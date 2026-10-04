// How well the vision labels agree with Google's own, on families Google did tag. Run after
// `npm run vision -- --controls N`: npx tsx server/vision-agreement.ts [labels file]
//
// Google's mood strengths come from people rating each family; build-vision.ts asks Claude for the
// same words on the same 40 to 100 scale, from a picture and without the name. Per mood with at
// least 5 positives (Google 50 or more) among the controls, two numbers:
//   AUC       how often a family Google gives the mood outranks one it does not, by Claude's
//             strength (0 when Claude left the mood out). 0.5 is chance, 1 is perfect.
//   Spearman  rank correlation of Claude's strength with Google's over all controls (0 where
//             either left the mood out), so it also rewards getting the strength right.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalog } from "./catalog.ts";

/** Google's 20 Expressive moods, as in build-vision.ts. */
const MOODS = [
  "Active", "Artistic", "Awkward", "Business", "Calm", "Childlike", "Competent", "Cute", "Excited", "Fancy",
  "Futuristic", "Happy", "Innovative", "Loud", "Playful", "Rugged", "Sincere", "Sophisticated", "Stiff", "Vintage",
];
const POSITIVE = 50;
const MIN_POSITIVES = 5;

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.argv[2] ?? path.join(here, "traits", "vision-controls.json"));

let labelled: Record<string, { moods: Record<string, number> }>;
try {
  labelled = (JSON.parse(await readFile(file, "utf8")) as { fonts: typeof labelled }).fonts;
} catch (err) {
  console.error(`Could not read ${file} (run npm run vision -- --controls 60 first): ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const { fonts } = await getCatalog();
const google = new Map(fonts.map((f) => [f.family, f.tagScores ?? {}]));
const families = Object.keys(labelled).filter((family) => google.has(family));
const lost = Object.keys(labelled).length - families.length;
console.log(`${families.length} control families${lost ? ` (${lost} no longer in the catalog, left out)` : ""}.\n`);

const rows: { mood: string; positives: number; auc: number; rho: number }[] = [];
for (const mood of MOODS) {
  const theirs = families.map((f) => google.get(f)![mood] ?? 0);
  const ours = families.map((f) => labelled[f].moods[mood] ?? 0);
  const positives = theirs.filter((g) => g >= POSITIVE).length;
  if (positives < MIN_POSITIVES || positives === families.length) continue;
  rows.push({ mood, positives, auc: auc(ours, theirs.map((g) => g >= POSITIVE)), rho: spearman(ours, theirs) });
}

if (!rows.length) {
  console.log(`No mood has ${MIN_POSITIVES} or more positives yet; label more controls.`);
  process.exit(0);
}
console.log(`${"mood".padEnd(14)} ${"positives".padStart(9)} ${"AUC".padStart(6)} ${"Spearman".padStart(9)}`);
for (const r of rows) console.log(`${r.mood.padEnd(14)} ${String(r.positives).padStart(9)} ${r.auc.toFixed(2).padStart(6)} ${r.rho.toFixed(2).padStart(9)}`);
console.log(`${"average".padEnd(14)} ${"".padStart(9)} ${mean(rows.map((r) => r.auc)).toFixed(2).padStart(6)} ${mean(rows.map((r) => r.rho)).toFixed(2).padStart(9)}`);
console.log(`\n${rows.length} of ${MOODS.length} moods had at least ${MIN_POSITIVES} positives (Google ${POSITIVE} or more).`);

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The chance a random positive scores above a random negative, ties counting half (Mann-Whitney). */
function auc(scores: number[], positive: boolean[]): number {
  const pos = scores.filter((_, i) => positive[i]);
  const neg = scores.filter((_, i) => !positive[i]);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Pearson correlation of the ranks, ties sharing their average rank; 0 when either side is constant. */
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
  const out = new Array<number>(xs.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].x === order[start].x) end++;
    for (let k = start; k <= end; k++) out[order[k].i] = (start + end) / 2 + 1;
    start = end + 1;
  }
  return out;
}
