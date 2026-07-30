# Patch Notes

Microtone is deployed continuously — there are no numbered releases, so every entry below is one dated batch of work, newest first. Dates are the day the work landed.

Bug reports and suggestions are welcome on [GitHub](https://github.com/curioustorvald/Microtone.js).

## 2026-08-03

- **Surround panning.** A song can now declare a **panning model** in the Project view: *Stereo* as before, *Planar* to pan all the way round the listener, or *Spatial* to place sources anywhere on the sphere. The model is a property of the song — it decides what the pan commands mean — and playback and WAV export fold the result back down to stereo, so you can write and hear it today.
  - In a surround song `S $8xxx` reads a 9-bit angle: `$000` left, `$080` front, `$100` right, `$180` behind. The low byte is the pan value you already know, so `S $8040` still means half-left, and pan slides now wrap round the circle instead of stopping at the ends.
  - Three new commands. **X** `$eeaa` places a source (azimuth `$aa` round the full turn, signed elevation `$ee`, `$00` = ear level), **4** `$eeaa` aims where it should travel to, and **Z** `$0xxx` slides it there along the shortest great-circle path at `$xxx`/16 azimuth units per tick — re-issue `Z` on each row you want it moving, `Z $0000` recalls the last speed. Planar songs stay on the horizon; a stereo song ignores all three.
  - A stereo sample in a surround song is placed as a pair of sources 30° either side of where the voice is pointed — the ITU listening triangle — and it turns with the voice instead of being nailed to the speakers.
- **Spatial panner.** A surround song gets a *Panner…* button on the Timeline and Patterns toolbox. It draws the circle from above — plus a side view for a spatial song — with every sounding channel shown where the engine actually has it, so a slide is visible while it runs. Drag the handle (or type the numbers) and one button writes the matching command into the cell under the cursor: **Place** an X, **Target** a 4, **Slide** a Z. Each button shows the exact hex it will write.
- **Surround meters in the channel headers.** In a surround song the header's pan strip stops being a left/right slider and becomes the source's *shadow* on the left–right line: height and depth both collapse onto it, so a hard-left source 60° up reads half-left and one directly behind reads centre. The new *Radar* toolbox button expands every header into a small top-down dial showing where the source really is — azimuth round the circle, elevation shrinking the radius toward the middle, plus a height bar on spatial songs — with a tick marking the same shadow the strip above is drawing.
  - On a spatial song both the panner's circle and the header radars now show height without you having to read a number: a source grows as it rises and shrinks as it sinks, and it casts a shadow from a light high up in front of you — tight underneath and sharp when the source is low, further below and softer when it is overhead. A dial seen from above cannot tell up from down on its own, and this is what closes that gap.
- **Fixed: exported audio ignored the song's tuning.** Export WAV and Export stems rendered at the tracker default instead of the tuning declared in the Project view, so an exported file could sit a couple of cents — or a whole semitone, on a retuned song — away from what playback had just sounded.
- **Export stems.** *File ▸ Export stems…* renders the song into one 24-bit 48 kHz mono WAV per track and hands back a single ZIP. A filename prefix is required; the tracks arrive as `<prefix>_01_<name>.wav`, named after the instrument or the channel they came from.
  - Two arrangements. **Per instrument** (the default) gives one track per instrument as it appears in the pattern, and splits a percussion instrument further into one track per kit piece — kicks, snares, toms and hats separately, while a drum layered from several sub-instruments stays on one track. **Per voice** gives one track per channel, with note-off ghosts and layered notes following the channel that spawned them.
  - Stem tracks are dry: every volume is baked in, panning is not, so a hard-panned part arrives at full level and you re-pan it in your DAW. Nothing is dithered — 24 bits sit far below the engine's own noise floor. Export WAV is unchanged, still 16-bit stereo.
- **Note-delay command upgraded.** `S $Dxny` used to define only its first half (delay the trigger to tick `$x`); the follow-up action is now specified and implemented. Tick `$x`+`$y` applies note off (`$n=0`), note cut (`1`), note continue (`2`), note fade (`3`) or key lift (`4`). Key lift here is a forced jump to the end of the sustain loop — it works even on instruments whose own Key-Lift flag is clear, in the same spirit as the per-voice NNA overrides.
- **Instrument pitch ranges read properly.** A zone whose lower or upper bound is open now shows as `~C-5` or `C-5~`, and a fully open one as *whole range*, instead of the raw sentinel note. This applies to the Zones trigger overlay, the Meta Layers table and the Advanced Edit patch list.
- **Envelope tabs share one header.** All four envelope tabs (Volume, Pan, Pitch, Filter) now report *present* / *absent* the same way, with *present* in the accent colour.
- **Fixed: a moment of the old position played after seeking.** On hosts without cross-origin isolation — where the engine renders on the audio thread — the look-ahead buffer was never flushed when playback was started, stopped or moved, so audio rendered against the previous position played out first. It is now flushed on every transport change.
- **Three new reference documents in the sidebar.** *Engine Spec* describes how playback actually works — timing, the 4096-TET pitch grid and tuning, envelopes, voice lifetimes and New Note Actions, the sampler and its interpolation modes, both filters, the mixing chain, the surround model and the 8-bit output stage. *File Format* is the complete `.taud` / `.tsii` / `.tpif` byte layout, down to every instrument-record field, envelope word and Project Data block. *Conversion Notes* explains what happens to a MOD, S3M, XM, IT, MON or MIDI file on its way into Taud, and what it loses on the way.
  - These replace a long stretch of accumulated engineering notes with something written to be read: if you have ever wondered why a converted XM fades differently, why an envelope node with no duration behaves in two different ways, or what the pan column means once a song goes surround, that is now written down.
  
## 2026-07-28

- **Stereo samples.** An instrument can now carry a true stereo sample. Each channel goes through the existing equal-energy pan law on its own side, so a stereo sample whose channels are identical sounds exactly like the mono original. The Samples view shows one entry per pair with a full-height waveform lane per channel, and the Sample Lab, audio import and the mic recorder all work on channel lists.
- **Stereo survives conversion.** Module imports keep stereo samples by default; SoundFont imports keep them behind a *stereo samples* option.
- Support links moved to Ko-fi.

## 2026-07-27

- **Chord maker.** Build a chorded sample out of an existing one — the Amiga trick, where the channel plays a single note so the chord has to live in the waveform. Six voices, each set as a named just interval, a degree of the song's own pitch table, a plain frequency ratio or a 4096-TET offset, plus a shared octave column and a per-voice level.
- Every voice row paints the note it lands on in the song's notation and prints the ratio, the cents and the distance to the nearest grid degree — so a just third reads as an off-grid E in 12-TET but sits exactly on a degree in 31-TET.
- Chord presets fill all six slots at once, the result length is either *longest voice* or *source length*, and normalising the result is on by default. Reachable from the Sample Lab's ops row and from the Samples view, which works on a copy so the pooled sample is untouched.

## 2026-07-26

- **Volume and pan columns are now symbol + argument.** Each cell has a symbol position followed by two digits, matching how the engine actually reads them: slides carry a direction tick, fine slides carry a sign, and a plain set has a blank symbol. A fine slide's argument is always the magnitude, with the sign in the symbol.
- Keys on the symbol position: `^`/`u` and `v`/`d` for volume slides, `>`/`r` and `<`/`l` for pan, `+`/`-` for fine, `.` for a plain set. Bracket keys and the wheel step the signed fine delta through zero instead of walking the raw byte, and the command palette is rebuilt around the five operations.
- **Erasing a blank cell no longer conjures a "set volume 00"** — a footgun, and typing `00` still gets you there deliberately.
- **Global Transpose** in Project → Global Operations, with the same notation-aware units as the pattern dialog, applied to the current song in one undo step.
- **Backspace erases like Delete** on both pattern grids.
- **Custom notation auto-naming scales.** Past five degrees per letter, names use the accidental palette (and then accidental × tick), so a 1200-EDO notation gets 1200 distinct symbols instead of repeating every ten degrees.

## 2026-07-25

- **Delete instrument**, with the references handled rather than left dangling: the plan reports which patterns use the slot, which metainstruments parent it, and which samples become unreferenced. Undoable in one step.
- **Global change instrument** in the Project view, scoped to the current song.

## 2026-07-24

- **The Sample Lab** — a small audio editor that every sound entering the project now passes through, *before* it is squeezed into the sample pool: selection, crop, cut, gain, fade, an eight-band EQ with a response graph, chopping into chunks at transients or manual splits, its own undo, and an audition path that plays back at the true rate. The info line always shows the projected frames and rate before the irreversible commit step.
- **Record a sample from your microphone** (Instruments → *Record sample…*): raw PCM capture with a live peak meter and a two-minute cap, deliberately not a compressed recording since the result is destined for 8 bits. Echo cancellation, noise suppression and auto-gain are requested off, and the take opens straight in the Lab.
- Existing pooled samples open in the Lab as a copy (*Lab…* in the Samples view), so the original is never disturbed.

## 2026-07-21

- **The status bar hint is contextual** — it follows the active view, and on the grid views also whether record mode is on.
- **Rename files** from the File tab; a rename refuses to overwrite a different existing file.
- **Fixed: Pattern Ditto was silent when playback started on a repeated row.** Effect 7 only armed its repeat state when playback ran through the arming row, so starting on one of the grey ghost rows played nothing.
- Bluesky link in the About popup.

## 2026-07-20

- **Pattern Ditto shows what it plays.** Effect 7 repeats earlier rows without copying them, so those rows looked empty although they sounded; the grids now paint the would-be-repeated values in grey.
- **Horizontal scrolling** with a touchpad swipe or a tilt wheel scrolls the channel columns on the Timeline and Cues. Record-mode wheel editing stays on the vertical axis, so a sideways swipe cannot edit a cell.
- **The wheel no longer writes a symbol into an empty cell.**
- **Housekeeping merges duplicate patterns** as part of pattern cleanup.
- Space on the Cues command column opens the command popup, like Enter.
- The ProTracker note table is now called *ProTracker Temperament* throughout, including in the manual.

## 2026-07-17

- **Song tuning is applied, not just stored.** The song's "note B sounds at F Hz" pair was parsed, written and settable in the wizard, but the engine ignored it; it now shifts playback, jamming and rendering.
- **ProTracker Temperament** — notation index 1, plus support for absolute pitch tables in general. ProTracker tunes from a hand-made table of integer Amiga periods, so `.mod` imports used to show most notes as off-grid; they now land on the grid they were written on.
- **Fixed: retuning an out-of-tune `.mod`.** Imports with no notation metadata defaulted to 12-TET while the Amiga period table sits a few cents off it, and two separate bugs then mangled the retune.
- **Fixed: jamming keys hung the browser** on ProTracker Temperament.
- **Fixed: shortcuts read raw key codes** where they should follow the keyboard layout.
- **Boot splash** covering the module load, so a cold start no longer flashes an unstyled page; it picks up your theme before anything else renders.
- **Metainstrument work**: *Edit…* on a layer row opens that child in its own editor with the ordinary tabs; *New metainstrument…* builds one from ticked instruments (copies, so the originals stay editable); *Renumber…* moves an instrument to another slot and remaps every pattern reference.
- **Housekeeping: cleanup instrument patches** — drops orphaned, degenerate and fully shadowed patches.
- **Notation Maker fixes**, including sensible auto-names past 26 degrees.
- **Fixed: arbitrary pattern numbers on the Timeline.** A cue addressing a pattern that had not been materialised yet painted blank and silently swallowed edits.
- Imported soundfont banks keep every patch of a preset, rather than only the ones the song happened to trigger.

## 2026-07-16

- **Remove DC** in the sample editor.
- **Fixed: sample preview in the Samples tab played the wrong thing** when the sample belonged to a metainstrument — it played whatever C4 resolved to through the owning instrument's zones instead of the waveform on screen. There is now a raw preview path that bypasses instrument resolution.
- **Fixed: sample names were shifted by one** in files written by the converters, which left sample 0 unnamed.

## 2026-07-15

- **Arbitrary pattern numbers.** Every pattern from `0x0000` to `0x7FFE` is navigable and creatable; storage only grows when a pattern is actually edited.
- **Ixmp patch Advanced Edit** — a full-panel editor for an instrument's patches: add, duplicate, delete and reorder them, edit every block, and watch the zone map while you do it.
- **Notation Maker** — custom notations stored in the project, up to 16 of them, with equal-division helpers, two auto-naming tools, and duplicate or delete.
- **Project Housekeeping** — cleanup patterns, cleanup samples and cleanup instruments, each an ordinary undoable operation.
- **Paint a waveform** — drag to draw, or seed a sine, saw, square, triangle or noise. Creates a new sample from the Instruments view, or rewrites an existing one from the Samples view.
- **Raw hex note entry** — with the Raw toggle on (or on a Raw notation) the note column takes hex digits straight into the 16-bit note word.
- **MIDI import takes a rows-per-beat setting** instead of always deciding for itself.
- Bracket keys normalised: `[` and `{` decrease, `]` and `}` increase.
- The Timeline voice header shows the metainstrument slot — the number written in the pattern — rather than the layer child it resolved to.
- Advanced Edit is a fixed-height layout that no longer scrolls the page, and no longer jumps to the top when you click a list row.

## 2026-07-14

- **Transport keys reworked.** Enter plays from the cursor, Shift+Enter from the start, Ctrl+Enter from the current cue; Space stops, or toggles record mode when stopped.
- **Lookahead scrolling** — the cursor moves freely in the middle of the view and the view only scrolls when it approaches an edge, on the Timeline, the pattern panes and the Cues.
- **Fixed: a row with no note but an instrument and a pitch effect was silent.** It now triggers at the voice's current pitch, so the slide has something to sound.
- **Fixed: effect state lingered across replays.** Starting playback now clears per-voice pattern-loop and Ditto memory.
- **Fixed: muting a channel left its NNA ghosts and metainstrument layer children audible.**
- **Metainstrument jamming auditions at a note that sounds.** A strict metainstrument is silent outside its zones, which is faithful but unhelpful when auditioning from the Instruments view.
- Pattern transpose honours a row-range selection; sub-instruments no longer appear in instrument pickers; the language setting also loads that language's font.

## 2026-07-12

- **The renderer moved off the audio thread** on cross-origin-isolated hosts, and the engine's batch size was cut. Together these removed the audio glitching reported on iPad — the audio callback's worst case fell from 14 ms to 3 ms against a 2.67 ms budget.
- **Performance profiler** behind `?profile=1`, off by default.
- **Export WAV shows progress** and can be cancelled; the offline render is bit-identical to the real-time path.
- **App reload button** in the top bar.
- **Cue and row numbers are hex everywhere**, including the Go-to dialog.
- **Instrument, pattern and cue names** are editable and shown next to the numbers; the fadeout slider is logarithmic.
- Lengthen and shorten a pattern by an arbitrary integer factor, not just two.
- Envelope graphs keep headroom at the right so the last node can always be dragged further out, and the Pitch and Filter tabs carry the *Envelope present* checkbox too.
- New instrument from a sample already in the pool.
- **Fixed: play-from-cue on the Cues view** used the stale Timeline cursor.
- MIDI import names patterns systematically and keeps a part on one voice where it can, the way a person writing in a tracker would.

## 2026-07-11

- **Copy and paste across the grids** — drag or Shift+arrow to select a 2D block, then Ctrl+C/X/V, with the clipboard respecting which columns you selected.
- **`z` `x` `c` `v` insert key-off, cut, fade and fast-fade.**
- **A Taud-conformant GeneralUser GS bundle** ships with the app, so MIDI import works without a soundfont of your own.
- **Documentation** — this viewer, with the User Manual and the Note Effects reference.
- **The Patterns tab holds several panes** side by side, each with its own pattern, cursor and selection.
- **A richer New Project wizard.**
- **Instrument lookup panel** on the Timeline and Patterns, listing top-level instruments by name.
- **The audio engine starts with the app**, suspended until your first interaction, so jamming works before you press play.
- **Metainstrument mix and detune are editable.**
- **Volume and pan tools** in the Patterns toolbar: multiply or add volume, widen, narrow or shift pan, change matching or all instruments.
- **Language switches without reloading**, and the language button sits next to the theme button. Non-ASCII names are shown decoded everywhere, while files keep their escapes.
- **About popup** on the brand, and a `?` button for the keyboard reference.
- New instrument by importing an audio file; sample rename and invert; the sample editor split into a pool-wide DSP editor and a per-slot marker editor.
- The Timeline voice header pitch indicator updates every tick, not every row.
- **Fixed: notes lingered after pressing play.** The pre-play reset silenced foreground voices but left NNA ghosts running.
- **Fixed: typing on the Cues, Project and File tabs jammed notes.**

## 2026-07-10

- **Import from a soundfont.** Pick presets from any `.sf2` (or the bundled one) and they are built into an instrument bank through the canonical converter machinery.
- **Import instruments from another `.taud` or `.tsii`**, with meta-layer dependencies followed, samples deduplicated and slots allocated around what you already have.
- **Import MIDI and tracker modules** (`.mod`, `.s3m`, `.it`, `.xm`, `.mon`) with no server involved: the canonical converters run in your browser. A progress popup streams the converter's log, and stays up in red on failure.
- **Channel mute and solo** on the Timeline — `M` and `N` on the cursor channel, or click and Ctrl+click the header.
- **Instrument editor depth**: SoundFont filter mode with cutoff and resonance in Hz and dB, New Note Action / Duplicate Check Type and Action spelled out, key lift as the fifth New Note Action, pitch-pan separation and centre, pan and volume swing, a wide detune slider with hex-word and cents readouts, and sliders with editable spinners throughout.
- **Envelope viewer gets a logarithmic timescale toggle.**
- **Note entry and jamming follow the active notation** instead of assuming 12-TET.
- Editable project and song names.

## 2026-07-09

First complete build of the web app.

- **The engine** — a port of the TSVM Taud engine, verified bit-exact against the reference implementation on every deterministic corpus song, rendering 32 kHz stereo 8-bit audio through an AudioWorklet.
- **Timeline, Cues, Patterns, Samples, Instruments, Project and File views**, with cell editing, record mode, undo and redo.
- **Storage in the browser** (nothing is uploaded), autosave with recovery on boot, import and export, and WAV export.
- **Microtonal notation** — pitch-table presets, a vector glyph engine drawing the accidentals each notation needs, and a Retune tool offering the nearest-pitch, delta, cadence and harmonic methods.
- **Sample and instrument editing** — waveform view with loop markers, normalise, fade and reverse, and envelope editing by dragging nodes in two dimensions.
- **A contextual command palette** along the bottom of the screen: sentinel inserts on the note column, volume and pan operations, and an effect chooser with per-argument documentation.
