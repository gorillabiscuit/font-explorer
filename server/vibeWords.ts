// What common request words mean in the catalog's own terms: the shape words (server/traits.ts),
// Google's moods and themes, and the foundries' vocabulary. A request like "fonts that imply fast
// movement" otherwise gets matched on the nearest tag, and Google has no speed tag (its Active means
// lively, mostly scripts), so the model reached for Futuristic and Techno instead.
// The matching lines go in the user prompt, so the cached system prompt stays the same.

export interface ReadingContext {
  /** The Italic switch: with it on, every font that has a real italic is drawn leaning. */
  italicOn?: boolean;
  /** Family names in the catalog and the installed list. A name in the request is not read as words. */
  familyNames?: string[];
}

const READINGS: { words: RegExp; meaning: string | ((c: ReadingContext) => string) }[] = [
  {
    words: /\b(fast|faster|speedy|speed|quick|rapid|swift|motion|moving|movement|momentum|kinetic|dynamic|action|racing|race|sporty|sports?|athletic|velocity|rush|zoom)\b/i,
    meaning: (c) =>
      `forward motion. Letters that lean forward (shape "slanted"${c.italicOn ? '; with the Italic switch on, also any font that "has italic"' : ""}), a wide, low or heavy stance, stretched horizontals, cuts or speed lines, sporty squared or racing letterforms, brush or marker strokes with momentum. Google's Active mostly marks lively scripts and comic faces, not speed; formal copperplate scripts lean but feel slow; a static techno or geometric face is not fast unless it also leans, stretches or breaks.`,
  },
  {
    words: /\b(loud|shout|shouting|punchy|impact|impactful|powerful|aggressive|attention-grabbing)\b/i,
    meaning: 'volume. Shape "heavy" or "bold", condensed or very wide display faces, Google Loud and Excited; not "thin", "light" or delicate faces.',
  },
  {
    words: /\b(calm|calmer|quiet|serene|peaceful|gentle|relaxed|zen|tranquil|understated|subtle)\b/i,
    meaning: 'quiet. Regular or light weight, open even shapes, low contrast, soft rounds, Google Calm and Sincere; not "heavy", squared, distressed or Excited faces.',
  },
  {
    // "techno" alone is a look; "a techno club" is music.
    words: /\b(futuristic|future|sci-?fi|science fiction|outer space|space age|space-age|spacey|techno(?!\s+(?:club|music|rave|party|parties|festival|night|scene|dj))|tech|techy|technological|technical|digital|cyber|cyberpunk|robotic|engineered|mechanical|machine)\b/i,
    meaning:
      'engineered, forward-looking type. Shapes "squared" or "straight-edged", wide stances, monoline modular construction, Google Futuristic, Techno and Innovative, Superellipse sans, foundry words like mechanistic, modular, grid or pixel.',
  },
  {
    words: /\b(elegant|elegance|luxury|luxurious|refined|sophisticated|classy|premium|upscale|fashion|graceful|chic|exquisite)\b/i,
    meaning: 'refinement. "High contrast", light weights, "small x-height", Didone or Modern serifs with fine detail, or a Formal script for flourish, Google Sophisticated and Fancy; not rounded, "heavy", comic or distressed faces.',
  },
  {
    words: /\b(playful|fun|funny|quirky|whimsical|cheerful|happy|cute|bouncy|childlike|kids?|cartoon|cartoony|silly|goofy)\b/i,
    meaning: 'play. "Curvy" or rounded shapes, "large x-height", bouncy or irregular letters, Google Playful, Happy, Cute, Childlike and Wacky, foundry words like wonky or blobby.',
  },
  {
    words: /\b(friendly|warm|warmer|approachable|welcoming|inviting|humane)\b/i,
    meaning: 'warmth. Rounded or humanist shapes, open counters, "large x-height", regular weight, low contrast, Google Sincere, Happy and Calm, Humanist sans, Rounded sans; not "squared", "straight-edged" or Stiff faces.',
  },
  {
    words: /\b(handmade|hand-made|handwritten|handwriting|hand-drawn|hand-lettered|organic|crafted|craft|artisan|artisanal|brush|marker|scribbly|natural|rough|imperfect)\b/i,
    meaning: "the hand. The handwriting category, the Brush theme, Informal or Handwritten scripts, irregular outlines (Rugged, Distressed), foundry words like organic, calligraphic, human-made, informal or textured.",
  },
  {
    words: /\b(retro|vintage|old-school|nostalgic|nostalgia|(?:19)?[5-9]0'?s|fifties|sixties|seventies|eighties|nineties|deco|western|victorian|antique)\b/i,
    meaning: "the past. Google Vintage and the Art Deco, Art Nouveau, Woodtype, Tuscan, Shaded and Inline themes, Fat Face serifs and Clarendon slabs, rounded heavy display faces for the 70s.",
  },
  {
    words: /\b(brutal|brutalist|raw|harsh|industrial|gritty|grunge|grungy|edgy|punk|rebellious|tough|rugged)\b/i,
    meaning: 'force. "Heavy", "condensed", "straight-edged" or "squared" shapes, grotesques, the Stencil and Distressed themes, Google Rugged, Loud and Stiff, foundry words like brutalist or damage.',
  },
  {
    words: /\b(condensed|narrow|narrower|compressed|skinny|slim)\b/i,
    meaning: 'shape "condensed" or "very condensed".',
  },
  {
    words: /\b(wide|wider|extended|expanded|stretched)\b/i,
    meaning: 'shape "wide" or "very wide".',
  },
  {
    words: /\b(heavy|heavier|thick|chunky|fat|blocky|bolder)\b/i,
    meaning: 'shape "heavy" or "bold".',
  },
  {
    words: /\b(thin|thinner|light(?!-hearted)|lighter|delicate|hairline|airy)\b/i,
    meaning: 'shape "thin" or "light".',
  },
  {
    words: /\b(round|rounded|rounder|bubbly|circular|soft)\b/i,
    meaning: 'Rounded sans, "curvy" shapes, round terminals; not "squared".',
  },
  {
    words: /\b(geometric)\b/i,
    meaning: "Geometric sans: a circular o, monoline strokes, construction from circles and straight lines.",
  },
  {
    words: /\b(clean|minimal|minimalist|swiss|modernist|sleek|slick)\b/i,
    meaning: "clean construction. Neo Grotesque, Grotesque or Geometric sans, low contrast, even widths, nothing decorative.",
  },
  {
    words: /\b(neutral|simple|plain|safe|unobtrusive)\b/i,
    meaning: "plain type. Neo Grotesque, Grotesque or Geometric sans, Transitional serifs, regular weights, low contrast; plain and common fonts are fine here.",
  },
  {
    words: /\b(corporate|professional|business|trustworthy|serious|reliable|institutional|official)\b/i,
    meaning: "credibility. Google Business and Competent, steady regular weights, low contrast, sans or Transitional serifs; not Playful, Wacky or distressed faces.",
  },
  {
    words: /\b(legible|legibility|readable|readability|clear|clarity)\b/i,
    meaning: 'legibility. Regular to bold weight, "large x-height", open shapes; not "thin", distressed or decorative faces.',
  },
  {
    words: /\b(pixel|pixelated|8-?bit|bitmap|arcade|video ?games?|lcd|led|dot-?matrix)\b/i,
    meaning: 'the Pixel theme, "straight-edged" and "squared" shapes, foundry words like pixel, bitmap or grid.',
  },
];

/** At most this many readings, so a long request does not turn into a glossary. */
const MAX_READINGS = 4;

/**
 * The readings for the words in a request, one line each ('"fast": forward motion. ...'), in the order
 * the words appear. Empty when nothing matches.
 */
export function readingsFor(request: string, context: ReadingContext = {}): string[] {
  const text = withoutFamilyNames(request, context.familyNames ?? []);
  return READINGS.flatMap(({ words, meaning }) => {
    const m = words.exec(text);
    return m ? [{ at: m.index, line: `"${m[0]}": ${typeof meaning === "string" ? meaning : meaning(context)}` }] : [];
  })
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_READINGS)
    .map((r) => r.line);
}

/**
 * The request with family names blanked out (same length, so positions hold), so "more like Space
 * Grotesk" or "Shadows Into Light" is not read as outer space or a light weight. A one-word name that
 * is itself a request word is left alone: there the word is more likely meant than the font.
 */
function withoutFamilyNames(request: string, names: string[]): string {
  let text = request;
  const lower = request.toLowerCase();
  const present = names.filter((name) => name.length >= 3 && lower.includes(name.toLowerCase()));
  for (const name of present.sort((a, b) => b.length - a.length)) {
    if (!name.includes(" ") && READINGS.some(({ words }) => words.test(name))) continue;
    text = text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), (m) => " ".repeat(m.length));
  }
  return text;
}
