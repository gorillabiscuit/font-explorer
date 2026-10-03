// Usage: node run_claude.mjs <variant> <model> <label> [effort]   -- same flags as server/vibe.ts askClaudeCode, plus optional --effort
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [variant, model, label, effort] = process.argv.slice(2);
const PICKS = { type: "array", items: { type: "object", properties: { family: { type: "string" }, reason: { type: "string" } }, required: ["family", "reason"], additionalProperties: false } };
const SCHEMA = { type: "object", properties: { independent: PICKS, others: PICKS }, required: ["independent", "others"], additionalProperties: false };
const env = {};
for (const [k, v] of Object.entries(process.env)) { if (/^(ANTHROPIC_|CLAUDE)/.test(k) && !["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"].includes(k)) continue; env[k] = v; }
env.MAX_THINKING_TOKENS = "0";
const args = ["-p", "--output-format", "json", "--model", model, "--system-prompt-file", `/tmp/fx_work/runs/system-${variant}.txt`, "--json-schema", JSON.stringify(SCHEMA), "--tools", "", "--safe-mode", "--strict-mode-placeholder", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none"].filter((a) => a !== "--strict-mode-placeholder");
if (effort) args.push("--effort", effort);
const t0 = Date.now();
const child = spawn("claude", args, { cwd: "/tmp/fx_work", env, stdio: ["pipe", "pipe", "pipe"] });
let out = "", err = "";
child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
child.stdin.end(readFileSync(process.argv[6] ? `/tmp/fx_work/runs/${process.argv[6]}` : `/tmp/fx_work/runs/prompt-${variant}.txt`, "utf8"));
child.on("close", (code) => {
  const wall = Date.now() - t0;
  let reply = null; try { reply = JSON.parse(out.trim().split("\n").pop()); } catch {}
  const so = reply?.structured_output;
  const rec = { label, variant, model, effort: effort ?? null, wall_ms: wall, code, duration_ms: reply?.duration_ms, duration_api_ms: reply?.duration_api_ms, cost: reply?.total_cost_usd, usage: reply?.usage, is_error: reply?.is_error, result_head: (reply?.result ?? "").slice(0, 200), err: err.slice(0, 300), indep: so?.independent, others: so?.others };
  writeFileSync(`/tmp/fx_work/runs/out-${label}.json`, JSON.stringify(rec, null, 1));
  console.log(JSON.stringify({ label, wall_ms: wall, api_ms: rec.duration_api_ms, cost: rec.cost, in: rec.usage?.input_tokens, cacheRead: rec.usage?.cache_read_input_tokens, cacheWrite: rec.usage?.cache_creation_input_tokens, out: rec.usage?.output_tokens, think: rec.usage?.output_tokens_details?.thinking_tokens, n_indep: so?.independent?.length, n_others: so?.others?.length, is_error: rec.is_error, err: rec.err }));
});
