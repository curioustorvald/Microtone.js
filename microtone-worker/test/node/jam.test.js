import { test } from "node:test";
import assert from "node:assert/strict";

import { JamKeyboard } from "../../src/ui/jam.js";
import { semiToNoteInTable, JAM_SEMIS } from "../../src/ui/edit.js";

function mkJam() {
  const log = [];
  const store = {
    audio: {
      jamNote: (ph, voice, note, inst, audition) => log.push({ t: "on", voice, note, inst, audition }),
      jamStop: () => log.push({ t: "off" }),
    },
    cursor: { ch: 3 },
    pitchPreset: undefined,
    view: "timeline",
  };
  return { jam: new JamKeyboard(store), log };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Release and wait out the grace window, so the note-off has landed. */
const release = async (jam, code) => { jam.up(code); await sleep(jam.releaseGraceMs + 20); };

test("jam: a held key is one note — autorepeat never retriggers", async () => {
  const { jam, log } = mkJam();
  assert.ok(jam.down("KeyA", false));
  assert.equal(log.length, 1);
  assert.equal(log[0].note, semiToNoteInTable(4, JAM_SEMIS.KeyA, undefined));

  for (let i = 0; i < 5; i++) assert.ok(jam.down("KeyA", true), "repeat is still consumed");
  assert.equal(log.length, 1, "no retrigger from the repeat flag");

  // Backstop: a host that leaves `repeat` unset must not retrigger either.
  jam.down("KeyA", false);
  assert.equal(log.length, 1, "no retrigger from a keydown for an already-held key");

  await release(jam, "KeyA");
  assert.deepEqual(log.map((e) => e.t), ["on", "off"]);
});

test("jam: autorepeat delivered as keyup+keydown pairs is not a release", async () => {
  const { jam, log } = mkJam();
  jam.down("KeyA", false);
  // X11 without detectable autorepeat: each repeat is a full up/down pair,
  // arriving back to back. The note must ride straight through them.
  for (let i = 0; i < 8; i++) {
    jam.up("KeyA");
    jam.down("KeyA", false);
    await sleep(1);
  }
  assert.deepEqual(log.map((e) => e.t), ["on"], "no note-off, no retrigger");
  assert.ok(jam.held.has("KeyA"), "still held");

  await release(jam, "KeyA");
  assert.deepEqual(log.map((e) => e.t), ["on", "off"], "the real release still ends it");
});

test("jam: the release grace is short and can be switched off", async () => {
  const { jam, log } = mkJam();
  assert.ok(jam.releaseGraceMs > 0 && jam.releaseGraceMs <= 50, "inaudible, sub-strike-rate");
  jam.down("KeyA", false);
  jam.up("KeyA");
  assert.equal(log.length, 1, "the note-off waits for its would-be repeat partner");
  await sleep(jam.releaseGraceMs + 20);
  assert.equal(log.at(-1).t, "off");

  jam.releaseGraceMs = 0;
  jam.down("KeyA", false);
  jam.up("KeyA");
  assert.equal(log.at(-1).t, "off", "grace 0 releases synchronously");
});

test("jam: last key wins, only the last release stops the voice", async () => {
  const { jam, log } = mkJam();
  jam.down("KeyA", false);
  jam.down("KeyS", false);
  assert.equal(log.filter((e) => e.t === "on").length, 2);
  await release(jam, "KeyA");
  assert.ok(!log.some((e) => e.t === "off"), "the still-held key keeps sounding");
  await release(jam, "KeyS");
  assert.equal(log.at(-1).t, "off");
});

test("jam: hold() (record-mode entry) shares the held-key bookkeeping", async () => {
  const { jam, log } = mkJam();
  jam.currentInst = 0x12;
  jam.hold("KeyA", 0x1234, 7);
  assert.deepEqual(log, [{ t: "on", voice: 7, note: 0x1234, inst: 0x12, audition: undefined }]);
  // A plain jam of the same key while it is held must not retrigger it...
  jam.down("KeyA", false);
  assert.equal(log.length, 1);
  // ...and its release ends the note.
  await release(jam, "KeyA");
  assert.equal(log.at(-1).t, "off");
});

test("jam: a keyup for a key we never took still stops a stray audition", () => {
  const { jam, log } = mkJam();
  jam.store.audio.jamNote(0, 0, 0x1000, 1);   // jammed by some other path
  jam.up("KeyA");
  assert.equal(log.at(-1).t, "off");
});

test("jam: allUp() drops everything (focus loss eats the keyup)", async () => {
  const { jam, log } = mkJam();
  jam.down("KeyA", false);
  jam.down("KeyS", false);
  jam.up("KeyA");            // release in flight when focus goes
  jam.allUp();
  assert.equal(log.at(-1).t, "off");
  assert.equal(jam.held.size, 0);
  await sleep(jam.releaseGraceMs + 20);
  assert.equal(log.filter((e) => e.t === "off").length, 1, "the cancelled release never fires");
  assert.equal(jam.down("KeyA", false), true);
  assert.equal(log.at(-1).t, "on", "the keyboard is usable again");
});

test("jam: non-piano keys are not consumed", () => {
  const { jam, log } = mkJam();
  assert.equal(jam.down("ArrowDown", false), false);
  assert.equal(jam.up("ArrowDown"), false);
  assert.equal(log.length, 0);
});
