// GENERATED FILE — do not edit. Rebuild with: node tools/make-worklet-bundle.js
// Single-file concat of src/engine/* + src/worklet/* for non-module AudioWorklets.
"use strict";

// ══ src/engine/constants.js ══
// Taud engine constants — port of AudioAdapter.kt companion object (scalar part).
// Source: tsvm_core/src/net/torvald/tsvm/peripheral/AudioAdapter.kt:149-250
// Lookup tables (sinc, SNES gauss, Amiga filter coefficients) live in tables.js.

// ── Output sampling rate (web item 108) ───────────────────────────────────
// DELIBERATE web divergence from Kotlin's fixed 32000. Browsers run their
// AudioContext at 48 kHz, so a 32 kHz engine had to be resampled on the way
// out — for playback AND for the default 48 kHz WAV export. Rendering at
// 48 kHz deletes that stage from both default paths: at a 48 kHz context the
// worklet's read cursor steps by exactly 1.0 and one TRACKER_CHUNK is exactly
// one render quantum.
//
// Everything rate-derived (tick length, the IT/SF2 filter coefficients, the
// Amiga LPF/LED coefficients, the anti-click ramps) is computed FROM this
// value, so the audible parameters stay where they are in Hz and in
// milliseconds — what changes is that they are now realised on a 48 kHz grid.
//
// It is a `let`, not a const: setSamplingRate() below puts the engine back on
// 32 kHz for the JVM-oracle conformance tests and the Kotlin-mirroring
// scenario tests, which compare against 32 kHz reference renders. Set it ONCE
// before rendering — like rng.js's seed, it is start-up configuration, not a
// per-render parameter.
let SAMPLING_RATE = 48000;
// Batch length of the mixer's per-sample loop. Tick/row timing is per-SAMPLE
// (mixer.js `samplesIntoTick`), so this is pure batching granularity and does
// NOT affect output — verified bit-exact vs the 512 baseline on the whole
// deterministic corpus. DELIBERATE web divergence from Kotlin's 512: the
// AudioWorklet must finish each render inside one ~2.67 ms quantum, and a 512-
// frame (16 ms) block renders in one burst that overruns the callback on slower
// devices (iPad: 5–14 ms/block → xruns); 128 spreads it evenly under budget.
const TRACKER_CHUNK = 128;

// Per-voice soundscope ring-buffer length. Power of two so wrap-around is a single AND.
const SCOPE_BUFFER_SIZE = 2048;

// Mixer-private background-voice pool size per playhead. NNA "Continue/Note Off/Note Fade"
// ghosts displaced foreground voices into this pool; oldest is evicted on overflow.
const MAX_BG_VOICES = 64;

const MIDDLE_C = 0x5000; // reference C for instrument samplingRate (terranmon.txt:2000)

// Amiga period at MIDDLE_C for a standard 8363 Hz instrument (NTSC clock 3579545 Hz).
const AMIGA_BASE_PERIOD = 428.0;

// Reference frequency for linear-freq tone mode (toneMode == 2): 12-TET A4 = 440 Hz.
const LINEAR_FREQ_C4_HZ = 261.6255653005986;

// ── Song tuning (terranmon.txt:3297-3324, §"Note Tuning"; web item 77) ──
// The song table declares "note TUNING base note sounds at TUNING freq Hz";
// tuningRatioOf() (tables.js) folds that pair into the playback-rate multiplier.
//
// Zero point: 12-TET concert C4, i.e. the same A4 = 440 the linear-freq mode
// references — numerically LINEAR_FREQ_C4_HZ, kept as its own name because it
// answers a different question (that one is the toneMode==2 slide reference,
// this one is where "no retune" sits).
const TUNING_REF_C4_HZ = LINEAR_FREQ_C4_HZ;

// Field defaults for a zero/blank song table — spec: "If zero, assume the
// tracker default value". C9 @ 8363 Hz is the Amiga/tracker convention, which
// is NOT concert pitch: it puts A4 at 439.53 Hz, ~1.87 cents flat of 440. The
// spec quotes 439.548 Hz for the reference tuning from the exact NTSC clock
// ratio (3579545/428 = 8363.42 Hz); the format stores the rounded 8363.0, so
// the honest reading of a default song table lands 0.09 cents below that quote.
const TUNING_DEFAULT_BASE_NOTE = 0xa000; // C9
const TUNING_DEFAULT_FREQ_HZ = 8363.0;

// Anti-click ramp-out on sample end/cut: 8 ms (256 samples at Kotlin's 32 kHz).
let RAMP_OUT_SAMPLES = 384;
const RAMP_OUT_SEC = 0.008;

// Fast note-fade (note word 0x0004): SF2 exclusiveClass choke, ≈ FluidSynth's
// GEN_VOLENVRELEASE = -2000 timecents.
const FAST_FADE_SEC = 0.3;

// Volume-change anti-click ramp: 2 ms (64 samples at Kotlin's 32 kHz).
// Bypassed on fresh note triggers.
let VOL_RAMP_SAMPLES = 96;
const VOL_RAMP_SEC = 0.002;

// Volume ramp for Attack (item 139): every fresh note trigger fades IN over this
// many samples on a half-cosine curve, 0 -> unity, instead of stepping straight to
// full gain. 32 samples at 48 kHz (~0.67 ms) is the reference figure the constant
// is named for; ATTACK_RAMP_SEC carries it to other rates the same way RAMP_OUT_SEC
// and VOL_RAMP_SEC do.
let ATTACK_RAMP_SAMPLES = 32;
const ATTACK_RAMP_SEC = 32 / 48000;

// Modules whose load-time tables are rate-derived (tables.js's Amiga filter
// coefficients) register here so setSamplingRate can rebuild them. Coefficients
// computed per call — the IT/SF2 voice filters — need no registration.
const rateListeners = new Set();

/** Register a rebuild callback; it fires on every later setSamplingRate. */
function onSamplingRateChange(fn) {
  rateListeners.add(fn);
  return fn;
}

/**
 * Move the engine's output rate. Call BEFORE constructing an engine: voices
 * already carrying ramp counters or filter state keep the old rate's numbers.
 * Rebuilds every rate-derived table, so the Amiga low-pass stays at 4421 Hz
 * and the anti-click ramps stay at 8 ms / 2 ms whatever the rate.
 */
function setSamplingRate(rate) {
  SAMPLING_RATE = rate;
  RAMP_OUT_SAMPLES = Math.round(RAMP_OUT_SEC * rate);
  VOL_RAMP_SAMPLES = Math.round(VOL_RAMP_SEC * rate);
  ATTACK_RAMP_SAMPLES = Math.round(ATTACK_RAMP_SEC * rate);
  for (const fn of rateListeners) fn(rate);
}

// Sample bin: 8 MB total (banking is a device-protocol concern; the JS engine
// addresses the pool directly, as the Kotlin playback path does).
const SAMPLE_BANK_SIZE = 524288;
const SAMPLE_BANK_COUNT = 16;
const SAMPLE_BIN_TOTAL = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT;

// Channels / voices. Physical voice & cue storage is always sized MAX_VOICES;
// 32-channel playback leaves the upper half inactive.
const NUM_VOICES = 32;
const MAX_VOICES = 64;

// Dedicated audition ("jam") voices, above every addressable song channel.
// JS-only — the Kotlin device jams on a song channel, which is exactly what
// item 140 is about: an audition on a channel is silenced by that channel's
// mute, it hijacks whatever the song is playing there, and one channel can only
// hold one note, so a held chord collapses to its last key. These slots belong
// to no channel, so the desk never mutes them and the song never writes to
// them; the row loop stops at channelCount() while the tick and mix loops walk
// the whole array, so they play but are never played TO.
const JAM_VOICES = 16;
const JAM_VOICE_BASE = MAX_VOICES;
const TOTAL_VOICES = MAX_VOICES + JAM_VOICES;
const NUM_CUES = 8192;
const CUE_BYTES = NUM_VOICES * 2;    // 64 bytes / cue (32-ch)
const CUE_BYTES_64 = MAX_VOICES * 2; // 128 bytes / cue (64-ch)

// Pattern store: 15-bit pattern numbers; 0x7FFF = "no pattern on this channel".
const NUM_PATTERNS = 0x7fff;
const PATTERN_EMPTY = 0x7fff;

// ── Cell layouts (file format version) ──
// Versions 1-2 carry an 8-byte pattern cell; version 3 — the surround format —
// carries 16, which is what buys the 8-bit volume column, the spherical panning
// column and a second effect. It is a whole-FILE property, so the engine holds
// one flag and every pattern in it is the same width.
const ROWS_PER_PATTERN = 64;
const CELL_BYTES = 8;
const CELL_BYTES_WIDE = 16;
const PATTERN_BYTES = ROWS_PER_PATTERN * CELL_BYTES;          // 512
const PATTERN_BYTES_WIDE = ROWS_PER_PATTERN * CELL_BYTES_WIDE; // 1024

/** Volume ceiling per cell format: 6-bit columns, or v3's 8-bit ones. */
const VOLUME_MAX = 0x3f;
const VOLUME_MAX_WIDE = 0xff;
/** What a 6-bit-derived delta (a nibble slide, a tremolo depth) is worth. */
const VOLUME_STEP_WIDE = 4;

// Interpolation modes (TAUD_NOTE_EFFECTS.md §1, bits 2-4 of global behaviour flags).
const INTERP_DEFAULT = 0;
const INTERP_NONE = 1;
const INTERP_A500 = 2;
const INTERP_A1200 = 3;
const INTERP_SNES = 4;
const INTERP_NES_DPCM = 5;

// Fast Sinc kernel geometry (table itself is generated in tables.js).
const SINC_WIDTH = 3;
const SINC_PRECISION_SHIFT = 10;
const SINC_PRECISION = 1 << SINC_PRECISION_SHIFT; // 1024

// Note-word sentinels (terranmon.txt:3040-3049).
const NOTE_NOP = 0x0000;
const NOTE_KEY_OFF = 0x0001;
const NOTE_CUT = 0x0002;
const NOTE_FADE = 0x0003;
const NOTE_FAST_FADE = 0x0004;
const NOTE_INT_FIRST = 0x0010; // Int0..IntF interrupt notes
const NOTE_INT_LAST = 0x001f;

// ══ src/engine/minifloat.js ══
// ThreeFiveMiniUfloat — port of tsvm_core/src/net/torvald/tsvm/ThreeFiveMinifloat.kt.
// 3.5 unsigned minifloat (3-bit exponent + 5-bit mantissa) scaled so the smallest
// non-zero step is 1/256 s ≈ 3.91 ms and the max is 15.75 s. Used for Taud
// envelope point offsets.
//
// The LUT is generated by the minifloat formula (e = i>>5, m = i&31;
// denormal e=0 → m/256, else (32+m)·2^(e−1)/256) — values are exact binary
// fractions, so this reproduces the Kotlin float LUT bit-exactly.

const MINIFLOAT_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const e = i >> 5;
  const m = i & 31;
  MINIFLOAT_LUT[i] = e === 0 ? m / 256 : ((32 + m) * 2 ** (e - 1)) / 256;
}

function minifloatToDouble(index) {
  return MINIFLOAT_LUT[index & 0xff];
}

// fromFloatToIndex (ThreeFiveMinifloat.kt:24-27): binary-search the interval,
// then "round to nearest even" — if the lower bound index is even take it,
// else take the upper bound. Ported verbatim, quirk included.
function minifloatFromDouble(fval) {
  let low = 0;
  let high = MINIFLOAT_LUT.length - 1;
  let llim, hlim;
  for (;;) {
    if (low > high) {
      llim = Math.max(high, 0);
      hlim = Math.min(low, MINIFLOAT_LUT.length - 1);
      break;
    }
    const mid = (low + high) >>> 1;
    const midVal = MINIFLOAT_LUT[mid];
    if (fval < midVal) high = mid - 1;
    else if (fval > midVal) low = mid + 1;
    else { llim = mid; hlim = mid; break; }
  }
  return llim % 2 === 0 ? llim : hlim;
}

// ══ src/engine/rng.js ══
// Randomness seams for the Taud engine. No engine file may call Math.random
// directly — everything routes through here so conformance tests can seed it.
//
// Two independent streams, mirroring AudioAdapter.kt:
//  - xorshift32: the noise-shaped dither PRNG in pcm32fToPcm8 (deterministic,
//    seeded constant per adapter instance — AudioAdapter.kt:1199-1214)
//  - random(): Math.random uses — vol/pan swing at trigger (2593-2597) and the
//    random LFO waveform 3 (1432). Musically intended nondeterminism in
//    production; injectable for tests.

function makeXorshift32(seed = 0x9e3779b9) {
  let x = seed >>> 0;
  return function xorshift32() {
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x = x >>> 0;
    return x;
  };
}

// Injectable uniform [0,1) source.
let _random = Math.random;

function random() {
  return _random();
}

/** Replace the uniform source (pass null to restore Math.random). */
function setRandomSource(fn) {
  _random = fn ?? Math.random;
}

/** Simple seedable mulberry32 for tests. */
function makeSeededRandom(seed = 1) {
  let a = seed >>> 0;
  return function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ══ src/engine/tables.js ══
// Lookup tables + pitch math — port of AudioAdapter.kt companion object tables
// (149-340), MOD_SIN_TABLE / FINETUNE_OFFSET (1406-1422), META_MIX_GAIN (1480),
// EffectOp (1438), lfoSample (1426), pitch conversions (1632-1690).



// ── Fast Sinc: 6-tap windowed sinc, 1024 sub-sample positions (251-273) ──
const SINC_TABLE = (() => {
  const n = SINC_PRECISION * SINC_WIDTH;
  const out = new Float64Array(n);
  const winFreq = Math.PI / SINC_WIDTH / SINC_PRECISION;
  out[0] = 1.0;
  for (let i = 1; i < n; i++) {
    const t = (i * Math.PI) / SINC_PRECISION;
    const win = 0.5 + 0.5 * Math.cos(winFreq * i);
    out[i] = (Math.sin(t) / t) * win;
  }
  return out;
})();

/** Windowed-sinc kernel value for fractional offset frac ∈ [0,1) and signed tap. */
function sincTap(frac, tap) {
  const x = (tap - frac) * SINC_PRECISION;
  const ax = Math.abs(x);
  const idx = Math.trunc(ax);
  if (idx >= SINC_PRECISION * SINC_WIDTH - 1) return 0.0;
  const f = ax - idx;
  return SINC_TABLE[idx] * (1.0 - f) + SINC_TABLE[idx + 1] * f;
}

// ── SNES BRR 4-tap gaussian table (512 entries; AudioAdapter.kt:283-316) ──
// The quad {gauss[i], gauss[0xff-i], gauss[0x100+i], gauss[0x1ff-i]} is meant to
// sum to 0x800 but the ROM is slightly bugged and lands on 0x7ff..0x801 (0x7ff at
// 42 phases, 0x800 at 168, 0x801 at 46). The 0x801 phases are the ones that can
// overrun int16 on rail-level input, and the DSP lets that partial sum WRAP —
// the famous "SNES gauss overflow chirp". See sampler.js INTERP_SNES.
const SNES_GAUSS = Int32Array.from([
  0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
  0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
  0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
  0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00a, 0x00a, 0x00a,
  0x00b, 0x00b, 0x00b, 0x00c, 0x00c, 0x00d, 0x00d, 0x00e, 0x00e, 0x00f, 0x00f, 0x00f, 0x010, 0x010, 0x011, 0x011,
  0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01a, 0x01b, 0x01b,
  0x01c, 0x01d, 0x01d, 0x01e, 0x01f, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
  0x029, 0x02a, 0x02b, 0x02c, 0x02d, 0x02e, 0x02f, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
  0x03a, 0x03b, 0x03c, 0x03d, 0x03e, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04a, 0x04c, 0x04d,
  0x04e, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05a, 0x05c, 0x05e, 0x05f, 0x061, 0x063, 0x064, 0x066,
  0x068, 0x06a, 0x06b, 0x06d, 0x06f, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07a, 0x07c, 0x07e, 0x080, 0x082, 0x084,
  0x086, 0x089, 0x08b, 0x08d, 0x08f, 0x091, 0x093, 0x096, 0x098, 0x09a, 0x09c, 0x09f, 0x0a1, 0x0a3, 0x0a6, 0x0a8,
  0x0ab, 0x0ad, 0x0af, 0x0b2, 0x0b4, 0x0b7, 0x0ba, 0x0bc, 0x0bf, 0x0c1, 0x0c4, 0x0c7, 0x0c9, 0x0cc, 0x0cf, 0x0d2,
  0x0d4, 0x0d7, 0x0da, 0x0dd, 0x0e0, 0x0e3, 0x0e6, 0x0e9, 0x0ec, 0x0ef, 0x0f2, 0x0f5, 0x0f8, 0x0fb, 0x0fe, 0x101,
  0x104, 0x107, 0x10b, 0x10e, 0x111, 0x114, 0x118, 0x11b, 0x11e, 0x122, 0x125, 0x129, 0x12c, 0x130, 0x133, 0x137,
  0x13a, 0x13e, 0x141, 0x145, 0x148, 0x14c, 0x150, 0x153, 0x157, 0x15b, 0x15f, 0x162, 0x166, 0x16a, 0x16e, 0x172,
  0x176, 0x17a, 0x17d, 0x181, 0x185, 0x189, 0x18d, 0x191, 0x195, 0x19a, 0x19e, 0x1a2, 0x1a6, 0x1aa, 0x1ae, 0x1b2,
  0x1b7, 0x1bb, 0x1bf, 0x1c3, 0x1c8, 0x1cc, 0x1d0, 0x1d5, 0x1d9, 0x1dd, 0x1e2, 0x1e6, 0x1eb, 0x1ef, 0x1f3, 0x1f8,
  0x1fc, 0x201, 0x205, 0x20a, 0x20f, 0x213, 0x218, 0x21c, 0x221, 0x226, 0x22a, 0x22f, 0x233, 0x238, 0x23d, 0x241,
  0x246, 0x24b, 0x250, 0x254, 0x259, 0x25e, 0x263, 0x267, 0x26c, 0x271, 0x276, 0x27b, 0x280, 0x284, 0x289, 0x28e,
  0x293, 0x298, 0x29d, 0x2a2, 0x2a6, 0x2ab, 0x2b0, 0x2b5, 0x2ba, 0x2bf, 0x2c4, 0x2c9, 0x2ce, 0x2d3, 0x2d8, 0x2dc,
  0x2e1, 0x2e6, 0x2eb, 0x2f0, 0x2f5, 0x2fa, 0x2ff, 0x304, 0x309, 0x30e, 0x313, 0x318, 0x31d, 0x322, 0x326, 0x32b,
  0x330, 0x335, 0x33a, 0x33f, 0x344, 0x349, 0x34e, 0x353, 0x357, 0x35c, 0x361, 0x366, 0x36b, 0x370, 0x374, 0x379,
  0x37e, 0x383, 0x388, 0x38c, 0x391, 0x396, 0x39b, 0x39f, 0x3a4, 0x3a9, 0x3ad, 0x3b2, 0x3b7, 0x3bb, 0x3c0, 0x3c5,
  0x3c9, 0x3ce, 0x3d2, 0x3d7, 0x3dc, 0x3e0, 0x3e5, 0x3e9, 0x3ed, 0x3f2, 0x3f6, 0x3fb, 0x3ff, 0x403, 0x408, 0x40c,
  0x410, 0x415, 0x419, 0x41d, 0x421, 0x425, 0x42a, 0x42e, 0x432, 0x436, 0x43a, 0x43e, 0x442, 0x446, 0x44a, 0x44e,
  0x452, 0x455, 0x459, 0x45d, 0x461, 0x465, 0x468, 0x46c, 0x470, 0x473, 0x477, 0x47a, 0x47e, 0x481, 0x485, 0x488,
  0x48c, 0x48f, 0x492, 0x496, 0x499, 0x49c, 0x49f, 0x4a2, 0x4a6, 0x4a9, 0x4ac, 0x4af, 0x4b2, 0x4b5, 0x4b7, 0x4ba,
  0x4bd, 0x4c0, 0x4c3, 0x4c5, 0x4c8, 0x4cb, 0x4cd, 0x4d0, 0x4d2, 0x4d5, 0x4d7, 0x4d9, 0x4dc, 0x4de, 0x4e0, 0x4e3,
  0x4e5, 0x4e7, 0x4e9, 0x4eb, 0x4ed, 0x4ef, 0x4f1, 0x4f3, 0x4f5, 0x4f6, 0x4f8, 0x4fa, 0x4fb, 0x4fd, 0x4ff, 0x500,
  0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50a, 0x50b, 0x50c, 0x50d, 0x50e, 0x50f, 0x510, 0x511, 0x511, 0x512,
  0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519,
]);

// ── Amiga filter coefficients (AudioAdapter.kt:318-339) ──
// Kotlin precomputes these at its fixed 32 kHz; the web engine's rate is
// settable (item 108), so they are recomputed whenever it moves — the cutoffs
// below are the physical RC/Sallen-Key corner frequencies of the real hardware
// and must land on the same Hz at any output rate.
const AMIGA_A500_LP_FC = 4420.971;
const AMIGA_LED_FC = 3090.533;
const AMIGA_LED_Q = 0.660225;

let AMIGA_A500_B1, AMIGA_A500_A0;
let AMIGA_LED_A1, AMIGA_LED_A2, AMIGA_LED_B1, AMIGA_LED_B2;

function rebuildAmigaCoeffs(rate) {
  AMIGA_A500_B1 = Math.exp((-2.0 * Math.PI * AMIGA_A500_LP_FC) / rate);
  AMIGA_A500_A0 = 1.0 - AMIGA_A500_B1;

  const aBase = 1.0 / Math.tan((Math.PI * AMIGA_LED_FC) / rate);
  const bBase = 1.0 / AMIGA_LED_Q;
  AMIGA_LED_A1 = 1.0 / (1.0 + bBase * aBase + aBase * aBase);
  AMIGA_LED_A2 = 2.0 * AMIGA_LED_A1;
  AMIGA_LED_B1 = 2.0 * (1.0 - aBase * aBase) * AMIGA_LED_A1;
  AMIGA_LED_B2 = (1.0 - bBase * aBase + aBase * aBase) * AMIGA_LED_A1;
}
rebuildAmigaCoeffs(SAMPLING_RATE);
onSamplingRateChange(rebuildAmigaCoeffs);

// ── 64-entry signed sine table (OpenMPT-style; 1407) ──
const MOD_SIN_TABLE = Int32Array.from([
  0x00, 0x0c, 0x19, 0x25, 0x31, 0x3c, 0x47, 0x51,
  0x5a, 0x62, 0x6a, 0x70, 0x75, 0x7a, 0x7d, 0x7e,
  0x7f, 0x7e, 0x7d, 0x7a, 0x75, 0x70, 0x6a, 0x62,
  0x5a, 0x51, 0x47, 0x3c, 0x31, 0x25, 0x19, 0x0c,
  0x00, -0x0c, -0x19, -0x25, -0x31, -0x3c, -0x47, -0x51,
  -0x5a, -0x62, -0x6a, -0x70, -0x75, -0x7a, -0x7d, -0x7e,
  -0x7f, -0x7e, -0x7d, -0x7a, -0x75, -0x70, -0x6a, -0x62,
  -0x5a, -0x51, -0x47, -0x3c, -0x31, -0x25, -0x19, -0x0c,
]);

// ── ST3-style fine-tune offsets in 4096-TET units (S $2x00; 1419) ──
const FINETUNE_OFFSET = Int32Array.from([
  -0x0154, -0x0132, -0x0111, -0x00e4, -0x00b8, -0x008b, -0x005d, -0x003b,
  0x0000, 0x0023, 0x0046, 0x0074, 0x0098, 0x00c8, 0x00f9, 0x0110,
]);

// ── The command LFOs' phase (H, U, R, Y) ────────────────────────────────
// 64 table entries × 17 steps each. The 17 is not arbitrary and the total is
// deliberately not a power of two: every 4-bit tracker field converts into
// Taud by NIBBLE-REPEAT, which multiplies by 17, so a phase whose step count
// carries that same factor makes a converted speed byte reproduce the source
// tracker's oscillator EXACTLY rather than approximately.
//
// A tracker advances an 8-bit phase by `speed × 4` and indexes `(pos >> 2) &
// 63`, giving index `x·t mod 64` at tick t. Here a converted byte `17x`
// advances by `17x` through 1088 and indexes `pos / 17`, giving
// `(17·x·t mod 1088) / 17` = `x·t mod 64` — the same index, every tick,
// forever. A power-of-two 1024 would have been 17/16 = 6.25% fast instead.
//
// Both are once per voice per TICK, never per sample, so the division and the
// modulo cost nothing worth a power-of-two compromise.
const LFO_PHASE_STEPS = 1088;
const LFO_STEPS_PER_ENTRY = 17;

/** Advance a command LFO's phase by its speed byte. */
function advanceLfoPhase(pos, speed) {
  return (pos + speed) % LFO_PHASE_STEPS;
}

/** Sample a command LFO's 1088-step phase (H, U, R, Y). */
function lfoSampleWide(pos, wave) {
  // `idx << 2` re-enters lfoSample at the position its own `>> 2` undoes, so
  // the two phase scales share one waveform switch (and one random draw).
  return lfoSample(Math.trunc(pos / LFO_STEPS_PER_ENTRY) << 2, wave);
}

/** LFO sample for auto-vibrato; pos is the 256-step phase accumulator. */

function lfoSample(pos, wave) {
  const idx = (pos >>> 2) & 0x3f;
  switch (wave & 3) {
    case 0: return MOD_SIN_TABLE[idx];                       // sine
    case 1: return 0x7f - (idx << 2);                        // ramp down
    case 2: return idx < 32 ? 0x7f : -0x7f;                  // square
    default: return (Math.trunc(random() * 256) & 0xff) - 0x80; // random
  }
}

// ── Effect opcode constants (base-36 digit values; 1438-1472) ──
const EffectOp = Object.freeze({
  OP_NONE: 0x00,
  OP_1: 0x01, OP_2: 0x02, OP_3: 0x03, OP_4: 0x04,
  OP_5: 0x05, OP_6: 0x06, OP_7: 0x07, OP_8: 0x08, OP_9: 0x09,
  OP_A: 0x0a, OP_B: 0x0b, OP_C: 0x0c, OP_D: 0x0d, OP_E: 0x0e, OP_F: 0x0f,
  OP_G: 0x10, OP_H: 0x11, OP_I: 0x12, OP_J: 0x13, OP_K: 0x14, OP_L: 0x15,
  OP_M: 0x16, OP_N: 0x17, OP_O: 0x18, OP_P: 0x19, OP_Q: 0x1a, OP_R: 0x1b,
  OP_S: 0x1c, OP_T: 0x1d, OP_U: 0x1e, OP_V: 0x1f, OP_W: 0x20, OP_X: 0x21,
  OP_Y: 0x22, OP_Z: 0x23,
});

// ── Metainstrument mix-gain: "Perceptually Significant Octet to Decibel Table"
//    as linear amplitude (1480-1513). Octet 0 = silence, 159 = unity, 255 = +24 dB.
const META_MIX_GAIN = Float64Array.from([
  0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
  0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
  0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
  0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
  0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
  0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
  0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
  0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
  0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
  0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
  0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
  0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
  0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
  0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
  0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
  0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
  0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
  0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
  0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
  0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
  1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
  1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
  1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
  1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
  1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
  1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
  2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
  2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
  3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
  4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
  6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
  10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932,
]);

/** initialAttenuation octet → linear amplitude multiplier (0 = unity sentinel). */
function attenGainOf(octet) {
  return octet <= 0 ? 1.0 : META_MIX_GAIN[octet & 0xff];
}

// ── Pitch conversions (1632-1690) ──

function noteValToAmigaPeriod(noteVal) {
  return AMIGA_BASE_PERIOD * 2 ** (-(noteVal - MIDDLE_C) / 4096.0);
}

function amigaPeriodToNoteVal(period) {
  return Math.round(MIDDLE_C + 4096.0 * Math.log2(AMIGA_BASE_PERIOD / period));
}

function noteValToFreqHz(noteVal) {
  return LINEAR_FREQ_C4_HZ * 2 ** ((noteVal - MIDDLE_C) / 4096.0);
}

function freqHzToNoteVal(freq) {
  return Math.round(MIDDLE_C + 4096.0 * Math.log2(freq / LINEAR_FREQ_C4_HZ));
}

/**
 * Song tuning pair → playback-rate multiplier (item 77).
 *
 * Step 1 of terranmon.txt §"Note Tuning" folds the declared "note `baseNote`
 * sounds at `freq` Hz" down to a C4 frequency (the spec's own worked example:
 * A4/440 → C4/261.6255653). The engine's zero point is concert C4, so the
 * multiplier is just how far the song's C4 sits from it. Every note the
 * playhead sounds is scaled by this, so the song retunes as a whole.
 *
 * Deliberately a pure ratio with NO log/exp round trip. `2 **` with a rational
 * exponent is the one transcendental the engine already trusts to agree with
 * the JVM bit-for-bit (computePlaybackRate leans on it), whereas Math.log2 has
 * no such guarantee — routing the tuning through a log would put the whole
 * bit-exact gate at the mercy of a last-ulp difference between platforms.
 *
 * A concert declaration returns EXACTLY 1.0: 440 is f32-representable and
 * `440 / 2**0.75 === TUNING_REF_C4_HZ` bit-for-bit, and `x * 1.0 === x`, so
 * A4@440 songs render without a single bit disturbed. The tracker default
 * (C9 @ 8363) returns 0.99892… — ~1.87 cents flat, which is what an Amiga
 * actually does and what the spec means by "tracker default tuning at A4 is
 * 439.548 Hz".
 */
function tuningRatioOf(baseNote, freq) {
  // Spec: either field reading zero means "assume the tracker default".
  const b = baseNote > 0 ? baseNote : TUNING_DEFAULT_BASE_NOTE;
  const f = freq > 0 ? freq : TUNING_DEFAULT_FREQ_HZ; // also catches NaN
  return (f / 2 ** ((b - MIDDLE_C) / 4096.0)) / TUNING_REF_C4_HZ;
}

/** One tick of Amiga-mode pitch slide; persists period state on the voice. */
function amigaSlideTick(voice, slideArg) {
  if (voice.amigaPeriod < 0.0) voice.amigaPeriod = noteValToAmigaPeriod(voice.noteVal);
  voice.amigaPeriod = Math.max(voice.amigaPeriod - slideArg, 1.0);
  return amigaPeriodToNoteVal(voice.amigaPeriod);
}

/** One-shot Amiga slide (fine EFx/FFx) — no persistent state mutation. */
function amigaSlideOnce(noteVal, slideArg) {
  const period = noteValToAmigaPeriod(noteVal);
  const newPeriod = Math.max(period - slideArg, 1.0);
  return amigaPeriodToNoteVal(newPeriod);
}

/** Per-tick linear-freq slide (toneMode 2, Hz/tick). */
function linearFreqSlideTick(voice, slideArg) {
  if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal);
  voice.linearFreq = Math.max(voice.linearFreq + slideArg, 1.0);
  return freqHzToNoteVal(voice.linearFreq);
}

/** One-shot linear-freq slide for fine E/F. */
function linearFreqSlideOnce(noteVal, slideArg) {
  const freq = noteValToFreqHz(noteVal);
  const newFreq = Math.max(freq + slideArg, 1.0);
  return freqHzToNoteVal(newFreq);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ══ src/engine/spatial.js ══
// Surround and ambisonics core — TODO #998.0/.1/.2.
//
// The engine's spatial model is OBJECT-based: a sounding voice is a source with
// a DIRECTION and a gain, and nothing in the mixer knows what the eventual
// output format will be. A SpatialRenderer turns those objects into the
// channels of a SpatialBus, so a file format is always a render TARGET, never
// the thing the engine holds: playback installs StereoRenderer (the device is
// stereo), and an export installs whatever the chosen format wants —
// AmbisonicRenderer today, ITU speaker layouts when #998.5 lands — then
// re-renders the song through the very same mixer.
//
// ── Units ──
// Azimuth is the 9-bit angle of the extended `S $8xxx` command (#998.1): 512
// units to a full turn, 0 = left (0°), 128 = front (90°), 256 = right (180°),
// 384 = behind (270°), increasing CLOCKWISE seen from above. Its low 8 bits are
// exactly the legacy pan byte, so pan $00 / $80 / $FF still mean left / centre
// / right and every ordinary pan write lands on the front arc.
// Elevation is effect X's signed byte: 128 units to 90°, −128 = below, +127 ≈
// above. Both are kept as doubles — a Z slide (#998.2) moves continuously.
//
// Direction vectors use the AmbiX axes: +x front, +y left, +z up.
//
// This is not a port: the Kotlin engine has no surround yet, so this file IS
// the reference implementation. Behaviour contract: TAUD_NOTE_EFFECTS.md
// ("Spatial panning effects" + S $80xx), terranmon.txt (song flag `ss`).


/** Song-immutable surround model (terranmon.txt song table, `ss` bits). */
const SURROUND_STEREO = 0;
const SURROUND_PLANAR = 1;   // 360° panning, horizontal only
const SURROUND_SPATIAL = 2;  // full sphere

/** Azimuth units in a full turn (the S $8xxx angle). */
const AZIMUTH_TURN = 512;
/** Elevation units in a quarter turn (effect X's signed byte). */
const ELEVATION_QUARTER = 128;
/** Widest multi-channel sample the placement table knows (terranmon.txt 's'). */
const MAX_SAMPLE_CHANNELS = 8;

const AZ_TO_RAD = (2 * Math.PI) / AZIMUTH_TURN;
const EL_TO_RAD = Math.PI / 2 / ELEVATION_QUARTER;
const AZ_PER_DEG = AZIMUTH_TURN / 360;
/** Taud azimuth 128 is straight ahead — the ambisonic 0° — and runs the other way. */
const AZ_FRONT = 128;

/** Fold an azimuth into [0, 512). */
function wrapAzimuth(a) {
  const r = a % AZIMUTH_TURN;
  return r < 0 ? r + AZIMUTH_TURN : r;
}

/**
 * Fold a full-circle azimuth onto the legacy pan byte (0..255) by mirroring the
 * rear arc onto the front one. Two speakers cannot render front/back, so a
 * stereo downmix keeps the left/right axis and drops the other; the mapping is
 * the identity on the front arc, which is what makes ordinary pan values behave
 * identically in every surround model.
 */
function foldAzimuthToPan(az) {
  const a = wrapAzimuth(az);
  const p = a <= 256 ? a : AZIMUTH_TURN - a;
  return p > 255 ? 255 : p;
}

/** Unit vector for (azimuth, elevation). */
function directionFromAngles(az, el, out) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cph = Math.cos(ph);
  out[0] = cph * Math.cos(th);
  out[1] = cph * Math.sin(th);
  out[2] = Math.sin(ph);
  return out;
}

/** (azimuth, elevation) of a unit vector — the inverse of directionFromAngles. */
function anglesFromDirection(x, y, z, out) {
  out[0] = wrapAzimuth(AZ_FRONT - Math.atan2(y, x) / AZ_TO_RAD);
  out[1] = Math.asin(clamp(z, -1.0, 1.0)) / EL_TO_RAD;
  return out;
}

const layoutOf = (...deg) => Float64Array.from(deg, (d) => d * AZ_PER_DEG);

/**
 * ITU-style placement of a MULTI-CHANNEL sample's channels (#998.0), as azimuth
 * offsets from the source's own direction, in WAV channel order. Stereo is the
 * ±30° "equilateral triangle" of BS.775; the surround sets are the BS.775 /
 * BS.2051 angles. Only 1 and 2 are reachable today — the sampler plays at most
 * two pool spans (terranmon.txt Ixmp note 8) — but the placement RULE is what
 * #998.0 pins down, so the whole table lives here.
 */
const SAMPLE_CHANNEL_LAYOUT = Object.freeze({
  1: layoutOf(0),
  2: layoutOf(-30, 30),                            // L R
  4: layoutOf(-30, 30, -110, 110),                 // L R Ls Rs
  6: layoutOf(-30, 30, 0, 0, -110, 110),           // L R C LFE Ls Rs
  8: layoutOf(-30, 30, 0, 0, -90, 90, -135, 135),  // L R C LFE Lss Rss Lrs Rrs
});

/**
 * World (azimuth, elevation) of a sample channel sitting `localAz` off the
 * source's own direction. The layout is a rigid body aimed at the source: it
 * yaws AND pitches with it, so a stereo pair keeps its 60° width however high
 * the source flies instead of collapsing at the poles the way a plain azimuth
 * offset would.
 */
function sampleChannelAngles(az, el, localAz, out) {
  if (localAz === 0) { out[0] = az; out[1] = el; return out; }
  if (el === 0) { out[0] = az + localAz; out[1] = 0; return out; } // exact, and the common case
  const psi = -localAz * AZ_TO_RAD; // layout offset is clockwise; ambisonic azimuth is not
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cpsi = Math.cos(psi), spsi = Math.sin(psi);
  const cph = Math.cos(ph), sph = Math.sin(ph);
  const cth = Math.cos(th), sth = Math.sin(th);
  return anglesFromDirection(
    cpsi * cph * cth - spsi * sth,
    cpsi * cph * sth + spsi * cth,
    cpsi * sph,
    out,
  );
}

/**
 * Orthogonal projection of a direction onto the listener's left–right axis:
 * −1 hard left … 0 centre … +1 hard right. It is the SHADOW the source casts
 * on that line — height and depth both collapse onto it, so a source overhead
 * or directly behind reads centre, and a hard-left source 60° up reads
 * half-left. The channel-header pan strip draws exactly this (#998.6), which
 * is why it lines up with the radar dot above it.
 *
 * Not the same thing as the audible downmix position (foldAzimuthToPan mirrors
 * the rear arc instead of foreshortening it) — this one is a POSITION display.
 */
function lateralProjection(az, el) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  return -Math.cos(el * EL_TO_RAD) * Math.sin(th);
}

/**
 * Decode an X / 4 argument (`$eeaa`) into [azimuth, elevation]. The commands
 * and any UI that writes them share this pair so the two encodings cannot
 * drift: azimuth is a byte over the full turn (half the engine's resolution),
 * elevation is signed.
 */
function anglesFromSpatialArg(arg, out) {
  const ee = (arg >>> 8) & 0xff;
  out[0] = (arg & 0xff) * 2;
  out[1] = ee >= 0x80 ? ee - 256 : ee;
  return out;
}

/** Encode (azimuth, elevation) back into an X / 4 argument. */
function spatialArgFromAngles(az, el) {
  const a = Math.round(wrapAzimuth(az) / 2) & 0xff;
  const e = clamp(Math.round(el), -128, 127) & 0xff;
  return (e << 8) | a;
}

const slerpA = new Float64Array(3);
const slerpB = new Float64Array(3);

/**
 * One tick of a Z slide (#998.2): rotate (az, el) toward (tgtAz, tgtEl) along
 * the great circle by at most `stepUnits` azimuth units, at constant angular
 * velocity — the SLERP the spec RECOMMENDS. Identical directions do nothing;
 * ANTIPODAL ones (where the great circle is undefined) take the CLOCKWISE path,
 * matching effect P's rule. Writes [azimuth, elevation] into `out`.
 */
function stepTowardTarget(az, el, tgtAz, tgtEl, stepUnits, out) {
  const a = directionFromAngles(az, el, slerpA);
  const b = directionFromAngles(tgtAz, tgtEl, slerpB);
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1.0, 1.0);
  const omega = Math.acos(dot);
  const step = stepUnits * AZ_TO_RAD;
  if (!(omega > 1e-12) || step <= 0.0) { out[0] = az; out[1] = el; return out; }
  if (step >= omega) { out[0] = wrapAzimuth(tgtAz); out[1] = tgtEl; return out; }

  let vx, vy, vz;
  if (omega > Math.PI - 1e-9) {
    // Antipodal: pick the axis whose rotation makes the azimuth INCREASE, i.e.
    // the part of −z perpendicular to the source (front → right → behind).
    let kx = a[2] * a[0];
    let ky = a[2] * a[1];
    let kz = a[2] * a[2] - 1.0;
    let len = Math.hypot(kx, ky, kz);
    if (len < 1e-9) {
      // Source is straight up or down: rotate through its own azimuth instead.
      const th = (AZ_FRONT - az) * AZ_TO_RAD;
      const hx = Math.cos(th), hy = Math.sin(th);
      kx = -a[2] * hy;
      ky = a[2] * hx;
      kz = a[0] * hy - a[1] * hx;
      len = Math.hypot(kx, ky, kz);
    }
    kx /= len; ky /= len; kz /= len;
    // Rodrigues, with k ⟂ a so the k(k·a) term vanishes.
    const c = Math.cos(step), s = Math.sin(step);
    vx = a[0] * c + (ky * a[2] - kz * a[1]) * s;
    vy = a[1] * c + (kz * a[0] - kx * a[2]) * s;
    vz = a[2] * c + (kx * a[1] - ky * a[0]) * s;
  } else {
    const sinOmega = Math.sin(omega);
    const c0 = Math.sin(omega - step) / sinOmega;
    const c1 = Math.sin(step) / sinOmega;
    vx = a[0] * c0 + b[0] * c1;
    vy = a[1] * c0 + b[1] * c1;
    vz = a[2] * c0 + b[2] * c1;
  }
  return anglesFromDirection(vx, vy, vz, out);
}

// ── Renderers ─────────────────────────────────────────────────────────────
// A renderer answers one question — "what gain does a source at (az, el) get in
// each of my channels?" — plus a monitoring stereo pair so any render target
// can be auditioned on the device. Everything format-specific stops here.

/**
 * Stereo render target: the device path, and the stereo downmix every other
 * format offers. Sources on the FRONT ARC hit exactly the legacy equal-energy
 * pan law (same expression, same order of operations), so a song that only uses
 * ordinary pan renders bit-for-bit like it does in stereo mode. Behind the
 * listener the image folds back onto the front, and elevation collapses it
 * toward the centre — at ±90° a source is dead centre, the only choice that
 * stays continuous at the poles.
 */
class StereoRenderer {
  constructor() {
    this.numChannels = 2;
    this.name = "stereo";
  }

  channelGains(az, el, out, off) {
    const p = foldAzimuthToPan(az);
    const pan = el === 0 ? p : 128 + (p - 128) * Math.cos(el * EL_TO_RAD);
    out[off] = Math.cos((Math.PI * pan) / 512.0);
    out[off + 1] = Math.sin((Math.PI * pan) / 512.0);
  }

  monitorStereo(data, frames, n, out) {
    out[0] = data[n];
    out[1] = data[frames + n];
  }
}

/** ACN indices carried by an order-N basis; planar keeps the horizontal (|m| = l) set. */
function acnChannelList(order, planar) {
  const list = [];
  for (let l = 0; l <= order; l++) {
    for (let m = -l; m <= l; m++) {
      if (!planar || Math.abs(m) === l) list.push(l * l + l + m);
    }
  }
  return Int32Array.from(list);
}

const SQRT3 = Math.sqrt(3.0);
const SQRT15 = Math.sqrt(15.0);
const SQRT5_8 = Math.sqrt(5.0 / 8.0);
const SQRT3_8 = Math.sqrt(3.0 / 8.0);

/**
 * Real spherical harmonics up to `order` (≤ 3) for one direction, SN3D
 * normalised and ACN ordered — the AmbiX convention (#998.4's export format,
 * and a perfectly good internal scene basis). Fills out[0 .. (order+1)²).
 */
function encodeSN3D(az, el, order, out) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cph = Math.cos(ph);
  const x = cph * Math.cos(th);
  const y = cph * Math.sin(th);
  const z = Math.sin(ph);

  out[0] = 1.0;
  if (order < 1) return out;
  out[1] = y;
  out[2] = z;
  out[3] = x;
  if (order < 2) return out;
  out[4] = SQRT3 * x * y;
  out[5] = SQRT3 * y * z;
  out[6] = (3.0 * z * z - 1.0) * 0.5;
  out[7] = SQRT3 * x * z;
  out[8] = SQRT3 * (x * x - y * y) * 0.5;
  if (order < 3) return out;
  out[9] = SQRT5_8 * y * (3.0 * x * x - y * y);
  out[10] = SQRT15 * x * y * z;
  out[11] = SQRT3_8 * y * (5.0 * z * z - 1.0);
  out[12] = z * (5.0 * z * z - 3.0) * 0.5;
  out[13] = SQRT3_8 * x * (5.0 * z * z - 1.0);
  out[14] = SQRT15 * z * (x * x - y * y) * 0.5;
  out[15] = SQRT5_8 * x * (x * x - 3.0 * y * y);
  return out;
}

/** Highest ambisonic order encodeSN3D implements. */
const AMBISONIC_ORDER_MAX = 3;

/**
 * Ambisonic (scene-based) render target — the export basis for #998.4, and the
 * proof that the mixer is format-agnostic: same voices, same objects, a
 * different set of channels. `planar` drops the harmonics a horizontal-only
 * song cannot excite (7 channels instead of 16 at order 3); an AmbiX writer
 * zero-fills the missing ACNs.
 */
class AmbisonicRenderer {
  constructor(order = AMBISONIC_ORDER_MAX, planar = false) {
    this.order = Math.min(order, AMBISONIC_ORDER_MAX);
    this.planar = planar;
    this.acn = acnChannelList(this.order, planar);
    this.numChannels = this.acn.length;
    this.name = `ambisonic${planar ? "2d" : "3d"}-o${this.order}`;
    this._sh = new Float64Array((this.order + 1) * (this.order + 1));
  }

  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, this.order, this._sh);
    const acn = this.acn;
    for (let c = 0; c < acn.length; c++) out[off + c] = sh[acn[c]];
  }

  /** Coincident cardioid pair at ±90° — W ± Y, the classic FOA monitor decode. */
  monitorStereo(data, frames, n, out) {
    const w = data[n];
    const yy = data[frames + n]; // ACN 1 is bus channel 1 in both bases
    out[0] = 0.5 * (w + yy);
    out[1] = 0.5 * (w - yy);
  }
}

// ── Bus ───────────────────────────────────────────────────────────────────

/**
 * The channel bus a renderer writes into: channel-major, one chunk deep, and
 * Float64 because the legacy stereo path accumulates in double locals — an
 * export tap (or #998.3's downmix) reads `data` directly.
 */
class SpatialBus {
  constructor(renderer, frames) {
    this.renderer = renderer;
    this.numChannels = renderer.numChannels;
    this.frames = frames;
    this.data = new Float64Array(this.numChannels * frames);
    this.pair = new Float64Array(2);
  }

  clear() { this.data.fill(0.0); }

  /**
   * Accumulate one positioned source sample into frame `n`. The factor order
   * matches the stereo path's `s * vol * gain * ramp` exactly — do not
   * "simplify" it, that is what keeps a planar song bit-identical to stereo.
   */
  addSource(n, value, gains, off, ramp) {
    const d = this.data;
    const nc = this.numChannels;
    const f = this.frames;
    for (let c = 0; c < nc; c++) d[c * f + n] += (value * gains[off + c]) * ramp;
  }

  /** The device's stereo pair for frame `n`, as the renderer defines it. */
  stereoAt(n) {
    this.renderer.monitorStereo(this.data, this.frames, n, this.pair);
    return this.pair;
  }
}

// ── Per-voice spatial state ───────────────────────────────────────────────
// Legacy pan writes funnel through applyPanSet / applyPanSlide so that the
// stereo model keeps its exact arithmetic (clamped 0..255 integers) while the
// surround models track the continuous azimuth that the mixer and the Z slide
// actually use. `voice.channelPan` stays the integer mirror the UI reads.

/** Channel-pan write: absolute. `pan` is the legacy byte, or a 9-bit angle. */
function applyPanSet(ts, voice, pan) {
  if (ts.surroundModel === SURROUND_STEREO) {
    voice.channelPan = pan & 0xff;
  } else {
    voice.panAzimuth = wrapAzimuth(pan);
    voice.channelPan = mirrorPanByte(voice.panAzimuth);
  }
  voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
}

/** Channel-pan write: signed delta — clamped in stereo, wrapped in surround. */
function applyPanSlide(ts, voice, delta) {
  if (ts.surroundModel === SURROUND_STEREO) {
    voice.channelPan = delta < 0
      ? Math.max(voice.channelPan + delta, 0)
      : Math.min(voice.channelPan + delta, 0xff);
  } else {
    voice.panAzimuth = wrapAzimuth(voice.panAzimuth + delta);
    voice.channelPan = mirrorPanByte(voice.panAzimuth);
  }
  voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
}

/** Elevation write (effect X / 4). Planar songs stay on the horizon. */
function applyElevation(ts, voice, el) {
  voice.panElevation = ts.surroundModel === SURROUND_SPATIAL ? el : 0.0;
}

// ── Note-pan axis ─────────────────────────────────────────────────────────
// The channel trio above places the CHANNEL; this pair offsets the note within
// it. The offset is stored signed with 0 = neutral, so the writers take the
// same 128-is-centre values every other pan command takes and subtract the
// centre themselves — an Ixmp patch pan of $80 and a column SET of centre both
// mean "no shift", whatever the channel is doing.

/** Fold a note offset into range: clamped like a stereo pan, wrapped like an angle. */
function boundNotePan(ts, off) {
  return boundNoteOffset(ts, off);
}

function boundNoteOffset(ts, off) {
  if (ts.surroundModel === SURROUND_STEREO) return clamp(off, -0xff, 0xff);
  return wrapAzimuth(off + AZIMUTH_TURN / 2) - AZIMUTH_TURN / 2;
}

/** Note-pan write: absolute. `pan` is a legacy byte or 9-bit angle, 128 = centre. */
function applyNotePanSet(ts, voice, pan) {
  voice.notePan = boundNoteOffset(ts, pan - AZ_FRONT);
}

/** Note-pan write: signed delta. */
function applyNotePanSlide(ts, voice, delta) {
  voice.notePan = boundNoteOffset(ts, voice.notePan + delta);
}

/** Note-elevation write (wide panning column). Planar songs stay on the horizon. */
function applyNoteElevation(ts, voice, el) {
  voice.noteElevation = ts.surroundModel === SURROUND_SPATIAL ? el : 0.0;
}

/** The integer pan the UI and ghost copies see: the monitoring (folded) byte. */
function mirrorPanByte(az) {
  return Math.round(foldAzimuthToPan(az));
}

/**
 * Effective azimuth of a voice: its own angle plus the note-pan offset, the pan
 * envelope's offset, the instrument's random pan swing and the panbrello LFO —
 * the surround twin of the stereo path's pan sum, wrapping where that one
 * clamps. So a Y that sweeps a stereo song across the front arc sweeps a
 * surround song along the same arc, and keeps turning past its ends.
 */
function voiceAzimuth(voice) {
  if (voice.hasPanEnv && voice.panEnvOn) {
    let envPanRaw = Math.round(voice.envPan * 255.0);
    envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
    return wrapAzimuth(voice.panAzimuth + voice.notePan + envPanRaw - 128 + voice.randomPanBias +
      voice.panbrelloOffset);
  }
  return wrapAzimuth(voice.panAzimuth + voice.notePan + voice.randomPanBias + voice.panbrelloOffset);
}

/** Effective elevation: the channel's height plus the note's own offset. */
function voiceElevation(voice) {
  return voice.panElevation + voice.noteElevation;
}

const angleScratch = new Float64Array(2);

/**
 * Renderer gains for every channel of `voice`, cached in `sc` and recomputed
 * only when the source actually moves (a direction changes at most once per
 * tick, the mixer asks once per sample). Returns the cache entry, which the
 * caller stores back — each BUS needs its own, or two buses alternating on the
 * same voice would invalidate each other's on every single sample.
 */
function voiceGainsCache(bus, voice, sc) {
  const nc = bus.numChannels;
  const layout = SAMPLE_CHANNEL_LAYOUT[voice.activeChanCount] ?? SAMPLE_CHANNEL_LAYOUT[1];
  const chans = layout.length;
  // The RAMPED azimuth (item 141) — the mixer advanced it once for this sample,
  // and the stereo path is smoothing the very same number, which is what keeps a
  // planar song rendering identically to its stereo twin.
  const az = voice.currentPan;
  const el = voiceElevation(voice);
  if (sc === null || sc.gains.length < nc * MAX_SAMPLE_CHANNELS) {
    sc = {
      az: NaN, el: NaN, chans: 0, renderer: null,
      gains: new Float64Array(nc * MAX_SAMPLE_CHANNELS),
    };
  }
  if (sc.az !== az || sc.el !== el || sc.chans !== chans || sc.renderer !== bus.renderer) {
    for (let k = 0; k < chans; k++) {
      sampleChannelAngles(az, el, layout[k], angleScratch);
      bus.renderer.channelGains(angleScratch[0], angleScratch[1], sc.gains, k * nc);
    }
    sc.az = az; sc.el = el; sc.chans = chans; sc.renderer = bus.renderer;
  }
  return sc;
}

/** Gains for the MONITOR / export bus (voice.spatial). */
function spatialVoiceGains(bus, voice) {
  return (voice.spatial = voiceGainsCache(bus, voice, voice.spatial)).gains;
}

/** Gains for the master-strip analysis bus (item 98) — its own cache slot. */
function analysisVoiceGains(bus, voice) {
  return (voice.analysisSpatial = voiceGainsCache(bus, voice, voice.analysisSpatial)).gains;
}

// ══ src/engine/hrir-sadie.js ══
// GENERATED FILE — do not edit. Rebuild with: node tools/make-hrir-table.js
//
// GoogleVR / SADIE spherical-harmonic HRIR set, order 3 (16 ambisonic
// channels), 256 taps at 48000 Hz, as taken from Google Omnitone
// (src/resources/sh_hrir_order_3.wav, md5 310d2836b94909a9b49a84c2ebbf3552).
//
// Copyright (c) 2017 Google Inc. and (c) 2017 University of York, licensed
// under the Apache License 2.0 — see vendor/VENDOR-VERSIONS.md. The
// measurements are the SADIE project's Google/VR binaural filter set:
// https://www.york.ac.uk/sadie-project/GoogleVRSADIE.html
//
// ── What these numbers ARE ──
// Channel k is the LEFT ear's impulse response for ambisonic channel k in ACN
// order, SN3D normalised. Decoding an ambisonic scene to headphones is then one
// convolution per channel and a sum — no per-source filtering, no head model to
// tune — and the right ear comes free: mirroring a listener left↔right flips the
// sign of every harmonic with m < 0 and leaves the rest alone, so
// L = Σ_{m≥0} + Σ_{m<0} and R = Σ_{m≥0} − Σ_{m<0}. The set already carries the
// max-rE weighting Google baked in, which is why the decoder applies no shelf,
// no near-field compensation and no gain of its own beyond one calibration
// scalar (see binaural.js).
//
// Stored channel-major as int16 little-endian, base64'd: the layout the
// convolver reads, so decodeShHrir() is a scale and a copy.

/** Ambisonic order the set decodes, and the channel count that implies. */
const HRIR_ORDER = 3;
const HRIR_CHANNELS = 16;
/** Taps per channel, and the rate they were measured at. */
const HRIR_LENGTH = 256;
const HRIR_RATE = 48000;

const HRIR_BASE64 = [
  "/v/z//3/AgD//wYAAAAKAN7/sv9RAHUBe/4//LsDzQQV/736/PfwAXT/MvkAAnADoAfjDQcNWAHw/UECSv7RA4UECAoGCPf8",
  "d//p+Rz8L/4x/1cBx//6AHf8ggHhAEQAMwFM/SD/9/sq/xv++/3f/z/9kf+N/f3+uv6c/vv+Vf6C/3P9yf4Y/sb+L/92/pr+",
  "rv2y/ur9N//M/p7+5P7+/fL+gf4V/5T+6f6b/lT+/v5b/iH/wP70/r3+tP7P/rD+Lf+F/g//vv7P/gv/2P4h//P+HP/L/h7/",
  "7P4M/0L/6P5R/y3/Rf9E/1P/N/9M/23/Lv9o/yb/Qf9Q/0D/Vf9b/2H/Sv9+/1n/d/99/2j/hP9v/3n/c/+K/3n/if+D/3j/",
  "mv99/47/iP+K/43/jP+Q/5b/o/+g/8L/qP+2/8b/q//A/8P/xf/R/9L/v//R/8b/vP/d/8H/0P/b/8T/1//e/83/3P/h/8j/",
  "4f/Y/8n/4//S/9H/4v/S/9L/4//R/9f/5P/P/9z/4P/Q/9//3//S/+D/3P/S/+L/2v/W/+T/2P/Z/+T/2P/c/+T/2P/g/+P/",
  "2f/i/+L/2v/l/+H/3P/m/+D/3//m/+D/4f/n/+D/4//n/+D/5f/m/+D/5v/l/+L/5//k/+H/5f/h/+H/5P/h/+T/5v/n/+r/",
  "7f/v//P/9f8EABgACgAAAAIA8//x/+//e//T/vAAEwWT/LT1wAdmCNj7+fNB75wLvwYu9AID4AYNEdkQ8RVfELP6HwcyBkoB",
  "lf9Y+9f7j/mX/wr7FP14/+f8PftR90/8cfgf+WH5cvli/Hf6V/4L/Zj+xPxC/Nr/AP6S/rr8rP3Q/MH8WP3D/XX/xP17/1L+",
  "IP/Y/9T+6v+d/1wAQ//p/3H/2/98ADX/SADA/zUATgCHAF0AMgCTAOj/xQBJAIsApAAkAFQAUwB1ABQApwA6AFoAfwAjAK4A",
  "ZABEADEATgAKADAANwDm/0EA+v8uAEcAEQATADUAHQAIAEUA9f8tACsACwA+ABMABQAbAB4AAgA8ABEA/v8gAPT/FwAXAA8A",
  "FQAYAPH/EQAnAPD/HwD1//v/JQDp/wAAJAD+/xkASwAOAC0APAAXAEcAOAAuAEgANwAxAEsAMAAuAEYAFQAmACwAAwAZABIA",
  "9v8PAAsA8f8UAAIA8/8UAPv//P8RAPX//f8NAPH//v8IAO7/AwADAO//BQD///L/CAD9//b/CgD6//n/CgD4//3/CAD3/wAA",
  "BwD3/wQABAD4/wYAAwD6/wgAAQD9/wkA/v///wgA/v8CAAcA/f8DAAYA/f8GAAQA/v8GAAIA//8GAAEAAAAFAP//AQADAP//",
  "AQABAP//AAAAAP//AAD//////v8AAAAAAQAAAP3/BAD5/wkA+v/3/x0A+v/C/vj+dwUAAmj5Ev7d/5sDxf8p/YcJmgDt9GH8",
  "9ggZAKLzkwGGCacGJAS6Be/67PEdAeoCWAT+Bkb8wvrL/Nz/8AEfA4ICAf3d/Mr9QwD2Aq8BpQAg/pH81f5xAXoB1QDP/zv+",
  "Z/5y/z4AtwBuAFr/7v42/6P/kgDVACUAxP+u/4//7/9MAEMA3/97/6r/7P/v/+D/EgABAMz/+//g/+L/IgAaAPr/5//Q/+r/",
  "OQA1AD8APgDw/wYADAD2/zcARgAPAAIAGQAhAD4AJQD8/xgADgAWABwA7f/i//b/9P/0//z/6v/8/xQA/P8DAAgA+P8KAA0A",
  "9v8BAP3/9/8GAPr/+f8BAPv/CAAPAPf/+f8CAPn////6//7/CQDx//P/DgDz/+f/AQD3//v/BwABAPz/8f/1//7/+v8EAAIA",
  "7/8BAAMA9f8MAAMA+f8KAPv/+v8IAPr/+/8JAPf/+/8HAPX/AwAHAPf/AwABAPb/BgABAPf/BQD7//f/BQD6//v/BQD5//3/",
  "BAD4/wAAAwD4/wEAAQD5/wIA///6/wMA/v/7/wMA/P/9/wMA+//+/wIA+////wEA+/8BAAAA+/8CAP///f8CAP7//f8CAP3/",
  "//8BAP7///8AAP7/AAD//////////////////wAAAAAAAP//AAD+/wIAAAD+/wwA+/+l/43/+ABPAS0ACP/o/FYATwGL+yf9",
  "TwVvDUb+tPS5C+YD/fQM+zH9aQkQBLb7bgB6/Yn95/xAAcgAEgD4AVP/IgIn/Gn9AwHMAL4CRP+yAJT8b/4oAcz/hgLC/kD/",
  "lv4IAMkB2QDTAcP/iwB7/+L/PgAiAHcAbf9OACL/oQBgAAcAmQBv/87/ZP9vAOj/FQAXALr/ZQCV/0wA7v/j//b/+P/+/8X/",
  "PgC8/0MA7f/T/yIA8/8jAAcAIAC3/xwA3//N/yAA3/9DACMAKgAeACoA+v8EACIAxP8OAOT/8v8GAO7/7v/t/wIA4v8VAOP/",
  "9v8MAOb/CwD//wAA+f8JAO7/AwAGAO3/GAD4////DQABAPz/EgD9/+7/FgD//wsAAQAHABQA7f/5/wIAAQAMAA0A+f8OAAQA",
  "9f8WAPn/AQAQAPz/BQAKAPb/BQAOAPX/DQAEAPD/CgD8//j/CgD8//f/CgD5//z/DQD3/wQACQD3/wUABQD3/wcAAwD3/wkA",
  "///6/wkA/f/9/wcA+////wcA+f8BAAUA+f8DAAMA+v8EAAEA+/8FAP///P8FAP3//v8EAPz///8DAPv/AQACAPv/AgAAAPz/",
  "AgAAAP3/AwD/////AgD//wAAAAD//wAAAAAAAAAAAAD///////8AAP////8AAP3/AwD//wEADAD+/37/Yf9gAdkBZwAh/hT8",
  "cALV/6P0DAILD/ECTP6KCPsFwvlQ9zj4+fl8AJEDDwFIAR0BHP04/+IA6f7YASYCt/5z/IL+wQEQAFIBxAG3/r3+FP9CAJ0B",
  "0QHhALz/cf8N/6X//f8qANX/nf8GAJ7//P9wAI4AjACTAA0Auf+SAAMA3/9aAP7/HQA8AAoA+v8RAOb/IAAHALf/LgAjAPr/",
  "FgD1/+z/LQARAPf/LwDy/xMANADp/wIAEgDe//j/DgDA/+P/9P/R/xMADgABADQAEQD0/xwA+P/1/xgA6/8AABIA6v8MABgA",
  "7P8QABkA/P8fAAIA8f8TAPr/AgAdAAUABwATAPP/CQAVAPn/FQAOAPj/FQAFAOf/DQAXAAEAFgAWAAoAEQAEAAAAAwD7/wEA",
  "BAD7/wYAAAD3/wkA/f/9/w4A+v/6/wgA+P///wcA+P8CAAQA+f8GAAQA/f8JAAMA/f8IAP3//P8GAPv//v8FAPn/AAAEAPr/",
  "AwAEAPv/BAACAPz/BQAAAP3/BQD///7/BQD+/wAABQD9/wEABAD9/wIAAwD9/wMAAQD+/wMAAQD+/wQAAAD//wMA//8AAAMA",
  "/v8BAAIA/v8BAAEA/v8CAAAA//8BAAAAAAABAAAAAAAAAAAAAAAAAP///v//////AAAAAPz/CAD3/w4A+v/z/y8A9P9Q/rH+",
  "tQdUAl32jP49AOUEOgG7+tkFQP1Z/ecCCgZpALrwjwIICXED3ACf+dz7dftwA94EygJyA4r9a/2K/MoBVANKAJ7/JP3t/sD/",
  "FwIFATYAiP+2/bD/nP9OAlsBMgDh/xr+DgB3ADEBSQAhAIH/Ev+wAOn/wgBlAAIA9f+O/zQARAB+AAQAfQAgAPT/cQAEAGUA",
  "PQAKAMP//f/t/+D/OwC6/wcABQDb/xIAGgAkADoAHwDZ/zUA+v/3/zcAz//l////2//z/xkA4f/5/wIA3P8bAPf/7P8QAPz/",
  "9/8WAAkA/f8hAPH/9/8KAOX//P8EAOv///8EAOj/DwABAOz/CQDp/+v/EAD+/+3/CgD1//v/EwDt/wkACQDj/wcADQDu//7/",
  "/v/3/xAA/P/5/wMA6v/6/wYA9f8EAAgA8P8CAAEA7/8FAPX/7v8CAPP/9v8EAPb//P8FAPL//v8EAPP/AwAAAPP/AgD9//X/",
  "AwD8//f/BgD7//v/BgD6////BAD5////AgD4/wEAAQD5/wIA///6/wMA/f/7/wMA/P/8/wMA+//+/wIA+v///wAA+v8BAAAA",
  "+/8BAP///P8CAP3//f8BAP3//v8AAPz//v////3///////7////+//7////////////8//3///8AAAIAAgAIAEEAnABv/wH9",
  "XgGiBJn8nf75BKoCXQJv+936+gKd+un1HQOxApv29vmQ/8X+tgBs/xX+vwUhC04Eg/+fAh0BjQKxBr8CpAJH/477///m/5cC",
  "rQIFANAA3/+GAEUALQFOAAoAyv8m/fL+XP9TAE8AOf9a/+f+z//j/6YAw//m/zYAKf9ZAB0ANAAgAAEA7v/m/zwA0P9IANb/",
  "GwAxALL/EwACAAsAGQBWANv/8f8DAMv/NgD4//j/4v/S/9j/HAAMANj/DACY/9//FADv/wIA1P/K/97/9v/G/+3/5//r/y4A",
  "+f8HABIABgAlADIABQAWADAACAAsABcAAAAYAAkABQAVAAIA9f8RAO3//f8cAPT/EAAfAPr/DwARAOn/FwAEANH/DAD1/9T/",
  "BADp/9b/CgDm/+D/FADv//7/GAD1/wsAEgD6/xYAEgD3/xEAAgD3/xQA///+/xIA/f8AABEA+f8DAA8A9/8EAAUA9P8GAAMA",
  "9v8HAP7/9v8IAPv/+f8HAPn/+/8FAPf//v8EAPf/AQACAPj/AgAAAPn/BAD+//r/BAD8//z/BAD8//7/AwD7////AgD7/wEA",
  "AQD7/wIA///8/wMA///9/wIA/f/+/wMA/f8AAAEA/f8AAAAA/f8AAAAA//8AAAAA//8AAAAAAAD///3///8AAAAAAgD//wQA",
  "//8FAAcA+P8ZABQABwAF/w0A9gHW/93/TP/A/6f+W/3CBO8AbP5jAB0BnQOK+sQANgLY9vYAUAgUACb8/wGB+4/9iQag/nED",
  "KQKq+87+gQAjAiQARwH9/WX+JgFBAD8CSAA1AL3+l/9HAEEA6QHO/00A5v6T/0EAQwA2Aav/TwBb/wQAhwANADcAzv/v/2b/",
  "IADE/2IASwBX/9f/hP/6/wwAHwCN/8L/5/+j/2UAyf8eAFYANwBRAEkAJwABAFgA4f9MADYA3P82APr/CAAoADYA9v8oAP3/",
  "5/81AOD/DgALAO//DwAqAPf/+/8bAM7/HAAUAOn/CADx/+z/CQAIAOn/HADz//D/GADn//z/DADx//j/DwDo/wIADADl/w4A",
  "9//v/wsA9f/v/w0A+P/s/wwA7f/v//7/9v/4//P/+v/w//H/+f/2//f/BQD5//L/CQD2//v/CQDx//v/AgDz//3/AgDw////",
  "/v/w/wMA/P/3/wYA+//4/wUA+f/7/wcA9//+/wUA9/8BAAIA+P8CAAAA9/8DAP7/+f8EAPz/+/8DAPv//P8CAPn//v8BAPn/",
  "//8AAPn/AAD///r/AQD9//v/AQD9//3/AQD9//3/AQD8////AAD8/wAA///9/////v/+//////////////////7/+f/7////",
  "//8FAAgABwB5AA4BAf/V+iECtght+/L7WQNPCY4LJe8v85oELQBC/grwb/8e/ELraQUp+c3xGQieDBsYoRT3BxEDZwE+AxkC",
  "6gYuBsUBE/09+2n9Uv3rA9YBbv7+/Zf8FwBZ/lwBHQFE/hj+ovp4/Zb+l/6Y/uT9lv5v/uL/GwBCALL/8v+0/z//mgBbAJwA",
  "/P8jADkAKgDTAJAA4QAsAF0ATQAtAJIAZwCMAD8AgQANABAANgAOAEgA4v/n/9z/EAAIACoAIwDf/xcA2v8NAAEA9P8AABkA",
  "RwBLAH8ANABIADcAKgBbACUAFgAQACQAAwARAA0A+v8fAA8AIwAgABkAGgAaAAcACAAYAAAAIQAOAAcAIgAGAAYAGgAKABIA",
  "GQDr/xsAHADn/wsA/v/0//b/6P/j/9j/5v8EAAsAGgAjABAALAAkABcAMQAhABwAIgATAA4AFQAKAA8AFQAEAA8ACAABAA0A",
  "CAAFAAkAAAD8/wcA/f/9/wUA+P/+/wAA9///////9/8AAPz/9/8CAPv/+v8CAPr//P8BAPr//v8CAPr/AAABAPv/AQAAAPz/",
  "AwAAAP3/AwD///7/AwD+////AgD9/wAAAgD8/wEAAQD9/wEAAAD9/wIA///+/wIA//8AAAIAAAAAAAEAAAAAAAAAAAAAAAAA",
  "//////7/AAD//wEAAgACAEwAowBC/0L8sABABZ7/TABcAEcEoAQP8az1j/4/+z/+CAAuCgULXgafAlH8N/6zAQkDngG7AskA",
  "qf3Z/78AUAHNARQAMvuK+gv8IP0VALP/3f7F/Zj9of60/1YBMAGaAJ3/GgBqAQkCWwIRAmwBFwABAA4A/f8OAKv/fP8+/07/",
  "bv/Z//j/AADi/4v/w//M//T/GgAiAAsA/v/b/8n/DQDg//v/AwDp/wwACgAgACgAHgD3//r/6f/n/xQA7P/c/93/0P/a/+b/",
  "1v/m//D/3f8GAAYA/v8SAAQA/f/9//D/6v/1/+P/6//4/+X/9P/3/+3/+P/5//f/AQD4//X/AwD0//j/+v/p//L/9f/1//j/",
  "9f/3/wUABwDw//T//f/s/+//+v/0/wIACwD//wgA/v/3//7/8P/1//z/6//w//j/7v/9/wEA8P/9//v/7/8BAPv/8/8BAPf/",
  "9f8DAPj/+/8GAPf///8FAPn/BAAFAPz/BgADAPv/BwABAP3/CAD+//7/BQD8////BQD7/wAAAwD6/wEAAQD7/wIA///7/wIA",
  "/v/8/wMA/f/9/wIA/P///wIA/P8AAAEA/f8BAAAA/f8CAP///f8CAP7//v8BAP7//v8BAP3///8AAP7/AAAAAP7/AAD/////",
  "//////////8AAAAAAAAAAP//AAD+/wAA/f8BAAMA9/8QAA0A/v8u/w0AoAHg/8//Wf/L/xH/Ov1gA2cCWP72/ioCHQOb/LD+",
  "iP0T/rQD/wCzAncA/f22/tr/ZgIUAWYBkf70/vn/e//CAUwATACx/qD+gv8nAGcBCAC/AGj/Yf/F/63/qQD9/0EAVv8p/0f/",
  "8P8/AN7/NABp/wsA/f8OAFsAGgADAM7/PwDJ/yAA+P/c/0QA8P8pABUALwAbADsA7f/e/yAAwf8xABAA7f8DAPD/4v/3/wkA",
  "z/8XAM//0P/9/8n/+////+v/8f8hAPf/DQAQANr/GwABAPT/BADy/+b/CQAAAO//GADs/wcAGwD1/wQAAADs//7/CQDp/wsA",
  "/v/p/w0A9v/4/wgA9v/1/wsA9P/8/wkA5/8GAAUA8P8FAAMA9P8CAP7/8P8FAPX/9/8GAPb//P8AAPr/AQAHAPz/BAADAPj/",
  "BgD+//v/BAD7//v/AwD8//7/BgD8/wIABQD6/wMAAgD7/wMAAAD6/wIA/v/7/wMA/P/8/wIA+//+/wIA+////wEA+/8AAAAA",
  "+/8BAP///P8CAP7//f8CAP7//v8CAP7///8BAP3/AAABAP3/AQAAAP7/AQD///7/AQD///7/AQD+////AAD+////AAD+////",
  "AAD//wAA/////////////////////wAA//8BAP//BgA4AIIAb/8T/a0AswPw/kcBiQNtAA7/aPlI+V//tvpF9pQFCww8BnEF",
  "pP2W/lUDmAJKACL/8ALQ/r7/JwG4/ckA//+g/ksAdgDg/rz9lP3y/sb+kv6//9X99f7V/0UArQAiAD4BBgB1AK4AJwGEAekA",
  "9wCr/yIABQBkAIYALQANAHf/AQBZ/9j/x/97/6z/ev/d/5X/+f+r/+//6v++/zUAyP8IANb/9//1/wcAHgDz/y0A1v8cAPv/",
  "AwA7ABcABwDl/wcA0/8eAP//3v8CANH////7/wIA+/8WAPL//P8ZANz/GAD+/wMAGAAAAAMACgAPAPj/EwDw//z/DAD0/xAA",
  "BgD+/wMACwD0/wcABQDv/w0A/P/+/wMA9f/w/wAA8//k/wkA+f/6/w0A//8CABAAAgD7/woA9//+//7/7f/5//j/9//6//r/",
  "+f////r/9/////X/+f/9//X/+P/9//j//f////f/AAD9//n/AgD9//z/AgD9//3/AwD9/wAABQD//wMABAD+/wMAAwD+/wMA",
  "AQD9/wIA///9/wIA/v/+/wIA/f///wEA/f8AAAAA/f8AAAAA/f8BAP///v8BAP///v8BAP7///8BAP7///8AAP7/AAAAAP7/",
  "AAD///7/AAD/////AAD/////AAD/////AAAAAAAA/////////////////P8BAPz/AQD5/ygAcQCq/+z9ZP9RBCQAIvzSAsD/",
  "af4JBI/+zvrR/PABXgW//+H9YANrA2UBXwN+AG/+mgBK/2j/4QBZ/rL8xP1P/sv/hQDW/wv/hP74/nz/VwC0/4r/3v8y/5T/",
  "q/8TAPH/xf8QAK3/nv+H/7r/wv/g/6//sv/v/7T/NAD2/9//OQAtADIAHwA2ACMAQQAYAC4AVAAAACEAHAAIACQAPQAXABYA",
  "GgAAADQAFAAFACUAFwAcAEAAJwAJACcABwAhABsA5/8OAA4A//8aACMAEAAzAC0ADgAmAAUAAAAiAAkAAgAdAAUAAgALAO//",
  "AAAFAPL/BgAGAPD/BgAIAPH/DwAGAP3/GgAHAP7/EAAIAAUAEAAEAAgACQADAA0A///+/woABQAEAAYABwAKAAwADAAQAAgA",
  "DAAOAAUADwALAAEACAAEAP//CQACAP7/CAD//wEACQD+/wMACQD+/wMABwD9/wUABQD+/wcAAwD+/wYAAgD//wcAAAAAAAYA",
  "/v8BAAUA/v8CAAQA/v8DAAMA/v8DAAIA//8EAAEA//8EAAAAAAAEAP//AQADAP//AgADAP//AgACAAAAAwABAAAAAwABAAAA",
  "AgAAAAEAAgAAAAEAAQAAAAEAAQAAAAEAAQAAAAAAAAAAAAEAAAD//////v/9////+/////3/9f8CAB0AWQCV/5j+aP+1AwEC",
  "4PgJAZoG+fz8/an8ywDzA8r8cgD6Aa4CSf4t/SYFuP/f/eP/EAAnAln/rv4NAHn/4P4iALsAtf8O/7v+IP/EAFoBtP9V/yj/",
  "j/8kAGYArgDV/5v/9f6g/ygA/v87AIH/if9q//P/HwBCAFkAy/8oAMn/DgA1ABEACwDn/ysACQBHACMAWQB3AB8AIAD4/+T/",
  "7v9BAPn/6f/l/8X/DwDk/+v/6P/n/9H/8P8IAO3/KADx//P/CAD5/wMA8P/M/83//f/Y/wIACwDt/xkACgAOABoADwAAABMA",
  "BQAIACMA//8PAA8A/f8LAAYA8v/8//r/6v8IAPj/9v8IAPX//v8KAP//9v8KAAUAAgAKAP//AgAHAAMABQAVAAoABwAPAAYA",
  "DwAJAAkADwAIAAkACQAFAAcABgABAAYAAgAAAAQA//8CAAYAAQACAAQA//8BAAMA/v8DAAEA/v8DAAEA//8DAAEA//8DAP//",
  "AAADAP//AQADAP//AQACAP//AgABAP//AwABAP//AwABAAAABAAAAAEAAwAAAAEAAwAAAAIAAgAAAAIAAgAAAAIAAQAAAAIA",
  "AQAAAAIAAAABAAIAAAABAAEAAAABAAEAAAABAAEAAAABAAAAAAAAAAAAAAAAAAAA/////wIA+f8GAPj///8PANX/EwABATYA",
  "kfp4AX0IU/pF/84BX/p/BRoC4/4K/Aj+IQRz/lQEof7E/KL/WwAACkT/8voj/nj+MQMoApcAkP5U/0j+4P89AZr/DgDj/Wb+",
  "Vv5vAGAAqv/6ALb+HgCg/wYAlAAAALwAkP9HAAEARAA1AO3/JQDE/z8Axv9rAFMALAAiALL/DAAXAG8A7f/2/+3/4f/z/6H/",
  "CQD6/xAA8//l/9L/3P8WAOz/FgDt//D/5//n//b//v8TAOb/DADq/woAKwALABUADgAdAAwAGgDy//P/BAD1/xsA9v/t/wIA",
  "AAD5/wsAAQD5/xUA9v8CAAEA8P8AAPr/7//4//z/8P8JAPj/8P8KAPj/+f8HAAUA9v8JAAQA9/8NAAIA+f8EAAIA+v8IAP//",
  "/P8FAPT/AQAIAPv/+/////7/AgALAP7/BQAIAPv/BAAAAPf/AQD+//X////6//f/AwD6//r/AgD5//z/AgD5//7/AQD5////",
  "AAD4/wEAAAD7/wMA/v/8/wQA/v/+/wMA/f///wQA/P8AAAIA/P8BAAEA/f8CAAAA/f8CAP///f8CAP7///8BAP7///8BAP7/",
  "//8AAP3/AAAAAP7/AQD///7/AQD/////AQD/////AAD//wAAAAD//wAAAAAAAAAA////////AAAAAAAAAAABAP//AgAAAP7/",
  "AQA9AEcAXv8g/8L/NgGtAQD++QA9B0n85PW0BAkA1/LzAXoHHAHTBGwFkQRRAMn8xvx6ADwBoPxM/yf98P1gAYj/UQEqABQB",
  "7v92APIB7/5/AEj/z/9w/3L/MgE7/6AAof/T/4IABgByAJH/4P8r/zcAFAAkAM8A4f9zADUAhwAvAEwAEwDg/1gAkv9VABIA",
  "BwAkAOT/CADy/y4Ayf9CAOb/3/8pALj/DwDt/+7/2P8GANj/8/8kALn/GgDZ/9z/BQDe/9z/AAAfAAgAXgAhADMASQAKAC8A",
  "CQDs//P/EADm/wUABQDj/yUA9f/+/xEA8//1/wYA7f/o/wwA5v8IAAYA8P8UAAMAAAAOAAAA9f8TAPL/9v8dAO//+f8SAPP/",
  "5/8DAPT/8f8IAPP/AgAGAPf/AAAEAPj///8CAPL/AgD7//b/AwD5//z/AQD7//z/BAD3////AwD1/wMA///4/wMA/v/4/wMA",
  "/f/4/wUA+f/6/wQA+P/9/wMA+P/+/wMA+P8BAAEA+P8CAP//+v8DAP7/+/8DAP3//f8DAPz//v8DAPz/AAABAPv/AQAAAPv/",
  "AQD///z/AQD+//3/AQD9//3/AQD8//7/AAD8///////9/wAA///+/wAA//////////////////8=",
].join("");

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 → bytes. Hand-rolled because `atob` is a window/worker global that
 * AudioWorkletGlobalScope does not carry, and this module runs there.
 */
function b64Bytes(s) {
  const lut = new Int32Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) lut[B64_ALPHABET.charCodeAt(i)] = i;
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // '='
  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | lut[s.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * The set as one channel-major Float64Array of HRIR_CHANNELS × HRIR_LENGTH,
 * scaled to ±1. Built once per call — binaural.js caches the rate-converted
 * table it derives from this.
 */
function decodeShHrir() {
  const bytes = b64Bytes(HRIR_BASE64);
  const out = new Float64Array(HRIR_CHANNELS * HRIR_LENGTH);
  for (let i = 0; i < out.length; i++) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768.0;
  }
  return out;
}

// ══ src/engine/binaural.js ══
// Binaural monitoring (#998.3, rebuilt for item 128) — the render target that
// makes a surround song AUDIBLE on headphones while you compose it.
//
// Why this exists: playback normally installs StereoRenderer, which folds the
// rear semicircle onto the front and collapses elevation toward the centre. It
// is the right stereo DOWNMIX, but it is a projection: behind sounds exactly
// like in front, and height is inaudible. Authoring a position you cannot hear
// is a non-starter, so this file adds a second monitor path.
//
// ── How it works ──
// The bus channels ARE an ambisonic scene: `channelGains` is the SN3D/ACN
// encode (the same basis as the AmbiX export, spatial.js `encodeSN3D`), so a
// voice is amplitude-encoded into spherical harmonics exactly as it is for a
// B-format render. `monitorStereo` then decodes that scene to two ears with the
// GoogleVR/SADIE spherical-harmonic HRIR set — one 256-tap convolution per
// ambisonic channel, summed. Because the set is measured, the interaural delay,
// the head shadow and the pinna's spectral cues arrive with it; there is no
// head model here to tune, and no per-source filtering at all. The mixer calls
// `monitorStereo` once per frame IN ORDER, which is what lets this renderer be
// stateful (the convolution history) while every other renderer stays a pure
// function.
//
// The right ear costs nothing extra: a listener mirrored left↔right is the same
// listener, and mirroring flips the sign of every harmonic with m < 0 and
// leaves the rest alone. So one convolution per channel serves both ears —
// L = Σ_{m≥0} + Σ_{m<0}, R = Σ_{m≥0} − Σ_{m<0}. This is the trick Omnitone's
// HOAConvolver builds out of Web Audio nodes; here it is the two accumulators
// in the frame loop.
//
// See hrir-sadie.js for the data, its provenance and its licence. What replaced
// what: this used to be a parametric head (Woodworth ITD, Brown & Duda shadow,
// a tuned pinna notch) driven from a ring of virtual speakers. Measured beats
// parametric — front/back and height are now cues a real head measured rather
// than curves fitted by ear — and the ambisonic basis is both cheaper per
// source (no per-speaker filter bank) and honest about what the bus carries.
//
// Not a port: the Kotlin engine has no surround at all, so this file — like
// spatial.js — IS the reference implementation.




/** Monitor modes (playhead state). Fold = StereoRenderer, the default. */
const MONITOR_FOLD = 0;
const MONITOR_BINAURAL = 1;

/** The order the HRIR set decodes, capped by the basis spatial.js implements. */
const BIN_ORDER = Math.min(HRIR_ORDER, AMBISONIC_ORDER_MAX);
const BIN_SH_COUNT = (BIN_ORDER + 1) * (BIN_ORDER + 1);

/** Azimuth of the front axis — the direction the level contract is fixed at. */
const BIN_FRONT_AZIMUTH = 128;

/** Rate conversion of the HRIR set: Kaiser-windowed sinc, resampler.js's β. */
const BIN_RESAMP_HALF = 24;
const BIN_RESAMP_BETA = 8.0;

/**
 * ACN channels a source ON THE HORIZON can excite. Y_lm vanishes on the horizon
 * whenever l − |m| is odd, so for a planar song — where nothing ever leaves the
 * horizon — dropping those is EXACT, not an approximation, and it buys back six
 * of the sixteen convolutions. A spatial song keeps the whole set.
 */
function binauralChannelList(sphere) {
  const list = [];
  for (let l = 0; l <= BIN_ORDER; l++) {
    for (let m = -l; m <= l; m++) {
      if (sphere || (l - Math.abs(m)) % 2 === 0) list.push(l * l + l + m);
    }
  }
  return Int32Array.from(list);
}

/** +1 where mirroring the listener leaves the harmonic alone (m ≥ 0), −1 where
 *  it flips the sign (m < 0) — the right ear, in one array. */
function binauralMirrorSigns(acn) {
  const out = new Int8Array(acn.length);
  for (let i = 0; i < acn.length; i++) {
    const k = acn[i];
    const l = Math.floor(Math.sqrt(k));
    out[i] = k - (l * l + l) >= 0 ? 1 : -1; // k − (l²+l) IS m
  }
  return out;
}

function binBesselI0(x) {
  let sum = 1.0;
  let term = 1.0;
  const half = x * 0.5;
  for (let k = 1; k < 24; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Rate-convert the whole set (item 108: the engine runs at 48 kHz, which is the
 * rate the HRIRs were measured at, but a test or a future device may not).
 * These are IMPULSE RESPONSES, not signals, so the taps are scaled by 1/ratio:
 * what has to survive is the filter's response Σh·e^{−jωn}, not the sequence's
 * amplitude. Length is rounded up to a multiple of four for the convolver's
 * unrolled inner loop.
 */
function binauralResample(src, srcLen, channels, rate) {
  const ratio = rate / HRIR_RATE;
  const cutoff = ratio < 1.0 ? ratio : 1.0;      // of the SOURCE Nyquist
  const half = Math.ceil(BIN_RESAMP_HALF / cutoff);
  const dstLen = (Math.ceil(srcLen * ratio) + 3) & ~3;
  const out = new Float64Array(channels * dstLen);
  const norm = binBesselI0(BIN_RESAMP_BETA);
  const scale = 1.0 / ratio;
  for (let n = 0; n < dstLen; n++) {
    const t = n / ratio;
    const lo = Math.max(0, Math.ceil(t - half));
    const hi = Math.min(srcLen - 1, Math.floor(t + half));
    for (let i = lo; i <= hi; i++) {
      const d = t - i;
      const u = cutoff * d;
      const sinc = Math.abs(u) < 1e-9 ? 1.0 : Math.sin(Math.PI * u) / (Math.PI * u);
      const x = d / half;
      const w = binBesselI0(BIN_RESAMP_BETA * Math.sqrt(1.0 - x * x)) / norm;
      const g = cutoff * sinc * w * scale;
      for (let c = 0; c < channels; c++) out[c * dstLen + n] += src[c * srcLen + i] * g;
    }
  }
  return out;
}

/**
 * Level contract: a source dead ahead must leave the head carrying the same
 * total power the stereo pan law gives it (cos² + sin² = 1, i.e. 0.707 per ear,
 * exactly what the fold delivers). One scalar does it, folded into the table.
 * Every other direction is then free to differ, and does — a real head is
 * quieter behind and below, and that level cue is part of what makes the
 * direction audible rather than an artefact to flatten out.
 */
function binauralCalibration(hrir, len) {
  const sh = new Float64Array(BIN_SH_COUNT);
  encodeSN3D(BIN_FRONT_AZIMUTH, 0.0, BIN_ORDER, sh);
  const all = Int32Array.from({ length: BIN_SH_COUNT }, (_, k) => k);
  const mirror = binauralMirrorSigns(all);
  let energy = 0.0;
  for (let n = 0; n < len; n++) {
    let p = 0.0;
    let q = 0.0;
    for (let k = 0; k < BIN_SH_COUNT; k++) {
      const v = sh[k] * hrir[k * len + n];
      if (mirror[k] > 0) p += v; else q += v;
    }
    energy += (p + q) * (p + q) + (p - q) * (p - q);
  }
  return 1.0 / Math.sqrt(energy);
}

/** The decoded, rate-converted, calibrated set — one build per rate, ever. */
const binauralTables = new Map();

function binauralHrirTable(rate = SAMPLING_RATE) {
  let t = binauralTables.get(rate);
  if (t !== undefined) return t;
  const raw = decodeShHrir();
  const hrir = rate === HRIR_RATE
    ? raw
    : binauralResample(raw, HRIR_LENGTH, HRIR_CHANNELS, rate);
  const taps = hrir.length / HRIR_CHANNELS;
  const gain = binauralCalibration(hrir, taps);
  for (let i = 0; i < hrir.length; i++) hrir[i] *= gain;
  t = { hrir, taps };
  binauralTables.set(rate, t);
  return t;
}

/**
 * Headphone render target: the bus carries an ambisonic scene, and the monitor
 * pair is that scene decoded through the SADIE HRIRs. `numChannels` is the
 * harmonic count — 16 for a spatial song, 10 for a planar one — so the decode
 * costs that many taps-long convolutions per frame, and the encode costs the
 * same handful of multiplies per voice the AmbiX export costs.
 */
class BinauralRenderer {
  constructor(sphere = true, sampleRate = SAMPLING_RATE) {
    this.sphere = sphere;
    this.acn = binauralChannelList(sphere);
    this.numChannels = this.acn.length;
    this.name = `binaural-${sphere ? "3d" : "2d"}`;
    this.sampleRate = sampleRate;
    this.order = BIN_ORDER;

    const table = binauralHrirTable(sampleRate);
    this.taps = table.taps;
    // The set's channels, gathered into bus order so the frame loop walks both
    // the history and the taps straight forward.
    this.hrir = new Float64Array(this.numChannels * this.taps);
    for (let c = 0; c < this.numChannels; c++) {
      this.hrir.set(table.hrir.subarray(this.acn[c] * this.taps, (this.acn[c] + 1) * this.taps),
        c * this.taps);
    }
    this.mirror = binauralMirrorSigns(this.acn);

    // Convolution history: every sample is written twice, `taps` apart, so a
    // backwards run of `taps` taps is always one contiguous stretch — no
    // index masking in the innermost loop.
    this.hist = new Float64Array(this.numChannels * this.taps * 2);
    this.histPos = 0;
    this._sh = new Float64Array(BIN_SH_COUNT);
  }

  /** Drop the convolution history (a new song, or a monitor switch). */
  reset() {
    this.hist.fill(0.0);
    this.histPos = 0;
  }

  /** Ambisonic encode — the bus channel gains for a source at (az, el). */
  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, BIN_ORDER, this._sh);
    const acn = this.acn;
    for (let c = 0; c < acn.length; c++) out[off + c] = sh[acn[c]];
  }

  /**
   * Decode one frame to two ears (the mixer calls this in frame order, which is
   * what makes the history below legal): one FIR per ambisonic channel, summed
   * into the symmetric and antisymmetric halves, then L = P + N, R = P − N.
   */
  monitorStereo(data, frames, n, out) {
    const nc = this.numChannels;
    const taps = this.taps;
    const hrir = this.hrir;
    const hist = this.hist;
    const mirror = this.mirror;
    const pos = this.histPos;
    let p = 0.0;
    let q = 0.0;

    for (let c = 0; c < nc; c++) {
      const base = c * taps * 2;
      const x = data[c * frames + n];
      hist[base + pos] = x;
      hist[base + pos + taps] = x;

      // Four accumulators: the tap loop is one long dependent chain of adds
      // otherwise, and breaking it is worth ~35 % of the whole decode.
      const hb = c * taps;
      const head = base + pos + taps;
      let a0 = 0.0;
      let a1 = 0.0;
      let a2 = 0.0;
      let a3 = 0.0;
      for (let i = 0; i < taps; i += 4) {
        a0 += hrir[hb + i] * hist[head - i];
        a1 += hrir[hb + i + 1] * hist[head - i - 1];
        a2 += hrir[hb + i + 2] * hist[head - i - 2];
        a3 += hrir[hb + i + 3] * hist[head - i - 3];
      }
      const acc = (a0 + a1) + (a2 + a3);
      if (mirror[c] > 0) p += acc; else q += acc;
    }

    this.histPos = pos + 1 === taps ? 0 : pos + 1;
    out[0] = p + q;
    out[1] = p - q;
  }
}

// ══ src/engine/speakers.js ══
// ITU speaker layouts and their render target (#998.6) — quadraphonic, 5.1 and
// 7.1 export.
//
// Like every other renderer, this one only answers "what gain does a source at
// (az, el) get in each of my channels?" — the mixer, the voices and the effects
// know nothing about it. It is not loaded by the worklet: playback monitors in
// stereo or binaural, and speaker feeds are an EXPORT target.
//
// ── Placement ──
// Angles are BS.775 / BS.2051: ±30° front pair, centre dead ahead, ±110°
// surrounds (quad drops the centre and the LFE), and for 7.1 the BS.2051
// System C split of ±90° sides and ±135° rears. Channel ORDER is the Microsoft
// WAVEFORMATEXTENSIBLE order that goes with each mask (…, BL, BR, SL, SR),
// which is what every DAW expects from a .wav; the ADM labels below carry the
// ITU names, where the sign convention is the opposite one (M+030 is LEFT).
// Note this is a different ordering question from a multi-channel SAMPLE's
// channels (spatial.js SAMPLE_CHANNEL_LAYOUT) — that order is fixed by the
// file format's 's' block, this one by the container we write.
//
// ── The LFE ──
// stays silent. There is no bass-management stage in this engine, and folding
// low frequencies into a separate channel would change the sound of the mix for
// anyone whose player redirects it back. The channel exists because the format
// has it; a mastering engineer fills it.


const SPK_AZ_PER_DEG = AZIMUTH_TURN / 360;
const SPK_EL_TO_RAD = Math.PI / 256; // 128 elevation units = 90°

/**
 * `deg` is degrees CLOCKWISE from front (negative = left), the same convention
 * as SAMPLE_CHANNEL_LAYOUT; `label` is the WAV/DAW name and `adm` the BS.2051
 * one. `mask` is the WAVEFORMATEXTENSIBLE dwChannelMask for the whole layout.
 */
const SPEAKER_LAYOUTS = Object.freeze({
  quad: {
    name: "quad",
    mask: 0x0033, // FL | FR | BL | BR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "Ls", adm: "M+110", deg: -110 },
      { label: "Rs", adm: "M-110", deg: 110 },
    ],
  },
  "5.1": {
    name: "5.1",
    mask: 0x003f, // FL | FR | FC | LFE | BL | BR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "C", adm: "M+000", deg: 0 },
      { label: "LFE", adm: "LFE1", deg: 0, lfe: true },
      { label: "Ls", adm: "M+110", deg: -110 },
      { label: "Rs", adm: "M-110", deg: 110 },
    ],
  },
  "7.1": {
    name: "7.1",
    mask: 0x063f, // FL | FR | FC | LFE | BL | BR | SL | SR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "C", adm: "M+000", deg: 0 },
      { label: "LFE", adm: "LFE1", deg: 0, lfe: true },
      { label: "Lrs", adm: "M+135", deg: -135 },
      { label: "Rrs", adm: "M-135", deg: 135 },
      { label: "Lss", adm: "M+090", deg: -90 },
      { label: "Rss", adm: "M-090", deg: 90 },
    ],
  },
});

/** Layout names in the order the UI offers them (fewest channels first). */
const SPEAKER_LAYOUT_NAMES = Object.freeze(["quad", "5.1", "7.1"]);

/** Engine azimuth of a speaker (front = 128, clockwise). */
function speakerAzimuth(deg) {
  return wrapAzimuth(128 + deg * SPK_AZ_PER_DEG);
}

/**
 * Speaker-feed render target. Sources are panned pairwise around the horizontal
 * ring — constant power between the two speakers that bracket them, which is
 * the classic surround panner and is exact at every speaker — and elevation,
 * which no ITU layout can reproduce, spreads the source evenly over the ring as
 * it climbs, reaching a fully diffuse image at the poles. That keeps the level
 * constant and the movement continuous, and it is the same idea as the stereo
 * fold's collapse toward the centre, generalised to n speakers.
 */
class SpeakerRenderer {
  constructor(layoutName) {
    const layout = SPEAKER_LAYOUTS[layoutName];
    if (!layout) throw new Error(`unknown speaker layout: ${layoutName}`);
    this.layout = layout;
    this.name = `speakers-${layout.name}`;
    this.numChannels = layout.speakers.length;

    // Ring = every non-LFE speaker, sorted by azimuth so the bracketing pair is
    // a search away rather than a special case per layout.
    const ring = [];
    for (let i = 0; i < layout.speakers.length; i++) {
      const s = layout.speakers[i];
      if (s.lfe) continue;
      ring.push({ channel: i, az: speakerAzimuth(s.deg) });
    }
    ring.sort((a, b) => a.az - b.az);
    this.ringChannel = Int32Array.from(ring, (r) => r.channel);
    this.ringAz = Float64Array.from(ring, (r) => r.az);
    this.ringSize = ring.length;

    // Stereo monitor: fold each speaker as if it were itself a source, so the
    // preview agrees with what the stereo export of the same song would give.
    const fold = new StereoRenderer();
    this.monitorGains = new Float64Array(this.numChannels * 2);
    for (let i = 0; i < layout.speakers.length; i++) {
      if (layout.speakers[i].lfe) continue;
      fold.channelGains(speakerAzimuth(layout.speakers[i].deg), 0, this.monitorGains, i * 2);
    }
  }

  channelGains(az, el, out, off) {
    const n = this.numChannels;
    for (let c = 0; c < n; c++) out[off + c] = 0.0;

    const size = this.ringSize;
    const a = wrapAzimuth(az);
    // The bracketing pair, with the wrap-around arc as the last segment.
    let i = size - 1;
    for (let k = 0; k < size; k++) {
      if (a < this.ringAz[k]) { i = (k - 1 + size) % size; break; }
    }
    const j = (i + 1) % size;
    const a0 = this.ringAz[i];
    let span = this.ringAz[j] - a0;
    if (span <= 0) span += AZIMUTH_TURN;
    let d = a - a0;
    if (d < 0) d += AZIMUTH_TURN;
    const t = (d / span) * (Math.PI / 2);
    out[off + this.ringChannel[i]] = Math.cos(t);
    out[off + this.ringChannel[j]] = Math.sin(t);

    // Height has nowhere to go in a planar layout: spread it instead.
    const w = Math.abs(Math.sin(el * SPK_EL_TO_RAD));
    if (w > 0) {
      const diffuse = w / size;
      for (let k = 0; k < size; k++) {
        const c = off + this.ringChannel[k];
        out[c] = Math.sqrt((1 - w) * out[c] * out[c] + diffuse);
      }
    }
  }

  monitorStereo(data, frames, n, out) {
    let l = 0.0;
    let r = 0.0;
    for (let c = 0; c < this.numChannels; c++) {
      const v = data[c * frames + n];
      l += v * this.monitorGains[c * 2];
      r += v * this.monitorGains[c * 2 + 1];
    }
    out[0] = l;
    out[1] = r;
  }
}

// ══ src/engine/analysis.js ══
// Master-bus analysis tap (item 98) — what the mastering strip looks at.
//
// The strip asks two different questions, and they want two different signals:
//
//   * "where is the energy in the room?" — the vectorscopes. That is a question
//     about the SOUND FIELD, not about any particular set of speakers, so the
//     scope tap is always first-order B-format (ACN/SN3D: W Y Z X). The three
//     Goniometer views are then literally axis pairs of that field — top = Y·X
//     (left-right against front-back), front = Y·Z, side = X·Z — and no view
//     needs a decode. A STEREO song has no front-back axis at all, so its tap
//     is taken from the finished mix instead: W = (L+R)/√2, Y = (L−R)/√2, which
//     is exactly the stereo→B-format encoding of a ±90° pair, and makes the top
//     view the classic mid/side goniometer. One display, every model.
//
//   * "will it clip, and how loud is it?" — the meters. That IS a question
//     about a target: 5.1's centre channel is only a thing if you are mastering
//     for 5.1. So the meters read a metering TARGET the user picks, rendered
//     through the very same renderers the exporter uses (speakers.js), which is
//     what makes the bars agree with the file that comes out.
//
// ── The ambisonic case ──
// There are no speakers to meter, so per-speaker levels are meaningless. What
// IS meaningful is the acoustic energy density of the encoded field,
//
//     E = (W² + X² + Y² + Z²) / 2
//
// which for SN3D order 1 reads p² for a plane wave from ANY direction and sums
// correctly over uncorrelated sources — a direction-invariant loudness that
// needs no decode and no listening position. Peak is per encoded CHANNEL (that
// is what clips in the exported file), oversampled 4× for the inter-sample
// peaks a later decode or resample would expose.
//
// Not a port: the Kotlin engine has no surround and no analysis tap, so this
// file — like spatial.js and binaural.js — IS the reference implementation.
//
// COST: everything here is opt-in. The tap is built only while the strip is on
// screen, and a stereo song never pays for a bus at all (its tap is two adds on
// the finished mix). See TrackerState.setAnalysis.




/** Metering targets. The value is the wire form (CMD.SET_ANALYSIS.target). */
const ANALYSIS_OFF = "off";
const ANALYSIS_STEREO = "stereo";
const ANALYSIS_AMBISONIC = "ambisonic";
/** …plus every key of SPEAKER_LAYOUTS ("quad", "5.1", "7.1"). */

/**
 * Scope ring: frames of B-format held for the vectorscopes. 4096 frames is
 * 85 ms at 48 kHz — five snapshot intervals, so a 60 fps strip never misses a
 * sample, and the cloud it draws is a WIDE window: many points, and only about
 * an eighth of them replaced per frame, which is what makes the shape settle
 * instead of flickering. The ring rides in the snapshot (64 KiB), so this is
 * also what the wire pays.
 */
const SCOPE_FRAMES = 4096;
/**
 * SECOND-ORDER ACN/SN3D — W Y Z X, then the five order-2 harmonics, in the
 * ring's interleave order.
 *
 * The scopes and the radiation surface only ever read the first four, and for
 * them order 1 IS the field. The soundfield cloud needs the rest, because at
 * first order some genuinely different scenes are the SAME four numbers: two
 * sources in anti-phase cancel in W entirely, and a pair at ±15° then encodes
 * identically to a pair at ±90°. Nothing downstream can undo that. The order-2
 * quadrupole breaks the tie and recovers both bearings exactly (see cloud.js).
 *
 * COST: the ring is the snapshot's largest block, and this takes it from 64 KiB
 * to 144 KiB. It is still built only while the strip is on screen.
 */
const SCOPE_CHANNELS = 9;
const SCOPE_W = 0, SCOPE_Y = 1, SCOPE_Z = 2, SCOPE_X = 3;
/** First of the five order-2 harmonics (ACN 4..8). */
const SCOPE_ORDER2 = 4;
/** The ambisonic order the ring carries. */
const SCOPE_ORDER = 2;

/** Widest metered channel set (7.1). Bounds the snapshot's meter block. */
const ANALYSIS_MAX_METERS = 8;

const SQRT1_2 = Math.SQRT1_2;

/** Which signals the meters read for a given target. */
const METER_MIX = 0;       // the finished stereo mix (fold or binaural)
const METER_FOA = 1;       // the encoded field's own channels
const METER_SPEAKERS = 2;  // speaker feeds, exactly as the exporter writes them

/**
 * Channel labels for a target, in meter order — the UI draws these under the
 * bars, and they are the same names speakers.js gives the exporter.
 */
function meterLabels(target) {
  if (target === ANALYSIS_STEREO) return ["L", "R"];
  // Meter order is W Y X Z, not the ring's ACN order: it puts the three
  // channels a planar song can actually excite first, so its meter strip is
  // three live bars instead of three live bars and a dead one.
  if (target === ANALYSIS_AMBISONIC) return ["W", "Y", "X", "Z"];
  const layout = SPEAKER_LAYOUTS[target];
  return layout ? layout.speakers.map((s) => s.label) : [];
}

/**
 * How a speaker layout's bars are ARRANGED on screen: left to right the way the
 * speakers stand around the listener, rather than in the file's channel order.
 * The LFE is not drawn at all — the exporter leaves it silent by design
 * (speakers.js), so a bar for it would only ever be a dead one.
 */
const METER_ARRANGEMENT = Object.freeze({
  quad: ["Ls", "L", "R", "Rs"],
  "5.1": ["Ls", "L", "C", "R", "Rs"],
  "7.1": ["Lrs", "Lss", "L", "C", "R", "Rss", "Rrs"],
});

/**
 * The meter strip as it is drawn: {label, channel} pairs, where `channel` is
 * the index the tap meters that signal on. Anything the arrangement leaves out
 * (the LFE) simply has no entry.
 */
function meterDisplay(target) {
  const labels = meterLabels(target);
  const order = METER_ARRANGEMENT[target];
  if (!order) return labels.map((label, channel) => ({ label, channel }));
  const out = [];
  for (const label of order) {
    const channel = labels.indexOf(label);
    if (channel >= 0) out.push({ label, channel });
  }
  return out;
}

/**
 * The targets that make sense for a surround model. A stereo song has exactly
 * one (there is nowhere else for the sound to go); a planar song can be
 * mastered for any ring; a spatial one additionally for a full-sphere basis.
 * The UI hides everything not listed here — item 98's "nonsensical options are
 * hidden" rule, applied to the meters.
 */
function availableTargets(model) {
  if (model === SURROUND_STEREO) return [ANALYSIS_STEREO];
  return [ANALYSIS_STEREO, "quad", "5.1", "7.1", ANALYSIS_AMBISONIC];
}

// ── 4× true-peak oversampler ────────────────────────────────────────────────
// A 32-tap windowed sinc split into 4 polyphase branches of 8 taps. Each branch
// is normalised to unity DC gain on its own, so a constant input reads back as
// itself and the oversampled peak can never sit BELOW the sample peak for a
// steady signal. No branch is the identity (the linear-phase delay 15.5 is not
// a multiple of 4), so the sample peak is tracked separately and folded in.

const TP_PHASES = 4;
const TP_TAPS = 8;

const TP_COEF = (() => {
  const n = TP_PHASES * TP_TAPS;
  const h = new Float64Array(n);
  const centre = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - centre) / TP_PHASES;
    const sinc = t === 0 ? 1.0 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
  }
  // Per-branch DC normalisation (see above).
  for (let p = 0; p < TP_PHASES; p++) {
    let s = 0.0;
    for (let k = 0; k < TP_TAPS; k++) s += h[k * TP_PHASES + p];
    if (s !== 0) for (let k = 0; k < TP_TAPS; k++) h[k * TP_PHASES + p] /= s;
  }
  return h;
})();

/**
 * Per-channel inter-sample peak detector. `channels` histories are kept side by
 * side; `push` returns nothing and `peak(c)` is read at drain time.
 */
class TruePeakDetector {
  constructor(channels) {
    this.channels = channels;
    this.hist = new Float64Array(channels * TP_TAPS); // newest first
    this.peaks = new Float64Array(channels);
  }

  reset() {
    this.hist.fill(0.0);
    this.peaks.fill(0.0);
  }

  /** Feed one sample of channel `c` and fold its 4 interpolated points in. */
  push(c, v) {
    const base = c * TP_TAPS;
    const h = this.hist;
    for (let k = TP_TAPS - 1; k > 0; k--) h[base + k] = h[base + k - 1];
    h[base] = v;
    let hi = this.peaks[c];
    for (let p = 0; p < TP_PHASES; p++) {
      let acc = 0.0;
      for (let k = 0; k < TP_TAPS; k++) acc += h[base + k] * TP_COEF[k * TP_PHASES + p];
      const a = acc < 0 ? -acc : acc;
      if (a > hi) hi = a;
    }
    this.peaks[c] = hi;
  }

  clearPeaks() { this.peaks.fill(0.0); }
}

// ── The analysis render target ──────────────────────────────────────────────

/**
 * Channels 0..3 are always the B-format scope tap; a speaker target appends its
 * own feeds after them, so ONE bus serves both halves of the strip and every
 * voice's gains are computed once per direction change.
 *
 * It is a SpatialRenderer like any other — the mixer cannot tell it apart from
 * the exporter's — but it is never a monitor, so `monitorStereo` is only the
 * FOA virtual-stereo decode the correlation meter uses.
 */
class AnalysisRenderer {
  constructor(speakerLayout = null) {
    this.speakers = speakerLayout === null ? null : new SpeakerRenderer(speakerLayout);
    this.numChannels = SCOPE_CHANNELS + (this.speakers === null ? 0 : this.speakers.numChannels);
    this.name = `analysis-${speakerLayout ?? "foa"}`;
    this._sh = new Float64Array(SCOPE_CHANNELS);
  }

  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, SCOPE_ORDER, this._sh);
    for (let c = 0; c < SCOPE_CHANNELS; c++) out[off + c] = sh[c];
    if (this.speakers !== null) this.speakers.channelGains(az, el, out, off + SCOPE_CHANNELS);
  }

  /** W ± Y — the coincident cardioid pair, i.e. the stereo the field would fold to. */
  monitorStereo(data, frames, n, out) {
    const w = data[n];
    const y = data[frames + n];
    out[0] = (w + y) * SQRT1_2;
    out[1] = (w - y) * SQRT1_2;
  }
}

// ── The tap ─────────────────────────────────────────────────────────────────

/**
 * Accumulates everything the strip needs over a chunk and hands it to the
 * snapshot: a ring of B-format frames (scopes), per-channel peak / true peak /
 * mean square / clip count (meters), the field energy integral (the ambisonic
 * RMS) and the three correlation sums.
 *
 * Meters and correlation are drained per snapshot (~16 ms) and integrated by
 * the UI, which is where the ballistics belong — the engine ships numbers, not
 * a look.
 */
class AnalysisTap {
  /**
   * @param {string} target one of ANALYSIS_STEREO / ANALYSIS_AMBISONIC / a SPEAKER_LAYOUTS key
   * @param {number} model  the song's surround model (SURROUND_*)
   */
  constructor(target, model) {
    this.target = target;
    this.model = model;
    const stereoSong = model === SURROUND_STEREO;
    const layout = SPEAKER_LAYOUTS[target] ? target : null;

    // A stereo song's field is derived from the finished mix (two adds per
    // frame), so it needs no bus and no per-voice work whatsoever. Any other
    // model already runs an object bus for the monitor; this is the second one.
    this.bus = stereoSong ? null : new SpatialBus(new AnalysisRenderer(layout), TRACKER_CHUNK);

    if (stereoSong || target === ANALYSIS_STEREO) {
      this.meterSource = METER_MIX;
      this.meterCount = 2;
    } else if (layout !== null) {
      this.meterSource = METER_SPEAKERS;
      this.meterCount = SPEAKER_LAYOUTS[layout].speakers.length;
    } else {
      this.meterSource = METER_FOA;
      // A planar song can never excite Z; metering it would be a permanently
      // dead bar, so the ambisonic meter drops it (the exported AmbiX file
      // still carries the full basis — see #998.4).
      this.meterCount = model === SURROUND_SPATIAL ? 4 : 3;
    }

    this.ring = new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS);
    this.ringWrite = 0; // frame index into the ring (wraps; the UI reads backwards)

    this.peak = new Float64Array(ANALYSIS_MAX_METERS);
    this.sumsq = new Float64Array(ANALYSIS_MAX_METERS);
    this.clip = new Float64Array(ANALYSIS_MAX_METERS);
    this.tp = new TruePeakDetector(this.meterCount);
    this.frames = 0;
    this.fieldEnergy = 0.0;
    this.corrLL = 0.0;
    this.corrRR = 0.0;
    this.corrLR = 0.0;
    this._meters = new Float64Array(ANALYSIS_MAX_METERS);
  }

  /** Per-chunk: the bus is an accumulator like the monitor's. */
  begin() {
    if (this.bus !== null) this.bus.clear();
  }

  /**
   * Fold one rendered chunk in. `mixL`/`mixR` are the finished device pair
   * (post fold/binaural, post Amiga filter, post clamp) — which is exactly what
   * a stereo export writes, so the stereo meters read the delivered signal
   * rather than the pre-master bus.
   */
  finish(frames, mixL, mixR) {
    const bus = this.bus;
    const data = bus === null ? null : bus.data;
    const busFrames = bus === null ? 0 : bus.frames;
    const nc = this.meterCount;
    const src = this.meterSource;
    const ring = this.ring;
    const m = this._meters;

    for (let n = 0; n < frames; n++) {
      let w, y, z, x;
      if (data === null) {
        // Stereo song: the ±90° pair encoding, which is also the inverse of the
        // monitorStereo decode above.
        const l = mixL[n];
        const r = mixR[n];
        w = (l + r) * SQRT1_2;
        y = (l - r) * SQRT1_2;
        z = 0.0;
        x = 0.0;
      } else {
        w = data[n];
        y = data[busFrames + n];
        z = data[2 * busFrames + n];
        x = data[3 * busFrames + n];
      }

      const rw = this.ringWrite * SCOPE_CHANNELS;
      ring[rw] = w;
      ring[rw + 1] = y;
      ring[rw + 2] = z;
      ring[rw + 3] = x;
      // The order-2 harmonics ride along untouched; a stereo song has none (it
      // has no bus at all), and its ring simply carries zeros there.
      if (data === null) {
        for (let c = SCOPE_ORDER2; c < SCOPE_CHANNELS; c++) ring[rw + c] = 0;
      } else {
        for (let c = SCOPE_ORDER2; c < SCOPE_CHANNELS; c++) {
          ring[rw + c] = data[c * busFrames + n];
        }
      }
      this.ringWrite = (this.ringWrite + 1) % SCOPE_FRAMES;

      this.fieldEnergy += (w * w + x * x + y * y + z * z) * 0.5;

      // Correlation is always measured on a stereo pair: the mix itself when
      // there is one, otherwise the field's virtual stereo decode.
      let cl, cr;
      if (data === null) {
        cl = mixL[n];
        cr = mixR[n];
      } else {
        cl = (w + y) * SQRT1_2;
        cr = (w - y) * SQRT1_2;
      }
      this.corrLL += cl * cl;
      this.corrRR += cr * cr;
      this.corrLR += cl * cr;

      if (src === METER_MIX) {
        m[0] = mixL[n];
        m[1] = mixR[n];
      } else if (src === METER_FOA) {
        m[0] = w; m[1] = y; m[2] = x; m[3] = z; // meterLabels order, not ACN
      } else {
        for (let c = 0; c < nc; c++) m[c] = data[(SCOPE_CHANNELS + c) * busFrames + n];
      }
      for (let c = 0; c < nc; c++) {
        const v = m[c];
        const a = v < 0 ? -v : v;
        if (a > this.peak[c]) this.peak[c] = a;
        this.sumsq[c] += v * v;
        // The mix bus is hard-clamped to ±1, so a sample AT full scale is a
        // clipped one; an object/speaker bus is unclamped and only exceeding
        // full scale would clip the file it is written to.
        if (a >= 1.0) this.clip[c] += 1;
        this.tp.push(c, v);
      }
    }
    this.frames += frames;
  }

  /** Snapshot readout; resets the accumulators (peaks included — the UI holds
   *  the hold/decay, so a stale peak can never stick here). */
  drain(out) {
    out.frames = this.frames;
    out.fieldEnergy = this.fieldEnergy;
    out.corrLL = this.corrLL;
    out.corrRR = this.corrRR;
    out.corrLR = this.corrLR;
    out.ringWrite = this.ringWrite;
    out.meterCount = this.meterCount;
    for (let c = 0; c < this.meterCount; c++) {
      const tp = this.tp.peaks[c];
      out.peak[c] = this.peak[c];
      out.truePeak[c] = tp > this.peak[c] ? tp : this.peak[c];
      out.meanSquare[c] = this.frames > 0 ? this.sumsq[c] / this.frames : 0.0;
      out.clip[c] = this.clip[c];
    }
    this.frames = 0;
    this.fieldEnergy = 0.0;
    this.corrLL = this.corrRR = this.corrLR = 0.0;
    this.peak.fill(0.0);
    this.sumsq.fill(0.0);
    this.clip.fill(0.0);
    this.tp.clearPeaks();
    return out;
  }
}

/** A drain target, so the snapshot fill allocates nothing. */
function makeAnalysisReadout() {
  return {
    frames: 0, fieldEnergy: 0, corrLL: 0, corrRR: 0, corrLR: 0, ringWrite: 0, meterCount: 0,
    peak: new Float64Array(ANALYSIS_MAX_METERS),
    truePeak: new Float64Array(ANALYSIS_MAX_METERS),
    meanSquare: new Float64Array(ANALYSIS_MAX_METERS),
    clip: new Float64Array(ANALYSIS_MAX_METERS),
  };
}

// ══ src/engine/samplemod.js ══
// Sample-modification note effects (item 130) — notefx 2 and 3, ONE command
// with two spellings: `3` names the region to modify, `2` names the region to
// leave alone. Both are NON-DESTRUCTIVE views over the sample pool, exactly as
// S $Fxxx is: the state lives on the INSTRUMENT and is applied when a byte is
// read (sampler.js readSamplePoint), so the pool itself is never written.
//
// Behavioural contract: TAUD_NOTE_EFFECTS.md §"2 $sexy and 3 $sexy".
//
//   $s $e   the region (see decodeSampleRegion)
//   $x      the operation — one at a time, so an instrument carries ONE
//           modification and writing either opcode replaces it
//   $y      index into FUNK_SPEED_TABLE, ProTracker's own funk-speed ladder
//
// Region argument, decoded once here so the two spellings cannot drift apart:
//
//   $00        the sounding voice's LOOP region (the S $Fxxx region)
//   $s..$e     s <= e: from s/16 to (e+1)/16 of the sample, rounded
//              — so $0F is the whole sample and $4B the middle half
//   $10        middle half            $20 first two thirds   $21 last two thirds
//   $30 $31 $32  first / middle / last third
//   $F0..$FE   COMB: keep the extent, alternate in and out of it every 2^n
//              bytes ($F0 = every other byte, $F3 = runs of 8, $FE = 16384)
//   otherwise (s > e)  reserved — the whole command is ignored
//
// The extent is stored with a -1 sentinel meaning "follow the sounding voice's
// loop", which is what keeps an Ixmp-patched voice on its own loop (item 116).

/** decodeSampleRegion result: nothing (reserved argument). */
const REGION_NONE = 0;
/** decodeSampleRegion result: out = [start, end, combShift] — a whole region. */
const REGION_SET = 1;
/** decodeSampleRegion result: out[2] = combShift only; the extent is kept. */
const REGION_COMB = 2;

// ── the operations ($x) ──────────────────────────────────────────────────────
// ROL rotates the region's BYTES left by 1/2/4/8 per step (there is no
// rotate-right: a left rotation of n and a right rotation of span−n are the
// same picture, and the ladder is more useful spent on step sizes). SUB
// subtracts from each byte's U8 value, wrapping through zero, by 2/8/32/128 per
// step — a running level slide that folds rather than clips.
const MOD_OFF = 0x0;
const MOD_FUNK = 0x1;
const MOD_ROL1 = 0x2;
const MOD_ROL8 = 0x5;
const MOD_SUB2 = 0x6;
const MOD_SUB128 = 0x9;
/** Highest assigned operation; $A..$F are reserved. */
const MOD_MAX = MOD_SUB128;

/** Step size per operation — bytes for the ROLs, U8 levels for the SUBs. */
const MOD_STEP = Object.freeze([0, 0, 1, 2, 4, 8, 2, 8, 32, 128]);

const isRolOp = (op) => op >= MOD_ROL1 && op <= MOD_ROL8;
const isSubOp = (op) => op >= MOD_SUB2 && op <= MOD_SUB128;

/**
 * ProTracker's funk-speed ladder, indexed by $y. The same table converters use
 * to lift `EFx` into `S $Fyyy`, so "speed 4" means one thing across the format.
 */
const FUNK_SPEED_TABLE = Object.freeze([
  0, 5, 6, 7, 8, 0x0a, 0x0b, 0x0d, 0x10, 0x13, 0x16, 0x1a, 0x20, 0x2b, 0x40, 0x80,
]);

/** Scratch triple for the decoders (callers own theirs; engine never allocates
 *  inside a tick). */
const regionScratch = new Int32Array(3);

/**
 * Decode the $se region byte against one voice's ACTIVE sample geometry.
 * Writes [start, end, combShift] into `out` and returns one of the REGION_*
 * codes. `combShift` is -1 for a solid region, else n where the comb runs are
 * 2^n bytes long.
 */
function decodeSampleRegion(se, sampleLen, loopStart, loopEnd, out) {
  const s = (se >>> 4) & 0xf;
  const e = se & 0xf;
  const len = sampleLen;
  out[2] = -1;
  // $Fn — comb only. Listed before the s <= e rule so $FF stays a comb rather
  // than becoming "the last sixteenth", and n = $E is the largest run.
  if (s === 0xf && e !== 0xf) { out[2] = e; return REGION_COMB; }
  if (se === 0x00) {
    // The loop region — spelled as the -1 sentinel so an Ixmp-patched voice
    // still follows ITS OWN loop (item 116) rather than a baked-in span.
    out[0] = -1;
    out[1] = -1;
    return REGION_SET;
  }
  if (len < 2) return REGION_NONE;
  if (s <= e) {
    out[0] = Math.round((len * s) / 16);
    out[1] = Math.round((len * (e + 1)) / 16);
    return REGION_SET;
  }
  switch (se) {
    case 0x10: out[0] = Math.round(len / 4); out[1] = Math.round((len * 3) / 4); break;
    case 0x20: out[0] = 0;                   out[1] = Math.round((len * 2) / 3); break;
    case 0x21: out[0] = Math.round(len / 3); out[1] = len;                       break;
    case 0x30: out[0] = 0;                   out[1] = Math.round(len / 3);       break;
    case 0x31: out[0] = Math.round(len / 3); out[1] = Math.round((len * 2) / 3); break;
    case 0x32: out[0] = Math.round((len * 2) / 3); out[1] = len;                 break;
    default: return REGION_NONE; // $40..$ED with s > e — reserved
  }
  if (out[1] - out[0] < 2) return REGION_NONE;
  return REGION_SET;
}

/**
 * Is byte `k` (an offset from the extent start) INSIDE the comb's runs?
 * `shift` < 0 is a solid region. Runs are 2^shift bytes, alternating in and
 * out, so the test is one shift and one bit — this sits in the sample-read
 * hot path.
 */
function inCombRun(k, shift) {
  return shift < 0 || ((k >>> shift) & 1) === 0;
}

/**
 * Does the modification touch sample byte `i`? The extent and comb decide, and
 * notefx 2's inversion flips the answer — which is the ONLY difference between
 * the two opcodes.
 */
function modTouches(inst, i, extentStart, extentEnd) {
  const inside = i >= extentStart && i < extentEnd &&
    inCombRun(i - extentStart, inst.modComb);
  return inst.modInvert ? !inside : inside;
}

/**
 * How far the funk walk may scan for the next byte the modification touches.
 * An inverted region can exclude almost the whole sample, and the walk must
 * not turn into a linear search for the one byte that is left — past this many
 * misses the step simply does not land. Well above any musically useful comb.
 */
const MOD_WALK_SCAN = 4096;

// ══ src/engine/inst.js ══
// Taud instrument data model — port of AudioAdapter.kt TaudInstEnvPoint (5246),
// TaudInstPatch (5261), MetaLayer (5312), TaudInst (5378-5766).
// Envelope point `offset` is the ThreeFiveMiniUfloat LUT index (0..255);
// use minifloatToDouble(pt.offset) for seconds.

function envPoint(value, offset = 0) {
  return { value, offset };
}

function makeEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * One Ixmp "extra sample" patch — overlays sample-scope state on a base
 * instrument for a (noteVal, rowVolume) rectangle. Optional v/p/f/P/x blocks
 * additionally override envelopes and fadeout/cutoff/resonance; anything left
 * absent (null env / hasExtra=false) defers to the base TaudInst.
 * Sentinels: defaultPan 0xFF, defaultNoteVolume 0, vibratoWaveform 0xFF all
 * mean "inherit the base instrument's value".
 *
 * The 's' block (hasChanBlock) makes the patch MULTI-CHANNEL: every channel is
 * a separate pool span sharing this record's length / loop / rate geometry,
 * with `chanPtrs` holding the pointers for channels 2..chanCount (channel 1 is
 * samplePtr). Only stereo (chanCount 2) is played today; the format's
 * quadraphonic/ambisonic cases are TODO #998.
 */
function makeInstPatch(fields) {
  return {
    pitchStart: 0, pitchEnd: 0, volumeStart: 0, volumeEnd: 0,
    samplePtr: 0, sampleLength: 0, playStart: 0, loopStart: 0, loopEnd: 0,
    samplingRate: 0, sampleDetune: 0, loopMode: 0,
    defaultPan: 0xff, defaultNoteVolume: 0,
    vibratoSpeed: 0, vibratoSweep: 0, vibratoDepth: 0, vibratoRate: 0,
    vibratoWaveform: 0xff,
    volEnv: null, volEnvLoop: 0, volEnvSustain: 0,
    panEnv: null, panEnvLoop: 0, panEnvSustain: 0,
    filterEnv: null, filterEnvLoop: 0, filterEnvSustain: 0,
    pitchEnv: null, pitchEnvLoop: 0, pitchEnvSustain: 0,
    hasExtra: false, fadeoutStep: 0, filterSfMode: false,
    extraCutoff: 0xff, extraResonance: 0xff, extraInitialAttenOctet: 0,
    hasChanBlock: false, chanCount: 1, chanMode: CHAN_MODE_DISCRETE,
    chanFlags: 0, chanPtrs: [],
    ...fields,
  };
}

/** 's' block channel modes (low nibble of the count/mode byte). */
const CHAN_MODE_DISCRETE = 0; // XY stereo, 4-track quad — one channel per speaker feed
const CHAN_MODE_MATRIX = 1;   // M/S stereo, ambisonic B-format — decoded before panning

function patchSampleLoopSustain(patch) {
  return (patch.loopMode & 0x04) !== 0;
}

/** Every pool span the patch plays, channel order: [samplePtr, ...chanPtrs]. */
function patchChannelPtrs(patch) {
  return patch.hasChanBlock && patch.chanCount > 1
    ? [patch.samplePtr, ...patch.chanPtrs.slice(0, patch.chanCount - 1)]
    : [patch.samplePtr];
}

/**
 * The Ixmp patch a voice is actually sounding, from the index applyActiveSample
 * recorded on it (-1 = the base record). Bounds-checked: a mid-playback patch
 * re-upload (the Advanced editor) can shorten the list under a live voice.
 */
function patchAt(inst, patchIndex) {
  if (inst == null || patchIndex < 0) return null;
  const patches = inst.extraPatches;
  return patches !== null && patchIndex < patches.length ? patches[patchIndex] : null;
}

/** True when the patch plays exactly two channels (the only multi-channel case
 *  the mixer renders today). */
function patchIsStereo(patch) {
  return patch.hasChanBlock && patch.chanCount === 2 && patch.chanPtrs.length >= 1;
}

/**
 * Parse a flat variable-length Ixmp patch blob (wire format) into patch
 * objects — the codec from AudioJSR223Delegate.kt:357-430, shared by the
 * engine upload path and the document layer. Returns [] for a short blob.
 */
function parsePatchesBlob(bytes) {
  if (bytes.length < 31) return [];
  const u8 = (o) => bytes[o] & 0xff;
  const u16 = (o) => (bytes[o] & 0xff) | ((bytes[o + 1] & 0xff) << 8);
  const s16 = (o) => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v; };
  const u32 = (o) =>
    ((bytes[o] & 0xff) | ((bytes[o + 1] & 0xff) << 8) | ((bytes[o + 2] & 0xff) << 16)) +
    (bytes[o + 3] & 0xff) * 0x1000000;

  const patches = [];
  let o = 0;
  outer: while (o + 31 <= bytes.length) {
    const ver = u8(o);
    let p = o + 31;
    let hasExtra = false, fadeoutStep = 0, extraCutoff = 0xff, extraResonance = 0xff;
    let extraAttenOctet = 0, filterSfMode = false;
    if ((ver & 0x80) !== 0) { // 'x' block (15 bytes)
      if (p + 15 > bytes.length) break;
      filterSfMode = (u8(p) & 0x01) !== 0;
      fadeoutStep = u16(p + 8);
      extraCutoff = u16(p + 10);
      extraResonance = u16(p + 12);
      extraAttenOctet = u8(p + 14);
      hasExtra = true;
      p += 15;
    }
    const readEnv = () => {
      if (p + 54 > bytes.length) return null;
      const loop = u16(p);
      const sus = u16(p + 2);
      const arr = new Array(25);
      for (let k = 0; k < 25; k++) arr[k] = envPoint(u8(p + 4 + 2 * k), u8(p + 5 + 2 * k));
      p += 54;
      return { arr, loop, sus };
    };
    let volEnv = null, volLoop = 0, volSus = 0;
    let panEnv = null, panLoop = 0, panSus = 0;
    let filEnv = null, filLoop = 0, filSus = 0;
    let pitEnv = null, pitLoop = 0, pitSus = 0;
    if ((ver & 0x02) !== 0) { const e = readEnv(); if (e === null) break outer; volEnv = e.arr; volLoop = e.loop; volSus = e.sus; }
    if ((ver & 0x04) !== 0) { const e = readEnv(); if (e === null) break outer; panEnv = e.arr; panLoop = e.loop; panSus = e.sus; }
    if ((ver & 0x08) !== 0) { const e = readEnv(); if (e === null) break outer; filEnv = e.arr; filLoop = e.loop; filSus = e.sus; }
    if ((ver & 0x10) !== 0) { const e = readEnv(); if (e === null) break outer; pitEnv = e.arr; pitLoop = e.loop; pitSus = e.sus; }
    // 's' block LAST (terranmon.txt Ixmp Note 6): u8 count/mode + u24 flags +
    // one u32 sample pointer per EXTRA channel.
    let hasChanBlock = false, chanCount = 1, chanMode = CHAN_MODE_DISCRETE;
    let chanFlags = 0, chanPtrs = [];
    if ((ver & 0x20) !== 0) {
      if (p + 4 > bytes.length) break;
      const cb = u8(p);
      chanCount = (cb >>> 4) + 1;
      chanMode = cb & 0x0f;
      chanFlags = u8(p + 1) | (u8(p + 2) << 8) | (u8(p + 3) << 16);
      if (p + 4 + 4 * (chanCount - 1) > bytes.length) break;
      for (let k = 0; k < chanCount - 1; k++) chanPtrs.push(u32(p + 4 + 4 * k));
      hasChanBlock = true;
      p += 4 + 4 * (chanCount - 1);
    }
    patches.push(makeInstPatch({
      pitchStart: u16(o + 1),
      pitchEnd: u16(o + 3),
      volumeStart: u8(o + 5),
      volumeEnd: u8(o + 6),
      samplePtr: u32(o + 7),
      sampleLength: u16(o + 11),
      playStart: u16(o + 13),
      loopStart: u16(o + 15),
      loopEnd: u16(o + 17),
      samplingRate: u16(o + 19),
      sampleDetune: s16(o + 21),
      loopMode: u8(o + 23),
      defaultPan: u8(o + 24),
      defaultNoteVolume: u8(o + 25),
      vibratoSpeed: u8(o + 26),
      vibratoSweep: u8(o + 27),
      vibratoDepth: u8(o + 28),
      vibratoRate: u8(o + 29),
      vibratoWaveform: u8(o + 30),
      volEnv, volEnvLoop: volLoop, volEnvSustain: volSus,
      panEnv, panEnvLoop: panLoop, panEnvSustain: panSus,
      filterEnv: filEnv, filterEnvLoop: filLoop, filterEnvSustain: filSus,
      pitchEnv: pitEnv, pitchEnvLoop: pitLoop, pitchEnvSustain: pitSus,
      hasExtra, fadeoutStep, filterSfMode,
      extraCutoff, extraResonance, extraInitialAttenOctet: extraAttenOctet,
      hasChanBlock, chanCount, chanMode, chanFlags, chanPtrs,
    }));
    o = p;
  }
  return patches;
}

/**
 * Serialise patch objects back to the flat wire blob — the exact byte-inverse
 * of parsePatchesBlob (blocks emitted in on-wire order x, v, p, f, P, s).
 * Shared by the engine capture path (getInstrumentPatches) and the document
 * layer's Ixmp patch editor.
 */
function writePatchesBlob(patches) {
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
    if (p.hasChanBlock) ver |= 0x20;
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
    if (p.hasChanBlock) {
      const extra = Math.max(0, Math.min(15, p.chanCount - 1));
      w8(((extra & 0x0f) << 4) | (p.chanMode & 0x0f));
      w8(p.chanFlags); w8(p.chanFlags >>> 8); w8(p.chanFlags >>> 16);
      for (let k = 0; k < extra; k++) w32(p.chanPtrs[k] ?? 0);
    }
  }
  return Uint8Array.from(out);
}

/** One layer of a Metainstrument. mixOctet is the raw PSO-dB octet (159 = unity). */
function makeMetaLayer(instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd) {
  return { instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd };
}

/** Layers a 256-byte metainstrument record can hold: byte 0 flags + byte 1
 *  count + bytes 2..3 sentinel, then 10 bytes per layer. */
const META_MAX_LAYERS = 25;

/**
 * Pack a 256-byte metainstrument record — the byte-inverse of loadRecord's meta
 * branch. `layers` are makeMetaLayer shapes; layer 0 is the FOREGROUND layer and
 * the rest spawn as background children (trigger.js triggerMetaOrNote). Layers
 * beyond META_MAX_LAYERS are dropped.
 *
 * A layer child must NOT itself be a metainstrument: triggerMetaOrNote resolves
 * layers through triggerNote, which never re-enters the meta branch, so a nested
 * meta's record would be read as sample fields.
 */
function buildMetaRecord(layers, { strict = false, percussion = false } = {}) {
  const use = layers.slice(0, META_MAX_LAYERS);
  const b = new Uint8Array(256);
  // samplePtr high 16 bits = 0xFFFF is the Metainstrument sentinel; the low
  // bytes carry the flags (byte 0) and the layer count (byte 1) instead.
  b[0] = (strict ? 0x01 : 0) | (percussion ? 0x02 : 0);
  b[1] = use.length & 0xff;
  b[2] = 0xff;
  b[3] = 0xff;
  let o = 4;
  for (const l of use) {
    const idx = l.instIdx & 0x3ff;
    const det = l.detune & 0xffff; // two's complement round-trips
    b[o] = idx & 0xff;
    b[o + 1] = l.mixOctet & 0xff;
    b[o + 2] = det & 0xff;
    b[o + 3] = (det >>> 8) & 0xff;
    b[o + 4] = l.pitchStart & 0xff;
    b[o + 5] = (l.pitchStart >>> 8) & 0xff;
    b[o + 6] = l.pitchEnd & 0xff;
    b[o + 7] = (l.pitchEnd >>> 8) & 0xff;
    // Layer inst index bits 8..9 ride in the vol-start byte's top two bits.
    b[o + 8] = (l.volStart & 0x3f) | (((idx >>> 8) & 0x3) << 6);
    b[o + 9] = l.volEnd & 0x3f;
    o += 10;
  }
  return b;
}

/**
 * 256-byte instrument record (terranmon.txt:2001+). See AudioAdapter.kt:5322-5376
 * for the full byte layout. Envelopes have LOOP (always-active wrap) and SUSTAIN
 * (key-on-only wrap) words; playback priority matches schismtracker sndmix.c.
 */
class TaudInst {
  constructor(index) {
    this.index = index;

    this.samplePtr = 0;
    this.sampleLength = 0;
    this.samplingRate = 0;
    this.samplePlayStart = 0;
    this.sampleLoopStart = 0;
    this.sampleLoopEnd = 0;
    this.loopMode = 0;            // byte 14: bits 0-1 mode, bit 2 sustain, bit 4 percussion,
                                  //          bit 5 spatial azimuth MSB (#998)
    this.volEnvLoop = 0;          // bytes 15-16 (LOOP word)
    this.panEnvLoop = 0;          // bytes 17-18
    this.pfEnvLoop = 0;           // bytes 19-20
    this.instGlobalVolume = 0xff;
    this.volEnvelopes = makeEnv(0x3f);
    this.panEnvelopes = makeEnv(0x80);
    this.pfEnvelopes = makeEnv(0x80);
    this.volumeFadeoutLow = 0;
    this.fadeoutHigh = 0;
    this.volumeSwing = 0;
    this.vibratoSpeed = 0;
    this.vibratoSweep = 0;
    this.defaultPan = 0x80;
    this.pitchPanCentre = 0x5000;
    this.pitchPanSeparation = 0;
    this.panSwing = 0;
    this.defaultCutoff = 0xff;
    this.defaultResonance = 0;    // matches Kotlin secondary-ctor default order
    this.sampleDetune = 0;
    this.instrumentFlag = 0;
    this.vibratoDepth = 0;
    this.vibratoRate = 0;
    this.volEnvSustainWord = 0;
    this.panEnvSustainWord = 0;
    this.pfEnvSustainWord = 0;
    this.dupCheckFlag = 0;
    this.defaultNoteVolume = 0;   // byte 196; 0 = legacy fall back to 0x3F
    this.pf2EnvLoop = 0;          // bytes 197-198
    this.pf2EnvSustainWord = 0;   // bytes 199-200
    this.pf2Envelopes = makeEnv(0x80); // bytes 201-250

    // Reserved padding at offsets 251..255; note the Kotlin indexing quirk:
    // getByte(252..255) reads reserved[offset-251] (reserved[0] unused), and
    // defaultCutoff16/defaultResonance16 read reserved[1]/reserved[2].
    this.reserved = new Uint8Array(5);
    this.initialAttenOctet = 0;   // byte 251; 0 = unity sentinel

    // Runtime notefx 5/6 overrides (-1 = none).
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;

    // Ixmp patches (null when none uploaded).
    this.extraPatches = null;

    // Metainstrument state.
    this.metaLayers = null;
    this.metaRaw = null;          // verbatim 256-byte record for lossless capture
    this.metaStrict = false;

    // Funk repeat (S$Fx00) XOR bit-mask over the loop region.
    this.funkMask = null;

    // Sample modification (item 130, notefx 2 / 3) — ONE per instrument: the
    // opcodes are the same command, `2` inverting which side of the region is
    // touched. Start -1 = "the sounding voice's loop region"; combShift -1 =
    // solid. Only the ACTIVE operation's accumulator is ever non-zero.
    this.modOp = 0;               // MOD_OFF
    this.modInvert = false;       // notefx 2: the region is what is NOT touched
    this.modStart = -1;
    this.modEnd = -1;
    this.modComb = -1;
    this.modMask = null;          // MOD_FUNK: one bit per sample byte
    this.modRot = 0;              // MOD_ROL*: byte displacement
    this.modSub = 0;              // MOD_SUB*: running subtrahend, 0..255
    this.modOn = false;           // hot-path guard: does it change any byte yet?
  }

  get sampleLoopSustain() { return (this.loopMode & 0x04) !== 0; }
  get isPercussion() {
    return this.metaRaw !== null
      ? (this.metaRaw[0] & 0x02) !== 0
      : (this.loopMode & 0x10) !== 0;
  }
  /**
   * The instrument's default position as a 9-bit azimuth (#998): record byte
   * 177 is its LOW byte and byte 14's bit 5 (`A`) the ninth — exactly the
   * relationship `S $8xxx` has with the legacy pan byte, which is what makes
   * this backwards compatible. An old file has bit 5 clear, so its pan lands on
   * the front arc it always meant, and a stereo song reads byte 177 alone.
   */
  get defaultAzimuth() {
    return ((this.loopMode & 0x20) !== 0 ? 256 : 0) | (this.defaultPan & 0xff);
  }
  /** Default elevation (#998), record byte 254, signed. Spatial songs only. */
  get defaultElevation() {
    const b = this.reserved[3] & 0xff; // byte 254 → reserved[254 − 251]
    return b >= 0x80 ? b - 256 : b;
  }
  get nnaKeyLift() { return ((this.instrumentFlag >>> 5) & 1) !== 0; }
  /** 0=note off, 1=note cut, 2=continue, 3=note fade. */
  get newNoteAction() { return this.instrumentFlag & 0x03; }
  /** 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2). */
  get vibratoWaveform() { return (this.instrumentFlag >>> 2) & 0x07; }
  get sampleDetuneSigned() {
    const v = this.sampleDetune & 0xffff;
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  get duplicateCheckType() { return this.dupCheckFlag & 0x03; }
  get duplicateCheckAction() { return (this.dupCheckFlag >>> 2) & 0x03; }
  /** byte 173 bit 4: false = ImpulseTracker filter units, true = SoundFont. */
  get filterSfMode() { return ((this.fadeoutHigh >>> 4) & 1) !== 0; }
  get isMeta() { return this.metaLayers !== null; }

  get defaultCutoff16() {
    if (this.cutoffOverride >= 0) return this.cutoffOverride;
    return this.filterSfMode
      ? ((this.defaultCutoff & 0xff) << 8) | (this.reserved[1] & 0xff)
      : this.defaultCutoff;
  }
  get defaultResonance16() {
    if (this.resonanceOverride >= 0) return this.resonanceOverride;
    return this.filterSfMode
      ? ((this.defaultResonance & 0xff) << 8) | (this.reserved[2] & 0xff)
      : this.defaultResonance;
  }

  /** First Ixmp patch whose pitch+volume rectangle contains the trigger, else null. */
  resolvePatch(noteVal, rowVolume) {
    const patches = this.extraPatches;
    if (patches === null) return null;
    for (const p of patches) {
      if (noteVal >= p.pitchStart && noteVal <= p.pitchEnd &&
          rowVolume >= p.volumeStart && rowVolume <= p.volumeEnd) return p;
    }
    return null;
  }

  /** All meta layers whose rectangle contains the trigger, in record order. */
  resolveMetaLayers(noteVal, rowVolume) {
    const layers = this.metaLayers;
    if (layers === null) return [];
    return layers.filter(
      (l) => noteVal >= l.pitchStart && noteVal <= l.pitchEnd &&
             rowVolume >= l.volStart && rowVolume <= l.volEnd
    );
  }

  /** Load a full 256-byte record; detects the Metainstrument sentinel
   *  (samplePtr high 16 bits == 0xFFFF) and parses its layer table. */
  loadRecord(b) {
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;
    const sp = ((b[0] & 0xff) | ((b[1] & 0xff) << 8) | ((b[2] & 0xff) << 16)) + (b[3] & 0xff) * 0x1000000;
    if (((sp >>> 16) & 0xffff) === 0xffff) {
      const count = (sp >>> 8) & 0xff; // byte 1 = layer count
      const layers = [];
      let o = 4;
      for (let n = 0; n < count; n++) {
        if (o + 10 > b.length) break;
        // 10-bit layer inst index: low 8 in byte 0, bits 8..9 in bits 6..7 of vol-start (+8).
        const instIdx = (b[o] & 0xff) | (((b[o + 8] >>> 6) & 0x3) << 8);
        const mixOctet = b[o + 1] & 0xff;
        const detRaw = (b[o + 2] & 0xff) | ((b[o + 3] & 0xff) << 8);
        const detune = detRaw >= 0x8000 ? detRaw - 0x10000 : detRaw;
        const pStart = (b[o + 4] & 0xff) | ((b[o + 5] & 0xff) << 8);
        const pEnd = (b[o + 6] & 0xff) | ((b[o + 7] & 0xff) << 8);
        const vStart = b[o + 8] & 0x3f;
        const vEnd = b[o + 9] & 0x3f;
        if (instIdx >= 1 && instIdx <= 1023 && instIdx !== this.index) {
          const layer = makeMetaLayer(instIdx, mixOctet, detune, pStart, pEnd, vStart, vEnd);
          layer.rawOffset = o; // metaRaw byte offset of this layer (editors target it)
          layers.push(layer);
        }
        o += 10;
      }
      this.metaLayers = layers.length === 0 ? null : layers;
      this.metaRaw = this.metaLayers !== null ? Uint8Array.from(b.slice(0, 256)) : null;
      this.metaStrict = this.metaLayers !== null && (b[0] & 0x01) !== 0;
      this.extraPatches = null;
    } else {
      this.metaLayers = null;
      this.metaRaw = null;
      this.metaStrict = false;
      const n = Math.min(256, b.length);
      for (let i = 0; i < n; i++) this.setByte(i, b[i] & 0xff);
    }
  }

  // Funk repeat mask — sized for the loop length; stale masks are discarded.
  // `loopLen` is the SOUNDING voice's active loop length — an Ixmp patch brings
  // its own loop points, so sizing the mask off the base record would index a
  // patched voice's inversion into the wrong bytes (item 116). Defaults to the
  // base record's loop for a voice with no patch.
  toggleFunkBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    const len = Math.max(loopLen, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.funkMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.funkMask = mask;
    }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
  }

  funkBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    const mask = this.funkMask;
    if (mask === null) return false;
    const len = Math.max(loopLen, 1);
    if (mask.length !== (len + 7) >> 3) { this.funkMask = null; return false; }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    return ((mask[idx >> 3] >>> (idx & 7)) & 1) !== 0;
  }

  /**
   * Point the modification at a new region (item 130). Its accumulated state is
   * indexed against that region, so a move invalidates it. Returns whether
   * anything MOVED, which is what tells the caller to restart the walk: writing
   * the same region every row must not keep resetting it.
   */
  setModRegion(start, end, combShift) {
    if (this.modStart === start && this.modEnd === end && this.modComb === combShift) return false;
    this.modStart = start;
    this.modEnd = end;
    this.modComb = combShift;
    this.clearModState();
    return true;
  }

  /** Comb the region without moving its ends ($Fn). */
  setModComb(combShift) {
    if (this.modComb === combShift) return false;
    this.modComb = combShift;
    this.clearModState();
    return true;
  }

  /** Select the operation and which side of the region it works on. Changing
   *  either starts the new operation from scratch — a rotation offset means
   *  nothing to a subtract. */
  setModOp(op, invert) {
    if (this.modOp === op && this.modInvert === invert) return false;
    this.modOp = op;
    this.modInvert = invert;
    this.clearModState();
    return true;
  }

  /** Drop what the operation has accumulated, keeping its region. */
  clearModState() {
    this.modMask = null;
    this.modRot = 0;
    this.modSub = 0;
    this.modOn = false;
  }

  /** $x = 0 — the modification, region and all. */
  resetMod() {
    this.modOp = 0;
    this.modInvert = false;
    this.modStart = -1;
    this.modEnd = -1;
    this.modComb = -1;
    this.clearModState();
  }

  /** Flip the modification's inversion bit for sample byte `i` (MOD_FUNK). The
   *  mask spans the whole SAMPLE — an inverted region's touched set is not a
   *  contiguous span, so there is no smaller origin to index from. */
  toggleModBit(i, sampleLen) {
    const len = Math.max(sampleLen, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.modMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.modMask = mask;
    }
    const idx = Math.min(Math.max(i, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
    this.modOn = true;
  }

  modBit(i) {
    const mask = this.modMask;
    if (mask === null) return false;
    const byte = i >> 3;
    if (byte < 0 || byte >= mask.length) return false;
    return ((mask[byte] >>> (i & 7)) & 1) !== 0;
  }

  _envPointGet(env, base, offset) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    return (rel & 1) === 0 ? pt.value & 0xff : pt.offset & 0xff;
  }

  _envPointSet(env, base, offset, byte) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    if ((rel & 1) === 0) pt.value = byte;
    else pt.offset = byte & 0xff;
  }

  /** Read one record byte (0..255). Metainstruments serve verbatim metaRaw. */
  getByte(offset) {
    if (this.metaRaw !== null) return this.metaRaw[offset] & 0xff;
    return this.getByteNormal(offset);
  }

  getByteNormal(o) {
    if (o >= 21 && o <= 70) return this._envPointGet(this.volEnvelopes, 21, o);
    if (o >= 71 && o <= 120) return this._envPointGet(this.panEnvelopes, 71, o);
    if (o >= 121 && o <= 170) return this._envPointGet(this.pfEnvelopes, 121, o);
    if (o >= 201 && o <= 250) return this._envPointGet(this.pf2Envelopes, 201, o);
    if (o >= 252 && o <= 255) return this.reserved[o - 251];
    switch (o) {
      case 0: return this.samplePtr & 0xff;
      case 1: return (this.samplePtr >>> 8) & 0xff;
      case 2: return (this.samplePtr >>> 16) & 0xff;
      case 3: return (this.samplePtr >>> 24) & 0xff;
      case 4: return this.sampleLength & 0xff;
      case 5: return (this.sampleLength >>> 8) & 0xff;
      case 6: return this.samplingRate & 0xff;
      case 7: return (this.samplingRate >>> 8) & 0xff;
      case 8: return this.samplePlayStart & 0xff;
      case 9: return (this.samplePlayStart >>> 8) & 0xff;
      case 10: return this.sampleLoopStart & 0xff;
      case 11: return (this.sampleLoopStart >>> 8) & 0xff;
      case 12: return this.sampleLoopEnd & 0xff;
      case 13: return (this.sampleLoopEnd >>> 8) & 0xff;
      case 14: return this.loopMode & 0x37;
      case 15: return this.volEnvLoop & 0xff;
      case 16: return (this.volEnvLoop >>> 8) & 0xff;
      case 17: return this.panEnvLoop & 0xff;
      case 18: return (this.panEnvLoop >>> 8) & 0xff;
      case 19: return this.pfEnvLoop & 0xff;
      case 20: return (this.pfEnvLoop >>> 8) & 0xff;
      case 171: return this.instGlobalVolume & 0xff;
      case 172: return this.volumeFadeoutLow & 0xff;
      case 173: return this.fadeoutHigh & 0xff;
      case 174: return this.volumeSwing & 0xff;
      case 175: return this.vibratoSpeed & 0xff;
      case 176: return this.vibratoSweep & 0xff;
      case 177: return this.defaultPan & 0xff;
      case 178: return this.pitchPanCentre & 0xff;
      case 179: return (this.pitchPanCentre >>> 8) & 0xff;
      case 180: return this.pitchPanSeparation & 0xff;
      case 181: return this.panSwing & 0xff;
      case 182: return this.defaultCutoff & 0xff;
      case 183: return this.defaultResonance & 0xff;
      case 184: return this.sampleDetune & 0xff;
      case 185: return (this.sampleDetune >>> 8) & 0xff;
      case 186: return this.instrumentFlag & 0xff;
      case 187: return this.vibratoDepth & 0xff;
      case 188: return this.vibratoRate & 0xff;
      case 189: return this.volEnvSustainWord & 0xff;
      case 190: return (this.volEnvSustainWord >>> 8) & 0xff;
      case 191: return this.panEnvSustainWord & 0xff;
      case 192: return (this.panEnvSustainWord >>> 8) & 0xff;
      case 193: return this.pfEnvSustainWord & 0xff;
      case 194: return (this.pfEnvSustainWord >>> 8) & 0xff;
      case 195: return this.dupCheckFlag & 0xff;
      case 196: return this.defaultNoteVolume & 0xff;
      case 197: return this.pf2EnvLoop & 0xff;
      case 198: return (this.pf2EnvLoop >>> 8) & 0xff;
      case 199: return this.pf2EnvSustainWord & 0xff;
      case 200: return (this.pf2EnvSustainWord >>> 8) & 0xff;
      case 251: return this.initialAttenOctet & 0xff;
      default: throw new Error(`Bad offset ${o}`);
    }
  }

  setByte(o, byte) {
    if (o >= 21 && o <= 70) return this._envPointSet(this.volEnvelopes, 21, o, byte);
    if (o >= 71 && o <= 120) return this._envPointSet(this.panEnvelopes, 71, o, byte);
    if (o >= 121 && o <= 170) return this._envPointSet(this.pfEnvelopes, 121, o, byte);
    if (o >= 201 && o <= 250) return this._envPointSet(this.pf2Envelopes, 201, o, byte);
    if (o >= 252 && o <= 255) { this.reserved[o - 251] = byte & 0xff; return; }
    switch (o) {
      case 0: this.samplePtr = (this.samplePtr & 0xffffff00) | byte; break;
      case 1: this.samplePtr = (this.samplePtr & 0xffff00ff) | (byte << 8); break;
      case 2: this.samplePtr = (this.samplePtr & 0xff00ffff) | (byte << 16); break;
      case 3: this.samplePtr = ((this.samplePtr & 0x00ffffff) | (byte << 24)) >>> 0; break;
      case 4: this.sampleLength = (this.sampleLength & 0xff00) | byte; break;
      case 5: this.sampleLength = (this.sampleLength & 0x00ff) | (byte << 8); break;
      case 6: this.samplingRate = (this.samplingRate & 0xff00) | byte; break;
      case 7: this.samplingRate = (this.samplingRate & 0x00ff) | (byte << 8); break;
      case 8: this.samplePlayStart = (this.samplePlayStart & 0xff00) | byte; break;
      case 9: this.samplePlayStart = (this.samplePlayStart & 0x00ff) | (byte << 8); break;
      case 10: this.sampleLoopStart = (this.sampleLoopStart & 0xff00) | byte; break;
      case 11: this.sampleLoopStart = (this.sampleLoopStart & 0x00ff) | (byte << 8); break;
      case 12: this.sampleLoopEnd = (this.sampleLoopEnd & 0xff00) | byte; break;
      case 13: this.sampleLoopEnd = (this.sampleLoopEnd & 0x00ff) | (byte << 8); break;
      case 14: this.loopMode = byte & 0x37; break;
      case 15: this.volEnvLoop = (this.volEnvLoop & 0xff00) | byte; break;
      case 16: this.volEnvLoop = (this.volEnvLoop & 0x00ff) | (byte << 8); break;
      case 17: this.panEnvLoop = (this.panEnvLoop & 0xff00) | byte; break;
      case 18: this.panEnvLoop = (this.panEnvLoop & 0x00ff) | (byte << 8); break;
      case 19: this.pfEnvLoop = (this.pfEnvLoop & 0xff00) | byte; break;
      case 20: this.pfEnvLoop = (this.pfEnvLoop & 0x00ff) | (byte << 8); break;
      case 171: this.instGlobalVolume = byte & 0xff; break;
      case 172: this.volumeFadeoutLow = byte & 0xff; break;
      case 173: this.fadeoutHigh = byte & 0x1f; break; // bits 0-3 fadeout high, bit 4 SF filter mode
      case 174: this.volumeSwing = byte & 0xff; break;
      case 175: this.vibratoSpeed = byte & 0xff; break;
      case 176: this.vibratoSweep = byte & 0xff; break;
      case 177: this.defaultPan = byte & 0xff; break;
      case 178: this.pitchPanCentre = (this.pitchPanCentre & 0xff00) | byte; break;
      case 179: this.pitchPanCentre = (this.pitchPanCentre & 0x00ff) | (byte << 8); break;
      case 180: this.pitchPanSeparation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 181: this.panSwing = byte & 0xff; break;
      case 182: this.defaultCutoff = byte & 0xff; break;
      case 183: this.defaultResonance = byte & 0xff; break;
      case 184: this.sampleDetune = (this.sampleDetune & 0xff00) | byte; break;
      case 185: this.sampleDetune = (this.sampleDetune & 0x00ff) | (byte << 8); break;
      case 186: this.instrumentFlag = byte & 0xff; break;
      case 187: this.vibratoDepth = byte & 0xff; break;
      case 188: this.vibratoRate = byte & 0xff; break;
      case 189: this.volEnvSustainWord = (this.volEnvSustainWord & 0xff00) | byte; break;
      case 190: this.volEnvSustainWord = (this.volEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 191: this.panEnvSustainWord = (this.panEnvSustainWord & 0xff00) | byte; break;
      case 192: this.panEnvSustainWord = (this.panEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 193: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0xff00) | byte; break;
      case 194: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 195: this.dupCheckFlag = byte & 0x0f; break;
      case 196: this.defaultNoteVolume = byte & 0xff; break;
      case 197: this.pf2EnvLoop = (this.pf2EnvLoop & 0xff00) | byte; break;
      case 198: this.pf2EnvLoop = (this.pf2EnvLoop & 0x00ff) | (byte << 8); break;
      case 199: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0xff00) | byte; break;
      case 200: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0x00ff) | (byte << 8); break;
      case 251: this.initialAttenOctet = byte & 0xff; break;
      default: throw new Error(`Bad offset ${o}`);
    }
  }
}

// ══ src/engine/voice.js ══
// Voice + MemorySlots — port of AudioAdapter.kt:4497-4878. All fields are
// initialised in the constructor (monomorphic shape for the JIT); defaults
// match the Kotlin field initialisers exactly. Envelope point `offset` fields
// hold ThreeFiveMiniUfloat LUT indices.



/** Per-channel effect memory cohorts and private slots (TAUD_NOTE_EFFECTS.md §6). */
class MemorySlots {
  constructor() {
    this.ef = 0;        // shared E/F (pitch slide)
    this.g = 0;         // G (tone porta) private speed
    this.huSpeed = 0;   // shared H/U vibrato
    this.huDepth = 0;
    this.rSpeed = 0;    // R (tremolo)
    this.rDepth = 0;
    this.ySpeed = 0;    // Y (panbrello)
    this.yDepth = 0;
    this.d = 0;
    this.i = 0;
    this.j = 0;
    this.o = 0;
    this.q = 0;
    this.tslide = 0;
    this.w = 0;
    this.k = 0;
    this.l = 0;
    this.n = 0;
    this.p = 0;
    this.z = 0;         // Z (spherical panning slide speed, #998.2)
  }
}

function makeActiveEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * Per-channel DSP history for a multi-channel (Ixmp 's') voice — item 90.
 * Channel 1 uses the Voice's OWN fields (so the mono path is untouched); this
 * mirrors the same field names for channel 2, which is why applyVoiceFilter /
 * applyTaudVoiceFx / fetchTrackerSample can take either object as their state
 * holder. Coefficients, envelopes and pitch stay shared — only the history
 * that must not be crossed between channels lives here.
 */
class ChannelState {
  constructor() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  /** Trigger-time reset — mirrors what triggerNote does to the Voice's own. */
  reset() {
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.nesDpcmCounter = 63;
  }

  copyFrom(src) {
    this.filterY1 = src.filterY1;
    this.filterY2 = src.filterY2;
    this.filterX1 = src.filterX1;
    this.filterX2 = src.filterX2;
    this.bitcrusherCounter = src.bitcrusherCounter;
    this.bitcrusherHeld = src.bitcrusherHeld;
    this.nesDpcmCounter = src.nesDpcmCounter;
  }
}

class Voice {
  constructor() {
    this.active = false;
    // Host-owned 256-step attenuator (0 = unity, 255 = silence/mute sentinel).
    this.fader = 0;
    this.samplePos = 0.0;
    this.playbackRate = 1.0;
    // Per-sample interpolation of the pitch (item 141). playbackRate is the
    // TARGET the tick just set; currentPlaybackRate is what the sampler steps
    // by, glided toward it across the tick so a slide or a vibrato is a
    // continuous bend rather than a staircase of 50 steps a second.
    this.currentPlaybackRate = 1.0;
    this.pitchRampSamples = 0;
    this.pitchRampStep = 0.0;
    this.snapPlaybackRate = true;
    this.forward = true;
    this.instrumentId = 0;
    // Display-only: the pattern-level instrument that triggered this voice (a
    // metainstrument's SLOT, not the layer-child it resolves to) — so the
    // Timeline voice header shows the number the user sees in the pattern. No
    // Kotlin counterpart (write-only, like renderPitch).
    this.displayInst = 0;

    // -1 for live foreground voices; 0..NUM_VOICES-1 = source channel for background ghosts.
    this.sourceChannel = -1;

    // ── Stem-export taps (item 93; JS-only, never read by the DSP) ──
    // Index into inst.extraPatches of the Ixmp patch this trigger resolved to,
    // -1 = the base record. Lets the exporter put each drum of a percussion
    // instrument on its own track.
    this.activePatchIndex = -1;
    // Memoised stem routing: stemKey is the (displayInst, instrumentId,
    // activePatchIndex) triple the exporter last resolved, stemIndex its answer.
    // Declared here so the Voice shape stays monomorphic.
    this.stemKey = -1;
    this.stemIndex = -1;

    // ── Metainstrument layering ──
    this.isLayerChild = false;
    this.layerRelDetune = 0;
    // How far this layer sits from the meta's centre (layer 0), in note-axis
    // units — the pan twin of layerRelDetune, re-added by the per-tick sync so
    // the arrangement ROTATES with the note rather than collapsing (item 118).
    this.layerRelPan = 0;
    this.layerRelElevation = 0;
    this.layerMixGain = 1.0;
    this.nnaOverride = -1;
    // Per-voice envelope gates (S $77..$7E).
    this.volEnvOn = true;
    this.panEnvOn = true;
    this.pitchEnvOn = true;
    this.filterEnvOn = true;
    this.metaForeground = false;
    this.noteFading = false;

    // Two-axis volume AND pan model (TAUD_NOTE_EFFECTS.md §3). Both axes work
    // the same way on either side: the instrument seeds the NOTE axis and the
    // pattern's channel commands own the CHANNEL axis, and the two combine at
    // the mixer — volume multiplies, pan adds.
    this.noteVolume = 0x3f;
    this.channelVolume = 0x3f;
    this.rowVolume = 63;
    this.channelPan = 0x80;
    this.rowPan = 32;
    // Note-pan axis: a signed OFFSET from the channel's position, in the same
    // 512-units-to-a-turn space as panAzimuth (so on the front arc it is just a
    // pan-byte delta). 0 = neutral, which is what keeps a song that never
    // touches it rendering exactly as it did under the single-register model.
    // Seeded by the Ixmp patch's `default pan` and written by the panning
    // column; nothing else may write it.
    this.notePan = 0;
    this.noteElevation = 0.0;      // the wide panning column's elevation half

    // ── Spatial position (#998) — used only when the song is planar/spatial.
    // channelPan stays the legacy integer (and the UI's mirror); panAzimuth is
    // the continuous 512-unit angle the mixer and the Z slide work in.
    this.panAzimuth = 128.0;       // 0 = left, 128 = front, 256 = right
    this.panElevation = 0.0;       // 128 units = 90°
    this.spatialTargetAz = 128.0;  // effect 4
    this.spatialTargetEl = 0.0;
    this.spatialSlideActive = false; // armed by Z for the current row
    // Mixer-side cache of the renderer gains: {az, el, chans, renderer, gains}.
    this.spatial = null;
    // The same, for the master strip's analysis bus (item 98) — a separate slot
    // so the two buses do not invalidate each other every sample.
    this.analysisSpatial = null;

    // Anti-click volume ramp.
    this.currentMixVolume = 1.0;
    this.volRampSamples = 0;
    this.volRampStep = 0.0;
    // …and of the pan (item 141), for the same reason: the pan law is evaluated
    // per sample but every input to it moves once a tick, so a slide, a
    // panbrello or a pan envelope stepped the gain 50 times a second.
    this.currentPan = 128.0;
    this.panRampSamples = 0;
    this.panRampStep = 0.0;
    this.snapPan = true;
    this.snapMixVolume = false;

    this.keyOff = false;
    this.envIndex = 0;
    this.envTimeSec = 0.0;
    this.envVolume = 1.0;
    // Per-sample smoothed copy of envVolume (see AudioAdapter.kt:4615-4624).
    this.envVolMix = 1.0;
    this.envVolStep = 0.0;
    this.envPanIndex = 0;
    this.envPanTimeSec = 0.0;
    this.envPan = 0.5;
    this.hasPanEnv = false;

    // Pitch and filter envelopes (0.5 = unity).
    this.hasPitchEnv = false;
    this.envPitchIndex = 0;
    this.envPitchTimeSec = 0.0;
    this.envPitchValue = 0.5;
    this.hasFilterEnv = false;
    this.envFilterIndex = 0;
    this.envFilterTimeSec = 0.0;
    this.envFilterValue = 0.5;

    this.fadeoutVolume = 1.0;

    // MilkyTracker-style anti-click ramp-out.
    this.rampOutSamples = 0;
    this.rampOutGain = 0.0;
    this.rampOutStep = 0.0;

    // Volume ramp for Attack (item 139). Counts down from ATTACK_RAMP_SAMPLES to 0
    // on every fresh triggerNote(); the mixer reads it as a half-cosine fade-in gain
    // and folds it into the same per-sample rampGain the sample-end ramp-out uses.
    this.attackRampSamples = 0;

    // Auto-vibrato.
    this.autoVibPhase = 0;
    this.autoVibTicksSinceTrigger = 0;

    // Active-sample view (snapshot by applyActiveSample at trigger).
    this.activeSamplePtr = 0;
    this.activeSampleLength = 0;
    this.activeSamplePlayStart = 0;
    this.activeSampleLoopStart = 0;
    this.activeSampleLoopEnd = 0;
    this.activeSamplingRate = 0;
    this.activeSampleDetune = 0; // signed 4096-TET
    this.activeLoopMode = 0;     // bits 0-1 direction, bit 2 sustain
    this.activeVibratoSpeed = 0;
    this.activeVibratoSweep = 0;
    this.activeVibratoDepth = 0;
    this.activeVibratoRate = 0;
    this.activeVibratoWaveform = 0;
    // Multi-channel view (Ixmp 's' block, item 90). 1 = mono — the only case
    // before stereo, and the only one the base instrument can express. 2 = the
    // sample is a stereo PAIR: chanPtr2 is the right channel's pool span, which
    // shares every geometry field above (length / play-start / loop / rate).
    // chanMode 0 = discrete L,R; 1 = matrix M,S (decoded at mix time).
    this.activeChanCount = 1;
    this.activeChanMode = 0;
    this.activeChanPtr2 = 0;
    this.right = new ChannelState();

    // Active-envelope view (snapshot by resolveActiveEnvelopes at trigger).
    this.activeVolEnv = makeActiveEnv(0x3f);
    this.activeVolEnvLoop = 0;
    this.activeVolEnvSustain = 0;
    this.activePanEnv = makeActiveEnv(0x80);
    this.activePanEnvLoop = 0;
    this.activePanEnvSustain = 0;
    this.activePitchEnv = makeActiveEnv(0x80);
    this.activePitchEnvLoop = 0;
    this.activePitchEnvSustain = 0;
    this.activeFilterEnv = makeActiveEnv(0x80);
    this.activeFilterEnvLoop = 0;
    this.activeFilterEnvSustain = 0;
    this.activeFadeoutStep = 0;
    this.activeDefaultCutoff = 0xff;
    this.activeDefaultResonance = 0xff;
    // false = IT filter units (bytes), true = SoundFont (cents / centibels).
    this.filterSfMode = false;
    this.activeAttenGain = 1.0;

    // NES 2A03 DMC counter for INTERP_NES_DPCM.
    this.nesDpcmCounter = 63;

    // Filter state.
    this.currentCutoff = 0xff;
    this.currentResonance = 0xff;
    this.filterActive = false;
    // IT 2-pole IIR-only: y[n] = A0·x[n] + B0·y[n-1] + B1·y[n-2]
    this.filterA0 = 1.0;
    this.filterB0 = 0.0;
    this.filterB1 = 0.0;
    this.filterY1 = 0.0;
    this.filterY2 = 0.0;
    // SF2 RBJ biquad: y[n] = b02·(x[n]+x[n-2]) + b1·x[n-1] − a1·y[n-1] − a2·y[n-2]
    this.filterIsBiquad = false;
    this.filterBqB02 = 0.0;
    this.filterBqB1 = 0.0;
    this.filterBqA1 = 0.0;
    this.filterBqA2 = 0.0;
    this.filterX1 = 0.0;
    this.filterX2 = 0.0;
    this.filterCutoffCached = -1;
    this.filterResonanceCached = -1;

    // Per-trigger random vol/pan swing biases.
    this.randomVolBias = 0;
    this.randomPanBias = 0;

    // Pitch state (4096-TET).
    this.noteVal = 0x0000;
    this.basePitch = 0x4000;
    this.amigaPeriod = -1.0; // -1.0 = needs reseed
    this.linearFreq = -1.0;
    // JS-only display tap (no Kotlin counterpart): the last per-tick sounding
    // pitch (finalPitch — after slides/arpeggio/vibrato/pitch-env), so the
    // Timeline header can show what the voice is ACTUALLY playing per tick, not
    // just the row-triggered noteVal. Never read by the DSP.
    this.renderPitch = 0x0000;

    // Per-row effect state.
    this.rowEffect = 0;
    this.rowEffectArg = 0;
    this.slideMode = 0;
    this.slideArg = 0;
    this.tonePortaTarget = -1;
    this.tonePortaSpeed = 0;
    this.arpOff1 = 0;
    this.arpOff2 = 0;
    this.arpActive = false;
    this.lastArpVoice = 0;
    this.tremorOn = 0;
    this.tremorOnTime = 1;
    this.tremorOffTime = 1;
    this.tremorPhaseOn = true;
    this.tremorTickInPhase = 0;

    // Vibrato (H / U).
    this.vibratoActive = false;
    this.vibratoLfoPos = 0;   // 1088-step phase (lfoSampleWide), not the auto-vib 256
    this.vibratoWave = 0;
    this.vibratoRetrig = true;
    this.vibratoFineShift = 6; // 6 for H, 8 for U

    // Tremolo (R).
    this.tremoloActive = false;
    this.tremoloLfoPos = 0;
    this.tremoloWave = 0;
    this.tremoloRetrig = true;

    // Panbrello (Y). `panbrelloOffset` is a signed pan offset the mixer sums
    // alongside notePan and randomPanBias — an OFFSET rather than a write to
    // either axis, so the LFO swings around wherever the channel and the note
    // have put the voice without eating the instrument's own pan seed, and so
    // it reaches the surround path (voiceAzimuth) unchanged.
    this.panbrelloActive = false;
    this.panbrelloLfoPos = 0;
    this.panbrelloWave = 0;
    this.panbrelloRetrig = true;
    this.panbrelloOffset = 0;

    this.glissandoOn = false;

    // Q retrigger.
    this.retrigCounter = 0;
    this.retrigInterval = 0;
    this.retrigVolMod = 0;
    this.retrigActive = false;

    // Note delay (S$Dx) + its optional post-trigger action (S$Dxny, item 94;
    // JS-only so far — TSVM has no `n`/`y` handling yet, only `x`).
    this.noteDelayTick = -1;
    this.delayedNote = 0;
    this.delayedInst = 0;
    this.delayedVol = -1;
    this.noteActionTick = -1; // absolute tick-in-row for the S$Dxny follow-up ($x+$y)
    this.delayedAction = -1;  // the $n value (0..4), or -1 = none scheduled

    // Note cut (S$Cx).
    this.cutAtTick = -1;
    this.noteWasCut = false;

    // Funk repeat (S$Fx).
    this.funkSpeed = 0;
    this.funkAccumulator = 0;
    this.funkWritePos = 0;

    // Sample modification (notefx 2 / 3) — the operation and its region live on
    // the instrument; the channel only drives the speed.
    this.modSpeed = 0;
    this.modAccumulator = 0;
    this.modWritePos = 0;

    // Pattern loop (S$Bx).
    this.loopStartRow = 0;
    this.loopCount = 0;

    // Pattern ditto (effect 7).
    this.dittoActive = false;
    this.dittoSourceStart = 0;
    this.dittoLength = 0;
    this.dittoEndRow = 0;

    // Tempo slide (T $00xy).
    this.tempoSlideDir = 0;
    this.tempoSlideAmount = 0;

    // Global volume slide (W $xy00).
    this.wSlideDir = 0;
    this.wSlideAmount = 0;

    // Volume / pan column slides.
    this.volColSlideUp = 0;
    this.volColSlideDown = 0;
    // Per-tick pan slides, one pair per axis — the pan twin of nSlideDir (N,
    // channel volume) vs volColSlide* (the volume column, note volume).
    this.panColSlideRight = 0;   // the panning column's, on the note axis
    this.panColSlideLeft = 0;
    this.chanPanSlideRight = 0;  // effect P's, on the channel axis
    this.chanPanSlideLeft = 0;
    this.nSlideDir = 0;

    // Bitcrusher (8) / Overdrive (9).
    this.clipMode = 0;
    this.bitcrusherDepth = 0;
    this.bitcrusherSkip = 0;
    this.bitcrusherCounter = 0;
    this.bitcrusherHeld = 0.0;
    this.overdriveAmp = 0;

    this.mem = new MemorySlots();

    // Soundscope ring buffer (visualisation only).
    this.scopeBuffer = new Float32Array(SCOPE_BUFFER_SIZE);
    this.scopeWritePos = 0;
  }

  get activeSampleLoopSustain() { return (this.activeLoopMode & 0x04) !== 0; }
  /** True when this voice renders a stereo pair (see activeChanCount). */
  get isStereo() { return this.activeChanCount === 2; }
}

// ══ src/engine/state.js ══
// PlayCue / PlayInstruction / TaudPlayData / TrackerState / Playhead —
// port of AudioAdapter.kt:4412-4494, 4880-5208, 5210-5244.







// ── PlayInstruction (4484-4494) — tagged objects ──
const INST_NOP = 0;
const INST_GOBACK = 1;
const INST_SKIP = 2;
const INST_JUMP = 3;
const INST_PATLEN = 4;
const INST_HALTAT = 5;
const INST_HALT = 6;

const PLAY_INST_NOP = Object.freeze({ type: INST_NOP, arg: 0 });
const PLAY_INST_HALT = Object.freeze({ type: INST_HALT, arg: 0 });

/** Per-cue playback data: 64 u16 channel words (pattern | signBit<<15). */
class PlayCue {
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

function decodeInstWord(w) {
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
class TaudPlayData {
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
class TrackerState {
  constructor() {
    this.cuePos = 0;
    this.rowIndex = 0;
    this.tickInRow = 0;
    this.samplesIntoTick = 0.0;
    this.firstRow = true;
    // Always MAX_VOICES so 64-channel mode has slots for every channel, plus
    // the dedicated jam bank above them (JAM_VOICE_BASE…, item 140) — the tick
    // and mix loops run the whole array, the row loop only the channels.
    this.voices = new Array(TOTAL_VOICES);
    for (let i = 0; i < TOTAL_VOICES; i++) this.voices[i] = new Voice();

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
    // Master-strip analysis tap (item 98) — null unless a host asked for one.
    this.analysis = null;
    this.analysisTarget = ANALYSIS_OFF;

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
    this.setAnalysis(this.analysisTarget); // the tap's shape follows the model
  }

  /**
   * Install (or remove) the master-strip analysis tap (item 98). ANALYSIS_OFF
   * frees it: nothing on the render path may cost anything while the strip is
   * hidden, which is also why this is a command and not a permanent fixture.
   */
  setAnalysis(target) {
    this.analysisTarget = target;
    this.analysis = (target === ANALYSIS_OFF || target === undefined)
      ? null
      : new AnalysisTap(target, this.surroundModel);
  }

  drainInterrupts() {
    const m = this.pendingInterrupts;
    this.pendingInterrupts = 0;
    return m;
  }
}

// ── Playhead (4949-5207), tracker-mode-only port ──
// PCM mode, audio devices and MMIO byte protocol are host concerns and omitted.
class Playhead {
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

  /**
   * Silence every voice the SONG owns — the channels plus the NNA / layer
   * ghosts hanging off them — leaving the jam bank alone, so an audition held
   * across a stop keeps sounding (JS-only, item 140: the Kotlin device has no
   * jam bank and stops the lot).
   *
   * Stopping the transport only clears isPlaying: the mixer runs while
   * isPlaying or jamActive, so it switches off, but every voice stays FROZEN
   * mid-note. Whatever turns the mix back on — a jammed key — would otherwise
   * resume the whole cut-off chord along with the note actually struck, and a
   * Stop pressed while an audition rang would not stop the song at all (nothing
   * ever goes silent, so jamActive never auto-clears either). Called from both
   * ends of the transport: TaudEngine.stop and the mixer's halt-cue tail.
   *
   * `ramp` cuts through the note-cut ramp, for a mix that is still running: a
   * hard drop mid-waveform clicks. With nothing rendering, drop them outright —
   * a ramp nobody renders is just the revival deferred to the next jam.
   */
  silenceSongVoices(ramp) {
    const ts = this.trackerState;
    if (ts === null) return;
    const cut = (v) => {
      if (!v.active) return;
      if (ramp) startCutRamp(v); else v.active = false;
    };
    for (let vi = 0; vi < JAM_VOICE_BASE; vi++) cut(ts.voices[vi]);
    for (const bg of ts.backgroundVoices) {
      if (bg.sourceChannel < JAM_VOICE_BASE) cut(bg);
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
      it.currentPan = 128.0; it.panRampSamples = 0; it.panRampStep = 0.0; it.snapPan = true;
      it.snapMixVolume = false;
      it.envVolMix = 1.0;
      it.envVolStep = 0.0;
      it.channelPan = 0x80;
      it.rowPan = 32;
      it.panbrelloOffset = 0;
      it.panAzimuth = 128.0;
      it.panElevation = 0.0;
      it.notePan = 0;
      it.noteElevation = 0.0;
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
      it.modSpeed = 0;
      it.modAccumulator = 0;
      it.modWritePos = 0;
      it.fader = 0;
      it.nnaOverride = -1;
      it.volEnvOn = true; it.panEnvOn = true; it.pitchEnvOn = true; it.filterEnvOn = true;
      it.metaForeground = false;
      it.noteFading = false;
      it.layerMixGain = 1.0; it.isLayerChild = false; it.layerRelDetune = 0;
      it.layerRelPan = 0; it.layerRelElevation = 0;
      // "What's playing" state — cleared alongside the volume reset so a stale
      // instrumentId can't survive into a fresh session (AudioAdapter.kt:5130-5142).
      it.instrumentId = 0;
      it.displayInst = 0;
      it.activePatchIndex = -1; // stem tap, cleared with the rest of "what's playing"
      it.samplePos = 0.0;
      it.playbackRate = 1.0;
      it.currentPlaybackRate = 1.0;
      it.pitchRampSamples = 0; it.pitchRampStep = 0.0; it.snapPlaybackRate = true;
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
      it.attackRampSamples = 0;
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
    // Sample modifications (funk masks + notefx 2/3 regions) and notefx 5/6
    // overrides are per-instrument runtime state — clear so a replay (or song
    // loop) starts from the file defaults.
    for (const inst of this.parent.instruments) {
      inst.funkMask = null;
      inst.resetMod();
      inst.cutoffOverride = -1;
      inst.resonanceOverride = -1;
    }
  }

  /** Clear sample-modification state only (per-voice speeds + per-instrument
   *  masks, regions and rotations). */
  resetFunkState() {
    const ts = this.trackerState;
    if (ts !== null) {
      for (const it of ts.voices) {
        it.funkSpeed = 0;
        it.funkAccumulator = 0;
        it.funkWritePos = 0;
        it.modSpeed = 0;
        it.modAccumulator = 0;
        it.modWritePos = 0;
      }
    }
    for (const inst of this.parent.instruments) {
      inst.funkMask = null;
      inst.resetMod();
    }
  }
}

// ══ src/engine/sampler.js ══
// Sample fetch + interpolators + anti-click ramps — port of AudioAdapter.kt
// computePlaybackRate (1515), readSamplePoint (2211), fetchTrackerSample (2221),
// startRampOut (2341), startFastFade (2357), advanceVolumeRamp (2376).
//
// `eng` is the TaudEngine instance (carries sampleBin as a Uint8Array; playback
// addresses the 8 MB pool directly by samplePtr — banking is a device-protocol
// concern that does not exist here).




/**
 * Active-sample-aware playback rate (patch-aware via the voice snapshot).
 *
 * `tuningRatio` is the song's tuning (item 77, ts.tuningRatio) — a whole-song
 * frequency scale applied last. Concert-tuned songs pass exactly 1.0, which is
 * an identity multiply, so they render bit-for-bit as if tuning did not exist.
 */
function computePlaybackRate(voice, noteVal, tuningRatio = 1.0) {
  return (voice.activeSamplingRate / SAMPLING_RATE) *
         2 ** ((noteVal - MIDDLE_C + voice.activeSampleDetune) / 4096.0) *
         tuningRatio;
}

/**
 * Read one PCM sample (in [-1,1]) at integer index idx, honouring the
 * instrument's sample modifications — notefx 3's rotation (which moves WHICH
 * byte is read) and then the funk-repeat mask (which inverts the byte read).
 * Caller wraps loop regions first.
 * `basePtr` is the pool address of the channel being read — voice.activeSamplePtr
 * for a mono voice or the first channel of a stereo pair, voice.activeChanPtr2
 * for its right channel (both channels share the funk mask and geometry).
 *
 * Regions default to the ACTIVE loop: an Ixmp patch replaces the loop points,
 * and the funk mask is sized and indexed against whichever loop is sounding
 * (item 116). notefx 2 / 3 may point either modification somewhere else.
 */
function readSamplePoint(eng, voice, inst, idx, sampleLen, binMax,
                                basePtr = voice.activeSamplePtr) {
  let i = Math.min(Math.max(idx, 0), sampleLen - 1);
  // Sample modification (notefx 2 / 3). ONE operation is live at a time, so a
  // ROL's address transform and a FUNK/SUB's value transform never meet.
  let touched = false;
  if (inst.modOn) {
    const es = inst.modStart >= 0 ? inst.modStart : voice.activeSampleLoopStart;
    const ee = inst.modStart >= 0 ? inst.modEnd : voice.activeSampleLoopEnd;
    if (ee > es) {
      touched = modTouches(inst, i, es, ee);
      if (touched && inst.modRot !== 0) {
        // An inverted region's touched set reaches both ends of the sample, so
        // that is the span the rotation wraps in; a plain region wraps in itself.
        const ds = inst.modInvert ? 0 : es;
        const dl = inst.modInvert ? sampleLen : ee - es;
        if (dl > 1) {
          let k = (i - ds + inst.modRot) % dl;
          if (k < 0) k += dl;
          i = ds + k;
        }
      }
    }
  }
  let b = eng.sampleBin[Math.min(basePtr + i, binMax)];
  // Loop points come from the ACTIVE view: an Ixmp patch replaces them, and the
  // funk mask is sized and indexed against whichever loop is sounding (item 116).
  const ls = voice.activeSampleLoopStart;
  const le = voice.activeSampleLoopEnd;
  if (inst.funkMask !== null && le > ls) {
    if (i >= ls && i < le && inst.funkBit(i - ls, le - ls)) b = b ^ 0xff;
  }
  if (touched) {
    if (inst.modMask !== null) { if (inst.modBit(i)) b = b ^ 0xff; }
    else if (inst.modSub !== 0) b = (b - inst.modSub) & 0xff;
  }
  return (b - 127.5) / 127.5;
}

/**
 * Promote a [-1,1] PCM sample to the SNES DSP's signed 15-bit domain
 * (-4000h..+3FFFh). The gaussian's four coefficients sum to ~800h while every
 * tap is only SAR 10, so the running sum sits at ~2x the sample and stays
 * inside int16 ONLY while the input is 15-bit — feed the DSP 16-bit samples and
 * the mid-sum wrap fires on everything past half scale, folding loud waveforms
 * inside out instead of chirping on the rare hardware case. -1.0 must map to
 * exactly -16384, which is what arms the documented 801h overflow (three
 * max-negative samples read back as +3FF8h).
 */
function pcmTo15Bit(x) {
  return Math.min(Math.round(x * 16384.0), 16383);
}

/**
 * Interpolate ONE channel at the voice's current position WITHOUT advancing it.
 * `basePtr` selects the channel's pool span and `st` its DPCM counter (the
 * Voice itself for channel 1, voice.right for a stereo right channel).
 */
function interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax, basePtr, st) {
  const i0 = Math.min(Math.max(Math.trunc(voice.samplePos), 0), sampleLen - 1);
  const frac = voice.samplePos - i0;

  switch (interpMode) {
    case INTERP_DEFAULT: {
      let acc = 0.0;
      for (let j = -SINC_WIDTH; j <= SINC_WIDTH; j++) {
        const coeff = sincTap(frac, j);
        if (coeff !== 0.0) acc += readSamplePoint(eng, voice, inst, i0 + j, sampleLen, binMax, basePtr) * coeff;
      }
      return acc;
    }
    case INTERP_SNES: {
      // SNES BRR 4-tap gaussian, with the hardware's partial overflow handling
      // preserved: of the three additions the 2nd WRAPS (the gauss "chirp") and
      // only the 3rd saturates (fullsnes §snesapudspbrrpitch).
      const oldest = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 - 1, sampleLen, binMax, basePtr));
      const olders = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr));
      const olds = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 + 1, sampleLen, binMax, basePtr));
      const news = pcmTo15Bit(readSamplePoint(eng, voice, inst, i0 + 2, sampleLen, binMax, basePtr));
      const offset = Math.min(Math.max(Math.trunc(frac * 256.0), 0), 255);
      let out = (SNES_GAUSS[0xff - offset] * oldest) >> 10;
      out += (SNES_GAUSS[0x1ff - offset] * olders) >> 10;   // 1st add: cannot overflow
      out += (SNES_GAUSS[0x100 + offset] * olds) >> 10;     // 2nd add: overflows for i<0x20…
      out = (out << 16) >> 16;                              // …and the hardware lets it wrap
      out += (SNES_GAUSS[offset] * news) >> 10;             // 3rd add: saturated, not wrapped
      out = Math.min(Math.max(out, -32768), 32767);
      return (out >> 1) / 16384.0;
    }
    case INTERP_NES_DPCM: {
      // NES 2A03 DMC 1-bit sigma-delta simulation (±2 slew on a 7-bit counter).
      const target = readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
      const targetLevel = Math.min(Math.max(Math.trunc((target + 1.0) * 63.5), 0), 127);
      if (targetLevel > st.nesDpcmCounter && st.nesDpcmCounter <= 125) {
        st.nesDpcmCounter += 2;
      } else if (targetLevel < st.nesDpcmCounter && st.nesDpcmCounter >= 2) {
        st.nesDpcmCounter -= 2;
      }
      return (st.nesDpcmCounter - 63.5) / 63.5;
    }
    case INTERP_NONE:
    case INTERP_A500:
    case INTERP_A1200:
    default:
      // Paula-style ZOH; aliasing removed by the post-mix Amiga LPFs.
      return readSamplePoint(eng, voice, inst, i0, sampleLen, binMax, basePtr);
  }
}

/**
 * Fetch BOTH channels of a stereo voice at one position, then advance once —
 * the pair is one sample of one voice, so pitch, loop wrapping and the
 * sample-end ramp are shared. Writes [ch1, ch2] into `out` (a length-2 array
 * the mixer recycles). Channel meaning is the patch's chanMode: discrete L,R
 * or matrix M,S (the mixer decodes).
 */
function fetchTrackerSampleStereo(eng, voice, inst, interpMode, out) {
  if (inst.index === 0) { out[0] = 0.0; out[1] = 0.0; return out; }
  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const binMax = SAMPLE_BIN_TOTAL - 1;
  out[0] = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeSamplePtr, voice);
  out[1] = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeChanPtr2, voice.right);
  if (voice.rampOutSamples <= 0) advanceSamplePos(voice, sampleLen);
  return out;
}

function fetchTrackerSample(eng, voice, inst, interpMode) {
  if (inst.index === 0) return 0.0;

  const sampleLen = Math.max(voice.activeSampleLength, 1);
  const binMax = SAMPLE_BIN_TOTAL - 1;
  const sample = interpolateChannel(eng, voice, inst, interpMode, sampleLen, binMax,
    voice.activeSamplePtr, voice);

  // While ramping out at sample end, hold position (mixer emits with decaying gain).
  if (voice.rampOutSamples > 0) return sample;
  advanceSamplePos(voice, sampleLen);
  return sample;
}

/** Step samplePos by the playback rate and apply the loop/end rules. */
function advanceSamplePos(voice, sampleLen) {
  const loopStart = voice.activeSampleLoopStart;
  const loopEnd = Math.max(voice.activeSampleLoopEnd, 1.0);
  if (voice.forward) {
    voice.samplePos += voice.currentPlaybackRate;
    // Sustain bit set + key-off ⇒ escape the loop (loopMode 0 semantics).
    const effectiveLoopMode =
      voice.activeSampleLoopSustain && voice.keyOff ? 0 : voice.activeLoopMode & 3;
    switch (effectiveLoopMode) {
      case 0:
        if (voice.samplePos >= sampleLen) {
          voice.samplePos = Math.max(sampleLen - 1, 0.0);
          startRampOut(voice);
        }
        break;
      case 1:
        if (voice.samplePos >= loopEnd) voice.samplePos -= Math.max(loopEnd - loopStart, 1.0);
        break;
      case 2:
        if (voice.samplePos >= loopEnd) { voice.samplePos = loopEnd; voice.forward = false; }
        break;
      case 3:
        if (voice.samplePos >= sampleLen) {
          voice.samplePos = Math.max(sampleLen - 1, 0.0);
          startRampOut(voice);
        }
        break;
    }
  } else {
    voice.samplePos -= voice.currentPlaybackRate;
    if (voice.samplePos < loopStart) { voice.samplePos = loopStart; voice.forward = true; }
  }
}

/** Engage a linear ramp to silence over `samples`, and stop there. No-op if one
 *  is already running — a voice that is already fading does not restart. */
function beginRampOut(voice, samples) {
  if (voice.rampOutSamples > 0) return;
  voice.rampOutSamples = samples;
  voice.rampOutGain = 1.0;
  voice.rampOutStep = 1.0 / samples;
}

/** Engage the MilkyTracker-style sample-end ramp (no-op if already ramping). */
function startRampOut(voice) {
  beginRampOut(voice, RAMP_OUT_SAMPLES);
}

/**
 * Note-cut ramp (note word 0x0002, and S $Dxny's $n=1). A cut used to drop
 * `active` on the spot, so a cut landing mid-cycle stepped straight to zero and
 * clicked — audible on anything with body to it.
 *
 * The ramp is the ATTACK one's 32 samples (~0.67 ms at 48 kHz), not the 8 ms
 * sample-end ramp: a cut is a rhythmic event, often on a fast row, and 8 ms
 * would round off the very transient the cut is being used to place. Short
 * enough to still read as a cut, long enough to have no edge in it.
 *
 * Note the sample position FREEZES while ramping (see the caller of
 * advanceSamplePos), so this is the last sample held and faded rather than
 * playback continuing under a fade — which is what the sample-end ramp does
 * too, and over 32 samples the difference is inaudible.
 */
function startCutRamp(voice) {
  beginRampOut(voice, ATTACK_RAMP_SAMPLES);
}

/** Fast note-fade (note word 0x0004 — SF2 exclusiveClass choke, ≈0.3 s). */
function startFastFade(voice, playhead) {
  if (!voice.active) return;
  voice.noteFading = true;
  const ticks = Math.max(FAST_FADE_SEC * playhead.bpm * 0.4, 1.0);
  voice.activeFadeoutStep = Math.min(Math.max(Math.round(1024.0 / ticks), 1), 0xfff);
}

/**
 * Per-sample pitch glide toward the tick's playbackRate, spread over one tick
 * (`spt` samples) so the control signal is INTERPOLATED rather than stepped.
 * A fresh trigger snaps: a new note starts at its own pitch, it does not bend
 * up from whatever the channel was last playing.
 */
function advancePitchRamp(voice, spt) {
  const target = voice.playbackRate;
  if (voice.snapPlaybackRate) {
    voice.currentPlaybackRate = target;
    voice.pitchRampSamples = 0;
    voice.pitchRampStep = 0.0;
    voice.snapPlaybackRate = false;
    return;
  }
  if (voice.pitchRampSamples > 0) {
    voice.currentPlaybackRate += voice.pitchRampStep;
    voice.pitchRampSamples--;
    if (voice.pitchRampSamples === 0) voice.currentPlaybackRate = target;
  } else if (voice.currentPlaybackRate !== target) {
    const n = spt >= 1 ? Math.round(spt) : 1;
    voice.pitchRampStep = (target - voice.currentPlaybackRate) / n;
    voice.pitchRampSamples = n - 1;
    voice.currentPlaybackRate += voice.pitchRampStep;
  }
}

/**
 * Per-sample pan ramp toward `target` (0..255), the sibling of the volume ramp
 * and over the same 2 ms. Ramping the PAN rather than the two gains means one
 * ramp covers everything that moves it — the slide, the panbrello, the pan
 * envelope, the pan column and S $80xx all feed this one number.
 *
 * Returns the value to use this sample.
 */
function advancePanRamp(voice, target, wrap = false) {
  // A surround azimuth WRAPS at AZIMUTH_TURN (512 units, the 9-bit S $8xxx
  // circle — NOT the stereo pan's 256): ramping 500 -> 12 the arithmetic way
  // would sweep the long way round the whole circle. Take the short way.
  if (wrap && !voice.snapPan) {
    const d = target - voice.currentPan;
    if (d > 256) voice.currentPan += 512;
    else if (d < -256) voice.currentPan -= 512;
  }
  if (voice.snapPan) {
    voice.currentPan = target;
    voice.panRampSamples = 0;
    voice.panRampStep = 0.0;
    voice.snapPan = false;
    return target;
  }
  if (voice.panRampSamples > 0) {
    voice.currentPan += voice.panRampStep;
    voice.panRampSamples--;
    if (voice.panRampSamples === 0) voice.currentPan = target;
  } else if (voice.currentPan !== target) {
    voice.panRampStep = (target - voice.currentPan) / VOL_RAMP_SAMPLES;
    voice.panRampSamples = VOL_RAMP_SAMPLES - 1;
    voice.currentPan += voice.panRampStep;
  }
  if (wrap) {
    if (voice.currentPan < 0) voice.currentPan += 512;
    else if (voice.currentPan >= 512) voice.currentPan -= 512;
  }
  return voice.currentPan;
}

/** Per-sample volume-ramp tick toward (rowVolume/max)·(channelVolume/max).
 *  `div` is the volume column's ceiling: 63 as ever, 255 for a wide cell. */
function advanceVolumeRamp(voice, div = 63.0) {
  const target = (voice.rowVolume / div) * (voice.channelVolume / div);
  if (voice.snapMixVolume) {
    voice.currentMixVolume = target;
    voice.volRampSamples = 0;
    voice.volRampStep = 0.0;
    voice.snapMixVolume = false;
    return;
  }
  if (voice.volRampSamples > 0) {
    voice.currentMixVolume += voice.volRampStep;
    voice.volRampSamples--;
    if (voice.volRampSamples === 0) voice.currentMixVolume = target;
  } else if (voice.currentMixVolume !== target) {
    voice.volRampStep = (target - voice.currentMixVolume) / VOL_RAMP_SAMPLES;
    voice.volRampSamples = VOL_RAMP_SAMPLES - 1;
    voice.currentMixVolume += voice.volRampStep;
  }
}

// ══ src/engine/filter.js ══
// Per-voice filters + Taud voice FX — port of AudioAdapter.kt refreshVoiceFilter
// (2001), applyVoiceFilter (2071), applyTaudVoiceFx (2101), clipSample (2141).
//
// TWO topologies, both mandatory:
//  - IT/tracker path: all-pole 2-pole resonant LPF (reference_materials/
//    tracker_filter/) — NO feedforward terms; byte-faithful for tracker playback.
//  - filterSfMode path: FluidSynth's RBJ biquad (reference_materials/fluidsynth/)
//    with cents→Hz cutoff, −3.01 dB Butterworth Q offset and 1/√Q gain-norm.


/** Recompute filter coefficients when cutoff/resonance changed since last refresh. */
function refreshVoiceFilter(voice) {
  const cut = voice.currentCutoff;
  const res = voice.currentResonance;
  if (cut === voice.filterCutoffCached && res === voice.filterResonanceCached) return;
  voice.filterCutoffCached = cut;
  voice.filterResonanceCached = res;

  const nyquist = SAMPLING_RATE * 0.5 - 1.0;
  if (voice.filterSfMode) {
    // SoundFont mode: cutoff = absolute cents, resonance = centibels above DC gain.
    if (cut >= 0xffff) { voice.filterActive = false; return; }
    const fres = Math.min(Math.max(8.176 * 2 ** (cut / 1200.0), 5.0), 0.45 * SAMPLING_RATE);

    // SF2 Q (cB) → linear, with FluidSynth's −3.01 dB offset (Q=0 cB ⇒ Butterworth).
    const qcb = res >= 0xffff ? 0 : res;
    const qDb = Math.min(Math.max(qcb / 10.0, 0.0), 96.0) - 3.01;
    const qLin = Math.max(10 ** (qDb / 20.0), 0.001);

    // RBJ cookbook low-pass, normalised to a0; SF2 §2.01 p.59 1/√Q gain-norm.
    const omega = (2.0 * Math.PI * fres) / SAMPLING_RATE;
    const sinC = Math.sin(omega);
    const cosC = Math.cos(omega);
    const alpha = sinC / (2.0 * qLin);
    const a0inv = 1.0 / (1.0 + alpha);
    const gain = a0inv / Math.sqrt(qLin);
    voice.filterBqB1 = (1.0 - cosC) * gain;
    voice.filterBqB02 = voice.filterBqB1 * 0.5;
    voice.filterBqA1 = -2.0 * cosC * a0inv;
    voice.filterBqA2 = (1.0 - alpha) * a0inv;
    voice.filterIsBiquad = true;
    voice.filterActive = true;
    return;
  }

  if (Math.min(Math.max(cut, 0), 255) >= 255) { voice.filterActive = false; return; }
  const itCutoff = Math.min(Math.max(cut, 0), 254) * 0.5; // 0..127
  const itResonance = res >= 255 ? 0.0 : Math.min(Math.max(res, 0), 254) * 0.5;
  const frequency = Math.min(110.0 * 2 ** (itCutoff / 24.0 + 0.25), nyquist);
  const dmpfac = 10 ** ((-itResonance * (24.0 / 128.0)) / 20.0);

  const r = SAMPLING_RATE / (2.0 * Math.PI * frequency);
  const d = dmpfac * r + dmpfac - 1.0;
  const e = r * r;
  const denom = 1.0 + d + e;

  voice.filterA0 = 1.0 / denom;
  voice.filterB0 = (d + e + e) / denom;
  voice.filterB1 = -e / denom;
  voice.filterIsBiquad = false;
  voice.filterActive = true;
}

/**
 * Apply the cached voice low-pass to one sample. Coefficients come from the
 * voice; the delay line comes from `st`, which is the voice itself for a mono
 * voice (or a stereo pair's first channel) and voice.right for the second
 * channel of a stereo pair — same coefficients, independent history.
 */
function applyVoiceFilter(voice, x0, st = voice) {
  if (!voice.filterActive) return x0;
  if (voice.filterIsBiquad) {
    // FluidSynth RBJ biquad, Direct Form I (unclamped — the SF2 gain-norm bounds it).
    const y0 = voice.filterBqB02 * (x0 + st.filterX2) +
               voice.filterBqB1 * st.filterX1 -
               voice.filterBqA1 * st.filterY1 -
               voice.filterBqA2 * st.filterY2;
    st.filterX2 = st.filterX1;
    st.filterX1 = x0;
    st.filterY2 = st.filterY1;
    st.filterY1 = y0;
    return y0;
  }
  // IT all-pole recurrence; history taps clipped ±2.0 (OpenMPT ClipFilter).
  const y1Clipped = Math.min(Math.max(st.filterY1, -2.0), 2.0);
  const y2Clipped = Math.min(Math.max(st.filterY2, -2.0), 2.0);
  const y0 = voice.filterA0 * x0 + voice.filterB0 * y1Clipped + voice.filterB1 * y2Clipped;
  st.filterY2 = st.filterY1;
  st.filterY1 = y0;
  return y0;
}

/** Shared clipper for effects 8/9: 0 clamp, 1 fold (triangle), 2 wrap (sawtooth). */
function clipSample(x, mode) {
  switch (mode & 3) {
    case 1: {
      let v = x;
      while (v > 1.0) v = 2.0 - v;
      while (v < -1.0) v = -2.0 - v;
      return v;
    }
    case 2: {
      let v = (x + 1.0) % 2.0;
      if (v < 0.0) v += 2.0;
      return v - 1.0;
    }
    default:
      return Math.min(Math.max(x, -1.0), 1.0);
  }
}

/** Overdrive (9) → shared clipper → bitcrusher (8): per output sample, per voice.
 *  `st` holds the crusher's hold/counter state (voice.right for a stereo pair's
 *  second channel) — the parameters themselves are always the voice's. */
function applyTaudVoiceFx(voice, sample, st = voice) {
  let s = sample;
  const overdriveOn = voice.overdriveAmp > 0;
  const depthQuantises = voice.bitcrusherDepth >= 1 && voice.bitcrusherDepth <= 7;
  const skipActive = voice.bitcrusherSkip > 0;
  const crushActive = depthQuantises || skipActive;

  if (overdriveOn) {
    s *= (16 + voice.overdriveAmp) / 16.0;
    s = clipSample(s, voice.clipMode);
  }

  if (crushActive) {
    if (st.bitcrusherCounter === 0) {
      if (depthQuantises) {
        const levels = (1 << voice.bitcrusherDepth) - 1;
        const clipped = Math.min(Math.max(clipSample(s, voice.clipMode), -1.0), 1.0);
        const q = Math.min(Math.max(Math.floor((clipped + 1.0) * 0.5 * levels + 0.5), 0.0), levels);
        s = (q / levels) * 2.0 - 1.0;
      }
      st.bitcrusherHeld = s;
    } else {
      s = st.bitcrusherHeld;
    }
    if (skipActive) {
      st.bitcrusherCounter = (st.bitcrusherCounter + 1) % (voice.bitcrusherSkip + 1);
    } else {
      st.bitcrusherCounter = 0;
    }
  }
  return s;
}

// ══ src/engine/envelope.js ══
// Envelope walkers — port of AudioAdapter.kt resolveEnvWrap (1708), envPresent
// (1728), applyKeyLift (1755), advanceEnvelope (1768), advancePfRole (1881),
// seedPfRole (1945), advancePitchEnvelope (1951), advanceFilterEnvelope (1960),
// advanceAutoVibrato (2166).
//
// Envelope point offsets are ThreeFiveMiniUfloat LUT indices; read seconds via
// minifloatToDouble. CRITICAL semantics carried over:
//  - advancePfRole SKIPS zero-duration nodes (instant transitions), stopping at
//    a sustain/loop boundary or maxIdx.
//  - seedPfRole settles the note-on seed past leading zero-duration nodes.
//  - the vol/pan walker (advanceEnvelope) FREEZES on zero-offset nodes — IT
//    terminator semantics — and is NOT seeded that way.




/**
 * Resolve the active wrap region from LOOP and SUSTAIN words + key state.
 * LOOP word: 0b0000_0sss_ssXcb_eeeee; SUSTAIN word: 0b0000_0sss_ss00b_eeeee.
 * bit 5 = enable; bits 12..8 = start, bits 4..0 = end. Priority matches
 * schismtracker player/sndmix.c:480-499. outRange[1] = -1 when no wrap.
 */
function resolveEnvWrap(loopWord, sustainWord, keyOff, outRange) {
  const susB = ((sustainWord >>> 5) & 1) !== 0;
  const loopB = ((loopWord >>> 5) & 1) !== 0;
  if (susB && !keyOff) {
    outRange[0] = (sustainWord >>> 8) & 0x1f;
    outRange[1] = sustainWord & 0x1f;
  } else if (loopB) {
    outRange[0] = (loopWord >>> 8) & 0x1f;
    outRange[1] = loopWord & 0x1f;
  } else {
    outRange[0] = -1;
    outRange[1] = -1;
  }
}

/** Envelope-present test — the P bit at LOOP word bit 13. */
function envPresent(loopWord) {
  return ((loopWord >>> 13) & 1) !== 0;
}

// Reusable scratch (allocation-free per-tick walks; single-threaded per worklet).
const volWrap = new Int32Array(2);
const panWrap = new Int32Array(2);
const pfWrap = new Int32Array(2);
const pfIdxBox = new Int32Array(1);
const pfTimeBox = new Float64Array(1);

/** Jump the volume envelope playhead straight to the sustain-end node, so the
 *  release nodes play immediately instead of walking the remaining pre-sustain
 *  nodes first. The shared core of applyKeyLift (gated) and forceKeyLift
 *  (unconditional). Reads the ACTIVE (patch-or-base) envelope. */
function jumpToSustainEnd(voice) {
  const sus = voice.activeVolEnvSustain;
  if (((sus >>> 5) & 1) === 0) return;
  const susEnd = sus & 0x1f;
  if (voice.envIndex >= susEnd) return;
  voice.envIndex = susEnd;
  voice.envTimeSec = 0.0;
  voice.envVolume = Math.min(Math.max(voice.activeVolEnv[susEnd].value / 63.0, 0.0), 1.0);
}

/**
 * "Key Lift" (instrument flag bit 5): MIDI-exact key release — jump the volume
 * envelope playhead straight to the sustain-end node on key-off so the release
 * nodes play immediately. Applies wherever key-off is delivered: pattern
 * KEY_OFF (0x0001), the NNA ghost spawned on a new note, DCA Note Off, and
 * past-note S $71 (terranmon.txt instrument-flag byte 186).
 */
function applyKeyLift(voice, inst) {
  if (!inst.nnaKeyLift) return;
  jumpToSustainEnd(voice);
}

/** S $Dxny's $n=4 "Key lift" follow-up action (item 94): forces the same
 *  sustain-end jump as applyKeyLift but bypasses the instrument's own Key
 *  Lift flag — a per-note override, same spirit as S $73..$76's per-voice
 *  NNA override. Distinct from $n=0 "Note off", which respects the flag. */
function forceKeyLift(voice) {
  jumpToSustainEnd(voice);
}

/** Volume + pan envelope advance (once per tick). */
function advanceEnvelope(voice, tickSec) {
  const maxIdx = 24;

  // Volume envelope — gated only by voice.volEnvOn; wrap bits gate WRAPPING,
  // not whether the envelope runs (Schism player/sndmix.c:470-502).
  const volEnv = voice.activeVolEnv;
  if (voice.volEnvOn) {
    resolveEnvWrap(voice.activeVolEnvLoop, voice.activeVolEnvSustain, voice.keyOff, volWrap);
    const wStart = volWrap[0];
    const wEnd = volWrap[1];
    const wrapping = wStart >= 0;

    if (wrapping && voice.envIndex === wEnd && wStart === wEnd) {
      // Hold at the wrap point (FT2 single-point sustain).
      voice.envVolume = Math.min(Math.max(volEnv[voice.envIndex].value / 63.0, 0.0), 1.0);
    } else if (wrapping && voice.envIndex === wEnd) {
      voice.envTimeSec = 0.0;
      voice.envIndex = wStart;
      voice.envVolume = Math.min(Math.max(volEnv[voice.envIndex].value / 63.0, 0.0), 1.0);
    } else if (voice.envIndex >= maxIdx) {
      const vEnd = volEnv[maxIdx].value;
      voice.envVolume = Math.min(Math.max(vEnd / 63.0, 0.0), 1.0);
      // Schism's "envelope-end + last-value-0 ⇒ cut" rule — fall-through only.
      if (vEnd === 0 && !wrapping) startRampOut(voice);
    } else {
      const vOffset = minifloatToDouble(volEnv[voice.envIndex].offset);
      const vCurValue = volEnv[voice.envIndex].value;
      if (vOffset === 0.0) {
        // Reached a terminator point — envelope holds here (IT semantics).
        voice.envVolume = Math.min(Math.max(vCurValue / 63.0, 0.0), 1.0);
        if (vCurValue === 0 && !wrapping) startRampOut(voice);
      } else {
        voice.envTimeSec += tickSec;
        if (voice.envTimeSec >= vOffset) {
          voice.envTimeSec -= vOffset;
          const nextIdx = wrapping && voice.envIndex === wEnd
            ? wStart
            : Math.min(voice.envIndex + 1, maxIdx);
          voice.envIndex = nextIdx;
          voice.envVolume = Math.min(Math.max(volEnv[voice.envIndex].value / 63.0, 0.0), 1.0);
        } else {
          const cur = Math.min(Math.max(vCurValue / 63.0, 0.0), 1.0);
          const nxt = Math.min(
            Math.max(volEnv[Math.min(voice.envIndex + 1, maxIdx)].value / 63.0, 0.0), 1.0);
          voice.envVolume = cur + (nxt - cur) * (voice.envTimeSec / vOffset);
        }
      }
    }
  }

  // Pan envelope.
  if (!voice.hasPanEnv || !voice.panEnvOn) return;
  const panEnv = voice.activePanEnv;
  resolveEnvWrap(voice.activePanEnvLoop, voice.activePanEnvSustain, voice.keyOff, panWrap);
  const pStart = panWrap[0];
  const pEnd = panWrap[1];
  const pWrapping = pStart >= 0;

  if (pWrapping && voice.envPanIndex === pEnd && pStart === pEnd) {
    voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
  } else if (pWrapping && voice.envPanIndex === pEnd) {
    voice.envPanTimeSec = 0.0;
    voice.envPanIndex = pStart;
    voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
  } else if (voice.envPanIndex >= maxIdx) {
    voice.envPan = panEnv[maxIdx].value / 255.0;
  } else {
    const pOffset = minifloatToDouble(panEnv[voice.envPanIndex].offset);
    if (pOffset === 0.0) {
      voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
    } else {
      voice.envPanTimeSec += tickSec;
      if (voice.envPanTimeSec >= pOffset) {
        voice.envPanTimeSec -= pOffset;
        const nextIdx = pWrapping && voice.envPanIndex === pEnd
          ? pStart
          : Math.min(voice.envPanIndex + 1, maxIdx);
        voice.envPanIndex = nextIdx;
        voice.envPan = panEnv[voice.envPanIndex].value / 255.0;
      } else {
        const cur = panEnv[voice.envPanIndex].value / 255.0;
        const nxt = panEnv[Math.min(voice.envPanIndex + 1, maxIdx)].value / 255.0;
        voice.envPan = cur + (nxt - cur) * (voice.envPanTimeSec / pOffset);
      }
    }
  }
}

/**
 * Generic 25-node envelope walk shared by pitch and filter envelopes.
 * Returns the new value (0..1, 0.5 = unity); advanced index/time via
 * idxBox[0] / timeBox[0]. MUST skip zero-duration nodes (instant transitions),
 * not freeze on them — see the AudioAdapter.kt:1899-1907 rationale.
 */
function advancePfRole(env, loopWord, susWord, keyOff, tickSec, wrapScratch, idxBox, timeBox) {
  const maxIdx = 24;
  resolveEnvWrap(loopWord, susWord, keyOff, wrapScratch);
  const susStart = wrapScratch[0];
  const susEnd = wrapScratch[1];
  const susOn = susStart >= 0;
  let idx = idxBox[0];
  if (susOn && idx === susEnd && susStart === susEnd) {
    return env[idx].value / 255.0;
  } else if (susOn && idx === susEnd) {
    timeBox[0] = 0.0;
    idx = susStart;
    idxBox[0] = idx;
    return env[idx].value / 255.0;
  } else if (idx >= maxIdx) {
    return env[maxIdx].value / 255.0;
  } else {
    while (idx < maxIdx && !(susOn && idx === susEnd) && minifloatToDouble(env[idx].offset) === 0.0) {
      idx++;
    }
    if (susOn && idx === susEnd) {
      if (susStart !== susEnd) { timeBox[0] = 0.0; idx = susStart; }
      idxBox[0] = idx;
      return env[idx].value / 255.0;
    }
    idxBox[0] = idx;
    if (idx >= maxIdx) {
      return env[maxIdx].value / 255.0;
    }
    const offset = minifloatToDouble(env[idx].offset);
    timeBox[0] += tickSec;
    if (timeBox[0] >= offset) {
      timeBox[0] -= offset;
      idx = Math.min(idx + 1, maxIdx);
      idxBox[0] = idx;
      return env[idx].value / 255.0;
    }
    const cur = env[idx].value / 255.0;
    const nxt = env[Math.min(idx + 1, maxIdx)].value / 255.0;
    return cur + (nxt - cur) * (timeBox[0] / offset);
  }
}

/** Seed a pf-envelope playhead at note-on, settling past leading zero-duration
 *  nodes. The settled index + time carry are left in pfIdxBox[0] / pfTimeBox[0]. */
function seedPfRole(env, loopWord, susWord) {
  pfIdxBox[0] = 0;
  pfTimeBox[0] = 0.0;
  return advancePfRole(env, loopWord, susWord, false, 0.0, pfWrap, pfIdxBox, pfTimeBox);
}

/** Advance the pitch envelope (drives playback rate; 0.5 = unity). */
function advancePitchEnvelope(voice, tickSec) {
  if (!voice.hasPitchEnv || !voice.pitchEnvOn) return;
  pfIdxBox[0] = voice.envPitchIndex;
  pfTimeBox[0] = voice.envPitchTimeSec;
  voice.envPitchValue = advancePfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
    voice.activePitchEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox);
  voice.envPitchIndex = pfIdxBox[0];
  voice.envPitchTimeSec = pfTimeBox[0];
}

/** Advance the filter envelope (drives cutoff; 0.5 = unity). */
function advanceFilterEnvelope(voice, tickSec) {
  if (!voice.hasFilterEnv || !voice.filterEnvOn) return;
  pfIdxBox[0] = voice.envFilterIndex;
  pfTimeBox[0] = voice.envFilterTimeSec;
  voice.envFilterValue = advancePfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
    voice.activeFilterEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox);
  voice.envFilterIndex = pfIdxBox[0];
  voice.envFilterTimeSec = pfTimeBox[0];
}

/**
 * IT-style auto-vibrato: returns a 4096-TET pitch delta for the current tick
 * and advances the LFO phase. Reads the voice's active-sample snapshot
 * (patch-aware); [inst] retained in the signature for callsite continuity.
 */
function advanceAutoVibrato(voice, inst) {
  const depth0 = voice.activeVibratoDepth;
  if (depth0 === 0 || voice.activeVibratoSpeed === 0) return 0;

  // FT2 vibratoSweep = "ticks to fully ramp"; IT vibratoRate = ramp acceleration.
  const ftSweep = voice.activeVibratoSweep;
  const itRate = voice.activeVibratoRate;
  const t = voice.autoVibTicksSinceTrigger;
  let rampDepth;
  if (ftSweep !== 0) rampDepth = Math.min(Math.trunc((depth0 * t) / ftSweep), depth0);
  else if (itRate !== 0) rampDepth = Math.min((t * itRate) >>> 8, depth0);
  else rampDepth = depth0;
  voice.autoVibTicksSinceTrigger++;

  // 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (negated ramp-down).
  const wave = voice.activeVibratoWaveform;
  const rawSample = wave === 4 ? -lfoSample(voice.autoVibPhase, 1)
                               : lfoSample(voice.autoVibPhase, wave & 3);
  const pitchDelta = (rawSample * rampDepth) >> 10;
  voice.autoVibPhase = (voice.autoVibPhase + voice.activeVibratoSpeed * 2) & 0xff;
  return pitchDelta;
}

// ══ src/engine/trigger.js ══
// Trigger path + NNA/Metainstrument machinery — port of AudioAdapter.kt
// applyActiveSample (1529), resolveActiveEnvelopes (1574), attenGainOf (1629),
// rowVolumeFromDefault (2413), capBackgroundVoices (2421), release/cutLayerChildren
// (2431/2445), triggerMetaOrNote (2469), triggerNote (2524), applyDuplicateCheck
// (2693), maybeSpawnBackgroundForNNA (2748), ghostVoice (2768),
// applyPastNoteAction (2887), applyVolColumn (2905), applyPanColumn (2927).









/**
 * Scratch out-box for triggerNote: [notePan, noteElevation, present] as the
 * INSTRUMENT left them for the trigger just run — `present` is 0 when the
 * instrument said nothing about panning at all. Only triggerMetaOrNote reads
 * it, immediately after each triggerNote call, to measure a layer's offset
 * from layer 0's (item 118). Same one-shot-box idiom as envelope.js's
 * pfIdxBox / pfTimeBox, and for the same reason: no per-voice field for a
 * value nothing keeps.
 */
const notePanSeedBox = new Float64Array(3);

/**
 * Snapshot the sample-scope state for voice from the base instrument or a
 * resolved Ixmp patch. Patch sentinels: defaultPan 0xFF, defaultNoteVolume 0,
 * vibratoWaveform 0xFF defer to the base instrument.
 */
function applyActiveSample(voice, inst, patch) {
  // Stem-export tap (item 93): which patch sounded. indexOf runs once per
  // trigger over a handful of patches; nothing in the DSP reads it back.
  voice.activePatchIndex =
    patch === null || inst.extraPatches === null ? -1 : inst.extraPatches.indexOf(patch);
  if (patch === null) {
    voice.activeSamplePtr = inst.samplePtr;
    voice.activeSampleLength = inst.sampleLength;
    voice.activeSamplePlayStart = inst.samplePlayStart;
    voice.activeSampleLoopStart = inst.sampleLoopStart;
    voice.activeSampleLoopEnd = inst.sampleLoopEnd;
    voice.activeSamplingRate = inst.samplingRate;
    voice.activeSampleDetune = inst.sampleDetuneSigned;
    voice.activeLoopMode = inst.loopMode;
    voice.activeVibratoSpeed = inst.vibratoSpeed;
    voice.activeVibratoSweep = inst.vibratoSweep;
    voice.activeVibratoDepth = inst.vibratoDepth;
    voice.activeVibratoRate = inst.vibratoRate;
    voice.activeVibratoWaveform = inst.vibratoWaveform;
    // A base instrument record has no channel block: always mono.
    voice.activeChanCount = 1;
    voice.activeChanMode = 0;
    voice.activeChanPtr2 = 0;
  } else {
    voice.activeSamplePtr = patch.samplePtr;
    voice.activeSampleLength = patch.sampleLength;
    voice.activeSamplePlayStart = patch.playStart;
    voice.activeSampleLoopStart = patch.loopStart;
    voice.activeSampleLoopEnd = patch.loopEnd;
    voice.activeSamplingRate = patch.samplingRate;
    voice.activeSampleDetune = patch.sampleDetune;
    voice.activeLoopMode = patch.loopMode;
    voice.activeVibratoSpeed = patch.vibratoSpeed;
    voice.activeVibratoSweep = patch.vibratoSweep;
    voice.activeVibratoDepth = patch.vibratoDepth;
    voice.activeVibratoRate = patch.vibratoRate;
    voice.activeVibratoWaveform =
      patch.vibratoWaveform === 0xff ? inst.vibratoWaveform : patch.vibratoWaveform;
    // Ixmp 's' block (item 90). Only the stereo case is rendered; a patch with
    // more channels (quad / ambisonic — TODO #998) plays its first channel as
    // mono rather than guessing a downmix.
    if (patchIsStereo(patch)) {
      voice.activeChanCount = 2;
      voice.activeChanMode = patch.chanMode;
      voice.activeChanPtr2 = patch.chanPtrs[0];
    } else {
      voice.activeChanCount = 1;
      voice.activeChanMode = 0;
      voice.activeChanPtr2 = 0;
    }
  }
  resolveActiveEnvelopes(voice, inst, patch);
}

/**
 * Snapshot the active vol/pan/pitch/filter envelopes + fadeout/cutoff/resonance
 * scalars onto voice, from the base instrument or a resolved Ixmp patch. The
 * base instrument's two pf-env slots are routed by their m-bit (LOOP bit 7:
 * 0 = pitch, 1 = filter); a patch's 'P'/'f' blocks override the matching role.
 */
function resolveActiveEnvelopes(voice, inst, patch) {
  const volEnv = patch !== null ? patch.volEnv : null;
  if (volEnv !== null) {
    voice.activeVolEnv = volEnv;
    voice.activeVolEnvLoop = patch.volEnvLoop;
    voice.activeVolEnvSustain = patch.volEnvSustain;
  } else {
    voice.activeVolEnv = inst.volEnvelopes;
    voice.activeVolEnvLoop = inst.volEnvLoop;
    voice.activeVolEnvSustain = inst.volEnvSustainWord;
  }
  const panEnv = patch !== null ? patch.panEnv : null;
  if (panEnv !== null) {
    voice.activePanEnv = panEnv;
    voice.activePanEnvLoop = patch.panEnvLoop;
    voice.activePanEnvSustain = patch.panEnvSustain;
  } else {
    voice.activePanEnv = inst.panEnvelopes;
    voice.activePanEnvLoop = inst.panEnvLoop;
    voice.activePanEnvSustain = inst.panEnvSustainWord;
  }

  let pitEnv = inst.pfEnvelopes, pitLoop = 0, pitSus = 0, pitOn = false;
  let filEnv = inst.pfEnvelopes, filLoop = 0, filSus = 0, filOn = false;
  // base slot 1 (bytes 19..)
  if (envPresent(inst.pfEnvLoop)) {
    if (((inst.pfEnvLoop >>> 7) & 1) !== 0) {
      filEnv = inst.pfEnvelopes; filLoop = inst.pfEnvLoop; filSus = inst.pfEnvSustainWord; filOn = true;
    } else {
      pitEnv = inst.pfEnvelopes; pitLoop = inst.pfEnvLoop; pitSus = inst.pfEnvSustainWord; pitOn = true;
    }
  }
  // base slot 2 (bytes 197..)
  if (envPresent(inst.pf2EnvLoop)) {
    if (((inst.pf2EnvLoop >>> 7) & 1) !== 0) {
      filEnv = inst.pf2Envelopes; filLoop = inst.pf2EnvLoop; filSus = inst.pf2EnvSustainWord; filOn = true;
    } else {
      pitEnv = inst.pf2Envelopes; pitLoop = inst.pf2EnvLoop; pitSus = inst.pf2EnvSustainWord; pitOn = true;
    }
  }
  // patch overrides by role
  const pPit = patch !== null ? patch.pitchEnv : null;
  if (pPit !== null) {
    pitEnv = pPit; pitLoop = patch.pitchEnvLoop; pitSus = patch.pitchEnvSustain;
    pitOn = envPresent(patch.pitchEnvLoop);
  }
  const pFil = patch !== null ? patch.filterEnv : null;
  if (pFil !== null) {
    filEnv = pFil; filLoop = patch.filterEnvLoop; filSus = patch.filterEnvSustain;
    filOn = envPresent(patch.filterEnvLoop);
  }
  voice.activePitchEnv = pitEnv; voice.activePitchEnvLoop = pitLoop;
  voice.activePitchEnvSustain = pitSus; voice.hasPitchEnv = pitOn;
  voice.activeFilterEnv = filEnv; voice.activeFilterEnvLoop = filLoop;
  voice.activeFilterEnvSustain = filSus; voice.hasFilterEnv = filOn;

  if (patch !== null && patch.hasExtra) {
    voice.activeFadeoutStep = patch.fadeoutStep;
    voice.filterSfMode = patch.filterSfMode;
    voice.activeDefaultCutoff = patch.extraCutoff;
    voice.activeDefaultResonance = patch.extraResonance;
    voice.activeAttenGain = attenGainOf(patch.extraInitialAttenOctet);
  } else {
    voice.activeFadeoutStep = inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8);
    voice.filterSfMode = inst.filterSfMode;
    voice.activeDefaultCutoff = inst.defaultCutoff16;
    voice.activeDefaultResonance = inst.defaultResonance16;
    voice.activeAttenGain = attenGainOf(inst.initialAttenOctet);
  }
}

/** Trigger-time noteVolume seed from Default Note Volume (byte 196; 0 = legacy
 *  full volume). The record's field is 8-bit: a 6-bit column narrows it, a wide
 *  cell's 8-bit volume state takes it as it stands. */
function rowVolumeFromDefault(inst, patch = null, volMax = 0x3f) {
  const patchDnv = patch !== null && patch.defaultNoteVolume !== 0 ? patch.defaultNoteVolume : null;
  const dnv = patchDnv !== null ? patchDnv : inst.defaultNoteVolume;
  if (dnv === 0) return volMax;
  return volMax === 0xff ? dnv : Math.trunc((dnv * 63 + 127) / 255);
}

/** Cap backgroundVoices to MAX_BG_VOICES, preferring to evict the oldest NON-layer ghost. */
function capBackgroundVoices(ts) {
  while (ts.backgroundVoices.length > MAX_BG_VOICES) {
    const idx = ts.backgroundVoices.findIndex((v) => !v.isLayerChild);
    if (idx >= 0) ts.backgroundVoices.splice(idx, 1);
    else ts.backgroundVoices.shift();
  }
}

/** Release channel vi's layer children (fresh trigger): detach + apply their own NNA. */
function releaseLayerChildren(eng, ts, vi) {
  for (const bg of ts.backgroundVoices) {
    if (!bg.isLayerChild || bg.sourceChannel !== vi) continue;
    bg.isLayerChild = false;
    switch (eng.instruments[bg.instrumentId].newNoteAction) {
      case 0:
        if (!bg.keyOff) { bg.keyOff = true; applyKeyLift(bg, eng.instruments[bg.instrumentId]); }
        break;
      case 1: bg.active = false; break; // note cut
      case 3: bg.noteFading = true; break; // note fade
      // 2 = continue
    }
  }
}

/** Cut channel vi's layer children (pattern note-cut 0x0002). Ramped like the
 *  parent — they are one note, and a clean parent over clicking children would
 *  be worse than either on its own. */
function cutLayerChildren(ts, vi) {
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) startCutRamp(bg);
  }
}

/**
 * Trigger noteVal/instId on channel vi's foreground voice; a Metainstrument
 * fans out into layer children. rowVolOverride is the V-column trigger velocity
 * (or -1), used for velocity-conditional layer/patch resolution.
 */
function triggerMetaOrNote(eng, ts, voice, vi, noteVal, instId, rowVolOverride) {
  // Remember the pattern-level instrument for the Timeline header (a meta's slot,
  // not the layer child triggerNote resolves it to). A note with no instrument
  // byte keeps the last one, matching what the pattern shows.
  if (instId !== 0) voice.displayInst = instId;
  releaseLayerChildren(eng, ts, vi);
  const inst = instId !== 0 ? eng.instruments[instId] : eng.instruments[voice.instrumentId];
  if (!inst.isMeta) {
    triggerNote(eng, ts, voice, noteVal, instId, rowVolOverride);
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    voice.layerRelPan = 0;
    voice.layerRelElevation = 0;
    voice.isLayerChild = false;
    return;
  }
  // Layer gating is an INSTRUMENT-side rectangle, so the axis is 6-bit whatever
  // the column's width: narrow a wide cell's volume to it.
  const gateVol = ts.wideCells ? rowVolOverride >> 2 : rowVolOverride;
  const seedVol = gateVol >= 0 && gateVol <= 0x3f ? gateVol : 0x3f;
  let layers = inst.resolveMetaLayers(noteVal, seedVol);
  // STRICT layering: drop layers whose patches don't cover the note (the gating
  // bbox is loose; strict converters emit each layer's canonical into its patches).
  if (inst.metaStrict) {
    layers = layers.filter((l) =>
      eng.instruments[l.instIdx].resolvePatch(clamp(noteVal + l.detune, 0x20, 0xffff), seedVol) !== null);
  }
  if (layers.length === 0) { // no layer sounds this note: silence
    voice.active = false;
    voice.layerMixGain = 1.0;
    voice.layerRelDetune = 0;
    return;
  }
  const l0 = layers[0];
  // CHANNEL pan context as it stands before layer 0 retriggers — a channel the
  // pattern placed carries to every layer, and capturing it first keeps layer
  // 0's own trigger from feeding back into its siblings. Where each layer sits
  // WITHIN that channel is the note axis's business, handled per child below.
  const chanPan = voice.channelPan, chanRowPan = voice.rowPan;
  const chanPanbrello = voice.panbrelloOffset;
  const chanAzimuth = voice.panAzimuth, chanElevation = voice.panElevation;
  triggerNote(eng, ts, voice, clamp(noteVal + l0.detune, 0x20, 0xffff), l0.instIdx, rowVolOverride);
  // Layer 0 IS the meta's position — the centre the other layers sit around, in
  // pan exactly as it already is in pitch (layerRelDetune below). A layer that
  // says nothing about panning has no opinion about where it sits relative to
  // that centre, so its baseline is 0 rather than layer 0's own value; that is
  // what keeps a pan-less layer sitting wherever the meta sits (item 116) while
  // a layer with a pan of its own keeps its distance (item 118).
  const l0HasPan = notePanSeedBox[2] !== 0;
  const l0Pan = l0HasPan ? notePanSeedBox[0] : 0;
  const l0Elevation = l0HasPan ? notePanSeedBox[1] : 0;
  voice.layerMixGain = META_MIX_GAIN[l0.mixOctet & 0xff];
  voice.layerRelDetune = 0;
  voice.layerRelPan = 0;
  voice.layerRelElevation = 0;
  voice.isLayerChild = false;
  voice.metaForeground = true;
  for (let k = 1; k < layers.length; k++) {
    const lk = layers[k];
    const child = new Voice();
    // Match layer 0's channel context so M/pan and the first tick agree; the
    // trigger below may then move the child's pan to its own default.
    child.channelVolume = voice.channelVolume;
    child.channelPan = chanPan;
    child.rowPan = chanRowPan;
    child.panbrelloOffset = chanPanbrello;
    child.panAzimuth = chanAzimuth;
    child.panElevation = chanElevation;
    triggerNote(eng, ts, child, clamp(noteVal + lk.detune, 0x20, 0xffff), lk.instIdx, rowVolOverride);
    child.isLayerChild = true;
    child.sourceChannel = vi;
    child.displayInst = voice.displayInst; // export/display tap: the meta SLOT, not the layer's inst
    child.layerRelDetune = lk.detune - l0.detune;
    // The pan twin of layerRelDetune (item 118): how far this layer sits from
    // the meta's centre, held across the whole note by the per-tick sync so a
    // note-pan SET ROTATES the arrangement instead of collapsing it onto one
    // spot. A layer with no pan of its own rides at offset 0.
    if (notePanSeedBox[2] !== 0) {
      child.layerRelPan = notePanSeedBox[0] - l0Pan;
      child.layerRelElevation = notePanSeedBox[1] - l0Elevation;
    } else {
      child.layerRelPan = 0;
      child.layerRelElevation = 0;
    }
    child.notePan = boundNotePan(ts, voice.notePan + child.layerRelPan);
    child.noteElevation = voice.noteElevation + child.layerRelElevation;
    child.layerMixGain = META_MIX_GAIN[lk.mixOctet & 0xff];
    ts.backgroundVoices.push(child);
  }
  capBackgroundVoices(ts);
}

/**
 * Narrow a note volume onto the Ixmp/meta rectangle's velocity axis. That axis
 * is INSTRUMENT data and stays 6-bit in every format version (file format §5.5),
 * so a wide cell's 8-bit volume must be scaled down for it — 255 → 63. Every
 * resolvePatch/resolveMetaLayers call site goes through here; one that forgets
 * silently misses every patch in a v3 song (item 116).
 */
function narrowVolAxis(ts, v) {
  return clamp(ts.wideCells ? v >> 2 : v, 0, 0x3f);
}

function triggerNote(eng, ts, voice, noteVal, instId, volOverride) {
  if (instId !== 0) voice.instrumentId = instId;
  const inst = eng.instruments[voice.instrumentId];
  // Resolve the Ixmp patch for this trigger (volume axis = pre-patch seed).
  const narrow = (v) => narrowVolAxis(ts, v);
  let seedVolForLookup;
  if (volOverride >= 0) seedVolForLookup = narrow(volOverride);
  else if (instId !== 0) seedVolForLookup = rowVolumeFromDefault(inst, null);
  else seedVolForLookup = narrow(voice.noteVolume);
  const patch = inst.resolvePatch(noteVal, seedVolForLookup);
  applyActiveSample(voice, inst, patch);
  voice.tonePortaTarget = -1; // fresh note trigger cancels any running porta
  voice.samplePos = voice.activeSamplePlayStart;
  voice.forward = true;
  voice.active = true;
  voice.keyOff = false;
  voice.envIndex = 0;
  voice.envTimeSec = 0.0;
  voice.envVolume = clamp(voice.activeVolEnv[0].value / 63.0, 0.0, 1.0);
  // Snap the per-sample-smoothed envelope so attacks land at node-0 immediately.
  voice.envVolMix = voice.envVolume;
  voice.envVolStep = 0.0;
  voice.envPanIndex = 0;
  voice.envPanTimeSec = 0.0;
  voice.envPan = voice.activePanEnv[0].value / 255.0;
  voice.hasPanEnv = envPresent(voice.activePanEnvLoop);
  // Pitch / filter envelope seeds — settle past leading zero-duration nodes.
  if (voice.hasPitchEnv) {
    voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
      voice.activePitchEnvSustain);
    voice.envPitchIndex = pfIdxBox[0];
    voice.envPitchTimeSec = pfTimeBox[0];
  } else {
    voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
  }
  if (voice.hasFilterEnv) {
    voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
      voice.activeFilterEnvSustain);
    voice.envFilterIndex = pfIdxBox[0];
    voice.envFilterTimeSec = pfTimeBox[0];
  } else {
    voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
  }
  voice.fadeoutVolume = 1.0;
  // Cancel any leftover sample-end ramp — a fresh attack must not be muted.
  voice.rampOutSamples = 0;
  voice.rampOutGain = 0.0;
  // Arm the Attack fade-in (item 139); see constants.js ATTACK_RAMP_SAMPLES.
  voice.attackRampSamples = ATTACK_RAMP_SAMPLES;
  voice.autoVibPhase = 0;
  voice.autoVibTicksSinceTrigger = 0;
  voice.nesDpcmCounter = 63;
  voice.right.reset(); // stereo channel 2's filter/crusher/DPCM history
  // Funk repeat: PT2 resets n_wavestart on fresh trigger; speed/accumulator persist.
  voice.funkWritePos = 0;
  // Random vol/pan swing biases — seeded once per trigger.
  voice.randomVolBias = inst.volumeSwing !== 0
    ? Math.trunc(random() * (2 * inst.volumeSwing + 1)) - inst.volumeSwing : 0;
  voice.randomPanBias = inst.panSwing !== 0
    ? Math.trunc(random() * (2 * inst.panSwing + 1)) - inst.panSwing : 0;
  // Default pan / pitch-pan separation: only when the row carried an instrument byte.
  notePanSeedBox[2] = 0;
  if (instId !== 0) {
    // Everything an INSTRUMENT says about panning lands on the note axis (item
    // 117), never on the channel's own position — the exact mirror of the
    // volume side, where an instrument seeds `note_vol` and only M / N may
    // touch `channel_vol`. That is what lets `S $80xx` ROTATE a zone-panned
    // instrument instead of being flattened by its next note: the channel says
    // where the part sits, the instrument says where the note sits within it.
    //
    // Two sources, in specificity order, and mutually EXCLUSIVE because they
    // are the same statement at two levels — an SF2 bank that applied its
    // record pan AND its zone pan would double every displacement:
    //
    //  - An Ixmp patch's default pan is per-ZONE, so a patched instrument's pan
    //    changes with the note being played. It carries its own sentinel
    //    (0xFF = no override) and applies whether or not 'p' is set: the patch
    //    is free to bring its own pan envelope, whose LOOP word REPLACES the
    //    base record's, so gating a patch override on 'p' would let the patch
    //    disable its own pan (item 116). SF2-derived banks are the common case.
    //  - Otherwise pan LOOP word bit 7 = 'p' ("use default pan") gates the base
    //    record's byte 177.
    //
    // The seed gate is unchanged: a trigger that brings NEITHER leaves the note
    // axis alone, so a pan column SET survives it exactly as it did when both
    // axes lived in one register.
    const patchPan = patch !== null && patch.defaultPan !== 0xff ? patch.defaultPan : null;
    if (patchPan !== null) {
      applyNotePanSet(ts, voice, patchPan);
      notePanSeedBox[2] = 1;
    } else if (((voice.activePanEnvLoop >>> 7) & 1) !== 0) {
      notePanSeedBox[2] = 1;
      if (ts.surroundModel === SURROUND_STEREO) {
        applyNotePanSet(ts, voice, inst.defaultPan);
      } else {
        // Surround: the instrument's default is a POSITION (#998). Its azimuth
        // is nine bits (byte 177 + byte 14's `A`), so it can sit behind the
        // listener, and its elevation comes from record byte 254. Both are read
        // as offsets from the channel's direction, so an instrument that wants
        // to sound half-left of wherever the part is placed can say so.
        applyNotePanSet(ts, voice, inst.defaultAzimuth);
        applyNoteElevation(ts, voice, inst.defaultElevation);
      }
    }
    // Pitch-pan separation — an instrument property, and pitch-derived, so it
    // shifts the note axis on top of whichever seed above ran. It still
    // ACCUMULATES across notes on an instrument that brings no default pan of
    // its own, which is IT's arithmetic (IT adds PPS to the pan it is holding
    // and only the default pan re-seeds that); it accumulates in note-axis
    // units now instead of channel-axis ones.
    if (inst.pitchPanSeparation !== 0) {
      const noteDelta = (noteVal - inst.pitchPanCentre) / 4096.0;
      const panShift = Math.trunc(noteDelta * inst.pitchPanSeparation * 4.0);
      applyNotePanSlide(ts, voice, panShift);
      notePanSeedBox[2] = 1;
    }
    // What this instrument said about panning, for triggerMetaOrNote to measure
    // a layer's offset against layer 0's (item 118). Reported as the RESULTING
    // note-axis value rather than the delta, because a seed replaces where a
    // slide accumulates; the two callers only ever subtract two of these, so a
    // pan column value both of them inherited cancels out.
    notePanSeedBox[0] = voice.notePan;
    notePanSeedBox[1] = voice.noteElevation;
  }
  // Filter defaults (ACTIVE values; patch 'x' block overrides base inst).
  voice.currentCutoff = voice.activeDefaultCutoff;
  voice.currentResonance = voice.activeDefaultResonance;
  voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0;
  voice.filterCutoffCached = -1;
  voice.filterResonanceCached = -1;
  voice.noteVal = noteVal;
  voice.basePitch = noteVal;
  voice.renderPitch = noteVal; // display tap: seed before the first tick runs
  voice.amigaPeriod = -1.0;
  voice.linearFreq = -1.0;
  voice.playbackRate = computePlaybackRate(voice, noteVal, ts.tuningRatio);
  // noteVolume seed (IT `chan->volume = psmp->volume` rule; channelVolume survives).
  if (volOverride >= 0) voice.noteVolume = clamp(volOverride, 0, ts.volMax);
  else if (instId !== 0) voice.noteVolume = rowVolumeFromDefault(inst, patch, ts.volMax);
  // else: note-only retrigger inherits the channel's existing note volume.
  voice.rowVolume = voice.noteVolume;
  // Deferred anti-click ramp snap (applyVolColumn/applyEffectRow run after this).
  voice.snapMixVolume = true;
  voice.volRampSamples = 0;
  voice.volRampStep = 0.0;
  // A fresh note starts AT its pitch and AT its pan — it does not bend or slide
  // in from whatever the channel was last playing (item 141).
  voice.snapPlaybackRate = true;
  voice.snapPan = true;
  voice.noteWasCut = false;
  voice.noteFading = false;
  // S $73..$7E per-note overrides reset on each fresh trigger.
  voice.nnaOverride = -1;
  voice.volEnvOn = true;
  voice.panEnvOn = true;
  voice.pitchEnvOn = true;
  voice.filterEnvOn = true;
  voice.metaForeground = false; // triggerMetaOrNote re-sets for the meta path
  if (voice.vibratoRetrig) voice.vibratoLfoPos = 0;
  if (voice.tremoloRetrig) voice.tremoloLfoPos = 0;
  if (voice.panbrelloRetrig) voice.panbrelloLfoPos = 0;
}

/**
 * IT-style Duplicate Check (DCT/DCA), run BEFORE NNA on every fresh foreground
 * trigger. Reference: schismtracker effects.c:1664-1764.
 */
function applyDuplicateCheck(eng, ts, channel, newInstId, newNote) {
  if (newInstId === 0) return;
  const newInst = eng.instruments[newInstId];
  const newPatch = newInst.resolvePatch(newNote, 0x3f);
  const newSmpPtr = newPatch !== null ? newPatch.samplePtr : newInst.samplePtr;
  const newSmpLen = newPatch !== null ? newPatch.sampleLength : newInst.sampleLength;

  const isDuplicate = (v) => {
    const existInst = eng.instruments[v.instrumentId];
    switch (existInst.duplicateCheckType) {
      case 1: return v.noteVal === newNote && v.instrumentId === newInstId;
      case 2: return v.instrumentId === newInstId &&
                     v.activeSamplePtr === newSmpPtr &&
                     v.activeSampleLength === newSmpLen;
      case 3: return v.instrumentId === newInstId;
      default: return false;
    }
  };

  const applyAction = (v) => {
    const existInst = eng.instruments[v.instrumentId];
    switch (existInst.duplicateCheckAction) {
      case 0: v.fadeoutVolume = 0.0; v.active = false; break;
      case 1: v.keyOff = true; applyKeyLift(v, existInst); break;
      case 2: v.noteFading = true; break;
    }
  };

  const fg = ts.voices[channel];
  if (fg.active && eng.instruments[fg.instrumentId].duplicateCheckType !== 0 && isDuplicate(fg)) {
    applyAction(fg);
  }

  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (bg.sourceChannel !== channel || !bg.active) continue;
    if (eng.instruments[bg.instrumentId].duplicateCheckType === 0) continue;
    if (!isDuplicate(bg)) continue;
    applyAction(bg);
    if (!bg.active) ts.backgroundVoices.splice(i, 1);
  }
}

/**
 * On a fresh foreground trigger, migrate the existing voice into the background
 * pool per the New Note Action (instrument default unless S $73..$76 override).
 */
function maybeSpawnBackgroundForNNA(eng, ts, voice, channel) {
  if (!voice.active) return;
  const nna = voice.nnaOverride >= 0
    ? voice.nnaOverride
    : eng.instruments[voice.instrumentId].newNoteAction;
  if (nna === 1) {
    // Note Cut. The voice is about to be REUSED for the new note, so "cut" used
    // to mean dropping the old one wherever its waveform happened to be — a step
    // from that value to whatever the new note starts at. That is the retrigger
    // click, and it is loudest exactly where it is least wanted: a fast run of
    // notes on one channel, or a tone portamento re-attacking (item 142).
    //
    // So the outgoing note is ghosted just long enough to ramp out. It fades
    // over the same span the incoming note's attack ramp fades IN, which makes
    // the pair a crossfade rather than a splice. The ghost costs one background
    // voice for ~0.7 ms and deactivates itself.
    const cut = ghostVoice(voice, channel);
    startCutRamp(cut);
    ts.backgroundVoices.push(cut);
    capBackgroundVoices(ts);
    return;
  }

  const bg = ghostVoice(voice, channel);
  if (nna === 0) { // Note Off
    bg.keyOff = true;
    applyKeyLift(bg, eng.instruments[bg.instrumentId]);
  } else if (nna === 3) { // Note Fade
    bg.noteFading = true;
  }
  // 2 (Continue) — ghost continues unchanged.
  ts.backgroundVoices.push(bg);
  capBackgroundVoices(ts);
}

/** Snapshot the playback-relevant state of src into a fresh Voice for channel.
 *  MUST copy the full active-sample + active-envelope views AND both filter
 *  state sets (incl. SF2 biquad coefficients/history) — see the port notes. */
function ghostVoice(src, channel) {
  const v = new Voice();
  v.active = true;
  v.fader = src.fader;
  v.instrumentId = src.instrumentId;
  v.displayInst = src.displayInst;       // export/display tap: the ghost is still "that" instrument
  v.samplePos = src.samplePos;
  v.playbackRate = src.playbackRate;
  v.currentPlaybackRate = src.currentPlaybackRate;
  v.currentPan = src.currentPan;
  v.forward = src.forward;
  v.noteVolume = src.noteVolume;
  v.channelVolume = src.channelVolume;
  v.rowVolume = src.rowVolume;
  v.channelPan = src.channelPan;
  v.rowPan = src.rowPan;
  // Spatial position travels with the ghost: it keeps sounding where it was —
  // both axes, since the note it is still sounding brought its own offset.
  v.panAzimuth = src.panAzimuth;
  v.panElevation = src.panElevation;
  v.notePan = src.notePan;
  v.noteElevation = src.noteElevation;
  v.spatialTargetAz = src.spatialTargetAz;
  v.spatialTargetEl = src.spatialTargetEl;
  v.currentMixVolume = src.currentMixVolume;
  // A very fast retrigger can ghost a voice while its own Attack fade-in (item 139)
  // is still running — copy it so the ghost keeps fading up from where the
  // foreground voice left off, instead of jumping straight to unity.
  v.attackRampSamples = src.attackRampSamples;
  v.keyOff = src.keyOff;
  v.envIndex = src.envIndex;
  v.envTimeSec = src.envTimeSec;
  v.envVolume = src.envVolume;
  v.envVolMix = src.envVolMix;
  v.envVolStep = src.envVolStep;
  v.envPanIndex = src.envPanIndex;
  v.envPanTimeSec = src.envPanTimeSec;
  v.envPan = src.envPan;
  v.hasPanEnv = src.hasPanEnv;
  v.hasPitchEnv = src.hasPitchEnv;
  v.envPitchIndex = src.envPitchIndex;
  v.envPitchTimeSec = src.envPitchTimeSec;
  v.envPitchValue = src.envPitchValue;
  v.hasFilterEnv = src.hasFilterEnv;
  v.envFilterIndex = src.envFilterIndex;
  v.envFilterTimeSec = src.envFilterTimeSec;
  v.envFilterValue = src.envFilterValue;
  v.fadeoutVolume = src.fadeoutVolume;
  v.autoVibPhase = src.autoVibPhase;
  v.autoVibTicksSinceTrigger = src.autoVibTicksSinceTrigger;
  v.currentCutoff = src.currentCutoff;
  v.currentResonance = src.currentResonance;
  v.filterSfMode = src.filterSfMode;
  v.filterActive = src.filterActive;
  v.filterA0 = src.filterA0;
  v.filterB0 = src.filterB0;
  v.filterB1 = src.filterB1;
  v.filterY1 = src.filterY1;
  v.filterY2 = src.filterY2;
  v.filterIsBiquad = src.filterIsBiquad;
  v.filterBqB02 = src.filterBqB02;
  v.filterBqB1 = src.filterBqB1;
  v.filterBqA1 = src.filterBqA1;
  v.filterBqA2 = src.filterBqA2;
  v.filterX1 = src.filterX1;
  v.filterX2 = src.filterX2;
  v.filterCutoffCached = src.filterCutoffCached;
  v.filterResonanceCached = src.filterResonanceCached;
  v.randomVolBias = src.randomVolBias;
  v.randomPanBias = src.randomPanBias;
  // A ghost runs no effects, so its panbrello freezes at the offset it had when
  // the new note pushed it out of the channel — it keeps sounding where it was.
  v.panbrelloOffset = src.panbrelloOffset;
  v.noteVal = src.noteVal;
  v.basePitch = src.basePitch;
  v.amigaPeriod = src.amigaPeriod;
  v.linearFreq = src.linearFreq;
  v.volEnvOn = src.volEnvOn;
  v.panEnvOn = src.panEnvOn;
  v.pitchEnvOn = src.pitchEnvOn;
  v.filterEnvOn = src.filterEnvOn;
  v.metaForeground = src.metaForeground;
  v.noteFading = src.noteFading;
  v.layerMixGain = src.layerMixGain;
  v.layerRelPan = src.layerRelPan;
  v.layerRelElevation = src.layerRelElevation;
  v.clipMode = src.clipMode;
  v.bitcrusherDepth = src.bitcrusherDepth;
  v.bitcrusherSkip = src.bitcrusherSkip;
  v.bitcrusherCounter = src.bitcrusherCounter;
  v.bitcrusherHeld = src.bitcrusherHeld;
  v.overdriveAmp = src.overdriveAmp;
  v.sourceChannel = channel;
  // Active-sample snapshot follows the foreground voice.
  v.activeSamplePtr = src.activeSamplePtr;
  v.activeSampleLength = src.activeSampleLength;
  v.activeSamplePlayStart = src.activeSamplePlayStart;
  v.activeSampleLoopStart = src.activeSampleLoopStart;
  v.activeSampleLoopEnd = src.activeSampleLoopEnd;
  v.activeSamplingRate = src.activeSamplingRate;
  v.activeSampleDetune = src.activeSampleDetune;
  v.activeLoopMode = src.activeLoopMode;
  v.activeVibratoSpeed = src.activeVibratoSpeed;
  v.activeVibratoSweep = src.activeVibratoSweep;
  v.activeVibratoDepth = src.activeVibratoDepth;
  v.activeVibratoRate = src.activeVibratoRate;
  v.activeVibratoWaveform = src.activeVibratoWaveform;
  v.activePatchIndex = src.activePatchIndex; // stem tap: the ghost keeps the patch it sounded
  // A ghost of a stereo note keeps playing BOTH channels, with its own copy of
  // the second channel's filter/crusher history (same rule as the voice's own).
  v.activeChanCount = src.activeChanCount;
  v.activeChanMode = src.activeChanMode;
  v.activeChanPtr2 = src.activeChanPtr2;
  v.right.copyFrom(src.right);
  // Active-envelope view follows too — ghosts keep their patch's envelopes.
  v.activeVolEnv = src.activeVolEnv;
  v.activeVolEnvLoop = src.activeVolEnvLoop;
  v.activeVolEnvSustain = src.activeVolEnvSustain;
  v.activePanEnv = src.activePanEnv;
  v.activePanEnvLoop = src.activePanEnvLoop;
  v.activePanEnvSustain = src.activePanEnvSustain;
  v.activePitchEnv = src.activePitchEnv;
  v.activePitchEnvLoop = src.activePitchEnvLoop;
  v.activePitchEnvSustain = src.activePitchEnvSustain;
  v.activeFilterEnv = src.activeFilterEnv;
  v.activeFilterEnvLoop = src.activeFilterEnvLoop;
  v.activeFilterEnvSustain = src.activeFilterEnvSustain;
  v.activeFadeoutStep = src.activeFadeoutStep;
  v.activeDefaultCutoff = src.activeDefaultCutoff;
  v.activeDefaultResonance = src.activeDefaultResonance;
  v.activeAttenGain = src.activeAttenGain;
  return v;
}

/** Past-note action (S $70..$72) on all background voices spawned by channel. */
function applyPastNoteAction(eng, ts, channel, action) {
  switch (action) {
    case 0: { // Past Note Cut — drop them.
      for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
        if (ts.backgroundVoices[i].sourceChannel === channel) ts.backgroundVoices.splice(i, 1);
      }
      break;
    }
    case 1: // Past Note Off — sustain release.
      for (const bg of ts.backgroundVoices) {
        if (bg.sourceChannel === channel) {
          bg.keyOff = true;
          applyKeyLift(bg, eng.instruments[bg.instrumentId]);
        }
      }
      break;
    case 2: // Past Note Fade.
      for (const bg of ts.backgroundVoices) {
        if (bg.sourceChannel === channel) bg.noteFading = true;
      }
      break;
  }
}

/** Volume column (value = 6-bit field, sel = 2-bit selector). */
function applyVolColumn(ts, voice, value, sel) {
  // FINE packs its direction into the TOP bit of the column's value field, so
  // the flag and the magnitude mask move with the field's width (bit 5 of six,
  // bit 7 of eight). Everything else is the same in both formats — a wide
  // cell's numbers are simply four times as fine.
  const dirBit = ts.wideCells ? 0x80 : 0x20;
  switch (sel) {
    case 0:
      voice.noteVolume = clamp(value, 0, ts.volMax);
      voice.rowVolume = voice.noteVolume;
      break;
    case 1: voice.volColSlideUp = value; break;
    case 2: voice.volColSlideDown = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & (dirBit - 1);
      voice.noteVolume = (value & dirBit) !== 0
        ? Math.min(voice.noteVolume + mag, ts.volMax)
        : Math.max(voice.noteVolume - mag, 0);
      voice.rowVolume = voice.noteVolume;
      break;
    }
  }
}

/**
 * Pan column — the NOTE pan axis (item 117), the exact counterpart of the
 * volume column owning `note_vol` while M / N own `channel_vol`. All four
 * selectors write it, so a column SET places THIS note and leaves the channel's
 * own position (S $80xx, P, X, Z) standing underneath: on a zone-panned Ixmp
 * instrument the SET is what overrides the zone, and the channel commands are
 * what rotate it. There is consequently nothing left to arbitrate when a row
 * carries both a SET and an S $80xx — they address different registers, so both
 * apply.
 *
 * The 6-bit SET keeps its front-arc mapping in every surround model — the
 * column has no room for a 360° angle, and S $8xxx / X are the commands that
 * do. The slides, however, wrap with the rest of the pan machinery.
 */
function applyPanColumn(ts, voice, value, sel) {
  switch (sel) {
    case 0:
      applyNotePanSet(ts, voice, (value << 2) | (value >>> 4));
      break;
    case 1: voice.panColSlideRight = value; break;
    case 2: voice.panColSlideLeft = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & 0x1f;
      applyNotePanSlide(ts, voice, (value & 0x20) !== 0 ? mag : -mag);
      break;
    }
  }
}

/**
 * A WIDE cell's panning column (format version 3): a 9-bit azimuth and a signed
 * elevation, so the column alone can place a source anywhere on the sphere —
 * the six bits of the narrow cell only ever reached the front arc.
 *
 * Like the narrow column it is the NOTE axis (item 117) — the wide cell is the
 * same two lanes at higher resolution, exactly as its volume column is still
 * `note_vol` with a whole byte instead of six bits — so its azimuth and
 * elevation are both offsets from wherever the channel is pointing.
 *
 * The one exception is a `Z` slide on the same row, which turns the SET into
 * that slide's TARGET rather than a jump (the column says what effect `4` would
 * have said, and outranks a `4` on the same row for being the more specific
 * statement). A Z target names an absolute direction for the CHANNEL to travel
 * to, so on those rows — and only those — the column speaks for the channel.
 */
function applyPanColumnWide(ts, voice, row) {
  switch (row.panEff) {
    case 0: {
      if (rowSlidesSpatially(row)) {
        voice.spatialTargetAz = row.azimuth;
        voice.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? row.elevation : 0;
      } else {
        applyNotePanSet(ts, voice, row.azimuth);
        applyNoteElevation(ts, voice, row.elevation);
      }
      break;
    }
    // Slides rotate the azimuth by the LOW byte per tick; the elevation byte is
    // reserved for these selectors.
    case 1: voice.panColSlideRight = row.azimuth & 0xff; break;
    case 2: voice.panColSlideLeft = row.azimuth & 0xff; break;
    case 3: {
      const mag = row.azimuth & 0xff;
      if (mag === 0) return;
      applyNotePanSlide(ts, voice, (row.azimuth & 0x100) !== 0 ? mag : -mag);
      break;
    }
  }
}

/** Does this row arm a Z slide (in either effect slot)? */
function rowSlidesSpatially(row) {
  return (row.effect === EffectOp.OP_Z && (row.effectArg & 0xfff) !== 0) ||
         (row.effect2 === EffectOp.OP_Z && (row.effectArg2 & 0xfff) !== 0);
}

// ══ src/engine/effects.js ══
// Effect-column dispatch — port of AudioAdapter.kt resolveArg (3214),
// applyEffectRow (3216), applySEffect (3538), forEachEnvTarget (3633),
// applyFilterParamEffect (3650), applyRetrigVolMod (4090).
// Behavioural contract: TAUD_NOTE_EFFECTS.md; implementation truth: the Kotlin.








/** Scratch [azimuth, elevation] for the X / 4 argument decode. */
const spatialArg = new Float64Array(2);

/** Resolve a non-zero argument or recall from cohort memory. */
function resolveArg(arg, mem) { return arg !== 0 ? arg : mem; }

function applyEffectRow(eng, ts, playhead, voice, vi, op, rawArg) {
  switch (op) {
    case EffectOp.OP_NONE: break;
    case EffectOp.OP_7:
      // Pattern Ditto marker — consumed by applyTrackerRow's row-time expansion.
      break;
    case EffectOp.OP_1: {
      // 1 $xx00 — Global behaviour flags in the high byte.
      const flags = rawArg >>> 8;
      playhead.updateTrackerGlobalBehaviour(flags);
      break;
    }
    // 2 spares the region it names; 3 modifies it. Same command otherwise.
    case EffectOp.OP_2: applySampleModEffect(eng, voice, rawArg, true); break;
    case EffectOp.OP_3: applySampleModEffect(eng, voice, rawArg, false); break;
    case EffectOp.OP_5: applyFilterParamEffect(eng, ts, voice, vi, rawArg, false); break;
    case EffectOp.OP_6: applyFilterParamEffect(eng, ts, voice, vi, rawArg, true); break;
    case EffectOp.OP_8: {
      // 8 $xyzz — Bitcrusher: x = clip mode, y = bit depth, zz = sample-skip.
      const x = (rawArg >>> 12) & 0xf;
      const y = (rawArg >>> 8) & 0xf;
      const z = rawArg & 0xff;
      voice.clipMode = x & 3;
      if (rawArg === 0) {
        voice.bitcrusherDepth = 0;
        voice.bitcrusherSkip = 0;
        voice.bitcrusherCounter = 0;
        voice.right.bitcrusherCounter = 0;
      } else if (y === 0 && z === 0) {
        // x000 — clip mode only.
      } else {
        voice.bitcrusherDepth = y;
        voice.bitcrusherSkip = z;
        voice.bitcrusherCounter = 0;
        voice.right.bitcrusherCounter = 0;
      }
      break;
    }
    case EffectOp.OP_9: {
      // 9 $x0zz — Overdrive: x = clip mode, zz = amplification index.
      const x = (rawArg >>> 12) & 0xf;
      const z = rawArg & 0xff;
      voice.clipMode = x & 3;
      if (rawArg === 0) voice.overdriveAmp = 0;
      else if (z !== 0) voice.overdriveAmp = z;
      break;
    }
    case EffectOp.OP_A: {
      const tr = (rawArg >>> 8) & 0xff;
      if (tr !== 0) playhead.tickRate = tr;
      break;
    }
    case EffectOp.OP_B:
      if (ts.pendingOrderJump < 0) ts.pendingOrderJump = clamp(rawArg, 0, NUM_CUES - 1);
      break;
    case EffectOp.OP_C:
      if (ts.pendingRowJump < 0) ts.pendingRowJump = clamp(rawArg, 0, 63);
      break;
    case EffectOp.OP_D: {
      // Per-note volume slide: fine forms at tick 0, coarse arms slideMode 5.
      const arg = resolveArg(rawArg, voice.mem.d);
      if (rawArg !== 0) voice.mem.d = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) {
        voice.noteVolume = Math.min(voice.noteVolume + 0xf * ts.volStep, ts.volMax); voice.rowVolume = voice.noteVolume;
      } else if (hin === 0xf && lo !== 0) {
        voice.noteVolume = Math.max(voice.noteVolume - lo * ts.volStep, 0); voice.rowVolume = voice.noteVolume;
      } else if (lo === 0xf && hin !== 0) {
        voice.noteVolume = Math.min(voice.noteVolume + hin * ts.volStep, ts.volMax); voice.rowVolume = voice.noteVolume;
      } else if (hin === 0 && lo !== 0) {
        voice.slideMode = 5; voice.slideArg = -lo;
      } else if (lo === 0 && hin !== 0) {
        voice.slideMode = 5; voice.slideArg = hin;
      }
      break;
    }
    case EffectOp.OP_E: {
      const arg = resolveArg(rawArg, voice.mem.ef);
      if (rawArg !== 0) voice.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = arg & 0x0fff;
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(voice.noteVal, -mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(voice.noteVal, -mag);
        else nv = voice.noteVal - mag;
        voice.noteVal = clamp(nv, 0x20, 0xffff);
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
        voice.playbackRate = computePlaybackRate(voice, voice.noteVal, ts.tuningRatio);
      } else {
        voice.slideMode = 1; voice.slideArg = -arg;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_F: {
      const arg = resolveArg(rawArg, voice.mem.ef);
      if (rawArg !== 0) voice.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = arg & 0x0fff;
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(voice.noteVal, mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(voice.noteVal, mag);
        else nv = voice.noteVal + mag;
        voice.noteVal = clamp(nv, 0x20, 0xffff);
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
        voice.playbackRate = computePlaybackRate(voice, voice.noteVal, ts.tuningRatio);
      } else {
        voice.slideMode = 2; voice.slideArg = arg;
        voice.amigaPeriod = -1.0;
        voice.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_G: {
      const arg = resolveArg(rawArg, voice.mem.g);
      if (rawArg !== 0) voice.mem.g = arg;
      voice.tonePortaSpeed = arg;
      break;
    }
    case EffectOp.OP_H: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.huSpeed = sp;
      if (dp !== 0) voice.mem.huDepth = dp;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 6;
      break;
    }
    case EffectOp.OP_I: {
      const arg = resolveArg(rawArg, voice.mem.i);
      if (rawArg !== 0) voice.mem.i = arg;
      voice.tremorOn = 1;
      voice.tremorOnTime = ((arg >>> 8) & 0xff) + 1;
      voice.tremorOffTime = (arg & 0xff) + 1;
      break;
    }
    case EffectOp.OP_J: {
      const arg = resolveArg(rawArg, voice.mem.j);
      if (rawArg !== 0) voice.mem.j = arg;
      voice.arpActive = true;
      voice.arpOff1 = (arg >>> 8) & 0xff;
      voice.arpOff2 = arg & 0xff;
      break;
    }
    case EffectOp.OP_K: {
      // K $xy00 — vibrato continuation + volume slide (down wins, ST3 quirk).
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (voice.mem.k = raw) : voice.mem.k;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 6;
      if (lo !== 0) voice.volColSlideDown = lo;
      else if (hi !== 0) voice.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_L: {
      // L $xy00 — tone-porta continuation + volume slide (porta speed from G's memory).
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (voice.mem.l = raw) : voice.mem.l;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      voice.tonePortaSpeed = voice.mem.g;
      if (lo !== 0) voice.volColSlideDown = lo;
      else if (hi !== 0) voice.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_M:
      // M $xx00 — set channel volume (literal, no recall; IT $40 clamps to $3F).
      // A wide cell's volume state is 8-bit, so the byte lands unscaled there.
      voice.channelVolume = Math.min((rawArg >>> 8) & 0xff, ts.volMax);
      break;
    case EffectOp.OP_N: {
      // N $xy00 — channel-volume slide (D nibble decoding, channel axis only).
      const arg = resolveArg(rawArg, voice.mem.n);
      if (rawArg !== 0) voice.mem.n = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) voice.channelVolume = Math.min(voice.channelVolume + 0xf * ts.volStep, ts.volMax);
      else if (hin === 0xf && lo !== 0) voice.channelVolume = Math.max(voice.channelVolume - lo * ts.volStep, 0);
      else if (lo === 0xf && hin !== 0) voice.channelVolume = Math.min(voice.channelVolume + hin * ts.volStep, ts.volMax);
      else if (hin === 0 && lo !== 0) voice.nSlideDir = -lo;
      else if (lo === 0 && hin !== 0) voice.nSlideDir = hin;
      break;
    }
    case EffectOp.OP_P: {
      // P $xy00 — channel-panning slide (IT convention: low nibble right, high left).
      const arg = resolveArg(rawArg, voice.mem.p);
      if (rawArg !== 0) voice.mem.p = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      // In a surround song the pan runs right round the circle: the slide
      // wraps where the stereo law clamps (TAUD_NOTE_EFFECTS.md, effect P).
      if (hi === 0xff || hi === 0xf0) {
        applyPanSlide(ts, voice, -0xf);
      } else if (hin === 0xf && lo !== 0) {
        applyPanSlide(ts, voice, lo);
      } else if (lo === 0xf && hin !== 0) {
        applyPanSlide(ts, voice, -hin);
      } else if (hin === 0 && lo !== 0) {
        voice.chanPanSlideRight = lo;
      } else if (lo === 0 && hin !== 0) {
        voice.chanPanSlideLeft = hin;
      }
      break;
    }
    case EffectOp.OP_O: {
      // Sample offset — clamps into the active sample's loop region.
      const arg = resolveArg(rawArg, voice.mem.o);
      if (rawArg !== 0) voice.mem.o = arg;
      let off = arg;
      if ((voice.activeLoopMode & 3) !== 0 &&
          voice.activeSampleLoopEnd > voice.activeSampleLoopStart &&
          off > voice.activeSampleLoopEnd) {
        const loopLen = Math.max(voice.activeSampleLoopEnd - voice.activeSampleLoopStart, 1);
        off = voice.activeSampleLoopStart + ((off - voice.activeSampleLoopStart) % loopLen);
      }
      voice.samplePos = off;
      break;
    }
    case EffectOp.OP_Q: {
      // Q $xy00 — x = retrigVolMod (bits 12-15), y = retrigInterval (bits 8-11).
      const arg = resolveArg(rawArg, voice.mem.q);
      const y = (arg >>> 8) & 0xf;
      if (y !== 0) {
        voice.mem.q = arg;
        voice.retrigInterval = y;
        voice.retrigVolMod = (arg >>> 12) & 0xf;
        voice.retrigActive = true;
        // Counter persists across rows per spec.
      }
      // y == 0 → entire effect ignored, even memory.
      break;
    }
    case EffectOp.OP_R: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.rSpeed = sp;
      if (dp !== 0) voice.mem.rDepth = dp;
      voice.tremoloActive = true;
      break;
    }
    case EffectOp.OP_S: applySEffect(eng, ts, voice, vi, rawArg); break;
    case EffectOp.OP_T: {
      const hi = (rawArg >>> 8) & 0xff;
      if (hi === 0xff) {
        // T $FFxx — extended set-tempo: BPM = $xx + $118 (280..535).
        playhead.bpm = clamp((rawArg & 0xff) + 0x118, 25, 535);
      } else if (hi !== 0) {
        // T $xx00 — set-tempo: BPM = $xx + $19 (25..280).
        playhead.bpm = clamp(hi + 0x19, 25, 535);
      } else {
        const low = rawArg & 0xff;
        switch (low & 0xf0) {
          case 0x00: voice.tempoSlideDir = -1; voice.tempoSlideAmount = low & 0x0f; voice.mem.tslide = low; break;
          case 0x10: voice.tempoSlideDir = +1; voice.tempoSlideAmount = low & 0x0f; voice.mem.tslide = low; break;
        }
      }
      break;
    }
    case EffectOp.OP_U: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.huSpeed = sp;
      if (dp !== 0) voice.mem.huDepth = dp;
      voice.vibratoActive = true;
      voice.vibratoFineShift = 8;
      break;
    }
    case EffectOp.OP_V:
      playhead.globalVolume = (rawArg >>> 8) & 0xff;
      break;
    case EffectOp.OP_W: {
      const arg = resolveArg(rawArg, voice.mem.w);
      if (rawArg !== 0) voice.mem.w = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff) playhead.globalVolume = Math.min(playhead.globalVolume + 0xf, 0xff);
      else if (hin === 0xf && lo !== 0) playhead.globalVolume = Math.max(playhead.globalVolume - lo, 0);
      else if (lo === 0xf && hin !== 0) playhead.globalVolume = Math.min(playhead.globalVolume + hin, 0xff);
      else if (hin === 0 && lo !== 0) { voice.wSlideDir = -1; voice.wSlideAmount = lo; }
      else if (lo === 0 && hin !== 0) { voice.wSlideDir = +1; voice.wSlideAmount = hin; }
      break;
    }
    case EffectOp.OP_Y: {
      const sp = (rawArg >>> 8) & 0xff;
      const dp = rawArg & 0xff;
      if (sp !== 0) voice.mem.ySpeed = sp;
      if (dp !== 0) voice.mem.yDepth = dp;
      voice.panbrelloActive = true;
      break;
    }
    // ── Spatial panning (#998.2) — reserved for songs whose surround model
    //    says so; a stereo song ignores all three (converters are required to
    //    turn IT's X "fine set panning" into S $80xx instead).
    case EffectOp.OP_X: {
      // X $eeaa — place the source: azimuth $aa over the full turn, elevation
      // $ee signed ($80 = −90°, $7F ≈ +90°). Channel axis, not note axis —
      // applyPanSet is the SAME call S $80xx makes (case 0x8 below), so the two
      // share one register and either can overwrite the other's azimuth.
      if (ts.surroundModel === SURROUND_STEREO) break;
      anglesFromSpatialArg(rawArg, spatialArg);
      applyPanSet(ts, voice, spatialArg[0]);
      applyElevation(ts, voice, spatialArg[1]);
      break;
    }
    case EffectOp.OP_4:
      // 4 $eeaa — where a Z slide is heading. Channel state: it outlives the row.
      if (ts.surroundModel === SURROUND_STEREO) break;
      anglesFromSpatialArg(rawArg, spatialArg);
      voice.spatialTargetAz = spatialArg[0];
      voice.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? spatialArg[1] : 0.0;
      break;
    case EffectOp.OP_Z: {
      // Z $0xxx — arm the slide for this row at $xxx/16 azimuth units per tick.
      if (ts.surroundModel === SURROUND_STEREO) break;
      const raw = rawArg & 0xfff;
      const arg = resolveArg(raw, voice.mem.z);
      if (raw !== 0) voice.mem.z = arg;
      if (arg !== 0) voice.spatialSlideActive = true;
      break;
    }
  }
}

function applySEffect(eng, ts, voice, vi, arg) {
  const sub = (arg >>> 12) & 0xf;
  const x = (arg >>> 8) & 0xf;
  switch (sub) {
    case 0x0:
      // S $0000 = LED filter on, S $0100 = off (PT E00/E01); Amiga modes only.
      if (ts.interpolationMode === INTERP_A500 || ts.interpolationMode === INTERP_A1200) {
        ts.ledFilterOn = x === 0;
      }
      break;
    case 0x1: voice.glissandoOn = x !== 0; break;
    case 0x2:
      voice.noteVal = clamp(voice.noteVal + FINETUNE_OFFSET[x], 0x20, 0xffff);
      voice.basePitch = voice.noteVal;
      voice.amigaPeriod = -1.0;
      voice.linearFreq = -1.0;
      voice.playbackRate = computePlaybackRate(voice, voice.noteVal, ts.tuningRatio);
      break;
    case 0x3: voice.vibratoWave = x & 3; voice.vibratoRetrig = (x & 4) === 0; break;
    case 0x4: voice.tremoloWave = x & 3; voice.tremoloRetrig = (x & 4) === 0; break;
    case 0x5: voice.panbrelloWave = x & 3; voice.panbrelloRetrig = (x & 4) === 0; break;
    case 0x6: ts.finePatternDelayExtra += x; break;
    case 0x7: {
      // S$7x — Note/Instrument actions. $0..$6 are no-ops on a metainstrument;
      // $7..$E fan out across the meta's constituents (forEachEnvTarget).
      const isMeta = voice.metaForeground;
      switch (x) {
        case 0x0: if (!isMeta) applyPastNoteAction(eng, ts, vi, 0); break;
        case 0x1: if (!isMeta) applyPastNoteAction(eng, ts, vi, 1); break;
        case 0x2: if (!isMeta) applyPastNoteAction(eng, ts, vi, 2); break;
        case 0x3: if (!isMeta) voice.nnaOverride = 1; break; // NNA Note Cut
        case 0x4: if (!isMeta) voice.nnaOverride = 2; break; // NNA Note Continue
        case 0x5: if (!isMeta) voice.nnaOverride = 0; break; // NNA Note Off
        case 0x6: if (!isMeta) voice.nnaOverride = 3; break; // NNA Note Fade
        case 0x7: forEachEnvTarget(ts, voice, vi, (v) => { v.volEnvOn = false; }); break;
        case 0x8: forEachEnvTarget(ts, voice, vi, (v) => { v.volEnvOn = true; }); break;
        case 0x9: forEachEnvTarget(ts, voice, vi, (v) => { v.panEnvOn = false; }); break;
        case 0xa: forEachEnvTarget(ts, voice, vi, (v) => { v.panEnvOn = true; }); break;
        // $B/$C: pitch env when defined, else filter env (IT "pitch or filter").
        case 0xb: forEachEnvTarget(ts, voice, vi, (v) => {
          if (v.hasPitchEnv) v.pitchEnvOn = false; else if (v.hasFilterEnv) v.filterEnvOn = false;
        }); break;
        case 0xc: forEachEnvTarget(ts, voice, vi, (v) => {
          if (v.hasPitchEnv) v.pitchEnvOn = true; else if (v.hasFilterEnv) v.filterEnvOn = true;
        }); break;
        case 0xd: forEachEnvTarget(ts, voice, vi, (v) => { v.filterEnvOn = false; }); break;
        case 0xe: forEachEnvTarget(ts, voice, vi, (v) => { v.filterEnvOn = true; }); break;
      }
      break;
    }
    case 0x8:
      // S$80xx — full 8-bit pan. A surround song reads one bit more (#998.1):
      // S$8xxx is a 9-bit angle, $000 left · $080 front · $100 right · $180
      // behind, of which $000..$0FF are exactly the old pan bytes.
      applyPanSet(ts, voice, arg & (ts.surroundModel === SURROUND_STEREO ? 0xff : 0x1ff));
      break;
    case 0xb:
      if (x === 0) voice.loopStartRow = ts.rowIndex;
      else {
        if (voice.loopCount === 0) {
          voice.loopCount = x;
          ts.pendingRowJump = voice.loopStartRow;
          ts.pendingRowJumpLocal = true;
        } else if (!ts.patternDelayActive) {
          voice.loopCount--;
          if (voice.loopCount > 0) {
            ts.pendingRowJump = voice.loopStartRow;
            ts.pendingRowJumpLocal = true;
          }
        }
      }
      break;
    case 0xc: if (x !== 0) voice.cutAtTick = x; break;
    case 0xd: break; // note delay — handled in the row's note section
    case 0xe:
      // Pattern delay — first SEx in ascending channel order wins.
      if (ts.sexWinningChannel < 0) {
        ts.sexWinningChannel = vi;
        ts.patternDelayRemaining = x;
      }
      break;
    case 0xf:
      voice.funkSpeed = arg & 0xff;
      if (x === 0) voice.funkAccumulator = 0;
      break;
  }
}

/**
 * notefx 2 and notefx 3 — the sample-modification command (item 130). `invert`
 * is what tells them apart: `3 $sexy` names the region to modify, `2 $sexy`
 * names the region to LEAVE ALONE. Everything else is identical, and an
 * instrument carries ONE modification, so either opcode replaces it.
 *
 *   $se  region        $x  operation (0 = reset)      $y  funk-speed index
 *
 * The state splits the way S $Fxxx's does: the modification belongs to the
 * INSTRUMENT (every channel sounding it hears the same sample) and the speed
 * driving it to the CHANNEL. A reserved operation or a reserved region is
 * ignored WHOLE, speed and all, so a typo cannot drive a modification the
 * writer never named.
 */
function applySampleModEffect(eng, voice, rawArg, invert) {
  const inst = eng.instruments[voice.instrumentId];
  const op = (rawArg >>> 4) & 0xf;
  if (op === MOD_OFF) {
    inst.resetMod();
    voice.modSpeed = 0;
    voice.modAccumulator = 0;
    voice.modWritePos = 0;
    return;
  }
  if (op > MOD_MAX) return;                       // $A..$F — reserved
  const code = decodeSampleRegion((rawArg >>> 8) & 0xff, voice.activeSampleLength,
    voice.activeSampleLoopStart, voice.activeSampleLoopEnd, regionScratch);
  if (code === REGION_NONE) return;
  const moved = code === REGION_COMB
    ? inst.setModComb(regionScratch[2])
    : inst.setModRegion(regionScratch[0], regionScratch[1], regionScratch[2]);
  const swapped = inst.setModOp(op, invert);
  // A changed region or operation restarts the walk; re-stating the SAME
  // command row after row must not, or it would never get past its first step.
  if (moved || swapped) {
    voice.modAccumulator = 0;
    voice.modWritePos = 0;
  }
  voice.modSpeed = FUNK_SPEED_TABLE[rawArg & 0xf];
}

/** Apply an env toggle to the foreground voice + (for a meta) its layer children. */
function forEachEnvTarget(ts, voice, vi, action) {
  action(voice);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) action(bg);
  }
}

/**
 * notefx 5 (cutoff) / 6 (resonance) — instrument-wide filter parameter control.
 * $FFFF clears the override; IT mode takes the high byte, SF mode the full 16 bits.
 */
function applyFilterParamEffect(eng, ts, voice, vi, rawArg, isResonance) {
  const targets = new Set();
  targets.add(voice.instrumentId);
  for (const bg of ts.backgroundVoices) {
    if (bg.isLayerChild && bg.sourceChannel === vi) targets.add(bg.instrumentId);
  }

  for (const id of targets) {
    const ti = eng.instruments[id];
    let value;
    if (rawArg === 0xffff) value = -1;
    else if (ti.filterSfMode) value = rawArg & 0xffff;
    else value = (rawArg >>> 8) & 0xff;
    if (isResonance) ti.resonanceOverride = value;
    else ti.cutoffOverride = value;
  }

  const push = (v) => {
    if (!targets.has(v.instrumentId)) return;
    const ti = eng.instruments[v.instrumentId];
    // The override is instrument-wide and ABSOLUTE: while one is in force every
    // voice takes it, patch or not. Clearing it ($FFFF) must return each voice
    // to its OWN default, and for a voice sounding an Ixmp patch with an 'x'
    // block that is the PATCH's value — falling back to the base record would
    // retune a patched voice's filter and, when the two disagree on SF vs IT
    // mode, reinterpret the number in the wrong units (item 116).
    const patch = patchAt(ti, v.activePatchIndex);
    const patchExtra = patch !== null && patch.hasExtra;
    const overridden = ti.cutoffOverride >= 0 || ti.resonanceOverride >= 0;
    v.filterSfMode = patchExtra && !overridden ? patch.filterSfMode : ti.filterSfMode;
    if (isResonance) {
      v.activeDefaultResonance = ti.resonanceOverride < 0 && patchExtra
        ? patch.extraResonance : ti.defaultResonance16;
      v.currentResonance = v.activeDefaultResonance;
    } else {
      v.activeDefaultCutoff = ti.cutoffOverride < 0 && patchExtra
        ? patch.extraCutoff : ti.defaultCutoff16;
      v.currentCutoff = v.activeDefaultCutoff;
    }
    v.filterCutoffCached = -1;
    v.filterResonanceCached = -1;
  };
  for (const v of ts.voices) if (v.active) push(v);
  for (const bg of ts.backgroundVoices) if (bg.active) push(bg);
}

/** Q's volume modifiers. The additive cases are stated in 6-bit units, so they
 *  scale with the cell format the way every other nibble delta does; the
 *  multiplicative ones are ratios and do not. */
function applyRetrigVolMod(vol, x, step = 1, max = 0x3f) {
  let v;
  switch (x & 0xf) {
    case 0: case 8: v = vol; break;
    case 1: v = vol - 0x01 * step; break;
    case 2: v = vol - 0x02 * step; break;
    case 3: v = vol - 0x04 * step; break;
    case 4: v = vol - 0x08 * step; break;
    case 5: v = vol - 0x10 * step; break;
    case 6: v = Math.trunc((vol * 2) / 3); break;
    case 7: v = vol >> 1; break;
    case 9: v = vol + 0x01 * step; break;
    case 0xa: v = vol + 0x02 * step; break;
    case 0xb: v = vol + 0x04 * step; break;
    case 0xc: v = vol + 0x08 * step; break;
    case 0xd: v = vol + 0x10 * step; break;
    case 0xe: v = Math.trunc((vol * 3) / 2); break;
    case 0xf: v = vol << 1; break;
    default: v = vol; break;
  }
  return clamp(v, 0, max);
}

// ══ src/engine/row.js ══
// Row processing + cue advance — port of AudioAdapter.kt applyTrackerRow (2948),
// advanceTrackerCue (4101), resetPatternLoopState (4117), advanceRow (4343).








/** S $Dxny (item 94, extended item 97): schedule the $n follow-up action at
 *  absolute tick $x+$y within the row (independent of whichever note-event
 *  branch deferred the trigger by $x, or fired it immediately when $x is 0,
 *  or — on a note-less row — deferred nothing at all, see the `note === 0`
 *  caller). No-op unless $y is nonzero — a zero $y never carries an action
 *  (TAUD_NOTE_EFFECTS.md "S $Dxny" table: "If $y is zero" has no action row).
 *  A schedule past the row's tick count self-discards: tick.js only fires on
 *  an exact tickInRow match, and row entry unconditionally resets
 *  noteActionTick to -1 before the next row's ticks can reach it — the same
 *  trick sDelayTick relies on. */
function scheduleDxnyAction(voice, row, delayTick) {
  if (row.effect !== EffectOp.OP_S || ((row.effectArg >>> 12) & 0xf) !== 0xd) return;
  const y = row.effectArg & 0xf;
  if (y === 0) return;
  voice.noteActionTick = delayTick + y;
  voice.delayedAction = (row.effectArg >>> 4) & 0xf;
}

function applyTrackerRow(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  // Reset row-scope state before scanning channels.
  if (!ts.patternDelayActive) ts.sexWinningChannel = -1;
  ts.finePatternDelayExtra = 0;

  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rawRow = eng.patternRead(patIdx)[ts.rowIndex];
    const voice = ts.voices[vi];

    // ── Pattern Ditto (effect 7) row-time expansion ──
    const n = ts.rowIndex;
    const isArmer = rawRow.effect === EffectOp.OP_7 && rawRow.effectArg !== 0;
    if (isArmer) {
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        const patLen = cue.rowLimit();
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave previously-armed ditto state alone.
    }

    const dittoArmRow = voice.dittoSourceStart + voice.dittoLength;
    let row;
    if (voice.dittoActive && n >= dittoArmRow && n <= voice.dittoEndRow) {
      const rel = (n - voice.dittoSourceStart) % voice.dittoLength;
      const srcRow = voice.dittoSourceStart + rel;
      const src = eng.patternRead(patIdx)[srcRow];

      // Vol-/pan-column "no-op" sentinel is SEL_FINE (3) with value 0 — in a
      // wide cell the pan column's "value" is the azimuth AND the elevation.
      const volIsSet = !(rawRow.volumeEff === 3 && rawRow.volume === 0);
      const panIsSet = ts.wideCells
        ? !(rawRow.panEff === 3 && rawRow.azimuth === 0 && rawRow.elevation === 0)
        : !(rawRow.panEff === 3 && rawRow.pan === 0);

      const destOp = isArmer ? 0 : rawRow.effect;
      const destArg = isArmer ? 0 : rawRow.effectArg;
      let effOp, effArg;
      if (destOp !== 0) { effOp = destOp; effArg = destArg; }
      else if (src.effect !== EffectOp.OP_7) { effOp = src.effect; effArg = src.effectArg; }
      else { effOp = 0; effArg = 0; }

      row = new TaudPlayData();
      row.note = rawRow.note !== 0x0000 ? rawRow.note : src.note;
      row.instrment = rawRow.instrment !== 0 ? rawRow.instrment : src.instrment;
      row.volume = volIsSet ? rawRow.volume : src.volume;
      row.volumeEff = volIsSet ? rawRow.volumeEff : src.volumeEff;
      row.pan = panIsSet ? rawRow.pan : src.pan;
      row.panEff = panIsSet ? rawRow.panEff : src.panEff;
      row.azimuth = panIsSet ? rawRow.azimuth : src.azimuth;
      row.elevation = panIsSet ? rawRow.elevation : src.elevation;
      row.effect = effOp;
      row.effectArg = effArg;
      // The second effect follows the first: a ditto that inherits one command
      // inherits the pair the source row actually carried.
      const dittoUsedSrc = destOp === 0 && effOp !== 0;
      row.effect2 = dittoUsedSrc ? src.effect2 : rawRow.effect2;
      row.effectArg2 = dittoUsedSrc ? src.effectArg2 : rawRow.effectArg2;
    } else {
      row = rawRow;
    }

    // Reset per-row transient state.
    voice.cutAtTick = -1;
    voice.noteDelayTick = -1;
    voice.noteActionTick = -1;
    voice.delayedAction = -1;
    voice.slideMode = 0;
    voice.slideArg = 0;
    voice.arpActive = false;
    voice.tremorOn = 0;
    voice.vibratoActive = false;
    voice.tremoloActive = false;
    voice.panbrelloActive = false; // the offset itself is the tick pass's (tick.js)
    voice.retrigActive = false;
    voice.tempoSlideDir = 0;
    voice.wSlideDir = 0;
    voice.volColSlideUp = 0; voice.volColSlideDown = 0;
    voice.panColSlideRight = 0; voice.panColSlideLeft = 0;
    voice.chanPanSlideRight = 0; voice.chanPanSlideLeft = 0;
    voice.spatialSlideActive = false; // Z re-arms per row, like every other slide
    voice.nSlideDir = 0;
    voice.rowEffect = row.effect;
    voice.rowEffectArg = row.effectArg;
    // Row boundary: rebase rowVolume to the persistent noteVolume.
    voice.rowVolume = voice.noteVolume;

    // ── Note ──
    // OP_L also takes a porta target without retriggering (continues a G porta).
    const toneG = row.effect === EffectOp.OP_G || row.effect === EffectOp.OP_L;
    const note = row.note;
    const sDelayTick = row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd
      ? (row.effectArg >>> 8) & 0xf : 0;

    if (note === 0x0000) {
      const pitchFx = row.effect === EffectOp.OP_E || row.effect === EffectOp.OP_F ||
        row.effect === EffectOp.OP_G;
      if (row.instrment !== 0 && pitchFx && voice.noteVal >= 0x20) {
        // Note 0 + instrument + a pitch effect (E porta-down / F porta-up /
        // G tone-porta) TRIGGERS the note at the voice's current pitch, so the
        // slide has a sounding note to move — previously this only latched the
        // instrument and stayed silent (item 43; needs the same TSVM fix).
        applyDuplicateCheck(eng, ts, vi, row.instrment, voice.noteVal);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, voice.noteVal, row.instrment, trigVol);
      } else if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
        // No note + instrument byte: latch instrument, re-seed from its DNV
        // (PT/FT2/IT/Schism all do this; see AudioAdapter.kt:3050-3061).
        voice.instrumentId = row.instrment;
        const newInst = eng.instruments[voice.instrumentId];
        const newPatch = newInst.resolvePatch(voice.noteVal,
          narrowVolAxis(ts, voice.noteVolume));
        // applyActiveSample without retrigger (Schism csf_instrument_change).
        applyInstrumentChange(eng, ts, voice, newInst, newPatch);
      }
      // A note-less row has nothing for S$D's $x to trigger, but the $n
      // follow-up action still applies to whatever voice is already sounding
      // (TAUD_NOTE_EFFECTS.md: FastTracker Kxx → S $D00xx, OpenMPT :xy →
      // S $Dx1y — both act on the current note without a note column entry).
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0001) {
      // Key-off (sub-row delay via S$Dx defers it).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0001;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.keyOff = true;
        applyKeyLift(voice, eng.instruments[voice.instrumentId]);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0002) {
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0002;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startCutRamp(voice);
        cutLayerChildren(ts, vi);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0004) {
      // Fast note-fade (SF2 exclusiveClass choke).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0004;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startFastFade(voice, playhead);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0003) {
      // IT-style note fade: fadeout without sustain release.
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0003;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.noteFading = true;
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note >= 0x0005 && note <= 0x000f) {
      // reserved sentinel range, no engine handler
    } else if (note >= 0x0010 && note <= 0x001f) {
      // Int0..IntF: latch the interrupt for the host to drain.
      ts.pendingInterrupts |= 1 << (note - 0x0010);
    } else {
      if (toneG && voice.active) {
        // Tone porta: target the note, do not retrigger sample.
        voice.tonePortaTarget = note;
        // Inst byte on a porta row reloads the default volume + clears fade state
        // without retriggering (Schism csf_instrument_change semantics), and
        // RE-ATTACKS the envelopes: the instrument byte is what makes a porta
        // row after a key-off audible again (item 124). FT2 runs its whole
        // retrigEnvelopeVibrato here — envelope playheads back to node 0,
        // sustain re-armed, fadeout reset — and only the sample position stays
        // put. Without the playhead half, a release that had already decayed
        // stayed decayed and swallowed the note.
        if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
          voice.instrumentId = row.instrment;
          const newInst = eng.instruments[voice.instrumentId];
          const newPatch = newInst.resolvePatch(voice.noteVal,
            narrowVolAxis(ts, voice.noteVolume));
          applyInstrumentChange(eng, ts, voice, newInst, newPatch, true);
        }
      } else if (row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd) {
        // Note delay: defer trigger; NNA fires when the deferred trigger executes.
        voice.noteDelayTick = (row.effectArg >>> 8) & 0xf;
        voice.delayedNote = note;
        voice.delayedInst = row.instrment;
        // Only a SEL_SET vol cell is an override on the deferred trigger.
        voice.delayedVol = row.volumeEff === 0 ? row.volume : -1;
        scheduleDxnyAction(voice, row, sDelayTick);
      } else {
        applyDuplicateCheck(eng, ts, vi, row.instrment, note);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, note, row.instrment, trigVol);
        scheduleDxnyAction(voice, row, sDelayTick);
      }
    }

    // ── Volume / pan columns ──
    applyVolColumn(ts, voice, row.volume, row.volumeEff);
    if (ts.wideCells) applyPanColumnWide(ts, voice, row);
    else applyPanColumn(ts, voice, row.pan, row.panEff);

    // ── Effect columns ──
    // A wide cell carries two, applied in order, so the second lands last where
    // both write the same channel state.
    applyEffectRow(eng, ts, playhead, voice, vi, row.effect, row.effectArg);
    if (ts.wideCells && row.effect2 !== 0) {
      applyEffectRow(eng, ts, playhead, voice, vi, row.effect2, row.effectArg2);
    }
  }
}

// Shared "instrument byte without retrigger" path (no-note-inst and porta+inst rows).
// `reAttack` additionally rewinds the four envelope playheads the way a fresh
// trigger does (triggerNote), WITHOUT touching the sample position — the porta
// row's half of FT2 retrigEnvelopeVibrato. A note-less instrument byte does not
// re-attack: FT2 leaves such a row decaying, and re-arming its sustain would
// hold a released note up for ever.

function applyInstrumentChange(eng, ts, voice, newInst, newPatch, reAttack = false) {
  applyActiveSample(voice, newInst, newPatch);
  const seedVol = rowVolumeFromDefault(newInst, newPatch, ts.volMax);
  voice.noteVolume = seedVol;
  voice.rowVolume = seedVol;
  voice.keyOff = false;
  voice.noteFading = false;
  voice.fadeoutVolume = 1.0;
  if (!reAttack) return;
  voice.envIndex = 0;
  voice.envTimeSec = 0.0;
  voice.envVolume = clamp(voice.activeVolEnv[0].value / 63.0, 0.0, 1.0);
  // envVolMix is deliberately NOT snapped here (item 142). This re-attack does
  // not restart the sample and arms no attack ramp, so snapping the smoothed
  // envelope steps the gain mid-waveform — a tone portamento onto a note whose
  // envelope starts below where the last one had got to clicks, every time. The
  // per-sample glide (envVolStep, re-armed each tick) walks it to node 0
  // instead. A FRESH trigger still snaps, in triggerNote, because there the
  // sample restarts from zero and the attack ramp covers the discontinuity.
  voice.envPanIndex = 0;
  voice.envPanTimeSec = 0.0;
  voice.envPan = voice.activePanEnv[0].value / 255.0;
  voice.hasPanEnv = envPresent(voice.activePanEnvLoop);
  // Pitch / filter envelope seeds — settle past leading zero-duration nodes.
  if (voice.hasPitchEnv) {
    voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
      voice.activePitchEnvSustain);
    voice.envPitchIndex = pfIdxBox[0];
    voice.envPitchTimeSec = pfTimeBox[0];
  } else {
    voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
  }
  if (voice.hasFilterEnv) {
    voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
      voice.activeFilterEnvSustain);
    voice.envFilterIndex = pfIdxBox[0];
    voice.envFilterTimeSec = pfTimeBox[0];
  } else {
    voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
  }
}

function advanceTrackerCue(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  if (cue.isHalt()) { playhead.isPlaying = false; return; }
  const instr = cue.flowInstruction();
  switch (instr.type) {
    case INST_GOBACK: ts.cuePos = Math.max(ts.cuePos - instr.arg, 0); break;
    case INST_SKIP: ts.cuePos = Math.min(ts.cuePos + instr.arg, NUM_CUES - 1); break;
    case INST_JUMP: ts.cuePos = clamp(instr.arg, 0, NUM_CUES - 1); break;
    default: ts.cuePos = Math.min(ts.cuePos + 1, NUM_CUES - 1); break;
  }
  playhead.position = ts.cuePos;
}

/**
 * Rebuild each voice's Pattern-Ditto (effect 7) arm state as if the current
 * cue's pattern had been played from row 0 up to (but NOT including) startRow.
 * This lets playback that STARTS mid-pattern on a ghosted (repeated) row still
 * sound it — the ghost cells are painted from the same static expansion but the
 * engine only re-derives them at play time once dittoActive is set on the
 * arming row, so seeking past the arm left the ghosts silent (item 81).
 *
 * Faithful mirror of the arm branch in applyTrackerRow (reads RAW rows only, so
 * cascaded/re-armed regions resolve exactly like the running engine); call it
 * right after the play-time voice reset in setTrackerRow. [needs the same TSVM
 * + taut.js fix].
 */
function reconstructDittoState(eng, ts, startRow) {
  const cue = eng.cueSheet[ts.cuePos];
  const patLen = cue.rowLimit();
  const limit = Math.min(startRow, patLen);
  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const voice = ts.voices[vi];
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rows = eng.patternRead(patIdx);
    for (let n = 0; n < limit; n++) {
      const rawRow = rows[n];
      if (rawRow.effect !== EffectOp.OP_7 || rawRow.effectArg === 0) continue;
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave a previously-armed ditto alone.
    }
  }
}

/** Per-pattern voice state reset (S$Bx loop counters + ditto), on every cue advance. */
function resetPatternLoopState(ts) {
  for (const voice of ts.voices) {
    voice.loopStartRow = 0;
    voice.loopCount = 0;
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
  }
}

/**
 * Advance to the next row: resolves pending B/C jumps and pattern-delay repeats.
 * Called once when tickInRow has just wrapped past tickRate.
 */
function advanceRow(eng, ts, playhead) {
  // Pattern delay (S$Ex): replay the same row patternDelayRemaining more times.
  if (ts.patternDelayRemaining > 0) {
    ts.patternDelayRemaining--;
    ts.patternDelayActive = true;
    applyTrackerRow(eng, ts, playhead);
    return;
  }
  ts.patternDelayActive = false;

  const pendingB = ts.pendingOrderJump;
  const pendingC = ts.pendingRowJump;
  const pendingLocal = ts.pendingRowJumpLocal;
  ts.pendingOrderJump = -1;
  ts.pendingRowJump = -1;
  ts.pendingRowJumpLocal = false;

  if (pendingB >= 0) {
    ts.cuePos = Math.min(pendingB, NUM_CUES - 1);
    ts.rowIndex = pendingC >= 0 ? pendingC : 0;
    playhead.position = ts.cuePos;
    resetPatternLoopState(ts);
  } else if (pendingC >= 0 && pendingLocal) {
    // S$Bx pattern loop — stay in the current cue, rewind the row.
    ts.rowIndex = clamp(pendingC, 0, 63);
  } else if (pendingC >= 0) {
    // C$xx pattern break — advance cue then jump to row.
    advanceTrackerCue(eng, ts, playhead);
    ts.rowIndex = clamp(pendingC, 0, 63);
    resetPatternLoopState(ts);
  } else {
    ts.rowIndex++;
    // LEN / "halt at x" shorten the effective row count.
    const rowLimit = eng.cueSheet[ts.cuePos].rowLimit();
    if (ts.rowIndex >= rowLimit) {
      ts.rowIndex = 0;
      advanceTrackerCue(eng, ts, playhead);
      resetPatternLoopState(ts);
    }
  }
  applyTrackerRow(eng, ts, playhead);
}

// ══ src/engine/tick.js ══
// Per-tick voice processing — port of AudioAdapter.kt applyTrackerTick (3689-4087).
//
// CRITICAL: after a mid-tick note-delay trigger (S$Dx) fires, the local `inst`
// binding MUST be re-fetched — triggerNote may have swapped the voice's
// instrument, and the rest of the tick (playback-rate recompute, envelopes,
// fadeout) must see the instrument that just fired (AudioAdapter.kt:3727-3733).










/** Scratch [azimuth, elevation] for the Z slide — one voice steps at a time. */
const spatialStep = new Float64Array(2);

function applyTrackerTick(eng, ts, playhead) {
  const tickSec = 2.5 / playhead.bpm;
  // Samples-per-tick — used to spread the per-tick envVolume jump across the
  // upcoming tick interval. Recomputed every tick (BPM can change mid-row).
  const spt = SAMPLING_RATE * tickSec;
  for (let vi = 0; vi < ts.voices.length; vi++) {
    const voice = ts.voices[vi];
    if (!voice.active && voice.noteDelayTick < 0 && voice.noteActionTick < 0) continue;
    let inst = eng.instruments[voice.instrumentId];

    // Note cut: zero noteVolume/rowVolume, leave channelVolume alone.
    if (voice.cutAtTick === ts.tickInRow) {
      voice.noteVolume = 0;
      voice.rowVolume = 0;
      voice.noteWasCut = true;
    }

    // Note delay — fire the deferred event when the requested tick arrives.
    if (voice.noteDelayTick === ts.tickInRow) {
      switch (voice.delayedNote) {
        case 0x0001: // delayed KEY_OFF
          voice.keyOff = true;
          applyKeyLift(voice, eng.instruments[voice.instrumentId]);
          break;
        case 0x0002: // delayed note cut
          startCutRamp(voice);
          cutLayerChildren(ts, vi);
          break;
        case 0x0003: // delayed note fade
          voice.noteFading = true;
          break;
        case 0x0004: // delayed fast fade
          startFastFade(voice, playhead);
          break;
        default:
          applyDuplicateCheck(eng, ts, vi, voice.delayedInst, voice.delayedNote);
          maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
          triggerMetaOrNote(eng, ts, voice, vi, voice.delayedNote, voice.delayedInst, voice.delayedVol);
          break;
      }
      voice.noteDelayTick = -1;
      // Re-bind: triggerNote may have swapped in a new instrument (see header note).
      inst = eng.instruments[voice.instrumentId];
    }

    // S$Dxny follow-up action — fires $y ticks after the (possibly deferred)
    // trigger, independent of whether that trigger left the voice active.
    if (voice.noteActionTick === ts.tickInRow) {
      switch (voice.delayedAction) {
        case 0: // Note off
          voice.keyOff = true;
          applyKeyLift(voice, eng.instruments[voice.instrumentId]);
          break;
        case 1: // Note cut
          startCutRamp(voice);
          cutLayerChildren(ts, vi);
          break;
        case 2: // Note continue — no-op.
          break;
        case 3: // Note fade
          voice.noteFading = true;
          break;
        case 4: // Key lift — forced, bypasses the instrument's own flag.
          voice.keyOff = true;
          forceKeyLift(voice);
          break;
      }
      voice.noteActionTick = -1;
      inst = eng.instruments[voice.instrumentId];
    }

    if (!voice.active) {
      advanceEnvelope(voice, tickSec);
      voice.envVolStep = spt > 0.0 ? (voice.envVolume - voice.envVolMix) / spt : 0.0;
      continue;
    }

    // Pitch slides (E/F coarse on tick > 0).
    if (ts.tickInRow > 0 && (voice.slideMode === 1 || voice.slideMode === 2)) {
      let nv;
      if (ts.toneMode === 1) nv = amigaSlideTick(voice, voice.slideArg);
      else if (ts.toneMode === 2) nv = linearFreqSlideTick(voice, voice.slideArg);
      else nv = voice.noteVal + voice.slideArg;
      voice.noteVal = clamp(nv, 0x20, 0xffff);
      voice.basePitch = voice.noteVal;
    }

    // Tone portamento (G).
    if (voice.tonePortaTarget >= 0 && ts.tickInRow > 0) {
      const target = voice.tonePortaTarget;
      const sp = voice.tonePortaSpeed;
      if (ts.toneMode === 2) {
        if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal);
        const targetFreq = noteValToFreqHz(target);
        const dir = targetFreq > voice.linearFreq ? +1.0 : -1.0;
        voice.linearFreq += dir * sp;
        if ((dir > 0 && voice.linearFreq >= targetFreq) ||
            (dir < 0 && voice.linearFreq <= targetFreq)) {
          voice.linearFreq = targetFreq;
          voice.noteVal = target;
          voice.tonePortaTarget = -1;
        } else {
          voice.noteVal = clamp(freqHzToNoteVal(voice.linearFreq), 0x20, 0xffff);
        }
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0;
      } else {
        const delta = target > voice.noteVal ? sp : -sp;
        voice.noteVal += delta;
        if ((delta > 0 && voice.noteVal >= target) || (delta < 0 && voice.noteVal <= target)) {
          voice.noteVal = target;
          voice.tonePortaTarget = -1;
        }
        voice.basePitch = voice.noteVal;
        voice.amigaPeriod = -1.0; // porta works in linear noteVal space
        voice.linearFreq = -1.0;
      }
    }

    // Volume slides (D coarse on tick > 0).
    if (ts.tickInRow > 0 && voice.slideMode === 5) {
      voice.noteVolume = clamp(voice.noteVolume + voice.slideArg * ts.volStep, 0, ts.volMax);
      voice.rowVolume = voice.noteVolume;
    }

    // Vol-col slides (selectors 1/2) + N coarse slide + pan-col slides.
    if (ts.tickInRow > 0) {
      if (voice.volColSlideUp !== 0) {
        voice.noteVolume = Math.min(voice.noteVolume + voice.volColSlideUp, ts.volMax);
        voice.rowVolume = voice.noteVolume;
      }
      if (voice.volColSlideDown !== 0) {
        voice.noteVolume = Math.max(voice.noteVolume - voice.volColSlideDown, 0);
        voice.rowVolume = voice.noteVolume;
      }
      if (voice.nSlideDir !== 0) {
        voice.channelVolume = clamp(voice.channelVolume + voice.nSlideDir * ts.volStep, 0, ts.volMax);
      }
      // The panning column slides the NOTE axis, as its SET does (item 117);
      // P slides the CHANNEL axis, as S $80xx sets it.
      if (voice.panColSlideRight !== 0) {
        applyNotePanSlide(ts, voice, voice.panColSlideRight);
      }
      if (voice.panColSlideLeft !== 0) {
        applyNotePanSlide(ts, voice, -voice.panColSlideLeft);
      }
      if (voice.chanPanSlideRight !== 0) {
        applyPanSlide(ts, voice, voice.chanPanSlideRight);
      }
      if (voice.chanPanSlideLeft !== 0) {
        applyPanSlide(ts, voice, -voice.chanPanSlideLeft);
      }
      // Spherical panning slide (Z, #998.2): one great-circle step per non-first
      // tick, at $xxx/16 azimuth units — X's units, so /8 in the engine's.
      if (voice.spatialSlideActive) {
        stepTowardTarget(
          voice.panAzimuth, voice.panElevation,
          voice.spatialTargetAz, voice.spatialTargetEl,
          voice.mem.z / 8, spatialStep,
        );
        applyPanSet(ts, voice, spatialStep[0]);
        voice.panElevation = spatialStep[1];
      }
    }

    // Tremor (I) — gates output volume.
    if (voice.tremorOn !== 0) {
      voice.tremorTickInPhase++;
      const limit = voice.tremorPhaseOn ? voice.tremorOnTime : voice.tremorOffTime;
      if (voice.tremorTickInPhase >= limit) {
        voice.tremorTickInPhase = 0;
        voice.tremorPhaseOn = !voice.tremorPhaseOn;
      }
      if (!voice.tremorPhaseOn) voice.rowVolume = 0;
    }

    // Vibrato (H/U) — base-pitch overlay.
    let pitchToMixer = voice.noteVal;
    if (voice.vibratoActive) {
      const sine = lfoSampleWide(voice.vibratoLfoPos, voice.vibratoWave);
      const pitchDelta = (sine * voice.mem.huDepth) >> voice.vibratoFineShift;
      pitchToMixer = clamp(voice.noteVal + pitchDelta, 0x20, 0xffff);
      voice.vibratoLfoPos = advanceLfoPhase(voice.vibratoLfoPos, voice.mem.huSpeed);
    }

    // Glissando (S$1x) — snap pitchToMixer to nearest semitone (noteVal stays smooth).
    if (voice.glissandoOn) {
      const semis = Math.trunc((pitchToMixer * 12 + 2048) / 4096);
      pitchToMixer = clamp(Math.trunc((semis * 4096) / 12), 0x20, 0xffff);
    }

    // Tremolo (R) — modulates rowVolume around noteVolume (IT semantics).
    if (voice.tremoloActive) {
      const sine = lfoSampleWide(voice.tremoloLfoPos, voice.tremoloWave);
      const volDelta = (sine * voice.mem.rDepth) >> 9;
      voice.rowVolume = clamp(voice.noteVolume + volDelta * ts.volStep, 0, ts.volMax);
      voice.tremoloLfoPos = advanceLfoPhase(voice.tremoloLfoPos, voice.mem.rSpeed);
    }

    // Panbrello (Y) — a signed offset onto the mixer's pan sum. The shift is 7,
    // not the 9 the 6-bit pan register wanted, because the sum it joins is the
    // 8-bit one; the swing per depth unit is the same.
    //
    // The zero case belongs HERE and not in the per-row reset: a row boundary
    // runs applyTrackerRow AFTER this pass (mixer.js), so a value cleared there
    // stays cleared for the whole of the new row's first tick — which is one
    // tick of dead-centre in the middle of a sweep that spans several rows.
    if (voice.panbrelloActive) {
      const sine = lfoSampleWide(voice.panbrelloLfoPos, voice.panbrelloWave);
      voice.panbrelloOffset = (sine * voice.mem.yDepth) >> 7;
      voice.panbrelloLfoPos = advanceLfoPhase(voice.panbrelloLfoPos, voice.mem.ySpeed);
    } else {
      voice.panbrelloOffset = 0;
    }

    // Arpeggio (J) — overrides pitchToMixer for this tick.
    if (voice.arpActive) {
      const voiceIdx = ts.tickInRow % 3;
      const arpDelta = voiceIdx === 1 ? voice.arpOff1 << 8 : voiceIdx === 2 ? voice.arpOff2 << 8 : 0;
      pitchToMixer = clamp(voice.basePitch + arpDelta, 0x20, 0xffff);
      voice.lastArpVoice = voiceIdx;
    }

    // Q retrigger.
    if (voice.retrigActive && !voice.noteWasCut) {
      voice.retrigCounter++;
      if (voice.retrigCounter >= voice.retrigInterval) {
        voice.retrigCounter = 0;
        voice.samplePos = voice.activeSamplePlayStart; // patch-aware
        voice.keyOff = false;
        voice.envIndex = 0; voice.envTimeSec = 0.0;
        voice.envPanIndex = 0; voice.envPanTimeSec = 0.0;
        voice.envPan = voice.activePanEnv[0].value / 255.0;
        // Re-seed pf-envs past leading zero-duration nodes (as at fresh trigger).
        if (voice.hasPitchEnv) {
          voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
            voice.activePitchEnvSustain);
          voice.envPitchIndex = pfIdxBox[0]; voice.envPitchTimeSec = pfTimeBox[0];
        } else {
          voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
        }
        if (voice.hasFilterEnv) {
          voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
            voice.activeFilterEnvSustain);
          voice.envFilterIndex = pfIdxBox[0]; voice.envFilterTimeSec = pfTimeBox[0];
        } else {
          voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
        }
        voice.fadeoutVolume = 1.0;
        voice.autoVibPhase = 0;
        voice.autoVibTicksSinceTrigger = 0;
        voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0;
        voice.right.reset();
        voice.noteVolume = applyRetrigVolMod(voice.noteVolume, voice.retrigVolMod, ts.volStep, ts.volMax);
        voice.rowVolume = voice.noteVolume;
      }
    }

    // Auto-vibrato — added on top of pitchToMixer.
    const autoVibDelta = advanceAutoVibrato(voice, inst);

    // Pitch envelope contribution (±16 semitones full-scale; Schism sndmix.c:455-462).
    const pitchEnvDelta = voice.hasPitchEnv && voice.pitchEnvOn
      ? Math.trunc(((voice.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
      : 0;

    const finalPitch = clamp(pitchToMixer + autoVibDelta + pitchEnvDelta, 0x20, 0xffff);
    voice.playbackRate = computePlaybackRate(voice, finalPitch, ts.tuningRatio);
    voice.renderPitch = finalPitch; // display tap (Timeline header per-tick pitch)

    // Filter envelope: currentCutoff = baseCut × envFilterValue (0.5 = unity at IFC).
    if (voice.hasFilterEnv && voice.filterEnvOn) {
      if (voice.filterSfMode) {
        const baseCut = voice.activeDefaultCutoff < 0xffff ? voice.activeDefaultCutoff : 13500;
        voice.currentCutoff = clamp(Math.trunc(baseCut * voice.envFilterValue), 0, 0xffff);
      } else {
        const baseCut = voice.activeDefaultCutoff < 255 ? voice.activeDefaultCutoff : 254;
        voice.currentCutoff = clamp(Math.trunc(baseCut * voice.envFilterValue), 0, 254);
      }
    }

    // Refresh filter coefficients once per tick (recomputes only when changed).
    refreshVoiceFilter(voice);

    // Volume fadeout: after key-off OR Note-Fade NNA, decrement per tick.
    if (voice.keyOff || voice.noteFading) {
      const fadeStep = voice.activeFadeoutStep;
      if (fadeStep > 0) {
        voice.fadeoutVolume = Math.max(voice.fadeoutVolume - fadeStep / 1024.0, 0.0);
        if (voice.fadeoutVolume <= 0.0) voice.active = false;
      }
    }

    advanceEnvelope(voice, tickSec);
    // Per-sample slope so envVolMix walks smoothly to the new envVolume.
    voice.envVolStep = spt > 0.0 ? (voice.envVolume - voice.envVolMix) / spt : 0.0;
    advancePitchEnvelope(voice, tickSec);
    advanceFilterEnvelope(voice, tickSec);
  }

  // Tempo slide — applied once per tick at the playhead level.
  for (const voice of ts.voices) {
    if (voice.tempoSlideDir !== 0 && ts.tickInRow > 0) {
      const tempoByte = clamp(
        playhead.bpm - 0x19 + voice.tempoSlideDir * voice.tempoSlideAmount, 0, 0xff);
      playhead.bpm = clamp(tempoByte + 0x19, 25, 280);
    }
  }

  // Global volume slide (W coarse) — once per non-first tick per armed channel.
  if (ts.tickInRow > 0) {
    for (const voice of ts.voices) {
      if (voice.wSlideDir !== 0) {
        playhead.globalVolume = clamp(
          playhead.globalVolume + voice.wSlideDir * voice.wSlideAmount, 0, 0xff);
      }
    }
  }

  // Funk repeat (S$Fx) — advance the per-instrument XOR mask (PT2 updateFunk).
  for (const voice of ts.voices) {
    if (voice.funkSpeed === 0 || !voice.active) continue;
    const inst = eng.instruments[voice.instrumentId];
    // ACTIVE loop, not the base record's — an Ixmp patch brings its own (item 116).
    if (voice.activeSampleLoopEnd <= voice.activeSampleLoopStart) continue;
    voice.funkAccumulator += voice.funkSpeed;
    if (voice.funkAccumulator >= 0x80) {
      voice.funkAccumulator = 0;
      const loopLen = Math.max(
        voice.activeSampleLoopEnd - voice.activeSampleLoopStart, 1);
      voice.funkWritePos = (voice.funkWritePos + 1) % loopLen;
      inst.toggleFunkBit(voice.funkWritePos, loopLen);
    }
  }

  // Sample modification (notefx 2 / 3) — one step of the instrument's live
  // operation per accumulator overflow, on the same >= $80 ladder funk repeat
  // walks (item 130).
  for (const voice of ts.voices) {
    if (voice.modSpeed === 0 || !voice.active) continue;
    const inst = eng.instruments[voice.instrumentId];
    if (inst.modOp === MOD_OFF) continue;
    const es = inst.modStart >= 0 ? inst.modStart : voice.activeSampleLoopStart;
    const ee = inst.modStart >= 0 ? inst.modEnd : voice.activeSampleLoopEnd;
    if (ee <= es) continue;
    voice.modAccumulator += voice.modSpeed;
    if (voice.modAccumulator < 0x80) continue;
    voice.modAccumulator = 0;
    const sampleLen = Math.max(voice.activeSampleLength, 1);
    const step = MOD_STEP[inst.modOp];
    if (inst.modOp === MOD_FUNK) {
      // Walk to the next byte the region actually touches and flip it. An
      // inverted region can exclude a long stretch, so the scan is bounded —
      // past MOD_WALK_SCAN misses this step simply does not land.
      const span = inst.modInvert ? sampleLen : ee - es;
      const base = inst.modInvert ? 0 : es;
      for (let n = 0; n < MOD_WALK_SCAN; n++) {
        voice.modWritePos = (voice.modWritePos + 1) % Math.max(span, 1);
        const i = base + voice.modWritePos;
        if (modTouches(inst, i, es, ee)) { inst.toggleModBit(i, sampleLen); break; }
      }
    } else if (isRolOp(inst.modOp)) {
      const dl = inst.modInvert ? sampleLen : ee - es;
      if (dl > 1) {
        inst.modRot = (inst.modRot + step) % dl;
        inst.modOn = inst.modRot !== 0;
      }
    } else {
      inst.modSub = (inst.modSub + step) & 0xff;
      inst.modOn = inst.modSub !== 0;
    }
  }

  // Background (NNA-ghost) voices: passive maintenance only.
  for (let i = ts.backgroundVoices.length - 1; i >= 0; i--) {
    const bg = ts.backgroundVoices[i];
    if (!bg.active) { ts.backgroundVoices.splice(i, 1); continue; }
    // Layer child: re-sync pitch / key-off / volume / pan from the parent each tick.
    if (bg.isLayerChild) {
      const parent = bg.sourceChannel >= 0 && bg.sourceChannel < ts.voices.length
        ? ts.voices[bg.sourceChannel] : null;
      if (parent === null || !parent.active) {
        // Parent ended. If it was RELEASED and its fast fadeout deactivated it in
        // the SAME tick the release fired, the sync below never ran — inherit the
        // release before detaching (the meta KEY_OFF race fix; AudioAdapter.kt:4020-4035).
        if (parent !== null && !bg.keyOff && !bg.noteFading) {
          if (parent.keyOff) {
            bg.keyOff = true;
            applyKeyLift(bg, eng.instruments[bg.instrumentId]);
          } else if (parent.noteFading) {
            bg.noteFading = true;
          }
        }
        bg.isLayerChild = false;
      } else {
        bg.noteVal = clamp(parent.noteVal + bg.layerRelDetune, 0x20, 0xffff);
        bg.basePitch = bg.noteVal;
        bg.amigaPeriod = -1.0;
        bg.linearFreq = -1.0;
        if (parent.keyOff && !bg.keyOff) {
          bg.keyOff = true;
          applyKeyLift(bg, eng.instruments[bg.instrumentId]);
        }
        if (parent.noteFading && !bg.noteFading) bg.noteFading = true;
        bg.channelVolume = parent.channelVolume;
        bg.noteVolume = parent.noteVolume;
        bg.rowVolume = parent.rowVolume;
        bg.channelPan = parent.channelPan;
        bg.rowPan = parent.rowPan;
        bg.panbrelloOffset = parent.panbrelloOffset;
        bg.panAzimuth = parent.panAzimuth;
        bg.panElevation = parent.panElevation;
        // Both axes follow the parent, the note axis carrying each layer's own
        // offset from the meta's centre with it (item 118) — the exact shape of
        // the pitch resync above, `parent + relative`. So the pattern's panning
        // column and S $80xx reach every layer, AND a kit whose layers pan
        // apart stays apart for the whole note instead of collapsing onto
        // layer 0 at the first tick.
        bg.notePan = boundNotePan(ts, parent.notePan + bg.layerRelPan);
        bg.noteElevation = parent.noteElevation + bg.layerRelElevation;
      }
    }
    const inst = eng.instruments[bg.instrumentId];
    advanceEnvelope(bg, tickSec);
    bg.envVolStep = spt > 0.0 ? (bg.envVolume - bg.envVolMix) / spt : 0.0;
    advancePitchEnvelope(bg, tickSec);
    advanceFilterEnvelope(bg, tickSec);
    if (bg.keyOff || bg.noteFading) {
      const fadeStep = bg.activeFadeoutStep;
      if (fadeStep > 0) {
        bg.fadeoutVolume = Math.max(bg.fadeoutVolume - fadeStep / 1024.0, 0.0);
      }
    }
    // Auto-vibrato keeps running on backgrounds.
    const autoVibDelta = advanceAutoVibrato(bg, inst);
    const pitchEnvDelta = bg.hasPitchEnv && bg.pitchEnvOn
      ? Math.trunc(((bg.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0) / 12.0)
      : 0;
    const finalPitch = clamp(bg.noteVal + autoVibDelta + pitchEnvDelta, 0x20, 0xffff);
    bg.playbackRate = computePlaybackRate(bg, finalPitch, ts.tuningRatio);
    bg.renderPitch = finalPitch; // display tap (per-tick pitch)
    // Filter envelope — MUST branch on SF mode too (cents vs IT byte range).
    if (bg.hasFilterEnv && bg.filterEnvOn) {
      if (bg.filterSfMode) {
        const baseCut = bg.activeDefaultCutoff < 0xffff ? bg.activeDefaultCutoff : 13500;
        bg.currentCutoff = clamp(Math.trunc(baseCut * bg.envFilterValue), 0, 0xffff);
      } else {
        const baseCut = bg.activeDefaultCutoff < 255 ? bg.activeDefaultCutoff : 254;
        bg.currentCutoff = clamp(Math.trunc(baseCut * bg.envFilterValue), 0, 254);
      }
    }
    refreshVoiceFilter(bg);
    // Reap fully-faded ghosts.
    if ((bg.keyOff || bg.noteFading) && bg.fadeoutVolume <= 0.0) {
      bg.active = false;
      ts.backgroundVoices.splice(i, 1);
    }
  }
}

// ══ src/engine/mixer.js ══
// Mixer + output quantiser — port of AudioAdapter.kt generateTrackerAudio
// (4128-4315) and pcm32fToPcm8 (839-873).
//
// The mix bus is Float32 (ts.mixLeft/mixRight Float32Array; typed-array stores
// round like Kotlin's .toFloat()). pcm32fToPcm8 runs Kotlin-Float semantics via
// Math.fround at every arithmetic step, and draws its TPDF dither from the
// engine's seeded xorshift32 stream — so the U8 output is deterministic.









const fround = Math.fround;

/** Scratch pair for fetchTrackerSampleStereo — one voice is mixed at a time. */
const stereoPair = [0.0, 0.0];

/**
 * One voice's contribution as a [left, right] PAIR, before pan and gain.
 * Mono voices put the same sample on both sides, which is what makes the
 * stereo path a strict generalisation: a stereo sample whose channels are
 * identical mixes bit-for-bit like the mono sample it was made from.
 *
 * Channel mode 0 (discrete) is the sample's own L,R. Mode 1 (matrix) holds
 * M,S and decodes L = M+S, R = M−S — the inverse of the M=(L+R)/2,
 * S=(L−R)/2 encoding. The decode happens BEFORE the filter and the voice FX
 * so those act on speaker feeds (the filter is linear so its result is the
 * same either way; the bitcrusher/overdrive are not, and crushing a speaker
 * feed is the sane reading). In a surround song the pair is not a pair of
 * speaker feeds at all — spatial.js places each channel as its own source at
 * the ITU angle for the sample's channel count (#998.0). Anything not
 * stereo-shaped stays mono here.
 */
function renderVoicePair(eng, voice, inst, interpMode, out) {
  if (voice.activeChanCount !== 2) {
    const s = applyTaudVoiceFx(voice, applyVoiceFilter(voice,
      fetchTrackerSample(eng, voice, inst, interpMode)));
    out[0] = s;
    out[1] = s;
    return out;
  }
  fetchTrackerSampleStereo(eng, voice, inst, interpMode, out);
  let c0 = out[0], c1 = out[1];
  if (voice.activeChanMode === CHAN_MODE_MATRIX) {
    const m = c0, s = c1;
    c0 = m + s;
    c1 = m - s;
  }
  out[0] = applyTaudVoiceFx(voice, applyVoiceFilter(voice, c0));
  out[1] = applyTaudVoiceFx(voice, applyVoiceFilter(voice, c1, voice.right), voice.right);
  return out;
}

/** urand: (xorshift32() & 0xFFFFFF) / 16777216 — exact in Float32. */
function urand(eng) {
  return (eng.xorshift32() & 0xffffff) / 16777216.0;
}

/** TPDF noise in [-1, +1) — difference of two urands, exact in Float32. */
function tpdf1(eng) {
  return urand(eng) - urand(eng);
}

/**
 * Noise-shaped dither 32f → interleaved U8, writing into out (length ≥ 2·sampleCount).
 * State: eng.ditherError = Float32Array(4) [L0, L1, R0, R1].
 */
function pcm32fToPcm8(eng, fleft, fright, sampleCount, out) {
  const b1 = 1.5;
  const b2 = -0.75;
  const scale = 127.5;
  const bias = 128;
  const ditherScale = 0.2; // fround(0.2) applied at the multiply below
  const err = eng.ditherError;

  for (let i = 0; i < sampleCount; i++) {
    // --- LEFT channel ---
    const feedbackL = fround(fround(b1 * err[0]) + fround(b2 * err[1]));
    const ditherL = fround(fround(ditherScale) * tpdf1(eng));
    let shapedL = fround(fround(fleft[i] + feedbackL) + fround(ditherL / scale));
    shapedL = shapedL < -1.0 ? -1.0 : shapedL > 1.0 ? 1.0 : shapedL;

    let qL = Math.round(fround(shapedL * scale));
    qL = qL < -128 ? -128 : qL > 127 ? 127 : qL;
    out[i * 2] = (qL + bias) & 0xff;

    const qerrL = fround(shapedL - fround(qL / scale));
    err[1] = err[0];
    err[0] = qerrL;

    // --- RIGHT channel ---
    const feedbackR = fround(fround(b1 * err[2]) + fround(b2 * err[3]));
    const ditherR = fround(fround(ditherScale) * tpdf1(eng));
    let shapedR = fround(fround(fright[i] + feedbackR) + fround(ditherR / scale));
    shapedR = shapedR < -1.0 ? -1.0 : shapedR > 1.0 ? 1.0 : shapedR;

    let qR = Math.round(fround(shapedR * scale));
    qR = qR < -128 ? -128 : qR > 127 ? 127 : qR;
    out[i * 2 + 1] = (qR + bias) & 0xff;

    const qerrR = fround(shapedR - fround(qR / scale));
    err[3] = err[2];
    err[2] = qerrR;
  }
}

/**
 * Render one 512-frame chunk for playhead into out (Uint8Array(1024), interleaved
 * U8 L,R). Returns null when the playhead has no tracker state.
 */
function generateTrackerAudio(eng, playhead, out) {
  const ts = playhead.trackerState;
  if (ts === null) return null;

  // Jam mode mixes voices without advancing rows/cues.
  const advancing = playhead.isPlaying;
  // Stem-export tap (item 93) — null on every playback path. See TaudEngine.stemBus.
  const stems = eng.stemBus;
  // Surround object bus (#998) — null for the stereo model, which keeps the
  // plain mixL/mixR accumulators below and stays bit-exact against the JVM.
  const spatial = ts.spatial;
  if (spatial !== null) spatial.clear();
  // Master-strip analysis tap (item 98) — null unless the strip is on screen.
  // Its bus is null for a stereo song, whose tap is taken from the finished
  // mix below, so the legacy path stays exactly as it was.
  const analysis = ts.analysis;
  const abus = analysis === null ? null : analysis.bus;
  if (analysis !== null) analysis.begin();

  if (advancing && ts.firstRow) {
    ts.firstRow = false;
    applyTrackerRow(eng, ts, playhead);
  }

  // The rate and the Amiga coefficients are settable module bindings (item
  // 108) — read them ONCE per chunk so the per-sample loop below works on
  // plain locals, as it did when they were compile-time constants.
  const srate = SAMPLING_RATE;
  const a500A0 = AMIGA_A500_A0, a500B1 = AMIGA_A500_B1;
  const ledA1 = AMIGA_LED_A1, ledA2 = AMIGA_LED_A2;
  const ledB1 = AMIGA_LED_B1, ledB2 = AMIGA_LED_B2;

  for (let n = 0; n < TRACKER_CHUNK; n++) {
    // Recompute samples-per-tick every iteration (T/T-slide mutate BPM mid-row).
    const spt = (srate * 2.5) / playhead.bpm;
    if (advancing) {
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
        ts.tickInRow++;
        if (ts.tickInRow >= playhead.tickRate + ts.finePatternDelayExtra) {
          ts.tickInRow = 0;
          advanceRow(eng, ts, playhead);
        }
      }
    } else { // jamActive: evolve envelopes only, never advance the song
      ts.samplesIntoTick += 1.0;
      if (ts.samplesIntoTick >= spt) {
        ts.samplesIntoTick -= spt;
        applyTrackerTick(eng, ts, playhead);
      }
    }

    let mixL = 0.0;
    let mixR = 0.0;
    const gvol = playhead.globalVolume / 255.0;
    const mvol = playhead.mixingVolume / 255.0;
    for (let vi = 0; vi < ts.voices.length; vi++) {
      const voice = ts.voices[vi];
      if (!voice.active || voice.fader === 255) {
        // Keep the soundscope flat between notes / while muted.
        voice.scopeBuffer[voice.scopeWritePos] = 0;
        voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
        continue;
      }
      const voiceInst = eng.instruments[voice.instrumentId];
      renderVoicePair(eng, voice, voiceInst, ts.interpolationMode, stereoPair);
      const sL = stereoPair[0];
      const sR = stereoPair[1];
      // Soundscope shows the mono sum — a stereo voice is still one voice.
      const sScope = voice.activeChanCount === 2 ? (sL + sR) * 0.5 : sL;
      const instGv = voiceInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + voice.randomVolBias / 255.0;
      // Per-sample envelope smoothing.
      voice.envVolMix += voice.envVolStep;
      const effEnvVol = voice.volEnvOn ? voice.envVolMix : 1.0;
      advanceVolumeRamp(voice, ts.volDiv);
      advancePitchRamp(voice, spt);
      const faderGain = (255 - voice.fader) / 255.0;
      const perVoiceGain = effEnvVol * voice.fadeoutVolume * voice.currentMixVolume *
        swingScale * instGv * faderGain * voice.layerMixGain * voice.activeAttenGain;
      const globalGain = (gvol * mvol * playhead.masterVolume) / 255.0;
      const vol = perVoiceGain * globalGain;
      // ONE pan ramp, above the branch, because both paths smooth the same
      // composed number: every input to it moves once a TICK while the pan law
      // (and the ambisonic encode) is evaluated every sample, so without this
      // the gain stepped 50 times a second (item 141). Sharing it is also what
      // keeps a planar song rendering identically to its stereo twin.
      let lGain = 0.0;
      let rGain = 0.0;
      if (spatial === null) {
        let pan;
        if (voice.hasPanEnv && voice.panEnvOn) {
          let envPanRaw = Math.round(voice.envPan * 255.0);
          envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
          pan = voice.channelPan + voice.notePan + envPanRaw - 128 + voice.randomPanBias +
            voice.panbrelloOffset;
        } else {
          pan = voice.channelPan + voice.notePan + voice.randomPanBias + voice.panbrelloOffset;
        }
        pan = pan < 0 ? 0 : pan > 255 ? 255 : pan;
        pan = advancePanRamp(voice, pan);
        // equal-energy pan law
        lGain = Math.cos((Math.PI * pan) / 512.0);
        rGain = Math.sin((Math.PI * pan) / 512.0);
      } else {
        advancePanRamp(voice, voiceAzimuth(voice), true);
      }
      // Sample-end ramp-out.
      let rampGain;
      if (voice.rampOutSamples > 0) {
        rampGain = voice.rampOutGain;
        voice.rampOutGain -= voice.rampOutStep;
        voice.rampOutSamples--;
        if (voice.rampOutSamples === 0) voice.active = false;
      } else {
        rampGain = 1.0;
      }
      // Volume ramp for Attack (item 139): half-cosine fade-in folded into the same
      // rampGain, so every downstream use (scope, stems, mix, spatial) picks it up for free.
      if (voice.attackRampSamples > 0) {
        const elapsed = ATTACK_RAMP_SAMPLES - voice.attackRampSamples;
        rampGain *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
        voice.attackRampSamples--;
      }
      voice.scopeBuffer[voice.scopeWritePos] = sScope * perVoiceGain * rampGain;
      voice.scopeWritePos = (voice.scopeWritePos + 1) & (SCOPE_BUFFER_SIZE - 1);
      if (stems !== null) stems.add(voice, vi, n, sScope * vol * rampGain);
      if (spatial === null) {
        mixL += sL * vol * lGain * rampGain;
        mixR += sR * vol * rGain * rampGain;
      } else {
        // One positioned source per sample channel: a stereo sample is a pair
        // of objects sitting ±30° apart, not two speaker feeds (#998.0).
        const g = spatialVoiceGains(spatial, voice);
        spatial.addSource(n, sL * vol, g, 0, rampGain);
        if (voice.activeChanCount === 2) {
          spatial.addSource(n, sR * vol, g, spatial.numChannels, rampGain);
        }
      }
      if (abus !== null) {
        const ag = analysisVoiceGains(abus, voice);
        abus.addSource(n, sL * vol, ag, 0, rampGain);
        if (voice.activeChanCount === 2) {
          abus.addSource(n, sR * vol, ag, abus.numChannels, rampGain);
        }
      }
    }
    // Background (NNA-ghost + metainstrument layer-child) voices.
    for (const bg of ts.backgroundVoices) {
      // Muting a channel must also silence the NNA ghosts and layer children it
      // spawned (item 45): fold the source channel's fader into the bg voice's
      // own, so a channel mute/solo covers everything that came from it.
      const srcVoice = ts.voices[bg.sourceChannel];
      const bgFader = srcVoice && srcVoice.fader > bg.fader ? srcVoice.fader : bg.fader;
      if (!bg.active || bgFader === 255) continue;
      const bgInst = eng.instruments[bg.instrumentId];
      renderVoicePair(eng, bg, bgInst, ts.interpolationMode, stereoPair);
      const sL = stereoPair[0];
      const sR = stereoPair[1];
      const instGv = bgInst.instGlobalVolume / 255.0;
      const swingScale = 1.0 + bg.randomVolBias / 255.0;
      bg.envVolMix += bg.envVolStep;
      const effEnvVol = bg.volEnvOn ? bg.envVolMix : 1.0;
      advanceVolumeRamp(bg, ts.volDiv);
      advancePitchRamp(bg, spt);
      const faderGain = (255 - bgFader) / 255.0;
      const vol = (effEnvVol * bg.fadeoutVolume * bg.currentMixVolume *
        swingScale * gvol * mvol * instGv * faderGain * bg.layerMixGain * bg.activeAttenGain *
        playhead.masterVolume) / 255.0;
      let lGain = 0.0;
      let rGain = 0.0;
      if (spatial === null) {
        let pan;
        if (bg.hasPanEnv && bg.panEnvOn) {
          let envPanRaw = Math.round(bg.envPan * 255.0);
          envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
          pan = bg.channelPan + bg.notePan + envPanRaw - 128 + bg.randomPanBias +
            bg.panbrelloOffset;
        } else {
          pan = bg.channelPan + bg.notePan + bg.randomPanBias + bg.panbrelloOffset;
        }
        pan = pan < 0 ? 0 : pan > 255 ? 255 : pan;
        pan = advancePanRamp(bg, pan);
        lGain = Math.cos((Math.PI * pan) / 512.0);
        rGain = Math.sin((Math.PI * pan) / 512.0);
      } else {
        advancePanRamp(bg, voiceAzimuth(bg), true);
      }
      let rampGain;
      if (bg.rampOutSamples > 0) {
        rampGain = bg.rampOutGain;
        bg.rampOutGain -= bg.rampOutStep;
        bg.rampOutSamples--;
        if (bg.rampOutSamples === 0) bg.active = false;
      } else {
        rampGain = 1.0;
      }
      if (bg.attackRampSamples > 0) {
        const elapsed = ATTACK_RAMP_SAMPLES - bg.attackRampSamples;
        rampGain *= 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / ATTACK_RAMP_SAMPLES);
        bg.attackRampSamples--;
      }
      // Ghosts and layer children belong to the stem of the channel that spawned them.
      if (stems !== null) {
        const sBg = bg.activeChanCount === 2 ? (sL + sR) * 0.5 : sL;
        stems.add(bg, bg.sourceChannel, n, sBg * vol * rampGain);
      }
      if (spatial === null) {
        mixL += sL * vol * lGain * rampGain;
        mixR += sR * vol * rGain * rampGain;
      } else {
        const g = spatialVoiceGains(spatial, bg);
        spatial.addSource(n, sL * vol, g, 0, rampGain);
        if (bg.activeChanCount === 2) {
          spatial.addSource(n, sR * vol, g, spatial.numChannels, rampGain);
        }
      }
      if (abus !== null) {
        const ag = analysisVoiceGains(abus, bg);
        abus.addSource(n, sL * vol, ag, 0, rampGain);
        if (bg.activeChanCount === 2) {
          abus.addSource(n, sR * vol, ag, abus.numChannels, rampGain);
        }
      }
    }

    // Fold the object bus down to the device's pair — for the stereo renderer
    // that IS the mix; another render target hands back its own monitor decode.
    if (spatial !== null) {
      const pair = spatial.stereoAt(n);
      mixL = pair[0];
      mixR = pair[1];
    }

    // Amiga interpolation modes: post-mix LPF chain.
    if (ts.interpolationMode === INTERP_A500) {
      ts.amigaLPStateL = mixL * a500A0 + ts.amigaLPStateL * a500B1;
      ts.amigaLPStateR = mixR * a500A0 + ts.amigaLPStateR * a500B1;
      mixL = ts.amigaLPStateL;
      mixR = ts.amigaLPStateR;
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * ledA1 + sl[0] * ledA2 + sl[1] * ledA1 - sl[2] * ledB1 - sl[3] * ledB2;
        const outR = mixR * ledA1 + sr[0] * ledA2 + sr[1] * ledA1 - sr[2] * ledB1 - sr[3] * ledB2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    } else if (ts.interpolationMode === INTERP_A1200) {
      // The A1200's own 1-pole LPF sits at ~34 kHz — above Nyquist at 32 kHz
      // AND at 48 kHz — so it stays bypassed (pt2-clone).
      if (ts.ledFilterOn) {
        const sl = ts.amigaLEDStateL;
        const sr = ts.amigaLEDStateR;
        const outL = mixL * ledA1 + sl[0] * ledA2 + sl[1] * ledA1 - sl[2] * ledB1 - sl[3] * ledB2;
        const outR = mixR * ledA1 + sr[0] * ledA2 + sr[1] * ledA1 - sr[2] * ledB1 - sr[3] * ledB2;
        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL;
        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR;
        mixL = outL;
        mixR = outR;
      }
    }

    // Double → Float32 (like Kotlin .toFloat()), then clamp in float space.
    const fl = fround(mixL);
    const fr = fround(mixR);
    ts.mixLeft[n] = fl < -1.0 ? -1.0 : fl > 1.0 ? 1.0 : fl;
    ts.mixRight[n] = fr < -1.0 ? -1.0 : fr > 1.0 ? 1.0 : fr;
  }

  // Meters/scopes read the FINISHED pair (post fold/binaural, post Amiga
  // filter, post clamp) and, for a surround target, the analysis bus above.
  if (analysis !== null) analysis.finish(TRACKER_CHUNK, ts.mixLeft, ts.mixRight);

  pcm32fToPcm8(eng, ts.mixLeft, ts.mixRight, TRACKER_CHUNK, out);

  // A halt cue (row.js) clears isPlaying mid-chunk — the transport's OTHER
  // stop, bypassing TaudEngine.stop and its silencing. The rest of THIS chunk
  // still rings out (that is how the song ends, and the chunk is written just
  // above), but what it leaves behind is the same frozen leftover a Stop would
  // have left, waiting for the next jam to resume it. End it here instead.
  if (advancing && !playhead.isPlaying) playhead.silenceSongVoices(playhead.jamActive);

  // Stop the jam-render spin once the audition has gone fully silent.
  if (playhead.jamActive && !playhead.isPlaying &&
      !ts.voices.some((v) => v.active) && !ts.backgroundVoices.some((v) => v.active)) {
    playhead.jamActive = false;
  }

  return out;
}

// ══ src/engine/engine.js ══
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

class TaudEngine {
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
    // Format version 3's 16-byte pattern cell — a whole-file property.
    this.wideCells = false;
    this.playheads = [
      new Playhead(this, 0), new Playhead(this, 1),
      new Playhead(this, 2), new Playhead(this, 3),
    ];
    // Dither state (pcm32fToPcm8): per-adapter xorshift32 + error history.
    this.xorshift32 = makeXorshift32();
    this.ditherError = new Float32Array(4); // [L0, L1, R0, R1]
    // Stem-export tap (item 93; JS-only, no Kotlin counterpart). null on every
    // normal path — playback and the WAV export never set it. When non-null the
    // mixer hands each voice's PRE-PAN mono contribution to `add()`; nothing
    // else about the render changes, so the main output stays bit-identical.
    this.stemBus = null;
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
    if (this.wideCells) {
      const n = Math.min(PATTERN_BYTES_WIDE, bytes.length);
      for (let i = 0; i < n; i++) {
        pat[(i / CELL_BYTES_WIDE) | 0].setByteWide(i % CELL_BYTES_WIDE, bytes[i] & 0xff);
      }
      return;
    }
    const n = Math.min(PATTERN_BYTES, bytes.length);
    for (let i = 0; i < n; i++) pat[(i / CELL_BYTES) | 0].setByte(i % CELL_BYTES, bytes[i] & 0xff);
  }

  /**
   * Select the file format's cell layout (version 3 = the wide cell). A
   * whole-file property: patterns uploaded afterwards are read in this layout,
   * and the volume columns' width follows it. Set it BEFORE uploading anything.
   */
  setCellFormat(wide) {
    this.wideCells = !!wide;
    for (const p of this.playheads) p.trackerState?.setCellFormat(this.wideCells);
  }
  getCellFormat() { return this.wideCells; }

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

  /**
   * Stop the transport, and end the song's voices with it. Clearing isPlaying
   * is all it takes to go SILENT (the mixer runs only while isPlaying or
   * jamActive), but on its own it leaves every voice FROZEN mid-note for
   * whatever turns the mix back on — see Playhead.silenceSongVoices. Ramped
   * while an audition is still sounding, because that mix keeps running;
   * dropped outright otherwise, where nothing renders and nothing is heard.
   */
  stop(ph) {
    const p = this.playheads[ph];
    p.isPlaying = false;
    p.silenceSongVoices(p.jamActive);
  }

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
   *  "mysteriously lingering notes" bug), and the CHANNEL-scope mixer state the
   *  song's own effects write (item 125: pan, elevation, channel volume). The
   *  playhead's tempo/volume are deliberately NOT touched (a replay must keep
   *  the song's tempo — that's why this is not a full resetParams), and neither
   *  is the host's per-channel fader/mute, which belongs to the desk. */
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
      // Channel-scope state, back to the song-start defaults (item 125). A
      // trigger deliberately does NOT reset any of this — pan and channel volume
      // belong to the CHANNEL, not the note — so without a clear here the last
      // S $80xx / M / N / P / X / Z of the previous play was still in force, and
      // a song played twice, or a second file opened on top of the first, panned
      // its notes wherever the last one had left them. Same defaults as
      // resetParams (state.js).
      v.channelVolume = ts.volMax;
      v.channelPan = 0x80;
      v.rowPan = 32;
      v.panAzimuth = 128.0;
      v.panElevation = 0.0;
      v.notePan = 0;
      v.noteElevation = 0.0;
      v.spatialTargetAz = 128.0;
      v.spatialTargetEl = 0.0;
      v.spatialSlideActive = false;
      v.panbrelloOffset = 0;
      v.glissandoOn = false;
      // Per-note S $7x overrides (NNA + the four envelope switches).
      v.nnaOverride = -1;
      v.volEnvOn = true; v.panEnvOn = true; v.pitchEnvOn = true; v.filterEnvOn = true;
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

  /**
   * Song-immutable surround model (#998): 0 stereo, 1 planar (360° panning),
   * 2 spatial. Anything but stereo mixes through the object bus.
   */
  setSurroundModel(ph, model) {
    const p = this.playheads[ph];
    p.surroundModel = model & 3;
    p.applySurroundModel();
  }
  getSurroundModel(ph) { return this.playheads[ph].surroundModel; }

  /**
   * Swap the render target the object bus feeds (#998.0). Null = the device's
   * own monitor (see setMonitorMode); an exporter installs e.g. an
   * AmbisonicRenderer and reads `trackerState.spatial.data` after each chunk.
   * No-op for a stereo song.
   */
  setSpatialRenderer(ph, renderer) {
    const p = this.playheads[ph];
    p.spatialRenderer = renderer;
    p.applySurroundModel();
  }

  /**
   * How the device monitors a surround song (#998.3): MONITOR_FOLD folds it
   * onto the stereo pan law, MONITOR_BINAURAL renders it through a head model
   * so elevation and front/back are audible on headphones. Ignored while an
   * exporter's renderer is installed, and irrelevant to a stereo song.
   */
  setMonitorMode(ph, mode) {
    const p = this.playheads[ph];
    p.monitorMode = mode & 1;
    p.applySurroundModel();
  }
  getMonitorMode(ph) { return this.playheads[ph].monitorMode; }

  /**
   * Master-strip analysis tap (item 98): ANALYSIS_OFF, ANALYSIS_STEREO,
   * ANALYSIS_AMBISONIC or a speaker-layout key. Costs nothing while off, so the
   * host turns it on only while the strip is visible.
   */
  setAnalysis(ph, target) { this.playheads[ph].trackerState.setAnalysis(target); }
  getAnalysis(ph) { return this.playheads[ph].trackerState.analysisTarget; }

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

  /** Voice index of jam-bank slot `i` (item 140). Hosts address the bank
   *  through this rather than by arithmetic, so the base can move. */
  jamVoice(i) { return JAM_VOICE_BASE + (((i | 0) % JAM_VOICES) + JAM_VOICES) % JAM_VOICES; }

  jamNote(ph, vi, note, inst, audition = false) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
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
   * `spec`: { ptr, len, rate, playStart?, loopStart, loopEnd, loopMode, detune?,
   * chanPtr2?, chanMode? } — chanPtr2 auditions a STEREO pair (item 90) by
   * hanging a synthetic full-range 's' patch off the scratch instrument, since
   * only an Ixmp patch can carry a second channel.
   */
  jamSample(ph, vi, note, spec) {
    const p = this.playheads[ph];
    const ts = p.trackerState;
    const v = Math.min(Math.max(vi, 0), TOTAL_VOICES - 1);
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
    inst.extraPatches = spec.chanPtr2
      ? [makeInstPatch({
          pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
          samplePtr: inst.samplePtr, sampleLength: inst.sampleLength,
          playStart: inst.samplePlayStart, loopStart: inst.sampleLoopStart,
          loopEnd: inst.sampleLoopEnd, samplingRate: inst.samplingRate,
          sampleDetune: inst.sampleDetuneSigned, loopMode: inst.loopMode,
          hasChanBlock: true, chanCount: 2, chanMode: spec.chanMode | 0,
          chanPtrs: [spec.chanPtr2 >>> 0],
        })]
      : null;
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

  /**
   * Stop ONE audition voice and everything it spawned (metainstrument layer
   * children, NNA ghosts) — what a released key of a held chord ends, where
   * jamStop's "deactivate the world" would take the song's own voices with it.
   * `vi < 0` stops the whole jam bank, which is the focus-loss panic: still not
   * a single song voice. JS-only (item 140), no Kotlin counterpart.
   *
   * Ramped through the pattern note-cut's own path (note word 0x0002) rather
   * than dropped on the spot: a key release lands wherever the waveform happens
   * to be, and that ramp exists because stepping to zero there clicks.
   */
  jamStopVoice(ph, vi) {
    const ts = this.playheads[ph].trackerState;
    const lo = vi < 0 ? JAM_VOICE_BASE : Math.min(vi, TOTAL_VOICES - 1);
    const hi = vi < 0 ? TOTAL_VOICES - 1 : lo;
    for (let v = lo; v <= hi; v++) startCutRamp(ts.voices[v]);
    for (const bg of ts.backgroundVoices) {
      if (bg.sourceChannel >= lo && bg.sourceChannel <= hi) startCutRamp(bg);
    }
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

  /** Pan as the stereo meters want it: a surround voice reports where the
   *  monitor downmix puts it (rear positions fold onto the front arc). */
  getVoiceEffectivePan(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 128;
    if (this.playheads[ph].surroundModel !== SURROUND_STEREO) {
      return Math.round(foldAzimuthToPan(voiceAzimuth(v)));
    }
    // Panbrello counts here (the surround branch already has it, via
    // voiceAzimuth): it is a commanded movement the meter should show. The
    // random pan swing still does not — that is per-trigger jitter, not a
    // position the song asked for.
    if (v.hasPanEnv && v.panEnvOn) {
      const envPanRaw = Math.min(Math.max(Math.trunc(v.envPan * 255.0), 0), 255);
      return Math.min(Math.max(v.channelPan + v.notePan + envPanRaw - 128 + v.panbrelloOffset,
        0), 255);
    }
    return Math.min(Math.max(v.channelPan + v.notePan + v.panbrelloOffset, 0), 255);
  }

  /** Where a voice actually sits (#998): 512-unit azimuth, 128-unit elevation.
   *  Stereo songs report the pan byte's front-arc position. */
  getVoiceSpatialAzimuth(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[ph].surroundModel === SURROUND_STEREO
      ? clamp(v.channelPan + v.notePan + v.panbrelloOffset, 0, 255) : voiceAzimuth(v);
  }
  getVoiceSpatialElevation(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[ph].surroundModel === SURROUND_STEREO ? 0 : voiceElevation(v);
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

  /**
   * The instrument's live sample modification (item 130), for the sample view's
   * overlay: the operation, which side of the region it works on, the region as
   * [start, end, combShift] with -1 meaning "the sample's own loop", and
   * whatever the operation has accumulated. Plain numbers — the reply crosses a
   * postMessage. The MOD_FUNK bit-mask travels with it as `modMask`.
   */
  getInstrumentSampleMod(slot) {
    const inst = this.instruments[slot & 0x3ff];
    return {
      op: inst.modOp, invert: inst.modInvert,
      start: inst.modStart, end: inst.modEnd, comb: inst.modComb,
      rot: inst.modRot, sub: inst.modSub, on: inst.modOn,
    };
  }

  /** The modification's inversion mask, one bit per SAMPLE byte (item 130). */
  getInstrumentModMask(slot) {
    const mask = this.instruments[slot & 0x3ff].modMask;
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

// ══ src/worklet/protocol.js ══
// Message protocol shared by the AudioWorklet processor and the main thread.
// The master-strip block's geometry comes from the analysis tap itself, so the
// wire layout cannot drift from what fills it.
//
// Commands (main → worklet) are plain {t, ...} messages, deliberately
// isomorphic to the TSVM `audio.*` calls taut.js makes; bulk payloads ride as
// transferred ArrayBuffers. Snapshots (worklet → main) are recycled
// Float32Array buffers with the fixed layout below.



const CMD = Object.freeze({
  INIT: "init",
  UPLOAD_SAMPLE_INST_BLOB: "uploadSampleInstBlob", // {image: ArrayBuffer} (decompressed)
  UPLOAD_INSTRUMENT: "uploadInstrument",           // {slot, bytes: ArrayBuffer}
  UPLOAD_INSTRUMENT_PATCHES: "uploadInstrumentPatches", // {slot, bytes: ArrayBuffer}
  CLEAR_INSTRUMENT_PATCHES: "clearInstrumentPatches",   // {slot}
  UPLOAD_PATTERN: "uploadPattern",                 // {slot, bytes: ArrayBuffer}
  UPLOAD_PATTERNS: "uploadPatterns",               // {slots: int[], blob: ArrayBuffer} (bulk, 512 B each)
  UPLOAD_CUE: "uploadCue",                         // {idx, bytes: ArrayBuffer}
  SET_64CH: "set64ChannelMode",                    // {on}
  SET_CELL_FORMAT: "setCellFormat",                // {wide} — format v3's 16-byte cell
  SET_BPM: "setBPM",                               // {ph, bpm}
  SET_TICK_RATE: "setTickRate",                    // {ph, rate}
  SET_TUNING: "setTuning",                         // {ph, baseNote, freq} — song tuning (item 77)
  SET_SONG_GLOBAL_VOLUME: "setSongGlobalVolume",   // {ph, volume}
  SET_SONG_MIXING_VOLUME: "setSongMixingVolume",   // {ph, volume}
  SET_MASTER_VOLUME: "setMasterVolume",            // {ph, volume}
  SET_MASTER_PAN: "setMasterPan",                  // {ph, pan}
  SET_TRACKER_MIXER_FLAGS: "setTrackerMixerFlags", // {ph, flags}
  SET_SURROUND_MODEL: "setSurroundModel",          // {ph, model} — #998 song flag
  SET_MONITOR_MODE: "setMonitorMode",              // {ph, mode} — #998.3 fold / binaural
  SET_ANALYSIS: "setAnalysis",                     // {ph, target} — item 98 master-strip tap
  PLAY: "play",                                    // {ph}
  STOP: "stop",                                    // {ph}
  SET_CUE_POSITION: "setCuePosition",              // {ph, pos}
  SET_TRACKER_ROW: "setTrackerRow",                // {ph, row}
  RESET_PARAMS: "resetParams",                     // {ph}
  RESET_FUNK_STATE: "resetFunkState",              // {ph}
  JAM_NOTE: "jamNote",                             // {ph, voice, note, inst}
  JAM_SAMPLE: "jamSample",                         // {ph, voice, note, spec} — raw pooled-sample preview
  JAM_STOP: "jamStop",                             // {ph} — every voice (panic)
  JAM_STOP_VOICE: "jamStopVoice",                  // {ph, voice} — one audition voice; voice < 0 = the whole jam bank
  SET_VOICE_MUTE: "setVoiceMute",                  // {ph, voice, muted}
  SET_VOICE_FADER: "setVoiceFader",                // {ph, voice, fader}
  QUERY_FUNK_MASK: "queryFunkMask",                // {slot} → MSG.FUNK_MASK
  SNAPSHOT_RETURN: "snapshotReturn",               // {buffer: ArrayBuffer} (recycle)
  USE_SAB: "useSab",                               // {sab: SharedArrayBuffer} — switch to shared-memory snapshots
  USE_AUDIO_SAB: "useAudioSab",                    // {sab: SharedArrayBuffer} — Tier 2 audio ring (worklet consumes; worker produces)
});

const MSG = Object.freeze({
  SNAPSHOT: "snapshot", // {buffer: ArrayBuffer} — Float32Array, layout below
  // {slot, mask: ArrayBuffer, mod} — S$Fx/notefx 2 invert-loop bit mask, plus
  // the instrument's notefx 2/3 region geometry (engine getInstrumentSampleMod).
  FUNK_MASK: "funkMask",
  READY: "ready",
  PROFILE: "profile",   // {cpuFrac, renderFrac, ...} — dev profiler, ~1/s (opt-in)
});

// ── Snapshot layout (Float32Array; integers are exact in f32 up to 2^24) ──
const SNAP_CUE_POS = 0;
const SNAP_ROW_INDEX = 1;
const SNAP_TICK_IN_ROW = 2;
const SNAP_BPM = 3;
const SNAP_TICK_RATE = 4;
const SNAP_FLAGS = 5;          // bit0 isPlaying, bit1 jamActive
const SNAP_INTERRUPT_MASK = 6; // drained latch (edge-triggered)
const SNAP_CHANNEL_COUNT = 7;
// Song global volume (0..255). Effects V and W move it DURING playback, which
// is what the master fader follows (item 98).
const SNAP_GLOBAL_VOLUME = 8;
// ── Master-strip analysis (item 98) ──
// All of these are zero while the tap is off. The meter/correlation figures are
// sums over SNAP_AN_FRAMES samples — one snapshot interval — and the UI owns
// the ballistics.
const SNAP_AN_METERS = 9;      // metered channel count (0 = tap off)
const SNAP_AN_FRAMES = 10;     // samples integrated since the last snapshot
const SNAP_AN_FIELD = 11;      // Σ (W²+X²+Y²+Z²)/2 — acoustic energy density
const SNAP_AN_CORR_LL = 12;    // Σ L², Σ R², Σ L·R of the stereo (decode)
const SNAP_AN_CORR_RR = 13;
const SNAP_AN_CORR_LR = 14;
const SNAP_AN_RING_WRITE = 15; // next frame index in the scope ring
const SNAP_HEADER_SIZE = 16;

// Per-voice block, stride SNAP_VOICE_STRIDE, SNAP_MAX_VOICES blocks.
const SNAP_V_ACTIVE = 0;
const SNAP_V_EFF_VOL = 1;      // 0..1 (getVoiceEffectiveVolume)
const SNAP_V_EFF_PAN = 2;      // 0..255 (getVoiceEffectivePan)
const SNAP_V_NOTE = 3;      // per-tick sounding pitch (renderPitch; follows slides/arp/vibrato)
const SNAP_V_INST = 4;
const SNAP_V_SAMPLE_POS = 5;
const SNAP_V_SAMPLE_PTR = 6;
const SNAP_V_SAMPLE_LEN = 7;
const SNAP_V_ENV_VOL_IDX = 8;
const SNAP_V_ENV_VOL_TIME = 9;
const SNAP_V_ENV_PAN_IDX = 10;
const SNAP_V_ENV_PAN_TIME = 11;
const SNAP_V_ENV_PITCH_IDX = 12;
const SNAP_V_ENV_PITCH_TIME = 13;
const SNAP_V_ENV_FILTER_IDX = 14;
const SNAP_V_ENV_FILTER_TIME = 15;
const SNAP_V_AZIMUTH = 16;     // #998: 512-unit angle (0 left, 128 front, CLOCKWISE)
const SNAP_V_ELEVATION = 17;   // #998: signed, 128 units = 90° (always 0 in a stereo song)
const SNAP_VOICE_STRIDE = 18;

// Every PHYSICAL voice, so the jam bank (item 140) is visible to the views that
// follow a sounding audition — the Instruments/Samples editors scan the block
// looking for the voice their preview landed on, and it no longer lands on a
// song channel.
const SNAP_MAX_VOICES = TOTAL_VOICES;

// ── Master-strip blocks (item 98), after the voice array ──
// Per metered channel: peak, true peak (4× oversampled), mean square over the
// interval, and the number of samples that hit full scale.
const SNAP_METER_BASE = SNAP_HEADER_SIZE + SNAP_MAX_VOICES * SNAP_VOICE_STRIDE;
const SNAP_M_PEAK = 0;
const SNAP_M_TRUE_PEAK = 1;
const SNAP_M_MEAN_SQUARE = 2;
const SNAP_M_CLIP = 3;
const SNAP_METER_STRIDE = 4;

// The vectorscope ring: SCOPE_FRAMES frames of first-order B-format, frame
// interleaved (W, Y, Z, X), written continuously and read backwards from
// SNAP_AN_RING_WRITE. See src/engine/analysis.js for why the scopes are always
// B-format whatever the metering target is.
const SNAP_SCOPE_BASE = SNAP_METER_BASE + ANALYSIS_MAX_METERS * SNAP_METER_STRIDE;

const SNAP_FLOATS = SNAP_SCOPE_BASE + SCOPE_FRAMES * SCOPE_CHANNELS;

// SAB fast path (crossOriginIsolated deploys): one shared buffer holding the
// float snapshot region plus a trailing Int32 interrupt-latch cell that the
// worklet ORs into (Atomics.or) and the main thread drains
// (Atomics.exchange 0). The float SNAP_INTERRUPT_MASK slot is only used by
// the postMessage fallback.
const SNAP_SAB_BYTES = SNAP_FLOATS * 4 + 4;

// ══ src/audio/audio-ring.js ══
// SharedArrayBuffer audio ring for Tier 2 (off-audio-thread rendering).
//
// A render Worker (producer) fills engine-rate float L/R frames; the AudioWorklet
// (consumer) reads them with a fractional resample cursor and copies to output.
// Single-producer / single-consumer, so the two absolute frame counters
// (AR_WRITE by the worker, AR_READ by the worklet) need only be published with
// Atomics.store / read with Atomics.load — no locks. AR_EPOCH is bumped by the
// worker on a transport reset (play / seek / stop) so the worklet drops the
// stale buffered tail instead of playing ~one ring of old audio.
//
// This module is imported by BOTH the module worker and the AudioWorklet, so it
// must stay bundle-safe (plain export forms, unique top-level names) — it goes
// into tools/make-worklet-bundle.js for the non-module-worklet fallback.

const AR_FRAMES = 8192;            // ring capacity in frames (power of two) — 171 ms @ 48 kHz
const AR_MASK = AR_FRAMES - 1;
const AR_CTRL_LEN = 6;             // Int32 control slots
const AR_WRITE = 0;                // absolute frames produced (worker → worklet), Int32-wrapping
const AR_READ = 1;                 // absolute frames consumed (worklet → worker), Int32-wrapping
const AR_STATE = 2;                // bit0: producer active (playing/jam) — informational
const AR_EPOCH = 3;                // transport-reset generation (worker bumps; worklet re-syncs)
const AR_FLUSH_POS = 4;            // write frame at the last flush — the worklet jumps its read cursor here,
                                          //   dropping the stale tail (counters stay monotonic; no reset race)
// Target ring occupancy the worker keeps buffered. 1024 frames ≈ 21 ms @ 48 kHz
// = the jam-latency / cursor-lead / underrun-safety knob (user-chosen balanced).
const AR_HIGH_WATER = 1024;
const AR_SAB_BYTES = AR_CTRL_LEN * 4 + AR_FRAMES * 4 * 2;

/** Map Int32 control + Float32 L/R views over an audio-ring SharedArrayBuffer. */
function audioRingViews(sab) {
  const ctrl = new Int32Array(sab, 0, AR_CTRL_LEN);
  const floatBase = AR_CTRL_LEN * 4;
  const L = new Float32Array(sab, floatBase, AR_FRAMES);
  const R = new Float32Array(sab, floatBase + AR_FRAMES * 4, AR_FRAMES);
  return { ctrl, L, R };
}

// ══ src/audio/resampler.js ══
// Kaiser-windowed-sinc resampling — the ONE interpolator every rate conversion
// in the app goes through:
//
//   * the AudioWorklet's engine→context read cursor (both the local render ring
//     and the Tier 2 SAB ring) — src/worklet/taud-processor.js
//   * the offline stereo WAV + mono stem exports — src/audio/offline-render.js
//   * the streaming multichannel export — src/audio/surround-export.js
//   * the sample Lab / import knife — src/doc/wavelab.js, which is ALSO the
//     float twin of the Python converters' taud_common.resample_bandlimited
//
// β=8 (~-70 dB stop-band), 512 phases, 8..24 half-taps, cutoff following the
// ratio so a DOWN-conversion anti-aliases on the way down, each phase row
// DC-normalised so a constant passes through unchanged. Those are the Python
// original's numbers, so the app and the converters shave a sample identically.
//
// Imported by the AudioWorklet, so this file must stay bundle-safe (plain
// export forms, unique top-level names) — it is in tools/make-worklet-bundle.js.

const RESAMP_BETA = 8.0;
const RESAMP_PHASES = 512; // power of two: the phase index is a mask away

function resampBesselI0(x) {
  let s = 1.0, t = 1.0, k = 1;
  for (;;) {
    t *= (x * x) / (4.0 * k * k);
    s += t;
    if (t < 1e-12 * s) return s;
    k++;
  }
}

const resampRowCache = new Map();
const resampKernelCache = new Map();

/**
 * Half-taps for a conversion by `ratio` (dst/src): 12 either side, widened as a
 * downsample narrows the transition band, capped at 24 so the cost stays bounded.
 */
function resampHalfWidth(ratio) {
  return Math.max(8, Math.min(24, Math.round(12.0 / Math.min(1.0, ratio))));
}

/**
 * Kernel rows of 2·halfWidth taps, row p being the kernel for fractional offset
 * p/phases. There are phases+1 of them: the last (frac = 1.0) is the endpoint
 * the read loops interpolate TOWARDS — see kaiserKernel. Cached, since the
 * tables are pure functions of their arguments and a handful of them cover
 * every rate pair the app ever sees.
 */
function kaiserSincRows(cutoff, halfWidth, phases = RESAMP_PHASES) {
  const key = `${Math.round(cutoff * 1e6)}:${halfWidth}:${phases}`;
  const cached = resampRowCache.get(key);
  if (cached) return cached;
  const nTaps = 2 * halfWidth;
  const invI0 = 1.0 / resampBesselI0(RESAMP_BETA);
  const rows = [];
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    const row = new Float64Array(nTaps);
    let s = 0.0;
    for (let k = 0; k < nTaps; k++) {
      const x = (k - (halfWidth - 1)) - frac;
      const a = 2.0 * cutoff * x;
      const sinc = a === 0.0 ? 1.0 : Math.sin(Math.PI * a) / (Math.PI * a);
      const r = x / halfWidth;
      const win = resampBesselI0(RESAMP_BETA * Math.sqrt(Math.max(0.0, 1.0 - r * r))) * invI0;
      row[k] = sinc * win;
      s += row[k];
    }
    const inv = s !== 0 ? 1.0 / s : 1.0;
    for (let k = 0; k < nTaps; k++) row[k] *= inv;
    rows.push(row);
  }
  resampRowCache.set(key, rows);
  return rows;
}

/**
 * Everything a read loop needs to convert srcRate → dstRate. The tap window for
 * output position `pos` is [⌊pos⌋−history, ⌊pos⌋+lead]: `lead` FUTURE frames
 * must already be buffered, which is why the streaming callers keep a look-ahead
 * the linear cursor never needed.
 *
 * `rows` is paired with `deltas` (row p+1 − row p) so a read loop can BLEND the
 * two rows bracketing the true phase: `w = rows[p][t] + deltas[p][t]·g`. Picking
 * the nearest row instead quantises the read position to 1/2·phases of a sample,
 * and that timing jitter is a ~−52 dB noise floor at 10 kHz — audible hiss riding
 * the music, and far worse than the −70 dB stop-band the window buys. One extra
 * multiply-add per tap buys it back.
 */
function kaiserKernel(srcRate, dstRate) {
  const cached = resampKernelCache.get(`${srcRate}:${dstRate}`);
  if (cached) return cached;
  const ratio = dstRate / srcRate;
  const halfWidth = resampHalfWidth(ratio);
  const nTaps = 2 * halfWidth;
  const rows = kaiserSincRows(0.5 * Math.min(1.0, ratio), halfWidth, RESAMP_PHASES);
  const deltas = [];
  for (let p = 0; p < RESAMP_PHASES; p++) {
    const d = new Float64Array(nTaps);
    for (let t = 0; t < nTaps; t++) d[t] = rows[p + 1][t] - rows[p][t];
    deltas.push(d);
  }
  const kernel = {
    rows,
    deltas,
    phases: RESAMP_PHASES,
    halfWidth,
    nTaps,
    history: halfWidth - 1,
    lead: halfWidth,
    step: srcRate / dstRate,
  };
  resampKernelCache.set(`${srcRate}:${dstRate}`, kernel);
  return kernel;
}

/**
 * Resample an interleaved Float32 buffer srcRate → dstRate in one go. Edge taps
 * clamp to the first/last frame (same as wavelab's whole-buffer resample).
 * Equal rates return the input untouched.
 */
function resampleInterleaved(f32, channels, srcRate, dstRate) {
  if (srcRate === dstRate) return f32;
  const srcFrames = f32.length / channels;
  const dstFrames = Math.floor((srcFrames * dstRate) / srcRate);
  const out = new Float32Array(dstFrames * channels);
  const { rows, deltas, phases, history, nTaps, step } = kaiserKernel(srcRate, dstRate);
  const acc = new Float64Array(channels);
  const last = srcFrames - 1;
  for (let n = 0; n < dstFrames; n++) {
    const pos = n * step;
    const i0 = Math.floor(pos);
    const fp = (pos - i0) * phases;
    const p = fp | 0;
    const g = fp - p;
    const row = rows[p], dRow = deltas[p];
    const base = i0 - history;
    acc.fill(0.0);
    for (let t = 0; t < nTaps; t++) {
      let idx = base + t;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      const o = idx * channels;
      const w = row[t] + dRow[t] * g;
      for (let c = 0; c < channels; c++) acc[c] += f32[o + c] * w;
    }
    const oo = n * channels;
    for (let c = 0; c < channels; c++) out[oo + c] = acc[c];
  }
  return out;
}

/**
 * Chunk-at-a-time resampler for the multichannel export, which encodes as it
 * renders. It carries the kernel's history AND its look-ahead across the block
 * boundary — a sinc needs `lead` frames that have not been rendered yet, so
 * output lags the input by that much and `flush()` drains the tail.
 */
class StreamResampler {
  constructor(channels, srcRate, dstRate) {
    this.channels = channels;
    this.step = srcRate / dstRate;
    this.k = srcRate === dstRate ? null : kaiserKernel(srcRate, dstRate);
    // Source position of the next output frame, relative to the current block's
    // first frame. Goes NEGATIVE (into the history) by up to the look-ahead.
    this.phase = 0.0;
    this.histFrames = this.k ? this.k.nTaps + 2 : 0;
    this.hist = new Float32Array(this.histFrames * channels);
    this.acc = new Float64Array(channels);
  }

  /** Upper bound on the output frames one `frames`-long block can produce. */
  maxOut(frames) { return Math.ceil(frames / this.step) + 2; }

  /** @returns the number of frames written into `out`. */
  process(input, frames, out) {
    const ch = this.channels;
    if (this.k === null) { // equal rates: a copy, not a filter
      out.set(input.subarray(0, frames * ch));
      return frames;
    }
    const { rows, deltas, phases, history, lead, nTaps } = this.k;
    const hist = this.hist, histFrames = this.histFrames, acc = this.acc;
    // The newest tap of output frame ⌊phase⌋ is ⌊phase⌋+lead, so stop as soon
    // as that would read past the end of this block.
    const limit = frames - 1 - lead;
    let phase = this.phase;
    let n = 0;
    while (Math.floor(phase) <= limit) {
      const i0 = Math.floor(phase);
      const fp = (phase - i0) * phases;
      const p = fp | 0;
      const g = fp - p;
      const row = rows[p], dRow = deltas[p];
      const base = i0 - history;
      acc.fill(0.0);
      for (let t = 0; t < nTaps; t++) {
        const idx = base + t;
        const w = row[t] + dRow[t] * g;
        if (idx >= 0) {
          const o = idx * ch;
          for (let c = 0; c < ch; c++) acc[c] += input[o + c] * w;
        } else {
          const o = Math.max(idx + histFrames, 0) * ch;
          for (let c = 0; c < ch; c++) acc[c] += hist[o + c] * w;
        }
      }
      const oo = n * ch;
      for (let c = 0; c < ch; c++) out[oo + c] = acc[c];
      n++;
      phase += this.step;
    }
    this.phase = phase - frames;
    // Carry the tail of this block as the next block's history (short blocks
    // push the older history along instead of replacing it).
    const carry = Math.min(histFrames, frames);
    if (carry < histFrames) hist.copyWithin(0, carry * ch);
    hist.set(input.subarray((frames - carry) * ch, frames * ch), (histFrames - carry) * ch);
    return n;
  }

  /** Emit the frames still held back by the look-ahead. Zero-padded: a render
   *  ends in silence, and a click at the very last sample is worse than a
   *  half-millisecond of decay. Call once, after the last process(). */
  flush(out) {
    if (this.k === null) return 0;
    const pad = this.k.lead + 1;
    return this.process(new Float32Array(pad * this.channels), pad, out);
  }
}

// ══ src/worklet/engine-commands.js ══
// Engine command dispatch + snapshot fill, shared by the AudioWorklet
// (render-mode fallback) and the Tier 2 render Worker. Both host a TaudEngine
// and speak the same audio.*-shaped CMD protocol, so this keeps the mutation
// path in one place (no drift between the two hosts). Bundle-safe (plain export
// forms, unique names) — included in tools/make-worklet-bundle.js.





/** Reused drain target — the snapshot path never allocates. */
const analysisReadout = makeAnalysisReadout();

/**
 * Apply an engine-mutating command to `eng`. Returns true if handled here.
 * Transport/reply commands (INIT, USE_SAB, USE_AUDIO_SAB, SNAPSHOT_RETURN,
 * QUERY_FUNK_MASK) return false — each host handles those itself.
 */
function applyAudioCommand(eng, m) {
  switch (m.t) {
    case CMD.UPLOAD_SAMPLE_INST_BLOB: eng.uploadSampleInstBlob(new Uint8Array(m.image)); return true;
    case CMD.UPLOAD_INSTRUMENT: eng.uploadInstrument(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_INSTRUMENT_PATCHES: eng.uploadInstrumentPatches(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.CLEAR_INSTRUMENT_PATCHES: eng.clearInstrumentPatches(m.slot); return true;
    case CMD.UPLOAD_PATTERN: eng.uploadPattern(m.slot, new Uint8Array(m.bytes)); return true;
    case CMD.UPLOAD_PATTERNS: {
      const blob = new Uint8Array(m.blob);
      // Stride follows the file's cell layout, which SET_CELL_FORMAT installed
      // before the first pattern was ever sent.
      const size = eng.getCellFormat() ? PATTERN_BYTES_WIDE : PATTERN_BYTES;
      for (let i = 0; i < m.slots.length; i++) {
        eng.uploadPattern(m.slots[i], blob.subarray(i * size, (i + 1) * size));
      }
      return true;
    }
    case CMD.UPLOAD_CUE: eng.uploadCue(m.idx, new Uint8Array(m.bytes)); return true;
    case CMD.SET_64CH: eng.set64ChannelMode(m.on); return true;
    case CMD.SET_CELL_FORMAT: eng.setCellFormat(m.wide); return true;
    case CMD.SET_BPM: eng.setBPM(m.ph, m.bpm); return true;
    case CMD.SET_TUNING: eng.setTuning(m.ph, m.baseNote, m.freq); return true;
    case CMD.SET_TICK_RATE: eng.setTickRate(m.ph, m.rate); return true;
    case CMD.SET_SONG_GLOBAL_VOLUME: eng.setSongGlobalVolume(m.ph, m.volume); return true;
    case CMD.SET_SONG_MIXING_VOLUME: eng.setSongMixingVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_VOLUME: eng.setMasterVolume(m.ph, m.volume); return true;
    case CMD.SET_MASTER_PAN: eng.setMasterPan(m.ph, m.pan); return true;
    case CMD.SET_TRACKER_MIXER_FLAGS: eng.setTrackerMixerFlags(m.ph, m.flags); return true;
    case CMD.SET_SURROUND_MODEL: eng.setSurroundModel(m.ph, m.model); return true;
    case CMD.SET_MONITOR_MODE: eng.setMonitorMode(m.ph, m.mode); return true;
    case CMD.SET_ANALYSIS: eng.setAnalysis(m.ph, m.target); return true;
    case CMD.PLAY: eng.play(m.ph); return true;
    case CMD.STOP: eng.stop(m.ph); return true;
    case CMD.SET_CUE_POSITION: eng.setCuePosition(m.ph, m.pos); return true;
    case CMD.SET_TRACKER_ROW: eng.setTrackerRow(m.ph, m.row); return true;
    case CMD.RESET_PARAMS: eng.resetParams(m.ph); return true;
    case CMD.RESET_FUNK_STATE: eng.resetFunkState(m.ph); return true;
    case CMD.JAM_NOTE: eng.jamNote(m.ph, m.voice, m.note, m.inst, m.audition); return true;
    case CMD.JAM_SAMPLE: eng.jamSample(m.ph, m.voice, m.note, m.spec); return true;
    case CMD.JAM_STOP: eng.jamStop(m.ph); return true;
    case CMD.JAM_STOP_VOICE: eng.jamStopVoice(m.ph, m.voice); return true;
    case CMD.SET_VOICE_MUTE: eng.setVoiceMute(m.ph, m.voice, m.muted); return true;
    case CMD.SET_VOICE_FADER: eng.setVoiceFader(m.ph, m.voice, m.fader); return true;
    default: return false;
  }
}

/** True for the transport commands that reset the play position (worker mode
 *  must flush the audio ring so no stale buffered tail plays after them). */
function isTransportReset(t) {
  return t === CMD.PLAY || t === CMD.STOP ||
    t === CMD.SET_CUE_POSITION || t === CMD.SET_TRACKER_ROW || t === CMD.RESET_PARAMS;
}

/** Detached copy of instrument `slot`'s S$Fx invert-loop bit mask (reply payload). */
function funkMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentFunkMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/** Detached copy of notefx 2/3's inversion mask for `slot` (item 130). */
function modMaskBuffer(eng, slot) {
  const mask = eng.getInstrumentModMask(slot);
  return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength);
}

/** Write every snapshot field except the interrupt latch into `f`. */
function fillSnapshotInto(eng, playhead, f) {
  const ph = eng.playheads[playhead];
  const ts = ph.trackerState;
  f[SNAP_CUE_POS] = ts.cuePos;
  f[SNAP_ROW_INDEX] = ts.rowIndex;
  f[SNAP_TICK_IN_ROW] = ts.tickInRow;
  f[SNAP_BPM] = ph.bpm;
  f[SNAP_TICK_RATE] = ph.tickRate;
  f[SNAP_FLAGS] = (ph.isPlaying ? 1 : 0) | (ph.jamActive ? 2 : 0);
  f[SNAP_CHANNEL_COUNT] = eng.channelCount();
  f[SNAP_GLOBAL_VOLUME] = ph.globalVolume;
  for (let vi = 0; vi < SNAP_MAX_VOICES; vi++) {
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
        pan = v.channelPan + v.notePan + envPanRaw - 128 + v.panbrelloOffset;
      } else {
        pan = v.channelPan + v.notePan + v.panbrelloOffset;
      }
      f[o + SNAP_V_EFF_PAN] = pan < 0 ? 0 : pan > 255 ? 255 : pan;
      // Spatial position (#998). EFF_PAN above stays the stereo meters' 0..255
      // value — in a surround song that is where the monitor downmix puts the
      // voice, which is what those meters are drawing.
      if (ts.surroundModel !== SURROUND_STEREO) {
        const az = voiceAzimuth(v);
        f[o + SNAP_V_EFF_PAN] = Math.round(foldAzimuthToPan(az));
        f[o + SNAP_V_AZIMUTH] = az;
        f[o + SNAP_V_ELEVATION] = voiceElevation(v);
      } else {
        f[o + SNAP_V_AZIMUTH] = f[o + SNAP_V_EFF_PAN];
        f[o + SNAP_V_ELEVATION] = 0;
      }
      f[o + SNAP_V_NOTE] = (v.renderPitch > 0 ? v.renderPitch : v.noteVal) & 0xffff;
      // Show the pattern-level instrument (a meta's slot), not the resolved
      // layer child; fall back to instrumentId before the first meta/plain trigger.
      f[o + SNAP_V_INST] = (v.displayInst || v.instrumentId) & 0x3ff;
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
      f[o + SNAP_V_AZIMUTH] = 128; // centre/front, matching EFF_PAN's rest value
      f[o + SNAP_V_SAMPLE_POS] = -1;
      f[o + SNAP_V_SAMPLE_PTR] = -1;
      f[o + SNAP_V_ENV_VOL_IDX] = -1;
      f[o + SNAP_V_ENV_PAN_IDX] = -1;
      f[o + SNAP_V_ENV_PITCH_IDX] = -1;
      f[o + SNAP_V_ENV_FILTER_IDX] = -1;
    }
  }
  fillAnalysisInto(ts, f);
}

/**
 * Master-strip block (item 98). Drains the analysis tap — meters, correlation
 * sums, field energy and the B-format scope ring — into the snapshot. With the
 * tap off, only the "no meters" marker is written; the ring keeps whatever it
 * last held, which nothing reads.
 */
function fillAnalysisInto(ts, f) {
  const tap = ts.analysis;
  if (tap === null) {
    f[SNAP_AN_METERS] = 0;
    f[SNAP_AN_FRAMES] = 0;
    f[SNAP_AN_FIELD] = 0;
    f[SNAP_AN_CORR_LL] = 0;
    f[SNAP_AN_CORR_RR] = 0;
    f[SNAP_AN_CORR_LR] = 0;
    return;
  }
  const r = tap.drain(analysisReadout);
  f[SNAP_AN_METERS] = r.meterCount;
  f[SNAP_AN_FRAMES] = r.frames;
  f[SNAP_AN_FIELD] = r.fieldEnergy;
  f[SNAP_AN_CORR_LL] = r.corrLL;
  f[SNAP_AN_CORR_RR] = r.corrRR;
  f[SNAP_AN_CORR_LR] = r.corrLR;
  f[SNAP_AN_RING_WRITE] = r.ringWrite;
  for (let c = 0; c < ANALYSIS_MAX_METERS; c++) {
    const o = SNAP_METER_BASE + c * SNAP_METER_STRIDE;
    const live = c < r.meterCount;
    f[o + SNAP_M_PEAK] = live ? r.peak[c] : 0;
    f[o + SNAP_M_TRUE_PEAK] = live ? r.truePeak[c] : 0;
    f[o + SNAP_M_MEAN_SQUARE] = live ? r.meanSquare[c] : 0;
    f[o + SNAP_M_CLIP] = live ? r.clip[c] : 0;
  }
  f.set(tap.ring, SNAP_SCOPE_BASE);
}

// ══ src/worklet/taud-processor.js ══
// TaudProcessor — AudioWorkletProcessor with two modes:
//
//   RENDER mode (non-isolated fallback): hosts the TaudEngine and renders
//     engine-rate U8/float chunks into a local FIFO ring, reading them back
//     with a fractional resample cursor. This is the original single-thread path.
//
//   CONSUME mode (Tier 2, crossOriginIsolated): the engine lives in a separate
//     render Worker that fills a SharedArrayBuffer audio ring; process() only
//     resamples + copies from that ring, so it can never overrun. Entered on
//     CMD.USE_AUDIO_SAB; no engine commands are routed here in this mode.
//
// The engine renders at SAMPLING_RATE — 48 kHz since item 108, which is the
// rate audio-system.js asks the AudioContext for, so the common case reads the
// ring back one frame at a time with no interpolation at all (step === 1: a
// straight copy, not even a kernel). A context that insists on another rate
// (44.1 kHz hardware) is served by a fractional cursor reading through the
// Kaiser-windowed sinc in audio/resampler.js — the same kernel the exporters
// and the sample Lab use. That kernel needs `lead` frames AHEAD of the cursor,
// so both modes buffer that much extra look-ahead. Loaded via
// audioWorklet.addModule() as an ES module; the committed single-file concat
// (taud-processor.bundle.js) is the non-module-worklet fallback — regenerate
// with tools/make-worklet-bundle.js after any change here.







const RING_FRAMES = 4096; // power of two (render-mode local ring)

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
    this.ringFloor = 0;      // oldest frame the kernel may read (flush barrier)
    this.step = SAMPLING_RATE / sampleRate; // 1.0 at a 48 kHz context
    // null at a matching context rate — then a frame is a frame and the read
    // loops copy. Otherwise the sinc kernel both read cursors run through.
    this.rs = this.step === 1.0 ? null : kaiserKernel(SAMPLING_RATE, sampleRate);

    // CONSUME mode (Tier 2): audio-ring SAB views + wrap-safe read cursor.
    this.audioRing = null;
    this.arEpoch = -1;       // forces a re-sync on the first callback
    this.arReadBase = 0;     // Int32-wrapping integer read frame
    this.arReadFrac = 0.0;   // 0..1 fractional accumulator
    this.arFloor = 0;        // ditto, on the SAB ring's wrapping counter

    const opts = options?.processorOptions ?? {};
    this.snapshotIntervalFrames =
      Math.max(1, Math.round(((opts.snapshotIntervalMs ?? 16) / 1000) * sampleRate));
    this.framesSinceSnapshot = 0;
    // Recycled snapshot buffers (transferred out, posted back via SNAPSHOT_RETURN).
    this.snapshotPool = [
      new ArrayBuffer(SNAP_FLOATS * 4),
      new ArrayBuffer(SNAP_FLOATS * 4),
    ];
    // SAB fast path (CMD.USE_SAB): write snapshots straight into shared memory.
    this.sabF32 = null;
    this.sabI32 = null;

    // ── dev profiler (opt-in via processorOptions.profile; zero cost when off) ──
    // Times the whole process() callback (the true xrun predictor) AND the
    // engine.renderChunk DSP alone. In CONSUME mode renderChunk is never called,
    // so renderCount≈0 — which is exactly the point: the audio thread stops
    // rendering. Reports rolling stats to the main thread ≈ once per second.
    this.profiling = !!opts.profile;
    // AudioWorkletGlobalScope does not reliably expose performance.now on older
    // iPad Safari — feature-detect and fall back to the 1 ms-resolution
    // Date.now, reporting which clock is live so the numbers stay interpretable.
    const hasPerf = (typeof performance !== "undefined" && typeof performance.now === "function");
    this.clockNow = hasPerf ? () => performance.now() : () => Date.now();
    this.hiResClock = hasPerf;
    this.clockResMs = hasPerf ? 0.005 : 1; // nominal resolution
    this.profileIntervalFrames = Math.max(1, Math.round(sampleRate)); // ≈ 1 s window
    this.pfReset();

    this.port.onmessage = (e) => this.onCommand(e.data);
    this.port.postMessage({ t: MSG.READY });
  }

  pfReset() {
    this.pfFrames = 0;
    this.pfProcBusy = 0; this.pfProcMax = 0; this.pfProcCount = 0; this.pfXruns = 0;
    this.pfRenderBusy = 0; this.pfRenderMax = 0; this.pfRenderCount = 0;
    this.pfPeakVoices = 0;
    this.pfUnderruns = 0; // CONSUME mode: callbacks starved while the producer was active
  }

  onCommand(m) {
    // Enter CONSUME mode: the worker owns the engine now; free ours (~8 MB).
    if (m.t === CMD.USE_AUDIO_SAB) {
      this.audioRing = audioRingViews(m.sab);
      this.engine = null;
      return;
    }
    if (this.audioRing) return; // consume mode: no engine commands routed here

    const eng = this.engine;
    if (applyAudioCommand(eng, m)) {
      // Transport reset (play/seek/stop): drop the local look-ahead ring's
      // buffered tail, or a block rendered against the OLD tracker state
      // leaks into the new playback (item 96) — render.worker.js's
      // flushRing/AR_EPOCH does the same job for the Tier 2 SAB path; this
      // mode never had the equivalent, since applyAudioCommand only touches
      // `eng`, not the processor's own ring pointers.
      if (isTransportReset(m.t)) this.flushRing();
      return;
    }
    switch (m.t) {
      case CMD.INIT:
        if (m.snapshotIntervalMs) {
          this.snapshotIntervalFrames =
            Math.max(1, Math.round((m.snapshotIntervalMs / 1000) * sampleRate));
        }
        break;
      case CMD.QUERY_FUNK_MASK: {
        const buf = funkMaskBuffer(eng, m.slot);
        const modBuf = modMaskBuffer(eng, m.slot);
        this.port.postMessage({
          t: MSG.FUNK_MASK, slot: m.slot, mask: buf,
          mod: eng.getInstrumentSampleMod(m.slot), modMask: modBuf,
        }, [buf, modBuf]);
        break;
      }
      case CMD.SNAPSHOT_RETURN:
        if (this.snapshotPool.length < 2) this.snapshotPool.push(m.buffer);
        break;
      case CMD.USE_SAB:
        this.sabF32 = new Float32Array(m.sab, 0, SNAP_FLOATS);
        this.sabI32 = new Int32Array(m.sab, SNAP_FLOATS * 4, 1);
        break;
    }
  }

  /** Discard whatever look-ahead audio is still queued (not yet read out) —
   *  it was rendered against the tracker state from BEFORE this transport
   *  reset. renderAndPlay re-fills from the current (already-reset) engine
   *  state starting exactly at the read cursor, so nothing is left to leak. */
  flushRing() {
    this.ringReadPos = this.ringWrite;
    // …and the sinc's history taps must not reach back across the cut either:
    // those frames are the discarded tail, and half a kernel of it would be
    // mixed into the first frames of the new playback.
    this.ringFloor = this.ringWrite;
  }

  renderIntoRing() {
    const t0 = this.profiling ? this.clockNow() : 0;
    const out = this.engine.renderChunk(this.playhead, this.chunk);
    if (this.profiling) {
      const dt = this.clockNow() - t0;
      this.pfRenderBusy += dt;
      if (dt > this.pfRenderMax) this.pfRenderMax = dt;
      this.pfRenderCount++;
      const ts0 = this.engine.playheads[this.playhead].trackerState;
      let nv = ts0.backgroundVoices.length;
      for (let i = 0; i < ts0.voices.length; i++) if (ts0.voices[i].active) nv++;
      if (nv > this.pfPeakVoices) this.pfPeakVoices = nv;
    }
    const mask = RING_FRAMES - 1;
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = 0;
        this.ringR[w] = 0;
      }
    } else {
      // Feed the pre-dither Float32 mix bus directly — clean output, no 8-bit
      // dithering. (renderChunk still fills the dithered U8 `out` so the engine
      // stays bit-exact for the JVM-oracle conformance tests; playback ignores it.)
      const ts = this.engine.playheads[this.playhead].trackerState;
      const mL = ts.mixLeft;
      const mR = ts.mixRight;
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = mL[n];
        this.ringR[w] = mR[n];
      }
    }
    this.ringWrite += TRACKER_CHUNK;
  }

  assembleSnapshot() {
    if (this.sabF32 !== null) {
      // Shared-memory path: fill in place; interrupts accumulate in the
      // trailing Int32 cell until the main thread drains it atomically.
      fillSnapshotInto(this.engine, this.playhead, this.sabF32);
      this.sabF32[SNAP_INTERRUPT_MASK] = 0;
      const drained = this.engine.playheads[this.playhead].trackerState.drainInterrupts();
      if (drained !== 0) Atomics.or(this.sabI32, 0, drained);
      return;
    }
    const buffer = this.snapshotPool.pop();
    if (!buffer) return; // main thread slow returning — skip, never allocate
    const f = new Float32Array(buffer);
    fillSnapshotInto(this.engine, this.playhead, f);
    f[SNAP_INTERRUPT_MASK] = this.engine.playheads[this.playhead].trackerState.drainInterrupts();
    this.port.postMessage({ t: MSG.SNAPSHOT, buffer }, [buffer]);
  }

  // RENDER mode: keep the local ring one chunk ahead, then read it out resampled.
  renderAndPlay(outL, outR, frames) {
    const ph = this.engine.playheads[this.playhead];
    const mask = RING_FRAMES - 1;
    const rs = this.rs;
    if (ph.isPlaying || ph.jamActive || this.ringReadPos < this.ringWrite) {
      // The last output frame's newest tap sits `lead` frames past its cursor.
      const lead = (rs === null ? 0 : rs.lead) + 2;
      while (this.ringWrite < this.ringReadPos + frames * this.step + lead) {
        if (ph.isPlaying || ph.jamActive) {
          this.renderIntoRing();
        } else {
          const w = this.ringWrite & mask;
          this.ringL[w] = 0;
          this.ringR[w] = 0;
          this.ringWrite += 1;
        }
      }
      if (rs === null) {
        const i0 = this.ringReadPos;
        for (let n = 0; n < frames; n++) {
          const a = (i0 + n) & mask;
          outL[n] = this.ringL[a];
          outR[n] = this.ringR[a];
        }
        this.ringReadPos = i0 + frames;
      } else {
        const { rows, deltas, phases, history, nTaps } = rs;
        const floor = this.ringFloor;
        for (let n = 0; n < frames; n++) {
          const pos = this.ringReadPos;
          const i0 = Math.floor(pos);
          const fp = (pos - i0) * phases;
          const p = fp | 0;
          const g = fp - p;
          const row = rows[p], dRow = deltas[p];
          const base = i0 - history;
          let l = 0.0, r = 0.0;
          for (let t = 0; t < nTaps; t++) {
            const src = base + t;
            const a = (src < floor ? floor : src) & mask;
            const w = row[t] + dRow[t] * g;
            l += this.ringL[a] * w;
            r += this.ringR[a] * w;
          }
          outL[n] = l;
          outR[n] = r;
          this.ringReadPos = pos + this.step;
        }
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
  }

  // CONSUME mode: read the worker's SAB ring resampled to the context rate.
  consumeFromRing(outL, outR, frames) {
    const { ctrl, L, R } = this.audioRing;
    // A transport reset (play/seek/stop) bumps the epoch and publishes a flush
    // mark — jump the read cursor there, dropping the stale buffered tail.
    const rs = this.rs;
    const epoch = Atomics.load(ctrl, AR_EPOCH) | 0;
    if (epoch !== this.arEpoch) {
      this.arEpoch = epoch;
      this.arReadBase = Atomics.load(ctrl, AR_FLUSH_POS) | 0;
      this.arReadFrac = 0;
      this.arFloor = this.arReadBase; // no history taps into the dropped tail
    }
    const write = Atomics.load(ctrl, AR_WRITE) | 0;
    const avail = (write - this.arReadBase) | 0;
    // …+ the frames the kernel's newest tap needs beyond the last read cursor.
    const need = Math.ceil(frames * this.step) + (rs === null ? 0 : rs.lead) + 2;
    if (avail < need) {
      // Silence, hold the cursor. If the PRODUCER is active (playing/jam) this
      // is a real dropout — the worker isn't refilling the ring in time; that is
      // the Tier 2 glitch signal the audio-thread xrun counter can no longer see.
      if (this.profiling && Atomics.load(ctrl, AR_STATE)) this.pfUnderruns++;
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      Atomics.store(ctrl, AR_READ, this.arReadBase);
      return;
    }
    let base = this.arReadBase, frac = this.arReadFrac;
    const step = this.step;
    if (rs === null) {
      for (let n = 0; n < frames; n++) {
        const a = base & AR_MASK;
        outL[n] = L[a];
        outR[n] = R[a];
        base = (base + 1) | 0;
      }
    } else {
      const { rows, deltas, phases, history, nTaps } = rs;
      const floor = this.arFloor;
      for (let n = 0; n < frames; n++) {
        const fp = frac * phases;
        const p = fp | 0;
        const g = fp - p;
        const row = rows[p], dRow = deltas[p];
        const first = (base - history) | 0;
        let l = 0.0, r = 0.0;
        for (let t = 0; t < nTaps; t++) {
          // Counters are Int32-wrapping, so "older than the floor" is a signed
          // DIFFERENCE, never a plain <.
          const src = (first + t) | 0;
          const a = (((src - floor) | 0) < 0 ? floor : src) & AR_MASK;
          const w = row[t] + dRow[t] * g;
          l += L[a] * w;
          r += R[a] * w;
        }
        outL[n] = l;
        outR[n] = r;
        frac += step;
        while (frac >= 1) { frac -= 1; base = (base + 1) | 0; }
      }
    }
    this.arReadBase = base;
    this.arReadFrac = frac;
    Atomics.store(ctrl, AR_READ, base);
  }

  emitProfile(quantumMs) {
    const audioMs = this.pfFrames / sampleRate * 1000;
    this.port.postMessage({
      t: MSG.PROFILE,
      cpuFrac: audioMs > 0 ? this.pfProcBusy / audioMs : 0,
      renderFrac: audioMs > 0 ? this.pfRenderBusy / audioMs : 0,
      procMeanMs: this.pfProcCount ? this.pfProcBusy / this.pfProcCount : 0,
      procMaxMs: this.pfProcMax,
      renderMeanMs: this.pfRenderCount ? this.pfRenderBusy / this.pfRenderCount : 0,
      renderMaxMs: this.pfRenderMax,
      quantumMs,
      xruns: this.pfXruns,
      underruns: this.pfUnderruns,
      procCount: this.pfProcCount,
      renderCount: this.pfRenderCount,
      peakVoices: this.pfPeakVoices,
      windowMs: audioMs,
      sampleRate,
      step: this.step,
      sab: this.sabF32 !== null || this.audioRing !== null,
      workerRender: this.audioRing !== null,
      hiResClock: this.hiResClock,
      clockResMs: this.clockResMs,
    });
    this.pfReset();
  }

  process(_inputs, outputs) {
    const t0 = this.profiling ? this.clockNow() : 0;
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : outputs[0][0];
    const frames = outL.length;

    if (this.audioRing) {
      this.consumeFromRing(outL, outR, frames);
    } else {
      this.renderAndPlay(outL, outR, frames);
    }

    if (this.profiling) {
      // Measure the whole callback — the work the audio thread must finish
      // within one quantum. The report post itself is excluded (dt before emit).
      const dt = this.clockNow() - t0;
      this.pfProcBusy += dt;
      if (dt > this.pfProcMax) this.pfProcMax = dt;
      this.pfProcCount++;
      const quantumMs = frames / sampleRate * 1000;
      if (dt > quantumMs) this.pfXruns++;
      this.pfFrames += frames;
      if (this.pfFrames >= this.profileIntervalFrames) this.emitProfile(quantumMs);
    }
    return true;
  }
}

registerProcessor("taud-processor", TaudProcessor);
