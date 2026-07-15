// Targeted regression tests for the historically-subtle engine behaviours
// (see CLAUDE.md porting rules). The corpus conformance covers these end to
// end; these keep them pinned even if the corpus changes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK } from "../../src/engine/constants.js";
import { Voice } from "../../src/engine/voice.js";
import { envPoint } from "../../src/engine/inst.js";
import { ghostVoice } from "../../src/engine/trigger.js";
import { advancePfRole, seedPfRole, advanceEnvelope, pfIdxBox, pfTimeBox } from "../../src/engine/envelope.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { loadIntoEngine } from "../../src/audio/offline-render.js";

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
  // Leftover pattern-loop + Ditto (effect 7) memory from the prior play (item 44).
  ts.voices[3].dittoActive = true;
  ts.voices[3].dittoSourceStart = 4; ts.voices[3].dittoLength = 2; ts.voices[3].dittoEndRow = 10;
  ts.voices[5].loopStartRow = 8; ts.voices[5].loopCount = 3;

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
  // item 44: ditto + loop status cleared so effects don't linger on replay.
  assert.equal(ts.voices[3].dittoActive, false, "ditto cleared");
  assert.equal(ts.voices[3].dittoSourceStart, 0);
  assert.equal(ts.voices[3].dittoLength, 0);
  assert.equal(ts.voices[3].dittoEndRow, 0);
  assert.equal(ts.voices[5].loopStartRow, 0, "S$Bx loop start cleared");
  assert.equal(ts.voices[5].loopCount, 0, "S$Bx loop count cleared");
});

// item 51: auditioning a strict metainstrument snaps to a note it can sound.
test("jamNote audition finds an in-range note for a strict metainstrument", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  // meta $4 is strict; at 0x5000 its layers' Ixmp zones don't cover the note.
  const inst = eng.instruments[4];
  assert.ok(inst.isMeta && inst.metaStrict, "meta $4 is a strict metainstrument");
  assert.ok(!eng._metaSoundsAt(inst, 0x5000), "silent at 0x5000 without audition");

  const jam = (audition) => {
    eng.stop(0);
    const ts = eng.playheads[0].trackerState;
    for (const v of ts.voices) v.active = false;
    ts.backgroundVoices.length = 0;
    eng.jamNote(0, 0, 0x5000, 4, audition);
    return ts.voices[0].active || ts.backgroundVoices.some((b) => b.active);
  };
  assert.equal(jam(false), false, "note-entry jam stays silent (exact pitch)");
  assert.equal(jam(true), true, "audition jam retries at an in-range note → sounds");
  // The chosen alternative note actually sounds.
  const alt = eng._auditionNoteFor(4, 0x5000);
  assert.ok(alt >= 0 && eng._metaSoundsAt(inst, alt), "audition note sounds");
});

// item 45: muting a channel silences its layer children / NNA ghosts too.
test("channel mute covers metainstrument layer children (background voices)", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  const ts = eng.playheads[0].trackerState;
  const rms = () => {
    const out = new Uint8Array(TRACKER_CHUNK * 2);
    let sum = 0, n = 0;
    for (let c = 0; c < 30; c++) { eng.renderChunk(0, out); for (let i = 0; i < out.length; i++) { const d = out[i] - 128; sum += d * d; n++; } }
    return Math.sqrt(sum / n);
  };
  const jam = () => {
    eng.stop(0);
    for (const v of ts.voices) v.active = false;
    ts.backgroundVoices.length = 0;
    eng.jamNote(0, 0, 0x50ab, 6); // meta $6 fans out ≥1 layer child onto ch 0
  };
  jam();
  assert.ok(ts.backgroundVoices.length >= 1, "meta $6 spawns a background layer child");
  const loud = rms();
  assert.ok(loud > 1, "sounds while unmuted");

  jam();
  eng.setVoiceMute(0, 0, true); // mute channel 0 (foreground + its children)
  const muted = rms();
  assert.ok(muted < loud * 0.05, `muted RMS ${muted.toFixed(2)} ≪ ${loud.toFixed(2)} (layer child silenced too)`);
});

// item 43: note 0 + instrument + a pitch effect (E/F/G) re-triggers the note.
test("note0 + inst + Fx F triggers the note at the current pitch (item 43)", () => {
  const eng = new TaudEngine();
  // Short NON-looping sample so the row-0 note ends before row 1.
  for (let i = 0; i < 200; i++) eng.sampleBin[i] = 128 + 40;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 200); w16(6, 32000); rec[14] = 0; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  eng.uploadInstrument(1, rec);
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;                       // row 0: C4, inst 1
  pat[8 + 2] = 1; pat[8 + 5] = 0x0f; pat[8 + 6] = 0x01; pat[8 + 7] = 0x01; // row 1: note 0, inst 1, F 0101
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0; // ch0 → pattern 0
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const v = eng.playheads[0].trackerState.voices[0];
  renderSamples(eng, 3072); // still within row 0 (< 6 ticks = 3840): the 200-frame note has ended
  assert.equal(v.active, false, "short row-0 note ended, voice idle");
  assert.ok(v.noteVal >= 0x20, "voice remembers the last note");
  renderSamples(eng, 1024);  // cross into row 1 (sample 3840)
  assert.equal(v.active, true, "note0 + inst + F re-triggered the note");
  assert.equal(v.instrumentId, 1);
  assert.ok(v.samplePos < 200, "re-triggered from the sample start");
});

// Timeline header: a metainstrument voice reports the META slot (what the
// pattern shows), not the layer child it resolves to (displayInst).
test("getVoiceInstrument reports the metainstrument slot, not the layer child", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  eng.jamNote(0, 0, 0x50ab, 6); // meta $6 sounds here; foreground = its layer-0 child
  const v = eng.playheads[0].trackerState.voices[0];
  assert.ok(v.active, "meta foreground voice is active");
  assert.equal(eng.instruments[6].isMeta, true, "slot 6 is a metainstrument");
  assert.notEqual(v.instrumentId, 6, "instrumentId resolved to a sub-instrument");
  assert.equal(eng.getVoiceInstrument(0, 0), 6, "header shows the meta slot $06");

  // A plain instrument still reports itself.
  eng.jamStop(0);
  const plain = eng.usedInstrumentSlots?.().find?.(() => false);
  let plainSlot = 0;
  for (let s = 1; s < 256; s++) { const i = eng.instruments[s]; if (i && !i.isMeta && i.sampleLength > 0) { plainSlot = s; break; } }
  eng.jamNote(0, 1, 0x5000, plainSlot);
  assert.equal(eng.getVoiceInstrument(0, 1), plainSlot, "plain instrument reports itself");
});

// bug #65: the Samples/Instruments editor preview must play the EXACT pooled
// sample on screen, not whatever a metainstrument would map C4 to. jamSample
// bypasses all instrument/zone resolution via a scratch AUDITION_SLOT.
test("jamSample previews the exact pooled sample, bypassing metainstrument zones (bug #65)", () => {
  const corpus = fileURLToPath(new URL("../corpus/flourish.taud", import.meta.url));
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(readFileSync(corpus)), 0);
  assert.ok(eng.instruments[6].isMeta, "slot 6 is a metainstrument");

  // A real pooled sample owned by one of the meta's layer children — exactly
  // the kind of sample the Samples view lists and the census attributes to a
  // metainstrument (so the old jamNote(slot) preview mis-resolved it at C4).
  let target = null;
  for (const l of eng.instruments[6].metaLayers) {
    const child = eng.instruments[l.instIdx & 0x3ff];
    if (child && !child.isMeta && child.sampleLength > 0) {
      target = { ptr: child.samplePtr, len: child.sampleLength, rate: child.samplingRate,
        playStart: 0, loopStart: child.sampleLoopStart, loopEnd: child.sampleLoopEnd,
        loopMode: child.loopMode };
      break;
    }
  }
  assert.ok(target, "found a layer-child sample to preview");

  // jamSample plays that exact region on the top channel regardless of the bank.
  const vi = 5;
  eng.jamSample(0, vi, 0x5000, target);
  const v = eng.playheads[0].trackerState.voices[vi];
  assert.ok(v.active, "audition voice is active");
  assert.equal(v.activeSamplePtr, target.ptr, "plays the exact sample ptr");
  assert.equal(v.activeSampleLength, target.len, "plays the exact sample length");
  // The scratch slot never disturbs a real bank slot.
  assert.equal(v.instrumentId, 1024, "audition plays through the reserved scratch slot");

  // Renders end-to-end through the reserved AUDITION_SLOT — proves the extended
  // instruments array is safe in the tick/mixer hot paths.
  renderSamples(eng, 256);
  assert.ok(v.samplePos > 0, "audition sample advanced");

  eng.jamStop(0);
  assert.equal(v.active, false, "jamStop ends the audition");
});
