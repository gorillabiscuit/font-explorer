// Alternates that touch the name: which of a face's stylistic sets and character variants change a
// letter of this particular name. A face with twenty sets often changes nothing in a given name, and
// one set (a single-storey a) can be the whole reason to pick it. DOM-free, like facts/core.ts, so the
// browser and a Node script run the same code on a parsed fontkit Font.
import type { Font, Glyph } from "fontkit";
import { changedBy } from "./facts/core";
import { Lru } from "./facts/lru";
import type { FontFacts } from "./facts/types";
import type { FontEntry } from "./types";

/** Features a designer switches on by choice. */
const OPTIONAL = /^(ss\d\d|cv\d\d|salt|swsh|dlig|titl)$/;
/** On by default: reported when they change the name (an fi ligature), never offered as a choice. */
const DEFAULTS = new Set(["liga", "calt"]);
/** A set whose new glyphs are named like this turns letters into symbols (①, Ⓐ, 🄰), not alternates. */
const ENCLOSED_NAME = /circled|squared|enclosed|negative|boxed/i;
/** Enclosed alphanumerics and their supplement: a set that maps letters onto these makes symbols too. */
const ENCLOSED_RANGES: [number, number][] = [
  [0x2460, 0x24ff],
  [0x1f100, 0x1f1ff],
];

export interface AltSet {
  tag: string;
  /** The font's own name for it ('Single-storey a'), when it gives one. */
  uiName?: string;
  /** The distinct characters it changes, in name order ('ag'). */
  letters: string;
  /** UTF-16 indexes into the name of every character whose glyph changes. */
  indexes: number[];
}

export interface Alternates {
  /** Opt-in sets that change at least one character of the name, in the font's order (ss01 first). */
  sets: AltSet[];
  /** Every character some set changes, once each, in name order ('gat' for Rigatoni). */
  letters: string;
  /** Substitutions the face makes on its own in this name (liga, calt): shown, never chosen. */
  defaults: AltSet[];
}

export const NO_ALTERNATES: Alternates = { sets: [], letters: "", defaults: [] };

// Each check shapes the name twice per feature, so the answer is kept per font and name: a grid
// re-rendering for any other reason (a verdict, the focus moving) costs nothing.
const memo = new WeakMap<Font, Lru<string, Alternates>>();

/**
 * The alternates of `font` that change `text` (the name as displayed: cased, breaks taken out).
 * Sets that turn letters into enclosed or circled symbols are left out: they change the name, but
 * into something no wordmark wants.
 */
export function relevantAlternates(font: Font, facts: FontFacts, text: string, opts: { quick?: boolean } = {}): Alternates {
  // quick: false shapes every feature, skipping the quick test (check-alternates compares the two).
  const steps = checking(font, facts, text, opts.quick !== false);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** The answer when it is already known (or needs no work), else undefined. */
export function peekAlternates(font: Font, facts: FontFacts, text: string): Alternates | undefined {
  if (!text.trim() || !facts.features.length) return NO_ALTERNATES;
  return memo.get(font)?.get(text);
}

// The browser runs the checks in slices of a few milliseconds with a yield between them, one face at
// a time, so a screenful of cards working out their chips never holds up scrolling or typing.
const SLICE_MS = 8;
let queue: Promise<unknown> = Promise.resolve();

/**
 * relevantAlternates without blocking: resolves with the answer, or null when `wanted` turns false
 * before it is done (the card scrolled away, the name changed). Work left half done is not kept.
 */
export function alternatesSoon(font: Font, facts: FontFacts, text: string, wanted: () => boolean = () => true): Promise<Alternates | null> {
  const known = peekAlternates(font, facts, text);
  if (known) return Promise.resolve(known);
  const run = queue.then(async () => {
    const steps = checking(font, facts, text);
    let since = performance.now();
    for (;;) {
      if (!wanted()) return null;
      const step = steps.next();
      if (step.done) return step.value;
      if (performance.now() - since > SLICE_MS) {
        await nextTask();
        since = performance.now();
      }
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

function nextTask(): Promise<void> {
  // A message posts a fresh task without the 4 ms clamp that chained timeouts get.
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** The check itself, pausing (yield) after each feature it had to shape. Only quick answers are kept. */
function* checking(font: Font, facts: FontFacts, text: string, quick = true): Generator<void, Alternates> {
  const known = quick ? peekAlternates(font, facts, text) : undefined;
  if (known) return known;
  if (!text.trim() || !facts.features.length) return NO_ALTERNATES;
  const sets: AltSet[] = [];
  const defaults: AltSet[] = [];
  const present = glyphsOf(font, text);
  for (const { tag, uiName } of facts.features) {
    const optional = OPTIONAL.test(tag);
    if ((!optional && !DEFAULTS.has(tag)) || (quick && !mayTouch(font, tag, present))) continue;
    let indexes: number[];
    try {
      indexes = changedBy(font, text, tag);
    } catch {
      continue; // a feature fontkit cannot apply is not offered
    }
    yield;
    if (!indexes.length || (optional && makesSymbols(font, text, tag, present))) continue;
    const entry: AltSet = { tag, letters: lettersAt(text, indexes), indexes };
    if (uiName) entry.uiName = uiName;
    (optional ? sets : defaults).push(entry);
  }
  const letters = lettersAt(text, sets.flatMap((s) => s.indexes));
  const result = sets.length || defaults.length ? { sets, letters, defaults } : NO_ALTERNATES;
  if (!quick) return result;
  let cache = memo.get(font);
  if (!cache) memo.set(font, (cache = new Lru(32)));
  cache.set(text, result);
  return result;
}

// --- the quick test ---
// Most features cannot touch a given name at all: every lookup a feature runs starts from a coverage
// table of the glyphs it acts on, and if none of the name's glyphs are in any of them, nothing
// changes. Only features that pass are shaped. Checked against shaping every feature, on the 394
// cached indie files and five names: the same answers for a sixteenth of the work. What is left can
// still take a while the first time on a face with many sets, because fontkit decodes each alternate
// glyph when it is first drawn (Junicode's fifteen sets that touch 'Polymodal' take most of a second),
// which is why the browser runs the checks in slices (alternatesSoon).

interface Coverage {
  glyphs?: number[];
  rangeRecords?: { start: number; end: number }[];
}
interface Subtable {
  coverage?: Coverage;
  /** Context and chained-context lookups in format 3 keep a coverage per input position. */
  coverages?: Coverage[];
  inputCoverage?: Coverage[];
  /** Extension lookups (type 7) wrap the real subtable. */
  extension?: Subtable;
}
interface GsubTable {
  featureList?: { tag: string; feature?: { lookupListIndexes?: number[] } }[];
  lookupList?: { get(i: number): { lookupType: number; subTables?: Subtable[] } | undefined };
}

/** The glyphs the name can start a lookup from: its characters as the font maps them, and as shaped by default. */
function glyphsOf(font: Font, text: string): Set<number> {
  const ids = new Set<number>();
  try {
    for (const g of font.glyphsForString(text)) ids.add(g.id);
  } catch {
    // fall back to the shaped glyphs alone
  }
  for (const g of shapeGlyphs(font, text, {}) ?? []) ids.add(g.id);
  return ids;
}

/** False only when no lookup of the feature covers any of `ids`. Anything unreadable counts as a maybe. */
function mayTouch(font: Font, tag: string, ids: Set<number>): boolean {
  try {
    const gsub = (font as unknown as { GSUB?: GsubTable }).GSUB;
    const records = gsub?.featureList?.filter((r) => r.tag === tag) ?? [];
    if (!gsub?.lookupList || !records.length) return true;
    for (const r of records) {
      for (const index of r.feature?.lookupListIndexes ?? []) {
        const lookup = gsub.lookupList.get(index);
        if (!lookup) return true;
        for (const raw of lookup.subTables ?? []) {
          const sub = lookup.lookupType === 7 ? raw.extension : raw;
          const cov = sub?.coverage ?? sub?.coverages?.[0] ?? sub?.inputCoverage?.[0];
          if (!cov || coversAny(cov, ids)) return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

function coversAny(cov: Coverage, ids: Set<number>): boolean {
  if (cov.glyphs) return cov.glyphs.some((g) => ids.has(g));
  if (cov.rangeRecords) return cov.rangeRecords.some((r) => [...ids].some((g) => g >= r.start && g <= r.end));
  return true;
}

/** The distinct characters at `indexes`, in name order, spaces left out. */
function lettersAt(text: string, indexes: number[]): string {
  const seen = new Set<string>();
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0xfffd);
    if (/\S/u.test(ch)) seen.add(ch);
  }
  return [...seen].join("");
}

/** The glyphs the set brings into the name (those not in `present`) include an enclosed or circled form. */
function makesSymbols(font: Font, text: string, tag: string, present: Set<number>): boolean {
  const after = shapeGlyphs(font, text, { [tag]: true });
  if (!after) return false;
  const enclosed = enclosedIds(font);
  return after.some((g) => !present.has(g.id) && (enclosed.has(g.id) || ENCLOSED_NAME.test(glyphName(g))));
}

/** fontkit's shaping, retried without mark positioning (which throws on some fonts, see core.ts). */
function shapeGlyphs(font: Font, text: string, features: Record<string, boolean>): Glyph[] | null {
  // fontkit writes into the features object it is given, so each call gets its own.
  const tries: Record<string, boolean>[] = [{}, { mark: false, mkmk: false }];
  for (const extra of tries) {
    try {
      return font.layout(text, { ...features, ...extra }).glyphs;
    } catch {
      // try the next way
    }
  }
  return null;
}

function glyphName(g: Glyph): string {
  try {
    return g.name ?? "";
  } catch {
    return ""; // a glyph without a readable name is judged by its code points alone
  }
}

const enclosedCache = new WeakMap<Font, Set<number>>();

/** The glyph ids the font maps the enclosed alphanumerics onto. */
function enclosedIds(font: Font): Set<number> {
  let ids = enclosedCache.get(font);
  if (ids) return ids;
  ids = new Set();
  for (const cp of font.characterSet) {
    if (ENCLOSED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) ids.add(font.glyphForCodePoint(cp).id);
  }
  enclosedCache.set(font, ids);
  return ids;
}

// --- choosing ---

/** One step of the lightbox's A cycle, and one option in the picker. */
export interface AltChoice {
  /** 'default', a feature tag, or 'all'. */
  key: string;
  /** For the picker and the toast: 'Default', 'ss01 Single-storey a', 'All sets'. */
  label: string;
  /** The alternates switched on; empty for Default. */
  features: Record<string, 1>;
  /** The characters it changes, to tint in the preview. */
  letters: string;
}

/** Default, then each set, then every set together (only when there are two or more). */
export function altChoices(alts: Alternates): AltChoice[] {
  const choices: AltChoice[] = [{ key: "default", label: "Default", features: {}, letters: "" }];
  for (const s of alts.sets) choices.push({ key: s.tag, label: s.uiName ? `${s.tag} ${s.uiName}` : s.tag, features: { [s.tag]: 1 }, letters: s.letters });
  if (alts.sets.length > 1) {
    choices.push({ key: "all", label: "All sets", features: Object.fromEntries(alts.sets.map((s) => [s.tag, 1])) as Record<string, 1>, letters: alts.letters });
  }
  return choices;
}

/** The alternates switched on in a recipe's features (kerning and the like are not alternates). */
function chosenTags(features: Record<string, 0 | 1> | undefined): string[] {
  return Object.keys(features ?? {})
    .filter((tag) => OPTIONAL.test(tag) && features?.[tag] === 1)
    .sort();
}

/** The choice these features make, or null when they match none (sets this name no longer uses). */
export function currentChoice(features: Record<string, 0 | 1> | undefined, choices: AltChoice[]): AltChoice | null {
  const on = chosenTags(features).join(" ");
  return choices.find((c) => Object.keys(c.features).sort().join(" ") === on) ?? null;
}

/** The features with the alternates replaced by the choice's; everything else (kern: 0) stays. */
export function withChoice(features: Record<string, 0 | 1> | undefined, choice: AltChoice): Record<string, 0 | 1> {
  const kept = Object.fromEntries(Object.entries(features ?? {}).filter(([tag]) => !OPTIONAL.test(tag))) as Record<string, 0 | 1>;
  return { ...kept, ...choice.features };
}

/** The choice after `current` in the A cycle, wrapping round to Default. */
export function nextChoice(current: AltChoice | null, choices: AltChoice[]): AltChoice {
  const i = current ? choices.findIndex((c) => c.key === current.key) : -1;
  return choices[(i + 1) % choices.length];
}

/** For a toast: 'ss01 on', 'default letters', 'all sets on'. */
export function choiceToast(choice: AltChoice): string {
  if (choice.key === "default") return "default letters";
  if (choice.key === "all") return "all sets on";
  return `${choice.label} on`;
}

/** 'fi ligature on', 'contextual forms on: s t', for the substitutions a face makes on its own. */
export function defaultNote(d: AltSet): string {
  return d.tag === "liga" ? `${d.letters} ligature on` : `contextual forms on: ${[...d.letters].join(" ")}`;
}

/**
 * Which file to draw a recipe from. Google's web files (Fontsource subsets) may lack the stylistic
 * sets, so a Google family with an alternate switched on is drawn from its full upstream file.
 * Every other source's file is complete already. Switching something off (kern: 0) needs no full file.
 */
export function variantFor(font: FontEntry, features: Record<string, 0 | 1> | undefined): "web" | "full" {
  return font.source === "fontsource" && Object.values(features ?? {}).some((on) => on === 1) ? "full" : "web";
}
