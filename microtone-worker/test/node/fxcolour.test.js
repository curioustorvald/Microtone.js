// Effect-column argument field map (item 120) — which of a command's four
// argument nibbles belong to which FIELD, so the grids can paint each field in
// its own shade of amber. Layouts are transcribed from TAUD_NOTE_EFFECTS.md;
// this pins the ones a reader would get wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fxArgFields } from "../../src/ui/notenames.js";

const OP = 0, RSVD = -1;

/** fxArgFields as a layout string, for readable assertions. */
const map = (effect, arg) => fxArgFields(effect, arg)
  .map((f) => (f === OP ? "o" : f === RSVD ? "." : String(f))).join("");

// Base-36 opcode letter → effect number, the same mapping the cell stores.
const fx = (letter) => parseInt(letter, 36);

test("one-value commands read the whole argument as a single field", () => {
  for (const letter of ["b", "c", "g", "o"]) assert.equal(map(fx(letter), 0x1234), "1111");
  // Filter cutoff / resonance: 16-bit in SF2 mode, high byte in IT mode —
  // either way ONE value, never a two-field split.
  assert.equal(map(5, 0x1234), "1111");
  assert.equal(map(6, 0xffff), "1111");
});

test("two-byte commands split down the middle", () => {
  for (const letter of ["h", "i", "j", "r", "u", "x", "y"]) {
    assert.equal(map(fx(letter), 0x2277), "1122");
  }
  assert.equal(map(4, 0x2040), "1122"); // 4 $eeaa — elevation, azimuth
  assert.equal(map(7, 0x1003), "1122"); // 7 $xxyy — ditto rows, repeats
});

test("nibble-pair slides mark their reserved low byte", () => {
  for (const letter of ["d", "k", "l", "n", "p", "q", "w"]) {
    assert.equal(map(fx(letter), 0x4000), "12..");
  }
  // Byte-argument commands keep the byte together over the same reserved half.
  for (const letter of ["a", "m", "v"]) assert.equal(map(fx(letter), 0x2000), "11..");
  assert.equal(map(1, 0x0100), "11.."); // 1 $xx00 — global behaviour flags
});

test("bitcrusher and overdrive split by their documented nibble roles", () => {
  assert.equal(map(8, 0x1234), "1233"); // 8 $xyzz — clip, depth, skip
  assert.equal(map(9, 0x10ff), "1.22"); // 9 $x0zz — clip, (reserved), amp
});

test("E / F switch layout on the fine-slide marker nibble", () => {
  assert.equal(map(fx("e"), 0x0155), "1111"); // coarse: one 16-bit value
  assert.equal(map(fx("f"), 0x0155), "1111");
  assert.equal(map(fx("e"), 0xf155), "1222"); // fine: $F marker + 12-bit magnitude
  assert.equal(map(fx("f"), 0xffff), "1222");
  assert.equal(map(fx("e"), 0xefff), "1111"); // $EFFF is still coarse
});

test("T picks one of three layouts from its high byte", () => {
  assert.equal(map(fx("t"), 0x6400), "11.."); // set tempo: byte + reserved
  assert.equal(map(fx("t"), 0xff64), "1122"); // extended set: $FF marker + byte
  assert.equal(map(fx("t"), 0x0013), "..12"); // slide: direction nibble + amount
});

test("S is multiplexed — the sub-command nibble takes the OPCODE's ink", () => {
  // 120.3: "S" and its selector are one two-character command, so they share
  // one colour; only what follows is argument.
  assert.equal(map(fx("s"), 0x3100), "o1.."); // S $3x00 vibrato waveform
  assert.equal(map(fx("s"), 0xc400), "o1.."); // S $Cx00 note cut
  assert.equal(map(fx("s"), 0x8040), "o111"); // S $80xx pan — 9-bit angle, one field
  assert.equal(map(fx("s"), 0xd123), "o123"); // S $Dxny delay, action, action delay
  assert.equal(map(fx("s"), 0xf0a0), "o111"); // S $F0xx invert loop — 12-bit speed
  assert.equal(map(fx("s"), 0xa000), "o111"); // undefined sub-command: one field
});

test("Z is multiplexed the same way", () => {
  assert.equal(map(fx("z"), 0x0080), "o111"); // Z $0xxx — selector + 12-bit speed
});

test("every effect number yields four fields, and the last is never the opcode's", () => {
  // 120.2: the opcode's colour and the LAST argument's colour must differ, so
  // no layout may end on 'o' (or on a reserved nibble, which would leave the
  // cell ending in dim ink).
  for (let effect = 0; effect <= 35; effect++) {
    for (const arg of [0x0000, 0x1234, 0xf155, 0xff64, 0x8040, 0xffff]) {
      const fields = fxArgFields(effect, arg);
      assert.equal(fields.length, 4, `effect ${effect} arg ${arg}`);
      assert.ok(fields.some((f) => f > 0), `effect ${effect} arg ${arg} has no argument field`);
      const last = fields.filter((f) => f > 0).pop();
      assert.ok(last >= 1 && last <= 3, `effect ${effect} arg ${arg} last field ${last}`);
    }
  }
});
