// Microtone.js application shell (M5): open/parse a document, wire the
// AudioSystem + DocSync + UndoStack, host the Timeline view, transport +
// keyboard dispatch. Other tabs are placeholders until M6/M7.

import { parseTaud } from "../format/taud-parse.js";
import { Document } from "../doc/document.js";
import { DocSync } from "../doc/sync.js";
import { UndoStack } from "../doc/undo.js";
import { AudioSystem } from "../audio/audio-system.js";
import { Store } from "./store.js";
import { TimelineView } from "./views/timeline.js";

const $ = (id) => document.getElementById(id);
const store = new Store();
let audioInitPromise = null;

// ── audio bring-up (lazy, single-flight; resumed on first gesture). Owns the
// DocSync creation so every "audio is ready" path pushes the document once. ──
async function ensureAudio() {
  if (!audioInitPromise) {
    audioInitPromise = (async () => {
      const audio = new AudioSystem();
      await audio.init();
      store.audio = audio;
    })();
  }
  await audioInitPromise;
  await store.audio.resume();
  if (store.doc && !store.sync) {
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
  }
  const badge = $("audioBadge");
  if (store.audio.running) {
    badge.textContent = `audio @ ${store.audio.context.sampleRate} Hz`;
    badge.classList.add("on");
  }
}
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => { if (audioInitPromise) ensureAudio(); }, { capture: true });
}

// ── document loading ──
async function loadFile(file) {
  let parsed;
  try {
    parsed = parseTaud(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    $("stFile").textContent = `parse error: ${err.message}`;
    return;
  }
  if (parsed.kind !== "taud") {
    $("stFile").textContent = `.${parsed.kind} files need a project context (M8)`;
    return;
  }
  store.doc = new Document(parsed);
  store.fileName = file.name;
  store.songIndex = 0;
  store.cursor = { row: 0, ch: 0 };
  store.undo = new UndoStack(store.doc, (dirty) => {
    store.sync?.onDirty(dirty);
    store.emit("edit", dirty);
    updateStatus();
  });
  store.sync = null; // (re)created by ensureAudio once the worklet is up
  if (store.audio) {
    store.sync = new DocSync(store.audio, store.doc, 0);
    store.sync.loadAll();
  }

  const sel = $("songSel");
  sel.innerHTML = "";
  store.doc.songs.forEach((song, i) => {
    const opt = document.createElement("option");
    const sm = store.doc.meta.songMeta[i];
    opt.value = i;
    opt.textContent = sm?.name ? `${i}: ${sm.name}` : `song ${i}`;
    sel.appendChild(opt);
  });

  $("emptyState").hidden = true;
  showView("timeline");
  updateStatus();
  store.emit("doc");
}

function updateStatus() {
  const doc = store.doc;
  $("stFile").textContent = doc
    ? `${store.fileName} — ${doc.meta.projectName ?? "untitled"} · ${doc.songs.length} song(s) · ${doc.channelCount}ch`
    : "no file";
  $("stDirty").hidden = !doc?.dirty;
}

$("openBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

$("songSel").addEventListener("change", async (e) => {
  store.songIndex = parseInt(e.target.value, 10);
  store.cursor = { row: 0, ch: 0 };
  if (store.audio) {
    store.audio.stop(0);
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
  }
  store.emit("doc");
});

// ── views ──
const timeline = new TimelineView(store, $("timeline"));
const PLACEHOLDER_TEXT = {
  cues: "Cues view — M6",
  pattern: "Pattern editor — M6",
  samples: "Samples view — M7",
  instruments: "Instrument editor — M7",
  project: "Project view — M7",
  files: "File browser (OPFS) — M6",
};

function showView(name) {
  store.view = name;
  for (const btn of $("tabs").children) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  $("timeline").hidden = name !== "timeline";
  const ph = $("placeholder");
  ph.hidden = name === "timeline" || !store.doc;
  if (!ph.hidden) ph.textContent = PLACEHOLDER_TEXT[name] ?? name;
  if (name === "timeline") timeline.resize();
  store.emit("view");
}
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (btn && store.doc) showView(btn.dataset.view);
});

// ── transport ──
async function playFrom(cue, row) {
  if (!store.doc) return;
  await ensureAudio(); // guarantees store.sync exists for the loaded doc
  store.sync.flushPatterns();
  store.audio.resetFunkState(0);
  store.audio.setCuePosition(0, cue);
  store.audio.setTrackerRow(0, row);
  store.audio.play(0);
}

$("playSong").addEventListener("click", () => playFrom(0, 0));
$("playCue").addEventListener("click", () => {
  const loc = timeline.locate(store.cursor.row);
  playFrom(loc ? loc.entry.cue : 0, 0);
});
$("stopBtn").addEventListener("click", () => store.audio?.stop(0));
$("follow").addEventListener("change", (e) => { store.follow = e.target.checked; });

// ── keyboard ──
window.addEventListener("keydown", (e) => {
  if (!store.doc) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  switch (e.code) {
    case "Space":
      e.preventDefault();
      if (store.audio?.isPlaying()) store.audio.stop(0);
      else if (e.shiftKey) playFrom(0, 0);
      else {
        const loc = timeline.locate(store.cursor.row);
        playFrom(loc ? loc.entry.cue : 0, loc ? loc.rowInCue : 0);
      }
      break;
    case "ArrowUp": e.preventDefault(); timeline.moveCursor(-1, 0); break;
    case "ArrowDown": e.preventDefault(); timeline.moveCursor(1, 0); break;
    case "ArrowLeft": e.preventDefault(); timeline.moveCursor(0, -1); break;
    case "ArrowRight": e.preventDefault(); timeline.moveCursor(0, 1); break;
    case "PageUp": e.preventDefault(); timeline.moveCursor(-16, 0); break;
    case "PageDown": e.preventDefault(); timeline.moveCursor(16, 0); break;
    case "Home": e.preventDefault(); timeline.moveCursor(-1e9, 0); break;
    case "End": e.preventDefault(); timeline.moveCursor(1e9, 0); break;
    case "F1": case "F2": case "F3": case "F4": case "F5": case "F6": case "F7": {
      e.preventDefault();
      const views = ["timeline", "cues", "pattern", "samples", "instruments", "project", "files"];
      showView(views[parseInt(e.code.slice(1), 10) - 1]);
      break;
    }
  }
});

// ── ?load= bootstrap (demo links; also drives the headless smoke test) ──
const bootParams = new URLSearchParams(location.search);
if (bootParams.has("load")) {
  const url = bootParams.get("load");
  fetch(url).then(async (resp) => {
    const buf = await resp.arrayBuffer();
    await loadFile({ name: url.split("/").pop(), arrayBuffer: async () => buf });
    console.info(`APP: loaded ${url} songs=${store.doc?.songs.length}`);
    if (bootParams.has("autoplay")) {
      await playFrom(0, 0);
      setTimeout(() => {
        console.info(`APP: autoplay check playing=${store.audio?.isPlaying()} cue=${store.audio?.getCuePosition()} row=${store.audio?.getTrackerRow()}`);
      }, 2500);
    }
  }).catch((err) => console.error(`APP: load failed ${err.message}`));
}

// ── frame loop: position display + timeline follow/repaint ──
function frame() {
  const audio = store.audio;
  if (audio && store.doc) {
    $("posCue").textContent = audio.getCuePosition();
    $("posRow").textContent = audio.getTrackerRow();
    $("posBpm").textContent = audio.getBPM() || "–";
    $("posSpd").textContent = audio.getTickRate() || "–";
  }
  if (store.view === "timeline") timeline.frame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
