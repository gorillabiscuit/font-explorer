import { createHash } from "node:crypto";
import { hasItalic } from "../src/italic.ts";
import { FORMATION_ORDER } from "../src/recipe.ts";
import { CATEGORIES, SOURCES, type Category, type FontEntry, type Source, type VibeRequest, type VibeResponse, type VibeResult, type VibeWordmark } from "../src/types.ts";
import { claudeCode, describeErrorResult } from "./claudeCode.ts";
import { loadTraits } from "./traits.ts";
import { readingsFor } from "./vibeWords.ts";

export { describeErrorResult };

// Vibe search runs through Claude Code (`claude -p`), so it uses your Claude subscription, not API billing.

/**
 * Sonnet 5.5 at low effort. In a trial on 2026-10-03 it answered faster than Haiku 4.5 (9.3 s against
 * 12.2 s on average) and, asked the same thing twice, repeated about half its picks where Haiku
 * repeated a fifth. Override with VIBE_MODEL in .env.
 */
export const VIBE_MODEL = process.env.VIBE_MODEL || "claude-sonnet-5-5";
/** Sonnet 5.5 and Opus cannot switch thinking off, so low effort is what keeps them quick. */
const VIBE_EFFORT = process.env.VIBE_EFFORT ?? "low";
/** Tried when the model is overloaded or not available. Haiku 4.5 is due to retire from 2026-10-15. */
const VIBE_FALLBACK_MODEL = process.env.VIBE_FALLBACK_MODEL ?? (/haiku/i.test(VIBE_MODEL) ? "claude-sonnet-5-5" : "claude-haiku-4-5-20251001");
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

/** Google's mood tags. A family with a score for none of these is one nobody rated. */
const MOODS = new Set(["Active", "Artistic", "Awkward", "Business", "Calm", "Childlike", "Competent", "Cute", "Excited", "Fancy", "Futuristic", "Happy", "Innovative", "Loud", "Playful", "Rugged", "Sincere", "Sophisticated", "Stiff", "Vintage"]);

const INSTRUCTIONS = `You help a designer choose typefaces for a logo or wordmark.

You get a catalog of the fonts available to them, one per line as "family | category | sources | tags | shape", and a list of fonts installed on their machine (source "local").
- Sources: velvetyne, collletttivo and tunera are independent libre foundries with experimental, characterful type; usemodify is a hand-picked list of libre fonts; fontshare is a small curated foundry collection; fontsource is the Google Fonts library.
- Tags: "very common" marks the most-used Google Fonts. A number after a tag is its strength out of 100. Google's moods (Active, Calm, Loud, Futuristic...) and themes (Techno, Brush, Pixel...) were rated by people looking at the fonts; Google's Active mostly marks lively scripts and comic faces, not speed. The independent sources and Fontshare use their own words (brutalist, pixel, wonky, generative, Headlines...). Moods after "judged:" were rated by a model from a rendered specimen, for fonts nobody had tagged. "-" means no tags.
- Shape is measured from the letter outlines of the regular style and names only what stands out against the whole catalog: weight (thin, light, bold, heavy), width (condensed, wide), "slanted" (the upright letters lean forward), "squared", "straight-edged" or "curvy" outlines, "high contrast" or "reverse contrast" strokes, a large or small x-height, and "caps only". "has italic" means the family comes with a real italic. No shape words means nothing measured stands out; "not measured" means the file could not be measured.
Read shape words as measured facts and tags as people's impressions, and also use what you know about each typeface. Do not match tag words literally: think about what each face actually looks like, and treat a font with few or no tags as fully eligible.

The designer finds the usual web fonts boring. Unless a request asks for something plain, neutral or safe, do not pick fonts marked "very common", avoid generic UI workhorses and the obvious genre clichés, and favour distinctive type with a point of view.
Each request describes a feeling or direction ("more technological", "slick and professional", "a bit more sci-fi, but still legible"). Pick the 15 to 20 catalog fonts that best answer it, in two lists, each best match first:
- "independent": 6 to 8 picks whose sources include velvetyne, collletttivo, tunera or usemodify. Give fewer only if the request asks for something plain, neutral or safe, or the constraints rule those sources out.
- "others": the rest of your picks, from any source.

Rules:
- The request comes first: every pick must answer it. The shortlist holds fonts the designer liked earlier in the project; use it only to break ties between fonts that answer the request equally well, and never let it pull picks towards its own style.
- Only pick families that appear in the catalog, spelled exactly as listed.
- Never pick a font from the culled list. Treat culled fonts as taste the designer rejected, and steer away from close relatives of them.
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
  /** Comes with a real italic (src/italic.ts). */
  italic: boolean;
}

let catalogCache: { fonts: FontEntry[]; traitsKey: string; text: string; families: Map<string, FamilyInfo> } | null = null;

/** The newest shortlisted names sent along. Enough to show taste; more only pulls picks towards it. */
const SHORTLIST_SENT = 12;

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
  // The grid's 'Has italic' filter counts only while the Italic switch is on; installed fonts never pass it.
  const italicOnly = Boolean(req.italic?.on && req.italic.only);
  /**
   * Whether the grid would show a family under the filters the user has on: its catalog row or its
   * installed copy, each judged on its own, as the grid judges each card.
   */
  const fits = (key: string) => {
    const info = catalog.families.get(key);
    const local = installed.get(key);
    const catalogFits =
      Boolean(info) &&
      (!sourceLimit || [...info!.sources].some((x) => sourceLimit.has(x))) &&
      (!categoryLimit || [...info!.categories].some((x) => categoryLimit.has(x))) &&
      (!italicOnly || info!.italic);
    const localFits =
      Boolean(local) && (!sourceLimit || sourceLimit.has("local")) && (!categoryLimit || categoryLimit.has(local!.category)) && !italicOnly;
    return catalogFits || localFits;
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
  if (req.shortlist?.length) {
    parts.push(`Shortlist (fonts I liked earlier; only to break ties): ${req.shortlist.slice(-SHORTLIST_SENT).join(", ")}`);
  }
  if (req.culled?.length) parts.push(`Culled (rejected, never suggest): ${req.culled.slice(-60).join(", ")}`);
  const current = history.at(-1)?.results;
  if (current?.length) {
    parts.push(`Current results, numbered:\n${current.map((r, i) => `#${i + 1} ${r.family}`).join("\n")}`);
  }
  if (req.italic?.on) {
    parts.push(
      italicOnly
        ? 'The Italic switch is on and only fonts that have an italic are shown, each in its real italic. Only pick fonts marked "has italic".'
        : 'The Italic switch is on: fonts marked "has italic" are shown in their real italic and the rest of the catalog stays upright; installed fonts use their own italic where they have one.',
    );
  }
  if (sourceLimit) {
    parts.push(
      `Only pick fonts available from: ${sources.join(", ")}` +
        (sourceLimit.has("local") ? ' ("local" means the installed list)' : ""),
    );
  }
  if (categoryLimit) parts.push(`Only pick from categories: ${categories.join(", ")}`);
  const query = req.query.trim();
  parts.push(`Request: ${query}`);
  const readings = readingsFor(query, {
    italicOn: Boolean(req.italic?.on),
    familyNames: [...[...catalog.families.values()].map((f) => f.family), ...[...installed.values()].map((f) => f.family)],
  });
  if (readings.length) {
    parts.push(`What the request's words mean in this catalog's terms (follow the request's own direction, including "less" or "not"):\n${readings.map((r) => `- ${r}`).join("\n")}`);
  }

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
  const reply = await claudeCode({
    system,
    prompt,
    model: VIBE_MODEL,
    effort: VIBE_EFFORT || undefined,
    fallbackModel: VIBE_FALLBACK_MODEL || undefined,
    schema: RESULT_SCHEMA,
    timeoutMs: TIMEOUT_MS,
    signal,
  });

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
  // Claude Code also makes small calls of its own on Haiku, so the answering model is the one that
  // wrote the most; it is the fallback model when the main one was unavailable.
  const models = Object.entries(reply.modelUsage ?? {})
    .sort(([, a], [, b]) => outputTokens(b) - outputTokens(a))
    .map(([model]) => model);
  console.log(
    `[vibe] "${req.query}" → ${results.length} fonts (${dropped.length} dropped) in ${((reply.duration_ms ?? 0) / 1000).toFixed(1)} s on ${models[0] ?? VIBE_MODEL} · ` +
      `in ${usage.input} + cache read ${usage.cacheRead} + cache write ${usage.cacheWrite}, out ${usage.output}`,
  );
  return { results, dropped, usage, models };
}

function outputTokens(usage: unknown): number {
  const n = (usage as { outputTokens?: unknown } | null)?.outputTokens;
  return typeof n === "number" ? n : 0;
}

/**
 * One line per family, in bands: the indie sources that fill the "independent" list, then Fontshare,
 * then Google and the rest. Within a band the order is a fixed shuffle (by a hash of the name). Sorted
 * by popularity, the model over-picked the first and last rows of a band (2026-10-03 trial: 11% of
 * Google picks came from the middle 30% of the block); shuffled, a row's place says nothing about the
 * font. The order is fixed rather than new per search, because a new order would make every search
 * re-read the whole catalog without Claude Code's prompt cache, which weighs far more on usage.
 */
function compactCatalog(fonts: FontEntry[]) {
  const traits = loadTraits();
  if (catalogCache?.fonts === fonts && catalogCache.traitsKey === traits.key) return catalogCache;
  const rows = new Map<string, FamilyInfo & { tags: Set<string>; scores: Record<string, number>; common: boolean }>();
  for (const f of fonts) {
    const key = f.family.toLowerCase();
    const row = rows.get(key) ?? { family: f.family, sources: new Set(), primary: new Set(), categories: new Set(), italic: false, tags: new Set(), scores: {}, common: false };
    row.sources.add(f.source);
    row.primary.add(f.source);
    f.alsoOn?.forEach((x) => row.sources.add(x));
    row.categories.add(f.category);
    f.tags.forEach((t) => row.tags.add(t));
    row.scores = { ...f.tagScores, ...row.scores };
    row.italic ||= hasItalic(f);
    row.common ||= Boolean(f.common);
    rows.set(key, row);
  }
  const band = (r: FamilyInfo) => ([...r.primary].some((x) => VIBE_INDIE.includes(x)) ? 0 : r.primary.has("fontshare") ? 1 : 2);
  const order = (family: string) => createHash("sha1").update(family).digest().readUInt32BE(0);
  const sorted = [...rows.values()]
    .map((r) => ({ r, band: band(r), order: order(r.family) }))
    .sort((a, b) => a.band - b.band || a.order - b.order || a.r.family.localeCompare(b.r.family))
    .map(({ r }) => r);
  const text = sorted
    .map((r) => {
      const { measured, shape, judged } = traits.lookup(r.family);
      const tags = [...r.tags].map((t) => (t in r.scores ? `${t} ${r.scores[t]}` : t));
      if (r.common) tags.unshift("very common");
      // Moods judged from a specimen stand in only where Google's people rated none.
      if (judged.length && !Object.keys(r.scores).some((t) => MOODS.has(t))) tags.push(`judged: ${judged.join(", ")}`);
      const look = [...(measured ? shape : ["not measured"]), ...(r.italic ? ["has italic"] : [])];
      return `${r.family} | ${[...r.categories].join("/")} | ${[...r.sources].join(", ")} | ${tags.length ? tags.join(", ") : "-"}` + (look.length ? ` | ${look.join(", ")}` : "");
    })
    .join("\n");
  const families = new Map<string, FamilyInfo>(
    sorted.map(({ family, sources, primary, categories, italic }) => [family.toLowerCase(), { family, sources, primary, categories, italic }]),
  );
  catalogCache = { fonts, traitsKey: traits.key, text, families };
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
