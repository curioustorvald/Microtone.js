// New-instrument-from-sample import — planSampleImport (bankmerge.js) through
// the invertible importBankOp, plus the \uHHHH display-name helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { planSampleImport, buildFreshInstRecord } from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { escapeNonAscii, unescapeName } from "../../src/ui/names.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

const enc = new TextEncoder();
const mkPcm = (n) => {
  const pcm = new Uint8Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 128 + Math.round(100 * Math.sin((i / n) * 20 * Math.PI));
  return pcm;
};

test("buildFreshInstRecord: sane defaults + non-zero vol-env terminator", () => {
  const rec = buildFreshInstRecord({ samplePtr: 0x1234, sampleLength: 100, samplingRate: 32000 });
  assert.equal(rec[0] | (rec[1] << 8) | (rec[2] << 16), 0x1234);
  assert.equal(rec[4] | (rec[5] << 8), 100);
  assert.equal(rec[6] | (rec[7] << 8), 32000);
  assert.equal(rec[14], 0, "loop off, no percussion");
  // the M8 gotcha: a value-0 env terminator triggers the Schism cut rule
  assert.equal(rec[21], 0x3f, "vol-env terminator value 0x3F");
  assert.equal(rec[171], 0xff, "inst global volume");
  assert.equal(rec[177], 0x80, "default pan centre");
  assert.equal(rec[182], 0xff, "filter cutoff off");
});

test("planSampleImport + importBankOp: census/record/names land; undo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const usedBefore = new Set(doc.usedInstrumentSlots());
  const censusBefore = doc.sampleList().length;

  const pcm = mkPcm(500);
  const name = escapeNonAscii("Kalimba 카림바");
  const plan = planSampleImport(doc, { nameBytes: enc.encode(name), pcm, rate: 32000 });
  assert.ok(!plan.error, plan.error);
  const slot = plan.insts[0].destSlot;
  assert.ok(slot >= 1 && slot <= 255 && !usedBefore.has(slot), "lowest free note-addressable slot");
  assert.equal(plan.newSampleBytes, 500);

  const dirty = undo.apply(importBankOp(plan));
  assert.deepEqual(dirty, [{ kind: "bank" }]);

  const inst = doc.instruments[slot];
  assert.equal(inst.sampleLength, 500);
  assert.equal(inst.samplingRate, 32000);
  assert.deepEqual(
    [...doc.sampleBin.subarray(inst.samplePtr, inst.samplePtr + 500)], [...pcm],
    "pool bytes are the PCM");

  const census = doc.sampleList();
  assert.equal(census.length, censusBefore + 1);
  const entry = census.find((e) => e.ptr === inst.samplePtr && e.len === 500);
  assert.ok(entry, "census sees the new sample");
  assert.deepEqual(entry.users, [slot]);
  assert.equal(doc.instrumentName(slot), name, "INam spliced");
  assert.equal(doc.sampleName(entry.index), name, "SNam by census order");
  assert.equal(unescapeName(doc.instrumentName(slot)), "Kalimba 카림바", "display decodes");

  // round-trips through the container
  const re = new Document(parseTaud(doc.toBytes()));
  assert.equal(re.instruments[slot].sampleLength, 500);
  assert.equal(re.instrumentName(slot), name);

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});

test("planSampleImport: content dedupe reuses the pool span and keeps its name", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const s0 = doc.sampleList()[0];
  const existing = Uint8Array.from(doc.sampleBin.subarray(s0.ptr, s0.ptr + s0.len));

  const plan = planSampleImport(doc, { nameBytes: enc.encode("dupe"), pcm: existing, rate: 12345 });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.samples.length, 0, "no new pool write");
  assert.equal(plan.dedupedSamples, 1);

  undo.apply(importBankOp(plan));
  const slot = plan.insts[0].destSlot;
  assert.equal(doc.instruments[slot].samplePtr, s0.ptr, "record points at the existing span");
  const entry = doc.sampleList().find((e) => e.ptr === s0.ptr && e.len === s0.len);
  assert.ok(entry.users.includes(slot));
  assert.equal(doc.sampleName(entry.index), s0.name, "existing sample keeps its name");
});

test("planSampleImport: rejects empty / oversized PCM", () => {
  const doc = loadWhen();
  assert.ok(planSampleImport(doc, { pcm: new Uint8Array(0), rate: 32000 }).error);
  assert.ok(planSampleImport(doc, { pcm: new Uint8Array(0x10000), rate: 32000 }).error);
});

test("escapeNonAscii/unescapeName: inverse pair, idempotent escape", () => {
  const raw = "Über 곡 – ✓";
  const escaped = escapeNonAscii(raw);
  assert.ok(!/[^\x00-\x7f]/.test(escaped), "escaped output is pure ASCII");
  assert.equal(escapeNonAscii(escaped), escaped, "idempotent");
  assert.equal(unescapeName(escaped), raw, "round-trips");
  assert.equal(unescapeName("plain ascii"), "plain ascii");
  assert.equal(unescapeName("\\u0152uvre"), "Œuvre", "uppercase hex");
  assert.equal(unescapeName("\\u015fx"), "şx", "lowercase hex");
});
