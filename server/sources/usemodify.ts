// Use & Modify (usemodify.com): Raphaël Bastide's curated list of libre fonts, about 190 families.
// There is no API. The homepage links every family as /fonts/<slug>/, and each family page carries the
// licence, keywords, the upstream link and an inline @font-face per face, pointing at woff/ttf copies
// hosted on usemodify.com itself (no woff2, no CORS, so the app's server proxies them). Uprights go in a
// row's `files`; slanted faces, read the same way, in `italicFiles` of their upright's row.
//
// Etiquette: at least 0.5 s between requests to usemodify.com, and every page and font file is cached
// under server/.cache/usemodify/ so reruns do not download anything again. USEMODIFY_REFRESH=1 refetches
// the HTML (font files stay cached; their URLs are content-stable). Nothing outside usemodify.com is ever
// requested: fetchOnHost refuses any other hostname, redirects included.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as fontkit from "fontkit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  categoryFromTags,
  readFontInfo,
  sleep,
  weightFromStyleName,
  type FontEntry,
  type SourceBuilder,
} from "./common.ts";

const SOURCE = "usemodify" as const;
const HOST = "usemodify.com";
const ORIGIN = `https://${HOST}`;
const UA = "font-explorer/0.1 (personal local font browser; fetches each catalog rarely)";
const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, "..", ".cache", "usemodify");
const REFRESH = process.env.USEMODIFY_REFRESH === "1";
/** The homepage is the list of families; refresh it weekly so new entries show up. */
const INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const GAP_MS = 600;

// ---------------------------------------------------------------------------------------------------
// Polite, cached fetching

let lastRequest = 0;
let requests = 0;

async function polite<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastRequest + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    requests++;
    return await fn();
  } finally {
    lastRequest = Date.now();
  }
}

export const onHost = (url: string) => {
  try {
    return new URL(url).hostname === HOST;
  } catch {
    return false;
  }
};

/** GET on usemodify.com only. Redirects are followed by hand so a hop to another host is refused too. */
async function fetchOnHost(url: string): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!onHost(target)) throw new Error(`refused: ${target} is not on ${HOST}`);
    if (hop) await sleep(GAP_MS); // a redirect hop is another request to the site
    const res = await fetch(target, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, target).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${target}`);
    return res;
  }
  throw new Error(`too many redirects for ${url}`);
}

async function fresh(file: string, maxAgeMs: number): Promise<boolean> {
  try {
    const s = await stat(file);
    return Date.now() - s.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

async function cachedText(url: string, file: string, maxAgeMs = Infinity): Promise<string> {
  if (!REFRESH && (await fresh(file, maxAgeMs))) return readFile(file, "utf8");
  const text = await polite(async () => (await fetchOnHost(url)).text());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return text;
}

const FONT_MAGIC = ["wOFF", "wOF2", "OTTO", "\x00\x01\x00\x00", "true"];
const isFont = (buf: Buffer) => FONT_MAGIC.includes(buf.subarray(0, 4).toString("latin1"));

/** A usemodify.com font file, from the disk cache or fetched once. Null when the site does not serve it. */
export async function cachedFont(url: string): Promise<Buffer | null> {
  if (!onHost(url)) return null;
  const m = url.match(/\/site\/assets\/files\/(\d+)\/([^/?#]+)$/);
  const file = path.join(CACHE, "files", m ? `${m[1]}-${m[2]}` : encodeURIComponent(url));
  try {
    return await readFile(file);
  } catch {}
  if (await fresh(file + ".missing", Infinity)) return null;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const buf = await polite(async () => Buffer.from(await (await fetchOnHost(url)).arrayBuffer()));
    if (!isFont(buf)) throw new Error("not a font file");
    await writeFile(file, buf);
    return buf;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Remember a definite miss (404/410, or an HTML page instead of a font) so reruns do not ask again;
    // delete the .missing file to retry. Timeouts and server errors are not remembered.
    if (/^HTTP (404|410)\b|not a font file/.test(msg)) await writeFile(file + ".missing", msg);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Parsing

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, " "));

export interface Face {
  /** The @font-face font-family, e.g. "sprat-condensedblack". */
  name: string;
  /** Candidate files on usemodify.com, woff first, then ttf. Some woff copies 404 while the ttf works. */
  urls: string[];
  /** File URLs on other hosts, left out (only usemodify.com is fetched). */
  offHost: string[];
}

export interface Page {
  slug: string;
  family: string;
  upstream?: string;
  keywords: string[];
  licenses: string[];
  faces: Face[];
}

function listItems(block: string | undefined): string[] {
  if (!block) return [];
  return [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1])).filter(Boolean);
}

export function parsePage(slug: string, html: string): Page | null {
  const start = html.indexOf("<div class='typeface'>");
  if (start < 0) return null;
  const endAt = html.indexOf("<div class='related'>", start);
  const s = html.slice(start, endAt > 0 ? endAt : undefined);

  const family = stripTags(s.match(/<li class='fontname'>([\s\S]*?)<\/li>/)?.[1] ?? "");
  const upstream = s.match(/<ul class='download_url'>[\s\S]*?<a href='([^']+)'/)?.[1];
  const keywords = listItems(s.match(/<ul class='keywords'>([\s\S]*?)<\/ul>/)?.[1]);
  const licenses = listItems(s.match(/<ul class='license'>([\s\S]*?)<\/ul>/)?.[1]);

  const faces: Face[] = [];
  for (const m of s.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const name = body.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/)?.[1]?.trim();
    if (!name) continue;
    const urls = [...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
      .map((u) => u[1].replace(/[?#].*$/, ""))
      .filter((u) => /\.(woff|ttf)$/i.test(u));
    const ordered = [...urls.filter((u) => /\.woff$/i.test(u)), ...urls.filter((u) => /\.ttf$/i.test(u))];
    const absolute = [...new Set(ordered.map((u) => new URL(u, ORIGIN + "/").href))];
    if (!absolute.length) continue;
    faces.push({ name: decode(name), urls: absolute.filter(onHost), offHost: absolute.filter((u) => !onHost(u)) });
  }
  return { slug, family: family || slug, upstream: upstream ? decode(upstream) : undefined, keywords, licenses, faces };
}

export async function loadPages(log: (msg: string) => void): Promise<Page[]> {
  const index = await cachedText(ORIGIN + "/", path.join(CACHE, "_index.html"), INDEX_MAX_AGE_MS);
  const slugs = [...new Set([...index.matchAll(/href=['"]\/fonts\/([^/'"]+)\/['"]/g)].map((m) => m[1]))];
  log(`${slugs.length} families listed on the homepage`);
  const pages: Page[] = [];
  for (const slug of slugs) {
    if (!/^[a-z0-9-]+$/i.test(slug)) {
      log(`skip ${slug}: unexpected slug`);
      continue;
    }
    const html = await cachedText(`${ORIGIN}/fonts/${slug}/`, path.join(CACHE, `${slug}.html`));
    const page = parsePage(slug, html);
    if (page) pages.push(page);
    else if (/not public yet/i.test(html)) log(`skip ${slug}: the page says the font is not public yet (no files, no licence)`);
    else log(`skip ${slug}: page has no typeface block`);
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------------
// Licences

/** Ordered from most to least restrictive; a row with several licences is labelled by the strictest. */
const LICENSE_ORDER = ["CC BY", "GPL + font exception", "Bitstream Vera", "Apache", "OFL", "MIT", "WTFPL", "CC0", "Public Domain"];

/** Short label for one licence string, or why it is not on the logo-safe list. */
export function classifyLicense(raw: string): { label: string } | { why: string } {
  const t = raw.toLowerCase();
  const unclear = "its terms for artwork made with the font are unclear";
  if (/share.?alike|\bby[ -]?sa\b/.test(t)) return { why: `${raw}: share-alike, ${unclear}` };
  if (/non.?commercial|no.?deriv|\bby[ -]?(nc|nd)\b/.test(t)) return { why: `${raw}: non-commercial or no-derivatives` };
  // Hack's own licence (Hack 2.x) is MIT terms for the Hack changes; Hack 3 relabelled it MIT.
  if (/^hack open font licen/.test(t)) return { label: "MIT" };
  if (/\bsil\b.*open font|^open font licen|\bofl\b/.test(t)) return { label: "OFL" };
  if (/apache/.test(t)) return { label: "Apache" };
  if (/\bmit\b/.test(t)) return { label: "MIT" };
  if (/\bcc0\b|cc zero|creative commons zero/.test(t)) return { label: "CC0" };
  if (/public domain/.test(t)) return { label: "Public Domain" };
  if (/wtfpl|do what the f/.test(t)) return { label: "WTFPL" };
  // DejaVu lists the Arev licence, which is the Bitstream Vera licence with the names changed.
  if (/bitstream vera|^arev fonts/.test(t)) return { label: "Bitstream Vera" };
  // Liberation 1.x: GPLv2 with the font-embedding exception.
  if (/liberation font licen/.test(t) || (/gpl|general public/.test(t) && /font exception/.test(t))) return { label: "GPL + font exception" };
  if (/\bgpl|general public/.test(t)) return { why: `${raw}: GPL without the font exception, ${unclear}` };
  if (/^cc[ -]?by\b|creative commons attribution/.test(t)) return { label: "CC BY" };
  return { why: `${raw}: not a licence on the logo-safe list` };
}

/**
 * The row's licence label. A page that lists the OFL next to another licence offers the OFL as one of
 * the choices (PT Sans: OFL or ParaType; Linux Libertine: OFL or GPL), so the row is OFL. Otherwise every
 * listed licence must be logo-safe, and the strictest one names the row (Hack: MIT + Bitstream Vera).
 */
export function licenseLabel(licenses: string[]): { label?: string; rejected: string[] } {
  if (!licenses.length) return { rejected: ["no licence listed"] };
  const results = licenses.map(classifyLicense);
  const labels = results.flatMap((r) => ("label" in r ? [r.label] : []));
  const rejected = results.flatMap((r) => ("why" in r ? [r.why] : []));
  if (labels.includes("OFL")) return { label: "OFL", rejected: [] };
  if (rejected.length) return { rejected };
  return { label: LICENSE_ORDER.find((l) => labels.includes(l)), rejected };
}

// ---------------------------------------------------------------------------------------------------
// Face names → style, width, optical size, weight, variant
//
// Every @font-face on the site says `font-weight: normal`, so weight, width and variant live only in
// the face name ("sprat-condensedblack", "barlowsemicondensed-extralight", "redaction35-bold"). Names
// come first; the font file's usWeightClass fills in when a name carries no weight word ("jost-semi",
// "authenticsans-130", "ankacoder-b").

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

const ITALIC_RE = /italic|oblique|obliq|slanted|italique|rotalic|kursiv|(^|[-_ ])(i|bi|it)(?=$|[-_ ])|(black|bold|light|semibold|medium|regular|thin|heavy|book)it$/;

const WIDTHS: [RegExp, string][] = [
  [/semi-?conde?n?se?d|smcond/, "Semi Condensed"],
  [/extra-?conde?n?se?d/, "Extra Condensed"],
  [/ultra-?conde?n?se?d/, "Ultra Condensed"],
  [/conde?n?se?d|cond/, "Condensed"],
  [/compressed/, "Compressed"],
  [/narrow/, "Narrow"],
  [/semi-?expanded|smexp/, "Semi Expanded"],
  [/expanded|exp/, "Expanded"],
  [/extended/, "Extended"],
  [/wide/, "Wide"],
];

/** Words that only say "weight"; removed before what is left is read as a variant name. */
const WEIGHT_WORDS =
  /extrablack|ultrablack|xblack|extrabold|ultrabold|semibold|demibold|smbold|extralight|ultralight|semilight|demilight|exlight|hairline|extrafin|submedium|thin|light|book|regular|normal|roman|plain|medium|mittel|black|heavy|bold|fett|demi|semi|extra|satt|med(?![a-z])/g;
/** The words weightFromStyleName knows; when one is present the name's weight wins over the file's. */
const NAMED_WEIGHT = /thin|hairline|extrafin|extralight|ultralight|light|semibold|demibold|demi|medium|mittel|extrabold|ultrabold|black|heavy|satt|bold|fett/;

interface Parsed {
  face: Face;
  /** Face name minus the family prefix, "-webfont" and upload markers, e.g. "condensedblack". */
  style: string;
  /** The site added "_1" / "-1" to a re-uploaded copy of the same face. */
  dupMark: boolean;
  italic: boolean;
  width: string;
  /** Larger is bigger: point size when named, 1000 for display/titling/poster, 500 when unmarked. */
  opsz: number;
  nameWeight?: number;
  /** What is left once weight, width and size words are gone, e.g. "boxes mono", "sans". */
  variant: string;
  digits: string;
}

/** The prefix all face names share: "seanslab-" for Canola, "arkes" for Ark-es, "routedgothic". */
function longestCommonPrefix(names: string[], familyNames: string[]): string {
  if (names.length < 2) return "";
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  // Without separators, trust it only as the start of the family name ("arkes" in "Ark-es Typeface");
  // otherwise cut back to a separator so "seanslab-c" (compressed/condensed) keeps its "c".
  // (Not when some face carries the full family name: "gidol" would turn Gidolinya into "inya".)
  const full = familyNames.map(norm).filter((f) => f.length > 1);
  const someFull = names.some((n) => full.some((f) => norm(n).startsWith(f)));
  if (p.length > 3 && !someFull && full.some((f) => f.startsWith(norm(p)))) return p;
  const cut = Math.max(p.lastIndexOf("-"), p.lastIndexOf("_"));
  return cut > 2 ? p.slice(0, cut + 1) : "";
}

function stripPrefix(face: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    const f = norm(prefix);
    if (f.length < 2) continue;
    for (let i = 1; i <= face.length; i++) {
      const n = norm(face.slice(0, i));
      if (n === f) return face.slice(i);
      if (n.length > f.length || !f.startsWith(n)) break;
    }
  }
  return face;
}

export function parseFace(face: Face, prefixes: string[], opts: Override = {}): Parsed {
  let s = stripPrefix(face.name.toLowerCase(), prefixes);
  s = s.replace(/-webfont.*$/, "");
  const dupMark = /[a-z][-_][1-9]$/.test(s);
  if (dupMark) s = s.replace(/[-_][1-9]$/, "");
  s = s.replace(/^[-_ ]+|[-_ ]+$/g, "");
  const style = s;
  const italic = ITALIC_RE.test(s);

  let width = "";
  for (const [re, label] of WIDTHS) {
    if (re.test(s)) {
      width = label;
      s = s.replace(re, " ");
      break;
    }
  }

  let opsz = 500;
  const pt = s.match(/(\d+)\s*pt/);
  if (pt) {
    opsz = Number(pt[1]);
    s = s.replace(pt[0], " ");
  } else if (/titling|display|poster|banner|headline/.test(s) && !opts.styleWords?.test(s)) {
    opsz = 1000;
    s = s.replace(/titling|display|poster|banner|headline/, " ");
  } else if (/caption|micro|subhead/.test(s)) {
    opsz = 10;
    s = s.replace(/caption|micro|subhead/, " ");
  }

  // "sinkinsans-300light": a weight number next to its weight word is not a variant.
  // (Glued only: "redaction100-bold" is Redaction 100.)
  s = s.replace(/[1-9]00(?=(x?black|bold|light|medium|regular|thin|heavy|semibold|extrabold|extralight))/, " ");
  // Variable-font markers ("amonovf", "kikuta-variable-vf") say nothing about the design.
  s = s.replace(/variable|vf(?![a-z])/g, " ");

  s = s.replace(/smbold/, "semibold"); // Junicode "SmExp SmBold"
  let nameWeight: number | undefined;
  const flat = s.replace(/[\s_-]/g, "");
  if (NAMED_WEIGHT.test(flat)) nameWeight = weightFromStyleName(flat);
  else if (/regular|normal|plain|roman/.test(flat) || /(^|[-_ ])r(?=$|[-_ ])/.test(s)) nameWeight = 400;
  else if (/(^|[-_ ])b(?=$|[-_ ])/.test(s)) nameWeight = 700;

  s = s
    .replace(ITALIC_RE, " ")
    .replace(WEIGHT_WORDS, " ")
    .replace(/(^|[-_ ])[rb](?=$|[-_ ])/g, " ");
  const digits = (s.match(/\d+/g) ?? []).join(" ");
  const variant = s
    .replace(/\d+/g, " ")
    .replace(/[-_\s]+/g, " ")
    .trim();
  return { face, style, dupMark, italic, width, opsz, nameWeight, variant, digits };
}

// ---------------------------------------------------------------------------------------------------
// Per-family corrections, for names the generic rules cannot read. Keyed by page slug.

interface Override {
  /** Display name for the base row (and the prefix of variant rows). */
  family?: string;
  /** Faces to leave out, with the reason logged. */
  skip?: { re: RegExp; why: string }[];
  /** Variant key → row name suffix ("" merges into the base row, "=Name" replaces the whole name). */
  labels?: Record<string, string>;
  /** Digits in these names are optical sizes, not variants (larger is kept). Applies to every face with digits. */
  digitsAreOpsz?: boolean;
  /** Words that name a style of their own here, not an optical size ("poster" in Tribalium Neue Poster). */
  styleWords?: RegExp;
  /** Extra tags for every row. */
  tags?: string[];
  /** Weight from the digits in a face name, for families that number their weights. */
  digitWeight?: (digits: string) => number;
  /** Site keywords to ignore for this family. */
  dropTags?: string[];
  /** Rows (by full name) that are the sans or the serif of a family tagged with both. */
  sansRows?: RegExp;
  serifRows?: RegExp;
}

const OVERRIDES: Record<string, Override> = {
  // Pixel-effect variants each come as a proportional and a monospaced twin with the same look; the twin
  // folds into the proportional row (same weight, so the shorter name wins). 0xA000 Mono stays its own row.
  "0xa000": {
    labels: { "boxes mono": "Boxes", "dots mono": "Dots", "monochrome mono": "Monochrome", "pixelated mono": "Pixelated", "squareish mono": "Squareish" },
  },
  "alte-din-1451": { labels: { "din alt": "", "din alt g": "Geprägt" } },
  "anka-coder": { labels: { "c 75": "Narrow", "c 87": "Condensed" } },
  "anonymous-pro": { labels: { minus: "" } },
  "ark-typeface": { family: "Ark-es" },
  // The site tags these plain grotesques "blackletter", which would send them to blackletter searches.
  aileron: { dropTags: ["blackletter"] },
  jost: { dropTags: ["blackletter"] },
  "fivo-sans-modern": { dropTags: ["blackletter"] },
  bluu: { family: "Bluu Next" },
  // "A font in four weights": the numbers are stem weights, the files all say 400.
  half: { digitWeight: (d) => ({ "21": 300, "39": 400, "51": 500, "75": 700 })[d] ?? 400 },
  monomusic: { skip: [{ re: /^mplus/, why: "M+ 1c Heavy, a different family listed on this page" }] },
  // A versioned experiment: 0.1-0.4 are earlier states of the design, 0.5 is current. The second
  // number is the stroke weight (10-100).
  version: {
    skip: [{ re: /^version_0[1-4]_/, why: "earlier version of the design; version 0.5 is kept" }],
    digitWeight: (d) => Math.min(900, Math.max(100, Math.round(Number(d.split(" ").pop()) / 10) * 100)),
  },
  // ebgaramond08/12 and ebgaramondsc08/12 are the 8 pt and 12 pt optical sizes; 12 is kept.
  "eb-garamond": {
    digitsAreOpsz: true,
    skip: [
      { re: /initialsf[12]/, why: "colour fill layer for the initials, not a typeface on its own" },
      { re: /allsc/, why: "all-small-caps cut (capitals shrunk too); EB Garamond SC serves the normal small caps" },
    ],
  },
  fibel: { labels: { sued: "Süd" } },
  // The file names it "Ferrite Core DX Display": a style next to Light-Black, not an optical size.
  "ferrite-core": { family: "Ferrite Core DX", styleWords: /display/ },
  "grammatika-regular": { family: "Grammatika" },
  guidole: { labels: { gidolinya: "=Gidolinya" } },
  "ia-writer": { labels: { duos: "Duo", monos: "Mono", quattros: "Quattro" } },
  meyrin: { family: "Meyrin" },
  // Face names are file codes: lin<family>_<r|b|z|d><i><a h>, R regular, B bold, Z semibold, D display,
  // I italic (so "riah" is Libertine Italic and "rbiah" its Bold Italic).
  "linux-libertine": {
    labels: {
      "linlibertine rah": "",
      "linlibertine rbah": "",
      "linlibertine rzah": "",
      "linlibertine riah": "",
      "linlibertine rbiah": "",
      "linlibertine rziah": "",
      "linlibertine drah": "Display",
      "linbiolinum rah": "=Linux Biolinum",
      "linbiolinum rbah": "=Linux Biolinum",
      "linbiolinum riah": "=Linux Biolinum",
    },
    skip: [
      { re: /linbiolinum_kah/, why: "Linux Biolinum Keyboard: key-cap symbols for manuals, not a typeface for words" },
      { re: /^linlibertine_i-/, why: "Linux Libertine Initials: decorative capitals, not an italic (its code 'i' reads like one)" },
    ],
    sansRows: /biolinum/i,
    serifRows: /libertine/i,
  },
  // ParaType file codes: pts PT Sans, ptn PT Sans Narrow, ptc PT Sans Caption; 55/75 Regular/Bold.
  "pt-sans": {
    labels: { "pts f w": "", "ptn f w": "Narrow" },
    skip: [{ re: /^ptc/, why: "PT Sans Caption, the small-size optical cut; PT Sans itself is served" }],
  },
  "pt-serif": { skip: [{ re: /^ptz/, why: "PT Serif Caption, the small-size optical cut; PT Serif itself is served" }] },
  monoid: { labels: { retina: "" } },
  profont: { labels: { windows: "" } },

  recursive: { labels: { monocslst: "Mono Casual", sanscslst: "Sans Casual", sanslnrst: "Sans Linear" } },
  "routed-gothic-font": { family: "Routed Gothic" },
  // Syne's script is its italic (the row's italicFiles); the upright the row is tagged by is not a script.
  syne: { dropTags: ["script"] },
  "steps-mono": { labels: { mono: "" } },
  tgl: { labels: { "0 16": "0-16", "0 17": "0-17", alt: "0-17 Alt" } },
  toren: { labels: { proportional: "" } },
  // Poster is a decorated style of its own (the outlines overlap the Regular's by under 20%).
  "tribalium-neue": { styleWords: /poster/ },
  // Pixel and Pixel Large are the same drawing snapped to a fine and a coarse pixel grid, with identical
  // advances; at catalog sizes they read as one design, so Large folds into Pixel (the finer grid is kept).
  // Cormorant Garamond stays its own row: its a, e, g and figures are drawn differently from Cormorant's.
  vagra: { labels: { "pixel large": "Pixel" } },
};

// ---------------------------------------------------------------------------------------------------
// Tags and categories

const TAG_MAP: Record<string, string | null> = {
  "sans serif": "sans",
  "grotesque / lineale": "grotesque",
  "garalde / old face": "garalde",
  "extended / wide": "wide",
  "glyphic / incise": "glyphic",
  inktraps: "ink-traps",
  smallsize: "small-size",
  "super-family": null,
  derivated: null,
  "large character map": null,
  latex: null,
};
/** Expressive tags first, so the cap at 8 drops the least useful ones. */
const TAG_PRIORITY = [
  "italic only", "wonky", "damage", "generative", "graphic", "pixel", "blackletter", "curveless", "reverse-contrast",
  "ink-traps", "organic", "paleographic", "glyphic", "mechanistic", "script", "gaelic", "bitmap", "ascii", "rounded",
  "condensed", "narrow", "wide", "monolinear", "revival", "geometric", "humanist", "didone", "slab", "garalde",
  "grotesque", "sans", "serif", "monospace", "code", "screen", "symbols", "variable", "small-size", "cyrillic",
];

/** A site keyword as a tag: "extended / wide" → "wide", "2020" → "2020s"; null drops it. */
function mapTag(k: string): string | null {
  const t = k.toLowerCase().trim();
  return t in TAG_MAP ? TAG_MAP[t] : /^(19|20)\d0$/.test(t) ? `${t}s` : t;
}

function cleanTags(keywords: string[], extra: string[]): string[] {
  const out: string[] = [];
  for (const k of [...keywords, ...extra]) {
    const t = mapTag(k);
    if (t && !out.includes(t) && t.length <= 24) out.push(t);
  }
  const decade = TAG_PRIORITY.indexOf("monospace") + 0.5;
  const rank = (t: string) => {
    const i = TAG_PRIORITY.indexOf(t);
    return i < 0 ? (/^\d{4}s$/.test(t) ? decade : 99) : i;
  };
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

/** Keywords that claim fixed-width letters; kept only when the served file measures monospaced. */
const MONO_TAG = /^(mono|monospaced?|code|coding|programming)$/;
/** Keywords that describe width; a family-level one says nothing about a row whose own name sets its width. */
const WIDTH_TAG = /^(wide|narrow|condensed|compressed|extended|expanded)$/;
const widthClass = (name: string) =>
  /condensed|compressed|narrow/i.test(name) ? "narrow" : /extended|expanded|wide/i.test(name) ? "wide" : "";

// ---------------------------------------------------------------------------------------------------
// Font files

interface FileFacts {
  url: string;
  weight: number;
  italic: boolean;
  /** Any variation axis. */
  variable: boolean;
  /** wght axis range when the file is variable along weight. */
  wght?: { min: number; max: number };
  latin: boolean;
  /** Narrow and wide letters (i l I against m M W, and 0) share one advance width, within 2%. */
  monospaced: boolean;
  /** Advance widths measured, per letter, for the log. */
  advances: string;
  /** The file's own style name: typographic subfamily, or family + subfamily ("Galgo" "Light"). */
  styleName: string;
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = UPPER.toLowerCase();
const NARROW_LETTERS = ["i", "l", "I"];
const WIDE_LETTERS = ["m", "M", "W"];

/** Equal advances for at least one narrow and one wide letter (and every other measured one). */
function measureMono(font: fontkit.Font): { monospaced: boolean; advances: string } {
  const adv = (c: string) => {
    const g = font.glyphForCodePoint(c.codePointAt(0)!);
    return g && g.id !== 0 ? g.advanceWidth : undefined;
  };
  const narrow = NARROW_LETTERS.flatMap((c) => adv(c) ?? []);
  const wide = WIDE_LETTERS.flatMap((c) => adv(c) ?? []);
  const all = [...narrow, ...wide, ...(adv("0") !== undefined ? [adv("0")!] : [])];
  const advances = [...NARROW_LETTERS, ...WIDE_LETTERS, "0"].map((c) => `${c}=${adv(c) ?? "-"}`).join(" ");
  if (!narrow.length || !wide.length) return { monospaced: false, advances };
  const max = Math.max(...all);
  return { monospaced: max > 0 && max - Math.min(...all) <= max * 0.02, advances };
}

async function fileFacts(face: Face): Promise<FileFacts | null> {
  for (const url of face.urls) {
    const buf = await cachedFont(url);
    if (!buf) continue;
    try {
      const info = readFontInfo(buf);
      const font = fontkit.create(buf) as fontkit.Font;
      const getName = (k: string) => (font as unknown as { getName(k: string): string | null }).getName(k);
      // The typographic subfamily wins: Vägra! files its Pixel styles under "Italic" for style linking.
      const sub = getName("preferredSubfamily") ?? font.subfamilyName ?? "";
      const axes = (font as unknown as { variationAxes?: Record<string, { min: number; max: number }> }).variationAxes ?? {};
      const has = (chars: string) => [...chars].every((c) => font.hasGlyphForCodePoint(c.codePointAt(0)!));
      return {
        url,
        weight: info.weight,
        // The OS/2 italic bit alone is not trusted: IBM 3270's upright Medium sets it.
        italic: /italic|oblique/i.test(sub),
        variable: info.variable,
        wght: info.variable && axes.wght ? { min: axes.wght.min, max: axes.wght.max } : undefined,
        latin: has(UPPER) || has(LOWER),
        ...measureMono(font),
        styleName: getName("preferredSubfamily") ?? `${font.familyName ?? ""} ${font.subfamilyName ?? ""}`.trim(),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Weight words a file's own name may carry, as whole words ("Light", "ExtraBold", not "Blackletter"). */
const FILE_WEIGHT_WORD =
  /^(?:(?:extra|ultra|semi|demi)?(?:light|bold|black)|thin|hairline|medium|heavy|demi)$/;

/**
 * The weight a file's own name states, once the family's own words are taken out: "Galgo Light" → 300,
 * "Ferrite Core DX Medium" → 500. Undefined when the name states none ("Regular", "Roman", "08 Regular").
 */
function fileNamedWeight(styleName: string, familyWords: string[]): number | undefined {
  const words = styleName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const own = words.filter((w) => !familyWords.includes(w));
  // Rejoin "Extra Light", "Semi Bold" and friends; "Sm Bold" is Junicode's SemiBold.
  const joined: string[] = [];
  for (const w of own) {
    const prev = joined[joined.length - 1];
    if (prev && /^(extra|ultra|semi|demi|sm)$/.test(prev) && /^(light|bold|black)$/.test(w)) {
      joined[joined.length - 1] = (prev === "sm" ? "semi" : prev) + w;
    } else joined.push(w);
  }
  const hit = joined.find((w) => FILE_WEIGHT_WORD.test(w));
  return hit ? weightFromStyleName(hit) : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Rows

interface Cand extends Parsed {
  file: FileFacts;
  weight: number;
}

/** Splits glued variant words: "sansmono" → "sans mono", "monocalligraphic" → "mono calligraphic". */
const GLUED = ["sans", "serif", "mono", "slab", "one", "alternate", "outline", "inline", "shadow", "calligraphic", "geometric", "casual", "linear"];
function splitGlued(s: string): string {
  // Only when the whole word is made of known parts, so "monochrome" stays one word.
  const parts = (w: string): string[] | null => {
    if (!w) return [];
    for (const g of GLUED) {
      if (!w.startsWith(g)) continue;
      const rest = parts(w.slice(g.length));
      if (rest) return [g, ...rest];
    }
    return null;
  };
  return s
    .split(" ")
    .map((w) => parts(w)?.join(" ") || w)
    .join(" ");
}

const titleCase = (s: string) =>
  s
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

/**
 * Best face for one weight inside a row: static over variable, a true italic over an oblique (Victor Mono
 * has both; uprights never carry either word), "regular"-named, plain names, originals.
 */
function better(a: Cand, b: Cand): Cand {
  const score = (c: Cand) =>
    (c.file.wght ? 0 : 32) +
    (/oblique|obliq|slanted/.test(c.style) ? 0 : 16) +
    (/regular|normal|roman/.test(c.style) ? 8 : /book|plain/.test(c.style) ? 4 : 0) +
    (c.dupMark ? 0 : 2) +
    (c.face.urls[0] === c.file.url ? 1 : 0);
  const sa = score(a);
  const sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  return a.style.length <= b.style.length ? a : b;
}

/** "Geprägt" → "gepragt", "Süd" → "sud": accents come off before the slug is made. */
const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const nearest400 = (weights: number[]) => weights.reduce((a, b) => (Math.abs(b - 400) < Math.abs(a - 400) ? b : a));

export const builder: SourceBuilder = {
  async build(log) {
    const pages = await loadPages(log);
    const rows: FontEntry[] = [];
    let faceCount = 0;
    let italicCount = 0;

    for (const page of pages) {
      const o = OVERRIDES[page.slug] ?? {};
      const familyName = o.family ?? page.family.replace(/\s+typeface$/i, "");
      if (/^(noto|playwrite)\b/i.test(familyName)) {
        log(`skip ${page.slug}: Noto and Playwrite families are excluded from the catalog`);
        continue;
      }
      const lic = licenseLabel(page.licenses);
      if (!lic.label) {
        log(`skip ${page.slug}: licence not logo-safe (${lic.rejected.join("; ")})`);
        continue;
      }
      if (!page.faces.length) {
        log(`skip ${page.slug}: no @font-face files on the page`);
        continue;
      }
      for (const f of page.faces) {
        if (f.offHost.length) log(`face ${page.slug}/${f.name}: left out ${f.offHost.join(", ")} (only usemodify.com is fetched)`);
      }

      const names = [o.family ?? "", page.family, page.slug].filter(Boolean);
      const lcp = longestCommonPrefix(page.faces.map((f) => f.name.toLowerCase()), names);
      const prefixes = [...names, lcp].filter(Boolean);
      const parsed = page.faces.map((f) => parseFace(f, prefixes, o));
      const familyWords = [...new Set(names.flatMap(words))];
      const fullNameOf = (suffix: string) =>
        suffix.startsWith("=") ? suffix.slice(1) : suffix ? `${familyName} ${suffix}` : familyName;
      let monoSibling = false;

      const skipped = new Map<string, string[]>();
      const skipWhy = (p: Parsed) => {
        const why = o.skip?.find((x) => x.re.test(p.face.name))?.why;
        if (why) skipped.set(why, [...(skipped.get(why) ?? []), p.face.name]);
        return why;
      };
      const read = async (p: Parsed): Promise<Cand | null> => {
        const file = await fileFacts(p.face);
        if (!file) {
          log(`skip face ${page.slug}/${p.face.name}: the site serves no readable woff/ttf for it`);
          return null;
        }
        if (!file.latin) {
          log(`skip face ${page.slug}/${p.face.name}: no full A-Z or a-z, cannot set a Latin word`);
          return null;
        }
        return { ...p, file, weight: 0 };
      };

      const weigh = (c: Cand) => {
        // A bare face name ("tuffy", "fifteentwenty", or "tuffy_italic" for a slanted face) next to named
        // weights is the Regular, whatever usWeightClass says (Tuffy's says 500). Otherwise the file's
        // weight fills in.
        const bare = !/[a-z0-9]/.test(c.style.replace(ITALIC_RE, "")) && page.faces.length > 1 && !c.file.wght;
        c.weight = c.nameWeight ?? (bare ? 400 : c.file.weight);
        // The file's own name wins over the face name when they disagree: "galgo-medium" is a file
        // named "Galgo Light".
        const named = c.file.variable || o.digitWeight ? undefined : fileNamedWeight(c.file.styleName, familyWords);
        if (named !== undefined && named !== c.weight) {
          log(`face ${page.slug}/${c.face.name}: its file is named "${c.file.styleName}", so weight ${named}, not ${c.weight}`);
          c.weight = named;
        }
      };

      // Upright faces, with their files read once. Slanted faces are read after, as the uprights' italics,
      // or as the stand-in when there is no upright.
      const cands: Cand[] = [];
      const slanted: (Parsed | Cand)[] = [];
      let uprightNamed = 0;
      for (const p of parsed) {
        if (p.italic) {
          slanted.push(p);
          continue;
        }
        if (skipWhy(p)) continue;
        uprightNamed++;
        const c = await read(p);
        if (!c) continue;
        if (c.file.italic) {
          uprightNamed--;
          slanted.push(c);
          continue;
        }
        weigh(c);
        cands.push(c);
      }
      const logSkipped = () => {
        for (const [why, faces] of skipped) {
          log(`skip ${faces.length > 1 ? `${faces.length} faces of ${page.slug} (${faces[0]} ...)` : `face ${page.slug}/${faces[0]}`}: ${why}`);
        }
        skipped.clear();
      };

      // ---- No upright style at all: the slanted face nearest Regular is served as 400, "italic only".
      if (!cands.length && !uprightNamed) {
        const pool: Cand[] = [];
        for (const p of slanted) {
          if (skipWhy(p)) continue;
          const c = "file" in p ? p : await read(p);
          if (c) pool.push({ ...c, weight: c.nameWeight ?? c.file.weight });
        }
        logSkipped();
        if (!pool.length) {
          log(`skip ${page.slug}: no readable face at all`);
          continue;
        }
        const pick = pool.reduce((a, b) => {
          const da = Math.abs(a.weight - 400);
          const db = Math.abs(b.weight - 400);
          return da !== db ? (da < db ? a : b) : better(a, b);
        });
        log(`${page.slug}: no upright style at all; serving the slanted ${pick.face.name} as weight 400, tagged "italic only"`);
        faceCount++;
        rows.push(makeRow("", new Map([[400, pick]]), { italicOnly: true, dropWidthKeywords: widthClass(familyName) !== "" }));
        continue;
      }
      logSkipped();
      if (!cands.length) {
        log(`skip ${page.slug}: no readable upright face left`);
        continue;
      }
      faceCount += cands.length;

      // Rows keyed by variant and width (before a family of one row becomes just the family). Uprights and
      // italics each go through this on their own, so an italic reads its digits, ties and variant the way
      // its upright does.
      const groupRows = (list: Cand[]): Map<string, Cand[]> => {
        // Digits left in names: optical sizes by override ("ebgaramond08/12", "ebgaramondsc12"), for every
        // face that has them; otherwise shared by every face of a group → noise ("lunchtype22-light");
        // different file weights with no weight word → weight codes ("authenticsans-60/90/130"); else →
        // variants ("redaction10", "dof-2").
        if (o.digitsAreOpsz) for (const c of list) c.opsz = c.digits ? Number(c.digits.split(" ").pop()) : 0;
        const groups = new Map<string, Cand[]>();
        for (const c of list) {
          const k = `${c.variant}|${c.width}`;
          groups.set(k, [...(groups.get(k) ?? []), c]);
        }
        for (const g of groups.values()) {
          if (o.digitWeight) {
            for (const c of g) c.weight = o.digitWeight(c.digits);
            continue;
          }
          if (o.digitsAreOpsz) continue;
          const distinct = new Set(g.map((c) => c.digits));
          if (distinct.size <= 1) continue;
          const codes = g.every((c) => c.nameWeight === undefined) && new Set(g.map((c) => c.file.weight)).size === g.length;
          if (codes) continue;
          for (const c of g) if (c.digits) c.variant = `${c.variant} ${c.digits}`.trim();
        }

        // Two names that read as the same weight. When their files differ ("jost-hairline" 100 and
        // "jost-thin" 200, "jost-heavy" 800 and "jost-black" 900), the files decide. When the files tie
        // too, Heavy sits under Black and ExtraBlack: Heavy 800, (Extra)Black 900.
        for (const g of groups.values()) {
          const byWeight = new Map<number, Cand[]>();
          for (const c of g) if (!c.file.wght) byWeight.set(c.weight, [...(byWeight.get(c.weight) ?? []), c]);
          for (const same of byWeight.values()) {
            if (same.length < 2 || !same.every((c) => c.opsz === same[0].opsz)) continue;
            if (new Set(same.map((c) => c.file.weight)).size === same.length) {
              for (const c of same) c.weight = c.file.weight;
              continue;
            }
            if (same.some((c) => /black/.test(c.style))) {
              for (const c of same) {
                if (!/heavy/.test(c.style) || /black/.test(c.style)) continue;
                log(`face ${page.slug}/${c.face.name}: Heavy next to a Black with the same file weight, so 800`);
                c.weight = 800;
              }
            }
          }
        }

        // One row per variant and width.
        const byKey = new Map<string, Cand[]>();
        for (const c of list) {
          const label = o.labels?.[c.variant] ?? titleCase(splitGlued(c.variant));
          const key = [label, c.width].filter(Boolean).join(" ");
          byKey.set(key, [...(byKey.get(key) ?? []), c]);
        }
        return byKey;
      };

      // Weight → face for one row's faces (its uprights, or its italics).
      const chooseWeights = (members0: Cand[], fullName: string): Map<number, Cand> => {
        // Optical sizes of one design: keep the largest.
        const top = Math.max(...members0.map((c) => c.opsz));
        const members = members0.filter((c) => c.opsz === top);
        const smaller = members0.filter((c) => c.opsz !== top);
        if (smaller.length) log(`${fullName}: kept the largest optical size; left out ${smaller.map((c) => c.face.name).join(", ")}`);
        const statics = members.filter((c) => !c.file.wght);
        const pool = statics.length ? statics : members;
        const unused = members.filter((c) => !pool.includes(c));
        if (unused.length) log(`${fullName}: static files cover the row; left out the variable ${unused.map((c) => c.face.name).join(", ")}`);
        const chosen = new Map<number, Cand>();
        const losses = new Map<Cand, { to: Cand; at: number[] }>();
        const put = (w: number, c: Cand) => {
          const prev = chosen.get(w);
          if (!prev) return void chosen.set(w, c);
          const win = better(prev, c);
          const lose = win === prev ? c : prev;
          chosen.set(w, win);
          const l = losses.get(lose) ?? { to: win, at: [] };
          l.to = win;
          l.at.push(w);
          losses.set(lose, l);
        };
        for (const c of pool) {
          if (c.file.wght && !statics.length) {
            const lo = Math.max(100, Math.ceil(c.file.wght.min / 100) * 100);
            const hi = Math.min(900, Math.floor(c.file.wght.max / 100) * 100);
            for (let w = lo; w <= hi; w += 100) put(w, c);
            continue;
          }
          put(c.weight, c);
        }
        for (const [lose, { to, at }] of losses) {
          if ([...chosen.values()].includes(lose)) continue;
          log(`weight tie in ${fullName} at ${at.join("/")}: ${to.face.name} kept, ${lose.face.name} left out`);
        }
        return chosen;
      };

      const byKey = groupRows(cands);
      // A family that ends up as one row is just the family ("fontlab" in Fontlab Font, "dx" in Ferrite Core).
      const suffixOf = (key: string) => (byKey.size === 1 ? "" : key);
      const byRow = new Map([...byKey].map(([key, list]) => [suffixOf(key), list] as const));
      // When any row's own name sets a width, the page's width keywords describe some members only.
      const dropWidthKeywords = [...byRow.keys()].some((k) => widthClass(fullNameOf(k)) !== "");
      monoSibling = [...byRow.keys()].some((k) => /\bmono\b/i.test(fullNameOf(k)));

      // The slanted faces, read and weighed like the uprights, join the row with the same variant and
      // width. In a family of one row every italic is that row's ("struggle-rotalics" reads as variant "s").
      // An italic whose variant has no upright row (Routed Gothic's half-slanted cuts) is left out.
      const italics: Cand[] = [];
      for (const p of slanted) {
        if (skipWhy(p)) continue;
        const c = "file" in p ? p : await read(p);
        if (!c) continue;
        weigh(c);
        italics.push(c);
      }
      logSkipped();
      const italicRows = new Map<string, Cand[]>();
      const strays: string[] = [];
      for (const [key, list] of groupRows(italics)) {
        const suffix = byKey.has(key) ? suffixOf(key) : byKey.size === 1 ? "" : undefined;
        if (suffix === undefined) strays.push(...list.map((c) => c.face.name));
        else italicRows.set(suffix, [...(italicRows.get(suffix) ?? []), ...list]);
      }
      if (strays.length) log(`${familyName}: left out italics with no upright row: ${strays.join(", ")}`);

      for (const [suffix, members0] of byRow) {
        const fullName = fullNameOf(suffix);
        const chosen = chooseWeights(members0, fullName);
        const rowItalics = italicRows.get(suffix);
        const italic = rowItalics ? chooseWeights(rowItalics, `${fullName} italics`) : undefined;
        italicCount += italic?.size ?? 0;
        rows.push(makeRow(suffix, chosen, { dropWidthKeywords, italic }));
      }

      function makeRow(
        suffix: string,
        chosen: Map<number, Cand>,
        opts: { italicOnly?: boolean; dropWidthKeywords: boolean; italic?: Map<number, Cand> },
      ): FontEntry {
        const fullName = fullNameOf(suffix);
        const weights = [...chosen.keys()].sort((a, b) => a - b);
        const files: Record<number, string> = {};
        for (const w of weights) files[w] = chosen.get(w)!.file.url;
        // An italic-only row's one file is its italic too, so an Italic switch shows the same face.
        const italicFiles: Record<number, string> = opts.italicOnly ? files : {};
        for (const w of [...(opts.italic?.keys() ?? [])].sort((a, b) => a - b)) italicFiles[w] = opts.italic!.get(w)!.file.url;
        const served = [...chosen.values()];
        // Monospaced is measured on the served file nearest Regular, never taken from a name or keyword.
        const regular = chosen.get(nearest400(weights))!;
        const mono = regular.file.monospaced;
        const variable = served.some((c) => c.file.variable);
        // Said to be mono: by its name, or by a page keyword when no sibling row is the Mono one.
        const claimsMono =
          /\bmono\b/i.test(fullName) || (!monoSibling && page.keywords.some((k) => MONO_TAG.test(mapTag(k) ?? "")));
        if (claimsMono && !mono) log(`${fullName}: called mono, but its letters are not monospaced (${regular.file.advances}); not mono`);
        if (!claimsMono && mono) log(`${fullName}: nothing calls it mono, but its letters are monospaced (${regular.file.advances})`);
        // A row named Sans or Serif inside a family tagged with both ("DejaVu Serif", "Liberation Sans").
        const namedSans = /\bsans\b/i.test(fullName) || Boolean(o.sansRows?.test(fullName));
        const namedSerif = !namedSans && (/\bserif\b/i.test(fullName) || Boolean(o.serifRows?.test(fullName)));
        const keywords = page.keywords.filter((k) => {
          const t = mapTag(k) ?? "";
          if (o.dropTags?.includes(k)) return false;
          if (MONO_TAG.test(t) && !mono) return false;
          if (t === "variable" && !variable) return false;
          if (WIDTH_TAG.test(t) && opts.dropWidthKeywords) return false;
          if (namedSerif && /^sans|grotesque/i.test(k)) return false;
          if (namedSans && /^serif$|garalde|didone|slab|old.?style/i.test(k)) return false;
          return true;
        });
        const extra = [
          ...(opts.italicOnly ? ["italic only"] : []),
          ...(o.tags ?? []),
          ...(/condensed|compressed/i.test(fullName) ? ["condensed"] : []),
          ...(/narrow/i.test(fullName) ? ["narrow"] : []),
          ...(/extended|expanded|wide/i.test(fullName) ? ["wide"] : []),
          ...(mono ? ["monospace"] : []),
          ...(variable ? ["variable"] : []),
          ...(namedSerif ? ["serif"] : []),
          ...(namedSans ? ["sans"] : []),
        ];
        return {
          id: suffix ? `${SOURCE}:${page.slug}:${slugify(suffix.replace(/^=/, ""))}` : `${SOURCE}:${page.slug}`,
          family: fullName,
          source: SOURCE,
          category: categoryFromTags([...keywords, ...extra]),
          tags: cleanTags(keywords, extra),
          weights,
          license: lic.label!,
          files,
          ...(Object.keys(italicFiles).length ? { italicFiles } : {}),
          homepage: `${ORIGIN}/fonts/${page.slug}/`,
          proxy: true,
        };
      }
    }
    log(
      `${rows.length} rows from ${faceCount} served faces, plus ${italicCount} italics in ` +
        `${rows.filter((r) => r.italicFiles && !r.tags.includes("italic only")).length} rows; ${requests} requests to usemodify.com this run`,
    );
    return rows;
  },
};
