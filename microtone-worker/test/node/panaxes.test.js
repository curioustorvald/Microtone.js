// The two panning axes (item 117) — the pan side of TAUD_NOTE_EFFECTS.md §3.
//
// `channel_pan` is where the PART sits and only S $80xx / P / X / 4 / Z may
// write it; `note_pan` is where the NOTE sits within it, seeded by the
// instrument (its default pan, or the Ixmp zone's) and written by the panning
// column. They add at the mixer, which is what lets a channel pan ROTATE a
// zone-panned instrument instead of flattening it at the next note.
//
// The volume side of the same shape is §3's `note_vol` × `channel_vol`, and
// the mapping of commands onto axes is deliberately identical: effect column →
// channel, mini-lane → note.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../src/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../src/engine/constants.js";
import { EffectOp } from "../../src/engine/tables.js";
import { makeInstPatch, writePatchesBlob } from "../../src/engine/inst.js";

setSamplingRate(32000);

/** Two instruments over one looping ramp: 1 plain, 2 with two panned zones. */
function makeEngine() {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = 128 + ((i % 100) - 50);
  const rec = () => {
    const r = new Uint8Array(256);
    const w16 = (o, v) => { r[o] = v & 0xff; r[o + 1] = (v >> 8) & 0xff; };
    w16(4, 1000); w16(6, 32000); w16(12, 1000);
    r[14] = 1; r[21] = 0x3f; r[171] = 255; r[196] = 255;
    return r;
  };
  eng.uploadInstrument(1, rec());
  eng.uploadInstrument(2, rec());
  const zone = (lo, hi, pan) => makeInstPatch({
    pitchStart: lo, pitchEnd: hi, volumeStart: 0, volumeEnd: 63,
    sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1,
    defaultPan: pan,
  });
  // A two-zone keyboard: low notes left of centre, high notes right of it.
  eng.uploadInstrumentPatches(2, writePatchesBlob([
    zone(0x0000, 0x4fff, 0x60), zone(0x5000, 0xffff, 0xa0),
  ]));
  return eng;
}

/** rows: [{row, note, inst, effect, arg, pan, panEff}] → uploaded pattern 0. */
function loadSong(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.pan !== undefined) pat[o + 4] = (c.pan & 0x3f) | ((c.panEff ?? 0) << 6);
    if (c.effect !== undefined) {
      pat[o + 5] = c.effect;
      pat[o + 6] = c.arg & 0xff;
      pat[o + 7] = (c.arg >>> 8) & 0xff;
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
assert.ok(Number.isInteger(CHUNKS_PER_TICK));

function render(eng, ticks) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < ticks * CHUNKS_PER_TICK; i++) eng.renderChunk(0, out);
}

const voice0 = (eng) => eng.playheads[0].trackerState.voices[0];
/** The 6-bit column value that lands on 8-bit pan `p` (the engine's own map). */
const colFor = (v) => (v << 2) | (v >>> 4);

// ── the axes are separate registers ──────────────────────────────────────

test("S $80xx moves the channel, the panning column moves the note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8040 },
    { row: 1, pan: 0x30, panEff: 0 },
  ]);
  render(eng, 3);
  assert.equal(voice0(eng).channelPan, 0x40, "S $80xx wrote the channel axis");
  assert.equal(voice0(eng).notePan, 0, "…and left the note axis alone");

  render(eng, 6);
  assert.equal(voice0(eng).channelPan, 0x40, "the column did not touch the channel");
  assert.equal(voice0(eng).notePan, colFor(0x30) - 0x80, "the column wrote the note axis");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 + colFor(0x30) - 0x80, "and they sum");
});

// The precedence rule this replaces ("S $80xx wins over a column SET on the
// same row") existed only because both wrote one register. They no longer do.
test("an S $80xx and a column SET on the same row BOTH apply", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8060, pan: 0x28, panEff: 0 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).channelPan, 0x60);
  assert.equal(voice0(eng).notePan, colFor(0x28) - 0x80);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x60 + colFor(0x28) - 0x80);
});

test("P slides the channel axis while the column's slide moves the note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x8080 },
    { row: 1, effect: EffectOp.OP_P, arg: 0x0400 },  // channel: right 4/tick
    { row: 2, pan: 0x06, panEff: 1 },                // note: right 6/tick
  ]);
  render(eng, 12);
  const afterP = voice0(eng).channelPan;
  assert.equal(afterP, 0x80 + 4 * 5, "five non-first ticks of P");
  assert.equal(voice0(eng).notePan, 0);

  render(eng, 6);
  assert.equal(voice0(eng).channelPan, afterP, "the column's slide left the channel alone");
  assert.equal(voice0(eng).notePan, 6 * 5, "five non-first ticks of the column slide");
});

// ── what the instrument seeds ────────────────────────────────────────────

test("a zone pan seeds the note axis, so a channel pan rotates the keyboard", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x4000, inst: 2, effect: EffectOp.OP_S, arg: 0x8040 },
    { row: 1, note: 0x6000, inst: 2 },
  ]);
  render(eng, 3);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 - 32, "low zone, 32 left of the channel");
  render(eng, 6);
  assert.equal(eng.getVoiceEffectivePan(0, 0), 0x40 + 32, "high zone, 32 right of it");
  assert.equal(voice0(eng).channelPan, 0x40, "neither note moved the channel");
});

test("a column SET overrides the zone pan for that note", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x4000, inst: 2, pan: 0x20, panEff: 0 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).notePan, colFor(0x20) - 0x80,
    "the column runs after the trigger, so it is what stands");
});

test("a trigger that brings no pan of its own leaves a column SET standing", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, pan: 0x10, panEff: 0 },
    { row: 1, note: 0x5100, inst: 1 },  // instrument 1 has no zone and no 'p'
  ]);
  render(eng, 12);
  assert.equal(voice0(eng).notePan, colFor(0x10) - 0x80, "still the column's value");
});

test("a zone-panned trigger re-seeds the note axis over a column SET", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, pan: 0x10, panEff: 0 },
    { row: 1, note: 0x4000, inst: 2 },  // instrument 2's low zone: $60
  ]);
  render(eng, 12);
  assert.equal(voice0(eng).notePan, 0x60 - 0x80, "the zone won");
});

// ── the sum ──────────────────────────────────────────────────────────────

test("the summed position saturates at the ends in a stereo song", () => {
  const eng = loadSong(makeEngine(), [
    { row: 0, note: 0x5000, inst: 1, effect: EffectOp.OP_S, arg: 0x80f0, pan: 0x3f, panEff: 0 },
  ]);
  render(eng, 6);
  assert.equal(voice0(eng).channelPan + voice0(eng).notePan, 0xf0 + 127, "both axes keep their value");
  assert.equal(eng.getVoiceEffectivePan(0, 0), 255, "the mixer is what clamps");
});

test("an NNA ghost keeps sounding at its own note position", () => {
  const eng = makeEngine();
  // Instrument 2, NNA = continue, so the first note lives on as a ghost.
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1; rec[21] = 0x3f; rec[171] = 255; rec[196] = 255;
  rec[186] = 2; // NNA continue
  eng.uploadInstrument(2, rec);
  eng.uploadInstrumentPatches(2, writePatchesBlob([
    makeInstPatch({
      pitchStart: 0x0000, pitchEnd: 0x4fff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1, defaultPan: 0x60,
    }),
    makeInstPatch({
      pitchStart: 0x5000, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      sampleLength: 1000, samplingRate: 32000, loopEnd: 1000, loopMode: 1, defaultPan: 0xa0,
    }),
  ]));
  loadSong(eng, [
    { row: 0, note: 0x4000, inst: 2 },
    { row: 1, note: 0x6000, inst: 2 },
  ]);
  render(eng, 12);
  const ghosts = eng.playheads[0].trackerState.backgroundVoices.filter((v) => v.active);
  assert.equal(ghosts.length, 1, "the displaced note carried on");
  assert.equal(ghosts[0].notePan, 0x60 - 0x80, "the ghost kept the zone it was sounding");
  assert.equal(voice0(eng).notePan, 0xa0 - 0x80, "the new note took its own");
});
