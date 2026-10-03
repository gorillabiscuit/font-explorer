import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FORMATION_ORDER } from "../src/recipe.ts";
import { CATEGORIES, INDIE_SOURCES, SOURCES, type Category, type FontEntry, type Source, type VibeRequest, type VibeResponse, type VibeResult, type VibeWordmark } from "../src/types.ts";

// Vibe search runs through Claude Code (`claude -p`), so it uses your Claude subscription, not API billing.

/** Fast is the point here. Override with VIBE_MODEL in .env to try another model. */
export const VIBE_MODEL = process.env.VIBE_MODEL || "claude-haiku-4-5-20251001";
/** Set CLAUDE_BIN in .env when `claude` is not on the server's PATH. */
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = 120_000;

const PICKS = {
  type: "array",
  items: {
    type: "object",
    properties: { family: { type: "string" }, reason: { type: "string" } },
    required: ["family", "reason"],
    additionalProperties: false,
  },
};

// Two lists on purpose: told in prose to use the indie sources, the fast model still reached for the
// usual Google clichés (3 indie picks of 17); a list of its own to fill works far better.
const RESULT_SCHEMA = {
  type: "object",
  properties: { independent: PICKS, others: PICKS },
  required: ["independent", "others"],
  additionalProperties: false,
};

/** The sources that fill the "independent" list. */
const VIBE_INDIE: Source[] = ["velvetyne", "collletttivo", "tunera", "usemodify"];

const INSTRUCTIONS = `You help a designer choose typefaces for a logo or wordmark.

You get a catalog of the fonts available to them, one per line as "family | category | sources | tags", and a list of fonts installed on their machine (source "local").
Sources: velvetyne, collletttivo and tunera are independent libre foundries with experimental, characterful type; usemodify is a hand-picked list of libre fonts; fontshare is a small curated foundry collection; fontsource is the Google Fonts library. Tags come from those sources; many fonts have none, so also use what you know about each typeface's letterforms. "very common" marks the most-used Google Fonts.

The designer finds the usual web fonts boring. Unless a request asks for something plain, neutral or safe, do not pick fonts marked "very common", avoid generic UI workhorses and the obvious genre clichés, and favour distinctive type with a point of view.
The independent sources describe fonts in their own words (brutalist, pixel, wonky, generative, fantasy, mechanistic, hard-to-read...) rather than Google's mood tags (Futuristic, Techno, Business...), so do not match tag words literally: think about what each face actually looks like.
Each request describes a feeling or direction ("more technological", "slick and professional", "a bit more sci-fi, but still legible"). Pick the 15 to 20 catalog fonts that best answer it, in two lists, each best match first:
- "independent": 6 to 8 picks whose sources include velvetyne, collletttivo, tunera or usemodify. Give fewer only if the request asks for something plain, neutral or safe, or the constraints rule those sources out.
- "others": the rest of your picks, from any source.

Rules:
- Only pick families that appear in the catalog, spelled exactly as listed.
- Never pick a font from the culled list. Treat culled fonts as taste the designer rejected, and steer away from close relatives of them.
- The shortlist shows what the designer already likes. Use it to read their taste. Prefer fresh discoveries over repeating shortlisted fonts.
- Follow-ups build on earlier turns. "#3" means the third font in the current results list.
- Respect any source or category constraint you are given.
- Think about wordmark use: distinctive letterforms, how it holds up large and small.
- Judge each pick on how it sets the given wordmark: its actual letters, the case, and the layout. Avoid caps-only faces for names with lowercase; for stacked or block layouts favour faces whose letters have even widths.

Answer with {"independent": [{"family": "Exact Family Name", "reason": "one short line on the specific letterform traits that fit"}], "others": [...]}.
Use the structured output tool if you have one; otherwise reply with only that JSON, no prose and no code fences.
Keep each reason under 14 words and concrete (e.g. "squared counters and a wide stance read as engineered").`;

interface FamilyInfo {
  family: string;
  /** Every source that carries the family (used for the source filter). */
  sources: Set<Source>;
  /** The source of the surviving catalog row: what the family really is (a Google family also listed on Use & Modify is Google). */
  primary: Set<Source>;
  categories: Set<Category>;
}

let catalogCache: { fonts: FontEntry[]; text: string; families: Map<string, FamilyInfo> } | null = null;

/** Everything sent to Claude, built without calling it, so it can be inspected. */
export function buildPrompt(req: VibeRequest, fonts: FontEntry[]) {
  const catalog = compactCatalog(fonts);

  // Installed fonts are listed in full, including ones also in the catalog, so "local only" sees all of them.
  const installed = new Map<string, { family: string; category: Category }>();
  for (const f of req.localFonts ?? []) installed.set(f.family.toLowerCase(), f);
  const familyName = (key: string) => catalog.families.get(key)?.family ?? installed.get(key)?.family;

  const { sources, categories } = req.constraints ?? { sources: [], categories: [] };
  const sourceLimit = sources?.length && sources.length < SOURCES.length ? new Set(sources) : null;
  const categoryLimit = categories?.length && categories.length < CATEGORIES.length ? new Set(categories) : null;
  /** Whether a family is available under the filters the user has on, from any of its sources. */
  const fits = (key: string) => {
    const info = catalog.families.get(key);
    const local = installed.get(key);
    const famSources = new Set<Source>(info?.sources);
    const famCategories = new Set<Category>(info?.categories);
    if (local) {
      famSources.add("local");
      famCategories.add(local.category);
    }
    return (
      (!sourceLimit || [...famSources].some((x) => sourceLimit.has(x))) &&
      (!categoryLimit || [...famCategories].some((x) => categoryLimit.has(x)))
    );
  };

  // Stable between searches (only the installed list can change it), so Claude Code's prompt cache keeps hitting.
  const system = [INSTRUCTIONS, `CATALOG\n${catalog.text}`];
  if (installed.size) {
    system.push(
      `INSTALLED ON THIS MACHINE (source "local"), one per line as "family | category"\n` +
        // Sorted, so the grid's current order (which reshuffles) never changes the cached prompt.
        [...installed.values()]
          .sort((a, b) => a.family.localeCompare(b.family))
          .map((f) => `${f.family} | ${f.category}`)
          .join("\n"),
    );
  }

  const parts: string[] = [];
  // What the type is for. It goes here, in the user prompt, so the cached system prompt stays the
  // same whatever the name, layout and brief.
  const descriptor = oneLine(req.wordmark?.descriptor, 120);
  const brief = oneLine(req.brief, 400);
  const about = [describeWordmark(req.wordmark), descriptor && `Descriptor: ${descriptor}`, brief && `Brief: ${brief}`].filter(Boolean);
  if (about.length) parts.push(about.join("\n"));
  const history = (req.history ?? []).slice(-4);
  if (history.length) {
    parts.push(
      "Earlier in this conversation, oldest first:\n" +
        history.map((t, i) => `${i + 1}. I asked: ${t.query}\n   You picked: ${t.results.map((r) => r.family).join(", ")}`).join("\n"),
    );
  }
  if (req.shortlist?.length) parts.push(`Shortlist (fonts I like): ${req.shortlist.slice(-40).join(", ")}`);
  if (req.culled?.length) parts.push(`Culled (rejected, never suggest): ${req.culled.slice(-60).join(", ")}`);
  const current = history.at(-1)?.results;
  if (current?.length) {
    parts.push(`Current results, numbered:\n${current.map((r, i) => `#${i + 1} ${r.family}`).join("\n")}`);
  }
  if (sourceLimit) {
    parts.push(
      `Only pick fonts available from: ${sources.join(", ")}` +
        (sourceLimit.has("local") ? ' ("local" means the installed list)' : ""),
    );
  }
  if (categoryLimit) parts.push(`Only pick from categories: ${categories.join(", ")}`);
  parts.push(`Request: ${req.query.trim()}`);

  /** Whether a family is available from one of the indie sources that fill the "independent" list. */
  const isIndie = (key: string) => [...(catalog.families.get(key)?.primary ?? [])].some((x) => VIBE_INDIE.includes(x));

  return { system: system.join("\n\n"), prompt: parts.join("\n\n"), familyName, fits, isIndie };
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * One line on the name being set, e.g. 'Wordmark: "UNIQLO" set in capitals as a two-row block (UNI/QLO)'.
 * Null when the request carries no name (a page from before names were sent).
 */
export function describeWordmark(w: Partial<VibeWordmark> | undefined): string | null {
  const name = oneLine(w?.text, 120);
  if (!name) return null;
  const lines = (typeof w?.rendered === "string" ? w.rendered.slice(0, 240) : "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const formation = FORMATION_ORDER.find((f) => f === w?.formation) ?? "line";
  const shown = lines.join("/");
  const count = NUMBER_WORDS[lines.length] ?? String(lines.length);
  const lower = /\p{Ll}/u.test(name);
  const upper = /\p{Lu}/u.test(name);
  const cased =
    w?.textCase === "upper" || (upper && !lower) ? " in capitals" : w?.textCase === "lower" || (lower && !upper) ? " in lowercase" : upper ? " in mixed case" : "";
  const stacked = lines.length > 1 ? `as a ${count}-line stack (${shown})` : "on one line";
  const shape = {
    line: "on one line",
    stack: stacked,
    block: lines.length > 1 ? `as a ${count}-row block (${shown})` : "as a block of equal letter cells",
    lockup: `${stacked}, with a smaller descriptor line`,
    mark: shown ? `as a monogram of its initials (${shown})` : "as a monogram of its initials",
  }[formation];
  return `Wordmark: "${name}" set${cased} ${shape}`;
}

/** A request field as one trimmed line, capped, so a stray paste cannot bloat the prompt. */
function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function vibeSearch(req: VibeRequest, fonts: FontEntry[], signal?: AbortSignal): Promise<VibeResponse> {
  const { system, prompt, familyName, fits, isIndie } = buildPrompt(req, fonts);
  const reply = await askClaudeCode(system, prompt, signal);

  const lists = readPicks(reply.structured_output) ?? parseReply(reply.result ?? "");
  const culled = new Set((req.culled ?? []).map((f) => f.toLowerCase()));
  const { results, dropped } = mergePicks(lists, { familyName, fits, isIndie, culled });
  if (!results.length) {
    throw new Error(`Claude returned no usable fonts. Raw reply: ${(reply.result ?? JSON.stringify(reply.structured_output) ?? "").slice(0, 300)}`);
  }

  const u = reply.usage ?? {};
  const usage = {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  console.log(
    `[vibe] "${req.query}" → ${results.length} fonts (${dropped.length} dropped) in ${((reply.duration_ms ?? 0) / 1000).toFixed(1)} s · ` +
      `in ${usage.input} + cache read ${usage.cacheRead} + cache write ${usage.cacheWrite}, out ${usage.output}`,
  );
  return { results, dropped, usage };
}

export interface ClaudeCodeResult {
  is_error?: boolean;
  /** Set on success, and on API errors reported as text (like an expired login). */
  result?: string;
  /** Claude Code's own failures (error_max_structured_output_retries, error_during_execution, ...) carry these instead of result. */
  subtype?: string;
  errors?: string[];
  terminal_reason?: string;
  structured_output?: unknown;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

/** One `claude -p` run: no tools, no CLAUDE.md/hooks/plugins/MCP, and no session saved. */
async function askClaudeCode(system: string, prompt: string, signal?: AbortSignal): Promise<ClaudeCodeResult> {
  const systemFile = await writeSystemPrompt(system);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const args = [
    "-p",
    "--output-format", "json",
    "--model", VIBE_MODEL,
    "--system-prompt-file", systemFile,
    "--json-schema", JSON.stringify(RESULT_SCHEMA),
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-prompts", "none",
  ];

  let out: { stdout: string; stderr: string; code: number | null };
  try {
    out = await run(CLAUDE_BIN, args, prompt, signal ? AbortSignal.any([signal, timeout]) : timeout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Could not run "${CLAUDE_BIN}". Install Claude Code, or set CLAUDE_BIN in .env to the full path of the claude command.`);
    }
    if ((err as Error).name === "AbortError") {
      throw new Error(timeout.aborted ? `Claude Code took longer than ${TIMEOUT_MS / 1000} s. Try again.` : "Search cancelled.");
    }
    throw err;
  }

  const reply = parseJsonOutput(out.stdout);
  if (!reply) {
    const detail = (out.stderr || out.stdout).trim().slice(0, 400) || "no output";
    throw new Error(`Claude Code failed${out.code ? ` (exit code ${out.code})` : ""}: ${detail}`);
  }
  if (reply.is_error) {
    const { subtype, errors, result, terminal_reason } = reply;
    console.error("[vibe] Claude Code error result:", JSON.stringify({ subtype, terminal_reason, errors, result }));
    throw new Error(describeErrorResult(reply));
  }
  return reply;
}

function run(bin: string, args: string[], stdin: string, signal: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    // Run from the temp folder: Claude Code tracks state per working directory, and searches
    // should not show up against this project (polyship ships sessions under ~/Code/Polymodal).
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: childEnv(), signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); // keeps multi-byte characters intact across chunks
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {}); // the child may exit before reading everything; its output says why
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin);
  });
}

const KEEP_ENV = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Drops every ANTHROPIC_* and CLAUDE* variable except the two above. An API key in the environment would
 * switch Claude Code to API billing, and a parent Claude Code session (the desktop app, its terminal) sets
 * variables that would route the call through that session instead of your own login.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(key) && !KEEP_ENV.has(key)) continue;
    env[key] = value;
  }
  // Claude Code turns on extended thinking by default. Picking from a list doesn't need it, and it
  // made a follow-up take ~50 s instead of ~7 s (measured: 3,384 output tokens vs 637).
  env.MAX_THINKING_TOKENS = "0";
  return env;
}

/**
 * The catalog is ~140 KB, too big to pass safely as one command-line argument. The name is a hash of
 * the content, so an existing file is reused; a new one is written aside and renamed into place, so a
 * search running at the same moment never reads a half-written file.
 */
async function writeSystemPrompt(text: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "font-explorer");
  const file = path.join(dir, `system-${createHash("sha1").update(text).digest("hex").slice(0, 16)}.txt`);
  const existing = await stat(file).catch(() => null);
  if (existing?.size === Buffer.byteLength(text)) return file;
  await mkdir(dir, { recursive: true });
  const temp = `${file}.${randomUUID()}`;
  await writeFile(temp, text);
  await rename(temp, file);
  return file;
}

function parseJsonOutput(stdout: string): ClaudeCodeResult | null {
  const candidates = [stdout.trim(), ...stdout.trim().split("\n").reverse()];
  for (const text of candidates) {
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text) as ClaudeCodeResult;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function describeErrorResult(reply: ClaudeCodeResult): string {
  return explainError(reply.result || reply.errors?.join("; ") || reply.subtype || "unknown error");
}

function explainError(message: string): string {
  if (/authenticat|oauth|log ?in|logged out|credential|api key/i.test(message)) {
    return (
      `Claude Code is not signed in (it said: "${message}"). In a terminal, run: claude auth login. ` +
      "Or run claude setup-token and put the token in .env as CLAUDE_CODE_OAUTH_TOKEN=..., then restart npm run dev."
    );
  }
  return `Claude Code: ${message}`;
}

/**
 * One line per family, in bands: the indie sources that fill the "independent" list, then Fontshare,
 * then Google and the rest. Within a band, "very common" fonts go last. The order nudges the model,
 * and it is fully deterministic, so the cached prompt stays the same between searches.
 */
function compactCatalog(fonts: FontEntry[]) {
  if (catalogCache?.fonts === fonts) return catalogCache;
  const rows = new Map<string, FamilyInfo & { tags: Set<string>; rank: number; common: boolean }>();
  for (const f of fonts) {
    const key = f.family.toLowerCase();
    const row = rows.get(key) ?? { family: f.family, sources: new Set(), primary: new Set(), categories: new Set(), tags: new Set(), rank: 9999, common: false };
    row.sources.add(f.source);
    row.primary.add(f.source);
    f.alsoOn?.forEach((x) => row.sources.add(x));
    row.categories.add(f.category);
    f.tags.forEach((t) => row.tags.add(t));
    row.rank = Math.min(row.rank, f.rank ?? 9999);
    row.common ||= Boolean(f.common);
    rows.set(key, row);
  }
  const band = (r: FamilyInfo) => ([...r.primary].some((x) => VIBE_INDIE.includes(x)) ? 0 : r.primary.has("fontshare") ? 1 : 2);
  const sorted = [...rows.values()].sort(
    (a, b) =>
      band(a) - band(b) || Number(a.common) - Number(b.common) || a.rank - b.rank || a.family.localeCompare(b.family),
  );
  const text = sorted
    .map((r) => {
      const tags = [...r.tags];
      if (r.common) tags.unshift("very common");
      return `${r.family} | ${[...r.categories].join("/")} | ${[...r.sources].join(", ")}` + (tags.length ? ` | ${tags.join(", ")}` : "");
    })
    .join("\n");
  const families = new Map<string, FamilyInfo>(
    sorted.map(({ family, sources, primary, categories }) => [family.toLowerCase(), { family, sources, primary, categories }]),
  );
  catalogCache = { fonts, text, families };
  return catalogCache;
}

export interface PickLists {
  independent: VibeResult[];
  others: VibeResult[];
}

function readPicks(value: unknown): PickLists | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { independent?: unknown; others?: unknown; fonts?: unknown };
  if (![v.independent, v.others, v.fonts].some(Array.isArray)) return null;
  const list = (x: unknown) => (Array.isArray(x) ? normalizeResults(x) : []);
  return { independent: list(v.independent), others: [...list(v.others), ...list(v.fonts)] };
}

/** Reads the two-list object from text (fenced or with prose around it); otherwise any flat list of picks. */
export function parseReply(text: string): PickLists {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const lists = readPicks(JSON.parse(unfenced.slice(start, end + 1)));
      if (lists) return lists;
    } catch {
      // not one clean object: salvage below
    }
  }
  // A cut-off two-list reply: salvage whole pick objects on each side of the "others" key.
  const othersAt = unfenced.indexOf('"others"');
  if (othersAt !== -1 || unfenced.includes('"independent"')) {
    const split = othersAt === -1 ? unfenced.length : othersAt;
    return { independent: salvageObjects(unfenced.slice(0, split)), others: salvageObjects(unfenced.slice(split)) };
  }
  return { independent: [], others: parseResults(text) };
}

function salvageObjects(text: string): VibeResult[] {
  const items: unknown[] = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      items.push(JSON.parse(m[0]));
    } catch {
      // skip a broken object
    }
  }
  return normalizeResults(items);
}

/**
 * Validates both lists and interleaves them, an indie pick first. Unknown, culled, off-filter and
 * repeated families are dropped; an "independent" pick that is not from an indie source moves to others.
 */
export function mergePicks(
  lists: PickLists,
  check: { familyName: (key: string) => string | undefined; fits: (key: string) => boolean; isIndie: (key: string) => boolean; culled: Set<string> },
): { results: VibeResult[]; dropped: string[] } {
  const seen = new Set<string>();
  const dropped: string[] = [];
  const indie: VibeResult[] = [];
  const others: VibeResult[] = [];
  for (const [list, wantIndie] of [[lists.independent, true], [lists.others, false]] as const) {
    for (const r of list) {
      const key = r.family.trim().toLowerCase();
      const family = check.familyName(key);
      if (!family || check.culled.has(key) || !check.fits(key)) {
        dropped.push(r.family);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      (wantIndie && check.isIndie(key) ? indie : others).push({ family, reason: r.reason });
    }
  }
  const results: VibeResult[] = [];
  for (let i = 0; i < Math.max(indie.length, others.length); i++) {
    if (i < indie.length) results.push(indie[i]);
    if (i < others.length) results.push(others[i]);
  }
  return { results, dropped };
}

/** Accepts a bare array, a fenced array, or prose around it. Falls back to salvaging whole objects. */
export function parseResults(text: string): VibeResult[] {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  let items: unknown[] = [];
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // fall through to salvage
    }
  }
  if (!items.length) {
    for (const m of unfenced.matchAll(/\{[^{}]*\}/g)) {
      try {
        items.push(JSON.parse(m[0]));
      } catch {
        // skip a broken object
      }
    }
  }
  return normalizeResults(items);
}

function normalizeResults(items: unknown[]): VibeResult[] {
  return items
    .filter((x): x is { family: string; reason?: unknown } => !!x && typeof (x as { family?: unknown }).family === "string")
    .map((x) => ({ family: x.family, reason: typeof x.reason === "string" ? x.reason : "" }));
}
