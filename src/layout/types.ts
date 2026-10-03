// What the layout engine takes and gives. DOM-free, so the Node check scripts and the browser share it.
// Every position is in px in the result's own box, with y pointing down (SVG coordinates).
import type { LayoutSettings } from "../recipe";
import type { Measurer } from "../facts/types";

export interface LayoutInput {
  /** The name split at typed '/' breaks, cased. One entry when nothing was typed. */
  lines: string[];
  /** The name on one line, breaks taken out, spaces kept. */
  flat: string;
  /** Lockup's second line (F4). */
  descriptor?: string;
  /** Mark's initials override (F4). */
  initials?: string;
}

export interface RunGlyph {
  /** Index into the run's text of the first character this glyph draws. */
  index: number;
  char: string;
  /** Where the glyph is drawn, and its advance. */
  x: number;
  w: number;
  /** Its ink box. inkT is the top edge, so inkT < inkB. A glyph with no ink (a space) has a zero box. */
  inkL: number;
  inkR: number;
  inkT: number;
  inkB: number;
  missing: boolean;
}

/** One `<text>`: a line, or the part of a line between two missing letters. */
export interface Run {
  text: string;
  /** Pen position where the text starts. */
  x: number;
  /** Baseline. */
  y: number;
  /** Font size in px. */
  size: number;
  /** Letter-spacing in em. */
  tracking: number;
  weight: number;
  features: Record<string, 0 | 1>;
  slot: "name" | "descriptor" | "initial";
  /** Drawn faded: a placeholder the user has not typed yet (Lockup's 'DESCRIPTOR LINE'). */
  placeholder?: boolean;
  glyphs: RunGlyph[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ContainerShape extends Rect {
  shape: "square" | "rounded" | "circle" | "pill";
  rx: number;
  style: "fill" | "keyline" | "guide";
  /** Keyline stroke width in px. */
  stroke: number;
}

/** Advice, never a verdict: glyph boxes are not outlines, so a 'collision' may not actually touch. */
export type LayoutWarning = "collision" | "strained" | "scaled";

export interface LayoutResult {
  runs: Run[];
  /** Hatched placeholders where the font has no glyph. The letter is never drawn from a fallback font. */
  missing: Rect[];
  /** Everything drawn, missing placeholders included. */
  ink: Rect;
  /** The whole drawing, padding included: the SVG's size. */
  box: { w: number; h: number };
  container?: ContainerShape;
  /**
   * Smaller copies of the container, drawn like it: the tiles of Mark's 32 and 16 px icons under the
   * main one. Their letters are ordinary runs, at their real (small) sizes.
   */
  tiles?: ContainerShape[];
  /** Corrections the layout needed, shown under the card ('+0.04em', '×1.31', 'evenness 0.12'). */
  fit: string[];
  warnings: LayoutWarning[];
  /** The shrink applied to fit the box: 1 when nothing was scaled. */
  scale: number;
  /** The font size the name was matched to, before any shrink (px). */
  fontSize: number;
}

export interface LayoutOptions {
  /** The Size slider: what the match mode equalises (see matchedSize). */
  size: number;
  weight: number;
  /** Letter-spacing in em. */
  tracking: number;
  features?: Record<string, 0 | 1>;
  /** Room available, padding included. Without it nothing is scaled to fit. */
  boxWidth?: number;
  /** Height available, padding included, for fixed boxes (Compare's columns). Cards leave it out. */
  boxHeight?: number;
  /** Space around the drawing in px. 18 by default (the card's old padding). */
  pad?: number;
  /** The face is a serif (catalogue category): a keyline container then takes 8% of the cap height. */
  serif?: boolean;
}

/** What a formation gets: the inputs plus the font size the name was matched to. */
export interface FormationContext {
  input: LayoutInput;
  layout: LayoutSettings;
  measurer: Measurer;
  opts: Required<Pick<LayoutOptions, "size" | "weight" | "tracking" | "pad">> & Pick<LayoutOptions, "features" | "boxWidth" | "boxHeight" | "serif">;
  /** The name's font size after matching. */
  fontSize: number;
  /** The name has no lowercase letter: bands and leading are measured in cap heights, not x-heights. */
  caps: boolean;
}

/**
 * A formation's drawing before the engine pads and fits it. Coordinates are px with y down; x = 0 is
 * the alignment edge (where the left padding ends) and y = 0 the top of the drawing. `box` is the
 * area the padding goes around; ink may stick out of it, and the engine still keeps that ink in view.
 */
export interface Formed {
  runs: Run[];
  missing: Rect[];
  box: { w: number; h: number };
  container?: ContainerShape;
  tiles?: ContainerShape[];
  fit: string[];
  warnings: LayoutWarning[];
  /**
   * Runs once the drawing is fitted to its box, for parts that must keep their real size whatever
   * the fit (Mark's 32 and 16 px icons). It returns the finished drawing.
   */
  after?: (fitted: Formed) => Formed;
}

export type FormationFn = (ctx: FormationContext) => Formed;
