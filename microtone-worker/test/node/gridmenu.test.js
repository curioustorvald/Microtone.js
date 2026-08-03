// The grid context menu's slot actions (item 103): moving a filled cue slot
// sideways, duplicating the pattern it points at, and the channel header's
// mute row. Plus the two ops underneath — compositeOp and createPatternOp.
//
// Same load-bearing invariant as channelops.test.js: bit 15 of a cue word
// belongs to the channel POSITION (it spells the cue's instruction words), so
// nothing here may carry it around with the pattern.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canMoveSlots, patternSlotItems, isPatternSlotItem, moveSlots, duplicateSlots,
  muteItems, runMuteItem,
} from "../../src/ui/gridmenu.js";
import { compositeOp, createPatternOp, setCueWordOp, setCellOp } from "../../src/doc/ops.js";
import { CUE_EMPTY } from "../../src/format/taud-const.js";
import { parseTaud, cueInstructionWords } from "../../src/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { Store } from "../../src/ui/store.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));

/** A store over WHEN.taud, wired the way app.js wires one (minus the audio). */
function loadStore() {
  const store = new Store();
  store.doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  store.undo = new UndoStack(store.doc);
  return store;
}

const pat = (store, cue, ch) => store.song.cues[cue][ch] & 0x7fff;
const cmdBit = (store, cue, ch) => store.song.cues[cue][ch] & 0x8000;
/** Every cue's instruction-word pair — what a slot move must not disturb. */
const insts = (store) => store.song.cues.map((w) => cueInstructionWords(w).join(","));

/** Force cue `cue`'s channels to the given pattern numbers (null = empty),
 *  leaving each position's command bit alone. */
function seed(store, cue, from, nums) {
  const w = store.song.cues[cue];
  nums.forEach((n, i) => {
    w[from + i] = (w[from + i] & 0x8000) | (n === null ? CUE_EMPTY : n);
  });
}

const ids = (items) => items.map((i) => i.id).join();

// ── canMoveSlots ──

test("canMoveSlots: a lone slot moves into an empty neighbour, not onto a full one", () => {
  const store = loadStore();
  const song = store.song;
  const chans = store.doc.channelCount;
  seed(store, 0, 0, [null, 0x11, 0x22]);
  assert.equal(canMoveSlots(song, [{ cue: 0, ch: 1 }], -1, chans), true, "left slot is empty");
  assert.equal(canMoveSlots(song, [{ cue: 0, ch: 1 }], 1, chans), false, "right slot is taken");
});

test("canMoveSlots: nothing may fall off either end", () => {
  const store = loadStore();
  const chans = store.doc.channelCount;
  seed(store, 0, 0, [0x11]);
  assert.equal(canMoveSlots(store.song, [{ cue: 0, ch: 0 }], -1, chans), false);
  // …and the same at the right-hand edge.
  const last = chans - 1;
  store.song.cues[0][last] = (store.song.cues[0][last] & 0x8000) | 0x11;
  assert.equal(canMoveSlots(store.song, [{ cue: 0, ch: last }], 1, chans), false);
});

test("canMoveSlots: an empty slot has nothing to move", () => {
  const store = loadStore();
  seed(store, 0, 0, [null, null]);
  assert.equal(canMoveSlots(store.song, [{ cue: 0, ch: 0 }], 1, store.doc.channelCount), false);
  assert.equal(canMoveSlots(store.song, [], 1, store.doc.channelCount), false);
});

test("canMoveSlots: a solid block slides — its interior targets are its own sources", () => {
  const store = loadStore();
  const chans = store.doc.channelCount;
  seed(store, 0, 0, [null, 0x11, 0x22, 0x33, 0x44]);
  const block = [1, 2, 3].map((ch) => ({ cue: 0, ch }));
  assert.equal(canMoveSlots(store.song, block, -1, chans), true,
    "only the leading edge needs somewhere to go");
  assert.equal(canMoveSlots(store.song, block, 1, chans), false,
    "…and to the right the block is up against channel 4");
});

test("canMoveSlots: an empty slot inside the block is not a source, only a target", () => {
  const store = loadStore();
  const chans = store.doc.channelCount;
  //          ch: 0     1     2     3
  seed(store, 0, 0, [null, 0x11, null, 0x33]);
  const block = [1, 2, 3].map((ch) => ({ cue: 0, ch }));
  // 0x33 moves into the hole at 2, 0x11 into the empty 0.
  assert.equal(canMoveSlots(store.song, block, -1, chans), true);
});

// ── moveSlots ──

test("moveSlots: the pattern moves, the position's command bit stays", () => {
  const store = loadStore();
  seed(store, 0, 0, [null, 0x11]);
  const bitsBefore = [cmdBit(store, 0, 0), cmdBit(store, 0, 1)];
  const before = insts(store).join("|");
  assert.equal(moveSlots(store, [{ cue: 0, ch: 1 }], -1), true);
  assert.equal(pat(store, 0, 0), 0x11, "the pattern landed on channel 0");
  assert.equal(pat(store, 0, 1), CUE_EMPTY, "…and left its old slot empty");
  assert.deepEqual([cmdBit(store, 0, 0), cmdBit(store, 0, 1)], bitsBefore,
    "each position kept its own command bit");
  assert.equal(insts(store).join("|"), before, "so the cue instructions are unchanged");
});

test("moveSlots: a solid block keeps its interior — only the trailing edge empties", () => {
  const store = loadStore();
  seed(store, 0, 0, [null, 0x11, 0x22, 0x33, null]);
  const block = [1, 2, 3].map((ch) => ({ cue: 0, ch }));
  assert.equal(moveSlots(store, block, -1), true);
  assert.deepEqual([0, 1, 2, 3].map((ch) => pat(store, 0, ch)),
    [0x11, 0x22, 0x33, CUE_EMPTY]);
});

test("moveSlots: a refused move writes nothing at all", () => {
  const store = loadStore();
  seed(store, 0, 0, [0x11, 0x22]);
  const depth = store.undo.undoStack.length;
  assert.equal(moveSlots(store, [{ cue: 0, ch: 0 }], 1), false, "channel 1 is occupied");
  assert.equal(pat(store, 0, 0), 0x11);
  assert.equal(store.undo.undoStack.length, depth, "…and nothing reached the undo stack");
});

test("moveSlots: several cues at once, in one undo step, byte-exact undo", () => {
  const store = loadStore();
  seed(store, 0, 0, [null, 0x11]);
  seed(store, 1, 0, [null, 0x22]);
  const bytesBefore = store.doc.toBytes();
  const depth = store.undo.undoStack.length;
  const slots = [{ cue: 0, ch: 1 }, { cue: 1, ch: 1 }];
  assert.equal(moveSlots(store, slots, -1), true);
  assert.equal(pat(store, 0, 0), 0x11);
  assert.equal(pat(store, 1, 0), 0x22);
  assert.equal(store.undo.undoStack.length, depth + 1, "one step for the whole block");
  store.undo.undo();
  assert.deepEqual(store.doc.toBytes(), bytesBefore);
  store.undo.redo();
  assert.equal(pat(store, 1, 0), 0x22, "…and it redoes");
});

// ── duplicateSlots ──

test("duplicateSlots: a fresh number per slot, all distinct, in one undo step", () => {
  const store = loadStore();
  seed(store, 0, 0, [0x11, 0x11, 0x22]); // two of them SHARE a pattern on purpose
  const want = store.song.freePatternNumbers(3);
  const depth = store.undo.undoStack.length;
  const slots = [0, 1, 2].map((ch) => ({ cue: 0, ch }));
  assert.equal(duplicateSlots(store, slots), true);
  const got = [0, 1, 2].map((ch) => pat(store, 0, ch));
  assert.deepEqual(got, want, "each slot got its own new number, lowest first");
  assert.equal(new Set(got).size, 3, "two slots sharing a pattern still get a copy each");
  assert.equal(store.undo.undoStack.length, depth + 1);
});

test("duplicateSlots: the copy carries the original's cells", () => {
  const store = loadStore();
  // Pick a cue slot whose pattern actually has notes in it.
  const src = store.song.patterns.findIndex(
    (p) => p && p.some((c) => c.note >= 0x20));
  assert.ok(src >= 0, "the corpus song has a non-empty pattern");
  seed(store, 0, 0, [src]);
  const srcBytes = store.doc.patternBytes(0, src);
  duplicateSlots(store, [{ cue: 0, ch: 0 }]);
  const copy = pat(store, 0, 0);
  assert.notEqual(copy, src, "the slot points somewhere new");
  assert.deepEqual(store.doc.patternBytes(0, copy), srcBytes);
});

test("duplicateSlots: the copy really is unshared — editing it leaves the original alone", () => {
  const store = loadStore();
  const src = store.song.patterns.findIndex((p) => p && p.some((c) => c.note >= 0x20));
  seed(store, 0, 0, [src]);
  const srcBytes = store.doc.patternBytes(0, src);
  duplicateSlots(store, [{ cue: 0, ch: 0 }]);
  store.undo.apply(setCellOp(0, pat(store, 0, 0), 0, { note: 0x40, inst: 1 }));
  assert.deepEqual(store.doc.patternBytes(0, src), srcBytes,
    "the pattern the other cues still share is untouched");
});

test("duplicateSlots: undo takes the new pattern back out, byte-exact", () => {
  const store = loadStore();
  const src = store.song.patterns.findIndex((p) => p && p.some((c) => c.note >= 0x20));
  seed(store, 0, 0, [src]);
  const bytesBefore = store.doc.toBytes();
  const lenBefore = store.song.patterns.length;
  duplicateSlots(store, [{ cue: 0, ch: 0 }]);
  assert.notDeepEqual(store.doc.toBytes(), bytesBefore);
  store.undo.undo();
  assert.equal(store.song.patterns.length, lenBefore,
    "the pattern array is the length it was — no empty pattern left behind");
  assert.deepEqual(store.doc.toBytes(), bytesBefore);
  store.undo.redo();
  store.undo.undo();
  assert.deepEqual(store.doc.toBytes(), bytesBefore, "redo then undo returns to the original");
});

test("duplicateSlots: empty slots are not duplicated", () => {
  const store = loadStore();
  seed(store, 0, 0, [null, 0x11]);
  assert.equal(duplicateSlots(store, [{ cue: 0, ch: 0 }]), false, "nothing to copy");
  const free = store.song.firstFreePattern();
  assert.equal(duplicateSlots(store, [{ cue: 0, ch: 0 }, { cue: 0, ch: 1 }]), true);
  assert.equal(pat(store, 0, 0), CUE_EMPTY, "the empty one stayed empty");
  assert.equal(pat(store, 0, 1), free);
});

// ── the menu cells ──

test("patternSlotItems: only the moves that are possible are offered", () => {
  const store = loadStore();
  seed(store, 0, 0, [0x11, null, 0x22, 0x33]);
  assert.equal(ids(patternSlotItems(store, [{ cue: 0, ch: 0 }])), "movRight,dupPat",
    "channel 0 has nowhere to go left");
  assert.equal(ids(patternSlotItems(store, [{ cue: 0, ch: 2 }])), "movLeft,dupPat",
    "channel 2 is boxed in on the right by channel 3");
  seed(store, 0, 0, [null, 0x11, null]);
  assert.equal(ids(patternSlotItems(store, [{ cue: 0, ch: 1 }])), "movLeft,movRight,dupPat");
});

test("patternSlotItems: an empty slot gets no cells at all", () => {
  const store = loadStore();
  seed(store, 0, 0, [null]);
  assert.deepEqual(patternSlotItems(store, [{ cue: 0, ch: 0 }]), []);
  assert.deepEqual(patternSlotItems(store, []), []);
});

test("isPatternSlotItem recognises exactly the three cells", () => {
  for (const id of ["movLeft", "movRight", "dupPat"]) assert.equal(isPatternSlotItem(id), true);
  for (const id of ["insLeft", "newPat", "paste", null]) assert.equal(isPatternSlotItem(id), false);
});

// ── the header's mute row (item 103.2) ──

test("muteItems: Mute flips to Unmute, and Unmute all only shows when it would do something", () => {
  const store = loadStore();
  assert.equal(ids(muteItems(store, 3)), "solo,mute", "nothing muted yet");
  assert.equal(muteItems(store, 3)[1].id, "mute");

  store.toggleMute(3);
  const items = muteItems(store, 3);
  assert.equal(ids(items), "solo,mute,unmuteAll");
  assert.equal(items[1].label, "Unmute", "the cell reads as the action it performs");
  assert.match(items[2].title, /1/, "the tooltip counts the muted channels");

  // A channel that is NOT the muted one still offers Unmute all…
  assert.equal(ids(muteItems(store, 4)), "solo,mute,unmuteAll");
  assert.equal(muteItems(store, 4)[1].label, "Mute", "…but its own cell still mutes");
});

test("runMuteItem: solo, toggle and unmute-all, and none of them touch undo", () => {
  const store = loadStore();
  const chans = store.doc.channelCount;
  const depth = store.undo.undoStack.length;

  assert.equal(runMuteItem(store, "mute", 2), true);
  assert.equal(store.voiceMutes[2], true);
  assert.equal(runMuteItem(store, "mute", 2), true);
  assert.equal(store.voiceMutes[2], false, "the same cell unmutes again");

  assert.equal(runMuteItem(store, "solo", 5), true);
  assert.equal(store.voiceMutes[5], false, "the soloed channel sounds");
  assert.equal(store.voiceMutes.slice(0, chans).filter(Boolean).length, chans - 1,
    "everything else is muted");

  assert.equal(runMuteItem(store, "unmuteAll", 5), true);
  assert.equal(store.voiceMutes.some(Boolean), false);

  assert.equal(runMuteItem(store, "paste", 0), false, "an unrelated id is not ours");
  assert.equal(store.undo.undoStack.length, depth, "mutes are playback state, not document state");
});

// ── the ops underneath ──

test("compositeOp: one undo step, the union of the tags, unwound in reverse", () => {
  const store = loadStore();
  const doc = store.doc;
  const bytesBefore = doc.toBytes();
  const depth = store.undo.undoStack.length;
  const free = store.song.firstFreePattern();
  const tags = store.undo.apply(compositeOp([
    createPatternOp(0, free, doc.patternBytes(0, 0)),
    setCueWordOp(0, 0, 0, (store.song.cues[0][0] & 0x8000) | free),
  ]));
  assert.equal(store.undo.undoStack.length, depth + 1);
  assert.deepEqual(tags.map((tg) => tg.kind), ["pattern", "cue"], "both sub-ops reported");
  assert.equal(pat(store, 0, 0), free);
  store.undo.undo();
  assert.deepEqual(doc.toBytes(), bytesBefore,
    "the create is undone AFTER the cue word that referenced it");
});

test("createPatternOp: materialises any number, and its inverse restores the gaps", () => {
  const store = loadStore();
  const doc = store.doc;
  const song = store.song;
  // A null gap below the array's end — the case appendPatternOp cannot serve.
  const gap = song.patterns.length;
  song.patterns.push(null, null);
  song.cues[0][0] = (song.cues[0][0] & 0x8000) | (gap + 1); // claim the far one
  assert.equal(song.firstFreePattern(), gap);

  const lenBefore = song.patterns.length;
  const bytes = doc.patternBytes(0, 0);
  const inverse = createPatternOp(0, gap, bytes).apply(doc);
  assert.deepEqual(doc.patternBytes(0, gap), bytes);
  assert.equal(song.patterns.length, lenBefore, "an interior index does not grow the array");

  inverse.apply(doc);
  assert.equal(song.patterns[gap], null, "the gap is a gap again");
  assert.equal(song.patterns.length, lenBefore);
});

test("createPatternOp past the end: undo pops the padding it added", () => {
  const store = loadStore();
  const doc = store.doc;
  const song = store.song;
  const lenBefore = song.patterns.length;
  const at = lenBefore + 4;
  const inverse = createPatternOp(0, at, doc.patternBytes(0, 0)).apply(doc);
  assert.equal(song.patterns.length, at + 1);
  inverse.apply(doc);
  assert.equal(song.patterns.length, lenBefore, "the null padding went away too");
});
