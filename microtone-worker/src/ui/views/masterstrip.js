// Master channel strip (item 98) — the mastering view, docked to the right of
// the Timeline grid: a stack of scope panels over one fader + meter.
//
// Everything it draws comes from the engine's analysis tap (src/engine/
// analysis.js) through the snapshot, and the two kinds of panel ask different
// questions of it:
//
//   * the SCOPES read the first-order B-format ring, so they show the sound
//     FIELD and never a particular speaker set. Their axes are literally the
//     field's own: left-right is Y, front-back is X, up-down is Z. A stereo
//     song has no front-back axis at all, so its vertical is the mono sum W —
//     which is exactly the classic mid/side goniometer, drawn by the same code.
//   * the METERS read a metering TARGET you pick, rendered through the same
//     renderers the exporter uses. What the bars say is what the file will hold.
//
// The fader is the SONG's global volume, not a monitor gain: effects V and W
// move it while the song plays and the cap follows them, but letting go of the
// mouse writes the project's value (one undo step per drag), and stopping
// playback snaps the cap back to it.
//
// ── Layout ──
// A scope panel is a FIXED size — chooser, square dial, correlation bar — set
// by the strip's width, so how many of them fit is a question about the
// viewport's height. The meter panel takes the rest and is dragged to size by
// the divider above it; every panel that fits above it is drawn, and the
// chooser's own "hide this panel" entry drops just that one (the ✕ in the
// header hides the whole strip). "+" adds one back whenever there is room.

import {
  ANALYSIS_OFF, ANALYSIS_STEREO, ANALYSIS_AMBISONIC,
  SCOPE_FRAMES, SCOPE_CHANNELS, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
  availableTargets, meterDisplay, makeAnalysisReadout,
} from "../../engine/analysis.js";
import {
  AZIMUTH_TURN, ELEVATION_QUARTER, SURROUND_STEREO, SURROUND_SPATIAL,
} from "../../engine/spatial.js";
import { setSongScalarOp } from "../../doc/ops.js";
import { themeColors } from "../theme.js";
import { paintSpatialDot } from "../spatialdot.js";
import { t } from "../i18n.js";

const PREF_KEY = "microtone-masterstrip";

/** Scope kinds. HIDE is the chooser's own "drop this panel" entry. */
export const SCOPE_BLOBS = "blobs";
export const SCOPE_TOP = "top";
export const SCOPE_FRONT = "front";
export const SCOPE_SIDE = "side";
export const SCOPE_HIDE = "hide";

/** Meter scale, in dBFS. Above 0 exists because an object bus is not clamped. */
export const METER_MIN_DB = -60;
export const METER_MAX_DB = 6;

/** Panel geometry (CSS px). The chooser and correlation bar are fixed; the dial
 *  is square, so the strip's WIDTH decides a scope panel's height. */
export const SCOPE_SELECT_H = 22;
export const SCOPE_CORR_H = 9;
export const SPLIT_H = 7;
export const METER_MIN_H = 112;
/** The strip's own padding, top and bottom (CSS .master-strip). */
export const STRIP_PAD = 4;
/** Enough panels for any plausible screen; they are built once and shown/hidden. */
export const MAX_SCOPE_PANELS = 6;

/** How much of the ring one cloud shows. The whole of it: 128 ms at 32 kHz. */
const TRACE_FRAMES = SCOPE_FRAMES;
/** Density curve — alpha = 1 − e^(−k·hits), so one hit is faint and a dozen saturate. */
const CLOUD_K = 0.50;
/** …calibrated for this many points, and scaled down when more are drawn, so
 *  widening the window makes the cloud FULLER rather than a solid disc. */
const CLOUD_REF_FRAMES = 1024;

// ── pure helpers (unit-tested in test/node/analysis.test.js) ───────────────

/** Amplitude → dBFS, with a floor rather than −Infinity. */
export function dbfs(v) {
  const a = v < 0 ? -v : v;
  return a <= 0 ? METER_MIN_DB - 1 : 20 * Math.log10(a);
}

/** dBFS → 0 (bottom of the scale) … 1 (top), clamped. */
export function meterFrac(db) {
  const f = (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Phase correlation of the interval's sums: +1 identical, 0 uncorrelated, −1
 * anti-phase. Silence reads +1 (nothing wrong with it) rather than 0/0.
 */
export function correlation(ll, rr, lr) {
  const d = Math.sqrt(ll * rr);
  if (!(d > 1e-20)) return 1;
  const c = lr / d;
  return c < -1 ? -1 : c > 1 ? 1 : c;
}

/** Height of one scope panel in a strip whose panels are `width` px wide. */
export function scopePanelHeight(width) {
  return SCOPE_SELECT_H + Math.max(48, width) + SCOPE_CORR_H;
}

/** How many scope panels fit above a meter panel of `meterH`. */
export function scopePanelsThatFit(stripH, headH, meterH, panelH) {
  if (!(panelH > 0)) return 0;
  return Math.max(0, Math.min(MAX_SCOPE_PANELS,
    Math.floor((stripH - headH - meterH - SPLIT_H) / panelH)));
}

/** "#rgb" / "#rrggbb" / "rgb(…)" → [r, g, b]; anything else → mid grey. */
export function parseInk(css) {
  const s = String(css ?? "").trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
    if (h.length >= 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((x) => parseInt(x, 10));
    if (p.length >= 3 && p.every((x) => Number.isFinite(x))) return p.slice(0, 3);
  }
  return [128, 128, 128];
}

/** Hits landing on one pixel → ink alpha. Saturating, so density reads as density. */
export function densityAlpha(hits, k = CLOUD_K) {
  return hits <= 0 ? 0 : 1 - Math.exp(-k * hits);
}

/** Every scope kind, in the order a newly added panel is offered one. */
export const SCOPE_KINDS = [SCOPE_BLOBS, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE];

/**
 * Which scope kinds a surround model can express. Z is identically zero unless
 * the song is spatial, so the two vertical-plane views would be flat lines —
 * item 98's "nonsensical options are hidden".
 */
export function availableScopes(model) {
  return model === SURROUND_SPATIAL
    ? [SCOPE_BLOBS, SCOPE_TOP, SCOPE_FRONT, SCOPE_SIDE]
    : [SCOPE_BLOBS, SCOPE_TOP];
}

/**
 * What each panel actually SHOWS, given what the user asked for — one entry per
 * wish, `null` where the panel cannot be shown at all.
 *
 * `scopes` is a list of WISHES and is never rewritten: the strip is built
 * before any song is loaded (so the model reads stereo) and the song can change
 * model later, and a panel asking for the side view must still be asking for it
 * when a spatial song finally arrives. Overwriting the wishes was the bug where
 * four configured panels came back from a reload as several copies of one view.
 *
 * A wish the model cannot express falls back to the first kind no earlier panel
 * is showing; once those run out the panel is dropped (null) rather than
 * repeating a view — a stereo song has exactly two things worth looking at.
 * A wish that IS expressible is always shown, so two panels can deliberately
 * show the same thing if that is what was asked for.
 */
export function effectiveScopes(scopes, model) {
  const kinds = availableScopes(model);
  const out = [];
  for (const wish of scopes) {
    if (kinds.includes(wish)) out.push(wish);
    else out.push(kinds.find((k) => !out.includes(k)) ?? null);
  }
  return out;
}

/**
 * The B-format components a Lissajous kind plots, as {h, v} ring indices, plus
 * the labels for the four edges. `stereoSong` swaps the top view's vertical
 * from front-back (which it does not have) to the mono sum.
 */
export function scopeAxes(kind, stereoSong) {
  switch (kind) {
    case SCOPE_TOP:
      return stereoSong
        ? { h: SCOPE_Y, v: SCOPE_W, left: "L", right: "R", top: "M", bottom: "−M" }
        : { h: SCOPE_Y, v: SCOPE_X, left: "L", right: "R", top: "F", bottom: "B" };
    case SCOPE_FRONT:
      return { h: SCOPE_Y, v: SCOPE_Z, left: "L", right: "R", top: "U", bottom: "D"};
    case SCOPE_SIDE:
      return { h: SCOPE_X, v: SCOPE_Z, left: "F", right: "B", top: "U", bottom: "D" };
    default:
      return null;
  }
}

/**
 * Meter ballistics — one channel's moving state. The engine ships sums per
 * snapshot interval; the LOOK (integration, peak hold and fall, clip hold) is
 * the display's business and lives here.
 */
export class MeterBallistics {
  constructor() { this.reset(); }

  reset() {
    this.rms = 0;        // mean square, leaky-integrated
    this.peakDb = METER_MIN_DB - 1;
    this.holdMs = 0;
    this.clipped = false;
  }

  /** Clear the clip latch. Only a fresh playback does this — see `update`. */
  clearClip() { this.clipped = false; }

  /**
   * @param {number} meanSquare mean square over the interval
   * @param {number} peak       true peak over the interval (amplitude)
   * @param {boolean} clipped   any sample at/over full scale
   * @param {number} dtMs       wall time since the previous update
   */
  update(meanSquare, peak, clipped, dtMs) {
    // ~300 ms RMS window, frame-rate independent.
    const a = 1 - Math.exp(-dtMs / 300);
    this.rms += (meanSquare - this.rms) * a;
    const db = dbfs(peak);
    if (db >= this.peakDb) {
      this.peakDb = db;
      this.holdMs = 1200;
    } else if (this.holdMs > 0) {
      this.holdMs -= dtMs;
    } else {
      this.peakDb -= (dtMs / 1000) * 20; // 20 dB/s fall
    }
    if (this.peakDb < METER_MIN_DB - 1) this.peakDb = METER_MIN_DB - 1;
    // The clip lamp LATCHES: one clipped sample anywhere in a take is something
    // you have to be told about, and a lamp that times out is one you can miss
    // while looking at the grid. Starting playback again clears it.
    if (clipped) this.clipped = true;
  }

  rmsDb() { return dbfs(Math.sqrt(this.rms)); }
  clipping() { return this.clipped; }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private mode / corrupt */ }
  return {};
}

// ── the strip ─────────────────────────────────────────────────────────────

export class MasterStrip {
  constructor(store, el) {
    this.store = store;
    this.el = el;
    const p = loadPrefs();
    this.visible = p.visible !== false; // item 98: visible by default
    this.scopes = Array.isArray(p.scopes) && p.scopes.length
      ? p.scopes.slice(0, MAX_SCOPE_PANELS)
      : [SCOPE_BLOBS, SCOPE_TOP];
    // Default chosen so two scope panels and a usable meter fit an ordinary
    // window; the divider moves it from there.
    this.meterH = typeof p.meterH === "number" ? p.meterH : 160;
    this.savedTarget = p.target ?? null;
    this.target = ANALYSIS_STEREO;

    this.readout = makeAnalysisReadout();
    this.meters = Array.from({ length: 10 }, () => new MeterBallistics());
    this.field = new MeterBallistics();
    this.corr = 1;
    // What each panel shows, and the panel → wish map; refreshControls owns both.
    this.effective = this.scopes.slice();
    this.slots = this.scopes.map((_, i) => i);
    this._wasPlaying = false;
    this.scopeGain = new Array(MAX_SCOPE_PANELS).fill(1); // auto-gain per panel
    this.cloud = new Array(MAX_SCOPE_PANELS).fill(null);  // density buffers per panel
    this.lastMs = 0;
    this._tapAudio = null;
    this._tapTarget = null;
    this._drag = null;
    this._split = null;
    this._wheelGesture = null;
    this._wheelAt = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.onToggle = null; // set by the shell so the toolbox button can follow

    this.build();
    store.on("doc", () => { this.pickTarget(); this.refreshControls(); this.applyVisibility(); });
    store.on("view", () => this.applyVisibility());
    // The surround model decides which targets and which scopes exist at all.
    store.on("edit", (tags) => {
      if (tags?.some?.((tag) => tag.kind === "scalar" && tag.key === "surroundModel")) {
        this.pickTarget();
        this.refreshControls();
      }
    });
    this.pickTarget();
    this.refreshControls();
    this.applyVisibility();
  }

  // ── DOM ──

  build() {
    this.el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "ms-head";
    this.head = head;
    const title = document.createElement("span");
    title.className = "ms-title";
    title.textContent = t("master.title");
    this.addBtn = document.createElement("button");
    this.addBtn.className = "icon-btn";
    this.addBtn.textContent = "+";
    this.addBtn.title = t("master.addTitle");
    this.addBtn.addEventListener("click", () => this.addScope());
    const close = document.createElement("button");
    close.className = "icon-btn";
    close.textContent = "︎✕";
    close.title = t("master.hideTitle");
    close.addEventListener("click", () => this.setVisible(false));
    head.append(title, this.addBtn, close);
    this.el.appendChild(head);

    this.scopePanel = [];
    this.scopeCanvas = [];
    this.scopeSel = [];
    for (let i = 0; i < MAX_SCOPE_PANELS; i++) {
      const box = document.createElement("div");
      box.className = "ms-scope";
      const sel = document.createElement("select");
      sel.className = "ms-mode";
      sel.addEventListener("change", () => {
        // `i` is the panel's place on screen; the wish it edits is slots[i].
        const wish = this.slots?.[i] ?? i;
        if (sel.value === SCOPE_HIDE) { // drops THIS panel, not the strip
          this.removeScope(wish);
          return;
        }
        this.scopes[wish] = sel.value;
        this.savePrefs();
        this.refreshControls();
      });
      const wrap = document.createElement("div");
      wrap.className = "ms-canvaswrap";
      const cv = document.createElement("canvas");
      wrap.appendChild(cv);
      box.append(sel, wrap);
      this.el.appendChild(box);
      this.scopePanel.push(box);
      this.scopeCanvas.push(cv);
      this.scopeSel.push(sel);
    }

    // The divider doubles as the separator above the meter and its resize grip.
    this.split = document.createElement("div");
    this.split.className = "ms-split";
    this.split.title = t("master.splitTitle");
    this.split.addEventListener("pointerdown", (e) => this.onSplitDown(e));
    this.split.addEventListener("pointermove", (e) => this.onSplitMove(e));
    this.split.addEventListener("pointerup", (e) => this.onSplitUp(e));
    this.split.addEventListener("pointercancel", (e) => this.onSplitUp(e));
    this.split.addEventListener("dblclick", () => { this.meterH = 160; this.layout(); this.savePrefs(); });
    this.el.appendChild(this.split);

    const mbox = document.createElement("div");
    mbox.className = "ms-meterbox";
    const mwrap = document.createElement("div");
    mwrap.className = "ms-canvaswrap";
    this.meterCanvas = document.createElement("canvas");
    mwrap.appendChild(this.meterCanvas);
    // Item 98 note 4: the metering chooser belongs to the meter, at its foot.
    this.targetSel = document.createElement("select");
    this.targetSel.className = "ms-target";
    this.targetSel.title = t("master.targetTitle");
    this.targetSel.addEventListener("change", () => {
      this.target = this.targetSel.value;
      this.savedTarget = this.target;
      this.resetMeters();
      this.savePrefs();
      this.syncTap();
    });
    mbox.append(mwrap, this.targetSel);
    this.el.appendChild(mbox);
    this.meterBox = mbox;

    this.meterCanvas.addEventListener("pointerdown", (e) => this.onFaderDown(e));
    this.meterCanvas.addEventListener("pointermove", (e) => this.onFaderMove(e));
    this.meterCanvas.addEventListener("pointerup", (e) => this.onFaderUp(e));
    this.meterCanvas.addEventListener("pointercancel", (e) => this.onFaderUp(e));
    this.meterCanvas.addEventListener("dblclick", (e) => {
      if (this.faderHit(e)) this.writeVolume(0x80, null);
    });
    this.meterCanvas.addEventListener("wheel", (e) => {
      if (!this.faderHit(e)) return;
      e.preventDefault();
      const step = e.shiftKey ? 8 : 1;
      // A run of wheel clicks is one gesture, so it undoes in one go.
      const now = Date.now();
      if (this._wheelGesture === null || now - this._wheelAt > 600) this._wheelGesture = `wheel:${now}`;
      this._wheelAt = now;
      this.writeVolume(this.volumeValue() + (e.deltaY < 0 ? step : -step), this._wheelGesture);
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  /** Scope panels actually on screen: what this song can show, capped by room. */
  panelCount() {
    const n = this.slots?.length ?? this.scopes.length;
    return Math.min(n, this.fit ?? n);
  }

  addScope() {
    if (this.scopes.length >= MAX_SCOPE_PANELS) return;
    // Ask for a kind nothing else has asked for — from the WHOLE set, not just
    // what this song can show, so adding panels to a stereo song still leaves
    // four distinct views waiting for the day it goes spatial.
    const unused = SCOPE_KINDS.find((k) => !this.scopes.includes(k)) ?? SCOPE_TOP;
    this.scopes.push(unused);
    this.savePrefs();
    this.refreshControls();
    this.layout();
  }

  removeScope(i) {
    this.scopes.splice(i, 1);
    this.savePrefs();
    this.refreshControls();
    this.layout();
  }

  /** Rebuild the choosers for the current song's surround model. */
  refreshControls() {
    const model = this.model();
    const targets = availableTargets(model);
    this.targetSel.innerHTML = "";
    for (const id of targets) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = t(`master.target.${id}`);
      this.targetSel.appendChild(o);
    }
    this.targetSel.value = this.target;
    this.targetSel.disabled = targets.length < 2;

    const kinds = availableScopes(model);
    // What each panel shows now. The wishes in this.scopes are left alone — see
    // effectiveScopes; overwriting them here is what used to lose a saved
    // front/side choice to the stereo model the strip boots with. `slots` maps
    // a panel on screen back to the wish it belongs to.
    this.effective = effectiveScopes(this.scopes, model);
    this.slots = this.effective
      .map((kind, i) => (kind === null ? -1 : i))
      .filter((i) => i >= 0);
    for (let p = 0; p < MAX_SCOPE_PANELS; p++) {
      const sel = this.scopeSel[p];
      if (p >= this.slots.length) continue;
      sel.innerHTML = "";
      for (const k of [...kinds, SCOPE_HIDE]) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = t(`master.scope.${k}`);
        sel.appendChild(o);
      }
      sel.value = this.effective[this.slots[p]];
    }
  }

  /** Default metering target for a freshly loaded song, or the saved one. */
  pickTarget() {
    const targets = availableTargets(this.model());
    if (this.savedTarget && targets.includes(this.savedTarget)) {
      this.target = this.savedTarget;
    } else {
      const m = this.model();
      this.target = m === SURROUND_STEREO ? ANALYSIS_STEREO
        : m === SURROUND_SPATIAL ? ANALYSIS_AMBISONIC : "5.1";
    }
    this.resetMeters();
    this.syncTap();
  }

  model() {
    return this.store.doc?.songs[this.store.songIndex]?.surroundModel ?? SURROUND_STEREO;
  }

  savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        visible: this.visible, scopes: this.scopes, target: this.savedTarget,
        meterH: Math.round(this.meterH),
      }));
    } catch { /* private mode */ }
  }

  resetMeters() {
    for (const m of this.meters) m.reset();
    this.field.reset();
    this.corr = 1;
  }

  /** The one thing that puts the clip lamps out: starting playback again. */
  clearClips() {
    for (const m of this.meters) m.clearClip();
    this.field.clearClip();
  }

  setVisible(on) {
    this.visible = on;
    this.savePrefs();
    this.applyVisibility();
    this.onToggle?.(on);
  }

  toggle() { this.setVisible(!this.visible); return this.visible; }

  /** The strip is a Timeline fixture; anywhere else it is neither shown nor paid for. */
  applyVisibility() {
    const show = this.visible && this.store.view === "timeline" && !!this.store.doc;
    this.el.hidden = !show;
    this.shown = show;
    if (show) this.resize();
    this.syncTap();
  }

  /**
   * Install or drop the engine-side tap. Called whenever anything that decides
   * it changes — including a new AudioSystem, which the frame loop notices.
   */
  syncTap() {
    const audio = this.store.audio;
    const want = this.shown ? this.target : ANALYSIS_OFF;
    if (!audio) { this._tapAudio = null; this._tapTarget = null; return; }
    if (this._tapAudio === audio && this._tapTarget === want) return;
    audio.setAnalysis(0, want);
    this._tapAudio = audio;
    this._tapTarget = want;
  }

  // ── layout ──

  /**
   * Give every panel its height. Scope panels are a fixed size set by the
   * strip's width, the meter takes what the user dragged, and whatever no
   * longer fits is simply not shown (its choice is remembered, so growing the
   * window brings it straight back).
   */
  layout() {
    // clientHeight/Width include the strip's own padding; the panels do not.
    const stripH = this.el.clientHeight - STRIP_PAD * 2;
    const width = this.el.clientWidth - STRIP_PAD * 2;
    if (stripH <= 0 || width <= 0) return;
    const headH = this.head.offsetHeight;
    const panelH = scopePanelHeight(width);

    this.meterH = Math.max(METER_MIN_H, Math.min(this.meterH, stripH - headH - SPLIT_H));
    this.fit = scopePanelsThatFit(stripH, headH, this.meterH, panelH);
    const shown = this.panelCount();
    for (let i = 0; i < MAX_SCOPE_PANELS; i++) {
      const box = this.scopePanel[i];
      box.hidden = i >= shown;
      box.style.height = `${panelH}px`;
    }
    // Scope panels are a fixed size and the meter is the only elastic panel, so
    // it takes everything left over — never less than the dragged height. That
    // makes the divider STEP: drag it up far enough and one more scope fits,
    // whereupon the meter gives that panel its room and keeps the remainder.
    this.meterBox.style.height = `${stripH - headH - SPLIT_H - shown * panelH}px`;
    // "+" only offers itself when it would actually put a panel on screen:
    // there has to be room, and the song has to have a view left to show (a
    // stereo song has two, so a fifth wish would sit invisible).
    const next = SCOPE_KINDS.find((k) => !this.scopes.includes(k)) ?? SCOPE_TOP;
    const wouldDraw = effectiveScopes([...this.scopes, next], this.model())
      .filter((k) => k !== null).length > this.slots.length;
    this.addBtn.hidden = this.scopes.length >= MAX_SCOPE_PANELS ||
      this.fit <= this.slots.length || !wouldDraw;
    this.resizeCanvases();
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.layout();
  }

  resizeCanvases() {
    const dpr = this.dpr;
    for (const cv of [...this.scopeCanvas, this.meterCanvas]) {
      const host = cv.parentElement;
      const w = Math.max(20, host.clientWidth);
      const h = Math.max(20, host.clientHeight);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + "px";
        cv.style.height = h + "px";
      }
    }
  }

  // ── the meter/scope divider ──

  onSplitDown(e) {
    this._split = this.el.getBoundingClientRect();
    this.split.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  onSplitMove(e) {
    if (this._split === null) return;
    this.meterH = this._split.bottom - STRIP_PAD - e.clientY - SPLIT_H / 2;
    this.layout();
  }

  onSplitUp(e) {
    if (this._split === null) return;
    this._split = null;
    this.split.releasePointerCapture?.(e.pointerId);
    this.savePrefs();
  }

  // ── fader ──

  /** Fader geometry in CSS pixels, shared by the painter and the hit test. */
  faderRect() {
    const h = this.meterCanvas.height / this.dpr;
    return { x: 4, y: 18, w: 22, h: Math.max(20, h - 38) };
  }

  faderHit(e) {
    const r = this.faderRect();
    const x = e.offsetX;
    return x >= r.x - 3 && x <= r.x + r.w + 3;
  }

  /** The value the cap sits at: the engine's live one while it plays (V and W
   *  effects move it), the project's own the moment it stops. */
  volumeValue() {
    const song = this.store.doc?.songs[this.store.songIndex];
    const docVol = song?.globalVolume ?? 0x80;
    const audio = this.store.audio;
    if (audio && audio.isPlaying()) {
      const live = audio.getLiveGlobalVolume();
      if (live > 0 || docVol === 0) return Math.round(live);
    }
    return docVol;
  }

  /** Write the PROJECT's global volume (undoable; DocSync pushes it live). */
  writeVolume(value, gestureId) {
    const v = Math.max(0, Math.min(255, Math.round(value)));
    const song = this.store.doc?.songs[this.store.songIndex];
    if (!song || !this.store.undo) return;
    if (song.globalVolume === v && gestureId === null) return;
    this.store.undo.apply(setSongScalarOp(this.store.songIndex, "globalVolume", v, gestureId));
  }

  faderValueAt(offsetY) {
    const r = this.faderRect();
    const f = 1 - (offsetY - r.y) / r.h;
    return (f < 0 ? 0 : f > 1 ? 1 : f) * 255;
  }

  onFaderDown(e) {
    if (!this.faderHit(e)) return;
    this._drag = `fader:${Date.now()}`;
    this.meterCanvas.setPointerCapture?.(e.pointerId);
    this.writeVolume(this.faderValueAt(e.offsetY), this._drag);
  }

  onFaderMove(e) {
    if (this._drag === null) return;
    this.writeVolume(this.faderValueAt(e.offsetY), this._drag);
  }

  onFaderUp(e) {
    if (this._drag === null) return;
    this._drag = null;
    this.meterCanvas.releasePointerCapture?.(e.pointerId);
  }

  // ── per-frame ──

  frame() {
    if (!this.shown) return;
    this.syncTap(); // a rebuilt AudioSystem needs the tap again
    const now = performance.now();
    const dt = this.lastMs === 0 ? 16 : Math.min(now - this.lastMs, 250);
    this.lastMs = now;

    const audio = this.store.audio;
    if (audio) {
      // A clip lamp stays lit until the next take starts — this is the edge
      // that puts it out.
      const playing = audio.isPlaying();
      if (playing && !this._wasPlaying) this.clearClips();
      this._wasPlaying = playing;

      const r = audio.readAnalysis(this.readout);
      if (r.frames > 0) {
        this.corr = correlation(r.corrLL, r.corrRR, r.corrLR);
        // The field bar reads item 98's pair literally: RMS is the energy
        // density of the encoded field, peak is the worst true peak any encoded
        // channel reached (that is what would clip the exported file).
        let worst = 0;
        let anyClip = false;
        for (let c = 0; c < r.meterCount; c++) {
          if (r.truePeak[c] > worst) worst = r.truePeak[c];
          if (r.clip[c] > 0) anyClip = true;
          this.meters[c].update(r.meanSquare[c], r.truePeak[c], r.clip[c] > 0, dt);
        }
        this.field.update(r.fieldEnergy / r.frames, worst, anyClip, dt);
      } else {
        // Nothing rendered this interval (stopped): let everything fall away.
        this.field.update(0, 0, false, dt);
        for (const m of this.meters) m.update(0, 0, false, dt);
      }
    }

    const C = themeColors();
    const n = this.panelCount();
    for (let i = 0; i < n; i++) this.drawScope(i, C);
    this.drawMeters(C);
  }

  // ── scopes ──

  drawScope(i, C) {
    const cv = this.scopeCanvas[i];
    const ctx = cv.getContext("2d");
    const dpr = this.dpr;
    const W = cv.width / dpr;
    const H = cv.height / dpr;
    if (W < 4 || H < 4) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, W, H);

    const pad = 12;
    const boxH = H - SCOPE_CORR_H - 3;
    const r = Math.max(8, Math.min(W - pad * 2, boxH - pad * 2) / 2);
    const cx = W / 2;
    const cy = boxH / 2;

    // Dial: the horizon circle, the axes and the listener at the centre.
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = C.meterBg;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    const kind = this.effective?.[this.slots?.[i] ?? i] ?? this.scopes[i];
    const stereoSong = this.model() === SURROUND_STEREO;
    const axes = scopeAxes(kind, stereoSong);
    if (kind === SCOPE_BLOBS) this.drawBlobs(ctx, C, cx, cy, r);
    else if (axes) this.drawCloud(ctx, C, cx, cy, r, axes, i);

    // Edge labels — which way is which (item 98: "all four label the direction").
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillStyle = C.dim;
    // The blobs dial is a MAP — its vertical is where the sources are, front to
    // back, even in a stereo song (whose sources all sit on the front arc).
    const lab = axes ?? { left: "L", right: "R", top: "F", bottom: "B" };
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(lab.left, cx - r - 10, cy);
    ctx.textAlign = "right";
    ctx.fillText(lab.right, cx + r + 10, cy);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(lab.top, cx, cy - r - 10);
    ctx.textBaseline = "bottom";
    ctx.fillText(lab.bottom, cx, cy + r + 11);

    this.drawCorrelation(ctx, C, 6, H - SCOPE_CORR_H, W - 12, SCOPE_CORR_H - 3);
  }

  /**
   * The tracker-friendly view: one dot per sounding channel where the engine
   * actually has it, not a waveform. Same dial and the same height cue as the
   * Panner and the channel radars, so a source reads the same everywhere.
   */
  drawBlobs(ctx, C, cx, cy, r) {
    const audio = this.store.audio;
    if (!audio) return;
    const spatial = this.model() === SURROUND_SPATIAL;
    const n = Math.min(audio.channelCount(), 64);
    for (let ch = 0; ch < n; ch++) {
      if (!audio.getVoiceActive(ch)) continue;
      const vol = audio.getVoiceEffectiveVolume(ch);
      if (vol <= 0.002) continue;
      const az = audio.getVoiceAzimuth(ch);
      const el = audio.getVoiceElevation(ch);
      const k = Math.cos((el * Math.PI) / (2 * ELEVATION_QUARTER));
      const rad = ((az - 128) * 2 * Math.PI) / AZIMUTH_TURN;
      const x = cx + Math.sin(rad) * k * r;
      const y = cy - Math.cos(rad) * k * r;
      const dotR = 1.5 + 4 * Math.min(vol * 2, 1);
      if (spatial) paintSpatialDot(ctx, x, y, el, r, dotR, C.accent2);
      else {
        ctx.fillStyle = C.accent2;
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * The vectorscope proper: the ring's samples as a CLOUD, one point each,
   * accumulated into a density buffer so that where the trace passes again and
   * again the ink builds up — a phosphor screen's own way of saying "most of
   * the energy is here". Each sample is splatted bilinearly, so the cloud stays
   * smooth instead of aliasing onto whole pixels.
   *
   * Auto-gained the way a hardware vectorscope is: the display is about SHAPE —
   * where the energy sits and whether the two sides agree — and a mix sitting at
   * a sane −20 dBFS would otherwise be a speck in the middle. The meters are the
   * absolute reading, so the gain is shown rather than hidden.
   */
  drawCloud(ctx, C, cx, cy, r, axes, slot) {
    const audio = this.store.audio;
    if (!audio) return;
    const ring = audio.scopeRing();
    const write = this.readout.ringWrite;
    const count = Math.min(TRACE_FRAMES, SCOPE_FRAMES);
    const hSign = axes.flipH ? 1 : -1; // +Y is LEFT on screen, +X is FRONT (up)

    let peak = 0;
    for (let k = 0; k < count; k++) {
      const o = ((write - count + k + SCOPE_FRAMES * 2) % SCOPE_FRAMES) * SCOPE_CHANNELS;
      const a = Math.abs(ring[o + axes.h]);
      const b = Math.abs(ring[o + axes.v]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    // Fast down (a transient must not blow the cloud off the dial), slow up.
    const want = Math.max(1, Math.min(0.92 / Math.max(peak, 1e-4), 64));
    const prev = this.scopeGain[slot];
    this.scopeGain[slot] = want < prev ? want : prev + (want - prev) * 0.05;

    // The density buffer is built in CSS pixels and blitted through the canvas
    // transform, so the cloud looks the same on a HiDPI screen as on a plain
    // one (and costs the same) instead of thinning out as the pixels get finer.
    const g = this.scopeGain[slot] * r;
    const size = Math.ceil(2 * r) + 2;
    const cloud = this.cloudBuffer(slot, size, C.accent);
    const { hits, image } = cloud;
    hits.fill(0);

    // Splat each sample over its four neighbouring pixels.
    const mid = size / 2;
    for (let k = 0; k < count; k++) {
      const o = ((write - count + k + SCOPE_FRAMES * 2) % SCOPE_FRAMES) * SCOPE_CHANNELS;
      const px = mid + hSign * ring[o + axes.h] * g;
      const py = mid - ring[o + axes.v] * g;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= size || y0 + 1 >= size) continue;
      const fx = px - x0;
      const fy = py - y0;
      const base = y0 * size + x0;
      hits[base] += (1 - fx) * (1 - fy);
      hits[base + 1] += fx * (1 - fy);
      hits[base + size] += (1 - fx) * fy;
      hits[base + size + 1] += fx * fy;
    }

    const data = image.data;
    const k = (CLOUD_K * CLOUD_REF_FRAMES) / count;
    for (let i = 0, p = 3; i < hits.length; i++, p += 4) {
      const h = hits[i];
      data[p] = h <= 0 ? 0 : Math.round(255 * densityAlpha(h, k));
    }
    cloud.ctx.putImageData(image, 0, 0);
    ctx.drawImage(cloud.canvas, cx - size / 2, cy - size / 2);

    if (this.scopeGain[slot] > 1.05) {
      ctx.fillStyle = C.dim;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(`×${this.scopeGain[slot].toFixed(1)}`, cx + r + 10, cy - r - 10);
    }
  }

  /** Density buffer + its ImageData for one panel, rebuilt on resize/theme change. */
  cloudBuffer(slot, size, ink) {
    let c = this.cloud[slot];
    if (c === null || c.size !== size || c.ink !== ink) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const cctx = canvas.getContext("2d");
      const image = cctx.createImageData(size, size);
      const [r, g, b] = parseInk(ink);
      const d = image.data;
      for (let p = 0; p < d.length; p += 4) { d[p] = r; d[p + 1] = g; d[p + 2] = b; }
      c = this.cloud[slot] = {
        size, ink, canvas, ctx: cctx, image, hits: new Float32Array(size * size),
      };
    }
    return c;
  }

  /**
   * The inverse-correlation meter: nothing at all when the image is mono-safe,
   * growing out of the centre as the two ears disagree, full width in anti-
   * phase. It rides under every scope, which is where you look when you are
   * checking whether the mix survives a fold-down.
   */
  drawCorrelation(ctx, C, x, y, w, h) {
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(x, y, w, h);
    const inv = (1 - this.corr) / 2; // 0 mono … 0.5 uncorrelated … 1 anti-phase
    const half = (w / 2) * inv;
    ctx.fillStyle = inv > 0.75 ? "#e05a4a" : inv > 0.5 ? "#e0a33a" : C.meter;
    ctx.fillRect(x + w / 2 - half, y, half * 2, h);
    ctx.fillStyle = C.dim;
    ctx.fillRect(x + w / 2 - 0.5, y - 1, 1, h + 2);
  }

  // ── fader + meters ──

  /**
   * The bars to draw, left to right. A speaker layout is arranged the way the
   * speakers stand rather than in channel order (and drops the LFE); the
   * ambisonic target leads with the field.
   */
  meterBars() {
    const bars = [];
    if (this.target === ANALYSIS_AMBISONIC) {
      bars.push({ label: "E", meter: this.field, weight: 1.7, field: true });
    }
    const n = this.readout.meterCount;
    for (const { label, channel } of meterDisplay(this.target)) {
      if (n > 0 && channel >= n) continue; // tap not up to this target yet
      bars.push({ label, meter: this.meters[channel], weight: 1 });
    }
    return bars;
  }

  drawMeters(C) {
    const cv = this.meterCanvas;
    const ctx = cv.getContext("2d");
    const dpr = this.dpr;
    const W = cv.width / dpr;
    const H = cv.height / dpr;
    if (W < 4 || H < 4) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, W, H);
    ctx.font = "9px system-ui, sans-serif";

    const fr = this.faderRect();
    this.drawFader(ctx, C, fr);

    // Scale ticks, between the fader and the bars.
    const scaleX = fr.x + fr.w + 3;
    const top = fr.y;
    const barH = fr.h;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = C.meterBg;
    for (const db of [0, -6, -12, -24, -36, -48]) {
      const y = top + barH * (1 - meterFrac(db));
      ctx.fillStyle = C.dim;
      ctx.fillText(String(db), scaleX + 13, y);
      ctx.beginPath();
      ctx.moveTo(scaleX + 15, y);
      ctx.lineTo(scaleX + 17, y);
      ctx.stroke();
    }

    const bars = this.meterBars();
    const x0 = scaleX + 18;
    const avail = W - x0 - 3;
    const totalWeight = bars.reduce((s, b) => s + b.weight, 0) || 1;
    const gap = 2;
    const unit = (avail - gap * (bars.length - 1)) / totalWeight;
    let x = x0;
    for (const bar of bars) {
      const bw = Math.max(3, unit * bar.weight);
      this.drawBar(ctx, C, x, top, bw, barH, bar);
      ctx.fillStyle = C.dim;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(bar.label, x + bw / 2, top + barH + 3);
      x += bw + gap;
    }
  }

  drawBar(ctx, C, x, y, w, h, bar) {
    const m = bar.meter;
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(x, y, w, h);

    const rmsF = meterFrac(m.rmsDb());
    if (rmsF > 0) {
      const rh = h * rmsF;
      const grad = ctx.createLinearGradient(0, y + h, 0, y);
      grad.addColorStop(0, C.meter);
      grad.addColorStop(meterFrac(-12), C.meter);
      grad.addColorStop(meterFrac(-3), "#e0a33a");
      grad.addColorStop(1, "#e05a4a");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y + h - rh, w, rh);
    }

    const pf = meterFrac(m.peakDb);
    if (pf > 0) {
      ctx.fillStyle = m.peakDb >= 0 ? "#e05a4a" : C.fg;
      ctx.fillRect(x, y + h - h * pf - 1, w, 1.5);
    }

    // Clip indicator: the cap of the bar. Latched, so a single clipped sample
    // half an hour ago is still telling you about itself.
    ctx.fillStyle = m.clipping() ? "#e05a4a" : C.meterBg;
    ctx.fillRect(x, y - 5, w, 4);
  }

  drawFader(ctx, C, r) {
    const v = this.volumeValue();
    const f = v / 255;
    // Track, with the travel filled in below the cap so the setting reads at a
    // glance from across the room.
    ctx.fillStyle = C.meterBg;
    ctx.fillRect(r.x + r.w / 2 - 3, r.y, 6, r.h);
    const capY = r.y + r.h * (1 - f);
    ctx.fillStyle = C.meter;
    ctx.fillRect(r.x + r.w / 2 - 3, capY, 6, r.y + r.h - capY);
    // The file's own default ($80) marked on the track.
    ctx.fillStyle = C.border;
    ctx.fillRect(r.x + 2, r.y + r.h * (1 - 0x80 / 255) - 0.5, r.w - 4, 1);

    ctx.fillStyle = this._drag !== null ? C.accent : C.fg;
    ctx.fillRect(r.x, capY - 5, r.w, 10);
    ctx.fillStyle = C.bg;
    ctx.fillRect(r.x, capY - 0.5, r.w, 1);

    ctx.fillStyle = C.dim;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(String(v), r.x + r.w / 2, r.y + r.h + 3);
    ctx.fillText(t("master.vol"), r.x + r.w / 2, 1);
  }
}
