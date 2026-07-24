// Mic recording (item 83.1) — capture a take from getUserMedia as RAW float
// PCM (AudioWorklet, ScriptProcessor fallback — never MediaRecorder, whose
// codec would smear an 8-bit-destined sample), then hand it to the Sample Lab
// for crop/chop/import. The lab is opened with confirmDiscard so a mis-Esc
// can't silently drop a take.

import { openSampleLab } from "./samplelab.js";
import { t } from "../i18n.js";

const MAX_REC_SECONDS = 120;
const METER_W = 260, METER_H = 16;
const WORKLET_URL = new URL("../../audio/record-worklet.js", import.meta.url);

/** Record → Lab → import. Resolves {firstSlot, count} | null. */
export async function recordSample(store) {
  if (!store.doc) return null;
  if (!navigator.mediaDevices?.getUserMedia) {
    alert(t("rec.noMic", { err: "mediaDevices unavailable" }));
    return null;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    alert(t("rec.noMic", { err: err.message ?? err }));
    return null;
  }

  const take = await runRecorderModal(stream);
  stream.getTracks().forEach((tr) => tr.stop());
  if (!take || take.data.length === 0) return null;
  return openSampleLab(store, {
    data: take.data,
    rate: take.rate,
    name: t("rec.defaultName"),
    sourceLabel: t("rec.sourceLabel", { rate: take.rate }),
    confirmDiscard: true,
  });
}

/** The capture modal: level meter, Record/Stop, Use-take. Resolves
 *  {data: Float32Array, rate} | null. */
function runRecorderModal(stream) {
  return new Promise(async (resolve) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);

    let recording = false;
    let chunks = [];
    let total = 0;
    let lastPeak = 0;
    const maxFrames = MAX_REC_SECONDS * ctx.sampleRate;
    const onChunk = (mono) => {
      let peak = 0;
      for (let i = 0; i < mono.length; i++) {
        const v = Math.abs(mono[i]);
        if (v > peak) peak = v;
      }
      lastPeak = peak;
      if (!recording) return;
      chunks.push(mono);
      total += mono.length;
      if (total >= maxFrames) setRecording(false);
    };

    // capture node: worklet preferred, ScriptProcessor fallback; either way
    // the graph must reach the destination to be pulled — through zero gain,
    // or the mic would feed back out of the speakers
    const mute = ctx.createGain();
    mute.gain.value = 0;
    let capture = null;
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      capture = new AudioWorkletNode(ctx, "mt-recorder");
      capture.port.onmessage = (e) => onChunk(e.data);
    } catch {
      const sp = ctx.createScriptProcessor(4096, 2, 1);
      sp.onaudioprocess = (e) => {
        const nCh = e.inputBuffer.numberOfChannels;
        const n = e.inputBuffer.length;
        const mono = new Float32Array(n);
        for (let c = 0; c < nCh; c++) {
          const d = e.inputBuffer.getChannelData(c);
          for (let i = 0; i < n; i++) mono[i] += d[i];
        }
        if (nCh > 1) for (let i = 0; i < n; i++) mono[i] /= nCh;
        onChunk(mono);
      };
      capture = sp;
    }
    src.connect(capture);
    capture.connect(mute);
    mute.connect(ctx.destination);

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const dlg = document.createElement("dialog");
    dlg.className = "modal record-modal";
    dlg.innerHTML = `
      <h3>${esc(t("rec.title"))}</h3>
      <canvas class="rec-meter" width="${METER_W}" height="${METER_H}"></canvas>
      <div class="rec-status dim">${esc(t("rec.ready"))}</div>
      <p class="dim rec-hint">${esc(t("rec.hint", { max: MAX_REC_SECONDS }))}</p>
      <div class="modal-buttons">
        <button class="rec-toggle">${esc(t("rec.record"))}</button>
        <button class="rec-use" disabled>${esc(t("rec.use"))}</button>
        <button class="rec-cancel">${esc(t("common.cancel"))}</button>
      </div>`;
    document.body.appendChild(dlg);
    const meter = dlg.querySelector(".rec-meter");
    const status = dlg.querySelector(".rec-status");
    const toggleBtn = dlg.querySelector(".rec-toggle");
    const useBtn = dlg.querySelector(".rec-use");

    let raf = 0;
    const paintMeter = () => {
      const mctx = meter.getContext("2d");
      const cs = getComputedStyle(document.documentElement);
      mctx.fillStyle = cs.getPropertyValue("--meter-bg").trim() || "#222";
      mctx.fillRect(0, 0, METER_W, METER_H);
      mctx.fillStyle = lastPeak > 0.98
        ? "#d33" : cs.getPropertyValue("--meter").trim() || "#4a4";
      mctx.fillRect(0, 2, Math.min(1, lastPeak) * METER_W, METER_H - 4);
      if (recording) {
        status.textContent = t("rec.elapsed", { secs: (total / ctx.sampleRate).toFixed(1) });
      }
      raf = requestAnimationFrame(paintMeter);
    };
    raf = requestAnimationFrame(paintMeter);

    function setRecording(on) {
      recording = on;
      if (on) { chunks = []; total = 0; }
      toggleBtn.textContent = on ? t("rec.stop") : (total > 0 ? t("rec.again") : t("rec.record"));
      useBtn.disabled = on || total === 0;
      if (!on && total > 0) {
        status.textContent = t("rec.took", { secs: (total / ctx.sampleRate).toFixed(1) });
      }
    }
    toggleBtn.addEventListener("click", () => setRecording(!recording));

    const finish = (result) => {
      cancelAnimationFrame(raf);
      try { src.disconnect(); capture.disconnect(); mute.disconnect(); } catch { /* torn down */ }
      ctx.close().catch(() => {});
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    useBtn.addEventListener("click", () => {
      const data = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { data.set(c, o); o += c.length; }
      finish({ data, rate: ctx.sampleRate });
    });
    dlg.querySelector(".rec-cancel").addEventListener("click", () => finish(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());

    // test hook: the smoke drives capture without clicking
    dlg.__rec = { setRecording, taken: () => total, use: () => useBtn.click() };

    dlg.showModal();
  });
}
