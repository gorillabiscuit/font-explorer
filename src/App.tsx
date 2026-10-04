// The page frame. State lives in store.ts; features mount through slots.tsx and register their
// keys with useHotkeys (keymap.ts). Keep this file to mounting: a feature may add a mount line,
// a hotkey block or one filter chip here, and nothing more.
import { useDeferredValue, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { Card, usePublishCardSettings } from "./Card";
import { localFontsSupported } from "./catalog";
import { Compare } from "./Compare";
import { STATIC } from "./env";
import { ExportMenu } from "./export/ExportControls";
import { useInView, useSettled } from "./hooks";
import { DONE_TYPING_KEYS, useHotkeys } from "./keymap";
import { columnWidth, intrinsicHeight } from "./layout/grid";
import { cardInSight, useGridNav } from "./nav";
import { SORT_LABELS, type Settings, type SortMode, type TextCase } from "./settings";
import { ABOVE_GRID, BELOW_VIBE, FILTER_CHIPS, GRID_PANELS, OVERLAYS, Slots, TOPBAR_CONTROLS, TOPBAR_LEFT, TOPBAR_RIGHT } from "./slots";
import { PAGE, useStore } from "./store";
import { CATEGORIES, SOURCE_LABELS, SOURCES, type Category, type Source } from "./types";
import { SealFilter } from "./Seal";
import { VibeBar } from "./VibeBar";

export function App() {
  const store = useStore();
  const { settings, setSettings, filters, setFilters, marks, view, setView, items, limit, setLimit, focusId, setFocus, find, setFind } = store;
  const { all, remote, local, catalogStatus, activeTurn, candidateRows, candidateFontIds, culledIds, reasons, toastState } = store;

  // Undo works everywhere; X, M and S act on the focused card (under the mouse, or moved to by key),
  // but only while it is drawn and on screen. A verdict must never land on a card nobody can see,
  // so otherwise the key does nothing.
  useHotkeys("global", { undo: () => store.undo() });
  const onFocusedCard = (act: (id: string) => void) => () => (focusId && cardInSight(focusId) ? act(focusId) : false);
  // Keyboard triage (nav.ts): arrows, Home and End move the focus, X, M and S move on to the next
  // card, Space or Enter opens the lightbox, P pins the reference. A held key repeats; repeats of
  // Space and Esc do nothing here, so the key that just closed the lightbox cannot reopen it or
  // clear the focus it handed back.
  const nav = useGridNav();
  useHotkeys("grid", {
    cull: onFocusedCard(nav.advancing(store.cull)),
    maybe: onFocusedCard(nav.advancing(store.maybe)),
    shortlist: onFocusedCard(nav.advancing(store.shortlist)),
    clearFocus: (e) => (focusId ? (e.repeat ? undefined : setFocus(null)) : false),
    move: nav.move,
    jump: nav.jump,
    open: (e) => onFocusedCard(e.repeat ? () => {} : nav.open)(),
    pin: onFocusedCard(nav.pin),
  });

  // Moving the mouse over a card focuses it. Only real movement counts: scrolling under a still
  // mouse (or after the arrow keys moved the focus) must not steal the focus.
  const lastMouse = useRef({ x: -1, y: -1 });
  const focusUnderMouse = (e: MouseEvent) => {
    if (e.clientX === lastMouse.current.x && e.clientY === lastMouse.current.y) return;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    // A dropdown keeps the keys while it has focus; once the hand is back on the grid, X, M and S
    // should work again. Text fields keep their focus, so a nudge of the mouse never turns typing into verdicts.
    if (document.activeElement instanceof HTMLSelectElement) document.activeElement.blur();
    const id = (e.target as Element).closest<HTMLElement>("[data-font-id]")?.dataset.fontId;
    if (id) setFocus(id);
  };
  // Scrolling moves the page under a still mouse and sends no mousemove, so the focus could stay on
  // a card scrolled out of sight. After a wheel scroll the card under the pointer takes the focus
  // (none over a gap), because the mouse is the cursor. Any other scroll (Page Down, dragging the
  // scrollbar) matters only once it settles with the focused card out of sight: then the card under
  // the pointer takes over, or the focus clears. Scrolls the app makes to show the focused card
  // (scrollIntoView after an arrow key) end with that card in sight, so they leave the focus alone.
  const focusNow = useRef(focusId);
  focusNow.current = focusId;
  // The grid stays mounted (hidden) while Compare is shown, so a scroll there must not move or
  // clear the grid's focus: coming back finds the same card focused, at the same place.
  const gridShown = useRef(view === "grid");
  gridShown.current = view === "grid";
  useEffect(() => {
    const pointer = { x: -1, y: -1 };
    let wheelAt = 0;
    let frame = 0;
    let settle = 0;
    const cardUnderPointer = () =>
      pointer.x < 0 ? null : (document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>(".grid [data-font-id]")?.dataset.fontId ?? null);
    const onMove = (e: globalThis.MouseEvent) => Object.assign(pointer, { x: e.clientX, y: e.clientY });
    const onWheel = () => (wheelAt = performance.now());
    const onScroll = () => {
      if (!gridShown.current) return;
      if (performance.now() - wheelAt <= 250) {
        if (frame || pointer.x < 0) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setFocus(cardUnderPointer());
        });
        return;
      }
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        const id = focusNow.current;
        if (gridShown.current && id && !cardInSight(id)) setFocus(cardUnderPointer());
      }, 120);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("scroll", onScroll);
    };
  }, [setFocus]);

  // Scrolling back to the top on a filter or Find change, and back to each vibe chip's own spot,
  // happens in the store (scrollMemory.ts).

  const sentinel = useRef<HTMLDivElement>(null);
  const nearEnd = useInView(sentinel, "600px 0px");
  // The sensor reports a frame late: right after scroll memory jumps back down a long list, it can
  // still say 'near' from the short vibe chip before. So the sentinel's real position decides, and
  // a stale 'near' waits for a scroll that really brings the end close.
  useEffect(() => {
    if (!nearEnd || limit >= items.length) return;
    // A hidden grid (Compare is showing) has no box: its sentinel reads top 0, which is not 'near'.
    const near = () => {
      const el = sentinel.current;
      return !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().top <= innerHeight + 600;
    };
    if (near()) return void setLimit((l) => l + PAGE);
    const onScroll = () => {
      if (!near()) return;
      window.removeEventListener("scroll", onScroll); // one page per wait
      setLimit((l) => l + PAGE);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [nearEnd, limit, items.length, setLimit]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));
  const toggleIn = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
    all.forEach((f) => c[f.source]++);
    return c;
  }, [all]);
  const maybeOrBetterCount = useMemo(
    () => new Set([...candidateFontIds, ...Object.keys(marks.verdicts).filter((id) => marks.verdicts[id] === "maybe")]).size,
    [candidateFontIds, marks.verdicts],
  );
  const shortlistIds = useMemo(() => [...candidateFontIds], [candidateFontIds]);

  // Column width and the expected card height (for cards not drawn yet) follow the layout (layout/grid.ts),
  // and the name as the cards set it: held back while typing, so a keystroke never resizes every card.
  const { layout, textCase, size, tracking } = settings;
  const text = useSettled(settings.text);
  const colMin = useMemo(() => columnWidth(layout, { text, textCase, size, tracking }), [layout, text, textCase, size, tracking]);
  const cardHeight = useMemo(() => intrinsicHeight(layout, { text, textCase, size, tracking }), [layout, text, textCase, size, tracking]);
  // The height only sizes cards never drawn yet, but changing it restyles every mounted card (it is
  // inherited), which took longer than re-setting the cards on screen. So it follows a moment later.
  const cardHeightLater = useDeferredValue(cardHeight);
  // Cards take the settings from a feed, near the screen first (Card.tsx).
  usePublishCardSettings(settings, view === "grid");

  return (
    <div className={`app ${settings.seal ? "seal" : settings.invert ? "inverted" : ""}`}>
      {settings.seal && <SealFilter />}
      <header className="topbar">
        <div className="row controls">
          <Slots of={TOPBAR_LEFT} />
          <strong className="brand">Font Explorer</strong>
          <input
            className="wordmark-input"
            type="text"
            value={settings.text}
            placeholder="Your wordmark"
            title="Type / for a line break (\/ for a slash). Press Enter when done to use the grid's keys"
            onChange={(e) => set("text", e.target.value)}
            onKeyDown={(e) => {
              // Done typing: the keys go back to the grid (keymap.ts DONE_TYPING_KEYS).
              if (DONE_TYPING_KEYS.includes(e.key) && !e.nativeEvent.isComposing) e.currentTarget.blur();
            }}
          />
          <label className="ctl">
            Size <span className="val">{settings.size}</span>
            <input type="range" min={16} max={200} value={settings.size} onChange={(e) => set("size", Number(e.target.value))} />
          </label>
          <label className="ctl">
            Weight
            <select value={settings.weight} onChange={(e) => set("weight", Number(e.target.value))}>
              {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Case">
            {(
              [
                ["as", "Aa"],
                ["upper", "AA"],
                ["lower", "aa"],
              ] as [TextCase, string][]
            ).map(([value, label]) => (
              <button key={value} className={settings.textCase === value ? "on" : ""} onClick={() => set("textCase", value)}>
                {label}
              </button>
            ))}
          </div>
          <Slots of={TOPBAR_CONTROLS} />
          <label className="ctl" title="Double-click the slider to reset">
            Letter spacing <span className="val">{settings.tracking.toFixed(3)}em</span>
            <input
              type="range"
              min={-0.15}
              max={0.6}
              step={0.005}
              value={settings.tracking}
              onChange={(e) => set("tracking", Number(e.target.value))}
              onDoubleClick={() => set("tracking", 0)}
            />
          </label>
          {/* While Seal is on it sets the colours, so this button first turns Seal off. */}
          <button
            className={`toggle ${settings.invert && !settings.seal ? "on" : ""} ${settings.seal ? "is-off" : ""}`}
            onClick={() => (settings.seal ? set("seal", false) : set("invert", !settings.invert))}
          >
            {settings.invert ? "White on black" : "Black on white"}
          </button>
          <button
            className={`toggle ${settings.seal ? "on" : ""}`}
            title="Red seal: every name in vermilion on paper, as a Japanese hanko stamps it. Block and Mark become the red square with the letters cut out"
            onClick={() => set("seal", !settings.seal)}
          >
            Seal
          </button>
          <div className="spacer" />
          <Slots of={TOPBAR_RIGHT} />
          <div className="seg" role="tablist">
            <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")}>
              Grid
            </button>
            <button className={view === "compare" ? "on" : ""} onClick={() => setView("compare")}>
              Compare ({candidateRows.length})
            </button>
          </div>
          <ExportMenu />
        </div>

        <VibeBar
          vibes={store.vibes}
          activeVibe={store.activeVibe}
          setActiveVibe={store.setActiveVibe}
          setVibes={store.setVibes}
          all={all}
          shortlist={shortlistIds}
          culled={culledIds}
          filters={filters}
          passes={store.passes}
          onError={(text) => store.toast(text, { ms: 15000 })}
        />
        <Slots of={BELOW_VIBE} />

        {view === "grid" && (
          <div className="row filters">
            {SOURCES.map((s) => (
              <button
                key={s}
                className={`chip ${filters.sources.includes(s) ? "on" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, sources: toggleIn(f.sources, s) }))}
              >
                {SOURCE_LABELS[s]} <span className="faint">{counts[s]}</span>
              </button>
            ))}
            <span className="divider" />
            {CATEGORIES.map((c: Category) => (
              <button
                key={c}
                className={`chip ${filters.categories.includes(c) ? "on" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, categories: toggleIn(f.categories, c) }))}
              >
                {c}
              </button>
            ))}
            <span className="divider" />
            {/* The rules behind these chips live in store.ts passes(). */}
            <button
              className={`chip ${filters.candidatesOnly ? "on" : ""}`}
              title="Only fonts with a saved candidate (★)"
              onClick={() => setFilters((f) => ({ ...f, candidatesOnly: !f.candidatesOnly }))}
            >
              ★ Candidates <span className="faint">{candidateFontIds.size}</span>
            </button>
            <button
              className={`chip ${filters.maybeOrBetter ? "on" : ""}`}
              title="Only fonts marked maybe (M) or saved as a candidate (S)"
              onClick={() => setFilters((f) => ({ ...f, maybeOrBetter: !f.maybeOrBetter }))}
            >
              Maybe+ <span className="faint">{maybeOrBetterCount}</span>
            </button>
            <button
              className={`chip ${filters.showCulled ? "on" : ""}`}
              onClick={() => setFilters((f) => ({ ...f, showCulled: !f.showCulled }))}
            >
              Show culled <span className="faint">{culledIds.length}</span>
            </button>
            <Slots of={FILTER_CHIPS} />
            <input className="find" type="search" placeholder="Find family" value={find} onChange={(e) => setFind(e.target.value)} />
            <label className="ctl" title={activeTurn ? "Vibe results keep Claude's order" : undefined}>
              Sort
              <select
                value={filters.sort}
                disabled={!!activeTurn}
                onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortMode }))}
              >
                {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                  <option key={m} value={m}>
                    {SORT_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            {(filters.sort === "indie" || filters.sort === "shuffle") && !activeTurn && (
              <button title="Reshuffle" onClick={() => setFilters((f) => ({ ...f, seed: f.seed + 1 }))}>
                ⤮ Reshuffle
              </button>
            )}
            <div className="spacer" />
            <span className="faint">{items.length.toLocaleString()} shown</span>
            <button
              disabled={!localFontsSupported}
              title={localFontsSupported ? "Chrome will ask for permission the first time" : "Needs Chrome or another Chromium browser"}
              onClick={store.loadLocalFonts}
            >
              {local.length ? "Reload local fonts" : "Load local fonts"}
            </button>
            {/* Online there is no server to refetch the sources: it only reads the site's font list again. */}
            <button title={STATIC ? "Reload the font list" : "Refetch the catalog (Google, Fontshare, and the saved indie lists)"} onClick={() => store.refreshCatalog(true)}>
              ↻
            </button>
          </div>
        )}
      </header>

      {catalogStatus.error && <div className="notice error">{catalogStatus.error}</div>}
      {catalogStatus.loading && !remote.length && <div className="notice">Loading font catalog…</div>}

      <Slots of={ABOVE_GRID} />
      {view === "grid" && <Slots of={GRID_PANELS} />}
      {/* The grid stays mounted while Compare is shown, only hidden: going back finds every card,
          the page count and the scroll position (scrollMemory.ts) as they were, without drawing
          a thousand cards again or losing the sentinel that loads the next page. */}
      <main
        className="grid"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${colMin}px), 1fr))`,
          ["--card-h" as string]: `${cardHeightLater}px`,
          display: view === "grid" ? undefined : "none",
        }}
        onMouseMove={focusUnderMouse}
      >
        {items.slice(0, limit).map(({ font, number, reason }) => (
          <Card
            key={font.id}
            font={font}
            number={number}
            reason={reason}
            verdict={marks.verdicts[font.id]}
            hasCandidate={candidateFontIds.has(font.id)}
            focused={focusId === font.id}
            onCull={store.cull}
            onMaybe={store.maybe}
            onShortlist={store.shortlist}
            onRestore={store.restore}
          />
        ))}
        {!catalogStatus.loading && !items.length && <div className="notice">No fonts match these filters.</div>}
        <div ref={sentinel} className="sentinel" />
      </main>
      {view === "compare" && <Compare rows={candidateRows} settings={settings} reasons={reasons} onRemove={store.removeCandidate} />}

      <Slots of={OVERLAYS} />

      {toastState && (
        <div className="toast" key={toastState.key}>
          <span>{toastState.text}</span>
          {toastState.undo && <button onClick={toastState.undo}>Undo</button>}
          {toastState.undo && <span className="faint">⌘Z</span>}
          {toastState.action && <button onClick={toastState.action.run}>{toastState.action.label}</button>}
        </div>
      )}
    </div>
  );
}
