// The small menus that hang off the top bar (projects, brief) close on a click outside them or on
// Esc. While one is open the grid's letter keys do nothing, so a stray X never culls a card behind it.
import { useEffect, useRef, type RefObject } from "react";
import { useModalHotkeys } from "./keymap";

export function usePopover(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>): void {
  useModalHotkeys(open);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose.current();
    };
    // Capture, so Esc closes the menu before the grid sees it (where it would clear the focus).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, ref]);
}
