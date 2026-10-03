// Which families come with a real italic, from the catalogue alone. Pure (no DOM, no React), so
// recipe.ts and the Node check scripts can use it too. fonts.ts draws an italic as a face of its
// own (italicFace); this file only says what the catalogue lists.
import type { FontEntry } from "./types";

/**
 * The weights the family has a real italic in, lightest first: Fontsource lists them, the other
 * sources list a file per weight, and so does an italic borrowed from another source's row (the
 * catalogue's italicFrom), whichever row it sits on. None for installed fonts, whose italics nobody
 * can know.
 */
export function italicWeightsOf(f: FontEntry): number[] {
  if (f.source === "local") return [];
  const listed = f.italicWeights?.length ? f.italicWeights : Object.keys(f.italicFiles ?? {}).map(Number);
  return [...new Set(listed)].filter(Number.isFinite).sort((a, b) => a - b);
}

/** The catalogue lists a real italic for the family. */
export function hasItalic(f: FontEntry): boolean {
  return italicWeightsOf(f).length > 0;
}
