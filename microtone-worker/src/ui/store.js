// App state + tiny event emitter. Topics: "doc" (loaded/replaced),
// "edit" (dirty tags), "view", "cursor", "transport", "mutes", "fx2".

/** Panes the Patterns view can hold — the fx2 flags are kept per pane INDEX so
 *  they survive the pane churn a viewport resize causes (pattern.js MAX_PANES). */
const FX2_PANES = 16;

export class Store {
  constructor() {
    this.doc = null;         // Document
    this.sync = null;        // DocSync
    this.undo = null;        // UndoStack
    this.audio = null;       // AudioSystem
    this.songIndex = 0;
    this.view = "timeline";
    this.fileName = null;
    this.follow = true;
    /** #998.3: monitor surround songs through the binaural head model. Default
     *  on — the stereo fold cannot render height at all. Stereo songs ignore it. */
    this.binaural = true;
    this.cursor = { row: 0, ch: 0 }; // absolute song row + channel
    this.voiceMutes = new Array(64).fill(false); // per-channel mute (UI + engine)
    // Format v3's SECOND effect column (§5.5), exposed per channel (Timeline)
    // and per pane (Patterns). Hidden by default: most songs never use it, and
    // it costs six characters of a column that is already the widest thing on
    // screen. View state, not document state — nothing here is saved.
    this.fx2Chans = new Array(64).fill(false);
    this.fx2Panes = new Array(FX2_PANES).fill(false);
    this._subs = new Map();
  }

  // ── the second effect column ──
  /** Is the column exposed on channel `ch`? Only a v3 document HAS one. */
  fx2Chan(ch) { return this.wideCells() && this.fx2Chans[ch] === true; }
  /** …and the same question for Patterns-view pane `i`. */
  fx2Pane(i) { return this.wideCells() && this.fx2Panes[i] === true; }
  wideCells() { return this.doc?.wideCells === true; }

  /** Is it exposed ANYWHERE? Drives the toolbox button's on/off label, and the
   *  Patterns view's column-width budget. */
  fx2Any() {
    if (!this.wideCells()) return false;
    return this.fx2Chans.some(Boolean) || this.fx2Panes.some(Boolean);
  }

  toggleFx2Chan(ch) {
    this.fx2Chans[ch] = !this.fx2Chans[ch];
    this.emit("fx2");
  }

  toggleFx2Pane(i) {
    this.fx2Panes[i] = !this.fx2Panes[i];
    this.emit("fx2");
  }

  /** Show/hide the column EVERYWHERE — every channel and every pattern pane. */
  setAllFx2(on) {
    this.fx2Chans.fill(on);
    this.fx2Panes.fill(on);
    this.emit("fx2");
  }

  /** Project switch: back to hidden, like the mutes (taut finishLoadCommon). */
  clearFx2() {
    this.fx2Chans.fill(false);
    this.fx2Panes.fill(false);
    this.emit("fx2");
  }

  setVoiceMute(ch, muted) {
    this.voiceMutes[ch] = muted;
    this.audio?.setVoiceMute(0, ch, muted);
  }

  toggleMute(ch) {
    this.setVoiceMute(ch, !this.voiceMutes[ch]);
    this.emit("mutes");
  }

  /** taut toggleSolo: mute everything but ch; when ch is ALREADY the solo
   *  (all others muted), unmute all instead. */
  toggleSolo(ch) {
    const n = this.doc?.channelCount ?? 64;
    let inSolo = true;
    for (let i = 0; i < n; i++) {
      if (i !== ch && !this.voiceMutes[i]) { inSolo = false; break; }
    }
    for (let i = 0; i < n; i++) this.setVoiceMute(i, inSolo ? false : i !== ch);
    this.emit("mutes");
  }

  /** Re-push every channel's mute to the engine and repaint. Used when
   *  something has rewritten the whole array rather than toggled one channel —
   *  a channel insert shifts the mutes along with the patterns they belong to,
   *  and its undo shifts them back. */
  syncVoiceMutes() {
    for (let i = 0; i < 64; i++) this.audio?.setVoiceMute(0, i, this.voiceMutes[i] === true);
    this.emit("mutes");
  }

  /** Song/project switch: clear all mutes (taut finishLoadCommon). */
  clearMutes() {
    for (let i = 0; i < 64; i++) {
      if (this.voiceMutes[i]) this.setVoiceMute(i, false);
    }
    this.emit("mutes");
  }

  on(topic, fn) {
    if (!this._subs.has(topic)) this._subs.set(topic, new Set());
    this._subs.get(topic).add(fn);
    return () => this._subs.get(topic).delete(fn);
  }

  emit(topic, payload) {
    const subs = this._subs.get(topic);
    if (subs) for (const fn of subs) fn(payload);
  }

  get song() { return this.doc?.songs[this.songIndex] ?? null; }

  /** Row-highlight divisions from the song's sMet (defaults 4/16). */
  beats() {
    const sm = this.doc?.meta.songMeta[this.songIndex];
    return {
      pri: sm?.beatPri > 0 ? sm.beatPri : 4,
      sec: sm?.beatSec > 0 ? sm.beatSec : 16,
    };
  }
}
