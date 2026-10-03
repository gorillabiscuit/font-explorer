// Collletttivo: an Italian libre type collective. Every free family is OFL and lives in its own repo
// under github.com/collletttivo, with web fonts in /fonts/. The foundry's site and its backend opt out
// of crawlers, so this builder reads GitHub and jsDelivr only:
//   1. One GitHub API call for the repo list (kept on disk for 12 hours), keeping OFL-1.1 repos. This
//      drops the two MIT tool repos. The paid retail catalogue is not on GitHub, so it never shows up.
//   2. Per repo, the head commit of the default branch, read from git's ref advertisement (the URL a
//      `git clone` starts with, not the rate-limited API), so file URLs are pinned and do not drift.
//   3. Per repo, the file list from jsDelivr's data API.
//   4. Each candidate font file downloaded once (kept on disk) and read with fontkit.
// GitHub has no descriptions, topics or READMEs for these repos, so category and tags are hand-written
// below from rendered specimens.
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { fetchBuffer, fetchJson, fetchText, readFontInfo, type Category, type FontEntry, type SourceBuilder } from "./common.ts";

const SOURCE = "collletttivo" as const;
const OWNER = "collletttivo";
const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "collletttivo");
const REPO_LIST_MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface Repo {
  name: string;
  html_url: string;
  default_branch: string;
  created_at: string;
  license: { spdx_id?: string } | null;
}

interface VariantMeta {
  tags: string[];
  category?: Category;
}

interface Curated {
  /** Display name, when title-casing the repo slug is not enough. */
  family?: string;
  category: Category;
  /** Up to 8, most important first. */
  tags: string[];
  /** Style words in file names that mark a different-looking design rather than a weight. */
  styleVariants?: string[];
  /** Hand-written tags for variant rows ("Condensed", "Angular"...). Width variants missing here get the base tags plus a width word. */
  variants?: Record<string, VariantMeta>;
  /** Weight by file name (no extension), for files whose style name and usWeightClass both mislead. */
  weightOverrides?: Record<string, number>;
  /** Set when the family cannot set a readable Latin word; the reason is logged. */
  skip?: string;
}

// Hand-written from specimens rendered at each style (no tag data exists anywhere on GitHub).
const CURATED: Record<string, Curated> = {
  absans: { category: "sans", tags: ["sans", "grotesk", "geometric", "clean", "neutral", "minimal", "contemporary"] },
  "apfel-grotezk": {
    category: "sans",
    tags: ["sans", "grotesk", "quirky", "geometric", "friendly", "indie", "contemporary"],
    // "Brukt" is not a light weight: the letters carry punched dots and construction nodes.
    styleVariants: ["Brukt"],
    variants: {
      Brukt: { category: "display", tags: ["display", "sans", "dotted", "perforated", "construction", "technical", "experimental", "grotesk"] },
    },
  },
  aujournuit: {
    category: "serif",
    tags: ["serif", "high-contrast", "elegant", "art-nouveau", "calligraphic", "fashion", "editorial", "delicate"],
    variants: {
      Condensed: { tags: ["serif", "condensed", "high-contrast", "elegant", "art-nouveau", "fashion", "editorial", "tall"] },
      Densed: { tags: ["serif", "narrow", "high-contrast", "elegant", "art-nouveau", "fashion", "editorial"] },
      Airy: { tags: ["serif", "wide", "high-contrast", "elegant", "art-nouveau", "airy", "luxury", "editorial"] },
      Wide: { tags: ["serif", "wide", "extended", "high-contrast", "elegant", "art-nouveau", "luxury", "editorial"] },
    },
  },
  // A maze-tile alphabet: every letter is a square labyrinth block built on a pixel grid. Words are hard
  // to read, so the tags say so plainly and the card lets the designer judge it.
  borges: {
    category: "display",
    tags: ["display", "maze", "pixel", "experimental", "hard-to-read", "labyrinth", "geometric", "square"],
  },
  coconat: {
    category: "serif",
    tags: ["serif", "flared", "glyphic", "wedge-serif", "warm", "display", "retro", "editorial"],
    // Both "Demi" and "Regular" carry usWeightClass 400. Measured ink sits between Regular and Bold,
    // about where a Medium does in Sprat, so 500.
    weightOverrides: { "Coconat-Demi": 500 },
  },
  halibut: {
    category: "serif",
    tags: ["serif", "quirky", "warm", "wedge-serif", "bookish", "editorial", "retro"],
    variants: {
      Condensed: { tags: ["serif", "condensed", "quirky", "warm", "wedge-serif", "bookish", "retro"] },
      Expanded: { tags: ["serif", "wide", "extended", "quirky", "warm", "wedge-serif", "retro"] },
    },
  },
  mattone: { category: "sans", tags: ["sans", "geometric", "wide", "extended", "heavy", "bold", "punchy", "poster"] },
  "mazius-display": {
    category: "serif",
    tags: ["serif", "display", "high-contrast", "elegant", "calligraphic", "editorial", "classic", "literary"],
  },
  messapia: {
    category: "display",
    tags: ["display", "wide", "glyphic", "flared", "inscriptional", "ancient", "elegant", "extended"],
  },
  "necto-mono": { category: "mono", tags: ["mono", "monospace", "code", "grotesk", "technical", "utilitarian"] },
  ortica: {
    category: "serif",
    tags: ["serif", "sharp", "elegant", "editorial", "bookish", "contemporary"],
    variants: {
      Linear: { tags: ["serif", "sharp", "high-contrast", "elegant", "editorial", "bookish", "contemporary"] },
      Angular: { tags: ["serif", "angular", "faceted", "chiseled", "sharp", "bold", "display", "editorial"] },
    },
  },
  ribes: { category: "sans", tags: ["sans", "geometric", "quirky", "playful", "retro", "funky", "contemporary"] },
  ronzino: { category: "sans", tags: ["sans", "grotesk", "neo-grotesk", "neutral", "swiss", "clean", "workhorse"] },
  sinistre: {
    category: "display",
    tags: ["display", "calligraphic", "uncial", "medieval", "gothic", "mystical", "flared", "serif"],
  },
  // The font file calls itself family "Sneaky", style "Times"; the designer's name is "Sneaky Times".
  "sneaky-times": { category: "serif", tags: ["serif", "quirky", "wonky", "times", "newspaper", "transitional", "editorial"] },
  sprat: {
    category: "serif",
    tags: ["serif", "high-contrast", "display", "didone", "fashion", "editorial", "elegant", "wide"],
    variants: {
      Condensed: { tags: ["serif", "condensed", "high-contrast", "display", "didone", "fashion", "editorial", "poster"] },
      Extended: { tags: ["serif", "extended", "wide", "high-contrast", "display", "didone", "fashion", "luxury"] },
    },
  },
};

// Width words found in file names, mapped to the name used on the card. "Condesed" is a typo in Sprat.
const WIDTH_RE = /(Semi)?(Condensed|Condesed|Compressed|Narrow|Densed|Extended|Expanded|Wide|Airy)/i;
const WIDTH_NAME: Record<string, string> = { condesed: "Condensed" };
const WIDTH_TAG: Record<string, string> = {
  condensed: "condensed",
  compressed: "condensed",
  narrow: "narrow",
  densed: "narrow",
  extended: "wide",
  expanded: "wide",
  wide: "wide",
  airy: "wide",
};
const FORMAT_RANK = ["woff2", "woff", "otf", "ttf"];
// Slant words in file names. "Extra" belongs to Mazius Display's "Extraitalic", a steeper italic, not a weight.
// No `g` flag: .test() on a global regex keeps state between calls.
const SLANT_RE = /(Extra)?(Italic|Oblique|Slanted)/i;

interface Face {
  file: string;
  url: string;
  weight: number;
  regularLike: boolean;
  variable: boolean;
  /** wght axis range for a variable file. */
  wght?: [number, number];
  /** Mazius Display's "Extraitalic": a steeper slant than a plain italic. */
  extraSlant?: boolean;
}

export const builder: SourceBuilder = {
  async build(log) {
    await mkdir(CACHE, { recursive: true });
    const repos = (await repoList(log)).filter((r) => r.license?.spdx_id === "OFL-1.1");
    log(`${repos.length} OFL repos`);

    const rows: FontEntry[] = [];
    for (const repo of repos) {
      const curated = CURATED[repo.name];
      // A new repo has no category or tags until someone looks at its specimen, so it waits rather than
      // shipping as an untagged "other" card.
      if (!curated) {
        log(`skip ${repo.name}: not curated yet (add it to CURATED with a category and tags)`);
        continue;
      }
      const family = curated.family ?? titleCase(repo.name);
      if (curated.skip) {
        log(`skip ${family}: ${curated.skip}`);
        continue;
      }
      try {
        const built = await buildRepo(repo, family, curated, log);
        rows.push(...built);
      } catch (err) {
        log(`${repo.name}: FAILED, left out (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return rows;
  },
};

async function buildRepo(repo: Repo, family: string, meta: Curated, log: (msg: string) => void): Promise<FontEntry[]> {
  const { ref, paths } = await listFonts(repo, log);
  const camel = repo.name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

  // Upright and slanted faces, each keyed by variant ("" for the plain family). Slanted faces are the
  // variant's italics, or stand in for its upright when it has none.
  const groups = new Map<string, Face[]>();
  const slanted = new Map<string, Face[]>();
  for (const p of paths) {
    const file = p.split("/").pop()!;
    const base = file.replace(/\.[^.]+$/, "");
    const url = `https://cdn.jsdelivr.net/gh/${OWNER}/${repo.name}@${ref}${p}`;
    const buffer = await cachedFont(repo.name, ref, p, url);
    const info = readFontInfo(buffer);
    const isSlanted = info.italic || SLANT_RE.test(base);

    // "OrticaAngular-Bold" → prefix "OrticaAngular", style "Bold". Strip variable-font markers first,
    // and the slant word, so "ExtraItalicBold" reads as "Bold" in the same variant as its upright.
    const variable = info.variable || /VF$|Variable/i.test(base);
    const dash = base.indexOf("-");
    const rawPrefix = dash < 0 ? base : base.slice(0, dash);
    let style = dash < 0 ? "" : base.slice(dash + 1);
    const prefix = rawPrefix.replace(/Variable|VF$/gi, "").replace(SLANT_RE, "");
    style = style.replace(/Variable|VF$/gi, "").replace(SLANT_RE, "");

    // A named variant baked into the prefix: OrticaAngular → "Angular". "Sneaky" (shorter than the slug) has none.
    const prefixVariant = prefix.toLowerCase().startsWith(camel.toLowerCase()) ? splitCamel(prefix.slice(camel.length)) : "";
    let width = "";
    const w = style.match(WIDTH_RE);
    if (w) {
      width = WIDTH_NAME[w[2].toLowerCase()] ?? capitalise(w[2]);
      style = style.replace(w[0], "");
    }
    let styleVariant = "";
    for (const sv of meta.styleVariants ?? []) {
      if (style.toLowerCase().includes(sv.toLowerCase())) {
        styleVariant = sv;
        style = style.replace(new RegExp(sv, "i"), "");
      }
    }
    const variant = [prefixVariant, styleVariant, width].filter(Boolean).join(" ");

    // An ordinary English weight word in the name wins; anything else (German names, "Dark", "Demi",
    // no word at all) takes usWeightClass from the file.
    const weight = meta.weightOverrides?.[base] ?? namedWeight(style) ?? info.weight;
    let wght: [number, number] | undefined;
    if (variable) {
      const axis = (fontkit.create(buffer) as unknown as { variationAxes?: Record<string, { min: number; max: number }> }).variationAxes?.wght;
      if (axis) wght = [axis.min, axis.max];
    }
    const extraSlant = /^Extra/i.test(base.match(SLANT_RE)?.[0] ?? "");
    const face: Face = { file, url, weight, variable, wght, extraSlant, regularLike: style === "" || /^(regular|normal|book|roman)$/i.test(style) };
    const into = isSlanted ? slanted : groups;
    into.set(variant, [...(into.get(variant) ?? []), face]);
  }

  const out: FontEntry[] = [];
  const summary: string[] = [];
  const leftOut: string[] = [];
  const variants = [...new Set([...groups.keys(), ...slanted.keys()])].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  for (const variant of variants) {
    const name = variant ? `${family} ${variant}` : family;
    const faces = groups.get(variant) ?? [];
    const slants = slanted.get(variant) ?? [];
    let files: Record<number, string> = {};
    let italicFiles: Record<number, string> = {};
    const italicOnly = !faces.length && slants.length > 0;
    if (italicOnly) {
      // No upright style at all: the slanted face closest to a regular stands in as weight 400, and is the
      // row's italic too, so an Italic switch shows the same face.
      const pick = [...slants].sort(
        (a, b) => Number(b.regularLike) - Number(a.regularLike) || Math.abs(a.weight - 400) - Math.abs(b.weight - 400) || Number(a.variable) - Number(b.variable),
      )[0];
      files[400] = pick.url;
      italicFiles = files;
      leftOut.push(...slants.filter((f) => f !== pick).map((f) => f.file));
      log(`${name}: no upright style, using the slanted ${pick.file} as 400 (tagged "italic only")`);
    } else {
      files = filesByWeight(faces, name, log);
      // The italics are weighed exactly like the uprights.
      if (slants.length) italicFiles = filesByWeight(slants, `${name} italics`, log);
    }
    const weights = Object.keys(files)
      .map(Number)
      .sort((a, b) => a - b);
    if (!weights.length) continue;

    const vm = variant ? meta.variants?.[variant] : undefined;
    const widthKey = variant.split(" ").pop()!.toLowerCase();
    const baseTags = vm?.tags ?? (variant && WIDTH_TAG[widthKey] ? withWidthTag(meta.tags, WIDTH_TAG[widthKey]) : meta.tags);
    // "italic only" goes right after the category word so the 8-tag cap can never drop it.
    const tags = italicOnly ? [baseTags[0], "italic only", ...baseTags.slice(1)].filter(Boolean) : baseTags;
    if (variant && !vm) log(`${name}: no hand-written tags for variant "${variant}", derived from ${family}`);

    out.push({
      id: variant ? `${SOURCE}:${repo.name}:${slugify(variant)}` : `${SOURCE}:${repo.name}`,
      family: name,
      source: SOURCE,
      category: vm?.category ?? meta.category,
      tags: tags.slice(0, 8),
      weights,
      license: "OFL",
      files,
      ...(Object.keys(italicFiles).length ? { italicFiles } : {}),
      homepage: repo.html_url,
      added: repo.created_at.slice(0, 10),
      proxy: true,
    });
    const italicWeights = Object.keys(italicFiles).join(",");
    summary.push(`${name} [${weights.join(",")}]${italicOnly ? " (italic only)" : italicWeights ? ` italic [${italicWeights}]` : ""}`);
  }
  log(`${repo.name}@${ref}: ${summary.join("; ")}${leftOut.length ? ` (left out ${leftOut.length} slanted: ${leftOut.join(", ")})` : ""}`);
  return out;
}

/**
 * Weight → URL for one set of faces (a row's uprights, or its italics). Static files win over variable ones;
 * two statics on one weight keep the regular-named one, and between italics the plain slant over a steeper
 * "Extra" one. With only variable files, every 100-step inside the wght axis points at the same file.
 */
function filesByWeight(faces: Face[], name: string, log: (msg: string) => void): Record<number, string> {
  const files: Record<number, string> = {};
  const statics = faces.filter((f) => !f.variable);
  if (statics.length) {
    const ignored = faces.filter((f) => f.variable).map((f) => f.file);
    if (ignored.length) log(`${name}: using static files, not the variable ${ignored.join(", ")}`);
    const chosen = new Map<number, Face>();
    for (const f of statics) {
      const prev = chosen.get(f.weight);
      if (!prev) chosen.set(f.weight, f);
      else {
        const better = (a: Face, b: Face) => (a.regularLike && !b.regularLike) || (a.regularLike === b.regularLike && !a.extraSlant && Boolean(b.extraSlant));
        const keep = better(f, prev) ? f : prev;
        const drop = keep === f ? prev : f;
        chosen.set(f.weight, keep);
        log(`${name}: ${drop.file} and ${keep.file} both weigh ${f.weight}; kept ${keep.file}`);
      }
    }
    for (const [weight, f] of chosen) files[weight] = f.url;
    return files;
  }
  for (const f of faces) {
    if (f.wght) {
      for (let wt = Math.max(100, Math.ceil(f.wght[0] / 100) * 100); wt <= Math.min(900, f.wght[1]); wt += 100) files[wt] ??= f.url;
    } else files[f.weight] ??= f.url;
  }
  return files;
}

/** The account's repos: one GitHub API call, reused from disk for 12 hours (60 unauthenticated calls an hour). */
async function repoList(log: (msg: string) => void): Promise<Repo[]> {
  const file = path.join(CACHE, "github-repos.json");
  const cached = existsSync(file) ? { age: Date.now() - (await stat(file)).mtimeMs, repos: JSON.parse(await readFile(file, "utf8")) as Repo[] } : null;
  if (cached && cached.age < REPO_LIST_MAX_AGE_MS) {
    log(`repo list from cache (${Math.round(cached.age / 60000)} min old)`);
    return cached.repos;
  }
  try {
    const repos = await fetchJson<Repo[]>(`https://api.github.com/users/${OWNER}/repos?per_page=100`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    await writeFile(file, JSON.stringify(repos, null, 1));
    log(`repo list from GitHub: ${repos.length} repos`);
    return repos;
  } catch (err) {
    if (!cached) throw err;
    log(`GitHub repo list failed (${err instanceof Error ? err.message : String(err)}); using the ${Math.round(cached.age / 3600000)} h old copy`);
    return cached.repos;
  }
}

/** Pins the default branch to its head commit and lists font files under /fonts/, one best format per style. */
async function listFonts(repo: Repo, log: (msg: string) => void): Promise<{ ref: string; paths: string[] }> {
  let ref = repo.default_branch;
  try {
    // git's ref advertisement (what `git clone` reads first). Not the REST API, so no 60-an-hour budget.
    const refs = await fetchText(`https://github.com/${OWNER}/${repo.name}.git/info/refs?service=git-upload-pack`);
    const sha = refs.match(new RegExp(`([0-9a-f]{40}) refs/heads/${repo.default_branch}\\b`))?.[1];
    // jsDelivr's data API answers 404 for some full-length commit ids but accepts a short one.
    if (sha) ref = sha.slice(0, 10);
  } catch (err) {
    log(`${repo.name}: could not read the head commit (${err instanceof Error ? err.message : String(err)}); using branch ${ref}`);
  }

  const pinned = ref !== repo.default_branch;
  const listingFile = path.join(CACHE, "listings", `${repo.name}@${ref}.json`);
  let names: string[];
  if (pinned && existsSync(listingFile)) names = JSON.parse(await readFile(listingFile, "utf8"));
  else {
    type Listing = { files: { name: string }[] };
    let listing: Listing;
    try {
      listing = await fetchJson<Listing>(`https://data.jsdelivr.com/v1/packages/gh/${OWNER}/${repo.name}@${ref}?structure=flat`);
    } catch (err) {
      if (!pinned) throw err;
      log(`${repo.name}: jsDelivr has no listing for ${ref}; falling back to branch ${repo.default_branch}`);
      ref = repo.default_branch;
      listing = await fetchJson<Listing>(`https://data.jsdelivr.com/v1/packages/gh/${OWNER}/${repo.name}@${ref}?structure=flat`);
    }
    names = listing.files.map((f) => f.name);
    if (ref !== repo.default_branch) {
      await mkdir(path.dirname(listingFile), { recursive: true });
      await writeFile(listingFile, JSON.stringify(names));
    }
  }

  const best = new Map<string, string>();
  for (const name of names) {
    const m = name.match(/^(\/fonts\/(?:.*\/)?([^/]+))\.(woff2|woff|otf|ttf)$/i);
    if (!m) continue;
    const key = m[2];
    const prev = best.get(key);
    const rank = (p: string) => FORMAT_RANK.indexOf(p.split(".").pop()!.toLowerCase());
    if (!prev || rank(name) < rank(prev)) best.set(key, name);
  }
  return { ref, paths: [...best.values()].sort() };
}

/** Downloads a font file once per pinned commit; later runs read it from disk. */
async function cachedFont(repo: string, ref: string, filePath: string, url: string): Promise<Buffer> {
  const local = path.join(CACHE, "files", `${repo}@${ref}`, filePath.replace(/^\/+/, ""));
  if (existsSync(local)) return readFile(local);
  const buffer = await fetchBuffer(url);
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, buffer);
  return buffer;
}

/** Standard English weight words only; returns undefined for anything that needs the file's own value. */
function namedWeight(style: string): number | undefined {
  const s = style.toLowerCase().replace(/[\s_-]/g, "");
  if (/^(regular|normal|book|roman)$/.test(s)) return 400;
  const table: [RegExp, number][] = [
    [/^(thin|hairline)$/, 100],
    [/^(extra|ultra)light$/, 200],
    [/^light$/, 300],
    [/^medium$/, 500],
    [/^(semi|demi)bold$/, 600],
    [/^bold$/, 700],
    [/^(extra|ultra)bold$/, 800],
    [/^(black|heavy)$/, 900],
  ];
  return table.find(([re]) => re.test(s))?.[1];
}

function withWidthTag(base: string[], widthTag: string): string[] {
  const widthWords = new Set(["wide", "extended", "condensed", "narrow", "compressed"]);
  const rest = base.filter((t) => !widthWords.has(t));
  return [rest[0], widthTag, ...rest.slice(1)].filter(Boolean);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const titleCase = (slug: string) => slug.split("-").map(capitalise).join(" ");
const splitCamel = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
