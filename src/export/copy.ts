// Copy as outlines, in the browser. A wordmark on screen is copied from the layout it drew (the
// card's, the lightbox stage's, Compare's large column), with letter shapes read from the font file
// the browser drew it from, so what pastes into Figma is what was judged. The sheets lay each
// candidate out here with the same engine, then draw it the same way.
import type { Font } from "fontkit";
import { variantFor } from "../alternates";
import { missingChars, effectiveText } from "../coverage";
import { getFacts, onFaceChange, peekExt, peekFacts, withExt } from "../facts/index";
import { Lru } from "../facts/lru";
import { borrowedFrom, fontExtBytes, fontUrl, hasExtFile, inLatinExt, isItalicFace, italicFace, lacksItalic, nearestWeight, nearestWeights, type FontVariant } from "../fonts";
import { layoutFormation } from "../layout/engine";
import type { LayoutResult } from "../layout/types";
import type { Recipe } from "../recipe";
import { parseName } from "../settings";
import type { ToastOptions } from "../store";
import { SOURCE_LABELS, type FontEntry } from "../types";
import { drawnWordmark } from "../Wordmark";
import { svgFromLayout, type GlyphFonts, type Outlines } from "./outline";

export type Toast = (text: string, opts?: ToastOptions) => void;

export const LOCAL_NOTE = "Outlines need the font file; installed fonts can't be read yet.";

// --- the font files behind the outlines ---

interface ExtEntry {
  promise: Promise<Font | null>;
  /** Set once read; null when it could not be. */
  value?: Font | null;
}
const extFonts = new Lru<string, ExtEntry>(24);

/**
 * A Google family's latin-ext file, parsed, when a card has already read it: only then can a layout
 * have drawn letters from it (Ł, ő). Null when the face has no such file or no name has needed it.
 */
function extFont(font: FontEntry, weight: number, variant: FontVariant): ExtEntry | null {
  if (variant !== "web" || !hasExtFile(font) || !(peekExt(font, weight, variant) instanceof Set)) return null;
  const key = `${font.id}@${nearestWeight(font, weight)}`;
  let entry = extFonts.get(key);
  if (!entry) {
    const made: ExtEntry = {
      promise: (async () => {
        const buf = await fontExtBytes(font, weight);
        if (!buf) return null;
        try {
          const fk = await import("fontkit");
          const created = fk.create(new Uint8Array(buf) as unknown as Buffer);
          return "fonts" in created ? created.fonts[0] : created;
        } catch {
          return null;
        }
      })(),
    };
    made.promise.then((value) => (made.value = value));
    extFonts.set(key, (entry = made));
  }
  return entry;
}

/**
 * The layout drew a letter the main file has no shape for, so the browser took it from the
 * latin-ext file (Ł, ő). Only then do the outlines need that file, and only then is it worth
 * waiting for it to be parsed.
 */
function drewFromExt(primary: Font, result: LayoutResult): boolean {
  return result.runs.some((run) => [...run.text].some((ch) => ch.trim() !== "" && !primary.hasGlyphForCodePoint(ch.codePointAt(0)!)));
}

/**
 * The files for outlines when they are already parsed, so a copy can be written within the key
 * press (Safari allows the clipboard only there). Undefined while something still has to load,
 * null when the face cannot be read.
 */
function glyphFontsNow(font: FontEntry, weight: number, variant: FontVariant, result: LayoutResult): GlyphFonts | null | undefined {
  const facts = peekFacts(font, weight, variant);
  if (!facts) return facts;
  if (!drewFromExt(facts.parsed, result)) return { primary: facts.parsed, fallback: null };
  const ext = extFont(font, weight, variant);
  if (ext && ext.value === undefined) return undefined;
  return { primary: facts.parsed, fallback: ext?.value ?? null };
}

async function glyphFonts(font: FontEntry, weight: number, variant: FontVariant, result: LayoutResult): Promise<GlyphFonts | null> {
  const facts = await getFacts(font, weight, variant);
  if (!facts) return null;
  const ext = drewFromExt(facts.parsed, result) ? extFont(font, weight, variant) : null;
  return { primary: facts.parsed, fallback: ext ? await ext.promise : null };
}

/**
 * The upstream file the outlines come from, for the SVG's description and the JSON export: not this
 * app's local proxy, and not the online build's own copy of the file (the catalogue keeps the
 * original's address in `upstream`).
 */
export function fileUrlOf(font: FontEntry, weight: number, variant: FontVariant): string | null {
  const url: unknown = fontUrl(font, nearestWeight(font, weight), variant);
  if (typeof url !== "string") return null;
  const proxied = /^\/api\/font\?url=(.*)$/.exec(url);
  return proxied ? decodeURIComponent(proxied[1]) : (font.upstream?.[url] ?? url);
}

/**
 * The source as the description and the sheet's labels name it, from the face drawn: an italic
 * borrowed from another source's release says so.
 */
export function sourceText(font: FontEntry): string {
  const from = borrowedFrom(font);
  return from ? `${SOURCE_LABELS[font.source]}, italic from ${SOURCE_LABELS[from]}` : SOURCE_LABELS[font.source];
}

export interface OutlineJob {
  /** The face drawn: the family's italic (fonts.ts italicFace) when the view drew one, so its outlines come from the italic file. */
  font: FontEntry;
  /** The weight drawn. */
  weight: number;
  variant: FontVariant;
  result: LayoutResult;
  recipe: Recipe;
}

/** Outlines plus what the toast should add: letters left out, and why. */
export interface CopiedOutlines extends Outlines {
  notes: string[];
  fileName: string;
}

function buildOutlines(job: OutlineJob, fonts: GlyphFonts): CopiedOutlines {
  const { font, weight, variant, result } = job;
  // The file and its description say what was drawn: italic only when the face is the family's italic.
  const recipe = { ...job.recipe, italic: isItalicFace(font) };
  const parsed = peekFacts(font, weight, variant);
  const facts = parsed ? withExt(font, weight, variant, parsed).facts : null;
  // The name as the face set it: a caps-only face draws it in capitals, so the layer says so too.
  const shown = effectiveText(font, facts, recipe);
  const out = svgFromLayout(result, fonts, {
    family: font.family,
    source: sourceText(font),
    license: font.license,
    homepage: font.homepage,
    fileUrl: fileUrlOf(font, weight, variant),
    weight,
    recipe: { ...recipe, weight },
    name: shown.flat,
    shownInCaps: shown.shownInCaps,
  });
  const notes: string[] = [];
  if (out.placeholders) {
    // Name the letters when the face's coverage is known; the card's badge names the same ones.
    const text = `${parseName(recipe).flat}${recipe.layout.formation === "lockup" ? recipe.layout.lockup.descriptor : ""}`;
    const lacking = facts ? missingChars(facts, text) : [];
    notes.push(`Left out ${lacking.length ? lacking.join(" ") : `${out.placeholders} letter${out.placeholders === 1 ? "" : "s"}`}: the font has no glyph for ${out.placeholders === 1 ? "it" : "them"}.`);
  }
  if (out.unshaped.length) notes.push(`Left out ${out.unshaped.join(" ")}: no outline in the font file.`);
  if (lacksItalic(font, job.recipe.italic)) notes.push(`${font.family} has no italic here, so the outlines are upright.`);
  return { ...out, notes, fileName: svgFileName(font, weight, recipe) };
}

/** Outlines for a layout, or null for installed fonts and files that cannot be read. */
export async function layoutToSvg(font: FontEntry, weight: number, variant: FontVariant, result: LayoutResult, recipe: Recipe): Promise<CopiedOutlines | null> {
  if (font.source === "local") return null;
  const fonts = await glyphFonts(font, weight, variant, result);
  return fonts && buildOutlines({ font, weight, variant, result, recipe }, fonts);
}

// --- clipboard and files ---

/**
 * Puts the layout on the clipboard as outlines and says so in a toast, which also offers the file
 * in case pasting fails. The face is normally parsed already (the view drew from its file), so the
 * SVG is built and written inside the key press, as Safari requires; otherwise after loading it.
 */
export function copyOutlines(job: OutlineJob, toast: Toast): void {
  if (job.font.source === "local") return toast(LOCAL_NOTE);
  const now = glyphFontsNow(job.font, job.weight, job.variant, job.result);
  if (now === null) return toast("Could not read this font's file, so there are no outlines to copy.");
  if (now) return void write(buildOutlines(job, now), toast);
  void glyphFonts(job.font, job.weight, job.variant, job.result).then((fonts) =>
    fonts ? write(buildOutlines(job, fonts), toast) : toast("Could not read this font's file, so there are no outlines to copy."),
  );
}

async function write(out: CopiedOutlines, toast: Toast) {
  const download = { label: "Download SVG", run: () => downloadSvg(out.svg, out.fileName) };
  try {
    if (!navigator.clipboard) throw new Error("this page has no clipboard access");
    await navigator.clipboard.writeText(out.svg);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    toast(`Could not copy to the clipboard (${why}). Download the SVG instead.`, { ms: 15000, action: download });
    return;
  }
  toast(["Copied outlines. Paste into Figma.", ...out.notes].join(" "), { ms: out.notes.length ? 10000 : 6000, action: download });
}

/**
 * The outlines job for the layout a drawn wordmark shows, with the face, weight and file it was
 * measured in (recorded with it, so they always belong together). Undefined when there is no
 * wordmark there; null when there is but it cannot be outlined, and a toast has said why.
 */
export function drawnJob(svg: Element | null | undefined, recipe: Recipe, toast: Toast): OutlineJob | null | undefined {
  const drawn = drawnWordmark(svg);
  if (!drawn) return undefined;
  if (drawn.font.source === "local") {
    toast(LOCAL_NOTE);
    return null;
  }
  // The stand-in shown before the face loads is a guess at the shape, not the face.
  if (!drawn.real) {
    toast(`${drawn.font.family} is still loading. Copy again in a moment.`);
    return null;
  }
  return { font: drawn.font, weight: drawn.weight, variant: drawn.variant, result: drawn.result, recipe: { ...recipe, weight: drawn.weight } };
}

/**
 * ⌘C on a drawn wordmark: copies the layout that SVG element shows. False when there is no wordmark
 * there (the key then does what it normally does).
 */
export function copyDrawnWordmark(svg: Element | null | undefined, recipe: Recipe, toast: Toast): boolean {
  const job = drawnJob(svg, recipe, toast);
  if (job === undefined) return false;
  if (job) copyOutlines(job, toast);
  return true;
}

/** True while the reader has text selected: ⌘C then copies that text, as everywhere else. */
export function hasTextSelection(): boolean {
  const s = window.getSelection();
  return !!s && !s.isCollapsed && s.toString().trim() !== "";
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSvg(svg: string, name: string) {
  downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`], { type: "image/svg+xml" }), name);
}

/**
 * Letters that are not a base letter plus an accent, so taking accents off (NFKD) would drop them
 * from a file name: 'Łódź' would save as 'odz'.
 */
const SPELLED: Record<string, string> = { Ł: "L", ł: "l", Ø: "O", ø: "o", Æ: "AE", æ: "ae", Œ: "OE", œ: "oe", ß: "ss", ẞ: "SS", Đ: "D", đ: "d", Ð: "D", ð: "d", Þ: "Th", þ: "th", ı: "i", Ħ: "H", ħ: "h" };

/** e.g. 'polymodal-inter-400.svg', or 'polymodal-lora-400-italic.svg'. */
export function svgFileName(font: FontEntry, weight: number, recipe: Pick<Recipe, "text" | "textCase" | "italic">): string {
  const slug = (s: string) =>
    s
      .replace(/[ŁłØøÆæŒœßẞĐđÐðÞþıĦħ]/g, (ch) => SPELLED[ch])
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return `${[slug(parseName(recipe).flat), slug(font.family), String(weight), recipe.italic ? "italic" : ""].filter(Boolean).join("-")}.svg`;
}

// --- laying out a recipe off screen (the sheets) ---

export interface LaidOut {
  result: LayoutResult;
  /** The face it was measured in: the family's italic for an italic recipe, unless that file could not be read. */
  face: FontEntry;
  weight: number;
  /** The file it was measured in: 'web' when the full file was wanted but could not be loaded. */
  variant: FontVariant;
}

/**
 * A candidate's recipe laid out by the engine exactly as Wordmark lays it out, for exports that have
 * no view on screen to copy from. Null for installed fonts and files that cannot be read.
 */
export async function layoutRecipe(font: FontEntry, recipe: Recipe, opts: { size: number; boxWidth?: number; variant?: FontVariant }): Promise<LaidOut | null> {
  if (font.source === "local") return null;
  // An italic recipe is set in the family's italic. When it has none, or its file cannot be read,
  // in the upright, as Compare then draws it; never in a slanted upright. Each face tries the same
  // three nearest weights as the views (fonts.ts ensureNearestFont), so one bad file costs a weight.
  const italic = recipe.italic ? italicFace(font) : null;
  for (const face of italic ? [italic, font] : [font]) {
    for (const weight of face.weights.length ? nearestWeights(face, recipe.weight) : [recipe.weight]) {
      const laid = await layoutIn(face, { ...recipe, weight }, opts);
      if (laid) return laid;
    }
  }
  return null;
}

async function layoutIn(font: FontEntry, recipe: Recipe, opts: { size: number; boxWidth?: number; variant?: FontVariant }): Promise<LaidOut | null> {
  const weight = nearestWeight(font, recipe.weight);
  // Google's full file when the recipe switches on alternates (the web subset strips them), as Compare draws it.
  let variant: FontVariant = opts.variant ?? variantFor(font, recipe.features);
  let parsed = await getFacts(font, weight, variant);
  if (!parsed && variant === "full") {
    variant = "web";
    parsed = await getFacts(font, weight, variant);
  }
  if (!parsed) return null;
  await extReady(font, weight, variant, recipe);
  const { facts, measurer } = withExt(font, weight, variant, parsed);
  // As Wordmark does: the face's own view of the name (caps-only faces in capitals), and typed
  // initials in the name's case.
  const name = effectiveText(font, facts, recipe);
  const initials = parseName({ text: recipe.layout.mark.initials, textCase: recipe.textCase }).flat;
  const result = layoutFormation({ lines: name.lines, flat: name.flat, descriptor: recipe.layout.lockup.descriptor, initials }, recipe.layout, measurer, {
    size: opts.size,
    weight,
    tracking: recipe.tracking,
    features: recipe.features,
    boxWidth: opts.boxWidth,
    serif: font.category === "serif",
  });
  return { result, face: font, weight, variant };
}

/**
 * A Google family draws Ł or ő from a second file that loads the first time a name needs it. A
 * card that set this name loaded it already; for an export that is first, wait (a few seconds at
 * most) until it is read, so those letters are not marked missing on the sheet.
 */
async function extReady(font: FontEntry, weight: number, variant: FontVariant, recipe: Recipe) {
  if (variant !== "web" || !hasExtFile(font) || peekExt(font, weight, variant) !== undefined) return;
  const parsed = peekFacts(font, weight, variant);
  const text = `${parseName(recipe).flat}${recipe.layout.lockup.descriptor}`;
  const needs = parsed && [...text.normalize("NFC")].some((ch) => ch.codePointAt(0)! > 0xff && inLatinExt(ch.codePointAt(0)!) && !parsed.facts.covers(ch));
  if (!parsed || !needs) return;
  await new Promise<void>((resolve) => {
    const stop = onFaceChange(font, weight, variant, () => {
      if (peekExt(font, weight, variant) === undefined) return;
      stop();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, 5000);
    // Measuring a run that needs the file is what starts loading it (facts/index.ts withExt).
    withExt(font, weight, variant, parsed).measurer.run(text, { size: 16 });
  });
}
