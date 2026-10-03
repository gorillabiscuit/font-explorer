import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { GOOGLE_FONTS_REPO as REPO, LICENCE_DIRS, parseMetadata, slugOf, type GoogleFamilyFiles } from "../src/googleMetadata.ts";

// Google families' complete files, for alternates. Fontsource's web files are cut down for the web
// and may lose a family's stylistic sets, so the lightbox and Compare draw a Google family with an
// alternate switched on from the file in Google's own repository instead. This finds that file:
// the family's folder is guessed from its name in each licence folder in turn, and its METADATA.pb
// lists the files and the variable axes. The file itself then loads through the font proxy (/api/font),
// which already allows raw.githubusercontent.com and keeps a copy. Reading METADATA.pb and choosing a
// file are in src/googleMetadata.ts, which has no Node code, so the browser can do the same.
//
// GET /api/google-files?family=Space%20Grotesk -> { family, files: [{weight, style, filename, url}], axes: [{tag, min, max}] }
// 404 when no folder matches: some families are renamed or live elsewhere.

const UA = "font-explorer/0.1 (personal local font browser; caches each lookup)";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(here, ".cache", "google-files.json");
/** A family that was not found is asked about again after this long: Google adds families. */
const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per slug: what was found (null: nothing) and when. */
type Cache = Record<string, { at: number; found: GoogleFamilyFiles | null }>;

let cache: Promise<Cache> | null = null;
const inflight = new Map<string, Promise<GoogleFamilyFiles | null>>();

export async function googleFiles(req: Request, res: Response) {
  const family = String(req.query.family ?? "").trim();
  const slug = slugOf(family);
  if (!slug || family.length > 100) {
    res.status(400).json({ error: "Give a family name, e.g. ?family=Space%20Grotesk" });
    return;
  }
  try {
    const found = await lookup(slug);
    if (!found) {
      res.status(404).json({ error: `No folder for "${family}" in Google's font repository.` });
      return;
    }
    res.json({ ...found, family });
  } catch (err) {
    // Not cached: a network failure may clear up.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[google-files] ${family}: ${message}`);
    res.status(502).json({ error: `Could not reach Google's font repository: ${message}` });
  }
}

async function lookup(slug: string): Promise<GoogleFamilyFiles | null> {
  const known = (await loadCache())[slug];
  if (known && (known.found || Date.now() - known.at < NOT_FOUND_TTL_MS)) return known.found;
  let p = inflight.get(slug);
  if (!p) {
    p = find(slug)
      .then(async (found) => {
        const all = await loadCache();
        all[slug] = { at: Date.now(), found };
        await saveCache(all);
        return found;
      })
      .finally(() => inflight.delete(slug));
    inflight.set(slug, p);
  }
  return p;
}

/** Tries each licence folder in turn. Throws on a network failure, so it is not cached as 'not found'. */
async function find(slug: string): Promise<GoogleFamilyFiles | null> {
  for (const dir of LICENCE_DIRS) {
    const res = await fetch(`${REPO}/${dir}/${slug}/METADATA.pb`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${dir}/${slug}`);
    const parsed = parseMetadata(await res.text(), `${REPO}/${dir}/${slug}`);
    return parsed.files.length ? parsed : null;
  }
  return null;
}

function loadCache(): Promise<Cache> {
  cache ??= readFile(CACHE_FILE, "utf8")
    .then((text) => JSON.parse(text) as Cache)
    .catch(() => ({}));
  return cache;
}

async function saveCache(all: Cache): Promise<void> {
  try {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const temp = `${CACHE_FILE}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify(all, null, 1));
    await rename(temp, CACHE_FILE);
  } catch (err) {
    // The answer is still in memory; it is only looked up again after a restart.
    console.warn("[google-files] could not save the cache", err);
  }
}
