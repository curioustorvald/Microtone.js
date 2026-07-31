// Jam (audition) keyboard: held piano keys → worklet jamNote on the cursor
// channel; releasing the last held key stops the audition. Single-voice,
// last-key-wins (taut's cursor-channel jam model).

import { JAM_SEMIS, semiToNoteInTable } from "./edit.js";

// Hosts that deliver hardware autorepeat as a keyup+keydown PAIR (X11 without
// detectable autorepeat) give no way to tell the phantom release from a real
// one at the instant it lands — the only tell is the keydown that follows in
// the same input burst. So a release waits this long for its partner before it
// takes effect. Nothing human re-strikes a key inside 30 ms, and a note-off
// that late is inaudible; browsers that set `repeat` never pay the wait, since
// they send no keyup at all.
const RELEASE_GRACE_MS = 30;

export class JamKeyboard {
  constructor(store) {
    this.store = store;
    this.held = new Set();
    this.octave = 4;
    this.currentInst = 1;
    /** code → timer id for releases still waiting out the grace window. */
    this.releasing = new Map();
    /** 0 releases synchronously (tests, and hosts known to set `repeat`). */
    this.releaseGraceMs = RELEASE_GRACE_MS;
  }

  /** keydown → true when consumed (a piano key). */
  down(code, repeat) {
    if (!(code in JAM_SEMIS)) return false;
    // The keydown half of a phantom repeat pair: the note never stopped, so
    // calling the pending release off is the whole job.
    this._cancelRelease(code);
    // A held key is one note: autorepeat must not retrigger it. `held` is the
    // backstop for hosts that leave `repeat` unset on the synthesised events.
    if (repeat || this.held.has(code)) return true;
    this.held.add(code);
    const audio = this.store.audio;
    if (audio) {
      const note = semiToNoteInTable(this.octave, JAM_SEMIS[code], this.store.pitchPreset);
      // Pure audition on the DOM views (Instruments/Samples) may snap a strict
      // metainstrument to a note it can actually sound (item 51); note-entry
      // views keep the exact pitch.
      const audition = this.store.view === "instruments" || this.store.view === "samples";
      audio.jamNote(0, this.store.cursor.ch, note, this.currentInst, audition);
    }
    return true;
  }

  /**
   * Audition a note the grid editor just entered, tracked under its key `code`
   * so record-mode entry obeys the same piano rules as a plain jam: last key
   * wins, and only the release of the LAST held key stops the voice.
   */
  hold(code, note, ch) {
    if (code in JAM_SEMIS) {
      this._cancelRelease(code);
      this.held.add(code);
    }
    this.store.audio?.jamNote(0, ch, note, this.currentInst);
  }

  up(code) {
    if (!(code in JAM_SEMIS)) return false;
    if (!this.held.has(code)) {
      // Not ours to release (a jam issued by some other path): keep the old
      // safety net so its voice can never be left sounding.
      if (this.held.size === 0) this.store.audio?.jamStop(0);
      return true;
    }
    this._cancelRelease(code);
    if (this.releaseGraceMs > 0) {
      this.releasing.set(code, setTimeout(() => {
        this.releasing.delete(code);
        this._release(code);
      }, this.releaseGraceMs));
    } else {
      this._release(code);
    }
    return true;
  }

  /** Drop every held key at once — a focus loss ends the gesture (no keyup). */
  allUp() {
    for (const code of this.releasing.keys()) clearTimeout(this.releasing.get(code));
    this.releasing.clear();
    const sounding = this.held.size > 0;
    this.held.clear();
    if (sounding) this.store.audio?.jamStop(0);
  }

  _release(code) {
    this.held.delete(code);
    if (this.held.size === 0) this.store.audio?.jamStop(0);
  }

  _cancelRelease(code) {
    const timer = this.releasing.get(code);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.releasing.delete(code);
    }
  }

  octaveDelta(d) {
    this.octave = Math.min(Math.max(this.octave + d, 0), 9);
  }
}
