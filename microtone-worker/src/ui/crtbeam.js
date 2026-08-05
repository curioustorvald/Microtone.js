// Current-limited CRT beam (item 106) — how the master strip's Lissajous scopes
// are drawn.
//
// A vectorscope is not a scatter plot. The thing it is imitating has ONE beam
// that is dragged continuously from where the last sample was to where this one
// is, and everything that makes such a display readable comes out of that:
//
//   * the trace is CONNECTED. Between two samples the beam sweeps a line, so a
//     signal that moves a long way in one sample is a streak rather than two
//     unrelated specks. Plotting points alone is what made the old cloud read
//     as a fog at high frequencies — the very case where the shape matters.
//   * a SLOW beam is BRIGHT. The gun delivers a roughly constant charge per unit
//     TIME, so the ink it leaves per unit LENGTH goes as 1/speed: the turning
//     points of a Lissajous figure, where the beam dwells, burn in while the
//     fast diagonal between them stays faint. That contrast is the reading —
//     it is what tells you where the energy actually sits.
//   * a FAST beam is dimmer still, because the deflection amplifier cannot hold
//     full current through a hard slew. That is the "current limiting": a beam
//     moving at velocity v draws 1 / (1 + k·v) of what a resting one draws.
//   * the screen ACCUMULATES. Energy is added, never replaced, so twenty traces
//     crossing one pixel really is twenty times the energy — and it fades on its
//     own between frames (energy ×= e^(−dt/τ)) instead of being cleared, which
//     is why the display is smooth at any frame rate and why it dies away when
//     the music stops rather than freezing on the last window.
//
// So the render target is FLOATING POINT ENERGY, not pixels: strokes accumulate
// into it unbounded, and only at the very end is it developed into ink through a
// saturating response and a gamma. That order is the whole point — saturate
// first and the twentieth crossing would be indistinguishable from the second.
//
// Nothing in here touches the DOM: it owns a Float32Array and fills a caller's
// RGBA bytes, which is what lets test/node/crtbeam.test.js drive the real
// painter. src/ui/views/masterstrip.js owns the canvas it is blitted through.

/**
 * Pen width — σ of the Gaussian spot, in buffer pixels. A real spot is a fixed
 * size on the SCREEN, but a dial here is anywhere from 48 to 300 px across and a
 * spot scaled to that would be a hairline on the small ones; a fixed pixel width
 * keeps every panel equally legible.
 */
export const BEAM_SIGMA = 0.5;
/** Where the pen is truncated, in σ. Past 3σ it contributes under 1.2%. */
export const BEAM_REACH = 3;

/**
 * Phosphor persistence. Near enough the old fixed 128 ms window, so the display
 * still settles into something you can compare from moment to moment, but it is
 * a TIME now rather than a sample count: the trace fades the same way whatever
 * the frame rate, and stopping playback lets it go dark.
 */
export const PHOSPHOR_TAU_MS = 90;
/** Energy below this is snapped to zero, so a decayed pixel stops costing. */
export const BEAM_FLOOR = 1e-3;

/**
 * Current limiting. `beamVelocity` is measured in DIAL RADII per sample, which
 * is what makes the look independent of the panel's size: a full-scale 1 kHz
 * tone sweeps ~0.13 radii per sample at 48 kHz, 5 kHz sweeps ~0.65. So k is set
 * for a gentle darkening across the audible band rather than a cliff. It is
 * rate-coupled by that definition — k was 0.6 while the engine ran at 32 kHz
 * (item 108) and is scaled by 48/32 to keep the same tone at the same
 * brightness.
 */
export const BEAM_LIMIT_K = 0.9;

/**
 * Oversampling. The beam does not fly in straight lines between samples — it
 * follows the reconstructed waveform — so a span whose neighbours say it is
 * CURVED is subdivided along a Catmull-Rom through them before it is drawn.
 * The count comes from the curvature, not the length: a straight span of any
 * length is already drawn exactly by one stroke, and subdividing it would only
 * rasterise the same pixels again.
 */
export const BEAM_FLATNESS_PX = 0.5;
export const BEAM_MAX_STEPS = 8;

/**
 * Energy that develops to ~63% ink. Everything else about the look hangs off
 * this: a trace much fainter than the reference is in the graded region where
 * density reads as density, one much brighter saturates and starts to bloom.
 */
export const BEAM_ENERGY_REF = 2.0;
/** Display gamma applied after the response, lifting the faint end. */
export const BEAM_GAMMA = 2.2;
/**
 * Bloom: how many times the reference energy a pixel needs before it stops
 * getting more OPAQUE and starts getting WHITER. Ink alpha runs out at a dozen
 * crossings or so; without this, a hundred crossings would look like a dozen.
 */
export const BEAM_BLOOM = 12;

// ── the pure curves (unit-tested in test/node/crtbeam.test.js) ─────────────

/** Beam current at a given velocity in dial radii per sample: 1 at rest. */
export function beamCurrent(velocity, k = BEAM_LIMIT_K) {
  return 1 / (1 + k * (velocity > 0 ? velocity : 0));
}

/** Fraction of a pixel's energy left after `dtMs` of phosphor decay. */
export function phosphorDecay(dtMs, tauMs = PHOSPHOR_TAU_MS) {
  return dtMs <= 0 ? 1 : Math.exp(-dtMs / tauMs);
}

/**
 * What a frame's worth of charge is worth by the END of that frame. A display
 * frame decays once and then lays down a whole frame of samples, but those
 * samples actually arrived spread ACROSS the interval and have been fading ever
 * since, so they are worth the average of e^(−u/τ) over it rather than all of
 * it. Without this a 30 fps display reads over 10% brighter than a 120 fps one
 * — the same trace, told twice, at two brightnesses.
 */
export function frameWeight(dtMs, tauMs = PHOSPHOR_TAU_MS) {
  if (!(dtMs > 0)) return 1;
  const u = dtMs / tauMs;
  return (1 - Math.exp(-u)) / u;
}

/**
 * The phosphor's own response: saturating, so a faint trace getting twice the
 * energy nearly doubles while a hot one can barely get hotter.
 */
export function phosphorResponse(energy, ref = BEAM_ENERGY_REF) {
  return energy <= 0 ? 0 : 1 - Math.exp(-energy / ref);
}

/** Response then gamma — energy → ink alpha, 0…1. */
export function beamAlpha(energy, ref = BEAM_ENERGY_REF, gamma = BEAM_GAMMA) {
  const v = phosphorResponse(energy, ref);
  return v <= 0 ? 0 : Math.pow(v, 1 / gamma);
}

/**
 * How far past saturation a pixel is, 0…1 — the trace's colour is lifted toward
 * white by this, which is how density keeps reading after alpha has run out.
 * Squared so it stays out of the way until the pixel really is overdriven.
 */
export function beamBloom(energy, ref = BEAM_ENERGY_REF, bloom = BEAM_BLOOM) {
  if (energy <= 0) return 0;
  const v = 1 - Math.exp(-energy / (ref * bloom));
  return v * v;
}

/**
 * What "past saturation" looks like on a given ground. An overdriven phosphor
 * goes WHITE, which is the reading on the dark themes and no reading at all on
 * the light one — a white core on white paper is an invisible one. There,
 * density has to go the other way, as ink getting blacker.
 */
export function beamCoreInk(bg) {
  const lum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  return lum > 140 ? [0, 0, 0] : [255, 255, 255];
}

/** Uniform Catmull-Rom through p0..p3, evaluated on the p1→p2 span. */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 +
    (p2 - p0) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (3 * p1 - 3 * p2 + p3 - p0) * t3);
}

/**
 * Sub-steps for a span whose Catmull-Rom bows `bow` pixels away from its chord
 * (the larger of the two second differences). A cubic's error falls as the
 * square of the subdivision, hence the root.
 */
export function segmentSteps(bow, flatness = BEAM_FLATNESS_PX, max = BEAM_MAX_STEPS) {
  if (!(bow > flatness)) return 1;
  const n = Math.ceil(Math.sqrt(bow / flatness));
  return n > max ? max : n;
}

// ── lookup tables ─────────────────────────────────────────────────────────
// The inner loops run over ~10⁵ pixels per panel per frame, so neither the pen
// nor the development calls Math.exp: both are tabulated from the curves above.

const REACH_PX = BEAM_SIGMA * BEAM_REACH;
const REACH2 = REACH_PX * REACH_PX;
const GAUSS_N = 256;
/** d² → pen table index. */
const GAUSS_SCALE = GAUSS_N / REACH2;
const GAUSS = (() => {
  const t = new Float32Array(GAUSS_N);
  const denom = 2 * BEAM_SIGMA * BEAM_SIGMA;
  for (let i = 0; i < GAUSS_N; i++) t[i] = Math.exp(-((i + 0.5) / GAUSS_SCALE) / denom);
  return t;
})();

const RESP_N = 256;
/** Tabulated up to this much energy; anything hotter develops as the last entry
 *  (fully opaque, fully bloomed) and there is nothing further to say about it. */
const RESP_MAX = BEAM_ENERGY_REF * 64;
/** √energy → response index, so the resolution is finest where the eye is. */
const RESP_SCALE = (RESP_N - 1) / Math.sqrt(RESP_MAX);
const RESP_A = new Uint8Array(RESP_N);
const RESP_W = new Float32Array(RESP_N);
for (let i = 0; i < RESP_N; i++) {
  const e = (i / RESP_SCALE) ** 2;
  RESP_A[i] = Math.round(255 * beamAlpha(e));
  RESP_W[i] = beamBloom(e);
}

// ── the beam ──────────────────────────────────────────────────────────────

/**
 * One square energy buffer and the beam that writes into it. Coordinates handed
 * to `trace` are in DIAL units — ±1 is the dial's rim, +y up — so the caller
 * never has to know the buffer's size, and the physics constants above stay in
 * units that mean something.
 */
export class CrtBeam {
  constructor(size) {
    this.size = 0;
    this.energy = null;
    this.deposit = 1; // this frame's charge scale — see decay()
    this.resize(size);
  }

  resize(size) {
    const s = Math.max(4, Math.round(size));
    if (s === this.size) return;
    this.size = s;
    this.mid = s / 2;
    // One pixel of margin, so a sample at full deflection still has room for
    // the pen's skirt rather than being clipped by the edge.
    this.radius = s / 2 - 1;
    this.energy = new Float32Array(s * s);
    this.lift();
  }

  /** Lift the beam: the next sample starts a fresh trace instead of being
   *  joined to wherever it happened to be left. */
  lift() {
    this.hasLast = false;
    this.px = this.py = this.qx = this.qy = 0;
  }

  clear() {
    this.energy.fill(0);
    this.lift();
  }

  /**
   * Advance the phosphor by `dtMs` of wall time, opening a new frame. Call it
   * once per displayed frame, before tracing that frame's samples: it also
   * fixes what those samples are worth by the time the frame is shown (see
   * frameWeight), which is what keeps the display's brightness the same at
   * every frame rate rather than only its shape.
   */
  decay(dtMs) {
    if (!(dtMs > 0)) return;
    this.deposit = frameWeight(dtMs);
    const k = phosphorDecay(dtMs);
    const e = this.energy;
    for (let i = 0; i < e.length; i++) {
      const v = e[i];
      if (v === 0) continue;
      const d = v * k;
      e[i] = d > BEAM_FLOOR ? d : 0;
    }
  }

  /**
   * Sweep the beam through `n` consecutive samples, `xs`/`ys` in dial units.
   * The beam is not lifted between calls, so successive frames of the same ring
   * join up into one continuous trace.
   */
  trace(xs, ys, n) {
    if (n <= 0) return;
    const mid = this.mid;
    const rad = this.radius;
    for (let i = 0; i < n; i++) {
      const x = mid + xs[i] * rad;
      const y = mid - ys[i] * rad;
      if (!this.hasLast) {
        // Nothing to sweep FROM yet: park the beam and start drawing at the
        // next sample. Only the first sample of a fresh trace pays this.
        this.hasLast = true;
        this.qx = this.px = x;
        this.qy = this.py = y;
        continue;
      }
      const j = i + 1 < n ? i + 1 : i;
      this.sweep(this.qx, this.qy, this.px, this.py,
        x, y, mid + xs[j] * rad, mid - ys[j] * rad);
      this.qx = this.px;
      this.qy = this.py;
      this.px = x;
      this.py = y;
    }
  }

  /**
   * One sample period of beam travel, from p1 to p2, with p0 and p3 the
   * neighbouring samples that say how the span is curved.
   */
  sweep(x0, y0, x1, y1, x2, y2, x3, y3) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const chord = Math.sqrt(dx * dx + dy * dy);
    // Current limiting is a property of the SAMPLE step — it is the deflection
    // amplifier that is being asked to slew, and it sees one sample period —
    // so it is computed once here and not per sub-step.
    const cur = beamCurrent(chord / (this.radius > 0 ? this.radius : 1));
    // Second differences: how far the reconstructed curve leaves the chord.
    const ax = Math.abs(x0 - 2 * x1 + x2) + Math.abs(y0 - 2 * y1 + y2);
    const bx = Math.abs(x1 - 2 * x2 + x3) + Math.abs(y1 - 2 * y2 + y3);
    const steps = segmentSteps(ax > bx ? ax : bx);
    const inv = 1 / steps;

    let cx = x1;
    let cy = y1;
    for (let s = 1; s <= steps; s++) {
      const t = s * inv;
      const nx = steps === 1 ? x2 : catmullRom(x0, x1, x2, x3, t);
      const ny = steps === 1 ? y2 : catmullRom(y0, y1, y2, y3, t);
      const lx = nx - cx;
      const ly = ny - cy;
      const len = Math.sqrt(lx * lx + ly * ly);
      // Charge conservation: this sub-step carries 1/steps of the sample
      // period's charge, spread over the length it covers — go twice as far in
      // the same time and every pixel gets half as much. A beam cannot
      // concentrate below its own spot, which is what the floor of 1 px is; a
      // resting beam therefore burns at full current, as it should.
      this.stroke(cx, cy, nx, ny, (inv * cur * this.deposit) / (len > 1 ? len : 1));
      cx = nx;
      cy = ny;
    }
  }

  /**
   * The pen: add exp(−d²/2σ²)·`amp` to every pixel within reach of the segment,
   * where d is the distance to the NEAREST POINT ON IT. Doing it against the
   * segment rather than its endpoints is what makes a fast sweep a clean streak
   * instead of a row of blobs.
   */
  stroke(x0, y0, x1, y1, amp) {
    const size = this.size;
    const e = this.energy;
    let minX = Math.floor((x0 < x1 ? x0 : x1) - REACH_PX);
    let maxX = Math.ceil((x0 > x1 ? x0 : x1) + REACH_PX);
    let minY = Math.floor((y0 < y1 ? y0 : y1) - REACH_PX);
    let maxY = Math.ceil((y0 > y1 ? y0 : y1) + REACH_PX);
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > size - 1) maxX = size - 1;
    if (maxY > size - 1) maxY = size - 1;
    if (minX > maxX || minY > maxY) return;

    const vx = x1 - x0;
    const vy = y1 - y0;
    const len2 = vx * vx + vy * vy;
    const invLen2 = len2 > 1e-12 ? 1 / len2 : 0;
    // A steep stroke crosses each row in a narrow band, and walking the whole
    // bounding box for it costs O(length²) where the ink is only O(length) —
    // which is exactly the case a bright, fast trace puts the scope in. So
    // steep strokes get their row spans computed: the pen reaches this far
    // either side of wherever the segment crosses the row (the slab's width,
    // plus one radius to cover the end caps).
    const absVy = vy < 0 ? -vy : vy;
    const rowHalf = absVy > 1e-6 ? REACH_PX * (Math.sqrt(len2) / absVy + 1) : Infinity;
    const banded = rowHalf * 2 < maxX - minX;

    for (let py = minY; py <= maxY; py++) {
      const wy = py + 0.5 - y0;
      const row = py * size;
      let lo = minX;
      let hi = maxX;
      if (banded) {
        let t = wy / vy;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const c = x0 + t * vx - 0.5; // pixel px is centred at px + 0.5
        lo = Math.ceil(c - rowHalf);
        hi = Math.floor(c + rowHalf);
        if (lo < minX) lo = minX;
        if (hi > maxX) hi = maxX;
      }
      const wyvy = wy * vy;
      for (let px = lo; px <= hi; px++) {
        const wx = px + 0.5 - x0;
        let t = (wx * vx + wyvy) * invLen2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = wx - vx * t;
        const dy = wy - vy * t;
        const d2 = dx * dx + dy * dy;
        if (d2 >= REACH2) continue;
        e[row + px] += GAUSS[(d2 * GAUSS_SCALE) | 0] * amp;
      }
    }
  }

  /**
   * Develop the energy into RGBA bytes: response, gamma, and a lift toward
   * `core` where the pixel is past saturation (see beamCoreInk). `out` is an
   * ImageData's data.
   */
  develop(out, rgb, core = [255, 255, 255]) {
    const e = this.energy;
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    const dr = core[0] - r;
    const dg = core[1] - g;
    const db = core[2] - b;
    for (let i = 0, p = 0; i < e.length; i++, p += 4) {
      const v = e[i];
      if (v <= 0) {
        out[p + 3] = 0;
        continue;
      }
      let idx = (Math.sqrt(v) * RESP_SCALE) | 0;
      if (idx > RESP_N - 1) idx = RESP_N - 1;
      const w = RESP_W[idx];
      out[p] = r + dr * w;
      out[p + 1] = g + dg * w;
      out[p + 2] = b + db * w;
      out[p + 3] = RESP_A[idx];
    }
  }

  /** Total energy on the screen — what the tests watch decay. */
  totalEnergy() {
    const e = this.energy;
    let s = 0;
    for (let i = 0; i < e.length; i++) s += e[i];
    return s;
  }

  /** Energy at the hottest pixel. */
  peakEnergy() {
    const e = this.energy;
    let m = 0;
    for (let i = 0; i < e.length; i++) if (e[i] > m) m = e[i];
    return m;
  }
}
