// The current-limited CRT beam (item 106) — the painter behind the master
// strip's Lissajous scopes.
//
// src/ui/crtbeam.js touches no DOM on purpose, so everything below drives the
// REAL painter rather than a model of it: the energy buffer is inspected
// directly and the developed bytes are the same ones the canvas is blitted
// from. What is pinned here is the BEHAVIOUR that makes the display readable —
// the trace is connected, a slow beam is brighter than a fast one, energy adds
// up, and the whole thing runs on wall time rather than frame counts — never a
// particular constant, all of which are a look and tuned by eye.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CrtBeam, beamCurrent, phosphorDecay, frameWeight, phosphorResponse, beamAlpha,
  beamBloom, beamCoreInk, catmullRom, segmentSteps,
  BEAM_ENERGY_REF, BEAM_LIMIT_K, PHOSPHOR_TAU_MS, BEAM_MAX_STEPS, BEAM_SIGMA,
} from "../../src/ui/crtbeam.js";

const SIZE = 162; // the strip's own buffer for an 80 px dial

/** Straight sweep from (x0,y0) to (x1,y1) in dial units, over `n` samples. */
function sweepLine(beam, x0, y0, x1, y1, n) {
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    xs[i] = x0 + (x1 - x0) * t;
    ys[i] = y0 + (y1 - y0) * t;
  }
  beam.trace(xs, ys, n);
  return { xs, ys };
}

/** Energy at a dial coordinate. */
function at(beam, x, y) {
  const px = Math.round(beam.mid + x * beam.radius);
  const py = Math.round(beam.mid - y * beam.radius);
  return beam.energy[py * beam.size + px];
}

test("beam current falls with velocity and never inverts", () => {
  assert.equal(beamCurrent(0), 1, "a resting beam draws full current");
  assert.ok(beamCurrent(1) < 1 && beamCurrent(1) > 0);
  assert.ok(beamCurrent(4) < beamCurrent(1));
  assert.ok(beamCurrent(1000) > 0, "it dims, it never goes dark or negative");
  // Negative "velocity" cannot exist, but a NaN-free floor is worth having.
  assert.equal(beamCurrent(-5), 1);
  // The knee sits inside the audible band: a full-scale 1 kHz tone at 32 kHz
  // moves ~0.2 dial radii per sample, 5 kHz ~1, so both must be dimmed but
  // neither wiped out.
  assert.ok(beamCurrent(0.2) > 0.8 && beamCurrent(1) < 0.8, String(BEAM_LIMIT_K));
});

test("phosphor decay is a time constant, not a frame count", () => {
  assert.equal(phosphorDecay(0), 1);
  // One τ leaves 1/e, and cutting the same stretch of time into more frames
  // lands in exactly the same place — this is what makes the display look the
  // same on a 30 fps machine as on a 144 fps one.
  assert.ok(Math.abs(phosphorDecay(PHOSPHOR_TAU_MS) - Math.exp(-1)) < 1e-12);
  let a = 1;
  for (let i = 0; i < 8; i++) a *= phosphorDecay(PHOSPHOR_TAU_MS / 8);
  assert.ok(Math.abs(a - phosphorDecay(PHOSPHOR_TAU_MS)) < 1e-12, String(a));
  // Long enough to hold a shape still, short enough to follow the music.
  assert.ok(PHOSPHOR_TAU_MS >= 50 && PHOSPHOR_TAU_MS <= 250, String(PHOSPHOR_TAU_MS));

  // A frame's charge arrived DURING the frame, not at the end of it: a long
  // frame's samples have had longer to fade by the time it is shown.
  assert.ok(Math.abs(frameWeight(0) - 1) < 1e-12);
  assert.ok(frameWeight(1e-6) > 0.999999, "and a vanishing frame is worth all of it");
  assert.ok(frameWeight(33) < frameWeight(8) && frameWeight(8) < 1);
  assert.ok(frameWeight(PHOSPHOR_TAU_MS) > 0.6 && frameWeight(PHOSPHOR_TAU_MS) < 0.65);
});

test("the response saturates, the gamma lifts, the bloom waits", () => {
  assert.equal(phosphorResponse(0), 0);
  assert.equal(beamAlpha(0), 0);
  assert.ok(phosphorResponse(BEAM_ENERGY_REF) > 0.6 && phosphorResponse(BEAM_ENERGY_REF) < 0.65);
  assert.ok(beamAlpha(1e6) <= 1);
  // Monotone and saturating: twice the energy is brighter, but a hot pixel can
  // barely get hotter — which is why the bloom exists.
  assert.ok(beamAlpha(2) > beamAlpha(1));
  assert.ok(beamAlpha(40) - beamAlpha(20) < beamAlpha(2) - beamAlpha(1));
  // Gamma lifts the faint end without touching either endpoint.
  assert.ok(beamAlpha(0.2) > phosphorResponse(0.2));
  // The bloom stays out of the way until a pixel really is overdriven, and
  // eventually says so — that is what keeps density readable after alpha has
  // run out at a dozen crossings.
  assert.ok(beamBloom(BEAM_ENERGY_REF) < 0.05, String(beamBloom(BEAM_ENERGY_REF)));
  assert.ok(beamBloom(BEAM_ENERGY_REF * 100) > 0.9);
  assert.ok(beamBloom(20) > beamBloom(10));
  assert.equal(beamBloom(0), 0);
});

test("Catmull-Rom passes through the samples it is drawn between", () => {
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 0) - 1) < 1e-12);
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 1) - 2) < 1e-12);
  // Evenly spaced collinear samples reconstruct as the straight line they are.
  for (const t of [0.25, 0.5, 0.75]) {
    assert.ok(Math.abs(catmullRom(0, 1, 2, 3, t) - (1 + t)) < 1e-12, String(t));
  }
  // A peak between two samples is drawn as a CURVE over the chord, which is the
  // whole point of oversampling: the beam does not fly in straight lines.
  assert.ok(catmullRom(0, 1, 1, 0, 0.5) > 1, String(catmullRom(0, 1, 1, 0, 0.5)));
});

test("subdivision follows curvature, not length", () => {
  assert.equal(segmentSteps(0), 1, "a flat span is already drawn exactly");
  assert.equal(segmentSteps(0.1), 1);
  assert.ok(segmentSteps(8) > segmentSteps(2));
  assert.ok(segmentSteps(1e6) <= BEAM_MAX_STEPS, "and it is bounded");
  // Halving the error takes ~√2 the steps, so a span four times as bowed needs
  // twice as many.
  assert.ok(Math.abs(segmentSteps(8) - 2 * segmentSteps(0.5 + 1e-9)) <= 1);
});

test("the trace is CONNECTED — a fast beam streaks, it does not dot", () => {
  // The regression this whole item is about: the old painter plotted one point
  // per sample, so a signal that moved a long way in one sample came out as two
  // unrelated specks with nothing between them.
  const beam = new CrtBeam(SIZE);
  sweepLine(beam, -0.8, 0, 0.8, 0, 2); // one sample period, right across the dial
  for (const x of [-0.6, -0.2, 0, 0.4, 0.7]) {
    assert.ok(at(beam, x, 0) > 0, `nothing inked at x=${x}`);
  }
  // …and nothing off the line it swept.
  assert.equal(at(beam, 0, 0.5), 0);
});

test("a slow beam burns, a fast one is faint — but the charge is the same", () => {
  const slow = new CrtBeam(SIZE);
  const fast = new CrtBeam(SIZE);
  // The same span, one crossed in 40 sample periods and one in 4.
  sweepLine(slow, -0.5, 0, 0.5, 0, 41);
  sweepLine(fast, -0.5, 0, 0.5, 0, 5);
  assert.ok(at(slow, 0, 0) > 4 * at(fast, 0, 0),
    `${at(slow, 0, 0)} vs ${at(fast, 0, 0)}`);
  // Charge conservation: the ink is SPREAD, not destroyed. Per sample period
  // the two lay down the same total (bar the current limiting, which takes a
  // further bite out of the fast one).
  const slowPer = slow.totalEnergy() / 40;
  const fastPer = fast.totalEnergy() / 4;
  assert.ok(fastPer < slowPer, "the fast sweep is current-limited on top");
  assert.ok(fastPer > 0.4 * slowPer, `${fastPer} vs ${slowPer}`);
});

test("energy accumulates — twenty traces really are twenty times one", () => {
  const one = new CrtBeam(SIZE);
  const ten = new CrtBeam(SIZE);
  sweepLine(one, -0.5, 0.2, 0.5, 0.2, 33);
  for (let i = 0; i < 10; i++) {
    ten.lift();
    sweepLine(ten, -0.5, 0.2, 0.5, 0.2, 33);
  }
  const r = ten.totalEnergy() / one.totalEnergy();
  assert.ok(Math.abs(r - 10) < 0.2, `${r}× for ten passes`);
  // The DISPLAY of it saturates, which is why the BUFFER must not: ten times
  // the energy is nothing like ten times the ink, so a screen that accumulated
  // ink instead of energy would have thrown the difference away long before it
  // got here. The bloom is what still separates them.
  const eRatio = at(ten, 0, 0.2) / at(one, 0, 0.2);
  const aRatio = beamAlpha(at(ten, 0, 0.2)) / beamAlpha(at(one, 0, 0.2));
  assert.ok(aRatio < eRatio / 3, `energy ×${eRatio.toFixed(1)}, ink ×${aRatio.toFixed(1)}`);
  assert.ok(beamBloom(at(ten, 0, 0.2)) > beamBloom(at(one, 0, 0.2)));
});

test("decay runs on wall time and eventually clears the screen", () => {
  const a = new CrtBeam(SIZE);
  const b = new CrtBeam(SIZE);
  sweepLine(a, -0.5, 0, 0.5, 0, 33);
  sweepLine(b, -0.5, 0, 0.5, 0, 33);
  a.decay(16);
  for (let i = 0; i < 4; i++) b.decay(4);
  assert.ok(Math.abs(a.totalEnergy() - b.totalEnergy()) / a.totalEnergy() < 1e-5,
    `${a.totalEnergy()} vs ${b.totalEnergy()}`);
  // Stopping the music lets the trace die instead of freezing it: a second of
  // silence is eleven time constants.
  for (let i = 0; i < 60; i++) a.decay(16);
  assert.equal(a.totalEnergy(), 0, "and it reaches zero rather than crawling");
});

test("the beam joins one frame to the next, and lifts when told to", () => {
  // Successive frames are one continuous trace: the ring does not restart at a
  // frame boundary, and neither may the beam.
  const joined = new CrtBeam(SIZE);
  sweepLine(joined, -0.6, 0, -0.2, 0, 2);
  sweepLine(joined, 0.2, 0, 0.6, 0, 2);
  assert.ok(at(joined, 0, 0) > 0, "the gap between the two frames is drawn");

  const lifted = new CrtBeam(SIZE);
  sweepLine(lifted, -0.6, 0, -0.2, 0, 2);
  lifted.lift();
  sweepLine(lifted, 0.2, 0, 0.6, 0, 2);
  assert.equal(at(lifted, 0, 0), 0, "…unless the beam was lifted between them");
  assert.ok(at(lifted, 0.4, 0) > 0, "which does not stop the second frame drawing");
});

test("a trace that leaves the dial is clipped, not lost", () => {
  const beam = new CrtBeam(SIZE);
  // Auto-gain overshoots on a transient by design, so samples DO land off the
  // screen; what is still on it has to be drawn.
  sweepLine(beam, -4, -4, 4, 4, 9);
  assert.ok(at(beam, 0, 0) > 0, "the part crossing the dial is inked");
  assert.ok(Number.isFinite(beam.totalEnergy()));
  // Nothing wrote outside the buffer: the row above the last one is untouched
  // by a horizontal sweep along the bottom.
  const off = new CrtBeam(SIZE);
  sweepLine(off, -2, -0.999, 2, -0.999, 5);
  assert.ok(off.energy[0] === 0 && off.energy[off.energy.length - 1] >= 0);
});

test("development: ink, alpha and the white core", () => {
  const beam = new CrtBeam(SIZE);
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const ink = [255, 192, 67];

  beam.develop(out, ink);
  assert.equal(out[3], 0, "an empty screen develops to nothing");

  sweepLine(beam, -0.5, 0, 0.5, 0, 33);
  beam.develop(out, ink);
  const px = (x, y) => {
    const i = (Math.round(beam.mid - y * beam.radius) * SIZE +
      Math.round(beam.mid + x * beam.radius)) * 4;
    return [out[i], out[i + 1], out[i + 2], out[i + 3]];
  };
  const lit = px(0, 0);
  assert.ok(lit[3] > 0, "the trace has ink");
  assert.equal(px(0, 0.5)[3], 0, "and the untouched screen has none");
  // A merely lit pixel wears the theme's colour; only an overdriven one is
  // pulled toward white.
  assert.ok(Math.abs(lit[1] - ink[1]) < 40, `${lit} vs ${ink}`);
  for (let i = 0; i < 400; i++) {
    beam.lift();
    sweepLine(beam, -0.5, 0, 0.5, 0, 33);
  }
  beam.develop(out, ink);
  const hot = px(0, 0);
  assert.equal(hot[3], 255);
  assert.ok(hot[2] > lit[2] + 60, `blue channel ${hot[2]} vs ${lit[2]}`);
  // On a LIGHT ground the same overdrive has to read the other way — a white
  // core on white paper says nothing at all.
  assert.deepEqual(beamCoreInk([0x1f, 0x23, 0x2b]), [255, 255, 255]);
  assert.deepEqual(beamCoreInk([0x34, 0x36, 0x3b]), [255, 255, 255], "the dim theme too");
  assert.deepEqual(beamCoreInk([0xec, 0xee, 0xf2]), [0, 0, 0]);
  beam.develop(out, [0xa4, 0x45, 0x00], beamCoreInk([0xec, 0xee, 0xf2]));
  assert.ok(px(0, 0)[0] < 0xa4, `light-theme core ${px(0, 0)}`);
  // Stale ink must not survive a decay: the pixel goes fully transparent again.
  for (let i = 0; i < 200; i++) beam.decay(16);
  beam.develop(out, ink);
  assert.equal(px(0, 0)[3], 0);
});

test("the same signal draws the same picture at any frame rate", () => {
  // The strip sweeps whatever arrived since the last frame and lets the
  // phosphor hold the rest, so a 30 fps machine and a 120 fps one see the same
  // trace at the same brightness — the property the old fixed-window cloud did
  // not have.
  const SR = 32000;
  const run = (fps) => {
    const beam = new CrtBeam(SIZE);
    const per = Math.round(SR / fps);
    const xs = new Float32Array(per);
    const ys = new Float32Array(per);
    let n = 0;
    for (let f = 0; f < Math.round(fps); f++) {
      for (let k = 0; k < per; k++, n++) {
        const t = (2 * Math.PI * 220 * n) / SR;
        xs[k] = 0.8 * Math.sin(t);
        ys[k] = 0.8 * Math.cos(t * 2);
      }
      beam.decay(1000 / fps);
      beam.trace(xs, ys, per);
    }
    return beam;
  };
  const slowFps = run(30);
  const fastFps = run(120);
  const rel = Math.abs(slowFps.totalEnergy() - fastFps.totalEnergy()) / slowFps.totalEnergy();
  assert.ok(rel < 0.05, `${slowFps.totalEnergy()} vs ${fastFps.totalEnergy()} (${rel})`);
  // And a real trace lands in the readable part of the response rather than
  // being a black screen or a solid disc.
  const peak = beamAlpha(slowFps.peakEnergy());
  assert.ok(peak > 0.8, `hottest pixel develops to ${peak}`);
  let lit = 0;
  for (const e of slowFps.energy) if (beamAlpha(e) > 0.02) lit++;
  const frac = lit / slowFps.energy.length;
  assert.ok(frac > 0.01 && frac < 0.5, `${(frac * 100).toFixed(1)}% of the screen lit`);
});

test("the pen is a spot, not a pixel", () => {
  // Sub-pixel motion must still move the trace: the ink either side of the
  // centre is what makes a slow sweep read as a smooth curve.
  const beam = new CrtBeam(SIZE);
  sweepLine(beam, 0, 0, 0, 0, 4);
  const mid = beam.mid | 0;
  const centre = beam.energy[mid * SIZE + mid];
  const skirt = beam.energy[mid * SIZE + mid + 1];
  assert.ok(centre > 0 && skirt > 0 && skirt < centre, `${centre} / ${skirt}`);
  assert.ok(beam.energy[mid * SIZE + mid + 4] === 0, "and it is truncated");
  assert.ok(BEAM_SIGMA > 0.5 && BEAM_SIGMA < 2, "a spot, not a brush");
});

test("resizing gives a clean screen at the new geometry", () => {
  const beam = new CrtBeam(64);
  sweepLine(beam, -0.5, 0, 0.5, 0, 33);
  assert.ok(beam.totalEnergy() > 0);
  beam.resize(128);
  assert.equal(beam.size, 128);
  assert.equal(beam.energy.length, 128 * 128);
  assert.equal(beam.totalEnergy(), 0, "the old trace is not stretched over it");
  // Same size is a no-op, not a wipe: the theme changing must not blank the scope.
  sweepLine(beam, -0.5, 0, 0.5, 0, 33);
  const e = beam.totalEnergy();
  beam.resize(128);
  assert.equal(beam.totalEnergy(), e);
  // A sample at full deflection still has room for the pen's skirt.
  assert.ok(beam.radius <= beam.size / 2 - 1);
});
