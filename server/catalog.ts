import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExcludedFamily } from "../src/exclude.ts";
import type { Category, FontEntry, Source } from "../src/types.ts";

const FONTSOURCE_URL = "https://api.fontsource.org/v1/fonts";
const FONTSHARE_URL = "https://api.fontshare.com/v2/fonts";
// Popularity rank and stroke. This endpoint carries no mood tags.
const GF_METADATA_URL = "https://fonts.google.com/metadata/fonts";
// The mood/classification tags fonts.google.com shows ("Futuristic", "Techno", "Geometric").
const GF_TAGS_URL = "https://raw.githubusercontent.com/google/fonts/main/tags/all/families.csv";

const TTL_MS = 24 * 60 * 60 * 1000;
const here = path.dirname(fileURLToPath(import.meta.url));
// Fontsource + Fontshare, refetched daily. Bump the version when the rules change, so an old cache is not served.
const REMOTE_CACHE_FILE = path.join(here, ".cache", "remote-v9.json");
// The indie sources' saved catalogs, written by `npm run sources`.
const DATA_DIR = path.join(here, "data");

interface Cached {
  at: number;
  fonts: FontEntry[];
}

/** Bump when the merge or exclusion rules change, so browsers replace their saved copy. */
const RULES_VERSION = 7;
/** After a failed or partial refetch, keep serving what we have and try again this much later. */
const RETRY_MS = 10 * 60 * 1000;

export interface Catalog extends Cached {
  /** Changes whenever the remote fetch or a saved source changes, so the browser knows to replace its copy. */
  version: string;
}

let memory: (Cached & { validUntil: number }) | null = null;
let inflight: Promise<Cached> | null = null;

/**
 * How the remote lists came to be, for the online export, which must not publish part of a catalog:
 * `requests` counts the list downloads this process made, and `partial` is true while what is served
 * is only what did arrive (a refetch fell short, and there was no saved copy to fall back on).
 */
export const remoteStatus = { requests: 0, partial: false };
let merged: { key: string; catalog: Catalog } | null = null;

export async function getCatalog(refresh = false): Promise<Catalog> {
  const { remote, seeds } = await loadParts(refresh);
  const key = `${RULES_VERSION}|${remote.at}|${seeds.key}`;
  if (merged?.key !== key) {
    const fonts = mergeSources([remote.fonts, ...seeds.lists]);
    merged = { key, catalog: { at: remote.at, version: shortHash(key), fonts } };
    const bySource = new Map<string, [number, number]>();
    for (const f of fonts) {
      const [n, italic] = bySource.get(f.source) ?? [0, 0];
      bySource.set(f.source, [n + 1, italic + (f.italicWeights?.length || Object.keys(f.italicFiles ?? {}).length ? 1 : 0)]);
    }
    const borrowed = fonts.filter((f) => f.italicFrom).map((f) => `${f.family} (from ${f.italicFrom})`);
    console.log(
      `[catalog] ${fonts.length} fonts: ${[...bySource].map(([k, [n, italic]]) => `${k} ${n} (${italic} with italics)`).join(", ")}` +
        (borrowed.length ? `; italics borrowed: ${borrowed.join(", ")}` : ""),
    );
  }
  return merged.catalog;
}

/**
 * The lists the catalog is merged from, before merging: the remote sources, then each saved indie
 * catalog. check:italics compares merged rows against them.
 */
export async function getSourceLists(): Promise<FontEntry[][]> {
  const { remote, seeds } = await loadParts(false);
  return [remote.fonts, ...seeds.lists];
}

async function loadParts(refresh: boolean) {
  const remote = await getRemote(refresh);
  const seeds = await loadSeeds();
  return { remote, seeds };
}

/**
 * Fontsource + Fontshare + Google metadata, refetched daily. A refetch is only saved when every part
 * succeeded; otherwise the last good copy keeps being served (even past its day) and we retry later.
 */
async function getRemote(refresh: boolean): Promise<Cached> {
  if (!refresh && memory && Date.now() < memory.validUntil) return memory;
  if (!memory) {
    try {
      const disk = JSON.parse(await readFile(REMOTE_CACHE_FILE, "utf8")) as Cached;
      memory = { ...disk, validUntil: disk.at + TTL_MS };
      if (!refresh && Date.now() < memory.validUntil) return memory;
    } catch {
      // no saved copy yet
    }
  }
  inflight ??= refetch().finally(() => (inflight = null));
  return inflight;
}

async function refetch(): Promise<Cached> {
  let built: { result: Cached; complete: boolean } | null = null;
  try {
    built = await build();
  } catch (err) {
    console.warn("[catalog] refetch failed:", err instanceof Error ? err.message : err);
  }
  if (built?.complete) {
    await mkdir(path.dirname(REMOTE_CACHE_FILE), { recursive: true });
    await writeFile(REMOTE_CACHE_FILE, JSON.stringify(built.result));
    memory = { ...built.result, validUntil: built.result.at + TTL_MS };
    remoteStatus.partial = false;
    return memory;
  }
  // A last good copy is whole, only older; without one, what is served now is missing a part.
  if (!memory) remoteStatus.partial = true;
  const fallback = memory ?? (built?.result.fonts.length ? built.result : null);
  console.warn(
    `[catalog] refetch incomplete; serving ${memory ? "the last good copy" : "what did arrive"}, retrying in ${RETRY_MS / 60000} min`,
  );
  // Keep the same `at`, so the version stays put and browsers do not swap in a shorter list each time.
  memory = { ...(fallback ?? { at: 0, fonts: [] }), validUntil: Date.now() + RETRY_MS };
  return memory;
}

let seedMemo: { key: string; lists: FontEntry[][] } | null = null;

async function loadSeeds(): Promise<{ key: string; lists: FontEntry[][] }> {
  const names = (await readdir(DATA_DIR).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  const stamps = await Promise.all(names.map(async (n) => `${n}:${(await stat(path.join(DATA_DIR, n))).mtimeMs}`));
  const key = stamps.join(",");
  if (seedMemo?.key === key) return seedMemo;
  const lists: FontEntry[][] = [];
  for (const n of names) {
    try {
      const { fonts } = JSON.parse(await readFile(path.join(DATA_DIR, n), "utf8")) as { fonts: FontEntry[] };
      const ok = fonts.filter(
        (f) =>
          typeof f?.family === "string" &&
          PRIORITY.includes(f.source) &&
          Array.isArray(f.tags) &&
          Array.isArray(f.weights) &&
          f.weights.length > 0 &&
          f.files &&
          typeof f.files === "object" &&
          Object.keys(f.files).length > 0 &&
          (f.italicFiles === undefined || (typeof f.italicFiles === "object" && f.italicFiles !== null)),
      );
      if (ok.length < fonts.length) console.warn(`[catalog] server/data/${n}: dropped ${fonts.length - ok.length} malformed rows`);
      lists.push(ok);
    } catch (err) {
      console.warn(`[catalog] skipping server/data/${n}:`, err instanceof Error ? err.message : err);
    }
  }
  return (seedMemo = { key, lists });
}

// When one family comes from several places, one row survives and the others hand over their tags,
// popularity, date and source names (alsoOn). The libre foundries' own releases win. Google beats
// Fontshare, because Fontshare re-hosts 35 Google families (Poppins, Montserrat, Space Grotesk...),
// which would otherwise pass as indie. Use & Modify is a curated list, so it yields to everyone.
//
// Italics: a surviving row with an italic of its own keeps it and never takes another source's, since
// those files can be a different release of the design. A surviving row with none borrows one from a
// dropped row that has it (Google's Sora has no italic, Fontshare's does), so the Italic switch draws
// a real italic instead of a 'no italic' badge. Only the italic is borrowed: the row's own upright
// files, weights and loading rule stay as they were. check:italics compares the two files' heights.
// A height mismatch is reported, not a reason to drop the borrow. Syne is the open case: its italic
// (Use & Modify, v1.000, the only Syne italic there is) is a calligraphic hand with an x-height 6.8%
// taller than Google's geometric upright (v2.200), so next to it the italic can read as another
// typeface. It is kept until Wouter decides; dropping it is one skip in the donors loop below, plus a
// RULES_VERSION bump.
const PRIORITY: Source[] = ["velvetyne", "collletttivo", "tunera", "fontsource", "fontshare", "usemodify"];

export function mergeSources(lists: FontEntry[][]): FontEntry[] {
  const all = lists
    .flat()
    .filter((f) => !isExcludedFamily(f.family))
    .map((f, i) => ({ f, i, p: PRIORITY.indexOf(f.source) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(({ f }) => f);
  const winners = new Map<string, FontEntry>();
  /** Per surviving row without an italic: the dropped rows that have one, in priority order. */
  const donors = new Map<FontEntry, FontEntry[]>();
  const out: FontEntry[] = [];
  for (const f of all) {
    const key = f.family.toLowerCase().replace(/[^a-z0-9]/g, "");
    const winner = winners.get(key);
    if (!winner) {
      const copy = { ...f, tags: [...f.tags] };
      winners.set(key, copy);
      out.push(copy);
      continue;
    }
    winner.tags = [...new Set([...winner.tags, ...f.tags])].slice(0, 10);
    winner.tagScores ??= f.tagScores;
    if (f.source !== winner.source && !winner.alsoOn?.includes(f.source)) winner.alsoOn = [...(winner.alsoOn ?? []), f.source];
    winner.rank ??= f.rank;
    winner.common ||= f.common;
    winner.added ??= f.added;
    if (!hasOwnItalic(winner) && borrowableItalic(f)) donors.set(winner, [...(donors.get(winner) ?? []), f]);
  }
  for (const [row, candidates] of donors) {
    const donor = bestDonor(row, candidates);
    const italicFiles = borrowableItalic(donor);
    if (!italicFiles) continue;
    row.italicFiles = italicFiles;
    // Explicit either way: the borrowed files follow the donor's loading rule, not the row's.
    row.italicProxy = Boolean(donor.proxy);
    row.italicFrom = donor.source;
  }
  return out;
}

function hasOwnItalic(f: FontEntry): boolean {
  return Boolean(f.italicWeights?.length || Object.keys(f.italicFiles ?? {}).length);
}

/**
 * A row's italic as files per weight, or null when it has none. A Fontsource row lists only weights
 * (its URLs are built from `ref`), so they are spelled out here, less the weights NOT_ITALIC and
 * NO_LATIN_FILE rule out.
 */
function borrowableItalic(f: FontEntry): Record<number, string> | null {
  if (f.source === "fontsource") {
    if (!f.ref || NO_LATIN_FILE.has(f.family)) return null;
    const weights = (f.italicWeights ?? []).filter((w) => !NOT_ITALIC[f.family]?.includes(w));
    if (!weights.length) return null;
    return Object.fromEntries(weights.map((w) => [w, `https://cdn.jsdelivr.net/fontsource/fonts/${f.ref}@latest/latin-${w}-italic.woff2`]));
  }
  return Object.keys(f.italicFiles ?? {}).length ? { ...f.italicFiles } : null;
}

/**
 * The donor most likely to be the same design: one spelled exactly like the row's family first, then
 * the one whose upright weights overlap the row's most, then the higher-priority source.
 */
function bestDonor(row: FontEntry, candidates: FontEntry[]): FontEntry {
  const overlap = (f: FontEntry) => f.weights.filter((w) => row.weights.includes(w)).length;
  return candidates
    .map((f, i) => ({ f, i, same: f.family === row.family ? 0 : 1, overlap: overlap(f) }))
    .sort((a, b) => a.same - b.same || b.overlap - a.overlap || a.i - b.i)[0].f;
}

function shortHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Fontsource weights whose italic file is not an italic, so they are not listed as one. Found on 2026-10-02 by
 * comparing every listed italic with its upright on the CDN and drawing the doubtful ones in WebKit; Google's
 * own families had none. Redaction's 700s and Clear Sans' 100 and 300 are the upright file byte for byte, so
 * the Italic switch would show the upright and call it italic. Open Sauce Sans' are Type 1 fonts under a
 * .woff2 name, which browsers refuse, so the card would fall back to another typeface.
 */
export const NOT_ITALIC: Record<string, number[]> = {
  Redaction: [700],
  "Redaction 10": [700],
  "Redaction 20": [700],
  "Redaction 35": [700],
  "Redaction 50": [700],
  "Redaction 70": [700],
  "Redaction 100": [700],
  "Clear Sans": [100, 300],
  "Open Sauce Sans": [400, 600, 900],
};

/**
 * Families Fontsource lists with a latin subset but serves no latin file for, upright or italic (only
 * its numbered CJK slices). Their cards cannot draw either way; listing no italic keeps them out of the
 * 'Has italic' filter. Found on 2026-10-02 by loading every 'Has italic' card in WebKit.
 * `npm run check:italics` re-tests this list and NOT_ITALIC.
 */
export const NO_LATIN_FILE = new Set(["Chiron Sung HK"]);

async function build(): Promise<{ result: Cached; complete: boolean }> {
  const started = Date.now();
  const [fontsource, fontshare, gfMeta, gfTags] = await Promise.all([
    fetchJson<FontsourceFont[]>(FONTSOURCE_URL),
    fetchJson<{ fonts: FontshareFont[] }>(FONTSHARE_URL),
    fetchJson<{ familyMetadataList: GfMeta[] }>(GF_METADATA_URL),
    fetchText(GF_TAGS_URL),
  ]);

  const meta = new Map((gfMeta?.familyMetadataList ?? []).map((m) => [m.family, m]));
  let italicFromMeta = 0;
  let italicAsListed = 0;
  const tags = gfTags ? parseGoogleTags(gfTags) : new Map<string, GoogleTags>();
  const fonts: FontEntry[] = [];

  for (const f of fontsource ?? []) {
    if (f.category === "icons" || !f.subsets.includes("latin") || !f.styles.includes("normal")) continue;
    if (isExcludedFamily(f.family)) continue;
    const m = meta.get(f.family);
    const extra = m?.stroke === "Slab Serif" ? ["Slab"] : [];
    const google = tags.get(f.family) ?? tags.get(RENAMED[f.family] ?? "");
    // Fontsource only says a family has italics, not at which weights, and its per-family API lists an italic
    // at every weight even where the CDN has none (Cardo 700). Google's metadata names each real style ("400i"),
    // so Google families take their italic weights from it. The few families Google does not list keep
    // Fontsource's weights (each one answered on the CDN when checked on 2026-10-02), less NOT_ITALIC's.
    let italicWeights: number[] = [];
    if (f.styles.includes("italic") && !NO_LATIN_FILE.has(f.family)) {
      if (m?.fonts) {
        italicWeights = f.weights.filter((w) => `${w}i` in m.fonts!);
        italicFromMeta++;
      } else if (f.type !== "google" || meta.size) {
        italicWeights = f.weights;
        italicAsListed++;
      }
      // Otherwise Google's metadata did not arrive, and Fontsource's own list would name italics that do
      // not exist: this build lists none for Google families. It is not saved, and the retry fills them in.
      italicWeights = italicWeights.filter((w) => !NOT_ITALIC[f.family]?.includes(w));
    }
    fonts.push({
      id: `fontsource:${f.id}`,
      family: f.family,
      source: "fontsource",
      category: FONTSOURCE_CATEGORY[f.category] ?? "other",
      tags: [...extra, ...(google?.tags ?? [])],
      ...(google && Object.keys(google.scores).length ? { tagScores: google.scores } : {}),
      weights: f.weights,
      ...(italicWeights.length ? { italicWeights } : {}),
      license: licenseLabel(f.license),
      cssUrl: `https://cdn.jsdelivr.net/npm/@fontsource/${f.id}@latest/index.css`,
      ref: f.id,
      rank: m?.popularity,
      common: (m?.popularity ?? 9999) <= 150,
      added: m?.dateAdded,
      homepage: f.type === "google" ? `https://fonts.google.com/specimen/${f.family.replace(/ /g, "+")}` : `https://fontsource.org/fonts/${f.id}`,
    });
  }

  const byViews = [...(fontshare?.fonts ?? [])].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  byViews.forEach((f, i) => {
    const files: Record<number, string> = {};
    const italicFiles: Record<number, string> = {};
    for (const s of f.styles) {
      if (s.is_variable) continue;
      if (s.is_italic) {
        // Fontshare numbers an italic one above its upright (Light Italic is 301); weight.weight is the real
        // weight. Only the standard weights, as for uprights (Pramukh Rounded's 350 is left out of both),
        // and only plain italics: a width cut's italic would be numbered otherwise (402), as its upright is.
        const w = s.weight.weight ?? s.weight.number - 1;
        if (w % 100 === 0 && s.weight.number === w + 1) italicFiles[w] = `https:${s.file}.woff2`;
        continue;
      }
      // Weights like 401 or 601 are Fontshare's numbering for width cuts (Array Wide), not weights.
      if (s.weight.number % 100 !== 0) continue;
      files[s.weight.number] = `https:${s.file}.woff2`;
    }
    const weights = Object.keys(files).map(Number).sort((a, b) => a - b);
    if (!weights.length || isExcludedFamily(f.name)) return;
    const [primary, ...rest] = f.category.split(",").map((c) => c.trim()).filter(Boolean);
    fonts.push({
      id: `fontshare:${f.slug}`,
      family: f.name,
      source: "fontshare",
      category: FONTSHARE_CATEGORY[primary] ?? "other",
      tags: [...(primary === "Slab" ? ["Slab"] : []), ...rest, ...f.font_tags.map((t) => t.name)].slice(0, 8),
      weights,
      license: f.license_type === "itf_ffl" ? "ITF free" : "OFL",
      cssUrl: `https://api.fontshare.com/v2/css?f[]=${f.slug}@${weights.join(",")}&display=swap`,
      files,
      ...(Object.keys(italicFiles).length ? { italicFiles } : {}),
      // Fontshare is small and hand-picked; spread it through the top of the popularity order.
      rank: i * 3,
      added: f.inserted_at?.slice(0, 10),
      homepage: `https://www.fontshare.com/fonts/${f.slug}`,
    });
  });

  const result = { at: Date.now(), fonts };
  console.log(
    `[catalog] built ${fonts.length} fonts in ${Date.now() - started} ms ` +
      `(fontsource ${fontsource?.length ?? "failed"}, fontshare ${fontshare?.fonts.length ?? "failed"}, ` +
      `google tags ${tags.size || "failed"}; fontsource italics: ${italicFromMeta} by Google's styles, ${italicAsListed} as listed)`,
  );
  return { result, complete: Boolean(fontsource?.length && fontshare?.fonts.length && gfMeta?.familyMetadataList.length && tags.size) };
}

/**
 * Fontsource still lists some Google families under a name Google has retired, and Google's tag file
 * only knows the new one (both rows are in the catalog). The old row borrows the new name's tags.
 * Checked against families.csv on 2026-10-03.
 */
const RENAMED: Record<string, string> = {
  "Arima Madurai": "Arima",
  "BBH Sans Bartle": "BBH Bartle",
  "BBH Sans Bogle": "BBH Bogle",
  "BBH Sans Hegarty": "BBH Hegarty",
  "Big Shoulders Display": "Big Shoulders",
  "Big Shoulders Text": "Big Shoulders",
  "Big Shoulders Inline Display": "Big Shoulders Inline",
  "Big Shoulders Inline Text": "Big Shoulders Inline",
  "Big Shoulders Stencil Display": "Big Shoulders Stencil",
  "Big Shoulders Stencil Text": "Big Shoulders Stencil",
  "Fredoka One": "Fredoka",
  "Gentium Book Basic": "Gentium Book Plus",
  "Merienda One": "Merienda",
  "Montserrat Subrayada": "Montserrat Underline",
  "Saira Stencil One": "Saira Stencil",
  "Source Sans Pro": "Source Sans 3",
  "Source Serif Pro": "Source Serif 4",
};

/** Google's tags for one family: labels strongest first, and the strength of the mood and theme ones. */
interface GoogleTags {
  tags: string[];
  scores: Record<string, number>;
}

/** Mood and theme tags come in strengths worth keeping (Active 89 against Active 41); the rest are classifications. */
const SCORED_GROUPS = new Set(["Expressive", "Theme"]);

/**
 * Rows look like `Orbitron,,/Theme/Techno,100`. A family is described by the rows with an empty second
 * column. Rows with an axis position there (`wght@900`, `wdth,wght@75,300`) describe one instance; many
 * variable families (Exo 2, Saira) have their moods only on those. A mood or theme the family rows lack
 * is taken from the instances at weight 500 or lighter, averaged over the ones that carry it. Lighter
 * only, because the catalog describes the regular style and Google rates some moods at bold weights
 * alone (Loud: 185 rows at 600 and 311 at 900, none at 400), so Inter would otherwise read as loud.
 * Averaged over carriers, because Google tags instances sparsely (Exo 2 has Competent 73 at 100 and 900
 * and no row at 400). Quality, seasonal and purpose tags say nothing about the look, so they are
 * dropped. Tags under 40 are dropped. Every classification and theme tag left is kept; moods are cut to
 * the strongest 5 in the labels, but all their strengths stay in `scores`.
 */
function parseGoogleTags(csv: string): Map<string, GoogleTags> {
  const familyRows = new Map<string, Map<string, number>>();
  const instanceRows = new Map<string, Map<string, Map<string, number>>>();
  for (const line of csv.split("\n")) {
    const parts = csvFields(line.trim());
    if (parts.length !== 4) continue;
    const [family, instance, tagPath, scoreText] = parts;
    const score = Number(scoreText);
    if (!tagPath.startsWith("/") || !Number.isFinite(score)) continue;
    const [group, name] = tagPath.slice(1).split("/");
    if (!name || group === "Quality" || group === "Seasonal" || group === "Purpose") continue;
    if (instance === "") {
      const rows = familyRows.get(family) ?? new Map<string, number>();
      rows.set(tagPath, score);
      familyRows.set(family, rows);
    } else {
      const byInstance = instanceRows.get(family) ?? new Map<string, Map<string, number>>();
      const rows = byInstance.get(instance) ?? new Map<string, number>();
      rows.set(tagPath, score);
      byInstance.set(instance, rows);
      instanceRows.set(family, byInstance);
    }
  }
  const groupOf = (tagPath: string) => tagPath.slice(1).split("/")[0];
  const out = new Map<string, GoogleTags>();
  for (const family of new Set([...familyRows.keys(), ...instanceRows.keys()])) {
    const rows = new Map(familyRows.get(family));
    const fromInstances = new Map<string, number[]>();
    for (const [instance, instanceTags] of instanceRows.get(family) ?? []) {
      if (instanceWeight(instance) > 500) continue;
      for (const [tagPath, score] of instanceTags) {
        if (rows.has(tagPath) || !SCORED_GROUPS.has(groupOf(tagPath))) continue;
        fromInstances.set(tagPath, [...(fromInstances.get(tagPath) ?? []), score]);
      }
    }
    for (const [tagPath, scores] of fromInstances) rows.set(tagPath, scores.reduce((a, b) => a + b, 0) / scores.length);
    const strong = [...rows].filter(([, score]) => score >= 40).sort((a, b) => b[1] - a[1]);
    if (!strong.length) continue;
    const moods = strong.filter(([tagPath]) => groupOf(tagPath) === "Expressive");
    const shown = new Set([...strong.filter(([tagPath]) => groupOf(tagPath) !== "Expressive"), ...moods.slice(0, 5)]);
    const tags: string[] = [];
    const scores: Record<string, number> = {};
    for (const entry of strong) {
      const [tagPath, score] = entry;
      const [group, name] = tagPath.slice(1).split("/");
      const label = ["Sans", "Serif", "Slab", "Script"].includes(group) ? `${name} ${group.toLowerCase()}` : name;
      if (shown.has(entry)) tags.push(label);
      if (SCORED_GROUPS.has(group)) scores[label] = Math.round(score);
    }
    out.set(family, { tags, scores });
  }
  return out;
}

/** The weight an instance name sets (`wght@900` → 900, `wdth,wght@75,300` → 300); 400 when it sets none. */
function instanceWeight(instance: string): number {
  const [axes, values] = instance.split("@");
  const at = (axes ?? "").split(",").indexOf("wght");
  const weight = at === -1 ? NaN : Number((values ?? "").split(",")[at]);
  return Number.isFinite(weight) ? weight : 400;
}

/** One CSV line as fields. A quoted field may hold commas: `Fredoka,"wdth,wght@75,300",/Expressive/Active,20`. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

function licenseLabel(license: string): string {
  if (license.startsWith("OFL")) return "OFL";
  if (license.startsWith("Apache")) return "Apache";
  if (license.startsWith("UFL")) return "UFL";
  return license;
}

const FONTSOURCE_CATEGORY: Record<string, Category> = {
  "sans-serif": "sans",
  serif: "serif",
  display: "display",
  handwriting: "handwriting",
  monospace: "mono",
};

const FONTSHARE_CATEGORY: Record<string, Category> = {
  Sans: "sans",
  Serif: "serif",
  Slab: "serif",
  Display: "display",
  Script: "handwriting",
  Handwritten: "handwriting",
};

async function fetchJson<T>(url: string): Promise<T | null> {
  const text = await fetchText(url);
  if (!text) return null;
  try {
    // Google prefixes some JSON with an anti-XSSI line.
    return JSON.parse(text.replace(/^\)\]\}'\s*/, "")) as T;
  } catch (err) {
    console.warn(`[catalog] bad JSON from ${url}:`, err);
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  remoteStatus.requests++;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`[catalog] could not fetch ${url}:`, err);
    return null;
  }
}

interface FontsourceFont {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  styles: string[];
  category: string;
  license: string;
  type: string;
}

interface FontshareFont {
  name: string;
  slug: string;
  category: string;
  license_type: string;
  views?: number;
  inserted_at?: string;
  font_tags: { name: string }[];
  /** weight.number is Fontshare's style number (an italic is its weight + 1); weight.weight is the weight itself. */
  styles: { file: string; is_italic: boolean; is_variable: boolean; weight: { number: number; weight?: number } }[];
}

interface GfMeta {
  family: string;
  stroke: string | null;
  popularity: number;
  dateAdded?: string;
  /** One key per style Google serves: "400", "400i", "700"... */
  fonts?: Record<string, unknown>;
}
