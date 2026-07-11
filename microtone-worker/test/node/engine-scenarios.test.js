// Targeted regression tests for the historically-subtle engine behaviours
// (see CLAUDE.md porting rules). The corpus conformance covers these end to
// end; these keep them pinned even if the corpus changes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK } from "../../src/engine/constants.js";
import { Voice } from "../../src/engine/voice.js";
import { envPoint } from "../../src/engine/inst.js";
import { ghostVoice } from "../../src/engine/trigger.js";
import { advancePfRole, seedPfRole, advanceEnvelope, pfIdxBox, pfTimeBox } from "../../src/engine/envelope.js";

const scratch = new Int32Array(2);

// Render ≈ `samples` frames of playhead 0, chunk-size-agnostic (renderChunk
// always emits exactly TRACKER_CHUNK, so these tests advance by sample count
// rather than counting chunks — output is bit-identical at any TRACKER_CHUNK).
function renderSamples(eng, samples) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const calls = Math.ceil(samples / TRACKER_CHUNK);
  for (let i = 0; i < calls; i++) eng.renderChunk(0, out);
}

function makeTestEngine() {
  const eng = new TaudEngine();
  // Simple looping instrument in slot 1: 1000-byte ramp sample @32 kHz.
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);       // sampleLength
  w16(6, 32000);      // samplingRate @C4
  w16(12, 1000);      // loopEnd
  rec[14] = 1;        // forward loop
  rec[21] = 0x3f;     // vol env node 0 = full — a zeroed env is a value-0
                      // terminator and the Schism cut rule ramps the voice out
                      // instantly (real converter records always fill this)
  rec[171] = 255;     // instGlobalVolume
  rec[196] = 255;     // defaultNoteVolume
  eng.uploadInstrument(1, rec);
  return eng;
}

test("S$Dx note delay fires on a FRESH channel (stale-inst re-bind)", () => {
  const eng = makeTestEngine();
  // Pattern 0 row 0: note C4, inst 1, S $D200 (note delay to tick 2).
  const pat = new Uint8Array(512);
  pat.fill(0);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; } // vol/pan no-op
  pat[0] = 0x00; pat[1] = 0x50;  // note 0x5000
  pat[2] = 1;                    // inst 1
  pat[5] = 0x1c;                 // OP_S
  pat[6] = 0x00; pat[7] = 0xd2;  // arg 0xD200 → S$D2
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;  // ch0 → pattern 0
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);

  const v = eng.playheads[0].trackerState.voices[0];

  renderSamples(eng, 512); // 512 samples < 640/tick — delay tick not reached
  assert.equal(v.active, false, "voice must not sound before the delay tick");

  renderSamples(eng, 3 * 512); // advance through tickInRow=2 → deferred trigger fires
  assert.equal(v.active, true, "delayed note must fire");
  assert.equal(v.instrumentId, 1);
  // The stale-inst bug zeroed playbackRate via instruments[0].samplingRate == 0.
  assert.ok(Math.abs(v.playbackRate - 1.0) < 1e-12, `playbackRate ${v.playbackRate} must be 1.0`);
  assert.ok(v.samplePos > 0, "sample must be advancing on the trigger tick");
});

test("advancePfRole SKIPS zero-duration nodes; seedPfRole settles past them", () => {
  // Node 0: instant (offset 0) value 0 → node 1: value 200 over ~0.25 s.
  const env = new Array(25);
  for (let i = 0; i < 25; i++) env[i] = envPoint(220, 0);
  env[0] = envPoint(0, 0);     // zero-duration attack node
  env[1] = envPoint(200, 64);  // minifloat idx 64 = 0.25 s
  env[2] = envPoint(220, 64);

  const seed = seedPfRole(env, 0x2000 /* P bit only */, 0);
  assert.equal(pfIdxBox[0], 1, "seed must settle past the zero-duration node");
  assert.ok(Math.abs(seed - 200 / 255) < 1e-12, "seed value is node 1's, not node 0's");

  // A fresh walk from index 0 must also skip, not freeze at node 0.
  pfIdxBox[0] = 0;
  pfTimeBox[0] = 0.0;
  const v = advancePfRole(env, 0x2000, 0, false, 0.012, scratch, pfIdxBox, pfTimeBox);
  assert.equal(pfIdxBox[0], 1);
  assert.ok(v > 200 / 255 - 1e-9, "walker moved onto the node-1 segment");
});

test("vol/pan walker FREEZES on zero-offset nodes (IT terminator semantics)", () => {
  const v = new Voice();
  v.activeVolEnv = new Array(25);
  for (let i = 0; i < 25; i++) v.activeVolEnv[i] = envPoint(63, 0);
  v.activeVolEnv[0] = envPoint(32, 0); // terminator at node 0
  v.activeVolEnvLoop = 0x2000;
  v.activeVolEnvSustain = 0;
  v.envIndex = 0;
  advanceEnvelope(v, 0.05);
  advanceEnvelope(v, 0.05);
  assert.equal(v.envIndex, 0, "vol env must hold at the terminator");
  assert.ok(Math.abs(v.envVolume - 32 / 63) < 1e-12);
});

test("ghostVoice copies SF2 biquad state and the active-envelope view", () => {
  const src = new Voice();
  src.active = true;
  src.filterIsBiquad = true;
  src.filterSfMode = true;
  src.filterBqB02 = 0.123;
  src.filterBqB1 = 0.456;
  src.filterBqA1 = -0.7;
  src.filterBqA2 = 0.2;
  src.filterX1 = 0.9;
  src.filterX2 = -0.4;
  src.filterY1 = 0.11;
  src.filterY2 = -0.22;
  src.activeFadeoutStep = 777;
  src.activeDefaultCutoff = 13500;
  src.activeAttenGain = 0.5;
  const customEnv = new Array(25);
  for (let i = 0; i < 25; i++) customEnv[i] = envPoint(i, 1);
  src.activeVolEnv = customEnv;
  src.activeVolEnvSustain = 0x1234;

  const g = ghostVoice(src, 3);
  assert.equal(g.sourceChannel, 3);
  assert.equal(g.filterIsBiquad, true);
  assert.equal(g.filterSfMode, true);
  assert.equal(g.filterBqB02, 0.123);
  assert.equal(g.filterBqB1, 0.456);
  assert.equal(g.filterBqA1, -0.7);
  assert.equal(g.filterBqA2, 0.2);
  assert.equal(g.filterX1, 0.9);
  assert.equal(g.filterX2, -0.4);
  assert.equal(g.filterY1, 0.11);
  assert.equal(g.filterY2, -0.22);
  assert.equal(g.activeFadeoutStep, 777);
  assert.equal(g.activeDefaultCutoff, 13500);
  assert.equal(g.activeAttenGain, 0.5);
  assert.strictEqual(g.activeVolEnv, customEnv, "env view is shared by reference");
  assert.equal(g.activeVolEnvSustain, 0x1234);
});

test("dither stream is deterministic across engine instances", () => {
  const render = () => {
    const eng = makeTestEngine();
    const pat = new Uint8Array(512);
    pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
    for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
    eng.uploadPattern(0, pat);
    const cue = new Uint8Array(64);
    for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
    cue[0] = 0;
    eng.uploadCue(0, cue);
    eng.setMasterVolume(0, 255);
    eng.play(0);
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    const all = new Uint8Array(TRACKER_CHUNK * 2 * 8);
    for (let i = 0; i < 8; i++) { eng.renderChunk(0, out); all.set(out, i * TRACKER_CHUNK * 2); }
    return all;
  };
  assert.deepEqual(render(), render());
});

test("renderPitch display tap: follows arpeggio per tick; noteVal stays at base", () => {
  const eng = makeTestEngine();
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50;   // note 0x5000
  pat[2] = 1;                     // inst 1
  pat[5] = 0x13;                  // OP_J arpeggio
  pat[6] = 0x04; pat[7] = 0x03;   // arg 0x0304 → arpOff1=3, arpOff2=4 semitones
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);

  const v = eng.playheads[0].trackerState.voices[0];
  const SPT = 640; // samples/tick at bpm 125 (32000*2.5/125)
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    renderSamples(eng, SPT); // advance ~one arp tick, chunk-size-agnostic
    seen.add(v.renderPitch);
    assert.equal(v.noteVal, 0x5000, "base noteVal never moves under arpeggio");
  }
  // The arp overlay shifts the SOUNDING pitch off the base on some ticks.
  assert.ok([...seen].some((p) => p !== 0x5000), "renderPitch deviates from base per tick");
  assert.ok(seen.size >= 2, "renderPitch varies across ticks");
});

test("setTrackerRow clears NNA ghosts + transient state (no lingering notes on replay)", () => {
  const eng = makeTestEngine();
  const ts = eng.playheads[0].trackerState;
  // Simulate a prior playback that left state behind: an active foreground
  // voice, a lingering NNA background ghost, a pattern-delay block, a pending
  // interrupt, a stale row jump.
  ts.voices[3].active = true;
  const ghost = new Voice();
  ghost.active = true;
  ts.backgroundVoices.push(ghost);
  ts.patternDelayActive = true;
  ts.patternDelayRemaining = 4;
  ts.sexWinningChannel = 7;
  ts.finePatternDelayExtra = 2;
  ts.pendingInterrupts = 0b101;
  ts.pendingRowJump = 12;
  ts.pendingRowJumpLocal = true;

  eng.setTrackerRow(0, 0);

  assert.equal(ts.voices[3].active, false, "foreground voice silenced");
  assert.equal(ts.backgroundVoices.length, 0, "NNA ghosts dropped");
  assert.equal(ts.patternDelayActive, false);
  assert.equal(ts.patternDelayRemaining, 0);
  assert.equal(ts.sexWinningChannel, -1);
  assert.equal(ts.finePatternDelayExtra, 0);
  assert.equal(ts.pendingInterrupts, 0);
  assert.equal(ts.pendingRowJump, -1);
  assert.equal(ts.pendingRowJumpLocal, false);
});
