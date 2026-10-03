// Online check of the two hand-made italic lists in catalog.ts, NOT_ITALIC and NO_LATIN_FILE, so they
// can be refreshed instead of going stale. Run: npm run check:italics. It downloads a few hundred font
// files from jsDelivr (a minute or two) and never runs as part of the offline checks.
//
// Google families take their italic weights from Google's own metadata. The other Fontsource families
// take Fontsource's list, which nothing vouches for, so each italic it lists is downloaded with its
// upright and judged:
//   missing       the italic file is not there (404)
//   upright copy  the italic file is the upright file byte for byte (Redaction 700)
//   unreadable    fontkit cannot parse it, and browsers refuse it too (Open Sauce Sans' Type 1 files)
// Each NO_LATIN_FILE family is checked to still have no latin file in either style. The script prints
// the lists as they should be and exits 1 when catalog.ts differs.
//
// Borrowed italics: a merged row with no italic of its own takes one from a dropped duplicate in
// another source (catalog.ts mergeSources; Sora's comes from Fontshare). First, offline, every borrowing
// row must keep its own fields exactly as its source listed them, and a row with an italic of its own
// must not borrow. Then each borrowed file is judged as above, and its cap height and x-height are
// compared with the row's upright at the same weight: an italic from another release of the design can
// be drawn at another size, which the Italic switch would show as a jump. A difference over 3% is
// reported for a person to look at; it does not fail the check.
import { createHash } from "node:crypto";
import * as fontkit from "fontkit";
import { isExcludedFamily } from "../src/exclude.ts";
import type { FontEntry } from "../src/types.ts";
import { getSourceLists, mergeSources, NO_LATIN_FILE, NOT_ITALIC } from "./catalog.ts";
import { allowed, FontFetchError, getFile } from "./fontProxy.ts";

const FONTSOURCE_URL = "https://api.fontsource.org/v1/fonts";
const CDN = "https://cdn.jsdelivr.net/fontsource/fonts";
/** Downloads at once: a CDN, but no reason to hurry it. */
const PARALLEL = 6;

interface FontsourceFont {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  styles: string[];
  category: string;
  type: string;
}

type Verdict = "missing" | "upright copy" | "unreadable";

const fileUrl = (id: string, weight: number, style: "normal" | "italic") => `${CDN}/${id}@latest/latin-${weight}-${style}.woff2`;

async function download(url: string): Promise<Buffer | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // A failed download says nothing about the file, so it is retried, then reported as a failure.
      if (attempt === 2) throw new Error(`${url}: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function parses(b: Buffer): boolean {
  try {
    const font = fontkit.create(b);
    return "fonts" in font ? font.fonts.length > 0 : font.numGlyphs > 0;
  } catch {
    return false;
  }
}

async function judge(f: FontsourceFont, weight: number): Promise<Verdict | null> {
  const italic = await download(fileUrl(f.id, weight, "italic"));
  if (!italic) return "missing";
  const upright = await download(fileUrl(f.id, weight, "normal"));
  if (upright && sha(upright) === sha(italic)) return "upright copy";
  return parses(italic) ? null : "unreadable";
}

async function pool<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

// --- borrowed italics, offline ---

/** Fields the merge itself may change on the surviving row: everything else is the source's own. */
const MERGED_FIELDS = new Set(["tags", "alsoOn", "rank", "common", "added"]);
const BORROWED_FIELDS = new Set(["italicFiles", "italicProxy", "italicFrom"]);
/** A height difference worth a person's look: 3% of the upright's. */
const HEIGHT_TOLERANCE = 0.03;

/** The row's fields, less `skip`, in a fixed order, for comparing two rows. */
const fieldsOf = (f: FontEntry, skip: Set<string>) =>
  JSON.stringify(
    Object.entries(f)
      .filter(([k, v]) => !skip.has(k) && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const lists = await getSourceLists();
const merged = mergeSources(lists);
const ownRows = new Map(lists.flat().map((f) => [f.id, f]));
let borrowProblems = 0;
const borrowProblem = (msg: string) => {
  borrowProblems++;
  console.log(`BORROWED: ${msg}`);
};
for (const row of merged) {
  const own = ownRows.get(row.id);
  if (!own) {
    borrowProblem(`${row.family}: no source row has the id ${row.id}`);
    continue;
  }
  if (fieldsOf(row, new Set([...MERGED_FIELDS, ...BORROWED_FIELDS])) !== fieldsOf(own, new Set([...MERGED_FIELDS, ...BORROWED_FIELDS]))) {
    borrowProblem(`${row.family} (${row.id}): fields of its own changed in the merge`);
  }
  if (!row.italicFrom) {
    if (fieldsOf(row, MERGED_FIELDS) !== fieldsOf(own, MERGED_FIELDS)) borrowProblem(`${row.family} (${row.id}): its italic changed without being borrowed`);
    continue;
  }
  if (own.italicWeights?.length || Object.keys(own.italicFiles ?? {}).length) borrowProblem(`${row.family} borrowed an italic but has its own`);
  if (!Object.keys(row.italicFiles ?? {}).length || typeof row.italicProxy !== "boolean") {
    borrowProblem(`${row.family}: a borrowed italic needs files and an explicit italicProxy`);
  }
}
const borrowed = merged.filter((f) => f.italicFrom);
console.log(
  `Borrowed italics: ${borrowed.map((f) => `${f.family} (${f.source}, italic from ${f.italicFrom})`).join(", ") || "none"}. ` +
    (borrowProblems ? `${borrowProblems} problem(s) above.` : "Every merged row keeps its own fields."),
);

// --- the Fontsource lists, online ---

const res = await fetch(FONTSOURCE_URL, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) {
  console.error(`Could not fetch ${FONTSOURCE_URL}: HTTP ${res.status}`);
  process.exit(2);
}
const all = (await res.json()) as FontsourceFont[];
// The rows catalog.ts would list with Fontsource's own italic weights, plus every family the lists name.
const named = new Set([...Object.keys(NOT_ITALIC), ...NO_LATIN_FILE]);
const listed = all.filter(
  (f) =>
    f.category !== "icons" &&
    f.subsets.includes("latin") &&
    f.styles.includes("normal") &&
    f.styles.includes("italic") &&
    !isExcludedFamily(f.family) &&
    (f.type !== "google" || named.has(f.family)) &&
    !NO_LATIN_FILE.has(f.family),
);
const jobs = listed.flatMap((f) => f.weights.map((w) => async () => ({ family: f.family, weight: w, verdict: await judge(f, w) })));
console.log(`Checking ${jobs.length} italic files of ${listed.length} Fontsource families that list their own italic weights…`);
const started = Date.now();
let failed = 0;
const results = await pool(
  jobs.map((job) => () =>
    job().catch((err) => {
      failed++;
      console.warn(`  could not check: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
  ),
);

const shouldBe: Record<string, number[]> = {};
for (const r of results) {
  if (!r?.verdict) continue;
  (shouldBe[r.family] ??= []).push(r.weight);
  console.log(`  ${r.family} ${r.weight}: ${r.verdict}`);
}

let differs = 0;
const families = [...new Set([...Object.keys(NOT_ITALIC), ...Object.keys(shouldBe)])].sort();
for (const family of families) {
  const now = [...(NOT_ITALIC[family] ?? [])].sort((a, b) => a - b);
  const want = [...(shouldBe[family] ?? [])].sort((a, b) => a - b);
  if (now.join() === want.join()) continue;
  differs++;
  console.log(`NOT_ITALIC["${family}"] is [${now.join(", ")}], should be [${want.join(", ")}]`);
}

const fontsource = new Map(all.map((f) => [f.family, f]));
for (const family of NO_LATIN_FILE) {
  const f = fontsource.get(family);
  if (!f) {
    differs++;
    console.log(`NO_LATIN_FILE: ${family} is no longer on Fontsource; take it off the list.`);
    continue;
  }
  const w = f.weights.includes(400) ? 400 : f.weights[0];
  const [upright, italic] = await Promise.all([download(fileUrl(f.id, w, "normal")), download(fileUrl(f.id, w, "italic"))]);
  if (upright || italic) {
    differs++;
    console.log(`NO_LATIN_FILE: ${family} now has a latin file at ${w} (${upright ? "upright" : ""}${upright && italic ? " and " : ""}${italic ? "italic" : ""}); take it off the list.`);
  }
}

// --- borrowed italics, online ---

/** The CDNs the browser loads from directly (Fontsource's and Fontshare's); every other host goes through the proxy. */
const DIRECT_HOSTS = new Set(["cdn.jsdelivr.net", "cdn.fontshare.com"]);

/** A file this check does not download, because the app would not load it from that host either. */
class HostRefused extends Error {}

/**
 * A file the way the app loads it: through the font proxy's cache when the row says so (fetched once
 * and kept, as the local app does), straight from the CDN otherwise. Null when it is not there. Only
 * from the hosts the app itself would use, so a future borrow can never send this check elsewhere.
 */
async function bytesOf(url: string, viaProxy: boolean): Promise<Buffer | null> {
  const u = new URL(url);
  if (viaProxy ? !allowed(u) : u.protocol !== "https:" || !DIRECT_HOSTS.has(u.hostname)) {
    throw new HostRefused(`${url} is on ${u.hostname}, which ${viaProxy ? "the font proxy does not allow" : "the app does not load from directly"}; not downloaded`);
  }
  if (!viaProxy) return download(url);
  try {
    return await getFile(new URL(url));
  } catch (err) {
    if (err instanceof FontFetchError && err.permanent) return null;
    throw err;
  }
}

/** Top of H and of x, as a share of the em. */
function heights(b: Buffer): { cap: number; x: number } {
  const created = fontkit.create(b);
  const font = "fonts" in created ? created.fonts[0] : created;
  const top = (ch: string) => {
    const g = font.glyphForCodePoint(ch.codePointAt(0)!);
    return g.id ? g.bbox.maxY / font.unitsPerEm : NaN;
  };
  return { cap: top("H"), x: top("x") };
}

const pct = (a: number, b: number) => Math.abs(a - b) / b;
let heightNotes = 0;
for (const row of borrowed) {
  const uprightUrl = (w: number) => (row.source === "fontsource" && row.ref ? fileUrl(row.ref, w, "normal") : row.files?.[w]);
  let worst = { cap: 0, x: 0 };
  const off: string[] = [];
  for (const [weight, url] of Object.entries(row.italicFiles ?? {})) {
    const w = Number(weight);
    try {
      const italic = await bytesOf(url, row.italicProxy === true);
      if (!italic) {
        borrowProblem(`${row.family} ${w} italic (from ${row.italicFrom}) is missing: ${url}`);
        continue;
      }
      if (!parses(italic)) {
        borrowProblem(`${row.family} ${w} italic (from ${row.italicFrom}) is unreadable: ${url}`);
        continue;
      }
      const up = row.weights.includes(w) ? uprightUrl(w) : undefined;
      const upright = up ? await bytesOf(up, row.proxy === true) : null;
      if (!upright) continue;
      if (sha(upright) === sha(italic)) {
        borrowProblem(`${row.family} ${w} italic (from ${row.italicFrom}) is the upright file byte for byte`);
        continue;
      }
      const [u, i] = [heights(upright), heights(italic)];
      const d = { cap: pct(i.cap, u.cap), x: pct(i.x, u.x) };
      worst = { cap: Math.max(worst.cap, d.cap || 0), x: Math.max(worst.x, d.x || 0) };
      if (!(d.cap <= HEIGHT_TOLERANCE && d.x <= HEIGHT_TOLERANCE)) {
        off.push(`${w}: cap height ${u.cap.toFixed(3)} upright, ${i.cap.toFixed(3)} italic; x-height ${u.x.toFixed(3)} upright, ${i.x.toFixed(3)} italic (em units)`);
      }
    } catch (err) {
      if (err instanceof HostRefused) {
        borrowProblem(`${row.family} ${w}: ${err.message}`);
        continue;
      }
      failed++;
      console.warn(`  could not check: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (off.length) {
    heightNotes++;
    console.log(`HEIGHTS: ${row.family}'s italic (from ${row.italicFrom}) differs from its upright by more than ${HEIGHT_TOLERANCE * 100}%:`);
    for (const line of off) console.log(`  ${line}`);
  } else {
    console.log(`  ${row.family}: italic from ${row.italicFrom} within ${(worst.cap * 100).toFixed(1)}% (cap height) and ${(worst.x * 100).toFixed(1)}% (x-height) of its upright`);
  }
}

console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
if (heightNotes) console.log(`${heightNotes} borrowed italic(s) drawn at another size than their upright: worth a look in the app.`);
if (failed) {
  console.log(`${failed} file(s) could not be downloaded, so the lists were not fully checked. Run again.`);
  process.exit(2);
}
if (borrowProblems) {
  console.log(`${borrowProblems} problem(s) with borrowed italics (lines starting BORROWED): see mergeSources in server/catalog.ts.`);
}
if (differs) {
  console.log(`${differs} difference(s): update NOT_ITALIC / NO_LATIN_FILE in server/catalog.ts (and bump its cache file name), after drawing any doubtful file in a browser.`);
}
if (differs || borrowProblems) process.exit(1);
console.log("NOT_ITALIC and NO_LATIN_FILE match the CDN, and the borrowed italics are sound.");
