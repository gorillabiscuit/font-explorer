// The How it works panel: what the tool is for and the core loop, in a few steps. It opens by itself
// on a visitor's first visit (remembered in this browser), and from the top bar's 'How it works'
// button after that. The words live in helpContent.ts; every key they name is drawn from KEYMAP.
import { Fragment, useEffect, useRef, useSyncExternalStore } from "react";
import { STATIC } from "./env";
import { helpContent, helpProblems, keysOf, type Part } from "./helpContent";
import "./howitworks.css";
import { formatKey, formatKeys, useModalHotkeys } from "./keymap";
import { useBackdropClose, useLockedPage } from "./overlay";
import { useStore } from "./store";

const SEEN_KEY = "fx:how-it-works";

/** True until the panel has been closed once in this browser. Storage that cannot be read means it shows. */
function firstVisit(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== "seen";
  } catch {
    return true;
  }
}

function rememberSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "seen");
  } catch {
    // blocked storage: it shows again next visit, which is all that is lost
  }
}

// Open state shared by the panel and the top-bar button, as KeyHelp keeps its own.
let open = typeof window !== "undefined" && firstVisit();
const listeners = new Set<() => void>();
function setOpen(next: boolean) {
  if (open && !next) rememberSeen();
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

// Said once in the dev console if the words name a key that KEYMAP does not bind that way.
if (import.meta.env.DEV) {
  const problems = helpProblems();
  if (problems.length) console.error(`How it works panel: ${problems.join("; ")}`);
}

export function HowItWorks() {
  const isOpen = useOpen();
  const { remote } = useStore();
  // The panel covers the page, so X, M and S must not cull or save the focused card behind it, and
  // Space, the arrows and the wheel scroll the panel, not the grid behind it.
  useModalHotkeys(isOpen);
  useLockedPage(isOpen);
  const backdrop = useBackdropClose(() => setOpen(false));
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Opened from the keyboard (Tab to the button, then Enter), the focus goes back to that button
    // on close. Opened with the mouse, or by itself on a first visit, it goes back to the page, so
    // the grid's keys work at once (a clicked button gives its keys back to the grid, keymap.ts).
    const opener = document.activeElement;
    const back = opener instanceof HTMLElement && opener !== document.body && opener.matches(":focus-visible") ? opener : null;
    // Focus the panel itself (not the ✕, which would show a focus ring on first paint), so Tab
    // starts inside it and a screen reader reads it.
    panel.current?.focus({ preventScroll: true });
    // Captured, so Esc closes the panel before it reaches the grid (where it would clear the focus).
    // '?' closes it too and goes on to open the key map, which the panel's last line points to.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?") return setOpen(false);
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen) return null;
  // The catalogue's size, rounded ('2,100'); the usual size until it has loaded.
  const fonts = (remote.length >= 100 ? Math.round(remote.length / 100) * 100 : 2100).toLocaleString("en");
  const content = helpContent(fonts);
  return (
    <div className="how-backdrop" {...backdrop}>
      <div
        ref={panel}
        className="how"
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          // Tab stays inside: the page behind cannot be used while the panel is open.
          if (e.key !== "Tab") return;
          e.preventDefault();
          e.currentTarget.querySelector<HTMLElement>(".how-close")?.focus();
        }}
      >
        <div className="how-head">
          <h2 id="how-title">How it works</h2>
          <button className="icon-btn how-close" title="Close (Esc)" aria-label="Close" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <p className="how-intro">
          <Parts parts={content.intro} />
        </p>
        {STATIC && (
          <ul className="how-online">
            {content.onlineOnly.map((line, i) => (
              <li key={i}>
                <Parts parts={line} />
              </li>
            ))}
          </ul>
        )}
        <ol className="how-steps">
          {content.steps.map((step, i) => (
            <li key={i}>
              <Parts parts={step} />
            </li>
          ))}
        </ol>
        <p className="how-outro">
          <Parts parts={content.outro} />
        </p>
      </div>
    </div>
  );
}

/** A sentence from helpContent.ts: words, key caps (from KEYMAP, or the name field's Enter), control names and typed characters. */
function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === "string") return <Fragment key={i}>{part}</Fragment>;
        if ("ui" in part) return <strong key={i}>{part.ui}</strong>;
        if ("typed" in part) return <kbd key={i} className="how-typed">{part.typed}</kbd>;
        if ("field" in part) return <kbd key={i}>{formatKey(part.field)}</kbd>;
        const keys = keysOf(part.keys);
        // A run of digits reads as one cap ('1-5'); anything else gets a cap per key.
        const caps = /^\d$/.test(keys[0] ?? "") && keys.length > 2 ? [formatKeys(keys)] : keys.map(formatKey);
        return (
          <span key={i} className="how-keys" data-binding={`${part.keys.scope}:${part.keys.action}`}>
            {caps.map((cap) => (
              <kbd key={cap}>{cap}</kbd>
            ))}
          </span>
        );
      })}
    </>
  );
}

/** The top bar's way back to the panel, next to the '?' key map. */
export function HowItWorksButton() {
  const isOpen = useOpen();
  return (
    <button className={`toggle how-button ${isOpen ? "on" : ""}`} title="What this tool is for, and how to use it" onClick={() => setOpen(!open)}>
      How it works
    </button>
  );
}
