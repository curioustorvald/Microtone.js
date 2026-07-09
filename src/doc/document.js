// Document — the canonical, fully-decoded project model owned by the main
// thread. The worklet holds a playback copy fed by upload commands (sync.js);
// the .taud container is (de)serialised by src/format/. Pattern cells reuse
// the engine's TaudPlayData codec so byte round-trips are exact.

import { TaudPlayData } from "../engine/state.js";
import { decodeInstWord, INST_PATLEN, INST_HALTAT, INST_HALT, INST_GOBACK, INST_SKIP, INST_JUMP } from "../engine/state.js";
import { CUE_EMPTY, MAX_VOICES, NUM_VOICES, PATTERN_SIZE } from "../format/taud-const.js";
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
  }

  get channelCount() { return this.is64Channel ? MAX_VOICES : NUM_VOICES; }

  /** Re-serialise to .taud bytes (via the format layer). */
  toBytes() {
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
