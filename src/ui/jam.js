// Jam (audition) keyboard: held piano keys → worklet jamNote on the cursor
// channel; releasing the last held key stops the audition. Single-voice,
// last-key-wins (taut's cursor-channel jam model).

import { JAM_SEMIS, semiToNote } from "./edit.js";

export class JamKeyboard {
  constructor(store) {
    this.store = store;
    this.held = new Set();
    this.octave = 4;
    this.currentInst = 1;
  }

  /** keydown → true when consumed (a piano key). */
  down(code, repeat) {
    if (!(code in JAM_SEMIS)) return false;
    if (repeat) return true;
    this.held.add(code);
    const audio = this.store.audio;
    if (audio) {
      const note = semiToNote(this.octave, JAM_SEMIS[code]);
      audio.jamNote(0, this.store.cursor.ch, note, this.currentInst);
    }
    return true;
  }

  up(code) {
    if (!(code in JAM_SEMIS)) return false;
    this.held.delete(code);
    if (this.held.size === 0) this.store.audio?.jamStop(0);
    return true;
  }

  octaveDelta(d) {
    this.octave = Math.min(Math.max(this.octave + d, 0), 9);
  }
}
