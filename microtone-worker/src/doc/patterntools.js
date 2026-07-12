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

/** Lengthen ×n: row r → row n·r with blanks between, rows past 63 pushed out
 *  (the Impulse Tracker Alt-F "expand pattern" behaviour, generalised from the
 *  fixed ×2 to any integer factor ≥ 1). */
export function expandPatternBytes(src, factor = 2) {
  const n = Math.max(1, factor | 0);
  const out = emptyPatternBytes();
  for (let r = 0; r * n <= 63; r++) out.set(src.subarray(r * 8, r * 8 + 8), r * n * 8);
  return out;
}

/** Shorten ÷n: row n·r → row r, the rows between dropped, the tail left blank
 *  (the Impulse Tracker Alt-G "shrink pattern" behaviour, generalised from the
 *  fixed ÷2 to any integer factor ≥ 1). */
export function shrinkPatternBytes(src, factor = 2) {
  const n = Math.max(1, factor | 0);
  const out = emptyPatternBytes();
  for (let r = 0; r * n <= 63; r++) out.set(src.subarray(r * n * 8, r * n * 8 + 8), r * 8);
  return out;
}

const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Scale/offset every SET volume value: v → clamp(round(v·mult + add), 0..63),
 *  keeping the effect selector. The no-op sentinel (eff=FINE, val=0 → 0xC0)
 *  and thus every empty cell are skipped — this amplifies existing volumes,
 *  it does not stamp volume onto cells that carry none. `rows` limits the span
 *  (a [r0,r1] inclusive pair) — omit for the whole pattern. */
export function scaleVolumeBytes(src, mult, add, rows = null) {
  const out = Uint8Array.from(src);
  const [r0, r1] = rows ?? [0, 63];
  for (let r = r0; r <= r1; r++) {
    const o = r * 8 + 3;
    const b = out[o], eff = (b >>> 6) & 3, val = b & 63;
    if (eff === 3 && val === 0) continue;
    out[o] = (eff << 6) | clampInt(Math.round(val * mult + add), 0, 63);
  }
  return out;
}

/** Pan transform: widen/narrow by signed `mult` about centre 0x20, then shift
 *  by `add`. mult>1 widens, 0<mult<1 narrows, mult<0 swaps L/R. Skips the
 *  pan no-op sentinel (eff=FINE, val=0). */
export function transformPanBytes(src, mult, add, rows = null) {
  const out = Uint8Array.from(src);
  const CENTRE = 32;
  const [r0, r1] = rows ?? [0, 63];
  for (let r = r0; r <= r1; r++) {
    const o = r * 8 + 4;
    const b = out[o], eff = (b >>> 6) & 3, val = b & 63;
    if (eff === 3 && val === 0) continue;
    out[o] = (eff << 6) | clampInt(Math.round(CENTRE + (val - CENTRE) * mult + add), 0, 63);
  }
  return out;
}

/** Remap the instrument byte: from===null → change every non-empty inst to
 *  `to`; otherwise only cells whose inst === from. */
export function changeInstrumentBytes(src, from, to, rows = null) {
  const out = Uint8Array.from(src);
  const [r0, r1] = rows ?? [0, 63];
  for (let r = r0; r <= r1; r++) {
    const o = r * 8 + 2, cur = out[o];
    if (from === null ? cur !== 0 : cur === (from & 0xff)) out[o] = to & 0xff;
  }
  return out;
}
