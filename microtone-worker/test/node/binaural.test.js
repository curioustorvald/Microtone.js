// Binaural monitoring (#998.3). The head model is parametric, so the tests
// assert the PROPERTIES that make it a usable monitor rather than transcribed
// numbers: the interaural delay has the right sign and magnitude, the near ear
// is louder, left/right is symmetric, elevation and front/back each move the
// spectrum monotonically in one direction, and the whole thing stays at the
// level the stereo fold would have produced.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BinauralRenderer, binauralSpeakerLayout, binauralEarDelay,
  MONITOR_FOLD, MONITOR_BINAURAL,
} from "../../src/engine/binaural.js";
import { StereoRenderer, SURROUND_PLANAR, SURROUND_SPATIAL } from "../../src/engine/spatial.js";
import { SAMPLING_RATE } from "../../src/engine/constants.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { loadIntoEngine, renderSong } from "../../src/audio/offline-render.js";

/** Push `sig` through the renderer from direction (az, el); returns [L, R]. */
function renderDirection(r, az, el, sig) {
  const frames = sig.length;
  const gains = new Float64Array(r.numChannels);
  r.channelGains(az, el, gains, 0);
  const bus = new Float64Array(r.numChannels * frames);
  for (let c = 0; c < r.numChannels; c++) {
    for (let n = 0; n < frames; n++) bus[c * frames + n] = sig[n] * gains[c];
  }
  const l = new Float64Array(frames);
  const rr = new Float64Array(frames);
  const pair = new Float64Array(2);
  r.reset();
  for (let n = 0; n < frames; n++) {
    r.monitorStereo(bus, frames, n, pair);
    l[n] = pair[0];
    rr[n] = pair[1];
  }
  return [l, rr];
}

/** Deterministic broadband noise (no rng.js dependency — this is a test fixture). */
function noise(n, seed = 12345) {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 4294967296) * 2 - 1;
  }
  return out;
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** One-pole low-pass — the ITD lives below the model's crossover, so the delay
 *  test has to look there (broadband, the undelayed high band dominates). */
function lowpass(a, fc) {
  const k = 1 - Math.exp((-2 * Math.PI * fc) / SAMPLING_RATE);
  const out = new Float64Array(a.length);
  let y = 0;
  for (let i = 0; i < a.length; i++) { y += k * (a[i] - y); out[i] = y; }
  return out;
}

/** Energy above ~4 kHz, via a one-pole high-pass complement. */
function hfEnergy(a) {
  const k = 1 - Math.exp((-2 * Math.PI * 4000) / SAMPLING_RATE);
  let lp = 0;
  let e = 0;
  for (let i = 0; i < a.length; i++) {
    lp += k * (a[i] - lp);
    const hi = a[i] - lp;
    e += hi * hi;
  }
  return Math.sqrt(e / a.length);
}

/** Group delay of the low band, by cross-correlating against the dry signal. */
function leadSamples(dry, wet, maxLag = 40) {
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < dry.length; i++) s += dry[i] * wet[i + lag];
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  return best;
}

test("the layouts cover the circle and, for spatial songs, the sphere", () => {
  const planar = binauralSpeakerLayout(false);
  assert.equal(planar.length, 12);
  assert.ok(planar.every(([, el]) => el === 0), "a planar ring stays at ear level");
  // Front, back, left and right must be speakers, not phantoms between them.
  for (const az of [0, 128, 256, 384]) {
    assert.ok(planar.some(([a]) => a === az), `no speaker at azimuth ${az}`);
  }
  const sphere = binauralSpeakerLayout(true);
  assert.equal(sphere.length, 26);
  assert.ok(sphere.some(([, el]) => el === 128), "no zenith");
  assert.ok(sphere.some(([, el]) => el === -128), "no nadir");
});

test("Woodworth delay: the near ear leads, and the spread is a real head's", () => {
  const near = binauralEarDelay(1, 1);   // source hard left, left ear
  const far = binauralEarDelay(1, -1);   // …and the right ear
  assert.ok(far > near, "the far ear must arrive later");
  const itd = far - near;
  // (a/c)(1 + π/2) ≈ 0.66 ms is the textbook maximum.
  assert.ok(itd > 0.0006 && itd < 0.0007, `ITD ${(itd * 1000).toFixed(3)} ms out of range`);
  assert.equal(binauralEarDelay(0, 1), binauralEarDelay(0, -1), "front is symmetric");
});

test("a source on one side reaches that ear first and louder", () => {
  const r = new BinauralRenderer(true);
  const sig = lowpass(noise(2048), 700);
  const [l, rr] = renderDirection(r, 0, 0, sig); // azimuth 0 = hard left
  assert.ok(rms(l) > rms(rr) * 1.2, "hard left must be louder in the left ear");
  const lagL = leadSamples(sig, l);
  const lagR = leadSamples(sig, rr);
  assert.ok(lagR > lagL, `left ear must lead (lagL=${lagL}, lagR=${lagR})`);
  // ~0.65 ms at 32 kHz ≈ 21 frames; allow the crossover's own group delay.
  assert.ok(lagR - lagL >= 12, `ITD too small: ${lagR - lagL} frames`);
});

test("left and right are mirror images of each other", () => {
  const r = new BinauralRenderer(true);
  const sig = noise(2048);
  const [l1, r1] = renderDirection(r, 64, 40, sig);        // 45° front-left, up
  const [l2, r2] = renderDirection(r, 192, 40, sig);       // mirrored to the right
  assert.ok(Math.abs(rms(l1) - rms(r2)) < 1e-9, "L(θ) must equal R(−θ)");
  assert.ok(Math.abs(rms(r1) - rms(l2)) < 1e-9, "R(θ) must equal L(−θ)");
});

test("elevation and front/back each move the spectrum, monotonically", () => {
  const r = new BinauralRenderer(true);
  const sig = noise(4096);
  // Spectral TILT, not absolute high-frequency level: the per-speaker
  // calibration deliberately equalises loudness across directions, so the cue
  // that survives — and the one the ear actually uses — is the balance.
  const hfAt = (az, el) => {
    const [l, rr] = renderDirection(r, az, el, sig);
    return (hfEnergy(l) + hfEnergy(rr)) / (rms(l) + rms(rr));
  };
  // Height: the pinna notch climbs out of the band and the shelf opens up.
  const below = hfAt(128, -100);
  const level = hfAt(128, 0);
  const above = hfAt(128, 100);
  assert.ok(below < level && level < above,
    `elevation cue not monotone: ${below} ${level} ${above}`);
  // Front/back at ear level: the fold cannot tell these apart at all.
  const front = hfAt(128, 0);
  const back = hfAt(384, 0);
  assert.ok((front - back) / front > 0.05,
    `front must read brighter than back (${front} vs ${back})`);

  const fold = new StereoRenderer();
  const g = new Float64Array(2);
  fold.channelGains(128, 0, g, 0);
  const gb = new Float64Array(2);
  fold.channelGains(384, 0, gb, 0);
  assert.deepEqual([...g], [...gb], "the fold really does collapse front onto back");
});

test("the monitor level tracks the stereo pan law it replaces", () => {
  const r = new BinauralRenderer(true);
  const sig = noise(4096);
  const dry = rms(sig);
  for (const [az, el] of [[128, 0], [0, 0], [256, 0], [384, 0], [64, 60], [128, 128], [128, -128]]) {
    const [l, rr] = renderDirection(r, az, el, sig);
    const power = Math.sqrt((rms(l) ** 2 + rms(rr) ** 2)) / dry;
    // The fold delivers exactly 1.0 (cos² + sin² = 1) and the per-speaker
    // calibration aims the head at the same figure; what is left is the
    // coherent summation of a phantom's two or three speakers, which no
    // amplitude panner escapes. ±1.5 dB.
    assert.ok(power > 0.84 && power < 1.19,
      `level ${power.toFixed(3)} at az=${az} el=${el} is outside ±1.5 dB`);
  }
});

test("a planar song's monitor never gets an elevated source, but survives one", () => {
  const r = new BinauralRenderer(false);
  const gains = new Float64Array(r.numChannels);
  r.channelGains(128, 128, gains, 0); // straight up, which no ring speaker sees
  const level = gains.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(level - 1) < 1e-9, "an unseeable direction must spread, not vanish");
});

test("panning is level-preserving and continuous around the circle", () => {
  for (const sphere of [false, true]) {
    const r = new BinauralRenderer(sphere);
    const gains = new Float64Array(r.numChannels);
    let prev = null;
    for (let az = 0; az < 512; az += 4) {
      r.channelGains(az, 0, gains, 0);
      const level = gains.reduce((s, v) => s + v, 0);
      assert.ok(Math.abs(level - 1) < 1e-9, `level ${level} at az=${az}`);
      if (prev !== null) {
        let d = 0;
        for (let i = 0; i < gains.length; i++) d += (gains[i] - prev[i]) ** 2;
        assert.ok(Math.sqrt(d) < 0.5, `pan jumps at az=${az}`);
      }
      prev = Float64Array.from(gains);
    }
  }
});

test("the engine installs and removes the head on demand", () => {
  const eng = new TaudEngine();
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  assert.equal(eng.getMonitorMode(0), MONITOR_FOLD);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "stereo");

  eng.setMonitorMode(0, MONITOR_BINAURAL);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-3d");
  // The model switch has to rebuild the head — a planar ring is a different one.
  eng.setSurroundModel(0, SURROUND_PLANAR);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-2d");

  // An exporter's renderer outranks the monitor, and giving it back restores it.
  eng.setSpatialRenderer(0, new StereoRenderer());
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "stereo");
  eng.setSpatialRenderer(0, null);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-2d");

  // A stereo song has no object bus at all, whatever the monitor says.
  eng.setSurroundModel(0, 0);
  assert.equal(eng.playheads[0].trackerState.spatial, null);
});

test("a whole song renders through the head: finite, audible, and not the fold", () => {
  // The head model runs inside the audio thread, where a NaN or an unstable
  // filter is an instant dead output. Render a real song both ways and compare.
  const doc = new Document(parseTaud(
    readFileSync(fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url))))).toRenderable(0);

  const render = (monitor) => {
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    eng.setSurroundModel(0, SURROUND_SPATIAL);
    if (monitor) eng.setMonitorMode(0, MONITOR_BINAURAL);
    return renderSong(eng, 3);
  };
  const head = render(true);
  const fold = render(false);

  assert.ok(head.frames > 0);
  let peak = 0;
  for (let i = 0; i < head.f32.length; i++) {
    assert.ok(Number.isFinite(head.f32[i]), `non-finite sample at ${i}`);
    const a = Math.abs(head.f32[i]);
    if (a > peak) peak = a;
  }
  assert.ok(peak > 0.01, `the head model produced near-silence (peak ${peak})`);
  assert.ok(peak <= 1.0, `the head model clipped (peak ${peak})`);
  assert.notDeepEqual(head.f32, fold.f32, "binaural must differ from the fold");

  // Loudness has to survive the trip, or nobody will leave it switched on.
  const rmsOf = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };
  const ratio = rmsOf(head.f32) / rmsOf(fold.f32);
  assert.ok(ratio > 0.7 && ratio < 1.45, `level moved by ${(20 * Math.log10(ratio)).toFixed(1)} dB`);
});

test("the monitor mode is a device setting, not a song property", () => {
  const eng = new TaudEngine();
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  eng.setMonitorMode(0, MONITOR_BINAURAL);
  eng.resetParams(0);
  assert.equal(eng.getMonitorMode(0), MONITOR_BINAURAL);
  assert.equal(eng.playheads[0].trackerState.spatial.renderer.name, "binaural-3d");
});
