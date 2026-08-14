// Chord maker core (item 89) — the pitch-offset algebra behind the four voice
// modes, degree counting against real pitch tables, and the mix itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JI_INTERVALS, CHORD_GROUPS, CHORD_PRESETS, MAX_UNITS, MAX_VOICES, UNITS_PER_OCTAVE,
  applyChordPreset, buildChord, chordLength, chordPresetLabel, chordPresetsFor,
  defaultVoice, defaultVoices, degreeUnits, invertVoiceSpecs, jiById,
  maxInversion, presetVoiceCount, voiceNote, voiceRatio, voiceUnits,
} from "../../src/doc/chord.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";
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

// ── tetrachords (item 141) ─────────────────────────────────────────────────

test("tetrachords divide their tuning's perfect fourth three ways", () => {
  // The complete charts of the Xenharmonic Wiki: every composition of the
  // fourth into three positive steps, which is (fourth−1 choose 2) of them.
  const expected = { 170: [7, 15], 220: [9, 28], 310: [13, 66] };
  for (const [notation, [fourth, count]] of Object.entries(expected)) {
    const tetra = CHORD_PRESETS.filter((p) => p.notation === Number(notation));
    assert.equal(tetra.length, count, `${notation} has ${count} tetrachords`);
    for (const p of tetra) {
      const steps = p.steps.split("-").map(Number);
      assert.equal(steps.length, 3, `${p.id} is three steps`);
      assert.ok(steps.every((n) => n >= 1), `${p.id} has no zero step`);
      assert.equal(steps.reduce((a, b) => a + b, 0), fourth,
        `${p.id} adds up to the fourth`);
      // …and the voices stand on the unison, the two inner degrees and the fourth
      assert.deepEqual(p.voices.map((v) => v.step),
        [0, steps[0], steps[0] + steps[1], fourth], `${p.id} voice degrees`);
      assert.ok(p.voices.every((v) => v.mode === "key"), `${p.id} counts degrees`);
    }
    assert.equal(new Set(tetra.map((p) => p.steps)).size, count, "no duplicates");
  }
});

test("a tetrachord's top voice IS the perfect fourth of its own tuning", () => {
  const cents = (u) => (u * 1200) / UNITS_PER_OCTAVE;
  for (const [notation, table] of [[170, pitchTablePresets[170]],
    [220, pitchTablePresets[220]], [310, pitchTablePresets[310]]]) {
    const p = CHORD_PRESETS.find((q) => q.notation === notation);
    const units = applyChordPreset(p.id).filter((v) => v.on).map((v) => voiceUnits(v, table));
    assert.equal(units.length, 4, "four pitches");
    assert.equal(units[0], 0, "…standing on the root");
    // A fourth is ~498 ¢ in any of these EDOs (17edo's is the widest, 494 ¢).
    assert.ok(Math.abs(cents(units[3]) - 498) < 12,
      `${notation} tetrachord spans a fourth (got ${Math.round(cents(units[3]))} ¢)`);
    for (let i = 1; i < units.length; i++) assert.ok(units[i] > units[i - 1]);
  }
});

test("tetrachords are offered only in their own tuning, and never invert", () => {
  const ids = (index) => new Set(chordPresetsFor({ index }).map((p) => p.id));
  const plain = CHORD_PRESETS.filter((p) => p.notation === undefined);
  assert.equal(chordPresetsFor({ index: 120 }).length, plain.length,
    "12-TET sees the tuning-independent vocabulary and nothing else");
  assert.equal(chordPresetsFor(null).length, plain.length, "…as does no notation at all");
  assert.equal(ids(170).size, plain.length + 15);
  assert.equal(ids(220).size, plain.length + 28);
  assert.equal(ids(310).size, plain.length + 66);
  assert.ok(!ids(220).has("tetra170-3-3-1"), "17-TET's tetrachords stay in 17-TET");
  assert.ok(ids(170).has("major"), "…and the ordinary chords are always there");

  // A tetrachord is a scale segment: inverting it would only scramble it.
  assert.equal(maxInversion("tetra170-3-3-1"), 0);
  assert.deepEqual(applyChordPreset("tetra170-3-3-1", 2), applyChordPreset("tetra170-3-3-1"));
});

test("tetrachord menu labels are the step pattern, plus the source's name", () => {
  const t = (k) => `«${k}»`;
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "major"), t),
    "«chord.preset.major»");
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra170-3-3-1"), t),
    "3-3-1 · ionian (jins ʻAjam)");
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra220-3-3-3"), t),
    "3-3-3 · diatonic · Porcupine, perfectly even");
  // 31edo's chart names nothing, so the pattern stands alone
  assert.equal(chordPresetLabel(CHORD_PRESETS.find((p) => p.id === "tetra310-5-3-5"), t), "5-3-5");
  assert.equal(chordPresetLabel(null, t), "");
});

test("the vocabulary is grouped, named in both languages, and fits the slots", () => {
  const cents = (u) => Math.round((u * 1200) / UNITS_PER_OCTAVE);
  for (const p of CHORD_PRESETS) {
    assert.ok(CHORD_GROUPS.includes(p.group), `${p.id} is in a known group`);
    assert.ok(p.voices.length >= 2 && p.voices.length <= MAX_VOICES, `${p.id} fits six slots`);
    if (p.steps) {
      // A tetrachord is named by its step pattern, in any language (item 141).
      assert.match(p.steps, /^\d+-\d+-\d+$/, `${p.id} carries a step pattern`);
    } else {
      assert.ok(en[p.key], `${p.id} is named in en`);
      assert.ok(ko[p.key], `${p.id} is named in ko`);
    }
    // …and reads bottom to top, which is what makes a preset checkable by eye
    const table = p.notation === undefined ? P12 : pitchTablePresets[p.notation];
    const units = p.voices.map((v) => voiceUnits({ ...defaultVoice(), ...v }, table));
    for (let i = 1; i < units.length; i++) {
      assert.ok(units[i] > units[i - 1], `${p.id} voice ${i} is above voice ${i - 1}`);
    }
  }
  for (const g of CHORD_GROUPS) {
    assert.ok(CHORD_PRESETS.some((p) => p.group === g), `group ${g} has entries`);
    assert.ok(en[`chord.group.${g}`] && ko[`chord.group.${g}`], `group ${g} is named`);
  }
  for (let i = 0; i <= MAX_VOICES - 1; i++) {
    assert.ok(en[`chord.inv${i}`] && ko[`chord.inv${i}`], `inversion ${i} is named`);
  }

  // the added/extended chords put their upper degrees where the degree names
  // say they are: the 9th IS the major second an octave up, and so on
  const of = (id) => applyChordPreset(id).filter((v) => v.on).map((v) => cents(voiceUnits(v, P12)));
  assert.deepEqual(of("add9"), [0, 386, 702, 1404], "add9 = major triad + a ninth");
  assert.deepEqual(of("madd9"), [0, 316, 702, 1404]);
  assert.deepEqual(of("add11"), [0, 386, 702, 1698], "the eleventh is the fourth, up an octave");
  assert.deepEqual(of("six9"), [0, 386, 702, 884, 1404]);
  assert.deepEqual(of("dom13").slice(-1), [2084], "the thirteenth is the sixth, up an octave");
  assert.equal(of("dom13").length, 6, "…and it drops the eleventh to fit");
  assert.equal(of("dom11").length, 5);
  assert.ok(!of("dom11").includes(386), "the eleventh chord drops the third");
  // sus2/sus4 are the same fifth with the third moved either way
  assert.deepEqual(of("sus2"), [0, 204, 702]);
  assert.deepEqual(of("sus4"), [0, 498, 702]);
  // quartal is fourths all the way up: 4/3 then 4/3 of that (16/9)
  assert.deepEqual(of("quartal"), [0, 498, 996]);
});

test("inversions lift the lowest voices an octave and re-sort", () => {
  const cents = (id, inv) => applyChordPreset(id, inv).filter((v) => v.on)
    .map((v) => Math.round((voiceUnits(v, P12) * 1200) / UNITS_PER_OCTAVE));

  // the textbook case: a major triad's root goes on top, then its third
  assert.deepEqual(cents("major", 0), [0, 386, 702]);
  assert.deepEqual(cents("major", 1), [386, 702, 1200]);
  assert.deepEqual(cents("major", 2), [702, 1200, 1586]);
  // a seventh chord has three, and the highest one is the chord over its 7th
  assert.deepEqual(cents("dom7", 3), [969, 1200, 1586, 1902]);

  // every inversion keeps the same PITCH CLASSES — nothing is added or dropped
  for (const p of CHORD_PRESETS) {
    const base = cents(p.id, 0);
    for (let inv = 1; inv <= maxInversion(p.id); inv++) {
      const got = cents(p.id, inv);
      assert.equal(got.length, base.length, `${p.id} inv ${inv} keeps its voice count`);
      const mod = (xs) => xs.map((c) => ((c % 1200) + 1200) % 1200).sort((a, b) => a - b);
      assert.deepEqual(mod(got), mod(base), `${p.id} inv ${inv} keeps its notes`);
      for (let i = 1; i < got.length; i++) {
        assert.ok(got[i] > got[i - 1], `${p.id} inv ${inv} still reads bottom to top`);
      }
    }
  }

  // a chord that already owns its octave lifts PAST it rather than doubling a
  // voice onto one it already has (which would only be a level change)
  assert.deepEqual(cents("power", 0), [0, 702, 1200]);
  assert.deepEqual(cents("power", 1), [702, 1200, 2400]);
  assert.deepEqual(cents("octaves", 1), [0, 1200, 2400]);

  // out of range clamps rather than wrapping: inverting EVERY voice would just
  // be the chord an octave up, so the last real inversion is voices−1
  assert.equal(maxInversion("major"), 2);
  assert.equal(maxInversion("dom13"), 5);
  assert.equal(maxInversion("nonesuch"), 0);
  assert.equal(presetVoiceCount("dom13"), MAX_VOICES);
  assert.deepEqual(cents("major", 9), cents("major", 2));
  assert.deepEqual(cents("major", -3), cents("major", 0));

  // the specs themselves are untouched (the preset table is shared state)
  const before = JSON.stringify(CHORD_PRESETS.find((p) => p.id === "major").voices);
  invertVoiceSpecs(CHORD_PRESETS.find((p) => p.id === "major").voices, 2);
  assert.equal(JSON.stringify(CHORD_PRESETS.find((p) => p.id === "major").voices), before);

  // an inversion is a plain octave on the voice, so it survives every mode
  const det = invertVoiceSpecs([{ mode: "ratio", ratio: 0.994 }, { mode: "ratio", ratio: 1 }], 1);
  assert.deepEqual(det, [{ mode: "ratio", ratio: 1 }, { mode: "ratio", ratio: 0.994, oct: 1 }]);
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
