// Document — the canonical, fully-decoded project model owned by the main
// thread. The worklet holds a playback copy fed by upload commands (sync.js);
// the .taud container is (de)serialised by src/format/. Pattern cells reuse
// the engine's TaudPlayData codec so byte round-trips are exact.

import { TaudPlayData } from "../engine/state.js";
import { decodeInstWord, INST_PATLEN, INST_HALTAT, INST_HALT, INST_GOBACK, INST_SKIP, INST_JUMP } from "../engine/state.js";
import { TaudInst, parsePatchesBlob } from "../engine/inst.js";
import { CUE_EMPTY, MAX_VOICES, NUM_VOICES, PATTERN_SIZE, SAMPLEBIN_SIZE } from "../format/taud-const.js";
import { cueInstructionWords } from "../format/taud-parse.js";
import { writeTaud } from "../format/taud-write.js";

function decodePattern(bytes) {
  const rows = new Array(64);
  for (let r = 0; r < 64; r++) {
    const cell = new TaudPlayData();
    for (let b = 0; b < 8; b++) cell.setByte(b, bytes[r * 8 + b]);
    rows[r] = cell;
  }
  return rows;
}

function encodePattern(rows) {
  const bytes = new Uint8Array(PATTERN_SIZE);
  for (let r = 0; r < 64; r++) {
    for (let b = 0; b < 8; b++) bytes[r * 8 + b] = rows[r].getByte(b);
  }
  return bytes;
}

/** Decode a cue's instruction words into {rowLimit, isHalt, flow:{type,arg}|null}. */
export function cueInfo(words) {
  const [w0, w1] = cueInstructionWords(words);
  const i0 = decodeInstWord(w0);
  const i1 = decodeInstWord(w1);
  const rowsOf = (i) => (i.type === INST_PATLEN || i.type === INST_HALTAT ? i.rows : 64);
  const isFlow = (i) => i.type === INST_GOBACK || i.type === INST_SKIP || i.type === INST_JUMP;
  return {
    inst0: i0,
    inst1: i1,
    rowLimit: Math.min(rowsOf(i0), rowsOf(i1)),
    isHalt: i0.type === INST_HALT || i0.type === INST_HALTAT ||
            i1.type === INST_HALT || i1.type === INST_HALTAT,
    flow: isFlow(i0) ? i0 : isFlow(i1) ? i1 : null,
  };
}

export class Song {
  constructor(parsedSong) {
    this.numVoices = parsedSong.numVoices;
    this.bpm = parsedSong.bpm;
    this.tickRate = parsedSong.tickRate;
    this.tuningBaseNote = parsedSong.tuningBaseNote;
    this.tuningFreq = parsedSong.tuningFreq;
    this.globalFlags = parsedSong.globalFlags;
    this.globalVolume = parsedSong.globalVolume;
    this.mixingVolume = parsedSong.mixingVolume;
    /** @type {TaudPlayData[][]} 64 cells per pattern */
    this.patterns = parsedSong.patterns.map(decodePattern);
    /** @type {Uint16Array[]} raw u16 channel words per cue (64-wide) */
    this.cues = parsedSong.cues.map((w) => Uint16Array.from(w));
  }

  /** Index of the last cue with any content (pattern refs or instruction bits). */
  lastUsedCue() {
    for (let c = this.cues.length - 1; c >= 0; c--) {
      const words = this.cues[c];
      for (let ch = 0; ch < MAX_VOICES; ch++) {
        if (words[ch] !== CUE_EMPTY) return c;
      }
    }
    return 0;
  }

  /**
   * Linear song map for the Timeline: sequential cues 0..lastUsedCue with each
   * cue's effective row count (flow instructions are shown, not followed).
   * Returns { entries: [{cue, startRow, rowLimit, info}], totalRows }.
   */
  songMap() {
    const entries = [];
    let startRow = 0;
    const last = this.lastUsedCue();
    for (let c = 0; c <= last; c++) {
      const info = cueInfo(this.cues[c]);
      entries.push({ cue: c, startRow, rowLimit: info.rowLimit, info });
      startRow += info.rowLimit;
    }
    return { entries, totalRows: startRow };
  }
}

export class Document {
  /** Build from the structure parseTaud returns. */
  constructor(parsed) {
    this.kind = parsed.kind;
    this.fmtVer = parsed.fmtVer;
    this.is64Channel = parsed.is64Channel;
    this.signature = parsed.signature;
    this.sampleInstImage = parsed.sampleInstImage; // Uint8Array(8650752) | null
    this.songs = parsed.songs.map((s) => new Song(s));
    this.projSections = parsed.projSections.map((s) => ({
      fourcc: s.fourcc,
      payload: Uint8Array.from(s.payload),
    }));
    this.ixmp = parsed.ixmp.map((e) => ({
      instId: e.instId,
      count: e.count,
      blob: Uint8Array.from(e.blob),
    }));
    this.meta = {
      projectName: parsed.meta.projectName,
      songMeta: structuredClone(parsed.meta.songMeta),
    };
    this.dirty = false; // unsaved-changes flag (ops set it; save clears it)

    this._instruments = null;     // lazily-decoded TaudInst[1024]
    this._instrumentsEdited = false; // when true, toBytes rebuilds the inst region
  }

  get channelCount() { return this.is64Channel ? MAX_VOICES : NUM_VOICES; }

  /** The 8 MB sample pool region of the image (view, not a copy). */
  get sampleBin() {
    return this.sampleInstImage?.subarray(0, SAMPLEBIN_SIZE) ?? null;
  }

  /**
   * Decoded instruments (TaudInst[1024], engine class) with Ixmp patches
   * attached — decoded lazily from the image. Instrument-scope ops mutate
   * these; toBytes()/instRecordBytes() regenerate the byte view.
   */
  get instruments() {
    if (this._instruments === null) {
      const insts = new Array(1024);
      const usedSlots = new Set();
      const instRegion = this.sampleInstImage?.subarray(SAMPLEBIN_SIZE) ?? null;
      const rec = new Uint8Array(256);
      for (let s = 0; s < 1024; s++) {
        const inst = new TaudInst(s);
        if (instRegion !== null) {
          const raw = instRegion.subarray(s * 256, (s + 1) * 256);
          rec.set(raw);
          inst.loadRecord(rec);
          if (!raw.every((b) => b === 0)) usedSlots.add(s);
        }
        insts[s] = inst;
      }
      for (const e of this.ixmp) {
        const patches = parsePatchesBlob(e.blob);
        if (patches.length > 0) {
          insts[e.instId & 0x3ff].extraPatches = patches;
          usedSlots.add(e.instId & 0x3ff);
        }
      }
      this._instruments = insts;
      this._usedSlots = usedSlots;
    }
    return this._instruments;
  }

  /** Slots (0..1023) with content, ascending. Ops add edited slots via markInstUsed. */
  usedInstrumentSlots() {
    this.instruments; // ensure decoded
    return [...this._usedSlots].sort((a, b) => a - b);
  }

  markInstUsed(slot) {
    this.instruments;
    this._usedSlots.add(slot & 0x3ff);
    this._instrumentsEdited = true;
  }

  /** 0x1E-separated name-table lookup (INam / SNam / pNam). */
  _nameTable(fourcc) {
    const sec = this.projSections.find((s) => s.fourcc === fourcc);
    if (!sec) return [];
    const dec = new TextDecoder();
    const parts = [];
    let start = 0;
    for (let i = 0; i <= sec.payload.length; i++) {
      if (i === sec.payload.length || sec.payload[i] === 0x1e) {
        parts.push(dec.decode(sec.payload.subarray(start, i)));
        start = i + 1;
      }
    }
    return parts;
  }

  instrumentName(slot) { return this._nameTable("INam")[slot] ?? ""; }
  sampleName(index) { return this._nameTable("SNam")[index] ?? ""; }

  /**
   * Deduped sample census across base instruments + Ixmp patches, sorted by
   * pool pointer: [{ptr, len, rate, loopStart, loopEnd, loopMode, users}].
   * SNam names map by pool order (converter emission order).
   */
  sampleList() {
    const byKey = new Map();
    const add = (ptr, len, rate, loopStart, loopEnd, loopMode, user) => {
      if (len <= 0) return;
      const key = `${ptr}:${len}`;
      let e = byKey.get(key);
      if (!e) {
        e = { ptr, len, rate, loopStart, loopEnd, loopMode, users: new Set() };
        byKey.set(key, e);
      }
      e.users.add(user);
    };
    for (const s of this.usedInstrumentSlots()) {
      const inst = this.instruments[s];
      if (!inst.isMeta) {
        add(inst.samplePtr, inst.sampleLength, inst.samplingRate,
            inst.sampleLoopStart, inst.sampleLoopEnd, inst.loopMode, s);
      }
      if (inst.extraPatches !== null) {
        for (const p of inst.extraPatches) {
          add(p.samplePtr, p.sampleLength, p.samplingRate,
              p.loopStart, p.loopEnd, p.loopMode, s);
        }
      }
    }
    const list = [...byKey.values()].sort((a, b) => a.ptr - b.ptr);
    list.forEach((e, i) => { e.index = i; e.name = this.sampleName(i); e.users = [...e.users]; });
    return list;
  }

  /** 256-byte record for slot, regenerated from the decoded TaudInst. */
  instRecordBytes(slot) {
    const inst = this.instruments[slot & 0x3ff];
    const rec = new Uint8Array(256);
    for (let i = 0; i < 256; i++) rec[i] = inst.getByte(i);
    return rec;
  }

  /** Fold decoded-instrument edits back into the image's inst region. */
  _rebuildInstRegion() {
    if (!this._instrumentsEdited || this.sampleInstImage === null) return;
    const instRegion = this.sampleInstImage.subarray(SAMPLEBIN_SIZE);
    for (let s = 0; s < 1024; s++) {
      instRegion.set(this.instRecordBytes(s), s * 256);
    }
    this._instrumentsEdited = false;
  }

  /** Re-serialise to .taud bytes (via the format layer). */
  toBytes() {
    this._rebuildInstRegion();
    return writeTaud({
      kind: this.kind,
      is64Channel: this.is64Channel,
      signature: this.signature,
      sampleInstImage: this.sampleInstImage,
      songs: this.songs.map((s) => ({
        numVoices: s.numVoices,
        bpm: s.bpm,
        tickRate: s.tickRate,
        tuningBaseNote: s.tuningBaseNote,
        tuningFreq: s.tuningFreq,
        globalFlags: s.globalFlags,
        globalVolume: s.globalVolume,
        mixingVolume: s.mixingVolume,
        patterns: s.patterns.map(encodePattern),
        cues: s.cues,
      })),
      projSections: this.projSections,
    });
  }

  /** Encode one pattern back to its 512-byte image (worklet sync). */
  patternBytes(songIdx, patIdx) {
    return encodePattern(this.songs[songIdx].patterns[patIdx]);
  }

  /** Encode one cue to its upload byte payload (worklet sync). */
  cueBytes(songIdx, cueIdx) {
    const words = this.songs[songIdx].cues[cueIdx];
    const chans = this.channelCount;
    const bytes = new Uint8Array(chans * 2);
    for (let ch = 0; ch < chans; ch++) {
      bytes[ch * 2] = words[ch] & 0xff;
      bytes[ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
    }
    return bytes;
  }
}
