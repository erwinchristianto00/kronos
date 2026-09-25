"""Market context of a frozen plan AT ITS CREATION TIME, from Testnet klines only.

Every feature uses bars that closed strictly before the plan was created, so the
same numbers are available when a new plan is judged and when an old one is
learned from. Directional features are signed by the plan side: positive means
"in the trade's direction".
"""
import json
import math
import time
import urllib.request

KLINES_URL = "https://testnet.binancefuture.com/fapi/v1/klines"
M5 = 300000
H1 = 3600000
BENCH = "BTCUSDT"


def fetch(symbol, interval, end_ms, limit, opener=None):
    opener = opener or urllib.request.urlopen
    url = "%s?symbol=%s&interval=%s&endTime=%d&limit=%d" % (KLINES_URL, symbol, interval, int(end_ms), limit)
    rows = json.load(opener(url, timeout=15))
    # (openTime, open, high, low, close, quoteVolume, closeTime)
    return [(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7]), int(r[6])) for r in rows]


def closed_before(bars, t):
    return [b for b in bars if b[6] < t]


def _atr(bars, n):
    if len(bars) < n + 1:
        return None
    trs = []
    for prev, b in zip(bars[-n - 1:-1], bars[-n:]):
        trs.append(max(b[2] - b[3], abs(b[2] - prev[4]), abs(b[3] - prev[4])))
    return sum(trs) / n


def _returns(bars):
    return [b[4] / a[4] - 1 for a, b in zip(bars[:-1], bars[1:])]


def _corr_beta(xs, ys):
    n = min(len(xs), len(ys))
    if n < 30:
        return None, None
    xs, ys = xs[-n:], ys[-n:]
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None, None
    return sxy / math.sqrt(sxx * syy), sxy / syy


def compute(plan, created, bars5, bars1h, btc5, cost_bps=None):
    """Raw context numbers, or None when history is too short to be honest about."""
    b5 = closed_before(bars5, created)[-289:]
    b1 = closed_before(bars1h, created)[-72:]
    bb = closed_before(btc5, created)[-289:]
    if len(b5) < 120 or len(b1) < 20:
        return None
    s = 1 if plan["side"] == "LONG" else -1
    px = b5[-1][4]
    atr1h = _atr(b1, 14)
    atr5_14, atr5_96 = _atr(b5, 14), _atr(b5, min(96, len(b5) - 1))
    if not atr1h or not atr5_14 or not atr5_96 or px <= 0:
        return None
    p1h, p4h = b5[-13][4], b5[-49][4]
    p24h = b5[0][4]
    # Efficiency on 1h closes: on 5m bars 24h of noise swamps the path and nearly
    # everything reads as range (measured: 150 of 152 plans).
    h24 = b1[-25:]
    path = sum(abs(b[4] - a[4]) for a, b in zip(h24[:-1], h24[1:]))
    er = abs(h24[-1][4] - h24[0][4]) / path if path > 0 else 0.0
    ret24 = px / p24h - 1
    hi24 = max(b[2] for b in b5)
    lo24 = min(b[3] for b in b5)
    trig = float(plan["triggerPrice"])
    stop_dist = abs(trig - float(plan["stopPrice"]))
    target_dist = abs(float(plan["targetPrice"]) - trig)
    corr = beta = btc4 = None
    if len(bb) >= 60:
        corr, beta = _corr_beta(_returns(b5), _returns(bb))
        btc4 = bb[-1][4] / bb[-49][4] - 1
    breakout = (trig >= hi24 - 0.1 * atr1h) if s > 0 else (trig <= lo24 + 0.1 * atr1h)
    aligned = s * ret24 > 0
    if breakout:
        setup = "BREAKOUT"
    elif aligned and s * (px - p1h) <= 0:
        setup = "PULLBACK_CONTINUATION"
    elif aligned:
        setup = "CONTINUATION"
    else:
        setup = "REVERSAL"
    trending = er >= 0.3 and abs(px - p24h) >= atr1h
    return {
        "side": plan["side"],
        "regime": ("TREND_WITH" if aligned else "TREND_AGAINST") if trending else "RANGE",
        "trendStrengthER": round(er, 4),
        "momentum4hAtr": round(s * (px - p4h) / atr1h, 3),
        "displacement1hAtr": round(s * (px - p1h) / atr1h, 3),
        "volExpansion": round(atr5_14 / atr5_96, 3),
        "atr1hBps": round(atr1h / px * 1e4, 1),
        "costBps": round(cost_bps, 2) if isinstance(cost_bps, (int, float)) else None,
        "quoteVolume24hUsd": round(sum(b[5] for b in b5), 0),
        "btcCorr": round(corr, 3) if corr is not None else None,
        "btcBeta": round(beta, 3) if beta is not None else None,
        "btcAligned4h": (s * btc4 > 0) if btc4 is not None else None,
        "setupType": setup,
        "triggerDistAtr": round(s * (trig - px) / atr1h, 3),
        "holdH": round(float(plan.get("maxHoldMs") or 0) / H1, 2),
        "stopAtr": round(stop_dist / atr1h, 3),
        "rr": round(target_dist / stop_dist, 3) if stop_dist > 0 else None,
        "refPrice": px,
    }


# Fixed, pre-declared bins. Pattern atoms are (feature, bin). Edges were set once from
# the FEATURE distribution of the first 152 plans (roughly terciles, outcomes not
# looked at). Changing an edge is a new learner version, never a silent re-fit.
BINS = {
    "trendStrengthER": [(0.2, "WEAK"), (0.45, "MODERATE"), (None, "STRONG")],
    "momentum4hAtr": [(-1.0, "AGAINST"), (1.0, "FLAT"), (None, "WITH")],
    "displacement1hAtr": [(-0.5, "AGAINST"), (0.5, "FLAT"), (1.5, "WITH"), (None, "EXTENDED_WITH")],
    "volExpansion": [(0.8, "CONTRACTING"), (1.3, "NORMAL"), (None, "EXPANDING")],
    "costBps": [(33, "LOW"), (45, "MID"), (None, "HIGH")],
    "btcCorr": [(0.1, "LOW"), (0.25, "MID"), (None, "HIGH")],
    "triggerDistAtr": [(-0.1, "WELL_THROUGH"), (0.05, "AT_TRIGGER"), (None, "AHEAD")],
    "holdH": [(2.0, "SHORT"), (6.0, "MEDIUM"), (None, "LONG")],
    "stopAtr": [(0.5, "TIGHT"), (1.0, "NORMAL"), (None, "WIDE")],
    "rr": [(1.5, "LOW"), (2.5, "MID"), (None, "HIGH")],
}
CATEGORICAL = ("side", "regime", "setupType", "btcAligned4h")
LABELS = {
    "side": "side", "regime": "regime", "setupType": "setup", "btcAligned4h": "BTC 4h aligned with trade",
    "trendStrengthER": "trend strength", "momentum4hAtr": "4h momentum (ATR, trade direction)",
    "displacement1hAtr": "1h displacement before entry (ATR, trade direction)",
    "volExpansion": "volatility (ATR14/ATR96 on 5m)", "costBps": "all-in cost at creation",
    "btcCorr": "BTC correlation 24h", "triggerDistAtr": "trigger distance at creation (ATR)",
    "holdH": "max hold", "stopAtr": "stop distance (ATR)", "rr": "reward/risk",
}


def atoms(ctx):
    """Discrete (feature, value) atoms of one context; missing features give no atom."""
    if not ctx:
        return []
    out = []
    for f in CATEGORICAL:
        v = ctx.get(f)
        if v is not None:
            out.append((f, str(v).upper()))
    for f, edges in BINS.items():
        v = ctx.get(f)
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            continue
        for edge, name in edges:
            if edge is None or v < edge:
                out.append((f, name))
                break
    return out


def describe(pattern):
    return " + ".join("%s=%s" % (LABELS.get(f, f), v) for f, v in pattern)


def build(plan, created, cost_bps=None, fetcher=fetch, btc_cache=None):
    end = created
    bars5 = fetcher(plan["symbol"], "5m", end, 300)
    bars1h = fetcher(plan["symbol"], "1h", end, 72)
    key = end // M5
    if btc_cache is not None and key in btc_cache:
        btc = btc_cache[key]
    else:
        btc = fetcher(BENCH, "5m", end, 300)
        if btc_cache is not None:
            btc_cache[key] = btc
        time.sleep(0.2)
    return compute(plan, created, bars5, bars1h, btc, cost_bps)
