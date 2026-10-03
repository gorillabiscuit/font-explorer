// What Google's font repository says about a family, and which of its files to draw from. No Node
// APIs and no DOM. The local server's /api/google-files (server/googleFiles.ts) reads METADATA.pb
// with it, and fonts.ts picks the full file with it. The online build has no server, so it runs the
// same lookup in the browser (lookupGoogleFiles, at the end); only that touches fetch and storage.

export const GOOGLE_FONTS_REPO = "https://raw.githubusercontent.com/google/fonts/main";
/** The licence folders a family's folder may sit in, tried in this order. */
export const LICENCE_DIRS = ["ofl", "apache", "ufl"];

export interface GoogleFile {
  weight: number;
  /** 'normal' or 'italic', as METADATA.pb gives it. */
  style: string;
  filename: string;
  url: string;
}
export interface GoogleAxis {
  tag: string;
  min: number;
  max: number;
}
/** A family's files and variable axes, as its METADATA.pb lists them. */
export interface GoogleFamilyFiles {
  files: GoogleFile[];
  axes: GoogleAxis[];
}

/** The repository's folder name: the family lowercased with everything but letters and digits removed. */
export function slugOf(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reads the top-level `fonts { ... }` and `axes { ... }` blocks of a METADATA.pb (protobuf text
 * format). They hold no nested braces, unlike the indented `source { files { ... } }` block, which is
 * skipped because only blocks starting at the beginning of a line are read.
 */
export function parseMetadata(text: string, base: string): GoogleFamilyFiles {
  const files: GoogleFile[] = [];
  for (const m of text.matchAll(/^fonts \{([^}]*)\}/gm)) {
    const body = m[1];
    const filename = field(body, "filename");
    const weight = Number(field(body, "weight"));
    if (!filename || !Number.isFinite(weight)) continue;
    // Brackets and commas in variable file names ('SpaceGrotesk[wght].ttf') must be escaped in the URL.
    files.push({ weight, style: field(body, "style") ?? "normal", filename, url: `${base}/${encodeURIComponent(filename)}` });
  }
  const axes: GoogleAxis[] = [];
  for (const m of text.matchAll(/^axes \{([^}]*)\}/gm)) {
    const tag = field(m[1], "tag");
    const min = Number(field(m[1], "min_value"));
    const max = Number(field(m[1], "max_value"));
    if (tag && Number.isFinite(min) && Number.isFinite(max)) axes.push({ tag, min, max });
  }
  return { files, axes };
}

/** One `name: value` line of a block; quoted strings are unquoted. */
function field(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`^\\s*${name}:\\s*(?:"([^"]*)"|(\\S+))`, "m"));
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * The file to draw a weight from, in one style: the static file nearest the weight, or else the
 * variable file. A variable file declares its whole weight range (`weight` is the FontFace weight
 * descriptor), so the browser sets its wght axis from the font-weight it is drawn at. Null when the
 * family has no file in that style: then there is no italic to draw, and none is made up.
 */
export function fullFileFor(info: GoogleFamilyFiles, weight: number, style: "normal" | "italic"): { url: string; weight: string } | null {
  const ofStyle = info.files.filter((x) => x.style === style);
  const statics = ofStyle.filter((x) => !x.filename.includes("["));
  if (statics.length) {
    const best = statics.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a));
    return { url: best.url, weight: String(weight) };
  }
  const variable = ofStyle.find((x) => x.filename.includes("["));
  if (!variable) return null;
  const wght = info.axes.find((a) => a.tag === "wght");
  return { url: variable.url, weight: wght ? `${wght.min} ${wght.max}` : String(weight) };
}

// --- the lookup in the browser ---
// The local app asks its server (/api/google-files), which keeps every answer on disk. The online
// build has no server, so the page asks Google's repository itself, the same way: each licence
// folder in turn. raw.githubusercontent.com sends CORS headers on every answer, 404s included.
// Found answers are kept in this browser for a week; a family that is not there is remembered for
// the visit only, because Google adds families.

const LOOKUP_KEY = "fx:google-files:v1";
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Saved = Record<string, { at: number; found: GoogleFamilyFiles }>;

const answers = new Map<string, GoogleFamilyFiles | null>();
const asking = new Map<string, Promise<GoogleFamilyFiles | null>>();

function readSaved(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOKUP_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Saved) : {};
  } catch {
    return {};
  }
}

function save(slug: string, found: GoogleFamilyFiles): void {
  try {
    const now = Date.now();
    const kept = Object.entries(readSaved()).filter(([, v]) => now - v.at < FOUND_TTL_MS);
    localStorage.setItem(LOOKUP_KEY, JSON.stringify(Object.fromEntries([...kept, [slug, { at: now, found }]])));
  } catch {
    // storage full or blocked: the answer still holds for this visit
  }
}

/**
 * The family's files in Google's repository, asked from the browser. Null when no licence folder has
 * it. Throws when the repository could not be reached, so a failure is never remembered as 'not there'.
 */
export function lookupGoogleFiles(family: string): Promise<GoogleFamilyFiles | null> {
  const slug = slugOf(family);
  if (!slug) return Promise.resolve(null);
  if (answers.has(slug)) return Promise.resolve(answers.get(slug) ?? null);
  const saved = readSaved()[slug];
  if (saved && Date.now() - saved.at < FOUND_TTL_MS && Array.isArray(saved.found?.files)) {
    answers.set(slug, saved.found);
    return Promise.resolve(saved.found);
  }
  let p = asking.get(slug);
  if (!p) {
    p = (async () => {
      for (const dir of LICENCE_DIRS) {
        const res = await fetch(`${GOOGLE_FONTS_REPO}/${dir}/${slug}/METADATA.pb`, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${dir}/${slug}`);
        const parsed = parseMetadata(await res.text(), `${GOOGLE_FONTS_REPO}/${dir}/${slug}`);
        return parsed.files.length ? parsed : null;
      }
      return null;
    })()
      .then((found) => {
        answers.set(slug, found);
        if (found) save(slug, found);
        return found;
      })
      .finally(() => asking.delete(slug));
    asking.set(slug, p);
  }
  return p;
}
