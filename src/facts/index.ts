// Font facts in the browser: parse the bytes fonts.ts already downloaded with fontkit, once per
// face, and keep the result. fontkit (about 350 KB) is imported on first use, so it stays out of
// the main bundle and costs nothing until something asks for facts.
import type { Font } from "fontkit";
import { catalogFonts } from "../catalog";
import { fileVariant, fontBytes, fontExtAbsent, fontExtBytes, hasExtFile, inLatinExt, nearestWeight, type FontVariant } from "../fonts";
import type { FontEntry } from "../types";
import { canvasMeasurer, NO_GLYPH } from "./canvas";
import { computeFacts, createMeasurer, withVariation } from "./core";
import { Lru } from "./lru";
import type { FontFacts, Measurer, Variation } from "./types";

export interface FactsResult {
  facts: FontFacts;
  measurer: Measurer;
  /**
   * fontkit's parsed font, for outlines (pathFor) and feature checks (changedBy). For a variable
   * file it is the instance at the weight the browser draws, so outlines match the measurer.
   */
  parsed: Font;
}

interface Entry {
  promise: Promise<FactsResult | null>;
  /** Set once the promise settles, so hooks can render known facts without a blank frame. */
  value?: FactsResult | null;
}

/** How many mounted views hold each face (see holdFacts). Held faces are never evicted. */
const holds = new Map<string, number>();
const cache = new Lru<string, Entry>(200, (key) => holds.has(key));
let fontkit: Promise<typeof import("fontkit")> | null = null;

function loadFontkit(): Promise<typeof import("fontkit")> {
  fontkit ??= import("fontkit").catch((err) => {
    fontkit = null; // a failed chunk load (dev server restart) may work next time
    throw err;
  });
  return fontkit;
}

function keyOf(font: FontEntry, weight: number, variant: FontVariant): string {
  // 'full' names a separate file only for Google families; elsewhere it is the web face, parsed once.
  return `${font.id}@${nearestWeight(font, weight)}@${fileVariant(font, variant)}`;
}

/**
 * Facts and a measurer for one face, or null for installed fonts (no file to read), missing files
 * and files fontkit cannot parse. Fetches the file only if fonts.ts does not already hold it.
 */
export function getFacts(font: FontEntry, weight: number, variant: FontVariant = "web"): Promise<FactsResult | null> {
  if (font.source === "local") return Promise.resolve(null);
  const key = keyOf(font, weight, variant);
  const hit = cache.get(key);
  if (hit) return hit.promise;

  const entry: Entry = { promise: Promise.resolve(null) };
  // A failed download or chunk load may work later, so those nulls are not remembered.
  const forget = () => {
    if (cache.get(key) === entry) cache.delete(key);
    return null;
  };
  entry.promise = (async () => {
    const buf = await fontBytes(font, weight, variant);
    if (!buf) return forget();
    let fk: typeof import("fontkit");
    try {
      fk = await loadFontkit();
    } catch (err) {
      console.warn("could not load fontkit", err);
      return forget();
    }
    return inTurn(() => {
      try {
        // The browser build reads any Uint8Array; the typings only know Node's Buffer.
        const created = fk.create(new Uint8Array(buf) as unknown as Buffer);
        const file = "fonts" in created ? created.fonts[0] : created;
        const parsed = withVariation(file, drawnVariation(file, nearestWeight(font, weight)));
        const facts = computeFacts(parsed);
        const measurer = createMeasurer(parsed, facts);
        // The first layout builds fontkit's shaping tables for the font. Doing it here keeps that
        // cost in this yielded task instead of inside the first render that measures a name.
        measurer.run("Hxa", { size: 16 });
        return { facts, measurer, parsed };
      } catch (err) {
        // The same bytes fail the same way, so this null stays cached.
        console.warn(`could not read font facts for ${font.family} ${weight}`, err);
        return null;
      }
    });
  })();
  entry.promise.then((value) => {
    entry.value = value;
    notify(key);
  });
  cache.set(key, entry);
  return entry.promise;
}

/** The facts when they are already parsed, null when they are known to be unavailable, undefined while unknown. */
export function peekFacts(font: FontEntry, weight: number, variant: FontVariant = "web"): FactsResult | null | undefined {
  if (font.source === "local") return null;
  return cache.get(keyOf(font, weight, variant))?.value;
}

/**
 * Keeps one face's facts cached, however many other faces are parsed meanwhile, until the returned
 * function is called. The hooks hold the face of every mounted view, so a grid with more cards than
 * the cache has room for never parses or downloads a face twice, and a sweep over the grid's faces
 * finds them all. Hold before calling getFacts, so a parse still under way is kept too.
 */
export function holdFacts(font: FontEntry, weight: number, variant: FontVariant = "web"): () => void {
  if (font.source === "local") return () => {};
  const key = keyOf(font, weight, variant);
  holds.set(key, (holds.get(key) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holds.get(key) ?? 1) - 1;
    if (left > 0) holds.set(key, left);
    else holds.delete(key);
  };
}

/**
 * The axis values the browser draws a variable file at: wght at the weight drawn (clamped to the
 * font's range). A web face declares that one weight; a Google full variable file declares its whole
 * range, and the browser then takes wght from the font-weight it draws at, which is the same number.
 * fontkit would otherwise read the file's default instance, which can be a different weight entirely
 * (Kikuta's default is wght 1). Measuring and outlines both use this instance.
 */
function drawnVariation(file: Font, weight: number): Variation | null {
  const wght = file.variationAxes?.wght;
  if (!wght) return null;
  const value = Math.min(wght.max, Math.max(wght.min, weight));
  return value === wght.default ? null : { wght: value };
}

// Parsing a face takes a few milliseconds (WOFF2 decompression, glyph boxes, shaping tables).
// A screenful of cards arriving at once would add up to a long freeze, so faces are parsed one at
// a time with a yield to the browser before each, keeping scrolling and input responsive.
let queue: Promise<unknown> = Promise.resolve();

function inTurn<T>(work: () => T): Promise<T> {
  const next = queue.then(yieldToBrowser).then(work);
  queue = next.catch(() => undefined);
  return next;
}

function yieldToBrowser(): Promise<void> {
  // A message posts a fresh task without the 4 ms clamp that chained setTimeout calls get.
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

// --- latin-ext ---
// A Fontsource face is two files once a name needs letters beyond Latin-1 (fonts.ts ensureFontExt).
// What the face can set is then the union of both cmaps, and a run that uses the second file is
// measured with the canvas, which sees both FontFaces, because fontkit only has the first.

interface ExtEntry {
  promise: Promise<ReadonlySet<number> | null>;
  /** The latin-ext file's code points; null when there is none. Set once the promise settles. */
  value?: ReadonlySet<number> | null;
  /** A failed download (not a 404) is tried again after this time (ms timestamp). */
  retryAt?: number;
}

// Faces a mounted view holds keep their entry too, so a card never falls back to marking those letters missing.
const extCoverage = new Lru<string, ExtEntry>(200, (key) => holds.has(key));
const listeners = new Map<string, Set<() => void>>();

/**
 * Calls `cb` whenever what is known about a face changes: its facts finish parsing, or its
 * latin-ext file has been read (or turned out not to exist). Returns an unsubscribe function.
 */
export function onFaceChange(font: FontEntry, weight: number, variant: FontVariant, cb: () => void): () => void {
  const key = keyOf(font, weight, variant);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (!set.size && listeners.get(key) === set) listeners.delete(key);
  };
}

function notify(key: string) {
  listeners.get(key)?.forEach((cb) => cb());
}

/**
 * The face's latin-ext code points: a set once read, null when it has none (for good), undefined
 * while unknown, not asked for yet, or after a failed download that may still work later.
 */
export function peekExt(font: FontEntry, weight: number, variant: FontVariant = "web"): ReadonlySet<number> | null | undefined {
  // A Google full file carries latin-ext itself; only the web subset has a second file.
  if (fileVariant(font, variant) !== "web" || !hasExtFile(font)) return null;
  const entry = extCoverage.get(keyOf(font, weight, "web"));
  return entry?.retryAt ? undefined : entry?.value;
}

/** Loads and reads the latin-ext file once per face. Safe to call during a render: the work starts in a microtask. */
function requestExt(font: FontEntry, weight: number) {
  const key = keyOf(font, weight, "web");
  const hit = extCoverage.get(key);
  if (hit && !(hit.retryAt && Date.now() > hit.retryAt)) return;
  const entry: ExtEntry = { promise: Promise.resolve(null) };
  entry.promise = (async () => {
    await Promise.resolve();
    const buf = await fontExtBytes(font, weight);
    if (!buf) {
      if (!fontExtAbsent(font, weight)) entry.retryAt = Date.now() + 60_000;
      return null;
    }
    let fk: typeof import("fontkit");
    try {
      fk = await loadFontkit();
    } catch {
      entry.retryAt = Date.now() + 60_000;
      return null;
    }
    return inTurn(() => {
      try {
        const created = fk.create(new Uint8Array(buf) as unknown as Buffer);
        const file = "fonts" in created ? created.fonts[0] : created;
        return new Set(file.characterSet);
      } catch (err) {
        console.warn(`could not read the latin-ext file of ${font.family}`, err);
        return null;
      }
    });
  })();
  entry.promise.then((value) => {
    entry.value = value;
    notify(key);
  });
  extCoverage.set(key, entry);
}

/** Every character of the text (as the browser composes it) has a glyph in `covers`. */
function coversRun(covers: (ch: string) => boolean, text: string): boolean {
  for (const ch of text.normalize("NFC")) if (!NO_GLYPH.test(ch) && !covers(ch)) return false;
  return true;
}

export interface Faced {
  facts: FontFacts;
  measurer: Measurer;
}

const faced = new WeakMap<FactsResult, { ext: ReadonlySet<number> | null | undefined; value: Faced }>();

/**
 * The facts and measurer views should use: the face's own, with its latin-ext file folded in for
 * Fontsource faces. Until that file is known, the measurer starts loading it the first time a run
 * has a letter only latin-ext could draw (so names in plain Latin never fetch it), and measures with
 * the latin file meanwhile, which marks those letters missing. Once it is read, `covers` answers for
 * both files and each run is measured by fontkit when the latin file covers it, by the canvas
 * otherwise. The same objects come back while nothing changes, so they are safe as memo keys.
 */
export function withExt(font: FontEntry, weight: number, variant: FontVariant, result: FactsResult): Faced {
  const ext = peekExt(font, weight, variant);
  if (ext === null) return result;
  const hit = faced.get(result);
  if (hit && hit.ext === ext) return hit.value;
  const { facts, measurer: primary } = result;
  let value: Faced;
  if (ext === undefined) {
    const wants = (text: string) => {
      for (const ch of text.normalize("NFC")) {
        const cp = ch.codePointAt(0)!;
        if (cp > 0xff && inLatinExt(cp) && !facts.covers(ch)) return true;
      }
      return false;
    };
    value = {
      facts,
      measurer: {
        ...primary,
        run(text, opts) {
          if (wants(text)) requestExt(font, weight);
          return primary.run(text, opts);
        },
      },
    };
  } else {
    const covers = (ch: string) => {
      for (const c of ch) if (!facts.covers(c) && !ext.has(c.codePointAt(0)!)) return false;
      return true;
    };
    const canvas = canvasMeasurer(font, weight, "web", { covers, tag: "+ext" });
    value = {
      facts: { ...facts, covers },
      measurer: {
        ...primary,
        run: (text, opts) => (coversRun(facts.covers, text) ? primary.run(text, opts) : canvas.run(text, opts)),
      },
    };
  }
  faced.set(result, { ext, value });
  return value;
}

/** How many faces are parsed and kept, and how many of those mounted views hold. For dev checks on memory. */
export function factsStats(): { parsed: number; held: number } {
  return { parsed: cache.size, held: holds.size };
}

let catalog: Promise<FontEntry[]> | null = null;

/** Backs the dev console helper `__fx.facts(id, weight)` installed by fonts.ts. */
export async function devFacts(id: string, weight = 400): Promise<FontFacts | null> {
  if (id.startsWith("local:")) {
    console.info("Installed fonts have no file to read, so they have no facts (the canvas measurer covers them).");
    return null;
  }
  // The page's own loader: the server's catalogue locally, catalog.json in the online build.
  catalog ??= catalogFonts().catch((err) => {
    catalog = null;
    throw err;
  });
  const font = (await catalog).find((f) => f.id === id);
  if (!font) throw new Error(`No font with id "${id}" in the catalog.`);
  return (await getFacts(font, weight))?.facts ?? null;
}
