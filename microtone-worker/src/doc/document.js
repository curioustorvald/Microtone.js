// Document — the canonical, fully-decoded project model owned by the main
// thread. The worklet holds a playback copy fed by upload commands (sync.js);
// the .taud container is (de)serialised by src/format/. Pattern cells reuse
// the engine's TaudPlayData codec so byte round-trips are exact.

import { TaudPlayData } from "../engine/state.js";
import { decodeInstWord, INST_PATLEN, INST_HALTAT, INST_HALT, INST_GOBACK, INST_SKIP, INST_JUMP } from "../engine/state.js";
import { TaudInst, parsePatchesBlob } from "../engine/inst.js";
import { CUE_EMPTY, MAX_VOICES, NUM_VOICES, PATTERN_SIZE, SAMPLEBIN_SIZE } from "../format/taud-const.js";
import { emptyPatternBytes } from "./patterntools.js";
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

/**
 * Combine a .tpif (patterns/cues/sMet only — the song domain) with an
 * instrument bank into a full parsed shape for `new Document()`. Mirrors the
 * device flow where a .tpif loads over the RESIDENT sample+inst state
 * (taud.mjs:173): the bank contributes the image, Ixmp and INam/SNam names;
 * everything else (songs, sMet, xHDR channel mode, …) comes from the .tpif.
 * `bank` is either a parsed .tsii/.taud or a live Document (whose image must
 * be up to date — call _rebuildInstRegion() first). The image is copied so
 * the combined document never aliases the bank's.
 */
export function combineTpif(bank, tpif) {
  const isBankSec = (s) => ["INam", "SNam", "Ixmp"].includes(s.fourcc);
  return {
    kind: "taud",
    fmtVer: tpif.fmtVer,
    is64Channel: tpif.is64Channel,
    signature: tpif.signature,
    sampleInstImage: bank.sampleInstImage ? bank.sampleInstImage.slice() : null,
    songs: tpif.songs,
    projSections: [
      ...tpif.projSections.filter((s) => !isBankSec(s)),
      ...(bank.projSections ?? []).filter(isBankSec),
    ],
    ixmp: bank.ixmp ?? [],
    meta: tpif.meta,
  };
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
    this._editedSlots = new Set();   // ONLY these slots rebuild — the decode
                                     // masks quirk bits (e.g. byte 173 & 0x1f),
                                     // so untouched records must stay verbatim
    this.smetEdited = false;      // when true, toBytes regenerates the sMet section
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

  /** Slots referenced as a layer of some metainstrument (its sub-instruments).
   *  The editor never lets you select these directly (item 59) — they are
   *  components of a metainstrument, not standalone playable instruments. */
  metaChildSlots() {
    const kids = new Set();
    for (const s of this.usedInstrumentSlots()) {
      const layers = this.instruments[s]?.metaLayers;
      if (layers) for (const l of layers) kids.add(l.instIdx & 0x3ff);
    }
    return kids;
  }

  /** Selectable (top-level) instrument slots: used slots minus meta children. */
  selectableInstrumentSlots() {
    const kids = this.metaChildSlots();
    return this.usedInstrumentSlots().filter((s) => !kids.has(s));
  }

  markInstUsed(slot) {
    this.instruments;
    this._usedSlots.add(slot & 0x3ff);
    this._editedSlots.add(slot & 0x3ff);
    this._instrumentsEdited = true;
  }

  /** Set/replace a Project-Data section payload; null removes the section. */
  setSection(fourcc, payload) {
    const i = this.projSections.findIndex((s) => s.fourcc === fourcc);
    if (payload === null) {
      if (i >= 0) this.projSections.splice(i, 1);
    } else if (i >= 0) {
      this.projSections[i] = { fourcc, payload };
    } else {
      this.projSections.push({ fourcc, payload });
    }
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
  patternName(idx) { return this._nameTable("pNam")[idx] ?? ""; }

  /** Build a new name-table payload (`fourcc`) with `escaped` (ASCII,
   *  \uHHHH-escaped) at `index`. Untouched entries keep their exact bytes — the
   *  section is split on 0x1E at the byte level (not re-encoded) so imported
   *  names round-trip verbatim. Missing leading entries are padded empty. */
  _buildNameTable(fourcc, index, escaped) {
    const sec = this.projSections.find((s) => s.fourcc === fourcc);
    const src = sec ? sec.payload : new Uint8Array(0);
    const segs = [];
    let start = 0;
    for (let i = 0; i <= src.length; i++) {
      if (i === src.length || src[i] === 0x1e) { segs.push(src.slice(start, i)); start = i + 1; }
    }
    while (segs.length <= index) segs.push(new Uint8Array(0));
    segs[index] = new TextEncoder().encode(escaped);
    const total = segs.reduce((n, s) => n + s.length, 0) + (segs.length - 1);
    const out = new Uint8Array(Math.max(0, total));
    let off = 0;
    segs.forEach((s, i) => { if (i > 0) out[off++] = 0x1e; out.set(s, off); off += s.length; });
    return out;
  }

  buildSampleNames(index, escaped) { return this._buildNameTable("SNam", index, escaped); }
  buildInstrumentNames(slot, escaped) { return this._buildNameTable("INam", slot, escaped); }
  buildPatternNames(idx, escaped) { return this._buildNameTable("pNam", idx, escaped); }

  /**
   * Deduped sample census across base instruments + Ixmp patches, sorted by
   * pool pointer: [{ptr, len, rate, loopStart, loopEnd, loopMode, users}].
   * SNam names map by pool order (converter emission order).
   * `patchOverrides` (Map slot → patches[]|null) substitutes a slot's Ixmp
   * patches WITHOUT applying them — the patch editor uses it to compute the
   * prospective census (and the SNam realignment it implies) before an edit.
   */
  sampleList(patchOverrides = null) {
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
      const patches = patchOverrides?.has(s) ? patchOverrides.get(s) : inst.extraPatches;
      if (patches !== null) {
        for (const p of patches) {
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

  /** Fold decoded-instrument edits back into the image's inst region —
   *  edited slots only, so unedited records round-trip byte-exact. */
  /** Drop the decoded-instrument cache so the next access re-decodes from the
   *  (possibly replaced) image; also clears pending-edit state. Used by bank-level
   *  ops that swap the whole image + Ixmp (import / cleanup). */
  _resetInstrumentCache() {
    this._instruments = null;
    this._instrumentsEdited = false;
    this._editedSlots.clear();
  }

  _rebuildInstRegion() {
    if (!this._instrumentsEdited || this.sampleInstImage === null) return;
    const instRegion = this.sampleInstImage.subarray(SAMPLEBIN_SIZE);
    for (const s of this._editedSlots) {
      instRegion.set(this.instRecordBytes(s), s * 256);
    }
    this._editedSlots.clear();
    this._instrumentsEdited = false;
  }

  /** Regenerate the sMet section from meta.songMeta (writer format of
   *  taud.mjs:555-570). Only called when metadata was edited, so unedited
   *  documents keep their original section bytes (byte-exact round trips). */
  _rebuildSMet() {
    if (!this.smetEdited) return;
    const enc = new TextEncoder();
    const out = [];
    const idxs = Object.keys(this.meta.songMeta).map(Number).sort((a, b) => a - b);
    for (const idx of idxs) {
      const m = this.meta.songMeta[idx];
      const sub = [
        m.notation & 0xff, (m.notation >>> 8) & 0xff,
        (m.beatPri | 0) & 0xff, (m.beatSec | 0) & 0xff,
        ...enc.encode(m.name ?? ""), 0,
        ...enc.encode(m.composer ?? ""), 0,
        ...enc.encode(m.copyright ?? ""), 0,
      ];
      out.push(idx & 0xff,
        sub.length & 0xff, (sub.length >>> 8) & 0xff,
        (sub.length >>> 16) & 0xff, (sub.length >>> 24) & 0xff,
        ...sub);
    }
    const payload = Uint8Array.from(out);
    const existing = this.projSections.findIndex((s) => s.fourcc === "sMet");
    if (existing >= 0) this.projSections[existing] = { fourcc: "sMet", payload };
    else this.projSections.push({ fourcc: "sMet", payload });
    this.smetEdited = false;
  }

  /** Re-serialise to .taud bytes (via the format layer). */
  toBytes() {
    this._rebuildInstRegion();
    this._rebuildSMet();
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
        // Null gaps (unmaterialised arbitrary-number patterns, item 48) serialise
        // as empty patterns — gzip compresses the sparsity.
        patterns: s.patterns.map((p) => (p ? encodePattern(p) : emptyPatternBytes())),
        cues: s.cues,
      })),
      projSections: this.projSections,
    });
  }

  /** Encode one pattern back to its 512-byte image (worklet sync). An index
   *  past the end (a just-undone append) or a null gap (item 48) serves the
   *  empty-cell image so the sync flush blanks the worklet's stale copy. */
  patternBytes(songIdx, patIdx) {
    const rows = this.songs[songIdx].patterns[patIdx];
    return rows ? encodePattern(rows) : emptyPatternBytes();
  }

  // ── item 48: arbitrary pattern numbers ──
  // Every pattern 0x0000..0x7FFE is conceptually available. The in-memory array
  // is grown (with `null` gaps — cheap) only when a pattern is actually EDITED;
  // gaps and the whole 0..length-1 range serialise as empty patterns (gzip
  // compresses the sparsity), so a song can reference/create any pattern number
  // without pre-creating the ones below it.

  /** Highest addressable pattern index (cue words are 15-bit, 0x7FFF = empty). */
  static get MAX_PATTERN() { return 0x7ffe; }

  /** The materialised pattern object at (songIdx, patIdx), or null (a gap /
   *  never-edited index). Read paths that want an editable-but-empty view use
   *  emptyPattern() instead. */
  patternAt(songIdx, patIdx) {
    return this.songs[songIdx].patterns[patIdx] ?? null;
  }

  /** Shared read-only empty pattern for displaying an unmaterialised index. */
  emptyPattern() {
    return (this._emptyPattern ??= decodePattern(emptyPatternBytes()));
  }

  /** Materialise (songIdx, patIdx) so it can be edited: pad the array with null
   *  gaps up to patIdx, then fill patIdx with a fresh empty pattern (gaps stay
   *  null until they too are edited). Returns the pattern object. Idempotent —
   *  a no-op when the pattern already exists (so undo of an ordinary edit stays
   *  byte-exact). */
  ensurePattern(songIdx, patIdx) {
    const pats = this.songs[songIdx].patterns;
    for (let i = pats.length; i < patIdx; i++) pats[i] = null;
    if (!pats[patIdx]) pats[patIdx] = decodePattern(emptyPatternBytes());
    return pats[patIdx];
  }

  /** Parsed-shape view for offline rendering (offline-render.js) — includes
   *  any instrument edits (rebuilds the image inst region first). */
  toRenderable(songIndex) {
    this._rebuildInstRegion();
    const s = this.songs[songIndex];
    return {
      is64Channel: this.is64Channel,
      sampleInstImage: this.sampleInstImage,
      ixmp: this.ixmp,
      songs: this.songs.map((song, i) => i === songIndex ? {
        bpm: s.bpm, tickRate: s.tickRate, globalFlags: s.globalFlags,
        globalVolume: s.globalVolume, mixingVolume: s.mixingVolume,
        patterns: s.patterns.map((_, p) => this.patternBytes(songIndex, p)),
        cues: s.cues,
      } : null),
    };
  }

  /** Encode one cue to its upload byte payload (worklet sync). An index past
   *  the end (a just-undone cue append) serves the all-empty image so the sync
   *  blanks the worklet's stale copy — mirrors patternBytes' empty fallback. */
  cueBytes(songIdx, cueIdx) {
    const words = this.songs[songIdx].cues[cueIdx];
    const chans = this.channelCount;
    const bytes = new Uint8Array(chans * 2);
    for (let ch = 0; ch < chans; ch++) {
      const w = words ? words[ch] : CUE_EMPTY;
      bytes[ch * 2] = w & 0xff;
      bytes[ch * 2 + 1] = (w >>> 8) & 0xff;
    }
    return bytes;
  }
}
