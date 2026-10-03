import csv, collections, json, re, glob, itertools
S = "/private/tmp/claude-501/-Users-wouterschreuders-Code-Polymodal-polyverse--claude-worktrees-local-font-explorer-fcb9f3/b888d5c9-4397-4831-affc-9d0b508cad0f/scratchpad"
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
flat = collections.defaultdict(dict); ax = collections.defaultdict(dict)
for r in csv.reader(open(f"{S}/families.csv")):
    if len(r) != 4: continue
    f, a, t, s = r
    if a == "": flat[norm(f)][t] = float(s)
    else: ax[norm(f)][t] = max(ax[norm(f)].get(t, 0), float(s))
merged = {norm(f["family"]): f for f in json.load(open("/tmp/fx_work/runs/merged.json"))}
INDIE = {"velvetyne", "collletttivo", "tunera", "usemodify"}
def active(k):
    if k in flat and any(t.startswith("/Expressive/") for t in flat[k]): return flat[k].get("/Expressive/Active", 0.0), "flat"
    if k in ax and any(t.startswith("/Expressive/") for t in ax[k]): return ax[k].get("/Expressive/Active", 0.0), "axis"
    return None, "none"
google = [k for k, f in merged.items() if f["source"] == "fontsource"]
pos60 = {k for k in google if (active(k)[0] or 0) >= 60}
pos40 = {k for k in google if (active(k)[0] or 0) >= 40}
print(f"silver Active positives among {len(google)} Google families: >=60: {len(pos60)}  >=40: {len(pos40)}  (flat-or-axis score)")
n_google_tagged = sum(1 for k in google if active(k)[1] != "none")
print("Google families with any mood row:", n_google_tagged)
runs = {}
for fn in sorted(glob.glob("/tmp/fx_work/runs/out-*.json")):
    d = json.load(open(fn))
    if d.get("is_error") or not d.get("indep") and not d.get("others"): continue
    picks = [r["family"] for r in (d["indep"] or []) + (d["others"] or [])]
    runs[d["label"]] = (d, picks)
print()
print(f"{'run':22s} {'n':>3s} {'indie':>5s} {'nonGoogle':>9s} {'Google':>6s} | G:Act>=60 G:Act>=40 G:noRow | tag'Active'shown | wall_s out_tok think cacheR cacheW")
for lab, (d, picks) in runs.items():
    ks = [norm(p) for p in picks]
    fs = [merged.get(k) for k in ks]
    unk = [p for p, f in zip(picks, fs) if f is None]
    fs2 = [(k, f) for k, f in zip(ks, fs) if f]
    n = len(fs2)
    indie = sum(f["source"] in INDIE for k, f in fs2)
    nong = sum(f["source"] != "fontsource" for k, f in fs2)
    g = [k for k, f in fs2 if f["source"] == "fontsource"]
    a60 = sum(k in pos60 for k in g); a40 = sum(k in pos40 for k in g); norow = sum(active(k)[1] == "none" for k in g)
    shown = sum("Active" in f["tags"] for k, f in fs2)
    u = d["usage"]
    print(f"{lab:22s} {n:3d} {indie:5d} {nong:9d} {len(g):6d} | {a60:3d}/{len(g):<3d}  {a40:3d}/{len(g):<3d}  {norow:3d}    | {shown:3d}            | {d['wall_ms']/1000:5.1f} {u['output_tokens']:6d} {u.get('output_tokens_details',{}).get('thinking_tokens',0):5d} {u['cache_read_input_tokens']:6d} {u['cache_creation_input_tokens']:6d}" + (f"  unknown:{unk}" if unk else ""))
print("\nJaccard between runs (families):")
labs = list(runs)
for a, b in itertools.combinations(labs, 2):
    A, B = set(norm(x) for x in runs[a][1]), set(norm(x) for x in runs[b][1])
    print(f"  {a:22s} vs {b:22s} {len(A&B)/len(A|B):.2f}  ({len(A&B)} shared)")
print()
for lab in labs:
    print(lab, "->", ", ".join(runs[lab][1]))

print("\n=== silver label details ===")
def sc(k, tag):
    d = flat.get(k) if (k in flat and any(t.startswith('/Expressive/') for t in flat[k])) else ax.get(k, {})
    return d.get(tag, 0.0)
common = {k for k, f in merged.items() if f.get("common")}
print("Active>=60 positives that are 'very common' (the prompt tells the model to avoid):", len(pos60 & common), "of", len(pos60))
bundle = {k for k in google if sc(k,'/Expressive/Active')>=60 or sc(k,'/Expressive/Excited')>=60}
print("bundle Active>=60 OR Excited>=60:", len(bundle), " of which common:", len(bundle & common))
# score each run's Google picks on several silver tags
for lab,(d,picks) in runs.items():
    g=[norm(p) for p in picks if merged.get(norm(p)) and merged[norm(p)]['source']=='fontsource']
    row={t:sum(sc(k,'/Expressive/'+t)>=60 for k in g) for t in ['Active','Excited','Loud','Futuristic','Stiff','Rugged']}
    row['bundle']=sum(k in bundle for k in g)
    print(f"{lab:22s} Google picks {len(g):2d}  >=60 counts:", row)
# per-tag correlation of Active with other tags among the catalog
import numpy as np
ks=[k for k in google if active(k)[1]!='none']
A=np.array([sc(k,'/Expressive/Active') for k in ks])
for t in ['Excited','Loud','Playful','Futuristic','Calm','Stiff','Rugged','Happy','Innovative']:
    B=np.array([sc(k,'/Expressive/'+t) for k in ks]); print(f"corr(Active,{t}) = {np.corrcoef(A,B)[0,1]:.2f}", end=' | ')
print()
# the top-20 by silver Active among Google, and are they common/indie
top=sorted(google,key=lambda k:-sc(k,'/Expressive/Active'))[:25]
print([ (merged[k]['family'], int(sc(k,'/Expressive/Active')), 'C' if k in common else '') for k in top])
