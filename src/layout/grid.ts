// Grid sizing from the settings alone, before any font has loaded: how wide a column should be so
// most faces fit without shrinking, and how tall a card will be, so cards drawn later (the grid
// renders lazily) do not make the page jump. DOM-free.
import type { LayoutSettings } from "../recipe";
import { parseName, type Settings } from "../settings";
import { stackLines } from "./breaks";
import { resolveContainer, TILE } from "./container";
import { DEFAULT_PAD, layoutFormation } from "./engine";
import { nominalMeasurer } from "./nominal";
import type { LayoutInput } from "./types";

const MIN_COLUMN = 240;
/**
 * A stack's lines are short, and Block and Mark sit in a tile of about 4·S, so their columns would
 * often sit at the minimum, where the meta row's badges leave the family name one or two letters.
 * This keeps about a dozen letters of it readable.
 */
const MIN_STACK_COLUMN = 320;
const MAX_COLUMN = 1400;
/**
 * Headroom over a typical face's width, so most faces fit their column without shrinking. Wide and
 * extended faces still shrink, and say so on the card.
 */
const ROOMY = 1.12;
/** The card's meta row (family, badges, actions) under the wordmark, in px. */
const META_HEIGHT = 36;

type Sizing = Pick<Settings, "text" | "textCase" | "size" | "tracking">;

/**
 * The narrowest column the grid should use. Matching makes a typical face's em about the Size slider
 * (cap height 0.7·S, x-height 0.5·S), so the name's longest line is measured in a typical face at S:
 * about 0.56 em per lowercase letter and 0.68 per capital (an all-caps name needs the wider column),
 * never less than four letters' worth.
 */
export function columnWidth(layout: LayoutSettings, settings: Sizing, flat = parseName(settings).flat): number {
  const S = settings.size;
  // Block and Mark sit in a tile of TILE·S (container.ts), as does any name put in a square, rounded
  // square or circle: the name is scaled into the tile, so the tile is all the column needs.
  const container = resolveContainer(layout);
  const tiled = layout.formation === "block" || layout.formation === "mark" || (container !== null && container.shape !== "pill");
  const min = layout.formation === "stack" || tiled ? MIN_STACK_COLUMN : MIN_COLUMN;
  const clamp = (w: number) => Math.round(Math.min(MAX_COLUMN, Math.max(min, w)));
  if (tiled) return clamp(TILE * S + 2 * DEFAULT_PAD);
  const lines = layout.formation === "stack" ? stackLines({ ...parseName(settings), flat }, layout) : [flat];
  let widest = Math.max(4 * 0.6 * S, ...lines.map((l) => nominalMeasurer.run(l, { size: S, tracking: settings.tracking }).advance));
  // A descriptor beside the name, or a pill around it, adds width a line estimate does not see.
  if (layout.formation === "lockup" || container?.shape === "pill") {
    const drawn = layoutFormation(layoutInput(settings, layout), layout, nominalMeasurer, { size: S, weight: 400, tracking: settings.tracking });
    widest = Math.max(widest, drawn.box.w - 2 * DEFAULT_PAD);
  }
  return clamp(widest * ROOMY + 2 * DEFAULT_PAD);
}

/** A card's expected height in px: the name laid out in a typical face, plus the meta row. */
export function intrinsicHeight(layout: LayoutSettings, settings: Sizing): number {
  const result = layoutFormation(layoutInput(settings, layout), layout, nominalMeasurer, { size: settings.size, weight: 400, tracking: settings.tracking });
  return Math.round(result.box.h + META_HEIGHT);
}

/** What Wordmark hands the engine: the name, plus Lockup's descriptor and Mark's initials. */
function layoutInput(settings: Sizing, layout: LayoutSettings): LayoutInput {
  return { ...parseName(settings), descriptor: layout.lockup.descriptor, initials: parseName({ text: layout.mark.initials, textCase: settings.textCase }).flat };
}
