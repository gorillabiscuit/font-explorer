// Offline check of server/traits/shape.json, the measured letter shapes `npm run shapes` writes. No
// network. Run: npx tsx server/check-shapes.ts. Exits 1 when the file is malformed or a family whose
// look is well known measures the wrong way (Roboto upright, Kaushan Script leaning, Oswald narrow).
// The spot checks compare a family with the rest of the catalog where they can (bottom 15% for
// width), so they hold when the catalog grows.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ShapeEntry, ShapeFile } from "./shape.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "traits", "shape.json");

let text: string;
let data: ShapeFile;
try {
  text = await readFile(FILE, "utf8");
  data = JSON.parse(text) as ShapeFile;
} catch (err) {
  console.log(`Cannot read ${FILE} (${err instanceof Error ? err.message : err}). Run npm run shapes first.`);
  process.exit(1);
}

const fonts = data.fonts ?? {};
const failed = data.failed ?? {};
const entries = Object.entries(fonts);
type Trait = "w" | "wd" | "sl" | "xr" | "sq" | "sf" | "ct";

/** Share of the measured families with a lower value: 0 is the lowest in the catalog, near 1 the highest. */
function rank(family: string, key: Trait): number {
  const v = fonts[family]?.[key];
  if (v == null) return NaN;
  let below = 0;
  let n = 0;
  for (const [, e] of entries) {
    const x = e[key];
    if (x == null) continue;
    n++;
    if (x < v) below++;
  }
  return below / n;
}

const get = (family: string): Partial<ShapeEntry> => fonts[family] ?? {};
/** A check on a family that may leave the catalog: passes, and says it was skipped, when the family is not measured. */
const ifPresent = (family: string, label: string, test: (e: ShapeEntry) => boolean): [string, boolean] =>
  fonts[family] ? [label, test(fonts[family])] : [`${label} (skipped: not measured)`, true];
const num = (v: unknown): number => (typeof v === "number" ? v : NaN);
const inRange = (v: number | null, lo: number, hi: number) => v == null || (v >= lo && v <= hi);
const collator = new Intl.Collator("en");

// Plausible ranges, wide enough for the odd display face (Redacted is solid boxes, Fungal's 'x' towers
// over its 'H'), narrow enough to catch a unit mistake.
const malformed = entries.filter(
  ([, e]) =>
    !/^https:\/\//.test(e.file) ||
    !Number.isFinite(e.weight) ||
    typeof e.caps !== "boolean" ||
    !inRange(e.w, 0, 1.5) ||
    !inRange(e.wd, 0.1, 4) ||
    !inRange(e.wdCaps, 0.1, 4) ||
    !inRange(e.sl, -45, 45) ||
    !inRange(e.xr, 0, 3) ||
    !inRange(e.sq, 0, 1.001) ||
    !inRange(e.sf, 0, 1) ||
    !inRange(e.ct, 0, 1) ||
    (e.ct == null) !== (e.rev == null),
);
const widthFromCaps = entries.filter(([, e]) => e.wdFromCaps);
// The order as written, read from the text: a parsed object moves number-like names ("3270") to the front.
const fontsBlock = text.slice(text.indexOf('"fonts": {'), text.indexOf('"failed": {'));
const keys = [...fontsBlock.matchAll(/^ {4}("(?:[^"\\]|\\.)*"): \{/gm)].map((m) => JSON.parse(m[1]) as string);

const checks: [string, boolean][] = [
  ["the file has a version and a date", Number.isInteger(data.version) && data.version > 0 && !Number.isNaN(Date.parse(data.measuredAt))],
  ["over 2,000 families measured", entries.length > 2000],
  ["fewer than 2% of families failed", Object.keys(failed).length < 0.02 * (entries.length + Object.keys(failed).length)],
  ["no family is both measured and failed", !Object.keys(failed).some((f) => f in fonts)],
  [
    "one family per line, sorted, so diffs are readable",
    keys.length === entries.length && keys.every((k, i) => i === 0 || collator.compare(keys[i - 1], k) <= 0),
  ],
  [`every value is in a plausible range${malformed.length ? ` (not: ${malformed.slice(0, 5).map(([f]) => f).join(", ")})` : ""}`, !malformed.length],
  ["nothing was measured from velvetyne.fr", !entries.some(([, e]) => /(^|\.)velvetyne\.fr$/.test(new URL(e.file).hostname))],
  ["the caps-to-lowercase width ratio is about 1.1", num(data.capsToLowerWidth) > 1 && num(data.capsToLowerWidth) < 1.3],
  [
    "a caps face's width is its caps width times that ratio",
    widthFromCaps.length > 0 && widthFromCaps.every(([, e]) => Math.abs(num(e.wd) - num(e.wdCaps) * num(data.capsToLowerWidth)) < 0.002),
  ],
  ["only caps faces and faces without an 'x' take their width from the caps", widthFromCaps.every(([f, e]) => e.caps || get(f).xr == null)],

  // Slant. Read from the stems; the whole-ink slant it replaced had upright scripts leaning back.
  [
    "Roboto and FT88 School (an upright pixel cursive whose exit strokes once read as -12°) stand upright (|sl| < 3)",
    Math.abs(num(get("Roboto").sl)) < 3 && Math.abs(num(get("FT88 School").sl)) < 3,
  ],
  [
    "Bebas Neue, Anton and Abril Fatface, upright display faces, stay near 0 (|sl| < 2)",
    ["Bebas Neue", "Anton", "Abril Fatface"].every((f) => Math.abs(num(get(f).sl)) < 2),
  ],
  [
    "Sacramento, Kaushan Script and Racing Sans One lean forward (sl ≥ 7)",
    ["Sacramento", "Kaushan Script", "Racing Sans One"].every((f) => num(get(f).sl) >= 7),
  ],
  [
    "Grand Hotel and Sofia, which Google tags upright scripts, neither lean back nor count as slanted (-5 < sl < 7)",
    ["Grand Hotel", "Sofia"].every((f) => num(get(f).sl) > -5 && num(get(f).sl) < 7),
  ],
  [
    "Rubik Marker Hatch, upright Rubik filled with leaning strokes, stands upright (|sl| < 3)",
    Math.abs(num(get("Rubik Marker Hatch").sl)) < 3,
  ],
  // Width
  ["Roboto Condensed is in the narrowest 15%", rank("Roboto Condensed", "wd") < 0.15],
  ["Oswald is in the narrowest 15%", rank("Oswald", "wd") < 0.15],
  ["Michroma is in the widest 10%", rank("Michroma", "wd") > 0.9],
  // Squareness: a circle is 0.785, a squared o 0.86 or more.
  ["Michroma and Orbitron have squared o's (sq ≥ 0.86)", num(get("Michroma").sq) >= 0.86 && num(get("Orbitron").sq) >= 0.86],
  ["Teko's o, four overlapping pieces, still measures squared", num(get("Teko").sq) >= 0.86],
  // Contrast
  ["Playfair Display is high contrast (ct > 0.5)", num(get("Playfair Display").ct) > 0.5 && get("Playfair Display").rev === false],
  ["Abril Fatface is higher still (ct > 0.8)", num(get("Abril Fatface").ct) > 0.8],
  ["Smokum is reverse contrast", get("Smokum").rev === true],
  ["Roboto is low contrast (ct < 0.3)", num(get("Roboto").ct) < 0.3],
  // Weight
  ["Poiret One is in the lightest 15%", rank("Poiret One", "w") < 0.15],
  ["Julius Sans One is in the lightest 15%", rank("Julius Sans One", "w") < 0.15],
  ["Anton is in the heaviest 5%", rank("Anton", "w") > 0.95],
  // Caps and condensed
  ["Bebas Neue is a caps face", get("Bebas Neue").caps === true],
  ["Anton has a lowercase, and is in the narrowest 15%", get("Anton").caps === false && rank("Anton", "wd") < 0.15],
  ["Roboto has a lowercase, with an x-height about 3/4 of its caps", get("Roboto").caps === false && num(get("Roboto").xr) > 0.68 && num(get("Roboto").xr) < 0.8],
  // Straightness
  ["Silkscreen, a pixel face, is straight (sf > 0.9)", num(get("Silkscreen").sf) > 0.9],
  ["Press Start 2P, a pixel face, is straight (sf > 0.9)", num(get("Press Start 2P").sf) > 0.9],
  ifPresent("Snap-it mono", "Snap-it mono, long facets joined at sharp angles, is straight (sf > 0.9)", (e) => num(e.sf) > 0.9),
  [
    "Winky Rough, Winky Sans traced as short lines, is about as straight as Winky Sans (within 0.1)",
    Math.abs(num(get("Winky Rough").sf) - num(get("Winky Sans").sf)) < 0.1,
  ],
  ["Rubik Dirt, Rubik with a jagged distressed edge, is not in the straightest 10%", rank("Rubik Dirt", "sf") < 0.9],
  ["Roboto is not in the straightest quarter", rank("Roboto", "sf") < 0.75],
  ["Kaushan Script, a brush script, is in the curviest quarter", rank("Kaushan Script", "sf") < 0.25],
  ["Pacifico, a script, is in the curviest 10%", rank("Pacifico", "sf") < 0.1],
  ["Flor de Ruina, letters of dots wound both ways, still has weight", num(get("Flor de Ruina").w) > 0.1],
];

let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`${label}: ${ok ? "ok" : "FAIL"}`);
}
console.log(`\n${entries.length} measured, ${Object.keys(failed).length} failed, ${failures ? `${failures} check(s) FAILED` : "all checks ok"}`);
process.exit(failures ? 1 : 0);
