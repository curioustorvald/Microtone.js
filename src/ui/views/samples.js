// Samples view (F4) — deduped sample census (base instruments + Ixmp patches),
// waveform canvas with loop markers and LIVE per-voice play-position blobs
// (snapshot voices whose samplePtr matches). Reference: taut_views.mjs samples
// tab. Read-only in M7 (sample editor modal is an M8 item).

import { hex2 } from "../notenames.js";

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
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wave-canvas";
    this.right.append(this.info, this.canvas);
    this.root.append(this.listEl, this.right);
    host.appendChild(this.root);
    this.visible = false;

    store.on("doc", () => { this.selected = 0; if (this.visible) this.refresh(); });
    new ResizeObserver(() => { if (this.visible) this.drawWave(); }).observe(this.right);
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  refresh() {
    const doc = this.store.doc;
    this.listEl.innerHTML = "";
    if (!doc) return;
    this.list = doc.sampleList();
    this.list.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "side-row" + (i === this.selected ? " sel" : "");
      row.innerHTML =
        `<span class="idx">${String(i).padStart(3, "0")}</span>` +
        `<span class="name">${escape(s.name || "(unnamed)")}</span>` +
        `<span class="dim">${(s.len / 1024).toFixed(1)}K</span>`;
      row.addEventListener("click", () => { this.selected = i; this.refresh(); });
      this.listEl.appendChild(row);
    });
    this.updateInfo();
    this.drawWave();
  }

  updateInfo() {
    const s = this.list[this.selected];
    if (!s) { this.info.textContent = "no samples"; return; }
    const loopModes = ["no loop", "forward", "ping-pong", "one-shot"];
    this.info.innerHTML =
      `<b>${escape(s.name || "(unnamed)")}</b> · ptr 0x${s.ptr.toString(16).toUpperCase()} · ` +
      `${s.len} bytes · ${s.rate} Hz@C4 · ${loopModes[s.loopMode & 3]}` +
      `${(s.loopMode & 3) !== 0 ? ` [${s.loopStart}..${s.loopEnd}]` : ""}` +
      `${(s.loopMode & 4) !== 0 ? " · sustain" : ""}` +
      ` · used by ${s.users.map((u) => "$" + hex2(u)).join(" ")}`;
  }

  /** Per-frame: live play blobs only need repaint while audio runs. */
  frame() {
    if (!this.visible) return;
    if (this.store.audio?.isPlaying() || this.store.audio?.snapshot) this.drawWave();
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
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1f232b";
    ctx.fillRect(0, 0, w, h);
    if (!s || !doc?.sampleBin) return;
    const bin = doc.sampleBin;

    // loop region shading
    if ((s.loopMode & 3) !== 0 && s.loopEnd > s.loopStart) {
      ctx.fillStyle = "#26314a";
      ctx.fillRect((s.loopStart / s.len) * w, 0, ((s.loopEnd - s.loopStart) / s.len) * w, h);
    }

    // min/max column waveform
    ctx.strokeStyle = "#43d675";
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const a = s.ptr + Math.floor((x / w) * s.len);
      const b = s.ptr + Math.max(a - s.ptr + 1, Math.floor(((x + 1) / w) * s.len));
      let mn = 255, mx = 0;
      for (let i = a; i < b && i < s.ptr + s.len; i++) {
        const v = bin[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const y0 = h - (mx / 255) * h;
      const y1 = h - (mn / 255) * h;
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, Math.max(y1, y0 + 1));
    }
    ctx.stroke();

    // live play-position blobs
    const audio = this.store.audio;
    if (audio) {
      ctx.fillStyle = "#f5a623";
      for (let vi = 0; vi < 64; vi++) {
        if (!audio.getVoiceActive(vi)) continue;
        if (audio.getVoiceSamplePtr(vi) !== s.ptr) continue;
        const pos = audio.getVoiceSamplePos(vi);
        if (pos < 0 || pos > s.len) continue;
        const x = (pos / s.len) * w;
        ctx.beginPath();
        ctx.arc(x, h / 2, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
