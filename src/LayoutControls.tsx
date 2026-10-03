// The top bar's layout controls: which formation every card is set in (keys 1-5), what the sizes are
// matched on, and a ⚙ popover with the current formation's own settings.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHotkeys } from "./keymap";
import { COMMON_CONTROLS, FORMATION_CONTROLS } from "./layout/controls/registry";
import { FORMATIONS } from "./layout/engine";
import "./layout/layout.css";
import { FORMATION_LABELS, FORMATION_ORDER, type Formation, type LayoutSettings, type MatchMode } from "./recipe";
import { useStore } from "./store";

const MATCH_OPTIONS: [MatchMode, string, string][] = [
  ["auto", "Auto", "Cap height for an all-caps name, x-height otherwise"],
  ["cap", "Cap height", "Every font gets the same cap height"],
  ["x", "x-height", "Every font gets the same x-height"],
  ["width", "Width", "Every font fills the card's width"],
  ["em", "Font size", "Plain font size, unmatched"],
];

export function LayoutControls() {
  const { settings, setSettings, focusId } = useStore();
  const { layout } = settings;
  const update = useCallback(
    (change: (l: LayoutSettings) => LayoutSettings) => setSettings((s) => ({ ...s, layout: change(s.layout) })),
    [setSettings],
  );
  const setFormation = (formation: Formation | undefined) => {
    if (!formation) return false;
    update((l) => (l.formation === formation ? l : { ...l, formation }));
  };
  // The lightbox registers its own 1-5 (Lightbox.tsx).
  useHotkeys("grid", { layout: (_e, key) => setFormation(FORMATION_ORDER[Number(key) - 1]) });

  // A new layout changes card heights; keep the focused card on screen. Nothing reloads or reorders.
  const focus = useRef(focusId);
  focus.current = focusId;
  const shown = useRef(layout);
  useEffect(() => {
    if (shown.current === layout) return;
    shown.current = layout;
    const id = focus.current;
    if (!id) return;
    const frame = requestAnimationFrame(() => keepInSight(document.querySelector(`.grid [data-font-id="${CSS.escape(id)}"]`)));
    return () => cancelAnimationFrame(frame);
  }, [layout]);

  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    // Captured, so Esc closes the popover before it reaches the grid (where it clears the focus).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // The top bar wraps, so the gear can sit near the right edge: open the popover leftwards there.
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    el.style.left = "";
    el.style.right = "";
    if (el.getBoundingClientRect().right > window.innerWidth - 8) {
      el.style.left = "auto";
      el.style.right = "0";
    }
  }, [open]);

  const Controls = FORMATION_CONTROLS[layout.formation];
  return (
    <div className="layout-controls">
      <div className="seg" role="group" aria-label="Layout">
        {FORMATION_ORDER.map((f, i) => (
          <button
            key={f}
            className={layout.formation === f ? "on" : ""}
            title={`${FORMATION_LABELS[f]} (${i + 1})${FORMATIONS[f] ? "" : ": not built yet, set as Line for now"}`}
            onClick={() => setFormation(f)}
          >
            {FORMATION_LABELS[f]}
          </button>
        ))}
      </div>
      <label className="ctl" title={MATCH_OPTIONS.find(([m]) => m === layout.match)?.[2]}>
        Match
        <select value={layout.match} onChange={(e) => update((l) => ({ ...l, match: e.target.value as MatchMode }))}>
          {MATCH_OPTIONS.map(([value, label, hint]) => (
            <option key={value} value={value} title={hint}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="layout-pop-anchor" ref={anchor}>
        <button className={`layout-gear ${open ? "on" : ""}`} title="Layout settings" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          ⚙
        </button>
        {open && (
          <div ref={pop} className="layout-pop" role="dialog" aria-label={`${FORMATION_LABELS[layout.formation]} settings`}>
            <div className="layout-pop-title">{FORMATION_LABELS[layout.formation]}</div>
            {Controls ? <Controls layout={layout} update={update} /> : <div className="faint">Not built yet: set as Line for now.</div>}
            {COMMON_CONTROLS.map((Common, i) => (
              <Common key={i} layout={layout} update={update} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Scrolls just enough to show the card below the sticky top bar. */
function keepInSight(card: Element | null) {
  // A card of the hidden grid (Compare is showing) has no box to keep in sight.
  if (!card || !card.getClientRects().length) return;
  const top = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + 8;
  const r = card.getBoundingClientRect();
  if (r.top < top) window.scrollBy({ top: r.top - top });
  else if (r.bottom > window.innerHeight - 8) window.scrollBy({ top: Math.min(r.bottom - window.innerHeight + 8, r.top - top) });
}
