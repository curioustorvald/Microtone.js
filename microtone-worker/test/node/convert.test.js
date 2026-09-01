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
import { CUE_EMPTY, NUM_PATTERNS_MAX } from "../../src/format/taud-const.js";
import { tuningRatioOf } from "../../src/engine/tables.js";
import { presetForNotation, surveyTuning } from "../../src/ui/pitchtables.js";
import { Document, combineTpif, sampleSpans, isStereoSample } from "../../src/doc/document.js";
import { planImport } from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { loadIntoEngine } from "../../src/audio/offline-render.js";
import { TRACKER_CHUNK } from "../../src/engine/constants.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { patchIsStereo } from "../../src/engine/inst.js";

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
      keepDuplicatePatterns: opts.keepDuplicatePatterns === true,
      quantise: opts.quantise ?? null,
      quantiseStrength: opts.quantiseStrength ?? 100,
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

test("buildArgv opts IN to stereo samples only when asked (item 90.1)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, stereoSamples: false }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, stereoSamples: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--stereo-samples"]);
  // Stacks with the other MIDI options, in argparse-safe order.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches", "--stereo-samples"]);
  // Tracker argv never carries it — it is a SoundFont concern.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.it", outPath: "/out.taud", stereoSamples: true }),
    ["/in.it", "/out.taud", "-v"]);
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

test("buildArgv opts IN to keeping duplicate patterns only when asked", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the converter pools byte-identical patterns.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, keepDuplicatePatterns: false }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, keepDuplicatePatterns: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--no-dedup-patterns"]);
  // Stacks with the other MIDI options, in argparse-safe order.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true,
                               keepDuplicatePatterns: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches",
     "--stereo-samples", "--no-dedup-patterns"]);
  // Pattern pooling is a MIDI-converter concern — tracker argv never carries it.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud",
                               keepDuplicatePatterns: true }),
    ["/in.mod", "/out.taud", "-v"]);
});

test("buildArgv opts IN to quantisation only when asked (item 168)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the performance's own timing is what gets converted.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, quantise: null }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, quantise: "off" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, quantise: "auto" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "auto"]);
  assert.deepEqual(buildArgv({ ...base, quantise: "row" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "row"]);
  assert.deepEqual(buildArgv({ ...base, quantise: 16 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "16"]);
  // Full strength is the converter's own default, so it is never spelled out.
  assert.deepEqual(buildArgv({ ...base, quantise: 8, quantiseStrength: 100 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "8"]);
  assert.deepEqual(buildArgv({ ...base, quantise: 8, quantiseStrength: 50 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "8", "--quantise-strength", "50"]);
  // A strength with no grid is not a request to quantise.
  assert.deepEqual(buildArgv({ ...base, quantiseStrength: 50 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  // Stacks with the other MIDI options, in argparse-safe order.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true,
                               keepDuplicatePatterns: true, quantise: "auto" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches",
     "--stereo-samples", "--no-dedup-patterns", "--quantise", "auto"]);
  // Timing quantisation is a MIDI concern — tracker argv never carries it.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud",
                               quantise: "auto" }),
    ["/in.mod", "/out.taud", "-v"]);
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
  assert.equal(preset.name, "ProTracker Temperament"); // renamed in e31d771

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
  // Item 115.2: IT's song message rides across as PMsg, CR-separated lines
  // translated to LF and the editor's trailing padding trimmed.
  const msg = doc.projectString("PMsg");
  assert.ok(msg.startsWith("\n                               Twilight Tears\n\n"), msg.slice(0, 60));
  assert.ok(msg.includes("Composed as a very simple example of how to use virtual channels."));
  assert.ok(!msg.includes("\r"), "CR must not survive into PMsg");
  assert.ok(!/[ \t]\n/.test(msg), "trailing line padding must be trimmed");
  assert.ok(!msg.endsWith("\n"), "trailing blank lines must be trimmed");
});

/** Every {note trigger, effect opcode} pair the songs of `doc` carry, as
 *  [[note, inst, op], …]. Taud opcodes are base-36 digit values: G = 16, L = 21,
 *  S = 28. */
function triggerCells(doc) {
  const out = [];
  for (const song of doc.songs) {
    for (const pat of song.patterns) {
      for (let r = 0; r < 64; r++) {
        const o = r * 8;
        const note = pat[o] | (pat[o + 1] << 8);
        if (note < 0x20) continue;                // not a pitch trigger
        out.push({ note, inst: pat[o + 2], op: pat[o + 5], arg: pat[o + 6] | (pat[o + 7] << 8) });
      }
    }
  }
  return out;
}

test("it2taud drops the instrument byte from porta-tied rows (item 169)", () => {
  // ImpulseTracker does not reset the envelopes when a note carries both an
  // instrument number and a tone portamento; the Taud engine deliberately DOES
  // re-attack there (item 124), so the converter writes the passage the way an
  // IT author's ear expects instead — without the instrument byte. TUTE.IT
  // carries three such rows (two G, one L), and every one of them names the
  // instrument the channel is already holding, so all three lose the byte.
  const cells = triggerCells(parseTaud(convert("TUTE.IT")));
  const tied = cells.filter((c) => c.op === 16 || c.op === 21);   // G, L
  assert.ok(tied.length > 0, "premise: the file HAS porta-tied notes");
  assert.deepEqual(tied.filter((c) => c.inst !== 0), [],
    "no porta-tied trigger may still carry an instrument byte");
  // The drop is surgical: ordinary triggers keep theirs.
  assert.ok(cells.some((c) => c.op !== 16 && c.op !== 21 && c.inst !== 0),
    "plain triggers still name their instrument");
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

    // Item 77: the converter pins MIDI key 60 to noteVal 0x5000, and key 60 is
    // concert middle C — so it must DECLARE concert. Declaring the tracker
    // default (C9 @ 8363) would now drag the whole song 1.87 cents flat, since
    // the engine no longer ignores these fields. A4 @ 440 is also the
    // exact-identity pair, so this render is unchanged by tuning existing.
    assert.equal(doc.songs[0].tuningBaseNote, 0x5c00, "must declare A4");
    assert.equal(doc.songs[0].tuningFreq, 440, "must declare 440 Hz");
    assert.ok(Object.is(tuningRatioOf(doc.songs[0].tuningBaseNote, doc.songs[0].tuningFreq), 1.0),
      "a concert declaration must be the exact-identity tuning");
  });

// Item 159 — pattern $0000 is the index an editor hands out for a newly-added
// channel or cue, so a converted song must not have real music sitting there.
test("midi2taud reserves pattern $0000 for silence (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    for (const opts of [{}, { keepDuplicatePatterns: true }]) {
      const song = parseTaud(convert("M_E1M1.mid", opts)).songs[0];
      const p0 = song.patterns[0];
      let sounding = 0;
      for (let r = 0; r < 64; r++) {
        const o = r * 8;
        // note / instrument / effect opcode — the vol+pan bytes are 0xC0 no-ops
        // in a filler cell, so they say nothing about whether it sounds.
        if (p0[o] || p0[o + 1] || p0[o + 2] || p0[o + 5]) sounding++;
      }
      assert.equal(sounding, 0,
        `pattern $0000 must be silent (${sounding} rows carry something)`);
    }
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

test("midi2taud --quantise puts every onset on a row (item 168; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    // S $Dx is the ONLY way a Taud pattern can say "this note starts part way
    // through the row", so it is the exact residue of off-grid timing: a
    // conversion quantised onto the row grid cannot need one, and an
    // unquantised conversion of the same MIDI does.
    const subRowDelays = (bytes) => triggerCells(parseTaud(bytes))
      .filter((c) => c.op === 0x1c && ((c.arg >>> 12) & 0xf) === 0xd).length;

    const played = subRowDelays(convert("M_E1M1.mid"));
    assert.ok(played > 0, "premise: the unquantised import carries note delays");
    assert.equal(subRowDelays(convert("M_E1M1.mid", { quantise: "row" })), 0,
      "--quantise row leaves no sub-row timing to express");
    // "auto" picks the subdivision the onsets already use, which is never finer
    // than the row grid the picker chose for them.
    assert.equal(subRowDelays(convert("M_E1M1.mid", { quantise: "auto" })), 0,
      "--quantise auto lands on rows too");
    // …and strength 0 is a no-op, which is what makes the strength dial safe.
    assert.equal(subRowDelays(convert("M_E1M1.mid", { quantise: "row", quantiseStrength: 0 })),
      played, "strength 0 moves nothing");
  });

test("midi2taud --no-dedup-patterns unshares patterns without changing the song (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const song = (bytes) => parseTaud(bytes).songs[0];
    const pooled = song(convert("M_E1M1.mid"));                              // default
    const unshared = song(convert("M_E1M1.mid", { keepDuplicatePatterns: true }));

    // The cue sheet is the same shape either way — only what its words POINT AT
    // changes, so walk both cue×voice grids and compare the pattern each cell
    // resolves to. Byte-identical everywhere ⇒ the song is note-for-note the same.
    assert.equal(unshared.cues.length, pooled.cues.length);
    const cellAt = (s, c, ch) => {
      const w = s.cues[c][ch] & CUE_EMPTY;
      return w === CUE_EMPTY ? "-" : Buffer.from(s.patterns[w]).toString("hex");
    };
    for (let c = 0; c < pooled.cues.length; c++) {
      for (let ch = 0; ch < pooled.cues[c].length; ch++) {
        assert.equal(cellAt(unshared, c, ch), cellAt(pooled, c, ch),
          `cue ${c} channel ${ch} differs`);
      }
    }

    // How often each pattern index is referenced. Pooling MUST produce reuse on
    // a song this repetitive (E1M1's silent columns alone repeat), and the flag
    // MUST remove all of it: one private pattern per occupied cue×voice cell.
    const refCounts = (s) => {
      const n = new Map();
      for (const words of s.cues) {
        for (const w of words) {
          const p = w & CUE_EMPTY;
          if (p !== CUE_EMPTY) n.set(p, (n.get(p) ?? 0) + 1);
        }
      }
      return n;
    };
    const pooledRefs = refCounts(pooled), unsharedRefs = refCounts(unshared);
    assert.ok([...pooledRefs.values()].some((n) => n > 1),
      "the default build should share at least one pattern between cues");
    assert.deepEqual([...unsharedRefs.values()].filter((n) => n > 1), [],
      "--no-dedup-patterns must leave no pattern referenced twice");
    // Same number of occupied cells, spread over strictly more patterns.
    assert.equal(unsharedRefs.size, [...pooledRefs.values()].reduce((a, b) => a + b, 0));
    assert.ok(unshared.patterns.length > pooled.patterns.length,
      `unshared (${unshared.patterns.length}) should exceed pooled (${pooled.patterns.length})`);
    assert.ok(unshared.patterns.length <= NUM_PATTERNS_MAX);
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

// ── stereo samples (item 90) ───────────────────────────────────────────────

test("it2taud keeps an IT stereo sample as a stereo pair, --mono-samples folds it", () => {
  // TUTE-stereo.it is TUTE.IT with sample 1 ("Low Strings") turned into a
  // stereo sample whose right channel is the left inverted about the DC centre.
  const stereoDoc = new Document(parseTaud(convert("TUTE-stereo.it")));
  const monoDoc = new Document(parseTaud(convert("TUTE.IT")));

  const list = stereoDoc.sampleList();
  const pair = list.filter(isStereoSample);
  assert.equal(pair.length, 1, "exactly one sample came through stereo");
  assert.equal(pair[0].name, "Low Strings");
  assert.deepEqual(sampleSpans(pair[0]).length, 2);

  // Both channels are pooled, and they genuinely differ.
  const [l, r] = sampleSpans(pair[0]);
  let diff = 0;
  for (let i = 0; i < pair[0].len; i++) {
    if (stereoDoc.sampleBin[l.ptr + i] !== stereoDoc.sampleBin[r.ptr + i]) diff++;
  }
  assert.ok(diff > pair[0].len * 0.9, `channels must differ (${diff}/${pair[0].len})`);

  // The census still names one sample per pair — same list as the mono file.
  assert.deepEqual(list.map((s) => s.name), monoDoc.sampleList().map((s) => s.name));

  // The instrument that plays it carries an 's' patch, and it sounds in stereo.
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(convert("TUTE-stereo.it")));
  const slot = stereoDoc.usedInstrumentSlots()
    .find((s) => (stereoDoc.instruments[s].extraPatches ?? []).some(patchIsStereo));
  assert.ok(slot, "some instrument carries the stereo patch");
  eng.setMasterVolume(0, 255);
  eng.jamNote(0, 0, 0x5000, slot);
  assert.equal(eng.playheads[0].trackerState.voices[0].activeChanCount, 2);
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let spread = 0, level = 0, n = 0;
  for (let c = 0; c < 20; c++) {
    eng.renderChunk(0, out);
    const ts = eng.playheads[0].trackerState;
    for (let i = 0; i < ts.mixLeft.length; i++) {
      spread += Math.abs(ts.mixLeft[i] - ts.mixRight[i]);
      level += Math.abs(ts.mixLeft[i]);
      n++;
    }
  }
  assert.ok(level / n > 0.001, "the note must sound");
  assert.ok(spread / n > level / n * 0.5, "left and right must differ");

  // --mono-samples reproduces the old downmix: no stereo, no extra pool bytes.
  const folded = new Document(parseTaud(runConverter(py, {
    script: "it2taud.py",
    argv: ["/in.it", "/out.taud", "-v", "--mono-samples"],
    inputs: [{ path: "/in.it", bytes: readFileSync(importDir + "TUTE-stereo.it") }],
    output: "/out.taud",
    onLog: () => {},
  })));
  assert.equal(folded.sampleList().filter(isStereoSample).length, 0);
});

test("midi2taud --stereo-samples imports SF2 pairs as stereo (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const run = (extra) => new Document(parseTaud(runConverter(py, {
      script: "midi2taud.py",
      argv: buildArgv({
        isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud",
        ...extra,
      }),
      inputs: [
        { path: "/in.mid", bytes: readFileSync(importDir + "M_E1M1.mid") },
        { path: "/sf.sf2", bytes: readFileSync(sf2Path) },
      ],
      output: "/out.taud",
      onLog: () => {},
    })));
    const poolBytes = (doc) =>
      doc.sampleList().reduce((n, e) => n + e.len * sampleSpans(e).length, 0);

    const mono = run({});
    assert.equal(mono.sampleList().filter(isStereoSample).length, 0,
      "mono stays the default for MIDI imports");
    const stereo = run({ stereoSamples: true });
    // Whether GeneralUser's presets use stereo pairs at all is the SF2's
    // business; the invariants are that the flag never loses samples, never
    // shrinks the pool, and that any stereo entry is a genuine two-span pair
    // the engine will play as such.
    assert.equal(stereo.sampleList().length, mono.sampleList().length);
    assert.ok(poolBytes(stereo) >= poolBytes(mono));
    for (const e of stereo.sampleList().filter(isStereoSample)) {
      assert.equal(sampleSpans(e).length, 2);
      assert.notEqual(e.chanPtrs[0], e.ptr);
    }
    for (const slot of stereo.usedInstrumentSlots()) {
      for (const p of stereo.instruments[slot].extraPatches ?? []) {
        if (patchIsStereo(p)) assert.equal(p.chanPtrs.length, 1);
      }
    }
  });

test("sf2bank --stereo doubles the pool and marks the samples stereo (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const sf2 = { path: "/sf.sf2", bytes: readFileSync(sf2Path) };
    const sel = JSON.stringify([[0, 0]]); // Grand Piano
    const build = (extra) => new Document(parseTaud(runConverter(py, {
      script: SF2BANK_SOURCE,
      argv: ["build", "/sf.sf2", "/sel.json", "/out.tsii", "--bpm", "125", ...extra],
      inputs: [sf2, { path: "/sel.json", bytes: new TextEncoder().encode(sel) }],
      output: "/out.tsii",
      onLog: () => {},
    })));
    const poolBytes = (doc) =>
      doc.sampleList().reduce((n, e) => n + e.len * sampleSpans(e).length, 0);

    const mono = build([]);
    const stereo = build(["--stereo"]);
    assert.equal(mono.sampleList().filter(isStereoSample).length, 0,
      "mono is still the default (item 90.1 is opt-in)");
    // GeneralUser's Grand Piano may or may not be built from stereo pairs; the
    // invariant either way is that --stereo never LOSES samples and never
    // shrinks the pool, and that any stereo entry costs exactly two spans.
    assert.equal(stereo.sampleList().length, mono.sampleList().length);
    assert.ok(poolBytes(stereo) >= poolBytes(mono));
    for (const e of stereo.sampleList().filter(isStereoSample)) {
      assert.equal(sampleSpans(e).length, 2);
      assert.notEqual(e.chanPtrs[0], e.ptr);
    }
  });
