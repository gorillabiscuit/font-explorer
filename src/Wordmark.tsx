import { memo, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { effectiveText } from "./coverage";
import { peekExt, peekFacts } from "./facts/index";
import { useFaceMeasure } from "./facts/useFacts";
import { fontStack, inLatinExt, isItalicFace, nearestWeight } from "./fonts";
import { useInView, useSettled, useWidth } from "./hooks";
import { layoutFormation } from "./layout/engine";
import { deepEqual } from "./merge";
import "./layout/layout.css";
import { nominalMeasurer } from "./layout/nominal";
import type { ContainerShape, LayoutResult, Run } from "./layout/types";
import type { Recipe } from "./recipe";
import { parseName, type Settings } from "./settings";
import type { FontEntry } from "./types";

/**
 * The one component that sets the name, for cards, the lightbox, the reference band and Compare.
 * It lays the name out with the layout engine (layout/engine.ts) and draws the result as SVG text.
 */
export interface WordmarkProps {
  /**
   * The face to draw. A family's italic is a face of its own (fonts.ts italicFace): handed one, the
   * wordmark is measured from the italic file and drawn in italic. Whoever loads the face decides
   * (fonts.ts ensureFace), so a family without an italic is handed its upright, never a slanted one.
   */
  font: FontEntry;
  /** The grid settings. */
  settings: Settings;
  /** Overrides the settings field by field, e.g. a candidate's own recipe or the weight that loaded. */
  recipe?: Partial<Recipe>;
  /** The Size the name is matched at (see matchedSize); settings.size when absent. */
  size?: number;
  /** Room to fit in. Without it the wordmark fits the width of its own element. */
  box?: { width: number; height?: number };
  /** 'full' is Google's complete upstream file (alternates), loaded one font at a time. */
  variant?: "web" | "full";
  className?: string;
  /** Called with each layout measured in the real face (not the stand-in shown before it loads). */
  onLayout?: (r: LayoutResult) => void;
}

/**
 * How far off screen a wordmark keeps its face's parsed font. Beyond this it lets go (the grid never
 * unmounts cards, so holding every face ever seen would grow without end) and keeps showing its last
 * layout, which nobody can see from there anyway. Wider than the 600 px at which cards load fonts.
 */
export const NEAR = "1500px 0px";

const HATCH = "#e5484d";

export const Wordmark = memo(function Wordmark(props: WordmarkProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Inside a card, watch the card: content-visibility skips its contents while it is far away, and
  // skipped elements report no position to an IntersectionObserver.
  const watched = useRef<Element | null>(null);
  useLayoutEffect(() => {
    watched.current = ref.current?.closest(".card") ?? ref.current;
  }, []);
  const near = useInView(watched, NEAR);
  const width = useWidth(ref);
  // Typing re-lays out the whole grid once the name has been still for 120 ms, not on every key.
  const text = useSettled(props.recipe?.text ?? props.settings.text);

  // A wordmark near the screen takes a change (pressing 1-5, the Size slider, a typed name) in the
  // render that made it. One far away takes it a moment later, in a background render React can
  // interrupt, and this shell is all that runs for it until then: with a thousand cards mounted,
  // the cards on screen are redrawn first. Its width is always the current one: a far wordmark
  // rarely lays out (see WordmarkBody), and one that does must not fit an old width.
  const now = useMemo(() => ({ props, text }), [props, text]);
  const later = useDeferredValue(now);
  const shown = near ? now : later;
  const { className, ...rest } = shown.props;
  return (
    <div ref={ref} className={["wordmark", className].filter(Boolean).join(" ")}>
      <WordmarkBody {...rest} text={shown.text} width={width} near={near} />
    </div>
  );
});

interface BodyProps extends Omit<WordmarkProps, "className"> {
  /** The name, settled (see useSettled). */
  text: string;
  /** The wrapper's measured width, undefined until it is known. */
  width: number | undefined;
  /** Within NEAR of the screen: holds its face and lays out in it. */
  near: boolean;
}

const WordmarkBody = memo(function WordmarkBody({ font, settings, recipe, size, box, variant = "web", onLayout, text, width, near }: BodyProps) {
  const weight = nearestWeight(font, recipe?.weight ?? settings.weight);
  const textCase = recipe?.textCase ?? settings.textCase;
  const tracking = recipe?.tracking ?? settings.tracking;
  const features = recipe?.features;
  const layout = recipe?.layout ?? settings.layout;
  const S = size ?? settings.size;
  // Until the width is known (a frame after mounting) the name is set unfitted.
  const boxWidth = (box?.width ?? width) || undefined;
  const boxHeight = box?.height;

  // The last layout measured in the real face. While it exists and the card is far away, the face is
  // let go and this layout stays on show; a card that has never been laid out stays active, so a view
  // that mounts on screen (the lightbox flipping fonts) shows the real layout on its first frame.
  // A card that comes back near with nothing changed (same face, name, layout, size, width) keeps
  // showing that layout without taking its face again: once more faces have been seen than the
  // caches hold, taking it again meant downloading and parsing the file a second time. Any change
  // to those inputs wakes it, and it lays out afresh. Only a final layout sleeps: one measured from
  // the file, or with the canvas where there is no file to read (an installed font, a file fontkit
  // cannot parse).
  const last = useRef<LayoutResult | null>(null);
  const inputs = [font, weight, variant, text, textCase, layout, S, tracking, features, boxWidth, boxHeight];
  const lastInputs = useRef<unknown[] | null>(null);
  const lastFinal = useRef(false);
  const asleep = useRef(false);
  if (!near && last.current && lastFinal.current) asleep.current = true;
  // Judged only once near: far away the body is shown props a moment old (useDeferredValue above).
  if (near && asleep.current && !sameInputs(inputs, lastInputs.current)) asleep.current = false;
  const active = last.current === null || (near && !asleep.current);
  // A card scrolled past before its file was parsed shows a canvas stand-in. When that parse lands
  // anyway (it was already queued), the exact layout is made from it once, far away and without
  // holding the face, so coming back does not mean reading the file again.
  const adopting = !active && last.current !== null && !lastFinal.current;
  const { facts, measurer } = useFaceMeasure(font, weight, variant, active, adopting);

  const computed = useMemo(() => {
    if (!active && !(adopting && measurer?.exact) && last.current) return null;
    const name = effectiveText(font, facts, { text, textCase });
    // Typed initials take the name's Case, as the name does.
    const initials = parseName({ text: layout.mark.initials, textCase }).flat;
    const result = layoutFormation({ lines: name.lines, flat: name.flat, descriptor: layout.lockup.descriptor, initials }, layout, measurer ?? nominalMeasurer, {
      size: S,
      weight,
      tracking,
      features,
      boxWidth,
      boxHeight,
      serif: font.category === "serif",
    });
    return { result, real: measurer !== null };
  }, [active, adopting, font, facts, measurer, text, textCase, layout, S, weight, tracking, features, boxWidth, boxHeight]);
  if (computed?.real) {
    last.current = computed.result;
    lastInputs.current = inputs;
    // Not final yet while a hatched letter from the latin-ext range may still be filled by that
    // file, not read yet.
    const extPending = computed.result.missing.length > 0 && peekExt(font, weight, variant) === undefined && missesLatinExt(computed.result);
    lastFinal.current = (measurer?.exact === true && !extPending) || font.source === "local" || peekFacts(font, weight, variant) === null;
  }
  const result = computed?.result ?? last.current;

  const real = computed ? computed.real : result !== null;
  // Called when the layout changes, not when the callback does, so an inline handler cannot loop.
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;
  useEffect(() => {
    if (result && real) onLayoutRef.current?.(result);
  }, [result, real]);

  const hatchId = `wm-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const family = fontStack(font, variant);
  const italic = isItalicFace(font);
  const svgRef = useRef<SVGSVGElement>(null);
  // The same elements while the layout stands, so a re-render that changed nothing here costs React
  // no diffing of the drawing.
  const drawing = useMemo(() => result && draw(result, real, family, italic, hatchId, svgRef), [result, real, family, italic, hatchId]);
  useEffect(() => {
    if (result && svgRef.current) DRAWN.set(svgRef.current, { result, real, font, weight, variant });
  }, [result, real, font, weight, variant]);
  return drawing;
});

function missesLatinExt(r: LayoutResult): boolean {
  return r.runs.some((run) => run.glyphs.some((g) => g.missing && [...g.char].some((ch) => inLatinExt(ch.codePointAt(0)!))));
}

/** Compared by value: pressing 3 then 1 hands the card a new layout object with the same settings. */
function sameInputs(a: unknown[], b: unknown[] | null): boolean {
  return b !== null && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
}

function draw(result: LayoutResult, real: boolean, family: string, italic: boolean, hatchId: string, svgRef: RefObject<SVGSVGElement | null>): ReactNode {
  const caption = captionOf(result);
  // A filled container is drawn in ink, so the letters on it take the paper colour.
  const paper = result.container?.style === "fill";
  return (
    <>
      <svg
        ref={svgRef}
        className="wm-svg"
        width={round(result.box.w)}
        height={round(result.box.h)}
        viewBox={`0 0 ${round(result.box.w)} ${round(result.box.h)}`}
        role="img"
        aria-label={result.runs.map((r) => r.text).join(" ")}
        data-font-size={import.meta.env.DEV ? round(result.fontSize) : undefined}
        data-scale={import.meta.env.DEV ? result.scale : undefined}
      >
        {result.missing.length > 0 && (
          <defs>
            <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke={HATCH} strokeWidth="1.5" />
            </pattern>
          </defs>
        )}
        {result.container && <Container c={result.container} main />}
        {result.tiles?.map((c, i) => <Container key={`t${i}`} c={c} />)}
        {result.runs.map((run, i) => drawRun(run, i, family, italic, paper, real))}
        {result.missing.map((m, i) => (
          <rect key={`m${i}`} x={round(m.x)} y={round(m.y)} width={round(m.w)} height={round(m.h)} fill={`url(#${hatchId})`} stroke={HATCH} strokeWidth="1" />
        ))}
      </svg>
      {caption && <div className="wm-caption">{caption}</div>}
    </>
  );
}

/**
 * One run as SVG text, with every letter at the x the layout measured for it, so the browser draws
 * exactly what was laid out (and what the copied outlines will be). Letter-spacing is never left to
 * the browser: WebKit drops kerning from a letter-spaced run and Chrome drops its ligatures, so a
 * tracked name came out wider than laid out and could be cut off at the card edge. Positions from
 * the stand-in measurer are guesses, so a layout that is not real yet is drawn as plain text.
 * `italic`: the face is an italic, which shares its upright's family name, so the style picks it.
 */
function drawRun(run: Run, key: number, family: string, italic: boolean, paper: boolean, real: boolean): ReactNode {
  const cells = real ? cellsOf(run) : null;
  const props = {
    y: round(run.y),
    fontFamily: family,
    fontStyle: italic ? "italic" : undefined,
    fontWeight: run.weight,
    fontSize: round(run.size),
    fill: paper ? undefined : "currentColor",
    opacity: run.placeholder ? 0.35 : undefined,
    xmlSpace: "preserve",
  } as const;
  if (!cells) {
    return (
      <text key={key} {...props} x={round(run.x)} style={textStyle(run.tracking, run.features, paper, false)}>
        {run.text}
      </text>
    );
  }
  // One character per cell, the common case: a single list of x positions on the text.
  if (cells.every((c) => c.text.length === 1)) {
    return (
      <text key={key} {...props} x={cells.map((c) => round(c.x)).join(" ")} style={textStyle(0, run.features, paper, true)}>
        {cells.map((c) => c.text).join("")}
      </text>
    );
  }
  // An accent or a ligature makes a cell longer: each cell gets its own tspan and the browser shapes inside it.
  return (
    <text key={key} {...props} x={round(run.x)} style={textStyle(0, run.features, paper, false)}>
      {cells.map((c, i) => (
        <tspan key={i} x={round(c.x)}>
          {c.text}
        </tspan>
      ))}
    </text>
  );
}

/**
 * The run cut where the layout positioned it: one cell per glyph that moves the pen, holding its
 * characters (both letters of a ligature) and any zero-width glyph after it (an accent). Null when
 * the glyphs are not in text order (right-to-left text), which the browser then lays out itself.
 */
function cellsOf(run: Run): { x: number; text: string; index: number }[] | null {
  const cells: { x: number; text: string; index: number }[] = [];
  let typed = "";
  let index = -1;
  for (const g of run.glyphs) {
    if (g.index < index) return null;
    index = g.index;
    typed += g.char;
    const cell = cells[cells.length - 1];
    if (cell && (Math.abs(g.w) < 0.01 || !g.char)) cell.text += g.char;
    else cells.push({ x: g.x, text: composed(g.char), index: g.index });
  }
  return cells.length && typed === run.text ? cells : null;
}

/**
 * A letter typed with a separate accent ('e' + U+0301) that the measurer drew as the font's own 'é'
 * is drawn as that 'é' too. Handed the two characters, WebKit draws the pair from a fallback font.
 */
function composed(chars: string): string {
  if (chars.length < 2) return chars;
  const letter = chars.normalize("NFC");
  return [...letter].length === 1 ? letter : chars;
}

/** `single`: every letter is placed on its own, so the layout formed no ligature and the browser must not either. */
function textStyle(tracking: number, features: Record<string, 0 | 1>, paper: boolean, single: boolean): CSSProperties {
  return {
    letterSpacing: tracking ? `${tracking}em` : undefined,
    fontFeatureSettings: featureSettings(features),
    // The measurer kerns (fontkit applies the font's kerning). Placed letters carry it in their
    // positions; a run drawn as plain text needs the browser to kern too, at every size.
    fontKerning: features.kern === 0 ? "none" : "normal",
    fontVariantLigatures: single ? "no-common-ligatures" : undefined,
    fontSynthesis: "none",
    whiteSpace: "pre",
    fill: paper ? "var(--card)" : undefined,
  };
}

/** `main`: the name's own container (not one of Mark's small tiles); the lightbox lines layers up on it. */
function Container({ c, main }: { c: ContainerShape; main?: boolean }) {
  const paint =
    c.style === "fill"
      ? { fill: "currentColor" }
      : c.style === "keyline"
        ? { fill: "none", stroke: "currentColor", strokeWidth: c.stroke }
        : { fill: "none", stroke: "currentColor", strokeOpacity: 0.35, strokeWidth: 1, strokeDasharray: "4 4" };
  const className = `wm-tile${main ? " wm-container" : ""}`;
  if (c.shape === "circle") return <ellipse className={className} cx={c.x + c.w / 2} cy={c.y + c.h / 2} rx={c.w / 2} ry={c.h / 2} {...paint} />;
  const rx = c.shape === "pill" ? Math.min(c.w, c.h) / 2 : c.shape === "rounded" ? c.rx : 0;
  return <rect className={className} x={c.x} y={c.y} width={c.w} height={c.h} rx={rx} {...paint} />;
}

/** '+0.04em / −0.02em · collision · scaled 82%', or '' when the layout needed nothing. */
export function captionOf(r: LayoutResult): string {
  const parts = r.fit.length ? [r.fit.join(" / ")] : [];
  // Rounded down, so a shrink of a fraction of a percent still reads as one (99%), never 'scaled 100%'.
  for (const w of r.warnings) parts.push(w === "scaled" ? `scaled ${Math.floor(r.scale * 100 + 1e-6)}%` : w);
  return parts.join(" · ");
}

const round = (v: number) => Math.round(v * 100) / 100;

/** { ss01: 1, kern: 0 } -> '"ss01" 1, "kern" 0', or undefined for none. */
export function featureSettings(features?: Record<string, 0 | 1>): string | undefined {
  const entries = Object.entries(features ?? {});
  return entries.length ? entries.map(([tag, on]) => `"${tag}" ${on}`).join(", ") : undefined;
}

/** What a drawn wordmark shows: its layout, and the face that layout was measured in. */
export interface DrawnWordmark {
  result: LayoutResult;
  /** Measured in the real face, not the stand-in shown while it loads. */
  real: boolean;
  font: FontEntry;
  weight: number;
  variant: "web" | "full";
}

/**
 * The layout each drawn wordmark shows, by its SVG element. Copy SVG outlines exactly this layout
 * (export/copy.ts), so what pastes is what was on screen; `__fx.auditFidelity()` checks it too.
 */
const DRAWN = new WeakMap<SVGSVGElement, DrawnWordmark>();

export function drawnWordmark(svg: Element | null | undefined): DrawnWordmark | undefined {
  return svg instanceof SVGSVGElement ? DRAWN.get(svg) : undefined;
}

// Console helpers in development. `await __fx.auditSizes()` lists random cards on screen with the
// height Match equalises (cap or x-height) as drawn, which should agree to within half a pixel.
// `__fx.auditFidelity()` compares where the browser put each letter of the cards on screen with
// where the layout measured it, which should agree to within a fraction of a pixel at any letter
// spacing; run it in each browser after changing how Wordmark draws text.
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__fx = {
    ...window.__fx,
    factsStats: () => import("./facts/index").then((m) => m.factsStats()),
    auditFidelity: (count = 40) => {
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      const rows = [];
      for (const svg of document.querySelectorAll<SVGSVGElement>(".wm-svg")) {
        const r = svg.getBoundingClientRect();
        const drawn = DRAWN.get(svg);
        if (r.bottom < top || r.top > window.innerHeight || !drawn?.real) continue;
        const texts = svg.querySelectorAll("text");
        // Only where each letter starts: a glyph is drawn from there, while the advance the browser
        // reports for it may leave out kerning that the next letter's position already carries.
        let off = 0;
        drawn.result.runs.forEach((run, i) => {
          const text = texts[i];
          const cells = cellsOf(run);
          if (!text || !cells) return;
          // Character indexes in what was drawn: a composed accent is one character there, two as typed.
          const asDrawn = text.textContent === cells.map((c) => c.text).join("");
          let at = 0;
          for (const c of cells) {
            try {
              off = Math.max(off, Math.abs(text.getStartPositionOfChar(asDrawn ? at : c.index).x - c.x));
            } catch {
              // an index the browser does not count (a character it merged): skipped
            }
            at += c.text.length;
          }
        });
        const card = svg.closest<HTMLElement>("[data-font-id]");
        rows.push({ font: card?.dataset.fontId ?? "", lines: new Set(drawn.result.runs.map((run) => run.y)).size, offPx: Number(off.toFixed(2)) });
        if (rows.length >= count) break;
      }
      console.table(rows);
      return rows;
    },
    auditSizes: async (count = 10) => {
      const store = window.__fxStore;
      if (!store) return [];
      const { getFacts } = await import("./facts/index");
      const { parseName } = await import("./settings");
      const { settings } = store;
      const caps = !/\p{Ll}/u.test(parseName(settings).flat);
      const mode = settings.layout.match === "auto" ? (caps ? "cap" : "x") : settings.layout.match;
      const target = mode === "cap" ? 0.7 * settings.size : mode === "x" ? 0.5 * settings.size : NaN;
      const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      const cards = [...document.querySelectorAll<HTMLElement>(".grid .card")].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > top && r.top < window.innerHeight && c.querySelector(".wm-svg text") && !c.querySelector(".is-pending");
      });
      const picked = cards.sort(() => Math.random() - 0.5).slice(0, count);
      const rows = [];
      for (const card of picked) {
        const font = store.byId.get(card.dataset.fontId ?? "");
        const svg = card.querySelector<SVGSVGElement>(".wm-svg");
        const text = svg?.querySelector("text");
        if (!font || !svg || !text) continue;
        const facts = (await getFacts(font, Number(text.getAttribute("font-weight"))))?.facts;
        if (!facts) continue;
        const drawn = Number(text.getAttribute("font-size"));
        const scale = Number(svg.dataset.scale ?? 1);
        const ref = mode === "cap" ? facts.capHeight : facts.xHeight;
        const matched = (drawn / scale) * ref;
        rows.push({ family: font.family, drawnSize: drawn, scale, [mode]: ref, matchedPx: Number(matched.toFixed(2)), targetPx: target, offPx: Number((matched - target).toFixed(2)) });
      }
      console.table(rows);
      return rows;
    },
  };
}
