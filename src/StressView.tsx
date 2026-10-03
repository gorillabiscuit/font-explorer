// The grid's stress views (V cycles them): every card's wordmark squinted at, set small, reversed,
// or drawn as real pixels at 16 px, so a weak silhouette goes early in the cull. Card wraps its
// Wordmark in StressView and nothing else changes: each mode works from the layout the Wordmark
// reports through onLayout, so no text is measured or positioned here.
import { cloneElement, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { fontStack, fontStyle } from "./fonts";
import { peekInView, useInView, useWidth } from "./hooks";
import { useHotkeys } from "./keymap";
import { DEFAULT_PAD } from "./layout/engine";
import type { ContainerShape, LayoutResult, Rect, Run } from "./layout/types";
import "./compare.css";
import type { Formation, Recipe } from "./recipe";
import { STRESS_MODES, type StressMode } from "./settings";
import { useStore } from "./store";
import { NEAR, Wordmark, type WordmarkProps } from "./Wordmark";

export const STRESS_LABELS: Record<StressMode, string> = {
  off: "Off",
  squint: "Squint",
  small: "Small",
  reversed: "Reversed",
  pixel: "Pixel",
};

/** Squint blurs by this share of the cap height: enough to lose the details, keep the silhouette. */
const SQUINT = 0.06;
/** Small: the whole drawing this many px tall, in one row under the card's wordmark. */
const SMALL_HEIGHTS = [24, 16, 12];
/** Pixel: the drawing this many px tall, shown at up to this many screen px per pixel. */
const PIXEL_HEIGHT = 16;
const PIXEL_ZOOM = 4;
/** The small tests are set at their real size, never shrunk to a slot (as in the lightbox). */
const UNFITTED = { width: 10_000 };
const HATCH = "#e5484d";
/** Capitals whose tops sit on the cap height: no apex, no overshoot. */
const FLAT_TOPPED = /[BDEFHIKLMNPRTUXZ]/;

/**
 * The cap height as drawn, in px. Measured from the flat-topped capitals of the name's largest
 * runs; a name without any (all lowercase) uses a typical face's 0.7 em at that size.
 */
function capHeightPx(r: LayoutResult): number {
  const size = Math.max(0, ...r.runs.map((run) => run.size));
  const tops: number[] = [];
  for (const run of r.runs) {
    if (run.size < 0.9 * size) continue; // a descriptor or a mark's mini sizes
    for (const g of run.glyphs) if (!g.missing && FLAT_TOPPED.test(g.char)) tops.push(run.y - g.inkT);
  }
  if (!tops.length) return 0.7 * size;
  tops.sort((a, b) => a - b);
  return tops[Math.floor(tops.length / 2)];
}

/** A blur of SQUINT cap heights, in px. */
export function squintBlur(r: LayoutResult): number {
  return Math.round(SQUINT * capHeightPx(r) * 100) / 100;
}

/** The squint blur with no real layout to measure: a typical face's cap height (0.7 em) at that Size. */
export function typicalSquintBlur(size: number): number {
  return Math.round(SQUINT * 0.7 * size * 100) / 100;
}

/** The one number squint and small take from a layout: the blur, or the ink height undone of any shrink to fit. */
function readout(mode: "squint" | "small", r: LayoutResult): number {
  return mode === "squint" ? squintBlur(r) : Math.round((r.ink.h / (r.scale || 1)) * 100) / 100;
}

interface Props {
  mode: StressMode;
  /** The card's Wordmark. Its onLayout, if any, still gets every layout. */
  children: ReactElement<WordmarkProps>;
}

export function StressView({ mode, children }: Props) {
  // The latest real layout. Kept without a re-render while the view is off, so turning a mode on
  // across the grid costs no extra renders until then.
  const last = useRef<LayoutResult | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // What squint or small took from the layout when they last rendered. A report that would not
  // change it renders nothing: while a hundred cards load, each render here starts another round of
  // effects, and React's development build warns about the chain.
  const shown = useRef<number | null>(null);
  // Pixel mode draws each new layout straight onto its canvas, with no render in between.
  const pixelDraw = useRef<(() => void) | null>(null);
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const theirs = useRef(children.props.onLayout);
  theirs.current = children.props.onLayout;
  const onLayout = useCallback((r: LayoutResult) => {
    last.current = r;
    theirs.current?.(r);
    const m = modeNow.current;
    if (m === "pixel") pixelDraw.current?.();
    else if ((m === "squint" || m === "small") && readout(m, r) !== shown.current) redraw();
  }, []);
  const wordmark = cloneElement(children, { onLayout });
  const layout = last.current;
  useLayoutEffect(() => {
    shown.current = layout && (mode === "squint" || mode === "small") ? readout(mode, layout) : null;
  });

  let style: CSSProperties | undefined;
  if (mode === "squint") {
    // Until the real layout is in, a typical face's cap height at the matched size.
    const blur = layout ? squintBlur(layout) : typicalSquintBlur(children.props.size ?? children.props.settings.size);
    style = { ["--stress-blur" as string]: `${blur}px` };
  }
  return (
    <div className={`stress stress-${mode}`} style={style}>
      {wordmark}
      {mode === "small" && layout && <SmallRow wordmark={children.props} layout={layout} />}
      {mode === "pixel" && <Pixels latest={last} draws={pixelDraw} wordmark={children.props} />}
    </div>
  );
}

/**
 * The same name and layout at 24, 16 and 12 px tall. Each is real text at its real size, set by
 * the engine like every other wordmark; only its Size is chosen, from the card's own layout, so
 * the whole drawing comes out that tall.
 */
function SmallRow({ wordmark, layout }: { wordmark: WordmarkProps; layout: LayoutResult }) {
  const { settings, recipe } = wordmark;
  const shape = recipe?.layout ?? settings.layout;
  // Matching by width needs a box, and these are set unfitted: they match like Auto instead.
  const small = useMemo<Partial<Recipe> | undefined>(
    () => (shape.match === "width" ? { ...recipe, layout: { ...shape, match: "auto" } } : recipe),
    [recipe, shape],
  );
  // Ink height per unit of Size, from the card's layout (undone of any shrink to fit the card).
  const S = wordmark.size ?? settings.size;
  const perSize = shape.match !== "width" && layout.ink.h > 0 && S > 0 ? layout.ink.h / (layout.scale || 1) / S : 0;

  // Set only while the card is near the screen, like its wordmark (NEAR). The grid never unmounts a
  // card, so three more wordmarks on every card ever drawn froze the page for a second each time
  // V reached Small. The card is found after mounting and asked at once (before paint) where it
  // was last seen, so the cards on screen show their row in the same frame. Away from the screen
  // the row keeps its last height.
  const own = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<Element | null>(null);
  useLayoutEffect(() => setCard(own.current?.closest(".card") ?? own.current), []);
  const watched = useMemo(() => ({ current: card }), [card]);
  const near = useInView(watched, NEAR);
  const show = card !== null && (near || peekInView(card, NEAR) === true);
  const height = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (show && own.current) height.current = own.current.offsetHeight;
  });
  return (
    <div ref={own} className="stress-small-row" style={show || height.current === null ? undefined : { height: height.current }}>
      {show &&
        SMALL_HEIGHTS.map((px) => <SmallAt key={px} px={px} guess={perSize ? px / perSize : px} wordmark={wordmark} recipe={small} />)}
    </div>
  );
}

/**
 * One small test. The Size comes from the card's layout. A layout that still comes out off (a width
 * match is set as Auto here) is corrected from its own numbers: the callback carries the Size its
 * layout was made at, so a late report can never compound a correction.
 */
function SmallAt({ px, guess, wordmark, recipe }: { px: number; guess: number; wordmark: WordmarkProps; recipe: Partial<Recipe> | undefined }) {
  const [fixed, setFixed] = useState<{ guess: number; size: number; tries: number } | null>(null);
  const current = fixed?.guess === guess ? fixed : null;
  const size = Math.max(1, current?.size ?? guess);
  const tries = current?.tries ?? 0;
  const onLayout = useCallback(
    (r: LayoutResult) => {
      if (r.ink.h <= 0 || tries >= 3) return;
      const needed = (size * px) / r.ink.h;
      if (Math.abs(needed / size - 1) > 0.01) setFixed({ guess, size: needed, tries: tries + 1 });
    },
    [px, size, guess, tries],
  );
  return (
    <span className="stress-small-item" title={`${px} px tall`}>
      <Wordmark font={wordmark.font} settings={wordmark.settings} recipe={recipe} size={size} box={UNFITTED} variant={wordmark.variant} className="stress-mini" onLayout={onLayout} />
      <span className="stress-small-label">{px}</span>
    </span>
  );
}

/**
 * The layout drawn with canvas fillText at 16 px tall, one canvas pixel per screen pixel, then
 * shown enlarged with hard pixel edges. Each letter goes where the layout put it. Canvas cannot
 * switch on OpenType features, so alternates show their default glyphs here. Only cards near the
 * screen draw; the rest keep their space.
 */
function Pixels({ latest, draws, wordmark }: { latest: { current: LayoutResult | null }; draws: { current: (() => void) | null }; wordmark: WordmarkProps }) {
  // Everything is found from this component's own element. On a card's first mount (every reload,
  // every card added by scrolling) this layout effect runs before React attaches the wrapper's ref,
  // but after it attaches the refs of elements rendered here.
  const own = useRef<HTMLDivElement>(null);
  // Inside a card, watch the card: content-visibility skips its contents while it is far away, and
  // skipped elements report no position to an IntersectionObserver.
  const watched = useRef<Element | null>(null);
  useLayoutEffect(() => {
    watched.current = own.current?.closest(".card") ?? own.current;
  }, []);
  const inView = useInView(watched, "200px 0px");
  // The room inside this element's padding (the wordmark's own 18 px).
  const width = useWidth(own);
  const canvas = useRef<HTMLCanvasElement>(null);
  const family = fontStack(wordmark.font, wordmark.variant);
  // An italic face shares its upright's family name: the style is what picks it.
  const style = fontStyle(wordmark.font);
  const invert = wordmark.settings.invert;
  const formation = (wordmark.recipe?.layout ?? wordmark.settings.layout).formation;

  const draw = () => {
    const c = canvas.current;
    const el = own.current;
    const layout = latest.current;
    if (!c || !el || !layout || !inView) return;
    const css = getComputedStyle(el);
    const drawn = drawPixels(c, layout, formation, family, style, css.color, css.getPropertyValue("--card").trim() || "#fff");
    if (!drawn) return;
    const room = width ?? el.clientWidth - 2 * DEFAULT_PAD;
    const zoom = Math.max(1, Math.min(PIXEL_ZOOM, Math.floor(room / c.width)));
    c.style.width = `${c.width * zoom}px`;
    c.style.height = `${c.height * zoom}px`;
  };
  // A new layout report draws with this render's view of the card.
  useLayoutEffect(() => {
    draws.current = draw;
  });
  useLayoutEffect(
    () => () => {
      draws.current = null;
    },
    [draws],
  );
  // Coming into view, or a change to how the card looks, draws the latest layout again.
  useEffect(() => draw(), [inView, family, style, invert, width, formation]);

  return (
    <div ref={own} className="stress-pixels" style={{ minHeight: (PIXEL_HEIGHT + 2) * PIXEL_ZOOM + 2 * DEFAULT_PAD }}>
      <canvas ref={canvas} className="stress-canvas" width={0} height={0} />
    </div>
  );
}

/**
 * What pixel mode draws: the whole layout, except Mark's row of 32 and 16 px copies under its tile.
 * Those are small-size tests of their own, and fitting them into the same 16 px would shrink the tile.
 */
function pixelPart(r: LayoutResult, formation: Formation): { runs: Run[]; missing: Rect[]; frame: Rect } {
  if (formation !== "mark") return { runs: r.runs, missing: r.missing, frame: r.ink };
  const size = Math.max(0, ...r.runs.map((run) => run.size));
  const runs = r.runs.filter((run) => run.size >= 0.9 * size);
  let frame: Rect | null = r.container ?? null;
  if (!frame) {
    const glyphs = runs.flatMap((run) => run.glyphs).filter((g) => g.inkR > g.inkL);
    if (!glyphs.length) return { runs: r.runs, missing: r.missing, frame: r.ink };
    const x = Math.min(...glyphs.map((g) => g.inkL));
    const y = Math.min(...glyphs.map((g) => g.inkT));
    frame = { x, y, w: Math.max(...glyphs.map((g) => g.inkR)) - x, h: Math.max(...glyphs.map((g) => g.inkB)) - y };
  }
  const bottom = frame.y + frame.h;
  return { runs, missing: r.missing.filter((m) => m.y < bottom), frame };
}

/** Draws the layout at PIXEL_HEIGHT px tall. False when there is nothing to draw. */
function drawPixels(c: HTMLCanvasElement, r: LayoutResult, formation: Formation, family: string, style: "normal" | "italic", ink: string, paper: string): boolean {
  const { runs, missing, frame } = pixelPart(r, formation);
  if (frame.h <= 0 || frame.w <= 0) return false;
  const k = PIXEL_HEIGHT / frame.h;
  c.width = Math.ceil(frame.w * k) + 2;
  c.height = PIXEL_HEIGHT + 2;
  const ctx = c.getContext("2d");
  if (!ctx) return false;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(1, 0, 0, 1, 1 - frame.x * k, 1 - frame.y * k);
  ctx.textBaseline = "alphabetic";
  ctx.fontKerning = "none"; // the layout's positions already carry the kerning
  // A filled container is drawn in ink, so the letters on it take the paper colour (as in Wordmark).
  if (r.container) drawContainer(ctx, r.container, k, ink);
  ctx.fillStyle = r.container?.style === "fill" ? paper : ink;
  for (const run of runs) {
    ctx.font = `${style === "italic" ? "italic " : ""}${run.weight} ${run.size * k}px ${family}`;
    ctx.globalAlpha = run.placeholder ? 0.35 : 1;
    for (const cell of cellsOf(run.glyphs)) ctx.fillText(cell.text, cell.x * k, run.y * k);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = HATCH;
  for (const m of missing) ctx.fillRect(m.x * k, m.y * k, m.w * k, m.h * k);
  return true;
}

function drawContainer(ctx: CanvasRenderingContext2D, s: ContainerShape, k: number, ink: string) {
  const [x, y, w, h] = [s.x * k, s.y * k, s.w * k, s.h * k];
  ctx.beginPath();
  if (s.shape === "circle") ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (s.shape === "pill" || s.shape === "rounded") ctx.roundRect(x, y, w, h, s.shape === "pill" ? Math.min(w, h) / 2 : s.rx * k);
  else ctx.rect(x, y, w, h);
  if (s.style === "fill") {
    ctx.fillStyle = ink;
    ctx.fill();
    return;
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = s.style === "keyline" ? Math.max(1, s.stroke * k) : 1;
  ctx.globalAlpha = s.style === "guide" ? 0.35 : 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** The run cut into the pieces the layout placed: a glyph that moves the pen, plus any accent after it. */
function cellsOf(glyphs: LayoutResult["runs"][number]["glyphs"]): { x: number; text: string }[] {
  const cells: { x: number; text: string }[] = [];
  for (const g of glyphs) {
    const cell = cells[cells.length - 1];
    if (cell && (Math.abs(g.w) < 0.01 || !g.char)) cell.text += g.char;
    else cells.push({ x: g.x, text: g.char });
  }
  return cells.map((c) => ({ ...c, text: c.text.normalize("NFC") })).filter((c) => c.text.trim());
}

/**
 * V and the chip in the filter row. The chip names the view that is on and turns it off; while
 * stress is off it offers the first view. X, M and S keep working in every view.
 */
export function StressChip() {
  const { settings, setSettings } = useStore();
  const mode = settings.stress;
  const cycle = () =>
    setSettings((s) => ({ ...s, stress: STRESS_MODES[(STRESS_MODES.indexOf(s.stress) + 1) % STRESS_MODES.length] ?? "off" }));
  useHotkeys("grid", { stress: () => cycle() });
  if (mode === "off") {
    return (
      <button className="chip ghost" title="Stress views: squint, small, reversed, pixel (V cycles them)" onClick={cycle}>
        Stress <span className="faint">V</span>
      </button>
    );
  }
  return (
    <button className="chip on" title="Turn the stress view off (V goes on to the next)" onClick={() => setSettings((s) => ({ ...s, stress: "off" }))}>
      Stress: {STRESS_LABELS[mode] ?? mode} ✕
    </button>
  );
}
