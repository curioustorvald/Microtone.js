// Conversion worker — owns the Pyodide runtime (13 MB wasm; loaded once on
// the first conversion, kept for the session) so the UI thread never blocks.
//
// in : {t:"convert", id, fileName, bytes, sf2?: {name, bytes}}
// out: {t:"status", id, line} stream, then {t:"done", id, bytes} | {t:"error", id, message}

import {
  CONVERTER_SOURCES, SF2BANK_SOURCE, converterFor, loadConverterRuntime,
  runConverter, buildArgv,
} from "./convert-core.js";

const VENDOR = new URL("../../vendor/", import.meta.url);

let runtimePromise = null; // single-flight boot
let queue = Promise.resolve(); // one conversion at a time

function ensureRuntime(onStatus) {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const { loadPyodide } = await import(new URL("pyodide/pyodide.mjs", VENDOR));
      const sources = {};
      const fetchSource = async (name, url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
        sources[name] = new Uint8Array(await res.arrayBuffer());
      };
      await Promise.all([
        ...CONVERTER_SOURCES.map((n) => fetchSource(n, new URL(`converters/${n}`, VENDOR))),
        fetchSource(SF2BANK_SOURCE, new URL(SF2BANK_SOURCE, import.meta.url)),
      ]);
      return loadConverterRuntime({
        loadPyodide,
        indexURL: new URL("pyodide/", VENDOR).href,
        sources,
        onStatus,
      });
    })();
    runtimePromise.catch(() => { runtimePromise = null; }); // allow retry after a failed boot
  }
  return runtimePromise;
}

/** Build the runConverter spec for one incoming message. */
function jobSpec(m) {
  if (m.t === "convert") {
    const conv = converterFor(m.fileName);
    if (!conv) throw new Error(`no converter for ${m.fileName}`);
    if (conv.isMidi && !m.sf2) throw new Error("MIDI conversion needs a soundfont");
    const inPath = "/in." + m.fileName.toLowerCase().split(".").pop();
    const inputs = [{ path: inPath, bytes: new Uint8Array(m.bytes) }];
    if (conv.isMidi) inputs.push({ path: "/sf.sf2", bytes: new Uint8Array(m.sf2.bytes) });
    return {
      label: `converting ${m.fileName}…`,
      script: conv.script,
      argv: buildArgv({ isMidi: conv.isMidi, inPath, sf2Path: "/sf.sf2", outPath: "/out.taud" }),
      inputs,
      output: "/out.taud",
    };
  }
  // m.t === "sf2": the sf2bank driver — list presets or build a bank
  const inputs = [{ path: "/sf.sf2", bytes: new Uint8Array(m.bytes) }];
  if (m.mode === "list") {
    return {
      label: "reading soundfont presets…",
      script: SF2BANK_SOURCE,
      argv: ["list", "/sf.sf2", "/out.json"],
      inputs,
      output: "/out.json",
    };
  }
  inputs.push({ path: "/sel.json", bytes: new TextEncoder().encode(JSON.stringify(m.selection)) });
  return {
    label: `building bank (${m.selection.length} presets)…`,
    script: SF2BANK_SOURCE,
    argv: ["build", "/sf.sf2", "/sel.json", "/out.tsii", "--bpm", String(m.bpm ?? 125)],
    inputs,
    output: "/out.tsii",
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t !== "convert" && m.t !== "sf2") return;
  const status = (line) => self.postMessage({ t: "status", id: m.id, line });
  queue = queue.then(async () => {
    try {
      const spec = jobSpec(m); // validate the request before paying for boot
      const py = await ensureRuntime(status);
      status(spec.label);
      const out = runConverter(py, { ...spec, onLog: status });
      const buf = out.slice().buffer;
      self.postMessage({ t: "done", id: m.id, bytes: buf }, [buf]);
    } catch (err) {
      self.postMessage({ t: "error", id: m.id, message: String(err.message ?? err) });
    }
  });
};
