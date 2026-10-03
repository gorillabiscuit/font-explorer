import type { ReactNode } from "react";
import type { Settings } from "../settings";
import type { FontEntry } from "../types";
import { AltChip } from "./AltChip";
import { CoverageBadge } from "./CoverageBadge";
import { ItalicFromBadge } from "./ItalicFromBadge";
import { NoItalicBadge } from "./NoItalicBadge";

export interface BadgeProps {
  /**
   * The face the card draws: the family's italic (fonts.ts italicFace, its id ending '#italic') when
   * it draws one, else the font itself. Its facts and coverage are the ones that count on the card.
   */
  font: FontEntry;
  settings: Settings;
  /** The weight the card actually shows (the nearest one that loaded). */
  weight: number;
}

/**
 * Extra badges in every card's meta row, after the built-in source, licence and weight badges.
 * A feature adds its badge by importing its component here and appending one entry. Entries are
 * rendered as components, so they may use hooks; return null to show nothing on a card.
 * Card stays free of the store context, so badges get only these props.
 */
export const CARD_BADGES: Array<(p: BadgeProps) => ReactNode> = [CoverageBadge, AltChip, NoItalicBadge, ItalicFromBadge];
