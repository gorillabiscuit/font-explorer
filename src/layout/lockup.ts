// Lockup: the name with a descriptor line (a tagline or category, 'CLOTHING'), in the same face and
// weight. The name is set as Line, or as Stack when it has a typed '/'. With size 'match' the
// descriptor's cap height is 0.28 of the name's and it is letter-spaced out to the name's ink width.
// A descriptor already wider than the name at its tightest is left wider, never squeezed to fit.
import type { TextCase } from "../settings";
import { collides, formatTracking, formLine, formStack, inkBounds, moveFormed, placeLine, setLine, type SetLine } from "./engine";
import type { FormationContext, Formed, LayoutWarning, Run } from "./types";

/** Shown faded until a descriptor is typed, so the lockup's shape can be judged before the words exist. */
export const DESCRIPTOR_PLACEHOLDER = "DESCRIPTOR LINE";
/** With size 'match': the descriptor's cap height as a share of the name's. */
export const MATCH_RATIO = 0.28;
/**
 * The tightest letter-spacing Match gives a descriptor, in em. It may close up a line a little wider
 * than the name, but small capitals set tighter than their own spacing start to touch, so a longer
 * line stays wider than the name and the card says by how much.
 */
export const TIGHTEST = 0;

export function formLockup(ctx: FormationContext): Formed {
  const m = ctx.measurer;
  const { lockup } = ctx.layout;
  const name = ctx.input.lines.length > 1 ? formStack(ctx) : formLine(ctx);
  const nameInk = inkBounds(name);
  if (!nameInk) return name;
  const nameRuns = name.runs.filter((r) => r.slot === "name");
  const baselines = nameRuns.map((r) => r.y);
  const firstBaseline = baselines.length ? Math.min(...baselines) : nameInk.y + nameInk.h;
  const lastBaseline = baselines.length ? Math.max(...baselines) : nameInk.y + nameInk.h;
  const capPx = m.capHeight * ctx.fontSize;

  const typed = (ctx.input.descriptor ?? "").replace(/\s+/gu, " ").trim();
  const placeholder = !typed;
  const text = cased(typed || DESCRIPTOR_PLACEHOLDER, lockup.textCase);
  const ratio = lockup.size === "match" ? MATCH_RATIO : Math.min(0.5, Math.max(0.2, lockup.size));
  const size = ratio * ctx.fontSize;
  const descCap = m.capHeight * size;

  const fit = [...name.fit];
  const warnings: LayoutWarning[] = [...name.warnings];
  // Beside the name there is no width to match, so the descriptor keeps its own letter-spacing.
  const matchWidth = lockup.size === "match" && lockup.position !== "right";
  let desc = setLine(ctx, text, size, lockup.tracking);
  if (matchWidth) {
    desc = trackToInk(ctx, desc, nameInk.w);
    if (desc.tracking < TIGHTEST) desc = setLine(ctx, text, size, TIGHTEST);
    const over = inkWidth(desc) - nameInk.w;
    if (over > 0.5 && nameInk.w > 0) fit.push(`descriptor wider than name ×${(inkWidth(desc) / nameInk.w).toFixed(2)}`);
    else {
      // Short of the name's width: a single letter has no gap to spread.
      if (over < -0.5) warnings.push("strained");
      fit.push(`descriptor ${formatTracking(desc.tracking)}`);
    }
  }

  // Where the descriptor's ink starts (x) and where its baseline sits (y).
  const gap = lockup.gap * capPx;
  const dInkW = inkWidth(desc);
  let inkX: number;
  let baseline: number;
  if (lockup.position === "right") {
    inkX = nameInk.x + nameInk.w + gap;
    // Capitals line up on their tops; with lowercase the shared baseline is what the eye follows.
    baseline = ctx.caps ? firstBaseline - capPx + descCap : firstBaseline;
  } else {
    inkX = lockup.align === "left" ? nameInk.x : lockup.align === "center" ? nameInk.x + (nameInk.w - dInkW) / 2 : nameInk.x + nameInk.w - dInkW;
    // The gap runs from the name's baseline to the descriptor's cap top (below), or from the
    // descriptor's baseline to the name's cap line (above, a kicker).
    baseline = lockup.position === "below" ? lastBaseline + gap + descCap : firstBaseline - capPx - gap;
  }
  const placed = placeLine(ctx, desc, inkX - desc.metrics.inkLeft, baseline, "descriptor");
  const runs: Run[] = placed.runs.map((r) => (placeholder ? { ...r, placeholder: true } : r));
  if (lockup.position !== "right") {
    const nameGlyphs = nameRuns.flatMap((r) => r.glyphs);
    if (lockup.position === "below" ? collides(nameGlyphs, placed.glyphs) : collides(placed.glyphs, nameGlyphs)) warnings.push("collision");
  }

  // The drawing's box covers the name's box and the descriptor's cap band (descenders included),
  // then moves so its top-left corner is back at the origin, as every formation's is.
  const descTop = baseline - Math.max(descCap, desc.metrics.inkTop);
  const descBottom = baseline + Math.max(0, -desc.metrics.inkBottom);
  const left = Math.min(0, inkX);
  const top = Math.min(0, descTop);
  const right = Math.max(name.box.w, inkX + dInkW);
  const bottom = Math.max(name.box.h, descBottom);
  const formed: Formed = {
    runs: [...name.runs, ...runs],
    missing: [...name.missing, ...placed.missing],
    box: { w: right - left, h: bottom - top },
    fit,
    warnings: [...new Set(warnings)],
  };
  return moveFormed(formed, -left, -top);
}

const inkWidth = (l: SetLine) => l.metrics.inkRight - l.metrics.inkLeft;

/**
 * The line with the letter-spacing that makes its ink exactly `target` wide. Spacing goes between
 * glyphs only, so each step adds one gap per pair of letters; a secant step or two corrects for a
 * glyph whose ink reaches past its neighbours.
 */
function trackToInk(ctx: FormationContext, line: SetLine, target: number): SetLine {
  const gaps = line.metrics.glyphs.filter((g) => g.advance !== 0).length - 1;
  if (gaps < 1 || Math.abs(inkWidth(line) - target) < 0.01) return line;
  let prev = line;
  let next = setLine(ctx, line.text, line.size, line.tracking + (target - inkWidth(line)) / gaps / line.size);
  for (let i = 0; i < 5 && Math.abs(inkWidth(next) - target) > 0.05; i++) {
    const slope = (inkWidth(next) - inkWidth(prev)) / (next.tracking - prev.tracking);
    if (!(Math.abs(slope) > 1e-6)) break;
    prev = next;
    next = setLine(ctx, line.text, line.size, next.tracking + (target - inkWidth(next)) / slope);
  }
  return next;
}

function cased(text: string, textCase: TextCase): string {
  return textCase === "upper" ? text.toUpperCase() : textCase === "lower" ? text.toLowerCase() : text;
}
