// Note-word display helpers. Taud notes are 4096-TET with 0x5000 = Middle C
// (labelled C4 outside tracker contexts — AudioAdapter.kt:164-168). One 12-EDO
// semitone = 4096/12 ≈ 341.33 units; notes off the 12-EDO grid get a cents
// marker (microtonal pitch-table content).

import { MIDDLE_C } from "../engine/constants.js";
import { volPanOp, volPanArg } from "./edit.js";

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

export function hex2(v) { return v.toString(16).toUpperCase().padStart(2, "0"); }
export function hex4(v) { return v.toString(16).toUpperCase().padStart(4, "0"); }

/** Effect column text: base-36 opcode letter + 4 hex digits ("·····" when empty). */
export function fxToStr(effect, arg) {
  if (effect === 0 && arg === 0) return "·····";
  return effect.toString(36).toUpperCase() + hex4(arg);
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
