import "dotenv/config";
import express from "express";
import { getCatalog } from "./catalog.ts";
import { fontProxy } from "./fontProxy.ts";
import { googleFiles } from "./googleFiles.ts";
import { projectsApi } from "./projects.ts";
import { vibeSearch } from "./vibe.ts";
import type { VibeRequest } from "../src/types.ts";

// Not PORT: launchers set that for the web half, and the two would collide.
const PORT = Number(process.env.API_PORT ?? 8787);
const app = express();

// Local only: listen on the loopback address, and refuse requests whose Host header names anything
// else, so neither another device on the network nor a DNS-rebinding web page can run searches.
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
app.use((req, res, next) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (ALLOWED_HOSTS.has(host)) return next();
  res.status(403).send("Local requests only");
});
app.use(express.json({ limit: "2mb" }));

app.get("/api/catalog", async (req, res) => {
  const catalog = await getCatalog(req.query.refresh === "1");
  res.json(catalog);
});

app.get("/api/font", fontProxy);
app.get("/api/google-files", googleFiles);

// Behind the same Host check as everything else: these files hold client names and briefs.
app.use("/api/projects", projectsApi);

app.post("/api/vibe", async (req, res) => {
  const body = req.body as VibeRequest;
  if (!body?.query?.trim()) {
    res.status(400).json({ error: "Empty request." });
    return;
  }
  // Stop the Claude Code run if the page goes away mid-search.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  try {
    const { fonts } = await getCatalog();
    res.json(await vibeSearch(body, fonts, abort.signal));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vibe]", message);
    res.status(502).json({ error: message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[api] listening on http://127.0.0.1:${PORT}`);
  // Warm the catalog so the first page load is quick.
  getCatalog().catch((err) => console.error("[catalog] warmup failed", err));
});
