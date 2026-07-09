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
  - [x] M4 AudioWorklet + protocol + `player.html` (≈ playtaud):
        `src/worklet/{protocol,taud-processor}.js` (module worklet; committed
        single-file fallback `taud-processor.bundle.js` — REGENERATE with
        `node tools/make-worklet-bundle.js` after ANY engine change; the tool
        requires plain `export`/`import{...}from"./x.js"` forms and unique
        top-level names across engine files — that's why `clamp` lives in
        tables.js), `src/audio/audio-system.js` (audio.*-shaped command +
        snapshot-backed sync readbacks). Headless-Chromium-verified via
        `test/browser/worklet-smoke.html` (+`?bundle=1` / `?rate=48000`
        variants): playback advances correctly on all three paths.
        Manual listening test in a real browser still pending.
- full Microtone web application
  - [x] M5 document model + ops/undo/sync + app shell + Timeline view:
        `src/doc/` (Document reuses the engine TaudPlayData cell codec;
        invertible ops with dirty tags; gesture-coalescing UndoStack; DocSync
        = cues/scalars eager, patterns lazy-flushed before play — taut.js
        strategy), `index.html` + `src/ui/{app,store,notenames}.js` +
        `views/timeline.js` (canvas, row-virtualised, follow mode, VU/pan
        header meters, cue:row gutter). `?load=<url>` bootstraps a file
        (demo links + headless smoke); `&autoplay=1` for testing.
        GOTCHA fixed: ensureAudio is single-flight and OWNS DocSync creation —
        concurrent init used to double-create AudioSystems and leave sync null.
  - [x] M6 editing core: `src/ui/edit.js` (PURE key interpreter — Node-tested;
        sub-column/nibble cursor model, taut SC_JAM piano map via e.code,
        current-inst auto-adopt), jam keyboard (`jam.js`), Timeline cell
        editing + record mode (Insert toggles; amber caret), Cues view with
        3-nibble pattern entry + CueCmd popup (BAK/FWD/JMP/LEN/HALT/HALT@
        sign-bit repack), Ctrl+Z/Y undo/redo, OPFS storage
        (`src/storage/opfs.js`, worker fallback for Safari sync-access) +
        Files view + import/export + Ctrl+S + unsaved guards.
        VERIFIED: browser edit smoke (test/browser/edit-smoke.html) PASS incl.
        OPFS round-trip; web-edited WHEN.taud renders on the REAL JVM engine
        and the JS engine matches it bit-exact.
        Deferred to M7: Pattern-details view, New Project wizard (pointless
        until sample import exists).
  - [x] M7 Samples view (deduped census from base insts + Ixmp patches, SNam
        names by pool order, waveform + loop shading + live play blobs),
        Instruments view (INam names, General tab with editable scalars via
        setInstFieldOp, 4 envelope-graph tabs with vertical node dragging via
        setEnvPointOp, Ixmp Zones map + live trigger overlay, Meta layer
        table), Project view (tempo/volumes/flags editable), Help (?) and
        Goto (Ctrl+G) popups. Document decodes instruments lazily into engine
        TaudInst objects (shared parsePatchesBlob codec in engine/inst.js);
        inst edits sync EAGERLY (uploadInstrument) and toBytes() rebuilds the
        image's inst region. CSS gotcha fixed: `[hidden]{display:none!important}`
        (class display rules defeated the hidden attribute).
        Deferred to M8: envelope OFFSET editing (values only for now), sample
        editor modal, retune/pitch tables, New Project wizard, PNam/sMet editing.
  - [~] M8 polish (2026-07-09 batch DONE):
        [x] envelope OFFSET dragging (2D node drag, minifloat-quantised,
            one-op gestures via setEnvDragOp)
        [x] WAV export (offline render on main thread via
            src/audio/offline-render.js — shared with tools/render-taud.js;
            16-bit stereo from the pre-dither f32 bus; Files view button)
        [x] autosave (debounced 45 s → OPFS autosave/ dir) + recovery prompt
            on boot; clean save removes the autosave
        [x] targeted engine regression tests (engine-scenarios.test.js):
            S$Dx fresh-channel re-bind, advancePfRole zero-skip + seed,
            vol-env terminator freeze, ghostVoice biquad/env-view copy,
            dither determinism. TEST-DATA GOTCHA: a synthetic inst record
            with zeroed env bytes is a value-0 terminator → Schism cut rule
            ramps the voice out instantly; set byte 21 = 0x3F.
        [x] pitch tables (src/ui/pitchtables.js — data port of taut.js
            pitchTablePresets; sMet notation IS the preset index) + Retune
            popup (nearest-pitch method, percussion skip, single undo op);
            Timeline shows degree·octave labels for off-12-EDO notes;
            sMet regenerates on save ONLY when edited (smetEdited flag —
            keeps unedited round-trips byte-exact)
        [x] .tsii loading (replace bank in a loaded project / seed a new one)
        [x] New Project wizard (32/64ch, BPM/speed, optional .tsii seed;
            empty cells use 0xC0 vol/pan no-ops — converter convention)
        [x] perf evidence: worst 5.3 ms/chunk (Onestop GM) vs 16 ms budget
        [x] vector glyph engine (`src/ui/glyphs.js`) — the web equivalent of
            tautfont: 4-char note cells [tick][letter][accidental][octave];
            sentinels per spec (key-off box, connected ^^^, high-amplitude
            ~~~, mirrored fast-fade); vector accidentals (slant-crossbar ♯,
            ♭, demisharp = single-stroke ♯, demiflat = mirrored ♭, 𝄪, ♭♭,
            ♯𝄪 triple, ♭♭♭, 𝄪𝄪 quad), Kite big-dot/up/down/double ticks;
            Shi'er lü (黃大太夾姑仲蕤林夷南無應) via a conventional CJK font.
            Per-preset sym tables transcribed from taut.js into a 3-char token
            DSL in pitchtables.js (tick/letter/accidental); raw + off-grid
            notes render hex4. Visual reference:
            test/browser/glyph-gallery.html.
        [x] Patterns tab (F3, `src/ui/views/pattern.js`): single-pattern
            editor sharing the cell layout helpers (now in edit.js) + glyph
            painter with the Timeline; used-by-cues info; Preview via the
            device-only scratch cue 8191 with a HALT word (taut
            PREVIEW_CUE_IDX idiom). Timeline note column widened 3→4 chars.
        [x] font corrections (user review): accidentals span TWO cells
            (Kite + Shi'er lü excepted), fast-fade = cut mirrored, IntH
            interrupt labels, glyph geometry in the exported GLYPH tunables
            (edit + reload test/browser/glyph-gallery.html), off-grid notes
            snap to nearest degree and paint YELLOW, raw-hex is an explicit
            toggle, pattern/cue numbers 4-digit hex
        [x] GUI: toolbox row (Retune…/Raw toggle on Timeline+Patterns),
            sMet beatPri/beatSec drive row banding + gutter highlights,
            wheelable topbar (Oct/Inst step used slots/Spd live tick rate),
            contextual command palette at screen bottom (sentinel inserts on
            note col, vol/pan selector buttons, effect-opcode chooser with
            tooltips, per-opcode argument docs on the arg column — FX_INFO
            in src/ui/palette.js)
        Remaining: sample editor modal, .tpif companion loading,
        delta/cadence/harmonic retune methods, SAB fast path,
        manual Firefox/Safari pass.

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
