// Each project (one client and name) is mirrored to server/projects/<id>.json, so a browser reset
// loses nothing and two clients' work never shares a file. The browser's localStorage stays the
// instant copy; this is the durable one. The files hold client names and briefs, so the folder is
// gitignored.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, "projects");
/** The browser uses the same rule. Anything else (a dot, a slash, '..') never gets near the disk. */
const PROJECT_ID = /^[a-z0-9-]{1,40}$/;
const PROJECT_FILE = /^([a-z0-9-]{1,40})\.json$/;
const MAX_BYTES = 2 * 1024 * 1024;

export interface ProjectListing {
  id: string;
  name: string;
  updatedAt: number;
}

/**
 * Everything under /api/projects, in one handler, so that even '/api/projects/../x' (which no
 * single-segment route would match) is answered here with a 400 instead of slipping past.
 *   GET /api/projects       list {id, name, updatedAt}, most recently changed first
 *   GET /api/projects/:id   the saved project, or null when it is not on disk yet
 *   PUT /api/projects/:id   save the whole project (a JSON object with a numeric updatedAt)
 */
export async function projectsApi(req: Request, res: Response) {
  try {
    if (req.path === "/") {
      if (req.method !== "GET") return void res.status(405).json({ error: "Use GET to list projects." });
      return void res.json(await listProjects());
    }
    let id: string;
    try {
      id = decodeURIComponent(req.path.slice(1));
    } catch {
      id = "";
    }
    if (!PROJECT_ID.test(id)) {
      return void res.status(400).json({ error: "Project ids are 1-40 characters of a-z, 0-9 and '-'." });
    }
    if (req.method === "GET") {
      const text = await readFile(fileFor(id), "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      // null rather than a 404: every new project is opened before its first save, and a 404 would
      // print a failed request in the browser console each time.
      if (text === null) return void res.json(null);
      return void res.type("json").send(text);
    }
    if (req.method === "PUT") return void (await saveProject(id, req.body, res));
    res.status(405).json({ error: "Use GET or PUT." });
  } catch (err) {
    console.error("[projects]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

const fileFor = (id: string) => path.join(DIR, `${id}.json`);

async function saveProject(id: string, body: unknown, res: Response) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return void res.status(400).json({ error: "Send the project as a JSON object." });
  }
  const updatedAt = (body as { updatedAt?: unknown }).updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return void res.status(400).json({ error: "The project needs a numeric updatedAt." });
  }
  const text = JSON.stringify(body);
  // The JSON parser already caps request bodies; this keeps the cap even if that limit is raised.
  if (Buffer.byteLength(text) > MAX_BYTES) return void res.status(413).json({ error: "A project can be at most 2 MB." });

  // One write at a time per project, so the newer-copy check and the write cannot interleave.
  await serial(id, async () => {
    // Saves can arrive out of order (a slow one after a fast one). An older copy never replaces a newer one.
    const existing = await readUpdatedAt(id);
    if (existing !== null && existing > updatedAt) {
      res.status(409).json({ error: "The server has a newer copy of this project.", updatedAt: existing });
      return;
    }
    await mkdir(DIR, { recursive: true });
    // Written aside and renamed into place, so a crash or a reader never sees half a file.
    const temp = `${fileFor(id)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, text);
      await rename(temp, fileFor(id));
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    res.json({ ok: true, updatedAt });
  });
}

async function readUpdatedAt(id: string): Promise<number | null> {
  try {
    const saved = JSON.parse(await readFile(fileFor(id), "utf8")) as { updatedAt?: unknown };
    return typeof saved.updatedAt === "number" ? saved.updatedAt : null;
  } catch {
    return null; // missing or unreadable: the new copy replaces it
  }
}

async function listProjects(): Promise<ProjectListing[]> {
  const names = await readdir(DIR).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw err;
  });
  const out: ProjectListing[] = [];
  for (const file of names) {
    const id = PROJECT_FILE.exec(file)?.[1];
    if (!id) continue; // temp files and anything else
    try {
      const saved = JSON.parse(await readFile(path.join(DIR, file), "utf8")) as { name?: unknown; updatedAt?: unknown };
      out.push({
        id,
        name: typeof saved.name === "string" && saved.name.trim() ? saved.name : id,
        updatedAt: typeof saved.updatedAt === "number" ? saved.updatedAt : 0,
      });
    } catch (err) {
      console.warn(`[projects] skipped ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

const queues = new Map<string, Promise<void>>();
function serial(id: string, task: () => Promise<void>): Promise<void> {
  const run = (queues.get(id) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}
