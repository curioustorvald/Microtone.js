// Contextual command palette (screen bottom) — contents follow the cursor's
// sub-column: sentinel inserts on the note column, selector buttons on the
// vol/pan columns, an effect-opcode chooser on the fx-op column, and argument
// documentation (no commands) on the fx-arg column.

import { SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG } from "./edit.js";
import { t } from "./i18n.js";

// Effect reference (TAUD_NOTE_EFFECTS.md digest): name + argument format.
export const FX_INFO = {
  0x01: { l: "1", n: "Global flags", a: "$ff00 — bits0-1 tone-slide mode, bits2-4 interpolation" },
  0x05: { l: "5", n: "Filter cutoff", a: "IT: $xx00 (00..FE) · SF: $xxxx cents · $FFFF = reset override" },
  0x06: { l: "6", n: "Filter resonance", a: "IT: $xx00 · SF: $xxxx centibels · $FFFF = reset override" },
  0x07: { l: "7", n: "Pattern ditto", a: "$llrr — copy the last ll rows rr times" },
  0x08: { l: "8", n: "Bitcrusher", a: "$xyzz — x clip mode, y bit depth (1-7), zz sample-skip · $0000 off" },
  0x09: { l: "9", n: "Overdrive", a: "$x0zz — x clip mode, zz gain (16+zz)/16 · $0000 off" },
  0x0a: { l: "A", n: "Set tick rate", a: "$xx00 — ticks per row" },
  0x0b: { l: "B", n: "Jump to cue", a: "$xxxx — cue index (order jump)" },
  0x0c: { l: "C", n: "Pattern break", a: "$00xx — next cue, start at row xx" },
  0x0d: { l: "D", n: "Volume slide", a: "$xy00 — x up / y down per tick · $xF00 fine up, $Fy00 fine down" },
  0x0e: { l: "E", n: "Pitch slide down", a: "$xxxx units/tick · $Fxxx = fine (once)" },
  0x0f: { l: "F", n: "Pitch slide up", a: "$xxxx units/tick · $Fxxx = fine (once)" },
  0x10: { l: "G", n: "Tone portamento", a: "$xxxx — slide speed toward the row's note" },
  0x11: { l: "H", n: "Vibrato", a: "$xy00 — x speed, y depth" },
  0x12: { l: "I", n: "Tremor", a: "$xy00 — x+1 ticks on, y+1 ticks off" },
  0x13: { l: "J", n: "Arpeggio", a: "$xy00 — offsets ×256 (4096-TET) for voices 2/3" },
  0x14: { l: "K", n: "Vibrato + vol slide", a: "$xy00 — vol slide nibbles; vibrato continues" },
  0x15: { l: "L", n: "Porta + vol slide", a: "$xy00 — vol slide nibbles; portamento continues" },
  0x16: { l: "M", n: "Channel volume", a: "$xx00 — set channel volume (00..3F)" },
  0x17: { l: "N", n: "Channel vol slide", a: "$xy00 — like D but on the channel axis" },
  0x18: { l: "O", n: "Sample offset", a: "$xxxx — start sample at byte offset" },
  0x19: { l: "P", n: "Pan slide", a: "$xy00 — x left / y right (IT convention)" },
  0x1a: { l: "Q", n: "Retrigger", a: "$0xyy — retrig every yy ticks, x = volume modifier" },
  0x1b: { l: "R", n: "Tremolo", a: "$xy00 — x speed, y depth" },
  0x1c: { l: "S", n: "Special", a: "$Dx.. delay · $Cx.. cut@tick · $Bx.. loop · $8xx pan · $1x gliss · $3/4/5 waveforms · $6x/$Ex delays · $7x NNA/env · $Fx funk" },
  0x1d: { l: "T", n: "Tempo", a: "$xx00 BPM=xx+25 · $FFxx BPM=xx+280 · $000y/$001y slide" },
  0x1e: { l: "U", n: "Fine vibrato", a: "$xy00 — x speed, y depth (finer than H)" },
  0x1f: { l: "V", n: "Global volume", a: "$xx00 — song global volume (00..FF)" },
  0x20: { l: "W", n: "Global vol slide", a: "$xy00 — fine/coarse like D, on global volume" },
  0x22: { l: "Y", n: "Panbrello", a: "$xy00 — x speed, y depth" },
};

export class CommandPalette {
  /** getContext() → {sub, cell, apply(fields)} | null */
  constructor(host, getContext) {
    this.host = host;
    this.getContext = getContext;
    this.lastKey = null;
  }

  refresh() {
    const ctx = this.getContext();
    if (!ctx) {
      this.host.hidden = true;
      this.lastKey = null;
      return;
    }
    const key = `${ctx.sub}:${ctx.cell?.effect ?? -1}:${ctx.cell?.volumeEff ?? -1}:${ctx.cell?.panEff ?? -1}`;
    if (key === this.lastKey && !this.host.hidden) return; // avoid re-render churn
    this.lastKey = key;
    this.host.hidden = false;
    this.host.innerHTML = "";

    const label = (text) => {
      const s = document.createElement("span");
      s.className = "pal-label";
      s.textContent = text;
      this.host.appendChild(s);
    };
    const btn = (text, title, onClick, active = false) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title ?? "";
      if (active) b.classList.add("active");
      b.addEventListener("click", () => { onClick(); this.lastKey = null; this.refresh(); });
      this.host.appendChild(b);
      return b;
    };
    const hint = (text) => {
      const s = document.createElement("span");
      s.className = "pal-hint";
      s.textContent = text;
      this.host.appendChild(s);
    };

    switch (ctx.sub) {
      case SUB_NOTE:
        label(t("pal.note"));
        btn(t("pal.sentKeyOff"), t("pal.sentKeyOffTitle"), () => ctx.apply({ note: 0x0001 }));
        btn(t("pal.sentCut"), t("pal.sentCutTitle"), () => ctx.apply({ note: 0x0002 }));
        btn(t("pal.sentFade"), t("pal.sentFadeTitle"), () => ctx.apply({ note: 0x0003 }));
        btn(t("pal.sentFastFade"), t("pal.sentFastFadeTitle"), () => ctx.apply({ note: 0x0004 }));
        btn(t("pal.clear"), t("pal.clearNoteTitle"), () => ctx.apply({ note: 0, instrment: 0 }));
        hint(t("pal.noteHint"));
        break;
      case SUB_INST:
        label(t("pal.instrument"));
        hint(t("pal.instHint"));
        break;
      case SUB_VOL: {
        label(t("pal.volColumn"));
        const sel = ctx.cell.volumeEff;
        const isNoop = sel === 3 && ctx.cell.volume === 0;
        btn(t("pal.volSet"), t("pal.volSetTitle"), () => ctx.apply({ volumeEff: 0 }), !isNoop && sel === 0);
        btn(t("pal.slideUp"), t("pal.slideUpTitle"), () => ctx.apply({ volumeEff: 1 }), sel === 1);
        btn(t("pal.slideDn"), t("pal.slideDnTitle"), () => ctx.apply({ volumeEff: 2 }), sel === 2);
        btn(t("pal.fine"), t("pal.volFineTitle"), () => ctx.apply({ volumeEff: 3 }), !isNoop && sel === 3);
        btn(t("pal.clear"), t("pal.noopTitle"), () => ctx.apply({ volume: 0, volumeEff: 3 }));
        hint(t("pal.hexHint"));
        break;
      }
      case SUB_PAN: {
        label(t("pal.panColumn"));
        const sel = ctx.cell.panEff;
        const isNoop = sel === 3 && ctx.cell.pan === 0;
        btn(t("pal.panSet"), t("pal.panSetTitle"), () => ctx.apply({ panEff: 0 }), !isNoop && sel === 0);
        btn(t("pal.slideRight"), t("pal.slideRightTitle"), () => ctx.apply({ panEff: 1 }), sel === 1);
        btn(t("pal.slideLeft"), t("pal.slideLeftTitle"), () => ctx.apply({ panEff: 2 }), sel === 2);
        btn(t("pal.fine"), t("pal.panFineTitle"), () => ctx.apply({ panEff: 3 }), !isNoop && sel === 3);
        btn(t("pal.clear"), t("pal.noopTitle"), () => ctx.apply({ pan: 0, panEff: 3 }));
        hint(t("pal.hexHint"));
        break;
      }
      case SUB_FX_OP: {
        label(t("pal.effect"));
        for (const [op, info] of Object.entries(FX_INFO)) {
          btn(info.l, `${info.n} — ${info.a}`, () => ctx.apply({ effect: parseInt(op, 10) }),
            ctx.cell.effect === parseInt(op, 10));
        }
        btn("×", t("pal.clearFxTitle"), () => ctx.apply({ effect: 0, effectArg: 0 }));
        break;
      }
      case SUB_FX_ARG: {
        const info = FX_INFO[ctx.cell.effect];
        label(t("pal.argument"));
        hint(info
          ? `${info.l} ${info.n}: ${info.a}`
          : ctx.cell.effect === 0 ? t("pal.noEffect") : t("pal.unknownOpcode"));
        break;
      }
    }
  }
}
