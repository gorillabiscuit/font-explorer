import { memo, useMemo } from "react";
import type { FontVariant } from "./fonts";
import type { Recipe } from "./recipe";
import { parseName, type Settings } from "./settings";
import type { FontEntry } from "./types";
import { Wordmark } from "./Wordmark";

/**
 * Letters whose construction differs most between faces, most telling first: the storeys of a and
 * g, the leg of R, the spur of G, the tail of Q, y and J, the joins of k, M and W.
 */
const PRIORITY = ["a", "g", "R", "G", "Q", "y", "J", "k", "M", "W", "e", "t", "&", "s"];
const COUNT = 9;

/** The name's own telling letters first (in priority order), then the rest of the list, up to 9. */
export function tellingLetters(name: string): string[] {
  const own = PRIORITY.filter((ch) => name.includes(ch));
  return [...own, ...PRIORITY.filter((ch) => !own.includes(ch))].slice(0, COUNT);
}

interface Props {
  font: FontEntry;
  settings: Settings;
  /** The weight on stage (the one that loaded). */
  weight: number;
  /** The alternates on stage (A, or the picker): the strip leads with a and g, so it must show them too. */
  features?: Record<string, 0 | 1>;
  /** The file the stage draws from ('full' for a Google family with an alternate on). */
  variant?: FontVariant;
  /** The Size the strip is matched at, about 40% of the stage's. */
  size: number;
  /** Room for the strip; it is scaled down rather than cut off. */
  width?: number;
}

/**
 * The strip under the lightbox stage. Set through Wordmark like everything else, so a letter the
 * font lacks shows as a hatched gap, never as a borrowed fallback glyph.
 */
export const TellingLetters = memo(function TellingLetters({ font, settings, weight, features, variant, size, width }: Props) {
  const { text, textCase, layout } = settings;
  const recipe = useMemo<Partial<Recipe>>(
    () => ({
      // Spaced so each letter reads on its own. Always on one line and never in a container,
      // whatever layout the name is in.
      text: tellingLetters(parseName({ text, textCase }).flat).join(" "),
      textCase: "as",
      tracking: 0,
      weight,
      ...(features ? { features } : {}),
      // Matching by width would stretch the strip across the whole box, larger than the name on
      // stage; it is matched like Auto instead, as the other small tests are.
      layout: {
        ...layout,
        formation: "line",
        breaks: null,
        match: layout.match === "width" ? "auto" : layout.match,
        container: { ...layout.container, auto: false, shape: "none" },
      },
    }),
    [text, textCase, layout, weight, features],
  );
  const box = useMemo(() => (width ? { width } : undefined), [width]);
  return <Wordmark font={font} settings={settings} recipe={recipe} size={size} box={box} variant={variant} />;
});
