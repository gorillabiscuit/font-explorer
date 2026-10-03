# Vibe search: what to change (research summary, 2026-10-03)

Question: why does vibe search return fonts that do not look like the request ("fonts that imply fast
movement or action" returned mostly techno faces), and what would fix it?

The detailed findings are in `results/*.json` (12 approaches, each with coverage, evidence, cost and a
verdict). Research agents ran on Sonnet. The lead re-checked the numbers marked "rechecked" below from
the agents' raw data.

## Why results are off today

- Claude Haiku gets a text list of 2,099 fonts (name, category, source, tags) and never sees a letter.
- The app keeps only Google's top 6 mood tags at score 40 or more, drops the scores, and skips tags that
  Google gives only per variable-axis position (`parseGoogleTags`, server/catalog.ts; rechecked).
- Google's "Active" tag is mostly scripts and comic display faces, not speed; popular sporty fonts (Exo 2,
  Saira, Teko) have no Active tag.
- The indie and Fontshare rows have tags, but in their own words, which never match Google's moods.
- Nothing says which fonts have a real italic, the strongest speed cue.
- The user's candidates go with every search as "fonts I like", and the prompt tells the model to read
  taste from them.
- The model favours fonts at the start and end of the long list (middle deciles get 11% of picks
  against 30% if uniform).

## What works, with evidence

- **Shape measured from the font files.** 2,082 of 2,099 families measured with fontkit in about 2.5
  minutes, no AI cost. On Google fonts with held-out tags, measurements predict Active, Loud, Futuristic
  and Techno far better than category (AUC 0.88 to 0.96 vs 0.69 to 0.79).
  - Upright faces drawn slanted: 41% carry Active, against 7% overall (rechecked; the agent reported
    38% vs 5.8% with a slightly different cut).
  - Measured ink density tracks Loud, r = 0.71 (rechecked).
  - Slant alone is a trap: the most slanted uprights are formal scripts, so slant needs the category.
- **Sonnet 5.5 at low effort instead of Haiku.** Faster (9.3 s vs 12.2 s mean, rechecked from the
  agents' live runs) and more consistent between identical runs (50% vs 19% overlap, not rechecked).
  Sonnet and Opus need `--effort low`; thinking cannot be switched off for them.
- **A vision model labelling each font once** works for overall look, but only on Sonnet: pilot of 48
  fonts, motion AUC 0.89 (Haiku 0.78). Measurements plus vision: 0.97. Vision models cannot tell bold
  or italic apart, so weight and slant must come from measurement.

## What does not

- Font image search (CLIP, FontCLIP): only as good as simple measurements for mood words; a
  non-commercial training set; skip.
- Copying tags from similar Google fonts to untagged ones: right only 29% of the time for the top 3.
- DaFont, Font Squirrel, MyFonts and crowd-rating datasets: wrong fonts, blocked, or commercial.
- Values stored in font files (PANOSE, width class): mostly empty or default. italicAngle is the one
  useful field.

## Recommended build

1. Measure every font's shape and add short words to its catalog line where it stands out (drawn
   slanted, very wide, condensed, heavy, square, straight-edged...). About +7.5k prompt tokens.
2. Say which fonts have a real italic, and whether the Italic switch is on.
3. Keep Google's mood scores, include the per-axis tags, and add the renamed-family aliases.
4. Sonnet 5.5 at low effort, with a fallback model.
5. The request outranks the candidates; candidates only break ties.
6. Shuffle the catalog order per search to remove the position bias.
7. A short "read this as" vocabulary in the request part ("fast" means slanted, wide, italics, speed
   lines...), so the cached part of the prompt stays the same.

Optional second step for the ~480 fonts with no Google-vocabulary mood: Sonnet labels rendered
specimen sheets once (~80 sheets), or a person tags them (2 to 3 hours).

Evaluation: blind side-by-side result grids for about 25 requests, two runs per version. A full round
is about 50 searches on the Claude subscription.
