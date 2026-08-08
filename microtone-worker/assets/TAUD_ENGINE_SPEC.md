# Taud Engine Specification

This document defines the **Taud playback engine**: how a conforming implementation turns the structures of a Taud file into audio. It covers timing, pitch, the trigger path, envelopes, the sampler, filters, mixing, the spatial model and the output stage. It does **not** define the file layout (see the **Taud File Format Specification**) or the effect column (see the **Note Effects** reference); it defines everything those two documents assume.

Taud is a ScreamTracker 3-lineage tracker extended with 16-bit effect arguments and a 4096 tone-equal-temperament pitch grid. Where behaviour has an ancestor, this document names it — ImpulseTracker (via Schism Tracker's mixer), FastTracker 2 (via MilkyTracker), ProTracker, SoundFont 2 (via FluidSynth). Those lineages are the *reason* for many rules that would otherwise look arbitrary, and an implementation that follows the rule but not the lineage will drift on real songs.

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold. Lowercase uses carry their ordinary English meaning.

Arithmetic notation: `⌊x⌋` truncates toward zero, `round(x)` is round-half-away-from-zero, `x >> n` is an arithmetic right shift on a 32-bit signed integer, and `clamp(x, lo, hi)` saturates. Unless a rule says otherwise, intermediate arithmetic is IEEE 754 **binary64**; the two places where binary32 is mandatory are called out in [§12](#12-output-stage).

## 1. Model

### 1.1 Playheads

A Taud device exposes four independent **playheads**. Each owns a complete tracker state — cue position, row, tick, channel voices, background voices — and renders its own stereo stream. Synchronisation between playheads is **not** guaranteed: a song **MUST NOT** be split across playheads.

Each playhead carries the transport-scope values a song table supplies: BPM, tick rate, global volume, mixing volume, master volume, master pan, tuning, global behaviour flags and surround model.

### 1.2 Channels and voices

A song has 32 channels, or 64 when the file's `xHDR` section selects 64-channel mode. Each channel owns exactly one **foreground voice**, which is monophonic: a chord needs several channels.

Beyond the foreground voices, each playhead keeps a mixer-private pool of **background voices**, at most 64. Two things put a voice there:

- **NNA ghosts.** When a fresh note displaces a still-sounding voice, the old voice is copied into the pool and keeps ringing under the instrument's New Note Action.
- **Metainstrument layer children.** A Metainstrument trigger sounds its first matching layer on the foreground voice and every further layer as a background voice bound to that channel.

When the pool overflows, the implementation **MUST** evict the **oldest non-layer ghost**; only if every entry is a layer child does it evict the outright oldest. Layer children are protected because dropping one silences part of a chord that is still being played, whereas dropping a ghost only shortens a tail.

Background voices are not addressable from the pattern. They receive no row events; they run envelopes, fadeout, auto-vibrato and filters, and layer children additionally re-synchronise to their parent every tick ([§5.5](#5-5-metainstruments)).

### 1.3 Output

The engine renders **8-bit unsigned, stereo, interleaved** at **32 000 Hz**, which is the TSVM Audio Adapter's hardware rate and the **reference rate this document is written against**: every sample count quoted below (samples per tick, the 256-sample ramp-out, the 64-sample volume ramp) and every filter coefficient follows from it. The 8-bit dithered character is intentional and part of the format's sound; always stereo is not negotiable.

A host whose output is at another rate **MAY** run the engine at that rate instead of resampling after the output stage — the browser implementation renders 48 kHz for exactly this reason, since resampling a 32 kHz render up to the audio device's rate is a quality loss taken on every song. An implementation that does so **MUST** derive all of the following from its own rate rather than carrying the 32 kHz numbers over:

| Quantity | Rule |
|---|---|
| `samples_per_tick` ([§2.1](#2-1-ticks-and-rows)) | `rate × 2.5 ÷ bpm` |
| Playback rate ([§3.2](#3-2-playback-rate)) | `sampling_rate ÷ rate` |
| Ramp-out on sample end/cut ([§12](#12-output-stage)) | 8 ms — 256 samples at 32 kHz |
| Volume-change ramp ([§12](#12-output-stage)) | 2 ms — 64 samples at 32 kHz |
| Voice filter coefficients ([§9](#9-filters)) | `rate` in §9's formulae is the running rate, so the cutoff clamp rises with it |
| Amiga LPF / LED coefficients ([§10.4](#10-4-the-post-mix-amiga-chain)) | Recomputed at the running rate, so both corners stay at their analogue frequencies (4420.971 Hz, 3090.533 Hz) |

Rate is the one thing that is an implementation's own choice. Nothing else in this document is: a render at another rate **MUST** still reach the same row at the same moment, and the same voice at the same pitch, as the 32 kHz reference — which is what makes conformance testable against a 32 kHz oracle by running the implementation at 32 kHz.

Internally the mix bus is floating point, and the quantisation to 8 bits happens once per chunk in a defined, deterministic way ([§12](#12-output-stage)).

## 2. Time base

### 2.1 Ticks and rows

Two independent knobs set the timing, exactly as in every ScreamTracker descendant:

- **Tempo** (effect `T`, song table byte 7/8) sets the duration of one **tick**, conventionally written as BPM.
- **Speed** (effect `A`, song table byte 8) sets how many ticks make one **row** — the *tick rate*.

The tick duration is

```
tick_seconds     = 2.5 / bpm
samples_per_tick = rate × 2.5 / bpm
```

so BPM 125 gives a 50 Hz tick and, at speed 6, a 120 ms row. BPM is a 9-bit value, 25…535; the engine **MUST** clamp to that range.

Timing is accumulated **per output sample**, not per block: the engine adds 1 to a sample counter for every frame it emits, and fires a tick whenever the counter reaches `samples_per_tick`, subtracting rather than resetting so fractional remainders carry. `samples_per_tick` **MUST** be recomputed every frame, because `T` and the tempo slide can change BPM in the middle of a row. Block size is therefore not observable in the output, and an implementation **MAY** choose any block length.

### 2.2 Order of events

Per emitted frame:

1. Advance the sample counter. If it has not reached `samples_per_tick`, skip to step 5.
2. Subtract `samples_per_tick` and run the **tick pass** ([§6](#6-the-tick-pass)) for the current `tickInRow`.
3. Increment `tickInRow`. If it is still below `tick_rate + fine_pattern_delay_extra`, skip to step 5.
4. Reset `tickInRow` to 0 and **advance the row** — resolve pending jumps and pattern delays, then run the **row pass** ([§5](#5-the-row-pass)) for the new row.
5. Mix every active voice into this frame ([§10](#10-mixing)).

The consequence worth internalising: a row's events fire at the boundary that *ends* the previous row, and the row's own tick passes then run with `tickInRow` = 0…`tick_rate − 1`. Effects that act "on tick 0" therefore act on the first tick pass after their row's events, and effects that act "on ticks after the first" skip that pass.

At the very start of playback the engine runs one row pass before any frames, so row 0 sounds from the first sample.

### 2.3 Row advance

On advancing a row, in order:

1. If a **pattern delay** (`S $Ex`) is outstanding, decrement it and re-run the *same* row's row pass. Notes do not re-trigger across repetitions, but every tick-0 event does.
2. Otherwise, consume the pending jump state latched during the row:
   - A pending **order jump** (`B`) sets the cue position, sets the row to any pending row jump or 0, and resets per-pattern loop state.
   - A pending **local row jump** (`S $Bx` pattern loop) rewinds the row within the current cue, leaving the cue position alone.
   - A pending **row jump** (`C` pattern break) advances the cue, then sets the row, and resets per-pattern loop state.
3. Otherwise increment the row. If the row reaches the cue's effective row limit — 64, or fewer under a LEN or HALT-AT instruction — reset to row 0 and advance the cue.

Advancing the cue reads the cue's flow instruction: BAK moves back, FWD moves forward, JMP goes to an absolute cue, and anything else moves to the next cue. A cue carrying HALT or HALT-AT stops playback instead.

Per-pattern loop state — the `S $Bx` loop counters and the Pattern-Ditto arm state — is cleared on every cue advance.

## 3. Pitch

### 3.1 The 4096-TET grid

A note word is an unsigned 16-bit value on a grid of **4096 steps per octave**. `0x5000` is C4 (middle C) and each `0x1000` is an octave, so `0x1000` is C0 and `0xF000` is C14. Values `0x0000`…`0x001F` are sentinels ([§5.2](#5-2-note-events)); the playable range is `0x0020`…`0xFFFF`, and the engine **MUST** clamp every computed pitch into it.

One 12-TET semitone is `4096 ÷ 12` ≈ 341.33 units, and one cent is `4096 ÷ 1200` ≈ 3.41 units. Note words are not required to land on any particular grid — that is the entire point of the format — so an engine **MUST NOT** quantise them except where a command says so (glissando, `S $1x`).

### 3.2 Playback rate

A sounding voice reads its sample at

```
playback_rate = (sampling_rate ÷ rate)
              × 2 ^ ((note − 0x5000 + detune) ÷ 4096)
              × tuning_ratio
```

where `sampling_rate` and `detune` come from the voice's **active sample** — the base instrument record, or the Ixmp patch this trigger resolved to ([§5.4](#5-4-patch-resolution)). `note` is the final per-tick pitch after slides, arpeggio, vibrato and the pitch envelope.

### 3.3 Song tuning

The song table declares "note *N* sounds at *F* Hz". The engine folds that pair into a single whole-song frequency multiplier:

```
tuning_ratio = (F ÷ 2 ^ ((N − 0x5000) ÷ 4096)) ÷ 261.6255653005986
```

with the reference denominator being 12-TET concert C4. Either field reading zero means the tracker default, C9 (`0xA000`) at 8363.0 Hz, which yields ≈ 0.99892 — about 1.87 cents flat, which is what an Amiga actually does.

Two implementation requirements:

- A concert declaration (A4 @ 440 Hz) **MUST** return exactly 1.0, so that concert-tuned songs render as though tuning did not exist. This falls out naturally because 440 is representable and `440 ÷ 2^0.75` is bit-identical to the reference constant.
- The ratio **SHOULD** be computed as a pure power-of-two expression with no logarithm round trip. `2 ^ (rational)` is the one transcendental that agrees bit-for-bit across platforms in practice; routing tuning through a logarithm puts cross-implementation agreement at the mercy of a last-ulp difference.

Changing the tuning takes effect on the next tick for notes already sounding, so dialling a tuning during playback bends the song in place.

### 3.4 Tone modes

The global behaviour flags select how the coarse pitch-slide effects (`E`, `F`) and tone portamento (`G`) interpret their arguments. Every mode ultimately produces a 4096-TET note word; they differ in the space the slide steps through.

| Mode | Name | Slide space |
|---|---|---|
| 0 | Linear | The argument is added directly to the note word, in 4096-TET units per tick |
| 1 | Amiga period | The argument is subtracted from an Amiga period, per tick |
| 2 | Linear frequency | The argument is added to a frequency in Hz, per tick |

**Amiga period mode** keeps a per-voice period, seeded from the note when needed:

```
period = 428 × 2 ^ (−(note − 0x5000) ÷ 4096)
period ← max(period − argument, 1)
note   = round(0x5000 + 4096 × log2(428 ÷ period))
```

428 is the ProTracker period of C4 for a standard 8363 Hz sample on the NTSC clock. Fine slides use the same expression without persisting the period.

**Linear-frequency mode** keeps a per-voice frequency:

```
freq = 261.6255653005986 × 2 ^ ((note − 0x5000) ÷ 4096)
freq ← max(freq + argument, 1)
note = round(0x5000 + 4096 × log2(freq ÷ 261.6255653005986))
```

This mode exists for sources whose slides are literally in Hz per tick — Monotone's PC-speaker arithmetic is the motivating case.

**Tone portamento** works in linear note space in modes 0 **and** 1, and in Hz in mode 2. Amiga-mode songs therefore glide linearly in pitch even though their `E`/`F` slides step in period space; this matches the Taud command reference and is deliberate.

Whenever a portamento or a mode-crossing event changes the note word, the engine **MUST** invalidate the cached period and frequency so the next slide reseeds from the new note.

## 4. Instruments

An instrument is a sample plus envelopes, filter defaults, tuning, panning rules and note-life rules. The byte layout is in the File Format Specification; this section defines what the engine does with it.

### 4.1 The active view

At trigger time the engine takes two snapshots onto the voice, and **all later playback reads the snapshots, never the instrument record**:

- The **active sample view** — pointer, length, play start, loop start, loop end, sampling rate, detune, loop mode, the five auto-vibrato fields, and the channel count/mode/second-channel pointer of a stereo pair.
- The **active envelope view** — the volume, pan, pitch and filter envelopes with their LOOP and SUSTAIN words, plus fadeout step, filter mode, default cutoff, default resonance and initial-attenuation gain.

This indirection is what makes Ixmp patches work at all, and it is also why an NNA ghost keeps playing the patch it was sounding even after the channel has moved to another instrument. An implementation that reads the instrument record during playback will get patched instruments audibly wrong.

### 4.2 Envelope roles

The record carries two pitch-or-filter envelope slots, each self-describing via the `m` bit in its LOOP word. The engine resolves them into two named roles:

1. Start with both roles unassigned.
2. For each base slot in order, if its LOOP word's `P` bit is set, assign it to the *pitch* or *filter* role its `m` bit names. A later slot claiming a role already taken overwrites it — a record whose two slots claim the same role is invalid.
3. A patch's `P` block overrides the pitch role and its `f` block overrides the filter role, each independently. The role the patch does not carry falls through to the base record.

Volume and pan envelopes resolve the same way, patch first.

This is how a SoundFont instrument — whose single modulation envelope drives pitch and filter cutoff simultaneously — and an IT instrument — which has exactly one such envelope, either pitch or filter — coexist in one record shape.

### 4.3 Instrument-scope scalars

| Field | Effect |
|---|---|
| Instrument global volume | A continuous multiplier on every output sample of the voice. Orthogonal to the volume column and to `Mxx`/`Nxx` |
| Default note volume | Seeds the per-note volume axis at trigger, unless the row carries a volume-column SET. A stored 0 means "not present" and falls back to 63 |
| Initial attenuation | A velocity-independent amplitude multiplier from the decibel octet table. Deliberately **not** folded into the envelope, so the envelope keeps its full 0…63 resolution |
| Volume swing / pan swing | A random bias drawn **once per trigger**: `⌊random × (2·swing + 1)⌋ − swing`. Volume swing scales output by `1 + bias ÷ 255`; pan swing adds `bias` to the pan sum |
| Default pan | Applied at trigger, but only when the row carried an instrument byte **and** either the pan envelope's LOOP word has the `p` bit set or the resolved patch supplies its own pan ([§5.3.1](#5-3-1-the-default-position)) |
| Pitch-pan centre / separation | Also trigger-time, also only with an instrument byte: `pan_shift = ⌊((note − centre) ÷ 4096) × separation × 4⌋`, applied as a pan slide |
| Percussion flag | Purely advisory to editors: a retuner or transposer **MUST NOT** move this instrument's notes. The engine ignores it |

## 5. The row pass

The row pass runs once per row, per channel, in ascending channel order.

### 5.1 Per-row reset

Before interpreting the cell, the engine clears the state that is scoped to one row: the note-delay and note-cut schedules, the slide arming, arpeggio, tremor, vibrato/tremolo/panbrello activation, retrigger arming, tempo- and global-volume-slide arming, the volume- and pan-column slides, and the spatial slide. It then rebases the row volume onto the persistent note volume, and records the row's effect and argument for the columns to consult.

Everything else — note volume, channel volume, pan, envelope positions, LFO phases, effect memories — persists across rows and across patterns. That persistence is what tracker composers rely on.

### 5.2 Note events

| Note word | Action |
|---|---|
| `0x0000` | No note event; see the special cases below |
| `0x0001` | **Key off** — set the key-off state, and apply key lift if the instrument asks for it |
| `0x0002` | **Note cut** — deactivate the voice at once, and cut its layer children |
| `0x0003` | **Note fade** — begin the fadeout without releasing sustain |
| `0x0004` | **Fast fade** — begin a ≈ 0.3 s fadeout (below) |
| `0x0005`…`0x000F` | Reserved; no handler |
| `0x0010`…`0x001F` | **Interrupt** *n* — latch bit *n* of the pending-interrupt mask; no sound |
| `0x0020`…`0xFFFF` | A pitch — trigger, or retarget a portamento |

**Fast fade** exists to reproduce SoundFont *exclusiveClass* choking (a closed hi-hat silencing a ringing open one). It sets note-fading and overrides the voice's fadeout step so the decay completes in ≈ 0.3 s regardless of the instrument's own fadeout:

```
ticks = max(0.3 × bpm × 0.4, 1)
fadeout_step = clamp(round(1024 ÷ ticks), 1, 0xFFF)
```

Two cases of note word `0x0000` are **not** silent, and both matter:

- **Instrument byte plus a pitch effect** (`E`, `F` or `G`) on a channel that already has a pitch: this **triggers** the note at the voice's current pitch, so the slide has something to move. Latching the instrument and staying silent — the obvious reading — loses the note.
- **Instrument byte alone**: latch the instrument, re-resolve its patch and re-seed the note volume from its default note volume, clear key-off and note-fading and reset the fadeout — **without** retriggering the sample. ProTracker, FT2, IT and Schism all behave this way.

A pitch on a row carrying `G` (or `L`, which also takes a target) sets the portamento target instead of retriggering. If such a row also carries an instrument byte, the instrument is latched with the same no-retrigger path.

### 5.3 Trigger sequence

A fresh foreground trigger runs three steps, in this order:

1. **Duplicate Check** ([§5.6](#5-6-duplicate-check)).
2. **NNA spawn** — migrate the existing voice into the background pool ([§5.7](#5-7-new-note-actions)).
3. **Trigger** — resolve layers and patches, then start the note.

The order matters: when Duplicate Check flags the foreground voice, the ghost that step 2 spawns inherits the flagged state.

Triggering a note **MUST**:

- Cancel any running portamento target.
- Resolve the Ixmp patch and take both active views ([§4.1](#4-1-the-active-view)).
- Set the sample position to the active play start and the direction to forward.
- Reset the volume and pan envelope playheads to node 0 and snap the per-sample smoothed envelope value, so an attack lands on node 0 immediately rather than gliding into it.
- Seed the pitch and filter envelope playheads past any leading zero-duration nodes ([§7.3](#7-3-the-pitch-and-filter-walker)).
- Reset the fadeout multiplier to 1, cancel any sample-end ramp, reset auto-vibrato phase and its sweep counter, and reset the NES DPCM counter and the stereo channel's DSP history.
- Draw fresh volume- and pan-swing biases.
- Apply the instrument's default position and pitch-pan separation, if the row carried an instrument byte ([§5.3.1](#5-3-1-the-default-position)).
- Reset the filter to the active defaults and clear its delay lines.
- Seed the note volume: from the volume column's SET if present, otherwise from the instrument's default note volume if the row carried an instrument byte, otherwise leave it — a note-only retrigger inherits the channel's current note volume.
- Clear the per-note overrides (`S $73`…`S $7E` NNA and envelope toggles).
- Reset the vibrato, tremolo and panbrello LFO phases if their respective retrigger flags are set.

Channel volume is **not** reset by a trigger. It belongs to the channel, not the note.

#### 5.3.1 The default position

A trigger takes its default position from one of two places, and either is enough to make it apply:

- **The resolved patch's `default pan`**, whenever that is not the `0xFF` sentinel. A patch override needs no further permission — see below.
- **The base record**, but only when the pan envelope's LOOP word carries the `p` bit ("use default pan").

When both are available the patch wins. What the winner means depends on the song's surround model:

- **Stereo** — a pan byte: the instrument's record 177, or the patch's. Unchanged from the days before the spatial fields existed.
- **Planar or spatial** — the instrument's default **position**: a 9-bit azimuth whose low byte is that same byte 177 and whose ninth bit is record byte 14's `A` flag, plus the signed elevation in record byte 254. A planar song forces the elevation to zero.

A patch overrides the azimuth only, and only within the front arc: a patch record holds an 8-bit pan and no elevation and no ninth bit, so the instrument's height stands whichever pan wins. The pan ENVELOPE offsets the azimuth and leaves the elevation where it is.

**Why `p` does not gate the patch.** The `p` bit lives in the base record's pan envelope, and a patch may replace that envelope wholesale — its own `p` block carries its own LOOP word. Gating the patch's pan on `p` would therefore let a patch silently disable its own override, and would leave every SoundFont-derived bank centred: those base records carry no pan envelope at all, so `p` is clear, while the per-zone pan sits in each patch's byte 24. The patch's `0xFF` sentinel *is* its enable flag.

Because the ninth bit and the elevation live in bits that were previously unused and are read only in a surround song, a file written before they existed keeps its exact stereo behaviour, and its default pan lands on the front arc — which is what a pan byte has always meant.

### 5.4 Patch resolution

If the instrument carries Ixmp patches, the engine walks the list **in order** and takes the **first** patch whose pitch × volume rectangle contains the trigger. When nothing matches, the base record's fields are used unchanged. Because the first match wins, patch order is significant and a fully covered patch is dead weight.

The volume axis used for the lookup is the *pre-patch* seed: the volume column's SET if present; otherwise the instrument's default note volume if the row carried an instrument byte; otherwise the voice's current note volume. Using the post-patch volume would make the lookup depend on its own result.

**That axis is six bits in every format version.** The rectangle is instrument data, and a bank is format-neutral, so a version 3 engine **MUST** narrow its eight-bit note volume onto 0…63 (a shift right by two) before testing it — at *every* lookup, not only at the trigger. A version 3 engine that forgets on one path finds no patch there at all, since the seed a wide cell starts from is 255 and every rectangle written by an IT, XM or SoundFont converter ends at 63. The same narrowing applies to a Metainstrument's layer rectangles, which share the axis.

A patch's "no override" sentinels — default pan `0xFF`, default note volume 0, auto-vibrato waveform `0xFF` — defer to the base record field by field.

### 5.5 Metainstruments

If the trigger's instrument is a Metainstrument, the engine first **releases** the channel's existing layer children: each is detached from the parent and given its own instrument's New Note Action (note off with key lift, cut, continue, or fade).

Then it collects every layer whose rectangle contains the trigger, in record order. Under **strict layering** it additionally drops any layer whose own instrument resolves no patch at the (detuned) trigger. If nothing survives, the channel goes **silent** for this note — that is the correct outcome, not a fallback.

Otherwise the first surviving layer sounds on the foreground voice and every further layer spawns a background voice bound to this channel. Each child inherits the parent's channel volume, pan, azimuth and elevation **as they stood before the foreground layer retriggered**, carries the parent's *relative* detune, and takes its own mix gain from the decibel octet table.

The order matters: the child inherits that channel context *before* it is triggered, so its own trigger can still move it to its own default position ([§5.3.1](#5-3-1-the-default-position)). Inheriting the parent's pan afterwards would flatten every layer onto the first one's position — audible as a SoundFont kit whose layers are meant to pan apart collapsing to a point.

Every tick thereafter, a layer child re-synchronises to its parent: pitch (parent note plus relative detune), key-off, note-fading, channel volume, note volume, row volume, pan, azimuth and elevation. When the parent goes inactive the child detaches — but if the parent was *released* and its own fadeout deactivated it within the same tick, the child **MUST** inherit that release before detaching, or a chord's upper layers will ring on after the note that released them.

Layer indices are 10 bits, so layers **MAY** live in the auxiliary instrument bin, which a pattern cell cannot reach. A layer index pointing at another Metainstrument, or at instrument 0, is skipped.

### 5.6 Duplicate Check

Duplicate Check (DCT/DCA) fires on every fresh foreground trigger that carries an instrument byte, **before** the NNA spawn. It does not fire on tone portamento, on key-off, on note cut, or on an empty cell.

The values consulted belong to the **existing** voice's instrument, not the incoming note's, so two instruments sharing a channel can behave asymmetrically. Targets are the channel's foreground voice and every background voice that channel spawned; each is tested independently against the incoming (instrument, note) pair.

| Type | Matches when |
|---|---|
| 0 — off | Never |
| 1 — note | Same note word **and** same instrument |
| 2 — sample | Same instrument **and** same canonical sample, matched by pointer and length |
| 3 — instrument | Same instrument |

| Action | Effect on a matching voice |
|---|---|
| 0 — note cut | Zero the fadeout multiplier; the voice deactivates this tick |
| 1 — note off | Set key-off (releasing sustain, applying key lift, and starting the fadeout if one is configured) |
| 2 — note fade | Begin fading immediately, with no sustain release, so sample and envelope loops continue |

### 5.7 New Note Actions

When a fresh note arrives on a channel whose voice is still sounding, the old voice is copied into the background pool and the copy is treated per the New Note Action — the instrument's own, unless a per-note override (`S $73`…`S $76`) is in force.

| NNA | Behaviour |
|---|---|
| 0 — Note Off | The ghost gets key-off (and key lift), releasing sustain into its release stage |
| 1 — Note Cut | No ghost is spawned at all; the voice simply stops |
| 2 — Continue | The ghost keeps playing unchanged |
| 3 — Note Fade | The ghost begins its fadeout immediately |

The ghost copy **MUST** carry the full playback state: both active views, both filter topologies' coefficients *and* delay lines, all four envelope playheads, the fadeout multiplier, the swing biases, the auto-vibrato phase, the spatial position and the stereo channel's own DSP history. A partial copy produces a click or a wrong-sounding tail at every NNA event; copying the filter but not its history is the classic instance.

Past-note actions (`S $70`…`S $72`) act on *all* background voices a channel spawned: cut removes them outright, off releases them with key lift, fade starts their fadeout.

### 5.8 Volume and panning columns

The columns are applied after the note event and before the effect column.

- **Volume SET** writes the note volume (and rebases the row volume onto it).
- **Volume slide up/down** arms a per-tick slide for ticks after the first.
- **Volume fine** applies a one-shot delta at tick 0 — bit 5 of the value is the direction, bits 0…4 the magnitude. A value of 0 is the canonical no-op.
- **Pan SET** writes the channel pan, scaled from six bits to eight as `(v << 2) | (v >> 4)`. `S $80xx` on the same row **wins** over this.
- **Pan slides** behave like the volume slides but move the pan, and in a surround song they **wrap** the azimuth where the stereo model clamps.

The pan column's SET keeps its front-arc meaning in every surround model — six bits cannot express a full turn, and `S $8xxx` and `X` are the commands that can.

### 5.9 Pattern Ditto

Effect `7` arms a row-time repeat region on its channel: `7 $LLRR` repeats the preceding `LL` rows `RR` times, starting from the arming row. Within the region, each row is composed from the *source* row it echoes, overlaid by whatever the destination cell actually carries — a non-zero note, a non-zero instrument, a volume or pan column that is not the FINE-0 no-op, and a non-zero effect all override the echo. An echoed `7` in the source is not re-armed.

Because the region is derived at play time from the arming row, an engine that supports starting playback mid-pattern **MUST** reconstruct the arm state by replaying the raw rows from row 0 up to the start row; otherwise ghost rows are silent when seeking into a region.

## 6. The tick pass

The tick pass runs once per tick, per voice, and is where everything continuous happens. For each foreground voice, in order:

1. **Scheduled note cut** (`S $Cx`): if this is the scheduled tick, zero the note and row volume — leaving channel volume alone — and mark the note cut.
2. **Note delay** (`S $Dx`): if this is the scheduled tick, perform the deferred event. For a pitch, that means the full trigger sequence of [§5.3](#5-3-trigger-sequence). **The instrument binding MUST be re-read afterwards** — the trigger may have swapped the voice's instrument, and the rest of this tick must see the instrument that just fired.
3. **Scheduled follow-up action** (`S $Dxny`): if this is the scheduled tick, apply note off, note cut, continue, note fade or forced key lift. Forced key lift bypasses the instrument's own key-lift flag, exactly as `S $73`…`S $76` bypass its NNA.
4. If the voice is inactive, advance its volume envelope anyway and move on — an inactive voice still needs its envelope walked so that a re-trigger or a scheduled event sees a coherent state.
5. **Pitch slides** (`E`, `F` coarse) on ticks after the first, in the current tone mode.
6. **Tone portamento** on ticks after the first: step toward the target and stop exactly on it, in note space or Hz space per the tone mode.
7. **Volume slides** — the effect-column coarse slide and the volume-column slides — on ticks after the first.
8. **Channel-volume slide** (`N`) and **pan-column slides**, on ticks after the first.
9. **Spatial slide** (`Z`) on ticks after the first ([§11.5](#11-5-the-z-slide)).
10. **Tremor** (`I`): advance the on/off phase counter; while off, force the row volume to 0.
11. **Vibrato** (`H`, `U`): `delta = (lfo × depth) >> shift`, where the shift is 6 for `H` and 8 for `U` — the finer of the two. The result overlays the note for this tick only; the underlying note word is untouched. Phase advances by `speed × 4`, modulo 256.
12. **Glissando** (`S $1x`): snap the *sounding* pitch to the nearest 12-TET semitone while leaving the note word smooth.
13. **Tremolo** (`R`): `row_volume = clamp(note_volume + ((lfo × depth) >> 9), 0, 63)`.
14. **Panbrello** (`Y`): `row_pan = clamp((channel_pan >> 2) + ((lfo × depth) >> 9), 0, 63)`.
15. **Arpeggio** (`J`): the tick index modulo 3 selects offset 0, the first argument byte or the second, each shifted left 8 bits (one argument byte is 256 units ≈ 0.75 semitones). This *overrides* the sounding pitch for the tick.
16. **Retrigger** (`Q`): count ticks and, on reaching the interval, restart the sample at the active play start, clear key-off, reset all four envelope playheads (re-seeding the pitch and filter ones past zero-duration nodes), reset the fadeout, auto-vibrato and filter history, and apply the retrigger volume modifier.
17. **Auto-vibrato** ([§6.1](#6-1-auto-vibrato)), added on top of the sounding pitch.
18. **Pitch envelope** contribution ([§7.4](#7-4-pitch-and-filter-envelope-application)).
19. Compute the final pitch, clamp it to `0x0020`…`0xFFFF`, and update the playback rate.
20. **Filter envelope** applied to the cutoff, then refresh the filter coefficients if cutoff or resonance changed.
21. **Fadeout**: while key-off or note-fading, subtract `fadeout_step ÷ 1024` from the fadeout multiplier, clamped at 0; at 0 the voice deactivates. A `fadeout_step` of 0 never fades.
22. **Advance the volume and pan envelopes**, then set the per-sample envelope slope for the coming tick.
23. **Advance the pitch and filter envelopes**.

Then, once per tick at playhead scope: the tempo slide, the global volume slide, and the funk-repeat mask advance. Finally the background voices run their own reduced pass — layer-child re-synchronisation, all four envelopes, fadeout, auto-vibrato, pitch and filter envelopes, coefficient refresh — and fully faded ghosts are reaped.

### 6.1 Auto-vibrato

Auto-vibrato is instrument-scope (or patch-scope) and independent of the `H` command. Its depth ramps in from zero over the note's life, in whichever of the two source conventions the instrument carries:

```
if sweep ≠ 0:   ramp = min(⌊depth × t ÷ sweep⌋, depth)     (FT2: ticks to full)
elif rate ≠ 0:  ramp = min((t × rate) >> 8, depth)          (IT: ramp acceleration)
else:           ramp = depth
```

with `t` the ticks since the trigger. The pitch delta is `(lfo × ramp) >> 10`, and the phase advances by `speed × 2` modulo 256. Waveform 4 (ramp up, FT2 only) is the negation of waveform 1.

### 6.2 The LFO

Vibrato, tremolo, panbrello and auto-vibrato share one waveform generator over an 8-bit phase accumulator. The table index is `(phase >> 2) & 63`.

| Waveform | Value |
|---|---|
| 0 — sine | A 64-entry signed sine table, amplitude ±0x7F |
| 1 — ramp down | `0x7F − (index << 2)` |
| 2 — square | `+0x7F` for the first half of the cycle, `−0x7F` for the second |
| 3 — random | A fresh uniform byte, biased to −0x80…+0x7F |

Waveform 3 is genuinely random and is the reason some songs never render bit-identically twice ([§13](#13-determinism)).

## 7. Envelopes

Each envelope is 25 nodes of (value, duration). Durations are 3.5 minifloat indices; **a duration of 0 is a terminator**, not an instant transition — except in the pitch and filter walker, where it *is* an instant transition. That asymmetry is deliberate and is the single most commonly mis-ported rule in this specification.

### 7.1 Wrap resolution

Every tick, for every envelope, the active wrap region is resolved from the LOOP and SUSTAIN words and the key state:

1. SUSTAIN enabled **and** key on → wrap between sustain start and sustain end.
2. Otherwise LOOP enabled → wrap between loop start and loop end.
3. Otherwise → no wrap.

A wrap region whose start equals its end **holds** at that node (the FT2 single-point sustain). Sustain therefore takes precedence while the key is on; once the key is released the LOOP region becomes active and can capture the playhead as it walks into range.

### 7.2 The volume and pan walker

For the volume envelope — evaluated whenever the voice's volume-envelope toggle is on, regardless of any wrap bits — and the pan envelope, which additionally requires its `P` presence bit:

- If wrapping and the playhead is at the wrap end with start equal to end: hold, taking the node's value.
- If wrapping and the playhead is at the wrap end: reset the time carry, jump to the wrap start, take that node's value.
- If the playhead is at node 24: take node 24's value.
- If the current node's duration is 0: **freeze** here and take its value.
- Otherwise: accumulate the tick into the time carry; when it passes the node's duration, subtract the duration and step (to the wrap start if wrapping at the end, else to the next node, capped at 24). Between nodes, the value is linearly interpolated on the time fraction.

Volume values scale as `clamp(value ÷ 63, 0, 1)`; pan values as `value ÷ 255`.

**The cut rule.** When the volume envelope freezes at a node — either the terminator case or arrival at node 24 — *and* that node's value is 0 *and* no wrap is active, the engine **MUST** start the voice's ramp-out. Without this, instruments with a stored fadeout of 0 and an envelope ending at 0 hold their voices forever.

### 7.3 The pitch and filter walker

The pitch and filter envelopes use a different walker, and the difference is not cosmetic:

- Zero-duration nodes are **skipped**, not frozen. The walker advances past any run of them until it reaches a node with a duration, a sustain boundary, or node 24.
- Wrap handling is otherwise as in [§7.1](#7-1-wrap-resolution), with the same hold-at-a-point behaviour.
- Values scale as `value ÷ 255`, with **0.5 as unity**.

At note-on (and on a `Q` retrigger) the playhead is **seeded** by running the walker once with a zero tick, which settles it past any leading zero-duration nodes. An engine that seeds at node 0 without settling will play a SoundFont-derived attack a step behind.

### 7.4 Pitch and filter envelope application

The pitch envelope's contribution is ±16 semitones at full scale:

```
pitch_delta = ⌊(value − 0.5) × 2 × 16 × 4096 ÷ 12⌋
```

The filter envelope scales the cutoff, with 0.5 as unity at the instrument's default cutoff:

```
IT units:  base = (default_cutoff < 255)    ? default_cutoff : 254
           cutoff = clamp(⌊base × value⌋, 0, 254)
SF units:  base = (default_cutoff < 0xFFFF) ? default_cutoff : 13500
           cutoff = clamp(⌊base × value⌋, 0, 0xFFFF)
```

Background voices apply both identically — and **MUST** branch on the filter mode in the same way, or SoundFont ghosts will be filtered as though their cents were IT bytes.

### 7.5 Key lift

An instrument with the key-lift flag treats key-off as a true MIDI key release: the volume envelope playhead jumps straight to the sustain-end node, so the release nodes play at once instead of the playhead first walking the remaining pre-sustain nodes. It applies wherever key-off is delivered — the pattern key-off word, an NNA ghost's release, a Duplicate Check note-off, and past-note off. Instruments with no volume-envelope sustain region are unaffected, since there is no release boundary to jump to.

## 8. The sampler

### 8.1 Reading a sample

Sample data is unsigned 8-bit with `0x80` as zero; a byte converts to `(b − 127.5) ÷ 127.5`. Reads clamp the index into the sample and clamp the pool address into the 8 MiB pool, so a malformed pointer cannot read out of bounds.

If the instrument has an active **funk-repeat** mask ([§8.4](#8-4-funk-repeat)) and a non-empty loop region, a byte inside the loop whose mask bit is set is XOR-ed with `0xFF` before conversion.

### 8.2 Loop modes

After each output sample the position advances by the playback rate, then:

| Mode | Behaviour on reaching the end |
|---|---|
| 0 — none | Clamp to the last sample and start the ramp-out |
| 1 — forward | Subtract the loop length (at least 1) from the position |
| 2 — ping-pong | Clamp to the loop end and reverse direction |
| 3 — one-shot | As mode 0 |

While playing backwards, the position decreases; on falling below the loop start it clamps there and reverses forward again.

A **sustain loop** (loop-mode bit 2) is a loop only while the key is held: once key-off arrives, the effective loop mode becomes 0 and the voice plays out to the sample end. This is how a sustain-looped instrument releases naturally.

### 8.3 Interpolation

The interpolation mode comes from the global behaviour flags and applies to every voice.

| Mode | Algorithm |
|---|---|
| 0 — default | Windowed sinc: a Hann-windowed sinc kernel over ±3 taps, tabulated at 1024 sub-sample positions and linearly interpolated between table entries |
| 1 — none | Zero-order hold — take the sample under the integer position |
| 2 — Amiga 500 | Zero-order hold, plus a post-mix one-pole low-pass at 4420.971 Hz and the optional LED filter |
| 3 — Amiga 1200 | Zero-order hold, plus the optional LED filter only: the A1200's own one-pole sits at ~34 kHz, above Nyquist at any rate the engine runs at, and is bypassed |
| 4 — SNES | The SPC700's 4-tap Gaussian, run over the DSP's signed **15-bit** sample domain (`-0x4000`…`+0x3FFF`) as the hardware does. Its partial overflow handling is preserved: of the three tap additions the second is allowed to wrap and only the third saturates, so the ROM table's bugged `0x801` phases still "chirp" exactly where the hardware does — a run of max-negative samples reads back as `+0x3FF8`. Promoting the samples to 16 bits instead makes the mid-sum wrap on *all* content past half scale, which folds loud waveforms inside out and doubles everything else |
| 5 — NES DPCM | A 1-bit sigma-delta simulation: a 7-bit counter slews ±2 toward the target level per output sample |

The Amiga LED filter is a second-order section at 3090.533 Hz with Q = 0.660225, toggled by `S $00` / `S $01` and applied to the **stereo mix**, not per voice. It is available only in the two Amiga modes.

SNES and NES DPCM modes carry per-voice state (the DPCM counter), and a stereo voice keeps a separate counter per channel.

### 8.4 Funk repeat

`S $Fx` engages ProTracker's "funk repeat": a per-instrument bit mask over the loop region, advanced once per tick by an accumulator. When the accumulator passes `0x80` it resets and toggles the mask bit at the current write position, which then advances cyclically through the loop. Sample bytes whose mask bit is set read inverted. The write position resets on a fresh trigger; the speed and accumulator persist.

The loop the mask covers is the **active** one — an Ixmp patch replaces the base record's loop points, and the mask is sized and indexed against whichever loop the voice is actually sounding.

The mask is instrument-scope runtime state and **MUST** be cleared on a transport reset, or a replay will start from a scrambled sample.

### 8.5 The sample-end ramp

When a voice reaches the end of a non-looping sample, or the volume envelope's cut rule fires, the engine engages an **8 ms linear ramp-out** (256 samples at the reference rate) rather than stopping instantly. During the ramp the sample position is held and the emitted value decays to zero, and the voice deactivates when the ramp completes. Re-engaging a ramp already in progress is a no-op, and a fresh trigger cancels any pending ramp so an attack is never muted by a stale one.

## 9. Filters

Two topologies, both mandatory. Which one a voice uses is decided by its instrument's (or patch's) filter mode.

Coefficients are recomputed only when cutoff or resonance has changed since the last refresh, which is checked once per tick.

### 9.1 The ImpulseTracker filter

A resonant **all-pole** 2-pole low-pass — no feedforward terms. This is not an approximation of the IT filter; it is the topology tracker playback needs to sound byte-faithful.

Cutoff 255 or above turns the filter off entirely. Otherwise, with `nyquist = 15999`:

```
c = clamp(cutoff, 0, 254) × 0.5                      → 0…127
r = (resonance ≥ 255) ? 0 : clamp(resonance, 0, 254) × 0.5
f = min(110 × 2 ^ (c ÷ 24 + 0.25), nyquist)
d = 10 ^ ((−r × 24 ÷ 128) ÷ 20)
R = rate ÷ (2π f)
D = d·R + d − 1
E = R²
a0 = 1 ÷ (1 + D + E)
b0 = (D + 2E) ÷ (1 + D + E)
b1 = −E ÷ (1 + D + E)
```

The recurrence, with the history taps clipped to ±2.0 (OpenMPT's `ClipFilter`, which keeps the resonant section from blowing up on pathological input):

```
y[n] = a0·x[n] + b0·clamp(y[n−1], ±2) + b1·clamp(y[n−2], ±2)
```

### 9.2 The SoundFont filter

FluidSynth's RBJ biquad, with cutoff in absolute cents and resonance in centibels above the DC gain. Cutoff `0xFFFF` or above turns the filter off.

```
fc  = clamp(8.176 × 2 ^ (cutoff ÷ 1200), 5, 0.45 × rate)
qdB = clamp(resonance_cB ÷ 10, 0, 96) − 3.01          (0 cB ⇒ Butterworth)
Q   = max(10 ^ (qdB ÷ 20), 0.001)
ω = 2π·fc ÷ rate ,  α = sin ω ÷ (2Q) ,  a0inv = 1 ÷ (1 + α)
gain = a0inv ÷ √Q                                      (SF2 §2.01 gain normalisation)
b1  = (1 − cos ω) × gain ,  b02 = b1 ÷ 2
a1  = −2 cos ω × a0inv   ,  a2  = (1 − α) × a0inv
y[n] = b02·(x[n] + x[n−2]) + b1·x[n−1] − a1·y[n−1] − a2·y[n−2]
```

Direct Form I, unclamped — the gain normalisation bounds it. The −3.01 dB offset is what makes a SoundFont's declared Q = 0 cB come out Butterworth.

### 9.3 Runtime overrides

Effects `5` and `6` set an instrument-wide cutoff or resonance override, targeting the channel's instrument and every layer child's instrument. An argument of `$FFFF` clears the override. In IT mode the high byte is taken; in SoundFont mode the full 16 bits are. Overrides are runtime state and **MUST** be cleared on a transport reset.

An override is **absolute and instrument-wide**: while one is in force every voice of that instrument takes it, decoded and applied in the *instrument's* filter mode, whatever patch the voice resolved. Clearing it returns each sounding voice to **its own** default — the value in its patch's `x` block when it has one, the base record's otherwise. Dropping every voice onto the base record instead would retune a patched voice's filter, and where the patch and the base record disagree on SoundFont-versus-IT mode it would reinterpret the stored number in the wrong units.

## 10. Mixing

### 10.1 Voice effects

Before the mixer sees a sample, two per-voice effects may act on it, in this order:

1. **Overdrive** (`9`): multiply by `(16 + amount) ÷ 16`, then clip.
2. **Bitcrusher** (`8`): with a depth of 1…7, quantise to `2^depth − 1` levels; with a non-zero skip, hold the sample for `skip + 1` output samples.

Both share a **clip mode**: 0 clamps to ±1, 1 folds (a triangle characteristic), 2 wraps (a sawtooth characteristic). Fold and wrap are what give the effect its character; a plain clamp is the conservative choice.

For a stereo voice the parameters are shared but the crusher's hold state is per channel.

### 10.2 The gain chain

Per voice, per frame:

```
per_voice = envelope_volume            (1.0 when the volume envelope is toggled off)
          × fadeout_multiplier
          × current_mix_volume         (the ramped row × channel volume)
          × (1 + volume_swing_bias ÷ 255)
          × instrument_global_volume ÷ 255
          × (255 − fader) ÷ 255
          × layer_mix_gain
          × initial_attenuation_gain

global    = (song_global_volume ÷ 255) × (mixing_volume ÷ 255) × master_volume ÷ 255

sample_out = sample × per_voice × global × pan_gain × ramp_gain
```

`current_mix_volume` chases `(row_volume ÷ 63) × (channel_volume ÷ 63)` over a **2 ms linear ramp** (64 samples at the reference rate), which is what keeps volume-column edits from clicking. A fresh trigger **snaps** it instead of ramping, so attacks are not softened.

The envelope volume is likewise smoothed per sample: at each tick the engine computes a slope `(new_envelope_value − current) ÷ samples_per_tick` and adds it once per frame. Without this, a 50 Hz envelope staircase is audible on sustained material.

The **fader** is a host-owned 256-step attenuator per channel (0 = unity, 255 = muted) used for mute and solo. Muting a channel **MUST** also silence the ghosts and layer children it spawned: a background voice's effective fader is the larger of its own and its source channel's.

### 10.3 Panning

In the stereo model, an equal-energy law:

```
pan   = clamp(channel_pan + envelope_pan_offset + pan_swing_bias, 0, 255)
left  = cos(π · pan ÷ 512)
right = sin(π · pan ÷ 512)
```

where `envelope_pan_offset` is `clamp(round(env_pan × 255), 0, 255) − 128` when the pan envelope is present and enabled, and 0 otherwise. There is no runtime choice of panning law.

For the planar and spatial models, see [§11](#11-the-spatial-model).

### 10.4 The post-mix Amiga chain

In Amiga 500 mode the stereo mix passes through a one-pole low-pass:

```
state ← mix × a0 + state × b1,   b1 = e^(−2π × 4420.971 ÷ rate),  a0 = 1 − b1
```

In both Amiga modes, when the LED filter is on, the mix additionally passes through the 3090.533 Hz second-order section. These act on the mix, after every voice has been summed.

## 11. The spatial model

The engine's spatial model is **object-based**: a sounding voice is a source with a direction and a gain, and the mixer knows nothing about output channels. A **renderer** turns those objects into bus channels, so an output format is always a render *target*, never something the engine holds. Playback installs a stereo renderer; an export installs whatever the chosen format wants and re-renders the same song through the same mixer.

The Kotlin reference engine does not implement this yet; the web engine is the reference implementation for this section.

### 11.1 Surround models

The song table's immutable `ss` flag selects one of three models, and it is immutable because it changes what the pan column *means*.

| Model | Meaning |
|---|---|
| 0 — stereo | The legacy two-accumulator path. The object bus is not allocated at all |
| 1 — planar | 360° panning on the horizon; elevation is forced to zero |
| 2 — spatial | The full sphere |

A planar or spatial song that uses only ordinary pan **MUST** render bit-identically to the same song in stereo mode. The stereo renderer therefore reuses the mixer's own `cos`/`sin` expression, and the object bus preserves the stereo path's factor order and accumulates in binary64. This is not an optimisation detail; it is the compatibility guarantee that lets a song change model without changing sound.

### 11.2 Angles

**Azimuth** is the 9-bit angle of the extended `S $8xxx` command: 512 units to a full turn, 0 = left, 128 = front, 256 = right, 384 = behind, increasing **clockwise** seen from above. Its low 8 bits are exactly the legacy pan byte, so pan `$00` / `$80` / `$FF` still mean left / centre / right and every ordinary pan write lands on the front arc.

**Elevation** is effect `X`'s signed byte: 128 units to 90°, −128 below, +127 ≈ above.

Both are continuous doubles, because the `Z` slide moves through them smoothly. Direction vectors use the AmbiX axes: +x front, +y left, +z up.

Two folds matter and are **not** the same operation:

- **Audible downmix.** A full-circle azimuth folds onto the pan byte by *mirroring* the rear arc onto the front: two speakers cannot render front versus back, so the left–right axis is kept and the other dropped. The mapping is the identity on the front arc, which is what makes ordinary pan behave identically in every model.
- **Position display.** The orthogonal projection onto the listener's left–right axis, `−cos(elevation) × sin(azimuth)`, is the *shadow* a source casts on that line: overhead and directly-behind both read centre. A channel-header pan strip draws this, which is why it lines up with a radar dot above it.

### 11.3 The stereo renderer

Sources on the front arc hit the legacy pan law exactly. Behind the listener the image folds forward; elevation collapses it toward the centre, so at ±90° a source is dead centre — the only choice that stays continuous at the poles.

```
p    = fold_to_pan(azimuth)
pan  = (elevation = 0) ? p : 128 + (p − 128) × cos(elevation)
left = cos(π·pan ÷ 512),  right = sin(π·pan ÷ 512)
```

### 11.4 Multi-channel samples

A multi-channel sample is **not** a set of speaker feeds. Each channel is placed as its own source, at an ITU-style angle offset from the source's own direction, as a rigid body aimed at the source — so a stereo pair keeps its 60° width however high the source flies, instead of collapsing at the poles the way a plain azimuth offset would.

| Channels | Offsets from the source direction (WAV channel order) |
|---|---|
| 1 | 0° |
| 2 | −30°, +30° (BS.775's equilateral triangle) |
| 4 | −30°, +30°, −110°, +110° |
| 6 | −30°, +30°, 0°, 0°, −110°, +110° |
| 8 | −30°, +30°, 0°, 0°, −90°, +90°, −135°, +135° |

Only mono and stereo are reachable today, since the sampler plays at most two pool spans; the placement *rule* is what this section pins down.

In the **stereo** model, multi-channel samples take a simpler path: each channel goes through the equal-energy pan law on its own side, so a stereo sample whose channels are identical renders bit-for-bit like the mono sample it was made from, and the pan column behaves as a mixer balance — hard left silences the right channel. A matrix-mode (mid/side) pair decodes to `L = M + S`, `R = M − S` **before** the filter and the voice effects, so those act on speaker feeds.

### 11.5 The `Z` slide

`Z` rotates a source toward the target set by effect `4`, along the **great circle**, at constant angular velocity — a spherical linear interpolation — by at most `argument ÷ 16` azimuth units per tick (the argument is in effect `X`'s units, which are half the engine's).

Identical directions do nothing. **Antipodal** directions, where the great circle is undefined, take the clockwise path, matching effect `P`'s rule; if the source is straight up or down, the rotation goes through its own azimuth instead.

### 11.6 Ambisonic rendering

The reference ambisonic renderer encodes to real spherical harmonics up to order 3, **SN3D normalised and ACN ordered** — the AmbiX convention. A `planar` variant keeps only the **sectoral** harmonics (`|m| = l`), giving 7 channels at order 3 instead of 16.

That variant is an internal scene basis, **not** a file layout: a written AmbiX file **MUST** carry the complete `(order + 1)²` set, encoded from the full basis. Zero-filling the channels the planar variant drops would be a different scene, because a horizontal song still excites the zonal harmonics — ACN 6 is `(3z² − 1) ÷ 2 = −½` at ear level, not zero.

Its stereo monitor decode is the classic coincident cardioid pair at ±90°: `L = (W + Y) ÷ 2`, `R = (W − Y) ÷ 2`.

### 11.7 Other render targets

Everything below is a render *target* in the sense of §11: the same song, the same mixer, a different renderer. None of it changes what a file means, so an implementation **MAY** offer any subset — but where it offers one of these, these are the rules.

**Speaker layouts.** Sources pan pairwise around the horizontal ring — constant power between the two speakers that bracket the azimuth, exact at every speaker — at the BS.775 / BS.2051 angles (±30° front pair, centre ahead, ±110° surrounds; 7.1 splits those into ±90° sides and ±135° rears). Elevation, which no such layout can reproduce, blends the source toward an even spread over the ring as it climbs, reaching fully diffuse at the poles: level-preserving and continuous, the n-speaker generalisation of the stereo fold's collapse toward the centre. The LFE channel receives **nothing**; there is no bass-management stage defined here.

**Binaural monitoring.** An implementation **MAY** monitor a surround song through a head model so that elevation and front/back are audible on headphones — without it, composing a height is composing something the composer cannot hear. It is a *monitor*, not a rendering rule: the stereo output an implementation writes or plays by default is still the fold of §11.3, and nothing about a file depends on the head model chosen. The reference implementation pans the objects onto a fixed ring (planar) or sphere (spatial) of virtual speakers and applies a per-speaker head model to those feeds — a Woodworth interaural delay applied below ~1.1 kHz, a Brown & Duda head-shadow shelf, and a direction-dependent pinna notch and shelf — each speaker's feed scaled so that both ears together carry the same power the pan law would have given.

## 12. Output stage

The mix accumulates in binary64 and then passes through a defined narrowing:

1. Convert each channel's frame to **binary32**, then clamp to ±1.0 **in binary32 space**. Clamping before narrowing gives different results at the boundary.
2. Store into a binary32 mix bus.

Quantisation to 8 bits is **noise-shaped dither**, per channel, with second-order error feedback:

```
feedback = 1.5 × e[n−1] − 0.75 × e[n−2]
dither   = 0.2 × (u1 − u2)                     u1, u2 uniform in [0,1)
shaped   = clamp(x + feedback + dither ÷ 127.5, −1, 1)
q        = clamp(round(shaped × 127.5), −128, 127)
out      = (q + 128) & 0xFF
e[n]     = shaped − q ÷ 127.5
```

Every arithmetic step in this loop **MUST** be evaluated in binary32, and the dither source **MUST** be the engine's own seeded generator, not the host's. Together those two rules are what make 8-bit output reproducible across implementations.

The uniform values are drawn as `(xorshift32() & 0xFFFFFF) ÷ 16777216`, which is exact in binary32.

## 13. Determinism

The engine has two random streams, and they serve opposite purposes.

- **The dither PRNG** is a 32-bit xorshift seeded to a constant per engine instance. It is deterministic by design: two runs of the same song produce byte-identical 8-bit output.
- **The musical randomness source** backs the random LFO waveform and the per-trigger volume and pan swing. In production it is the host's uniform generator, so a song using volume swing sounds slightly different on every play — which is what swing is *for*.

An implementation **MUST NOT** call the host's random generator directly from engine code; both streams **MUST** be injectable, or conformance testing against a reference render becomes impossible. A song that uses neither swing nor the random waveform renders deterministically.

Under those conditions, and with the numeric rules of [§12](#12-output-stage), independent implementations agree **bit-for-bit** — both on the pre-dither float bus and on the dithered 8-bit output. That is the conformance bar this specification sets, and it is met in practice: the JavaScript and Kotlin engines match exactly across the reference corpus.

## 14. Interrupts and the host interface

Note words `0x0010`…`0x001F` are **interrupt markers**: they produce no sound and have no built-in behaviour. Processing one latches bit *n* in the playhead's pending-interrupt mask.

The host drains the mask with a **read-to-acknowledge** call that returns and clears it. Latching accumulates, so no fire is lost between drains, but repeated fires of the same interrupt between two drains collapse into one bit — the semantics are edge-triggered and level-collapsed. A host dispatches its own callbacks from the drained mask.

Interrupts are how a song drives something outside itself: lighting cues, subtitle timing, game events.

## 15. Transport reset

A transport reset restores a well-defined starting state, and getting its scope right prevents a family of "mysteriously lingering" bugs.

A **full reset** sets BPM 125, tick rate 6, global and mixing volume `0x80`, clears the tuning, restores the tone and interpolation modes from the file's global behaviour flags, re-installs the surround model, clears the Amiga filter states, deactivates every voice, empties the background pool, clears every per-voice effect and envelope state, and clears the per-instrument runtime state (funk masks and filter overrides).

A **play-from-row** reset is narrower and deliberately so: it resets row, tick and jump state, deactivates every voice, **empties the background pool**, clears the per-channel pattern-loop and Ditto state, and reconstructs the Ditto arm state for the starting row — but leaves tempo and volumes alone, because a replay must keep the song's tempo.

Emptying the background pool is the part that is easy to omit and audible when omitted: a stop leaves ghosts active, and a replay resumes them.

## 16. Effects

The effect column is specified in full in the **Note Effects** reference, including per-effect memory cohorts, recall rules and the conversion tables for ProTracker, ScreamTracker 3, FastTracker 2 and ImpulseTracker sources. This document defines only the machinery those commands drive.

Opcodes are base-36 digit values: `0`…`9` are `0x00`…`0x09` and `A`…`Z` are `0x0A`…`0x23`. A few carry engine-scope rather than voice-scope meaning and are worth naming here:

| Opcode | Scope | Engine effect |
|---|---|---|
| `1` | Playhead | Set the global behaviour flags — tone mode and interpolation — from the argument's high byte |
| `5` / `6` | Instrument | Cutoff / resonance override, `$FFFF` to clear |
| `7` | Channel, row-time | Pattern Ditto ([§5.9](#5-9-pattern-ditto)) |
| `8` / `9` | Voice | Bitcrusher / overdrive ([§10.1](#10-1-voice-effects)) |
| `A` / `T` | Playhead | Tick rate / tempo |
| `B` / `C` | Playhead | Order jump / pattern break, both resolved at row end |
| `V` / `W` | Playhead | Set / slide the song global volume |
| `4` / `X` / `Z` | Voice | Spatial target, position and slide — ignored entirely in a stereo song |

## 17. Conformance summary

An implementation conforms when all of the following hold.

- Timing is accumulated per sample, with `samples_per_tick` recomputed every frame, so block size is not observable.
- Row events fire at the row boundary and the row's tick passes then run with tick indices 0…`tick_rate − 1`.
- All playback state reads the trigger-time active views, never the live instrument record.
- The volume and pan envelope walker freezes on zero-duration nodes; the pitch and filter walker skips them, and seeds settle past leading ones.
- The volume envelope's cut rule fires on a zero-valued terminator with no active wrap.
- NNA ghosts carry the complete voice state, including both filter topologies' delay lines.
- Duplicate Check runs before the NNA spawn and consults the *existing* voice's instrument.
- A note delay's trigger re-binds the instrument for the remainder of that tick.
- Sample ends and envelope cuts ramp out over 8 ms; volume changes ramp over 2 ms, and a trigger snaps rather than ramps.
- A planar or spatial song that uses only ordinary pan renders bit-identically to the stereo model.
- The output stage narrows to binary32 before clamping, and runs the dither loop entirely in binary32 against a seeded generator.
