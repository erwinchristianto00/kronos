"""V4 trajectory/path predictor exported for the TypeScript continuation runtime.

The trainer deliberately retains the current fixed LightGBM family: H6/H12/H24/H36 specialists,
purged OOF specialist predictions, trajectory head, and validation-only temperature calibration.
It is a reproducible challenger trainer, not a hyperparameter miner.
"""
import json
import sys
from datetime import datetime, timezone

import numpy as np
import lightgbm as lgb

HORIZONS = [6, 12, 24, 36]
EMBARGO = max(HORIZONS)
CLASSES = ["STRONG_DOWN", "NEUTRAL", "STRONG_UP"]
PATHS = ["PERSISTENT_UP", "PERSISTENT_DOWN", "UP_THEN_REVERSAL", "DOWN_THEN_REVERSAL",
         "EARLY_UP_THEN_FLAT", "EARLY_DOWN_THEN_FLAT", "CHOP", "TRANSITION"]
N_FOLDS = 5
Z_BOUNDARY = 0.5
CONFIGS_EVALUATED = 2
BASE = dict(learning_rate=0.05, num_leaves=8, min_data_in_leaf=400, feature_fraction=0.6,
            bagging_fraction=0.8, bagging_freq=1, lambda_l2=25.0, verbose=-1, seed=7, num_threads=2)
ROUNDS = 120
TRAJ = dict(BASE); TRAJ.update(num_leaves=6, min_data_in_leaf=250, feature_fraction=0.8)
TRAJ_ROUNDS = 90


def served_cols(names):
    # Existing V4 contract: funding remains diagnostic until its source coverage is mature.
    return [i for i, nm in enumerate(names)
            if not nm.startswith("adm_") and "funding" not in nm.lower()]


def path_class_from(z6, z12, z24, z36, b=Z_BOUNDARY):
    """Must remain byte-for-byte semantically aligned with pathClassFrom in TypeScript."""
    def sgn(z):
        return 1 if z >= b else (-1 if z <= -b else 0)
    s6, s12, s24, s36 = sgn(z6), sgn(z12), sgn(z24), sgn(z36)
    early, late = s6 + s12, s24 + s36
    if s6 > 0 and s12 > 0 and s24 > 0 and s36 > 0:
        return "PERSISTENT_UP"
    if s6 < 0 and s12 < 0 and s24 < 0 and s36 < 0:
        return "PERSISTENT_DOWN"
    if early >= 1 and late <= -1:
        return "UP_THEN_REVERSAL"
    if early <= -1 and late >= 1:
        return "DOWN_THEN_REVERSAL"
    if early >= 1 and late == 0:
        return "EARLY_UP_THEN_FLAT"
    if early <= -1 and late == 0:
        return "EARLY_DOWN_THEN_FLAT"
    if s6 == 0 and s12 == 0 and s24 == 0 and s36 == 0:
        return "CHOP"
    return "TRANSITION"


def load(csv_path):
    with open(csv_path) as fh:
        header = fh.readline().rstrip("\n").split(",")
        rows = [ln.rstrip("\n").split(",") for ln in fh if ln.strip()]
    n_label = 4 * len(HORIZONS)
    # Lifecycle matrix adds an audit-only source-timestamp column. It is deliberately excluded
    # from the model vector; training below separately verifies the no-leakage invariant.
    feature_start = 2 if len(header) > 1 and header[1] == "maxFeatureSourceTimestampMs" else 1
    if len(header) > feature_start and header[feature_start] == "baseLongCount":
        feature_start += 1
    names = header[feature_start:-n_label]
    t = np.array([int(r[0]) for r in rows], dtype=np.int64)
    source_t = np.array([int(r[1]) if len(header) > 1 and header[1] == "maxFeatureSourceTimestampMs" else int(r[0]) for r in rows], dtype=np.int64)
    if np.any(source_t > t):
        raise SystemExit("FATAL: feature source timestamp after formation")
    X = np.full((len(rows), len(names)), np.nan)
    for i, r in enumerate(rows):
        for j, v in enumerate(r[feature_start:feature_start + len(names)]):
            if v != "":
                X[i, j] = float(v)
    labels, base = {}, feature_start + len(names)
    for k, h in enumerate(HORIZONS):
        off = base + 4 * k
        labels[h] = {
            "r": np.array([float(r[off]) for r in rows]),
            "vol": np.array([float(r[off + 1]) for r in rows]),
            "z": np.array([float(r[off + 2]) for r in rows]),
            "cls": np.array([CLASSES.index(r[off + 3]) for r in rows]),
        }
    path = np.array([PATHS.index(path_class_from(labels[6]["z"][i], labels[12]["z"][i],
                                                 labels[24]["z"][i], labels[36]["z"][i]))
                     for i in range(len(rows))])
    return t, names, X, labels, path


def purged_split(n, ft=0.60, fv=0.20):
    i1, i2 = int(n * ft), int(n * (ft + fv))
    return (np.arange(0, i1 - EMBARGO), np.arange(i1 + EMBARGO, i2 - EMBARGO),
            np.arange(i2 + EMBARGO, n))


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def logloss(P, y):
    return float(-np.mean(np.log(np.clip(P[np.arange(len(y)), y], 1e-12, 1.0))))


def balacc(pred, y, k):
    accs = [float((pred[y == c] == c).mean()) for c in range(k) if (y == c).sum()]
    return float(np.mean(accs)) if accs else float("nan")


def block_ci(fn, n, iters=1200, seed=17):
    rng = np.random.default_rng(seed)
    blocks = [np.arange(i, min(i + EMBARGO, n)) for i in range(0, n, EMBARGO)]
    out = []
    for _ in range(iters):
        pick = rng.integers(0, len(blocks), len(blocks))
        try:
            out.append(fn(np.concatenate([blocks[k] for k in pick])))
        except Exception:
            continue
    return (float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))) if out else (float("nan"),) * 2


def flatten(node):
    feat, thr, ml, left, right, leaf, val = [], [], [], [], [], [], []

    def add(nd):
        i = len(feat)
        feat.append(-1); thr.append(0.0); ml.append(0); left.append(0); right.append(0)
        leaf.append(0); val.append(0.0)
        if "leaf_value" in nd and "split_index" not in nd:
            leaf[i] = 1; val[i] = float(nd["leaf_value"]); return i
        if nd.get("decision_type", "<=") != "<=":
            raise SystemExit("runtime only implements '<=' splits")
        feat[i] = int(nd["split_feature"]); thr[i] = float(nd["threshold"])
        ml[i] = 1 if nd.get("default_left", False) else 0
        left[i] = add(nd["left_child"]); right[i] = add(nd["right_child"])
        return i

    add(node)
    return {"featureIdx": feat, "threshold": thr, "missingGoToLeft": ml,
            "left": left, "right": right, "isLeaf": leaf, "value": val}


def export_trees(booster, num_class=1):
    d = booster.dump_model()
    per = [[] for _ in range(num_class)]
    for ti, info in enumerate(d["tree_info"]):
        per[ti % num_class].append(flatten(info["tree_structure"]))
    return per


def score_artifact(trees, baseline, X):
    out = np.full(X.shape[0], float(baseline))
    idxr = np.arange(X.shape[0])
    for tr in trees:
        fi = np.array(tr["featureIdx"]); th = np.array(tr["threshold"]); mg = np.array(tr["missingGoToLeft"])
        lf = np.array(tr["left"]); rt = np.array(tr["right"]); il = np.array(tr["isLeaf"]); vv = np.array(tr["value"])
        node = np.zeros(X.shape[0], dtype=np.int64)
        for _ in range(128):
            isleaf = il[node] == 1
            if isleaf.all():
                break
            v = X[idxr, np.where(isleaf, 0, fi[node])]
            go_left = np.where(np.isnan(v), mg[node] == 1, v <= th[node])
            node = np.where(isleaf, node, np.where(go_left, lf[node], rt[node]))
        out += vv[node]
    return out


def fit_specialist(Xtr, lab, cols, weights):
    heads = {}
    p = dict(BASE); p.update(objective="multiclass", num_class=3)
    m = lgb.train(p, lgb.Dataset(Xtr[:, cols], label=lab["cls"], weight=weights, free_raw_data=False),
                  num_boost_round=ROUNDS)
    heads["cls"] = {"kind": "softmax", "classes": CLASSES,
                    "perClass": [{"baseline": 0.0, "trees": tt} for tt in export_trees(m, 3)]}
    for name, target, obj, alpha in (("mean", lab["r"], "regression", None),
                                     ("q10", lab["r"], "quantile", 0.10),
                                     ("q50", lab["r"], "quantile", 0.50),
                                     ("q90", lab["r"], "quantile", 0.90),
                                     ("vol", lab["vol"], "regression", None)):
        p2 = dict(BASE); p2["objective"] = obj
        if alpha is not None:
            p2["alpha"] = alpha
        mm = lgb.train(p2, lgb.Dataset(Xtr[:, cols], label=target, free_raw_data=False),
                       num_boost_round=ROUNDS)
        heads[name] = {"kind": "identity", "baseline": 0.0, "trees": export_trees(mm, 1)[0]}
    return heads


def specialist_block(heads, X):
    raw = np.column_stack([score_artifact(h["trees"], h["baseline"], X) for h in heads["cls"]["perClass"]])
    P = softmax(raw)
    cols = [P[:, 0], P[:, 1], P[:, 2]]
    for name in ("mean", "q10", "q50", "q90", "vol"):
        cols.append(score_artifact(heads[name]["trees"], heads[name]["baseline"], X))
    return np.column_stack(cols)


TRAJ_COLS_PER_H = ["p_down", "p_neutral", "p_up", "mean", "q10", "q50", "q90", "vol"]


def build_traj_features(blocks):
    """Must match DirectionTrajectory.predict exactly."""
    M = np.column_stack([blocks[h] for h in HORIZONS])
    ups = np.column_stack([blocks[h][:, 2] for h in HORIZONS])
    downs = np.column_stack([blocks[h][:, 0] for h in HORIZONS])
    means = np.column_stack([blocks[h][:, 3] for h in HORIZONS])
    lean = ups - downs
    early = (lean[:, 0] + lean[:, 1]) / 2.0
    late = (lean[:, 2] + lean[:, 3]) / 2.0
    return np.column_stack([
        M, early, late, late - early,
        np.abs(np.sign(lean).sum(axis=1)) / len(HORIZONS),
        np.abs(np.sign(means).sum(axis=1)) / len(HORIZONS),
        ups.max(axis=1) - ups.min(axis=1), means.mean(axis=1), means[:, 3] - means[:, 0],
    ])


def traj_feature_names():
    names = [f"h{h}_{c}" for h in HORIZONS for c in TRAJ_COLS_PER_H]
    return names + ["early_lean", "late_lean", "reversal_axis", "agree_direction",
                    "agree_mean_sign", "up_prob_spread", "mean_of_means", "long_minus_short_mean"]


def parity_prediction(specialists, traj_heads, X, cols, idx, temperature):
    """A compact, deterministic Python reference for the served JSON-tree artifact.

    The lifecycle compares this output with DirectionTrajectory.predict in TypeScript on exactly
    the same feature rows before a candidate can pass its feature-parity gate.  Keep the formulas
    aligned with the runtime rather than using LightGBM's predictor here: this checks exported tree
    traversal, softmax/calibration, trajectory-vector order and missing-value routing as served.
    """
    blocks = {h: specialist_block(specialists[h], X[[idx]][:, cols]) for h in HORIZONS}
    vec = build_traj_features(blocks)
    raw = np.column_stack([score_artifact(traj_heads["cls"]["perClass"][k]["trees"], 0.0, vec)
                           for k in range(len(PATHS))])
    probabilities = softmax(raw / temperature)[0]
    by_path = {PATHS[i]: float(probabilities[i]) for i in range(len(PATHS))}
    rows = [blocks[h][0] for h in HORIZONS]
    lean = [row[2] - row[0] for row in rows]
    means = [row[3] for row in rows]
    early = (lean[0] + lean[1]) / 2.0
    late = (lean[2] + lean[3]) / 2.0
    reversal = by_path["UP_THEN_REVERSAL"] + by_path["DOWN_THEN_REVERSAL"]
    persistence = by_path["PERSISTENT_UP"] - by_path["PERSISTENT_DOWN"]
    agreement = abs(sum(1 if value > 0 else (-1 if value < 0 else 0) for value in lean)) / len(HORIZONS)
    confidence = max(0.0, min(1.0,
        0.50 * abs(persistence) + 0.30 * agreement + 0.20 * max(0.0, 1.0 - 2.0 * reversal)))
    horizon_rows = []
    for horizon, row in zip(HORIZONS, rows):
        q10, q50, q90 = sorted([float(row[4]), float(row[5]), float(row[6])])
        horizon_rows.append({
            "horizon": horizon,
            "pStrongDown": float(row[0]), "pNeutral": float(row[1]), "pStrongUp": float(row[2]),
            "expectedReturn": float(row[3]), "q10": q10, "q50": q50, "q90": q90,
            "expectedVol": float(row[7]),
        })
    q10, q50, q90 = sorted([float(rows[-1][4]), float(rows[-1][5]), float(rows[-1][6])])
    top_idx = int(np.argmax(probabilities))
    return {
        "pathProbabilities": by_path,
        "topPath": PATHS[top_idx],
        "topPathProbability": float(probabilities[top_idx]),
        "persistenceScore": float(persistence),
        "reversalRisk": float(reversal),
        "earlyLean": float(early),
        "lateLean": float(late),
        "reversalAxis": float(late - early),
        "expectedReturn": float(rows[-1][3]),
        "q10": q10, "q50": q50, "q90": q90, "expectedVol": float(rows[-1][7]),
        "confidence": float(confidence), "horizonAgreement": float(agreement),
        "horizons": horizon_rows,
    }


def write_parity_fixture(path_out, artifact, t, names, X, cols, ho, specialists, traj_heads, temperature):
    # Deterministic spread across the newest chronological block. Twenty-four is enough to cover
    # ordinary and missing-value rows while keeping the run artifact small and auditable.
    count = min(24, len(ho))
    if count < 1:
        raise SystemExit("FATAL: no holdout rows available for Python/TypeScript parity fixture")
    positions = np.unique(np.linspace(0, len(ho) - 1, num=count, dtype=int))
    served = [names[i] for i in cols]
    samples = []
    for position in positions:
        idx = int(ho[position])
        features = {}
        for name, column in zip(served, cols):
            value = X[idx, column]
            features[name] = None if np.isnan(value) else float(value)
        samples.append({
            "formationTimestampMs": int(t[idx]),
            "features": features,
            "prediction": parity_prediction(specialists, traj_heads, X, cols, idx, temperature),
        })
    with open(path_out, "w") as fh:
        json.dump({
            "schemaVersion": 1,
            "artifactVersion": artifact["version"],
            "featureNames": served,
            "samples": samples,
        }, fh)


def main():
    positional = [arg for arg in sys.argv[1:] if not arg.startswith("--parity-out=")]
    parity_arg = next((arg for arg in sys.argv[1:] if arg.startswith("--parity-out=")), None)
    if len(positional) != 2 or (parity_arg is not None and not parity_arg.split("=", 1)[1]):
        raise SystemExit("usage: train-trajectory-v4.py <matrixCsv> <outJson> [--parity-out=<json>]")
    csv_path, out_path = positional
    parity_out = parity_arg.split("=", 1)[1] if parity_arg is not None else None
    t, names, X, labels, path = load(csv_path)
    n = len(path)
    cols = served_cols(names)
    served = [names[i] for i in cols]
    tr, va, ho = purged_split(n)
    if min(len(tr), len(va), len(ho)) < 500:
        raise SystemExit("FATAL: insufficient purged chronological sample for V4 training")
    print(f"rows={n} served_features={len(served)} eff_independent~{n // EMBARGO}")
    print(f"train={len(tr)} val={len(va)} holdout={len(ho)} (embargo {EMBARGO})")
    print(f"configs evaluated: {CONFIGS_EVALUATED}")
    for split_name, idx in (("TRAIN", tr), ("VAL", va), ("HOLDOUT", ho)):
        c = np.bincount(path[idx], minlength=len(PATHS))
        parts = "  ".join(f"{PATHS[i][:14]}={c[i]}({100*c[i]/len(idx):.1f}%)" for i in range(len(PATHS)) if c[i])
        print(f"{split_name:<8} {parts}")

    counts36 = np.bincount(labels[36]["cls"][tr], minlength=3).astype(float)
    cw = counts36.sum() / (3.0 * np.clip(counts36, 1, None))

    edges = np.linspace(0, len(tr), N_FOLDS + 1).astype(int)
    oof = {h: np.full((len(tr), 8), np.nan) for h in HORIZONS}
    for k in range(N_FOLDS):
        lo, hi = edges[k], edges[k + 1]
        test_idx = np.arange(lo, hi)
        fit_idx = np.concatenate([np.arange(0, max(0, lo - EMBARGO)),
                                  np.arange(min(len(tr), hi + EMBARGO), len(tr))])
        if len(fit_idx) < 500 or not len(test_idx):
            continue
        gf, gt = tr[fit_idx], tr[test_idx]
        for h in HORIZONS:
            lab = {kk: vv[gf] for kk, vv in labels[h].items()}
            hd = fit_specialist(X[gf], lab, cols, cw[labels[36]["cls"][gf]])
            oof[h][test_idx] = specialist_block(hd, X[gt][:, cols])
        print(f"OOF fold {k+1}/{N_FOLDS}", flush=True)
    ok = ~np.isnan(oof[36]).any(axis=1)
    if ok.sum() < 500:
        raise SystemExit("FATAL: insufficient valid OOF specialist rows")

    specialists = {}
    for h in HORIZONS:
        specialists[h] = fit_specialist(X[tr], {kk: vv[tr] for kk, vv in labels[h].items()}, cols, cw[labels[36]["cls"][tr]])
        print(f"specialist H{h}", flush=True)

    Mtr = build_traj_features({h: oof[h][ok] for h in HORIZONS})
    ytr = path[tr][ok]
    pc = np.bincount(ytr, minlength=len(PATHS)).astype(float)
    pw = pc.sum() / (len(PATHS) * np.clip(pc, 1, None))
    p = dict(TRAJ); p.update(objective="multiclass", num_class=len(PATHS))
    traj = lgb.train(p, lgb.Dataset(Mtr, label=ytr, weight=pw[ytr], free_raw_data=False), num_boost_round=TRAJ_ROUNDS)
    traj_heads = {"cls": {"kind": "softmax", "classes": PATHS,
                            "perClass": [{"baseline": 0.0, "trees": tt} for tt in export_trees(traj, len(PATHS))]}}

    def traj_block(idx):
        return build_traj_features({h: specialist_block(specialists[h], X[idx][:, cols]) for h in HORIZONS})

    Mva = traj_block(va)
    lib = traj.predict(Mva[:300], raw_score=True)
    dev = 0.0
    for k in range(len(PATHS)):
        art = score_artifact(traj_heads["cls"]["perClass"][k]["trees"], 0.0, Mva[:300])
        dev = max(dev, float(np.max(np.abs(lib[:, k] - art))))
    print(f"export fidelity (trajectory) = {dev:.3e}")
    if dev > 1e-6:
        raise SystemExit("FATAL: exported artifact does not reproduce fitted trajectory model")

    raw_va = np.column_stack([score_artifact(traj_heads["cls"]["perClass"][k]["trees"], 0.0, Mva)
                              for k in range(len(PATHS))])
    y_va = path[va]
    best_T, best_ll = 1.0, logloss(softmax(raw_va), y_va)
    for T in np.arange(0.6, 8.01, 0.05):
        ll = logloss(softmax(raw_va / T), y_va)
        if ll < best_ll:
            best_ll, best_T = ll, float(T)
    print(f"trajectory calibration T={best_T:.2f} val logloss {logloss(softmax(raw_va), y_va):.5f}->{best_ll:.5f}")

    base_path = np.bincount(path[tr], minlength=len(PATHS)) / len(tr)

    def report(idx, label, T):
        M = traj_block(idx)
        raw = np.column_stack([score_artifact(traj_heads["cls"]["perClass"][k]["trees"], 0.0, M)
                               for k in range(len(PATHS))])
        P = softmax(raw / T)
        y = path[idx]
        pred = P.argmax(axis=1)
        bp = np.tile(base_path, (len(y), 1))
        ba = balacc(pred, y, len(PATHS))
        lo, hi = block_ci(lambda i2: balacc(pred[i2], y[i2], len(PATHS)), len(y))
        print(f"TRAJECTORY {label} n={len(idx)} logloss={logloss(P, y):.5f} base-rate={logloss(bp, y):.5f} balacc={ba:.4f} CI95[{lo:.4f},{hi:.4f}]")
        return P, y

    report(va, "VALIDATION", best_T)
    P_ho, y_ho = report(ho, "FINAL_HOLDOUT", best_T)
    for h in HORIZONS:
        B = specialist_block(specialists[h], X[ho][:, cols])
        P = B[:, :3]
        y = labels[h]["cls"][ho]
        br = np.bincount(labels[h]["cls"][tr], minlength=3) / len(tr)
        print(f"H{h} logloss={logloss(P, y):.5f} base={logloss(np.tile(br, (len(y),1)), y):.5f} balacc={balacc(P.argmax(axis=1), y, 3):.4f} corr={np.corrcoef(B[:,3], labels[h]['r'][ho])[0,1]:+.4f}")
    # Keep objects referenced for integrity diagnostics; assertions above are the source of truth.
    assert P_ho.shape[0] == len(y_ho)

    artifact = {
        "version": f"dm-36h-v4-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "schemaVersion": 4,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "horizonBars": 36,
        "horizons": HORIZONS,
        "trainingPopulation": "ADMISSION_CONDITIONED",
        "featureNames": served,
        "trajectoryFeatureNames": traj_feature_names(),
        "classes": CLASSES,
        "pathClasses": PATHS,
        "zBoundary": Z_BOUNDARY,
        "calibrationTemperature": best_T,
        "configsEvaluated": CONFIGS_EVALUATED,
        "trainRows": int(len(tr)),
        "pathCounts": {PATHS[i]: int(c) for i, c in enumerate(np.bincount(path[tr], minlength=len(PATHS)))},
        "trainSpan": {"fromMs": int(t[tr[0]]), "toMs": int(t[tr[-1]])},
        "specialists": {str(h): specialists[h] for h in HORIZONS},
        "trajectory": traj_heads,
    }
    with open(out_path, "w") as fh:
        json.dump(artifact, fh)
    if parity_out:
        write_parity_fixture(parity_out, artifact, t, names, X, cols, ho, specialists, traj_heads, best_T)
        print(f"wrote Python/TypeScript parity fixture {parity_out}")
    print(f"wrote {out_path} version={artifact['version']}")


if __name__ == "__main__":
    main()
