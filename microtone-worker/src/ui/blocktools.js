// The right-click menu's SECOND row: the Patterns-view edit tools, aimed at
// whatever the pointer is on.
//
// Which tools appear is decided by the COLUMNS in play — the block selection's
// column band, or the single column under the pointer — so right-clicking a
// volume column offers the volume tool and nothing else. A band spanning
// several columns offers each of their tools EXCEPT the effect palette: picking
// an effect is a write, not a transform, and stamping one across a band that
// only happens to include the effect column is never what was meant.
//
// Every tool acts on a CELL LIST the view supplies — the selection when there
// is one, else the single cell that was clicked — so the same code serves the
// Timeline (rows × channels, crossing patterns) and a Patterns column (a row
// range in one pattern). The maths is patterntools.js's per-cell core, the same
// one the Patterns toolbar runs, so the two can't drift.

import { ICON, fxGlyph } from "./icons.js";
import { t } from "./i18n.js";
import { showModal } from "./widgets/modal.js";
import { COL_NOTE, COL_INST, COL_VOL, COL_PAN, COL_FX, COL_FX2, SUB_PAN } from "./edit.js";
import { scaleVolumeAt, transformPanAt, changeInstrumentAt } from "../doc/patterntools.js";
import { setCellsBytesOp, setCellsFieldsOp, bulkNotesOp } from "../doc/ops.js";
import { cellToBytes } from "../doc/clipboard.js";
import { transposePatternNotes, transposeUnitKeys, pitchTablePresets } from "./pitchtables.js";
import { FX_INFO, fxName, fxArg } from "./palette.js";

/**
 * The quick effect palette (item 100.5).
 *
 * Surveyed over the 64 `.taud` files in the TSVM music library
 * (`assets/disk0/home/music/`, top level only): 371 808 non-empty cells, of
 * which 160 206 carry an effect. The shortlist is the smallest set covering
 * ≥ 90% of those effect cells — S (36.8%), D (22.4%), G (16.3%), H (6.8%),
 * O (3.5%), E (3.0%) — plus A, which is in more than half the songs (38/64)
 * though only 1.2% of cells, and F, the other half of E's pitch slide: a quick
 * palette with "slide down" and no "slide up" is a papercut on every use. That
 * is 91.5% of every effect written in the corpus, in eight cells. Everything
 * else stays one keystroke away in the command palette at the foot of the
 * screen.
 */
export const QUICK_FX = [0x10, 0x11, 0x0d, 0x0e, 0x0f];

/** Which tool a logical column offers, if any. */
const TOOL_FOR_COL = {
  [COL_NOTE]: "transpose",
  [COL_INST]: "instrument",
  [COL_VOL]: "volume",
  [COL_PAN]: "pan",
};

const TOOL_ITEM = {
  transpose: () => ({ id: "transpose", label: t("ctx.transpose"), icon: ICON.transpose,
    title: t("ctx.transposeTitle") }),
  instrument: () => ({ id: "instrument", label: t("ctx.instrument"), icon: ICON.instrument,
    title: t("ctx.instrumentTitle") }),
  volume: () => ({ id: "volume", label: t("ctx.volume"), icon: ICON.volume,
    title: t("ctx.volumeTitle") }),
  pan: () => ({ id: "pan", label: t("ctx.pan"), icon: ICON.pan, title: t("ctx.panTitle") }),
  panner: () => ({ id: "panner", label: t("toolbox.panner").replace(/…$/, ""),
    icon: ICON.panner, title: t("toolbox.pannerTitle") }),
  findchange: () => ({ id: "findchange", label: t("ctx.findchange"),
    icon: ICON.findchange, title: t("ctx.findchangeTitle") }),
};

/**
 * The second row for a set of logical columns (edit.js COL_*). One column gets
 * that column's tool — the effect column gets the quick palette instead. Several
 * columns get one tool each, effects excluded.
 *
 * `surround` adds the Panner beside the panning tool, on exactly the condition
 * the toolbox button uses (the song declares a surround model): the two are the
 * same popup, so they should appear and disappear together. A stereo song has
 * no circle to place anything on.
 *
 * Find & Change (item 132) closes every row, including the effect palette's:
 * it is the only tool here that is not about a column, so which column you
 * happened to open the menu on has no bearing on whether it is offered.
 */
export function blockToolItems(cols, { surround = false } = {}) {
  // Either effect column alone gets the quick palette, writing to that column's
  // own slot — `fx:` is effect 1, `fx2:` the second effect (§5.5).
  if (cols.length === 1 && (cols[0] === COL_FX || cols[0] === COL_FX2)) {
    const prefix = cols[0] === COL_FX2 ? "fx2" : "fx";
    // The name and the argument format are i18n lookups, not fields on FX_INFO
    // — reading them off the record gave every cell an `undefined` label.
    const quick = QUICK_FX.map((op) => {
      const info = FX_INFO[op];
      return { id: `${prefix}:${op}`, label: fxName(info), icon: fxGlyph(info.l),
        title: `${info.l} ${fxName(info)} — ${fxArg(info)}` };
    });
    return [...quick, TOOL_ITEM.findchange()];
  }
  const items = [];
  for (const col of cols) {
    const tool = TOOL_FOR_COL[col];
    if (tool) items.push(TOOL_ITEM[tool]());
    if (col === COL_PAN && surround) items.push(TOOL_ITEM.panner());
  }
  items.push(TOOL_ITEM.findchange());
  return items;
}

/** True when `id` is one of the second row's actions. */
export function isBlockTool(id) {
  return typeof id === "string" &&
    (id.startsWith("fx:") || id.startsWith("fx2:") || id in TOOL_ITEM);
}

/** Percussion slots skip a transpose — a kit piece's pitch selects the drum,
 *  it isn't melodic (the same rule the retune uses). */
function percussionSlots(doc) {
  const perc = new Uint8Array(1024);
  for (const s of doc.usedInstrumentSlots()) {
    if (doc.instruments[s].isPercussion) perc[s] = 1;
  }
  return perc;
}

/** Apply a per-cell byte transform to the whole cell list as ONE undo step.
 *  `fn(bytes, wide)` mutates a cell's bytes and returns whether it changed it. */
function applyCellBytes(ctx, fn) {
  const { store, cells } = ctx;
  const wide = store.doc.wideCells === true;
  const writes = [];
  for (const { pat, row } of cells) {
    const cell = store.doc.patternAt(store.songIndex, pat)?.[row];
    if (!cell) continue;
    const bytes = cellToBytes(cell, wide);
    if (fn(bytes, wide)) writes.push({ pat, row, bytes });
  }
  if (!writes.length) return false;
  store.undo.apply(setCellsBytesOp(store.songIndex, writes));
  return true;
}

/**
 * Run one second-row action.
 *
 * `ctx` is `{ store, cells, scope, anchor }` — `cells` a DEDUPED `[{pat, row}]`
 * list (the view builds it from its selection, or from the one clicked cell),
 * `scope` the human label the modals put in their body text, and `anchor` the
 * `{pat, row, channel, rowLabel}` the panner reads its starting position off.
 * Resolves true when the document changed.
 */
export async function runBlockTool(id, ctx) {
  if (id.startsWith("fx2:")) return applyQuickFx(ctx, parseInt(id.slice(4), 10), true);
  if (id.startsWith("fx:")) return applyQuickFx(ctx, parseInt(id.slice(3), 10), false);
  switch (id) {
    case "transpose": return transposeTool(ctx);
    case "instrument": return instrumentTool(ctx);
    case "volume": return volumeTool(ctx);
    case "pan": return panTool(ctx);
    case "panner": return pannerTool(ctx);
    case "findchange": return findChangeTool(ctx);
  }
  return false;
}

/** Find & Change (item 132) on the block. The dialog owns its own commit —
 *  it has to run the query to count the matches anyway, so handing back a
 *  cell transform and letting applyCellBytes redo the work would mean running
 *  it twice and hoping the two agreed. */
async function findChangeTool(ctx) {
  const { showFindChange } = await import("./popups/findchange.js");
  // No pattern number in the title: a block on the Timeline crosses patterns,
  // and naming one of them would be a lie about what Apply is going to touch.
  return showFindChange(ctx.store, { cells: ctx.cells, scope: ctx.scope });
}

/**
 * Open the same Panner the toolbox opens, reading its starting position off the
 * anchor cell — but writing to the whole block. Its four buttons each produce
 * ONE answer (a placement, a target, a slide speed, a column position), so
 * every cell in the block gets that same answer in one undo step, which is what
 * a `Z` slide wants anyway: it has to be re-issued on every row it moves over.
 */
async function pannerTool(ctx) {
  const { store, cells, anchor } = ctx;
  const cell = store.doc.patternAt(store.songIndex, anchor.pat)?.[anchor.row];
  if (!cell) return false;
  const { showPanner } = await import("./popups/panner.js");
  let changed = false;
  await showPanner(store, {
    sub: SUB_PAN,
    channel: anchor.channel,
    rowLabel: anchor.rowLabel,
    wide: store.doc.wideCells === true,
    cell,
    apply: (fields) => {
      store.undo.apply(setCellsFieldsOp(store.songIndex, cells, fields));
      changed = true;
    },
  });
  return changed;
}

/** Write an effect opcode across the cells, keeping each one's argument — the
 *  same thing the command palette's opcode chooser does, generalised to a
 *  block. `second` aims it at the wide cell's effect 2 (byte 10, §5.5), which
 *  only exists there. */
function applyQuickFx(ctx, op, second = false) {
  const wide = ctx.store.doc.wideCells === true;
  if (second && !wide) return false;
  const slot = second ? 10 : 5;
  return applyCellBytes(ctx, (bytes) => {
    if (bytes[slot] === op) return false;
    bytes[slot] = op;
    return true;
  });
}

/** The volume tool's dialog. Shared with the Patterns toolbar so the two
 *  routes to it ask the same question. Resolves {mult, add} or null. */
export async function volumeDialog(store, scope, titleArg) {
  const wide = store.doc?.wideCells === true;
  const result = await showModal({
    title: t("pat.volModalTitle", { pat: titleArg }),
    body: t("pat.volBody", { scope }),
    fields: [
      { name: "mult", label: t("pat.multiply"), type: "number", value: 1, min: -8, max: 8 },
      // The volume column is 6-bit in v2 and a whole byte in v3 (§5.5), so the
      // offset's range has to follow the format or the same number means a
      // quarter of the move.
      { name: "add", label: t("pat.add"), type: "number", value: 0,
        min: wide ? -255 : -63, max: wide ? 255 : 63 },
    ],
    okLabel: t("common.apply"),
  });
  if (!result) return null;
  const mult = parseFloat(result.mult ?? "1");
  const add = parseInt(result.add || "0", 10) | 0;
  return mult === 1 && add === 0 ? null : { mult, add };
}

/** The panning tool's dialog. Resolves {mult, add} or null. */
export async function panDialog(store, scope, titleArg) {
  const wide = store.doc?.wideCells === true;
  const result = await showModal({
    title: t("pat.panModalTitle", { pat: titleArg }),
    body: t("pat.panBody", { scope }),
    fields: [
      { name: "mult", label: t("pat.widen"), type: "number", value: 1, min: -4, max: 4 },
      // v3's panning column is a 9-bit angle, so a shift can be up to a whole
      // turn rather than the width of the front arc.
      { name: "shift", label: t("pat.shift"), type: "number", value: 0,
        min: wide ? -511 : -63, max: wide ? 511 : 63 },
    ],
    okLabel: t("common.apply"),
  });
  if (!result) return null;
  const mult = parseFloat(result.mult ?? "1");
  const add = parseInt(result.shift || "0", 10) | 0;
  return mult === 1 && add === 0 ? null : { mult, add };
}

/** The transpose dialog — its unit labels follow the song's tuning, and the
 *  raw checkbox bypasses notation entirely for a straight 4096-TET-unit shift
 *  (fine = note units, coarse = octaves), the same arithmetic the "Raw
 *  format" preset already does, on demand rather than by switching notation.
 *  Resolves {fine, coarse, raw} or null. */
export async function transposeDialog(store, scope, titleArg) {
  const units = transposeUnitKeys(store.pitchPreset);
  const result = await showModal({
    title: t("pat.transposeModalTitle", { pat: titleArg }),
    body: t("pat.transposeBody", { scope }),
    fields: [
      { name: "fine", label: t(units.fine), type: "number", value: 0, min: -4096, max: 4096 },
      { name: "coarse", label: t(units.coarse), type: "number", value: 0, min: -10, max: 10 },
      { name: "raw", label: t("pat.unitRaw4096"), type: "checkbox", value: false },
    ],
    okLabel: t("common.apply"),
  });
  if (!result) return null;
  const fine = parseInt(result.fine || "0", 10) | 0;
  const coarse = parseInt(result.coarse || "0", 10) | 0;
  const raw = !!result.raw;
  return fine === 0 && coarse === 0 ? null : { fine, coarse, raw };
}

/** The preset a transpose should actually compute against: the raw checkbox
 *  swaps in the "Raw format" preset (an empty table), which makes
 *  transposePatternNotes take its no-table branch — a straight 4096-TET-unit
 *  shift regardless of the song's real notation. */
export function transposePresetFor(store, v) {
  return v.raw ? pitchTablePresets[0] : store.pitchPreset;
}

/** The change-instrument dialog. `withSongScope` adds the Patterns toolbar's
 *  "every pattern in the song" option, which a block tool has no business
 *  offering. Resolves {from, to, target} or null. */
export async function instrumentDialog(scope, titleArg, withSongScope = false) {
  const fields = [
    { name: "from", label: t("pat.instFrom"), type: "text", value: "",
      placeholder: t("pat.instAll") },
    { name: "to", label: t("pat.instTo"), type: "text", value: "" },
  ];
  if (withSongScope) {
    fields.push({ name: "target", label: t("pat.instScope"), type: "select", value: "here",
      options: [
        { value: "here", label: t("pat.instScopeHere", { scope }) },
        { value: "song", label: t("pat.instScopeSong") },
      ] });
  }
  const result = await showModal({
    title: t("pat.instModalTitle", { pat: titleArg }),
    body: t("pat.instBody", { scope }),
    fields,
    okLabel: t("common.apply"),
  });
  if (!result) return null;
  const fromStr = (result.from ?? "").trim();
  return {
    from: fromStr === "" ? null : (parseInt(fromStr, 16) & 0xff),
    to: parseInt((result.to ?? "").trim() || "0", 16) & 0xff,
    target: result.target ?? "here",
  };
}

async function volumeTool(ctx) {
  const v = await volumeDialog(ctx.store, ctx.scope, ctx.scope);
  if (!v) return false;
  return applyCellBytes(ctx, (bytes, wide) => scaleVolumeAt(bytes, 0, wide, v.mult, v.add));
}

async function panTool(ctx) {
  const v = await panDialog(ctx.store, ctx.scope, ctx.scope);
  if (!v) return false;
  return applyCellBytes(ctx, (bytes, wide) => transformPanAt(bytes, 0, wide, v.mult, v.add));
}

async function instrumentTool(ctx) {
  const v = await instrumentDialog(ctx.scope, ctx.scope);
  if (!v) return false;
  return applyCellBytes(ctx, (bytes, wide) => changeInstrumentAt(bytes, 0, wide, v.from, v.to));
}

/**
 * Transpose the listed cells. Grouped by pattern because the note maths needs
 * the RUNNING instrument to know what is percussion, and that is only knowable
 * by walking a pattern from row 0 — the block's own rows are not enough. One
 * bulkNotesOp, so it is one undo step however many patterns it touched.
 */
async function transposeTool(ctx) {
  const { store, cells } = ctx;
  const v = await transposeDialog(store, ctx.scope, ctx.scope);
  if (!v) return false;
  const preset = transposePresetFor(store, v);
  const perc = percussionSlots(store.doc);
  const byPattern = new Map();
  for (const { pat, row } of cells) {
    if (!byPattern.has(pat)) byPattern.set(pat, new Set());
    byPattern.get(pat).add(row);
  }
  for (const pat of byPattern.keys()) store.doc.ensurePattern(store.songIndex, pat);
  store.undo.apply(bulkNotesOp(store.songIndex, (song) => {
    const changes = [];
    for (const [pat, rows] of byPattern) {
      changes.push(...transposePatternNotes(song, pat, preset, perc,
        v.fine, v.coarse, 0, Infinity, (row) => rows.has(row)));
    }
    return changes;
  }));
  return true;
}
