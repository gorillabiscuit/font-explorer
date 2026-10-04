// Type-only, so the server can import this file without pulling in the browser modules.
import type { Formation } from "./recipe";
import type { TextCase } from "./settings";

export type Source = "local" | "fontsource" | "fontshare" | "velvetyne" | "collletttivo" | "tunera" | "usemodify";
export type Category = "sans" | "serif" | "display" | "mono" | "handwriting" | "other";

export const SOURCES: Source[] = ["local", "fontsource", "fontshare", "velvetyne", "collletttivo", "tunera", "usemodify"];
export const SOURCE_LABELS: Record<Source, string> = {
  local: "Local",
  fontsource: "Google",
  fontshare: "Fontshare",
  velvetyne: "Velvetyne",
  collletttivo: "Collletttivo",
  tunera: "Tunera",
  usemodify: "Use & Modify",
};

/** Independent foundries and curated libre lists: the distinctive end of the catalog. */
export const INDIE_SOURCES: Source[] = ["velvetyne", "collletttivo", "tunera", "usemodify", "fontshare"];
export const CATEGORIES: Category[] = ["sans", "serif", "display", "mono", "handwriting", "other"];

export interface FontEntry {
  /** Unique across sources, e.g. "fontsource:inter", "fontshare:satoshi", "local:Helvetica Neue". */
  id: string;
  family: string;
  source: Source;
  category: Category;
  tags: string[];
  /** How strongly each of Google's mood and theme tags applies, out of 100 ("Active": 89). Google rows only. */
  tagScores?: Record<string, number>;
  weights: number[];
  license: string;
  /** Stylesheet a site would use to load this font. Local fonts have none. */
  cssUrl?: string;
  /** woff2 URL per upright weight. Fontsource URLs are built from `ref` instead. */
  files?: Record<number, string>;
  /** Weights that also come as a real italic (Fontsource, whose URLs are built from `ref`). */
  italicWeights?: number[];
  /** woff2 URL per italic weight, for sources that list files (Fontshare and the indie sources). */
  italicFiles?: Record<number, string>;
  /**
   * The italic files come from another source's row for the same family (the kept row had none),
   * so they follow that source's loading rule: true when they go through the font proxy.
   */
  italicProxy?: boolean;
  /** The source the italic was borrowed from, when it was (see italicProxy). */
  italicFrom?: Source;
  /**
   * Online build only: the original URL of each file the build hosts itself, keyed by the copy's
   * path. Labels and exports name the original.
   */
  upstream?: Record<string, string>;
  /** Fontsource package id. */
  ref?: string;
  /** Lower is more popular (Google Fonts' ranking). Unknown for the indie sources. */
  rank?: number;
  /** When the family was published or added to its source, as an ISO date, if known. */
  added?: string;
  /** Where a person can see or download the family (foundry page or repository). */
  homepage?: string;
  /** Load files through the local server, which fetches each file once and keeps a copy. */
  proxy?: boolean;
  /** Among the most-used Google Fonts (popularity rank 150 or better). Vibe search steers away from these. */
  common?: boolean;
  /** Other sources that also carry this family; their duplicate rows were merged into this one. */
  alsoOn?: Source[];
}

export interface VibeResult {
  family: string;
  reason: string;
}

export interface VibeTurn {
  id: string;
  /** The turn that was on screen when this one was asked; follow-ups walk back along these. */
  parentId?: string | null;
  query: string;
  results: (VibeResult & { fontId: string })[];
  at: number;
  /** Finished in the background and not looked at yet: its chip shows a dot until it is opened. */
  unread?: boolean;
}

/** The name Claude is choosing type for, as the grid draws it. */
export interface VibeWordmark {
  /** The name on one line, case applied ('UNIQLO'). */
  text: string;
  /** The lines as drawn, one per '\n' ('UNI\nQLO'); for Mark, the initials. */
  rendered: string;
  textCase: TextCase;
  formation: Formation;
  /** Lockup only: the descriptor line as drawn. */
  descriptor?: string;
}

export interface VibeRequest {
  query: string;
  /** Earlier turns, oldest first, so follow-ups like "more like #3" resolve. */
  history: { query: string; results: VibeResult[] }[];
  shortlist: string[];
  culled: string[];
  localFonts: { family: string; category: Category }[];
  constraints: { sources: Source[]; categories: Category[] };
  wordmark: VibeWordmark;
  /** The project's one-line brief: what it is, for whom, words to avoid. */
  brief?: string;
  /** The Italic switch: `on` draws each family's real italic; `only` is the 'Has italic' filter, which counts only while on. */
  italic?: { on: boolean; only: boolean };
}

export interface VibeResponse {
  results: VibeResult[];
  dropped: string[];
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** The models Claude Code used, the one that answered first (the fallback model, when the main one was unavailable). */
  models?: string[];
}
