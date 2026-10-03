// Offline check of src/facts/core.ts against every font file the proxy has cached.
// Run: npm run check:facts. Exits 1 when core.ts throws on a file fontkit could parse, when too
// few files parse, or when the cap heights stop looking like cap heights.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import type { Font } from "fontkit";
import { changedBy, computeFacts, createMeasurer, pathFor } from "../src/facts/core.ts";
import type { FontFacts, RunMetrics, RunPath } from "../src/facts/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// 'é' typed as 'e' plus a separate accent, as pasted or decomposed text arrives.
const DECOMPOSED = "Cafe\u0301 Zoe\u0308";
// Accents with no precomposed letter, so the font's mark positioning has to place them.
const MARKED = "x\u0301 q\u0302 b\u0308";
const DIR = path.join(here, ".cache", "fonts");

const files = (await readdir(DIR)).filter((name) => !name.includes(".")); // skip half-written temp files
if (!files.length) {
  console.log(`No cached fonts in ${DIR}. Scroll the indie fonts in the app first.`);
  process.exit(0);
}

interface Row {
  family: string;
  facts: FontFacts;
}

const rows: Row[] = [];
const unparsed: string[] = [];
const coreErrors: string[] = [];
const invariantErrors: string[] = [];
const joinedScriptWarnings = new Set<string>();
let parseMs = 0;
let factsMs = 0;
let outlinesCompared = 0;

for (const name of files) {
  const bytes = await readFile(path.join(DIR, name));
  let font: Font;
  const t0 = performance.now();
  try {
    const parsed = fontkit.create(bytes);
    font = "fonts" in parsed ? parsed.fonts[0] : parsed;
    if (!font) throw new Error("empty collection");
  } catch (err) {
    unparsed.push(`${name}: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  parseMs += performance.now() - t0;

  // Some files carry an empty or junk name table; fall back to the cache file name.
  const family = [font.fullName, font.familyName].find((s) => s && /\p{L}/u.test(s)) ?? `unnamed ${name.slice(0, 8)}`;
  try {
    const t1 = performance.now();
    const facts = computeFacts(font);
    factsMs += performance.now() - t1;
    const measurer = createMeasurer(font, facts);
    // Exercise everything later features call, so a throw anywhere in core.ts shows up here.
    const plain = measurer.run("Polymodal", { size: 100 });
    const tracked = measurer.run("Polymodal", { size: 100, tracking: 0.05 });
    measurer.run("", { size: 100 });
    const accented = measurer.run("Café & Øre", { size: 56, features: { kern: 0 } });
    const ligatures = measurer.run("office fifty", { size: 56 });
    const decomposed = measurer.run(DECOMPOSED, { size: 100 });
    const marked = measurer.run(MARKED, { size: 100 });
    for (const { tag } of facts.features) {
      changedBy(font, "Rigatoni fi", tag);
      changedBy(font, DECOMPOSED, tag);
    }
    const outline = pathFor(font, "Hamburg", { size: 100, tracking: 0.02 });
    checkInvariants(family, facts, plain, tracked, outline.glyphs.length);
    // Each glyph must name the characters it draws, at their place in the text, ligatures,
    // accents and missing letters included, or badges and letter lineups would point at the wrong letter.
    const lineups = [["Polymodal", plain], ["Café & Øre", accented], ["office fifty", ligatures], [DECOMPOSED, decomposed], [MARKED, marked]] as const;
    // Joined script faces insert connecting strokes, so a plain word shapes to more glyphs than it
    // has letters. fontkit does not say which letter each stroke belongs to, and its reused glyph
    // objects can carry another text's code points, so letter matching is best effort there
    // (known limit: badges and lineups may point at the wrong letter in accented names).
    const joinedScript = plain.glyphs.length > Array.from("Polymodal").length;
    for (const [text, run] of lineups) {
      const lined = run.glyphs.every((g) => text.startsWith(g.char, g.index)) && run.glyphs.map((g) => g.char).join("") === text;
      if (lined) continue;
      if (joinedScript) joinedScriptWarnings.add(family);
      else invariantErrors.push(`${family}: glyphs do not line up with ${JSON.stringify(text)}`);
    }
    // The outlines must sit exactly where the measurer puts the ink, accents included, or the
    // copied SVG would not be what was judged.
    checkOutlines(family, "Hamburg", measurer.run("Hamburg", { size: 100, tracking: 0.02 }), outline);
    checkOutlines(family, DECOMPOSED, decomposed, pathFor(font, DECOMPOSED, { size: 100 }));
    checkOutlines(family, MARKED, marked, pathFor(font, MARKED, { size: 100 }));
    rows.push({ family, facts });
  } catch (err) {
    coreErrors.push(`${family} (${name}): ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  }
}

/** Tracking adds exactly (gaps × tracking × size), with nothing after the last glyph; boxes are sane. */
function checkInvariants(
  family: string,
  facts: FontFacts,
  plain: ReturnType<ReturnType<typeof createMeasurer>["run"]>,
  tracked: typeof plain,
  outlineGlyphs: number,
) {
  const gaps = plain.glyphs.filter((g) => g.advance !== 0).length - 1;
  const expected = plain.advance + gaps * 0.05 * 100;
  if (Math.abs(tracked.advance - expected) > 0.01) invariantErrors.push(`${family}: tracked advance ${tracked.advance} ≠ ${expected}`);
  if (!(plain.advance > 0)) invariantErrors.push(`${family}: 'Polymodal' has no advance`);
  if (plain.inkLeft > plain.inkRight) invariantErrors.push(`${family}: ink box is inside out`);
  if (outlineGlyphs === 0) invariantErrors.push(`${family}: no outline glyphs for 'Hamburg'`);
  if (!(facts.upm > 0)) invariantErrors.push(`${family}: upm ${facts.upm}`);
}

/** Each glyph's outline box must equal its measured ink box, within half a pixel at 100 px. */
function checkOutlines(family: string, text: string, run: RunMetrics, outline: RunPath) {
  if (run.glyphs.length !== outline.glyphs.length) {
    invariantErrors.push(`${family}: ${JSON.stringify(text)} has ${run.glyphs.length} measured glyphs but ${outline.glyphs.length} outlines`);
    return;
  }
  outline.glyphs.forEach((p, i) => {
    const m = run.glyphs[i];
    if (!p.d) return;
    outlinesCompared++;
    const box = pathBox(p.d);
    // The outline's y points down and the measurer's points up.
    const off = Math.max(Math.abs(box.minX - m.inkL), Math.abs(box.maxX - m.inkR), Math.abs(box.minY + m.inkT), Math.abs(box.maxY + m.inkB));
    if (off > 0.5) invariantErrors.push(`${family}: the outline of glyph ${i} in ${JSON.stringify(text)} is ${off.toFixed(1)} px from its measured ink`);
  });
}

/** The ink box of SVG path data as pathFor writes it (absolute M, L, Q, C and Z), with curves sampled. */
function pathBox(d: string) {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  };
  let x0 = 0;
  let y0 = 0;
  for (const [, command, args] of d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/\s+/).map(Number) : [];
    if (command === "Z") continue;
    const [x, y] = n.slice(-2);
    if (command === "Q" || command === "C") {
      // A curve's extremes can lie between its points, so walk along it.
      for (let k = 1; k < 64; k++) {
        const t = k / 64;
        const u = 1 - t;
        if (command === "Q") add(u * u * x0 + 2 * u * t * n[0] + t * t * x, u * u * y0 + 2 * u * t * n[1] + t * t * y);
        else add(u * u * u * x0 + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t * t * t * x, u * u * u * y0 + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t * t * t * y);
      }
    }
    add(x, y);
    x0 = x;
    y0 = y;
  }
  return box;
}

const total = files.length;
const parsed = rows.length + coreErrors.length;
const count = (test: (f: FontFacts) => boolean) => rows.filter((r) => test(r.facts));
const names = (list: Row[]) => list.map((r) => r.family).join(", ");

const withSets = count((f) => f.features.some((x) => /^ss\d\d$/.test(x.tag)));
const capsOnly = count((f) => f.lowerIsCaps || !f.hasLower);
const noKerning = count((f) => !f.hasKerning);
const lacking = (ch: string) => count((f) => !f.covers(ch));
const lackE = lacking("é");
const lackO = lacking("ø");
const lackAmp = lacking("&");
const lackAny = count((f) => !f.covers("é") || !f.covers("ø") || !f.covers("&"));
const capOk = count((f) => f.capHeight >= 0.4 && f.capHeight <= 1.0);

console.log(`files: ${total}`);
console.log(`parsed: ${parsed} (${(parseMs).toFixed(0)} ms to parse, ${factsMs.toFixed(0)} ms for facts)`);
console.log(`with stylistic sets: ${withSets.length}`);
console.log(`caps-only (lowerIsCaps or no a-z): ${capsOnly.length}${capsOnly.length ? ` — ${names(capsOnly)}` : ""}`);
console.log(`lacking é, ø or &: ${lackAny.length}`);
console.log(`  lacking é: ${lackE.length}${lackE.length ? ` — ${names(lackE)}` : ""}`);
console.log(`  lacking ø: ${lackO.length}${lackO.length ? ` — ${names(lackO)}` : ""}`);
console.log(`  lacking &: ${lackAmp.length}${lackAmp.length ? ` — ${names(lackAmp)}` : ""}`);
console.log(`no kerning: ${noKerning.length}`);
console.log(`cap height in 0.4-1.0: ${capOk.length} of ${rows.length}`);
const outliers = rows.filter((r) => r.facts.capHeight < 0.4 || r.facts.capHeight > 1.0);
if (outliers.length) console.log(`  outside: ${outliers.map((r) => `${r.family} ${r.facts.capHeight.toFixed(2)}`).join(", ")}`);
console.log(`glyph outlines checked against their measured ink: ${outlinesCompared}`);
if (unparsed.length) console.log(`fontkit could not parse:\n  ${unparsed.join("\n  ")}`);

let failed = false;
if (coreErrors.length) {
  failed = true;
  console.error(`\nFAIL core.ts threw on ${coreErrors.length} file(s) fontkit parsed:\n  ${coreErrors.join("\n  ")}`);
}
if (joinedScriptWarnings.size) {
  console.log(`joined script faces, letter matching best effort (warning only): ${[...joinedScriptWarnings].join(", ")}`);
}
if (invariantErrors.length) {
  failed = true;
  console.error(`\nFAIL measurement invariants:\n  ${invariantErrors.join("\n  ")}`);
}
if (rows.length && capOk.length < rows.length * 0.95) {
  failed = true;
  console.error(`\nFAIL only ${capOk.length} of ${rows.length} cap heights are in 0.4-1.0 (need 95%).`);
}
// The cache grows as fonts are browsed, so the bar is a share, not a fixed count.
if (parsed < total * 0.98) {
  failed = true;
  console.error(`\nFAIL fontkit parsed only ${parsed} of ${total} files (need 98%).`);
}
console.log(failed ? "\ncheck:facts failed" : "\ncheck:facts ok");
process.exit(failed ? 1 : 0);
