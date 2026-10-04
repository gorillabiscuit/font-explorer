// Runs the test requests in eval/requests.json through one version of vibe search, one real search
// each (on your Claude subscription), and saves every result to eval/runs/<label>/<id>.json.
//
//   npx tsx eval/run.ts after                     this checkout
//   npx tsx eval/run.ts before /path/to/old/copy  another checkout (a git worktree of an older commit)
//
// Searches run one at a time. A request already answered is skipped, so an interrupted run picks up
// where it stopped; one saved as failed is run again. The answering model is saved too (vibe search
// can fall back to another), when the checkout reports it.
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FontEntry, VibeRequest, VibeResponse, VibeWordmark } from "../src/types.ts";

interface TestRequest {
  id: string;
  kind: string;
  query: string;
  shortlist?: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const [label, rootArg] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]+$/.test(label)) {
  console.error("Usage: npx tsx eval/run.ts <label> [code root]");
  process.exit(2);
}
const root = path.resolve(rootArg ?? path.join(here, ".."));
const { getCatalog } = (await import(pathToFileURL(path.join(root, "server", "catalog.ts")).href)) as {
  getCatalog: () => Promise<{ fonts: FontEntry[] }>;
};
const vibe = (await import(pathToFileURL(path.join(root, "server", "vibe.ts")).href)) as {
  vibeSearch: (req: VibeRequest, fonts: FontEntry[]) => Promise<VibeResponse>;
  VIBE_MODEL: string;
};

const { wordmark, requests } = JSON.parse(await readFile(path.join(here, "requests.json"), "utf8")) as {
  wordmark: VibeWordmark;
  requests: TestRequest[];
};
const outDir = path.join(here, "runs", label);
await mkdir(outDir, { recursive: true });
const { fonts } = await getCatalog();
console.log(`[eval] ${label}: ${requests.length} requests on ${vibe.VIBE_MODEL}, code from ${root}, ${fonts.length} fonts`);

for (const r of requests) {
  const file = path.join(outDir, `${r.id}.json`);
  // A finished request is kept; one that failed is asked again.
  const done = await readFile(file, "utf8").then((text) => !(JSON.parse(text) as { error?: string }).error, () => false);
  if (done) continue;
  const req: VibeRequest = {
    query: r.query,
    history: [],
    shortlist: r.shortlist ?? [],
    culled: [],
    localFonts: [],
    constraints: { sources: [], categories: [] },
    wordmark,
    italic: { on: false, only: false },
  };
  let saved: object | null = null;
  for (let attempt = 1; attempt <= 2 && !saved; attempt++) {
    const started = Date.now();
    try {
      const res = await vibe.vibeSearch(req, fonts);
      saved = { id: r.id, kind: r.kind, query: r.query, label, model: vibe.VIBE_MODEL, wallMs: Date.now() - started, ...res };
    } catch (err) {
      console.warn(`[eval] ${r.id} attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      if (attempt === 2) saved = { id: r.id, kind: r.kind, query: r.query, label, model: vibe.VIBE_MODEL, error: String(err), results: [] };
      else await new Promise((done) => setTimeout(done, 5000));
    }
  }
  await writeFile(file, JSON.stringify(saved, null, 2) + "\n");
}
console.log(`[eval] ${label}: done`);
