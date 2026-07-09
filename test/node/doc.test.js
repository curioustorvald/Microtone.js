import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { setCellOp, setCueWordOp, setSongScalarOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { DocSync } from "../../src/doc/sync.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const whenBytes = await readFile(corpusDir + "WHEN.taud");

test("Document round-trips through toBytes", () => {
  const parsed = parseTaud(whenBytes);
  const doc = new Document(parsed);
  const reparsed = parseTaud(doc.toBytes());
  assert.equal(reparsed.songs.length, parsed.songs.length);
  for (let s = 0; s < parsed.songs.length; s++) {
    const a = parsed.songs[s];
    const b = reparsed.songs[s];
    assert.equal(b.patterns.length, a.patterns.length, `song${s} numPats`);
    for (let p = 0; p < a.patterns.length; p++) {
      assert.ok(Buffer.from(b.patterns[p]).equals(Buffer.from(a.patterns[p])), `song${s} pat${p}`);
    }
    for (let c = 0; c < a.cues.length; c++) {
      assert.deepEqual(Array.from(b.cues[c]), Array.from(a.cues[c]), `song${s} cue${c}`);
    }
    assert.equal(b.bpm, a.bpm);
    assert.equal(b.tickRate, a.tickRate);
  }
  // project sections preserved verbatim
  assert.equal(reparsed.projSections.length, parsed.projSections.length);
});

test("songMap covers sequential cues with row limits", () => {
  const doc = new Document(parseTaud(whenBytes));
  const map = doc.songs[0].songMap();
  assert.ok(map.entries.length >= 1);
  assert.equal(map.entries[0].startRow, 0);
  let acc = 0;
  for (const e of map.entries) {
    assert.equal(e.startRow, acc);
    assert.ok(e.rowLimit >= 1 && e.rowLimit <= 64);
    acc += e.rowLimit;
  }
  assert.equal(map.totalRows, acc);
});

test("setCellOp apply → invert restores the cell", () => {
  const doc = new Document(parseTaud(whenBytes));
  const cell = doc.songs[0].patterns[0][0];
  const before = { note: cell.note, instrment: cell.instrment, volume: cell.volume };
  const op = setCellOp(0, 0, 0, { note: 0x5000, instrment: 3, volume: 40 });
  const inverse = op.apply(doc);
  assert.equal(cell.note, 0x5000);
  assert.equal(cell.instrment, 3);
  inverse.apply(doc);
  assert.equal(cell.note, before.note);
  assert.equal(cell.instrment, before.instrment);
  assert.equal(cell.volume, before.volume);
});

test("UndoStack undo/redo round-trip with coalescing", () => {
  const doc = new Document(parseTaud(whenBytes));
  const s = doc.songs[0];
  const undo = new UndoStack(doc);

  const bpm0 = s.bpm;
  // A "slider drag": three scalar writes sharing one gesture id → one undo entry.
  undo.apply(setSongScalarOp(0, "bpm", 200, "drag1"));
  undo.apply(setSongScalarOp(0, "bpm", 210, "drag1"));
  undo.apply(setSongScalarOp(0, "bpm", 220, "drag1"));
  assert.equal(s.bpm, 220);
  assert.equal(undo.undoStack.length, 1);

  // A separate edit.
  undo.apply(setCueWordOp(0, 0, 0, 0x7fff));
  assert.equal(undo.undoStack.length, 2);

  undo.undo(); // cue word back
  undo.undo(); // whole drag back
  assert.equal(s.bpm, bpm0);
  assert.ok(!undo.canUndo());

  undo.redo();
  assert.equal(s.bpm, 220);
  undo.redo();
  assert.ok(!undo.canRedo());
});

test("DocSync: cues eager, patterns lazy until flush, scalars immediate", () => {
  const doc = new Document(parseTaud(whenBytes));
  const calls = [];
  const audioMock = {
    uploadCue: (idx) => calls.push(`cue:${idx}`),
    uploadPattern: (slot) => calls.push(`pat:${slot}`),
    setBPM: (_ph, bpm) => calls.push(`bpm:${bpm}`),
    setTickRate: () => calls.push("tick"),
    setSongGlobalVolume: () => calls.push("gv"),
    setSongMixingVolume: () => calls.push("mv"),
    setTrackerMixerFlags: () => calls.push("flags"),
  };
  const sync = new DocSync(audioMock, doc, 0);
  const undo = new UndoStack(doc, (dirty) => sync.onDirty(dirty));

  undo.apply(setCellOp(0, 5, 0, { note: 0x5000 }));
  undo.apply(setCellOp(0, 7, 1, { note: 0x5100 }));
  assert.deepEqual(calls, [], "pattern edits must not upload eagerly");

  undo.apply(setCueWordOp(0, 3, 2, 0x0010));
  assert.deepEqual(calls, ["cue:3"], "cue edits upload eagerly");

  undo.apply(setSongScalarOp(0, "bpm", 150));
  assert.deepEqual(calls, ["cue:3", "bpm:150"]);

  sync.flushPatterns();
  assert.deepEqual([...calls].sort(), ["bpm:150", "cue:3", "pat:5", "pat:7"].sort());
  sync.flushPatterns();
  assert.equal(calls.filter((c) => c.startsWith("pat:")).length, 2, "flush is once");
});
