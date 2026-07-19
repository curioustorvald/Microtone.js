// Pattern-cell edit interpreter — pure functions (Node-testable), glued to the
// canvas views by timeline.js. Column model per cell:
//   sub 0 = note, 1 = instrument (2 nibbles), 2 = volume (2 nibbles),
//   sub 3 = effect opcode (base-36), 4 = effect arg (4 nibbles).
// The jam map mirrors taut.js SC_JAM: physical-position piano on the A-row
// (KeyA..KeyK white, KeyW/E/T/Y/U black) — layout-independent via e.code.

import { MIDDLE_C } from "../engine/constants.js";
import { stepNoteInTable } from "./pitchtables.js";

export const SUB_NOTE = 0;
export const SUB_INST = 1;
export const SUB_VOL = 2;
export const SUB_PAN = 3;
export const SUB_FX_OP = 4;
export const SUB_FX_ARG = 5;
export const NUM_SUBS = 6;
export const SUB_NIBBLES = [1, 2, 2, 2, 1, 4];

// ── shared cell layout (Timeline + Pattern views) ──
// "♯C-4 01 v3F p20 A0F00": note glyphs 0-3, inst 5-6, vol 8-10, pan 12-14,
// fx 16-20 → 21 chars per cell.
export const CELL_CHARS = 21;

/**
 * Lookahead-scroll (item 42): given a cursor position, the current scroll
 * offset, the number of visible cells and the max scroll, return the new scroll
 * so the cursor stays inside the central 64% of the viewport — the view scrolls
 * only when the cursor enters the 18% edge band, and just enough to return it to
 * that band's boundary. Within the band the scroll is unchanged (keeps any
 * fractional wheel offset). Used by every grid view's cursor-follow.
 */
export function lookahead(pos, scroll, vis, maxScroll) {
  const clamp = (v) => Math.min(Math.max(v, 0), Math.max(0, maxScroll));
  if (vis <= 0) return clamp(scroll);
  const edge = Math.max(1, Math.floor(vis * 0.18));
  const top = Math.floor(scroll);
  if (pos < top + edge) return clamp(pos - edge);
  if (pos > top + vis - 1 - edge) return clamp(pos - (vis - 1 - edge));
  return clamp(scroll); // cursor already inside the central 64%
}

/** Cursor sub-position walk order within one channel: [sub, nib] pairs. */
export const SUB_POSITIONS = [];
for (let sub = 0; sub < SUB_NIBBLES.length; sub++) {
  for (let nib = 0; nib < SUB_NIBBLES[sub]; nib++) SUB_POSITIONS.push([sub, nib]);
}

/**
 * Is the given sub-column of `cell` empty — i.e. rendered as dots? Wheel-edit
 * skips empty sub-columns, so a wheel tick over a dot only scrolls the view and
 * never conjures a value out of nothing. The dot conditions mirror the painters
 * (timeline.js / pattern.js) and the *ToStr helpers in notenames.js.
 *   note: only a pitched note (>= 0x20) is wheel-steppable — 0, sentinels,
 *         reserved and interrupt words all count as "nothing to step" here.
 *   fx  : the opcode + arg share one visual column, empty only when both are 0.
 */
export function subIsEmpty(sub, cell) {
  switch (sub) {
    case SUB_NOTE: return cell.note < 0x20;
    case SUB_INST: return cell.instrment === 0;
    case SUB_VOL: return cell.volumeEff === 3 && cell.volume === 0;
    case SUB_PAN: return cell.panEff === 3 && cell.pan === 0;
    case SUB_FX_OP:
    case SUB_FX_ARG: return cell.effect === 0 && cell.effectArg === 0;
    default: return true;
  }
}

/** Character offset + width of a sub-position inside the cell. */
export function subCharPos(sub, nib) {
  switch (sub) {
    case SUB_NOTE: return [0, 4];         // 4 glyph slots
    case SUB_INST: return [5 + nib, 1];
    case SUB_VOL: return [9 + nib, 1];    // char 8 is the selector prefix
    case SUB_PAN: return [13 + nib, 1];   // char 12 is the selector prefix
    case SUB_FX_OP: return [16, 1];
    case SUB_FX_ARG: return [17 + nib, 1];
    default: return [0, 1];
  }
}

// ── logical clipboard columns ──
// Coarser than the six sub-cursor positions: note / inst / vol / pan / fx (the
// effect opcode + arg are ONE column). Block copy/paste records which of these
// a selection covers, so a partial-column paste overwrites only those bytes.
export const COL_NOTE = 0, COL_INST = 1, COL_VOL = 2, COL_PAN = 3, COL_FX = 4;
export const ALL_COLS = [COL_NOTE, COL_INST, COL_VOL, COL_PAN, COL_FX];
/** Raw cell byte offsets each logical column occupies. */
export const COL_BYTES = [[0, 1], [2], [3], [4], [5, 6, 7]];
/** Inclusive [startChar, endChar] span of each column within the cell (for the
 *  selection highlight); contiguous, covering all CELL_CHARS. */
export const COL_CHAR_RANGE = [[0, 5], [5, 8], [8, 12], [12, 16], [16, 21]];

/** Logical column of a sub-cursor position (fx-op and fx-arg → COL_FX). */
export function subToCol(sub) { return sub <= COL_PAN ? sub : COL_FX; }

/** Logical column ids spanned by an inclusive sub-cursor range [subA..subB]. */
export function colsForSubs(subA, subB) {
  const lo = subToCol(Math.min(subA, subB)), hi = subToCol(Math.max(subA, subB));
  const cols = [];
  for (let c = lo; c <= hi; c++) cols.push(c);
  return cols;
}

/** Map a character offset within a cell to [sub, nib]. */
export function charToSub(charX) {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  if (charX >= 17) return [SUB_FX_ARG, clamp(Math.floor(charX - 17), 0, 3)];
  if (charX >= 16) return [SUB_FX_OP, 0];
  if (charX >= 12) return [SUB_PAN, clamp(Math.floor(charX - 13), 0, 1)];
  if (charX >= 8) return [SUB_VOL, clamp(Math.floor(charX - 9), 0, 1)];
  if (charX >= 5) return [SUB_INST, clamp(Math.floor(charX - 5), 0, 1)];
  return [SUB_NOTE, 0];
}

// Physical piano rows (KeyboardEvent.code → semitone offset from C).
// White: a s d f g h j k → C D E F G A B +C; black: w e t y u.
export const JAM_SEMIS = Object.freeze({
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12,
});

/** Whether the note column is showing raw hex words (the Raw toggle is on, or
 *  the notation preset is Raw — no degree table). When true the note column
 *  accepts raw hex entry instead of the piano jam / sentinels. */
export function rawNoteView(rawToggle, preset) {
  return !!rawToggle || !preset || preset.table.length === 0;
}

/** 12-EDO note word for semitone offset from C at `octave` (C4 = MIDDLE_C). */
export function semiToNote(octave, semi) {
  const val = MIDDLE_C + (octave - 4) * 4096 + Math.round((semi * 4096) / 12);
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/**
 * Notation-aware jam note: map a 12-EDO semitone (0..12 white/black keys) to a
 * note word in the active pitch table by snapping the semitone's fractional
 * period position to the NEAREST table degree — the port of taut.js
 * semitoneToNote. So a non-12-TET song's keyboard plays that tuning's degrees
 * (CDEFGAB… mapped into its grid) instead of fixed 12-EDO. The Raw preset
 * (empty table) and 12-TET fall back to the exact 12-EDO note.
 */
export function semiToNoteInTable(octave, semi, preset) {
  if (!preset || preset.table.length === 0 || preset.index === 120) {
    return semiToNote(octave, semi);
  }
  const interval = preset.interval;
  const table = preset.table;
  let pos = Math.round((semi / 12) * interval);
  let carry = 0;
  while (pos >= interval) { pos -= interval; carry++; } // semitone 12 wraps to next period root
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - pos);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  // The next period's root (one interval up) can be the true nearest degree.
  let off = table[bestIdx], periodAdj = carry;
  if (interval - pos < bestDist) { off = table[0]; periodAdj = carry + 1; }
  const val = MIDDLE_C + (octave - 4) * interval + periodAdj * interval + off;
  return Math.min(Math.max(val, 0x20), 0xffff);
}

/** Next/previous selectable instrument slot from `cur`, stepping by `step`
 *  (+1 = up, -1 = down) through the ascending `slots` list. Off-list current
 *  values jump to the nearest slot in the step direction. Null if none. */
function stepInstSlot(cur, step, slots) {
  if (!slots || slots.length === 0) return null;
  cur &= 0xff;
  const i = slots.indexOf(cur);
  if (i < 0) {
    if (step > 0) return slots.find((s) => s > cur) ?? slots[slots.length - 1];
    for (let k = slots.length - 1; k >= 0; k--) if (slots[k] < cur) return slots[k];
    return slots[0];
  }
  return slots[Math.min(Math.max(i + step, 0), slots.length - 1)];
}

/**
 * Contextual bracket-key edit (items 47.2 + 47.6). `dir` is -1 for '[' / +1 for
 * ']'; `shift` selects the '{' / '}' variant. This handles ONLY the record-mode,
 * cursor-on-a-column edits; the not-record global bindings ([ ] octave, { }
 * instrument) live in app.js. Per-column behaviour (following the 47.6 table,
 * with the note column overridden by the 47.2 choice — octave / semitone):
 *   note: [ ] octave down/up      · Shift {} one semitone/step down/up
 *   inst: [ prev inst · ] next    · Shift same
 *   vol : [ vol- · ] vol+         · Shift {} FINE selector, value ∓1
 *   pan : [ pan- (L) · ] pan+ (R) · Shift {} FINE selector, ∓1 toward L/R
 *   fx  : no-op
 * ctx: { preset, instSlots } (instSlots = ascending selectable slots).
 * Returns { fields } for setCellOp, or null (unhandled / nothing to change).
 */
export function interpretBracketKey(dir, shift, sub, cell, ctx) {
  const clampV = (v) => (v < 0 ? 0 : v > 0x3f ? 0x3f : v);
  switch (sub) {
    case SUB_NOTE: {
      if (cell.note < 0x20) return null; // sentinel / empty: no pitch to nudge
      const interval = ctx.preset?.interval || 0x1000;
      const note = shift
        ? stepNoteInTable(cell.note, ctx.preset, dir)                        // semitone/step
        : Math.min(Math.max(cell.note + dir * interval, 0x20), 0xffff);      // octave/period
      return note === cell.note ? null : { fields: { note } };
    }
    case SUB_INST: {
      // '[' = prev instrument (dn), ']' = next (up). '{'/'}' behave the same.
      const instrment = stepInstSlot(cell.instrment, dir > 0 ? +1 : -1, ctx.instSlots);
      return instrment == null || instrment === cell.instrment ? null : { fields: { instrment } };
    }
    case SUB_VOL: {
      const empty = cell.volumeEff === 3 && cell.volume === 0;
      if (shift) { // FINE selector, value ∓1
        const base = empty ? 0x20 : cell.volume;
        return { fields: { volume: clampV(base + dir), volumeEff: 3 } };
      }
      if (empty) return { fields: { volume: 0x20, volumeEff: 0 } };  // default set
      // '[' = quieter, ']' = louder (so value += dir).
      return { fields: { volume: clampV(cell.volume + dir), volumeEff: cell.volumeEff } };
    }
    case SUB_PAN: {
      const empty = cell.panEff === 3 && cell.pan === 0;
      if (shift) { // FINE selector, ∓1 toward L / R
        const base = empty ? 0x20 : cell.pan;
        return { fields: { pan: clampV(base + dir), panEff: 3 } };
      }
      if (empty) return { fields: { pan: 0x20, panEff: 0 } };  // default centre
      // '[' = toward L (pan-), ']' = toward R (pan+).
      return { fields: { pan: clampV(cell.pan + dir), panEff: cell.panEff } };
    }
    default: return null; // fx op/arg: no-op
  }
}

function hexDigit(key) {
  if (key.length !== 1) return -1;
  const c = key.toLowerCase().charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

function base36Digit(key) {
  if (key.length !== 1) return -1;
  const c = key.toLowerCase().charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 122) return c - 87;
  return -1;
}

/**
 * Interpret an edit-mode keydown against a cell column.
 * @param ev   {code, key} from the KeyboardEvent
 * @param sub  cursor sub-column, nib nibble index within it
 * @param cell current TaudPlayData (read-only here)
 * @param ctx  {octave, currentInst, preset} — preset = active pitch table
 * @returns null (unhandled) or an action:
 *   {fields, jamNote?, advanceRow?, advanceNib?} — fields go through setCellOp;
 *   advanceRow steps the cursor down (note entry / field completion),
 *   advanceNib moves within the field.
 */
export function interpretEditKey(ev, sub, nib, cell, ctx) {
  const { code, key } = ev;

  if (sub === SUB_NOTE) {
    // Raw hex note entry — active whenever the note column shows raw hex words
    // (Raw toggle on, or a Raw notation preset). Hex digits shift into the
    // 16-bit note word (left-to-right), OVERRIDING the piano jam, the sentinels
    // and any other note-column key; non-hex keys are swallowed so nothing jams.
    if (ctx.rawHex) {
      if (code === "Delete" || code === "Period") {
        return { fields: { note: 0, instrment: 0 }, advanceRow: true };
      }
      const d = hexDigit(key);
      if (d < 0) return { consumed: true }; // swallow (no jam / no sentinel), no edit
      return { fields: { note: ((cell.note << 4) | d) & 0xffff } };
    }
    if (code in JAM_SEMIS) {
      const note = semiToNoteInTable(ctx.octave, JAM_SEMIS[code], ctx.preset);
      const fields = { note };
      // Current-instrument auto-adopt (taut behaviour): note entry stamps the
      // active instrument unless the cell already carries one.
      if (ctx.currentInst > 0) fields.instrment = ctx.currentInst;
      return { fields, jamNote: note, advanceRow: true };
    }
    switch (code) {
      // Sentinels: taut z/x/c/v (and ` for key-off), inserted not auditioned.
      // Digit 1/2/3 were removed (item 47.3): they clashed with hex input on the
      // note column; ` is kept because other trackers use it for key-off.
      case "Backquote": case "KeyZ": return { fields: { note: 0x0001 }, advanceRow: true }; // key-off
      case "KeyX": return { fields: { note: 0x0002 }, advanceRow: true };    // note cut
      case "KeyC": return { fields: { note: 0x0003 }, advanceRow: true };    // note fade
      case "KeyV": return { fields: { note: 0x0004 }, advanceRow: true };    // fast fade
      case "Delete": case "Period":
        return { fields: { note: 0, instrment: 0 }, advanceRow: true };
    }
    return null;
  }

  if (sub === SUB_INST) {
    if (code === "Delete" || code === "Period") {
      return { fields: { instrment: 0 }, advanceRow: true };
    }
    const d = hexDigit(key);
    if (d < 0) return null;
    const cur = cell.instrment & 0xff;
    const val = nib === 0 ? ((d << 4) | (cur & 0x0f)) : ((cur & 0xf0) | d);
    return nib === 0
      ? { fields: { instrment: val }, advanceNib: true }
      : { fields: { instrment: val }, advanceRow: true };
  }

  if (sub === SUB_VOL) {
    if (code === "Delete" || code === "Period") {
      // vol-column no-op sentinel: SEL_FINE(3) with value 0
      return { fields: { volume: 0, volumeEff: 3 }, advanceRow: true };
    }
    // selector prefixes: v = SET, + = slide-up, - = slide-down, f = fine
    if (key === "+") return { fields: { volumeEff: 1 } };
    if (key === "-") return { fields: { volumeEff: 2 } };
    const d = hexDigit(key);
    if (d < 0) return null;
    const cur = cell.volume & 0x3f;
    const sel = cell.volumeEff === 3 && cell.volume === 0 ? 0 : cell.volumeEff;
    const val = nib === 0 ? (((d << 4) | (cur & 0x0f)) & 0x3f) : ((cur & 0x30) | d);
    return nib === 0
      ? { fields: { volume: val, volumeEff: sel }, advanceNib: true }
      : { fields: { volume: val, volumeEff: sel }, advanceRow: true };
  }

  if (sub === SUB_PAN) {
    if (code === "Delete" || code === "Period") {
      // pan-column no-op sentinel: SEL_FINE(3) with value 0
      return { fields: { pan: 0, panEff: 3 }, advanceRow: true };
    }
    if (key === "+") return { fields: { panEff: 1 } }; // slide right
    if (key === "-") return { fields: { panEff: 2 } }; // slide left
    const d = hexDigit(key);
    if (d < 0) return null;
    const cur = cell.pan & 0x3f;
    const sel = cell.panEff === 3 && cell.pan === 0 ? 0 : cell.panEff;
    const val = nib === 0 ? (((d << 4) | (cur & 0x0f)) & 0x3f) : ((cur & 0x30) | d);
    return nib === 0
      ? { fields: { pan: val, panEff: sel }, advanceNib: true }
      : { fields: { pan: val, panEff: sel }, advanceRow: true };
  }

  if (sub === SUB_FX_OP) {
    if (code === "Delete" || code === "Period") {
      return { fields: { effect: 0, effectArg: 0 }, advanceRow: true };
    }
    const d = base36Digit(key);
    if (d < 0) return null;
    return { fields: { effect: d }, advanceNib: true }; // move into the arg nibbles
  }

  if (sub === SUB_FX_ARG) {
    if (code === "Delete" || code === "Period") {
      return { fields: { effectArg: 0 }, advanceRow: true };
    }
    const d = hexDigit(key);
    if (d < 0) return null;
    const shift = (3 - nib) * 4;
    const val = (cell.effectArg & ~(0xf << shift)) | (d << shift);
    return nib === 3
      ? { fields: { effectArg: val & 0xffff }, advanceRow: true }
      : { fields: { effectArg: val & 0xffff }, advanceNib: true };
  }

  return null;
}
