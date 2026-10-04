// Mood labels for the families Google never tagged. Run: npm run vision (one-off, approved once).
//
// Vibe search matches requests against each family's tags, and Google's mood words (Futuristic,
// Calm, Rugged...) carry most of that weight. About a quarter of the catalog has none: the indie
// foundries, Fontshare, and Google families Google left untagged. They lose to tagged families
// whatever they look like. So Claude Sonnet looks at each one, six to a specimen sheet, and labels
// it in Google's own vocabulary and scale. The sheets carry letters A to F and no names, so the
// labels come from the drawing and not from a name's reputation.
//
// Steps: pick the families (no Google mood, not local), leave out the ones already in
// server/traits/vision.json, put the rest in a fixed shuffled order, and render them six to a sheet
// (specimen.ts). A family whose file will not load, or that the browser cannot draw, is reported
// and the next one takes its place. Each sheet then goes to `claude -p` (claudeCode.ts, your
// subscription), two at a time, and vision.json is written after every sheet, so a stopped run
// keeps what it has and the next run carries on.
//
// Options:
//   --render-only   render the sheets, call nothing
//   --limit N       only the first N sheets
//   --controls N    instead, label N Google families that do have Google's moods, spread across
//                   the moods, into vision-controls.json; vision-agreement.ts then compares the two
//   --all           relabel families that already have labels
//   --out DIR       where the sheets go (default: font-explorer/vision in the temp folder)
import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { FontEntry } from "../src/types.ts";
import { getCatalog } from "./catalog.ts";
import { claudeCode, type ClaudeCodeResult } from "./claudeCode.ts";
import { loadRegularFont, regularFile } from "./fontFiles.ts";
import { renderSheet, type FontCheck } from "./specimen.ts";

/** Google's 20 Expressive moods, the words fonts.google.com filters on. */
const MOODS = [
  "Active", "Artistic", "Awkward", "Business", "Calm", "Childlike", "Competent", "Cute", "Excited", "Fancy",
  "Futuristic", "Happy", "Innovative", "Loud", "Playful", "Rugged", "Sincere", "Sophisticated", "Stiff", "Vintage",
];
/** Google's Theme tags. Most families have none. */
const THEMES = [
  "Art Deco", "Art Nouveau", "Blackletter", "Blobby", "Brush", "Distressed", "Inline", "Medieval", "Pixel", "Shaded",
  "Stencil", "Techno", "Tuscan", "Wacky", "Woodtype",
];
const MOOD_SET = new Set(MOODS);

const MODEL = "claude-sonnet-5-5";
/** Changing the seed reshuffles every sheet; keep it while a run is under way. */
const SEED = "font-explorer vision v1";
const LABELS = "ABCDEF";
const CALLS_AT_ONCE = 2;
const DOWNLOADS_AT_ONCE = 6;
const CALL_TIMEOUT_MS = 180_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const TRAITS = path.join(here, "traits");
// The sheets are not kept in the repo; --out puts them somewhere to look at afterwards.
const DEFAULT_OUT = path.join(os.tmpdir(), "font-explorer", "vision");

const { values: opts } = parseArgs({
  options: {
    "render-only": { type: "boolean", default: false },
    limit: { type: "string" },
    controls: { type: "string" },
    all: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const limit = count(opts.limit, "--limit") ?? Infinity;
const controls = count(opts.controls, "--controls");
const outDir = path.resolve(opts.out ?? DEFAULT_OUT);
const kind = controls ? "controls" : "sheets";
const sheetDir = path.join(outDir, kind);
const indexFile = path.join(outDir, `${kind}.json`);
const labelsFile = path.join(TRAITS, controls ? "vision-controls.json" : "vision.json");

interface Labels {
  moods: Record<string, number>;
  themes: Record<string, number>;
  look: string[];
  note: string;
  sheet: string;
  at: string;
}

interface LabelsFile {
  version: 1;
  model: string;
  fonts: Record<string, Labels>;
}

interface Row {
  label: string;
  font: FontEntry;
  check: FontCheck;
}

interface Sheet {
  name: string;
  png: string;
  rows: Row[];
}

async function renderAll(): Promise<Sheet[]> {
  const index = await readJson<Record<string, { label: string; family: string; source: string; missing?: string }[]>>(indexFile, {});
  const out: Sheet[] = [];
  let next = 0;
  /** The next family in the queue whose file arrives, or null when the queue is done. */
  const nextLoadable = async (): Promise<{ font: FontEntry; bytes: Buffer } | null> => {
    while (next < queue.length) {
      // Ask for a few ahead, so downloads overlap with rendering.
      for (const f of queue.slice(next, next + DOWNLOADS_AT_ONCE * 2)) fetchBytes(f).catch(() => {});
      const font = queue[next++];
      try {
        return { font, bytes: await fetchBytes(font) };
      } catch (err) {
        skip(font, err instanceof Error ? err.message : String(err));
      }
    }
    return null;
  };

  while (out.length < limit) {
    const name = `sheet-${String(firstNumber + out.length).padStart(3, "0")}`;
    const png = path.join(sheetDir, `${name}.png`);
    let rows: { font: FontEntry; bytes: Buffer }[] = [];
    let checks: FontCheck[] = [];
    // A family the browser cannot draw is dropped and the next one takes its row.
    for (;;) {
      while (rows.length < LABELS.length) {
        const r = await nextLoadable();
        if (!r) break;
        rows.push(r);
      }
      if (!rows.length) return out;
      checks = await render(rows.map((r, i) => ({ label: LABELS[i], bytes: r.bytes })), png);
      const failed = new Set(checks.flatMap((c, i) => (c.status === "failed" ? [i] : [])));
      if (!failed.size) break;
      for (const i of failed) skip(rows[i].font, checks[i].reason ?? "could not be drawn");
      rows = rows.filter((_, i) => !failed.has(i));
    }
    const sheet: Sheet = { name, png, rows: rows.map((r, i) => ({ label: LABELS[i], font: r.font, check: checks[i] })) };
    out.push(sheet);
    index[name] = sheet.rows.map((r) => ({ label: r.label, family: r.font.family, source: r.font.source, ...(r.check.missing ? { missing: r.check.missing } : {}) }));
    await writeJson(indexFile, sortKeys(index));
    console.log(`${name}: ${sheet.rows.map((r) => `${r.label} ${r.font.family}`).join(", ")}`);
  }
  return out;
}

/** Chrome once more on a failure, then the run stops: every later sheet would fail the same way. */
async function render(rows: { label: string; bytes: Buffer }[], png: string): Promise<FontCheck[]> {
  try {
    return await renderSheet(rows, png);
  } catch (err) {
    console.warn(`  ${path.basename(png)}: ${err instanceof Error ? err.message : err}; trying again`);
    return renderSheet(rows, png);
  }
}

function skip(f: FontEntry, reason: string) {
  skipped.push(`${f.family} (${f.source}): ${reason}`);
  console.log(`  skipped ${f.family} (${f.source}): ${reason}`);
}

const downloads = new Map<FontEntry, Promise<Buffer>>();
let downloading = 0;
const waiting: (() => void)[] = [];

/** The family's Regular file, fetched once, with a few at a time and one retry. */
function fetchBytes(f: FontEntry): Promise<Buffer> {
  let p = downloads.get(f);
  if (!p) {
    p = (async () => {
      if (!regularFile(f)) throw new Error("no upright file to fetch");
      if (downloading >= DOWNLOADS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
      else downloading++;
      try {
        return (
          await loadRegularFont(f).catch(async () => {
            await new Promise((r) => setTimeout(r, 1500));
            return loadRegularFont(f);
          })
        ).bytes;
      } finally {
        const nextInLine = waiting.shift();
        if (nextInLine) nextInLine();
        else downloading--;
      }
    })();
    downloads.set(f, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------

const SYSTEM = `You label typefaces for a font browser, in the vocabulary Google Fonts uses to tag its own families.

You are given one specimen sheet, a PNG image: up to six typefaces, one per row, labelled A to F at the left. Every row sets the same text at the same size: "Rafgkwy Hamburgefonstiv" on the first line and "RAFGKWY HAMBURG 2049" on the second. Read the image with the Read tool, then judge each typeface only by what you see in its letterforms: proportions, stroke, contrast, terminals, construction, spacing, texture.
You are not told the fonts' names. Do not guess them, and do not let a guess about which font it might be steer the labels.
A gap in a row means the font has no glyph for that character; ignore it. A row of bars, blocks or symbols instead of letters is a symbol font; label what you see.

For each typeface give:
- moods: the Google Fonts moods that clearly apply, chosen only from this list: ${MOODS.join(", ")}. Give each a strength on Google's scale from 40 to 100: 100 is the defining feel of the face, 70 is clearly there, 40 is noticeable. Leave out any mood under 40. At most 6; Google gives most families 3 to 5.
- themes: the Google Fonts themes that apply, chosen only from: ${THEMES.join(", ")}. Same 40 to 100 scale. Usually none: give a theme only when the face plainly is one.
- look: 2 to 5 plain words or short phrases for what the letters look like (for example condensed, wide, rounded, stencil, monoline, high contrast, slab serifs, ink traps, slanted, outline).
- note: one line, under 14 words, on what the letters look like.

Answer for every row on the sheet, in order (A, B, C, ...).`;

interface Answer {
  letter: string;
  moods: { mood: string; strength: number }[];
  themes: { theme: string; strength: number }[];
  look: string[];
  note: string;
}

/** One entry per row, in order; the tag names and strengths can only be Google's. */
function answerSchema(letters: string[]) {
  const strength = { type: "integer", minimum: 40, maximum: 100 };
  const tagged = (key: string, names: string[], maxItems: number) => ({
    type: "array",
    maxItems,
    items: {
      type: "object",
      properties: { [key]: { type: "string", enum: names }, strength },
      required: [key, "strength"],
      additionalProperties: false,
    },
  });
  return {
    type: "object",
    properties: {
      fonts: {
        type: "array",
        minItems: letters.length,
        maxItems: letters.length,
        items: {
          type: "object",
          properties: {
            letter: { type: "string", enum: letters },
            moods: tagged("mood", MOODS, 6),
            themes: tagged("theme", THEMES, 3),
            look: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", maxLength: 40 } },
            note: { type: "string", maxLength: 120 },
          },
          required: ["letter", "moods", "themes", "look", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["fonts"],
    additionalProperties: false,
  };
}

type Reply = ClaudeCodeResult & { total_cost_usd?: number; num_turns?: number };

async function labelAll(sheets: Sheet[]) {
  console.log(`\nLabelling ${sheets.length} sheet(s) with ${MODEL}, ${CALLS_AT_ONCE} at a time.`);
  const labelStart = Date.now();
  const failed: string[] = [];
  const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
  let next = 0;
  const worker = async () => {
    while (next < sheets.length) {
      const sheet = sheets[next++];
      for (let attempt = 1; ; attempt++) {
        const t0 = Date.now();
        try {
          const { answers, reply } = await labelSheet(sheet);
          totals.calls++;
          totals.input += reply.usage?.input_tokens ?? 0;
          totals.cacheRead += reply.usage?.cache_read_input_tokens ?? 0;
          totals.cacheWrite += reply.usage?.cache_creation_input_tokens ?? 0;
          totals.output += reply.usage?.output_tokens ?? 0;
          totals.cost += reply.total_cost_usd ?? 0;
          await record(sheet, answers);
          console.log(
            `${sheet.name} labelled in ${seconds(t0)} (Claude Code: ${((reply.duration_ms ?? 0) / 1000).toFixed(1)} s, ${reply.num_turns ?? "?"} turns; ` +
              `tokens in ${reply.usage?.input_tokens ?? "?"}, cache read ${reply.usage?.cache_read_input_tokens ?? "?"}, ` +
              `cache write ${reply.usage?.cache_creation_input_tokens ?? "?"}, out ${reply.usage?.output_tokens ?? "?"}` +
              `${reply.total_cost_usd !== undefined ? `; $${reply.total_cost_usd.toFixed(4)} at API prices, not billed` : ""})`,
          );
          for (const a of answers) console.log(`  ${a.letter} ${describe(sheet, a)}`);
          break;
        } catch (err) {
          console.warn(`${sheet.name} attempt ${attempt} failed after ${seconds(t0)}: ${err instanceof Error ? err.message : err}`);
          if (attempt === 2) {
            failed.push(sheet.name);
            break;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CALLS_AT_ONCE, sheets.length) }, worker));
  console.log(
    `\nLabelled ${sheets.length - failed.length} of ${sheets.length} sheet(s) in ${seconds(labelStart)}; ` +
      `${totals.calls} call(s), tokens in ${totals.input}, cache read ${totals.cacheRead}, cache write ${totals.cacheWrite}, out ${totals.output}` +
      (totals.cost ? `, $${totals.cost.toFixed(2)} at API prices (the subscription pays)` : "") +
      `. Written to ${path.relative(process.cwd(), labelsFile)}.`,
  );
  if (failed.length) {
    console.log(`Not labelled: ${failed.join(", ")}. Run again to retry them.`);
    process.exitCode = 1;
  }
}

async function labelSheet(sheet: Sheet): Promise<{ answers: Answer[]; reply: Reply }> {
  const letters = sheet.rows.map((r) => r.label);
  const reply = (await claudeCode({
    system: SYSTEM,
    prompt: `Read the specimen sheet ${path.basename(sheet.png)} in the current folder and label its ${letters.length} typefaces, rows ${letters.join(", ")}.`,
    model: MODEL,
    effort: "low",
    tools: ["Read"],
    cwd: sheetDir,
    schema: answerSchema(letters),
    timeoutMs: CALL_TIMEOUT_MS,
  })) as Reply;
  const answers = (reply.structured_output as { fonts?: Answer[] } | undefined)?.fonts;
  if (!Array.isArray(answers)) throw new Error(`no structured answer (got: ${String(reply.result ?? "").slice(0, 200)})`);
  const seen = answers.map((a) => a.letter).sort().join("");
  if (seen !== letters.join("")) throw new Error(`answered rows ${seen || "none"}, expected ${letters.join("")}`);
  return { answers, reply };
}

let writing = Promise.resolve();

/** Adds a sheet's labels and rewrites the file, one write at a time. */
function record(sheet: Sheet, answers: Answer[]): Promise<void> {
  const at = new Date().toISOString();
  for (const a of answers) {
    const row = sheet.rows.find((r) => r.label === a.letter)!;
    saved.fonts[row.font.family] = {
      moods: strongestFirst(a.moods.map((m) => [m.mood, m.strength])),
      themes: strongestFirst(a.themes.map((t) => [t.theme, t.strength])),
      look: [...new Set(a.look.map((w) => w.trim().toLowerCase()).filter(Boolean))],
      note: a.note.trim(),
      sheet: sheet.name,
      at,
    };
  }
  writing = writing.then(() => writeJson(labelsFile, { version: 1, model: MODEL, fonts: sortKeys(saved.fonts) }));
  return writing;
}

/** A tag given twice keeps its higher strength. */
function strongestFirst(pairs: [string, number][]): Record<string, number> {
  const best = new Map<string, number>();
  for (const [name, n] of pairs) best.set(name, Math.max(n, best.get(name) ?? 0));
  return Object.fromEntries([...best].sort((a, b) => b[1] - a[1]));
}

function describe(sheet: Sheet, a: Answer): string {
  const row = sheet.rows.find((r) => r.label === a.letter)!;
  const moods = a.moods.map((m) => `${m.mood} ${m.strength}`).join(", ") || "none";
  const themes = a.themes.map((t) => `${t.theme} ${t.strength}`).join(", ") || "none";
  return `${row.font.family} (${row.font.source}): moods ${moods}; themes ${themes}; look ${a.look.join(", ")}; "${a.note}"`;
}

// ---------------------------------------------------------------------------------------------

/**
 * Google families with Google's own moods, for checking the labels against people's: taken in
 * turn from each mood's families (those Google gives it 50 or more), so every mood has positives.
 */
function pickControls(candidates: FontEntry[], n: number): FontEntry[] {
  const ordered = shuffled(candidates);
  const byMood = MOODS.map((m) => ordered.filter((f) => (f.tagScores?.[m] ?? 0) >= 50));
  const cursors = MOODS.map(() => 0);
  const picked = new Set<FontEntry>();
  for (let progress = true; progress && picked.size < n; ) {
    progress = false;
    for (let m = 0; m < MOODS.length && picked.size < n; m++) {
      while (cursors[m] < byMood[m].length && picked.has(byMood[m][cursors[m]])) cursors[m]++;
      if (cursors[m] < byMood[m].length) {
        picked.add(byMood[m][cursors[m]++]);
        progress = true;
      }
    }
  }
  return [...picked];
}

/** A fixed order that looks random: by a hash of the seed and the family name. */
function shuffled(list: FontEntry[]): FontEntry[] {
  const key = (f: FontEntry) => createHash("sha1").update(`${SEED}\0${f.family}`).digest("hex");
  return list.map((f) => ({ f, k: key(f) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map(({ f }) => f);
}

function bySource(list: FontEntry[]): string {
  const n = new Map<string, number>();
  for (const f of list) n.set(f.source, (n.get(f.source) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([s, k]) => `${s} ${k}`).join(", ");
}

async function readLabels(): Promise<LabelsFile> {
  const file = await readJson<Partial<LabelsFile>>(labelsFile, {});
  return { version: 1, model: MODEL, fonts: file.fonts ?? {} };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Written aside and renamed into place, so a run stopped mid-write leaves the last good file. */
async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 1) + "\n");
  await rename(temp, file);
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function count(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} wants a whole number above 0, got "${text}"`);
  return n;
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------------------------
// The run. Down here so the module state above is in place before it starts.

const started = Date.now();
const { fonts } = await getCatalog();
const hasMood = (f: FontEntry) => Object.keys(f.tagScores ?? {}).some((k) => MOOD_SET.has(k));
// Barcodes, redaction blocks and symbol sets draw no letters, so a mood read off them would only
// mislead the search. Google's own 'Special use' tags mark most; the rest are named.
const SYMBOL_TAGS = new Set(["Barcode", "Redaction", "Symbols"]);
const SYMBOL_FAMILIES = new Set(["Bravura", "Bravura Text", "DSEG Weather", "Material Symbols"]);
const isSymbols = (f: FontEntry) => SYMBOL_FAMILIES.has(f.family) || f.tags.some((t) => SYMBOL_TAGS.has(t));
const chosen = controls
  ? pickControls(fonts.filter((f) => f.source === "fontsource" && hasMood(f) && regularFile(f)), controls)
  : fonts.filter((f) => f.source !== "local" && !hasMood(f) && !isSymbols(f));
console.log(`${chosen.length} ${controls ? "control" : "target"} families: ${bySource(chosen)}`);

const saved = await readLabels();
const todo = opts.all ? chosen : chosen.filter((f) => !saved.fonts[f.family]);
if (todo.length < chosen.length) console.log(`${chosen.length - todo.length} already labelled in ${path.relative(process.cwd(), labelsFile)}; ${todo.length} to go`);
const queue = shuffled(todo);

// Sheet numbers carry on from the last run, so a sheet's name keeps pointing at the same picture.
const firstNumber = opts.all ? 1 : Math.max(0, ...Object.values(saved.fonts).map((l) => Number(/(\d+)$/.exec(l.sheet)?.[1] ?? 0))) + 1;

await mkdir(sheetDir, { recursive: true });
const skipped: string[] = [];
const sheets = await renderAll();
const partial = sheets.flatMap((s) => s.rows.filter((r) => r.check.status === "partial").map((r) => `${r.font.family} (${s.name} ${r.label}: no ${r.check.missing})`));
console.log(`\nRendered ${sheets.length} sheet(s) of ${sheets.reduce((n, s) => n + s.rows.length, 0)} families into ${sheetDir} in ${seconds(started)}.`);
if (skipped.length) console.log(`Skipped ${skipped.length}:\n  ${skipped.join("\n  ")}`);
if (partial.length) console.log(`Drawn with characters missing (left blank on the sheet), ${partial.length}:\n  ${partial.join("\n  ")}`);

if (!opts["render-only"] && sheets.length) await labelAll(sheets);
