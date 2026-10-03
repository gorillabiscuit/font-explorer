// Refreshes the saved catalogs of the indie sources: `npm run sources` (all) or `npm run sources -- tunera`.
// Each builder lives in server/sources/<name>.ts and exports `builder`. Output: server/data/<name>.json.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceBuilder } from "./sources/common.ts";

const ALL = ["velvetyne", "collletttivo", "tunera", "usemodify"];
const here = path.dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2).filter((a) => a !== "--");
const names = wanted.length ? wanted : ALL;

let failed = 0;
for (const name of names) {
  const started = Date.now();
  const log = (msg: string) => console.log(`[${name}] ${msg}`);
  try {
    const { builder } = (await import(`./sources/${name}.ts`)) as { builder: SourceBuilder };
    const rows = await builder.build(log);
    if (!rows.length) throw new Error("builder returned no rows");
    await mkdir(path.join(here, "data"), { recursive: true });
    const file = path.join(here, "data", `${name}.json`);
    await writeFile(file, JSON.stringify({ builtAt: new Date().toISOString(), fonts: rows }, null, 1) + "\n");
    log(`${rows.length} families → ${path.relative(process.cwd(), file)} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  } catch (err) {
    failed++;
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
