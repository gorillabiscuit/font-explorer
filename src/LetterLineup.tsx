// The letter lineup: one letter from every candidate, large, at equal cap height on one shared
// baseline, so two near-twins are settled on the letter that decides it. Opened by clicking a
// letter in a Compare row's large wordmark; Esc or ✕ closes it.
import { memo, useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { FontVariant } from "./fonts";
import type { LayoutResult } from "./layout/types";
import { useLoadedFace } from "./Lightbox";
import { DEFAULT_LAYOUT, type Recipe } from "./recipe";
import { DEFAULT_SETTINGS } from "./settings";
import type { CandidateRow } from "./store";
import type { FontEntry } from "./types";
import { Wordmark } from "./Wordmark";

/** Cap height 0.7 of this, so each letter stands about 240 px tall with its padding. */
const SIZE = 200;
const UNFITTED = { width: 10_000 };

interface Props {
  /** The letter as clicked. Every candidate shows this exact character, whatever its own case. */
  letter: string;
  rows: CandidateRow[];
  /** Which file each candidate is drawn from, as in its Compare row. */
  variantOf: (font: FontEntry, recipe: Recipe) => FontVariant;
  onClose: () => void;
  /** Removes the candidate (undoable), not just its place in the lineup. */
  onRemove: (candidateId: string) => void;
}

export function LetterLineup({ letter, rows, variantOf, onClose, onRemove }: Props) {
  const top = useTopbarHeight();
  // Each tile's baseline (px from its top), so every tile is nudged down onto the lowest one.
  const [baselines, setBaselines] = useState<Record<string, number>>({});
  const report = useCallback((key: string, y: number) => setBaselines((b) => (Math.abs((b[key] ?? -1) - y) < 0.01 ? b : { ...b, [key]: y })), []);
  // Per candidate, kept while the candidates stand, so the tiles (and their layouts) stay put.
  const tiles = useMemo(
    () => new Map(rows.map(({ candidate, font }) => [candidate.id, tilesOf(candidate.id, font, candidate.recipe, variantOf(font, candidate.recipe))])),
    [rows, variantOf],
  );
  const shared = Math.max(0, ...[...tiles.values()].flat().map((t) => baselines[t.key] ?? 0));
  return (
    <section className="lineup" style={{ top }} aria-label={`Letter lineup: ${letter}`}>
      <header className="lineup-head">
        <strong>
          Lineup: <span className="lineup-letter">{letter}</span>
        </strong>
        <span className="faint">every candidate at equal cap height, on one baseline</span>
        <div className="spacer" />
        <span className="faint">Esc closes</span>
        <button className="icon-btn" title="Close the lineup (Esc)" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="lineup-strip">
        {rows.map(({ candidate, font }) => (
          <div key={candidate.id} className="lineup-entry">
            <div className="lineup-glyphs">
              {(tiles.get(candidate.id) ?? []).map((t) => (
                <LineupTile key={t.key} tile={t} letter={letter} offset={shared - (baselines[t.key] ?? shared)} report={report} />
              ))}
            </div>
            <div className="lineup-name">
              <span className="family" title={font.family}>
                <LineupName font={font} recipe={candidate.recipe} />
              </span>
              <button className="icon-btn" title="Remove this candidate (⌘Z brings it back)" onClick={() => onRemove(candidate.id)}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The family with the weight and style drawn, as its Compare row names them. */
function LineupName({ font, recipe }: { font: FontEntry; recipe: Recipe }) {
  const face = useLoadedFace(font, recipe.weight, !!recipe.italic);
  return (
    <>
      {font.family} <span className="faint">{face.weight}{recipe.italic && !face.noItalic ? " italic" : ""}</span>
    </>
  );
}

interface Tile {
  key: string;
  font: FontEntry;
  variant: FontVariant;
  recipe: Recipe;
  features: Record<string, 0 | 1>;
  /** Under an alternate pair: 'default' or the features switched on. */
  label?: string;
}

/** A candidate with features on shows its default glyph next to the alternate one. */
function tilesOf(cid: string, font: FontEntry, recipe: Recipe, variant: FontVariant): Tile[] {
  const features = recipe.features ?? {};
  const on = Object.keys(features).filter((tag) => features[tag] === 1 && tag !== "kern");
  if (!on.length) return [{ key: cid, font, variant, recipe, features }];
  const plain = Object.fromEntries(Object.entries(features).filter(([, v]) => v === 0)) as Record<string, 0 | 1>;
  return [
    { key: `${cid}:default`, font, variant, recipe, features: plain, label: "default" },
    { key: `${cid}:alt`, font, variant, recipe, features, label: on.join(" ") },
  ];
}

const LineupTile = memo(function LineupTile({
  tile,
  letter,
  offset,
  report,
}: {
  tile: Tile;
  letter: string;
  offset: number;
  report: (key: string, y: number) => void;
}) {
  // An italic candidate's letter comes from its italic, as its row draws it.
  const face = useLoadedFace(tile.font, tile.recipe.weight, !!tile.recipe.italic);
  const layout = tile.recipe.layout ?? DEFAULT_LAYOUT;
  // Cap-height matching, one line, the candidate's weight and alternates. A '/' is escaped, or the
  // name parser would read it as a line break.
  const recipe = useMemo<Partial<Recipe>>(
    () => ({
      text: letter === "/" ? "\\/" : letter,
      textCase: "as",
      tracking: 0,
      weight: face.weight,
      features: tile.features,
      layout: { ...DEFAULT_LAYOUT, ...layout, formation: "line", breaks: null, match: "cap", container: DEFAULT_LAYOUT.container },
    }),
    [letter, face.weight, tile.features, layout],
  );
  const { key } = tile;
  const onLayout = useCallback((r: LayoutResult) => report(key, r.runs[0]?.y ?? 0), [report, key]);
  return (
    <div className="lineup-tile" style={{ marginTop: offset }}>
      <Wordmark
        font={face.drawn}
        settings={DEFAULT_SETTINGS}
        recipe={recipe}
        size={SIZE}
        box={UNFITTED}
        variant={tile.variant}
        className={face.ready ? undefined : "is-pending"}
        onLayout={onLayout}
      />
      {tile.label && <span className="lineup-tag">{tile.label}</span>}
    </div>
  );
});

/** The sticky top bar's height: the lineup sticks right under it while the rows scroll. */
function useTopbarHeight(): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const bar = document.querySelector(".topbar");
    if (!bar) return;
    const read = () => setHeight(bar.getBoundingClientRect().height);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  return height;
}
