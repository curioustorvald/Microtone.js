// Sample editor modal (v1) — waveform with draggable playStart / loopStart /
// loopEnd markers, loop mode + sustain, and length-preserving DSP ops
// (src/doc/sampledsp.js). Field edits write bytes 8..14 of EVERY
// base-instrument user of the sample in one undo step (multiInstBytesOp);
// patch-only users share the pool bytes but keep their own Ixmp loop fields
// and are listed as untouched. DSP ops rewrite the pool span
// (setSampleBytesOp → bank re-upload, so playback hears it immediately).

import { multiInstBytesOp, setSampleBytesOp } from "../../doc/ops.js";
import { SAMPLE_DSP } from "../../doc/sampledsp.js";
import { themeColors } from "../theme.js";
import { hex2 } from "../notenames.js";

const MARKERS = [
  { key: "playStart", label: "play", lo: 8, colorKey: "accent2" },
  { key: "loopStart", label: "loop⇤", lo: 10, colorKey: "accent" },
  { key: "loopEnd", label: "⇥loop", lo: 12, colorKey: "accent" },
];

/**
 * Open the editor for a sampleList() census entry. Resolves when closed.
 * Live values are re-read from the FIRST base-inst user each paint, so
 * undo/redo while open stays coherent.
 */
export function openSampleEditor(store, sample) {
  return new Promise((resolve) => {
    const doc = store.doc;
    // Base-instrument users whose record fields describe THIS pool span.
    const slots = sample.users.filter((u) => {
      const inst = doc.instruments[u];
      return !inst.isMeta && inst.samplePtr === sample.ptr && inst.sampleLength === sample.len;
    });
    const patchOnly = sample.users.filter((u) => !slots.includes(u));
    const ref = () => doc.instruments[slots[0]]; // field source of truth
    const fields = () => slots.length > 0
      ? {
        playStart: ref().samplePlayStart,
        loopStart: ref().sampleLoopStart,
        loopEnd: ref().sampleLoopEnd,
        loopMode: ref().loopMode & 3,
        sustain: (ref().loopMode & 4) !== 0,
      }
      : { playStart: 0, loopStart: 0, loopEnd: 0, loopMode: 0, sustain: false };

    const dlg = document.createElement("dialog");
    dlg.className = "modal sample-editor";
    const h = document.createElement("h3");
    h.textContent = `Sample ${String(sample.index).padStart(3, "0")} — ${sample.name || "(unnamed)"}`;
    const info = document.createElement("p");
    info.className = "dim";
    info.textContent =
      `${sample.len} bytes · ${sample.rate} Hz@C4 · edits apply to ` +
      (slots.length > 0 ? `$${slots.map(hex2).join(" $")}` : "(no base-inst users)") +
      (patchOnly.length > 0 ? ` · patch-only users $${patchOnly.map(hex2).join(" $")} keep their own loops` : "");

    const canvas = document.createElement("canvas");
    canvas.className = "smp-canvas";

    // field row: three spinners + loop mode + sustain
    const fieldRow = document.createElement("div");
    fieldRow.className = "smp-fields";
    const spinners = {};
    for (const m of MARKERS) {
      const lab = document.createElement("label");
      lab.append(m.label + " ");
      const num = document.createElement("input");
      num.type = "number";
      num.min = 0;
      num.max = sample.len;
      num.addEventListener("change", () => {
        applyFields({ [m.key]: Math.max(0, Math.min(sample.len, Math.round(Number(num.value) || 0))) });
      });
      spinners[m.key] = num;
      lab.appendChild(num);
      fieldRow.appendChild(lab);
    }
    const modeLab = document.createElement("label");
    modeLab.append("loop ");
    const modeSel = document.createElement("select");
    for (const [v, name] of [[0, "off"], [1, "forward"], [2, "ping-pong"], [3, "one-shot"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = name;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener("change", () => applyFields({ loopMode: Number(modeSel.value) }));
    modeLab.appendChild(modeSel);
    const susLab = document.createElement("label");
    const susBox = document.createElement("input");
    susBox.type = "checkbox";
    susBox.addEventListener("change", () => applyFields({ sustain: susBox.checked }));
    susLab.append(susBox, " sustain");
    fieldRow.append(modeLab, susLab);

    // DSP + audition row
    const opRow = document.createElement("div");
    opRow.className = "smp-ops";
    for (const [name, fn] of SAMPLE_DSP) {
      const b = document.createElement("button");
      b.textContent = name;
      b.addEventListener("click", () => {
        const span = doc.sampleBin.subarray(sample.ptr, sample.ptr + sample.len);
        store.undo.apply(setSampleBytesOp(sample.ptr, fn(span)));
        paint();
      });
      opRow.appendChild(b);
    }
    const playBtn = document.createElement("button");
    playBtn.textContent = "▶ C4";
    playBtn.title = "Audition through the engine (first user instrument)";
    playBtn.disabled = sample.users.length === 0;
    let auditioning = false;
    playBtn.addEventListener("click", async () => {
      await window.__microtoneEnsureAudio?.();
      const audio = store.audio;
      if (!audio) return;
      if (auditioning) {
        audio.jamStop(0);
        playBtn.textContent = "▶ C4";
      } else {
        audio.jamNote(0, store.doc.channelCount - 1, 0x5000, sample.users[0]);
        playBtn.textContent = "■ stop";
      }
      auditioning = !auditioning;
    });
    opRow.appendChild(playBtn);

    const btnRow = document.createElement("div");
    btnRow.className = "modal-buttons";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    btnRow.appendChild(closeBtn);

    dlg.append(h, info, canvas, fieldRow, opRow, btnRow);
    document.body.appendChild(dlg);

    const finish = () => {
      if (auditioning) store.audio?.jamStop(0);
      dlg.close();
      dlg.remove();
      resolve();
    };
    closeBtn.addEventListener("click", (e) => { e.preventDefault(); finish(); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();

    // ── field writes: one multi-inst op per change/drag-step ──
    function applyFields(change, gestureId = null) {
      if (slots.length === 0) return;
      const f = { ...fields(), ...change };
      // the edited marker wins; the other end follows to keep start ≤ end
      if ("loopStart" in change && f.loopStart > f.loopEnd) f.loopEnd = f.loopStart;
      if ("loopEnd" in change && f.loopEnd < f.loopStart) f.loopStart = f.loopEnd;
      const modeByte = (ref().loopMode & 0x10) | (f.sustain ? 4 : 0) | (f.loopMode & 3);
      const pairs = [
        [8, f.playStart & 0xff], [9, (f.playStart >>> 8) & 0xff],
        [10, f.loopStart & 0xff], [11, (f.loopStart >>> 8) & 0xff],
        [12, f.loopEnd & 0xff], [13, (f.loopEnd >>> 8) & 0xff],
        [14, modeByte],
      ];
      store.undo.apply(multiInstBytesOp(slots.map((slot) => ({ slot, pairs })), gestureId));
      paint();
    }

    // ── waveform + markers ──
    const W = 720, H = 200;
    function paint() {
      const C = themeColors();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, W, H);
      const bin = doc.sampleBin;
      const f = fields();

      if (f.loopMode !== 0 && f.loopEnd > f.loopStart) {
        ctx.fillStyle = C.waveLoop;
        ctx.fillRect((f.loopStart / sample.len) * W, 0,
          ((f.loopEnd - f.loopStart) / sample.len) * W, H);
      }
      const baseY = H / 2;
      const yOf = (v) => (H * (255 - v)) / 255;
      ctx.fillStyle = C.dim;
      ctx.fillRect(0, Math.round(baseY), W, 1);
      ctx.fillStyle = C.wave;
      if (sample.len <= W) {
        const rectW = Math.max(1, Math.ceil(W / sample.len));
        for (let i = 0; i < sample.len; i++) {
          const yv = yOf(bin[sample.ptr + i]);
          ctx.fillRect(Math.floor((i * W) / sample.len), Math.min(baseY, yv),
            rectW, Math.max(1, Math.abs(baseY - yv)));
        }
      } else {
        for (let col = 0; col < W; col++) {
          const start = Math.floor((col * sample.len) / W);
          const end = Math.min(sample.len, Math.floor(((col + 1) * sample.len) / W));
          if (end <= start) continue;
          const step = Math.max(1, ((end - start) / 8) | 0);
          let mn = 255, mx = 0;
          for (let p = start; p < end; p += step) {
            const v = bin[sample.ptr + p];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          const yTop = Math.min(baseY, yOf(mx));
          const yBot = Math.max(baseY, yOf(mn));
          ctx.fillRect(col, yTop, 1, Math.max(1, yBot - yTop + 1));
        }
      }
      // markers
      for (const m of MARKERS) {
        const x = (f[m.key] / sample.len) * W;
        ctx.fillStyle = C[m.colorKey];
        ctx.fillRect(x - 1, 0, 2, H);
        ctx.font = "10px sans-serif";
        ctx.fillText(m.label, Math.min(W - 30, x + 3), m.key === "loopEnd" ? H - 4 : 11);
      }
      // sync the controls
      for (const m of MARKERS) spinners[m.key].value = f[m.key];
      modeSel.value = f.loopMode;
      susBox.checked = f.sustain;
      const editable = slots.length > 0;
      for (const el of [...Object.values(spinners), modeSel, susBox]) el.disabled = !editable;
    }
    paint();

    // ── marker dragging ──
    let drag = null; // {key, gestureId}
    const markerAt = (x) => {
      const f = fields();
      let best = null, bestDist = 6; // px grab radius
      for (const m of MARKERS) {
        const mx = (f[m.key] / sample.len) * W;
        const d = Math.abs(x - mx);
        if (d < bestDist) { bestDist = d; best = m.key; }
      }
      return best;
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (slots.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const key = markerAt(e.clientX - rect.left);
      if (!key) return;
      drag = { key, gestureId: `smpdrag${Date.now()}` };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const rect = canvas.getBoundingClientRect();
      const pos = Math.max(0, Math.min(sample.len,
        Math.round(((e.clientX - rect.left) / W) * sample.len)));
      applyFields({ [drag.key]: pos }, drag.gestureId);
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
  });
}
