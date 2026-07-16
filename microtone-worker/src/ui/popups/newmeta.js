// New-metainstrument popup (item 72) — build a metainstrument out of the
// project's existing instruments. Each pick is copied into a $100+ sub-slot and
// layered (bankmerge.planCreateMeta), so the originals stay selectable; the
// result applies through the same importBankOp undo pipeline as every other
// bank edit. Metainstruments are not offered: the engine resolves layers with
// triggerNote, which never re-enters the meta branch, so metas can't nest.

import { planCreateMeta } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
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
 * Resolves {firstSlot, count} after the metainstrument is created (firstSlot =
 * the new meta, so the caller can adopt and show it), or null when cancelled.
 */
export function showNewMeta(store) {
  const doc = store.doc;
  if (!doc) return Promise.resolve(null);
  const candidates = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta);
  if (candidates.length === 0) {
    alert(t("newmeta.noCandidates"));
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";
    const h = el("h3", "", t("newmeta.title"));
    const hint = el("p", "dim", t("newmeta.hint"));

    const nameRow = el("div", "import-bar");
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "import-filter";
    nameIn.placeholder = t("newmeta.namePlaceholder");
    nameRow.append(el("span", "", t("newmeta.name")), nameIn);

    const bar = el("div", "import-bar");
    const allBtn = el("button", "", t("common.all"));
    const noneBtn = el("button", "", t("common.none"));
    const tally = el("span", "import-tally", "");
    bar.append(allBtn, noneBtn, tally);

    const list = el("div", "import-list");
    const boxes = [];
    for (const slot of candidates) {
      const row = document.createElement("label");
      row.className = "import-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.slot = slot;
      const inst = doc.instruments[slot];
      const badge = inst.extraPatches ? `IXMP·${inst.extraPatches.length}` : "";
      row.append(box, el("span", "idx", hex3(slot)),
        el("span", "name", unescapeName(doc.instrumentName(slot)) || t("inst.unnamed")),
        el("span", "badge-sm", badge));
      list.appendChild(row);
      boxes.push(box);
    }

    const errEl = el("p", "import-error", "");
    errEl.hidden = true;
    const btnRow = el("div", "modal-buttons");
    const okBtn = el("button", "", t("newmeta.create"));
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);

    dlg.append(h, hint, nameRow, bar, list, errEl, btnRow);
    document.body.appendChild(dlg);

    const picked = () => boxes.filter((b) => b.checked).map((b) => Number(b.dataset.slot));
    const updateTally = () => {
      const n = picked().length;
      tally.textContent = t("newmeta.tally", { n });
      okBtn.disabled = n === 0;
    };
    list.addEventListener("change", updateTally);
    allBtn.addEventListener("click", () => { boxes.forEach((b) => { b.checked = true; }); updateTally(); });
    noneBtn.addEventListener("click", () => { boxes.forEach((b) => { b.checked = false; }); updateTally(); });
    updateTally();

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const plan = planCreateMeta(store.doc, picked(), escapeNonAscii(nameIn.value.trim()));
      if (plan.error) {
        errEl.textContent = plan.error;
        errEl.hidden = false;
        return;
      }
      store.undo.apply(importBankOp(plan));
      finish({ firstSlot: plan.metaSlot, count: plan.childSlots.length });
    });
    dlg.showModal();
    nameIn.focus();
  });
}
