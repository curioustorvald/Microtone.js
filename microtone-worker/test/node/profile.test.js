// Dev audio profiler: the pure verdict classifier (src/ui/profileoverlay.js).
// The overlay DOM is exercised in the browser smoke; here we pin the logic that
// decides whether a WASM engine rewrite could help (DSP-bound) or not
// (overhead-bound / headroom OK).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  profileVerdict, PF_LOAD_WARN, PF_LOAD_SATURATED, PF_DSP_SHARE,
} from "../../src/ui/profileoverlay.js";

// A comfortable desktop: low load, no xruns, plenty of budget.
test("headroom OK when load is low and nothing glitches", () => {
  const v = profileVerdict({
    cpuFrac: 0.3, renderFrac: 0.25, procMaxMs: 1.2, quantumMs: 2.67, xruns: 0,
  });
  assert.equal(v.tone, "ok");
  assert.equal(v.label, "Headroom OK");
});

// The real iPad case: only 35% average load but heavy xruns → bursty, not
// saturated. Must recommend spreading the render before a WASM rewrite, even
// though the engine is ~all the busy time (dspShare high).
test("bursty overrun when glitching with spare average headroom", () => {
  const v = profileVerdict({
    cpuFrac: 0.35, renderFrac: 0.34, procMeanMs: 0.92, procMaxMs: 14.0,
    quantumMs: 2.67, xruns: 63,
  });
  assert.equal(v.tone, "bad");
  assert.equal(v.label, "Bursty overrun");
  assert.ok(0.35 < PF_LOAD_SATURATED);
  assert.match(v.detail, /spread/i);
});

// Saturated (high load) AND the engine dominates → genuine DSP throughput wall.
test("DSP-bound when saturated and renderChunk dominates", () => {
  const v = profileVerdict({
    cpuFrac: 0.95, renderFrac: 0.85, procMaxMs: 3.1, quantumMs: 2.67, xruns: 7,
  });
  assert.equal(v.tone, "bad");
  assert.equal(v.label, "DSP-bound");
  assert.ok(0.95 >= PF_LOAD_SATURATED);
  assert.ok(0.85 / 0.95 >= PF_DSP_SHARE);
});

// Saturated but the engine is a minority of the callback — WASM won't fix it.
test("overhead-bound when saturated but render is a small share", () => {
  const v = profileVerdict({
    cpuFrac: 0.95, renderFrac: 0.3, procMaxMs: 3.0, quantumMs: 2.67, xruns: 4,
  });
  assert.equal(v.label, "Overhead-bound");
  assert.ok(0.3 / 0.95 < PF_DSP_SHARE);
});

// procMax over the quantum budget counts as over-budget even with zero counted
// xruns in the window (belt-and-braces on the glitch predictor).
test("procMax over budget alone trips the over-budget branch", () => {
  const v = profileVerdict({
    cpuFrac: 0.4, renderFrac: 0.38, procMaxMs: 3.5, quantumMs: 2.67, xruns: 0,
  });
  assert.notEqual(v.tone, "ok"); // went over budget on a spike
  assert.equal(v.label, "Bursty overrun"); // low mean load → bursty
});

// High sustained load (above PF_LOAD_WARN) with no dropouts → "Near budget".
test("sustained high load without xruns is Near budget, not OK", () => {
  const v = profileVerdict({
    cpuFrac: PF_LOAD_WARN + 0.05, renderFrac: 0.2, procMaxMs: 2.0, quantumMs: 2.67, xruns: 0,
  });
  assert.equal(v.tone, "warn");
  assert.equal(v.label, "Near budget");
});

// Degenerate/empty report must not throw or divide by zero.
test("empty report is safe", () => {
  const v = profileVerdict({});
  assert.ok(v.tone);
  assert.ok(v.label);
  assert.ok(v.detail);
});
