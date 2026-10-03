// Mirrors the active project to the local server (server/projects/<id>.json), so a browser reset
// loses nothing. localStorage stays the instant copy: the page never waits on the server.
//
// When a project opens, the newer of the two copies wins, judged by updatedAt (the time of the last
// change, kept beside the project's fields in localStorage). After that, every change is PUT as one
// whole snapshot, a second after the last edit. A save that does not get through is tried again on
// its own, waiting longer each time.
//
// Nothing is saved before the two copies have met. If the server does not answer when a project
// opens, changes stay in this browser and the server is asked again (after each change, and on a
// timer); only its answer decides whether this browser's copy may replace the one on disk.
// Otherwise a browser that opened the project empty (or with an older copy) while the server was
// down would overwrite the real copy with its first change.
//
// One exception guards the user's existing work: state saved before syncing existed has no
// updatedAt. A server copy only replaces it when this browser holds nothing at all (a cleared or
// new browser). Otherwise any other browser that opened the app empty would wipe it.
//
// The online build has no server, so there a project lives in this browser only: nothing is sent or
// compared, and the status always reads 'local'. Changes are still stamped, for the project list.
import { useEffect, useMemo, useRef, useState } from "react";
import { STATIC } from "./env";
import { deepMerge, isPlainObject } from "./merge";
import { DEFAULT_FILTERS, DEFAULT_SETTINGS, type Filters, type Settings } from "./settings";
import type { Marks, Pinned } from "./store";
import type { VibeTurn } from "./types";

export interface ProjectMeta {
  name: string;
  /** One line: what it is, for whom, words to avoid. Claude reads it with every vibe search. */
  brief: string;
}

/** Everything that makes up a project, as saved on the server. */
export interface ProjectSnapshot extends ProjectMeta {
  settings: Settings;
  filters: Filters;
  marks: Marks;
  vibes: VibeTurn[];
  activeVibe: string | null;
  pinned: Pinned | null;
  /** ms timestamp of the last change. */
  updatedAt: number;
}
export type ProjectState = Omit<ProjectSnapshot, "updatedAt">;

/**
 * 'offline': the last save did not get through, so the latest changes live only in this browser
 * for now; it is tried again on its own. 'unchecked': the server did not answer when the project
 * opened, so it has not been compared with the copy on disk and nothing is saved until it has.
 */
export type SyncStatus = "local" | "saving" | "saved" | "offline" | "unchecked";

export interface ProjectListing {
  id: string;
  name: string;
  updatedAt: number;
}

const PROJECT_ID = /^[a-z0-9-]{1,40}$/;
const SAVE_DELAY_MS = 1000;
const LOAD_TIMEOUT_MS = 4000;
/** The first wait before asking a silent server again; it doubles up to MAX_RETRY_MS. */
const RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;

export function defaultProjectName(id: string): string {
  return id === "default" ? "Default" : id;
}

// store.ts keeps each project field under `fx:p:<id>:<field>`; the time of the last change sits beside them.
const updatedKey = (id: string) => `fx:p:${id}:updatedAt`;

function readUpdatedAt(id: string): number {
  try {
    const n = Number(localStorage.getItem(updatedKey(id)));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Writes a project's fields to their `fx:p:<id>:<field>` keys straight away (store.ts reads them
 * there). False when storage refused any of them.
 */
function writeFields(id: string, p: ProjectState): boolean {
  const fields: Record<string, unknown> = {
    meta: { name: p.name, brief: p.brief },
    settings: p.settings,
    filters: p.filters,
    marks: p.marks,
    vibes: p.vibes,
    activeVibe: p.activeVibe,
    pinned: p.pinned,
  };
  try {
    for (const [field, value] of Object.entries(fields)) localStorage.setItem(`fx:p:${id}:${field}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Records a change to a project made outside the live state (a new or duplicated project). */
export function writeUpdatedAt(id: string, at: number): void {
  try {
    localStorage.setItem(updatedKey(id), String(at));
  } catch {
    // storage blocked: the server copy is still written, it just cannot be compared on the next load
  }
}

/** What this browser held when a project opened: the comparison with the server copy judges by it. */
interface Opened {
  /** updatedAt of the local copy, 0 when it has none. */
  at: number;
  /** Nothing saved here at all, so the page showed defaults. */
  blank: boolean;
}

// A project changed before the server ever answered keeps a note of what the browser held when it
// opened. Those edits are not stamped (a stamp would make them look newer than the copy on disk),
// so without the note a reload would mistake them for state saved before syncing existed, which
// the server never replaces. With it, the comparison still sees what they were made on.
const uncheckedKey = (id: string) => `fx:p:${id}:unchecked`;

function readUnchecked(id: string): Opened | null {
  try {
    const raw = JSON.parse(localStorage.getItem(uncheckedKey(id)) ?? "null") as unknown;
    return isPlainObject(raw) && typeof raw.at === "number" && typeof raw.blank === "boolean" ? { at: raw.at, blank: raw.blank } : null;
  } catch {
    return null;
  }
}

function writeUnchecked(id: string, opened: Opened): void {
  try {
    localStorage.setItem(uncheckedKey(id), JSON.stringify({ at: opened.at, blank: opened.blank }));
  } catch {
    // storage blocked: the live comparison still holds until the page closes
  }
}

function clearUnchecked(id: string): void {
  try {
    localStorage.removeItem(uncheckedKey(id));
  } catch {
    // storage blocked: nothing was written either
  }
}

/** One string per project state, to tell a real change from a re-render. Field order is fixed. */
function contentOf(s: ProjectState): string {
  return JSON.stringify([s.name, s.brief, s.settings, s.filters, s.marks, s.vibes, s.activeVibe, s.pinned]);
}

/** What a browser with nothing saved shows for a project. */
function blankContent(id: string): string {
  return contentOf({
    name: defaultProjectName(id),
    brief: "",
    settings: DEFAULT_SETTINGS,
    filters: DEFAULT_FILTERS,
    marks: { verdicts: {}, candidates: [] },
    vibes: [],
    activeVibe: null,
    pinned: null,
  });
}

/**
 * A saved project in the shape the page expects. Fields missing from an older file get their
 * defaults, the same way localStorage reads do (hooks.ts readStored), so equal states compare equal.
 */
function normalize(raw: unknown, id: string): ProjectSnapshot | null {
  if (!isPlainObject(raw) || typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;
  const marks = raw.marks;
  const pinned = raw.pinned;
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : defaultProjectName(id),
    brief: typeof raw.brief === "string" ? raw.brief : "",
    settings: deepMerge(DEFAULT_SETTINGS, isPlainObject(raw.settings) ? raw.settings : {}),
    filters: deepMerge(DEFAULT_FILTERS, isPlainObject(raw.filters) ? raw.filters : {}),
    marks:
      isPlainObject(marks) && isPlainObject(marks.verdicts) && Array.isArray(marks.candidates)
        ? (marks as unknown as Marks)
        : { verdicts: {}, candidates: [] },
    vibes: Array.isArray(raw.vibes) ? (raw.vibes as VibeTurn[]) : [],
    activeVibe: typeof raw.activeVibe === "string" ? raw.activeVibe : null,
    pinned: isPlainObject(pinned) && typeof pinned.fontId === "string" && isPlainObject(pinned.recipe) ? (pinned as unknown as Pinned) : null,
    updatedAt: raw.updatedAt,
  };
}

async function fetchProject(id: string, signal: AbortSignal): Promise<ProjectSnapshot | null> {
  const res = await fetch(`/api/projects/${id}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(LOAD_TIMEOUT_MS)]) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Loading the project failed (${res.status})`);
  const raw: unknown = await res.json(); // null: not saved on disk yet
  return raw === null ? null : normalize(raw, id);
}

/**
 * 'saved' when the server has the snapshot (or an even newer copy), 'retry' when it did not answer
 * (down, or the dev proxy could not reach it), or the status code of a refusal that retrying cannot fix.
 */
async function putProject(id: string, body: ProjectSnapshot, keepalive: boolean): Promise<"saved" | "retry" | number> {
  const init: RequestInit = { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res: Response;
  try {
    res = await fetch(`/api/projects/${id}`, { ...init, keepalive });
  } catch {
    // keepalive refuses bodies over 64 KB; a plain request still has a chance while the page closes.
    if (!keepalive) return "retry";
    try {
      res = await fetch(`/api/projects/${id}`, init);
    } catch {
      return "retry";
    }
  }
  // 409: a later save already landed first, so the server's copy is newer than this one.
  if (res.ok || res.status === 409) return "saved";
  return res.status >= 500 ? "retry" : res.status;
}

interface Job {
  id: string;
  body: ProjectSnapshot;
}

/**
 * Keeps the active project and its server copy in step. `apply` swaps the whole live state for a
 * newer server copy; `notify` tells the user when that replaced edits made here. Returns how
 * syncing stands, for the project switcher.
 */
export function useProjectSync(
  projectId: string,
  state: ProjectState,
  apply: (s: ProjectSnapshot) => void,
  notify?: (text: string, opts: { ms: number }) => void,
): SyncStatus {
  // STATIC never changes while the page runs, so every render calls the same hooks.
  return STATIC ? useBrowserOnly(projectId, state) : useDiskSync(projectId, state, apply, notify);
}

/**
 * The online build: the project's fields are already in localStorage (store.ts writes them), so all
 * that is left is stamping each real change, which orders the project list. Opening another project
 * is not a change to it.
 */
function useBrowserOnly(projectId: string, state: ProjectState): SyncStatus {
  const content = useMemo(
    () => contentOf(state),
    [state.name, state.brief, state.settings, state.filters, state.marks, state.vibes, state.activeVibe, state.pinned],
  );
  const seen = useRef({ projectId, content });
  useEffect(() => {
    const before = seen.current;
    seen.current = { projectId, content };
    if (before.projectId === projectId && before.content !== content) writeUpdatedAt(projectId, Date.now());
  }, [projectId, content]);
  return "local";
}

function useDiskSync(
  projectId: string,
  state: ProjectState,
  apply: (s: ProjectSnapshot) => void,
  notify?: (text: string, opts: { ms: number }) => void,
): SyncStatus {
  const [saveStatus, setSaveStatus] = useState<Exclude<SyncStatus, "unchecked">>("local");
  const [unchecked, setUnchecked] = useState(false);
  // Each field keeps its identity until it changes, so this runs on real changes, not on every render.
  const content = useMemo(
    () => contentOf(state),
    [state.name, state.brief, state.settings, state.filters, state.marks, state.vibes, state.activeVibe, state.pinned],
  );
  const latest = useRef({ state, content, apply, notify });
  latest.current = { state, content, apply, notify };
  // Plain mutable bookkeeping; the functions below touch only this, so any render's copy of them works.
  const sync = useRef({
    projectId,
    /**
     * The server has answered for the open project and the two copies have met. Until then nothing
     * is saved: a change could replace a newer copy on disk, or the only one.
     */
    compared: false,
    /** A request for the server copy is on its way; its answer is compared with the latest state. */
    loading: false,
    /** What this browser held when the project opened, plus whether it was changed before the server answered. */
    opened: { at: 0, blank: false, content: "", edited: false },
    /** The state last saved or loaded; anything else is a change. */
    baseline: "",
    /** The newest unsaved snapshot per project (a switch can leave the previous one waiting). */
    pending: new Map<string, Job>(),
    inFlight: false,
    saveTimer: 0,
    saveRetryMs: RETRY_MS,
    checkTimer: 0,
    checkRetryMs: RETRY_MS,
    request: null as AbortController | null,
  }).current;

  // One save at a time, always each project's newest snapshot; a change made meanwhile follows it.
  const send = async (keepalive = false) => {
    clearTimeout(sync.saveTimer);
    const job = sync.pending.values().next().value;
    if (!job || sync.inFlight) return;
    sync.pending.delete(job.id);
    sync.inFlight = true;
    setSaveStatus("saving");
    const result = await putProject(job.id, job.body, keepalive);
    sync.inFlight = false;
    if (result === "retry") {
      // The server is down: keep the snapshot (unless a newer one is already waiting) and try again
      // on its own, so the work reaches the disk even if nothing else changes.
      if (!sync.pending.has(job.id)) sync.pending.set(job.id, job);
      setSaveStatus("offline");
      sync.saveTimer = window.setTimeout(() => void send(), sync.saveRetryMs);
      sync.saveRetryMs = Math.min(sync.saveRetryMs * 2, MAX_RETRY_MS);
      return;
    }
    sync.saveRetryMs = RETRY_MS;
    if (result === "saved") setSaveStatus("saved");
    else {
      setSaveStatus("offline");
      latest.current.notify?.(`The server refused to save this project (${result}). It is kept in this browser only.`, { ms: 12000 });
    }
    if (sync.pending.size) void send();
  };
  const schedule = (job: Job, delay: number) => {
    sync.pending.set(job.id, job);
    clearTimeout(sync.saveTimer);
    sync.saveTimer = window.setTimeout(() => void send(), delay);
  };

  // The two copies meet. The newer one wins, judged by what this browser held when the project
  // opened, not by edits made while waiting for the server's answer.
  const meet = (id: string, server: ProjectSnapshot | null) => {
    const local = latest.current;
    const { at: localAt, blank } = sync.opened;
    const edited = sync.opened.edited || local.content !== sync.opened.content;
    const serverContent = server ? contentOf(server) : null;
    sync.compared = true;
    clearUnchecked(id);
    if (server && serverContent === local.content) {
      sync.baseline = local.content;
      setSaveStatus("saved");
    } else if (server && server.updatedAt > localAt && (localAt > 0 || blank)) {
      // Newer on disk: another browser, or this one before its storage was cleared. Edits made here
      // before the answer came were made on an older copy (or on nothing), so they give way.
      local.apply(server);
      // apply() only queues the new state; React writes it to storage after its next render, which a
      // project switch (or closing the page) can get in before. The stamp says 'this browser has
      // the disk copy', so the fields go to storage first, and the stamp only once they are there:
      // a blank copy carrying the disk copy's stamp would later be sent back over the real one.
      if (writeFields(id, server)) writeUpdatedAt(id, server.updatedAt);
      sync.baseline = contentOf(server);
      setSaveStatus("saved");
      if (edited) local.notify?.("Loaded the newer copy of this project from disk. Changes made here before it loaded were replaced.", { ms: 12000 });
    } else if (!server && !localAt && local.content === blankContent(id)) {
      // Nothing here and nothing on disk: no file until something actually happens.
      sync.baseline = local.content;
      setSaveStatus("saved");
    } else {
      // Newer here, or not on disk yet (including changes made while the server was down).
      const at = edited ? Date.now() : localAt || Date.now();
      writeUpdatedAt(id, at);
      sync.baseline = local.content;
      schedule({ id, body: { ...local.state, updatedAt: at } }, 0);
    }
  };

  // Asks the server for its copy. With no answer, it asks again later, waiting longer each time.
  const check = () => {
    clearTimeout(sync.checkTimer);
    sync.request?.abort();
    const request = (sync.request = new AbortController());
    const id = sync.projectId;
    sync.loading = true;
    fetchProject(id, request.signal).then(
      (server) => {
        if (request.signal.aborted) return;
        sync.loading = false;
        sync.checkRetryMs = RETRY_MS;
        setUnchecked(false);
        meet(id, server);
      },
      () => {
        if (request.signal.aborted) return;
        sync.loading = false;
        setUnchecked(true);
        sync.checkTimer = window.setTimeout(check, sync.checkRetryMs);
        sync.checkRetryMs = Math.min(sync.checkRetryMs * 2, MAX_RETRY_MS);
      },
    );
  };

  // Opening a project: the previous project's unsaved change goes out first, then the two copies meet.
  useEffect(() => {
    void send();
    sync.projectId = projectId;
    sync.compared = false;
    sync.baseline = "";
    sync.checkRetryMs = RETRY_MS;
    setUnchecked(false);
    // Judged on what storage held when the project opened, or, after a reload, on what it held
    // before edits the server has not seen yet.
    const now = latest.current.content;
    const note = readUnchecked(projectId);
    sync.opened = note
      ? { ...note, content: now, edited: true }
      : { at: readUpdatedAt(projectId), blank: now === blankContent(projectId), content: now, edited: false };
    check();
    return () => {
      sync.request?.abort();
      clearTimeout(sync.checkTimer);
    };
  }, [projectId]);

  // Every real change: stamp it and save it a second after the last edit.
  useEffect(() => {
    if (content === sync.baseline) return;
    if (!sync.compared) {
      // Not compared with the copy on disk yet, so it stays in this browser. The note keeps that
      // true across a reload, and the server is asked again shortly (the answer on its way, if any).
      if (content !== sync.opened.content) writeUnchecked(projectId, sync.opened);
      if (!sync.loading) {
        clearTimeout(sync.checkTimer);
        sync.checkTimer = window.setTimeout(check, SAVE_DELAY_MS);
      }
      return;
    }
    sync.baseline = content;
    const at = Date.now();
    writeUpdatedAt(projectId, at);
    schedule({ id: projectId, body: { ...latest.current.state, updatedAt: at } }, SAVE_DELAY_MS);
  }, [content, projectId]);

  // Hiding or closing the tab sends a waiting save at once.
  useEffect(() => {
    const flush = () => void (sync.pending.size && send(true));
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return unchecked ? "unchecked" : saveStatus;
}

/**
 * Removes every key of a project from this browser. Online that is the only copy, so the project is
 * gone. Call it only once the page has switched away from the project: until then store.ts may
 * still write its last change back under those keys.
 */
export function forgetProject(id: string): void {
  try {
    const prefix = `fx:p:${id}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // storage blocked: nothing of it was saved either
  }
}

/** Projects in this browser, from the keys store.ts writes. */
function localProjects(): ProjectListing[] {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const id = /^fx:p:([^:]+):/.exec(localStorage.key(i) ?? "")?.[1];
      if (id && PROJECT_ID.test(id)) ids.add(id);
    }
  } catch {
    // storage blocked: only the server's list
  }
  return [...ids].map((id) => {
    let name = defaultProjectName(id);
    try {
      const meta = JSON.parse(localStorage.getItem(`fx:p:${id}:meta`) ?? "null") as Partial<ProjectMeta> | null;
      if (typeof meta?.name === "string" && meta.name.trim()) name = meta.name;
    } catch {
      // keep the default name
    }
    return { id, name, updatedAt: readUpdatedAt(id) };
  });
}

/**
 * Every project this browser or the server knows, most recently changed first. `serverOk` is false
 * when the server did not answer, so the list may be missing projects saved only on disk. Online
 * there is no disk: this browser's list is the whole list, so it is always complete.
 */
export async function listProjects(): Promise<{ projects: ProjectListing[]; serverOk: boolean }> {
  const byId = new Map(localProjects().map((p) => [p.id, p]));
  if (STATIC) return { projects: newestFirst(byId.values()), serverOk: true };
  let serverOk = true;
  try {
    const res = await fetch("/api/projects", { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(String(res.status));
    for (const p of (await res.json()) as ProjectListing[]) {
      const here = byId.get(p.id);
      // The newer copy names it; opening the project brings the rest of that copy across.
      if (!here || p.updatedAt > here.updatedAt) byId.set(p.id, p);
    }
  } catch {
    serverOk = false;
  }
  return { projects: newestFirst(byId.values()), serverOk };
}

function newestFirst(projects: Iterable<ProjectListing>): ProjectListing[] {
  return [...projects].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/**
 * An id for a new project, from its name: 'Acme Studio' -> 'acme-studio', or 'acme-studio-2' when
 * taken. Without the server's list, a random tail keeps it from landing on a project saved only on disk.
 */
export function newProjectId(name: string, taken: Iterable<string>, serverOk: boolean): string {
  const used = new Set(taken);
  const slug =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // accents off: "Café" -> "cafe"
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "project";
  const base = serverOk ? slug : `${slug}-${Math.random().toString(36).slice(2, 7)}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
