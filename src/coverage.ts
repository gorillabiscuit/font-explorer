// What a font will actually set of the name, and what it cannot. Wordmark sets every run through
// effectiveText, so a caps-only face is shown in capitals on every card, in the lightbox and in
// Compare alike. Letters the face lacks are not handled here: the measurer reports them missing and
// the layout draws a hatched box in their place. The card badge (card/CoverageBadge.tsx) names them.
import { NO_GLYPH, probeCase, probeCovers } from "./facts/canvas";
import type { FontFacts } from "./facts/types";
import { fontStyle } from "./fonts";
import { parseName, type Settings } from "./settings";
import type { FontEntry } from "./types";

export interface EffectiveText {
  lines: string[];
  flat: string;
  /** The face has no lowercase, so a name with lowercase is shown in capitals (and badged). */
  shownInCaps: boolean;
}

/** What a face can set: from its facts, or for an installed font (no file to read) from the browser. */
export interface Coverage {
  /** True when the face has a glyph for every character of `ch`. */
  covers(ch: string): boolean;
  /** Its lowercase letters are capitals, or it has (almost) none. */
  capsOnly: boolean;
}

/**
 * Caps-only: the lowercase slots hold copies of the capitals (most caps-only display faces do
 * this), or the face has fewer than half of a-z. A face missing a letter or two of an otherwise
 * full lowercase is not caps-only; its gaps show as missing letters instead.
 */
export function isCapsOnly(facts: FontFacts): boolean {
  if (facts.lowerIsCaps) return true;
  if (facts.hasLower) return false;
  let lower = 0;
  for (let cp = 0x61; cp <= 0x7a; cp++) if (facts.covers(String.fromCharCode(cp))) lower++;
  return lower < 13;
}

/**
 * The face's coverage, or null while it is unknown (a remote face whose facts are not parsed yet).
 * Installed fonts are probed with the canvas (facts/canvas.ts probeCovers), at `weight` and in the
 * face's style, so with Italic on an installed italic is judged by its own letters.
 */
export function coverageOf(font: FontEntry, facts: FontFacts | null, weight = 400): Coverage | null {
  if (facts) return { covers: (ch) => facts.covers(ch), capsOnly: isCapsOnly(facts) };
  if (font.source !== "local") return null;
  const style = fontStyle(font);
  const { lowerCount, lowerIsCaps } = probeCase(font.family, weight, style);
  return {
    covers: (ch) => [...ch].every((c) => probeCovers(font.family, weight, c, style)),
    capsOnly: lowerIsCaps || lowerCount < 13,
  };
}

/**
 * The name as this face shows it: parseName, except that a caps-only face sets a name with
 * lowercase in capitals (flagged shownInCaps), so it reads as the face was drawn instead of as a
 * row of missing letters. The name is then all capitals, so Match Auto sizes it by cap height.
 */
export function effectiveText(font: FontEntry, facts: FontFacts | null, settings: Pick<Settings, "text" | "textCase">): EffectiveText {
  const name = parseName(settings);
  if (!/\p{Ll}/u.test(name.flat) || !coverageOf(font, facts)?.capsOnly) return { ...name, shownInCaps: false };
  return { lines: name.lines.map((l) => l.toUpperCase()), flat: name.flat.toUpperCase(), shownInCaps: true };
}

/**
 * The distinct characters of `text` the face cannot set, in order of first use. Spaces are never
 * missing, and an accent typed separately counts as the accented letter the browser composes.
 */
export function missingChars(coverage: Pick<Coverage, "covers">, text: string): string[] {
  const out: string[] = [];
  for (const ch of text.normalize("NFC")) {
    if (NO_GLYPH.test(ch) || out.includes(ch)) continue;
    if (!coverage.covers(ch)) out.push(ch);
  }
  return out;
}

/**
 * Licences that allow a logo without asking: the libre font licences of the catalogue (OFL, Apache,
 * UFL), Fontshare's free licence (ITF FFL), and the permissive or public-domain ones some indie
 * fonts use. CC BY is left out because it asks for credit. Everything else, installed fonts of
 * unknown origin included, needs its terms read first.
 */
export const LOGO_SAFE_LICENCES = [
  "OFL",
  "Apache",
  "UFL",
  "ITF free",
  "MIT",
  "Bitstream Vera",
  "GPL + font exception",
  "WTFPL",
  "Unlicense",
  "Public Domain",
  "CC0",
  "CC0-1.0",
];
const SAFE = new Set(LOGO_SAFE_LICENCES.map((l) => l.toLowerCase()));

export function isLogoSafe(font: FontEntry): boolean {
  return SAFE.has(font.license.toLowerCase());
}
