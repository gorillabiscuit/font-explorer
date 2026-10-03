// The words of the How it works panel (HowItWorks.tsx), as data. Every key it names is a reference
// to a binding in KEYMAP, never a letter typed into a sentence, so the panel shows whatever the key
// map binds and cannot drift from it. helpProblems() checks that; DOM-free, so a Node script can too.
import { DONE_TYPING_KEYS, KEYMAP, type HotkeyAction, type HotkeyScope, type KeyBinding } from "./keymap";
import { FORMATION_LABELS, FORMATION_ORDER } from "./recipe";

/** One binding's keys, drawn as key caps. `only` picks some of them ('Space' of 'Space' and 'Enter'). */
export interface KeyRef {
  scope: HotkeyScope;
  action: string;
  only?: string[];
}

/**
 * A piece of a sentence: plain words, key caps from KEYMAP, the name of a control on screen,
 * something typed into the name field (the '/' that breaks a line), or a key the name field takes
 * itself to end typing (keymap.ts DONE_TYPING_KEYS, not a KEYMAP binding).
 */
export type Part = string | { keys: KeyRef } | { ui: string } | { typed: string } | { field: string };

const key = <S extends HotkeyScope>(scope: S, action: HotkeyAction<S>, ...only: string[]): { keys: KeyRef } => ({
  keys: { scope, action, ...(only.length ? { only } : {}) },
});
const ui = (name: string) => ({ ui: name });

/** 'Line, Stack, Block, Lockup or Mark', in key order. */
const formations = FORMATION_ORDER.map((f) => FORMATION_LABELS[f]);
const formationList = `${formations.slice(0, -1).join(", ")} or ${formations.at(-1)}`;

export interface HelpContent {
  intro: Part[];
  /** Said in the online build only (env.ts STATIC). */
  onlineOnly: Part[][];
  steps: Part[][];
  outro: Part[];
}

/** `fonts`: how many fonts the catalogue has, rounded for the intro ('2,100'). */
export function helpContent(fonts: string): HelpContent {
  return {
    intro: [
      `Font Explorer helps you choose a typeface for a logo or wordmark. You see your own name, in the layout it will really have, set in about ${fonts} free fonts. It works best on a computer with a keyboard.`,
    ],
    onlineOnly: [
      ["This online version has no vibe search (finding fonts by describing a feel in words)."],
      ["Your projects are kept in this browser only, so clearing the browser's data clears them too."],
    ],
    steps: [
      [
        "Type the name, with ",
        { typed: "/" },
        " for a line break, and press ",
        { field: "Enter" },
        ". Then pick a layout with ",
        key("grid", "layout"),
        `: ${formationList}.`,
      ],
      [
        "Move through the fonts with ",
        key("grid", "move"),
        " or the mouse. ",
        key("grid", "cull"),
        " culls a font so it leaves the grid, ",
        key("grid", "maybe"),
        " marks it as a maybe, and ",
        key("grid", "shortlist"),
        " saves it as a candidate with the exact settings you see. Each one moves on to the next font, and ",
        key("global", "undo"),
        " undoes it.",
      ],
      [key("grid", "pin"), " pins a favourite. It stays in view above the grid, so you judge every other font against it."],
      [
        key("grid", "open", "Space"),
        " opens the font large, in the lightbox. There ",
        key("lightbox", "flip"),
        " flip between fonts, ",
        key("lightbox", "blink"),
        " blinks between this font and your pinned one, and ",
        key("lightbox", "alternates"),
        " cycles through its alternate letters.",
      ],
      [key("grid", "italic"), " switches italic on and off. The ", ui("Line spacing"), " slider sets the space between lines in Stack and Block."],
      [ui("Compare"), " lines your candidates up side by side, in every layout and at small sizes."],
      [
        ui("Copy SVG"),
        " in Compare, or ",
        key("grid", "copy"),
        " on a font, puts exact outlines on the clipboard, ready to paste into Figma. ",
        ui("Export"),
        " saves your candidates as a sheet or a JSON file.",
      ],
    ],
    outro: ["Press ", key("global", "help"), " for every key."],
  };
}

/** The binding a reference points at, or undefined when KEYMAP has no such scope and action. */
export function bindingOf(ref: KeyRef): KeyBinding | undefined {
  return (KEYMAP as readonly KeyBinding[]).find((b) => b.scope === ref.scope && b.action === ref.action);
}

/** The keys a reference draws, in KEYMAP's spelling ('x', 'ArrowLeft', 'Mod+c'). */
export function keysOf(ref: KeyRef): readonly string[] {
  return ref.only ?? bindingOf(ref)?.keys ?? [];
}

/**
 * A key named in plain words: a lone capital letter ('press X'), a key name, an arrow, a run of
 * digits ('1-5'), or '?' and '/' standing alone. Words like 'SVG' and 'JSON' are not keys.
 */
const KEY_IN_WORDS = /(?<![\p{L}\d])[A-Z](?![\p{L}\d])|\b(?:Space|Enter|Esc|Escape|Shift|Ctrl|Cmd|Alt|Tab|Home|End)\b|[⌘⌥⇧←→↑↓]|\b\d\s*[-–]\s*\d\b|(?<!\S)[?/](?!\S)/gu;

/**
 * Everything wrong with the panel's words against KEYMAP: a reference to a binding that does not
 * exist, a key picked that the binding does not have, a key the name field does not take, or a key
 * named in a sentence instead of referenced (it would not follow a change to the key map). Empty
 * when the panel is right.
 */
export function helpProblems(content: HelpContent = helpContent("2,100")): string[] {
  const problems: string[] = [];
  const parts = [...content.intro, ...content.onlineOnly.flat(), ...content.steps.flat(), ...content.outro];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const [named] of part.matchAll(KEY_IN_WORDS)) problems.push(`names the key '${named}' in words instead of from KEYMAP: "${part}"`);
    } else if ("keys" in part) {
      const b = bindingOf(part.keys);
      if (!b) problems.push(`no KEYMAP binding ${part.keys.scope}:${part.keys.action}`);
      else for (const k of part.keys.only ?? []) if (!b.keys.includes(k)) problems.push(`${b.scope}:${b.action} has no key '${k}' (it has ${b.keys.join(", ")})`);
    } else if ("field" in part && !DONE_TYPING_KEYS.includes(part.field)) {
      problems.push(`the name field does not end typing on '${part.field}' (keymap.ts DONE_TYPING_KEYS: ${DONE_TYPING_KEYS.join(", ")})`);
    }
  }
  return problems;
}
