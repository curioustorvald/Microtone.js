// Pattern-cell edit interpreter — pure functions (Node-testable), glued to the
// canvas views by timeline.js. Column model per cell:
//   sub 0 = note, 1 = instrument (2 nibbles), 2 = volume (2 nibbles),
//   sub 3 = effect opcode (base-36), 4 = effect arg (4 nibbles).
// The jam map mirrors taut.js SC_JAM: physical-position piano on the A-row
// (KeyA..KeyK white, KeyW/E/T/Y/U black) — layout-independent via e.code.

import { MIDDLE_C } from "../engine/constants.js";

export const SUB_NOTE = 0;
export const SUB_INST = 1;
export const SUB_VOL = 2;
export const SUB_FX_OP = 3;
export const SUB_FX_ARG = 4;
export const NUM_SUBS = 5;
export const SUB_NIBBLES = [1, 2, 2, 1, 4];

// Physical piano rows (KeyboardEvent.code → semitone offset from C).
// White: a s d f g h j k → C D E F G A B +C; black: w e t y u.
export const JAM_SEMIS = Object.freeze({
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12,
});

/** 12-EDO note word for semitone offset from C at `octave` (C4 = MIDDLE_C). */
export function semiToNote(octave, semi) {
  const val = MIDDLE_C + (octave - 4) * 4096 + Math.round((semi * 4096) / 12);
  return Math.min(Math.max(val, 0x20), 0xffff);
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
 * @param ctx  {octave, currentInst}
 * @returns null (unhandled) or an action:
 *   {fields, jamNote?, advanceRow?, advanceNib?} — fields go through setCellOp;
 *   advanceRow steps the cursor down (note entry / field completion),
 *   advanceNib moves within the field.
 */
export function interpretEditKey(ev, sub, nib, cell, ctx) {
  const { code, key } = ev;

  if (sub === SUB_NOTE) {
    if (code in JAM_SEMIS) {
      const note = semiToNote(ctx.octave, JAM_SEMIS[code]);
      const fields = { note };
      // Current-instrument auto-adopt (taut behaviour): note entry stamps the
      // active instrument unless the cell already carries one.
      if (ctx.currentInst > 0) fields.instrment = ctx.currentInst;
      return { fields, jamNote: note, advanceRow: true };
    }
    switch (code) {
      case "Backquote": return { fields: { note: 0x0001 }, advanceRow: true }; // key-off
      case "Digit1": return { fields: { note: 0x0002 }, advanceRow: true };    // note cut
      case "Digit2": return { fields: { note: 0x0003 }, advanceRow: true };    // note fade
      case "Digit3": return { fields: { note: 0x0004 }, advanceRow: true };    // fast fade
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
