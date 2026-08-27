// Item 159 — Metainstrument type 4: an operator rack whose wiring is an RPN
// program in the record's own tail.
//
// Three things are worth pinning and nothing else really is. (1) The record
// round-trips, and a program that does not verify leaves the instrument silent
// rather than running the record's tail as code. (2) The rack is ONE voice: the
// modulators never reach the mix, and phase modulation moves the read without
// moving the trajectory — a modulated carrier must still be at the same place
// after N samples as an unmodulated one. (3) Operator 0 is the principal: gate
// it out and the note is silent, whatever the modulators would have done.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../src/engine/constants.js";
import {
  buildMetaRecord, makeMetaLayer, decodeFmProgram, defaultFmProgram, fmRecordBytes,
  TaudInst, FmOp, FM_WORD_MOD, FM_WORD_FB, FM_MAX_OPERATORS, FM_BUDGET_BYTES,
  META_TYPE_FM, META_TYPE_LAYERED,
} from "../../src/engine/inst.js";
import { fmReferencedOperators } from "../../src/engine/fm.js";

setSamplingRate(32000);

const op = (slot, mix = 159, detune = 0, lo = 0x0000, hi = 0xffff, vlo = 0, vhi = 63) =>
  makeMetaLayer(slot, mix, detune, lo, hi, vlo, vhi);

/** A 256-frame looping sine in `slot` — a single-cycle waveform, which is what
 *  makes the modulation index read as "cycles" the way §7.6 says it does. */
function uploadCycle(eng, slot, ptr) {
  for (let i = 0; i < 256; i++) {
    eng.sampleBin[ptr + i] = 128 + Math.round(120 * Math.sin((2 * Math.PI * i) / 256));
  }
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  rec[0] = ptr & 0xff; rec[1] = (ptr >> 8) & 0xff; rec[2] = (ptr >> 16) & 0xff;
  w16(4, 256);    // sampleLength
  w16(6, 32000);  // samplingRate @C4 — playback rate 1.0
  w16(12, 256);   // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; // instGlobalVolume
  rec[196] = 255; // defaultNoteVolume
  eng.uploadInstrument(slot, rec);
}

function makeEngine() {
  const eng = new TaudEngine();
  uploadCycle(eng, 1, 0);
  uploadCycle(eng, 2, 512);
  return eng;
}

function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
  }
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
  return eng;
}

const CHUNKS_PER_TICK = (SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK;
assert.ok(Number.isInteger(CHUNKS_PER_TICK));

/** Render `chunks` chunks, returning the interleaved U8 of the LAST one. */
function render(eng, chunks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < chunks; i++) eng.renderChunk(0, out);
  return out;
}

const ts0 = (eng) => eng.playheads[0].trackerState;
const voice0 = (eng) => ts0(eng).voices[0];
const operators = (eng) => ts0(eng).backgroundVoices.filter((v) => v.fmOperator);

/** Peak deflection from the U8 midpoint over one rendered chunk. */
function peak(out) {
  let m = 0;
  for (let i = 0; i < out.length; i += 2) m = Math.max(m, Math.abs(out[i] - 128));
  return m;
}

// ── the record ───────────────────────────────────────────────────────────

test("a type-4 record round-trips its type, rack and algorithm", () => {
  const rec = buildMetaRecord([op(0x101), op(0x102)], { type: META_TYPE_FM });
  assert.equal(rec[0] >>> 4, META_TYPE_FM, "byte 0's high nibble is the type");
  assert.equal(rec[1], 2);
  assert.equal(rec[2], 0xff);
  assert.equal(rec[3], 0xff);
  const inst = new TaudInst(5);
  inst.loadRecord(rec);
  assert.ok(inst.isMeta && inst.isFm);
  assert.equal(inst.metaType, META_TYPE_FM);
  assert.equal(inst.metaLayers.length, 2);
  // The default algorithm is the chain: push op1, then op0 modulated by it.
  assert.deepEqual([...inst.fmProgram], [1, FM_WORD_MOD | 0]);
});

test("a layered record still reads as type 0 and carries no program", () => {
  const inst = new TaudInst(5);
  inst.loadRecord(buildMetaRecord([op(0x101), op(0x102)]));
  assert.equal(inst.metaType, META_TYPE_LAYERED);
  assert.equal(inst.isFm, false);
  assert.equal(inst.fmProgram, null);
});

test("an FM rack MUTES an unusable operator in place; a layered meta drops it", () => {
  // Operator 0 points at nothing. Compacting the rack would slide operator 1
  // into slot 0 and rewire every word of the algorithm under it.
  const layers = [op(0), op(0x102)];
  const fm = new TaudInst(5);
  fm.loadRecord(buildMetaRecord(layers, { type: META_TYPE_FM }));
  assert.equal(fm.metaLayers.length, 2, "the rack keeps its shape");
  assert.equal(fm.metaLayers[0].instIdx, 0, "…with the dead operator muted");
  assert.equal(fm.metaLayers[1].instIdx, 0x102);

  const layered = new TaudInst(5);
  layered.loadRecord(buildMetaRecord(layers));
  assert.equal(layered.metaLayers.length, 1, "a layer table compacts as it always has");
  assert.equal(layered.metaLayers[0].instIdx, 0x102);
});

test("a program that does not verify is no program at all", () => {
  const bad = (words) => {
    const rec = buildMetaRecord([op(0x101), op(0x102)],
      { type: META_TYPE_FM, program: Uint16Array.from(words) });
    const inst = new TaudInst(5);
    inst.loadRecord(rec);
    return inst.fmProgram;
  };
  assert.equal(bad([FM_WORD_MOD | 0]), null, "modulated push with an empty stack");
  assert.equal(bad([0, 1, FmOp.ADD, FmOp.ADD]), null, "one ADD too many");
  assert.equal(bad([7]), null, "operator 7 of a two-operator rack");
  assert.equal(bad([]), null, "nothing to output");
  assert.notEqual(bad([0, 1, FmOp.ADD]), null, "…and a well-formed one survives");
});

test("an unknown word is rejected, not stepped over", () => {
  // $0Cxx is not an operand class and $FF7F is not an operator. Reading past
  // either would be running the record's tail as code.
  const rec = buildMetaRecord([op(0x101)], { type: META_TYPE_FM });
  const at = 4 + 10;
  rec[at] = 0x00; rec[at + 1] = 0x0c;
  assert.equal(decodeFmProgram(rec, at, 1), null);
  rec[at] = 0x7f; rec[at + 1] = 0xff;
  assert.equal(decodeFmProgram(rec, at, 1), null);
});

test("the rack and the algorithm share one 252-byte budget", () => {
  // 16 operators is the cap precisely so the algorithm always has room left.
  assert.ok(fmRecordBytes(FM_MAX_OPERATORS, defaultFmProgram(FM_MAX_OPERATORS).length)
    <= FM_BUDGET_BYTES);
  // …and the packer never writes a word it cannot terminate. NEG is depth
  // neutral, so this program stays well-formed wherever the budget cuts it.
  const long = new Uint16Array(200).fill(FmOp.NEG);
  const rec = buildMetaRecord([op(0x101)], {
    type: META_TYPE_FM, program: Uint16Array.from([0, ...long]),
  });
  const inst = new TaudInst(5);
  inst.loadRecord(rec);
  assert.notEqual(inst.fmProgram, null, "the truncated program still verifies");
  assert.ok(inst.fmProgram.length < 201, "…because it WAS truncated");
  assert.ok(fmRecordBytes(1, inst.fmProgram.length) <= FM_BUDGET_BYTES);
});

test("only $00xx and $04xx make an operator sound", () => {
  // A feedback tap reads what an operator left LAST sample, so it can never be
  // the thing that brings one to life.
  const used = fmReferencedOperators(
    Uint16Array.from([FM_WORD_FB | 2, FM_WORD_MOD | 1, 0, FmOp.ADD]), 3);
  assert.deepEqual([...used], [1, 1, 0]);
});

// ── the engine ───────────────────────────────────────────────────────────

test("a rack is ONE voice: its modulators never reach the mix", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  const ops = operators(eng);
  assert.equal(ops.length, 1, "operator 1 spawned as a background voice");
  assert.ok(ops[0].active, "…and it is sounding");
  assert.notEqual(voice0(eng).fmRig, null, "the channel's voice carries the rack");
  assert.equal(voice0(eng).fmRig.voices[0], voice0(eng), "operator 0 IS that voice");
  // The proof that the operand is not also a sound: silence the CARRIER and
  // the channel goes quiet even though the modulator is still running at full
  // level. What is left is the output dither, which is one LSB of it.
  const quiet = makeEngine();
  quiet.uploadInstrument(4, buildMetaRecord([op(1, 0), op(2, 255)], { type: META_TYPE_FM }));
  loadSong(quiet, [{ row: 0, note: 0x5000, inst: 4 }]);
  assert.equal(operators(quiet).length, 0, "premise: nothing rendered yet");
  assert.ok(peak(render(quiet, 3)) <= 1,
    "a carrier at silence is silence, not a modulator solo");
});

test("modulation moves the read, not the trajectory", () => {
  const straight = makeEngine();
  straight.uploadInstrument(3, buildMetaRecord([op(1)], { type: META_TYPE_FM }));
  loadSong(straight, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(straight, 4);

  const modulated = makeEngine();
  modulated.uploadInstrument(3, buildMetaRecord([op(1), op(2, 200, 4096)],
    { type: META_TYPE_FM }));
  loadSong(modulated, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(modulated, 4);

  assert.equal(voice0(modulated).samplePos, voice0(straight).samplePos,
    "the carrier is exactly where it would have been unmodulated");
});

test("modulation changes the SIGNAL", () => {
  const straight = makeEngine();
  straight.uploadInstrument(3, buildMetaRecord([op(1)], { type: META_TYPE_FM }));
  loadSong(straight, [{ row: 0, note: 0x5000, inst: 3 }]);
  const a = render(straight, 3);

  const modulated = makeEngine();
  modulated.uploadInstrument(3, buildMetaRecord([op(1), op(2, 200, 4096)],
    { type: META_TYPE_FM }));
  loadSong(modulated, [{ row: 0, note: 0x5000, inst: 3 }]);
  const b = render(modulated, 3);

  assert.notDeepEqual([...a], [...b]);
  assert.ok(peak(b) > 0, "…and it is still making a sound");
});

test("an operator the algorithm never names costs nothing", () => {
  const eng = makeEngine();
  // Three operators, an algorithm that reads two of them.
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2), op(2)], {
    type: META_TYPE_FM, program: Uint16Array.from([1, FM_WORD_MOD | 0]),
  }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  assert.equal(operators(eng).length, 1, "operator 2 was never spawned");
  assert.equal(voice0(eng).fmRig.voices[2], null);
});

test("operator 0 is the principal: gate it out and the note is silent", () => {
  const eng = makeEngine();
  // Operator 0 covers nothing at C-4; operator 1 covers everything.
  eng.uploadInstrument(3, buildMetaRecord([
    op(1, 159, 0, 0x8000, 0xffff), op(2),
  ], { type: META_TYPE_FM }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 2);
  assert.equal(voice0(eng).active, false);
  assert.equal(voice0(eng).fmRig, null);
  assert.equal(operators(eng).length, 0, "and nothing was spawned to sound alone");
});

test("a rack with no verifiable algorithm is silent", () => {
  const eng = makeEngine();
  const rec = buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM });
  const at = 4 + 20;
  rec[at] = 0x00; rec[at + 1] = 0x0c;  // an unknown word where the program starts
  eng.uploadInstrument(3, rec);
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 2);
  assert.equal(voice0(eng).active, false);
});

test("retriggering the channel takes the whole rack with it", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  uploadCycle(eng, 5, 1024);
  loadSong(eng, [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5000, inst: 5 },
  ]);
  render(eng, CHUNKS_PER_TICK * 6 + 1);
  assert.equal(voice0(eng).fmRig, null, "the plain note dropped the rack");
  assert.equal(operators(eng).length, 0, "…and its operands went with it");
});

test("a rack's operators die with the note rather than ageing on", () => {
  const eng = makeEngine();
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [{ row: 0, note: 0x5000, inst: 3 }]);
  render(eng, 1);
  assert.equal(operators(eng).length, 1);
  voice0(eng).active = false;               // operator 0's own note ended
  render(eng, CHUNKS_PER_TICK + 1);
  assert.equal(operators(eng).length, 0);
  assert.equal(ts0(eng).backgroundVoices.length, 0, "…and nothing was left behind");
});

test("a rack does not leave an NNA ghost behind", () => {
  // A ghost of a rack would sound operator 0's bare sample — not the note that
  // was playing, and not a sound the patch can make.
  const eng = makeEngine();
  const nna = new Uint8Array(256);
  const w16 = (o, v) => { nna[o] = v & 0xff; nna[o + 1] = (v >> 8) & 0xff; };
  w16(4, 256); w16(6, 32000); w16(12, 256);
  nna[14] = 1; nna[21] = 0x3f; nna[171] = 255; nna[196] = 255;
  nna[186] = 0x02; // instrument flag: New Note Action = continue
  eng.uploadInstrument(1, nna);
  eng.uploadInstrument(3, buildMetaRecord([op(1), op(2)], { type: META_TYPE_FM }));
  loadSong(eng, [
    { row: 0, note: 0x5000, inst: 3 },
    { row: 1, note: 0x5400, inst: 3 },
  ]);
  render(eng, CHUNKS_PER_TICK * 6 + 1);
  assert.equal(operators(eng).length, 1, "the new rack's operand, and only it");
  assert.equal(ts0(eng).backgroundVoices.length, 1, "no ghost of the old rack");
});

test("the ADD word sums two carriers", () => {
  const one = makeEngine();
  one.uploadInstrument(3, buildMetaRecord([op(1)], { type: META_TYPE_FM }));
  loadSong(one, [{ row: 0, note: 0x5000, inst: 3 }]);
  const solo = peak(render(one, 3));

  const both = makeEngine();
  both.uploadInstrument(3, buildMetaRecord([op(1), op(1)], {
    type: META_TYPE_FM, program: Uint16Array.from([0, 1, FmOp.ADD]),
  }));
  loadSong(both, [{ row: 0, note: 0x5000, inst: 3 }]);
  const summed = peak(render(both, 3));

  assert.ok(summed > solo, `two carriers are louder than one (${summed} vs ${solo})`);
});
