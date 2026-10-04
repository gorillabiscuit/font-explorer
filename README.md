# Font Explorer

Local tool for picking wordmark fonts. One grid across:

- **Independent foundries**: Velvetyne, Collletttivo and Tunera (experimental libre type, all OFL).
- **Use & Modify**: Raphaël Bastide's hand-picked list of libre fonts (logo-safe licences only).
- **Fontshare**: ITF's free collection.
- **Google Fonts** via Fontsource (minus Noto and Playwrite, which are no use for a Latin wordmark).
- **Your installed fonts** (Chrome only).

Claude-powered "vibe search" picks from all of it, steering away from the most common fonts.

## Run

```bash
npm install
npm run dev            # web on http://localhost:5173, API on :8787
```

Vibe search runs through Claude Code (`claude -p`) on your Claude subscription, so there is no API
key. Claude Code has to be signed in: run `claude auth login` once. If that login keeps expiring,
run `claude setup-token` instead, copy `.env.example` to `.env`, and paste the token there.

Open http://localhost:5173 in Chrome. "Load local fonts" only works in Chromium browsers.

## Use

- **How it works** (top right, next to **?**) walks through the whole loop in seven steps. It opens by
  itself on a browser's first visit (remembered as `fx:how-it-works` in localStorage). Its keys are
  drawn from the key map, and `npm run check:help` fails if its text and the key map ever disagree.
- Hover a card (it gets a blue ring) and press **X** to cull, **M** for maybe, **S** to save the current
  settings as a candidate. A candidate is the exact recipe (weight, italic, case, spacing, layout), so
  one family can be saved twice in two ways; **S** again with the same settings removes it.
  **Cmd/Ctrl+Z** undoes. **?** lists every key.
- Type **/** in the name for a line break (**\/** for a real slash).
- **Italic** (the top-bar switch, or **I** in the grid and the lightbox) draws each family's own italic,
  at its nearest italic weight. A family without one stays upright with a **no italic** badge: nothing
  is ever slanted to fake one. The **Has italic** filter chip, shown while Italic is on, hides those.
  Installed fonts ask for their installed italic and get no badge, since whether one is installed is unknown.
- **Line spacing** (top bar, shown for Stack, Block and a Lockup whose name has a **/**) sets the gap
  between lines: in cap heights for an all-caps name, x-heights otherwise; Block's rows always count in
  cap heights. Below 0 lines overlap, and a card says when letters collide. Double-click resets it. The
  layout's ⚙ has the same slider, and Block's own Letter gap.
- Alternates: a card's **Alt a g** chip names the letters of your name that the face's stylistic sets
  change. Choose between them in the lightbox (click one under the stage, or press **A** to cycle) or
  in a Compare row's tuning; **S** then saves the recipe with them. Google cards only show the chip once
  that font's full file has been opened, because Google's web files leave the sets out.
- Vibe search sends Claude the catalog (family, category, tags with their strength, measured shape,
  whether it has an italic), the name as you have set it (case and layout), the project's one-line
  brief, the Italic switch, your 12 newest candidates (only to break ties: the request comes first),
  and recently culled fonts as negatives. Follow-ups like "more like #3 but wider" use the card numbers. Searches run in the
  background: keep triaging, and each one arrives as a chip with a dot. Several can run at once, and
  the ✕ on a running chip cancels it.
- Compare shows each candidate large and at 16px, positive and inverted. Export gives JSON (with each
  recipe) and a PNG contact sheet.
- **Seal** (next to Black on white) previews every name as a red Japanese seal: vermilion on warm
  paper, through a worn print (rough edges, uneven ink, a few specks). Block and Mark's filled square
  becomes the red block with the letters cut out. It is a way of looking, like White on black: copied
  SVGs and exports stay black on white.
- Projects (the menu at the far left): one per client and name, each with its own settings, verdicts,
  candidates, vibe searches and brief. Each is saved in the browser (`fx:p:<project>:*` keys) and on
  disk in `server/projects/<id>.json`, so clearing the browser loses nothing; when a project opens, the
  newer copy wins. Those files hold client names and briefs, so the folder is gitignored. The first
  run copies the older single-list keys (`fx:marks`, `fx:settings` and the rest) into project
  "default" and leaves the originals in place.

## Indie sources

Their catalogs are read once and saved in `server/data/<source>.json`, so the app starts instantly
and the small foundries' sites are not hit every day. To refresh them:

```bash
npm run sources                 # all four
npm run sources -- tunera       # just one
```

Builders live in `server/sources/`. They never touch velvetyne.fr (its robots.txt opts out of AI
agents), read Tunera's homepage at most once per run, and space Use & Modify requests out and cache
them. Font files for these sources go through the local server (`/api/font`), which fetches each
file once and keeps it in `server/.cache/fonts/`.

When one family exists in several sources, the foundry's own release wins and the others hand over
their tags. If the row that wins has no italic and another source's has one, it borrows that italic
(see Notes).

## Online version

The same app is published at https://www.wouterschreuders.com/fonts as plain files, with no server
behind it. Everything that needs the local server is missing there: no vibe search, and no project
files on disk (projects live only in each visitor's own browser). The indie foundries' font files
are copied into the build and served from the site itself; Google and Fontshare files load from their
own CDNs, as they do locally.

Build it:

```bash
npm run build:static
```

This type-checks, builds the page for `/fonts/` into `dist-static/`, then runs
`server/export-static.ts`, which writes `dist-static/catalog.json` and copies every indie font file into
`dist-static/files/`. The copies come from the local font cache (`server/.cache/fonts/`); any file not
there yet is fetched once, slowly (Use & Modify 0.6 s apart, GitLab and Codeberg 1 s apart), and
kept in the cache, so a rebuild downloads no font file again. (Like the local server, it refreshes
the Google and Fontshare lists once a day.) It ends with totals. A file that cannot
be fetched, or is not a font, is left out with its weight and listed under "left out"; a clean build
says "nothing left out".

The export will not write a catalog that is missing a part. It stops when the Fontsource, Fontshare
or Google lists did not all arrive and there is no saved copy, and when a source has far fewer fonts
(or fonts with italics) than at the last build, which is what a lost list or a host that was down
looks like. It then writes no `catalog.json`, so there is nothing to publish. If a source really did
remove fonts, run `EXPORT_ACCEPT_SMALLER=1 npm run build:static`.

Try it before publishing with any static server that serves `dist-static` under `/fonts/`, because
every link in the build starts with `/fonts/`. For example:

```bash
mkdir -p /tmp/fx-site && ln -sfn "$PWD/dist-static" /tmp/fx-site/fonts
python3 -m http.server 4173 -d /tmp/fx-site
```

Then open http://localhost:4173/fonts/. The grid should fill, and indie cards should draw their own
faces.

Publish it (needs the AWS CLI, logged in to the account that owns the site):

```bash
npm run deploy:site -- --dryrun   # lists what would be uploaded or deleted; changes nothing
npm run deploy:site               # asks once, uploads, then refreshes CloudFront (a minute or two)
```

`scripts/deploy-site.sh` only ever writes under `fonts/` in the site's bucket, so the rest of the site
is never touched. It uploads the font files and the page's scripts first and the page itself last, so
nobody is served a page whose files are not up yet.

Before it uploads anything, it copies `dist-static/` and publishes from that copy, so a rebuild
started meanwhile cannot mix two builds. It checks that every script the page loads and every font
file the catalog names is in the copy, and refuses if one is missing: online, a missing file would
quietly come back as the portfolio's page. A real publish asks "Publish ...? [y/N]" first. Where
nothing can answer (run from a script), add `-- --yes`. Writing the flag without the `--`
(`npm run deploy:site --dryrun`) still makes a dry run.

## Notes

- Model: `VIBE_MODEL` in `server/vibe.ts` (default `claude-sonnet-5-5` at low effort, falling back to
  Haiku 4.5 when Sonnet is overloaded), or set `VIBE_MODEL`, `VIBE_EFFORT` and `VIBE_FALLBACK_MODEL` in
  `.env`.
- Each search is one `claude -p` run with no tools, in safe mode (no CLAUDE.md, hooks, plugins or MCP
  servers), at low effort (Sonnet 5.5 cannot switch thinking off; on Haiku, thinking is off, because it
  made searches 5-7x slower), started from the temp folder, with no Claude Code session saved. The prompt (catalog plus
  your installed-font list) is passed as a file in `$TMPDIR/font-explorer/`.
- The run gets a clean environment: every `ANTHROPIC_*`/`CLAUDE*` variable is removed except
  `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`, so no API key in the environment can switch it to
  API billing. Claude Code can also hold an API key in its own config (an `apiKeyHelper`, or a Console
  login); if you never set one up, it uses your subscription.
- The catalog is cached for 24h, on the server (`server/.cache/`) and in the browser. The ↻ button refetches.
- Mood tags ("Futuristic 89", "Techno 100") come from Google's tag file in the google/fonts repository,
  with their strength out of 100. Many variable families (Exo 2, Saira) are rated only per weight; those
  ratings are averaged. A few families Fontsource still lists under a retired name borrow the new name's
  tags (`RENAMED` in `server/catalog.ts`). fonts.google.com/metadata/fonts has popularity but no tags.
- What vibe search sends Claude about each family, besides its tags (`server/traits.ts`):
  - Shape, measured from the outlines of its regular style by `npm run shapes` into
    `server/traits/shape.json`: weight, width, slant, how square or straight the letters are, stroke
    contrast, x-height. Only what stands out against the whole catalog becomes a word ("condensed",
    "slanted"). Rerun it after new fonts arrive; it only measures what is new (`--all` redoes everything).
  - For the families nobody had tagged (the indie foundries, Fontshare, and Google-listed families
    Google never rated), moods judged once by Claude Sonnet from a rendered specimen, by `npm run vision`
    into `server/traits/vision.json`. Running it labels only families without a label yet, and each
    sheet of six fonts is one `claude -p` call on your subscription.
- Request words like "fast", "techy" or "elegant" get a line in the user prompt saying what they mean in
  the catalog's own terms (`server/vibeWords.ts`): Google has no speed tag, and its Active means lively,
  mostly scripts. The request outranks the shortlist, which only breaks ties.
- The catalog is listed indie first, then Fontshare, then Google, each band in a fixed shuffled order:
  sorted by popularity, the model favoured the first and last rows. It is fixed rather than new per
  search so Claude Code's prompt cache keeps working.
- Remote fonts load as FontFace objects under private names, so an installed copy of the same
  family never stands in for the web version.
- A Google font with an alternate on is drawn from its complete file in Google's own repository:
  `/api/google-files` finds it from the family's `METADATA.pb` (the answer is kept in
  `server/.cache/google-files.json`), and the font proxy fetches and keeps the file. The lightbox and
  Compare load it one font at a time, never the grid. `npm run check:alternates` tests the alternates
  finder against the cached font files offline.
- `npm run check` tests the prompt builder and reply parser offline (run `npm run dev` once first
  so the catalog cache exists). `npm run check:shapes` tests the shape measurements on fonts whose
  shape is known (Roboto upright, Kaushan Script slanted, Oswald condensed...).
- `eval/` is a before-and-after test of vibe search: 25 fixed requests (`eval/requests.json`), each run
  once through two versions of the code (`npx tsx eval/run.ts <label> [checkout]`, real searches on
  your subscription), drawn as blind pictures (`eval/grids.ts`) and compared (`eval/score.ts`). The
  runs from 2026-10-03 (Haiku with the old prompt against Sonnet with this one) are in `eval/runs/`,
  and the blind verdicts in `eval/judgements.json`.
- Italics come from the catalog: Google's metadata names each Google family's italic weights; the
  other sources list their italic files. A few Fontsource italics are not real italics (byte-for-byte
  uprights, or files browsers refuse) and are left out by hand in `server/catalog.ts`.
  `npm run check:italics` re-tests that list against Fontsource's CDN (online, about half a minute).
- Borrowed italics: when a family is in several sources and the row that is kept has no italic, it
  borrows the italic of another source's row (Sora's comes from Fontshare, Syne's from Use & Modify).
  Only the italic is borrowed; the upright stays the kept row's own. `npm run check:italics` also checks
  the borrowed files and compares their cap height and x-height with the upright: Sora's match exactly.
  Syne's italic is an older release of the design, a calligraphic hand with an x-height about 7% taller
  than Google's geometric upright, so it can look like another typeface. It is kept for now, as the only
  Syne italic there is; whether it stays is still open (one line in `mergeSources` drops it).
