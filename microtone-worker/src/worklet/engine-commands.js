// Engine command dispatch + snapshot fill, shared by the AudioWorklet
// (render-mode fallback) and the Tier 2 render Worker. Both host a TaudEngine
// and speak the same audio.*-shaped CMD protocol, so this keeps the mutation
// path in one place (no drift between the two hosts). Bundle-safe (plain export
// forms, unique names) — included in tools/make-worklet-bundle.js.

import { MAX_VOICES } from "../engine/constants.js";
import {
  CMD,
  SNAP_CUE_POS, SNAP_ROW_INDEX, SNAP_TICK_IN_ROW, SNAP_BPM, SNAP_TICK_RATE,
  SNAP_FLAGS, SNAP_CHANNEL_COUNT, SNAP_HEADER_SIZE,
  SNAP_V_ACTIVE, SNAP_V_EFF_VOL, SNAP_V_EFF_PAN, SNAP_V_NOTE, SNAP_V_INST,
  SNAP_V_SAMPLE_POS, SNAP_V_SAMPLE_PTR, SNAP_V_SAMPLE_LEN,
  SNAP_V_ENV_VOL_IDX, SNAP_V_ENV_VOL_TIME, SNAP_V_ENV_PAN_IDX, SNAP_V_ENV_PAN_TIME,
  SNAP_V_ENV_PITCH_IDX, SNAP_V_ENV_PITCH_TIME, SNAP_V_ENV_FILTER_IDX, SNAP_V_ENV_FILTER_TIME,
  SNAP_VOICE_STRIDE,
} from "./protocol.js";

/**
 * Apply an engine-mutating command to `eng`. Returns true if handled here.
 * Transport/reply commands (INIT, USE_SAB, USE_AUDIO_SAB, SNAPSHOT_RETURN,
 * QUERY_FUNK_MASK) return false — each host handles those itself.
 */
export function applyAudioCommand(eng, m) {
  switch (m.t) {
    case CMD.UPLOAD_SAMPLE_INST_BLOB: eng.uploadSampleInstBlob(new Uint8Array(m.image)); return true;
    case CMD.UPLOAD_INSTRUMENT: eng.uploadInstrument(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_INSTRUMENT_PATCHES: eng.uploadInstrumentPatches(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.CLEAR_INSTRUMENT_PATCHES: eng.clearInstrumentPatches(m.slot); return true;
    case CMD.UPLOAD_PATTERN: eng.uploadPattern(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_PATTERNS: {
      const blob = new Uint8Array(m.blob);
      for (let i = 0; i < m.slots.length; i++) {
        eng.uploadPattern(m.slots[i], blob.subarray(i * 512, (i + 1) * 512));
      }
      return true;
    }
    case CMD.UPLOAD_CUE: eng.uploadCue(m.idx, new Uint8Array(m.bytes)); return true;
    case CMD.SET_64CH: eng.set64ChannelMode(m.on); return true;
    case CMD.SET_BPM: eng.setBPM(m.ph, m.bpm); return true;
    case CMD.SET_TICK_RATE: eng.setTickRate(m.ph, m.rate); return true;
    case CMD.SET_SONG_GLOBAL_VOLUME: eng.setSongGlobalVolume(m.ph, m.volume); return true;
    case CMD.SET_SONG_MIXING_VOLUME: eng.setSongMixingVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_VOLUME: eng.setMasterVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_PAN: eng.setMasterPan(m.ph, m.pan); return true;
    case CMD.SET_TRACKER_MIXER_FLAGS: eng.setTrackerMixerFlags(m.ph, m.flags); return true;
    case CMD.PLAY: eng.play(m.ph); return true;
    case CMD.STOP: eng.stop(m.ph); return true;
    case CMD.SET_CUE_POSITION: eng.setCuePosition(m.ph, m.pos); return true;
    case CMD.SET_TRACKER_ROW: eng.setTrackerRow(m.ph, m.row); return true;
    case CMD.RESET_PARAMS: eng.resetParams(m.ph); return true;
    case CMD.RESET_FUNK_STATE: eng.resetFunkState(m.ph); return true;
    case CMD.JAM_NOTE: eng.jamNote(m.ph, m.voice, m.note, m.inst, m.audition); return true;
    case CMD.JAM_STOP: eng.jamStop(m.ph); return true;
    case CMD.SET_VOICE_MUTE: eng.setVoiceMute(m.ph, m.voice, m.muted); return true;
    case CMD.SET_VOICE_FADER: eng.setVoiceFader(m.ph, m.voice, m.fader); return true;
    default: return false;
  }
}

/** True for the transport commands that reset the play position (worker mode
 *  must flush the audio ring so no stale buffered tail plays after them). */
export function isTransportReset(t) {
  return t === CMD.PLAY || t === CMD.STOP ||
    t === CMD.SET_CUE_POSITION || t === CMD.SET_TRACKER_ROW || t === CMD.RESET_PARAMS;
}

/** Detached copy of instrument `slot`'s S$Fx invert-loop bit mask (reply payload). */
export function funkMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentFunkMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/** Write every snapshot field except the interrupt latch into `f`. */
export function fillSnapshotInto(eng, playhead, f) {
  const ph = eng.playheads[playhead];
  const ts = ph.trackerState;
  f[SNAP_CUE_POS] = ts.cuePos;
  f[SNAP_ROW_INDEX] = ts.rowIndex;
  f[SNAP_TICK_IN_ROW] = ts.tickInRow;
  f[SNAP_BPM] = ph.bpm;
  f[SNAP_TICK_RATE] = ph.tickRate;
  f[SNAP_FLAGS] = (ph.isPlaying ? 1 : 0) | (ph.jamActive ? 2 : 0);
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
      f[o + SNAP_V_NOTE] = (v.renderPitch > 0 ? v.renderPitch : v.noteVal) & 0xffff;
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
}
