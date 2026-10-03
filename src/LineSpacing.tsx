// The top bar's line spacing: the gap between a Stack's lines (and a Lockup's, when its name is
// stacked with a typed '/') or between a Block's rows, in reach instead of in the ⚙ popover. It sets
// the same values as the popover's sliders, with the same range, so the two always agree.
// It stays in the bar in every layout, greyed out where it has no effect, so switching layouts never
// moves the controls after it or changes the bar's height.
import { formatGap, LEADING, LEADING_HINT, leadingUnit, ROW_GAP } from "./layout/controls/spacing";
import "./layout/layout.css";
import { rowGapOf, type LayoutSettings } from "./recipe";
import { parseName } from "./settings";
import { useStore } from "./store";

const OFF_HINT = "Line spacing applies to Stack, Block, and a Lockup whose name has a line break (/).";

export function LineSpacing() {
  const { settings, setSettings } = useStore();
  const { layout } = settings;
  // Lockup sets the name as a Stack only when it has more than one line (lockup.ts).
  const stacked = layout.formation === "stack" || (layout.formation === "lockup" && parseName(settings).lines.length > 1);
  const off = !stacked && layout.formation !== "block";

  const update = (change: (l: LayoutSettings) => LayoutSettings) => setSettings((s) => ({ ...s, layout: change(s.layout) }));
  // Greyed out, it shows Stack's leading: what a line break would bring back.
  const control =
    stacked || off
      ? {
          value: layout.stack.leading,
          range: LEADING,
          unit: leadingUnit(settings),
          hint: LEADING_HINT,
          set: (leading: number) => update((l) => ({ ...l, stack: { ...l.stack, leading } })),
        }
      : {
          value: rowGapOf(layout.block),
          range: ROW_GAP,
          unit: "cap",
          hint: "The gap between rows, in cap heights.",
          set: (rowGap: number) => update((l) => ({ ...l, block: { ...l.block, rowGap } })),
        };
  const { value, range, unit, hint, set } = control;
  const title = off ? OFF_HINT : `${hint} Below 0 they overlap, and a card says when letters collide. Double-click the slider to reset`;
  return (
    <label className={`ctl line-spacing ${off ? "is-off" : ""}`} title={title} aria-disabled={off || undefined}>
      Line spacing <span className="val">{formatGap(value, unit)}</span>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        disabled={off}
        onChange={(e) => set(Number(e.target.value))}
        onDoubleClick={() => set(range.reset)}
      />
    </label>
  );
}
