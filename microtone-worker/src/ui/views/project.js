// Project view (F6) — song list with editable tempo/volume/flags scalars
// (eager-synced via ops), tuning display, project metadata. Reference:
// taut.js VIEW_PROJECT. Pitch-table retune is an M8 item.

import {
  setSongScalarOp, setTuningOp, retuneOp, remapPatternsOp, cleanupBankOp,
} from "../../doc/ops.js";
import { tuningRatioOf } from "../../engine/tables.js";
import {
  TUNING_REF_C4_HZ, TUNING_DEFAULT_BASE_NOTE, TUNING_DEFAULT_FREQ_HZ,
} from "../../engine/constants.js";
import {
  planCleanupPatterns, planRenumberPatterns, applyPatternOrder, encodeNameTable, planBankCleanup,
  planIxmpCleanup,
} from "../../doc/cleanup.js";
import { pitchTablePresets, presetForNotation, retuneAllPatterns, surveyTuning } from "../pitchtables.js";
import { defToPreset } from "../../doc/notation.js";
import { Song } from "../../doc/document.js";
import { showModal } from "../widgets/modal.js";
import { escapeNonAscii, unescapeName } from "../names.js";
import { t } from "../i18n.js";

// Tuning references, transcribed from terranmon.txt:3316-3324 ("Known standard
// tunings") with the tracker default at the head — that is what every converted
// file declares, and it is NOT concert: it puts A4 at ~439.53 Hz.
const TUNING_PRESETS = [
  { key: "proj.tuneTracker", note: TUNING_DEFAULT_BASE_NOTE, freq: TUNING_DEFAULT_FREQ_HZ },
  { key: "proj.tuneIso440", note: 0x5c00, freq: 440 },
  { key: "proj.tuneFrench435", note: 0x5c00, freq: 435 },
  { key: "proj.tunePhil452", note: 0x5c00, freq: 452 },
  { key: "proj.tunePow2C256", note: 0x5000, freq: 256 },
  { key: "proj.tuneAak262", note: 0x5000, freq: 262 },
  { key: "proj.tuneHyangak311", note: 0x5000, freq: 311 },
];

// Base notes worth naming. The field is a full Uint16 note value (spec:
// 1..65533), so a file may declare something else — that value is shown as a
// hex entry rather than being silently rewritten.
const BASE_NOTE_CHOICES = [[0x5000, "C4"], [0x5c00, "A4"], [0xa000, "C9"]];

export class ProjectView {
  constructor(store, host, cb = {}) {
    this.store = store;
    this.host = host;
    this.cb = cb; // { renameSong(index) } — the app's interactive rename modal
    this.visible = false;
    this.root = document.createElement("div");
    this.root.className = "project-view";
    host.appendChild(this.root);
    store.on("doc", () => { if (this.visible) this.refresh(); });
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  op(key, value) {
    this.store.undo.apply(setSongScalarOp(this.store.songIndex, key, value));
    this.refresh();
  }

  /**
   * Tuning (item 77): the song's declared "note B sounds at F Hz", which the
   * engine now applies to every note instead of ignoring it.
   */
  setTuning(baseNote, freq) {
    this.store.undo.apply(setTuningOp(this.store.songIndex, baseNote, freq));
    this.refresh();
  }

  buildTuning(song) {
    const box = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "inst-grid";

    const base = song.tuningBaseNote > 0 ? song.tuningBaseNote : TUNING_DEFAULT_BASE_NOTE;
    const freq = song.tuningFreq > 0 ? song.tuningFreq : TUNING_DEFAULT_FREQ_HZ;

    // The spec's own "Known standard tunings" list (terranmon.txt:3316-3324),
    // plus the tracker default that every converted file declares.
    const match = TUNING_PRESETS.findIndex(
      (p) => p.note === base && Math.abs(p.freq - freq) < 1e-3);
    const presetSel = sel(t("proj.tuningPreset"), match, [
      ...TUNING_PRESETS.map((p, i) => [i, t(p.key)]),
      [-1, t("proj.tuningCustom")],
    ], (i) => {
      if (i < 0) { this.refresh(); return; } // "Custom" is a readout, not a command
      this.setTuning(TUNING_PRESETS[i].note, TUNING_PRESETS[i].freq);
    });

    const baseSel = sel(t("proj.tuningBaseNote"), BASE_NOTE_CHOICES
      .some(([v]) => v === base) ? base : -1, [
      ...BASE_NOTE_CHOICES,
      ...(BASE_NOTE_CHOICES.some(([v]) => v === base)
        ? [] : [[-1, `$${base.toString(16).toUpperCase()}`]]),
    ], (v) => { if (v > 0) this.setTuning(v, freq); });

    // Frequency is a Float32 in the file, so a fractional reference (261.6256)
    // is legitimate — a plain number input, not the integer `num` helper.
    const freqWrap = document.createElement("label");
    freqWrap.className = "inst-field";
    freqWrap.textContent = t("proj.tuningFreq");
    const freqInput = document.createElement("input");
    freqInput.type = "number";
    freqInput.step = "any";
    freqInput.min = "1";
    freqInput.value = String(freq);
    freqInput.addEventListener("change", () => {
      const v = parseFloat(freqInput.value);
      if (!(v > 0)) { freqInput.value = String(freq); return; }
      this.setTuning(base, v);
    });
    freqWrap.appendChild(freqInput);

    grid.append(presetSel, baseSel, freqWrap);
    box.appendChild(grid);

    // What the declaration actually SOUNDS like. The tracker default is ~1.87
    // cents flat of concert, so this line is the difference between "cosmetic
    // option" and a number the user can trust.
    const ratio = tuningRatioOf(base, freq);
    const a4 = ratio * TUNING_REF_C4_HZ * 2 ** 0.75;
    const c = 1200 * Math.log2(ratio);
    const ann = document.createElement("p");
    ann.className = "dim";
    ann.style.margin = "0.1rem 0 0.4rem";
    ann.style.fontSize = "0.8rem";
    ann.textContent = t("proj.tuningAnnotation", {
      a4: a4.toFixed(2),
      cents: (c >= 0 ? "+" : "") + c.toFixed(2),
      rel: Math.abs(c) < 0.005
        ? t("proj.tuningAtConcert")
        : t(c < 0 ? "proj.tuningFlat" : "proj.tuningSharp"),
    });
    box.appendChild(ann);
    return box;
  }

  refresh() {
    const doc = this.store.doc;
    this.root.innerHTML = "";
    if (!doc) return;
    const song = this.store.song;
    const sm = doc.meta.songMeta[this.store.songIndex];

    const head = document.createElement("h3");
    head.className = "proj-title";
    head.textContent = unescapeName(doc.meta.projectName ?? "") || t("proj.untitledProject");
    this.root.appendChild(head);

    const info = document.createElement("p");
    info.className = "dim";
    let infoTxt = t("proj.infoMain", {
      n: doc.songs.length,
      songs: doc.songs.length === 1 ? t("proj.song") : t("proj.songs"),
      ch: doc.channelCount, ver: doc.fmtVer ?? 2, sig: doc.signature.trim(),
    });
    if (sm) {
      infoTxt += t("proj.infoSong", { name: unescapeName(sm.name) });
      if (sm.composer) infoTxt += t("proj.infoBy", { composer: unescapeName(sm.composer) });
    }
    info.textContent = infoTxt;
    this.root.appendChild(info);

    // Editable PROJECT name (PNam). Song renaming lives on the File tab's
    // song list. TSVM's string reader is ASCII-only, so any non-ASCII
    // character is STORED as a \uHHHH escape; the input shows the decoded
    // text and re-escapes on save.
    const nameRow = document.createElement("div");
    nameRow.className = "inst-field";
    nameRow.style.maxWidth = "440px";
    nameRow.append(document.createTextNode(t("proj.projectName")));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = unescapeName(doc.meta.projectName ?? "");
    nameInput.placeholder = t("proj.untitledProject");
    nameInput.spellcheck = false;
    nameInput.addEventListener("change", () => this.changeProjectName(nameInput.value));
    nameRow.appendChild(nameInput);
    // this.root.appendChild(nameRow);
    const nameHint = document.createElement("p");
    nameHint.className = "dim";
    nameHint.style.margin = "0.1rem 0 0.4rem";
    nameHint.style.fontSize = "0.8rem";
    // nameHint.textContent = "Non-ASCII characters are stored as \\uHHHH escapes (TSVM compatibility).";
    this.root.appendChild(nameHint);

    // Notation (display-only): changes how notes are drawn WITHOUT moving them.
    const preset = presetForNotation(sm?.notation ?? 120, doc);
    const notationRow = document.createElement("div");
    notationRow.className = "inst-field";
    notationRow.style.maxWidth = "440px";
    notationRow.append(document.createTextNode(t("proj.notationDisplayOnly")));
    const notSel = document.createElement("select");
    for (const p of Object.values(pitchTablePresets)) {
      const o = document.createElement("option");
      o.value = p.index;
      o.textContent = p.name;
      notSel.appendChild(o);
    }
    // Custom notations from the project's "nota" section (item 61).
    const customs = doc.customNotations();
    if (customs.length > 0) {
      const grp = document.createElement("optgroup");
      grp.label = t("nota.customGroup");
      for (const d of customs) {
        const p = defToPreset(d);
        const o = document.createElement("option");
        o.value = p.index;
        o.textContent = p.name;
        grp.appendChild(o);
      }
      notSel.appendChild(grp);
    }
    notSel.value = preset.index;
    notSel.addEventListener("change", () => this.changeNotation(parseInt(notSel.value, 10)));
    notationRow.appendChild(notSel);
    const makerBtn = document.createElement("button");
    makerBtn.textContent = t("nota.openMaker");
    makerBtn.title = t("nota.openMakerTitle");
    makerBtn.style.marginLeft = "0.4rem";
    makerBtn.addEventListener("click", async () => {
      const { showNotationMaker } = await import("../popups/notationmaker.js");
      await showNotationMaker(this.store);
      this.refresh();
    });
    notationRow.appendChild(makerBtn);

    const grid = document.createElement("div");
    grid.className = "inst-grid";
    grid.append(
      nameRow,
      num(t("proj.bpm"), song.bpm, 25, 535, (v) => this.op("bpm", v)),
      num(t("proj.speedTicks"), song.tickRate, 1, 127, (v) => this.op("tickRate", v)),
      num(t("proj.globalVolume"), song.globalVolume, 0, 255, (v) => this.op("globalVolume", v)),
      num(t("proj.mixingVolume"), song.mixingVolume, 0, 255, (v) => this.op("mixingVolume", v)),
      sel(t("proj.toneSlideMode"), song.globalFlags & 3, [
        [0, t("proj.toneLinear")], [1, t("proj.toneAmiga")], [2, t("proj.toneLinearHz")],
      ], (v) => this.op("globalFlags", (song.globalFlags & ~3) | v)),
      sel(t("proj.interpolation"), (song.globalFlags >> 2) & 7, [
        [0, t("proj.interpFastSinc")], [1, t("proj.interpNone")], [2, t("proj.interpAmiga500")],
        [3, t("proj.interpAmiga1200")], [4, t("proj.interpSnes")], [5, t("proj.interpNes")],
      ], (v) => this.op("globalFlags", (song.globalFlags & ~0x1c) | (v << 2))),
      notationRow,
    );
    this.root.appendChild(grid);

    this.root.appendChild(this.buildTuning(song));

    const tuning = document.createElement("p");
    tuning.className = "dim";
    let tuningTxt = "";
    if (sm) tuningTxt += t("proj.tuningBeat", { pri: sm.beatPri, sec: sm.beatSec });
    tuningTxt += t("proj.tuningPatterns", { pat: song.patterns.length, cues: song.lastUsedCue() + 1 });
    tuning.textContent = tuningTxt.replace(/^ · /, "");
    this.root.appendChild(tuning);

    const retuneP = document.createElement("p");
    retuneP.className = "dim";
    retuneP.append(document.createTextNode(t("proj.remapNotes")));
    const retuneBtn = document.createElement("button");
    retuneBtn.textContent = t("toolbox.retune");
    retuneBtn.addEventListener("click", () => this.openRetune(preset));
    retuneP.appendChild(retuneBtn);
    this.root.appendChild(retuneP);

    const songsTableHead = document.createElement("h3");
    songsTableHead.className = "files-songs-head";
    songsTableHead.textContent = t("files.songsHead");
    this.root.appendChild(songsTableHead);

    const songsTable = document.createElement("table");
    songsTable.className = "files-table";
    songsTable.innerHTML = `<thead><tr><th>${t("files.colSong")}</th><th>${t("files.colName")}</th>` +
      `<th>${t("files.colVoices")}</th><th>${t("files.colPatterns")}</th><th>${t("proj.colBpm")}</th>` +
      `<th>${t("proj.colSpeed")}</th><th>${t("proj.colOperation")}</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    doc.songs.forEach((s, i) => {
      const m = doc.meta.songMeta[i];
      const tr = document.createElement("tr");
      if (i === this.store.songIndex) tr.className = "files-current";
      tr.innerHTML =
        `<td>${i}</td><td>${esc(unescapeName(m?.name || "") || t("instList.unnamed"))}</td><td>${s.numVoices}</td>` +
        `<td>${s.patterns.length}</td><td>${s.bpm}</td><td>${s.tickRate}</td>`;
      const td = document.createElement("td");
      const rn = mkBtn(t("common.rename"), async () => {
        await this.cb.renameSong?.(i);
        this.refresh();
      });
      rn.title = t("song.renameBtnTitle");
      const rm = mkBtn(t("common.delete"), () => this.removeSong(i));
      rm.title = t("song.deleteBtnTitle");
      rm.disabled = doc.songs.length <= 1; // can't delete the last song
      td.appendChild(rn);
      td.appendChild(rm);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    songsTable.appendChild(tbody);
    this.root.appendChild(songsTable);

    const songBar = document.createElement("div");
    songBar.className = "toolbox";
    songBar.style.borderBottom = "none";
    songBar.style.padding = "0.4rem 0";
    const addBtn = document.createElement("button");
    addBtn.textContent = t("proj.addSong");
    addBtn.addEventListener("click", () => this.addSong());
    songBar.append(addBtn);
    this.root.appendChild(songBar);

    // ── Housekeeping (item 60): compact the project ──
    const houseHead = document.createElement("h3");
    houseHead.textContent = t("clean.title");
    this.root.appendChild(houseHead);
    const houseBar = document.createElement("div");
    houseBar.className = "toolbox";
    houseBar.style.borderBottom = "none";
    houseBar.style.padding = "0.4rem 0";
    houseBar.style.flexWrap = "wrap";
    const hbtn = (label, title, fn) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    houseBar.append(
      hbtn(t("clean.patterns"), t("clean.patternsTitle"), () => this.cleanupPatterns()),
      hbtn(t("clean.renumber"), t("clean.renumberTitle"), () => this.renumberPatterns()),
      hbtn(t("clean.bank"), t("clean.bankTitle"), () => this.cleanupBank()),
      hbtn(t("clean.ixmp"), t("clean.ixmpTitle"), () => this.cleanupIxmp()),
    );
    this.root.appendChild(houseBar);
  }

  /** Remove patterns no cue references (renumber survivors, rewrite cues + pNam). */
  cleanupPatterns() {
    const store = this.store, song = store.song;
    const order = planCleanupPatterns(song);
    const removed = song.patterns.filter(Boolean).length - order.length;
    if (removed <= 0 && this._isIdentityOrder(order, song)) { alert(t("clean.nothing")); return; }
    if (!confirm(t("clean.patternsConfirm", { removed: Math.max(removed, 0) }))) return;
    this._applyRemap(order);
  }

  /** Compact + reorder ALL materialised patterns into play order (drops gaps). */
  renumberPatterns() {
    const store = this.store, song = store.song;
    const order = planRenumberPatterns(song);
    if (this._isIdentityOrder(order, song)) { alert(t("clean.nothing")); return; }
    this._applyRemap(order);
  }

  _isIdentityOrder(order, song) {
    return order.length === song.patterns.length && order.every((v, i) => v === i);
  }

  _applyRemap(order) {
    const store = this.store;
    const plan = applyPatternOrder(store.song, order, store.doc._nameTable("pNam"));
    store.undo.apply(remapPatternsOp(store.songIndex, plan.patterns, plan.cues, encodeNameTable(plan.pNam)));
    store.emit("edit", [{ kind: "resync", song: store.songIndex }]);
    this.refresh();
  }

  /** Remove unused instruments + free their orphaned samples (one undo step). */
  cleanupBank() {
    const store = this.store;
    const plan = planBankCleanup(store.doc);
    if (plan.removedInstruments === 0 && plan.freedSampleBytes === 0) { alert(t("clean.nothing")); return; }
    if (!confirm(t("clean.bankConfirm", { insts: plan.removedInstruments, bytes: plan.freedSampleBytes }))) return;
    store.undo.apply(cleanupBankOp(plan));
    store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
  }

  /** Remove instrument patches that can never be triggered (item 74): orphan
   *  blobs, degenerate rectangles, and patches shadowed by higher-priority ones. */
  cleanupIxmp() {
    const store = this.store;
    const plan = planIxmpCleanup(store.doc);
    if (plan.noop) { alert(t("clean.nothing")); return; }
    if (!confirm(t("clean.ixmpConfirm", {
      patches: plan.removedPatches, insts: plan.report.length, blobs: plan.removedBlobs,
    }))) return;
    store.undo.apply(cleanupBankOp(plan));
    store.emit("edit", [{ kind: "bank" }]);
    this.refresh();
  }

  /** Rename the project (PNam section). Same \uHHHH escape convention as
   *  song names; the payload is byte-per-char + NUL (taud.mjs strNul). */
  changeProjectName(raw) {
    const store = this.store;
    const escaped = escapeNonAscii(raw);
    if ((store.doc.meta.projectName ?? "") === escaped) return;
    store.doc.meta.projectName = escaped;
    const bytes = [];
    for (let i = 0; i < escaped.length; i++) bytes.push(escaped.charCodeAt(i) & 0xff);
    bytes.push(0);
    store.doc.setSection("PNam", Uint8Array.from(bytes));
    store.doc.dirty = true;
    store.emit("status"); // topbar file line shows the project name
    this.refresh();
  }

  /** Rename song `index` (default: current). Non-ASCII characters are encoded
   *  as \uHHHH ASCII escapes so the sMet stays TSVM-readable (its string
   *  parser is not Unicode; the escape is kept verbatim). */
  changeName(raw, index = this.store.songIndex) {
    const store = this.store;
    const escaped = escapeNonAscii(raw);
    const sm = store.doc.meta.songMeta[index] ??
      (store.doc.meta.songMeta[index] =
        { notation: 120, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" });
    if (sm.name === escaped) return;
    sm.name = escaped;
    store.doc.smetEdited = true;
    store.doc.dirty = true;
    this.refresh();
  }

  /** Change the song's display notation only — does NOT move any notes. */
  changeNotation(newIndex) {
    const store = this.store;
    const sm = store.doc.meta.songMeta[store.songIndex] ??
      (store.doc.meta.songMeta[store.songIndex] =
        { notation: 120, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" });
    sm.notation = newIndex;
    store.doc.smetEdited = true;
    store.doc.dirty = true;
    store.pitchPreset = presetForNotation(newIndex, store.doc);
    store.emit("doc"); // redraw glyphs with the new table
    this.refresh();
  }

  /** Append a fresh empty song (one private pattern per channel, cue 0). */
  addSong() {
    const store = this.store;
    const doc = store.doc;
    const chans = doc.channelCount;
    const emptyPat = new Uint8Array(512);
    for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
    const cue0 = new Uint16Array(64).fill(0x7fff);
    const patterns = [];
    for (let ch = 0; ch < chans; ch++) { cue0[ch] = ch; patterns.push(Uint8Array.from(emptyPat)); }
    const t = store.song;
    doc.songs.push(new Song({
      numVoices: chans,
      bpm: t?.bpm ?? 125, tickRate: t?.tickRate ?? 6,
      tuningBaseNote: t?.tuningBaseNote ?? 0xa000, tuningFreq: t?.tuningFreq ?? 8363.0,
      globalFlags: t?.globalFlags ?? 0, globalVolume: t?.globalVolume ?? 0x80,
      mixingVolume: t?.mixingVolume ?? 0x80, patterns, cues: [cue0],
    }));
    const idx = doc.songs.length - 1;
    doc.meta.songMeta[idx] = {
      notation: doc.meta.songMeta[store.songIndex]?.notation ?? 120,
      beatPri: 4, beatSec: 16, name: `song ${idx}`, composer: "", copyright: "",
    };
    doc.smetEdited = true;
    doc.dirty = true;
    store.emit("songs", { select: idx });
  }

  /** Remove song `index` (default: current), guarded against emptying the
   *  project. The re-selection keeps the currently-viewed song when a DIFFERENT
   *  one is deleted. */
  removeSong(index = this.store.songIndex) {
    const store = this.store;
    const doc = store.doc;
    if (doc.songs.length <= 1) return;
    const idx = index;
    const nm = unescapeName(doc.meta.songMeta[idx]?.name ?? "");
    if (!confirm(t("confirm.removeSong", { idx, name: nm ? ` "${nm}"` : "" }))) return;
    const cur = store.songIndex;
    doc.songs.splice(idx, 1);
    // songMeta is keyed by song index — shift entries above `idx` down by one.
    const newMeta = {};
    for (const k of Object.keys(doc.meta.songMeta).map(Number)) {
      if (k === idx) continue;
      newMeta[k > idx ? k - 1 : k] = doc.meta.songMeta[k];
    }
    doc.meta.songMeta = newMeta;
    doc.smetEdited = true;
    doc.dirty = true;
    // Keep the viewer on the same song where possible.
    const select = idx === cur ? Math.min(idx, doc.songs.length - 1)
      : idx < cur ? cur - 1 : cur;
    store.emit("songs", { select });
  }

  /** Retune dialog: snap every note onto a new pitch table (nearest-pitch).
   *  Updates the song's sMet notation so display + future retunes follow.
   *  Callable without an argument (toolbox button). */
  async openRetune(currentPreset = presetForNotation(
    this.store.doc?.meta.songMeta[this.store.songIndex]?.notation ?? 120, this.store.doc)) {
    const store = this.store;
    const presetPool = [
      ...Object.values(pitchTablePresets),
      ...store.doc.customNotations().map(defToPreset),
    ].filter((p) => p.table.length > 0);
    const result = await showModal({
      title: t("retune.title"),
      body: t("retune.body", { name: currentPreset.name }),
      fields: [
        {
          name: "preset", label: t("retune.preset"), type: "select",
          value: String(currentPreset.index),
          options: presetPool.map((p) => ({ value: String(p.index), label: p.name })),
        },
        {
          name: "method", label: t("retune.method"), type: "select", value: "pitch",
          options: [
            { value: "pitch", label: t("retune.methodPitch") },
            { value: "delta", label: t("retune.methodDelta") },
            { value: "cadence", label: t("retune.methodCadence") },
            { value: "harmonic", label: t("retune.methodHarmonic") },
          ],
        },
      ],
      okLabel: t("retune.ok"),
    });
    if (!result) return;
    const newPreset = presetPool.find((p) => p.index === parseInt(result.preset, 10));
    if (!newPreset) return;
    const method = result.method || "pitch";

    // Percussion slots: inst byte14 bit4 / meta byte0 bit1 (isPercussion getter).
    const percSlots = new Uint8Array(1024);
    for (const s of store.doc.usedInstrumentSlots()) {
      if (store.doc.instruments[s].isPercussion) percSlots[s] = 1;
    }

    // Item 73 — an out-of-tune song (a .mod's period table lands notes a few
    // cents off every degree) needs a snap-to-grid pass before it can retune
    // sensibly. A same-table nearest-pitch retune IS that pass, so it only
    // no-ops when the notes really are all on the grid; anything else warns
    // first and points at the cleanup, rather than silently misplacing notes.
    const survey = surveyTuning(store.song, currentPreset, percSlots);
    const isCleanup = newPreset.index === currentPreset.index && method === "pitch";
    if (isCleanup) {
      if (survey.wouldChange === 0) {
        await showModal({
          title: t("retune.title"),
          body: t("retune.nothingToDo", { name: currentPreset.name }),
          okLabel: t("common.ok"),
        });
        return;
      }
    } else if (survey.offGrid > 0) {
      const go = await showModal({
        title: t("retune.outOfTuneTitle"),
        body: t("retune.outOfTuneBody", {
          off: survey.offGrid, total: survey.total, name: currentPreset.name,
        }),
        okLabel: t("retune.retuneAnyway"),
      });
      if (!go) return;
    }

    store.undo.apply(retuneOp(store.songIndex, newPreset, percSlots,
      (song, np, ps) => retuneAllPatterns(song, np, currentPreset, ps, method)));
    // Record the new tuning in the song metadata (drives display + next retune).
    if (!store.doc.meta.songMeta[store.songIndex]) {
      store.doc.meta.songMeta[store.songIndex] =
        { notation: newPreset.index, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" };
    } else {
      store.doc.meta.songMeta[store.songIndex].notation = newPreset.index;
    }
    store.doc.smetEdited = true;
    store.pitchPreset = newPreset;
    store.emit("doc"); // full redraw — many patterns changed
    this.refresh();
  }

  frame() {}
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function num(label, value, min, max, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "inst-field";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  input.min = min;
  input.max = max;
  input.addEventListener("change", () => {
    const v = Math.min(Math.max(parseInt(input.value || "0", 10), min), max);
    input.value = v;
    onChange(v);
  });
  wrap.appendChild(input);
  return wrap;
}

function sel(label, value, options, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "inst-field";
  wrap.textContent = label;
  const s = document.createElement("select");
  options.forEach(([v, text]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    s.appendChild(o);
  });
  s.value = value;
  s.addEventListener("change", () => onChange(parseInt(s.value, 10)));
  wrap.appendChild(s);
  return wrap;
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
