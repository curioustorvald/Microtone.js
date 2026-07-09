// Microtone.js application shell (M6): document open/save (OPFS + import/
// export), editing dispatch (record mode, jam keyboard, undo/redo), Timeline
// + Cues + Files views. Samples/Instruments/Project views come with M7.

import { parseTaud } from "../format/taud-parse.js";
import { Document } from "../doc/document.js";
import { DocSync } from "../doc/sync.js";
import { UndoStack } from "../doc/undo.js";
import { AudioSystem } from "../audio/audio-system.js";
import { Store } from "./store.js";
import { TimelineView } from "./views/timeline.js";
import { CuesView } from "./views/cues.js";
import { FilesView } from "./views/files.js";
import { JamKeyboard } from "./jam.js";
import { SUB_NOTE } from "./edit.js";
import { hex2 } from "./notenames.js";

const $ = (id) => document.getElementById(id);
const store = new Store();
store.record = true;
store.editStep = 1;
let audioInitPromise = null;

// ── audio bring-up (lazy, single-flight; owns DocSync creation) ──
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
async function loadBytes(name, bytes) {
  if (store.doc?.dirty) {
    if (!confirm(`Discard unsaved changes to ${store.fileName ?? "the current project"}?`)) return;
  }
  let parsed;
  try {
    parsed = parseTaud(bytes);
  } catch (err) {
    $("stFile").textContent = `parse error: ${err.message}`;
    return;
  }
  if (parsed.kind !== "taud") {
    $("stFile").textContent = `.${parsed.kind} files need a project context (M8)`;
    return;
  }
  store.audio?.stop(0);
  store.doc = new Document(parsed);
  store.fileName = name;
  store.songIndex = 0;
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.undo = new UndoStack(store.doc, (dirty) => {
    store.sync?.onDirty(dirty);
    store.emit("edit", dirty);
    updateStatus();
  });
  store.sync = null; // (re)created by ensureAudio
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
    ? `${store.fileName ?? "untitled"} — ${doc.meta.projectName ?? "untitled"} · ${doc.songs.length} song(s) · ${doc.channelCount}ch`
    : "no file";
  $("stDirty").hidden = !doc?.dirty;
  $("octDisp").textContent = jam.octave;
  $("instDisp").textContent = hex2(jam.currentInst);
}
store.on("saved", updateStatus);

$("openBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) await loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) await loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
});
window.addEventListener("beforeunload", (e) => {
  if (store.doc?.dirty) e.preventDefault();
});

$("songSel").addEventListener("change", (e) => {
  store.songIndex = parseInt(e.target.value, 10);
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  if (store.audio) {
    store.audio.stop(0);
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
  }
  store.emit("doc");
});

// ── views ──
const jam = new JamKeyboard(store);
const timeline = new TimelineView(store, $("timeline"));
const cuesView = new CuesView(store, $("cuesCanvas"));
const filesView = new FilesView(store, $("filesHost"), {
  openBytes: (name, bytes) => loadBytes(name, bytes),
  currentDoc: () => ({ doc: store.doc, fileName: store.fileName }),
});

const PLACEHOLDER_TEXT = {
  pattern: "Pattern editor — M7",
  samples: "Samples view — M7",
  instruments: "Instrument editor — M7",
  project: "Project view — M7",
};

function showView(name) {
  store.view = name;
  for (const btn of $("tabs").children) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  $("timeline").hidden = name !== "timeline";
  $("cuesCanvas").hidden = name !== "cues";
  $("filesHost").hidden = name !== "files";
  const ph = $("placeholder");
  ph.hidden = !(name in PLACEHOLDER_TEXT) || !store.doc;
  if (!ph.hidden) ph.textContent = PLACEHOLDER_TEXT[name];
  if (name === "timeline") timeline.resize();
  if (name === "cues") cuesView.resize();
  if (name === "files") filesView.refresh();
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

function setRecord(on) {
  store.record = on;
  $("recBtn").classList.toggle("on", on);
  timeline.invalidate();
  cuesView.invalidate();
}
$("recBtn").addEventListener("click", () => setRecord(!store.record));

// ── keyboard dispatch ──
window.addEventListener("keydown", (e) => {
  if (!store.doc) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" ||
      e.target.closest?.("dialog")) return;

  // global chords
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
    e.preventDefault();
    if (e.shiftKey) store.undo.redo();
    else store.undo.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") {
    e.preventDefault();
    store.undo.redo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
    e.preventDefault();
    filesView.save();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.code) {
    case "Space": {
      e.preventDefault();
      if (store.audio?.isPlaying()) store.audio.stop(0);
      else if (e.shiftKey) playFrom(0, 0);
      else {
        const loc = timeline.locate(store.cursor.row);
        playFrom(loc ? loc.entry.cue : 0, loc ? loc.rowInCue : 0);
      }
      return;
    }
    case "Insert": setRecord(!store.record); return;
    case "BracketLeft": jam.octaveDelta(-1); updateStatus(); return;
    case "BracketRight": jam.octaveDelta(1); updateStatus(); return;
    case "F1": case "F2": case "F3": case "F4": case "F5": case "F6": case "F7": {
      e.preventDefault();
      const views = ["timeline", "cues", "pattern", "samples", "instruments", "project", "files"];
      showView(views[parseInt(e.code.slice(1), 10) - 1]);
      return;
    }
  }

  if (store.view === "cues") {
    if (cuesView.processKey(e)) { e.preventDefault(); return; }
    return;
  }

  if (store.view === "timeline") {
    switch (e.code) {
      case "ArrowUp": e.preventDefault(); timeline.moveCursor(-store.editStep || -1, 0); return;
      case "ArrowDown": e.preventDefault(); timeline.moveCursor(store.editStep || 1, 0); return;
      case "ArrowLeft": e.preventDefault(); timeline.moveSubCursor(-1); return;
      case "ArrowRight": e.preventDefault(); timeline.moveSubCursor(1); return;
      case "Tab":
        e.preventDefault();
        store.cursor.sub = SUB_NOTE;
        store.cursor.nib = 0;
        timeline.moveCursor(0, e.shiftKey ? -1 : 1);
        return;
      case "PageUp": e.preventDefault(); timeline.moveCursor(-16, 0); return;
      case "PageDown": e.preventDefault(); timeline.moveCursor(16, 0); return;
      case "Home": e.preventDefault(); timeline.moveCursor(-1e9, 0); return;
      case "End": e.preventDefault(); timeline.moveCursor(1e9, 0); return;
      case "Enter": { // pick up the cell's instrument as current
        e.preventDefault();
        const target = timeline.cursorCell();
        if (target && target.cell.instrment !== 0) {
          jam.currentInst = target.cell.instrment;
          updateStatus();
        }
        return;
      }
    }
    if (store.record && timeline.processEditKey(e, jam)) {
      e.preventDefault();
      updateStatus();
      return;
    }
    // jam-only fallback: piano keys audition without recording
    if (!store.record || store.cursor.sub === SUB_NOTE) {
      if (jam.down(e.code, e.repeat)) { e.preventDefault(); return; }
    }
  }
});

window.addEventListener("keyup", (e) => jam.up(e.code));

// ── ?load= bootstrap (demo links; also drives the headless smoke test) ──
const bootParams = new URLSearchParams(location.search);
if (bootParams.has("load")) {
  const url = bootParams.get("load");
  fetch(url).then(async (resp) => {
    await loadBytes(url.split("/").pop(), new Uint8Array(await resp.arrayBuffer()));
    console.info(`APP: loaded ${url} songs=${store.doc?.songs.length}`);
    if (bootParams.has("view")) showView(bootParams.get("view"));
    if (bootParams.has("autoplay")) {
      await playFrom(0, 0);
      setTimeout(() => {
        console.info(`APP: autoplay check playing=${store.audio?.isPlaying()} cue=${store.audio?.getCuePosition()} row=${store.audio?.getTrackerRow()}`);
      }, 2500);
    }
  }).catch((err) => console.error(`APP: load failed ${err.message}`));
}

// Expose internals for the headless editing smoke test (harmless in prod).
window.__microtone = { store, timeline, cuesView, jam, loadBytes };

// ── frame loop ──
function frame() {
  const audio = store.audio;
  if (audio && store.doc) {
    $("posCue").textContent = audio.getCuePosition();
    $("posRow").textContent = audio.getTrackerRow();
    $("posBpm").textContent = audio.getBPM() || "–";
    $("posSpd").textContent = audio.getTickRate() || "–";
  }
  if (store.view === "timeline") timeline.frame();
  if (store.view === "cues") cuesView.frame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
