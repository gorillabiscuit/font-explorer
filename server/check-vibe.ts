// Offline check of the vibe prompt and reply parser. No API call. Run: npx tsx server/check-vibe.ts
import { getCatalog } from "./catalog.ts";
import { buildPrompt, describeErrorResult, describeWordmark, mergePicks, parseReply, parseResults } from "./vibe.ts";
import type { FontEntry, VibeRequest } from "../src/types.ts";

// The merged catalog: the cached Fontsource/Fontshare fetch plus the saved indie sources.
const { fonts } = (await getCatalog()) as { fonts: FontEntry[] };
const request: VibeRequest = {
  query: "more like #2 but wider",
  history: [{ query: "more technological", results: [{ family: "Orbitron", reason: "a" }, { family: "Space Grotesk", reason: "b" }] }],
  shortlist: ["Satoshi", "Clash Display"],
  culled: ["Roboto"],
  localFonts: [{ family: "Helvetica Neue", category: "sans" }, { family: "Inter", category: "sans" }],
  constraints: { sources: ["fontsource", "fontshare", "local"], categories: ["sans", "display"] },
  wordmark: { text: "UNIQLO", rendered: "UNI\nQLO", textCase: "upper", formation: "block" },
  brief: "Japanese casual-wear basics for everyone; avoid anything luxurious or techy",
};
const { system, prompt, familyName } = buildPrompt(request, fonts);
// A different name, layout, brief and question: only the user prompt may change.
const other = buildPrompt(
  {
    ...request,
    query: "warmer, a bit handmade",
    history: [],
    wordmark: { text: "Borealis", rendered: "Borealis", textCase: "as", formation: "lockup", descriptor: "COFFEE ROASTERS" },
    brief: "Small-batch coffee roaster in Tromsø",
  },
  fonts,
);

console.log(`system prompt: ${system.length.toLocaleString()} chars ≈ ${Math.round(system.length / 3.5).toLocaleString()} tokens`);
console.log("first catalog lines:\n" + system.split("CATALOG\n")[1].split("\n").slice(0, 5).join("\n"));
console.log("installed block:", JSON.stringify(system.split("INSTALLED ON THIS MACHINE")[1] ?? null));
console.log("user prompt:\n" + prompt);

const cases: [string, string, number][] = [
  ["bare array", '[{"family":"Orbitron","reason":"x"}]', 1],
  ["object wrapper", '{"fonts":[{"family":"Orbitron","reason":"x"}]}', 1],
  ["fenced", '```json\n[{"family":"Orbitron","reason":"x"},{"family":"Exo 2","reason":"y"}]\n```', 2],
  ["prose around", 'Here you go:\n[{"family":"Orbitron","reason":"x"}]\nEnjoy!', 1],
  ["truncated", '[{"family":"Orbitron","reason":"x"},{"family":"Exo 2","reason":"y"},{"family":"Sa', 2],
  ["garbage", "sorry, no", 0],
];
let failed = 0;
for (const [label, text, want] of cases) {
  const got = parseResults(text).length;
  if (got !== want) failed++;
  console.log(`parse ${label}: ${got === want ? "ok" : `FAIL (got ${got}, want ${want})`}`);
}
const twoLists = parseReply('```json\n{"independent":[{"family":"Avara","reason":"a"}],"others":[{"family":"Orbitron","reason":"b"},{"family":"Syne","reason":"c"}]}\n```');
const flatOnly = parseReply('[{"family":"Orbitron","reason":"x"}]');
const merged = mergePicks(
  { independent: [{ family: "Avara", reason: "" }, { family: "Orbitron", reason: "" }, { family: "Terminal Grotesque", reason: "" }], others: [{ family: "Syne", reason: "" }, { family: "Avara", reason: "" }, { family: "Nope Sans", reason: "" }] },
  {
    familyName: (k) => ({ avara: "Avara", orbitron: "Orbitron", "terminal grotesque": "Terminal Grotesque", syne: "Syne" })[k],
    fits: () => true,
    isIndie: (k) => k === "avara" || k === "terminal grotesque",
    culled: new Set(),
  },
);
const base = {
  query: "x",
  history: [],
  shortlist: [],
  culled: [],
  localFonts: [{ family: "Inter", category: "sans" as const }, { family: "Helvetica Neue", category: "sans" as const }],
  wordmark: { text: "Wordmark", rendered: "Wordmark", textCase: "as" as const, formation: "line" as const },
};
const checks: [string, boolean][] = [
  ["family names resolve, any case", familyName("orbitron") === "Orbitron" && familyName("helvetica neue") === "Helvetica Neue"],
  ["fontshare-only keeps Satoshi", buildPrompt({ ...base, constraints: { sources: ["fontshare"], categories: [] } }, fonts).fits("satoshi")],
  ["fontshare-only drops Orbitron", !buildPrompt({ ...base, constraints: { sources: ["fontshare"], categories: [] } }, fonts).fits("orbitron")],
  ["local-only keeps installed Inter, which is also in the catalog", buildPrompt({ ...base, constraints: { sources: ["local"], categories: [] } }, fonts).fits("inter")],
  ["local-only drops Orbitron", !buildPrompt({ ...base, constraints: { sources: ["local"], categories: [] } }, fonts).fits("orbitron")],
  ["serif-only drops Orbitron", !buildPrompt({ ...base, constraints: { sources: [], categories: ["serif"] } }, fonts).fits("orbitron")],
  ["catalog lines name their sources", /\nSatoshi \| sans \| fontshare/.test(system) && /\nRoboto \| sans \| fontsource/.test(system)],
  ["a family on several sources collapses to one row", fonts.filter((f) => f.family === "Space Grotesk").length === 1],
  ["installed block lists Inter too", /INSTALLED ON THIS MACHINE[^]*\nInter \| sans/.test(system)],
  [
    "structured-output failure keeps its reason",
    describeErrorResult({ is_error: true, subtype: "error_max_structured_output_retries", errors: ["Failed to provide valid structured output after 5 attempts"] }).includes("after 5 attempts"),
  ],
  ["no Noto or Playwrite families in the catalog", !fonts.some((f) => /^(Noto|Playwrite)\b/i.test(f.family))],
  ["Notable (not Noto) is kept", fonts.some((f) => f.family === "Notable")],
  ["catalog bands: indie sources, then Fontshare, then Google; nothing very common among the indie", (() => {
    const lines = system.split("CATALOG\n")[1].split("\n");
    // Band by the row's own source, the first one listed (others are where it is also available).
    const band = (l: string) => {
      const primary = (l.split(" | ")[2] ?? "").split(", ")[0];
      return /velvetyne|collletttivo|tunera|usemodify/.test(primary) ? 0 : primary === "fontshare" ? 1 : 2;
    };
    const bands = lines.map(band);
    const ordered = bands.every((b, i) => i === 0 || bands[i - 1] <= b);
    const commonInIndie = lines.some((l, i) => bands[i] === 0 && l.includes("very common"));
    return ordered && !commonInIndie && bands.includes(0) && bands.includes(1) && bands.includes(2);
  })()],
  ["Google beats Fontshare's re-hosted copies (Montserrat is a Google row, also on Fontshare)", (() => {
    const m = fonts.find((f) => f.family === "Montserrat");
    return m?.source === "fontsource" && Boolean(m.alsoOn?.includes("fontshare"));
  })()],
  ["a cut-off two-list reply keeps both lists", (() => {
    const cut = parseReply('{"independent":[{"family":"Avara","reason":"a"}],"others":[{"family":"Syne","reason":"b"},{"family":"Orb');
    return cut.independent.length === 1 && cut.others.length === 1;
  })()],
  ["the most-used Google fonts are marked very common", /\nInter \| sans \| [^|]+\| very common/.test(system)],
  ["two-list reply parses (fenced)", twoLists.independent.length === 1 && twoLists.others.length === 2],
  ["a flat list still parses", flatOnly.independent.length === 0 && flatOnly.others.length === 1],
  [
    "merge interleaves indie first, moves misfiled picks, drops unknown and repeats",
    merged.results.map((r) => r.family).join(",") === "Avara,Orbitron,Terminal Grotesque,Syne" && merged.dropped.join(",") === "Nope Sans",
  ],
  ["expired login gets the sign-in hint", describeErrorResult({ is_error: true, result: "Failed to authenticate: OAuth session expired" }).includes("claude auth login")],
  ["user prompt names the wordmark and its layout", prompt.includes('Wordmark: "UNIQLO" set in capitals as a two-row block (UNI/QLO)')],
  ["user prompt carries the brief", prompt.includes("Brief: Japanese casual-wear basics for everyone; avoid anything luxurious or techy")],
  ["a lockup sends its descriptor line", other.prompt.includes('Wordmark: "Borealis" set in mixed case on one line, with a smaller descriptor line\nDescriptor: COFFEE ROASTERS\nBrief: Small-batch')],
  ["the system prompt is identical across two different requests", system === other.system],
  ["the system prompt never mentions the name or brief", !/UNIQLO|Borealis|Tromsø|casual-wear/.test(system)],
  ["the system prompt carries the wordmark rule", system.includes("Judge each pick on how it sets the given wordmark")],
  ["a request without a name still builds, with no Wordmark line", !buildPrompt({ ...request, wordmark: undefined } as unknown as VibeRequest, fonts).prompt.includes("Wordmark:")],
  ["lowercase stack", describeWordmark({ text: "gyphdk", rendered: "gyp\nhdk", textCase: "lower", formation: "stack" }) === 'Wordmark: "gyphdk" set in lowercase as a two-line stack (gyp/hdk)'],
  ["mixed-case line", describeWordmark({ text: "Polymodal", rendered: "Polymodal", textCase: "as", formation: "line" }) === 'Wordmark: "Polymodal" set in mixed case on one line'],
  ["block with no breaks", describeWordmark({ text: "UNIQLO", rendered: "UNIQLO", textCase: "upper", formation: "block" }) === 'Wordmark: "UNIQLO" set in capitals as a block of equal letter cells'],
  ["monogram", describeWordmark({ text: "Polymodal", rendered: "P", textCase: "as", formation: "mark" }) === 'Wordmark: "Polymodal" set in mixed case as a monogram of its initials (P)'],
  ["an unknown layout reads as one line", describeWordmark({ text: "ACME", rendered: "ACME", textCase: "as", formation: "spiral" as never }) === 'Wordmark: "ACME" set in capitals on one line'],
];
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${label}: ${ok ? "ok" : "FAIL"}`);
}
process.exit(failed ? 1 : 0);
