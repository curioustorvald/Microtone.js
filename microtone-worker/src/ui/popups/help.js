// Help popup (?) — keyboard reference. Key names stay literal (universal); the
// descriptions come from i18n.

import { t } from "../i18n.js";

export function showHelp() {
  const dlg = document.createElement("dialog");
  dlg.className = "modal help-modal";
  const col1 = [
    ["Space", t("help.play")],
    ["Shift+Space", t("help.playStart")],
    ["F1…F7", t("help.views")],
    ["Insert", t("help.record")],
    ["[ ]", t("help.octave")],
    ["Enter", t("help.enter")],
    ["M / N", t("help.muteSolo")],
    ["Ctrl+Z / Ctrl+Y", t("help.undoRedo")],
    ["Ctrl+S", t("help.save")],
    ["Ctrl+G", t("help.goto")],
    ["Shift+" + t("help.arrowsDrag"), t("help.selExtend")],
    ["Ctrl+C / X / V", t("help.clipboard")],
    ["Esc · Delete", t("help.selClear")],
  ];
  const col2 = [
    ["W E · T Y U", t("help.blackKeys")],
    ["A S D F G H J K", t("help.whiteKeys")],
    ["z x c v · ` 1 2 3", t("help.sentinels")],
    ["0-9 A-F", t("help.hexEntry")],
    ["0-Z", t("help.fxOpcode")],
    ["+ / -", t("help.slideSel")],
    ["Delete / .", t("help.clearField")],
    ["← → / Tab", t("help.subCol")],
    ["wheel · Shift+wheel", t("help.scroll")],
    [t("help.wheelCell"), t("help.wheelEdit")],
  ];
  const dl = (rows) => "<dl>" +
    rows.map(([k, d]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(d)}</dd>`).join("") + "</dl>";
  dlg.innerHTML = `
    <h3>${escapeHtml(t("help.title"))}</h3>
    <div class="help-cols">${dl(col1)}${dl(col2)}</div>
    <div class="modal-buttons"><button>${escapeHtml(t("common.close"))}</button></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("button").addEventListener("click", () => { dlg.close(); dlg.remove(); });
  dlg.addEventListener("cancel", () => dlg.remove());
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
