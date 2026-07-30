// Block clipboard for the pattern grids (Timeline + Pattern views). A block is
// a rectangular region of cells captured as raw 8-byte images (row-major); the
// same shape serves both views — the Pattern view is just a 1-channel block.
// Cross-view paste clips the block to whatever the destination can hold.
//
// "Empty" cells follow the converter convention: vol/pan bytes 0xC0
// (SEL_FINE-0 no-ops), everything else zero — NOT all-zero (that is a real
// "set volume 0" command). Overwrite-paste of an empty source cell therefore
// blanks the destination, which is the standard tracker paste semantic.

/** Bytes per cell for a block: format version 3's cell is twice as wide. */
export function cellSize(wide) { return wide ? 16 : 8; }

/** Blank-cell image — FINE-by-zero in both columns, whichever the format. */
export function emptyCellBytes(wide = false) {
  const b = new Uint8Array(cellSize(wide));
  if (wide) {
    b[8] = 0x33; // both selectors FINE, values zero (file format §5.5)
  } else {
    b[3] = 0xc0;
    b[4] = 0xc0;
  }
  return b;
}

/** Serialise a TaudPlayData cell to its raw bytes, in the format's layout. */
export function cellToBytes(cell, wide = false) {
  const n = cellSize(wide);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = wide ? cell.getByteWide(i) : cell.getByte(i);
  return b;
}

/** Allocate a rows×chans block pre-filled with blank cells. */
export function makeBlock(rows, chans, wide = false) {
  const n = cellSize(wide);
  const cells = new Uint8Array(rows * chans * n);
  const empty = emptyCellBytes(wide);
  for (let i = 0; i < rows * chans; i++) cells.set(empty, i * n);
  return { rows, chans, wide, cells };
}

/** Mutable view of block cell (r, c). */
export function blockCell(block, r, c) {
  const n = cellSize(block.wide === true);
  const off = (r * block.chans + c) * n;
  return block.cells.subarray(off, off + n);
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

// Byte offsets per logical column, as [offset, mask] pairs (duplicated from
// edit.js so this pure module stays DOM/UI-free): note / inst / vol / pan / fx.
// The wide cell needs the masks — its byte 8 carries BOTH column selectors and
// the azimuth's ninth bit, so a per-column paste works in bits there.
const COL_BYTE_MASKS = [[[0, 0xff], [1, 0xff]], [[2, 0xff]], [[3, 0xff]], [[4, 0xff]],
  [[5, 0xff], [6, 0xff], [7, 0xff]]];
const COL_BYTE_MASKS_WIDE = [
  [[0, 0xff], [1, 0xff]],
  [[2, 0xff]],
  [[3, 0xff], [8, 0x70]],
  [[4, 0xff], [9, 0xff], [8, 0x8f]],
  [[5, 0xff], [6, 0xff], [7, 0xff], [10, 0xff], [11, 0xff], [12, 0xff]],
];

/** Overlay only `cols` (logical column ids) of `src` onto `dest` (same format);
 *  returns `dest`. Columns outside the set keep dest's bytes — this is what
 *  makes a partial-column paste leave the other columns unaffected. */
export function overlayCols(dest, src, cols, wide = false) {
  const table = wide ? COL_BYTE_MASKS_WIDE : COL_BYTE_MASKS;
  for (const col of cols) {
    for (const [b, mask] of table[col]) {
      dest[b] = (dest[b] & ~mask & 0xff) | (src[b] & mask);
    }
  }
  return dest;
}
