import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CARD_BADGES } from "./card/Badges";
import { drawnFace, ensureFace, isFontLoaded, nearestWeight } from "./fonts";
import { useInView } from "./hooks";
import { DEFAULT_SETTINGS, type Settings } from "./settings";
import type { Verdict } from "./store";
import { StressView } from "./StressView";
import { SOURCE_LABELS, type FontEntry } from "./types";
import { NEAR, Wordmark } from "./Wordmark";

/**
 * The grid settings reach cards through this feed rather than as a prop. The grid never unmounts a
 * card, so with a thousand or more drawn, re-rendering every card in the render that changed the
 * settings (1-5, the Size slider, a key of the name, V) took 150-500 ms. Now only the cards near
 * the screen (NEAR) take a change in that render; the rest catch up afterwards, a few dozen per
 * task, so the browser paints and takes input in between, and any card coming near takes the
 * current settings at once. While the grid is hidden (Compare is showing), every card catches up
 * that way, and the cards near the screen catch up before the grid is painted again.
 */
const feed = { settings: DEFAULT_SETTINGS, shown: true, listeners: new Set<() => void>() };

/** Far cards waiting to take the current settings, and how many take them per task. */
const behind = new Set<() => void>();
const CATCH_UP_BATCH = 60;
let catchUpTimer = 0;

function catchUpLater(update: () => void) {
  behind.add(update);
  catchUpTimer ||= window.setTimeout(catchUp, 0);
}

function catchUp() {
  catchUpTimer = 0;
  let n = 0;
  for (const update of behind) {
    behind.delete(update);
    update();
    if (++n >= CATCH_UP_BATCH) break;
  }
  if (behind.size) catchUpTimer = window.setTimeout(catchUp, 0);
}

/** App calls this with the grid settings and whether the grid is showing. */
export function usePublishCardSettings(settings: Settings, shown: boolean): void {
  // Set during the render, so cards mounted by this same render start from these settings.
  feed.settings = settings;
  feed.shown = shown;
  useLayoutEffect(() => feed.listeners.forEach((update) => update()), [settings, shown]);
}

function useCardSettings(near: boolean): Settings {
  const nearNow = useRef(near);
  nearNow.current = near;
  const [own, setOwn] = useState(feed.settings);
  useEffect(() => {
    // Read when it runs, so a far card that waited takes the newest settings.
    const take = () => setOwn(feed.settings);
    const update = () => {
      if (nearNow.current && feed.shown) {
        behind.delete(take);
        take();
      } else catchUpLater(take);
    };
    feed.listeners.add(update);
    update(); // a change between this card's render and this effect
    return () => {
      feed.listeners.delete(update);
      behind.delete(take);
    };
  }, []);
  return near && feed.shown ? feed.settings : own;
}

// Card never reads the store context: it gets only stable props, so a verdict on one card
// re-renders that card alone. The settings come from the feed above.
interface Props {
  font: FontEntry;
  number?: number;
  reason?: string;
  verdict?: Verdict;
  /** At least one candidate saved for this font: the star. */
  hasCandidate: boolean;
  focused: boolean;
  onCull: (id: string) => void;
  onMaybe: (id: string) => void;
  onShortlist: (id: string) => void;
  onRestore: (id: string) => void;
}

type LoadState = "idle" | "loading" | "ready" | "failed";

export const Card = memo(function Card({
  font,
  number,
  reason,
  verdict,
  hasCandidate,
  focused,
  onCull,
  onMaybe,
  onShortlist,
  onRestore,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref);
  const settings = useCardSettings(useInView(ref, NEAR));
  const { italic } = settings;
  // The face to draw until the load below answers: the family's italic when Italic is on and the
  // catalogue lists one (fonts.ts italicFace), else the font itself.
  const guess = drawnFace(font, italic);
  const [state, setState] = useState<LoadState>(() => (isFontLoaded(guess, settings.weight) ? "ready" : "idle"));
  // The face and weight actually shown: the nearest weight, or the next nearest when that file will
  // not load, and the upright when the italic will not. Kept with the setting it answered, so a
  // change of weight or Italic never shows the last setting's face.
  const asked = `${settings.weight}@${italic}`;
  const [loaded, setLoaded] = useState<{ asked: string; face: FontEntry; weight: number } | null>(null);

  useEffect(() => {
    if (isFontLoaded(guess, settings.weight)) {
      setLoaded(null);
      setState("ready");
      return;
    }
    if (!visible) return;
    let live = true;
    setState("loading");
    ensureFace(font, settings.weight, italic).then((got) => {
      if (!live) return;
      setLoaded(got && { asked, ...got });
      setState(got === null ? "failed" : "ready");
    });
    return () => {
      live = false;
    };
  }, [font, guess, settings.weight, italic, asked, visible]);

  const shown = loaded?.asked === asked ? loaded : null;
  const face = shown?.face ?? guess;
  const weight = shown?.weight ?? nearestWeight(face, settings.weight);
  const recipe = useMemo(() => ({ weight }), [weight]);
  const culled = verdict === "cull";
  const classes = ["card", culled && "is-culled", verdict === "maybe" && "is-maybe", hasCandidate && "is-shortlisted", focused && "is-focused"]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className={classes} data-font-id={font.id}>
      <StressView mode={settings.stress}><Wordmark font={face} settings={settings} recipe={recipe} className={state === "ready" ? undefined : "is-pending"} /></StressView>
      {/* In the corner where the maybe dot sits, so the meta row keeps its old layout. */}
      <button className={`maybe-btn ${verdict === "maybe" ? "on" : ""}`} title="Maybe (M)" onClick={() => onMaybe(font.id)}>
        ○
      </button>
      <div className="meta">
        <div className="meta-main">
          {number !== undefined && <span className="num">#{number}</span>}
          {font.homepage ? (
            <a className="family" href={font.homepage} target="_blank" rel="noreferrer" title={`${font.tags.join(", ")}\nOpen the foundry page`}>
              {font.family} <span className="ext">↗</span>
            </a>
          ) : (
            <span className="family" title={font.tags.join(", ")}>
              {font.family}
            </span>
          )}
          <span className={`badge src-${font.source}`}>{SOURCE_LABELS[font.source]}</span>
          <span className="badge">{font.license}</span>
          {weight !== settings.weight && <span className="badge faint">{weight}</span>}
          {state === "failed" && <span className="badge warn">failed to load</span>}
          {CARD_BADGES.map((Badge, i) => (
            <Badge key={i} font={face} settings={settings} weight={weight} />
          ))}
        </div>
        <div className="actions">
          <button
            className={`icon-btn ${hasCandidate ? "on" : ""}`}
            title={hasCandidate ? "Save these settings as a candidate too, or remove the matching one (S)" : "Save as a candidate (S)"}
            onClick={() => onShortlist(font.id)}
          >
            ★
          </button>
          {culled ? (
            <button className="icon-btn" title="Restore" onClick={() => onRestore(font.id)}>
              ↺
            </button>
          ) : (
            <button className="icon-btn" title="Cull (X)" onClick={() => onCull(font.id)}>
              ✕
            </button>
          )}
        </div>
      </div>
      {reason && <div className="reason">{reason}</div>}
    </div>
  );
});
