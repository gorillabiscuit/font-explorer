import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_LAYOUT, type LayoutSettings } from "../../recipe";
import type { TextCase } from "../../settings";
import { MATCH_RATIO, TIGHTEST } from "../lockup";
import { Field, Seg, Slider } from "./fields";
import type { FormationControlProps } from "./registry";

type Lockup = LayoutSettings["lockup"];

export function LockupControls({ layout, update }: FormationControlProps) {
  const { lockup } = layout;
  const set = (patch: Partial<Lockup>) => update((l) => ({ ...l, lockup: { ...l.lockup, ...patch } }));
  const ratio = typeof lockup.size === "number" ? lockup.size : null;
  // With size Match, below or above, the letter-spacing is whatever brings the line to the name's width.
  const tracked = lockup.size === "match" && lockup.position !== "right";
  return (
    <>
      <Field label="Descriptor" title="The line set with the name, in the same face and weight">
        <SettledText value={lockup.descriptor} placeholder="CLOTHING" onChange={(descriptor) => set({ descriptor })} />
      </Field>
      <Field label="Position">
        <Seg<Lockup["position"]>
          options={[
            ["below", "Below"],
            ["right", "Right"],
            ["above", "Above"],
          ]}
          value={lockup.position}
          onChange={(position) => set({ position })}
        />
      </Field>
      {lockup.position !== "right" && (
        <Field label="Align" title="Lines up the descriptor's ink with the name's">
          <Seg<Lockup["align"]>
            options={[
              ["left", "Left"],
              ["center", "Centre"],
              ["right", "Right"],
            ]}
            value={lockup.align}
            onChange={(align) => set({ align })}
          />
        </Field>
      )}
      <Field label="Size" title={`Match: cap height ${MATCH_RATIO} of the name's, spaced out to the name's width. Ratio: a share of the name's cap height`}>
        <span className="layout-inline">
          <Seg<"match" | "ratio">
            options={[
              ["match", "Match"],
              ["ratio", "Ratio"],
            ]}
            value={ratio === null ? "match" : "ratio"}
            onChange={(v) => set({ size: v === "match" ? "match" : MATCH_RATIO })}
          />
          {ratio !== null && <Slider value={ratio} min={0.2} max={0.5} step={0.01} reset={MATCH_RATIO} format={(v) => `×${v.toFixed(2)}`} onChange={(size) => set({ size })} />}
        </span>
      </Field>
      <Field label="Case">
        <Seg<TextCase>
          options={[
            ["as", "As typed"],
            ["upper", "UPPER"],
            ["lower", "lower"],
          ]}
          value={lockup.textCase}
          onChange={(textCase) => set({ textCase })}
        />
      </Field>
      <Field label="Spacing" title="The descriptor's letter-spacing, in em">
        {tracked ? (
          <span className="faint">Set by Match, to the name's width (never tighter than {TIGHTEST}em)</span>
        ) : (
          <Slider value={lockup.tracking} min={-0.05} max={0.6} step={0.01} reset={DEFAULT_LAYOUT.lockup.tracking} format={(v) => `${v.toFixed(2)}em`} onChange={(tracking) => set({ tracking })} />
        )}
      </Field>
      <Field label="Gap" title="Between the name and the descriptor, in the name's cap heights">
        <Slider value={lockup.gap} min={0.1} max={2} step={0.05} reset={DEFAULT_LAYOUT.lockup.gap} format={(v) => `${v.toFixed(2)} cap`} onChange={(gap) => set({ gap })} />
      </Field>
    </>
  );
}

/**
 * A text field that passes its value on once typing pauses for 120 ms (as the name field does), so
 * the whole grid re-lays out once per pause, not on every key. Leaving the field, or closing the
 * popover (Esc, a click outside), passes on what is still waiting, so the last keys are never lost.
 */
export function SettledText({ value, placeholder, onChange }: { value: string; placeholder?: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const sent = useRef(value);
  const typed = useRef(draft);
  typed.current = draft;
  // A change from elsewhere (another project, Undo) replaces the draft.
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setDraft(value);
    }
  }, [value]);
  const latest = useRef(onChange);
  latest.current = onChange;
  const flush = useCallback(() => {
    if (typed.current === sent.current) return;
    sent.current = typed.current;
    latest.current(typed.current);
  }, []);
  useEffect(() => {
    if (draft === sent.current) return;
    const timer = window.setTimeout(flush, 120);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  // The popover unmounts the field when it closes; the pending timer dies with it, so send now.
  useEffect(() => flush, [flush]);
  return <input type="text" className="layout-text" value={draft} placeholder={placeholder} spellCheck={false} onChange={(e) => setDraft(e.target.value)} onBlur={flush} />;
}
