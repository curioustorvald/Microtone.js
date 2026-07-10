// Pure byte-level pattern transforms (64 rows × 8-byte cells = 512 bytes).
// "Empty" cells follow the converter convention: vol/pan bytes 0xC0
// (SEL_FINE-0 no-ops) — all-zero vol/pan bytes would be real "set volume 0"
// commands, not blanks.

import { PATTERN_SIZE } from "../format/taud-const.js";

/** A fully empty pattern image (the newProject/converter blank-cell shape). */
export function emptyPatternBytes() {
  const bytes = new Uint8Array(PATTERN_SIZE);
  for (let r = 0; r < 64; r++) {
    bytes[r * 8 + 3] = 0xc0;
    bytes[r * 8 + 4] = 0xc0;
  }
  return bytes;
}

/** Lengthen ×2: row r → row 2r with blanks between (rows 32..63 push out —
 *  the Impulse Tracker Alt-F "expand pattern" behaviour). */
export function expandPatternBytes(src) {
  const out = emptyPatternBytes();
  for (let r = 0; r < 32; r++) out.set(src.subarray(r * 8, r * 8 + 8), r * 2 * 8);
  return out;
}

/** Shorten ÷2: row 2r → row r, odd rows dropped, the tail left blank (the
 *  Impulse Tracker Alt-G "shrink pattern" behaviour). */
export function shrinkPatternBytes(src) {
  const out = emptyPatternBytes();
  for (let r = 0; r < 32; r++) out.set(src.subarray(r * 2 * 8, r * 2 * 8 + 8), r * 8);
  return out;
}
