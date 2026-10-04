import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ShapeFile, ShapeTraits } from "./shape.ts";

// What the vibe catalog says about a family beyond its source's tags: shape measured from the font file
// (server/traits/shape.json, written by `npm run shapes`) and moods a model judged from a rendered
// specimen for families nobody had tagged (server/traits/vision.json, `npm run vision`). Either file
// may be missing; a family without an entry simply gets no words.

const here = path.dirname(fileURLToPath(import.meta.url));
const SHAPE_FILE = path.join(here, "traits", "shape.json");
const VISION_FILE = path.join(here, "traits", "vision.json");

interface Judged {
  moods?: Record<string, number>;
  themes?: Record<string, number>;
}

export interface Traits {
  /** The font file was measured (shape.json has the family). */
  measured: boolean;
  /** Plain words for what stands out ("condensed", "slanted"), in a fixed order. */
  shape: string[];
  /** Moods and themes judged from a specimen, strongest first ("Loud 70"). */
  judged: string[];
}

const NONE: Traits = { measured: false, shape: [], judged: [] };

/** A forward lean this steep reads as slanted; uprights measure within a degree or two of 0. A backward lean is too rare to be worth a word. */
const SLANTED_DEG = 7;
/** A circle's o measures 0.785; this is a superellipse or a rounded square. */
const SQUARED_O = 0.86;
/** Didones measure 0.77 to 0.93 (Playfair Display 0.79, Abril Fatface 0.91); ordinary book serifs 0.5 to 0.7. */
const HIGH_CONTRAST = 0.74;
/** Thick horizontals strong enough to see (Savate, Ribes, Blackout Two AM); a slightly uneven o is not that. */
const REVERSE_CONTRAST = 0.45;

let memo: { key: string; lookup: (family: string) => Traits } | null = null;

/**
 * A lookup from family to its words. The files are read again only when they change on disk, and the
 * key changes with them, so the vibe catalog (and Claude Code's cached prompt) is rebuilt only then.
 */
export function loadTraits(): { key: string; lookup: (family: string) => Traits } {
  const key = [SHAPE_FILE, VISION_FILE].map((f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0).join("|");
  if (memo?.key === key) return memo;
  const shapes: Record<string, Partial<ShapeTraits>> = readJson<ShapeFile>(SHAPE_FILE)?.fonts ?? {};
  const judged = readJson<{ fonts?: Record<string, Judged> }>(VISION_FILE)?.fonts ?? {};

  // Cut-offs are quantiles of the whole catalog, so "wide" means wide among these fonts.
  const q = (field: "w" | "wd" | "sf" | "xr", rows = Object.values(shapes)) => quantiles(rows.map((s) => s[field]).filter(num));
  const weight = q("w");
  const width = q("wd");
  const straight = q("sf");
  // A caps face's "x" is an X, so its x-height measures 1.0; left out, it would shift the cut-off.
  const xHeight = q("xr", Object.values(shapes).filter((s) => !s.caps));

  const words = new Map<string, Traits>();
  for (const family of new Set([...Object.keys(shapes), ...Object.keys(judged)])) {
    const s = shapes[family];
    const shape: string[] = [];
    if (s) {
      if (num(s.w)) {
        if (s.w <= weight(0.1)) shape.push("thin");
        else if (s.w <= weight(0.2)) shape.push("light");
        else if (s.w >= weight(0.9)) shape.push("heavy");
        else if (s.w >= weight(0.8)) shape.push("bold");
      }
      if (num(s.wd)) {
        if (s.wd <= width(0.04)) shape.push("very condensed");
        else if (s.wd <= width(0.12)) shape.push("condensed");
        else if (s.wd >= width(0.96)) shape.push("very wide");
        else if (s.wd >= width(0.88)) shape.push("wide");
      }
      if (num(s.sl) && s.sl >= SLANTED_DEG) shape.push("slanted");
      if (num(s.sq) && s.sq >= SQUARED_O) shape.push("squared");
      if (num(s.sf)) {
        if (s.sf >= straight(0.9)) shape.push("straight-edged");
        else if (s.sf <= straight(0.1)) shape.push("curvy");
      }
      if (num(s.ct)) {
        if (s.rev && s.ct >= REVERSE_CONTRAST) shape.push("reverse contrast");
        else if (!s.rev && s.ct >= HIGH_CONTRAST) shape.push("high contrast");
      }
      if (s.caps) shape.push("caps only");
      else if (num(s.xr)) {
        if (s.xr >= xHeight(0.92)) shape.push("large x-height");
        else if (s.xr <= xHeight(0.08)) shape.push("small x-height");
      }
    }
    const j = judged[family];
    const scored = Object.entries({ ...j?.moods, ...j?.themes })
      .filter(([, v]) => typeof v === "number")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag, v]) => `${tag} ${Math.round(v)}`);
    words.set(family, { measured: Boolean(s), shape, judged: scored });
  }
  memo = { key, lookup: (family) => words.get(family) ?? NONE };
  return memo;
}

function num(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** p in 0..1 to the value at that quantile (nearest rank), or NaN for an empty list, which no comparison passes. */
function quantiles(values: number[]): (p: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : NaN);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[traits] could not read ${file}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
