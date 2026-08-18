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
// step — a running level slide that folds rather than clips. RND (item 152) is
// the ROL ladder's random twin: instead of one more fixed step, each step
// throws the region a fresh displacement bounded by 12.5 / 25 / 50 / 100% of
// the wrap domain.
export const MOD_OFF = 0x0;
export const MOD_FUNK = 0x1;
export const MOD_ROL1 = 0x2;
export const MOD_ROL8 = 0x5;
export const MOD_SUB2 = 0x6;
export const MOD_SUB128 = 0x9;
export const MOD_RND12 = 0xc;
export const MOD_RND_ALL = 0xf;
/** Highest assigned operation; $A and $B are reserved (isModOpReserved). */
export const MOD_MAX = MOD_RND_ALL;

/** Step size per operation — bytes for the ROLs, U8 levels for the SUBs. The
 *  RNDs take their reach from MOD_SCATTER_FRAC instead, so they read 0 here. */
export const MOD_STEP = Object.freeze(
  [0, 0, 1, 2, 4, 8, 2, 8, 32, 128, 0, 0, 0, 0, 0, 0]);

/** RND displacement bound as a fraction of the wrap domain, by op − MOD_RND12. */
export const MOD_SCATTER_FRAC = Object.freeze([0.125, 0.25, 0.5, 1]);

export const isRolOp = (op) => op >= MOD_ROL1 && op <= MOD_ROL8;
export const isSubOp = (op) => op >= MOD_SUB2 && op <= MOD_SUB128;
export const isRndOp = (op) => op >= MOD_RND12 && op <= MOD_RND_ALL;
/** $A and $B carry no operation — a whole command naming one is ignored. */
export const isModOpReserved = (op) => op === 0xa || op === 0xb;

/**
 * One scatter step's displacement (item 152). NOT an accumulation: the offset
 * is drawn afresh from the ORIGINAL position every step, which is what keeps
 * `$C` inside 12.5% of it however long the effect runs — accumulating would
 * random-walk out to anywhere within a few seconds and make the four operations
 * one operation. `$F` draws from the whole domain, so it IS anywhere.
 *
 * `domainLen` is the wrap domain readSamplePoint rotates in — the region for
 * notefx 3, the whole sample for notefx 2, exactly as ROL uses it.
 */
export function scatterRot(op, domainLen) {
  if (domainLen < 2) return 0;
  const frac = MOD_SCATTER_FRAC[op - MOD_RND12];
  if (frac === undefined) return 0;
  if (frac >= 1) return Math.min(Math.floor(random() * domainLen), domainLen - 1);
  const reach = Math.max(1, Math.round(domainLen * frac));
  const d = Math.round((random() * 2 - 1) * reach) % domainLen;
  return d < 0 ? d + domainLen : d;
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
