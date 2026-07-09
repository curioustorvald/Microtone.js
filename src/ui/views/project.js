// Project view (F6) — song list with editable tempo/volume/flags scalars
// (eager-synced via ops), tuning display, project metadata. Reference:
// taut.js VIEW_PROJECT. Pitch-table retune is an M8 item.

import { setSongScalarOp, retuneOp } from "../../doc/ops.js";
import { pitchTablePresets, presetForNotation, retuneNearest } from "../pitchtables.js";
import { showModal } from "../widgets/modal.js";

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
    head.textContent = doc.meta.projectName ?? "(untitled project)";
    this.root.appendChild(head);

    const info = document.createElement("p");
    info.className = "dim";
    info.textContent =
      `${doc.songs.length} song(s) · ${doc.channelCount} channels · format v${doc.fmtVer ?? 2}` +
      ` · signature "${doc.signature.trim()}"` +
      (sm ? ` · song: "${sm.name}"${sm.composer ? ` by ${sm.composer}` : ""}` : "");
    this.root.appendChild(info);

    const grid = document.createElement("div");
    grid.className = "inst-grid";
    grid.append(
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
    );
    this.root.appendChild(grid);

    const preset = presetForNotation(sm?.notation ?? 120);
    const tuning = document.createElement("p");
    tuning.className = "dim";
    tuning.textContent =
      `Tuning: base note 0x${song.tuningBaseNote.toString(16).toUpperCase()} @ ${song.tuningFreq} Hz` +
      ` · pitch table: ${preset.name}` +
      (sm ? ` · beat ${sm.beatPri}/${sm.beatSec}` : "") +
      ` · patterns: ${song.patterns.length} · cues used: ${song.lastUsedCue() + 1}`;
    const retuneBtn = document.createElement("button");
    retuneBtn.textContent = "Retune…";
    retuneBtn.style.marginLeft = "0.8rem";
    retuneBtn.addEventListener("click", () => this.openRetune(preset));
    tuning.appendChild(retuneBtn);
    this.root.appendChild(tuning);

    const songsTable = document.createElement("table");
    songsTable.className = "files-table";
    songsTable.innerHTML = "<thead><tr><th>#</th><th>name</th><th>voices</th><th>patterns</th><th>BPM</th><th>speed</th></tr></thead>";
    const tbody = document.createElement("tbody");
    doc.songs.forEach((s, i) => {
      const m = doc.meta.songMeta[i];
      const tr = document.createElement("tr");
      if (i === this.store.songIndex) tr.className = "files-current";
      tr.innerHTML =
        `<td>${i}</td><td>${esc(m?.name || "(unnamed)")}</td><td>${s.numVoices}</td>` +
        `<td>${s.patterns.length}</td><td>${s.bpm}</td><td>${s.tickRate}</td>`;
      tbody.appendChild(tr);
    });
    songsTable.appendChild(tbody);
    this.root.appendChild(songsTable);
  }

  /** Retune dialog: snap every note onto a new pitch table (nearest-pitch).
   *  Updates the song's sMet notation so display + future retunes follow.
   *  Callable without an argument (toolbox button). */
  async openRetune(currentPreset = presetForNotation(
    this.store.doc?.meta.songMeta[this.store.songIndex]?.notation ?? 120)) {
    const store = this.store;
    const result = await showModal({
      title: "Retune all patterns",
      body: `Current: ${currentPreset.name}. Notes snap to the nearest pitch of the new table; percussion instruments are skipped. One undo step.`,
      fields: [{
        name: "preset", label: "New pitch table", type: "select",
        value: String(currentPreset.index),
        options: Object.values(pitchTablePresets)
          .filter((p) => p.table.length > 0)
          .map((p) => ({ value: String(p.index), label: p.name })),
      }],
      okLabel: "Retune",
    });
    if (!result) return;
    const newPreset = pitchTablePresets[parseInt(result.preset, 10)];
    if (!newPreset || newPreset.index === currentPreset.index) return;

    // Percussion slots: inst byte14 bit4 / meta byte0 bit1 (isPercussion getter).
    const percSlots = new Uint8Array(1024);
    for (const s of store.doc.usedInstrumentSlots()) {
      if (store.doc.instruments[s].isPercussion) percSlots[s] = 1;
    }
    store.undo.apply(retuneOp(store.songIndex, newPreset, percSlots, retuneNearest));
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
