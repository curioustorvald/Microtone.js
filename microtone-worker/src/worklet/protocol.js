// Message protocol shared by the AudioWorklet processor and the main thread.
// Commands (main → worklet) are plain {t, ...} messages, deliberately
// isomorphic to the TSVM `audio.*` calls taut.js makes; bulk payloads ride as
// transferred ArrayBuffers. Snapshots (worklet → main) are recycled
// Float32Array buffers with the fixed layout below.

export const CMD = Object.freeze({
  INIT: "init",
  UPLOAD_SAMPLE_INST_BLOB: "uploadSampleInstBlob", // {image: ArrayBuffer} (decompressed)
  UPLOAD_INSTRUMENT: "uploadInstrument",           // {slot, bytes: ArrayBuffer}
  UPLOAD_INSTRUMENT_PATCHES: "uploadInstrumentPatches", // {slot, bytes: ArrayBuffer}
  CLEAR_INSTRUMENT_PATCHES: "clearInstrumentPatches",   // {slot}
  UPLOAD_PATTERN: "uploadPattern",                 // {slot, bytes: ArrayBuffer}
  UPLOAD_PATTERNS: "uploadPatterns",               // {slots: int[], blob: ArrayBuffer} (bulk, 512 B each)
  UPLOAD_CUE: "uploadCue",                         // {idx, bytes: ArrayBuffer}
  SET_64CH: "set64ChannelMode",                    // {on}
  SET_BPM: "setBPM",                               // {ph, bpm}
  SET_TICK_RATE: "setTickRate",                    // {ph, rate}
  SET_TUNING: "setTuning",                         // {ph, baseNote, freq} — song tuning (item 77)
  SET_SONG_GLOBAL_VOLUME: "setSongGlobalVolume",   // {ph, volume}
  SET_SONG_MIXING_VOLUME: "setSongMixingVolume",   // {ph, volume}
  SET_MASTER_VOLUME: "setMasterVolume",            // {ph, volume}
  SET_MASTER_PAN: "setMasterPan",                  // {ph, pan}
  SET_TRACKER_MIXER_FLAGS: "setTrackerMixerFlags", // {ph, flags}
  PLAY: "play",                                    // {ph}
  STOP: "stop",                                    // {ph}
  SET_CUE_POSITION: "setCuePosition",              // {ph, pos}
  SET_TRACKER_ROW: "setTrackerRow",                // {ph, row}
  RESET_PARAMS: "resetParams",                     // {ph}
  RESET_FUNK_STATE: "resetFunkState",              // {ph}
  JAM_NOTE: "jamNote",                             // {ph, voice, note, inst}
  JAM_SAMPLE: "jamSample",                         // {ph, voice, note, spec} — raw pooled-sample preview
  JAM_STOP: "jamStop",                             // {ph}
  SET_VOICE_MUTE: "setVoiceMute",                  // {ph, voice, muted}
  SET_VOICE_FADER: "setVoiceFader",                // {ph, voice, fader}
  QUERY_FUNK_MASK: "queryFunkMask",                // {slot} → MSG.FUNK_MASK
  SNAPSHOT_RETURN: "snapshotReturn",               // {buffer: ArrayBuffer} (recycle)
  USE_SAB: "useSab",                               // {sab: SharedArrayBuffer} — switch to shared-memory snapshots
  USE_AUDIO_SAB: "useAudioSab",                    // {sab: SharedArrayBuffer} — Tier 2 audio ring (worklet consumes; worker produces)
});

export const MSG = Object.freeze({
  SNAPSHOT: "snapshot", // {buffer: ArrayBuffer} — Float32Array, layout below
  FUNK_MASK: "funkMask", // {slot, mask: ArrayBuffer} — S$Fx invert-loop bit mask
  READY: "ready",
  PROFILE: "profile",   // {cpuFrac, renderFrac, ...} — dev profiler, ~1/s (opt-in)
});

// ── Snapshot layout (Float32Array; integers are exact in f32 up to 2^24) ──
export const SNAP_CUE_POS = 0;
export const SNAP_ROW_INDEX = 1;
export const SNAP_TICK_IN_ROW = 2;
export const SNAP_BPM = 3;
export const SNAP_TICK_RATE = 4;
export const SNAP_FLAGS = 5;          // bit0 isPlaying, bit1 jamActive
export const SNAP_INTERRUPT_MASK = 6; // drained latch (edge-triggered)
export const SNAP_CHANNEL_COUNT = 7;
export const SNAP_HEADER_SIZE = 8;

// Per-voice block, stride SNAP_VOICE_STRIDE, MAX_VOICES blocks.
export const SNAP_V_ACTIVE = 0;
export const SNAP_V_EFF_VOL = 1;      // 0..1 (getVoiceEffectiveVolume)
export const SNAP_V_EFF_PAN = 2;      // 0..255 (getVoiceEffectivePan)
export const SNAP_V_NOTE = 3;      // per-tick sounding pitch (renderPitch; follows slides/arp/vibrato)
export const SNAP_V_INST = 4;
export const SNAP_V_SAMPLE_POS = 5;
export const SNAP_V_SAMPLE_PTR = 6;
export const SNAP_V_SAMPLE_LEN = 7;
export const SNAP_V_ENV_VOL_IDX = 8;
export const SNAP_V_ENV_VOL_TIME = 9;
export const SNAP_V_ENV_PAN_IDX = 10;
export const SNAP_V_ENV_PAN_TIME = 11;
export const SNAP_V_ENV_PITCH_IDX = 12;
export const SNAP_V_ENV_PITCH_TIME = 13;
export const SNAP_V_ENV_FILTER_IDX = 14;
export const SNAP_V_ENV_FILTER_TIME = 15;
export const SNAP_VOICE_STRIDE = 16;

export const SNAP_MAX_VOICES = 64;
export const SNAP_FLOATS = SNAP_HEADER_SIZE + SNAP_MAX_VOICES * SNAP_VOICE_STRIDE; // 1032

// SAB fast path (crossOriginIsolated deploys): one shared buffer holding the
// float snapshot region plus a trailing Int32 interrupt-latch cell that the
// worklet ORs into (Atomics.or) and the main thread drains
// (Atomics.exchange 0). The float SNAP_INTERRUPT_MASK slot is only used by
// the postMessage fallback.
export const SNAP_SAB_BYTES = SNAP_FLOATS * 4 + 4;
