// PlayCue / PlayInstruction / TaudPlayData / TrackerState / Playhead —
// port of AudioAdapter.kt:4412-4494, 4880-5208, 5210-5244.

import {
  MAX_VOICES, PATTERN_EMPTY, NUM_CUES, TRACKER_CHUNK, INTERP_DEFAULT,
  VOLUME_MAX, VOLUME_MAX_WIDE, VOLUME_STEP_WIDE,
} from "./constants.js";
import { Voice } from "./voice.js";
import { SURROUND_STEREO, SURROUND_SPATIAL, SpatialBus, StereoRenderer } from "./spatial.js";
import { MONITOR_FOLD, MONITOR_BINAURAL, BinauralRenderer } from "./binaural.js";

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
// Two wire layouts share these fields: the 8-byte cell of format versions 1-2
// (getByte/setByte) and version 3's 16-byte WIDE cell (getByteWide/setByteWide).
// The wide layout is a superset in meaning, not in encoding — its volume is a
// whole byte and its panning column is an azimuth plus an elevation rather than
// a 6-bit front-arc value — so the two codecs stay separate and the v2 path is
// untouched, which is what keeps it bit-exact.
export class TaudPlayData {
  constructor() {
    this.note = 0;       // 0..65535
    this.instrment = 0;  // 0..255 (sic — Kotlin field name kept for diffability)
    this.volume = 0;     // 0..63, or 0..255 in a wide cell
    this.volumeEff = 0;  // 0..3, or 0..7 in a wide cell
    this.pan = 0;        // 0..63 — the 8-byte cell's front-arc column value
    this.panEff = 0;     // 0..3, or 0..15 in a wide cell
    this.effect = 0;     // 0..255
    this.effectArg = 0;  // 0..65535
    // ── wide cell only (#v3) ──
    this.azimuth = 0;    // 0..511, the panning column's 9-bit angle
    this.elevation = 0;  // -128..127, signed
    this.effect2 = 0;    // second effect, applied after the first
    this.effectArg2 = 0;
  }

  /** Wide-cell byte view — see the file format's §5.5 table. */
  getByteWide(offset) {
    switch (offset) {
      case 0: return this.note & 0xff;
      case 1: return (this.note >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return this.volume & 0xff;
      case 4: return this.azimuth & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      case 8: return (((this.azimuth >>> 8) & 1) << 7) |
                     ((this.volumeEff & 7) << 4) | (this.panEff & 0xf);
      case 9: return this.elevation & 0xff;
      case 10: return this.effect2 & 0xff;
      case 11: return this.effectArg2 & 0xff;
      case 12: return (this.effectArg2 >>> 8) & 0xff;
      case 13: case 14: case 15: return 0; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByteWide(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 0xff; break;
      case 4: this.azimuth = (this.azimuth & 0x100) | byte; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      case 8:
        this.azimuth = (this.azimuth & 0xff) | ((byte & 0x80) << 1);
        this.volumeEff = (byte >>> 4) & 7;
        this.panEff = byte & 0xf;
        break;
      case 9: this.elevation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 10: this.effect2 = byte; break;
      case 11: this.effectArg2 = (this.effectArg2 & 0xff00) | byte; break;
      case 12: this.effectArg2 = (this.effectArg2 & 0x00ff) | (byte << 8); break;
      case 13: case 14: case 15: break; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
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

    // Cell format (file format version 3 — the wide cell). It sets the width of
    // the volume column, and with it the whole volume STATE: note, row and
    // channel volume are 0…63 in a v2 song and 0…255 in a v3 one. `volStep` is
    // what a 6-bit-derived delta is worth (a nibble slide, a tremolo depth), so
    // `D $01` moves at the same musical rate in both; `volDiv` normalises to
    // gain. Instrument data — envelope nodes, Ixmp velocity rectangles — stays
    // 6-bit in both, so a bank loads into either.
    this.wideCells = false;
    this.volMax = VOLUME_MAX;
    this.volStep = 1;
    this.volDiv = 63.0;

    // Surround model (#998; song-immutable `ss` flag) + the object bus it mixes
    // into. Null bus = the stereo model, which keeps the plain two-accumulator
    // path untouched — see mixer.js.
    this.surroundModel = SURROUND_STEREO;
    this.spatial = null;

    // Song tuning as a playback-rate multiplier (item 77) — mirrored down from
    // the playhead by setTuning, like toneMode/interpolationMode are from the
    // global-behaviour flags, so the per-sample path reads it off `ts` alone.
    // 1.0 = concert; the tracker default (C9 @ 8363) is 0.99892 (~1.87c flat).
    this.tuningRatio = 1.0;

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

  /**
   * Install the cell format (file format version 3). Rescales the running
   * volume state so a switch cannot leave a voice at a quarter of its intended
   * level; in practice this is called once, before anything is uploaded.
   */
  setCellFormat(wide) {
    if (this.wideCells === !!wide) return;
    this.wideCells = !!wide;
    this.volMax = wide ? VOLUME_MAX_WIDE : VOLUME_MAX;
    this.volStep = wide ? VOLUME_STEP_WIDE : 1;
    this.volDiv = this.volMax * 1.0;
    for (const v of this.voices) {
      v.noteVolume = this.volMax;
      v.channelVolume = this.volMax;
      v.rowVolume = this.volMax;
    }
  }

  /**
   * Install the song's surround model (#998). The stereo model keeps `spatial`
   * null — the mixer's legacy two-accumulator path, untouched; anything else
   * allocates the object bus for `renderer`, which is the device's
   * StereoRenderer unless an exporter asked for a different render target.
   */
  setSurroundModel(model, renderer = null) {
    this.surroundModel = model & 3;
    this.spatial = this.surroundModel === SURROUND_STEREO
      ? null
      : new SpatialBus(renderer ?? new StereoRenderer(), TRACKER_CHUNK);
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
    // Declared song tuning (item 77), kept for readback; the hot path uses the
    // multiplier setTuning derives onto trackerState. Untuned until a song
    // load pushes the file's pair — the engine has no song table of its own,
    // so the spec's "if zero, assume the tracker default" rule lives in
    // tuningRatioOf, on the values the host hands over.
    this.tuningBaseNote = 0;
    this.tuningFreq = 0.0;

    this.trackerState = new TrackerState();
    this.jamActive = false;
    this.initialGlobalFlags = 0;
    // Song-immutable surround model + the render target it mixes through
    // (#998). Null renderer = the device's own monitor, picked by monitorMode
    // (fold or binaural, #998.3); an exporter overrides it with the format's
    // renderer and the engine never learns which format asked.
    this.surroundModel = SURROUND_STEREO;
    this.spatialRenderer = null;
    this.monitorMode = MONITOR_FOLD;
    this.binauralRenderer = null; // built on demand, kept across model switches

    this._isPlaying = false;
  }

  /**
   * The render target the object bus should use right now (#998.3): an
   * exporter's explicit renderer if one is installed, otherwise the device
   * monitor this playhead is set to — null for the fold (the bus builds its own
   * StereoRenderer), or a binaural head matching the song's model. The binaural
   * renderer is stateful, so it is kept across model switches and reset each
   * time it is (re-)installed.
   */
  effectiveSpatialRenderer() {
    if (this.spatialRenderer !== null) return this.spatialRenderer;
    if (this.monitorMode !== MONITOR_BINAURAL || this.surroundModel === SURROUND_STEREO) return null;
    const sphere = this.surroundModel === SURROUND_SPATIAL;
    if (this.binauralRenderer === null || this.binauralRenderer.sphere !== sphere) {
      this.binauralRenderer = new BinauralRenderer(sphere);
    }
    this.binauralRenderer.reset();
    return this.binauralRenderer;
  }

  /** (Re-)install the surround model on the tracker state with that target. */
  applySurroundModel() {
    this.trackerState.setSurroundModel(this.surroundModel, this.effectiveSpatialRenderer());
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
    this.tuningBaseNote = 0;
    this.tuningFreq = 0.0;
    const ts = this.trackerState;
    if (ts === null) return;
    ts.tuningRatio = 1.0;
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
    this.applySurroundModel();
    ts.ledFilterOn = false;
    ts.amigaLPStateL = 0.0; ts.amigaLPStateR = 0.0;
    ts.amigaLEDStateL.fill(0.0); ts.amigaLEDStateR.fill(0.0);
    for (const it of ts.voices) {
      it.active = false;
      it.noteVolume = ts.volMax;
      it.channelVolume = ts.volMax;
      it.rowVolume = ts.volMax;
      it.currentMixVolume = 1.0;
      it.volRampSamples = 0;
      it.volRampStep = 0.0;
      it.snapMixVolume = false;
      it.envVolMix = 1.0;
      it.envVolStep = 0.0;
      it.channelPan = 0x80;
      it.rowPan = 32;
      it.panAzimuth = 128.0;
      it.panElevation = 0.0;
      it.spatialTargetAz = 128.0;
      it.spatialTargetEl = 0.0;
      it.spatialSlideActive = false;
      it.spatial = null;
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
      it.activePatchIndex = -1; // stem tap, cleared with the rest of "what's playing"
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
      it.right.reset();
      it.activeChanCount = 1; it.activeChanMode = 0; it.activeChanPtr2 = 0;
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
