# Vendored dependencies

Single-file, dependency-free ES modules. Never imported by `src/engine/` or the
worklet — compression is a load/save-time (main thread) concern only.

| File | Package | Version | Source URL | Role |
|---|---|---|---|---|
| `fflate.esm.js` | fflate | 0.8.2 | https://unpkg.com/fflate@0.8.2/esm/browser.js | gzip inflate (load) + deflate (save path; desktop TSVM auto-detects gzip vs zstd by magic) |
| `fzstd.esm.js` | fzstd | 0.1.1 | https://unpkg.com/fzstd@0.1.1/esm/index.mjs | zstd decompress (load path; TSVM's "gzip" namespace actually writes zstd frames) |

To update: re-download from the URL, bump this table, run `node --test test/node/`.

## pyodide/ — CPython-in-wasm runtime (import features only)

**Exception to the single-file-ESM rule** (approved for the import work): the
tracker/MIDI/SF2 import features run the canonical `*2taud.py` converters
VERBATIM in the browser instead of porting ~10k lines of heuristics to JS.
Pyodide is lazily loaded by `src/convert/` the first time an import runs —
never on the normal app path.

| File | Version | Source |
|---|---|---|
| `pyodide/pyodide.js`, `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` | 314.0.2 (CPython 3.14.2) | https://github.com/pyodide/pyodide/releases/download/314.0.2/pyodide-core-314.0.2.tar.bz2 |

To update: extract those five files from the release tarball, then RENAME the
two module files `pyodide.mjs → pyodide.js` and `pyodide.asm.mjs →
pyodide.asm.js` and fix the `pyodide.asm.mjs` reference inside `pyodide.js`
(sed `s/pyodide\.asm\.mjs/pyodide.asm.js/`). Reason: static hosts that don't
map the `.mjs` extension serve it with no/`text/x-asm` MIME type, and browsers
refuse to load an ES module without a JS MIME type — the `.js` extension is
universally recognised. Then run the conversion tests.

## converters/ — canonical Taud converters (verbatim copies from tsvm)

`taud_common.py` + `{mod,s3m,it,xm,mon,midi}2taud.py`, copied UNMODIFIED from
`/home/torvald/Documents/tsvm/` (the source of truth — they keep evolving
there). Pure stdlib; the optional `zstandard` import is absent under Pyodide
so output falls back to gzip (`best_compress`), which every Taud loader
sniffs fine. To sync: `cp` the files again and re-run the conversion tests —
no porting, no patching.

## Third-party DATA in `src/engine/` — the binaural HRIR set

**The other exception to "never imported by `src/engine/`"**, and the only one:
`src/engine/hrir-sadie.js` is a *data* module, not a library — no code of
anyone else's runs, and nothing in it touches the DOM or Web Audio, so the
engine's layering rules are intact.

| File | Source | Version | Licence |
|---|---|---|---|
| `src/engine/hrir-sadie.js` | [Google Omnitone](https://github.com/GoogleChrome/omnitone) `src/resources/sh_hrir_order_3.wav` (md5 `310d2836b94909a9b49a84c2ebbf3552`) | GoogleVR resource v1.0.0, 2017-08-22 | Apache-2.0 — Google Inc. and University of York |

The measurements are the [SADIE project's Google/VR binaural filter
set](https://www.york.ac.uk/sadie-project/GoogleVRSADIE.html): 16 ambisonic
channels (ACN/SN3D, order 3) × 256 taps at 48 kHz, each channel the LEFT ear's
response to that harmonic. Only the *binaural* half of Omnitone is used — its
Web Audio graph, its rotator and its FOA path are not, because the engine has
its own ambisonic scene already and must stay Web-Audio-free.

To update: replace the WAV in the Omnitone checkout and re-run
`node tools/make-hrir-table.js [path/to/sh_hrir_order_3.wav]`, then
`node tools/make-worklet-bundle.js` and `node --test 'test/node/*.test.js'`.
