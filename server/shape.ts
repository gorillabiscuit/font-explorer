// Shape facts for one font file, measured from its outlines: how heavy, wide, slanted, square,
// straight and contrasted its letters are. The vibe search's catalog is text only, so these numbers
// are the only way Claude learns what a family looks like.
//
// The weight and width follow fontTools (varLib.avar.plan's measureWeight and measureWidth, and the
// StatisticsPen they use), so the numbers can be compared with tools that use those. Curves are
// flattened into short straight pieces and the filled shape is integrated with Green's theorem: each
// contour's signed area and moments are summed, so a counter (wound the other way) is subtracted from
// the letter around it. Overlapping contours are counted twice, as in fontTools. One departure: a
// separate island of ink counts as ink whichever way it is wound (see settle), because fonts draw with
// the nonzero rule and some wind half their islands backwards. The slant is read from the stems (see
// stemSlantOf); fontTools' measureSlant, taken over the whole ink, is only the fallback, because a
// script's joining strokes and tails drag it backwards.
//
// Pure: no network, no file system, and fontkit is a type import only. Whoever parses the file
// passes the Font in.
import type { Font, Glyph } from "fontkit";

export interface ShapeTraits {
  /**
   * Ink weight: Σ(advance × |ink area|) / Σ(advance²) over the letters, per em (fontTools
   * measureWeight with every letter counted once). A regular text face sits near 0.2.
   */
  w: number | null;
  /**
   * Width: the mean advance of a-z over the x-height (the ink top of 'x'). Null here for caps faces
   * and faces without an 'x'; build-shapes fills those from `wdCaps`.
   */
  wd: number | null;
  /** Caps width: the mean advance of A-Z over the cap height (the ink top of 'H'). */
  wdCaps: number | null;
  /**
   * Slant in degrees, positive when the letters lean right: the mean angle from vertical of the sides
   * of the stems and bowls between the baseline and the x-height, weighted by their height (see
   * stemSlantOf). `slFrom` says when the whole-ink slant stood in for it.
   */
  sl: number | null;
  /**
   * Set when `sl` is fontTools' whole-ink slant instead of the stems' (see slantOf): too little stem
   * to read, a pixel italic whose stems are vertical steps, or letters drawn from many pieces whose
   * edges disagree with the ink. Absent when the stems were read.
   */
  slFrom?: "covariance";
  /** x-height over cap height: the ink top of 'x' over the ink top of 'H'. */
  xr: number | null;
  /**
   * Squareness of 'o': its outer contour's area over that contour's box (its silhouette's, for an 'o'
   * built from pieces). A circle is about 0.785, a squared 'o' 0.86 or more.
   */
  sq: number | null;
  /**
   * Share of the letters' outline length that is straight: runs of straight pieces that keep one
   * direction, long enough or ending in corners (see straightness), so a curve stored as many short
   * lines still counts as curved.
   */
  sf: number | null;
  /** Stroke contrast of 'o': 1 − thinner stroke / thicker stroke, sides against top and bottom. Null when 'o' has no two clean strokes on each line. */
  ct: number | null;
  /** Reverse contrast: the top and bottom of 'o' are thicker than its sides, by more than 15%. Null with ct. */
  rev: boolean | null;
  /** No lowercase, or a lowercase drawn the same as the capitals. */
  caps: boolean;
}

/**
 * One family's row in server/traits/shape.json, written by build-shapes.ts: the traits rounded to
 * three decimals, and which file they were measured on.
 */
export interface ShapeEntry extends ShapeTraits {
  /** The upright file measured, the weight nearest 400. */
  file: string;
  weight: number;
  /**
   * The width was not measured on a lowercase (a caps face, or no 'x'), so `wd` is `wdCaps` times the
   * catalog's median ratio between the two measures, which `capsToLowerWidth` records.
   */
  wdFromCaps?: true;
}

/** server/traits/shape.json. */
export interface ShapeFile {
  /** Bumped when the measuring changes, so the next run measures every family again. */
  version: number;
  measuredAt: string;
  /** The median of wd / wdCaps over the families with both, used to fill `wd` for caps faces. */
  capsToLowerWidth: number | null;
  /** By family name, exactly as in the catalog. */
  fonts: Record<string, ShapeEntry>;
  /** Families that could not be measured, with a short reason. */
  failed: Record<string, string>;
}

/** fontkit internals the published types leave out, read defensively (as in src/facts/core.ts). */
interface FontInternals {
  directory?: { tables?: Record<string, unknown> };
  getGlyph?: (id: number, codePoints?: number[]) => Glyph | null;
  /** The plain (glyf or CFF) glyph, bypassing colour layers. */
  _getBaseGlyph?: (id: number, codePoints?: number[]) => Glyph | null | undefined;
  _glyphs?: Record<number, Glyph | undefined>;
}

/** Straight pieces per curve when flattening. A quarter circle is one or two curves, so this is plenty. */
const STEPS = 16;
/**
 * A curve whose control points sit within 1% of the em of its chord counts as straight, as long as
 * they are also within 3% of the chord's own length. The em rule alone catches the curves a designer
 * drew with their handles on the line, but TrueType outlines build a bowl from many short quadratics,
 * each within 1% of the em of its own chord, so on the em rule alone Kaushan Script came out 86%
 * straight and Roboto 91%. The chord rule keeps any piece that turns by more than about 7° (a
 * quadratic) to 10° (a cubic) curved.
 */
const STRAIGHT_TOLERANCE = 0.01;
const STRAIGHT_BEND = 0.03;
/**
 * Straight pieces that keep within MERGE_DEG of one direction make one span (see straightness). A span
 * is straight when it is at least SPAN_MIN of the em long, or when both its ends are corners that turn
 * by CORNER_DEG or more and it is at least CORNER_SPAN_MIN of the em (a pixel's side, a chamfer, a
 * short serif). A shorter span between gentle turns is a stretch of a curve stored as lines: a traced
 * bowl turns 2-25° at each join. A shorter span between corners is the jagged edge of a rough or
 * distressed face (Comico, Rubik Dirt), not a pixel: the finest pixel grids in the catalog are 3-4% of
 * the em.
 */
const MERGE_DEG = 3;
const SPAN_MIN = 0.035;
const CORNER_DEG = 25;
const CORNER_SPAN_MIN = 0.015;
/**
 * The slant is read from stems: runs of outline that stay within STEM_DEG of vertical, between the
 * baseline and the x-height (cap height for a face with no lowercase), less STEM_INSET of that band at
 * the bottom and the top, where stems bend into joining strokes, tails and arches. A run counts when it
 * climbs RUN_MIN of the band or more, so dots, texture and the ends of bowls are left out, and it ends
 * where the outline turns by RUN_TURN or more at once (a corner), so a stem and the chamfer above it
 * are two runs. The outline is first walked in steps of RESAMPLE of the band, so a rough or traced
 * edge reads as the line it follows rather than as its jitter. 40° rather than 45° keeps out pixel
 * faces drawn with diagonal shading, whose 45° edges would otherwise count.
 */
const STEM_DEG = 40;
const STEM_INSET = 0.1;
const RUN_MIN = 0.3;
const RESAMPLE = 0.04;
const RUN_TURN = 20;
/**
 * The letters the slant is read from: those with stems or bowls. The diagonals of k, v, w, x, y and z
 * and the spine of s lean whichever way the letter needs, not the way the face does; in a wide face
 * one diagonal of a v falls inside STEM_DEG and the other outside, and the face reads as leaning.
 */
const STEM_LETTERS = new Set([..."abcdefghijlmnopqrtu", ..."BCDEFGHIJLOPQRTU"]);
/**
 * Below this much stem, in band heights per letter, there are too few stems to read and the whole-ink
 * slant is used. An ordinary face has two to four (both sides of each stem, and of each bowl).
 */
const MIN_STEM = 0.5;
/**
 * A face whose stems are all exactly vertical but whose ink leans forward by STAIRCASE_DEG or more is a
 * pixel italic, its stems vertical steps; its whole-ink slant is the one a reader sees.
 */
const STAIRCASE_SHARE = 0.95;
const STAIRCASE_DEG = 5;
/**
 * Letters drawn from more than TEXTURE_PIECES contours each, on average, are hatching, dots or texture,
 * and the pieces' edges need not follow the letter's stems: Rubik Marker Hatch is upright Rubik filled
 * with strokes leaning 20°. When such a face's stems and whole ink disagree by more than
 * TEXTURE_DISAGREE degrees, the whole ink is read. Pixel faces drawn pixel by pixel (stems all
 * exactly vertical) are exempt: FT88 School's whole ink leans back 12° on its exit strokes.
 */
const TEXTURE_PIECES = 5;
const TEXTURE_DISAGREE = 10;
/** Top and bottom strokes this much thicker than the sides make a reverse-contrast 'o'. */
const REVERSE_MARGIN = 1.15;
/** The outer contour of 'o' must span this share of the letter's width and height to be measured for squareness. */
const OUTER_SPAN = 0.8;
/** Rows sampled across an 'o' built from pieces, to measure its silhouette. */
const SILHOUETTE_ROWS = 200;
/** Share of the lowercase letters that must be drawn as their capitals for a face to count as caps. */
const CAPS_SHARE = 0.5;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();

/** One closed contour, flattened, with its own signed integrals (see contourOf). */
interface Contour {
  /** The polygon, x0,y0,x1,y1,… (the closing edge is implied). */
  pts: number[];
  a: number;
  mx: number;
  my: number;
  myy: number;
  mxy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One letter, flattened, with the integrals the traits are built from (all in font units). */
interface Letter {
  id: number;
  advance: number;
  /** Each contour as a closed polygon, x0,y0,x1,y1,… (the closing edge is implied). */
  contours: number[][];
  /** Area of each contour, in the same order: positive for ink, negative for a counter. */
  areas: number[];
  /** Signed totals over the filled shape: area and the moments ∫x, ∫y, ∫x², ∫y², ∫xy. */
  area: number;
  mx: number;
  my: number;
  myy: number;
  mxy: number;
  /** Outline length, and the part of it that is straight (see straightness). */
  length: number;
  straight: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The shape traits of a font's letters, or null when it has no letter fontkit can draw. Measures the
 * font as given: for one instance of a variable font, pass `font.getVariation(...)`.
 */
export function measureShape(font: Font): ShapeTraits | null {
  plainOutlines(font);
  const upm = font.unitsPerEm || 1000;
  const lower = lettersOf(font, LOWER, upm);
  const upper = lettersOf(font, UPPER, upm);
  if (!lower.size && !upper.size) return null;

  const caps = !lower.size || drawnAsCaps(lower, upper);
  // The letters a reader sees in running text. A face with no lowercase at all is measured on its
  // capitals, which is what a caps face that maps a-z onto its capitals gets measured on anyway.
  const text = lower.size ? [...lower.values()] : [...upper.values()];
  const o = lower.get("o") ?? upper.get("O") ?? null;
  const x = lower.get("x") ?? null;
  const H = upper.get("H") ?? null;

  let ct: number | null = null;
  let rev: boolean | null = null;
  const strokes = o ? strokesOf(o) : null;
  if (strokes) {
    ct = 1 - Math.min(strokes.side, strokes.topBottom) / Math.max(strokes.side, strokes.topBottom);
    rev = strokes.topBottom > strokes.side * REVERSE_MARGIN;
  }

  const stemmed = [...(lower.size ? lower : upper)].filter(([ch]) => STEM_LETTERS.has(ch)).map(([, l]) => l);
  const slant = slantOf(text, stemmed, lower.size ? x : H);
  return {
    w: weightOf(text, upm),
    wd: !caps && x && x.maxY > 0 ? meanAdvance(lower) / x.maxY : null,
    wdCaps: H && H.maxY > 0 && upper.size ? meanAdvance(upper) / H.maxY : null,
    sl: slant.sl,
    ...(slant.fromCovariance ? { slFrom: "covariance" as const } : {}),
    xr: x && H && H.maxY > 0 && x.maxY > 0 ? x.maxY / H.maxY : null,
    sq: o ? squarenessOf(o) : null,
    sf: straightShareOf(text),
    ct,
    rev,
    caps,
  };
}

// --- the traits ---

/** fontTools measureWeight: Σ(advance × |area|) / Σ(advance²), per em. */
function weightOf(letters: Letter[], upm: number): number | null {
  let ink = 0;
  let room = 0;
  for (const l of letters) {
    ink += l.advance * Math.abs(l.area);
    room += l.advance * l.advance;
  }
  return room > 0 ? ink / room / upm : null;
}

/**
 * The slant of the letters, from the stems of `stemmed` (the letters in STEM_LETTERS) where there are
 * enough (see stemSlantOf), else from the whole ink of all of them. `band` is the letter whose ink top
 * bounds the stems: 'x' for a face with a lowercase, 'H' for one without.
 */
function slantOf(letters: Letter[], stemmed: Letter[], band: Letter | null): { sl: number | null; fromCovariance: boolean } {
  const whole = covarianceSlantOf(letters);
  const top = band && band.maxY > 0 ? band.maxY : 0;
  const stems = top && stemmed.length ? stemSlantOf(stemmed, top) : null;
  if (!stems || stems.height < MIN_STEM * stemmed.length * (1 - 2 * STEM_INSET) * top) return { sl: whole, fromCovariance: true };
  const pixels = stems.vertical >= STAIRCASE_SHARE * stems.height;
  // A pixel italic: every stem is a stack of exactly vertical steps, so only the whole ink shows the lean.
  if (pixels && whole != null && whole >= STAIRCASE_DEG) return { sl: whole, fromCovariance: true };
  let pieces = 0;
  for (const l of letters) pieces += l.contours.length;
  const texture = pieces > TEXTURE_PIECES * letters.length && !pixels;
  if (texture && whole != null && Math.abs(stems.angle - whole) > TEXTURE_DISAGREE) return { sl: whole, fromCovariance: true };
  return { sl: stems.angle, fromCovariance: false };
}

/**
 * The lean of the stems, in degrees, positive when the top is to the right. Each contour is walked in
 * short even steps (see resample), and consecutive steps that stay within STEM_DEG of vertical, inside
 * the band between STEM_INSET and 1 − STEM_INSET of `top`, keep going the same way (up or down) and
 * turn by less than RUN_TURN from one to the next make a run: one side of a stem or of a bowl. Each
 * run that climbs RUN_MIN of the band or more gives its chord's angle from vertical, and the slant is
 * their mean weighted by height. Below the baseline and above the x-height lie descender tails and
 * ascender loops; off vertical lie joining strokes and the flat parts of bowls. Also returns the runs'
 * total height, and the part of it climbed by exactly vertical steps (a pixel face's).
 */
function stemSlantOf(letters: Letter[], top: number): { angle: number; height: number; vertical: number } {
  const lo = top * STEM_INSET;
  const hi = top * (1 - STEM_INSET);
  const band = hi - lo;
  const limit = Math.tan((STEM_DEG * Math.PI) / 180);
  const corner = (RUN_TURN * Math.PI) / 180;
  let sum = 0;
  let height = 0;
  let vertical = 0;
  let dx = 0;
  let dy = 0;
  let straightUp = 0;
  let lean = 0; // the last step's angle from vertical
  const flush = () => {
    const h = Math.abs(dy);
    if (h >= RUN_MIN * band) {
      sum += h * Math.atan(dx / dy);
      height += h;
      vertical += straightUp;
    }
    dx = 0;
    dy = 0;
    straightUp = 0;
  };
  for (const l of letters) {
    for (const outline of l.contours) {
      const pts = resample(outline, RESAMPLE * band);
      const n = pts.length / 2;
      if (n < 3) continue;
      // The step from point i to the next, clipped to the band, and its angle from vertical; null when
      // it is not part of a stem.
      const step = (i: number): [number, number, number] | null => {
        const j = (i + 1) % n;
        const [ax, ay, bx, by] = [pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]];
        if (ay === by || Math.abs(bx - ax) > limit * Math.abs(by - ay)) return null;
        const y0 = Math.max(Math.min(ay, by), lo);
        const y1 = Math.min(Math.max(ay, by), hi);
        if (y1 <= y0) return null;
        const slope = (bx - ax) / (by - ay);
        const h = (y1 - y0) * Math.sign(by - ay);
        return [slope * h, h, Math.atan(slope)];
      };
      // Start just after a step that is not a stem, so no run wraps around the starting point.
      let start = 0;
      while (start < n && step(start)) start++;
      if (start === n) continue; // a contour that is all stem, a sliver, has no sides to read
      for (let k = 1; k <= n; k++) {
        const s = step((start + k) % n);
        if (!s) {
          flush();
          continue;
        }
        if (dy && (Math.sign(s[1]) !== Math.sign(dy) || Math.abs(s[2] - lean) >= corner)) flush();
        dx += s[0];
        dy += s[1];
        lean = s[2];
        if (s[0] === 0) straightUp += Math.abs(s[1]);
      }
      flush();
    }
  }
  return { angle: height > 0 ? (sum / height) * (180 / Math.PI) : 0, height, vertical };
}

/**
 * The closed polygon walked again in steps of `step` along its outline (its first point kept), so long
 * edges are split and short wiggles are cut across.
 */
function resample(pts: number[], step: number): number[] {
  const n = pts.length / 2;
  if (!(step > 0)) return pts;
  const out = [pts[0], pts[1]];
  let carried = 0; // outline walked since the last point kept
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[2 * i];
    const ay = pts[2 * i + 1];
    const length = Math.hypot(pts[2 * j] - ax, pts[2 * j + 1] - ay);
    let t = step - carried;
    while (t < length) {
      out.push(ax + ((pts[2 * j] - ax) * t) / length, ay + ((pts[2 * j + 1] - ay) * t) / length);
      t += step;
    }
    carried = length - (t - step);
  }
  return out;
}

/**
 * fontTools measureSlant, sign flipped so a forward lean is positive: each letter's StatisticsPen
 * slant, covariance(x, y) / variance(y) of its filled shape, averaged with the advances as weights,
 * then turned into an angle. Joining strokes and tails at the baseline pull it backwards (it had Grand
 * Hotel and Sacramento leaning back, and FT88 School, an upright pixel cursive, at -12°), so it is only
 * the fallback (see slantOf).
 */
function covarianceSlantOf(letters: Letter[]): number | null {
  let sum = 0;
  let weights = 0;
  for (const l of letters) {
    if (!l.area || l.advance <= 0) continue;
    const meanX = l.mx / l.area;
    const meanY = l.my / l.area;
    const varianceY = l.myy / l.area - meanY * meanY;
    const covariance = l.mxy / l.area - meanX * meanY;
    // StatisticsPen counts a shape with no height as no slant.
    const slant = varianceY !== 0 ? covariance / varianceY : 0;
    sum += l.advance * slant;
    weights += l.advance;
  }
  return weights > 0 ? (Math.atan(sum / weights) * 180) / Math.PI : null;
}

function meanAdvance(letters: Map<string, Letter>): number {
  let sum = 0;
  for (const l of letters.values()) sum += l.advance;
  return sum / letters.size;
}

/**
 * The outer contour of 'o' (the one with the most area) against its own box. When that contour is not
 * the whole letter (it spans less than OUTER_SPAN of the letter's width or height), the 'o' is built
 * from pieces (Teko's from four overlapping quarters, a stencil's from two halves), and its silhouette
 * stands in for the outer contour: row by row, from the first ink to the last. A dot-matrix 'o', whose
 * rows of dots leave empty rows between them, has no silhouette to measure and gets null.
 */
function squarenessOf(o: Letter): number | null {
  let best = -1;
  for (let i = 0; i < o.areas.length; i++) if (best < 0 || Math.abs(o.areas[i]) > Math.abs(o.areas[best])) best = i;
  if (best < 0) return null;
  const pts = o.contours[best];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  if (maxX - minX < OUTER_SPAN * (o.maxX - o.minX) || maxY - minY < OUTER_SPAN * (o.maxY - o.minY)) return silhouetteSquareness(o);
  const box = (maxX - minX) * (maxY - minY);
  return box > 0 ? Math.abs(o.areas[best]) / box : null;
}

/** The area inside the letter's silhouette over its box, or null when some rows have no ink at all. */
function silhouetteSquareness(o: Letter): number | null {
  const height = o.maxY - o.minY;
  const width = o.maxX - o.minX;
  if (!(height > 0 && width > 0)) return null;
  let area = 0;
  let empty = 0;
  for (let r = 0; r < SILHOUETTE_ROWS; r++) {
    const runs = inkRuns(o.contours, o.minY + ((r + 0.5) * height) / SILHOUETTE_ROWS, true);
    if (!runs.length) empty++;
    else area += runs[runs.length - 1][1] - runs[0][0];
  }
  if (empty > SILHOUETTE_ROWS * 0.02) return null;
  return (area * height) / SILHOUETTE_ROWS / (width * height);
}

function straightShareOf(letters: Letter[]): number | null {
  let straight = 0;
  let length = 0;
  for (const l of letters) {
    straight += l.straight;
    length += l.length;
  }
  return length > 0 ? straight / length : null;
}

/**
 * The strokes of 'o', from the runs of ink along a horizontal line through the middle of its box and a
 * vertical line through its middle. Each line must meet exactly two runs: the sides are the thicker of
 * the two side runs, the top and bottom the thinner of those two. Null for any other count (pixel,
 * dotted, inline and shadowed o's, and script o's whose entry or exit stroke crosses a line).
 */
function strokesOf(o: Letter): { side: number; topBottom: number } | null {
  const across = inkRuns(o.contours, (o.minY + o.maxY) / 2, true);
  const down = inkRuns(o.contours, (o.minX + o.maxX) / 2, false);
  if (across.length !== 2 || down.length !== 2) return null;
  const side = Math.max(across[0][1] - across[0][0], across[1][1] - across[1][0]);
  const topBottom = Math.min(down[0][1] - down[0][0], down[1][1] - down[1][0]);
  return side > 0 && topBottom > 0 ? { side, topBottom } : null;
}

/**
 * The runs of ink, [start, end], along the line y = at (horizontal) or x = at, in order. The outline's
 * crossings with the line are walked with the nonzero rule fonts are drawn with, so pieces that overlap
 * (an 'o' built from two halves, as Poltawski Nowy's is) make one run, as they do on screen; for an
 * outline with no overlaps this is the plain even-odd pairing of crossings. An edge counts when its ends
 * sit on opposite sides, with an end exactly on the line counted on the low side, so a vertex on the
 * line is crossed once, not twice.
 */
function inkRuns(contours: number[][], at: number, horizontal: boolean): [number, number][] {
  const hits: [number, number][] = [];
  const a = horizontal ? 1 : 0; // the coordinate compared with `at`
  const b = 1 - a; // the coordinate reported
  for (const pts of contours) {
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = pts[2 * i + a];
      const q = pts[2 * j + a];
      if (p > at === q > at) continue;
      const t = (at - p) / (q - p);
      hits.push([pts[2 * i + b] + t * (pts[2 * j + b] - pts[2 * i + b]), q > p ? 1 : -1]);
    }
  }
  hits.sort((m, n) => m[0] - n[0]);
  const runs: [number, number][] = [];
  let winding = 0;
  let start = 0;
  for (const [pos, dir] of hits) {
    if (winding === 0) start = pos;
    winding += dir;
    if (winding === 0 && pos > start) runs.push([start, pos]);
  }
  return runs;
}

/**
 * A lowercase drawn as its capitals: at least half of the letters present in both cases are the same
 * glyph, or a copy of it (same advance and box; some caps faces give 'a' its own glyph holding the 'A'
 * outline). Same idea as core.ts sameDrawing, over more than one letter.
 */
function drawnAsCaps(lower: Map<string, Letter>, upper: Map<string, Letter>): boolean {
  let pairs = 0;
  let same = 0;
  for (const [ch, l] of lower) {
    const u = upper.get(ch.toUpperCase());
    if (!u) continue;
    pairs++;
    if (
      l.id === u.id ||
      (l.advance === u.advance && near(l.minX, u.minX) && near(l.maxX, u.maxX) && near(l.minY, u.minY) && near(l.maxY, u.maxY))
    ) {
      same++;
    }
  }
  return pairs > 0 && same >= pairs * CAPS_SHARE;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

// --- outlines ---

/** The letters of `chars` the font draws with some ink, by character. */
function lettersOf(font: Font, chars: string, upm: number): Map<string, Letter> {
  const letters = new Map<string, Letter>();
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    let glyph: Glyph;
    try {
      if (!font.hasGlyphForCodePoint(cp)) continue;
      glyph = font.glyphForCodePoint(cp);
    } catch {
      continue;
    }
    const letter = glyph ? flatten(glyph, upm) : null;
    if (letter) letters.set(ch, letter);
  }
  return letters;
}

/** One piece of a contour as drawn, for the straight share (see straightness). */
interface Piece {
  /** Its length along the outline (a curve's flattened length). */
  length: number;
  /** A line, or a curve whose control points sit on its chord. */
  straight: boolean;
  /** The chord. */
  dx: number;
  dy: number;
  /** Direction leaving the start and arriving at the end, in radians: the chord's for a straight piece, the tangents for a curve. */
  startDir: number;
  endDir: number;
}

/**
 * The glyph's outline as closed polygons, with its integrals. Null for a glyph with no ink or an
 * outline fontkit cannot decode.
 */
function flatten(glyph: Glyph, upm: number): Letter | null {
  let commands: Glyph["path"]["commands"];
  let advance: number;
  try {
    commands = glyph.path.commands;
    advance = glyph.advanceWidth;
  } catch {
    return null;
  }
  const tolerance = upm * STRAIGHT_TOLERANCE;
  const raw: Contour[] = [];
  const letter: Letter = {
    id: glyph.id,
    advance: Number.isFinite(advance) ? advance : 0,
    contours: [],
    areas: [],
    area: 0,
    mx: 0,
    my: 0,
    myy: 0,
    mxy: 0,
    length: 0,
    straight: 0,
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  let pts: number[] = [];
  let pieces: Piece[] = [];
  let x0 = 0;
  let y0 = 0;

  const to = (x: number, y: number) => {
    pts.push(x, y);
    if (x < letter.minX) letter.minX = x;
    if (x > letter.maxX) letter.maxX = x;
    if (y < letter.minY) letter.minY = y;
    if (y > letter.maxY) letter.maxY = y;
  };
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (!length) return;
    const dir = Math.atan2(dy, dx);
    pieces.push({ length, straight: true, dx, dy, startDir: dir, endDir: dir });
  };
  const close = () => {
    if (pts.length >= 6) {
      // The closing edge, from the last point back to the first, is a straight line.
      line(x0, y0, pts[0], pts[1]);
      const { length, straight } = straightness(pieces, upm * SPAN_MIN, upm * CORNER_SPAN_MIN);
      letter.length += length;
      letter.straight += straight;
      raw.push(contourOf(pts));
    }
    pts = [];
    pieces = [];
  };

  for (const { command, args } of commands) {
    if (command === "closePath") {
      close();
      continue;
    }
    const x = args[args.length - 2];
    const y = args[args.length - 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (command === "moveTo") {
      close();
      to(x, y);
    } else {
      if (!pts.length) to(x0, y0); // a contour that never said where it starts
      if (command === "lineTo") {
        line(x0, y0, x, y);
        to(x, y);
      } else {
        // A quadratic has one control point, a cubic two.
        const controls = command === "quadraticCurveTo" ? [args[0], args[1]] : [args[0], args[1], args[2], args[3]];
        let length = 0;
        let px = x0;
        let py = y0;
        for (let s = 1; s <= STEPS; s++) {
          const [qx, qy] = pointOnCurve(x0, y0, controls, x, y, s / STEPS);
          length += Math.hypot(qx - px, qy - py);
          to(qx, qy);
          px = qx;
          py = qy;
        }
        if (length > 0) {
          if (controlsNearChord(x0, y0, controls, x, y, tolerance)) line(x0, y0, x, y);
          else pieces.push({ length, straight: false, dx: x - x0, dy: y - y0, ...tangents(x0, y0, controls, x, y) });
        }
      }
    }
    x0 = x;
    y0 = y;
  }
  close();
  settle(letter, raw);
  return letter.contours.length && letter.area > 0 ? letter : null;
}

/**
 * One closed contour's outline length and the part of it that is straight. Its straight pieces are
 * joined into spans: a piece joins the span before it when it turns by under MERGE_DEG from both the
 * piece before it and the span's own chord (so a curve stored as many short lines, each turning a
 * little, cannot add up into one long span). A curve piece ends a span. A span counts as straight when
 * it is `minSpan` long (SPAN_MIN of the em), or `minCornered` long (CORNER_SPAN_MIN) with corners of
 * CORNER_DEG or more at both ends; any other span is a stretch of a curve or of a rough edge. So a
 * pixel face (square corners), a faceted face (long facets, sharp joins) and a stem stay straight,
 * while a bowl traced as short lines, or a distressed edge's jags, count as curved.
 */
function straightness(pieces: Piece[], minSpan: number, minCornered: number): { length: number; straight: number } {
  const n = pieces.length;
  let length = 0;
  for (const p of pieces) length += p.length;
  if (!n) return { length, straight: 0 };
  const merge = (MERGE_DEG * Math.PI) / 180;
  const corner = (CORNER_DEG * Math.PI) / 180;
  // Begin just after the sharpest join (or a curve), so no span wraps around the starting point.
  let start = 0;
  let sharpest = -1;
  for (let i = 0; i < n; i++) {
    const prev = pieces[(i + n - 1) % n];
    const t = prev.straight && pieces[i].straight ? turn(prev.endDir, pieces[i].startDir) : Infinity;
    if (t > sharpest) {
      sharpest = t;
      start = i;
    }
  }
  let straight = 0;
  let open = false;
  let spanLength = 0;
  let spanDx = 0;
  let spanDy = 0;
  let turnIn = 0;
  const end = (turnOut: number) => {
    if (open && (spanLength >= minSpan || (spanLength >= minCornered && turnIn >= corner && turnOut >= corner))) straight += spanLength;
    open = false;
  };
  let prevDir = pieces[(start + n - 1) % n].endDir;
  for (let k = 0; k < n; k++) {
    const p = pieces[(start + k) % n];
    const t = turn(prevDir, p.startDir);
    if (!p.straight) {
      end(t);
    } else if (open && t < merge && turn(Math.atan2(spanDy, spanDx), p.startDir) < merge) {
      spanLength += p.length;
      spanDx += p.dx;
      spanDy += p.dy;
    } else {
      end(t);
      open = true;
      spanLength = p.length;
      spanDx = p.dx;
      spanDy = p.dy;
      turnIn = t;
    }
    prevDir = p.endDir;
  }
  end(turn(prevDir, pieces[start].startDir));
  return { length, straight };
}

/** The angle between two directions, 0 to π. */
function turn(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/**
 * A curve's direction leaving its start and arriving at its end: towards the first control point that
 * is not on the start, and from the last that is not on the end.
 */
function tangents(x0: number, y0: number, c: number[], x: number, y: number): { startDir: number; endDir: number } {
  const all = [x0, y0, ...c, x, y];
  let startDir = Math.atan2(y - y0, x - x0);
  let endDir = startDir;
  for (let i = 2; i < all.length; i += 2) {
    if (all[i] !== x0 || all[i + 1] !== y0) {
      startDir = Math.atan2(all[i + 1] - y0, all[i] - x0);
      break;
    }
  }
  for (let i = all.length - 4; i >= 0; i -= 2) {
    if (all[i] !== x || all[i + 1] !== y) {
      endDir = Math.atan2(y - all[i + 1], x - all[i]);
      break;
    }
  }
  return { startDir, endDir };
}

/**
 * Sums the contours into the letter, each signed by its winding relative to the outermost contour
 * around it: an island of ink (a contour nothing encloses) counts positive whichever way it is wound,
 * and what it encloses counts negative when wound against it (a counter) and positive when wound with
 * it (an overlap, counted twice as in fontTools). For a font that winds every outer contour the same
 * way this is fontTools' plain signed sum. Flor de Ruina draws its letters from dots wound half one
 * way and half the other, which the plain sum cancels to nothing; the nonzero rule fonts are drawn
 * with fills every dot.
 */
function settle(letter: Letter, contours: Contour[]) {
  for (const c of contours) {
    let root = c;
    for (const d of contours) if (Math.abs(d.a) > Math.abs(root.a) && encloses(d, c)) root = d;
    const sign = root.a < 0 ? -1 : 1;
    letter.contours.push(c.pts);
    letter.areas.push(sign * c.a);
    letter.area += sign * c.a;
    letter.mx += sign * c.mx;
    letter.my += sign * c.my;
    letter.myy += sign * c.myy;
    letter.mxy += sign * c.mxy;
  }
}

/** Contour `inner` lies inside contour `outer`: inside its box, and (up to eight of) its points inside its polygon. */
function encloses(outer: Contour, inner: Contour): boolean {
  if (inner.minX < outer.minX || inner.maxX > outer.maxX || inner.minY < outer.minY || inner.maxY > outer.maxY) return false;
  const n = inner.pts.length / 2;
  const step = Math.max(1, Math.floor(n / 8));
  for (let i = 0; i < n; i += step) if (!insidePolygon(outer.pts, inner.pts[2 * i], inner.pts[2 * i + 1])) return false;
  return true;
}

/** Even-odd point in polygon. */
function insidePolygon(pts: number[], x: number, y: number): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/**
 * One closed polygon's signed area and moments, by Green's theorem over its edges (the same integrals
 * fontTools' StatisticsPen takes over the exact curves), and its box.
 */
function contourOf(pts: number[]): Contour {
  const n = pts.length / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let a = 0;
  let mx = 0;
  let my = 0;
  let myy = 0;
  let mxy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if (xi < minX) minX = xi;
    if (xi > maxX) maxX = xi;
    if (yi < minY) minY = yi;
    if (yi > maxY) maxY = yi;
    const cross = xi * yj - xj * yi;
    a += cross;
    mx += (xi + xj) * cross;
    my += (yi + yj) * cross;
    myy += (yi * yi + yi * yj + yj * yj) * cross;
    mxy += (xi * yj + 2 * xi * yi + 2 * xj * yj + xj * yi) * cross;
  }
  return { pts, a: a / 2, mx: mx / 6, my: my / 6, myy: myy / 12, mxy: mxy / 24, minX, minY, maxX, maxY };
}

/** A point on a quadratic (one control point) or cubic (two) curve at t. */
function pointOnCurve(x0: number, y0: number, c: number[], x: number, y: number, t: number): [number, number] {
  const u = 1 - t;
  if (c.length === 2) {
    return [u * u * x0 + 2 * u * t * c[0] + t * t * x, u * u * y0 + 2 * u * t * c[1] + t * t * y];
  }
  return [
    u * u * u * x0 + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t * t * t * x,
    u * u * u * y0 + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * y,
  ];
}

/** Every control point within `tolerance` of the chord from (x0, y0) to (x, y). */
function controlsNearChord(x0: number, y0: number, c: number[], x: number, y: number, tolerance: number): boolean {
  const limit = Math.min(tolerance, STRAIGHT_BEND * Math.hypot(x - x0, y - y0));
  for (let i = 0; i < c.length; i += 2) if (distanceToSegment(c[i], c[i + 1], x0, y0, x, y) > limit) return false;
  return true;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const plain = new WeakSet<Font>();

/**
 * Colour fonts are read through their plain outlines, which every COLR font carries for apps without
 * colour support; fontkit's colour glyphs break on newer colour tables. The same fix as core.ts
 * plainOutlines (copied, not shared, so this file stays free of the browser's facts code). Changes
 * how this Font object makes glyphs, once, before any are read.
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
