// Sample Lab (items 83/84/999) — the import-time sample editor, "a tiny
// Audacity running inside": a zoomable waveform over a FLOAT working buffer
// with drag selection, length-changing edits (crop/cut — legal here and only
// here, before pool allocation), fades/gain/normalise/etc over the selection,
// an oversampled parametric EQ with a live response graph, and a transient
// chopper (item 84) that splits the take into per-hit chunks the user can
// merge/split/discard. Commit funnels every kept chunk through
// planMultiSampleImport + ONE importBankOp (full undo). Length is only
// finalised at commit: each chunk is Kaiser-resampled to the target rate and,
// if still over the 65535-frame budget, squeezed with the rate following —
// the info line shows that fate BEFORE the irreversible step.
//
// Entry points (all resolve {firstSlot, count} | null):
//   file import (importsample.js) · mic recording (recordsample.js) ·
//   Samples-view "Lab…" (a pooled sample's copy — the original is untouched).

import { planMultiSampleImport } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import {
  crop, cut, silenceRange, fadeInRange, fadeOutRange, gainRange, normaliseRange,
  reverseRange, invertRange, removeDCRange, eqApply, eqResponseDb,
  detectTransients, chunksFromSplits, planFit, fitToBudget, quantiseU8,
  TARGET_RATE_MAX,
} from "../../doc/wavelab.js";
import { showModal } from "../widgets/modal.js";
import { themeColors } from "../theme.js";
import { escapeNonAscii } from "../names.js";
import { t } from "../i18n.js";

const WAVE_H = 220;
const EQGRAPH_H = 150;
const UNDO_CAP = 24;
const SPLIT_GRAB_PX = 6;
const EQ_DB_RANGE = 18; // graph spans ±this many dB

// 8 bands: 1 high-pass, 2 shelves (Q-adjustable), 5 peaks — spread ascending.
const DEFAULT_BANDS = () => ([
  { type: "highpass", freq: 80, q: 0.707, enabled: false },
  { type: "lowshelf", freq: 120, gainDb: 0, q: 0.707, enabled: true },
  { type: "peak", freq: 250, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 600, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 1500, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 4000, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 8000, gainDb: 0, q: 1.0, enabled: true },
  { type: "highshelf", freq: 12000, gainDb: 0, q: 0.707, enabled: true },
]);

/**
 * Open the Lab on a working buffer.
 * @param store the app store (doc + undo + audio)
 * @param data Float32Array mono, nominal ±1
 * @param rate sample rate of `data`
 * @param name default instrument/sample name
 * @param sourceLabel free-text provenance shown in the title
 * @param confirmDiscard confirm before closing without importing (recordings)
 */
export function openSampleLab(store, { data, rate, name = "", sourceLabel = "", confirmDiscard = false }) {
  if (!store.doc || !data || data.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    // ── state ──
    let buf = Float32Array.from(data);
    const srcRate = Math.max(1, Math.round(rate));
    let sel = null;            // {a, b} in samples, a < b
    let splits = [];           // chop boundaries (samples)
    let chopOn = false;
    let discarded = new Set(); // chunk START positions left out of the import
    // clamp default corners below the Nyquist of this take (a low-rate pooled
    // sample can sit under 12 kHz, where the high shelf's default would fall)
    const nyquist = Math.max(1, Math.floor(srcRate / 2));
    let bands = DEFAULT_BANDS().map((b) => ({ ...b, freq: Math.min(b.freq, nyquist - 1) }));
    let eqOpen = false;
    const undoStack = [], redoStack = [];
    let edited = false;
    let playing = null;        // {src, gain, t0, from}
    let actx = null;

    // ── view transform ──
    const dlg = document.createElement("dialog");
    dlg.className = "modal samplelab-modal";
    const cssW = Math.min(Math.floor((window.innerWidth * 94) / 100), 1280) - 48*2;
    const W = Math.max(480, cssW);
    let spp = buf.length / W;  // samples per px
    let scroll = 0;            // sample index at x=0
    const fitSpp = () => Math.max(1 / 16, buf.length / W);
    const clampView = () => {
      spp = Math.max(1 / 16, Math.min(fitSpp(), spp));
      scroll = Math.max(0, Math.min(Math.max(0, buf.length - W * spp), scroll));
    };
    const xOf = (i) => (i - scroll) / spp;
    const iOf = (x) => Math.round(scroll + x * spp);

    // ── DOM ──
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    dlg.innerHTML = `
      <h3>${esc(t("lab.title", { name: name || t("lab.untitled") }))}${sourceLabel ? ` <span class="dim">· ${esc(sourceLabel)}</span>` : ""}</h3>
      <div class="lab-info dim"></div>
      <div class="lab-tools">
        <button class="lab-play">${esc(t("lab.play"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-zin">${esc(t("lab.zoomIn"))}</button>
        <button class="lab-zout">${esc(t("lab.zoomOut"))}</button>
        <button class="lab-zfit">${esc(t("lab.zoomFit"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-undo">${esc(t("lab.undo"))}</button>
        <button class="lab-redo">${esc(t("lab.redo"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-chop" aria-pressed="false" title="${esc(t("lab.chopTitle"))}">${esc(t("lab.chop"))}</button>
        <span class="lab-chopctl" hidden>
          <button class="lab-detect" title="${esc(t("lab.detectTitle"))}">${esc(t("lab.detect"))}</button>
          <button class="lab-merge" title="${esc(t("lab.mergeTitle"))}">${esc(t("lab.merge"))}</button>
          <label>${esc(t("lab.threshold"))} <input type="range" class="lab-sens" min="1.1" max="3.5" step="0.1" value="1.8"></label>
        </span>
      </div>
      <canvas class="lab-wave"></canvas>
      <div class="lab-chunks" hidden></div>
      <div class="lab-tools lab-ops">
        <button data-op="crop" title="${esc(t("lab.cropTitle"))}">${esc(t("lab.crop"))}</button>
        <button data-op="cut" title="${esc(t("lab.cutTitle"))}">${esc(t("lab.cut"))}</button>
        <button data-op="silence">${esc(t("lab.silence"))}</button>
        <button data-op="fadeIn">${esc(t("lab.fadeIn"))}</button>
        <button data-op="fadeOut">${esc(t("lab.fadeOut"))}</button>
        <button data-op="gain" title="${esc(t("lab.gainTitle"))}">${esc(t("lab.gain"))}</button>
        <button data-op="normalise">${esc(t("lab.normalise"))}</button>
        <button data-op="reverse">${esc(t("lab.reverse"))}</button>
        <button data-op="invert">${esc(t("lab.invert"))}</button>
        <button data-op="removeDC">${esc(t("lab.removeDC"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-eqtoggle">${esc(t("lab.eq"))} ▾</button>
      </div>
      <div class="lab-eq" hidden>
        <div class="lab-eqbands"></div>
        <canvas class="lab-eqgraph"></canvas>
        <div class="lab-tools">
          <button class="lab-eqapply">${esc(t("lab.eqApply"))}</button>
          <span class="dim lab-eqhint">${esc(t("lab.eqHint"))}</span>
        </div>
      </div>
      <div class="lab-row">
        <label>${esc(t("lab.name"))} <input type="text" class="lab-name" value="${esc(name)}"></label>
        <label>${esc(t("lab.rate"))} <input type="number" class="lab-rate" min="1" max="${TARGET_RATE_MAX}" value="${Math.min(srcRate, TARGET_RATE_MAX)}"></label>
        <span class="lab-fit dim"></span>
      </div>
      <p class="dim lab-hint">${esc(t("lab.hint"))}</p>
      <div class="modal-buttons">
        <button class="lab-ok">${esc(t("lab.import"))}</button>
        <button class="lab-cancel">${esc(t("common.cancel"))}</button>
      </div>`;
    document.body.appendChild(dlg);

    const $ = (q) => dlg.querySelector(q);
    const canvas = $(".lab-wave");
    const eqGraph = $(".lab-eqgraph");
    const chunkStrip = $(".lab-chunks");
    const nameInput = $(".lab-name");
    const rateInput = $(".lab-rate");
    const playBtn = $(".lab-play");
    const okBtn = $(".lab-ok");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = WAVE_H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = WAVE_H + "px";
    eqGraph.width = W * dpr; eqGraph.height = EQGRAPH_H * dpr;
    eqGraph.style.width = W + "px"; eqGraph.style.height = EQGRAPH_H + "px";

    // ── helpers ──
    const chunks = () => chunksFromSplits(buf.length, splits);
    const keptChunks = () => (chopOn ? chunks().filter((c) => !discarded.has(c.a)) : [{ a: 0, b: buf.length }]);
    const targetRate = () => {
      const v = parseInt(rateInput.value, 10);
      return Number.isFinite(v) && v >= 1 ? Math.min(TARGET_RATE_MAX, v) : null;
    };

    function pushUndo() {
      undoStack.push({ buf, splits: [...splits], discarded: new Set(discarded) });
      if (undoStack.length > UNDO_CAP) undoStack.shift();
      redoStack.length = 0;
      edited = true;
    }
    function restore(s) {
      buf = s.buf;
      splits = [...s.splits];
      discarded = new Set(s.discarded);
      sel = null;
      clampView();
      refresh();
    }
    const labUndo = () => {
      if (!undoStack.length) return;
      redoStack.push({ buf, splits: [...splits], discarded: new Set(discarded) });
      restore(undoStack.pop());
    };
    const labRedo = () => {
      if (!redoStack.length) return;
      undoStack.push({ buf, splits: [...splits], discarded: new Set(discarded) });
      restore(redoStack.pop());
    };

    // splits/discards follow a length-changing edit (crop keeps the window,
    // cut closes the gap); discards are keyed by chunk start so they remap
    // with the same arithmetic
    function remapPositions(list, fn) {
      return list.map(fn).filter((p) => p !== null && p > 0 && p < buf.length);
    }
    function applyRanged(op) {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      if ((op === "crop" || op === "cut") && !sel) { alert(t("lab.needSel")); return; }
      pushUndo();
      switch (op) {
        case "crop": {
          buf = crop(buf, a, b);
          const shift = (p) => (p <= a ? null : p >= b ? null : p - a);
          splits = remapPositions(splits, shift);
          discarded = new Set(remapPositions([...discarded], shift));
          sel = null; scroll = 0; spp = fitSpp();
          break;
        }
        case "cut": {
          buf = cut(buf, a, b);
          const shift = (p) => (p < a ? p : p < b ? null : p - (b - a));
          splits = remapPositions(splits, shift);
          discarded = new Set(remapPositions([...discarded], shift));
          sel = null;
          break;
        }
        case "silence": buf = silenceRange(buf, a, b); break;
        case "fadeIn": buf = fadeInRange(buf, a, b); break;
        case "fadeOut": buf = fadeOutRange(buf, a, b); break;
        case "normalise": buf = normaliseRange(buf, a, b); break;
        case "reverse": buf = reverseRange(buf, a, b); break;
        case "invert": buf = invertRange(buf, a, b); break;
        case "removeDC": buf = removeDCRange(buf, a, b); break;
      }
      clampView();
      refresh();
    }
    async function gainTool() {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      const res = await showModal({
        title: t("lab.gain"),
        fields: [{ name: "db", label: t("lab.gainAsk"), type: "number", value: "-3" }],
        okLabel: t("common.apply"),
      });
      if (!res) return;
      const db = Number(res.db);
      if (!Number.isFinite(db)) return;
      pushUndo();
      buf = gainRange(buf, a, b, Math.pow(10, db / 20));
      refresh();
    }

    // ── painting ──
    function paintWave() {
      const C = themeColors();
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, W, WAVE_H);
      const mid = WAVE_H / 2;
      const yOf = (v) => mid - v * (mid - 4);

      // selection under the wave
      if (sel) {
        ctx.fillStyle = C.sel || C.accent;
        ctx.globalAlpha = 0.22;
        ctx.fillRect(xOf(sel.a), 0, xOf(sel.b) - xOf(sel.a), WAVE_H);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = C.dim;
      ctx.fillRect(0, Math.round(mid), W, 1);

      ctx.strokeStyle = C.wave;
      ctx.fillStyle = C.wave;
      if (spp <= 1) {
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        const i0 = Math.max(0, Math.floor(scroll));
        const i1 = Math.min(buf.length - 1, Math.ceil(scroll + W * spp));
        for (let i = i0; i <= i1; i++) {
          const x = xOf(i), y = yOf(buf[i]);
          i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        for (let col = 0; col < W; col++) {
          const a = Math.floor(scroll + col * spp);
          const b = Math.min(buf.length, Math.floor(scroll + (col + 1) * spp));
          if (b <= a || a >= buf.length) continue;
          const step = Math.max(1, ((b - a) / 8) | 0);
          let mn = Infinity, mx = -Infinity;
          for (let p = a; p < b; p += step) {
            const v = buf[p];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          const yT = yOf(mx), yB = yOf(mn);
          ctx.fillRect(col, Math.min(yT, mid), 1, Math.max(1, Math.abs(yB - yT)));
        }
      }

      if (chopOn) {
        const cs = chunks();
        // discarded chunks dim out
        ctx.fillStyle = C.bg;
        ctx.globalAlpha = 0.55;
        for (const c of cs) {
          if (discarded.has(c.a)) ctx.fillRect(xOf(c.a), 0, xOf(c.b) - xOf(c.a), WAVE_H);
        }
        ctx.globalAlpha = 1;
        // split flags
        for (const p of splits) {
          const x = xOf(p);
          if (x < -4 || x > W + 4) continue;
          ctx.fillStyle = C.accent2;
          ctx.fillRect(x - 0.5, 0, 1.5, WAVE_H);
          ctx.beginPath();
          ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 9);
          ctx.closePath();
          ctx.fill();
        }
        // chunk numbers
        ctx.fillStyle = C.fg2 || C.fg;
        ctx.font = "11px sans-serif";
        cs.forEach((c, i) => {
          const x = Math.max(2, xOf(c.a) + 3);
          if (x < W) ctx.fillText(String(i + 1), x, 20);
        });
      }

      if (playing) {
        const pos = playPos();
        if (pos !== null) {
          ctx.fillStyle = C.playCursor || C.accent;
          ctx.fillRect(xOf(pos) - 0.5, 0, 1.5, WAVE_H);
        }
      }
    }

    const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : `${Math.round(f)}`);
    function paintEqGraph() {
      const C = themeColors();
      const ctx = eqGraph.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, W, EQGRAPH_H);

      const GL = 30, GB = 15;                 // gutters: dB labels (left), Hz labels (bottom)
      const plotW = W - GL, plotH = EQGRAPH_H - GB;
      const fLo = 20, fHi = srcRate / 2;       // view spans 20 Hz → Nyquist
      const xF = (f) => GL + (Math.log(f / fLo) / Math.log(fHi / fLo)) * plotW;
      const yDb = (db) => plotH / 2 - (db / EQ_DB_RANGE) * (plotH / 2 - 4);
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "alphabetic";

      // ── dB grid (horizontal, every 6 dB) + left-gutter labels ──
      for (let db = -EQ_DB_RANGE; db <= EQ_DB_RANGE; db += 6) {
        const y = yDb(db);
        ctx.fillStyle = C.dim;
        ctx.globalAlpha = db === 0 ? 0.5 : 0.22;
        ctx.fillRect(GL, y, plotW, 1);
        ctx.globalAlpha = 0.85;
        ctx.fillText(db > 0 ? `+${db}` : `${db}`, 2, y + 3);
      }

      // ── frequency grid (log, 1-2-3-5-7 per decade); majors labelled ──
      const majors = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
      const lines = [20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000,
                     5000, 7000, 10000, 20000];
      ctx.fillStyle = C.dim;
      for (const f of lines) {
        if (f <= fLo || f >= fHi) continue;
        const x = xF(f);
        ctx.globalAlpha = majors.has(f) ? 0.38 : 0.16;
        ctx.fillRect(x, 0, 1, plotH);
        if (majors.has(f)) {
          ctx.globalAlpha = 0.85;
          ctx.fillText(fmtHz(f), x + 2, EQGRAPH_H - 4);
        }
      }
      // always label the view's extremes: 20 Hz at the left, Nyquist at the right
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = C.fg2 || C.fg;
      ctx.fillText(`${fLo}`, GL + 2, EQGRAPH_H - 4);
      const hi = fmtHz(fHi);
      ctx.fillText(hi, W - ctx.measureText(hi).width - 2, EQGRAPH_H - 4);
      ctx.globalAlpha = 1;

      // ── response curve, clipped to the plot ──
      ctx.save();
      ctx.beginPath();
      ctx.rect(GL, 0, plotW, plotH);
      ctx.clip();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let px = 0; px <= plotW; px++) {
        const f = fLo * Math.pow(fHi / fLo, px / plotW);
        const y = yDb(eqResponseDb(bands, srcRate, f));
        px === 0 ? ctx.moveTo(GL + px, y) : ctx.lineTo(GL + px, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function refreshInfo() {
      const secs = (n) => (n / srcRate).toFixed(2);
      let line = t("lab.info", { frames: buf.length, rate: srcRate, secs: secs(buf.length) });
      if (sel) line += t("lab.selInfo", { frames: sel.b - sel.a, secs: secs(sel.b - sel.a) });
      $(".lab-info").textContent = line;

      const kept = keptChunks();
      let fitStr;
      if (kept.length === 0) {
        fitStr = t("lab.noChunks");
      } else {
        const fits = kept.map((c) => planFit(c.b - c.a, srcRate, targetRate()));
        const big = fits.reduce((m, f) => (f.frames > m.frames ? f : m), fits[0]);
        fitStr = kept.length === 1
          ? t("lab.importOne", { frames: big.frames, rate: big.rate })
          : t("lab.importMany", { n: kept.length, frames: big.frames, rate: big.rate });
        if (fits.some((f) => f.squeezed)) fitStr += t("lab.squeezed");
      }
      $(".lab-fit").textContent = fitStr;
      okBtn.textContent = chopOn && kept.length > 1
        ? t("lab.importN", { n: kept.length }) : t("lab.import");
      okBtn.disabled = kept.length === 0;
    }

    function refreshChunkStrip() {
      chunkStrip.hidden = !chopOn;
      chunkStrip.innerHTML = "";
      if (!chopOn) return;
      chunks().forEach((c, i) => {
        const pill = document.createElement("span");
        pill.className = "lab-chunk" + (discarded.has(c.a) ? " off" : "");
        pill.title = t("lab.chunkTitle");
        const keep = document.createElement("input");
        keep.type = "checkbox";
        keep.checked = !discarded.has(c.a);
        keep.addEventListener("change", () => {
          keep.checked ? discarded.delete(c.a) : discarded.add(c.a);
          edited = true;
          refresh();
        });
        const lab = document.createElement("button");
        lab.textContent = `${i + 1} · ${((c.b - c.a) / srcRate).toFixed(2)}s`;
        lab.addEventListener("click", () => {
          sel = { a: c.a, b: c.b };
          if (xOf(c.a) < 0 || xOf(c.b) > W) scroll = Math.max(0, c.a - ((W * spp) - (c.b - c.a)) / 2);
          clampView();
          refresh();
        });
        pill.append(keep, lab);
        chunkStrip.appendChild(pill);
      });
    }

    function refresh() {
      paintWave();
      refreshChunkStrip();
      refreshInfo();
      $(".lab-undo").disabled = undoStack.length === 0;
      $(".lab-redo").disabled = redoStack.length === 0;
    }

    // ── waveform interaction: drag = select, click = chop-edit / clear ──
    let drag = null; // {x0, i0, moved}
    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      drag = { x0: x, i0: Math.max(0, Math.min(buf.length, iOf(x))), moved: false };
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer (smokes) */ }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (!drag.moved && Math.abs(x - drag.x0) < 3) return;
      drag.moved = true;
      const i = Math.max(0, Math.min(buf.length, iOf(x)));
      sel = i === drag.i0 ? null : { a: Math.min(drag.i0, i), b: Math.max(drag.i0, i) };
      paintWave();
      refreshInfo();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const wasDrag = drag.moved;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      drag = null;
      if (wasDrag) return;
      if (chopOn) {
        // click near a flag removes the split, elsewhere adds one
        const near = splits.find((p) => Math.abs(xOf(p) - x) <= SPLIT_GRAB_PX);
        pushUndo();
        if (near !== undefined) splits = splits.filter((p) => p !== near);
        else {
          const p = Math.max(1, Math.min(buf.length - 1, iOf(x)));
          splits = [...splits, p].sort((m, n) => m - n);
        }
        refresh();
      } else {
        sel = null;
        refresh();
      }
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (e.ctrlKey || e.metaKey) {
        const focus = iOf(x);
        spp *= e.deltaY > 0 ? 1.3 : 1 / 1.3;
        clampView();
        scroll = Math.max(0, focus - x * spp);
        clampView();
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        scroll += d * spp;
        clampView();
      }
      paintWave();
    }, { passive: false });

    $(".lab-zin").addEventListener("click", () => {
      const centre = iOf(W / 2);
      spp /= 2; clampView();
      scroll = Math.max(0, centre - (W / 2) * spp); clampView();
      paintWave();
    });
    $(".lab-zout").addEventListener("click", () => {
      const centre = iOf(W / 2);
      spp *= 2; clampView();
      scroll = Math.max(0, centre - (W / 2) * spp); clampView();
      paintWave();
    });
    $(".lab-zfit").addEventListener("click", () => { spp = fitSpp(); scroll = 0; paintWave(); });

    // ── tools ──
    for (const b of dlg.querySelectorAll(".lab-ops button[data-op]")) {
      b.addEventListener("click", () => {
        if (b.dataset.op === "gain") gainTool();
        else applyRanged(b.dataset.op);
      });
    }
    $(".lab-undo").addEventListener("click", labUndo);
    $(".lab-redo").addEventListener("click", labRedo);

    // ── chop ──
    const chopBtn = $(".lab-chop");
    const detect = () => {
      pushUndo();
      splits = detectTransients(buf, srcRate, { sensitivity: Number($(".lab-sens").value) });
      discarded.clear();
      refresh();
    };
    const setChopMode = (on) => {
      chopOn = on;
      chopBtn.classList.toggle("on", on);
      chopBtn.setAttribute("aria-pressed", on ? "true" : "false");
      $(".lab-chopctl").hidden = !on;
      if (on && splits.length === 0) detect(); // first entry auto-detects
      else refresh();
    };
    chopBtn.addEventListener("click", () => setChopMode(!chopOn));
    $(".lab-detect").addEventListener("click", detect);
    // Merge: drop every split that falls strictly inside the selection, so the
    // chunks it spans collapse into one (two or more, in a single action). The
    // simplest case — merging two neighbours — is also a click on their shared
    // split flag on the waveform.
    function mergeSelection() {
      if (!chopOn) return;
      if (!sel) { alert(t("lab.mergeNoSel")); return; }
      const inSel = (p) => p > sel.a && p < sel.b;
      if (!splits.some(inSel)) { alert(t("lab.mergeNone")); return; }
      pushUndo();
      splits = splits.filter((p) => !inSel(p));
      // a discarded chunk whose start was one of the dropped splits is gone
      discarded = new Set([...discarded].filter((p) => !inSel(p)));
      refresh();
    }
    $(".lab-merge").addEventListener("click", mergeSelection);

    // ── EQ ──
    const bandsEl = $(".lab-eqbands");
    function buildEqBands() {
      bandsEl.innerHTML = "";
      bands.forEach((band) => {
        const row = document.createElement("div");
        row.className = "lab-eqband";
        const en = document.createElement("input");
        en.type = "checkbox";
        en.checked = band.enabled !== false;
        en.addEventListener("change", () => { band.enabled = en.checked; paintEqGraph(); });
        const kind = document.createElement("span");
        kind.className = "lab-eqkind";
        kind.textContent = t(`lab.eqBand.${band.type}`);
        row.append(en, kind);
        const num = (key, min, max, step, unit) => {
          if (band[key] === undefined) return;
          const lab = document.createElement("label");
          const inp = document.createElement("input");
          inp.type = "number";
          inp.min = min; inp.max = max; inp.step = step;
          inp.value = band[key];
          inp.addEventListener("change", () => {
            band[key] = Math.max(min, Math.min(max, Number(inp.value) || 0));
            inp.value = band[key];
            paintEqGraph();
          });
          lab.append(inp, " " + unit);
          row.appendChild(lab);
        };
        num("freq", 20, Math.floor(srcRate / 2), 1, t("lab.eqFreq"));
        num("gainDb", -24, 24, 0.5, t("lab.eqGain"));
        num("q", 0.1, 12, 0.1, t("lab.eqQ"));
        bandsEl.appendChild(row);
      });
    }
    $(".lab-eqtoggle").addEventListener("click", () => {
      eqOpen = !eqOpen;
      $(".lab-eq").hidden = !eqOpen;
      if (eqOpen) { buildEqBands(); paintEqGraph(); }
    });
    $(".lab-eqapply").addEventListener("click", () => {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      pushUndo();
      buf = eqApply(buf, srcRate, bands, { a, b });
      refresh();
    });

    // ── audition (Web Audio on the working buffer — it is not pooled yet) ──
    function playPos() {
      if (!playing || !actx) return null;
      const pos = playing.from + (actx.currentTime - playing.t0) * srcRate;
      return pos >= 0 && pos <= buf.length ? pos : null;
    }
    function stopPlay() {
      if (!playing) return;
      try { playing.src.stop(); } catch { /* already ended */ }
      playing = null;
      playBtn.textContent = t("lab.play");
      paintWave();
    }
    function startPlay() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === "suspended") actx.resume();
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      // AudioBuffer rates clamp to [8000, 96000]; playbackRate restores pitch
      const bufRate = Math.max(8000, Math.min(96000, srcRate));
      const ab = actx.createBuffer(1, buf.length, bufRate);
      ab.getChannelData(0).set(buf);
      const src = actx.createBufferSource();
      src.buffer = ab;
      src.playbackRate.value = srcRate / bufRate;
      let head = src;
      if (eqOpen) {
        // live preview of the EQ panel with native filters (the destructive
        // Apply is the oversampled render — marginally cleaner near Nyquist)
        const map = { highpass: "highpass", lowshelf: "lowshelf", peak: "peaking", highshelf: "highshelf" };
        for (const band of bands) {
          if (band.enabled === false) continue;
          if (band.type !== "highpass" && Math.abs(band.gainDb ?? 0) < 1e-6) continue;
          const f = actx.createBiquadFilter();
          f.type = map[band.type];
          f.frequency.value = band.freq;
          if (band.gainDb !== undefined) f.gain.value = band.gainDb;
          if (band.q !== undefined) f.Q.value = band.q;
          head.connect(f);
          head = f;
        }
      }
      head.connect(actx.destination);
      src.start(0, a / bufRate, (b - a) / bufRate);
      playing = { src, t0: actx.currentTime, from: a };
      playBtn.textContent = t("lab.stop");
      src.onended = () => { if (playing?.src === src) stopPlay(); };
      const tick = () => {
        if (!playing) return;
        paintWave();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    playBtn.addEventListener("click", () => (playing ? stopPlay() : startPlay()));

    // ── commit / close ──
    const enc = new TextEncoder();
    function commit() {
      const kept = keptChunks();
      if (kept.length === 0) { alert(t("lab.noChunks")); return; }
      const nm = nameInput.value.trim() || name || t("lab.untitled");
      let clippedCount = 0;
      const items = kept.map((c, i) => {
        const fitted = fitToBudget(buf.slice(c.a, c.b), srcRate, targetRate());
        const q = quantiseU8(fitted.data);
        if (q.clipped) clippedCount++;
        return {
          nameBytes: enc.encode(escapeNonAscii(kept.length > 1 ? `${nm} ${i + 1}` : nm)),
          pcm: q.pcm,
          rate: fitted.rate,
        };
      });
      if (clippedCount > 0 && !confirm(t("lab.clipWarn", { n: clippedCount }))) return;
      const plan = planMultiSampleImport(store.doc, items);
      if (plan.error) { alert(plan.error); return; }
      store.undo.apply(importBankOp(plan));
      finish({ firstSlot: plan.insts[0].destSlot, count: plan.insts.length });
    }
    function finish(result) {
      stopPlay();
      if (actx) { actx.close().catch(() => {}); actx = null; }
      dlg.close();
      dlg.remove();
      resolve(result);
    }
    function requestCancel() {
      if ((confirmDiscard || edited) && !confirm(t("lab.confirmClose"))) return;
      finish(null);
    }
    okBtn.addEventListener("click", (e) => { e.preventDefault(); commit(); });
    $(".lab-cancel").addEventListener("click", (e) => { e.preventDefault(); requestCancel(); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); requestCancel(); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // never leak piano/transport keys to the grid
      const inField = e.target.tagName === "INPUT" && e.target.type !== "checkbox" && e.target.type !== "range";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inField) {
        e.preventDefault();
        e.shiftKey ? labRedo() : labUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !inField) {
        e.preventDefault();
        labRedo();
      } else if (e.key === " " && !inField && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        playing ? stopPlay() : startPlay();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !inField && sel) {
        e.preventDefault();
        applyRanged("cut");
      }
    });
    rateInput.addEventListener("change", refreshInfo);

    // ── test hooks (headless smokes drive the modal through these) ──
    dlg.__lab = {
      state: () => ({
        len: buf.length, rate: srcRate, sel: sel && { ...sel },
        splits: [...splits], chop: chopOn,
        discarded: [...discarded], undoDepth: undoStack.length,
      }),
      buffer: () => buf,
      setSelection: (a, b) => { sel = { a: Math.min(a, b), b: Math.max(a, b) }; refresh(); },
      clearSelection: () => { sel = null; refresh(); },
      tool: (op) => applyRanged(op),
      gainDb: (db) => { pushUndo(); const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length]; buf = gainRange(buf, a, b, Math.pow(10, db / 20)); refresh(); },
      undo: labUndo,
      redo: labRedo,
      setChop: (on) => setChopMode(on),
      detect,
      setSplits: (arr) => { pushUndo(); splits = [...arr].sort((a, b) => a - b); refresh(); },
      merge: mergeSelection,
      toggleChunk: (i) => {
        const c = chunks()[i];
        if (!c) return;
        discarded.has(c.a) ? discarded.delete(c.a) : discarded.add(c.a);
        edited = true;
        refresh();
      },
      chunks: () => chunks(),
      bands: () => bands,
      setBand: (i, patch) => { Object.assign(bands[i], patch); if (eqOpen) { buildEqBands(); paintEqGraph(); } },
      applyEq: () => $(".lab-eqapply").click(),
      setName: (s) => { nameInput.value = s; },
      setTargetRate: (v) => { rateInput.value = v; refreshInfo(); },
      commit,
      cancel: () => finish(null),
    };

    refresh();
    dlg.showModal();
  });
}
