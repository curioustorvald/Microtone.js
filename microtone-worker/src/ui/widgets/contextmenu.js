// Icon-cell context menu — the app's right-click menu shape: a palette of
// square cells, each an SVG glyph over its name, rather than a list of text
// rows. Callers pass the items; the widget owns placement and dismissal.
//
// Built on <dialog>.showModal() like widgets/modal.js, for three things that
// come free with it: Escape → `cancel`, focus containment, and app.js's global
// key handler skipping anything inside a dialog (so the piano/transport keys
// stay quiet while the menu is up). The backdrop is transparent — a click on it
// targets the dialog itself, which is the outside-click dismissal.

import { t } from "../i18n.js";

const MARGIN = 6; // keep the menu this far from the viewport edge

/**
 * Show a context menu at viewport coordinates (x, y).
 *
 * `groups` is an array of ROWS, each row an array of
 * [{id, label, icon, title?, disabled?}] — `icon` is inline SVG markup (see
 * icons.js), `title` the hover tooltip. Empty rows are skipped, so a caller can
 * pass a row it may or may not have anything for. Resolves with the chosen
 * item's id, or null when dismissed.
 */
export function showContextMenu(x, y, groups) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "ctxmenu";
    const grid = document.createElement("div");
    grid.className = "ctx-grid";
    const rows = groups.filter((g) => g.length > 0);

    const finish = (result) => {
      if (!dlg.isConnected) return;
      dlg.close();
      dlg.remove();
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("resize", onScroll);
      resolve(result);
    };
    const onScroll = () => finish(null);

    for (const items of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "ctx-row";
      for (const item of items) {
        const cell = document.createElement("button");
        cell.className = "ctx-cell";
        cell.type = "button";
        cell.dataset.id = item.id; // how tests (and any caller) find a cell
        cell.disabled = item.disabled === true;
        if (item.title) cell.title = item.title;
        const art = document.createElement("span");
        art.className = "ctx-icon";
        art.innerHTML = item.icon ?? "";
        const name = document.createElement("span");
        name.className = "ctx-name";
        name.textContent = item.label;
        cell.append(art, name);
        cell.addEventListener("click", () => finish(item.id));
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    }
    if (rows.length === 0) {
      const none = document.createElement("div");
      none.className = "ctx-empty";
      none.textContent = t("ctx.empty");
      grid.appendChild(none);
    }
    dlg.appendChild(grid);
    document.body.appendChild(dlg);

    // A modal dialog's backdrop covers the viewport and delivers its events to
    // the dialog, so "did the pointer land outside the menu box" is a straight
    // rect test — and unlike `e.target === dlg` it doesn't treat the menu's own
    // padding as outside.
    dlg.addEventListener("pointerdown", (e) => {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right ||
          e.clientY < r.top || e.clientY > r.bottom) finish(null);
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep the piano/transport keys out of the menu
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // ←/→ walk every cell in reading order, rows included (Tab does the same
      // thing; this is just what the shape leads you to press).
      const cells = [...grid.querySelectorAll(".ctx-cell:not(:disabled)")];
      const i = cells.indexOf(document.activeElement);
      if (cells.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      cells[(i + step + cells.length) % cells.length].focus();
    });
    window.addEventListener("wheel", onScroll, true);
    window.addEventListener("resize", onScroll);

    dlg.showModal();
    // Place it only once it has been laid out, so the flip is measured against
    // the real box: prefer down-right of the pointer, flip at the edges.
    const box = dlg.getBoundingClientRect();
    const maxX = window.innerWidth - box.width - MARGIN;
    const maxY = window.innerHeight - box.height - MARGIN;
    dlg.style.left = `${Math.max(MARGIN, Math.min(x, maxX))}px`;
    dlg.style.top = `${Math.max(MARGIN, Math.min(y, maxY))}px`;
    grid.querySelector(".ctx-cell:not(:disabled)")?.focus();
  });
}
