// Chord maker (item 89) — build a CHORDED sample by mixing pitch-shifted
// copies of an existing one, the old Amiga trick: one Paula channel can only
// play one sample, so trackers baked the chord into the sample itself.
//
// Pure float-domain computation (no DOM, Node-tested). Everything funnels
// through ONE canonical quantity: a voice's pitch offset in 4096-TET units
// (0x1000 = octave), the project's native pitch unit. The three "mods" of the
// TODO are just three ways of naming that offset —
//   ji     a named just ratio (always available, tuning-independent)
//   key    N degrees of the CURRENT project notation (24-TET has more
//          options than 12-TET, by construction)
//   ratio  a raw playback ratio, 2.0 = an octave up   ┐ the two manual
//   units  a raw 4096-TET offset, e.g. 0x100          ┘ input styles
// — plus a per-voice `oct` (×2^n) that every mode shares, so voicing a chord
// never means hunting through the interval list for "a fifth, two octaves up".
// Modes are per voice: voice 1 can be a just fifth while voice 2 counts
// degrees and voice 3 types a ratio.
//
// Playback ratio r = 2^(units/4096); a copy pitched up by r plays r× faster,
// i.e. resample(buf, 1/r) — which also anti-aliases on the way up, since the
// Kaiser-sinc cutoff follows the ratio (wavelab.js).

import { MIDDLE_C } from "../engine/constants.js";
import { resample, normaliseRange } from "./wavelab.js";

export const UNITS_PER_OCTAVE = 0x1000;
export const MAX_VOICES = 6;
/** Pitch travel a voice may ask for, either way. Four octaves up already means
 *  a 16× oversized working buffer when a voice also runs four octaves down. */
export const MAX_UNITS = 4 * UNITS_PER_OCTAVE;

/**
 * Named just intervals, ascending within one octave. `id` is the stable key
 * (presets, saved state, tests); `key` is the i18n name. Anything outside the
 * octave is reached with the voice's `oct` field rather than a longer list.
 */
export const JI_INTERVALS = [
  { id: "1/1",   num: 1,  den: 1,  key: "chord.ji.unison" },
  { id: "16/15", num: 16, den: 15, key: "chord.ji.min2" },
  { id: "9/8",   num: 9,  den: 8,  key: "chord.ji.maj2" },
  { id: "7/6",   num: 7,  den: 6,  key: "chord.ji.sep3" },
  { id: "6/5",   num: 6,  den: 5,  key: "chord.ji.min3" },
  { id: "5/4",   num: 5,  den: 4,  key: "chord.ji.maj3" },
  { id: "9/7",   num: 9,  den: 7,  key: "chord.ji.sepMaj3" },
  { id: "4/3",   num: 4,  den: 3,  key: "chord.ji.fourth" },
  { id: "11/8",  num: 11, den: 8,  key: "chord.ji.und4" },
  { id: "7/5",   num: 7,  den: 5,  key: "chord.ji.sepTt" },
  { id: "45/32", num: 45, den: 32, key: "chord.ji.aug4" },
  { id: "3/2",   num: 3,  den: 2,  key: "chord.ji.fifth" },
  { id: "8/5",   num: 8,  den: 5,  key: "chord.ji.min6" },
  { id: "5/3",   num: 5,  den: 3,  key: "chord.ji.maj6" },
  { id: "7/4",   num: 7,  den: 4,  key: "chord.ji.harm7" },
  { id: "16/9",  num: 16, den: 9,  key: "chord.ji.pyth7" },
  { id: "9/5",   num: 9,  den: 5,  key: "chord.ji.min7" },
  { id: "15/8",  num: 15, den: 8,  key: "chord.ji.maj7" },
  { id: "2/1",   num: 2,  den: 1,  key: "chord.ji.octave" },
];

export function jiById(id) {
  return JI_INTERVALS.find((iv) => iv.id === id) ?? JI_INTERVALS[0];
}

/** A single silent-by-default voice slot. */
export function defaultVoice() {
  return { on: false, mode: "ji", ji: "1/1", step: 0, ratio: 1, units: 0, oct: 0, gainDb: 0 };
}

/** Six voice slots seeded with `preset`'s voices (a chord-preset id). */
export function defaultVoices(presetId = "major") {
  return applyChordPreset(presetId);
}

/**
 * The order the preset menus group their entries in — one optgroup each, so a
 * vocabulary this size stays readable in a `<select>`.
 */
export const CHORD_GROUPS = ["triad", "seventh", "added", "extended", "spread"];

/**
 * Ready-made voicings, all in `ji` mode except `detune` — which demonstrates
 * the manual ratio input, and is the other classic use of this tool (three
 * near-unison copies = a chorus/supersaw in one sample).
 *
 * Notes ABOVE the octave are the plain interval plus `oct: 1`: a ninth is the
 * major second an octave up, an eleventh the fourth, a thirteenth the sixth —
 * which is what those degrees mean, and it keeps JI_INTERVALS one octave long.
 * Voices are listed ASCENDING; nothing depends on it (inversions sort), but a
 * preset that reads bottom-to-top is a preset you can check by eye.
 *
 * Six slots is the ceiling, so the tall chords omit what a keyboard player
 * omits: the eleventh drops the third, the thirteenth drops the eleventh.
 */
export const CHORD_PRESETS = [
  // ── triads ──
  { id: "major",   group: "triad", key: "chord.preset.major",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }] },
  { id: "minor",   group: "triad", key: "chord.preset.minor",   voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }] },
  { id: "sus2",    group: "triad", key: "chord.preset.sus2",    voices: [{ ji: "1/1" }, { ji: "9/8" }, { ji: "3/2" }] },
  { id: "sus4",    group: "triad", key: "chord.preset.sus4",    voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "3/2" }] },
  { id: "dim",     group: "triad", key: "chord.preset.dim",     voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }] },
  { id: "aug",     group: "triad", key: "chord.preset.aug",     voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "8/5" }] },
  // ── sevenths ──
  { id: "maj7",    group: "seventh", key: "chord.preset.maj7",    voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "15/8" }] },
  { id: "dom7",    group: "seventh", key: "chord.preset.dom7",    voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }] },
  { id: "min7",    group: "seventh", key: "chord.preset.min7",    voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/5" }] },
  { id: "minmaj7", group: "seventh", key: "chord.preset.minmaj7", voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "15/8" }] },
  { id: "halfdim", group: "seventh", key: "chord.preset.halfdim", voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }, { ji: "9/5" }] },
  { id: "dim7",    group: "seventh", key: "chord.preset.dim7",    voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }, { ji: "5/3" }] },
  { id: "sus7",    group: "seventh", key: "chord.preset.sus7",    voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "3/2" }, { ji: "7/4" }] },
  // ── sixths and added notes ──
  { id: "maj6",    group: "added", key: "chord.preset.maj6",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "5/3" }] },
  { id: "min6",    group: "added", key: "chord.preset.min6",   voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "5/3" }] },
  { id: "add9",    group: "added", key: "chord.preset.add9",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "9/8", oct: 1 }] },
  { id: "madd9",   group: "added", key: "chord.preset.madd9",  voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/8", oct: 1 }] },
  { id: "add11",   group: "added", key: "chord.preset.add11",  voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "4/3", oct: 1 }] },
  { id: "six9",    group: "added", key: "chord.preset.six9",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "5/3" }, { ji: "9/8", oct: 1 }] },
  // ── extended ──
  { id: "maj9",    group: "extended", key: "chord.preset.maj9",  voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "15/8" }, { ji: "9/8", oct: 1 }] },
  { id: "dom9",    group: "extended", key: "chord.preset.dom9",  voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }, { ji: "9/8", oct: 1 }] },
  { id: "min9",    group: "extended", key: "chord.preset.min9",  voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/5" }, { ji: "9/8", oct: 1 }] },
  { id: "dom11",   group: "extended", key: "chord.preset.dom11", voices: [{ ji: "1/1" }, { ji: "3/2" }, { ji: "7/4" }, { ji: "9/8", oct: 1 }, { ji: "4/3", oct: 1 }] },
  { id: "dom13",   group: "extended", key: "chord.preset.dom13", voices: [
    { ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }, { ji: "9/8", oct: 1 }, { ji: "5/3", oct: 1 },
  ] },
  // ── spreads: no third to speak of, so no quality either ──
  { id: "power",   group: "spread", key: "chord.preset.power",   voices: [{ ji: "1/1" }, { ji: "3/2" }, { ji: "1/1", oct: 1 }] },
  { id: "quartal", group: "spread", key: "chord.preset.quartal", voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "16/9" }] },
  { id: "octaves", group: "spread", key: "chord.preset.octaves", voices: [{ ji: "1/1", oct: -1 }, { ji: "1/1" }, { ji: "1/1", oct: 1 }] },
  { id: "detune",  group: "spread", key: "chord.preset.detune",  voices: [
    { mode: "ratio", ratio: 0.994 }, { mode: "ratio", ratio: 1 }, { mode: "ratio", ratio: 1.006 },
  ] },
];

/** The preset entry for an id, or null — an unknown id is silence, not a throw. */
export function chordPresetById(presetId) {
  return CHORD_PRESETS.find((p) => p.id === presetId) ?? null;
}

/** How many voices a preset sounds — the inversion selector's ceiling. */
export function presetVoiceCount(presetId) {
  return chordPresetById(presetId)?.voices.length ?? 0;
}

/** Highest inversion a preset has: the Nth lifts N voices, and lifting them
 *  all is just the same chord an octave up. */
export function maxInversion(presetId) {
  return Math.max(0, presetVoiceCount(presetId) - 1);
}

/**
 * A voice list inverted, in the textbook sense: the Nth inversion lifts the N
 * lowest voices an octave each, over the top of the chord, so it keeps its
 * notes and changes which one is in the bass. Out-of-range values are clamped
 * rather than wrapped (a "6th inversion" of a triad is not a thing).
 *
 * Ordering is by sounding pitch with NO pitch table in hand: every preset is
 * written in `ji`/`ratio` mode, whose offsets are notation-independent, so the
 * bass voice is the same one in every tuning. The result is re-sorted, which is
 * what keeps the voice rows reading bottom-to-top after the lift.
 *
 * A chord that already contains its own octave (power, octaves) would land the
 * lifted voice exactly on one it already has — a second copy of the same sample
 * at the same pitch, which is a level change and nothing else — so the lift
 * carries on up until the voice is its own note again.
 */
export function invertVoiceSpecs(specs, inversion = 0) {
  const n = Math.min(Math.max(Math.round(inversion) || 0, 0), Math.max(0, specs.length - 1));
  if (n === 0) return specs.slice();
  const ranked = specs
    .map((spec) => ({ spec, u: voiceUnits({ ...defaultVoice(), ...spec }, null) }))
    .sort((a, b) => a.u - b.u);
  const taken = (u, self) => ranked.some((e, j) => j !== self && Math.abs(e.u - u) < 1);
  for (let i = 0; i < n; i++) {
    let octs = 1;
    while (octs < 4 && taken(ranked[i].u + octs * UNITS_PER_OCTAVE, i)) octs++;
    ranked[i] = {
      spec: { ...ranked[i].spec, oct: (ranked[i].spec.oct ?? 0) + octs },
      u: ranked[i].u + octs * UNITS_PER_OCTAVE,
    };
  }
  ranked.sort((a, b) => a.u - b.u);
  return ranked.map((e) => e.spec);
}

/** Six voice slots for a chord-preset id, in its `inversion`th inversion;
 *  unused slots stay off. */
export function applyChordPreset(presetId, inversion = 0) {
  const preset = chordPresetById(presetId);
  const specs = preset ? invertVoiceSpecs(preset.voices, inversion) : [];
  const out = [];
  for (let i = 0; i < MAX_VOICES; i++) {
    const spec = specs[i];
    out.push(spec ? { ...defaultVoice(), on: true, ...spec } : defaultVoice());
  }
  return out;
}

/**
 * Pitch offset, in 4096-TET units, of `d` degrees of `preset`'s pitch table
 * counted from unison (degree 0 = the table entry at Middle C).
 *
 * Kept local rather than reaching for pitchtables.stepNoteInTable: doc/ must
 * not import from ui/, and a chord voice steps by a WHOLE offset in one go
 * (walking one degree at a time would be the same arithmetic, slower).
 *   - lattice preset  degrees wrap into periods, so 13 degrees of 12-TET is an
 *                     octave + a semitone (and 14 of Bohlen-Pierce a tritave +
 *                     one step — periods are not assumed to be octaves);
 *   - absolute preset (interval 0, e.g. ProTracker) the table IS the complete
 *                     note list, so degrees clamp at its ends instead;
 *   - empty table     (Raw) one degree = one raw 4096-TET unit, matching what
 *                     the transpose dialogs do with no notation to lean on.
 */
export function degreeUnits(preset, d) {
  const table = preset?.table ?? [];
  d = Math.round(d) || 0;
  if (table.length === 0) return d;
  if (!preset.interval) {
    const base = preset.base ?? MIDDLE_C;
    let i0 = 0, bestD = Infinity;
    for (let i = 0; i < table.length; i++) {
      const dist = Math.abs(base + table[i] - MIDDLE_C);
      if (dist < bestD) { bestD = dist; i0 = i; }
    }
    const i = Math.min(Math.max(i0 + d, 0), table.length - 1);
    return base + table[i] - MIDDLE_C;
  }
  const n = table.length;
  const k = Math.floor(d / n);
  return k * preset.interval + table[d - k * n];
}

/** A voice's total pitch offset in 4096-TET units (clamped to ±MAX_UNITS). */
export function voiceUnits(voice, preset) {
  if (!voice) return 0;
  let u = (Math.round(voice.oct ?? 0) || 0) * UNITS_PER_OCTAVE;
  switch (voice.mode) {
    case "key":
      u += degreeUnits(preset, voice.step ?? 0);
      break;
    case "ratio": {
      const r = Number(voice.ratio);
      u += Number.isFinite(r) && r > 0 ? UNITS_PER_OCTAVE * Math.log2(r) : 0;
      break;
    }
    case "units": {
      const v = Number(voice.units);
      u += Number.isFinite(v) ? v : 0;
      break;
    }
    default: {
      const iv = jiById(voice.ji);
      u += UNITS_PER_OCTAVE * Math.log2(iv.num / iv.den);
    }
  }
  return Math.min(Math.max(u, -MAX_UNITS), MAX_UNITS);
}

/** Playback ratio of a voice (2.0 = an octave up). */
export function voiceRatio(voice, preset) {
  return Math.pow(2, voiceUnits(voice, preset) / UNITS_PER_OCTAVE);
}

/** Note word a voice sounds when the root sounds Middle C — what the UI paints
 *  through the ordinary note-cell glyph painter, so the reading is the same one
 *  the pattern grid gives. */
export function voiceNote(voice, preset) {
  return Math.min(Math.max(Math.round(MIDDLE_C + voiceUnits(voice, preset)), 0x20), 0xffff);
}

export const activeVoices = (voices) => (voices ?? []).filter((v) => v && v.on !== false);

/**
 * Frames the mix will occupy, without building it. `lengthMode`:
 *   "longest"  the slowest (lowest) voice sets the length — a one-shot keeps
 *              its whole tail whatever the chord does to it;
 *   "source"   the source length, cropping the low voices — what you want when
 *              the result is going to be looped, or fed back into a sampler
 *              slot whose length matters.
 */
export function chordLength(srcLen, voices, preset, lengthMode = "longest") {
  if (lengthMode === "source") return srcLen;
  let out = 0;
  for (const v of activeVoices(voices)) {
    out = Math.max(out, Math.max(1, Math.floor(srcLen / voiceRatio(v, preset))));
  }
  return out || srcLen;
}

const dbToLin = (db) => Math.pow(10, (Number(db) || 0) / 20);

/**
 * Mix the chord. Returns {data, peak, voices} where `peak` is the mix's peak
 * BEFORE any normalisation (the UI reports it as headroom: six copies at unity
 * clip long before the 8-bit quantiser sees them) and `voices` is how many
 * sounded. `normalise` scales the result to full scale afterwards, which is
 * the sane default — the pool format is 8-bit and every dB counts.
 */
export function buildChord(buf, voices, preset, { normalise = true, lengthMode = "longest" } = {}) {
  const active = activeVoices(voices);
  const outLen = active.length === 0
    ? 0
    : Math.max(1, Math.min(chordLength(buf.length, active, preset, lengthMode), 1 << 24));
  const out = new Float32Array(outLen);
  for (const v of active) {
    const r = voiceRatio(v, preset);
    const part = Math.abs(r - 1) < 1e-9 ? buf : resample(buf, 1 / r);
    const gain = dbToLin(v.gainDb);
    const n = Math.min(outLen, part.length);
    for (let i = 0; i < n; i++) out[i] += part[i] * gain;
  }
  let peak = 0;
  for (let i = 0; i < outLen; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  return {
    data: normalise && peak > 0 ? normaliseRange(out, 0, outLen) : out,
    peak,
    voices: active.length,
  };
}
