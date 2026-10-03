// Shared helpers for the source builders in this folder. Each builder reads one foundry's catalog
// and returns FontEntry rows; `npm run sources` writes them to server/data/<source>.json.
import * as fontkit from "fontkit";
import type { Category, FontEntry } from "../../src/types.ts";

export type { Category, FontEntry };

export interface SourceBuilder {
  /** Rows for the catalog. Upright styles only in `files`; set `proxy: true` on every row. */
  build(log: (msg: string) => void): Promise<FontEntry[]>;
}

const UA = "font-explorer/0.1 (personal local font browser; fetches each catalog rarely)";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchOk(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

export const fetchText = async (url: string, init?: RequestInit) => (await fetchOk(url, init)).text();
export const fetchJson = async <T>(url: string, init?: RequestInit) => (await fetchOk(url, init)).json() as Promise<T>;
export const fetchBuffer = async (url: string, init?: RequestInit) => Buffer.from(await (await fetchOk(url, init)).arrayBuffer());

export interface FontFileInfo {
  family: string;
  subfamily: string;
  /** usWeightClass from the OS/2 table, 100-900. */
  weight: number;
  italic: boolean;
  variable: boolean;
}

/** Reads names and weight from a woff2/woff/ttf/otf file. */
export function readFontInfo(buffer: Buffer): FontFileInfo {
  const font = fontkit.create(buffer) as fontkit.Font;
  const os2 = (font as unknown as { "OS/2"?: { usWeightClass?: number; fsSelection?: { italic?: boolean } } })["OS/2"];
  const subfamily = font.subfamilyName ?? "";
  return {
    family: font.familyName ?? "",
    subfamily,
    weight: clampWeight(os2?.usWeightClass ?? weightFromStyleName(subfamily)),
    italic: Boolean(os2?.fsSelection?.italic) || /italic|oblique/i.test(subfamily),
    variable: Object.keys((font as unknown as { variationAxes?: object }).variationAxes ?? {}).length > 0,
  };
}

function clampWeight(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 400;
  // Some fonts store 1-9 instead of 100-900.
  if (w < 10) w *= 100;
  return Math.min(900, Math.max(100, Math.round(w / 100) * 100));
}

/** Guesses a weight from a style or file name: "ExtraLight" → 200, "Fett" → 700. Defaults to 400. */
export function weightFromStyleName(name: string): number {
  const s = name.toLowerCase().replace(/[\s_-]/g, "");
  const table: [RegExp, number][] = [
    [/thin|hairline|extrafin/, 100],
    [/extralight|ultralight/, 200],
    [/light|fin\b/, 300],
    [/semibold|demibold|demi/, 600],
    [/medium|mittel/, 500],
    [/extrabold|ultrabold/, 800],
    [/black|heavy|satt|dark/, 900],
    [/bold|fett/, 700],
  ];
  return table.find(([re]) => re.test(s))?.[1] ?? 400;
}

/** Maps free-form tags to the app's categories. Expressive tags win, since they matter most for wordmarks. */
export function categoryFromTags(tags: string[], fallback: Category = "display"): Category {
  const t = tags.map((x) => x.toLowerCase());
  const has = (re: RegExp) => t.some((x) => re.test(x));
  // Whole words only: "monolinear" and "monoline" describe stroke, not spacing.
  if (has(/^(mono|monospaced?|code|coding|programming)$/) || has(/\bmonospaced?\b/)) return "mono";
  if (has(/script|handwrit|brush|calligraph/)) return "handwriting";
  if (has(/fantasy|brutalist|pixel|wonky|damage|generative|graphic|blackletter|curveless|inktrap|reverse.?contrast|display|decorative/)) return "display";
  if (has(/^serif|slab|garalde|didone|old.?style/)) return "serif";
  if (has(/sans|grotesk|grotesque|geometric|humanist/)) return "sans";
  return fallback;
}
