// Sample editor modals (v2) — split per tab, both with Apply / Cancel:
//   openSampleDspEditor  (Samples tab)     — length-preserving DSP over the
//     pool span (normalise / fade in / fade out / reverse). Pool bytes are
//     shared, so the edit reaches EVERY instrument using the sample; the
//     waveform shows the census loop region read-only.
//   openInstSampleEditor (Instruments tab) — play / loop / sustain markers of
//     ONE instrument's record (draggable markers + spinners + loop mode),
//     written through setInstBytesOp on bytes 8..14 of that slot only.
// Edits go through the undo stack as they happen (so playback hears them);
// Apply keeps them, Cancel (or Esc) rolls the stack back to the open depth.

import { setInstBytesOp, setSampleBytesOp } from "../../doc/ops.js";
import { normalise, fadeIn, fadeOut, reverse } from "../../doc/sampledsp.js";
import { themeColors } from "../theme.js";
import { hex2 } from "../notenames.js";
import { unescapeName } from "../names.js";
import { t } from "../i18n.js";

const W = 720, H = 200;

const MARKERS = [
  { key: "playStart", labelKey: "smp.play", lo: 8, colorKey: "accent2" },
  { key: "loopStart", labelKey: "smp.loopStart", lo: 10, colorKey: "accent" },
  { key: "loopEnd", labelKey: "smp.loopEnd", lo: 12, colorKey: "accent" },
];

/** Samples-tab editor for a sampleList() census entry. Resolves when closed. */
export function openSampleDspEditor(store, sample) {
  return new Promise((resolve) => {
    const doc = store.doc;
    const shell = buildShell(store, {
      title: `Sample ${String(sample.index).padStart(3, "0")} — ${unescapeName(sample.name) || "(unnamed)"}`,
      info: t("smp.dspNote", { len: sample.len, rate: sample.rate }) +
        ` · $${sample.users.map(hex2).join(" $")}`,
      className: "sample-editor",
      resolve,
    });

    const paint = () => {
      const hasLoop = (sample.loopMode & 3) !== 0 && sample.loopEnd > sample.loopStart;
      paintWaveform(shell.canvas, doc.sampleBin, sample.ptr, sample.len, {
        loopStart: hasLoop ? sample.loopStart : 0,
        loopEnd: hasLoop ? sample.loopEnd : 0,
        markers: [],
      });
    };

    // DSP row: each button rewrites the pool span through one undoable op.
    const opRow = document.createElement("div");
    opRow.className = "smp-ops";
    const DSP = [
      [t("smp.normalise"), normalise],
      [t("smp.fadeIn"), fadeIn],
      [t("smp.fadeOut"), fadeOut],
      [t("smp.reverse"), reverse],
    ];
    for (const [name, fn] of DSP) {
      const b = document.createElement("button");
      b.textContent = name;
      b.addEventListener("click", () => {
        const span = doc.sampleBin.subarray(sample.ptr, sample.ptr + sample.len);
        store.undo.apply(setSampleBytesOp(sample.ptr, fn(span)));
        paint();
      });
      opRow.appendChild(b);
    }
    opRow.appendChild(shell.makeAuditionButton(sample.users[0]));

    shell.dlg.insertBefore(opRow, shell.btnRow);
    paint();
    shell.show();
  });
}

/** Instruments-tab editor for slot's play/loop/sustain record fields. */
export function openInstSampleEditor(store, slot) {
  return new Promise((resolve) => {
    const doc = store.doc;
    const inst = () => doc.instruments[slot & 0x3ff];
    const len = inst().sampleLength;
    const ptr = inst().samplePtr;
    const shell = buildShell(store, {
      title: t("smp.editInst", {
        slot: slot.toString(16).toUpperCase().padStart(3, "0"),
        name: unescapeName(doc.instrumentName(slot)) || "(unnamed)",
      }),
      info: `${len} bytes · ${inst().samplingRate} Hz@C4 · ` + t("smp.markersNote"),
      className: "sample-editor",
      resolve,
    });

    const fields = () => ({
      playStart: inst().samplePlayStart,
      loopStart: inst().sampleLoopStart,
      loopEnd: inst().sampleLoopEnd,
      loopMode: inst().loopMode & 3,
      sustain: (inst().loopMode & 4) !== 0,
    });

    // field row: three spinners + loop mode + sustain
    const fieldRow = document.createElement("div");
    fieldRow.className = "smp-fields";
    const spinners = {};
    for (const m of MARKERS) {
      const lab = document.createElement("label");
      lab.append(t(m.labelKey) + " ");
      const num = document.createElement("input");
      num.type = "number";
      num.min = 0;
      num.max = len;
      num.addEventListener("change", () => {
        applyFields({ [m.key]: Math.max(0, Math.min(len, Math.round(Number(num.value) || 0))) });
      });
      spinners[m.key] = num;
      lab.appendChild(num);
      fieldRow.appendChild(lab);
    }
    const modeLab = document.createElement("label");
    modeLab.append(t("smp.loop"));
    const modeSel = document.createElement("select");
    for (const [v, name] of [[0, t("smp.loopOff")], [1, t("smp.loopForward")],
                             [2, t("smp.loopPingpong")], [3, t("smp.loopOneshot")]]) {
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
    susLab.append(susBox, t("smp.sustain"));
    fieldRow.append(modeLab, susLab);

    const opRow = document.createElement("div");
    opRow.className = "smp-ops";
    opRow.appendChild(shell.makeAuditionButton(slot));

    shell.dlg.insertBefore(fieldRow, shell.btnRow);
    shell.dlg.insertBefore(opRow, shell.btnRow);

    // ── field writes: one setInstBytesOp per change/drag-step ──
    function applyFields(change, gestureId = null) {
      const f = { ...fields(), ...change };
      // the edited marker wins; the other loop end follows to keep start ≤ end
      if ("loopStart" in change && f.loopStart > f.loopEnd) f.loopEnd = f.loopStart;
      if ("loopEnd" in change && f.loopEnd < f.loopStart) f.loopStart = f.loopEnd;
      const modeByte = (inst().loopMode & 0x10) | (f.sustain ? 4 : 0) | (f.loopMode & 3);
      const pairs = [
        [8, f.playStart & 0xff], [9, (f.playStart >>> 8) & 0xff],
        [10, f.loopStart & 0xff], [11, (f.loopStart >>> 8) & 0xff],
        [12, f.loopEnd & 0xff], [13, (f.loopEnd >>> 8) & 0xff],
        [14, modeByte],
      ];
      store.undo.apply(setInstBytesOp(slot, pairs, gestureId));
      paint();
    }

    function paint() {
      const f = fields();
      paintWaveform(shell.canvas, doc.sampleBin, ptr, len, {
        loopStart: f.loopMode !== 0 ? f.loopStart : 0,
        loopEnd: f.loopMode !== 0 ? f.loopEnd : 0,
        markers: MARKERS.map((m) => ({ ...m, pos: f[m.key] })),
      });
      for (const m of MARKERS) spinners[m.key].value = f[m.key];
      modeSel.value = f.loopMode;
      susBox.checked = f.sustain;
    }
    paint();

    // ── marker dragging ──
    let drag = null; // {key, gestureId}
    const markerAt = (x) => {
      const f = fields();
      let best = null, bestDist = 6; // px grab radius
      for (const m of MARKERS) {
        const mx = (f[m.key] / len) * W;
        const d = Math.abs(x - mx);
        if (d < bestDist) { bestDist = d; best = m.key; }
      }
      return best;
    };
    shell.canvas.addEventListener("pointerdown", (e) => {
      const rect = shell.canvas.getBoundingClientRect();
      const key = markerAt(e.clientX - rect.left);
      if (!key) return;
      drag = { key, gestureId: `smpdrag${Date.now()}` };
      shell.canvas.setPointerCapture(e.pointerId);
    });
    shell.canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const rect = shell.canvas.getBoundingClientRect();
      const pos = Math.max(0, Math.min(len,
        Math.round(((e.clientX - rect.left) / W) * len)));
      applyFields({ [drag.key]: pos }, drag.gestureId);
    });
    shell.canvas.addEventListener("pointerup", () => { drag = null; });

    shell.show();
  });
}

// ── shared dialog shell: title/info/canvas + Apply/Cancel with undo rollback ──
function buildShell(store, { title, info, className, resolve }) {
  const dlg = document.createElement("dialog");
  dlg.className = `modal ${className}`;
  const h = document.createElement("h3");
  h.textContent = title;
  const infoEl = document.createElement("p");
  infoEl.className = "dim";
  infoEl.textContent = info;
  const canvas = document.createElement("canvas");
  canvas.className = "smp-canvas";

  const btnRow = document.createElement("div");
  btnRow.className = "modal-buttons";
  const applyBtn = document.createElement("button");
  applyBtn.textContent = t("common.apply");
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = t("common.cancel");
  btnRow.append(applyBtn, cancelBtn);

  dlg.append(h, infoEl, canvas, btnRow);
  document.body.appendChild(dlg);

  // Cancel = undo everything applied while the editor was open. Sound because
  // coalescing only merges ops with a NON-null shared gestureId — a modal edit
  // can never fold into an entry that predates the open.
  const depth0 = store.undo?.undoStack.length ?? 0;
  let auditioning = false;
  const finish = (rollback) => {
    if (auditioning) store.audio?.jamStop(0);
    if (rollback && store.undo) {
      while (store.undo.undoStack.length > depth0) store.undo.undo();
    }
    dlg.close();
    dlg.remove();
    resolve();
  };
  applyBtn.addEventListener("click", (e) => { e.preventDefault(); finish(false); });
  cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(true); });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(true); });
  dlg.addEventListener("keydown", (e) => e.stopPropagation());

  /** Engine audition of `slot` on the top channel; toggles play/stop. */
  const makeAuditionButton = (slot) => {
    const playBtn = document.createElement("button");
    playBtn.textContent = t("smp.audition");
    playBtn.title = t("smp.auditionTitle");
    playBtn.disabled = slot === undefined;
    playBtn.addEventListener("click", async () => {
      await window.__microtoneEnsureAudio?.();
      const audio = store.audio;
      if (!audio) return;
      if (auditioning) {
        audio.jamStop(0);
        playBtn.textContent = t("smp.audition");
      } else {
        audio.jamNote(0, store.doc.channelCount - 1, 0x5000, slot);
        playBtn.textContent = t("smp.auditionStop");
      }
      auditioning = !auditioning;
    });
    return playBtn;
  };

  return { dlg, canvas, btnRow, makeAuditionButton, show: () => dlg.showModal() };
}

// ── shared waveform painter (centre-anchored bars, loop shading, markers) ──
function paintWaveform(canvas, bin, ptr, len, { loopStart, loopEnd, markers }) {
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
  if (len <= 0) return;

  if (loopEnd > loopStart) {
    ctx.fillStyle = C.waveLoop;
    ctx.fillRect((loopStart / len) * W, 0, ((loopEnd - loopStart) / len) * W, H);
  }
  const baseY = H / 2;
  const yOf = (v) => (H * (255 - v)) / 255;
  ctx.fillStyle = C.dim;
  ctx.fillRect(0, Math.round(baseY), W, 1);
  ctx.fillStyle = C.wave;
  if (len <= W) {
    const rectW = Math.max(1, Math.ceil(W / len));
    for (let i = 0; i < len; i++) {
      const yv = yOf(bin[ptr + i]);
      ctx.fillRect(Math.floor((i * W) / len), Math.min(baseY, yv),
        rectW, Math.max(1, Math.abs(baseY - yv)));
    }
  } else {
    for (let col = 0; col < W; col++) {
      const start = Math.floor((col * len) / W);
      const end = Math.min(len, Math.floor(((col + 1) * len) / W));
      if (end <= start) continue;
      const step = Math.max(1, ((end - start) / 8) | 0);
      let mn = 255, mx = 0;
      for (let p = start; p < end; p += step) {
        const v = bin[ptr + p];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const yTop = Math.min(baseY, yOf(mx));
      const yBot = Math.max(baseY, yOf(mn));
      ctx.fillRect(col, yTop, 1, Math.max(1, yBot - yTop + 1));
    }
  }
  for (const m of markers) {
    const x = (m.pos / len) * W;
    ctx.fillStyle = C[m.colorKey];
    ctx.fillRect(x - 1, 0, 2, H);
    ctx.font = "10px sans-serif";
    ctx.fillText(t(m.labelKey), Math.min(W - 30, x + 3), m.key === "loopEnd" ? H - 4 : 11);
  }
}
