// Name-table edits for instruments (INam) and patterns (pNam). Mirrors the
// SNam rename coverage in sampleedit.test.js: byte-level splice keeps siblings
// verbatim, setSectionOp is invertible byte-exact, and a FRESH pNam section
// survives the toBytes → parseTaud round-trip (WHEN has no pNam to start).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { setSectionOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

test("buildInstrumentNames splices INam by slot; siblings verbatim; op invertible", () => {
  const doc = loadWhen();
  const slots = doc.usedInstrumentSlots();
  const slot = slots[2];
  const sibling = slots[1];
  const siblingName = doc.instrumentName(sibling); // must stay byte-identical
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  undo.apply(setSectionOp("INam", doc.buildInstrumentNames(slot, "Lead Synth")));
  assert.equal(doc.instrumentName(slot), "Lead Synth", "renamed entry");
  assert.equal(doc.instrumentName(sibling), siblingName, "sibling untouched");
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before), "bytes changed");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("buildPatternNames creates a fresh pNam section that round-trips", () => {
  const doc = loadWhen();
  assert.equal(doc.patternName(0), "", "starts unnamed (no pNam)");
  assert.ok(!doc.projSections.some((s) => s.fourcc === "pNam"), "no pNam yet");
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  // Two names at non-adjacent indices — the gap between must be empty entries.
  undo.apply(setSectionOp("pNam", doc.buildPatternNames(0, "Intro")));
  undo.apply(setSectionOp("pNam", doc.buildPatternNames(3, "Chorus")));
  assert.equal(doc.patternName(0), "Intro");
  assert.equal(doc.patternName(3), "Chorus");
  assert.equal(doc.patternName(1), "", "gap entry empty");

  // The new section survives serialisation and re-parse.
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.patternName(0), "Intro", "pNam persisted through write/read");
  assert.equal(reloaded.patternName(3), "Chorus");

  undo.undo();
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo removes the fresh section byte-exact");
});

test("name builders \\uHHHH-escape convention passes bytes through verbatim", () => {
  const doc = loadWhen();
  // The frontend escapes non-ASCII before storing; the builder is byte-level.
  const escaped = "caf\\u00E9";
  const payload = doc.buildInstrumentNames(doc.usedInstrumentSlots()[0], escaped);
  doc.setSection("INam", payload);
  assert.equal(doc.instrumentName(doc.usedInstrumentSlots()[0]), escaped, "stored verbatim");
});
