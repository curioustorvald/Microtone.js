// New-metainstrument popup (item 72) and the Layers tab's "Add layers…" (item
// 113) — one picker over the project's ordinary instruments, with a COUNT per
// row rather than a checkbox.
//
// The count is the whole point. Picking one instrument three times is how a
// unison/chord stack is built ("a chorded piano out of one piano"): the source
// is copied ONCE into a $100+ sub-slot and three LINKED layers point at that
// copy, so retuning or refiltering the piano moves all three of its voices
// together. Splitting one voice off later is the Layers tab's Unlink.
//
// Metainstruments are not offered: the engine resolves layers with triggerNote,
// which never re-enters the meta branch, so metas can't nest.

import { planCreateMeta, planAddMetaLayers } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { META_MAX_LAYERS, metaLayers } from "../../doc/metaedit.js";
import { escapeNonAscii, unescapeName } from "../names.js";
import { t } from "../i18n.js";

const hex3 = (n) => "$" + n.toString(16).toUpperCase().padStart(3, "0");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The shared instrument list. Each row carries a −/+ stepper; 0 means "not
 * picked" and the row dims. Returns {list, picks(), total(), onChange, setAll}.
 * `budget` is how many layers the target can still take.
 */
function buildPicker(doc, candidates, budget, onTally) {
  const list = el("div", "import-list meta-picker");
  const rows = [];

  const total = () => rows.reduce((n, r) => n + r.count, 0);
  const sync = () => {
    for (const r of rows) {
      r.node.classList.toggle("picked", r.count > 0);
      r.readout.textContent = r.count > 0 ? `×${r.count}` : "—";
      r.minus.disabled = r.count === 0;
      r.plus.disabled = total() >= budget;
    }
    onTally(total());
  };

  for (const slot of candidates) {
    const row = el("div", "import-row meta-pick-row");
    row.dataset.slot = slot;
    const inst = doc.instruments[slot];
    const badge = inst.extraPatches ? `IXMP·${inst.extraPatches.length}` : "";

    const rec = { count: 0, slot, node: row };
    const minus = el("button", "meta-step", "−");
    const readout = el("span", "meta-count", "—");
    const plus = el("button", "meta-step", "+");
    minus.type = "button"; plus.type = "button";
    rec.minus = minus; rec.plus = plus; rec.readout = readout;

    const bump = (d) => {
      const next = rec.count + d;
      if (next < 0 || next > META_MAX_LAYERS) return;
      if (d > 0 && total() >= budget) return;
      rec.count = next;
      sync();
    };
    minus.addEventListener("click", (e) => { e.preventDefault(); bump(-1); });
    plus.addEventListener("click", (e) => { e.preventDefault(); bump(+1); });

    // Clicking the row itself is the common case: on, or back off.
    const name = el("span", "name", unescapeName(doc.instrumentName(slot)) || t("inst.unnamed"));
    const hit = el("button", "meta-pick-hit");
    hit.type = "button";
    hit.append(el("span", "idx", hex3(slot)), name, el("span", "badge-sm", badge));
    hit.addEventListener("click", (e) => {
      e.preventDefault();
      if (rec.count > 0) rec.count = 0;
      else if (total() < budget) rec.count = 1;
      sync();
    });

    row.append(minus, readout, plus, hit);
    list.appendChild(row);
    rows.push(rec);
  }

  return {
    list,
    total,
    picks: () => rows.filter((r) => r.count > 0).map((r) => ({ slot: r.slot, count: r.count })),
    setAll: (n) => {
      let left = budget;
      for (const r of rows) { r.count = Math.min(n, left); left -= r.count; }
      sync();
    },
    sync,
  };
}

/** "n of 25 layers · up to n voices per note" — the layer table's capacity and
 *  what the stack will cost in polyphony, which is the surprise otherwise. */
function tallyText(total, existing) {
  const n = total + existing;
  return `${t("meta.tally", { n, max: META_MAX_LAYERS })} · ${t("meta.voiceCost", { n })}`;
}

/**
 * Shared modal shell. `commit(picks, name)` returns a plan; the caller applies
 * it. Resolves whatever `done(plan)` returns, or null on cancel.
 */
function pickerModal(store, {
  title, hint, candidates, existing, withName, okLabel, commit, done,
}) {
  const doc = store.doc;
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";
    const parts = [el("h3", "", title), el("p", "dim", hint)];

    let nameIn = null;
    if (withName) {
      const nameRow = el("div", "import-bar");
      nameIn = document.createElement("input");
      nameIn.type = "text";
      nameIn.className = "import-filter";
      nameIn.placeholder = t("newmeta.namePlaceholder");
      nameRow.append(el("span", "", t("newmeta.name")), nameIn);
      parts.push(nameRow);
    }

    const bar = el("div", "import-bar");
    const allBtn = el("button", "", t("common.all"));
    const noneBtn = el("button", "", t("common.none"));
    const tally = el("span", "import-tally", "");
    bar.append(allBtn, noneBtn, tally);
    parts.push(bar);

    const errEl = el("p", "import-error", "");
    errEl.hidden = true;
    const btnRow = el("div", "modal-buttons");
    const okBtn = el("button", "", okLabel);
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);

    const budget = META_MAX_LAYERS - existing;
    const picker = buildPicker(doc, candidates, budget, (total) => {
      tally.textContent = tallyText(total, existing);
      okBtn.disabled = total === 0;
    });
    parts.splice(parts.length, 0, picker.list, errEl, btnRow);

    dlg.append(...parts);
    document.body.appendChild(dlg);
    picker.sync();

    allBtn.addEventListener("click", (e) => { e.preventDefault(); picker.setAll(1); });
    noneBtn.addEventListener("click", (e) => { e.preventDefault(); picker.setAll(0); });

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const plan = commit(picker.picks(), nameIn ? escapeNonAscii(nameIn.value.trim()) : "");
      if (plan.error) {
        errEl.textContent = plan.error;
        errEl.hidden = false;
        return;
      }
      store.undo.apply(importBankOp(plan));
      finish(done(plan));
    });
    dlg.showModal();
    (nameIn ?? okBtn).focus();
  });
}

/** Ordinary (layerable) instruments — everything but the metas. */
function layerCandidates(doc) {
  return doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta);
}

/**
 * Resolves {firstSlot, count} after the metainstrument is created (firstSlot =
 * the new meta, so the caller can adopt and show it), or null when cancelled.
 */
export function showNewMeta(store) {
  const doc = store.doc;
  if (!doc) return Promise.resolve(null);
  const candidates = layerCandidates(doc);
  if (candidates.length === 0) {
    alert(t("newmeta.noCandidates"));
    return Promise.resolve(null);
  }
  return pickerModal(store, {
    title: t("newmeta.title"),
    hint: t("newmeta.hint"),
    candidates,
    existing: 0,
    withName: true,
    okLabel: t("newmeta.create"),
    commit: (picks, name) => planCreateMeta(store.doc, picks, name),
    done: (plan) => ({ firstSlot: plan.metaSlot, count: plan.childSlots.length }),
  });
}

/**
 * Add layers to the metainstrument in `metaSlot` (Layers tab). Resolves the
 * number of layers added, or null on cancel.
 */
export function showAddMetaLayers(store, metaSlot) {
  const doc = store.doc;
  const meta = doc?.instruments[metaSlot & 0x3ff];
  if (!meta?.isMeta) return Promise.resolve(null);
  const existing = metaLayers(meta).length;
  if (existing >= META_MAX_LAYERS) {
    alert(t("meta.fullTable", { max: META_MAX_LAYERS }));
    return Promise.resolve(null);
  }
  const candidates = layerCandidates(doc);
  if (candidates.length === 0) {
    alert(t("newmeta.noCandidates"));
    return Promise.resolve(null);
  }
  return pickerModal(store, {
    title: t("meta.addTitle"),
    hint: t("meta.addHint"),
    candidates,
    existing,
    withName: false,
    okLabel: t("meta.addLayers"),
    commit: (picks) => planAddMetaLayers(store.doc, metaSlot, picks),
    done: (plan) => plan.addedLayers,
  });
}
