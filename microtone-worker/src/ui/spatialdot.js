// Height cue for the spatial dials (#998.6). The Panner's top view and the
// Timeline header radars share it, so a source reads the same way wherever you
// look at it.
//
// A dial seen from above cannot show height on its own: the radius already
// carries elevation (straight overhead collapses to the centre), which leaves
// "up" and "down" indistinguishable. So the dot behaves like a real object
// above a floor, lit from the front and high up (see the constants below):
//
//   * it GROWS as it rises and shrinks as it sinks;
//   * its SHADOW slides away from the light (straight down the screen, since
//     the light is at the front) — tight against the dot and sharp when the
//     source is low, further off and softer when it is high overhead.
//
// The floor is the bottom of the sphere, not the ear plane: a source at −90°
// sits ON the floor with its shadow exactly beneath it, ear level is halfway
// up, and +90° is the full height. Planar songs never call any of this —
// everything there is at ear level and the cue would be a constant.

import { currentTheme, onThemeChange } from "./theme.js";

/** Elevation of the imaginary key light, in degrees. */
export const LIGHT_ELEVATION_DEG = 85;
/** Its azimuth in Taud degrees (90° = front), i.e. shadows fall down-screen. */
export const LIGHT_AZIMUTH_DEG = 90;

const EL_TO_RAD = Math.PI / 256; // 128 elevation units = 90°
const COT_LIGHT = 1 / Math.tan((LIGHT_ELEVATION_DEG * Math.PI) / 180);

/**
 * Presentation numbers for a source at elevation `el` (Taud units, ±128) drawn
 * on a dial of radius `dialR` with a nominal dot radius `dotR`.
 * Pure — unit-tested in test/node/spatialdot.test.js.
 */
export function spatialDotCue(el, dialR, dotR) {
  const s = Math.sin(el * EL_TO_RAD); // −1 below … 0 ear level … +1 above
  const h = 1 + s;                    // height over the floor, 0 … 2
  // The header radars draw dots of 2-4 px; a shadow scaled straight off those
  // would be a smudge nobody can read, so the shadow has a size floor.
  const sr = Math.max(dotR, 4);
  return {
    height: h,
    radius: dotR * (1 + 0.3 * s),
    // Shadow displacement = height / tan(light elevation), in dial units where
    // the ring radius is one "ear-level unit".
    offset: dialR * 0.5 * h * COT_LIGHT,
    // Deliberately tighter than the dot: a big soft halo reads as glow rather
    // than as a shadow cast on the floor.
    core: sr * (0.5 + 0.15 * h),
    blur: sr * (0.35 + 0.5 * h),
    alpha: 0.4 - 0.1 * h,
  };
}

// A shadow is a darkening, and a dark ground swallows more of it than a light
// one — so the dark theme gets a stronger one for the SAME apparent depth.
// Resolved lazily (and refreshed on theme change) so this module still imports
// in Node, where the pure half is unit-tested.
let shadowBoost = null;
function themeShadowBoost() {
  if (shadowBoost === null) {
    const read = () => { shadowBoost = currentTheme() === "dark" ? 1.7 : 1.0; };
    read();
    onThemeChange(read);
  }
  return shadowBoost;
}

/**
 * Draw a source dot with its height cue. `fill` paints the dot; the shadow is
 * always a darkening, which reads on both themes (the canvas ground is a mid
 * tone in each). Leaves no canvas state behind except fillStyle.
 */
export function paintSpatialDot(ctx, x, y, el, dialR, dotR, fill) {
  const cue = spatialDotCue(el, dialR, dotR);
  const sy = y + cue.offset;
  const outer = cue.core + cue.blur;
  const a = Math.min(cue.alpha * themeShadowBoost(), 0.85);
  const g = ctx.createRadialGradient(x, sy, 0, x, sy, outer);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(cue.core / outer, `rgba(0,0,0,${a * 0.75})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, sy, outer, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, cue.radius, 0, Math.PI * 2);
  ctx.fill();
  return cue;
}
