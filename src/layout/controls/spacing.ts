// The line-spacing sliders' ranges, defaults and units, shared by the ⚙ popover (Stack, Block) and
// the top bar (LineSpacing.tsx), so both allow and show the same values.
import { DEFAULT_LAYOUT } from "../../recipe";
import { parseName, type Settings } from "../../settings";
import { isCapsName } from "../engine";

/**
 * Stack's leading: from lines overlapping by half a cap or x-height to a line and a half apart.
 * Tight settings are allowed on purpose; letters that touch are flagged on the card, never prevented.
 */
export const LEADING = { min: -0.5, max: 1.5, step: 0.05, reset: DEFAULT_LAYOUT.stack.leading };

/** Block's gap between rows, in cap heights. Its default is the one gap's (rowGap starts as null and follows it). */
export const ROW_GAP = { min: -0.3, max: 1, step: 0.02, reset: DEFAULT_LAYOUT.block.gap };

/**
 * What Stack's leading is measured in for this name, as the engine measures it. One label for the
 * whole grid, so it follows the typed name: a caps-only face draws a lowercase name in capitals and
 * leads it in cap heights, which LEADING_HINT says.
 */
export function leadingUnit(s: Pick<Settings, "text" | "textCase">): "cap" | "x-height" {
  return isCapsName(parseName(s)) ? "cap" : "x-height";
}

export const LEADING_HINT =
  "The gap between lines: in cap heights for an all-caps name, in x-heights otherwise. A face with only capitals sets every name in capitals, so it counts in cap heights.";

/**
 * '+0.25 x-height', '−0.50 cap'. Always signed, since these gaps can close up below 0, and so the
 * readout keeps one width while the slider is dragged across 0 (the slider beside it stays put).
 */
export const formatGap = (v: number, unit: string) => `${v < -0.0005 ? "−" : "+"}${Math.abs(v).toFixed(2)} ${unit}`;
