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
import { presetForNotation, surveyTuning } from "../../src/ui/pitchtables.js";
import { Document, combineTpif } from "../../src/doc/document.js";
import { planImport } from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { loadIntoEngine } from "../../src/audio/offline-render.js";
import { TRACKER_CHUNK } from "../../src/engine/constants.js";
import { TaudEngine } from "../../src/engine/engine.js";

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
    argv: buildArgv({
      isMidi: conv.isMidi, inPath, sf2Path: "/sf.sf2", outPath: "/out.taud",
      rpb: opts.rpb ?? null, trimPatches: opts.trimPatches === true,
    }),
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

test("buildArgv pins MIDI rows-per-beat only when requested (item 62)", () => {
  const midi = (rpb) => buildArgv({ isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud", rpb });
  // auto (null / omitted / "auto") → no --rpb, converter picks the grid
  assert.deepEqual(midi(null), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(midi("auto"), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  // pinned value → --rpb N appended (string, matching the argparse choices)
  assert.deepEqual(midi(8), ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8"]);
  assert.deepEqual(midi("16"), ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "16"]);
  // rpb is MIDI-only — tracker argv never carries it
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.xm", outPath: "/out.taud", rpb: 8 }),
    ["/in.xm", "/out.taud", "-v"]);
});

test("buildArgv opts IN to patch trimming only when asked (item 75)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the converter keeps each preset's full zone map and the
  // editor's Housekeeping decides what to drop.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, trimPatches: false }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, trimPatches: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--trim-unused-patches"]);
  // Composes with --rpb, and stays MIDI-only.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches"]);
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.xm", outPath: "/out.taud", trimPatches: true }),
    ["/in.xm", "/out.taud", "-v"]);
});

/** A minimal 4-channel "M.K." module: one pattern, one note per row, each a
 *  period straight out of ProTracker's table. Synthesised rather than shipped
 *  as a corpus binary so the periods under test are visible right here. */
function makeMod(periods) {
  const N_SAMPLES = 31, CH = 4, SAMPLE_WORDS = 8;
  const head = 20 + N_SAMPLES * 30 + 1 + 1 + 128 + 4;
  const buf = new Uint8Array(head + 1024 + SAMPLE_WORDS * 2);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  put(0, "pt-grid probe");
  const s1 = 20;                       // sample 1's 30-byte header
  put(s1, "probe");
  buf[s1 + 23] = SAMPLE_WORDS;         // length in words (big-endian)
  buf[s1 + 25] = 64;                   // volume; finetune 0, loop len 1 = none
  buf[s1 + 29] = 1;
  const o = 20 + N_SAMPLES * 30;
  buf[o] = 1;                          // one order, and it plays pattern 0
  buf[o + 1] = 127;                    // restart
  put(o + 2 + 128, "M.K.");
  periods.forEach((period, row) => {
    const c = head + row * CH * 4;      // channel 0 of this row
    buf[c] = (period >> 8) & 0x0f;      // sample hi nibble 0 | period hi
    buf[c + 1] = period & 0xff;
    buf[c + 2] = 1 << 4;                // sample 1 lo nibble, effect 0
  });
  return buf;
}

test("mod2taud stamps notation 1 and its notes land on the ProTracker grid", () => {
  // A spread across PT's range, including all four entries whose octave is not
  // a clean doubling (D-3 190, E-3 170, G-3 143, G#3 135) plus B-1 453 — the
  // notes no octave-repeating table could place.
  const periods = [428, 404, 381, 339, 170, 143, 135, 190, 453, 856, 214, 113];
  const out = runConverter(py, {
    script: "mod2taud.py",
    argv: buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud" }),
    inputs: [{ path: "/in.mod", bytes: makeMod(periods) }],
    output: "/out.taud",
    onLog: () => {},
  });
  const doc = new Document(parseTaud(out));
  assert.equal(doc.meta.songMeta[0].notation, 1, "sMet notation must be ProTracker pitch");
  const preset = presetForNotation(doc.meta.songMeta[0].notation, doc);
  assert.equal(preset.name, "ProTracker pitch");

  const onPt = surveyTuning(doc.songs[0], preset, null);
  assert.equal(onPt.total, periods.length);
  assert.equal(onPt.offGrid, 0, "a converted .mod must be fully in tune");
  assert.equal(onPt.wouldChange, 0, "and exactly on the grid, not merely near it");

  // The same notes under the old 12-TET default: the bug this fixes.
  assert.ok(surveyTuning(doc.songs[0], presetForNotation(120), null).offGrid > 0);
});

test("xm2taud under Pyodide → parseable, loadable document", () => {
  const out = convert("milky.xm");
  const doc = new Document(parseTaud(out));
  assert.equal(doc.kind, "taud");
  assert.equal(doc.songs.length, 1);
  assert.ok(doc.songs[0].patterns.length > 0);
  assert.ok(doc.usedInstrumentSlots().length > 0);
  assert.ok(doc.sampleList().length > 0);
  // #66: SNam is pool-ordered and 0-based — census sample 0 carries its own
  // name (before the fix a reserved leading '' shifted every name by one and
  // left sample 0 unnamed).
  assert.deepEqual(doc.sampleList().map((s) => s.name),
    ["beng", "bass", "perc", "lead"]);
});

test("it2taud under Pyodide → parseable, loadable document", () => {
  const out = convert("TUTE.IT");
  const doc = new Document(parseTaud(out));
  assert.equal(doc.kind, "taud");
  assert.ok(doc.songs[0].patterns.length > 0);
  assert.ok(doc.usedInstrumentSlots().length > 0);
  // #66: 0-based SNam, no leading-empty shift.
  assert.deepEqual(doc.sampleList().map((s) => s.name),
    ["Aurora", "Synth Pad", "Panflute", "Low Strings", "Open Hihat", "Bass Drum"]);
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

test("midi2taud --rpb pins the grid: more rows-per-beat → more rows (item 62; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const totalRows = (bytes) =>
      new Document(parseTaud(bytes)).songs[0].patterns
        .reduce((n, p) => n + (p ? p.length : 0), 0);
    const rows2 = totalRows(convert("M_E1M1.mid", { rpb: 2 }));
    const rows16 = totalRows(convert("M_E1M1.mid", { rpb: 16 }));
    // rows = beats × rpb (a pinned rpb is not bumped), so 16 rpb yields
    // materially more rows than 2 — proof the --rpb flag reached the converter.
    assert.ok(rows2 > 0 && rows16 > 0, "both conversions produced rows");
    assert.ok(rows16 > rows2 * 2,
      `expected 16-rpb (${rows16}) to far exceed 2-rpb (${rows2})`);
  });

test("midi2taud keeps every zone by default; --trim-unused-patches drops the untriggered ones (item 75; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const patchCount = (bytes) => {
      const doc = new Document(parseTaud(bytes));
      return doc.usedInstrumentSlots()
        .reduce((n, s) => n + (doc.instruments[s].extraPatches?.length ?? 0), 0);
    };
    const full = convert("M_E1M1.mid");                          // default: no flag
    const trimmed = convert("M_E1M1.mid", { trimPatches: true });
    const nFull = patchCount(full), nTrim = patchCount(trimmed);
    // The default now carries each preset's whole zone map, so it must hold
    // strictly more patches than the trim-to-triggered build.
    assert.ok(nTrim > 0, "the trimmed build still has patches");
    assert.ok(nFull > nTrim, `default (${nFull}) should keep more patches than trimmed (${nTrim})`);
    // The extra patches are INERT for this song: the notes it actually plays are
    // untriggered-patch-free either way, so both banks must render identically.
    const render = (bytes) => {
      const doc = new Document(parseTaud(bytes));
      const eng = new TaudEngine();
      loadIntoEngine(eng, doc.toRenderable(0), 0);
      eng.setMasterVolume(0, 255);
      eng.setCuePosition(0, 0);
      eng.play(0);
      const out = new Uint8Array(TRACKER_CHUNK * 2);
      const acc = [];
      // ~2 s of audio: enough for every voice to speak, cheap to compare.
      for (let i = 0; i < 500; i++) { eng.renderChunk(0, out); acc.push(...out); }
      return acc;
    };
    assert.deepEqual(render(full), render(trimmed),
      "untriggered patches must not change what the song sounds like");
  });
