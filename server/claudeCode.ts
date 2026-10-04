import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// One `claude -p` run, so calls use your Claude subscription, not API billing. Vibe search and the
// one-off font labelling (build-vision.ts) both go through here.

/** Set CLAUDE_BIN in .env when `claude` is not on the server's PATH. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

export interface ClaudeCodeResult {
  is_error?: boolean;
  /** Set on success, and on API errors reported as text (like an expired login). */
  result?: string;
  /** Claude Code's own failures (error_max_structured_output_retries, error_during_execution, ...) carry these instead of result. */
  subtype?: string;
  errors?: string[];
  terminal_reason?: string;
  structured_output?: unknown;
  duration_ms?: number;
  /** Per model that answered, keyed by model id (the fallback model shows up here when it was used). */
  modelUsage?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
}

export interface ClaudeCodeCall {
  /** Sent as a file (--system-prompt-file): the vibe catalog is too big for one command-line argument. */
  system: string;
  /** Sent on stdin. */
  prompt: string;
  model: string;
  /** --effort, for models whose thinking cannot be switched off (Sonnet 5.5, Opus). */
  effort?: string;
  /** --fallback-model, tried when the model is overloaded or not available. */
  fallbackModel?: string;
  /** --json-schema: the reply comes back as structured_output. */
  schema?: object;
  /** --tools; none by default. */
  tools?: string[];
  /** Working directory. Defaults to the temp folder (see run). */
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One `claude -p` run: no tools unless asked, no CLAUDE.md/hooks/plugins/MCP, and no session saved. */
export async function claudeCode(call: ClaudeCodeCall): Promise<ClaudeCodeResult> {
  const systemFile = await writeSystemPrompt(call.system);
  const timeout = AbortSignal.timeout(call.timeoutMs);
  const args = [
    "-p",
    "--output-format", "json",
    "--model", call.model,
    ...(call.effort ? ["--effort", call.effort] : []),
    ...(call.fallbackModel ? ["--fallback-model", call.fallbackModel] : []),
    "--system-prompt-file", systemFile,
    ...(call.schema ? ["--json-schema", JSON.stringify(call.schema)] : []),
    "--tools", (call.tools ?? []).join(","),
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-prompts", "none",
  ];

  let out: { stdout: string; stderr: string; code: number | null };
  try {
    out = await run(CLAUDE_BIN, args, call.prompt, call.signal ? AbortSignal.any([call.signal, timeout]) : timeout, call.cwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Could not run "${CLAUDE_BIN}". Install Claude Code, or set CLAUDE_BIN in .env to the full path of the claude command.`);
    }
    if ((err as Error).name === "AbortError") {
      throw new Error(timeout.aborted ? `Claude Code took longer than ${call.timeoutMs / 1000} s. Try again.` : "Search cancelled.");
    }
    throw err;
  }

  const reply = parseJsonOutput(out.stdout);
  if (!reply) {
    const detail = (out.stderr || out.stdout).trim().slice(0, 400) || "no output";
    throw new Error(`Claude Code failed${out.code ? ` (exit code ${out.code})` : ""}: ${detail}`);
  }
  if (reply.is_error) {
    const { subtype, errors, result, terminal_reason } = reply;
    console.error("[claude] Claude Code error result:", JSON.stringify({ subtype, terminal_reason, errors, result }));
    throw new Error(describeErrorResult(reply));
  }
  return reply;
}

function run(bin: string, args: string[], stdin: string, signal: AbortSignal, cwd?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    // Run from the temp folder by default: Claude Code tracks state per working directory, and searches
    // should not show up against this project (polyship ships sessions under ~/Code/Polymodal).
    const child = spawn(bin, args, { cwd: cwd ?? os.tmpdir(), env: childEnv(), signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); // keeps multi-byte characters intact across chunks
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {}); // the child may exit before reading everything; its output says why
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin);
  });
}

const KEEP_ENV = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Drops every ANTHROPIC_* and CLAUDE* variable except the two above. An API key in the environment would
 * switch Claude Code to API billing, and a parent Claude Code session (the desktop app, its terminal) sets
 * variables that would route the call through that session instead of your own login.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(key) && !KEEP_ENV.has(key)) continue;
    env[key] = value;
  }
  // Claude Code turns on extended thinking by default. Picking from a list doesn't need it, and on Haiku
  // it made a follow-up take ~50 s instead of ~7 s (measured: 3,384 output tokens vs 637). Sonnet 5.5
  // and Opus ignore this; --effort low is their lever.
  env.MAX_THINKING_TOKENS = "0";
  return env;
}

/**
 * The name is a hash of the content, so an existing file is reused; a new one is written aside and
 * renamed into place, so a search running at the same moment never reads a half-written file.
 */
async function writeSystemPrompt(text: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "font-explorer");
  const file = path.join(dir, `system-${createHash("sha1").update(text).digest("hex").slice(0, 16)}.txt`);
  const existing = await stat(file).catch(() => null);
  if (existing?.size === Buffer.byteLength(text)) return file;
  await mkdir(dir, { recursive: true });
  const temp = `${file}.${randomUUID()}`;
  await writeFile(temp, text);
  await rename(temp, file);
  return file;
}

function parseJsonOutput(stdout: string): ClaudeCodeResult | null {
  const candidates = [stdout.trim(), ...stdout.trim().split("\n").reverse()];
  for (const text of candidates) {
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text) as ClaudeCodeResult;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function describeErrorResult(reply: ClaudeCodeResult): string {
  return explainError(reply.result || reply.errors?.join("; ") || reply.subtype || "unknown error");
}

function explainError(message: string): string {
  if (/authenticat|oauth|log ?in|logged out|credential|api key/i.test(message)) {
    return (
      `Claude Code is not signed in (it said: "${message}"). In a terminal, run: claude auth login. ` +
      "Or run claude setup-token and put the token in .env as CLAUDE_CODE_OAUTH_TOKEN=..., then restart npm run dev."
    );
  }
  return `Claude Code: ${message}`;
}
