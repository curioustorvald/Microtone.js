// Samples view (F4) — deduped sample census (base instruments + Ixmp patches),
// waveform canvas with loop markers and LIVE per-voice play-position blobs
// (snapshot voices whose samplePtr matches). Reference: taut_views.mjs samples
// tab. Read-only in M7 (sample editor modal is an M8 item).

import { hex2 } from "../notenames.js";
import { themeColors } from "../theme.js";
import { unescapeName } from "../names.js";
import { t } from "../i18n.js";

export class SamplesView {
  constructor(store, host) {
    this.store = store;
    this.host = host;
    this.selected = 0;
    this.list = [];
    this.root = document.createElement("div");
    this.root.className = "split-view";
    this.listEl = document.createElement("div");
    this.listEl.className = "side-list";
    this.right = document.createElement("div");
    this.right.className = "side-detail";
    this.info = document.createElement("div");
    this.info.className = "detail-info";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "smp-toolbar";
    this.editBtn = document.createElement("button");
    this.editBtn.textContent = t("smp.edit");
    this.editBtn.title = "Open the sample DSP editor (normalise/fade/reverse — affects every instrument using the sample)";
    this.editBtn.addEventListener("click", async () => {
      const s = this.list?.[this.selected];
      if (!s) return;
      const { openSampleDspEditor } = await import("../popups/sampleeditor.js");
      await openSampleDspEditor(this.store, s);
      this.refresh();
    });
    this.toolbar.appendChild(this.editBtn);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wave-canvas";
    this.right.append(this.info, this.toolbar, this.canvas);
    this.root.append(this.listEl, this.right);
    host.appendChild(this.root);
    this.visible = false;

    store.on("doc", () => { this.selected = 0; if (this.visible) this.refresh(); });
    store.on("edit", (tags) => {
      // bank import/undo changes the census; inst edits move loop points
      if (this.visible && tags?.some?.((t) => t.kind === "bank" || t.kind === "inst")) this.refresh();
    });
    new ResizeObserver(() => { if (this.visible) this.drawWave(); }).observe(this.right);
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  refresh() {
    const doc = this.store.doc;
    this.listEl.innerHTML = "";
    this.rowEls = [];
    if (!doc) return;
    this.list = doc.sampleList();
    this.list.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "side-row" + (i === this.selected ? " sel" : "");
      row.innerHTML =
        `<span class="dot"></span>` +
        `<span class="idx">${String(i).padStart(3, "0")}</span>` +
        `<span class="name">${escape(unescapeName(s.name) || "(unnamed)")}</span>` +
        `<span class="dim">${(s.len / 1024).toFixed(1)}K</span>`;
      row.addEventListener("click", () => { this.selected = i; this.refresh(); });
      this.listEl.appendChild(row);
      this.rowEls.push({ el: row, ptr: s.ptr });
    });
    this.updateInfo();
    this.drawWave();
  }

  /** Light the list rows of samples any voice is sounding right now. */
  updateLiveDots() {
    const audio = this.store.audio;
    if (!audio || !this.rowEls) return;
    const livePtrs = new Set();
    for (let vi = 0; vi < 64; vi++) {
      if (audio.getVoiceActive(vi)) livePtrs.add(audio.getVoiceSamplePtr(vi));
    }
    for (const r of this.rowEls) r.el.classList.toggle("live", livePtrs.has(r.ptr));
  }

  updateInfo() {
    const s = this.list[this.selected];
    if (!s) { this.info.textContent = "no samples"; return; }
    const loopModes = ["no loop", "forward", "ping-pong", "one-shot"];
    this.info.innerHTML =
      `<b>${escape(unescapeName(s.name) || "(unnamed)")}</b> · ptr 0x${s.ptr.toString(16).toUpperCase()} · ` +
      `${s.len} bytes · ${s.rate} Hz@C4 · ${loopModes[s.loopMode & 3]}` +
      `${(s.loopMode & 3) !== 0 ? ` [${s.loopStart}..${s.loopEnd}]` : ""}` +
      `${(s.loopMode & 4) !== 0 ? " · sustain" : ""}` +
      ` · used by ${s.users.map((u) => "$" + hex2(u)).join(" ")}`;
  }

  /** Per-frame: live play cursors + list dots while audio runs. */
  frame() {
    if (!this.visible) return;
    const audio = this.store.audio;
    // Refresh the funk-repeat masks of the shown sample's instruments so the
    // waveform overlay tracks the live S$Fx inversion (reply lands next frame).
    if (audio?.isPlaying()) {
      const s = this.list[this.selected];
      if (s) for (const inst of s.users) audio.requestFunkMask(inst);
    }
    if (audio?.isPlaying() || audio?.snapshot) this.drawWave();
    this.updateLiveDots();
  }

  drawWave() {
    const s = this.list[this.selected];
    const doc = this.store.doc;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, this.right.clientWidth - 20);
    const h = 220;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    const C = themeColors();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    if (!s || !doc?.sampleBin) return;
    const bin = doc.sampleBin;

    // loop region shading
    const hasLoop = (s.loopMode & 3) !== 0 && s.loopEnd > s.loopStart;
    if (hasLoop) {
      ctx.fillStyle = C.waveLoop;
      ctx.fillRect((s.loopStart / s.len) * w, 0, ((s.loopEnd - s.loopStart) / s.len) * w, h);
    }

    // Live funk-repeat (S$Fx) invert-loop overlay: the engine's per-instrument
    // XOR mask flips loop-region bytes by 0xFF and persists like ProTracker's
    // destructive EFx. Bytes it flips are drawn in the funk colour. (taut.js)
    const audio = this.store.audio;
    let funkMask = null;
    if (hasLoop && audio) {
      for (const inst of s.users) {
        const m = audio.getFunkMask(inst);
        if (m && m.length) { funkMask = m; break; }
      }
    }
    const funkEnd = funkMask ? Math.min(s.loopEnd, s.loopStart + funkMask.length * 8) : 0;
    const byteAt = (p) => {
      let v = bin[s.ptr + p];
      let flipped = false;
      if (funkMask && p >= s.loopStart && p < funkEnd) {
        const k = p - s.loopStart;
        if ((funkMask[k >>> 3] >>> (k & 7)) & 1) { v ^= 0xff; flipped = true; }
      }
      return { v, flipped };
    };

    // Bars anchored to the centre line (taut style): value 128 sits at the
    // middle, each bar filled from the baseline out to its sample value.
    const baseY = h / 2;
    const yOf = (v) => (h * (255 - v)) / 255;
    ctx.fillStyle = C.waveMid ?? C.dim;
    ctx.fillRect(0, Math.round(baseY), w, 1);

    if (s.len <= w) {
      const rectW = Math.max(1, Math.ceil(w / s.len));
      for (let i = 0; i < s.len; i++) {
        const { v, flipped } = byteAt(i);
        const yv = yOf(v);
        const top = Math.min(baseY, yv);
        ctx.fillStyle = flipped ? C.waveFunk : C.wave;
        ctx.fillRect(Math.floor((i * w) / s.len), top, rectW, Math.max(1, Math.abs(baseY - yv)));
      }
    } else {
      for (let col = 0; col < w; col++) {
        const start = Math.floor((col * s.len) / w);
        const end = Math.min(s.len, Math.floor(((col + 1) * s.len) / w));
        if (end <= start) continue;
        const step = Math.max(1, ((end - start) / 8) | 0);
        let mn = 255, mx = 0, anyFlip = false;
        for (let p = start; p < end; p += step) {
          const { v, flipped } = byteAt(p);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          if (flipped) anyFlip = true;
        }
        const yTop = Math.min(baseY, yOf(mx));
        const yBot = Math.max(baseY, yOf(mn));
        ctx.fillStyle = anyFlip ? C.waveFunk : C.wave;
        ctx.fillRect(col, yTop, 1, Math.max(1, yBot - yTop + 1));
      }
    }

    // live play-position cursors — vertical bars, matching the envelope
    // graph's playback cursor style
    if (audio) {
      ctx.fillStyle = C.playCursor;
      for (let vi = 0; vi < 64; vi++) {
        if (!audio.getVoiceActive(vi)) continue;
        if (audio.getVoiceSamplePtr(vi) !== s.ptr) continue;
        const pos = audio.getVoiceSamplePos(vi);
        if (pos < 0 || pos > s.len) continue;
        const x = (pos / s.len) * w;
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }
  }
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
