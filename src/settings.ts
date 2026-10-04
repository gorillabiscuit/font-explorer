import { DEFAULT_LAYOUT, type LayoutSettings } from "./recipe";
import type { Category, FontEntry, Source } from "./types";
import { CATEGORIES, INDIE_SOURCES, SOURCES } from "./types";

export type TextCase = "as" | "upper" | "lower";

/** Grid-wide stress tests: V cycles them in this order. */
export type StressMode = "off" | "squint" | "small" | "reversed" | "pixel";
export const STRESS_MODES: StressMode[] = ["off", "squint", "small", "reversed", "pixel"];

export interface Settings {
  /** The name. '/' breaks the line ('\/' is a literal slash); '|' is reserved and stripped. See parseName. */
  text: string;
  size: number;
  weight: number;
  textCase: TextCase;
  /** Letter-spacing in em. */
  tracking: number;
  /** Draw each family's real italic; a family without one stays upright and says so. */
  italic: boolean;
  invert: boolean;
  /** Names in vermilion seal paste on warm paper, drawn through a worn print (Seal.tsx). Overrides invert while on. */
  seal: boolean;
  layout: LayoutSettings;
  stress: StressMode;
}

export const DEFAULT_SETTINGS: Settings = {
  text: "Wordmark",
  size: 56,
  weight: 400,
  textCase: "as",
  tracking: 0,
  italic: false,
  invert: false,
  seal: false,
  layout: DEFAULT_LAYOUT,
  stress: "off",
};

export type SortMode = "indie" | "shuffle" | "newest" | "least" | "popular" | "az";

export const SORT_LABELS: Record<SortMode, string> = {
  indie: "Indie first",
  shuffle: "Shuffle",
  newest: "Newest",
  least: "Least popular",
  popular: "Most popular",
  az: "A–Z",
};

export interface Filters {
  sources: Source[];
  categories: Category[];
  /** Only fonts with at least one saved candidate. */
  candidatesOnly: boolean;
  /** Only fonts marked maybe or with a candidate. */
  maybeOrBetter: boolean;
  showCulled: boolean;
  /** Only fonts whose licence allows a logo without asking (coverage.ts isLogoSafe). */
  logoSafe: boolean;
  /** Only families with a real italic (italic.ts hasItalic). Applies only while Italic is on, as its chip shows only then. */
  hasItalic: boolean;
  /** Order of the "All fonts" grid. Vibe results keep Claude's order. */
  sort: SortMode;
  /** Changes on "reshuffle"; the shuffle is stable for a given seed so culling does not reorder the grid. */
  seed: number;
}

export const DEFAULT_FILTERS: Filters = {
  sources: [...SOURCES],
  categories: [...CATEGORIES],
  candidatesOnly: false,
  maybeOrBetter: false,
  showCulled: false,
  logoSafe: false,
  hasItalic: false,
  sort: "indie",
  seed: 1,
};

/**
 * The name as typed, cased, and split into lines. '/' starts a new line and '\/' is a literal slash.
 * '|' is reserved for two-weight segments later and is dropped for now, so typing it early is harmless.
 * Lines are trimmed; `flat` is the name with the breaks taken out but its spaces kept, so
 * 'UNI/QLO' is 'UNIQLO' on one line and 'Acme /Studio' is 'Acme Studio'.
 */
export function parseName(s: Pick<Settings, "text" | "textCase">): { lines: string[]; flat: string } {
  const cased = s.textCase === "upper" ? s.text.toUpperCase() : s.textCase === "lower" ? s.text.toLowerCase() : s.text;
  const parts = [""];
  for (let i = 0; i < cased.length; i++) {
    const ch = cased[i];
    if (ch === "\\" && cased[i + 1] === "/") {
      parts[parts.length - 1] += "/";
      i++;
    } else if (ch === "/") parts.push("");
    else if (ch !== "|") parts[parts.length - 1] += ch;
  }
  // A space either side of a break becomes one space: 'UNI / QLO' reads 'UNI QLO', not 'UNI  QLO'.
  const flat = parts
    .reduce((acc, p) => (/\s$/.test(acc) || /^\s/.test(p) ? `${acc.trimEnd()} ${p.trimStart()}` : acc + p))
    .trim();
  const lines = parts.map((p) => p.trim()).filter(Boolean);
  return { lines: lines.length ? lines : [flat], flat };
}

/** The name on one line. Never empty, so an empty input still leaves the card its height. */
export function displayText(s: Pick<Settings, "text" | "textCase">): string {
  return parseName(s).flat || " ";
}

/** A stable pseudo-random number per font for a given seed (FNV-1a). */
function shuffleKey(id: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const FOUNDRIES: Source[] = ["velvetyne", "collletttivo", "tunera"];
/** Use & Modify's own keywords for characterful type (about half its list is plain workhorse type). */
const EXPRESSIVE = /wonky|damage|pixel|graphic|generative|curveless|blackletter|organic|ink-?traps?|reverse-contrast|paleographic|glyphic|bitmap|gaelic|brutalist|fantasy|stencil|experimental|hard-to-read/;

/**
 * "Indie first" bands, each shuffled: 0 = the foundries plus Use & Modify's characterful fonts,
 * 1 = Fontshare and the rest of Use & Modify, 2 = Google and installed fonts.
 */
function indieBand(f: FontEntry): number {
  if (FOUNDRIES.includes(f.source)) return 0;
  if (f.source === "usemodify") {
    const characterful = f.category === "display" || f.category === "handwriting" || f.tags.some((t) => EXPRESSIVE.test(t.toLowerCase()));
    return characterful ? 0 : 1;
  }
  return INDIE_SOURCES.includes(f.source) ? 1 : 2;
}

/** Sorts a copy of the list. Fonts missing the sort's data (no date, no popularity) go last. */
export function sortFonts(fonts: FontEntry[], mode: SortMode, seed: number): FontEntry[] {
  const shuffled = (a: FontEntry, b: FontEntry) => shuffleKey(a.id, seed) - shuffleKey(b.id, seed);
  const compare: Record<SortMode, (a: FontEntry, b: FontEntry) => number> = {
    indie: (a, b) => indieBand(a) - indieBand(b) || shuffled(a, b),
    shuffle: shuffled,
    newest: (a, b) => (b.added ?? "").localeCompare(a.added ?? "") || a.family.localeCompare(b.family),
    least: (a, b) => (b.rank ?? -1) - (a.rank ?? -1) || a.family.localeCompare(b.family),
    popular: (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.family.localeCompare(b.family),
    az: (a, b) => a.family.localeCompare(b.family),
  };
  return [...fonts].sort(compare[mode]);
}
