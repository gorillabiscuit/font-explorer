// Builds the app's real vibe prompt (read-only import of the app's code) for the 2,099-family catalog, in variants.
import { readFileSync, writeFileSync } from "node:fs";
import { mergeSources } from "/Users/wouterschreuders/Code/font-explorer/server/catalog.ts";
import { buildPrompt } from "/Users/wouterschreuders/Code/font-explorer/server/vibe.ts";
const APP = "/Users/wouterschreuders/Code/font-explorer";
const remote = JSON.parse(readFileSync(`${APP}/server/.cache/remote-v7.json`, "utf8")).fonts;
const seeds = ["velvetyne", "collletttivo", "tunera", "usemodify"].map((n) => JSON.parse(readFileSync(`${APP}/server/data/${n}.json`, "utf8")).fonts);
const fonts = mergeSources([remote, ...seeds]);
const bySource: Record<string, number> = {};
for (const f of fonts) bySource[f.source] = (bySource[f.source] ?? 0) + 1;
console.log("merged families", fonts.length, JSON.stringify(bySource));
const mkReq = (query: string) => ({
  query, history: [], shortlist: [], culled: [], localFonts: [], constraints: { sources: [], categories: [] },
  wordmark: { text: "", rendered: "", textCase: "as", formation: "line" }, brief: "",
});
const variants: Record<string, (f: any) => any> = {
  tags: (f) => f,                                    // as shipped
  nogoogletags: (f) => (f.source === "fontsource" ? { ...f, tags: [] } : f), // Google mood tags hidden: names + category only
};
for (const [name, fn] of Object.entries(variants)) {
  const fs = fonts.map(fn);
  const q = "fonts that imply fast movement or action";
  const { system, prompt } = buildPrompt(mkReq(q) as any, fs as any);
  writeFileSync(`/tmp/fx_work/runs/system-${name}.txt`, system);
  writeFileSync(`/tmp/fx_work/runs/prompt-${name}.txt`, prompt);
  console.log(name, "system chars", system.length, "user prompt:", JSON.stringify(prompt));
}
writeFileSync("/tmp/fx_work/runs/merged.json", JSON.stringify(fonts.map((f: any) => ({ family: f.family, source: f.source, category: f.category, tags: f.tags, alsoOn: f.alsoOn, common: f.common }))));
