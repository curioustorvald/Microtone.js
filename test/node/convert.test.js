// Conversion pipeline — the vendored *2taud.py converters running under the
// vendored Pyodide runtime, driven through the SAME convert-core the Web
// Worker uses. Slow (~1 s runtime boot + real conversions) but it proves the
// whole import path headlessly: tracker file in → parseable .taud out that
// the Document layer accepts.
//
// The MIDI test needs a soundfont: it uses GeneralUser-GS.sf2 from the repo
// root (32 MB, not committed) and auto-skips when absent — same pattern as
// the conformance suite's reference dumps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "../../vendor/pyodide/pyodide.js";
import {
  CONVERTER_SOURCES, SF2BANK_SOURCE, converterFor, loadConverterRuntime,
  runConverter, buildArgv,
} from "../../src/convert/convert-core.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { Document, combineTpif } from "../../src/doc/document.js";
import { planImport } from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const importDir = root + "test/corpus/import/";
const sf2Path = root + "GeneralUser-GS.sf2";

const sources = {};
for (const name of CONVERTER_SOURCES) {
  sources[name] = await readFile(root + "vendor/converters/" + name);
}
sources[SF2BANK_SOURCE] = await readFile(root + "src/convert/" + SF2BANK_SOURCE);
const py = await loadConverterRuntime({
  loadPyodide,
  indexURL: root + "vendor/pyodide/",
  sources,
});

function convert(fileName, opts = {}) {
  const conv = converterFor(fileName);
  const inPath = "/in." + fileName.toLowerCase().split(".").pop();
  const inputs = [{ path: inPath, bytes: readFileSync(importDir + fileName) }];
  if (conv.isMidi) inputs.push({ path: "/sf.sf2", bytes: readFileSync(sf2Path) });
  return runConverter(py, {
    script: conv.script,
    argv: buildArgv({ isMidi: conv.isMidi, inPath, sf2Path: "/sf.sf2", outPath: "/out.taud" }),
    inputs,
    output: "/out.taud",
    onLog: () => {},
  });
}

test("converterFor maps extensions", () => {
  assert.equal(converterFor("song.XM").script, "xm2taud.py");
  assert.equal(converterFor("a.b.mod").script, "mod2taud.py");
  assert.ok(converterFor("x.MID").isMidi);
  assert.equal(converterFor("song.taud"), null);
  assert.equal(converterFor("noext"), null);
});

test("xm2taud under Pyodide → parseable, loadable document", () => {
  const out = convert("milky.xm");
  const doc = new Document(parseTaud(out));
  assert.equal(doc.kind, "taud");
  assert.equal(doc.songs.length, 1);
  assert.ok(doc.songs[0].patterns.length > 0);
  assert.ok(doc.usedInstrumentSlots().length > 0);
  assert.ok(doc.sampleList().length > 0);
});

test("it2taud under Pyodide → parseable, loadable document", () => {
  const out = convert("TUTE.IT");
  const doc = new Document(parseTaud(out));
  assert.equal(doc.kind, "taud");
  assert.ok(doc.songs[0].patterns.length > 0);
  assert.ok(doc.usedInstrumentSlots().length > 0);
});

test("failed conversion raises and leaves the runtime reusable", () => {
  assert.throws(() => {
    runConverter(py, {
      script: "xm2taud.py",
      argv: ["/nope.xm", "/out.taud"],
      inputs: [{ path: "/nope.xm", bytes: Uint8Array.from([0, 1, 2, 3]) }],
      output: "/out.taud",
      onLog: () => {},
    });
  });
  // runtime still healthy afterwards
  const out = convert("milky.xm");
  assert.equal(parseTaud(out).kind, "taud");
});

test(".tsii + .tpif (batch mode) combine EXACTLY into the single-file conversion",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    // midi2taud directory mode → shared bank + per-song pattern image
    py.FS.mkdirTree("/mididir");
    py.FS.mkdirTree("/outdir");
    py.FS.writeFile("/mididir/M_E1M1.mid", readFileSync(importDir + "M_E1M1.mid"));
    const tpifBytes = runConverter(py, {
      script: "midi2taud.py",
      argv: ["/mididir", "/sf.sf2", "/outdir"],
      inputs: [{ path: "/sf.sf2", bytes: readFileSync(sf2Path) }],
      output: "/outdir/M_E1M1.tpif",
      onLog: () => {},
    });
    const tsiiBytes = py.FS.readFile("/outdir/sf.tsii"); // sf_stem of /sf.sf2

    const tsii = parseTaud(new Uint8Array(tsiiBytes));
    const tpif = parseTaud(new Uint8Array(tpifBytes));
    assert.equal(tsii.kind, "tsii");
    assert.equal(tpif.kind, "tpif");
    assert.equal(tpif.sampleInstImage, null);

    const combined = combineTpif(tsii, tpif);
    const single = parseTaud(convert("M_E1M1.mid")); // same flags via buildArgv
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    assert.ok(eq(combined.sampleInstImage, single.sampleInstImage), "image byte-equal");
    const cs = combined.songs[0], ss = single.songs[0];
    assert.equal(cs.patterns.length, ss.patterns.length);
    cs.patterns.forEach((p, i) => assert.ok(eq(p, ss.patterns[i]), `pattern ${i}`));
    cs.cues.forEach((c, i) => assert.deepEqual([...c], [...ss.cues[i]], `cue ${i}`));
    assert.equal(cs.bpm, ss.bpm);
    assert.equal(cs.tickRate, ss.tickRate);

    // the combined document is a full, saveable .taud
    const doc = new Document(combined);
    assert.deepEqual(doc.meta.songMeta[0], new Document(single).meta.songMeta[0]);
    const re = parseTaud(doc.toBytes());
    assert.equal(re.kind, "taud");
    assert.ok(eq(re.sampleInstImage, combined.sampleInstImage));
  });

test("sf2bank: list presets + build bank + merge into a project (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const sf2 = { path: "/sf.sf2", bytes: readFileSync(sf2Path) };

    const listOut = runConverter(py, {
      script: SF2BANK_SOURCE,
      argv: ["list", "/sf.sf2", "/out.json"],
      inputs: [sf2],
      output: "/out.json",
      onLog: () => {},
    });
    const presets = JSON.parse(Buffer.from(listOut).toString());
    assert.ok(presets.length > 100, `GeneralUser lists ${presets.length} presets`);
    assert.ok(presets.some((p) => p.name === "Grand Piano" && p.bank === 0 && p.program === 0));
    assert.ok(presets.some((p) => p.bank === 128), "has drum kits");

    const sel = JSON.stringify([[0, 0], [128, 0]]); // Grand Piano + Standard 1
    const tsii = runConverter(py, {
      script: SF2BANK_SOURCE,
      argv: ["build", "/sf.sf2", "/sel.json", "/out.tsii", "--bpm", "125"],
      inputs: [sf2, { path: "/sel.json", bytes: new TextEncoder().encode(sel) }],
      output: "/out.tsii",
      onLog: () => {},
    });
    const src = new Document(parseTaud(tsii));
    assert.equal(src.kind, "tsii");
    const topLevel = src.usedInstrumentSlots().filter((s) => s <= 255);
    assert.equal(topLevel.length, 2, "one slot per selected preset");
    assert.equal(src.instrumentName(topLevel[0]), "Grand Piano");
    assert.ok(src.instruments[topLevel[1]].isPercussion, "drum kit carries the P flag");

    // merge into a real project through the same pipeline the UI uses
    const dest = new Document(parseTaud(readFileSync(root + "test/corpus/WHEN.taud")));
    const before = Buffer.from(dest.toBytes());
    const undo = new UndoStack(dest);
    const plan = planImport(dest, src, topLevel);
    assert.ok(!plan.error, plan.error);
    undo.apply(importBankOp(plan));
    const gp = plan.slotMap.get(topLevel[0]);
    assert.equal(dest.instrumentName(gp), "Grand Piano");
    undo.undo();
    assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
  });

test("midi2taud with GeneralUser-GS → parseable document (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const out = convert("M_E1M1.mid");
    const doc = new Document(parseTaud(out));
    assert.equal(doc.kind, "taud");
    assert.ok(doc.songs[0].patterns.length > 0);
    const used = doc.usedInstrumentSlots();
    assert.ok(used.length > 0);
    // E1M1 layers presets → expect at least one Metainstrument, like the
    // corpus M_E1M1.taud built by the same converter natively
    assert.ok(used.some((s) => doc.instruments[s].isMeta));
  });
