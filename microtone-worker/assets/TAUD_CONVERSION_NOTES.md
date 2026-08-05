# Taud Conversion Notes

This document describes how music in other formats becomes Taud: what maps cleanly, what has to be approximated, and where the traps are. It covers ProTracker (`.mod`), ScreamTracker 3 (`.s3m`), FastTracker 2 (`.xm`), ImpulseTracker (`.it`), Monotone (`.mon`) and Standard MIDI plus SoundFont 2 (`.mid` + `.sf2`).

It is written for two audiences at once. If you are **using** a converter, the per-format sections tell you what to expect from your file and which options change it. If you are **writing** one, they tell you which decisions are forced by the target format and which are judgement calls that the reference converters have already made one way.

The reference converters are `mod2taud.py`, `s3m2taud.py`, `xm2taud.py`, `it2taud.py`, `mon2taud.py` and `midi2taud.py`, sharing `taud_common.py`. Microtone runs those exact files in the browser, so what this document says about them is also what the app does.

Companion documents: the **Taud File Format Specification** defines the structures every converter writes; the **Taud Engine Specification** defines how they sound; the **Note Effects** reference carries the per-command conversion tables for ProTracker, ScreamTracker 3, FastTracker 2 and ImpulseTracker sources.

The key words **MUST**, **SHOULD**, **MAY** and their negations are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold.

## 1. What every conversion faces

### 1.1 The target's hard limits

| Resource | Limit | What happens when you exceed it |
|---|---|---|
| Sample pool | 8 MiB total | Every sample is resampled down globally ([§1.2](#1-2-samples)) |
| One sample | 65 535 bytes | That sample alone is resampled further |
| Directly addressable instruments | 255 (`$01`…`$FF`) | Conversion fails, or instruments are dropped |
| Auxiliary instruments | 768 (`$100`…`$3FF`) | Reachable only as Metainstrument layers |
| Channels | 32, or 64 with `xHDR` | Excess channels are dropped |
| Pattern rows | 64 | Longer patterns are split ([§1.4](#1-4-patterns-are-single-channel)) |
| Patterns | 32 767 | Practically bounded by `patterns × channels` |
| Cues | 8192, or 4096 in 64-channel mode | — |
| Ixmp patches per instrument | Unbounded, but rectangles **MUST NOT** overlap | — |

The pattern budget is the one that bites first on wide modules, because a Taud pattern holds one channel: a 20-channel module with 64 source patterns needs 1280 Taud patterns before deduplication. The reference converters treat `patterns × channels > 4095` as a hard error for the ≤ 20-channel formats.

### 1.2 Samples

Taud samples are **unsigned 8-bit**, so every source needs depth conversion:

- 16-bit signed → take the high byte and add 128.
- 8-bit signed → XOR with `0x80`.
- 8-bit unsigned → pass through.

Stereo sources are stored **split**, not interleaved: the whole left channel followed by the whole right, which matches the on-disk layout IT, S3M and XM already use. A converter that keeps stereo emits two pool spans joined by an Ixmp `s` patch; one that does not downmixes to mono.

**Pool overflow** is handled in two passes, and the order matters:

1. If the sum of all samples exceeds 8 MiB, **every** sample is resampled down by the same ratio, and each instrument's sampling-rate field is adjusted by the same ratio so pitch is preserved. This costs bandwidth song-wide, which is why options that shrink the pool are worth taking before the overflow does it for you.
2. Any individual sample still over the 65 535-byte cap is then resampled further on its own.

Both passes invalidate sample-offset effect arguments (`O`), so those **MUST** be rescaled by the same ratio — per instrument slot when the second pass resampled only some samples. A converter that resamples but forgets the offsets will start long samples in the wrong place, which usually sounds like a drum loop losing its downbeat.

### 1.3 Pitch

Every source pitch becomes a 4096-TET note word anchored at C4 = `0x5000`:

| Source | Conversion |
|---|---|
| ProTracker period | `round(0x5000 + 4096 × log2(428 ÷ period))` |
| Semitone index *n* relative to C4 | `round(0x5000 + n × 4096 ÷ 12)` |
| Frequency *f* Hz | `round(0x5000 + 4096 × log2(f ÷ 261.6255653))` |

Per-sample tuning offsets — XM's `relative note` and `finetune`, IT's C5 speed, SoundFont's `originalPitch` and `pitchCorrection` — are baked into the instrument's **sampling rate at C4** field, or into its signed **sample detune** field, rather than being pushed into every note. That keeps the pattern readable and lets a retune operate on musical pitches.

One semitone is ≈ 341.33 units and one cent is ≈ 3.41 units, so slide arguments generally need scaling; each format's section gives its factor.

### 1.4 Patterns are single-channel

This is the structural difference that shapes every converter. A source pattern of *R* rows × *C* channels becomes *C* Taud patterns of *R* rows, and the cue that plays them names all *C* at once.

Consequences:

- **Row counts other than 64** need the cue's LEN instruction (`rows − 1` in the low six bits). A pattern longer than 64 rows is split into ⌊rows ÷ 64⌋ full cues plus a remainder cue carrying LEN.
- **Splitting renumbers the order list**, so every `B` (position jump) and `C` (pattern break) target **MUST** be remapped to the new cue indices.
- **A pattern loop (`S $Bx`) that straddles a split boundary cannot work**, because the loop is per-cue. Converters warn rather than silently mangling it.
- **Deduplication pays for itself.** Identical 512-byte patterns collapse to one copy with a remap table; on a typical module most single-channel patterns are empty and fold into one.

### 1.5 The cue sheet

A converted song's cue sheet needs three things right:

- **HALT goes on the last active cue**, not in an empty cue appended after it. Appending leaves a silent 64-row gap before playback stops.
- **A partial final bar uses HALT AT** *x* rather than plain HALT, so the song ends at its own length.
- **Trailing empty cues are trimmed** — a cue is empty only when every channel word is the no-pattern sentinel *and* both instruction words are NOP.

Looping is a cue **JMP** back to the loop-start cue, replacing that cue's HALT. When the loop start is mid-cue, an in-pattern `B` (plus `C` for the row) does the job instead.

### 1.6 Effect memory

Most trackers back their effects with per-effect or shared memory: re-issuing a command with a `$00` argument recalls the last non-zero one. Taud has memory too, but **its cohorts are narrower than ST3's or IT's**, so a naive pass-through changes which value gets recalled.

The reference converters therefore **resolve recalls eagerly**: they walk the patterns in order-list order, per channel, tracking the source's own memory model, and substitute the concrete value before encoding. The known limitation is honest and worth stating: a pattern reached from several order entries is rewritten on its first visit, so a later visit may diverge from the original if the memory state differed. In practice this is inaudible on real modules, but it is a real difference and a converter **SHOULD** document it rather than pretend otherwise.

### 1.7 Volume and pan columns

Taud's volume and pan columns each carry a 6-bit value plus a selector, and the FINE selector with value 0 is the canonical **no-op** (byte `0xC0`). Two conventions follow:

- On a row that triggers a note but carries no explicit source volume, emit a **SET** with the instrument's default volume. Otherwise the channel's prior volume persists into the fresh note, which is almost never what the source meant.
- On every other row, emit the FINE-0 no-op so the column does not disturb running state.

A source volume of 64 maps to **63**, not to a rescaled value. ST3, XM and IT all display a 0…64 volume and all clamp it to six bits in the player, so 64 and 63 sound the same at the source; scaling the whole range by 63/64 to make 64 "fit" would quietly pull every other volume in the song down. Clamp, do not scale.

Effects that only set channel volume or panning (`M`, `N`, `X`, `P` in ST3 terms) **SHOULD** be folded into these columns, which frees the effect slot for something that genuinely needs it. Each cell has exactly one effect slot, and on dense material that slot is the scarcest resource in the whole conversion.

### 1.8 Subsongs

Modules do not carry a subsong table; subsongs emerge from the order list's flow graph. The shared detector takes the lowest unvisited non-terminator order as the next subsong's entry point, walks forward reachability through fall-through and `Bxx` targets, marks everything reached as visited, and repeats.

The subtlety is fall-through: it is treated as **dead** when the pattern at that order carries a `Bxx` on its absolute last row, which is every tracker's idiom for "the song ends here, loop back". Without that rule, subsongs separated only by `Bxx` terminators — with no explicit `0xFF` marker — merge into one. In practice this finds 4 subsongs in `WHEN.s3m` (which does use `0xFF` separators) and 8 in `Insaniq2.it` (which does not).

Each detected subsong becomes one entry in the Taud song table.

### 1.9 Project Data

Everything that is naming or presentation rides in Project Data: instrument names (`INam`), sample names (`SNam`), pattern names (`pNam`), the project name and message (`PNam`, `Pmsg`), and per-song metadata including the display notation and beat divisions (`sMet`).

**`Ixmp` also lives there**, and it is not cosmetic. Omitting Project Data — every converter has a `--no-project-data` flag — collapses each instrument to its single canonical sample, silently discarding keyboard maps, velocity layers, per-sample envelopes and stereo pairs. Use the flag for size experiments, not for output you intend to listen to.

### 1.10 Compression

Each compressed payload picks its own codec: the converters compress with gzip and zstd and keep whichever came out smaller, and every Taud reader sniffs the magic. Under Pyodide the `zstandard` package is absent, so the browser falls back to gzip — which every reader accepts, at a modest size cost.

## 2. ProTracker — `.mod`

ProTracker is the simplest source and the one whose *emulation* details matter most, because so much of its sound is the Amiga hardware rather than the notes.

### 2.1 Global setup

The converter sets two global behaviour flags: **Amiga period tone mode** and **Amiga 500 interpolation**. Together those give period-space pitch slides, zero-order-hold sampling and the post-mix 4.4 kHz low-pass — the reason a converted MOD sounds like a MOD rather than like a clean 32 kHz sampler.

`E00` / `E01` (filter on/off) map to `S $00` / `S $01`, which the engine honours only in the Amiga interpolation modes.

### 2.2 Pitch and slides

Periods convert against ProTracker's period 428 for C4. Because the song runs in Amiga period mode, coarse `1xx` and `2xx` slide arguments pass through **unscaled** — the engine consumes them in period space directly. Fine slides (`E1x`, `E2x`) do the same.

Tone portamento (`3xx`) is the exception: Taud treats `G` as linear even in Amiga mode, so its argument is scaled to 4096-TET units by `round(arg × 64 ÷ 3)`.

Arpeggio nibbles are semitone offsets and go through the shared table: one Taud argument byte is 256 units ≈ 0.75 semitones, so `byte = round(semitones × 4 ÷ 3)`.

### 2.3 Effects

Full ProTracker dispatch per the Note Effects conversion table, with these folds:

| Source | Becomes |
|---|---|
| `Cxx` (set volume) | Volume column SET |
| `Axy` (volume slide) | Effect-column `D` — **not** the volume column |
| `EAx` / `EBx` (fine volume slide) | Volume column |
| `8xx`, `E8x` (panning) | Pan column |
| `5xy` (porta + volume slide) | `L` verbatim |
| `6xy` (vibrato + volume slide) | `K` verbatim |
| `Dxx` (pattern break) | `C`, BCD-decoded |
| `E0x` (LED filter) | `S $0x` |

`Axy` routes through the effect column rather than the volume column for a specific reason: when a row carries both `Cxx` and `Axy`, the volume column can encode only one of them, and the slide is the half that gets lost — five ticks of slide per row, which is audible. Keeping the slide in the effect slot preserves both.

`5xy` and `6xy` map to `L` and `K` verbatim rather than being split into a portamento plus a volume-column slide, for the same reason: the split loses the slide on any row that also needs a volume SET.

Sample finetune is pre-baked into each instrument's sampling rate, so notes stay clean.

## 3. ScreamTracker 3 — `.s3m`

### 3.1 Instrument indexing

S3M instrument numbers are 1-based on disk and in cells, and Taud's cell instrument byte preserves that: 0 means "no instrument change", 1…255 select a slot. The converter passes the raw byte through with no subtract-1, writes the instrument bin at `index × 64`, and leaves slot 0 empty.

AdLib/OPL instruments are skipped — there is no FM synthesis in Taud.

### 3.2 Shared-memory recall

ST3 backs effects `D`, `E`, `F`, `I`, `J`, `K`, `L`, `Q`, `R` and `S` with a **single per-channel memory slot**, so a `$00` argument on any of them recalls whatever any of them last set. Taud's cohorts are narrower, so the converter resolves every such recall eagerly ([§1.6](#1-6-effect-memory)).

### 3.3 Numeric quirks

- **`Cxx` is BCD on disk.** `$10` means decimal row 10, not hex row 16. Decode as `(byte >> 4) × 10 + (byte & 0xF)`; anything decoding to 64 or above clamps to row 0. (IT's `Cxx` is plain binary — the two formats differ here and mixing them up shifts every pattern break.)
- **The coarse pitch-slide unit is 1/16 semitone**, ≈ 21.33 Taud units, so `E`, `F` and `G` coarse arguments are multiplied by `$0015`. Fine forms are packed into Taud's `$F0xx` fine form after the same per-step scale.
- **Global volume is 0…$40**, scaled to Taud's 0…$FF by ×4 with a clamp.
- **Tempo** is a raw decimal BPM; Taud's byte is biased −25. The converter also scans row 0 of the order list's first pattern for `A` and `T` and prefers those over the header defaults, because that is where trackers actually put the intended tempo.

### 3.4 Default panning

Row 0 of every pattern emits a pan-column SET derived from the S3M channel-setting byte — channels 0…7 left (`$10`), 8…15 right (`$2F`), otherwise centre (`$1F`). Every other row emits the FINE-0 no-op unless an `X`, `P` or `S $8x` overrides it.

## 4. FastTracker 2 — `.xm`

### 4.1 Multi-sample instruments

XM instruments carry a 96-key sample map. `xm2taud` materialises **one Taud instrument slot per (XM instrument, sample) pair** and picks the slot from the triggering note's keymap entry.

That is a different choice from `it2taud`, which uses Ixmp patches to keep one Taud instrument per source instrument. XM could be retrofitted the same way to conserve slots; it has not been, because no real XM file has yet hit the 255-slot cap. If you are converting a bank-heavy XM that does, this is the knob to turn.

### 4.2 Pattern length

- ≤ 64 rows → one cue, with the LEN instruction when the count is under 64 and no instruction when it is exactly 64.
- > 64 rows → ⌊rows ÷ 64⌋ full cues plus, when there is a remainder, a final cue carrying LEN for the leftover rows.

### 4.3 Tuning

XM combines a per-sample `relative note` (signed semitones) with a `finetune` in 1/128-semitone units. Both are baked into the instrument's sampling rate:

```
semitones = relative_note + finetune ÷ 128
c2spd     = max(1, round(8363 × 2 ^ (semitones ÷ 12)))
```

so an XM "C-4" row sounds correct when the Taud note is also C4.

### 4.4 Envelopes and fadeout

XM volume (0…64) and panning (0…64, with 32 as centre) envelopes convert to Taud's 0…63 and 0…255 ranges. XM's single-point sustain becomes a SUSTAIN word with equal start and end; XM's envelope loop becomes the LOOP word. The two are independent in XM and stay independent in Taud.

**Fadeout needs rescaling and this is a common mistake.** FT2's per-tick decrement is `stored ÷ 32768` of unit volume; Taud's is `stored ÷ 1024`. Divide by 32, rounding to nearest:

```
taud_fadeout = min((xm_fadeout + 16) ÷ 32, 0x0FFF)
```

XM values 1…15 round to Taud 0 — those originals ran over eleven minutes at 50 Hz and were effectively "no fade" anyway. XM 32 becomes Taud 1 (≈ 20 s). MilkyTracker writes 32767 to encode its "cut" slider, which becomes Taud 1024, a one-tick cut.

Auto-vibrato maps with XM's own scaling: rate becomes Taud's "speed", depth doubles into the 0…255 range, sweep and waveform pass through.

### 4.5 NNA

XM has no New Note Action — every new note unconditionally retriggers the channel. Converted instruments therefore get NNA = Note Cut, which reproduces that. Do not "improve" this to Note Fade: it changes the arrangement of any XM that relies on retrigger cutting a ringing note.

### 4.6 Effects

Full XM dispatch per the Note Effects conversion table. Volume-column commands fold into the Taud volume column when they can, or occupy the main effect slot when it is free, and are dropped otherwise — the same policy `it2taud` uses. `E5x` (set finetune) becomes `S $5x`. Position jump and pattern break are remapped to Taud cue indices after any pattern splitting.

`Kxx` (delayed key-off) carries no note-column entry of its own in XM — it acts on whatever is already sounding — so it cannot become `S $Dx00` on a `NOTE_KEYOFF` sentinel the way a note-column key-off can; that path fires the key-off at `$x` and leaves nothing else to defer. Instead it becomes `S $D00xx` (`x`=0, `n`=0 note off, `y`=`xx` clamped to the 4-bit range, i.e. `min(xx, 0xF)`, never a truncating mask — `K10` must land on `y=$F`, not silently become a no-op at `y=0`) and the row's own note column is left empty, letting the engine's follow-up-action mechanism apply the note-off to the sounding voice at the right tick. `K00` (arg 0) has no follow-up window to defer into — `S $D`'s action never arms when `$y` is zero — so it still forces an immediate `NOTE_KEYOFF` instead. One gap survives the fix: the FT2-only quirk where a key-off on a vol-env-off instrument hard-mutes the volume (see the `keyoff_zero_rows` gating below) cannot be replayed on the deferred tick without re-losing the delay, so it is skipped for a delayed `Kxx` — only the real note-off fires.

## 5. ImpulseTracker — `.it`

IT is the richest source and maps onto Taud most directly, because most of Taud's instrument model exists to carry IT semantics.

### 5.1 Channels

The converter takes the non-muted, in-use channels: 32 or fewer stay in the default layout, 33…64 switch the file to **64-channel mode** (the `xHDR` flag), and only a song exceeding 64 active channels is capped. A channel is "muted" when its pan byte has bit 7 set or reads `0xC0`, and "in use" when any cell on it is non-empty.

### 5.2 Instruments and Ixmp

Each IT instrument becomes **one** Taud instrument, whose base record carries the C5 canonical sample, plus an Ixmp patch list covering every keyboard cell that maps to a different sample. Patch rectangles are contiguous runs of keyboard cells pointing at the same sample, which guarantees the no-overlap rule because the keyboard map is itself a partition.

Per-patch fields mirror what the base record would have stored for that sample — loop points and mode, default volume and pan, auto-vibrato — so a patched note behaves exactly as a base-record note on the same sample would.

Volume, panning and pitch-or-filter envelopes convert natively, with up to 25 nodes, both sustain and loop regions, and the `P` presence bit set whenever nodes are emitted. Auto-vibrato, fadeout, pitch-pan centre and separation, default pan, volume and pan swing, and initial filter cutoff and resonance all forward to their instrument fields. AdLib instruments are skipped.

IT2.14/IT2.15 **compressed samples** are decoded during conversion. The compression flag is per sample (bit 2 of the sample's `cvt` byte), *not* global via the file's `cwt` — reading it globally mis-decodes mixed files.

**Stereo samples are kept by default**: the two channels become two pool spans joined by an Ixmp `s` patch. Because a base record cannot express a stereo sample, a stereo canonical sample is treated as non-canonical and gets patches over its own keyboard runs. Downmixing to mono is available as an option.

### 5.3 Pattern splitting

IT patterns may exceed 64 rows, and are split into ⌈rows ÷ 64⌉ consecutive Taud patterns. `B` and `C` targets are remapped onto the new cue indices; an `S $Bx` pattern loop crossing a chunk boundary is warned about, since a Taud loop cannot span cues.

### 5.4 Note delays past the row

IT triggers a note delay *during* the current row, so a delay of `x` ticks with `x ≥ speed` never lands — the note is silently lost. The converter relocates such a note to the next row with `delay = x − speed`, but only when that next row on the same channel is empty. This recovers notes that IT itself would have dropped, which is a deliberate deviation in favour of the music.

### 5.5 Effects

A–Z dispatch per the Note Effects reference, with the IT-specific readings:

| Command | Reading |
|---|---|
| `Cxx` | **Binary**, not BCD as in ST3 |
| `V` | IT 0…128, scaled ×2 to Taud 0…255 |
| `X` | Full 8-bit IT panning |
| `Y` | Panbrello, nibble-repeated to 8 bits |
| `Z` | MIDI macro — **dropped** |
| `S6x` | Fine pattern delay, forwarded directly |
| `SAx` | High sample offset — **dropped** |
| `S7x` | NNA, past-note and envelope toggles; the IT sub-codes match Taud one-to-one |

Memory cohorts are resolved eagerly: `D`, `K` and `L` share one; `E` and `F` optionally link with `G` per the header's flag bit 5. Volume-column pitch-slide, tone-portamento and vibrato sub-commands move to the main effect slot when it is free and are dropped otherwise.

Global and mixing volume are IT's 0…128, scaled by 255/128 and rounded.

## 6. Monotone — `.mon`

Monotone is Calvin "Trixter" French's tracker for the PC speaker, Tandy and TI-99 SN76489. It has no user-defined instruments — the only instrument is the beeper — 1…12 voices, 64 rows per pattern, ProTracker-flavoured 2-byte cells, and eight effects: `0`, `1`, `2`, `3`, `4`, `B`, `D`, `F`.

### 6.1 The instrument

The converter synthesises a single instrument: a 32-byte, 50 %-duty square wave at offset 0 of the pool, looping forward, with a sampling rate of 8372 Hz so C4 sounds at 261.6 Hz. Its instrument global volume is set to `0xA0` for headroom (a square wave is loud), its default note volume to full, its filter off, and its NNA to Note Cut. Every Monotone voice plays this one instrument.

### 6.2 Pitch and slides

Monotone note value 1 is A0, so C4 sits at value 40 and `note = 0x5000 + round((value − 40) × 4096 ÷ 12)`. Value `0x7F` is a note cut.

The interesting decision is the slides. Monotone's `1xx`, `2xx` and `3xx` are **Hz per tick** — its player literally adds the argument to a frequency. Rather than rescale them into 4096-TET units and accumulate drift, the converter emits them verbatim and turns on Taud's **linear-frequency tone mode**, so the engine performs exactly the same arithmetic the original player did. Interpolation is set to none, matching a square-wave source.

### 6.3 Effects

| Monotone | Taud |
|---|---|
| `0xy` arpeggio (two 3-bit nibbles) | `J`, through the semitone table |
| `1xx` / `2xx` slide up/down | `F` / `E` in Hz per tick |
| `3xx` tone portamento | `G` in Hz per tick |
| `4xy` vibrato (3-bit speed and depth) | `H`, each nibble scaled ×36 into a byte |
| `Bxx` position jump | `B` |
| `Dxx` pattern break | `C` |
| `Fxx` set speed | `A` (an argument of 0 is invalid in Monotone and becomes a no-op) |

## 7. MIDI and SoundFont 2 — `.mid` + `.sf2`

This is the least mechanical conversion: MIDI has no patterns, no rows and no channels-as-voices, and a SoundFont is a sampler bank rather than a tracker instrument list. Almost everything here is a judgement call.

### 7.1 The rhythmic grid

MIDI time is continuous; Taud time is rows and ticks. The converter chooses **rows per beat** and **ticks per row** together, from the tempo map, the time signatures and an analysis of which onset subdivisions the song actually uses. The chosen `rpb × speed` fine-ticks per beat must represent the finest subdivision in use, keep every tempo inside the 25…535 BPM register, and stay near the proven 24-fine-ticks-per-beat grid — so plain 4/4 at 120 BPM still comes out as the familiar speed 6, 4 rows per beat.

Pinning either axis on the command line auto-fits the other; pinning both overrides the analysis entirely.

As a final step, a bend- or polyphony-heavy song with fewer than 8 rows per beat has its `rpb` doubled and its `speed` halved (leaving tempo and `F` unchanged), up to 8. The extra rows give key-offs, choke events, portamento and channel-volume effects distinct rows to land on, so fewer are lost to same-row collisions — each cell has only one effect slot.

Sub-row timing is then carried by `S $Dx` note delays.

Tempo changes become `T $xx00`, or the extended `T $FFxx` form above 280 BPM. Channel volume and expression (CC7 × CC11) become `M $xx00` channel-volume effects, deliberately **not** volume-column writes: the volume column is the velocity axis that selects Ixmp patches, and driving it from CC7 would change which sample plays.

Cues break at every time-signature change, and each section is packed into whole-bar cues — the largest multiple of its bar length that fits in 64 rows — so a tracker's beat highlighting lines up with the music.

### 7.2 Pitch bend

Bends **MUST** be preserved as far as the format allows, and Taud's 4096-TET grid allows a lot.

- A note starting under a non-zero bend triggers **directly at the bent pitch**; MIDI can start a note already bent, and a tracker cannot, so the trigger encodes the shifted pitch exactly.
- Movement during a note becomes linear segments: one row each, carrying the exact target note plus a tone portamento (`G`) sized to arrive by the row's end.
- Jittery curves are simplified against a cents threshold (default 4 cents).
- RPN 0,0 **pitch-bend-range** messages are honoured — a converter that assumes ±2 semitones will render wide-bend songs wrong by a factor.
- Bend values are computed as floats from the full 14-bit word, so MIDIs that only drive the MSB work transparently.

### 7.3 Note-off idioms

MIDI has two: a real note-off message, and a note-on with velocity 0. **Both** become Taud key-off.

Percussion-channel key-offs are **dropped by default**, because GM percussion ignores note-off and emitting them chops one-shot drum tails. An option re-enables them for kits that genuinely sustain.

### 7.4 SoundFont presets to Taud instruments

Each preset's zones are partitioned into the fewest mutually **disjoint** layers (default cap 4, and about 93 % of big-bank presets fit in 4, 98 % in 5). Each layer becomes one ordinary Taud instrument with its zones as Ixmp patches, on a velocity axis of `round(velocity × 63 ÷ 127)`.

A preset needing more than one layer becomes a **Metainstrument**: the note references the meta slot and the engine fans out one voice per matching layer. This is what makes SoundFont's simultaneous layering and detune stacks actually sound; before Metainstruments existed, overlapping zones had to be dropped. Single-layer presets stay plain instruments. Layer sub-instruments are allocated in the **auxiliary bin**, so they do not consume the 255 directly-addressable slots.

By default the full zone map is kept as Ixmp patches, so imported instruments stay playable across the whole keyboard rather than only where this song happened to play them. Trimming to triggered patches is available for the smallest file — and is worth using when the untrimmed pool overflows 8 MiB, since that overflow resamples *every* sample and costs quality song-wide.

Stereo SF2 samples are mixed to mono by default; an option keeps them as genuine stereo pairs at double the pool cost.

**Far-loop samples** get special treatment. A looped sample whose loop point sits past the 65 535-frame cap even at 32 kHz — multi-second sustain instruments in large banks — would otherwise force the whole sample to be resampled down until it fits, muffling it. By default such a sample instead gets a *synthesised* loop at 32 kHz plus a 10-second decay: the genuine sustain loop is traded for full bandwidth. An option restores the real loop and accepts the muffling.

### 7.5 The ADSR mapping

This is the part most likely to be got wrong, because SoundFont's release is not a tracker envelope stage.

The SF2 volume envelope's **delay, attack, hold and decay** become Taud volume-envelope nodes, with a sustain region held while the key is on. There is **no release leg in the envelope**. Instead, the SF2 *release segment* becomes the **Volume Fadeout**, with NNA = Note Fade: on key-off the voice holds at its sustain node and fades to silence over the release time.

Because Taud's fadeout is linear in amplitude while FluidSynth's release is linear in decibels, the release time is scaled to FluidSynth's *perceived* release length rather than copied. Per-layer Ixmp patches carry their own fadeout when their release differs from the canonical zone's.

Fadeout steps encode seconds **per song tick**, and the tick rate is proportional to BPM. A bank built for one tempo therefore has slightly wrong release times at another — which is why batch mode targets the mean of its songs' initial tempos, and why a tempo-independent override exists.

SF2 `initialAttenuation` is a per-zone static gain with no dedicated legacy field, so converters fold it into the per-patch **volume envelope's node peaks**, scaling every 0…63 node by `10^(−attenuation_cB ÷ 200)`. It multiplies with the velocity-driven note volume — it cannot live in the patch's default note volume, which an explicit volume column overrides at trigger time — so velocity layers differ in level as well as in ADSR shape. Newer files may use the dedicated initial-attenuation octet instead.

Melodic instruments get the **key lift** flag, so key-off behaves like a MIDI key release: the volume envelope jumps straight to its sustain end and the release plays at once, instead of ringing on through the remaining pre-sustain nodes like a depressed sustain pedal.

### 7.6 Polyphony

Polyphony rides on New Note Actions, which is what makes MIDI-shaped music fit a tracker at all. Every instrument, drum kits included, gets **NNA = Note Fade**: a voice column becomes reusable the moment its note releases, and the release tail moves to a background ghost that dies over its own release time.

The voice-column budget defaults to 32. A song exceeding it releases the oldest pedal-held or soonest-ending note **early** rather than cutting it. Raising the budget above 32 opts into 64-channel Taud mode, but only takes effect if the song actually allocates 33 or more voices.

SF2 **exclusiveClass** (generator 57) is honoured on the percussion channel: a new note in a class chokes any ringing note of the same class, matching FluidSynth's kill-by-exclusive-class. The choke is emitted as the fast note-fade sentinel (`0x0004`, ≈ 0.3 s) at the next same-class onset. Without it, long percussion tails wash over the whole beat — an open hi-hat ringing through the closed one that should have stopped it.

### 7.7 Looping

A MIDI that carries its own loop markers is **always** made to loop at those points, regardless of any command-line loop flag. Recognised conventions, case-insensitive, first occurrence winning, in priority order:

1. Text or copyright meta-events beginning with `loops` (start) and `loope` (end).
2. CC 116 (start) and CC 117 (end).
3. CC 110 (start) and CC 111 (end).
4. CC 111 alone as a loop **start**, with the loop end at End-of-Track.

A missing loop end defaults to End-of-Track. The loop is realised as a cue **JMP** when it spans complete full-length cues from a cue boundary; otherwise as an in-pattern `B` (plus `C` for the row when the loop start is mid-cue) on the last looped row. Cues after the loop end are dropped.

Whole-song looping rounds its loop end **up to the next bar line** by default, so the seam stays on the beat and usually lands on a full cue — that is, a clean JMP. Bar rounding never applies to explicit MIDI loop markers, which loop verbatim.

### 7.8 Batch mode and split output

Pointing the converter at a **directory** compiles every MIDI in it against one SoundFont into the split format: a single shared `.tsii` holding the bank for all the songs, plus one `.tpif` per MIDI carrying just that song's patterns.

The shared bank spans the **union** of every song's instruments, so the 8 MiB pool and the 255-slot budget are shared too, and overflow degrades exactly as in single-file mode. A `.tsii` plus its `.tpif` combine to precisely the `.taud` that a single-file conversion of the same MIDI would have produced — which is the property the conversion tests pin.

## 8. Verifying a conversion

Some practical checks, roughly in order of how much they catch per minute spent:

- **Play it against the reference engine, not only your own.** Bit-exact agreement between engines is the format's conformance bar, and a converter bug often shows up as an engine disagreement first.
- **Check the first and last bars.** Cue HALT placement, partial final bars and loop seams all fail at the ends, where a quick listen through the middle will not notice.
- **Check a mid-song tempo or time-signature change.** Grid choice, cue breaking and `T` emission all meet there.
- **Check a note that starts bent, and a note that bends across a bar line** (MIDI), or **a slide that crosses a pattern boundary** (modules). Effect memory and recall resolution show up here.
- **Check an instrument with a keyboard split.** If Ixmp went missing — a stray `--no-project-data`, or a reader that ignores Project Data — every split instrument collapses to one sample, and it is obvious once you know to listen for it.
- **Check the loudest passage.** Pool overflow resampling, mixing-volume headroom and clipping all surface at peak polyphony.
