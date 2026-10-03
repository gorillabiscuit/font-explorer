// The project's brief: one line on what it is, for whom, and words to avoid. Claude reads it with
// every vibe search. It is edited here, from the project menu and from the Brief toggle in the vibe row.
// The online build has no vibe search, so neither the project menu nor a vibe row offers it there.
import { useRef, useState } from "react";
import { usePopover } from "./popover";
import { useStore } from "./store";
import "./projects.css";

export function BriefField({ autoFocus, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const { brief, setBrief } = useStore();
  return (
    <input
      className="brief-field"
      type="text"
      value={brief}
      maxLength={300}
      autoFocus={autoFocus}
      placeholder="What it is, for whom, words to avoid"
      onChange={(e) => setBrief(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone?.();
      }}
    />
  );
}

/** The Brief chip in the vibe row: a dot shows a brief is set, and a click edits it in place. */
export function BriefToggle() {
  const { brief } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  usePopover(open, () => setOpen(false), ref);
  const isSet = brief.trim().length > 0;
  return (
    <span className="popover-anchor" ref={ref}>
      <button
        type="button"
        className={`chip brief-toggle ${open ? "on" : ""}`}
        title={isSet ? `Brief: ${brief}` : "Add a one-line brief. Claude reads it with every vibe search."}
        onClick={() => setOpen(!open)}
      >
        Brief
        {isSet && <span className="brief-set" aria-label="(set)" />}
      </button>
      {open && (
        <div className="popover brief-pop">
          <div className="menu-head">Brief · Claude reads it with every vibe search</div>
          <div className="menu-form">
            <BriefField autoFocus onDone={() => setOpen(false)} />
          </div>
        </div>
      )}
    </span>
  );
}
