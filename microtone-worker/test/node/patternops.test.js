// Pattern-view edit operations — the pure byte transforms (patterntools.js),
// the notation-aware single-pattern transpose (pitchtables.js) and the three
// new invertible ops (setPatternBytesOp / appendPatternOp / bulkNotesOp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  emptyPatternBytes, expandPatternBytes, shrinkPatternBytes,
  scaleVolumeBytes, transformPanBytes, changeInstrumentBytes,
} from "../../src/doc/patterntools.js";
import { setPatternBytesOp, appendPatternOp, bulkNotesOp } from "../../src/doc/ops.js";
import { pitchTablePresets, transposePatternNotes, ANCHOR_NOTE } from "../../src/ui/pitchtables.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

test("emptyPatternBytes: converter blank-cell convention (0xC0 vol/pan)", () => {
  const b = emptyPatternBytes();
  assert.equal(b.length, 512);
  for (let r = 0; r < 64; r++) {
    assert.equal(b[r * 8 + 3], 0xc0, `row ${r} vol`);
    assert.equal(b[r * 8 + 4], 0xc0, `row ${r} pan`);
    for (const off of [0, 1, 2, 5, 6, 7]) assert.equal(b[r * 8 + off], 0);
  }
});

test("expand/shrink: IT Alt-F/Alt-G row mapping", () => {
  const src = new Uint8Array(512);
  for (let r = 0; r < 64; r++) for (let b = 0; b < 8; b++) src[r * 8 + b] = (r * 8 + b) & 0xff;

  const ex = expandPatternBytes(src);
  for (let r = 0; r < 32; r++) {
    assert.deepEqual([...ex.subarray(r * 16, r * 16 + 8)], [...src.subarray(r * 8, r * 8 + 8)],
      `row ${r} lands on ${2 * r}`);
    assert.equal(ex[(2 * r + 1) * 8 + 3], 0xc0, `blank between rows is empty-convention`);
  }

  const sh = shrinkPatternBytes(src);
  for (let r = 0; r < 32; r++) {
    assert.deepEqual([...sh.subarray(r * 8, r * 8 + 8)], [...src.subarray(2 * r * 8, 2 * r * 8 + 8)],
      `row ${2 * r} lands on ${r}`);
  }
  assert.equal(sh[40 * 8 + 3], 0xc0, "tail is blank");

  // shrink(expand(x)) restores the first half verbatim
  const round = shrinkPatternBytes(expandPatternBytes(src));
  assert.deepEqual([...round.subarray(0, 32 * 8)], [...src.subarray(0, 32 * 8)]);
});

/** First pattern whose expansion differs from itself (a lone row-0 note
 *  expands to an identical image, which would make the assertions vacuous). */
function patternWithNotes(doc) {
  for (let p = 0; p < doc.songs[0].patterns.length; p++) {
    const src = doc.patternBytes(0, p);
    const ex = expandPatternBytes(src);
    if (ex.some((v, i) => v !== src[i])) return p;
  }
  throw new Error("corpus has no expandable pattern");
}

test("setPatternBytesOp: whole-pattern swap, undo/redo byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const pat = patternWithNotes(doc);
  const src = doc.patternBytes(0, pat);

  const op = setPatternBytesOp(0, pat, expandPatternBytes(src));
  assert.deepEqual(op.dirty(doc), [{ kind: "pattern", song: 0, pat }]);
  undo.apply(op);
  assert.deepEqual([...doc.patternBytes(0, pat)], [...expandPatternBytes(src)]);
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before));

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("appendPatternOp: duplicate grows the list; undo pops it byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const n0 = doc.songs[0].patterns.length;
  const undo = new UndoStack(doc);

  const dirty = undo.apply(appendPatternOp(0, doc.patternBytes(0, 2)));
  assert.equal(doc.songs[0].patterns.length, n0 + 1);
  assert.deepEqual(dirty, [{ kind: "pattern", song: 0, pat: n0 }], "dirty names the NEW index");
  assert.deepEqual([...doc.patternBytes(0, n0)], [...doc.patternBytes(0, 2)], "copy is verbatim");

  undo.undo();
  assert.equal(doc.songs[0].patterns.length, n0);
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  // the sync flush of the now-removed index must serve an EMPTY image, not throw
  const blank = doc.patternBytes(0, n0);
  assert.deepEqual([...blank], [...emptyPatternBytes()]);

  undo.redo();
  assert.equal(doc.songs[0].patterns.length, n0 + 1);
});

test("transposePatternNotes: 12-TET semitones + octaves, sentinel/perc skip", () => {
  const preset = pitchTablePresets[120];
  const cellOf = (note, inst = 0) => ({ note, instrment: inst });
  const mkSong = (cells) => ({ patterns: [cells] });

  // +1 semitone in 12-TET = one table step = 0x1000/12 ≈ 0x155 (with rounding
  // from the snap grid); anchor C4 (0x5000) must land exactly on C#4 (0x5155).
  {
    const song = mkSong([cellOf(ANCHOR_NOTE), cellOf(0x0001), cellOf(0x0000)]);
    const changes = transposePatternNotes(song, 0, preset, null, 1, 0);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + preset.table[1]);
    assert.equal(changes.length, 1, "sentinels untouched");
    assert.equal(song.patterns[0][1].note, 0x0001);
  }
  // +1 octave exactly
  {
    const song = mkSong([cellOf(ANCHOR_NOTE)]);
    transposePatternNotes(song, 0, preset, null, 0, 1);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + 0x1000);
  }
  // -1 step from C wraps to B of the period below
  {
    const song = mkSong([cellOf(ANCHOR_NOTE)]);
    transposePatternNotes(song, 0, preset, null, -1, 0);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE - 0x1000 + preset.table[11]);
  }
  // percussion skipped through running-instrument inheritance
  {
    const perc = new Uint8Array(1024);
    perc[5] = 1;
    const song = mkSong([cellOf(ANCHOR_NOTE, 5), cellOf(ANCHOR_NOTE), cellOf(ANCHOR_NOTE, 2)]);
    const changes = transposePatternNotes(song, 0, preset, perc, 1, 0);
    assert.equal(changes.length, 1, "only the inst-2 row moves");
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE);
    assert.equal(song.patterns[0][1].note, ANCHOR_NOTE, "inherited inst 5 keeps it skipped");
    assert.equal(song.patterns[0][2].note, ANCHOR_NOTE + preset.table[1]);
  }
  // Raw preset: fine = raw note units
  {
    const song = mkSong([cellOf(0x5000)]);
    transposePatternNotes(song, 0, pitchTablePresets[0], null, 7, 0);
    assert.equal(song.patterns[0][0].note, 0x5007);
  }
  // Bohlen-Pierce: coarse = one TRITAVE (0x195C), not an octave
  {
    const bp = pitchTablePresets[35130];
    const song = mkSong([cellOf(ANCHOR_NOTE)]);
    transposePatternNotes(song, 0, bp, null, 0, 1);
    assert.equal(song.patterns[0][0].note, ANCHOR_NOTE + bp.interval);
    assert.equal(bp.interval, 0x195c);
  }
  // clamps at the note floor (sentinel range is never entered)
  {
    const song = mkSong([cellOf(0x21)]);
    transposePatternNotes(song, 0, pitchTablePresets[0], null, -100, 0);
    assert.equal(song.patterns[0][0].note, 0x20);
  }
});

// ── item 22: volume / pan / instrument bulk transforms ──

/** A blank pattern with one cell's vol/pan/inst bytes set. */
function patWith(row, { vol, volEff = 0, pan, panEff = 0, inst }) {
  const b = emptyPatternBytes();
  if (vol !== undefined) b[row * 8 + 3] = (volEff << 6) | (vol & 63);
  if (pan !== undefined) b[row * 8 + 4] = (panEff << 6) | (pan & 63);
  if (inst !== undefined) b[row * 8 + 2] = inst & 0xff;
  return b;
}

test("scaleVolumeBytes: amplify set volumes, skip the no-op sentinel", () => {
  const src = patWith(3, { vol: 20 });
  const out = scaleVolumeBytes(src, 2, 0);
  assert.equal(out[3 * 8 + 3] & 63, 40, "20 × 2 = 40");
  assert.equal((out[3 * 8 + 3] >>> 6) & 3, 0, "effect selector kept");
  // empty cells (0xC0 no-op) untouched
  assert.equal(out[0 * 8 + 3], 0xc0, "blank row stays blank");
  // clamps at 63
  assert.equal(scaleVolumeBytes(patWith(0, { vol: 40 }), 3, 0)[3] & 63, 63);
  // add-only, keep slide-up selector (eff 1)
  const slide = scaleVolumeBytes(patWith(0, { vol: 10, volEff: 1 }), 1, 5);
  assert.equal(slide[3] & 63, 15);
  assert.equal((slide[3] >>> 6) & 3, 1);
});

test("transformPanBytes: widen/narrow about centre + shift, L/R swap", () => {
  // widen ×2 about centre 32: 40 (dev +8) → 48
  assert.equal(transformPanBytes(patWith(0, { pan: 40 }), 2, 0)[4] & 63, 48);
  // narrow ×0.5: 48 (dev +16) → 40
  assert.equal(transformPanBytes(patWith(0, { pan: 48 }), 0.5, 0)[4] & 63, 40);
  // negative mult swaps L/R: 40 (dev +8) → 24 (dev −8)
  assert.equal(transformPanBytes(patWith(0, { pan: 40 }), -1, 0)[4] & 63, 24);
  // shift only: +10
  assert.equal(transformPanBytes(patWith(0, { pan: 20 }), 1, 10)[4] & 63, 30);
  // no-op sentinel skipped
  assert.equal(transformPanBytes(emptyPatternBytes(), 2, 5)[4], 0xc0);
});

test("changeInstrumentBytes: matching one vs all", () => {
  const src = new Uint8Array(patWith(0, { inst: 0x05 }));
  src[1 * 8 + 2] = 0x07;
  src[2 * 8 + 2] = 0x05;
  // matching 0x05 → 0x0A leaves 0x07 alone
  const m = changeInstrumentBytes(src, 0x05, 0x0a);
  assert.equal(m[0 * 8 + 2], 0x0a);
  assert.equal(m[1 * 8 + 2], 0x07);
  assert.equal(m[2 * 8 + 2], 0x0a);
  // all (from=null) → every non-empty inst becomes 0x0A; empty (0) stays 0
  const a = changeInstrumentBytes(src, null, 0x0a);
  assert.equal(a[0 * 8 + 2], 0x0a);
  assert.equal(a[1 * 8 + 2], 0x0a);
  assert.equal(a[3 * 8 + 2], 0, "empty inst stays empty");
});

test("bulk transforms: rows span limits the edit", () => {
  const src = new Uint8Array(emptyPatternBytes());
  src[2 * 8 + 3] = 20; // row 2 vol
  src[9 * 8 + 3] = 20; // row 9 vol
  const out = scaleVolumeBytes(src, 2, 0, [0, 5]); // only rows 0..5
  assert.equal(out[2 * 8 + 3] & 63, 40, "row 2 in span scaled");
  assert.equal(out[9 * 8 + 3] & 63, 20, "row 9 outside span untouched");
});

test("bulkNotesOp: transpose one pattern on WHEN, single undo step, byte-exact", () => {
  const doc = loadWhen();
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);
  const preset = pitchTablePresets[120];

  // find a pattern with at least one real note
  let patIdx = -1;
  outer: for (let p = 0; p < doc.songs[0].patterns.length; p++) {
    for (const cell of doc.songs[0].patterns[p]) {
      if (cell.note >= 0x20) { patIdx = p; break outer; }
    }
  }
  assert.ok(patIdx >= 0, "corpus has notes");

  const dirty = undo.apply(bulkNotesOp(0,
    (song) => transposePatternNotes(song, patIdx, preset, null, 2, 0)));
  assert.deepEqual(dirty, [{ kind: "pattern", song: 0, pat: patIdx }]);
  assert.equal(undo.undoStack.length, 1);
  assert.ok(!Buffer.from(doc.toBytes()).equals(before), "notes moved");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
});
