// 'no italic' on a card while Italic is on and the card draws its upright: the family has no italic
// (or its italic file would not load). The card never slants the upright to stand in for one.
// Installed fonts get no badge: whether one is installed in italic nobody can tell.
import { lacksItalic } from "../fonts";
import type { BadgeProps } from "./Badges";

export function NoItalicBadge({ font, settings }: BadgeProps) {
  if (!lacksItalic(font, settings.italic)) return null;
  return (
    <span className="badge cov" title="No italic to draw: the family has none, or its italic file would not load. Shown upright, never slanted to fake one.">
      no italic
    </span>
  );
}
