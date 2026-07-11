// Timeline view (F1) — the multi-voice pattern grid across the whole song,
// canvas-rendered and row-virtualised. M5 scope: read-only navigation, follow
// mode, per-channel VU/pan header meters, cue-boundary gutter. Feature
// reference: taut.js VIEW_TIMELINE.

import { PATTERN_EMPTY } from "../../engine/constants.js";
import { hex2, hex4, volToStr, panToStr, fxToStr } from "../notenames.js";
import { stepNoteInTable } from "../pitchtables.js";
import { paintNoteCell } from "../glyphs.js";
import {
  interpretEditKey, SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG,
  SUB_POSITIONS, subCharPos, charToSub, CELL_CHARS,
  colsForSubs, subToCol, ALL_COLS, COL_CHAR_RANGE,
} from "../edit.js";
import { setCellOp, setCellsBytesOp } from "../../doc/ops.js";
import { makeBlock, blockCell, cellToBytes, emptyCellBytes, overlayCols } from "../../doc/clipboard.js";
import { themeColors } from "../theme.js";
import { canvasFont } from "../fonts.js";

const FONT_PX = 13; // family comes from --cv-font via fonts.js
const CHAR_W = 7.9;
const ROW_H = 16;
const HEADER_H = 50;   // channel header: number + pattern + VU + pan + live note
const GUTTER_W = 76;   // "cue:row | absrow"
const COL_W = Math.ceil(CELL_CHARS * CHAR_W) + 10;

export class TimelineView {
  constructor(store, canvas) {
    this.store = store;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scrollRow = 0;   // top visible absolute row (fractional while wheeling)
    this.scrollCh = 0;    // leftmost visible channel
    this.map = null;      // songMap cache
    this.needsRedraw = true;
    this.lastPlayRow = -1; // remembered so resize() can repaint synchronously
    this.sel = null;       // block selection {aRow, aCh, row, ch} (absolute rows/channels)
    this._drag = null;     // active pointer-drag anchor {aRow, aCh}

    store.on("doc", () => { this.map = null; this.scrollRow = 0; this.scrollCh = 0; this.sel = null; this.invalidate(); });
    store.on("edit", () => { this.map = null; this.invalidate(); });
    store.on("cursor", () => this.invalidate());
    store.on("mutes", () => this.invalidate());

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Shift+wheel reports its delta in deltaX on most platforms.
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      // Record mode: wheel over the CURSOR cell increments/decrements the
      // hovered column (wheel up = +1); elsewhere the wheel scrolls. Shift
      // always means "scroll channels" — never a cell edit.
      if (!e.shiftKey && this.store.record && this.wheelEdit(e, d < 0 ? 1 : -1)) return;
      if (e.shiftKey) {
        this.scrollCh = clampInt(this.scrollCh + Math.sign(d), 0, this.maxScrollCh());
        this.invalidate();
      } else {
        this.scrollBy(d / ROW_H);
      }
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const host = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, Math.round(host.clientWidth * dpr));
    const h = Math.max(100, Math.round(host.clientHeight * dpr));
    // Skip no-op resizes (ResizeObserver fires on unrelated reflows too).
    if (this.canvas.width === w && this.canvas.height === h && this.dpr === dpr) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = host.clientWidth + "px";
    this.canvas.style.height = host.clientHeight + "px";
    this.dpr = dpr;
    // Setting canvas.width blanks the backing store; repaint synchronously
    // (ResizeObserver runs before paint) so the empty frame never shows — this
    // is the "moving the cursor in/out of the note column flickers" fix, since
    // that resizes the command palette and reflows the view host.
    this.needsRedraw = false;
    this.draw(this.lastPlayRow);
  }

  invalidate() { this.needsRedraw = true; }

  visibleRows() { return Math.floor((this.canvas.height / this.dpr - HEADER_H) / ROW_H); }
  visibleChans() { return Math.floor((this.canvas.width / this.dpr - GUTTER_W) / COL_W); }
  maxScrollCh() {
    const chans = this.store.doc?.channelCount ?? 32;
    return Math.max(0, chans - this.visibleChans());
  }

  getMap() {
    if (this.map === null && this.store.song) this.map = this.store.song.songMap();
    return this.map;
  }

  scrollBy(rows) {
    const map = this.getMap();
    if (!map) return;
    this.scrollRow = Math.max(0, Math.min(this.scrollRow + rows, map.totalRows - 4));
    this.invalidate();
  }

  /** Centre an absolute row (follow mode / cursor jumps). */
  centreRow(row) {
    const map = this.getMap();
    if (!map) return;
    const want = row - this.visibleRows() / 2;
    this.scrollRow = Math.max(0, Math.min(want, Math.max(0, map.totalRows - 4)));
    this.invalidate();
  }

  /** Map absolute song row → {entry, rowInCue} via the song map. */
  locate(absRow) {
    const map = this.getMap();
    if (!map || map.entries.length === 0) return null;
    // linear scan is fine (≤ a few thousand cues); binary-search later if needed
    for (let i = map.entries.length - 1; i >= 0; i--) {
      const e = map.entries[i];
      if (absRow >= e.startRow) {
        const rowInCue = absRow - e.startRow;
        if (rowInCue >= e.rowLimit) return null; // past end
        return { entry: e, rowInCue };
      }
    }
    return null;
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < HEADER_H) {
      // channel header: click = mute toggle, Ctrl/⌘+click = solo toggle
      const ch = this.scrollCh + Math.floor((x - GUTTER_W) / COL_W);
      if (x >= GUTTER_W && ch >= this.scrollCh &&
          ch < (this.store.doc?.channelCount ?? 0)) {
        if (e.ctrlKey || e.metaKey) this.store.toggleSolo(ch);
        else this.store.toggleMute(ch);
      }
      return;
    }
    const hit = this.hitTest(x, y);
    if (!hit) return;
    if (e.shiftKey) {
      // Shift+click extends a FULL-column block from the current cursor.
      const c = this.store.cursor;
      if (!this.sel) this.sel = { aRow: c.row, aCh: c.ch, aSub: 0, row: hit.row, ch: hit.ch, sub: SUB_FX_ARG };
      else { this.sel.row = hit.row; this.sel.ch = hit.ch; this.sel.aSub = 0; this.sel.sub = SUB_FX_ARG; }
    } else {
      // Mouse-drag carries sub-column granularity (the hit's sub-position).
      this.sel = null;
      this._drag = { aRow: hit.row, aCh: hit.ch, aSub: hit.sub };
      this.canvas.setPointerCapture?.(e.pointerId);
    }
    this.store.cursor = hit;
    this.store.emit("cursor");
    this.invalidate();
  }

  onPointerMove(e) {
    if (!this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (hit.row !== this._drag.aRow || hit.ch !== this._drag.aCh || hit.sub !== this._drag.aSub) {
      this.sel = {
        aRow: this._drag.aRow, aCh: this._drag.aCh, aSub: this._drag.aSub,
        row: hit.row, ch: hit.ch, sub: hit.sub,
      };
    } else {
      this.sel = null; // dragged back to the origin cell — no block
    }
    const c = this.store.cursor;
    c.row = hit.row; c.ch = hit.ch; c.sub = hit.sub; c.nib = hit.nib;
    this.store.emit("cursor");
    this.invalidate();
  }

  onPointerUp(e) {
    if (this._drag) {
      this.canvas.releasePointerCapture?.(e.pointerId);
      this._drag = null;
    }
  }

  // ── block selection + clipboard ──
  hasSelection() { return this.sel !== null; }
  clearSelection() { if (this.sel) { this.sel = null; this.invalidate(); } }

  /** Normalised inclusive bounds {r0,r1,c0,c1,colLo,colHi}, or null. colLo/colHi
   *  are the logical-column band (all columns when the selection has no sub
   *  span, e.g. keyboard selections). */
  selBounds() {
    const s = this.sel;
    if (!s) return null;
    const aSub = s.aSub ?? 0, sub = s.sub ?? SUB_FX_ARG;
    return {
      r0: Math.min(s.aRow, s.row), r1: Math.max(s.aRow, s.row),
      c0: Math.min(s.aCh, s.ch), c1: Math.max(s.aCh, s.ch),
      colLo: subToCol(Math.min(aSub, sub)), colHi: subToCol(Math.max(aSub, sub)),
    };
  }

  /** Logical columns the selection covers (for partial copy/paste/clear). */
  selCols() {
    const s = this.sel;
    return s ? colsForSubs(s.aSub ?? 0, s.sub ?? SUB_FX_ARG) : ALL_COLS;
  }

  /** Anchor a keyboard selection at the current cursor cell/column if none is
   *  active. Keyboard selection carries the SAME sub-column granularity as a
   *  mouse drag: it anchors on the cursor's sub and tracks it as the cursor
   *  moves, so Shift+↑/↓ grow the row span and Shift+←/→ the column band. */
  _ensureSel() {
    const c = this.store.cursor;
    if (!this.sel) this.sel = { aRow: c.row, aCh: c.ch, aSub: c.sub, row: c.row, ch: c.ch, sub: c.sub };
  }

  /** Keyboard block-extend (Shift+↑/↓, Page, Home/End): grow the row span,
   *  tracking the cursor's sub-column band. */
  extendSelection(dRow, dCh) {
    const map = this.getMap();
    if (!map) return;
    this._ensureSel();
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    c.row = clampInt(c.row + dRow, 0, map.totalRows - 1);
    c.ch = clampInt(c.ch + dCh, 0, chans - 1);
    this.sel.row = c.row; this.sel.ch = c.ch; this.sel.sub = c.sub;
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  /** Shift+←/→: extend the selection by walking the sub-cursor (crossing
   *  channels at the edges, like moveSubCursor), so the block carries
   *  sub-column granularity just like a mouse drag. */
  extendSelectionSub(dir) {
    const map = this.getMap();
    if (!map) return;
    this._ensureSel();
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    let idx = SUB_POSITIONS.findIndex(([s, n]) => s === c.sub && n === c.nib);
    if (idx < 0) idx = 0;
    idx += dir;
    if (idx < 0) {
      if (c.ch > 0) { c.ch--; idx = SUB_POSITIONS.length - 1; } else idx = 0;
    } else if (idx >= SUB_POSITIONS.length) {
      if (c.ch < chans - 1) { c.ch++; idx = 0; } else idx = SUB_POSITIONS.length - 1;
    }
    [c.sub, c.nib] = SUB_POSITIONS[idx];
    this.sel.ch = c.ch; this.sel.sub = c.sub; this.sel.row = c.row;
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  /** Dedupe writes by (pat,row) — channels sharing a pattern would otherwise
   *  produce two writes to the same cell and corrupt the undo capture. */
  dedupeWrites(fn) {
    const map = new Map();
    fn((pat, row, bytes) => map.set(`${pat}:${row}`, { pat, row, bytes: Uint8Array.from(bytes) }));
    return [...map.values()];
  }

  copySelection() {
    const b = this.selBounds();
    if (!b) return false;
    const rows = b.r1 - b.r0 + 1, chans = b.c1 - b.c0 + 1;
    const block = makeBlock(rows, chans);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < chans; c++) {
        const t = this.cellAt(b.r0 + r, b.c0 + c);
        if (t) blockCell(block, r, c).set(cellToBytes(t.cell));
      }
    }
    block.cols = this.selCols(); // which logical columns the paste will carry
    this.store.clipboard = block;
    return true;
  }

  cutSelection() {
    if (!this.copySelection()) return false;
    this.clearRegion(this.selBounds(), this.selCols());
    return true;
  }

  deleteSelection() {
    const b = this.selBounds();
    if (!b) return false;
    this.clearRegion(b, this.selCols());
    return true;
  }

  clearRegion(b, cols = ALL_COLS) {
    const empty = emptyCellBytes();
    const writes = this.dedupeWrites((push) => {
      for (let r = b.r0; r <= b.r1; r++) {
        for (let ch = b.c0; ch <= b.c1; ch++) {
          const t = this.cellAt(r, ch);
          // overlay only the selected columns' empty bytes onto the cell
          if (t) push(t.pat, t.rowInCue, overlayCols(cellToBytes(t.cell), empty, cols));
        }
      }
    });
    if (writes.length) {
      this.store.undo.apply(setCellsBytesOp(this.store.songIndex, writes));
      this.invalidate();
    }
  }

  paste() {
    const block = this.store.clipboard;
    if (!block) return false;
    const cols = block.cols ?? ALL_COLS;
    const c = this.store.cursor;
    const writes = this.dedupeWrites((push) => {
      for (let r = 0; r < block.rows; r++) {
        for (let ch = 0; ch < block.chans; ch++) {
          const t = this.cellAt(c.row + r, c.ch + ch);
          // merge only the block's columns onto the destination cell
          if (t) push(t.pat, t.rowInCue, overlayCols(cellToBytes(t.cell), blockCell(block, r, ch), cols));
        }
      }
    });
    if (!writes.length) return false;
    this.store.undo.apply(setCellsBytesOp(this.store.songIndex, writes));
    const map = this.getMap();
    const chans = this.store.doc.channelCount;
    this.sel = {
      aRow: c.row, aCh: c.ch, aSub: 0, sub: SUB_FX_ARG,
      row: Math.min(c.row + block.rows - 1, map.totalRows - 1),
      ch: Math.min(c.ch + block.chans - 1, chans - 1),
    };
    this.invalidate();
    return true;
  }

  /** Canvas-relative coords → {row, ch, sub, nib}, or null off-grid. */
  hitTest(x, y) {
    if (y < HEADER_H) return null;
    const row = Math.floor(this.scrollRow) + Math.floor((y - HEADER_H) / ROW_H);
    const colIdx = Math.floor((x - GUTTER_W) / COL_W);
    const ch = this.scrollCh + colIdx;
    const map = this.getMap();
    if (!map || row < 0 || row >= map.totalRows || colIdx < 0) return null;
    const chans = this.store.doc.channelCount;
    const charX = (x - GUTTER_W - colIdx * COL_W - 2) / CHAR_W;
    const [sub, nib] = charToSub(charX);
    return { row, ch: clampInt(ch, 0, chans - 1), sub, nib };
  }

  /**
   * Wheel-over-the-cursor-cell editing (record mode): the hovered column steps
   * by one unit — notes by one degree of the ACTIVE pitch table (a quarter-tone
   * in 24-TET, a semitone in 12-TET…), inst/vol/pan/fx by ±1. Consecutive
   * ticks coalesce into one undo entry.
   */
  wheelEdit(e, dir) {
    const store = this.store;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return false;
    const c = store.cursor;
    if (hit.row !== c.row || hit.ch !== c.ch) return false;
    const target = this.cursorCell();
    if (!target) return false;
    const cell = target.cell;

    let fields = null;
    switch (hit.sub) {
      case SUB_NOTE:
        if (cell.note >= 0x20) {
          fields = { note: stepNoteInTable(cell.note, store.pitchPreset, dir) };
        }
        break;
      case SUB_INST:
        fields = { instrment: clampInt(cell.instrment + dir, 0, 255) };
        break;
      case SUB_VOL:
        fields = cell.volumeEff === 3 && cell.volume === 0
          ? { volume: 0x20, volumeEff: 0 } // promote the no-op to a centre SET
          : { volume: clampInt(cell.volume + dir, 0, 0x3f) };
        break;
      case SUB_PAN:
        fields = cell.panEff === 3 && cell.pan === 0
          ? { pan: 0x20, panEff: 0 }
          : { pan: clampInt(cell.pan + dir, 0, 0x3f) };
        break;
      case SUB_FX_OP:
        fields = { effect: clampInt(cell.effect + dir, 0, 35) };
        break;
      case SUB_FX_ARG:
        fields = { effectArg: clampInt(cell.effectArg + dir, 0, 0xffff) };
        break;
    }
    if (fields === null) return false;
    store.undo.apply(setCellOp(store.songIndex, target.pat, target.rowInCue, fields,
      `wheel:${target.pat}:${target.rowInCue}:${c.ch}:${hit.sub}`));
    this.invalidate();
    return true;
  }

  moveCursor(dRow, dCh) {
    const map = this.getMap();
    if (!map) return;
    this.sel = null; // plain navigation drops any block selection
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    c.row = clampInt(c.row + dRow, 0, map.totalRows - 1);
    c.ch = clampInt(c.ch + dCh, 0, chans - 1);
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  /** Move through sub-positions (nibble-level), wrapping across channels. */
  moveSubCursor(dir) {
    this.sel = null; // plain navigation drops any block selection
    const c = this.store.cursor;
    const chans = this.store.doc.channelCount;
    let idx = SUB_POSITIONS.findIndex(([s, n]) => s === c.sub && n === c.nib);
    if (idx < 0) idx = 0;
    idx += dir;
    if (idx < 0) {
      if (c.ch > 0) { c.ch--; idx = SUB_POSITIONS.length - 1; } else idx = 0;
    } else if (idx >= SUB_POSITIONS.length) {
      if (c.ch < chans - 1) { c.ch++; idx = 0; } else idx = SUB_POSITIONS.length - 1;
    }
    [c.sub, c.nib] = SUB_POSITIONS[idx];
    this.keepCursorVisible();
    this.store.emit("cursor");
  }

  keepCursorVisible() {
    const c = this.store.cursor;
    const top = Math.floor(this.scrollRow);
    const vis = this.visibleRows();
    if (c.row < top) this.scrollRow = c.row;
    else if (c.row >= top + vis) this.scrollRow = c.row - vis + 1;
    if (c.ch < this.scrollCh) this.scrollCh = c.ch;
    else if (c.ch >= this.scrollCh + this.visibleChans()) {
      this.scrollCh = c.ch - this.visibleChans() + 1;
    }
  }

  /** The pattern cell at (row, ch), or null (empty cue slot / off-map). */
  cellAt(row, ch) {
    const { store } = this;
    if (ch < 0 || ch >= store.doc.channelCount) return null;
    const loc = this.locate(row);
    if (!loc) return null;
    const patNum = store.song.cues[loc.entry.cue][ch] & 0x7fff;
    if (patNum === PATTERN_EMPTY) return null;
    const pattern = store.song.patterns[patNum];
    if (!pattern) return null;
    return { pat: patNum, rowInCue: loc.rowInCue, cell: pattern[loc.rowInCue] };
  }

  /** The pattern cell under the cursor, or null (empty cue slot / off-map). */
  cursorCell() { return this.cellAt(this.store.cursor.row, this.store.cursor.ch); }

  /**
   * Record-mode key dispatch. Returns true when consumed. `jam` provides
   * octave/currentInst context and auditions entered notes.
   */
  processEditKey(e, jam) {
    const store = this.store;
    if (!store.record) return false;
    const target = this.cursorCell();
    if (!target) return false;
    const c = store.cursor;
    const action = interpretEditKey(
      { code: e.code, key: e.key }, c.sub, c.nib, target.cell,
      { octave: jam.octave, currentInst: jam.currentInst, preset: store.pitchPreset });
    if (!action) return false;

    if (action.fields) {
      store.undo.apply(setCellOp(store.songIndex, target.pat, target.rowInCue, action.fields));
    }
    if (action.jamNote !== undefined && store.audio) {
      store.audio.jamNote(0, c.ch, action.jamNote, jam.currentInst);
    }
    if (action.advanceNib) {
      this.moveSubCursor(1);
    } else if (action.advanceRow) {
      c.nib = 0; // field complete: back to its first nibble
      this.moveCursor(store.editStep, 0);
    }
    this.invalidate();
    return true;
  }

  /** Per-frame: follow playback + repaint when needed. */
  frame() {
    const store = this.store;
    if (!store.doc) return;
    const audio = store.audio;
    let playRow = -1;
    if (audio && audio.isPlaying()) {
      const map = this.getMap();
      const cue = audio.getCuePosition();
      const entry = map?.entries[cue];
      if (entry) {
        playRow = entry.startRow + Math.min(audio.getTrackerRow(), entry.rowLimit - 1);
        if (store.follow) {
          const centred = playRow - this.visibleRows() / 2;
          const target = Math.max(0, Math.min(centred, map.totalRows - 4));
          if (Math.abs(target - this.scrollRow) > 0.01) {
            this.scrollRow = target;
            this.needsRedraw = true;
          }
        }
      }
      this.needsRedraw = true; // meters + playhead move every frame while playing
    }
    if (this.needsRedraw) {
      this.needsRedraw = false;
      this.draw(playRow);
    }
  }

  /** Pattern number assigned to channel `ch` at the current play/cursor cue. */
  currentPatternFor(ch) {
    const song = this.store.song;
    if (!song) return null;
    const map = this.getMap();
    const audio = this.store.audio;
    let entry = null;
    if (audio && audio.isPlaying() && map) entry = map.entries[audio.getCuePosition()];
    else { const loc = this.locate(this.store.cursor.row); entry = loc?.entry ?? null; }
    if (!entry) return null;
    const words = song.cues[entry.cue];
    if (!words) return null;
    return words[ch] & 0x7fff;
  }

  draw(playRow) {
    if (playRow === undefined) playRow = -1;
    this.lastPlayRow = playRow;
    const C = themeColors();
    const { ctx, store } = this;
    const dpr = this.dpr;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const doc = store.doc;
    const song = store.song;
    if (!doc || !song) return;
    const map = this.getMap();
    const chans = doc.channelCount;
    const visCh = Math.min(this.visibleChans() + 1, chans - this.scrollCh);
    const visRows = this.visibleRows() + 1;
    const top = Math.floor(this.scrollRow);
    const audio = store.audio;

    ctx.font = canvasFont(FONT_PX);
    ctx.textBaseline = "middle";

    // ── channel headers: number + pattern, VU bar, pan tick, live note ──
    const headPal = { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent };
    for (let i = 0; i < visCh; i++) {
      const ch = this.scrollCh + i;
      const x = GUTTER_W + i * COL_W;
      ctx.fillStyle = ch % 2 ? C.panel : C.panel2;
      ctx.fillRect(x, 0, COL_W - 2, HEADER_H - 2);
      // top line: channel number (left) + current pattern number (right)
      ctx.fillStyle = C.dim;
      ctx.textAlign = "left";
      ctx.fillText(String(ch + 1).padStart(2, "0"), x + 4, 9);
      const patNum = this.currentPatternFor(ch);
      if (patNum !== null && patNum !== PATTERN_EMPTY) {
        ctx.fillStyle = C.accent;
        ctx.textAlign = "right";
        ctx.fillText(hex4(patNum), x + COL_W - 6, 9);
        ctx.textAlign = "left";
      }
      // VU
      const barX = x + 4;
      const barW = COL_W - 12;
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(barX, 16, barW, 7);
      if (audio && audio.getVoiceActive(ch)) {
        const vol = audio.getVoiceEffectiveVolume(ch);
        ctx.fillStyle = C.meter;
        ctx.fillRect(barX, 16, Math.round(barW * vol), 7);
      }
      // pan
      ctx.fillStyle = C.meterBg;
      ctx.fillRect(barX, 27, barW, 3);
      const pan = audio ? audio.getVoiceEffectivePan(ch) / 255 : 0.5;
      ctx.fillStyle = C.accent2;
      ctx.fillRect(barX + pan * (barW - 3), 25, 3, 7);
      // live note — same 4-char glyph font as the pattern cells (raw-aware)
      if (audio && audio.getVoiceActive(ch)) {
        paintNoteCell(ctx, audio.getVoiceNote(ch), store.pitchPreset, x + 4, 33,
          CHAR_W, 15, headPal, store.rawNoteView);
        ctx.fillStyle = C.dim;
        ctx.fillText(hex2(audio.getVoiceInstrument(ch)), x + 4 + 5 * CHAR_W, 40.5);
      }
      // muted channel: dim the header, MUTE tag over the meters
      if (store.voiceMutes[ch]) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = C.bg;
        ctx.fillRect(x, 0, COL_W - 2, HEADER_H - 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.fg2;
        ctx.textAlign = "center";
        ctx.fillText("MUTE", x + (COL_W - 2) / 2, 20);
        ctx.textAlign = "left";
      }
    }

    // ── rows ──
    const cursor = store.cursor;
    const sb = this.selBounds(); // block selection bounds (or null)
    const beats = store.beats(); // primary/secondary divisions from sMet
    for (let r = 0; r < visRows; r++) {
      const absRow = top + r;
      const y = HEADER_H + r * ROW_H;
      const loc = this.locate(absRow);
      if (!loc) continue;
      const { entry, rowInCue } = loc;

      // row background banding from the song's beat divisions
      if (absRow === playRow) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (rowInCue % beats.sec === 0) {
        ctx.fillStyle = C.rowBar;
        ctx.fillRect(GUTTER_W, y, W - GUTTER_W, ROW_H);
      } else if (rowInCue % beats.pri === 0) {
        ctx.fillStyle = C.rowBeat;
        ctx.fillRect(GUTTER_W, y, W - GUTTER_W, ROW_H);
      }

      // cue boundary line
      if (rowInCue === 0) {
        ctx.strokeStyle = C.cueLine;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
        ctx.stroke();
      }

      // gutter: "cue:row" (cue is 4-digit hex); beat rows highlighted
      ctx.textAlign = "left";
      ctx.fillStyle = rowInCue === 0 ? C.accent
        : rowInCue % beats.pri === 0 ? C.fg : C.dim;
      ctx.fillText(
        `${entry.cue.toString(16).toUpperCase().padStart(4, "0")}:${rowInCue.toString().padStart(2, "0")}`,
        6, y + ROW_H / 2);

      // cells
      for (let i = 0; i < visCh; i++) {
        const ch = this.scrollCh + i;
        const x = GUTTER_W + i * COL_W;
        if (sb && absRow >= sb.r0 && absRow <= sb.r1 && ch >= sb.c0 && ch <= sb.c1) {
          ctx.fillStyle = C.sel;
          if (sb.colLo === 0 && sb.colHi === 4) {
            ctx.fillRect(x - 2, y, COL_W - 2, ROW_H); // whole cell
          } else { // partial column band
            const cs = COL_CHAR_RANGE[sb.colLo][0], ce = COL_CHAR_RANGE[sb.colHi][1];
            ctx.fillRect(x + 2 + cs * CHAR_W - 1, y, (ce - cs) * CHAR_W + 2, ROW_H);
          }
        }
        if (absRow === cursor.row && ch === cursor.ch) {
          ctx.fillStyle = C.cursor;
          ctx.fillRect(x - 2, y, COL_W - 2, ROW_H);
          // sub-column caret: amber in record mode, blue otherwise
          const [cpos, cw] = subCharPos(cursor.sub ?? 0, cursor.nib ?? 0);
          ctx.fillStyle = store.record ? C.caret : C.caretNav;
          ctx.fillRect(x + 2 + cpos * CHAR_W - 1, y, cw * CHAR_W + 2, ROW_H);
        }
        const patNum = entry.info ? (this.store.song.cues[entry.cue][ch] & 0x7fff) : PATTERN_EMPTY;
        if (patNum === PATTERN_EMPTY) {
          continue;
        }
        const pattern = song.patterns[patNum];
        if (!pattern) continue;
        const cell = pattern[rowInCue];
        // Note glyphs: taut-style vector accidentals/ticks/sentinels, CJK
        // Shi'er lü via a conventional font, hex4 for raw/off-grid notes.
        paintNoteCell(ctx, cell.note, store.pitchPreset, x + 2, y, CHAR_W, ROW_H,
          { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent },
          store.rawNoteView);
        const instS = cell.instrment !== 0 ? hex2(cell.instrment) : "··";
        const volS = volToStr(cell.volume, cell.volumeEff);
        const panS = panToStr(cell.pan, cell.panEff);
        const fxS = fxToStr(cell.effect, cell.effectArg);

        ctx.fillStyle = cell.instrment !== 0 ? C.accent2 : C.dim;
        if (cell.instrment === 0) ctx.globalAlpha = 0.4;
        ctx.fillText(instS, x + 2 + 5 * CHAR_W, y + ROW_H / 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = volS === "···" ? C.dim : C.meter;
        if (volS === "···") ctx.globalAlpha = 0.4;
        ctx.fillText(volS, x + 2 + 8 * CHAR_W, y + ROW_H / 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = panS === "···" ? C.dim : C.colPan;
        if (panS === "···") ctx.globalAlpha = 0.4;
        ctx.fillText(panS, x + 2 + 12 * CHAR_W, y + ROW_H / 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = fxS === "·····" ? C.dim : C.accent;
        if (fxS === "·····") ctx.globalAlpha = 0.4;
        ctx.fillText(fxS, x + 2 + 16 * CHAR_W, y + ROW_H / 2);
        ctx.globalAlpha = 1;
      }
    }

    // gutter/header separators
    ctx.strokeStyle = C.border;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W - 4.5, 0);
    ctx.lineTo(GUTTER_W - 4.5, H);
    ctx.moveTo(0, HEADER_H - 1.5);
    ctx.lineTo(W, HEADER_H - 1.5);
    ctx.stroke();
  }
}

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
