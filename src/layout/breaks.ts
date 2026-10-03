// Where to break a name into two or three lines for Stack (and later Block). DOM-free.
import type { Measurer } from "../facts/types";
import type { LayoutSettings } from "../recipe";
import type { LayoutInput } from "./types";

export interface BreakSuggestion {
  /** Positions in the flat name where each new line starts (see applyBreaks). */
  breaks: number[];
  lines: string[];
  /** e.g. 'UNI/QLO' */
  label: string;
  /** (widest - narrowest) / widest: 0 is perfectly balanced. */
  balance: number;
}

const visible = (s: string) => s.match(/\S/gu)?.length ?? 0;
const letters = (s: string) => s.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

/**
 * Splits the flat name at the given positions. A position is the index of the first character of the
 * new line; spaces at a break are dropped, so breaking 'Acme Studio' at its space gives 'Acme' and
 * 'Studio'. Positions outside the name (left over from an earlier name) are ignored.
 */
export function applyBreaks(flat: string, breaks: number[]): string[] {
  const cuts = [...new Set(breaks)].filter((i) => Number.isInteger(i) && i > 0 && i < flat.length).sort((a, b) => a - b);
  const lines: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    lines.push(flat.slice(from, cut).trim());
    from = cut;
  }
  lines.push(flat.slice(from).trim());
  return lines.filter(Boolean);
}

/**
 * The best splits into `count` lines, at most 4, each line keeping at least 2 letters. Ranked by how
 * evenly the lines' ink widths match (from the measurer at a reference size), or by letter count
 * without one. A multi-word name breaks only between words when it can ('Acme/Studio', never
 * 'Acme S/tudio'), and inside words only when there are too few words. Three-line splits need 9 letters.
 */
export function suggestBreaks(flat: string, measurer: Measurer | null, count: 2 | 3 = 2): BreakSuggestion[] {
  if (count === 3 && letters(flat) < 9) return [];
  const all = breakPositions(flat);
  const between = rank(flat, measurer, count, splitsOf(all.filter((i) => /\s/.test(flat[i])), count));
  return between.length ? between : rank(flat, measurer, count, splitsOf(all, count));
}

function splitsOf(positions: number[], count: 2 | 3): number[][] {
  const splits: number[][] = [];
  if (count === 2) for (const i of positions) splits.push([i]);
  else for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) splits.push([positions[a], positions[b]]);
  return splits;
}

function rank(flat: string, measurer: Measurer | null, count: 2 | 3, splits: number[][]): BreakSuggestion[] {
  const widths = new Map<string, number>();
  const widthOf = (line: string) => {
    let w = widths.get(line);
    if (w === undefined) {
      const m = measurer?.run(line, { size: 100 });
      w = m ? m.inkRight - m.inkLeft : visible(line);
      widths.set(line, w);
    }
    return w;
  };

  const seen = new Set<string>();
  const ranked: (BreakSuggestion & { inWord: number; offCentre: number })[] = [];
  for (const breaks of splits) {
    const lines = applyBreaks(flat, breaks);
    if (lines.length !== count || lines.some((l) => letters(l) < 2)) continue;
    const label = lines.join("/");
    if (seen.has(label)) continue;
    seen.add(label);
    const w = lines.map(widthOf);
    const widest = Math.max(...w);
    ranked.push({
      breaks,
      lines,
      label,
      balance: widest > 0 ? (widest - Math.min(...w)) / widest : 0,
      // Breaks that split a word, so a multi-word name keeps its words whole wherever it can.
      inWord: breaks.filter((i) => !/\s/.test(flat[i])).length,
      offCentre: breaks.reduce((sum, i, k) => sum + Math.abs(i / flat.length - (k + 1) / count), 0),
    });
  }
  ranked.sort((a, b) => a.inWord - b.inWord || a.balance - b.balance || a.offCentre - b.offCentre);
  return ranked.slice(0, 4).map(({ breaks, lines, label, balance }) => ({ breaks, lines, label, balance }));
}

/** Where a stack breaks when nothing was typed or chosen: the most even split by letter count, so every font breaks alike. */
export function defaultBreaks(flat: string): number[] | null {
  return suggestBreaks(flat, null, 2)[0]?.breaks ?? null;
}

/** A Stack's lines: a typed '/' always wins, then the chosen breaks, then the default split. */
export function stackLines(input: LayoutInput, layout: LayoutSettings): string[] {
  if (input.lines.length > 1) return input.lines;
  if (layout.breaks?.length) {
    const chosen = applyBreaks(input.flat, layout.breaks);
    if (chosen.length > 1) return chosen;
  }
  const auto = defaultBreaks(input.flat);
  return auto ? applyBreaks(input.flat, auto) : [input.flat];
}

/** Indexes a line may start at: after a space (once per run of spaces), or between two letters of a word. */
function breakPositions(flat: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < flat.length; i++) {
    const c = flat.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // inside a surrogate pair
    if (/\p{M}/u.test(flat[i])) continue; // an accent stays on its letter
    // Right after a space is the same break as at that space, so only the space itself counts.
    if (!/\s/.test(flat[i - 1])) out.push(i);
  }
  return out;
}
