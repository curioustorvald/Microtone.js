// Format version 3 — the 16-byte pattern cell (file format §5.5): 8-bit
// volume, a panning column that carries a whole spherical position, and a
// second effect.
//
// The property that matters most is the one that is NOT about v3: a version-2
// song must render exactly as it always did, because the volume state widened
// underneath it. The conformance suite pins that against the JVM oracle; the
// first test here pins the arithmetic that made the widening possible.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import {
  TRACKER_CHUNK, PATTERN_BYTES_WIDE, CELL_BYTES_WIDE, SAMPLING_RATE, setSamplingRate,
} from "../../src/engine/constants.js";
import { TaudPlayData } from "../../src/engine/state.js";
import { EffectOp } from "../../src/engine/tables.js";
import { SURROUND_PLANAR, SURROUND_SPATIAL } from "../../src/engine/spatial.js";

// Pinned to the Kotlin engine's 32 kHz (item 108 moved the web default to
// 48 kHz): the expectations below are sample counts and reference renders
// taken from AudioAdapter.kt, and they stay diffable against it.
setSamplingRate(32000);

/** Engine with a looping ramp sample in slot 1, in the wide-cell format. */
function makeWideEngine(surroundModel = SURROUND_SPATIAL) {
  const eng = new TaudEngine();
  eng.setCellFormat(true);
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1;
  rec[21] = 0x3f;
  rec[171] = 255;
  rec[196] = 255;
  eng.uploadInstrument(1, rec);
  eng.setSurroundModel(0, surroundModel);
  return eng;
}

/**
 * rows: [{row, note, inst, vol, volEff, azimuth, elevation, panEff,
 *         effect, arg, effect2, arg2}] → uploaded as pattern 0.
 * Untouched columns get the FINE-by-zero sentinel, exactly as an editor writes.
 */
function loadWideSong(eng, rows) {
  const pat = new Uint8Array(PATTERN_BYTES_WIDE);
  for (let r = 0; r < 64; r++) pat[r * CELL_BYTES_WIDE + 8] = 0x33; // vol+pan = FINE 0
  for (const c of rows) {
    const o = c.row * CELL_BYTES_WIDE;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    let sel = pat[o + 8];
    if (c.vol !== undefined) {
      pat[o + 3] = c.vol & 0xff;
      sel = (sel & 0x8f) | ((c.volEff ?? 0) << 4);
    }
    if (c.azimuth !== undefined) {
      pat[o + 4] = c.azimuth & 0xff;
      sel = (sel & 0x7f) | (((c.azimuth >>> 8) & 1) << 7);
      sel = (sel & 0xf0) | (c.panEff ?? 0);
    }
    if (c.elevation !== undefined) pat[o + 9] = c.elevation & 0xff;
    pat[o + 8] = sel;
    if (c.effect !== undefined) {
      pat[o + 5] = c.effect;
      pat[o + 6] = c.arg & 0xff;
      pat[o + 7] = (c.arg >>> 8) & 0xff;
    }
    if (c.effect2 !== undefined) {
      pat[o + 10] = c.effect2;
      pat[o + 11] = c.arg2 & 0xff;
      pat[o + 12] = (c.arg2 >>> 8) & 0xff;
    }
  }
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
  return eng;
}

const CHUNKS_PER_TICK = (SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK;
function render(eng, ticks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < ticks * CHUNKS_PER_TICK; i++) eng.renderChunk(0, out);
}
const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];

// ── the codec ────────────────────────────────────────────────────────────

test("the wide cell round-trips every field through its 16 bytes", () => {
  const cell = new TaudPlayData();
  cell.note = 0x5123;
  cell.instrment = 0xab;
  cell.volume = 0xcd;
  cell.volumeEff = 5;
  cell.azimuth = 0x1a4;      // needs the ninth bit
  cell.elevation = -40;
  cell.panEff = 0xd;
  cell.effect = EffectOp.OP_X;
  cell.effectArg = 0x40c0;
  cell.effect2 = EffectOp.OP_Z;
  cell.effectArg2 = 0x0123;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = cell.getByteWide(i);
  const back = new TaudPlayData();
  for (let i = 0; i < 16; i++) back.setByteWide(i, bytes[i]);

  for (const k of ["note", "instrment", "volume", "volumeEff", "azimuth", "elevation",
    "panEff", "effect", "effectArg", "effect2", "effectArg2"]) {
    assert.equal(back[k], cell[k], `${k} did not survive the round trip`);
  }
  // The selector byte is the documented packing, not something incidental.
  assert.equal(bytes[8], 0x80 | (5 << 4) | 0xd);
  assert.equal(bytes[9], 0xd8, "elevation is signed on the wire");
  assert.deepEqual([...bytes.subarray(13)], [0, 0, 0], "reserved bytes stay clear");
});

test("an untouched wide cell is FINE-by-zero in both columns", () => {
  const cell = new TaudPlayData();
  cell.volumeEff = 3;
  cell.panEff = 3;
  assert.equal(cell.getByteWide(8), 0x33);
  assert.equal(cell.getByteWide(3), 0);
  assert.equal(cell.getByteWide(4), 0);
});

// ── volume ───────────────────────────────────────────────────────────────

test("the volume column is eight bits and the state widens with it", () => {
  const eng = makeWideEngine();
  assert.equal(eng.playheads[0].trackerState.volMax, 255);
  loadWideSong(eng, [{ row: 0, note: 0x5000, inst: 1, vol: 200, volEff: 0 }]);
  render(eng, 2);
  assert.equal(voice0(eng).noteVolume, 200, "a value a 6-bit column could not hold");
});

test("a nibble volume slide moves at the rate it always did", () => {
  // D $01 is one 6-bit unit per tick; in a wide cell that has to be four of
  // its own units, or every converted song slides four times too slowly.
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, vol: 255, volEff: 0 },
    { row: 1, effect: EffectOp.OP_D, arg: 0x0100 }, // slide down 1/tick
  ]);
  render(eng, 6);          // row 0
  const start = voice0(eng).noteVolume;
  render(eng, 6);          // row 1: five non-first ticks
  const moved = start - voice0(eng).noteVolume;
  assert.equal(moved, 5 * 4, `slid ${moved} units, expected 5 ticks × 4`);
});

test("the volume column's own slide keeps its full 8-bit precision", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, vol: 255, volEff: 0 },
    { row: 1, vol: 1, volEff: 2 }, // slide DOWN by one unit per tick
  ]);
  render(eng, 6);
  const start = voice0(eng).noteVolume;
  render(eng, 6);
  assert.equal(start - voice0(eng).noteVolume, 5, "one unit per tick — not four");
});

test("FINE moves its direction flag to the top of the wider field", () => {
  const eng = makeWideEngine();
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, vol: 100, volEff: 0 },
    { row: 1, vol: 0x80 | 20, volEff: 3 }, // fine UP by 20
    { row: 2, vol: 20, volEff: 3 },        // fine DOWN by 20
  ]);
  // A row's pass runs on the FIRST tick of the row, so one tick is enough to
  // see row 0 and six carry us into each of the rows after it.
  render(eng, 1);
  assert.equal(voice0(eng).noteVolume, 100);
  render(eng, 6);
  assert.equal(voice0(eng).noteVolume, 120);
  render(eng, 6);
  assert.equal(voice0(eng).noteVolume, 100);
});

test("velocity layers still see a 6-bit axis (instrument data does not widen)", () => {
  // A patch covering the top half of the 6-bit volume axis must be picked by a
  // wide cell's 255, and not by its 100.
  const eng = makeWideEngine();
  const patch = new Uint8Array([
    0x01,             // version: base fields only
    0x20, 0x00,       // pitchStart
    0xff, 0xff,       // pitchEnd
    32, 63,           // volumeStart..volumeEnd — the top half
    0, 0, 0, 0,       // samplePtr
    0xe8, 0x03,       // sampleLength 1000
    0, 0,             // playStart
    0, 0,             // loopStart
    0xe8, 0x03,       // loopEnd
    0x00, 0x7d,       // samplingRate 32000
    0, 0,             // detune
    1,                // loopMode
    0xff,             // defaultPan sentinel
    0,                // defaultNoteVolume sentinel
    0, 0, 0, 0, 0xff, // vibrato + waveform sentinel
  ]);
  eng.uploadInstrumentPatches(1, patch);

  loadWideSong(eng, [{ row: 0, note: 0x5000, inst: 1, vol: 255, volEff: 0 }]);
  render(eng, 2);
  assert.equal(voice0(eng).activePatchIndex, 0, "255 → 63 must land inside the rectangle");

  const quiet = makeWideEngine();
  quiet.uploadInstrumentPatches(1, patch);
  loadWideSong(quiet, [{ row: 0, note: 0x5000, inst: 1, vol: 100, volEff: 0 }]);
  render(quiet, 2);
  assert.equal(voice0(quiet).activePatchIndex, -1, "100 → 25 must fall outside it");
});

// ── panning ──────────────────────────────────────────────────────────────

test("the panning column places a source anywhere on the sphere", () => {
  const eng = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 384, elevation: 64, panEff: 0 },
  ]);
  render(eng, 2);
  // Item 117: the panning column is the NOTE axis in a wide cell too, so the
  // pair it writes is an offset from the channel's direction — which, with the
  // channel at its default front, puts the source exactly where the cell says.
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0), 384, "behind — the ninth bit reached the engine");
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 64);
  assert.equal(voice0(eng).panAzimuth, 128, "the channel's own direction is untouched");
});

test("a planar song keeps the column's azimuth and drops its elevation", () => {
  const eng = makeWideEngine(SURROUND_PLANAR);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 300, elevation: 100, panEff: 0 },
  ]);
  render(eng, 2);
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0), 300);
  assert.equal(eng.getVoiceSpatialElevation(0, 0), 0);
  assert.equal(voice0(eng).noteElevation, 0, "dropped at the write, not at the mixer");
});

test("a Z on the same row makes the column a slide TARGET, not a jump", () => {
  const eng = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 128, elevation: 0, panEff: 0 },
    { row: 1, azimuth: 256, elevation: 64, panEff: 0, effect: EffectOp.OP_Z, arg: 0x010 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).panAzimuth, 128, "row 0 places the source at the front");
  render(eng, 2); // into row 1: the row pass has run and the slide has stepped
  const v = voice0(eng);
  assert.equal(v.spatialTargetAz, 256, "the column set the target");
  assert.equal(v.spatialTargetEl, 64);
  assert.ok(v.panAzimuth > 128 && v.panAzimuth < 256,
    `the source should be travelling, not teleported (at ${v.panAzimuth})`);
});

test("the column's pan slides rotate by their low byte per tick", () => {
  const eng = makeWideEngine(SURROUND_PLANAR);
  loadWideSong(eng, [
    { row: 0, note: 0x5000, inst: 1, azimuth: 128, elevation: 0, panEff: 0 },
    { row: 1, azimuth: 10, panEff: 1 }, // slide right by 10 per tick
  ]);
  render(eng, 6);
  const start = eng.getVoiceSpatialAzimuth(0, 0);
  render(eng, 6);
  assert.equal(eng.getVoiceSpatialAzimuth(0, 0) - start, 50, "five non-first ticks × 10");
  assert.equal(voice0(eng).panAzimuth, 128, "a column slide turns the note, not the channel");
});

// ── the second effect ────────────────────────────────────────────────────

test("both effect slots run, and the second one lands last", () => {
  const eng = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng, [{
    row: 0, note: 0x5000, inst: 1,
    effect: EffectOp.OP_X, arg: 0x0040,   // place: front, ear level
    effect2: EffectOp.OP_M, arg2: 0x8000, // …and set the channel volume
  }]);
  render(eng, 2);
  const v = voice0(eng);
  assert.equal(v.panAzimuth, 128, "effect 1 ran");
  assert.equal(v.channelVolume, 0x80, "effect 2 ran — and at full 8-bit range");

  // Two writes to the same state: the second must win.
  const eng2 = makeWideEngine(SURROUND_SPATIAL);
  loadWideSong(eng2, [{
    row: 0, note: 0x5000, inst: 1,
    effect: EffectOp.OP_X, arg: 0x0040,
    effect2: EffectOp.OP_X, arg2: 0x00c0, // behind
  }]);
  render(eng2, 2);
  assert.equal(voice0(eng2).panAzimuth, 384, "the later effect wins");
});

test("a narrow-cell engine never reads the second effect", () => {
  // Same 16 bytes fed to an 8-byte reader would be nonsense, so the guard is
  // that the format flag — not the data — decides.
  const eng = new TaudEngine();
  assert.equal(eng.getCellFormat(), false);
  assert.equal(eng.playheads[0].trackerState.volMax, 0x3f);
  eng.setCellFormat(true);
  assert.equal(eng.getCellFormat(), true);
  assert.equal(eng.playheads[0].trackerState.volMax, 255);
  assert.equal(eng.playheads[0].trackerState.volStep, 4);
  assert.equal(eng.playheads[0].trackerState.volDiv, 255);
});

// ── the document and the container ───────────────────────────────────────

test("a version-3 file round-trips through parse → document → write", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { writeTaud } = await import("../../src/format/taud-write.js");
  const { Document } = await import("../../src/doc/document.js");

  // Start from a real song and widen it by hand — the upgrade FLOW is stage 2;
  // what this pins is that the container, the document and the codec agree.
  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const parsed = parseTaud(readFileSync(path));
  parsed.fmtVer = 3;
  parsed.songs[0].surroundModel = SURROUND_SPATIAL;
  parsed.songs.forEach((song) => {
    song.patterns = song.patterns.map((p8) => {
      const p16 = new Uint8Array(PATTERN_BYTES_WIDE);
      for (let r = 0; r < 64; r++) {
        p16[r * 16 + 8] = 0x33;
        for (let b = 0; b < 3; b++) p16[r * 16 + b] = p8[r * 8 + b]; // note + inst
      }
      return p16;
    });
  });
  // A position the narrow cell could not have expressed at all.
  parsed.songs[0].patterns[0][4] = 0x80;  // azimuth low byte
  parsed.songs[0].patterns[0][8] = 0x80;  // A bit + SET in both columns
  parsed.songs[0].patterns[0][9] = 0x40;  // elevation +45°

  const bytes = writeTaud(parsed);
  assert.equal(bytes[8] & 0x1f, 3, "the header must declare version 3");

  const again = parseTaud(bytes);
  assert.equal(again.fmtVer, 3);
  assert.equal(again.songs[0].patterns[0].length, PATTERN_BYTES_WIDE);
  assert.deepEqual(again.songs[0].patterns[0], parsed.songs[0].patterns[0]);

  const doc = new Document(again);
  assert.equal(doc.wideCells, true);
  const cell = doc.songs[0].patterns[0][0];
  assert.equal(cell.azimuth, 384, "the ninth bit survived the whole trip");
  assert.equal(cell.elevation, 64);
  assert.deepEqual(doc.patternBytes(0, 0), parsed.songs[0].patterns[0],
    "the document re-encodes the pattern byte-for-byte");
  assert.equal(doc.toBytes()[8] & 0x1f, 3, "…and saves as version 3, never down");
});

test("an empty wide pattern is empty in the wide sense", async () => {
  const { emptyPatternBytes } = await import("../../src/doc/patterntools.js");
  const narrow = emptyPatternBytes();
  const wide = emptyPatternBytes(true);
  assert.equal(narrow.length, 512);
  assert.equal(wide.length, PATTERN_BYTES_WIDE);
  assert.equal(narrow[3], 0xc0);
  assert.equal(wide[8], 0x33, "FINE in both columns");
  assert.equal(wide[3], 0, "…with a zero value, which is what makes it a no-op");
});

test("a wide document renders through the offline path", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { renderToWav } = await import("../../src/audio/offline-render.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const parsed = parseTaud(readFileSync(path));
  parsed.fmtVer = 3;
  parsed.songs[0].surroundModel = SURROUND_SPATIAL;
  parsed.songs.forEach((song) => {
    song.patterns = song.patterns.map((p8) => {
      const p16 = new Uint8Array(PATTERN_BYTES_WIDE);
      for (let r = 0; r < 64; r++) {
        p16[r * 16 + 8] = 0x33;
        for (let b = 0; b < 3; b++) p16[r * 16 + b] = p8[r * 8 + b];
        p16[r * 16 + 3] = 255;                       // full 8-bit volume
        p16[r * 16 + 8] = (p16[r * 16 + 8] & 0x0f);  // volume SET
      }
      return p16;
    });
  });
  const doc = new Document(parsed);
  const wav = renderToWav(doc.toRenderable(0), 0, 1);
  assert.ok(wav.bytes.length > 44, "produced audio");
  let peak = 0;
  const dv = new DataView(wav.bytes.buffer, 44);
  for (let i = 0; i + 1 < dv.byteLength; i += 2) peak = Math.max(peak, Math.abs(dv.getInt16(i, true)));
  assert.ok(peak > 1000, `a wide-cell song must actually sound (peak ${peak})`);
});

// ── the version-2 → version-3 upgrade ────────────────────────────────────

test("widening a cell preserves what every field meant", async () => {
  const { widenPattern, widenVolume } = await import("../../src/doc/upgrade.js");
  const src = new Uint8Array(512);
  const put = (r, bytes) => src.set(bytes, r * 8);
  //     note      inst  vol         pan         fx    arg
  put(0, [0x00, 0x50, 1, 0x3f, 0x20, EffectOp.OP_A, 0x34, 0x12]); // vol SET 63, pan SET 32
  put(1, [0, 0, 0, 0x40 | 8, 0x80 | 5, 0, 0, 0]);                 // vol slide up 8, pan slide L 5
  put(2, [0, 0, 0, 0xc0 | 0x20 | 10, 0xc0 | 0x20 | 7, 0, 0, 0]);  // FINE up 10 / right 7
  put(3, [0, 0, 0, 0xc0, 0xc0, EffectOp.OP_M, 0x00, 0x30]);       // empty cols + M $3000
  const out = widenPattern(src);

  const sel = (r) => out[r * 16 + 8];
  // row 0 — SET in both columns.
  assert.equal(out[3], 255, "volume 63 must become full scale, exactly");
  // Pan value 32 of 63 → the byte the v2 engine derived: (32<<2)|(32>>4) = 130.
  assert.equal(out[4], 130, "pan SET → the front-arc byte the v2 engine derived");
  assert.equal(sel(0) & 0x80, 0, "…which needs no ninth bit");
  assert.equal((sel(0) >> 4) & 7, 0);
  assert.equal(sel(0) & 0xf, 0);
  assert.equal(out[5], EffectOp.OP_A, "the effect moves to slot 1 untouched");
  assert.equal(out[6] | (out[7] << 8), 0x1234);
  assert.deepEqual([...out.subarray(10, 16)], [0, 0, 0, 0, 0, 0], "slot 2 + reserved stay clear");

  // row 1 — slides: volume scales, panning does not (same units either way).
  assert.equal(out[16 + 3], widenVolume(8));
  assert.equal((sel(1) >> 4) & 7, 1);
  assert.equal(out[16 + 4], 5, "a pan-byte step IS an azimuth step");
  assert.equal(sel(1) & 0xf, 2);

  // row 2 — FINE: the direction flag moves to the top of each wider field.
  assert.equal(out[32 + 3] & 0x80, 0x80, "volume fine UP");
  assert.equal(out[32 + 3] & 0x7f, widenVolume(10));
  assert.equal(sel(2) & 0x80, 0x80, "pan fine RIGHT rides the A bit");
  assert.equal(out[32 + 4], 7, "…with its magnitude unchanged");

  // row 3 — the empty-column sentinel survives as the wide one, and M scales.
  assert.equal(sel(3), 0x33);
  assert.equal(out[48 + 3], 0);
  assert.equal(out[48 + 4], 0);
  assert.equal(out[48 + 7], widenVolume(0x30), "M sets a LEVEL, so it rescales");
});

test("the upgrade is one undo step and puts the exact bytes back", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { upgradeCellFormatOp } = await import("../../src/doc/ops.js");
  const { UndoStack } = await import("../../src/doc/undo.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const doc = new Document(parseTaud(readFileSync(path)));
  const before = doc.toBytes();
  const wasVer = doc.fmtVer; // the corpus holds version-1 files too
  assert.equal(doc.wideCells, false);

  const undo = new UndoStack(doc);
  undo.apply(upgradeCellFormatOp(0, 2));
  assert.equal(doc.wideCells, true);
  assert.equal(doc.fmtVer, 3);
  assert.equal(doc.songs[0].surroundModel, 2, "the model rides in the same op");
  assert.equal(doc.patternBytes(0, 0).length, PATTERN_BYTES_WIDE);
  assert.equal(doc.toBytes()[8] & 0x1f, 3);

  undo.undo();
  assert.equal(doc.wideCells, false);
  assert.equal(doc.fmtVer, wasVer);
  assert.equal(doc.songs[0].surroundModel, 0, "…and comes back with it");
  assert.deepEqual(doc.toBytes(), before, "undo must restore the file byte for byte");

  undo.redo();
  assert.equal(doc.wideCells, true, "…and redo widens it again");
});

test("a widened song sounds like the one it came from", async () => {
  // The upgrade's whole claim: the same music, in a cell that can say more.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { renderToWav } = await import("../../src/audio/offline-render.js");

  const path = fileURLToPath(new URL("../corpus/WHEN.taud", import.meta.url));
  const narrow = new Document(parseTaud(readFileSync(path)));
  const wide = new Document(parseTaud(readFileSync(path)));
  wide.upgradeToWideCells();

  const a = renderToWav(narrow.toRenderable(0), 0, 4);
  const b = renderToWav(wide.toRenderable(0), 0, 4);
  assert.equal(a.bytes.length, b.bytes.length);

  // Not bit-exact — 8-bit volume quantises the mix differently — but the two
  // renders have to be the same performance, so compare them as signals.
  const pcm = (w) => {
    const dv = new DataView(w.bytes.buffer, 44);
    const out = new Float64Array(dv.byteLength >> 1);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
    return out;
  };
  const pa = pcm(a);
  const pb = pcm(b);
  let dot = 0, ea = 0, eb = 0, worst = 0;
  for (let i = 0; i < pa.length; i++) {
    dot += pa[i] * pb[i];
    ea += pa[i] * pa[i];
    eb += pb[i] * pb[i];
    worst = Math.max(worst, Math.abs(pa[i] - pb[i]));
  }
  const corr = dot / Math.sqrt(ea * eb);
  assert.ok(corr > 0.9999, `the widened song drifted (correlation ${corr.toFixed(6)})`);
  assert.ok(worst < 0.02, `sample-level difference too large (${worst.toFixed(4)})`);
});

// ── the editor's wide columns (stage 3) ─────────────────────────────────

test("the cursor walks the wide cell's extra panning digits", async () => {
  const E = await import("../../src/ui/edit.js");
  assert.deepEqual(E.subNibbles(false), [1, 2, 3, 3, 1, 4]);
  assert.deepEqual(E.subNibbles(true), [1, 2, 3, 6, 1, 4], "panning gains el + 3-digit azimuth");
  assert.equal(E.subPositions(false).length, 14);
  assert.equal(E.subPositions(true).length, 17);
  assert.equal(E.cellChars(false), 21);
  assert.equal(E.cellChars(true), 24);

  // Clicking maps to the same places the painter draws.
  assert.deepEqual(E.charToSub(12, true), [E.SUB_PAN, 0], "symbol");
  assert.deepEqual(E.charToSub(13, true), [E.SUB_PAN, 1], "elevation hi");
  assert.deepEqual(E.charToSub(15, true), [E.SUB_PAN, 3], "azimuth hi");
  assert.deepEqual(E.charToSub(17, true), [E.SUB_PAN, 5], "azimuth lo");
  assert.deepEqual(E.charToSub(19, true), [E.SUB_FX_OP, 0], "the effect moved right");
  assert.deepEqual(E.charToSub(20, true), [E.SUB_FX_ARG, 0]);
  // …and the narrow layout is untouched.
  assert.deepEqual(E.charToSub(16, false), [E.SUB_FX_OP, 0]);
  assert.deepEqual(E.subCharPos(E.SUB_FX_OP, 0, true), [19, 1]);
  assert.deepEqual(E.subCharPos(E.SUB_FX_OP, 0, false), [16, 1]);
});

test("typing an 8-bit volume into a wide cell", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.volumeEff = 3; cell.panEff = 3; // empty
  const ctx = { octave: 4, currentInst: 1, preset: null, rawHex: false, wideCells: true };
  const key = (k, sub, nib, c) => E.interpretEditKey({ code: "Key", key: k }, sub, nib, c, ctx);

  // "F" then "F" on the two digits → 255, which a 6-bit column could not hold.
  let a = key("f", E.SUB_VOL, 1, cell);
  assert.equal(a.fields.volume, 0xf0);
  assert.equal(a.fields.volumeEff, 0, "an empty column promotes to SET");
  Object.assign(cell, a.fields);
  a = key("f", E.SUB_VOL, 2, cell);
  assert.equal(a.fields.volume, 0xff);
  assert.ok(a.advanceRow, "the last digit steps to the next row");
});

test("the wide panning column edits elevation and a 9-bit azimuth", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.volumeEff = 3; cell.panEff = 3;
  const ctx = { octave: 4, currentInst: 1, preset: null, rawHex: false, wideCells: true };
  const key = (k, nib, c) => E.interpretEditKey({ code: "Key", key: k }, E.SUB_PAN, nib, c, ctx);

  // Elevation "C0" = −64 (45° below).
  let a = key("c", 1, cell);
  Object.assign(cell, a.fields);
  a = key("0", 2, cell);
  Object.assign(cell, a.fields);
  assert.equal(cell.elevation, -64, "elevation is a SIGNED byte");

  // Azimuth "180" = behind the listener — three digits, nine bits.
  a = key("1", 3, cell);
  Object.assign(cell, a.fields);
  a = key("8", 4, cell);
  Object.assign(cell, a.fields);
  a = key("0", 5, cell);
  Object.assign(cell, a.fields);
  assert.equal(cell.azimuth, 0x180);
  assert.equal(cell.panEff, 0, "…as a SET");
  assert.ok(a.advanceRow, "the last azimuth digit steps to the next row");

  // Clearing blanks the whole column, elevation included.
  const clear = E.interpretEditKey({ code: "Delete", key: "Delete" }, E.SUB_PAN, 4, cell, ctx);
  assert.deepEqual(clear.fields, { azimuth: 0, elevation: 0, panEff: 3 });
});

test("FINE's direction flag follows the field it lives in", async () => {
  const E = await import("../../src/ui/edit.js");
  // Volume: bit 5 of six becomes bit 7 of eight.
  const narrow = new TaudPlayData();
  narrow.volume = 10; narrow.volumeEff = 0;
  assert.equal(E.volPanSelect(false, "fineUp", narrow, false).volume, 0x20 | 10);
  const wide = new TaudPlayData();
  wide.volume = 10; wide.volumeEff = 0;
  assert.equal(E.volPanSelect(false, "fineUp", wide, true).volume, 0x80 | 10);
  // Panning: the flag is the azimuth's ninth bit, which IS `A` on the wire.
  const wp = new TaudPlayData();
  wp.azimuth = 40; wp.panEff = 0;
  const f = E.volPanSelect(true, "fineUp", wp, true);
  assert.equal(f.azimuth, 0x100 | 40);
  assert.equal(E.volPanOp(f.azimuth, f.panEff, true, true), "fineUp");
  assert.equal(E.volPanArg(f.azimuth, f.panEff, true, true), 40, "…and the digits show the magnitude");
});

test("an empty wide panning column knows the elevation counts", async () => {
  const E = await import("../../src/ui/edit.js");
  const cell = new TaudPlayData();
  cell.panEff = 3; cell.azimuth = 0; cell.elevation = 0;
  assert.equal(E.subIsEmpty(E.SUB_PAN, cell), true);
  cell.elevation = 30;
  assert.equal(E.subIsEmpty(E.SUB_PAN, cell), false, "a height alone is not nothing");
});

test("a spatial song states ear level instead of hiding it", async () => {
  // On the sphere 00 is a POSITION — the composer chose ear level — so the
  // column says so. A planar song has no height to state, and under a slide
  // selector the elevation field is reserved, so both keep the dots.
  const { elevationCellText } = await import("../../src/ui/glyphs.js");
  assert.equal(elevationCellText(0, "set", true), "00", "spatial + placing → stated");
  assert.equal(elevationCellText(0, "set", false), "··", "planar has no height");
  assert.equal(elevationCellText(0, "none", true), "··", "an empty column stays empty");
  assert.equal(elevationCellText(0, "up", true), "··", "reserved under a slide");
  assert.equal(elevationCellText(0, "fineUp", true), "··");
  // A real height is always shown, in every model — including a negative one,
  // which is a signed byte on the wire.
  assert.equal(elevationCellText(64, "set", false), "40");
  assert.equal(elevationCellText(-64, "set", true), "C0");
  assert.equal(elevationCellText(-1, "up", false), "FF");
});
