// Auditioning raw pool bytes (item 175) — Web Audio, not the tracker engine.
//
// The map view lets you drag a window out of memory and cut an instrument from
// it. Doing that blind is guesswork, so the window has to be audible BEFORE it
// becomes anything, and the bytes being auditioned belong to no instrument yet
// — there is nothing for the engine to trigger. So the preview is a plain
// AudioBufferSourceNode over a copy of the bytes: it plays whether or not the
// song is playing, it cannot disturb engine state, and stopping it is a
// `stop()` rather than a voice-allocation problem.
//
// The context is BORROWED from the AudioSystem when there is one, so a phone
// is not asked for a second audio device; before audio has ever started (the
// Samples tab is usable from a cold load) a private one is made on the first
// play, which is always inside a click and therefore allowed to start.

/** AudioBuffer sample rates are clamped to this range by the spec; a rate
 *  outside it is carried on `playbackRate` instead, so pitch is preserved. */
const BUF_RATE_MIN = 8000;
const BUF_RATE_MAX = 96000;

export class SamplePreview {
  /** @param getSharedContext () => AudioContext | null | undefined */
  constructor(getSharedContext = () => null) {
    this.getSharedContext = getSharedContext;
    this.ctx = null;        // the private context, made only if needed
    this.playing = null;    // {src, t0, frames, rate, loop, meta}
    this.onChange = null;   // called when playback starts or stops
  }

  /** True while something is sounding. */
  get active() { return this.playing !== null; }

  /** Whatever the caller attached to the current playback (the map uses it to
   *  put the playhead back at the right pool address). */
  get meta() { return this.playing?.meta ?? null; }

  context() {
    const shared = this.getSharedContext();
    if (shared) return shared;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    return this.ctx;
  }

  /**
   * Play `chans` (Float32Array per channel, all the same length) at `rate`.
   * `loop` repeats until stopped; `meta` is handed back through `meta`/`frame`.
   * Returns false when there is no Web Audio to play it through.
   */
  play(chans, rate, { loop = false, meta = null } = {}) {
    this.stop();
    const actx = this.context();
    if (!actx || !chans.length || !chans[0].length) return false;
    if (actx.state === "suspended") actx.resume();
    const srcRate = Math.max(1, rate | 0);
    const bufRate = Math.max(BUF_RATE_MIN, Math.min(BUF_RATE_MAX, srcRate));
    const ab = actx.createBuffer(chans.length, chans[0].length, bufRate);
    chans.forEach((c, i) => ab.getChannelData(i).set(c));
    const src = actx.createBufferSource();
    src.buffer = ab;
    src.playbackRate.value = srcRate / bufRate;
    src.loop = loop;
    src.connect(actx.destination);
    src.start();
    this.playing = { src, t0: actx.currentTime, frames: chans[0].length, rate: srcRate, loop, meta };
    src.onended = () => { if (this.playing?.src === src) this.stop(); };
    this.onChange?.();
    return true;
  }

  stop() {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    try { p.src.onended = null; p.src.stop(); } catch { /* already ended */ }
    this.onChange?.();
  }

  /**
   * How far into the played window the playhead is, in FRAMES, or -1 when
   * nothing is sounding. A looping preview wraps, which is what makes a loop
   * point judgeable by eye as well as by ear.
   */
  frame() {
    const p = this.playing;
    const actx = this.getSharedContext() ?? this.ctx;
    if (!p || !actx) return -1;
    const at = (actx.currentTime - p.t0) * p.rate;
    if (at < 0) return -1;
    if (!p.loop) return at <= p.frames ? at : -1;
    return at % p.frames;
  }

  /** Drop the private context (nothing to do when the shared one was used). */
  dispose() {
    this.stop();
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* already closed */ }
      this.ctx = null;
    }
  }
}
