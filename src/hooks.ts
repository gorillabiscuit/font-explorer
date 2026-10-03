import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { deepMerge, isPlainObject } from "./merge";

/** Saved objects are deep-merged over `initial`, so fields added since they were saved get their defaults. */
export function readStored<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial;
    const saved = JSON.parse(raw) as unknown;
    return isPlainObject(initial) && isPlainObject(saved) ? deepMerge(initial, saved) : (saved as T);
  } catch {
    return initial;
  }
}

interface Stored<T> {
  key: string;
  value: T;
  /** Changed since it was read, so it needs writing. What was just read is never written back. */
  dirty: boolean;
}

export function usePersisted<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<Stored<T>>(() => ({ key, value: readStored(key, initial), dirty: false }));
  const initialRef = useRef(initial);
  initialRef.current = initial;
  // A new key (another project) re-reads storage in place, so switching projects needs no remount.
  // A change to the old key that has not been written yet (it came in the same render as the switch)
  // is written first, or it would be lost: the effect below only ever writes the current key.
  let current = stored;
  if (stored.key !== key) {
    if (stored.dirty) writeStored(stored.key, stored.value);
    current = { key, value: readStored(key, initial), dirty: false };
    setStored(current);
  }
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setStored((s) => {
        const value = typeof next === "function" ? (next as (prev: T) => T)(s.value) : next;
        return Object.is(value, s.value) ? s : { key: s.key, value, dirty: true };
      }),
    [],
  );
  useEffect(() => {
    if (current.dirty) writeStored(current.key, current.value);
  }, [current]);
  // Another tab on the same project wrote this key: take its value, or the next change here would
  // write this tab's older state back over it (and on to the server copy).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || e.key !== key) return;
      setStored((s) => (s.key === key ? { key, value: readStored(key, initialRef.current), dirty: false } : s));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);
  return [current.value, set];
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: state still works for this session
  }
}

/**
 * One shared observer per margin, so a card and its wordmark can watch different distances. Several
 * components may watch one element at one margin (a card's wordmark and its stress-view copies):
 * each gets every report, and one leaving does not stop the others' reports.
 */
const observers = new Map<
  string,
  { observer: IntersectionObserver; watchers: WeakMap<Element, Set<(visible: boolean) => void>>; seen: WeakMap<Element, boolean> }
>();

/** The last report for an element already watched at this margin, undefined when there is none yet. */
export function peekInView(el: Element, rootMargin: string): boolean | undefined {
  return observers.get(rootMargin)?.seen.get(el);
}

/** True while the element is within `rootMargin` of the viewport. Cards load their font only when near it. */
export function useInView(ref: RefObject<Element | null>, rootMargin = "600px 0px"): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let shared = observers.get(rootMargin);
    if (!shared) {
      const watchers = new WeakMap<Element, Set<(visible: boolean) => void>>();
      const seen = new WeakMap<Element, boolean>();
      const observer = new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => {
            // No box at all: the grid is hidden while Compare shows. That says nothing about where
            // the element is, so it keeps its last report, and the grid comes back as it was left.
            const r = e.boundingClientRect;
            if (!e.isIntersecting && r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) return;
            seen.set(e.target, e.isIntersecting);
            watchers.get(e.target)?.forEach((cb) => cb(e.isIntersecting));
          }),
        { rootMargin },
      );
      observers.set(rootMargin, (shared = { observer, watchers, seen }));
    }
    const { observer, watchers, seen } = shared;
    let set = watchers.get(el);
    if (!set) {
      watchers.set(el, (set = new Set()));
      observer.observe(el);
    } else if (seen.has(el)) {
      // Already observed: the observer reports only changes, so a new watcher starts from the last report.
      setVisible(seen.get(el)!);
    }
    set.add(setVisible);
    return () => {
      set.delete(setVisible);
      if (set.size) return;
      watchers.delete(el);
      seen.delete(el);
      observer.unobserve(el);
    };
  }, [ref, rootMargin]);
  return visible;
}

const widthCallbacks = new WeakMap<Element, (width: number) => void>();
let resizeObserver: ResizeObserver | null = null;

/**
 * The element's content width in px, from one shared ResizeObserver; undefined until it first reports
 * (just after the element is laid out). Deliberately no synchronous read on mount: a state update
 * from a layout effect re-renders synchronously, and with a hundred cards mounting at once that
 * chains React's passive effects into one long task the browser never gets to interrupt.
 */
export function useWidth(ref: RefObject<Element | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A width of 0 is skipped: the element keeps its last width. It comes from an element that is not
    // laid out, not from one with no room: a card's contents once the card is skipped far off screen
    // (content-visibility), or the whole grid hidden while Compare shows. Taking it laid every such
    // wordmark out unfitted, then again at its real width when it came back.
    resizeObserver ??= new ResizeObserver((entries) =>
      entries.forEach((e) => {
        if (e.contentRect.width > 0) widthCallbacks.get(e.target)?.(e.contentRect.width);
      }),
    );
    widthCallbacks.set(el, setWidth);
    resizeObserver.observe(el);
    return () => {
      resizeObserver?.unobserve(el);
      widthCallbacks.delete(el);
    };
  }, [ref]);
  return width;
}

// One timer for every useSettled caller, so a pause in typing updates the whole grid in one render.
const settling = new Set<() => void>();
let settleTimer = 0;
/** The value the timer is waiting on. */
let settleValue: unknown;

/**
 * `value`, held back until it has stopped changing for `ms` (the name while typing). The first value
 * comes through at once. Every caller waiting at the same moment updates in the same task. Only a
 * new value restarts the wait: cards far off screen take the name a little later (Card.tsx), and
 * each of those joining the wait must not hold back the cards on screen.
 */
export function useSettled<T>(value: T, ms = 120): T {
  const [settled, setSettled] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const done = () => setSettled(() => latest.current);
    settling.add(done);
    if (!settleTimer || !Object.is(value, settleValue)) {
      settleValue = value;
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        const waiting = [...settling];
        settling.clear();
        waiting.forEach((fn) => fn());
      }, ms);
    }
    return () => {
      settling.delete(done);
    };
  }, [value, settled, ms]);
  return settled;
}
