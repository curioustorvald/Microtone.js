// Funk repeat — `Z $F0xx`, ProTracker 1.0C's EFx (item 161).
//
// Pinned against the transcription in the TSVM tree's
// reference_materials/protracker_1/FUNK_REPEAT.md, which derives both halves of
// `EF $x` line by line from the 1.0C and 1.1B playroutine sources. Section
// numbers below are that document's.
//
// The disambiguation this file exists to hold: `EF $x` is ONE slot with TWO
// algorithms. **Invert Loop** (1.1B onwards) is `S $F0xx` and one's-complements
// the loop's bytes in place. **Funk Repeat** (1.0C) is this command: it adds a
// whole loop length to the repeat pointer, writes it into Paula's AUDxLC, and
// snaps back to the real loop start when the next block would not fit whole
// (§3.1). The sample data is never touched. They share the ladder, the
// accumulator, the sticky speed nibble and — in PT's sources — every name.
//
// State scope (§2.1, §7.2): the window is per voice and follows the note; the
// speed and the accumulator are per channel and outlive it. PT never cleared
// the accumulator anywhere but on its own overflow — not on a note, not on a
// speed change, not on `EF $0` — so the ladder is a running phase, not a
// period counter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import { SURROUND_SPATIAL } from "../../src/engine/spatial.js";
import { TOTAL_VOICES } from "../../src/engine/constants.js";
import { fillSnapshotInto } from "../../src/worklet/engine-commands.js";
import {
  SNAP_FLOATS, SNAP_HEADER_SIZE, SNAP_VOICE_STRIDE, SNAP_V_ACTIVE,
  SNAP_V_FUNK_WINDOW, SNAP_V_FUNK_POS, SNAP_V_FUNK_LEN,
} from "../../src/worklet/protocol.js";

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

test("the window hops a WHOLE LOOP LENGTH per step (§3.2)", () => {
  // Loop [100, 132) — 32 bytes — in a 1000-byte sample.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]); // $80 — the ladder's top rung, one step per tick
  const v = voiceOf(eng);
  assert.equal(v.funkPos, -1, "nothing has moved before the row runs");

  render(eng, TICK);
  assert.equal(v.funkSpeed, 0x80);
  assert.equal(v.funkPos, 132, "one step = one loop length, not one byte");
  render(eng, TICK * 3);
  assert.equal(v.funkPos, 228, "…and it keeps hopping by 32");
});

test("the walk snaps back to the LOOP START, not the sample start (§3.3)", () => {
  // §8.2's first vector in offsets: loopStart 16, loopLen 16, sample 128 bytes.
  // Successive positions 32 48 64 80 96 112 → 16, i.e. seven distinct blocks.
  const eng = makeEngine(16, 32);
  eng.instruments[1].sampleLength = 128;
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  const seen = [];
  for (let i = 0; i < 9; i++) { render(eng, TICK); seen.push(v.funkPos); }
  assert.deepEqual(seen, [32, 48, 64, 80, 96, 112, 16, 32, 48],
    "the last block visited is the last one that fits WHOLE, then back to 16");
});

test("a loop at the tail of its sample is inert — by design (§3.5)", () => {
  // limit == loopStart, so every candidate overshoots and every step resets.
  const eng = makeEngine(SAMPLE_LEN - 32, SAMPLE_LEN);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 4);
  assert.equal(v.funkPos, SAMPLE_LEN - 32,
    "pinned to the real loop start — this is why the manual asks for a SHORT loop");
});

test("the window is what SOUNDS, and it follows the walk", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 4);
  assert.equal(v.funkPos, 228);
  assert.ok(v.funkWindow >= 100, "the window has been latched at least once");
  assert.ok(v.samplePos >= v.funkWindow && v.samplePos < v.funkWindow + 32,
    `samplePos ${v.samplePos} sits inside the window at ${v.funkWindow}`);
  assert.ok(v.samplePos >= 132,
    "…which is past the end of the loop the instrument declares");
});

test("the window is latched at the loop restart, not the moment the walk steps", () => {
  // A loop long enough that one iteration outlasts a tick — at rate 1.0 a
  // 300-byte loop is 300 samples against the tick's 640 is not enough, so take
  // 900: the pointer gets to move between two restarts and the lag is visible.
  const eng = makeEngine(0, 900);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, TICK * 3);
  assert.equal(v.funkPos, 0,
    "a 900-byte window in a 1000-byte sample cannot fit twice: every step resets");
  assert.equal(v.funkWindow, 0, "so the window it latches is the loop start");
});

test("the accumulator is a running phase: nothing resets it (§2.1, §7.3)", () => {
  // $2B steps every 3rd tick. Two ticks in, the phase is 2×$2B = $56; a fresh
  // Z $F02B on the next row must NOT restart the count, so the step still lands
  // on the 3rd tick of the ORIGINAL count rather than three ticks later.
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf02b]]);
  const v = voiceOf(eng);
  render(eng, TICK * 2);
  assert.equal(v.funkAccumulator, 0x2b * 2, "two ticks of phase, unspent");
  assert.equal(v.funkPos, -1, "and no step yet");
  render(eng, TICK);
  assert.equal(v.funkPos, 132, "the third tick overflows $80 and steps");
  assert.equal(v.funkAccumulator, 0, "reset to zero, not decremented by $80");
});

test("Z $F000 stops the walk, keeps the phase, and leaves the window where it is", () => {
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

test("a fresh trigger puts the loop back; the speed and the phase do not", () => {
  const eng = makeEngine(100, 132);
  // Row 0 arms the walk, row 4 sounds the note again with no effect at all.
  loadRows(eng, [[0x23, 0xf080]], [4]);
  const v = voiceOf(eng);
  render(eng, ROW * 4 + TICK);   // one tick into the re-triggered note
  assert.equal(v.funkSpeed, 0x80, "the speed is channel state and survives the note");
  assert.equal(v.funkPos, 132,
    "the walk restarts from the loop start (PT's n_wavestart = n_loopstart)");
  assert.ok(v.samplePos < 164, "and the voice is sounding near the sample's own loop again");
});

test("an unlooped sample is left alone — the effect needs a loop to move", () => {
  const eng = makeEngine(0, 0, 0); // loop mode 0: no loop
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  render(eng, ROW);
  assert.equal(v.funkSpeed, 0x80, "the command still lands");
  assert.equal(v.funkPos, -1, "…and finds nothing to walk");
});

test("the ladder fires on the ticks §8.1 tabulates", () => {
  // The report's accumulator table, read back through the engine: the tick a
  // walk starting from a zero phase takes its FIRST step on.
  const LADDER = [
    [0x05, 26], [0x06, 22], [0x07, 19], [0x08, 16], [0x0a, 13], [0x0b, 12],
    [0x0d, 10], [0x10, 8], [0x13, 7], [0x16, 6], [0x1a, 5], [0x20, 4],
    [0x2b, 3], [0x40, 2], [0x80, 1],
  ];
  for (const [speed, tick] of LADDER) {
    const eng = makeEngine(100, 132);
    loadRows(eng, [[0x23, 0xf000 | speed]]);
    const v = voiceOf(eng);
    render(eng, TICK * (tick - 1));
    assert.equal(v.funkPos, -1,
      `speed $${speed.toString(16)}: nothing before tick ${tick}`);
    render(eng, TICK);
    assert.equal(v.funkPos, 132,
      `speed $${speed.toString(16)}: the first step lands on tick ${tick}`);
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
  render(eng, TICK);
  assert.equal(v.funkPos, 132, "…which ignores Z $0xxx but must not ignore Z $F0xx");
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

// ── The Samples view's state overlay (item 164) ──────────────────────────────
// The view draws the window from the SNAPSHOT, so what is pinned here is the
// data path: the three per-voice fields, and that they say what the overlay
// needs — where the loop is, where it is going, and how wide to draw it.

test("the snapshot carries the window, the pending hop and the width", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x23, 0xf080]]);
  const v = voiceOf(eng);
  const f = new Float64Array(SNAP_FLOATS);
  const vField = (vi, k) => f[SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE + k];

  render(eng, TICK * 4);
  fillSnapshotInto(eng, 0, f);
  assert.equal(vField(0, SNAP_V_FUNK_WINDOW), v.funkWindow);
  assert.equal(vField(0, SNAP_V_FUNK_POS), v.funkPos);
  assert.equal(vField(0, SNAP_V_FUNK_LEN), 32, "the VOICE's active loop length");
  assert.ok(vField(0, SNAP_V_FUNK_POS) >= vField(0, SNAP_V_FUNK_WINDOW),
    "the pending hop runs ahead of the window that is sounding");
  // …and the overlay's own guard: the band must fit inside the sample it is
  // drawn over, whatever the walk is doing.
  assert.ok(vField(0, SNAP_V_FUNK_WINDOW) + vField(0, SNAP_V_FUNK_LEN) <= SAMPLE_LEN);
});

test("a voice with no walk reports -1, so nothing is drawn", () => {
  const eng = makeEngine(100, 132);
  loadRows(eng, [[0x00, 0x0000]]);   // a note, no funk
  const f = new Float64Array(SNAP_FLOATS);
  const vField = (vi, k) => f[SNAP_HEADER_SIZE + vi * SNAP_VOICE_STRIDE + k];
  render(eng, TICK * 4);
  fillSnapshotInto(eng, 0, f);
  assert.equal(vField(0, SNAP_V_ACTIVE), 1, "the voice is sounding");
  assert.equal(vField(0, SNAP_V_FUNK_WINDOW), -1, "…on the sample's own loop");
  assert.equal(vField(0, SNAP_V_FUNK_POS), -1);
  // A silent voice reports -1 too, rather than a stale window from last time.
  assert.equal(vField(TOTAL_VOICES - 1, SNAP_V_FUNK_WINDOW), -1);
  assert.equal(vField(TOTAL_VOICES - 1, SNAP_V_FUNK_POS), -1);
});
