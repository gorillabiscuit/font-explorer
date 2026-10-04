import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sniff } from "./fontProxy.ts";

// Specimen sheets: up to six typefaces, one per row, labelled A to F and nothing else, drawn by
// headless Chrome into a PNG for build-vision.ts to show Claude. No family names appear anywhere, so
// the labels come from the letters and not from what a name is known for.
//
// Chrome draws a font it cannot load, or a character the font lacks, in a system font without a
// word. A page script checks every row before the picture is taken: whether the face loaded, which
// characters fall back, and whether anything was drawn at all. Characters that fall back are made
// transparent, so the sheet shows only the font's own glyphs (the gap stays), and the findings come
// back through Chrome's DOM dump in the same run.

export const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LINE_1 = "Rafgkwy Hamburgefonstiv";
const LINE_2 = "RAFGKWY HAMBURG 2049";
const WIDTH = 1400;
const ROW = 212;
const PAD = 16;
/** The longest one Chrome run may take; a sheet takes about a second. */
const CHROME_TIMEOUT_MS = 60_000;
/** A row that falls back on more of its characters than this is not the font's drawing any more. */
const MAX_MISSING_SHARE = 0.5;

export interface SheetFont {
  label: string;
  bytes: Buffer;
}

export interface FontCheck {
  label: string;
  /** ok: every character drawn by the font. partial: some fell back and were hidden. failed: not usable. */
  status: "ok" | "partial" | "failed";
  /** The characters the font has no glyph for (hidden on the sheet). */
  missing: string;
  reason?: string;
}

const FORMAT: Record<string, string> = { "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "truetype", "font/otf": "opentype" };

/**
 * Draws the fonts into outPng, one row each, and says per row whether the font really drew it.
 * Rows that fail stay on the picture, so a caller that wants a clean sheet drops them and renders
 * again.
 */
export async function renderSheet(fonts: SheetFont[], outPng: string): Promise<FontCheck[]> {
  const height = fonts.length * ROW + 2 * PAD;
  const dom = await screenshotPage(sheetHtml(fonts, height), WIDTH, height, outPng);
  const found = /<pre id="probe"[^>]*>([^<]*)<\/pre>/.exec(dom)?.[1];
  if (!found) throw new Error("the page's font check did not finish");
  const checks = JSON.parse(unescapeHtml(found)) as FontCheck[];
  if (checks.length !== fonts.length) throw new Error(`the page checked ${checks.length} of ${fonts.length} fonts`);
  return checks;
}

/**
 * Draws a self-contained page (fonts embedded) into outPng with headless Chrome, at the given size,
 * and returns the page as it ended up, after its scripts ran. The test grids in eval/ use it too.
 */
export async function screenshotPage(page: string, width: number, height: number, outPng: string): Promise<string> {
  const work = await mkdtemp(path.join(path.dirname(outPng), ".render-"));
  try {
    const html = path.join(work, "page.html");
    await writeFile(html, page);
    await rm(outPng, { force: true });
    return await chrome(
      [`--user-data-dir=${path.join(work, "profile")}`, `--window-size=${width},${height}`, `--screenshot=${outPng}`, "--dump-dom", pathToFileURL(html).href],
      outPng,
    );
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

/** A font file as a CSS src value, with the format hint browsers want. */
export function fontSrc(bytes: Buffer): string {
  const type = sniff(bytes);
  if (!type) throw new Error("not a font file");
  return `url(data:${type};base64,${bytes.toString("base64")}) format("${FORMAT[type]}")`;
}

/** Chrome's DOM dump escapes these in text. */
function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&");
}

function sheetHtml(fonts: SheetFont[], height: number): string {
  const faces = fonts.map((f, i) => {
    if (!sniff(f.bytes)) throw new Error(`row ${f.label}: not a font file`);
    return `@font-face{font-family:"S${i}";src:${fontSrc(f.bytes)};font-display:block}`;
  });
  const rows = fonts.map(
    (f, i) =>
      `<div class="row" data-face="S${i}" data-label="${f.label}"><div class="label">${f.label}</div>` +
      `<div class="lines" style="font-family:'S${i}',monospace"><div class="l1">${LINE_1}</div><div class="l2">${LINE_2}</div></div></div>`,
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>sheet</title><style>
${faces.join("\n")}
html,body{margin:0;background:#fff;color:#000;width:${WIDTH}px;height:${height}px;overflow:hidden}
body{padding:${PAD}px 0;box-sizing:border-box}
.row{display:flex;height:${ROW}px;box-sizing:border-box;border-top:1px solid #d0d0d0;overflow:clip}
.row:first-child{border-top:none}
.label{flex:none;width:64px;padding-top:32px;text-align:center;font:600 26px -apple-system,"Helvetica Neue",Arial,sans-serif}
.lines{flex:1;min-width:0;padding:22px 24px 0 8px;font-weight:normal;font-style:normal;font-synthesis:none}
.l1,.l2{white-space:nowrap;overflow-x:clip}
.l1{font-size:62px;line-height:86px;height:86px}
.l2{font-size:46px;line-height:64px;height:64px;margin-top:10px}
.miss{color:transparent}
</style></head><body>
${rows.join("\n")}
<pre id="probe" style="display:none"></pre>
<script>${PAGE_CHECK}</script>
</body></html>`;
}

// Runs in the page. A character the font lacks is drawn by the next family in the stack, so it
// measures as wide as the bare monospace AND as the bare serif when the stack ends in each; a glyph
// of the font's own measures the same in both stacks. Ink is counted on a canvas, to catch a face
// that loads but draws nothing.
const PAGE_CHECK = `
(async () => {
  const L1 = ${JSON.stringify(LINE_1)}, L2 = ${JSON.stringify(LINE_2)};
  const chars = [...new Set((L1 + L2).replace(/\\s/g, ""))];
  const canvas = document.createElement("canvas");
  canvas.width = 1400; canvas.height = 200;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const width = (font, ch) => { ctx.font = font; return ctx.measureText(ch).width; };
  const out = [];
  for (const row of document.querySelectorAll(".row")) {
    const face = row.dataset.face, label = row.dataset.label;
    try {
      const ff = [...document.fonts].find((f) => f.family.replace(/["']/g, "") === face);
      let status = "error";
      try { if (ff) { await ff.load(); status = ff.status; } } catch { status = ff ? ff.status : "error"; }
      if (status !== "loaded") { out.push({ label, status: "failed", missing: "", reason: "the browser could not load the file" }); continue; }
      const missing = chars.filter((ch) =>
        width('40px "' + face + '", monospace', ch) === width("40px monospace", ch) &&
        width('40px "' + face + '", serif', ch) === width("40px serif", ch));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      const own = (text) => [...text].filter((ch) => !missing.includes(ch)).join("");
      ctx.font = '62px "' + face + '", monospace';
      ctx.fillText(own(L1), 10, 80);
      ctx.font = '46px "' + face + '", monospace';
      ctx.fillText(own(L2), 10, 170);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 127) ink++;
      for (const line of row.querySelectorAll(".l1, .l2")) {
        line.innerHTML = [...line.textContent].map((ch) => missing.includes(ch) ? '<span class="miss">' + ch + "</span>" : ch).join("");
      }
      if (missing.length / chars.length > ${MAX_MISSING_SHARE}) out.push({ label, status: "failed", missing: missing.join(""), reason: "the font lacks " + missing.length + " of the " + chars.length + " characters" });
      else if (ink < 300) out.push({ label, status: "failed", missing: missing.join(""), reason: "the font draws (almost) nothing" });
      else out.push({ label, status: missing.length ? "partial" : "ok", missing: missing.join("") });
    } catch (err) {
      out.push({ label, status: "failed", missing: "", reason: "the page check broke: " + err });
    }
  }
  document.getElementById("probe").textContent = JSON.stringify(out);
})();
`;

/**
 * One headless Chrome run. Returns the DOM dump once both it and the screenshot are written, then
 * stops Chrome and its helpers (they share its process group): on this Mac, Chrome 154 wrote both
 * within a second and then kept running for minutes, every time.
 */
function chrome(args: string[], png: string): Promise<string> {
  const all = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--use-mock-keychain",
    "--virtual-time-budget=8000",
    ...args,
  ];
  stopOnExit();
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, all, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) live.add(child.pid);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      stop();
      // Wait for the process to go, so the caller can delete its profile folder.
      const done = () => {
        if (child.pid) live.delete(child.pid);
        if (err) reject(err);
        else resolve(stdout);
      };
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once("close", done);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`) : err));
    child.on("close", (code) => {
      if (settled) return;
      if (stdout.includes("</html>")) finish(null);
      else finish(new Error(`Chrome exited (code ${code}) without output: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
    // The DOM dump comes on stdout; Chrome says "N bytes written to file" on stderr once the PNG is saved.
    const poll = setInterval(async () => {
      if (!stdout.includes("</html>") || !/bytes written to file/.test(stderr)) return;
      const png_ = await stat(png).catch(() => null);
      if (png_?.size) finish(null);
    }, 100);
    const timer = setTimeout(() => finish(new Error(`Chrome took longer than ${CHROME_TIMEOUT_MS / 1000} s`)), CHROME_TIMEOUT_MS);
  });
}

/** Chrome runs in a process group of its own (so it can be stopped with its helpers); Ctrl-C would not reach it. */
const live = new Set<number>();
let hooked = false;

function stopOnExit() {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const pid of live) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}
