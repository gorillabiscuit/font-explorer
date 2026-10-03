import type { LayoutSettings } from "../../recipe";
import { useStore } from "../../store";
import { Field, Seg, Slider, Toggle } from "./fields";
import type { FormationControlProps } from "./registry";
import { formatGap, LEADING, LEADING_HINT, leadingUnit } from "./spacing";

type Stack = LayoutSettings["stack"];

export function StackControls({ layout, update }: FormationControlProps) {
  const { stack } = layout;
  const set = (patch: Partial<Stack>) => update((l) => ({ ...l, stack: { ...l.stack, ...patch } }));
  // The unit follows the name being set: capitals are leaded in cap heights, anything else in x-heights.
  const unit = leadingUnit(useStore().settings);
  return (
    <>
      <Field label="Align">
        <Seg<Stack["align"]>
          options={[
            ["left", "Left"],
            ["center", "Centre"],
            ["right", "Right"],
          ]}
          value={stack.align}
          onChange={(align) => set({ align })}
        />
      </Field>
      <Field label="Justify">
        <Seg<Stack["justify"]>
          options={[
            ["none", "None"],
            ["track", "Track"],
            ["size", "Size"],
          ]}
          value={stack.justify}
          onChange={(justify) => set({ justify })}
        />
      </Field>
      <Field label="Line spacing" title={`${LEADING_HINT} Below 0 the lines overlap, and a card says when letters collide`}>
        <Slider value={stack.leading} {...LEADING} format={(v) => formatGap(v, unit)} onChange={(leading) => set({ leading })} />
      </Field>
      <OpticalEdge layout={layout} update={update} />
    </>
  );
}

/** Line has one setting of its own, which every formation shares. */
export function LineControls({ layout, update }: FormationControlProps) {
  return <OpticalEdge layout={layout} update={update} />;
}

function OpticalEdge({ layout, update }: FormationControlProps) {
  return (
    <Field label="Edge">
      <Toggle checked={layout.opticalEdge} label="Align the ink, not the sidebearing" onChange={(opticalEdge) => update((l) => ({ ...l, opticalEdge }))} />
    </Field>
  );
}
