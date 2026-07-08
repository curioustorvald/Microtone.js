This repository is a complete web build of the Microtone tracker.

Plain JavaScript ES modules, **no build step, no npm dependencies** (vendored
single-file ESM only — see `vendor/VENDOR-VERSIONS.md`). Node ≥ 22 for tests:
`node --test` (from the repo root). Source repo for all porting reference:
`/home/torvald/Documents/tsvm` (engine truth: `tsvm_core/src/net/torvald/tsvm/
peripheral/AudioAdapter.kt`; format spec: `terranmon.txt` §"Taud serialisation
format"; effects: `TAUD_NOTE_EFFECTS.md`; UI behaviour reference:
`assets/disk0/tvdos/bin/taut.js` + `taut_*.mjs`).

Architecture (decided 2026-07-08): main thread owns the canonical document
(parsed structures, invertible ops, undo); the AudioWorklet owns a playback
copy fed by upload-style commands mirroring the TSVM `audio.*` delegate;
worklet posts recycled state snapshots (~16 ms) for meters/positions. Engine
(`src/engine/`) is pure computation — importable by both the worklet and Node —
and keeps Kotlin function/field names verbatim so Kotlin↔JS syncs diff cleanly.
Engine renders 32 kHz stereo U8 (the 8-bit dithered character is intentional);
the worklet converts to float and linear-resamples if the context isn't 32 kHz.

## What need to be done

- Full Taud engine implementation (taud.js)
  - [x] M0 scaffold: repo layout, vendored fflate/fzstd, corpus, smoke tests
  - [x] M1 JVM PCM oracle: `tsvm/devtests/webconf/RenderDumpTest.java` — U8 PCM
        + pre-dither float32 tap dumps; interrupts the adapter render threads
        and drives generateTrackerAudio synchronously; double-run determinism
        check (4THSYM is NONDETERMINISTIC — vol/pan swing). Regenerate refs
        into `test/reference/` (gitignored) with the recipe in that file.
        NOTE: build tsvm_core from CURRENT sources first (out/production can
        be stale; kotlinc CLI works — see devtests/ixmp/README.md classpath).
  - [x] M2 format layer: compress sniff (gzip/zstd in, gzip out), taud-parse,
        taud-write; round-trip tests green on corpus; `tools/inspect-taud.js`
        cross-checked vs `taud_inspect.py`
  - [x] M3 engine port E1–E11 — **BIT-EXACT vs the JVM oracle** on all 6
        deterministic corpus songs (20 s each, f32 AND dithered U8): WHEN,
        slumberjack, changing_waves, Insaniq2, DOOM-E1M1, flourish.
        `node tools/render-taud.js` (~70-90× realtime), `tools/compare-pcm.js`,
        `test/node/conformance.test.js` (auto-skips without reference dumps).
        Still TODO from the M3 list: targeted unit tests for the known-subtle
        scenarios (zero-dur env nodes, seedPfRole, key-lift, fast-fade, NNA
        ghost biquad copy, meta KEY_OFF fade, S$Dx re-bind) — the corpus
        conformance covers most of these end-to-end already
  - [ ] M4 AudioWorklet + protocol + `player.html` (≈ playtaud)
- full Microtone web application
  - [ ] M5 document model + ops/undo/sync + app shell + Timeline view
        (read-only, follow mode, VU meters)
  - [ ] M6 editing core: cell editing, jam keyboard, Cues view + CueCmd popup,
        scalars, undo/redo, OPFS save/load, import/export, New Project wizard,
        unsaved guard; exported .taud must play on desktop TSVM
  - [ ] M7 Samples view (waveform + play blobs), Instruments view (envelope
        editors, meta layers, Ixmp visualiser + live overlay), Project view
        (pitch tables/retune, flags), Help/Goto/Retune/Flags popups
  - [ ] M8 polish: sample editor modal, .tsii/.tpif, 64-ch UX, autosave,
        perf hardening, WAV export, optional SAB fast path

Full plan with fidelity checkpoints and verification criteria:
`~/.claude/plans/jazzy-singing-bee.md` (approved 2026-07-08).

## Porting rules

- **Never reimplement tracker/DSP behaviour from memory** — translate from the
  current Kotlin source. All the subtle fixes (stale `inst` re-bind after
  mid-tick triggerNote, advancePfRole zero-duration skip, seedPfRole, SF2 RBJ
  biquad vs IT all-pole, active-envelope view, meta KEY_OFF race) already live
  there; a faithful translation inherits them.
- `Math.random` is never called directly in `src/engine/` — route through
  `rng.js` (injectable/seedable; production default is Math.random for swing).
- Mix bus is Float32: use `Float32Array` for mixL/R and `Math.fround` inside
  `pcm32fToPcm8`, matching Kotlin Float semantics. Everything upstream is
  Double = plain JS numbers.
- `src/engine/` must not import from `vendor/`, `src/ui/`, or anything
  DOM/Web-Audio-touching.
