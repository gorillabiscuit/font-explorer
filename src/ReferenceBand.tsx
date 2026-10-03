import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRecipeVariant } from "./AltPicker";
import { useWidth } from "./hooks";
import { referenceRecipe, useLoadedFace } from "./Lightbox";
import { cardEl, revealCard, visibleTop } from "./nav";
import { recipeFromSettings, recipeLabel } from "./recipe";
import type { Settings } from "./settings";
import { useStore, type Pinned } from "./store";
import type { FontEntry } from "./types";
import { Wordmark } from "./Wordmark";
import "./lightbox.css";

/**
 * Block and Mark set the name in a tile about four Sizes tall, and Mark adds 32 and 16 px copies
 * under it. At card size that made the band taller than a row of cards. In those layouts the band
 * holds the drawing to this height (padding included) and leaves out Mark's small copies, which a
 * fixed box skips anyway, so it stays a slim band.
 */
const TILE_BAND_HEIGHT = 120;

/**
 * The pinned reference, kept on screen under the top bar while the grid scrolls, so every card is
 * judged as a challenger to it. It is drawn like a card: the current name and layout, at the
 * grid's size, in the card colours (inverted with the grid). In Block and Mark the tile is held
 * to TILE_BAND_HEIGHT.
 */
export function ReferenceBand() {
  const { pinned, byId, settings, unpin, toast, focusId, lightboxOpen } = useStore();
  const font = pinned && byId.get(pinned.fontId);
  const bandRef = useSteadyGrid(focusId, lightboxOpen);
  if (!pinned || !font) return null;
  const onUnpin = () => {
    unpin();
    toast(`Unpinned ${font.family}`);
  };
  return <Band pinned={pinned} font={font} settings={settings} onUnpin={onUnpin} bandRef={bandRef} />;
}

interface BandProps {
  pinned: Pinned;
  font: FontEntry;
  settings: Settings;
  onUnpin: () => void;
  bandRef: (el: HTMLDivElement | null) => void;
}

function Band({ pinned, font, settings, onUnpin, bandRef }: BandProps) {
  // Pinned in italic, the band draws the family's italic (or its upright, saying so, when it has none).
  const face = useLoadedFace(font, pinned.recipe.weight, !!pinned.recipe.italic);
  const recipe = useMemo(() => referenceRecipe(pinned, face.weight), [pinned, face.weight]);
  // Pinned with an alternate on, a Google family is drawn from its full file once that has loaded.
  const variant = useRecipeVariant(face.drawn, face.weight, pinned.recipe.features);
  const top = useTopbarHeight();
  const slot = useRef<HTMLDivElement>(null);
  const slotWidth = Math.floor(useWidth(slot) ?? 0);

  // At card size: a name too long for a grid column is scaled down in its card, so here it gets the
  // column's width too, not the whole band's, and is scaled the same way.
  const [column, setColumn] = useState(0);
  useLayoutEffect(() => {
    const card = document.querySelector(".grid .card");
    const w = card ? Math.floor(card.getBoundingClientRect().width) : 0;
    setColumn((c) => (c === w ? c : w));
  });
  const width = column ? Math.min(column, slotWidth) : slotWidth;
  const { formation } = settings.layout;
  const tiled = formation === "block" || formation === "mark";
  const box = useMemo(() => (tiled ? { width, height: TILE_BAND_HEIGHT } : { width }), [width, tiled]);

  // What the band draws: the pin's weight, spacing and alternates in the current name, case and
  // layout (referenceRecipe). The label names that, not the case and layout of the moment it was pinned.
  // Without 'Italic' when the upright stands in for an italic that would not load (badged below).
  const label = recipeLabel(font, { ...recipeFromSettings(settings), ...recipe, italic: !!recipe.italic && !face.noItalic });
  return (
    <div ref={bandRef} className="refband" style={{ top }}>
      <div className="refband-label" title={label}>
        <span className="refband-kicker">Reference</span>
        <span className="refband-name">{font.family}</span>
        <span className="refband-recipe">{label.split(" · ").slice(1).join(" · ")}</span>
        {face.noItalic && (
          <span className="badge" title="No italic to draw: the family has none, or its italic file would not load. Shown upright, never slanted.">
            no italic
          </span>
        )}
      </div>
      <div className="refband-mark" ref={slot}>
        {width > 0 && <Wordmark font={face.drawn} settings={settings} recipe={recipe} box={box} variant={variant} className={face.ready ? undefined : "is-pending"} />}
      </div>
      <button className="icon-btn" title="Unpin the reference (or press P on it)" onClick={onUnpin}>
        ✕
      </button>
    </div>
  );
}

/**
 * The band sits in the page flow above the grid, so when it appears, goes or changes height, every
 * card below would jump by as much. Once the page is scrolled down (the band stuck under the top
 * bar, over the grid), the window scrolls by the same amount instead, so the cards stay where the
 * eye is. At the top of the page the band pushes the grid down, as anything in the flow does.
 * Either way, a focused card the change leaves under the band or pushes off the bottom is brought
 * back into sight, because X, M and S only act on a card that can be seen.
 *
 * The grid's move is measured (where it is now against where it was last seen), not taken from the
 * band's height: a browser that anchors the scroll itself (Chrome does, WebKit sometimes) has
 * already held it still, and making up for that a second time would move the cards the other way.
 */
function useSteadyGrid(focusId: string | null, lightboxOpen: boolean): (el: HTMLDivElement | null) => void {
  const now = useRef({ focusId, lightboxOpen });
  now.current = { focusId, lightboxOpen };
  const [steady] = useState(() => steadyGrid(() => now.current));
  useLayoutEffect(() => {
    steady.look();
    window.addEventListener("scroll", steady.onScroll, { passive: true });
    return () => window.removeEventListener("scroll", steady.onScroll);
  }, [steady]);
  return steady.ref;
}

function steadyGrid(context: () => { focusId: string | null; lightboxOpen: boolean }) {
  let band: HTMLDivElement | null = null;
  let observer: ResizeObserver | null = null;
  let height = 0;
  /** The grid's top on screen, as last seen before the band changed. */
  let seen: number | null = null;
  /** Where this code last scrolled to: the browser reports that scroll a frame later, when the band may have changed again. */
  let ownScroll = NaN;

  const look = () => {
    // The grid hidden while Compare shows has no position to hold.
    const grid = document.querySelector(".grid");
    seen = grid?.getClientRects().length ? grid.getBoundingClientRect().top : null;
  };
  const onScroll = () => {
    const mine = window.scrollY === ownScroll;
    ownScroll = NaN;
    if (!mine) look();
  };

  const settle = (next: number) => {
    const change = next - height;
    height = next;
    const before = seen;
    look();
    if (before === null || seen === null || Math.abs(change) < 0.5) return;
    // Of the grid's move on screen, only the band's own share is made up.
    const moved = seen - before;
    const share = change > 0 ? Math.min(Math.max(moved, 0), change) : Math.max(Math.min(moved, 0), change);
    // Stuck: the page was scrolled past where the band sits in the flow, so it covered the grid's top.
    const topbar = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const undo = before < topbar + (next - change) - 0.5 ? share : 0;
    const y = window.scrollY;
    if (undo) window.scrollBy({ top: undo });
    keepFocusInSight(moved - undo, topbar);
    look();
    if (window.scrollY !== y) ownScroll = window.scrollY;
  };

  /** `moved`: how far this change moved the cards on screen; `topbar`: the top bar's bottom edge. */
  const keepFocusInSight = (moved: number, topbar: number) => {
    const { focusId, lightboxOpen } = context();
    const card = focusId && !lightboxOpen ? cardEl(focusId) : null;
    if (!focusId || !card) return;
    const r = card.getBoundingClientRect();
    const underBars = r.top < visibleTop() - 0.5 && r.bottom > topbar;
    const pushedOff = r.top >= window.innerHeight && r.top - moved < window.innerHeight;
    if (underBars || pushedOff) revealCard(focusId);
  };

  const ref = (el: HTMLDivElement | null) => {
    observer?.disconnect();
    observer = null;
    band = el;
    if (el) {
      observer = new ResizeObserver(() => band && settle(band.getBoundingClientRect().height));
      observer.observe(el);
      return;
    }
    // Gone (unpinned, or another view). Settled a frame later, once it has left the page; a band put
    // straight back (React's development double mount) never went.
    requestAnimationFrame(() => {
      if (!band) settle(0);
    });
  };

  return { look, onScroll, ref };
}

/** The sticky top bar's height, which changes as its rows wrap. The band sticks right under it. */
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
