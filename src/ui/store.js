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
    this._subs = new Map();
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
