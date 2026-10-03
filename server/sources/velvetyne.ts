// Velvetyne Type Foundry: libre (mostly OFL) display faces. The catalog is the GitLab group "velvetyne",
// five families that live in their authors' own GitLab repositories, and a seed list of Velvetyne
// families hosted on GitHub. For each repository this builder reads the root listing, lists only the
// font folders (never the whole repo: UFO sources hold thousands of files), reads METADATA.yml /
// METADATA.yaml / FONTINFO.json for the name and tags, downloads every face once to read its real weight,
// and turns the styles into rows: uprights in `files`, slanted faces in `italicFiles` of the row their
// upright belongs to. A family with no upright style at all gets one row: its slanted file as weight 400
// (in both maps), tagged "italic only".
//
// Etiquette: velvetyne.fr opts out of AI agents in its robots.txt, so this builder never requests it.
// GitLab repositories come from gitlab.com's API (500 unauthenticated calls a minute; this run makes about
// 170 plus the first-run downloads, spaced at least 200 ms apart, with one retry on HTTP 429). GitHub
// repositories are listed through jsDelivr's data API and served from cdn.jsdelivr.net, never through
// GitHub's REST API (60 calls an hour); the head commit comes from git's ref advertisement. Font files
// are cached by content hash under server/.cache/velvetyne/, so reruns only download faces that changed.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { load as loadYaml } from "js-yaml";
import { isExcludedFamily } from "../../src/exclude.ts";
import {
  categoryFromTags,
  fetchJson,
  fetchOk,
  fetchText,
  sleep,
  weightFromStyleName,
  type Category,
  type FontEntry,
  type FontFileInfo,
  type SourceBuilder,
} from "./common.ts";

const SOURCE = "velvetyne" as const;
const API = "https://gitlab.com/api/v4";
const GROUP = "velvetyne";
/** Velvetyne families published from their authors' own repositories on gitlab.com. */
const EXTERNAL = [
  "StudioTriple/pilowlava",
  "StudioTriple/Solide-Mirage",
  "phantomfoundry/karrik_fonts",
  "raphaelbastide/Terminal-Grotesque",
  "Eugenie-B/degheest-types",
];

/**
 * Velvetyne families hosted on GitHub, found by web search (the velvetyne GitHub organisation and the
 * designers' own repositories), each with an OFL LICENSE file read through jsDelivr. `branch` is the
 * fallback when the head commit cannot be read or jsDelivr has no listing for it. The organisation's
 * copies of Sporting Grotesque, Format 1452, Mourier and Trickster are left out: those come from GitLab.
 */
const GITHUB: { repo: string; branch: string }[] = [
  { repo: "raoulaudouin/outward", branch: "master" },
  // The designer's own repository; velvetyne/Typefesse is a copy of the same commit that jsDelivr will not pin.
  { repo: "ohpla/typefesse", branch: "master" },
  // Velvetyne's fork of jbmorizot/BluuNext, which adds the Titling cut and the web fonts.
  { repo: "velvetyne/BluuNext", branch: "master" },
  { repo: "velvetyne/Boeticher", branch: "master" },
  { repo: "velvetyne/Hangul", branch: "master" },
  { repo: "velvetyne/Victorianna", branch: "master" },
  { repo: "velvetyne/resistance-generale", branch: "master" },
  { repo: "velvetyne/Lment_", branch: "master" },
  { repo: "velvetyne/runic", branch: "master" },
  { repo: "velvetyne/courrrier", branch: "master" },
  { repo: "velvetyne/Commune-Nuit-Debout", branch: "master" },
  { repo: "jckfa/tinyfonts", branch: "master" },
];

/** Velvetyne families left out on purpose without fetching them, with the reason (logged on every run). */
const LEFT_OUT: [string, string][] = [
  ["mariellenils/PicNic", "deliberate skip: its licence is not clearly logo-safe"],
  ["github.com/velvetyne/BilboINC", "licensed CC BY-NC-SA (non-commercial), not OFL"],
  ["github.com/velvetyne/Daubenton", "the repository is over jsDelivr's 50 MB package limit, so jsDelivr can neither list nor serve it"],
  ["github.com/velvetyne/saintjean", "a workshop font of ampersand drawings: its letters are not readable Latin"],
  ["github.com/velvetyne/marcel", "the repository holds no font files"],
  ["github.com/velvetyne/Pictoporn", "pictograms, not a typeface"],
];

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, "..", ".cache", "velvetyne");
const FONT_EXT = ["woff2", "woff", "otf", "ttf"];
const FONT_FILE = /\.(woff2|woff|otf|ttf)$/i;
const GITLAB_GAP_MS = 200;
const UA = "font-explorer/0.1 (personal local font browser; fetches each catalog rarely)";
/** Root folders that hold released fonts. */
const FONT_DIR = /^(fonts?|webfonts?)$/i;
/** Root folders with web specimens; their files only count as a better format of a released face. */
const SPECIMEN_DIR = /^(web-?specimen|specimen)$/i;
const ITALIC = /italic|oblique/i;
/** The slant word in a file name, with its separator: "-Bolditalic", "_thin_talic" (Victorianna's spelling). */
const SLANT_WORD = /[-_ ]?(?:i?talic|oblique)/i;
/** A slant word that is a style on its own ("Karrik-Italic", "happy-times-NG_italic_master_web"). */
const LONE_SLANT = /(^|[-_ ])(?:i?talic|oblique)(?=$|[-_ .])/i;

// ---------------------------------------------------------------------------------------------------
// Hand-made knowledge per repository, keyed by the lowercased GitLab path. Tags and categories come from
// rendering every face. Repositories missing here still get rows, with tags taken from their metadata
// file and GitLab topics.

interface RowHints {
  category?: Category;
  tags?: string[];
}

interface RepoHints extends RowHints {
  /** Display name of the family, when the metadata file or project name is wrong or clumsy. */
  name?: string;
  /** Leave the whole repository out, with this reason. */
  skip?: string;
  /** Keep only font files whose name matches (logged). */
  only?: { re: RegExp; reason: string };
  /** Leave out matching font files, with a reason. */
  skipFiles?: { re: RegExp; reason: string }[];
  /** Put every face in one row (named styles that are really weights or grades of one design). */
  merge?: boolean;
  /** Assigns a face to a variant row by file name; "" is the main row. */
  variantOf?: (file: string) => string | undefined;
  /** Weight overrides by file name, for files whose own weight data is wrong. */
  weights?: [RegExp, number][];
  /** Rename a generated row (keyed by its generated display name). */
  rename?: Record<string, string>;
  /** Category and tags for a variant or collection row, keyed by its final display name. */
  rows?: Record<string, RowHints>;
  /** Tags from the metadata file or GitLab topics that do not describe the family (curated tags are kept). */
  dropTags?: string[];
}

// Keys: "<namespace>/<project>" for gitlab.com, "gh:<owner>/<repo>" for GitHub, both lowercased.
const HINTS: Record<string, RepoHints> = {
  "velvetyne/flor-des-ruina": {
    name: "Flor de Ruina",
    category: "display",
    tags: ["serif", "textured", "eroded", "grunge", "organic", "fractured", "experimental"],
    // Germen, Semilla, Flor, Ruina and Fractura are the stages of one design, and their files carry the
    // weights 300-700 in that order. Rendered, all five set a readable word (Flor included).
    merge: true,
  },
  "velvetyne/interlope": {
    // METADATA.yml names it "Gabriel" (the designer); the files and README say Interlope.
    name: "Interlope",
    category: "handwriting",
    tags: ["script", "calligraphic", "amateur", "diy", "1970s", "ornamental", "ligatures"],
  },
  "velvetyne/letters": {
    // METADATA.yml is a copy of Sligoil's. Torn is the upright style; Lavish is flagged italic in its file.
    // Caps only, but it sets readable words at display sizes.
    name: "Letters",
    category: "display",
    tags: ["caps", "torn", "paper", "collage", "decorative", "textured", "experimental"],
    skipFiles: [
      {
        re: /Letters-Lavish\./i,
        reason: "Lavish is a style of its own, not Torn's italic: its file flags it italic, but it has no slant and its letters are about 1.6 times as wide",
      },
    ],
  },
  "velvetyne/lineal": {
    category: "sans",
    tags: ["geometric", "sans", "modular", "futura-like", "clean", "art-deco"],
  },
  "velvetyne/facade-font": {
    name: "Façade",
    category: "display",
    tags: ["condensed", "architectural", "grid", "geometric", "modular", "monoline", "sans"],
    // The variable font shows the design space: Sud→Est is the weight axis (100→900), Sud→Sud-Ouest→Ouest
    // the contrast axis at weight 100. One row with the two ends of the weight axis: Sud 100, Est 900.
    merge: true,
    skipFiles: [
      { re: /Facade-Ouest\./i, reason: "the no-contrast end of the contrast axis at weight 100, the same weight as Façade Sud" },
      {
        re: /Facade-Sud-Ouest\./i,
        reason: "a contrast step at weight 100 (the variable font's instance; the file says 400), not a weight of the family",
      },
    ],
  },
  "velvetyne/grotesk": {
    category: "sans",
    tags: ["geometric", "sans", "art-deco", "wide", "spaced", "elegant"],
    // The files' names and weights are shuffled (the "Mince" file says "01 Extrafine Bold", weight 400).
    // GroteskVF's named instances sit at wght 120, 310, 500 and 600 in the order 01 Extrafin, 02 Mince,
    // 03 Regular, 04 Gras; rounded to 100 those are the weights.
    weights: [[/01Extrafin/i, 100], [/02Mince/i, 300], [/03Regular/i, 500], [/04Gras/i, 600]],
  },
  "velvetyne/jgs": {
    name: "jgs",
    category: "mono",
    tags: ["pixel", "ascii-art", "monospace", "bitmap", "retro", "computer"],
    only: { re: /^jgs9\./i, reason: "jgs5, jgs7 and jgs9 are pixel-grid sizes of one design; keeping the largest, jgs9" },
  },
  "velvetyne/fungal": {
    category: "display",
    tags: ["organic", "mycelium", "biomorphic", "generative", "hairy", "wonky", "sans"],
    // 21 statics along two axes (Grow, Thickness), all weight 400, and no weight axis. Grow 0 is plain
    // DejaVu Sans; the middle of both axes shows the growth and still reads.
    only: { re: /Grow500Thickness500\./i, reason: "21 growth instances at one weight; keeping the middle one (Grow 500, Thickness 500)" },
    merge: true,
  },
  "velvetyne/sligoil": {
    // Micro is the only optical size shipped, so the row is just "Sligoil".
    category: "mono",
    tags: ["monospace", "inktrap", "sans", "technical", "sharp", "micro"],
    merge: true,
  },
  "velvetyne/amdal": { skip: "Tifinagh only: the font has no Latin letters" },
  "velvetyne/gulax": {
    category: "sans",
    tags: ["monolinear", "geometric", "sans", "quirky", "experimental"],
  },
  "velvetyne/trickster": {
    category: "display",
    tags: ["blackletter", "calligraphic", "high-contrast", "merovingian", "wonky", "sharp", "headline"],
  },
  "velvetyne/sporting-grotesque": {
    category: "sans",
    tags: ["grotesque", "wide", "sans", "sporty", "quirky", "titling"],
  },
  "velvetyne/basteleur": {
    category: "serif",
    tags: ["serif", "fantasy", "tarot", "esoteric", "human-made", "high-contrast", "sharp"],
    // Moonlight is the light style of the same design. Bold's file says weight 400.
    merge: true,
    weights: [[/Basteleur-Bold\./i, 700]],
  },
  "velvetyne/anthony": {
    category: "display",
    tags: ["geometric", "leaning", "sculptural", "wonky", "thin", "playful"],
  },
  "velvetyne/mess": { skip: "illegible by design (repository description and metadata tag)" },
  "velvetyne/mourier": {
    // Abstract and hard to read, but rendered at display size it still spells words; kept, and tagged so.
    category: "display",
    tags: ["modular", "geometric", "labyrinth", "abstract", "hard-to-read", "square", "1970s", "futuristic"],
  },
  "velvetyne/imago-mundi-mei": { skip: "pictographic: the letters are psychogeographic symbols, not readable Latin" },
  "velvetyne/cantique": {
    category: "serif",
    tags: ["serif", "calligraphic", "geometric", "romantic", "swash", "elegant", "ligatures"],
  },
  "velvetyne/lack": {
    // The repository has no licence file, and every font file's copyright notice ends "All rights reserved".
    skip: 'not logo-safe: the font files say "Copyright © 2018 by Adrien Midzic. All rights reserved." and there is no licence file',
  },
  "velvetyne/backout": {
    category: "display",
    tags: ["incised", "glyphic", "brutalist", "humanist", "flared", "african", "albertus-like"],
  },
  "velvetyne/kaerukaeru": {
    category: "display",
    tags: ["soft", "blobby", "organic", "playful", "woodcut", "frog", "rounded"],
    dropTags: ["display"],
  },
  "velvetyne/format-1452": {
    category: "sans",
    tags: ["din-like", "modular", "industrial", "technical", "grotesque", "condensed"],
  },
  "velvetyne/avara": {
    category: "serif",
    tags: ["serif", "curveless", "angular", "lapidary", "transitional", "sharp", "faceted"],
  },
  "velvetyne/vg5000": {
    category: "display",
    tags: ["pixel", "8-bit", "retro", "80s", "computer", "condensed", "monospace"],
  },
  "velvetyne/ouroboros": {
    category: "display",
    tags: ["art-nouveau", "fantasy", "occult", "flared", "organic", "serif", "decorative"],
  },
  "velvetyne/murmure": {
    category: "display",
    tags: ["condensed", "sans", "titling", "high-contrast", "sharp", "editorial", "tall"],
  },
  "velvetyne/compagnon": {
    // Five styles by different students: Light and Roman are one typewriter serif; the "Bold" file is
    // Compagnon Script and Medium is a sans typewriter (README).
    category: "mono",
    tags: ["typewriter", "monospace", "serif", "slab", "retro"],
    variantOf: (file) => (/-Bold\./i.test(file) ? "Script" : /-Medium\./i.test(file) ? "Medium" : ""),
    rows: {
      "Compagnon Script": { category: "handwriting", tags: ["script", "typewriter", "monospace", "connected", "retro"] },
      "Compagnon Medium": { category: "mono", tags: ["typewriter", "monospace", "sans", "bold", "retro"] },
    },
  },
  "velvetyne/happy-times-at-the-ikob": {
    name: "Happy Times at the IKOB",
    category: "serif",
    tags: ["serif", "times-like", "contemporary", "editorial", "quirky", "transitional"],
  },
  "studiotriple/pilowlava": {
    category: "display",
    tags: ["fluid", "lava", "blobby", "organic", "caps", "psychedelic", "curvy"],
    // The metadata file says "cursive"; the letters are separate caps, not a script.
    dropTags: ["cursive"],
    rows: { "Pilowlava Atome": { tags: ["perforated", "fluid", "lava", "blobby", "caps", "psychedelic", "curvy"] } },
  },
  "studiotriple/solide-mirage": {
    // A didone-style display face in two cuts, each its own family in the files, both weight 400:
    // Etroit (narrow) and Mono (monospaced). Unicase-leaning: several lowercase letters are small capitals.
    category: "display",
    tags: ["didone", "high-contrast", "serif", "unicase", "experimental", "fashion"],
    rows: {
      "Solide Mirage Etroit": { tags: ["didone", "condensed", "high-contrast", "serif", "unicase", "experimental", "fashion"] },
      "Solide Mirage Mono": { tags: ["didone", "monospace", "high-contrast", "serif", "unicase", "experimental"] },
    },
  },
  "velvetyne/feroniapi": {
    // Julienne Richard's redesign of Peter Wiegel's Feronia. The font files, README and licence call it
    // Feroniapi (METADATA.yaml still says Feronia, the original). Only a Medium Italic is released, so it
    // is an italic-only row. The README names the CUTE licence, but LICENSE.txt is the OFL 1.1 with
    // Reserved Font Name Feroniapi, and GitLab detects OFL too.
    name: "Feroniapi",
    category: "display",
    tags: ["art-nouveau", "flowing", "elegant", "curvy", "ligatures", "inclusive", "human-made"],
  },
  // GitHub families. Tags and categories come from rendering each face.
  "gh:raoulaudouin/outward": {
    // Block is the regular; Round is slanted 14° (Block's italic); Borders is an outline cut that its
    // file style-links as Bold (weight 700) although it is drawn at Block's width, so it is its own row.
    name: "Outward",
    category: "display",
    tags: ["ultra-condensed", "black", "dense", "tall", "geometric", "poster", "blocky"],
    variantOf: (file) => (/borders/i.test(file) ? "Borders" : ""),
    weights: [[/borders/i, 400]],
    rows: { "Outward Borders": { tags: ["outline", "inline", "ultra-condensed", "tall", "geometric", "poster"] } },
  },
  "gh:ohpla/typefesse": {
    // Two files: Claire-Obscure (contorted line bodies in the lowercase, black frames in the capitals) and
    // Pleine (solid bodies). Both read as capitals at display size.
    category: "display",
    tags: ["butt", "bodies", "playful", "humorous", "illustrative", "caps", "1970s"],
    rename: { "Typefesse Claire Obscure": "Typefesse Claire-Obscure" },
    rows: {
      "Typefesse Claire-Obscure": { tags: ["butt", "bodies", "outline", "playful", "humorous", "illustrative", "caps"] },
      "Typefesse Pleine": { tags: ["butt", "bodies", "solid", "playful", "humorous", "illustrative", "caps"] },
    },
  },
  "gh:velvetyne/bluunext": {
    // Bold (700) and the Titling cut (its own family in the files, 400). Bold Italic is Bluu Next's italic.
    // Velvetyne retired Bluu Next in 2023; the repository and its OFL licence remain.
    name: "Bluu Next",
    category: "serif",
    tags: ["serif", "bold", "high-contrast", "sharp", "flared", "editorial", "headline"],
    rows: { "Bluu Next Titling": { category: "serif", tags: ["serif", "titling", "high-contrast", "sharp", "editorial", "headline"] } },
  },
  "gh:velvetyne/boeticher": {
    // Capitals only, and the figures are ornaments (metadata tag "incomplete"); the letters read well.
    category: "display",
    tags: ["caps", "western", "nautical", "slab", "tuscan", "condensed", "playful"],
    merge: true,
  },
  "gh:velvetyne/hangul": {
    // Latin letters built from the strokes of Hangul; the font calls itself "vtf_hngl".
    name: "Hangul",
    category: "display",
    tags: ["hangul-inspired", "korean", "geometric", "modular", "quirky", "experimental", "sans"],
    // METADATA.yml's "Din-like, condensed" is a copy of Format 1452's; the face is neither.
    dropTags: ["din-like", "condensed"],
    merge: true,
  },
  "gh:velvetyne/victorianna": {
    // One thin upright; the "thin talic" file is its italic (flagged so in the file).
    category: "serif",
    tags: ["thin", "victorian", "serif", "decorative", "elegant", "art-deco", "ligatures"],
  },
  "gh:velvetyne/resistance-generale": {
    // A three-day ENSAD Paris workshop font (METADATA.yml calls it "Demo"). It has no space glyph, so a
    // browser sets spaces in the fallback font; the letters themselves are complete and readable.
    name: "Résistance Générale",
    category: "display",
    tags: ["grotesque", "bold", "workshop", "experimental", "quirky", "80s", "sans"],
  },
  "gh:velvetyne/lment_": {
    name: "Lment",
    category: "display",
    tags: ["geometric", "unicase", "caps", "modular", "experimental", "futuristic", "sans"],
  },
  "gh:velvetyne/runic": {
    // Capitals only (unicase). Plain and Inline (a white line inside each stroke) are both weight 400.
    name: "Runic Sans",
    category: "display",
    // "rune-like", not "runic": a tag equal to the repository name is dropped.
    tags: ["rune-like", "angular", "unicase", "caps", "geometric", "norse", "sharp"],
    rename: { "Runic Sans Plain": "Runic Sans" },
    rows: { "Runic Sans Inline": { tags: ["inline", "rune-like", "angular", "unicase", "geometric", "norse", "sharp"] } },
  },
  "gh:velvetyne/courrrier": {
    // A playful remix of a typewriter face, monospaced, with mixed upper- and lowercase forms.
    category: "mono",
    tags: ["typewriter", "courier-like", "monospace", "quirky", "experimental", "slab", "playful"],
  },
  "gh:velvetyne/commune-nuit-debout": {
    category: "sans",
    tags: ["condensed", "curveless", "sans", "geometric", "tall", "protest", "political"],
    // METADATA.yml's "stencil" describes the Pochoir cut only.
    dropTags: ["stencil"],
    rows: { "Commune Nuit Debout Pochoir": { category: "display", tags: ["stencil", "condensed", "curveless", "sans", "tall", "protest"] } },
  },
  "gh:jckfa/tinyfonts": {
    // TINY 5x3 by Jack Halten Fahnestock, first released on Velvetyne (README). A dot-matrix face with 15
    // instances by dot size (20-300), whose weights are 2.5 × the dot size. Dot sizes 40-280 in steps of 40
    // and 300 give the distinct weights 100-800; the others would round onto them.
    name: "TINY",
    category: "display",
    tags: ["pixel", "dot-matrix", "dots", "bitmap", "retro", "modular", "playful"],
    merge: true,
    only: {
      re: /^TINY5x3-(40|80|120|160|200|240|280|300)\./i,
      reason: "dot-size instances; keeping the eight whose weights round to distinct hundreds (dot size 40-280 by 40, and 300)",
    },
  },
  "phantomfoundry/karrik_fonts": {
    name: "Karrik",
    category: "sans",
    tags: ["grotesque", "raw", "naive", "clumsy", "irregular", "analog", "charming"],
  },
  "raphaelbastide/terminal-grotesque": {
    category: "display",
    tags: ["pixel", "grotesque", "bitmap", "retro", "computer", "lo-fi"],
    rows: { "Terminal Grotesque Open": { tags: ["outline", "pixel", "grotesque", "bitmap", "retro", "lo-fi"] } },
  },
  "eugenie-b/degheest-types": {
    // A collection: each of Ange Degheest's revived typefaces is its own family in the files.
    name: "Degheest",
    category: "display",
    tags: ["revival"],
    skipFiles: [
      { re: /Basalte-Volume\./i, reason: "shading layer of Basalte: alone it shows only fragments of the letters" },
      { re: /Basalte-Multicolor\./i, reason: "colour-layer file of Basalte with no plain outlines; Basalte Fond is the readable base" },
    ],
    rename: { "Basalte Fond": "Basalte" },
    rows: {
      Abordage: { category: "sans", tags: ["geometric", "sans", "friendly", "revival", "rounded"] },
      Basalte: { category: "display", tags: ["condensed", "caps", "bold", "poster", "chromatic", "revival"] },
      Director: { category: "mono", tags: ["typewriter", "monospace", "serif", "slab", "revival"] },
      Equateur: { category: "serif", tags: ["serif", "classic", "editorial", "revival"] },
      FT88: { category: "display", tags: ["pixel", "bitmap", "monospace", "retro", "computer", "revival"] },
      "FT88 Expanded": { category: "display", tags: ["wide", "extended", "geometric", "monoline", "techno", "retro"] },
      "FT88 Gothique": { category: "display", tags: ["pixel", "blackletter", "gothic", "bitmap", "retro"] },
      "FT88 School": { category: "display", tags: ["pixel", "script", "bitmap", "school", "retro"] },
      "FT88 Serif": { category: "display", tags: ["pixel", "serif", "bitmap", "monospace", "retro"] },
      Latitude: { category: "serif", tags: ["serif", "classic", "elegant", "humanist", "revival"] },
      Louise: { category: "handwriting", tags: ["script", "calligraphic", "elegant", "swash", "connected", "revival"] },
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// Repository access. Both hosts give the same view: list a folder, a public URL per file, its bytes.

interface TreeEntry {
  /** Content hash (git blob id on GitLab, jsDelivr's sha256 on GitHub); names the cached copy. */
  id: string;
  name: string;
  type: "tree" | "blob";
  path: string;
}

interface Repo {
  /** For logs: "velvetyne/lineal", "github.com/raoulaudouin/outward". */
  label: string;
  /** HINTS key. */
  key: string;
  name: string;
  path: string;
  webUrl: string;
  created?: string;
  topics: string[];
  /** Licence already confirmed from the repository's licence file (GitHub repositories). */
  license?: string;
  /** GitLab's detected licence key. */
  licenseKey?: string | null;
  list(dir: string, recursive: boolean): Promise<TreeEntry[]>;
  url(file: string): string;
  download(file: string): Promise<Buffer>;
  text(file: string): Promise<string>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Set by build(): where the access helpers report a retry. */
let note: (msg: string) => void = () => {};

// gitlab.com, spaced out so a run stays far below 500 calls a minute, with one retry on HTTP 429.
let lastCall = 0;
async function gitlab(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + GITLAB_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return res;
    await res.body?.cancel();
    if (res.status === 429 && attempt === 1) {
      const after = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(after) && after > 0 ? Math.min(after, 120) * 1000 : 30_000;
      note(`GitLab answered 429 (rate limited); retrying once in ${Math.round(ms / 1000)} s: ${url}`);
      await sleep(ms);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}
const gitlabJson = async <T>(url: string) => (await (await gitlab(url)).json()) as T;

interface Project {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  default_branch: string;
  web_url: string;
  created_at: string;
  description: string | null;
  topics?: string[];
  license?: { key: string; name: string } | null;
}

async function listTree(p: Project, dir: string, recursive: boolean): Promise<TreeEntry[]> {
  const all: TreeEntry[] = [];
  for (let page = 1; page; ) {
    const q = new URLSearchParams({ ref: p.default_branch, per_page: "100", page: String(page) });
    if (dir) q.set("path", dir);
    if (recursive) q.set("recursive", "true");
    const res = await gitlab(`${API}/projects/${p.id}/repository/tree?${q}`);
    all.push(...((await res.json()) as TreeEntry[]));
    page = Number(res.headers.get("x-next-page")) || 0;
  }
  return all;
}

const rawUrl = (p: Project, file: string) =>
  `${API}/projects/${p.id}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(p.default_branch)}`;

function gitlabRepo(p: Project): Repo {
  return {
    label: p.path_with_namespace,
    key: p.path_with_namespace.toLowerCase(),
    name: p.name,
    path: p.path,
    webUrl: p.web_url,
    created: p.created_at,
    topics: p.topics ?? [],
    licenseKey: p.license?.key,
    list: (dir, recursive) => listTree(p, dir, recursive),
    url: (file) => rawUrl(p, file),
    download: async (file) => Buffer.from(await (await gitlab(rawUrl(p, file))).arrayBuffer()),
    text: async (file) => (await gitlab(rawUrl(p, file))).text(),
  };
}

// GitHub through jsDelivr: one flat listing per repository from the data API, files from cdn.jsdelivr.net.

type ListedFile = { name: string; hash: string };
const encPath = (file: string) => file.split("/").map(encodeURIComponent).join("/");
/** Root licence files: LICENSE.txt, license.txt, OFL_BluuNext.txt, licence_BilboINC.txt, COPYING. */
const LICENSE_FILE = /^(?:.*[_-])?(?:licen[cs]e|ofl|copying)(?:[_.-].*)?$/i;

/** Licence text in UTF-8 or, with a byte-order mark, UTF-16 (Bluu Next's OFL file is UTF-16LE). */
async function fetchLicenseText(url: string): Promise<string> {
  const b = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  const even = (x: Buffer) => Buffer.from(x.subarray(0, x.length - (x.length % 2)));
  if (b[0] === 0xff && b[1] === 0xfe) return even(b.subarray(2)).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) return even(b.subarray(2)).swap16().toString("utf16le");
  return b.toString("utf8");
}

/** A pinned listing never changes, so it is kept on disk; a branch listing is fetched every run. */
async function jsdelivrListing(repo: string, ref: string, pinned: boolean): Promise<ListedFile[]> {
  const cached = path.join(CACHE, "listings", `${repo.replace("/", "__")}@${ref}.json`);
  if (pinned && existsSync(cached)) return JSON.parse(await readFile(cached, "utf8")) as ListedFile[];
  const { files } = await fetchJson<{ files: ListedFile[] }>(`https://data.jsdelivr.com/v1/packages/gh/${repo}@${ref}?structure=flat`);
  const slim = files.map(({ name, hash }) => ({ name, hash }));
  if (pinned) {
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(cached, JSON.stringify(slim));
  }
  return slim;
}

async function githubRepo(seed: { repo: string; branch: string }, log: (m: string) => void): Promise<Repo | null> {
  const label = `github.com/${seed.repo}`;
  let branch = seed.branch;
  let ref = branch;
  try {
    // git's ref advertisement (what `git clone` reads first), not the REST API, so no 60-an-hour budget.
    const refs = await fetchText(`https://github.com/${seed.repo}.git/info/refs?service=git-upload-pack`);
    branch = refs.match(/symref=HEAD:refs\/heads\/([^\s\0]+)/)?.[1] ?? branch;
    const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sha = refs.match(new RegExp(`([0-9a-f]{40}) refs/heads/${esc}\\n`))?.[1];
    // jsDelivr's data API refuses some full-length commit ids but accepts a short one.
    if (sha) ref = sha.slice(0, 10);
  } catch (err) {
    log(`${label}: could not read the head commit (${errText(err)}); using branch ${branch}`);
  }
  let files: ListedFile[];
  try {
    files = await jsdelivrListing(seed.repo, ref, ref !== branch);
  } catch (err) {
    if (ref === branch) throw err;
    log(`${label}: jsDelivr has no listing for commit ${ref} (${errText(err)}); using branch ${branch}`);
    ref = branch;
    files = await jsdelivrListing(seed.repo, ref, false);
  }

  const entries: TreeEntry[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const p = f.name.replace(/^\/+/, "");
    entries.push({ id: Buffer.from(f.hash, "base64").toString("hex"), name: path.posix.basename(p), type: "blob", path: p });
    for (let d = path.posix.dirname(p); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  }
  for (const d of dirs) entries.push({ id: d, name: path.posix.basename(d), type: "tree", path: d });
  const parent = (p: string) => (path.posix.dirname(p) === "." ? "" : path.posix.dirname(p));
  const url = (file: string) => `https://cdn.jsdelivr.net/gh/${seed.repo}@${ref}/${encPath(file)}`;

  // Only an OFL licence file at the root lets the repository in.
  const licenseFiles = entries.filter((e) => e.type === "blob" && !e.path.includes("/") && LICENSE_FILE.test(e.name));
  let license: string | undefined;
  for (const e of licenseFiles) {
    if (/open font licen[cs]e/i.test(await fetchLicenseText(url(e.path)))) {
      license = "OFL";
      break;
    }
  }
  if (!license) {
    log(`skip ${label}: no OFL licence file (${licenseFiles.map((e) => e.name).join(", ") || "none found"})`);
    return null;
  }

  const name = seed.repo.split("/")[1];
  return {
    label,
    key: `gh:${seed.repo.toLowerCase()}`,
    name,
    path: name,
    webUrl: `https://github.com/${seed.repo}`,
    topics: [],
    license,
    list: async (dir, recursive) =>
      entries.filter((e) => (recursive ? dir === "" || e.path.startsWith(`${dir}/`) : parent(e.path) === dir)),
    url,
    download: async (file) => Buffer.from(await (await fetchOk(url(file))).arrayBuffer()),
    text: (file) => fetchText(url(file)),
  };
}

// ---------------------------------------------------------------------------------------------------
// Metadata: METADATA.yml / .yaml (Unified Font Repository), FONTINFO.json (Type Design Boilerplate, with
// // comments and trailing commas). Several files are broken (tabs, unresolved merge conflicts), so the
// parse is lenient and falls back to a regex.

interface Meta {
  name?: string;
  tags: string[];
  license?: string;
}

function parseMeta(text: string): Meta {
  let s = text.replace(/\r/g, "").replace(/\t/g, "  ");
  // Unresolved merge conflicts: keep our side.
  s = s.replace(/^<{7}.*\n([\s\S]*?)^={7}.*\n[\s\S]*?^>{7}.*\n?/gm, "$1");
  s = s.replace(/^\s*\/\/.*$/gm, "");
  let obj: unknown;
  try {
    obj = s.trim().startsWith("{") ? JSON.parse(s.replace(/,(\s*[\]}])/g, "$1")) : loadYaml(s);
  } catch {
    obj = undefined;
  }
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const fam = (o["typeface family"] ?? o.typeface ?? o) as Record<string, unknown>;
  let name = typeof fam?.name === "string" ? fam.name : undefined;
  let tags = Array.isArray(fam?.tags) ? fam.tags.filter((t): t is string => typeof t === "string") : [];
  if (!obj) {
    name = s.match(/^\s*name:\s*(.+)$/m)?.[1]?.trim();
    const block = s.match(/^\s*tags:\s*\n((?:\s*-\s*.+\n?)+)/m)?.[1] ?? "";
    tags = [...block.matchAll(/-\s*(.+)/g)].map((m) => m[1].trim());
  }
  const lic = (fam as { licence?: unknown }).licence ?? o.license ?? o.licence;
  return { name: name?.trim() || undefined, tags, license: typeof lic === "string" ? lic : undefined };
}

// ---------------------------------------------------------------------------------------------------
// Names and tags.

/** Lowercase letters and digits only, accents folded: "Façade Sud-Ouest" → "facadesudouest". */
const compact = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const titleWord = (w: string) => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));

/** Style words that never name a variant. */
const STYLE_WORDS = new Set(
  ("thin hairline extralight ultralight extra ultra light regular reg normal book roman medium semibold demibold semi demi " +
    "bold extrabold ultrabold black heavy italic oblique extrafin extrafine fin mince gras maigre master web webfont vf variable")
    .split(" "),
);

/** Variant words from a file name: "Sporting_Grotesque-Bold_web.woff2" → ["Sporting", "Grotesque"]. */
function nameTokens(file: string): string[] {
  const base = path.basename(file).replace(FONT_FILE, "");
  return base
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/(\d)([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((t) => t && !STYLE_WORDS.has(t.toLowerCase()) && !/^0\d$/.test(t));
}

/** Weight implied by the style words of a file name; undefined when it has none. */
function weightFromFileName(file: string): number | undefined {
  const words = path
    .basename(file)
    .replace(FONT_FILE, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/(\d)([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/);
  const joined = words.join("");
  const table: [RegExp, number][] = [
    [/^(thin|hairline|extrafin|extrafine)$/, 100],
    [/^(extralight|ultralight|mince)$/, 200],
    [/^(light|fin|maigre)$/, 300],
    [/^(regular|reg|normal|book|roman)$/, 400],
    [/^medium$/, 500],
    [/^(semibold|demibold)$/, 600],
    [/^(bold|gras)$/, 700],
    [/^(extrabold|ultrabold)$/, 800],
    [/^(black|heavy)$/, 900],
  ];
  // Compounds first: "ExtraBold" splits into "extra" + "bold".
  for (const [re, n] of [[/extralight|ultralight/, 200], [/semibold|demibold/, 600], [/extrabold|ultrabold/, 800]] as [RegExp, number][])
    if (re.test(joined)) return n;
  for (const w of words) for (const [re, n] of table) if (re.test(w)) return n;
  return undefined;
}

const TAG_ALIASES: Record<string, string> = {
  "sans-serif": "sans",
  "sans serif": "sans",
  monospaced: "monospace",
  inktraps: "inktrap",
  incise: "incised",
  ornemental: "ornamental",
  "human made": "human-made",
  "art déco": "art-deco",
  lapidaire: "lapidary",
  contrast: "high-contrast",
};
const TAG_STOP = new Set(
  ("font fonts typeface typography type type-design typedesign design assets dataset free free-font libre open-source " +
    "open-source-font open-source-typeface open-source-typography published incomplete variable medium bold vietnamese " +
    "cyrillic latin velvetyne emotions collaborative")
    .split(" "),
);

/** Lowercase, hyphenated, deduplicated tags; `strict` also drops the generic words found in metadata files. */
function cleanTags(tags: string[], strict: boolean): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    let t = raw.toLowerCase().trim();
    t = TAG_ALIASES[t] ?? t;
    t = t.replace(/\s+/g, "-");
    if (!t || t.length > 24 || (strict && TAG_STOP.has(t)) || t.includes(SOURCE) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

function licenseLabel(key: string | undefined | null, metaLicense: string | undefined): string | undefined {
  const byKey: Record<string, string> = {
    "ofl-1.1": "OFL",
    "bitstream-vera": "Bitstream Vera",
    "lal-1.3": "Art Libre",
    mit: "MIT",
    "apache-2.0": "Apache",
    "cc0-1.0": "CC0",
  };
  if (key && byKey[key]) return byKey[key];
  if (metaLicense && /OFL|open font/i.test(metaLicense)) return "OFL";
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// Faces.

interface Face {
  file: string; // repository path
  url: string;
  info: FontFileInfo;
  wghtAxis?: [number, number];
  ext: string;
}

const extRank = (file: string) => FONT_EXT.indexOf(path.extname(file).slice(1).toLowerCase());

/** One key per drawn style across formats: "happy-times-NG_bold_master_web.woff2" ≡ "happy-times-NG_bold_master.otf". */
function styleKey(file: string): string {
  let s = path.basename(file).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(FONT_FILE, "");
  s = s.replace(/(?:[-_ ]?webfont|[-_ ]web)$/, "");
  s = s.replace(/[-_ ]/g, "");
  return s.replace(/reg$/, "regular");
}

/** Font file signatures: WOFF2, WOFF, CFF OpenType, TrueType ("\0\1\0\0" or "true"). */
const isFontBytes = (b: Buffer) => b.length > 12 && ["wOF2", "wOFF", "OTTO", "\0\x01\0\0", "true"].includes(b.subarray(0, 4).toString("latin1"));

function clampWeight(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 400;
  // Some fonts store 1-9 instead of 100-900.
  if (w < 10) w *= 100;
  return Math.min(900, Math.max(100, Math.round(w / 100) * 100));
}

interface FaceRead {
  info: FontFileInfo;
  latin: boolean;
  wght?: [number, number];
  copyright: string;
}

/**
 * Names, weight, slant, axes and Latin coverage of a font file: common.ts's readFontInfo, except that the
 * axes come from the raw fvar table inside a try. fontkit's variationAxes getter also resolves each axis
 * name and throws on files whose tables it only half reads, which misreported usable faces as unreadable.
 * A file whose axes cannot be read counts as static.
 */
function readFace(buf: Buffer): FaceRead {
  const font = fontkit.create(buf) as fontkit.Font;
  const os2 = (font as unknown as { "OS/2"?: { usWeightClass?: number; fsSelection?: { italic?: boolean } } })["OS/2"];
  const subfamily = font.subfamilyName ?? "";
  type Axis = { axisTag: string; minValue: number; maxValue: number };
  let axes: Axis[] = [];
  try {
    axes = (font as unknown as { fvar?: { axis?: Axis[] } }).fvar?.axis ?? [];
  } catch {
    axes = [];
  }
  const wght = axes.find((a) => a.axisTag.trim() === "wght");
  let copyright = "";
  try {
    copyright = font.getName("copyright", "en") ?? "";
  } catch {
    copyright = "";
  }
  return {
    info: {
      family: font.familyName ?? "",
      subfamily,
      weight: clampWeight(os2?.usWeightClass ?? weightFromStyleName(subfamily)),
      italic: Boolean(os2?.fsSelection?.italic) || ITALIC.test(subfamily),
      variable: axes.length > 0,
    },
    latin: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].every((c) => font.hasGlyphForCodePoint(c.codePointAt(0)!)),
    wght: wght ? [wght.minValue, wght.maxValue] : undefined,
    copyright,
  };
}

async function loadFace(repo: Repo, blob: TreeEntry, log: (m: string) => void): Promise<Face | null> {
  const ext = path.extname(blob.path).toLowerCase();
  const cached = path.join(CACHE, blob.id + ext);
  let buf: Buffer;
  if (existsSync(cached)) {
    buf = await readFile(cached);
  } else {
    buf = await repo.download(blob.path);
    if (!isFontBytes(buf)) throw new Error(`${blob.path} is not a font file (${buf.length} bytes)`);
    await writeFile(cached, buf);
  }
  let read: FaceRead;
  try {
    read = readFace(buf);
  } catch (err) {
    log(`skip ${repo.label}/${blob.path}: unreadable (${errText(err)})`);
    return null;
  }
  if (!read.latin) {
    log(`skip ${repo.label}/${blob.path}: no Latin A-Z`);
    return null;
  }
  if (/all rights reserved/i.test(read.copyright)) log(`${repo.label}/${blob.path}: note, its copyright notice says "All rights reserved"`);
  return { file: blob.path, url: repo.url(blob.path), info: read.info, wghtAxis: read.wght, ext };
}

/** True when the file is an italic or oblique face, by its own flags or by any of its names. */
const isItalic = (f: Face) => f.info.italic || ITALIC.test(f.info.family) || ITALIC.test(path.basename(f.file));

/** An italic's file name without its slant word: "BluuNext-Bolditalic.otf" → "BluuNext-Bold.otf". */
const withoutSlant = (file: string) => path.posix.basename(file).replace(SLANT_WORD, "");

/**
 * The path an italic's upright would have ("Fonts/BluuNext-Bolditalic.otf" → "Fonts/BluuNext-Bold.otf"), so
 * the row, weight hints and name-based weights read an italic the same way as its upright. A slant word on
 * its own is the Regular's italic: "Compagnon-Italic" reads as "Compagnon-Regular", so it weighs 400 by name
 * beside "Compagnon-LightItalic" (both files say 400, as Compagnon's two uprights do).
 */
function uprightPath(file: string): string {
  const name = path.posix.basename(file);
  let upright = withoutSlant(file);
  if (LONE_SLANT.test(name) && weightFromFileName(upright) === undefined) upright = name.replace(LONE_SLANT, "$1Regular");
  return path.posix.join(path.posix.dirname(file), upright);
}

// ---------------------------------------------------------------------------------------------------

async function buildProject(repo: Repo, log: (m: string) => void): Promise<FontEntry[]> {
  const hints = HINTS[repo.key] ?? {};
  if (hints.skip) {
    log(`skip ${repo.label}: ${hints.skip}`);
    return [];
  }

  const root = await repo.list("", false);
  const rootNames = root.filter((e) => e.type === "blob").map((e) => e.name);
  const metaFile = rootNames.find((n) => /^METADATA\.ya?ml$/i.test(n)) ?? rootNames.find((n) => /^FONTINFO\.json$/i.test(n));
  const meta: Meta = metaFile ? parseMeta(await repo.text(metaFile)) : { tags: [] };
  const topics = repo.topics;
  if ([...meta.tags, ...topics].some((t) => /illegible|unreadable/i.test(t))) {
    log(`skip ${repo.label}: tagged illegible`);
    return [];
  }

  // Font files: root-level ones, the font folders, and specimen folders (format upgrades only).
  const released: TreeEntry[] = root.filter((e) => e.type === "blob" && FONT_FILE.test(e.name));
  const specimen: TreeEntry[] = [];
  for (const dir of root.filter((e) => e.type === "tree")) {
    if (FONT_DIR.test(dir.name)) released.push(...(await repo.list(dir.path, true)));
    else if (SPECIMEN_DIR.test(dir.name)) specimen.push(...(await repo.list(dir.path, true)));
  }
  // Leaves out UFO sources and macOS "._" resource-fork files.
  const isFont = (e: TreeEntry) =>
    e.type === "blob" && FONT_FILE.test(e.path) && !/\.ufo\//i.test(e.path) && !/(^|\/)\._/.test(e.path);
  const releasedFonts = released.filter(isFont);
  if (!releasedFonts.length) {
    log(`skip ${repo.label}: no font files (not a font repository)`);
    return [];
  }
  const releasedKeys = new Set(releasedFonts.map((e) => styleKey(e.path)));

  // Best format per style.
  const best = new Map<string, TreeEntry>();
  const score = (e: TreeEntry) => extRank(e.path) * 10 + (specimen.includes(e) ? 1 : 0);
  for (const e of [...releasedFonts, ...specimen.filter(isFont).filter((s) => releasedKeys.has(styleKey(s.path)))]) {
    const k = styleKey(e.path);
    const cur = best.get(k);
    if (!cur || score(e) < score(cur)) best.set(k, e);
  }

  const italicName = (e: TreeEntry) => ITALIC.test(path.basename(e.path));
  let italicEntries = [...best.values()].filter(italicName);
  let chosen = [...best.values()].filter((e) => !italicName(e));
  // `only` and `skipFiles` name upright files; an italic falls under the rule its upright's name does.
  const onlyOk = (e: TreeEntry) => !hints.only || hints.only.re.test(withoutSlant(e.path));
  if (hints.only) {
    const dropped = chosen.filter((e) => !onlyOk(e));
    if (dropped.length) log(`${repo.label}: ${hints.only.reason} (left out ${dropped.length} files)`);
    chosen = chosen.filter(onlyOk);
  }
  const skipRule = (e: TreeEntry) =>
    hints.skipFiles?.find((rule) => rule.re.test(path.basename(e.path)) || rule.re.test(withoutSlant(e.path)));
  for (const e of chosen) {
    const rule = skipRule(e);
    if (rule) log(`skip ${repo.label}/${e.path}: ${rule.reason}`);
  }
  chosen = chosen.filter((e) => !skipRule(e));
  italicEntries = italicEntries.filter((e) => onlyOk(e) && !skipRule(e));

  await mkdir(CACHE, { recursive: true });
  let faces: Face[] = [];
  for (const e of chosen.sort((a, b) => a.path.localeCompare(b.path))) {
    const face = await loadFace(repo, e, log);
    if (face) faces.push(face);
  }
  let slanted = faces.filter(isItalic);
  faces = faces.filter((f) => !isItalic(f));
  // The files named italic were held back until now; they are read whether or not the family has uprights.
  // One that fails to load is left out, and never takes the family's uprights down with it.
  for (const e of italicEntries.sort((a, b) => a.path.localeCompare(b.path))) {
    try {
      const face = await loadFace(repo, e, log);
      if (face) slanted.push(face);
    } catch (err) {
      log(`skip ${repo.label}/${e.path}: ${errText(err)}`);
    }
  }

  // No upright style at all: an italic-only family gets one row, its slanted file as weight 400 (the one
  // nearest 400 when there are several), tagged "italic only". That file is its italic too, so an Italic
  // switch shows the same face.
  let italicOnly = false;
  if (!faces.length) {
    if (!slanted.length) {
      log(`skip ${repo.label}: no readable Latin face`);
      return [];
    }
    const pick = [...slanted].sort(
      (a, b) => Math.abs(a.info.weight - 400) - Math.abs(b.info.weight - 400) || extRank(a.file) - extRank(b.file),
    )[0];
    const others = slanted.filter((f) => f !== pick).map((f) => path.basename(f.file));
    log(
      `${repo.label}: no upright style; using ${path.basename(pick.file)} as weight 400, tagged "italic only"` +
        (others.length ? ` (left out ${others.join(", ")})` : ""),
    );
    faces = [pick];
    slanted = [];
    italicOnly = true;
  }

  // The same face in two formats under different file names (e.g. "Trickster-Reg.otf"): keep the best format.
  // Then static files win over a variable one. Uprights and italics each go through this on their own.
  const tidy = (list: Face[]): Face[] => {
    const byIdentity = new Map<string, Face>();
    for (const f of list) {
      const id = `${compact(f.info.family)}|${compact(f.info.subfamily)}|${f.info.weight}|${f.info.variable}`;
      const cur = byIdentity.get(id);
      if (!cur || extRank(f.file) < extRank(cur.file)) byIdentity.set(id, f);
    }
    const unique = [...byIdentity.values()];
    const statics = unique.filter((f) => !f.info.variable);
    if (!statics.length || statics.length === unique.length) return unique;
    for (const f of unique.filter((x) => x.info.variable)) log(`${repo.label}: using static files instead of ${path.basename(f.file)}`);
    return statics;
  };
  faces = tidy(faces);
  slanted = tidy(slanted);

  // Family name for the repository.
  const projectName = repo.name.replace(/[-_]+/g, " ").replace(/\s+(fonts?|types?|font family)$/i, "").trim();
  const fileKeys = faces.map((f) => compact(nameTokens(f.file).join("")));
  const metaSane =
    meta.name &&
    [compact(repo.name), compact(repo.path), compact(projectName), ...fileKeys].some((k) => k.startsWith(compact(meta.name!)));
  const base = hints.name ?? (metaSane ? meta.name! : projectName.replace(/^\p{Ll}/u, (c) => c.toUpperCase()));
  const baseSlug = slugify(base);

  // Rows: one per variant.
  const rowsByName = new Map<string, Face[]>();
  const rowNameOf = (f: Face): string => {
    if (hints.merge) return base;
    const v = hints.variantOf?.(path.basename(f.file));
    if (v !== undefined) return v ? `${base} ${v}` : base;
    const tokens = nameTokens(f.file);
    const target = compact(base);
    let acc = "";
    for (let i = 0; i < tokens.length; i++) {
      acc += compact(tokens[i]);
      if (acc === target) return [base, ...tokens.slice(i + 1).map(titleWord)].join(" ");
      if (!target.startsWith(acc)) break;
    }
    if (!tokens.length || compact(tokens.join("")) === target) return base;
    return tokens.map(titleWord).join(" ");
  };
  for (const f of faces) {
    let name = rowNameOf(f);
    name = hints.rename?.[name] ?? name;
    rowsByName.set(name, [...(rowsByName.get(name) ?? []), f]);
  }
  // A repository whose files all carry a different name (e.g. "LeMurmure", "happy-times-NG") is one family.
  if (rowsByName.size === 1 && !rowsByName.has(base)) {
    const only = [...rowsByName.values()][0];
    rowsByName.clear();
    rowsByName.set(base, only);
  }

  // Italics join the row of their upright, found from the name the upright file would have. In a family of
  // one row every italic is that row's (Outward Round has no upright called Round: it is Block's italic).
  // An italic of a variant that has no upright row is left out.
  const italicsByName = new Map<string, Face[]>();
  const strays: string[] = [];
  for (const f of slanted) {
    const asUpright = { ...f, file: uprightPath(f.file) };
    let name = rowNameOf(asUpright);
    name = hints.rename?.[name] ?? name;
    if (!rowsByName.has(name) && rowsByName.size === 1) name = [...rowsByName.keys()][0];
    if (!rowsByName.has(name)) {
      strays.push(path.basename(f.file));
      continue;
    }
    italicsByName.set(name, [...(italicsByName.get(name) ?? []), asUpright]);
  }
  if (strays.length) log(`${repo.label}: left out italics with no upright row: ${strays.join(", ")}`);

  const license = repo.license ?? licenseLabel(repo.licenseKey, meta.license) ?? "Unverified";
  if (license === "Unverified") log(`${repo.label}: no licence file or licence statement found in the repository`);
  const dropTags = new Set((hints.dropTags ?? []).map((t) => t.toLowerCase()));
  const out: FontEntry[] = [];
  for (const [name, rowFaces] of rowsByName) {
    const files = italicOnly ? { 400: rowFaces[0].url } : weightsFor(rowFaces, hints, `${repo.label} ${name}`, log);
    const weights = Object.keys(files).map(Number).sort((a, b) => a - b);
    if (!weights.length) continue;
    // Italic weights come the way upright ones do: the files' own weights, with name and hint rules applied
    // to the upright name (so "Basteleur-BoldItalic" takes Basteleur-Bold's 700).
    const rowItalics = italicsByName.get(name);
    const italicFiles = italicOnly ? files : rowItalics ? weightsFor(rowItalics, hints, `${repo.label} ${name} italics`, log) : {};
    if (isExcludedFamily(name)) {
      log(`skip ${name}: excluded family`);
      continue;
    }
    const rowHints = hints.rows?.[name];
    // Curated tags first, then the metadata file's (when it describes this family and this row is not a
    // variant with its own tags); GitLab topics only for repositories without hints.
    const curated = rowHints?.tags ?? hints.tags ?? [];
    const extra = [...(metaSane && !rowHints?.tags ? meta.tags : []), ...(curated.length ? [] : topics)];
    const names = new Set([compact(base), compact(repo.path), compact(name)]);
    const fromMeta = cleanTags(extra, true).filter((t) => !dropTags.has(t));
    const all = [...new Set([...cleanTags(curated, false), ...fromMeta])].filter((t) => !names.has(compact(t)));
    const tags = italicOnly ? [...all.slice(0, 7), "italic only"] : all.slice(0, 8);
    const variant = name === base ? "" : name.startsWith(`${base} `) ? name.slice(base.length + 1) : name;
    out.push({
      id: variant ? `${SOURCE}:${baseSlug}:${slugify(variant)}` : `${SOURCE}:${baseSlug}`,
      family: name,
      source: SOURCE,
      category: rowHints?.category ?? hints.category ?? categoryFromTags(tags, "display"),
      tags,
      weights,
      license,
      files,
      ...(Object.keys(italicFiles).length ? { italicFiles } : {}),
      homepage: repo.webUrl,
      ...(repo.created ? { added: repo.created.slice(0, 10) } : {}),
      proxy: true,
    });
  }
  return out;
}

/** Weight → URL for one row: the files' own weights, name-based weights on a clash, hints first. */
function weightsFor(faces: Face[], hints: RepoHints, label: string, log: (m: string) => void): Record<number, string> {
  const files: Record<number, string> = {};
  const variable = faces.find((f) => f.info.variable && f.wghtAxis);
  if (variable && faces.length === 1) {
    const [min, max] = variable.wghtAxis!;
    for (let w = Math.max(100, Math.ceil(min / 100) * 100); w <= Math.min(900, Math.floor(max / 100) * 100); w += 100) files[w] = variable.url;
    if (Object.keys(files).length) return files;
  }

  const hinted = (f: Face) => hints.weights?.find(([re]) => re.test(path.basename(f.file)))?.[1];
  let weightOf = (f: Face) => hinted(f) ?? f.info.weight;
  const clash = (fn: (f: Face) => number | undefined) => new Set(faces.map(fn)).size < faces.length;
  if (clash(weightOf)) {
    const byName = (f: Face) => hinted(f) ?? weightFromFileName(f.file);
    if (faces.every((f) => byName(f) !== undefined) && !clash(byName)) {
      log(`${label}: files share a weight; using the weights their names give`);
      weightOf = (f) => byName(f)!;
    }
  }
  const regularLike = (f: Face) => /regular|normal|roman|book/i.test(path.basename(f.file)) || weightFromFileName(f.file) === undefined;
  for (const f of faces) {
    const w = weightOf(f);
    const cur = files[w];
    if (cur) {
      const curFace = faces.find((x) => x.url === cur)!;
      // A regular-looking name wins; between equals, the better format (one face in two formats).
      const better = regularLike(f) !== regularLike(curFace) ? regularLike(f) : extRank(f.file) < extRank(curFace.file);
      const keep = better ? f : curFace;
      const drop = keep === f ? curFace : f;
      log(`${label}: ${path.basename(drop.file)} and ${path.basename(keep.file)} both weigh ${w}; keeping ${path.basename(keep.file)}`);
      files[w] = keep.url;
    } else {
      files[w] = f.url;
    }
  }
  return files;
}

export const builder: SourceBuilder = {
  async build(log) {
    note = log;
    for (const [repo, reason] of LEFT_OUT) log(`skip ${repo}: ${reason}`);
    const fonts: FontEntry[] = [];
    // One failing repository is logged and left out; the rest of the catalog still builds.
    const each = async (label: string, open: () => Promise<Repo | null>) => {
      try {
        const repo = await open();
        if (repo) fonts.push(...(await buildProject(repo, log)));
      } catch (err) {
        log(`skip ${label}: FAILED (${errText(err)})`);
      }
    };

    let group: Project[] = [];
    try {
      group = await gitlabJson<Project[]>(`${API}/groups/${GROUP}/projects?per_page=100&include_subgroups=false`);
    } catch (err) {
      log(`could not list the GitLab group "${GROUP}" (${errText(err)}); building the other repositories`);
    }
    log(`${group.length} repositories in the GitLab group, ${EXTERNAL.length} other GitLab repositories, ${GITHUB.length} on GitHub`);
    const gitlabRefs: [string, string][] = [
      ...group.map((p): [string, string] => [p.path_with_namespace, String(p.id)]),
      ...EXTERNAL.map((e): [string, string] => [e, encodeURIComponent(e)]),
    ];
    for (const [label, ref] of gitlabRefs) {
      await each(label, async () => {
        // The project call with license=true also gives created_at, topics and the default branch.
        const p = await gitlabJson<Project>(`${API}/projects/${ref}?license=true`);
        if (!p.default_branch) {
          log(`skip ${p.path_with_namespace}: empty repository`);
          return null;
        }
        return gitlabRepo(p);
      });
    }
    for (const seed of GITHUB) await each(`github.com/${seed.repo}`, () => githubRepo(seed, log));

    // Ids must be unique; a clash would mean two repositories share a family name.
    const seen = new Map<string, number>();
    for (const f of fonts) {
      const n = seen.get(f.id) ?? 0;
      seen.set(f.id, n + 1);
      if (n) f.id = `${f.id}-${n + 1}`;
    }
    return fonts.sort((a, b) => a.family.localeCompare(b.family));
  },
};
