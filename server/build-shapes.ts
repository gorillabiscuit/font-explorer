// Measures the letter shapes of every family in the catalog and writes server/traits/shape.json, so
// the vibe search can tell Claude how heavy, wide, slanted, square, straight and contrasted each
// family is (Claude never sees a letter). Run: npm run shapes. Add --all to measure every family
// again; otherwise a family keeps its saved row while the file it was measured on is still listed.
//
// One upright file per family, the weight nearest 400 (400, then 500, 300, 600, ...). Files are read
// into memory and never written to disk, except the indie sources' files, which go through the font
// proxy's own cache (most are already there, so they cost no request). Requests are spaced out: at
// most 4 at once to jsDelivr, ~120 ms apart; at most 2 to Fontshare, ~700 ms apart. Nothing is ever
// requested from velvetyne.fr.
//
// Families that cannot be measured go in `failed` with a reason, and are tried again on the next run.
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import type { Font } from "fontkit";
import type { FontEntry, Source } from "../src/types.ts";
import { getCatalog, NO_LATIN_FILE } from "./catalog.ts";
import { cachePath, FontFetchError, getFile, UA } from "./fontProxy.ts";
import { measureShape, type ShapeEntry, type ShapeFile, type ShapeTraits } from "./shape.ts";

/** Bump when shape.ts measures differently, so the next run measures every family again. */
const VERSION = 2;
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "traits", "shape.json");
const CDN = "https://cdn.jsdelivr.net/fontsource/fonts";
/** Weights tried per family when a file is missing or unreadable, nearest 400 first. */
const MAX_TRIES = 3;

/**
 * Colour fonts whose plain outlines (what shape.ts measures, as fontkit cannot draw the colour layers)
 * are not the letters a browser draws, so they are left unmeasured. Found on 2026-10-03 by drawing the
 * plain outlines of all 21 families Google lists with colour tables: Honk's are letters cut out of a
 * solid block, and Kalnia Glaze's are hairline outlines of letters Chrome draws filled. The others'
 * plain outlines are their letters (Bungee Spice and Tint are Bungee; Nabla its extruded silhouette).
 */
const PLAIN_OUTLINES_MISLEAD = new Map([
  ["Honk", "colour font: its plain outlines are letters cut out of a block, not what browsers draw"],
  ["Kalnia Glaze", "colour font: its plain outlines are hairlines, not the filled letters browsers draw"],
]);

// --- request pacing ---

/** At most `max` tasks at once, each started at least `gapMs` after the one before. */
class Lane {
  private active = 0;
  private lastStart = 0;
  private waiting: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  requests = 0;

  constructor(
    private readonly max: number,
    private readonly gapMs: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.pump();
    });
    this.requests++;
    try {
      return await task();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private pump() {
    if (this.timer || !this.waiting.length || this.active >= this.max) return;
    const wait = this.lastStart + this.gapMs - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    this.active++;
    this.lastStart = Date.now();
    this.waiting.shift()!();
    this.pump();
  }
}

const lanes = {
  jsdelivr: new Lane(4, 120),
  fontshare: new Lane(2, 700),
  // Indie files the proxy has not cached yet. Small foundry hosts, so slower still.
  proxy: new Lane(2, 500),
};

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Never velvetyne.fr: it opts out of AI agents in its robots.txt (see sources/velvetyne.ts), and the
 * catalog's Velvetyne files come from the foundries' git hosts anyway.
 */
function refuseVelvetyne(url: URL) {
  if (url.hostname === "velvetyne.fr" || url.hostname.endsWith(".velvetyne.fr")) throw new HttpError(403);
}

/**
 * Asking again would get the same answer: a 4xx other than 429, or a FontFetchError marked permanent
 * (an off-host redirect, from fetchOnce or the font proxy, or a file that is not a font).
 */
function permanent(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 400 && err.status < 500 && err.status !== 429;
  return err instanceof FontFetchError && err.permanent;
}

/**
 * The file is not there: a 404 from this script's own download or from the font proxy's (getFile
 * throws FontFetchError, whose message is the status), the one failure worth trying another weight for.
 */
function missing(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 404;
  return err instanceof FontFetchError && err.permanent && err.message === "HTTP 404";
}

/** A file's bytes, in memory only. Retried twice on timeouts and server errors, never on a permanent failure. */
async function download(href: string, lane: Lane): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await lane.run(() => fetchOnce(new URL(href)));
    } catch (err) {
      if (permanent(err) || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function fetchOnce(start: URL): Promise<Buffer> {
  let url = start;
  // Redirects are followed by hand and only within the same host, so a request never lands somewhere unplanned.
  for (let hop = 0; ; hop++) {
    refuseVelvetyne(url);
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get("location") ?? "", url);
      // Permanent: the host will redirect the same way next time.
      if (hop >= 3 || next.hostname !== start.hostname) throw new FontFetchError(`redirect to ${next.href} not followed`, true);
      url = next;
      continue;
    }
    if (!res.ok) throw new HttpError(res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** An indie file through the font proxy's cache; only a file it has not cached yet waits for the lane. */
async function viaProxy(href: string): Promise<Buffer> {
  const url = new URL(href);
  refuseVelvetyne(url);
  try {
    await access(cachePath(url));
    return await getFile(url);
  } catch {
    // not cached yet
  }
  return lanes.proxy.run(() => getFile(url));
}

// --- which file ---

interface Candidate {
  weight: number;
  url: string;
  get: () => Promise<Buffer>;
}

/** Nearest 400 first; between two equally near, the heavier (500 before 300). */
function byNearness(weights: number[]): number[] {
  return [...new Set(weights)].filter(Number.isFinite).sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400) || b - a);
}

/** The upright files to try for a family, best first, or a reason there are none. */
function candidatesFor(f: FontEntry): Candidate[] | string {
  const misleading = PLAIN_OUTLINES_MISLEAD.get(f.family);
  if (misleading) return misleading;
  if (f.source === "fontsource") {
    if (NO_LATIN_FILE.has(f.family)) return "no latin file on the CDN (NO_LATIN_FILE)";
    if (!f.ref) return "no Fontsource id";
    return byNearness(f.weights).map((weight) => {
      const url = `${CDN}/${f.ref}@latest/latin-${weight}-normal.woff2`;
      return { weight, url, get: () => download(url, lanes.jsdelivr) };
    });
  }
  const files = f.files ?? {};
  const weights = byNearness(Object.keys(files).map(Number));
  if (!weights.length) return "no upright file listed";
  return weights.map((weight) => {
    const url = files[weight];
    return { weight, url, get: () => (f.proxy ? viaProxy(url) : download(url, lanes.fontshare)) };
  });
}

// --- measuring ---

let variableFiles = 0;

function parse(bytes: Buffer): Font {
  const created = fontkit.create(bytes);
  const font = "fonts" in created ? created.fonts[0] : created;
  if (!font) throw new Error("empty collection");
  return font;
}

/**
 * The traits of one file at the given weight. A variable file with a weight axis is measured at that
 * weight when fontkit can make the instance, and otherwise at its default. Two indie files are
 * variable today: A MONO (default 400 already) and Kikuta, whose default instance is wght 1 and named
 * Thin, though its letters are not hairlines (weight 0.36 there against 0.39 at 400). Measuring it at
 * 400 moves its weight by about 8% and its widths and contrast somewhat.
 */
function measureFile(bytes: Buffer, weight: number): ShapeTraits | null {
  const font = parse(bytes);
  const axis = font.variationAxes?.wght;
  if (axis) {
    variableFiles++;
    if (axis.default !== weight && weight >= axis.min && weight <= axis.max) {
      try {
        const traits = measureShape(font.getVariation({ wght: weight }));
        if (traits) return traits;
      } catch {
        // fall back to the default instance
      }
    }
  }
  return measureShape(font);
}

type Outcome = { entry: ShapeEntry; reused: boolean } | { failed: string };

async function measureFamily(f: FontEntry, old: ShapeEntry | undefined, all: boolean): Promise<Outcome> {
  const candidates = candidatesFor(f);
  if (typeof candidates === "string") return { failed: candidates };
  if (!all && old && candidates.some((c) => c.url === old.file && c.weight === old.weight)) return { entry: old, reused: true };

  let reason = "no file";
  for (const c of candidates.slice(0, MAX_TRIES)) {
    let bytes: Buffer;
    try {
      bytes = await c.get();
    } catch (err) {
      reason = `download failed: ${err instanceof Error ? err.message : String(err)}`;
      // Only a missing file is worth trying another weight for; a host that is down will be down for all.
      if (missing(err)) continue;
      return { failed: reason };
    }
    let traits: ShapeTraits | null;
    try {
      traits = measureFile(bytes, c.weight);
    } catch (err) {
      reason = `fontkit could not read it: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (!traits) return { failed: `no letters fontkit can draw (${c.weight})` };
    return { entry: { file: c.url, weight: c.weight, ...traits }, reused: false };
  }
  return { failed: reason };
}

// --- output ---

const round = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

/** The entry as written: rounded, keys in a fixed order, the width filled from the caps where it has to be. */
function finish(e: ShapeEntry, capsToLower: number | null): ShapeEntry {
  const measuredWd = e.wdFromCaps ? null : e.wd;
  const wdCaps = round(e.wdCaps);
  const fromCaps = measuredWd == null && wdCaps != null && capsToLower != null;
  const out: ShapeEntry = {
    file: e.file,
    weight: e.weight,
    w: round(e.w),
    wd: fromCaps ? round(wdCaps * capsToLower) : round(measuredWd),
    sl: round(e.sl),
    ...(e.slFrom === "covariance" ? { slFrom: "covariance" as const } : {}),
    xr: round(e.xr),
    sq: round(e.sq),
    sf: round(e.sf),
    ct: round(e.ct),
    rev: e.ct == null ? null : e.rev,
    caps: e.caps,
    wdCaps,
  };
  if (fromCaps) out.wdFromCaps = true;
  return out;
}

const collator = new Intl.Collator("en");

const byFamily = ([a]: [string, unknown], [b]: [string, unknown]) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * One family per line, sorted by name, so a re-run's diff shows exactly which families changed. Written
 * from the sorted lists rather than from an object, which would move number-like names ("3270") first.
 */
function serialize(head: Omit<ShapeFile, "fonts" | "failed">, fonts: [string, ShapeEntry][], failed: [string, string][]): string {
  const block = (rows: [string, unknown][]) => {
    const lines = [...rows].sort(byFamily).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    return lines.length ? `{\n${lines.join(",\n")}\n  }` : "{}";
  };
  return (
    `{\n  "version": ${head.version},\n  "measuredAt": ${JSON.stringify(head.measuredAt)},\n` +
    `  "capsToLowerWidth": ${JSON.stringify(head.capsToLowerWidth)},\n` +
    `  "fonts": ${block(fonts)},\n  "failed": ${block(failed)}\n}\n`
  );
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// --- run ---

const all = process.argv.includes("--all");
const started = Date.now();
const { fonts } = await getCatalog();

let previous: ShapeFile | null = null;
try {
  previous = JSON.parse(await readFile(OUT, "utf8")) as ShapeFile;
} catch {
  // first run
}
const oldFonts = new Map(previous?.version === VERSION ? Object.entries(previous.fonts ?? {}) : []);
if (previous && previous.version !== VERSION) console.log(`shape.json is version ${previous.version}, this is ${VERSION}: measuring everything again`);

const families = fonts.filter((f) => f.source !== "local");
const seen = new Set<string>();
for (const f of families) {
  if (seen.has(f.family)) console.warn(`[shapes] ${f.family} is in the catalog twice; keeping the first row`);
  seen.add(f.family);
}

const results = new Map<string, Outcome & { source: Source }>();
let done = 0;
await Promise.all(
  families.map(async (f) => {
    if (results.has(f.family)) return;
    let outcome: Outcome;
    try {
      outcome = await measureFamily(f, oldFonts.get(f.family), all);
    } catch (err) {
      outcome = { failed: `unexpected: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!results.has(f.family)) results.set(f.family, { ...outcome, source: f.source });
    done++;
    if (done % 200 === 0) console.log(`[shapes] ${done}/${families.length} (${Math.round((Date.now() - started) / 1000)} s)`);
  }),
);

// The width of a caps face is scaled from its capitals by how the two measures compare on the
// families that have both, so it lands on the same scale as everyone else's lowercase width.
const ratios: number[] = [];
for (const r of results.values()) {
  if (!("entry" in r)) continue;
  const e = r.entry;
  if (!e.caps && !e.wdFromCaps && e.wd != null && e.wdCaps != null && e.wdCaps > 0) ratios.push(e.wd / e.wdCaps);
}
ratios.sort((a, b) => a - b);
const capsToLower = ratios.length ? round(quantile(ratios, 0.5)) : null;

const measured: [string, ShapeEntry][] = [];
const failed: [string, string][] = [];
for (const [family, r] of results) {
  if ("entry" in r) measured.push([family, finish(r.entry, capsToLower)]);
  else failed.push([family, r.failed]);
}
await mkdir(path.dirname(OUT), { recursive: true });
const temp = `${OUT}.${process.pid}.tmp`;
await writeFile(temp, serialize({ version: VERSION, measuredAt: new Date().toISOString(), capsToLowerWidth: capsToLower }, measured, failed));
await rename(temp, OUT);

// --- summary ---

const bySource = new Map<string, { measured: number; reused: number; failed: number }>();
for (const r of results.values()) {
  const row = bySource.get(r.source) ?? { measured: 0, reused: 0, failed: 0 };
  if ("failed" in r) row.failed++;
  else if (r.reused) row.reused++;
  else row.measured++;
  bySource.set(r.source, row);
}
console.log(`\nWrote ${path.relative(process.cwd(), OUT)} in ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`requests: jsDelivr ${lanes.jsdelivr.requests}, Fontshare ${lanes.fontshare.requests}, indie hosts (not cached yet) ${lanes.proxy.requests}`);
console.log(`variable files: ${variableFiles}; caps-to-lowercase width ratio: ${capsToLower} (median of ${ratios.length})`);
console.log("source".padEnd(14) + "measured".padStart(10) + "reused".padStart(8) + "failed".padStart(8));
for (const [source, row] of [...bySource].sort()) {
  console.log(source.padEnd(14) + String(row.measured).padStart(10) + String(row.reused).padStart(8) + String(row.failed).padStart(8));
}
const total = [...bySource.values()].reduce((s, r) => ({ measured: s.measured + r.measured, reused: s.reused + r.reused, failed: s.failed + r.failed }), { measured: 0, reused: 0, failed: 0 });
console.log("total".padEnd(14) + String(total.measured).padStart(10) + String(total.reused).padStart(8) + String(total.failed).padStart(8));
if (failed.length) console.log(`\nfailed:\n${failed.map(([family, why]) => `  ${family}: ${why}`).join("\n")}`);

const rows = measured.map(([, e]) => e);
console.log(`\ntrait     n      p5     p10     p50     p90     p95`);
for (const key of ["w", "wd", "sl", "xr", "sq", "sf", "ct"] as const) {
  const values = rows.map((e) => e[key]).filter((v): v is number => v != null).sort((a, b) => a - b);
  const cells = [0.05, 0.1, 0.5, 0.9, 0.95].map((q) => quantile(values, q).toFixed(3).padStart(8));
  console.log(`${key.padEnd(6)}${String(values.length).padStart(5)}${cells.join("")}`);
}
const count = (pred: (e: ShapeEntry) => boolean) => rows.filter(pred).length;
console.log(
  `caps ${count((e) => e.caps)}, reverse contrast ${count((e) => e.rev === true)}, width from caps ${count((e) => !!e.wdFromCaps)}, ` +
    `slant from the whole ink ${count((e) => e.slFrom === "covariance")}`,
);
