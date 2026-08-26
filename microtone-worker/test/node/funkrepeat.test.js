// Funk repeat — `Z $F0xx`, ProTracker 1.x's EFx (item 161).
//
// The disambiguation this file exists to pin: PT 1.x's **Funk Repeat** and PT
// 2.x's **Invert Loop** are different effects that share one opcode, one speed
// ladder and (in PT's own sources) one set of `funk*` names. Invert Loop is
// `S $F0xx` and grinds a progressive XOR through the loop's BYTES; Funk Repeat
// is this command and walks the loop WINDOW through the sample, leaving every
// byte alone. PT 1.1A's manual is the only place the original is described:
//
//     Cmd EF. Funk Repeat [Speed:$0-$F]
//     This command will need a short loop ($10,20,40,80 etc. bytes) to work.
//     It will move the loop through the whole length of the sample.
//
// …and PT 1.1B's playroutine is where the machinery survived, re-pointed at the
// byte inverter: the ladder, the 8-bit accumulator, the one-byte stride and the
// wrap all come from `mt_UpdateFunk`, which this engine follows for both.
//
// The window only changes where Paula changed it — the repeat pointer is
// latched when the loop restarts — so the pointer (`funkPos`) runs ahead of the
// window that is actually sounding (`funkWindow`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { SURROUND_SPATIAL } from "../../src/engine/spatial.js";

setSamplingRate(32000);

const SAMPLE_LEN = 1000;
const TICK = 640;          // 125 BPM at 32 kHz
const ROW = 6 * TICK;      // six ticks to the row

/** Engine with a 1000-byte ramp sample in slot 1, looping over `[ls, le)`. */
function makeEngine(ls = 100, le = 132, loopMode = 1) {
  const eng = new TaudEngine();
  for (let i = 0; i < SAMPLE_LEN; i++) eng.sampleBin[i] = i & 0xff;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, SAMPLE_LEN); // sampleLength
  w16(6, 32000);      // samplingRate @C4 — playback rate exactly 1.0
  w16(10, ls);        // loopStart
  w16(12, le);        // loopEnd
  rec[14] = loopMode;
  rec[21] = 0x3f;     // vol env node 0 = full
  rec[171] = 255;
  rec[196] = 255;
  eng.uploadInstrument(1, rec);
  return eng;
}

/**
 * Row 0 sounds C4 on instrument 1; `rows` gives each row's [effect, arg] in
 * turn. `retrigger` re-sounds the note on every row that carries one.
 */
function loadRows(eng, rows, retriggerRows = []) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1;
  for (const r of retriggerRows) { pat[r * 8] = 0x00; pat[r * 8 + 1] = 0x50; pat[r * 8 + 2] = 1; }
  rows.forEach(([effect, arg], r) => {
    pat[r * 8 + 5] = effect;
    pat[r * 8 + 6] = arg & 0xff;
    pat[r * 8 + 7] = (arg >> 8) & 0xff;
  });
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
}

function render(eng, samples) {
  const buf = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < Math.ceil(samples / TRACKER_CHUNK); i++) eng.renderChunk(0, buf);
}

const voiceOf = (eng) => eng.playheads[0].trackerState.voices[0];

test("Z $F0xx walks the loop window one byte per step", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]); // $80 — the ladder's top rung, one step per tick
  const v = voiceOf(eng);
  assert.equal(v.funkPos, -1, "nothing has moved before the row runs");

  render(eng, ROW);
  assert.equal(v.funkSpeed, 0x80);
  // Six ticks to the row, one byte a tick, from the loop start.
  assert.equal(v.funkPos, 106);
  render(eng, ROW * 5);
  assert.equal(v.funkPos, 136, "the walk keeps going without another command");
});

test("the window is what SOUNDS, and it follows the walk", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, ROW * 4);
  // 24 ticks in: the pointer is 24 bytes along and the sounding window is a
  // 32-byte span pinned to it, so the position is inside the MOVED loop and
  // nowhere near the sample's own.
  assert.equal(v.funkPos, 124);
  assert.ok(v.funkWindow >= 100, "the window has been latched at least once");
  assert.ok(v.samplePos >= v.funkWindow && v.samplePos < v.funkWindow + 32,
    `samplePos ${v.samplePos} sits inside the window at ${v.funkWindow}`);
  assert.ok(v.samplePos >= 132,
    "…which is past the end of the loop the instrument declares");
});

test("the window is latched at the loop restart, not the moment the walk steps", () => {
  // A loop long enough that one iteration outlasts a tick — at rate 1.0 a
  // 900-byte loop is 900 samples against the tick's 640 — so the pointer gets
  // to move between two restarts and the lag is visible.
  const eng = makeEngine(0, 900);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 3);
  assert.equal(v.funkPos, 3, "three ticks, three steps");
  assert.ok(v.funkWindow < v.funkPos,
    `the sounding window (${v.funkWindow}) is behind the pointer (${v.funkPos}) ` +
    "— Paula latches the repeat pointer when the loop restarts");
});

test("the walk wraps at the SAMPLE end, and the whole window stays inside it", () => {
  // Loop at the very end of the sample: one step already puts the window's far
  // end past the last byte, so the pointer wraps to the sample start at once.
  const eng = makeEngine(SAMPLE_LEN - 32, SAMPLE_LEN);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK);
  assert.equal(v.funkPos, 0, "wrapped to the sample start rather than reading past the end");
  render(eng, TICK);
  assert.equal(v.funkPos, 1, "and carries on from there");
});

test("a fresh trigger puts the loop back; the speed and accumulator do not", () => {
  const eng = makeEngine(100, 132);
  // Row 0 arms the walk, row 4 sounds the note again with no effect at all.
  loadRows(eng, [[0x23, 0xf080]], [4]);
  const v = voiceOf(eng);
  render(eng, ROW * 4 + TICK);   // one tick into the re-triggered note
  assert.equal(v.funkSpeed, 0x80, "the speed is channel state and survives the note");
  assert.equal(v.funkPos, 101,
    "the walk restarts from the loop start (PT's n_wavestart = n_loopstart)");
  assert.ok(v.samplePos < 132, "and the voice is sounding the sample's own loop again");
});

test("Z $F000 stops the walk and leaves the window where it stopped", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080], [0x00, 0x0000], [0x23, 0xf000]]);
  const v = voiceOf(eng);
  render(eng, ROW * 3);
  const stopped = v.funkPos;
  assert.equal(v.funkSpeed, 0);
  assert.ok(stopped > 100, "the walk had moved before it was switched off");
  render(eng, ROW * 4);
  assert.equal(v.funkPos, stopped, "and it stays exactly where it was");
  assert.ok(v.samplePos >= v.funkWindow && v.samplePos < v.funkWindow + 32,
    "the moved window keeps sounding — PT leaves the repeat pointer alone too");
});

test("an unlooped sample is left alone — the effect needs a loop to move", () => {
  const eng = makeEngine(0, 0, 0); // loop mode 0: no loop
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, ROW);
  assert.equal(v.funkSpeed, 0x80, "the command still lands");
  assert.equal(v.funkPos, -1, "…and finds nothing to walk");
});

test("the speed ladder is the accumulator's, shared with the invert loop", () => {
  // $80 steps every tick, $40 every second, $2B every third: the 8-bit
  // accumulator adds the value and steps when it passes $80.
  for (const [speed, ticks, steps] of [[0x80, 6, 6], [0x40, 6, 3], [0x2b, 6, 2], [0x05, 6, 0]]) {
    const eng = makeEngine(100, 132);
    loadRows(eng, [[0x23, 0xf000 | speed]]);
    const v = voiceOf(eng);
    render(eng, TICK * ticks);
    const walked = v.funkPos < 0 ? 0 : v.funkPos - 100;
    assert.equal(walked, steps, `speed $${speed.toString(16)} over ${ticks} ticks`);
  }
});

test("nothing is written to the sample: the pool is untouched", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  render(eng, ROW * 8);
  for (let i = 0; i < SAMPLE_LEN; i++) {
    assert.equal(eng.sampleBin[i], i & 0xff, `sample byte ${i} is as it was uploaded`);
  }
  assert.equal(eng.instruments[1].invertMask, null,
    "and no invert-loop mask was allocated — this is the OTHER EFx");
});

test("the funk form of Z is live in a stereo song, and leaves the slide alone", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  assert.equal(eng.getSurroundModel(0), 0, "a plain stereo song");
  render(eng, ROW);
  assert.equal(v.funkPos, 106, "…which ignores Z $0xxx but must not ignore Z $F0xx");
  assert.equal(v.spatialSlideActive, false);
  assert.equal(v.mem.z, 0, "the spatial slide's memory slot is not the funk speed");
});

test("Z $0xxx still slides, and does not arm the walk", () => {
  const eng = makeEngine(100, 132);
  eng.setSurroundModel(0, SURROUND_SPATIAL);
  loadRows(eng, [[0x04, 0x0040], [0x23, 0x0100]]); // aim front-left, then slide
  const v = voiceOf(eng);
  render(eng, ROW * 2);
  assert.equal(v.mem.z, 0x100, "the slide speed went to the slide's memory");
  assert.equal(v.funkSpeed, 0, "and nothing to the walk");
  assert.equal(v.funkPos, -1);
});

test("a transport reset clears the walk", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, ROW * 2);
  assert.ok(v.funkPos > 100);
  eng.resetSampleFxState(0);
  assert.equal(v.funkSpeed, 0);
  assert.equal(v.funkAccumulator, 0);
  assert.equal(v.funkPos, -1);
  assert.equal(v.funkWindow, -1, "a clean replay starts from the file's own loop");
});
