# Patch Notes

Microtone is deployed continuously — there are no numbered releases, so every entry below is one dated batch of work, newest first. Dates are the day the work landed.

Bug reports and suggestions are welcome on [GitHub](https://github.com/curioustorvald/Microtone.js).

## 2026-08-05


- **Surround panning.** A song can now declare a **panning model** in the Project view: *Stereo* as before, *Planar* to pan all the way round the listener, or *Spatial* to place sources anywhere on the sphere. The model is a property of the song — it decides what the pan commands mean.
  - In a surround song `S $8xxx` reads a 9-bit angle: `$000` left, `$080` front, `$100` right, `$180` behind. The low byte is the pan value you already know, so `S $8040` still means half-left, and pan slides now wrap round the circle instead of stopping at the ends.
  - Three new commands. **X** `$eeaa` places a source (azimuth `$aa` round the full turn, signed elevation `$ee`, `$00` = ear level), **4** `$eeaa` aims where it should travel to, and **Z** `$0xxx` slides it there along the shortest great-circle path at `$xxx`/16 azimuth units per tick — re-issue `Z` on each row you want it moving, `Z $0000` recalls the last speed. Planar songs stay on the horizon; a stereo song ignores all three.
  - A stereo sample in a surround song is placed as a pair of sources 30° either side of where the voice is pointed — the ITU listening triangle — and it turns with the voice instead of being nailed to the speakers.
- **A master strip for mastering.** The Timeline gains a panel down its right-hand edge — a stack of vectorscopes over a meter and the song's global-volume fader — shown by default and switched with the *Master* toolbox button. It costs nothing while it is hidden.
  - **The panels.** A scope panel is a fixed size, so how many you get depends on your screen: two by default, more on a tall window, up to one per view the song has — six on a spatial song, two on a stereo or planar one. Each chooser's last entry, *Hide this panel*, drops that one panel; **+** in the header adds one back when there is room; and the divider above the meter drags straight to a count — panels close as it passes them on the way down and open again on the way up, with the meter taking whatever is left (double-click goes back to two). Your arrangement is remembered.
  - **Vectorscopes** come in two families over the same three views — *top* (left–right against front–back), *front* (left–right against height) and *side* (front–back against height) — on the same axes, each labelling its own directions, so a panel from each family placed side by side agree. *Blobs* shows the **sources**: a dot per sounding channel where the engine actually has it, with the familiar height cue on the top view. *Lissajous* traces the **sound**. Views a song cannot express are not offered: a stereo song has no front–back axis, a planar one has no height.
  - A Lissajous view is drawn as a **CRT beam**, a beam from each sample to the next, the way the instrument it is named after did. The lights add up just like a real phosphor; once ink can get no more opaque the spot starts going white instead (dark, on the light theme), so density still reads.
  - In a stereo song the top view is the classic mid/side goniometer you already know — a vertical cloud is a mono-safe mix, a horizontal one is wide, a diagonal is off to one side. It is the same display as the surround one, because for two speakers those axes *are* mid and side. It is auto-gained (the factor is shown) so a quiet mix still fills the dial, gliding over about a third of a second rather than snapping at every transient; the meters below are the absolute reading.
  - Under every scope sits a thin **correlation meter** that grows out of the centre: nothing at all when the mix folds to mono cleanly, wider as the two sides disagree, full width in anti-phase. It reads about half a second of audio and is eased on top of that, so it moves at the speed of the music instead of twitching at every transient.
  - **Meters** are RMS and peak in one bar, with a peak hold and a clip light on each bar. The clip light latches: once a channel has clipped it stays lit until you start playback again, so a single clipped sample cannot slip past while you are looking at the grid. Peak is a true peak — the level *between* the samples, which is what a resampler or a decoder will run into.
  - **What the meters measure is your choice** — the chooser at the foot of the meter panel — and it does not have to be what you are listening to: a surround song can be metered as stereo, as quadraphonic, 5.1 or 7.1 — the same speaker feeds the export writes, so the bars match the file — or as the ambisonic field. A speaker layout's bars stand where its speakers do, left to right around you — `Ls L C R Rs` for 5.1, `Lrs Lss L C R Rss Rrs` for 7.1 — with no LFE bar, since the exporter leaves that channel silent by design.
  - **Ambisonic metering** has no speakers to meter, so it reads the encoded field instead: one bar for the acoustic energy in the sound field, which is the same number whichever direction the sound comes from, beside a bar per encoded channel so you can see which one is about to clip. A planar song meters the three channels it can actually excite.
  - **The fader is the song's global volume.** While the song plays it follows the `V` and `W` commands as they move it, so you can watch a written fade happen; dragging it writes the project's own value in one undo step, and stopping playback snaps it back to that value. Double-click resets it to the default, and the wheel nudges it.
- **Export stems.** *File ▸ Export stems…* renders the song into one 24-bit 48 kHz mono WAV per track and hands back a single ZIP. A filename prefix is required; the tracks arrive as `<prefix>_01_<name>.wav`, named after the instrument or the channel they came from.
  - Two arrangements. **Per instrument** (the default) gives one track per instrument as it appears in the pattern, and splits a percussion instrument further into one track per kit piece — kicks, snares, toms and hats separately, while a drum layered from several sub-instruments stays on one track. **Per voice** gives one track per channel, with note-off ghosts and layered notes following the channel that spawned them.
  - Stem tracks are dry: every volume is baked in, panning is not, so a hard-panned part arrives at full level and you re-pan it in your DAW. Nothing is dithered — 24 bits sit far below the engine's own noise floor. Export WAV is unchanged, still 16-bit stereo.
- **Right-click menu on the grids.** Right-clicking a channel on the Timeline — its header, or anywhere down its column — opens a small palette of icons. *Channel left* and *Channel right* insert an empty channel beside it, sliding that channel and everything to its right one place along, mutes included. The song's channel count does not change, so if the last channel is carrying anything you are told it is about to be dropped before it happens; either way Ctrl+Z puts the whole shift back, mutes and all. Cue commands stay on the channel they were written on — inserting never moves a pattern length, halt or jump.
  - Right-clicking a cell where the cue leaves that channel empty adds a third choice, *New pattern*: it points the slot at the lowest pattern number nothing in the song is using and drops the cursor on it, ready to type. Over a block — on the Timeline or in the Cues view — it fills every empty slot the block covers, one fresh pattern each, in a single step; slots that already have a pattern are left alone.
  - A slot that already **has** a pattern gets the opposite three. *Move left* and *Move right* slide it one channel over — offered only when there is an empty slot waiting there, so a move can never overwrite anything — and *Duplicate* points the slot at a fresh copy of its pattern, which is how you make one cue's part differ from the others that were sharing it.
  - Over a block they act on every filled slot at once: a solid block of channels slides sideways as a unit, or every slot in it gets its own copy, in a single step. A move takes the selection with it, so you can walk a part across the grid one channel at a time.
  - With a block selected the menu also offers *Copy* and *Cut*, and any cell that has a pattern offers *Paste* — the same three as Ctrl+C / Ctrl+X / Ctrl+V, for when your hand is already on the mouse.
  - **The Cues view has the same menu**, since a column there is a channel too: the clipboard, both channel inserts, and *New pattern* on an empty slot. The Cmd1/Cmd2 columns belong to the cue rather than to any channel, so they have no menu.
  - **The Patterns editor has the clipboard half** — a Taud pattern is a single channel, so there is no channel to insert one beside. Right-clicking focuses the column you pointed at first, which is what makes it work across columns: select and *Copy* in one column, right-click in another and *Paste*, and it lands there.
  - **A second row carries the edit tools**, picked by the column under the pointer: *Transpose* on the note column, *Instrument*, *Volume*, *Panning* — the same tools as the Patterns toolbar, plus a *Panner* cell beside the panning one in a surround song — and on the effect column the most-used commands (**S** Special, **D** Volume slide, **G** Tone portamento, **H** Vibrato, **E**/**F** Pitch slide, **O** Sample offset, **A** Set tick rate), which write the opcode and leave the argument alone.
    - Each one acts on the **selected block** — which on the Timeline may span channels and cross several patterns — or on the one cell you clicked, in a single undo step either way. A selection covering several columns offers one tool per column but never the effect list, since picking an effect writes a command rather than transforming what is there.
  - **On a channel header that second row is the channel's mutes instead** — *Solo*, *Mute* (which reads *Unmute* when the channel is already silenced), and *Unmute all* whenever anything in the song is muted. They are the same actions as clicking and Ctrl+clicking the header, spelt out for when you would rather not remember which click does which.
- **A third theme: dim, and it is the new default.** The ◐ button now cycles dark → dim → light rather than flipping between two. Dim is a neutral grey rather than the dark theme lightened and it keeps the same ink and accents, so nothing moves or changes meaning when you switch. Everyone gets it on a first visit now, whatever the desktop is set to; if you have ever picked a theme here, your choice is untouched. It applies to the documentation viewer too, and `?theme=dim` in the URL selects it.
- **Three new reference documents in the sidebar.** *Engine Spec* describes how playback actually works — timing, the 4096-TET pitch grid and tuning, envelopes, voice lifetimes and New Note Actions, the sampler and its interpolation modes, both filters, the mixing chain, the surround model and the 8-bit output stage. *File Format* is the complete `.taud` / `.tsii` / `.tpif` byte layout, down to every instrument-record field, envelope word and Project Data block. *Conversion Notes* explains what happens to a MOD, S3M, XM, IT, MON or MIDI file on its way into Taud, and what it loses on the way.
  - These replace a long stretch of accumulated engineering notes with something written to be read: if you have ever wondered why a converted XM fades differently, why an envelope node with no duration behaves in two different ways, or what the pan column means once a song goes surround, that is now written down.
- **Spatial panner.** A surround song gets a *Panner…* button on the Timeline and Patterns toolbox. It draws the circle from above — plus a side view for a spatial song — with every sounding channel shown where the engine actually has it, so a slide is visible while it runs. Drag the handle (or type the numbers) and one button writes the matching command into the cell under the cursor: **Place** an X, **Target** a 4, **Slide** a Z. Each button shows the exact hex it will write.
- **Surround meters in the channel headers.** In a surround song the header's pan strip stops being a left/right slider and becomes the source's *shadow* on the left–right line: height and depth both collapse onto it, so a hard-left source 60° up reads half-left and one directly behind reads centre. The new *Radar* toolbox button expands every header into a small top-down dial showing where the source really is — azimuth round the circle, elevation shrinking the radius toward the middle, plus a height bar on spatial songs — with a tick marking the same shadow the strip above is drawing.
  - On a spatial song both the panner's circle and the header radars now show height without you having to read a number: a source grows as it rises and shrinks as it sinks, and it casts a shadow from a light high up in front of you — tight underneath and sharp when the source is low, further below and softer when it is overhead. A dial seen from above cannot tell up from down on its own, and this is what closes that gap.
- **Instruments can have a spatial home.** In a surround song the Instruments view's *Default pan* becomes **Default azimuth** — the whole circle, so an instrument can sit behind you by default — and a spatial song adds **Default elevation** next to it. They apply wherever the instrument's *Use default pan* box already applied, so a part lands in its place with no command in the pattern. Older files are unaffected: the new values live in bits they leave clear, and a stereo song ignores them.
- **A wider pattern cell for surround songs.** Making a project surround now upgrades its file format, and the extra room goes where a spatial song needs it most: the volume column becomes 8-bit (00–FF, four times the resolution, with single-unit slides), and the panning column carries a whole position — height and angle — instead of one front-arc value. The editor explains the change first and saves the upgraded project as a new file; the original is left exactly as it was. Projects created as Planar or Spatial start out this way.
  - The panning column reads *height* then *angle*: `C0 180` is 45° below and directly behind you. The height is drawn in its own colour, and a `Z` slide on the same row turns the column into that slide's target rather than a jump. In a spatial song a placed source shows its height even when it is `00` — on the sphere, ear level is a position you chose rather than a blank.
  - The Panner gains a **Column** button that writes the position into the panning column, leaving the effect slot free.
  - The upgrade cannot be undone in the file — a version-3 project cannot be saved back down, and the TSVM device cannot play it — though Ctrl+Z still reverts it while you are editing.
- **Binaural monitoring.** A surround song is now monitored through a head model, so on headphones a source behind you sounds behind you and one above you sounds above you — the stereo fold could only ever tell you left from right. It is on by default for planar and spatial songs; the *Binaural* button next to *Radar* switches it off when you want to hear the plain stereo downmix everyone else gets.
  - Each ear gets its own arrival time and its own shading of the sound, and every direction is level-matched to the pan law it replaces, so switching it on does not change how loud anything is.
  - The panner's new *This channel only* box hides the other channels' dots when a busy song makes the dial hard to read.
- **Surround and ambisonic export.** *File ▸ Export audio…* replaces *Export WAV…* and offers the whole range, each with a picture of its channel layout: stereo, quadraphonic, 5.1, 7.1, and ambisonic B-format at first, second or third order. Every target is the same song re-rendered through the engine, not a downmix bolted on at the end.
  - **Speaker layouts** are 24-bit, at the ITU angles, and carry the channel mask plus ADM metadata so a DAW knows which channel is which. The LFE is left silent — there is no bass management here, and that is a decision for whoever masters the file.
  - **Ambisonic** exports are AmbiX (ACN order, SN3D normalisation) with ADM HOA metadata, saved as `<name>.ambix.wav`. This is the only format that keeps the height: a speaker layout spreads an overhead source round the ring, and stereo folds it to the centre.
  - Exporting a surround song to **stereo** now asks how: *Fold* (the safe choice for speakers) or *Binaural* (keeps height and front/back, for headphones) — the same head model you have been composing with.
  - A stereo song can be exported to any of these too; it is promoted to the planar model first, which sounds the same for ordinary panning.
- **Fixed: exported audio ignored the song's tuning.** Export WAV and Export stems rendered at the tracker default instead of the tuning declared in the Project view, so an exported file could sit a couple of cents — or a whole semitone, on a retuned song — away from what playback had just sounded.
- **Note-delay command upgraded.** `S $Dxny` used to define only its first half (delay the trigger to tick `$x`); the follow-up action is now specified and implemented. Tick `$x`+`$y` applies note off (`$n=0`), note cut (`1`), note continue (`2`), note fade (`3`) or key lift (`4`). Key lift here is a forced jump to the end of the sustain loop — it works even on instruments whose own Key-Lift flag is clear, in the same spirit as the per-voice NNA overrides.
  - Its follow-up action can now also land on a row that plays no new note, so it works for commands that just modify a note already sounding.
- **Fixed: converted FastTracker `Kxx` (delayed key-off) always cut the note at the start of the row.** The row's delay tick is preserved now, so an imported .xm's key-off lands on the same tick it did in FastTracker instead of jumping early.
- **Paste lands on the selection.** With a block selected, pasting now puts the clipboard at the **start of the selection** — the corner you began the drag from — instead of at the cursor, which sits wherever the drag happened to end. Without a selection it still pastes at the cursor, and the right-click *Paste* uses the cell you opened the menu on. This is the same in all three grids: Timeline, Cues and Patterns.
- **Single-row and single-column selections.** A drag that never leaves one row, one cell, or one column, is now a selection like any other, so you can copy just one row's panning, or one row's effect, without dragging over the columns either side of it. A plain click still means "no selection".
- **Instrument pitch ranges read properly.** A zone whose lower or upper bound is open now shows as `~C-5` or `C-5~`, and a fully open one as *whole range*, instead of the raw sentinel note. This applies to the Zones trigger overlay, the Meta Layers table and the Advanced Edit patch list.
- **Envelope tabs share one header.** All four envelope tabs (Volume, Pan, Pitch, Filter) now report *present* / *absent* the same way, with *present* in the accent colour.
- **Fixed: a moment of the old position played after seeking.** On hosts without cross-origin isolation — where the engine renders on the audio thread — the look-ahead buffer was never flushed when playback was started, stopped or moved, so audio rendered against the previous position played out first. It is now flushed on every transport change.
- **Fixed: holding a note key machine-gunned the note.** A held piano key was read as the key being struck again and again, so it retriggered on the keyboard's auto-repeat rate and, in record mode, wrote the same note down the rows below it. A held key now sounds once and keeps sounding until you let go, and holding a second key no longer means the first one's release cuts it short.
  - Auto-repeat is ignored however your system reports it, including the older X11 style that reports it as a real release followed by a fresh press. Switching away from the window while a key is down now ends the note too, instead of leaving it sounding.
- **Sample export.** The Samples view's toolbar, the sample DSP editor and the Sample Lab all gain an *Export* button that downloads the sample as a WAV file; the two editors split it into *Export original* and *Export edited*, so you can save a before/after pair without leaving the dialog — *Export original* always downloads the sample exactly as it was when the dialog opened, however many edits you make afterwards.
- **One sample editor.** The Samples view's *Edit…* and *Lab…* buttons are now a single **Edit…** that opens the Sample Lab. Everything the Lab could already do to an imported take — crop, cut, EQ, chop, chord, normalise, fades, gain, mono/stereo — it now does to a sample already in your project.
- **Replace a sample in place.** The Lab, opened on a sample from the Samples view, commits two ways: **Import as new** as before, or **Replace**, which writes the edit back over the pooled sample so every instrument using it plays the new audio. Replacing asks first and lists the instruments it will reach, and one Ctrl+Z puts everything back.
  - The length may change. A crop, a cut or a resample re-places the sample in the pool and every instrument and patch bound to it follows, with each one's play and loop points carried through the edits you made — crop the front off a looping sample and its loop moves with the sound instead of pointing at the wrong place.
  - Rename it in the same step: type in the Lab's **Name** field before pressing Replace.
  - **→ Mono** then Replace folds a stereo sample down to one channel and hands the right channel's bytes back to the sample pool.
  - Two things Replace refuses rather than guess at: turning a mono sample stereo (import that as new, so the instrument gets a proper stereo patch), and changing the length of a sample whose bytes overlap another sample's.
  - When the Lab opens on a sample in the project, its loop region is shaded on the waveform and moves as you edit, so you can see where Replace will leave it.
- **Fixed: zoomed-out waveforms in the Sample Lab and the chord maker were drawn as floating hairlines.** Wherever a whole column of the waveform sat on one side of the zero line — a decay tail, anything with an offset — the display drew only the thin span between that column's loudest and quietest sample, hanging in space. Every sample display now fills each column from the zero line out to its peak, as the Samples view always did. The waveform thumbnail on the Instruments view's Zones tab is drawn the same way now.
- **The engine renders at 48 kHz.** It used to render 32 kHz and stretch that up to whatever rate your browser's audio runs at, one sample at a time — a resampling stage that sat on every note you heard and on every WAV you exported. The engine now renders at the rate the audio device actually wants, so nothing is stretched at all: playback and a 48 kHz export leave the mixer and arrive untouched. Everything that follows from the rate — tick length, the IT and SoundFont filters, the Amiga 500 low-pass and the LED filter — is worked out for the new rate, so songs play at the same speed and the filters sit at the same frequencies as before; what changes is that the top of the spectrum is no longer smeared by the stretch. Exports at other rates (44.1, 96, 32 kHz) are still resampled, as they must be.
- **Buttons draw their symbols as vectors.** Play, stop, record, undo, redo, reload, theme, export, new-tab, heart, the pattern steppers, the File tab's rename / download / delete, the master strip's hide, the metainstrument breadcrumb, the Sample Lab's mono/stereo and EQ toggle — all were text characters, and several of those code points are missing from the stock fonts on some phones and tablets, where the button showed an empty box or nothing at all. They are drawings now, so they render identically everywhere and follow the theme's colours.
  - The sample marker fields read **loop start** and **loop end** instead of the arrow symbols they shared.
- **Fixed: the record button was greyed out at all times, and never showed when record mode was on.** Its highlighted state had been commented out of the stylesheet, leaving only the dimmed one, so the button read as disabled whether the editor was recording or not. It is an ordinary button when idle now, and goes red — dot, label and all — while record mode is on.
- **Fixed: pressing Enter did whatever the last button you clicked did.** Clicking a button left it holding the keyboard, so Enter pressed it again — opening the dialog you had just closed instead of starting playback. Enter is the transport key again, wherever you last clicked.
- **The manual is clearer about full volume being 3F.** That is 63, and it is not a step short of the 64 a ScreamTracker screen shows: ST3 clamps its own 64 to 63, so an imported song keeps its full dynamic range. The Note Effects and conversion documents say the same, for anyone writing a converter.
- **A welcome screen.** With nothing open, the Timeline tab is a proper first screen instead of a line of grey text. *Start* has New project, Open and Import MIDI, plus links to the manual and the shortcut list; *Recent projects* lists everything in your browser's storage with the one you touched last at the top, and a click opens it; *What's new* shows the newest entries below, read straight from this page so it is never out of date; and a banner at the foot asks, once, for a coffee or a sponsorship.
  - The *Donate* and *Sponsor* buttons have left the top bar in favour of that banner. Both are still in the About box, where clicking the Microtone logo has always put them.
- **Fixed: with nothing loaded, opening the File tab was a one-way trip.** The Timeline tab did nothing without a project, so there was no way back to it. It now carries the welcome screen and stays live — on the tab or on F1 — and the tabs that really do need a project are greyed out until there is one.
  
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
