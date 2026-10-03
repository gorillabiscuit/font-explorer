// Block: the name as a grid of letters, the Uniqlo look. 'cells' (the default) gives every letter its
// own equal square cell, centred on its ink and on the cap-height band; 'rows' sets each row as one
// kerned run, justified to the widest row by letter-spacing only. DOM-free, like the rest of layout/.
import type { Measurer, RunMetrics } from "../facts/types";
import { rowGapOf } from "../recipe";
import { applyBreaks } from "./breaks";
import { collides, formatTracking, headroom, footroom, lineWidth, placeLine, setLine, trackTo, type SetLine } from "./engine";
import type { FormationContext, Formed, LayoutWarning, Rect, Run, RunGlyph } from "./types";

/** Columns for the automatic grid by letter count: 6 letters is 3×2, 7 is 4+3. Other counts use ceil(√n). */
const AUTO_COLS: Record<number, number> = { 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 9: 3 };

/** A letter with any accents typed after it: one cell. */
const LETTER = /\P{M}\p{M}*/gu;

/**
 * Letters left out of the evenness readout: one stem, narrow in every face (an I is about 0.13 cap
 * heights wide in Inter, Poppins and Fira alike), so counting them measures the name, not the face.
 * Punctuation is left out for the same reason.
 */
const ONE_STEM = /^[Iilj1]|^[^\p{L}\p{N}]/u;

export const lettersOf = (text: string): string[] => text.replace(/\s+/gu, "").match(LETTER) ?? [];

/**
 * The block's rows as text: a typed '/' wins, then chosen break positions, then the automatic grid
 * (spaces dropped, columns from layout.block.cols or the table above).
 */
export function blockRows(ctx: FormationContext): string[] {
  const { input, layout } = ctx;
  if (input.lines.length > 1) return input.lines;
  if (layout.breaks?.length) {
    const chosen = applyBreaks(input.flat, layout.breaks);
    if (chosen.length > 1) return chosen;
  }
  const letters = lettersOf(input.flat);
  const n = letters.length;
  const cols = gridCols(n, layout.block.cols);
  const rows: string[] = [];
  for (let i = 0; i < n; i += cols) rows.push(letters.slice(i, i + cols).join(""));
  return rows.length ? rows : [input.flat];
}

/** Letters per row of the automatic grid: the override, or the table, or ceil(√n). */
function gridCols(n: number, cols: number | null): number {
  return Math.max(1, Math.round(cols ?? AUTO_COLS[n] ?? Math.ceil(Math.sqrt(n))));
}

/**
 * The automatic grid as break positions in the flat name (see applyBreaks), so the break chips can
 * mark it as the default in Block; null when it is one row. A row that starts after a space breaks
 * at the space, where the chips put that break too.
 */
export function gridBreaks(flat: string, cols: number | null): number[] | null {
  const starts = [...flat.matchAll(LETTER)].filter((m) => !/\s/u.test(m[0])).map((m) => m.index);
  const step = gridCols(starts.length, cols);
  const breaks: number[] = [];
  for (let i = step; i < starts.length; i += step) {
    let at = starts[i];
    while (at > 0 && /\s/u.test(flat[at - 1])) at--;
    breaks.push(at);
  }
  return breaks.length ? breaks : null;
}

export function formBlock(ctx: FormationContext): Formed {
  return ctx.layout.block.mode === "rows" ? formRows(ctx) : formCells(ctx);
}

// --- cells ---

function formCells(ctx: FormationContext): Formed {
  const m = ctx.measurer;
  const size = ctx.fontSize;
  const features = ctx.opts.features;
  const rows = blockRows(ctx).map(lettersOf).filter((r) => r.length);
  const capPx = m.capHeight * size;
  // An empty name keeps one cell's height, so the card does not collapse while it is being typed.
  if (!rows.length) return { runs: [], missing: [], box: { w: 0, h: capPx }, fit: [], warnings: [] };
  // Letters sit on the cap-height band (an all-caps name) or the x-height band, never on the em box,
  // so a round letter's overshoot hangs out of the band as it does in type.
  const bandPx = (ctx.caps ? m.capHeight : m.xHeight) * size;
  const measured = rows.map((row) => row.map((letter) => letterAt(m, letter, size, features)));
  const all = measured.flat();
  const widths = rows.flat().flatMap((letter, i) => (ONE_STEM.test(letter.normalize("NFD")) || all[i].glyphs.some((g) => g.missing) ? [] : [inkWidth(all[i])]));
  // One cell for every letter: as wide as the widest letter's ink, and never less than a cap height.
  const cell = Math.max(capPx, ...all.map(inkWidth));
  // Across a row and down the rows are spaced apart, so the letters can sit tight while the lines
  // breathe (or the other way round). A layout saved before that uses one gap both ways.
  const gap = ctx.layout.block.gap * capPx;
  const rowGap = rowGapOf(ctx.layout.block) * capPx;
  const step = cell + gap;
  const rowStep = cell + rowGap;
  const cols = Math.max(...rows.map((r) => r.length));

  const runs: Run[] = [];
  const missing: Rect[] = [];
  const placedRows: RunGlyph[][] = [];
  rows.forEach((row, i) => {
    // A short row (the last one of 7 letters as 4+3, or a short typed line) sits centred or left.
    const shift = ctx.layout.block.lastRow === "center" ? ((cols - row.length) * step) / 2 : 0;
    const baseline = i * rowStep + cell / 2 + bandPx / 2;
    const glyphs: RunGlyph[] = [];
    row.forEach((letter, j) => {
      const metrics = measured[i][j];
      const centre = shift + j * step + cell / 2;
      const line: SetLine = { text: letter, size, tracking: 0, features, metrics, left: metrics.inkLeft, right: metrics.inkRight };
      const placed = placeLine(ctx, line, centre - (metrics.inkLeft + metrics.inkRight) / 2, baseline);
      runs.push(...placed.runs);
      missing.push(...placed.missing);
      glyphs.push(...placed.glyphs);
    });
    placedRows.push(glyphs);
  });

  const warnings: LayoutWarning[] = [];
  if (placedRows.some((row, i) => i > 0 && collides(placedRows[i - 1], row))) warnings.push("collision");
  return {
    runs,
    missing,
    box: { w: cols * cell + (cols - 1) * gap, h: rows.length * cell + (rows.length - 1) * rowGap },
    fit: widths.length > 1 ? [`evenness ${evenness(widths).toFixed(2)}`] : [],
    warnings,
  };
}

/**
 * How unevenly wide the letters are: the coefficient of variation of their ink widths (standard
 * deviation over mean), one-stem letters left out. Near 0, every letter fills its cell alike and the
 * face holds the module. Monospaced and grotesque faces score lowest; geometric capitals, with
 * their circular O and narrow L, score higher than humanist ones.
 */
export function evenness(widths: number[]): number {
  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  if (!(mean > 0)) return 0;
  const variance = widths.reduce((a, w) => a + (w - mean) ** 2, 0) / widths.length;
  return Math.sqrt(variance) / mean;
}

const inkWidth = (r: RunMetrics) => r.inkRight - r.inkLeft;

// --- rows ---

/** Each row one run, kerned as the font sets it, then letter-spaced out to the widest row (never scaleX). */
function formRows(ctx: FormationContext): Formed {
  const m = ctx.measurer;
  let lines = blockRows(ctx).map((t) => setLine(ctx, t, ctx.fontSize, ctx.opts.tracking));
  const target = Math.max(...lines.map(lineWidth));
  const fit: string[] = [];
  const warnings: LayoutWarning[] = [];
  let strained = false;
  if (lines.length > 1) {
    lines = lines.map((l) => {
      const tracked = trackTo(ctx, l, target);
      const extra = tracked.tracking - ctx.opts.tracking;
      // A one-letter row has no gap to spread, so it stays short and reads strained.
      if (Math.abs(extra) > 0.1 + 1e-9 || Math.abs(lineWidth(tracked) - target) > 0.5) strained = true;
      fit.push(formatTracking(extra));
      return tracked;
    });
  }
  if (strained) warnings.push("strained");

  // The gap between rows is in cap heights, as in cells: for caps it runs baseline to cap top, with
  // lowercase from one row's descenders to the next row's ascenders.
  const capPx = m.capHeight * ctx.fontSize;
  const rowGap = rowGapOf(ctx.layout.block) * capPx;
  const above = (l: SetLine) => (ctx.caps ? m.capHeight : m.ascender) * l.size;
  const below = (l: SetLine) => (ctx.caps ? 0 : -m.descender * l.size);
  const baselines = [headroom(ctx, lines[0])];
  for (let i = 1; i < lines.length; i++) baselines.push(baselines[i - 1] + below(lines[i - 1]) + above(lines[i]) + rowGap);

  const width = Math.max(...lines.map(lineWidth));
  const runs: Run[] = [];
  const missing: Rect[] = [];
  const placed = lines.map((l, i) => {
    // Only a row that could not reach the width is short; it follows the last-row setting.
    const slack = width - lineWidth(l);
    const p = placeLine(ctx, l, (ctx.layout.block.lastRow === "center" ? slack / 2 : 0) - l.left, baselines[i]);
    runs.push(...p.runs);
    missing.push(...p.missing);
    return p.glyphs;
  });
  if (placed.some((row, i) => i > 0 && collides(placed[i - 1], row))) warnings.push("collision");
  const last = lines.length - 1;
  return { runs, missing, box: { w: width, h: baselines[last] + footroom(ctx, lines[last]) }, fit, warnings };
}

// --- one letter at a time ---

/** Letters measured alone, per measurer (one per face) and features, at REF px; sizes scale linearly. */
const letters = new WeakMap<Measurer, Map<string, RunMetrics>>();
const REF = 100;

/**
 * One letter (or a few characters, unkerned against anything) measured on its own. Block cells, the
 * Mark and keyline strokes ask for the same few letters on every re-layout of every card, so each is
 * measured once per face and scaled.
 */
export function letterAt(m: Measurer, text: string, size: number, features?: Record<string, 0 | 1>): RunMetrics {
  let cache = letters.get(m);
  if (!cache) letters.set(m, (cache = new Map()));
  const key = `${features ? JSON.stringify(features) : ""}\u0000${text}`;
  let ref = cache.get(key);
  if (!ref) {
    ref = m.run(text, { size: REF, features });
    // A face that keeps getting new names should not keep every letter it ever saw.
    if (cache.size > 400) cache.clear();
    cache.set(key, ref);
  }
  const k = size / REF;
  return {
    advance: ref.advance * k,
    inkLeft: ref.inkLeft * k,
    inkRight: ref.inkRight * k,
    inkTop: ref.inkTop * k,
    inkBottom: ref.inkBottom * k,
    glyphs: ref.glyphs.map((g) => ({ ...g, x: g.x * k, advance: g.advance * k, inkL: g.inkL * k, inkR: g.inkR * k, inkT: g.inkT * k, inkB: g.inkB * k })),
  };
}
