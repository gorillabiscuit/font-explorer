// Where the outlines leave the app: ⌘C on the focused card, a Copy SVG button on each Compare row,
// and the Export menu in the top bar (JSON, SVG sheet, PNG sheet). The lightbox registers its own
// ⌘C (Lightbox.tsx) with the same copyDrawnWordmark.
import { useRef, useState, type MouseEvent } from "react";
import type { RowActionProps } from "../Compare";
import { exportJson, exportPngSheet, exportSvgSheet } from "../exporters";
import { useHotkeys } from "../keymap";
import { cardEl, cardInSight } from "../nav";
import { usePopover } from "../popover";
import "../projects.css";
import { recipeFromSettings } from "../recipe";
import { useStore } from "../store";
import { copyDrawnWordmark, copyOutlines, downloadSvg, drawnJob, hasTextSelection, layoutToSvg, LOCAL_NOTE } from "./copy";
import "./export.css";

/**
 * ⌘C on the grid copies the focused card as outlines, exactly as the card draws it. Mounted in
 * OVERLAYS. With text selected, or no card in sight, ⌘C is left to the browser.
 */
export function CopyKeys() {
  const { focusId, settings, toast } = useStore();
  useHotkeys("grid", {
    copy: () => {
      if (hasTextSelection() || !focusId || !cardInSight(focusId)) return false;
      // The card's own wordmark comes first; small-size copies (the Small stress view) follow it.
      return copyDrawnWordmark(cardEl(focusId)?.querySelector(".wm-svg"), recipeFromSettings(settings), toast);
    },
  });
  return null;
}

/**
 * Copy SVG and Download SVG in a Compare row's header: the candidate's own layout, as its large
 * column draws it. The layout is read from that wordmark together with the weight and file it was
 * measured in, so a copy made just as the row switches file or weight never mixes the two.
 */
export function CopySvgAction({ font, recipe }: RowActionProps) {
  const { toast } = useStore();
  const job = (e: MouseEvent<HTMLButtonElement>) => {
    const j = drawnJob(e.currentTarget.closest(".cmp-row")?.querySelector(".cmp-own .wm-svg"), recipe, toast);
    if (j === undefined) toast(font.source === "local" ? LOCAL_NOTE : `${font.family} has not been drawn yet, so there is nothing to copy.`);
    return j;
  };
  const copy = (e: MouseEvent<HTMLButtonElement>) => {
    const j = job(e);
    if (j) copyOutlines(j, toast);
  };
  const download = (e: MouseEvent<HTMLButtonElement>) => {
    const j = job(e);
    if (!j) return;
    void layoutToSvg(j.font, j.weight, j.variant, j.result, j.recipe).then((out) =>
      out ? downloadSvg(out.svg, out.fileName) : toast("Could not read this font's file, so there are no outlines."),
    );
  };
  return (
    <>
      <button title="Copy this candidate's own layout as vector outlines, to paste into Figma" onClick={copy}>
        Copy SVG
      </button>
      <button title="Download this candidate's own layout as an SVG file (if pasting does not work)" onClick={download}>
        ↓ SVG
      </button>
    </>
  );
}

type Kind = "JSON" | "SVG sheet" | "PNG sheet";

/** The top bar's Export menu. Every export reads the candidates' font files first, so it takes a moment. */
export function ExportMenu() {
  const { candidateRows, settings, reasons, toast, projectName } = useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  usePopover(open, () => setOpen(false), ref);
  const count = candidateRows.length;

  const run = (kind: Kind) => {
    setOpen(false);
    setBusy(kind);
    const job =
      kind === "JSON"
        ? exportJson(candidateRows, settings, reasons, projectName)
        : kind === "SVG sheet"
          ? exportSvgSheet(candidateRows, settings, projectName)
          : exportPngSheet(candidateRows, settings, projectName);
    job
      .then((notes) => notes.length && toast(notes.join(" "), { ms: 12000 }))
      .catch((err: unknown) => toast(`Could not export the ${kind}: ${err instanceof Error ? err.message : String(err)}`, { ms: 12000 }))
      .finally(() => setBusy(null));
  };

  return (
    <div className="popover-anchor export-menu" ref={ref}>
      <button
        disabled={!count || busy !== null}
        aria-expanded={open}
        title={count ? "Export the candidates" : "Save candidates first (★ or S)"}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? `Exporting ${busy}…` : "Export"} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="popover" role="menu">
          <div className="menu-head">
            {count} candidate{count === 1 ? "" : "s"}
          </div>
          <button className="menu-item" role="menuitem" onClick={() => run("JSON")}>
            <span className="label">JSON</span>
            <span className="when">recipes, licences, files</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => run("SVG sheet")}>
            <span className="label">SVG sheet</span>
            <span className="when">outlines, opens in Figma</span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => run("PNG sheet")}>
            <span className="label">PNG sheet</span>
            <span className="when">the same, as an image</span>
          </button>
        </div>
      )}
    </div>
  );
}
