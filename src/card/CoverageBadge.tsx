// The card's honesty badges: letters of the name the face cannot set (drawn as hatched boxes),
// caps-only faces, and installed fonts whose licence nobody knows.
import { useEffect, useRef, useState } from "react";
import { coverageOf, effectiveText, missingChars } from "../coverage";
import { onFaceChange, peekExt, peekFacts, withExt } from "../facts/index";
import type { FontFacts } from "../facts/types";
import type { BadgeProps } from "./Badges";
import "./coverage.css";

/** Missing letters named on the badge itself; the rest are counted, and all are in its tooltip. */
const SHOWN = 3;

export function CoverageBadge({ font, settings, weight }: BadgeProps) {
  const facts = useKnownFacts(font, weight);
  const { formation, lockup } = settings.layout;
  // The lockup's descriptor is set in the same face, so its letters count too.
  const descriptor = formation !== "lockup" ? "" : lockup.textCase === "upper" ? lockup.descriptor.toUpperCase() : lockup.textCase === "lower" ? lockup.descriptor.toLowerCase() : lockup.descriptor;
  let shown = facts ? judge(font, facts, settings, weight, descriptor) : null;
  // A card back on screen with nothing changed keeps its last layout without parsing its face again
  // (Wordmark.tsx), so the face may have left the cache: the badges it showed then still hold.
  const key = `${font.id}@${weight}@${settings.text}@${settings.textCase}@${descriptor}`;
  const kept = useRef<{ key: string; shown: Judged } | null>(null);
  if (shown) kept.current = { key, shown };
  else if (kept.current?.key === key) shown = kept.current.shown;
  const { missing, shownInCaps, capsOnly } = shown ?? judge(font, null, settings, weight, descriptor);
  const more = missing.length - SHOWN;

  return (
    <>
      {missing.length > 0 && (
        <span className="badge cov cov-missing" title={`Not in this font: ${missing.join(" ")}. They show as hatched boxes, never borrowed from another font.`}>
          missing <span className="cov-chars">{missing.slice(0, SHOWN).join(" ")}</span>
          {more > 0 && ` +${more}`}
        </span>
      )}
      {shownInCaps ? (
        <span className="badge cov" title="This face has no lowercase, so the name is set in its capitals">
          caps only · shown in caps
        </span>
      ) : (
        capsOnly && (
          <span className="badge cov" title="This face has no lowercase: its lowercase letters are capitals">
            caps only
          </span>
        )
      )}
      {font.license === "Local-unknown" && (
        <span className="badge cov cov-licence" title="Installed font of unknown origin: check its licence allows a logo before using it">
          check licence
        </span>
      )}
    </>
  );
}

interface Judged {
  missing: string[];
  shownInCaps: boolean;
  capsOnly: boolean;
}

function judge(font: BadgeProps["font"], facts: FontFacts | null, settings: BadgeProps["settings"], weight: number, descriptor: string): Judged {
  const name = effectiveText(font, facts, settings);
  const coverage = coverageOf(font, facts, weight);
  const missing = coverage ? missingChars(coverage, `${name.flat} ${descriptor}`) : [];
  return { missing, shownInCaps: name.shownInCaps, capsOnly: Boolean(coverage?.capsOnly) };
}

/**
 * The face's facts as the card's wordmark knows them (with the latin-ext file folded in), without
 * holding or parsing the face itself: the wordmark does that while the card is near the screen.
 * Re-renders when they arrive or widen. Null while unknown, and always for installed fonts.
 */
function useKnownFacts(font: BadgeProps["font"], weight: number): FontFacts | null {
  const [, rerender] = useState(0);
  const result = peekFacts(font, weight) ?? null;
  const ext = peekExt(font, weight);
  useEffect(() => {
    if (font.source === "local") return;
    const changed = () => (peekFacts(font, weight) ?? null) !== result || peekExt(font, weight) !== ext;
    // They may have arrived between this render and the effect.
    if (changed()) rerender((n) => n + 1);
    return onFaceChange(font, weight, "web", () => {
      if (changed()) rerender((n) => n + 1);
    });
  }, [font, weight, result, ext]);
  return result ? withExt(font, weight, "web", result).facts : null;
}
