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
 * Ready-made voicings, all in `ji` mode except `detune` — which demonstrates
 * the manual ratio input, and is the other classic use of this tool (three
 * near-unison copies = a chorus/supersaw in one sample).
 */
export const CHORD_PRESETS = [
  { id: "major",   key: "chord.preset.major",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }] },
  { id: "minor",   key: "chord.preset.minor",   voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }] },
  { id: "sus4",    key: "chord.preset.sus4",    voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "3/2" }] },
  { id: "dim",     key: "chord.preset.dim",     voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }] },
  { id: "aug",     key: "chord.preset.aug",     voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "8/5" }] },
  { id: "maj7",    key: "chord.preset.maj7",    voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "15/8" }] },
  { id: "min7",    key: "chord.preset.min7",    voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/5" }] },
  { id: "dom7",    key: "chord.preset.dom7",    voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }] },
  { id: "power",   key: "chord.preset.power",   voices: [{ ji: "1/1" }, { ji: "3/2" }, { ji: "1/1", oct: 1 }] },
  { id: "octaves", key: "chord.preset.octaves", voices: [{ ji: "1/1", oct: -1 }, { ji: "1/1" }, { ji: "1/1", oct: 1 }] },
  { id: "detune",  key: "chord.preset.detune",  voices: [
    { mode: "ratio", ratio: 0.994 }, { mode: "ratio", ratio: 1 }, { mode: "ratio", ratio: 1.006 },
  ] },
];

/** Six voice slots for a chord-preset id; unused slots stay off. */
export function applyChordPreset(presetId) {
  const preset = CHORD_PRESETS.find((p) => p.id === presetId);
  const out = [];
  for (let i = 0; i < MAX_VOICES; i++) {
    const spec = preset?.voices[i];
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
