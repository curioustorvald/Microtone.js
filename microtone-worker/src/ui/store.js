// App state + tiny event emitter. Topics: "doc" (loaded/replaced),
// "edit" (dirty tags), "view", "cursor", "transport".

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
    this.cursor = { row: 0, ch: 0 }; // absolute song row + channel
    this.voiceMutes = new Array(64).fill(false); // per-channel mute (UI + engine)
    this._subs = new Map();
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
