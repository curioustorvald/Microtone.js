// Sample-modification note effects (items 130, 152) — notefx 2 and 3, ONE command
// with two spellings: `3` names the region to modify, `2` names the region to
// leave alone. Both are NON-DESTRUCTIVE views over the sample pool, exactly as
// S $Fxxx is: the state lives on the INSTRUMENT and is applied when a byte is
// read (sampler.js readSamplePoint), so the pool itself is never written.
//
// Behavioural contract: TAUD_NOTE_EFFECTS.md §"2 $sexy and 3 $sexy".
//
//   $s $e   the region (see decodeSampleRegion)
//   $x      the operation — one at a time, so an instrument carries ONE
//           modification and writing either opcode replaces it
//   $y      index into FUNK_SPEED_TABLE, ProTracker's own funk-speed ladder
//
// Region argument, decoded once here so the two spellings cannot drift apart:
//
//   $00        the sounding voice's LOOP region (the S $Fxxx region)
//   $s..$e     s <= e: from s/16 to (e+1)/16 of the sample, rounded
//              — so $0F is the whole sample and $4B the middle half
//   $10        middle half            $20 first two thirds   $21 last two thirds
//   $30 $31 $32  first / middle / last third
//   $F0..$FE   COMB: keep the extent, alternate in and out of it every 2^n
//              bytes ($F0 = every other byte, $F3 = runs of 8, $FE = 16384)
//   otherwise (s > e)  reserved — the whole command is ignored
//
// The extent is stored with a -1 sentinel meaning "follow the sounding voice's
// loop", which is what keeps an Ixmp-patched voice on its own loop (item 116).

import { random } from "./rng.js";

/** decodeSampleRegion result: nothing (reserved argument). */
export const REGION_NONE = 0;
/** decodeSampleRegion result: out = [start, end, combShift] — a whole region. */
export const REGION_SET = 1;
/** decodeSampleRegion result: out[2] = combShift only; the extent is kept. */
export const REGION_COMB = 2;

// ── the operations ($x) ──────────────────────────────────────────────────────
// ROL rotates the region's BYTES left by 1/2/4/8 per step (there is no
// rotate-right: a left rotation of n and a right rotation of span−n are the
// same picture, and the ladder is more useful spent on step sizes). SUB
// subtracts from each byte's U8 value, wrapping through zero, by 2/8/32/128 per
// step — a running level slide that folds rather than clips.
//
// Item 152 added the two random families, which share the ROL ladder's address
// transform and differ in what they apply it to. JUMP ($A $B) throws the WHOLE
// region to a new offset each step, within 50 / 100% of the wrap domain: the
// waveform arrives intact, somewhere else — a randomised `O $xxyy`, one draw a
// step. SCATTER ($C..$F) throws EVERY BYTE its own way within 12.5 / 25 / 50 /
// 100%: the region is shuffled rather than moved, which is why $F, drawing from
// the whole domain, leaves nothing where it was.
export const MOD_OFF = 0x0;
export const MOD_FUNK = 0x1;
export const MOD_ROL1 = 0x2;
export const MOD_ROL8 = 0x5;
export const MOD_SUB2 = 0x6;
export const MOD_SUB128 = 0x9;
export const MOD_JUMP50 = 0xa;
export const MOD_JUMP_ALL = 0xb;
export const MOD_RND12 = 0xc;
export const MOD_RND_ALL = 0xf;
/** Highest operation; every $x nibble is assigned since item 152's second half. */
export const MOD_MAX = MOD_RND_ALL;

/** Step size per operation — bytes for the ROLs, U8 levels for the SUBs. The
 *  random operations take their reach from their own tables, so they read 0. */
export const MOD_STEP = Object.freeze(
  [0, 0, 1, 2, 4, 8, 2, 8, 32, 128, 0, 0, 0, 0, 0, 0]);

/** JUMP reach as a fraction of the wrap domain, by op − MOD_JUMP50. The WHOLE
 *  region is thrown this far, in one piece. */
export const MOD_JUMP_FRAC = Object.freeze([0.5, 1]);

/** SCATTER reach as a fraction of the wrap domain, by op − MOD_RND12. Each BYTE
 *  is thrown this far, independently of its neighbours. */
export const MOD_SCATTER_FRAC = Object.freeze([0.125, 0.25, 0.5, 1]);

export const isRolOp = (op) => op >= MOD_ROL1 && op <= MOD_ROL8;
export const isSubOp = (op) => op >= MOD_SUB2 && op <= MOD_SUB128;
export const isJumpOp = (op) => op >= MOD_JUMP50 && op <= MOD_JUMP_ALL;
export const isRndOp = (op) => op >= MOD_RND12 && op <= MOD_RND_ALL;

/**
 * One JUMP step's displacement ($A $B): a single offset for the whole region,
 * drawn afresh from its ORIGINAL position every step rather than added to the
 * last one. Bounded, so `$A` paces around home and `$B` goes anywhere; a random
 * WALK would have made the two the same effect arriving at different speeds.
 *
 * Read back through the same transform ROL uses (the region moves as one
 * piece), so what comes out is the sample intact and re-seated — which is the
 * whole difference between this pair and the scatter below.
 */
export function jumpRot(op, domainLen) {
  if (domainLen < 2) return 0;
  const frac = MOD_JUMP_FRAC[op - MOD_JUMP50];
  if (frac === undefined) return 0;
  if (frac >= 1) return Math.min(Math.floor(random() * domainLen), domainLen - 1);
  const reach = Math.max(1, Math.round(domainLen * frac));
  const d = Math.round((random() * 2 - 1) * reach) % domainLen;
  return d < 0 ? d + domainLen : d;
}

/**
 * How far one scatter step may throw a byte, in bytes (0 = it cannot). The
 * whole domain for `$F`, so its draw covers everything.
 */
export function scatterReach(op, domainLen) {
  const frac = MOD_SCATTER_FRAC[op - MOD_RND12];
  if (frac === undefined || domainLen < 2) return 0;
  return Math.max(1, Math.min(Math.round(domainLen * frac), domainLen));
}

/** A fresh scramble for the next step. One draw per step — the per-byte spread
 *  comes out of the hash below, not out of 65535 more calls to the RNG. */
export function scatterSeed() {
  return (random() * 0x100000000) >>> 0;
}

/**
 * Integer avalanche (the murmur3 finaliser's shape): (seed, i) → a uint32 with
 * no visible structure. It has to be a pure FUNCTION of the byte's index, not a
 * stream — one output sample reads the same position through every sinc tap and
 * every channel, and a fresh draw per read would smear the whole sample into
 * white noise regardless of the reach. This IS the per-byte randomness.
 */
function scatterHash(seed, i) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ i, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Where sample byte `i` is READ FROM under a live scatter (item 152): its own
 * position displaced by its own random amount within ±`reach`, wrapped into
 * [domainStart, domainStart + domainLen). Every byte draws separately, so this
 * shuffles the region rather than moving it — `$F`, whose reach is the whole
 * domain, leaves nothing where it was.
 *
 * The mapping is not a permutation: a source byte may be drawn twice and
 * another not at all. Wanting one would mean shuffling an index table the size
 * of the sample on every step, which is not a thing to do inside a tick, and
 * a draw-with-replacement scramble is indistinguishable from a permutation at
 * this grain anyway.
 */
export function scatterSource(i, domainStart, domainLen, reach, seed) {
  if (reach <= 0 || domainLen < 2) return i;
  const span = 2 * reach + 1;
  // Map the hash onto [0, span) by multiply-shift: no modulo, and the product
  // stays exact in a double (2^32 × 2^17 well under 2^53).
  const d = ((scatterHash(seed, i) * span) / 4294967296 | 0) - reach;
  let k = (i - domainStart + d) % domainLen;
  if (k < 0) k += domainLen;
  return domainStart + k;
}

/**
 * ProTracker's funk-speed ladder, indexed by $y. The same table converters use
 * to lift `EFx` into `S $Fyyy`, so "speed 4" means one thing across the format.
 */
export const FUNK_SPEED_TABLE = Object.freeze([
  0, 5, 6, 7, 8, 0x0a, 0x0b, 0x0d, 0x10, 0x13, 0x16, 0x1a, 0x20, 0x2b, 0x40, 0x80,
]);

/** Scratch triple for the decoders (callers own theirs; engine never allocates
 *  inside a tick). */
export const regionScratch = new Int32Array(3);

/**
 * Decode the $se region byte against one voice's ACTIVE sample geometry.
 * Writes [start, end, combShift] into `out` and returns one of the REGION_*
 * codes. `combShift` is -1 for a solid region, else n where the comb runs are
 * 2^n bytes long.
 */
export function decodeSampleRegion(se, sampleLen, loopStart, loopEnd, out) {
  const s = (se >>> 4) & 0xf;
  const e = se & 0xf;
  const len = sampleLen;
  out[2] = -1;
  // $Fn — comb only. Listed before the s <= e rule so $FF stays a comb rather
  // than becoming "the last sixteenth", and n = $E is the largest run.
  if (s === 0xf && e !== 0xf) { out[2] = e; return REGION_COMB; }
  if (se === 0x00) {
    // The loop region — spelled as the -1 sentinel so an Ixmp-patched voice
    // still follows ITS OWN loop (item 116) rather than a baked-in span.
    out[0] = -1;
    out[1] = -1;
    return REGION_SET;
  }
  if (len < 2) return REGION_NONE;
  if (s <= e) {
    out[0] = Math.round((len * s) / 16);
    out[1] = Math.round((len * (e + 1)) / 16);
    return REGION_SET;
  }
  switch (se) {
    case 0x10: out[0] = Math.round(len / 4); out[1] = Math.round((len * 3) / 4); break;
    case 0x20: out[0] = 0;                   out[1] = Math.round((len * 2) / 3); break;
    case 0x21: out[0] = Math.round(len / 3); out[1] = len;                       break;
    case 0x30: out[0] = 0;                   out[1] = Math.round(len / 3);       break;
    case 0x31: out[0] = Math.round(len / 3); out[1] = Math.round((len * 2) / 3); break;
    case 0x32: out[0] = Math.round((len * 2) / 3); out[1] = len;                 break;
    default: return REGION_NONE; // $40..$ED with s > e — reserved
  }
  if (out[1] - out[0] < 2) return REGION_NONE;
  return REGION_SET;
}

/**
 * Is byte `k` (an offset from the extent start) INSIDE the comb's runs?
 * `shift` < 0 is a solid region. Runs are 2^shift bytes, alternating in and
 * out, so the test is one shift and one bit — this sits in the sample-read
 * hot path.
 */
export function inCombRun(k, shift) {
  return shift < 0 || ((k >>> shift) & 1) === 0;
}

/**
 * Does the modification touch sample byte `i`? The extent and comb decide, and
 * notefx 2's inversion flips the answer — which is the ONLY difference between
 * the two opcodes.
 */
export function modTouches(inst, i, extentStart, extentEnd) {
  const inside = i >= extentStart && i < extentEnd &&
    inCombRun(i - extentStart, inst.modComb);
  return inst.modInvert ? !inside : inside;
}

/**
 * How far the funk walk may scan for the next byte the modification touches.
 * An inverted region can exclude almost the whole sample, and the walk must
 * not turn into a linear search for the one byte that is left — past this many
 * misses the step simply does not land. Well above any musically useful comb.
 */
export const MOD_WALK_SCAN = 4096;
