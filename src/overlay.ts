// What an overlay that covers the page (How it works, the '?' key map) needs besides silencing the
// grid's keys (keymap.ts useModalHotkeys): the page behind it holds still, and only a click that both
// starts and ends on the backdrop closes it.
import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

/** Overlays open right now; the page is unlocked when the last one closes. */
let locks = 0;
let before = { overflow: "", gutter: "" };

/**
 * While `open`, the page behind cannot scroll. The wheel, Space, the arrows and End would otherwise
 * move the grid under the overlay, clear the card the mouse was on, and End would load more cards.
 * The overlay scrolls itself. The scrollbar keeps its room, so the page does not shift sideways where
 * scrollbars take space (Windows).
 */
export function useLockedPage(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement.style;
    if (locks++ === 0) {
      before = { overflow: html.getPropertyValue("overflow"), gutter: html.getPropertyValue("scrollbar-gutter") };
      html.setProperty("overflow", "hidden");
      html.setProperty("scrollbar-gutter", "stable");
    }
    return () => {
      if (--locks > 0) return;
      html.setProperty("overflow", before.overflow);
      html.setProperty("scrollbar-gutter", before.gutter);
    };
  }, [open]);
}

/**
 * Props for an overlay's backdrop: a click on it closes the overlay, but only when the press began on
 * the backdrop too. Selecting the overlay's text with a drag that ends outside it also reports a
 * click on the backdrop, and that must leave it open.
 */
export function useBackdropClose(close: () => void) {
  const pressed = useRef<EventTarget | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => void (pressed.current = e.target),
    onClick: (e: MouseEvent) => {
      if (e.target === e.currentTarget && pressed.current === e.currentTarget) close();
    },
  };
}
