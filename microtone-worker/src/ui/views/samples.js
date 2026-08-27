// Samples view (F4) — deduped sample census (base instruments + Ixmp patches),
// waveform canvas with loop markers and LIVE per-voice play-position blobs
// (snapshot voices whose samplePtr matches). Reference: taut_views.mjs samples
// tab. The toolbar's editors: "Edit…" opens the Sample Lab (item 109 — one
// editor, which both replaces the sample in place and imports as new),
// "Paint…" redraws its waveform by hand, "Chord…" is the Lab with the chord
// maker on top. "Duplicate" and "Delete" (item 151) are the pool-level pair:
// one copies the bytes into a new sample + instrument, the other frees them and
// leaves every instrument bound to them dangling.

import { hex2 } from "../notenames.js";
import { themeColors } from "../theme.js";
import { unescapeName, escapeNonAscii } from "../names.js";
import { sampleSpans, isStereoSample } from "../../doc/document.js";
import { TOTAL_VOICES } from "../../engine/constants.js";
import {
  ModGeom, resolveModGeom, modTouches, modAddress,
} from "../../engine/samplemod.js";
import { encodeU8Wav } from "../../audio/wavwrite.js";
import { download } from "../../storage/import-export.js";
import { sanitiseName } from "../../audio/stem-export.js";
import { planDuplicateSample, duplicateInstrumentName } from "../../doc/bankmerge.js";
import { planDeleteSample } from "../../doc/cleanup.js";
import { importBankOp, cleanupBankOp } from "../../doc/ops.js";
import { showModal } from "../widgets/modal.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";
import { PoolPanel } from "./poolpanel.js";

/** The memory panel is off by default and remembered per browser. */
const POOL_PREF_KEY = "microtone-poolpanel";
function loadPoolPref() {
  try { return localStorage.getItem(POOL_PREF_KEY) === "1"; } catch { return false; }
}
function savePoolPref(v) {
  try { localStorage.setItem(POOL_PREF_KEY, v ? "1" : "0"); } catch { /* private mode */ }
}

/** Waveform canvas height PER CHANNEL (px). */
const WAVE_LANE_H = 220;

/** An instrument slot as the rest of the app spells it: $01–$FF in two digits,
 *  a $100+ layer child in three (a sample's users are often layer children). */
const instLabel = (slot) => "$" + (slot > 0xff ? slot.toString(16).toUpperCase().padStart(3, "0") : hex2(slot));

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
    // Live funk-repeat state (item 164) — its own line so the static one above
    // is not rebuilt sixty times a second.
    this.funkInfo = document.createElement("div");
    this.funkInfo.className = "detail-info funk-info";
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
    setIconLabel(this.exportBtn, "download", t("smp.export"), { after: true });
    this.exportBtn.title = t("smp.exportTitle");
    this.exportBtn.addEventListener("click", () => this.exportSample());
    // "Duplicate" (item 151) copies the bytes — the copy is a sample of its own,
    // so editing it can never reach the music written with the original. (New
    // instrument, next to it, is the version that SHARES the bytes.)
    this.dupBtn = document.createElement("button");
    this.dupBtn.textContent = t("smp.duplicate");
    this.dupBtn.title = t("smp.duplicateTitle");
    this.dupBtn.addEventListener("click", () => this.duplicateSample());
    // "Delete" frees the pool bytes. Every instrument bound to the sample is
    // named in the confirm dialog: they keep their slot and lose their sample.
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.textContent = t("smp.delete");
    this.deleteBtn.title = t("smp.deleteTitle");
    this.deleteBtn.addEventListener("click", () => this.deleteSample());
    // "Memory" (item 166) toggles the pool map under the waveform: the list is
    // a CENSUS of (ptr:len) claims and says nothing about where the bytes are,
    // and this is the view that does. Off by default and remembered.
    this.poolBtn = document.createElement("button");
    this.poolBtn.className = "smp-pool";
    this.poolBtn.textContent = t("pool.toggle");
    this.poolBtn.title = t("pool.toggleTitle");
    this.poolBtn.addEventListener("click", () => this.togglePool());
    this.toolbar.append(this.editBtn, this.paintBtn, this.chordBtn, this.dupBtn,
      this.exportBtn, this.newInstBtn, this.deleteBtn, this.poolBtn);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wave-canvas";
    this.pool = new PoolPanel(store, {
      onSelect: (idx) => {
        if (idx === this.selected || idx < 0 || idx >= this.list.length) return;
        this.selected = idx;
        this.refresh();
        this.rowEls?.[idx]?.el.scrollIntoView({ block: "nearest" });
      },
    });
    this.poolOpen = loadPoolPref();
    this.pool.element.hidden = !this.poolOpen;
    this.poolBtn.classList.toggle("on", this.poolOpen);
    this.right.append(this.info, this.funkInfo, this.toolbar, this.canvas, this.pool.element);
    this.root.append(this.listEl, this.right);
    host.appendChild(this.root);
    this.visible = false;

    store.on("doc", () => { this.selected = 0; if (this.visible) this.refresh(); });
    store.on("edit", (tags) => {
      // bank import/undo changes the census; inst edits move loop points
      if (this.visible && tags?.some?.((t) => t.kind === "bank" || t.kind === "inst")) this.refresh();
    });
    new ResizeObserver(() => {
      if (!this.visible) return;
      this.drawWave();
      if (this.poolOpen) this.pool.draw();
    }).observe(this.right);
  }

  /** Show/hide the sample-memory panel, and remember the choice. */
  togglePool() {
    this.poolOpen = !this.poolOpen;
    savePoolPref(this.poolOpen);
    this.poolBtn.classList.toggle("on", this.poolOpen);
    this.pool.element.hidden = !this.poolOpen;
    if (!this.poolOpen) return;
    this.pool.refresh(this.selected);
    // Opened from a toolbar at the top of a pane whose waveform can be two
    // lanes tall, so bring the thing that just appeared into view.
    this.pool.element.scrollIntoView({ block: "nearest" });
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

  /** Copy the selected sample's bytes into a fresh pool span plus an instrument
   *  that plays them (item 151). The name defaults to "<name> (2)" — the same
   *  numbering a duplicated instrument gets — and the new sample is selected. */
  async duplicateSample() {
    const s = this.list?.[this.selected];
    const doc = this.store.doc;
    if (!s || !doc) return;
    const base = unescapeName(s.name) || `sample ${s.index}`;
    const takenNames = new Set(this.list.map((e) => unescapeName(e.name)));
    const suggested = duplicateInstrumentName(takenNames, base) || base;
    const res = await showModal({
      title: t("smp.dupTitle", { name: base }),
      body: t("smp.dupBody", { bytes: s.len * sampleSpans(s).length }),
      fields: [{ name: "name", label: t("inst.sampleImportName"), value: suggested }],
      okLabel: t("common.create"),
    });
    if (!res) return;
    const nameBytes = new TextEncoder().encode(escapeNonAscii(res.name || suggested));
    const plan = planDuplicateSample(doc, s, nameBytes);
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(importBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
    // Land on the copy: the census is pool-ordered, so find it by its pointer.
    // The view stays put — this duplicated a SAMPLE, and the instrument minted
    // to carry it is a means to that; "New instrument" is the button that means
    // to go and edit one.
    const at = this.list.findIndex((e) => e.ptr === plan.duplicate.ptr);
    if (at >= 0) { this.selected = at; this.refresh(); }
  }

  /** Free the selected sample's pool bytes (item 151). Everything bound to it is
   *  named first: base records are left DANGLING (slot and notes survive, the
   *  sample does not) and Ixmp patches bound to it are dropped. */
  async deleteSample() {
    const s = this.list?.[this.selected];
    const doc = this.store.doc;
    if (!s || !doc) return;
    const plan = planDeleteSample(doc, s);
    if (plan.error) { alert(plan.error); return; }
    const bodyParts = [];
    if (plan.clearedInsts.length > 0) {
      bodyParts.push(t("smp.delBodyDangling", {
        n: plan.clearedInsts.length,
        list: plan.clearedInsts.map(instLabel).join(", "),
      }));
    }
    if (plan.removedPatches > 0) {
      bodyParts.push(t("smp.delBodyPatches", {
        n: plan.removedPatches, insts: plan.patchedInsts.length, blobs: plan.removedBlobs,
      }));
    }
    bodyParts.push(t("smp.delBodyFrees", { kb: (plan.freedSampleBytes / 1024).toFixed(1) }));
    const res = await showModal({
      title: t("smp.delTitle", { name: unescapeName(s.name) || `sample ${s.index}`, idx: s.index }),
      body: bodyParts.join(" "),
      okLabel: t("smp.delOk"),
    });
    if (!res) return;
    this.store.undo.apply(cleanupBankOp(plan));
    this.store.emit("edit", [{ kind: "bank" }]);
    this.selected = Math.max(0, Math.min(this.selected, doc.sampleList().length - 1));
    this.refresh();
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
    if (this.poolOpen) this.pool.refresh(this.selected);
  }

  /** Light the list rows of samples any voice is sounding right now. */
  updateLiveDots() {
    const audio = this.store.audio;
    if (!audio || !this.rowEls) return;
    const livePtrs = new Set();
    for (let vi = 0; vi < TOTAL_VOICES; vi++) {
      if (audio.getVoiceActive(vi)) livePtrs.add(audio.getVoiceSamplePtr(vi));
    }
    for (const r of this.rowEls) r.el.classList.toggle("live", livePtrs.has(r.ptr));
  }

  /**
   * Per-frame line under the sample's own: what funk repeat is doing to it
   * right now. The band on the canvas says WHERE; this says how far along the
   * sweep that is, and where the next hop lands — the two numbers you cannot
   * read off a 30-pixel block.
   */
  updateFunkReadout() {
    const s = this.list[this.selected];
    const fws = s ? collectFunkWindows(this.store.audio, s) : [];
    if (!fws.length) {
      if (this.funkInfo.textContent !== "") this.funkInfo.textContent = "";
      return;
    }
    const fw = fws[0];
    const home = (s.loopMode & 3) !== 0 ? s.loopStart : 0;
    // The walk's grid is the HOP's, not the window's (item 163): a half- or
    // eighth-block walk visits four or eight times as many positions over the
    // same sample, and counting them in loop lengths would say "step 3 of 7"
    // while the band was plainly somewhere else.
    const hop = funkHopSize(fw);
    const blocks = Math.max(1, Math.floor((s.len - fw.len - home) / hop) + 1);
    const at = Math.min(Math.max(Math.round((fw.window - home) / hop), 0), blocks - 1) + 1;
    // The pending hop is only worth a clause while it differs from the window:
    // right after a restart latches it the two are equal, and printing the same
    // number twice reads as a bug rather than as "it has just landed".
    const next = fw.pending >= 0 && fw.pending !== fw.window
      ? t("smp.funkReadoutNext", { next: fw.pending }) : "";
    this.funkInfo.textContent =
      t("smp.funkReadout", { f: funkSpelling(fw), at: fw.window, k: at, n: blocks }) + next;
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
      ` · ${escape(t("smp.infoUsedBy", { list: s.users.map(instLabel).join(" ") }))}`;
  }

  /** Per-frame: live play cursors + list dots while audio runs. */
  frame() {
    if (!this.visible) return;
    const audio = this.store.audio;
    // Refresh the invert-loop masks of the shown sample's instruments so the
    // waveform overlay tracks the live S$Fx inversion (reply lands next frame).
    if (audio?.isPlaying()) {
      const s = this.list[this.selected];
      if (s) for (const inst of s.users) audio.requestInvertMask(inst);
    }
    if (audio?.isPlaying() || audio?.snapshot) this.drawWave();
    this.updateFunkReadout();
    this.updateLiveDots();
    // Only the tick layer — the map itself is arithmetic over the census and
    // has no business being repainted sixty times a second.
    if (this.poolOpen && (audio?.isPlaying() || audio?.snapshot)) this.pool.drawLive();
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

    // Funk repeat (Z $F0xx, item 161) — where the loop has been walked TO.
    // The shading above is the loop the sample declares; this is the window the
    // voice is actually sounding, which the walk hops through the sample a whole
    // loop length at a time. Two marks per sounding voice: a filled band for the
    // window under the playhead, and an outline one block on for where the next
    // loop restart will jump. Identical windows are drawn once, so two voices
    // sitting on the same block do not stack into a brighter band.
    const funkWindows = collectFunkWindows(this.store.audio, s);
    if (funkWindows.length) {
      const xOf = (byte) => (byte / s.len) * w;
      for (const fw of funkWindows) {
        ctx.fillStyle = C.waveFunk;
        ctx.globalAlpha = 0.28;
        ctx.fillRect(xOf(fw.window), 0, Math.max(1, xOf(fw.len)), h);
        ctx.globalAlpha = 1;
        if (fw.pending >= 0 && fw.pending !== fw.window) {
          // Where the NEXT loop restart will jump to: a faint block plus a
          // dashed line on its leading edge. An outlined rectangle was tried
          // and reads as noise once the trace is drawn over the middle of it.
          ctx.fillStyle = C.waveFunk;
          ctx.globalAlpha = 0.10;
          ctx.fillRect(xOf(fw.pending), 0, Math.max(1, xOf(fw.len)), h);
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = C.waveFunk;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(Math.round(xOf(fw.pending)) + 0.5, 0);
          ctx.lineTo(Math.round(xOf(fw.pending)) + 0.5, h);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        // Name the band where there is room for it — a teal block over a
        // waveform means nothing on its own, and the effect code is the one
        // caption that needs no translating.
        if (xOf(fw.len) >= 46) {
          ctx.fillStyle = C.waveFunk;
          ctx.globalAlpha = 0.9;
          ctx.font = "10px sans-serif";
          ctx.fillText(`Z ${funkSpelling(fw)}xx`, xOf(fw.window) + 4, h - 4);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Live sample-modification overlay: the invert loop's per-instrument XOR
    // mask (S$Fx, and notefx 2/3's INVERT operation) flips bytes by 0xFF and
    // persists like ProTracker's destructive EFx; notefx 2/3 can also rotate a
    // region's bytes, scatter them one by one, or slide their level. Everything
    // the modifications touch — inverted, moved or shifted — is drawn in the
    // invert colour. (taut.js)
    const audio = this.store.audio;
    let invertMask = null;
    let mod = null;
    let modMask = null;
    if (audio) {
      for (const inst of s.users) {
        const m = audio.getInvertMask(inst);
        if (m && m.length) { invertMask = m; break; }
      }
      for (const inst of s.users) {
        const g = audio.getSampleMod(inst);
        if (g && g.modOn) { mod = g; modMask = audio.getModMask(inst); break; }
      }
    }
    // The region is a FRACTION of the sample's loop region (item 153), resolved
    // here through the engine's own geometry — the snapshot carries the
    // instrument's field names precisely so this cannot drift from playback.
    const modGeom = new ModGeom();
    if (mod) resolveModGeom(modGeom, mod, s.loopStart, s.loopEnd, s.len);
    const modLive = mod !== null && modGeom.live;
    const touches = (p) => modTouches(modGeom, mod.modInvert, p);
    // A mask sized for a shorter sample than the one on screen (the engine
    // grows it lazily) stops where the bits do.
    const invertEnd = invertMask
      ? Math.min(s.loopEnd, s.loopStart + invertMask.length * 8) : 0;
    const byteAt = (p, base = s.ptr) => {
      let src = p;
      const hit = modLive && touches(p);
      // The scatter throws every byte its own way, so the picture has to be
      // drawn through the engine's own mapping rather than one offset.
      if (hit) src = modAddress(modGeom, p, mod.modRot, mod.modScatter, mod.modSeed);
      let v = bin[base + src];
      let flipped = src !== p;
      // The legacy mask is tested against the byte actually READ, exactly as
      // the engine does — a rotation moves which byte that is.
      if (invertMask && src >= s.loopStart && src < invertEnd) {
        const k = src - s.loopStart;
        if ((invertMask[k >>> 3] >>> (k & 7)) & 1) { v ^= 0xff; flipped = true; }
      }
      if (hit) {
        if (modMask && modMask.length) {
          if ((modMask[src >>> 3] >>> (src & 7)) & 1) { v ^= 0xff; flipped = true; }
        } else if (mod.modSub) { v = (v - mod.modSub) & 0xff; flipped = true; }
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
          ctx.fillStyle = flipped ? C.waveInvert : C.wave;
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
          ctx.fillStyle = anyFlip ? C.waveInvert : C.wave;
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

    // Live play-position cursors — vertical bars in the waveform's OWN cursor
    // colour, which no part of the trace can wear: the old one was the same
    // orange as a byte the sample-modification command has inverted, so the
    // hairline disappeared into exactly the picture it was measuring (item 160).
    if (audio) {
      ctx.fillStyle = C.waveCursor ?? C.playCursor;
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
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

/** The walk's hop in bytes: the window's length shifted by `$f`'s low two bits
 *  ($0 a whole block, $3 an eighth of one), never less than a byte. */
function funkHopSize(fw) {
  return Math.max(1, fw.len >> (fw.mode & 3));
}

/** How the command that is driving this window is spelled — `$F0` … `$FF`. The
 *  effect code is the one caption that needs no translating. */
function funkSpelling(fw) {
  return `$F${(fw.mode & 0xf).toString(16).toUpperCase()}`;
}

/**
 * The distinct funk-repeat windows live on `s` right now, newest state per
 * frame: `{ window, pending, len }` in bytes plus the walk's `mode` (item
 * 163's `$f`), ready to scale onto the canvas.
 *
 * The width comes from the VOICE (its active loop length), not from the
 * document's loop points — an Ixmp patch replaces those under a sounding voice
 * (item 116), and a band drawn at the document's width would then be the wrong
 * size on exactly the instrument whose loop is most worth watching.
 */
function collectFunkWindows(audio, s) {
  const out = [];
  if (!audio || !s) return out;
  for (let vi = 0; vi < TOTAL_VOICES; vi++) {
    if (!audio.getVoiceActive(vi)) continue;
    if (audio.getVoiceSamplePtr(vi) !== s.ptr) continue;
    const len = audio.getVoiceFunkLen(vi);
    const window = audio.getVoiceFunkWindow(vi);
    if (!(len > 0) || window < 0 || window + len > s.len) continue;
    const pending = audio.getVoiceFunkPos(vi);
    const mode = audio.getVoiceFunkMode(vi) | 0;
    if (out.some((o) => o.window === window && o.len === len
      && o.pending === pending && o.mode === mode)) continue;
    out.push({ window, pending, len, mode });
  }
  return out;
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
