// Cues view (F2) — the order list: cue rows × channel columns of pattern
// numbers, plus the two per-cue instruction words (Cmd1/Cmd2 — BAK/FWD/JMP/
// LEN/HALT, encoded in the sign bits of ch 0-15 / 16-31). Edits are eager-
// synced to the worklet (DocSync). Feature reference: taut.js VIEW_CUES.

import { CUE_EMPTY, MAX_VOICES, NUM_CUES, NUM_CUES_64 } from "../../format/taud-const.js";
import { cueInstructionWords } from "../../format/taud-parse.js";
import { cueInfo } from "../../doc/document.js";
import { INST_NOP, INST_GOBACK, INST_SKIP, INST_JUMP, INST_PATLEN, INST_HALTAT, INST_HALT } from "../../engine/state.js";
import { setCuesOp } from "../../doc/ops.js";
import { makeCueBlock, cueBlockIndex, mergeCueWord } from "../../doc/clipboard.js";
import { showModal } from "../widgets/modal.js";
import { themeColors } from "../theme.js";
import { canvasFont } from "../fonts.js";
import { unescapeName } from "../names.js";
import { t } from "../i18n.js";

const FONT_PX = 13; // family comes from --cv-font via fonts.js
const CHAR_W = 7.9;
const ROW_H = 16;
const HEADER_H = 22;
const GUTTER_W = 52;             // cue index (4-digit hex)
const CMD_W = Math.ceil(9 * CHAR_W); // "HALT@40 " per word
const COL_W = Math.ceil(4 * CHAR_W) + 8; // 4 hex digits per channel (0000..7FFE)

const INST_NAMES = {
  [INST_NOP]: "", [INST_HALT]: "HALT", [INST_HALTAT]: "HALT@",
  [INST_PATLEN]: "LEN·", [INST_GOBACK]: "BAK·", [INST_SKIP]: "FWD·", [INST_JUMP]: "JMP·",
};

function instToStr(inst) {
  if (inst.type === INST_NOP) return "····";
  const name = INST_NAMES[inst.type];
  if (inst.type === INST_HALT) return name;
  return name + inst.arg.toString(16).toUpperCase();
}

// Encode a command choice back to its 16-bit instruction word.
function encodeInstWord(kind, arg) {
  switch (kind) {
    case "nop": return 0;
    case "halt": return 0x0100;
    case "haltAt": return 0x0140 | (arg & 0x3f);
    case "len": return 0x0200 | ((arg - 1) & 0x3f);
    case "bak": return 0x8000 | (arg & 0xfff);
    case "fwd": return 0x9000 | (arg & 0xfff);
    case "jmp": return 0xf000 | (arg & 0xfff);
    default: return 0;
  }
}

export class CuesView {
  constructor(store, canvas) {
    this.store = store;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scrollCue = 0;
    this.scrollCh = 0;
    this.cursor = { cue: 0, col: 0, nib: 0 }; // col: 0/1 = cmd words, 2+ = channel-2
    this.sel = null;   // block selection {aCue, aCh, cue, ch} (channel space)
    this._drag = null; // active pointer-drag anchor {aCue, aCh}
    this.needsRedraw = true;

    store.on("doc", () => { this.cursor = { cue: 0, col: 0, nib: 0 }; this.sel = null; this.scrollCue = 0; this.invalidate(); });
    store.on("edit", () => this.invalidate());

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Shift+wheel reports its delta in deltaX on most platforms.
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (e.shiftKey) this.scrollCh = Math.max(0, this.scrollCh + Math.sign(d) * 2);
      else this.scrollCue = clampInt(this.scrollCue + Math.sign(d) * 3, 0, this.maxScrollCue());
      this.invalidate();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("dblclick", () => this.openCmdEditor());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  invalidate() { this.needsRedraw = true; }

  resize() {
    const host = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(100, host.clientWidth * dpr);
    this.canvas.height = Math.max(100, host.clientHeight * dpr);
    this.canvas.style.width = host.clientWidth + "px";
    this.canvas.style.height = host.clientHeight + "px";
    this.dpr = dpr;
    this.invalidate();
  }

  visibleRows() { return Math.floor((this.canvas.height / this.dpr - HEADER_H) / ROW_H); }
  chanX(i) { return GUTTER_W + 2 * CMD_W + i * COL_W; }
  numCues() { return this.store.song?.cues.length ?? 0; }
  /** Scrollable/editable row count = the WHOLE cue address space (8192 / 4096),
   *  Excel-style: every row down to the hard limit is navigable and editable,
   *  but a cue is only materialised into the document when you write to it, so
   *  scrolling never bloats the save. Editing far down fills the gap in between
   *  (the accepted "cue 0 and 8191 ⇒ serialise 0..8191" caveat). */
  editRows() {
    return this.store.doc?.is64Channel ? NUM_CUES_64 : NUM_CUES;
  }
  /** Top scroll position that still shows the last row (no scrolling into void). */
  maxScrollCue() { return Math.max(0, this.editRows() - this.visibleRows()); }
  /** Word for cue/ch, or CUE_EMPTY for an unmaterialised row past the cue list. */
  wordAt(cue, ch) {
    const words = this.store.song?.cues[cue];
    return words ? words[ch] : CUE_EMPTY;
  }

  /** Canvas-relative x → {col} (0/1 = Cmd words, 2+ = channel-2), or -1 off-grid. */
  hitCol(x) {
    if (x < GUTTER_W) return -1;
    if (x < GUTTER_W + CMD_W) return 0;
    if (x < GUTTER_W + 2 * CMD_W) return 1;
    return 2 + this.scrollCh + Math.floor((x - GUTTER_W - 2 * CMD_W) / COL_W);
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < HEADER_H) return;
    const cue = this.scrollCue + Math.floor((y - HEADER_H) / ROW_H);
    if (cue >= this.editRows()) return;
    const col = this.hitCol(x);
    if (col < 0) return;
    if (e.shiftKey && col >= 2) {
      // Shift+click extends a channel block from the current cursor cell.
      const c = this.cursor;
      const aCh = c.col >= 2 ? c.col - 2 : 0;
      if (!this.sel) this.sel = { aCue: c.cue, aCh, cue, ch: col - 2 };
      else { this.sel.cue = cue; this.sel.ch = col - 2; }
    } else {
      this.sel = null;
      if (col >= 2) {
        this._drag = { aCue: cue, aCh: col - 2 };
        this.canvas.setPointerCapture?.(e.pointerId);
      }
    }
    this.cursor = { cue, col, nib: 0 };
    this.invalidate();
  }

  onPointerMove(e) {
    if (!this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cue = clampInt(this.scrollCue + Math.floor((y - HEADER_H) / ROW_H), 0, this.editRows() - 1);
    const col = this.hitCol(x);
    if (col < 2) return;
    const chans = this.store.doc.channelCount;
    const ch = clampInt(col - 2, 0, chans - 1);
    if (cue !== this._drag.aCue || ch !== this._drag.aCh) {
      this.sel = { aCue: this._drag.aCue, aCh: this._drag.aCh, cue, ch };
    } else {
      this.sel = null; // dragged back to the origin cell — no block
    }
    this.cursor = { cue, col: ch + 2, nib: 0 };
    this.invalidate();
  }

  onPointerUp(e) {
    if (this._drag) {
      this.canvas.releasePointerCapture?.(e.pointerId);
      this._drag = null;
    }
  }

  moveCursor(dRow, dCol) {
    const chans = this.store.doc.channelCount;
    const c = this.cursor;
    this.sel = null; // plain navigation drops any block selection
    c.cue = clampInt(c.cue + dRow, 0, this.editRows() - 1);
    c.col = clampInt(c.col + dCol, 0, chans + 1);
    if (dCol !== 0) c.nib = 0;
    this.keepCursorVisible();
    this.invalidate();
  }

  keepCursorVisible() {
    const vis = this.visibleRows();
    const c = this.cursor;
    if (c.cue < this.scrollCue) this.scrollCue = c.cue;
    else if (c.cue >= this.scrollCue + vis) this.scrollCue = c.cue - vis + 1;
  }

  // ── block selection + cue clipboard ──
  hasSelection() { return this.sel !== null; }
  clearSelection() { if (this.sel) { this.sel = null; this.invalidate(); } }

  /** Normalised inclusive bounds {r0,r1,c0,c1} (cue rows × channels), or null. */
  selBounds() {
    const s = this.sel;
    if (!s) return null;
    return {
      r0: Math.min(s.aCue, s.cue), r1: Math.max(s.aCue, s.cue),
      c0: Math.min(s.aCh, s.ch), c1: Math.max(s.aCh, s.ch),
    };
  }

  _ensureSel() {
    const c = this.cursor;
    if (!this.sel && c.col >= 2) {
      this.sel = { aCue: c.cue, aCh: c.col - 2, cue: c.cue, ch: c.col - 2 };
    }
  }

  /** Shift+arrows: grow the channel block, moving the cursor with it. Selection
   *  is channel-only, so it seeds nothing when the cursor sits on a Cmd column. */
  extendSelection(dCue, dCol) {
    this._ensureSel();
    if (!this.sel) return;
    const c = this.cursor;
    const chans = this.store.doc.channelCount;
    c.cue = clampInt(c.cue + dCue, 0, this.editRows() - 1);
    c.col = clampInt(c.col + dCol, 2, chans + 1);
    this.sel.cue = c.cue; this.sel.ch = c.col - 2;
    this.keepCursorVisible();
    this.invalidate();
  }

  copySelection() {
    const b = this.selBounds();
    if (!b) return false;
    const rows = b.r1 - b.r0 + 1, chans = b.c1 - b.c0 + 1;
    const block = makeCueBlock(rows, chans);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < chans; c++) {
        // carry the pattern index only (strip the command sign bit)
        block.words[cueBlockIndex(block, r, c)] = this.wordAt(b.r0 + r, b.c0 + c) & 0x7fff;
      }
    }
    this.store.cueClipboard = block;
    return true;
  }

  cutSelection() {
    if (!this.copySelection()) return false;
    this.clearRegion(this.selBounds());
    return true;
  }

  deleteSelection() {
    const b = this.selBounds();
    if (!b) return false;
    this.clearRegion(b);
    return true;
  }

  /** Blank the pattern index of every cell in bounds, keeping command bits.
   *  Rows past the real cue list (unmaterialised) are skipped so a delete
   *  never materialises an empty cue. */
  clearRegion(b) {
    const chans = this.store.doc.channelCount;
    const nCues = this.numCues();
    const writes = [];
    for (let cue = b.r0; cue <= Math.min(b.r1, nCues - 1); cue++) {
      for (let ch = b.c0; ch <= Math.min(b.c1, chans - 1); ch++) {
        writes.push({ cue, ch, value: (this.wordAt(cue, ch) & 0x8000) | 0x7fff });
      }
    }
    if (writes.length) {
      this.store.undo.apply(setCuesOp(this.store.songIndex, writes));
      this.invalidate();
    }
  }

  paste() {
    const block = this.store.cueClipboard;
    if (!block) return false;
    const c = this.cursor;
    const chans = this.store.doc.channelCount;
    const limit = this.store.doc.is64Channel ? NUM_CUES_64 : NUM_CUES;
    const baseCh = Math.max(0, c.col - 2);
    const writes = [];
    for (let r = 0; r < block.rows; r++) {
      const cue = c.cue + r;
      if (cue >= limit) break;
      for (let ch = 0; ch < block.chans; ch++) {
        const dch = baseCh + ch;
        if (dch >= chans) break; // clip past the last channel
        const src = block.words[cueBlockIndex(block, r, ch)];
        writes.push({ cue, ch: dch, value: mergeCueWord(this.wordAt(cue, dch), src) });
      }
    }
    if (!writes.length) return false;
    this.store.undo.apply(setCuesOp(this.store.songIndex, writes));
    this.sel = {
      aCue: c.cue, aCh: baseCh,
      cue: Math.min(c.cue + block.rows - 1, limit - 1),
      ch: Math.min(baseCh + block.chans - 1, chans - 1),
    };
    this.invalidate();
    return true;
  }

  /** Cue-view key handling. Returns true when consumed. */
  processKey(e) {
    const store = this.store;
    const c = this.cursor;
    switch (e.code) {
      case "ArrowUp": e.shiftKey ? this.extendSelection(-1, 0) : this.moveCursor(-1, 0); return true;
      case "ArrowDown": e.shiftKey ? this.extendSelection(1, 0) : this.moveCursor(1, 0); return true;
      case "ArrowLeft": e.shiftKey ? this.extendSelection(0, -1) : this.moveCursor(0, -1); return true;
      case "ArrowRight": e.shiftKey ? this.extendSelection(0, 1) : this.moveCursor(0, 1); return true;
      case "PageUp": e.shiftKey ? this.extendSelection(-16, 0) : this.moveCursor(-16, 0); return true;
      case "PageDown": e.shiftKey ? this.extendSelection(16, 0) : this.moveCursor(16, 0); return true;
      case "Enter": this.openCmdEditor(); return true;
    }
    if (!store.record || c.col < 2) return false;
    const ch = c.col - 2;
    if (e.code === "Delete" || e.code === "Period") {
      if (c.cue < this.numCues()) { // nothing to delete on the phantom row
        store.undo.apply(setCuesOp(store.songIndex,
          [{ cue: c.cue, ch, value: (this.wordAt(c.cue, ch) & 0x8000) | 0x7fff }]));
      }
      this.moveCursor(1, 0);
      return true;
    }
    const d = parseInt(e.key, 16);
    if (Number.isNaN(d) || e.key.length !== 1) return false;
    // 4-nibble pattern entry (0000..7FFE; the top nibble masks to 15 bits).
    // An empty slot starts from 0. setCuesOp materialises the cue if it is the
    // blank row past the end (edit beyond HALT / a new song's cue 0).
    const cur = this.wordAt(c.cue, ch);
    const sign = cur & 0x8000;
    let pat = cur & 0x7fff;
    if (pat === CUE_EMPTY) pat = 0;
    const shift = (3 - c.nib) * 4;
    pat = (pat & ~(0xf << shift)) | (d << shift);
    store.undo.apply(setCuesOp(store.songIndex,
      [{ cue: c.cue, ch, value: sign | (pat & 0x7fff) }]));
    if (c.nib === 3) { c.nib = 0; this.moveCursor(1, 0); }
    else { c.nib++; this.invalidate(); }
    return true;
  }

  /** CueCmd popup: choose word slot's instruction (Cmd1/Cmd2). */
  async openCmdEditor() {
    const store = this.store;
    const c = this.cursor;
    if (c.col > 1) return;
    const word = c.col; // 0 or 1
    const existing = store.song.cues[c.cue]; // undefined on the phantom row
    const info = cueInfo(existing ?? new Uint16Array(MAX_VOICES).fill(CUE_EMPTY));
    const current = word === 0 ? info.inst0 : info.inst1;
    const result = await showModal({
      title: t("cue.cmdTitle", {
        cue: c.cue.toString(16).toUpperCase().padStart(4, "0"), word: word + 1 }),
      body: t("cue.cmdBody"),
      fields: [
        { name: "kind", label: t("cue.command"), type: "select", value: kindOf(current), options: [
          { value: "nop", label: t("cue.none") },
          { value: "len", label: t("cue.len") },
          { value: "halt", label: t("cue.halt") },
          { value: "haltAt", label: t("cue.haltAt") },
          { value: "bak", label: t("cue.bak") },
          { value: "fwd", label: t("cue.fwd") },
          { value: "jmp", label: t("cue.jmp") },
        ]},
        { name: "arg", label: t("cue.argument"), type: "number", value: current.arg || 0, min: 0, max: 4095 },
      ],
    });
    if (!result) return;
    const newWord = encodeInstWord(result.kind, parseInt(result.arg || "0", 10));
    // Repack: sign bits of ch 0-15 = word0, ch 16-31 = word1.
    const words = existing ? Uint16Array.from(existing)
      : new Uint16Array(MAX_VOICES).fill(CUE_EMPTY);
    const [w0, w1] = cueInstructionWords(words);
    const w = word === 0 ? newWord : w0;
    const w2 = word === 1 ? newWord : w1;
    for (let ch = 0; ch < 16; ch++) {
      words[ch] = (words[ch] & 0x7fff) | (((w >> ch) & 1) << 15);
      words[16 + ch] = (words[16 + ch] & 0x7fff) | (((w2 >> ch) & 1) << 15);
    }
    // Write through the growable cue op so a command on the phantom row
    // materialises the cue (edit past HALT).
    const chans = store.doc.channelCount;
    const writes = [];
    for (let ch = 0; ch < chans; ch++) writes.push({ cue: c.cue, ch, value: words[ch] });
    store.undo.apply(setCuesOp(store.songIndex, writes));
    this.invalidate();
  }

  frame() {
    if (!this.store.doc) return;
    if (this.store.audio?.isPlaying()) this.needsRedraw = true; // playhead marker
    if (this.needsRedraw) { this.needsRedraw = false; this.draw(); }
  }

  draw() {
    const C = themeColors();
    const { ctx, store } = this;
    const dpr = this.dpr ?? 1;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const song = store.song;
    if (!song) return;
    const chans = store.doc.channelCount;
    ctx.font = canvasFont(FONT_PX);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    // header
    ctx.fillStyle = C.dim;
    ctx.fillText("cue", 6, HEADER_H / 2);
    ctx.fillText("Cmd1", GUTTER_W + 4, HEADER_H / 2);
    ctx.fillText("Cmd2", GUTTER_W + CMD_W + 4, HEADER_H / 2);
    const visCh = Math.min(Math.floor((W - this.chanX(0)) / COL_W) + 1, chans - this.scrollCh);
    for (let i = 0; i < visCh; i++) {
      ctx.fillStyle = C.dim;
      ctx.fillText(String(this.scrollCh + i + 1).padStart(2, "0"), this.chanX(i) + 4, HEADER_H / 2);
    }

    const playCue = store.audio?.isPlaying() ? store.audio.getCuePosition() : -1;
    const editRows = this.editRows();
    const sb = this.selBounds();
    const vis = this.visibleRows() + 1;
    for (let r = 0; r < vis; r++) {
      const cueIdx = this.scrollCue + r;
      if (cueIdx >= editRows) break;
      const y = HEADER_H + r * ROW_H;
      const words = song.cues[cueIdx]; // undefined on the phantom (append) row
      const info = words ? cueInfo(words) : cueInfo(new Uint16Array(MAX_VOICES).fill(CUE_EMPTY));

      if (cueIdx === playCue) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (cueIdx % 4 === 0) {
        ctx.fillStyle = C.panel;
        ctx.fillRect(0, y, W, ROW_H);
      }
      // block selection highlight (channel columns only)
      if (sb && cueIdx >= sb.r0 && cueIdx <= sb.r1) {
        for (let i = 0; i < visCh; i++) {
          const ch = this.scrollCh + i;
          if (ch >= sb.c0 && ch <= sb.c1) {
            ctx.fillStyle = C.sel;
            ctx.fillRect(this.chanX(i) - 2, y, COL_W - 2, ROW_H);
          }
        }
      }
      if (this.cursor.cue === cueIdx) {
        const cx = this.cursor.col === 0 ? GUTTER_W :
                   this.cursor.col === 1 ? GUTTER_W + CMD_W :
                   this.chanX(this.cursor.col - 2 - this.scrollCh);
        const cw = this.cursor.col <= 1 ? CMD_W : COL_W;
        ctx.fillStyle = C.cursor;
        ctx.fillRect(cx, y, cw - 2, ROW_H);
        if (this.cursor.col >= 2) {
          ctx.fillStyle = store.record ? C.caret : C.cursor;
          ctx.fillRect(cx + 4 + this.cursor.nib * CHAR_W - 1, y, CHAR_W + 2, ROW_H);
        }
      }

      ctx.fillStyle = C.accent;
      ctx.fillText(cueIdx.toString(16).toUpperCase().padStart(4, "0"), 6, y + ROW_H / 2);
      ctx.fillStyle = info.inst0.type !== INST_NOP ? C.accent2 : C.dim;
      if (info.inst0.type === INST_NOP) ctx.globalAlpha = 0.35;
      ctx.fillText(instToStr(info.inst0), GUTTER_W + 4, y + ROW_H / 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = info.inst1.type !== INST_NOP ? C.accent2 : C.dim;
      if (info.inst1.type === INST_NOP) ctx.globalAlpha = 0.35;
      ctx.fillText(instToStr(info.inst1), GUTTER_W + CMD_W + 4, y + ROW_H / 2);
      ctx.globalAlpha = 1;

      for (let i = 0; i < visCh; i++) {
        const ch = this.scrollCh + i;
        const pat = (words ? words[ch] : CUE_EMPTY) & 0x7fff;
        const x = this.chanX(i) + 4;
        if (pat === CUE_EMPTY) {
          ctx.fillStyle = C.dim;
          ctx.globalAlpha = 0.3;
          ctx.fillText("····", x, y + ROW_H / 2);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = C.fg;
          ctx.fillText(pat.toString(16).toUpperCase().padStart(4, "0"), x, y + ROW_H / 2);
        }
      }
    }

    ctx.strokeStyle = C.border;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W - 2.5, 0); ctx.lineTo(GUTTER_W - 2.5, H);
    ctx.moveTo(this.chanX(0) - 2.5, 0); ctx.lineTo(this.chanX(0) - 2.5, H);
    ctx.moveTo(0, HEADER_H - 0.5); ctx.lineTo(W, HEADER_H - 0.5);
    ctx.stroke();

    // Floating name tag for the pattern under the cursor (rename display). The
    // grid cells are too narrow for names, so a tag floats by the cursor cell.
    if (this.cursor.col >= 2) {
      const ch = this.cursor.col - 2;
      const vOff = ch - this.scrollCh;
      const rOff = this.cursor.cue - this.scrollCue;
      const words = song.cues[this.cursor.cue];
      const pat = words ? (words[ch] & 0x7fff) : CUE_EMPTY;
      const nm = pat !== CUE_EMPTY ? unescapeName(store.doc.patternName(pat)) : "";
      if (nm && vOff >= 0 && vOff < visCh && rOff >= 0 && rOff < vis) {
        const cellX = this.chanX(vOff);
        let ty = HEADER_H + rOff * ROW_H + ROW_H;         // below the cursor row
        if (ty + ROW_H > H) ty = HEADER_H + rOff * ROW_H - ROW_H; // flip up near bottom
        const label = pat.toString(16).toUpperCase().padStart(4, "0") + "  " + nm;
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = C.panel;
        ctx.fillRect(cellX, ty + 2, tw, ROW_H - 3);
        ctx.strokeStyle = C.accent;
        ctx.strokeRect(cellX + 0.5, ty + 2.5, tw, ROW_H - 4);
        ctx.fillStyle = C.fg;
        ctx.fillText(label, cellX + 6, ty + 2 + (ROW_H - 3) / 2);
      }
    }
  }
}

function kindOf(inst) {
  switch (inst.type) {
    case INST_HALT: return "halt";
    case INST_HALTAT: return "haltAt";
    case INST_PATLEN: return "len";
    case INST_GOBACK: return "bak";
    case INST_SKIP: return "fwd";
    case INST_JUMP: return "jmp";
    default: return "nop";
  }
}

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
