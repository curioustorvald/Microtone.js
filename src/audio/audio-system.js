// AudioSystem — main-thread side of the worklet: AudioContext lifecycle,
// command senders shaped like the TSVM `audio.*` API, and the snapshot store.
//
// The main thread owns the canonical document; the worklet holds a playback
// copy fed by upload commands (exactly how taut.js treats the TSVM device).
// Worklet state arrives as recycled snapshots (~16 ms); reads are synchronous
// against the latest snapshot, so UI code keeps taut.js's synchronous idiom.

import {
  CMD, MSG,
  SNAP_CUE_POS, SNAP_ROW_INDEX, SNAP_BPM, SNAP_TICK_RATE, SNAP_FLAGS,
  SNAP_INTERRUPT_MASK, SNAP_CHANNEL_COUNT, SNAP_HEADER_SIZE,
  SNAP_V_ACTIVE, SNAP_V_EFF_VOL, SNAP_V_EFF_PAN, SNAP_V_NOTE, SNAP_V_INST,
  SNAP_V_SAMPLE_POS, SNAP_V_SAMPLE_PTR, SNAP_V_SAMPLE_LEN,
  SNAP_V_ENV_VOL_IDX, SNAP_V_ENV_VOL_TIME, SNAP_V_ENV_PAN_IDX, SNAP_V_ENV_PAN_TIME,
  SNAP_V_ENV_PITCH_IDX, SNAP_V_ENV_PITCH_TIME, SNAP_V_ENV_FILTER_IDX, SNAP_V_ENV_FILTER_TIME,
  SNAP_VOICE_STRIDE, SNAP_FLOATS,
} from "../worklet/protocol.js";
import { MAX_VOICES, NUM_VOICES } from "../engine/constants.js";

const WORKLET_MODULE = new URL("../worklet/taud-processor.js", import.meta.url);
const WORKLET_BUNDLE = new URL("../worklet/taud-processor.bundle.js", import.meta.url);

export class AudioSystem {
  constructor() {
    this.context = null;
    this.node = null;
    this.snapshot = new Float32Array(SNAP_FLOATS);
    this.snapshot[SNAP_CHANNEL_COUNT] = NUM_VOICES;
    this.interruptMask = 0; // accumulated between pollTrackerInterrupts calls
    this.onSnapshot = null; // optional callback(snapshot Float32Array)
    this.usedBundleFallback = false;
    this.funkMasks = new Map(); // slot → Uint8Array (latest queried S$Fx invert mask)
  }

  /** Create the context + node. Must be called once; audio starts suspended
   *  until resume() is called from a user gesture.
   *  Test knobs: forceBundle loads the single-file worklet concat; sampleRate
   *  overrides the context rate (exercises the 32 kHz→context resampler). */
  async init({ snapshotIntervalMs = 16, forceBundle = false, sampleRate = 48000 } = {}) {
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
    } catch {
      ctx = new AudioContext({ latencyHint: "interactive" }); // resampler path
    }
    this.context = ctx;

    if (forceBundle) {
      await ctx.audioWorklet.addModule(WORKLET_BUNDLE);
      this.usedBundleFallback = true;
    } else {
      try {
        await ctx.audioWorklet.addModule(WORKLET_MODULE);
      } catch (e) {
        // Firefox (no module-worklet import support): committed single-file concat.
        await ctx.audioWorklet.addModule(WORKLET_BUNDLE);
        this.usedBundleFallback = true;
      }
    }

    this.node = new AudioWorkletNode(ctx, "taud-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { snapshotIntervalMs },
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === MSG.SNAPSHOT) {
        const f = new Float32Array(m.buffer);
        this.snapshot.set(f);
        this.interruptMask |= f[SNAP_INTERRUPT_MASK];
        this.node.port.postMessage({ t: CMD.SNAPSHOT_RETURN, buffer: m.buffer }, [m.buffer]);
        if (this.onSnapshot) this.onSnapshot(this.snapshot);
      } else if (m.t === MSG.FUNK_MASK) {
        this.funkMasks.set(m.slot, new Uint8Array(m.mask));
      }
    };
    this.node.connect(ctx.destination);
    return this;
  }

  get running() { return this.context?.state === "running"; }

  /** Call from a user gesture (pointerdown/keydown). */
  async resume() {
    if (this.context && this.context.state !== "running") await this.context.resume();
  }

  _post(msg, transfer) { this.node.port.postMessage(msg, transfer ?? []); }

  // ── document upload (mirror of taud.mjs uploadTaudFile order) ──

  /**
   * Push a parsed Taud document (the shape taud-parse returns) to the worklet
   * for playback of song songIndex. Copies the sample+inst image (the caller's
   * document keeps its own).
   */
  loadDocument(doc, songIndex = 0) {
    const song = doc.songs[songIndex];
    if (!song) throw new Error("songIndex out of range");

    this._post({ t: CMD.SET_64CH, on: doc.is64Channel });

    if (doc.sampleInstImage) {
      const image = doc.sampleInstImage.slice().buffer;
      this._post({ t: CMD.UPLOAD_SAMPLE_INST_BLOB, image }, [image]);
    }

    // Bulk pattern upload (one transfer).
    const nPats = song.patterns.length;
    const blob = new Uint8Array(nPats * 512);
    const slots = new Array(nPats);
    for (let p = 0; p < nPats; p++) {
      blob.set(song.patterns[p], p * 512);
      slots[p] = p;
    }
    this._post({ t: CMD.UPLOAD_PATTERNS, slots, blob: blob.buffer }, [blob.buffer]);

    const chans = doc.is64Channel ? 64 : 32;
    for (let c = 0; c < song.cues.length; c++) {
      const words = song.cues[c];
      const bytes = new Uint8Array(chans * 2);
      for (let ch = 0; ch < chans; ch++) {
        bytes[ch * 2] = words[ch] & 0xff;
        bytes[ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
      }
      this._post({ t: CMD.UPLOAD_CUE, idx: c, bytes: bytes.buffer }, [bytes.buffer]);
    }

    this.setBPM(0, song.bpm);
    this.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
    this.setTrackerMixerFlags(0, song.globalFlags);
    this.setSongGlobalVolume(0, song.globalVolume);
    this.setSongMixingVolume(0, song.mixingVolume);
    this.setMasterVolume(0, 255);

    for (const entry of doc.ixmp) {
      const bytes = entry.blob.slice().buffer;
      this._post({ t: CMD.UPLOAD_INSTRUMENT_PATCHES, slot: entry.instId, bytes }, [bytes]);
    }
  }

  // ── audio.*-shaped command surface ──

  play(ph = 0) { this._post({ t: CMD.PLAY, ph }); }
  stop(ph = 0) { this._post({ t: CMD.STOP, ph }); }
  setCuePosition(ph, pos) { this._post({ t: CMD.SET_CUE_POSITION, ph, pos }); }
  setTrackerRow(ph, row) { this._post({ t: CMD.SET_TRACKER_ROW, ph, row }); }
  setBPM(ph, bpm) { this._post({ t: CMD.SET_BPM, ph, bpm }); }
  setTickRate(ph, rate) { this._post({ t: CMD.SET_TICK_RATE, ph, rate }); }
  setSongGlobalVolume(ph, volume) { this._post({ t: CMD.SET_SONG_GLOBAL_VOLUME, ph, volume }); }
  setSongMixingVolume(ph, volume) { this._post({ t: CMD.SET_SONG_MIXING_VOLUME, ph, volume }); }
  setMasterVolume(ph, volume) { this._post({ t: CMD.SET_MASTER_VOLUME, ph, volume }); }
  setMasterPan(ph, pan) { this._post({ t: CMD.SET_MASTER_PAN, ph, pan }); }
  setTrackerMixerFlags(ph, flags) { this._post({ t: CMD.SET_TRACKER_MIXER_FLAGS, ph, flags }); }
  resetParams(ph = 0) { this._post({ t: CMD.RESET_PARAMS, ph }); }
  resetFunkState(ph = 0) { this._post({ t: CMD.RESET_FUNK_STATE, ph }); }
  jamNote(ph, voice, note, inst) { this._post({ t: CMD.JAM_NOTE, ph, voice, note, inst }); }
  jamStop(ph = 0) { this._post({ t: CMD.JAM_STOP, ph }); }
  setVoiceMute(ph, voice, muted) { this._post({ t: CMD.SET_VOICE_MUTE, ph, voice, muted }); }
  setVoiceFader(ph, voice, fader) { this._post({ t: CMD.SET_VOICE_FADER, ph, voice, fader }); }
  uploadPattern(slot, bytes) {
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_PATTERN, slot, bytes: buf }, [buf]);
  }
  uploadCue(idx, bytes) {
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_CUE, idx, bytes: buf }, [buf]);
  }
  uploadInstrument(slot, bytes) {
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_INSTRUMENT, slot, bytes: buf }, [buf]);
  }
  set64ChannelMode(on) { this._post({ t: CMD.SET_64CH, on }); }

  /** Ask the worklet for instrument `slot`'s live S$Fx invert-loop bit mask;
   *  the reply lands in funkMasks (read via getFunkMask, ~1 frame later). */
  requestFunkMask(slot) { this._post({ t: CMD.QUERY_FUNK_MASK, slot }); }
  /** Latest queried funk mask for `slot` (Uint8Array; empty when none). */
  getFunkMask(slot) { return this.funkMasks.get(slot) ?? null; }

  // ── snapshot-backed synchronous readbacks (audio.*-shaped) ──

  isPlaying() { return (this.snapshot[SNAP_FLAGS] & 1) !== 0; }
  getCuePosition() { return this.snapshot[SNAP_CUE_POS]; }
  getTrackerRow() { return this.snapshot[SNAP_ROW_INDEX]; }
  getBPM() { return this.snapshot[SNAP_BPM]; }
  getTickRate() { return this.snapshot[SNAP_TICK_RATE]; }
  channelCount() { return this.snapshot[SNAP_CHANNEL_COUNT] || NUM_VOICES; }

  /** Edge-triggered latch, accumulated across snapshots; reading clears. */
  pollTrackerInterrupts() {
    const m = this.interruptMask;
    this.interruptMask = 0;
    return m;
  }

  _v(vi, field) {
    const v = Math.min(Math.max(vi, 0), MAX_VOICES - 1);
    return this.snapshot[SNAP_HEADER_SIZE + v * SNAP_VOICE_STRIDE + field];
  }

  getVoiceActive(vi) { return this._v(vi, SNAP_V_ACTIVE) !== 0; }
  getVoiceEffectiveVolume(vi) { return this._v(vi, SNAP_V_EFF_VOL); }
  getVoiceEffectivePan(vi) { return this._v(vi, SNAP_V_EFF_PAN); }
  getVoiceNote(vi) { return this._v(vi, SNAP_V_NOTE); }
  getVoiceInstrument(vi) { return this._v(vi, SNAP_V_INST); }
  getVoiceSamplePos(vi) { return this._v(vi, SNAP_V_SAMPLE_POS); }
  getVoiceSamplePtr(vi) { return this._v(vi, SNAP_V_SAMPLE_PTR); }
  getVoiceSampleLength(vi) { return this._v(vi, SNAP_V_SAMPLE_LEN); }
  getVoiceEnvVolIndex(vi) { return this._v(vi, SNAP_V_ENV_VOL_IDX); }
  getVoiceEnvVolTime(vi) { return this._v(vi, SNAP_V_ENV_VOL_TIME); }
  getVoiceEnvPanIndex(vi) { return this._v(vi, SNAP_V_ENV_PAN_IDX); }
  getVoiceEnvPanTime(vi) { return this._v(vi, SNAP_V_ENV_PAN_TIME); }
  getVoiceEnvPitchIndex(vi) { return this._v(vi, SNAP_V_ENV_PITCH_IDX); }
  getVoiceEnvPitchTime(vi) { return this._v(vi, SNAP_V_ENV_PITCH_TIME); }
  getVoiceEnvFilterIndex(vi) { return this._v(vi, SNAP_V_ENV_FILTER_IDX); }
  getVoiceEnvFilterTime(vi) { return this._v(vi, SNAP_V_ENV_FILTER_TIME); }
}
