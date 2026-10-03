// The online build's catalog and font files. `npm run build:static` runs this after Vite has built the
// page into dist-static/. Online there is no server, so every font file the local app fetches through
// its proxy (/api/font: the indie sources, and italics borrowed from them) is hosted next to the page:
//   dist-static/catalog.json        the catalog, as GET /api/catalog returns it, with those URLs rewritten
//   dist-static/files/<sha1><ext>   one copy per file, named by the sha1 of its original URL
// Each rewritten row keeps the original URLs in `upstream` (copy path -> original URL), so labels and
// exports can name the real file. Fontsource and Fontshare files stay on their CDNs: the browser loads
// them directly (both send CORS headers).
//
// The copies come from the font proxy's own cache (server/.cache/fonts/, same names without the
// extension). Missing files are fetched politely and saved there too, so the local proxy and the next
// build reuse them: a build with everything cached fetches no font file. (The catalog itself comes from
// getCatalog, which refreshes the Fontsource, Fontshare and Google lists once a day, as the local server
// does.) A file that cannot be had, or is not a font, is left out with its weight, and the script lists it.
//
// It refuses to write a catalog that is missing a part: one built from lists that did not all arrive,
// or one with a source much smaller than at the last build. catalog.json is written last, so a refused
// or stopped build has none, and deploy:site will not publish it.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalog, remoteStatus } from "./catalog.ts";
import { allowed, cachePath, FontFetchError, getFile, sniff } from "./fontProxy.ts";
import type { FontEntry } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "dist-static");
/** Where the page is served from. vite.config.ts builds with the same base; the check below holds them together. */
const BASE = "/fonts/";
const FILES = "files";

/**
 * Files that could not be had for good (a 404, not a font), and when. They are not asked for again
 * for a week, so a rebuild stays quiet. Delete the file to try them all again.
 */
const FAILURES_FILE = path.join(here, ".cache", "export-failures.json");
const FAILURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How each host is asked: at most `parallel` downloads at once, and `gapMs` from one finishing to the
 * next starting. The small foundry hosts get one at a time; jsDelivr is a CDN.
 */
const HOSTS: Record<string, { parallel: number; gapMs: number }> = {
  "usemodify.com": { parallel: 1, gapMs: 600 },
  "gitlab.com": { parallel: 1, gapMs: 1000 },
  "codeberg.org": { parallel: 1, gapMs: 1000 },
  "cdn.jsdelivr.net": { parallel: 4, gapMs: 0 },
};
/** Any other host the proxy allows (raw.githubusercontent.com, which no catalog row uses today). */
const OTHER_HOST = { parallel: 2, gapMs: 500 };
/** Timeouts and server errors are tried this many times in all, a few seconds apart. */
const ATTEMPTS = 3;

/** Fonts, and fonts with an italic, per source, as the last build wrote them. */
const COUNTS_FILE = path.join(here, ".cache", "export-counts.json");
/**
 * How much smaller than at the last build a source may be before the export stops to ask: a lost list
 * or a host that was down shows up as a source shrinking far more than a foundry ever removes fonts.
 */
const SHRINK_LIMIT = 0.1;
type Counts = Record<string, { fonts: number; italics: number }>;

const EXT: Record<string, string> = { "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HostQueue {
  private active = 0;
  private lastEnd = 0;
  private waiting: (() => void)[] = [];
  private limits: { parallel: number; gapMs: number };
  constructor(limits: { parallel: number; gapMs: number }) {
    this.limits = limits;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limits.parallel) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      const wait = this.lastEnd + this.limits.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      this.lastEnd = Date.now();
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

type Failures = Record<string, { at: number; reason: string }>;

/** The files a row loads through the proxy locally, as [kind, weight, url]. */
function proxied(f: FontEntry): ["files" | "italicFiles", number, string][] {
  const out: ["files" | "italicFiles", number, string][] = [];
  if (f.proxy) for (const [w, url] of Object.entries(f.files ?? {})) out.push(["files", Number(w), url]);
  if (f.italicProxy ?? f.proxy) for (const [w, url] of Object.entries(f.italicFiles ?? {})) out.push(["italicFiles", Number(w), url]);
  return out;
}

async function main() {
  const started = Date.now();
  const index = await readFile(path.join(OUT, "index.html"), "utf8").catch(() => null);
  if (index === null) fail(`No ${path.relative(process.cwd(), OUT)}/index.html: run npm run build:static, which builds the page first.`);
  if (!index.includes(`${BASE}assets/`)) fail(`dist-static/index.html was not built for ${BASE} (vite.config.ts and this script must agree on the base).`);
  // Gone until this run writes a whole one, so a run that stops halfway never leaves an old catalog
  // naming files that are no longer there.
  await rm(path.join(OUT, "catalog.json"), { force: true });

  const catalog = await getCatalog();
  if (remoteStatus.partial) {
    fail(
      "Not all of the Fontsource, Fontshare and Google lists arrived, and there is no saved copy to fall back on, " +
        "so the catalog would be missing fonts or italics. Nothing was written. Run npm run build:static again in a while.",
    );
  }
  const failures: Failures = JSON.parse(await readFile(FAILURES_FILE, "utf8").catch(() => "{}"));
  const queues = new Map<string, HostQueue>();
  const fetched = new Map<string, number>();
  const requests = new Map<string, number>();
  const count = (m: Map<string, number>, host: string) => m.set(host, (m.get(host) ?? 0) + 1);

  /** The file's bytes (from the cache, or fetched and then cached), or why there are none. */
  async function obtain(raw: string): Promise<{ body: Buffer } | { reason: string }> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { reason: "not a URL" };
    }
    if (!allowed(url)) return { reason: `host ${url.hostname} is not one the font proxy allows` };
    const cached = await readFile(cachePath(url)).catch(() => null);
    if (cached) return { body: cached };
    const known = failures[url.href];
    if (known && Date.now() - known.at < FAILURE_TTL_MS) {
      return { reason: `${known.reason} (on ${new Date(known.at).toISOString().slice(0, 10)}; not asked again for a week)` };
    }
    const host = url.hostname;
    let queue = queues.get(host);
    if (!queue) queues.set(host, (queue = new HostQueue(HOSTS[host] ?? OTHER_HOST)));
    for (let attempt = 1; ; attempt++) {
      try {
        // getFile saves the file into the proxy's cache, where the local app and the next build find it.
        const body = await queue.run(() => {
          count(requests, host);
          return getFile(url);
        });
        count(fetched, host);
        delete failures[url.href];
        return { body };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const permanent = err instanceof FontFetchError && err.permanent;
        if (permanent) failures[url.href] = { at: Date.now(), reason };
        if (permanent || attempt >= ATTEMPTS) return { reason };
        await sleep(2000 * attempt);
      }
    }
  }

  // Every file once, however many rows name it.
  const urls = [...new Set(catalog.fonts.flatMap((f) => proxied(f).map(([, , url]) => url)))];
  const pending = urls.length - (await Promise.all(urls.map((u) => isCached(u)))).filter(Boolean).length;
  console.log(`[export] ${catalog.fonts.length} fonts; ${urls.length} files to host, ${pending} not in the cache yet`);
  let done = 0;
  const progress = setInterval(() => console.log(`[export] ${done}/${urls.length} files ready`), 15_000);

  await rm(path.join(OUT, FILES), { recursive: true, force: true });
  await mkdir(path.join(OUT, FILES), { recursive: true });
  /** Original URL -> the copy's path on the site, or why there is no copy. */
  const copies = new Map<string, { path: string; bytes: number } | { reason: string }>();
  await Promise.all(
    urls.map(async (raw) => {
      const got = await obtain(raw);
      done++;
      if ("reason" in got) return void copies.set(raw, got);
      const type = sniff(got.body);
      if (!type) return void copies.set(raw, { reason: "not a font file (its first bytes are not a font's)" });
      const name = `${path.basename(cachePath(new URL(raw)))}${EXT[type]}`;
      await writeFile(path.join(OUT, FILES, name), got.body);
      copies.set(raw, { path: `${BASE}${FILES}/${name}`, bytes: got.body.length });
    }),
  );
  clearInterval(progress);
  await mkdir(path.dirname(FAILURES_FILE), { recursive: true });
  await writeFile(FAILURES_FILE, JSON.stringify(failures, null, 1));

  // Rewrite the rows. Nothing online goes through a proxy, so no row keeps proxy or italicProxy.
  const left: string[] = [];
  const fonts: FontEntry[] = [];
  for (const f of catalog.fonts) {
    const row: FontEntry = { ...f, files: f.files && { ...f.files }, italicFiles: f.italicFiles && { ...f.italicFiles } };
    const upstream: Record<string, string> = {};
    for (const [kind, w, url] of proxied(f)) {
      const copy = copies.get(url)!;
      if ("path" in copy) {
        row[kind]![w] = copy.path;
        upstream[copy.path] = url;
        continue;
      }
      delete row[kind]![w];
      if (kind === "files") row.weights = row.weights.filter((x) => x !== w);
      left.push(`${f.family} (${f.source}) ${w}${kind === "italicFiles" ? " italic" : ""}: ${copy.reason}\n      ${url}`);
    }
    delete row.proxy;
    delete row.italicProxy;
    if (row.files && !Object.keys(row.files).length) delete row.files;
    if (row.italicFiles && !Object.keys(row.italicFiles).length) {
      delete row.italicFiles;
      delete row.italicFrom;
    }
    if (Object.keys(upstream).length) row.upstream = upstream;
    if (!row.weights.length) {
      left.push(`${f.family} (${f.source}): no upright file left, so the family is left out`);
      continue;
    }
    fonts.push(row);
  }

  // Compare with the last build before writing anything a deploy would publish.
  const counts = countsOf(fonts);
  const previous: Counts | null = JSON.parse(await readFile(COUNTS_FILE, "utf8").catch(() => "null"));
  const shrunk = previous ? shrinkage(previous, counts) : [];
  if (shrunk.length && process.env.EXPORT_ACCEPT_SMALLER !== "1") {
    console.error("[export] the catalog is much smaller than at the last build, so catalog.json was not written:");
    for (const line of shrunk) console.error(`  - ${line}`);
    if (left.length) console.error(`  (${left.length} file(s) or font(s) were also left out this time; run again to see them.)`);
    fail("If a source really did remove those fonts, run again with EXPORT_ACCEPT_SMALLER=1 npm run build:static.");
  }

  // The version changes with what this build wrote, so a visitor's saved copy is replaced when a file
  // that failed last time is there now, even though the merged catalog is the same.
  const version = `${catalog.version}-${createHash("sha1").update(JSON.stringify(fonts)).digest("hex").slice(0, 8)}`;
  await writeFile(path.join(OUT, "catalog.json"), JSON.stringify({ at: catalog.at, version, fonts }));
  await writeFile(COUNTS_FILE, JSON.stringify(counts, null, 1));

  const hosted = [...copies.values()].filter((c): c is { path: string; bytes: number } => "path" in c);
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const catalogBytes = (await stat(path.join(OUT, "catalog.json"))).size;
  console.log(`[export] catalog.json: ${fonts.length} fonts (${mb(catalogBytes)} MB), version ${version}`);
  console.log(`[export] files/: ${hosted.length} files, ${mb(hosted.reduce((n, c) => n + c.bytes, 0))} MB`);
  const perHost = (m: Map<string, number>) => [...m].map(([h, n]) => `${h} ${n}`).join(", ") || "none";
  const fileRequests = [...requests.values()].reduce((a, b) => a + b, 0);
  console.log(`[export] per source: ${Object.entries(counts).map(([s, c]) => `${s} ${c.fonts} (${c.italics} with italics)`).join(", ")}`);
  console.log(
    `[export] source lists: ${remoteStatus.requests ? `downloaded again (${remoteStatus.requests} requests)` : "from the saved copy (no request)"}; ` +
      `font files fetched now: ${[...fetched.values()].reduce((a, b) => a + b, 0)} (${perHost(fetched)}); ` +
      `requests made in all: ${remoteStatus.requests + fileRequests} (${perHost(requests)}${remoteStatus.requests ? `, lists ${remoteStatus.requests}` : ""})`,
  );
  if (left.length) {
    console.log(`[export] left out (${left.length}):`);
    for (const line of left) console.log(`  - ${line}`);
  } else {
    console.log("[export] nothing left out");
  }
  console.log(`[export] done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

function countsOf(fonts: FontEntry[]): Counts {
  const out: Counts = {};
  for (const f of fonts) {
    const c = (out[f.source] ??= { fonts: 0, italics: 0 });
    c.fonts++;
    if (f.italicWeights?.length || Object.keys(f.italicFiles ?? {}).length) c.italics++;
  }
  return out;
}

/** Each source that shrank past SHRINK_LIMIT since the last build, in words. */
function shrinkage(before: Counts, now: Counts): string[] {
  const out: string[] = [];
  for (const [source, was] of Object.entries(before)) {
    const is = now[source] ?? { fonts: 0, italics: 0 };
    if (is.fonts < was.fonts * (1 - SHRINK_LIMIT)) out.push(`${source}: ${is.fonts} fonts, ${was.fonts} at the last build`);
    else if (is.italics < was.italics * (1 - SHRINK_LIMIT)) out.push(`${source}: ${is.italics} fonts with an italic, ${was.italics} at the last build`);
  }
  return out;
}

async function isCached(raw: string): Promise<boolean> {
  try {
    await stat(cachePath(new URL(raw)));
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  console.error(`[export] ${message}`);
  process.exit(1);
}

await main();
// getCatalog may have started timers (a refetch); the export is finished either way.
process.exit(0);
