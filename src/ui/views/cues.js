// Cues view (F2) — the order list: cue rows × channel columns of pattern
// numbers, plus the two per-cue instruction words (Cmd1/Cmd2 — BAK/FWD/JMP/
// LEN/HALT, encoded in the sign bits of ch 0-15 / 16-31). Edits are eager-
// synced to the worklet (DocSync). Feature reference: taut.js VIEW_CUES.

import { CUE_EMPTY } from "../../format/taud-const.js";
import { cueInstructionWords } from "../../format/taud-parse.js";
import { cueInfo } from "../../doc/document.js";
import { INST_NOP, INST_GOBACK, INST_SKIP, INST_JUMP, INST_PATLEN, INST_HALTAT, INST_HALT } from "../../engine/state.js";
import { setCueWordOp, setCueOp } from "../../doc/ops.js";
import { showModal } from "../widgets/modal.js";
import { themeColors } from "../theme.js";

const FONT = "12px ui-monospace, 'Cascadia Mono', 'DejaVu Sans Mono', monospace";
const CHAR_W = 7.3;
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
    this.needsRedraw = true;

    store.on("doc", () => { this.cursor = { cue: 0, col: 0, nib: 0 }; this.scrollCue = 0; this.invalidate(); });
    store.on("edit", () => this.invalidate());

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Shift+wheel reports its delta in deltaX on most platforms.
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (e.shiftKey) this.scrollCh = Math.max(0, this.scrollCh + Math.sign(d) * 2);
      else this.scrollCue = Math.max(0, this.scrollCue + Math.sign(d) * 3);
      this.invalidate();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => this.onPointer(e));
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

  onPointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < HEADER_H) return;
    const cue = this.scrollCue + Math.floor((y - HEADER_H) / ROW_H);
    if (cue >= this.numCues()) return;
    let col;
    if (x < GUTTER_W + CMD_W) col = 0;
    else if (x < GUTTER_W + 2 * CMD_W) col = 1;
    else col = 2 + this.scrollCh + Math.floor((x - GUTTER_W - 2 * CMD_W) / COL_W);
    this.cursor = { cue, col, nib: 0 };
    this.invalidate();
  }

  moveCursor(dRow, dCol) {
    const chans = this.store.doc.channelCount;
    const c = this.cursor;
    c.cue = Math.min(Math.max(c.cue + dRow, 0), this.numCues() - 1);
    c.col = Math.min(Math.max(c.col + dCol, 0), chans + 1);
    if (dCol !== 0) c.nib = 0;
    // keep visible
    const vis = this.visibleRows();
    if (c.cue < this.scrollCue) this.scrollCue = c.cue;
    else if (c.cue >= this.scrollCue + vis) this.scrollCue = c.cue - vis + 1;
    this.invalidate();
  }

  /** Cue-view key handling. Returns true when consumed. */
  processKey(e) {
    const store = this.store;
    const c = this.cursor;
    switch (e.code) {
      case "ArrowUp": this.moveCursor(-1, 0); return true;
      case "ArrowDown": this.moveCursor(1, 0); return true;
      case "ArrowLeft": this.moveCursor(0, -1); return true;
      case "ArrowRight": this.moveCursor(0, 1); return true;
      case "PageUp": this.moveCursor(-16, 0); return true;
      case "PageDown": this.moveCursor(16, 0); return true;
      case "Enter": this.openCmdEditor(); return true;
    }
    if (!store.record || c.col < 2) return false;
    const ch = c.col - 2;
    const words = store.song.cues[c.cue];
    if (e.code === "Delete" || e.code === "Period") {
      store.undo.apply(setCueWordOp(store.songIndex, c.cue, ch,
        (words[ch] & 0x8000) | 0x7fff));
      this.moveCursor(1, 0);
      return true;
    }
    const d = parseInt(e.key, 16);
    if (Number.isNaN(d) || e.key.length !== 1) return false;
    // 4-nibble pattern entry (0000..7FFE; the top nibble masks to 15 bits).
    // An empty slot starts from 0.
    const sign = words[ch] & 0x8000;
    let pat = words[ch] & 0x7fff;
    if (pat === CUE_EMPTY) pat = 0;
    const shift = (3 - c.nib) * 4;
    pat = (pat & ~(0xf << shift)) | (d << shift);
    store.undo.apply(setCueWordOp(store.songIndex, c.cue, ch, sign | (pat & 0x7fff)));
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
    const info = cueInfo(store.song.cues[c.cue]);
    const current = word === 0 ? info.inst0 : info.inst1;
    const result = await showModal({
      title: `Cue ${c.cue.toString(16).toUpperCase().padStart(4, "0")} — command word ${word + 1}`,
      body: "LEN/HALT@ take rows (1-64); BAK/FWD/JMP take a cue count/index.",
      fields: [
        { name: "kind", label: "Command", type: "select", value: kindOf(current), options: [
          { value: "nop", label: "(none)" },
          { value: "len", label: "LEN — pattern length" },
          { value: "halt", label: "HALT — stop after pattern" },
          { value: "haltAt", label: "HALT@ — stop after N rows" },
          { value: "bak", label: "BAK — go back N cues" },
          { value: "fwd", label: "FWD — skip N cues" },
          { value: "jmp", label: "JMP — jump to cue" },
        ]},
        { name: "arg", label: "Argument", type: "number", value: current.arg || 0, min: 0, max: 4095 },
      ],
    });
    if (!result) return;
    const newWord = encodeInstWord(result.kind, parseInt(result.arg || "0", 10));
    // Repack: sign bits of ch 0-15 = word0, ch 16-31 = word1.
    const words = Uint16Array.from(store.song.cues[c.cue]);
    const [w0, w1] = cueInstructionWords(words);
    const w = word === 0 ? newWord : w0;
    const w2 = word === 1 ? newWord : w1;
    for (let ch = 0; ch < 16; ch++) {
      words[ch] = (words[ch] & 0x7fff) | (((w >> ch) & 1) << 15);
      words[16 + ch] = (words[16 + ch] & 0x7fff) | (((w2 >> ch) & 1) << 15);
    }
    store.undo.apply(setCueOp(store.songIndex, c.cue, words));
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
    ctx.font = FONT;
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
    const vis = this.visibleRows() + 1;
    for (let r = 0; r < vis; r++) {
      const cueIdx = this.scrollCue + r;
      if (cueIdx >= song.cues.length) break;
      const y = HEADER_H + r * ROW_H;
      const words = song.cues[cueIdx];
      const info = cueInfo(words);

      if (cueIdx === playCue) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(0, y, W, ROW_H);
      } else if (cueIdx % 4 === 0) {
        ctx.fillStyle = C.panel;
        ctx.fillRect(0, y, W, ROW_H);
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
        const pat = words[ch] & 0x7fff;
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
