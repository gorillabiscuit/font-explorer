import csv, collections, json, re, glob, itertools, statistics
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
    if k in flat and any(t.startswith('/Expressive/') for t in flat[k]): return flat[k]
    if k in ax and any(t.startswith('/Expressive/') for t in ax[k]): return ax[k]
    return None
def sc(k,t):
    d=vec(k); return None if d is None else d.get(t,0.0)
def load(lab):
    d=json.load(open(f'runs/out-{lab}.json'))
    if d.get('indep') is None and d.get('others') is None: return None, d
    return [r['family'] for r in (d['indep'] or [])+(d['others'] or [])], d
Q={'pixel':'/Theme/Pixel','calm':'/Expressive/Calm','loud':'/Expressive/Loud','black':'/Theme/Blackletter'}
print("Tag-faithful queries: precision of the Google picks against Google's own tag (silver >=60), tags visible vs hidden")
print(f"{'query':7s} {'silver n>=60':>12s} | {'cond':18s} {'G picks':>7s} {'>=60':>5s} {'>=40':>5s} {'any row':>7s} {'indie':>5s} | jaccard(tags,hidden)")
for q,t in Q.items():
    npos=sum(1 for k in G if (sc(k,t) or 0)>=60)
    res={}
    for cond in ['haiku-tags','haiku-hidden','sonnetlow-tags','sonnetlow-hidden']:
        picks,d=load(f'q-{q}-{cond}')
        ks=[norm(p) for p in picks if merged.get(norm(p))]
        g=[k for k in ks if merged[k]['source']=='fontsource']
        indie=sum(1 for k in ks if merged[k]['source'] in ('velvetyne','collletttivo','tunera','usemodify'))
        res[cond]=(set(ks),len(g),sum((sc(k,t) or 0)>=60 for k in g),sum((sc(k,t) or 0)>=40 for k in g),sum(vec(k) is not None for k in g),indie)
    for cond,(ks,ng,a60,a40,anyrow,indie) in res.items():
        jac=''
        if cond.endswith('hidden'):
            o=cond.replace('hidden','tags'); A,B=res[o][0],ks; jac=f"{len(A&B)/len(A|B):.2f}"
        print(f"{q:7s} {npos:12d} | {cond:18s} {ng:7d} {a60:5d} {a40:5d} {anyrow:7d} {indie:5d} | {jac}")
print()
print("Replicates of 'fast movement or action' (same prompt, same model): hits on Google Active>=60, Jaccard between replicates")
groups={'haiku-tags':['haiku-tags-1','haiku-tags-2','fast-haiku-tags-r2','fast-haiku-tags-r3','fast-haiku-tags-r4','fast-haiku-tags-r5'],
        'haiku-hidden':['haiku-hidden-1','fast-haiku-hidden-r2','fast-haiku-hidden-r3','fast-haiku-hidden-r4','fast-haiku-hidden-r5'],
        'sonnetlow-tags':['sonnet-low-1','fast-sonnetlow-tags-r2','fast-sonnetlow-tags-r3','fast-sonnetlow-tags-r4','fast-sonnetlow-tags-r5'],
        'sonnetlow-hidden':['sonnet-hidden-low-1','fast-sonnetlow-hidden-r2','fast-sonnetlow-hidden-r3','fast-sonnetlow-hidden-r4','fast-sonnetlow-hidden-r5']}
for g,labs in groups.items():
    sets=[];hits=[];ng=[];wall=[];out=[]
    for l in labs:
        picks,d=load(l)
        if picks is None: print('   (skipped failed run',l,')'); continue
        ks=[norm(p) for p in picks if merged.get(norm(p))]
        sets.append(set(ks)); gg=[k for k in ks if merged[k]['source']=='fontsource']; ng.append(len(gg)); hits.append(sum((sc(k,'/Expressive/Active') or 0)>=60 for k in gg)); wall.append(d['wall_ms']/1000); out.append(d['usage']['output_tokens'])
    js=[len(a&b)/len(a|b) for a,b in itertools.combinations(sets,2)]
    print(f"{g:18s} n={len(sets)} Google picks/run mean {statistics.mean(ng):.1f}; Active>=60 hits/run {hits} (mean {statistics.mean(hits):.1f}); mean pairwise Jaccard {statistics.mean(js):.2f} (min {min(js):.2f}, max {max(js):.2f}); wall s mean {statistics.mean(wall):.1f} (min {min(wall):.1f}, max {max(wall):.1f}); out tokens mean {statistics.mean(out):.0f}")
# union of distinct picks and how often the top picks recur
cnt=collections.Counter()
for l in groups['haiku-tags']:
    picks,_=load(l)
    for p in set(picks): cnt[p]+=1
print("Haiku (tags) picks recurring in >=4 of 6 runs:", [p for p,c in cnt.items() if c>=4], "| appear in only 1 run:", sum(1 for c in cnt.values() if c==1), "of", len(cnt), "distinct")
