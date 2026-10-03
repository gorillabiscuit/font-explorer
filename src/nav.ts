// Moving through the grid with the keyboard. The pure helpers at the top walk the store's `items`
// order; the DOM helpers below read the grid the browser actually drew (its column count, what is
// on screen under the sticky bars); useGridNav ties both to the grid's keys.
import { useLayoutEffect, useRef } from "react";
import { recipeFromSettings, type Recipe } from "./recipe";
import { PAGE, useStore, type Item, type ProjectStore } from "./store";

type Ids = readonly Pick<Item, "font">[];

const indexOf = (items: Ids, id: string | null) => (id === null ? -1 : items.findIndex((it) => it.font.id === id));

/** The item after `id`, or null at the end (or when `id` is not in the list). */
export function nextId(items: Ids, id: string | null): string | null {
  const i = indexOf(items, id);
  return i >= 0 && i + 1 < items.length ? items[i + 1].font.id : null;
}

export function prevId(items: Ids, id: string | null): string | null {
  const i = indexOf(items, id);
  return i > 0 ? items[i - 1].font.id : null;
}

/** The card one row up in a grid of `cols` columns, or null on the first row. */
export function idAbove(items: Ids, id: string | null, cols: number): string | null {
  const i = indexOf(items, id);
  return i >= cols ? items[i - cols].font.id : null;
}

/**
 * The card one row down. Below a short last row there may be no card straight down; then the last
 * card is the one below, as in a file browser, so Down always reaches the end.
 */
export function idBelow(items: Ids, id: string | null, cols: number): string | null {
  const i = indexOf(items, id);
  if (i < 0) return null;
  if (i + cols < items.length) return items[i + cols].font.id;
  const lastRow = Math.floor((items.length - 1) / cols);
  return Math.floor(i / cols) < lastRow ? items[items.length - 1].font.id : null;
}

// ---------------------------------------------------------------------------------------------
// The drawn grid

/** Columns the browser laid the grid out in (the template is auto-fill, so only it knows). */
export function gridColumns(grid: Element | null = document.querySelector(".grid")): number {
  if (!grid) return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  return template && template !== "none" ? Math.max(1, template.trim().split(/\s+/).length) : 1;
}

export function cardEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.grid [data-font-id="${CSS.escape(id)}"]`);
}

/**
 * Where the visible part of the page starts: below the sticky top bar and the reference band.
 * A card scrolled under either of them is out of sight, even though it is inside the window.
 */
export function visibleTop(): number {
  let top = 0;
  for (const el of document.querySelectorAll(".topbar, .refband")) top = Math.max(top, el.getBoundingClientRect().bottom);
  return top;
}

/** True when the card is drawn and at least partly on screen, below the sticky bars. */
export function cardInSight(id: string): boolean {
  const card = cardEl(id);
  if (!card) return false;
  const r = card.getBoundingClientRect();
  return r.bottom > visibleTop() && r.top < window.innerHeight;
}

/** The first drawn card that is at least partly on screen, in grid order. */
export function firstCardInSight(): string | null {
  const top = visibleTop();
  for (const card of document.querySelectorAll<HTMLElement>(".grid [data-font-id]")) {
    const r = card.getBoundingClientRect();
    if (r.top >= window.innerHeight) return null;
    if (r.bottom > top) return card.dataset.fontId ?? null;
  }
  return null;
}

const REVEAL_MARGIN = 12;

/**
 * Scrolls just enough to show the whole card below the sticky bars (scrollIntoView would tuck it
 * under them). Instant, so holding an arrow key keeps up. Returns false when the card is not drawn.
 */
export function revealCard(id: string): boolean {
  const card = cardEl(id);
  if (!card) return false;
  const r = card.getBoundingClientRect();
  const top = visibleTop() + REVEAL_MARGIN;
  const bottom = window.innerHeight - REVEAL_MARGIN;
  // A card taller than the visible area shows its top, where the wordmark is.
  if (r.top < top) window.scrollBy({ top: r.top - top });
  else if (r.bottom > bottom) window.scrollBy({ top: Math.min(r.bottom - bottom, r.top - top) });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Keys

/** P everywhere: pin the font as the reference, or unpin it when it already is the reference. */
export function togglePin(store: ProjectStore, fontId: string, recipe: Recipe): void {
  const name = store.byId.get(fontId)?.family ?? fontId;
  if (store.pinned?.fontId === fontId) {
    store.unpin();
    store.toast(`Unpinned ${name}`);
  } else {
    store.pin(fontId, recipe);
    store.toast(`Pinned ${name} as the reference`);
  }
}

/**
 * Makes sure the grid draws the item at `index`: the grid renders only the first `limit` items, so
 * the limit grows by PAGE once the focus comes within a row of it, and jumps past a far target (End).
 */
export function growLimitFor(store: Pick<ProjectStore, "limit" | "setLimit" | "items">, index: number, cols: number): void {
  if (index < store.limit - cols) return;
  const wanted = Math.min(store.items.length, Math.max(store.limit + PAGE, Math.ceil((index + cols + 1) / PAGE) * PAGE));
  if (wanted > store.limit) store.setLimit((l) => Math.max(l, wanted));
}

/**
 * Reveals a card after the holder's next render, before paint. A verdict or a grown limit changes
 * the grid first (a culled card leaves, the next one slides into its place, new cards get drawn),
 * so the scroll has to be worked out on the grid as it will be, not as it was.
 */
export function useReveal(): (id: string) => void {
  const pending = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = pending.current;
    pending.current = null;
    if (id) revealAndSettle(id);
  });
  return (id: string) => {
    pending.current = id;
  };
}

/** Counts reveals, so one still settling knows when a newer one (from any component) has taken over. */
let revealCount = 0;
/** How long a reveal keeps its card in sight while the grid settles, counted from the first frame drawn. */
const SETTLE_MS = 2000;
/** The user taking over: a wheel, a touch, a click (the scrollbar too) or any key. */
const SETTLE_ENDS_ON = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Reveals the card, then keeps it revealed while the grid settles. Cards skipped by
 * content-visibility get their real height only once drawn, and drawn cards change height again
 * when their fonts arrive, so after a long jump (End, or closing the lightbox far down the list)
 * the cards above the target keep pushing it down for a second or so. Each change in the grid's
 * height reveals it again (which does nothing while it is in sight), until the time is up, a newer
 * reveal takes over, the focus moves to another card, or the user scrolls, clicks or presses a key.
 */
export function revealAndSettle(id: string): void {
  const mine = ++revealCount;
  revealCard(id);
  const grid = document.querySelector(".grid");
  if (!grid) return;
  let done = false;
  let first = 0;
  const stop = () => {
    done = true;
    observer.disconnect();
    for (const type of SETTLE_ENDS_ON) window.removeEventListener(type, stop, true);
  };
  // The correction waits for the next frame: scrolling from inside the observer draws more cards,
  // which resize the grid again in the same frame, and the browser reports that as a loop error.
  const observer = new ResizeObserver(() =>
    requestAnimationFrame(() => {
      const card = cardEl(id);
      if (done) return;
      if (mine !== revealCount || (card && !card.classList.contains("is-focused"))) stop();
      else revealCard(id);
    }),
  );
  // The time is counted in drawn frames, not from now: a jump to the end draws thousands of cards,
  // and that one long frame must not use it up before the first correction.
  const afterFrame = () => {
    if (done) return;
    const now = performance.now();
    first ||= now;
    if (now - first > SETTLE_MS) stop();
    else requestAnimationFrame(afterFrame);
  };
  for (const type of SETTLE_ENDS_ON) window.addEventListener(type, stop, { capture: true, passive: true });
  observer.observe(grid);
  requestAnimationFrame(afterFrame);
}

/**
 * The grid's arrow, Home, End, Space and P keys, and the move-on that follows X, M and S.
 * Handlers return false when there is nothing to act on, so the key keeps its browser default.
 */
export function useGridNav() {
  const store = useStore();
  const { items, focusId, setFocus, settings } = store;
  const reveal = useReveal();

  const go = (id: string | null, cols = gridColumns()) => {
    if (!id) return;
    // Already focused (Home on the first card): nothing re-renders, so reveal it now.
    if (id === focusId) {
      revealAndSettle(id);
      return;
    }
    growLimitFor(store, indexOf(items, id), cols);
    setFocus(id);
    reveal(id);
  };

  return {
    /**
     * Arrow keys. With no focus on screen (nothing pointed at yet, or the focused card scrolled
     * away), the first key focuses the first card in sight instead of jumping back to an old place.
     */
    move: (_e: KeyboardEvent, key: string) => {
      if (!items.length) return false;
      if (!focusId || !cardInSight(focusId)) {
        const first = firstCardInSight();
        if (!first) return false;
        setFocus(first);
        return;
      }
      const cols = gridColumns();
      const target =
        key === "ArrowLeft"
          ? prevId(items, focusId)
          : key === "ArrowRight"
            ? nextId(items, focusId)
            : key === "ArrowUp"
              ? idAbove(items, focusId, cols)
              : idBelow(items, focusId, cols);
      go(target, cols);
    },
    /** Home and End: the first or last card of the whole list. */
    jump: (_e: KeyboardEvent, key: string) => {
      if (!items.length) return false;
      go(key === "Home" ? items[0].font.id : items[items.length - 1].font.id);
    },
    open: (id: string) => {
      setFocus(id);
      store.setLightboxOpen(true);
    },
    pin: (id: string) => togglePin(store, id, recipeFromSettings(settings)),
    /**
     * Wraps a verdict so the focus moves on to the next card. The next card is found before the
     * verdict, because a culled card leaves `items` when culls are hidden. On the last card the
     * focus stays, and the store hands it to the new last card if this one left the list.
     */
    advancing: (act: (id: string) => void) => (id: string) => {
      const next = nextId(items, id);
      act(id);
      go(next);
    },
  };
}
