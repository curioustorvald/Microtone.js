// Project cleanup / renumber ops (item 60): pure pattern planners + the
// invertible remapPatternsOp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  referencedPatterns, planCleanupPatterns, planRenumberPatterns,
  applyPatternOrder, encodeNameTable, usedInstrumentSlots,
} from "../../src/doc/cleanup.js";
import { remapPatternsOp, cleanupBankOp } from "../../src/doc/ops.js";
import { planBankCleanup } from "../../src/doc/cleanup.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

// A tiny synthetic song: patterns 0..3, one cue that plays pattern 2 (ch0) and
// pattern 0 (ch2); patterns 1 and 3 are unreferenced. An empty slot is 0x7FFF.
function synthSong() {
  const mkPat = (mark) => { const rows = new Array(64).fill(null).map(() => ({ mark: -1 })); rows[0] = { mark }; return rows; };
  const E = 0x7fff;
  return {
    patterns: [mkPat(0xa), mkPat(0xb), mkPat(0xc), mkPat(0xd)],
    cues: [
      Uint16Array.from([2 | 0x8000, E, 0, E]),  // ch0 → pat 2 (with an instruction sign bit), ch2 → pat 0
      Uint16Array.from([2, E, E, E]),            // ch0 → pat 2 again
    ],
  };
}

test("referencedPatterns: first-appearance order, empties skipped", () => {
  assert.deepEqual(referencedPatterns(synthSong()), [2, 0]);
});

test("planCleanupPatterns: only referenced patterns, ascending", () => {
  assert.deepEqual(planCleanupPatterns(synthSong()), [0, 2]);
});

test("planRenumberPatterns: referenced first (play order), then extras", () => {
  // referenced 2,0 (appearance) then unreferenced-materialised 1,3
  assert.deepEqual(planRenumberPatterns(synthSong()), [2, 0, 1, 3]);
});

test("applyPatternOrder: rewrites cue refs, keeps the instruction sign bit", () => {
  const song = synthSong();
  const order = planCleanupPatterns(song); // [0, 2] → new indices 0→0, 2→1
  const { patterns, cues } = applyPatternOrder(song, order, []);
  assert.equal(patterns.length, 2);
  assert.equal(patterns[0][0].mark, 0xa); // old pattern 0
  assert.equal(patterns[1][0].mark, 0xc); // old pattern 2
  // cue 0: ch0 old pat 2 → new 1 (sign bit kept), ch2 old pat 0 → new 0
  assert.equal(cues[0][0] & 0x7fff, 1);
  assert.equal(cues[0][0] & 0x8000, 0x8000, "instruction sign bit preserved");
  assert.equal(cues[0][2] & 0x7fff, 0);
  assert.equal(cues[0][1], 0x7fff, "empty slot untouched");
});

test("encodeNameTable round-trips through the 0x1E split", () => {
  const payload = encodeNameTable(["intro", "", "chorus"]);
  const doc = loadWhen();
  doc.setSection("pNam", payload);
  assert.deepEqual(doc._nameTable("pNam").slice(0, 3), ["intro", "", "chorus"]);
  assert.equal(encodeNameTable([]), null);
});

test("remapPatternsOp on WHEN: cleanup preserves what each cue plays; undo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const song = doc.songs[0];

  // Snapshot the bytes each (cue,ch) plays.
  const playBytes = () => {
    const out = [];
    for (const words of doc.songs[0].cues) {
      for (const w of words) {
        const pat = w & 0x7fff;
        if (pat !== 0x7fff) out.push(Buffer.from(doc.patternBytes(0, pat)).toString("hex"));
      }
    }
    return out;
  };
  const playedBefore = playBytes();

  const order = planCleanupPatterns(song);
  const plan = applyPatternOrder(song, order, doc._nameTable("pNam"));
  const undo = new UndoStack(doc);
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, encodeNameTable(plan.pNam)));

  assert.equal(doc.songs[0].patterns.length, order.length, "pattern count = referenced set");
  assert.deepEqual(playBytes(), playedBefore, "every cue plays the same content after remap");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("usedInstrumentSlots: pattern cells + meta-layer closure", () => {
  // inst 5 used by a cell; meta 5 has layer child 200 (also a used slot)
  const song = { patterns: [[{ instrment: 5 }, ...new Array(63).fill({ instrment: 0 })]], cues: [] };
  const allUsed = new Set([5, 200, 99]);
  const instAt = (s) => (s === 5 ? { metaLayers: [{ instIdx: 200 }] } : null);
  const used = usedInstrumentSlots(song, allUsed, instAt);
  assert.ok(used.has(5) && used.has(200), "cell inst + its meta child are used");
  assert.ok(!used.has(99), "unreferenced slot is not used");
});

test("planBankCleanup + cleanupBankOp on WHEN: removes unused insts; survivors intact; undo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());

  // The instruments patterns actually reference must survive verbatim.
  const usedInPatterns = new Set();
  for (const song of doc.songs) for (const p of song.patterns) if (p) {
    for (const c of p) if (c.instrment) usedInPatterns.add(c.instrment & 0xff);
  }
  const survivorRecords = new Map();
  for (const s of usedInPatterns) survivorRecords.set(s, Buffer.from(doc.instRecordBytes(s)));

  const plan = planBankCleanup(doc);
  assert.ok(plan.removedInstruments >= 1, "WHEN has ≥1 unused instrument to remove");

  const undo = new UndoStack(doc);
  undo.apply(cleanupBankOp(plan));

  for (const [s, rec] of survivorRecords) {
    assert.ok(Buffer.from(doc.instRecordBytes(s)).equals(rec), `used inst $${s.toString(16)} intact`);
  }
  assert.ok(!Buffer.from(doc.toBytes()).equals(before), "cleanup changed the file");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});
