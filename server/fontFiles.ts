import type { FontEntry } from "../src/types.ts";
import { NO_LATIN_FILE } from "./catalog.ts";
import { getFile, sniff, UA } from "./fontProxy.ts";

// One upright file per family, for scripts that draw or measure a family outside the browser (the
// specimen sheets in build-vision.ts). Google and Fontshare files are fetched into memory and not
// kept: there are thousands, and the disk is tight. The indie sources' files go through the font
// proxy's cache, which already holds most of them.

/** Nearest to Regular first; on a tie the heavier weight wins (500 before 300), as it reads less faint. */
function byNearness(a: number, b: number): number {
  return Math.abs(a - 400) - Math.abs(b - 400) || b - a;
}

/**
 * The family's upright files, nearest weight 400 first, or none when it has none we can fetch (a local
 * font, or a Google family Fontsource serves no latin file for).
 */
export function uprightFiles(f: FontEntry): { url: string; weight: number }[] {
  if (f.source === "local") return [];
  if (f.source === "fontsource") {
    if (!f.ref || NO_LATIN_FILE.has(f.family)) return [];
    return [...f.weights]
      .sort(byNearness)
      .map((weight) => ({ url: `https://cdn.jsdelivr.net/fontsource/fonts/${f.ref}@latest/latin-${weight}-normal.woff2`, weight }));
  }
  return Object.keys(f.files ?? {})
    .map(Number)
    .sort(byNearness)
    .map((weight) => ({ url: f.files![weight], weight }));
}

/** The family's upright file nearest weight 400, or null when it has none we can fetch. */
export function regularFile(f: FontEntry): { url: string; weight: number } | null {
  return uprightFiles(f)[0] ?? null;
}

/**
 * The bytes of the family's upright file nearest 400 that loads. A file that is missing or is not a
 * font is passed over for the next weight: Fontsource's Open Sauce Sans 400 is a Type 1 file under a
 * .woff2 name, and its 500 is fine. Throws the first error when none loads.
 */
export async function loadRegularFont(f: FontEntry): Promise<{ bytes: Buffer; url: string; weight: number }> {
  let first: unknown = null;
  for (const file of uprightFiles(f).slice(0, 3)) {
    try {
      return { ...file, bytes: await loadFontBytes(f, file.url) };
    } catch (err) {
      first ??= err;
    }
  }
  throw first ?? new Error("no upright file to fetch");
}

/** The bytes of one of the family's files. Throws when the host fails or the reply is not a font. */
export async function loadFontBytes(f: FontEntry, url: string): Promise<Buffer> {
  if (f.files && f.proxy) {
    const body = await getFile(new URL(url));
    if (!sniff(body)) throw new Error(`not a font file: ${url}`);
    return body;
  }
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!sniff(body)) throw new Error(`not a font file: ${url}`);
  return body;
}
