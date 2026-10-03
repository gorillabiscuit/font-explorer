// The candidate sheets: every candidate in its own layout, one under the other with a muted label
// line, in one SVG. Each wordmark is outlines drawn from its layout (outline.ts), the same as Copy
// SVG gives. The PNG sheet is that SVG drawn onto a canvas at 2×: outlines need no fonts, so the
// PNG keeps alternates and exact spacing, which canvas text cannot draw.
import { effectiveText } from "../coverage";
import { canvasMeasurer } from "../facts/canvas";
import { ensureFace, fontStack, fontStyle, isItalicFace, nearestWeight } from "../fonts";
import { DEFAULT_PAD, layoutFormation } from "../layout/engine";
import type { LayoutResult } from "../layout/types";
import { deepMerge } from "../merge";
import { DEFAULT_LAYOUT, recipeLabel, type Recipe } from "../recipe";
import { parseName, type Settings } from "../settings";
import type { CandidateRow } from "../store";
import type { FontEntry } from "../types";
import { layoutRecipe, layoutToSvg, sourceText } from "./copy";
import { INK, PAPER } from "./outline";

const WIDTH = 1200;
const MARGIN = 48;
/** From a row's top rule to its label's baseline, and from there to the wordmark. */
const LABEL_BASELINE = 26;
const LABEL_GAP = 8;
const ROW_GAP = 28;
const HEADER = 72;
const MUTED = "#7a7a7a";
/** Installed fonts of unknown origin: the licence needs checking before a logo uses one. */
const AMBER = "#b26a00";
const UI_FONT = "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

const EMPTY_RECIPE: Recipe = { text: "", weight: 400, textCase: "as", tracking: 0, features: {}, axes: null, layout: DEFAULT_LAYOUT };

/** A saved recipe with any layout field it predates filled in from the defaults (as Compare reads it). */
export function fullRecipe(r: Recipe): Recipe {
  return deepMerge(EMPTY_RECIPE, r);
}

export interface Sheet {
  svg: string;
  width: number;
  height: number;
  /** Candidates that could not be drawn as outlines, and why. */
  notes: string[];
}

/**
 * Every candidate as outlines in its own layout, at the size of Compare's large column (the Size
 * slider, never below 96), shrunk only where a name is wider than the sheet.
 */
export async function buildSheet(rows: CandidateRow[], settings: Settings, title: string): Promise<Sheet> {
  const size = Math.max(settings.size, 96);
  const room = WIDTH - 2 * MARGIN;
  const notes: string[] = [];
  const drawn = await Promise.all(
    rows.map(async ({ candidate, font }, i) => {
      const recipe = fullRecipe(candidate.recipe);
      const art = await drawCandidate(font, recipe, size, room).catch(() => null);
      if (!art) notes.push(`${font.family}: could not read the font file, so it is listed without its wordmark.`);
      else if (art.asText) notes.push(`${font.family} is an installed font: drawn as text, which needs the font installed to show.`);
      return { font, recipe, note: candidate.note, art, index: i };
    }),
  );

  let y = HEADER;
  let body = "";
  for (const { font, recipe, note, art, index } of drawn) {
    body += `<line x1="${MARGIN}" y1="${y + 0.5}" x2="${WIDTH - MARGIN}" y2="${y + 0.5}" stroke="#e6e6e6"/>`;
    const licence = `<tspan${font.license === "Local-unknown" ? ` fill="${AMBER}"` : ""}>${esc(font.license)}</tspan>`;
    const extra = note ? ` · ${esc(note)}` : "";
    // The label names what was drawn: upright when the italic file would not load, as the outlines
    // are, and where a borrowed italic's file came from.
    const label = recipeLabel(font, art ? { ...recipe, weight: art.weight, italic: isItalicFace(art.face) } : recipe);
    body += `<text x="${MARGIN}" y="${y + LABEL_BASELINE}" font-family="${esc(UI_FONT)}" font-size="13" fill="${MUTED}">${index + 1}. ${esc(label)} · ${esc(sourceText(art?.face ?? font))} · ${licence}${extra}</text>`;
    const top = y + LABEL_BASELINE + LABEL_GAP;
    if (art) {
      // Moved left by the wordmark's own padding, so its ink lines up with the label.
      body += `<g transform="translate(${MARGIN - DEFAULT_PAD} ${num(top)})">${art.desc ? `<desc>${esc(art.desc)}</desc>` : ""}${art.group}</g>`;
      y = top + art.height + ROW_GAP;
    } else {
      body += `<text x="${MARGIN}" y="${top + 24}" font-family="${esc(UI_FONT)}" font-size="13" fill="${AMBER}">Could not read the font file.</text>`;
      y = top + 40 + ROW_GAP;
    }
  }
  const height = Math.ceil(y + MARGIN - ROW_GAP);
  const date = new Date().toISOString().slice(0, 10);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">` +
    `<desc>Font Explorer candidates · ${esc(title)} · ${date}. Each wordmark is outlines in px at the size it is shown; its own description gives the recipe.</desc>` +
    `<rect width="${WIDTH}" height="${height}" fill="${PAPER}"/>` +
    `<text x="${MARGIN}" y="44" font-family="${esc(UI_FONT)}" font-size="15" font-weight="500" fill="${MUTED}">Candidates · ${esc(title)} · ${date}</text>` +
    body +
    `</svg>`;
  return { svg, width: WIDTH, height, notes };
}

interface Art {
  /** The wordmark's group, drawn from (0, 0). */
  group: string;
  desc?: string;
  height: number;
  /** Drawn as live text, not outlines (an installed font). */
  asText?: boolean;
  /** The face and weight it was drawn in: the family's italic only when that file was read. */
  face: FontEntry;
  weight: number;
}

async function drawCandidate(font: FontEntry, recipe: Recipe, size: number, room: number): Promise<Art | null> {
  // The room is for the ink; the wordmark keeps the engine's padding around it.
  const boxWidth = room + 2 * DEFAULT_PAD;
  if (font.source === "local") return drawInstalled(font, recipe, size, boxWidth);
  const laid = await layoutRecipe(font, recipe, { size, boxWidth });
  if (!laid) return null;
  // The face it was laid out in: the family's italic for an italic recipe that has one.
  const out = await layoutToSvg(laid.face, laid.weight, laid.variant, laid.result, recipe);
  return out && { group: out.group, desc: out.desc, height: laid.result.box.h, face: laid.face, weight: laid.weight };
}

/**
 * An installed font has no file to read, so no outlines: it is laid out with the canvas measurer
 * (as its card is) and drawn as text with every letter at its measured place.
 */
async function drawInstalled(upright: FontEntry, recipe: Recipe, size: number, boxWidth: number): Promise<Art | null> {
  // An italic recipe asks for the installed italic (fonts.ts italicFace), as its card does.
  const got = await ensureFace(upright, recipe.weight, !!recipe.italic);
  const font = got?.face ?? upright;
  const weight = got?.weight ?? nearestWeight(font, recipe.weight);
  const measurer = canvasMeasurer(font, weight);
  // As its card shows it: a caps-only installed face sets the name in capitals.
  const name = effectiveText(font, null, recipe);
  const initials = parseName({ text: recipe.layout.mark.initials, textCase: recipe.textCase }).flat;
  const result = layoutFormation({ lines: name.lines, flat: name.flat, descriptor: recipe.layout.lockup.descriptor, initials }, recipe.layout, measurer, {
    size,
    weight,
    tracking: recipe.tracking,
    features: recipe.features,
    boxWidth,
    serif: font.category === "serif",
  });
  return { group: textGroup(result, font, weight), height: result.box.h, asText: true, face: font, weight };
}

function textGroup(r: LayoutResult, font: FontEntry, weight: number): string {
  const knockOut = r.container?.style === "fill";
  let out = "";
  for (const c of [r.container, ...(r.tiles ?? [])]) {
    if (!c) continue;
    const paint = c.style === "fill" ? `fill="${INK}"` : `fill="none" stroke="${INK}" stroke-width="${num(c.style === "keyline" ? c.stroke : 1)}"${c.style === "guide" ? ' stroke-opacity="0.35" stroke-dasharray="4 4"' : ""}`;
    out +=
      c.shape === "circle"
        ? `<ellipse cx="${num(c.x + c.w / 2)}" cy="${num(c.y + c.h / 2)}" rx="${num(c.w / 2)}" ry="${num(c.h / 2)}" ${paint}/>`
        : `<rect x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}" rx="${num(c.shape === "pill" ? Math.min(c.w, c.h) / 2 : c.shape === "rounded" ? c.rx : 0)}" ${paint}/>`;
  }
  for (const run of r.runs) {
    const single = run.glyphs.every((g) => [...g.char].length === 1);
    const x = single ? run.glyphs.map((g) => num(g.x)).join(" ") : num(run.x);
    const text = single ? run.glyphs.map((g) => g.char).join("") : run.text;
    // The installed italic, or the upright where none is installed: never a slanted upright.
    const style = fontStyle(font) === "italic" ? ' font-style="italic" style="font-synthesis: none"' : "";
    out += `<text x="${x}" y="${num(run.y)}" font-family="${esc(fontStack(font).replace(/"/g, "'"))}"${style} font-weight="${weight}" font-size="${num(run.size)}" fill="${knockOut ? PAPER : INK}"${run.placeholder ? ' fill-opacity="0.35"' : ""} xml:space="preserve">${esc(text)}</text>`;
  }
  return `<g id="${esc(font.family)} (installed, live text)">${out}</g>`;
}

/** The sheet as a PNG at 2×, drawn from its SVG (which needs no fonts but the labels' system font). */
export async function sheetToPng(sheet: Sheet, scale = 2): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sheet.svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(sheet.width * scale);
  canvas.height = Math.ceil(sheet.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw the PNG sheet: no canvas.");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render the PNG sheet.");
  return blob;
}

function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
