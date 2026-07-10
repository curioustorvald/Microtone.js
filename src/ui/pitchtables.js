// Pitch-table presets — data port of taut.js pitchTablePresets (taut.js:219-281).
// `table` entries are 4096-TET offsets within one `interval` (0x1000 = octave;
// Bohlen-Pierce uses a tritave). The preset index doubles as the sMet
// `notation` field, so a song's active tuning comes from its metadata.
//
// `sym` carries one 3-char token per degree, transcribed from taut's custom-
// font sym strings into a compact DSL rendered by src/ui/glyphs.js:
//   [0] tick:   ' ' none · '.' Kite big-dot · 'u'/'d' up/down tick ·
//               'U'/'D' double up/down tick
//   [1] letter: A-J note letter (H/J are Bohlen-Pierce)
//   [2] accidental: '-' natural · '#' sharp · 'b' flat · 't' demisharp ·
//               'p' demiflat · 'x' double sharp · 'B' double flat ·
//               '3' triple sharp · 'T' triple flat · '4' quadruple sharp
// Shi'er lü uses single CJK tokens rendered with a conventional font.

export const ANCHOR_NOTE = 0x5000; // C4 — fixed reference for all periods

const SYM_12 = [" C-", " C#", " D-", " D#", " E-", " F-", " F#", " G-", " G#", " A-", " A#", " B-"];
const SYM_24 = [" C-", " Ct", " C#", " Dp", " D-", " Dt", " D#", " Ep", " E-", " Et", " F-", " Ft",
                " F#", " Gp", " G-", " Gt", " G#", " Ap", " A-", " At", " A#", " Bp", " B-", " Bt"];
// 96-TET (Kite): per 24-TET degree emit [big-dot, up, double-up, down-of-next].
const SYM_96 = (() => {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const cur = SYM_24[i].slice(1);
    const nxt = SYM_24[(i + 1) % 24].slice(1);
    out.push("." + cur, "u" + cur, "U" + cur, "d" + nxt);
  }
  return out;
})();

export const pitchTablePresets = {
  0: { index: 0, name: "Raw format", table: [], interval: 0x1000, t: "" },
  10: { index: 10, name: "Octave only", table: [0x0], interval: 0x1000, t: "M", sym: [" C-"] },
  20: { index: 20, name: "2-TET", table: [0x0, 0x800], interval: 0x1000, t: "M", sym: [" C-", " F#"] },
  30: { index: 30, name: "3-TET", table: [0x0, 0x555, 0xaab], interval: 0x1000, t: "M", sym: [" C-", " E-", " G#"] },
  40: { index: 40, name: "4-TET", table: [0x0, 0x400, 0x800, 0xc00], interval: 0x1000, t: "M", sym: [" C-", " D#", " F#", " A-"] },
  50: { index: 50, name: "5-TET", table: [0x0, 0x333, 0x666, 0x99a, 0xccd], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " G-", " A-"] },
  60: { index: 60, name: "6-TET", table: [0x0, 0x2ab, 0x555, 0x800, 0xaab, 0xd55], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " F#", " G#", " A#"] },
  70: { index: 70, name: "7-TET", table: [0x0, 0x249, 0x492, 0x6db, 0x925, 0xb6e, 0xdb7], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " F-", " G-", " A-", " B-"] },
  80: { index: 80, name: "8-TET", table: [0x0, 0x200, 0x400, 0x600, 0x800, 0xa00, 0xc00, 0xe00], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " F-", " F#", " G#", " A-", " B-"] },
  90: { index: 90, name: "9-TET", table: [0x0, 0x1c7, 0x38e, 0x555, 0x71c, 0x8e4, 0xaab, 0xc72, 0xe39], interval: 0x1000, t: "M", sym: [" C-", " D-", " E-", " E#", " F-", " G-", " A-", " B-", " B#"] },
  100: { index: 100, name: "10-TET", table: [0x0, 0x19a, 0x333, 0x4cd, 0x666, 0x800, 0x99a, 0xb33, 0xccd, 0xe66], interval: 0x1000, t: "M", sym: [" C-", " Db", " D-", " Eb", " E-", " E#", " G-", " G#", " A-", " A#"] },
  120: { index: 120, name: "12-TET", table: [0x0, 0x155, 0x2ab, 0x400, 0x555, 0x6ab, 0x800, 0x955, 0xaab, 0xc00, 0xd55, 0xeab], interval: 0x1000, t: "d", sym: SYM_12 },
  150: { index: 150, name: "15-TET", table: [0x0, 0x111, 0x222, 0x333, 0x444, 0x555, 0x666, 0x777, 0x889, 0x99a, 0xaab, 0xbbc, 0xccd, 0xdde, 0xeef], interval: 0x1000, t: "m", sym: [" C-", " C#", " D-", " D#", " Eb", " E-", " E#", " F#", " G-", " G#", " Ab", " A-", " A#", " Bb", " B-"] },
  160: { index: 160, name: "16-TET", table: [0x0, 0x100, 0x200, 0x300, 0x400, 0x500, 0x600, 0x700, 0x800, 0x900, 0xa00, 0xb00, 0xc00, 0xd00, 0xe00, 0xf00], interval: 0x1000, t: "m", sym: [" C-", " C#", " D-", " D#", " E-", " E#", " Fb", " F-", " F#", " G-", " G#", " A-", " A#", " B-", " B#", " Cb"] },
  170: { index: 170, name: "17-TET", table: [0x0, 0xf1, 0x1e2, 0x2d3, 0x3c4, 0x4b5, 0x5a6, 0x697, 0x788, 0x878, 0x969, 0xa5a, 0xb4b, 0xc3c, 0xd2d, 0xe1e, 0xf0f], interval: 0x1000, t: "m", sym: [" C-", " Db", " C#", " D-", " Eb", " D#", " E-", " F-", " Gb", " F#", " G-", " Ab", " G#", " A-", " Bb", " A#", " B-"] },
  190: { index: 190, name: "19-TET", table: [0x0, 0xd8, 0x1af, 0x287, 0x35e, 0x436, 0x50d, 0x5e5, 0x6bd, 0x794, 0x86c, 0x943, 0xa1b, 0xaf3, 0xbca, 0xca2, 0xd79, 0xe51, 0xf28], interval: 0x1000, t: "m", sym: [" C-", " C#", " Db", " D-", " D#", " Eb", " E-", " E#", " F-", " F#", " Gb", " G-", " G#", " Ab", " A-", " A#", " Bb", " B-", " B#"] },
  220: { index: 220, name: "22-TET", table: [0x0, 0xba, 0x174, 0x22f, 0x2e9, 0x3a3, 0x45d, 0x517, 0x5d1, 0x68c, 0x746, 0x800, 0x8ba, 0x974, 0xa2f, 0xae9, 0xba3, 0xc5d, 0xd17, 0xdd1, 0xe8c, 0xf46], interval: 0x1000, t: "m", sym: [" C-", " Ct", " C#", " Dp", " D-", " Dt", " D#", " Ep", " E-", " F-", " Ft", " F#", " Gp", " G-", " Gt", " G#", " Ap", " A-", " At", " A#", " Bp", " B-"] },
  240: { index: 240, name: "24-TET", table: [0x0, 0xab, 0x155, 0x200, 0x2ab, 0x355, 0x400, 0x4ab, 0x555, 0x600, 0x6ab, 0x755, 0x800, 0x8ab, 0x955, 0xa00, 0xaab, 0xb55, 0xc00, 0xcab, 0xd55, 0xe00, 0xeab, 0xf55], interval: 0x1000, t: "m", sym: SYM_24 },
  310: { index: 310, name: "31-TET", table: [0x0, 0x84, 0x108, 0x18c, 0x211, 0x295, 0x319, 0x39d, 0x421, 0x4a5, 0x529, 0x5ad, 0x632, 0x6b6, 0x73a, 0x7be, 0x842, 0x8c6, 0x94a, 0x9ce, 0xa53, 0xad7, 0xb5b, 0xbdf, 0xc63, 0xce7, 0xd6b, 0xdef, 0xe74, 0xef8, 0xf7c], interval: 0x1000, t: "m", sym: [" C-", " Ct", " C#", " Db", " Dp", " D-", " Dt", " D#", " Eb", " Ep", " E-", " Et", " Fp", " F-", " Ft", " F#", " Gb", " Gp", " G-", " Gt", " G#", " Ab", " Ap", " A-", " At", " A#", " Bb", " Bp", " B-", " Bt", " Cp"] },
  410: { index: 410, name: "41-TET (Kite)", table: [0x0, 0x64, 0xc8, 0x12c, 0x190, 0x1f4, 0x257, 0x2bb, 0x31f, 0x383, 0x3e7, 0x44b, 0x4af, 0x513, 0x577, 0x5db, 0x63e, 0x6a2, 0x706, 0x76a, 0x7ce, 0x832, 0x896, 0x8fa, 0x95e, 0x9c2, 0xa25, 0xa89, 0xaed, 0xb51, 0xbb5, 0xc19, 0xc7d, 0xce1, 0xd45, 0xda9, 0xe0c, 0xe70, 0xed4, 0xf38, 0xf9c], interval: 0x1000, t: "m", sym: [".C-", "uC-", "DC#", "dC#", ".C#", "uC#", "dD-", ".D-", "uD-", "DD#", "dD#", ".D#", "uD#", "dE-", ".E-", "uE-", "UE-", ".F-", "uF-", "DF#", "dF#", ".F#", "uF#", "dG-", ".G-", "uG-", "DG#", "dG#", ".G#", "uG#", "dA-", ".A-", "uA-", "DA#", "dA#", ".A#", "uA#", "dB-", ".B-", "uB-", "UB-"] },
  530: { index: 530, name: "53-TET (Kite)", table: [0x0, 0x4d, 0x9b, 0xe8, 0x135, 0x182, 0x1d0, 0x21d, 0x26a, 0x2b8, 0x305, 0x352, 0x39f, 0x3ed, 0x43a, 0x487, 0x4d5, 0x522, 0x56f, 0x5bc, 0x60a, 0x657, 0x6a4, 0x6f2, 0x73f, 0x78c, 0x7d9, 0x827, 0x874, 0x8c1, 0x90e, 0x95c, 0x9a9, 0x9f6, 0xa44, 0xa91, 0xade, 0xb2b, 0xb79, 0xbc6, 0xc13, 0xc61, 0xcae, 0xcfb, 0xd48, 0xd96, 0xde3, 0xe30, 0xe7e, 0xecb, 0xf18, 0xf65, 0xfb3], interval: 0x1000, t: "m", sym: [".C-", "uC-", "UC-", "DC#", "dC#", ".C#", "uC#", "DD-", "dD-", ".D-", "uD-", "UD-", "DD#", "dD#", ".D#", "uD#", "DE-", "dE-", ".E-", "uE-", "UE-", "dF-", ".F-", "uF-", "UF-", "DF#", "dF#", ".F#", "uF#", "DG-", "dG-", ".G-", "uG-", "UG-", "DG#", "dG#", ".G#", "uG#", "DA-", "dA-", ".A-", "uA-", "UA-", "DA#", "dA#", ".A#", "uA#", "DB-", "dB-", ".B-", "uB-", "UB-", "dC-"] },
  531: { index: 531, name: "53-TET (Pythagorean)", table: [0x0, 0x4d, 0x9b, 0xe8, 0x135, 0x182, 0x1d0, 0x21d, 0x26a, 0x2b8, 0x305, 0x352, 0x39f, 0x3ed, 0x43a, 0x487, 0x4d5, 0x522, 0x56f, 0x5bc, 0x60a, 0x657, 0x6a4, 0x6f2, 0x73f, 0x78c, 0x7d9, 0x827, 0x874, 0x8c1, 0x90e, 0x95c, 0x9a9, 0x9f6, 0xa44, 0xa91, 0xade, 0xb2b, 0xb79, 0xbc6, 0xc13, 0xc61, 0xcae, 0xcfb, 0xd48, 0xd96, 0xde3, 0xe30, 0xe7e, 0xecb, 0xf18, 0xf65, 0xfb3], interval: 0x1000, t: "m", sym: [" C-", " B#", " A3", " ET", " Db", " C#", " Bx", " FT", " EB", " D-", " Cx", " B3", " FB", " Eb", " D#", " C3", " GT", " Fb", " E-", " Dx", " C4", " GB", " F-", " E#", " D3", " AT", " Gb", " F#", " Ex", " D4", " AB", " G-", " Fx", " E3", " BT", " Ab", " G#", " F3", " CT", " BB", " A-", " Gx", " F4", " CB", " Bb", " A#", " G3", " DT", " Cb", " B-", " Ax", " G4", " DB"] },
  960: { index: 960, name: "96-TET (Kite)", table: (() => { const t = []; for (let i = 0; i < 96; i++) t.push(Math.round((i * 0x1000) / 96)); return t; })(), interval: 0x1000, t: "m", sym: SYM_96 },
  10121: { index: 10121, name: "Pythagorean dim. 5th", table: [0x0, 0x134, 0x2b8, 0x3ec, 0x570, 0x6a4, 0x7d8, 0x95c, 0xa90, 0xc14, 0xd48, 0xecc], interval: 0x1000, t: "d", sym: SYM_12 },
  10122: { index: 10122, name: "Pythagorean aug. 4th", table: [0x0, 0x134, 0x2b8, 0x3ec, 0x570, 0x6a4, 0x828, 0x95c, 0xa90, 0xc14, 0xd48, 0xecc], interval: 0x1000, t: "d", sym: SYM_12 },
  10123: { index: 10123, name: "Shi'er lü", table: [0x0, 0x184, 0x2b8, 0x43c, 0x570, 0x6f4, 0x828, 0x95c, 0xae0, 0xc14, 0xd98, 0xecc], interval: 0x1000, t: "d", sym: ["\u9EC3", "\u5927", "\u592A", "\u5936", "\u59D1", "\u4EF2", "\u8564", "\u6797", "\u5937", "\u5357", "\u7121", "\u61C9"] },
  35130: { index: 35130, name: "Equal-Tempered Bohlen-Pierce", table: [0x0, 0x1f3, 0x3e7, 0x5da, 0x7ce, 0x9c1, 0xbb4, 0xda8, 0xf9b, 0x118e, 0x1382, 0x1575, 0x1769], interval: 0x195c, t: "M", sym: [" C-", " C#", " D-", " E-", " F-", " F#", " G-", " H-", " H#", " J-", " A-", " A#", " B-"] },
};

/** Preset for an sMet notation value; unknown/absent → 12-TET. */
export function presetForNotation(notation) {
  return pitchTablePresets[notation] ?? pitchTablePresets[120];
}

/**
 * Degree label for a non-12 preset: base-36 degree + octave (period) digit,
 * or null when the note is off-grid (> ±2 units) — caller falls back to the
 * 12-EDO name with a cents marker.
 */
export function noteDegreeLabel(note, preset) {
  if (!preset || preset.index === 120 || preset.table.length === 0) return null;
  const rel = note - ANCHOR_NOTE;
  const k = Math.floor(rel / preset.interval);
  const inPeriod = rel - k * preset.interval;
  let best = -1, bestD = 3;
  for (let i = 0; i < preset.table.length; i++) {
    const d = Math.abs(preset.table[i] - inPeriod);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  const octave = 4 + k;
  if (octave < 0 || octave > 9) return null;
  return best.toString(36).toUpperCase().padStart(2, "0") + octave;
}

/**
 * Resolve a playable note against a preset's symbol table. Always snaps to
 * the NEAREST degree (wrap-aware); notes farther than ±2 units off the grid
 * carry offGrid: true — "out of tune", painted yellow by the glyph painter.
 * Returns null only when the preset has no syms (Raw) or the period is out
 * of display range; else
 *   {cjk, octave, offGrid}              for Shi'er lü tokens, or
 *   {tick, letter, acc, octave, offGrid} decoded from the 3-char token DSL.
 */
export function resolveNoteSymbol(note, preset) {
  if (!preset || !preset.sym || preset.table.length === 0) return null;
  const rel = note - ANCHOR_NOTE;
  let k = Math.floor(rel / preset.interval);
  const inPeriod = rel - k * preset.interval;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < preset.table.length; i++) {
    const d = Math.abs(preset.table[i] - inPeriod);
    if (d < bestD) { bestD = d; best = i; }
  }
  // The next period's root may be closer than the top table entry.
  if (preset.interval - inPeriod < bestD) {
    bestD = preset.interval - inPeriod;
    best = 0;
    k += 1;
  }
  const octave = 4 + k;
  if (octave < 0 || octave > 9) return null;
  const offGrid = bestD > 2;
  const token = preset.sym[best];
  if (token.length === 1) return { cjk: token, octave, offGrid };
  return { tick: token[0], letter: token[1], acc: token[2], octave, offGrid };
}

/**
 * Step a note by `dir` (±1) degrees of the active pitch table: snap to the
 * nearest degree, then move one table entry, wrapping across periods.
 * 12-TET steps a semitone, 24-TET a quarter-tone, etc. The Raw preset
 * (empty table) steps one raw 4096-TET unit.
 */
export function stepNoteInTable(note, preset, dir) {
  if (!preset || preset.table.length === 0) {
    return Math.min(Math.max(note + dir, 0x20), 0xffff);
  }
  const table = preset.table;
  const rel = note - ANCHOR_NOTE;
  let k = Math.floor(rel / preset.interval);
  const inPeriod = rel - k * preset.interval;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - inPeriod);
    if (d < bestD) { bestD = d; best = i; }
  }
  let i = best + dir;
  if (i < 0) { k--; i = table.length - 1; }
  else if (i >= table.length) { k++; i = 0; }
  const out = ANCHOR_NOTE + k * preset.interval + table[i];
  return Math.min(Math.max(out, 0x20), 0xffff);
}

// ── retune tension / harmonic fields (taut.js:340-489) ──
const FIFTH_PC = 0x95a;   // abstract 3:2 fifth in 0x1000-per-octave units
const TONIC_TOL = 0x40;   // narrow tonic neighbourhood for the k=0 tension gate

/** Fifth-circle tonal tension of pitch `p` relative to `tonic` ('cadence'). */
function cadTension(p, tonic, interval) {
  const half = interval >>> 1;
  const d = (((p - tonic) % interval) + interval) % interval;
  const cyclic = d <= half ? d : interval - d;
  let bestT = cyclic <= TONIC_TOL ? cyclic : Infinity;
  for (let k = -6; k <= 6; k++) {
    if (k === 0) continue;
    const target = (((k * FIFTH_PC) % interval) + interval) % interval;
    let dist = Math.abs(d - target);
    if (dist > half) dist = interval - dist;
    const candT = Math.abs(k) * 0x100 + dist;
    if (candT < bestT) bestT = candT;
  }
  return bestT;
}

// Just-intonation attractor field A(P) for the 'harmonic' method: [offset, weight].
const HARM_REFS = [
  [0x0, 1.0], [0x1d2, 4.0], [0x435, 3.0], [0x527, 3.0], [0x6a4, 2.0],
  [0x95b, 2.0], [0xab7, 3.0], [0xbcb, 3.0], [0xd3d, 4.0],
];
function harmonicCost(p, tonic, interval) {
  const half = interval >>> 1;
  const d = (((p - tonic) % interval) + interval) % interval;
  let best = Infinity;
  for (const [off, w] of HARM_REFS) {
    let dist = Math.abs(d - off);
    if (dist > half) dist = interval - dist;
    const cost = w * dist;
    if (cost < best) best = cost;
  }
  return best;
}

/**
 * Retune every pattern note in `song` from `srcPreset` to `newPreset` — the
 * four methods of taut.js retuneAllPatterns (taut.js:522+), ported verbatim:
 *   'pitch'    nearest-note: snap each pitch to the closest new-table entry.
 *   'delta'    nearest-delta: first note nearest-pitch; each later note keeps
 *              the interval from the previous mapped note closest to the
 *              original interval ("preserve the melody's shape").
 *   'cadence'  nearest-cadence: like delta, but scored by how well the mapped
 *              step reproduces the tonal-tension change of the source step.
 *   'harmonic' cadence-aware nearest-harmonic: delta + a duration-weighted
 *              pull toward JI attractors (long notes pull harder).
 * Percussion notes are skipped via percSlots (inst byte14 bit4 / meta byte0
 * bit1). Mutates cells; returns [{pat, row, prev}] for the inverse.
 */
export function retuneAllPatterns(song, newPreset, srcPreset, percSlots, method = "pitch") {
  if (method !== "delta" && method !== "cadence" && method !== "harmonic") method = "pitch";
  const newTable = newPreset.table;
  const newInterval = newPreset.interval;
  if (newTable.length === 0) return [];
  // Tension/harmonic shapes are read from the SOURCE tuning's modular space —
  // they describe the composition the user wrote, not the snap grid.
  const srcInterval = srcPreset?.interval || 0x1000;

  const forEachCandidate = (absRef, fn) => {
    const baseK = Math.floor((absRef - ANCHOR_NOTE) / newInterval);
    for (let dK = -1; dK <= 1; dK++) {
      const root = ANCHOR_NOTE + (baseK + dK) * newInterval;
      for (let i = 0; i < newTable.length; i++) {
        const cand = root + newTable[i];
        if (cand >= 0 && cand <= 0xffff) fn(cand);
      }
      const nextRoot = root + newInterval;
      if (nextRoot >= 0 && nextRoot <= 0xffff) fn(nextRoot);
    }
  };

  const changes = [];
  for (let p = 0; p < song.patterns.length; p++) {
    const ptn = song.patterns[p];
    let prevOrigAbs = -1, prevMappedAbs = 0, tonic = 0;

    // Tonic = the first non-percussion, non-sentinel note in the pattern.
    if (method === "cadence" || method === "harmonic") {
      let runningInst = 0;
      for (let row = 0; row < ptn.length; row++) {
        const cell = ptn[row];
        if (cell.instrment !== 0) runningInst = cell.instrment;
        const note = cell.note;
        if (note >= 0x0000 && note <= 0x001f) continue;
        const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
        if (percSlots && eInst >= 1 && percSlots[eInst]) continue;
        tonic = note;
        break;
      }
    }

    let runningInst = 0;
    for (let row = 0; row < ptn.length; row++) {
      const cell = ptn[row];
      if (cell.instrment !== 0) runningInst = cell.instrment;
      const note = cell.note;
      if (note >= 0x0000 && note <= 0x001f) continue; // sentinels/interrupts
      const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
      if (percSlots && eInst >= 1 && percSlots[eInst]) continue;
      const origAbs = note;
      let newAbs;

      if ((method === "delta" || method === "cadence" || method === "harmonic") && prevOrigAbs >= 0) {
        const targetAbs = prevMappedAbs + (origAbs - prevOrigAbs);
        let targetDeltaT = 0, tMappedPrev = 0, lambda = 0;
        if (method === "cadence") {
          targetDeltaT = cadTension(origAbs, tonic, srcInterval) - cadTension(prevOrigAbs, tonic, srcInterval);
          tMappedPrev = cadTension(prevMappedAbs, tonic, srcInterval);
        } else if (method === "harmonic") {
          let duration = 1; // held length = trailing key-off (0x0001) run
          for (let r = row + 1; r < ptn.length; r++) {
            if (ptn[r].note !== 0x0001) break;
            duration++;
          }
          lambda = 1 - Math.exp(-(duration - 1) / 4);
        }
        let bestAbs = 0, bestScore = Infinity;
        forEachCandidate(targetAbs, (cand) => {
          const pitchErr = Math.abs(cand - targetAbs);
          let score = pitchErr;
          if (method === "cadence") {
            const candDeltaT = cadTension(cand, tonic, srcInterval) - tMappedPrev;
            score = Math.abs(candDeltaT - targetDeltaT) * 2 + pitchErr;
          } else if (method === "harmonic") {
            score = pitchErr + lambda * harmonicCost(cand, tonic, srcInterval);
          }
          if (score < bestScore) { bestScore = score; bestAbs = cand; }
        });
        newAbs = bestAbs;
      } else {
        let bestAbs = 0, bestDist = Infinity;
        forEachCandidate(origAbs, (cand) => {
          const d = Math.abs(cand - origAbs);
          if (d < bestDist) { bestDist = d; bestAbs = cand; }
        });
        newAbs = bestAbs;
      }

      newAbs = Math.min(Math.max(newAbs, 0), 0xffff) & 0xffff;
      if (newAbs !== note) {
        changes.push({ pat: p, row, prev: note });
        cell.note = newAbs;
      }
      prevOrigAbs = origAbs;
      prevMappedAbs = newAbs;
    }
  }
  return changes;
}

/** Nearest-pitch retune (back-compat wrapper). */
export function retuneNearest(song, newPreset, percSlots) {
  return retuneAllPatterns(song, newPreset, null, percSlots, "pitch");
}

/**
 * Transpose every note of ONE pattern, notation-aware:
 *   - table presets: snap to the nearest degree, move `fine` table steps
 *     (wrapping across periods) plus `coarse` whole periods;
 *   - Raw (empty table): `fine` raw 4096-TET note units plus `coarse` periods.
 * Sentinels/interrupts (< 0x20) and percussion instruments are skipped, with
 * the same running-instrument inheritance as retuneAllPatterns. Mutates the
 * cells; returns [{pat, row, prev}] for restoreNotesOp (via bulkNotesOp).
 */
export function transposePatternNotes(song, patIdx, preset, percSlots, fine, coarse) {
  const ptn = song.patterns[patIdx];
  const useTable = preset && preset.table.length > 0;
  const interval = preset?.interval || 0x1000;
  const changes = [];
  let runningInst = 0;
  for (let row = 0; row < ptn.length; row++) {
    const cell = ptn[row];
    if (cell.instrment !== 0) runningInst = cell.instrment;
    const note = cell.note;
    if (note >= 0x0000 && note <= 0x001f) continue; // sentinels/interrupts
    const eInst = cell.instrment !== 0 ? cell.instrment : runningInst;
    if (percSlots && eInst >= 1 && percSlots[eInst]) continue;

    let out;
    if (!useTable) {
      out = note + fine + coarse * interval;
    } else {
      const table = preset.table;
      const rel = note - ANCHOR_NOTE;
      let k = Math.floor(rel / interval);
      const inPeriod = rel - k * interval;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < table.length; i++) {
        const d = Math.abs(table[i] - inPeriod);
        if (d < bestD) { bestD = d; best = i; }
      }
      // the next period's root may be nearer than the top table entry
      if (interval - inPeriod < bestD) { k += 1; best = 0; }
      let idx = best + fine;
      k += Math.floor(idx / table.length) + coarse;
      idx = ((idx % table.length) + table.length) % table.length;
      out = ANCHOR_NOTE + k * interval + table[idx];
    }
    out = Math.min(Math.max(Math.round(out), 0x20), 0xffff);
    if (out !== note) {
      changes.push({ pat: patIdx, row, prev: note });
      cell.note = out;
    }
  }
  return changes;
}
