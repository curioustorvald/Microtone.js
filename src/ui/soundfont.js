// Session soundfont sources — the bundled GeneralUser-GS.sf2 next to
// index.html and/or a user-picked .sf2, each fetched/picked once per session.
// MIDI import (topbar button, drag-drop, ?load=) and the Instruments Add…
// shortcut share these caches.

import { pickFile } from "../storage/import-export.js";

let bundled;        // undefined = not tried, null = unavailable, else {name, bytes}
let userSf2 = null; // last user-picked {name, bytes}

/** The bundled GeneralUser-GS.sf2, or null when not deployed alongside the
 *  app. Guards the RIFF magic: a host that checked out Git LFS without
 *  pulling objects serves the ~130-byte POINTER FILE with a 200. */
export async function getBundledSoundfont() {
  if (bundled !== undefined) return bundled;
  bundled = null;
  try {
    const res = await fetch(new URL("GeneralUser-GS.sf2", document.baseURI));
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
          bytes[2] === 0x46 && bytes[3] === 0x46) { // "RIFF"
        bundled = { name: "GeneralUser-GS.sf2", bytes };
      } else {
        console.warn("bundled GeneralUser-GS.sf2 is not a RIFF file (Git LFS pointer?) — ignoring");
      }
    }
  } catch { /* not bundled */ }
  return bundled;
}

/** Ask the user for an .sf2; null on cancel. The pick is cached for reuse. */
export async function pickUserSoundfont() {
  const file = await pickFile(".sf2");
  if (!file) return null;
  userSf2 = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  return userSf2;
}

/** Automatic resolution: bundled → last user pick → file picker. Null when
 *  the user cancels. Used by the paths without an explicit choice UI
 *  (drag-drop / ?load= MIDI, Instruments Add…). */
export async function getSoundfont() {
  return (await getBundledSoundfont()) ?? userSf2 ?? pickUserSoundfont();
}
