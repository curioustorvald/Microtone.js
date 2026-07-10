// Bank merge (instrument import) — planImport / importBankOp against real
// corpus sources merged into a synthetic empty project (the New Project
// wizard's parsed shape).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud, parseIxmpSection } from "../../src/format/taud-parse.js";
import { SAMPLEINST_SIZE, SAMPLEBIN_SIZE } from "../../src/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp } from "../../src/doc/ops.js";
import {
  planImport, bankInventory, splitNameTable, joinNameTable, buildIxmpSection,
} from "../../src/doc/bankmerge.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const when = new Document(parseTaud(await readFile(corpusDir + "WHEN.taud")));
const e1m1 = new Document(parseTaud(await readFile(corpusDir + "M_E1M1.taud")));

/** Empty 32-channel project (the New Project wizard's parsed shape). */
function emptyProject({ image = null, projSections = [] } = {}) {
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  return new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: image ?? new Uint8Array(SAMPLEINST_SIZE),
    songs: [{
      numVoices: 32, bpm: 125, tickRate: 6, tuningBaseNote: 0x4500,
      tuningFreq: 440, globalFlags: 0, globalVolume: 128, mixingVolume: 48,
      patterns: [emptyPat], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections, ixmp: [],
    meta: { projectName: "test", songMeta: {} },
  });
}

test("name table helpers round-trip", () => {
  const payload = Uint8Array.from([0x61, 0x1e, 0x1e, 0x62, 0x63]); // "a", "", "bc"
  const parts = splitNameTable(payload);
  assert.equal(parts.length, 3);
  assert.deepEqual([...parts[2]], [0x62, 0x63]);
  assert.deepEqual([...joinNameTable(parts)], [...payload]);
  // trailing empties trim
  assert.deepEqual([...joinNameTable([...parts, new Uint8Array(0)])], [...payload]);
});

test("basic import: record verbatim except sample pointer; bytes land in pool", () => {
  const dest = emptyProject();
  const srcSlot = when.usedInstrumentSlots().find(
    (s) => !when.instruments[s].isMeta && when.instruments[s].sampleLength > 0);
  const plan = planImport(dest, when, [srcSlot]);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.insts.length, 1);
  const it = plan.insts[0];
  assert.equal(it.destSlot, 1); // first free note-addressable slot

  importBankOp(plan).apply(dest);

  const srcRec = when.instRecordBytes(srcSlot);
  const dstRec = dest.instRecordBytes(1);
  for (let i = 4; i < 256; i++) assert.equal(dstRec[i], srcRec[i], `record byte ${i}`);

  const inst = dest.instruments[1];
  const src = when.instruments[srcSlot];
  assert.equal(inst.sampleLength, src.sampleLength);
  assert.ok(Buffer.from(dest.sampleBin.subarray(inst.samplePtr, inst.samplePtr + inst.sampleLength))
    .equals(Buffer.from(when.sampleBin.subarray(src.samplePtr, src.samplePtr + src.sampleLength))));
  assert.deepEqual(dest.usedInstrumentSlots(), [1]);
});

test("re-import dedupes samples by content", () => {
  const dest = emptyProject();
  const srcSlot = when.usedInstrumentSlots().find(
    (s) => !when.instruments[s].isMeta && when.instruments[s].sampleLength > 0);
  const plan1 = planImport(dest, when, [srcSlot]);
  assert.ok(plan1.newSampleBytes > 0);
  importBankOp(plan1).apply(dest);

  const plan2 = planImport(dest, when, [srcSlot]);
  assert.ok(!plan2.error, plan2.error);
  assert.equal(plan2.newSampleBytes, 0, "second import allocates no pool bytes");
  assert.equal(plan2.dedupedSamples, 1);
  importBankOp(plan2).apply(dest);
  assert.equal(dest.instruments[2].samplePtr, dest.instruments[1].samplePtr);
});

test("meta import pulls layer deps, remaps 10-bit indices, zeroes unmapped", () => {
  const dest = emptyProject();
  const metaSlot = e1m1.usedInstrumentSlots().find((s) => e1m1.instruments[s].isMeta);
  const srcLayers = e1m1.instruments[metaSlot].metaLayers;
  const plan = planImport(dest, e1m1, [metaSlot]);
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.insts.length, 1 + new Set(srcLayers.map((l) => l.instIdx)).size);
  // meta is the only top-level pick → slot 1; deps land 1023 downward
  const metaIt = plan.insts.find((it) => it.srcSlot === metaSlot);
  assert.equal(metaIt.destSlot, 1);
  for (const it of plan.insts) {
    if (it.srcSlot !== metaSlot) assert.ok(it.destSlot > 255, "layer dep in high slots");
  }

  importBankOp(plan).apply(dest);
  const meta = dest.instruments[1];
  assert.ok(meta.isMeta);
  assert.equal(meta.metaLayers.length, srcLayers.length);
  meta.metaLayers.forEach((l, i) => {
    assert.equal(l.instIdx, plan.slotMap.get(srcLayers[i].instIdx), `layer ${i} remap`);
    assert.equal(l.mixOctet, srcLayers[i].mixOctet);
    assert.equal(l.detune, srcLayers[i].detune);
    assert.equal(l.pitchStart, srcLayers[i].pitchStart);
    // layer instrument really exists in the destination
    const li = dest.instruments[l.instIdx];
    assert.ok(!li.isMeta && (li.sampleLength > 0 || li.extraPatches !== null));
  });
});

test("Ixmp blobs: pointers remapped, section round-trips, patches resolve", () => {
  const dest = emptyProject();
  const srcSlot = e1m1.usedInstrumentSlots().find(
    (s) => !e1m1.instruments[s].isMeta && (e1m1.instruments[s].extraPatches?.length ?? 0) > 0);
  const plan = planImport(dest, e1m1, [srcSlot]);
  assert.ok(!plan.error, plan.error);
  importBankOp(plan).apply(dest);

  const srcPatches = e1m1.instruments[srcSlot].extraPatches;
  const dstPatches = dest.instruments[1].extraPatches;
  assert.equal(dstPatches.length, srcPatches.length);
  dstPatches.forEach((p, i) => {
    const sp = srcPatches[i];
    assert.equal(p.sampleLength, sp.sampleLength);
    assert.equal(p.pitchStart, sp.pitchStart);
    assert.equal(p.volumeEnd, sp.volumeEnd);
    if (p.sampleLength > 0) {
      assert.ok(Buffer.from(dest.sampleBin.subarray(p.samplePtr, p.samplePtr + p.sampleLength))
        .equals(Buffer.from(e1m1.sampleBin.subarray(sp.samplePtr, sp.samplePtr + sp.sampleLength))),
        `patch ${i} sample content`);
    }
  });

  // Ixmp section rebuilt and parseable back to the same entries
  const sec = dest.projSections.find((s) => s.fourcc === "Ixmp");
  assert.ok(sec);
  const entries = parseIxmpSection(sec.payload);
  assert.equal(entries.length, dest.ixmp.length);
  assert.equal(entries[0].instId, 1);
  assert.equal(entries[0].count, dest.ixmp[0].count);
  assert.ok(Buffer.from(entries[0].blob).equals(Buffer.from(dest.ixmp[0].blob)));
});

test("names: INam splices by slot, SNam follows the census", () => {
  const dest = emptyProject();
  const named = e1m1.usedInstrumentSlots().filter(
    (s) => !e1m1.instruments[s].isMeta && e1m1.instrumentName(s));
  const picks = named.slice(0, 3);
  const plan = planImport(dest, e1m1, picks);
  assert.ok(!plan.error, plan.error);
  importBankOp(plan).apply(dest);
  picks.forEach((srcSlot, i) => {
    assert.equal(dest.instrumentName(plan.slotMap.get(srcSlot)), e1m1.instrumentName(srcSlot));
  });
  // every dest sample that came from a named source sample keeps its name
  const srcNameByKey = new Map();
  e1m1.sampleList().forEach((e) => srcNameByKey.set(`${e.ptr}:${e.len}`, e.name));
  for (const it of plan.insts) {
    const inst = dest.instruments[it.destSlot];
    if (inst.isMeta || inst.sampleLength === 0) continue;
    const src = e1m1.instruments[it.srcSlot];
    const want = srcNameByKey.get(`${src.samplePtr}:${src.sampleLength}`) ?? "";
    const got = dest.sampleList().find((e) => e.ptr === inst.samplePtr && e.len === inst.sampleLength);
    assert.equal(got.name, want, `sample name for slot ${it.destSlot}`);
  }
});

test("undo restores toBytes byte-exact; redo re-applies byte-exact", () => {
  const dest = emptyProject();
  // seed with one instrument so undo has non-trivial surroundings
  importBankOp(planImport(dest, when, [when.usedInstrumentSlots()[0]])).apply(dest);
  const before = Buffer.from(dest.toBytes());

  const undo = new UndoStack(dest);
  const metaSlot = e1m1.usedInstrumentSlots().find((s) => e1m1.instruments[s].isMeta);
  const ixmpSlot = e1m1.usedInstrumentSlots().find(
    (s) => !e1m1.instruments[s].isMeta && (e1m1.instruments[s].extraPatches?.length ?? 0) > 0);
  const plan = planImport(dest, e1m1, [metaSlot, ixmpSlot]);
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const after = Buffer.from(dest.toBytes());
  assert.ok(!after.equals(before));

  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(dest.toBytes()).equals(after), "redo byte-exact");
  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "second undo byte-exact");
});

test("import into a REAL corpus project: undo byte-exact (quirk bits survive)", () => {
  // WHEN's image carries record bytes outside the decode masks (e.g. byte 173
  // & ~0x1f); only EDITED slots may be re-encoded or those bits are lost.
  const dest = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  const before = Buffer.from(dest.toBytes());
  const undo = new UndoStack(dest);
  const metaSlot = e1m1.usedInstrumentSlots().find((s) => e1m1.instruments[s].isMeta);
  const plan = planImport(dest, e1m1, [metaSlot]);
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const after = Buffer.from(dest.toBytes());
  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(dest.toBytes()).equals(after), "redo byte-exact");
});

test("full round-trip: imported doc re-parses with identical instruments", () => {
  const dest = emptyProject();
  const picks = e1m1.usedInstrumentSlots().slice(0, 6);
  const plan = planImport(dest, e1m1, picks);
  assert.ok(!plan.error, plan.error);
  importBankOp(plan).apply(dest);

  const re = new Document(parseTaud(dest.toBytes()));
  assert.deepEqual(re.usedInstrumentSlots(), dest.usedInstrumentSlots());
  for (const s of dest.usedInstrumentSlots()) {
    assert.ok(Buffer.from(re.instRecordBytes(s)).equals(Buffer.from(dest.instRecordBytes(s))), `slot ${s}`);
    assert.equal(re.instrumentName(s), dest.instrumentName(s));
  }
  assert.equal(re.ixmp.length, dest.ixmp.length);
  assert.deepEqual(re.sampleList().map((e) => e.name), dest.sampleList().map((e) => e.name));
});

test("slot budget: full 1..255 range errors for top-level picks", () => {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  for (let s = 1; s <= 255; s++) image[SAMPLEBIN_SIZE + s * 256 + 6] = 1; // any nonzero byte
  const dest = emptyProject({ image });
  const plan = planImport(dest, when, [when.usedInstrumentSlots()[0]]);
  assert.match(plan.error ?? "", /note-addressable/);
});

test("inventory lists metas and marks layer children", () => {
  const inv = bankInventory(e1m1);
  assert.equal(inv.length, e1m1.usedInstrumentSlots().length);
  const metas = inv.filter((e) => e.isMeta);
  assert.equal(metas.length, 4);
  const children = inv.filter((e) => e.layerOf.length > 0);
  assert.ok(children.length > 0);
  for (const c of children) assert.ok(c.layerOf.every((m) => e1m1.instruments[m].isMeta));
  const withSample = inv.find((e) => !e.isMeta && e.sampleBytes > 0);
  assert.ok(withSample);
});

test("buildIxmpSection is the exact inverse of parseIxmpSection", () => {
  const sec = e1m1.projSections.find((s) => s.fourcc === "Ixmp");
  const entries = parseIxmpSection(sec.payload);
  assert.ok(Buffer.from(buildIxmpSection(entries)).equals(Buffer.from(sec.payload)));
});
