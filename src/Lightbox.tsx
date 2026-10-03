// The lightbox: one font at a time, large, positive and reversed. The name is held in one place on
// screen (its first line's baseline and its left edge never move), so left and right swap only the
// typeface and every flip works as a flicker comparison. Against the pinned reference, B blinks
// the two in place and O lays the reference over in magenta, with the differences in percent.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AltPicker, useRecipeVariant } from "./AltPicker";
import { choiceToast, currentChoice, nextChoice, withChoice, type AltChoice } from "./alternates";
import { copyDrawnWordmark, hasTextSelection } from "./export/copy";
import { getFacts } from "./facts/index";
import { useFacts } from "./facts/useFacts";
import { borrowedFrom, drawnFace, ensureFace, isFontLoaded, lacksItalic, nearestWeight, type FontVariant } from "./fonts";
import { useWidth } from "./hooks";
import { useHotkeys } from "./keymap";
import type { LayoutResult } from "./layout/types";
import { gridColumns, growLimitFor, nextId, prevId, togglePin, useReveal } from "./nav";
import { FORMATION_ORDER, recipeFromSettings, type Recipe } from "./recipe";
import { parseName, type Settings } from "./settings";
import { useStore, type Pinned } from "./store";
import { TellingLetters } from "./TellingLetters";
import { SOURCE_LABELS, type FontEntry } from "./types";
import { Wordmark } from "./Wordmark";
import "./lightbox.css";

type Mode = "none" | "blink" | "overlay";
const BLINK_MS = 500;
const PRELOAD_AHEAD = 3;
/** Space inside a stage panel, px. */
const PAD_X = 28;
const PAD_Y = 24;
/** Room left above the first font's tallest letters, in Sizes, so a taller face rarely moves the baseline. */
const HEADROOM = 0.2;
/** A Google font's full file (for its alternates) loads once it has been on stage this long, not while flipping past. */
const FULL_FILE_DWELL_MS = 300;

/** What useLoadedFace reports: the face and weight drawn, and how loading went. */
export interface LoadedFace<F extends FontEntry | null> {
  /**
   * The face to draw: the family's italic when one was asked for and it loaded (fonts.ts
   * italicFace), else the font itself. Null only for a null font.
   */
  drawn: F;
  weight: number;
  ready: boolean;
  failed: boolean;
  /** An italic was asked for and the upright is drawn: the family has none, or it would not load. */
  noItalic: boolean;
}

/**
 * Loads a face the way a card does (the nearest weight, or the next nearest when that file fails;
 * the family's italic when `italic` and it has one, else the upright) and reports the face and
 * weight actually drawn. Null font: nothing to load.
 */
export function useLoadedFace<F extends FontEntry | null>(font: F, wanted: number, italic = false): LoadedFace<F> {
  const key = font ? `${font.id}@${wanted}@${italic ? "italic" : "upright"}` : "";
  const [got, setGot] = useState<{ key: string; face: FontEntry | null; weight: number | null } | null>(null);
  useEffect(() => {
    if (!font) return;
    let live = true;
    ensureFace(font, wanted, italic).then((r) => {
      if (live) setGot({ key, face: r?.face ?? null, weight: r?.weight ?? null });
    });
    return () => {
      live = false;
    };
  }, [font, wanted, italic, key]);
  if (!font) return { drawn: font, weight: wanted, ready: false, failed: false, noItalic: false };
  const settled = got?.key === key ? got : undefined;
  // Until the load answers: the italic when the catalogue lists one.
  const drawn = settled?.face ?? drawnFace(font, italic);
  const weight = settled?.weight ?? nearestWeight(drawn, wanted);
  return {
    drawn: drawn as F,
    weight,
    ready: settled?.weight != null || isFontLoaded(drawn, wanted),
    failed: settled !== undefined && settled.weight === null,
    noItalic: lacksItalic(drawn, italic),
  };
}

/**
 * 'italic from Fontshare' when the italic drawn is another source's release of the family (the
 * family's own source has none), so a header never credits the row's source for a file it did not
 * give. Nothing for every other face. The lightbox and Compare's rows both show it.
 */
export function ItalicFromBadge({ font, drawn }: { font: FontEntry; drawn: FontEntry }) {
  const from = borrowedFrom(drawn);
  if (!from) return null;
  return (
    <span className={`badge src-${from}`} title={`${SOURCE_LABELS[font.source]} has no italic of ${font.family}; this one is from ${SOURCE_LABELS[from]}'s release of the family.`}>
      italic from {SOURCE_LABELS[from]}
    </span>
  );
}

/**
 * How the reference is drawn next to another font. It keeps how it was set when pinned (weight,
 * italic, spacing, alternates) and takes the current name, case and layout from the settings, so it is
 * always the same word in the same shape as whatever it is judged against.
 */
export function referenceRecipe(pinned: Pinned, weight: number): Partial<Recipe> {
  return { weight, italic: !!pinned.recipe.italic, tracking: pinned.recipe.tracking, features: pinned.recipe.features };
}

/**
 * The width of the name's letters, for the readout: their glyph ink only (not a container's tile, a
 * descriptor, or Mark's 32 and 16 px copies), scaled back to the size the name was matched at.
 * Block and Mark fit their letters into a tile of one fixed size, so the drawn ink, tile and all,
 * read about the same for every face; undoing that fit, and any shrink to the panel, compares the
 * faces themselves.
 */
function naturalInkWidth(r: LayoutResult): number | undefined {
  const named = r.runs.filter((run) => run.slot !== "descriptor");
  if (!named.length) return undefined;
  // Mark's small copies are runs of the same initials at smaller sizes; the mark itself is the largest.
  const biggest = Math.max(...named.map((run) => run.size));
  const main = named.filter((run) => run.slot !== "initial" || run.size > biggest * 0.99);
  let left = Infinity;
  let right = -Infinity;
  for (const run of main) {
    for (const g of run.glyphs) {
      if (g.missing || g.inkR <= g.inkL) continue;
      left = Math.min(left, g.inkL);
      right = Math.max(right, g.inkR);
    }
  }
  // Stack's Justify Size enlarges the shorter lines; the line at the smallest size was not enlarged.
  const drawnSize = Math.min(...main.map((run) => run.size));
  return right > left && drawnSize > 0 ? ((right - left) * r.fontSize) / drawnSize : undefined;
}

export function Lightbox() {
  const store = useStore();
  const { lightboxOpen: open, setLightboxOpen, items, settings, pinned, byId, marks, candidateFontIds } = store;

  // The font on stage. It starts at the focused card, and the focus comes back to it on close.
  const [cur, setCur] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("none");
  /** Which way the last flip went, so preloading runs ahead in that direction. */
  const [dir, setDir] = useState<1 | -1>(1);
  /** Ink widths from the stage's layouts, per face, for the readout. */
  const [widths, setWidths] = useState<Record<string, number>>({});
  /** Alternates chosen per font while the lightbox is open (features with only alternates in them). */
  const [altFeatures, setAltFeatures] = useState<Record<string, Record<string, 0 | 1>>>({});
  const [wasOpen, setWasOpen] = useState(open);
  // State set during render only shows on the next pass, so this pass carries on with `shown`.
  let shown = cur;
  if (open !== wasOpen) {
    setWasOpen(open);
    shown = open ? (store.focusId ?? items[0]?.font.id ?? null) : null;
    setCur(shown);
    setMode("none");
    setDir(1);
    setWidths({});
    setAltFeatures({});
  }

  // If the font on stage leaves the list some other way, the one that took its place goes on stage.
  const lastIndex = useRef(0);
  let index = shown === null ? -1 : items.findIndex((it) => it.font.id === shown);
  if (open && index < 0 && items.length) index = Math.min(lastIndex.current, items.length - 1);
  const item = open && index >= 0 ? items[index] : undefined;
  if (item && item.font.id !== shown) setCur(item.font.id);
  useEffect(() => {
    if (index >= 0) lastIndex.current = index;
  });
  useEffect(() => {
    if (open && !items.length) setLightboxOpen(false);
  }, [open, items.length, setLightboxOpen]);

  const font = item?.font ?? null;
  // The grid's Italic applies on stage too: the family's italic when it has one (I flips it here as well).
  const face = useLoadedFace(font, settings.weight, settings.italic);
  const refFont = (open && pinned && byId.get(pinned.fontId)) || null;
  // Blink and overlay need a reference. Unpinned (P on it, or the band's ✕), the mode ends too, or
  // the next pin would start straight in it.
  if (!refFont && mode !== "none") setMode("none");
  // The reference keeps the italic it was pinned with, as it keeps its weight.
  const refFace = useLoadedFace(refFont, pinned?.recipe.weight ?? settings.weight, !!pinned?.recipe.italic);
  // The alternates chosen for the font on stage (A, or a click in the picker under the stage), kept
  // per font while the lightbox is open, so flipping back finds them as they were.
  const features = font ? altFeatures[font.id] : undefined;
  const recipe = useMemo<Partial<Recipe>>(() => (features ? { weight: face.weight, features } : { weight: face.weight }), [face.weight, features]);
  const refRecipe = useMemo(() => (pinned ? referenceRecipe(pinned, refFace.weight) : undefined), [pinned, refFace.weight]);
  // A Google family with an alternate on is drawn from its full file, once that has loaded.
  const curVariant = useRecipeVariant(face.drawn, face.weight, features);
  const refVariant = useRecipeVariant(refFace.drawn, refFace.weight, pinned?.recipe.features);

  // Blink: the reference and the font on stage take turns, paused while the tab is hidden.
  const [showRef, setShowRef] = useState(false);
  useEffect(() => {
    setShowRef(false);
    if (mode !== "blink") return;
    const t = window.setInterval(() => {
      if (!document.hidden) setShowRef((v) => !v);
    }, BLINK_MS);
    return () => clearInterval(t);
  }, [mode]);

  // The next few fonts load (and get parsed) before they are flipped to, so a flip never shows a
  // blank frame or a layout that settles a moment later. One goes the other way, for a step back.
  useEffect(() => {
    if (!open || index < 0) return;
    const near = [...Array.from({ length: PRELOAD_AHEAD }, (_, k) => items[index + dir * (k + 1)]), items[index - dir]];
    for (const it of near) {
      if (!it) continue;
      ensureFace(it.font, settings.weight, settings.italic).then((got) => {
        if (got) void getFacts(got.face, got.weight);
      });
    }
  }, [open, index, dir, items, settings.weight, settings.italic]);

  // The grid behind stays mounted at its scroll position: the page itself must not scroll while
  // the lightbox is up (a wheel over it, or the arrow keys the lightbox does not use).
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add("lb-open");
    // Arrow keys belong to whatever has focus; a button clicked before opening would keep them.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return () => root.classList.remove("lb-open");
  }, [open]);

  // Everything behind the lightbox is inert while it is up: Tab cannot reach the top bar (letters
  // typed into the name field there would never reach the lightbox), and nothing behind takes a
  // click. The toast stays live for a verdict's Undo, and so does the key map. Run again when a
  // pin mounts the reference band behind it.
  const dialog = useRef<HTMLDivElement>(null);
  const onStage = font !== null;
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!open || !el?.parentElement) return;
    const behind = [...el.parentElement.children].filter(
      (x): x is HTMLElement => x instanceof HTMLElement && x !== el && !x.inert && !x.matches(".toast, .keyhelp-backdrop"),
    );
    for (const x of behind) x.inert = true;
    return () => {
      for (const x of behind) x.inert = false;
    };
  }, [open, onStage, pinned]);

  const reportWidth = useCallback((key: string, r: LayoutResult) => {
    const w = naturalInkWidth(r);
    if (w === undefined) return;
    setWidths((prev) => (Math.abs((prev[key] ?? -1) - w) < 0.01 ? prev : { ...prev, [key]: w }));
  }, []);
  // By the face drawn, so an italic and its upright are measured apart.
  const curKey = face.drawn ? `${face.drawn.id}@${face.weight}@${JSON.stringify(features ?? {})}` : "";
  const refKey = refFace.drawn ? `${refFace.drawn.id}@${refFace.weight}` : "";
  const onCurLayout = useCallback((r: LayoutResult) => reportWidth(curKey, r), [reportWidth, curKey]);
  const onRefLayout = useCallback((r: LayoutResult) => reportWidth(refKey, r), [reportWidth, refKey]);

  // The picker under the stage lists the options; A steps through the same list. Null while the
  // picker is still finding them (loading Google's full file, checking the sets), with its reason.
  const altChoices = useRef<{ fontId: string; list: AltChoice[] | null; status: string | null } | null>(null);
  const fontId = font?.id ?? null;
  const onChoices = useCallback((list: AltChoice[] | null, status: string | null) => {
    if (fontId) altChoices.current = { fontId, list, status };
  }, [fontId]);
  const onPickAlt = useCallback((next: Record<string, 0 | 1>) => {
    if (fontId) setAltFeatures((prev) => ({ ...prev, [fontId]: next }));
  }, [fontId]);

  const reveal = useReveal();
  const close = () => {
    setLightboxOpen(false);
    if (!font) return;
    growLimitFor(store, index, gridColumns());
    store.setFocus(font.id);
    reveal(font.id);
  };
  const flipTo = (id: string | null, d: 1 | -1) => {
    if (!id) return;
    setCur(id);
    setDir(d);
  };
  /** X, M and S act on the font on stage, then move on. Next is found first: a culled font may leave the list. */
  const verdict = (act: (id: string) => void) => () => {
    if (!font) return false;
    const next = nextId(items, font.id);
    act(font.id);
    if (next) flipTo(next, 1);
  };
  const toggleMode = (m: Mode) => {
    if (!refFont) {
      store.toast("Press P on a font to pin it as the reference");
      return;
    }
    setMode((now) => (now === m ? "none" : m));
  };
  // What S saves and P pins: the exact setting on stage, its alternates included.
  const stageRecipe = (): Recipe => ({ ...recipeFromSettings(settings), features: { ...features } });
  const pin = () => (font ? togglePin(store, font.id, stageRecipe()) : false);
  /** A: default, then each set that changes the name, then all of them, round again. */
  const cycleAlternates = () => {
    if (!font) return false;
    const known = altChoices.current?.fontId === font.id ? altChoices.current : null;
    const list = known?.list;
    if (!list || list.length < 2) store.toast(known?.status ?? "Looking for alternates…");
    else {
      const next = nextChoice(currentChoice(features, list), list);
      onPickAlt(withChoice(features, next));
      store.toast(`${font.family}: ${choiceToast(next)}`, { ms: 1500 });
    }
  };
  useHotkeys("lightbox", {
    flip: (_e, key) => {
      if (!font) return false;
      if (key === "ArrowLeft") flipTo(prevId(items, font.id), -1);
      else flipTo(nextId(items, font.id), 1);
    },
    cull: verdict(store.cull),
    maybe: verdict(store.maybe),
    shortlist: verdict((id) => store.toggleCandidate(id, stageRecipe())),
    pin,
    alternates: cycleAlternates,
    blink: () => toggleMode("blink"),
    overlay: () => toggleMode("overlay"),
    // The layout already chosen keeps its settings object, so nothing behind the lightbox is laid out again.
    layout: (_e, key) => {
      const formation = FORMATION_ORDER[Number(key) - 1];
      if (!formation) return false;
      store.setSettings((s) => (s.layout.formation === formation ? s : { ...s, layout: { ...s.layout, formation } }));
    },
    // ⌘C copies the word on stage as outlines, as the light panel draws it (export/copy.ts).
    copy: () =>
      hasTextSelection() ? false : copyDrawnWordmark(dialog.current?.querySelector(".lb-light .lb-layer .wm-svg"), { ...recipeFromSettings(settings), ...recipe }, store.toast),
    // A held Space or Esc repeats. Only a fresh press closes, so the Space that opened the
    // lightbox cannot close it again while held (the grid ignores the repeats too).
    close: (e) => {
      if (!e.repeat) close();
    },
  });

  if (!open || !font) return null;

  const verdictNow = marks.verdicts[font.id];
  const isRef = pinned?.fontId === font.id;
  const size = Math.max(settings.size * 2, 120);
  const curFace = face.drawn ?? font;
  const layers: Layer[] = [{ key: "cur", font: curFace, recipe, variant: curVariant, pending: !face.ready, look: "shown", onLayout: onCurLayout }];
  if (refFont && refRecipe) {
    // Always laid out, so the stage keeps one height and the readout has its numbers; drawn only
    // when blinking or overlaid.
    const look = mode === "overlay" ? "overlay" : mode === "blink" && showRef ? "shown" : "hidden";
    layers.push({ key: "ref", font: refFace.drawn ?? refFont, recipe: refRecipe, variant: refVariant, pending: !refFace.ready, look, onLayout: onRefLayout });
    if (mode === "blink" && showRef) layers[0] = { ...layers[0], look: "hidden" };
  }
  // Clicking a control must not leave it focused: it would then keep the arrow keys and Space.
  const keepKeys = (e: MouseEvent) => {
    if ((e.target as Element).closest("button, a")) e.preventDefault();
  };

  return (
    <div ref={dialog} className="lightbox" role="dialog" aria-modal="true" aria-label={`Lightbox: ${font.family}`} onMouseDown={keepKeys}>
      <header className="lb-head">
        <button className="icon-btn" title="Previous font (←)" disabled={index === 0} onClick={() => flipTo(prevId(items, font.id), -1)}>
          ‹
        </button>
        <button className="icon-btn" title="Next font (→)" disabled={index === items.length - 1} onClick={() => flipTo(nextId(items, font.id), 1)}>
          ›
        </button>
        <span className="lb-pos">
          {(index + 1).toLocaleString()} / {items.length.toLocaleString()}
        </span>
        {/* The name and badges change with every font, so they get whatever room is left and are
            cut short there. The header must stay one line: if it wrapped, the stage would drop.
            The verdict badges come first, so in a narrow window they are the last to be cut. */}
        <div className="lb-id">
          {font.homepage ? (
            <a className="family" href={font.homepage} target="_blank" rel="noreferrer" title={`${font.family}: open the foundry page`}>
              {font.family} <span className="ext">↗</span>
            </a>
          ) : (
            <span className="family" title={font.family}>
              {font.family}
            </span>
          )}
          {face.failed && <span className="badge warn">failed to load</span>}
          {verdictNow === "cull" && <span className="badge warn">culled</span>}
          {verdictNow === "maybe" && <span className="badge">maybe</span>}
          {candidateFontIds.has(font.id) && <span className="badge lb-star">★ candidate</span>}
          {isRef && <span className="badge lb-ref">reference</span>}
          <span className={`badge src-${font.source}`}>{SOURCE_LABELS[font.source]}</span>
          {/* The italic drawn came from another source's release of the family: the header says so. */}
          <ItalicFromBadge font={font} drawn={curFace} />
          <span className="badge">{font.license}</span>
          <span className={`badge ${face.weight === settings.weight ? "" : "faint"}`} title="The weight drawn">
            {face.weight === settings.weight ? face.weight : `${face.weight} (nearest to ${settings.weight})`}
          </span>
          {face.noItalic && (
            <span className="badge" title="No italic to draw: the family has none, or its italic file would not load. Shown upright, never slanted.">
              no italic
            </span>
          )}
        </div>
        <button className={`toggle ${isRef ? "on" : ""}`} title="Pin or unpin as the reference (P)" onClick={pin}>
          Pin <kbd>P</kbd>
        </button>
        <button className={`toggle ${mode === "blink" ? "on" : ""}`} title="Blink against the reference (B)" onClick={() => toggleMode("blink")}>
          Blink <kbd>B</kbd>
        </button>
        <button className={`toggle ${mode === "overlay" ? "on" : ""}`} title="Overlay the reference (O)" onClick={() => toggleMode("overlay")}>
          Overlay <kbd>O</kbd>
        </button>
        <button className="icon-btn" title="Close (Esc or Space)" onClick={close}>
          ✕
        </button>
      </header>

      <div className="lb-body">
        <div className="lb-stage">
          {[false, true].map((dark) => (
            <Panel key={dark ? "dark" : "light"} dark={dark} layers={layers} settings={settings} size={size} />
          ))}
          {[false, true].map((dark) => (
            <SmallTests key={dark ? "dark-tests" : "light-tests"} dark={dark} font={curFace} settings={settings} weight={face.weight} features={features} variant={curVariant} />
          ))}
        </div>
        {refFont &&
          (isRef ? (
            <div className="lb-readout">This is the reference.</div>
          ) : (
            <Readout font={curFace} weight={face.weight} refFont={refFace.drawn ?? refFont} refWeight={refFace.weight} width={widths[curKey]} refWidth={widths[refKey]} />
          ))}
        <section className="lb-alternates" aria-label="Alternates">
          <span className="lb-alternates-title">
            Alternates <kbd>A</kbd>
          </span>
          {/* An italic has its own alternates, read from its own file. */}
          <AltPicker key={curFace.id} font={curFace} weight={face.weight} settings={settings} features={features} onPick={onPickAlt} delay={FULL_FILE_DWELL_MS} onChoices={onChoices} />
        </section>
        <Telling font={curFace} settings={settings} weight={face.weight} features={features} variant={curVariant} size={Math.round(size * 0.4)} />
      </div>
    </div>
  );
}

interface Layer {
  /** Stays the same across flips, so the Wordmark is updated in place, never remounted. */
  key: "cur" | "ref";
  font: FontEntry;
  recipe: Partial<Recipe>;
  /** 'full' once a Google family's full file is in, for its alternates. */
  variant: FontVariant;
  /** The face is still loading: drawn faint, and not counted when the baseline is fixed. */
  pending: boolean;
  /** 'hidden' is still laid out (the stage keeps its height and anchor), just not drawn. */
  look: "shown" | "hidden" | "overlay";
  onLayout?: (r: LayoutResult) => void;
}

/**
 * One stage panel. Each layer is placed so its first line's baseline sits on one fixed line. That
 * line, and the panel height, only ever grow while the name's shape stays the same, so a taller
 * face never pushes the word down for the fonts after it.
 */
function Panel({ dark, layers, settings, size }: { dark: boolean; layers: Layer[]; settings: Settings; size: number }) {
  const panel = useRef<HTMLDivElement>(null);
  // The width comes from a zero-height strip, not the panel itself: the panel's height is set below
  // while its layers report their sizes, and watching it would answer every such change again.
  const strip = useRef<HTMLDivElement>(null);
  const boxWidth = Math.max(0, Math.floor(useWidth(strip) ?? 0) - 2 * PAD_X);
  const box = useMemo(() => ({ width: boxWidth }), [boxWidth]);
  const shapeKey = JSON.stringify([settings.text, settings.textCase, settings.tracking, settings.layout, size, boxWidth]);
  const held = useRef<{ key: string; baseline: number | null; height: number }>({ key: "", baseline: null, height: 0 });
  const els = useRef(new Map<string, HTMLDivElement>());

  const anchor = useCallback(() => {
    const p = panel.current;
    if (!p) return;
    const h = held.current;
    if (h.key !== shapeKey) Object.assign(h, { key: shapeKey, baseline: null, height: 0 });
    const placed = [...els.current.values()].map((el) => ({ el, offset: baselineOffset(el), ready: el.dataset.ready === "1" }));
    const ready = placed.filter((x) => x.ready);
    if (ready.length) {
      const needed = PAD_Y + Math.max(...ready.map((x) => x.offset));
      h.baseline = h.baseline === null ? needed + size * HEADROOM : Math.max(h.baseline, needed);
    }
    const baseline = h.baseline ?? PAD_Y + size;
    for (const { el, offset, ready: counted } of placed) {
      el.style.top = `${baseline - offset}px`;
      if (counted) h.height = Math.max(h.height, baseline - offset + el.offsetHeight + PAD_Y);
    }
    p.style.minHeight = `${Math.ceil(Math.max(h.height, baseline + PAD_Y))}px`;
  }, [shapeKey, size]);
  useLayoutEffect(anchor);

  // A Wordmark can re-lay itself out without this panel rendering (its font finished loading, its
  // facts arrived): it reports that through onLayout, and a size change shows on the observer. The
  // observer waits a frame: resizing the panel from inside its callback can resize what other
  // observers watch (the lightbox gains a scrollbar), which the browser reports as a loop error.
  const anchorNow = useRef(anchor);
  anchorNow.current = anchor;
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    observer.current = new ResizeObserver(() => requestAnimationFrame(() => anchorNow.current()));
    els.current.forEach((el) => observer.current?.observe(el));
    return () => observer.current?.disconnect();
  }, []);
  const latest = useRef(layers);
  latest.current = layers;
  const handlers = useRef(new Map<string, { ref: (el: HTMLDivElement | null) => void; onLayout: (r: LayoutResult) => void }>());
  const handlersFor = (key: string) => {
    let h = handlers.current.get(key);
    if (!h) {
      h = {
        ref: (el) => {
          const old = els.current.get(key);
          if (old && old !== el) observer.current?.unobserve(old);
          if (el) {
            els.current.set(key, el);
            observer.current?.observe(el);
          } else els.current.delete(key);
        },
        onLayout: (r) => {
          // Only the light panel reports, so each layout is counted once.
          if (!dark) latest.current.find((l) => l.key === key)?.onLayout?.(r);
          anchorNow.current();
          requestAnimationFrame(() => anchorNow.current());
        },
      };
      handlers.current.set(key, h);
    }
    return h;
  };

  return (
    <div ref={panel} className={`lb-panel ${dark ? "lb-dark" : "lb-light"}`} style={{ gridArea: dark ? "dp" : "lp" }}>
      <div ref={strip} className="lb-strip" />
      {boxWidth > 0 &&
        layers.map((l) => {
          const h = handlersFor(l.key);
          return (
            <div key={l.key} ref={h.ref} className={`lb-layer is-${l.look}`} data-ready={l.pending ? "0" : "1"} style={{ left: PAD_X, width: boxWidth }}>
              <Wordmark
                font={l.font}
                settings={settings}
                recipe={l.recipe}
                size={size}
                box={box}
                variant={l.variant}
                className={l.pending ? "is-pending" : undefined}
                onLayout={h.onLayout}
              />
            </div>
          );
        })}
    </div>
  );
}

/**
 * Where the layer's first line sits: px from the layer's top to its baseline. For the SVG wordmark
 * that is the `<text>`'s own y, read through the transform the browser draws it with. Small runs
 * (a descriptor, a mark's mini sizes) are skipped, so the name is what stays put. For text drawn as
 * HTML, a zero-size inline block sits exactly on the line's baseline. A name in a container (Block
 * and Mark's tile) is held by the container's top edge instead: each face sits its letters at its
 * own height inside the tile, so holding the baselines would move the tile itself on every flip,
 * blink and overlay.
 */
function baselineOffset(layer: HTMLElement): number {
  const top = layer.getBoundingClientRect().top;
  // Read from the shape's own attributes: the overlaid layer does not draw its tile (lightbox.css).
  const tile = layer.querySelector(".wm-svg .wm-container");
  const m = tile instanceof SVGGeometryElement ? tile.ownerSVGElement?.getScreenCTM() : null;
  const tileY = tile instanceof SVGRectElement ? tile.y.baseVal.value : tile instanceof SVGEllipseElement ? tile.cy.baseVal.value - tile.ry.baseVal.value : null;
  if (m && tileY !== null) return m.d * tileY + m.f - top;
  const texts = [...layer.querySelectorAll<SVGTextElement>("svg text")];
  if (texts.length) {
    const sizes = texts.map((t) => parseFloat(getComputedStyle(t).fontSize) || 0);
    const big = Math.max(...sizes) * 0.6;
    const text = texts[sizes.findIndex((s) => s >= big)];
    const m = text.getScreenCTM();
    if (m) {
      const first = (list: SVGAnimatedLengthList) => (list.baseVal.numberOfItems ? list.baseVal.getItem(0).value : 0);
      const x = first(text.x);
      const y = first(text.y);
      return m.b * x + m.d * y + m.f - top;
    }
  }
  const host = layer.querySelector(".wordmark") ?? layer;
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  host.appendChild(probe);
  const y = probe.getBoundingClientRect().bottom - top;
  probe.remove();
  return y;
}

/**
 * Room for the small tests. They are shown at their real size; without a box a Wordmark would
 * shrink to the width of its slot (a 16 px favicon tile), which is not the test.
 */
const UNFITTED = { width: 10_000 };

/** The small-size tests under each panel: the name as a 16 px nav logo, and the initial as favicons. */
function SmallTests(p: { dark: boolean; font: FontEntry; settings: Settings; weight: number; features?: Record<string, 0 | 1>; variant: FontVariant }) {
  const { dark, font, settings, weight, features, variant } = p;
  const { text, textCase, layout } = settings;
  const initial = Array.from(parseName({ text: layout.mark.initials.trim() || text, textCase }).flat.trim())[0] ?? "";
  // A nav logo is one line, whatever the main layout, and bare: a container would turn it (and the
  // favicons, which copy this) into a badge. Matching by width needs a box, which a nav slot does
  // not have, so that one falls back to the automatic match. The alternates on stage apply here too.
  const navRecipe = useMemo<Partial<Recipe>>(
    () => ({
      weight,
      ...(features ? { features } : {}),
      layout: { ...layout, formation: "line", breaks: null, match: layout.match === "width" ? "auto" : layout.match, container: { ...layout.container, auto: false, shape: "none" } },
    }),
    [weight, features, layout],
  );
  const iconRecipe = useMemo<Partial<Recipe>>(() => ({ ...navRecipe, text: initial, textCase: "as", tracking: 0 }), [navRecipe, initial]);
  return (
    <div className={`lb-tests ${dark ? "lb-dark" : "lb-light"}`} style={{ gridArea: dark ? "dt" : "lt" }}>
      <div className="lb-nav">
        <Wordmark font={font} settings={settings} recipe={navRecipe} size={16} box={UNFITTED} variant={variant} className="lb-mini" />
        <span className="lb-nav-fake">Product&nbsp;&nbsp;&nbsp;Pricing&nbsp;&nbsp;&nbsp;About</span>
      </div>
      {initial &&
        [16, 32].map((px) => (
          <span key={px} className={`lb-favicon f${px}`} title={`The initial as a ${px} px favicon`}>
            <Wordmark font={font} settings={settings} recipe={iconRecipe} size={Math.round(px * 0.95)} box={UNFITTED} variant={variant} className="lb-mini" />
          </span>
        ))}
    </div>
  );
}

function Telling(p: { font: FontEntry; settings: Settings; weight: number; features?: Record<string, 0 | 1>; variant: FontVariant; size: number }) {
  const slot = useRef<HTMLDivElement>(null);
  const width = Math.floor(useWidth(slot) ?? 0);
  return (
    <div className="lb-telling">
      <div ref={slot}>{width > 0 && <TellingLetters {...p} width={width} />}</div>
    </div>
  );
}

/** 'width +4.2% · cap +0.5% · x-height -3.1%': the font on stage against the reference. */
function Readout(p: { font: FontEntry; weight: number; refFont: FontEntry; refWeight: number; width?: number; refWidth?: number }) {
  const facts = useFacts(p.font, p.weight);
  const refFacts = useFacts(p.refFont, p.refWeight);
  const pct = (a: number, b: number) => {
    const d = (a / b - 1) * 100;
    return `${d < 0 ? "-" : "+"}${Math.abs(d).toFixed(1)}%`;
  };
  const parts: string[] = [];
  if (p.width && p.refWidth) parts.push(`width ${pct(p.width, p.refWidth)}`);
  if (facts && refFacts) parts.push(`cap ${pct(facts.capHeight, refFacts.capHeight)}`, `x-height ${pct(facts.xHeight, refFacts.xHeight)}`);
  const unreadable = p.font.source === "local" || p.refFont.source === "local";
  return (
    <div className="lb-readout">
      <span className="faint">Against {p.refFont.family}:</span>{" "}
      {parts.join(" · ") || (unreadable ? "installed fonts can't be measured yet" : "measuring…")}
    </div>
  );
}
