// PlayCue / PlayInstruction / TaudPlayData / TrackerState / Playhead —
// port of AudioAdapter.kt:4412-4494, 4880-5208, 5210-5244.

import {
  MAX_VOICES, PATTERN_EMPTY, NUM_CUES, TRACKER_CHUNK, INTERP_DEFAULT,
} from "./constants.js";
import { Voice } from "./voice.js";

// ── PlayInstruction (4484-4494) — tagged objects ──
export const INST_NOP = 0;
export const INST_GOBACK = 1;
export const INST_SKIP = 2;
export const INST_JUMP = 3;
export const INST_PATLEN = 4;
export const INST_HALTAT = 5;
export const INST_HALT = 6;

const PLAY_INST_NOP = Object.freeze({ type: INST_NOP, arg: 0 });
const PLAY_INST_HALT = Object.freeze({ type: INST_HALT, arg: 0 });

/** Per-cue playback data: 64 u16 channel words (pattern | signBit<<15). */
export class PlayCue {
  constructor() {
    this.raw = new Int32Array(MAX_VOICES).fill(PATTERN_EMPTY);
    this.inst0 = PLAY_INST_NOP;
    this.inst1 = PLAY_INST_NOP;
  }

  /** Pattern number for channel ch (0..0x7FFE), or PATTERN_EMPTY. */
  pattern(ch) { return this.raw[ch] & 0x7fff; }

  _instWord(base) {
    let w = 0;
    for (let k = 0; k < 16; k++) w |= ((this.raw[base + k] >>> 15) & 1) << k;
    return w;
  }

  recomputeInstructions() {
    this.inst0 = decodeInstWord(this._instWord(0));
    this.inst1 = decodeInstWord(this._instWord(16));
  }

  /** Effective playable row count: a LEN or "halt at x" in either word shortens it. */
  rowLimit() { return Math.min(rowsOf(this.inst0), rowsOf(this.inst1)); }

  /** True if either instruction word halts playback. */
  isHalt() {
    return this.inst0.type === INST_HALT || this.inst0.type === INST_HALTAT ||
           this.inst1.type === INST_HALT || this.inst1.type === INST_HALTAT;
  }

  /** The flow instruction (BAK / FWD / JMP) carried by either word, else NOP. */
  flowInstruction() {
    const t0 = this.inst0.type;
    if (t0 === INST_GOBACK || t0 === INST_SKIP || t0 === INST_JUMP) return this.inst0;
    const t1 = this.inst1.type;
    if (t1 === INST_GOBACK || t1 === INST_SKIP || t1 === INST_JUMP) return this.inst1;
    return PLAY_INST_NOP;
  }

  write(index, byte) {
    const ch = index >>> 1;
    this.raw[ch] = (index & 1) === 0
      ? (this.raw[ch] & 0xff00) | (byte & 0xff)
      : (this.raw[ch] & 0x00ff) | ((byte & 0xff) << 8);
    this.recomputeInstructions();
  }

  read(index) {
    const ch = index >>> 1;
    return (index & 1) === 0 ? this.raw[ch] & 0xff : (this.raw[ch] >>> 8) & 0xff;
  }
}

export function decodeInstWord(w) {
  if (w === 0) return PLAY_INST_NOP;
  const b30 = (w >>> 8) & 0xff;
  const b31 = w & 0xff;
  if (b30 === 0x02) return { type: INST_PATLEN, arg: (b31 & 0x3f) + 1, rows: (b31 & 0x3f) + 1 };
  if (b30 === 0x01) {
    // HALT family: arg 01xxxxxx ⇒ "halt at x" (x = 0 ⇒ full length); else plain HALT.
    if ((b31 & 0xc0) === 0x40) {
      const x = b31 & 0x3f;
      return { type: INST_HALTAT, arg: x === 0 ? 64 : x, rows: x === 0 ? 64 : x };
    }
    return PLAY_INST_HALT;
  }
  if ((b30 & 0xf0) === 0x80) return { type: INST_GOBACK, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0x90) return { type: INST_SKIP, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0xf0) return { type: INST_JUMP, arg: ((b30 & 0xf) << 8) | b31 };
  return PLAY_INST_NOP;
}

function rowsOf(inst) {
  return inst.type === INST_PATLEN || inst.type === INST_HALTAT ? inst.rows : 64;
}

// ── TaudPlayData — one pattern cell (5210-5244) ──
export class TaudPlayData {
  constructor() {
    this.note = 0;       // 0..65535
    this.instrment = 0;  // 0..255 (sic — Kotlin field name kept for diffability)
    this.volume = 0;     // 0..63
    this.volumeEff = 0;  // 0..3
    this.pan = 0;        // 0..63
    this.panEff = 0;     // 0..3
    this.effect = 0;     // 0..255
    this.effectArg = 0;  // 0..65535
  }

  getByte(offset) {
    switch (offset) {
      case 0: return this.note & 0xff;
      case 1: return (this.note >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return (this.volume | (this.volumeEff << 6)) & 0xff;
      case 4: return (this.pan | (this.panEff << 6)) & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByte(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 63; this.volumeEff = (byte >>> 6) & 3; break;
      case 4: this.pan = byte & 63; this.panEff = (byte >>> 6) & 3; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }
}

// ── TrackerState (4880-4947) ──
export class TrackerState {
  constructor() {
    this.cuePos = 0;
    this.rowIndex = 0;
    this.tickInRow = 0;
    this.samplesIntoTick = 0.0;
    this.firstRow = true;
    // Always MAX_VOICES so 64-channel mode has slots for every channel.
    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) this.voices[i] = new Voice();

    // Tone-slide mode: 0=linear 4096-TET, 1=Amiga period, 2=linear-frequency (Hz).
    this.toneMode = 0;
    this.interpolationMode = INTERP_DEFAULT;
    this.ledFilterOn = false;

    // Post-mix Amiga filter state (stereo bus).
    this.amigaLPStateL = 0.0;
    this.amigaLPStateR = 0.0;
    this.amigaLEDStateL = new Float64Array(4); // [in_z1, in_z2, out_z1, out_z2]
    this.amigaLEDStateR = new Float64Array(4);

    // Pending row-end events.
    this.pendingOrderJump = -1;
    this.pendingRowJump = -1;
    this.pendingRowJumpLocal = false;

    // Pattern delay (S$Ex).
    this.patternDelayRemaining = 0;
    this.patternDelayActive = false;
    this.sexWinningChannel = -1;

    // Fine pattern delay (S$6x).
    this.finePatternDelayExtra = 0;

    // Interrupt-note latch (Int0..IntF). Plain int — the engine is single-threaded
    // inside the worklet; the drain happens in snapshot assembly (edge-triggered,
    // level-collapsed semantics preserved).
    this.pendingInterrupts = 0;

    // Pre-allocated mix buffers (Float32 — matches the Kotlin FloatArray mix bus).
    this.mixLeft = new Float32Array(TRACKER_CHUNK);
    this.mixRight = new Float32Array(TRACKER_CHUNK);

    // Mixer-private background voices (NNA ghosts); index 0 = oldest.
    this.backgroundVoices = [];
  }

  drainInterrupts() {
    const m = this.pendingInterrupts;
    this.pendingInterrupts = 0;
    return m;
  }
}

// ── Playhead (4949-5207), tracker-mode-only port ──
// PCM mode, audio devices and MMIO byte protocol are host concerns and omitted.
export class Playhead {
  constructor(parent, index) {
    this.parent = parent;
    this.index = index;

    this.position = 0;
    this.masterVolume = 0;
    this.masterPan = 128;
    this.bpm = 125;      // 25..535
    this.tickRate = 6;
    this.patBank1 = 0;
    this.patBank2 = 0;
    this.globalVolume = 0x80;
    this.mixingVolume = 0x80;

    this.trackerState = new TrackerState();
    this.jamActive = false;
    this.initialGlobalFlags = 0;

    this._isPlaying = false;
  }

  updateTrackerGlobalBehaviour(flags) {
    const ts = this.trackerState;
    if (ts !== null) {
      ts.toneMode = flags & 3;
      ts.interpolationMode = (flags >>> 2) & 7;
    }
  }

  get isPlaying() { return this._isPlaying; }
  set isPlaying(value) {
    // Starting real playback ends any jam audition: drop leftover jammed voices
    // so a held audition can't bleed into the first rows of the song.
    if (!this._isPlaying && value && this.jamActive) {
      const ts = this.trackerState;
      if (ts !== null) {
        for (const v of ts.voices) v.active = false;
        for (const v of ts.backgroundVoices) v.active = false;
      }
      this.jamActive = false;
    }
    this._isPlaying = value;
  }

  setCuePosition(pos) {
    this.position = pos;
    const ts = this.trackerState;
    if (ts !== null) ts.cuePos = Math.min(pos, NUM_CUES - 1);
  }

  resetParams() {
    this.position = 0;
    this.isPlaying = false;
    this.jamActive = false;
    // Spec §5 defaults — applied on every reset so song-start state is well-defined.
    this.bpm = 125;
    this.tickRate = 6;
    this.globalVolume = 0x80;
    this.mixingVolume = 0x80;
    const ts = this.trackerState;
    if (ts === null) return;
    ts.cuePos = 0; ts.rowIndex = 0; ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0; ts.firstRow = true;
    ts.pendingOrderJump = -1; ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    ts.patternDelayRemaining = 0; ts.patternDelayActive = false;
    ts.sexWinningChannel = -1;
    ts.finePatternDelayExtra = 0;
    ts.pendingInterrupts = 0;
    ts.toneMode = this.initialGlobalFlags & 3;
    ts.interpolationMode = (this.initialGlobalFlags >>> 2) & 7;
    ts.ledFilterOn = false;
    ts.amigaLPStateL = 0.0; ts.amigaLPStateR = 0.0;
    ts.amigaLEDStateL.fill(0.0); ts.amigaLEDStateR.fill(0.0);
    for (const it of ts.voices) {
      it.active = false;
      it.noteVolume = 0x3f;
      it.channelVolume = 0x3f;
      it.rowVolume = 0x3f;
      it.currentMixVolume = 1.0;
      it.volRampSamples = 0;
      it.volRampStep = 0.0;
      it.snapMixVolume = false;
      it.envVolMix = 1.0;
      it.envVolStep = 0.0;
      it.channelPan = 0x80;
      it.rowPan = 32;
      it.glissandoOn = false;
      it.loopStartRow = 0;
      it.loopCount = 0;
      it.dittoActive = false;
      it.dittoSourceStart = 0;
      it.dittoLength = 0;
      it.dittoEndRow = 0;
      it.funkSpeed = 0;
      it.funkAccumulator = 0;
      it.funkWritePos = 0;
      it.fader = 0;
      it.nnaOverride = -1;
      it.volEnvOn = true; it.panEnvOn = true; it.pitchEnvOn = true; it.filterEnvOn = true;
      it.metaForeground = false;
      it.noteFading = false;
      it.layerMixGain = 1.0; it.isLayerChild = false; it.layerRelDetune = 0;
      // "What's playing" state — cleared alongside the volume reset so a stale
      // instrumentId can't survive into a fresh session (AudioAdapter.kt:5130-5142).
      it.instrumentId = 0;
      it.displayInst = 0;
      it.samplePos = 0.0;
      it.playbackRate = 1.0;
      it.forward = true;
      it.keyOff = false;
      it.envIndex = 0; it.envTimeSec = 0.0; it.envVolume = 1.0;
      it.envPanIndex = 0; it.envPanTimeSec = 0.0; it.envPan = 0.5;
      it.hasPanEnv = false;
      it.envPitchIndex = 0; it.envPitchTimeSec = 0.0; it.envPitchValue = 0.5;
      it.envFilterIndex = 0; it.envFilterTimeSec = 0.0; it.envFilterValue = 0.5;
      it.hasPitchEnv = false; it.hasFilterEnv = false;
      it.fadeoutVolume = 1.0;
      it.rampOutSamples = 0; it.rampOutGain = 0.0; it.rampOutStep = 0.0;
      it.noteVal = 0x0000; it.basePitch = 0x4000;
      it.amigaPeriod = -1.0; it.linearFreq = -1.0;
      it.tonePortaTarget = -1; it.tonePortaSpeed = 0;
      it.filterY1 = 0.0; it.filterY2 = 0.0; it.filterX1 = 0.0; it.filterX2 = 0.0;
      it.filterCutoffCached = -1; it.filterResonanceCached = -1;
      it.currentCutoff = 0xff; it.currentResonance = 0xff;
      it.nesDpcmCounter = 63;
    }
    ts.backgroundVoices.length = 0;
    // Funk masks + notefx 5/6 overrides are per-instrument runtime state — clear
    // so a replay (or song loop) starts from the file defaults.
    for (const inst of this.parent.instruments) {
      inst.funkMask = null;
      inst.cutoffOverride = -1;
      inst.resonanceOverride = -1;
    }
  }

  /** Clear funk-repeat state only (per-voice + per-instrument masks). */
  resetFunkState() {
    const ts = this.trackerState;
    if (ts !== null) {
      for (const it of ts.voices) {
        it.funkSpeed = 0;
        it.funkAccumulator = 0;
        it.funkWritePos = 0;
      }
    }
    for (const inst of this.parent.instruments) inst.funkMask = null;
  }
}
