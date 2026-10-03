// A stand-in measurer with typical proportions, for the moments no real one exists: a card whose
// font has not loaded yet, and the grid's size estimates (grid.ts). It only has to get heights and
// rough widths right; nothing judged is ever measured with it.
import type { GlyphMetrics, Measurer, RunMetrics, RunOptions } from "../facts/types";

const NARROW = /[iljtfrI1.,;:'!|()[\]]/;
const WIDE = /[mwMW@%]/;
const TALL_LOWER = /[bdfhklt]/;
const DESCENDS = /[gjpqyQJ,;]/;

function advanceOf(ch: string): number {
  if (/\s/.test(ch)) return 0.28;
  if (NARROW.test(ch)) return 0.3;
  if (WIDE.test(ch)) return 0.86;
  return /\p{Lu}|\p{N}/u.test(ch) ? 0.68 : 0.56;
}

function topOf(ch: string): number {
  if (/\s/.test(ch)) return 0;
  if (/\p{Lu}|\p{N}/u.test(ch)) return 0.7;
  if (TALL_LOWER.test(ch)) return 0.74;
  return /\p{Ll}/u.test(ch) ? 0.5 : 0.7;
}

export const nominalMeasurer: Measurer = {
  capHeight: 0.7,
  xHeight: 0.5,
  ascender: 0.74,
  descender: -0.22,
  overshoot: 0.012,
  exact: false,
  run(text: string, { size, tracking = 0 }: RunOptions): RunMetrics {
    let pen = 0;
    const glyphs: GlyphMetrics[] = [];
    let index = 0;
    for (const char of text) {
      if (glyphs.length) pen += tracking * size;
      const advance = advanceOf(char) * size;
      const inked = !/\s/.test(char);
      glyphs.push({
        index,
        char,
        x: pen,
        advance,
        inkL: pen + (inked ? 0.05 * size : 0),
        inkR: pen + (inked ? advance - 0.05 * size : 0),
        inkT: topOf(char) * size,
        inkB: inked && DESCENDS.test(char) ? -0.22 * size : 0,
        missing: false,
      });
      pen += advance;
      index += char.length;
    }
    const inked = glyphs.filter((g) => g.inkR > g.inkL);
    return {
      advance: pen,
      inkLeft: inked.length ? Math.min(...inked.map((g) => g.inkL)) : 0,
      inkRight: inked.length ? Math.max(...inked.map((g) => g.inkR)) : 0,
      inkTop: inked.length ? Math.max(...inked.map((g) => g.inkT)) : 0,
      inkBottom: inked.length ? Math.min(...inked.map((g) => g.inkB)) : 0,
      glyphs,
    };
  },
};
