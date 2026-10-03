// Offline check of the layout engine (src/layout/*) against real fonts from the proxy's cache.
// Run: npm run check:layout. Picks the first 10 static fonts with a full lowercase, sets names in
// Line, Stack, Block, Lockup and Mark (with and without containers) with the same core.ts measurer
// the browser uses, and exits 1 when a rule breaks.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import type { Font } from "fontkit";
import { computeFacts, createMeasurer } from "../src/facts/core.ts";
import { INK, PAPER, svgFromLayout } from "../src/export/outline.ts";
import type { FontFacts, Measurer } from "../src/facts/types.ts";
import { evenness } from "../src/layout/block.ts";
import { suggestBreaks } from "../src/layout/breaks.ts";
import { TILE } from "../src/layout/container.ts";
import { DEFAULT_PAD, layoutFormation, MAX_GROW } from "../src/layout/engine.ts";
import { MATCH_RATIO, TIGHTEST } from "../src/layout/lockup.ts";
import { MARK_SIZES } from "../src/layout/mark.ts";
import { nominalMeasurer } from "../src/layout/nominal.ts";
import { LEADING, leadingUnit, ROW_GAP } from "../src/layout/controls/spacing.ts";
import { columnWidth, intrinsicHeight } from "../src/layout/grid.ts";
import type { LayoutInput, LayoutOptions, LayoutResult } from "../src/layout/types.ts";
import { deepMerge } from "../src/merge.ts";
import { DEFAULT_LAYOUT, rowGapOf, sameRecipe, type LayoutSettings, type Recipe } from "../src/recipe.ts";
import { parseName } from "../src/settings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, ".cache", "fonts");
const WANTED = 10;
const S = 56;
const TOLERANCE = 0.5;

interface Face {
  family: string;
  facts: FontFacts;
  measurer: Measurer;
  font: Font;
}

const files = (await readdir(DIR).catch(() => [] as string[])).filter((name) => !name.includes(".")).sort();
const faces: Face[] = [];
for (const name of files) {
  if (faces.length >= WANTED) break;
  let font: Font;
  try {
    const parsed = fontkit.create(await readFile(path.join(DIR, name)));
    font = "fonts" in parsed ? parsed.fonts[0] : parsed;
  } catch {
    continue;
  }
  // Static files only: a variable file would be measured at its default instance here, while the
  // browser draws it at the weight it was loaded with.
  if (!font || Object.keys(font.variationAxes ?? {}).length) continue;
  const facts = computeFacts(font);
  if (!facts.hasLower || facts.lowerIsCaps || !facts.covers("Wordmakgyphdk HAMBURG")) continue;
  const family = [font.fullName, font.familyName].find((s) => s && /\p{L}/u.test(s)) ?? name.slice(0, 8);
  faces.push({ family, facts, measurer: createMeasurer(font, facts), font });
}
if (faces.length < WANTED) {
  console.log(`Only ${faces.length} usable cached fonts in ${DIR} (need ${WANTED}). Scroll the indie fonts in the app first.`);
  process.exit(faces.length ? 1 : 0);
}

const failures: string[] = [];
const fail = (face: Face, what: string) => failures.push(`${face.family}: ${what}`);
const opts: LayoutOptions = { size: S, weight: 400, tracking: 0 };
type Nested = "stack" | "block" | "lockup" | "mark" | "container";
const layoutWith = (patch: Partial<Omit<LayoutSettings, Nested>> & { [K in Nested]?: Partial<LayoutSettings[K]> } = {}): LayoutSettings => ({
  ...DEFAULT_LAYOUT,
  ...patch,
  stack: { ...DEFAULT_LAYOUT.stack, ...patch.stack },
  block: { ...DEFAULT_LAYOUT.block, ...patch.block },
  lockup: { ...DEFAULT_LAYOUT.lockup, ...patch.lockup },
  mark: { ...DEFAULT_LAYOUT.mark, ...patch.mark },
  container: { ...DEFAULT_LAYOUT.container, ...patch.container },
});
const NO_CONTAINER = { auto: false, shape: "none" } as const;
const nameOf = (text: string, textCase: "as" | "upper" | "lower" = "as"): LayoutInput => parseName({ text, textCase });

/** Ink extents of each line, found by grouping runs on the same baseline. */
function lineInks(r: LayoutResult): { left: number; right: number; y: number }[] {
  const lines = new Map<number, { left: number; right: number; y: number }>();
  for (const run of r.runs) {
    const key = Math.round(run.y * 100);
    const line = lines.get(key) ?? { left: Infinity, right: -Infinity, y: run.y };
    for (const g of run.glyphs) {
      if (g.inkR <= g.inkL) continue;
      line.left = Math.min(line.left, g.inkL);
      line.right = Math.max(line.right, g.inkR);
    }
    lines.set(key, line);
  }
  return [...lines.values()].sort((a, b) => a.y - b.y);
}

/** The ink box of the runs in one slot (and their missing placeholders are not counted). */
function slotInk(r: LayoutResult, slot: "name" | "descriptor" | "initial"): { left: number; right: number; top: number; bottom: number } {
  const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const run of r.runs) {
    if (run.slot !== slot) continue;
    for (const g of run.glyphs) {
      if (g.inkR <= g.inkL) continue;
      box.left = Math.min(box.left, g.inkL);
      box.right = Math.max(box.right, g.inkR);
      box.top = Math.min(box.top, g.inkT);
      box.bottom = Math.max(box.bottom, g.inkB);
    }
  }
  return box;
}

/** Every number in the drawing is in the box: nothing is cut off at the SVG's edge. */
function inBox(r: LayoutResult): boolean {
  const shapes = [r.container, ...(r.tiles ?? [])].filter((c) => c !== undefined);
  return (
    r.ink.x >= -0.01 &&
    r.ink.y >= -0.01 &&
    r.ink.x + r.ink.w <= r.box.w + 0.01 &&
    r.ink.y + r.ink.h <= r.box.h + 0.01 &&
    shapes.every((c) => c.x >= -0.01 && c.y >= -0.01 && c.x + c.w <= r.box.w + 0.01 && c.y + c.h <= r.box.h + 0.01)
  );
}

function finite(r: LayoutResult): boolean {
  const nums = [r.box.w, r.box.h, r.ink.x, r.ink.y, r.ink.w, r.ink.h, r.fontSize, r.scale];
  for (const run of r.runs) nums.push(run.x, run.y, run.size, run.tracking, ...run.glyphs.flatMap((g) => [g.x, g.inkL, g.inkR, g.inkT, g.inkB]));
  return nums.every(Number.isFinite);
}

/** For rules worked out here in full: the engine's arithmetic is deterministic, so they hold to a millionth of a px. */
const EXACT = 1e-6;

/**
 * Block's cells, worked out from the rule instead of run through the engine, so a change that moves
 * every drawing alike cannot pass by comparing the engine with itself. Each letter's ink is centred
 * in a cell as wide as the widest letter's ink (never less than a cap height); the cells step
 * `across` cap heights apart in a row and `down` between rows; a short row is centred by the across
 * step; the cap band is centred in the cell. Before rowGap existed `down` was the one gap, so with
 * across = down this is the old drawing. Caps names only (their band is the cap height). Returns what is off.
 */
function cellsOff(r: LayoutResult, rows: string[], m: Measurer, across: number, down: number): string[] {
  const size = r.fontSize;
  const cap = m.capHeight * size;
  const inkWidth = (ch: string) => m.run(ch, { size }).inkRight - m.run(ch, { size }).inkLeft;
  const cell = Math.max(cap, ...rows.flatMap((row) => [...row].map(inkWidth)));
  const [stepX, stepY] = [cell + across * cap, cell + down * cap];
  const cols = Math.max(...rows.map((row) => row.length));
  const off: string[] = [];
  let i = 0;
  rows.forEach((row, rowIndex) => {
    const shift = ((cols - row.length) * stepX) / 2;
    [...row].forEach((ch, col) => {
      const run = r.runs[i++];
      const g = run?.glyphs[0];
      if (!run || !g || run.text !== ch) {
        off.push(`letter ${i}: expected '${ch}', drew ${JSON.stringify(run?.text)}`);
        return;
      }
      const x = DEFAULT_PAD + shift + col * stepX + cell / 2;
      const y = DEFAULT_PAD + rowIndex * stepY + cell / 2 + cap / 2;
      if (Math.abs((g.inkL + g.inkR) / 2 - x) > EXACT) off.push(`'${ch}' ink centre ${((g.inkL + g.inkR) / 2).toFixed(4)}, expected ${x.toFixed(4)}`);
      if (Math.abs(run.y - y) > EXACT) off.push(`'${ch}' baseline ${run.y.toFixed(4)}, expected ${y.toFixed(4)}`);
    });
  });
  if (i !== r.runs.length) off.push(`${r.runs.length} runs for ${i} letters`);
  // The box is the grid plus the padding, or the ink and a pixel where a tail (Q) hangs out of its cell.
  const w = Math.max(cols * cell + (cols - 1) * across * cap + 2 * DEFAULT_PAD, r.ink.x + r.ink.w + 1);
  const h = Math.max(rows.length * cell + (rows.length - 1) * down * cap + 2 * DEFAULT_PAD, r.ink.y + r.ink.h + 1);
  if (Math.abs(r.box.w - w) > EXACT || Math.abs(r.box.h - h) > EXACT) off.push(`box ${r.box.w.toFixed(4)}×${r.box.h.toFixed(4)}, expected ${w.toFixed(4)}×${h.toFixed(4)}`);
  return off;
}

/**
 * The steps between baselines in Block's rows mode and in Stack (justify none), worked out from the
 * rule: the next line's height above its baseline (cap height for an all-caps name, ascender
 * otherwise), the depth of the line before (none for capitals), and the gap: `gapPx` px.
 */
function stepsOff(r: LayoutResult, m: Measurer, caps: boolean, gapPx: number): string[] {
  const ys = [...new Set(r.runs.filter((run) => run.slot === "name").map((run) => run.y))].sort((a, b) => a - b);
  const step = (caps ? m.capHeight : m.ascender - m.descender) * r.fontSize + gapPx;
  if (ys.length < 2) return [`${ys.length} baselines, expected two or more`];
  return ys.slice(1).flatMap((y, i) => (Math.abs(y - ys[i] - step) > EXACT ? [`baseline ${i + 2} is ${(y - ys[i]).toFixed(4)} px below the one before, expected ${step.toFixed(4)}`] : []));
}

let checks = 0;
let measuredUniqloFirst = 0;
const evennessByFace: string[] = [];
for (const face of faces) {
  const m = face.measurer;

  // Justify: both lines end up exactly as wide, by letter-spacing (track) or by resizing a whole line (size).
  for (const justify of ["track", "size"] as const) {
    const r = layoutFormation(nameOf("Word/mark"), layoutWith({ formation: "stack", stack: { justify } }), m, opts);
    checks++;
    const [a, b] = lineInks(r);
    if (!a || !b) fail(face, `justify ${justify}: expected two lines, got ${lineInks(r).length}`);
    else if (Math.abs(a.right - a.left - (b.right - b.left)) > TOLERANCE)
      fail(face, `justify ${justify}: line widths ${(a.right - a.left).toFixed(2)} and ${(b.right - b.left).toFixed(2)} differ`);
    if (r.fit.length !== 2) fail(face, `justify ${justify}: expected a fit readout per line, got ${JSON.stringify(r.fit)}`);
    if (!finite(r)) fail(face, `justify ${justify}: non-finite numbers in the result`);
  }

  // A line justify cannot bring to width is flagged: one letter has no gap to track, and Size never
  // grows a line past MAX_GROW.
  {
    checks++;
    const track = layoutFormation(nameOf("A/BBBB"), layoutWith({ formation: "stack", stack: { justify: "track" } }), m, opts);
    if (!track.warnings.includes("strained")) fail(face, `justify track 'A/BBBB': a lone letter cannot widen, expected 'strained', got ${JSON.stringify(track.warnings)}`);
    const size = layoutFormation(nameOf("I/MMMMMM"), layoutWith({ formation: "stack", stack: { justify: "size" } }), m, opts);
    const grown = Math.max(...size.runs.map((run) => run.size)) / size.fontSize;
    if (grown > MAX_GROW + 1e-6) fail(face, `justify size 'I/MMMMMM': a line grew ×${grown.toFixed(2)}, more than ×${MAX_GROW}`);
    if (!size.warnings.includes("strained")) fail(face, `justify size 'I/MMMMMM': expected 'strained', got ${JSON.stringify(size.warnings)}`);
  }

  // Letter-spacing turns the common ligatures off, in the measuring and in what the runs are drawn
  // with, as browsers do; with no spacing the font's defaults stand.
  {
    checks++;
    const tracked = layoutFormation(nameOf("Office"), DEFAULT_LAYOUT, m, { ...opts, tracking: 0.05 });
    const run = tracked.runs[0];
    if (run.features.liga !== 0 || run.features.clig !== 0) fail(face, `tracked 'Office': runs drawn with ${JSON.stringify(run.features)}, expected liga and clig off`);
    if (run.glyphs.length !== "Office".length) fail(face, `tracked 'Office': ${run.glyphs.length} glyphs, expected one per letter`);
    const plain = layoutFormation(nameOf("Office"), DEFAULT_LAYOUT, m, opts);
    if ("liga" in plain.runs[0].features) fail(face, "untracked 'Office': ligatures should be left to the font");
  }

  // Leading: 'gyp' over 'hdk' collides when the lines overlap, and not when there is a gap.
  for (const [leading, expected] of [
    [-0.2, true],
    [0.6, false],
  ] as const) {
    checks++;
    const r = layoutFormation(nameOf("gyp/hdk", "lower"), layoutWith({ formation: "stack", stack: { leading } }), m, opts);
    const collided = r.warnings.includes("collision");
    if (collided !== expected) fail(face, `'gyp/hdk' at leading ${leading}: collision ${collided}, expected ${expected}`);
  }

  // Optical edge: the first letter's ink sits on the padding; a round letter hangs out by its overshoot.
  {
    checks++;
    const r = layoutFormation(nameOf("Hamburg"), layoutWith({ opticalEdge: true }), m, opts);
    const left = lineInks(r)[0].left;
    if (Math.abs(left - DEFAULT_PAD) > TOLERANCE) fail(face, `optical edge: ink left ${left.toFixed(2)}, padding ${DEFAULT_PAD}`);
    const round = layoutFormation(nameOf("Ocean"), layoutWith({ opticalEdge: true }), m, opts);
    const expected = DEFAULT_PAD - face.facts.overshoot * round.fontSize;
    if (Math.abs(lineInks(round)[0].left - expected) > TOLERANCE) fail(face, `optical edge: 'O' ink left ${lineInks(round)[0].left.toFixed(2)}, expected ${expected.toFixed(2)}`);
  }

  // Matching: cap height 0.7·S for an all-caps name, x-height 0.5·S otherwise (Auto), and explicit cap.
  {
    checks++;
    const caps = layoutFormation(nameOf("Hamburg", "upper"), layoutWith({ match: "auto" }), m, opts);
    if (Math.abs(caps.fontSize * face.facts.capHeight - 0.7 * S) > TOLERANCE) fail(face, `match auto (caps): cap height ${(caps.fontSize * face.facts.capHeight).toFixed(2)} px, expected ${0.7 * S}`);
    const cap = layoutFormation(nameOf("Hamburg"), layoutWith({ match: "cap" }), m, opts);
    if (Math.abs(cap.fontSize * face.facts.capHeight - 0.7 * S) > TOLERANCE) fail(face, `match cap: cap height ${(cap.fontSize * face.facts.capHeight).toFixed(2)} px, expected ${0.7 * S}`);
    const x = layoutFormation(nameOf("polymodal"), layoutWith({ match: "auto" }), m, opts);
    if (Math.abs(x.fontSize * face.facts.xHeight - 0.5 * S) > TOLERANCE) fail(face, `match auto (lowercase): x-height ${(x.fontSize * face.facts.xHeight).toFixed(2)} px, expected ${0.5 * S}`);
  }

  // Width matching: the ink fills the box between the paddings, whatever the face, and is not a correction.
  {
    checks++;
    const r = layoutFormation(nameOf("Hamburg"), layoutWith({ match: "width" }), m, { ...opts, boxWidth: 400 });
    const line = lineInks(r)[0];
    if (Math.abs(line.right - line.left - (400 - 2 * DEFAULT_PAD)) > TOLERANCE) fail(face, `match width: ink ${(line.right - line.left).toFixed(2)} px wide, expected ${400 - 2 * DEFAULT_PAD}`);
    if (r.warnings.includes("scaled")) fail(face, "match width: reported as scaled");
  }

  // Fit to box: a name too wide for its box is shrunk to fit and says so; nothing is cut.
  {
    checks++;
    const r = layoutFormation(nameOf("Polymodal Studios"), DEFAULT_LAYOUT, m, { ...opts, boxWidth: 260 });
    if (r.box.w > 260 + TOLERANCE) fail(face, `fit: box ${r.box.w.toFixed(1)} px wide in a 260 px column`);
    if (!r.warnings.includes("scaled") || !(r.scale < 1)) fail(face, `fit: expected 'scaled', got ${JSON.stringify(r.warnings)} at scale ${r.scale}`);
    if (r.ink.x < 0 || r.ink.x + r.ink.w > r.box.w || r.ink.y < 0 || r.ink.y + r.ink.h > r.box.h) fail(face, "fit: ink outside the box");
  }

  // A missing letter becomes a placeholder, is never part of the drawn text, and splits the line
  // into two runs that keep their measured positions.
  {
    const lacking = ["é", "ø", "&", "Ł", "☃"].find((ch) => !face.facts.covers(ch));
    if (lacking) {
      checks++;
      const r = layoutFormation(nameOf(`Ca${lacking}fe`), DEFAULT_LAYOUT, m, opts);
      const plain = layoutFormation(nameOf("Cafe"), DEFAULT_LAYOUT, m, opts);
      if (r.missing.length !== 1) fail(face, `'Ca${lacking}fe': ${r.missing.length} placeholders`);
      if (r.runs.map((run) => run.text).join("|") !== "Ca|fe") fail(face, `'Ca${lacking}fe': runs draw ${JSON.stringify(r.runs.map((run) => run.text))}`);
      else if (!(r.runs[1].x - r.runs[0].x > plain.runs[0].glyphs[2].x - plain.runs[0].x)) fail(face, `'Ca${lacking}fe': the gap for the missing letter is gone`);
    }
  }

  // Break suggestions: UNI/QLO leads by letter count, and (reported only) by measured width.
  if (suggestBreaks("UNIQLO", m)[0]?.label === "UNI/QLO") measuredUniqloFirst++;

  // Block cells: 'UNIQLO' is 3×2 in equal square cells as wide as the widest letter (never less than
  // a cap height), each letter's ink centred in its cell and the cap band centred vertically.
  if (face.facts.covers("UNIQLO")) {
    checks++;
    const r = layoutFormation(nameOf("UNIQLO"), layoutWith({ formation: "block", container: NO_CONTAINER }), m, opts);
    const size = r.fontSize;
    const cap = face.facts.capHeight * size;
    const cell = Math.max(cap, ...[..."UNIQLO"].map((ch) => m.run(ch, { size }).inkRight - m.run(ch, { size }).inkLeft));
    const step = cell + DEFAULT_LAYOUT.block.gap * cap;
    if (r.runs.length !== 6) fail(face, `block 'UNIQLO': ${r.runs.length} runs, expected one per letter`);
    r.runs.forEach((run, i) => {
      const [row, col] = [Math.floor(i / 3), i % 3];
      const g = run.glyphs[0];
      const centre = (g.inkL + g.inkR) / 2;
      const expected = DEFAULT_PAD + col * step + cell / 2;
      if (Math.abs(centre - expected) > TOLERANCE) fail(face, `block '${run.text}': ink centre ${centre.toFixed(2)}, cell centre ${expected.toFixed(2)}`);
      const baseline = DEFAULT_PAD + row * step + cell / 2 + cap / 2;
      if (Math.abs(run.y - baseline) > TOLERANCE) fail(face, `block '${run.text}': baseline ${run.y.toFixed(2)}, expected the cap band centred at ${baseline.toFixed(2)}`);
    });
    if (!r.fit.some((f) => f.startsWith("evenness "))) fail(face, `block: no evenness readout in ${JSON.stringify(r.fit)}`);
    evennessByFace.push(`${face.family} ${r.fit.find((f) => f.startsWith("evenness "))?.slice(9)}`);
    if (!finite(r)) fail(face, "block: non-finite numbers in the result");

    // The default container (Auto) puts a block in a filled square tile of TILE·S.
    const boxed = layoutFormation(nameOf("UNIQLO"), layoutWith({ formation: "block" }), m, opts);
    if (boxed.container?.shape !== "square" || boxed.container.style !== "fill") fail(face, `block: Auto gave ${JSON.stringify(boxed.container?.shape)} ${boxed.container?.style}, expected a filled square`);
    else if (Math.abs(boxed.container.w - TILE * S) > TOLERANCE) fail(face, `block: square ${boxed.container.w.toFixed(1)} px, expected ${TILE * S}`);
    if (!inBox(boxed)) fail(face, "block in a square: drawing outside its box");

    // A typed '/' wins: 'UNI/QLO' is two rows of three whatever the columns say.
    const typed = layoutFormation(nameOf("UNI/QLO"), layoutWith({ formation: "block", block: { cols: 2 }, container: NO_CONTAINER }), m, opts);
    const rows = new Set(typed.runs.map((run) => run.y.toFixed(2)));
    if (rows.size !== 2 || typed.runs.length !== 6) fail(face, `block 'UNI/QLO': ${rows.size} rows of ${typed.runs.length} letters, expected 2 of 3`);
  }

  // Block rows: each row one kerned run, letter-spaced to the widest row, never scaled.
  {
    checks++;
    const r = layoutFormation(nameOf("TIMBER"), layoutWith({ formation: "block", block: { mode: "rows" }, container: NO_CONTAINER }), m, opts);
    const [a, b] = lineInks(r);
    if (!a || !b || lineInks(r).length !== 2) fail(face, `block rows 'TIMBER': ${lineInks(r).length} rows, expected 2`);
    else if (Math.abs(a.right - a.left - (b.right - b.left)) > TOLERANCE) fail(face, `block rows: widths ${(a.right - a.left).toFixed(2)} and ${(b.right - b.left).toFixed(2)} differ`);
    if (r.fit.length !== 2) fail(face, `block rows: expected the tracking of each row in the readout, got ${JSON.stringify(r.fit)}`);
    if (r.runs.some((run) => Math.abs(run.size - r.fontSize) > 1e-6)) fail(face, "block rows: a row was resized; rows justify by letter-spacing only");
  }

  // Line gap (block.rowGap): in cells it moves the rows apart and no letter across a row; the letter
  // gap moves letters across and no row. In rows mode it is the gap between rows, and the letter gap
  // has no say. A layout saved before rowGap existed draws exactly as it did, one gap both ways.
  if (face.facts.covers("UNIQLO")) {
    checks++;
    const cells = (block: Partial<LayoutSettings["block"]>) => layoutWith({ formation: "block", block, container: NO_CONTAINER });
    const plain = layoutFormation(nameOf("UNIQLO"), cells({}), m, opts);
    const cap = face.facts.capHeight * plain.fontSize;
    const xs = (r: LayoutResult) => r.runs.map((run) => run.x);
    const ys = (r: LayoutResult) => r.runs.map((run) => run.y);
    const same = (a: number[], b: number[], shift: (i: number) => number = () => 0) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i] - shift(i)) < 1e-6);
    const airy = layoutFormation(nameOf("UNIQLO"), cells({ rowGap: 0.6 }), m, opts);
    const grew = (0.6 - DEFAULT_LAYOUT.block.gap) * cap;
    if (!same(xs(airy), xs(plain))) fail(face, "block line gap: letters moved across a row");
    if (!same(ys(airy), ys(plain), (i) => Math.floor(i / 3) * grew)) fail(face, `block line gap 0.6: row baselines ${JSON.stringify(ys(airy))}, expected each row ${grew.toFixed(2)} px lower than the last`);
    if (Math.abs(airy.box.w - plain.box.w) > 1e-6 || Math.abs(airy.box.h - plain.box.h - grew) > 1e-6) fail(face, "block line gap: the box should grow in height only");
    const wide = layoutFormation(nameOf("UNIQLO"), cells({ gap: 0.4, rowGap: DEFAULT_LAYOUT.block.gap }), m, opts);
    if (!same(ys(wide), ys(plain))) fail(face, "block letter gap: the rows moved");
    if (!(wide.box.w > plain.box.w + 1)) fail(face, "block letter gap: the letters did not spread across");

    const rows = (block: Partial<LayoutSettings["block"]>) => layoutFormation(nameOf("TIMBER"), layoutWith({ formation: "block", block: { mode: "rows", ...block }, container: NO_CONTAINER }), m, opts);
    const step = (r: LayoutResult) => {
      const [a, b] = [...new Set(ys(r))].sort((p, q) => p - q);
      return b - a;
    };
    const rows18 = rows({});
    if (Math.abs(step(rows({ rowGap: 0.6 })) - step(rows18) - (0.6 - DEFAULT_LAYOUT.block.gap) * cap) > 1e-6) fail(face, "block rows: the line gap does not set the gap between rows");
    if (JSON.stringify(rows({ gap: 0.5, rowGap: DEFAULT_LAYOUT.block.gap })) !== JSON.stringify(rows18)) fail(face, "block rows: the letter gap changed the drawing");

    for (const mode of ["cells", "rows"] as const) {
      const legacy = layoutWith({ formation: "block", block: { mode, gap: 0.3 }, container: NO_CONTAINER });
      delete (legacy.block as { rowGap?: unknown }).rowGap;
      const drawn = JSON.stringify(layoutFormation(nameOf("UNIQLO"), legacy, m, opts));
      if (drawn !== JSON.stringify(layoutFormation(nameOf("UNIQLO"), layoutWith({ formation: "block", block: { mode, gap: 0.3, rowGap: 0.3 }, container: NO_CONTAINER }), m, opts)))
        fail(face, `block ${mode} saved without rowGap: not drawn as gap 0.3 both ways`);
      // What every loader does with saved state: deep-merge it over today's defaults.
      if (drawn !== JSON.stringify(layoutFormation(nameOf("UNIQLO"), deepMerge(DEFAULT_LAYOUT, legacy), m, opts))) fail(face, `block ${mode} saved without rowGap: drawn differently once merged over the defaults`);
    }
    // And the old rule itself, written out in cellsOff and stepsOff rather than run through the
    // engine: a layout saved without rowGap is drawn on the old grid of one step both ways, to a
    // millionth of a px. HAMBURG (4+3) also puts a short row on it.
    const GRID = { UNIQLO: ["UNI", "QLO"], HAMBURG: ["HAMB", "URG"] } as const;
    for (const [text, grid] of Object.entries(GRID)) {
      if (!face.facts.covers(text)) continue;
      for (const gap of [0.3, DEFAULT_LAYOUT.block.gap]) {
        const legacy = layoutWith({ formation: "block", block: { gap }, container: NO_CONTAINER });
        delete (legacy.block as { rowGap?: unknown }).rowGap;
        for (const off of cellsOff(layoutFormation(nameOf(text), legacy, m, opts), [...grid], m, gap, gap)) fail(face, `block cells '${text}' saved without rowGap (gap ${gap}): ${off}`);
        const rowsLegacy = { ...legacy, block: { ...legacy.block, mode: "rows" as const } };
        const drawn = layoutFormation(nameOf(text), rowsLegacy, m, opts);
        for (const off of stepsOff(drawn, m, true, gap * face.facts.capHeight * drawn.fontSize)) fail(face, `block rows '${text}' saved without rowGap (gap ${gap}): ${off}`);
      }
      // Split, each gap goes its own way: a short row is still centred by the step across, a line
      // gap of exactly 0 is 0 (not the letter gap), and rows can overlap.
      for (const [gap, rowGap] of [
        [0.1, 1],
        [0.3, 0],
        [0.6, ROW_GAP.min],
      ] as const) {
        const split = layoutWith({ formation: "block", block: { gap, rowGap }, container: NO_CONTAINER });
        for (const off of cellsOff(layoutFormation(nameOf(text), split, m, opts), [...grid], m, gap, rowGap)) fail(face, `block cells '${text}' gap ${gap}, line gap ${rowGap}: ${off}`);
        const drawn = layoutFormation(nameOf(text), { ...split, block: { ...split.block, mode: "rows" } }, m, opts);
        for (const off of stepsOff(drawn, m, true, rowGap * face.facts.capHeight * drawn.fontSize)) fail(face, `block rows '${text}' line gap ${rowGap}: ${off}`);
      }
    }
    // Rows of lowercase step from one row's descenders to the next row's ascenders, plus the line gap in cap heights.
    for (const rowGap of [0, 0.5]) {
      const drawn = layoutFormation(nameOf("gyp/hdk"), layoutWith({ formation: "block", block: { mode: "rows", rowGap }, container: NO_CONTAINER }), m, opts);
      for (const off of stepsOff(drawn, m, false, rowGap * face.facts.capHeight * drawn.fontSize)) fail(face, `block rows 'gyp/hdk' line gap ${rowGap}: ${off}`);
    }
  }

  // Stack leading is in cap heights for an all-caps name and in x-heights otherwise, and the top
  // bar's unit (leadingUnit) names the one the engine uses. A Lockup whose name is stacked with '/'
  // leads its name the same way, so the one slider means the same there.
  for (const [text, textCase] of [
    ["Word/mark", "as"],
    ["gyp/hdk", "lower"],
    ["HAM/BURG", "as"],
  ] as const) {
    checks++;
    const settings = { text, textCase };
    const caps = text === text.toUpperCase();
    const unit = leadingUnit(settings);
    if (unit !== (caps ? "cap" : "x-height")) fail(face, `leadingUnit '${text}': '${unit}', expected '${caps ? "cap" : "x-height"}'`);
    const ref = caps ? face.facts.capHeight : face.facts.xHeight;
    for (const leading of [LEADING.min, 0, DEFAULT_LAYOUT.stack.leading, 1, LEADING.max]) {
      const stack = layoutFormation(parseName(settings), layoutWith({ formation: "stack", stack: { leading } }), m, opts);
      for (const off of stepsOff(stack, m, caps, leading * ref * stack.fontSize)) fail(face, `stack '${text}' leading ${leading}: ${off}`);
      const lockup = layoutFormation({ ...parseName(settings), descriptor: "Hamburg" }, layoutWith({ formation: "lockup", stack: { leading } }), m, opts);
      for (const off of stepsOff(lockup, m, caps, leading * ref * lockup.fontSize)) fail(face, `lockup '${text}' leading ${leading}: ${off}`);
    }
  }

  // The slider ends, tight and airy, lay out in every formation that uses them: finite numbers and
  // nothing outside the box. Letters pushed into each other at the tight end are flagged, never hidden.
  {
    checks++;
    const cases: [string, LayoutInput, LayoutSettings][] = [];
    for (const leading of [LEADING.min, LEADING.max]) {
      for (const text of ["Word/mark", "gyp/hdk", "HAM/BUR", "Word/mark/gyph"]) {
        cases.push([`stack leading ${leading} '${text}'`, nameOf(text), layoutWith({ formation: "stack", stack: { leading } })]);
        cases.push([`stack justify size, leading ${leading} '${text}'`, nameOf(text), layoutWith({ formation: "stack", stack: { leading, justify: "size" } })]);
        cases.push([`lockup leading ${leading} '${text}'`, { ...nameOf(text), descriptor: "Hamburg" }, layoutWith({ formation: "lockup", stack: { leading } })]);
      }
    }
    for (const rowGap of [ROW_GAP.min, ROW_GAP.max]) {
      for (const mode of ["cells", "rows"] as const) {
        for (const container of [NO_CONTAINER, { auto: true }, { auto: false, shape: "circle" as const }]) {
          for (const text of ["HAMBURG", "gyp/hdk", "HAM/BUR"]) cases.push([`block ${mode} line gap ${rowGap} '${text}' ${JSON.stringify(container)}`, nameOf(text), layoutWith({ formation: "block", block: { mode, rowGap }, container })]);
        }
      }
    }
    for (const [label, input, layout] of cases) {
      for (const o of [opts, { ...opts, boxWidth: 300 }]) {
        try {
          const r = layoutFormation(input, layout, m, o);
          if (!finite(r) || !inBox(r)) fail(face, `${label}${o.boxWidth ? " in 300 px" : ""}: non-finite numbers or drawing outside its box`);
        } catch (e) {
          fail(face, `${label}: threw ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    const collided = (input: LayoutInput, layout: LayoutSettings) => layoutFormation(input, layout, m, opts).warnings.includes("collision");
    if (!collided(nameOf("HAM/BUR"), layoutWith({ formation: "stack", stack: { leading: LEADING.min } }))) fail(face, `stack 'HAM/BUR' at leading ${LEADING.min}: lines half a cap height into each other, expected 'collision'`);
    if (collided(nameOf("HAM/BUR"), layoutWith({ formation: "stack", stack: { leading: LEADING.max } }))) fail(face, `stack 'HAM/BUR' at leading ${LEADING.max}: flagged a collision`);
    if (!collided(nameOf("HAM/BUR"), layoutWith({ formation: "block", block: { mode: "rows", rowGap: ROW_GAP.min }, container: NO_CONTAINER }))) fail(face, `block rows 'HAM/BUR' at line gap ${ROW_GAP.min}: expected 'collision'`);
    if (collided(nameOf("HAM/BUR"), layoutWith({ formation: "block", block: { mode: "rows", rowGap: ROW_GAP.max }, container: NO_CONTAINER }))) fail(face, `block rows 'HAM/BUR' at line gap ${ROW_GAP.max}: flagged a collision`);
    // One-stem letters keep the cell at one cap height, so a negative line gap overlaps the rows. (Not
    // every I stops at the cap height: xx Queen juicy's reaches 1.3 caps and touches at the default.)
    if (face.facts.covers("I")) {
      if (!collided(nameOf("III/III"), layoutWith({ formation: "block", block: { rowGap: ROW_GAP.min }, container: NO_CONTAINER }))) fail(face, `block cells 'III/III' at line gap ${ROW_GAP.min}: expected 'collision'`);
      if (collided(nameOf("III/III"), layoutWith({ formation: "block", block: { rowGap: ROW_GAP.max }, container: NO_CONTAINER }))) fail(face, `block cells 'III/III' at line gap ${ROW_GAP.max}: flagged a collision`);
    }
  }

  // Circle: every corner of the name's ink box stays within R − p, the circle is the tile, and a
  // long name shrinks to fit it.
  {
    checks++;
    const layout = layoutWith({ container: { auto: false, shape: "circle", style: "fill" } });
    const r = layoutFormation(nameOf("Polymodal Studios"), layout, m, { ...opts, boxWidth: 600 });
    const c = r.container;
    if (!c || c.shape !== "circle") fail(face, "circle: no circle in the result");
    else {
      const ink = slotInk(r, "name");
      const R = c.w / 2;
      const p = DEFAULT_LAYOUT.container.padding * face.facts.capHeight * r.runs[0].size;
      const far = Math.max(...[ink.left, ink.right].flatMap((x) => [ink.top, ink.bottom].map((y) => Math.hypot(x - (c.x + R), y - (c.y + R)))));
      if (far > R - p + TOLERANCE) fail(face, `circle: an ink corner is ${far.toFixed(2)} px from the centre, more than R − p = ${(R - p).toFixed(2)}`);
      if (Math.abs(c.w - TILE * S) > TOLERANCE) fail(face, `circle: ${c.w.toFixed(1)} px across, expected the ${TILE * S} px tile`);
      if (!(r.runs[0].size < r.fontSize)) fail(face, "circle: a long name did not shrink to fit");
      if (!r.fit.some((f) => f.startsWith("circle ×"))) fail(face, `circle: the fit is not in the readout ${JSON.stringify(r.fit)}`);
    }
    if (!inBox(r)) fail(face, "circle: drawing outside its box");
    const pill = layoutFormation(nameOf("Hamburg"), layoutWith({ container: { auto: false, shape: "pill", style: "keyline" } }), m, opts);
    if (pill.container?.shape !== "pill" || !(pill.container.w > pill.container.h) || !(pill.container.stroke > 0)) fail(face, `pill: ${JSON.stringify(pill.container)}`);
    if (!inBox(pill) || !finite(pill)) fail(face, "pill: drawing outside its box or non-finite");
  }

  // Lockup: with size Match the descriptor's cap height is 0.28 of the name's and its ink is exactly
  // the name's width; placed right, a caps descriptor shares the name's cap line.
  if (face.facts.covers("CLOTHING")) {
    checks++;
    const below = layoutFormation({ ...nameOf("Hamburg", "upper"), descriptor: "clothing" }, layoutWith({ formation: "lockup" }), m, opts);
    const name = slotInk(below, "name");
    const desc = slotInk(below, "descriptor");
    if (Math.abs(desc.right - desc.left - (name.right - name.left)) > TOLERANCE)
      fail(face, `lockup: descriptor ink ${(desc.right - desc.left).toFixed(2)} px, name ink ${(name.right - name.left).toFixed(2)} px`);
    const descRun = below.runs.find((run) => run.slot === "descriptor");
    if (!descRun || descRun.text !== "CLOTHING") fail(face, `lockup: descriptor drawn as ${JSON.stringify(descRun?.text)}, expected the UPPER default case`);
    else if (Math.abs(descRun.size - MATCH_RATIO * below.fontSize) > 1e-6) fail(face, `lockup: descriptor at ${descRun.size.toFixed(2)} px, expected ${MATCH_RATIO} of ${below.fontSize.toFixed(2)}`);
    if (!(desc.top > name.bottom)) fail(face, "lockup below: the descriptor is not under the name");
    if (!below.fit.some((f) => f.startsWith("descriptor "))) fail(face, `lockup: the descriptor's tracking is not in the readout ${JSON.stringify(below.fit)}`);

    const right = layoutFormation({ ...nameOf("Hamburg", "upper"), descriptor: "CLOTHING" }, layoutWith({ formation: "lockup", lockup: { position: "right" } }), m, opts);
    const nameRun = right.runs.find((run) => run.slot === "name");
    const descRight = right.runs.find((run) => run.slot === "descriptor");
    if (nameRun && descRight) {
      const nameCap = nameRun.y - face.facts.capHeight * nameRun.size;
      const descCap = descRight.y - face.facts.capHeight * descRight.size;
      if (Math.abs(nameCap - descCap) > TOLERANCE) fail(face, `lockup right: cap lines at ${nameCap.toFixed(2)} and ${descCap.toFixed(2)}`);
      if (!(slotInk(right, "descriptor").left > slotInk(right, "name").right)) fail(face, "lockup right: the descriptor is not right of the name");
    } else fail(face, "lockup right: missing a run");

    const empty = layoutFormation(nameOf("Hamburg"), layoutWith({ formation: "lockup" }), m, opts);
    if (!empty.runs.some((run) => run.slot === "descriptor" && run.placeholder)) fail(face, "lockup: no faded placeholder when the descriptor is empty");
    const above = layoutFormation({ ...nameOf("Hamburg"), descriptor: "Est. 2026" }, layoutWith({ formation: "lockup", lockup: { position: "above" } }), m, opts);
    if (!(slotInk(above, "descriptor").bottom < slotInk(above, "name").top)) fail(face, "lockup above: the descriptor is not over the name");
    if (!inBox(above) || !inBox(below) || !inBox(right)) fail(face, "lockup: drawing outside its box");

    // A tagline longer than the name is never squeezed past TIGHTEST to reach the name's width: it
    // stays wider, placed by the align setting, and the readout says by how much.
    for (const align of ["left", "center", "right"] as const) {
      const long = layoutFormation({ ...nameOf("Acme"), descriptor: "Premium clothing and accessories since 1949" }, layoutWith({ formation: "lockup", lockup: { align } }), m, opts);
      const tracking = Math.min(...long.runs.filter((run) => run.slot === "descriptor").map((run) => run.tracking));
      if (!(tracking >= TIGHTEST - 1e-9)) fail(face, `lockup long descriptor (${align}): letter-spacing ${tracking.toFixed(3)}em, under the floor ${TIGHTEST}em`);
      const nameInk = slotInk(long, "name");
      const descInk = slotInk(long, "descriptor");
      if (!(descInk.right - descInk.left > nameInk.right - nameInk.left)) fail(face, `lockup long descriptor (${align}): expected it wider than the name`);
      if (!long.fit.some((f) => f.startsWith("descriptor wider than name ×"))) fail(face, `lockup long descriptor: no 'wider' readout in ${JSON.stringify(long.fit)}`);
      if (long.warnings.includes("strained")) fail(face, "lockup long descriptor: a wider descriptor is not strained");
      const edge = align === "left" ? Math.abs(descInk.left - nameInk.left) : align === "right" ? Math.abs(descInk.right - nameInk.right) : Math.abs((descInk.left + descInk.right) / 2 - (nameInk.left + nameInk.right) / 2);
      if (edge > TOLERANCE) fail(face, `lockup long descriptor (${align}): ink edges ${edge.toFixed(2)} px apart`);
      if (!inBox(long) || !finite(long)) fail(face, `lockup long descriptor (${align}): drawing outside its box or non-finite`);
    }
  }

  // Mark: a pair is spaced by ink (0.04 em), the tile is the filled square, and the same mark is
  // set again 32 and 16 px tall under it, at real sizes.
  {
    checks++;
    const r = layoutFormation(nameOf("Hamburg Docks"), layoutWith({ formation: "mark", mark: { construction: "pair" } }), m, opts);
    const letters = r.runs.filter((run) => run.size === Math.max(...r.runs.map((x) => x.size)));
    if (letters.map((run) => run.text).join("") !== "HD") fail(face, `mark pair: drew ${JSON.stringify(letters.map((run) => run.text))}, expected H and D`);
    else {
      const [a, b] = letters.map((run) => run.glyphs[0]);
      const expected = a.inkR + 0.04 * letters[0].size;
      if (Math.abs(b.inkL - expected) > TOLERANCE) fail(face, `mark pair: second ink starts at ${b.inkL.toFixed(2)}, expected ${expected.toFixed(2)}`);
    }
    if (r.container?.shape !== "square") fail(face, "mark: no square tile");
    const heights = (r.tiles ?? []).map((t) => t.h);
    if (heights.length !== MARK_SIZES.length || heights.some((h, i) => Math.abs(h - MARK_SIZES[i]) > 0.01)) fail(face, `mark: small tiles ${JSON.stringify(heights)}, expected ${JSON.stringify(MARK_SIZES)}`);
    if (r.runs.length !== 3 * letters.length) fail(face, `mark: ${r.runs.length} runs, expected the pair three times`);
    if (!inBox(r) || !finite(r)) fail(face, "mark: drawing outside its box or non-finite");
    const fixed = layoutFormation(nameOf("Hamburg"), layoutWith({ formation: "mark" }), m, { ...opts, boxWidth: 140, boxHeight: 140 });
    if (fixed.tiles?.length) fail(face, "mark in a fixed box: the small renders should be left out");
    if (fixed.box.w > 140 + TOLERANCE || fixed.box.h > 140 + TOLERANCE) fail(face, `mark in a 140 px box: drawn ${fixed.box.w.toFixed(1)}×${fixed.box.h.toFixed(1)}`);
    const stacked = layoutFormation(nameOf("Hamburg Docks"), layoutWith({ formation: "mark", mark: { construction: "stacked" }, container: NO_CONTAINER }), m, opts);
    const big = stacked.runs.filter((run) => run.size === Math.max(...stacked.runs.map((x) => x.size)));
    if (big.length !== 2 || !(big[1].y > big[0].y)) fail(face, "mark stacked: expected the pair one above the other");
  }
}

// Outlines (Copy SVG, src/export/outline.ts): the SVG is drawn from the layout, so it has one path
// per drawn letter, each outline sits exactly on the ink box the layout measured for that letter
// (which is where the card draws it), and its viewBox is the layout's box.
const SVG_CASES: [string, LayoutInput, LayoutSettings, LayoutOptions][] = [
  ["line", nameOf("Wordmark"), DEFAULT_LAYOUT, opts],
  ["line, letter-spaced and shrunk to a 260 px card", nameOf("Wordmark"), DEFAULT_LAYOUT, { ...opts, tracking: 0.08, boxWidth: 260 }],
  ["stack justified by tracking", nameOf("Word/mark"), layoutWith({ formation: "stack", stack: { justify: "track" } }), opts],
  ["block in a filled square", nameOf("UNIQLO"), layoutWith({ formation: "block" }), opts],
  ["lockup", { ...nameOf("Hamburg", "upper"), descriptor: "clothing" }, layoutWith({ formation: "lockup" }), opts],
  ["mark pair with its small sizes", nameOf("Hamburg Docks"), layoutWith({ formation: "mark", mark: { construction: "pair" } }), opts],
  ["pill keyline", nameOf("Hamburg"), layoutWith({ container: { auto: false, shape: "pill", style: "keyline" } }), opts],
];
let svgChecks = 0;
for (const face of faces.slice(0, 5)) {
  for (const [label, input, layout, o] of SVG_CASES) {
    if (!face.facts.covers(input.flat.replace(/\s/g, "") + (input.descriptor ?? "").toUpperCase())) continue;
    checks++;
    svgChecks++;
    const r = layoutFormation(input, layout, face.measurer, o);
    const recipe: Recipe = { text: input.flat, weight: 400, textCase: "as", tracking: o.tracking, features: {}, axes: null, layout };
    const out = svgFromLayout(r, { primary: face.font }, { family: face.family, source: "cache", license: "test", weight: 400, recipe });
    const where = `svg ${label}`;
    if (!out.svg.startsWith("<svg")) fail(face, `${where}: does not start with <svg`);
    const view = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(out.svg);
    if (!view || Math.abs(Number(view[1]) - r.box.w) > TOLERANCE || Math.abs(Number(view[2]) - r.box.h) > TOLERANCE)
      fail(face, `${where}: viewBox ${view?.slice(1).join("×")} but the layout's box is ${r.box.w.toFixed(2)}×${r.box.h.toFixed(2)}`);
    const glyphs = r.runs.flatMap((run) => run.glyphs).filter((g) => g.inkR > g.inkL && g.char.trim());
    const paths = [...out.svg.matchAll(/<path id="([^"]*)"([^>]*) d="([^"]*)"/g)].filter((m) => m[1] !== "pill" && m[1] !== "clear space");
    if (paths.length !== glyphs.length) {
      fail(face, `${where}: ${paths.length} paths for ${glyphs.length} drawn letters`);
      continue;
    }
    paths.forEach((m, i) => {
      const g = glyphs[i];
      if (m[1] !== g.char) fail(face, `${where}: path ${i} is named ${JSON.stringify(m[1])}, the letter is ${JSON.stringify(g.char)}`);
      const box = pathBox(m[3]);
      const off = Math.max(Math.abs(box.minX - g.inkL), Math.abs(box.maxX - g.inkR), Math.abs(box.minY - g.inkT), Math.abs(box.maxY - g.inkB));
      if (off > TOLERANCE) fail(face, `${where}: the outline of '${g.char}' is ${off.toFixed(2)} px from where the layout draws it`);
    });
    // Letters knocked out of a filled shape take the paper colour; the shape is drawn in ink.
    if (r.container?.style === "fill") {
      if (!out.svg.includes(`<rect id="square"`) || !out.svg.includes(`fill="${INK}"`)) fail(face, `${where}: no filled square in ink`);
      if (paths.some((m) => !m[2].includes(`fill="${PAPER}"`))) fail(face, `${where}: letters on a filled shape should take the paper colour`);
    }
    if (layout.formation === "mark" && !(out.svg.includes('<g id="32 px">') && out.svg.includes('<g id="16 px">'))) fail(face, `${where}: the 32 and 16 px copies are not grouped`);
    if (layout.container.shape === "pill" && !/<path id="pill" d="M[^"]+A[^"]+" fill="none" stroke=/.test(out.svg)) fail(face, `${where}: no keyline pill path`);
    if (!out.desc.includes(face.family) || !out.svg.includes("<desc>")) fail(face, `${where}: the description does not name the face`);
  }
}
if (svgChecks < 15) failures.push(`svg: only ${svgChecks} outline cases ran (fonts lack the test letters?)`);

/** The ink box of SVG path data as pathFor writes it (absolute M, L, Q, C and Z), curves sampled. */
function pathBox(d: string) {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  };
  let x0 = 0;
  let y0 = 0;
  for (const [, command, args] of d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/\s+/).map(Number) : [];
    if (command === "Z") continue;
    const [x, y] = n.slice(-2);
    if (command === "Q" || command === "C") {
      for (let k = 1; k < 64; k++) {
        const t = k / 64;
        const u = 1 - t;
        if (command === "Q") add(u * u * x0 + 2 * u * t * n[0] + t * t * x, u * u * y0 + 2 * u * t * n[1] + t * t * y);
        else add(u * u * u * x0 + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t * t * t * x, u * u * u * y0 + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t * t * t * y);
      }
    }
    add(x, y);
    x0 = x;
    y0 = y;
  }
  return box;
}

// Font-independent rules.
checks++;
// The automatic block grid: 4 letters 2×2, 5 as 3+2, 7 as 4+3, 8 as 4×2, 9 as 3×3, 10 by ceil(√n).
for (const [name, expected] of [
  ["ABCD", "2,2"],
  ["ABCDE", "3,2"],
  ["ABCDEFG", "4,3"],
  ["ABCDEFGH", "4,4"],
  ["ABCDEFGHI", "3,3,3"],
  ["ABCDEFGHIJ", "4,4,2"],
  ["AB CD EF", "3,3"],
] as const) {
  const r = layoutFormation(nameOf(name), layoutWith({ formation: "block", container: NO_CONTAINER }), nominalMeasurer, opts);
  const rows = new Map<string, number>();
  for (const run of r.runs) rows.set(run.y.toFixed(2), (rows.get(run.y.toFixed(2)) ?? 0) + 1);
  const got = [...rows.values()].join(",");
  if (got !== expected) failures.push(`block grid '${name}': rows ${got}, expected ${expected}`);
}
// A candidate saved before rowGap is the same recipe as the grid when they draw the same (pressing S
// again removes it instead of adding a twin), and a different one when the rows differ.
{
  const blockRecipe = (block: Partial<LayoutSettings["block"]>, legacy = false): Recipe => {
    const layout = layoutWith({ formation: "block", block });
    if (legacy) delete (layout.block as { rowGap?: unknown }).rowGap;
    return { text: "UNIQLO", weight: 400, textCase: "as", tracking: 0, features: {}, axes: null, layout };
  };
  if (!sameRecipe(blockRecipe({ gap: 0.3 }, true), blockRecipe({ gap: 0.3, rowGap: 0.3 }))) failures.push("sameRecipe: a block saved without rowGap differs from the same gap set both ways");
  if (sameRecipe(blockRecipe({ gap: 0.3 }, true), blockRecipe({ gap: 0.3, rowGap: 0.18 }))) failures.push("sameRecipe: different line gaps count as the same recipe");
}
// A line gap of exactly 0 is a gap of 0, not "unset": only a missing one follows the letter gap.
if (rowGapOf({ gap: 0.3, rowGap: 0 }) !== 0 || rowGapOf({ gap: 0.3, rowGap: null }) !== 0.3) failures.push("rowGapOf: 0 must stay 0 and only null follows the gap");
// The slider ends the brief fixed, so tight and airy stacks and blocks stay possible; both start at the old defaults.
if (LEADING.min !== -0.5 || LEADING.max !== 1.5 || LEADING.reset !== 0.25) failures.push(`stack leading range ${JSON.stringify(LEADING)}, expected -0.5..1.5, reset 0.25`);
if (ROW_GAP.min !== -0.3 || ROW_GAP.max !== 1 || ROW_GAP.reset !== 0.18) failures.push(`block line gap range ${JSON.stringify(ROW_GAP)}, expected -0.3..1, reset 0.18`);
if (Math.abs(evenness([2, 2, 2])) > 1e-9 || !(evenness([1, 2, 3]) > 0.3)) failures.push("evenness: expected 0 for equal widths and more for uneven ones");
// A name being typed can be empty or only spaces: every formation and container still gives a finite drawing.
for (const text of ["", "   "]) {
  for (const formation of ["line", "stack", "block", "lockup", "mark"] as const) {
    for (const container of [NO_CONTAINER, { auto: true }, { auto: false, shape: "circle" as const }]) {
      for (const mode of ["cells", "rows"] as const) {
        const r = layoutFormation(nameOf(text), layoutWith({ formation, container, block: { mode } }), nominalMeasurer, { ...opts, boxWidth: 300 });
        if (!finite(r)) failures.push(`empty name '${text}' in ${formation} (${mode}, ${JSON.stringify(container)}): non-finite numbers`);
      }
    }
  }
}
const blockSettings = { text: "UNIQLO", textCase: "as" as const, size: S, tracking: 0 };
if (columnWidth(layoutWith({ formation: "block" }), blockSettings) < TILE * S + 2 * DEFAULT_PAD) failures.push("columnWidth: a block column is narrower than its tile");
if (!(intrinsicHeight(layoutWith({ formation: "mark" }), blockSettings) > TILE * S + MARK_SIZES[0])) failures.push("intrinsicHeight: a mark card should be estimated with its tile and the small renders");
if (suggestBreaks("UNIQLO", null)[0]?.label !== "UNI/QLO") failures.push(`suggestBreaks('UNIQLO') leads with ${suggestBreaks("UNIQLO", null)[0]?.label}`);
if (suggestBreaks("Acme Studio", null).map((s) => s.label).join() !== "Acme/Studio") failures.push(`suggestBreaks('Acme Studio') should break only between the words: ${suggestBreaks("Acme Studio", null).map((s) => s.label).join(", ")}`);
if (suggestBreaks("Polymodal", null, 3).length !== 4) failures.push("suggestBreaks('Polymodal', 3 lines) should offer 4 splits");
if (suggestBreaks("Polymoda", null, 3).length !== 0) failures.push("suggestBreaks gives 3-line splits for fewer than 9 letters");
if (suggestBreaks("UNIQLO", null).some((s) => s.lines.some((l) => l.length < 2))) failures.push("suggestBreaks leaves a line with fewer than 2 letters");
const settings = { text: "Wordmark", textCase: "as" as const, size: S, tracking: 0 };
const width = columnWidth(DEFAULT_LAYOUT, settings);
if (width < 240 || width > 1400) failures.push(`columnWidth ${width} outside 240-1400`);
if (!(intrinsicHeight(layoutWith({ formation: "stack" }), settings) > intrinsicHeight(DEFAULT_LAYOUT, settings))) failures.push("a stack should be estimated taller than a line");

console.log(`fonts: ${faces.map((f) => f.family).join(", ")}`);
console.log(`checks: ${checks} groups over ${faces.length} fonts`);
console.log(`'UNI/QLO' ranked first by measured width in ${measuredUniqloFirst} of ${faces.length} fonts`);
console.log(`block 'UNIQLO' evenness (lower holds the module): ${evennessByFace.join(", ")}`);
console.log(`outline SVGs checked against their layouts: ${svgChecks}`);
if (failures.length) {
  console.error(`\nFAIL ${failures.length}:\n  ${failures.join("\n  ")}`);
  console.log("\ncheck:layout failed");
  process.exit(1);
}
console.log("\ncheck:layout ok");
