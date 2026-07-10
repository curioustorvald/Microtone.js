// Conversion core — drives the vendored, UNMODIFIED *2taud.py converters
// inside a Pyodide runtime. Environment-agnostic: the Web Worker
// (convert.worker.js) and the Node tests both call loadConverterRuntime /
// runConverter, differing only in how they obtain the vendor file bytes.
//
// The converters are canonical tsvm sources (vendor/VENDOR-VERSIONS.md);
// running them verbatim is the whole point — no JS port to drift.

/** Converter script per input extension. */
export const CONVERTERS = {
  mod: "mod2taud.py",
  s3m: "s3m2taud.py",
  it: "it2taud.py",
  xm: "xm2taud.py",
  mon: "mon2taud.py",
  mid: "midi2taud.py",
  midi: "midi2taud.py",
};

export const CONVERTER_SOURCES = [
  "taud_common.py", "mod2taud.py", "s3m2taud.py", "it2taud.py",
  "xm2taud.py", "mon2taud.py", "midi2taud.py",
];

/** Microtone.js's own SF2→bank driver (src/convert/sf2bank.py) — installed
 *  alongside the vendored converters; imports midi2taud from the same dir. */
export const SF2BANK_SOURCE = "sf2bank.py";

/** {script, isMidi} for a file name, or null when it's not a convertible type. */
export function converterFor(name) {
  const ext = name.toLowerCase().split(".").pop();
  const script = CONVERTERS[ext];
  if (!script) return null;
  return { script, isMidi: script === "midi2taud.py" };
}

/**
 * Load Pyodide and install the converter sources on its MEMFS.
 * @param loadPyodide  the function from vendor/pyodide/pyodide.mjs
 * @param indexURL     URL/path of vendor/pyodide/
 * @param sources      {fileName: Uint8Array} for CONVERTER_SOURCES
 * @param onStatus     optional (line) => void progress callback
 */
export async function loadConverterRuntime({ loadPyodide, indexURL, sources, onStatus }) {
  onStatus?.("loading Python runtime…");
  const py = await loadPyodide({ indexURL });
  py.FS.mkdirTree("/converters");
  for (const name of CONVERTER_SOURCES) {
    if (!sources[name]) throw new Error(`missing converter source ${name}`);
  }
  for (const [name, bytes] of Object.entries(sources)) {
    py.FS.writeFile(`/converters/${name}`, bytes);
  }
  py.runPython(`import sys; sys.path.insert(0, "/converters")`);
  onStatus?.(`Python ${py.runPython("import sys; sys.version.split()[0]")} ready`);
  return py;
}

/**
 * Run one converter inside a loaded runtime. Inputs are written to MEMFS,
 * argv is passed through unchanged (paths must reference the input names
 * below), stdout+stderr stream to onLog, and the produced file is returned.
 * All per-run MEMFS files are removed afterwards.
 *
 * @param py       runtime from loadConverterRuntime
 * @param script   e.g. "xm2taud.py"
 * @param argv     converter argv AFTER the script name, e.g. ["/in.xm", "/out.taud"]
 * @param inputs   [{path, bytes}] to place on MEMFS
 * @param output   MEMFS path the converter writes (must appear in argv)
 * @param onLog    optional (line) => void for converter output
 * @returns Uint8Array of the produced file
 */
export function runConverter(py, { script, argv, inputs, output, onLog }) {
  for (const f of inputs) py.FS.writeFile(f.path, f.bytes);
  const log = (line) => { if (line.trim() !== "") onLog?.(line); };
  py.setStdout({ batched: log });
  py.setStderr({ batched: log });
  try {
    // argv as a JSON literal — a JSON string is a valid Python string literal,
    // so no globals/PyProxy lifetime to manage.
    const argvJson = JSON.stringify(JSON.stringify([script, ...argv]));
    py.runPython(`
import sys, runpy, json
sys.argv = json.loads(${argvJson})
try:
    runpy.run_path("/converters/" + sys.argv[0], run_name="__main__")
except SystemExit as e:
    if e.code not in (0, None):
        raise RuntimeError(f"converter exited with code {e.code}") from None
`);
    return py.FS.readFile(output);
  } finally {
    py.setStdout();
    py.setStderr();
    for (const f of inputs) {
      try { py.FS.unlink(f.path); } catch { /* not created */ }
    }
    try { py.FS.unlink(output); } catch { /* converter failed before writing */ }
  }
}

/** argv for a conversion: tracker files take (in, out); MIDI adds the
 *  soundfont. Converter defaults are used as-is — notably far-loop
 *  synth-loop rescue, which upstream midi2taud now applies by default
 *  (opt-out is --no-force-synth-loop). -v streams the converter's vprint
 *  diagnostics through the status channel (the import progress popup). */
export function buildArgv({ isMidi, inPath, sf2Path, outPath }) {
  return isMidi ? [inPath, sf2Path, outPath, "-v"] : [inPath, outPath, "-v"];
}
