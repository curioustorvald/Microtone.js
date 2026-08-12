// Row-level song surgery (item 136.2) — the Timeline trough's insert/delete
// rows, and the empty-cue insert beside them.
//
// Two properties carry everything here. The first is LINEAR: the song read top
// to bottom must come out as the original with those rows spliced out (or blanks
// spliced in), whatever the cue lengths were and however the patterns underneath
// were shared. The second is that the CUE GRID stays put: a row is a row of the
// song, so the music slides up or down THROUGH the cues rather than the cue
// boundaries moving with it — which is what forces every pattern below the edit
// to be rebuilt, and what the rest of these tests are about.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  planDeleteRows, planInsertRows, planInsertCue, PATTERN_ROWS,
} from "../../src/doc/songrows.js";
import { remapPatternsOp } from "../../src/doc/ops.js";
import { Document, cueInfo } from "../../src/doc/document.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { UndoStack } from "../../src/doc/undo.js";
import { CUE_EMPTY, MAX_VOICES } from "../../src/format/taud-const.js";
import { emptyPatternBytes } from "../../src/doc/patterntools.js";
import { INST_JUMP, INST_GOBACK } from "../../src/engine/state.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = (name) => new Document(parseTaud(readFileSync(corpusDir + name)));

/** One cell as a comparable string. */
function cellKey(cell, wide) {
  if (!cell) return "";
  let s = "";
  for (let b = 0; b < (wide ? 16 : 8); b++) {
    s += (wide ? cell.getByteWide(b) : cell.getByte(b)).toString(16).padStart(2, "0");
  }
  return s;
}

/** The key an EMPTY cell has — the FINE-with-0 sentinel in both columns, not
 *  all-zero bytes (patterntools.js). */
function emptyKey(wide) {
  const bytes = emptyPatternBytes(wide);
  let s = "";
  for (let b = 0; b < (wide ? 16 : 8); b++) s += bytes[b].toString(16).padStart(2, "0");
  return s;
}

/**
 * The song as it SOUNDS, read top to bottom: one string per absolute row holding
 * every channel's cell, with silence written as ".". A channel with no pattern
 * and a channel whose pattern is blank on that row are both silence, and an
 * insert makes one kind or the other depending on where it landed — so
 * distinguishing them here would compare the structure instead of the music,
 * which is the thing these edits are allowed to change.
 */
function linear(song, wide = false) {
  const empty = emptyKey(wide);
  const out = [];
  for (const e of song.songMap().entries) {
    for (let r = 0; r < e.rowLimit; r++) {
      const row = [];
      for (let ch = 0; ch < MAX_VOICES; ch++) {
        const p = song.cues[e.cue][ch] & 0x7fff;
        const key = p === CUE_EMPTY ? empty : (cellKey(song.patterns[p]?.[r], wide) || empty);
        row.push(key === empty ? "." : key);
      }
      out.push(row.join("|"));
    }
  }
  return out;
}

/** Every cue's playable length, in order — the grid the music slides through. */
const limits = (song) => song.songMap().entries.map((e) => e.rowLimit);
/** Materialised pattern count, the thing a naive rebuild would explode. */
const patCount = (song) => song.patterns.filter(Boolean).length;

/** Apply a plan to `doc` (no undo stack — the op is enough for the maths). */
function applyPlan(doc, plan) {
  assert.ok(plan, "the planner refused");
  remapPatternsOp(0, plan.patterns, plan.cues, null).apply(doc);
  return doc.songs[0];
}

/** A row of silence, however it is spelled underneath. */
const blankRow = () => new Array(MAX_VOICES).fill(".").join("|");

// ── delete: the linear result ──

test("delete inside one cue: everything below moves up", () => {
  const doc = load("town.taud");
  const before = linear(doc.songs[0]);
  const song = applyPlan(doc, planDeleteRows(doc.songs[0], 10, 13,
    { patternNames: doc._nameTable("pNam") }));
  const want = before.slice();
  want.splice(10, 4);
  assert.deepEqual(linear(song), want);
});

test("delete spanning a cue boundary", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const cut = song0.songMap().entries[1].startRow; // last 3 of cue 0 + first 3 of cue 1
  const before = linear(song0);
  const song = applyPlan(doc, planDeleteRows(song0, cut - 3, cut + 2, {}));
  const want = before.slice();
  want.splice(cut - 3, 6);
  assert.deepEqual(linear(song), want);
});

test("delete every row leaves one empty cue rather than no song", () => {
  const doc = load("town.taud");
  const song = applyPlan(doc, planDeleteRows(doc.songs[0], 0, 1e6, {}));
  assert.equal(song.cues.length, 1);
  assert.equal(song.songMap().totalRows, PATTERN_ROWS);
  assert.deepEqual(linear(song), new Array(PATTERN_ROWS).fill(blankRow()));
});

// ── delete: the music moves through the cue grid ──

test("the cue grid stays put — only the song's LAST cue loses the rows", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const was = limits(song0);
  const song = applyPlan(doc, planDeleteRows(song0, 100, 103, {}));
  const now = limits(song);
  assert.deepEqual(now.slice(0, -1), was.slice(0, -1), "every cue keeps its length");
  assert.equal(now[now.length - 1], was[was.length - 1] - 4, "the song ends four rows earlier");
});

test("music from the cue BELOW moves up into the edited one", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[1];
  const before = linear(song0);
  // The four rows at the top of cue 2 are what cue 1 should end with afterwards.
  const pulled = before.slice(e.startRow + e.rowLimit, e.startRow + e.rowLimit + 4);
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow, e.startRow + 3, {}));
  const after = linear(song);
  assert.deepEqual(after.slice(e.startRow + e.rowLimit - 4, e.startRow + e.rowLimit), pulled,
    "cue 1 now ends with what cue 2 began with");
  assert.equal(limits(song)[1], e.rowLimit, "…and cue 1 is still the same length");
});

test("a delete at the very end is a length edit and nothing else", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const total = song0.songMap().totalRows;
  const pats = patCount(song0);
  const cues = song0.cues.map((w) => Uint16Array.from(w));
  const song = applyPlan(doc, planDeleteRows(song0, total - 4, total - 1, {}));
  assert.equal(song.songMap().totalRows, total - 4);
  assert.equal(patCount(song), pats, "no pattern was rebuilt");
  // Only the last cue's words differ, and only in its instruction bits.
  song.cues.forEach((w, c) => {
    const same = c !== limits(song).length - 1;
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      assert.equal(w[ch] & 0x7fff, cues[c][ch] & 0x7fff, `cue ${c} ch ${ch} pattern`);
      if (same) assert.equal(w[ch], cues[c][ch], `cue ${c} ch ${ch} word`);
    }
  });
});

// ── the cheap alignments ──

test("deleting whole cues splices them out, touching no pattern", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  const a = map.entries[2], b = map.entries[3];
  const before = linear(song0);
  const pats = song0.patterns.map((p) => (p ? p.map((c) => cellKey(c)).join() : null));
  const song = applyPlan(doc, planDeleteRows(song0, a.startRow, b.startRow + b.rowLimit - 1, {}));
  const want = before.slice();
  want.splice(a.startRow, a.rowLimit + b.rowLimit);
  assert.deepEqual(linear(song), want);
  assert.equal(song.cues.length, before.length && song0.cues.length, "cue list is two shorter");
  assert.deepEqual(song.patterns.map((p) => (p ? p.map((c) => cellKey(c)).join() : null)),
    pats.slice(0, song.patterns.length), "every pattern is byte-identical");
  assert.deepEqual(limits(song), [...limits(song).slice(0, 2), ...limits(song).slice(2)]);
});

test("inserting AT a cue boundary is a blank cue, touching no pattern", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const at = song0.songMap().entries[2].startRow;
  const before = linear(song0);
  const pats = patCount(song0);
  const song = applyPlan(doc, planInsertRows(song0, at, 8, {}));
  const want = before.slice();
  want.splice(at, 0, ...new Array(8).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.equal(patCount(song), pats, "no pattern was rebuilt");
  assert.equal(limits(song)[2], 8, "the blank cue holds the eight rows");
});

test("insert past the last row appends blank cues", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const total = song0.songMap().totalRows;
  const before = linear(song0);
  const song = applyPlan(doc, planInsertRows(song0, total, 100, {}));
  assert.deepEqual(linear(song), [...before, ...new Array(100).fill(blankRow())]);
  assert.deepEqual(limits(song).slice(-2), [64, 36], "spilled into two cues");
});

// ── insert inside a cue: the shift ──

test("insert inside a cue pushes the whole song down through the grid", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const was = limits(song0);
  const before = linear(song0);
  const at = song0.songMap().entries[1].startRow + 10;
  const song = applyPlan(doc, planInsertRows(song0, at, 6, {}));
  const want = before.slice();
  want.splice(at, 0, ...new Array(6).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  const now = limits(song);
  assert.deepEqual(now.slice(0, -1), was.slice(0, -1), "every cue above it keeps its length");
  // The six rows pushed off the bottom land in the last cue, which had room for
  // them (32 of its 64); a full one would have spilled into a new cue instead.
  assert.equal(now.length, was.length);
  assert.equal(now[now.length - 1], was[was.length - 1] + 6);
});

test("…and spills into a new cue when the last one is already full", () => {
  const doc = load("WHEN.taud"); // every cue is a full 64 rows
  const song0 = doc.songs[0];
  const was = limits(song0);
  assert.equal(was[was.length - 1], PATTERN_ROWS, "fixture: the last cue is full");
  const before = linear(song0);
  const song = applyPlan(doc, planInsertRows(song0, 70, 5, {}));
  const want = before.slice();
  want.splice(70, 0, ...new Array(5).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.deepEqual(limits(song), [...was, 5]);
});

test("insert then delete the same rows returns the song to where it started", () => {
  const doc = load("town.taud");
  const before = linear(doc.songs[0]);
  const grown = applyPlan(doc, planInsertRows(doc.songs[0], 100, 6, {}));
  const shrunk = applyPlan(doc, planDeleteRows(grown, 100, 105, {}));
  assert.deepEqual(linear(shrunk), before);
});

// ── what happens to the patterns ──

test("patterns ABOVE the cut are untouched, sharing and all", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  const cut = map.entries[10].startRow + 3;
  // Every pattern only cues 0..9 play must come out byte-identical.
  const above = new Set();
  const below = new Set();
  song0.cues.forEach((w, c) => {
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      const p = w[ch] & 0x7fff;
      if (p !== CUE_EMPTY) (c < 10 ? above : below).add(p);
    }
  });
  const kept = [...above].filter((p) => !below.has(p) && song0.patterns[p]);
  assert.ok(kept.length > 0, "fixture: some patterns are played only above the cut");
  const was = new Map(kept.map((p) => [p, song0.patterns[p].map((c) => cellKey(c)).join()]));
  const cues = song0.cues.slice(0, 10).map((w) => Uint16Array.from(w));

  const song = applyPlan(doc, planDeleteRows(song0, cut, cut + 1, {}));
  for (const [p, key] of was) {
    assert.equal(song.patterns[p].map((c) => cellKey(c)).join(), key, `pattern ${p}`);
  }
  song.cues.slice(0, 10).forEach((w, c) => assert.deepEqual(w, cues[c], `cue ${c}`));
});

test("a pattern an untouched cue still plays is never written over", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  // Pattern 14 is played all over this song, above the cut as well as below.
  const users = [];
  song0.cues.forEach((w, c) => {
    for (let ch = 0; ch < MAX_VOICES; ch++) if ((w[ch] & 0x7fff) === 14) users.push([c, ch]);
  });
  assert.ok(users.some(([c]) => c < 5) && users.some(([c]) => c > 15),
    "fixture: pattern 14 plays both sides of the cut");
  const was = song0.patterns[14].map((c) => cellKey(c));
  const cut = song0.songMap().entries[12].startRow + 5;
  const song = applyPlan(doc, planDeleteRows(song0, cut, cut, {}));
  assert.deepEqual(song.patterns[14].map((c) => cellKey(c)), was,
    "the cues above the cut still play it exactly as it was");
});

test("the rebuild recycles numbers instead of one pattern per slot", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const map = song0.songMap();
  const before = patCount(song0);
  // A cut near the TOP is the worst case: every cue below it is rebuilt.
  const song = applyPlan(doc, planDeleteRows(song0, map.entries[1].startRow + 4,
    map.entries[1].startRow + 7, {}));
  const slots = song0.cues.reduce((n, w) => n +
    [...w].filter((x) => (x & 0x7fff) !== CUE_EMPTY).length, 0);
  // The naive rebuild is one fresh pattern per rebuilt slot. Recycling the
  // numbers the rebuilt cues just freed keeps the real cost a fraction of that:
  // what is left over is the slots that had nothing to recycle, i.e. a channel
  // silent in one cue and playing in the next one it now borrows rows from.
  assert.ok(patCount(song) < before + slots / 4,
    `pattern count stayed close (${before} → ${patCount(song)}, ${slots} slots rebuilt)`);
});

test("channels drawing the same rows out of the same patterns share one copy", () => {
  const doc = load("Onestop.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  // A rebuilt cue borrows rows from the cue BELOW it, so what decides whether
  // two channels can go on sharing is whether they match in BOTH — matching in
  // the edited cue alone is not enough, and two channels that diverge below it
  // have to diverge here too, because their music now differs.
  const pairs = [];
  let matched = 0;
  for (let a = 0; a < MAX_VOICES; a++) {
    for (let b = a + 1; b < MAX_VOICES; b++) {
      const here = (song0.cues[e.cue][a] & 0x7fff) === (song0.cues[e.cue][b] & 0x7fff);
      const next = (song0.cues[e.cue + 1][a] & 0x7fff) === (song0.cues[e.cue + 1][b] & 0x7fff);
      if (here && next) { pairs.push([a, b]); matched++; }
    }
  }
  assert.ok(matched > 0, "fixture: some channels match across both cues");
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow + 2, e.startRow + 3, {}));
  for (const [a, b] of pairs) {
    assert.equal(song.cues[e.cue][a] & 0x7fff, song.cues[e.cue][b] & 0x7fff,
      `channels ${a}/${b} kept their sharing`);
  }
});

test("a channel with nothing anywhere in the rebuilt span stays empty", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const empty = [];
  for (let ch = 0; ch < MAX_VOICES; ch++) {
    if (song0.cues.every((w) => (w[ch] & 0x7fff) === CUE_EMPTY)) empty.push(ch);
  }
  assert.ok(empty.length > 0, "fixture: the song does not use every channel");
  const song = applyPlan(doc, planDeleteRows(song0, 80, 83, {}));
  for (const ch of empty) {
    for (const w of song.cues) {
      assert.equal(w[ch] & 0x7fff, CUE_EMPTY, `channel ${ch} was given a pattern`);
    }
  }
});

// ── empty cue insert (the structural alternative) ──

test("planInsertCue adds a blank cue as long as the one it sits beside", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[3];
  const before = linear(song0);
  const pats = patCount(song0);
  const song = applyPlan(doc, planInsertCue(song0, e.startRow + 5, true, {}));
  const want = before.slice();
  want.splice(e.startRow, 0, ...new Array(e.rowLimit).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.equal(limits(song)[3], e.rowLimit, "…the same length as the cue it went above");
  assert.equal(patCount(song), pats, "no pattern was touched");
});

test("planInsertCue below puts it after that cue", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[0]; // the 16-row cue
  const before = linear(song0);
  const song = applyPlan(doc, planInsertCue(song0, e.startRow, false, {}));
  const want = before.slice();
  want.splice(e.startRow + e.rowLimit, 0, ...new Array(e.rowLimit).fill(blankRow()));
  assert.deepEqual(linear(song), want);
  assert.deepEqual(limits(song).slice(0, 3), [16, 16, 64]);
});

// ── cue instructions ──

test("a shortened cue gets a LEN saying so", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const total = song0.songMap().totalRows;
  const song = applyPlan(doc, planDeleteRows(song0, total - 10, total - 1, {}));
  const last = song.songMap().entries.length - 1;
  assert.equal(cueInfo(song.cues[last]).rowLimit, 22, "the 32-row last cue lost ten");
});

test("a cue keeps its HALT when the music through it changes", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const e = song0.songMap().entries[5];
  song0.cues[e.cue][8] |= 0x8000; // word 0 = 0x0100 → plain HALT
  assert.equal(cueInfo(song0.cues[e.cue]).isHalt, true);
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow - 2, e.startRow + 1, {}));
  assert.equal(cueInfo(song.cues[e.cue]).isHalt, true, "the halt stayed on its cue");
});

test("an absolute jump follows the cue it aimed at", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const jmp = 0xf000 | 6; // JMP 6 on cue 9, in instruction word 1 (channels 16-31)
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][16 + ch] = (song0.cues[9][16 + ch] & 0x7fff) | (((jmp >> ch) & 1) << 15);
  }
  assert.equal(cueInfo(song0.cues[9]).flow.type, INST_JUMP);
  const e = song0.songMap().entries[2];
  const song = applyPlan(doc, planDeleteRows(song0, e.startRow, e.startRow + e.rowLimit - 1, {}));
  const flow = cueInfo(song.cues[8]).flow; // cue 9 shifted down to 8
  assert.equal(flow.type, INST_JUMP);
  assert.equal(flow.arg, 5, "cue 6 became cue 5, so the jump did too");
});

test("relative jumps are re-measured across an inserted cue", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  const back = 0x8000 | 4; // BAK 4 on cue 9 → cue 5
  for (let ch = 0; ch < 16; ch++) {
    song0.cues[9][ch] = (song0.cues[9][ch] & 0x7fff) | (((back >> ch) & 1) << 15);
  }
  assert.equal(cueInfo(song0.cues[9]).flow.type, INST_GOBACK);
  const song = applyPlan(doc, planInsertCue(song0, song0.songMap().entries[7].startRow, true, {}));
  const flow = cueInfo(song.cues[10]).flow; // cue 9 moved one along
  assert.equal(flow.type, INST_GOBACK);
  assert.equal(flow.arg, 5, "one more cue now sits between it and its target");
});

// ── document integration ──

test("nothing to do reports it", () => {
  const song = load("town.taud").songs[0];
  const total = song.songMap().totalRows;
  assert.equal(planDeleteRows(song, total + 10, total + 20, {}), null, "past the end: nothing");
  assert.equal(planInsertRows(song, 0, 0, {}).changed, true, "a 0 becomes one row");
});

test("pattern names follow a copy the rebuild had to make", () => {
  const doc = load("flourish.taud");
  const song0 = doc.songs[0];
  const names = doc._nameTable("pNam");
  names[14] = "chorus";
  const e = song0.songMap().entries.find(
    (x) => [...song0.cues[x.cue]].some((w) => (w & 0x7fff) === 14));
  const ch = [...song0.cues[e.cue]].findIndex((w) => (w & 0x7fff) === 14);
  const plan = planDeleteRows(song0, e.startRow, e.startRow, { patternNames: names });
  const song = applyPlan(doc, plan);
  const now = song.cues[e.cue][ch] & 0x7fff;
  assert.equal(plan.pNam[now], "chorus", "whatever it plays now carries the name");
});

test("delete then undo restores the document byte-for-byte", () => {
  const doc = load("town.taud");
  const bytes = doc.toBytes();
  const undo = new UndoStack(doc);
  const plan = planDeleteRows(doc.songs[0], 20, 40, { patternNames: doc._nameTable("pNam") });
  undo.apply(remapPatternsOp(0, plan.patterns, plan.cues, null));
  assert.notDeepEqual(doc.toBytes(), bytes);
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytes);
  undo.redo();
  undo.undo();
  assert.deepEqual(doc.toBytes(), bytes, "redo then undo returns to the original");
});

test("the wide cell (format v3) survives a row delete", () => {
  const doc = load("town.taud");
  doc.upgradeToWideCells();
  const song0 = doc.songs[0];
  const before = linear(song0, true);
  const song = applyPlan(doc, planDeleteRows(song0, 12, 15, { wide: true }));
  const want = before.slice();
  want.splice(12, 4);
  assert.deepEqual(linear(song, true), want);
});

test("a song whose cues all differ in length still reads straight through", () => {
  const doc = load("town.taud");
  const song0 = doc.songs[0];
  assert.ok(new Set(limits(song0)).size >= 3, "fixture: cues of several lengths");
  const before = linear(song0);
  // Three cuts in a row, each landing inside a different cue.
  let song = song0;
  const want = before.slice();
  for (const at of [1000, 300, 20]) {
    song = applyPlan(doc, planDeleteRows(song, at, at + 2, {}));
    want.splice(at, 3);
  }
  assert.deepEqual(linear(song), want);
});
