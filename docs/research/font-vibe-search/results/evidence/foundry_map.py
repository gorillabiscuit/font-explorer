# Strict hand mapping of the foundries' own words (non-Google rows) onto Google mood names. Run: python3 foundry_map.py
# Result on 2026-10-03: 121 of 339 non-Google families get >= 1 mood (Vintage 66, Techno 27, Elegant 23, Playful 14, Loud 12, Futuristic 8, Active 7, Calm 7).
import json, collections
S = "/private/tmp/claude-501/-Users-wouterschreuders-Code-Polymodal-polyverse--claude-worktrees-local-font-explorer-fcb9f3/b888d5c9-4397-4831-affc-9d0b508cad0f/scratchpad"
cat = json.load(open(f'{S}/cat.json'))['fonts']
M = {
 'Techno': ['techno','technical','computer','cyberpunk','neon','glitch','digital','mechanistic','industrial'],
 'Futuristic': ['futuristic','cyberpunk','solarpunk','streamlined'],
 'Playful': ['playful','funny','fun','funky','humorous','comics','comic','kids'],
 'Elegant/Sophisticated': ['elegant','luxury','fashion','didone','classical','delicate','romantic'],
 'Vintage': ['retro','revival','1900s','1960s','1970s','1980s','80s','1990s','victorian','art-deco','art nouveau','art-nouveau','art deco','old-style','analog'],
 'Calm': ['calm','soft','airy','warm'],
 'Active': ['sporty','jerseys','sports','slanted','leaning','punchy','spiky'],
 'Loud': ['bold','heavy','black','punchy','blocky','graffiti'],
}
inv = collections.defaultdict(set)
for g, ts in M.items():
    for t in ts: inv[t].add(g)
tot = hit_n = 0; per = collections.Counter(); mood = collections.Counter()
for f in cat:
    if f['source'] == 'fontsource': continue
    tot += 1
    hit = set()
    for t in f['tags']: hit |= inv.get(t.lower(), set())
    if hit: hit_n += 1; per[f['source']] += 1
    for h in hit: mood[h] += 1
print(tot, hit_n, dict(per), dict(mood))
