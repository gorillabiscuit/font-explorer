import { DEFAULT_LAYOUT, type LayoutSettings } from "../../recipe";
import { resolveContainer } from "../container";
import { Field, Seg, Slider, Toggle } from "./fields";
import type { FormationControlProps } from "./registry";

type Container = LayoutSettings["container"];

/** Shown under every formation's own settings: the shape the name sits in. */
export function ContainerControls({ layout, update }: FormationControlProps) {
  const { container } = layout;
  const set = (patch: Partial<Container>) => update((l) => ({ ...l, container: { ...l.container, ...patch } }));
  // With Auto on, the controls show what Auto picked; picking anything yourself turns Auto off.
  const shown = resolveContainer(layout);
  return (
    <>
      <div className="layout-pop-section">Container</div>
      <Field label="Auto">
        <Toggle
          checked={container.auto}
          label="Filled square for Block and Mark"
          // Turning Auto off keeps what it showed, so nothing jumps until another shape is picked.
          onChange={(auto) => set(auto ? { auto } : { auto, shape: shown?.shape ?? "none", style: shown?.style ?? container.style })}
        />
      </Field>
      <Field label="Shape" title="Square, rounded and circle are tiles 4× the Size, the same for every face; the name is scaled to sit inside. A pill hugs the name">
        <Seg<Container["shape"]>
          options={[
            ["none", "None"],
            ["square", "Square"],
            ["rounded", "Rounded"],
            ["circle", "Circle"],
            ["pill", "Pill"],
          ]}
          value={shown?.shape ?? "none"}
          onChange={(shape) => set({ shape, style: shown?.style ?? container.style, auto: false })}
        />
      </Field>
      <Field label="Style" title="Fill: the shape in ink, the letters cut out. Keyline: an outline as heavy as the letters' stems. Guide: a faint clear-space outline">
        <Seg<Container["style"]>
          options={[
            ["fill", "Fill"],
            ["keyline", "Keyline"],
            ["guide", "Guide"],
          ]}
          value={shown?.style ?? container.style}
          onChange={(style) => set({ style, shape: shown?.shape ?? (container.shape === "none" ? "square" : container.shape), auto: false })}
        />
      </Field>
      <Field label="Padding" title="Clear space between the letters and the shape, in cap heights">
        <Slider value={container.padding} min={0} max={2} step={0.05} reset={DEFAULT_LAYOUT.container.padding} format={(v) => `${v.toFixed(2)} cap`} onChange={(padding) => set({ padding })} />
      </Field>
    </>
  );
}
