import { DEFAULT_LAYOUT, rowGapOf, type LayoutSettings } from "../../recipe";
import { Field, Seg, Slider } from "./fields";
import type { FormationControlProps } from "./registry";
import { formatGap, ROW_GAP } from "./spacing";

type Block = LayoutSettings["block"];

const COLUMNS = ["auto", "2", "3", "4", "5", "6"] as const;

export function BlockControls({ layout, update }: FormationControlProps) {
  const { block } = layout;
  const set = (patch: Partial<Block>) => update((l) => ({ ...l, block: { ...l.block, ...patch } }));
  return (
    <>
      <Field label="Mode" title="Cells: every letter in an equal square cell, the Uniqlo look. Rows: each row one kerned line, justified by letter-spacing">
        <Seg<Block["mode"]>
          options={[
            ["cells", "Cells"],
            ["rows", "Rows"],
          ]}
          value={block.mode}
          onChange={(mode) => set({ mode })}
        />
      </Field>
      <Field label="Columns" title="Letters per row. Auto: 4 is 2×2, 6 is 3×2, 7 is 4+3. A typed '/' or a chosen break still wins">
        <Seg<(typeof COLUMNS)[number]>
          options={COLUMNS.map((c) => [c, c === "auto" ? "Auto" : c])}
          value={block.cols === null ? "auto" : (String(block.cols) as (typeof COLUMNS)[number])}
          // Columns and chosen line breaks both decide the rows; the latest choice wins, so a column
          // count clears the breaks.
          onChange={(c) => update((l) => ({ ...l, breaks: null, block: { ...l.block, cols: c === "auto" ? null : Number(c) } }))}
        />
      </Field>
      {/* Rows mode has no gap across a row: each row is one line, justified by letter-spacing. */}
      {block.mode === "cells" && (
        <Field label="Letter gap" title="Space between the letters of a row, in cap heights">
          <Slider
            value={block.gap}
            min={0}
            max={0.6}
            step={0.02}
            reset={DEFAULT_LAYOUT.block.gap}
            format={(v) => formatGap(v, "cap")}
            // A layout from before the split has one gap both ways; moving it now leaves the rows where they were.
            onChange={(gap) => update((l) => ({ ...l, block: { ...l.block, gap, rowGap: rowGapOf(l.block) } }))}
          />
        </Field>
      )}
      <Field label="Line gap" title="Space between rows, in cap heights. Below 0 the rows overlap, and a card says when letters collide">
        <Slider value={rowGapOf(block)} {...ROW_GAP} format={(v) => formatGap(v, "cap")} onChange={(rowGap) => set({ rowGap })} />
      </Field>
      <Field label="Last row" title="Where a short last row sits">
        <Seg<Block["lastRow"]>
          options={[
            ["center", "Centre"],
            ["left", "Left"],
          ]}
          value={block.lastRow}
          onChange={(lastRow) => set({ lastRow })}
        />
      </Field>
    </>
  );
}
