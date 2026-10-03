// Line-break suggestions for Stack (and Block): a row of chips above the grid while the name has no
// typed '/'. Clicking one, or [ and ], sets the same breaks on every card. The row scrolls with the
// grid instead of sitting in the top bar, so switching layouts never changes the bar's height.
// It stays mounted in Compare (where it shows nothing), so a name typed there still clears the breaks.
import { useEffect, useRef } from "react";
import { useMeasurer } from "./facts/useFacts";
import { drawnFace, isFontLoaded } from "./fonts";
import { useHotkeys } from "./keymap";
import { gridBreaks } from "./layout/block";
import { applyBreaks, defaultBreaks, suggestBreaks, type BreakSuggestion } from "./layout/breaks";
import "./layout/layout.css";
import type { Measurer } from "./facts/types";
import { parseName, type Settings } from "./settings";
import { useStore, type Item } from "./store";
import type { FontEntry } from "./types";

export function BreakChips() {
  const { settings, setSettings, focusId, byId, items, limit, view } = useStore();
  const { layout, text, textCase, weight, italic } = settings;

  // Breaks are positions in the name, so typing a new name clears them. A name and layout replaced
  // together (another project, a candidate's recipe applied) keep the breaks that came with them.
  const before = useRef({ text, layout });
  useEffect(() => {
    const prev = before.current;
    before.current = { text, layout };
    if (prev.text !== text && prev.layout === layout && layout.breaks) {
      setSettings((s) => (s.layout.breaks ? { ...s, layout: { ...s.layout, breaks: null } } : s));
    }
  }, [text, layout, setSettings]);

  const name = parseName({ text, textCase });
  const shown = view === "grid" && (layout.formation === "stack" || layout.formation === "block") && name.lines.length === 1;
  // Ranked by the font in hand: the focused card's, or the first one that has loaded. With Italic
  // on, in the face the cards draw: the family's italic when it lists one.
  const focused = focusId ? byId.get(focusId) : undefined;
  const focusedFace = focused && drawnFace(focused, italic);
  const font = shown ? (focusedFace && isFontLoaded(focusedFace, weight) ? focusedFace : firstLoaded(items.slice(0, limit), weight, italic)) : undefined;

  const list = useRef<BreakSuggestion[]>([]);
  const choose = (s: BreakSuggestion) => setSettings((st) => ({ ...st, layout: { ...st.layout, breaks: s.breaks } }));
  useHotkeys("grid", {
    breaks: (_e, key) => {
      const options = list.current;
      if (!shown || !options.length) return false;
      const active = layout.breaks ?? defaultFor(layout, name.flat);
      const i = options.findIndex((s) => sameBreaks(s.breaks, active));
      choose(options[key === "]" ? (i + 1) % options.length : i <= 0 ? options.length - 1 : i - 1]);
    },
  });

  if (!shown) {
    list.current = [];
    return null;
  }
  const props = { flat: name.flat, settings, font, list, choose };
  return font ? <MeasuredChips key={`${font.id}@${weight}`} {...props} font={font} /> : <Chips {...props} measurer={null} />;
}

interface ChipsProps {
  flat: string;
  settings: Settings;
  font: FontEntry | undefined;
  list: { current: BreakSuggestion[] };
  choose: (s: BreakSuggestion) => void;
}

function MeasuredChips(props: ChipsProps & { font: FontEntry }) {
  return <Chips {...props} measurer={useMeasurer(props.font, props.settings.weight)} />;
}

function Chips({ flat, settings, font, list, choose, measurer }: ChipsProps & { measurer: Measurer | null }) {
  const auto = defaultFor(settings.layout, flat);
  const two = defaultFirst(suggestBreaks(flat, measurer, 2), auto, flat, 2);
  const three = defaultFirst(suggestBreaks(flat, measurer, 3), auto, flat, 3);
  list.current = [...two, ...three];
  if (!list.current.length) return null;
  const active = settings.layout.breaks ?? auto;
  const chip = (s: BreakSuggestion) => (
    <button key={s.label} className={`chip ${sameBreaks(s.breaks, active) ? "on" : ""}`} onClick={() => choose(s)}>
      {s.label}
      {sameBreaks(s.breaks, auto) && <span className="faint"> default</span>}
    </button>
  );
  return (
    <div className="row break-chips">
      <span className="faint">Breaks</span>
      {two.map(chip)}
      {three.length > 0 && <span className="divider" />}
      {three.map(chip)}
      <span className="faint break-hint">
        [ ] cycle · default: {settings.layout.formation === "block" ? "the block's own grid" : "the most even letter count"}
        {measurer && font ? `, the rest ranked in ${font.family}` : ""}
      </span>
    </div>
  );
}

/**
 * The split every card uses until one is chosen (even letter counts, alike for every font), put
 * first, so the highlighted chip leads the row and the others are the alternatives to it.
 */
function defaultFirst(ranked: BreakSuggestion[], auto: number[] | null, flat: string, count: 2 | 3): BreakSuggestion[] {
  if (!auto || auto.length !== count - 1) return ranked;
  const lines = applyBreaks(flat, auto);
  // Matched by its lines too: two positions can give the same lines, and one chip is enough.
  const own = ranked.find((s) => sameBreaks(s.breaks, auto)) ?? ranked.find((s) => s.label === lines.join("/")) ?? { breaks: auto, lines, label: lines.join("/"), balance: 0 };
  return [own, ...ranked.filter((s) => s !== own)].slice(0, 4);
}

/** Where the cards break before a chip is chosen: Block's automatic grid (4+3, 3×3), or Stack's even split. */
function defaultFor(layout: Settings["layout"], flat: string): number[] | null {
  return layout.formation === "block" ? gridBreaks(flat, layout.block.cols) : defaultBreaks(flat);
}

function firstLoaded(items: Item[], weight: number, italic: boolean): FontEntry | undefined {
  for (const it of items) {
    const face = drawnFace(it.font, italic);
    if (isFontLoaded(face, weight)) return face;
  }
  return undefined;
}

function sameBreaks(a: number[] | null, b: number[] | null): boolean {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}
