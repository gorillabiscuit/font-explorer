"""Held-out check for 'tag transfer': hide one Google family's mood tags at a time, predict them from the
nearest OTHER families (kNN, leave-one-out), compare with a category-only baseline.
Features: cheap metadata only (category, Google stroke class, quant stroke widths, legacy 1-10 thickness/slant/width)
and/or TF-IDF of Google's DESCRIPTION text. numpy only. Run: python3 transfer_loo.py"""
import csv, collections, json, re, math, sys, html
import numpy as np

S = "/private/tmp/claude-501/-Users-wouterschreuders-Code-Polymodal-polyverse--claude-worktrees-local-font-explorer-fcb9f3/b888d5c9-4397-4831-affc-9d0b508cad0f/scratchpad"
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())

cat = json.load(open(f"{S}/cat.json"))["fonts"]
G = {norm(f["family"]): f for f in cat if f["source"] == "fontsource"}
meta = {norm(f["family"]): f for f in json.load(open("/tmp/gfmeta.json"))["familyMetadataList"]}

flat = collections.defaultdict(dict)
for r in csv.reader(open(f"{S}/families.csv")):
    if len(r) == 4 and r[1] == "":
        flat[norm(r[0])][r[2]] = float(r[3])
q = collections.defaultdict(dict)
for r in csv.reader(open(f"{S}/quant.csv")):
    q[norm(r[0])][(r[1], r[2])] = float(r[3])

keys = [k for k in G if any(t.startswith("/Expressive/") for t in flat.get(k, {}))]
keys.sort()
N = len(keys)
print("families with flat Expressive tags:", N)

EXPR = sorted({t for k in keys for t in flat[k] if t.startswith("/Expressive/")})
THEME = ["/Theme/Techno", "/Theme/Pixel", "/Theme/Brush", "/Theme/Wacky", "/Theme/Distressed", "/Theme/Blobby", "/Theme/Woodtype"]
TAGS = EXPR + THEME
Y = np.array([[flat[k].get(t, 0.0) for t in TAGS] for k in keys])

# ---------- cheap metadata features
CATS = ["sans", "serif", "display", "mono", "handwriting", "other"]
STROKES = ["Sans Serif", "Serif", "Slab Serif", None]


def nearest_w(d, want=400):
    ws = []
    for (axk, name), v in d.items():
        m = re.match(r"^wght@(\d+)$", axk)
        if m and name == "/quant/stroke_width_max":
            ws.append(int(m.group(1)))
    if not ws:
        return None
    return min(ws, key=lambda w: abs(w - want))


feat = []
for k in keys:
    f = G[k]
    m = meta.get(k, {})
    row = [1.0 if f["category"] == c else 0.0 for c in CATS]
    row += [1.0 if m.get("stroke") == s else 0.0 for s in STROKES]
    d = q.get(k, {})
    w = nearest_w(d)
    if w is not None:
        smax = d[(f"wght@{w}", "/quant/stroke_width_max")]
        smin = d.get((f"wght@{w}", "/quant/stroke_width_min"), smax)
        row += [smax, smin / smax if smax else 1.0, 0.0]
    else:
        row += [np.nan, np.nan, 1.0]
    fonts = m.get("fonts", {})
    leg = fonts.get("400") or next((v for v in fonts.values() if v.get("thickness") is not None), None)
    if leg and leg.get("thickness") is not None:
        row += [leg["thickness"], leg["slant"], leg["width"], 0.0]
    else:
        row += [np.nan, np.nan, np.nan, 1.0]
    row += [len(f.get("weights", [])), math.log1p(m.get("popularity", 2000) or 2000)]
    feat.append(row)
X = np.array(feat, dtype=float)
# impute NaN with category-conditional mean, then standardise numeric columns
cat_idx = np.argmax(X[:, : len(CATS)], axis=1)
for j in range(X.shape[1]):
    col = X[:, j]
    nan = np.isnan(col)
    if nan.any():
        for c in range(len(CATS)):
            sel = (cat_idx == c)
            vals = col[sel & ~nan]
            fill = vals.mean() if len(vals) else np.nanmean(col)
            col[sel & nan] = fill
        col[np.isnan(col)] = np.nanmean(col)
num_cols = list(range(len(CATS) + len(STROKES), X.shape[1]))
mu, sd = X[:, num_cols].mean(0), X[:, num_cols].std(0) + 1e-9
Xs = X.copy()
Xs[:, num_cols] = (X[:, num_cols] - mu) / sd
Xs[:, : len(CATS) + len(STROKES)] *= 1.5  # category matters most

# ---------- description text features (TF-IDF)
def desc_tokens(k):
    import os
    for root in ("ofl", "apache", "ufl"):
        p = f"{S}/gf/{root}/{k}/DESCRIPTION.en_us.html"
        if os.path.exists(p):
            t = open(p, encoding="utf8", errors="ignore").read()
            t = re.sub(r"<[^>]+>", " ", t)
            t = html.unescape(t).lower()
            t = re.sub(r"https?://\S+", " ", t)
            return re.findall(r"[a-z]{3,}", t)
    return None


docs = [desc_tokens(k) for k in keys]
has_desc = np.array([d is not None for d in docs])
print("with description text:", int(has_desc.sum()))
STOP = set("the and for with that this are was were from have has its their which into also been can his her more other such than these those they not but you your all any out one two use used based family font fonts typeface typefaces designed design learn contribute see github com www http https org html available version released while about over only when who each both most many".split())
vocab = collections.Counter(t for d in docs if d for t in set(d) if t not in STOP)
V = [w for w, c in vocab.items() if 3 <= c <= N * 0.3]
vi = {w: i for i, w in enumerate(V)}
T = np.zeros((N, len(V)))
for i, d in enumerate(docs):
    if not d:
        continue
    for t in d:
        if t in vi:
            T[i, vi[t]] += 1
df = (T > 0).sum(0)
T = np.log1p(T) * np.log(N / (1 + df))
T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-9
print("vocab", len(V))


# ---------- kNN leave-one-out
def knn_pred(sim, k=15, power=1.0, mask=None):
    S_ = sim.copy()
    np.fill_diagonal(S_, -np.inf)
    if mask is not None:
        S_[mask & ~np.eye(N, dtype=bool)] = -np.inf
    idx = np.argpartition(-S_, k, axis=1)[:, :k]
    w = np.take_along_axis(S_, idx, axis=1)
    w = np.maximum(w, 0) ** power + 1e-9
    P = (Y[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
    return P


def sim_from_dist(Z):
    d2 = ((Z[:, None, :] - Z[None, :, :]) ** 2).sum(-1)
    return 1.0 / (1.0 + np.sqrt(d2))


def auc(score, pos):
    n1 = pos.sum(); n0 = (~pos).sum()
    if n1 == 0 or n0 == 0:
        return float("nan")
    ranks = score.argsort().argsort() + 1.0
    # average ties
    order = np.argsort(score)
    s_sorted = score[order]
    r = np.empty(len(score)); i = 0
    while i < len(score):
        j = i
        while j + 1 < len(score) and s_sorted[j + 1] == s_sorted[i]:
            j += 1
        r[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return (r[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def evaluate(P, name, thr=60, topk=20):
    out = {}
    for ti, t in enumerate(TAGS):
        pos = Y[:, ti] >= thr
        if pos.sum() < 15:
            continue
        a = auc(P[:, ti], pos)
        top = np.argsort(-P[:, ti])[:topk]
        out[t] = (int(pos.sum()), a, pos[top].mean(), pos.mean())
    return out


# baselines
rng = np.random.default_rng(7)
fold = rng.integers(0, 10, N)
Pcat = np.zeros_like(Y)
for fo in range(10):
    tr = fold != fo
    for c in range(len(CATS)):
        sel_tr = tr & (cat_idx == c)
        if sel_tr.sum():
            Pcat[(~tr) & (cat_idx == c)] = Y[sel_tr].mean(0)
        else:
            Pcat[(~tr) & (cat_idx == c)] = Y[tr].mean(0)
Pcat = Pcat + rng.normal(0, 1e-6, Pcat.shape)  # random tie-break
# siblings: same first word (>=4 letters), e.g. "Big Shoulders ...", "Fusion Pixel ...", "Anek ..."
first = [re.split(r"[\s\-]+", G[k]["family"].lower())[0] for k in keys]
SIB = np.array([[first[i] == first[j] and len(first[i]) >= 4 for j in range(N)] for i in range(N)])
print("families with at least one sibling:", int((SIB.sum(1) > 1).sum()))
P_meta = knn_pred(sim_from_dist(Xs), k=15)
Tsim = T @ T.T
Tsim[~has_desc, :] = 0; Tsim[:, ~has_desc] = 0
P_text = knn_pred(Tsim, k=15)
# combined similarity: standardised metadata + text
Msim = sim_from_dist(Xs)
P_both = knn_pred(0.5 * Msim / Msim.max() + 0.5 * Tsim / (Tsim.max() + 1e-9), k=15)
# Global mean (popularity prior)
Pmean = np.tile(Y.mean(0), (N, 1))

res = {n: evaluate(P, n) for n, P in [("category_only", Pcat), ("meta_kNN", P_meta), ("text_kNN", P_text), ("meta+text_kNN", P_both)]}
print(f"\nLeave-one-out over {N} Google families; positive = score>=60; P@20 over the whole pool")
print(f"{'tag':28s} {'n_pos':>5s} {'base':>5s} | " + " | ".join(f"{n[:14]:>14s}" for n in res))
for t in TAGS:
    if t not in res["category_only"]:
        continue
    n_pos, _, _, base = res["category_only"][t]
    line = f"{t:28s} {n_pos:5d} {base:5.2f} | " + " | ".join(f"AUC {res[n][t][1]:.2f} P20 {res[n][t][2]:.2f}" for n in res)
    print(line)
print("\nmean AUC", {n: round(float(np.nanmean([v[1] for v in r.values()])), 3) for n, r in res.items()})
print("mean P@20", {n: round(float(np.mean([v[2] for v in r.values()])), 3) for n, r in res.items()})
print("mean base rate", round(float(np.mean([v[3] for v in res['category_only'].values()])), 3))
# Pearson correlations of predicted vs true score per tag (mean)
def mean_corr(P):
    cs = []
    for ti in range(len(TAGS)):
        if Y[:, ti].std() < 1e-6 or P[:, ti].std() < 1e-6:
            continue
        cs.append(np.corrcoef(P[:, ti], Y[:, ti])[0, 1])
    return float(np.mean(cs))
print("mean Pearson r", {n: round(mean_corr(P), 3) for n, P in [("category_only", Pcat), ("meta_kNN", P_meta), ("text_kNN", P_text), ("meta+text_kNN", P_both)]})
np.save("/tmp/fx_work/keys.npy", np.array(keys))

# ------------- stricter: neighbours may not be siblings of the held-out family
def summarize(P):
    r = evaluate(P, "x")
    return round(float(np.nanmean([v[1] for v in r.values()])), 3), round(float(np.mean([v[2] for v in r.values()])), 3), round(mean_corr(P), 3)
P_meta_ns = knn_pred(Msim, k=15, mask=SIB)
P_text_ns = knn_pred(Tsim, k=15, mask=SIB)
Mix = 0.5 * Msim / Msim.max() + 0.5 * Tsim / (Tsim.max() + 1e-9)
P_both_ns = knn_pred(Mix, k=15, mask=SIB)
print("\nSUMMARY (mean AUC, mean P@20, mean Pearson r)")
for n, P in [("category_only(10-fold)", Pcat), ("meta_kNN", P_meta), ("meta_kNN no-siblings", P_meta_ns), ("text_kNN", P_text), ("text_kNN no-siblings", P_text_ns), ("meta+text", P_both), ("meta+text no-siblings", P_both_ns)]:
    print(f"{n:26s}", summarize(P))
# stratify by distance of the nearest neighbour in metadata space (no-siblings)
S_ = Msim.copy(); S_[SIB] = -np.inf
nn = np.max(S_, axis=1)
q1, q2 = np.quantile(nn, [1 / 3, 2 / 3])
for name, sel in [("nearest-neighbour FAR (outer third)", nn <= q1), ("middle third", (nn > q1) & (nn <= q2)), ("NEAR (inner third)", nn > q2)]:
    aucs = []
    for ti, t in enumerate(TAGS):
        pos = Y[sel, ti] >= 60
        if pos.sum() >= 8 and (~pos).sum() >= 8:
            aucs.append(auc(P_meta_ns[sel, ti], pos))
    print(f"meta_kNN no-siblings, {name}: mean AUC {np.nanmean(aucs):.3f} over {len(aucs)} tags, n={int(sel.sum())}")
# by-tag table for meta+text no-siblings
r = evaluate(P_both_ns, "x")
print("\nPer tag, meta+text no-siblings: tag n_pos base AUC P@20")
for t, (n_pos, a, p20, base) in r.items():
    print(f"  {t:26s} {n_pos:4d} {base:.2f}  AUC {a:.2f}  P@20 {p20:.2f}")

# ------------- how good as a PRE-FILL for a person: top-3 suggested moods per font (lift-normalised)
mood_idx = [i for i, t in enumerate(TAGS) if t.startswith("/Expressive/")]
mu_t = Y.mean(0); sd_t = Y.std(0) + 1e-9
for n, P in [("meta+text no-siblings", P_both_ns), ("meta no-siblings", P_meta_ns), ("category_only", Pcat)]:
    Z = (P - mu_t) / sd_t
    hit60 = hit40 = tot = 0
    for i in range(N):
        top = sorted(mood_idx, key=lambda j: -Z[i, j])[:3]
        for j in top:
            tot += 1; hit60 += Y[i, j] >= 60; hit40 += Y[i, j] >= 40
    print(f"top-3 suggested moods per font, {n}: {hit60/tot:.2f} truly >=60, {hit40/tot:.2f} truly >=40 (random pick of 3 moods: {np.mean(Y[:, mood_idx] >= 60):.2f} / {np.mean(Y[:, mood_idx] >= 40):.2f})")
