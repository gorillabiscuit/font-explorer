// The data model every feature implements against: how a wordmark is laid out, and the exact
// recipe a candidate was saved with. Later features fill these fields in; they never reshape them.
// Kept free of React and the DOM (and of value imports from settings.ts, which imports this file)
// so the Node check scripts can load it.
import { italicWeightsOf } from "./italic";
import { deepEqual, deepMerge } from "./merge";
import type { Settings, TextCase } from "./settings";
import type { FontEntry } from "./types";

export type Formation = "line" | "stack" | "block" | "lockup" | "mark";
export type MatchMode = "auto" | "cap" | "x" | "width" | "em";

/** Keys 1-5 pick these, in this order. */
export const FORMATION_ORDER: Formation[] = ["line", "stack", "block", "lockup", "mark"];
export const FORMATION_LABELS: Record<Formation, string> = {
  line: "Line",
  stack: "Stack",
  block: "Block",
  lockup: "Lockup",
  mark: "Mark",
};

export interface LayoutSettings {
  formation: Formation;
  /** What gets equalised between fonts: cap height, x-height, ink width or plain font size. */
  match: MatchMode;
  /** Put the first letter's ink, not its sidebearing, on the edge. */
  opticalEdge: boolean;
  /** Break positions (character indexes into the flat name), or null to use a typed '/' or none. */
  breaks: number[] | null;
  stack: { align: "left" | "center" | "right"; justify: "none" | "track" | "size"; leading: number };
  block: {
    mode: "cells" | "rows";
    cols: number | null;
    /** Between the letters of a row (cells mode), in cap heights. */
    gap: number;
    /**
     * Between rows, in cap heights. null means the same as `gap`: layouts saved before rows had a gap
     * of their own used one gap both ways, and still draw that way (see rowGapOf).
     */
    rowGap: number | null;
    lastRow: "left" | "center";
  };
  lockup: {
    descriptor: string;
    position: "below" | "right" | "above";
    align: "left" | "center" | "right";
    size: "match" | number;
    textCase: TextCase;
    tracking: number;
    gap: number;
  };
  mark: { initials: string; construction: "single" | "pair" | "stacked" };
  container: {
    shape: "none" | "square" | "rounded" | "circle" | "pill";
    style: "fill" | "keyline" | "guide";
    padding: number;
    auto: boolean;
  };
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  formation: "line",
  match: "auto",
  opticalEdge: true,
  breaks: null,
  stack: { align: "left", justify: "none", leading: 0.25 },
  // rowGap null follows gap, so it starts at 0.18 too. A number here would be deep-merged into every
  // old saved layout and change the row spacing of any whose gap was not the default.
  block: { mode: "cells", cols: null, gap: 0.18, rowGap: null, lastRow: "center" },
  lockup: { descriptor: "", position: "below", align: "left", size: "match", textCase: "upper", tracking: 0.12, gap: 0.6 },
  mark: { initials: "", construction: "single" },
  container: { shape: "none", style: "fill", padding: 1, auto: true },
};

/** Everything that decides how one font sets the name. Two candidates of one family differ here. */
export interface Recipe {
  text: string;
  weight: number;
  /** The family's real italic. Absent in recipes saved before italics existed, which are upright. */
  italic?: boolean;
  textCase: TextCase;
  /** Letter-spacing in em. */
  tracking: number;
  /** OpenType features switched on (1) or explicitly off (0), e.g. { ss01: 1, kern: 0 }. */
  features: Record<string, 0 | 1>;
  /** Variable-font axes. Reserved: nothing sets them yet. */
  axes: Record<string, number> | null;
  layout: LayoutSettings;
}

export interface Candidate {
  /** A uuid, so one family can be a candidate twice with different recipes. */
  id: string;
  fontId: string;
  recipe: Recipe;
  note: string;
  /** ms timestamp */
  addedAt: number;
}

/** The recipe the grid is showing right now. Grid settings carry no features or axes. */
export function recipeFromSettings(s: Settings): Recipe {
  return {
    text: s.text,
    weight: s.weight,
    italic: s.italic,
    textCase: s.textCase,
    tracking: s.tracking,
    features: {},
    axes: null,
    layout: structuredClone(s.layout),
  };
}

const EMPTY_RECIPE: Recipe = { text: "", weight: 400, italic: false, textCase: "as", tracking: 0, features: {}, axes: null, layout: DEFAULT_LAYOUT };

/**
 * Same exact setting. Missing layout fields count as their defaults, so a candidate saved before a
 * field existed still matches the grid (pressing S again removes it instead of adding a twin).
 */
export function sameRecipe(a: Recipe, b: Recipe): boolean {
  return deepEqual(settled(a), settled(b));
}

/** The recipe with every default filled in, and a row gap that follows the gap written out, since it draws the same. */
function settled(r: Recipe): Recipe {
  const full = deepMerge(EMPTY_RECIPE, r);
  const { block } = full.layout;
  return { ...full, layout: { ...full.layout, block: { ...block, rowGap: rowGapOf(block) } } };
}

/** Block's gap between rows in cap heights: its own, or the one gap for layouts saved before it had one. */
export function rowGapOf(block: Pick<LayoutSettings["block"], "gap" | "rowGap">): number {
  return block.rowGap ?? block.gap;
}

/**
 * The recipe as this font actually draws it: the weight snaps to the nearest one the family ships.
 * A family with only a 400 draws 'weight 700' at 400, so the two are the same candidate. Likewise an
 * italic snaps to the nearest italic weight, and a family with no italic draws upright, so its
 * recipe says upright. An installed font keeps its italic: whether one is installed is unknown.
 */
export function drawnRecipe(font: FontEntry, r: Recipe): Recipe {
  const italicWeights = r.italic ? italicWeightsOf(font) : [];
  const italic = !!r.italic && (font.source === "local" || italicWeights.length > 0);
  const weights = italic && font.source !== "local" ? italicWeights : font.weights;
  const weight = font.source === "local" || !weights.length ? r.weight : nearest(weights, r.weight);
  return weight === r.weight && italic === !!r.italic ? r : { ...r, weight, italic };
}

/** e.g. 'Satoshi · 500 · UPPER · -0.02em · Stack · ss01'. Defaults (as typed, 0 tracking) are left out. */
export function recipeLabel(font: FontEntry, r: Recipe): string {
  const { weight, italic } = drawnRecipe(font, r);
  const parts = [font.family, String(weight)];
  if (italic) parts.push("Italic");
  if (r.textCase === "upper") parts.push("UPPER");
  if (r.textCase === "lower") parts.push("lower");
  if (r.tracking) parts.push(`${r.tracking > 0 ? "+" : ""}${Number(r.tracking.toFixed(3))}em`);
  parts.push(FORMATION_LABELS[r.layout?.formation] ?? FORMATION_LABELS.line);
  for (const [tag, on] of Object.entries(r.features ?? {})) parts.push(on ? tag : `no ${tag}`);
  for (const [axis, v] of Object.entries(r.axes ?? {})) parts.push(`${axis} ${v}`);
  return parts.join(" · ");
}

/** Same rule as fonts.ts nearestWeight, repeated here to keep this file free of browser code. */
function nearest(weights: number[], wanted: number): number {
  return weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), weights[0]);
}
