// The Analogue Warmth Edition's calendar rule (src/ui/warmth.js) and the two
// lists it feeds in theme.js. Everything here is DOM-free on purpose: the date
// arithmetic and the roster are the parts that must not drift, and a browser
// smoke test cannot run them on a day of its choosing.
//
// The behaviour under test, in one sentence: the edition arrives on its own for
// exactly one local day a year (or whenever PUBLISHED is flipped), joins the ◐
// button's roster while it is here, and can never end up in the saved-theme
// whitelist — so it never outlives its day.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isAprilFools, warmthInSeason, setWarmthClock } from "../../src/ui/warmth.js";
import { THEMES, WARMTH, isThemeName, themeRoster } from "../../src/ui/theme.js";

const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h); // 1-based month

test("April 1st, and only April 1st", () => {
  assert.equal(isAprilFools(day(2027, 4, 1)), true);
  assert.equal(isAprilFools(day(2027, 4, 1, 0)), true);   // first minute
  assert.equal(isAprilFools(day(2027, 4, 1, 23)), true);  // last
  assert.equal(isAprilFools(day(2027, 3, 31, 23)), false);
  assert.equal(isAprilFools(day(2027, 4, 2, 0)), false);
  // The one off-by-one that matters: getMonth() is 0-based, so a rule written
  // from the calendar rather than the API lands on the 1st of MAY.
  assert.equal(isAprilFools(day(2027, 5, 1)), false);
  // …and the neighbouring first-of-months, for the same reason.
  for (const m of [1, 2, 3, 6, 7, 8, 9, 10, 11, 12]) {
    assert.equal(isAprilFools(day(2027, m, 1)), false, `month ${m}`);
  }
});

test("a leap year does not shift it", () => {
  assert.equal(isAprilFools(day(2028, 4, 1)), true);
  assert.equal(isAprilFools(day(2028, 2, 29)), false);
});

test("in season on the day, out of it either side", () => {
  try {
    setWarmthClock(() => day(2027, 4, 1));
    assert.equal(warmthInSeason(), true);
    assert.deepEqual(themeRoster(), ["dark", "dim", "light", WARMTH]);

    setWarmthClock(() => day(2027, 4, 2));
    assert.equal(warmthInSeason(), false);
    assert.deepEqual(themeRoster(), ["dark", "dim", "light"]);
  } finally {
    setWarmthClock();
  }
});

test("the roster is a copy — a caller cannot grow THEMES", () => {
  try {
    for (const d of [day(2027, 4, 1), day(2027, 4, 2)]) { // in season and out
      setWarmthClock(() => d);
      themeRoster().push("chartreuse");
      assert.deepEqual(THEMES, ["dark", "dim", "light"]);
    }
  } finally {
    setWarmthClock();
  }
});

test("warmth is a theme NAME but never a saved value", () => {
  // isThemeName is the ?theme= whitelist and answers yes; THEMES is what
  // applyTheme is allowed to write to localStorage, and must not contain it,
  // or the edition would survive the day that summoned it.
  assert.equal(isThemeName(WARMTH), true);
  assert.equal(THEMES.includes(WARMTH), false);
  assert.equal(isThemeName("chartreuse"), false);
  assert.equal(isThemeName(null), false);
  for (const name of THEMES) assert.equal(isThemeName(name), true);
});
