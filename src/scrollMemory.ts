// Each vibe chip, and All fonts, keeps its own scroll position and page count, so flipping between
// Claude's results and the full grid lands back on the card you left. A filter or Find change starts
// the list over: back to the top, and every remembered position is dropped, because each one points
// into a list that no longer exists. Switching projects changes the filters too, so it starts over.
// Compare is shown over a hidden grid; going back to the grid returns to where it was left.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Filters } from "./settings";
import type { View } from "./store";

interface Spot {
  scrollY: number;
  limit: number;
}

/** How long a restore keeps re-applying its position while the cards settle to their real height. */
const SETTLE_MS = 600;
/** Any of these means the user is scrolling or acting, which ends a restore at once. */
const USER_INPUT = ["wheel", "keydown", "pointerdown", "touchstart"] as const;

export function useScrollMemory(args: {
  activeVibe: string | null;
  filters: Filters;
  find: string;
  limit: number;
  setLimit: (n: number) => void;
  page: number;
  view: View;
}): void {
  const { activeVibe, filters, find, limit, setLimit, page, view } = args;
  const memory = useRef(new Map<string | null, Spot>()).current;
  // Read from scroll events, not at the switch: by then the new list may already have clamped scrollY.
  const lastScrollY = useRef(0);
  const before = useRef({ activeVibe, filters, find, limit });
  const restore = useRef<Spot | null>(null);
  /** Stops a restore that is still settling. */
  const stopSettling = useRef(() => {});

  useEffect(() => {
    lastScrollY.current = window.scrollY;
    const onScroll = () => (lastScrollY.current = window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      stopSettling.current();
    };
  }, []);

  // Layout effects, so the jump happens before the new list is painted.
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = { activeVibe, filters, find, limit };
    if (prev.filters !== filters || prev.find !== find) {
      stopSettling.current();
      memory.clear();
      restore.current = null;
      setLimit(page);
      window.scrollTo({ top: 0 });
      lastScrollY.current = 0;
    } else if (prev.activeVibe !== activeVibe) {
      stopSettling.current();
      memory.set(prev.activeVibe, { scrollY: lastScrollY.current, limit: prev.limit });
      restore.current = memory.get(activeVibe) ?? { scrollY: 0, limit: page };
      setLimit(restore.current.limit);
    }
  }, [activeVibe, filters, find, limit, setLimit, page]);

  // Compare's page is shorter, so the window scroll is clamped while it shows; the grid's own
  // position is kept aside and put back on the way back, before the grid is painted.
  const gridScrollY = useRef(0);
  const viewBefore = useRef(view);
  useLayoutEffect(() => {
    const prev = viewBefore.current;
    viewBefore.current = view;
    if (prev === view) return;
    if (prev === "grid") {
      stopSettling.current();
      gridScrollY.current = lastScrollY.current;
    } else if (view === "grid") {
      stopSettling.current = scrollAndSettle(gridScrollY.current, () => (lastScrollY.current = window.scrollY));
    }
  }, [view]);

  // Scroll once at least the remembered number of cards is drawn, or the page would be too short to
  // get there. (The grid's own paging may already have added a page on top.)
  useLayoutEffect(() => {
    const spot = restore.current;
    if (!spot || limit < spot.limit) return;
    restore.current = null;
    stopSettling.current = scrollAndSettle(spot.scrollY, () => (lastScrollY.current = window.scrollY));
  });
}

/**
 * Scrolls to `top`, then keeps re-applying it on the next frames until it holds or SETTLE_MS pass.
 * Cards below the fold start at an estimated height and grow as their wordmarks measure, so right
 * after a switch the page can be too short to reach a spot near its end, and the browser stops
 * short. That bites most in a vibe chip, whose short list of results is often looked through to
 * the bottom. The user's own wheel, key, click or touch ends it at once. Returns a stop function.
 */
function scrollAndSettle(top: number, onScrolled: () => void): () => void {
  const reached = () => Math.abs(window.scrollY - top) < 1;
  window.scrollTo({ top });
  onScrolled();
  if (reached()) return () => {};
  const until = performance.now() + SETTLE_MS;
  let frame = requestAnimationFrame(function again() {
    window.scrollTo({ top });
    onScrolled();
    if (reached() || performance.now() > until) return stop();
    frame = requestAnimationFrame(again);
  });
  function stop() {
    cancelAnimationFrame(frame);
    USER_INPUT.forEach((type) => window.removeEventListener(type, stop, true));
  }
  USER_INPUT.forEach((type) => window.addEventListener(type, stop, { capture: true, passive: true }));
  return stop;
}
