// "Microtone: Analogue Warmth Edition" — the joke theme (`data-theme="warmth"`):
// a yellowed-ABS palette with moulded, semi-skeuomorphic chrome, plus a splash
// that parodies the marketing of a certain kind of plugin.
//
// It is NOT an ordinary fourth entry in the theme cycle. It is IN SEASON only
// when this module says so, and there are exactly two ways for that to happen:
//
//   * It is April 1st in the VIEWER's timezone. Then it boots over whatever
//     theme the reader saved — and never writes itself back (applyTheme
//     refuses to persist it), so their saved choice is still there, untouched,
//     on April 2nd. It also joins the roster of the ◐ button for the day.
//   * PUBLISHED below is flipped. That is the "whenever I feel like it" switch:
//     the edition is meant to go out whenever some snake-oil plugin gets called
//     out in public and the joke is topical — that is the moment it travels,
//     not once a year. Flip it, bump the version, deploy; flip it back when the
//     moment has passed. ONE other line goes with it: index.html's early-theme
//     script (the boot splash runs before any module can be imported, so it
//     repeats the rule) has a WARMTH_PUBLISHED of its own. Leave that one false
//     and a published run merely shows a frame of the old palette before the
//     app catches up — the calendar half is already handled there.
//
// test/browser/warmth-visual.html frames the screenshots for the announcement.
//
// Out of season the theme still EXISTS — `?theme=warmth` reaches it, for a
// screenshot or a demo — it is just not in the ◐ roster and never boots on its
// own. Either way it is never written to localStorage.
//
// Deliberately DOM-free and dependency-free: theme.js, docs.js and the Node
// tests all read it.

/** The "publish it now" switch — see the header. */
const PUBLISHED = false;

let _now = () => new Date();

/** Test seam: pin the clock (no argument restores the real one). */
export function setWarmthClock(fn) { _now = fn ?? (() => new Date()); }

/** April 1st on the reader's own calendar — the gag is a date, not an instant. */
export function isAprilFools(d = _now()) {
  return d.getMonth() === 3 && d.getDate() === 1; // getMonth() is 0-based
}

/** True while the edition boots on its own and joins the ◐ roster. */
export function warmthInSeason() { return PUBLISHED || isAprilFools(); }
