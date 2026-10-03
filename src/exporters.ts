// The Export menu's three files: the candidates as JSON recipes, and as SVG and PNG sheets of
// outlines (export/sheets.ts). Each carries every recipe, licence and source, so the decision
// travels intact.
import { variantFor } from "./alternates";
import { effectiveText } from "./coverage";
import { downloadBlob, fileUrlOf } from "./export/copy";
import { describeLayout } from "./export/outline";
import { buildSheet, fullRecipe, sheetToPng } from "./export/sheets";
import { getFacts } from "./facts/index";
import { borrowedFrom, drawnFace, fullAbsent, fullStyleAbsent, isItalicFace, italicFace, nearestWeight, nearestWeights, resolveFull } from "./fonts";
import { italicWeightsOf } from "./italic";
import { recipeLabel } from "./recipe";
import { displayText, type Settings } from "./settings";
import type { CandidateRow } from "./store";
import type { FontEntry } from "./types";

const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * What the numbers in a recipe are measured in, and what a field means where its name does not say,
 * written into the file so it reads on its own.
 */
const UNITS = {
  tracking: "em: 1 = the font size; letter-spacing between letters, never after the last one",
  "layout.stack.leading": "cap heights for an all-caps name, x-heights otherwise: the gap between lines (Stack, and a Lockup whose name has a typed '/')",
  "layout.block.gap": "cap heights between the letters of a row",
  "layout.block.rowGap": "cap heights between rows; null = same as layout.block.gap",
  "layout.lockup.gap": "cap heights of the name",
  "layout.lockup.size": "'match' = the descriptor's cap height is 0.28 of the name's, letter-spaced to the name's width; a number = that share of the name's cap height",
  "layout.lockup.tracking": "em of the descriptor",
  "layout.container.padding": "cap heights of the name",
  "layout.breaks": "character positions in the name where a line ends",
  italicFrom: "the source the italic file came from (as in `source`), when the family's own source has no italic and it is borrowed from another source's copy of the same family; null otherwise",
  cssUrl: "a stylesheet that declares the face drawn; null when there is none to link (an installed font, or a borrowed italic: use fontFile)",
};

/**
 * One entry per candidate: its full recipe and label, licence, homepage, font file, note and
 * Claude's reason. Returns notes for candidates whose file is not the one the recipe needs.
 */
export async function exportJson(rows: CandidateRow[], settings: Settings, reasons: Map<string, string>, project: string): Promise<string[]> {
  // Before writing anything, read what each entry depends on, so the file is the same whatever was
  // opened before: Google's full file is only known once it has been looked up (Compare and the
  // lightbox do that for the fonts they show), and whether a face is caps-only needs its file.
  const looked = await Promise.all(
    rows.map(async ({ candidate: c, font: f }) => {
      const recipe = fullRecipe(c.recipe);
      // An italic and its upright share one lookup of Google's files, so it runs alongside.
      const variant = variantFor(f, recipe.features);
      const [{ face, weight, facts }] = await Promise.all([readableFace(f, recipe), variant === "full" ? resolveFull(f) : null]);
      // Asked for, listed in the catalogue, but its file could not be read, so it is drawn upright.
      const italicUnread = !!recipe.italic && f.source !== "local" && !!italicFace(f) && !isItalicFace(face);
      return { recipe, face, weight, variant, facts, italicUnread };
    }),
  );
  const notes: string[] = [];
  const data = {
    exportedAt: new Date().toISOString(),
    project,
    grid: { ...settings, rendered: displayText(settings) },
    units: UNITS,
    candidates: rows.map(({ candidate: c, font: f }, i) => {
      const { recipe, face, weight, variant, facts, italicUnread } = looked[i];
      // The label, file and weight name what Compare and the sheets draw; `recipe` keeps what was asked for.
      const label = recipeLabel(f, { ...recipe, weight, italic: isItalicFace(face) });
      // Google's full file when the recipe switches on alternates, which the web subset lacks.
      let fontFile = fileUrlOf(face, weight, variant);
      const fileNotes: string[] = [];
      if (italicUnread) fileNotes.push("The family's italic file could not be read just now, so this is the upright file, as Compare and the sheets draw it.");
      if (!fontFile && variant === "full") {
        fontFile = fileUrlOf(face, weight, "web");
        const why = fullAbsent(face)
          ? "Google's font repository has no full file for this family"
          : fullStyleAbsent(face, weight)
            ? "Google's font repository lists no italic full file for this family"
            : "Could not look up Google's full file just now";
        fileNotes.push(`${why}, so this is the web file, which may lack the alternates this recipe switches on.`);
      }
      const fontFileNote = fileNotes.join(" ") || null;
      if (fontFileNote) notes.push(`${label}: ${fontFileNote}`);
      // As the cards set it: a caps-only face shows the name in capitals, so Match Auto uses cap height.
      const name = effectiveText(f, facts, recipe);
      return {
        family: f.family,
        label,
        source: f.source,
        category: f.category,
        tags: f.tags,
        license: f.license,
        homepage: f.homepage ?? null,
        fontFile,
        fontFileNote,
        cssUrl: cssUrlOf(f, face, weight),
        weights: f.weights,
        italicWeights: italicWeightsOf(f),
        weightUsed: weight,
        // A borrowed italic: the face drawn is the family's italic, but its file is another source's.
        italicFrom: borrowedFrom(face),
        recipe,
        shownInCaps: name.shownInCaps,
        // The same recipe in words, as the copied SVG describes it.
        layout: describeLayout(recipe.layout, !/\p{Ll}/u.test(name.flat), name.lines.length),
        note: c.note || null,
        reason: reasons.get(f.id) ?? null,
        addedAt: new Date(c.addedAt).toISOString(),
      };
    }),
  };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `candidates-${stamp()}.json`);
  return notes;
}

/**
 * The face, weight and facts a recipe is drawn in, found as the sheets find them (export/copy.ts
 * layoutRecipe): the family's italic for an italic recipe, at the nearest of three weights whose file
 * can be read, else the upright the same way. Installed fonts have no file: as the recipe asks.
 */
async function readableFace(f: FontEntry, recipe: { weight: number; italic?: boolean }) {
  const italic = recipe.italic && f.source !== "local" ? italicFace(f) : null;
  if (f.source !== "local") {
    for (const face of italic ? [italic, f] : [f]) {
      for (const weight of nearestWeights(face, recipe.weight)) {
        const read = await getFacts(face, weight).catch(() => null);
        if (read) return { face, weight, facts: read.facts };
      }
    }
  }
  const face = drawnFace(f, !!recipe.italic);
  return { face, weight: nearestWeight(face, recipe.weight), facts: null };
}

/**
 * A stylesheet for the face drawn. The family's own cssUrl declares its uprights only, so an italic
 * gets the one that declares it, where the source has one per style.
 */
function cssUrlOf(f: FontEntry, face: FontEntry, weight: number): string | null {
  if (!isItalicFace(face) || f.source === "local") return f.cssUrl ?? null;
  // A borrowed italic's file is another source's (italicFrom), so the family's own source has no
  // stylesheet for it, and the row does not carry the other source's id to build theirs.
  if (borrowedFrom(face)) return null;
  if (f.source === "fontsource" && f.ref) return `https://cdn.jsdelivr.net/npm/@fontsource/${f.ref}@latest/${weight}-italic.css`;
  // Fontshare numbers an italic one above its weight: 401 is the 400 italic.
  if (f.source === "fontshare") return `https://api.fontshare.com/v2/css?f[]=${f.id.replace(/^fontshare:/, "")}@${weight + 1}&display=swap`;
  return null;
}

/** Every candidate as outlines in its own layout, in one SVG file. Returns notes for anything left as text or out. */
export async function exportSvgSheet(rows: CandidateRow[], settings: Settings, project: string): Promise<string[]> {
  const sheet = await buildSheet(rows, settings, project);
  downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${sheet.svg}\n`], { type: "image/svg+xml" }), `candidates-${stamp()}.svg`);
  return sheet.notes;
}

/** The SVG sheet drawn onto a 2× canvas. */
export async function exportPngSheet(rows: CandidateRow[], settings: Settings, project: string): Promise<string[]> {
  const sheet = await buildSheet(rows, settings, project);
  downloadBlob(await sheetToPng(sheet), `candidates-${stamp()}.png`);
  return sheet.notes;
}
