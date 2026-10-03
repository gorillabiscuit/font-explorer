// What a font file tells us about its shapes, and how a run of text measures in it.
// Shared by the browser (facts/index.ts) and the Node check scripts, so nothing here touches the DOM.

/** OpenType feature switches, e.g. { ss01: 1, kern: 0 }. Recipe.features uses 0 and 1. */
export type FeatureSettings = Record<string, 0 | 1 | boolean>;

/** Variable-font axis values, e.g. { wght: 650 }. */
export type Variation = Record<string, number>;

export interface FontFeature {
  tag: string;
  /** The font's own name for a stylistic set ("Single-storey a"), when it gives one. */
  uiName?: string;
}

export interface AxisRange {
  min: number;
  max: number;
  default: number;
}

/**
 * Vertical metrics are in em (1 = the font size) and measured from the actual glyphs where they
 * exist, because the values stored in the OS/2 table are often wrong.
 */
export interface FontFacts {
  /** Units per em of the font's design grid. */
  upm: number;
  /** Top of 'H'. */
  capHeight: number;
  /** Top of 'x'. Equals capHeight when the font has neither an 'x' nor a stored x-height. */
  xHeight: number;
  /** Top of 'd' or 'h', whichever is taller. */
  ascender: number;
  /** Bottom of 'p' or 'g', whichever is lower. Negative: below the baseline. */
  descender: number;
  /** How far 'O' rises above 'H'. Zero or more. */
  overshoot: number;
  /** The font maps every letter a-z. */
  hasLower: boolean;
  /** 'a' draws the same glyph as 'A': a caps-only face. */
  lowerIsCaps: boolean;
  hasKerning: boolean;
  /** Only the features that matter for a wordmark: stylistic sets, alternates, ligatures, case. */
  features: FontFeature[];
  axes: Record<string, AxisRange>;
  /** True when the font has a glyph for every character of `ch`. */
  covers(ch: string): boolean;
}

export interface RunOptions {
  /** Font size in px. */
  size: number;
  /** Extra space between glyphs in em, never added after the last one. */
  tracking?: number;
  features?: FeatureSettings;
}

/**
 * One glyph of a measured run. x and the ink edges are px from the run's origin (the pen position
 * where the run starts); y points up from the baseline.
 */
export interface GlyphMetrics {
  /** Index into the measured text (UTF-16) of the first character this glyph draws. */
  index: number;
  /** The characters this glyph draws: one usually, several for a ligature, '' for an extra glyph. */
  char: string;
  /** Where the glyph is drawn, tracking included. */
  x: number;
  /** The glyph's own advance, without tracking. */
  advance: number;
  inkL: number;
  inkR: number;
  inkT: number;
  inkB: number;
  /**
   * The font has no glyph for this character. Its ink is then the placeholder box a layout draws
   * instead: the .notdef advance wide and cap-height tall, so nothing is measured from a fallback font.
   */
  missing: boolean;
}

/** A measured run, in px at the requested size, y up from the baseline. */
export interface RunMetrics {
  /** Pen distance from start to end, with tracking between glyphs but not after the last one. */
  advance: number;
  /** The run's ink box. All zero when nothing in the run has ink (only spaces, or empty). */
  inkLeft: number;
  inkRight: number;
  inkTop: number;
  inkBottom: number;
  glyphs: GlyphMetrics[];
}

/**
 * Measures text in one face at one weight. The vertical metrics are in em, like FontFacts; run()
 * answers in px. `exact` is true when the numbers come from the font file (fontkit) and false when
 * they come from the browser's canvas, which cannot apply OpenType features and sees fallback fonts.
 */
export interface Measurer {
  capHeight: number;
  xHeight: number;
  ascender: number;
  descender: number;
  overshoot: number;
  exact: boolean;
  run(text: string, opts: RunOptions): RunMetrics;
}

/** One glyph outline from pathFor, already placed in the run. */
export interface GlyphPath {
  index: number;
  char: string;
  /** SVG path data in px, y pointing down, baseline at y = 0. Empty for glyphs with no ink. */
  d: string;
  x: number;
  missing: boolean;
}

export interface RunPath {
  /** Every glyph's outline joined into one path. Missing glyphs are left out. */
  d: string;
  glyphs: GlyphPath[];
  advance: number;
}
