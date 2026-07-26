import { test } from "node:test";
import assert from "node:assert/strict";

import {
  interpretEditKey, interpretBracketKey, lookahead, rawNoteView, semiToNote, semiToNoteInTable,
  subIsEmpty, subCharPos, charToSub, subToCol, SUB_POSITIONS, SUB_NIBBLES,
  volPanOp, volPanArg, volPanStep, fineSigned, fineValue,
  SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG,
} from "../../src/ui/edit.js";
import { volToStr, panToStr } from "../../src/ui/notenames.js";
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

test("semiToNoteInTable: absolute (ProTracker, interval 0) snaps without looping", () => {
  const pt = pitchTablePresets[1]; // ProTracker pitch — interval 0, absolute table
  assert.equal(pt.interval, 0, "ProTracker preset is absolute");
  const base = pt.base;
  // Every jam key must return a real table degree (regression: interval 0 used
  // to spin `while (pos >= interval)` forever and lock the browser).
  for (let oct = 0; oct <= 9; oct++) {
    for (let semi = 0; semi <= 12; semi++) {
      const note = semiToNoteInTable(oct, semi, pt);
      assert.ok(pt.table.some((off) => base + off === note),
        `oct ${oct} semi ${semi} → ${note.toString(16)} is a ProTracker degree`);
    }
  }
  // Root key at C4 snaps to the nearest PT degree to concert C4.
  const c4 = semiToNoteInTable(4, 0, pt);
  const dist = Math.min(...pt.table.map((off) => Math.abs(base + off - MIDDLE_C)));
  assert.equal(Math.abs(c4 - MIDDLE_C), dist, "C4 key picks the nearest degree");
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

test("note column specials: keyoff/clear (Digit1/2/3 removed, item 47.3)", () => {
  const cell = new TaudPlayData();
  assert.equal(interpretEditKey({ code: "Backquote", key: "`" }, SUB_NOTE, 0, cell, ctx).fields.note, 1);
  // Digit 1/2/3 no longer insert sentinels on the note column.
  assert.equal(interpretEditKey({ code: "Digit1", key: "1" }, SUB_NOTE, 0, cell, ctx), null);
  assert.equal(interpretEditKey({ code: "Digit2", key: "2" }, SUB_NOTE, 0, cell, ctx), null);
  assert.equal(interpretEditKey({ code: "Digit3", key: "3" }, SUB_NOTE, 0, cell, ctx), null);
  const clr = interpretEditKey({ code: "Delete", key: "Delete" }, SUB_NOTE, 0, cell, ctx);
  assert.deepEqual(clr.fields, { note: 0, instrment: 0 });
});

test("note column: taut z/x/c/v sentinels, inserted not auditioned", () => {
  const cell = new TaudPlayData();
  for (const [code, note] of [["KeyZ", 1], ["KeyX", 2], ["KeyC", 3], ["KeyV", 4]]) {
    const a = interpretEditKey({ code, key: code.slice(3).toLowerCase() }, SUB_NOTE, 0, cell, ctx);
    assert.equal(a.fields.note, note, `${code} → 0x000${note}`);
    assert.ok(a.advanceRow, `${code} advances the row`);
    assert.equal(a.jamNote, undefined, `${code} is not auditioned`);
  }
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

test("subIsEmpty: a wheel over a dotted sub-column only scrolls (no edit)", () => {
  // A convention-blank pattern cell: vol/pan no-op sentinels, everything else 0.
  const blank = new TaudPlayData();
  blank.volumeEff = 3; blank.panEff = 3; // 0xC0/0xC0 -> "···"/"···"
  for (const sub of [SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG]) {
    assert.equal(subIsEmpty(sub, blank), true);
  }

  // note: only a pitched note (>= 0x20) is steppable; sentinels count as empty.
  const note = new TaudPlayData(); note.note = MIDDLE_C;
  assert.equal(subIsEmpty(SUB_NOTE, note), false);
  note.note = 0x0001; // key-off sentinel
  assert.equal(subIsEmpty(SUB_NOTE, note), true);

  // Each filled sub-column is editable independently of the others.
  const cell = new TaudPlayData();
  cell.volumeEff = 3; cell.panEff = 3; // start fully blank
  cell.instrment = 1;
  assert.equal(subIsEmpty(SUB_INST, cell), false);
  assert.equal(subIsEmpty(SUB_VOL, cell), true); // vol still a dot -> untouched

  cell.volumeEff = 0; cell.volume = 0x20; // a real SET volume
  assert.equal(subIsEmpty(SUB_VOL, cell), false);

  cell.panEff = 2; cell.pan = 0x10; // pan slide
  assert.equal(subIsEmpty(SUB_PAN, cell), false);

  // fx opcode + arg share one visual column: empty only when both are 0.
  const fx = new TaudPlayData();
  assert.equal(subIsEmpty(SUB_FX_OP, fx), true);
  assert.equal(subIsEmpty(SUB_FX_ARG, fx), true);
  fx.effect = 1;
  assert.equal(subIsEmpty(SUB_FX_OP, fx), false);
  assert.equal(subIsEmpty(SUB_FX_ARG, fx), false);
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

test("rawNoteView: Raw toggle on OR a Raw notation preset", () => {
  assert.equal(rawNoteView(true, pitchTablePresets[120]), true, "toggle on");
  assert.equal(rawNoteView(false, pitchTablePresets[120]), false, "12-TET, toggle off");
  assert.equal(rawNoteView(false, pitchTablePresets[0]), true, "Raw preset (empty table)");
  assert.equal(rawNoteView(false, null), true, "no preset");
});

test("raw-hex note entry shifts in + overrides jam/sentinels", () => {
  const rctx = { octave: 4, currentInst: 5, preset: pitchTablePresets[120], rawHex: true };
  const cell = new TaudPlayData();
  // hex digits shift into the 16-bit word, left-to-right
  cell.note = 0;
  assert.equal(interpretEditKey({ code: "Digit5", key: "5" }, SUB_NOTE, 0, cell, rctx).fields.note, 0x0005);
  cell.note = 0x0567;
  const a = interpretEditKey({ code: "KeyA", key: "a" }, SUB_NOTE, 0, cell, rctx); // 'a' = hex A, NOT jam C
  assert.equal(a.fields.note, 0x567a);
  assert.equal(a.jamNote, undefined, "no audition on raw hex entry");
  // 'c' is hex 0xC — shifts in, does NOT insert the fade sentinel
  cell.note = 0x0012;
  assert.equal(interpretEditKey({ code: "KeyC", key: "c" }, SUB_NOTE, 0, cell, rctx).fields.note, 0x012c);
  // non-hex keys (jam 's', sentinel 'z', backquote) are swallowed: consumed, no edit, no jam
  for (const [code, key] of [["KeyS", "s"], ["KeyZ", "z"], ["Backquote", "`"]]) {
    const r = interpretEditKey({ code, key }, SUB_NOTE, 0, cell, rctx);
    assert.ok(r && !r.fields && r.jamNote === undefined, `${key} swallowed (no jam/sentinel)`);
  }
  // Delete clears the note + instrument
  assert.deepEqual(
    interpretEditKey({ code: "Delete", key: "Delete" }, SUB_NOTE, 0, cell, rctx).fields,
    { note: 0, instrment: 0 });
});

test("non-edit keys pass through", () => {
  const cell = new TaudPlayData();
  assert.equal(interpretEditKey({ code: "KeyG", key: "g" }, SUB_INST, 0, cell, ctx), null);
  assert.equal(interpretEditKey({ code: "Semicolon", key: ";" }, SUB_NOTE, 0, cell, ctx), null);
});

// ── item 47.2/47.6: contextual bracket keys ──
test("bracket note: [ ] octave, { } semitone/step (12-TET)", () => {
  const bctx = { preset: pitchTablePresets[120], instSlots: [1, 2, 5] };
  const cell = new TaudPlayData(); cell.note = MIDDLE_C;
  // '[' (dir -1) = octave down, ']' (dir +1) = octave up
  assert.equal(interpretBracketKey(-1, false, SUB_NOTE, cell, bctx).fields.note, MIDDLE_C - 0x1000);
  assert.equal(interpretBracketKey(+1, false, SUB_NOTE, cell, bctx).fields.note, MIDDLE_C + 0x1000);
  // Shift = one 12-TET degree (semitone)
  assert.equal(interpretBracketKey(+1, true, SUB_NOTE, cell, bctx).fields.note,
    MIDDLE_C + pitchTablePresets[120].table[1]);
  // sentinels / empty note: no action
  cell.note = 0x0001;
  assert.equal(interpretBracketKey(-1, false, SUB_NOTE, cell, bctx), null);
});

test("bracket inst: steps through selectable slots ('[' prev, ']' next)", () => {
  const bctx = { instSlots: [1, 2, 5] };
  const cell = new TaudPlayData(); cell.instrment = 2;
  assert.equal(interpretBracketKey(-1, false, SUB_INST, cell, bctx).fields.instrment, 1, "'[' = prev");
  assert.equal(interpretBracketKey(+1, false, SUB_INST, cell, bctx).fields.instrment, 5, "']' = next");
  cell.instrment = 5; // top of the list
  assert.equal(interpretBracketKey(+1, false, SUB_INST, cell, bctx), null, "']' clamped at the end");
});

test("bracket vol/pan: [ ] value, { } fine (FINE selector)", () => {
  const cell = new TaudPlayData();
  cell.volume = 0x20; cell.volumeEff = 0;
  // Consistent direction: '[' decreases, ']' increases.
  assert.equal(interpretBracketKey(-1, false, SUB_VOL, cell, {}).fields.volume, 0x1f, "'[' quieter");
  assert.equal(interpretBracketKey(+1, false, SUB_VOL, cell, {}).fields.volume, 0x21, "']' louder");
  const fine = interpretBracketKey(+1, true, SUB_VOL, cell, {});
  assert.equal(fine.fields.volumeEff, 3); assert.equal(fine.fields.volume, 0x21);
  cell.pan = 0x20; cell.panEff = 0;
  assert.equal(interpretBracketKey(-1, false, SUB_PAN, cell, {}).fields.pan, 0x1f, "'[' toward L");
  assert.equal(interpretBracketKey(+1, false, SUB_PAN, cell, {}).fields.pan, 0x21, "']' toward R");
});

// ── item 42: lookahead-scroll (18% edge / 64% central band) ──
test("lookahead: cursor free in the central 64%, scrolls at the 18% edge", () => {
  // vis 20 → edge = floor(20*0.18) = 3; central band = [top+3 .. top+16].
  assert.equal(lookahead(50, 45, 20, 1000), 45, "inside band → no scroll");
  assert.equal(lookahead(47, 45, 20, 1000), 44, "top edge → scroll up to the band");
  assert.equal(lookahead(63, 45, 20, 1000), 47, "bottom edge → scroll down to the band");
  assert.equal(lookahead(2, 5, 20, 1000), 0, "clamps at 0");
  assert.equal(lookahead(70, 45, 20, 47), 47, "clamps at maxScroll");
  assert.equal(lookahead(3, 0, 0, 100), 0, "vis 0 → clamp only");
});

// ── item 86: Backspace erases like Delete on the pattern grids ──
test("Backspace clears every column, exactly as Delete does", () => {
  const mk = () => {
    const c = new TaudPlayData();
    c.note = MIDDLE_C; c.instrment = 0x11;
    c.volume = 0x20; c.volumeEff = 0;
    c.pan = 0x20; c.panEff = 0;
    c.effect = 5; c.effectArg = 0x1234;
    return c;
  };
  const rctx = { ...ctx, preset: pitchTablePresets[120] };
  // The argument digits and the note/inst/fx columns: identical to Delete.
  for (const [sub, nib] of [[SUB_NOTE, 0], [SUB_INST, 0], [SUB_INST, 1],
                            [SUB_VOL, 1], [SUB_VOL, 2], [SUB_PAN, 1], [SUB_PAN, 2],
                            [SUB_FX_OP, 0], [SUB_FX_ARG, 0], [SUB_FX_ARG, 3]]) {
    const del = interpretEditKey({ code: "Delete", key: "Delete" }, sub, nib, mk(), rctx);
    const bsp = interpretEditKey({ code: "Backspace", key: "Backspace" }, sub, nib, mk(), rctx);
    assert.deepEqual(bsp, del, `sub ${sub} nib ${nib}`);
  }
  // …including in raw-hex note mode.
  const raw = { ...rctx, rawHex: true };
  assert.deepEqual(
    interpretEditKey({ code: "Backspace", key: "Backspace" }, SUB_NOTE, 0, mk(), raw).fields,
    { note: 0, instrment: 0 });
});

// ── item 87: the vol/pan symbol cell ──
test("vol/pan columns are three positions wide: symbol + two digits", () => {
  assert.deepEqual(SUB_NIBBLES, [1, 2, 3, 3, 1, 4]);
  // char 8 = vol symbol, 9/10 its digits; 12 = pan symbol, 13/14 its digits
  assert.deepEqual(subCharPos(SUB_VOL, 0), [8, 1]);
  assert.deepEqual(subCharPos(SUB_VOL, 2), [10, 1]);
  assert.deepEqual(subCharPos(SUB_PAN, 0), [12, 1]);
  assert.deepEqual(charToSub(8), [SUB_VOL, 0]);
  assert.deepEqual(charToSub(10), [SUB_VOL, 2]);
  assert.deepEqual(charToSub(12), [SUB_PAN, 0]);
  assert.deepEqual(charToSub(14), [SUB_PAN, 2]);
  // Every position is reachable by walking the cursor, in reading order.
  const walk = SUB_POSITIONS.filter(([s]) => s === SUB_VOL || s === SUB_PAN);
  assert.deepEqual(walk, [[SUB_VOL, 0], [SUB_VOL, 1], [SUB_VOL, 2],
                          [SUB_PAN, 0], [SUB_PAN, 1], [SUB_PAN, 2]]);
  // The logical clipboard column is unchanged — the symbol travels with its value.
  assert.equal(subToCol(SUB_VOL), 2);
  assert.equal(subToCol(SUB_PAN), 3);
});

test("volPanOp/volPanArg: the engine's bit-5 fine direction reads as a symbol", () => {
  // SEL_FINE with bit 5 SET raises the value (AudioAdapter.kt:2980/3001).
  assert.equal(volPanOp(0x2a, 3), "fineUp");
  assert.equal(volPanArg(0x2a, 3), 0x0a, "argument is the magnitude alone");
  assert.equal(volPanOp(0x0a, 3), "fineDown");
  assert.equal(volPanArg(0x0a, 3), 0x0a);
  assert.equal(volPanOp(0x00, 3), "none", "$C0 is the empty-cell sentinel");
  assert.equal(volPanOp(0x30, 0), "set");
  assert.equal(volPanArg(0x30, 0), 0x30, "a set/slide argument is the full 6 bits");
  assert.equal(volPanOp(0x05, 1), "up");
  assert.equal(volPanOp(0x05, 2), "down");
  // signed round-trip
  for (const s of [-0x1f, -1, 1, 0x1f]) assert.equal(fineSigned(fineValue(s), 3), s);
  assert.equal(fineValue(0), 0, "zero delta IS the no-op sentinel");
});

test("symbol cell keys: vol ^u/vd/+=/−, pan >r/<l/+=/−, '.' set", () => {
  const cell = new TaudPlayData();
  cell.volume = 0x2a; cell.volumeEff = 0;   // set volume $2A
  cell.pan = 0x2a; cell.panEff = 0;
  const key = (k, code = "") => ({ code, key: k });
  const volOf = (k, code) => interpretEditKey(key(k, code), SUB_VOL, 0, cell, ctx);
  const panOf = (k, code) => interpretEditKey(key(k, code), SUB_PAN, 0, cell, ctx);

  // Slides keep the argument the user can see and only swap the operation.
  for (const k of ["^", "u"]) assert.deepEqual(volOf(k).fields, { volume: 0x2a, volumeEff: 1 }, k);
  for (const k of ["v", "d"]) assert.deepEqual(volOf(k).fields, { volume: 0x2a, volumeEff: 2 }, k);
  for (const k of [">", "r"]) assert.deepEqual(panOf(k).fields, { pan: 0x2a, panEff: 1 }, k);
  for (const k of ["<", "l"]) assert.deepEqual(panOf(k).fields, { pan: 0x2a, panEff: 2 }, k);
  // Shift+Period is '>' on the pan column, NOT the clear key.
  assert.deepEqual(panOf(">", "Period").fields, { pan: 0x2a, panEff: 1 });

  // Fine slides re-read the argument as a magnitude (00..1F): $2A → $0A.
  for (const k of ["+", "="]) {
    assert.deepEqual(volOf(k).fields, { volume: 0x20 | 0x0a, volumeEff: 3 }, k);
    assert.deepEqual(panOf(k).fields, { pan: 0x20 | 0x0a, panEff: 3 }, k);
  }
  assert.deepEqual(volOf("-").fields, { volume: 0x0a, volumeEff: 3 });
  assert.deepEqual(panOf("-").fields, { pan: 0x0a, panEff: 3 });

  // '.' / Delete / Backspace select "set" (they do NOT blank the column here).
  cell.volumeEff = 1;
  for (const [k, code] of [[".", "Period"], ["Delete", "Delete"], ["Backspace", "Backspace"]]) {
    assert.deepEqual(interpretEditKey(key(k, code), SUB_VOL, 0, cell, ctx).fields,
      { volume: 0x2a, volumeEff: 0 }, code);
  }
  // Every symbol key steps onto the argument's first digit.
  cell.volumeEff = 0;
  assert.ok(volOf("^").advanceNib);
});

test("symbol cell: a fine slide never carries a zero argument", () => {
  const cell = new TaudPlayData();
  cell.volume = 0; cell.volumeEff = 3;      // the $C0 empty cell
  // Selecting fine on a blank argument seeds a magnitude of 1…
  assert.deepEqual(interpretEditKey({ code: "", key: "+" }, SUB_VOL, 0, cell, ctx).fields,
    { volume: 0x21, volumeEff: 3 }, "fine up by 1");
  assert.deepEqual(interpretEditKey({ code: "", key: "-" }, SUB_VOL, 0, cell, ctx).fields,
    { volume: 0x01, volumeEff: 3 }, "fine down by 1");
  // …and "set" on an empty cell stays empty: Delete must never conjure a
  // "set volume 00" (which would silence the note) out of a blank column.
  const set = interpretEditKey({ code: "Delete", key: "Delete" }, SUB_VOL, 0, cell, ctx);
  assert.ok(set && !set.fields, "consumed, no edit");
});

test("argument digits: fine magnitude is 00..1F and zero clears the cell", () => {
  const cell = new TaudPlayData();
  cell.volume = 0x20 | 0x1f; cell.volumeEff = 3;  // fine up by $1F
  // high digit carries bit 4 only — 2..F all read as 1, keeping 00..1F
  assert.deepEqual(interpretEditKey({ code: "Digit0", key: "0" }, SUB_VOL, 1, cell, ctx).fields,
    { volume: 0x20 | 0x0f, volumeEff: 3 });
  assert.deepEqual(interpretEditKey({ code: "KeyF", key: "f" }, SUB_VOL, 1, cell, ctx).fields,
    { volume: 0x20 | 0x1f, volumeEff: 3 }, "clamped to 1");
  // low digit
  assert.deepEqual(interpretEditKey({ code: "Digit3", key: "3" }, SUB_VOL, 2, cell, ctx).fields,
    { volume: 0x20 | 0x13, volumeEff: 3 });
  // …the direction bit survives every digit edit
  cell.volume = 0x0f; // fine DOWN by $F
  assert.deepEqual(interpretEditKey({ code: "Digit2", key: "2" }, SUB_VOL, 2, cell, ctx).fields,
    { volume: 0x02, volumeEff: 3 }, "still a fine down");
  // typing the magnitude down to zero clears the cell like $C0 would
  cell.volume = 0x20 | 0x10;
  assert.deepEqual(interpretEditKey({ code: "Digit0", key: "0" }, SUB_VOL, 1, cell, ctx).fields,
    { volume: 0, volumeEff: 3 }, "fine slide of zero = the no-op sentinel");
  // a set/slide argument keeps its full 6-bit range
  cell.volume = 0x00; cell.volumeEff = 0;
  assert.deepEqual(interpretEditKey({ code: "Digit3", key: "3" }, SUB_VOL, 1, cell, ctx).fields,
    { volume: 0x30, volumeEff: 0 });
});

test("volPanStep (wheel): fine steps its signed delta, never through zero", () => {
  const cell = new TaudPlayData();
  cell.volume = 0x20 | 0x05; cell.volumeEff = 3;    // fine up 5
  assert.deepEqual(volPanStep(false, cell, +1), { volume: 0x26, volumeEff: 3 });
  assert.deepEqual(volPanStep(false, cell, -1), { volume: 0x24, volumeEff: 3 });
  cell.volume = 0x20 | 0x01;                        // fine up 1 — one step from zero
  assert.equal(volPanStep(false, cell, -1), null, "stops rather than flipping direction");
  cell.volume = 0x01;                               // fine down 1
  assert.equal(volPanStep(false, cell, +1), null);
  assert.deepEqual(volPanStep(false, cell, -1), { volume: 0x02, volumeEff: 3 }, "deeper drop");
  // plain values still step ±1 and clamp
  cell.volume = 0x3f; cell.volumeEff = 0;
  assert.equal(volPanStep(false, cell, +1), null, "clamped at 3F");
  assert.deepEqual(volPanStep(false, cell, -1), { volume: 0x3e, volumeEff: 0 });
  cell.pan = 0x10; cell.panEff = 2;
  assert.deepEqual(volPanStep(true, cell, +1), { pan: 0x11, panEff: 2 });
});

test("volToStr/panToStr: symbol + argument, fine shows its magnitude", () => {
  assert.equal(volToStr(0, 3), "···", "empty cell");
  assert.equal(volToStr(0x3f, 0), " 3F", "set = blank symbol");
  assert.equal(volToStr(0x0a, 1), "˄0A", "vol slide up tick");
  assert.equal(volToStr(0x0a, 2), "˅0A", "vol slide down tick");
  assert.equal(volToStr(0x20 | 0x0a, 3), "+0A", "fine up");
  assert.equal(volToStr(0x0a, 3), "−0A", "fine down");
  assert.equal(panToStr(0x20, 0), " 20", "pan set = blank symbol");
  assert.equal(panToStr(0x03, 1), "˃03", "pan slide right tick");
  assert.equal(panToStr(0x03, 2), "˂03", "pan slide left tick");
  assert.equal(panToStr(0x20 | 0x03, 3), "+03");
  assert.equal(panToStr(0x03, 3), "−03");
});
