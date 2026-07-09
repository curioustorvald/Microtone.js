// File view (F7) — OPFS project browser + import/export. DOM-based (lists and
// buttons, no canvas). The Files tab replaces taut's filenav-driven File tab.

import * as opfs from "../../storage/opfs.js";
import { pickFile, download } from "../../storage/import-export.js";
import { showModal } from "../widgets/modal.js";
import { renderToWav } from "../../audio/offline-render.js";

export class FilesView {
  /**
   * @param host container element
   * @param callbacks { openBytes(name, bytes), currentDoc() → {doc, fileName} }
   */
  constructor(store, host, callbacks) {
    this.store = store;
    this.host = host;
    this.cb = callbacks;
    this.root = document.createElement("div");
    this.root.className = "files-view";
    host.appendChild(this.root);
  }

  async refresh() {
    const ok = await opfs.available();
    this.root.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "files-bar";
    const saveBtn = mkBtn("Save", () => this.save());
    const saveAsBtn = mkBtn("Save As…", () => this.saveAs());
    const importBtn = mkBtn("Import…", () => this.import());
    const exportBtn = mkBtn("Export ⬇", () => this.export());
    const wavBtn = mkBtn("Export WAV…", () => this.exportWav());
    bar.append(saveBtn, saveAsBtn, importBtn, exportBtn, wavBtn);
    this.root.appendChild(bar);

    if (!ok) {
      const warn = document.createElement("p");
      warn.className = "files-warn";
      warn.textContent = "OPFS unavailable (private mode?) — nothing persists in-browser; use Export to keep your work.";
      this.root.appendChild(warn);
      return;
    }

    const entries = await opfs.list();
    const table = document.createElement("table");
    table.className = "files-table";
    table.innerHTML = "<thead><tr><th>project</th><th>size</th><th>modified</th><th></th></tr></thead>";
    const tbody = document.createElement("tbody");
    if (entries.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="dim">no projects yet — Save As… or Import…</td>`;
      tbody.appendChild(tr);
    }
    for (const e of entries) {
      const tr = document.createElement("tr");
      const current = e.name === this.store.fileName;
      tr.innerHTML =
        `<td class="${current ? "files-current" : ""}">${escapeHtml(e.name)}</td>` +
        `<td>${(e.size / 1024).toFixed(1)} K</td>` +
        `<td>${new Date(e.mtime).toLocaleString()}</td>`;
      const td = document.createElement("td");
      td.append(
        mkBtn("Open", async () => {
          await this.cb.openBytes(e.name, await opfs.read(e.name));
          this.refresh();
        }),
        mkBtn("⬇", async () => download(await opfs.read(e.name), e.name)),
        mkBtn("✕", async () => {
          const yes = await showModal({ title: `Delete ${e.name}?`, okLabel: "Delete" });
          if (yes) { await opfs.remove(e.name); this.refresh(); }
        }),
      );
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.root.appendChild(table);
  }

  async save() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    if (!fileName) return this.saveAs();
    await opfs.write(fileName, doc.toBytes());
    doc.dirty = false;
    this.store.emit("saved", fileName);
    this.refresh();
  }

  async saveAs() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const result = await showModal({
      title: "Save project as",
      fields: [{ name: "name", label: "Name", value: fileName ?? "untitled.taud" }],
      okLabel: "Save",
    });
    if (!result || !result.name) return;
    const name = result.name.endsWith(".taud") ? result.name : result.name + ".taud";
    await opfs.write(name, doc.toBytes());
    doc.dirty = false;
    this.store.fileName = name;
    this.store.emit("saved", name);
    this.refresh();
  }

  async import() {
    const file = await pickFile();
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (await opfs.available()) await opfs.write(file.name, bytes);
    await this.cb.openBytes(file.name, bytes);
    this.refresh();
  }

  export() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    download(doc.toBytes(), fileName ?? "untitled.taud");
  }

  /** Offline-render the current song through the engine → 16-bit stereo WAV. */
  async exportWav() {
    const { doc, fileName } = this.cb.currentDoc();
    if (!doc) return;
    const result = await showModal({
      title: "Export WAV (offline render)",
      body: "Renders through the same engine at 32 kHz. Songs that never HALT stop at the cap.",
      fields: [{ name: "cap", label: "Max seconds", type: "number", value: 300, min: 1, max: 3600 }],
      okLabel: "Render",
    });
    if (!result) return;
    const cap = Math.min(Math.max(parseInt(result.cap || "300", 10), 1), 3600);
    const songIndex = this.cb.songIndex?.() ?? 0;
    const t0 = performance.now();
    const wav = renderToWav(doc.toRenderable(songIndex), songIndex, cap);
    console.info(`WAV render: ${wav.seconds.toFixed(1)}s in ${(performance.now() - t0).toFixed(0)}ms (halted=${wav.halted})`);
    const base = (fileName ?? "untitled.taud").replace(/\.taud$/, "");
    download(wav.bytes, `${base}.wav`);
  }
}

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
