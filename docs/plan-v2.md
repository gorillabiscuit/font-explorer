# Font Explorer v2 plan

Produced 2026-10-01 by five expert perspectives (identity designer, typographer, layout specialist,
speed-workflow product designer, brand strategist) who proposed features, debated each other's, and
were synthesised into this plan. Amendments by the lead for execution:

- No git commits. The lead snapshots the project between waves instead (the user commits when he asks).
- Work happens in a staging copy (experiments/font-explorer-staging, dev server on 5174 / API 8788)
  so the user's running app on 5173 / 8787 stays stable; the lead syncs staging back at the end.
- F2 also creates small slot registries so later features mount without editing App.tsx logic.
- Browser checks use headless WebKit (playwright-core) against the staging server; Chromium-only
  APIs (queryLocalFonts) are checked by reading the code.

# VISION
 Type for a wordmark gets chosen on the real name, in the real arrangement, at matched sizes, small and reversed, letter by letter. This tool makes that the default for 2,100 fonts at once. Every card sets the name in the shape the logo will take (one line, a two-line stack, a Uniqlo-style block in a square, name plus descriptor, or a monogram), matched by cap height or x-height. No card ever fakes a missing letter or hides an alternate. The designer works at Photo Mechanic speed: one key per verdict, a lightbox that flips between fonts without moving the word and blinks them against a pinned favourite, and a Compare matrix that tests each candidate in every layout and at every small size. A candidate is an exact recipe (face, weight, case, spacing, alternates, layout) and it leaves as vector outlines that paste straight into Figma. Measurements only sort, flag and normalise; Claude suggests faces from a brief that includes the name; the designer's eye makes the call.

# CORE LOOP
 1. Pick or create a project (one per client and name). Type the name, with '/' for a line break (UNI/QLO). Optionally add a descriptor line and a one-line brief.
2. Press 1-5 to choose the layout the logo will take: Line, Stack, Block, Lockup or Mark. Every card resets at once. Match: Auto gives every font the same cap height (for an all-caps name) or x-height (otherwise), so no font wins just by being drawn bigger. In Stack and Block, chips offer the most balanced line breaks; [ and ] cycle through them.
3. Wide pass with hands on the keyboard. Arrow keys move a focus ring. X culls, M marks maybe, S saves the current settings as a candidate, and each one moves on to the next card. Badges flag missing letters, caps-only faces, unknown licences, and 'Alt a g' when a face has alternate letters that change this name. V cycles stress views (squint, small, reversed, pixel) so weak silhouettes go early. Vibe searches run in the background with the name, layout and brief. Results arrive as chips and never move the grid.
4. P pins the current favourite. A sticky reference band keeps it on screen, so every card is judged as a challenger to it.
5. Space opens the lightbox. The name stays fixed in place, positive and reversed, with a 16 px nav line, favicon tests and a strip of the name's most telling letters. Left and right flip between fonts in place. B blinks and O overlays the current font against the reference, with width and height differences shown in percent. A cycles through alternates (loading Google's full font file for that one font only). S saves the exact recipe.
6. Compare: candidates are rows; layouts and small sizes are columns. Tune each candidate (weight strip, five-step tracking ladder, alternates, case) without touching the grid. Click any letter to line it up across all candidates. 'Apply recipe to grid' re-scans the catalogue around one candidate.
7. Decide and hand off. Copy SVG pastes exact outlines into Figma. The SVG and PNG sheets and the JSON export carry each recipe, licence and source. Each project lives on disk, so two clients' work never mixes.

# ARCHITECTURE
 BUILD ORDER AND WAVES
- Wave 1, in parallel: F1 (font facts) and F2 (store and extension points). F1 touches only src/fonts.ts, new src/facts/* and one package.json script. F2 owns every other existing src file for that wave.
- Wave 2, in parallel: F3 (layout engine part 1), F6 (triage and lightbox), F10 (projects and vibe).
- Wave 3, in parallel: F4 (layout engine part 2), F5 (honest glyphs), F8 (Compare matrix).
- Wave 4, in parallel: F7 (alternates), F9 (outlines and export).
- Each feature is one local commit on the font-explorer branch, then the gate below.
- Per Wouter's standing rule, agents commit locally and never push. He reviews before anything leaves the machine.

THE ONE RENDER PIPELINE
font file bytes (fetched once)
-> FontFace for rendering, plus a lazily parsed fontkit Font (browser build, code-split by a dynamic import)
-> FontFacts and a Measurer (fontkit when the primary file covers the run; canvas measureText as the fallback for installed fonts and latin-ext runs)
-> layoutFormation(input, layout, measurer, opts), a pure function giving a LayoutResult (runs with glyph boxes, missing-glyph rects, container, fit readouts, warnings)
-> renderers:
  - src/Wordmark.tsx: SVG <text> for cards, the lightbox, the reference band and Compare.
  - src/StressView.tsx: wraps Wordmark.
  - src/export/outline.ts: fontkit glyph paths at the same positions, for the clipboard and the sheets.
No other component measures or positions text. That is what makes the copied SVG equal what was judged.
src/facts/core.ts and src/layout/* stay DOM-free, so the Node check scripts (server/check-facts.ts, server/check-layout.ts) test them against the 269 cached indie files in server/.cache/fonts. A later `npm run measure` catalogue index reuses them unchanged.

DATA MODEL (defined by F2 in src/recipe.ts and src/settings.ts; later features implement it, never reshape it)
- Settings: text, size, weight, textCase, tracking, invert, layout: LayoutSettings, stress.
- Marks v2: verdicts Record<fontId, 'cull'|'maybe'>, candidates Candidate[].
- Candidate: id, fontId, recipe, note, addedAt.
- Recipe: text, weight, textCase, tracking, features, axes, layout.
- The project state lives in src/store.ts behind a React context, under per-project localStorage keys `fx:p:<id>:*`, mirrored to server/projects/<id>.json by F10.
- Undo is one generic snapshot action over Marks.
- Grid settings stay global and uniform (only the typeface differs between cards). Per-candidate tuning edits candidate.recipe only.
- Name syntax: '/' is a line break, with '\/' for a literal slash. '|' is reserved for segments and stripped for now. The descriptor and the initials override are separate fields in layout.lockup and layout.mark.

COLLISION RULES
- After wave 1, App.tsx and Card.tsx are mount-only. A feature may add a mount line, a hotkey registration block, or one filter chip. All logic lives in the feature's own new files.
- Card must not read the store context, so memoisation survives. It gets stable props: font, settings, number, reason, verdict, hasCandidate, focused, plus callbacks.
- Extension points created by F2: the Wordmark props contract (font, settings, recipe?, size?, box?, variant?, className?, onLayout?); the CARD_BADGES registry (src/card/Badges.tsx, one line per badge); useHotkeys(scope) and the KEYMAP table (src/keymap.ts); store actions and toast; and the context `items` list.
- Created by F3: the FORMATIONS registry in src/layout/engine.ts, the FORMATION_CONTROLS registry in src/layout/controls/registry.ts, and the stub src/coverage.ts. F4 and F5 extend these without touching Wordmark.tsx.
- F8 leaves an Alternates slot in CandidateTuner for F7.
- CSS goes in per-component files imported by the component (layout.css, lightbox.css, compare.css). styles.css gets only global tokens and the removal of the old mask.
- package.json: each feature adds at most one script line.

FILE OWNERSHIP
- F1: fonts.ts, facts/*
- F2: store.ts, recipe.ts, keymap.ts, KeyHelp.tsx, the Wordmark.tsx stub, card/Badges.tsx, App.tsx, Card.tsx, settings.ts, hooks.ts
- F3: layout/*, Wordmark.tsx internals, LayoutControls.tsx, BreakChips.tsx, coverage.ts stub
- F4: layout/{block,lockup,mark,container}.ts, layout/controls/{Block,Lockup,Mark,Container}Controls.tsx
- F5: coverage.ts, card/CoverageBadge.tsx, latin-ext in fonts.ts and facts/index.ts
- F6: nav.ts, Lightbox.tsx, TellingLetters.tsx, ReferenceBand.tsx
- F7: alternates.ts, AltPicker.tsx, card/AltChip.tsx, server/googleFiles.ts, the 'full' variant in fonts.ts and facts/index.ts
- F8: Compare.tsx, CandidateTuner.tsx, LetterLineup.tsx, StressView.tsx
- F9: export/*, exporters.ts
- F10: server/projects.ts, ProjectSwitcher.tsx, BriefField.tsx, VibeBar.tsx, server/vibe.ts, store sync

KEY MAP (canonical, in src/keymap.ts)
- Global: ⌘/Ctrl+Z undo; ? shows the key map.
- Grid: arrow keys move focus; Home/End; X cull or restore; M maybe; S shortlist the current recipe (X, M and S advance to the next card); Space or Enter opens the lightbox; P pins or unpins the reference; 1-5 choose Line, Stack, Block, Lockup, Mark; [ and ] cycle break suggestions; V cycles stress views; I switches Italic on or off for every card; ⌘C copies outlines; Esc clears focus.
- Lightbox: left/right previous or next font; X, M, S verdicts that advance; P pin; B blink with the reference; O overlay with the reference; A cycle alternates; I italic; 1-5 layout; ⌘C copy outlines; Space or Esc close.
- Compare: click a letter for the lineup; Esc closes the lineup.
- Digits go to layouts because verdicts use letters. Letter keys are never context-overloaded across grid and lightbox, except X, M, S, P, I and 1-5, which mean the same thing everywhere.

LOADING BUDGET
- The grid loads one web file per font, as today.
- latin-ext loads only when the name needs it (F5).
- Google's full upstream file loads only for the font open in the lightbox or for Compare candidates with features (F7), through the caching proxy.
- fontkit parses lazily, with LRUs (400 byte buffers, 200 parsed fonts).
- Re-layout is debounced to 120 ms while typing the name.
- The pixel stress view draws canvases only for cards in view.
- Nothing ever waits on Claude.

SERVER
- Stays loopback-only, with the Host check, as today.
- New routes: /api/google-files (F7) and /api/projects (F10). The font proxy allowlist and limits are unchanged.
- Vibe changes are additive and confined to the user prompt, plus one INSTRUCTIONS rule, so the prompt cache keeps hitting.

RESOLVED DEBATE POINTS
- Caps-only fonts are shown in caps with a 'caps only · shown in caps' badge, not hidden or hatched. The identity designer, typographer and strategist backed this. It is labelled, so the one-variable rule stays honest.
- The 'Sets my name' hide filter waits for the catalogue index, so cards never vanish while fonts load.
- Verdicts are X/M/S, not a three-level ladder plus reasons.
- Number keys go to layouts.
- The descriptor gets its own field, and '|' is reserved for segments.
- Block defaults to equal cells (the real Uniqlo look), with justified rows as the second mode. Every correction a layout needed shows as a readout, never hidden.
- Alternates show as one quiet chip in the grid, with choosing done in the lightbox and Compare.
- Claude suggests faces (now told the name, layout and brief) and never issues verdicts.
- Context mockups are reduced to Compare columns plus grid stress views.
- Projects ship in a minimal version (on disk, with a brief).
- Variable axes and the shape index are deferred, with their data fields reserved now.

QUALITY GATE PER FEATURE
- Run `npm run typecheck`, `npm run build` and the relevant check scripts (check, check:facts, check:layout).
- Run the feature's acceptance steps in the browser through .claude/launch.json ('font-explorer', port 5173).
- Get a fresh-context code review before reporting the feature done.

# BUILD NOW

## F1 Font bytes and in-browser font facts (fontkit)  (deps: -; backed by identity designer, typographer, layout specialist, product designer, brand strategist)
VALUE: Every later feature (fair sizing, honest glyphs, layouts, alternates, Copy SVG) needs the font's real shapes. This reads the font file the browser already downloads, so it gives exact cap height, x-height, missing letters, alternates and outlines, with no extra download and no server round trip.
SPEC: Verified while planning: fontkit 2.0.4 ships a browser build (package exports 'import' -> dist/browser-module.mjs). Vite bundles it to about 357 KB minified. It parsed all 269 cached indie files from a Uint8Array in 90 ms in Node, and glyph bounding boxes give the exact ink extents.

1) src/fonts.ts. ensureFont(f, weight, variant='web') now does fetch(url) -> ArrayBuffer once, then `new FontFace(faceName(f, variant), buf.slice(0), {weight, style:'normal'})` -> load -> document.fonts.add. Keep the bytes in Map<key, ArrayBuffer>, where key is `${id}@${weight}@${variant}`. Cap that map with an LRU of 400 entries; evicting bytes keeps the FontFace. The failure backoff and the ensureNearestFont behaviour stay as today. Export fontBytes(f, weight, variant) (the cached bytes, refetching on a cache miss), fontUrl(f, weight, variant) (the renamed fileUrl), and faceName(f, variant). 'full' returns `fx-<id>-full`, and in F1 its fontUrl returns null (F7 implements it). Local fonts keep today's path.

2) src/facts/types.ts. FontFacts {upm; capHeight; xHeight; ascender; descender; overshoot (all in em); hasLower; lowerIsCaps; hasKerning; features: {tag, uiName?}[]; axes: Record<string,{min,max,default}>; covers(ch): boolean}. Measurer {capHeight; xHeight; ascender; descender; overshoot; exact: boolean; run(text, {size, tracking, features}) -> RunMetrics}. RunMetrics {advance; inkLeft; inkRight; inkTop; inkBottom; glyphs: {index, char, x, advance, inkL, inkR, inkT, inkB, missing}[]}. All values are in px at `size`, with y up from the baseline.

3) src/facts/core.ts. Must be DOM-free and import only `import type {Font} from 'fontkit'`, so Node scripts and the browser share it. computeFacts(font): capHeight and xHeight come from glyph bboxes of 'H' and 'x' (the stored OS/2 values often lie), falling back to OS/2 when the glyph is missing. Ascender and descender come from the bboxes of 'd'/'h' and 'p'/'g', with hhea as fallback. overshoot = (O.bbox.maxY - H.bbox.maxY)/upm, clamped at 0 or above. hasLower: cmap covers a-z. lowerIsCaps: the glyph id for 'a' equals the one for 'A'. hasKerning: GPOS has 'kern' or a kern table exists. features come from font.availableFeatures, filtered to ss01-ss20, cv01-cv99, salt, swsh, dlig, titl, case, smcp, liga, calt. uiName is best effort: GSUB featureList[i].feature.featureParams.uiNameID -> font.name.records.fontFeatures[id].en. createMeasurer(font, facts, variation?) implements Measurer from font.layout(text, features). It scales positions by size/upm, adds tracking*size between glyphs (never after the last one), takes ink from glyph.bbox, and sets missing when glyph.id === 0. changedBy(font, text, tag) returns the char indexes whose glyph id changes with the feature on; a change in glyph count marks the affected cluster as a ligature. pathFor(font, text, {size, tracking, features, variation}) returns SVG path data with y flipped to point down, plus the per-glyph paths (for F9).

4) src/facts/index.ts (browser). getFacts(font, weight, variant='web'): Promise<{facts, measurer} | null>. It runs `await import('fontkit')` on first use (so the module is code-split), parses the bytes lazily, and caches per key in an LRU of 200. Local fonts return null.

5) src/facts/canvas.ts. canvasMeasurer(font, weight) implements Measurer with OffscreenCanvas measureText: actualBoundingBox for ink, 'H' for cap height, 'x' for x-height, ctx.letterSpacing for tracking, and per-glyph boxes by measuring prefixes. exact=false.

6) src/facts/useFacts.ts. useFacts(font, weight, variant) returns facts or null. useMeasurer(font, weight, variant) returns the fontkit measurer when ready, otherwise the canvas measurer once the FontFace is loaded, otherwise null.

7) In dev only, `window.__fx = {facts(id, weight)}` for console checks.

8) server/check-facts.ts (npm run check:facts). Parses every file in server/.cache/fonts with the Node fontkit and core.ts. Prints counts: parsed, with ss sets, caps-only (lowerIsCaps or !hasLower), lacking é, ø or &, and no kerning. Asserts capHeight is in 0.4-1.0 for at least 95% of files, and exits 1 if core.ts throws on a file that fontkit parsed.
FILES: Modify src/fonts.ts. New: src/facts/types.ts, src/facts/core.ts, src/facts/index.ts, src/facts/canvas.ts, src/facts/useFacts.ts, server/check-facts.ts. package.json: add script "check:facts": "tsx server/check-facts.ts". No other file changes; Card and App keep calling ensureFont exactly as before.
ACCEPTANCE:
 - Scrolling the grid makes exactly one network request per font file (Network panel). There is no second fetch for facts.
 - In dev, `await __fx.facts('fontsource:inter', 400)` in the console returns capHeight about 0.73, xHeight about 0.55, hasKerning true, and a features list.
 - `npm run check:facts` parses at least 265 of the 269 cached files, prints the counts, and exits 0.
 - `npm run build` shows fontkit in its own chunk, and the grid's first paint is no slower than before (fontkit loads only when facts are first asked for).
 - `npm run typecheck` and `npm run build` pass.

## F2 Project store, candidate recipes, X/M/S verdicts, key map and extension points  (deps: -; backed by identity designer, typographer, layout specialist, product designer, brand strategist)
VALUE: The shortlist starts remembering how a font was set (weight, case, spacing, alternates, layout), not just its name. The same face can be shortlisted twice in two different ways. A maybe tier stops the shortlist bloating. The app is also restructured so that eight feature agents can work in parallel without fighting over App.tsx.
SPEC: 1) src/recipe.ts. Types and defaults that every later feature implements against:
- `type Formation = 'line'|'stack'|'block'|'lockup'|'mark'`
- `type MatchMode = 'auto'|'cap'|'x'|'width'|'em'`
- `LayoutSettings {formation; match; opticalEdge: boolean; breaks: number[]|null; stack: {align: 'left'|'center'|'right'; justify: 'none'|'track'|'size'; leading: number}; block: {mode: 'cells'|'rows'; cols: number|null; gap: number; rowGap: number|null; lastRow: 'left'|'center'}; lockup: {descriptor: string; position: 'below'|'right'|'above'; align: 'left'|'center'|'right'; size: 'match'|number; textCase: TextCase; tracking: number; gap: number}; mark: {initials: string; construction: 'single'|'pair'|'stacked'}; container: {shape: 'none'|'square'|'rounded'|'circle'|'pill'; style: 'fill'|'keyline'|'guide'; padding: number; auto: boolean}}`
- DEFAULT_LAYOUT: line, auto, opticalEdge true, breaks null; stack {left, none, 0.25}; block {cells, null, 0.18, null, center} (gap is between the letters of a row, in cap heights; rowGap is between rows, in cap heights, and null means the same as gap, so layouts saved before it existed draw as they did); lockup {'', below, left, 'match', upper, 0.12, 0.6}; mark {'', single}; container {none, fill, 1, auto true}.
- `Recipe {text; weight; italic?: boolean; textCase; tracking; features: Record<string,0|1>; axes: Record<string,number>|null; layout: LayoutSettings}`. italic means the family's real italic; absent (recipes saved before it) means upright.
- `Candidate {id (uuid); fontId; recipe; note; addedAt}`
- Helpers: recipeFromSettings(settings), sameRecipe(a, b), recipeLabel(font, recipe) (e.g. 'Satoshi · 500 · UPPER · -0.02em · Stack · ss01').

2) src/settings.ts. Settings gains `layout: LayoutSettings` and `stress: 'off'|'squint'|'small'|'reversed'|'pixel'`. Filters: rename shortlistOnly to candidatesOnly, and add maybeOrBetter: boolean. Add parseName(settings) -> {lines: string[]; flat: string}: apply the case, split on '/' ('\/' is a literal slash), and strip '|' (reserved for two-weight segments later).

3) src/hooks.ts. usePersisted deep-merges nested plain objects, so a saved Settings without `layout` (or with an older layout) picks up defaults field by field.

4) src/store.ts. A ProjectStore React context and provider, plus useStore(). It holds persisted state for the active project: settings, filters, marks v2 `{verdicts: Record<fontId,'cull'|'maybe'>; candidates: Candidate[]}`, vibes, activeVibe, view, pinned `{fontId, recipe} | null`, and lightboxOpen (not persisted). Storage keys are `fx:p:<projectId>:<name>`; the active id lives in `fx:project` (default 'default'). One-time migration: copy the old fx:settings, fx:filters:v2, fx:marks, fx:vibes, fx:active-vibe and fx:view into project 'default'. Culled ids become verdict 'cull'. Shortlist ids become candidates whose recipe comes from the migrated settings. Leave the old keys in place, so nothing is ever lost. Actions: cull(id) (toggles restore), maybe(id) (toggle), toggleCandidate(id, recipe) (adds; removes an existing candidate with sameRecipe), removeCandidate(cid), updateCandidate(cid, patch), pin(fontId, recipe) / unpin(), setFocus(id). Undo is one generic action, `{label, before: Marks, after: Marks}`, capped at 200 entries; ⌘Z reverts and shows a toast. A toast(text, {undo?}) helper is exposed through the context. The remap-on-catalog-change logic moves here from App.tsx, unchanged.

5) src/keymap.ts. KEYMAP is the canonical table: {scope: 'global'|'grid'|'lightbox'|'compare', keys, action, label}[]. It holds the full table listed in architecture_notes, including keys that later features implement. useHotkeys(scope, handlers) works with one window keydown listener. It ignores keys while an input, textarea or select has focus. The active scope is 'lightbox' when lightboxOpen, 'compare' when view === 'compare', and 'grid' otherwise. Global keys: ⌘/Ctrl+Z undo; '?' toggles src/KeyHelp.tsx, an overlay listing KEYMAP grouped by scope, with keys not yet implemented shown greyed out.

6) Focus. focusId lives in the store. mousemove over a card sets the focus, which replaces document.elementFromPoint. X, M and S act on the focused card. Card gets a `focused` prop and a visible `.is-focused` ring. A culled card shows `.is-culled` as today; a maybe card shows a small hollow dot (`.is-maybe`). The star means 'has at least one candidate'.

7) Extension points. (a) src/Wordmark.tsx: extract today's wordmark div from Card. The props contract is final now: `{font; settings; recipe?: Partial<Recipe>; size?: number; box?: {width: number; height?: number}; variant?: 'web'|'full'; className?: string; onLayout?: (r: unknown) => void}`. It keeps today's single-line rendering, plus `fontFeatureSettings` from recipe.features. (b) src/card/Badges.tsx exports `CARD_BADGES: Array<(p: {font; settings; weight}) => ReactNode>`, rendered in Card's meta row after the existing badges. A feature adds its badge by appending one entry. (c) The context exposes `items` (the current filtered, ordered list of {font, number?, reason?}) for the lightbox and navigation.

8) App.tsx slims down. It reads state from the store, registers grid keys through useHotkeys, and passes Card the stable props {font, settings, number, reason, verdict, hasCandidate, focused, onCull, onMaybe, onShortlist, onRestore}. Card must not consume the context directly, so memoisation holds. VibeBar receives shortlist = the families of the candidates, and culled = the cull verdicts. Compare and the exporters temporarily take the candidates' fonts (one per candidate) until F8 and F9 rewrite them.
FILES: New: src/recipe.ts, src/store.ts, src/keymap.ts, src/KeyHelp.tsx, src/Wordmark.tsx, src/card/Badges.tsx. Modify: src/App.tsx (major), src/Card.tsx (Wordmark, Badges, new props, M action), src/settings.ts, src/hooks.ts, src/VibeBar.tsx (marks shape only), src/Compare.tsx and src/exporters.ts (signatures only), src/styles.css (.is-focused, .is-maybe).
ACCEPTANCE:
 - Seed localStorage with old-format fx:marks (2 shortlisted, 3 culled) and fx:settings, then reload. The same fonts show stars and culls, and the old keys still exist.
 - With the mouse over a card, X, M and S work, and ⌘Z undoes each one in reverse order with a toast.
 - S twice on one font with unchanged settings adds and then removes the candidate. Change the weight, press S again, and Compare shows two rows of the same family.
 - The 'Candidates' and 'Maybe+' filter chips narrow the grid correctly.
 - '?' opens the key map overlay.
 - Cards look exactly as before apart from the focus ring and the maybe dot.
 - `npm run typecheck`, `npm run build` and `npm run check` pass.

## F3 Layout engine part 1: fair sizing, no clipping, Line and Stack across the whole grid  (deps: F1, F2; backed by layout specialist, identity designer, typographer, product designer, brand strategist)
VALUE: Every card gets the same cap height or x-height, so no face wins just by being drawn bigger. Long names are never cut off. Pressing 2 sets every font in the grid as a two-line stack with real leading, alignment to the visible letter edge, and flags when lines collide or have to be bent to fit. This is the first half of 'judge the type in the logo's real shape'.
SPEC: 1) src/layout/types.ts. `LayoutInput {lines: string[]; flat: string; descriptor?: string; initials?: string}`. `Run {text; x; y (baseline, px); size (px); tracking (em); weight; features; slot: 'name'|'descriptor'|'initial'; glyphs: {index, char, x, w, inkL, inkR, inkT, inkB, missing}[]}`. `LayoutResult {runs; missing: {x, y, w, h}[]; ink: {x, y, w, h}; box: {w, h}; container?: {shape, x, y, w, h, rx, style, stroke}; fit: string[] (e.g. '+0.04em', 'x1.31'); warnings: ('collision'|'strained'|'scaled')[]; scale: number}`.

2) src/layout/engine.ts. A pure function: layoutFormation(input, layout, measurer, {size, weight, tracking, features, boxWidth}). It dispatches on formation through a FORMATIONS registry; F3 implements line and stack, and block, lockup and mark fall back to line until F4 registers them. It also carries the container hook (none in F3) and a final fit-to-box step.
- Matching: match 'auto' means cap when the displayed name has no lowercase letter, otherwise x. With slider value S: cap gives font size = 0.7*S / capHeight; x gives 0.5*S / xHeight; em gives S; width scales the whole formation so the ink width equals boxWidth minus padding.
- Line: one run. With opticalEdge on, shift it so the first glyph's ink left sits on the padding (x = pad - inkLeft). Round first letters (O C G Q S) may overhang by overshoot*size.
- Stack: lines from input.lines, or from layout.breaks applied to flat. Baseline step = ref*(1 + leading), where ref is the cap height (caps) or x-height at the run size. Lines align left, centre or right by ink edges. Justify 'track' sets per-line extra tracking = (target - natural)/(glyphs - 1), with no trailing space. Justify 'size' scales each line to the widest line's ink width; it never uses scaleX. fit[] gets a per-line '+0.06em' or 'x1.38'.
- 'strained' warning when any line needs more than ±0.1em of tracking or a scale above 1.25.
- 'collision' warning when any glyph box in line n overlaps, horizontally and vertically, a glyph box in line n+1. Only pairs whose x-ranges overlap count.
- Missing glyphs (glyph.missing) go into result.missing as rects the width of the notdef advance, and are excluded from the drawn text runs.
- If the box is wider than boxWidth at the matched size: scale = fit, add the 'scaled' warning.

3) src/layout/breaks.ts. suggestBreaks(flat, measurer|null, lines = 2|3) returns the top 4 splits that leave at least 2 letters per side, ranked by |w1 - w2|/max (ink widths from the measurer, or letter count without one). Multi-word names break at spaces first. 3-line splits are offered when the name has 9 or more letters. A typed '/' always wins.

4) src/layout/grid.ts. columnWidth(layout, settings, flat) replaces colMin in App.tsx. Line: 0.6em × the longest line at the matched size, plus padding, clamped to 240-1400. Stack: the longest line. Block and Mark: a square tile of about 4×S, clamped. Also intrinsicHeight(layout, settings) for `contain-intrinsic-size`, so lazily rendered cards do not make the page jump.

5) src/Wordmark.tsx (rewrite the internals; the props contract stays). Get the measurer from useMeasurer. Compute the layout with useMemo, keyed on faceName|weight|text|layout|size|tracking|features|boxWidth, where boxWidth comes from a shared ResizeObserver hook useWidth(ref) added to hooks.ts. Render `<svg width height viewBox>`. Each run is one `<text>` with font-family stack, font-weight, font-size, letter-spacing, font-feature-settings, fill=currentColor and font-synthesis:none. Missing rects get a red 45-degree hatch pattern. The container (rect with rx, circle, or pill path) is drawn with fill, keyline or dashed-guide styles, using currentColor and the card background for knock-outs. Below the wordmark, a tiny muted caption shows fit[] and warnings ('+0.04em / -0.02em · collision · scaled 82%'), only when non-empty. Call onLayout(result). Run text goes through `effectiveText(font, facts, settings)` from src/coverage.ts. F3 creates that file as a stub returning parseName; F5 fills it in.

6) Name input. Debounce re-layout by 120 ms while typing.

7) src/LayoutControls.tsx, mounted in the top bar after the Case control: a segmented Layout control (Line, Stack, Block, Lockup, Mark) bound to settings.layout.formation, and a 'Match' select (Auto, Cap height, x-height, Width, Font size). A '⚙' button opens a popover rendering FORMATION_CONTROLS[formation] from src/layout/controls/registry.ts. F3 adds StackControls (align, justify none/track/size, leading slider -0.2 to 1, optical edge toggle). Since widened: the slider is labelled 'Line spacing' and runs -0.5 to 1.5; Block has 'Letter gap' and 'Line gap' (-0.3 to 1.0); and a top-bar 'Line spacing' slider edits the same value for Stack, Block and a stacked Lockup (src/layout/controls/spacing.ts). Keys 1-5 set the formation (registered via useHotkeys).

8) src/BreakChips.tsx, shown under the vibe bar when the formation is stack or block and the name has no '/': chips for suggestBreaks, measured with the focused font (or the first loaded one). Clicking a chip sets layout.breaks; [ and ] cycle. Changing the name clears breaks.

9) styles.css. Remove the .wordmark mask-image and nowrap. Changing layout or match never reloads fonts, never reorders the grid, never resets `limit` or scroll. After a change, call scrollIntoView({block: 'nearest'}) on the focused card.

10) server/check-layout.ts (npm run check:layout). Load 10 cached indie fonts with Node fontkit, core.ts and createMeasurer, and assert:
- In a stack with justify track, the two ink widths are equal within 0.5 px.
- With justify size, likewise.
- 'gyp/hdk' in lowercase at leading -0.2 reports a collision, and at 0.6 does not.
- With opticalEdge, the line's ink left equals the padding within 0.5 px.
- At match cap, size*capHeight = 0.7*S within 0.5 px.
FILES: New: src/layout/types.ts, src/layout/engine.ts, src/layout/breaks.ts, src/layout/grid.ts, src/layout/controls/registry.ts, src/layout/controls/StackControls.tsx, src/LayoutControls.tsx, src/BreakChips.tsx, src/coverage.ts (stub), src/layout/layout.css, server/check-layout.ts. Rewrite: src/Wordmark.tsx. Modify: src/hooks.ts (useWidth), src/App.tsx (mount LayoutControls and BreakChips; colMin -> columnWidth; three lines plus the grid style), src/styles.css (remove the mask and nowrap), package.json (script check:layout).
ACCEPTANCE:
 - Name 'polymodal', Match Auto: for 10 random loaded cards, rendered font-size × facts.xHeight is equal within 0.5 px (dev helper __fx.auditSizes() prints them). Switching to UPPER switches to cap-height matching.
 - 'Word/mark' in Stack shows two lines on every card. The leading slider moves every card. Justify Track makes both lines equal width, and the caption shows the per-line tracking.
 - 'UNIQLO' in Stack offers the break chip 'UNI/QLO' first, and ']' cycles the suggestion across the whole grid.
 - No wordmark is faded or clipped. A card that would overflow shows 'scaled N%'.
 - Pressing 1 then 2 re-sets about 120 visible cards in under 150 ms with no new network requests, and the focused card stays on screen.
 - `npm run check:layout`, `npm run typecheck` and `npm run build` pass.

## F6 Keyboard triage and the lightbox: flip in place, pinned reference, blink and overlay  (deps: F2; backed by product designer, identity designer, typographer, layout specialist, brand strategist)
VALUE: Culling 2,000 fonts becomes a one-key rhythm with no mouse aiming. The lightbox keeps the name fixed in one spot while left and right swap the typeface. That turns every flip into a flicker comparison, and against a pinned favourite it shows a few percent of width or the cut of a terminal immediately.
SPEC: 1) src/nav.ts. Pure helpers: nextId, prevId, idAbove and idBelow over the `items` order. The column count comes from getComputedStyle(gridEl).gridTemplateColumns.split(' ').length.

Grid keys (via useHotkeys('grid')): arrow keys move focusId; Home and End jump; then scrollIntoView({block: 'nearest'}). When focus gets within one row of `limit`, raise limit by PAGE. X, M and S apply the verdict, then advance focus to the next item. Compute the next id before the action, because a culled card leaves `items` when Show culled is off. Moving the mouse over a card still moves focus (from F2).

2) src/Lightbox.tsx. Space or Enter on the focused card sets store.lightboxOpen. The lightbox is a fixed full-screen overlay; the grid stays mounted and keeps its scroll position.
- Layout: header (family, source, licence, weight used, verdict state, position 'n / total'). The stage shows two panels (positive left, reversed right; stacked below 900 px), each with <Wordmark box={{width: panelWidth}} size={max(settings.size*2, 120)}> anchored to a fixed baseline and left edge, so flipping never moves the word.
- Under the stage: the name at 16 px in a fake nav line ('Product  Pricing  About'), the first initial as a 16 px and a 32 px favicon, and src/TellingLetters.tsx. That strip shows the name's own letters from the priority list 'a g R G Q y J k M W e t & s' first, then fills from the list up to 9 glyphs, at about 40% of the stage size.
- Keys (scope 'lightbox'): left and right go to the previous or next item in the current filtered list, preloading the next 3 with ensureFont. X, M and S apply the verdict and advance. 1-5 change the layout. Space or Esc closes; the focus becomes the last font viewed, and the grid scrolls it into view. Swaps are instant (no transition).

3) Pinned reference. P (grid or lightbox) pins the focused font with recipeFromSettings(settings) (store.pin); pressing P on the pinned font unpins it.
- src/ReferenceBand.tsx: a slim sticky band under the top bar, above the grid, showing the pinned font's Wordmark in the current layout at card size, its name, and an ✕.
- In the lightbox, B toggles blink: current and reference swap every 500 ms in exactly the same position, pausing while document.hidden. O toggles overlay: the reference is drawn on top in #ff0080 with mix-blend-mode multiply (screen when inverted), at the same matched size and baseline.
- A readout under the stage, 'width +4.2% · cap +0.5% · x-height -3.1%', compares the two LayoutResults (ink widths) and facts (cap height and x-height as em ratios).
- Without a pin, B and O show a hint 'Press P on a font to pin it as the reference'.

4) CSS lives in src/lightbox.css, imported by Lightbox.tsx.
FILES: New: src/nav.ts, src/Lightbox.tsx, src/TellingLetters.tsx, src/ReferenceBand.tsx, src/lightbox.css. Modify: src/App.tsx (mount <Lightbox/> and <ReferenceBand/>, and register the grid arrow, Home, End, Space, P and auto-advance handlers; small, contiguous block).
ACCEPTANCE:
 - Without touching the mouse, arrows plus X and S triage 20 cards. Each verdict moves the ring to the next card, and ⌘Z restores the font.
 - Space opens the lightbox, and right-arrow flips 10 fonts. Two screenshots taken after consecutive flips show the baseline and left ink edge in the same pixel row and column. Preloaded fonts appear without a blank frame.
 - P on font A, right-arrow to font B, then B: the word alternates between A and B in place at about 2 Hz. O shows the magenta overlay, and the percentage readout appears.
 - Esc returns to the grid scrolled to the last font viewed, with that font focused.
 - `npm run typecheck` and `npm run build` pass.

## F10 Projects on disk, a brief, and vibe search that knows the name and stays out of the way  (deps: F2; backed by product designer, brand strategist, identity designer, layout specialist, typographer)
VALUE: Each client and name gets its own workspace, so this week's three logos never mix and a browser reset loses nothing. Claude finally sees the name, case and layout it is choosing type for, plus a one-line brief. Searches run in the background while triage continues, and never yank the grid away.
SPEC: 1) server/projects.ts.
- Routes in server/index.ts: GET /api/projects (list {id, name, updatedAt}), GET /api/projects/:id, PUT /api/projects/:id. The body is a JSON object of at most 2 MB holding the whole project state.
- Files go to server/projects/<id>.json, where id matches ^[a-z0-9-]{1,40}$ (reject anything else with 400). Write to a temp file and rename it into place.
- Add server/projects/ to .gitignore, because it holds client data.

2) src/store.ts sync.
- On project load, fetch the server copy and use it when its updatedAt is newer than the local one.
- After any change, PUT a debounced (1 s) snapshot {name, brief, settings, filters, marks, vibes, activeVibe, pinned, updatedAt}.
- localStorage stays the instant cache. If the server is down, carry on locally and retry on the next change.

3) src/ProjectSwitcher.tsx at the far left of the top bar: the current project name, and a menu with the project list, New project (name plus the wordmark text), Duplicate, Rename and Brief. Switching swaps all project state in place, without a page reload, and clears the undo stack.

4) Brief. One line of text in the project ('what it is, for whom, words to avoid'), editable from the switcher menu and from a small 'Brief' toggle in the VibeBar row.

5) Vibe request.
- types.ts VibeRequest gains `wordmark: {text: string; rendered: string; textCase: TextCase; formation: Formation; descriptor?: string}` and `brief?: string`.
- In server/vibe.ts buildPrompt, add to the USER prompt (not the system prompt, so the prompt cache keeps hitting): a line such as `Wordmark: "UNIQLO" set in capitals as a two-row block (UNI/QLO)` (from a describeFormation helper), plus `Descriptor: ...` and `Brief: ...` when present.
- Add one rule to INSTRUCTIONS: 'Judge each pick on how it sets the given wordmark: its actual letters, the case, and the layout. Avoid caps-only faces for names with lowercase; for stacked or block layouts favour faces whose letters have even widths.' This changes the cached system prompt once.

6) Background searches in src/VibeBar.tsx.
- The input is never disabled. Each submit creates a pending chip with a spinner and an ✕ that aborts the fetch. Several can run at once.
- A finished search becomes a normal chip with an unread dot. It does NOT change activeVibe.
- Errors show as a toast and drop the pending chip.

7) Scroll memory.
- The store keeps {scrollY, limit} per activeVibe id (null means All fonts). Switching chips restores them, replacing App.tsx's unconditional scrollTo(0) and setLimit(PAGE) when activeVibe changes.
- Filter or find changes still reset to the top.

8) Update server/check-vibe.ts so it builds a request with the new fields and prints the user prompt.
FILES: New: server/projects.ts, src/ProjectSwitcher.tsx, src/BriefField.tsx. Modify: server/index.ts (3 routes), server/vibe.ts (prompt lines and one rule), server/check-vibe.ts, src/types.ts (VibeRequest fields), src/VibeBar.tsx (background runs), src/store.ts (server sync, scroll memory), src/App.tsx (mount the switcher; scroll memory instead of the reset), .gitignore.
ACCEPTANCE:
 - Create projects 'Acme' and 'Borealis' with different names and candidates, and switching swaps everything. After restarting `npm run dev` and clearing localStorage, both come back from server/projects/.
 - Start a vibe search while triaging: the grid, scroll and focus do not move. The chip gets a dot when it is done, and two searches can run at the same time.
 - `npm run check` prints a user prompt containing the Wordmark line and the Brief line, while the system prompt stays identical across two different requests.
 - Switching between All fonts and a vibe chip returns to each one's previous scroll position.
 - PUT /api/projects/../x is rejected with 400.
 - `npm run typecheck` and `npm run build` pass.

## F4 Layout engine part 2: Uniqlo-style block, lockup with descriptor, monogram, containers  (deps: F3; backed by layout specialist, identity designer, product designer, brand strategist, typographer)
VALUE: The grid can test the hardest layouts. Pressing 3 shows every face as a Uniqlo-style block of equal square cells with each letter optically centred. A number on each card shows which faces hold the module. Pressing 4 adds a descriptor line tracked out to the name's width. Pressing 5 tests the initial as an app icon at 180, 32 and 16 px. Containers show which faces survive inside a square or a circle.
SPEC: All formations register in FORMATIONS (engine.ts) and return a LayoutResult, so Wordmark (F3), Compare (F8) and Copy SVG (F9) need no changes.

1) src/layout/block.ts.
- Rows come from input.lines, layout.breaks, or an automatic grid with spaces dropped. n letters: 4 -> 2x2, 5 -> 3+2, 6 -> 3x2, 7 -> 4+3, 8 -> 4x2, 9 -> 3x3; otherwise cols = ceil(sqrt(n)). layout.block.cols overrides.
- Mode 'cells' (the default, the real Uniqlo look): measure each letter alone. Cell size = the largest of (ink width, cap height) across the name's letters. Each letter is centred horizontally by its ink box, and vertically on the cap-height band (caps) or x-height band (lowercase), never on the em box. Round letters (O C G Q S o c e) overshoot by facts.overshoot. Gap and padding are in cap heights (gap 0.18 by default). A short last row is centred or left-aligned (block.lastRow).
- fit[] = 'evenness 0.12': the coefficient of variation of the letters' ink widths, where lower means the face holds the module.
- Mode 'rows': each row is one run with kerning kept, justified to the widest row by tracking only (never scaleX), with per-row tracking in fit[].

2) src/layout/container.ts. fitInContainer(result, container, box, measurer).
- Padding p = container.padding × cap height, iterated twice because p depends on the fitted size.
- Square or rounded: s = min((W - 2p)/inkW, (H - 2p)/inkH), with rx 22% for rounded. Circle: scale until the farthest ink-box corner lies within R - p. Pill: check corners against a rectangle plus two half circles.
- Styles: 'fill' (the shape in ink, letters in paper colour), 'keyline' (stroke = the ink width of 'l' or 'I' at the fitted size; serif fonts use 8% of cap height), 'guide' (faint dashed clear-space outline).
- container.auto = true gives Block and Mark a square fill and everything else none.

3) src/layout/lockup.ts.
- The name is set as Line, or as Stack when it contains '/'.
- Descriptor = layout.lockup.descriptor. When empty, use the placeholder 'DESCRIPTOR LINE' at 35% opacity (flag the run).
- Position: below (aligned left, centre or right by ink edge), right (cap-height aligned for caps, baseline otherwise), or above (kicker).
- Size 'match': the descriptor's cap height = 0.28 × the name's cap height, tracked out until its ink width equals the name's, with no trailing space and the extra tracking reported in fit[]. Otherwise size is a ratio from 0.2 to 0.5 of the name's cap height.
- Defaults: descriptor case UPPER, tracking 0.12em, gap 0.6 cap heights, same face and weight.

4) src/layout/mark.ts.
- Initials = layout.mark.initials, or the first letters of each word or '/' segment, or the first two letters of a single word.
- Constructions: single (the first initial); pair (the second letter's ink left = the first letter's ink right + 0.04em); stacked (the pair stacked, centred, with cap-height leading 0.15).
- Mark cards also render a mini row of the same mark at 32 px and 16 px tall, as real text at real sizes so browser rendering is honest. F3's Wordmark gets this from an `extras: 'markSizes'` flag set by the engine on the result; implement the mini row inside mark.ts's result as extra runs at fixed sizes positioned under the tile.

5) Controls. src/layout/controls/BlockControls.tsx (mode, columns, gap, last row), LockupControls.tsx (descriptor text field, position, align, size match or ratio, case, tracking, gap), MarkControls.tsx (initials override, construction) and ContainerControls.tsx (shape, style, padding, auto; shown for every formation). Register each with one line in registry.ts.

6) Extend server/check-layout.ts:
- 'UNIQLO' in cells gives 3x2 with every letter's ink centre within 0.5 px of its cell centre horizontally.
- A circle container keeps all ink-box corners inside R - p.
- A lockup in match mode gives a descriptor ink width equal to the name's within 0.5 px.
- Rows mode gives equal row widths within 0.5 px.
FILES: New: src/layout/block.ts, src/layout/lockup.ts, src/layout/mark.ts, src/layout/container.ts, src/layout/controls/BlockControls.tsx, src/layout/controls/LockupControls.tsx, src/layout/controls/MarkControls.tsx, src/layout/controls/ContainerControls.tsx. Modify: src/layout/engine.ts (register the three formations and call fitInContainer; replace the F3 stubs), src/layout/controls/registry.ts (4 lines), src/layout/grid.ts (tile sizes if needed), server/check-layout.ts (new cases).
ACCEPTANCE:
 - 'UNIQLO' plus key 3 shows every card as a 3x2 block in a filled square. A geometric caps face shows a lower evenness number than a humanist sans, and the number is visible on each card.
 - 'UNI/QLO' forces 2 rows of 3, and Rows mode justifies them by tracking only.
 - Key 4 with descriptor 'CLOTHING' shows a tracked-out line exactly the name's width on every card. Switching position to 'right' aligns it to the cap height.
 - Key 5 shows the initial (or the pair) in a square tile with 32 px and 16 px renders under it.
 - Setting the container to circle visibly shrinks wide one-line names, and nothing clips.
 - `npm run check:layout`, `npm run typecheck` and `npm run build` pass.

## F5 Honest glyphs: show missing letters, handle caps-only faces, filter for logo-safe licences  (deps: F1, F2, F3; backed by identity designer, typographer, layout specialist, product designer, brand strategist)
VALUE: The tool stops lying. A font without é, & or Ł no longer quietly borrows the letter from the system sans: the gap shows, and a badge names it. Caps-only display faces stay in the running instead of looking broken. Fonts whose licence is unknown can be hidden before you fall for one.
SPEC: 1) src/coverage.ts (fill in F3's stub). effectiveText(font, facts, settings) returns parseName(settings). Exception: when facts.hasLower is false and the displayed text contains lowercase, it returns the uppercased lines and sets the flag shownInCaps. missingChars(facts, text) returns the distinct characters (not spaces) the font cannot set.

2) src/card/CoverageBadge.tsx, registered with one line in CARD_BADGES.
- 'no é' or 'missing & Ł' for up to 3 characters, then '+N', with a title listing them all.
- 'caps only · shown in caps' when shownInCaps; 'caps only' when lowerIsCaps.
- An amber 'check licence' badge for license 'Local-unknown', with the title 'Installed font of unknown origin: check its licence allows a logo before using it'.
The hatched placeholders themselves are drawn by F3's engine from glyph.missing.

3) Fontsource latin-ext.
- When the displayed text contains characters above U+00FF, ensureFontExt(font, weight) in fonts.ts loads `https://cdn.jsdelivr.net/fontsource/fonts/<ref>@latest/latin-ext-<weight>-normal.woff2` as a second FontFace under the same family name. Its unicodeRange is the standard Google latin-ext range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF. Also parse its bytes.
- facts/index.ts exposes coverage as the union of both files' cmaps.
- Measurement rule: the fontkit measurer is used only when the primary file covers every character of a run; otherwise the canvas measurer is used, since canvas sees both FontFaces.
- A 404 means the family has no latin-ext, so those characters really are missing.

4) Installed fonts (no facts). For each distinct character, compare canvas widths with `"<family>", monospace` and `"<family>", serif`. If they differ, the character is missing. Cache the result per family and character. The canvas measurer reports these as missing.

5) Add `font-synthesis: none` to every wordmark render (styles.css, plus SVG text from F3), so no fake bold or italic is ever shown.

6) Filters.logoSafe in settings.ts, with a 'Logo-safe licence' chip in App's filter row. passes() keeps licences OFL, Apache, UFL and 'ITF free' and drops everything else, including Local-unknown. The count updates.

7) There is no 'Sets my name' hide filter yet. It would make cards vanish as fonts load; it comes with the catalogue-wide index later.
FILES: Modify: src/coverage.ts (replace the stub), src/fonts.ts (ensureFontExt plus the LATIN_EXT_RANGE constant), src/facts/index.ts (union coverage; measurer choice per run), src/settings.ts (Filters.logoSafe), src/App.tsx (one chip and one passes() clause), src/styles.css (font-synthesis). New: src/card/CoverageBadge.tsx (plus one line in src/card/Badges.tsx).
ACCEPTANCE:
 - Name 'Café & Øre': a cached indie font that check:facts lists as lacking é shows hatched boxes in those positions and a 'missing é' badge. Fonts that have the letters show none.
 - Name 'Łódź' on Inter (Google, with latin-ext) draws Ł and ź in Inter with no hatch. A Fontsource family with no latin-ext file shows hatches and a badge.
 - A caps-only display face with the name 'Polymodal' shows 'POLYMODAL' and the badge 'caps only · shown in caps'.
 - The Logo-safe chip hides installed fonts and any non-libre licence, and the shown count drops accordingly.
 - `npm run typecheck` and `npm run build` pass.

## F8 Compare as a candidate matrix, with per-candidate tuning, a letter lineup and stress views  (deps: F2, F3; backed by layout specialist, identity designer, typographer, product designer, brand strategist)
VALUE: The finalists get judged the way an identity actually lives: each candidate recipe in every layout and at every small size, side by side. Each one can be tuned to its best (weight, spacing, case) without disturbing the fair grid. Near-twins are settled by lining up the letter that decides it. One key stress-tests the whole grid early.
SPEC: 1) src/Compare.tsx (rewrite). Rows are the candidates, in order.
- Row header: recipeLabel, source, licence, a note field (click to edit, saved to candidate.note), Remove, and 'Apply recipe to grid', which copies the recipe's weight, textCase, tracking, layout and text into settings.
- Columns, each a <Wordmark> using that candidate's recipe in a fixed box:
  1. Own layout, large (highlighted, about 520×220).
  2. Line, Stack, Block in a square, Lockup, each about 220×140.
  3. Mark at 64, 32 and 16 px.
  4. Avatar: Mark in a circle container at 40 px.
  5. Nav: the name at 16 px beside 'Product Pricing About'.
  6. Squint: the own layout blurred by 6% of its cap height.
  7. Reversed: the own layout on the dark ground.
- The row scrolls horizontally on narrow screens. Formations not yet implemented fall back to Line automatically.

2) src/CandidateTuner.tsx: an expand toggle under each row.
- Weight strip: the wordmark in every weight in font.weights, stacked; click one to set recipe.weight.
- Tracking ladder: current -0.04, -0.02, 0, +0.02 and +0.06 em; click one to set it.
- Case toggle, a layout select, and kerning on/off (font-kerning; applied by Wordmark through recipe.features.kern = 0).
- An empty 'Alternates' slot that F7 fills in.
- Every edit calls store.updateCandidate and can be undone with ⌘Z. The grid's settings never change.

3) src/LetterLineup.tsx.
- Clicking a letter in any candidate's large wordmark (hit-test the click against LayoutResult glyph boxes from onLayout) opens a strip at the top of Compare. It shows that letter from every candidate at about 240 px, at equal cap height, on one shared baseline, with the family name under each and an ✕ to remove that candidate.
- When a candidate has features on, the default glyph is shown next to the alternate one.
- Esc closes the strip.

4) src/StressView.tsx wraps the grid wordmark (Card renders `<StressView mode={settings.stress}><Wordmark .../></StressView>`, a one-line edit).
- squint: CSS filter blur of 6% of the matched cap height.
- small: the same layout rendered at 24, 16 and 12 px tall in one row inside the card.
- reversed: the card's colours swapped.
- pixel: the layout drawn with canvas fillText (runs from onLayout) at 16 px tall, shown scaled ×4 with image-rendering: pixelated. Only cards in view (useInView) draw it.
- V (grid scope) cycles off -> squint -> small -> reversed -> pixel. A chip in the filter row shows the active mode, and clicking it turns stress off. X, M and S keep working in every mode.

5) CSS goes in src/compare.css.
FILES: Rewrite: src/Compare.tsx. New: src/CandidateTuner.tsx, src/LetterLineup.tsx, src/StressView.tsx, src/compare.css. Modify: src/Card.tsx (wrap Wordmark in StressView, one line), src/App.tsx (register the V handler and the stress chip; small).
ACCEPTANCE:
 - Shortlisting one family at weights 400 and 700 shows two Compare rows labelled with their recipes.
 - Clicking +0.02 on one row's tracking ladder changes only that row, and ⌘Z reverts it. The grid is unchanged.
 - Every row shows every layout column. A wide one-line name is visibly small in the avatar circle.
 - Clicking the 'a' in a row's large wordmark shows every candidate's 'a' on one baseline at equal cap height.
 - V cycles the grid through the stress views, X and S still work in each, and pixel mode is hard-edged.
 - 'Apply recipe to grid' sets the top-bar controls to that candidate's values.
 - `npm run typecheck` and `npm run build` pass.

## F7 Alternates that touch the name  (deps: F1, F6, F8; backed by identity designer, typographer, layout specialist, product designer, brand strategist)
VALUE: Often the right face is the one with its single-storey a or straight-tailed y switched on, and today those letters are invisible. The grid now flags exactly which letters of this name a font can swap. The lightbox and Compare let you cycle through them and save the choice into the recipe. That roughly doubles the real options without adding a single font.
SPEC: 1) src/alternates.ts. relevantAlternates(font, facts, text) runs changedBy for each tag matching ss\d\d|cv\d\d|salt|swsh|dlig|titl and keeps tags with at least one changed character. It drops a set when its output glyphs are enclosed or circled forms: glyph names matching /circled|squared|enclosed|negative|boxed/, or outputs mapping to U+2460-24FF or U+1F100-1F1FF. It returns {tag, uiName?, letters: string, indexes}[]. It also reports default substitutions that change the name (a liga or calt cluster change), shown as 'fi ligature on'.

2) src/card/AltChip.tsx, registered with one line in CARD_BADGES: 'Alt a g t' (the unique changed letters, in name order), shown only when at least one set qualifies. Its title lists each set as 'ss01 Alternate a: a' (using uiName when present). It works in the grid for Fontshare, indie and local-with-facts fonts, because their loaded files keep their features. Google web subsets strip them, so Google cards show no chip until the full file is loaded.

3) Google full files: server/googleFiles.ts and GET /api/google-files?family=.
- slug = the family lowercased with non-alphanumerics removed. Try https://raw.githubusercontent.com/google/fonts/main/{ofl|apache|ufl}/<slug>/METADATA.pb in turn.
- Parse its `fonts { name style weight filename }` blocks and its `axes { tag min_value max_value }` blocks.
- Return {files: [{weight, style, filename, url}], axes}. url-encode brackets (SpaceGrotesk%5Bwght%5D.ttf).
- Cache found and not-found results in server/.cache/google-files.json.
- The files load through the existing /api/font proxy; raw.githubusercontent.com is already allowed and the 10 MB cap covers them.
- Register the route with one line in server/index.ts.

4) fonts.ts variant 'full'. For Fontsource fonts, fontUrl(f, w, 'full') resolves through /api/google-files (cached per family in memory). Prefer the static upright file nearest the weight; otherwise use the variable file, loaded with a FontFace weight descriptor of `${min} ${max}`. facts/index.ts uses font.getVariation({wght: weight}) for variable full files, for both measuring and paths. For Fontshare and indie fonts, 'full' is the same file as 'web'. The 'full' variant is only ever requested by the lightbox and Compare, one font at a time, and never by the grid.

5) src/AltPicker.tsx. One small wordmark per relevant set, with the changed letters tinted in the accent colour, plus 'Default' and 'All'. Click one to choose it. It shows 'Loading full font…' while the full file loads.

6) Lightbox (F6): mount AltPicker under the stage. The A key cycles default -> each set -> all sets combined. The choice applies to the stage Wordmark (recipe.features, with variant 'full' for Google), and S saves the candidate with those features.

7) CandidateTuner (F8): mount AltPicker in its Alternates slot. Changes go through updateCandidate (undoable).

8) Wherever a candidate renders (Compare, the reference band, exports), recipe.features apply, using variant 'full' when the font is a Google family and features are not empty.
FILES: New: server/googleFiles.ts, src/alternates.ts, src/card/AltChip.tsx, src/AltPicker.tsx. Modify: server/index.ts (one route), src/fonts.ts (resolve 'full' URLs), src/facts/index.ts (variation for variable full files), src/card/Badges.tsx (one line), src/Lightbox.tsx (mount AltPicker and the A handler), src/CandidateTuner.tsx (mount AltPicker), src/Compare.tsx (pass variant 'full' when features are set; one line).
ACCEPTANCE:
 - Name 'Rigatoni': the Satoshi card (Fontshare) shows 'Alt a g t'. Name 'Polymodal': several indie cards show an Alt chip, and fonts without relevant sets show none.
 - `curl 'http://127.0.0.1:8787/api/google-files?family=Space%20Grotesk'` returns a SpaceGrotesk%5Bwght%5D.ttf URL.
 - Opening Inter in the lightbox with name 'Polymodal' makes exactly one /api/font request for Inter's full file and lists only the sets that change its letters. Sets that turn letters into circled or boxed symbols are not offered.
 - A cycles the alternates in place. S saves, and the Compare row and the reference band render with the alternate.
 - `npm run typecheck` and `npm run build` pass.

## F9 Copy as outlines for Figma, and exports that carry the recipe  (deps: F1, F3, F8; backed by identity designer, typographer, layout specialist, product designer, brand strategist)
VALUE: The search ends where the drawing starts. One key puts the exact wordmark, in the exact layout, spacing and alternates, on the clipboard as vector outlines that paste straight into Figma, with no font installs and no retyping. The sheets and the JSON carry every recipe and licence, so the decision travels intact.
SPEC: 1) src/export/outline.ts. layoutToSvg(font, weight, variant, result: LayoutResult, recipe) returns an SVG string.
- Get the fontkit font from facts/index.ts (variant 'full' when recipe.features are set on a Google family).
- For each run, call pathFor(run.text, {size: run.size, tracking: run.tracking, features: run.features, variation}) and translate it to run.x, run.y.
- Emit one `<path id="<char>">` per glyph inside `<g id="<name> - <family> <weight>">`.
- Missing characters are omitted, with a warning.
- Containers become `<rect rx>`, `<circle>` or a pill path. A filled container draws the shape in ink and the letters in the paper colour.
- The root is `<svg xmlns viewBox width height>`. Its `<desc>` holds the spec: family, source, licence, homepage, the font file URL used, weight, case, tracking in em, features, and layout settings in type units (e.g. 'stack, leading 0.25 cap, justify track').
- Units are px at the rendered size.

2) Copy.
- ⌘C or Ctrl+C on the focused grid card uses recipeFromSettings. In the lightbox it uses the current font plus its chosen alternates. A 'Copy SVG' button on each Compare row uses that candidate's recipe.
- All of them call navigator.clipboard.writeText(svg) and toast 'Copied outlines. Paste into Figma.'
- Never intercept ⌘C while text is selected or an input has focus.
- Installed fonts with no facts get the toast 'Outlines need the font file; installed fonts can't be read yet.'
- Also add a 'Download SVG' item, as a fallback in case pasting fails.

3) src/export/sheets.ts and src/exporters.ts (rewrite).
- exportJson(candidates): each candidate with its full recipe, label, licence, homepage, file URL, note and reason.
- exportSvgSheet(candidates): every candidate as outlines in its own layout, stacked with a muted label line, in one SVG file.
- exportPngSheet(candidates): render the SVG sheet through an Image with a data URL onto a 2× canvas. Outlines need no fonts, which avoids canvas's lack of OpenType feature and axis support.
- Labels print the licence, in amber for Local-unknown.
- In App's top bar, an Export menu (JSON, SVG sheet, PNG sheet) replaces the two buttons.

4) Extend server/check-layout.ts: run layoutToSvg on 5 cached fonts in Line, Stack and Block. Assert the output starts with '<svg', contains one <path> per drawn glyph, and that its viewBox equals result.box within 0.5 px.
FILES: New: src/export/outline.ts, src/export/sheets.ts. Rewrite: src/exporters.ts. Modify: src/App.tsx (Export menu and the grid ⌘C handler; small), src/Lightbox.tsx (⌘C handler), src/Compare.tsx (Copy SVG button), server/check-layout.ts (SVG cases).
ACCEPTANCE:
 - Copy SVG on a 56 px card and paste it into Figma: vector paths appear. Laid over a screenshot of the card at the same scale, the edges differ by less than 1 px.
 - A Stack, a Block in a filled square and a Lockup each paste with the same geometry as their cards.
 - With F7 present, a candidate saved with ss01 pastes with the alternate glyphs.
 - The SVG sheet opens in Chrome and Figma. The PNG sheet shows each candidate in its own layout, not a single line.
 - The exported JSON lists each candidate's recipe in type units (em, cap heights).
 - `npm run check:layout`, `npm run typecheck` and `npm run build` pass.

# LATER
- Shape index for the whole catalogue: instant 'more like this, but wider / taller x-height / less contrast', sorts by width and by best block fit, and a 'Sets my name' hide filter that works before fonts load : It needs one regular file from each of about 2,000 families measured once on the server (`npm run measure`, reusing src/facts/core.ts with the Node fontkit build and the proxy's per-host limits). That is L effort and network-heavy. Every grid feature in this round works on loaded fonts first, and the index slots in without changing their interfaces.
- Variable axes: continuous weight, a width sweep, optical size, and custom axes (SOFT, WONK) in the candidate tuner : The grid loads static per-weight files. Only about 570 Google families have Fontsource variable files, catalog.ts skips Fontshare's variable styles, and 7 of the roughly 375 cached indie files are variable. Recipe.axes is already reserved, and the full-file plumbing from F7 is the base for it.
- Two-weight and two-case segments ('Poly|modal': Poly in bold, modal in light) with a 'has the range' filter : It builds on the layout engine and an extra run type. The '|' syntax is reserved and stripped now, so typing it early is harmless.
- A partner face for the descriptor, and a 'vary name or descriptor' scan : Pairing is a second-stage problem. The lockup first has to work in the name's own face.
- Brief to named directions (3 or 4 routes as separate result chips), and 'like Söhne, but libre' references re-ranked by measured shape : Sending the name, layout and brief to Claude (F10) comes first. Directions and commercial-reference lookups get much better once the shape index can check Claude's claims.
- Seen tracking: an 'Unseen only' pass and a 'mark this screen seen' key : A strong speed lever for a second session, but triage, focus and projects have to exist first.
- Fold superfamilies and duplicates into one card (Barlow plus Condensed and Semi Condensed, Bitcount ×12, Anek ×10, SC siblings) : It needs family-root grouping rules and a way to expand groups in the lightbox. The value is clear, but it is not on the critical path.
- Test strings per project (name, initials, sub-brand) cycled by one key : The Lockup and Mark layouts already cover the descriptor and the initials. Full test-string cycling can wait for projects to settle.
- Telling-letters strip under every grid card (T) : The lightbox already shows it and the Compare lineup covers the decision. Adding it to the grid costs card density.
- Spacing inspector with flagged letter pairs, a 'no kerning' badge, and opt-in display spacing that shows its own correction : Large effort that drifts towards kerning, which is Figma's job. The tracking ladder covers the honest part now, and facts.hasKerning is already computed for an easy badge later.
- Weight matched by measured darkness ('Regular reads as Medium') : It needs a stem-thickness measurement and a decision about how the global weight control behaves.
- Letter-structure filters (single-storey a, binocular g, straight-legged R, spur on the G) : It needs glyphs rasterised and their enclosed holes counted across the catalogue, so it belongs with the shape index.
- Facts for installed fonts via queryLocalFonts FontData.blob() : The permission and re-query flow needs care. Installed fonts fall back to canvas measuring meanwhile, with no outlines.
- Real small caps, titling and case-sensitive forms as case options : Niche for choosing a wordmark face. Web subsets strip them, so it rides on the full-file path from F7.

# CUT
- Brand colours, accent fills and photo backgrounds on cards : Colour flatters weak letterforms and slows the cull. Four of the five perspectives cut it, and the strategist withdrew it. Ink, paper and invert are enough to judge type.
- Context mockup gallery (business card, shop sign with a distance slider, photo, website header) and print-gain or embroidery simulation : Scenes flatter every font about equally. The tests that actually rule fonts out (tiny, square, circle, reversed, squint) are now Compare columns and the grid stress views.
- Competitor lineup set in Claude's guess of each competitor's typeface : It stacks two guesses (which face a brand uses, then the nearest catalogue font) and shows the result as if it were fact.
- Claude shortlist crit, 'explain the difference', lookalike verdicts and 'your taste so far' : Claude runs without vision and writes about letterforms it cannot see. The letter lineup, blink and overlay show the real differences on the real name. Claude stays in suggestion, with better context.
- Client presentation page and direction boards : The logo gets presented after it is drawn in Figma. Copy SVG, the SVG and PNG sheets and the JSON recipes cover the handoff.
- Merge-sort playoff ranking of finalists : Wordmark type ends with 3 to 5 finalists. Blinking against a pinned reference settles near-twins without 25 forced choices.
- Three-level rating ladder with a reject-reason picker : Bookkeeping. X, M and S (cull, maybe, candidate) give the narrowing tier most perspectives asked for at one key per verdict.
- Automatic per-font display spacing in the grid : It hides each face's own spacing, which is evidence of how much hand work the face needs, and an imperfect gap measurement makes the grid quietly unfair. The per-candidate tracking ladder replaces it.
- Global width-axis control in the top bar : Only about 97 families have a width axis, so it would break the rule that only the typeface differs between cards.
- Shape-filter histogram sliders as the interface : Designers navigate by reference ('like this, but wider'). When the measurements arrive they become sorts and one-click nudges, not a fifth row of controls.
- Overlapping, knocked-out monogram construction : That is drawing a mark, not choosing type. The Mark layout keeps a single initial, a touching pair and a stacked pair.
- Per-card settings panels, or alternate combinations expanded as extra grid cards : The grid stays one card per font and one key per decision. Tuning belongs to the lightbox and Compare.
- Stretching glyphs (scaleX), synthetic bold or italic, and fake small caps : They distort the very face being judged. Lines are justified only by tracking or by scaling the whole line, and font-synthesis is off everywhere.

# RISKS
- fontkit in the browser is the foundation bet. I checked that Vite bundles fontkit's browser build to about 357 KB and that it parses all 269 cached files from a Uint8Array in 90 ms in Node, but not yet in Chrome itself. F1 must keep fontkit code-split and pass FontFace a copy of the bytes (buf.slice(0)) so the buffer fontkit reads is never detached. If parsing on the main thread janks while scrolling fast, move the parsing into a Web Worker behind the same getFacts interface.
- Cards render with the browser's own text shaping, while exports use fontkit's positions. Any difference between the two shows up as a mismatch between the card and the pasted SVG. F9's overlay acceptance check catches it. If drift appears, Wordmark can draw fontkit paths for large sizes and keep real text only for the 16-32 px tests.
- The F2 store migration touches the user's only copy of his shortlist and culls. It must copy the old keys and never delete them. Test it with seeded localStorage before anything else lands.
- Google full-file lookup guesses the folder name (family lowercased, punctuation removed, in ofl, apache or ufl). Some families are renamed or live elsewhere, and some files are big variable TTFs. A failed lookup must quietly show 'alternates unavailable', never break the lightbox. Variable full files need a FontFace weight range and getVariation, or the alternates will render at the wrong weight.
- Fontsource's web files strip stylistic sets and latin-ext letters. Until the catalogue index exists, Google cards show no Alt chip in the grid, which can make Google look poorer in alternates than it is. The lightbox and Compare close that gap one font at a time.
- Wave-2 and wave-3 agents all add lines to App.tsx and package.json. The mount-only rule keeps the edits small, but merges still need a human-sized look. Run wave 1 to completion before starting wave 2.
- Performance: up to 120 SVG cards, each laid out with fontkit on every name change, plus pixel-mode canvases. Mitigations are memoising the layout per font, debouncing typing to 120 ms, and drawing canvases only for cards in view. Verify with F3's 150 ms acceptance check on a real catalogue page.
- The collision and evenness readouts work from glyph bounding boxes, not exact outlines. They can flag a 'collision' where the ink doesn't actually touch (a descender beside an ascender). Label them as advice, and only test glyph pairs whose horizontal ranges overlap.
- Figma accepting pasted SVG markup as vectors is widely relied on but has not been checked on Wouter's Figma build. The 'Download SVG' fallback in F9 covers it if pasting fails.
- Showing caps-only fonts in caps means those cards differ from the rest in one more way than the typeface. That is labelled, but if it confuses the cull, switch to badge-only through the coverage.ts flag.
- Projects in server/projects/ hold client names and briefs. They are gitignored, but the font-explorer folder is still untracked and has no experiments/<slug>/experiment.json manifest. Both need settling before any PR.
