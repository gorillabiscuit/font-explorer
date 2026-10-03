import { useEffect, useSyncExternalStore } from "react";
import { formatKeys, isImplemented, KEYMAP, useHotkeys, useModalHotkeys, type HotkeyScope, type KeyBinding } from "./keymap";
import "./keyhelp.css";
import { useBackdropClose, useLockedPage } from "./overlay";

// Open state shared by the overlay and the top-bar button without going through the project store.
let open = false;
const listeners = new Set<() => void>();
function setOpen(next: boolean) {
  open = next;
  listeners.forEach((l) => l());
}
function useOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

const SCOPE_TITLES: Record<HotkeyScope, string> = {
  global: "Everywhere",
  grid: "Grid",
  lightbox: "Lightbox",
  compare: "Compare",
};

/** The '?' overlay: every key in KEYMAP by scope, with keys no feature implements yet greyed out. */
export function KeyHelp() {
  const isOpen = useOpen();
  useHotkeys("global", { help: () => setOpen(!open) });
  // The list covers the page, so X, M and S must not cull or save the focused card behind it, and
  // Space or the wheel must not scroll the grid behind it.
  useModalHotkeys(isOpen);
  useLockedPage(isOpen);
  const backdrop = useBackdropClose(() => setOpen(false));

  // Esc closes the overlay before it can reach the grid (where it would clear the focus).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen]);

  if (!isOpen) return null;
  const scopes = Object.keys(SCOPE_TITLES) as HotkeyScope[];
  return (
    <div className="keyhelp-backdrop" {...backdrop}>
      <div className="keyhelp" role="dialog" aria-label="Keyboard shortcuts">
        <div className="keyhelp-head">
          <strong>Keys</strong>
          <span className="faint">Greyed out: not built yet</span>
          <div className="spacer" />
          <button className="icon-btn" title="Close (Esc)" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="keyhelp-cols">
          {scopes.map((scope) => (
            <section key={scope}>
              <h3>{SCOPE_TITLES[scope]}</h3>
              <dl>
                {(KEYMAP as readonly KeyBinding[])
                  .filter((b) => b.scope === scope)
                  .map((b) => (
                    <div key={b.action} className={isImplemented(b) ? "" : "is-todo"}>
                      <dt>
                        <kbd>{formatKeys(b.keys)}</kbd>
                      </dt>
                      <dd>{b.label}</dd>
                    </div>
                  ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A small '?' in the top bar, for anyone who does not know the key yet. */
export function KeyHelpButton() {
  const isOpen = useOpen();
  return (
    <button className={`toggle ${isOpen ? "on" : ""}`} title="Keyboard shortcuts (?)" onClick={() => setOpen(!open)}>
      ?
    </button>
  );
}
