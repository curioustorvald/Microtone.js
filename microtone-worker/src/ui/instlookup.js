// Quick instrument lookup (item 27) — a toggleable floating panel on the
// Timeline + Patterns grids listing the top-level instruments ($01..$FF) with
// their names. Clicking a row makes it the current jam/entry instrument. Meta
// LAYER CHILDREN (sub-instruments) that happen to fall in $01..$FF are hidden —
// only real, directly-triggerable instruments are shown.

import { unescapeName } from "./names.js";
import { t } from "./i18n.js";

const PREF_KEY = "microtone-instlist";

function loadPref() {
  try { return localStorage.getItem(PREF_KEY) === "1"; } catch { return false; }
}
function savePref(v) {
  try { localStorage.setItem(PREF_KEY, v ? "1" : "0"); } catch { /* private mode */ }
}

export class InstLookup {
  constructor(store, jam, el, onPick) {
    this.store = store;
    this.jam = jam;
    this.el = el;
    this.onPick = onPick; // called after a pick so the shell can refresh status
    this.enabled = loadPref();

    store.on("doc", () => this.render());
    store.on("view", () => this.applyVisibility());
    store.on("edit", (tags) => {
      if (tags?.some?.((tag) => tag.kind === "bank" || tag.kind === "inst" || tag.kind === "section")) {
        this.render();
      }
    });
    // current-instrument changes (topbar wheel, Enter pick-up, jam) repaint the
    // highlight cheaply without a full rebuild.
    store.on("instsel", () => this.highlight());
  }

  get visible() { return this.enabled; }

  toggle() {
    this.enabled = !this.enabled;
    savePref(this.enabled);
    this.applyVisibility();
    return this.enabled;
  }

  /** Shown only when enabled AND on a grid view (Timeline/Patterns) with a doc. */
  applyVisibility() {
    const onGrid = this.store.view === "timeline" || this.store.view === "pattern";
    const show = this.enabled && onGrid && !!this.store.doc;
    this.el.hidden = !show;
    if (show) this.render();
  }

  /** Used top-level slots in $01..$FF, excluding meta-layer children. */
  topLevelSlots() {
    const doc = this.store.doc;
    if (!doc) return [];
    const children = new Set();
    const used = doc.usedInstrumentSlots();
    for (const s of used) {
      const layers = doc.instruments[s].metaLayers;
      if (layers) for (const l of layers) children.add(l.instIdx);
    }
    return used.filter((s) => s >= 1 && s <= 0xff && !children.has(s));
  }

  render() {
    if (this.el.hidden) return;
    const doc = this.store.doc;
    if (!doc) { this.el.innerHTML = ""; return; }
    const slots = this.topLevelSlots();
    const head =
      `<div class="il-head">${esc(t("instList.title"))} ` +
      `<span class="dim">(${slots.length})</span></div>`;
    const rows = slots.map((s) => {
      const inst = doc.instruments[s];
      const kind = inst.isMeta ? "M" : inst.extraPatches ? "X" : "";
      const name = esc(unescapeName(doc.instrumentName(s)) || t("instList.unnamed"));
      const sel = s === this.jam.currentInst ? " sel" : "";
      return `<div class="il-row${sel}" data-slot="${s}">` +
        `<span class="il-idx">${s.toString(16).toUpperCase().padStart(2, "0")}</span>` +
        `<span class="il-name">${name}</span>` +
        `<span class="il-kind">${kind}</span></div>`;
    }).join("");
    this.el.innerHTML = head +
      `<div class="il-list">${rows || `<div class="dim il-empty">${esc(t("instList.none"))}</div>`}</div>`;
    for (const row of this.el.querySelectorAll(".il-row")) {
      row.addEventListener("click", () => {
        this.jam.currentInst = parseInt(row.dataset.slot, 10);
        this.highlight();
        this.onPick?.();
      });
    }
  }

  /** Toggle the .sel class to match the current instrument (no rebuild). */
  highlight() {
    if (this.el.hidden) return;
    for (const row of this.el.querySelectorAll(".il-row")) {
      row.classList.toggle("sel", parseInt(row.dataset.slot, 10) === this.jam.currentInst);
    }
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
