import { STATIC } from "./env";
import { Lru } from "./facts/lru";
import { fullFileFor, lookupGoogleFiles, type GoogleFamilyFiles } from "./googleMetadata";
import { italicWeightsOf } from "./italic";
import type { FontEntry, Source } from "./types";

/**
 * 'web' is the file the grid loads (for Google fonts, Fontsource's latin subset). 'full' is the
 * font's complete upstream file, with every stylistic set, loaded one font at a time by the
 * lightbox and Compare. Only Google families have a separate full file (see fileVariant).
 */
export type FontVariant = "web" | "full";

/**
 * The face is drawn from Fontsource's cut-down web files, their URLs built from `ref`: a Google
 * family, upright or its own italic. Not a Google family's italic borrowed from another source's
 * row (italicFrom): that one lists its files, each that source's complete file.
 */
function fromFontsource(f: FontEntry): boolean {
  return f.source === "fontsource" && !f.files;
}

/**
 * The file a variant really names. Every source but Google already serves its complete file, so
 * 'full' is 'web' there: the same face, loaded and parsed once.
 */
export function fileVariant(f: FontEntry, variant: FontVariant): FontVariant {
  return variant === "full" && fromFontsource(f) ? "full" : "web";
}

const loaded = new Map<string, Promise<boolean>>();
const loadedSync = new Set<string>();
/** When a failed face may be tried again (ms timestamp). */
const failedUntil = new Map<string, number>();
const RETRY_AFTER_MS = 60_000;

// The file bytes behind each loaded face, so font facts and outlines read the same download the
// browser renders from instead of fetching again. Evicting bytes keeps the FontFace; a later
// fontBytes call fetches the file again, which the browser's HTTP cache usually answers.
const bytes = new Lru<string, ArrayBuffer>(400);
const bytesInflight = new Map<string, Promise<ArrayBuffer>>();
const loadListeners = new Map<string, Set<() => void>>();

/**
 * Remote fonts get a private family name so a local copy with the same name never wins. A family's
 * italic shares its upright's name; its FontFaces say style 'italic', so CSS font-style picks it.
 */
export function faceName(f: FontEntry, variant: FontVariant = "web"): string {
  if (f.source === "local") return f.family;
  const base = `fx-${uprightOf(f).id.replace(/[^a-zA-Z0-9-]/g, "-")}`;
  return fileVariant(f, variant) === "full" ? `${base}-full` : base;
}

export function fontStack(f: FontEntry, variant: FontVariant = "web"): string {
  return `"${faceName(f, variant)}", sans-serif`;
}

export function nearestWeight(f: FontEntry, wanted: number): number {
  if (f.source === "local" || !f.weights.length) return wanted;
  return f.weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), f.weights[0]);
}

/**
 * Where a face's file comes from, or null when there is none: local fonts, and a Google full file
 * before resolveFull has found it (or after it found none).
 */
export function fontUrl(f: FontEntry, weight: number, variant: FontVariant = "web"): string | null {
  if (f.source === "local") return null;
  if (fileVariant(f, variant) === "full") {
    const file = fullFile(f, weight);
    return file ? viaProxy(file.url, true) : null;
  }
  if (fromFontsource(f) && f.ref) {
    return `https://cdn.jsdelivr.net/fontsource/fonts/${f.ref}@latest/latin-${weight}-${fontStyle(f)}.woff2`;
  }
  const url = f.files?.[weight];
  if (!url) return null;
  return viaProxy(url, !!f.proxy);
}

/**
 * A file the local app loads through its server's font proxy (hosts without CORS or with the wrong
 * content type, and Google's repository). The online build has no server: its catalogue already
 * points at copies the site hosts itself, and Google's repository answers with CORS, so every URL
 * there is used as it is.
 */
function viaProxy(url: string, proxy: boolean): string {
  return proxy && !STATIC ? `/api/font?url=${encodeURIComponent(url)}` : url;
}

function keyOf(f: FontEntry, weight: number, variant: FontVariant): string {
  return `${f.id}@${weight}@${fileVariant(f, variant)}`;
}

/**
 * Where a face's bytes are kept. A Google variable file serves every weight from one download, so
 * its bytes are kept by URL: asking for 400 and then 700 fetches it once.
 */
function bytesKey(f: FontEntry, weight: number, variant: FontVariant, url: string): string {
  return fileVariant(f, variant) === "full" ? `full:${url}` : keyOf(f, weight, variant);
}

export function isFontLoaded(f: FontEntry, weight: number, variant: FontVariant = "web"): boolean {
  return f.source === "local" || loadedSync.has(keyOf(f, nearestWeight(f, weight), variant));
}

/**
 * Calls `cb` once, when that face finishes loading through ensureFont. It never starts a load
 * itself, so facts can follow a card's own loading instead of fetching for cards off screen.
 * Returns an unsubscribe function.
 */
export function onFontLoaded(f: FontEntry, weight: number, variant: FontVariant, cb: () => void): () => void {
  const key = keyOf(f, nearestWeight(f, weight), variant);
  let set = loadListeners.get(key);
  if (!set) loadListeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (!set.size && loadListeners.get(key) === set) loadListeners.delete(key);
  };
}

function fetchBytes(key: string, url: string): Promise<ArrayBuffer> {
  const hit = bytes.get(key);
  if (hit) return Promise.resolve(hit);
  let p = bytesInflight.get(key);
  if (!p) {
    p = fetch(url)
      .then((res) => {
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        return res.arrayBuffer();
      })
      .then((buf) => {
        bytes.set(key, buf);
        return buf;
      })
      .finally(() => bytesInflight.delete(key));
    bytesInflight.set(key, p);
  }
  return p;
}

/**
 * The face's file bytes: the copy ensureFont downloaded, or a fresh fetch when it has been evicted
 * or never loaded. Null for local fonts, missing URLs and failed downloads. Treat the buffer as
 * read-only; it is shared.
 */
export async function fontBytes(f: FontEntry, weight: number, variant: FontVariant = "web"): Promise<ArrayBuffer | null> {
  const w = nearestWeight(f, weight);
  if (fileVariant(f, variant) === "full" && !(await resolveFull(f))) return null;
  const url = fontUrl(f, w, variant);
  if (!url) return null;
  try {
    return await fetchBytes(bytesKey(f, w, variant, url), url);
  } catch {
    return null;
  }
}

/** Resolves true once the face is usable. Local fonts are already installed. */
export function ensureFont(f: FontEntry, wanted: number, variant: FontVariant = "web"): Promise<boolean> {
  if (f.source === "local") return Promise.resolve(true);
  const weight = nearestWeight(f, wanted);
  const key = keyOf(f, weight, variant);
  let p = loaded.get(key);
  if (!p && (failedUntil.get(key) ?? 0) > Date.now()) return Promise.resolve(false);
  if (!p && fileVariant(f, variant) === "full") {
    p = ensureFull(f, weight, key);
    loaded.set(key, p);
  }
  if (!p) {
    const url = fontUrl(f, weight, variant);
    p = url
      ? fetchBytes(key, url)
          // The FontFace gets its own copy: the browser may detach the buffer it is handed, and
          // fontkit must keep reading ours. No format hint either: indie sources serve woff, ttf
          // and otf too, and the browser sniffs the bytes.
          .then((buf) => new FontFace(faceName(f, variant), buf.slice(0), { weight: String(weight), style: fontStyle(f) }).load())
          .then((face) => {
            document.fonts.add(face);
            loadedSync.add(key);
            const listeners = loadListeners.get(key);
            loadListeners.delete(key);
            listeners?.forEach((cb) => cb());
            return true;
          })
          .catch((err) => {
            console.warn(`could not load ${f.family} ${weight}`, err);
            // Forget the failure after a minute, so the card can try again when it next scrolls into view.
            loaded.delete(key);
            bytes.delete(key);
            failedUntil.set(key, Date.now() + RETRY_AFTER_MS);
            return false;
          })
      : Promise.resolve(false);
    loaded.set(key, p);
  }
  return p;
}

/**
 * Loads the nearest weight that works and returns it, or null when none of the three nearest load.
 * A single bad file upstream (WebKit rejects Open Sauce Sans Regular, for one) then costs one weight,
 * not the whole card.
 */
export async function ensureNearestFont(f: FontEntry, wanted: number, variant: FontVariant = "web"): Promise<number | null> {
  if (f.source === "local" || !f.weights.length) return wanted;
  for (const w of nearestWeights(f, wanted)) if (await ensureFont(f, w, variant)) return w;
  return null;
}

/** The three weights ensureNearestFont tries, in its order: nearest first, the lighter of two equally near. */
export function nearestWeights(f: FontEntry, wanted: number): number[] {
  return [...f.weights].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b).slice(0, 3);
}

// --- italics ---
// A family's italic is drawn as a face of its own: a FontEntry made from the family's, whose
// weights are its italic weights and whose files are its italic files, with '#italic' on its id.
// Every cache here and in facts/ is keyed by that id, so the bytes, the facts, the measurer, the
// alternates and the outlines of an italic all come from the italic file. In CSS it shares the
// upright's family name, with style 'italic' on its FontFaces. Nothing is ever slanted to stand in
// for a missing italic: a family without one is drawn upright (and its card says so).

const italics = new WeakMap<FontEntry, FontEntry>();
const uprights = new WeakMap<FontEntry, FontEntry>();

/**
 * The family's italic, or null when the catalogue lists none. The same object comes back every
 * time, so it is safe as a memo key. An installed font always gets one: its installed italic is
 * asked for through CSS font-style, and whether there is one nobody can tell.
 */
export function italicFace(f: FontEntry): FontEntry | null {
  if (uprights.has(f)) return f;
  const known = italics.get(f);
  if (known) return known;
  const weights = f.source === "local" ? f.weights : italicWeightsOf(f);
  if (f.source !== "local" && !weights.length) return null;
  // An italic borrowed from another source's row keeps that source's loading rule (italicProxy).
  const proxy = f.italicProxy ?? f.proxy;
  const face: FontEntry = { ...f, id: `${f.id}#italic`, weights, files: f.italicFiles, proxy, italicWeights: undefined, italicFiles: undefined };
  italics.set(f, face);
  uprights.set(face, f);
  return face;
}

export function isItalicFace(f: FontEntry): boolean {
  return uprights.has(f);
}

/**
 * Where a drawn italic came from when the family's own row had none and it was borrowed from
 * another source's release of the family (the catalogue's italicFrom). Null for everything else,
 * so labels name it only when the file drawn is not the row's own.
 */
export function borrowedFrom(face: FontEntry): Source | null {
  return (isItalicFace(face) && face.italicFrom) || null;
}

/** The family's upright: itself for an upright face. */
export function uprightOf(f: FontEntry): FontEntry {
  return uprights.get(f) ?? f;
}

/** The CSS font-style (and FontFace style) a face is drawn with. */
export function fontStyle(f: FontEntry): "normal" | "italic" {
  return uprights.has(f) ? "italic" : "normal";
}

/** The face a setting draws before anything has loaded: the italic when one is asked for and listed. */
export function drawnFace(f: FontEntry, italic: boolean): FontEntry {
  return (italic && italicFace(f)) || f;
}

/**
 * Loads the face a setting draws and returns it with the weight that loaded: the family's italic at
 * the nearest italic weight when `italic` is asked for and the family has one, the upright
 * otherwise. An italic that will not load counts as no italic at that weight, so the upright is
 * drawn instead. Null when nothing loads.
 */
export async function ensureFace(f: FontEntry, wanted: number, italic: boolean, variant: FontVariant = "web"): Promise<{ face: FontEntry; weight: number } | null> {
  const it = italic ? italicFace(f) : null;
  if (it) {
    const weight = await ensureNearestFont(it, wanted, variant);
    if (weight !== null) return { face: it, weight };
  }
  const weight = await ensureNearestFont(f, wanted, variant);
  return weight === null ? null : { face: f, weight };
}

/**
 * An italic was asked for and the face drawn is the upright: the family has none (or it would not
 * load). Never for installed fonts, whose italics are unknown.
 */
export function lacksItalic(face: FontEntry, italic: boolean | undefined): boolean {
  return !!italic && face.source !== "local" && !isItalicFace(face);
}

// --- latin-ext ---
// Fontsource splits each Google family into subsets and the grid loads only 'latin' (Latin-1 plus
// a few extras), so Ł, ő or ș would quietly come from the system sans. When a name needs one of
// those letters, the family's latin-ext file loads as a second FontFace under the same family name,
// limited to its range, and the browser takes those letters from it. Other sources serve the whole
// file already, so whatever their file lacks is really missing.

/** Google's latin-ext range, as Google Fonts and Fontsource declare it for that file. */
export const LATIN_EXT_RANGE =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

const LATIN_EXT_SPANS = LATIN_EXT_RANGE.split(", ").map((part) => {
  const [lo, hi = lo] = part.slice(2).split("-");
  return [parseInt(lo, 16), parseInt(hi, 16)] as const;
});

/** True when the latin-ext file would be the one to draw this code point. */
export function inLatinExt(cp: number): boolean {
  return LATIN_EXT_SPANS.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * The family has a latin-ext file to try (Fontsource only; it may still turn out not to exist). A
 * borrowed italic is another source's whole file, so it has none.
 */
export function hasExtFile(f: FontEntry): boolean {
  return fromFontsource(f) && !!f.ref;
}

const extLoaded = new Map<string, Promise<boolean>>();
/** Faces whose family Fontsource has no latin-ext file for (it answered 404). */
const extAbsent = new Set<string>();

function extKey(f: FontEntry, weight: number): string {
  return `${keyOf(f, weight, "web")}+ext`;
}

function extUrl(f: FontEntry, weight: number): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${f.ref}@latest/latin-ext-${weight}-${fontStyle(f)}.woff2`;
}

/**
 * Loads the family's latin-ext file at the nearest weight and adds it beside the latin face.
 * Resolves true once the browser can draw from it, false when there is none: sources other than
 * Fontsource, and families Fontsource has no latin-ext file for (a 404, remembered for the session,
 * because then those letters really are missing). Other failures may work again after a minute.
 */
export function ensureFontExt(f: FontEntry, wanted: number): Promise<boolean> {
  if (!hasExtFile(f)) return Promise.resolve(false);
  const weight = nearestWeight(f, wanted);
  const key = extKey(f, weight);
  let p = extLoaded.get(key);
  if (!p && (failedUntil.get(key) ?? 0) > Date.now()) return Promise.resolve(false);
  if (!p) {
    p = fetchBytes(key, extUrl(f, weight))
      .then((buf) =>
        new FontFace(faceName(f), buf.slice(0), { weight: String(weight), style: fontStyle(f), unicodeRange: LATIN_EXT_RANGE }).load(),
      )
      .then((face) => {
        document.fonts.add(face);
        return true;
      })
      .catch((err: unknown) => {
        bytes.delete(key);
        if ((err as { status?: number }).status === 404) extAbsent.add(key);
        else {
          console.warn(`could not load the latin-ext file of ${f.family} ${weight}`, err);
          extLoaded.delete(key);
          failedUntil.set(key, Date.now() + RETRY_AFTER_MS);
        }
        return false;
      });
    extLoaded.set(key, p);
  }
  return p;
}

/** True once Fontsource has answered that the family has no latin-ext file (as opposed to a failed download). */
export function fontExtAbsent(f: FontEntry, weight: number): boolean {
  return extAbsent.has(extKey(f, nearestWeight(f, weight)));
}

/** The latin-ext file's bytes once ensureFontExt has loaded it (refetched if evicted), else null. */
export async function fontExtBytes(f: FontEntry, weight: number): Promise<ArrayBuffer | null> {
  const w = nearestWeight(f, weight);
  if (!(await ensureFontExt(f, w))) return null;
  try {
    return await fetchBytes(extKey(f, w), extUrl(f, w));
  } catch {
    return null;
  }
}

// --- Google full files ---
// Fontsource's web files are cut down for the web and may lose a family's stylistic sets, so a
// Google font with alternates switched on is drawn from the file in Google's own repository. The
// local server finds it (/api/google-files, from the family's METADATA.pb) and the font proxy
// fetches and keeps it. The online build has no server, so the page reads METADATA.pb and the file
// from the repository itself (googleMetadata.ts lookupGoogleFiles). Only the lightbox and Compare
// ask for it, one font at a time.

/**
 * Per family (the upright's font id, which its italic shares): the answer, or null when Google's
 * repository has no such family. Missing while unknown.
 */
const fullInfo = new Map<string, GoogleFamilyFiles | null>();
const fullLookups = new Map<string, Promise<GoogleFamilyFiles | null>>();

/**
 * Finds the family's files in Google's repository, once per family. Null when it is not there (some
 * families are renamed or live elsewhere): remembered, because asking again finds nothing new. A
 * failed request is not remembered, so the next ask tries again.
 */
export function resolveFull(f: FontEntry): Promise<GoogleFamilyFiles | null> {
  if (!fromFontsource(f)) return Promise.resolve(null);
  const id = uprightOf(f).id;
  if (fullInfo.has(id)) return Promise.resolve(fullInfo.get(id) ?? null);
  let p = fullLookups.get(id);
  if (!p) {
    p = (STATIC ? lookupGoogleFiles(f.family) : askServer(f.family))
      .then((info) => {
        fullInfo.set(id, info);
        return info;
      })
      .catch((err) => {
        console.warn(`could not look up the full file of ${f.family}`, err);
        return null;
      })
      .finally(() => fullLookups.delete(id));
    fullLookups.set(id, p);
  }
  return p;
}

/** The local server's lookup (server/googleFiles.ts), which keeps every answer on disk. */
async function askServer(family: string): Promise<GoogleFamilyFiles | null> {
  const res = await fetch(`/api/google-files?family=${encodeURIComponent(family)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as GoogleFamilyFiles;
}

/** The family has no full file: Google's repository was asked and does not have it. */
export function fullAbsent(f: FontEntry): boolean {
  const id = uprightOf(f).id;
  return fromFontsource(f) && fullInfo.has(id) && fullInfo.get(id) === null;
}

/**
 * Google's repository has the family but no full file in this face's style: an italic face of a family
 * whose METADATA.pb lists no italic file. Its alternates can then only come from the web file.
 */
export function fullStyleAbsent(f: FontEntry, weight: number): boolean {
  return fromFontsource(f) && !!fullInfo.get(uprightOf(f).id) && !fullFile(f, weight);
}

/**
 * The full file for a weight, once resolveFull has answered, in the face's style: the static file
 * nearest the weight, or else the variable file (googleMetadata.ts fullFileFor). A variable file
 * declares its whole weight range, so the browser sets its wght axis from the font-weight it is
 * drawn at (facts/index.ts reads the same instance). An italic face takes the italic file, and has
 * none when METADATA.pb lists no italic.
 */
function fullFile(f: FontEntry, weight: number): { url: string; weight: string } | null {
  const info = fullInfo.get(uprightOf(f).id);
  return info ? fullFileFor(info, weight, fontStyle(f)) : null;
}

/** Full faces by file and weight descriptor: one variable file serves every weight with one FontFace. */
const fullFaces = new Map<string, Promise<void>>();

function ensureFull(f: FontEntry, weight: number, key: string): Promise<boolean> {
  return resolveFull(f).then((info) => {
    const file = info && fullFile(f, weight);
    const url = fontUrl(f, weight, "full");
    if (!file || !url) {
      // Not in Google's repository, or no file in this style there: final. A failed lookup may work later.
      if (!info && !fullAbsent(f)) {
        loaded.delete(key);
        failedUntil.set(key, Date.now() + RETRY_AFTER_MS);
      }
      return false;
    }
    const bk = bytesKey(f, weight, "full", url);
    const faceKey = `${bk}|${file.weight}`;
    let face = fullFaces.get(faceKey);
    if (!face) {
      face = fetchBytes(bk, url)
        .then((buf) => new FontFace(faceName(f, "full"), buf.slice(0), { weight: file.weight, style: fontStyle(f) }).load())
        .then((loadedFace) => {
          document.fonts.add(loadedFace);
        });
      fullFaces.set(faceKey, face);
    }
    return face.then(
      () => {
        loadedSync.add(key);
        const listeners = loadListeners.get(key);
        loadListeners.delete(key);
        listeners?.forEach((cb) => cb());
        return true;
      },
      (err) => {
        console.warn(`could not load the full file of ${f.family} ${weight}`, err);
        fullFaces.delete(faceKey);
        loaded.delete(key);
        bytes.delete(bk);
        failedUntil.set(key, Date.now() + RETRY_AFTER_MS);
        return false;
      },
    );
  });
}

// Console helper in development: `await __fx.facts('fontsource:inter', 400)`. The facts module (and
// fontkit with it) loads only when the helper is first called, so the grid's first paint is untouched.
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__fx = {
    ...window.__fx,
    facts: (id: string, weight = 400) => import("./facts/index").then((m) => m.devFacts(id, weight)),
  };
}

declare global {
  interface Window {
    /** Development-only console helpers. Features add their own entries next to `facts`. */
    __fx?: Record<string, unknown>;
  }
}
