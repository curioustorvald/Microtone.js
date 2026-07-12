// Block clipboard for the pattern grids (Timeline + Pattern views). A block is
// a rectangular region of cells captured as raw 8-byte images (row-major); the
// same shape serves both views — the Pattern view is just a 1-channel block.
// Cross-view paste clips the block to whatever the destination can hold.
//
// "Empty" cells follow the converter convention: vol/pan bytes 0xC0
// (SEL_FINE-0 no-ops), everything else zero — NOT all-zero (that is a real
// "set volume 0" command). Overwrite-paste of an empty source cell therefore
// blanks the destination, which is the standard tracker paste semantic.

/** 8-byte image of a blank cell. */
export function emptyCellBytes() {
  const b = new Uint8Array(8);
  b[3] = 0xc0;
  b[4] = 0xc0;
  return b;
}

/** Serialise a TaudPlayData cell to its 8 raw bytes. */
export function cellToBytes(cell) {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = cell.getByte(i);
  return b;
}

/** Allocate a rows×chans block pre-filled with blank cells. */
export function makeBlock(rows, chans) {
  const cells = new Uint8Array(rows * chans * 8);
  const empty = emptyCellBytes();
  for (let i = 0; i < rows * chans; i++) cells.set(empty, i * 8);
  return { rows, chans, cells };
}

/** Mutable 8-byte view of block cell (r, c). */
export function blockCell(block, r, c) {
  const off = (r * block.chans + c) * 8;
  return block.cells.subarray(off, off + 8);
}

// ── Cue-block clipboard (Cues view) ──
// A cue block is a rows×chans grid of pattern-index words (low 15 bits). The
// per-cue command sign bits are NOT carried: they are bit-packed across the
// channels of one cue, so a rectangular copy that moves channels around would
// scramble them. Paste therefore preserves each destination cell's own command
// bit and overlays only the pasted pattern index.
import { CUE_EMPTY } from "../format/taud-const.js";

/** Allocate a rows×chans cue block pre-filled with empty pattern words. */
export function makeCueBlock(rows, chans) {
  return { rows, chans, words: new Uint16Array(rows * chans).fill(CUE_EMPTY) };
}

/** Flat index of cue-block cell (r, c) into block.words (row-major). */
export function cueBlockIndex(block, r, c) { return r * block.chans + c; }

/** Merge a copied pattern word onto a destination cue word, keeping the
 *  destination's command sign bit (bit 15) intact. */
export function mergeCueWord(destWord, srcWord) {
  return (destWord & 0x8000) | (srcWord & 0x7fff);
}

// Byte offsets per logical column (duplicated from edit.js so this pure module
// stays DOM/UI-free): note / inst / vol / pan / fx.
const COL_BYTE_OFFSETS = [[0, 1], [2], [3], [4], [5, 6, 7]];

/** Overlay only `cols` (logical column ids) of `src` onto `dest` (both 8-byte);
 *  returns `dest`. Columns outside the set keep dest's bytes — this is what
 *  makes a partial-column paste leave the other columns unaffected. */
export function overlayCols(dest, src, cols) {
  for (const col of cols) for (const b of COL_BYTE_OFFSETS[col]) dest[b] = src[b];
  return dest;
}
