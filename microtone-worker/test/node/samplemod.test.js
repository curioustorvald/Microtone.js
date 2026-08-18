// Sample-modification note effects (item 130) — notefx 2 and 3, one command
// with two spellings ($sexy: region, operation, funk-speed index; `2` inverts
// which side of the region is touched). Region decoding is pinned here against
// TAUD_NOTE_EFFECTS.md; the engine legs drive real rows through the tracker so
// the per-tick accumulators and the read-time transforms are the ones the mixer
// actually uses.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../src/engine/constants.js";
import {
  decodeSampleRegion, inCombRun, FUNK_SPEED_TABLE, MOD_STEP, MOD_MAX,
  MOD_SCATTER_FRAC, MOD_RND12, MOD_RND_ALL, isModOpReserved, scatterRot,
  REGION_NONE, REGION_SET, REGION_COMB,
} from "../../src/engine/samplemod.js";
import { setRandomSource, makeSeededRandom } from "../../src/engine/rng.js";
import { readSamplePoint } from "../../src/engine/sampler.js";

setSamplingRate(32000);

const out = new Int32Array(3);
/** decodeSampleRegion against a 1000-byte sample looping over [100, 900). */
const dec = (se, len = 1000, ls = 100, le = 900) =>
  ({ code: decodeSampleRegion(se, len, ls, le, out), start: out[0], end: out[1], comb: out[2] });

test("region: s <= e is the percentage form, rounded", () => {
  // $0F — the whole sample; $4B — exactly the middle half.
  assert.deepEqual(dec(0x0f), { code: REGION_SET, start: 0, end: 1000, comb: -1 });
  assert.deepEqual(dec(0x4b), { code: REGION_SET, start: 250, end: 750, comb: -1 });
  // Boundaries: start s/16, end (e+1)/16 — so $88 is the ninth sixteenth alone.
  assert.deepEqual(dec(0x88), { code: REGION_SET, start: 500, end: 563, comb: -1 });
  assert.deepEqual(dec(0xff), { code: REGION_SET, start: 938, end: 1000, comb: -1 });
});

test("region: $00 is the -1 sentinel, so the voice's own loop still wins", () => {
  const r = dec(0x00);
  assert.equal(r.code, REGION_SET);
  assert.equal(r.start, -1, "start -1 = follow the sounding voice's loop (item 116)");
  assert.equal(r.end, -1);
  assert.equal(r.comb, -1);
});

test("region: the named fractions", () => {
  assert.deepEqual(dec(0x10), { code: REGION_SET, start: 250, end: 750, comb: -1 });
  assert.deepEqual(dec(0x20), { code: REGION_SET, start: 0, end: 667, comb: -1 });
  assert.deepEqual(dec(0x21), { code: REGION_SET, start: 333, end: 1000, comb: -1 });
  assert.deepEqual(dec(0x30), { code: REGION_SET, start: 0, end: 333, comb: -1 });
  assert.deepEqual(dec(0x31), { code: REGION_SET, start: 333, end: 667, comb: -1 });
  assert.deepEqual(dec(0x32), { code: REGION_SET, start: 667, end: 1000, comb: -1 });
  // $10 and $4B name the same middle half two ways.
  assert.deepEqual(dec(0x10), dec(0x4b));
});

test("region: $Fn is a comb of 2^n bytes and keeps the extent", () => {
  for (let n = 0; n <= 0xe; n++) {
    const r = dec(0xf0 | n);
    assert.equal(r.code, REGION_COMB, `$F${n.toString(16)} combs`);
    assert.equal(r.comb, n);
  }
  // …but $FF is s == e, i.e. the last sixteenth, not a comb.
  assert.equal(dec(0xff).code, REGION_SET);
});

test("region: s > e outside the named set is reserved and ignored", () => {
  // $40 and $41 are among them: they used to set the rotate step, which the
  // operation nibble now carries.
  for (const se of [0x40, 0x41, 0x54, 0xa9, 0xed, 0x73]) {
    assert.ok((se >> 4) > (se & 0xf), `$${se.toString(16)} really is s > e`);
    assert.equal(dec(se).code, REGION_NONE, `$${se.toString(16)} is reserved`);
  }
});

test("the funk-speed ladder is ProTracker's own", () => {
  assert.deepEqual([...FUNK_SPEED_TABLE],
    [0, 5, 6, 7, 8, 0x0a, 0x0b, 0x0d, 0x10, 0x13, 0x16, 0x1a, 0x20, 0x2b, 0x40, 0x80]);
  assert.equal(FUNK_SPEED_TABLE.length, 16, "one entry per $y nibble");
});

test("operation steps: rotate by 1/2/4/8 bytes, subtract 2/8/32/128", () => {
  assert.deepEqual([...MOD_STEP].slice(0, 10), [0, 0, 1, 2, 4, 8, 2, 8, 32, 128]);
  assert.equal(MOD_STEP.length, 16, "one entry per $x nibble");
  // Item 152 spent $C..$F on the scatter ladder; $A and $B are what is left.
  assert.equal(MOD_MAX, 0xf);
  assert.deepEqual([0xa, 0xb, 0xc, 0xf].map(isModOpReserved), [true, true, false, false]);
  assert.deepEqual([...MOD_SCATTER_FRAC], [0.125, 0.25, 0.5, 1]);
});

// The JVM twin (tsvm devtests/webconf/SampleModTest.java) prints the same
// checksum over the same sweep: rounding is the classic port hazard here
// (Math.round on a .5 boundary, integer vs double division), so every argument
// is decoded against a spread of sample lengths and reduced to ONE number the
// two engines can be compared on.
test("region decode: the whole $se space matches the JVM engine", () => {
  const out = new Int32Array(3);
  // FNV-1a 64, in BigInt so the multiply cannot lose the high bits.
  let h = 0xcbf29ce484222325n;
  const MASK = (1n << 64n) - 1n;
  for (const len of [2, 3, 1000, 999, 4095, 65535, 1048577]) {
    for (let se = 0; se < 256; se++) {
      const code = decodeSampleRegion(se, len, 0, len, out);
      for (const v of [code, out[0], out[1], out[2]]) {
        h = ((h ^ (BigInt(v) & 0xffffffffn)) * 1099511628211n) & MASK;
      }
    }
  }
  assert.equal(h.toString(16), "43411e372b055f5d",
    "region decode must agree with SampleModTest's REGION-DECODE-CHECKSUM");
});

test("comb runs alternate every 2^n bytes", () => {
  assert.ok(inCombRun(0, -1) && inCombRun(9999, -1), "solid region has no gaps");
  // $F0 — every other byte.
  assert.deepEqual([0, 1, 2, 3].map((k) => inCombRun(k, 0)), [true, false, true, false]);
  // $F3 — runs of eight.
  assert.deepEqual([0, 7, 8, 15, 16].map((k) => inCombRun(k, 3)),
    [true, true, false, false, true]);
});

// ── engine legs ──────────────────────────────────────────────────────────────

/** Engine with a 1000-byte ramp sample in slot 1, looping over its whole length. */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = i & 0xff;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);   // sampleLength
  w16(6, 32000);  // samplingRate @C4
  w16(12, 1000);  // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255;
  rec[196] = 255;
  eng.uploadInstrument(1, rec);
  return eng;
}

// One tick is 640 samples at 125 BPM / 32 kHz; a 6-tick row is 3840, and row
// r's first tick lands exactly on sample r·ROW — so rendering ROW leaves the
// playhead ON the next row, and ROW − TICK inside the current one.
const TICK = 640;
const ROW = 6 * TICK;

/**
 * Row 0 sounds C4 on instrument 1; `rows` gives each row's [effect, arg] in
 * turn (later rows carry no note, so the voice plays on under them).
 */
function loadRows(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50;
  pat[2] = 1;
  rows.forEach(([effect, arg], r) => {
    pat[r * 8 + 5] = effect;
    pat[r * 8 + 6] = arg & 0xff;
    pat[r * 8 + 7] = (arg >> 8) & 0xff;
  });
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
}

function render(eng, samples) {
  const buf = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < Math.ceil(samples / TRACKER_CHUNK); i++) eng.renderChunk(0, buf);
}

test("notefx 3 confines its operation to the region it names", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x311f]]); // 3 $311F — middle third, FUNK, top speed
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modStart, 333, "region start = a third in");
  assert.equal(inst.modEnd, 667);
  assert.equal(inst.modOp, 1, "operation 1 is funk repeat");
  assert.equal(inst.modInvert, false, "notefx 3 modifies the region it names");
  assert.ok(inst.modMask !== null, "the walk must have flipped something");

  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = (i) => Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);
  for (const i of [0, 100, 332, 667, 999]) {
    assert.equal(raw(i), i & 0xff, `byte ${i} is outside the region and must be untouched`);
  }
  let flipped = 0;
  for (let i = 333; i < 667; i++) if (raw(i) !== (i & 0xff)) flipped++;
  assert.ok(flipped > 0, "the region must carry the inversion");
});

test("notefx 2 is the same command with the region inverted", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x02, 0x311f]]); // 2 $311F — funk EVERYTHING BUT the middle third
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modInvert, true);
  assert.equal(inst.modStart, 333, "the region it names is the one it spares");
  assert.equal(inst.modEnd, 667);

  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = (i) => Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);
  for (let i = 333; i < 667; i++) {
    assert.equal(raw(i), i & 0xff, `byte ${i} is inside the spared region`);
  }
  let flipped = 0;
  for (let i = 0; i < 1000; i++) if (raw(i) !== (i & 0xff)) flipped++;
  assert.ok(flipped > 0, "…and the rest of the sample carries the inversion");
});

test("$x = 0 resets the modification, region and all", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x311f], [0x03, 0x3100]]);
  render(eng, ROW - TICK);
  assert.ok(eng.instruments[1].modMask !== null);
  render(eng, TICK); // …into row 1's reset
  const inst = eng.instruments[1];
  assert.equal(inst.modMask, null, "reset clears what the operation accumulated");
  assert.equal(inst.modOp, 0);
  assert.equal(inst.modStart, -1, "…and hands the region back to the loop");
  assert.equal(inst.modOn, false);
  assert.equal(eng.playheads[0].trackerState.voices[0].modSpeed, 0);
});

test("re-stating the same command does not restart the walk", () => {
  const eng = makeEngine();
  // Both rows carry the SAME argument: the walk must continue across them.
  loadRows(eng, [[0x03, 0x0f1f], [0x03, 0x0f1f]]); // whole sample, funk, one flip/tick
  render(eng, ROW);
  const after = eng.playheads[0].trackerState.voices[0].modWritePos;
  assert.ok(after > 1, `write pos must have walked (was ${after})`);
  render(eng, ROW);
  assert.ok(eng.playheads[0].trackerState.voices[0].modWritePos > after,
    "a repeated identical command must not reset the write position");
});

test("the funk speed comes from the ladder, not the nibble", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f14]]); // $y = 4 → speed 8, not 4
  render(eng, TICK);
  assert.equal(eng.playheads[0].trackerState.voices[0].modSpeed, FUNK_SPEED_TABLE[4]);
  assert.equal(FUNK_SPEED_TABLE[4], 8);
});

test("ROL rotates the region left by its own step, wrapping inside it", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x214f]]); // 3 $214F — last two thirds, ROL4, top speed
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modOp, 4, "operation 4 is ROL4");
  assert.equal(inst.modStart, 333);
  assert.equal(inst.modEnd, 1000);
  assert.equal(inst.modRot % 4, 0, "the offset moves in whole steps of 4 bytes");
  assert.ok(inst.modRot > 0 && inst.modOn);

  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = (i) => Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);
  for (const i of [0, 100, 332]) {
    assert.equal(raw(i), i & 0xff, `byte ${i} sits outside the region`);
  }
  const span = 1000 - 333;
  const src = 333 + (((400 - 333 + inst.modRot) % span) + span) % span;
  assert.equal(raw(400), src & 0xff, "a byte inside the region reads from its rotated source");
});

test("SUB slides the region's level, wrapping through zero", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f8f]]); // 3 $0F8F — whole sample, SUB32, top speed
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modOp, 8, "operation 8 is SUB32");
  assert.equal(inst.modSub % 32, 0, "…and it moves 32 at a time");
  assert.ok(inst.modSub !== 0 && inst.modOn, `something must have moved (${inst.modSub})`);

  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = (i) => Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);
  for (const i of [0, 1, 300, 999]) {
    assert.equal(raw(i), ((i & 0xff) - inst.modSub) & 0xff,
      `byte ${i} is the sample byte less the running subtrahend, wrapped`);
  }
});

test("SUB wraps: 128 twice over is the sample back again", () => {
  const eng = makeEngine();
  // $y = 8 is speed $10, so a step lands every 8th tick (5120 samples). The JVM
  // twin (tsvm devtests/webconf/SampleModTest.java) drives the same argument
  // over the same spans — its render granularity cannot straddle a step there.
  loadRows(eng, [[0x03, 0x0f98]]); // whole sample, SUB128, speed $10
  render(eng, 5632); // one step: past tick 8, before tick 16
  const inst = eng.instruments[1];
  assert.equal(inst.modSub, 128);
  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = (i) => Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);
  assert.equal(raw(10), (10 - 128) & 0xff);
  render(eng, 5632); // …the second lands back on zero
  assert.equal(inst.modSub, 0);
  assert.equal(inst.modOn, false, "a modification that changes nothing costs nothing to read");
  assert.equal(raw(10), 10);
});

test("a reserved operation or region is ignored whole — speed included", () => {
  for (const [name, arg] of [["operation $A", 0x0f_af], ["operation $B", 0x0f_bf],
                             ["region $54", 0x548f]]) {
    const eng = makeEngine();
    loadRows(eng, [[0x03, arg]]);
    render(eng, ROW);
    assert.equal(eng.playheads[0].trackerState.voices[0].modSpeed, 0,
      `${name} must not arm the speed either`);
    assert.equal(eng.instruments[1].modOp, 0, `${name} must not select an operation`);
  }
});

test("S $Fxxx is untouched by any of it", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x1c, 0xf040]]); // S $F040
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.ok(inst.funkMask !== null, "legacy funk repeat still walks the loop");
  assert.equal(inst.modOp, 0, "…and never touches the notefx 2/3 modification");
  assert.equal(inst.modStart, -1);
});

test("resetFunkState clears the modification and the legacy mask alike", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f1f]]);
  render(eng, ROW);
  assert.ok(eng.instruments[1].modMask !== null);
  eng.resetFunkState(0);
  const inst = eng.instruments[1];
  assert.equal(inst.funkMask, null);
  assert.equal(inst.modMask, null);
  assert.equal(inst.modOp, 0);
  assert.equal(inst.modStart, -1);
  assert.equal(inst.modOn, false);
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.funkSpeed, 0);
  assert.equal(v.modSpeed, 0);
  assert.equal(v.modWritePos, 0);
});

// ── the scatter ladder (item 152) ────────────────────────────────────────────

/** rot as a SIGNED displacement: the short way round the wrap domain. */
const signedRot = (rot, dl) => (rot > dl / 2 ? rot - dl : rot);

test("scatterRot stays inside its fraction of the domain, whatever the draw", () => {
  const dl = 1000;
  try {
    setRandomSource(makeSeededRandom(0xc0ffee));
    for (const op of [MOD_RND12, 0xd, 0xe]) {
      const reach = Math.round(dl * MOD_SCATTER_FRAC[op - MOD_RND12]);
      let sawNear = false;
      for (let n = 0; n < 4000; n++) {
        const d = Math.abs(signedRot(scatterRot(op, dl), dl));
        assert.ok(d <= reach, `op $${op.toString(16)}: |${d}| must be <= ${reach}`);
        if (d > reach * 0.9) sawNear = true;
      }
      assert.ok(sawNear, `op $${op.toString(16)} must actually use its whole reach`);
    }
    // $F is "everywhere": it must reach past the widest bounded op.
    let far = 0;
    for (let n = 0; n < 4000; n++) far = Math.max(far, Math.abs(signedRot(scatterRot(MOD_RND_ALL, dl), dl)));
    assert.ok(far > dl * 0.45, "$F draws from the whole domain");
  } finally {
    setRandomSource(null);
  }
});

test("scatterRot is safe on a domain too short to displace", () => {
  for (const dl of [0, 1]) {
    for (let op = MOD_RND12; op <= MOD_RND_ALL; op++) assert.equal(scatterRot(op, dl), 0);
  }
});

test("notefx 3 $C..$F displace the region and never accumulate past their bound", () => {
  try {
    setRandomSource(makeSeededRandom(7));
    for (const [op, frac] of [[0xc, 0.125], [0xd, 0.25], [0xe, 0.5]]) {
      const eng = makeEngine();
      loadRows(eng, [[0x03, 0x0f00 | (op << 4) | 0xf]]); // 3 $0F{op}F — whole sample, top speed
      const inst = eng.instruments[1];
      const reach = Math.round(1000 * frac);
      // 40 rows is ~240 steps at speed $F: a random WALK would have wandered
      // far past `reach` long before the end of that.
      for (let r = 0; r < 40; r++) {
        render(eng, ROW);
        assert.equal(inst.modOp, op);
        assert.ok(Math.abs(signedRot(inst.modRot, 1000)) <= reach,
          `op $${op.toString(16)} stayed within ${reach} of the original position`);
      }
    }
  } finally {
    setRandomSource(null);
  }
});

test("a scatter really moves which byte is read", () => {
  try {
    setRandomSource(makeSeededRandom(99));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0fef]]); // 3 $0FEF — whole sample, 50% scatter, top speed
    render(eng, ROW);
    const inst = eng.instruments[1];
    assert.ok(inst.modOn, "the displacement is live");
    assert.equal(inst.modSub, 0, "a scatter is an address transform, not a level one");
    assert.equal(inst.modMask, null, "…and keeps no inversion mask");
    const voice = eng.playheads[0].trackerState.voices[0];
    const raw = (i) => Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);
    for (const i of [0, 1, 250, 500, 999]) {
      assert.equal(raw(i), (i + inst.modRot) % 1000 & 0xff, `byte ${i} is read from the displaced position`);
    }
  } finally {
    setRandomSource(null);
  }
});

test("switching from a rotate to a scatter restarts the displacement", () => {
  try {
    setRandomSource(makeSeededRandom(3));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0f5f], [0x03, 0x0fcf]]); // ROL8 for a row, then scatter
    render(eng, ROW - TICK);
    const inst = eng.instruments[1];
    assert.equal(inst.modOp, 5);
    assert.ok(inst.modRot > 0, "the rotate accumulated");
    render(eng, TICK + 1); // into row 1: the operation changes
    assert.equal(inst.modOp, 0xc);
    assert.ok(Math.abs(signedRot(inst.modRot, 1000)) <= 125,
      "the ROL's offset was discarded rather than scattered from");
  } finally {
    setRandomSource(null);
  }
});
