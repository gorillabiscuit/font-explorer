import type { LayoutSettings } from "../../recipe";
import { parseName } from "../../settings";
import { useStore } from "../../store";
import { markInitials } from "../mark";
import { Field, Seg } from "./fields";
import { SettledText } from "./LockupControls";
import type { FormationControlProps } from "./registry";

type Mark = LayoutSettings["mark"];

export function MarkControls({ layout, update }: FormationControlProps) {
  const { mark } = layout;
  const set = (patch: Partial<Mark>) => update((l) => ({ ...l, mark: { ...l.mark, ...patch } }));
  // The initials the name gives, as many as the build uses, shown as the field's placeholder until
  // an override is typed.
  const { settings } = useStore();
  const derived = markInitials({ ...parseName(settings), initials: "" })
    .slice(0, mark.construction === "single" ? 1 : 2)
    .join("");
  return (
    <>
      <Field label="Initials" title="Leave empty to take the first letter of each word or '/' line, or the first two letters of one word">
        <SettledText value={mark.initials} placeholder={derived || "AB"} onChange={(initials) => set({ initials })} />
      </Field>
      <Field label="Build" title="Single: the first initial. Pair: two initials side by side. Stacked: the pair one above the other">
        <Seg<Mark["construction"]>
          options={[
            ["single", "Single"],
            ["pair", "Pair"],
            ["stacked", "Stacked"],
          ]}
          value={mark.construction}
          onChange={(construction) => set({ construction })}
        />
      </Field>
    </>
  );
}
