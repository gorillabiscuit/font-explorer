// Compare: the candidates as a matrix. Rows are the candidates in the order they were saved (one
// family can be there twice, set two ways). Columns are the tests an identity lives through: its
// own layout large, every other layout, the mark small, an avatar, a nav bar, squinted, reversed.
// Every cell is a Wordmark set from that candidate's recipe alone, so the grid's settings never
// reach a row, and tuning one row (CandidateTuner) leaves the others and the grid as they are.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { useRecipeVariant } from "./AltPicker";
import { variantFor } from "./alternates";
import { CandidateTuner } from "./CandidateTuner";
import "./compare.css";
import { CopySvgAction } from "./export/ExportControls";
import { drawnFace, isFontLoaded, type FontVariant } from "./fonts";
import { useInView } from "./hooks";
import { useHotkeys } from "./keymap";
import { DEFAULT_PAD, FORMATIONS } from "./layout/engine";
import type { LayoutResult } from "./layout/types";
import { LetterLineup } from "./LetterLineup";
import { ItalicFromBadge, useLoadedFace } from "./Lightbox";
import { deepMerge } from "./merge";
import { DEFAULT_LAYOUT, FORMATION_LABELS, recipeLabel, type Candidate, type Formation, type LayoutSettings, type Recipe } from "./recipe";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import { squintBlur, typicalSquintBlur } from "./StressView";
import { useStore, type ProjectStore, type CandidateRow } from "./store";
import { SOURCE_LABELS, type FontEntry } from "./types";
import { Wordmark } from "./Wordmark";

interface Props {
  /** One row per candidate; one family can appear twice with different recipes. */
  rows: CandidateRow[];
  /** Only the Size is read: the large column grows with it (never below 96). */
  settings: Settings;
  reasons: Map<string, string>;
  /** Takes the candidate id. */
  onRemove: (candidateId: string) => void;
}

/** What a row action gets: the candidate and the exact recipe its cells are set from. */
export interface RowActionProps {
  candidate: Candidate;
  font: FontEntry;
  /** The candidate's recipe with every layout field filled in. */
  recipe: Recipe;
  /** The weight drawn (the nearest one that loaded). */
  weight: number;
  variant: FontVariant;
  /** The large column's layout (fitted to its box), once it has been measured. */
  ownLayout: () => LayoutResult | null;
}

/**
 * Buttons in each row's header, before 'Apply recipe to grid' and Remove. F9 adds Copy SVG here
 * with one import and one entry. Entries are rendered as components, so they may use hooks.
 */
export const ROW_ACTIONS: Array<(p: RowActionProps) => ReactNode> = [CopySvgAction];

/** The large column: the candidate's own layout, highlighted. */
const BIG = { width: 520, height: 220 };
/** Line, Stack, Block, Lockup, Squint and Reversed. */
const CELL = { width: 220, height: 140 };
const CELL_SIZE = 36;
const MARK_SIZES = [64, 32, 16];
const AVATAR = 40;
/** The nav test is set at its real size, never shrunk to its slot (as in the lightbox). */
const UNFITTED = { width: 10_000 };
const LAYOUT_COLUMNS: Formation[] = ["line", "stack", "block", "lockup"];

/** The box that leaves `px` of room inside the Wordmark's own padding, so the drawing fits a px-sized slot. */
const slotBox = (px: number) => ({ width: px + 2 * DEFAULT_PAD, height: px + 2 * DEFAULT_PAD });
const MARK_BOXES = Object.fromEntries(MARK_SIZES.map((px) => [px, slotBox(px)]));
const AVATAR_BOX = slotBox(AVATAR);

// The letter lined up across candidates, from a click in a large column. It lives outside Compare
// so its keys can be registered for the life of the page: the key map greys out a key that nothing
// has registered yet, and Compare is only mounted once the Compare view has been opened.
let lineupLetter: string | null = null;
const lineupListeners = new Set<() => void>();
function setLetter(letter: string | null) {
  if (letter === lineupLetter) return;
  lineupLetter = letter;
  lineupListeners.forEach((fn) => fn());
}
function subscribeLetter(fn: () => void) {
  lineupListeners.add(fn);
  return () => {
    lineupListeners.delete(fn);
  };
}
const currentLetter = () => lineupLetter;

/** Compare's keys, mounted in OVERLAYS. They act only while the Compare view has the keys. */
export function CompareKeys() {
  useHotkeys("compare", {
    // A click, not a key: registered so the key map shows it as working.
    lineup: () => false,
    closeLineup: () => (lineupLetter === null ? false : setLetter(null)),
  });
  return null;
}

export function Compare({ rows, settings, reasons, onRemove }: Props) {
  const { updateCandidate, setSettings, toast } = useStore();
  const letter = useSyncExternalStore(subscribeLetter, currentLetter);
  // Leaving Compare, or running out of candidates, closes the lineup.
  useEffect(() => () => setLetter(null), []);
  useEffect(() => {
    if (!rows.length) setLetter(null);
  }, [rows.length]);

  if (!rows.length) {
    return <div className="notice">Save candidates with ★ (or hover a card and press S) to compare them here.</div>;
  }
  const large = Math.max(settings.size, 96);
  return (
    <main className="compare">
      {letter !== null && <LetterLineup letter={letter} rows={rows} variantOf={variantOf} onClose={() => setLetter(null)} onRemove={onRemove} />}
      {rows.map(({ candidate, font }) => (
        <Row
          key={candidate.id}
          candidate={candidate}
          font={font}
          reason={reasons.get(font.id)}
          large={large}
          onLetter={setLetter}
          onRemove={onRemove}
          update={updateCandidate}
          setSettings={setSettings}
          toast={toast}
        />
      ))}
    </main>
  );
}

interface RowProps {
  candidate: Candidate;
  font: FontEntry;
  reason?: string;
  /** The Size of the large column. */
  large: number;
  onLetter: (letter: string) => void;
  onRemove: (candidateId: string) => void;
  update: ProjectStore["updateCandidate"];
  setSettings: ProjectStore["setSettings"];
  toast: ProjectStore["toast"];
}

/**
 * Which file a candidate's lineup tiles are drawn from: Google's complete file (with its stylistic
 * sets) when the recipe switches an alternate on and its row has loaded that file, as the row draws.
 * An italic recipe looks for the italic's full file.
 */
function variantOf(font: FontEntry, recipe: Recipe): FontVariant {
  const face = drawnFace(font, !!recipe.italic);
  return variantFor(face, recipe.features) === "full" && isFontLoaded(face, recipe.weight, "full") ? "full" : "web";
}

const EMPTY_RECIPE: Recipe = { text: "", weight: 400, textCase: "as", tracking: 0, features: {}, axes: null, layout: DEFAULT_LAYOUT };

/** A saved recipe with any layout field it predates filled in from the defaults. */
function fullRecipe(r: Recipe): Recipe {
  return deepMerge(EMPTY_RECIPE, r);
}

// Rows get only stable props, so changing one candidate re-renders that row alone.
const Row = memo(function Row({ candidate: c, font, reason, large, onLetter, onRemove, update, setSettings, toast }: RowProps) {
  const ref = useRef<HTMLElement>(null);
  // A row far down the page sets its cells once it comes near, and keeps them from then on.
  const near = useInView(ref, "800px 0px");
  const [seen, setSeen] = useState(near);
  if (near && !seen) setSeen(true);
  const [tuning, setTuning] = useState(false);

  const recipe = useMemo(() => fullRecipe(c.recipe), [c.recipe]);
  // An italic recipe draws the family's italic; a recipe saved before italics existed is upright.
  const face = useLoadedFace(font, recipe.weight, !!recipe.italic);
  // Google's full file once it has loaded, when the recipe switches an alternate on (AltPicker.tsx).
  const variant = useRecipeVariant(face.drawn, face.weight, recipe.features);
  // Named as drawn: the weight that loaded, and no 'Italic' when the italic file would not load and
  // the upright stands in (the row's badge says so).
  const label = recipeLabel(font, { ...recipe, weight: face.weight, italic: !!recipe.italic && !face.noItalic });
  const own = useRef<LayoutResult | null>(null);
  const ownLayout = useCallback(() => own.current, []);

  // Named by the recipe as it was, so two rows of one family read apart in the toast.
  const change = useCallback(
    (patch: Partial<Recipe>, what: string) => update(c.id, { recipe: patch }, { label: `${label}: ${what}` }),
    [update, c.id, label],
  );
  // The grid takes the recipe's name, weight, italic, case, spacing and layout. Grid settings carry
  // no alternates, so features stay with the candidate.
  const apply = () => {
    setSettings((s) => ({
      ...s,
      text: recipe.text,
      weight: recipe.weight,
      italic: !!recipe.italic,
      textCase: recipe.textCase,
      tracking: recipe.tracking,
      layout: structuredClone(recipe.layout),
    }));
    // The toast names what the grid now shows: the recipe without its alternates.
    const alternates = Object.keys(recipe.features ?? {}).length > 0;
    toast(`Grid set to ${recipeLabel(font, { ...recipe, features: {} })}${alternates ? " (alternates stay with the candidate)" : ""}`);
  };
  const saveNote = (note: string) => update(c.id, { note }, { label: note ? `Note on ${label}` : `Cleared the note on ${label}` });

  return (
    <section ref={ref} className="cmp-row">
      <header className="cmp-head">
        {font.homepage ? (
          <a className="family cmp-label" href={font.homepage} target="_blank" rel="noreferrer" title={`${label}\nOpen the foundry page`}>
            {label} <span className="ext">↗</span>
          </a>
        ) : (
          <span className="family cmp-label" title={label}>
            {label}
          </span>
        )}
        <span className={`badge src-${font.source}`}>{SOURCE_LABELS[font.source]}</span>
        <ItalicFromBadge font={font} drawn={face.drawn} />
        <span className="badge">{font.license}</span>
        {face.failed && <span className="badge warn">failed to load</span>}
        {!face.failed && face.weight !== recipe.weight && <span className="badge faint">shows {face.weight}</span>}
        {face.noItalic && (
          <span className="badge" title="No italic to draw: the family has none, or its italic file would not load. Shown upright, never slanted.">
            no italic
          </span>
        )}
        {reason && (
          <span className="cmp-reason" title={reason}>
            {reason}
          </span>
        )}
        <NoteField note={c.note} onSave={saveNote} />
        <div className="spacer" />
        {ROW_ACTIONS.map((Action, i) => (
          <Action key={i} candidate={c} font={font} recipe={recipe} weight={face.weight} variant={variant} ownLayout={ownLayout} />
        ))}
        <button title="Set the grid's name, weight, italic, case, letter spacing and layout to this recipe" onClick={apply}>
          Apply recipe to grid
        </button>
        <button title="Remove this candidate (⌘Z brings it back)" onClick={() => onRemove(c.id)}>
          Remove
        </button>
      </header>
      {seen ? (
        <Cells font={face.drawn} recipe={recipe} weight={face.weight} ready={face.ready} failed={face.failed} variant={variant} large={large} own={own} onLetter={onLetter} />
      ) : (
        <div className="cmp-cells is-waiting" />
      )}
      <button className="cmp-tune-toggle" aria-expanded={tuning} onClick={() => setTuning((t) => !t)}>
        {tuning ? "▴ Hide tuning" : "▾ Tune: weight, letter spacing, italic, case, layout, kerning, alternates"}
      </button>
      {tuning && <CandidateTuner font={font} face={face.drawn} recipe={recipe} weight={face.weight} variant={variant} change={change} />}
    </section>
  );
});

/** Every column's recipe, from the candidate's own. Kept while the recipe and weight stand, so no cell is laid out again. */
function cellRecipes(recipe: Recipe, weight: number) {
  const own: Recipe = { ...recipe, weight };
  const L = recipe.layout;
  // The other layouts are tested plain: Block and Mark get their usual square, the rest no container.
  const plain = DEFAULT_LAYOUT.container;
  const as = (patch: Partial<LayoutSettings>): Recipe => ({ ...own, layout: { ...L, container: plain, ...patch } });
  const circle = { ...plain, shape: "circle", style: "fill", auto: false } as const;
  return {
    own,
    line: as({ formation: "line" }),
    stack: as({ formation: "stack" }),
    block: as({ formation: "block", container: { ...plain, shape: "square", style: "fill", auto: false } }),
    lockup: as({ formation: "lockup" }),
    mark: as({ formation: "mark" }),
    avatarMark: as({ formation: "mark", container: circle }),
    avatarName: { ...own, layout: { ...L, container: circle } },
    // A nav logo is one line. Matching by width needs a box, which the unfitted nav test does not have.
    nav: as({ formation: "line", breaks: null, match: L.match === "width" ? "auto" : L.match, container: { ...plain, shape: "none", auto: false } }),
  } satisfies Record<string, Recipe>;
}

/** A layout the engine has not been taught yet is set as Line, and the label says so. */
const formationLabel = (f: Formation) => `${FORMATION_LABELS[f]}${FORMATIONS[f] ? "" : " (as Line)"}`;

interface CellsProps {
  /** The face drawn: the family's italic for an italic recipe that has one (fonts.ts italicFace). */
  font: FontEntry;
  recipe: Recipe;
  weight: number;
  ready: boolean;
  /** The face never loaded: no real layout will be reported. */
  failed: boolean;
  variant: FontVariant;
  large: number;
  own: { current: LayoutResult | null };
  onLetter: (letter: string) => void;
}

const Cells = memo(function Cells({ font, recipe, weight, ready, failed, variant, large, own, onLetter }: CellsProps) {
  const r = useMemo(() => cellRecipes(recipe, weight), [recipe, weight]);
  const pending = ready ? undefined : "is-pending";
  const common = { font, settings: DEFAULT_SETTINGS, variant };
  const onOwnLayout = useCallback(
    (res: LayoutResult) => {
      own.current = res;
    },
    [own],
  );

  // Clicking a letter in the large column lines that letter up across every candidate.
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const res = own.current;
    const svg = e.currentTarget.querySelector<SVGSVGElement>(".wm-svg");
    if (!res || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ch = letterAt(res, ((e.clientX - rect.left) * res.box.w) / rect.width, ((e.clientY - rect.top) * res.box.h) / rect.height);
    if (ch) onLetter(ch);
  };

  return (
    <div className="cmp-cells">
      <Cell label={`Own layout · ${formationLabel(recipe.layout.formation)}`} className="cmp-own" title="Click a letter to line it up across every candidate" onClick={pick}>
        <Wordmark {...common} recipe={r.own} size={large} box={BIG} className={pending} onLayout={onOwnLayout} />
      </Cell>
      {LAYOUT_COLUMNS.map((f) => (
        <Cell key={f} label={f === "block" ? `${formationLabel(f)} in a square` : formationLabel(f)}>
          <Wordmark {...common} recipe={r[f]} size={CELL_SIZE} box={CELL} className={pending} />
        </Cell>
      ))}
      <Cell label={`${formationLabel("mark")} · ${MARK_SIZES.join(" · ")} px`} className="cmp-small">
        {MARK_SIZES.map((px) => (
          <Slot key={px} px={px} title={`${px} px`}>
            <Wordmark {...common} recipe={r.mark} size={px * 3} box={MARK_BOXES[px]} className={pending} />
          </Slot>
        ))}
      </Cell>
      <Cell label={`Avatar · ${AVATAR} px`} className="cmp-small">
        <Slot px={AVATAR} round title="The mark in a circle">
          <Wordmark {...common} recipe={r.avatarMark} size={AVATAR * 3} box={AVATAR_BOX} className={pending} />
        </Slot>
        <Slot px={AVATAR} round title="The name in a circle">
          <Wordmark {...common} recipe={r.avatarName} size={AVATAR * 3} box={AVATAR_BOX} className={pending} />
        </Slot>
      </Cell>
      <Cell label="Nav · 16 px" className="cmp-nav">
        <Wordmark {...common} recipe={r.nav} size={16} box={UNFITTED} className={["cmp-mini", pending].filter(Boolean).join(" ")} />
        <span className="cmp-nav-fake">Product&nbsp;&nbsp;Pricing&nbsp;&nbsp;About</span>
      </Cell>
      <SquintCell font={font} recipe={r.own} variant={variant} pending={pending} failed={failed} />
      <Cell label="Reversed" className="cmp-reversed">
        <Wordmark {...common} recipe={r.own} size={CELL_SIZE} box={CELL} className={pending} />
      </Cell>
    </div>
  );
});

function Cell(p: { label: string; className?: string; title?: string; onClick?: (e: MouseEvent<HTMLDivElement>) => void; children: ReactNode }) {
  return (
    <figure className={["cmp-cell", p.className].filter(Boolean).join(" ")}>
      <figcaption className="cmp-cell-label">{p.label}</figcaption>
      <div className="cmp-art" title={p.title} onClick={p.onClick}>
        {p.children}
      </div>
    </figure>
  );
}

/** A px-sized slot. The wordmark (its own padding included) is centred on it, so the drawing fills it. */
function Slot({ px, round, title, children }: { px: number; round?: boolean; title?: string; children: ReactNode }) {
  return (
    <span className={`cmp-slot ${round ? "is-round" : ""}`} style={{ width: px, height: px }} title={title}>
      {children}
    </span>
  );
}

/**
 * The own layout blurred by 6% of its cap height, as drawn: what survives a squint. A face that
 * never loaded reports no layout, so it is shown with a typical face's blur instead of staying hidden.
 */
function SquintCell({ font, recipe, variant, pending, failed }: { font: FontEntry; recipe: Recipe; variant: FontVariant; pending?: string; failed: boolean }) {
  const [measured, setBlur] = useState<number | null>(null);
  const onLayout = useCallback((res: LayoutResult) => setBlur(squintBlur(res)), []);
  const blur = measured ?? (failed ? typicalSquintBlur(CELL_SIZE) : null);
  return (
    <Cell label="Squint" className={`cmp-squint ${blur === null ? "is-measuring" : ""}`}>
      <div className="cmp-blur" style={{ ["--cmp-blur" as string]: `${blur ?? 0}px` }}>
        <Wordmark font={font} settings={DEFAULT_SETTINGS} recipe={recipe} size={CELL_SIZE} box={CELL} variant={variant} className={pending} onLayout={onLayout} />
      </div>
    </Cell>
  );
}

/** Within this many px of a letter's ink, a click still picks it. */
const HIT_SLOP = 6;

/** The letter drawn at (x, y), in the layout's own px, or null when the click missed every letter. */
export function letterAt(r: LayoutResult, x: number, y: number): string | null {
  let best: { d: number; ch: string } | null = null;
  for (const run of r.runs) {
    for (const g of run.glyphs) {
      // Letters only: not spaces, and not an accent drawn as its own glyph.
      const chars = [...g.char];
      if (g.missing || g.inkR <= g.inkL || !chars.some((ch) => /[^\s\p{M}]/u.test(ch))) continue;
      const dx = x < g.inkL ? g.inkL - x : x > g.inkR ? x - g.inkR : 0;
      const dy = y < g.inkT ? g.inkT - y : y > g.inkB ? y - g.inkB : 0;
      const d = Math.hypot(dx, dy);
      if (d > HIT_SLOP || (best && d >= best.d)) continue;
      // A ligature draws several letters: the one under the pointer, by its share of the width.
      const i = chars.length > 1 ? Math.min(chars.length - 1, Math.max(0, Math.floor(((x - g.inkL) / (g.inkR - g.inkL)) * chars.length))) : 0;
      best = { d, ch: chars[i] };
    }
  }
  return best?.ch ?? null;
}

/** The candidate's note: shown as text, edited in place on click. Enter or leaving the field saves; Esc cancels. */
function NoteField({ note, onSave }: { note: string; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Esc removes the field, and a field removed while focused may still report a blur: only the first ending counts.
  const ended = useRef(false);
  if (draft === null) {
    return (
      <button className={`cmp-note ${note ? "" : "is-empty"}`} title={note ? `${note}\nClick to edit` : "Add a note to this candidate"} onClick={() => ((ended.current = false), setDraft(note))}>
        {note || "Add a note"}
      </button>
    );
  }
  const end = (save: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (save && draft.trim() !== note) onSave(draft.trim());
    setDraft(null);
  };
  return (
    <input
      className="cmp-note-input"
      type="text"
      autoFocus
      value={draft}
      placeholder="Why this one, what to check"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") end(true);
        else if (e.key === "Escape") {
          e.preventDefault();
          end(false);
        }
      }}
      onBlur={() => end(true)}
    />
  );
}
