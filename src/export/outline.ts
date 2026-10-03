// A laid-out wordmark as vector outlines: the SVG that Copy SVG puts on the clipboard and the
// sheets are built from. It draws a LayoutResult, the same one the card drew, so every letter goes
// exactly where the card put it; fontkit only supplies each letter's shape. DOM-free, so the Node
// check script (server/check-layout.ts) tests the very code the browser runs.
import type { Font } from "fontkit";
import { pathFor } from "../facts/core";
import type { ContainerShape, LayoutResult, Run } from "../layout/types";
import { FORMATION_LABELS, rowGapOf, type LayoutSettings, type Recipe } from "../recipe";
import { parseName } from "../settings";

/** The letters' colour, and the paper colour that letters knocked out of a filled shape take. */
export const INK = "#000000";
export const PAPER = "#ffffff";

/** Where the letter shapes come from. */
export interface GlyphFonts {
  /** The file the card was drawn from (the instance at the drawn weight, for a variable font). */
  primary: Font;
  /**
   * A second file for letters the first lacks: a Google family's latin-ext file, which the card
   * draws Ł or ő from. Null when there is none.
   */
  fallback?: Font | null;
}

/** What the SVG's description records about the face and the recipe. */
export interface OutlineSpec {
  family: string;
  /** e.g. 'Google', 'Fontshare'. */
  source: string;
  license: string;
  homepage?: string | null;
  /** The font file the outlines were read from. */
  fileUrl?: string | null;
  /** The weight drawn (the nearest one the family ships). */
  weight: number;
  /** As drawn: `italic` only when the outlines come from the family's italic file. */
  recipe: Recipe;
  /** The layer name's first part: the name as drawn. Defaults to the recipe's name on one line. */
  name?: string;
  /** The face has no lowercase, so a name typed with lowercase was drawn in its capitals. */
  shownInCaps?: boolean;
}

export interface Outlines {
  svg: string;
  /** The drawing alone, `<g id="<name> - <family> <weight>">`, for placing on a sheet. */
  group: string;
  /** The recipe in words, as the SVG's <desc> holds it (unescaped). */
  desc: string;
  /** How many letter outlines were drawn. */
  glyphs: number;
  /** Letters in the drawing that neither file has a shape for, so they were left out. */
  unshaped: string[];
  /** Hatched placeholders on the card (letters the face lacks): never part of the outlines. */
  placeholders: number;
}

/**
 * The layout as an SVG of outlines, in px at the size it was laid out (the card's own size). The
 * viewBox is the layout's box, so pasted over a screenshot of the card at the same scale it lines up.
 */
export function svgFromLayout(result: LayoutResult, fonts: GlyphFonts, spec: OutlineSpec): Outlines {
  const knockOut = result.container?.style === "fill";
  const unshaped: string[] = [];
  let glyphs = 0;

  const drawRuns = (runs: Run[]) => {
    let out = "";
    for (const run of runs) {
      for (const glyph of glyphPaths(run, fonts, unshaped)) {
        glyphs++;
        const paint = `${knockOut ? ` fill="${PAPER}"` : ""}${run.placeholder ? ' fill-opacity="0.35"' : ""}`;
        out += `<path id="${attr(glyph.char)}"${paint} d="${glyph.d}"/>`;
      }
    }
    return out;
  };

  // Mark sets its tile again at 32 and 16 px under the main one. Those copies are drawn too (the
  // card shows them, and the drawing keeps the card's box), each in its own group so it is easy to
  // delete in Figma.
  const { main, minis } = splitMarkSizes(result, spec.recipe.layout);
  let body = result.container ? shapeSvg(result.container) : "";
  body += drawRuns(main);
  for (const mini of minis) body += `<g id="${attr(mini.label)}">${mini.tile ? shapeSvg(mini.tile) : ""}${drawRuns(mini.runs)}</g>`;

  const name = spec.name ?? parseName(spec.recipe).flat;
  const w = num(result.box.w);
  const h = num(result.box.h);
  const desc = describe(result, spec);
  const group = `<g id="${attr(`${name} - ${spec.family} ${spec.weight}${spec.recipe.italic ? " Italic" : ""}`)}" fill="${INK}">${body}</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><desc>${text(desc)}</desc>${group}</svg>`;
  return { svg, group, desc, glyphs, unshaped: [...new Set(unshaped)], placeholders: result.missing.length };
}

/** One letter's outline, placed. A ligature is one glyph with several characters ('fi'). */
interface PlacedGlyph {
  char: string;
  d: string;
}

/**
 * The run's letters as outlines at the layout's positions. fontkit shapes the run's text again only
 * to know which glyph draws each letter (ligatures, alternates and accents included); each outline
 * is then moved to where the layout put that glyph, which is where the card drew it. An accent
 * that is its own glyph joins its letter's path.
 */
function glyphPaths(run: Run, fonts: GlyphFonts, unshaped: string[]): PlacedGlyph[] {
  const shaped = pathFor(fonts.primary, run.text, { size: run.size, tracking: run.tracking, features: run.features });
  // The layout measured this text with the same features, so glyph i of one is glyph i of the other.
  // When they differ (a run the canvas measured, which knows no ligatures), each glyph follows the
  // layout's position for the letter it starts at, so letters still land where the card drew them.
  const aligned = shaped.glyphs.length === run.glyphs.length && shaped.glyphs.every((g, i) => g.index === run.glyphs[i].index);
  const layoutX = new Map<number, number>();
  for (const g of run.glyphs) if (!layoutX.has(g.index)) layoutX.set(g.index, g.x);
  const shift = new Map<number, number>();

  const out: PlacedGlyph[] = [];
  shaped.glyphs.forEach((g, i) => {
    // Where this glyph's origin goes, in the layout's own px.
    let x: number;
    if (aligned) x = run.glyphs[i].x;
    else {
      if (!shift.has(g.index)) {
        const at = layoutX.get(g.index);
        shift.set(g.index, at === undefined ? 0 : at - (run.x + g.x));
      }
      x = run.x + g.x + shift.get(g.index)!;
    }
    let d = "";
    if (!g.missing) d = offsetPath(g.d, x - g.x, run.y);
    else if (g.char.trim()) {
      // The layout drew this letter, so the browser found it: in the latin-ext file, if anywhere.
      const borrowed = fonts.fallback && fonts.fallback.hasGlyphForCodePoint(g.char.codePointAt(0)!) ? pathFor(fonts.fallback, g.char, { size: run.size, features: run.features }) : null;
      if (borrowed && !borrowed.glyphs.some((b) => b.missing)) d = offsetPath(borrowed.d, x, run.y);
      else unshaped.push(g.char);
    }
    if (!d) return;
    const prev = out[out.length - 1];
    if (!g.char && prev) prev.d += d;
    else out.push({ char: g.char || "glyph", d });
  });
  return out;
}

/** The main drawing, and Mark's small copies (runs and tile) grouped by size, largest first. */
function splitMarkSizes(result: LayoutResult, layout: LayoutSettings): { main: Run[]; minis: { label: string; runs: Run[]; tile?: ContainerShape }[] } {
  if (layout.formation !== "mark" || !result.runs.length) return { main: result.runs, minis: [] };
  const big = Math.max(...result.runs.map((r) => r.size));
  const main = result.runs.filter((r) => r.size >= 0.9 * big);
  const bySize = new Map<number, Run[]>();
  for (const r of result.runs) {
    if (r.size >= 0.9 * big) continue;
    const key = Math.round(r.size * 100);
    bySize.set(key, [...(bySize.get(key) ?? []), r]);
  }
  const tiles = [...(result.tiles ?? [])].sort((a, b) => b.h - a.h);
  const minis = [...bySize.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, runs], i) => {
      const tile = tiles[i];
      // The copy is set this many px tall: its tile's height, or its letters' when there is no tile.
      const tall = tile?.h ?? inkHeight(runs);
      return { label: `${Math.round(tall)} px`, runs, tile };
    });
  return { main, minis };
}

function inkHeight(runs: Run[]): number {
  const glyphs = runs.flatMap((r) => r.glyphs).filter((g) => g.inkB > g.inkT);
  return glyphs.length ? Math.max(...glyphs.map((g) => g.inkB)) - Math.min(...glyphs.map((g) => g.inkT)) : 0;
}

/** A container as the card draws it: in ink when filled, a stem-weight stroke as a keyline, a faint dashed guide. */
function shapeSvg(c: ContainerShape): string {
  const paint =
    c.style === "fill"
      ? `fill="${INK}"`
      : c.style === "keyline"
        ? `fill="none" stroke="${INK}" stroke-width="${num(c.stroke)}"`
        : `fill="none" stroke="${INK}" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="4 4"`;
  const id = c.style === "guide" ? "clear space" : c.shape;
  if (c.shape === "circle") {
    if (Math.abs(c.w - c.h) < 0.01) return `<circle id="${id}" cx="${num(c.x + c.w / 2)}" cy="${num(c.y + c.h / 2)}" r="${num(c.w / 2)}" ${paint}/>`;
    return `<ellipse id="${id}" cx="${num(c.x + c.w / 2)}" cy="${num(c.y + c.h / 2)}" rx="${num(c.w / 2)}" ry="${num(c.h / 2)}" ${paint}/>`;
  }
  if (c.shape === "pill") {
    // A rectangle with half circles at both ends, as one path.
    const r = Math.min(c.w, c.h) / 2;
    const [x0, x1, y0, y1] = [c.x + r, c.x + c.w - r, c.y, c.y + c.h];
    const d = `M${num(x0)} ${num(y0)}H${num(x1)}A${num(r)} ${num(r)} 0 0 1 ${num(x1)} ${num(y1)}H${num(x0)}A${num(r)} ${num(r)} 0 0 1 ${num(x0)} ${num(y0)}Z`;
    return `<path id="${id}" d="${d}" ${paint}/>`;
  }
  const rx = c.shape === "rounded" && c.rx > 0 ? ` rx="${num(c.rx)}"` : "";
  return `<rect id="${id}" x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}"${rx} ${paint}/>`;
}

/**
 * SVG path data as pathFor writes it (absolute M, L, Q, C and Z, coordinates in x y pairs),
 * moved by (dx, dy).
 */
export function offsetPath(d: string, dx: number, dy: number): string {
  if (!dx && !dy) return d;
  return d.replace(/([MLQC])([^MLQCZ]*)/g, (_, command: string, args: string) => {
    const n = args.trim().split(/\s+/).map(Number);
    let out = command;
    for (let i = 0; i + 1 < n.length; i += 2) out += `${i ? " " : ""}${num(n[i] + dx)} ${num(n[i + 1] + dy)}`;
    return out;
  });
}

// --- the description ---

/** The recipe in words and type units, for the SVG's <desc>, so the file explains itself. */
export function describe(result: LayoutResult, spec: OutlineSpec): string {
  const r = spec.recipe;
  const lines = [
    `${spec.name ?? parseName(r).flat} set in ${spec.family} ${spec.weight}${r.italic ? " Italic" : ""} (${spec.source}, licence: ${spec.license})`,
  ];
  if (spec.homepage) lines.push(`Homepage: ${spec.homepage}`);
  if (spec.fileUrl) lines.push(`Font file: ${spec.fileUrl}`);
  // The card's badge wording, so the file and the card say the same thing.
  const caseName = `${CASE_NAMES[r.textCase] ?? r.textCase}${spec.shownInCaps ? " (caps only · shown in caps: the face has no lowercase)" : ""}`;
  lines.push(`Weight ${spec.weight}${r.italic ? " italic (a real italic file, not a slanted upright)" : ""} · case ${caseName} · letter spacing ${em(r.tracking)} · features ${featureList(r.features)}`);
  const caps = !result.runs.some((run) => run.slot !== "descriptor" && /\p{Ll}/u.test(run.text));
  lines.push(`Layout: ${describeLayout(r.layout, caps, parseName(r).lines.length)}`);
  const fit = [...result.fit, ...result.warnings.map((w) => (w === "scaled" ? `scaled to ${Math.floor(result.scale * 100 + 1e-6)}% to fit` : w))];
  if (fit.length) lines.push(`Corrections the layout needed: ${fit.join(" · ")}`);
  if (result.missing.length) lines.push(`Left out: ${result.missing.length} letter(s) the font has no glyph for`);
  // The name's size as drawn: after any shrink to fit the card and any fit into a container.
  const drawn = Math.max(0, ...result.runs.filter((run) => run.slot !== "descriptor").map((run) => run.size));
  lines.push(`Units: px at the size it was judged (name at ${num(drawn)} px font size)`);
  return lines.join("\n");
}

const CASE_NAMES: Record<string, string> = { as: "as typed", upper: "UPPER", lower: "lower" };

/**
 * e.g. 'stack, leading 0.25 cap height, align left, justify track; match auto (cap height); optical edge'.
 * `lines` is how many lines the typed name has ('/' breaks it): a Lockup sets a name of more than
 * one as a Stack (lockup.ts), with Stack's leading, align and justify.
 */
export function describeLayout(l: LayoutSettings, caps: boolean, lines = 1): string {
  const ref = caps ? "cap height" : "x-height";
  const parts: string[] = [FORMATION_LABELS[l.formation]?.toLowerCase() ?? l.formation];
  // Chosen breaks shape a Stack or a Block only, and only when no '/' was typed (breaks.ts, block.ts);
  // they stay in the settings across a switch to another layout, where they mean nothing.
  if (l.breaks?.length && lines <= 1 && (l.formation === "stack" || l.formation === "block")) parts.push(`line breaks after letter ${l.breaks.join(", ")}`);
  if (l.formation === "stack") parts.push(`leading ${l.stack.leading} ${ref}`, `align ${l.stack.align}`, `justify ${l.stack.justify}`);
  if (l.formation === "block") {
    parts.push(l.block.mode === "cells" ? "equal cells" : "justified rows", `columns ${l.block.cols ?? "auto"}`);
    // Justified rows have no gap across a row (each row is letter-spaced to the width), only between rows.
    if (l.block.mode === "cells") parts.push(`letter gap ${l.block.gap} cap height`);
    parts.push(`line gap ${rowGapOf(l.block)} cap height`);
    if (l.block.mode === "cells") parts.push(`last row ${l.block.lastRow}`);
  }
  if (l.formation === "lockup") {
    const d = l.lockup;
    const size = d.size === "match" ? "matched (0.28 of the name's cap height, letter-spaced to the name's width)" : `${d.size} of the name's cap height`;
    if (lines > 1) parts.push(`name stacked in ${lines} lines`, `leading ${l.stack.leading} ${ref}`, `align ${l.stack.align}`, `justify ${l.stack.justify}`);
    parts.push(
      d.descriptor ? `descriptor "${d.descriptor}"` : "descriptor placeholder",
      `${d.position}`,
      `align ${d.align}`,
      `size ${size}`,
      `case ${CASE_NAMES[d.textCase] ?? d.textCase}`,
      `letter spacing ${em(d.tracking)}`,
      `gap ${d.gap} cap height`,
    );
  }
  if (l.formation === "mark") parts.push(l.mark.construction, l.mark.initials ? `initials "${l.mark.initials}"` : "initials from the name");
  const match = l.match === "auto" ? `auto (${ref})` : MATCH_NAMES[l.match];
  const out = [parts.join(", "), `match ${match}`];
  if (l.opticalEdge) out.push("optical edge");
  const c = l.container;
  const shape = c.auto ? (l.formation === "block" || l.formation === "mark" ? { shape: "square", style: "fill" } : null) : c.shape === "none" ? null : c;
  if (shape) out.push(`container ${STYLE_NAMES[shape.style]} ${shape.shape}${c.auto ? " (auto)" : ""}, padding ${c.padding} cap height`);
  return out.join("; ");
}

const MATCH_NAMES: Record<string, string> = { cap: "cap height", x: "x-height", width: "width", em: "font size" };
const STYLE_NAMES: Record<string, string> = { fill: "filled", keyline: "keyline", guide: "guide" };

function featureList(features: Record<string, 0 | 1>): string {
  const entries = Object.entries(features ?? {});
  return entries.length ? entries.map(([tag, on]) => `${tag} ${on ? "on" : "off"}`).join(", ") : "none";
}

function em(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Number(Math.abs(v).toFixed(3))}em`;
}

// --- markup ---

function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Text for an element's content. */
function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text for a double-quoted attribute. */
function attr(s: string): string {
  return text(s).replace(/"/g, "&quot;");
}
