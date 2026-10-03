/**
 * Mount points, so a feature adds its UI here instead of editing App.tsx's logic.
 *
 * Each list holds components that take no props and read what they need from useStore() (and
 * register their keys with useHotkeys). To mount one, import it below and append it to a list:
 * one import line and one entry. Order in a list is order on screen. An entry may render null.
 *
 *   TOPBAR_LEFT      far left of the top bar, before the app name (e.g. a project switcher)
 *   TOPBAR_CONTROLS  in the top bar, right after the Case control (e.g. layout and match controls)
 *   TOPBAR_RIGHT     right side of the top bar, before the Grid/Compare tabs (How it works, the '?' key map)
 *   BELOW_VIBE       whole rows under the vibe bar; each entry is its own row. The top bar stays on screen,
 *                    so a row here should show in every layout, or the bar changes height when the layout does
 *   ABOVE_GRID       whole rows between the top bar and the grid that scroll away with it, in every view
 *                    (e.g. line-break chips, shown in Stack and Block only, so they must not resize the top bar)
 *   FILTER_CHIPS     inside the grid's filter row, after the Candidates/Maybe+/Show culled chips
 *   GRID_PANELS      between the top bar and the grid, grid view only (e.g. a pinned reference band)
 *   OVERLAYS         at the app root, in every view (e.g. a lightbox, the key map)
 *
 * The lists are fixed at load time; React keys are list positions, so do not reorder them at runtime.
 */
import type { ComponentType } from "react";
import { BreakChips } from "./BreakChips";
import { CompareKeys } from "./Compare";
import { CopyKeys } from "./export/ExportControls";
import { HasItalicChip, ItalicToggle } from "./ItalicControls";
import { HowItWorks, HowItWorksButton } from "./HowItWorks";
import { KeyHelp, KeyHelpButton } from "./KeyHelp";
import { LayoutControls } from "./LayoutControls";
import { Lightbox } from "./Lightbox";
import { LineSpacing } from "./LineSpacing";
import { LogoSafeChip } from "./LogoSafeChip";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ReferenceBand } from "./ReferenceBand";
import { StressChip } from "./StressView";

export type SlotEntry = ComponentType;

export const TOPBAR_LEFT: SlotEntry[] = [ProjectSwitcher];
export const TOPBAR_CONTROLS: SlotEntry[] = [ItalicToggle, LayoutControls, LineSpacing];
export const TOPBAR_RIGHT: SlotEntry[] = [HowItWorksButton, KeyHelpButton];
export const BELOW_VIBE: SlotEntry[] = [];
export const ABOVE_GRID: SlotEntry[] = [BreakChips];
export const FILTER_CHIPS: SlotEntry[] = [LogoSafeChip, StressChip, HasItalicChip];
export const GRID_PANELS: SlotEntry[] = [ReferenceBand];
export const OVERLAYS: SlotEntry[] = [KeyHelp, HowItWorks, Lightbox, CompareKeys, CopyKeys];

/** Renders one list in place. */
export function Slots({ of }: { of: SlotEntry[] }) {
  return (
    <>
      {of.map((Entry, i) => (
        <Entry key={i} />
      ))}
    </>
  );
}
