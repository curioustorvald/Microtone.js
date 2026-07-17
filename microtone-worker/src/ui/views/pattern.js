// Pattern view (F3) — multi-column pattern editor. A Taud pattern is a
// per-channel entity (64 rows × 8-byte cells); cues place patterns onto
// channels. This view shows SEVERAL patterns side by side ("view windows",
// each an independent PatternPane with its own pattern selector + scroll), so
// a musician can edit one pattern while referencing/copy-pasting others in
// real time. The shared toolbar's edit tools + preview act on the currently
// ACTIVE column. Column count follows the viewport width (minimum 2).
// Reference: taut.js VIEW_PATTERN_DETAILS + PREVIEW_CUE_IDX.

import { hex2, volToStr, panToStr, fxToStr } from "../notenames.js";
import { paintNoteCell } from "../glyphs.js";
import { stepNoteInTable, transposePatternNotes } from "../pitchtables.js";
import {
  interpretEditKey, interpretBracketKey, rawNoteView, SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG,
  SUB_POSITIONS, subCharPos, charToSub, CELL_CHARS, lookahead,
  colsForSubs, subToCol, ALL_COLS, COL_CHAR_RANGE,
} from "../edit.js";
import { setCellOp, setPatternBytesOp, appendPatternOp, bulkNotesOp, setCellsBytesOp, setSectionOp } from "../../doc/ops.js";
import { escapeNonAscii, unescapeName } from "../names.js";
import { makeBlock, blockCell, cellToBytes, emptyCellBytes, overlayCols } from "../../doc/clipboard.js";
import {
  expandPatternBytes, shrinkPatternBytes,
  scaleVolumeBytes, transformPanBytes, changeInstrumentBytes,
} from "../../doc/patterntools.js";
import { CUE_EMPTY } from "../../format/taud-const.js";
import { themeColors } from "../theme.js";
import { canvasFont } from "../fonts.js";
import { showModal } from "../widgets/modal.js";
import { t } from "../i18n.js";

const FONT_PX = 14; // family comes from --cv-font via fonts.js
const CHAR_W = 8.5;
const ROW_H = 17;
const GUTTER_W = 34;
const PREVIEW_CUE = 8191; // device-only scratch cue (taut PREVIEW_CUE_IDX idiom)

const MIN_PANES = 2;         // spec: at least two columns
const MAX_PANES = 16;         // sanity cap for very wide viewports
const MIN_PANE_W = 250;      // px budget per column before we add another

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ───────────────────────── one column ─────────────────────────
// A PatternPane owns a pattern index, cursor, scroll, selection and its own
// canvas. All the per-pattern editing lives here; the container routes the
// shared toolbar/keyboard to whichever pane is active.
class PatternPane {
  constructor(container, index) {
    this.container = container;
    this.store = container.store;
    this.jam = container.jam;
    this.index = index;
    this.patIdx = 0;
    this.cursor = { row: 0, sub: 0, nib: 0 };
    this.scrollRow = 0;
    this.sel = null;    // row-range selection {aRow, row, aSub, sub}
    this._drag = null;  // active pointer-drag anchor {row, sub}
    this.previewing = false;
    this.previewStarted = false; // set once the worklet confirms playback
    this.needsRedraw = true;

    this.el = document.createElement("div");
    this.el.className = "pattern-pane";
    this.header = document.createElement("div");
    this.header.className = "pattern-pane-hd";
    this.numEl = document.createElement("span");
    this.numEl.className = "pane-num";
    this.numEl.textContent = "#" + (index + 1);
    this.patInput = document.createElement("input");
    this.patInput.type = "text";
    this.patInput.className = "pat-input";
    this.patInput.addEventListener("change", () => this.setPattern(parseInt(this.patInput.value, 16) || 0));
    const prev = mkBtn("◀", () => this.setPattern(this.patIdx - 1));
    const next = mkBtn("▶", () => this.setPattern(this.patIdx + 1));
    // Editable pattern name (pNam) — doubles as the name display alongside the
    // number. Commit on blur/Enter; Enter also returns focus to the grid.
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.className = "pat-name-input";
    this.nameInput.placeholder = t("pat.namePlaceholder");
    this.nameInput.title = t("pat.nameTitle");
    this.nameInput.addEventListener("change", () => this.commitName());
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { this.commitName(); this.canvas.focus?.(); }
      e.stopPropagation(); // keep grid shortcuts from firing while typing a name
    });
    this.info = document.createElement("span");
    this.info.className = "pane-info";
    this.header.append(this.numEl, prev, this.patInput, next, this.nameInput, this.info);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pattern-canvas";
    this.el.append(this.header, this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.attachEvents();
  }

  isActive() { return this.container.active === this; }
  invalidate() { this.needsRedraw = true; }
  setIndex(i) { this.index = i; this.numEl.textContent = "#" + (i + 1); }
  applyActiveClass(on) { this.el.classList.toggle("active", on); }

  attachEvents() {
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      // Wheel-edit only on the active column (record mode); reference panes scroll.
      // Never wheel-edit mid drag-selection — then the wheel only scrolls (item 57).
      if (this.store.record && this.isActive() && this._drag === null &&
          this.wheelEdit(e, d < 0 ? 1 : -1)) return;
      this.scrollRow = clampInt(this.scrollRow + Math.round(d / ROW_H), 0, 48);
      this.invalidate();
    }, { passive: false });

    this.canvas.addEventListener("pointerdown", (e) => {
      const hit = this.hitTest(e);
      if (!hit) return;
      this.container.setActivePane(this); // clicking a column focuses it
      if (e.shiftKey) {
        // Shift+click = full-column selection.
        if (!this.sel) this.sel = { aRow: this.cursor.row, row: hit.row, aSub: 0, sub: SUB_FX_ARG };
        else { this.sel.row = hit.row; this.sel.aSub = 0; this.sel.sub = SUB_FX_ARG; }
      } else {
        // Mouse-drag carries sub-column granularity.
        this.sel = null;
        this._drag = { row: hit.row, sub: hit.sub };
        this.canvas.setPointerCapture?.(e.pointerId);
      }
      this.cursor = hit;
      this.invalidate();
      this.store.emit("cursor");
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this._drag === null) return;
      const hit = this.hitTest(e);
      if (!hit) return;
      this.sel = (hit.row !== this._drag.row || hit.sub !== this._drag.sub)
        ? { aRow: this._drag.row, row: hit.row, aSub: this._drag.sub, sub: hit.sub }
        : null;
      this.cursor.row = hit.row; this.cursor.sub = hit.sub; this.cursor.nib = hit.nib;
      this.invalidate();
      this.store.emit("cursor");
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (this._drag !== null) {
        this.canvas.releasePointerCapture?.(e.pointerId);
        this._drag = null;
      }
    });

    // Interacting with the header — ◀/▶, the pattern-number field, or the name
    // field — focuses this column (item 46).
    this.header.addEventListener("pointerdown", () => this.container.setActivePane(this));
    this.patInput.addEventListener("focus", () => this.container.setActivePane(this));
    this.nameInput.addEventListener("focus", () => this.container.setActivePane(this));
  }

  // Arbitrary-number patterns (item 48): an unmaterialised index shows the
  // shared empty pattern (editable — the first edit materialises it).
  pattern() {
    return this.store.song?.patterns[this.patIdx] ?? this.store.doc?.emptyPattern() ?? null;
  }

  setPattern(idx) {
    // Every pattern 0x0000..0x7FFE is navigable, whether or not it exists yet.
    this.patIdx = this.store.song ? clampInt(idx, 0, 0x7ffe) : 0;
    this.sel = null;
    this.refreshHeader();
    this.invalidate();
  }

  // ── row-range selection + clipboard ──
  hasSelection() { return this.sel !== null; }
  clearSelection() { if (this.sel) { this.sel = null; this.invalidate(); } }

  /** Ctrl+A — select the whole pattern column: every row, all sub-columns. */
  selectColumn() {
    this.sel = { aRow: 0, row: 63, aSub: 0, sub: SUB_FX_ARG };
    this.invalidate();
    this.store.emit("cursor");
  }

  selRowBounds() {
    const s = this.sel;
    if (!s) return null;
    const aSub = s.aSub ?? 0, sub = s.sub ?? SUB_FX_ARG;
    return {
      r0: Math.min(s.aRow, s.row), r1: Math.max(s.aRow, s.row),
      colLo: subToCol(Math.min(aSub, sub)), colHi: subToCol(Math.max(aSub, sub)),
    };
  }

  selCols() {
    const s = this.sel;
    return s ? colsForSubs(s.aSub ?? 0, s.sub ?? SUB_FX_ARG) : ALL_COLS;
  }

  /** Anchor a keyboard selection at the current cursor cell/column if none is
   *  active. Keyboard selection carries the SAME sub-column granularity as a
   *  mouse drag: it anchors on the cursor's sub and tracks it as the cursor
   *  moves, so Shift+↑/↓ grow the row span and Shift+←/→ the column band. */
  _ensureSel() {
    if (!this.sel) {
      this.sel = { aRow: this.cursor.row, row: this.cursor.row, aSub: this.cursor.sub, sub: this.cursor.sub };
    }
  }

  extendSelection(dRow) {
    this._ensureSel();
    this.cursor.row = clampInt(this.cursor.row + dRow, 0, 63);
    this.sel.row = this.cursor.row;
    this.sel.sub = this.cursor.sub; // track the cursor's column band
    this._followCursor();
    this.invalidate();
    this.store.emit("cursor");
  }

  /** Shift+←/→: widen or narrow the selection's column band by walking the
   *  cursor's sub-position (nibble steps, matching moveSubCursor). */
  extendSelectionSub(dir) {
    this._ensureSel();
    const c = this.cursor;
    let idx = SUB_POSITIONS.findIndex(([s, n]) => s === c.sub && n === c.nib);
    idx = clampInt(idx + dir, 0, SUB_POSITIONS.length - 1);
    [c.sub, c.nib] = SUB_POSITIONS[idx];
    this.sel.row = c.row;
    this.sel.sub = c.sub;
    this.invalidate();
    this.store.emit("cursor");
  }

  copySelection() {
    const b = this.selRowBounds();
    const pattern = this.pattern();
    if (!b || !pattern) return false;
    const rows = b.r1 - b.r0 + 1;
    const block = makeBlock(rows, 1);
    for (let r = 0; r < rows; r++) blockCell(block, r, 0).set(cellToBytes(pattern[b.r0 + r]));
    block.cols = this.selCols();
    this.store.clipboard = block;
    return true;
  }

  cutSelection() {
    if (!this.copySelection()) return false;
    this.clearRegion(this.selRowBounds(), this.selCols());
    return true;
  }

  deleteSelection() {
    const b = this.selRowBounds();
    if (!b) return false;
    this.clearRegion(b, this.selCols());
    return true;
  }

  clearRegion(b, cols = ALL_COLS) {
    const empty = emptyCellBytes();
    const pattern = this.pattern();
    const writes = [];
    for (let r = b.r0; r <= b.r1; r++) {
      writes.push({ pat: this.patIdx, row: r, bytes: overlayCols(cellToBytes(pattern[r]), empty, cols) });
    }
    this.store.undo.apply(setCellsBytesOp(this.store.songIndex, writes));
    this.invalidate();
  }

  paste() {
    const block = this.store.clipboard;
    const pattern = this.pattern();
    if (!block || !pattern) return false;
    const cols = block.cols ?? ALL_COLS;
    const start = this.cursor.row;
    const writes = [];
    for (let r = 0; r < block.rows; r++) {
      const row = start + r;
      if (row > 63) break;
      writes.push({ pat: this.patIdx, row, bytes: overlayCols(cellToBytes(pattern[row]), blockCell(block, r, 0), cols) });
    }
    if (!writes.length) return false;
    this.store.undo.apply(setCellsBytesOp(this.store.songIndex, writes));
    this.sel = { aRow: start, row: Math.min(start + block.rows - 1, 63), aSub: 0, sub: SUB_FX_ARG };
    this.invalidate();
    return true;
  }

  /** Commit this pane's pattern name (pNam) as one undoable step. */
  commitName() {
    const doc = this.store.doc;
    if (!doc) return;
    const escaped = escapeNonAscii(this.nameInput.value.trim());
    if (escaped === (doc.patternName(this.patIdx) ?? "")) return;
    this.store.undo.apply(setSectionOp("pNam", doc.buildPatternNames(this.patIdx, escaped)));
    this.container.refreshAllHeaders(); // other panes on the same pattern update
    this.store.emit("edit"); // repaint the Timeline's name display
  }

  /** Update this column's header — pattern number + name + which cues use it. */
  refreshHeader() {
    this.patInput.value = this.patIdx.toString(16).toUpperCase().padStart(4, "0");
    const doc = this.store.doc;
    if (this.nameInput !== document.activeElement) {
      this.nameInput.value = doc ? (unescapeName(doc.patternName(this.patIdx)) || "") : "";
    }
    const song = this.store.song;
    if (!song) { this.info.textContent = ""; return; }
    const users = [];
    song.cues.forEach((words, c) => {
      for (let ch = 0; ch < this.store.doc.channelCount; ch++) {
        if ((words[ch] & 0x7fff) === this.patIdx && (words[ch] & 0x7fff) !== CUE_EMPTY) {
          users.push(`${c.toString(16).toUpperCase().padStart(4, "0")}:${ch + 1}`);
          break;
        }
      }
    });
    this.info.textContent = users.length
      ? `${users.length} ${users.length === 1 ? "cue" : "cues"}: ${users.slice(0, 4).join(" ")}${users.length > 4 ? "…" : ""}`
      : "unused";
  }

  /** Preview: play just this pattern via the device-only scratch cue (HALT). */
  async togglePreview() {
    const store = this.store;
    if (!store.doc) return;
    if (this.previewing) { this.stopPreview(); return; }
    await window.__microtoneEnsureAudio?.();
    if (!store.audio) return;
    const song = store.song;
    // Faithful to taut startPlayPattern: clean slate + restore song tempo.
    store.sync?.flushPatterns();
    store.audio.stop(0);
    store.audio.setBPM(0, song.bpm);
    store.audio.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
    // Preview cue: voice 0 = this pattern, all other voices CUE_EMPTY (0x7FFF),
    // plus a HALT so it ends after one pass (channel 8 sign bit → word0 = HALT).
    const chans = store.doc.channelCount;
    const bytes = new Uint8Array(chans * 2);
    for (let i = 0; i < bytes.length; i += 2) { bytes[i] = 0xff; bytes[i + 1] = 0x7f; }
    bytes[0] = this.patIdx & 0xff;          // channel 0 ← this pattern
    bytes[1] = (this.patIdx >>> 8) & 0x7f;
    bytes[17] |= 0x80;                      // ch8 sign bit → word0 bit 8 = HALT
    store.audio.uploadCue(PREVIEW_CUE, bytes);
    store.audio.resetFunkState(0);
    store.audio.setCuePosition(0, PREVIEW_CUE);
    store.audio.setTrackerRow(0, 0);
    store.audio.play(0);
    this.previewing = true;
    this.previewStarted = false; // do NOT auto-stop until the worklet confirms play
  }

  stopPreview() {
    this.store.audio?.stop(0);
    this.previewing = false;
    this.previewStarted = false;
  }

  // ── pattern-scoped edit operations ──

  /** Duplicate: append a copy of this pattern and jump to it. */
  duplicate() {
    const store = this.store;
    if (!store.doc || !this.pattern()) return;
    if (store.song.patterns.length >= 0x7fff) return; // cue words are 15-bit
    store.undo.apply(appendPatternOp(store.songIndex,
      store.doc.patternBytes(store.songIndex, this.patIdx)));
    this.setPattern(store.song.patterns.length - 1);
  }

  /** Run a bytes→bytes transform (lengthen/shorten) as one undo step. */
  applyPatternBytes(fn) {
    const store = this.store;
    if (!store.doc || !this.pattern()) return;
    store.undo.apply(setPatternBytesOp(store.songIndex, this.patIdx,
      fn(store.doc.patternBytes(store.songIndex, this.patIdx))));
    this.refreshHeader();
    this.invalidate();
  }

  /** Prompt for an integer factor, then lengthen (space rows out) or shorten
   *  (keep every nth row) the whole pattern. Rows pushed past the end are
   *  dropped — the IT Alt-F/Alt-G behaviour, generalised past the fixed ×2. */
  async _resizeOp(kind) {
    if (!this.pattern()) return;
    const result = await showModal({
      title: t(`pat.${kind}ModalTitle`, { pat: this._titlePat() }),
      body: t(`pat.${kind}Body`),
      fields: [
        { name: "factor", label: t("pat.factor"), type: "number", value: 2, min: 2, max: 63 },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const n = clampInt(parseInt(result.factor || "2", 10) | 0, 2, 63);
    const fn = kind === "lengthen" ? expandPatternBytes : shrinkPatternBytes;
    this.applyPatternBytes((src) => fn(src, n));
  }

  lengthenOp() { return this._resizeOp("lengthen"); }
  shortenOp() { return this._resizeOp("shorten"); }

  /** Notation-aware transpose of this pattern. The fine unit follows the
   *  song's tuning — semitones in 12-TET, steps in other TETs, raw note
   *  units in Raw — and the coarse unit is octaves (or periods when the
   *  tuning isn't octave-based, e.g. Bohlen-Pierce tritaves). */
  async transpose() {
    const store = this.store;
    if (!store.doc || !this.pattern()) return;
    const preset = store.pitchPreset;
    const raw = !preset || preset.table.length === 0;
    // `t: "d"` is the 12-notes-per-octave family (12-TET, Pythagorean, Shi'er
    // lü, ProTracker) — there a table step IS a semitone.
    const fineLabel = raw ? t("pat.unitNoteUnits")
      : preset.t === "d" ? t("pat.unitSemitones") : t("pat.unitSteps");
    // interval 0 = an absolute table (ProTracker): coarse moves an octave in
    // pitch and re-snaps, so it is octaves here too.
    const iv = preset?.interval ?? 0x1000;
    const coarseLabel = (iv === 0x1000 || iv === 0)
      ? t("pat.unitOctaves") : t("pat.unitPeriods");
    const result = await showModal({
      title: t("pat.transposeModalTitle", { pat: this._titlePat() }),
      body: t("pat.transposeBody", { scope: this._opScope().scope }),
      fields: [
        { name: "fine", label: fineLabel, type: "number", value: 0, min: -4096, max: 4096 },
        { name: "coarse", label: coarseLabel, type: "number", value: 0, min: -10, max: 10 },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const fine = parseInt(result.fine || "0", 10) | 0;
    const coarse = parseInt(result.coarse || "0", 10) | 0;
    if (fine === 0 && coarse === 0) return;
    // Percussion slots skip the shift (retune semantics — a kit piece's pitch
    // selects the drum, it isn't melodic).
    const percSlots = new Uint8Array(1024);
    for (const s of store.doc.usedInstrumentSlots()) {
      if (store.doc.instruments[s].isPercussion) percSlots[s] = 1;
    }
    const patIdx = this.patIdx;
    store.doc.ensurePattern(store.songIndex, patIdx); // materialise if arbitrary-number (item 48)
    // Honour a row-range block selection (item 58); else the whole pattern.
    const b = this.selRowBounds();
    const [rowLo, rowHi] = b ? [b.r0, b.r1] : [0, 63];
    store.undo.apply(bulkNotesOp(store.songIndex,
      (song) => transposePatternNotes(song, patIdx, preset, percSlots, fine, coarse, rowLo, rowHi)));
    this.invalidate();
  }

  /** Row span the bulk ops act on: the row-range selection if one is active,
   *  else the whole pattern. Returns [r0,r1] plus a human scope label. */
  _opScope() {
    const b = this.selRowBounds();
    return b
      ? { rows: [b.r0, b.r1], scope: t("pat.scopeSel", { r0: b.r0, r1: b.r1 }) }
      : { rows: null, scope: t("pat.scopeAll") };
  }

  _titlePat() { return this.patIdx.toString(16).toUpperCase().padStart(4, "0"); }

  /** Volume amplify: new = old × mult + add (existing volumes only). */
  async volumeOp() {
    if (!this.pattern()) return;
    const { rows, scope } = this._opScope();
    const result = await showModal({
      title: t("pat.volModalTitle", { pat: this._titlePat() }),
      body: t("pat.volBody", { scope }),
      fields: [
        { name: "mult", label: t("pat.multiply"), type: "number", value: 1, min: -8, max: 8 },
        { name: "add", label: t("pat.add"), type: "number", value: 0, min: -63, max: 63 },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const mult = parseFloat(result.mult ?? "1");
    const add = parseInt(result.add || "0", 10) | 0;
    if (mult === 1 && add === 0) return;
    this._applyBytes((src) => scaleVolumeBytes(src, mult, add, rows));
  }

  /** Pan widen/narrow (signed mult about centre) + shift (add). */
  async panOp() {
    if (!this.pattern()) return;
    const { rows, scope } = this._opScope();
    const result = await showModal({
      title: t("pat.panModalTitle", { pat: this._titlePat() }),
      body: t("pat.panBody", { scope }),
      fields: [
        { name: "mult", label: t("pat.widen"), type: "number", value: 1, min: -4, max: 4 },
        { name: "shift", label: t("pat.shift"), type: "number", value: 0, min: -63, max: 63 },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const mult = parseFloat(result.mult ?? "1");
    const shift = parseInt(result.shift || "0", 10) | 0;
    if (mult === 1 && shift === 0) return;
    this._applyBytes((src) => transformPanBytes(src, mult, shift, rows));
  }

  /** Change instrument: From blank → every non-empty inst becomes To. */
  async instrumentOp() {
    if (!this.pattern()) return;
    const { rows, scope } = this._opScope();
    const result = await showModal({
      title: t("pat.instModalTitle", { pat: this._titlePat() }),
      body: t("pat.instBody", { scope }),
      fields: [
        { name: "from", label: t("pat.instFrom"), type: "text", value: "", placeholder: t("pat.instAll") },
        { name: "to", label: t("pat.instTo"), type: "text", value: "" },
      ],
      okLabel: t("common.apply"),
    });
    if (!result) return;
    const fromStr = (result.from ?? "").trim();
    const from = fromStr === "" ? null : (parseInt(fromStr, 16) & 0xff);
    const to = parseInt((result.to ?? "").trim() || "0", 16) & 0xff;
    this._applyBytes((src) => changeInstrumentBytes(src, from, to, rows));
  }

  /** Apply a bytes→bytes pattern transform as one undo step + repaint. */
  _applyBytes(fn) {
    const store = this.store;
    store.undo.apply(setPatternBytesOp(store.songIndex, this.patIdx,
      fn(store.doc.patternBytes(store.songIndex, this.patIdx))));
    this.invalidate();
  }

  hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const row = this.scrollRow + Math.floor(y / ROW_H);
    if (row < 0 || row > 63 || x < GUTTER_W) return null;
    const charX = (x - GUTTER_W - 4) / CHAR_W;
    const [sub, nib] = charToSub(charX);
    return { row: clampInt(row, 0, 63), sub, nib };
  }

  moveCursor(dRow) {
    this.sel = null;
    this.cursor.row = clampInt(this.cursor.row + dRow, 0, 63);
    this._followCursor();
    this.invalidate();
    this.store.emit("cursor");
  }

  /** Lookahead-scroll the pattern to keep the cursor in the central 64% (item 42). */
  _followCursor() {
    const vis = Math.floor(this.canvas.clientHeight / ROW_H);
    this.scrollRow = lookahead(this.cursor.row, this.scrollRow, vis, Math.max(0, 64 - vis));
  }

  moveSubCursor(dir) {
    this.sel = null;
    const c = this.cursor;
    let idx = SUB_POSITIONS.findIndex(([s, n]) => s === c.sub && n === c.nib);
    idx = clampInt(idx + dir, 0, SUB_POSITIONS.length - 1);
    [c.sub, c.nib] = SUB_POSITIONS[idx];
    this.invalidate();
    this.store.emit("cursor");
  }

  /** View-specific keys; true when consumed. Called from the container (which
   *  has already routed here as the active pane). */
  processKey(e) {
    switch (e.code) {
      case "ArrowUp": e.shiftKey ? this.extendSelection(-1) : this.moveCursor(-1); return true;
      case "ArrowDown": e.shiftKey ? this.extendSelection(1) : this.moveCursor(1); return true;
      case "ArrowLeft": e.shiftKey ? this.extendSelectionSub(-1) : this.moveSubCursor(-1); return true;
      case "ArrowRight": e.shiftKey ? this.extendSelectionSub(1) : this.moveSubCursor(1); return true;
      case "PageUp": e.shiftKey ? this.extendSelection(-16) : this.moveCursor(-16); return true;
      case "PageDown": e.shiftKey ? this.extendSelection(16) : this.moveCursor(16); return true;
      case "Home": e.shiftKey ? this.extendSelection(-64) : this.moveCursor(-64); return true;
      case "End": e.shiftKey ? this.extendSelection(64) : this.moveCursor(64); return true;
      case "BracketLeft": case "BracketRight": return false; // octave keys: global
    }
    const pattern = this.pattern();
    if (!pattern || !this.store.record) return false;
    const c = this.cursor;
    const cell = pattern[c.row];
    const action = interpretEditKey(
      { code: e.code, key: e.key }, c.sub, c.nib, cell,
      { octave: this.jam.octave, currentInst: this.jam.currentInst, preset: this.store.pitchPreset,
        rawHex: rawNoteView(this.store.rawNoteView, this.store.pitchPreset) });
    if (!action) return false;
    if (action.fields) {
      this.store.undo.apply(setCellOp(this.store.songIndex, this.patIdx, c.row, action.fields));
    }
    if (action.jamNote !== undefined && this.store.audio) {
      this.store.audio.jamNote(0, 0, action.jamNote, this.jam.currentInst);
    }
    if (action.advanceNib) this.moveSubCursor(1);
    else if (action.advanceRow) { c.nib = 0; this.moveCursor(this.store.editStep); }
    this.invalidate();
    return true;
  }

  /** Contextual bracket-key cell edit (item 47.6), record mode only. */
  bracketEdit(dir, shift) {
    const store = this.store;
    if (!store.record) return false;
    const pattern = this.pattern();
    if (!pattern) return false;
    const c = this.cursor;
    const action = interpretBracketKey(dir, shift, c.sub, pattern[c.row],
      { preset: store.pitchPreset, instSlots: store.doc.selectableInstrumentSlots() });
    if (!action) return false;
    store.undo.apply(setCellOp(store.songIndex, this.patIdx, c.row, action.fields));
    this.invalidate();
    return true;
  }

  wheelEdit(e, dir) {
    const hit = this.hitTest(e);
    if (!hit || hit.row !== this.cursor.row) return false;
    const pattern = this.pattern();
    if (!pattern) return false;
    const cell = pattern[this.cursor.row];
    let fields = null;
    switch (hit.sub) {
      case SUB_NOTE:
        if (cell.note >= 0x20) fields = { note: stepNoteInTable(cell.note, this.store.pitchPreset, dir) };
        break;
      case SUB_INST: fields = { instrment: clampInt(cell.instrment + dir, 0, 255) }; break;
      case SUB_VOL:
        fields = cell.volumeEff === 3 && cell.volume === 0
          ? { volume: 0x20, volumeEff: 0 }
          : { volume: clampInt(cell.volume + dir, 0, 0x3f) };
        break;
      case SUB_PAN:
        fields = cell.panEff === 3 && cell.pan === 0
          ? { pan: 0x20, panEff: 0 }
          : { pan: clampInt(cell.pan + dir, 0, 0x3f) };
        break;
      case SUB_FX_OP: fields = { effect: clampInt(cell.effect + dir, 0, 35) }; break;
      case SUB_FX_ARG: fields = { effectArg: clampInt(cell.effectArg + dir, 0, 0xffff) }; break;
    }
    if (fields === null) return false;
    this.store.undo.apply(setCellOp(this.store.songIndex, this.patIdx, this.cursor.row, fields,
      `pwheel:${this.patIdx}:${this.cursor.row}:${hit.sub}`));
    this.invalidate();
    return true;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(160, this.el.clientWidth);
    const h = Math.max(80, this.el.clientHeight - this.header.offsetHeight - 4);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (this.canvas.width === cw && this.canvas.height === ch && this.dpr === dpr) return;
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.dpr = dpr;
    // Repaint synchronously — setting canvas.width blanks the backing store,
    // and a deferred redraw flashes when the command palette reflows the view.
    this.needsRedraw = false;
    this.draw();
  }

  /** Per-frame housekeeping: playhead repaint + preview auto-stop.
   *  Returns true when the preview state changed (so the container refreshes
   *  the shared button). */
  frame() {
    const audio = this.store.audio;
    if (this.previewing && audio?.isPlaying()) this.needsRedraw = true; // playhead row
    let changed = false;
    // Auto-reset when the preview ends — but only AFTER we've actually seen it
    // playing. Snapshots lag the play() command by ~16 ms, so checking
    // !isPlaying() too early would kill the preview before it ever started.
    if (this.previewing && audio) {
      if (audio.isPlaying()) this.previewStarted = true;
      else if (this.previewStarted) { this.stopPreview(); changed = true; }
    }
    if (this.needsRedraw) { this.needsRedraw = false; this.draw(); }
    return changed;
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
    const pattern = this.pattern();
    if (!pattern) {
      ctx.fillStyle = C.dim;
      ctx.font = canvasFont(FONT_PX);
      ctx.fillText("no such pattern", 20, 30);
      return;
    }
    ctx.font = canvasFont(FONT_PX);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const audio = store.audio;
    const playRow = this.previewing && audio?.isPlaying() &&
      audio.getCuePosition() === PREVIEW_CUE ? audio.getTrackerRow() : -1;
    const active = this.isActive();

    const vis = Math.floor(H / ROW_H) + 1;
    const x0 = GUTTER_W + 4;
    const sb = this.selRowBounds(); // row-range selection (or null)
    const beats = store.beats(); // primary/secondary divisions from sMet
    for (let r = 0; r < vis; r++) {
      const row = this.scrollRow + r;
      if (row > 63) break;
      const y = r * ROW_H;
      if (row === playRow) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (row % beats.sec === 0) {
        ctx.fillStyle = C.rowBar;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (row % beats.pri === 0) {
        ctx.fillStyle = C.rowBeat;
        ctx.fillRect(0, y, W, ROW_H);
      }
      if (sb && row >= sb.r0 && row <= sb.r1) {
        ctx.fillStyle = C.sel;
        if (sb.colLo === 0 && sb.colHi === 4) {
          ctx.fillRect(GUTTER_W, y, CELL_CHARS * CHAR_W + 8, ROW_H);
        } else {
          const cs = COL_CHAR_RANGE[sb.colLo][0], ce = COL_CHAR_RANGE[sb.colHi][1];
          ctx.fillRect(x0 + cs * CHAR_W - 1, y, (ce - cs) * CHAR_W + 2, ROW_H);
        }
      }
      if (row === this.cursor.row) {
        ctx.fillStyle = C.cursor;
        ctx.fillRect(GUTTER_W, y, CELL_CHARS * CHAR_W + 8, ROW_H);
        const [cpos, cw] = subCharPos(this.cursor.sub, this.cursor.nib);
        // Amber record caret only on the active column; reference panes show
        // a plain cursor so it's clear which one edits will land in.
        ctx.fillStyle = (store.record && active) ? C.caret : C.cursor;
        ctx.fillRect(x0 + cpos * CHAR_W - 1, y, cw * CHAR_W + 2, ROW_H);
      }
      ctx.fillStyle = row % beats.sec === 0 ? C.accent
        : row % beats.pri === 0 ? C.fg : C.dim;
      ctx.fillText(row.toString(16).toUpperCase().padStart(2, "0"), 8, y + ROW_H / 2);

      const cell = pattern[row];
      paintNoteCell(ctx, cell.note, store.pitchPreset, x0, y, CHAR_W, ROW_H,
        { note: C.fg, sentinel: C.accent, dim: C.dim, offGrid: C.accent },
        store.rawNoteView);
      const instS = cell.instrment !== 0 ? hex2(cell.instrment) : "··";
      const volS = volToStr(cell.volume, cell.volumeEff);
      const panS = panToStr(cell.pan, cell.panEff);
      const fxS = fxToStr(cell.effect, cell.effectArg);
      ctx.fillStyle = cell.instrment !== 0 ? C.accent2 : C.dim;
      ctx.fillText(instS, x0 + 5 * CHAR_W, y + ROW_H / 2);
      ctx.fillStyle = volS === "···" ? C.dim : C.meter;
      ctx.fillText(volS, x0 + 8 * CHAR_W, y + ROW_H / 2);
      ctx.fillStyle = panS === "···" ? C.dim : C.colPan;
      ctx.fillText(panS, x0 + 12 * CHAR_W, y + ROW_H / 2);
      ctx.fillStyle = fxS === "·····" ? C.dim : C.accent;
      ctx.fillText(fxS, x0 + 16 * CHAR_W, y + ROW_H / 2);
    }

    ctx.strokeStyle = C.border;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W - 2.5, 0);
    ctx.lineTo(GUTTER_W - 2.5, H);
    ctx.stroke();
  }
}

// ───────────────────── multi-column container ─────────────────────
// Owns the shared toolbar and a responsive row of PatternPanes. The active
// pane receives the toolbar's edit tools, the preview button, the keyboard,
// and the clipboard. The public surface (cursor/patIdx/sel/setPattern/… and
// the clipboard methods) delegates to the active pane so app.js + the smoke
// tests keep talking to `patternView` unchanged.
export class PatternView {
  constructor(store, host, jam) {
    this.store = store;
    this.jam = jam;
    this.visible = false;
    this.panes = [];
    this.activeIdx = 0;

    this.root = document.createElement("div");
    this.root.className = "pattern-view";
    this.bar = document.createElement("div");
    this.bar.className = "files-bar";
    this.panesEl = document.createElement("div");
    this.panesEl.className = "pattern-panes";
    this.root.append(this.bar, this.panesEl);
    host.appendChild(this.root);

    this.buildBar();

    store.on("doc", () => {
      this.resetPanes();
      if (this.visible) { this.refreshAllHeaders(); this.syncPreviewBtn(); }
      this.invalidate();
    });
    store.on("edit", () => this.invalidate());

    this._ro = new ResizeObserver(() => { if (this.visible) this.layout(); });
    this._ro.observe(this.root);

    for (let i = 0; i < MIN_PANES; i++) this.addPane();
    this.reassertActive();
  }

  get active() { return this.panes[this.activeIdx]; }

  // ── delegating surface (app.js palette/clipboard + smoke tests) ──
  get cursor() { return this.active.cursor; }
  get patIdx() { return this.active.patIdx; }
  get scrollRow() { return this.active.scrollRow; }
  get sel() { return this.active.sel; }
  set sel(v) { this.active.sel = v; this.active.invalidate(); }
  pattern() { return this.active.pattern(); }
  setPattern(i) { return this.active.setPattern(i); }
  duplicate() { return this.active.duplicate(); }
  applyPatternBytes(fn) { return this.active.applyPatternBytes(fn); }
  hasSelection() { return this.active.hasSelection(); }
  clearSelection() { return this.active.clearSelection(); }
  selectColumn() { return this.active.selectColumn(); }
  bracketEdit(dir, shift) { return this.active.bracketEdit(dir, shift); }
  copySelection() { return this.active.copySelection(); }
  cutSelection() { return this.active.cutSelection(); }
  deleteSelection() { return this.active.deleteSelection(); }
  paste() { return this.active.paste(); }

  show() {
    this.visible = true;
    this.layout();          // fit column count to width + resize panes
    this.refreshAllHeaders();
    this.syncPreviewBtn();
    this.invalidate();
  }
  hide() {
    this.visible = false;
    for (const p of this.panes) if (p.previewing) p.stopPreview();
  }
  invalidate() { for (const p of this.panes) p.invalidate(); }

  /** (Re)build the shared toolbar — labels come from i18n, so this also
   *  re-runs on a runtime language change. Tools act on the active pane. */
  buildBar() {
    this.bar.innerHTML = "";
    this.previewBtn = mkBtn(t("pat.preview"), () => this.togglePreview());
    const dupBtn = mkBtn(t("pat.duplicatePattern"), () => this.active.duplicate());
    dupBtn.title = t("pat.duplicateTitle");
    const trBtn = mkBtn(t("pat.transpose"), () => this.active.transpose());
    trBtn.title = t("pat.transposeTitle");
    const lenBtn = mkBtn(t("pat.lengthen"), () => this.active.lengthenOp());
    lenBtn.title = t("pat.lengthenTitle");
    const shortBtn = mkBtn(t("pat.shorten"), () => this.active.shortenOp());
    shortBtn.title = t("pat.shortenTitle");
    const volBtn = mkBtn(t("pat.volume"), () => this.active.volumeOp());
    volBtn.title = t("pat.volumeTitle");
    const panBtn = mkBtn(t("pat.pan"), () => this.active.panOp());
    panBtn.title = t("pat.panTitle");
    const instBtn = mkBtn(t("pat.instrument"), () => this.active.instrumentOp());
    instBtn.title = t("pat.instrumentTitle");
    // Duplicate moves to the very end (item 55): preview, transpose, lengthen,
    // shorten, volume, pan, instrument, then Duplicate pattern.
    this.bar.append(this.previewBtn, trBtn, lenBtn, shortBtn, volBtn, panBtn, instBtn, dupBtn);
    this.syncPreviewBtn();
  }

  togglePreview() {
    const p = this.active.togglePreview();
    return Promise.resolve(p).finally(() => this.syncPreviewBtn());
  }

  syncPreviewBtn() {
    if (!this.previewBtn) return;
    const label = this.active?.previewing ? t("pat.previewStop") : t("pat.preview");
    if (this.previewBtn.textContent !== label) this.previewBtn.textContent = label;
  }

  // ── pane lifecycle + active tracking ──
  defaultPatFor(i) {
    const n = this.store.song?.patterns.length ?? 0;
    return n ? Math.min(i, n - 1) : 0;
  }

  addPane() {
    const pane = new PatternPane(this, this.panes.length);
    pane.patIdx = this.defaultPatFor(this.panes.length);
    this.panesEl.appendChild(pane.el);
    this.panes.push(pane);
    if (this.visible) { pane.refreshHeader(); pane.resize(); }
  }

  removePane() {
    const pane = this.panes.pop();
    if (!pane) return;
    if (pane.previewing) pane.stopPreview();
    pane.el.remove();
  }

  reassertActive() {
    if (this.activeIdx >= this.panes.length) this.activeIdx = this.panes.length - 1;
    if (this.activeIdx < 0) this.activeIdx = 0;
    this.panes.forEach((p, i) => { p.setIndex(i); p.applyActiveClass(i === this.activeIdx); });
    this.syncPreviewBtn();
  }

  setActivePane(pane) {
    const i = this.panes.indexOf(pane);
    if (i >= 0) this.setActiveIdx(i);
  }

  setActiveIdx(i) {
    if (i < 0 || i >= this.panes.length || i === this.activeIdx) return;
    // Preview follows the active column, and stray selections in the column we
    // leave would only confuse — drop both when focus moves.
    for (const p of this.panes) if (p.previewing) p.stopPreview();
    this.panes.forEach((p, idx) => { if (idx !== i) p.clearSelection(); });
    this.activeIdx = i;
    this.panes.forEach((p, idx) => p.applyActiveClass(idx === i));
    this.syncPreviewBtn();
    this.invalidate();
    this.store.emit("cursor"); // palette/status follow the active pane
  }

  /** Column count follows the viewport width (spec: minimum 2). */
  layout() {
    const width = this.panesEl.clientWidth || this.root.clientWidth || 0;
    let want = Math.max(MIN_PANES, Math.floor(width / MIN_PANE_W));
    want = Math.min(want, MAX_PANES);
    while (this.panes.length < want) this.addPane();
    while (this.panes.length > want) this.removePane();
    this.reassertActive();
    for (const p of this.panes) p.resize();
  }

  resetPanes() {
    this.activeIdx = 0;
    this.panes.forEach((p, i) => {
      p.patIdx = this.defaultPatFor(i);
      p.cursor = { row: 0, sub: 0, nib: 0 };
      p.scrollRow = 0;
      p.sel = null;
      p.previewing = false;
      p.previewStarted = false;
    });
    this.reassertActive();
  }

  refreshAllHeaders() { for (const p of this.panes) p.refreshHeader(); }

  /** Tab / Shift+Tab cycles the active column; everything else routes to the
   *  active pane. */
  processKey(e) {
    if (e.code === "Tab") {
      const dir = e.shiftKey ? -1 : 1;
      this.setActiveIdx((this.activeIdx + dir + this.panes.length) % this.panes.length);
      return true;
    }
    return this.active.processKey(e);
  }

  frame() {
    if (!this.visible) return;
    let changed = false;
    for (const p of this.panes) changed = p.frame() || changed;
    if (changed) this.syncPreviewBtn();
  }
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
