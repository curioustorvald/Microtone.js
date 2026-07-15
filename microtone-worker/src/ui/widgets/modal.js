// Minimal modal helper over <dialog>. Builds a form-style dialog from field
// specs and resolves with the values (or null on cancel).

import { t } from "../i18n.js";

export function showModal({ title, fields = [], okLabel = "OK", body = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal";
    const h = document.createElement("h3");
    h.textContent = title;
    dlg.appendChild(h);
    if (body) {
      const p = document.createElement("p");
      p.className = "dim";
      p.textContent = body;
      dlg.appendChild(p);
    }
    const inputs = {};
    for (const f of fields) {
      const label = document.createElement("label");
      label.className = "modal-field";
      label.append(f.label + " ");
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const opt of f.options) {
          const o = document.createElement("option");
          o.value = opt.value;
          o.textContent = opt.label;
          input.appendChild(o);
        }
        if (f.value !== undefined) input.value = f.value;
      } else {
        input = document.createElement("input");
        input.type = f.type ?? "text";
        if (f.value !== undefined) input.value = f.value;
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.name = f.name;
      inputs[f.name] = input;
      label.appendChild(input);
      dlg.appendChild(label);
    }
    const row = document.createElement("div");
    row.className = "modal-buttons";
    const ok = document.createElement("button");
    ok.textContent = okLabel;
    const cancel = document.createElement("button");
    cancel.textContent = t("common.cancel");
    row.append(ok, cancel);
    dlg.appendChild(row);
    document.body.appendChild(dlg);

    const finish = (result) => {
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    ok.addEventListener("click", (e) => {
      e.preventDefault();
      const values = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
      finish(values);
    });
    cancel.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't leak piano/transport keys while a modal is up
      if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); ok.click(); }
    });
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}
