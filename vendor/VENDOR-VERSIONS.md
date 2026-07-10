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
| `pyodide/pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` | 314.0.2 (CPython 3.14.2) | https://github.com/pyodide/pyodide/releases/download/314.0.2/pyodide-core-314.0.2.tar.bz2 |

To update: extract those five files from the release tarball, run the
conversion tests.

## converters/ — canonical Taud converters (verbatim copies from tsvm)

`taud_common.py` + `{mod,s3m,it,xm,mon,midi}2taud.py`, copied UNMODIFIED from
`/home/torvald/Documents/tsvm/` (the source of truth — they keep evolving
there). Pure stdlib; the optional `zstandard` import is absent under Pyodide
so output falls back to gzip (`best_compress`), which every Taud loader
sniffs fine. To sync: `cp` the files again and re-run the conversion tests —
no porting, no patching.
