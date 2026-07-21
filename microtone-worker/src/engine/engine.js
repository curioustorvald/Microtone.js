// TaudEngine — the device facade, port of AudioAdapter.kt state fields
// (356-397) + AudioJSR223Delegate.kt (the `audio.*` API surface consumed by
// taut.js / playtaud / taud.mjs). One instance ≈ one AudioAdapter.
//
// Differences from the Kotlin device (deliberate, per the port plan):
//  - uploadSampleInstBlob takes the DECOMPRESSED 8650752-byte image
//    (decompression is a format-layer / main-thread concern).
//  - No PCM/MP2/TAD paths, no MMIO/banked windows: callers address the API,
//    playback addresses the 8 MB pool directly (as the Kotlin engine does).
//  - Voice-index clamps mirror the delegate exactly (readbacks clamp to
//    NUM_VOICES-1; jamNote to MAX_VOICES-1).

import {
  SAMPLE_BIN_TOTAL, NUM_PATTERNS, NUM_CUES, NUM_VOICES, MAX_VOICES,
  CUE_BYTES, CUE_BYTES_64, TRACKER_CHUNK,
} from "./constants.js";
import { tuningRatioOf } from "./tables.js";
import { TaudInst, parsePatchesBlob, writePatchesBlob } from "./inst.js";
import { PlayCue, TaudPlayData, Playhead } from "./state.js";
import { makeXorshift32 } from "./rng.js";
import { generateTrackerAudio } from "./mixer.js";
import { triggerMetaOrNote, triggerNote } from "./trigger.js";
import { reconstructDittoState } from "./row.js";

// Scratch instrument slot for the raw-sample preview (jamSample). It sits just
// past the 1024 addressable bank slots so an audition never borrows a real one;
// every `instruments[voice.instrumentId]` lookup indexes it directly (no & mask).
const AUDITION_SLOT = 1024;

function makePattern() {
  const rows = new Array(64);
  for (let i = 0; i < 64; i++) {
    const c = new TaudPlayData();
    c.pan = 32;
    rows[i] = c;
  }
  return rows;
}

export class TaudEngine {
  constructor() {
    this.sampleBin = new Uint8Array(SAMPLE_BIN_TOTAL);
    this.instruments = new Array(AUDITION_SLOT + 1);
    for (let i = 0; i <= AUDITION_SLOT; i++) this.instruments[i] = new TaudInst(i);
    // Pattern store — lazily allocated (memory scales with actual song size).
    this.playdata = new Array(NUM_PATTERNS).fill(null);
    this.emptyPattern = makePattern();
    this.scratchPattern = makePattern();
    this.cueSheet = new Array(NUM_CUES);
    for (let i = 0; i < NUM_CUES; i++) this.cueSheet[i] = new PlayCue();
    this.is64ChannelMode = false;
    this.playheads = [
      new Playhead(this, 0), new Playhead(this, 1),
      new Playhead(this, 2), new Playhead(this, 3),
    ];
    // Dither state (pcm32fToPcm8): per-adapter xorshift32 + error history.
    this.xorshift32 = makeXorshift32();
    this.ditherError = new Float32Array(4); // [L0, L1, R0, R1]
  }

  channelCount() { return this.is64ChannelMode ? MAX_VOICES : NUM_VOICES; }
  cueByteStride() { return this.is64ChannelMode ? CUE_BYTES_64 : CUE_BYTES; }

  /** Read-only view of pattern idx (shared empty pattern when unallocated). */
  patternRead(idx) {
    if (idx < 0 || idx >= NUM_PATTERNS) return this.emptyPattern;
    return this.playdata[idx] ?? this.emptyPattern;
  }

  /** Writable pattern idx, allocating its 64 rows on first access. */
  patternFor(idx) {
    if (idx < 0 || idx >= NUM_PATTERNS) return this.scratchPattern;
    let p = this.playdata[idx];
    if (p === null) {
      p = makePattern();
      this.playdata[idx] = p;
    }
    return p;
  }

  // ── content upload (AudioJSR223Delegate.kt:343-497, 610-640) ──

  /**
   * Install a DECOMPRESSED sample+instrument image: 8 MB samples followed by
   * 1024 (or fewer, for older files) 256-byte instrument records. Slots absent
   * from the blob are cleared; all Ixmp patches are dropped (they point into
   * the replaced pool).
   */
  uploadSampleInstBlob(image) {
    const sampleSize = SAMPLE_BIN_TOTAL;
    if (image.length < sampleSize + 65536) return 0;
    this.sampleBin.set(image.subarray(0, sampleSize));
    const instCount = Math.min(1024, Math.trunc((image.length - sampleSize) / 256));
    const rec = new Uint8Array(256);
    for (let instIdx = 0; instIdx < 1024; instIdx++) {
      if (instIdx < instCount) {
        rec.set(image.subarray(sampleSize + instIdx * 256, sampleSize + (instIdx + 1) * 256));
      } else {
        rec.fill(0);
      }
      this.instruments[instIdx].loadRecord(rec);
    }
    for (const inst of this.instruments) inst.extraPatches = null;
    return image.length;
  }

  /** Capture the raw 8650752-byte sample+instrument image (save path). */
  captureSampleInstImage() {
    const out = new Uint8Array(SAMPLE_BIN_TOTAL + 1024 * 256);
    out.set(this.sampleBin);
    for (let i = 0; i < 1024 * 256; i++) {
      out[SAMPLE_BIN_TOTAL + i] = this.instruments[(i / 256) | 0].getByte(i % 256);
    }
    return out;
  }

  /** Upload up to 256 bytes defining instrument slot (0-1023; 256+ = aux bin). */
  uploadInstrument(slot, bytes) {
    const inst = this.instruments[slot & 0x3ff];
    const rec = new Uint8Array(256);
    for (let i = 0; i < Math.min(256, bytes.length); i++) rec[i] = bytes[i] & 0xff;
    inst.loadRecord(rec);
  }

  /**
   * Upload an Ixmp "extra samples" block for instrument slot. Patches are
   * variable-length: version byte (0b x00Pfpvi) + 30 common bytes + optional
   * x/v/p/f/P blocks in that order (AudioJSR223Delegate.kt:357-430).
   */
  uploadInstrumentPatches(slot, bytes) {
    const inst = this.instruments[slot & 0x3ff];
    const patches = parsePatchesBlob(bytes);
    inst.extraPatches = patches.length === 0 ? null : patches;
  }

  getInstrumentPatchCount(slot) {
    const p = this.instruments[slot & 0x3ff].extraPatches;
    return p === null ? 0 : p.length;
  }

  /** Exact byte-inverse of uploadInstrumentPatches (capture path). */
  getInstrumentPatches(slot) {
    const patches = this.instruments[slot & 0x3ff].extraPatches;
    if (patches === null) return new Uint8Array(0);
    return writePatchesBlob(patches);
  }

  clearInstrumentPatches(slot) {
    this.instruments[slot & 0x3ff].extraPatches = null;
  }

  /** Upload 512 bytes (64 rows × 8) defining pattern slot. */
  uploadPattern(slot, bytes) {
    const pat = this.patternFor(slot & 0x7fff);
    const n = Math.min(512, bytes.length);
    for (let i = 0; i < n; i++) pat[(i / 8) | 0].setByte(i % 8, bytes[i] & 0xff);
  }

  /** Upload one cue entry (64 bytes / 128 bytes in 64-channel mode). */
  uploadCue(idx, bytes) {
    const cue = this.cueSheet[idx & (NUM_CUES - 1)];
    const n = Math.min(this.cueByteStride(), bytes.length);
    for (let i = 0; i < n; i++) cue.write(i, bytes[i] & 0xff);
  }

  set64ChannelMode(enabled) { this.is64ChannelMode = enabled; }

  // ── transport / params (delegate 56-139, 328-337, 505-575) ──

  setTrackerMode(ph) { /* PCM mode does not exist here; tracker is the only mode */ }
  play(ph) { this.playheads[ph].isPlaying = true; }
  stop(ph) { this.playheads[ph].isPlaying = false; }
  isPlaying(ph) { return this.playheads[ph].isPlaying; }

  setMasterVolume(ph, volume) { this.playheads[ph].masterVolume = volume & 255; }
  getMasterVolume(ph) { return this.playheads[ph].masterVolume; }
  setMasterPan(ph, pan) { this.playheads[ph].masterPan = pan & 255; }
  getMasterPan(ph) { return this.playheads[ph].masterPan; }

  setBPM(ph, bpm) { this.playheads[ph].bpm = Math.min(Math.max(bpm, 25), 535); }
  getBPM(ph) { return this.playheads[ph].bpm; }
  setTickRate(ph, rate) { this.playheads[ph].tickRate = rate & 255; }
  getTickRate(ph) { return this.playheads[ph].tickRate; }

  /**
   * Song tuning (item 77): `baseNote` sounds at `freq` Hz. Either reading zero
   * means the tracker default (spec) — tuningRatioOf applies that rule. Takes
   * effect on the next tick for notes already sounding, so dialling a tuning
   * while the song plays bends it in place rather than waiting for retriggers.
   */
  setTuning(ph, baseNote, freq) {
    const p = this.playheads[ph];
    p.tuningBaseNote = baseNote & 0xffff;
    p.tuningFreq = freq;
    p.trackerState.tuningRatio = tuningRatioOf(p.tuningBaseNote, p.tuningFreq);
  }
  getTuningRatio(ph) { return this.playheads[ph].trackerState.tuningRatio; }

  setCuePosition(ph, pos) {
    const p = this.playheads[ph];
    p.position = pos & (NUM_CUES - 1);
    p.trackerState.cuePos = p.position;
  }
  getCuePosition(ph) { return this.playheads[ph].position; }
  getTrackerRow(ph) { return this.playheads[ph].trackerState.rowIndex; }

  /** Set the starting row for the next play, resetting timing + silencing every
   *  voice. This is the common pre-play reset point (playFrom / pattern
   *  preview), so it clears the transient per-play state that would otherwise
   *  bleed a prior playback into a fresh start — notably the NNA background
   *  ghosts, which stop() leaves active and a replay would resume (the
   *  "mysteriously lingering notes" bug). Tempo/volume are deliberately NOT
   *  touched (a replay must keep the song's tempo — that's why this is not a
   *  full resetParams). */
  setTrackerRow(ph, row) {
    const ts = this.playheads[ph].trackerState;
    ts.rowIndex = Math.min(Math.max(row, 0), 63);
    ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0;
    ts.firstRow = true;
    ts.pendingOrderJump = -1;
    ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    ts.patternDelayRemaining = 0;
    ts.patternDelayActive = false;
    ts.sexWinningChannel = -1;
    ts.finePatternDelayExtra = 0;
    ts.pendingInterrupts = 0;
    for (const v of ts.voices) {
      v.active = false;
      // Clear per-voice pattern-loop (S$Bx) + Ditto (effect 7) memory so a replay
      // never resumes effect status from the previous play (item 44). These are
      // transient playback state, not song settings — the same rationale as the
      // ghost/note clears; resetPatternLoopState normally does this on cue
      // advances, but nothing did it at play START.
      v.loopStartRow = 0; v.loopCount = 0;
      v.dittoActive = false; v.dittoSourceStart = 0; v.dittoLength = 0; v.dittoEndRow = 0;
    }
    ts.backgroundVoices.length = 0; // drop lingering NNA ghosts from a prior play
    // Re-arm any Pattern-Ditto (effect 7) region that a mid-pattern start lands
    // inside, so a ghosted (repeated) row sounds when you play from it (item 81).
    reconstructDittoState(this, ts, ts.rowIndex);
  }

  setTrackerMixerFlags(ph, flags) {
    const p = this.playheads[ph];
    p.initialGlobalFlags = flags;
    p.updateTrackerGlobalBehaviour(flags);
  }
  getTrackerMixerFlags(ph) { return this.playheads[ph].initialGlobalFlags; }

  setSongGlobalVolume(ph, volume) { this.playheads[ph].globalVolume = volume & 255; }
  getSongGlobalVolume(ph) { return this.playheads[ph].globalVolume; }
  setSongMixingVolume(ph, volume) { this.playheads[ph].mixingVolume = volume & 255; }
  getSongMixingVolume(ph) { return this.playheads[ph].mixingVolume; }

  resetParams(ph) { this.playheads[ph].resetParams(); }
  resetFunkState(ph) { this.playheads[ph].resetFunkState(); }

  getFreePlayhead(fallback) {
    for (let i = 0; i < this.playheads.length; i++) {
      if (!this.playheads[i].isPlaying) return i;
    }
    return fallback;
  }

  /** Drain the pending interrupt latch (read-to-acknowledge, edge-triggered). */
  pollTrackerInterrupts(ph) {
    return this.playheads[ph].trackerState.drainInterrupts();
  }

  // ── jam / audition (AudioAdapter.kt:4322-4337) ──

  jamNote(ph, vi, note, inst, audition = false) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), MAX_VOICES - 1);
    note &= 0xffff;
    inst &= 0x3ff;
    triggerMetaOrNote(this, ts, ts.voices[v], v, note, inst, -1);
    // Audition-only (item 51): a STRICT metainstrument only sounds where its
    // Ixmp zones actually place a sample, so an arbitrary jammed pitch is often
    // silent. In pure-audition contexts (Instruments/Samples views) retry at the
    // nearest note it can actually sound, so the user hears the instrument.
    // Note ENTRY (Timeline/Patterns) keeps the exact pitch.
    if (audition && !ts.voices[v].active &&
        !ts.backgroundVoices.some((b) => b.sourceChannel === v && b.active)) {
      const alt = this._auditionNoteFor(inst, note);
      if (alt >= 0) triggerMetaOrNote(this, ts, ts.voices[v], v, alt, inst, -1);
    }
    p.jamActive = true;
  }

  /**
   * Preview the EXACT pooled sample `spec` (ptr/len/rate/loop) on voice `vi`,
   * BYPASSING all instrument / metainstrument zone resolution. The Samples and
   * Instruments editors call this so the audition plays the wave the user is
   * looking at, not whatever a metainstrument would map `note` to (bug #65).
   * JS-only (no Kotlin counterpart): a scratch instrument in AUDITION_SLOT
   * carries the sample and its clean default envelope so the note simply
   * sounds at full volume until jamStop / sample end.
   * `spec`: { ptr, len, rate, playStart?, loopStart, loopEnd, loopMode, detune? }.
   */
  jamSample(ph, vi, note, spec) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), MAX_VOICES - 1);
    note &= 0xffff;
    const inst = this.instruments[AUDITION_SLOT];
    inst.samplePtr = spec.ptr >>> 0;
    inst.sampleLength = spec.len | 0;
    inst.samplingRate = spec.rate | 0;
    inst.samplePlayStart = spec.playStart | 0;
    inst.sampleLoopStart = spec.loopStart | 0;
    inst.sampleLoopEnd = spec.loopEnd | 0;
    inst.loopMode = (spec.loopMode | 0) & 0x07; // loop mode + sustain, drop percussion bit
    inst.sampleDetune = (spec.detune | 0) & 0xffff;
    inst.extraPatches = null;
    triggerNote(this, ts, ts.voices[v], note, AUDITION_SLOT, -1);
    p.jamActive = true;
  }

  /** True when metainstrument `inst` would produce at least one sounding layer
   *  at `note` (mirrors the strict-layer gating in triggerMetaOrNote). */
  _metaSoundsAt(inst, note) {
    let layers = inst.resolveMetaLayers(note, 0x3f);
    if (inst.metaStrict) {
      layers = layers.filter((l) => {
        let n = note + l.detune;
        n = n < 0x20 ? 0x20 : n > 0xffff ? 0xffff : n;
        return this.instruments[l.instIdx].resolvePatch(n, 0x3f) !== null;
      });
    }
    return layers.length > 0;
  }

  /** Nearest note to `note` (within the metainstrument's layer bboxes) that
   *  actually sounds, or -1 if none / not a metainstrument. */
  _auditionNoteFor(instId, note) {
    const inst = this.instruments[instId];
    if (!inst || !inst.isMeta) return -1;
    let lo = 0xffff, hi = 0x20;
    for (const l of inst.metaLayers) {
      if (l.pitchStart < lo) lo = l.pitchStart;
      if (l.pitchEnd > hi) hi = l.pitchEnd;
    }
    if (lo < 0x20) lo = 0x20;
    if (hi < lo) return -1;
    // Sweep outward from the requested note at a fine step, clamped to the
    // bboxes' union (a jam event, so the cost is irrelevant).
    const step = 0x20;
    for (let d = 0; d <= hi - lo; d += step) {
      const up = note + d, dn = note - d;
      if (up >= lo && up <= hi && this._metaSoundsAt(inst, up)) return up;
      if (dn >= lo && dn <= hi && this._metaSoundsAt(inst, dn)) return dn;
    }
    return -1;
  }

  jamStop(ph) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    for (const v of ts.voices) v.active = false;
    for (const v of ts.backgroundVoices) v.active = false;
    p.jamActive = false;
  }

  // ── per-voice readbacks (delegate 144-325; clamps mirror the delegate) ──

  _voice(ph, vi) {
    const v = Math.min(Math.max(vi, 0), NUM_VOICES - 1);
    return this.playheads[ph].trackerState.voices[v];
  }

  setVoiceMute(ph, vi, muted) { this._voice(ph, vi).fader = muted ? 255 : 0; }
  getVoiceMute(ph, vi) { return this._voice(ph, vi).fader === 255; }
  setVoiceFader(ph, vi, fader) { this._voice(ph, vi).fader = fader & 255; }
  getVoiceFader(ph, vi) { return this._voice(ph, vi).fader; }

  getVoiceEffectiveVolume(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 0.0;
    const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
    const faderGain = (255 - v.fader) / 255.0;
    return Math.min(Math.max(effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain, 0.0), 1.0);
  }

  getVoiceEffectivePan(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 128;
    if (v.hasPanEnv && v.panEnvOn) {
      const envPanRaw = Math.min(Math.max(Math.trunc(v.envPan * 255.0), 0), 255);
      return Math.min(Math.max(v.channelPan + envPanRaw - 128, 0), 255);
    }
    return Math.min(Math.max(v.channelPan, 0), 255);
  }

  getVoiceActive(ph, vi) { return this._voice(ph, vi).active; }

  getActiveNoteCounts(ph) {
    const counts = new Int32Array(1024);
    const ts = this.playheads[ph].trackerState;
    for (const v of ts.voices) {
      if (v.active) counts[v.instrumentId & 0x3ff]++;
    }
    return counts;
  }

  getVoiceFunkSpeed(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.funkSpeed : 0;
  }

  getInstrumentFunkMask(slot) {
    const mask = this.instruments[slot & 0x3ff].funkMask;
    return mask === null ? new Uint8Array(0) : mask.slice();
  }

  getVoiceNote(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.noteVal & 0xffff : 0;
  }

  getVoiceInstrument(ph, vi) {
    const v = this._voice(ph, vi);
    // Pattern-level instrument (meta slot), not the resolved layer child.
    return v.active ? (v.displayInst || v.instrumentId) & 0x3ff : 0;
  }

  getVoiceSamplePos(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.samplePos : -1.0;
  }

  getVoiceSamplePtr(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.activeSamplePtr : -1;
  }

  getVoiceSampleLength(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? v.activeSampleLength : 0;
  }

  getVoiceEnvVolIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envIndex : -1; }
  getVoiceEnvVolTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envTimeSec : 0.0; }
  getVoiceEnvPanIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanIndex : -1; }
  getVoiceEnvPanTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanTimeSec : 0.0; }
  getVoiceEnvPitchIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchIndex : -1; }
  getVoiceEnvPitchTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchTimeSec : 0.0; }
  getVoiceEnvFilterIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterIndex : -1; }
  getVoiceEnvFilterTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterTimeSec : 0.0; }

  // ── rendering ──

  /**
   * Render one 512-frame chunk (interleaved U8 stereo, 1024 bytes) for playhead
   * ph. Pass a reusable out buffer to avoid allocation; a fresh one is made
   * otherwise. Returns the buffer (or null when the playhead has no state).
   */
  renderChunk(ph, out = new Uint8Array(TRACKER_CHUNK * 2)) {
    return generateTrackerAudio(this, this.playheads[ph], out);
  }
}
