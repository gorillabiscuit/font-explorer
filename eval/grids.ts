// Draws each saved result list from eval/run.ts as a picture for blind judging: the fonts in rank
// order, numbered, each setting the test wordmark, with no family names. Each request gets two
// pictures under neutral names (<id>-x.png, <id>-y.png), which version is which decided by a hash of
// the id, and the key is written next to the folder, not in it.
//
//   npx tsx eval/grids.ts before after <out folder>
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getCatalog } from "../server/catalog.ts";
import { loadRegularFont } from "../server/fontFiles.ts";
import { fontSrc, screenshotPage } from "../server/specimen.ts";
import type { FontEntry, VibeResult, VibeWordmark } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const [a, b, outArg] = process.argv.slice(2);
if (!a || !b || !outArg) {
  console.error("Usage: npx tsx eval/grids.ts <label A> <label B> <out folder>");
  process.exit(2);
}
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });

const WIDTH = 1400;
const CELL_H = 128;
const COLUMNS = 2;
const MAX_FONTS = 20;
const SAMPLE = "Rafgkwy HAMBURG 2049";

const { wordmark, requests } = JSON.parse(await readFile(path.join(here, "requests.json"), "utf8")) as {
  wordmark: VibeWordmark;
  requests: { id: string; query: string }[];
};
const { fonts } = await getCatalog();
const byFamily = new Map<string, FontEntry>(fonts.map((f) => [f.family.toLowerCase(), f]));

const bytes = new Map<string, Promise<Buffer | null>>();
function fontBytes(f: FontEntry): Promise<Buffer | null> {
  let p = bytes.get(f.family);
  if (!p) {
    p = loadRegularFont(f).then(
      (file) => file.bytes,
      () => null,
    );
    bytes.set(f.family, p);
  }
  return p;
}

const key: Record<string, { x: string; y: string; query: string }> = {};
for (const r of requests) {
  // Which version is x: the first bit of a hash of the id, so it is fixed but not always the same side.
  const flip = createHash("sha1").update(r.id).digest()[0] & 1;
  const [x, y] = flip ? [b, a] : [a, b];
  key[r.id] = { x, y, query: r.query };
  for (const [side, label] of [["x", x], ["y", y]] as const) {
    const run = JSON.parse(await readFile(path.join(here, "runs", label, `${r.id}.json`), "utf8")) as { results: VibeResult[]; error?: string };
    if (run.error) throw new Error(`${label} ${r.id} failed (${run.error.slice(0, 80)}); run eval/run.ts again first`);
    const picks = run.results.slice(0, MAX_FONTS).flatMap((res) => byFamily.get(res.family.toLowerCase()) ?? []);
    const loaded = await Promise.all(picks.map(async (f) => ({ f, data: await fontBytes(f) })));
    const rows = Math.ceil(Math.max(1, loaded.length) / COLUMNS);
    const height = rows * CELL_H + 24;
    const faces = loaded.map(({ data }, i) => (data ? `@font-face{font-family:"F${i}";src:${fontSrc(data)};font-display:block}` : ""));
    const cells = loaded.map(
      ({ data }, i) =>
        `<div class="cell"><span class="n">${i + 1}</span>` +
        (data ? `<div class="w" style="font-family:'F${i}',monospace">${escapeHtml(wordmark.text)}</div><div class="s" style="font-family:'F${i}',monospace">${SAMPLE}</div>` : `<div class="s">(could not load)</div>`) +
        `</div>`,
    );
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>
${faces.join("\n")}
html,body{margin:0;background:#fff;color:#111;width:${WIDTH}px;height:${height}px;overflow:hidden}
body{display:grid;grid-template-columns:repeat(${COLUMNS},1fr);grid-auto-rows:${CELL_H}px;padding:12px 0;box-sizing:border-box}
.cell{position:relative;border-top:1px solid #ddd;padding:8px 20px 0 52px;overflow:clip;font-synthesis:none}
.n{position:absolute;left:14px;top:12px;font:600 18px -apple-system,Helvetica,Arial,sans-serif;color:#888}
.w{font-size:62px;line-height:78px;white-space:nowrap}
.s{font-size:24px;line-height:32px;white-space:nowrap;color:#444}
</style></head><body>${cells.join("")}</body></html>`;
    await screenshotPage(page, WIDTH, height, path.join(out, `${r.id}-${side}.png`));
  }
  console.log(`[grids] ${r.id}`);
}
// The key goes beside the folder, so a judge given the folder does not find it.
await writeFile(`${out}-key.json`, JSON.stringify(key, null, 2) + "\n");
console.log(`[grids] ${requests.length * 2} pictures in ${out}; key in ${out}-key.json`);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
