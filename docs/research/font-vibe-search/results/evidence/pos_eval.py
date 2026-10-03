import json, re, collections, csv
S = "/private/tmp/claude-501/-Users-wouterschreuders-Code-Polymodal-polyverse--claude-worktrees-local-font-explorer-fcb9f3/b888d5c9-4397-4831-affc-9d0b508cad0f/scratchpad"
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
flat = collections.defaultdict(dict); ax = collections.defaultdict(dict)
for r in csv.reader(open(f"{S}/families.csv")):
    if len(r)!=4: continue
    f,a,t,s=r
    if a=="": flat[norm(f)][t]=float(s)
    else: ax[norm(f)][t]=max(ax[norm(f)].get(t,0),float(s))
def vec(k):
    if k in flat and any(t.startswith('/Expressive/') for t in flat[k]): return flat[k]
    if k in ax and any(t.startswith('/Expressive/') for t in ax[k]): return ax[k]
def order_of(path):
    body=open(path).read().split('CATALOG\n',1)[1].split('\n')
    rows=[l.split(' | ') for l in body if ' | ' in l]
    return {norm(r[0]):i for i,r in enumerate(rows)}, {norm(r[0]):r[2].strip() for r in rows}, {norm(r[0]):('very common' in r[-1]) for r in rows}
o_sorted,src,_=order_of('runs/system-tags.txt'); o_shuf,_,_=order_of('runs/system-shuf.txt')
FG=339; G=1760
SILVER={'fast':'/Expressive/Active','pixel':'/Theme/Pixel','calm':'/Expressive/Calm','loud':'/Expressive/Loud','black':'/Theme/Blackletter'}
def picks(label):
    d=json.load(open(f'runs/out-{label}.json')); return [r['family'] for r in (d['indep'] or [])+(d['others'] or [])]
def conds(variant):
    out=[]
    for q in SILVER:
        if variant=='sorted':
            hk = 'haiku-tags-1' if q=='fast' else f'q-{q}-haiku-tags'; sk = 'sonnet-low-1' if q=='fast' else f'q-{q}-sonnetlow-tags'
        else:
            hk=f'shuf-{q}-haiku'; sk=f'shuf-{q}-sonnetlow'
        out += [(q,'haiku',hk),(q,'sonnetlow',sk)]
    return out
for variant,order in [('sorted',o_sorted),('shuffled',o_shuf)]:
    bins=collections.Counter(); tot=0; hits=collections.defaultdict(lambda:[0,0]); common=0
    for q,m,lab in conds(variant):
        for p in picks(lab):
            k=norm(p)
            if k in order and order[k]>=FG:
                pos=order[k]-FG; bins[min(9,int(10*pos/G))]+=1; tot+=1
                v=vec(k); h=hits[(q,m)]; h[1]+=1
                if v is not None and v.get(SILVER[q],0)>=60: h[0]+=1
    print(f"{variant:9s} Google-only picks {tot}; per decile of the Google band: {[bins.get(i,0) for i in range(10)]}  (middle 3 deciles 6-8: {100*sum(bins.get(i,0) for i in (6,7,8))/tot:.0f}% vs 30% if uniform; first+last decile {100*(bins.get(0,0)+bins.get(9,0))/tot:.0f}% vs 20%)")
    agg=[0,0]
    for (q,m),(a,b) in sorted(hits.items()):
        agg[0]+=a; agg[1]+=b
    print("   silver hits (>=60 on the query's own Google tag) / Google picks:", {f"{q}/{m}":f"{a}/{b}" for (q,m),(a,b) in sorted(hits.items())}, " TOTAL", f"{agg[0]}/{agg[1]}")
