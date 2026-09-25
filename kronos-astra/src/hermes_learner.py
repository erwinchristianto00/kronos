"""Hermes learner v2: AVOID / PREFER / UNCERTAIN priors from market-context patterns.

Every frozen plan is labelled by replaying its own geometry on Testnet 1m candles and
described by its market context at creation time (hermes_context). Patterns are one or
two context atoms. A pattern moves through

  CANDIDATE_LESSON -> SUPPORTED -> ACTIVE_PRIOR -> STRONG      (CONTRADICTED -> RETIRED)

Discovery uses history (N>=5, expectancy >=0.2R away from baseline). Every later level
also needs PROSPECTIVE evidence: episodes created after the pattern was discovered.
Measured on this lane's own history, the discovery thresholds alone produced as many
"active priors" from shuffled outcomes as from real ones (36 real vs 38.7 null), so
history can nominate a pattern but only the future can confirm it.

ACTIVE_PRIOR and STRONG lessons reach Sonnet as priors in the CANDIDATE arm only; PREFER
never enters by itself. STRONG AVOID is also a host block in that arm. CONTROL receives
nothing, so the A/B report can show whether priors improve decisions over baseline.
"""
import copy
import hashlib
import json
import math
import os
import statistics
import sys
import time
import urllib.request
from pathlib import Path

import hermes_context as ctxmod

VERSION = "HERMES_LEARNER_V3"
STATE_NAME = "hermes-learner-v3.json"
STUDY_KIND = "HERMES_LEARNER"
LEARNER_VERSION_ID = "hermes_learner_v1"   # the registered A/B study version; unchanged
KLINES_URL = "https://testnet.binancefuture.com/fapi/v1/klines"
FEE_BPS_PER_SIDE = 4.0
MINUTE = 60000
BAR5 = 300000
DAY = 86400000
TRIGGER_WINDOW_CAP_MS = 24 * 3600 * 1000
EPISODE_MS = 4 * 3600 * 1000
LABELS_PER_TICK = 6
CONTEXTS_PER_TICK = 10
TICK_BUDGET_S = 90
MAX_OPEN_LESSONS = 40
LEVELS = ("CANDIDATE_LESSON", "SUPPORTED", "ACTIVE_PRIOR", "STRONG")
DELIVERED = ("ACTIVE_PRIOR", "STRONG")
T = {  # thresholds; R = net after costs / planned stop distance
    "candidateN": 5, "materialR": 0.2,
    "supportedN": 10, "supportedProspectiveN": 5,
    "activeN": 15, "activeProspectiveN": 8, "activeProspectiveT": 1.65, "maxSymbolShare": 0.4,
    "strongN": 30, "strongProspectiveN": 15, "strongProspectiveT": 2.33, "strongRegimes": 2,
    "contradictProspectiveN": 5, "contradictT": 1.0, "retireProspectiveN": 10, "retireT": 1.65,
    "contradictedRetireDays": 14, "staleCandidateDays": 21,
    # An AVOID prior must save materially more losing R than the winning R it throws away,
    # and a PREFER prior must beat comparable plans (same side/setup/regime), not just baseline.
    "avoidSavedToSkippedMin": 1.5, "preferMinComparableN": 5, "preferMinUpliftR": 0.1,
}
BINS_HASH = hashlib.sha256(json.dumps([ctxmod.BINS, ctxmod.CATEGORICAL, T], sort_keys=True).encode()).hexdigest()


def now_ms():
    return int(time.time() * 1000)


def _finite(x):
    return type(x) in (int, float) and math.isfinite(x)


def stop_bps(plan):
    return abs(float(plan["triggerPrice"]) - float(plan["stopPrice"])) / float(plan["triggerPrice"]) * 1e4


# ---------------------------------------------------------------- labelling

def fetch_klines(symbol, start, end, opener=None):
    opener = opener or urllib.request.urlopen
    out, t = [], int(start)
    while t < end:
        url = "%s?symbol=%s&interval=1m&startTime=%d&endTime=%d&limit=499" % (KLINES_URL, symbol, t, int(end))
        rows = json.load(opener(url, timeout=15))
        if not rows:
            break
        out.extend(rows)
        t = int(rows[-1][0]) + MINUTE
        if len(rows) < 499:
            break
        time.sleep(0.3)
    return [(int(r[0]), float(r[2]), float(r[3]), float(r[4])) for r in out]


def label_window(wrapper):
    p = wrapper["plan"]
    created = int(wrapper["createdAt"])
    trigger_end = min(int(p.get("expiresAt") or created + TRIGGER_WINDOW_CAP_MS), created + TRIGGER_WINDOW_CAP_MS)
    hold = int(p.get("maxHoldMs") or 4 * 3600000)
    return created, trigger_end, trigger_end + hold + 5 * MINUTE


def simulate(plan, created, trigger_end, bars):
    """Host semantics: trigger on the last CLOSED 5m close, entry price inside the band.

    1m close stands in for the executable quote. Stop wins a bar that touches both.
    Net is after taker fees on both sides plus the plan's own slippage allowances.
    """
    side = plan["side"]
    sgn = 1 if side == "LONG" else -1
    above = plan["triggerKind"] == "CLOSE_ABOVE"
    trig, lo, hi = plan["triggerPrice"], plan["entryMin"], plan["entryMax"]
    stop, target = plan["stopPrice"], plan["targetPrice"]
    last5 = None
    entry_i = None
    for i, (t, h, l, c) in enumerate(bars):
        if t + MINUTE > trigger_end:
            break
        if (t + MINUTE) % BAR5 == 0:
            last5 = c  # closes a 5m candle; the host reads the latest one, even pre-creation
        if t < created:
            continue
        fired = last5 is not None and ((last5 >= trig) if above else (last5 <= trig))
        if fired and lo <= c <= hi:
            entry_i = i
            break
    if entry_i is None:
        return {"status": "NOT_TRIGGERED"}
    entry = bars[entry_i][3]
    t0 = bars[entry_i][0]
    end = t0 + MINUTE + int(plan.get("maxHoldMs") or 4 * 3600000)
    status, px, minutes = "TIMEOUT", entry, None
    for t, h, l, c in bars[entry_i + 1:]:
        if t >= end:
            break
        hit_stop = l <= stop if side == "LONG" else h >= stop
        hit_target = h >= target if side == "LONG" else l <= target
        if hit_stop:
            status, px, minutes = "STOP", stop, (t - t0) / MINUTE
            break
        if hit_target:
            status, px, minutes = "TARGET", target, (t - t0) / MINUTE
            break
        px = c
    gross = sgn * (px - entry) / entry * 1e4
    net = gross - 2 * FEE_BPS_PER_SIDE - float(plan.get("entrySlippageBps") or 0) - float(plan.get("exitSlippageBps") or 0)
    return {"status": status, "entry": entry, "enteredAt": t0, "exit": px, "minutes": minutes,
            "grossBps": round(gross, 2), "netBps": round(net, 2)}


# ---------------------------------------------------------------- statistics

def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def _welch_t(a, b):
    """t of mean(a) - mean(b); None when either side is too small."""
    if len(a) < 2 or len(b) < 2:
        return None
    se = math.sqrt(statistics.variance(a) / len(a) + statistics.variance(b) / len(b))
    diff = _mean(a) - _mean(b)
    if se > 0:
        return max(-99.0, min(99.0, diff / se))
    return 0.0 if diff == 0 else math.copysign(99.0, diff)  # identical outcomes: certain, capped


def _pf(xs):
    win = sum(x for x in xs if x > 0)
    loss = -sum(x for x in xs if x < 0)
    return round(win / loss, 3) if loss > 0 else None


def perf(xs):
    """Distribution of a chronological R series; never just the mean."""
    if not xs:
        return {"n": 0, "expectancyR": None, "pf": None, "winRate": None, "avgWinR": None, "avgLossR": None,
                "payoffRatio": None, "maxDrawdownR": None, "sumR": 0.0}
    wins = [x for x in xs if x > 0]
    losses = [x for x in xs if x <= 0]
    peak = equity = dd = 0.0
    for x in xs:
        equity += x
        peak = max(peak, equity)
        dd = max(dd, peak - equity)
    aw = _mean(wins) if wins else None
    al = _mean(losses) if losses else None
    return {"n": len(xs), "expectancyR": round(_mean(xs), 3), "pf": _pf(xs),
            "winRate": round(len(wins) / len(xs), 3), "avgWinR": round(aw, 3) if aw is not None else None,
            "avgLossR": round(al, 3) if al is not None else None,
            "payoffRatio": round(aw / -al, 3) if aw is not None and al not in (None, 0) else None,
            "maxDrawdownR": round(dd, 3), "sumR": round(sum(xs), 3)}


STRATA = ("side", "setupType", "regime")


def stratum(atoms, exclude=()):
    """Comparable-plan key; features the pattern itself fixes are left out."""
    d = dict(atoms)
    return tuple(d.get(f) for f in STRATA if f not in exclude)


def avoidance(xs):
    """What blocking these episodes would have done: losers avoided vs winners skipped."""
    wins = [x for x in xs if x > 0]
    losses = [x for x in xs if x <= 0]
    saved, skipped = -sum(losses), sum(wins)
    return {"avoidedLosers": len(losses), "avoidedLossR": round(saved, 3),
            "skippedWinners": len(wins), "skippedWinR": round(skipped, 3),
            "netBlockValueR": round(saved - skipped, 3),
            "savedToSkippedRatio": round(saved / skipped, 3) if skipped > 0 else (99.0 if saved > 0 else None)}


def uplift(mine, others, pattern=()):
    """Pattern vs matched comparable plans: same side, setup type and regime, except the
    features the pattern itself is defined by."""
    fixed = {f for f, _ in pattern}
    pools = {}
    for e in others:
        pools.setdefault(stratum(e["atoms"], fixed), []).append(e["R"])
    diffs, comparable = [], 0
    for e in mine:
        pool = pools.get(stratum(e["atoms"], fixed))
        if pool:
            diffs.append(e["R"] - _mean(pool))
            comparable += 1
    matched_pool = sum(len(pools.get(k, [])) for k in {stratum(e["atoms"], fixed) for e in mine})
    return {"matchedN": comparable, "comparablePoolN": matched_pool,
            "upliftVsComparableR": round(_mean(diffs), 3) if diffs else None}


def _normal_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def episodes(rows):
    """Overlapping plans (same symbol+side inside 4h) are ONE independent episode."""
    groups = {}
    for r in rows:
        groups.setdefault((r["symbol"], r["side"], r["createdAt"] // EPISODE_MS), []).append(r)
    out = []
    for (symbol, side, _), rs in groups.items():
        rs = sorted(rs, key=lambda r: r["createdAt"])
        out.append({"key": rs[0]["key"], "keys": [r["key"] for r in rs], "symbol": symbol, "side": side,
                    "createdAt": rs[0]["createdAt"], "R": _mean([r["R"] for r in rs]),
                    "atoms": frozenset(rs[0]["atoms"]), "regime": rs[0]["regime"]})
    return sorted(out, key=lambda e: e["createdAt"])


def pattern_key(pattern):
    return "|".join("%s=%s" % a for a in sorted(pattern))


def pattern_of(key):
    return tuple(tuple(x.split("=", 1)) for x in key.split("|"))


def matches(pattern, atoms):
    return all(tuple(a) in atoms for a in pattern)


def evaluate(pattern, direction, eps, since):
    """All numbers a lesson carries, from scratch, for one pattern and claim."""
    s = 1 if direction == "PREFER" else -1
    base = _mean([e["R"] for e in eps])
    mine = [e for e in eps if matches(pattern, e["atoms"])]
    xs = [e["R"] for e in mine]
    post = [e for e in eps if e["createdAt"] >= since]
    post_mine = [e for e in post if matches(pattern, e["atoms"])]
    post_rest = [e["R"] for e in post if not matches(pattern, e["atoms"])]
    pxs = [e["R"] for e in post_mine]
    stats = perf(xs)
    out = {"sampleN": len(xs), "baselineR": round(base, 3) if base is not None else None,
           "expectancyR": stats["expectancyR"], "winRate": stats["winRate"], "pf": stats["pf"],
           "avgWinR": stats["avgWinR"], "avgLossR": stats["avgLossR"], "payoffRatio": stats["payoffRatio"],
           "maxDrawdownR": stats["maxDrawdownR"],
           "baseline": perf([e["R"] for e in eps]), "prospective": perf(pxs),
           "ifBlocked": avoidance(xs), "prospectiveIfBlocked": avoidance(pxs),
           "vsComparable": uplift(mine, [e for e in eps if not matches(pattern, e["atoms"])], pattern),
           "prospectiveN": len(pxs), "prospectiveExpectancyR": round(_mean(pxs), 3) if pxs else None,
           "prospectiveBaselineR": round(_mean([e["R"] for e in post]), 3) if post else None,
           "symbols": len({e["symbol"] for e in mine}), "regimes": len({e["regime"] for e in mine})}
    t = _welch_t(pxs, post_rest)
    out["prospectiveT"] = round(s * t, 3) if t is not None else None  # >0 = supports the claim
    out["confidence"] = round(_normal_cdf(s * t), 3) if t is not None else None
    if xs:
        syms = {}
        for e in mine:
            syms[e["symbol"]] = syms.get(e["symbol"], 0) + 1
        out["maxSymbolShare"] = round(max(syms.values()) / len(xs), 3)
        ordered = sorted(xs, reverse=(s > 0))  # drop the single episode most favourable to the claim
        out["leaveOneOutR"] = round(_mean(ordered[1:]), 3) if len(ordered) > 1 else None
        half = len(xs) // 2
        out["halvesR"] = [round(_mean(xs[:half]), 3) if half else None, round(_mean(xs[half:]), 3)]
        regs = {}
        for e in mine:
            regs.setdefault(e["regime"], []).append(e["R"])
        out["byRegime"] = {k: {"n": len(v), "R": round(_mean(v), 3)} for k, v in regs.items()}
    support = [e for e in mine if s * e["R"] > 0 or (s < 0 and e["R"] <= 0)]
    against = [e for e in mine if e not in support]
    out["supportingExamples"] = [e["key"] for e in support[-5:]]
    out["contradictingExamples"] = [e["key"] for e in against[-5:]]
    return out


def on_side(value, base, s, margin=0.0):
    return value is not None and base is not None and s * (value - base) > margin


def level_of(direction, ev):
    """Highest level the evidence reaches (index into LEVELS), -1 if not even a candidate."""
    s = 1 if direction == "PREFER" else -1
    n, ex, base = ev["sampleN"], ev["expectancyR"], ev["baselineR"]
    if n < T["candidateN"] or ex is None or not on_side(ex, base, s, T["materialR"] - 1e-12) or s * ex <= 0:
        return -1
    level = 0
    halves = ev.get("halvesR") or [None, None]
    if (n >= T["supportedN"] and all(on_side(h, base, s) for h in halves)
            and ev["prospectiveN"] >= T["supportedProspectiveN"]
            and on_side(ev["prospectiveExpectancyR"], ev["prospectiveBaselineR"], s)):
        level = 1
    else:
        return level
    if s < 0:
        block = ev.get("ifBlocked") or {}
        ratio = block.get("savedToSkippedRatio")
        balanced = ratio is not None and ratio >= T["avoidSavedToSkippedMin"]
    else:
        comp = ev.get("vsComparable") or {}
        balanced = (comp.get("matchedN", 0) >= T["preferMinComparableN"]
                    and (comp.get("upliftVsComparableR") or 0) >= T["preferMinUpliftR"])
    if (n >= T["activeN"] and ev["maxSymbolShare"] <= T["maxSymbolShare"] and balanced
            and on_side(ev["leaveOneOutR"], base, s)
            and ev["prospectiveN"] >= T["activeProspectiveN"]
            and (ev["prospectiveT"] or 0) >= T["activeProspectiveT"]):
        level = 2
    else:
        return level
    stable = sum(1 for v in ev["byRegime"].values() if v["n"] >= 5 and on_side(v["R"], base, s))
    if (n >= T["strongN"] and ev["prospectiveN"] >= T["strongProspectiveN"]
            and (ev["prospectiveT"] or 0) >= T["strongProspectiveT"] and stable >= T["strongRegimes"]):
        level = 3
    return level


def contradicted(ev):
    return (ev["prospectiveN"] >= T["contradictProspectiveN"] and ev["prospectiveT"] is not None
            and ev["prospectiveT"] <= -T["contradictT"])


def discover(eps):
    """History nominates: every 1- and 2-atom pattern meeting the candidate rule."""
    base = _mean([e["R"] for e in eps])
    atoms = sorted({a for e in eps for a in e["atoms"]})
    patterns = [(a,) for a in atoms] + [(a, b) for i, a in enumerate(atoms) for b in atoms[i + 1:] if a[0] != b[0]]
    found = []
    for p in patterns:
        xs = [e["R"] for e in eps if matches(p, e["atoms"])]
        if len(xs) < T["candidateN"]:
            continue
        ex = _mean(xs)
        d = ex - base
        if abs(d) < T["materialR"]:
            continue
        direction = "PREFER" if d > 0 else "AVOID"
        if (direction == "PREFER" and ex <= 0) or (direction == "AVOID" and ex >= 0):
            continue
        rest = [e["R"] for e in eps if not matches(p, e["atoms"])]
        t = _welch_t(xs, rest)
        found.append({"pattern": p, "direction": direction, "n": len(xs), "t": abs(t) if t is not None else 0.0})
    found.sort(key=lambda f: (-f["t"], -f["n"]))
    return found


# ---------------------------------------------------------------- state

def state_path(root):
    return Path(root) / "hermes-home" / STATE_NAME


def empty_state():
    return {"version": VERSION, "binsHash": BINS_HASH, "labels": {}, "contexts": {}, "lessons": {},
            "verdicts": {}, "events": [], "summary": None, "updatedAt": None}


def load_state(root):
    path = state_path(root)
    if not path.exists():
        return empty_state()
    state = json.loads(path.read_text())
    if state.get("version") != VERSION or state.get("binsHash") != BINS_HASH:
        raise ValueError("Learner version/bins changed; explicit migration required")
    return state


def save_state(root, state):
    path = state_path(root)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w") as f:
        os.chmod(tmp, 0o640)
        json.dump(state, f, allow_nan=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    keep = path.stat() if path.exists() else None
    tmp.replace(path)
    if keep and (keep.st_uid, keep.st_gid) != (os.geteuid(), os.getegid()):
        os.chown(path, keep.st_uid, keep.st_gid)


def read_state_quiet(root):
    try:
        return load_state(root)
    except (OSError, ValueError):
        return None


def plan_key(wrapper):
    return "%s@%d" % (wrapper["plan"]["id"], int(wrapper["createdAt"]))


def load_plans(root):
    data = json.loads((Path(root) / "hermes-home" / "astra-plans.json").read_text())
    plans = data.get("plans") or []
    return list(plans.values()) if isinstance(plans, dict) else plans


def load_arms(root):
    path = Path(root) / "hermes-home" / "astra-experiments.json"
    if not path.exists():
        return {}, None
    ex = json.loads(path.read_text())
    study = next((s for s in reversed(ex.get("studies", [])) if s.get("kind") == STUDY_KIND), None)
    arms = {}
    for pid, v in ex.get("planVersions", {}).items():
        if study and v.get("version") == study["candidate"]:
            arms[pid] = "CANDIDATE"
        elif study and v.get("version") == study["control"] and v.get("at", 0) >= study["registeredAt"]:
            arms[pid] = "CONTROL"
        else:
            arms[pid] = "INCUMBENT"
    return arms, study


# ---------------------------------------------------------------- priors

def lesson_view(l):
    ev = l.get("evidence") or {}
    return {"id": l["id"], "verdict": l["direction"], "status": l["status"], "pattern": l["description"],
            "sampleN": ev.get("sampleN"), "prospectiveN": ev.get("prospectiveN"),
            "winRate": ev.get("winRate"), "expectancyR": ev.get("expectancyR"), "baselineR": ev.get("baselineR"),
            "pf": ev.get("pf"), "avgWinR": ev.get("avgWinR"), "avgLossR": ev.get("avgLossR"),
            "maxDrawdownR": ev.get("maxDrawdownR"), "ifBlocked": ev.get("ifBlocked"),
            "vsComparable": ev.get("vsComparable"), "confidence": ev.get("confidence"), "symbols": ev.get("symbols"),
            "regimes": ev.get("regimes"), "lastUpdated": l.get("lastUpdated")}


def verdict_for(state, atoms):
    """AVOID / PREFER / UNCERTAIN from delivered lessons that match these context atoms."""
    atoms = frozenset(tuple(a) for a in atoms)
    hits = [l for l in (state or {}).get("lessons", {}).values()
            if l["status"] in DELIVERED and matches(pattern_of(l["patternKey"]), atoms)]
    avoid = [l["id"] for l in hits if l["direction"] == "AVOID"]
    prefer = [l["id"] for l in hits if l["direction"] == "PREFER"]
    if avoid and prefer:
        v = "UNCERTAIN"
    elif avoid:
        v = "AVOID"
    elif prefer:
        v = "PREFER"
    else:
        v = "UNCERTAIN"
    return {"verdict": v, "avoidLessons": avoid, "preferLessons": prefer,
            "strongAvoid": [l["id"] for l in hits if l["direction"] == "AVOID" and l["status"] == "STRONG"],
            "conflict": bool(avoid and prefer)}


def fast_context(state, arm, plan_ids=()):
    """What Sonnet sees. CONTROL and INCUMBENT cycles get no priors at all."""
    if arm != "CANDIDATE" or not state:
        return {"version": VERSION, "arm": arm, "lessons": [], "planPriors": {},
                "meaning": "No Hermes priors in this arm; decide on your own evidence."}
    lessons = [lesson_view(l) for l in state.get("lessons", {}).values() if l["status"] in DELIVERED]
    lessons.sort(key=lambda l: (l["status"] != "STRONG", -(l["confidence"] or 0)))
    priors = {pid: state["verdicts"][pid] for pid in plan_ids if pid in state.get("verdicts", {})}
    return {"version": VERSION, "arm": arm, "lessons": lessons[:10], "planPriors": priors,
            "meaning": "Hermes priors learned from counterfactual outcomes of past plans in their market context. "
                       "PREFER is a prior, never an instruction to enter; AVOID lowers the prior; UNCERTAIN means "
                       "no confirmed lesson applies. STRONG AVOID plans are rejected by the host in this arm. "
                       "Judge the live setup yourself and say in your reason whether a prior changed your decision."}


def lesson_text(l):
    ev = l.get("evidence") or {}
    b = ev.get("ifBlocked") or {}
    c = ev.get("vsComparable") or {}
    return ("Hermes %s %s [%s]: %s -> N=%s (prospective %s), win %s, expectancy %sR vs baseline %sR, PF %s, "
            "avg win %sR / avg loss %sR, maxDD %sR; if blocked: %s losers (%sR) avoided vs %s winners (%sR) "
            "skipped; vs comparable plans %sR (n=%s); confidence %s"
            % (l["id"], l["direction"], l["status"], l["description"], ev.get("sampleN"), ev.get("prospectiveN"),
               ev.get("winRate"), ev.get("expectancyR"), ev.get("baselineR"), ev.get("pf"), ev.get("avgWinR"),
               ev.get("avgLossR"), ev.get("maxDrawdownR"), b.get("avoidedLosers"), b.get("avoidedLossR"),
               b.get("skippedWinners"), b.get("skippedWinR"), c.get("upliftVsComparableR"), c.get("matchedN"),
               ev.get("confidence")))


def screen(state, plan_wrapper, arm, context_builder=None):
    """Host block: only STRONG AVOID, only in the CANDIDATE arm. Unknown context blocks nothing."""
    if arm != "CANDIDATE" or not state:
        return []
    strong = [l for l in state.get("lessons", {}).values() if l["status"] == "STRONG" and l["direction"] == "AVOID"]
    if not strong:
        return []
    ctx = state.get("contexts", {}).get(plan_key(plan_wrapper))
    if ctx is None and context_builder is not None:
        try:
            ctx = context_builder(plan_wrapper)
        except Exception:
            ctx = None
    if not ctx:
        return []
    atoms = frozenset(ctxmod.atoms(ctx))
    return [l for l in strong if matches(pattern_of(l["patternKey"]), atoms)]


# ---------------------------------------------------------------- one tick

def label_due(state, plans, now, fetch, budget_s=None, limit=None):
    budget_s = TICK_BUDGET_S if budget_s is None else budget_s
    limit = LABELS_PER_TICK if limit is None else limit
    started = time.monotonic()
    done = 0
    for w in sorted(plans, key=lambda w: w.get("createdAt", 0)):
        if done >= limit or time.monotonic() - started > budget_s:
            break
        key = plan_key(w)
        p = w.get("plan") or {}
        if key in state["labels"] or p.get("triggerKind") not in ("CLOSE_ABOVE", "CLOSE_BELOW") \
                or p.get("side") not in ("LONG", "SHORT"):
            continue
        try:
            stop_bps(p)
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            continue
        created, trigger_end, ready_at = label_window(w)
        if now < ready_at:
            continue
        try:
            bars = fetch(p["symbol"], created - 10 * MINUTE, ready_at)
        except Exception as error:
            state.setdefault("fetchErrors", []).append({"at": now, "key": key, "error": str(error)[:200]})
            state["fetchErrors"] = state["fetchErrors"][-20:]
            continue
        lab = simulate(p, created, trigger_end, bars) if bars else {"status": "NO_DATA"}
        lab.update(planId=p["id"], symbol=p["symbol"], side=p["side"], createdAt=created, labeledAt=now)
        state["labels"][key] = lab
        done += 1
    return done


def context_due(state, plans, now, builder, limit=None):
    limit = CONTEXTS_PER_TICK if limit is None else limit
    done = 0
    # newest first: live plans need a prior before the older backlog
    for w in sorted(plans, key=lambda w: -w.get("createdAt", 0)):
        if done >= limit:
            break
        key = plan_key(w)
        if key in state["contexts"] or (w.get("plan") or {}).get("side") not in ("LONG", "SHORT"):
            continue
        try:
            state["contexts"][key] = builder(w)
        except Exception as error:
            state.setdefault("fetchErrors", []).append({"at": now, "key": key, "error": "context: " + str(error)[:180]})
            state["fetchErrors"] = state["fetchErrors"][-20:]
            continue
        done += 1
    return done


def default_builder(cache):
    def build(w):
        cost = (w.get("evaluations") or [{}])[0].get("costBps")
        return ctxmod.build(w["plan"], int(w["createdAt"]), cost, btc_cache=cache)
    return build


def rows_for(state, plans_by_key):
    rows = []
    for key, lab in state["labels"].items():
        ctx = state["contexts"].get(key)
        w = plans_by_key.get(key)
        if lab.get("status") not in ("STOP", "TARGET", "TIMEOUT") or not ctx or not w:
            continue
        rows.append({"key": key, "symbol": lab["symbol"], "side": lab["side"], "createdAt": lab["createdAt"],
                     "R": lab["netBps"] / stop_bps(w["plan"]), "atoms": ctxmod.atoms(ctx), "regime": ctx["regime"]})
    return rows


def update_lessons(state, eps, now):
    lessons, events = state["lessons"], state["events"]
    for l in lessons.values():
        if l["status"] == "RETIRED":
            continue
        ev = evaluate(pattern_of(l["patternKey"]), l["direction"], eps, l["discoveredAt"])
        l["evidence"], l["lastUpdated"] = ev, now
        previous = l["status"]
        if contradicted(ev):
            if previous != "CONTRADICTED":
                l.update(status="CONTRADICTED", contradictedAt=now)
            elif ((ev["prospectiveN"] >= T["retireProspectiveN"] and ev["prospectiveT"] <= -T["retireT"])
                  or now - l["contradictedAt"] >= T["contradictedRetireDays"] * DAY):
                l.update(status="RETIRED", retiredAt=now, retiredReason="Prospective evidence contradicts the claim")
        else:
            lvl = level_of(l["direction"], ev)
            if lvl < 0 and ev["prospectiveN"] >= T["contradictProspectiveN"]:
                l.update(status="RETIRED", retiredAt=now, retiredReason="No longer materially different from baseline")
            elif lvl < 0:
                l["status"] = "CANDIDATE_LESSON"
            else:
                l["status"] = LEVELS[lvl]
            if (l["status"] == "CANDIDATE_LESSON" and ev["prospectiveN"] == 0
                    and now - l["discoveredAt"] >= T["staleCandidateDays"] * DAY):
                l.update(status="RETIRED", retiredAt=now, retiredReason="No prospective evidence within window")
        l["evidenceStatus"] = {"CANDIDATE_LESSON": "HISTORY_ONLY_AWAITING_PROSPECTIVE",
                               "SUPPORTED": "PROSPECTIVE_DIRECTION_CONSISTENT",
                               "ACTIVE_PRIOR": "PROSPECTIVE_SIGNIFICANT_DELIVERED_AS_PRIOR",
                               "STRONG": "STABLE_ACROSS_SLICES_HOST_ENFORCED_IF_AVOID",
                               "CONTRADICTED": "PROSPECTIVE_EVIDENCE_AGAINST", "RETIRED": "RETIRED"}[l["status"]]
        if l["status"] != previous:
            events.append({"at": now, "lessonId": l["id"], "from": previous, "to": l["status"],
                           "evidence": {k: ev.get(k) for k in ("sampleN", "prospectiveN", "expectancyR",
                                                              "prospectiveExpectancyR", "prospectiveT")}})
    open_n = sum(1 for l in lessons.values() if l["status"] != "RETIRED")
    for f in discover(eps):
        if open_n >= MAX_OPEN_LESSONS:
            break
        key = pattern_key(f["pattern"])
        lid = "HL2-" + hashlib.sha256((key + f["direction"]).encode()).hexdigest()[:10]
        if lid in lessons:
            continue
        lesson = {"id": lid, "patternKey": key, "pattern": [list(a) for a in f["pattern"]],
                  "description": ctxmod.describe(f["pattern"]), "direction": f["direction"],
                  "scope": {"sides": sorted({v for k, v in f["pattern"] if k == "side"}) or ["LONG", "SHORT"],
                            "atoms": len(f["pattern"])},
                  "status": "CANDIDATE_LESSON", "discoveredAt": now, "lastUpdated": now}
        lesson["evidence"] = evaluate(f["pattern"], f["direction"], eps, now)
        lesson["evidenceStatus"] = "HISTORY_ONLY_AWAITING_PROSPECTIVE"
        lessons[lid] = lesson
        events.append({"at": now, "lessonId": lid, "from": None, "to": "CANDIDATE_LESSON",
                       "pattern": lesson["description"], "direction": f["direction"], "n": f["n"]})
        open_n += 1
    state["events"] = events[-300:]


def refresh_verdicts(state, plans, now):
    verdicts = {}
    for w in plans:
        ctx = state["contexts"].get(plan_key(w))
        if not ctx or (w["plan"].get("expiresAt") or 0) < now - DAY:
            continue
        verdicts[w["plan"]["id"]] = {**verdict_for(state, ctxmod.atoms(ctx)), "planKey": plan_key(w)}
        # The verdict the plan was born with is what the A/B judges; later lesson
        # changes never rewrite it.
        state.setdefault("verdictAtCreation", {}).setdefault(plan_key(w), {**verdicts[w["plan"]["id"]], "at": now})
    state["verdicts"] = verdicts


def ab_report(state, plans, arms, study):
    """Did priors improve DECISIONS? Full distributions, never only the mean.

    Per arm: what was entered, what was available, and for plans born with an AVOID or
    PREFER verdict what following or ignoring it cost. CONTROL plans get the same frozen
    verdicts as a shadow, so skipped winners / avoided losers are measured in both arms.
    """
    if not study:
        return None
    by_key = {plan_key(w): w for w in plans}
    born = state.get("verdictAtCreation", {})
    out = {}
    for arm in ("CANDIDATE", "CONTROL"):
        rows = []
        for key, lab in state["labels"].items():
            w = by_key.get(key)
            if (not w or arms.get(w["plan"]["id"]) != arm or lab["createdAt"] < study["registeredAt"]
                    or lab.get("status") not in ("STOP", "TARGET", "TIMEOUT")):
                continue
            ctx = state["contexts"].get(key)
            rows.append({"t": lab["createdAt"], "R": lab["netBps"] / stop_bps(w["plan"]),
                         "entered": bool(w.get("submissionId")), "verdict": (born.get(key) or {}).get("verdict", "UNKNOWN"),
                         "atoms": frozenset(ctxmod.atoms(ctx)) if ctx else frozenset()})
        rows.sort(key=lambda r: r["t"])
        entered = [r["R"] for r in rows if r["entered"]]
        avoid = [r for r in rows if r["verdict"] == "AVOID"]
        prefer = [r for r in rows if r["verdict"] == "PREFER"]
        rest = [r for r in rows if r["verdict"] != "PREFER"]
        out[arm] = {
            "entered": perf(entered), "allFilledPlans": perf([r["R"] for r in rows]),
            "selectionEdgeR": (round(_mean(entered) - _mean([r["R"] for r in rows]), 3) if entered and rows else None),
            "avoidSkipped": avoidance([r["R"] for r in avoid if not r["entered"]]),
            "avoidIgnoredEntered": perf([r["R"] for r in avoid if r["entered"]]),
            "preferEntered": perf([r["R"] for r in prefer if r["entered"]]),
            "preferAll": perf([r["R"] for r in prefer]),
            "preferVsComparable": uplift(prefer, rest),
            "byVerdict": {v: {"created": sum(r["verdict"] == v for r in rows),
                              "entered": sum(r["verdict"] == v and r["entered"] for r in rows),
                              "all": perf([r["R"] for r in rows if r["verdict"] == v])}
                          for v in sorted({r["verdict"] for r in rows})}}
    c, k = out["CANDIDATE"]["entered"], out["CONTROL"]["entered"]
    if c["n"] < 20 or k["n"] < 20:
        out["verdict"] = "UNPROVEN: needs >=20 entered plans per arm (now %d / %d)" % (c["n"], k["n"])
    else:
        better = (c["expectancyR"] > k["expectancyR"] and (c["maxDrawdownR"] or 0) <= 1.1 * (k["maxDrawdownR"] or 0)
                  and out["CANDIDATE"]["avoidSkipped"]["netBlockValueR"] >= 0)
        out["verdict"] = "PRIORS_IMPROVE_DECISIONS" if better else "NO_IMPROVEMENT"
    return out


def tick(root, fetch=None, builder=None, now=None):
    now = now or now_ms()
    fetch = fetch or fetch_klines
    builder = builder or default_builder({})
    state = load_state(root)
    plans = load_plans(root)
    labelled = label_due(state, plans, now, fetch)
    contexted = context_due(state, plans, now, builder)
    by_key = {plan_key(w): w for w in plans}
    eps = episodes(rows_for(state, by_key))
    if len(eps) >= 2 * T["candidateN"]:
        update_lessons(state, eps, now)
    refresh_verdicts(state, plans, now)
    arms, study = load_arms(root)
    counts = {}
    for lab in state["labels"].values():
        counts[lab.get("status")] = counts.get(lab.get("status"), 0) + 1
    status_n = {}
    for l in state["lessons"].values():
        status_n[l["status"]] = status_n.get(l["status"], 0) + 1
    rs = [e["R"] for e in eps]
    state["summary"] = {
        "at": now, "plansSeen": len(plans), "labelledThisTick": labelled, "contextsThisTick": contexted,
        "labelCounts": counts, "episodes": len(eps), "baselineR": round(_mean(rs), 3) if rs else None,
        "winRate": round(sum(r > 0 for r in rs) / len(rs), 3) if rs else None,
        "lessonStatus": status_n, "ab": ab_report(state, plans, arms, study),
        "studyId": study["id"] if study else None, "thresholds": T,
        "method": "Testnet 1m replay per frozen plan (5m-close trigger, band entry, stop wins ties, fees+slippage), "
                  "R = net/planned stop. Context from Testnet klines closed before creation. 1-2 atom patterns; "
                  "history nominates, prospective evidence promotes."}
    state["updatedAt"] = now
    save_state(root, state)
    return state["summary"]


def summary_text(state):
    if not state or not state.get("summary"):
        return "HERMES LEARNER: no labelled plans yet."
    s = state["summary"]
    lines = ["HERMES LEARNER (%s): %s episodes, baseline %sR, win %s. Lessons: %s"
             % (VERSION, s["episodes"], s["baselineR"], s["winRate"], json.dumps(s["lessonStatus"]))]
    shown = sorted((l for l in state["lessons"].values() if l["status"] not in ("RETIRED",)),
                   key=lambda l: (-LEVELS.index(l["status"]) if l["status"] in LEVELS else 1,
                                  -((l.get("evidence") or {}).get("sampleN") or 0)))
    for l in shown[:8]:
        lines.append("- " + lesson_text(l))
    if s.get("ab"):
        lines.append("- A/B: " + json.dumps(s["ab"], separators=(",", ":")))
    return "\n".join(lines)


if __name__ == "__main__":
    root = Path(sys.argv[sys.argv.index("--root") + 1]) if "--root" in sys.argv else Path(__file__).resolve().parent
    print(json.dumps(tick(root), allow_nan=False, default=str), flush=True)
