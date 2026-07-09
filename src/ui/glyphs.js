// Vector note-glyph painter — the web equivalent of taut's custom pattern
// font (tautfont_*.chr), redrawn as canvas paths so they scale with the cell
// metrics. Renders the 4-char-wide note cell:
//
//   [letter][ accidental ×2 ][octave]      normal presets (taut layout —
//                                          accidentals span TWO cells)
//   [tick][letter][acc ×1][octave]         Kite notation (compact accidental)
//   [  CJK char spanning 2  ][oct][ ]      Shi'er lü (conventional CJK font)
//   [    sentinel vector, full width  ]    key-off / cut / fade / fast-fade
//   [ IntH ] / [ hex4 ]                    interrupts / raw mode & no-preset
//
// ── MANUAL TUNING ──
// All glyph geometry lives in the GLYPH table below as fractions of the cell
// box (x/w horizontal, y/h vertical). Tweak a number, reload
// test/browser/glyph-gallery.html (it renders every glyph large), iterate.
// Sentinel shapes per spec: key-off = wide low-height rectangle; cut =
// connected vertically-centred ^^^; fade = connected greater-amplitude ~~~;
// fast-fade = the CUT mirrored vertically (∨∨∨).

import { resolveNoteSymbol } from "./pitchtables.js";
import { hex4 } from "./notenames.js";

export const NOTE_CELL_CHARS = 4;

export const GLYPH = {
  lineWidth: 1.3,

  // sentinels (fractions of the full 4-char cell)
  keyoffW: 0.76,      // box width
  keyoffH: 0.28,      // box height
  cutAmp: 0.17,       // ^^^ amplitude (of cell height)
  cutPeaks: 4,
  cutSpanX: [0.10, 0.90],
  fadeAmp: 0.13,      // ~~~ amplitude
  fadePeriods: 3,
  fadeSpanX: [0.12, 0.88],

  // sharp family (fractions of one accidental box)
  sharpRise: 0.08,    // crossbar upward slant
  sharpBarX: [0.25, 0.75],
  sharpStemX: [0.38, 0.62],
  sharpVertY: [0.16, 0.84],
  sharpCrossY: [0.36, 0.60],

  // flat family
  flatStemY: [0.12, 0.82],
  flatLoopTopY: 0.58,
  flatSpan: [0.62, 0.72, 0.82],     // width used by the loop run (multi-flats divide this)

  // double sharp (𝄪)
  dsRadius: 0.24,     // of box width
  dsDotSize: 0.36,    // serif dot size relative to radius

  // Kite ticks
  tickW: 0.32,
  tickH: 0.16,
  tickDoubleY: [0.36, 0.64],
  bigDotR: 0.16,

  // natural marker (the '-' in "C-")
  naturalX: [0.30, 0.70],

  // CJK font for Shi'er lü
  cjkFont: '"Noto Sans CJK TC", "Noto Sans CJK", "WenQuanYi Zen Hei", sans-serif',
};

// ── sentinel vectors (span the whole cell width) ──

function drawKeyOff(ctx, x, y, w, h) {
  const bw = w * GLYPH.keyoffW;
  const bh = h * GLYPH.keyoffH;
  ctx.strokeRect(x + (w - bw) / 2 + 0.5, y + (h - bh) / 2 + 0.5, bw, bh);
}

function drawCut(ctx, x, y, w, h, mirrored) {
  // connected ^^^ (mirrored = fast-fade's ∨∨∨), vertically centred
  const amp = h * GLYPH.cutAmp * (mirrored ? -1 : 1);
  const cy = y + h / 2;
  const x0 = x + w * GLYPH.cutSpanX[0];
  const x1 = x + w * GLYPH.cutSpanX[1];
  const seg = (x1 - x0) / (GLYPH.cutPeaks * 2);
  ctx.beginPath();
  ctx.moveTo(x0, cy + amp);
  for (let i = 0; i < GLYPH.cutPeaks; i++) {
    ctx.lineTo(x0 + seg * (i * 2 + 1), cy - amp);
    ctx.lineTo(x0 + seg * (i * 2 + 2), cy + amp);
  }
  ctx.stroke();
}

function drawFade(ctx, x, y, w, h) {
  // connected ~~~ — smooth wave, larger amplitude than the cut
  const amp = h * GLYPH.fadeAmp;
  const cy = y + h / 2;
  const x0 = x + w * GLYPH.fadeSpanX[0];
  const x1 = x + w * GLYPH.fadeSpanX[1];
  const n = 32;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const px = x0 + ((x1 - x0) * i) / n;
    const py = cy - Math.sin((i / n) * Math.PI * 2 * GLYPH.fadePeriods) * amp;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// ── accidentals, drawn inside a box (x, y, w, h) ──

function drawSharpBody(ctx, x, y, w, h, verticals) {
  // verticals straight; crossbars slanted UPWARD to the right (♯, not #)
  const rise = h * GLYPH.sharpRise;
  const xL = x + w * GLYPH.sharpBarX[0];
  const xR = x + w * GLYPH.sharpBarX[1];
  const vXs = [];
  for (let i = 0; i < verticals; i++) {
    const t = (verticals === 1 || verticals === 3 && i === 1) ? 0.5 : (i === 0) ? GLYPH.sharpStemX[0] : GLYPH.sharpStemX[1];
    vXs.push(x + w * t);
  }
  ctx.beginPath();
  for (const vx of vXs) {
    ctx.moveTo(vx, y + h * GLYPH.sharpVertY[0]);
    ctx.lineTo(vx, y + h * GLYPH.sharpVertY[1]);
  }
  for (const cyf of GLYPH.sharpCrossY) {
    const cy = y + h * cyf;
    ctx.moveTo(xL, cy + rise);
    ctx.lineTo(xR, cy - rise);
  }
  ctx.stroke();
}

function drawFlatBody(ctx, x, y, w, h, mirrored, count = 1) {
  // stem + right-facing loop (♭); mirrored = demiflat (loop opens left)
  const span = w * GLYPH.flatSpan[count-1];
  const each = span / count;
  for (let i = 0; i < count; i++) {
    const sx = mirrored
      ? x + w * (0.5 + GLYPH.flatSpan[count-1] / 2) - each * i - each * 0.15
      : x + w * (0.5 - GLYPH.flatSpan[count-1] / 2) + each * i + each * 0.15;
    const dir = mirrored ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(sx, y + h * GLYPH.flatStemY[0]);
    ctx.lineTo(sx, y + h * GLYPH.flatStemY[1]);
    ctx.bezierCurveTo(
      sx + dir * each * 0.85, y + h * (GLYPH.flatLoopTopY - 0.06),
      sx + dir * each * 0.55, y + h * (GLYPH.flatLoopTopY - 0.18),
      sx, y + h * GLYPH.flatLoopTopY,
    );
    ctx.stroke();
  }
}

function drawDoubleSharp(ctx, x, y, w, h, pair = false) {
  // 𝄪 — an × with serif dots; pair=true draws two side by side (quad sharp)
  const draw = (cx, cy, r) => {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    ctx.stroke();
    const d = r * GLYPH.dsDotSize;
    for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
      ctx.fillRect(cx + dx - d / 2, cy + dy - d / 2, d, d);
    }
  };
  const cy = y + h * 0.5;
  if (pair) {
    draw(x + w * 0.28, cy, w * GLYPH.dsRadius * 0.62);
    draw(x + w * 0.72, cy, w * GLYPH.dsRadius * 0.62);
  } else {
    draw(x + w * 0.5, cy, w * GLYPH.dsRadius);
  }
}

function drawTripleSharp(ctx, x, y, w, h) {
  // ♯𝄪 — with a two-cell box there is room for both halves
  drawSharpBody(ctx, x, y, w * 0.72, h, 2);
  const cx = x + w * 0.76;
  const cy = y + h * 0.5;
  const r = w * 0.16;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
  ctx.stroke();
  const d = r * GLYPH.dsDotSize;
  for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    ctx.fillRect(cx + dx - d / 2, cy + dy - d / 2, d, d);
  }
}

function drawNatural(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x + w * GLYPH.naturalX[0], y + h * 0.5);
  ctx.lineTo(x + w * GLYPH.naturalX[1], y + h * 0.5);
  ctx.stroke();
}

// ── Kite ticks ──

function drawTick(ctx, x, y, w, h, up, double_) {
  const cx = x + w * 0.5;
  const aw = w * GLYPH.tickW;
  const ah = h * GLYPH.tickH;
  const draw = (cy) => {
    ctx.beginPath();
    if (up) {
      ctx.moveTo(cx - aw, cy + ah);
      ctx.lineTo(cx, cy - ah);
      ctx.lineTo(cx + aw, cy + ah);
    } else {
      ctx.moveTo(cx - aw, cy - ah);
      ctx.lineTo(cx, cy + ah);
      ctx.lineTo(cx + aw, cy - ah);
    }
    ctx.stroke();
  };
  if (double_) {
    draw(y + h * GLYPH.tickDoubleY[0]);
    draw(y + h * GLYPH.tickDoubleY[1]);
  } else {
    draw(y + h * 0.5);
  }
}

function drawBigDot(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.5, Math.max(w, 4) * GLYPH.bigDotR, 0, Math.PI * 2);
  ctx.fill();
}

function drawAccidental(ctx, code, x, y, w, h) {
  switch (code) {
    case "#": drawSharpBody(ctx, x, y, w, h, 2); break;
    case "t": drawSharpBody(ctx, x, y, w, h, 1); break;          // demisharp
    case "b": drawFlatBody(ctx, x, y, w, h, false, 1); break;
    case "p": drawFlatBody(ctx, x, y, w, h, true, 1); break;     // demiflat
    case "x": drawDoubleSharp(ctx, x, y, w, h, false); break;
    case "B": drawFlatBody(ctx, x, y, w, h, false, 2); break;    // double flat
    case "3": drawTripleSharp(ctx, x, y, w, h); break;
    case "T": drawFlatBody(ctx, x, y, w, h, false, 3); break;    // triple flat
    case "4": drawDoubleSharp(ctx, x, y, w, h, true); break;     // quad sharp
    default: drawNatural(ctx, x, y, w, h); break;                // '-'
  }
}

function drawTickCode(ctx, code, x, y, w, h) {
  switch (code) {
    case ".": drawBigDot(ctx, x, y, w, h); break;
    case "u": drawTick(ctx, x, y, w, h, true, false); break;
    case "d": drawTick(ctx, x, y, w, h, false, false); break;
    case "U": drawTick(ctx, x, y, w, h, true, true); break;
    case "D": drawTick(ctx, x, y, w, h, false, true); break;
    default: break; // ' ' — no tick
  }
}

/**
 * Paint the 4-char note cell at (x, y).
 * palette: {note, sentinel, dim, offGrid} — off-grid ("out of tune") notes
 * paint in palette.offGrid (taut's yellow). rawMode forces hex4 for playable
 * notes (the taut rawNoteView toggle).
 */
export function paintNoteCell(ctx, note, preset, x, y, charW, rowH, palette, rawMode = false) {
  const cellW = charW * NOTE_CELL_CHARS;
  const midY = y + rowH / 2;

  if (note === 0x0000) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    ctx.fillText("····", x, midY);
    ctx.globalAlpha = 1;
    return;
  }

  // Sentinels — full-width vectors.
  if (note >= 0x0001 && note <= 0x0004) {
    ctx.strokeStyle = palette.sentinel;
    ctx.fillStyle = palette.sentinel;
    ctx.lineWidth = GLYPH.lineWidth;
    ctx.lineJoin = "miter";
    switch (note) {
      case 0x0001: drawKeyOff(ctx, x, y, cellW, rowH); break;
      case 0x0002: drawCut(ctx, x, y, cellW, rowH, false); break;
      case 0x0003: drawFade(ctx, x, y, cellW, rowH); break;
      case 0x0004: drawCut(ctx, x, y, cellW, rowH, true); break; // cut, mirrored
    }
    return;
  }
  if (note >= 0x0005 && note <= 0x000f) {
    ctx.fillStyle = palette.dim;
    ctx.fillText("rsvd", x, midY);
    return;
  }
  if (note >= 0x0010 && note <= 0x001f) {
    // taut notation: IntH, H = hex 0..F
    ctx.fillStyle = palette.sentinel;
    ctx.fillText("Int" + (note - 0x0010).toString(16).toUpperCase(), x, midY);
    return;
  }

  const symb = rawMode ? null : resolveNoteSymbol(note, preset);
  if (symb === null) {
    ctx.fillStyle = rawMode ? palette.note : palette.dim;
    ctx.fillText(hex4(note), x, midY);
    return;
  }

  // "Out of tune" (off the preset's grid): taut paints it yellow.
  const ink = symb.offGrid ? palette.offGrid : palette.note;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = GLYPH.lineWidth;
  ctx.lineJoin = "miter";

  if (symb.cjk) {
    // Shi'er lü — conventional CJK font across two slots + octave digit.
    const prevFont = ctx.font;
    ctx.font = `${Math.round(rowH - 3)}px ${GLYPH.cjkFont}`;
    ctx.fillText(symb.cjk, x + charW * 0.1, midY + 0.5);
    ctx.font = prevFont;
    ctx.fillText(String(symb.octave), x + charW * 2.35, midY);
    return;
  }

  if (symb.tick !== " ") {
    // Kite: [tick][letter][compact accidental][octave]
    drawTickCode(ctx, symb.tick, x, y + 1, charW, rowH - 2);
    ctx.fillText(symb.letter, x + charW * 1.1, midY);
    drawAccidental(ctx, symb.acc, x + charW * 1.8, y + 2, charW * 1.5, rowH - 4);
    ctx.fillText(String(symb.octave), x + charW * 3.1, midY);
  } else {
    // Normal presets: [letter][ accidental spanning TWO cells ][octave]
    ctx.fillText(symb.letter, x + charW * 0.1, midY);
    drawAccidental(ctx, symb.acc, x + charW * 1.05, y + 2, charW * 1.9, rowH - 4);
    ctx.fillText(String(symb.octave), x + charW * 3.1, midY);
  }
}
