// Samples view (F4) — deduped sample census (base instruments + Ixmp patches),
// waveform canvas with loop markers and LIVE per-voice play-position blobs
// (snapshot voices whose samplePtr matches). Reference: taut_views.mjs samples
// tab. The toolbar's editors: "Edit…" opens the Sample Lab (item 109 — one
// editor, which both replaces the sample in place and imports as new),
// "Paint…" redraws its waveform by hand, "Chord…" is the Lab with the chord
// maker on top.

import { hex2 } from "../notenames.js";
import { themeColors } from "../theme.js";
import { unescapeName } from "../names.js";
import { sampleSpans, isStereoSample } from "../../doc/document.js";
import { encodeU8Wav } from "../../audio/wavwrite.js";
import { download } from "../../storage/import-export.js";
import { sanitiseName } from "../../audio/stem-export.js";
import { t } from "../i18n.js";

/** Waveform canvas height PER CHANNEL (px). */
const WAVE_LANE_H = 220;

export class SamplesView {
  constructor(store, host, callbacks = {}) {
    this.store = store;
    this.host = host;
    this.cb = callbacks;
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
    // "Edit…" is the ONE sample editor (item 109): the Sample Lab, opened on a
    // float copy of the selected sample. It commits either way — Replace writes
    // the edit back over these pool bytes (every instrument using them follows),
    // or Import as new mints fresh samples and instruments and leaves the
    // original alone.
    this.editBtn = document.createElement("button");
    this.editBtn.textContent = t("smp.edit");
    this.editBtn.title = t("smp.editTitle");
    this.editBtn.addEventListener("click", () => this.openInLab());
    // Create a fresh instrument that plays the selected pooled sample (item 40).
    this.newInstBtn = document.createElement("button");
    this.newInstBtn.textContent = t("smp.newInst");
    this.newInstBtn.title = t("smp.newInstBtnTitle");
    this.newInstBtn.addEventListener("click", async () => {
      const s = this.list?.[this.selected];
      if (!s) return;
      const { newInstrumentFromSample } = await import("../popups/importsample.js");
      const res = await newInstrumentFromSample(this.store, s);
      if (res) this.cb.onNewInstrument?.(res.firstSlot);
    });
    // "Paint…" is a second editor for the SELECTED pooled sample — repaint its
    // waveform in place (affects every instrument using it). Sits next to Edit….
    this.paintBtn = document.createElement("button");
    this.paintBtn.textContent = t("smp.paint");
    this.paintBtn.title = t("smp.paintTitle");
    this.paintBtn.addEventListener("click", async () => {
      const s = this.list?.[this.selected];
      if (!s) return;
      const { paintEditSample } = await import("../popups/waveformpaint.js");
      await paintEditSample(this.store, s);
      this.refresh(); // repaint the waveform view
    });
    // "Chord…" (item 89) is the same trip into the Lab with the chord maker
    // opened on arrival: mix pitch-shifted copies of the sample into one
    // chorded sample, the Amiga trick. The Lab then names/auditions/commits it.
    this.chordBtn = document.createElement("button");
    this.chordBtn.textContent = t("smp.chord");
    this.chordBtn.title = t("smp.chordTitle");
    this.chordBtn.addEventListener("click", () => this.openInLab(true));
    // "Export" downloads the selected pooled sample as a WAV file — its
    // current committed bytes, 8-bit PCM straight out of the pool (bit-exact,
    // no requantisation).
    this.exportBtn = document.createElement("button");
    this.exportBtn.textContent = t("smp.export");
    this.exportBtn.title = t("smp.exportTitle");
    this.exportBtn.addEventListener("click", () => this.exportSample());
    this.toolbar.append(this.editBtn, this.paintBtn, this.chordBtn, this.exportBtn, this.newInstBtn);
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

  /** Open a float copy of the selected sample in the Sample Lab; `openChord`
   *  opens the chord maker on top of it. `replaceTarget` is what lets the Lab
   *  write the edit BACK over these pool bytes (item 109) — the alternative
   *  commit, importing the result as new instruments, leaves them untouched. */
  async openInLab(openChord = false) {
    const s = this.list?.[this.selected];
    if (!s) return;
    const [{ openSampleLab }, { u8ToFloat }] = await Promise.all([
      import("../popups/samplelab.js"), import("../../doc/wavelab.js"),
    ]);
    // Every channel travels: a stereo pooled sample opens as a stereo take.
    const chans = sampleSpans(s).map((sp) =>
      u8ToFloat(this.store.doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len)));
    const res = await openSampleLab(this.store, {
      data: chans,
      rate: s.rate,
      name: unescapeName(s.name) || `sample ${s.index}`,
      sourceLabel: t("smp.labSource", { idx: s.index }),
      openChord,
      replaceTarget: s,
    });
    if (res?.firstSlot !== undefined) this.cb.onNewInstrument?.(res.firstSlot);
    else if (res?.replaced) this.refresh();
  }

  exportSample() {
    const s = this.list?.[this.selected];
    const doc = this.store.doc;
    if (!s || !doc?.sampleBin) return;
    const chans = sampleSpans(s).map((sp) => doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len));
    const bytes = encodeU8Wav(chans, s.rate);
    download(bytes, `${sanitiseName(s.name, `sample_${String(s.index).padStart(3, "0")}`)}.wav`);
  }

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
        (isStereoSample(s) ? `<span class="smp-tag">${escape(t("smp.stereoTag"))}</span>` : "") +
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
    if (!s) { this.info.textContent = t("smp.noSamples"); return; }
    const loopModes = [t("smp.noLoop"), t("smp.loopForward"), t("smp.loopPingpong"), t("smp.loopOneshot")];
    this.info.innerHTML =
      `<b>${escape(unescapeName(s.name) || escape(t("smp.namePlaceholder")))}</b> · ptr 0x${s.ptr.toString(16).toUpperCase()} · ` +
      `${escape(t("smp.infoBytes", { n: s.len }))}${isStereoSample(s) ? " ×2" : ""} · ` +
      `${escape(t(isStereoSample(s) ? "smp.stereo" : "smp.mono"))} · ` +
      `${s.rate} Hz@C4 · ${escape(loopModes[s.loopMode & 3])}` +
      `${(s.loopMode & 3) !== 0 ? ` [${s.loopStart}..${s.loopEnd}]` : ""}` +
      `${(s.loopMode & 4) !== 0 ? ` · ${escape(t("smp.infoSustain"))}` : ""}` +
      ` · ${escape(t("smp.infoUsedBy", { list: s.users.map((u) => "$" + hex2(u)).join(" ") }))}`;
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
    // One FULL lane per channel: a stereo sample gets a canvas twice as tall
    // rather than two half-height lanes — the view has the room, and squeezing
    // them would cost exactly the amplitude detail the display is for.
    const h = WAVE_LANE_H * (s ? sampleSpans(s).length : 1);
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
    const byteAt = (p, base = s.ptr) => {
      let v = bin[base + p];
      let flipped = false;
      if (funkMask && p >= s.loopStart && p < funkEnd) {
        const k = p - s.loopStart;
        if ((funkMask[k >>> 3] >>> (k & 7)) & 1) { v ^= 0xff; flipped = true; }
      }
      return { v, flipped };
    };

    // Bars anchored to the centre line (taut style): value 128 sits at the
    // middle, each bar filled from the baseline out to its sample value. A
    // stereo sample (item 90) draws one lane per channel, stacked, sharing the
    // loop shading and the play cursors — it is one sample, seen twice.
    const spans = sampleSpans(s);
    const laneH = h / spans.length;
    spans.forEach((span, li) => {
      const top0 = li * laneH;
      const baseY = top0 + laneH / 2;
      const yOf = (v) => top0 + (laneH * (255 - v)) / 255;
      ctx.fillStyle = C.waveMid ?? C.dim;
      ctx.fillRect(0, Math.round(baseY), w, 1);
      const at = (i) => byteAt(i, span.ptr);

      if (s.len <= w) {
        const rectW = Math.max(1, Math.ceil(w / s.len));
        for (let i = 0; i < s.len; i++) {
          const { v, flipped } = at(i);
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
            const { v, flipped } = at(p);
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
      if (spans.length > 1) {
        ctx.fillStyle = C.fg2 ?? C.fg;
        ctx.globalAlpha = 0.85;
        ctx.font = "10px sans-serif";
        ctx.fillText(t(li === 0 ? "lab.chanL" : "lab.chanR"), 3, top0 + 11);
        ctx.globalAlpha = 1;
        if (li > 0) {
          ctx.fillStyle = C.dim;
          ctx.globalAlpha = 0.6;
          ctx.fillRect(0, Math.round(top0), w, 1);
          ctx.globalAlpha = 1;
        }
      }
    });

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
