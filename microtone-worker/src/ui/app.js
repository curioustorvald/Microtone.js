// Microtone.js application shell (M6): document open/save (OPFS + import/
// export), editing dispatch (record mode, jam keyboard, undo/redo), Timeline
// + Cues + Files views. Samples/Instruments/Project views come with M7.

import { parseTaud } from "../format/taud-parse.js";
import { Document, combineTpif } from "../doc/document.js";
import { DocSync } from "../doc/sync.js";
import { UndoStack } from "../doc/undo.js";
import { AudioSystem } from "../audio/audio-system.js";
import { createProfileOverlay } from "./profileoverlay.js";
import { Store } from "./store.js";
import { TimelineView } from "./views/timeline.js";
import { CuesView } from "./views/cues.js";
import { PatternView } from "./views/pattern.js";
import { FilesView } from "./views/files.js";
import { SamplesView } from "./views/samples.js";
import { InstrumentsView } from "./views/instruments.js";
import { ProjectView } from "./views/project.js";
import { JamKeyboard } from "./jam.js";
import { InstLookup } from "./instlookup.js";
import { SUB_NOTE } from "./edit.js";
import { CommandPalette } from "./palette.js";
import { setCellOp } from "../doc/ops.js";
import { hex2 } from "./notenames.js";
import { showHelp } from "./popups/help.js";
import { showAbout } from "./popups/about.js";
import { showNewProject } from "./popups/newproject.js";
import { showModal } from "./widgets/modal.js";
import * as opfs from "../storage/opfs.js";
import { pickFile } from "../storage/import-export.js";
import { convertToTaud, converterFor, CONVERT_ACCEPT } from "../convert/convert.js";
import { showImportProgress } from "./popups/importlog.js";
import { getSoundfont, getBundledSoundfont, pickUserSoundfont } from "./soundfont.js";
import { presetForNotation } from "./pitchtables.js";
import { initTheme, toggleTheme, onThemeChange } from "./theme.js";
import { initI18n, applyDom, t, LANGS, changeLang, onLangChange, currentLang } from "./i18n.js";
import { unescapeName } from "./names.js";
import { loadCanvasFonts, refreshCanvasFont } from "./fonts.js";

initTheme(); // before any canvas paints (saved choice ?? OS preference)
await initI18n(); // strings before any UI is built
applyDom(); // translate the static index.html chrome
{
  // ?theme=dark|light overrides for this load (and persists like the toggle)
  const t = new URLSearchParams(location.search).get("theme");
  if (t === "dark" || t === "light") {
    const { applyTheme } = await import("./theme.js");
    applyTheme(t);
  }
}

const $ = (id) => document.getElementById(id);
const store = new Store();
store.record = true;
store.editStep = 1;
let audioInitPromise = null;

// ?profile=1 attaches the dev audio profiler (worklet timing + on-screen
// overlay). Off by default → zero overhead in production.
const PROFILE = new URLSearchParams(location.search).has("profile");
let profileOverlay = null;

// ── audio bring-up (single-flight; owns DocSync creation) ──
// The worklet is warmed up eagerly on load (resume:false → suspended context,
// no sound, no autoplay-policy violation) so store.audio + DocSync exist before
// the first gesture; the first pointer/key then resume()s it (resume:true).
// That is what lets note jamming work without first pressing Play (item 26).
async function ensureAudio({ resume = true } = {}) {
  if (!audioInitPromise) {
    audioInitPromise = (async () => {
      const audio = new AudioSystem();
      await audio.init({ profile: PROFILE });
      if (PROFILE) {
        profileOverlay = createProfileOverlay();
        document.body.appendChild(profileOverlay.el);
        audio.onProfile = (p) => profileOverlay.update(p);
      }
      store.audio = audio;
    })();
  }
  await audioInitPromise;
  if (resume) await store.audio.resume();
  if (store.doc && !store.sync) {
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
    // mutes toggled before the first audio gesture only exist in the store
    store.voiceMutes.forEach((m, ch) => { if (m) store.audio.setVoiceMute(0, ch, true); });
  }
  const badge = $("audioBadge");
  if (store.audio.running) {
    badge.textContent = `audio @ ${store.audio.context.sampleRate} Hz`;
    badge.classList.add("on");
  }
}
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => ensureAudio(), { capture: true });
}
// Warm up the engine now (suspended) so jamming is ready pre-Play. Fire-and-
// forget: a headless/virtual-time boot where addModule never settles just
// leaves audio uninitialised, which the rest of the app already tolerates.
ensureAudio({ resume: false }).catch((e) => console.warn("APP: eager audio warmup failed", e));

// ── import conversion (tracker/MIDI → .taud via the vendored Python converters) ──

async function convertImport(name, bytes, sf2Override = null) {
  let sf2 = sf2Override;
  if (!sf2 && converterFor(name).isMidi) {
    $("stFile").textContent = t("midi.needSf");
    sf2 = await getSoundfont();
    if (!sf2) { $("stFile").textContent = t("midi.cancelled"); return null; }
  }
  const progress = showImportProgress(`Importing ${name}`);
  try {
    const out = await convertToTaud(name, bytes, { sf2, onStatus: progress.log });
    progress.done();
    return out;
  } catch (err) {
    const last = err.message.trim().split("\n").pop();
    progress.fail(last);
    $("stFile").textContent = t("status.importFailed", { name, err: last });
    console.error("import failed:", err);
    return null;
  }
}

// ── document loading ──
async function loadBytes(name, bytes, { sf2 = null, saveToOpfs = false } = {}) {
  let converted = false;
  if (converterFor(name)) {
    bytes = await convertImport(name, bytes, sf2);
    if (bytes === null) return;
    name = name.replace(/\.[^.]+$/, "") + ".taud";
    converted = true;
  }

  let parsed;
  try {
    parsed = parseTaud(bytes);
  } catch (err) {
    $("stFile").textContent = t("status.parseError", { err: err.message });
    return;
  }

  // .tsii = a sample+instrument bank. Into a loaded project it REPLACES the
  // instrument domain (the taud.mjs "load the companion .tsii first" flow);
  // standalone it seeds a new project.
  if (parsed.kind === "tsii") {
    if (store.doc) {
      if (!confirm(t("confirm.replaceBank", { name }))) return;
      store.audio?.stop(0);
      store.doc.sampleInstImage = parsed.sampleInstImage;
      store.doc.ixmp = parsed.ixmp.map((e) => ({ instId: e.instId, count: e.count, blob: Uint8Array.from(e.blob) }));
      store.doc._instruments = null; // re-decode from the new image
      store.doc._instrumentsEdited = false;
      // Carry the bank's name tables + Ixmp sections over; keep song sections.
      store.doc.projSections = store.doc.projSections.filter(
        (s) => !["INam", "SNam", "Ixmp"].includes(s.fourcc));
      for (const s of parsed.projSections) {
        if (["INam", "SNam", "Ixmp"].includes(s.fourcc)) {
          store.doc.projSections.push({ fourcc: s.fourcc, payload: Uint8Array.from(s.payload) });
        }
      }
      store.doc.dirty = true;
      store.sync?.loadAll();
      store.emit("doc");
      updateStatus();
    } else {
      await newProject({ fromBank: parsed, bankName: name });
    }
    return;
  }
  // .tpif = one song's patterns over a resident bank (taud.mjs:173). Combine
  // it with the current project's bank when one is loaded, else prompt for
  // the companion .tsii; the result is a full (unsaved) .taud document.
  if (parsed.kind === "tpif") {
    let bank;
    if (store.doc?.sampleInstImage) {
      store.doc._rebuildInstRegion(); // decoded inst edits are canonical
      bank = store.doc;
    } else {
      $("stFile").textContent = t("status.tpifNeedsBank", { name });
      const bankFile = await pickFile(".tsii,.taud");
      if (!bankFile) return;
      try {
        bank = parseTaud(new Uint8Array(await bankFile.arrayBuffer()));
      } catch (err) {
        $("stFile").textContent = t("status.parseErrorIn", { name: bankFile.name, err: err.message });
        return;
      }
      if (!bank.sampleInstImage) {
        $("stFile").textContent = t("status.noBankIn", { name: bankFile.name });
        return;
      }
    }
    parsed = combineTpif(bank, parsed);
    name = name.replace(/\.[^.]+$/, "") + ".taud";
    converted = true; // synthesised container — load it unsaved
  }

  if (store.doc?.dirty) {
    if (!confirm(t("confirm.discardNamed", { name: store.fileName ?? t("common.currentProject") }))) return;
  }
  store.audio?.stop(0);
  store.doc = new Document(parsed);
  store.clearMutes(); // per-song UI state (taut finishLoadCommon)
  store.fileName = name;
  store.songIndex = 0;
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.pitchPreset = presetForNotation(store.doc.meta.songMeta[0]?.notation ?? 120);
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

  rebuildSongList();

  $("emptyState").hidden = true;
  showView("timeline");
  if (converted) store.doc.dirty = true; // imported, not yet saved anywhere
  if (converted && saveToOpfs && (await opfs.available())) {
    // Files-tab MIDI import: the CONVERSION RESULT lands in OPFS right away.
    await opfs.write(name, store.doc.toBytes());
    store.doc.dirty = false;
    store.emit("saved", name);
  }
  updateStatus();
  store.emit("doc");
}

function updateStatus() {
  const doc = store.doc;
  $("stFile").textContent = doc
    ? `${store.fileName ?? "untitled"} — ${unescapeName(doc.meta.projectName ?? "untitled")} · ${doc.songs.length} ${doc.songs.length === 1 ? "song" : "songs"} · ${doc.channelCount}ch`
    : t("status.noFile");
  $("stDirty").hidden = !doc?.dirty;
  $("octDisp").textContent = jam.octave;
  $("instDisp").textContent = hex2(jam.currentInst);
  updateUndoUI();
}

function updateUndoUI() {
  const u = store.undo;
  const canU = !!u?.canUndo();
  const canR = !!u?.canRedo();
  $("undoBtn").disabled = !canU;
  $("redoBtn").disabled = !canR;
  const nU = u?.undoStack.length ?? 0;
  const nR = u?.redoStack.length ?? 0;
  $("undoStat").textContent = nU || nR ? `${nU}/${nR}` : "";
  $("undoStat").title = `${nU} undo · ${nR} redo`;
}
store.on("saved", updateStatus);
store.on("edit", updateUndoUI);
store.on("status", updateStatus); // e.g. project rename

/** New Project wizard — optionally seeded from a .tsii instrument bank. */
async function newProject({ fromBank = null, bankName = null } = {}) {
  const result = await showNewProject({ fromBank, bankName });
  if (!result) return;
  if (store.doc?.dirty) {
    if (!confirm(t("confirm.discard"))) return;
  }
  const is64 = result.channels === 64;
  const chans = is64 ? 64 : 32;
  const projName = result.name || "untitled";

  // Empty pattern: vol/pan bytes 0xC0 (SEL_FINE-0 no-op — converter convention).
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  // Cue 0: one private pattern per channel (pattern n on channel n).
  const cue0 = new Uint16Array(64).fill(0x7fff);
  const patterns = [];
  for (let ch = 0; ch < chans; ch++) {
    cue0[ch] = ch;
    patterns.push(Uint8Array.from(emptyPat));
  }

  const enc = new TextEncoder();
  const projSections = [];
  if (is64) {
    const xhdr = new Uint8Array(256);
    xhdr[0] = 0x01;
    projSections.push({ fourcc: "xHDR", payload: xhdr });
  }
  if (fromBank) {
    for (const s of fromBank.projSections) {
      if (["INam", "SNam", "Ixmp"].includes(s.fourcc)) {
        projSections.push({ fourcc: s.fourcc, payload: Uint8Array.from(s.payload) });
      }
    }
  }
  projSections.push({ fourcc: "PNam", payload: Uint8Array.from([...enc.encode(projName), 0]) });

  const parsedShape = {
    kind: "taud",
    fmtVer: 2,
    is64Channel: is64,
    signature: "Microtone.js  ",
    sampleInstImage: fromBank ? fromBank.sampleInstImage : new Uint8Array(8650752),
    songs: [{
      numVoices: chans,
      numPats: patterns.length,
      bpm: result.bpm,
      tickRate: result.tickRate,
      tuningBaseNote: result.baseNote,
      tuningFreq: result.baseFreq,
      globalFlags: 0,
      globalVolume: 0x80,
      mixingVolume: 0x80,
      numCuesStored: 1,
      patterns,
      cues: [cue0],
    }],
    projSections,
    ixmp: fromBank ? fromBank.ixmp : [],
    meta: {
      projectName: projName,
      songMeta: { 0: {
        notation: result.notation, beatPri: result.beatPri, beatSec: result.beatSec,
        name: projName, composer: result.composer || "", copyright: result.copyright || "",
      } },
    },
  };
  store.audio?.stop(0);
  store.doc = new Document(parsedShape);
  store.doc.smetEdited = true; // bake the fresh sMet on first save
  store.doc.dirty = true;
  store.fileName = null;
  store.songIndex = 0;
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.pitchPreset = presetForNotation(result.notation);
  store.undo = new UndoStack(store.doc, (dirty) => {
    store.sync?.onDirty(dirty);
    store.emit("edit", dirty);
    updateStatus();
  });
  store.sync = null;
  if (store.audio) {
    store.sync = new DocSync(store.audio, store.doc, 0);
    store.sync.loadAll();
  }
  const sel = $("songSel");
  sel.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = 0;
  opt.textContent = `0: ${projName}`;
  sel.appendChild(opt);
  $("emptyState").hidden = true;
  showView("timeline");
  updateStatus();
  store.emit("doc");
}

$("newBtn").addEventListener("click", () => newProject());
// Open takes native containers + tracker files; MIDI goes through the
// dedicated Import MIDI… button (explicit soundfont choice). Drag-drop and
// ?load= still accept .mid via the automatic bundled-else-picker path.
const OPEN_ACCEPT = ".taud,.tsii,.tpif," +
  CONVERT_ACCEPT.split(",").filter((e) => !e.startsWith(".mid")).join(",");
$("fileInput").accept = OPEN_ACCEPT;
$("openBtn").addEventListener("click", () => $("fileInput").click());

/** Pick a .mid + soundfont, convert, load. `toOpfs` (Files-tab button) also
 *  persists the conversion result into OPFS. */
async function importMidiInteractive({ toOpfs = false } = {}) {
  const file = await pickFile(".mid,.midi");
  if (!file) return;
  const bundledAvail = (await getBundledSoundfont()) !== null;
  const choice = await showModal({
    title: t("midi.title", { name: file.name }),
    body: t("midi.body"),
    fields: [{
      name: "sf", label: t("midi.soundfont"), type: "select",
      value: bundledAvail ? "bundled" : "own",
      options: [
        ...(bundledAvail ? [{ value: "bundled", label: t("midi.bundled") }] : []),
        { value: "own", label: t("midi.chooseSf2") },
      ],
    }],
    okLabel: t("common.import"),
  });
  if (!choice) return;
  const sf2 = choice.sf === "bundled" ? await getBundledSoundfont() : await pickUserSoundfont();
  if (!sf2) { $("stFile").textContent = t("midi.cancelled"); return; }
  await loadBytes(file.name, new Uint8Array(await file.arrayBuffer()), { sf2, saveToOpfs: toOpfs });
}
$("importMidiBtn").addEventListener("click", () => importMidiInteractive());
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

function rebuildSongList() {
  const sel = $("songSel");
  sel.innerHTML = "";
  store.doc.songs.forEach((song, i) => {
    const opt = document.createElement("option");
    const sm = store.doc.meta.songMeta[i];
    opt.value = i;
    opt.textContent = sm?.name ? `${i}: ${unescapeName(sm.name)}` : `song ${i}`;
    sel.appendChild(opt);
  });
  sel.value = store.songIndex;
}

function selectSong(index) {
  store.songIndex = Math.min(Math.max(index, 0), store.doc.songs.length - 1);
  $("songSel").value = store.songIndex;
  store.clearMutes(); // per-song state (taut finishLoadCommon)
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.pitchPreset = presetForNotation(store.doc.meta.songMeta[store.songIndex]?.notation ?? 120);
  if (store.audio) {
    store.audio.stop(0);
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
  }
  store.emit("doc");
  updateStatus();
}

$("songSel").addEventListener("change", (e) => selectSong(parseInt(e.target.value, 10)));

// Rename song `index` — offered per-row on the File tab's song list (the
// write goes through ProjectView.changeName so there is one code path). The
// input shows the DECODED name; changeName re-escapes on save.
async function renameSongInteractive(index) {
  if (!store.doc) return;
  const sm = store.doc.meta.songMeta[index];
  const result = await showModal({
    title: t("song.renameTitle", { n: index }),
    fields: [{ name: "name", label: t("files.name"), value: unescapeName(sm?.name ?? "") }],
    okLabel: t("common.rename"),
  });
  if (result === null) return;
  projectView.changeName(result.name, index);
  rebuildSongList();
  updateStatus();
}

// Project view add/remove-song: rebuild the picker + switch to the target song.
store.on("songs", (payload) => {
  rebuildSongList();
  selectSong(payload?.select ?? store.songIndex);
});
store.on("doc", updateStatus); // keep the dirty dot in sync on doc-level edits

// ── views ──
const jam = new JamKeyboard(store);
const timeline = new TimelineView(store, $("timeline"));
const cuesView = new CuesView(store, $("cuesCanvas"));
const patternView = new PatternView(store, $("patternHost"), jam);
window.__microtoneEnsureAudio = ensureAudio; // pattern preview needs lazy audio
const samplesView = new SamplesView(store, $("samplesHost"), {
  // New instrument from a pooled sample (item 40): adopt it + jump to it.
  onNewInstrument: (slot) => {
    jam.currentInst = slot;
    instrumentsView.selected = slot;
    store.emit("instsel");
    showView("instruments");
    updateStatus();
  },
});
const instrumentsView = new InstrumentsView(store, $("instrumentsHost"), jam);
const projectView = new ProjectView(store, $("projectHost"), {
  renameSong: (i) => renameSongInteractive(i),
});
const instLookup = new InstLookup(store, jam, $("instLookup"), () => updateStatus());
const filesView = new FilesView(store, $("filesHost"), {
  openBytes: (name, bytes) => loadBytes(name, bytes),
  currentDoc: () => ({ doc: store.doc, fileName: store.fileName }),
  songIndex: () => store.songIndex,
  importMidi: () => importMidiInteractive({ toOpfs: true }),
  renameSong: (i) => renameSongInteractive(i),
});

function showView(name) {
  store.view = name;
  for (const btn of $("tabs").children) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  $("emptyState").hidden = !!store.doc || name === "files";
  $("toolbox").hidden = !(name === "timeline" || name === "pattern") || !store.doc;
  $("timeline").hidden = name !== "timeline";
  $("cuesCanvas").hidden = name !== "cues";
  $("patternHost").hidden = name !== "pattern";
  $("samplesHost").hidden = name !== "samples";
  $("instrumentsHost").hidden = name !== "instruments";
  $("projectHost").hidden = name !== "project";
  $("filesHost").hidden = name !== "files";
  $("placeholder").hidden = true;
  if (name === "timeline") timeline.resize();
  if (name === "cues") cuesView.resize();
  name === "pattern" ? patternView.show() : patternView.hide();
  name === "samples" ? samplesView.show() : samplesView.hide();
  name === "instruments" ? instrumentsView.show() : instrumentsView.hide();
  name === "project" ? projectView.show() : projectView.hide();
  if (name === "files") filesView.refresh();
  store.emit("view");
}
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  // The File tab works without a document (browse OPFS, import something);
  // every other view needs one.
  if (btn && (store.doc || btn.dataset.view === "files")) showView(btn.dataset.view);
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

/** Where a "play from cue"/"play from cursor" starts, honouring the active
 *  view. The Cues view drives its OWN row cursor (item 39) — the Timeline
 *  cursor doesn't move while you navigate cues, so playing from the Timeline
 *  cursor there ignored the selected cue. Every other view maps the Timeline
 *  cursor's absolute row to its cue/row. Clamped to the materialised cue list. */
function playCursor() {
  if (store.view === "cues") {
    const nCues = store.song?.cues.length ?? 0;
    const cue = Math.min(Math.max(cuesView.cursor.cue, 0), Math.max(nCues - 1, 0));
    return { cue, row: 0 };
  }
  const loc = timeline.locate(store.cursor.row);
  return { cue: loc ? loc.entry.cue : 0, row: loc ? loc.rowInCue : 0 };
}

$("playSong").addEventListener("click", () => playFrom(0, 0));
$("playCue").addEventListener("click", () => playFrom(playCursor().cue, 0));
$("stopBtn").addEventListener("click", () => store.audio?.stop(0));
$("follow").addEventListener("change", (e) => { store.follow = e.target.checked; });

function setRecord(on) {
  store.record = on;
  $("recBtn").classList.toggle("on", on);
  timeline.invalidate();
  cuesView.invalidate();
  patternView.invalidate();
}
$("recBtn").addEventListener("click", () => setRecord(!store.record));
$("undoBtn").addEventListener("click", () => store.undo?.undo());
$("redoBtn").addEventListener("click", () => store.undo?.redo());

// ── About (brand click) ──
$("brandBtn").addEventListener("click", () => showAbout());

// ── reload (refresh the page back to the initial state) ──
$("reloadBtn").addEventListener("click", () => {
  if (store.doc?.dirty && !confirm(t("confirm.discard"))) return;
  location.reload();
});

// ── on-screen help (mirrors the '?' key; works regardless of view/doc) ──
$("helpBtn").addEventListener("click", () => showHelp());

// ── language picker (applied live — no reload; item 29) ──
$("langBtn").textContent = currentLang().toUpperCase();
$("langBtn").addEventListener("click", async () => {
  const result = await showModal({
    title: t("lang.title"),
    body: t("lang.body"),
    fields: [{
      name: "lang", label: t("lang.field"), type: "select", value: currentLang(),
      options: Object.entries(LANGS).map(([value, label]) => ({ value, label })),
    }],
    okLabel: t("common.ok"),
  });
  if (!result || result.lang === currentLang()) return;
  await changeLang(result.lang); // swaps strings + applyDom + fires onLangChange
});
// Re-apply the imperatively-set (non data-i18n) labels + re-render dynamic views.
onLangChange(() => {
  $("langBtn").textContent = currentLang().toUpperCase();
  $("tbRaw").textContent = t(store.rawNoteView ? "toolbox.rawOn" : "toolbox.rawOff");
  patternView.buildBar();
  palette.refresh();
  instLookup.render();
  if (store.doc) rebuildSongList();
  if (store.view === "samples") samplesView.refresh();
  if (store.view === "instruments") instrumentsView.refresh();
  if (store.view === "project") projectView.refresh();
  if (store.view === "files") filesView.refresh();
  updateStatus();
});

// ── theme toggle ──
$("themeBtn").addEventListener("click", () => toggleTheme());
onThemeChange(() => {
  // repaint every canvas + refresh DOM views that cache colours implicitly
  refreshCanvasFont(); // --cv-font could be themed too
  timeline.invalidate();
  cuesView.invalidate();
  patternView.invalidate();
  if (store.view === "samples") samplesView.refresh();
  if (store.view === "instruments") instrumentsView.renderPanel();
});

// ── canvas grid webfont (--cv-font) ──
// Canvas text never triggers a webfont download on its own; force-load the
// faces at the sizes the grids draw (12px timeline/cues, 13px patterns) and
// repaint once the real font is in (early paints show the fallback stack).
loadCanvasFonts([13, 14], () => {
  timeline.invalidate();
  cuesView.invalidate();
  patternView.invalidate();
});

// ── toolbox (Timeline / Patterns) ──
$("tbRetune").addEventListener("click", () => projectView.openRetune());
store.rawNoteView = false;
$("tbRaw").textContent = t("toolbox.rawOff");
$("tbRaw").addEventListener("click", () => {
  store.rawNoteView = !store.rawNoteView;
  $("tbRaw").textContent = t(store.rawNoteView ? "toolbox.rawOn" : "toolbox.rawOff");
  $("tbRaw").classList.toggle("active", store.rawNoteView);
  timeline.invalidate();
  patternView.invalidate();
});
// Quick instrument lookup toggle (persists per session).
$("tbInstList").classList.toggle("active", instLookup.visible);
$("tbInstList").addEventListener("click", () => {
  $("tbInstList").classList.toggle("active", instLookup.toggle());
});

// ── wheelable topbar controls (hover + wheel) ──
function onWheelCtl(id, fn) {
  $(id).addEventListener("wheel", (e) => {
    e.preventDefault();
    const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    fn(d < 0 ? 1 : -1);
  }, { passive: false });
}
onWheelCtl("octCtl", (dir) => { jam.octaveDelta(dir); updateStatus(); });
onWheelCtl("instCtl", (dir) => {
  if (!store.doc) return;
  // step through the USED instrument slots (wrap-free clamp at the ends)
  const slots = store.doc.usedInstrumentSlots();
  if (slots.length === 0) return;
  let i = slots.indexOf(jam.currentInst);
  if (i < 0) i = 0;
  else i = Math.min(Math.max(i + dir, 0), slots.length - 1);
  jam.currentInst = slots[i];
  updateStatus();
  store.emit("instsel");
});
onWheelCtl("spdCtl", (dir) => {
  // live playback speed tweak (device only — the A effect can still override)
  const audio = store.audio;
  if (!audio) return;
  const cur = audio.getTickRate() || store.song?.tickRate || 6;
  audio.setTickRate(0, Math.min(Math.max(cur + dir, 1), 127));
});

// ── contextual command palette (screen bottom) ──
function editContext() {
  if (!store.doc || !store.record) return null;
  if (store.view === "timeline") {
    const target = timeline.cursorCell();
    if (!target) return null;
    return {
      sub: store.cursor.sub,
      cell: target.cell,
      apply: (fields) => store.undo.apply(
        setCellOp(store.songIndex, target.pat, target.rowInCue, fields)),
    };
  }
  if (store.view === "pattern") {
    const pattern = patternView.pattern();
    if (!pattern) return null;
    const row = patternView.cursor.row;
    return {
      sub: patternView.cursor.sub,
      cell: pattern[row],
      apply: (fields) => store.undo.apply(
        setCellOp(store.songIndex, patternView.patIdx, row, fields)),
    };
  }
  return null;
}
const palette = new CommandPalette($("cmdPalette"), editContext);
for (const topic of ["cursor", "edit", "view", "doc"]) {
  store.on(topic, () => palette.refresh());
}

// The grid views that support block selection + clipboard (item 17; Cues added
// later — it keeps its own cue-word clipboard, store.cueClipboard).
function selView() {
  return store.view === "timeline" ? timeline
    : store.view === "pattern" ? patternView
    : store.view === "cues" ? cuesView : null;
}

// ── keyboard dispatch ──
window.addEventListener("keydown", (e) => {
  if (!store.doc) {
    // The File tab stays reachable before anything is loaded.
    if (e.code === "F7" && !e.ctrlKey && !e.metaKey && !e.altKey &&
        e.target.tagName !== "INPUT" && !e.target.closest?.("dialog")) {
      e.preventDefault();
      showView("files");
    }
    return;
  }
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
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyG") {
    e.preventDefault();
    openGoto();
    return;
  }
  // Block clipboard (Timeline / Patterns): copy / cut / paste.
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyC" || e.code === "KeyX" || e.code === "KeyV")) {
    const v = selView();
    if (v) {
      e.preventDefault();
      if (e.code === "KeyC") v.copySelection();
      else if (e.code === "KeyX") v.cutSelection();
      else v.paste();
      updateStatus();
      return;
    }
  }
  // Escape clears a block selection; Delete/Backspace blanks a selected block.
  if (e.code === "Escape") {
    const v = selView();
    if (v?.hasSelection()) { v.clearSelection(); e.preventDefault(); return; }
  }
  if (e.code === "Delete" || e.code === "Backspace") {
    const v = selView();
    if (v?.hasSelection()) { e.preventDefault(); v.deleteSelection(); updateStatus(); return; }
  }
  if (e.key === "?" && store.view !== "files") {
    e.preventDefault();
    showHelp();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.code) {
    case "Space": {
      e.preventDefault();
      if (store.audio?.isPlaying()) store.audio.stop(0);
      else if (e.shiftKey) playFrom(0, 0);
      else { const p = playCursor(); playFrom(p.cue, p.row); }
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

  if (store.view === "pattern") {
    if (patternView.processKey(e)) { e.preventDefault(); updateStatus(); return; }
    // jam-only fallback on the note column / when record is off
    if (!store.record || patternView.cursor.sub === SUB_NOTE) {
      if (jam.down(e.code, e.repeat)) { e.preventDefault(); return; }
    }
    return;
  }

  if (store.view === "samples" || store.view === "instruments") {
    // Instrument/sample DOM views audition through the piano keys.
    if (jam.down(e.code, e.repeat)) { e.preventDefault(); return; }
    return;
  }
  // Cues / Project / File never jam — piano keys are inert there (item 24).
  // (Cues returns above; Project + File fall through to no-op.)
  if (store.view === "project" || store.view === "files") return;

  if (store.view === "timeline") {
    switch (e.code) {
      case "ArrowUp": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(-1, 0) : timeline.moveCursor(-store.editStep || -1, 0); return;
      case "ArrowDown": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(1, 0) : timeline.moveCursor(store.editStep || 1, 0); return;
      case "ArrowLeft": e.preventDefault();
        e.shiftKey ? timeline.extendSelectionSub(-1) : timeline.moveSubCursor(-1); return;
      case "ArrowRight": e.preventDefault();
        e.shiftKey ? timeline.extendSelectionSub(1) : timeline.moveSubCursor(1); return;
      case "Tab":
        e.preventDefault();
        store.cursor.sub = SUB_NOTE;
        store.cursor.nib = 0;
        timeline.moveCursor(0, e.shiftKey ? -1 : 1);
        return;
      case "PageUp": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(-16, 0) : timeline.moveCursor(-16, 0); return;
      case "PageDown": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(16, 0) : timeline.moveCursor(16, 0); return;
      case "Home": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(-1e9, 0) : timeline.moveCursor(-1e9, 0); return;
      case "End": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(1e9, 0) : timeline.moveCursor(1e9, 0); return;
      case "Enter": { // pick up the cell's instrument as current
        e.preventDefault();
        const target = timeline.cursorCell();
        if (target && target.cell.instrment !== 0) {
          jam.currentInst = target.cell.instrment;
          updateStatus();
          store.emit("instsel");
        }
        return;
      }
      // Mute/solo on the cursor channel — navigate mode only, like taut
      // (in record mode M and N stay piano keys).
      case "KeyM":
        if (!store.record) { e.preventDefault(); store.toggleMute(store.cursor.ch); return; }
        break;
      case "KeyN":
        if (!store.record) { e.preventDefault(); store.toggleSolo(store.cursor.ch); return; }
        break;
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

async function openGoto() {
  if (!store.doc) return;
  const result = await showModal({
    title: t("goto.title"),
    fields: [
      { name: "cue", label: t("goto.cue"), value: "0" },
      { name: "row", label: t("goto.row"), value: "0" },
    ],
    okLabel: t("common.go"),
  });
  if (!result) return;
  const cue = parseInt(result.cue || "0", 16);
  const row = parseInt(result.row || "0", 16);
  const map = store.song.songMap();
  const entry = map.entries[Math.min(cue, map.entries.length - 1)];
  if (!entry) return;
  store.cursor.row = entry.startRow + Math.min(row, entry.rowLimit - 1);
  timeline.centreRow(store.cursor.row);
  store.emit("cursor");
  if (store.view === "cues") {
    cuesView.cursor.cue = entry.cue;
    cuesView.invalidate();
  }
}

// ── autosave (debounced 45 s after the last edit) + recovery prompt ──
let autosaveTimer = null;
store.on("edit", () => {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    if (!store.doc?.dirty) return;
    if (!(await opfs.available())) return;
    const name = store.fileName ?? "untitled.taud";
    try {
      await opfs.writeAutosave(name, store.doc.toBytes());
      console.info(`APP: autosaved ${name}`);
    } catch (err) {
      console.warn(`APP: autosave failed: ${err.message}`);
    }
  }, 45000);
});
store.on("saved", (name) => opfs.removeAutosave(name)); // clean save supersedes

(async function offerRecovery() {
  if (!(await opfs.available())) return;
  const autosaves = await opfs.listAutosaves();
  if (autosaves.length === 0) return;
  const newest = autosaves.sort((a, b) => b.mtime - a.mtime)[0];
  const result = await showModal({
    title: t("recover.title"),
    body: t("recover.body", { name: newest.name, when: new Date(newest.mtime).toLocaleString() }),
    fields: [],
    okLabel: t("recover.ok"),
  });
  if (result) {
    await loadBytes(newest.name, await opfs.readAutosave(newest.name));
    store.doc.dirty = true; // recovered content is unsaved by definition
    updateStatus();
  } else {
    for (const a of autosaves) await opfs.removeAutosave(a.name);
  }
})();

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
window.__microtone = { store, timeline, cuesView, patternView, samplesView, instrumentsView, projectView, jam, instLookup, loadBytes, playCursor };

// ── frame loop ──
function frame() {
  const audio = store.audio;
  if (audio && store.doc) {
    // Cue/row shown in hex (matches the grid gutters + note-fx B/C hex args).
    $("posCue").textContent = "$" + audio.getCuePosition().toString(16).toUpperCase();
    $("posRow").textContent = "$" + audio.getTrackerRow().toString(16).toUpperCase().padStart(2, "0");
    $("posBpm").textContent = audio.getBPM() || "–";
    $("posSpd").textContent = audio.getTickRate() || "–";
  }
  if (store.view === "timeline") timeline.frame();
  if (store.view === "cues") cuesView.frame();
  if (store.view === "pattern") patternView.frame();
  if (store.view === "samples") samplesView.frame();
  if (store.view === "instruments") instrumentsView.frame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
