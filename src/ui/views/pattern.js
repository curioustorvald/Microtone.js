// Pattern view (F3) — single-pattern editor. A Taud pattern is a per-channel
// entity (64 rows × 8-byte cells); cues place patterns onto channels. This
// view edits one pattern directly (regardless of cue assignments), shows
// which cues use it, and previews it via a device-only scratch cue.
// Reference: taut.js VIEW_PATTERN_DETAILS + PREVIEW_CUE_IDX.

import { PATTERN_EMPTY } from "../../engine/constants.js";
import { hex2, volToStr, panToStr, fxToStr } from "../notenames.js";
import { paintNoteCell } from "../glyphs.js";
import { stepNoteInTable, transposePatternNotes } from "../pitchtables.js";
import {
  interpretEditKey, SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG,
  SUB_POSITIONS, subCharPos, charToSub, CELL_CHARS,
} from "../edit.js";
import { setCellOp, setPatternBytesOp, appendPatternOp, bulkNotesOp } from "../../doc/ops.js";
import { expandPatternBytes, shrinkPatternBytes } from "../../doc/patterntools.js";
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

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export class PatternView {
  constructor(store, host, jam) {
    this.store = store;
    this.jam = jam;
    this.visible = false;
    this.patIdx = 0;
    this.cursor = { row: 0, sub: 0, nib: 0 };
    this.scrollRow = 0;
    this.previewing = false;
    this.previewStarted = false; // set once the worklet confirms playback
    this.needsRedraw = true;

    this.root = document.createElement("div");
    this.root.className = "pattern-view";
    this.bar = document.createElement("div");
    this.bar.className = "files-bar";
    this.patInput = document.createElement("input");
    this.patInput.type = "text";
    this.patInput.className = "pat-input";
    this.patInput.value = "000";
    this.patInput.addEventListener("change", () => {
      this.setPattern(parseInt(this.patInput.value, 16) || 0);
    });
    const prev = mkBtn("◀", () => this.setPattern(this.patIdx - 1));
    const next = mkBtn("▶", () => this.setPattern(this.patIdx + 1));
    this.previewBtn = mkBtn(t("pat.preview"), () => this.togglePreview());
    // pattern-scoped edit operations (all single undo steps)
    const dupBtn = mkBtn(t("pat.duplicate"), () => this.duplicate());
    dupBtn.title = t("pat.duplicateTitle");
    const trBtn = mkBtn(t("pat.transpose"), () => this.transpose());
    trBtn.title = t("pat.transposeTitle");
    const lenBtn = mkBtn(t("pat.lengthen"), () => this.applyPatternBytes(expandPatternBytes));
    lenBtn.title = t("pat.lengthenTitle");
    const shortBtn = mkBtn(t("pat.shorten"), () => this.applyPatternBytes(shrinkPatternBytes));
    shortBtn.title = t("pat.shortenTitle");
    this.info = document.createElement("span");
    this.info.className = "dim";
    this.bar.append(prev, this.patInput, next, this.previewBtn,
      dupBtn, trBtn, lenBtn, shortBtn, this.info);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pattern-canvas";
    this.root.append(this.bar, this.canvas);
    host.appendChild(this.root);
    this.ctx = this.canvas.getContext("2d");

    store.on("doc", () => {
      this.patIdx = 0;
      this.cursor = { row: 0, sub: 0, nib: 0 };
      this.scrollRow = 0;
      if (this.visible) this.refreshBar();
      this.invalidate();
    });
    store.on("edit", () => this.invalidate());

    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (this.store.record && this.wheelEdit(e, d < 0 ? 1 : -1)) return;
      this.scrollRow = clampInt(this.scrollRow + Math.round(d / ROW_H), 0, 48);
      this.invalidate();
    }, { passive: false });

    this.canvas.addEventListener("pointerdown", (e) => {
      const hit = this.hitTest(e);
      if (!hit) return;
      this.cursor = hit;
      this.invalidate();
      this.store.emit("cursor");
    });

    new ResizeObserver(() => { if (this.visible) this.resize(); }).observe(this.root);
  }

  show() { this.visible = true; this.refreshBar(); this.resize(); }
  hide() { this.visible = false; if (this.previewing) this.stopPreview(); }
  invalidate() { this.needsRedraw = true; }

  pattern() { return this.store.song?.patterns[this.patIdx] ?? null; }

  setPattern(idx) {
    const numPats = this.store.song?.patterns.length ?? 0;
    this.patIdx = clampInt(idx, 0, Math.max(numPats - 1, 0));
    this.refreshBar();
    this.invalidate();
  }

  refreshBar() {
    const song = this.store.song;
    if (!song) return;
    // Pattern numbers are 4-digit hex, range 0000..7FFE.
    this.patInput.value = this.patIdx.toString(16).toUpperCase().padStart(4, "0");
    const users = [];
    song.cues.forEach((words, c) => {
      for (let ch = 0; ch < this.store.doc.channelCount; ch++) {
        if ((words[ch] & 0x7fff) === this.patIdx && (words[ch] & 0x7fff) !== CUE_EMPTY) {
          users.push(`${c.toString(16).toUpperCase().padStart(4, "0")}:${ch + 1}`);
          break;
        }
      }
    });
    this.info.textContent =
      ` of ${song.patterns.length.toString(16).toUpperCase().padStart(4, "0")} · used by ` +
      (users.length ? `${users.length} ${users.length === 1 ? "cue" : "cues"}: ${users.slice(0, 8).join(" ")}${users.length > 8 ? "…" : ""}` : "no cue");
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
    this.previewBtn.textContent = t("pat.previewStop");
  }

  stopPreview() {
    this.store.audio?.stop(0);
    this.previewing = false;
    this.previewStarted = false;
    this.previewBtn.textContent = t("pat.preview");
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
    this.refreshBar();
    this.invalidate();
  }

  /** Notation-aware transpose of this pattern. The fine unit follows the
   *  song's tuning — semitones in 12-TET, steps in other TETs, raw note
   *  units in Raw — and the coarse unit is octaves (or periods when the
   *  tuning isn't octave-based, e.g. Bohlen-Pierce tritaves). */
  async transpose() {
    const store = this.store;
    if (!store.doc || !this.pattern()) return;
    const preset = store.pitchPreset;
    const raw = !preset || preset.table.length === 0;
    const fineLabel = raw ? t("pat.unitNoteUnits")
      : preset.index === 120 ? t("pat.unitSemitones") : t("pat.unitSteps");
    const coarseLabel = (preset?.interval ?? 0x1000) === 0x1000
      ? t("pat.unitOctaves") : t("pat.unitPeriods");
    const result = await showModal({
      title: t("pat.transposeModalTitle", { pat: this.patIdx.toString(16).toUpperCase().padStart(4, "0") }),
      body: t("pat.transposeBody"),
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
    store.undo.apply(bulkNotesOp(store.songIndex,
      (song) => transposePatternNotes(song, patIdx, preset, percSlots, fine, coarse)));
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
    this.cursor.row = clampInt(this.cursor.row + dRow, 0, 63);
    const vis = Math.floor(this.canvas.clientHeight / ROW_H);
    if (this.cursor.row < this.scrollRow) this.scrollRow = this.cursor.row;
    else if (this.cursor.row >= this.scrollRow + vis) this.scrollRow = this.cursor.row - vis + 1;
    this.invalidate();
    this.store.emit("cursor");
  }

  moveSubCursor(dir) {
    const c = this.cursor;
    let idx = SUB_POSITIONS.findIndex(([s, n]) => s === c.sub && n === c.nib);
    idx = clampInt(idx + dir, 0, SUB_POSITIONS.length - 1);
    [c.sub, c.nib] = SUB_POSITIONS[idx];
    this.invalidate();
    this.store.emit("cursor");
  }

  /** View-specific keys; true when consumed. Called from the app dispatcher. */
  processKey(e) {
    switch (e.code) {
      case "ArrowUp": this.moveCursor(-1); return true;
      case "ArrowDown": this.moveCursor(1); return true;
      case "ArrowLeft": this.moveSubCursor(-1); return true;
      case "ArrowRight": this.moveSubCursor(1); return true;
      case "PageUp": this.moveCursor(-16); return true;
      case "PageDown": this.moveCursor(16); return true;
      case "Home": this.moveCursor(-64); return true;
      case "End": this.moveCursor(64); return true;
      case "BracketLeft": case "BracketRight": return false; // octave keys: global
    }
    const pattern = this.pattern();
    if (!pattern || !this.store.record) return false;
    const c = this.cursor;
    const cell = pattern[c.row];
    const action = interpretEditKey(
      { code: e.code, key: e.key }, c.sub, c.nib, cell,
      { octave: this.jam.octave, currentInst: this.jam.currentInst, preset: this.store.pitchPreset });
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
    const w = Math.max(200, this.root.clientWidth);
    const h = Math.max(120, this.root.clientHeight - this.bar.offsetHeight - 6);
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

  frame() {
    if (!this.visible) return;
    const audio = this.store.audio;
    if (audio?.isPlaying()) this.needsRedraw = true; // playhead row while previewing
    // Auto-reset the button when the preview ends — but only AFTER we've actually
    // seen it playing. Snapshots lag the play() command by ~16 ms, so checking
    // !isPlaying() too early would kill the preview before it ever started.
    if (this.previewing && audio) {
      if (audio.isPlaying()) this.previewStarted = true;
      else if (this.previewStarted) this.stopPreview();
    }
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

    const vis = Math.floor(H / ROW_H) + 1;
    const x0 = GUTTER_W + 4;
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
      if (row === this.cursor.row) {
        ctx.fillStyle = C.cursor;
        ctx.fillRect(GUTTER_W, y, CELL_CHARS * CHAR_W + 8, ROW_H);
        const [cpos, cw] = subCharPos(this.cursor.sub, this.cursor.nib);
        ctx.fillStyle = store.record ? C.caret : C.cursor;
        ctx.fillRect(x0 + cpos * CHAR_W - 1, y, cw * CHAR_W + 2, ROW_H);
      }
      ctx.fillStyle = row % beats.sec === 0 ? C.accent
        : row % beats.pri === 0 ? C.fg : C.dim;
      ctx.fillText(String(row).padStart(2, "0"), 8, y + ROW_H / 2);

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

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
