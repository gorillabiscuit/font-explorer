// A Measurer built on canvas measureText, for faces fontkit cannot read: installed fonts (no file)
// and runs that need a second file such as latin-ext. It sees what the browser renders, fallback
// fonts included, but cannot apply OpenType features, so it reports exact = false. Letters the face
// lacks are reported missing, so a layout draws a placeholder instead of the fallback font's letter.
import { faceName, fontStack, fontStyle, isFontLoaded, nearestWeight, type FontVariant } from "../fonts";
import type { FontEntry } from "../types";
import { Lru } from "./lru";
import type { GlyphMetrics, Measurer, RunMetrics, RunOptions } from "./types";

// Measure at one large size and scale down: small sizes get hinted and rounded by the browser.
const REF = 200;

type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
let shared: Context | null | undefined;
let inPage: Context | null | undefined;

function context(): Context | null {
  if (shared !== undefined) return shared;
  try {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    shared = canvas.getContext("2d") as Context | null;
  } catch {
    shared = null;
  }
  return shared;
}

/**
 * The canvas installed fonts are measured on: a hidden one in the page, styled font-synthesis: none
 * as the wordmarks are. A canvas off the page cannot carry that style, so for an installed family
 * with no italic (or no bold) it would measure a slanted (or thickened) stand-in that the card,
 * which never fakes one, does not draw. Remote faces stay on the canvas off the page: theirs are
 * registered at the exact weight and style drawn, and a canvas in the page can cost the browser a
 * style pass whenever its font changes.
 */
function installedContext(): Context | null {
  if (inPage !== undefined) return inPage ?? context();
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.setAttribute("aria-hidden", "true");
    // 'all: initial' keeps the page's own text styles (numerals, features) out of the measurements.
    canvas.style.cssText =
      "all: initial; position: fixed; left: -10000px; top: 0; width: 1px; height: 1px; visibility: hidden; pointer-events: none; font-synthesis: none";
    document.body.append(canvas);
    inPage = canvas.getContext("2d");
  } catch {
    inPage = null;
  }
  return inPage ?? context();
}

interface Unit {
  index: number;
  char: string;
  /** At REF px, before tracking. */
  x: number;
  advance: number;
  ink: { l: number; r: number; t: number; b: number } | null;
  missing: boolean;
}

export interface CanvasMeasurerOptions {
  /**
   * Which characters the face really has, when the caller knows (the cmaps of the files behind it).
   * Without it, each character is tested in the browser with probeCovers.
   */
  covers?: (ch: string) => boolean;
  /** Tells apart measurers of one face that differ in what it covers (e.g. '+ext' once latin-ext loaded). */
  tag?: string;
}

const measurers = new Lru<string, Measurer>(500);

/**
 * Call once the face has loaded (isFontLoaded): before that the canvas would measure the fallback
 * font. Measurers made too early still work but are not cached, so the next call measures again.
 */
export function canvasMeasurer(font: FontEntry, weight: number, variant: FontVariant = "web", opts: CanvasMeasurerOptions = {}): Measurer {
  const w = nearestWeight(font, weight);
  const key = `${font.id}@${w}@${variant}${opts.tag ?? ""}`;
  const hit = measurers.get(key);
  if (hit) return hit;
  const family = faceName(font, variant);
  // An italic face shares its upright's family name, so the style is what picks it.
  const style = fontStyle(font);
  const installed = font.source === "local";
  const measurer = build(
    `${style === "italic" ? "italic " : ""}${w} ${REF}px ${fontStack(font, variant)}`,
    opts.covers ?? ((ch) => probeCovers(family, w, ch, style, installed)),
    installed ? installedContext : context,
  );
  if (isFontLoaded(font, w, variant)) measurers.set(key, measurer);
  return measurer;
}

/** Characters that never need a glyph of their own: spaces, accents typed separately, invisible format marks. */
export const NO_GLYPH = /^[\s\p{M}\p{Cf}]+$/u;
const probed = new Map<string, boolean>();
const cases = new Map<string, { lowerCount: number; lowerIsCaps: boolean }>();

/**
 * Whether the browser draws `ch` from the face itself rather than a fallback, for faces with no
 * file to read (installed fonts). The character is measured with the face first and monospace,
 * then serif, behind it: if the face has the glyph both widths are the face's own, and if it lacks
 * it the two fallbacks almost always differ. An italic is asked for in its style, so an installed
 * italic answers for itself. Cached per family, weight, style and character.
 */
export function probeCovers(family: string, weight: number, ch: string, style: "normal" | "italic" = "normal", installed = true): boolean {
  if (!ch || NO_GLYPH.test(ch)) return true;
  const key = `${family}\u0000${weight}\u0000${style}\u0000${ch}`;
  const known = probed.get(key);
  if (known !== undefined) return known;
  const ctx = installed ? installedContext() : context();
  if (!ctx) return true;
  const width = (fallback: string) => {
    ctx.font = `${style === "italic" ? "italic " : ""}${weight} ${REF}px "${family}", ${fallback}`;
    return ctx.measureText(ch).width;
  };
  const covered = Math.abs(width("monospace") - width("serif")) < 0.01;
  probed.set(key, covered);
  return covered;
}

/**
 * Case facts for an installed font, from the same probe: how many of a-z it has, and whether its
 * lowercase letters are copies of the capitals (a caps-only face), judged by 'a', 'e' and 'g'
 * measuring exactly like 'A', 'E' and 'G'. Cached per family, weight and style.
 */
export function probeCase(family: string, weight: number, style: "normal" | "italic" = "normal"): { lowerCount: number; lowerIsCaps: boolean } {
  const key = `${family}\u0000${weight}\u0000${style}`;
  const known = cases.get(key);
  if (known) return known;
  let lowerCount = 0;
  for (let cp = 0x61; cp <= 0x7a; cp++) if (probeCovers(family, weight, String.fromCharCode(cp), style)) lowerCount++;
  const ctx = installedContext();
  let lowerIsCaps = false;
  if (ctx && lowerCount) {
    const shape = (ch: string) => {
      ctx.font = `${style === "italic" ? "italic " : ""}${weight} ${REF}px "${family}", monospace`;
      const m = ctx.measureText(ch);
      return [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].map((v) => v.toFixed(2)).join();
    };
    lowerIsCaps = ["a", "e", "g"].every((ch) => probeCovers(family, weight, ch, style) && shape(ch) === shape(ch.toUpperCase()));
  }
  const result = { lowerCount, lowerIsCaps };
  cases.set(key, result);
  return result;
}

function build(cssFont: string, covers: (ch: string) => boolean, contextOf: () => Context | null): Measurer {
  const runs = new Lru<string, Unit[]>(64);

  const measure = (text: string, kerning: boolean) => {
    const ctx = contextOf();
    if (!ctx) return null;
    ctx.font = cssFont;
    // Not every engine has fontKerning; where it is missing, kerning stays on.
    if ("fontKerning" in ctx) ctx.fontKerning = kerning ? "normal" : "none";
    return ctx.measureText(text);
  };

  const ascentOf = (ch: string) => (measure(ch, true)?.actualBoundingBoxAscent ?? 0) / REF;
  const cap = ascentOf("H");
  const descentOf = (ch: string) => (measure(ch, true)?.actualBoundingBoxDescent ?? 0) / REF;

  const units = (text: string, kerning: boolean): Unit[] => {
    const key = `${kerning ? 1 : 0}\u0000${text}`;
    const hit = runs.get(key);
    if (hit) return hit;
    const out: Unit[] = [];
    let index = 0;
    for (const char of text) {
      // A glyph's position is the width of everything before it, so kerning against the previous
      // letter is included, as the browser renders it.
      const x = measure(text.slice(0, index), kerning)?.width ?? 0;
      const end = measure(text.slice(0, index + char.length), kerning)?.width ?? x;
      const m = measure(char, kerning);
      const l = m ? -m.actualBoundingBoxLeft : 0;
      const r = m ? m.actualBoundingBoxRight : 0;
      const t = m ? m.actualBoundingBoxAscent : 0;
      const b = m ? -m.actualBoundingBoxDescent : 0;
      out.push({ index, char, x, advance: end - x, ink: r > l && t > b ? { l, r, t, b } : null, missing: !NO_GLYPH.test(char) && !covers(char) });
      index += char.length;
    }
    runs.set(key, out);
    return out;
  };

  return {
    capHeight: cap,
    xHeight: ascentOf("x"),
    ascender: Math.max(ascentOf("d"), ascentOf("h")),
    descender: -Math.max(descentOf("p"), descentOf("g")),
    overshoot: Math.max(0, ascentOf("O") - cap),
    exact: false,
    run(text: string, { size, tracking = 0, features }: RunOptions): RunMetrics {
      const kerning = !(features && "kern" in features && !features.kern);
      const scale = size / REF;
      // Tracking is added by hand rather than with ctx.letterSpacing, which also pads after the last
      // letter and is missing in some engines. Same rule as the fontkit measurer: between glyphs only,
      // never in front of a zero-width one.
      const step = tracking * size;
      let shift = 0;
      let spacingSeen = false;
      let inkLeft = Infinity;
      let inkRight = -Infinity;
      let inkTop = -Infinity;
      let inkBottom = Infinity;
      const glyphs: GlyphMetrics[] = units(text, kerning).map((u) => {
        if (u.advance !== 0) {
          if (spacingSeen) shift += step;
          spacingSeen = true;
        }
        const x = u.x * scale + shift;
        const g: GlyphMetrics = { index: u.index, char: u.char, x, advance: u.advance * scale, inkL: x, inkR: x, inkT: 0, inkB: 0, missing: u.missing };
        // A missing letter's ink is the placeholder box, as the fontkit measurer reports it: its
        // advance wide and cap-height tall, so nothing is measured from the fallback's letter.
        const ink = u.missing ? { l: 0, r: u.advance > 0 ? u.advance : 0.5 * REF, t: cap * REF, b: 0 } : u.ink;
        if (ink) {
          g.inkL = x + ink.l * scale;
          g.inkR = x + ink.r * scale;
          g.inkT = ink.t * scale;
          g.inkB = ink.b * scale;
          inkLeft = Math.min(inkLeft, g.inkL);
          inkRight = Math.max(inkRight, g.inkR);
          inkTop = Math.max(inkTop, g.inkT);
          inkBottom = Math.min(inkBottom, g.inkB);
        }
        return g;
      });
      const last = glyphs[glyphs.length - 1];
      const inked = inkLeft <= inkRight;
      return {
        advance: last ? last.x + last.advance : 0,
        inkLeft: inked ? inkLeft : 0,
        inkRight: inked ? inkRight : 0,
        inkTop: inked ? inkTop : 0,
        inkBottom: inked ? inkBottom : 0,
        glyphs,
      };
    },
  };
}
