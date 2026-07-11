// Item 28: editable Metainstrument mix + detune. The layer table parses a raw
// byte offset per layer (rawOffset), and setMetaBytesOp writes metaRaw + re-
// derives metaLayers (setByte can't — a meta ignores the decoded fields).

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudInst } from "../../src/engine/inst.js";
import { setMetaBytesOp } from "../../src/doc/ops.js";

/** Build a 256-byte Metainstrument record with `layers` = [{inst, mix, detune}]. */
function metaRecord(layers) {
  const b = new Uint8Array(256);
  b[0] = 0x00;            // flags (strict bit clear)
  b[1] = layers.length;   // layer count (byte 1 of the 0xFFFF sentinel word)
  b[2] = 0xff; b[3] = 0xff; // samplePtr high 16 bits = 0xFFFF → Metainstrument
  let o = 4;
  for (const l of layers) {
    b[o] = l.inst & 0xff;
    b[o + 1] = l.mix & 0xff;
    const d = l.detune & 0xffff;
    b[o + 2] = d & 0xff; b[o + 3] = (d >>> 8) & 0xff;
    b[o + 8] = ((l.inst >>> 8) & 3) << 6; // inst high bits, vStart 0
    o += 10;
  }
  return b;
}

test("meta parse: rawOffset + signed detune, layers in order", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x10, mix: 159, detune: 0 },
    { inst: 0x20, mix: 100, detune: -341 },
  ]));
  assert.ok(inst.isMeta);
  assert.equal(inst.metaLayers.length, 2);
  assert.equal(inst.metaLayers[0].rawOffset, 4);
  assert.equal(inst.metaLayers[1].rawOffset, 14);
  assert.equal(inst.metaLayers[0].mixOctet, 159);
  assert.equal(inst.metaLayers[1].detune, -341, "signed detune decoded");
});

test("meta parse: skipped invalid layer keeps rawOffset aligned to the real slot", () => {
  const inst = new TaudInst(0);
  // middle layer has inst 0 (invalid) → dropped from metaLayers but still
  // occupies its 10 raw bytes, so the third layer's rawOffset must be 24.
  inst.loadRecord(metaRecord([
    { inst: 0x10, mix: 159, detune: 0 },
    { inst: 0x00, mix: 0, detune: 0 },   // invalid → skipped
    { inst: 0x30, mix: 120, detune: 5 },
  ]));
  assert.equal(inst.metaLayers.length, 2);
  assert.equal(inst.metaLayers[0].rawOffset, 4);
  assert.equal(inst.metaLayers[1].rawOffset, 24, "third raw slot, not the second");
});

test("setMetaBytesOp: edit mix + detune, invertible, targets metaRaw", () => {
  const inst = new TaudInst(0);
  inst.loadRecord(metaRecord([
    { inst: 0x10, mix: 159, detune: 0 },
    { inst: 0x20, mix: 100, detune: 0 },
  ]));
  const doc = { instruments: [inst], markInstUsed() {}, dirty: false };
  const l1 = inst.metaLayers[1];

  // mix: byte rawOffset+1
  const invMix = setMetaBytesOp(0, [[l1.rawOffset + 1, 200]]).apply(doc);
  assert.equal(doc.instruments[0].metaLayers[1].mixOctet, 200);
  assert.equal(doc.instruments[0].metaRaw[l1.rawOffset + 1], 200, "written to metaRaw");
  assert.ok(doc.dirty);

  // detune: bytes rawOffset+2/+3 (signed −341 → 0xFEAB)
  const v = -341 & 0xffff;
  setMetaBytesOp(0, [[l1.rawOffset + 2, v & 0xff], [l1.rawOffset + 3, (v >>> 8) & 0xff]]).apply(doc);
  assert.equal(doc.instruments[0].metaLayers[1].detune, -341);

  // the first mix op's inverse restores 100 (and the mixLayer stays layer 1)
  invMix.apply(doc);
  assert.equal(doc.instruments[0].metaLayers[1].mixOctet, 100, "inverse restores mix");
  // (detune stayed at −341: the inverse only touched the mix byte)
  assert.equal(doc.instruments[0].metaLayers[1].detune, -341);
});
