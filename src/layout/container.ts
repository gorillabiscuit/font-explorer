// Containers: the name inside a square, rounded square, circle or pill, as a badge, app icon or
// avatar would hold it. Square, rounded and circle are fixed tiles (4×S, the grid's tile, never more
// than the room), the same for every face, and the name is scaled to sit inside with the padding: a
// wide face gets smaller letters, which is the test. A pill hugs the name. DOM-free.
import type { LayoutSettings } from "../recipe";
import { letterAt } from "./block";
import { inkBounds, moveFormed, scaleFormed } from "./engine";
import type { ContainerShape, FormationContext, Formed } from "./types";

/** A tile's side in Size units: the grid's Block and Mark columns are this wide (grid.ts). */
export const TILE = 4;
/** Corner radius of 'rounded', as a share of the side. */
const ROUNDED = 0.22;
/** A keyline's stroke in serif faces, in cap heights: their 'I' is serifed, so its width is no stem. */
const SERIF_STROKE = 0.08;

export interface ContainerChoice {
  shape: ContainerShape["shape"];
  style: ContainerShape["style"];
  /** Clear space between the ink and the shape, in cap heights. */
  padding: number;
}

/** The container a layout draws, or null. Auto gives Block and Mark a filled square and the rest none. */
export function resolveContainer(layout: LayoutSettings): ContainerChoice | null {
  const c = layout.container;
  if (c.auto) return layout.formation === "block" || layout.formation === "mark" ? { shape: "square", style: "fill", padding: c.padding } : null;
  return c.shape === "none" ? null : { shape: c.shape, style: c.style, padding: c.padding };
}

/**
 * Puts the drawing in its container. The padding is container.padding cap heights of the name at
 * its fitted size, so it scales with the letters and the fit is exact in one step: the drawing and
 * its padding are scaled together until the shape is the tile's size. The circle is sized by the
 * ink box's farthest corner, so every corner stays within R − p. The result's box is the shape.
 */
export function fitInContainer(formed: Formed, ctx: FormationContext): Formed {
  const choice = resolveContainer(ctx.layout);
  const ink = inkBounds(formed);
  if (!choice || !ink) return formed;
  const m = ctx.measurer;
  // The name's size as drawn now (Width matching may already have scaled it).
  const nameSize = formed.runs.find((r) => r.slot !== "descriptor")?.size ?? ctx.fontSize;
  const pad = Math.max(0, choice.padding) * m.capHeight * nameSize;

  // The smallest shape around the ink with that padding, at the current scale.
  let w: number;
  let h: number;
  if (choice.shape === "circle") w = h = 2 * (Math.hypot(ink.w / 2, ink.h / 2) + pad);
  else if (choice.shape === "pill") {
    // Half circles at both ends whose centres sit above the ink box's side edges: its corners are
    // then exactly the padding inside the curve.
    h = ink.h + 2 * pad;
    w = ink.w + h;
  } else w = h = Math.max(ink.w, ink.h) + 2 * pad;

  let k = 1;
  if (choice.shape !== "pill" && w > 0) {
    const roomW = ctx.opts.boxWidth === undefined ? Infinity : Math.max(1, ctx.opts.boxWidth - 2 * ctx.opts.pad);
    const roomH = ctx.opts.boxHeight === undefined ? Infinity : Math.max(1, ctx.opts.boxHeight - 2 * ctx.opts.pad);
    k = Math.min(TILE * ctx.opts.size, roomW, roomH) / w;
  }

  const scaled = scaleFormed(formed, k);
  const cx = (ink.x + ink.w / 2) * k;
  const cy = (ink.y + ink.h / 2) * k;
  const W = w * k;
  const H = h * k;
  const shape: ContainerShape = {
    shape: choice.shape,
    style: choice.style,
    x: cx - W / 2,
    y: cy - H / 2,
    w: W,
    h: H,
    rx: choice.shape === "rounded" ? ROUNDED * W : choice.shape === "square" ? 0 : Math.min(W, H) / 2,
    stroke: choice.style === "keyline" ? keylineStroke(ctx, nameSize * k) : 1,
  };
  // A mark is always scaled to fill its tile: that is how Mark works, not a correction worth a readout.
  const reported = Math.abs(k - 1) > 0.005 && ctx.layout.formation !== "mark";
  const fit = reported ? [...scaled.fit, `${choice.shape} ×${k.toFixed(2)}`] : scaled.fit;
  return moveFormed({ ...scaled, container: shape, box: { w: W, h: H }, fit }, -shape.x, -shape.y);
}

/**
 * A keyline as heavy as the letters' stems: the ink width of 'I' (a caps name) or 'l' at the size the
 * name is drawn. Serif faces use 8% of the cap height, as does a face with neither letter.
 */
function keylineStroke(ctx: FormationContext, size: number): number {
  const m = ctx.measurer;
  const fallback = SERIF_STROKE * m.capHeight * size;
  if (ctx.opts.serif) return fallback;
  for (const letter of ctx.caps ? ["I", "l"] : ["l", "I"]) {
    const r = letterAt(m, letter, size, ctx.opts.features);
    const g = r.glyphs[0];
    const width = r.inkRight - r.inkLeft;
    // A stem wider than a third of the cap height is no stem (a swash or a stand-in measure).
    if (g && !g.missing && width > 0 && width < m.capHeight * size / 3) return width;
  }
  return fallback;
}
