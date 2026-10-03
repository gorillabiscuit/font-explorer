// React access to font facts. These hooks never start a font download: they wait for whoever
// shows the font (a card, the lightbox) to load it with ensureFont, then read the same bytes.
// Pass the weight that was actually loaded, so a card that fell back to the next weight still matches.
import { useEffect, useMemo, useState } from "react";
import { isFontLoaded, nearestWeight, onFontLoaded, type FontVariant } from "../fonts";
import type { FontEntry } from "../types";
import { canvasMeasurer } from "./canvas";
import { getFacts, holdFacts, onFaceChange, peekExt, peekFacts, withExt, type FactsResult } from "./index";
import type { FontFacts, Measurer } from "./types";

/** fontkit facts, a measurer and the parsed font, once the face has loaded and been parsed. */
export function useFactsResult(font: FontEntry, weight: number, variant: FontVariant = "web"): FactsResult | null {
  return useFaceState(font, weight, variant).result;
}

export function useFacts(font: FontEntry, weight: number, variant: FontVariant = "web"): FontFacts | null {
  return useFaceState(font, weight, variant).result?.facts ?? null;
}

/**
 * The exact fontkit measurer when it is ready; until then (and always for installed fonts) a canvas
 * measurer once the face has loaded; null before that. The same object comes back on every render
 * until it changes, so it is safe as a memo key.
 */
export function useMeasurer(font: FontEntry, weight: number, variant: FontVariant = "web"): Measurer | null {
  return useFaceMeasure(font, weight, variant).measurer;
}

/**
 * Facts and the measurer together, from one hold on the face. While `active` is false the hook lets
 * go of the face entirely and returns nulls, so a view far off screen keeps no parsed font alive
 * (the wordmark keeps showing what it last laid out). Turning it back on picks the face up again.
 * `adopt` (only while inactive): no hold and no request, but facts that land anyway (a parse that
 * was already queued) are handed over once, with no canvas stand-in.
 */
export function useFaceMeasure(
  font: FontEntry,
  weight: number,
  variant: FontVariant = "web",
  active = true,
  adopt = false,
): { facts: FontFacts | null; measurer: Measurer | null } {
  const { ready, result } = useFaceState(font, weight, variant, active, adopt);
  // Kept per component as well: the shared canvas cache has a limit, and a grid of installed fonts
  // can outgrow it, which would hand every card a new measurer object on each render.
  const canvas = useMemo(
    () => (active && ready && !result ? canvasMeasurer(font, weight, variant) : null),
    [font, weight, variant, active, ready, result],
  );
  // A Fontsource face gains its latin-ext file later, when a name first needs it (see withExt).
  useExtArrival(font, weight, variant, active && result !== null);
  const faced = result ? withExt(font, weight, variant, result) : null;
  return { facts: faced?.facts ?? null, measurer: faced?.measurer ?? canvas };
}

/** Re-renders when the face's latin-ext file has been read, so withExt hands out the wider facts. */
function useExtArrival(font: FontEntry, weight: number, variant: FontVariant, on: boolean) {
  const [, rerender] = useState(0);
  const seen = on ? peekExt(font, weight, variant) : null;
  useEffect(() => {
    // Null is final: not a Fontsource face, or Fontsource has no latin-ext file for it.
    if (!on || seen === null) return;
    // It may have arrived between this render and the effect.
    if (peekExt(font, weight, variant) !== seen) rerender((n) => n + 1);
    return onFaceChange(font, weight, variant, () => {
      if (peekExt(font, weight, variant) !== seen) rerender((n) => n + 1);
    });
  }, [font, weight, variant, on, seen]);
}

interface Got {
  key: string;
  result: FactsResult | null;
}

function useFaceState(font: FontEntry, weight: number, variant: FontVariant, active = true, adopt = false): { ready: boolean; result: FactsResult | null } {
  const key = `${font.id}@${nearestWeight(font, weight)}@${variant}`;
  const ready = isFontLoaded(font, weight, variant);
  const [, rerender] = useState(0);
  // The result this component was handed, kept in its own state rather than re-read from the shared
  // cache on every render, so a mounted card never drops back to the canvas measurer or parses again
  // when the cache makes room for other faces. Seeded from the cache, so a face parsed earlier shows
  // its exact facts on the first render.
  const [got, setGot] = useState<Got | null>(() => {
    const known = peekFacts(font, weight, variant);
    return known === undefined ? null : { key, result: known };
  });
  const adopting = !active && adopt;
  const result = adopting ? (peekFacts(font, weight, variant) ?? null) : !active ? null : got?.key === key ? got.result : (peekFacts(font, weight, variant) ?? null);

  // Adopting: re-render when the face's facts land, without holding or asking for them.
  const sawKnown = adopting && peekFacts(font, weight, variant) !== undefined;
  useEffect(() => {
    if (!adopting || sawKnown) return;
    if (peekFacts(font, weight, variant) !== undefined) return void rerender((n) => n + 1);
    return onFaceChange(font, weight, variant, () => rerender((n) => n + 1));
  }, [font, weight, variant, adopting, sawKnown]);

  // Re-render when the face finishes loading. If it loaded between render and this effect, the
  // render saw it unloaded, so catch up now.
  useEffect(() => {
    if (!active) return;
    if (isFontLoaded(font, weight, variant)) {
      if (!ready) rerender((n) => n + 1);
      return;
    }
    return onFontLoaded(font, weight, variant, () => rerender((n) => n + 1));
  }, [font, weight, variant, ready, active]);

  // Parse once loaded, and hold the face in the shared cache while mounted and active (see holdFacts).
  // The hold comes first, so the entry cannot be evicted while its parse is still waiting its turn.
  useEffect(() => {
    if (!active) {
      // Drop this component's reference too, or the parsed font would outlive the hold.
      setGot((prev) => (prev === null ? prev : null));
      return;
    }
    if (!ready || font.source === "local") return;
    const release = holdFacts(font, weight, variant);
    let live = true;
    getFacts(font, weight, variant).then((next) => {
      // Returning the same state object skips the re-render when this render already had it.
      if (live) setGot((prev) => (prev?.key === key && prev.result === next ? prev : { key, result: next }));
    });
    return () => {
      live = false;
      release();
    };
  }, [font, weight, variant, ready, key, active]);

  return { ready, result };
}
