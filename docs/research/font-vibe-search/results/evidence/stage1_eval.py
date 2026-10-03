import csv, collections, json, re, glob
S = "/private/tmp/claude-501/-Users-wouterschreuders-Code-Polymodal-polyverse--claude-worktrees-local-font-explorer-fcb9f3/b888d5c9-4397-4831-affc-9d0b508cad0f/scratchpad"
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
flat = collections.defaultdict(dict); ax = collections.defaultdict(dict)
for r in csv.reader(open(f"{S}/families.csv")):
    if len(r)!=4: continue
    f,a,t,s=r
    if a=="": flat[norm(f)][t]=float(s)
    else: ax[norm(f)][t]=max(ax[norm(f)].get(t,0),float(s))
merged = {norm(f["family"]): f for f in json.load(open("runs/merged.json"))}
G=[k for k,f in merged.items() if f["source"]=="fontsource"]
def vec(k):
    d = flat[k] if (k in flat and any(t.startswith('/Expressive/') for t in flat[k])) else ax.get(k)
    return d
NAME={"ArtDeco":"Art Deco","ArtNouveau":"Art Nouveau"}
def tagscore(k,w):
    d=vec(k)
    if d is None: return None
    s=0
    for t,wt in w.items():
        t=NAME.get(t,t)
        key=('/Expressive/'+t) if ('/Expressive/'+t) in d or t in ['Active','Artistic','Awkward','Business','Calm','Childlike','Competent','Cute','Excited','Fancy','Futuristic','Happy','Innovative','Loud','Playful','Rugged','Sincere','Sophisticated','Stiff','Vintage'] else '/Theme/'+t
        s+=wt*d.get(key,0)/100
    return s
runs={}
for fn in sorted(glob.glob('runs/out-*.json')):
    d=json.load(open(fn))
    if d.get('is_error') or not d.get('indep') and not d.get('others'): continue
    runs[d['label']]=[r['family'] for r in (d['indep'] or [])+(d['others'] or [])]
for i in (1,2):
    w=json.load(open(f'runs/stage1-out{i}.json'))['structured_output']['tags']
    sc={k:tagscore(k,w) for k in G}
    ranked=[k for k,v in sorted(((k,v) for k,v in sc.items() if v is not None), key=lambda x:-x[1])]
    pos={k:i for i,k in enumerate(ranked)}
    n_scored=len(ranked)
    print(f"stage-1 weights #{i}: {w}\n  Google families scorable: {n_scored} of {len(G)}")
    print("  top 15 by tag score:", [merged[k]['family'] for k in ranked[:15]])
    tot=0; in80=0; in200=0; in400=0; unsc=0
    for lab,picks in runs.items():
        g=[norm(p) for p in picks if merged.get(norm(p)) and merged[norm(p)]['source']=='fontsource']
        a=sum(1 for k in g if k in pos and pos[k]<80); b=sum(1 for k in g if k in pos and pos[k]<200); c=sum(1 for k in g if k in pos and pos[k]<400); u=sum(1 for k in g if k not in pos)
        tot+=len(g); in80+=a; in200+=b; in400+=c; unsc+=u
        print(f"  {lab:22s} Google picks {len(g):2d}: in tag-top-80: {a:2d}, top-200: {b:2d}, top-400: {c:2d}, not scorable: {u}")
    print(f"  ALL RUNS: {tot} Google picks -> top-80 {in80} ({100*in80/tot:.0f}%), top-200 {in200} ({100*in200/tot:.0f}%), top-400 {in400} ({100*in400/tot:.0f}%), unscorable {unsc}")
    print(f"  baseline: a random 80 of {n_scored} would contain {100*80/n_scored:.0f}%, 200 -> {100*200/n_scored:.0f}%, 400 -> {100*400/n_scored:.0f}%")
    # what silver does the tag-ranked top-20 give? precision vs Active>=60
    pos60={k for k in G if (vec(k) or {}).get('/Expressive/Active',0)>=60}
    print("  tag-ranked top-20 containing Active>=60:", sum(k in pos60 for k in ranked[:20]), "/20")
