// Instruments view (F5) — list + tabbed editor: General (editable scalars),
// Volume/Panning/PF1/PF2 envelope graphs (drag nodes vertically to edit
// values; live playback cursor overlay), Zones (Ixmp rectangle map with live
// trigger overlay), Meta (layer table). Reference: taut_views.mjs instrument
// tab + openAdvancedInstEdit.

import { setInstFieldOp, setEnvDragOp } from "../../doc/ops.js";
import { minifloatToDouble, minifloatFromDouble } from "../../engine/minifloat.js";
import { envPresent } from "../../engine/envelope.js";
import { hex2, noteToStr } from "../notenames.js";

const ENV_TABS = [
  { key: "volEnvelopes", loopKey: "volEnvLoop", susKey: "volEnvSustainWord", label: "Vol env", max: 63 },
  { key: "panEnvelopes", loopKey: "panEnvLoop", susKey: "panEnvSustainWord", label: "Pan env", max: 255 },
  { key: "pfEnvelopes", loopKey: "pfEnvLoop", susKey: "pfEnvSustainWord", label: "PF env 1", max: 255 },
  { key: "pf2Envelopes", loopKey: "pf2EnvLoop", susKey: "pf2EnvSustainWord", label: "PF env 2", max: 255 },
];

export class InstrumentsView {
  constructor(store, host, jam) {
    this.store = store;
    this.host = host;
    this.jam = jam;
    this.selected = 1;
    this.tab = "general";
    this.visible = false;
    this.dragState = null;

    this.root = document.createElement("div");
    this.root.className = "split-view";
    this.listEl = document.createElement("div");
    this.listEl.className = "side-list";
    this.right = document.createElement("div");
    this.right.className = "side-detail";
    this.tabBar = document.createElement("div");
    this.tabBar.className = "subtabs";
    this.panel = document.createElement("div");
    this.panel.className = "inst-panel";
    this.right.append(this.tabBar, this.panel);
    this.root.append(this.listEl, this.right);
    host.appendChild(this.root);

    store.on("doc", () => { this.selected = 1; if (this.visible) this.refresh(); });
    store.on("edit", (tags) => {
      if (this.visible && tags?.some?.((t) => t.kind === "inst")) this.renderPanel();
    });
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  refresh() {
    const doc = this.store.doc;
    this.listEl.innerHTML = "";
    if (!doc) return;
    for (const slot of doc.usedInstrumentSlots()) {
      const inst = doc.instruments[slot];
      const row = document.createElement("div");
      row.className = "side-row" + (slot === this.selected ? " sel" : "");
      const kind = inst.isMeta ? "META" : inst.extraPatches ? `IXMP·${inst.extraPatches.length}` : "";
      row.innerHTML =
        `<span class="idx">$${slot.toString(16).toUpperCase().padStart(3, "0")}</span>` +
        `<span class="name">${escape(doc.instrumentName(slot) || "(unnamed)")}</span>` +
        `<span class="badge-sm">${kind}</span>`;
      row.addEventListener("click", () => {
        this.selected = slot;
        this.jam.currentInst = slot;
        this.refresh();
      });
      this.listEl.appendChild(row);
    }
    this.renderTabs();
    this.renderPanel();
  }

  renderTabs() {
    this.tabBar.innerHTML = "";
    const inst = this.store.doc?.instruments[this.selected];
    const tabs = inst?.isMeta
      ? [["meta", "Layers"]]
      : [["general", "General"], ...ENV_TABS.map((t, i) => [`env${i}`, t.label]), ["zones", "Zones"]];
    for (const [key, label] of tabs) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = this.tab === key ? "active" : "";
      b.addEventListener("click", () => { this.tab = key; this.renderTabs(); this.renderPanel(); });
      this.tabBar.appendChild(b);
    }
    if (inst?.isMeta) this.tab = "meta";
    else if (this.tab === "meta") this.tab = "general";
  }

  renderPanel() {
    const doc = this.store.doc;
    if (!doc) return;
    const inst = doc.instruments[this.selected];
    this.panel.innerHTML = "";
    if (this.tab === "general") this.renderGeneral(inst);
    else if (this.tab.startsWith("env")) this.renderEnv(inst, ENV_TABS[parseInt(this.tab.slice(3), 10)]);
    else if (this.tab === "zones") this.renderZones(inst);
    else if (this.tab === "meta") this.renderMeta(inst);
  }

  field(label, value, min, max, onChange) {
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

  select(label, value, options, onChange) {
    const wrap = document.createElement("label");
    wrap.className = "inst-field";
    wrap.textContent = label;
    const sel = document.createElement("select");
    options.forEach(([v, text]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      sel.appendChild(o);
    });
    sel.value = value;
    sel.addEventListener("change", () => onChange(parseInt(sel.value, 10)));
    wrap.appendChild(sel);
    return wrap;
  }

  setField(key, value) {
    this.store.undo.apply(setInstFieldOp(this.selected, key, value));
  }

  renderGeneral(inst) {
    const grid = document.createElement("div");
    grid.className = "inst-grid";
    const fadeout = inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8);
    grid.append(
      this.field("Global vol", inst.instGlobalVolume, 0, 255, (v) => this.setField("instGlobalVolume", v)),
      this.field("Default note vol", inst.defaultNoteVolume, 0, 255, (v) => this.setField("defaultNoteVolume", v)),
      this.field("Fadeout (12-bit)", fadeout, 0, 4095, (v) => {
        this.setField("volumeFadeoutLow", v & 0xff);
        this.setField("fadeoutHigh", (inst.fadeoutHigh & 0x10) | ((v >> 8) & 0x0f));
      }),
      this.field("Default pan", inst.defaultPan, 0, 255, (v) => this.setField("defaultPan", v)),
      this.field("Cutoff", inst.defaultCutoff, 0, 255, (v) => this.setField("defaultCutoff", v)),
      this.field("Resonance", inst.defaultResonance, 0, 255, (v) => this.setField("defaultResonance", v)),
      this.field("Detune (s16)", inst.sampleDetuneSigned, -32768, 32767, (v) =>
        this.setField("sampleDetune", v & 0xffff)),
      this.select("NNA", inst.instrumentFlag & 3,
        [[0, "Note off"], [1, "Note cut"], [2, "Continue"], [3, "Note fade"]],
        (v) => this.setField("instrumentFlag", (inst.instrumentFlag & ~3) | v)),
      this.select("Key lift", (inst.instrumentFlag >> 5) & 1, [[0, "off"], [1, "on"]],
        (v) => this.setField("instrumentFlag", (inst.instrumentFlag & ~0x20) | (v << 5))),
      this.select("DCT", inst.dupCheckFlag & 3,
        [[0, "off"], [1, "note"], [2, "sample"], [3, "instrument"]],
        (v) => this.setField("dupCheckFlag", (inst.dupCheckFlag & ~3) | v)),
      this.select("DCA", (inst.dupCheckFlag >> 2) & 3,
        [[0, "cut"], [1, "off"], [2, "fade"]],
        (v) => this.setField("dupCheckFlag", (inst.dupCheckFlag & ~0x0c) | (v << 2))),
      this.select("Percussion", (inst.loopMode >> 4) & 1, [[0, "no"], [1, "yes"]],
        (v) => this.setField("loopMode", (inst.loopMode & ~0x10) | (v << 4))),
      this.field("Vib speed", inst.vibratoSpeed, 0, 255, (v) => this.setField("vibratoSpeed", v)),
      this.field("Vib sweep", inst.vibratoSweep, 0, 255, (v) => this.setField("vibratoSweep", v)),
      this.field("Vib depth", inst.vibratoDepth, 0, 255, (v) => this.setField("vibratoDepth", v)),
      this.field("Vib rate", inst.vibratoRate, 0, 255, (v) => this.setField("vibratoRate", v)),
      this.select("Vib wave", (inst.instrumentFlag >> 2) & 7,
        [[0, "sine"], [1, "ramp down"], [2, "square"], [3, "random"], [4, "ramp up"]],
        (v) => this.setField("instrumentFlag", (inst.instrumentFlag & ~0x1c) | (v << 2))),
      this.field("Sample ptr", inst.samplePtr, 0, 8388607, (v) => this.setField("samplePtr", v)),
      this.field("Sample len", inst.sampleLength, 0, 65535, (v) => this.setField("sampleLength", v)),
      this.field("Rate @C4", inst.samplingRate, 0, 65535, (v) => this.setField("samplingRate", v)),
      this.field("Loop start", inst.sampleLoopStart, 0, 65535, (v) => this.setField("sampleLoopStart", v)),
      this.field("Loop end", inst.sampleLoopEnd, 0, 65535, (v) => this.setField("sampleLoopEnd", v)),
      this.select("Loop mode", inst.loopMode & 3,
        [[0, "off"], [1, "forward"], [2, "ping-pong"], [3, "one-shot"]],
        (v) => this.setField("loopMode", (inst.loopMode & ~3) | v)),
      this.select("SF2 filter", (inst.fadeoutHigh >> 4) & 1, [[0, "IT"], [1, "SoundFont"]],
        (v) => this.setField("fadeoutHigh", (inst.fadeoutHigh & 0x0f) | (v << 4))),
    );
    this.panel.appendChild(grid);
  }

  renderEnv(inst, tabDef) {
    const env = inst[tabDef.key];
    const loopWord = inst[tabDef.loopKey];
    const susWord = inst[tabDef.susKey];
    const head = document.createElement("div");
    head.className = "detail-info";
    const present = envPresent(loopWord);
    const mBit = (loopWord >> 7) & 1;
    head.innerHTML =
      `${tabDef.label}: ${present ? "present" : "absent (P bit clear)"}` +
      (tabDef.key.startsWith("pf") ? ` · role: <b>${mBit ? "FILTER" : "PITCH"}</b>` : "") +
      ` · loop 0x${loopWord.toString(16)} sustain 0x${susWord.toString(16)}` +
      ` — drag nodes to edit values`;
    this.panel.appendChild(head);

    const canvas = document.createElement("canvas");
    canvas.className = "wave-canvas";
    this.panel.appendChild(canvas);
    this.envCanvas = { canvas, env, tabDef, inst };
    this.drawEnvGraph();

    canvas.addEventListener("pointerdown", (e) => this.envPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.envPointerMove(e));
    canvas.addEventListener("pointerup", () => { this.dragState = null; });
  }

  envGeometry() {
    const { canvas, env } = this.envCanvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // cumulative time axis; ensure a minimum span so flat envs remain visible
    const times = [0];
    for (let i = 0; i < 24; i++) times.push(times[i] + minifloatToDouble(env[i].offset));
    const total = Math.max(times[24], 0.25);
    return { w, h, times, total };
  }

  drawEnvGraph() {
    const { canvas, env, tabDef, inst } = this.envCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, this.right.clientWidth - 20);
    const h = 240;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1f232b";
    ctx.fillRect(0, 0, w, h);

    const { times, total } = this.envGeometry();
    const X = (i) => 10 + (times[i] / total) * (w - 20);
    const Y = (v) => h - 14 - (v / tabDef.max) * (h - 28);

    // sustain / loop region shading
    const shade = (word, color) => {
      if (((word >> 5) & 1) === 0) return;
      const s = (word >> 8) & 0x1f;
      const e = word & 0x1f;
      ctx.fillStyle = color;
      ctx.fillRect(X(Math.min(s, 24)), 0, Math.max(X(Math.min(e, 24)) - X(Math.min(s, 24)), 2), h);
    };
    shade(inst[tabDef.susKey], "#2a3a2e");
    shade(inst[tabDef.loopKey], "#33314a44");

    // polyline + nodes
    ctx.strokeStyle = "#4aa3ff";
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const x = X(i);
      const y = Y(env[i].value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "#f5a623";
    for (let i = 0; i <= 24; i++) {
      ctx.beginPath();
      ctx.arc(X(i), Y(env[i].value), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // live playback cursors: voices playing this instrument
    const audio = this.store.audio;
    if (audio && tabDef.key === "volEnvelopes") {
      ctx.fillStyle = "#43d675";
      for (let vi = 0; vi < 64; vi++) {
        if (!audio.getVoiceActive(vi) || audio.getVoiceInstrument(vi) !== this.selected) continue;
        const idx = audio.getVoiceEnvVolIndex(vi);
        const t = audio.getVoiceEnvVolTime(vi);
        if (idx < 0 || idx > 24) continue;
        const base = times[Math.min(idx, 24)];
        const x = 10 + (Math.min(base + t, total) / total) * (w - 20);
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }
  }

  envHit(e) {
    const rect = this.envCanvas.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { w, times, total } = this.envGeometry();
    let best = -1, bestD = 12;
    for (let i = 0; i <= 24; i++) {
      const nx = 10 + (times[i] / total) * (w - 20);
      const d = Math.abs(nx - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { idx: best, y };
  }

  envPointerDown(e) {
    const hit = this.envHit(e);
    if (hit.idx < 0) return;
    this.envCanvas.canvas.setPointerCapture(e.pointerId);
    this.dragState = { idx: hit.idx, gestureId: `envdrag${Date.now()}` };
    this.envPointerMove(e);
  }

  envPointerMove(e) {
    if (!this.dragState) return;
    const { canvas, tabDef } = this.envCanvas;
    const rect = canvas.getBoundingClientRect();
    const h = canvas.clientHeight;
    const idx = this.dragState.idx;
    const v = Math.round(((h - 14 - (e.clientY - rect.top)) / (h - 28)) * tabDef.max);
    const change = { value: Math.min(Math.max(v, 0), tabDef.max) };
    // Horizontal drag re-times the PRECEDING segment (env[idx-1].offset),
    // quantised to the ThreeFiveMiniUfloat grid. Node 0 is fixed at t=0.
    if (idx > 0) {
      const { w, times, total } = this.envGeometry();
      const x = e.clientX - rect.left;
      const wantTime = ((x - 10) / (w - 20)) * total;
      const seg = Math.max(wantTime - times[idx - 1], 0);
      change.prevOffset = minifloatFromDouble(seg);
    }
    this.store.undo.apply(setEnvDragOp(
      this.selected, tabDef.key, idx, change, this.dragState.gestureId));
    this.drawEnvGraph();
  }

  renderZones(inst) {
    const head = document.createElement("div");
    head.className = "detail-info";
    const patches = inst.extraPatches ?? [];
    head.textContent = `${patches.length} Ixmp patch(es) — pitch × velocity zones (live triggers highlighted)`;
    this.panel.appendChild(head);
    const canvas = document.createElement("canvas");
    canvas.className = "wave-canvas";
    this.panel.appendChild(canvas);
    this.zoneCanvas = { canvas, inst };
    this.drawZones();
  }

  drawZones() {
    if (!this.zoneCanvas) return;
    const { canvas, inst } = this.zoneCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, this.right.clientWidth - 20);
    const h = 260;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1f232b";
    ctx.fillRect(0, 0, w, h);
    const patches = inst.extraPatches ?? [];
    const X = (noteVal) => (noteVal / 0xffff) * w;
    const Y = (vol) => h - (vol / 63) * h;

    const audio = this.store.audio;
    const liveKeys = new Set();
    if (audio) {
      for (let vi = 0; vi < 64; vi++) {
        if (audio.getVoiceActive(vi) && audio.getVoiceInstrument(vi) === this.selected) {
          liveKeys.add(`${audio.getVoiceSamplePtr(vi)}:${audio.getVoiceSampleLength(vi)}`);
        }
      }
    }

    patches.forEach((p, i) => {
      const x = X(p.pitchStart);
      const y = Y(p.volumeEnd);
      const pw = Math.max(X(p.pitchEnd) - x, 2);
      const ph = Math.max(Y(p.volumeStart) - y, 2);
      const live = liveKeys.has(`${p.samplePtr}:${p.sampleLength}`);
      ctx.fillStyle = live ? "#f5a62388" : `hsla(${(i * 47) % 360} 50% 55% / 0.35)`;
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeStyle = live ? "#f5a623" : "#4aa3ff66";
      ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
      ctx.fillStyle = "#d8dce4";
      ctx.font = "10px monospace";
      if (pw > 30) {
        ctx.fillText(`${noteToStr(p.pitchStart)}‥${noteToStr(p.pitchEnd)}`, x + 2, y + 11);
      }
    });
  }

  renderMeta(inst) {
    const doc = this.store.doc;
    const table = document.createElement("table");
    table.className = "files-table";
    table.innerHTML =
      "<thead><tr><th>#</th><th>sub-inst</th><th>mix</th><th>detune</th><th>pitch range</th><th>vel</th></tr></thead>";
    const tbody = document.createElement("tbody");
    (inst.metaLayers ?? []).forEach((l, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${i}</td>` +
        `<td>$${l.instIdx.toString(16).toUpperCase().padStart(3, "0")} ${escape(doc.instrumentName(l.instIdx) || "")}</td>` +
        `<td>${l.mixOctet}</td><td>${l.detune}</td>` +
        `<td>${noteToStr(l.pitchStart)}‥${noteToStr(l.pitchEnd)}</td>` +
        `<td>${l.volStart}‥${l.volEnd}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    this.panel.appendChild(table);
  }

  frame() {
    if (!this.visible) return;
    if (this.store.audio?.isPlaying()) {
      if (this.tab.startsWith("env") && this.envCanvas) this.drawEnvGraph();
      if (this.tab === "zones" && this.zoneCanvas) this.drawZones();
    }
  }
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
