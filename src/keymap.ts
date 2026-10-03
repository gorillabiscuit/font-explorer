// The canonical key map, and the one window keydown listener that serves it.
//
// A feature implements a key by registering a handler for its action in a component that is
// mounted for the life of the page (even while its scope is inactive):
//
//   useHotkeys("grid", { stress: () => cycleStress() });
//
// Only 'global' and the active scope receive keys. The store sets the active scope: 'lightbox'
// while the lightbox is open, 'compare' in the Compare view, 'grid' otherwise. A handler that
// returns false declines the key (it falls through to the browser), e.g. ⌘C while text is selected.
// An overlay that covers the page calls useModalHotkeys(open), which silences every scope but 'global'.
// Keys that nothing has registered show greyed out in the '?' overlay.
import { useEffect, useRef } from "react";

export type HotkeyScope = "global" | "grid" | "lightbox" | "compare";

export interface KeyBinding {
  scope: HotkeyScope;
  /** 'x', 'Space', 'ArrowLeft', 'Mod+z' (Mod is ⌘ on a Mac, Ctrl elsewhere). Shift is ignored unless named. */
  keys: readonly string[];
  action: string;
  label: string;
  /** Done with the mouse; listed in the overlay, never matched against keys. */
  mouse?: boolean;
}

export const KEYMAP = [
  { scope: "global", keys: ["Mod+z"], action: "undo", label: "Undo the last verdict or candidate change" },
  { scope: "global", keys: ["?"], action: "help", label: "Show or hide this key map" },

  { scope: "grid", keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], action: "move", label: "Move the focus ring" },
  { scope: "grid", keys: ["Home", "End"], action: "jump", label: "First or last card" },
  { scope: "grid", keys: ["x"], action: "cull", label: "Cull, or restore a culled font (moves on)" },
  { scope: "grid", keys: ["m"], action: "maybe", label: "Maybe (moves on)" },
  { scope: "grid", keys: ["s"], action: "shortlist", label: "Save the current settings as a candidate, or remove that candidate (moves on)" },
  { scope: "grid", keys: ["Space", "Enter"], action: "open", label: "Open the lightbox" },
  { scope: "grid", keys: ["p"], action: "pin", label: "Pin or unpin as the reference" },
  { scope: "grid", keys: ["1", "2", "3", "4", "5"], action: "layout", label: "Layout: Line, Stack, Block, Lockup, Mark" },
  { scope: "grid", keys: ["[", "]"], action: "breaks", label: "Previous or next line-break suggestion" },
  { scope: "grid", keys: ["v"], action: "stress", label: "Cycle stress views: squint, small, reversed, pixel" },
  { scope: "grid", keys: ["i"], action: "italic", label: "Italic on or off for every card" },
  { scope: "grid", keys: ["Mod+c"], action: "copy", label: "Copy as outlines (paste into Figma)" },
  { scope: "grid", keys: ["Escape"], action: "clearFocus", label: "Clear the focus" },

  { scope: "lightbox", keys: ["ArrowLeft", "ArrowRight"], action: "flip", label: "Previous or next font" },
  { scope: "lightbox", keys: ["x"], action: "cull", label: "Cull (moves on)" },
  { scope: "lightbox", keys: ["m"], action: "maybe", label: "Maybe (moves on)" },
  { scope: "lightbox", keys: ["s"], action: "shortlist", label: "Save the exact recipe as a candidate (moves on)" },
  { scope: "lightbox", keys: ["p"], action: "pin", label: "Pin or unpin as the reference" },
  { scope: "lightbox", keys: ["b"], action: "blink", label: "Blink against the reference" },
  { scope: "lightbox", keys: ["o"], action: "overlay", label: "Overlay the reference" },
  { scope: "lightbox", keys: ["a"], action: "alternates", label: "Cycle alternates" },
  { scope: "lightbox", keys: ["i"], action: "italic", label: "Italic on or off (the grid's setting)" },
  { scope: "lightbox", keys: ["1", "2", "3", "4", "5"], action: "layout", label: "Layout: Line, Stack, Block, Lockup, Mark" },
  { scope: "lightbox", keys: ["Mod+c"], action: "copy", label: "Copy as outlines" },
  { scope: "lightbox", keys: ["Space", "Escape"], action: "close", label: "Close" },

  { scope: "compare", keys: ["Click"], action: "lineup", label: "Click a letter to line it up across candidates", mouse: true },
  { scope: "compare", keys: ["Escape"], action: "closeLineup", label: "Close the letter lineup" },
] as const satisfies readonly KeyBinding[];

export type HotkeyAction<S extends HotkeyScope> = Extract<(typeof KEYMAP)[number], { scope: S }>["action"];
/** Gets the key spec that matched (e.g. 'ArrowLeft' or '3'). Return false to decline the key. */
export type HotkeyHandler = (e: KeyboardEvent, key: string) => void | boolean;

/** Per `${scope}:${action}`, a stack of handlers; the most recently mounted one wins. */
const registry = new Map<string, HotkeyHandler[]>();
/** Everything that has ever been registered this session: the '?' overlay greys out the rest. */
const everRegistered = new Set<string>();
let activeScope: HotkeyScope = "grid";
let listening = false;
/** Open modal overlays. While one is open only global keys work, so nothing acts on the page behind it. */
let modals = 0;

export function setHotkeyScope(scope: HotkeyScope): void {
  activeScope = scope;
}

/** Call from an overlay that covers the page: while `open`, grid, lightbox and compare keys do nothing. */
export function useModalHotkeys(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    modals++;
    return () => {
      modals--;
    };
  }, [open]);
}

export function isImplemented(b: KeyBinding): boolean {
  return everRegistered.has(`${b.scope}:${b.action}`);
}

export function useHotkeys<S extends HotkeyScope>(scope: S, handlers: Partial<Record<HotkeyAction<S>, HotkeyHandler>>): void {
  // The latest handlers, so callers can pass closures over fresh state without re-registering.
  const latest = useRef(handlers);
  latest.current = handlers;
  const actions = Object.keys(handlers).sort().join(" ");
  useEffect(() => {
    if (!listening) {
      window.addEventListener("keydown", onKeyDown);
      trackClickFocus();
      listening = true;
    }
    const added = actions
      .split(" ")
      .filter(Boolean)
      .map((action) => {
        const id = `${scope}:${action}`;
        const fn: HotkeyHandler = (e, key) => {
          const h = (latest.current as Record<string, HotkeyHandler | undefined>)[action];
          return h ? h(e, key) : false;
        };
        registry.set(id, [...(registry.get(id) ?? []), fn]);
        everRegistered.add(id);
        return [id, fn] as const;
      });
    return () => {
      for (const [id, fn] of added) registry.set(id, (registry.get(id) ?? []).filter((x) => x !== fn));
    };
  }, [scope, actions]);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  for (const b of KEYMAP as readonly KeyBinding[]) {
    if (b.mouse || (b.scope !== "global" && (modals > 0 || b.scope !== activeScope))) continue;
    const key = b.keys.find((k) => matches(e, k));
    if (!key || ownedByTarget(e, key)) continue;
    const handler = registry.get(`${b.scope}:${b.action}`)?.at(-1);
    if (!handler || handler(e, key) === false) continue;
    e.preventDefault();
    return;
  }
}

function matches(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+");
  const key = parts.pop()!;
  const mod = parts.includes("Mod");
  if (mod !== (e.metaKey || e.ctrlKey) || e.altKey !== parts.includes("Alt")) return false;
  // Shift matters for chords (⌘⇧Z is redo, not undo); for single keys it is ignored, so caps lock
  // and '?' (Shift+/ on most layouts) still work.
  if (mod && e.shiftKey !== parts.includes("Shift")) return false;
  const pressed = e.key === " " ? "Space" : e.key;
  return pressed.length === 1 ? pressed.toLowerCase() === key.toLowerCase() : pressed === key;
}

/**
 * The button or link that took the focus from a mouse click. Chrome focuses whatever is clicked, so
 * after clicking a card's star or the Grid tab that control would keep Space, Enter and the arrows,
 * and Space would press the star again on a card the hand has already left. A control reached with
 * the keyboard (Tab) keeps its keys as usual.
 */
let clickFocused: Element | null = null;
let pressedOn: EventTarget | null = null;

function trackClickFocus() {
  window.addEventListener("mousedown", (e) => void (pressedOn = e.target), true);
  // Any key (Tab, or a key that moves the focus itself) means the next focus is the keyboard's.
  window.addEventListener("keydown", () => void (pressedOn = null), true);
  window.addEventListener(
    "focusin",
    (e) => {
      const el = e.target instanceof Element ? e.target : null;
      clickFocused = el && pressedOn instanceof Node && el.contains(pressedOn) ? el : null;
    },
    true,
  );
}

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
/** Keys a focused slider, checkbox, button or link already uses for itself. */
const CONTROL_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Space", "Enter"]);

/**
 * True when the focused element should keep the key: every key while typing in a field or a
 * select, and a control's own keys otherwise. Letter keys still reach the grid after dragging the
 * size slider or clicking a chip, which is where the hand usually is. A button or link that only
 * has the focus because it was clicked gives its keys back too (see clickFocused).
 */
function ownedByTarget(e: KeyboardEvent, key: string): boolean {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable || el.closest("textarea, select")) return true;
  const input = el.closest("input");
  if (input && TEXT_INPUTS.has(input.type)) return true;
  if (input) return CONTROL_KEYS.has(key);
  const control = el.closest("button, a[href], [role='button']");
  return Boolean(control) && control !== clickFocused && CONTROL_KEYS.has(key);
}

/**
 * Keys that end typing in the name field: it lets go of the keyboard, so 1-5, the arrows, X, M and S
 * work straight away instead of typing into the name. Not in KEYMAP, because a text field keeps
 * every key (ownedByTarget): the field handles these itself (App.tsx), and How it works names Enter.
 */
export const DONE_TYPING_KEYS: readonly string[] = ["Enter", "Escape"];

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Space: "Space",
  Enter: "Enter",
  Home: "Home",
  End: "End",
  Click: "Click",
};

/** 'Mod+z' -> '⌘Z' on a Mac, 'Ctrl+Z' elsewhere. */
export function formatKey(spec: string): string {
  const parts = spec.split("+");
  const key = parts.pop()!;
  const name = KEY_NAMES[key] ?? key.toUpperCase();
  const mods = parts.map((m) => (m === "Mod" ? (IS_MAC ? "⌘" : "Ctrl+") : m === "Shift" ? (IS_MAC ? "⇧" : "Shift+") : IS_MAC ? "⌥" : "Alt+"));
  return mods.join("") + name;
}

/** A binding's keys for display, with runs of digits shortened: '1-5'. */
export function formatKeys(keys: readonly string[]): string {
  if (keys.length > 2 && keys.every((k, i) => /^\d$/.test(k) && (i === 0 || Number(k) === Number(keys[i - 1]) + 1))) {
    return `${keys[0]}-${keys.at(-1)}`;
  }
  return keys.map(formatKey).join(" ");
}
