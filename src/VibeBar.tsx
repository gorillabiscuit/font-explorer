import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BriefToggle } from "./BriefField";
import { STATIC } from "./env";
import type { LayoutSettings } from "./recipe";
import { parseName, type Filters, type Settings, type TextCase } from "./settings";
import { useStore } from "./store";
import type { FontEntry, Source, VibeRequest, VibeResponse, VibeTurn, VibeWordmark } from "./types";
import "./vibebar.css";

interface Props {
  vibes: VibeTurn[];
  activeVibe: string | null;
  setActiveVibe: (id: string | null) => void;
  setVibes: (fn: (prev: VibeTurn[]) => VibeTurn[]) => void;
  all: FontEntry[];
  /** Font ids with at least one candidate: sent to Claude as taste. */
  shortlist: string[];
  /** Culled font ids, oldest first: the most recent are sent as negatives. */
  culled: string[];
  filters: Filters;
  passes: (f: FontEntry) => boolean;
  onError: (text: string) => void;
}

/** A search still waiting on Claude. Several run at once; each chip's ✕ aborts its own. */
interface Running {
  id: string;
  query: string;
  abort: AbortController;
}

/** Width of the fade on a strip edge with chips hidden past it (vibebar.css uses the same). */
const EDGE_FADE = 24;

// When Claude names a family that exists in several places, show the foundry's own release first.
const SOURCE_PREFERENCE: Source[] = ["velvetyne", "collletttivo", "tunera", "fontshare", "fontsource", "usemodify", "local"];

/**
 * Searches run in the background: the input never locks, each search shows as a chip with a
 * spinner, and a finished one becomes a normal chip with a dot. It never switches the grid to its
 * results; you open it when you are ready, so triage carries on undisturbed.
 *
 * Vibe search asks Claude through the local server, so the online build, which has none, leaves the
 * whole row out: the search, the Brief chip and the result chips.
 */
export function VibeBar(props: Props) {
  return STATIC ? null : <VibeSearch {...props} />;
}

function VibeSearch(props: Props) {
  const { vibes, activeVibe, setActiveVibe, setVibes, all, shortlist, culled, filters } = props;
  const { settings, brief, projectId, toast } = useStore();
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState<Running[]>([]);
  const strip = useRef<HTMLDivElement>(null);
  // A search's results are matched against the catalog and the culls as they are when it finishes.
  const latest = useRef({ props, projectId, running });
  latest.current = { props, projectId, running };

  const submit = () => {
    const q = query.trim();
    if (!q) return;
    const byId = new Map(all.map((f) => [f.id, f]));
    const family = (id: string) => byId.get(id)?.family;
    // The conversation is the chain of turns that led to the one on screen, so jumping back
    // to an older chip and asking a follow-up continues from there, without the abandoned branch.
    const byTurnId = new Map(vibes.map((v) => [v.id, v]));
    const history: VibeTurn[] = [];
    for (let t = activeVibe ? byTurnId.get(activeVibe) : undefined; t && history.length < 4; t = t.parentId ? byTurnId.get(t.parentId) : undefined) {
      history.unshift(t);
    }
    const body: VibeRequest = {
      query: q,
      history: history.map((t) => ({ query: t.query, results: t.results.map(({ family, reason }) => ({ family, reason })) })),
      shortlist: shortlist.flatMap((id) => family(id) ?? []),
      culled: culled.slice(-60).flatMap((id) => family(id) ?? []),
      localFonts: all.filter((f) => f.source === "local").map((f) => ({ family: f.family, category: f.category })),
      constraints: { sources: filters.sources, categories: filters.categories },
      wordmark: wordmarkOf(settings),
      brief: brief.trim() || undefined,
      italic: { on: settings.italic, only: filters.hasItalic },
    };
    const job: Running = { id: crypto.randomUUID(), query: q, abort: new AbortController() };
    setRunning((r) => [...r, job]);
    setQuery("");
    void search(job, body, history.at(-1)?.id ?? null).finally(() => setRunning((r) => r.filter((x) => x !== job)));
    // Scroll the new chip into view only if it landed out of sight (or under a fade), so the older
    // chips stay put when there is room. Only the chip strip scrolls; the page stays where it is.
    requestAnimationFrame(() => {
      const el = strip.current;
      const chip = el?.querySelector(`[data-job="${job.id}"]`);
      if (!el || !chip) return;
      const box = el.getBoundingClientRect();
      const c = chip.getBoundingClientRect();
      if (c.right > box.right - EDGE_FADE) el.scrollBy({ left: c.right - box.right + EDGE_FADE });
      else if (c.left < box.left + EDGE_FADE) el.scrollBy({ left: c.left - box.left - EDGE_FADE });
    });
  };

  const search = async (job: Running, body: VibeRequest, parentId: string | null) => {
    const startedIn = latest.current.projectId;
    try {
      const res = await fetch("/api/vibe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: job.abort.signal,
      });
      const text = await res.text();
      let data: (VibeResponse & { error?: string }) | null = null;
      try {
        data = JSON.parse(text);
      } catch {
        // an empty or non-JSON body means the request never reached the API server
      }
      if (!data) throw new Error(`Vibe search failed (${res.status}). Is the API server running? Check the npm run dev terminal.`);
      if (!res.ok || data.error) throw new Error(data.error ?? `Vibe search failed (${res.status})`);
      if (latest.current.projectId !== startedIn) return; // another project is open now; it was cancelled

      const { all, culled, passes, setVibes } = latest.current.props;
      const culledSet = new Set(culled);
      const results = data.results.flatMap((r) => {
        const candidates = all
          .filter((f) => f.family.toLowerCase() === r.family.toLowerCase() && !culledSet.has(f.id))
          .sort((a, b) => Number(passes(b)) - Number(passes(a)) || SOURCE_PREFERENCE.indexOf(a.source) - SOURCE_PREFERENCE.indexOf(b.source));
        return candidates[0] ? [{ ...r, fontId: candidates[0].id }] : [];
      });
      const turn: VibeTurn = { id: crypto.randomUUID(), parentId, query: job.query, results, at: Date.now(), unread: true };
      setVibes((prev) => [...prev, turn]);
    } catch (err) {
      if (job.abort.signal.aborted) return; // cancelled with its ✕, or by switching projects
      latest.current.props.onError(err instanceof Error ? err.message : String(err));
    }
  };

  // Searches belong to the project they were asked in: switching projects cancels the rest.
  const askedIn = useRef(projectId);
  useEffect(() => {
    if (askedIn.current === projectId) return;
    askedIn.current = projectId;
    const cancelled = latest.current.running;
    cancelled.forEach((job) => job.abort.abort());
    if (cancelled.length) toast(`Cancelled ${cancelled.length === 1 ? "a vibe search" : `${cancelled.length} vibe searches`} from the previous project`);
  }, [projectId, toast]);
  useEffect(() => () => latest.current.running.forEach((job) => job.abort.abort()), []);

  // A fade on each strip edge that has chips hidden past it, so they read as 'more this way'.
  const [fade, setFade] = useState({ start: false, end: false });
  const updateFade = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);
  // Re-judged when the chips or the Brief chip's width change, and on scroll and window resize. Not
  // a ResizeObserver: observing the strip made WebKit report 'ResizeObserver loop' errors whenever
  // the cards resized in the same frame (on a project switch, for one).
  useLayoutEffect(updateFade, [updateFade, vibes, running, brief]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    el.addEventListener("scroll", updateFade, { passive: true });
    window.addEventListener("resize", updateFade);
    return () => {
      el.removeEventListener("scroll", updateFade);
      window.removeEventListener("resize", updateFade);
    };
  }, [updateFade]);

  // The strip is one line that scrolls sideways; let an ordinary mouse wheel scroll it too.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const open = (id: string | null) => {
    setActiveVibe(id);
    if (id && vibes.some((v) => v.id === id && v.unread)) {
      setVibes((prev) =>
        prev.map((v) => {
          if (v.id !== id) return v;
          const { unread: _seen, ...rest } = v;
          return rest;
        }),
      );
    }
  };

  return (
    <div className="row vibe">
      <form
        className="vibe-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
          // Hand the keys back to the grid, so X, M and S carry on while Claude thinks.
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <input
          type="text"
          value={query}
          placeholder={activeVibe ? 'Follow up: "more like #3 but wider"' : 'Describe a vibe: "slick and professional", "a bit more sci-fi, but still legible"'}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={!query.trim()}>
          Vibe search
        </button>
      </form>
      <BriefToggle />
      {/* Outside the strip, so the way back to the full grid never scrolls out of sight. */}
      <button className={`chip all-fonts ${activeVibe === null ? "on" : ""}`} onClick={() => open(null)}>
        All fonts
      </button>
      <div className={`chips vibe-strip${fade.start ? " fade-start" : ""}${fade.end ? " fade-end" : ""}`} ref={strip}>
        {vibes.map((v) => (
          <button
            key={v.id}
            className={`chip vibe-chip ${activeVibe === v.id ? "on" : ""}`}
            title={`${v.results.length} fonts${v.unread ? " · new" : ""}`}
            onClick={() => open(v.id)}
          >
            {v.unread && <span className="unread-dot" aria-label="(new)" />}
            {v.query}
          </button>
        ))}
        {running.map((job) => (
          <span
            key={job.id}
            data-job={job.id}
            className="chip vibe-chip is-running"
            title="Claude is searching. Keep going; the results arrive as a chip."
          >
            <span className="spinner" aria-hidden="true" />
            <span className="q">{job.query}</span>
            <button type="button" className="chip-x" title="Cancel this search" aria-label={`Cancel "${job.query}"`} onClick={() => job.abort.abort()}>
              ✕
            </button>
          </span>
        ))}
        {vibes.length > 0 && (
          <button
            className="chip ghost"
            onClick={() => {
              setVibes(() => []);
              setActiveVibe(null);
            }}
          >
            Clear history
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The name as the grid draws it, for Claude: case applied, the lines as laid out, and the
 * descriptor for a lockup. A typed '/' wins over break chips, as in the layout engine.
 */
function wordmarkOf(s: Settings): VibeWordmark {
  const { lines, flat } = parseName(s);
  const { formation, breaks, lockup, mark } = s.layout;
  const typed = lines.length > 1 ? lines : null;
  let shown: string[];
  if (formation === "stack" || formation === "block") shown = typed ?? splitAt(flat, breaks) ?? [flat];
  else if (formation === "lockup") shown = typed ?? [flat];
  else if (formation === "mark") shown = [initialsOf(mark, typed, flat, s.textCase)];
  else shown = [flat];
  const descriptor = formation === "lockup" ? withCase(lockup.descriptor.trim(), lockup.textCase) : "";
  return { text: flat, rendered: shown.join("\n"), textCase: s.textCase, formation, ...(descriptor ? { descriptor } : {}) };
}

/** Break chips store character positions in the one-line name. */
function splitAt(flat: string, breaks: number[] | null): string[] | null {
  if (!breaks?.length) return null;
  const cuts = [...new Set(breaks)].filter((i) => i > 0 && i < flat.length).sort((a, b) => a - b);
  const pieces = [...cuts, flat.length].map((end, i) => flat.slice(i ? cuts[i - 1] : 0, end).trim()).filter(Boolean);
  return pieces.length > 1 ? pieces : null;
}

/** The plan's Mark rule: the typed initials, else each word's or line's first letter, else a single word's first two. */
function initialsOf(mark: LayoutSettings["mark"], typed: string[] | null, flat: string, textCase: TextCase): string {
  const words = typed ?? flat.split(/\s+/).filter(Boolean);
  const all = withCase(mark.initials.trim(), textCase) || (words.length > 1 ? words.map((w) => [...w][0]).join("") : [...flat].slice(0, 2).join(""));
  return [...all].slice(0, mark.construction === "single" ? 1 : 2).join("");
}

function withCase(text: string, textCase: TextCase): string {
  return textCase === "upper" ? text.toUpperCase() : textCase === "lower" ? text.toLowerCase() : text;
}
