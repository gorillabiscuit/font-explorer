// Small building blocks for the ⚙ popover, shared by every formation's controls.
import type { ReactNode } from "react";

/** One labelled row of the popover. */
export function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="layout-field" title={title}>
      <span className="layout-field-label">{label}</span>
      {children}
    </div>
  );
}

/** A segmented choice between a few values. */
export function Seg<T extends string>({ options, value, onChange }: { options: [T, string][]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** A slider with its value shown; double-click puts it back to `reset`. */
export function Slider({
  value,
  min,
  max,
  step,
  reset,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  reset: number;
  format: (v: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <span className="layout-slider" title="Double-click to reset">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(reset)} />
      <span className="val">{format(value)}</span>
    </span>
  );
}

export function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="layout-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
