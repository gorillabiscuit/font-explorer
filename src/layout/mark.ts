// Mark: the name's initial (or a pair of them) as a monogram, the shape an app icon or avatar takes.
// The engine fits it in its tile (container.ts); then a row of the same mark at 32 and 16 px is set
// under the tile, as real text at real sizes, so how the face survives a favicon is seen, not guessed.
import { lettersOf, letterAt } from "./block";
import { inkBounds, moveFormed, placeLine, scaleFormed, type SetLine } from "./engine";
import type { FormationContext, Formed, LayoutInput, Rect, Run } from "./types";

/** Space between a pair's letters, in em: the second letter's ink starts this far past the first's. */
const PAIR_GAP = 0.04;
/** A stacked pair's gap between the lines, in cap heights. */
const STACK_LEADING = 0.15;
/** The small renders under the tile, by height in px. */
export const MARK_SIZES = [32, 16];
const MINI_GAP = 12;

/**
 * The initials: the override, else the first letter of each word or '/' segment, else the first two
 * letters of a one-word name. The caller hands the override over in the name's Case, as Wordmark
 * does, so the lightbox's favicon shows the same letter.
 */
export function markInitials(input: LayoutInput): string[] {
  const typed = lettersOf(input.initials ?? "");
  if (typed.length) return typed;
  const words = input.lines.flatMap((l) => l.split(/\s+/u)).filter((w) => lettersOf(w).length);
  if (words.length > 1) return words.map((w) => lettersOf(w)[0]);
  return lettersOf(input.flat).slice(0, 2);
}

export function formMark(ctx: FormationContext): Formed {
  const m = ctx.measurer;
  const size = ctx.fontSize;
  const { construction } = ctx.layout.mark;
  const initials = markInitials(ctx.input);
  const shown = construction === "single" ? initials.slice(0, 1) : initials.slice(0, 2);
  if (!shown.length) return { runs: [], missing: [], box: { w: 0, h: m.capHeight * size }, fit: [], warnings: [] };

  const capPx = m.capHeight * size;
  const set = shown.map((letter) => {
    const metrics = letterAt(m, letter, size, ctx.opts.features);
    const line: SetLine = { text: letter, size, tracking: 0, features: ctx.opts.features, metrics, left: metrics.inkLeft, right: metrics.inkRight };
    return line;
  });
  // Each letter is placed by its ink, measured alone: a monogram's letters are spaced by eye, not kerned.
  const places: { x: number; y: number }[] = [];
  if (construction === "stacked" && set.length > 1) {
    const widest = Math.max(...set.map((l) => l.right - l.left));
    set.forEach((l, i) => places.push({ x: (widest - (l.right - l.left)) / 2 - l.left, y: capPx + i * capPx * (1 + STACK_LEADING) }));
  } else {
    let inkEnd = 0;
    set.forEach((l, i) => {
      const x = i === 0 ? -l.left : inkEnd + PAIR_GAP * size - l.left;
      places.push({ x, y: capPx });
      inkEnd = x + l.right;
    });
  }

  const runs: Run[] = [];
  const missing: Rect[] = [];
  set.forEach((l, i) => {
    const placed = placeLine(ctx, l, places[i].x, places[i].y, "initial");
    runs.push(...placed.runs);
    missing.push(...placed.missing);
  });
  const ink = inkBounds({ runs, missing });
  const lastBaseline = places[places.length - 1].y;
  return {
    runs,
    missing,
    box: { w: ink ? ink.x + ink.w : 0, h: lastBaseline },
    fit: [],
    warnings: [],
    after: (fitted) => withMarkSizes(fitted, ctx),
  };
}

/**
 * The fitted mark plus copies of it 32 and 16 px tall (tile included) in a row under it. Skipped in a
 * fixed box (Compare's columns are one size test each) and under a tile too small to need them.
 */
function withMarkSizes(f: Formed, ctx: FormationContext): Formed {
  if (ctx.opts.boxHeight !== undefined) return f;
  const frame: Rect | null = f.container ?? inkBounds(f);
  if (!frame || frame.h < 2 * MARK_SIZES[0]) return f;
  const base: Formed = { ...f, after: undefined, tiles: undefined };
  const top = frame.y + frame.h + MINI_GAP;
  const row = Math.max(...MARK_SIZES);
  const runs = [...f.runs];
  const missing = [...f.missing];
  const tiles = [...(f.tiles ?? [])];
  let x = frame.x;
  for (const px of MARK_SIZES) {
    const k = px / frame.h;
    // Centred on the row, so the two icons share a middle line.
    const copy = moveFormed(scaleFormed(base, k), x - frame.x * k, top + (row - px) / 2 - frame.y * k);
    runs.push(...copy.runs);
    missing.push(...copy.missing);
    if (copy.container) tiles.push(copy.container);
    x += frame.w * k + MINI_GAP;
  }
  return {
    ...f,
    runs,
    missing,
    tiles,
    box: { w: Math.max(f.box.w, x - MINI_GAP), h: Math.max(f.box.h, top + row) },
    after: undefined,
  };
}
