// Compares two saved runs of eval/run.ts request by request, and prints a table plus totals:
// picks, how many are from the independent foundries, how many are "very common", how many the two
// versions share, time per search, and for the motion requests how many picks lean or are slanted.
// When eval/judgements.json exists (blind A/B votes on the rendered grids), it adds the win count
// and a sign test.
//
//   npx tsx eval/score.ts before after
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalog } from "../server/catalog.ts";
import { loadTraits } from "../server/traits.ts";
import type { FontEntry, VibeResult } from "../src/types.ts";

interface Run {
  id: string;
  kind: string;
  query: string;
  model: string;
  /** The models Claude Code used, when the checkout reports them. */
  models?: string[];
  wallMs?: number;
  results: VibeResult[];
  error?: string;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

/** One request's blind verdicts: which version each judge preferred. */
interface Judgement {
  id: string;
  votes: ("before" | "after" | "tie")[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const [a = "before", b = "after"] = process.argv.slice(2);
const runsA = await loadRuns(a);
const runsB = await loadRuns(b);
const { fonts } = await getCatalog();
const byFamily = new Map<string, FontEntry>(fonts.map((f) => [f.family.toLowerCase(), f]));
const { lookup } = loadTraits();
const INDIE = new Set(["velvetyne", "collletttivo", "tunera", "usemodify", "fontshare"]);

const judgements = new Map<string, Judgement>();
try {
  for (const j of JSON.parse(await readFile(path.join(here, "judgements.json"), "utf8")) as Judgement[]) judgements.set(j.id, j);
} catch {
  // no votes yet
}

const rows: string[][] = [["id", "request", `picks ${a}/${b}`, `indie ${a}/${b}`, `common ${a}/${b}`, "shared", `secs ${a}/${b}`, `leaning ${a}/${b}`, "votes"]];
const totals = { picksA: 0, picksB: 0, indieA: 0, indieB: 0, commonA: 0, commonB: 0, shared: 0, union: 0, secsA: [] as number[], secsB: [] as number[] };
let wins = 0;
let losses = 0;
let ties = 0;
const failed: string[] = [];
for (const [id, ra] of runsA) {
  const rb = runsB.get(id);
  if (!rb) continue;
  // A failed search is no answer; comparing it would count an outage as a loss.
  if (ra.error || rb.error) {
    failed.push(id);
    continue;
  }
  const fa = ra.results.map((r) => r.family.toLowerCase());
  const fb = rb.results.map((r) => r.family.toLowerCase());
  const indie = (list: string[]) => list.filter((f) => INDIE.has(byFamily.get(f)?.source ?? "")).length;
  const common = (list: string[]) => list.filter((f) => byFamily.get(f)?.common).length;
  // Forward lean as the app would draw it upright: measured slant, or a script drawn slanted.
  const leaning = (list: string[]) => list.filter((f) => lookup(byFamily.get(f)?.family ?? f).shape.includes("slanted")).length;
  const shared = fa.filter((f) => fb.includes(f)).length;
  const union = new Set([...fa, ...fb]).size;
  const j = judgements.get(id);
  const score = j ? j.votes.filter((v) => v === b).length - j.votes.filter((v) => v === a).length : 0;
  if (j) {
    if (score > 0) wins++;
    else if (score < 0) losses++;
    else ties++;
  }
  rows.push([
    id,
    ra.query.slice(0, 44),
    `${fa.length}/${fb.length}`,
    `${indie(fa)}/${indie(fb)}`,
    `${common(fa)}/${common(fb)}`,
    `${shared}`,
    `${secs(ra)}/${secs(rb)}`,
    ra.kind === "motion" ? `${leaning(fa)}/${leaning(fb)}` : "",
    j ? j.votes.map((v) => (v === b ? "+" : v === a ? "-" : "=")).join("") : "",
  ]);
  totals.picksA += fa.length;
  totals.picksB += fb.length;
  totals.indieA += indie(fa);
  totals.indieB += indie(fb);
  totals.commonA += common(fa);
  totals.commonB += common(fb);
  totals.shared += shared;
  totals.union += union;
  if (ra.wallMs) totals.secsA.push(ra.wallMs / 1000);
  if (rb.wallMs) totals.secsB.push(rb.wallMs / 1000);
}

const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
for (const r of rows) console.log(r.map((cell, c) => cell.padEnd(widths[c])).join("  "));
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
console.log(`\npicks: ${a} ${totals.picksA}, ${b} ${totals.picksB}`);
console.log(`from independent foundries and Fontshare: ${a} ${pct(totals.indieA, totals.picksA)}, ${b} ${pct(totals.indieB, totals.picksB)}`);
console.log(`"very common": ${a} ${pct(totals.commonA, totals.picksA)}, ${b} ${pct(totals.commonB, totals.picksB)}`);
console.log(`fonts both versions picked: ${pct(totals.shared, totals.union)} of all fonts picked`);
console.log(`seconds per search: ${a} ${mean(totals.secsA).toFixed(1)}, ${b} ${mean(totals.secsB).toFixed(1)}`);
console.log(`errors: ${a} ${[...runsA.values()].filter((r) => r.error).length}, ${b} ${[...runsB.values()].filter((r) => r.error).length}` + (failed.length ? ` (left out: ${failed.join(", ")})` : ""));
// Every model Claude Code used, including its own small Haiku calls next to the answering model.
const used = (runs: Map<string, Run>) => [...new Set([...runs.values()].flatMap((r) => r.models ?? [r.model]))].join(", ");
console.log(`models used: ${a} ${used(runsA)}; ${b} ${used(runsB)}`);
if (judgements.size) {
  const n = wins + losses;
  console.log(`\nblind votes: ${b} better on ${wins} requests, ${a} better on ${losses}, tied on ${ties}`);
  console.log(`sign test (two-sided, ties left out): p = ${signTest(wins, n).toFixed(4)}`);
}

async function loadRuns(label: string): Promise<Map<string, Run>> {
  const dir = path.join(here, "runs", label);
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const runs = new Map<string, Run>();
  for (const n of names) {
    const r = JSON.parse(await readFile(path.join(dir, n), "utf8")) as Run;
    runs.set(r.id, r);
  }
  return runs;
}

function secs(r: Run): string {
  return r.wallMs ? (r.wallMs / 1000).toFixed(0) : "–";
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((100 * part) / whole)}% (${part} of ${whole})` : "–";
}

/** Exact two-sided binomial test of k wins in n untied comparisons against a fair coin. */
function signTest(k: number, n: number): number {
  if (!n) return 1;
  const choose = (n: number, r: number) => {
    let c = 1;
    for (let i = 1; i <= r; i++) c = (c * (n - r + i)) / i;
    return c;
  };
  const tail = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= tail; i++) p += choose(n, i);
  return Math.min(1, (2 * p) / 2 ** n);
}
