// DocSync — mirrors document edits into the worklet's playback copy, with the
// exact strategy taut.js proved out against the TSVM device:
//   cues     → eager  (uploadCue on every edit)
//   scalars  → eager  (setBPM / setTickRate / volumes / flags)
//   patterns → lazy   (dirty set, bulk-flushed right before playback starts)
// A full document (re)load pushes everything (audio-system.loadDocument).

export class DocSync {
  constructor(audio, doc, songIndex = 0) {
    this.audio = audio;
    this.doc = doc;
    this.songIndex = songIndex;
    this.dirtyPatterns = new Set();
  }

  /** Push the whole current song to the worklet (load / song switch). */
  loadAll() {
    this.dirtyPatterns.clear();
    this.audio.loadDocument(
      { // adapt Document → the parsed shape loadDocument expects
        is64Channel: this.doc.is64Channel,
        sampleInstImage: this.doc.sampleInstImage,
        songs: this.doc.songs.map((s, i) => i === this.songIndex ? {
          bpm: s.bpm, tickRate: s.tickRate, globalFlags: s.globalFlags,
          globalVolume: s.globalVolume, mixingVolume: s.mixingVolume,
          patterns: s.patterns.map((_, p) => this.doc.patternBytes(this.songIndex, p)),
          cues: s.cues,
        } : null),
        ixmp: this.doc.ixmp,
      },
      this.songIndex,
    );
  }

  /** Route an op's dirty tags to the device-sync strategy. */
  onDirty(tags) {
    for (const tag of tags) {
      if (tag.song !== undefined && tag.song !== this.songIndex) continue;
      switch (tag.kind) {
        case "pattern":
          this.dirtyPatterns.add(tag.pat);
          break;
        case "cue":
          this.audio.uploadCue(tag.cue, this.doc.cueBytes(this.songIndex, tag.cue));
          break;
        case "scalar":
          this.pushScalar(tag.key);
          break;
        case "inst":
          // Instruments sync eagerly — jam must always hear the current edit.
          this.audio.uploadInstrument(tag.slot, this.doc.instRecordBytes(tag.slot));
          break;
        case "bank":
          // Bank import/undo touches the sample pool + many inst records +
          // Ixmp patches at once: re-upload the whole image (which clears all
          // patch state in the engine) then every patch blob, mirroring the
          // loadDocument order.
          this.doc._rebuildInstRegion();
          if (this.doc.sampleInstImage) {
            this.audio.uploadSampleInstImage(this.doc.sampleInstImage);
            for (const e of this.doc.ixmp) {
              this.audio.uploadInstrumentPatches(e.instId, e.blob);
            }
          }
          break;
      }
    }
  }

  pushScalar(key) {
    const s = this.doc.songs[this.songIndex];
    switch (key) {
      case "bpm": this.audio.setBPM(0, s.bpm); break;
      case "tickRate": this.audio.setTickRate(0, s.tickRate); break;
      case "globalVolume": this.audio.setSongGlobalVolume(0, s.globalVolume); break;
      case "mixingVolume": this.audio.setSongMixingVolume(0, s.mixingVolume); break;
      case "globalFlags": this.audio.setTrackerMixerFlags(0, s.globalFlags); break;
      // tuning fields have no device state (editor-only)
    }
  }

  /** Flush lazily-dirty patterns; call right before starting playback. */
  flushPatterns() {
    for (const pat of this.dirtyPatterns) {
      this.audio.uploadPattern(pat, this.doc.patternBytes(this.songIndex, pat));
    }
    this.dirtyPatterns.clear();
  }
}
