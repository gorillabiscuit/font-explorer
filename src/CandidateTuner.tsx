// Tuning one candidate to its best without touching the fair grid: a strip of its weights, a
// tracking ladder around its current spacing, italic, case, layout and kerning. Every click is one
// undoable change to that candidate's recipe (⌘Z); the grid's settings never change.
import { memo, useMemo, type ComponentType } from "react";
import { TunerAlternates, useRecipeVariant } from "./AltPicker";
import type { FontVariant } from "./fonts";
import { hasItalic, italicWeightsOf } from "./italic";
import { Seg } from "./layout/controls/fields";
import { FORMATIONS } from "./layout/engine";
import { useLoadedFace } from "./Lightbox";
import { FORMATION_LABELS, FORMATION_ORDER, type Formation, type Recipe } from "./recipe";
import { DEFAULT_SETTINGS, type TextCase } from "./settings";
import type { FontEntry } from "./types";
import { Wordmark } from "./Wordmark";

/** The ladder's rungs, in em, around the current tracking. */
const LADDER = [-0.04, -0.02, 0, 0.02, 0.06];
/** Every preview here: the candidate's own layout, small, in a fixed box. */
const PREVIEW_SIZE = 28;
const PREVIEW_BOX = { width: 300, height: 84 };

/** What an entry in the Alternates slot gets. */
export interface AlternatesSlotProps {
  /** The face drawn: the family's italic for an italic recipe that has one, whose alternates are its own. */
  font: FontEntry;
  /** The candidate's recipe, every layout field filled in. */
  recipe: Recipe;
  /** The weight drawn (the nearest one that loaded). */
  weight: number;
  variant: FontVariant;
  /** Sets recipe.features as one undoable change; `label` names it in the toast ('ss01 on'). */
  setFeatures: (features: Record<string, 0 | 1>, label: string) => void;
}

/**
 * The Alternates slot. F7 mounts its alternates picker here with one import and one entry; while
 * this list is empty the section says alternates are not available yet.
 */
export const TUNER_ALTERNATES: ComponentType<AlternatesSlotProps>[] = [TunerAlternates];

interface Props {
  font: FontEntry;
  /** The face drawn: the family's italic when the recipe asks for one and it loaded, else `font`. */
  face: FontEntry;
  /** The candidate's recipe, every layout field filled in. */
  recipe: Recipe;
  /** The weight drawn (the nearest one that loaded). */
  weight: number;
  variant: FontVariant;
  /** One undoable change to this candidate's recipe; `label` names it in the toast. */
  change: (patch: Partial<Recipe>, label: string) => void;
}

export const CandidateTuner = memo(function CandidateTuner({ font, face, recipe, weight, variant, change }: Props) {
  // An italic recipe offers the weights the italic comes in.
  const italicWeights = recipe.italic ? italicWeightsOf(font) : [];
  const offered = italicWeights.length ? italicWeights : font.weights;
  const weights = offered.length ? [...offered].sort((a, b) => a - b) : [];
  // An installed font may have an italic installed; a listed family has one only if the catalogue says so.
  const italicKnown = font.source === "local" || hasItalic(font);
  const kerning = recipe.features?.kern !== 0;
  const setKerning = (on: boolean) => {
    const { kern: _kern, ...rest } = recipe.features ?? {};
    change({ features: on ? rest : { ...rest, kern: 0 } }, on ? "kerning on" : "kerning off");
  };
  const setFeatures = (features: Record<string, 0 | 1>, label: string) => change({ features }, label);
  return (
    <div className="tuner">
      <section className="tuner-col">
        <h4 className="tuner-title">Weight</h4>
        {weights.length ? (
          <div className="tuner-list">
            {weights.map((w) => (
              <WeightOption key={w} font={font} recipe={recipe} weight={w} on={w === recipe.weight} variant={variant} onPick={() => change({ weight: w }, `weight ${w}`)} />
            ))}
          </div>
        ) : (
          <p className="faint">An installed font: its weights are not listed, so only the one shown can be used.</p>
        )}
      </section>

      <section className="tuner-col">
        <h4 className="tuner-title">Letter spacing</h4>
        <div className="tuner-list">
          {LADDER.map((step) => {
            const tracking = Math.round((recipe.tracking + step) * 1000) / 1000;
            return (
              <TrackingRung
                key={step}
                font={face}
                recipe={recipe}
                weight={weight}
                variant={variant}
                step={step}
                tracking={tracking}
                onPick={() => (step ? change({ tracking }, `letter spacing ${formatEm(tracking)}`) : undefined)}
              />
            );
          })}
        </div>
      </section>

      <section className="tuner-col tuner-settings">
        <h4 className="tuner-title">Case</h4>
        <Seg<TextCase>
          options={[
            ["as", "Aa"],
            ["upper", "AA"],
            ["lower", "aa"],
          ]}
          value={recipe.textCase}
          onChange={(textCase) => change({ textCase }, textCase === "upper" ? "UPPER" : textCase === "lower" ? "lower case" : "case as typed")}
        />
        <h4 className="tuner-title">Italic</h4>
        <label
          className="tuner-check"
          title={italicKnown ? "The family's own italic, never a slanted upright" : "This family has no italic, so it can only be set upright"}
        >
          <input type="checkbox" checked={!!recipe.italic} disabled={!italicKnown && !recipe.italic} onChange={(e) => change({ italic: e.target.checked }, e.target.checked ? "italic" : "upright")} />
          {recipe.italic ? "On" : "Off"}
        </label>
        <h4 className="tuner-title">Layout</h4>
        <select
          value={recipe.layout.formation}
          onChange={(e) => {
            const formation = e.target.value as Formation;
            change({ layout: { ...recipe.layout, formation } }, FORMATION_LABELS[formation]);
          }}
        >
          {FORMATION_ORDER.map((f) => (
            <option key={f} value={f}>
              {FORMATION_LABELS[f]}
              {FORMATIONS[f] ? "" : " (set as Line for now)"}
            </option>
          ))}
        </select>
        <h4 className="tuner-title">Kerning</h4>
        <label className="tuner-check" title="The font's own kerning pairs. Off shows how much its spacing relies on them.">
          <input type="checkbox" checked={kerning} onChange={(e) => setKerning(e.target.checked)} />
          {kerning ? "On" : "Off"}
        </label>
        <h4 className="tuner-title">Alternates</h4>
        {/* The Alternates slot: F7's picker mounts here through TUNER_ALTERNATES. */}
        <div className="tuner-alternates">
          {TUNER_ALTERNATES.length ? (
            TUNER_ALTERNATES.map((Entry, i) => <Entry key={i} font={face} recipe={recipe} weight={weight} variant={variant} setFeatures={setFeatures} />)
          ) : (
            <p className="faint">Not available yet.</p>
          )}
        </div>
      </section>
    </div>
  );
});

/** One weight of the family, set in the candidate's recipe. It loads that weight's file (its italic for an italic recipe). */
function WeightOption(p: { font: FontEntry; recipe: Recipe; weight: number; on: boolean; variant: FontVariant; onPick: () => void }) {
  const face = useLoadedFace(p.font, p.weight, !!p.recipe.italic);
  // Each weight is its own file: with an alternate on, a Google family loads that weight's full file too.
  const variant = useRecipeVariant(face.drawn, face.weight, p.recipe.features);
  const recipe = useMemo(() => ({ ...p.recipe, weight: face.weight }), [p.recipe, face.weight]);
  const note = face.failed ? " · failed to load" : face.weight !== p.weight ? ` · shows ${face.weight}` : "";
  return (
    <button className={`tuner-option ${p.on ? "on" : ""}`} title={p.on ? "The weight in use" : `Use weight ${p.weight}`} onClick={p.onPick}>
      <span className="tuner-label">
        {p.weight}
        {note}
      </span>
      <Wordmark font={face.drawn} settings={DEFAULT_SETTINGS} recipe={recipe} size={PREVIEW_SIZE} box={PREVIEW_BOX} variant={variant} className={face.ready ? undefined : "is-pending"} />
    </button>
  );
}

function TrackingRung(p: { font: FontEntry; recipe: Recipe; weight: number; variant: FontVariant; step: number; tracking: number; onPick: () => void }) {
  const recipe = useMemo(() => ({ ...p.recipe, weight: p.weight, tracking: p.tracking }), [p.recipe, p.weight, p.tracking]);
  const current = p.step === 0;
  return (
    <button className={`tuner-option ${current ? "on" : ""}`} title={current ? "The spacing in use" : `Use ${formatEm(p.tracking)}`} onClick={p.onPick}>
      <span className="tuner-label">
        {current ? "current" : `${p.step > 0 ? "+" : "−"}${Math.abs(p.step).toFixed(2)}`} <span className="faint">{formatEm(p.tracking)}</span>
      </span>
      <Wordmark font={p.font} settings={DEFAULT_SETTINGS} recipe={recipe} size={PREVIEW_SIZE} box={PREVIEW_BOX} variant={p.variant} />
    </button>
  );
}

/** 0.02 -> '+0.020em', -0.015 -> '−0.015em', 0 -> '0em'. */
function formatEm(em: number): string {
  if (Math.abs(em) < 0.0005) return "0em";
  return `${em > 0 ? "+" : "−"}${Math.abs(em).toFixed(3)}em`;
}
