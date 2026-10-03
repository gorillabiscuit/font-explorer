// Font facts, run measurement, feature checks and outlines, read from a parsed fontkit Font.
// DOM-free and fontkit-free at runtime (type import only), so the browser and the Node check
// scripts run exactly the same code. Whoever parses the file passes the Font in.
import type { BBOX, Font, Glyph, GlyphPosition } from "fontkit";
import { Lru } from "./lru";
import type { FeatureSettings, FontFacts, FontFeature, GlyphPath, Measurer, RunMetrics, RunOptions, RunPath, Variation } from "./types";

/** fontkit tables and methods the published types leave out. Read defensively: any of them may be absent. */
interface FontInternals {
  directory?: { tables?: Record<string, unknown> };
  // fontkit reads a feature's params as { version, nameID }; for ssXX that nameID is the spec's
  // uiNameID, and for cvXX it lands on the label name, which is the one we want too.
  GSUB?: { featureList?: { tag: string; feature?: { featureParams?: { nameID?: number } | null } }[] };
  GPOS?: { featureList?: { tag: string }[] };
  name?: { records?: { fontFeatures?: Record<number, Record<string, string> | undefined> } };
  getGlyph?: (id: number, codePoints?: number[]) => Glyph | null;
  /** The plain (glyf or CFF) glyph, bypassing colour layers. */
  _getBaseGlyph?: (id: number, codePoints?: number[]) => Glyph | null | undefined;
  _glyphs?: Record<number, Glyph | undefined>;
}

// The features that change how a wordmark looks. Kerning and the rest are handled elsewhere or
// are invisible in a name.
const NAMED_FEATURES = ["salt", "swsh", "dlig", "titl", "case", "smcp", "liga", "calt"];
const WORDMARK_FEATURE = /^(ss(0[1-9]|1\d|20)|cv(0[1-9]|[1-9]\d)|salt|swsh|dlig|titl|case|smcp|liga|calt)$/;

export function computeFacts(font: Font): FontFacts {
  plainOutlines(font);
  const upm = font.unitsPerEm || 1000;
  const H = inkOf(font, "H");
  const x = inkOf(font, "x");
  const O = inkOf(font, "O");
  const tall = [inkOf(font, "d"), inkOf(font, "h")].filter((b): b is BBOX => !!b);
  const deep = [inkOf(font, "p"), inkOf(font, "g")].filter((b): b is BBOX => !!b);

  const capUnits = H?.maxY ?? positive(font.capHeight) ?? font.ascent * 0.7;
  // A font with no 'x' and no stored x-height has no lowercase to match on, so x-height falls back
  // to the cap height rather than to a made-up ratio.
  const xUnits = x?.maxY ?? positive(font.xHeight) ?? capUnits;
  const ascUnits = tall.length ? Math.max(...tall.map((b) => b.maxY)) : font.ascent;
  const descUnits = deep.length ? Math.min(...deep.map((b) => b.minY)) : font.descent;

  let hasLower = true;
  for (let cp = 0x61; cp <= 0x7a; cp++) if (!font.hasGlyphForCodePoint(cp)) hasLower = false;
  const lowerIsCaps = font.hasGlyphForCodePoint(0x61) && font.hasGlyphForCodePoint(0x41) && sameDrawing(font.glyphForCodePoint(0x61), font.glyphForCodePoint(0x41));

  const internals = font as unknown as FontInternals;
  const hasKerning = !!internals.directory?.tables?.kern || !!internals.GPOS?.featureList?.some((r) => r.tag === "kern");

  const axes: FontFacts["axes"] = {};
  for (const [tag, axis] of Object.entries(font.variationAxes ?? {})) {
    if (axis) axes[tag] = { min: axis.min, max: axis.max, default: axis.default };
  }

  return {
    upm,
    capHeight: capUnits / upm,
    xHeight: xUnits / upm,
    ascender: ascUnits / upm,
    descender: descUnits / upm,
    overshoot: H && O ? Math.max(0, (O.maxY - H.maxY) / upm) : 0,
    hasLower,
    lowerIsCaps,
    hasKerning,
    features: wordmarkFeatures(font),
    axes,
    covers(ch: string) {
      for (const c of ch) if (!font.hasGlyphForCodePoint(c.codePointAt(0)!)) return false;
      return true;
    },
  };
}

/**
 * Measures runs with fontkit's own shaping (kerning, ligatures, the requested features), so the
 * numbers match what the outlines will be. Pass a variation to measure one instance of a variable font.
 */
export function createMeasurer(font: Font, facts: FontFacts, variation?: Variation | null): Measurer {
  const face = withVariation(font, variation);
  return {
    capHeight: facts.capHeight,
    xHeight: facts.xHeight,
    ascender: facts.ascender,
    descender: facts.descender,
    overshoot: facts.overshoot,
    exact: true,
    run(text: string, opts: RunOptions): RunMetrics {
      const { size } = opts;
      const shaped = shape(face, text, opts.features);
      const scale = size / shaped.upm;
      const placed = place(shaped, size, opts.tracking ?? 0);
      let inkLeft = Infinity;
      let inkRight = -Infinity;
      let inkTop = -Infinity;
      let inkBottom = Infinity;
      const glyphs = shaped.glyphs.map((g, i) => {
        const x = placed.x[i];
        const advance = g.advance * scale;
        let inkL = x;
        let inkR = x;
        let inkT = 0;
        let inkB = 0;
        if (g.missing) {
          inkR = x + (advance > 0 ? advance : 0.5 * size);
          inkT = facts.capHeight * size;
        } else if (g.box) {
          inkL = x + g.box.minX * scale;
          inkR = x + g.box.maxX * scale;
          inkB = (g.y + g.box.minY) * scale;
          inkT = (g.y + g.box.maxY) * scale;
        }
        if (g.missing || g.box) {
          inkLeft = Math.min(inkLeft, inkL);
          inkRight = Math.max(inkRight, inkR);
          inkTop = Math.max(inkTop, inkT);
          inkBottom = Math.min(inkBottom, inkB);
        }
        return { index: g.index, char: g.char, x, advance, inkL, inkR, inkT, inkB, missing: g.missing };
      });
      const inked = inkLeft <= inkRight;
      return {
        advance: placed.advance,
        inkLeft: inked ? inkLeft : 0,
        inkRight: inked ? inkRight : 0,
        inkTop: inked ? inkTop : 0,
        inkBottom: inked ? inkBottom : 0,
        glyphs,
      };
    },
  };
}

/**
 * The UTF-16 indexes of `text` whose glyph changes when `tag` is switched on, compared with it
 * switched off. Letters merged into one glyph (a ligature) count as changed, as do letters split
 * apart. Works for default-on features (liga, calt) as well as opt-in ones (ss01).
 */
export function changedBy(font: Font, text: string, tag: string, features?: FeatureSettings): number[] {
  const off = glyphPerChar(font, text, { ...features, [tag]: 0 });
  const on = glyphPerChar(font, text, { ...features, [tag]: 1 });
  const changed: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (isLowSurrogate(text, i)) continue; // report each character once, at its first unit
    if (off[i] !== on[i]) changed.push(i);
  }
  return changed;
}

/**
 * Outlines for a run, at the same positions the measurer reports, as SVG path data in px with y
 * pointing down and the baseline at y = 0. Missing glyphs get no outline.
 */
export function pathFor(font: Font, text: string, opts: RunOptions & { variation?: Variation | null }): RunPath {
  const face = withVariation(font, opts.variation);
  const shaped = shape(face, text, opts.features);
  const scale = opts.size / shaped.upm;
  const placed = place(shaped, opts.size, opts.tracking ?? 0);
  const glyphs: GlyphPath[] = shaped.glyphs.map((g, i) => {
    const x = placed.x[i];
    // g.y lifts the glyph (y up, in font units); the path's y points down, so the shift is negative.
    const d = g.missing || !g.box ? "" : svgPath(g.glyph, scale, x, -g.y * scale);
    return { index: g.index, char: g.char, d, x, missing: g.missing };
  });
  return { d: glyphs.map((g) => g.d).join(""), glyphs, advance: placed.advance };
}

/** The font itself, or the instance of a variable font at the given axis values (cached). */
export function withVariation(font: Font, variation?: Variation | null): Font {
  if (!variation || !Object.keys(variation).length || !Object.keys(font.variationAxes ?? {}).length) return font;
  const key = variationKey(variation);
  let instances = variations.get(font);
  if (!instances) variations.set(font, (instances = new Map()));
  let instance = instances.get(key);
  if (!instance) instances.set(key, (instance = font.getVariation(variation)));
  return instance;
}

// --- shaping ---

interface ShapedGlyph {
  index: number;
  char: string;
  id: number;
  glyph: Glyph;
  /** Pen position plus the shaper's offset, in font units, before tracking. */
  x: number;
  y: number;
  advance: number;
  box: BBOX | null;
  missing: boolean;
}

interface Shaped {
  glyphs: ShapedGlyph[];
  /** In font units. */
  advance: number;
  upm: number;
}

const variations = new WeakMap<Font, Map<string, Font>>();
// One small cache of shaped runs per font. Layouts re-measure the same name many times (every
// formation, every break suggestion), and size and tracking scale linearly, so the shaping is
// reusable across them.
const shapedRuns = new WeakMap<Font, Lru<string, Shaped>>();

function shape(font: Font, typed: string, features?: FeatureSettings): Shaped {
  const key = `${featureKey(features)}\u0000${typed}`;
  let cache = shapedRuns.get(font);
  if (!cache) shapedRuns.set(font, (cache = new Lru(64)));
  const hit = cache.get(key);
  if (hit) return hit;

  plainOutlines(font);
  // An accent typed as a separate mark is drawn as the font's own accented letter when it has one,
  // as browsers do. Glyph indexes are mapped back to the typed text below.
  const composed = composeForFont(font, typed);
  const text = composed?.text ?? typed;
  const run = layoutRun(font, text, features);
  // Which characters each glyph draws. fontkit reuses one Glyph object per glyph id, so the code
  // points it carries belong to whichever text first created it: every missing letter shares
  // .notdef, and a caps-only face shares one glyph between 'a' and 'A'. So the characters are read
  // from the text. With one glyph per character (no ligatures or splits) that is a straight walk;
  // otherwise a glyph's claimed characters are trusted only where the text agrees.
  const chars = Array.from(text);
  const oneToOne = run.glyphs.length === chars.length;
  let pen = 0;
  let cursor = 0;
  let lastIndex = 0;
  const glyphs = run.glyphs.map((glyph, i): ShapedGlyph => {
    const pos = run.positions[i];
    let char: string;
    if (oneToOne) char = chars[i];
    else {
      const claimed = String.fromCodePoint(...glyph.codePoints);
      if (!claimed || text.startsWith(claimed, cursor)) char = claimed;
      // A zero-width mark the text does not account for is an accent split off its letter.
      else if (pos.xAdvance === 0 && glyph.isMark) char = "";
      else char = String.fromCodePoint(text.codePointAt(cursor) ?? 0xfffd);
    }
    // A glyph with no characters (the second half of a split) belongs to the previous character.
    const index = char ? Math.min(cursor, Math.max(0, text.length - 1)) : lastIndex;
    if (char) {
      lastIndex = index;
      cursor += char.length;
    }
    const shaped: ShapedGlyph = {
      index,
      char,
      id: glyph.id,
      glyph,
      x: pen + pos.xOffset,
      y: pos.yOffset,
      advance: pos.xAdvance,
      box: inkBox(glyph),
      missing: glyph.id === 0,
    };
    pen += pos.xAdvance;
    return shaped;
  });
  if (composed) backToTyped(glyphs, typed, composed.map);
  const shaped = { glyphs, advance: pen, upm: font.unitsPerEm || 1000 };
  cache.set(key, shaped);
  return shaped;
}

/**
 * fontkit's shaping, made safe to call during a render. Its mark positioning throws on some fonts
 * whose anchor tables have gaps (Junicode with an accent it has no precomposed letter for), so a
 * failed run is shaped again without mark positioning (the accent then sits where the pen is), and
 * as a last resort laid out one glyph per character with no shaping at all.
 */
function layoutRun(font: Font, text: string, features?: FeatureSettings): { glyphs: Glyph[]; positions: GlyphPosition[] } {
  try {
    return font.layout(text, fontkitFeatures(features));
  } catch (err) {
    warnOnce(font, err);
  }
  try {
    return font.layout(text, { ...fontkitFeatures(features), mark: false, mkmk: false });
  } catch {
    // fall through to the unshaped run
  }
  try {
    const glyphs = font.glyphsForString(text);
    return { glyphs, positions: glyphs.map((g) => ({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 })) };
  } catch {
    return { glyphs: [], positions: [] };
  }
}

const warned = new WeakSet<Font>();

function warnOnce(font: Font, err: unknown) {
  if (warned.has(font)) return;
  warned.add(font);
  const why = err instanceof Error ? err.message : String(err);
  console.warn(`fontkit could not shape a run in ${font.fullName || font.familyName} (${why}); measuring it with less shaping`);
}

// A letter followed by one or more combining marks: the only spans that composing can change.
const MARK_CLUSTER = /\P{M}\p{M}+/gu;

/**
 * The text with each letter-plus-accent spelling replaced by the font's precomposed letter, where
 * Unicode has one and the font draws it ('e' + U+0301 becomes 'é'), as browsers do when they shape.
 * Null when nothing changes. `map` gives, for each UTF-16 position of the new text (and its end),
 * the position in the typed text; positions inside a composed letter map to its end, so the glyph
 * that starts the letter claims the whole typed spelling.
 */
function composeForFont(font: Font, typed: string): { text: string; map: number[] } | null {
  if (!/\p{M}/u.test(typed)) return null;
  let text = "";
  const map: number[] = [];
  let done = 0;
  for (const m of typed.matchAll(MARK_CLUSTER)) {
    const spelling = m[0];
    const letter = spelling.normalize("NFC");
    if (letter === spelling || !coversAll(font, letter)) continue;
    const start = m.index;
    for (let i = done; i < start; i++) map.push(i);
    map.push(start);
    for (let i = 1; i < letter.length; i++) map.push(start + spelling.length);
    text += typed.slice(done, start) + letter;
    done = start + spelling.length;
  }
  if (!done) return null;
  for (let i = done; i <= typed.length; i++) map.push(i);
  text += typed.slice(done);
  return { text, map };
}

/** Points each glyph back at the characters of the typed text, after composeForFont changed it. */
function backToTyped(glyphs: ShapedGlyph[], typed: string, map: number[]) {
  let cursor = 0;
  let lastIndex = 0;
  for (const g of glyphs) {
    if (g.char) {
      const start = Math.max(cursor, map[g.index]);
      const end = Math.max(start, map[g.index + g.char.length]);
      g.char = typed.slice(start, end);
      if (g.char) {
        g.index = lastIndex = start;
        cursor = end;
        continue;
      }
    }
    // A glyph with no characters of its own belongs to the previous character, as in shape().
    g.index = lastIndex;
  }
}

function coversAll(font: Font, text: string): boolean {
  for (const c of text) if (!font.hasGlyphForCodePoint(c.codePointAt(0)!)) return false;
  return true;
}

const plain = new WeakSet<Font>();

/**
 * Colour fonts are read through their plain outlines, which every COLR font carries for apps
 * without colour support. Only the shapes matter here (the browser draws the colours), and
 * fontkit's colour glyphs break on newer colour tables when their box is read (Bungee Tint,
 * Sixtyfour Convergence). Changes how this Font object makes glyphs, once, before any are shaped.
 */
function plainOutlines(font: Font) {
  if (plain.has(font)) return;
  plain.add(font);
  const f = font as unknown as FontInternals;
  if (!f.directory?.tables?.COLR || !f._getBaseGlyph) return;
  const base = f._getBaseGlyph.bind(font);
  f._glyphs = {}; // forget colour glyphs made before this
  // fontkit's WOFF2 reader returns nothing for a glyph it has already made, so its cache comes first.
  f.getGlyph = (id, codePoints = []) => f._glyphs?.[id] ?? base(id, codePoints) ?? null;
}

/**
 * Glyph x positions in px with tracking, and the run's advance. Tracking goes between glyphs, never
 * after the last one, and never in front of a zero-width glyph (an accent stays on its letter),
 * which matches how browsers apply letter-spacing per character.
 */
function place(shaped: Shaped, size: number, tracking: number): { x: number[]; advance: number } {
  const scale = size / shaped.upm;
  const step = tracking * size;
  let shift = 0;
  let spacingSeen = false;
  const x = shaped.glyphs.map((g) => {
    if (g.advance !== 0) {
      if (spacingSeen) shift += step;
      spacingSeen = true;
    }
    return g.x * scale + shift;
  });
  return { x, advance: shaped.advance * scale + shift };
}

function glyphPerChar(font: Font, text: string, features: FeatureSettings): string[] {
  const ids = new Array<string>(text.length).fill("");
  for (const g of shape(font, text, features).glyphs) {
    // The cluster start and length are part of the signature, so merging two letters into one
    // glyph reads as a change even when the shaper reuses a glyph id.
    const end = Math.min(text.length, g.index + Math.max(1, g.char.length));
    for (let k = g.index; k < end; k++) ids[k] += `${g.id}@${g.index}+${g.char.length};`;
  }
  return ids;
}

// --- helpers ---

function wordmarkFeatures(font: Font): FontFeature[] {
  // availableFeatures looks under the default script; a Latin name is shaped under 'latn', and
  // some fonts register their sets only there, so ask for both.
  const tags = new Set([...font.availableFeatures, ...font.getAvailableFeatures("latn", "")]);
  const names = featureNames(font);
  return [...tags]
    .filter((tag) => WORDMARK_FEATURE.test(tag))
    .sort((a, b) => featureRank(a) - featureRank(b))
    .map((tag) => (names.has(tag) ? { tag, uiName: names.get(tag) } : { tag }));
}

function featureRank(tag: string): number {
  const n = Number(tag.slice(2));
  if (tag.startsWith("ss")) return n;
  if (tag.startsWith("cv")) return 100 + n;
  return 200 + NAMED_FEATURES.indexOf(tag);
}

/** Stylistic-set names the font stores for its own UI. Best effort: many fonts have none. */
function featureNames(font: Font): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const internals = font as unknown as FontInternals;
    const records = internals.name?.records?.fontFeatures;
    for (const rec of internals.GSUB?.featureList ?? []) {
      const id = rec.feature?.featureParams?.nameID;
      const entry = id == null ? undefined : records?.[id];
      const text = entry ? (entry.en ?? Object.values(entry)[0]) : undefined;
      if (text && !names.has(rec.tag)) names.set(rec.tag, text);
    }
  } catch {
    // a malformed name or feature table only costs the nice label
  }
  return names;
}

function svgPath(glyph: Glyph, scale: number, dx: number, dy: number): string {
  // Read the commands rather than calling path.scale()/translate(): those mutate fontkit's cached path.
  let commands: Glyph["path"]["commands"];
  try {
    commands = glyph.path.commands;
  } catch {
    return ""; // an outline fontkit cannot decode is left out, like a missing glyph
  }
  let d = "";
  for (const { command, args } of commands) {
    if (command === "closePath") {
      d += "Z";
      continue;
    }
    d += SVG_COMMAND[command];
    for (let i = 0; i < args.length; i += 2) {
      d += `${i ? " " : ""}${num(dx + args[i] * scale)} ${num(dy - args[i + 1] * scale)}`;
    }
  }
  return d;
}

const SVG_COMMAND = { moveTo: "M", lineTo: "L", quadraticCurveTo: "Q", bezierCurveTo: "C" } as const;

function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

/**
 * Same glyph, or a copy of it. Some caps-only faces give 'a' its own glyph id holding the 'A'
 * outline (EB Garamond All SC, Boeticher), so equal ids alone would miss them.
 */
function sameDrawing(a: Glyph, b: Glyph): boolean {
  if (a.id === b.id) return true;
  const p = inkBox(a);
  const q = inkBox(b);
  return !!p && !!q && a.advanceWidth === b.advanceWidth && p.minX === q.minX && p.maxX === q.maxX && p.minY === q.minY && p.maxY === q.maxY;
}

function inkOf(font: Font, ch: string): BBOX | null {
  const cp = ch.codePointAt(0)!;
  if (!font.hasGlyphForCodePoint(cp)) return null;
  return inkBox(font.glyphForCodePoint(cp));
}

/** A glyph's ink box, or null for a glyph with no ink or one whose outline fontkit cannot decode. */
function inkBox(glyph: Glyph): BBOX | null {
  if (boxes.has(glyph)) return boxes.get(glyph) ?? null;
  let box: BBOX | null;
  try {
    const b = pathBox(glyph.path.commands);
    box = hasInk(b) ? b : null;
  } catch {
    box = null;
  }
  boxes.set(glyph, box);
  return box;
}

const boxes = new WeakMap<Glyph, BBOX | null>();

/**
 * The exact box of an outline, from the same commands the outlines are drawn from. fontkit's own
 * glyph.bbox can miss where a curve bulges past its end points: a TrueType curve is a quadratic,
 * which it raises to a cubic whose leading term should be 0 but comes out a rounding error away,
 * and its root formula then lands nowhere near the bulge (DOF 1 Italic's 'u' dips half a pixel at
 * 100 px below the box it reports). Each curve's extremes are solved here in its own degree.
 */
function pathBox(commands: { command: string; args: number[] }[]): BBOX {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let x0 = 0;
  let y0 = 0;
  for (const { command, args } of commands) {
    if (command === "closePath") continue;
    const [x, y] = args.slice(-2);
    if (command === "quadraticCurveTo") {
      const [cx, cy] = args;
      for (const t of quadraticExtremes(x0, cx, x).concat(quadraticExtremes(y0, cy, y))) {
        const u = 1 - t;
        add(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
      }
    } else if (command === "bezierCurveTo") {
      const [c1x, c1y, c2x, c2y] = args;
      for (const t of cubicExtremes(x0, c1x, c2x, x).concat(cubicExtremes(y0, c1y, c2y, y))) {
        const u = 1 - t;
        add(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
      }
    }
    add(x, y);
    x0 = x;
    y0 = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } as BBOX;
}

/** Where a quadratic's coordinate turns, strictly inside the curve. */
function quadraticExtremes(p0: number, p1: number, p2: number): number[] {
  const d = p0 - 2 * p1 + p2;
  if (d === 0) return [];
  const t = (p0 - p1) / d;
  return t > 0 && t < 1 ? [t] : [];
}

/** Where a cubic's coordinate turns, strictly inside the curve: the roots of its derivative. */
function cubicExtremes(p0: number, p1: number, p2: number, p3: number): number[] {
  // The derivative over 3 is a t² + b t + c.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  let roots: number[];
  // A cubic that is really a quadratic has a of nearly 0: then the derivative is linear.
  if (Math.abs(a) < 1e-9 * scale) roots = b === 0 ? [] : [-c / b];
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    // The form that avoids cancelling two nearly equal numbers.
    const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
    roots = [q / a, q === 0 ? 0 : c / q];
  }
  return roots.filter((t) => t > 0 && t < 1);
}

/** fontkit gives an empty glyph (a space) an infinite box. */
function hasInk(b: BBOX): boolean {
  return Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minY) && Number.isFinite(b.maxY) && (b.maxX > b.minX || b.maxY > b.minY);
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** fontkit mutates the features object it is given, so every call gets a fresh one. */
function fontkitFeatures(features?: FeatureSettings): Record<string, boolean> | undefined {
  if (!features) return undefined;
  const out: Record<string, boolean> = {};
  for (const [tag, on] of Object.entries(features)) out[tag] = !!on;
  return out;
}

function featureKey(features?: FeatureSettings): string {
  if (!features) return "";
  return Object.keys(features)
    .sort()
    .map((tag) => `${tag}=${features[tag] ? 1 : 0}`)
    .join(",");
}

function variationKey(variation: Variation): string {
  return Object.keys(variation)
    .sort()
    .map((tag) => `${tag}=${variation[tag]}`)
    .join(",");
}

function isLowSurrogate(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return i > 0 && c >= 0xdc00 && c <= 0xdfff;
}
