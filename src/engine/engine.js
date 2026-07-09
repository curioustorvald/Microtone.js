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
import { TaudInst, parsePatchesBlob } from "./inst.js";
import { PlayCue, TaudPlayData, Playhead } from "./state.js";
import { makeXorshift32 } from "./rng.js";
import { generateTrackerAudio } from "./mixer.js";
import { triggerMetaOrNote } from "./trigger.js";

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
    this.instruments = new Array(1024);
    for (let i = 0; i < 1024; i++) this.instruments[i] = new TaudInst(i);
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
    const out = [];
    const w8 = (v) => out.push(v & 0xff);
    const w16 = (v) => { out.push(v & 0xff, (v >>> 8) & 0xff); };
    const w32 = (v) => { w16(v); w16(v >>> 16); };
    const wEnv = (env, loop, sus) => {
      w16(loop); w16(sus);
      for (let k = 0; k < 25; k++) { w8(env[k].value); w8(env[k].offset); }
    };
    for (const p of patches) {
      let ver = 0x01;
      if (p.hasExtra) ver |= 0x80;
      if (p.volEnv !== null) ver |= 0x02;
      if (p.panEnv !== null) ver |= 0x04;
      if (p.filterEnv !== null) ver |= 0x08;
      if (p.pitchEnv !== null) ver |= 0x10;
      w8(ver);
      w16(p.pitchStart); w16(p.pitchEnd);
      w8(p.volumeStart); w8(p.volumeEnd);
      w32(p.samplePtr);
      w16(p.sampleLength); w16(p.playStart); w16(p.loopStart); w16(p.loopEnd);
      w16(p.samplingRate); w16(p.sampleDetune); // two's complement round-trips
      w8(p.loopMode); w8(p.defaultPan); w8(p.defaultNoteVolume);
      w8(p.vibratoSpeed); w8(p.vibratoSweep); w8(p.vibratoDepth);
      w8(p.vibratoRate); w8(p.vibratoWaveform);
      if (p.hasExtra) {
        w32(p.filterSfMode ? 1 : 0); w32(0);
        w16(p.fadeoutStep); w16(p.extraCutoff); w16(p.extraResonance);
        w8(p.extraInitialAttenOctet);
      }
      if (p.volEnv !== null) wEnv(p.volEnv, p.volEnvLoop, p.volEnvSustain);
      if (p.panEnv !== null) wEnv(p.panEnv, p.panEnvLoop, p.panEnvSustain);
      if (p.filterEnv !== null) wEnv(p.filterEnv, p.filterEnvLoop, p.filterEnvSustain);
      if (p.pitchEnv !== null) wEnv(p.pitchEnv, p.pitchEnvLoop, p.pitchEnvSustain);
    }
    return Uint8Array.from(out);
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

  setCuePosition(ph, pos) {
    const p = this.playheads[ph];
    p.position = pos & (NUM_CUES - 1);
    p.trackerState.cuePos = p.position;
  }
  getCuePosition(ph) { return this.playheads[ph].position; }
  getTrackerRow(ph) { return this.playheads[ph].trackerState.rowIndex; }

  /** Set the starting row for the next play, resetting timing + silencing voices. */
  setTrackerRow(ph, row) {
    const ts = this.playheads[ph].trackerState;
    ts.rowIndex = Math.min(Math.max(row, 0), 63);
    ts.tickInRow = 0;
    ts.samplesIntoTick = 0.0;
    ts.firstRow = true;
    ts.pendingOrderJump = -1;
    ts.pendingRowJump = -1;
    for (const v of ts.voices) v.active = false;
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

  jamNote(ph, vi, note, inst) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), MAX_VOICES - 1);
    triggerMetaOrNote(this, ts, ts.voices[v], v, note & 0xffff, inst & 0x3ff, -1);
    p.jamActive = true;
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
    return v.active ? v.instrumentId & 0x3ff : 0;
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
