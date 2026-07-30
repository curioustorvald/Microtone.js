// Binaural monitoring (#998.3) — the render target that makes a surround song
// AUDIBLE on headphones while you compose it.
//
// Why this exists: playback normally installs StereoRenderer, which folds the
// rear semicircle onto the front and collapses elevation toward the centre. It
// is the right stereo DOWNMIX, but it is a projection: behind sounds exactly
// like in front, and height is inaudible. Authoring a position you cannot hear
// is a non-starter, so this file adds a second monitor path.
//
// ── Why virtual speakers ──
// A SpatialRenderer answers one question — "what GAIN does a source at (az, el)
// get in each of my channels?" — one broadband scalar per channel. Direction-
// dependent FILTERING (the interaural delay, the head's shadow, the pinna's
// spectral cues) cannot be expressed that way. So the bus channels become a
// fixed ring/sphere of VIRTUAL SPEAKERS, a source is amplitude-panned across
// them, and the per-speaker HRTF — fixed, therefore precomputable — is applied
// in `monitorStereo`, which the mixer calls once per frame in order. That
// ordering is what lets this renderer be stateful (delay lines, filters) while
// every other renderer stays a pure function.
//
// ── The head model ──
// This is a PARAMETRIC model, not a measured HRTF set (no dependencies, no
// megabytes of impulse responses, and no per-listener fitting):
//   * ITD — Woodworth's spherical-head path length, applied to the LOW band
//     only. Above ~1.1 kHz the ear stops using interaural phase, and delaying
//     only the low band is also what keeps amplitude panning between two
//     virtual speakers from combing: the comb notch of the delay DIFFERENCE
//     between neighbours lands above the crossover, where nothing is delayed.
//   * ILD — the Brown & Duda head-shadow shelf: unity at DC, α(θ) at HF with
//     α = 1.05 + 0.95·cos(θ·180/150), corner c/(π·a) ≈ 1.25 kHz.
//   * Elevation and front/back — OUR OWN cue pair, tuned by ear rather than
//     measured: a pinna notch that rises with elevation (≈4 kHz below, 7 kHz
//     at ear level, 12 kHz overhead) and is deepest for frontal sources where
//     the pinna actually faces the source, plus a shelf that brightens sources
//     that are above and/or in front. Both are direction-only cues, so they sit
//     BEFORE the ear split and cost one biquad + one shelf per speaker.
// Everything is unity-gain at DC, so the output level is calibrated by a single
// constant against the stereo pan law (a front-centre source reads 0.707 per
// ear, exactly as the fold gives it).
//
// Not a port: the Kotlin engine has no surround at all, so this file — like
// spatial.js — IS the reference implementation.

import { SAMPLING_RATE } from "./constants.js";
import {
  AZIMUTH_TURN, ELEVATION_QUARTER, directionFromAngles,
} from "./spatial.js";

/** Monitor modes (playhead state). Fold = StereoRenderer, the default. */
export const MONITOR_FOLD = 0;
export const MONITOR_BINAURAL = 1;

/** Head radius (m) and speed of sound (m/s) — the spherical-head model's only
 *  physical constants; a/c is the maximum one-way path detour. */
const BIN_HEAD_RADIUS = 0.0875;
const BIN_SOUND_SPEED = 343.0;

/** Amplitude-panning sharpness: gains ∝ max(0, cos γ)^BIN_PAN_EXP, then
 *  energy-normalised. High enough that a source AT a speaker keeps ~83 % of its
 *  energy there, low enough that the pan stays continuous as it moves. */
const BIN_PAN_EXP = 8;

/** ITD crossover: only this band is delayed (see the header). */
const BIN_ITD_LP_HZ = 1100.0;
/** Pinna-notch centre at ear level, its ± octave swing, depth and width. */
const BIN_NOTCH_HZ = 7000.0;
const BIN_NOTCH_OCTAVES = 0.75;
const BIN_NOTCH_DB = 7.0;
const BIN_NOTCH_Q = 1.6;
/** Direction shelf: dB at HF = elevation term + front/back term, at this corner. */
const BIN_SHELF_HZ = 4000.0;
const BIN_SHELF_EL_DB = 6.0;
const BIN_SHELF_FB_DB = 3.0;
/**
 * Level contract: a source sitting AT a virtual speaker must leave the head
 * with the same total power the stereo pan law would have given it
 * (cos² + sin² = 1). The head's own filters do not obey that on their own — the
 * near ear's shadow shelf BOOSTS by up to 6 dB — so each speaker's feed is
 * scaled by the calibration below. It equalises the SUM of the two ears and
 * leaves their RATIO alone, which is the whole cue. Frequency grid size for
 * that integral (midpoint rule over 0…Nyquist, white-weighted, i.e. what an RMS
 * measurement on broadband noise sees).
 */
const BIN_CALIB_BANDS = 96;

/** Delay-line length in frames — a power of two ≥ the longest ITD (~21 frames
 *  at 32 kHz, since (a/c)(1 + π/2) ≈ 0.65 ms). */
const BIN_RING = 32;
const BIN_RING_MASK = BIN_RING - 1;

/**
 * Virtual speaker directions as [azimuth, elevation] pairs in engine units.
 * Planar songs get a 12-point horizontal ring (30° apart, with speakers exactly
 * at front/back/left/right); a spatial song adds ±45° rings and the two poles,
 * 26 in all. Denser is smoother and linearly more expensive — this is the
 * playback path, so it is deliberately the coarsest layout that still moves
 * continuously.
 */
export function binauralSpeakerLayout(sphere) {
  const out = [];
  const ring = (count, el) => {
    for (let k = 0; k < count; k++) out.push([(k * AZIMUTH_TURN) / count, el]);
  };
  ring(12, 0);
  if (sphere) {
    ring(6, ELEVATION_QUARTER / 2);
    ring(6, -ELEVATION_QUARTER / 2);
    out.push([128, ELEVATION_QUARTER], [128, -ELEVATION_QUARTER]);
  }
  return out;
}

/**
 * First-order shelf H(s) = (1 + G·s/ω)/(1 + s/ω) — unity at DC, `gainHf` at
 * Nyquist — bilinear-transformed into y = b0·x + b1·x₋₁ − a1·y₋₁. Both the head
 * shadow (G = α) and the direction shelf are this same section.
 */
export function binauralShelf(gainHf, fc, fs, out, off) {
  const k = fs / (Math.PI * fc);
  out[off] = (1.0 + gainHf * k) / (1.0 + k);
  out[off + 1] = (1.0 - gainHf * k) / (1.0 + k);
  out[off + 2] = (1.0 - k) / (1.0 + k);
  return out;
}

/**
 * RBJ peaking section with negative gain — the pinna notch. Unity at DC and at
 * Nyquist (so it colours the cue band and nothing else), `db` deep at `fc`.
 * Written as b0, b1, b2, a1, a2 with a0 divided out.
 */
export function binauralNotch(db, fc, q, fs, out, off) {
  const w0 = (2.0 * Math.PI * Math.min(fc, fs * 0.45)) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2.0 * q);
  const a = Math.pow(10.0, -db / 40.0); // db > 0 → a cut
  const a0 = 1.0 + alpha / a;
  out[off] = (1.0 + alpha * a) / a0;
  out[off + 1] = (-2.0 * cw) / a0;
  out[off + 2] = (1.0 - alpha * a) / a0;
  out[off + 3] = (-2.0 * cw) / a0;
  out[off + 4] = (1.0 - alpha / a) / a0;
  return out;
}

/**
 * One-way propagation delay (seconds) to an ear at `earY` (+1 left, −1 right)
 * for a source whose direction has left/right component `dy` — Woodworth: the
 * near side arrives early by a·cos, the far side has to creep round the sphere.
 * The ear axis is ±y, so nothing else about the direction matters. Offset so
 * the value is never negative: the absolute delay is inaudible, and a delay
 * line cannot look ahead.
 */
export function binauralEarDelay(dy, earY) {
  const cosA = dy * earY; // |d| = 1, so this is the cosine of the angle
  const a = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
  const t = a <= Math.PI / 2 ? -Math.cos(a) : a - Math.PI / 2;
  return ((t + 1.0) * BIN_HEAD_RADIUS) / BIN_SOUND_SPEED;
}

// ── frequency responses, used once per construction by the calibration ────
// Complex values are [re, im] pairs in a scratch array; none of this runs while
// audio does.

/** Complex response of a biquad b0,b1,b2 / 1,a1,a2 at digital frequency w. */
function binBiquadResp(c, off, w, out) {
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[off] + c[off + 1] * c1 + c[off + 2] * c2;
  const ni = -(c[off + 1] * s1 + c[off + 2] * s2);
  const dr = 1 + c[off + 3] * c1 + c[off + 4] * c2;
  const di = -(c[off + 3] * s1 + c[off + 4] * s2);
  const den = dr * dr + di * di;
  out[0] = (nr * dr + ni * di) / den;
  out[1] = (ni * dr - nr * di) / den;
  return out;
}

/** Same, for a first-order section b0,b1 / 1,a1. */
function binShelfResp(c, off, w, out) {
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const nr = c[off] + c[off + 1] * c1;
  const ni = -(c[off + 1] * s1);
  const dr = 1 + c[off + 2] * c1;
  const di = -(c[off + 2] * s1);
  const den = dr * dr + di * di;
  out[0] = (nr * dr + ni * di) / den;
  out[1] = (ni * dr - nr * di) / den;
  return out;
}

const binDir = new Float64Array(3);

/**
 * Headphone render target: the bus carries virtual-speaker feeds, and the
 * monitor pair is those feeds through the head model. `numChannels` is the
 * layout size, so this costs (speakers × voices) multiplies per frame in the
 * mixer — the reason the layout stays small.
 */
export class BinauralRenderer {
  constructor(sphere = true, sampleRate = SAMPLING_RATE) {
    this.sphere = sphere;
    this.layout = binauralSpeakerLayout(sphere);
    this.numChannels = this.layout.length;
    this.name = `binaural-${sphere ? "3d" : "2d"}`;
    this.sampleRate = sampleRate;

    const ns = this.numChannels;
    /** Unit vector per speaker — the panner compares directions, not angles. */
    this.dirs = new Float64Array(ns * 3);
    this.notch = new Float64Array(ns * 5);
    this.shelf = new Float64Array(ns * 3);
    this.shadow = new Float64Array(ns * 2 * 3);   // [speaker][ear] shelf
    this.delayInt = new Int32Array(ns * 2);
    this.delayFrac = new Float64Array(ns * 2);

    for (let s = 0; s < ns; s++) {
      const [az, el] = this.layout[s];
      directionFromAngles(az, el, binDir);
      const dx = binDir[0], dy = binDir[1], dz = binDir[2];
      this.dirs[s * 3] = dx;
      this.dirs[s * 3 + 1] = dy;
      this.dirs[s * 3 + 2] = dz;

      // Direction-only cues (ear-independent): the notch rises with elevation
      // and is deepest where the pinna faces the source; the shelf brightens
      // what is above and in front.
      const front = dx > 0 ? dx : 0;
      const sinEl = dz;
      binauralNotch(
        BIN_NOTCH_DB * (0.35 + 0.65 * front),
        BIN_NOTCH_HZ * Math.pow(2.0, BIN_NOTCH_OCTAVES * sinEl),
        BIN_NOTCH_Q, sampleRate, this.notch, s * 5,
      );
      const shelfDb = BIN_SHELF_EL_DB * sinEl + BIN_SHELF_FB_DB * dx;
      binauralShelf(Math.pow(10.0, shelfDb / 20.0), BIN_SHELF_HZ, sampleRate, this.shelf, s * 3);

      for (let ear = 0; ear < 2; ear++) {
        const earY = ear === 0 ? 1.0 : -1.0;
        // Brown & Duda: α runs 2.0 at the ear's own axis down to 0.1 at 150°.
        const theta = Math.acos(Math.max(-1, Math.min(1, dy * earY)));
        const alpha = 1.05 + 0.95 * Math.cos((theta * 180.0) / 150.0);
        binauralShelf(alpha, BIN_SOUND_SPEED / (Math.PI * BIN_HEAD_RADIUS),
          sampleRate, this.shadow, (s * 2 + ear) * 3);
        const d = binauralEarDelay(dy, earY) * sampleRate;
        const di = Math.floor(d);
        this.delayInt[s * 2 + ear] = di;
        this.delayFrac[s * 2 + ear] = d - di;
      }
    }

    // Filter + delay state, all flat and preallocated (this runs per frame).
    this.notchState = new Float64Array(ns * 2);
    this.shelfState = new Float64Array(ns * 2);   // [x₋₁, y₋₁]
    this.shadowState = new Float64Array(ns * 2 * 2);
    this.lpState = new Float64Array(ns);
    this.ring = new Float64Array(ns * BIN_RING);
    this.ringPos = 0;
    this.lpA = 1.0 - Math.exp((-2.0 * Math.PI * BIN_ITD_LP_HZ) / sampleRate);
    this._g = new Float64Array(ns);
    this._calibrate();
  }

  /**
   * Scale each speaker's feed so both ears together carry unit power for unit
   * broadband input — see BIN_CALIB_BANDS. The gain is folded into the notch's
   * numerator, which is the first thing every sample meets, so it costs nothing
   * at run time. Cheap enough to redo whenever the model is rebuilt (once per
   * song, at most).
   */
  _calibrate() {
    const ns = this.numChannels;
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    for (let s = 0; s < ns; s++) {
      let acc = 0.0;
      for (let k = 0; k < BIN_CALIB_BANDS; k++) {
        const w = (Math.PI * (k + 0.5)) / BIN_CALIB_BANDS;
        binBiquadResp(this.notch, s * 5, w, a);
        binShelfResp(this.shelf, s * 3, w, b);
        // Direction-only stages, common to both ears.
        const dr = a[0] * b[0] - a[1] * b[1];
        const di = a[0] * b[1] + a[1] * b[0];
        // The ITD crossover: the low band is delayed, the high band is not, so
        // the split is a (mild) comb of its own and belongs in the integral.
        const lp = this.lpA;
        const lr = 1 - (1 - lp) * Math.cos(w);
        const li = (1 - lp) * Math.sin(w);
        const lden = lr * lr + li * li;
        const lo_r = (lp * lr) / lden;
        const lo_i = (-lp * li) / lden;
        for (let ear = 0; ear < 2; ear++) {
          const j = s * 2 + ear;
          const d = this.delayInt[j] + this.delayFrac[j];
          const cd = Math.cos(w * d), sd = -Math.sin(w * d);
          // lo·e^{-jwd} + (1 − lo)
          const pr = lo_r * cd - lo_i * sd + (1 - lo_r);
          const pi = lo_r * sd + lo_i * cd - lo_i;
          binShelfResp(this.shadow, j * 3, w, b);
          const er = pr * b[0] - pi * b[1];
          const ei = pr * b[1] + pi * b[0];
          const tr = dr * er - di * ei;
          const ti = dr * ei + di * er;
          acc += tr * tr + ti * ti;
        }
      }
      const comp = 1.0 / Math.sqrt(acc / BIN_CALIB_BANDS);
      this.notch[s * 5] *= comp;
      this.notch[s * 5 + 1] *= comp;
      this.notch[s * 5 + 2] *= comp;
    }
  }

  /** Reset every filter and delay line (a new song, or a monitor switch). */
  reset() {
    this.notchState.fill(0);
    this.shelfState.fill(0);
    this.shadowState.fill(0);
    this.lpState.fill(0);
    this.ring.fill(0);
    this.ringPos = 0;
  }

  /**
   * Amplitude-pan a source across the layout: cos^n of the angle to each
   * speaker, then normalised so the gains SUM to one.
   *
   * Sum, not sum-of-squares: loudspeakers in a room decorrelate and add in
   * power, but here every virtual speaker feeding an ear is the same signal
   * through a slightly different head, so it adds in AMPLITUDE — energy
   * normalisation would make a phantom direction 3 dB louder than a source
   * sitting on a speaker. A direction no speaker can see (only reachable if a
   * planar layout is handed an elevated source) spreads evenly rather than
   * falling silent.
   */
  channelGains(az, el, out, off) {
    directionFromAngles(az, el, binDir);
    const ns = this.numChannels;
    const dirs = this.dirs;
    const g = this._g;
    let sum = 0.0;
    for (let s = 0; s < ns; s++) {
      const c = binDir[0] * dirs[s * 3] + binDir[1] * dirs[s * 3 + 1] + binDir[2] * dirs[s * 3 + 2];
      const w = c > 0 ? Math.pow(c, BIN_PAN_EXP) : 0.0;
      g[s] = w;
      sum += w;
    }
    if (sum <= 0.0) {
      const u = 1.0 / ns;
      for (let s = 0; s < ns; s++) out[off + s] = u;
      return;
    }
    const norm = 1.0 / sum;
    for (let s = 0; s < ns; s++) out[off + s] = g[s] * norm;
  }

  /**
   * The head model, one frame at a time (the mixer calls this in frame order,
   * which is what makes the state below legal). Per speaker: pinna notch →
   * direction shelf → split at the ITD crossover; per ear: delay the low band,
   * add the undelayed high band, then the head shadow.
   */
  monitorStereo(data, frames, n, out) {
    const ns = this.numChannels;
    const notch = this.notch, nst = this.notchState;
    const shelf = this.shelf, sst = this.shelfState;
    const shadow = this.shadow, hst = this.shadowState;
    const ring = this.ring, pos = this.ringPos;
    const dInt = this.delayInt, dFrac = this.delayFrac;
    const lpA = this.lpA, lp = this.lpState;
    let l = 0.0;
    let r = 0.0;

    for (let s = 0; s < ns; s++) {
      const x = data[s * frames + n];

      // Pinna notch — transposed direct form II.
      const nc = s * 5;
      const y = notch[nc] * x + nst[s * 2];
      nst[s * 2] = notch[nc + 1] * x - notch[nc + 3] * y + nst[s * 2 + 1];
      nst[s * 2 + 1] = notch[nc + 2] * x - notch[nc + 4] * y;

      // Direction shelf — first order, y = b0·x + b1·x₋₁ − a1·y₋₁.
      const sc = s * 3;
      const sv = shelf[sc] * y + shelf[sc + 1] * sst[s * 2] - shelf[sc + 2] * sst[s * 2 + 1];
      sst[s * 2] = y;
      sst[s * 2 + 1] = sv;

      // ITD crossover: the low band goes down the delay line, the high band
      // bypasses it (and the two sum back to sv when the delay is zero).
      const lo = lp[s] + lpA * (sv - lp[s]);
      lp[s] = lo;
      const hi = sv - lo;
      const base = s * BIN_RING;
      ring[base + (pos & BIN_RING_MASK)] = lo;

      for (let ear = 0; ear < 2; ear++) {
        const j = s * 2 + ear;
        const i0 = pos - dInt[j];
        const f = dFrac[j];
        const d0 = ring[base + (i0 & BIN_RING_MASK)];
        const d1 = ring[base + ((i0 - 1) & BIN_RING_MASK)];
        const ear_in = d0 + (d1 - d0) * f + hi;
        const hc = j * 3;
        const hs = shadow[hc] * ear_in + shadow[hc + 1] * hst[j * 2] - shadow[hc + 2] * hst[j * 2 + 1];
        hst[j * 2] = ear_in;
        hst[j * 2 + 1] = hs;
        if (ear === 0) l += hs; else r += hs;
      }
    }

    this.ringPos = pos + 1;
    out[0] = l;
    out[1] = r;
  }
}
