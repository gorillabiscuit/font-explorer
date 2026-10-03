// Offline check of src/alternates.ts against every font file the proxy has cached, and of the
// METADATA.pb reader and file choice behind /api/google-files and the 'full' variant
// (src/googleMetadata.ts). Run: npm run check:alternates. Exits 1 when the quick test (which skips
// features whose lookups cannot touch the name) gives a different answer from shaping every
// feature, when a set that makes enclosed symbols is offered, or when the choosing helpers, the
// METADATA reader or the choice of an upright or italic full file go wrong.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import type { Font } from "fontkit";
import { altChoices, currentChoice, nextChoice, relevantAlternates, withChoice, type Alternates } from "../src/alternates.ts";
import { computeFacts } from "../src/facts/core.ts";
import { fullFileFor, parseMetadata, slugOf } from "../src/googleMetadata.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, ".cache", "fonts");
const NAMES = ["Polymodal", "Rigatoni", "UNIQLO", "office fjord"];
const ENCLOSED = /circled|squared|enclosed|negative|boxed/i;
const failures: string[] = [];

const files = (await readdir(DIR)).filter((name) => !name.includes(".")); // skip half-written temp files
let parsed = 0;
let compared = 0;
let quickMs = 0;
let exactMs = 0;
const withSets: Record<string, number> = {};
const dropped: string[] = [];

for (const name of files) {
  let font: Font;
  try {
    const created = fontkit.create(await readFile(path.join(DIR, name)));
    font = "fonts" in created ? created.fonts[0] : created;
    if (!font) continue;
  } catch {
    continue; // check:facts reports files fontkit cannot read
  }
  // A variable file is read at its regular weight, as the browser draws it.
  const wght = font.variationAxes?.wght;
  if (wght) font = font.getVariation({ wght: Math.min(wght.max, Math.max(wght.min, 400)) });
  let facts;
  try {
    facts = computeFacts(font);
  } catch {
    continue;
  }
  parsed++;
  const family = [font.fullName, font.familyName].find((s) => s && /\p{L}/u.test(s)) ?? `unnamed ${name.slice(0, 8)}`;
  for (const text of NAMES) {
    let t = performance.now();
    const exact = relevantAlternates(font, facts, text, { quick: false });
    exactMs += performance.now() - t;
    t = performance.now();
    const quick = relevantAlternates(font, facts, text);
    quickMs += performance.now() - t;
    compared++;
    if (summary(quick) !== summary(exact)) failures.push(`${family} "${text}": quick ${summary(quick)} but every feature shaped gives ${summary(exact)}`);
    if (quick.sets.length) withSets[text] = (withSets[text] ?? 0) + 1;
    for (const s of quick.sets) if (s.uiName && ENCLOSED.test(s.uiName)) failures.push(`${family} "${text}": offers ${s.tag} (${s.uiName})`);
    // Sets the font itself names as enclosed forms (never offered, whether or not they touch the name).
    for (const f of facts.features) {
      if (f.uiName && ENCLOSED.test(f.uiName) && !quick.sets.some((s) => s.tag === f.tag) && text === NAMES[0]) dropped.push(`${family} ${f.tag} (${f.uiName})`);
    }
  }
}

function summary(a: Alternates): string {
  const part = (list: Alternates["sets"]) => list.map((s) => `${s.tag}=${s.letters}`).join(",");
  return `[${part(a.sets)}|${part(a.defaults)}]`;
}

// The choosing helpers, on a made-up face with two sets.
const fake: Alternates = {
  sets: [
    { tag: "ss01", uiName: "Single-storey a", letters: "a", indexes: [7] },
    { tag: "cv05", letters: "l", indexes: [2, 8] },
  ],
  letters: "la",
  defaults: [],
};
const choices = altChoices(fake);
expect(choices.map((c) => c.key).join(" "), "default ss01 cv05 all", "the A cycle: default, each set, all");
expect(currentChoice({ kern: 0 }, choices)?.key, "default", "kerning off is no alternate");
expect(currentChoice({ cv05: 1, ss01: 1 }, choices)?.key, "all", "both sets on is All");
expect(JSON.stringify(withChoice({ kern: 0, ss01: 1 }, choices[2])), JSON.stringify({ kern: 0, cv05: 1 }), "a pick keeps kerning, replaces the set");
expect(nextChoice(choices[3], choices).key, "default", "the cycle wraps to Default");
expect(nextChoice(null, choices).key, "default", "unknown features start the cycle at Default");

// The METADATA.pb reader, on a trimmed copy of Space Grotesk's and a static family's.
const variable = parseMetadata(
  `name: "Space Grotesk"\nfonts {\n  name: "Space Grotesk"\n  style: "normal"\n  weight: 400\n  filename: "SpaceGrotesk[wght].ttf"\n}\naxes {\n  tag: "wght"\n  min_value: 300.0\n  max_value: 700.0\n}\nsource {\n  files {\n    source_file: "fonts/ttf/SpaceGrotesk[wght].ttf"\n    dest_file: "SpaceGrotesk[wght].ttf"\n  }\n}\n`,
  "https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk",
);
expect(variable.files.map((f) => f.url).join(" "), "https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf", "variable file URL, brackets escaped");
expect(JSON.stringify(variable.axes), JSON.stringify([{ tag: "wght", min: 300, max: 700 }]), "the weight axis");
const statics = parseMetadata(`fonts {\n  style: "normal"\n  weight: 100\n  filename: "Lato-Thin.ttf"\n}\nfonts {\n  style: "italic"\n  weight: 100\n  filename: "Lato-ThinItalic.ttf"\n}\n`, "base");
expect(statics.files.map((f) => `${f.weight}/${f.style}`).join(" "), "100/normal 100/italic", "static files with their styles");
// Which full file a weight draws from, upright or italic. Italic on means the italic file, and a
// family whose METADATA lists no italic has none to give (nothing is slanted to stand in for one).
const lato = parseMetadata(
  ["Thin:100:normal", "ThinItalic:100:italic", "Regular:400:normal", "Italic:400:italic", "Bold:700:normal", "BoldItalic:700:italic"]
    .map((x) => x.split(":"))
    .map(([name, weight, style]) => `fonts {\n  style: "${style}"\n  weight: ${weight}\n  filename: "Lato-${name}.ttf"\n}\n`)
    .join(""),
  "base",
);
expect(fullFileFor(lato, 400, "normal")?.url, "base/Lato-Regular.ttf", "static upright at 400");
expect(fullFileFor(lato, 400, "italic")?.url, "base/Lato-Italic.ttf", "static italic at 400");
expect(fullFileFor(lato, 650, "italic")?.url, "base/Lato-BoldItalic.ttf", "nearest static italic to 650");
expect(fullFileFor(lato, 650, "italic")?.weight, "650", "a static file keeps the weight asked for as its descriptor");
const lora = parseMetadata(
  `fonts {\n  style: "normal"\n  weight: 400\n  filename: "Lora[wght].ttf"\n}\nfonts {\n  style: "italic"\n  weight: 400\n  filename: "Lora-Italic[wght].ttf"\n}\naxes {\n  tag: "wght"\n  min_value: 400.0\n  max_value: 700.0\n}\n`,
  "base",
);
expect(fullFileFor(lora, 500, "normal")?.url, "base/Lora%5Bwght%5D.ttf", "variable upright");
expect(fullFileFor(lora, 500, "italic")?.url, "base/Lora-Italic%5Bwght%5D.ttf", "variable italic");
expect(fullFileFor(lora, 500, "italic")?.weight, "400 700", "a variable italic declares the weight range");
expect(fullFileFor(variable, 400, "italic"), null, "no italic listed: no italic full file");
expect(fullFileFor(variable, 400, "normal")?.weight, "300 700", "variable upright declares the weight range");
expect(slugOf("Space Grotesk"), "spacegrotesk", "folder name from the family");
expect(slugOf("M PLUS 1p"), "mplus1p", "punctuation and spaces dropped");

function expect(got: unknown, want: unknown, what: string) {
  if (got !== want) failures.push(`${what}: got ${String(got)}, expected ${String(want)}`);
}

console.log(`fonts: ${parsed} parsed of ${files.length} cached files; ${compared} font and name pairs compared`);
console.log(`with a set that changes the name: ${NAMES.map((n) => `${n} ${withSets[n] ?? 0}`).join(", ")}`);
console.log(`time: every feature shaped ${Math.round(exactMs)} ms, then the quick test ${Math.round(quickMs)} ms (on glyphs the first pass already decoded)`);
console.log(`sets the fonts name as enclosed forms, none offered for "${NAMES[0]}": ${dropped.length ? dropped.join(", ") : "none in these files"}`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n${failures.slice(0, 30).join("\n")}`);
  process.exit(1);
}
console.log("\ncheck:alternates ok");
