# Microtone User Manual

**Microtone** is a microtonal music tracker for the TSVM **Taud** format that
runs entirely in your browser. There is no server component: your files never
leave your machine, projects are stored in the browser's private storage, and
even MIDI/module conversion happens locally. The audio engine is a faithful
port of the TSVM Taud engine — a ScreamTracker 3-lineage tracker extended with
16-bit effect arguments and a 4096-tone-equal-temperament pitch grid, rendering
32 kHz stereo 8-bit audio (the dithered 8-bit character is intentional).

> Press **?** in the app (or the **?** button in the top bar) at any time for a
> compact keyboard reference. The full effect-command specification lives in
> the **Note Effects** document in the sidebar.

## Introduction

### Tracker concepts

If you have used Impulse Tracker, Schism Tracker or OpenMPT, you will feel at
home. If not, here is the vocabulary this manual uses:

| Term | Meaning |
|---|---|
| **Channel / voice** | One monophonic playback lane. A song has 32 or 64 channels. |
| **Pattern** | A 64-row grid of cells for **one** channel. Unlike most trackers, a Taud pattern is single-channel. |
| **Row** | One line of a pattern. Each row holds a note, an instrument, a volume, a pan and an effect. |
| **Tick** | The engine's time slice. Each row lasts *speed* ticks; effects update per tick. |
| **Cue** | One entry of the song's order list: for every channel, which pattern plays next, plus optional flow commands (jump, halt, length…). A song is a sequence of cues. |
| **Instrument** | A playable definition: a sample plus envelopes, filter, panning, NNA rules — or a *metainstrument* layering several others. |
| **Sample** | Raw 8-bit audio data in the shared sample pool. Several instruments may use the same sample. |
| **Note word** | A 16-bit pitch value; see the pitch system below. |

### The pitch system: 4096-TET

Every note is a 16-bit word on a grid of **4096 steps per octave** — fine
enough to represent any practical tuning. `0x5000` is middle C (C4) and each
`0x1000` is one octave. Values `0x0000`–`0x001F` are reserved for sentinels
(key-off, note cut, fades) and interrupts.

You almost never type raw note words. Instead each song carries a **pitch
table** (a notation preset such as 12-TET, 19-TET, 31-TET, Bohlen-Pierce…)
and the editor snaps entry, display and stepping to that table's degrees. See
[Microtonality in depth](#microtonality-in-depth).

## Getting started

### Opening and creating projects

- **Drop a file anywhere** on the window, or use **Open…** in the top bar. Native formats: `.taud` (full project), `.tsii` (sample+instrument bank), `.tpif` (pattern file that loads over a bank). Tracker modules (`.mod`, `.s3m`, `.xm`, `.it`, `.mon`) are converted on the fly.
- **Import MIDI…** converts a `.mid` file through a SoundFont — see [Importing music](#importing-music).
- **New…** opens the New Project wizard, which collects every song setting before the blank project is built:
  - **Tempo** — BPM (25–535) and speed (ticks per row, 1–127), with a live *blinkenlights* strip previewing the feel of that tempo.
  - **Meter** — a time signature and rows-per-beat. These set the two beat divisors (rows/beat and the derived rows/bar) that colour the row highlighting; the **Row highlight** preview shows exactly how the Timeline gutter will band.
  - **Tuning** — the reference base note (C4 or A4) and its frequency.
  - **Metadata** — song name, composer and copyright.
  - **Layout** — 32 or 64 channels.
  - **Notation** — the display pitch table (12-TET, 24-TET, 31-TET, Bohlen-Pierce…), defaulting to **24-TET**. You can change it later in the Project view.

  A new project has no samples — seed it by opening a `.tsii` bank first, or add instruments later from the Instruments view.

The app warns before discarding unsaved changes, and autosaves your work — see
[Saving and autosave](#saving-and-autosave).

### Playing

| Control | Action |
|---|---|
| **Space** | Play from the cursor row / stop |
| **Shift+Space** | Play from the start |
| **▶ Song** button | Play from the start |
| **▶ Cue** button | Play from the cue under the cursor |
| **follow** checkbox | Scroll the view with playback |

Audio starts in a suspended state (browsers require a user gesture before
sound); the first click or key press activates it — the badge in the top bar
shows `audio @ … Hz` once running. Jamming on the piano keys works immediately,
without pressing Play.

### The screen at a glance

From top to bottom:

- **Top bar** — transport, record toggle, undo/redo, octave / instrument / speed displays (hover and use the mouse wheel to change them), song selector, file buttons, language / theme / help buttons. Click the **Microtone** logo for the About box.
- **Tabs** — the seven views, on **F1**–**F7**.
- **Toolbox** (Timeline and Patterns only) — **Retune…**, the **Raw** hex-note toggle and the quick **Instruments** lookup panel.
- **The main view.**
- **Command palette** — a context strip above the status bar showing the actions and documentation for the column under the cursor while recording.
- **Status bar** — file name, project name, dirty marker, cue/row/BPM/speed position, and links to GitHub and these docs.

## Views

| Key | View | Purpose |
|---|---|---|
| **F1** | Timeline | The whole song, all channels — main editing view |
| **F2** | Cues | The order list and flow commands |
| **F3** | Patterns | Single-pattern editor with bulk tools |
| **F4** | Samples | The sample pool: waveforms, DSP editing |
| **F5** | Instruments | The instrument bank: envelopes, zones, layers |
| **F6** | Project | Song properties, tuning, song list |
| **F7** | File | Browser storage, import/export |

## Timeline (F1)

The Timeline unrolls the entire song: every channel side by side, every cue
stacked vertically. The left gutter shows `cue:row`; channel headers carry
live VU/pan meters and the channel's current pitch while playing.

### Reading a cell

Each cell is five columns:

```
♯C-4 01 v3F p20 A0F00
└note┘└inst┘└vol┘└pan┘└─fx─┘
```

- **Note** — the pitch in the song's notation (or a sentinel symbol: `===` key-off, `^^^` cut, `~~~` fade, `~^~` fast fade). Notes that don't sit on the current pitch table are shown snapped to the nearest degree and painted **yellow**. The toolbox **Raw** toggle switches to 4-digit hex words.
- **Instrument** — two hex digits, `01`–`FF`.
- **Volume** — a selector prefix + two hex digits (00–3F): `v` set, `+` slide up, `-` slide down, `f` fine (one-shot) change.
- **Pan** — same shape: `p` set (00 = left, 20 = centre, 3F = right), `+` slide right, `-` slide left, `f` fine.
- **Effect** — a base-36 opcode letter and a 16-bit argument in four hex digits. See [Effect commands](#effect-commands).

### Navigation

| Key | Action |
|---|---|
| **← → ↑ ↓** | Move the cursor (left/right walks the sub-columns) |
| **Tab / Shift+Tab** | Next / previous channel (jumps to the note column) |
| **PageUp / PageDown** | ±16 rows |
| **Home / End** | Start / end of the song |
| **Ctrl+G** | Go to a `cue:row` (cue in hex) |
| **wheel / Shift+wheel** | Scroll rows / channels |

### Mute and solo

In navigate mode (record **off**), **M** mutes and **N** solos the cursor
channel; pressing solo again unmutes everything. With the mouse: click a
channel header to mute, **Ctrl+click** (⌘+click) to solo. Mutes are per-song
and cleared when a file loads.

### Picking up an instrument

**Enter** on a cell adopts its instrument as the current jam/entry instrument.
You can also turn on the **Instruments** lookup panel in the toolbox — a
floating list of every top-level instrument; click one to select it.

## Editing

### Record mode

**Insert** (or the **⏺ rec** button) toggles record mode — the cursor caret
turns amber. With record **off** the piano keys only audition ("jam") notes;
with record **on** they write into the pattern and step down one row.

### Entering notes

The note column uses two physical piano rows (layout-independent — they follow
key position, not labels):

```
 black:   W E   T Y U
 white:  A S D F G H J K
         C D E F G A B C
```

**[** and **]** shift the octave. Entering a note also stamps the current
instrument into the cell (unless the cell already has one).

Entry is **notation-aware**: in a non-12-TET song, the keyboard's twelve
positions map to the nearest degrees of the song's pitch table, so you play
that tuning's scale rather than fixed 12-EDO. To reach every degree of a
larger table, enter a nearby note and step it with the mouse wheel (one wheel
click = one table degree).

### Note sentinels

| Keys | Word | Symbol | Meaning |
|---|---|---|---|
| **z** or **`** | `0001` | `===` | Key-off — release the note (envelopes enter their release phase) |
| **x** or **1** | `0002` | `^^^` | Note cut — stop immediately |
| **c** or **2** | `0003` | `~~~` | Note fade — fade out at the instrument's fade rate |
| **v** or **3** | `0004` | `~^~` | Fast fade |
| **Delete** or **.** | — | | Clear the note (and instrument) |

### Instrument, volume and pan columns

Type **hex digits** to set values nibble by nibble. On the volume and pan
columns, **+** and **-** first switch the selector (slide up/down, or
right/left for pan); the command palette shows buttons for all four selector
modes including *fine*. **Delete** / **.** writes the no-op sentinel so the
cell stays blank.

### The effect column

The first character is the opcode — any base-36 key (**0–9, A–Z**); the caret
then moves into the four-digit hex argument. The command palette lists every
opcode with a tooltip, and while on the argument column it documents the
argument format of the current opcode. **Delete** clears the effect.

### Mouse-wheel editing

In record mode, the wheel over any cell steps the hovered column in place:
notes by one degree of the pitch table, everything else by one. Hovering the
top-bar **Oct** / **Inst** / **Spd** displays and wheeling changes the jam
octave, steps through the used instrument slots, or nudges the live playback
speed.

### Undo and redo

Everything is undoable: **Ctrl+Z** undoes, **Ctrl+Y** (or **Ctrl+Shift+Z**)
redoes. Bulk operations (retune, transpose, imports, pattern tools, sample
DSP) are single undo steps. The counter next to the buttons shows the stack
depth.

## Block selection and clipboard

Timeline and Patterns support rectangular selections:

- **Drag** with the mouse to select rows × channels. A drag also records which *columns* (note / instrument / volume / pan / effect) it covers, so a narrow drag lets you copy just volumes, or just notes.
- **Shift+arrows** (and **Shift+PageUp/Down/Home/End**) extend a whole-cell selection from the cursor.
- **Ctrl+C / Ctrl+X / Ctrl+V** copy, cut and paste; the block's top-left lands at the cursor. Pasting across views clips to what fits; a column-limited block overwrites only its columns.
- **Delete / Backspace** blanks the selection, **Esc** clears it.

## Cues (F2)

The Cues view is the song's order list: one row per cue, one column per
channel, each cell holding the pattern number (hex) that channel plays during
that cue.

- Type **hex digits** to enter a pattern number (`0000`–`7FFE`).
- **Delete** / **.** empties the slot.
- **Enter** opens the command popup for the cell. Commands occupy the slot instead of a pattern:

| Command | Meaning |
|---|---|
| **LEN** | Set this cue's pattern length (1–64 rows) |
| **HALT** | Stop playback after this cue |
| **HALT@** | Stop after N rows into this cue |
| **BAK** | Go back N cues |
| **FWD** | Skip forward N cues |
| **JMP** | Jump to cue N |

## Patterns (F3)

A focused editor for one pattern, with the same cell editing as the Timeline.
The header shows which cues (and channels) use the pattern — remember that
editing a shared pattern changes every place it plays.

- **▶ Preview** plays just this pattern in a loop-free scratch cue.
- **Duplicate** copies the pattern into a fresh slot.
- **Transpose…** shifts every note, notation-aware: the fine unit is semitones / steps / note units depending on the preset, the coarse unit octaves (or periods for non-octave tunings). Percussion instruments and sentinels are skipped.
- **Lengthen ×2 / Shorten ÷2** stretch or squeeze the rows (Impulse Tracker's Alt-F/Alt-G maps).
- **Volume…** rescales set volumes (`new = old × multiply + add`).
- **Pan…** widens/narrows around centre and shifts (`new = 20 + (old − 20) × widen + shift`); a negative widen mirrors left/right.
- **Instrument…** replaces instrument numbers (leave *From* blank to replace all).

The volume/pan/instrument tools honour an active row selection; otherwise they
act on the whole pattern.

## Samples (F4)

Lists every distinct sample in the pool (from base instruments and Ixmp
patches alike) with its name, length and rate. The waveform display shades
loop regions and shows live play-position cursors while audio runs. Piano keys
audition the selected sample's instrument.

**Edit…** opens the sample editor in DSP mode:

- **Normalise**, **Fade in**, **Fade out**, **Reverse**, **Invert** (polarity) — all length-preserving, each one undo step.
- **Rename** the sample.
- **▶ C4** auditions through the engine.

DSP edits rewrite the pool bytes, so *every* instrument using the sample hears
the change. **Apply** keeps the edits; **Cancel** rolls all of them back.

## Instruments (F5)

The left list shows every defined instrument slot; rows light up while an
instrument plays. Above it:

- **Add…** — pick presets from the bundled GeneralUser-GS SoundFont (or your own `.sf2`) and merge them in.
- **Import…** — merge instruments (with their samples and patches) from a `.taud`, `.tsii` or `.sf2` file. A checkbox picker lets you choose which; SF2 drum kits are the bank-128 presets.
- **New from sample…** — build a fresh instrument from any audio file (`.wav`, `.mp3`, `.ogg`, `.flac`, …). The audio is decoded, mixed to mono and squeezed into the engine's 8-bit format.

All imports are single undo steps.

### Editing an instrument

- **General** — global volume, volume swing, fadeout; default pan, pan swing, pitch-pan separation and centre; wide-range detune (with hex-word and cents readouts); **New Note Action** (cut / continue / key-off / fade / key lift), Duplicate Check Type and Action; filter mode (**ImpulseTracker** or **SoundFont2**) with cutoff and resonance shown in Hz/dB for SF2 mode. The Sample section binds the sample and opens the **play/loop/sustain marker editor** — draggable play-start, loop-start and loop-end markers, loop mode (off / forward / ping-pong / one-shot) and sustain, affecting this instrument slot only.
- **Vol env / Pan env / Pitch / Filter** — envelope graphs. Drag nodes vertically for values, horizontally for timing; a checkbox switches to a logarithmic timescale. The pitch/filter tab follows the instrument's envelope role.
- **Zones** — the Ixmp key/velocity zone map with a live trigger overlay showing which zone each incoming note lands in.
- **Layers** (metainstruments) — a metainstrument plays several sub-instruments at once; the table lists each layer's pitch/velocity range with editable **mix** (0–255, 159 = 0 dB, live dB readout) and **detune** (signed 4096-TET units).

## Project (F6)

Per-song properties, applied live to playback:

- **Name** (and the project name — both stored with `\uHHHH` escapes for non-ASCII, shown decoded).
- **BPM** (25–535) and **Speed** (ticks per row, 1–127).
- **Global volume** and **Mixing volume** (0–255).
- **Tone-slide mode** — Linear (4096-TET), Amiga period, or Linear frequency.
- **Interpolation** — Fast sinc, None (ZOH), Amiga 500, Amiga 1200, SNES gaussian, NES DPCM.
- **Notation** — the display pitch table. Changing it only relabels notes; use **Retune…** to actually move them (see [Microtonality in depth](#microtonality-in-depth)).

Below, the songs table lets you rename, delete and add songs within the
project; the top-bar selector switches between them.

## File (F7)

The File view works even before anything is loaded (**F7** from the empty
screen).

### Browser storage (OPFS)

Projects are saved into the browser's **origin-private file system** — private
storage owned by the site, never uploaded anywhere. The table lists your saved
projects with size and modification time; **Open** loads, **Delete** removes.
In private-browsing mode OPFS may be unavailable — a warning appears, and you
should use **Export** to keep your work.

### Saving and autosave

- **Save** (**Ctrl+S**) writes the current project into OPFS; **Save As…** under a new name.
- The app **autosaves** 45 seconds after your last edit. If the browser closes with unsaved work, the next visit offers to recover it; declining discards the autosave. A clean save removes its autosave.

### Import and export

- **Import Taud/Module…** — bring a file from your real disk into OPFS.
- **Import MIDI…** — convert a MIDI file and save the result straight into OPFS.
- **Export ⬇** — download the project as a `.taud` file.
- **Export WAV…** — render the current song offline through the same engine to a 16-bit stereo WAV at 48 kHz. Set a maximum length (songs that never HALT stop at the cap).

## Importing music

All conversion runs **inside your browser** — the canonical Taud converter
scripts execute under a bundled Python runtime. The first import boots the
runtime (a few seconds); a progress popup streams the converter's log.

### MIDI

MIDI needs a SoundFont for its instruments. Use **Import MIDI…** and choose
the **bundled GeneralUser-GS** bank or pick your own `.sf2`. The result loads
as an unsaved project.

### Tracker modules

`.mod`, `.s3m`, `.xm`, `.it` and `.mon` files convert directly — just open or
drop them.

### Banks and pattern files

- Opening a **`.tsii`** over a loaded project replaces its samples and instruments (with confirmation); opened standalone it seeds a new project.
- Opening a **`.tpif`** (patterns only) combines it with the current project's bank, or prompts for the companion `.tsii`.

## Microtonality in depth

### Pitch-table presets

The available notations (the preset also defines the note symbols used in the
grid):

| Preset | Notes per period | Period |
|---|---|---|
| Raw format | — (raw hex words) | octave |
| Octave only | 1 | octave |
| 2- to 10-TET | 2–10 | octave |
| 12-TET | 12 | octave |
| 15-, 16-, 17-, 19-, 22-, 24-, 31-TET | as named | octave |
| 41-TET (Kite), 53-TET (Kite) | 41 / 53, Kite up/down tick notation | octave |
| 53-TET (Pythagorean) | 53, letters with stacked sharps/flats | octave |
| 96-TET (Kite) | 96 | octave |
| Pythagorean dim. 5th / aug. 4th | 12, just fifths | octave |
| Shi'er lü | 12, 十二律 CJK names | octave |
| Equal-Tempered Bohlen-Pierce | 13 | **tritave** (3:1) |

Note display uses proper microtonal accidentals — sharps, flats, demisharps,
demiflats, double/triple/quadruple accidentals, Kite tick marks — and degree
octave labels where letters run out. Notes more than two units off the active
grid render snapped-but-**yellow**; the **Raw** toolbox toggle shows exact hex
words instead.

### Retuning

**Retune…** (toolbox or Project view) remaps every pattern note onto a new
pitch table, as one undo step. Percussion instruments are skipped. Four
methods:

- **Nearest pitch** — snap each note to the closest new-table degree.
- **Nearest delta** — preserve the melody's shape: each note keeps the interval from the previous note as closely as possible.
- **Nearest cadence** — like delta, but scores candidates by how well they reproduce the original's rise and fall of tonal tension.
- **Cadence-aware harmonic** — delta plus a pull toward just-intonation intervals, weighted by note duration (held notes pull harder).

For non-destructive experiments remember **Ctrl+Z** restores the previous
tuning exactly.

## Effect commands

A quick digest — the full specification with per-tick semantics, memory
behaviour and worked examples is the **Note Effects** reference in the
sidebar (also at [Note Effects](#effects)).

| Op | Name | Argument |
|---|---|---|
| 1 | Global flags | `$ff00` — tone-slide mode and interpolation bits |
| 5 | Filter cutoff | IT: `$xx00` · SF: `$xxxx` cents · `$FFFF` reset |
| 6 | Filter resonance | IT: `$xx00` · SF: `$xxxx` centibels · `$FFFF` reset |
| 7 | Pattern ditto | `$llrr` — repeat the last `ll` rows `rr` times |
| 8 | Bitcrusher | `$xyzz` — clip mode, bit depth, sample-skip |
| 9 | Overdrive | `$x0zz` — clip mode, gain (16+zz)/16 |
| A | Set tick rate | `$xx00` — ticks per row |
| B | Jump to cue | `$xxxx` — order jump |
| C | Pattern break | `$00xx` — next cue at row xx |
| D | Volume slide | `$xy00` — up/down per tick; `F` nibble = fine |
| E | Pitch slide down | `$xxxx` units/tick · `$Fxxx` fine |
| F | Pitch slide up | `$xxxx` units/tick · `$Fxxx` fine |
| G | Tone portamento | `$xxxx` — slide toward the row's note |
| H | Vibrato | `$xy00` — speed, depth |
| I | Tremor | `$xy00` — x+1 ticks on, y+1 off |
| J | Arpeggio | `$xy00` — microtonal offsets ×256 for voices 2/3 |
| K | Vibrato + vol slide | `$xy00` |
| L | Portamento + vol slide | `$xy00` |
| M | Channel volume | `$xx00` (00–3F) |
| N | Channel vol slide | `$xy00` |
| O | Sample offset | `$xxxx` — start at byte offset |
| P | Pan slide | `$xy00` — left/right |
| Q | Retrigger | `$0xyy` — every yy ticks, x = volume modifier |
| R | Tremolo | `$xy00` — speed, depth |
| S | Special | delays, cuts, loops, waveforms, NNA overrides, funk… |
| T | Tempo | `$xx00` set · `$FFxx` extended · `$000y/$001y` slide |
| U | Fine vibrato | `$xy00` |
| V | Global volume | `$xx00` (00–FF) |
| W | Global vol slide | `$xy00` |
| Y | Panbrello | `$xy00` — speed, depth |

## Keyboard reference

### Global and navigation

| Keys | Action |
|---|---|
| Space | Play from cursor / stop |
| Shift+Space | Play from start |
| F1…F7 | Switch views |
| Insert | Record mode on/off |
| [ ] | Octave down / up |
| Enter | Timeline: pick up the cell's instrument · Cues: command popup |
| M / N | Mute / solo the cursor channel (navigate mode) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Save to browser storage |
| Ctrl+G | Go to cue:row |
| Shift+arrows · drag | Extend a block selection |
| Ctrl+C / X / V | Copy / cut / paste the block |
| Esc · Delete | Clear the selection · blank the block |
| ? | Keyboard help popup |

### Editing keys

| Keys | Action |
|---|---|
| A S D F G H J K | Piano white keys (C D E F G A B C) |
| W E · T Y U | Piano black keys |
| z x c v (or ` 1 2 3) | Key-off `===` · cut `^^^` · fade `~~~` · fast-fade `~^~` |
| 0–9 A–F | Hex entry (instrument / volume / pan / fx argument) |
| 0–Z | Effect opcode (base-36) |
| + / - | Volume/pan slide selectors |
| Delete / . | Clear the field |
| ← → / Tab | Sub-column / next channel |
| wheel · Shift+wheel | Scroll rows · channels |
| wheel on cursor cell | Step the hovered column (notes by one table degree) |

## Tips

- **No sound?** Click anywhere or press a key — browsers keep audio suspended until a user gesture. The top-bar badge shows the running sample rate.
- **Interface language and theme** — the globe and theme buttons in the top bar; both persist. `?theme=dark` / `?theme=light` in the URL forces a theme.
- **Deep links** — `index.html?load=<url>` opens a `.taud` from a URL, and `player.html` is a minimal stand-alone player.
- **Everything is local.** Clearing the browser's site data deletes your OPFS projects — export `.taud` files of anything you care about.

## About

Microtone is free software, distributed under the GNU General Public License
version 3. Source, issues and discussion:
[github.com/curioustorvald/Microtone.js](https://github.com/curioustorvald/Microtone.js)
— you can support development via
[PayPal](https://paypal.me/curioustorvald) or
[GitHub Sponsors](https://github.com/sponsors/curioustorvald).
