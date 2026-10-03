import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";

// Font files for the indie sources go through here. Each file is fetched from its host once and kept
// on disk, so small foundry hosts see one request per file ever, and every browser gets a proper
// font content type (the git hosts send application/octet-stream, and Use & Modify sends no CORS).
// The online build (export-static.ts) copies its files out of the same cache, so the helpers it
// needs are exported.

const ALLOWED_HOSTS = new Set(["gitlab.com", "codeberg.org", "cdn.jsdelivr.net", "raw.githubusercontent.com", "usemodify.com"]);
const MAX_BYTES = 10 * 1024 * 1024;
const PER_HOST = 4;
export const UA = "font-explorer/0.1 (personal local font browser; caches each file)";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, ".cache", "fonts");

/** Failed URLs and when to try them again, so a broken file is not re-requested on every scroll. */
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const failures = new Map<string, number>();
const MAX_REDIRECTS = 3;

const inflight = new Map<string, Promise<Buffer>>();
const active = new Map<string, number>();
const queues = new Map<string, (() => void)[]>();

export async function fontProxy(req: Request, res: Response) {
  let url: URL;
  try {
    url = new URL(String(req.query.url ?? ""));
  } catch {
    res.status(400).send("Bad url");
    return;
  }
  if (!allowed(url)) {
    res.status(403).send("Host not allowed");
    return;
  }
  if ((failures.get(url.href) ?? 0) > Date.now()) {
    res.status(502).set("Cache-Control", "max-age=300").send("Recently failed; not retrying yet");
    return;
  }
  try {
    const body = await getFile(url);
    res
      .set("Content-Type", sniff(body) ?? "application/octet-stream")
      .set("Cache-Control", "public, max-age=31536000, immutable")
      .send(body);
  } catch (err) {
    failures.set(url.href, Date.now() + FAILURE_BACKOFF_MS);
    console.warn(`[font] ${url.href}: ${err instanceof Error ? err.message : err}`);
    res.status(502).set("Cache-Control", "max-age=300").send("Could not fetch font");
  }
}

/** https only, on an allowed host, on the default port, with no credentials in the URL. */
export function allowed(url: URL): boolean {
  return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password;
}

/** The cache file for a URL: named by the sha1 of the URL, with no extension. */
export function cachePath(url: URL): string {
  return path.join(DIR, createHash("sha1").update(url.href).digest("hex"));
}

/**
 * Why a download failed. `permanent` is true when asking again would get the same answer (a 404, a
 * file that is not a font, a redirect off the allowed hosts), false for timeouts and server errors.
 */
export class FontFetchError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

/**
 * The file's bytes, from the cache or else from its host (and then kept in the cache). Only from an
 * allowed host, whoever asks: the route, the online export and check:italics all come through here.
 */
export async function getFile(url: URL): Promise<Buffer> {
  if (!allowed(url)) throw new FontFetchError(`${url.origin} is not allowed (the font proxy fetches only https, from its own list of hosts)`, true);
  const file = cachePath(url);
  try {
    return await readFile(file);
  } catch {
    // not cached yet
  }
  let p = inflight.get(file);
  if (!p) {
    p = withHostSlot(url.hostname, () => download(url))
      .then(async (body) => {
        await mkdir(DIR, { recursive: true });
        const temp = `${file}.${randomUUID()}`;
        await writeFile(temp, body);
        await rename(temp, file);
        return body;
      })
      .finally(() => inflight.delete(file));
    inflight.set(file, p);
  }
  return p;
}

async function download(start: URL): Promise<Buffer> {
  const signal = AbortSignal.timeout(30_000);
  let url = start;
  // Follow redirects by hand, so every hop is held to the same host rules.
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get("location") ?? "", url);
      if (hop >= MAX_REDIRECTS || !allowed(next)) throw new FontFetchError(`redirect to ${next.href} not allowed`, true);
      url = next;
      continue;
    }
    if (!res.ok || !res.body) throw new FontFetchError(`HTTP ${res.status}`, res.status >= 400 && res.status < 500 && res.status !== 429);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new FontFetchError(`too large (${declared} bytes)`, true);
    // Count bytes as they arrive and stop early, rather than buffering an oversized response.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new FontFetchError(`too large (over ${MAX_BYTES} bytes)`, true);
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    if (!sniff(body)) throw new FontFetchError("not a font file", true);
    return body;
  }
}

/** At most PER_HOST downloads at once per host, so scrolling fast does not hammer a small site. */
async function withHostSlot<T>(host: string, task: () => Promise<T>): Promise<T> {
  if ((active.get(host) ?? 0) >= PER_HOST) {
    // Wait for a finishing download to hand its slot over (the count stays the same).
    await new Promise<void>((resolve) => queues.set(host, [...(queues.get(host) ?? []), resolve]));
  } else {
    active.set(host, (active.get(host) ?? 0) + 1);
  }
  try {
    return await task();
  } finally {
    const next = queues.get(host)?.shift();
    if (next) next();
    else active.set(host, (active.get(host) ?? 1) - 1);
  }
}

/** The font's content type from its first four bytes, or null when they are not a font's. */
export function sniff(body: Buffer): string | null {
  if (body.length < 4) return null;
  const sig = body.subarray(0, 4).toString("latin1");
  if (sig === "wOF2") return "font/woff2";
  if (sig === "wOFF") return "font/woff";
  if (sig === "OTTO") return "font/otf";
  if (sig === "true" || body.readUInt32BE(0) === 0x00010000) return "font/ttf";
  return null;
}
