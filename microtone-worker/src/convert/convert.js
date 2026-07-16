// Main-thread conversion API. convertToTaud() lazily spawns the module
// worker (which lazily boots Pyodide) and resolves with .taud container
// bytes ready for the normal loadBytes path.

import { converterFor } from "./convert-core.js";

export { converterFor };

/** Extensions the import pipeline accepts, for file-picker accept lists. */
export const CONVERT_ACCEPT = ".mod,.s3m,.it,.xm,.mon,.mid,.midi";

let worker = null;
let nextId = 1;
const pending = new Map(); // id → {resolve, reject, onStatus}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./convert.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.t === "status") p.onStatus?.(m.line);
    else if (m.t === "done") { pending.delete(m.id); p.resolve(new Uint8Array(m.bytes)); }
    else if (m.t === "error") { pending.delete(m.id); p.reject(new Error(m.message)); }
  };
  worker.onerror = (e) => {
    // a worker-level failure (e.g. module load) kills every pending job
    for (const p of pending.values()) p.reject(new Error(e.message || "conversion worker failed"));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Convert a tracker/MIDI file to .taud bytes.
 * @param fileName  original name (extension selects the converter)
 * @param bytes     Uint8Array of the file
 * @param opts.sf2  {name, bytes} soundfont (required for .mid/.midi)
 * @param opts.rpb  MIDI rows-per-beat (2/4/8/16/32/64, or null/"auto")
 * @param opts.trimPatches  MIDI: drop the Ixmp patches the song never triggers
 *                          (item 75; off = keep each preset's full zone map)
 * @param opts.onStatus  (line) => void progress stream
 */
export function convertToTaud(fileName, bytes,
                              { sf2 = null, rpb = null, trimPatches = false, onStatus = null } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onStatus });
    const buf = bytes.slice().buffer;
    const msg = { t: "convert", id, fileName, bytes: buf, rpb, trimPatches };
    const transfer = [buf];
    if (sf2) {
      const sfBuf = sf2.bytes.slice().buffer;
      msg.sf2 = { name: sf2.name, bytes: sfBuf };
      transfer.push(sfBuf);
    }
    ensureWorker().postMessage(msg, transfer);
  });
}

function sf2Request(msg, onStatus) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onStatus });
    ensureWorker().postMessage({ ...msg, id }, [msg.bytes]);
  });
}

/** List an .sf2's presets: [{bank, program, name}] (bank 128 = drum kits). */
export async function listSf2Presets(sf2Bytes, { onStatus = null } = {}) {
  const out = await sf2Request({ t: "sf2", mode: "list", bytes: sf2Bytes.slice().buffer }, onStatus);
  return JSON.parse(new TextDecoder().decode(out));
}

/**
 * Build a .tsii instrument bank from selected presets ([[bank, program], …])
 * via the canonical midi2taud machinery. `bpm` should be the destination
 * song's BPM (fadeout steps are tempo-relative).
 */
export function buildSf2Bank(sf2Bytes, selection, { bpm = 125, onStatus = null } = {}) {
  return sf2Request(
    { t: "sf2", mode: "build", bytes: sf2Bytes.slice().buffer, selection, bpm },
    onStatus,
  );
}
