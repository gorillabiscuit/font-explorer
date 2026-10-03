// Tunera Type Foundry (tunera.xyz): about 20 OFL families, mostly by Ariel Martín Pérez.
// The homepage is the only catalog: one card per family, each with a download link that points at the
// family's repository (Codeberg for most, a few on GitLab, one on GitHub). This builder reads the homepage
// once, lists each repository's font folder through the host's API, downloads every face once to read its
// real weight, and turns the styles into rows: uprights in `files`, slanted faces in `italicFiles` of their
// upright's row. A family with no upright style at all would get one row from a slanted file at 400 (in both
// maps), tagged "italic only" (no Tunera family needs that today).
//
// Etiquette: tunera.xyz asks for Crawl-delay 10, so a run makes at most one homepage request (the HTML is
// cached for a week under server/.cache/tunera/) and never opens the family pages. Font files come from the
// repositories' API raw endpoints (CORS-friendly), never from tunera.xyz. GitHub's unauthenticated API is
// used for a single call (Amakan's creation date); jsDelivr's data API lists that repository's files.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { load as loadYaml } from "js-yaml";
import {
  categoryFromTags,
  fetchBuffer,
  fetchJson,
  fetchOk,
  fetchText,
  readFontInfo,
  sleep,
  weightFromStyleName,
  type Category,
  type FontEntry,
  type FontFileInfo,
  type SourceBuilder,
} from "./common.ts";

const SOURCE = "tunera" as const;
const HOME_URL = "https://www.tunera.xyz/";
const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, "..", ".cache", "tunera");
const HOME_CACHE = path.join(CACHE, "home.html");
const HOME_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Preferred file format per face, best first. */
const FONT_EXT = ["woff2", "woff", "otf", "ttf"];

// ---------------------------------------------------------------------------------------------------
// Hand-made knowledge per family (keyed by the homepage slug). Categories follow the research notes,
// except Canarina, which has no serifs. Families missing here still get a row, with tags taken from the
// repository's METADATA.yml and topics.

interface FamilyHints {
  category: Category;
  tags: string[];
  /** Extra tags for a variant row, keyed by the variant name ("Neon Tube"). */
  variantTags?: Record<string, string[]>;
  /** Leave the whole family out, with this reason. */
  skip?: string;
  /** Leave out matching font files, with a reason. */
  skipPaths?: { re: RegExp; reason: string }[];
}

const HINTS: Record<string, FamilyHints> = {
  ampoule: {
    category: "display",
    tags: ["dot-grid", "pixel", "neon", "modular", "cyberpunk", "signage", "techno", "rounded"],
    variantTags: { "Neon Tube": ["outline"], "Rats Tube": ["outline"] },
    skipPaths: [
      {
        re: /playground/i,
        reason: "Ampoule Playground is a pattern set: its letters dissolve into chickens, flowers and stars and do not read as words",
      },
    ],
  },
  luperca: { category: "serif", tags: ["roman", "capitals", "inscriptional", "classical", "ligatures", "editorial", "elegant", "wide"] },
  canarina: { category: "sans", tags: ["angular", "brush", "informal", "humanist", "friendly", "vernacular", "canary islands"] },
  azabache: { category: "handwriting", tags: ["handwritten", "modular", "textured", "calligraphic", "digital", "streamlined", "slanted"] },
  choso: {
    category: "display",
    tags: [],
    skip: "symbol font: its keys map to geometric frieze ornaments from Canarian house facades, not letters",
  },
  tanklager: {
    category: "sans",
    tags: ["grotesk", "din", "vernacular", "swiss", "hand-painted", "quirky", "signage"],
    variantTags: { Kompakt: ["condensed"] },
  },
  lobular: { category: "display", tags: ["bubble", "inktrap", "blobby", "graffiti", "organic", "heavy", "caps", "playful"] },
  amakan: {
    category: "display",
    tags: ["pattern", "woven", "monospaced", "geometric", "textile", "grid", "caps", "filipino"],
    variantTags: { Stripes: ["striped"], Strips: ["striped"] },
    skipPaths: [
      {
        re: /(^|\/)Amakan-Sheet\.[^/]+$/i,
        reason: "Amakan Sheet is a woven pattern: its letters read only as weave direction, not as words; Stripes and Strips stay",
      },
    ],
  },
  "nyght-serif": { category: "serif", tags: ["contemporary", "high-contrast", "sharp", "spiky", "spurs", "editorial", "cyrillic"] },
  piscolabis: { category: "sans", tags: ["condensed", "bold", "hand-painted", "signage", "tall ascenders", "headline", "vernacular"] },
  "roubaix-industrielle": {
    // Caps only, striped, built from modular blocks: a display face, not a text sans.
    category: "display",
    tags: ["modular", "brick", "striped", "industrial", "geometric", "textile", "blocky", "caps"],
    skipPaths: [
      {
        re: /(^|\/)Multi\//,
        reason: "the Multi letter-height versions are print-only by the designer's note and have no web files; the Regular stays",
      },
    ],
  },
  pescante: { category: "sans", tags: ["curveless", "angular", "flat brush", "vernacular", "geometric", "signage", "wide stems"] },
  teranoptia: { category: "display", tags: [], skip: "creature-part glyphs for building chimeras, not letters" },
  isenheim: { category: "serif", tags: ["medieval", "old-style", "calligraphic", "ligatures", "lombardic", "elegant", "classical"] },
  picaflor: { category: "serif", tags: ["didone", "high-contrast", "calligraphic", "condensed", "vernacular", "elegant", "editorial", "caps"] },
  malebolge: { category: "display", tags: ["medieval", "dark", "spiky", "gothic", "caps", "metal", "ornate"] },
  paysage: { category: "sans", tags: ["humanist", "calm", "readable", "swinging g", "friendly", "text"] },
  manosque: { category: "handwriting", tags: ["brush", "sign painting", "heavy", "retro", "flat brush", "railway", "french"] },
  kobata: { category: "sans", tags: ["geometric", "pixel", "glitch", "experimental", "rectangles", "circles", "modular"] },
  brassia: { category: "display", tags: ["art nouveau", "solarpunk", "art deco", "organic", "caps", "decorative", "cyrillic-inspired"] },
};

// ---------------------------------------------------------------------------------------------------
// The homepage

interface Card {
  slug: string;
  name: string;
  download?: string;
  license: string;
}

async function homepage(log: (msg: string) => void): Promise<string> {
  let cachedAge = Infinity;
  try {
    cachedAge = Date.now() - (await stat(HOME_CACHE)).mtimeMs;
  } catch {
    // no cached copy yet
  }
  if (cachedAge < HOME_MAX_AGE_MS) {
    log(`homepage from cache (${(cachedAge / 3600_000).toFixed(1)} h old)`);
    return readFile(HOME_CACHE, "utf8");
  }
  try {
    log(`fetching ${HOME_URL} (the one tunera.xyz request of this run)`);
    const html = await fetchText(HOME_URL);
    await mkdir(CACHE, { recursive: true });
    await writeFile(HOME_CACHE, html);
    return html;
  } catch (err) {
    if (cachedAge === Infinity) throw err;
    log(`homepage fetch failed (${err instanceof Error ? err.message : err}); using the stale cached copy`);
    return readFile(HOME_CACHE, "utf8");
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseCards(html: string): Card[] {
  const cards: Card[] = [];
  for (const chunk of html.split(/<div class=['"]grid typeface /).slice(1)) {
    const head = chunk.match(/<h2 class=['"]fontname[^'"]*['"]>\s*<a href=['"]\/fonts\/([^/'"]+)\/?['"]>([^<]+)<\/a>/i);
    if (!head) continue;
    const download = [...chunk.matchAll(/href=['"](https?:\/\/[^'"]+)['"]/g)]
      .map((m) => m[1])
      .find((u) => parseRepo(u) !== null);
    const licenseText = chunk.match(/Learn more about ([^<]*Licen[cs]e[^<]*)<\/a>/i)?.[1] ?? "";
    cards.push({ slug: head[1], name: decodeEntities(head[2]), download, license: licenseLabel(licenseText) });
  }
  return cards;
}

function licenseLabel(text: string): string {
  if (/open font licen[cs]e|\bofl\b/i.test(text)) return "OFL";
  if (/apache/i.test(text)) return "Apache";
  if (/\bmit\b/i.test(text)) return "MIT";
  if (/cc0|public domain/i.test(text)) return "CC0";
  if (/creative commons|cc[ -]by/i.test(text)) return "CC BY";
  // Every Tunera family is OFL; the site states it on every card and in its FAQ.
  return text.trim() || "OFL";
}

// ---------------------------------------------------------------------------------------------------
// Repositories

type Host = "codeberg" | "gitlab" | "github";

interface Repo {
  host: Host;
  /** "owner/name" (a GitLab path may hold subgroups). */
  project: string;
  ref: string;
}

interface RepoFile {
  path: string;
  /** Blob hash from the listing, used as a cache key for the downloaded file. */
  sha?: string;
}

interface RepoListing {
  files: RepoFile[];
  added?: string;
  topics: string[];
  hasMetadata: boolean;
}

function parseRepo(href: string): Repo | null {
  let m = href.match(/^https?:\/\/codeberg\.org\/([^/]+\/[^/]+)\/archive\/([^/]+?)\.(?:zip|tar\.gz)$/i);
  if (m) return { host: "codeberg", project: m[1], ref: m[2] };
  m = href.match(/^https?:\/\/gitlab\.com\/(.+?)\/-\/archive\/([^/]+)\//i);
  if (m) return { host: "gitlab", project: m[1], ref: m[2] };
  m = href.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/(?:refs\/heads\/)?([^/]+?)\.(?:zip|tar\.gz)$/i);
  if (m) return { host: "github", project: m[1], ref: m[2] };
  return null;
}

const isFontPath = (p: string) => new RegExp(`\\.(${FONT_EXT.join("|")})$`, "i").test(p);
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** The URL the app's server fetches: the hosts' API raw endpoints or jsDelivr (all send CORS headers). */
function rawUrl(repo: Repo, filePath: string): string {
  const ref = encodeURIComponent(repo.ref);
  switch (repo.host) {
    case "codeberg":
      return `https://codeberg.org/api/v1/repos/${repo.project}/raw/${encPath(filePath)}?ref=${ref}`;
    case "gitlab":
      return `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.project)}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${ref}`;
    case "github":
      return `https://cdn.jsdelivr.net/gh/${repo.project}@${repo.ref}/${encPath(filePath)}`;
  }
}

function repoPage(repo: Repo): string {
  return repo.host === "codeberg"
    ? `https://codeberg.org/${repo.project}`
    : repo.host === "gitlab"
      ? `https://gitlab.com/${repo.project}`
      : `https://github.com/${repo.project}`;
}

/** The earlier of several ISO timestamps, as YYYY-MM-DD. */
function earliestDate(...stamps: (string | undefined)[]): string | undefined {
  const times = stamps.map((s) => (s ? Date.parse(s) : NaN)).filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)).toISOString().slice(0, 10) : undefined;
}

async function listCodeberg(repo: Repo): Promise<RepoListing> {
  const base = `https://codeberg.org/api/v1/repos/${repo.project}`;
  const ref = encodeURIComponent(repo.ref);
  const info = await fetchJson<{ created_at?: string; topics?: string[] }>(base);
  const top = await fetchJson<{ name: string; path: string; type: string; sha: string }[]>(`${base}/contents?ref=${ref}`);
  const files: RepoFile[] = [];
  for (const entry of top) {
    if (entry.type === "file" && isFontPath(entry.path)) files.push({ path: entry.path, sha: entry.sha });
    // Start from the font folders: the sources/ trees run to thousands of entries.
    if (entry.type !== "dir" || !/font/i.test(entry.name)) continue;
    for (let page = 1; page <= 50; page++) {
      const tree = await fetchJson<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>(
        `${base}/git/trees/${entry.sha}?recursive=true&per_page=1000&page=${page}`,
      );
      for (const blob of tree.tree) {
        if (blob.type === "blob" && isFontPath(blob.path)) files.push({ path: `${entry.path}/${blob.path}`, sha: blob.sha });
      }
      if (!tree.truncated) break;
    }
  }
  // Repositories moved to Codeberg in 2025 keep their history, so the oldest commit dates the family
  // better than the repository's creation date. Two cheap requests: the count, then the last page.
  let firstCommit: string | undefined;
  try {
    const url = `${base}/commits?sha=${ref}&limit=1&stat=false&verification=false&files=false`;
    const res = await fetchOk(url);
    const total = Number(res.headers.get("x-total-count") ?? 0);
    type Commit = { commit?: { author?: { date?: string } } };
    let commits = (await res.json()) as Commit[];
    if (total > 1) commits = await fetchJson<Commit[]>(`${url}&page=${total}`);
    firstCommit = commits[0]?.commit?.author?.date;
  } catch {
    // the date is optional
  }
  return {
    files,
    added: earliestDate(info.created_at, firstCommit),
    topics: info.topics ?? [],
    hasMetadata: top.some((e) => e.type === "file" && e.name === "METADATA.yml"),
  };
}

async function listGitlab(repo: Repo): Promise<RepoListing> {
  const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.project)}`;
  const ref = encodeURIComponent(repo.ref);
  const info = await fetchJson<{ created_at?: string; topics?: string[] }>(base);
  type Entry = { name: string; path: string; type: string; id: string };
  const tree = async (query: string): Promise<Entry[]> => {
    const all: Entry[] = [];
    for (let page = 1; page <= 50; page++) {
      const res = await fetchOk(`${base}/repository/tree?ref=${ref}&per_page=100&page=${page}${query}`);
      all.push(...((await res.json()) as Entry[]));
      if (!res.headers.get("x-next-page")) break;
    }
    return all;
  };
  const top = await tree("");
  const files: RepoFile[] = top.filter((e) => e.type === "blob" && isFontPath(e.path)).map((e) => ({ path: e.path, sha: e.id }));
  for (const dir of top.filter((e) => e.type === "tree" && /font/i.test(e.name))) {
    for (const e of await tree(`&recursive=true&path=${encodeURIComponent(dir.path)}`)) {
      if (e.type === "blob" && isFontPath(e.path)) files.push({ path: e.path, sha: e.id });
    }
  }
  return {
    files,
    added: earliestDate(info.created_at),
    topics: info.topics ?? [],
    hasMetadata: top.some((e) => e.type === "blob" && e.name === "METADATA.yml"),
  };
}

async function listGithub(repo: Repo): Promise<RepoListing> {
  const listing = await fetchJson<{ files: { name: string; hash?: string }[] }>(
    `https://data.jsdelivr.com/v1/packages/gh/${repo.project}@${repo.ref}?structure=flat`,
  );
  const all = listing.files.map((f) => ({ path: f.name.replace(/^\//, ""), sha: f.hash }));
  const files = all.filter((f) => isFontPath(f.path) && /font/i.test(f.path.split("/")[0]));
  // One unauthenticated GitHub call for the creation date (60 an hour are allowed); optional.
  let created: string | undefined;
  let topics: string[] = [];
  try {
    const info = await fetchJson<{ created_at?: string; topics?: string[] }>(`https://api.github.com/repos/${repo.project}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    created = info.created_at;
    topics = info.topics ?? [];
  } catch {
    // rate-limited or offline: no date
  }
  return { files, added: earliestDate(created), topics, hasMetadata: all.some((f) => f.path === "METADATA.yml") };
}

function listRepo(repo: Repo): Promise<RepoListing> {
  return repo.host === "codeberg" ? listCodeberg(repo) : repo.host === "gitlab" ? listGitlab(repo) : listGithub(repo);
}

/** Tags from the repository's METADATA.yml (Unified Font Repository format). Only for unknown families. */
async function metadataTags(repo: Repo): Promise<string[]> {
  try {
    const doc = loadYaml(await fetchText(rawUrl(repo, "METADATA.yml"))) as Record<string, unknown> | null;
    const family = doc?.["typeface family"] as { tags?: unknown } | undefined;
    return Array.isArray(family?.tags) ? family.tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------
// Font files

/** Downloads a font file once; later runs read it from server/.cache/tunera/files/. */
async function fontBytes(url: string, sha?: string): Promise<Buffer> {
  const key = createHash("sha1").update(`${url}|${sha ?? ""}`).digest("hex").slice(0, 24);
  const file = path.join(CACHE, "files", key);
  try {
    return await readFile(file);
  } catch {
    // not cached yet
  }
  const buffer = await fetchBuffer(url);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  await sleep(150);
  return buffer;
}

/** The wght axis range of a variable font, if it has one. */
function wghtAxis(buffer: Buffer): { min: number; max: number } | null {
  const font = fontkit.create(buffer) as fontkit.Font;
  const axes = (font as unknown as { variationAxes?: Record<string, { min: number; max: number }> }).variationAxes ?? {};
  return axes.wght ? { min: axes.wght.min, max: axes.wght.max } : null;
}

// ---------------------------------------------------------------------------------------------------
// Styles → rows

interface Face {
  stem: string;
  /** The style part of the file name: "72-96Banner", "NeonTube", "Fin". */
  style: string;
  file: RepoFile;
  variable: boolean;
}

interface Optical {
  size: number;
  kind: "numeric" | "named";
  /** The style without the size part. */
  rest: string;
}

interface Candidate {
  face: Face;
  url: string;
  info: FontFileInfo;
  /** Style left once the optical size is set aside; weight words and the variant name live here. */
  label: string;
  /** Set for a variable font: its wght range, which covers several weights with one file. */
  axis?: { min: number; max: number } | null;
}

const NAMED_SIZES = [
  "micro", "caption", "small", "chica", "text", "subtitle", "subhead", "mediana", "deck",
  "title", "header", "headline", "display", "grande", "banner", "poster",
];
const WEIGHT_WORDS = new Set([
  "thin", "hairline", "extra", "ultra", "semi", "demi", "light", "fin", "fine", "book", "regular",
  "regulier", "régulier", "normal", "roman", "plain", "medium", "mittel", "bold", "gras", "black",
  "heavy", "dark", "fett", "satt", "extralight", "ultralight", "semibold", "demibold", "extrabold",
  "ultrabold",
]);
const REGULAR_LIKE = /^(regular|regulier|régulier|normal|book|roman|plain)$/i;

const tokens = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_\-]+/)
    .filter(Boolean);

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** "Luperca-72-96Banner" with family "Luperca" → "72-96Banner". */
function styleOf(stem: string, family: string): string {
  const fam = slugify(family).replace(/-/g, "");
  let i = 0;
  let j = 0;
  while (i < stem.length && j < fam.length) {
    const c = stem[i].toLowerCase();
    if (!/[a-z0-9]/.test(c)) {
      i++;
      continue;
    }
    if (c !== fam[j]) break;
    i++;
    j++;
  }
  const rest = j === fam.length ? stem.slice(i) : stem.replace(/^[^-_]*[-_]?/, "");
  return rest.replace(/^[-_\s]+/, "").trim();
}

function opticalOf(style: string): Optical | null {
  // "96pt", "Regular60-96pt"
  let m = style.match(/(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*pt/i);
  if (m) return { size: Math.max(Number(m[1]), Number(m[2] ?? 0)), kind: "numeric", rest: cut(style, m) };
  // "72-96Banner"
  m = style.match(/(\d{1,3})\s*-\s*(\d{1,3})\s*([A-Za-z]+)?/);
  if (m && (!m[3] || NAMED_SIZES.includes(m[3].toLowerCase()))) {
    return { size: Math.max(Number(m[1]), Number(m[2])), kind: "numeric", rest: cut(style, m) };
  }
  // "Grande", "Caption"
  const parts = tokens(style);
  const hit = parts.findIndex((t) => NAMED_SIZES.includes(t.toLowerCase()));
  if (hit >= 0) {
    return { size: NAMED_SIZES.indexOf(parts[hit].toLowerCase()), kind: "named", rest: parts.filter((_, k) => k !== hit).join(" ") };
  }
  return null;
}

function cut(s: string, m: RegExpMatchArray): string {
  return (s.slice(0, m.index) + s.slice((m.index ?? 0) + m[0].length)).replace(/^[-_\s]+|[-_\s]+$/g, "");
}

const variantOf = (label: string) =>
  tokens(label)
    .filter((t) => !WEIGHT_WORDS.has(t.toLowerCase()))
    .join(" ");

/** A slanted style read as its upright's: "BoldItalic" → "Bold", "72-96BannerItalic" → "72-96Banner". */
const unslant = (style: string) => style.replace(/[-_\s]?(?:italic|oblique|slanted|slant)/gi, "").trim();

/**
 * Static faces → rows keyed by variant ("" for the plain family). Optical sizes of one design: keep the
 * largest. Named sizes whose files carry different weights are really weights (Canarina's Chica/Mediana/
 * Grande are 400/500/800), so those stay. Weight words stay inside a row.
 */
function variantRows(statics: Candidate[], notes: string[]): Map<string, Candidate[]> {
  const kept: Candidate[] = [];
  const groups = new Map<string, { c: Candidate; o: Optical }[]>();
  for (const c of statics) {
    const o = opticalOf(c.face.style);
    if (!o) {
      kept.push(c);
      continue;
    }
    const key = slugify(o.rest);
    groups.set(key, [...(groups.get(key) ?? []), { c, o }]);
  }
  for (const group of groups.values()) {
    const weights = new Set(group.map((g) => g.c.info.weight));
    const namedWeights = group.length > 1 && group.every((g) => g.o.kind === "named") && weights.size === group.length;
    if (namedWeights) {
      notes.push(`${group.map((g) => `${g.c.face.style} ${g.c.info.weight}`).join(", ")} kept as weights`);
      for (const g of group) kept.push({ ...g.c, label: g.o.rest });
      continue;
    }
    const best = group.reduce((a, b) => (b.o.size > a.o.size ? b : a));
    if (group.length > 1) notes.push(`kept ${best.c.face.style} of ${group.length} optical sizes`);
    kept.push({ ...best.c, label: best.o.rest });
  }

  const byVariant = new Map<string, Candidate[]>();
  for (const c of kept) {
    const v = variantOf(c.label);
    byVariant.set(v, [...(byVariant.get(v) ?? []), c]);
  }
  return byVariant;
}

/** Weight → URL for one row's faces (its uprights, or its italics); a variable file covers its wght range. */
function filesByWeight(cands: Candidate[], notes: string[]): Record<number, string> {
  const files: Record<number, string> = {};
  const label: Record<number, string> = {};
  for (const c of cands) {
    const axis = c.axis;
    const weights = axis
      ? Array.from({ length: 9 }, (_, k) => (k + 1) * 100).filter((w) => w >= axis.min && w <= axis.max)
      : [c.info.weight];
    for (const w of weights) {
      if (files[w]) {
        // Two files on one weight: keep the Regular-like one.
        const regularNow = tokens(c.label).some((t) => REGULAR_LIKE.test(t)) || !c.label;
        const regularBefore = tokens(label[w]).some((t) => REGULAR_LIKE.test(t)) || !label[w];
        notes.push(`${c.face.stem} and ${label[w] || "another face"} both at ${w}`);
        if (!regularNow || regularBefore) continue;
      }
      files[w] = c.url;
      label[w] = c.label;
    }
  }
  return files;
}

/** One family card → zero or more rows. */
async function familyRows(card: Card, log: (msg: string) => void): Promise<FontEntry[]> {
  const hints = HINTS[card.slug];
  if (hints?.skip) {
    log(`skip ${card.name}: ${hints.skip}`);
    return [];
  }
  const repo = card.download ? parseRepo(card.download) : null;
  if (!repo) {
    log(`skip ${card.name}: no repository link on its card`);
    return [];
  }
  const listing = await listRepo(repo);
  const notes: string[] = [];

  // Leave out folders that hold other designs.
  let files = listing.files.filter((f) => !/(^|\/)(sources?|documentation|specimens?)\//i.test(f.path));
  for (const { re, reason } of hints?.skipPaths ?? []) {
    const dropped = new Set(files.filter((f) => re.test(f.path)).map((f) => path.posix.basename(f.path).replace(/\.[^.]+$/, "")));
    if (dropped.size) {
      log(`skip ${dropped.size} ${card.name} faces: ${reason}`);
      files = files.filter((f) => !re.test(f.path));
    }
  }

  // One face per file stem, in the best available format.
  const byStem = new Map<string, RepoFile[]>();
  for (const f of files) {
    const stem = path.posix.basename(f.path).replace(/\.[^.]+$/, "");
    byStem.set(stem, [...(byStem.get(stem) ?? []), f]);
  }
  const faces: Face[] = [...byStem].map(([stem, list]) => {
    const rank = (f: RepoFile) => FONT_EXT.indexOf(f.path.split(".").pop()!.toLowerCase());
    const file = [...list].sort((a, b) => rank(a) - rank(b))[0];
    const variable = /variable/i.test(path.posix.dirname(file.path)) || /(VF|GX|Variable)$/i.test(stem);
    return { stem, style: styleOf(stem, card.name), file, variable };
  });

  // Upright static faces, with their real weights read from the files. Slanted ones (by name, or by the
  // file's own flag) are set aside as the italics.
  const slanted = /italic|oblique|slant/i;
  const statics: Candidate[] = [];
  const slantedStatics: Face[] = [];
  for (const face of faces.filter((f) => !f.variable)) {
    if (slanted.test(face.style)) {
      slantedStatics.push(face);
      continue;
    }
    const url = rawUrl(repo, face.file.path);
    const info = readFontInfo(await fontBytes(url, face.file.sha));
    if (info.italic) {
      slantedStatics.push(face);
      continue;
    }
    statics.push({ face, url, info, label: face.style });
  }

  // Named variants become rows; weight words stay inside a row.
  const byVariant = variantRows(statics, notes);
  const single = byVariant.size === 1;

  // No upright static faces at all: fall back to a variable font.
  if (!byVariant.size) {
    const vf = faces.find((f) => f.variable && !slanted.test(f.style));
    if (vf) {
      const url = rawUrl(repo, vf.file.path);
      const buffer = await fontBytes(url, vf.file.sha);
      const axis = wghtAxis(buffer);
      byVariant.set("", [{ face: vf, url, info: readFontInfo(buffer), label: "", axis }]);
      notes.push(axis ? `variable ${vf.stem} covers ${axis.min}-${axis.max}` : `variable ${vf.stem} without a wght axis`);
    }
  }

  // No upright style at all (italic or slanted only): one slanted file stands in as weight 400, and the
  // row says so with the tag "italic only". The Regular-like face wins, then the one nearest to 400.
  let italicOnly = false;
  if (!byVariant.size) {
    const pool = slantedStatics.length ? slantedStatics : faces.filter((f) => f.variable && slanted.test(f.style));
    const distance = (f: Face) => {
      const words = tokens(f.style).filter((t) => !slanted.test(t));
      return words.length === 0 || words.some((t) => REGULAR_LIKE.test(t)) ? -1 : Math.abs(weightFromStyleName(f.style) - 400);
    };
    const pick = [...pool].sort((a, b) => distance(a) - distance(b) || a.stem.localeCompare(b.stem))[0];
    if (pick) {
      const url = rawUrl(repo, pick.file.path);
      const info = readFontInfo(await fontBytes(url, pick.file.sha));
      byVariant.set("", [{ face: pick, url, info: { ...info, weight: 400 }, label: "" }]);
      italicOnly = true;
      notes.push(`no upright style: slanted ${pick.stem} used as 400`);
    }
  }

  // The italics go through the same steps as the uprights, read under the name their upright would have
  // ("72-96BannerItalic" → "72-96Banner"), and join the row with the same variant. In a family of one row,
  // every italic is that row's. A variable italic stands in only when there is no static one.
  const italicsByVariant = new Map<string, Candidate[]>();
  if (!italicOnly && byVariant.size) {
    const italicCands: Candidate[] = [];
    // An italic that fails to load is left out; it never takes the family's uprights down with it.
    const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
    for (const face of slantedStatics) {
      const url = rawUrl(repo, face.file.path);
      try {
        const info = readFontInfo(await fontBytes(url, face.file.sha));
        const style = unslant(face.style);
        italicCands.push({ face: { ...face, style }, url, info, label: style });
      } catch (err) {
        notes.push(`italic ${face.stem} left out (${why(err)})`);
      }
    }
    const italicRows = variantRows(italicCands, notes);
    const vf = italicRows.size ? undefined : faces.find((f) => f.variable && slanted.test(f.style));
    if (vf) {
      const url = rawUrl(repo, vf.file.path);
      try {
        const buffer = await fontBytes(url, vf.file.sha);
        italicRows.set("", [{ face: vf, url, info: readFontInfo(buffer), label: "", axis: wghtAxis(buffer) }]);
      } catch (err) {
        notes.push(`variable italic ${vf.stem} left out (${why(err)})`);
      }
    }
    const strays: string[] = [];
    for (const [variant, cands] of italicRows) {
      const row = byVariant.has(variant) ? variant : single ? [...byVariant.keys()][0] : undefined;
      if (row === undefined) strays.push(...cands.map((c) => c.face.stem));
      else italicsByVariant.set(row, [...(italicsByVariant.get(row) ?? []), ...cands]);
    }
    if (strays.length) notes.push(`italics with no upright row left out: ${strays.join(", ")}`);
  }

  const tags = await tagsFor(card, repo, listing, hints);
  const rows: FontEntry[] = [];
  for (const [variant, cands] of [...byVariant].sort(([a], [b]) => a.localeCompare(b))) {
    const files = filesByWeight(cands, notes);
    const weights = Object.keys(files)
      .map(Number)
      .sort((a, b) => a - b);
    if (!weights.length) continue;
    const italics = italicsByVariant.get(variant);
    // An italic-only row's one file is its italic too, so an Italic switch shows the same face.
    const italicFiles = italicOnly ? files : italics ? filesByWeight(italics, notes) : {};
    const isVariantRow = !single && variant !== "";
    const extra = isVariantRow ? (hints?.variantTags?.[variant] ?? []) : [];
    rows.push({
      id: isVariantRow ? `${SOURCE}:${card.slug}:${slugify(variant)}` : `${SOURCE}:${card.slug}`,
      family: isVariantRow ? `${card.name} ${variant}` : card.name,
      source: SOURCE,
      category: hints?.category ?? categoryFromTags(tags, "display"),
      tags: [...new Set([...(italicOnly ? ["italic only"] : []), ...extra, ...tags])].slice(0, 8),
      weights,
      license: card.license,
      files,
      ...(Object.keys(italicFiles).length ? { italicFiles } : {}),
      homepage: `https://www.tunera.xyz/fonts/${card.slug}/`,
      ...(listing.added ? { added: listing.added } : {}),
      proxy: true,
    });
  }

  const summary =
    rows
      .map((r) => `${r.family} [${r.weights.join(",")}]${r.italicFiles && !italicOnly ? ` italic [${Object.keys(r.italicFiles).join(",")}]` : ""}`)
      .join("; ") || "no rows";
  log(`${card.name} (${repo.host} ${repo.project}): ${summary}${notes.length ? ` (${notes.join("; ")})` : ""}`);
  if (!rows.length) log(`skip ${card.name}: no usable upright font files in ${repoPage(repo)}`);
  return rows;
}

const GENERIC_TAG = /^(font|fonts|typeface|typefaces|typography|type ?design|typedesign|free|free ?font|open-?source.*|libre|assets|tipograf[ií]a)$/i;

async function tagsFor(card: Card, repo: Repo, listing: RepoListing, hints: FamilyHints | undefined): Promise<string[]> {
  if (hints?.tags.length) return hints.tags.slice(0, 8);
  const fromMetadata = listing.hasMetadata ? await metadataTags(repo) : [];
  const name = card.name.toLowerCase();
  const tags = [...fromMetadata, ...listing.topics]
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t && !GENERIC_TAG.test(t) && !t.includes(name) && !t.includes("tunera"));
  return [...new Set(tags)].slice(0, 8);
}

// ---------------------------------------------------------------------------------------------------

export const builder: SourceBuilder = {
  async build(log) {
    const cards = parseCards(await homepage(log));
    log(`${cards.length} families on the homepage`);
    if (!cards.length) throw new Error("no family cards found on the Tunera homepage (markup changed?)");
    const rows: FontEntry[] = [];
    for (const card of cards) {
      try {
        rows.push(...(await familyRows(card, log)));
      } catch (err) {
        log(`FAILED ${card.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ids = new Set<string>();
    for (const r of rows) {
      if (ids.has(r.id)) throw new Error(`duplicate id ${r.id}`);
      ids.add(r.id);
    }
    return rows;
  },
};
