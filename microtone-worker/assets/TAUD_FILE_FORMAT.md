# Taud File Format Specification

This document defines the **Taud** container family — the on-disk representation of TSVM tracker music — and every structure a conforming reader or writer must understand. Three file kinds share one container: `.taud` (a complete project), `.tsii` (a sample and instrument bank alone) and `.tpif` (patterns and songs alone). They differ only in which sections are present, so this specification describes them together.

Companion documents: the **Taud Engine Specification** defines how the data described here is *played*; the **Note Effects** reference defines the effect column; the **Conversion Notes** describe how other tracker and MIDI formats map onto these structures.

- **Created** by CuriousTorvald, 2026-04-19 (`.tsii` / `.tpif`: 2026-06-15).
- **Endianness** — little, everywhere, without exception.
- **Character encoding** — UTF-8 for Project Data strings unless a field says otherwise. Fixed-width byte fields (the file signature, notation tables) are raw bytes.

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold. Lowercase uses carry their ordinary English meaning and impose no requirement.

Four further terms classify malformed or unused encodings:

- **INVALID.** Blame the encoder. A decoder **MUST** stop decoding and report an error.
- **UNDEFINED BEHAVIOUR.** An encoder **MAY** produce it; a decoder **MAY** do anything in response.
- **IGNORED.** An encoder **MAY** produce it; a decoder **MUST** skip past it without complaint.
- **RESERVED.** An encoder **MUST NOT** produce it; a decoder **MUST** skip past it.

Field tables use these type names: `U8`/`U16`/`U24`/`U32` for unsigned integers, `S8`/`S16` for two's-complement signed integers, `F32` for IEEE 754 binary32, and `Byte[n]` for a raw run of *n* bytes.

## 1. File structure

Every file begins with the same 8-byte magic and 32-byte header. What follows depends on the container kind encoded in the header's version byte.

```
\x1F T S V M a u d
[HEADER]                                  32 bytes total, including the magic
[SAMPLE+INSTRUMENT IMAGE]                 compressed; absent in .tpif
[SONG TABLE]                              32 bytes per song; absent in .tsii
[PATTERN BIN for song 0]                  compressed
[CUE SHEET  for song 0]                   compressed
[PATTERN BIN for song 1]
[CUE SHEET  for song 1]
...
[PROJECT DATA]                            optional; FourCC-tagged blocks
```

The song table sits immediately after the sample and instrument image, so its offset is `32 + (compressed size of that image)`. Each song table entry carries an absolute file offset to its own pattern bin; the cue sheet follows the pattern bin directly, at `song_offset + pattern_bin_compressed_size`. Project Data is located by an absolute offset in the header, not by position, so a writer **MAY** place it anywhere after the song bins.

### Container kinds

| Kind | Version bits `kk` | Sample+inst image | Song table | Typical use |
|---|---|---|---|---|
| `.taud` | `00` | present | present | A complete, self-contained project |
| `.tsii` | `10` | present | **empty** (song count 0) | A shared instrument bank |
| `.tpif` | `11` | **absent** (size 0) | present | One song against a shared bank |

Bits `01` are **RESERVED**; a file carrying them is **INVALID**.

`.tsii` and `.tpif` are not separate formats — they are *specialised interpretations* of this one, so a general Taud reader parses them with no extra code. A `.tpif` is played by first loading its companion `.tsii`: the pattern image loads over the **resident** bank, exactly as the device behaves. See [§8](#8-tsii-and-tpif).

### Compression

Four payloads are compressed independently: the sample and instrument image, and each song's pattern bin and cue sheet. Each is a self-contained stream whose codec is identified by its own leading magic:

| Codec | Magic | Notes |
|---|---|---|
| gzip | `1F 8B 08` | Universally supported; the safe default for writers |
| zstd | `28 B5 2F FD` | Usually smaller, especially on sample images |

A decoder **MUST** sniff the magic rather than assume a codec, because a single file **MAY** mix them — the reference converters compress each payload both ways and keep whichever came out smaller. A writer **MAY** emit either; gzip is **RECOMMENDED** when the reading side is unknown.

Decompressed sizes are implied by the surrounding structures (see each section), so a decoder that needs to pre-allocate can do so without trial decompression.

## 2. Header

Fixed 32 bytes, always at file offset 0.

| Offset | Type | Field |
|---|---|---|
| 0 | `Byte[8]` | Magic — `1F 54 53 56 4D 61 75 64` (`\x1FTSVMaud`) |
| 8 | `U8` | Version and container kind (below) |
| 9 | `U8` | Number of songs in the song table (0 for `.tsii`) |
| 10 | `U32` | Compressed size of the sample and instrument image (0 for `.tpif`) |
| 14 | `U32` | Absolute offset to Project Data; 0 when absent |
| 18 | `Byte[14]` | Tracker / converter signature, space-padded |

A file whose magic does not match is **INVALID**.

### Version byte

```
0b kk x vvvvv
```

- `vvvvv` — **format version**, 1 to 3.
  - **1** — legacy cue sheet: 20 voices, 12-bit pattern numbers, 32 bytes per cue.
  - **2** — extended cue sheet (2026-07-01): 32 voices, 15-bit pattern numbers, 64 bytes per cue with sign-bit instruction words.
  - **3** — the wide pattern cell (2026-07-31): 16 bytes per cell, 8-bit volume, spherical panning column, a second effect ([§5.5](#5-5-format-version-3-the-wide-cell)). Cue sheets are as version 2. Surround songs only, and not readable by the TSVM device.
- `x` (`0x20`) — the Project Data carries an `xHDR` section, which the reader **MUST** also parse. If this bit is clear but an `xHDR` section is present, the file is **INVALID**.
- `kk` — container kind, per the table in [§1](#container-kinds).

A version-2 reader **MUST** accept version-1 files and translate their cue images into the version-2 layout on load (see [§6.3](#6-3-legacy-version-1-cue-sheet)). Writers **SHOULD** emit version 2, and version 3 only for the songs that need it.

Version numbers above 3 are unassigned; a decoder that does not recognise a version **MUST** stop rather than guess.

### Signature

Fourteen bytes naming the producer, used for diagnostics only and otherwise **IGNORED**. Known values include `mod2taud/TSVM `, `s3m2taud/TSVM `, `it2taud/TSVM  `, `xm2taud/TSVM  `, `mon2taud/TSVM `, `midi2taud/TSVM` and `Microtone.js  `. A writer that re-saves an existing file **MAY** preserve the original signature or stamp its own; neither choice affects playback.

## 3. Sample and instrument image

One compressed blob that decompresses to exactly **8 650 752 bytes**:

| Range | Size | Contents |
|---|---|---|
| `0x000000`–`0x7FFFFF` | 8 MiB | Sample pool — raw unsigned 8-bit PCM, no headers |
| `0x800000`–`0x83FFFF` | 256 KiB | Instrument bin — 1024 records of 256 bytes |

The sample pool is a flat byte array. Nothing in it is self-describing: an instrument record (or Ixmp patch) supplies the pointer, length and loop points of every sample, and two instruments **MAY** address overlapping spans. Sample data is unsigned, with `0x80` as the zero level.

The instrument bin holds records for instrument indices 0…1023:

- **0** — always silent. A pattern cell's instrument byte of 0 means "no instrument change", so index 0 is never playable.
- **1…255** — directly addressable: a pattern cell's 8-bit instrument byte selects these.
- **256…1023** — the **auxiliary bin**, reachable only as a Metainstrument layer (a 10-bit index). Pattern cells cannot address it. It exists so that layered instruments do not consume the scarce directly-addressable slots.

A decoder **SHOULD** tolerate a short image by zero-padding to the full size; older files sometimes carry fewer than 1024 records. A `.tpif` has no image at all, and its instruments come from the bank already resident.

## 4. Song table

Present in `.taud` and `.tpif`; the entry count is the header's song count. Each entry is 32 bytes, and entries are contiguous.

| Offset | Type | Field |
|---|---|---|
| 0 | `U32` | Absolute file offset of this song's pattern bin |
| 4 | `U8` | Number of voices (channels) |
| 5 | `U16` | Number of patterns; **0 is INVALID**. Decompressed pattern bin length = `numPatterns × 512` |
| 7 | `U8` | Initial BPM, low 8 bits, biased by −25 (`0x00` = 25 BPM, `0xFF` = 280 BPM) |
| 8 | `U8` | bit 7 = BPM bit 8; bits 0…6 = initial tick rate (**0 is INVALID**) |
| 9 | `U16` | Tuning base note, 1…65533 — a 4096-TET note word; 0 = "use the tracker default" |
| 11 | `F32` | Frequency in Hz at the base note; 0 = "use the tracker default" |
| 15 | `U8` | Global behaviour flags (below) |
| 16 | `U8` | Song global volume, 0…255 |
| 17 | `U8` | Song mixing volume, 0…255 |
| 18 | `U32` | Compressed size of this song's pattern bin |
| 22 | `U32` | Compressed size of this song's cue sheet |
| 26 | `U16` | Number of cues stored in the cue sheet (version 2); 0 in a version-1 file |
| 28 | `U8` | Immutable song flags (below) |
| 29 | `Byte[3]` | **RESERVED** |

The BPM field is split across two bytes, giving a 9-bit range of 25…535. Values above 280 are reachable only from the file or from the extended set-tempo effect; note that the effect form `T $FFxx` cannot express `0x1FF`.

The cue count at offset 26 exists so a loader can size the cue image without deriving it from the decompressed length. When it is 0 (a version-1 file, or a version-2 writer that omitted it), a reader **MUST** fall back to `decompressed_length ÷ cue_size`.

### Global behaviour flags (byte 15)

This byte is the file-level form of effect `1` and is applied before the first row.

```
0b 000 rrr ff
```

| Bits | Field | Values |
|---|---|---|
| `ff` (0…1) | Tone mode | 0 = linear 4096-TET pitch slides, 1 = Amiga period slides, 2 = linear-frequency (Hz) slides, 3 = **RESERVED** |
| `rrr` (2…4) | Interpolation | 0 = default (windowed sinc), 1 = none, 2 = Amiga 500, 3 = Amiga 1200, 4 = SNES 4-tap Gaussian, 5 = NES DPCM simulation |
| 5…7 | — | **RESERVED** |

Effect `1` may change these at runtime, but the change does not persist: starting a song re-applies the file's byte.

### Immutable song flags (byte 28)

```
0b 0000 00ss
```

`ss` selects the **surround model**: 0 = stereo, 1 = planar (360° panning), 2 = spatial (full sphere), 3 = **RESERVED**. It is immutable because it changes what the pan column *means*; no effect can alter it mid-song. Bits 2…7 are **RESERVED**.

### Tuning

The pair at offsets 9 and 11 declares "note *N* sounds at *F* Hz", and the engine scales the whole song accordingly. Either field reading 0 means "assume the tracker default", which is **C9 (`0xA000`) at 8363.0 Hz** — the Amiga convention, which puts A4 at roughly 439.53 Hz, about 1.87 cents flat of concert pitch. (The exact NTSC-derived reference is `(3579545 ÷ 428) × 2^(3/4) ÷ 32` ≈ 439.548 Hz; the format stores the rounded 8363.0.)

Well-known declarations:

| Declaration | Meaning |
|---|---|
| A4 (`0x5C00`) @ 440 Hz | ISO concert pitch — renders as an exact identity, disturbing no bits |
| A4 @ 435 Hz | Former French standard (1859) |
| A4 @ 452 Hz | Old Philharmonic pitch (19th-century Britain) |
| C4 (`0x5000`) @ 256 Hz | Scientific / power-of-two pitch |
| C4 @ 262 Hz | Modern Chinese *a-ak* convention |
| C4 @ 311 Hz | Korean *hyang-ak* standard (ROK National Gugak Center) |

## 5. Pattern bin

A song's pattern bin decompresses to `numPatterns × 64 × cellSize` bytes: one image per pattern, back to back. A Taud pattern is **single-channel** — 64 rows — which is why a cue names one pattern *per channel* rather than one pattern for the whole song. `cellSize` is fixed by the file's format version: **8 bytes** in versions 1 and 2, **16 bytes** in version 3 ([§5.5](#5-5-format-version-3-the-wide-cell)), so a v3 pattern image is 1024 bytes and a given pattern bin holds half as many patterns for the same number of bytes.

### Pattern cell

| Offset | Type | Field |
|---|---|---|
| 0 | `U16` | Note word |
| 2 | `U8` | Instrument, 0…255; 0 = no instrument change |
| 3 | `U8` | Volume column: bits 0…5 value, bits 6…7 selector |
| 4 | `U8` | Panning column: bits 0…5 value, bits 6…7 selector |
| 5 | `U8` | Effect opcode — a base-36 digit value (`0`…`9` = `0x00`…`0x09`, `A`…`Z` = `0x0A`…`0x23`) |
| 6 | `U16` | Effect argument |

Rendered by a tracker's display, one row reads:

```
rr || NOTE | Ins | E.Vol | E.Pan | EE.ffff |
63 || FFFF |  FF | 3 3F  | 3 3F  | FF FFFF |
```

### Note words

Notes are **4096 tone-equal temperament**: 4096 steps to the octave, with `0x1000` per octave. `0x5000` is C4 (middle C); `0x1000` is C0 and `0xF000` is C14. The playable range is `0x0020`…`0xFFFF`. Values `0x0000`…`0x001F` are reserved for sentinels:

| Value | Name | Meaning |
|---|---|---|
| `0x0000` | — | No note event on this row |
| `0x0001` | Key off | Release the sustain region; the release stage of the envelope plays |
| `0x0002` | Note cut | Silence the voice immediately |
| `0x0003` | Note fade | Begin the fadeout without releasing sustain |
| `0x0004` | Fast fade | Fast fadeout (~0.3 s) — the SoundFont *exclusiveClass* choke |
| `0x0005`–`0x000F` | — | **RESERVED** |
| `0x0010`–`0x001F` | Int0…IntF | Interrupt markers 0…15: produce no sound, latch a host-visible flag |

Actual sounding pitch also depends on the instrument's sampling rate and detune; the note word alone is not a frequency. See the Engine Specification.

### Volume and panning columns

Both columns share one encoding: a 6-bit value plus a 2-bit selector.

| Selector | Name | Volume column | Panning column |
|---|---|---|---|
| 0 | SET | Set note volume to *value* (0…63) | Set channel pan to *value* scaled to 0…255 |
| 1 | SLIDE UP | Slide volume up by *value* per tick | Slide pan right by *value* per tick |
| 2 | SLIDE DOWN | Slide volume down by *value* per tick | Slide pan left by *value* per tick |
| 3 | FINE | One-shot delta on tick 0: bit 5 = direction (set = up/right), bits 0…4 = magnitude | Same |

A FINE selector with a value of 0 is therefore a **no-op**, and that is the canonical "this column is empty" encoding: byte `0xC0`. Converters and editors write `0xC0` into both columns of an untouched cell, so a cell with no volume or pan intent does not disturb running state.

The panning column's SET is a front-arc value even in a surround song — six bits cannot express a full turn. Effects `S $8xxx` and `X` are the commands that place a source anywhere on the circle or the sphere. Format version 3 lifts that limit; see below.

### 5.5 Format version 3 — the wide cell

Version 3 doubles the pattern cell to **16 bytes** so that the two columns a surround song leans on hardest stop being the narrowest fields in the format: the volume column becomes eight bits, and the panning column carries a whole spherical position rather than a front-arc sixth of one.

It is a **whole-file** property, because the version byte is. Every song in a v3 file uses the wide cell, including any that is still stereo — such a song simply never reads the spatial fields.

**When it may be written.** A writer **MUST NOT** emit version 3 unless at least one song in the file declares a surround model (`ss` ≠ 0); version 3 exists to serve them. A reader **MUST** accept any well-formed v3 file regardless. There is no downgrade: the wide cell can express positions, volumes and second effects that the 8-byte cell cannot, so a conversion back to version 2 would be lossy and is **NOT** defined. An editor offering the upgrade **SHOULD** say so, and **SHOULD** write the result to a new file rather than over the original.

Version 3 is not supported by the TSVM device, whose audio hardware has no surround model at all.

#### The wide cell

| Offset | Type | Field |
|---|---|---|
| 0 | `U16` | Note word — unchanged |
| 2 | `U8` | Instrument, 0…255; 0 = no instrument change |
| 3 | `U8` | Volume column **value**, 0…255 |
| 4 | `U8` | Panning column **azimuth**, low 8 bits |
| 5 | `U8` | Effect 1 opcode |
| 6 | `U16` | Effect 1 argument |
| 8 | `U8` | Column selectors: `0b Avvv pppp` — `A` = azimuth bit 8, `vvv` = volume selector, `pppp` = panning selector |
| 9 | `S8` | Panning column **elevation** |
| 10 | `U8` | Effect 2 opcode |
| 11 | `U16` | Effect 2 argument |
| 13 | `Byte[3]` | **RESERVED** |

Rendered by a tracker's display, one row reads:

```
rr || NOTE | Ins | E.Vol | E.ElAzm | EE.ffff |
63 || FFFF |  FF | 7 FF  | F FF1FF | FF FFFF |
```

The volume selector is three bits, so its display digit only ever reaches **7**; the panning selector is a full nibble. Both keep the version-2 numbering — 0 SET, 1 SLIDE UP, 2 SLIDE DOWN, 3 FINE — and selectors 4 and above are **RESERVED** in both columns.

#### Volume column

The value is a plain byte, 0…255. Note volume, row volume and channel volume are all 0…255 in a v3 song, so the column reaches the engine's own resolution instead of a quarter of it.

- **SET** — note volume = *value*.
- **SLIDE UP / SLIDE DOWN** — by *value* per tick, in the same 0…255 units, so a slide can now move by one unit per tick.
- **FINE** — a one-shot delta on tick 0: **bit 7** = direction (set = up), bits 0…6 = magnitude. (Version 2 put the direction in bit 5, the top of its 6-bit field; the flag moves with the field width.)

A FINE selector with a value of 0 remains the **no-op**, and remains the canonical "this column is empty" encoding: a fine slide by zero is meaningless at any width. An untouched v3 cell therefore has selector byte `0x33` — FINE in both columns — with its value, azimuth and elevation bytes zero.

**What stays six bits.** Volume-envelope node values and an Ixmp patch's velocity rectangle live in the *instrument* record, which version 3 does not change: a bank is format-neutral, and the same `.tsii` loads into a v2 or a v3 project. A v3 engine scales those 0…63 values by 4 when it reads or compares them. Effect-column volume slides (`D`, `K`, `L`, `N`, the retrigger volume modifiers) are nibble-packed and keep their version-2 arguments; a v3 engine multiplies their per-tick step by 4, so `D $01` moves at the rate it always did. Effects that set an absolute volume LEVEL from a byte — channel volume `M` — use the full 0…255 range.

#### Panning column

The azimuth is nine bits: byte 4 plus the `A` bit, in the units of `S $8xxx` (0 = left, 128 = front, 256 = right, 384 = behind, clockwise). The elevation is byte 9, signed, in effect `X`'s units (128 = 90°). Together they place a source anywhere on the sphere from the column alone.

- **SET** — position the source at (azimuth, elevation). A planar song forces the elevation to zero; a stereo song folds the azimuth as it folds every other one.
- **SLIDE UP / SLIDE DOWN** — rotate the azimuth right / left by the **low byte** per tick, wrapping in a surround song and clamping in a stereo one. The elevation byte is **RESERVED** for these selectors and **MUST** be zero.
- **FINE** — a one-shot rotation on tick 0: `A` = direction (set = right), low byte = magnitude, elevation **RESERVED**.

Two interactions carry over or extend the version-2 rules:

- `S $8xxx` on the same row **wins**: a pan column SET is ignored when the row's effect is a set-pan, exactly as in version 2.
- A **`Z` slide on the same row** turns a pan column SET into the slide's TARGET rather than an immediate jump — the column then says the same thing effect `4` would have, and the source travels there instead of appearing there. If the row carries both `4` and a pan SET, the column wins, being the more specific statement.

#### Effect 2

A second effect, with the same opcode and 16-bit argument encoding as the first, applied **after** it on every pass — the row pass and each tick pass alike. Where two effects would write the same channel state, the second therefore lands last. The reference editor does not expose it; it exists so that a converter is no longer forced to discard one of two simultaneous source commands.

#### Upgrading a version-2 song

| Field | Mapping |
|---|---|
| Volume SET / slides | `round(value × 255 ÷ 63)` — the column's units quadrupled |
| Volume FINE | magnitude scaled the same way; the direction flag moves bit 5 → bit 7 |
| Panning SET | azimuth = `(value << 2) \| (value >> 4)`, the same byte the version-2 engine derived from a 6-bit SET; elevation 0 |
| Panning slides | magnitude **verbatim** — a pan-byte step and an azimuth step are the same unit |
| Panning FINE | magnitude verbatim; the direction flag moves bit 5 → `A` |
| Effect columns | copied verbatim into effect 1; effect 2 empty |
| Channel volume `M` | argument scaled `round(× 255 ÷ 63)` — it sets an absolute level, not a delta |

Everything else copies across unchanged. Note that only the volume column is rescaled: the panning column's old value was a *fraction of the front arc* and its new one is an angle on the same arc, so the numbers already agree. Nibble-packed effect arguments are never touched — a version-3 engine scales their per-tick step instead ([§5.5 volume column](#volume-column)) — so a converted song sounds as it did.

## 6. Cue sheet

The cue sheet is the song's order list. Unlike most trackers, one cue names a pattern **for every channel** independently, plus up to two flow instructions. A song is therefore a sequence of cues, and channels never diverge.

### 6.1 Version 2 layout

Each cue is an array of `S16` channel words: 32 words (64 bytes) normally, or 64 words (128 bytes) in 64-channel mode. Cues are stored back to back; the count comes from the song table (or from the decompressed length divided by the stride).

Each channel word:

| Bits | Field |
|---|---|
| 0…14 | Pattern number, 0…`0x7FFE`; `0x7FFF` = no pattern on this channel |
| 15 | One bit of an instruction word (below) |

A song may therefore carry up to 32 767 patterns, and the cue sheet holds up to 8192 cues (4096 in 64-channel mode).

### 6.2 Instruction words

The sign bits of the channel words are harvested into two 16-bit instruction words:

- **Word 0** — sign bits of channels 0…15; channel *c* contributes bit *c*.
- **Word 1** — sign bits of channels 16…31; channel *c* contributes bit *c* − 16.

In 64-channel mode a cue spans two 64-byte rows and the sign bits of channels 32…63 encode nothing; the two-instruction limit is unchanged.

A word decodes from `b30 = word >> 8` and `b31 = word & 0xFF`:

| `b30` | `b31` | Instruction | Meaning |
|---|---|---|---|
| `0x00` | `0x00` | NOP | No operation — a plain 64-row cue |
| `1000xxxx` | `yyyyyyyy` | BAK | Go back `0bxxxxyyyyyyyy` cues |
| `1001xxxx` | `yyyyyyyy` | FWD | Skip forward `0bxxxxyyyyyyyy` cues |
| `1111xxxx` | `yyyyyyyy` | JMP | Jump to absolute cue `0bxxxxyyyyyyyy` (this is how a song loops) |
| `00000010` | `00xxxxxx` | LEN | This cue is `xxxxxx + 1` rows long (1…64) |
| `00000001` | `00000000` | HALT | Play the whole pattern, then stop |
| `00000001` | `01xxxxxx` | HALT AT | Play `x` rows, then stop; `x` = 0 behaves as plain HALT |

Because a cue carries two words it can hold two instructions — LEN together with JMP, for instance.

BAK, FWD and JMP arguments remain 12-bit (0…4095) even though the sheet addresses 8192 cues. A song that must loop beyond cue 4095 cannot express it with JMP.

Reader rules:

- A cue's effective row count is the **minimum** of what each word implies (64 unless the word is LEN or HALT AT).
- The cue halts playback if **either** word is HALT or HALT AT.
- The flow instruction is word 0's if word 0 carries one, otherwise word 1's.
- `b30 == 0x01` with `b31` not matching `01xxxxxx` decodes as a plain HALT. Historic documentation assigned `00000001 00xxxxxx` to a "fade out then stop" instruction; it was never implemented and is now **RESERVED**.

Converters place the HALT on the **last active cue**, not in an empty cue appended after it, so playback stops as the last row completes rather than after a silent 64-row gap.

### 6.3 Legacy version-1 cue sheet

Version-1 files store 32 bytes per cue for 20 voices, with 12-bit pattern numbers spread across three nibble planes:

| Bytes | Contents |
|---|---|
| 0…9 | Low nibble of the pattern number for voices 1…20, two voices per byte (high nibble first) |
| 10…19 | Middle nibble, same packing |
| 20…29 | High nibble, same packing |
| 30…31 | Instruction word: byte 30 is the high byte, byte 31 the low byte |

The pattern-empty sentinel is `0xFFF`. A version-2 reader **MUST** translate: reassemble each 12-bit number, map `0xFFF` to `0x7FFF`, place the instruction word's bit *c* into channel *c*'s sign bit for channels 0…15, and leave channels 20…31 empty. Instruction decoding is identical.

### 6.4 Trailing-cue trimming

A cue is *empty* when every channel word is `0x7FFF` and both instruction words are NOP — that is, every byte of its stride is `FF 7F`. Writers **SHOULD** drop the trailing run of empty cues (keeping at least one cue) so that deleting content past a point actually shrinks the file. Interior empty cues are meaningful rests and **MUST** be preserved.

## 7. Instrument records

Each instrument occupies 256 bytes in the instrument bin. Envelopes are described by three independent regions per envelope, and the record carries two pitch-or-filter envelope slots, which is what lets a single instrument hold both.

If the record's `U32` at offset 0 has its high 16 bits equal to `0xFFFF` — a value no real sample pointer can take, since the 8 MiB pool caps pointers at `0x7FFFFF` — the record is a **Metainstrument** and bytes 0…3 are reinterpreted per [§7.4](#7-4-metainstrument-records).

### 7.1 Byte map

| Offset | Type | Field |
|---|---|---|
| 0 | `U32` | Sample pointer into the pool (or the Metainstrument sentinel) |
| 4 | `U16` | Sample length in bytes |
| 6 | `U16` | Sampling rate at C4 (note `0x5000`) |
| 8 | `U16` | Play start — where a fresh trigger begins (usually 0) |
| 10 | `U16` | Loop start (**MAY** be smaller than play start) |
| 12 | `U16` | Loop end |
| 14 | `U8` | Instrument / sample flags (below) |
| 15 | `U16` | Volume envelope LOOP word |
| 17 | `U16` | Panning envelope LOOP word |
| 19 | `U16` | Pitch/filter envelope LOOP word, slot 1 |
| 21 | `U16 × 25` | Volume envelope nodes — value 0…63, then offset |
| 71 | `U16 × 25` | Panning envelope nodes — value 0…255 (`0x80` centre), then offset |
| 121 | `U16 × 25` | Pitch/filter envelope nodes, slot 1 — value 0…255 (`0x80` unity), then offset |
| 171 | `U8` | Instrument global volume, 0…255 |
| 172 | `U8` | Volume fadeout, low 8 bits |
| 173 | `U8` | Fadeout high nibble + filter interpretation mode (below) |
| 174 | `U8` | Volume swing, 0…255 |
| 175 | `U8` | Auto-vibrato speed |
| 176 | `U8` | Auto-vibrato sweep |
| 177 | `U8` | Default pan value, 0…255 (enabled by the pan LOOP word's `p` bit). In surround/spatial mode, the positive half of the azimuth |
| 178 | `U16` | Pitch-pan centre, as a 4096-TET note word |
| 180 | `S8` | Pitch-pan separation, −128…127 |
| 181 | `U8` | Pan swing, 0…255 |
| 182 | `U8` | Default cutoff — 0…254, 255 = filter off |
| 183 | `U8` | Default resonance — 0…254, 255 = off |
| 184 | `S16` | Sample detune, in 4096-TET units |
| 186 | `U8` | Instrument flag: NNA, vibrato waveform |
| 187 | `U8` | Auto-vibrato depth, 0…255 |
| 188 | `U8` | Auto-vibrato rate, 0…255 |
| 189 | `U16` | Volume envelope SUSTAIN word |
| 191 | `U16` | Panning envelope SUSTAIN word |
| 193 | `U16` | Pitch/filter envelope SUSTAIN word, slot 1 |
| 195 | `U8` | Duplicate Check Type and Action (below) |
| 196 | `U8` | Default note volume, 0…255 |
| 197 | `U16` | Pitch/filter envelope LOOP word, slot 2 |
| 199 | `U16` | Pitch/filter envelope SUSTAIN word, slot 2 |
| 201 | `U16 × 25` | Pitch/filter envelope nodes, slot 2 |
| 251 | `U8` | Initial attenuation, as a decibel octet ([§7.5](#7-5-the-decibel-octet-table)); 0 = unity |
| 252 | `U8` | Default cutoff, low bits (SoundFont mode only) |
| 253 | `U8` | Default resonance, low bits (SoundFont mode only) |
| 254 | `S8` | Panning elevation, ignored in stereo mode |
| 255 | `Byte` | **RESERVED** |

**The instrument's default position.** In a stereo song byte 177 is the pan value it has always been. In a surround song the same byte is the **low eight bits of a 9-bit azimuth** — byte 14's `A` bit supplies the ninth — read in the units of `S $8xxx` (0 = left, 128 = front, 256 = right, 384 = behind), and byte 254 is the elevation in effect `X`'s signed units (128 = 90°). This is the same relationship `S $80xx` has with `S $8xxx`, so every file written before these bits existed stays valid: `A` clear puts the default on the front arc, which is exactly what its pan byte always meant, and a stereo song never reads either extra field.

A planar song forces the elevation to zero, as it does for every other source of elevation. The fields are consumed only when the pan envelope's `p` bit ("use default pan") is set, and an **Ixmp patch cannot override them**: a patch record carries an 8-bit `default pan` and no elevation, so a patch override moves the azimuth onto the front arc while the instrument's elevation stands. The pan ENVELOPE offsets the azimuth and leaves the elevation alone.

#### Byte 14 — instrument / sample flags

```
0b 00AP 0spp
```

| Bits | Field |
|---|---|
| `pp` (0…1) | Loop mode: 0 = none, 1 = forward loop, 2 = ping-pong, 3 = one-shot (plays to the end regardless of note length) |
| `s` (2) | The loop is a **sustain** loop: key-off escapes it |
| `P` (4) | This instrument is **percussion**; a retuner or transposer **MUST NOT** touch its notes |
| `A` (5) | The panning azimuth is behind the listener: bit 8 of the 9-bit azimuth, i.e. **add 0x100** to byte 177's value |

#### Byte 173 — fadeout high bits and filter mode

```
0b 000m ffff
```

`ffff` is the high nibble of the 12-bit volume fadeout (combined with byte 172). `m` selects how the filter fields are read:

- `m = 0` — **ImpulseTracker units.** Cutoff is byte 182 alone and resonance is byte 183 alone, each 0…254 (255 = off). The IT range 0…127 maps to 0…254 here.
- `m = 1` — **SoundFont units.** Cutoff is `(byte 182 << 8) | byte 252` in absolute cents; resonance is `(byte 183 << 8) | byte 253` in centibels above the DC gain.

#### Volume fadeout (bytes 172–173)

The combined 12-bit value drives a per-tick decay of the voice's fadeout multiplier once the voice is in key-off or note-fade state: `fadeout −= stored ÷ 1024` per tick, clamped to 0, at which point the voice deactivates. There is no separate "use fadeout" flag; like IT and XM, both extremes live in the same field:

| Stored | Behaviour |
|---|---|
| 0 | **No fade.** The voice rings until the envelope, the sample end or a note cut ends it |
| 1…1023 | Graduated fade, completing in `1024 ÷ stored` ticks |
| 1024 | Exactly one tick — the canonical "kill on key-off" |
| 1025…4095 | Also a one-tick cut; the headroom lets converters pass through out-of-range source values without saturating early |

At the default 50 Hz tick rate: stored 1 ≈ 20.5 s, stored 32 ≈ 640 ms, stored 1024 ≈ 20 ms.

#### Byte 186 — instrument flag

```
0b 00N www nn
```

| Bits | Field |
|---|---|
| `Nnn` (0…1, 5) | New Note Action: 0 = note off, 1 = note cut, 2 = continue, 3 = note fade, 4 = key lift (see below) |
| `www` (2…4) | Auto-vibrato waveform: 0 = sine, 1 = ramp down, 2 = square, 3 = random, 4 = ramp up |

**Key lift**: on key-off, jump the volume envelope straight to the sustain-end node so the release nodes play at once, instead of walking the remaining pre-sustain nodes first. This is exactly a MIDI key release; instruments with no volume-envelope sustain region are unaffected.

#### Byte 195 — Duplicate Check

```
0b 0000 dcdt
```

| Bits | Field |
|---|---|
| `dt` (0…1) | Duplicate Check **Type**: 0 = off, 1 = note, 2 = sample, 3 = instrument |
| `dc` (2…3) | Duplicate Check **Action**: 0 = note cut, 1 = note off, 2 = note fade |

IT-only semantics; FT2-sourced instruments leave this 0. The values consulted at trigger time belong to the *existing* voice's instrument, not the incoming note's, so two instruments on one channel can behave asymmetrically — which is IT-correct.

#### Byte 171 versus byte 196

These are two different volume axes and converters routinely get them confused:

- **Byte 171, instrument global volume**, is a continuous multiplier on every output sample of the voice. It is orthogonal to the volume column and to `Mxx`/`Nxx`.
- **Byte 196, default note volume**, seeds the *per-note* volume axis at trigger time, and any explicit volume-column SET on the trigger row overrides it. The stored 0…255 rescales to the engine's 0…63 note-volume range.

Files written before 2026-05-09 folded the source's per-sample volume into byte 171 and left byte 196 zero. A reader **SHOULD** treat `byte 196 == 0` as "field not present" and fall back to a default note volume of 63, which preserves those files' balance.

### 7.2 Envelopes

Every envelope is 25 nodes. Each node is two bytes: a **value** and an **offset** — the time until the next node, encoded as a 3.5 unsigned minifloat (3-bit exponent, 5-bit mantissa) covering 0…15.75 s with a smallest non-zero step of 1/256 s ≈ 3.91 ms. That step was chosen so a single tracker tick resolves at every supported tempo. **An offset of 0 means "hold at this node indefinitely"** — it is the terminator.

Given a minifloat index *i*, with `e = i >> 5` and `m = i & 31`:

```
seconds = (e == 0) ? m / 256                      (denormal)
                   : (32 + m) * 2^(e - 1) / 256
```

Every value is an exact binary fraction, so the table is reproducible on any platform without a lookup table.

Each envelope has two 16-bit control words, at different offsets, which is what makes sustain versus loop a structural distinction rather than a flag bit.

**LOOP word** — an always-active wrap region:

```
0b 00P sssss Xcb eeeee
```

| Bits | Field |
|---|---|
| 0…4 (`e`) | Loop end node index, 0…24 |
| 5 (`b`) | Enable the loop wrap |
| 6 (`c`) | Envelope **carry** — carry the envelope position across triggers |
| 7 (`X`) | Role-specific: pan envelope = `p` ("use default pan", byte 177); pitch/filter envelope = `m` (0 = pitch, 1 = filter); volume envelope = **RESERVED** |
| 8…12 (`s`) | Loop start node index, 0…24 |
| 13 (`P`) | **Envelope present in the source** |
| 14…15 | **RESERVED** |

**SUSTAIN word** — a wrap region active only while the key is on:

```
0b 000 sssss 00b eeeee
```

Bits 0…4, 5 and 8…12 carry the same meaning as in the LOOP word; bits 6…7 and 13…15 are **RESERVED** (the carry bit lives in the LOOP word).

Wrap priority, evaluated every tick:

1. If SUSTAIN is enabled and the key is on — wrap between sustain start and sustain end.
2. Otherwise, if LOOP is enabled — wrap between loop start and loop end.
3. Otherwise — walk forward and hold at the last node.

A single-point sustain (the FT2 idiom) is encoded as `sus_start == sus_end`. A sustain *loop* (the IT idiom) uses `sus_start <= sus_end`. There is no separate "release loop": once sustain releases, the LOOP region — if any — captures the playhead when it walks into that range.

The **`P` bit is the sole presence signal.** A converter **MUST** set `P = 1` whenever it emits envelope nodes, regardless of whether the source enables any wrap. `P = 0` means the source had no envelope of this kind at all: the node array is **IGNORED**, and the engine reads pan from the channel value and cutoff/pitch from the sample defaults. `P = 1` means the envelope is evaluated every tick even when neither wrap is enabled — that is the IT idiom for envelope-driven decay tails and shaped attacks. Files written before 2026-05-06 predate the `P` bit and will not have their pan or pitch/filter envelopes evaluated; they need re-converting from source.

The two pitch/filter slots (bytes 19/121/193 and 197/201/199) are distinguished by their own `m` bits. A record whose two slots claim the same role is **INVALID**. IT and XM instruments fill one slot and leave the other absent; SoundFont instruments, whose single modulation envelope drives pitch *and* filter simultaneously, use both.

### 7.3 Ixmp patches

The base record can describe exactly one sample. An instrument that needs a keyboard map, velocity layers, per-sample envelopes or a stereo pair carries an **Ixmp** ("instrument extra samples") patch list in the Project Data. See [§9.9](#9-9-ixmp-instrument-extra-samples).

### 7.4 Metainstrument records

A Metainstrument occupies an ordinary 256-byte slot and is referenced by a pattern cell exactly like any instrument, but carries no sample of its own. Instead it triggers a list of **layers**, each an ordinary instrument sounded simultaneously at its own mix level, detune and (note × volume) sub-range.

| Offset | Type | Field |
|---|---|---|
| 0 | `U8` | Type and flags: `0b tttt_00Ps` |
| 1 | `U8` | Layer count, 1…25 |
| 2 | `U8` | Sentinel — **MUST** be `0xFF` |
| 3 | `U8` | Sentinel — **MUST** be `0xFF` |
| 4 | — | Layer records, 10 bytes each |

Bytes 0…3 alias the base record's sample pointer, and the two `0xFF` sentinels are what put `0xFFFF` in its high half. In byte 0: `t` is the type (only type 0, *layered*, is defined), `P` marks the instrument as percussion, and `s` selects **strict layering** (below). Legacy files leave byte 0 as `0x00`.

Each layer record:

| Offset | Type | Field |
|---|---|---|
| +0 | `U8` | Layer instrument index, low 8 bits |
| +1 | `U8` | Mix volume as a decibel octet ([§7.5](#7-5-the-decibel-octet-table)) |
| +2 | `S16` | Sample detune, in 4096-TET units |
| +4 | `U16` | Pitch range low (full range = `0x0000`) |
| +6 | `U16` | Pitch range high, inclusive (full range = `0xFFFF`) |
| +8 | `U8` | bits 0…5 = volume range low (0…63); bits 6…7 = layer instrument index bits 8…9 |
| +9 | `U8` | bits 0…5 = volume range high, inclusive; bits 6…7 **RESERVED** |

The four range fields define a rectangle over the same pitch × volume space as an Ixmp patch. A layer fires only when the trigger falls inside its rectangle, which is how key- and velocity-conditional layering is expressed.

- Layer rectangles **MAY** overlap; that is the entire point. Every layer whose rectangle contains the trigger sounds, each on its own voice. (Overlap within a single ordinary instrument's Ixmp patch list remains **INVALID** — layering lives here instead.)
- The same ordinary instrument **MAY** be listed several times at different detune and mix level, which reproduces SoundFont detune stacks without spending extra instrument slots.
- Mix volume **scales** the layer's output; it multiplies with the trigger's velocity rather than replacing it. Sample detune is **added** to the trigger note and to the layer instrument's own detune.
- **Recursion is forbidden.** A layer index **MUST** resolve to an ordinary instrument in `0x001`…`0x3FF`. A layer pointing at another Metainstrument, or at instrument 0, is skipped by the engine.
- A single Metainstrument trigger costs up to *layer count* voices against the mixer's pool.

**Strict layering** (byte 0, bit 0) addresses a subtle failure. A layer's rectangle is a single bounding box, but the layer instrument's own Ixmp zones may cover only part of it — a drum layer holding scattered keys has a box spanning the gaps between them. Under legacy semantics a trigger landing in such a gap still fires the layer and, matching no patch, falls through to that instrument's base sample, sounding a wrong instrument (a closed hi-hat under an open one). With strict layering the engine drops the layer for that note instead. A producer setting this bit **MUST** also place each layer instrument's canonical zone in its own Ixmp patch list, so that a non-match unambiguously means "no zone covers this trigger".

### 7.5 The decibel octet table

Two fields — Metainstrument layer mix volume and instrument/patch initial attenuation — encode gain as an octet on a *perceptually significant* scale rather than a linear one. Octet **159 is 0 dB (unity)**; the scale is finest near unity and coarsens outward:

| Octet range | Step | dB at the range's edges |
|---|---|---|
| 255…232 | 0.5 dB | +24 down to +12.5 |
| 231…208 | 0.25 dB | +12 down to +6.25 |
| 207…112 | 0.125 dB | +6 down to −5.875 |
| 111…88 | 0.25 dB | −6 down to −11.75 |
| 87…64 | 0.5 dB | −12 down to −23.5 |
| 63…2 | 1 dB | −24 down to −85 |
| 1 | — | −86 dB |
| 0 | — | −∞ (silence) |

Linear amplitude is `10^(dB ÷ 20)`. **Octet 0 means unity, not silence, in the two *initial attenuation* fields** (byte 251 and the Ixmp `x` block), where it is the unset sentinel that keeps legacy files — whose reserved bytes were zero — unaffected. In the Metainstrument layer mix field, 0 is genuine silence.

## 8. `.tsii` and `.tpif`

Both are the same container with parts omitted.

**`.tsii` — Taud Sample and Instrument Image.** Stores a bank alone, for several `.tpif` songs that share it.

- The song count is 0 and there is no song table.
- The version byte's kind bits are `10`.
- Project Data carries only instrument- and sample-scoped sections — those whose FourCC begins with `I` or `S`.

**`.tpif` — Taud Pattern Image.** Stores patterns and songs alone.

- The compressed size of the sample and instrument image is 0 and the image is absent.
- The version byte's kind bits are `11`.
- Project Data carries only pattern- and song-scoped sections — those whose FourCC begins with `p` or `s`.

The intended use case is compiling a collection of MIDI files against one SoundFont: the SoundFont becomes one `.tsii`, and each MIDI becomes a `.tpif`. Loading a `.tpif` applies it over whatever bank is currently resident, so the two must be loaded in order. A `.tsii` plus a `.tpif` combine to exactly the `.taud` that a single-file conversion of the same source would have produced.

## 9. Project Data

Project Data is the extension mechanism: a concatenation of FourCC-tagged blocks that a Taud reader may skip entirely and still play the song. This is what makes the format forward- and backward-compatible — Microtone project data rides along in a file the TSVM device plays without understanding it.

```
Byte[8]  Magic — \x1E T a u d P r J  (1E 54 61 75 64 50 72 4A)
Byte[8]  RESERVED
* repetition of:
  Byte[4]  Section FourCC
  U32      Section payload length
  Byte[*]  Payload
```

A reader walks sections until it runs out of file. An unrecognised FourCC **MUST** be skipped using its length field. Sections **MAY** appear in any order; duplicate sections are **UNDEFINED BEHAVIOUR**.

FourCC prefixes indicate scope, and `.tsii`/`.tpif` splitting relies on them:

| Prefix | Scope |
|---|---|
| `P` | Project |
| `I` | Instrument |
| `p` | Pattern |
| `S` | Sample |
| `s` | Song |

### 9.1 `xHDR` — extended header

Only a format-version-2 (or later) file **MAY** carry this section; otherwise the file is **INVALID**. Its presence **MUST** be mirrored by the header version byte's `x` bit.

| Offset | Type | Field |
|---|---|---|
| 0 | `U8` | Flags1: bit 0 = 64-channel mode |
| 1 | `Byte[255]` | **RESERVED** |

64-channel mode changes the cue stride to 128 bytes and the per-cue channel count to 64. A reader **MUST** consult this section *before* parsing cue sheets.

### 9.2 `PNam`, `PCom`, `PCpr`, `Pmsg` — project strings

Each holds one UTF-8 string: the project name, author, copyright notice and free-form message respectively.

### 9.3 `INam` — instrument name table

Instrument names, separated by `0x1E`, in instrument-index order. UTF-8.

### 9.4 `SNam` — sample name table

Sample names, separated by `0x1E`, in sample-pool order. UTF-8. Taud has no sample records — a "sample" is a span in the pool referenced by instruments — so this table is ordered by the deduplicated census of spans that a producer derives from the instrument bin and the Ixmp patches.

### 9.5 `pNam` — pattern name table

Pattern names, separated by `0x1E`, in pattern-index order. UTF-8.

### 9.6 `sMet` — song metadata table

Per-song display metadata. Repetition of:

| Type | Field |
|---|---|
| `U8` | Song index |
| `U32` | Size of the remainder of this entry |
| `U16` | Notation index (below) |
| `U8` | Primary beat division, in rows (default 4) |
| `U8` | Secondary beat division, in rows (default 16) |
| `Byte[*]` | Song name, NUL-terminated, UTF-8 |
| `Byte[*]` | Composer, NUL-terminated, UTF-8 |
| `Byte[*]` | Copyright, NUL-terminated, UTF-8 |

The beat divisions drive a tracker's row banding and are purely cosmetic. The **notation index** selects how note words are *displayed* — it never changes pitch. Registered values:

| Index | Notation |
|---|---|
| 0 | Raw numbers (hex note words) |
| 1 | ProTracker pitch (period-based) |
| 10 × *n* | *n*-tone equal temperament — 12-TET is 120, 24-TET is 240, and so on |
| 410, 530, 960 | 41-, 53- and 96-TET in Kite notation |
| 531 | 53-TET Pythagorean notation |
| 10121 | Pythagorean diminished fifth (12 tones) |
| 10122 | Pythagorean augmented fourth (12 tones) |
| 10123 | Shi'er lü — East Asian traditional tuning (12 tones) |
| 35130 | Equal-tempered Bohlen–Pierce (13 divisions of the tritave) |
| 65520…65535 | Custom notations defined by the `nota` section, index 0 = 65535 downwards |

An unknown index **SHOULD** fall back to 12-TET display.

### 9.7 `nota` — custom notation definitions

Defines notations beyond the registered set. Repetition of:

| Type | Field |
|---|---|
| `U8` | Notation index, counting from 0 (internally mapped to 65535 − index) |
| `U32` | Size of the remainder of this entry |
| `U16` | **RESERVED** for flags |
| `U16` | Interval size in the 4096-TET lattice — octave = `0x1000`, tritave = `0x195C`. **0** when the notation is not an interval system (and therefore names every note it can express explicitly) |
| `U16` | **RESERVED** for a float32 interval size |
| `U16` | Notes between intervals **minus one** — 12-TET stores 11 |
| `U16` | Base note the frequency table is offset against, as an absolute note word (C4 = `0x5000`); 0 = the default |
| `Byte[6]` | **RESERVED** |
| `Byte[*]` | Name, NUL-terminated, UTF-8 |
| `Byte[*]` | Notation table — `0xFF`-separated, NUL-terminated, in the Taud character set |
| `U16[*]` | Frequency table — relative pitch offsets in 4096-TET space; index 0 **MUST** be 0 |

Frequency-table offsets are unsigned, so an interval-less notation that must name notes below C4 declares its lowest note in the base-note field. For an interval system the base note is the root of the root interval and the field **MUST** be 0.

Note tuning proceeds in five steps:

1. Derive "base note at C4" from the song table's tuning pair. A declaration of A4 @ 440 Hz becomes C4 @ 261.6255653 Hz.
2. The frequency at C5 is the C4 frequency times the interval size.
3. Distribute 4096 notes logarithmically between C4 and C5; this builds the frequency-offset table.
4. Apply the frequency-offset table against the base note at C4 — or the notation's own base-note field when non-zero — to construct the notation's notes.
5. Continue outside the root interval to build a complete note-to-frequency table.

A notation definition **MAY** also be stored standalone, for a notation editor to exchange:

```
Byte[8]  Magic — \x1E T a u d n o t
U8       Version — ASCII 'a'
Bytes    Notation definitions, as above
```

If your samples are already pre-tuned for your system, leave the project's tuning at the defaults; you still **MUST** specify the interval size if you are not working in octaves.

### 9.8 Reading Project Data on a device that ignores it

Nothing in Project Data is required to play a song correctly, with two exceptions that a conforming *player* **MUST** honour:

- `xHDR`, because it changes the cue stride.
- `Ixmp`, because it changes which samples an instrument plays.

Everything else is naming, display and editor state.

### 9.9 `Ixmp` — instrument extra samples

This section overlays additional samples on instruments: a keyboard map, velocity layers, per-sample envelopes, per-sample tuning, and stereo pairs. It exists to carry IT and XM instrument semantics, and partial SoundFont 2 compatibility, without widening the 256-byte base record.

The payload is a repetition of per-instrument entries:

| Type | Field |
|---|---|
| `U8` | Instrument ID, low 8 bits |
| `U16` | Number of patch records that follow |
| `U8` | bits 0…1 = instrument ID bits 8…9; bits 2…7 **RESERVED** (0) |

The two ID fields together give a 10-bit instrument ID, 0…1023 (256…1023 is the auxiliary bin). The high-ID byte was formerly the top byte of a `U24` patch count, which was always 0 for realistic counts — so a pre-2026-06-30 reader still parses legacy entries unchanged.

Two rules bound the whole section:

- Overlapping rectangles within one instrument's patch list are **INVALID**. Layered samples **MUST** use a Metainstrument instead.
- Two `Ixmp` entries naming the same instrument are **INVALID**.

### 9.10 Ixmp patch records

Patch records are **variable length**. Each begins with a version byte that is really a set of feature flags, followed by 30 common bytes, followed by whichever optional blocks the flags select.

```
0b x0s Pfpvi
```

| Bit | Flag | Selects |
|---|---|---|
| `i` (0) | — | Always set — version 1 |
| `v` (1) | volume envelopes | a `v` block |
| `p` (2) | pan envelopes | a `p` block |
| `f` (3) | filter envelopes | an `f` block |
| `P` (4) | pitch envelopes | a `P` block |
| `s` (5) | stereo / surround data | an `s` block |
| — (6) | **RESERVED** | |
| `x` (7) | extra base info | an `x` block |

**Common fields** (offsets relative to the record start):

| Offset | Type | Field |
|---|---|---|
| 0 | `U8` | Version / feature flags |
| 1 | `U16` | Pitch range start — a 4096-TET note word |
| 3 | `U16` | Pitch range end, inclusive |
| 5 | `U8` | Volume range start, 0…63 |
| 6 | `U8` | Volume range end, inclusive |
| 7 | `U32` | Sample pointer |
| 11 | `U16` | Sample length |
| 13 | `U16` | Play start |
| 15 | `U16` | Loop start |
| 17 | `U16` | Loop end |
| 19 | `U16` | Sampling rate at C4 — same encoding as base record bytes 6…7 |
| 21 | `S16` | Sample detune, in 4096-TET units (XM finetune; IT samples leave 0) |
| 23 | `U8` | Loop mode and sustain bit — identical to base record byte 14 |
| 24 | `U8` | Default pan, 0…255; **`0xFF` = no override** |
| 25 | `U8` | Default note volume, 0…255; **0 = no override** |
| 26 | `U8` | Auto-vibrato speed |
| 27 | `U8` | Auto-vibrato sweep |
| 28 | `U8` | Auto-vibrato depth |
| 29 | `U8` | Auto-vibrato rate |
| 30 | `U8` | Auto-vibrato waveform, bits 0…2; **`0xFF` = no override** |

The first four fields define a rectangle over pitch × volume space. **Patch selection walks the list in order and the first patch whose rectangle contains the trigger wins**; when nothing matches, the base record's sample fields are used unchanged. The "no override" sentinels let a converter that has no per-sample data for one axis defer to the base record.

The IT and XM formats do not define a velocity axis; those converters leave the volume range at 0…63. SoundFont does, and the velocity axis is `round(velocity × 63 ÷ 127)`.

**Block order on the wire is always `x`, `v`, `p`, `f`, `P`, `s`**, regardless of bit numbering. A decoder walks them in that order and skips any whose flag is clear. A version byte with only bit 0 set yields the legacy 31-byte record — byte-identical to pre-2026-06-13 patches.

| Block | Size | Contents |
|---|---|---|
| `x` | 15 bytes | Extra base info (below) |
| `v` | 54 bytes | LOOP word, SUSTAIN word, 25 volume envelope nodes |
| `p` | 54 bytes | LOOP word, SUSTAIN word, 25 pan envelope nodes |
| `f` | 54 bytes | LOOP word, SUSTAIN word, 25 filter envelope nodes |
| `P` | 54 bytes | LOOP word, SUSTAIN word, 25 pitch envelope nodes |
| `s` | 4 + 4 × *extra channels* | Multi-channel sample data (below) |

> Historic documentation gave the `x` block as 12 bytes. That was a transcription error: the block has always been 15 bytes, as its own field list shows. Implementations follow the field list.

The `s` block is **last** because it is the only block whose size is not fixed by the version byte — it carries one pointer per extra channel, so its length must be read from its own count byte. Putting it last keeps every other block at the offset a pre-stereo decoder expects, and a decoder that does not implement multi-channel playback need only step over `4 + 4 × cccc` bytes to stay in sync.

**The `x` block:**

| Offset | Type | Field |
|---|---|---|
| +0 | `U32` | Extra feature flags 1…32. Bit 0: 0 = the cutoff and resonance fields use ImpulseTracker units, 1 = SoundFont units |
| +4 | `U32` | Extra feature flags 33…64 — **RESERVED**, all clear |
| +8 | `U16` | Volume fadeout — same encoding as base record bytes 172…173 |
| +10 | `U16` | Default cutoff |
| +12 | `U16` | Default resonance |
| +14 | `U8` | Initial attenuation as a decibel octet; 0 = unity. Overrides the base record's byte 251 for this patch, applied as a velocity-independent gain and **not** folded into the envelope |

**Pitch versus filter envelopes.** The `f` and `P` blocks map onto the base record's two pitch/filter slots: `f` onto slot 1 (bytes 19/121/193, with `m` = filter), `P` onto slot 2 (bytes 197/201/199, with `m` = pitch). A patch **MAY** carry either, both or neither; each independently overrides the base record's corresponding role while the other role falls through. This is how SoundFont's single modulation envelope — which drives both pitch and filter cutoff at once — is represented, while IT and XM instruments use one slot and leave the other absent.

**The `s` block — multi-channel samples:**

| Offset | Type | Field |
|---|---|---|
| +0 | `U8` | `0b cccc mmmm`: `cccc` = channel count **minus one** (1 = stereo, 3 = quadraphonic); `mmmm` = channel mode |
| +1 | `U24` | Extra flags affecting the panning rule — **RESERVED** |
| +4 | `U32 × cccc` | Pool pointer for channels 2, 3, … |

Channel mode 0 is **discrete** (XY stereo, 4-track quadraphonic — each channel is its own feed); mode 1 is **matrix** (mid/side stereo, first-order ambisonic B-format — decoded before panning); 2 and above are **RESERVED**.

Every channel is a separate pool span, and the record's length, play start, loop points, sampling rate and detune describe **all** of them — so the channels are frame-aligned by construction and one voice plays the whole set with one pitch, one envelope and one loop.

A base instrument record cannot express a stereo sample, so **any stereo instrument necessarily carries an Ixmp patch**, even one whose rectangle covers the whole keyboard.

Stereo (`cccc` = 1) is the only case implemented today. In discrete mode with ordinary stereo output, each channel is fed through the engine's equal-energy pan law on its own side, which means a stereo sample whose channels are identical renders bit-for-bit like the mono sample it was made from, and the pan column behaves as a mixer balance. In matrix mode the pair is mid/side and decodes to `L = M + S`, `R = M − S` first. Surround and spatial output define their own placement rules; see the Engine Specification.

Readers other than the reference web engine currently *skip* the `s` block rather than play it; a stereo sample then sounds as its first channel.

## 10. Validity checklist

A writer producing a file that any conforming reader will accept must satisfy all of the following.

- The magic matches and the version byte names a known version and a defined container kind.
- The header's `x` bit and the presence of an `xHDR` section agree.
- `Project Data offset` is 0 if and only if there is no Project Data.
- Every song's pattern count is non-zero and its tick rate is non-zero.
- Each song's pattern bin decompresses to exactly `numPatterns × 512` bytes.
- Each song's cue sheet decompresses to a whole number of cues at the stride implied by `xHDR`.
- No pattern number in a cue exceeds `0x7FFE` except the `0x7FFF` sentinel.
- Every `Ixmp` entry names a distinct instrument, and no two patches of one instrument have overlapping rectangles.
- Every Metainstrument layer index resolves to an ordinary instrument in `0x001`…`0x3FF`.
- Envelopes carrying nodes have `P = 1` in their LOOP word.
- The two pitch/filter slots of one record do not claim the same role.

## 11. Version history

| Date | Change |
|---|---|
| 2026-04-19 | Format created |
| 2026-05-06 | Instrument record widened 192 → 256 bytes; SUSTAIN words split out from the LOOP words; `P` presence bit added; Duplicate Check moved to byte 195 |
| 2026-05-07 | Envelope minifloat rebiased so the smallest non-zero step is 1/256 s |
| 2026-05-09 | Default note volume (byte 196) split out of instrument global volume |
| 2026-06-13 | Ixmp patch records became variable-length with optional `x`/`v`/`p`/`f`/`P` blocks |
| 2026-06-15 | `.tsii` and `.tpif` container kinds |
| 2026-06-30 | Ixmp instrument IDs widened to 10 bits |
| 2026-07-01 | Format version 2: 32-channel cue sheet, 15-bit pattern numbers, 64-byte cues, two instruction words; auxiliary instrument bin ($100…$3FF); `xHDR` 64-channel mode |
| 2026-07-28 | Ixmp `s` block — multi-channel (stereo) samples |
| 2026-07-29 | Song table byte 28: the `ss` surround model flag |
