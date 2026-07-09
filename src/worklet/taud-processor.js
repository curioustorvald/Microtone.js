// TaudProcessor — AudioWorkletProcessor hosting the Taud engine.
//
// The engine ALWAYS renders at 32 kHz (512-frame U8 stereo chunks, converted
// to float as (b−128)/128 to preserve the 8-bit dithered character). A float
// FIFO ring decouples the 128-frame process() quantum from the 512-frame
// engine chunk; when the context sample rate is not 32000 the ring is read
// with a fractional cursor + linear interpolation.
//
// This file is loaded with audioWorklet.addModule() as an ES module (static
// imports of ../engine/*). For browsers without module-worklet support, load
// the committed single-file concat instead: taud-processor.bundle.js
// (regenerate with tools/make-worklet-bundle.js).

import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK, MAX_VOICES } from "../engine/constants.js";
import {
  CMD, MSG,
  SNAP_CUE_POS, SNAP_ROW_INDEX, SNAP_TICK_IN_ROW, SNAP_BPM, SNAP_TICK_RATE,
  SNAP_FLAGS, SNAP_INTERRUPT_MASK, SNAP_CHANNEL_COUNT, SNAP_HEADER_SIZE,
  SNAP_V_ACTIVE, SNAP_V_EFF_VOL, SNAP_V_EFF_PAN, SNAP_V_NOTE, SNAP_V_INST,
  SNAP_V_SAMPLE_POS, SNAP_V_SAMPLE_PTR, SNAP_V_SAMPLE_LEN,
  SNAP_V_ENV_VOL_IDX, SNAP_V_ENV_VOL_TIME, SNAP_V_ENV_PAN_IDX, SNAP_V_ENV_PAN_TIME,
  SNAP_V_ENV_PITCH_IDX, SNAP_V_ENV_PITCH_TIME, SNAP_V_ENV_FILTER_IDX, SNAP_V_ENV_FILTER_TIME,
  SNAP_VOICE_STRIDE, SNAP_FLOATS,
} from "./protocol.js";

const RING_FRAMES = 4096; // power of two

class TaudProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new TaudEngine();
    this.playhead = 0; // the browser player drives playhead 0

    this.chunk = new Uint8Array(TRACKER_CHUNK * 2);
    this.ringL = new Float32Array(RING_FRAMES);
    this.ringR = new Float32Array(RING_FRAMES);
    this.ringWrite = 0;      // absolute frame counter (wraps via mask)
    this.ringReadPos = 0.0;  // fractional absolute read cursor
    this.step = SAMPLING_RATE / sampleRate; // 1.0 at a 32 kHz context

    const opts = options?.processorOptions ?? {};
    this.snapshotIntervalFrames =
      Math.max(1, Math.round(((opts.snapshotIntervalMs ?? 16) / 1000) * sampleRate));
    this.framesSinceSnapshot = 0;
    // Recycled snapshot buffers (transferred out, posted back via SNAPSHOT_RETURN).
    this.snapshotPool = [
      new ArrayBuffer(SNAP_FLOATS * 4),
      new ArrayBuffer(SNAP_FLOATS * 4),
    ];

    this.port.onmessage = (e) => this.onCommand(e.data);
    this.port.postMessage({ t: MSG.READY });
  }

  onCommand(m) {
    const eng = this.engine;
    switch (m.t) {
      case CMD.INIT:
        if (m.snapshotIntervalMs) {
          this.snapshotIntervalFrames =
            Math.max(1, Math.round((m.snapshotIntervalMs / 1000) * sampleRate));
        }
        break;
      case CMD.UPLOAD_SAMPLE_INST_BLOB: eng.uploadSampleInstBlob(new Uint8Array(m.image)); break;
      case CMD.UPLOAD_INSTRUMENT: eng.uploadInstrument(m.slot, new Uint8Array(m.bytes)); break;
      case CMD.UPLOAD_INSTRUMENT_PATCHES: eng.uploadInstrumentPatches(m.slot, new Uint8Array(m.bytes)); break;
      case CMD.CLEAR_INSTRUMENT_PATCHES: eng.clearInstrumentPatches(m.slot); break;
      case CMD.UPLOAD_PATTERN: eng.uploadPattern(m.slot, new Uint8Array(m.bytes)); break;
      case CMD.UPLOAD_PATTERNS: {
        const blob = new Uint8Array(m.blob);
        for (let i = 0; i < m.slots.length; i++) {
          eng.uploadPattern(m.slots[i], blob.subarray(i * 512, (i + 1) * 512));
        }
        break;
      }
      case CMD.UPLOAD_CUE: eng.uploadCue(m.idx, new Uint8Array(m.bytes)); break;
      case CMD.SET_64CH: eng.set64ChannelMode(m.on); break;
      case CMD.SET_BPM: eng.setBPM(m.ph, m.bpm); break;
      case CMD.SET_TICK_RATE: eng.setTickRate(m.ph, m.rate); break;
      case CMD.SET_SONG_GLOBAL_VOLUME: eng.setSongGlobalVolume(m.ph, m.volume); break;
      case CMD.SET_SONG_MIXING_VOLUME: eng.setSongMixingVolume(m.ph, m.volume); break;
      case CMD.SET_MASTER_VOLUME: eng.setMasterVolume(m.ph, m.volume); break;
      case CMD.SET_MASTER_PAN: eng.setMasterPan(m.ph, m.pan); break;
      case CMD.SET_TRACKER_MIXER_FLAGS: eng.setTrackerMixerFlags(m.ph, m.flags); break;
      case CMD.PLAY: eng.play(m.ph); break;
      case CMD.STOP: eng.stop(m.ph); break;
      case CMD.SET_CUE_POSITION: eng.setCuePosition(m.ph, m.pos); break;
      case CMD.SET_TRACKER_ROW: eng.setTrackerRow(m.ph, m.row); break;
      case CMD.RESET_PARAMS: eng.resetParams(m.ph); break;
      case CMD.RESET_FUNK_STATE: eng.resetFunkState(m.ph); break;
      case CMD.JAM_NOTE: eng.jamNote(m.ph, m.voice, m.note, m.inst); break;
      case CMD.JAM_STOP: eng.jamStop(m.ph); break;
      case CMD.SET_VOICE_MUTE: eng.setVoiceMute(m.ph, m.voice, m.muted); break;
      case CMD.SET_VOICE_FADER: eng.setVoiceFader(m.ph, m.voice, m.fader); break;
      case CMD.SNAPSHOT_RETURN:
        if (this.snapshotPool.length < 2) this.snapshotPool.push(m.buffer);
        break;
    }
  }

  renderIntoRing() {
    const out = this.engine.renderChunk(this.playhead, this.chunk);
    const mask = RING_FRAMES - 1;
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = 0;
        this.ringR[w] = 0;
      }
    } else {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = (out[n * 2] - 128) / 128;
        this.ringR[w] = (out[n * 2 + 1] - 128) / 128;
      }
    }
    this.ringWrite += TRACKER_CHUNK;
  }

  assembleSnapshot() {
    const buffer = this.snapshotPool.pop();
    if (!buffer) return; // main thread slow returning — skip, never allocate
    const f = new Float32Array(buffer);
    const eng = this.engine;
    const ph = eng.playheads[this.playhead];
    const ts = ph.trackerState;
    f[SNAP_CUE_POS] = ts.cuePos;
    f[SNAP_ROW_INDEX] = ts.rowIndex;
    f[SNAP_TICK_IN_ROW] = ts.tickInRow;
    f[SNAP_BPM] = ph.bpm;
    f[SNAP_TICK_RATE] = ph.tickRate;
    f[SNAP_FLAGS] = (ph.isPlaying ? 1 : 0) | (ph.jamActive ? 2 : 0);
    f[SNAP_INTERRUPT_MASK] = ts.drainInterrupts();
    f[SNAP_CHANNEL_COUNT] = eng.channelCount();
    for (let vi = 0; vi < MAX_VOICES; vi++) {
      const v = ts.voices[vi];
      const o = SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE;
      const active = v.active;
      f[o + SNAP_V_ACTIVE] = active ? 1 : 0;
      if (active) {
        const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
        const faderGain = (255 - v.fader) / 255.0;
        let ev = effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain;
        f[o + SNAP_V_EFF_VOL] = ev < 0 ? 0 : ev > 1 ? 1 : ev;
        let pan;
        if (v.hasPanEnv && v.panEnvOn) {
          let envPanRaw = Math.trunc(v.envPan * 255.0);
          envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
          pan = v.channelPan + envPanRaw - 128;
        } else {
          pan = v.channelPan;
        }
        f[o + SNAP_V_EFF_PAN] = pan < 0 ? 0 : pan > 255 ? 255 : pan;
        f[o + SNAP_V_NOTE] = v.noteVal & 0xffff;
        f[o + SNAP_V_INST] = v.instrumentId & 0x3ff;
        f[o + SNAP_V_SAMPLE_POS] = v.samplePos;
        f[o + SNAP_V_SAMPLE_PTR] = v.activeSamplePtr;
        f[o + SNAP_V_SAMPLE_LEN] = v.activeSampleLength;
        f[o + SNAP_V_ENV_VOL_IDX] = v.envIndex;
        f[o + SNAP_V_ENV_VOL_TIME] = v.envTimeSec;
        f[o + SNAP_V_ENV_PAN_IDX] = v.envPanIndex;
        f[o + SNAP_V_ENV_PAN_TIME] = v.envPanTimeSec;
        f[o + SNAP_V_ENV_PITCH_IDX] = v.envPitchIndex;
        f[o + SNAP_V_ENV_PITCH_TIME] = v.envPitchTimeSec;
        f[o + SNAP_V_ENV_FILTER_IDX] = v.envFilterIndex;
        f[o + SNAP_V_ENV_FILTER_TIME] = v.envFilterTimeSec;
      } else {
        for (let k = 1; k < SNAP_VOICE_STRIDE; k++) f[o + k] = 0;
        f[o + SNAP_V_EFF_PAN] = 128;
        f[o + SNAP_V_SAMPLE_POS] = -1;
        f[o + SNAP_V_SAMPLE_PTR] = -1;
        f[o + SNAP_V_ENV_VOL_IDX] = -1;
        f[o + SNAP_V_ENV_PAN_IDX] = -1;
        f[o + SNAP_V_ENV_PITCH_IDX] = -1;
        f[o + SNAP_V_ENV_FILTER_IDX] = -1;
      }
    }
    this.port.postMessage({ t: MSG.SNAPSHOT, buffer }, [buffer]);
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : outputs[0][0];
    const frames = outL.length;
    const ph = this.engine.playheads[this.playhead];
    const mask = RING_FRAMES - 1;

    if (ph.isPlaying || ph.jamActive || this.ringReadPos < this.ringWrite) {
      // Keep the ring at least one chunk ahead of the read cursor (+1 frame
      // headroom for the linear-interp neighbour).
      while (this.ringWrite < this.ringReadPos + frames * this.step + 2) {
        if (ph.isPlaying || ph.jamActive) {
          this.renderIntoRing();
        } else {
          // Drained and idle — pad silence so the cursor can pass the tail.
          const w = this.ringWrite & mask;
          this.ringL[w] = 0;
          this.ringR[w] = 0;
          this.ringWrite += 1;
        }
      }
      for (let n = 0; n < frames; n++) {
        const pos = this.ringReadPos;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = i0 & mask;
        const b = (i0 + 1) & mask;
        outL[n] = this.ringL[a] * (1 - frac) + this.ringL[b] * frac;
        outR[n] = this.ringR[a] * (1 - frac) + this.ringR[b] * frac;
        this.ringReadPos += this.step;
      }
    } else {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
    }

    this.framesSinceSnapshot += frames;
    if (this.framesSinceSnapshot >= this.snapshotIntervalFrames) {
      this.framesSinceSnapshot = 0;
      this.assembleSnapshot();
    }
    return true;
  }
}

registerProcessor("taud-processor", TaudProcessor);
