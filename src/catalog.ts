import { BASE, STATIC } from "./env";
import { isExcludedFamily } from "./exclude";
import type { Category, FontEntry } from "./types";

// The browser keeps a copy of the server's catalog so the page fills instantly, then checks the
// server's version in the background and swaps in the new list when it changed (new sources, refetch).
// The online build has no server: the same list sits beside the page as catalog.json, written by
// server/export-static.ts, with every file the browser could not load from its host pointing at a
// copy the site hosts itself. It is kept and checked the same way.
const CATALOG_KEY = "fx:catalog:v3";
const LOCAL_KEY = "fx:local-fonts:v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const OLD_CATALOG_KEYS = ["fx:catalog:v1", "fx:catalog:v2"];

interface CatalogResponse {
  version: string;
  fonts: FontEntry[];
}

function readCached(): CatalogResponse | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? "null") as (CatalogResponse & { at: number }) | null;
    return cached && Date.now() - cached.at < TTL_MS && cached.fonts.length ? cached : null;
  } catch {
    return null;
  }
}

function writeCached(catalog: CatalogResponse) {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ ...catalog, at: Date.now() }));
  } catch {
    // storage full: carry on uncached
  }
}

async function fetchCatalog(force: boolean): Promise<CatalogResponse> {
  if (STATIC) return fetchStaticCatalog();
  const res = await fetch(`/api/catalog${force ? "?refresh=1" : ""}`);
  if (!res.ok) throw new Error(`Catalog request failed (${res.status}). Is the server running?`);
  const { version, fonts } = (await res.json()) as CatalogResponse;
  return { version, fonts };
}

/**
 * The online build's catalog.json. Always checked with the site ('no-cache'), so a new build shows on
 * the next visit; an unchanged file costs a short 'not modified'. A missing file comes back as the
 * site's home page, so anything but the catalogue's shape counts as a failure.
 */
async function fetchStaticCatalog(): Promise<CatalogResponse> {
  const res = await fetch(`${BASE}catalog.json`, { cache: "no-cache" });
  const data = res.ok ? ((await res.json().catch(() => null)) as Partial<CatalogResponse> | null) : null;
  if (!data || typeof data.version !== "string" || !Array.isArray(data.fonts)) throw new Error(`Could not load the font list (${res.status}).`);
  return { version: data.version, fonts: data.fonts };
}

/** The catalogue as loadRemoteCatalog last saw it, or freshly fetched. For the dev console helper. */
export async function catalogFonts(): Promise<FontEntry[]> {
  return readCached()?.fonts ?? (await fetchCatalog(false)).fonts;
}

/**
 * Calls `onFonts` with the saved copy right away (if there is one), then again with the server's
 * list if its version differs. Rejects only when there is neither a saved copy nor a server.
 */
export async function loadRemoteCatalog(force: boolean, onFonts: (fonts: FontEntry[]) => void): Promise<void> {
  OLD_CATALOG_KEYS.forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage blocked: nothing to clean
    }
  });
  const cached = force ? null : readCached();
  if (cached) onFonts(cached.fonts);
  try {
    const fresh = await fetchCatalog(force);
    if (!cached || fresh.version !== cached.version || fresh.fonts.length !== cached.fonts.length) onFonts(fresh.fonts);
    writeCached(fresh);
  } catch (err) {
    if (!cached) throw err;
  }
}

export function cachedLocalFonts(): FontEntry[] {
  try {
    return (JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]") as FontEntry[])
      .filter((f) => !isExcludedFamily(f.family))
      .map(({ rank: _placeholder, ...f }) => f); // older saves carried a made-up rank of 6000
  } catch {
    return [];
  }
}

interface LocalFontData {
  family: string;
  style: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

export const localFontsSupported = typeof window !== "undefined" && "queryLocalFonts" in window;

/** Must run from a click: Chrome shows a permission prompt the first time. */
export async function queryLocalFonts(remote: FontEntry[]): Promise<FontEntry[]> {
  if (!window.queryLocalFonts) throw new Error("This browser cannot list local fonts. Use Chrome or another Chromium browser.");
  const faces = await window.queryLocalFonts();
  const families = new Map<string, Set<number>>();
  for (const face of faces) {
    if (face.family.startsWith(".") || isExcludedFamily(face.family)) continue; // "." = hidden macOS system faces
    const weights = families.get(face.family) ?? new Set<number>();
    weights.add(styleToWeight(face.style));
    families.set(face.family, weights);
  }
  const known = new Map(remote.map((f) => [f.family.toLowerCase(), f]));
  const fonts: FontEntry[] = [...families].map(([family, weights]) => {
    const match = known.get(family.toLowerCase());
    return {
      id: `local:${family}`,
      family,
      source: "local",
      category: match?.category ?? guessCategory(family),
      tags: match?.tags ?? [],
      weights: [...weights].sort((a, b) => a - b),
      license: "Local-unknown",
    };
  });
  fonts.sort((a, b) => a.family.localeCompare(b.family));
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(fonts));
  } catch {
    // fine, they just will not survive a reload
  }
  return fonts;
}

function styleToWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s-_]/g, "");
  const table: [RegExp, number][] = [
    [/thin|hairline/, 100],
    [/extralight|ultralight/, 200],
    [/light/, 300],
    [/medium/, 500],
    [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800],
    [/black|heavy/, 900],
    [/bold/, 700],
  ];
  return table.find(([re]) => re.test(s))?.[1] ?? 400;
}

function guessCategory(family: string): Category {
  const f = family.toLowerCase();
  if (/mono|code|courier|consol|menlo/.test(f)) return "mono";
  if (/script|hand|brush|marker|chalk|noteworthy|zapfino|snell/.test(f)) return "handwriting";
  if (/sans|grotesk|grotesque|gothic|helvetica|arial|avenir|futura|gill|verdana|tahoma|geneva|frutiger|univers|din/.test(f)) return "sans";
  if (/serif|times|georgia|garamond|baskerville|bodoni|didot|caslon|palatino|cochin|hoefler|charter|book|roman/.test(f)) return "serif";
  return "other";
}
