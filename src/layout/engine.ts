// The layout engine: one pure function from a name, a layout and a measurer to positioned runs.
// Wordmark draws its result, Compare and the exports reuse it, and the Node check script tests it,
// so nothing here touches the DOM. Line and Stack live here; Block, Lockup and Mark have their own
// files and register in FORMATIONS, and container.ts puts any of them in a shape.
import type { Measurer, RunMetrics } from "../facts/types";
import type { Formation, LayoutSettings, MatchMode } from "../recipe";
import { formBlock } from "./block";
import { stackLines } from "./breaks";
import { fitInContainer } from "./container";
import { formLockup } from "./lockup";
import { formMark } from "./mark";
import type { ContainerShape, FormationContext, FormationFn, Formed, LayoutInput, LayoutOptions, LayoutResult, LayoutWarning, Rect, Run, RunGlyph } from "./types";

/** Space around the drawing, in px: the card's old padding. */
export const DEFAULT_PAD = 18;

/** The most Justify Size enlarges a line. Lines it cannot bring to width stay short and read 'strained'. */
export const MAX_GROW = 2;

/** Letters whose round side may hang past the alignment edge by the font's overshoot, as O does past H. */
export const ROUND = /^[OCGQSoce]/;

/** Formations without an entry here are set as Line. */
export const FORMATIONS: Partial<Record<Formation, FormationFn>> = {
  line: formLine,
  stack: formStack,
  block: formBlock,
  lockup: formLockup,
  mark: formMark,
};

export function layoutFormation(input: LayoutInput, layout: LayoutSettings, measurer: Measurer, options: LayoutOptions): LayoutResult {
  const opts = {
    size: options.size,
    weight: options.weight,
    tracking: options.tracking,
    features: options.features,
    boxWidth: options.boxWidth,
    boxHeight: options.boxHeight,
    pad: options.pad ?? DEFAULT_PAD,
    serif: options.serif,
  };
  const caps = isCapsName(input);
  const fontSize = matchedSize(measurer, layout.match, opts.size, caps);
  const ctx: FormationContext = { input, layout, measurer, opts, fontSize, caps };

  let formed = (FORMATIONS[layout.formation] ?? formLine)(ctx);
  const room = opts.boxWidth === undefined ? Infinity : Math.max(1, opts.boxWidth - 2 * opts.pad);
  // Width matching scales the whole drawing so its ink fills the box: that is the match, not a correction.
  if (layout.match === "width" && Number.isFinite(room) && formed.box.w > 0) formed = scaleFormed(formed, room / formed.box.w);
  formed = applyContainer(formed, ctx);

  let scale = 1;
  const roomHigh = opts.boxHeight === undefined ? Infinity : Math.max(1, opts.boxHeight - 2 * opts.pad);
  const [needW, needH] = drawnSize(formed, opts.pad);
  if (needW > room + 0.01 || needH > roomHigh + 0.01) {
    scale = Math.min(room / needW, roomHigh / needH);
    formed = scaleFormed(formed, scale);
    formed.warnings = [...formed.warnings, "scaled"];
  }
  if (formed.after) formed = formed.after(formed);
  return finish(formed, opts.pad, scale, fontSize);
}

/** No lowercase letter in the name: it is matched, banded and leaded in cap heights, not x-heights. */
export function isCapsName(input: Pick<LayoutInput, "flat" | "lines">): boolean {
  return !/\p{Ll}/u.test([input.flat, ...input.lines].join(" "));
}

/**
 * The font size that equalises what the match mode names, so no face wins by being drawn bigger.
 * With the slider at S: cap height 0.7·S, or x-height 0.5·S; 'auto' picks cap height when the name
 * has no lowercase. 'em' is plain font size S, and 'width' starts there and is scaled to the box later.
 */
export function matchedSize(measurer: Measurer, match: MatchMode, size: number, caps: boolean): number {
  const mode = match === "auto" ? (caps ? "cap" : "x") : match;
  // A broken font can report a near-zero height; the floor keeps it from being set enormous.
  if (mode === "cap") return (0.7 * size) / Math.max(0.15, measurer.capHeight);
  if (mode === "x") return (0.5 * size) / Math.max(0.15, measurer.xHeight);
  return size;
}

/** The layout's container (container.ts), or the drawing unchanged when it has none. */
function applyContainer(formed: Formed, ctx: FormationContext): Formed {
  return fitInContainer(formed, ctx);
}

// --- lines ---

/** A measured line, before it is placed. */
export interface SetLine {
  text: string;
  size: number;
  /** Letter-spacing in em. */
  tracking: number;
  metrics: RunMetrics;
  /** The OpenType features it was measured with, which its runs are drawn with (see lineFeatures). */
  features?: Record<string, 0 | 1>;
  /**
   * The edges lines align on, in px from the pen origin. With optical edge on: the ink, with a round
   * first or last letter allowed to hang out by the overshoot. Off: the pen box (origin to advance),
   * in Stack too, where the spec aligns lines by their ink: the toggle promises "align the ink, not
   * the sidebearing", so turning it off is the designer asking for sidebearing alignment everywhere.
   */
  left: number;
  right: number;
}

export const lineWidth = (l: SetLine) => l.right - l.left;

/**
 * The features a line is set with. A letter-spaced line leaves out the common ligatures (fi, fl)
 * unless the recipe asks for them, as CSS does: spaced letters around a tight ligature read as a
 * mistake. Measuring and drawing both use this list, so they agree on every glyph.
 */
export function lineFeatures(features: Record<string, 0 | 1> | undefined, tracking: number): Record<string, 0 | 1> | undefined {
  return Math.abs(tracking) < 1e-6 ? features : { liga: 0, clig: 0, ...features };
}

export function setLine(ctx: FormationContext, text: string, size: number, tracking: number): SetLine {
  const features = lineFeatures(ctx.opts.features, tracking);
  const metrics = ctx.measurer.run(text, { size, tracking, features });
  const inked = metrics.glyphs.filter((g) => g.missing || g.inkR > g.inkL);
  if (!ctx.layout.opticalEdge || !inked.length) return { text, size, tracking, features, metrics, left: 0, right: metrics.advance };
  const first = inked.reduce((a, g) => (g.inkL < a.inkL ? g : a));
  const last = inked.reduce((a, g) => (g.inkR > a.inkR ? g : a));
  const hang = ctx.measurer.overshoot * size;
  return {
    text,
    size,
    tracking,
    features,
    metrics,
    left: metrics.inkLeft + (!first.missing && ROUND.test(first.char) ? hang : 0),
    right: metrics.inkRight - (!last.missing && ROUND.test(last.char) ? hang : 0),
  };
}

/**
 * The same line with extra letter-spacing so its width (edge to edge) reaches `target`. Tracking goes
 * between glyphs only, so the width grows by one step per gap. When a letter further in reaches past
 * the end letters (a long tail), a secant step or two corrects the first guess.
 */
export function trackTo(ctx: FormationContext, line: SetLine, target: number): SetLine {
  const gaps = line.metrics.glyphs.filter((g) => g.advance !== 0).length - 1;
  if (gaps < 1 || Math.abs(lineWidth(line) - target) < 0.01) return line;
  let prev = line;
  let next = setLine(ctx, line.text, line.size, line.tracking + (target - lineWidth(line)) / gaps / line.size);
  for (let i = 0; i < 4 && Math.abs(lineWidth(next) - target) > 0.05; i++) {
    const slope = (lineWidth(next) - lineWidth(prev)) / (next.tracking - prev.tracking);
    if (!(Math.abs(slope) > 1e-6)) break;
    prev = next;
    next = setLine(ctx, line.text, line.size, next.tracking + (target - lineWidth(next)) / slope);
  }
  return next;
}

/**
 * Room above the first baseline. Every font gets at least what a typical face needs for this name
 * (0.76·S with capitals, ascenders or accents, 0.52·S for x-height letters only), so cards set alike
 * line up and flipping between fonts keeps the baseline still. Ink that reaches higher gets its room.
 */
export function headroom(ctx: FormationContext, line: SetLine): number {
  const tall = /[^\sacemnorsuvwxz.,:;\-–—_'"‘’“”]/u.test(line.text);
  return Math.max((tall ? 0.76 : 0.52) * ctx.opts.size * (line.size / ctx.fontSize), line.metrics.inkTop);
}

/** Room below the last baseline, on the same terms as headroom. */
export function footroom(ctx: FormationContext, line: SetLine): number {
  const descends = /[gjpqyQJ,;̧̨]/u.test(line.text.normalize("NFD"));
  return Math.max((descends ? 0.24 : 0.04) * ctx.opts.size * (line.size / ctx.fontSize), -line.metrics.inkBottom);
}

/**
 * Turns a measured line into runs, with its pen origin at x and its baseline at y. A missing letter
 * becomes a placeholder rect and splits the line: the parts either side are separate runs at their
 * measured positions, so the browser never draws that letter from a fallback font.
 */
export function placeLine(ctx: FormationContext, line: SetLine, x: number, y: number, slot: Run["slot"] = "name"): { runs: Run[]; missing: Rect[]; glyphs: RunGlyph[] } {
  const glyphs: RunGlyph[] = line.metrics.glyphs.map((g) => ({
    index: g.index,
    char: g.char,
    x: x + g.x,
    w: g.advance,
    inkL: x + g.inkL,
    inkR: x + g.inkR,
    inkT: y - g.inkT,
    inkB: y - g.inkB,
    missing: g.missing,
  }));
  const runs: Run[] = [];
  const missing: Rect[] = [];
  let part: RunGlyph[] = [];
  const flush = () => {
    const first = part[0];
    if (first) {
      runs.push({
        text: part.map((g) => g.char).join(""),
        x: first.x,
        y,
        size: line.size,
        tracking: line.tracking,
        weight: ctx.opts.weight,
        features: line.features ?? ctx.opts.features ?? {},
        slot,
        glyphs: part.map((g) => ({ ...g, index: g.index - first.index })),
      });
    }
    part = [];
  };
  for (const g of glyphs) {
    if (!g.missing) {
      part.push(g);
      continue;
    }
    flush();
    missing.push({ x: g.inkL, y: g.inkT, w: g.inkR - g.inkL, h: g.inkB - g.inkT });
  }
  flush();
  return { runs, missing, glyphs };
}

// --- formations ---

export function formLine(ctx: FormationContext): Formed {
  const line = setLine(ctx, ctx.input.flat, ctx.fontSize, ctx.opts.tracking);
  const top = headroom(ctx, line);
  const placed = placeLine(ctx, line, -line.left, top);
  return { runs: placed.runs, missing: placed.missing, box: { w: lineWidth(line), h: top + footroom(ctx, line) }, fit: [], warnings: [] };
}

/**
 * Two or more lines. Leading is the gap between lines in cap heights (a caps name) or x-heights:
 * for caps the baseline step is cap·(1 + leading); with lowercase the gap runs from one line's
 * descender to the next line's ascender, so a leading of 0 lets extenders just meet.
 */
export function formStack(ctx: FormationContext): Formed {
  const { align, justify, leading } = ctx.layout.stack;
  const m = ctx.measurer;
  let lines = stackLines(ctx.input, ctx.layout).map((t) => setLine(ctx, t, ctx.fontSize, ctx.opts.tracking));
  const target = Math.max(...lines.map(lineWidth));
  const fit: string[] = [];
  const warnings: LayoutWarning[] = [];
  let strained = false;
  if (lines.length > 1 && justify === "track") {
    lines = lines.map((l) => {
      const tracked = trackTo(ctx, l, target);
      const extra = tracked.tracking - ctx.opts.tracking;
      // A line of one letter has no gap to spread, so it stays short: that is strained too.
      if (Math.abs(extra) > 0.1 + 1e-9 || Math.abs(lineWidth(tracked) - target) > 0.5) strained = true;
      fit.push(formatTracking(extra));
      return tracked;
    });
  } else if (lines.length > 1 && justify === "size") {
    // The whole line grows (never scaleX), so the letters keep their drawn proportions. Never past
    // MAX_GROW: 'I/MMMMMM' would otherwise set a lone I several screens tall.
    lines = lines.map((l) => {
      const k = lineWidth(l) > 0 ? Math.min(MAX_GROW, target / lineWidth(l)) : 1;
      if (k > 1.25 + 1e-9 || lineWidth(l) * k < target - 0.5) strained = true;
      fit.push(formatScale(k));
      return k === 1 ? l : setLine(ctx, l.text, l.size * k, l.tracking);
    });
  }
  if (strained) warnings.push("strained");

  const refPx = (ctx.caps ? m.capHeight : m.xHeight) * ctx.fontSize;
  const above = (l: SetLine) => (ctx.caps ? m.capHeight : m.ascender) * l.size;
  const below = (l: SetLine) => (ctx.caps ? 0 : -m.descender * l.size);
  const baselines = [headroom(ctx, lines[0])];
  for (let i = 1; i < lines.length; i++) baselines.push(baselines[i - 1] + below(lines[i - 1]) + above(lines[i]) + leading * refPx);

  const width = Math.max(...lines.map(lineWidth));
  const runs: Run[] = [];
  const missing: Rect[] = [];
  const placed = lines.map((l, i) => {
    const slack = width - lineWidth(l);
    const offset = align === "left" ? 0 : align === "center" ? slack / 2 : slack;
    const p = placeLine(ctx, l, offset - l.left, baselines[i]);
    runs.push(...p.runs);
    missing.push(...p.missing);
    return p.glyphs;
  });
  for (let i = 0; i + 1 < placed.length; i++) {
    if (collides(placed[i], placed[i + 1])) {
      warnings.push("collision");
      break;
    }
  }
  const last = lines.length - 1;
  return { runs, missing, box: { w: width, h: baselines[last] + footroom(ctx, lines[last]) }, fit, warnings };
}

/** Any glyph box of one line overlapping one of the next, counting only pairs whose x-ranges overlap. */
export function collides(upper: RunGlyph[], lower: RunGlyph[]): boolean {
  const inked = (g: RunGlyph) => g.inkR - g.inkL > 0.01 && g.inkB - g.inkT > 0.01;
  for (const a of upper) {
    if (!inked(a)) continue;
    for (const b of lower) {
      if (!inked(b)) continue;
      if (a.inkR > b.inkL + 0.01 && b.inkR > a.inkL + 0.01 && a.inkB > b.inkT + 0.01 && b.inkB > a.inkT + 0.01) return true;
    }
  }
  return false;
}

export function formatTracking(em: number): string {
  return `${em < -0.0005 ? "−" : "+"}${Math.abs(em).toFixed(2)}em`;
}

export function formatScale(k: number): string {
  return `×${k.toFixed(2)}`;
}

// --- geometry ---

/** Scales a whole drawing about its origin: positions, font sizes and the box. */
export function scaleFormed(f: Formed, s: number): Formed {
  if (s === 1) return f;
  const rect = (r: Rect) => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });
  return {
    ...f,
    runs: f.runs.map((r) => ({
      ...r,
      x: r.x * s,
      y: r.y * s,
      size: r.size * s,
      glyphs: r.glyphs.map((g) => ({ ...g, x: g.x * s, w: g.w * s, inkL: g.inkL * s, inkR: g.inkR * s, inkT: g.inkT * s, inkB: g.inkB * s })),
    })),
    missing: f.missing.map(rect),
    box: { w: f.box.w * s, h: f.box.h * s },
    container: f.container && scaleShape(f.container, s),
    tiles: f.tiles?.map((t) => scaleShape(t, s)),
  };
}

const scaleShape = (c: ContainerShape, s: number): ContainerShape => ({ ...c, x: c.x * s, y: c.y * s, w: c.w * s, h: c.h * s, rx: c.rx * s, stroke: c.stroke * s });

/** Moves a whole drawing by (dx, dy): positions, ink and shapes. */
export function moveFormed(f: Formed, dx: number, dy: number): Formed {
  if (dx === 0 && dy === 0) return f;
  const move = <T extends Rect>(r: T): T => ({ ...r, x: r.x + dx, y: r.y + dy });
  return {
    ...f,
    runs: f.runs.map((r) => ({
      ...r,
      x: r.x + dx,
      y: r.y + dy,
      glyphs: r.glyphs.map((g) => ({ ...g, x: g.x + dx, inkL: g.inkL + dx, inkR: g.inkR + dx, inkT: g.inkT + dy, inkB: g.inkB + dy })),
    })),
    missing: f.missing.map(move),
    container: f.container && move(f.container),
    tiles: f.tiles?.map(move),
  };
}

/** Everything with ink (shapes included), in the drawing's own coordinates, or null when nothing has any. */
export function inkBounds(f: Pick<Formed, "runs" | "missing" | "container" | "tiles">): Rect | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    l = Math.min(l, x0);
    t = Math.min(t, y0);
    r = Math.max(r, x1);
    b = Math.max(b, y1);
  };
  for (const run of f.runs) for (const g of run.glyphs) if (g.inkR > g.inkL || g.inkB > g.inkT) add(g.inkL, g.inkT, g.inkR, g.inkB);
  for (const m of f.missing) add(m.x, m.y, m.x + m.w, m.y + m.h);
  for (const c of [f.container, ...(f.tiles ?? [])]) if (c) add(c.x, c.y, c.x + c.w, c.y + c.h);
  return l <= r ? { x: l, y: t, w: r - l, h: b - t } : null;
}

/** The room the drawing needs inside its padding. Ink may hang into the padding (a round letter's overshoot), never past it. */
function drawnSize(f: Formed, pad: number): [number, number] {
  const ink = inkBounds(f);
  if (!ink) return [f.box.w, f.box.h];
  return [
    Math.max(f.box.w, ink.x + ink.w + 1 - pad) - Math.min(0, ink.x - 1 + pad),
    Math.max(f.box.h, ink.y + ink.h + 1 - pad) - Math.min(0, ink.y - 1 + pad),
  ];
}

/** Pads the drawing and moves it into its own box, growing the box wherever ink would otherwise be cut. */
function finish(f: Formed, pad: number, scale: number, fontSize: number): LayoutResult {
  const ink = inkBounds(f);
  let left = -pad;
  let top = -pad;
  let right = f.box.w + pad;
  let bottom = f.box.h + pad;
  if (ink) {
    left = Math.min(left, ink.x - 1);
    top = Math.min(top, ink.y - 1);
    right = Math.max(right, ink.x + ink.w + 1);
    bottom = Math.max(bottom, ink.y + ink.h + 1);
  }
  const dx = -left;
  const dy = -top;
  const move = (r: Rect) => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
  return {
    runs: f.runs.map((r) => ({
      ...r,
      x: r.x + dx,
      y: r.y + dy,
      glyphs: r.glyphs.map((g) => ({ ...g, x: g.x + dx, inkL: g.inkL + dx, inkR: g.inkR + dx, inkT: g.inkT + dy, inkB: g.inkB + dy })),
    })),
    missing: f.missing.map(move),
    ink: ink ? move(ink) : { x: dx, y: dy, w: 0, h: 0 },
    box: { w: right - left, h: bottom - top },
    container: f.container && { ...f.container, ...move(f.container) },
    tiles: f.tiles?.map((t) => ({ ...t, ...move(t) })),
    fit: f.fit,
    warnings: f.warnings,
    scale,
    fontSize,
  };
}
