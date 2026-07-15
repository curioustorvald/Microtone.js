// Notation Maker (item 61) — Scala .scl parsing, the nota section codec,
// Taud-charset symbol mapping, preset bridging, and the Document integration
// (custom notation values 65535..65520 resolving through the "nota" section).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseScl, sclToDef, centsToUnits, buildNotaPayload, parseNotaPayload,
  buildTaudnot, parseTaudnot, symTokenToTaud, taudToSymToken, autoAssignSyms,
  defToPreset, validateDef, notationValueForSlot, slotForNotationValue,
} from "../../src/doc/notation.js";
import { pitchTablePresets, presetForNotation, resolveNoteSymbol, stepNoteInTable, ANCHOR_NOTE }
  from "../../src/ui/pitchtables.js";
import { setSectionOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

// The two example scales from the item-61 spec.
const BP_SCL = `! bohlen-p_et.scl
!
13-tone equal division of 3/1. Bohlen-Pierce equal approximation
 13
!
 146.30423
 292.60846
 438.91269
 585.21692
 731.52115
 877.82539
 1024.12962
 1170.43385
 1316.73808
 1463.04231
 1609.34654
 1755.65077
 3/1`;

const MADA_SCL = `! madagascar19.scl
Madagascar[19] (19&53&58) hobbit in 313et tuning
19
!
65.17572
138.01917
184.02556
249.20128
314.37700
387.22045
452.39617
498.40256
563.57827
636.42173
701.59744
747.60383
812.77955
885.62300
950.79872
1015.97444
1061.98083
1134.82428
1200.00000
!`;

test("parseScl + sclToDef: Bohlen-Pierce matches the shipped 35130 preset exactly", () => {
  const def = sclToDef(parseScl(BP_SCL), 0);
  const shipped = pitchTablePresets[35130];
  assert.equal(def.interval, 0x195c, "3/1 tritave in 4096-TET");
  assert.deepEqual(def.table, shipped.table, "13 degrees identical to the preset");
  assert.deepEqual(validateDef(def), []);
  assert.equal(def.name, "13-tone equal division of 3/1. Bohlen-Pierce equal approximation");
});

test("parseScl + sclToDef: madagascar19 (cents lines, octave period)", () => {
  const def = sclToDef(parseScl(MADA_SCL), 5);
  assert.equal(def.interval, 0x1000);
  assert.equal(def.table.length, 19);
  assert.equal(def.table[0], 0, "implicit 1/1 is degree 0");
  assert.equal(def.table[1], centsToUnits(65.17572));
  assert.deepEqual(validateDef(def), []);
  assert.equal(def.syms.length, 19, "auto-named");
});

test("parseScl: ratios, bare integers and errors", () => {
  const d = parseScl("!c\nname\n3\n 9/8\n 5/4 a comment\n 2");
  assert.equal(Math.round(d.cents[0]), 204, "9/8 = 203.9c");
  assert.equal(Math.round(d.cents[1]), 386, "5/4 = 386.3c");
  assert.equal(d.cents[2], 1200, "bare 2 = 2/1");
  assert.throws(() => parseScl("only one line"), /header/);
  assert.throws(() => parseScl("name\nnot-a-number\n"), /count/);
  assert.throws(() => parseScl("name\n2\n100.0"), /missing pitch/);
  assert.throws(() => parseScl("name\n1\n 3/0"), /ratio/);
  assert.throws(() => parseScl("name\n0\n"), /empty/);
});

test("Taud charset: every tick × letter × accidental round-trips; CJK + escapes", () => {
  const ticks = [" ", ".", "u", "d", "U", "D"];
  const accs = ["-", "#", "b", "t", "p", "x", "B", "3", "T", "4"];
  for (const tk of ticks) for (const L of ["A", "J", "Z"]) for (const a of accs) {
    const tok = tk + L + a;
    assert.equal(taudToSymToken(symTokenToTaud(tok)), tok, `token ${JSON.stringify(tok)}`);
  }
  for (const c of "黃大太夶姑仲蕤林夷南無應") {
    assert.equal(taudToSymToken(symTokenToTaud(c)), c, "Shi'er lü pair");
  }
  assert.equal(taudToSymToken(symTokenToTaud("宮")), "宮", "arbitrary unicode via 0x84 escape");
  // Kite tokens use the compact one-byte accidentals — like taut's own strings.
  assert.deepEqual(symTokenToTaud(".C#"), [0xf9, 0x43, 0x98]);
  // Normal tokens use two-cell accidentals with no leading space.
  assert.deepEqual(symTokenToTaud(" C-"), [0x43, 0xa2, 0xa3]);
  assert.equal(taudToSymToken([0x01, 0x02]), null, "garbage → null");
});

test("nota payload codec: parse(build(defs)) round-trips and rebuilds byte-exact", () => {
  const d1 = sclToDef(parseScl(BP_SCL), 0);
  const d2 = sclToDef(parseScl(MADA_SCL), 3);
  d2.syms[4] = "黃"; // a CJK token survives the charset
  const payload = buildNotaPayload([d1, d2]);
  const back = parseNotaPayload(payload);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map((d) => [d.slot, d.interval, d.table, d.syms, d.name]),
    [d1, d2].map((d) => [d.slot, d.interval, d.table, d.syms, d.name]));
  assert.deepEqual([...buildNotaPayload(back)], [...payload], "byte-exact rebuild");
});

test(".taudnot wrapper: magic + version guard", () => {
  const def = sclToDef(parseScl(BP_SCL), 2);
  const file = buildTaudnot([def]);
  assert.deepEqual([...file.subarray(0, 8)],
    [0x1e, 0x54, 0x61, 0x75, 0x64, 0x6e, 0x6f, 0x74], "\\x1ETaudnot magic");
  assert.equal(file[8], 0x61, "version 'a'");
  const back = parseTaudnot(file);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].table, def.table);
  assert.equal(parseTaudnot(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseTaudnot(readFileSync(corpusDir + "WHEN.taud").subarray(0, 64)), null);
});

test("defToPreset bridges into the pitch-table machinery (glyphs + stepping)", () => {
  const def = sclToDef(parseScl(BP_SCL), 0);
  const preset = defToPreset(def);
  assert.equal(preset.index, 0xffff, "slot 0 = internal 65535");
  assert.equal(slotForNotationValue(preset.index), 0);
  assert.equal(notationValueForSlot(15), 0xfff0);
  // degree 1 of the tritave resolves + steps like any shipped preset
  const note = ANCHOR_NOTE + def.table[1];
  const sym = resolveNoteSymbol(note, preset);
  assert.ok(sym && !sym.offGrid, "on-grid degree resolves");
  assert.equal(stepNoteInTable(note, preset, -1), ANCHOR_NOTE, "steps down to the root");
  const top = ANCHOR_NOTE + def.table[def.table.length - 1];
  assert.equal(stepNoteInTable(top, preset, +1), ANCHOR_NOTE + def.interval,
    "wraps into the next TRITAVE period");
  // interval-less defs degrade to a Raw-style preset (hex display)
  const rawish = defToPreset({ slot: 1, interval: 0, name: "", table: [], syms: [] });
  assert.equal(rawish.table.length, 0);
  assert.equal(resolveNoteSymbol(0x5000, rawish), null, "renders as hex");
});

test("autoAssignSyms: nearest quarter-tone and letter-sequence modes", () => {
  const eq24 = { table: Array.from({ length: 24 }, (_, i) => Math.round((i * 0x1000) / 24)), interval: 0x1000 };
  assert.deepEqual(autoAssignSyms(eq24, "nearest").slice(0, 4), [" C-", " Ct", " C#", " Dp"]);
  const big = { table: Array.from({ length: 30 }, (_, i) => i * 100), interval: 0x1000 };
  const seq = autoAssignSyms(big, "sequence");
  assert.equal(seq[0], " A-");
  assert.equal(seq[25], " Z-");
  assert.equal(seq[26], ".A-", "27th degree cycles with a tick mark");
});

test("validateDef issue codes", () => {
  assert.deepEqual(validateDef({ interval: 0x1000, table: [] }), ["count"]);
  assert.deepEqual(validateDef({ interval: 0x1000, table: [5, 10] }), ["zeroFirst"]);
  assert.deepEqual(validateDef({ interval: 0x1000, table: [0, 20, 10] }), ["ascending"]);
  assert.deepEqual(validateDef({ interval: 0x800, table: [0, 0x900] }), ["interval"]);
  assert.ok(validateDef({ interval: 0x1_0000, table: [0] }).includes("range"));
});

test("Document: nota section via setSectionOp — resolve, undo byte-exact, reload", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  const def = sclToDef(parseScl(BP_SCL), 0);
  def.name = "BP test";
  undo.apply(setSectionOp("nota", buildNotaPayload([def])));

  assert.equal(doc.customNotations().length, 1, "cache follows the section");
  assert.equal(doc.customNotations()[0].name, "BP test");
  const preset = doc.customPreset(0xffff);
  assert.ok(preset && preset.interval === 0x195c, "customPreset resolves slot 0");
  assert.equal(presetForNotation(0xffff, doc).name, "BP test", "doc-aware resolution");
  assert.equal(presetForNotation(0xffff).index, 120, "docless call falls back to 12-TET");
  assert.equal(presetForNotation(0xfff5, doc).index, 120, "undefined slot falls back");

  // survives a full write → parse round-trip
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.customPreset(0xffff)?.name, "BP test", "nota persisted");
  assert.deepEqual(reloaded.customPreset(0xffff).table, defToPreset(def).table);

  undo.undo();
  assert.equal(doc.customNotations().length, 0, "cache invalidated by the swap");
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.equal(doc.customPreset(0xffff)?.name, "BP test", "redo restores");
});
