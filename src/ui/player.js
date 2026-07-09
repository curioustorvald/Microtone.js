// Minimal Taud player (M4 artefact) — the browser twin of TSVM's playtaud.js:
// load a .taud, play/stop/seek by cue, live per-voice VU + pan meters from
// worklet snapshots.

import { parseTaud } from "../format/taud-parse.js";
import { AudioSystem } from "../audio/audio-system.js";

const $ = (id) => document.getElementById(id);

const audio = new AudioSystem();
let audioReady = false;
let doc = null;
let songIndex = 0;

async function ensureAudio() {
  if (!audioReady) {
    await audio.init();
    audioReady = true;
    if (audio.usedBundleFallback) console.info("worklet: using single-file bundle fallback");
  }
  await audio.resume();
  updateAudioBadge();
}

function updateAudioBadge() {
  const el = $("audioState");
  if (audio.running) {
    el.textContent = `audio on @ ${audio.context.sampleRate} Hz${audio.context.sampleRate !== 32000 ? " (resampled)" : ""}`;
    el.classList.add("on");
  }
}

// Resume-on-gesture: any key/pointer wakes the context.
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => { if (audioReady) ensureAudio(); });
}

async function loadFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    doc = parseTaud(bytes);
  } catch (err) {
    $("fileinfo").textContent = `parse error: ${err.message}`;
    return;
  }
  if (doc.kind !== "taud") {
    $("fileinfo").textContent = `.${doc.kind} loaded — only full .taud files are playable here`;
    return;
  }

  const sel = $("song");
  sel.innerHTML = "";
  doc.songs.forEach((song, i) => {
    const opt = document.createElement("option");
    const sm = doc.meta.songMeta[i];
    opt.value = i;
    opt.textContent = `${i}: ${sm?.name || "song " + i} (${song.patterns.length} pats, ${song.bpm} BPM)`;
    sel.appendChild(opt);
  });

  $("fileinfo").textContent =
    `${file.name} — ${doc.meta.projectName ?? "untitled"} · ${doc.songs.length} song(s) · ` +
    `format v${doc.fmtVer} · ${doc.is64Channel ? 64 : 32}ch` +
    (doc.ixmp.length ? ` · Ixmp on ${doc.ixmp.length} inst` : "");
  $("transport").hidden = false;

  await ensureAudio();
  songIndex = 0;
  audio.loadDocument(doc, songIndex);
}

$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("hover");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

$("song").addEventListener("change", async (e) => {
  songIndex = parseInt(e.target.value, 10);
  audio.stop(0);
  audio.loadDocument(doc, songIndex); // song switch re-uploads patterns/cues
});

$("play").addEventListener("click", async () => {
  await ensureAudio();
  audio.resetFunkState(0);
  audio.setCuePosition(0, 0);
  audio.setTrackerRow(0, 0);
  audio.play(0);
});
$("stopBtn").addEventListener("click", () => audio.stop(0));
$("prevCue").addEventListener("click", () => {
  audio.setCuePosition(0, Math.max(0, audio.getCuePosition() - 1));
  audio.setTrackerRow(0, 0);
});
$("nextCue").addEventListener("click", () => {
  audio.setCuePosition(0, audio.getCuePosition() + 1);
  audio.setTrackerRow(0, 0);
});
$("vol").addEventListener("input", (e) => audio.setMasterVolume(0, parseInt(e.target.value, 10)));

// ── meters ──
const canvas = $("meters");
const ctx = canvas.getContext("2d");
const css = getComputedStyle(document.documentElement);
const COL = {
  bg: css.getPropertyValue("--panel").trim(),
  bar: css.getPropertyValue("--meter").trim(),
  barBg: css.getPropertyValue("--meter-bg").trim(),
  pan: css.getPropertyValue("--accent-2").trim(),
  text: css.getPropertyValue("--dim").trim(),
  accent: css.getPropertyValue("--accent").trim(),
};
// Peak-hold state per voice.
const peaks = new Float32Array(64);

function drawMeters() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  const chans = audio.channelCount();
  const colW = W / chans;
  const barW = Math.max(2, colW - 4);
  const meterH = H - 40;

  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  for (let vi = 0; vi < chans; vi++) {
    const x = vi * colW + 2;
    // VU bar
    ctx.fillStyle = COL.barBg;
    ctx.fillRect(x, 10, barW, meterH);
    const vol = audio.getVoiceActive(vi) ? audio.getVoiceEffectiveVolume(vi) : 0;
    peaks[vi] = Math.max(peaks[vi] * 0.94, vol);
    const h = Math.round(vol * meterH);
    ctx.fillStyle = COL.bar;
    ctx.fillRect(x, 10 + meterH - h, barW, h);
    const ph = Math.round(peaks[vi] * meterH);
    if (ph > 0) {
      ctx.fillStyle = COL.accent;
      ctx.fillRect(x, 10 + meterH - ph - 1, barW, 2);
    }
    // pan tick
    const pan = audio.getVoiceEffectivePan(vi) / 255;
    ctx.fillStyle = COL.pan;
    ctx.fillRect(x + pan * (barW - 3), H - 24, 3, 8);
    // channel number
    ctx.fillStyle = COL.text;
    ctx.fillText(String(vi + 1), x + barW / 2, H - 4);
  }

  $("cue").textContent = audio.getCuePosition();
  $("rowIdx").textContent = audio.getTrackerRow();
  $("bpm").textContent = audio.getBPM() || "—";
  $("speed").textContent = audio.getTickRate() || "—";
  requestAnimationFrame(drawMeters);
}
requestAnimationFrame(drawMeters);
