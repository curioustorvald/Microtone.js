// Chord maker core (item 89) — the pitch-offset algebra behind the four voice
// modes, degree counting against real pitch tables, and the mix itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JI_INTERVALS, CHORD_PRESETS, MAX_UNITS, MAX_VOICES, UNITS_PER_OCTAVE,
  applyChordPreset, buildChord, chordLength, defaultVoice, defaultVoices,
  degreeUnits, jiById, voiceNote, voiceRatio, voiceUnits,
} from "../../src/doc/chord.js";
import { pitchTablePresets, gridDelta } from "../../src/ui/pitchtables.js";
import { MIDDLE_C } from "../../src/engine/constants.js";

const P12 = pitchTablePresets[120];
const P24 = pitchTablePresets[240];
const P31 = pitchTablePresets[310];
const PBP = pitchTablePresets[35130];   // Bohlen-Pierce: period is a TRITAVE
const PPT = pitchTablePresets[1];       // ProTracker: absolute table, interval 0
const PRAW = pitchTablePresets[0];      // Raw: no table at all

const voice = (patch) => ({ ...defaultVoice(), on: true, ...patch });
const sine = (n, cycles) =>
  Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * cycles * i) / n));

// ── the four modes ─────────────────────────────────────────────────────────

test("ji mode: units are the log of the ratio; the table is sane", () => {
  const fifth = voice({ mode: "ji", ji: "3/2" });
  assert.ok(Math.abs(voiceUnits(fifth, P12) - 4096 * Math.log2(1.5)) < 1e-9);
  assert.ok(Math.abs(voiceRatio(fifth, P12) - 1.5) < 1e-12);
  // 3:2 is 701.955¢ — the classic 2¢ over 12-TET's 700
  assert.equal(Math.round((voiceUnits(fifth, P12) * 1200) / 4096), 702);
  assert.equal(voiceUnits(voice({ mode: "ji", ji: "1/1" }), P12), 0);
  assert.equal(voiceUnits(voice({ mode: "ji", ji: "2/1" }), P12), UNITS_PER_OCTAVE);

  // every entry is inside one octave, ascending, and uniquely named
  let prev = -1;
  for (const iv of JI_INTERVALS) {
    const u = 4096 * Math.log2(iv.num / iv.den);
    assert.ok(u > prev, `${iv.id} ascends`);
    assert.ok(u >= 0 && u <= UNITS_PER_OCTAVE, `${iv.id} within the octave`);
    prev = u;
  }
  assert.equal(new Set(JI_INTERVALS.map((iv) => iv.key)).size, JI_INTERVALS.length);
  assert.equal(jiById("nonesuch").id, "1/1", "unknown id falls back to unison");
});

test("key mode: degrees follow the song's notation, and wrap into periods", () => {
  // 12-TET: 7 degrees = the tempered fifth, exactly the table entry
  assert.equal(degreeUnits(P12, 7), P12.table[7]);
  assert.equal(degreeUnits(P12, 0), 0);
  assert.equal(degreeUnits(P12, 12), UNITS_PER_OCTAVE, "a full table wraps to a period");
  assert.equal(degreeUnits(P12, 13), UNITS_PER_OCTAVE + P12.table[1]);
  assert.equal(degreeUnits(P12, -1), -UNITS_PER_OCTAVE + P12.table[11], "negative wraps down");
  assert.equal(degreeUnits(P12, -12), -UNITS_PER_OCTAVE);

  // finer tunings simply offer more of them: 4 degrees of 24-TET is a whole
  // tone, of 12-TET a major third — the TODO's "24-TET has more options"
  assert.equal(degreeUnits(P24, 4), P24.table[4]);
  assert.ok(degreeUnits(P24, 4) < degreeUnits(P12, 4));
  assert.equal(degreeUnits(P24, 14), degreeUnits(P12, 7), "24-TET's 14 = 12-TET's 7");

  // 31-TET's 10th degree is its major third — meantone's whole point, and far
  // closer to just 5:4 than 12-TET's 4 semitones
  const justThird = 4096 * Math.log2(1.25);
  assert.ok(Math.abs(degreeUnits(P31, 10) - justThird) < Math.abs(degreeUnits(P12, 4) - justThird));

  // periods are not assumed to be octaves
  assert.equal(degreeUnits(PBP, PBP.table.length), PBP.interval);
  assert.ok(PBP.interval > UNITS_PER_OCTAVE, "Bohlen-Pierce repeats at a tritave");
});

test("key mode: absolute tables clamp, Raw counts raw units", () => {
  // ProTracker's table IS every note it can say, so degrees clamp at the ends
  const top = degreeUnits(PPT, 999);
  assert.equal(top, degreeUnits(PPT, PPT.table.length), "clamped at the top");
  assert.equal(degreeUnits(PPT, -999), degreeUnits(PPT, -PPT.table.length));
  assert.equal(degreeUnits(PPT, 0), 0, "degree 0 is unison (PT period 428 ≡ C4)");
  assert.ok(Math.abs(degreeUnits(PPT, 12) - UNITS_PER_OCTAVE) < 20, "PT's octave is inexact");

  assert.equal(degreeUnits(PRAW, 100), 100, "no table: one degree = one 4096-TET unit");
});

test("ratio and 4096-TET modes are the two manual inputs", () => {
  assert.ok(Math.abs(voiceRatio(voice({ mode: "ratio", ratio: 1.9632 }), P12) - 1.9632) < 1e-12);
  assert.equal(voiceUnits(voice({ mode: "ratio", ratio: 2 }), P12), UNITS_PER_OCTAVE);
  assert.equal(voiceUnits(voice({ mode: "ratio", ratio: 0 }), P12), 0, "non-positive ratio ignored");
  assert.equal(voiceUnits(voice({ mode: "units", units: 0x100 }), P12), 0x100);
  assert.ok(Math.abs(voiceRatio(voice({ mode: "units", units: 0x1000 }), P12) - 2) < 1e-12);
});

test("oct rides on top of every mode, and travel is clamped", () => {
  for (const v of [{ mode: "ji", ji: "3/2" }, { mode: "key", step: 7 },
                   { mode: "ratio", ratio: 1.5 }, { mode: "units", units: 0x95b }]) {
    const flat = voiceUnits(voice(v), P12);
    assert.equal(voiceUnits(voice({ ...v, oct: 1 }), P12), flat + UNITS_PER_OCTAVE);
    assert.equal(voiceUnits(voice({ ...v, oct: -2 }), P12), flat - 2 * UNITS_PER_OCTAVE);
  }
  assert.equal(voiceUnits(voice({ mode: "ratio", ratio: 16, oct: 4 }), P12), MAX_UNITS);
  assert.equal(voiceUnits(voice({ mode: "units", units: -0x9000 }), P12), -MAX_UNITS);
});

test("voiceNote names where a voice lands when the root sounds Middle C", () => {
  assert.equal(voiceNote(voice({ mode: "ji", ji: "1/1" }), P12), MIDDLE_C);
  assert.equal(voiceNote(voice({ mode: "key", step: 12 }), P12), MIDDLE_C + UNITS_PER_OCTAVE);
  // the just third is 14¢ (≈48 units) under 12-TET's E
  const third = voiceNote(voice({ mode: "ji", ji: "5/4" }), P12);
  assert.ok(third < MIDDLE_C + P12.table[4] && MIDDLE_C + P12.table[4] - third < 60);
  assert.ok(voiceNote(voice({ mode: "units", units: -0x9000 }), P12) >= 0x20, "clamped playable");
});

test("gridDelta signs how far a voice sits from the notation's nearest degree", () => {
  const cents = (u) => (u * 1200) / UNITS_PER_OCTAVE;
  // the readout that makes the just intervals legible: 5:4 lands 13.7¢ under
  // 12-TET's E, 3:2 lands 2¢ over its G
  assert.ok(Math.abs(cents(gridDelta(voiceNote(voice({ mode: "ji", ji: "5/4" }), P12), P12)) + 13.7) < 0.5);
  assert.ok(Math.abs(cents(gridDelta(voiceNote(voice({ mode: "ji", ji: "3/2" }), P12), P12)) - 2.0) < 0.5);
  // 31-TET all but swallows the third; a degree of any table reads exactly 0
  assert.ok(Math.abs(cents(gridDelta(voiceNote(voice({ mode: "ji", ji: "5/4" }), P31), P31))) < 1.5);
  assert.equal(gridDelta(MIDDLE_C + P12.table[7], P12), 0);
  assert.equal(gridDelta(MIDDLE_C + 123, PRAW), 0, "Raw has no grid to be off");
});

// ── presets ────────────────────────────────────────────────────────────────

test("chord presets fill six slots, extras stay silent", () => {
  for (const p of CHORD_PRESETS) {
    const vs = applyChordPreset(p.id);
    assert.equal(vs.length, MAX_VOICES);
    assert.equal(vs.filter((v) => v.on).length, p.voices.length, `${p.id} voice count`);
    assert.ok(vs.slice(p.voices.length).every((v) => !v.on), `${p.id} pads with silence`);
  }
  assert.equal(new Set(CHORD_PRESETS.map((p) => p.id)).size, CHORD_PRESETS.length);
  assert.equal(defaultVoices().filter((v) => v.on).length, 3, "opens on a major triad");
  assert.ok(applyChordPreset("nonesuch").every((v) => !v.on), "unknown preset = all silent");

  // the just major triad really is 4:5:6
  const [r, third, fifth] = applyChordPreset("major").map((v) => voiceRatio(v, P12));
  assert.ok(Math.abs(r - 1) < 1e-12 && Math.abs(third - 1.25) < 1e-12 && Math.abs(fifth - 1.5) < 1e-12);
  // detune is the manual-ratio demo: three near-unison copies
  assert.ok(applyChordPreset("detune").filter((v) => v.on).every((v) => v.mode === "ratio"));
});

// ── the mix ────────────────────────────────────────────────────────────────

test("chordLength: the lowest voice sets the length, or the source does", () => {
  const vs = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "ji", ji: "1/1", oct: -1 })];
  assert.equal(chordLength(1000, vs, P12, "longest"), 2000, "an octave down runs twice as long");
  assert.equal(chordLength(1000, vs, P12, "source"), 1000);
  const up = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "ji", ji: "2/1" })];
  assert.equal(chordLength(1000, up, P12, "longest"), 1000, "voices above unison never grow it");
  assert.equal(chordLength(1000, [], P12, "longest"), 1000, "no voices: source length");
});

test("buildChord mixes pitch-shifted copies; unison is the source itself", () => {
  const src = sine(4096, 8);
  const solo = buildChord(src, [voice({ mode: "ji", ji: "1/1" })], P12, { normalise: false });
  assert.equal(solo.voices, 1);
  assert.equal(solo.data.length, src.length);
  for (let i = 0; i < src.length; i++) {
    assert.ok(Math.abs(solo.data[i] - src[i]) < 1e-7, "unison passes through untouched");
  }

  // an octave up is the same wave at half the length, so a zero crossing of
  // the source at frame 2i lands at frame i
  const up = buildChord(src, [voice({ mode: "ji", ji: "2/1" })], P12,
    { normalise: false, lengthMode: "source" });
  assert.equal(up.data.length, src.length, "source length keeps the frames");
  for (let i = 100; i < 1900; i += 97) {
    assert.ok(Math.abs(up.data[i] - src[2 * i]) < 0.02, `octave-up frame ${i}`);
  }
  assert.ok(up.data.slice(2048).every((v) => v === 0), "the tail past the copy is silence");
});

test("buildChord: gains, peak reporting and normalisation", () => {
  const src = sine(2048, 4);
  const two = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "ji", ji: "1/1" })];
  const raw = buildChord(src, two, P12, { normalise: false });
  assert.ok(Math.abs(raw.peak - 1.0) < 1e-3, "two copies at unity double the peak");
  assert.ok(Math.abs(Math.max(...raw.data) - 1.0) < 1e-3, "not normalised");

  const norm = buildChord(src, two, P12, { normalise: true });
  assert.ok(Math.abs(norm.peak - 1.0) < 1e-3, "peak reports the PRE-normalise level");
  let mx = 0;
  for (const v of norm.data) mx = Math.max(mx, Math.abs(v));
  assert.ok(Math.abs(mx - 1.0) < 1e-6, "normalised to full scale");

  // −6 dB halves a voice: one at unity + one at −6 dB peaks at 1.5×
  const ducked = buildChord(src, [two[0], { ...two[1], gainDb: -6.0206 }], P12, { normalise: false });
  assert.ok(Math.abs(ducked.peak - 0.75) < 2e-3, `peak ${ducked.peak}`);

  assert.equal(buildChord(src, [], P12).data.length, 0, "no voices: nothing to mix");
  assert.equal(buildChord(src, [{ ...voice({}), on: false }], P12).voices, 0);
});

test("buildChord is deterministic and notation-aware", () => {
  const src = sine(3000, 5);
  const vs = [voice({ mode: "ji", ji: "1/1" }), voice({ mode: "key", step: 7 }),
              voice({ mode: "units", units: 0x100 }), voice({ mode: "ratio", ratio: 1.9632 })];
  const a = buildChord(src, vs, P12);
  const b = buildChord(src, vs, P12);
  assert.deepEqual([...a.data], [...b.data], "same inputs, same bytes");

  // the SAME voice list retunes with the song: step 7 is a fifth in 12-TET and
  // a quarter-tone-flat fourth in 24-TET, so the mixes differ
  const c = buildChord(src, vs, P24);
  assert.notDeepEqual([...a.data], [...c.data]);
  assert.equal(voiceUnits(vs[1], P24), P24.table[7]);
});
