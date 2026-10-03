import csv, collections, json, re
S = "/private/tmp/claude-501/-Users-wouterschreuders-Code-Polymodal-polyverse--claude-worktrees-local-font-explorer-fcb9f3/b888d5c9-4397-4831-affc-9d0b508cad0f/scratchpad"
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
flat = collections.defaultdict(dict)
for r in csv.reader(open(f"{S}/families.csv")):
    if len(r)==4 and r[1]=="": flat[r[0]][r[2]] = float(r[3])
merged = json.load(open("/tmp/fx_work/runs/merged.json"))
G = [f["family"] for f in merged if f["source"]=="fontsource"]
tests = {
 "/Theme/Pixel": r"pixel|bit|8|px|silkscreen|vt323|jersey|tiny5|micro|dot",
 "/Theme/Brush": r"brush|marker|paint|script|hand|ink",
 "/Theme/Stencil": r"stencil|army|ops",
 "/Theme/Blackletter": r"black|fraktur|gotisch|goth|pirata|unifraktur|texturina|medieval|grenze|old english",
 "/Theme/Techno": r"tech|mono|digital|orbit|space|cyber|robot|sci|circuit|neon|future|zen dots|audio|exo|oxanium|quantum",
 "/Theme/Art Deco": r"deco|poiret|limelight|gatsby|monoton|metal",
 "/Expressive/Futuristic": r"tech|space|orbit|exo|future|cyber|neo|zen dots|audio|oxanium|quantum|michroma|syncopate|aldrich|electrolize|tomorrow",
 "/Expressive/Active": r"fast|race|racing|sport|speed|rush|dash|run|jump|move",
}
print("tag | positives>=60 | with literal keyword in family name | name-only share")
for t, pat in tests.items():
    pos = [g for g in G if flat.get(g, {}).get(t, 0) >= 60]
    hit = [g for g in pos if re.search(pat, g.lower())]
    print(f"{t:26s} {len(pos):4d} {len(hit):4d} {100*len(hit)/max(1,len(pos)):4.0f}%   e.g. missed by name: {[g for g in pos if g not in hit][:6]}")
