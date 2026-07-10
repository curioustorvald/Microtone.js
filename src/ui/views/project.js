// Project view (F6) — song list with editable tempo/volume/flags scalars
// (eager-synced via ops), tuning display, project metadata. Reference:
// taut.js VIEW_PROJECT. Pitch-table retune is an M8 item.

import { setSongScalarOp, retuneOp } from "../../doc/ops.js";
import { pitchTablePresets, presetForNotation, retuneAllPatterns } from "../pitchtables.js";
import { Song } from "../../doc/document.js";
import { showModal } from "../widgets/modal.js";
import { escapeNonAscii, unescapeName } from "../names.js";

export class ProjectView {
  constructor(store, host) {
    this.store = store;
    this.host = host;
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

  refresh() {
    const doc = this.store.doc;
    this.root.innerHTML = "";
    if (!doc) return;
    const song = this.store.song;
    const sm = doc.meta.songMeta[this.store.songIndex];

    const head = document.createElement("h3");
    head.className = "proj-title";
    head.textContent = unescapeName(doc.meta.projectName ?? "") || "(untitled project)";
    this.root.appendChild(head);

    const info = document.createElement("p");
    info.className = "dim";
    info.textContent =
      `${doc.songs.length} ${doc.songs.length === 1 ? "song" : "songs"} · ${doc.channelCount} channels · format v${doc.fmtVer ?? 2}` +
      ` · signature "${doc.signature.trim()}"` +
      (sm ? ` · song: "${unescapeName(sm.name)}"${sm.composer ? ` by ${unescapeName(sm.composer)}` : ""}` : "");
    this.root.appendChild(info);

    // Editable PROJECT name (PNam). Song renaming lives on the File tab's
    // song list. TSVM's string reader is ASCII-only, so any non-ASCII
    // character is STORED as a \uHHHH escape; the input shows the decoded
    // text and re-escapes on save.
    const nameRow = document.createElement("div");
    nameRow.className = "inst-field";
    nameRow.style.maxWidth = "440px";
    nameRow.append(document.createTextNode("Project name"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = unescapeName(doc.meta.projectName ?? "");
    nameInput.placeholder = "(untitled project)";
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
    const preset = presetForNotation(sm?.notation ?? 120);
    const notationRow = document.createElement("div");
    notationRow.className = "inst-field";
    notationRow.style.maxWidth = "440px";
    notationRow.append(document.createTextNode("Notation (display only)"));
    const notSel = document.createElement("select");
    for (const p of Object.values(pitchTablePresets)) {
      const o = document.createElement("option");
      o.value = p.index;
      o.textContent = p.name;
      notSel.appendChild(o);
    }
    notSel.value = preset.index;
    notSel.addEventListener("change", () => this.changeNotation(parseInt(notSel.value, 10)));
    notationRow.appendChild(notSel);

    const grid = document.createElement("div");
    grid.className = "inst-grid";
    grid.append(
      nameRow,
      num("BPM", song.bpm, 25, 535, (v) => this.op("bpm", v)),
      num("Speed (ticks/row)", song.tickRate, 1, 127, (v) => this.op("tickRate", v)),
      num("Global volume", song.globalVolume, 0, 255, (v) => this.op("globalVolume", v)),
      num("Mixing volume", song.mixingVolume, 0, 255, (v) => this.op("mixingVolume", v)),
      sel("Tone-slide mode", song.globalFlags & 3, [
        [0, "Linear (4096-TET)"], [1, "Amiga period"], [2, "Linear frequency (Hz)"],
      ], (v) => this.op("globalFlags", (song.globalFlags & ~3) | v)),
      sel("Interpolation", (song.globalFlags >> 2) & 7, [
        [0, "Fast sinc"], [1, "None (ZOH)"], [2, "Amiga 500"],
        [3, "Amiga 1200"], [4, "SNES gaussian"], [5, "NES DPCM"],
      ], (v) => this.op("globalFlags", (song.globalFlags & ~0x1c) | (v << 2))),
      notationRow,
    );
    this.root.appendChild(grid);

    const tuning = document.createElement("p");
    tuning.className = "dim";
    tuning.textContent =
      `Tuning: base note 0x${song.tuningBaseNote.toString(16).toUpperCase()} @ ${song.tuningFreq} Hz` +
      (sm ? ` · beat ${sm.beatPri}/${sm.beatSec}` : "") +
      ` · patterns: ${song.patterns.length} · cues used: ${song.lastUsedCue() + 1}`;
    this.root.appendChild(tuning);

    const retuneP = document.createElement("p");
    retuneP.className = "dim";
    retuneP.append(document.createTextNode("Remap notes onto a different tuning: "));
    const retuneBtn = document.createElement("button");
    retuneBtn.textContent = "Retune…";
    retuneBtn.addEventListener("click", () => this.openRetune(preset));
    retuneP.appendChild(retuneBtn);
    this.root.appendChild(retuneP);

    const songsTableHead = document.createElement("h3");
    songsTableHead.className = "files-songs-head";
    songsTableHead.textContent = "Songs in this project";
    this.root.appendChild(songsTableHead);

    const songsTable = document.createElement("table");
    songsTable.className = "files-table";
    songsTable.innerHTML = "<thead><tr><th>#</th><th>name</th><th>voices</th><th>patterns</th><th>BPM</th><th>speed</th><th>operation</th></tr></thead>";
    const tbody = document.createElement("tbody");
    doc.songs.forEach((s, i) => {
      const m = doc.meta.songMeta[i];
      const tr = document.createElement("tr");
      if (i === this.store.songIndex) tr.className = "files-current";
      tr.innerHTML =
        `<td>${i}</td><td>${esc(unescapeName(m?.name || "") || "(unnamed)")}</td><td>${s.numVoices}</td>` +
        `<td>${s.patterns.length}</td><td>${s.bpm}</td><td>${s.tickRate}</td>`;
      const td = document.createElement("td");
      const rn = mkBtn("Rename", async () => {
        await this.cb.renameSong(i);
        this.refresh();
      });
      rn.title = "Rename this song";
      const rm = mkBtn("Delete", async () => {
        await this.cb.renameSong(i);
        this.refresh();
      });
      rm.title = "Delete this song";
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
    addBtn.textContent = "＋ Add song";
    addBtn.addEventListener("click", () => this.addSong());
    songBar.append(addBtn);
    this.root.appendChild(songBar);
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
    store.pitchPreset = presetForNotation(newIndex);
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

  /** Remove the current song (guarded against removing the last one). */
  removeSong() {
    const store = this.store;
    const doc = store.doc;
    if (doc.songs.length <= 1) return;
    const idx = store.songIndex;
    const nm = unescapeName(doc.meta.songMeta[idx]?.name ?? "");
    if (!confirm(`Remove song ${idx}${nm ? ` "${nm}"` : ""}? This cannot be undone.`)) return;
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
    store.emit("songs", { select: Math.min(idx, doc.songs.length - 1) });
  }

  /** Retune dialog: snap every note onto a new pitch table (nearest-pitch).
   *  Updates the song's sMet notation so display + future retunes follow.
   *  Callable without an argument (toolbox button). */
  async openRetune(currentPreset = presetForNotation(
    this.store.doc?.meta.songMeta[this.store.songIndex]?.notation ?? 120)) {
    const store = this.store;
    const result = await showModal({
      title: "Retune all patterns",
      body: `Current: ${currentPreset.name}. Notes remap onto the new table; percussion instruments are skipped. One undo step.`,
      fields: [
        {
          name: "preset", label: "New pitch table", type: "select",
          value: String(currentPreset.index),
          options: Object.values(pitchTablePresets)
            .filter((p) => p.table.length > 0)
            .map((p) => ({ value: String(p.index), label: p.name })),
        },
        {
          name: "method", label: "Method", type: "select", value: "pitch",
          options: [
            { value: "pitch", label: "Nearest pitch (snap each note)" },
            { value: "delta", label: "Nearest delta (preserve intervals)" },
            { value: "cadence", label: "Nearest cadence (tonal tension)" },
            { value: "harmonic", label: "Cadence-aware harmonic" },
          ],
        },
      ],
      okLabel: "Retune",
    });
    if (!result) return;
    const newPreset = pitchTablePresets[parseInt(result.preset, 10)];
    if (!newPreset) return;
    const method = result.method || "pitch";
    // A same-table retune is a no-op only for the plain 'pitch' method; the
    // delta/cadence/harmonic methods can still re-voice within the same tuning.
    if (newPreset.index === currentPreset.index && method === "pitch") return;

    // Percussion slots: inst byte14 bit4 / meta byte0 bit1 (isPercussion getter).
    const percSlots = new Uint8Array(1024);
    for (const s of store.doc.usedInstrumentSlots()) {
      if (store.doc.instruments[s].isPercussion) percSlots[s] = 1;
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
