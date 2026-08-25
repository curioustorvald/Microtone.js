// Instruments view (F5) — list + tabbed editor: General (editable scalars),
// Volume/Panning/PF1/PF2 envelope graphs (drag nodes vertically to edit
// values; live playback cursor overlay), Zones (Ixmp rectangle map with live
// trigger overlay), Meta (layer table). Reference: taut_views.mjs instrument
// tab + openAdvancedInstEdit.

import {
  setInstFieldOp, setInstBytesOp, setEnvDragOp, setEnvPointOp, setEnvArrayOp,
  setMetaRecordOp, setSectionOp, renumberInstrumentOp, deleteInstrumentOp,
  importBankOp,
} from "../../doc/ops.js";
import {
  metaLayers, metaRecordOf, duplicateLayer, removeLayer, moveLayer, patchLayer,
  linkCount, clampDetune, META_MAX_LAYERS,
} from "../../doc/metaedit.js";
import {
  planRenumberInstrument, instrumentCellRefs,
  planDeleteInstrument, metainstrumentParents,
  classifyMetaChildren, uniqueSampleSpansForSet,
} from "../../doc/cleanup.js";
import { planDuplicateInstruments } from "../../doc/bankmerge.js";
import { showModal } from "../widgets/modal.js";
import { AdvancedZoneEditor } from "./instadvanced.js";
import { META_MIX_GAIN } from "../../engine/tables.js";
import { TOTAL_VOICES } from "../../engine/constants.js";
import { showImportInstruments, importFromSf2 } from "../popups/importinst.js";
import { getSoundfont } from "../soundfont.js";
import { minifloatToDouble, minifloatFromDouble } from "../../engine/minifloat.js";
import { mapSpinner } from "../widgets/spinner.js";
import { envPresent } from "../../engine/envelope.js";
import { hex2, rangeToStr } from "../notenames.js";
import { noteGlyphCanvas, rangeGlyphCanvas } from "../noteglyph.js";
import { ANCHOR_NOTE, stepNoteInTable } from "../pitchtables.js";
import { UNITS_PER_OCTAVE } from "../../doc/chord.js";
import { themeColors } from "../theme.js";
import { unescapeName, escapeNonAscii } from "../names.js";
import {
  annHex2, annFilter, annFadeout, annSfCutoff, annSfReso, azimuthLabel, elevationLabel,
  SEG_MINIFLOAT_MAP,
} from "../units.js";
import { SURROUND_STEREO, SURROUND_SPATIAL } from "../../engine/spatial.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

// Fraction of the envelope graph's plottable width the time axis uses; the
// rightmost 1−ENV_TIME_FRAC stays empty so the last node can always be grabbed
// and dragged further right to extend the envelope (item 37).
const ENV_TIME_FRAC = 0.8;

const ENV_TABS = [
  { key: "volEnvelopes", loopKey: "volEnvLoop", susKey: "volEnvSustainWord", labelKey: "inst.tabVolEnv",
    max: 63, liveIdx: "getVoiceEnvVolIndex", liveTime: "getVoiceEnvVolTime" },
  { key: "panEnvelopes", loopKey: "panEnvLoop", susKey: "panEnvSustainWord", labelKey: "inst.tabPanEnv",
    max: 255, liveIdx: "getVoiceEnvPanIndex", liveTime: "getVoiceEnvPanTime" },
];

/**
 * The instrument record carries TWO pitch/filter envelope slots (bytes 19..
 * and 197..) whose ROLE — pitch or filter — is chosen by each slot's m-bit
 * (LOOP-word bit 7), in no set order; when both claim one role the second
 * slot wins (engine resolveActiveEnvelopes). The UI hides that quirk behind
 * plain "Pitch" and "Filter" tabs (taut.js behaviour): each tab resolves the
 * physical slot that currently HOLDS its role. When the role is absent, the
 * tab targets a free slot (or the overridden loser) so that editing can
 * claim it — the first drag sets the slot's P bit + m-bit for the role.
 */
function roleTabDef(inst, wantFilter) {
  const SLOT1 = { key: "pfEnvelopes", loopKey: "pfEnvLoop", susKey: "pfEnvSustainWord" };
  const SLOT2 = { key: "pf2Envelopes", loopKey: "pf2EnvLoop", susKey: "pf2EnvSustainWord" };
  const role1 = envPresent(inst.pfEnvLoop) ? ((inst.pfEnvLoop >>> 7) & 1) === 1 : null;
  const role2 = envPresent(inst.pf2EnvLoop) ? ((inst.pf2EnvLoop >>> 7) & 1) === 1 : null;
  let slot, active;
  if (role2 === wantFilter) { slot = SLOT2; active = true; }        // slot 2 wins
  else if (role1 === wantFilter) { slot = SLOT1; active = true; }
  else if (role1 === null && role2 === null) { slot = wantFilter ? SLOT2 : SLOT1; active = false; }
  else if (role1 === null) { slot = SLOT1; active = false; }
  else if (role2 === null) { slot = SLOT2; active = false; }
  else { slot = SLOT1; active = false; }                            // both hold the other role → loser
  return {
    ...slot,
    labelKey: wantFilter ? "inst.envFilter" : "inst.envPitch",
    max: 255,
    role: wantFilter ? "filter" : "pitch",
    roleActive: active,
    liveIdx: wantFilter ? "getVoiceEnvFilterIndex" : "getVoiceEnvPitchIndex",
    liveTime: wantFilter ? "getVoiceEnvFilterTime" : "getVoiceEnvPitchTime",
  };
}

export class InstrumentsView {
  constructor(store, host, jam) {
    this.store = store;
    this.host = host;
    this.jam = jam;
    this.selected = 1;
    this.tab = "general";
    this.visible = false;
    this.dragState = null;
    this.selectedNode = 0; // envelope node targeted by the spinner controls
    this.envLogTime = false; // logarithmic time axis for the envelope graph
    this.advanced = false; // Advanced Edit (Ixmp patch editor, item 49b) active
    this.advEditor = new AdvancedZoneEditor(this);

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

    this._childSelected = null; // meta-layer child explicitly opened via "Edit…"
    this._childParent = null;   // the metainstrument it was opened from (breadcrumb)
    store.on("doc", () => {
      this.selected = 1; this.advanced = false;
      this._childSelected = null; this._childParent = null;
      if (this.visible) this.refresh();
    });
    store.on("edit", (tags) => {
      // Suppress the rebuild WHILE an envelope node or a General-tab slider is
      // being dragged — each drag step fires an inst edit, and re-rendering
      // would detach the canvas/control (killing pointer capture). The graph
      // repaints in-place via drawEnvGraph; sliders update themselves.
      if (this.dragState || this._quiet) return;
      if (!this.visible) return;
      if (tags?.some?.((t) => t.kind === "bank")) this.refresh(); // import/undo — slots changed
      else if (tags?.some?.((t) => t.kind === "inst" || t.kind === "ixmp")) this.renderPanel();
    });
  }

  show() { this.visible = true; this.refresh(); }
  hide() { this.visible = false; }

  refresh() {
    const doc = this.store.doc;
    this.listEl.innerHTML = "";
    this.rowEls = [];
    if (!doc) return;
    const bar = document.createElement("div");
    bar.className = "side-toolbar-inst";
    const adopt = (res) => {
      if (!res) return;
      this.selected = res.firstSlot;
      this.jam.currentInst = res.firstSlot;
      this.refresh();
    };
    const addBtn = document.createElement("button");
    addBtn.textContent = t("inst.add");
    addBtn.title = t("inst.addTitle");
    addBtn.addEventListener("click", async () => {
      const sf2 = await getSoundfont();
      if (sf2) adopt(await importFromSf2(this.store, sf2.name, sf2.bytes));
    });
    const importBtn = document.createElement("button");
    importBtn.textContent = t("inst.import");
    importBtn.title = t("inst.importTitle");
    importBtn.addEventListener("click", async () => adopt(await showImportInstruments(this.store)));
    const smpBtn = document.createElement("button");
    smpBtn.textContent = t("inst.newFromSample");
    smpBtn.title = t("inst.newFromSampleTitle");
    smpBtn.addEventListener("click", async () => {
      const { importSampleAsInstrument } = await import("../popups/importsample.js");
      adopt(await importSampleAsInstrument(this.store));
    });
    const paintBtn = document.createElement("button");
    paintBtn.textContent = t("inst.paint");
    paintBtn.title = t("inst.paintTitle");
    paintBtn.addEventListener("click", async () => {
      const { paintNewSample } = await import("../popups/waveformpaint.js");
      adopt(await paintNewSample(this.store));
    });
    const recBtn = document.createElement("button");
    recBtn.textContent = t("inst.record");
    recBtn.title = t("inst.recordTitle");
    recBtn.addEventListener("click", async () => {
      const { recordSample } = await import("../popups/recordsample.js");
      adopt(await recordSample(this.store));
    });
    const metaBtn = document.createElement("button");
    metaBtn.textContent = t("inst.newMeta");
    metaBtn.title = t("inst.newMetaTitle");
    metaBtn.addEventListener("click", async () => {
      const { showNewMeta } = await import("../popups/newmeta.js");
      adopt(await showNewMeta(this.store));
    });
    bar.append(addBtn, importBtn, smpBtn, paintBtn, recBtn, metaBtn);
    this.listEl.appendChild(bar);
    // Only top-level instruments are listed — a metainstrument's sub-instruments
    // are not directly selectable (item 59); edit them via their metainstrument.
    const slots = doc.selectableInstrumentSlots();
    // A meta-layer child opened via the Layers tab's "Edit…" button stays
    // selected across rebuilds (it is not in the list — item 59 keeps it out of
    // ordinary selection); anything else off-list resets to the first slot.
    const keepChild = this._childSelected === this.selected &&
      doc.metaChildSlots().has(this.selected);
    if (slots.length && !slots.includes(this.selected) && !keepChild) {
      this.selected = slots[0];
      this._childSelected = null;
      this._childParent = null;
      if (doc.metaChildSlots().has(this.jam.currentInst)) this.jam.currentInst = slots[0];
    }
    for (const slot of slots) {
      const inst = doc.instruments[slot];
      const row = document.createElement("div");
      row.className = "side-row" + (slot === this.selected ? " sel" : "");
      const kind = inst.isMeta ? "META" : inst.extraPatches ? `IXMP·${inst.extraPatches.length}` : "";
      row.innerHTML =
        `<span class="dot"></span>` +
        `<span class="idx">$${slot.toString(16).toUpperCase().padStart(3, "0")}</span>` +
        `<span class="name">${escape(unescapeName(doc.instrumentName(slot)) || t("inst.unnamed"))}</span>` +
        `<span class="badge-sm">${kind}</span>`;
      row.addEventListener("click", () => {
        this.selected = slot;
        this._childSelected = null;
        this._childParent = null;
        this.jam.currentInst = slot;
        this.store.emit("instsel");
        this.refresh();
      });
      this.listEl.appendChild(row);
      this.rowEls.push({ el: row, slot });
    }
    this.renderTabs();
    this.renderPanel();
  }

  /** Light the list rows of instruments any voice is playing right now.
   *  A meta's layer children play sub-instrument slots, so those light too. */
  updateLiveDots() {
    const audio = this.store.audio;
    if (!audio || !this.rowEls) return;
    const liveSlots = new Set();
    for (let vi = 0; vi < TOTAL_VOICES; vi++) {
      if (audio.getVoiceActive(vi)) liveSlots.add(audio.getVoiceInstrument(vi));
    }
    for (const r of this.rowEls) r.el.classList.toggle("live", liveSlots.has(r.slot));
  }

  renderTabs() {
    this.tabBar.innerHTML = "";
    const inst = this.store.doc?.instruments[this.selected];
    const tabs = inst?.isMeta
      ? [["meta", t("inst.tabLayers")]]
      : [["general", t("inst.tabGeneral")], ["env0", t("inst.tabVolEnv")], ["env1", t("inst.tabPanEnv")],
         ["pitch", t("inst.tabPitch")], ["filter", t("inst.tabFilter")], ["zones", t("inst.tabZones")]];
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
    // Advanced Edit (item 49b): a whole-panel Ixmp patch editor replaces the
    // tab bar + panel until its Back button (metas fall back to the tabs).
    if (this.advanced && inst?.isMeta) this.advanced = false;
    this.tabBar.hidden = this.advanced;
    // adv-active makes the panel fill the detail pane so the patch-list
    // separator reaches the bottom of the available space (item 63).
    this.panel.classList.toggle("adv-active", this.advanced);
    if (this.advanced) {
      this.refreshListBadge(this.selected);
      this.advEditor.render();
      return;
    }
    this.panel.innerHTML = "";
    if (inst) this.panel.appendChild(this.nameRow());
    if (this.tab === "general") this.renderGeneral(inst);
    else if (this.tab.startsWith("env")) this.renderEnv(inst, ENV_TABS[parseInt(this.tab.slice(3), 10)]);
    else if (this.tab === "pitch") this.renderEnv(inst, roleTabDef(inst, false));
    else if (this.tab === "filter") this.renderEnv(inst, roleTabDef(inst, true));
    else if (this.tab === "zones") this.renderZones(inst);
    else if (this.tab === "meta") this.renderMeta(inst);
  }

  setField(key, value) {
    this.store.undo.apply(setInstFieldOp(this.selected, key, value));
  }

  /** Editable instrument-name row (INam), shown atop every tab so it's reachable
   *  for meta insts too. Commits via setSectionOp (undoable, cosmetic — no
   *  device effect); updates the list-row label in place without a full rebuild
   *  so the input keeps focus during typing. */
  nameRow() {
    const doc = this.store.doc;
    const slot = this.selected;
    const row = document.createElement("div");
    row.className = "inst-name-row";
    // A layer child opened via the Meta tab (item 71) has no list row to return
    // from — a breadcrumb chip walks back to the metainstrument that owns it.
    if (this._childSelected === slot && this._childParent !== null) {
      const parent = this._childParent;
      const back = document.createElement("button");
      back.className = "inst-parent-chip";
      setIconLabel(back, "prev", "$" + parent.toString(16).toUpperCase().padStart(3, "0") + " " +
        (unescapeName(doc.instrumentName(parent)) || t("inst.unnamed")));
      back.title = t("inst.backToMeta");
      back.addEventListener("click", () => {
        this._childSelected = null;
        this._childParent = null;
        this.selected = parent;
        this.tab = "meta";
        this.refresh();
      });
      row.appendChild(back);
    }
    const idx = document.createElement("span");
    idx.className = "inst-name-idx";
    idx.textContent = "$" + slot.toString(16).toUpperCase().padStart(3, "0");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inst-name-input";
    input.value = unescapeName(doc.instrumentName(slot)) || "";
    input.placeholder = t("inst.namePlaceholder");
    input.title = t("inst.nameTitle");
    input.addEventListener("change", () => {
      const escaped = escapeNonAscii(input.value.trim());
      if (escaped === (doc.instrumentName(slot) ?? "")) return;
      this.store.undo.apply(setSectionOp("INam", doc.buildInstrumentNames(slot, escaped)));
      this.refreshListLabel(slot);
      this.store.emit("status"); // status bar / other views pick up the name
    });
    const dupBtn = document.createElement("button");
    dupBtn.className = "inst-dup-btn";
    dupBtn.textContent = t("inst.duplicate");
    dupBtn.title = t("inst.duplicateTitle");
    dupBtn.addEventListener("click", () => this.duplicateInstrument());
    const renumBtn = document.createElement("button");
    renumBtn.className = "inst-renum-btn";
    renumBtn.textContent = t("inst.renumber");
    renumBtn.title = t("inst.renumberTitle");
    renumBtn.addEventListener("click", () => this.renumber());
    const delBtn = document.createElement("button");
    delBtn.className = "inst-del-btn";
    delBtn.textContent = t("inst.delete");
    delBtn.title = t("inst.deleteTitle");
    delBtn.addEventListener("click", () => this.deleteInstrument());
    row.append(idx, input, dupBtn, renumBtn, delBtn);
    return row;
  }

  /** Duplicate the selected instrument (item 114): a derivative copy that
   *  SHARES its source's samples — one slot, no pool bytes — so tweaking one
   *  field (fadeout, an envelope, the filter) needs no re-import. No dialog:
   *  the copy is one undo step away, and the selection moves onto it so the
   *  tweak can start immediately. A metainstrument copies its layer children
   *  too, so editing the copy's layers can't change the original's sound. */
  duplicateInstrument() {
    const doc = this.store.doc;
    const slot = this.selected;
    if (!doc || !doc.usedInstrumentSlots().includes(slot)) return;
    const plan = planDuplicateInstruments(doc, [slot]);
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(importBankOp(plan));

    // The copy is a top-level instrument even when the source was a layer child
    // (item 59 keeps children off the list), so the breadcrumb ends here.
    this.selected = plan.duplicates[0].destSlot;
    this._childSelected = null;
    this._childParent = null;
    this.advanced = false;
    this.jam.currentInst = this.selected;
    this.store.emit("instsel");
    this.store.emit("status");
    this.refresh();
  }

  /** Delete the selected instrument. The dialog adapts to the situation: notes
   *  reference it (offer reassign, else leave dangling); it is a metainstrument
   *  layer child (rewire the parents); it is a metainstrument (cascade-delete its
   *  now-orphaned $100+ sub-instruments, offer to delete its $01–$FF ones); and/or
   *  it uniquely owns samples (offer to free them). One undo step; selection moves
   *  off the slot. */
  async deleteInstrument() {
    const doc = this.store.doc;
    const slot = this.selected;
    if (!doc || !doc.usedInstrumentSlots().includes(slot)) return;
    const wide = slot > 0xff;
    const label = "$" + slot.toString(16).toUpperCase().padStart(wide ? 3 : 2, "0");
    const name = unescapeName(doc.instrumentName(slot)) || t("inst.unnamed");

    const hex3 = (x) => "$" + x.toString(16).toUpperCase().padStart(3, "0");
    const refs = instrumentCellRefs(doc, slot);      // note references (all songs; [] for $100+)
    const parents = metainstrumentParents(doc, slot); // metas to rewire (deleting a child)
    // Metainstrument cascade: $100+ orphans auto-delete; $01–$FF children opt-in.
    const { autoChildren, lowChildren } = classifyMetaChildren(doc, slot);
    // Samples freed by the always-deleted set (this inst + its auto-cascade kids).
    const spans = uniqueSampleSpansForSet(doc, [slot, ...autoChildren]);
    const uniqueBytes = spans.reduce((n, s) => n + s.len, 0);

    const bodyParts = [];
    if (refs.length > 0) bodyParts.push(t("del.bodyRefs", { n: refs.length }));
    if (parents.length > 0) {
      bodyParts.push(t("del.bodyMeta", { n: parents.length, metas: parents.map((p) => hex3(p.slot)).join(", ") }));
    }
    if (autoChildren.length > 0) {
      bodyParts.push(t("del.bodyAutoChildren", { n: autoChildren.length, list: autoChildren.map(hex3).join(", ") }));
    }
    if (lowChildren.length > 0) {
      const list = lowChildren.map((c) => t("del.lowChild", { slot: hex3(c.slot), n: c.patternRefs })).join(", ");
      bodyParts.push(t("del.bodyLowChildren", { n: lowChildren.length, list }));
    }
    if (refs.length === 0 && parents.length === 0 && autoChildren.length === 0 && lowChildren.length === 0) {
      bodyParts.push(t("del.bodyClean"));
    }

    const fields = [];
    if (refs.length > 0) {
      fields.push({ name: "reassign", label: t("del.reassignTo"), type: "text",
        value: "", placeholder: t("del.reassignPlaceholder") });
    }
    if (lowChildren.length > 0) {
      fields.push({ name: "deleteLow", type: "checkbox", value: false,
        label: t("del.deleteLow", { n: lowChildren.length }) });
    }
    if (spans.length > 0) {
      fields.push({ name: "free", type: "checkbox", value: true,
        label: t("del.freeSamples", { n: spans.length, kb: (uniqueBytes / 1024).toFixed(1) }) });
    }

    const res = await showModal({
      title: t("del.title", { slot: label, name }),
      body: bodyParts.join(" "),
      fields,
      okLabel: t("del.ok"),
    });
    if (!res) return;

    let reassignTo = null;
    if (refs.length > 0) {
      const raw = String(res.reassign ?? "").replace(/^\$/, "").trim();
      if (raw !== "") {
        reassignTo = parseInt(raw, 16);
        if (!Number.isFinite(reassignTo) || reassignTo < 1 || reassignTo > 0xff) {
          alert(t("del.badNumber"));
          return;
        }
      }
    }
    const freeSamples = spans.length > 0 && res.free === true;
    const deleteLowChildren = lowChildren.length > 0 && res.deleteLow === true;

    const plan = planDeleteInstrument(doc, slot, { freeSamples, reassignTo, deleteLowChildren });
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(deleteInstrumentOp(plan));

    // Move selection off the deleted slot. A layer child returns to its parent
    // (unless the parent was itself deleted/emptied); anything else falls to the
    // first remaining selectable instrument.
    const removed = new Set([...plan.emptiedMetas, slot, ...plan.autoChildren, ...plan.deletedLowChildren]);
    const parentAlive = this._childParent !== null && !removed.has(this._childParent) &&
      doc.usedInstrumentSlots().includes(this._childParent);
    if (this._childSelected === slot && parentAlive) {
      this.selected = this._childParent;
      this._childSelected = null;
      this._childParent = null;
      this.tab = doc.instruments[this.selected].isMeta ? "meta" : "general";
    } else {
      this._childSelected = null;
      this._childParent = null;
      const remaining = doc.selectableInstrumentSlots();
      this.selected = remaining[0] ?? 1;
    }
    this.advanced = false;
    if (this.jam.currentInst === slot || !doc.usedInstrumentSlots().includes(this.jam.currentInst)) {
      this.jam.currentInst = this.selected;
    }
    this.store.emit("instsel");
    this.store.emit("status");
    this.refresh();
  }

  /** Renumber the selected instrument (item 73). Wiring references (Ixmp slot
   *  id, INam, metainstrument layers) always follow; pattern cells only when the
   *  user asks — moving an instrument out from under its notes is a musical
   *  decision, so the box is off by default. */
  async renumber() {
    const doc = this.store.doc;
    const from = this.selected;
    if (!doc || !doc.usedInstrumentSlots().includes(from)) return;
    const refs = instrumentCellRefs(doc, from).length;
    const res = await showModal({
      title: t("renum.title", { slot: "$" + from.toString(16).toUpperCase().padStart(2, "0") }),
      body: refs > 0 ? t("renum.bodyRefs", { n: refs }) : t("renum.body"),
      fields: [
        { name: "to", label: t("renum.to"), type: "text",
          value: from.toString(16).toUpperCase().padStart(2, "0") },
        { name: "cells", label: t("renum.remapPatterns"), type: "checkbox", value: false },
      ],
      okLabel: t("renum.ok"),
    });
    if (!res) return;
    const to = parseInt(String(res.to).replace(/^\$/, ""), 16);
    if (!Number.isFinite(to)) { alert(t("renum.badNumber")); return; }
    const plan = planRenumberInstrument(doc, from, to, { remapPatterns: res.cells === true });
    if (plan.error) { alert(plan.error); return; }
    this.store.undo.apply(renumberInstrumentOp(plan));
    this.selected = to;
    if (this._childSelected === from) this._childSelected = to;
    if (this.jam.currentInst === from) this.jam.currentInst = to;
    this.store.emit("instsel");
    this.store.emit("status");
    this.refresh();
  }

  /** Repaint one list row's name span in place (after a rename). */
  refreshListLabel(slot) {
    const r = this.rowEls?.find((e) => e.slot === slot);
    const nameEl = r?.el.querySelector(".name");
    if (nameEl) nameEl.textContent = unescapeName(this.store.doc.instrumentName(slot)) || t("inst.unnamed");
  }

  /** Repaint one list row's kind badge (IXMP·n) after a patch edit. */
  refreshListBadge(slot) {
    const r = this.rowEls?.find((e) => e.slot === slot);
    const badge = r?.el.querySelector(".badge-sm");
    if (!badge) return;
    const inst = this.store.doc.instruments[slot];
    badge.textContent = inst.isMeta ? "META" : inst.extraPatches ? `IXMP·${inst.extraPatches.length}` : "";
  }

  /** Open a metainstrument's layer child (item 71) in its own base editor.
   *  Children are kept out of the list (item 59), so `_childSelected` pins the
   *  selection across rebuilds and `_childParent` feeds the breadcrumb back. */
  openChild(slot, parentSlot) {
    this._childSelected = slot;
    this._childParent = parentSlot;
    this.selected = slot;
    this.advanced = false;
    this.tab = this.store.doc?.instruments[slot]?.isMeta ? "meta" : "general";
    this.refresh();
  }

  openAdvanced() {
    this.advanced = true;
    this.renderPanel();
  }

  closeAdvanced() {
    this.advanced = false;
    this.renderTabs();
    this.renderPanel();
  }

  /** Apply an inst op WITHOUT rebuilding the panel — for slider drags whose
   *  widgets update themselves in place (a rebuild would detach the control
   *  mid-drag). The engine still re-syncs via the dirty tag. */
  applyQuiet(op) {
    this._quiet = true;
    try { this.store.undo.apply(op); }
    finally { this._quiet = false; }
  }

  /** A titled group of stacked field rows (taut.js drawGroupHeader layout —
   *  Volume / Panning / Filter / Vibrato / Note actions / …). */
  group(title, ...rows) {
    const head = document.createElement("div");
    head.className = "inst-group-head";
    head.textContent = title;
    this.panel.appendChild(head);
    const box = document.createElement("div");
    box.className = "inst-rows";
    box.append(...rows.filter(Boolean));
    this.panel.appendChild(box);
  }

  /** label · editable number spinner · annotation · range slider. `onChange`
   *  receives (value, gestureId); a range drag reuses one gestureId so it
   *  collapses to a single undo step. `opts`: {ann, wide, log, signedLog}. When
   *  `log` the slider TRAVEL is logarithmic (fine control at the low end) while
   *  the spinner/annotation still show the real value; slider bottom pins to
   *  `min` (which may be 0 = "off"), the rest spans log(max(min,1))..log(max).
   *  `signedLog` is the two-sided variant: position 0 = value 0 at the centre,
   *  ±1..±N log-spaced out to ±max|min| — fine control near zero in BOTH
   *  directions (used by the full-range signed detune slider). */
  sliderRow(label, value, min, max, onChange, opts = {}) {
    const row = document.createElement("div");
    row.className = "slider-row" + (opts.wide ? " wide" : "");
    const lab = document.createElement("span");
    lab.className = "sl-label"; lab.textContent = label;
    const num = document.createElement("input");
    num.type = "number"; num.className = "sl-num";
    num.min = min; num.max = max; num.value = value;
    const ann = document.createElement("span");
    ann.className = "sl-ann";
    const range = document.createElement("input");
    range.type = "range"; range.className = "sl-range";

    // Value ⇄ slider-position mapping. Linear by default; logarithmic when
    // opts.log (position 0..LOG_STEPS, 0 → min, 1..N → exp-spaced [lo, max]).
    const LOG_STEPS = 1000;
    const lo = Math.max(min, 1);
    const mag = Math.max(Math.abs(min), Math.abs(max), 2); // signedLog span
    const symDenom = Math.log(1 + mag);                    // symlog normaliser
    const toPos = (v) => {
      if (opts.signedLog) {
        // Symmetric log (matplotlib symlog): log(1+|v|) is near-LINEAR through
        // zero, so 0 sits exactly at the centre, ±1 land at distinct, visible
        // positions, and the scale only compresses toward the extremes. (Pure
        // log has no value at 0 and collapses every |v|<=1 onto the centre.)
        const s = v < 0 ? -1 : 1;
        const a = Math.min(Math.abs(v), mag);
        return Math.round(s * (Math.log(1 + a) / symDenom) * LOG_STEPS);
      }
      if (!opts.log) return v;
      if (v <= min) return 0;
      const t = (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(max) - Math.log(lo));
      return Math.round(1 + t * (LOG_STEPS - 1));
    };
    const fromPos = (p) => {
      if (opts.signedLog) {
        const s = p < 0 ? -1 : 1;
        const t = Math.abs(p) / LOG_STEPS;
        return s * Math.round(Math.exp(t * symDenom) - 1);
      }
      if (!opts.log) return p;
      if (p <= 0) return min;
      const t = (p - 1) / (LOG_STEPS - 1);
      return Math.round(Math.exp(Math.log(lo) + t * (Math.log(max) - Math.log(lo))));
    };
    range.min = opts.signedLog ? -LOG_STEPS : (opts.log ? 0 : min);
    range.max = opts.signedLog ? LOG_STEPS : (opts.log ? LOG_STEPS : max);
    range.step = 1;
    range.value = toPos(clampN(value, min, max));

    const paint = (v) => { if (opts.ann) ann.textContent = opts.ann(v); };
    paint(value);

    let gid = null;
    const commit = (v, g) => {
      v = clampN(Math.round(v), min, max);
      num.value = v; range.value = toPos(v); paint(v);
      onChange(v, g);
    };
    range.addEventListener("pointerdown", () => { gid = "sl" + Date.now() + Math.random(); });
    range.addEventListener("keydown", () => { if (!gid) gid = "sl" + Date.now(); });
    range.addEventListener("input", () => commit(fromPos(parseFloat(range.value)), gid ?? ("sl" + Date.now())));
    range.addEventListener("change", () => { gid = null; });
    num.addEventListener("change", () => commit(parseInt(num.value || "0", 10), null));

    row.append(lab, num, ann, range);
    return row;
  }

  /** Spinner-only row (values whose range is too wide for a useful slider). */
  numRow(label, value, min, max, onChange, opts = {}) {
    const row = document.createElement("div");
    row.className = "slider-row noslider";
    const lab = document.createElement("span");
    lab.className = "sl-label"; lab.textContent = label;
    const num = document.createElement("input");
    num.type = "number"; num.className = "sl-num wide"; num.min = min; num.max = max; num.value = value;
    const ann = document.createElement("span");
    ann.className = "sl-ann";
    if (opts.ann) ann.textContent = opts.ann(value);
    num.addEventListener("change", () => {
      const v = clampN(parseInt(num.value || "0", 10), min, max);
      num.value = v; if (opts.ann) ann.textContent = opts.ann(v);
      onChange(v);
    });
    row.append(lab, num, ann);
    return row;
  }

  /** label · checkbox (with on/off text) row. */
  checkRow(label, checked, onChange) {
    const row = document.createElement("div");
    row.className = "slider-row check";
    const lab = document.createElement("span");
    lab.className = "sl-label"; lab.textContent = label;
    const wrap = document.createElement("label");
    wrap.className = "sl-check";
    const c = document.createElement("input");
    c.type = "checkbox"; c.checked = checked;
    c.addEventListener("change", () => onChange(c.checked));
    wrap.append(c, document.createTextNode(checked ? t("inst.on") : t("inst.off")));
    row.append(lab, wrap);
    return row;
  }

  selectRow(label, value, options, onChange) {
    const row = document.createElement("div");
    row.className = "slider-row select";
    const lab = document.createElement("span");
    lab.className = "sl-label"; lab.textContent = label;
    const group = document.createElement("div");
    group.className = "sl-buttons";
    options.forEach(([v, text]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.className = v === value ? "active" : "";
      b.addEventListener("click", () => onChange(v));
      group.appendChild(b);
    });
    row.append(lab, group);
    return row;
  }

  /** WIDE detune slider spanning the FULL signed 16-bit range (-32768..32767)
   *  on a signed-logarithmic scale — fine control near zero in both directions,
   *  the ±8-octave extremes still reachable — with an editable signed spinner
   *  plus hex-word and cents readout (taut.js detuneRow). */
  detuneRow(inst) {
    const min = -0x8000, max = 0x7fff;
    const value = inst.sampleDetuneSigned;
    const ann = (v) =>
      `$${(v & 0xffff).toString(16).toUpperCase().padStart(4, "0")} · ` +
      `${((v * 1200) / 4096).toFixed(1)} cents, 4096-TET`;
    return this.sliderRow(t("inst.detune"), value, min, max,
      (v, gid) => this.applyQuiet(setInstFieldOp(this.selected, "sampleDetune", v & 0xffff, gid)),
      { ann, wide: true, signedLog: true });
  }

  /**
   * The instrument's default position (#998). A stereo song sees the pan byte
   * it always saw; a surround song sees the same byte as the low eight bits of
   * a NINE-bit azimuth (the ninth is record byte 14's bit 5), so the default
   * can sit behind the listener, and a spatial song additionally gets the
   * elevation from byte 254. Both extra fields are hidden in a stereo song
   * because the engine ignores them there — nothing would come of editing them.
   */
  defaultPositionRows(inst) {
    const model = this.store.doc?.songs[this.store.songIndex]?.surroundModel ?? SURROUND_STEREO;
    if (model === SURROUND_STEREO) {
      return [this.sliderRow(t("inst.defaultPan"), inst.defaultPan, 0, 255,
        (v, gid) => this.applyQuiet(setInstFieldOp(this.selected, "defaultPan", v, gid)),
        { ann: annHex2 })];
    }
    const rows = [
      // One op for the pair: the azimuth's ninth bit lives in another byte, and
      // a drag that wrote them separately would undo in two steps.
      this.sliderRow(t("inst.defaultAzimuth"), inst.defaultAzimuth, 0, 511, (v, gid) =>
        this.applyQuiet(setInstBytesOp(this.selected, [
          [177, v & 0xff],
          [14, (inst.getByteNormal(14) & ~0x20) | (v >= 256 ? 0x20 : 0)],
        ], gid)), { ann: azimuthLabel }),
    ];
    if (model === SURROUND_SPATIAL) {
      rows.push(this.sliderRow(t("inst.defaultElevation"), inst.defaultElevation, -128, 127,
        (v, gid) => this.applyQuiet(setInstBytesOp(this.selected, [[254, v & 0xff]], gid)),
        { ann: elevationLabel }));
    }
    return rows;
  }

  renderGeneral(inst) {
    const fSet = (key) => (v, gid) => this.applyQuiet(setInstFieldOp(this.selected, key, v, gid));
    const flagSet = (mask, shift) => (v) =>
      this.setField("instrumentFlag", (inst.instrumentFlag & ~(mask << shift)) | ((v & mask) << shift));
    const fadeout = inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8);
    const sfMode = inst.filterSfMode;
    // NNA UI value: 4 = Key Lift (flag bit 5), else 0..3 (flag bits 0-1).
    const nna = ((inst.instrumentFlag >> 5) & 1) ? 4 : (inst.instrumentFlag & 3);

    this.group(t("inst.grpVolume"),
      this.sliderRow(t("inst.globalVol"), inst.instGlobalVolume, 0, 255, fSet("instGlobalVolume"), { ann: annHex2 }),
      this.sliderRow(t("inst.defaultNoteVol"), inst.defaultNoteVolume, 0, 255, fSet("defaultNoteVolume"), { ann: annHex2 }),
      this.sliderRow(t("inst.fadeout"), fadeout, 0, 1024, (v, gid) =>
        this.applyQuiet(setInstBytesOp(this.selected,
          [[172, v & 0xff], [173, (inst.fadeoutHigh & 0x10) | ((v >> 8) & 0x0f)]], gid)),
        { ann: annFadeout, log: true }),
      this.sliderRow(t("inst.swing"), inst.volumeSwing, 0, 255, fSet("volumeSwing"), { ann: annHex2 }),
    );

    this.group(t("inst.grpPanning"),
      ...this.defaultPositionRows(inst),
      this.sliderRow(t("inst.pitchPanSep"), inst.pitchPanSeparation, -128, 127, fSet("pitchPanSeparation")),
      this.sliderRow(t("inst.panSwing"), inst.panSwing, 0, 255, fSet("panSwing"), { ann: annHex2 }),
      this.sliderRow(t("inst.pitchPanCentre"), inst.pitchPanCentre, 0, 0xffff, fSet("pitchPanCentre"), { ann: annHex4 }),
      // Pan LOOP word bit 7 = "use default pan" (engine trigger.js:280).
      this.checkRow(t("inst.useDefaultPan"), ((inst.panEnvLoop >> 7) & 1) !== 0,
        (on) => this.setEnvWordBit("panEnvLoop", 7, on)),
    );

    this.group(t("inst.grpFilter"),
      this.selectRow(t("inst.filterModeLabel"), sfMode ? 1 : 0, [[0, "ImpulseTracker"], [1, "SoundFont2"]],
        (v) => this.setField("fadeoutHigh", (inst.fadeoutHigh & 0x0f) | (v << 4))),
      sfMode
        // SoundFont: 16-bit cutoff (absolute cents, bytes 182/252) → Hz,
        // resonance (centibels above DC gain, bytes 183/253) → dB.
        ? this.sliderRow(t("inst.cutoff"), inst.defaultCutoff16, 1500, 13500, (v, gid) =>
            this.applyQuiet(setInstBytesOp(this.selected, [[182, (v >> 8) & 0xff], [252, v & 0xff]], gid)),
            { ann: annSfCutoff })
        : this.sliderRow(t("inst.cutoff"), inst.defaultCutoff, 0, 255, fSet("defaultCutoff"), { ann: annFilter }),
      sfMode
        ? this.sliderRow(t("inst.resonance"), inst.defaultResonance16, 0, 960, (v, gid) =>
            this.applyQuiet(setInstBytesOp(this.selected, [[183, (v >> 8) & 0xff], [253, v & 0xff]], gid)),
            { ann: annSfReso })
        : this.sliderRow(t("inst.resonance"), inst.defaultResonance, 0, 255, fSet("defaultResonance"), { ann: annFilter }),
    );

    this.group(t("inst.grpVibrato"),
      this.selectRow(t("inst.vibWaveLabel"), (inst.instrumentFlag >> 2) & 7,
        [[0, t("inst.vibSine")], [1, t("inst.vibRampDown")], [2, t("inst.vibSquare")],
         [3, t("inst.vibRandom")], [4, t("inst.vibRampUp")]],
        flagSet(7, 2)),
      this.sliderRow(t("inst.vibSpeed"), inst.vibratoSpeed, 0, 255, fSet("vibratoSpeed"), { ann: annHex2 }),
      this.sliderRow(t("inst.vibDepth"), inst.vibratoDepth, 0, 255, fSet("vibratoDepth"), { ann: annHex2 }),
      this.sliderRow(t("inst.vibSweep"), inst.vibratoSweep, 0, 255, fSet("vibratoSweep"), { ann: annHex2 }),
      this.sliderRow(t("inst.vibRate"), inst.vibratoRate, 0, 255, fSet("vibratoRate"), { ann: annHex2 }),
    );

    this.group(t("inst.grpNoteActions"),
      this.selectRow(t("inst.nna"), nna,
        [[1, t("inst.nnaNoteCut")], [2, t("inst.nnaContinue")],
         [0, t("inst.nnaNoteOff")], [3, t("inst.nnaNoteFade")], [4, t("inst.nnaKeyLift")]],
        (v) => {
          // Key Lift = bit 5 set, NNA bits 0-1 = 00 (the 0b100 "Nnn" pattern);
          // 0..3 = traditional NNA with bit 5 clear. Preserve vib-waveform bits.
          const base = inst.instrumentFlag & ~0x23;
          this.setField("instrumentFlag", v === 4 ? (base | 0x20) : (base | (v & 3)));
        }),
      this.selectRow(t("inst.dct"), inst.dupCheckFlag & 3,
        [[0, t("inst.dctNever")], [1, t("inst.dctNote")], [2, t("inst.dctSample")], [3, t("inst.dctInstrument")]],
        (v) => this.setField("dupCheckFlag", (inst.dupCheckFlag & ~3) | v)),
      this.selectRow(t("inst.dca"), (inst.dupCheckFlag >> 2) & 3,
        [[0, t("inst.dcaCut")], [1, t("inst.dcaOff")], [2, t("inst.dcaFade")]],
        (v) => this.setField("dupCheckFlag", (inst.dupCheckFlag & ~0x0c) | (v << 2))),
    );

    // Sample section — the visual play/loop/sustain editor lives in a modal
    // (same style as the Samples-tab editor, but scoped to THIS instrument).
    const editRow = document.createElement("div");
    editRow.className = "slider-row";
    const editLab = document.createElement("span");
    editLab.className = "sl-label";
    editLab.textContent = t("inst.playLoopSustain");
    const editBtn = document.createElement("button");
    editBtn.textContent = t("smp.edit");
    editBtn.title = t("inst.sampleEditTitle");
    editBtn.disabled = inst.sampleLength <= 0;
    editBtn.addEventListener("click", async () => {
      const { openInstSampleEditor } = await import("../popups/sampleeditor.js");
      await openInstSampleEditor(this.store, this.selected);
      this.renderPanel();
    });
    editRow.append(editLab, editBtn);

    this.group(t("inst.grpSample"),
      this.numRow(t("inst.samplePtr"), inst.samplePtr, 0, 8388607, (v) => this.setField("samplePtr", v), { ann: annHex6 }),
      this.numRow(t("inst.sampleLen"), inst.sampleLength, 0, 65535, (v) => this.setField("sampleLength", v)),
      this.numRow(t("inst.rateC4"), inst.samplingRate, 0, 65535, (v) => this.setField("samplingRate", v), { ann: (v) => v + " Hz" }),
      this.numRow(t("inst.loopStart"), inst.sampleLoopStart, 0, 65535, (v) => this.setField("sampleLoopStart", v)),
      this.numRow(t("inst.loopEnd"), inst.sampleLoopEnd, 0, 65535, (v) => this.setField("sampleLoopEnd", v)),
      this.selectRow(t("inst.loopMode"), inst.loopMode & 3,
        [[0, t("smp.loopOff")], [1, t("smp.loopForward")], [2, t("smp.loopPingpong")], [3, t("smp.loopOneshot")]],
        (v) => this.setField("loopMode", (inst.loopMode & ~3) | v)),
      this.checkRow(t("inst.percussion"), ((inst.loopMode >> 4) & 1) !== 0,
        (on) => this.setField("loopMode", (inst.loopMode & ~0x10) | (on ? 0x10 : 0))),
      editRow,
    );

    this.group(t("inst.grpTuning"), this.detuneRow(inst));
  }

  renderEnv(inst, tabDef) {
    const env = inst[tabDef.key];
    // Pitch/Filter "present" is whether THIS tab currently holds the role
    // (tabDef.roleActive) — the raw loop-key P bit belongs to whichever
    // physical slot resolved to the tab, which may be the OTHER role.
    const present = tabDef.role ? tabDef.roleActive : envPresent(inst[tabDef.loopKey]);
    const head = document.createElement("div");
    head.className = "detail-info";
    const label = t(tabDef.labelKey);
    const stateWord = escape(t(present ? "inst.envStatePresent" : "inst.envStateAbsent"));
    const state = present ? `<b class="env-present">${stateWord}</b>` : `<b>${stateWord}</b>`;
    head.innerHTML = t("inst.envHeaderState", { label, state });
    this.panel.appendChild(head);

    const canvas = document.createElement("canvas");
    canvas.className = "wave-canvas";
    this.panel.appendChild(canvas);
    this.envCanvas = { canvas, env, tabDef, inst, head };

    const active = this.envActiveCount(env);
    this.selectedNode = Math.min(Math.max(this.selectedNode, 0), active - 1);
    this.drawEnvGraph();

    canvas.addEventListener("pointerdown", (e) => this.envPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.envPointerMove(e));
    canvas.addEventListener("pointerup", () => {
      const dragged = this.dragState !== null;
      this.dragState = null;
      // Re-render was suppressed during the drag; settle header + spinners now
      // (a role claim can change which slot each tab resolves to).
      if (dragged) this.renderPanel();
    });

    this.panel.appendChild(this.buildEnvControls(inst, tabDef, env, active));
  }

  /** Active node count: nodes 0..N where N is the first zero-duration
   *  (terminator) node, capped at 25 (the physical slot count). */
  envActiveCount(env) {
    for (let i = 0; i < 24; i++) if (env[i].offset === 0) return i + 1;
    return 25;
  }

  setEnvWordBit(key, bit, on) {
    const cur = this.store.doc.instruments[this.selected][key];
    const nw = on ? (cur | (1 << bit)) : (cur & ~(1 << bit));
    this.store.undo.apply(setInstFieldOp(this.selected, key, nw & 0xffff));
  }

  /** Pitch/Filter "envelope present" toggle. Turning it ON CLAIMS the resolved
   *  slot for the role — present bit (13) + role m-bit (bit 7: set = filter,
   *  clear = pitch) — the same claim a first node-drag performs; OFF just clears
   *  the present bit. renderPanel re-runs after (inst edit) and re-resolves the
   *  tab's slot. */
  setRolePresent(tabDef, on) {
    const cur = this.store.doc.instruments[this.selected][tabDef.loopKey];
    const nw = on
      ? ((cur | 0x2000) & ~0x80) | (tabDef.role === "filter" ? 0x80 : 0)
      : (cur & ~0x2000);
    this.store.undo.apply(setInstFieldOp(this.selected, tabDef.loopKey, nw & 0xffff));
  }

  setEnvWordField(key, shift, mask, val) {
    const cur = this.store.doc.instruments[this.selected][key];
    const v = Math.min(Math.max(val | 0, 0), mask);
    const nw = (cur & ~(mask << shift)) | (v << shift);
    this.store.undo.apply(setInstFieldOp(this.selected, key, nw & 0xffff));
  }

  /** Insert a node after `sel`: split its segment (interior) or extend the tail. */
  addEnvNode(tabDef, env, sel, max) {
    const active = this.envActiveCount(env);
    if (active >= 25) return;
    const nodes = env.map((n) => ({ value: n.value, offset: n.offset }));
    if (sel >= active - 1) {
      // Extend the envelope: give the last node a span, append a terminator.
      nodes[active - 1] = { value: env[active - 1].value, offset: minifloatFromDouble(0.1) };
      nodes[active] = { value: env[active - 1].value, offset: 0 };
      this.selectedNode = active;
    } else {
      const total = minifloatToDouble(env[sel].offset);
      const half = minifloatFromDouble(total / 2);
      const midVal = Math.round((env[sel].value + env[sel + 1].value) / 2);
      for (let i = 24; i > sel + 1; i--) nodes[i] = { value: nodes[i - 1].value, offset: nodes[i - 1].offset };
      nodes[sel].offset = half;
      nodes[sel + 1] = { value: Math.min(Math.max(midVal, 0), max),
        offset: minifloatFromDouble(Math.max(total - minifloatToDouble(half), 0)) };
      this.selectedNode = sel + 1;
    }
    this.store.undo.apply(setEnvArrayOp(this.selected, tabDef.key, nodes));
  }

  /** Delete node `sel` (node 0 is anchored at t=0 and cannot be removed). */
  removeEnvNode(tabDef, env, sel) {
    const active = this.envActiveCount(env);
    if (sel === 0 || active <= 1) return;
    const nodes = env.map((n) => ({ value: n.value, offset: n.offset }));
    // Merge the removed segment into the previous node so later timing is kept.
    const merged = minifloatToDouble(env[sel - 1].offset) + minifloatToDouble(env[sel].offset);
    nodes[sel - 1].offset = minifloatFromDouble(merged);
    for (let i = sel; i < 24; i++) nodes[i] = { value: env[i + 1].value, offset: env[i + 1].offset };
    this.selectedNode = Math.max(sel - 1, 0);
    this.store.undo.apply(setEnvArrayOp(this.selected, tabDef.key, nodes));
  }

  /** Spinner/checkbox control panel below the envelope graph. */
  buildEnvControls(inst, tabDef, env, active) {
    const max = tabDef.max;
    const wrap = document.createElement("div");
    wrap.className = "env-controls";
    const sel = this.selectedNode;
    const node = env[sel];

    const spin = (label, value, min, hi, step, onChange) => {
      const l = document.createElement("label");
      l.className = "env-ctl";
      l.append(document.createTextNode(label));
      const inp = document.createElement("input");
      inp.type = "number"; inp.value = value; inp.min = min; inp.max = hi;
      if (step) inp.step = step;
      inp.addEventListener("change", () => onChange(inp.value));
      l.appendChild(inp);
      return l;
    };
    /** …and one whose stored units are not the ones on screen (item 156.2). */
    const spinMapped = (label, map, raw, onChange) => {
      const l = document.createElement("label");
      l.className = "env-ctl";
      l.append(document.createTextNode(label));
      const inp = document.createElement("input");
      mapSpinner(inp, map, raw);
      inp.addEventListener("change", () => onChange(inp.rawValue));
      l.appendChild(inp);
      return l;
    };
    const chk = (label, checked, onChange) => {
      const l = document.createElement("label");
      l.className = "env-ctl chk";
      const c = document.createElement("input");
      c.type = "checkbox"; c.checked = checked;
      c.addEventListener("change", () => onChange(c.checked));
      l.append(c, document.createTextNode(label));
      return l;
    };
    const btn = (label, title, onClick, disabled) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title; b.disabled = !!disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const row = (...kids) => { const d = document.createElement("div"); d.className = "env-row"; d.append(...kids); return d; };

    // node select + value + segment duration + add/remove
    wrap.appendChild(row(
      spin(t("env.node"), sel, 0, active - 1, 1, (v) => {
        this.selectedNode = Math.min(Math.max(parseInt(v, 10) || 0, 0), active - 1);
        this.renderPanel();
      }),
      spin(t("env.value"), node.value, 0, max, 1, (v) =>
        this.store.undo.apply(setEnvPointOp(this.selected, tabDef.key, sel,
          { value: Math.min(Math.max(parseInt(v, 10) || 0, 0), max) }))),
      spinMapped(t("env.seg"), SEG_MINIFLOAT_MAP, node.offset, (code) =>
        this.store.undo.apply(setEnvPointOp(this.selected, tabDef.key, sel,
          { offset: code }))),
      btn(t("env.addNode"), t("adv.addNodeTitle"),
        () => this.addEnvNode(tabDef, env, sel, max), active >= 25),
      btn(t("env.removeNode"), t("adv.removeNodeTitle"),
        () => this.removeEnvNode(tabDef, env, sel), active <= 1 || sel === 0),
    ));

    // sustain point + range
    const susW = inst[tabDef.susKey];
    wrap.appendChild(row(
      chk(t("env.sustain"), ((susW >> 5) & 1) !== 0, (on) => this.setEnvWordBit(tabDef.susKey, 5, on)),
      spin(t("env.start"), (susW >> 8) & 0x1f, 0, active - 1, 1, (v) => this.setEnvWordField(tabDef.susKey, 8, 0x1f, parseInt(v, 10) || 0)),
      spin(t("env.end"), susW & 0x1f, 0, active - 1, 1, (v) => this.setEnvWordField(tabDef.susKey, 0, 0x1f, parseInt(v, 10) || 0)),
    ));

    // loop point + range
    const loopW = inst[tabDef.loopKey];
    wrap.appendChild(row(
      chk(t("env.loop"), ((loopW >> 5) & 1) !== 0, (on) => this.setEnvWordBit(tabDef.loopKey, 5, on)),
      spin(t("env.start"), (loopW >> 8) & 0x1f, 0, active - 1, 1, (v) => this.setEnvWordField(tabDef.loopKey, 8, 0x1f, parseInt(v, 10) || 0)),
      spin(t("env.end"), loopW & 0x1f, 0, active - 1, 1, (v) => this.setEnvWordField(tabDef.loopKey, 0, 0x1f, parseInt(v, 10) || 0)),
    ));

    // Final row: logarithmic time-axis toggle for the graph above, plus (on
    // Vol/Pan tabs) the envelope-present toggle. Pitch/Filter presence is the
    // role claim, so those tabs show only the log toggle.
    const logChk = chk(t("env.logTimescale"), this.envLogTime,
      (on) => { this.envLogTime = on; this.drawEnvGraph(); });
    // "Envelope present" — for Vol/Pan it toggles the LOOP-word P bit directly;
    // for Pitch/Filter (role) tabs it claims/releases the resolved slot's role
    // (item 36), so the checkbox tracks roleActive.
    wrap.appendChild(row(
      tabDef.role
        ? chk(t("env.present"), tabDef.roleActive, (on) => this.setRolePresent(tabDef, on))
        : chk(t("env.present"), envPresent(inst[tabDef.loopKey]),
            (on) => this.setEnvWordBit(tabDef.loopKey, 13, on)),
      logChk,
    ));
    return wrap;
  }

  /** Fraction 0..1 of the time axis for time `t` (linear or log). */
  envTimeFrac(t, total) {
    if (!this.envLogTime) return total > 0 ? t / total : 0;
    const t0 = Math.max(total / 400, 1e-4);
    return Math.log((t + t0) / t0) / Math.log((total + t0) / t0);
  }

  /** Inverse of envTimeFrac: seconds for axis fraction `f`. */
  envFracTime(f, total) {
    if (!this.envLogTime) return f * total;
    const t0 = Math.max(total / 400, 1e-4);
    return t0 * (Math.pow((total + t0) / t0, f) - 1);
  }

  envGeometry() {
    const { canvas, env } = this.envCanvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // cumulative time axis; span only the ACTIVE envelope (to its terminator).
    const times = [0];
    for (let i = 0; i < 24; i++) times.push(times[i] + minifloatToDouble(env[i].offset));
    const active = this.envActiveCount(env);
    const total = Math.max(times[active - 1], 0.25);
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
    const C = themeColors();
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);

    const { times, total } = this.envGeometry();
    const Xt = (t) => 10 + this.envTimeFrac(t, total) * (w - 20) * ENV_TIME_FRAC;
    const X = (i) => Xt(times[i]);
    const Y = (v) => h - 14 - (v / tabDef.max) * (h - 28);

    // ── grids ── magnitude (horizontal, value labels) + time (vertical, seconds)
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.strokeStyle = C.border;
    for (let g = 0; g <= 4; g++) {
      const val = (tabDef.max * g) / 4;
      const y = Y(val);
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(w - 10, y); ctx.stroke();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = C.dim;
      ctx.fillText(String(Math.round(val)), 1, y - 1.5);
    }
    // Time gridlines: log mode uses a 1/2/5-decade ladder (spreads in log
    // space); linear mode uses evenly-spaced "nice" steps.
    for (const t of envTimeTicks(total, this.envLogTime)) {
      const x = Xt(t);
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 12); ctx.stroke();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = C.dim;
      ctx.fillText((t < 1 ? t.toFixed(2) : t.toFixed(1)) + "s", x + 1, h - 3);
    }
    ctx.globalAlpha = 1;

    // sustain / loop region shading
    const shade = (word, color) => {
      if (((word >> 5) & 1) === 0) return;
      const s = (word >> 8) & 0x1f;
      const e = word & 0x1f;
      ctx.fillStyle = color;
      ctx.fillRect(X(Math.min(s, 24)), 0, Math.max(X(Math.min(e, 24)) - X(Math.min(s, 24)), 2), h);
    };
    shade(inst[tabDef.susKey], C.envSus);
    shade(inst[tabDef.loopKey], C.envLoop);

    // polyline + nodes (active nodes only — up to the terminator)
    const activeCount = this.envActiveCount(env);
    ctx.strokeStyle = C.envLine;
    ctx.beginPath();
    for (let i = 0; i < activeCount; i++) {
      const x = X(i);
      const y = Y(env[i].value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = C.envNode;
    for (let i = 0; i < activeCount; i++) {
      ctx.beginPath();
      ctx.arc(X(i), Y(env[i].value), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // highlight the spinner-selected node
    if (this.selectedNode >= 0 && this.selectedNode < activeCount) {
      ctx.strokeStyle = C.playCursor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(this.selectedNode), Y(env[this.selectedNode].value), 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // live playback cursor for THIS envelope's role — every tab (vol / pan /
    // pitch / filter) has its own snapshot index+time accessor on tabDef.
    const audio = this.store.audio;
    if (audio && tabDef.liveIdx) {
      ctx.fillStyle = C.live;
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
        if (!audio.getVoiceActive(vi) || audio.getVoiceInstrument(vi) !== this.selected) continue;
        const idx = audio[tabDef.liveIdx](vi);
        const t = audio[tabDef.liveTime](vi);
        if (idx < 0 || idx > 24) continue;
        const base = times[Math.min(idx, 24)];
        const x = Xt(Math.min(base + t, total));
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }
  }

  envHit(e) {
    const rect = this.envCanvas.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { w, times, total } = this.envGeometry();
    const active = this.envActiveCount(this.envCanvas.env);
    let best = -1, bestD = 12;
    for (let i = 0; i < active; i++) {
      const nx = 10 + this.envTimeFrac(times[i], total) * (w - 20) * ENV_TIME_FRAC;
      const d = Math.abs(nx - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { idx: best, y };
  }

  envPointerDown(e) {
    const hit = this.envHit(e);
    if (hit.idx < 0) return;
    this.selectedNode = hit.idx; // sync the spinner target to the grabbed node
    this.envCanvas.canvas.setPointerCapture(e.pointerId);
    const gestureId = `envdrag${Date.now()}`;
    this.dragState = { idx: hit.idx, gestureId };
    // Editing an inactive Pitch/Filter role first CLAIMS its slot: mark the
    // envelope present (LOOP-word P bit 13) and assign the role via the m-bit
    // (bit 7: set = filter, clear = pitch), as part of this drag's undo step.
    const { tabDef, inst, head } = this.envCanvas;
    if (tabDef.role && !tabDef.roleActive) {
      const claimed = ((inst[tabDef.loopKey] | 0x2000) & ~0x80) | (tabDef.role === "filter" ? 0x80 : 0);
      this.store.undo.apply(setInstFieldOp(this.selected, tabDef.loopKey, claimed, gestureId));
      tabDef.roleActive = true;
      if (head) head.innerHTML = t("inst.envHeaderClaimed", { label: t(tabDef.labelKey) });
    }
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
      // Divide by the reserved plot width so dragging into the rightmost
      // headroom (frac > 1, up to 1/ENV_TIME_FRAC) extends the envelope.
      const frac = Math.min(Math.max((x - 10) / ((w - 20) * ENV_TIME_FRAC), 0), 1 / ENV_TIME_FRAC);
      const wantTime = this.envFracTime(frac, total);
      const seg = Math.max(wantTime - times[idx - 1], 0);
      change.prevOffset = minifloatFromDouble(seg);
    }
    this.store.undo.apply(setEnvDragOp(
      this.selected, tabDef.key, idx, change, this.dragState.gestureId));
    this.drawEnvGraph();
  }

  renderZones(inst) {
    const bar = document.createElement("div");
    bar.className = "adv-openbar";
    const advBtn = document.createElement("button");
    advBtn.textContent = t("adv.open");
    advBtn.title = t("adv.openTitle");
    advBtn.addEventListener("click", () => this.openAdvanced());
    bar.appendChild(advBtn);
    this.panel.appendChild(bar);
    const head = document.createElement("div");
    head.className = "detail-info";
    const patches = inst.extraPatches ?? [];
    head.textContent = patches.length === 1
      ? t("inst.zonesInfo1")
      : t("inst.zonesInfoN", { n: patches.length });
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
    const C = themeColors();
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    const patches = inst.extraPatches ?? [];
    const X = (noteVal) => (noteVal / 0xffff) * w;
    const Y = (vol) => h - (vol / 63) * h;

    const audio = this.store.audio;
    const liveKeys = new Set();
    if (audio) {
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
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
      ctx.globalAlpha = live ? 0.55 : 0.35;
      ctx.fillStyle = live ? C.playCursor : `hsl(${(i * 47) % 360} 50% 55%)`;
      ctx.fillRect(x, y, pw, ph);
      ctx.globalAlpha = live ? 1 : 0.45;
      ctx.strokeStyle = live ? C.playCursor : C.envLine;
      ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.fg;
      ctx.font = "10px monospace";
      if (pw > 30) {
        // A stereo zone (Ixmp 's') is tagged, since two zones that look alike
        // on the map can differ by costing twice the pool bytes.
        const tag = p.hasChanBlock && p.chanCount > 1 ? ` ${t("smp.stereoTag")}` : "";
        ctx.fillText(`${rangeToStr(p.pitchStart, p.pitchEnd)}${tag}`, x + 2, y + 11);
      }
    });
  }

  /** Commit a new layer array for metainstrument `slot`. Structural edits
   *  (add / duplicate / remove / reorder) change the layer count in byte 1 and
   *  shift every entry after them, so the whole record is repacked — that is
   *  setMetaRecordOp's job, not setMetaBytesOp's. */
  applyMetaLayers(slot, layers) {
    const inst = this.store.doc.instruments[slot];
    this.store.undo.apply(setMetaRecordOp(slot, metaRecordOf(inst, layers)));
    this.refresh();
  }

  renderMeta(inst) {
    const doc = this.store.doc;
    const slot = this.selected;
    const layers = metaLayers(inst);
    const preset = this.store.pitchPreset;
    const commit = (next) => this.applyMetaLayers(slot, next);
    const full = layers.length >= META_MAX_LAYERS;

    // ── toolbar: how much of the table is spent, and what it costs to play ──
    const bar = document.createElement("div");
    bar.className = "meta-bar";
    const addBtn = document.createElement("button");
    setIconLabel(addBtn, "filePlus", t("meta.addLayers"));
    addBtn.title = t("meta.addLayersTitle");
    addBtn.disabled = full;
    addBtn.addEventListener("click", async () => {
      const { showAddMetaLayers } = await import("../popups/newmeta.js");
      if ((await showAddMetaLayers(this.store, slot)) !== null) this.refresh();
    });
    const tally = document.createElement("span");
    tally.className = "dim meta-tally";
    tally.textContent = `${t("meta.tally", { n: layers.length, max: META_MAX_LAYERS })} · ` +
      `${t("meta.voiceCost", { n: layers.length })}`;
    bar.append(addBtn, tally);
    this.panel.appendChild(bar);

    const table = document.createElement("table");
    table.className = "files-table meta-table";
    table.innerHTML =
      `<thead><tr><th>#</th><th>${escape(t("meta.subInst"))}</th><th>${escape(t("meta.mix"))}</th>` +
      `<th>${escape(t("meta.detune"))}</th><th>${escape(t("meta.pitchRange"))}</th>` +
      `<th>${escape(t("meta.vel"))}</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");

    /** A committing number input. */
    const numIn = (value, min, max, onCommit, title = "") => {
      const i = document.createElement("input");
      i.type = "number"; i.min = min; i.max = max; i.value = value;
      i.className = "meta-num";
      if (title) i.title = title;
      i.addEventListener("change", () =>
        onCommit(clampN(Math.round(Number(i.value) || 0), min, max)));
      return i;
    };
    const iconBtn = (name, label, title, onClick, disabled = false) => {
      const b = document.createElement("button");
      b.className = "meta-act";
      if (name) setIconLabel(b, name, label);
      else b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };

    layers.forEach((l, i) => {
      const links = linkCount(layers, i);
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="idxCell"></td><td class="nameCell"></td><td class="mixCell"></td>` +
        `<td class="detCell"></td><td class="rngCell"></td><td class="velCell"></td>` +
        `<td class="advCell"></td>`;

      // Layer 0 leads: the first layer that COVERS a trigger plays on the
      // channel itself and the rest spawn background voices, so record order is
      // priority (trigger.js triggerMetaOrNote).
      const idxCell = tr.querySelector(".idxCell");
      idxCell.textContent = String(i);
      if (i === 0) {
        const star = document.createElement("span");
        star.className = "meta-fg";
        star.textContent = "▸";
        star.title = t("meta.foregroundTitle");
        idxCell.prepend(star);
      }

      // A linked layer shares its sub-instrument with its siblings: editing it
      // edits all of them, which is the point of a unison stack and a trap
      // otherwise — so it is badged, and Unlink is right there.
      const nameCell = tr.querySelector(".nameCell");
      const nameTxt = document.createElement("span");
      nameTxt.textContent = `$${(l.instIdx & 0x3ff).toString(16).toUpperCase().padStart(3, "0")} ` +
        (unescapeName(doc.instrumentName(l.instIdx)) || "");
      nameCell.append(nameTxt);
      if (links > 1) {
        const badge = document.createElement("span");
        badge.className = "badge-sm meta-link";
        badge.textContent = t("meta.linked", { n: links });
        badge.title = t("meta.linkedTitle", { n: links });
        nameCell.append(badge);
      }

      // Mix. The record stores a raw PSO octet (0..255, 159 = 0 dB) and nobody
      // mixes in those — so the box reads DECIBELS while − and + still walk one
      // octet at a time, which is item 156.2's mapping in its plainest form.
      // The octet itself stays visible beside it, because it is what the file
      // holds and what a bug report has to quote.
      const mixIn = document.createElement("input");
      mixIn.className = "meta-num";
      mixIn.title = t("meta.mixTitle");
      // mapSpinner FIRST: its own change handler is what settles `rawValue`
      // from a hand-typed decibel figure, and the commit below reads that.
      mapSpinner(mixIn, MIX_DB_MAP, l.mixOctet);
      mixIn.addEventListener("change", () =>
        commit(patchLayer(layers, i, { mixOctet: mixIn.rawValue })));
      tr.querySelector(".mixCell").append(
        mixIn,
        Object.assign(document.createElement("span"),
          { className: "dim meta-db", textContent: annHex2(l.mixOctet) }));

      // Detune. The record stores signed 4096-TET units — a major third is 1365
      // and a chorus detune is 6 — which nobody thinks in, so the field is CENTS
      // while − and + step whole degrees of the song's own pitch table
      // (stepNoteInTable, so unequal tables step to real degrees, not by 341).
      // That is the same one-control shape as every other value in the app
      // (item 156): the pair of arrows this cell used to carry beside the box
      // ARE the spinner's buttons now, with the mapping doing the units.
      const detCell = tr.querySelector(".detCell");
      const centsIn = document.createElement("input");
      centsIn.className = "meta-num";
      centsIn.title = t("meta.detuneTitle");
      centsIn.dataset.mtDecTitle = t("meta.detuneDownTitle");
      centsIn.dataset.mtIncTitle = t("meta.detuneUpTitle");
      mapSpinner(centsIn, {
        toDisplay: (units) => `${centsOfUnits(units).toFixed(1)} ¢`,
        fromDisplay: (text) => {
          const c = Number.parseFloat(String(text).replace("−", "-"));
          return clampDetune(Number.isFinite(c) ? unitsOfCents(c) : 0);
        },
        step: (units, dir) => clampDetune(
          stepNoteInTable(clampN(ANCHOR_NOTE + units, 0x20, 0xffff), preset, dir) - ANCHOR_NOTE),
      }, l.detune);
      centsIn.addEventListener("change", () =>
        commit(patchLayer(layers, i, { detune: centsIn.rawValue })));
      // The note the detune lands on, painted in the SONG's notation (the
      // grids' own glyph painter) rather than spelled in 12-EDO — the − +
      // buttons already step degrees of this table, so the readout has to agree
      // with them. The raw 4096-TET units stay as text beside the glyph.
      const detAnn = Object.assign(document.createElement("span"), { className: "dim meta-det-ann" });
      detAnn.append(
        noteGlyphCanvas(clampN(ANCHOR_NOTE + l.detune, 0x20, 0xffff), preset),
        ` · ${l.detune}`);
      detCell.append(centsIn, detAnn);

      // Gating rectangle. The new-meta hint has always told people to "narrow
      // them on the Layers tab"; until item 113 there was nothing here to narrow.
      const rngCell = tr.querySelector(".rngCell");
      const rngAnn = Object.assign(document.createElement("span"), { className: "dim meta-rng-ann" });
      rngAnn.append(rangeGlyphCanvas(l.pitchStart, l.pitchEnd, preset, t("range.whole")));
      rngCell.append(
        numIn(l.pitchStart, 0, 0xffff, (v) => commit(patchLayer(layers, i, { pitchStart: v })),
          t("meta.pitchLoTitle")),
        numIn(l.pitchEnd, 0, 0xffff, (v) => commit(patchLayer(layers, i, { pitchEnd: v })),
          t("meta.pitchHiTitle")),
        rngAnn);

      const velCell = tr.querySelector(".velCell");
      velCell.append(
        numIn(l.volStart, 0, 63, (v) => commit(patchLayer(layers, i, { volStart: v })),
          t("meta.velLoTitle")),
        numIn(l.volEnd, 0, 63, (v) => commit(patchLayer(layers, i, { volEnd: v })),
          t("meta.velHiTitle")));

      // Actions. Layer children are not list-selectable (item 59), so "Edit…"
      // is their only entry point: the child opens in its OWN base editor
      // (item 71) — the same tabs a top-level instrument gets.
      const advCell = tr.querySelector(".advCell");
      advCell.append(
        iconBtn(null, "▲", t("meta.moveUpTitle"),
          () => commit(moveLayer(layers, i, -1)), i === 0),
        iconBtn(null, "▼", t("meta.moveDownTitle"),
          () => commit(moveLayer(layers, i, +1)), i === layers.length - 1),
        iconBtn("duplicate", "", t("meta.dupTitle"),
          () => commit(duplicateLayer(layers, i)), full),
        iconBtn(null, t("meta.chord"), t("meta.chordTitleBtn"), async () => {
          const { showChordStack } = await import("../popups/metachord.js");
          if ((await showChordStack(this.store, slot, i)) !== null) this.refresh();
        }, full),
        iconBtn(null, t("meta.unlink"), t("meta.unlinkTitle"), async () => {
          const { planUnlinkMetaLayer } = await import("../../doc/bankmerge.js");
          const plan = planUnlinkMetaLayer(doc, slot, i);
          if (plan.error) { alert(plan.error); return; }
          this.store.undo.apply(importBankOp(plan));
          this.refresh();
        }, links < 2),
        iconBtn("close", "", t("meta.removeTitle"),
          () => commit(removeLayer(layers, i)), layers.length <= 1),
        iconBtn(null, t("meta.edit"), t("meta.editTitle"),
          () => this.openChild(l.instIdx & 0x3ff, slot)));

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    this.panel.appendChild(table);
  }

  frame() {
    if (!this.visible) return;
    if (this.advanced) {
      this.advEditor.frame();
    } else if (this.store.audio?.isPlaying()) {
      if (this.tab.startsWith("env") && this.envCanvas) this.drawEnvGraph();
      if (this.tab === "zones" && this.zoneCanvas) this.drawZones();
    }
    this.updateLiveDots();
  }
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Meta layer detune is a signed 4096-TET offset; the Layers tab shows cents.
const centsOfUnits = (units) => (units * 1200) / UNITS_PER_OCTAVE;
const unitsOfCents = (cents) => (cents * UNITS_PER_OCTAVE) / 1200;

/** Meta mix octet → a dB readout (159 = 0 dB unity; 0 = silence). */
function mixDbLabel(octet) {
  const g = META_MIX_GAIN[octet & 0xff];
  if (!(g > 0)) return "−∞ dB";
  const db = 20 * Math.log10(g);
  return (db >= 0 ? "+" : "−") + Math.abs(db).toFixed(1) + " dB";
}

/** …and back: the octet whose gain is nearest the decibels someone typed. */
function mixOctetOfDb(text) {
  const str = String(text).replace("−", "-").trim();
  if (str === "" || /-\s*(∞|inf)/i.test(str)) return 0;
  const db = parseFloat(str);
  if (!Number.isFinite(db)) return 0;
  const want = 10 ** (db / 20);
  let best = 0, bestErr = Infinity;
  for (let o = 0; o < 256; o++) {
    const err = Math.abs(META_MIX_GAIN[o] - want);
    if (err < bestErr) { bestErr = err; best = o; }
  }
  return best;
}

/** The mix field's spinner mapping (item 156.2): decibels on screen, one raw
 *  PSO octet per press of − / +. */
const MIX_DB_MAP = {
  toDisplay: mixDbLabel,
  fromDisplay: mixOctetOfDb,
  step: (octet, dir) => Math.min(Math.max((octet | 0) + dir, 0), 255),
};
const annHex4 = (v) => "$" + (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const annHex6 = (v) => "$" + (v & 0xffffff).toString(16).toUpperCase().padStart(6, "0");

/** A "nice" time-grid interval (1/2/5 × 10ⁿ) giving ~5-8 gridlines. */
function niceTimeStep(total) {
  const raw = total / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / pow;
  const mult = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return Math.max(mult * pow, 0.01);
}

/** Time gridline positions (seconds). Linear mode: evenly-spaced nice steps.
 *  Log mode: a 1/2/5-per-decade ladder (spreads legibly in log space). */
function envTimeTicks(total, log) {
  const ticks = [];
  if (log) {
    const ladder = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15];
    ticks.push(0);
    for (const t of ladder) if (t <= total + 1e-9) ticks.push(t);
  } else {
    const step = niceTimeStep(total);
    for (let t = 0; t <= total + 1e-9; t += step) ticks.push(t);
  }
  return ticks;
}
