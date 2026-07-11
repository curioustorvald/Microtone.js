// Elaborate New-Project dialog — the web equivalent of taut_newproj.mjs, bumped
// to a richer GUI. Collects every song setting BEFORE the blank project is built:
// tempo (BPM/speed) with a live "blinkenlights" tempo preview, meter (time
// signature + rows/beat → derived rows/bar; these are the primary/secondary
// beat divisors that drive the timeline row-highlight), tuning reference, project
// metadata, channel layout, and the display notation (default 24-TET).
//
// showNewProject({ fromBank, bankName }) resolves with a settings object or null
// (cancel). The caller (app.js newProject) turns it into the Document shape.
//   { name, composer, copyright, channels(32|64), bpm, tickRate, notation,
//     beatPri, beatSec, timeSigNum, timeSigDen, baseNote, baseFreq }

import { t } from "../i18n.js";
import { pitchTablePresets } from "../pitchtables.js";

// Base-note tuning references (note value in the 0x1000-per-octave space, C4 =
// 0x5000). Written to the song's tuning fields; display-only in this engine.
const BASE_NOTES = [
  { label: "C4", note: 0x5000, freq: 261.6256 },
  { label: "A4", note: 0x5c00, freq: 440.0 },
];
const DEN_OPTIONS = [1, 2, 4, 8, 16, 32];
const NOTATION_DEFAULT = 240; // 24-TET

const NOTE_PRESETS = Object.values(pitchTablePresets).sort((a, b) => a.index - b.index);
// Notation-type badge colours (mirrors taut's list palette): d diatonic-ish,
// M macrotonal, m microtonal, "" raw.
const TYPE_LABEL = { d: "12", M: "M", m: "µ", "": "·" };

const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n));
};

export function showNewProject({ fromBank = null, bankName = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal np-modal";

    // ── state ──
    let baseSel = 1;      // default A4
    let freqAuto = true;  // freq tracks the base note until the user edits it
    let noteSel = Math.max(0, NOTE_PRESETS.findIndex((p) => p.index === NOTATION_DEFAULT));

    const title = fromBank ? t("np.titleFromBank", { bank: bankName }) : t("np.title");
    const body = fromBank ? t("np.bodyFromBank") : t("np.body");

    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      <p class="dim np-body">${esc(body)}</p>
      <div class="np-grid">
        <div class="np-col">
          <fieldset class="np-sec">
            <legend>${esc(t("np.secTempo"))}</legend>
            <label class="np-field"><span>${esc(t("np.bpm"))}</span>
              <input type="number" data-f="bpm" min="25" max="535" value="125"></label>
            <label class="np-field"><span>${esc(t("np.speed"))}</span>
              <input type="number" data-f="spd" min="1" max="127" value="6"></label>
            <div class="np-field np-blink-row"><span class="np-blink-label">${esc(t("np.beat"))}</span>
              <canvas class="np-blink" width="188" height="16"></canvas></div>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secMeter"))}</legend>
            <div class="np-field"><span>${esc(t("np.timeSig"))}</span>
              <span class="np-tsig">
                <input type="number" data-f="tnum" min="1" max="16" value="4">
                <span class="np-tsig-sep">/</span>
                <select data-f="tden">${DEN_OPTIONS.map((d) =>
                  `<option value="${d}"${d === 4 ? " selected" : ""}>${d}</option>`).join("")}</select>
              </span></div>
            <label class="np-field"><span>${esc(t("np.rowsPerBeat"))}</span>
              <input type="number" data-f="rpb" min="1" max="16" value="4"></label>
            <div class="np-field np-derived"><span></span>
              <span class="dim" data-f="rpbar"></span></div>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secTuning"))}</legend>
            <div class="np-field"><span>${esc(t("np.baseNote"))}</span>
              <span class="np-chips" data-f="base">${BASE_NOTES.map((b, i) =>
                `<button type="button" class="np-chip${i === baseSel ? " sel" : ""}" data-base="${i}">${b.label}</button>`).join("")}</span></div>
            <label class="np-field"><span>${esc(t("np.frequency"))}</span>
              <span class="np-freq"><input type="number" data-f="freq" min="0" step="0.0001" value="440"> Hz</span></label>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secMeta"))}</legend>
            <label class="np-field"><span>${esc(t("np.name"))}</span>
              <input type="text" data-f="name" maxlength="63" value="${esc(t("np.untitled"))}"></label>
            <label class="np-field"><span>${esc(t("np.composer"))}</span>
              <input type="text" data-f="comp" maxlength="63" value=""></label>
            <label class="np-field"><span>${esc(t("np.copyright"))}</span>
              <input type="text" data-f="copy" maxlength="63" value=""></label>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secLayout"))}</legend>
            <div class="np-field"><span>${esc(t("np.channels"))}</span>
              <span class="np-chips" data-f="chan">
                <button type="button" class="np-chip sel" data-chan="32">32</button>
                <button type="button" class="np-chip" data-chan="64">64</button>
              </span></div>
          </fieldset>
        </div>
        <div class="np-col np-col-right">
          <fieldset class="np-sec np-sec-grow">
            <legend>${esc(t("np.secNotation"))}</legend>
            <div class="np-notelist" data-f="notes" tabindex="0">${NOTE_PRESETS.map((p, i) =>
              `<div class="np-note${i === noteSel ? " sel" : ""}" data-note="${i}">
                 <span class="np-note-badge np-badge-${p.t || "raw"}">${TYPE_LABEL[p.t] ?? "·"}</span>
                 <span class="np-note-name">${esc(p.name)}</span></div>`).join("")}</div>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secPreview"))}</legend>
            <div class="np-preview" data-f="preview"></div>
          </fieldset>
        </div>
      </div>
      <div class="modal-buttons">
        <button class="np-ok">${esc(t("common.create"))}</button>
        <button class="np-cancel">${esc(t("common.cancel"))}</button>
      </div>`;

    document.body.appendChild(dlg);
    const q = (sel) => dlg.querySelector(sel);
    const inp = (f) => dlg.querySelector(`[data-f="${f}"]`);

    // ── value getters ──
    const beatPri = () => clampInt(inp("rpb").value, 1, 16, 4);
    const timeNum = () => clampInt(inp("tnum").value, 1, 16, 4);
    const beatSec = () => Math.min(255, beatPri() * timeNum());
    const bpmVal = () => clampInt(inp("bpm").value, 25, 535, 125);
    const spdVal = () => clampInt(inp("spd").value, 1, 127, 6);
    const curFreq = () => {
      const n = parseFloat(inp("freq").value);
      return isNaN(n) || n <= 0 ? BASE_NOTES[baseSel].freq : n;
    };

    // ── row-highlight preview: two columns of pattern rows tinted by the beat
    //    divisions, exactly like the Timeline gutter/banding. ──
    const PREV_ROWS = 16, PREV_COLS = 2;
    function drawPreview() {
      const bp = beatPri(), bs = beatSec();
      const host = inp("preview");
      let html = "";
      for (let col = 0; col < PREV_COLS; col++) {
        html += '<div class="np-prev-col">';
        for (let r = 0; r < PREV_ROWS; r++) {
          const row = col * PREV_ROWS + r;
          const isBar = row % bs === 0;
          const isBeat = row % bp === 0;
          const cls = isBar ? "bar" : isBeat ? "beat" : "";
          html += `<div class="np-prev-row ${cls}">${String(row).padStart(2, "0")}</div>`;
        }
        html += "</div>";
      }
      host.innerHTML = html;
    }

    function drawDerived() {
      inp("rpbar").textContent = t("np.rowsPerBar", { n: beatSec() });
    }

    // ── blinkenlights: a strip whose length = the tick speed, a cursor
    //    advancing one LED per tick (rate = BPM), and a beat lamp lit on every
    //    notated-beat row. Purely a live BPM×speed preview. ──
    const canvas = q(".np-blink");
    const cx = canvas.getContext("2d");
    const css = getComputedStyle(dlg);
    const COL = {
      off: css.getPropertyValue("--meter-bg").trim() || "#2a2f3a",
      tick: css.getPropertyValue("--accent").trim() || "#ffc043",
      beatOn: css.getPropertyValue("--meter").trim() || "#8be400",
    };
    let blinkTick = 0;
    function drawBlinken() {
      const w = canvas.width, h = canvas.height;
      const spd = spdVal(), bp = beatPri();
      const row = Math.floor(blinkTick / spd);
      const tickInRow = blinkTick % spd;
      const onBeat = row % bp === 0;
      cx.clearRect(0, 0, w, h);
      // beat lamp (left)
      const r = h / 2 - 1;
      cx.fillStyle = onBeat ? COL.beatOn : COL.off;
      cx.beginPath(); cx.arc(r + 1, h / 2, r, 0, Math.PI * 2); cx.fill();
      // tick strip
      const x0 = h + 4;
      const stripW = w - x0;
      const seg = stripW / Math.max(1, spd);
      for (let i = 0; i < spd; i++) {
        cx.fillStyle = i === tickInRow ? COL.tick : COL.off;
        const cxp = x0 + i * seg + seg / 2;
        cx.beginPath();
        cx.arc(cxp, h / 2, Math.min(r, seg / 2 - 0.5), 0, Math.PI * 2);
        cx.fill();
      }
    }

    // animation loop (rAF, tempo-accurate: 2.5/BPM seconds per tick)
    let raf = 0, lastMs = 0, accMs = 0;
    function frame(ms) {
      if (!lastMs) lastMs = ms;
      let dt = ms - lastMs; lastMs = ms;
      if (dt < 0) dt = 0;
      const tickMs = 2500 / bpmVal();
      accMs += dt;
      if (accMs > tickMs * 8) accMs = tickMs; // no long catch-up burst
      let advanced = false;
      while (accMs >= tickMs) { accMs -= tickMs; blinkTick = (blinkTick + 1) & 0x7fffffff; advanced = true; }
      if (advanced) drawBlinken();
      raf = requestAnimationFrame(frame);
    }

    // ── selection helpers ──
    function selectBase(i) {
      baseSel = i;
      dlg.querySelectorAll("[data-base]").forEach((el) =>
        el.classList.toggle("sel", +el.dataset.base === i));
      if (freqAuto) inp("freq").value = String(BASE_NOTES[i].freq);
    }
    function selectChan(v) {
      dlg.querySelectorAll("[data-chan]").forEach((el) =>
        el.classList.toggle("sel", el.dataset.chan === String(v)));
    }
    function selectNote(i) {
      noteSel = i;
      dlg.querySelectorAll("[data-note]").forEach((el) =>
        el.classList.toggle("sel", +el.dataset.note === i));
      const el = dlg.querySelector(`[data-note="${i}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
    function curChan() {
      return dlg.querySelector("[data-chan].sel")?.dataset.chan === "64" ? 64 : 32;
    }

    // ── wiring ──
    dlg.querySelectorAll("[data-base]").forEach((el) =>
      el.addEventListener("click", () => selectBase(+el.dataset.base)));
    dlg.querySelectorAll("[data-chan]").forEach((el) =>
      el.addEventListener("click", () => selectChan(el.dataset.chan)));
    dlg.querySelectorAll("[data-note]").forEach((el) =>
      el.addEventListener("click", () => selectNote(+el.dataset.note)));

    inp("freq").addEventListener("input", () => { freqAuto = false; });
    for (const f of ["rpb", "tnum"]) inp(f).addEventListener("input", () => { drawDerived(); drawPreview(); });

    // arrow-key navigation on the notation list
    inp("notes").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selectNote(Math.max(0, Math.min(NOTE_PRESETS.length - 1, noteSel + (e.key === "ArrowDown" ? 1 : -1))));
      }
    });

    // ── close / result ──
    const finish = (result) => {
      cancelAnimationFrame(raf);
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    function buildResult() {
      return {
        name: inp("name").value,
        composer: inp("comp").value,
        copyright: inp("copy").value,
        channels: curChan(),
        bpm: bpmVal(),
        tickRate: spdVal(),
        notation: NOTE_PRESETS[noteSel].index,
        beatPri: beatPri(),
        beatSec: beatSec(),
        timeSigNum: timeNum(),
        timeSigDen: DEN_OPTIONS[inp("tden").selectedIndex],
        baseNote: BASE_NOTES[baseSel].note,
        baseFreq: curFreq(),
      };
    }
    q(".np-ok").addEventListener("click", (e) => { e.preventDefault(); finish(buildResult()); });
    q(".np-cancel").addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't leak piano/transport keys while modal is up
      // Enter submits, except inside the notation list (arrows drive it) and
      // on the buttons (their own click handler runs).
      if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target !== inp("notes")) {
        e.preventDefault(); finish(buildResult());
      }
    });

    // ── first paint ──
    drawDerived();
    drawPreview();
    drawBlinken();
    dlg.showModal();
    // reveal the default-selected notation (the list opens mid-way down)
    const selEl = dlg.querySelector(".np-note.sel");
    if (selEl) {
      const list = inp("notes");
      list.scrollTop = selEl.offsetTop - list.clientHeight / 2 + selEl.clientHeight / 2;
    }
    inp("name").focus();
    inp("name").select();
    raf = requestAnimationFrame(frame);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
