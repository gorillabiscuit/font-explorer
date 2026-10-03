// The ⚙ popover's contents per formation (LayoutControls.tsx renders them). A formation adds its
// controls with one import and one entry here; nothing else needs editing.
import type { ComponentType } from "react";
import type { Formation, LayoutSettings } from "../../recipe";
import { BlockControls } from "./BlockControls";
import { ContainerControls } from "./ContainerControls";
import { LockupControls } from "./LockupControls";
import { MarkControls } from "./MarkControls";
import { LineControls, StackControls } from "./StackControls";

export interface FormationControlProps {
  layout: LayoutSettings;
  /** Changes the grid's layout settings. */
  update: (change: (layout: LayoutSettings) => LayoutSettings) => void;
}

export const FORMATION_CONTROLS: Partial<Record<Formation, ComponentType<FormationControlProps>>> = {
  line: LineControls,
  stack: StackControls,
  block: BlockControls,
  lockup: LockupControls,
  mark: MarkControls,
};

/** Shown under every formation's own controls (e.g. containers). */
export const COMMON_CONTROLS: ComponentType<FormationControlProps>[] = [ContainerControls];
