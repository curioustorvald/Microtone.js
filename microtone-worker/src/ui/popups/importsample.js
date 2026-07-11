// "New instrument from sample" flow — pick an audio file, decode it to mono
// U8 PCM (audiodecode.js), confirm the name, then land it as a fresh
// instrument through planSampleImport + the invertible importBankOp (the
// same pipeline the bank importer uses, so undo/sync come for free).

import { pickFile } from "../../storage/import-export.js";
import { decodeAudioToU8 } from "../audiodecode.js";
import { planSampleImport } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { showModal } from "../widgets/modal.js";
import { escapeNonAscii } from "../names.js";
import { t } from "../i18n.js";

const ACCEPT = ".wav,.mp3,.ogg,.oga,.flac,.aif,.aiff,.m4a,audio/*";

/** Resolves with {firstSlot, count} after a successful import, else null. */
export async function importSampleAsInstrument(store) {
  if (!store.doc) return null;
  const file = await pickFile(ACCEPT);
  if (!file) return null;

  let decoded;
  try {
    decoded = await decodeAudioToU8(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    alert(t("import.cantDecode", { name: file.name, err: err.message ?? err }));
    return null;
  }

  const base = file.name.replace(/\.[^.]+$/, "");
  const result = await showModal({
    title: t("inst.sampleImportTitle", { name: file.name }),
    body: t("inst.sampleImportBody", {
      secs: decoded.seconds.toFixed(2),
      len: decoded.pcm.length,
      rate: decoded.rate,
    }),
    fields: [{ name: "name", label: t("inst.sampleImportName"), value: base }],
    okLabel: t("common.import"),
  });
  if (!result) return null;

  const nameBytes = new TextEncoder().encode(escapeNonAscii(result.name || base));
  const plan = planSampleImport(store.doc, {
    nameBytes,
    pcm: decoded.pcm,
    rate: decoded.rate,
  });
  if (plan.error) {
    alert(plan.error);
    return null;
  }
  store.undo.apply(importBankOp(plan));
  return { firstSlot: plan.insts[0].destSlot, count: 1 };
}
