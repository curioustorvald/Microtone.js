// Soundfield cloud (item 133) — the estimator, not the paint.
//
// The radial axis is a PERCEPTUAL claim: a pair at ±θ images at cos θ, so a
// single source is on the rim and a pair equidistant either side of you is at
// the centre, which is where such a pair is actually heard. That is testable,
// because |Ia| / P comes out as cos θ exactly — nothing here is fitted.
//
// And a pair in ANTI-phase has no phantom centre at all: you hear two separate
// sources. The pressure cancels while the air still moves, and the display has
// to say so rather than dropping it in the middle beside the in-phase case.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOPE_FRAMES, SCOPE_CHANNELS, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
} from "../../src/engine/analysis.js";
import { anglesFromDirection } from "../../src/engine/spatial.js";
import { RAD_BANDS, RAD_NBANDS } from "../../src/ui/radiation.js";
import {
  CloudField, CloudView, CLOUD_FILL, CLOUD_HOP, CLOUD_SIG_MIN, CLOUD_SIG_MAX,
  CLOUD_SUSTAIN_DEFAULT,
  cloudRadius, cloudPairRadius, cloudHalfAngle, cloudSigma, cloudDecay, cloudAlpha,
} from "../../src/ui/cloud.js";

const RATE = 48000;
const deg = (rad) => (rad * 180) / Math.PI;
const bearing = (d, e = 0) => {
  const a = (d * Math.PI) / 180, el = (e * Math.PI) / 180, ce = Math.cos(el);
  return [ce * Math.cos(a), ce * Math.sin(a), Math.sin(el)];
};
const FRONT = bearing(0), LEFT = bearing(90), RIGHT = bearing(-90);

function ringOf(sources) {
  const ring = new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS);
  for (const { dir, hz, amp = 1, phase = 0 } of sources) {
    for (let i = 0; i < SCOPE_FRAMES; i++) {
      const v = amp * Math.sin((2 * Math.PI * hz * i) / RATE + phase);
      const o = i * SCOPE_CHANNELS;
      ring[o + SCOPE_W] += v;
      ring[o + SCOPE_Y] += v * dir[1];
      ring[o + SCOPE_Z] += v * dir[2];
      ring[o + SCOPE_X] += v * dir[0];
    }
  }
  return ring;
}

/** A stand-in for the AudioSystem's voice accessors. */
function voices(list) {
  const out = new Float64Array(2);
  return {
    channelCount: () => list.length,
    getVoiceActive: (i) => list[i].vol > 0,
    getVoiceEffectiveVolume: (i) => list[i].vol,
    getVoiceAzimuth: (i) => (anglesFromDirection(...list[i].dir, out), out[0]),
    getVoiceElevation: (i) => (anglesFromDirection(...list[i].dir, out), out[1]),
    getVoiceSustain: (i) => list[i].sustain,
  };
}

const S_STRIDE = 7, S_DX = 0, S_DY = 1, S_DZ = 2, S_R = 3, S_SIG = 4, S_A = 5;

/** The splats, heaviest first, as plain objects. */
function splatsOf(f) {
  const out = [];
  for (let i = 0; i < f.count; i++) {
    const o = i * S_STRIDE;
    out.push({
      d: [f.splats[o + S_DX], f.splats[o + S_DY], f.splats[o + S_DZ]],
      r: f.splats[o + S_R], sig: f.splats[o + S_SIG], alpha: f.splats[o + S_A],
    });
  }
  return out;
}

// ── the radial axis ───────────────────────────────────────────────────────

test("the radius is cos of the half-angle, and reads back", () => {
  // The spec: a pair at ±θ images at cos θ. ±60° is 0.5 because cos 60° is.
  assert.equal(cloudPairRadius(0), 1);
  assert.ok(Math.abs(cloudPairRadius(Math.PI / 3) - 0.5) < 1e-12, "±60° is half way");
  assert.ok(Math.abs(cloudPairRadius(Math.PI / 2)) < 1e-12, "±90° is the centre");
  for (let d = 0; d <= 90; d += 5) {
    const half = (d * Math.PI) / 180;
    assert.ok(Math.abs(cloudHalfAngle(cloudPairRadius(half)) - half) < 1e-9, `${d}°`);
  }
  // …and the analyser's own radius is |Ia| / P, which is that same cosine.
  assert.equal(cloudRadius(0, 0), 0);
  assert.equal(cloudRadius(5, 1), 1, "more velocity than pressure clamps at the rim");
  assert.ok(Math.abs(cloudRadius(0.5, 1) - 0.5) < 1e-12);
});

test("an in-phase pair images at cos θ, measured end to end", () => {
  for (const t of [0, 15, 30, 45, 60, 75, 90]) {
    const f = new CloudField();
    const src = t === 0
      ? [{ dir: bearing(0), hz: 700, amp: 2 }]
      : [{ dir: bearing(t), hz: 700 }, { dir: bearing(-t), hz: 700 }];
    f.analyse(ringOf(src), 0, RATE, 0, null);
    const s = splatsOf(f);
    assert.ok(s.length > 0, `±${t}° produced nothing`);
    const want = cloudPairRadius((t * Math.PI) / 180);
    for (const sp of s) {
      assert.ok(Math.abs(sp.r - want) < 0.02, `±${t}°: r ${sp.r.toFixed(3)} want ${want.toFixed(3)}`);
    }
  }
});

test("splat size is the level in decibels", () => {
  assert.ok(Math.abs(cloudSigma(0) - CLOUD_SIG_MAX) < 1e-12, "the loudest tile is the biggest");
  assert.ok(cloudSigma(-6) < cloudSigma(0));
  assert.ok(cloudSigma(-24) < cloudSigma(-6));
  assert.equal(cloudSigma(-999), CLOUD_SIG_MIN, "and it floors rather than vanishing");
  // Equal decibel steps are equal size steps — that is the point of using dB.
  const a = cloudSigma(-10) - cloudSigma(-20);
  const b = cloudSigma(-20) - cloudSigma(-30);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
});

test("the accumulator's curves", () => {
  assert.equal(cloudDecay(0), 1);
  assert.ok(cloudDecay(230) < 0.4 && cloudDecay(230) > 0.3, "one tau is ~1/e");
  // Frame-rate independence: one long step equals many short ones.
  let k = 1;
  for (let i = 0; i < 10; i++) k *= cloudDecay(10);
  assert.ok(Math.abs(k - cloudDecay(100)) < 1e-9);
  assert.equal(cloudAlpha(0), 0);
  assert.ok(cloudAlpha(1) > cloudAlpha(0.1), "denser is more opaque");
  assert.ok(cloudAlpha(1e6) <= 1);
});

// ── the analysis ──────────────────────────────────────────────────────────

test("a single source lands at the rim, in its own direction", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ dir: bearing(35, 20), hz: 700 }]), 0, RATE, 0, null);
  const s = splatsOf(f);
  assert.ok(s.length > 0, "something was found");
  const want = bearing(35, 20);
  for (const sp of s) {
    assert.ok(sp.r > CLOUD_FILL * 0.9, `radius ${sp.r} should be at the rim`);
    const dot = sp.d[0] * want[0] + sp.d[1] * want[1] + sp.d[2] * want[2];
    assert.ok(dot > 0.999, `direction off by ${deg(Math.acos(dot)).toFixed(2)}°`);
  }
});

test("an in-phase pair either side of you is in-head; an ANTI-phase one is not", () => {
  // In phase: the classic phantom centre, heard inside the head.
  const inp = new CloudField();
  inp.analyse(ringOf([{ dir: LEFT, hz: 700 }, { dir: RIGHT, hz: 700 }]), 0, RATE, 0, null);
  for (const sp of splatsOf(inp)) assert.ok(sp.r < 0.05, `radius ${sp.r} should be in-head`);

  // Invert one and there is no phantom centre at all — you hear two separate
  // sources. The pressure cancels, so the excess velocity becomes a PAIR of
  // splats on the rim rather than anything in the middle.
  for (const t of [30, 60, 90]) {
    const f = new CloudField();
    f.analyse(ringOf([
      { dir: bearing(t), hz: 700 },
      { dir: bearing(-t), hz: 700, phase: Math.PI },
    ]), 0, RATE, 0, null);
    const s = splatsOf(f);
    assert.ok(s.length > 0, `±${t}° anti-phase produced nothing`);
    for (const sp of s) assert.ok(sp.r > 0.95, `±${t}°: radius ${sp.r} should be at the rim`);
    // Two ends of one axis, in opposite directions, in equal number.
    const plus = s.filter((x) => x.d[1] > 0.5).length;
    const minus = s.filter((x) => x.d[1] < -0.5).length;
    assert.ok(plus > 0 && minus > 0, `±${t}°: expected both ends, got ${plus}/${minus}`);
    assert.equal(plus, minus, `±${t}°: the pair should be balanced`);
  }
});

test("uncorrelated sources separate — the reading the surface cannot give", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ dir: LEFT, hz: 700 }, { dir: RIGHT, hz: 1600 }]), 0, RATE, 0, null);
  const s = splatsOf(f);
  const left = s.filter((x) => x.d[1] > 0.9 && x.r > CLOUD_FILL * 0.9);
  const right = s.filter((x) => x.d[1] < -0.9 && x.r > CLOUD_FILL * 0.9);
  assert.ok(left.length > 0, "the left source is at the rim on the left");
  assert.ok(right.length > 0, "the right source is at the rim on the right");
});

test("silence produces no splats at all", () => {
  const f = new CloudField();
  f.analyse(new Float32Array(SCOPE_FRAMES * SCOPE_CHANNELS), 0, RATE, 0, null);
  assert.equal(f.count, 0);
});

test("the analysis is paced by the audio, not the frame rate", () => {
  const f = new CloudField();
  const ring = ringOf([{ dir: FRONT, hz: 700 }]);
  assert.equal(f.analyse(ring, 0, RATE, 0, null), true, "the first window always runs");
  assert.equal(f.analyse(ring, 0, RATE, 8, null), false, "8 frames is not a hop");
  assert.equal(f.analyse(ring, 0, RATE, CLOUD_HOP, null), true, "a hop's worth is");
  f.reset();
  assert.equal(f.count, 0);
  assert.equal(f.ready, false);
});

// ── held-ness: the part that cannot come from the audio ───────────────────

test("alpha is held-ness, and a quiet HELD note keeps it", () => {
  const f = new CloudField();
  // Same volume both sides; only the key state differs.
  f.readVoices(voices([
    { dir: LEFT, vol: 0.05, sustain: 1 },      // very quiet, key still down
    { dir: RIGHT, vol: 0.9, sustain: 0.04 },   // loud, but ringing out
  ]));
  assert.equal(f.vCount, 2);
  assert.ok(f.sustainAt(...LEFT) > 0.95, "quiet but held reads as held");
  assert.ok(f.sustainAt(...RIGHT) < 0.1, "loud but releasing reads as releasing");
  // A bearing with no voice anywhere near it has nothing to say.
  assert.equal(f.sustainAt(...FRONT), CLOUD_SUSTAIN_DEFAULT);
});

test("…and it reaches the splats", () => {
  const f = new CloudField();
  const audio = voices([
    { dir: LEFT, vol: 0.8, sustain: 1 },
    { dir: RIGHT, vol: 0.8, sustain: 0.02 },
  ]);
  f.analyse(ringOf([{ dir: LEFT, hz: 700 }, { dir: RIGHT, hz: 1600 }]), 0, RATE, 0, audio);
  const s = splatsOf(f);
  const left = s.filter((x) => x.d[1] > 0.9);
  const right = s.filter((x) => x.d[1] < -0.9);
  assert.ok(left.length && right.length, "both sides produced splats");
  for (const sp of left) assert.ok(sp.alpha > 0.9, `held splat alpha ${sp.alpha}`);
  for (const sp of right) assert.ok(sp.alpha < 0.1, `releasing splat alpha ${sp.alpha}`);
});

// ── the accumulator ───────────────────────────────────────────────────────

test("the cloud accumulates and then dies away", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ dir: bearing(30, 10), hz: 700 }]), 0, RATE, 0, null);
  const view = new CloudView(64);
  const bandLin = RAD_BANDS.map(() => [1, 1, 1]);
  const basis = { h: [0, -1, 0], v: [1, 0, 0], d: [0, 0, 1] };
  assert.equal(view.totalEnergy(), 0);
  view.splat(f, basis, bandLin, 1);
  const one = view.totalEnergy();
  assert.ok(one > 0, "one window lays something down");
  view.splat(f, basis, bandLin, 1);
  assert.ok(view.totalEnergy() > one * 1.9, "…and a second adds to it rather than replacing it");
  // Stop feeding it and it fades, frame-rate independently.
  const lit = view.totalEnergy();
  for (let i = 0; i < 40; i++) view.decay(25); // ~1 s
  assert.ok(view.totalEnergy() < lit * 0.02, `fell from ${lit} to ${view.totalEnergy()}`);
  view.clear();
  assert.equal(view.totalEnergy(), 0);
});

test("develop paints where the cloud is and nowhere else", () => {
  const f = new CloudField();
  f.analyse(ringOf([{ dir: bearing(90), hz: 700 }]), 0, RATE, 0, null); // hard left
  const size = 64;
  const view = new CloudView(size);
  view.splat(f, { h: [0, -1, 0], v: [1, 0, 0], d: [0, 0, 1] },
    RAD_BANDS.map(() => [1, 1, 1]), 1);
  const px = new Uint8ClampedArray(size * size * 4);
  view.develop(px, [255, 255, 255]);
  let sx = 0, n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (px[(y * size + x) * 4 + 3] === 0) continue;
      sx += (x + 0.5) / size * 2 - 1;
      n++;
    }
  }
  assert.ok(n > 0, "something was painted");
  assert.ok(sx / n < -0.5, `a hard-left source paints on the left (centroid ${(sx / n).toFixed(2)})`);
});

test("every band is drawable", () => {
  assert.equal(RAD_BANDS.length, RAD_NBANDS);
  const f = new CloudField();
  const src = RAD_BANDS.map((b, i) => ({
    dir: bearing(i * 60), hz: Math.sqrt(b.lo * b.hi), amp: 1,
  }));
  f.analyse(ringOf(src), 0, RATE, 0, null);
  const bands = new Set();
  for (let i = 0; i < f.count; i++) bands.add(f.splats[i * S_STRIDE + 6]);
  assert.equal(bands.size, RAD_NBANDS, `only bands ${[...bands]} appeared`);
});
