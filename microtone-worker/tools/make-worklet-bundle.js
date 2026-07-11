#!/usr/bin/env node
// Concatenate the engine + worklet module graph into a single classic-script
// worklet file for browsers whose AudioWorklet cannot import ES modules
// (historically Firefox). Output is COMMITTED: src/worklet/taud-processor.bundle.js
// — regenerate after any engine change: node tools/make-worklet-bundle.js
//
// The strip is naive by design (this repo's import/export usage is uniform):
//   - `import {...} from "...";` statements removed (multi-line supported)
//   - leading `export ` keywords removed
// Duplicate local helpers (e.g. clamp) are benign re-declarations.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const FILES = [
  "src/engine/constants.js",
  "src/engine/minifloat.js",
  "src/engine/rng.js",
  "src/engine/tables.js",
  "src/engine/inst.js",
  "src/engine/voice.js",
  "src/engine/state.js",
  "src/engine/sampler.js",
  "src/engine/filter.js",
  "src/engine/envelope.js",
  "src/engine/trigger.js",
  "src/engine/effects.js",
  "src/engine/row.js",
  "src/engine/tick.js",
  "src/engine/mixer.js",
  "src/engine/engine.js",
  "src/worklet/protocol.js",
  "src/audio/audio-ring.js",
  "src/worklet/engine-commands.js",
  "src/worklet/taud-processor.js",
];

let out = `// GENERATED FILE — do not edit. Rebuild with: node tools/make-worklet-bundle.js
// Single-file concat of src/engine/* + src/worklet/* for non-module AudioWorklets.
"use strict";
`;

for (const rel of FILES) {
  let src = await readFile(root + rel, "utf8");
  src = src.replace(/^import\s[\s\S]*?from\s*"[^"]+";\s*$/gm, "");
  src = src.replace(/^export\s+(function|const|class|let|var)/gm, "$1");
  out += `\n// ══ ${rel} ══\n${src}`;
}

// Sanity: no import/export may survive.
if (/^\s*(import|export)\s/m.test(out)) {
  const line = out.split("\n").find((l) => /^\s*(import|export)\s/.test(l));
  throw new Error(`unstripped module syntax: ${line}`);
}

await writeFile(root + "src/worklet/taud-processor.bundle.js", out);
console.log(`wrote src/worklet/taud-processor.bundle.js (${out.length} bytes)`);
