// Paint a waveform by hand with the mouse (item 53). Two entry points share the
// canvas/paint/seed core:
//   paintNewSample  — CREATE a fresh sample+instrument (Instruments view), landed
//     through planSampleImport + importBankOp (undo/sync for free). A length
//     field + seed shapes; the whole sample loops so a single cycle sustains.
//   paintEditSample — EDIT the selected pooled sample in place (Samples view,
//     next to Edit…): the canvas is primed with the sample's bytes, its length is
//     fixed, and OK rewrites the pool span via setSampleBytesOp (every instrument
//     using the sample hears it). A confirm warns when the sample is long
//     (> PAINT_WARN_LEN), since hand-painting is meant for short waveforms.

import { planSampleImport } from "../../doc/bankmerge.js";
import { importBankOp, setSampleBytesOp } from "../../doc/ops.js";
import { escapeNonAscii } from "../names.js";
import { t } from "../i18n.js";

const MIN_LEN = 2, MAX_LEN = 0xffff, DEF_LEN = 256, RATE = 32000;
export const PAINT_WARN_LEN = 1024;

/** CREATE a new sample+instrument by painting. Resolves {firstSlot, count} | null. */
export function paintNewSample(store) {
  if (!store.doc) return Promise.resolve(null);
  return openPaintModal({
    store,
    title: t("wave.title"),
    length: DEF_LEN,
    fixedLength: false,
    okLabel: t("common.create"),
    showName: true,
    commit: (buf, name) => {
      const nameBytes = new TextEncoder().encode(escapeNonAscii(name || t("wave.defaultName")));
      const plan = planSampleImport(store.doc, { nameBytes, pcm: buf, rate: RATE, loop: true });
      if (plan.error) { alert(plan.error); return undefined; }
      store.undo.apply(importBankOp(plan));
      return { firstSlot: plan.insts[0].destSlot, count: 1 };
    },
  });
}

/** EDIT the pooled sample `sample` (a doc.sampleList() entry) by painting over
 *  its current bytes. Resolves true on apply, else null. */
export function paintEditSample(store, sample) {
  if (!store.doc || !sample) return Promise.resolve(null);
  if (sample.len > PAINT_WARN_LEN &&
      !confirm(t("wave.longWarn", { len: sample.len, limit: PAINT_WARN_LEN }))) {
    return Promise.resolve(null);
  }
  const initial = Uint8Array.from(store.doc.sampleBin.subarray(sample.ptr, sample.ptr + sample.len));
  return openPaintModal({
    store,
    title: t("wave.editTitle", { name: sample.name || `#${sample.index}`, len: sample.len }),
    length: sample.len,
    fixedLength: true,
    initial,
    okLabel: t("common.apply"),
    showName: false,
    commit: (buf) => {
      store.undo.apply(setSampleBytesOp(sample.ptr, buf));
      return true;
    },
  });
}

// ── shared modal ──
function openPaintModal(opts) {
  return new Promise((resolve) => {
    let length = opts.length;
    let buf = opts.initial ? Uint8Array.from(opts.initial) : new Uint8Array(length).fill(128);

    let cssMaxW1 = ((window.innerWidth * 94) / 100)|0 // 94 vw
    let cssMaxW2 = 1280 // 1280 px
    let cssMaxW = Math.min(cssMaxW1, cssMaxW2)

    const dlg = document.createElement("dialog");
    dlg.className = "modal wavepaint-modal";
    const lenRow = opts.fixedLength
      ? `<span class="wave-len-fixed">${esc(t("wave.length"))}: ${length}</span>`
      : `<label>${esc(t("wave.length"))} <input type="number" class="wave-len" min="${MIN_LEN}" max="${MAX_LEN}" value="${length}"></label>`;
    dlg.innerHTML = `
      <h3>${esc(opts.title)}</h3>
      <div class="wave-row">
        ${lenRow}
        <span class="wave-shapes">
          <button data-shape="sine">${esc(t("wave.sine"))}</button>
          <button data-shape="saw">${esc(t("wave.saw"))}</button>
          <button data-shape="square">${esc(t("wave.square"))}</button>
          <button data-shape="triangle">${esc(t("wave.triangle"))}</button>
          <button data-shape="noise">${esc(t("wave.noise"))}</button>
          <button data-shape="flat">${esc(t("wave.clear"))}</button>
        </span>
      </div>
      <canvas class="wave-paint" width="${cssMaxW - 48}" height="200"></canvas>
      <p class="wave-hint">${esc(t("wave.hint"))}</p>
      ${opts.showName ? `<div class="wave-row"><label>${esc(t("wave.name"))} <input type="text" class="wave-name" value="${esc(t("wave.defaultName"))}"></label></div>` : ""}
      <div class="modal-buttons">
        <button class="wave-cancel">${esc(t("common.cancel"))}</button>
        <button class="wave-ok">${esc(opts.okLabel)}</button>
      </div>`;
    document.body.appendChild(dlg);

    const canvas = dlg.querySelector(".wave-paint");
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const lenInput = dlg.querySelector(".wave-len");
    const nameInput = dlg.querySelector(".wave-name");

    const xToIdx = (x) => Math.min(length - 1, Math.max(0, Math.round((x / W) * (length - 1))));
    const yToVal = (y) => Math.min(255, Math.max(0, Math.round((1 - y / H) * 255)));

    function draw() {
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue("--cv-bg").trim() || "#111";
      const fg = cs.getPropertyValue("--accent").trim() || "#4af";
      const grid = cs.getPropertyValue("--dim").trim() || "#666";
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = grid; ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = fg; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let x = 0; x < W; x++) {
        const y = H - (buf[xToIdx(x)] / 255) * H;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Paint: fill the range between the previous and current sample index so a
    // fast drag has no gaps (linear ramp of the value across skipped indices).
    let painting = false, lastIdx = -1, lastVal = 128;
    function paintAt(e) {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (W / r.width);
      const y = (e.clientY - r.top) * (H / r.height);
      const idx = xToIdx(x), val = yToVal(y);
      if (lastIdx < 0) { buf[idx] = val; }
      else {
        const a = Math.min(lastIdx, idx), b = Math.max(lastIdx, idx);
        const va = lastIdx <= idx ? lastVal : val, vb = lastIdx <= idx ? val : lastVal;
        for (let i = a; i <= b; i++) {
          buf[i] = b === a ? val : Math.round(va + ((vb - va) * (i - a)) / (b - a));
        }
      }
      lastIdx = idx; lastVal = val;
      draw();
    }
    canvas.addEventListener("pointerdown", (e) => {
      painting = true; lastIdx = -1; canvas.setPointerCapture?.(e.pointerId); paintAt(e);
    });
    canvas.addEventListener("pointermove", (e) => { if (painting) paintAt(e); });
    canvas.addEventListener("pointerup", (e) => {
      painting = false; canvas.releasePointerCapture?.(e.pointerId);
    });

    function seed(shape) {
      for (let i = 0; i < length; i++) {
        const p = i / length; let v = 128;
        switch (shape) {
          case "sine": v = 128 + 127 * Math.sin(2 * Math.PI * p); break;
          case "saw": v = 255 * p; break;
          case "square": v = p < 0.5 ? 255 : 0; break;
          case "triangle": v = p < 0.5 ? 510 * p : 510 * (1 - p); break;
          case "noise": v = Math.random() * 255; break;
          case "flat": default: v = 128; break;
        }
        buf[i] = Math.min(255, Math.max(0, Math.round(v)));
      }
      draw();
    }
    for (const b of dlg.querySelectorAll(".wave-shapes button")) {
      b.addEventListener("click", () => seed(b.dataset.shape));
    }

    if (lenInput) {
      lenInput.addEventListener("change", () => {
        const newLen = Math.min(MAX_LEN, Math.max(MIN_LEN, parseInt(lenInput.value, 10) || DEF_LEN));
        const nb = new Uint8Array(newLen);
        for (let i = 0; i < newLen; i++) nb[i] = buf[Math.min(length - 1, Math.round((i / newLen) * length))];
        buf = nb; length = newLen; lenInput.value = newLen;
        draw();
      });
    }

    const close = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    dlg.querySelector(".wave-cancel").addEventListener("click", () => close(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation()); // don't leak to the grid
    dlg.querySelector(".wave-ok").addEventListener("click", () => {
      const result = opts.commit(buf, nameInput ? nameInput.value : "");
      if (result === undefined) return; // commit reported an error; keep the modal open
      close(result);
    });

    draw();
    dlg.showModal();
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
