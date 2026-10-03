// The active project's state, behind one React context. App and the slot components read it with
// useStore(); Card never does, so its memoisation holds.
//
// Persisted per project under `fx:p:<projectId>:<field>`; the active project id lives in `fx:project`.
// Verdicts and candidates ("marks") change only through actions that record an undo snapshot.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cachedLocalFonts, loadRemoteCatalog, queryLocalFonts } from "./catalog";
import { isLogoSafe } from "./coverage";
import { usePersisted } from "./hooks";
import { hasItalic } from "./italic";
import { setHotkeyScope } from "./keymap";
import { deepMerge, isPlainObject } from "./merge";
import { defaultProjectName, useProjectSync, writeUpdatedAt, type ProjectMeta, type ProjectSnapshot, type SyncStatus } from "./projectSync";
import { drawnRecipe, recipeFromSettings, recipeLabel, sameRecipe, type Candidate, type Recipe } from "./recipe";
import { useScrollMemory } from "./scrollMemory";
import { DEFAULT_FILTERS, DEFAULT_SETTINGS, sortFonts, type Filters, type Settings } from "./settings";
import { SOURCES, type FontEntry, type Source, type VibeTurn } from "./types";

export type Verdict = "cull" | "maybe";
export interface Marks {
  /** Insertion order is kept, newest last (vibe search sends the most recent culls). */
  verdicts: Record<string, Verdict>;
  candidates: Candidate[];
  /**
   * A culled font's candidates (tuned recipes, notes), set aside by the cull and put back when the
   * font is restored, by font id. Absent when there are none. Nothing else reads them: a culled
   * font has no candidates anywhere in the app.
   */
  parked?: Record<string, Candidate[]>;
}
export interface Pinned {
  fontId: string;
  recipe: Recipe;
}
export type View = "grid" | "compare";
/** One grid entry: a font, plus its number and Claude's reason when a vibe result is showing. */
export interface Item {
  font: FontEntry;
  number?: number;
  reason?: string;
}
export interface CandidateRow {
  candidate: Candidate;
  font: FontEntry;
}
export interface UndoEntry {
  label: string;
  before: Marks;
  after: Marks;
}
export interface ToastOptions {
  /** true: an Undo button that reverts the last marks change. A function: a custom undo. */
  undo?: boolean | (() => void);
  ms?: number;
  /** One more button, e.g. 'Download SVG' after copying outlines. */
  action?: { label: string; run: () => void };
}
export interface ToastState {
  text: string;
  undo?: () => void;
  action?: { label: string; run: () => void };
  ms: number;
  key: number;
}
export interface CatalogStatus {
  loading: boolean;
  error?: string;
}
export type CandidatePatch = { note?: string; recipe?: Partial<Recipe> };
type Setter<T> = (next: T | ((prev: T) => T)) => void;

export interface ProjectStore {
  projectId: string;
  /** Swaps every persisted field to another project in place and clears the undo history. */
  switchProject: (id: string) => void;
  // Projects on disk: each one is mirrored to server/projects/<id>.json (projectSync.ts).
  projectName: string;
  brief: string;
  setBrief: (brief: string) => void;
  renameProject: (name: string) => void;
  /** A fresh project with default settings and `text` as the name to set, switched to at once. */
  createProject: (id: string, name: string, text: string) => void;
  /** A copy of the whole current project under a new id, switched to at once. */
  duplicateProject: (id: string, name: string) => void;
  /** How the last save to the server went. */
  syncStatus: SyncStatus;

  settings: Settings;
  setSettings: Setter<Settings>;
  filters: Filters;
  setFilters: Setter<Filters>;
  marks: Marks;
  vibes: VibeTurn[];
  setVibes: Setter<VibeTurn[]>;
  activeVibe: string | null;
  setActiveVibe: Setter<string | null>;
  view: View;
  setView: Setter<View>;
  pinned: Pinned | null;

  // Session only, never persisted.
  lightboxOpen: boolean;
  setLightboxOpen: (open: boolean) => void;
  /** The card that X, M and S act on: the one under the mouse, or the one the keys moved to. */
  focusId: string | null;
  setFocus: (id: string | null) => void;
  find: string;
  setFind: (text: string) => void;
  /** How many items the grid renders; it grows by PAGE as the end scrolls into view. */
  limit: number;
  setLimit: Setter<number>;

  // Catalog
  all: FontEntry[];
  byId: Map<string, FontEntry>;
  remote: FontEntry[];
  local: FontEntry[];
  catalogStatus: CatalogStatus;
  refreshCatalog: (force: boolean) => void;
  /** Must be called from a click: Chrome asks for permission the first time. */
  loadLocalFonts: () => void;

  // Derived
  /** The grid's current filtered, ordered list (also the lightbox's flip order). */
  items: Item[];
  passes: (f: FontEntry) => boolean;
  activeTurn: VibeTurn | null;
  /** Candidates whose font is in the catalog, in the order they were saved. */
  candidateRows: CandidateRow[];
  candidateFontIds: Set<string>;
  culledIds: string[];
  /** Claude's latest reason per font id, across all vibe turns. */
  reasons: Map<string, string>;

  // Actions (undoable, each with a toast)
  /** Culls, or restores a culled font. Culling sets that font's candidates aside; restoring brings them back. */
  cull: (fontId: string) => void;
  restore: (fontId: string) => void;
  /** Toggles maybe. */
  maybe: (fontId: string) => void;
  /**
   * Adds a candidate, or removes the one with the same recipe. The weight is stored as drawn (the
   * nearest one the family ships). Saving a culled font restores it.
   */
  toggleCandidate: (fontId: string, recipe: Recipe) => void;
  /** toggleCandidate with the grid's current settings as the recipe. */
  shortlist: (fontId: string) => void;
  removeCandidate: (candidateId: string) => void;
  updateCandidate: (candidateId: string, patch: CandidatePatch, opts?: { label?: string; quiet?: boolean }) => void;
  /** Any other marks change, recorded as one undo step. Returns false when nothing changed. */
  changeMarks: (label: string, change: (m: Marks) => Marks, opts?: { quiet?: boolean }) => boolean;
  undo: () => void;

  pin: (fontId: string, recipe: Recipe) => void;
  unpin: () => void;

  toast: (text: string, opts?: ToastOptions) => void;
  toastState: ToastState | null;
  dismissToast: () => void;
}

export const PAGE = 120;
const UNDO_LIMIT = 200;
const EMPTY_MARKS: Marks = { verdicts: {}, candidates: [] };

const PROJECT_KEY = "fx:project";
const PROJECT_ID = /^[a-z0-9-]{1,40}$/;
type ProjectField = "settings" | "filters" | "marks" | "vibes" | "activeVibe" | "view" | "pinned" | "meta";
export const projectKey = (projectId: string, field: ProjectField) => `fx:p:${projectId}:${field}`;

function readProjectId(): string {
  try {
    const id = localStorage.getItem(PROJECT_KEY);
    return id && PROJECT_ID.test(id) ? id : "default";
  } catch {
    return "default";
  }
}

// ---------------------------------------------------------------------------------------------
// One-time migration from the single-project v1 keys. They hold the user's only copy of his
// shortlist and culls, so they are copied, never moved: nothing here deletes or overwrites a key.

const MIGRATED_KEY = "fx:migrated:v2";
const LEGACY = {
  settings: "fx:settings",
  filters: "fx:filters:v2",
  filtersV1: "fx:filters",
  marks: "fx:marks",
  vibes: "fx:vibes",
  activeVibe: "fx:active-vibe",
  view: "fx:view",
} as const;

interface LegacyState {
  settings?: Settings;
  filters?: Filters;
  marks?: Marks;
  vibes?: VibeTurn[];
  activeVibe?: string | null;
  view?: View;
}
/** Set only when the copy could not be written (storage full): the old state is then shown from memory. */
let legacyFallback: LegacyState = {};

function readLegacy(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The v1 state in the project shape. Only fields that were actually saved are present. */
function legacyState(): LegacyState {
  const out: LegacyState = {};
  const oldSettings = readLegacy(LEGACY.settings);
  // Shortlisted fonts become candidates set the way the grid was set at the time of migration.
  const settings = deepMerge(DEFAULT_SETTINGS, isPlainObject(oldSettings) ? oldSettings : {});
  if (isPlainObject(oldSettings)) out.settings = settings;

  const oldFilters = readLegacy(LEGACY.filters) ?? upgradeV1Filters(readLegacy(LEGACY.filtersV1));
  if (isPlainObject(oldFilters)) {
    const { shortlistOnly, ...rest } = oldFilters as Partial<Filters> & { shortlistOnly?: unknown };
    out.filters = deepMerge(DEFAULT_FILTERS, { ...rest, candidatesOnly: Boolean(shortlistOnly) });
  }

  const oldMarks = readLegacy(LEGACY.marks);
  if (isPlainObject(oldMarks)) {
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const recipe = recipeFromSettings(settings);
    const now = Date.now();
    out.marks = {
      verdicts: Object.fromEntries(ids(oldMarks.culled).map((id) => [id, "cull" as const])),
      candidates: [...new Set(ids(oldMarks.shortlist))].map((fontId, i) => ({
        id: crypto.randomUUID(),
        fontId,
        recipe,
        note: "",
        addedAt: now + i,
      })),
    };
  }

  const vibes = readLegacy(LEGACY.vibes);
  if (Array.isArray(vibes)) out.vibes = vibes as VibeTurn[];
  const activeVibe = readLegacy(LEGACY.activeVibe);
  if (typeof activeVibe === "string" || activeVibe === null) out.activeVibe = activeVibe;
  const view = readLegacy(LEGACY.view);
  if (view === "grid" || view === "compare") out.view = view;
  return out;
}

/** v1 filters lacked the newer sources; carry the choices over with those sources switched on. */
function upgradeV1Filters(old: unknown): Filters | undefined {
  if (!isPlainObject(old)) return undefined;
  const known: Source[] = ["local", "fontsource", "fontshare"];
  const added = SOURCES.filter((s) => !known.includes(s));
  const sources = Array.isArray(old.sources) ? (old.sources as Source[]) : DEFAULT_FILTERS.sources;
  return { ...DEFAULT_FILTERS, ...(old as Partial<Filters>), sources: [...new Set([...sources, ...added])] };
}

/** Copies the v1 keys into project 'default', once. Exported for the dev console and checks. */
export function migrateLegacyStorage(): void {
  try {
    if (localStorage.getItem(MIGRATED_KEY) !== null) return;
  } catch {
    return; // storage blocked: there is nothing to migrate
  }
  const state = legacyState();
  let ok = true;
  for (const [field, value] of Object.entries(state)) {
    const key = projectKey("default", field as ProjectField);
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      ok = false;
      console.warn(`could not copy the saved ${field} into project 'default'`, err);
    }
  }
  if (!ok) {
    legacyFallback = state; // the old keys are untouched, so the copy is tried again on the next load
    return;
  }
  try {
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    // the copy is done; it will simply be checked again next time (it never overwrites)
  }
}

// ---------------------------------------------------------------------------------------------

function withVerdict(m: Marks, id: string, v: Verdict | null): Marks {
  const { [id]: _previous, ...rest } = m.verdicts;
  return { ...m, verdicts: v ? { ...rest, [id]: v } : rest };
}

/** Culls a font, setting its candidates aside (parked) for a restore to bring back. */
function culled(m: Marks, id: string): Marks {
  const mine = m.candidates.filter((c) => c.fontId === id);
  const next = withVerdict(m, id, "cull");
  if (!mine.length) return next;
  const parked = { ...m.parked, [id]: [...(m.parked?.[id] ?? []), ...mine] };
  return { ...next, candidates: m.candidates.filter((c) => c.fontId !== id), parked };
}

/** Restores a culled font with the candidates its cull set aside. */
function restored(m: Marks, id: string): Marks {
  const next = withVerdict(m, id, null);
  const back = m.parked?.[id];
  if (!back) return next;
  const { [id]: _back, ...parked } = m.parked ?? {};
  const known = new Set(m.candidates.map((c) => c.id));
  const { parked: _all, ...rest } = next;
  return { ...rest, candidates: [...m.candidates, ...back.filter((c) => !known.has(c.id))], ...(Object.keys(parked).length ? { parked } : {}) };
}

function remapMarks(m: Marks, resolve: (id: string) => string): Marks {
  let changed = false;
  const verdicts: Record<string, Verdict> = {};
  for (const [id, v] of Object.entries(m.verdicts)) {
    let to = resolve(id);
    // Never onto a font that already has its own verdict: one of the two would silently replace
    // the other. The old id is kept as it is instead.
    if (to !== id && (to in m.verdicts || to in verdicts)) to = id;
    if (to !== id) changed = true;
    verdicts[to] = v;
  }
  const moved = (c: Candidate) => {
    const fontId = resolve(c.fontId);
    if (fontId === c.fontId) return c;
    changed = true;
    return { ...c, fontId };
  };
  const candidates = m.candidates.map(moved);
  // Parked candidates follow their font's verdict: under the id the verdict ended up with.
  let parked = m.parked;
  if (m.parked) {
    parked = {};
    for (const [id, list] of Object.entries(m.parked)) {
      const to = id in verdicts ? id : resolve(id);
      parked[to] = [...(parked[to] ?? []), ...list.map((c) => (to === id ? c : { ...c, fontId: to }))];
      if (to !== id) changed = true;
    }
  }
  return changed ? { verdicts, candidates, ...(parked ? { parked } : {}) } : m;
}

/** Same normalisation the server uses to spot one family on several sources. */
function familyKey(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const StoreContext = createContext<ProjectStore | null>(null);

export function useStore(): ProjectStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore needs <ProjectStoreProvider> above it");
  return store;
}

export function ProjectStoreProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectId] = useState(() => {
    migrateLegacyStorage(); // before any field below reads storage
    return readProjectId();
  });
  const fallback = projectId === "default" ? legacyFallback : {};
  const key = (field: ProjectField) => projectKey(projectId, field);
  const [settings, setSettings] = usePersisted<Settings>(key("settings"), fallback.settings ?? DEFAULT_SETTINGS);
  const [filters, setFilters] = usePersisted<Filters>(key("filters"), fallback.filters ?? DEFAULT_FILTERS);
  const [marks, setMarks] = usePersisted<Marks>(key("marks"), fallback.marks ?? EMPTY_MARKS);
  const [vibes, setVibes] = usePersisted<VibeTurn[]>(key("vibes"), fallback.vibes ?? []);
  const [activeVibe, setActiveVibe] = usePersisted<string | null>(key("activeVibe"), fallback.activeVibe ?? null);
  const [view, setView] = usePersisted<View>(key("view"), fallback.view ?? "grid");
  const [pinned, setPinned] = usePersisted<Pinned | null>(key("pinned"), null);
  const [meta, setMeta] = usePersisted<ProjectMeta>(key("meta"), { name: defaultProjectName(projectId), brief: "" });

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [focusId, setFocus] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [toastState, setToastState] = useState<ToastState | null>(null);

  // Catalog
  const [remote, setRemote] = useState<FontEntry[]>([]);
  const [local, setLocal] = useState<FontEntry[]>(cachedLocalFonts);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>({ loading: true });
  const refreshCatalog = useCallback((force: boolean) => {
    setCatalogStatus({ loading: true });
    loadRemoteCatalog(force, setRemote)
      .then(() => setCatalogStatus({ loading: false }))
      .catch((err: Error) => setCatalogStatus({ loading: false, error: err.message }));
  }, []);
  useEffect(() => refreshCatalog(false), [refreshCatalog]);

  const all = useMemo(() => sortFonts([...remote, ...local], filters.sort, filters.seed), [remote, local, filters.sort, filters.seed]);
  const byId = useMemo(() => new Map(all.map((f) => [f.id, f])), [all]);

  // The catalog merge can change which row (and id) survives for a family, e.g. a Google family that
  // used to be a Fontshare row. Saved marks and vibe results keep pointing at the old id, so remap
  // any id that is no longer in the catalog to the surviving row with the same family.
  useEffect(() => {
    if (!remote.length) return;
    const ids = new Set(all.map((f) => f.id));
    const byFamily = new Map(all.map((f) => [familyKey(f.family), f.id]));
    const resolve = (id: string) => {
      // An installed font is missing from the catalog whenever this browser has no local font list
      // (a fresh browser, Safari, a project opened from disk). It never became another row, and
      // remapping it would move its verdicts and candidates onto the Google font of the same name.
      if (ids.has(id) || id.startsWith("local:")) return id;
      const family = id.split(":").slice(1).join(":").replace(/-/g, " ");
      return byFamily.get(familyKey(family)) ?? id;
    };
    setMarks((m) => remapMarks(m, resolve));
    setPinned((p) => (p && resolve(p.fontId) !== p.fontId ? { ...p, fontId: resolve(p.fontId) } : p));
    setVibes((vs) => {
      let changed = false;
      const next = vs.map((v) => ({
        ...v,
        results: v.results.map((r) => {
          const fontId = resolve(r.fontId);
          if (fontId !== r.fontId) changed = true;
          return { ...r, fontId };
        }),
      }));
      return changed ? next : vs;
    });
  }, [remote, all, setMarks, setPinned, setVibes]);

  // Actions read the latest state through this ref, so they stay stable for memoised cards.
  // `marks` is also updated by each action straight away, so two keys pressed before the next
  // render both see the first one's result.
  const live = useRef({ marks, byId, settings, remote });
  live.current = { marks, byId, settings, remote };
  const fontName = (id: string) => live.current.byId.get(id)?.family ?? id.split(":").slice(1).join(":");
  const restoredLabel = (m: Marks, id: string) => {
    const back = m.parked?.[id]?.length ?? 0;
    return back ? `Restored ${fontName(id)} and its ${plural(back, "candidate")}` : `Restored ${fontName(id)}`;
  };
  const candidateName = (c: Pick<Candidate, "fontId" | "recipe">) => {
    const font = live.current.byId.get(c.fontId);
    return font ? recipeLabel(font, c.recipe) : fontName(c.fontId);
  };

  const undoRef = useRef<() => void>(() => {});
  const toast = useCallback((text: string, opts: ToastOptions = {}) => {
    const undo = opts.undo === true ? () => undoRef.current() : typeof opts.undo === "function" ? opts.undo : undefined;
    setToastState({ text, undo, action: opts.action, ms: opts.ms ?? 5000, key: Date.now() + Math.random() });
  }, []);
  const dismissToast = useCallback(() => setToastState(null), []);
  useEffect(() => {
    if (!toastState) return;
    const t = setTimeout(() => setToastState(null), toastState.ms);
    return () => clearTimeout(t);
  }, [toastState]);

  const undoStack = useRef<UndoEntry[]>([]);
  const changeMarks = useCallback(
    (label: string, change: (m: Marks) => Marks, opts: { quiet?: boolean } = {}) => {
      const before = live.current.marks;
      const after = change(before);
      if (after === before) return false;
      live.current.marks = after;
      undoStack.current.push({ label, before, after });
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
      setMarks(after);
      if (!opts.quiet) toast(label, { undo: true });
      return true;
    },
    [setMarks, toast],
  );
  const undo = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) {
      toast("Nothing to undo");
      return;
    }
    live.current.marks = entry.before;
    setMarks(entry.before);
    toast(`Undid: ${entry.label}`);
  }, [setMarks, toast]);
  undoRef.current = undo;

  // fontName and candidateName read the ref, so these actions depend on changeMarks alone.
  const cull = useCallback(
    (id: string) => {
      const m = live.current.marks;
      if (m.verdicts[id] === "cull") {
        changeMarks(restoredLabel(m, id), (x) => restored(x, id));
        return;
      }
      const dropped = m.candidates.filter((c) => c.fontId === id).length;
      changeMarks(
        dropped ? `Culled ${fontName(id)}. Its ${plural(dropped, "candidate")} come${dropped === 1 ? "s" : ""} back if you restore it` : `Culled ${fontName(id)}`,
        (x) => culled(x, id),
      );
    },
    [changeMarks],
  );
  const restore = useCallback(
    (id: string) => {
      const m = live.current.marks;
      if (m.verdicts[id] !== "cull") return;
      changeMarks(restoredLabel(m, id), (x) => restored(x, id));
    },
    [changeMarks],
  );
  const maybe = useCallback(
    (id: string) => {
      const was = live.current.marks.verdicts[id] === "maybe";
      changeMarks(was ? `No longer maybe: ${fontName(id)}` : `Maybe: ${fontName(id)}`, (x) => withVerdict(x, id, was ? null : "maybe"));
    },
    [changeMarks],
  );
  const toggleCandidate = useCallback(
    (fontId: string, wanted: Recipe) => {
      // Saved and compared at the weight the font actually draws, so S at 700 on a family that
      // only ships 400 finds the 400 candidate instead of saving a twin that looks the same.
      const font = live.current.byId.get(fontId);
      const drawn = (r: Recipe) => (font ? drawnRecipe(font, r) : r);
      const recipe = drawn(wanted);
      const m = live.current.marks;
      if (m.verdicts[fontId] === "cull") {
        // Saving a culled font restores it, with the candidates its cull set aside. One of those
        // may already be this exact setting: then the restore alone is the save.
        const back = m.parked?.[fontId] ?? [];
        const same = back.find((c) => sameRecipe(drawn(c.recipe), recipe));
        const added: Candidate = { id: crypto.randomUUID(), fontId, recipe, note: "", addedAt: Date.now() };
        changeMarks(same ? restoredLabel(m, fontId) : `Saved ${candidateName(added)}`, (x) => {
          const r = restored(x, fontId);
          return same ? r : { ...r, candidates: [...r.candidates, added] };
        });
        return;
      }
      const existing = m.candidates.find((c) => c.fontId === fontId && sameRecipe(drawn(c.recipe), recipe));
      if (existing) {
        changeMarks(`Removed candidate ${candidateName(existing)}`, (x) => ({
          ...x,
          candidates: x.candidates.filter((c) => c.id !== existing.id),
        }));
        return;
      }
      const added: Candidate = { id: crypto.randomUUID(), fontId, recipe, note: "", addedAt: Date.now() };
      changeMarks(`Saved ${candidateName(added)}`, (x) => ({ ...x, candidates: [...x.candidates, added] }));
    },
    [changeMarks],
  );
  const shortlist = useCallback((fontId: string) => toggleCandidate(fontId, recipeFromSettings(live.current.settings)), [toggleCandidate]);
  const removeCandidate = useCallback(
    (cid: string) => {
      const c = live.current.marks.candidates.find((x) => x.id === cid);
      if (!c) return;
      changeMarks(`Removed candidate ${candidateName(c)}`, (x) => ({ ...x, candidates: x.candidates.filter((y) => y.id !== cid) }));
    },
    [changeMarks],
  );
  const updateCandidate = useCallback(
    (cid: string, patch: CandidatePatch, opts: { label?: string; quiet?: boolean } = {}) => {
      const c = live.current.marks.candidates.find((x) => x.id === cid);
      if (!c) return;
      const next: Candidate = { ...c, note: patch.note ?? c.note, recipe: patch.recipe ? { ...c.recipe, ...patch.recipe } : c.recipe };
      if (next.note === c.note && sameRecipe(next.recipe, c.recipe)) return;
      // Tuned into the exact setting of another candidate of the same font, the two would be twins
      // that S on the grid removes one at a time. The change is refused instead; nothing is lost.
      if (patch.recipe) {
        const font = live.current.byId.get(c.fontId);
        const drawn = (r: Recipe) => (font ? drawnRecipe(font, r) : r);
        const twin = live.current.marks.candidates.find((y) => y.id !== cid && y.fontId === c.fontId && sameRecipe(drawn(y.recipe), drawn(next.recipe)));
        if (twin) {
          toast(`${candidateName(twin)} is already a candidate`);
          return;
        }
      }
      changeMarks(
        opts.label ?? `Changed ${candidateName(next)}`,
        (x) => ({ ...x, candidates: x.candidates.map((y) => (y.id === cid ? next : y)) }),
        { quiet: opts.quiet },
      );
    },
    [changeMarks, toast],
  );

  const pin = useCallback((fontId: string, recipe: Recipe) => setPinned({ fontId, recipe }), [setPinned]);
  const unpin = useCallback(() => setPinned(null), [setPinned]);

  const switchProject = useCallback((id: string) => {
    if (!PROJECT_ID.test(id)) throw new Error(`Project ids are 1-40 of a-z, 0-9 and '-': ${id}`);
    try {
      localStorage.setItem(PROJECT_KEY, id);
    } catch {
      // storage blocked: the switch still holds for this session
    }
    undoStack.current = [];
    setFocus(null);
    setLightboxOpen(false);
    setFind("");
    setProjectId(id);
  }, []);

  // Projects on disk (projectSync.ts). A newer server copy replaces the live state wholesale; undo
  // steps from before it would revert to state that no longer exists, so they go.
  const applySnapshot = useCallback(
    (p: ProjectSnapshot) => {
      undoStack.current = [];
      live.current.marks = p.marks;
      setMeta({ name: p.name, brief: p.brief });
      setSettings(p.settings);
      setFilters(p.filters);
      setMarks(p.marks);
      setVibes(p.vibes);
      setActiveVibe(p.activeVibe);
      setPinned(p.pinned);
    },
    [setMeta, setSettings, setFilters, setMarks, setVibes, setActiveVibe, setPinned],
  );
  const syncStatus = useProjectSync(
    projectId,
    { name: meta.name, brief: meta.brief, settings, filters, marks, vibes, activeVibe, pinned },
    applySnapshot,
    toast,
  );
  const setBrief = useCallback((brief: string) => setMeta((m) => ({ ...m, brief })), [setMeta]);
  const renameProject = useCallback((name: string) => setMeta((m) => ({ ...m, name: name.trim() || m.name })), [setMeta]);
  /** Writes a new project's fields straight to storage, then switches: the switch reads them from there. */
  const seedProject = (id: string, fields: Partial<Record<ProjectField, unknown>>) => {
    if (!PROJECT_ID.test(id)) throw new Error(`Project ids are 1-40 of a-z, 0-9 and '-': ${id}`);
    try {
      for (const [field, value] of Object.entries(fields)) localStorage.setItem(projectKey(id, field as ProjectField), JSON.stringify(value));
    } catch {
      toast("Could not create the project: browser storage is full or blocked");
      return;
    }
    writeUpdatedAt(id, Date.now());
    switchProject(id);
  };
  const createProject = (id: string, name: string, text: string) =>
    seedProject(id, { meta: { name, brief: "" }, settings: { ...DEFAULT_SETTINGS, text: text || name } });
  const duplicateProject = (id: string, name: string) =>
    seedProject(id, { meta: { name, brief: meta.brief }, settings, filters, marks: live.current.marks, vibes, activeVibe, view, pinned });

  const loadLocalFonts = useCallback(() => {
    // queryLocalFonts calls the browser API before its first await, so the click still counts.
    queryLocalFonts(live.current.remote)
      .then((fonts) => {
        setLocal(fonts);
        toast(`Loaded ${fonts.length} local font families`);
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err)));
  }, [toast]);

  // Derived
  const candidateFontIds = useMemo(() => new Set(marks.candidates.map((c) => c.fontId)), [marks.candidates]);
  const culledIds = useMemo(() => Object.keys(marks.verdicts).filter((id) => marks.verdicts[id] === "cull"), [marks.verdicts]);
  const activeTurn = useMemo(() => vibes.find((v) => v.id === activeVibe) ?? null, [vibes, activeVibe]);

  // The filter row's rules. A feature adding a filter adds one clause here (and its field in Filters).
  // 'Has italic' counts only while Italic is on: its chip is hidden otherwise, and a hidden chip must not filter.
  const italicOnly = filters.hasItalic && settings.italic;
  const passes = useCallback(
    (f: FontEntry) => {
      const verdict = marks.verdicts[f.id];
      const hasCandidate = candidateFontIds.has(f.id);
      return (
        (filters.sources.includes(f.source) || Boolean(f.alsoOn?.some((x) => filters.sources.includes(x)))) &&
        filters.categories.includes(f.category) &&
        (!filters.candidatesOnly || hasCandidate) &&
        (!filters.maybeOrBetter || hasCandidate || verdict === "maybe") &&
        (filters.showCulled || verdict !== "cull") &&
        (!filters.logoSafe || isLogoSafe(f)) &&
        (!italicOnly || hasItalic(f))
      );
    },
    [filters, marks.verdicts, candidateFontIds, italicOnly],
  );

  const items = useMemo(() => {
    const base: Item[] = activeTurn
      ? activeTurn.results.flatMap((r, i) => {
          const font = byId.get(r.fontId);
          return font ? [{ font, number: i + 1, reason: r.reason }] : [];
        })
      : all.map((font) => ({ font }));
    const needle = find.trim().toLowerCase();
    return base.filter(({ font }) => passes(font) && (!needle || font.family.toLowerCase().includes(needle)));
  }, [activeTurn, all, byId, passes, find]);

  const candidateRows = useMemo(
    () =>
      marks.candidates.flatMap((candidate) => {
        const font = byId.get(candidate.fontId);
        return font ? [{ candidate, font }] : [];
      }),
    [marks.candidates, byId],
  );
  const reasons = useMemo(() => {
    const map = new Map<string, string>();
    vibes.forEach((v) => v.results.forEach((r) => map.set(r.fontId, r.reason)));
    return map;
  }, [vibes]);

  // The focus follows the list. When the list itself starts over (a filter chip, Sort, Reshuffle,
  // Find or a vibe chip), the grid jumps back to the top and draws only the first PAGE cards, so
  // the old focus may now be far out of sight: it clears, and X, M and S wait for a card to be
  // pointed at. When only the marks changed and the focused card left the list (culled while
  // culls are hidden), the card that slides into its place takes the focus. That is also the card
  // now under the mouse. scrollMemory.ts restarts the page on the same three inputs.
  const focusIndex = useRef(-1);
  const listInputs = useRef({ filters, find, activeVibe });
  useEffect(() => {
    const before = listInputs.current;
    listInputs.current = { filters, find, activeVibe };
    if (focusId === null) return;
    if (before.filters !== filters || before.find !== find || before.activeVibe !== activeVibe) {
      setFocus(null);
      return;
    }
    const i = items.findIndex((it) => it.font.id === focusId);
    if (i >= 0) {
      focusIndex.current = i;
      return;
    }
    setFocus(items[Math.min(focusIndex.current, items.length - 1)]?.font.id ?? null);
  }, [items, focusId, filters, find, activeVibe]);

  useLayoutEffect(() => setHotkeyScope(lightboxOpen ? "lightbox" : view === "compare" ? "compare" : "grid"), [lightboxOpen, view]);

  // A vibe chip and All fonts each come back to their own scroll position; filters and Find start over.
  useScrollMemory({ activeVibe, filters, find, limit, setLimit, page: PAGE, view });

  const store: ProjectStore = {
    projectId,
    switchProject,
    projectName: meta.name,
    brief: meta.brief,
    setBrief,
    renameProject,
    createProject,
    duplicateProject,
    syncStatus,
    settings,
    setSettings,
    filters,
    setFilters,
    marks,
    vibes,
    setVibes,
    activeVibe,
    setActiveVibe,
    view,
    setView,
    pinned,
    lightboxOpen,
    setLightboxOpen,
    focusId,
    setFocus,
    find,
    setFind,
    limit,
    setLimit,
    all,
    byId,
    remote,
    local,
    catalogStatus,
    refreshCatalog,
    loadLocalFonts,
    items,
    passes,
    activeTurn,
    candidateRows,
    candidateFontIds,
    culledIds,
    reasons,
    cull,
    restore,
    maybe,
    toggleCandidate,
    shortlist,
    removeCandidate,
    updateCandidate,
    changeMarks,
    undo,
    pin,
    unpin,
    toast,
    toastState,
    dismissToast,
  };
  // Dev only: lets the console and the browser check scripts drive the store.
  useEffect(() => {
    if (import.meta.env.DEV) window.__fxStore = store;
  });
  return createElement(StoreContext.Provider, { value: store }, children);
}

declare global {
  interface Window {
    __fxStore?: ProjectStore;
  }
}
