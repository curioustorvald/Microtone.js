// Note-word display helpers. Taud notes are 4096-TET with 0x5000 = Middle C
// (labelled C4 outside tracker contexts — AudioAdapter.kt:164-168). One 12-EDO
// semitone = 4096/12 ≈ 341.33 units; notes off the 12-EDO grid get a cents
// marker (microtonal pitch-table content).

import { MIDDLE_C } from "../engine/constants.js";
import { volPanOp, volPanArg } from "./edit.js";
import { t } from "./i18n.js";

const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const SEMI = 4096 / 12;

/** 3-char note-cell text for a pattern note word (+ optional detune marker). */
export function noteToStr(note) {
  if (note === 0x0000) return "···";
  if (note === 0x0001) return "==="; // key-off
  if (note === 0x0002) return "^^^"; // note cut
  if (note === 0x0003) return "~~~"; // note fade
  if (note === 0x0004) return "~^~"; // fast fade
  if (note >= 0x0005 && note <= 0x000f) return "res";
  if (note >= 0x0010 && note <= 0x001f) return "I·" + (note - 0x0010).toString(16).toUpperCase();
  const rel = note - MIDDLE_C;
  const semis = Math.round(rel / SEMI);
  const octave = 4 + Math.floor(semis / 12);
  const idx = ((semis % 12) + 12) % 12;
  if (octave < 0 || octave > 9) return "???";
  return NAMES[idx] + octave;
}

/** Cents deviation from the nearest 12-EDO degree (rounded; 0 when on-grid). */
export function noteCentsOff(note) {
  const rel = note - MIDDLE_C;
  const semis = Math.round(rel / SEMI);
  return Math.round(((rel - semis * SEMI) / SEMI) * 100);
}

// terranmon.txt:3041 — 0x0000..0x001F are reserved sentinels, so the lowest
// PLAYABLE note is 0x0020; a zone/layer authored against either boundary
// means "no lower bound". 0xFFFF is the note-range upper sentinel.
const RANGE_LO_SENTINELS = new Set([0x0000, 0x0020]);
const RANGE_HI_SENTINEL = 0xffff;

/** Which ends of a zone/layer range are OPEN — shared so the text form below
 *  and the glyph form (noteglyph.js rangeGlyphCanvas) collapse them alike. */
export function rangeBoundsOpen(lo, hi) {
  return { openLo: RANGE_LO_SENTINELS.has(lo), openHi: hi === RANGE_HI_SENTINEL };
}

/** Note-range text for Ixmp zones / meta layers / Advanced Edit: collapses an
 *  open lower/upper bound into "~note" / "note~", both bounds into a
 *  translated "whole range", otherwise the plain "lo‥hi" pair. */
export function rangeToStr(lo, hi) {
  const { openLo, openHi } = rangeBoundsOpen(lo, hi);
  if (openLo && openHi) return t("range.whole");
  if (openLo) return "~" + noteToStr(hi);
  if (openHi) return noteToStr(lo) + "~";
  return noteToStr(lo) + "‥" + noteToStr(hi);
}

export function hex2(v) { return v.toString(16).toUpperCase().padStart(2, "0"); }
export function hex4(v) { return v.toString(16).toUpperCase().padStart(4, "0"); }

// ── Effect-argument field map (item 120) ─────────────────────────────────────
// A Taud argument is four nibbles, but almost no command reads it as one
// number: H is speed+depth, D is two slide nibbles over a reserved byte, S
// multiplexes on its first nibble. The grids paint each FIELD in its own shade
// of amber so the split is visible without consulting the manual, which is what
// these layouts describe — one character per nibble, most significant first:
//
//   '1' '2' '3'  argument field 1 / 2 / 3 (the three argument inks)
//   'o'          part of the COMMAND, not of its argument: the S / Z
//                multiplexer nibble, which takes the opcode's own ink so
//                "S8" and "Z0" read as the two-character commands they are
//   '.'          reserved / ignored by the engine — drawn dim
//
// Sources: TAUD_NOTE_EFFECTS.md, one entry per command heading.
const FX_LAYOUT = {
  0: "1111", // no effect (an argument here is junk, but show it)
  1: "11..", // 1 $xx00  global behaviour flags
  2: "1123", // 2 $sexy  sample modification, region INVERTED: region, op, speed
  3: "1123", // 3 $sexy  sample modification: region, operation, step period
  4: "1122", // 4 $eeaa  spherical slide target: elevation, azimuth
  5: "1111", // 5 $xxyy  filter cutoff (one value: 16-bit in SF2 mode, high byte in IT)
  6: "1111", // 6 $xxyy  filter resonance, as 5
  7: "1122", // 7 $xxyy  pattern ditto: rows, repeats
  8: "1233", // 8 $xyzz  bitcrusher: clip mode, bit depth, sample skip
  9: "1.22", // 9 $x0zz  overdrive: clip mode, (reserved), amplification
  10: "11..", // A $xx00  set speed
  11: "1111", // B $xxxx  jump to cue
  12: "1111", // C $xxxx  break to row
  13: "12..", // D $xy00  volume slide
  14: null, //  E $xxxx  pitch slide down — contextual, see fxArgFields
  15: null, //  F $xxxx  pitch slide up — contextual
  16: "1111", // G $xxxx  tone portamento
  17: "1122", // H $xxyy  vibrato: speed, depth
  18: "1122", // I $xxyy  tremor: on-time, off-time
  19: "1122", // J $xxyy  arpeggio: offset 1, offset 2
  20: "12..", // K $xy00  vibrato + volume slide
  21: "12..", // L $xy00  portamento + volume slide
  22: "11..", // M $xx00  set channel volume
  23: "12..", // N $xy00  channel volume slide
  24: "1111", // O $xxyy  sample offset
  25: "12..", // P $xy00  channel panning slide
  26: "12..", // Q $xy00  retrigger: volume modifier, interval
  27: "1122", // R $xxyy  tremolo: speed, depth
  28: null, //  S        multiplexed — see fxArgFields
  29: null, //  T $xxyy  tempo set / extended / slide — contextual
  30: "1122", // U $xxyy  fine vibrato: speed, depth
  31: "11..", // V $xx00  set global volume
  32: "12..", // W $xy00  global volume slide
  33: "1122", // X $eeaa  spherical pan: elevation, azimuth
  34: "1122", // Y $xxyy  panbrello: speed, depth
  35: "o111", // Z $0xxx spherical pan slide / Z $F0xx funk repeat (the sub-selector rides with the opcode)
};

// S's sub-commands, keyed by the high nibble. The nibble itself is always 'o'.
const S_LAYOUT = {
  0x0: "o1..", // S $0x00  Amiga LED filter
  0x1: "o1..", // S $1x00  glissando
  0x2: "o1..", // S $2x00  fine-tune
  0x3: "o1..", // S $3x00  vibrato waveform
  0x4: "o1..", // S $4x00  tremolo waveform
  0x5: "o1..", // S $5x00  panbrello waveform
  0x6: "o1..", // S $6x00  fine pattern delay
  0x7: "o1..", // S $7x00  note/instrument action
  0x8: "o111", // S $80xx  set channel pan (9-bit angle in surround)
  0xb: "o1..", // S $Bx00  pattern loop
  0xc: "o1..", // S $Cx00  note cut
  0xd: "o123", // S $Dxny  note delay, action, action delay
  0xe: "o1..", // S $Ex00  pattern delay
  0xf: "o111", // S $F0xx  invert loop
};

/**
 * Which argument field each of the four nibbles of `arg` belongs to, for the
 * effect-column colouring. Returns Int8Array-like array of 4 numbers:
 * 0 = opcode (the S / Z multiplexer nibble), 1..3 = argument field, -1 =
 * reserved. Pure — the grids map the numbers onto inks themselves.
 */
export function fxArgFields(effect, arg) {
  const layout = fxLayout(effect, arg);
  const out = new Array(4);
  for (let i = 0; i < 4; i++) {
    const c = layout[i];
    out[i] = c === "o" ? 0 : c === "." ? -1 : c.charCodeAt(0) - 48;
  }
  return out;
}

function fxLayout(effect, arg) {
  switch (effect) {
    case 14: case 15:
      // E / F: $F000..$FFFF is the FINE form — the marker nibble is a field of
      // its own and the magnitude is the low 12 bits.
      return (arg & 0xf000) === 0xf000 ? "1222" : "1111";
    case 28: // S: high nibble multiplexes; unknown sub-commands stay one field
      return S_LAYOUT[(arg >> 12) & 0xf] ?? "o111";
    case 29: {
      // T: a zero high byte means "tempo slide" and moves everything into the
      // low byte; $FF means "extended set" and makes the low byte the value.
      const hi = (arg >> 8) & 0xff;
      if (hi === 0x00) return "..12"; // $00 marker, direction nibble, amount
      if (hi === 0xff) return "1122"; // $FF marker byte, tempo byte
      return "11..";
    }
    default:
      return FX_LAYOUT[effect] ?? "1111";
  }
}

// Volume / panning columns (item 87): a SYMBOL cell naming the operation plus
// two argument digits. The symbol is blank for a plain set (nothing is
// happening to the value), a tick for a per-tick slide, and +/− for the
// one-shot fine slides — whose argument is the magnitude 00..1F, the direction
// having moved into the symbol. "···" is the $C0 no-op sentinel (empty cell).
// The grids paint the ticks as vectors (glyphs.paintVolPanCell); these strings
// are the text fallback and what the tests read.
const VOL_SYM = { set: " ", up: "˄", down: "˅", fineUp: "+", fineDown: "−", none: "·" };
const PAN_SYM = { set: " ", up: "˃", down: "˂", fineUp: "+", fineDown: "−", none: "·" };

/** Volume column text: symbol + two hex digits ("···" for the no-op). */
export function volToStr(volume, volumeEff) {
  return volPanToStr(false, volume, volumeEff);
}

/** Pan column text (00 = left, 20 = centre, 3F = right). */
export function panToStr(pan, panEff) {
  return volPanToStr(true, pan, panEff);
}

function volPanToStr(isPan, value, sel) {
  const op = volPanOp(value, sel);
  if (op === "none") return "···";
  return (isPan ? PAN_SYM : VOL_SYM)[op] + hex2(volPanArg(value, sel));
}
