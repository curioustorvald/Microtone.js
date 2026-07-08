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
  - [ ] M1 JVM PCM oracle (in tsvm repo: `devtests/webconf/RenderDumpTest.java`,
        modelled on `devtests/ixmp/IxmpFileTest.java`) — U8 PCM + pre-dither
        float32 tap dumps for the corpus
  - [ ] M2 format layer: compress sniff (gzip/zstd in, gzip out), 256-B inst +
        Ixmp codec, taud-parse, taud-write; round-trip tests on corpus;
        `tools/inspect-taud.js` vs `taud_inspect.py`
  - [ ] M3 engine port E1–E11 (constants/minifloat/rng → tables → inst →
        voice/state → sampler/filter → envelope → trigger → effects →
        row/tick → mixer → facade) + conformance vs M1 dumps
        (float tap ≤1e-6; U8 ≥99.9% exact ±1 LSB) + unit tests for:
        zero-dur env nodes, seedPfRole, key-lift, fast-fade, NNA ghost copies
        biquad state, meta KEY_OFF fade, S$Dx inst re-bind
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
