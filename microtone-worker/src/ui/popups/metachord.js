// Chord stack (item 113) — turn ONE layer of a metainstrument into a chord or a
// unison spread in a single action. This is the two-click path to the thing
// metainstruments were always able to do but nobody could reach: a chorded
// piano out of one piano.
//
// The copies are LINKED (same $100+ sub-instrument, doc/metaedit.js stackLayer),
// so the stack stays ONE editable instrument sounded at several pitches — retune
// or refilter it once and every voice follows. Only the detune differs.
//
// The chord vocabulary is doc/chord.js's, the same one the Sample Lab's chord
// maker uses, so a just major third means the same interval in both places. The
// voice nearest unison is the REFERENCE: the base layer keeps the detune it
// already had and the others are placed relative to it, which is why "octaves"
// adds one above and one below instead of transposing the whole stack down.

import { CHORD_PRESETS, applyChordPreset, voiceUnits, UNITS_PER_OCTAVE } from "../../doc/chord.js";
import { metaLayers, metaRecordOf, stackLayer, clampDetune, META_MAX_LAYERS } from "../../doc/metaedit.js";
import { setMetaRecordOp } from "../../doc/ops.js";
import { ANCHOR_NOTE } from "../pitchtables.js";
import { noteToStr } from "../notenames.js";
import { unescapeName } from "../names.js";
import { t } from "../i18n.js";

const centsOf = (units) => (units * 1200) / UNITS_PER_OCTAVE;
const signedCents = (units) =>
  (units >= 0 ? "+" : "−") + Math.abs(centsOf(units)).toFixed(1) + " ¢";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Detune offsets a preset adds to the layer it is built on, relative to the
 * voice nearest unison (which IS that layer — it is not added again).
 */
export function chordOffsets(presetId, pitchPreset) {
  const voices = applyChordPreset(presetId).filter((v) => v.on);
  if (voices.length === 0) return [];
  const units = voices.map((v) => voiceUnits(v, pitchPreset));
  let ref = 0;
  for (let i = 1; i < units.length; i++) {
    if (Math.abs(units[i]) < Math.abs(units[ref])) ref = i;
  }
  return units.filter((_, i) => i !== ref).map((u) => clampDetune(u - units[ref]));
}

/**
 * Open the chord stack on layer `layerIdx` of the metainstrument in `metaSlot`.
 * Resolves the number of layers added, or null on cancel.
 */
export function showChordStack(store, metaSlot, layerIdx) {
  const doc = store.doc;
  const inst = doc?.instruments[metaSlot & 0x3ff];
  if (!inst?.isMeta) return Promise.resolve(null);
  const layers = metaLayers(inst);
  if (layerIdx < 0 || layerIdx >= layers.length) return Promise.resolve(null);
  if (layers.length >= META_MAX_LAYERS) {
    alert(t("meta.fullTable", { max: META_MAX_LAYERS }));
    return Promise.resolve(null);
  }

  const base = layers[layerIdx];
  const pitchPreset = store.pitchPreset;
  let presetId = CHORD_PRESETS[0].id;

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";

    const baseName = unescapeName(doc.instrumentName(base.instIdx & 0x3ff)) || t("inst.unnamed");
    const head = el("h3", "", t("meta.chordTitle"));
    const hint = el("p", "dim", t("meta.chordHint", {
      layer: layerIdx, inst: `$${(base.instIdx & 0x3ff).toString(16).toUpperCase().padStart(3, "0")} ${baseName}`,
    }));

    const bar = el("div", "import-bar");
    const sel = document.createElement("select");
    for (const p of CHORD_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = t(p.key);
      sel.appendChild(o);
    }
    bar.append(el("span", "", t("meta.chordPreset")), sel);

    const preview = el("div", "meta-chord-preview");
    const tally = el("p", "dim", "");
    const errEl = el("p", "import-error", "");
    errEl.hidden = true;

    const btnRow = el("div", "modal-buttons");
    const okBtn = el("button", "", t("meta.chordApply"));
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);

    // The preview lists every voice the stack will have — the base layer's own
    // pitch first — as the note it sounds when the pattern plays C4.
    const refresh = () => {
      const offsets = chordOffsets(presetId, pitchPreset);
      const room = META_MAX_LAYERS - layers.length;
      const use = offsets.slice(0, Math.max(0, room));
      preview.replaceChildren();
      const rows = [{ d: 0, root: true }, ...use.map((o) => ({ d: o, root: false }))];
      for (const r of rows) {
        const units = clampDetune(base.detune + r.d);
        const line = el("div", "meta-chord-voice" + (r.root ? " root" : ""));
        line.append(
          el("span", "meta-chord-note", noteToStr(Math.min(Math.max(ANCHOR_NOTE + units, 0x20), 0xffff))),
          el("span", "dim", r.root ? t("meta.chordRoot") : signedCents(r.d)));
        preview.appendChild(line);
      }
      const total = layers.length + use.length;
      tally.textContent = `${t("meta.chordAdds", { n: use.length })} · ` +
        `${t("meta.tally", { n: total, max: META_MAX_LAYERS })} · ${t("meta.voiceCost", { n: total })}`;
      okBtn.disabled = use.length === 0;
      errEl.hidden = use.length >= offsets.length;
      if (!errEl.hidden) errEl.textContent = t("meta.chordTruncated", { max: META_MAX_LAYERS });
    };

    sel.addEventListener("change", () => { presetId = sel.value; refresh(); });

    dlg.append(head, hint, bar, preview, tally, errEl, btnRow);
    document.body.appendChild(dlg);
    refresh();

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const offsets = chordOffsets(presetId, pitchPreset).map((o) => clampDetune(base.detune + o));
      const next = stackLayer(layers, layerIdx, offsets);
      const added = next.length - layers.length;
      if (added <= 0) { finish(null); return; }
      store.undo.apply(setMetaRecordOp(metaSlot & 0x3ff, metaRecordOf(inst, next)));
      finish(added);
    });
    dlg.showModal();
    sel.focus();
  });
}
