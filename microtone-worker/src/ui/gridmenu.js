// Shared right-click menu vocabulary for the three grids (Timeline, Cues,
// Patterns). The three views hit-test differently and hold different cursors,
// but the ACTIONS are the same ones, and a menu that drifted between them
// would be worse than no menu — so the item specs and the two document actions
// live here rather than being written out three times.

import { ICON } from "./icons.js";
import { t } from "./i18n.js";
import { insertChannelOp, channelHasContent } from "../doc/ops.js";

/** Copy / Cut / Paste cells. `hasSelection` gates the first two, `canPaste` the
 *  third; `selAnchored` only picks the tooltip that tells the truth about where
 *  the paste will land. */
export function clipboardItems({ hasSelection, canPaste, selAnchored = false }) {
  const items = [];
  if (hasSelection) {
    items.push(
      { id: "copy", label: t("ctx.copy"), icon: ICON.copy, title: t("ctx.copyTitle") },
      { id: "cut", label: t("ctx.cut"), icon: ICON.cut, title: t("ctx.cutTitle") });
  }
  if (canPaste) {
    items.push({ id: "paste", label: t("ctx.paste"), icon: ICON.paste,
      title: t(selAnchored ? "ctx.pasteSelTitle" : "ctx.pasteTitle") });
  }
  return items;
}

/** The two channel inserts for channel `ch` of `chans`. */
export function channelItems(ch, chans) {
  return [
    { id: "insLeft", label: t("ctx.chanLeft"), icon: ICON.channelLeft,
      title: t("ctx.chanLeftTitle", { ch: ch + 1 }) },
    { id: "insRight", label: t("ctx.chanRight"), icon: ICON.channelRight,
      title: t("ctx.chanRightTitle", { ch: ch + 1 }), disabled: ch >= chans - 1 },
  ];
}

/** The cell an empty cue slot gets instead of Paste. */
export function newPatternItem() {
  return { id: "newPat", label: t("ctx.newPattern"), icon: ICON.patternNew,
    title: t("ctx.newPatternTitle") };
}

/**
 * Insert an empty channel at `at`, shifting that channel and everything right
 * of it one place along — mutes included, which is why the live array goes in.
 * The channel count is a fixed 32/64, so the last channel falls off the end:
 * ask first when it is carrying something (the drop is in the op's inverse, so
 * it undoes either way). Returns true when the document changed.
 */
export function insertChannelAt(store, at) {
  const chans = store.doc.channelCount;
  if (at < 0 || at >= chans) return false;
  if (channelHasContent(store.song, chans - 1) &&
      !confirm(t("ctx.dropLastConfirm", { ch: chans }))) return false;
  store.undo.apply(insertChannelOp(store.songIndex, at, null, store.voiceMutes));
  return true;
}
