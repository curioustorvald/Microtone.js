import { test } from "node:test";
import assert from "node:assert/strict";

import { interpretEditKey, semiToNote, semiToNoteInTable, SUB_NOTE, SUB_INST, SUB_VOL, SUB_FX_OP, SUB_FX_ARG } from "../../src/ui/edit.js";
import { TaudPlayData } from "../../src/engine/state.js";
import { MIDDLE_C } from "../../src/engine/constants.js";
import { pitchTablePresets } from "../../src/ui/pitchtables.js";

const ctx = { octave: 4, currentInst: 0x12 };

test("semiToNote: C4 = MIDDLE_C, octave steps are 4096", () => {
  assert.equal(semiToNote(4, 0), MIDDLE_C);
  assert.equal(semiToNote(5, 0), MIDDLE_C + 4096);
  assert.equal(semiToNote(4, 12), MIDDLE_C + 4096);
  assert.equal(semiToNote(4, 7), MIDDLE_C + Math.round((7 * 4096) / 12));
});

test("semiToNoteInTable: 12-TET/Raw/absent fall back to plain 12-EDO", () => {
  for (const preset of [undefined, pitchTablePresets[0], pitchTablePresets[120]]) {
    for (const semi of [0, 1, 5, 7, 11, 12]) {
      assert.equal(semiToNoteInTable(4, semi, preset), semiToNote(4, semi));
    }
  }
});

test("semiToNoteInTable: non-12 tuning snaps keys onto the scale degrees", () => {
  const p24 = pitchTablePresets[240]; // 24-TET, table entries per quarter-tone
  // Root key still lands on the anchor C4.
  assert.equal(semiToNoteInTable(4, 0, p24), MIDDLE_C);
  // A white key snaps to the nearest 24-TET degree (an exact table entry).
  const e = semiToNoteInTable(4, 4, p24); // ~major third
  const off = (e - MIDDLE_C) % p24.interval;
  assert.ok(p24.table.includes(off), `offset ${off.toString(16)} is a 24-TET degree`);
  // Top C wraps up one period.
  assert.equal(semiToNoteInTable(4, 12, p24), MIDDLE_C + p24.interval);
});

test("note column: entry follows the active notation preset", () => {
  const cell = new TaudPlayData();
  const p24 = pitchTablePresets[240];
  const a = interpretEditKey({ code: "KeyE", key: "e" }, SUB_NOTE, 0, cell,
    { octave: 4, currentInst: 0, preset: p24 });
  assert.equal(a.fields.note, semiToNoteInTable(4, 3, p24)); // KeyE = semitone 3
});

test("note column: piano key writes note + adopts current inst + jams", () => {
  const cell = new TaudPlayData();
  const a = interpretEditKey({ code: "KeyA", key: "a" }, SUB_NOTE, 0, cell, ctx);
  assert.equal(a.fields.note, MIDDLE_C);
  assert.equal(a.fields.instrment, 0x12);
  assert.equal(a.jamNote, MIDDLE_C);
  assert.ok(a.advanceRow);
});

test("note column specials: keyoff/cut/fade/clear", () => {
  const cell = new TaudPlayData();
  assert.equal(interpretEditKey({ code: "Backquote", key: "`" }, SUB_NOTE, 0, cell, ctx).fields.note, 1);
  assert.equal(interpretEditKey({ code: "Digit1", key: "1" }, SUB_NOTE, 0, cell, ctx).fields.note, 2);
  assert.equal(interpretEditKey({ code: "Digit2", key: "2" }, SUB_NOTE, 0, cell, ctx).fields.note, 3);
  const clr = interpretEditKey({ code: "Delete", key: "Delete" }, SUB_NOTE, 0, cell, ctx);
  assert.deepEqual(clr.fields, { note: 0, instrment: 0 });
});

test("inst column: two-nibble hex entry", () => {
  const cell = new TaudPlayData();
  const hi = interpretEditKey({ code: "Digit2", key: "2" }, SUB_INST, 0, cell, ctx);
  assert.equal(hi.fields.instrment, 0x20);
  assert.ok(hi.advanceNib);
  cell.instrment = 0x20;
  const lo = interpretEditKey({ code: "KeyA", key: "a" }, SUB_INST, 1, cell, ctx);
  assert.equal(lo.fields.instrment, 0x2a);
  assert.ok(lo.advanceRow);
});

test("vol column: hex entry promotes the no-op sentinel to SET", () => {
  const cell = new TaudPlayData(); // volume 0, volumeEff 0 by default
  cell.volumeEff = 3; cell.volume = 0; // explicit no-op sentinel
  const hi = interpretEditKey({ code: "Digit3", key: "3" }, SUB_VOL, 0, cell, ctx);
  assert.equal(hi.fields.volume, 0x30);
  assert.equal(hi.fields.volumeEff, 0); // SET
});

test("fx column: base-36 opcode then 4 arg nibbles", () => {
  const cell = new TaudPlayData();
  const op = interpretEditKey({ code: "KeyT", key: "t" }, SUB_FX_OP, 0, cell, ctx);
  assert.equal(op.fields.effect, 29); // 't' = OP_T
  assert.ok(op.advanceNib);
  const n0 = interpretEditKey({ code: "Digit7", key: "7" }, SUB_FX_ARG, 0, cell, ctx);
  assert.equal(n0.fields.effectArg, 0x7000);
  cell.effectArg = 0x7000;
  const n3 = interpretEditKey({ code: "KeyF", key: "f" }, SUB_FX_ARG, 3, cell, ctx);
  assert.equal(n3.fields.effectArg, 0x700f);
  assert.ok(n3.advanceRow);
});

test("non-edit keys pass through", () => {
  const cell = new TaudPlayData();
  assert.equal(interpretEditKey({ code: "KeyG", key: "g" }, SUB_INST, 0, cell, ctx), null);
  assert.equal(interpretEditKey({ code: "Semicolon", key: ";" }, SUB_NOTE, 0, cell, ctx), null);
});
