// item 96: the AudioWorklet's RENDER-mode look-ahead ring (taud-processor.js
// renderIntoRing/renderAndPlay — the single-thread fallback for non-isolated
// hosts) kept no flush on a transport reset (play/seek/stop), unlike the
// Tier 2 render Worker's ring (render.worker.js flushRing/AR_EPOCH), which
// already had one. So a block rendered against the OLD tracker state could
// still be sitting between ringReadPos and ringWrite when a fresh play()
// arrived, and would play out BEFORE the new content — a "stale block leaks
// into the new playback" glitch, audible whenever a cue/row change or replay
// follows quickly on a still-playing (or barely-stopped) transport.
//
// TaudProcessor is only ever constructed inside a real AudioWorkletGlobalScope
// in production, but the class itself has no browser dependency beyond three
// globals (AudioWorkletProcessor, registerProcessor, sampleRate) — stubbing
// those lets this run the REAL production module deterministically in Node,
// with no wall-clock racing (real-time browser capture would need to catch an
// ~8-sample-quantum-wide window, which is exactly the kind of test that flakes).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CMD } from "../../src/worklet/protocol.js";

// Left in place for the rest of this file: TaudProcessor's constructor reads
// the global `sampleRate` (AudioWorkletGlobalScope semantics) each time it
// runs, not just at import — restoring it right after import would break
// every processor built later in this file.
globalThis.sampleRate = 32000; // match the engine's native rate: step = 1.0, no resampler
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
let TaudProcessor = null;
globalThis.registerProcessor = (name, cls) => { TaudProcessor = cls; };
await import("../../src/worklet/taud-processor.js");

const NUM_PATTERNS_EMPTY = [0xff, 0x7f]; // PATTERN_EMPTY sentinel, LE

/** A loud, indefinitely-sustaining looping tone in instrument slot 1 (same
 *  shape as engine-scenarios.test.js's makeTestEngine — byte 21 = 0x3F keeps
 *  the vol-env terminator non-zero, else the Schism cut rule ramps it out). */
function uploadLoudInstrument(eng) {
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 255; // max positive u8 → loudest constant tone
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);
}

function makeLoudPattern() {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50; // note C4
  pat[2] = 1;                   // inst 1
  return pat;
}

function makeCue(patSlot) {
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = NUM_PATTERNS_EMPTY[0]; cue[ch * 2 + 1] = NUM_PATTERNS_EMPTY[1]; }
  cue[0] = patSlot & 0xff; cue[1] = (patSlot >> 8) & 0xff;
  return cue;
}

function setup() {
  const p = new TaudProcessor({ processorOptions: {} });
  uploadLoudInstrument(p.engine);
  p.engine.uploadPattern(0, makeLoudPattern());     // pattern 0: the loud tone
  p.engine.uploadPattern(1, new Uint8Array(512));   // pattern 1: all-zero = silent (no note)
  p.engine.uploadCue(0, makeCue(0));                // cue 0 → loud pattern
  p.engine.uploadCue(1, makeCue(1));                // cue 1 → silent pattern
  p.engine.setBPM(0, 125);
  p.engine.setTickRate(0, 6);
  p.engine.setMasterVolume(0, 255);
  return p;
}

function maxAbs(buf) {
  let m = 0;
  for (const v of buf) { const a = Math.abs(v); if (a > m) m = a; }
  return m;
}

test("RENDER-mode ring: a transport reset flushes the look-ahead buffer (item 96 fix)", () => {
  const p = setup();
  p.onCommand({ t: CMD.SET_CUE_POSITION, ph: 0, pos: 0 });
  p.onCommand({ t: CMD.SET_TRACKER_ROW, ph: 0, row: 0 });
  p.onCommand({ t: CMD.PLAY, ph: 0 });

  const outL = new Float32Array(128), outR = new Float32Array(128);
  for (let i = 0; i < 5; i++) p.renderAndPlay(outL, outR, 128); // let the ring build real look-ahead
  assert.ok(maxAbs(outL) > 0.1, "sanity: the loud tone is actually audible before the switch");
  assert.ok(p.ringWrite > p.ringReadPos, "sanity: the ring has un-consumed look-ahead queued");

  // Switch straight to the silent cue WITHOUT stop() first — exactly app.js's
  // playFrom() sequence (setCuePosition, setTrackerRow, play), which is also
  // how a Timeline/Cues cue-change or a mid-play seek reaches the worklet.
  p.onCommand({ t: CMD.SET_CUE_POSITION, ph: 0, pos: 1 });
  p.onCommand({ t: CMD.SET_TRACKER_ROW, ph: 0, row: 0 });
  p.onCommand({ t: CMD.PLAY, ph: 0 });

  assert.equal(p.ringReadPos, p.ringWrite, "the stale look-ahead block was dropped, not just left queued");

  const outL2 = new Float32Array(128), outR2 = new Float32Array(128);
  p.renderAndPlay(outL2, outR2, 128);
  assert.ok(maxAbs(outL2) < 1e-6, "no stale loud block leaks into the new (silent) playback");
  assert.ok(maxAbs(outR2) < 1e-6);
});

test("control: without the flush, the stale block WOULD have leaked (proves the test is meaningful)", () => {
  const p = setup();
  p.onCommand({ t: CMD.SET_CUE_POSITION, ph: 0, pos: 0 });
  p.onCommand({ t: CMD.SET_TRACKER_ROW, ph: 0, row: 0 });
  p.onCommand({ t: CMD.PLAY, ph: 0 });

  const outL = new Float32Array(128), outR = new Float32Array(128);
  for (let i = 0; i < 5; i++) p.renderAndPlay(outL, outR, 128);
  assert.ok(p.ringWrite > p.ringReadPos, "sanity: look-ahead queued");

  // Reproduce the PRE-FIX sequence: mutate the engine directly (bypassing
  // onCommand, so flushRing never runs) — the same effect applyAudioCommand
  // alone had before this fix, since it only ever touched `eng`.
  p.engine.setCuePosition(0, 1);
  p.engine.setTrackerRow(0, 0);
  p.engine.play(0);

  assert.ok(p.ringReadPos < p.ringWrite, "the stale block is still sitting in the ring, unflushed");
  const outL2 = new Float32Array(128), outR2 = new Float32Array(128);
  p.renderAndPlay(outL2, outR2, 128);
  assert.ok(maxAbs(outL2) > 0.1, "the OLD loud block leaks through before the new (silent) content arrives");
});
