// Determinate progress popup — a spinner + a <progress> bar + a percentage
// readout, optionally cancellable (exposes an AbortSignal). Used by the WAV
// export (item 38); shaped like showImportProgress but for a known-length job.

import { t } from "../i18n.js";

export function showProgress(title, { cancellable = false } = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal progress-modal";
  const h = document.createElement("h3");
  const spin = document.createElement("span");
  spin.className = "spinner";
  h.append(spin, document.createTextNode(" " + title));
  const bar = document.createElement("progress");
  bar.className = "progress-bar";
  bar.max = 1; bar.value = 0;
  const pct = document.createElement("div");
  pct.className = "progress-pct dim";
  pct.textContent = "0%";
  const btnRow = document.createElement("div");
  btnRow.className = "modal-buttons";

  const controller = new AbortController();
  const closeBtn = document.createElement("button");
  if (cancellable) {
    closeBtn.textContent = t("common.cancel");
    closeBtn.addEventListener("click", (e) => { e.preventDefault(); controller.abort(); });
    btnRow.appendChild(closeBtn);
  } else {
    btnRow.hidden = true;
  }

  dlg.append(h, bar, pct, btnRow);
  document.body.appendChild(dlg);

  let running = true;
  dlg.addEventListener("cancel", (e) => { if (running) e.preventDefault(); });
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();

  return {
    signal: controller.signal,
    set(frac) {
      const f = Math.max(0, Math.min(1, frac || 0));
      bar.value = f;
      pct.textContent = Math.round(f * 100) + "%";
    },
    done() { running = false; dlg.close(); dlg.remove(); },
    fail(message) {
      running = false;
      spin.classList.add("stopped");
      pct.textContent = "✖ " + message;
      closeBtn.textContent = t("common.close");
      closeBtn.onclick = (e) => { e.preventDefault(); dlg.close(); dlg.remove(); };
      btnRow.hidden = false;
      closeBtn.focus();
    },
  };
}
