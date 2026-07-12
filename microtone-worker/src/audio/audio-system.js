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
  SNAP_VOICE_STRIDE, SNAP_FLOATS, SNAP_SAB_BYTES,
} from "../worklet/protocol.js";
import { MAX_VOICES, NUM_VOICES } from "../engine/constants.js";
import { AR_SAB_BYTES } from "./audio-ring.js";

const WORKLET_MODULE = new URL("../worklet/taud-processor.js", import.meta.url);
const WORKLET_BUNDLE = new URL("../worklet/taud-processor.bundle.js", import.meta.url);
const RENDER_WORKER = new URL("./render.worker.js", import.meta.url);

export class AudioSystem {
  constructor() {
    this.context = null;
    this.node = null;
    this.snapshot = new Float32Array(SNAP_FLOATS);
    this.snapshot[SNAP_CHANNEL_COUNT] = NUM_VOICES;
    this.interruptMask = 0; // accumulated between pollTrackerInterrupts calls
    this.onSnapshot = null; // optional callback(snapshot Float32Array; postMessage path only)
    this.usedBundleFallback = false;
    this.usingSab = false;  // shared-memory snapshots (crossOriginIsolated deploys)
    this.sabI32 = null;     // Int32Array view over the SAB interrupt latch
    this.worker = null;         // Tier 2 render Worker (isolated hosts); null in render mode
    this.usingWorker = false;   // engine renders off the audio thread (Tier 2)
    this._cueHighWater = 0;     // highest cue index+1 ever uploaded to the engine
                                // (the cueSheet persists across loads — blank the
                                // stale tail when a shorter song loads over it)
    this.engineTarget = null;   // where engine commands go: worklet port or the worker
    this.funkMasks = new Map(); // slot → Uint8Array (latest queried S$Fx invert mask)
    this.profile = null;    // latest worklet profiler report (opt-in; null when off)
    this.onProfile = null;  // optional callback(profile) when a report arrives
  }

  /** Create the context + node. Must be called once; audio starts suspended
   *  until resume() is called from a user gesture.
   *  Test knobs: forceBundle loads the single-file worklet concat; sampleRate
   *  overrides the context rate (exercises the 32 kHz→context resampler). */
  async init({ snapshotIntervalMs = 16, forceBundle = false, sampleRate = 48000, profile = false } = {}) {
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
      processorOptions: { snapshotIntervalMs, profile },
    });
    this.node.port.onmessage = (e) => this._onEngineMessage(e.data);
    this.node.connect(ctx.destination);
    this.engineTarget = this.node.port; // render mode: engine lives in the worklet

    // On cross-origin-isolated pages (COOP/COEP) we get SharedArrayBuffer, so:
    //   1. snapshots live in shared memory (no message traffic), and
    //   2. Tier 2 — a render Worker hosts the engine and streams audio into a
    //      SAB ring, leaving the AudioWorklet to only resample+copy (it can
    //      never overrun, whatever the channel/voice load). Non-isolated hosts
    //      keep the engine in the worklet (render mode) with postMessage snapshots.
    if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      const snapSab = new SharedArrayBuffer(SNAP_SAB_BYTES);
      const view = new Float32Array(snapSab, 0, SNAP_FLOATS);
      view.set(this.snapshot); // carry the pre-init defaults (channel count)
      this.snapshot = view;
      this.sabI32 = new Int32Array(snapSab, SNAP_FLOATS * 4, 1);
      this.usingSab = true;

      try {
        this.worker = new Worker(RENDER_WORKER, { type: "module" });
        this.worker.onmessage = (e) => this._onEngineMessage(e.data);
        const audioSab = new SharedArrayBuffer(AR_SAB_BYTES);
        this.node.port.postMessage({ t: CMD.USE_AUDIO_SAB, sab: audioSab }); // worklet → consume
        this.worker.postMessage({ t: CMD.USE_SAB, sab: snapSab });           // worker fills snapshots
        this.worker.postMessage({ t: CMD.USE_AUDIO_SAB, sab: audioSab });    // worker produces into the ring
        this.worker.postMessage({ t: CMD.INIT, snapshotIntervalMs });
        this.engineTarget = this.worker; // route engine commands to the worker
        this.usingWorker = true;
      } catch (e) {
        // Module Worker unavailable → keep the engine in the worklet, just with
        // SAB snapshots (the pre-Tier-2 isolated path).
        this.worker = null;
        this.node.port.postMessage({ t: CMD.USE_SAB, sab: snapSab });
        this.node.port.postMessage({ t: CMD.INIT, snapshotIntervalMs });
      }
    } else {
      this.node.port.postMessage({ t: CMD.INIT, snapshotIntervalMs });
    }
    return this;
  }

  /** Messages from whichever thread hosts the engine (worklet port in render
   *  mode, the Worker in Tier 2). Snapshots only arrive via postMessage in
   *  render mode without SAB. */
  _onEngineMessage(m) {
    if (m.t === MSG.SNAPSHOT) {
      const f = new Float32Array(m.buffer);
      // A snapshot posted before a USE_SAB switch landed must not clobber the
      // live shared view — but its latched interrupts still count.
      this.interruptMask |= f[SNAP_INTERRUPT_MASK];
      if (!this.usingSab) {
        this.snapshot.set(f);
        if (this.onSnapshot) this.onSnapshot(this.snapshot);
      }
      this.node.port.postMessage({ t: CMD.SNAPSHOT_RETURN, buffer: m.buffer }, [m.buffer]);
    } else if (m.t === MSG.FUNK_MASK) {
      this.funkMasks.set(m.slot, new Uint8Array(m.mask));
    } else if (m.t === MSG.PROFILE) {
      // Enrich the worklet report with main-side facts it cannot see.
      m.usingSab = this.usingSab;
      m.usingWorker = this.usingWorker;
      m.bundleFallback = this.usedBundleFallback;
      m.contextSampleRate = this.context.sampleRate;
      this.profile = m;
      if (this.onProfile) this.onProfile(m);
    }
  }

  get running() { return this.context?.state === "running"; }

  /** Call from a user gesture (pointerdown/keydown). */
  async resume() {
    if (this.context && this.context.state !== "running") await this.context.resume();
  }

  // Engine commands go to whichever thread hosts the engine (the worklet port
  // in render mode, the render Worker in Tier 2). Both share the postMessage
  // (msg, transfer) signature.
  _post(msg, transfer) { this.engineTarget.postMessage(msg, transfer ?? []); }

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
    // Blank any cues left over from a longer previously-loaded song (the engine
    // keeps one persistent cueSheet). Without this a doc grown into that stale
    // tail — now reachable via the Cues view's full-range scroll — could replay
    // the old song's patterns. 0x7FFF = CUE_EMPTY (bytes 0xFF, 0x7F).
    for (let c = song.cues.length; c < this._cueHighWater; c++) {
      const empty = new Uint8Array(chans * 2);
      for (let i = 0; i < chans * 2; i += 2) { empty[i] = 0xff; empty[i + 1] = 0x7f; }
      this._post({ t: CMD.UPLOAD_CUE, idx: c, bytes: empty.buffer }, [empty.buffer]);
    }
    this._cueHighWater = song.cues.length;

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
    if (idx + 1 > this._cueHighWater) this._cueHighWater = idx + 1;
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_CUE, idx, bytes: buf }, [buf]);
  }
  uploadInstrument(slot, bytes) {
    const buf = bytes.slice().buffer;
    this._post({ t: CMD.UPLOAD_INSTRUMENT, slot, bytes: buf }, [buf]);
  }
  /** Replace the whole 8650752-byte sample+inst image (bank import/undo).
   *  Clears all uploaded Ixmp patch state — re-send the blobs afterwards. */
  uploadSampleInstImage(image) {
    const buf = image.slice().buffer;
    this._post({ t: CMD.UPLOAD_SAMPLE_INST_BLOB, image: buf }, [buf]);
  }
  uploadInstrumentPatches(slot, blob) {
    const buf = blob.slice().buffer;
    this._post({ t: CMD.UPLOAD_INSTRUMENT_PATCHES, slot, bytes: buf }, [buf]);
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

  /** Edge-triggered latch, accumulated across snapshots; reading clears.
   *  SAB path: the worklet ORs into the shared Int32 cell; draining is one
   *  atomic exchange. (Both sources merge — snapshots posted before the
   *  USE_SAB switch landed still count.) */
  pollTrackerInterrupts() {
    let m = this.interruptMask;
    this.interruptMask = 0;
    if (this.sabI32 !== null) m |= Atomics.exchange(this.sabI32, 0, 0);
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
