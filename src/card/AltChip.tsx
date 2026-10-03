// The grid's one quiet hint about alternates: 'Alt a g t' when the face has stylistic sets that change
// those letters of this name. Choosing between them happens in the lightbox and Compare. A Google
// card shows no chip until its full file has been loaded (by the lightbox or Compare, one font at a
// time): Google's web files lose the sets, so judging by them would say there are none.
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useAlternatesOf } from "../AltPicker";
import { defaultNote } from "../alternates";
import { effectiveText } from "../coverage";
import { onFaceChange, peekFacts, type FactsResult } from "../facts/index";
import type { BadgeProps } from "./Badges";

export function AltChip({ font, settings, weight }: BadgeProps) {
  const result = useKnownResult(font, weight);
  // While the name is typed, the chips follow a moment behind, so typing never waits on them.
  const text = useDeferredValue(effectiveText(font, result?.facts ?? null, settings).flat);
  let alts = useAlternatesOf(result, text);
  // A card back on screen with nothing changed keeps its last layout without parsing its face again
  // (Wordmark.tsx), so the face may have left the cache: the chip it showed then still holds.
  const key = `${font.id}@${weight}@${text}`;
  const kept = useRef<{ key: string; alts: NonNullable<typeof alts> } | null>(null);
  if (alts) kept.current = { key, alts };
  else if (!result && kept.current?.key === key) alts = kept.current.alts;
  if (!alts?.sets.length) return null;

  const lines = alts.sets.map((s) => `${s.tag}${s.uiName ? ` ${s.uiName}` : ""}: ${[...s.letters].join(" ")}`);
  const notes = alts.defaults.map(defaultNote);
  return (
    <span className="badge alt-chip" title={[...lines, ...notes, "Choose them in the lightbox (A) or in Compare."].join("\n")}>
      Alt <span className="alt-chip-letters">{[...alts.letters].join(" ")}</span>
    </span>
  );
}

/**
 * The card's parsed face as the card's wordmark parsed it, without holding or parsing it here: the
 * wordmark does that while the card is near the screen. For a Google family, its full file instead
 * once something else has parsed that. Null while unknown, and always for installed fonts.
 * Re-renders when either arrives.
 */
function useKnownResult(font: BadgeProps["font"], weight: number): FactsResult | null {
  const [, rerender] = useState(0);
  // Reads only font and weight, so the effect below needs no other dependency.
  const peek = () => (font.source === "fontsource" ? peekFacts(font, weight, "full") : null) || (peekFacts(font, weight) ?? null);
  const result = peek();
  useEffect(() => {
    if (font.source === "local") return;
    const check = () => {
      if (peek() !== result) rerender((n) => n + 1);
    };
    // It may have arrived between this render and the effect.
    check();
    const offWeb = onFaceChange(font, weight, "web", check);
    const offFull = font.source === "fontsource" ? onFaceChange(font, weight, "full", check) : undefined;
    return () => {
      offWeb();
      offFull?.();
    };
  }, [font, weight, result]);
  return result;
}
