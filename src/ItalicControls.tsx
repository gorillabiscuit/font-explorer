// Italic: the top-bar switch (and the I key) that sets every card in its family's real italic, and
// the 'Has italic' filter chip, shown while Italic is on. Mounted through slots.tsx. Which face a
// card draws is decided where it loads (fonts.ts ensureFace); a family without an italic stays
// upright and its card says 'no italic' (card/NoItalicBadge.tsx).
import { useMemo } from "react";
import { hasItalic } from "./italic";
import { useHotkeys } from "./keymap";
import { useStore } from "./store";

export function ItalicToggle() {
  const { settings, setSettings, toast } = useStore();
  const set = (italic: boolean) => setSettings((s) => (s.italic === italic ? s : { ...s, italic }));
  // The key says what it did: in the lightbox the switch itself is out of sight.
  const flip = () => {
    set(!settings.italic);
    toast(settings.italic ? "Italic off" : "Italic on: each family's own italic, where it has one", { ms: 1500 });
  };
  useHotkeys("grid", { italic: flip });
  useHotkeys("lightbox", { italic: flip });
  return (
    <button
      className={`toggle ${settings.italic ? "on" : ""}`}
      aria-pressed={settings.italic}
      title="Set every card in its family's real italic (I). A family without one stays upright and says 'no italic'; nothing is slanted to fake one."
      onClick={() => set(!settings.italic)}
    >
      Italic
    </button>
  );
}

/** 'Has italic': only families whose catalogue entry lists a real italic. Installed fonts are hidden by it. */
export function HasItalicChip() {
  const { settings, filters, setFilters, all } = useStore();
  const count = useMemo(() => all.filter(hasItalic).length, [all]);
  if (!settings.italic) return null;
  return (
    <button
      className={`chip ${filters.hasItalic ? "on" : ""}`}
      title="Only families with a real italic. Installed fonts are hidden too: whether one is installed in italic is unknown."
      onClick={() => setFilters((f) => ({ ...f, hasItalic: !f.hasItalic }))}
    >
      Has italic <span className="faint">{count}</span>
    </button>
  );
}
