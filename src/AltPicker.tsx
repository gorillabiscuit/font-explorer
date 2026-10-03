// Choosing alternates: one small wordmark per stylistic set that changes the name, with the letters
// it changes tinted, plus Default and All. Mounted under the lightbox stage (where A cycles the same
// options) and in each Compare row's tuner. Also the hooks that load Google's full file, which is
// where a Google family's sets live, and work out which sets touch the name.
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { alternatesSoon, altChoices, choiceToast, currentChoice, defaultNote, peekAlternates, variantFor, withChoice, type AltChoice, type Alternates } from "./alternates";
import "./alternates.css";
import type { AlternatesSlotProps } from "./CandidateTuner";
import { effectiveText } from "./coverage";
import type { FactsResult } from "./facts/index";
import { useFactsResult } from "./facts/useFacts";
import { ensureFont, fullAbsent, fullStyleAbsent, isFontLoaded, type FontVariant } from "./fonts";
import type { LayoutResult } from "./layout/types";
import type { Recipe } from "./recipe";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import type { FontEntry } from "./types";
import { Wordmark } from "./Wordmark";

/** Where loading a Google family's full file stands. 'off': not asked for (or not a Google family). */
export type FullStatus = "off" | "loading" | "ready" | "unavailable";

/**
 * Loads Google's full file of `font` at `weight` while `wanted`, after `delay` ms (the lightbox waits
 * a moment, so flipping past a font downloads nothing). Only Google families have a separate full
 * file; for every other source this stays 'off', because their own file already has every set.
 */
export function useFullFace(font: FontEntry | null, weight: number, wanted: boolean, delay = 0): FullStatus {
  const google = font?.source === "fontsource";
  const ready = !!font && google && wanted && isFontLoaded(font, weight, "full");
  const key = font && google && wanted ? `${font.id}@${weight}` : "";
  const [settled, setSettled] = useState<{ key: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!font || !key || isFontLoaded(font, weight, "full")) return;
    let live = true;
    const start = () =>
      ensureFont(font, weight, "full").then((ok) => {
        if (live) setSettled({ key, ok });
      });
    if (!delay) {
      void start();
    } else {
      const t = window.setTimeout(start, delay);
      return () => {
        live = false;
        clearTimeout(t);
      };
    }
    return () => {
      live = false;
    };
  }, [font, weight, key, delay]);
  if (!key) return "off";
  if (ready) return "ready";
  if (settled?.key === key && !settled.ok) return "unavailable";
  return font && fullAbsent(font) ? "unavailable" : "loading";
}

/**
 * The file a recipe is drawn from right now: Google's full file once it has loaded, when the recipe
 * switches an alternate on (see variantFor); the web file otherwise, including while the full file
 * loads or when it cannot be found, so the wordmark never waits on it.
 */
export function useRecipeVariant(font: FontEntry | null, weight: number, features: Record<string, 0 | 1> | undefined): FontVariant {
  const wanted = !!font && variantFor(font, features) === "full";
  return useFullFace(font, weight, wanted) === "ready" ? "full" : "web";
}

/**
 * The alternates of a parsed face that change `text`, worked out in the background (alternatesSoon).
 * Undefined while that runs, null when there is no parsed face (an installed font, an unreadable file).
 */
export function useAlternatesOf(result: Pick<FactsResult, "parsed" | "facts"> | null, text: string): Alternates | null | undefined {
  const known = result ? peekAlternates(result.parsed, result.facts, text) : null;
  const [got, setGot] = useState<{ result: unknown; text: string; alts: Alternates } | null>(null);
  useEffect(() => {
    if (!result || known) return;
    let live = true;
    alternatesSoon(result.parsed, result.facts, text, () => live).then((alts) => {
      if (live && alts) setGot({ result, text, alts });
    });
    return () => {
      live = false;
    };
  }, [result, text, known]);
  if (!result) return null;
  return known ?? (got?.result === result && got.text === text ? got.alts : undefined);
}

/** Every preview: the name on one line, small, in a fixed width (a long name is scaled down to fit). */
const PREVIEW_SIZE = 22;
const PREVIEW_BOX = { width: 230 };
const DEFAULT_ONLY: AltChoice[] = [{ key: "default", label: "Default", features: {}, letters: "" }];

interface AltPickerProps {
  font: FontEntry;
  /** The weight drawn. */
  weight: number;
  /** The settings the previews start from; `recipe` overrides them field by field (a candidate's own). */
  settings: Settings;
  recipe?: Partial<Recipe>;
  /** The features in use. Their alternates decide which option is lit; anything else (kern: 0) is kept on a pick. */
  features: Record<string, 0 | 1> | undefined;
  onPick: (features: Record<string, 0 | 1>, choice: AltChoice) => void;
  /** Wait this long before loading Google's full file (the lightbox, while flipping). */
  delay?: number;
  /**
   * Told the options whenever they change, for the lightbox's A key: null while they are not known,
   * with the line the picker shows instead ('Loading full font…', 'Alternates unavailable: …').
   */
  onChoices?: (choices: AltChoice[] | null, status: string | null) => void;
}

export const AltPicker = memo(function AltPicker({ font, weight, settings, recipe, features, onPick, delay = 0, onChoices }: AltPickerProps) {
  const google = font.source === "fontsource";
  const full = useFullFace(font, weight, google, delay);
  // Google's sets are read from the full file; every other source's own file has them.
  const variant: FontVariant = google ? "full" : "web";
  const result = useFactsResult(font, weight, variant);
  const textCase = recipe?.textCase ?? settings.textCase;
  const name = effectiveText(font, result?.facts ?? null, { text: recipe?.text ?? settings.text, textCase }).flat;
  const alts = useAlternatesOf(result, name);
  const choices = useMemo(() => (alts ? altChoices(alts) : DEFAULT_ONLY), [alts]);
  const current = currentChoice(features, choices);
  // Each option's features, kept while nothing changes, so the previews are not laid out again on every render.
  const picks = useMemo(() => choices.map((choice) => withChoice(features, choice)), [choices, features]);

  // The previews: the name on one line, bare, in the face and weight shown, each with one choice on.
  const layout = recipe?.layout ?? settings.layout;
  const base = useMemo<Partial<Recipe>>(
    () => ({
      ...recipe,
      weight,
      layout: { ...layout, formation: "line", breaks: null, match: layout.match === "width" ? "auto" : layout.match, container: { ...layout.container, auto: false, shape: "none" } },
    }),
    [recipe, weight, layout],
  );

  let status: string | null = null;
  if (font.source === "local") status = "Installed fonts can't be read yet, so their alternates are unknown.";
  else if (google && full === "unavailable")
    // An italic whose family is in Google's repository with no italic file: the upright's full file exists.
    status = fullStyleAbsent(font, weight)
      ? "Alternates unavailable: Google's repository lists no italic full file for this family."
      : "Alternates unavailable: Google's full file for this family could not be found or loaded.";
  else if (google && full !== "ready") status = "Loading full font…";
  else if (result === null) status = "Reading the font…";
  else if (alts === undefined) status = "Looking for alternates…";
  else if (alts && !alts.sets.length) status = `No stylistic set changes “${name.trim()}”.`;
  const known = alts ? choices : null;
  useEffect(() => onChoices?.(known, status), [known, status, onChoices]);

  return (
    <div className="alt-picker">
      {status ? (
        <p className="alt-status faint">{status}</p>
      ) : (
        <div className="alt-options">
          {choices.map((choice, i) => (
            <AltOption
              key={choice.key}
              font={font}
              settings={settings}
              recipe={base}
              features={picks[i]}
              variant={variant}
              choice={choice}
              on={current?.key === choice.key}
              onPick={() => onPick(picks[i], choice)}
            />
          ))}
        </div>
      )}
      {alts && alts.defaults.length > 0 && <p className="alt-defaults faint">{alts.defaults.map(defaultNote).join(" · ")}</p>}
    </div>
  );
});

interface OptionProps {
  font: FontEntry;
  settings: Settings;
  recipe: Partial<Recipe>;
  features: Record<string, 0 | 1>;
  variant: FontVariant;
  choice: AltChoice;
  on: boolean;
  onPick: () => void;
}

/**
 * One option: its label and the name set with it. The letters it changes are tinted by laying an
 * accent-coloured copy of the same wordmark over it, masked to those letters' glyph boxes.
 */
const AltOption = memo(function AltOption({ font, settings, recipe, features, variant, choice, on, onPick }: OptionProps) {
  const withFeatures = useMemo(() => ({ ...recipe, features }), [recipe, features]);
  const [laid, setLaid] = useState<LayoutResult | null>(null);
  const onLayout = useCallback((r: LayoutResult) => setLaid(r), []);
  const mask = useMemo(() => (laid && choice.letters ? tintMask(laid, choice.letters) : null), [laid, choice.letters]);
  const title = choice.key === "default" ? "The face's default letters" : choice.key === "all" ? "Every set on at once" : `${choice.label}: changes ${[...choice.letters].join(" ")}`;
  return (
    <button type="button" className={`alt-option ${on ? "on" : ""}`} aria-pressed={on} title={title} onClick={onPick}>
      <span className="alt-label">
        {choice.label}
        {choice.letters && <span className="alt-letters"> · {[...choice.letters].join(" ")}</span>}
      </span>
      <span className="alt-art">
        <Wordmark font={font} settings={settings} recipe={withFeatures} size={PREVIEW_SIZE} box={PREVIEW_BOX} variant={variant} onLayout={onLayout} />
        {mask && (
          <span className="alt-tint" style={mask} aria-hidden="true">
            <Wordmark font={font} settings={settings} recipe={withFeatures} size={PREVIEW_SIZE} box={PREVIEW_BOX} variant={variant} />
          </span>
        )}
      </span>
    </button>
  );
});

/** A CSS mask showing only the glyph boxes of `letters` in the drawn layout, or null when none are drawn. */
function tintMask(r: LayoutResult, letters: string): CSSProperties | null {
  const wanted = new Set(letters);
  const rects: string[] = [];
  for (const run of r.runs) {
    for (const g of run.glyphs) {
      if (g.missing || g.inkR <= g.inkL || ![...g.char].some((ch) => wanted.has(ch))) continue;
      // A pixel of slack, so antialiased edges are tinted too.
      rects.push(`<rect x='${(g.inkL - 1).toFixed(1)}' y='${(g.inkT - 1).toFixed(1)}' width='${(g.inkR - g.inkL + 2).toFixed(1)}' height='${(g.inkB - g.inkT + 2).toFixed(1)}'/>`);
    }
  }
  if (!rects.length) return null;
  const w = r.box.w.toFixed(1);
  const h = r.box.h.toFixed(1);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${rects.join("")}</svg>`;
  const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const size = `${w}px ${h}px`;
  return { WebkitMaskImage: image, maskImage: image, WebkitMaskSize: size, maskSize: size, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat" };
}

/**
 * The picker in a Compare row's tuner (CandidateTuner's Alternates slot): the candidate's own name,
 * case, spacing and weight, and each pick one undoable change to its recipe's features.
 */
export function TunerAlternates({ font, recipe, weight, setFeatures }: AlternatesSlotProps) {
  const onPick = useCallback((features: Record<string, 0 | 1>, choice: AltChoice) => setFeatures(features, choiceToast(choice)), [setFeatures]);
  return <AltPicker font={font} weight={weight} settings={DEFAULT_SETTINGS} recipe={recipe} features={recipe.features} onPick={onPick} />;
}
