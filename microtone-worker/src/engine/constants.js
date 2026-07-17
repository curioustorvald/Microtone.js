// Taud engine constants — port of AudioAdapter.kt companion object (scalar part).
// Source: tsvm_core/src/net/torvald/tsvm/peripheral/AudioAdapter.kt:149-250
// Lookup tables (sinc, SNES gauss, Amiga filter coefficients) live in tables.js.

export const SAMPLING_RATE = 32000;
// Batch length of the mixer's per-sample loop. Tick/row timing is per-SAMPLE
// (mixer.js `samplesIntoTick`), so this is pure batching granularity and does
// NOT affect output — verified bit-exact vs the 512 baseline on the whole
// deterministic corpus. DELIBERATE web divergence from Kotlin's 512: the
// AudioWorklet must finish each render inside one ~2.67 ms quantum, and a 512-
// frame (16 ms) block renders in one burst that overruns the callback on slower
// devices (iPad: 5–14 ms/block → xruns); 128 spreads it evenly under budget.
export const TRACKER_CHUNK = 128;

// Per-voice soundscope ring-buffer length. Power of two so wrap-around is a single AND.
export const SCOPE_BUFFER_SIZE = 2048;

// Mixer-private background-voice pool size per playhead. NNA "Continue/Note Off/Note Fade"
// ghosts displaced foreground voices into this pool; oldest is evicted on overflow.
export const MAX_BG_VOICES = 64;

export const MIDDLE_C = 0x5000; // reference C for instrument samplingRate (terranmon.txt:2000)

// Amiga period at MIDDLE_C for a standard 8363 Hz instrument (NTSC clock 3579545 Hz).
export const AMIGA_BASE_PERIOD = 428.0;

// Reference frequency for linear-freq tone mode (toneMode == 2): 12-TET A4 = 440 Hz.
export const LINEAR_FREQ_C4_HZ = 261.6255653005986;

// ── Song tuning (terranmon.txt:3297-3324, §"Note Tuning"; web item 77) ──
// The song table declares "note TUNING base note sounds at TUNING freq Hz";
// tuningRatioOf() (tables.js) folds that pair into the playback-rate multiplier.
//
// Zero point: 12-TET concert C4, i.e. the same A4 = 440 the linear-freq mode
// references — numerically LINEAR_FREQ_C4_HZ, kept as its own name because it
// answers a different question (that one is the toneMode==2 slide reference,
// this one is where "no retune" sits).
export const TUNING_REF_C4_HZ = LINEAR_FREQ_C4_HZ;

// Field defaults for a zero/blank song table — spec: "If zero, assume the
// tracker default value". C9 @ 8363 Hz is the Amiga/tracker convention, which
// is NOT concert pitch: it puts A4 at 439.53 Hz, ~1.87 cents flat of 440. The
// spec quotes 439.548 Hz for the reference tuning from the exact NTSC clock
// ratio (3579545/428 = 8363.42 Hz); the format stores the rounded 8363.0, so
// the honest reading of a default song table lands 0.09 cents below that quote.
export const TUNING_DEFAULT_BASE_NOTE = 0xa000; // C9
export const TUNING_DEFAULT_FREQ_HZ = 8363.0;

// Anti-click ramp-out on sample end/cut: 8 ms at 32 kHz.
export const RAMP_OUT_SAMPLES = 256;

// Fast note-fade (note word 0x0004): SF2 exclusiveClass choke, ≈ FluidSynth's
// GEN_VOLENVRELEASE = -2000 timecents.
export const FAST_FADE_SEC = 0.3;

// Volume-change anti-click ramp: ~2 ms at 32 kHz. Bypassed on fresh note triggers.
export const VOL_RAMP_SAMPLES = 64;

// Sample bin: 8 MB total (banking is a device-protocol concern; the JS engine
// addresses the pool directly, as the Kotlin playback path does).
export const SAMPLE_BANK_SIZE = 524288;
export const SAMPLE_BANK_COUNT = 16;
export const SAMPLE_BIN_TOTAL = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT;

// Channels / voices. Physical voice & cue storage is always sized MAX_VOICES;
// 32-channel playback leaves the upper half inactive.
export const NUM_VOICES = 32;
export const MAX_VOICES = 64;
export const NUM_CUES = 8192;
export const CUE_BYTES = NUM_VOICES * 2;    // 64 bytes / cue (32-ch)
export const CUE_BYTES_64 = MAX_VOICES * 2; // 128 bytes / cue (64-ch)

// Pattern store: 15-bit pattern numbers; 0x7FFF = "no pattern on this channel".
export const NUM_PATTERNS = 0x7fff;
export const PATTERN_EMPTY = 0x7fff;

// Interpolation modes (TAUD_NOTE_EFFECTS.md §1, bits 2-4 of global behaviour flags).
export const INTERP_DEFAULT = 0;
export const INTERP_NONE = 1;
export const INTERP_A500 = 2;
export const INTERP_A1200 = 3;
export const INTERP_SNES = 4;
export const INTERP_NES_DPCM = 5;

// Fast Sinc kernel geometry (table itself is generated in tables.js).
export const SINC_WIDTH = 3;
export const SINC_PRECISION_SHIFT = 10;
export const SINC_PRECISION = 1 << SINC_PRECISION_SHIFT; // 1024

// Note-word sentinels (terranmon.txt:3040-3049).
export const NOTE_NOP = 0x0000;
export const NOTE_KEY_OFF = 0x0001;
export const NOTE_CUT = 0x0002;
export const NOTE_FADE = 0x0003;
export const NOTE_FAST_FADE = 0x0004;
export const NOTE_INT_FIRST = 0x0010; // Int0..IntF interrupt notes
export const NOTE_INT_LAST = 0x001f;
