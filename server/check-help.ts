// The How it works panel against KEYMAP: every key it names is a real binding, no key is named in
// plain words, and the bindings the panel describes are the ones the brief named. Prints the panel
// as text with its key caps. Exit 1 on any problem. Run: npm run check:help
import { helpContent, helpProblems, keysOf, bindingOf, type Part } from "../src/helpContent.ts";
import { KEYMAP, formatKeys } from "../src/keymap.ts";

const content = helpContent("2,100");
const problems = helpProblems(content);

// What each sentence promises, checked against the live KEYMAP (the words next to a cap must fit
// the binding it draws): scope:action -> the keys the brief names for it.
const PROMISED: Record<string, string[]> = {
  "grid:layout": ["1", "2", "3", "4", "5"],
  "grid:move": ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
  "grid:cull": ["x"], "grid:maybe": ["m"], "grid:shortlist": ["s"], "grid:pin": ["p"],
  "grid:open": ["Space"], "lightbox:flip": ["ArrowLeft", "ArrowRight"], "lightbox:blink": ["b"],
  "lightbox:alternates": ["a"], "grid:italic": ["i"], "grid:copy": ["Mod+c"], "global:help": ["?"], "global:undo": ["Mod+z"],
};
const parts: Part[] = [...content.intro, ...content.onlineOnly.flat(), ...content.steps.flat(), ...content.outro];
const used = new Map<string, readonly string[]>();
for (const p of parts) if (typeof p === "object" && "keys" in p) used.set(`${p.keys.scope}:${p.keys.action}`, keysOf(p.keys));
for (const [id, keys] of Object.entries(PROMISED)) {
  const drawn = used.get(id);
  if (!drawn) problems.push(`the panel never draws ${id}`);
  else if (drawn.join(" ") !== keys.join(" ")) problems.push(`${id} draws ${drawn.join(" ")}, the brief says ${keys.join(" ")}`);
  const [scope, action] = id.split(":");
  const b = bindingOf({ scope: scope as never, action });
  if (b && !keys.every((k) => b.keys.includes(k))) problems.push(`KEYMAP ${id} is ${b.keys.join(" ")}, not ${keys.join(" ")}`);
}
for (const id of used.keys()) if (!PROMISED[id]) problems.push(`${id} is drawn but not checked here`);

const text = (ps: Part[]) => ps.map((p) => (typeof p === "string" ? p : "ui" in p ? `**${p.ui}**` : "typed" in p ? `'${p.typed}'` : "field" in p ? `[${p.field}]` : `[${formatKeys(keysOf(p.keys))}]`)).join("");
console.log(text(content.intro));
content.onlineOnly.forEach((l) => console.log("  (online) " + text(l)));
content.steps.forEach((s, i) => console.log(`  ${i + 1}. ${text(s)}`));
console.log(text(content.outro));
console.log(`${used.size} bindings drawn, KEYMAP has ${KEYMAP.length}`);
if (problems.length) { console.log("FAIL\n  " + problems.join("\n  ")); process.exit(1); }
console.log("PASS: every key in the panel comes from KEYMAP and matches it");
