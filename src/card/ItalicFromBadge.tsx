// 'italic from Fontshare' on a card that draws a borrowed italic: the family's own source has none, so
// the card's source badge alone would credit it for a file it did not give. Same words as the lightbox.
// 'cov' lets the meta line wrap (card/coverage.css), so the long label never squeezes the family name away.
import { borrowedFrom } from "../fonts";
import { SOURCE_LABELS } from "../types";
import type { BadgeProps } from "./Badges";

export function ItalicFromBadge({ font }: BadgeProps) {
  const from = borrowedFrom(font);
  if (!from) return null;
  return (
    <span className={`badge cov src-${from}`} title={`This family's own source has no italic; this one is from ${SOURCE_LABELS[from]}'s release of the family.`}>
      italic from {SOURCE_LABELS[from]}
    </span>
  );
}
