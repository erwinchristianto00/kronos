#!/usr/bin/env python3
"""Kronos control cockpit (port 3104).

READ-ONLY BY CONSTRUCTION: no exchange credentials, no exchange client import. It GETs from the
live/testnet APIs and reads their stores. It cannot place, cancel, or size an order.

Every number is either read from runtime or computed here from runtime data. Nothing about the
strategy's measured performance is hardcoded — where a source does not exist the UI says
"Tidak tersedia" rather than inventing one.
"""
import json, math, os, statistics as st, subprocess, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone, timedelta

PORT = 3104
INST = {
    "live":    {"api": "http://127.0.0.1:3103", "label": "LIVE (mainnet)", "port": 3103, "id": "3103",
                "rel": "/root/kronos-live-releases/migrate-20260818T060000Z/daily-trading-cockpit-v2",
                "store": "/root/kronos-live/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json"},
    "testnet": {"api": "http://127.0.0.1:3102", "label": "TESTNET (paper)", "port": 3102, "id": "3102",
                "rel": "/root/kronos-testnet-releases/history-fb-lock-20260814T130500Z/daily-trading-cockpit-v2",
                "store": "/root/kronos-testnet-releases/128b09f/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json"},
}
PROD_SIGNAL = "MOM36_FILTERED"
_cache = {"at": 0.0, "data": None}
CACHE_TTL = 25.0

def get(url, timeout=12):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception as e:
        return {"__error__": str(e)[:140]}

def sh(cmd, timeout=25):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception as e:
        return "ERR %s" % str(e)[:60]

def age_h(path):
    try: return (time.time() - os.path.getmtime(path)) / 3600.0
    except OSError: return None

def parse_iso(s):
    try: return datetime.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception: return None

# ---------------------------------------------------------------- edge statistics
def _dd(seq):
    eq = peak = worst = 0.0
    for x in seq:
        eq += x; peak = max(peak, eq); worst = min(worst, eq - peak)
    return worst

def edge_stats(rets):
    """Deterministic. rets = resolved net returns as fractions, oldest first."""
    n = len(rets)
    if n == 0:
        return {"n": 0}
    mean = sum(rets) / n
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r < 0]
    pf = (sum(wins) / abs(sum(losses))) if losses and sum(losses) != 0 else None
    t = None
    if n > 1:
        sd = st.stdev(rets)
        if sd > 0: t = mean / (sd / math.sqrt(n))
    return {"n": n, "meanPct": 100 * mean, "winPct": 100 * len(wins) / n,
            "pf": pf, "tStat": t, "ddPct": 100 * _dd(rets), "totalPct": 100 * sum(rets)}

def independent_episodes(rows, horizon_h=48):
    """Non-overlapping count: consecutive shadow baskets overlap almost completely, so a raw N
    overstates the evidence. Same rule the harness uses."""
    kept, free = 0, None
    for r in sorted(rows, key=lambda x: x["openedAtMs"]):
        if free is None or r["openedAtMs"] >= free:
            kept += 1; free = r["openedAtMs"] + horizon_h * 3600_000
    return kept

def load_observations(path, signal=PROD_SIGNAL):
    try:
        obs = (json.load(open(path)) or {}).get("observations") or []
    except Exception:
        return []
    out = []
    for o in obs:
        if o.get("signal") != signal or o.get("status") == "OPEN": continue
        nr, oa = o.get("netReturn"), o.get("openedAtMs")
        if not isinstance(nr, (int, float)) or not isinstance(oa, (int, float)): continue
        out.append({"netReturn": nr, "openedAtMs": oa, "openedAt": o.get("openedAt"),
                    "scoreGap": o.get("scoreGap"), "regime": o.get("regimeClassAtOpen"),
                    "longRet": o.get("longLegReturn"), "shortRet": o.get("shortLegReturn"),
                    "exitReason": o.get("exitReason"), "resolvedAt": o.get("resolvedAt"),
                    "smartFormation": o.get("smartFormation")})
    out.sort(key=lambda r: r["openedAtMs"])
    return out

def bucket(rows, keyfn, order=None):
    g = {}
    for r in rows:
        k = keyfn(r)
        if k is None: continue
        g.setdefault(k, []).append(r["netReturn"])
    keys = order or sorted(g)
    return [{"key": k, **edge_stats(g[k])} for k in keys if k in g]

def hold_hours(r):
    a, b = parse_iso(r.get("openedAt")), parse_iso(r.get("resolvedAt"))
    return None if not a or not b else (b - a).total_seconds() / 3600.0

# ---------------------------------------------------------------- gauges (deterministic)
def clamp(v, lo=0.0, hi=100.0): return max(lo, min(hi, v))

GAUGE_DOC = {
 "edge":      "50 + 15 x t-stat TERKOREKSI, dibatasi 0-100. Koreksi = t mentah x akar(episode independen / N), karena observasi bayangan tumpang tindih hampir seluruhnya sehingga t mentah melebih-lebihkan bukti. t=0 -> 50; t=+2 -> 80; t=-2 -> 20.",
 "recent":    "50 + 50 x (mean 30 terakhir / |mean seluruh riwayat|), dibatasi 0-100. 50 berarti performa terakhir setara rata-rata panjangnya.",
 "dd":        "100 x (1 - |drawdown| / (|drawdown| + |total return|)). 100 = tidak pernah drawdown; turun saat drawdown besar relatif terhadap hasil.",
 "exec":      "100 x (harga fill terkonfirmasi bursa / total harga fill yang dibukukan) di seluruh basket tereksekusi.",
 "data":      "Rata-rata dua bagian: simbol pool yang likuiditasnya terukur, dan sinyal tidak basi di tiap instance.",
 "research":  "100 x (episode independen 48 jam / 30). 30 dipilih karena di bawah itu MDE lebih besar daripada edge lane-nya sendiri, jadi hasil apa pun tak bisa dibedakan dari nol.",
 "overall":   "Rata-rata tertimbang: Edge 35%, Recent 20%, Drawdown 20%, Execution 15%, Data 10%. Research dan System sengaja TIDAK dimasukkan - keduanya menilai apakah angka lain layak dipercaya, bukan performa.",
}

def build_gauges(all_stats, w30, exec_conf, data_q, episodes):
    g = {}
    t = all_stats.get("tStat")
    n = all_stats.get("n") or 0
    # Deflate the t-stat by the overlap ratio. Without this the gauge reads 100 off a t of 5.5 that
    # rests on 3 independent episodes — flatly contradicting the evidence-strength gauge beside it.
    if isinstance(t, float) and n > 0 and isinstance(episodes, int) and episodes > 0:
        t_eff = t * math.sqrt(min(1.0, episodes / float(n)))
    else:
        t_eff = t if isinstance(t, float) else None
    g["edgeTRaw"], g["edgeTEff"] = t, t_eff
    g["edge"] = clamp(50 + 15 * t_eff) if isinstance(t_eff, float) else None
    am, rm = all_stats.get("meanPct"), w30.get("meanPct")
    g["recent"] = clamp(50 + 50 * (rm / abs(am))) if isinstance(am, float) and isinstance(rm, float) and am != 0 else None
    dd, tot = all_stats.get("ddPct"), all_stats.get("totalPct")
    if isinstance(dd, float) and isinstance(tot, float):
        den = abs(dd) + abs(tot)
        g["dd"] = clamp(100 * (1 - abs(dd) / den)) if den > 0 else None
    else: g["dd"] = None
    g["exec"] = exec_conf
    g["data"] = data_q
    g["research"] = clamp(100 * episodes / 30.0) if isinstance(episodes, int) else None
    parts = [("edge", .35), ("recent", .20), ("dd", .20), ("exec", .15), ("data", .10)]
    have = [(g[k], w) for k, w in parts if isinstance(g.get(k), float)]
    g["overall"] = sum(v * w for v, w in have) / sum(w for _, w in have) if have else None
    return g

# ---------------------------------------------------------------- collector
def collect():
    if _cache["data"] is not None and time.time() - _cache["at"] < CACHE_TTL:
        return _cache["data"]
    now = datetime.now(timezone.utc)
    R = {"generatedAt": now.isoformat(), "inst": {}}

    for key, cfg in INST.items():
        ex = get(cfg["api"] + "/api/live/cross-sectional-executor")
        rep = get(cfg["api"] + "/api/shadow/cross-sectional-report")
        pool = get(cfg["api"] + "/api/live/cross-sectional-pool")
        adm = ex.get("entryAdmission") or {}
        fr = (rep or {}).get("filteredReport") or {}
        rn = fr.get("recentNetReturns") or []
        gate = {"n": len(rn),
                "last8": 100 * sum(rn[-8:]) / 8 if len(rn) >= 8 else None,
                "last30": 100 * sum(rn[-30:]) / len(rn[-30:]) if rn else None,
                "openShadow": len((rep or {}).get("filteredOpenBaskets") or [])}
        gate["pass"] = isinstance(gate["last8"], float) and isinstance(gate["last30"], float) \
                       and gate["last8"] > 0 and gate["last30"] > 0
        rows = load_observations(cfg["store"])
        R["inst"][key] = {
            "label": cfg["label"], "port": cfg["port"], "id": cfg["id"], "rel": cfg["rel"],
            "ex": ex, "adm": adm, "gate": gate, "pool": pool, "rows": rows,
            "envPolicy": sh("%s/deploy/apply-required-env.sh --check %s/.env %s 2>&1 | tail -1"
                            % (cfg["rel"], cfg["rel"], cfg["id"])),
            "attempt": (ex.get("entryAttemptAudit") or {}),
            "admAudit": (ex.get("entryAdmissionAudit") or {}),
        }

    R["account"] = get(INST["live"]["api"] + "/api/live/account")
    R["axis"] = get(INST["live"]["api"] + "/api/shadow/regime-axis-timeline")
    R["dir"] = get(INST["live"]["api"] + "/api/live/cross-sectional-directional-regime")

    # ---- edge, computed from the production signal's own resolved observations -------------
    rows = R["inst"]["testnet"]["rows"] + R["inst"]["live"]["rows"]
    rows.sort(key=lambda r: r["openedAtMs"])
    seen, merged = set(), []
    for r in rows:
        k = (r["openedAtMs"], round(r["netReturn"], 12))
        if k in seen: continue
        seen.add(k); merged.append(r)
    nets = [r["netReturn"] for r in merged]
    windows = {}
    for lbl, k in (("8 terakhir", 8), ("30 terakhir", 30), ("90 terakhir", 90), ("seluruhnya", None)):
        seq = nets if k is None else nets[-k:]
        windows[lbl] = edge_stats(seq)
    episodes = independent_episodes(merged) if merged else 0
    R["edge"] = {
        "windows": windows, "episodes": episodes, "signal": PROD_SIGNAL,
        "curve": [{"at": r["openedAt"], "net": r["netReturn"]} for r in merged],
        "byRegime": bucket(merged, lambda r: r.get("regime"), ["TREND_LONG", "MIXED_CHOP", "TREND_SHORT"]),
        "byGap": bucket(merged, lambda r: None if not isinstance(r.get("scoreGap"), float) else
                        ("<0.04" if r["scoreGap"] < .04 else "0.04-0.058" if r["scoreGap"] < .058
                         else "0.058-0.08" if r["scoreGap"] < .08 else ">=0.08"),
                        ["<0.04", "0.04-0.058", "0.058-0.08", ">=0.08"]),
        "byHold": bucket(merged, lambda r: (lambda h: None if h is None else
                         "<12j" if h < 12 else "12-24j" if h < 24 else "24-36j" if h < 36 else ">=36j")(hold_hours(r)),
                         ["<12j", "12-24j", "24-36j", ">=36j"]),
        "byMonth": bucket(merged, lambda r: (r.get("openedAt") or "")[:7]),
        "sideLong": edge_stats([r["longRet"] for r in merged if isinstance(r.get("longRet"), float)]),
        "sideShort": edge_stats([r["shortRet"] for r in merged if isinstance(r.get("shortRet"), float)]),
        "gapVsReturn": [{"gap": r["scoreGap"], "net": r["netReturn"]} for r in merged
                        if isinstance(r.get("scoreGap"), float)],
    }

    # ---- execution quality: exchange-confirmed fill prices across executed baskets ----------
    conf = tot = 0
    for key in INST:
        for b in (R["inst"][key]["ex"].get("recent") or []) + (R["inst"][key]["ex"].get("openBaskets") or []):
            for l in b.get("legs") or []:
                for f in ("entryPriceConfirmed", "exitPriceConfirmed"):
                    v = l.get(f)
                    if v is None: continue
                    tot += 1; conf += 1 if v else 0
    R["execQuality"] = {"confirmed": conf, "total": tot,
                        "pct": (100.0 * conf / tot) if tot else None}

    # ---- data quality ----------------------------------------------------------------------
    prow = (R["inst"]["live"]["pool"] or {}).get("rows") or []
    measured = sum(1 for r in prow if isinstance(r.get("liquidityUsdPerHour"), (int, float)))
    fresh = [not R["inst"][k]["ex"].get("signalStale") for k in INST]
    dq = None
    if prow:
        dq = clamp(100 * (0.5 * measured / len(prow) + 0.5 * (sum(1 for f in fresh if f) / len(fresh))))
    R["dataQuality"] = {"pct": dq, "measured": measured, "universe": len(prow),
                        "staleSignals": [k for k in INST if R["inst"][k]["ex"].get("signalStale")]}

    R["gauges"] = build_gauges(windows["seluruhnya"], windows["30 terakhir"],
                               R["execQuality"]["pct"], dq, episodes)

    # ---- system ----------------------------------------------------------------------------
    pm2 = []
    try:
        for p in json.loads(sh("pm2 jlist") or "[]"):
            e = p.get("pm2_env", {})
            if p.get("name", "").startswith(("dtc-api", "kronos-control")):
                pm2.append({"name": p["name"], "status": e.get("status"), "restarts": e.get("restart_time")})
    except Exception: pass
    jobs = []
    for lbl, path, mx in (("Perekam positioning", "/root/xsec-sim/record.log", 2.0),
                          ("Arsip observasi", "/root/xsec-archive/harvest.log", 2.0),
                          ("Cek drift konfigurasi", "/root/env-drift.log", 26.0),
                          ("Perekam microstructure", "/root/kronos-microstructure/cron.log", 2.0)):
        a = age_h(path)
        jobs.append({"job": lbl, "ageHours": a, "stale": (a is None or a > mx), "maxHours": mx})
    man = {}
    for iid in ("3101", "3102", "3103"):
        p = "%s/deploy/manifests/%s.json" % (INST["live"]["rel"], iid)
        try:
            d = json.load(open(p))
            man[iid] = d.get("treeHash") or d.get("hash") or (d.get("summary") or {}).get("hash")
        except Exception: man[iid] = None
    disk = sh("df -h / | tail -1").split()
    R["system"] = {"pm2": pm2, "jobs": jobs, "manifests": man,
                   "disk": {"size": disk[1], "used": disk[2], "avail": disk[3], "pct": disk[4]} if len(disk) > 5 else None,
                   "hostTimeUtc": now.isoformat()}
    _cache["at"], _cache["data"] = time.time(), R
    return R

# ================================================================ presentation
CSS = """
*{box-sizing:border-box}
body{margin:0;background:#0b0f14;color:#c9d4e0;font:13.5px/1.6 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:18px 16px 60px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
h1{font-size:16px;margin:0;color:#e8eef5;font-weight:600;letter-spacing:.2px}
.stamp{color:#68788a;font-size:11px}
nav{display:flex;gap:2px;flex-wrap:wrap;margin:14px 0 18px;border-bottom:1px solid #1b2430}
nav button{background:none;border:0;border-bottom:2px solid transparent;color:#7d8fa3;padding:8px 13px;font:inherit;font-size:13px;cursor:pointer;border-radius:4px 4px 0 0}
nav button:hover{color:#c9d4e0;background:#111823}
nav button.on{color:#e8eef5;border-bottom-color:#4c8fd6;font-weight:600}
section{display:none}section.on{display:block}
h2{font-size:12px;margin:24px 0 10px;color:#8fa3b8;font-weight:600;letter-spacing:.7px;text-transform:uppercase}
h2:first-child{margin-top:0}
.lead{background:#111823;border:1px solid #1e2836;border-left:3px solid #4c8fd6;border-radius:0 7px 7px 0;padding:13px 16px;margin-bottom:14px}
.lead .c{font-size:16px;color:#e8eef5;font-weight:600;margin-bottom:3px}
.lead .r{color:#93a5b8;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:9px}
.card{background:#111823;border:1px solid #1e2836;border-radius:7px;padding:11px 13px}
.card .k{color:#68788a;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px}
.card .v{font-size:20px;color:#e8eef5;margin-top:3px;font-weight:600;letter-spacing:-.3px}
.card .s{font-size:11.5px;color:#7d8fa3;margin-top:2px}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}
th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #18202b;white-space:nowrap}
th{color:#68788a;font-weight:500;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
tr:hover td{background:#101722}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:#4ec9a0}.neg{color:#e5686d}.dim{color:#68788a}.warnc{color:#d9a441}
details{margin-top:9px;border:1px solid #1e2836;border-radius:7px;background:#0e141c}
summary{cursor:pointer;padding:8px 13px;color:#7d8fa3;font-size:12px;user-select:none}
summary:hover{color:#c9d4e0}
details[open] summary{border-bottom:1px solid #1e2836;color:#c9d4e0}
details .body{padding:11px 13px}
.kv{display:grid;grid-template-columns:minmax(190px,auto) 1fr;gap:3px 14px;font-size:12.5px}
.kv dt{color:#68788a}.kv dd{margin:0;color:#c9d4e0;word-break:break-word}
code{background:#0b1017;border:1px solid #1e2836;border-radius:4px;padding:1px 5px;font-size:11.5px;color:#8fb8dd}
.gauge{background:#111823;border:1px solid #1e2836;border-radius:7px;padding:11px 13px}
.bar{height:6px;background:#18202b;border-radius:3px;overflow:hidden;margin-top:7px}
.bar i{display:block;height:100%;border-radius:3px}
.trace{border-left:2px solid #1e2836;margin-left:7px;padding-left:14px}
.trace .step{position:relative;padding:7px 0}
.trace .step:before{content:'';position:absolute;left:-19px;top:13px;width:9px;height:9px;border-radius:50%;background:#1e2836;border:2px solid #0b0f14}
.trace .step.p:before{background:#4ec9a0}.trace .step.f:before{background:#e5686d}.trace .step.w:before{background:#d9a441}
.trace .t{color:#e8eef5;font-size:13px}.trace .d{color:#7d8fa3;font-size:12px}
.note{color:#68788a;font-size:11.5px;margin-top:7px}
.scroll{overflow-x:auto}
@media(max-width:640px){.kv{grid-template-columns:1fr}.card .v{font-size:17px}}
"""

def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

def money(v, d=2):
    if not isinstance(v, (int, float)): return "<span class='dim'>–</span>"
    return "<span class='%s'>%s$%s</span>" % ("pos" if v > 0 else "neg" if v < 0 else "",
                                              "+" if v > 0 else "-" if v < 0 else "",
                                              format(abs(round(v, d)), ",.%df" % d))

def pct(v, d=2, sign=True):
    if not isinstance(v, (int, float)): return "<span class='dim'>–</span>"
    return "<span class='%s'>%s%.*f%%</span>" % ("pos" if v > 0 else "neg" if v < 0 else "",
                                                 "+" if sign and v > 0 else "", d, v)

def num(v, d=2):
    return "<span class='dim'>–</span>" if not isinstance(v, (int, float)) else format(round(v, d), ",.%df" % d)

DOT = {"ok": "🟢", "watch": "🟡", "override": "🟠", "block": "🔴", "off": "⚪"}

def card(k, v, s=""):
    return "<div class='card'><div class='k'>%s</div><div class='v'>%s</div>%s</div>" % (
        k, v, "<div class='s'>%s</div>" % s if s else "")

def lead(status, conclusion, reason):
    return "<div class='lead'><div class='c'>%s %s</div><div class='r'>%s</div></div>" % (
        DOT.get(status, ""), conclusion, reason)

def tech(title, pairs):
    rows = "".join("<dt>%s</dt><dd>%s</dd>" % (k, v) for k, v in pairs)
    return "<details><summary>Detail teknis · %s</summary><div class='body'><dl class='kv'>%s</dl></div></details>" % (title, rows)

# ---------------------------------------------------------------- inline SVG charts
def spark_area(points, w=560, h=110, pos="#4ec9a0", neg="#e5686d"):
    """Cumulative equity-style curve from a list of increments."""
    if len(points) < 2: return "<div class='dim'>Data tidak cukup untuk kurva.</div>"
    cum, s = [], 0.0
    for p in points: s += p; cum.append(s)
    lo, hi = min(cum + [0]), max(cum + [0])
    rng = (hi - lo) or 1.0
    X = lambda i: 8 + i * (w - 16) / (len(cum) - 1)
    Y = lambda v: h - 10 - (v - lo) * (h - 24) / rng
    d = " ".join("%s%.1f,%.1f" % ("M" if i == 0 else "L", X(i), Y(v)) for i, v in enumerate(cum))
    zero = Y(0)
    col = pos if cum[-1] >= 0 else neg
    return ("<svg viewBox='0 0 %d %d' width='100%%' height='%d' preserveAspectRatio='none'>"
            "<line x1='8' y1='%.1f' x2='%d' y2='%.1f' stroke='#1e2836' stroke-dasharray='3 3'/>"
            "<path d='%s' fill='none' stroke='%s' stroke-width='1.8'/></svg>") % (w, h, h, zero, w - 8, zero, d, col)

def bars(items, w=560, h=130, fmt=lambda v: "%.2f%%" % v):
    """items = [(label, value)] comparison bars, signed."""
    items = [(l, v) for l, v in items if isinstance(v, (int, float))]
    if not items: return "<div class='dim'>Tidak ada data.</div>"
    mx = max(abs(v) for _, v in items) or 1.0
    bw = (w - 20) / len(items)
    mid = h - 34
    out = ["<svg viewBox='0 0 %d %d' width='100%%' height='%d'>" % (w, h, h),
           "<line x1='10' y1='%d' x2='%d' y2='%d' stroke='#1e2836'/>" % (mid, w - 10, mid)]
    for i, (l, v) in enumerate(items):
        bh = abs(v) / mx * (mid - 14)
        x = 10 + i * bw + bw * .18
        y = mid - bh if v >= 0 else mid
        out.append("<rect x='%.1f' y='%.1f' width='%.1f' height='%.1f' rx='2' fill='%s'/>"
                   % (x, y, bw * .64, max(bh, 1), "#4ec9a0" if v >= 0 else "#e5686d"))
        out.append("<text x='%.1f' y='%d' fill='#68788a' font-size='9.5' text-anchor='middle'>%s</text>"
                   % (x + bw * .32, h - 20, esc(l)[:12]))
        out.append("<text x='%.1f' y='%.1f' fill='#8fa3b8' font-size='9' text-anchor='middle'>%s</text>"
                   % (x + bw * .32, (y - 3) if v >= 0 else (y + bh + 9), fmt(v)))
    out.append("</svg>")
    return "".join(out)

def scatter(pairs, thr, w=560, h=170):
    if len(pairs) < 3: return "<div class='dim'>Data tidak cukup.</div>"
    xs = [p["gap"] for p in pairs]; ys = [p["net"] * 100 for p in pairs]
    x0, x1 = min(xs), max(xs); y0, y1 = min(ys), max(ys)
    xr = (x1 - x0) or 1; yr = (y1 - y0) or 1
    X = lambda v: 34 + (v - x0) * (w - 46) / xr
    Y = lambda v: h - 26 - (v - y0) * (h - 44) / yr
    out = ["<svg viewBox='0 0 %d %d' width='100%%' height='%d'>" % (w, h, h)]
    out.append("<line x1='34' y1='%.1f' x2='%d' y2='%.1f' stroke='#1e2836' stroke-dasharray='3 3'/>" % (Y(0), w - 12, Y(0)))
    if x0 <= thr <= x1:
        out.append("<line x1='%.1f' y1='6' x2='%.1f' y2='%d' stroke='#d9a441' stroke-dasharray='4 3'/>" % (X(thr), X(thr), h - 26))
        out.append("<text x='%.1f' y='14' fill='#d9a441' font-size='9.5'>ambang %.3f</text>" % (min(X(thr) + 4, w - 80), thr))
    for p in pairs:
        out.append("<circle cx='%.1f' cy='%.1f' r='2.4' fill='%s' opacity='.72'/>"
                   % (X(p["gap"]), Y(p["net"] * 100), "#4ec9a0" if p["net"] >= 0 else "#e5686d"))
    out.append("<text x='4' y='%.1f' fill='#68788a' font-size='9'>%.1f%%</text>" % (Y(y1) + 3, y1))
    out.append("<text x='4' y='%.1f' fill='#68788a' font-size='9'>%.1f%%</text>" % (Y(y0) + 3, y0))
    out.append("<text x='34' y='%d' fill='#68788a' font-size='9'>scoreGap %.3f</text>" % (h - 8, x0))
    out.append("<text x='%d' y='%d' fill='#68788a' font-size='9' text-anchor='end'>%.3f</text>" % (w - 12, h - 8, x1))
    out.append("</svg>")
    return "".join(out)

def gauge(label, val, doc):
    if not isinstance(val, (int, float)):
        return ("<div class='gauge'><div class='k' style='color:#68788a;font-size:10.5px;text-transform:uppercase'>%s</div>"
                "<div class='v' style='font-size:20px;color:#68788a'>Tidak tersedia</div>"
                "<div class='s' style='color:#68788a;font-size:11px'>%s</div></div>" % (label, doc[:90]))
    col = "#4ec9a0" if val >= 67 else "#d9a441" if val >= 40 else "#e5686d"
    return ("<div class='gauge'><div style='color:#68788a;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px'>%s</div>"
            "<div style='font-size:22px;color:%s;font-weight:600;margin-top:2px'>%d<span style='font-size:12px;color:#68788a'> / 100</span></div>"
            "<div class='bar'><i style='width:%.0f%%;background:%s'></i></div>"
            "<details style='margin-top:7px;border:0;background:none'><summary style='padding:3px 0;font-size:11px'>Bagaimana dihitung?</summary>"
            "<div style='padding:4px 0;color:#7d8fa3;font-size:11.5px'>%s</div></details></div>") % (label, col, round(val), val, col, doc)

def _alerts(R):
    out = []
    for k, i in R["inst"].items():
        ex = i["ex"]
        if ex.get("__error__"): out.append(("block", "%s tidak merespons" % i["label"], ex["__error__"]))
        if ex.get("lastError"): out.append(("block", "%s melaporkan error" % i["label"], str(ex["lastError"])[:120]))
        if ex.get("configErrors"): out.append(("block", "%s konfigurasi bermasalah" % i["label"], str(ex["configErrors"])[:120]))
        if ex.get("orphanedLegs"): out.append(("block", "%s punya kaki yatim" % i["label"], "%d kaki tanpa basket" % len(ex["orphanedLegs"])))
        if ex.get("signalStale"): out.append(("watch", "%s sinyalnya basi" % i["label"],
            "umur %.0f menit, batas %.0f menit — tidak ada basket baru sampai sinyal segar" % (
                (ex.get("signalAgeMs") or 0)/60000.0, (ex.get("signalMaxAgeMs") or 0)/60000.0)))
        if "OK:" not in (i["envPolicy"] or ""): out.append(("block", "%s menyimpang dari kebijakan konfigurasi" % i["label"], i["envPolicy"][:120]))
        if ex.get("entryHealthBypassed"): out.append(("override", "%s: gerbang bukti di-override operator" % i["label"],
            "Bot tetap membuka basket walau bukti terakhir negatif. Ini keputusan manual, bukan lampu hijau dari data."))
    for j in R["system"]["jobs"]:
        if j["stale"]: out.append(("watch", "%s berhenti berjalan" % j["job"],
            "terakhir %s, ambang %.0f jam" % ("tidak pernah" if j["ageHours"] is None else "%.1f jam lalu" % j["ageHours"], j["maxHours"])))
    for p in R["system"]["pm2"]:
        if p["status"] != "online": out.append(("block", "Proses %s: %s" % (p["name"], p["status"]), "Layanan tidak berjalan."))
    d = R["system"].get("disk")
    if d and int(str(d["pct"]).rstrip("%") or 0) >= 90:
        out.append(("watch", "Disk hampir penuh", "%s terpakai, sisa %s" % (d["pct"], d["avail"])))
    return out

def tab_overview(R):
    a, o = R["account"], []
    liv, tst = R["inst"]["live"], R["inst"]["testnet"]
    eq, up = a.get("accountEquity"), a.get("unrealizedPnl")
    ob = liv["ex"].get("openBaskets") or []
    alerts = _alerts(R)
    blocking = [x for x in alerts if x[0] == "block"]
    w8 = R["edge"]["windows"]["8 terakhir"]

    if blocking: st, cc, rr = "block", "Ada %d masalah yang perlu tindakan" % len(blocking), blocking[0][1] + " — " + blocking[0][2]
    elif ob: st, cc, rr = ("ok", "Bot sedang memegang %d basket" % len(ob),
        "Posisi berjalan dengan stop/TP ±%s%% dan batas tahan %s jam." % (liv["ex"].get("stopNetReturnPct"), liv["ex"].get("maxHoldHours")))
    elif liv["adm"].get("tier") == "GREEN": st, cc, rr = ("watch", "Tidak ada posisi, menunggu formasi berikutnya",
        "Izin masuk terbuka. Basket baru dibuka begitu ada formasi yang lolos ambang pemisahan.")
    else: st, cc, rr = ("block", "Tidak ada posisi dan entry sedang ditutup", str(liv["adm"].get("reason") or "")[:150])
    o.append(lead(st, cc, rr))

    o.append("<div class='grid'>")
    o.append(card("Ekuitas akun", money(eq), "wallet %s · tersedia %s" % (money(a.get("walletBalance")), money(a.get("availableBalance")))))
    o.append(card("P&amp;L belum terealisasi", money(up, 4), "dari %d posisi terbuka" % (a.get("openPositionCount") or 0)))
    o.append(card("P&amp;L terealisasi (live)", money(liv["ex"].get("totalNetPnlUsd"), 4), "%s basket selesai" % liv["ex"].get("closedCount")))
    o.append(card("P&amp;L terealisasi (testnet)", money(tst["ex"].get("totalNetPnlUsd"), 4), "%s basket selesai · uang demo" % tst["ex"].get("closedCount")))
    o.append("</div>")

    o.append("<h2>Izin masuk</h2><div class='grid'>")
    for k in ("live", "testnet"):
        i = R["inst"][k]; adm = i["adm"]; t = adm.get("tier")
        byp = i["ex"].get("entryHealthBypassed")
        s = "override" if byp else "ok" if t == "GREEN" else "watch" if t == "YELLOW" else "block" if t == "RED" else "off"
        txt = "Boleh membuka" if t == "GREEN" else "Ukuran dikurangi" if t == "YELLOW" else "Ditutup" if t == "RED" else "—"
        o.append(card(i["label"], "%s %s" % (DOT[s], txt),
                      "override operator aktif" if byp else "gerbang bukti dihormati"))
    o.append("</div>")

    o.append("<h2>Kesehatan edge</h2><div class='grid'>")
    o.append(card("8 basket terakhir", pct(w8.get("meanPct"), 3) if w8.get("n") else "<span class='dim'>–</span>", "rata-rata per basket"))
    o.append(card("Episode independen", str(R["edge"]["episodes"]), "dari %d observasi — yang menentukan kepercayaan" % R["edge"]["windows"]["seluruhnya"].get("n", 0)))
    g = R["gauges"]
    o.append(card("Skor edge", num(g.get("edge"), 0), "0–100, lihat tab Edge"))
    o.append(card("Skor keseluruhan", num(g.get("overall"), 0), "0–100, lihat tab Edge"))
    o.append("</div>")

    o.append("<h2>Peringatan &amp; keamanan</h2>")
    if not alerts:
        o.append("<div class='card'>%s Tidak ada peringatan aktif.</div>" % DOT["ok"])
    else:
        o.append("<table><tr><th>status</th><th>masalah</th><th>keterangan</th></tr>")
        for s, t, d in alerts:
            o.append("<tr><td>%s</td><td>%s</td><td class='dim'>%s</td></tr>" % (DOT[s], esc(t), esc(d)))
        o.append("</table>")
    return "".join(o)

def tab_strategy(R):
    liv = R["inst"]["live"]; ex = liv["ex"]; pool = liv["pool"] or {}
    cnt = pool.get("counts") or {}; leg = pool.get("leg") or {}
    fc = ((get(INST["live"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig")) or {}
    a = R["account"]; eq = a.get("accountEquity")
    legusd = ex.get("legUsd"); gross = (legusd * 6) if isinstance(legusd, (int, float)) else None
    o = [lead("ok", "Market-neutral lintas-simbol, 3 long / 3 short",
              "Peringkat momentum 36 jam memilih yang terkuat dan terlemah; basket ditahan sampai batas waktu kecuali stop/TP kena.")]
    o.append("<div class='grid'>")
    o.append(card("Sinyal", esc(fc.get("signal") or "–"), "momentum 36 jam, varian tersaring"))
    o.append(card("Struktur basket", "3 long / 3 short", "bobot dari peringkat skor, dibatasi"))
    o.append(card("Ukuran per kaki", money(legusd, 0), "eksposur kotor %s%s" % (money(gross, 0),
              (" · %.0f%% ekuitas" % (100 * gross / eq)) if gross and eq else "")))
    o.append(card("Batas tahan", "%s jam" % ex.get("maxHoldHours"), "horizon sinyal 48 jam"))
    o.append(card("Stop / ambil untung", "±%s%% / %s%%" % (ex.get("stopNetReturnPct"), ex.get("tpNetReturnPct")), "atas nilai basket, simetris"))
    o.append(card("Ambang pemisahan", num(fc.get("minScoreGap"), 3), "selisih skor long vs short minimum"))
    o.append(card("Universe", "%s simbol" % cnt.get("universe"), "pool long %s · short layak %s" % (cnt.get("poolLong"), cnt.get("shortEligible"))))
    o.append(card("Basket bersamaan", str(ex.get("maxOpenBaskets") or "–"), "maksimum posisi hidup"))
    o.append("</div>")
    o.append("<h2>Seleksi kandidat (Smart Formation)</h2>")
    o.append("<div class='lead' style='border-left-color:#8a6fbf'><div class='r'>Peringkat momentum tetap dominan. Dua faktor lain hanya pemecah seri berbatas: "
             "<b>konfirmasi cepat</b> (gerak 4 bar terakhir dibagi volatilitasnya, bobot 0,22) menaikkan nama yang gerak terbarunya searah, dan "
             "<b>penalti terlalu jauh</b> (bobot 0,20) menurunkan nama yang sudah berlari terlalu jauh. "
             "Ada penalti 0,18 per nama tambahan dari klaster yang sama supaya basket tidak menumpuk di satu tema.</div></div>")
    o.append(tech("parameter runtime", [
        ("Sinyal", "<code>%s</code>" % esc(fc.get("signal"))),
        ("Ambang scoreGap", "<code>%s</code> — env <code>CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP</code>" % fc.get("minScoreGap")),
        ("Leg USD", "<code>%s</code> — env <code>CROSS_SECTIONAL_EXEC_LEG_USD</code>" % legusd),
        ("Leverage", "<code>%s</code>" % ex.get("leverage")),
        ("Batas tahan", "<code>%s</code> jam — env <code>CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS</code>" % ex.get("maxHoldHours")),
        ("Stop / TP", "<code>%s</code> / <code>%s</code> — env <code>..._EXEC_STOP_NET_RETURN</code> / <code>..._EXEC_TP_NET_RETURN</code>" % (ex.get("stopNetReturnPct"), ex.get("tpNetReturnPct"))),
        ("Exit adaptif", "dinonaktifkan — ambang scan dinaikkan sehingga tak terjangkau dalam horizon 48 jam"),
        ("Allowlist long", "<code>%s</code>" % esc(", ".join((fc.get("longAllowlist") or [])[:30]))),
        ("Blocklist short", "<code>%s</code>" % esc(", ".join(fc.get("shortBlocklist") or []))),
        ("Bursa", "Binance USD-M Futures · %s" % ("mainnet" if liv["id"] == "3103" else "testnet")),
        ("Funding", "tidak dibukukan per basket oleh executor — <b>tidak tersedia</b> di UI ini"),
    ]))
    return "".join(o)

def tab_decision(R):
    o = []
    for k in ("live", "testnet"):
        i = R["inst"][k]; ex = i["ex"]; adm = i["adm"]; gate = i["gate"]
        att = (i["attempt"] or {}).get("latest") or {}
        aa = i["admAudit"] or {}
        pool = (i["pool"] or {}).get("counts") or {}
        fc_gap = ((i["pool"] or {}).get("thresholds") or {})
        tier = adm.get("tier")
        allowed = tier == "GREEN"
        o.append("<h2>%s</h2>" % i["label"])
        o.append(lead("ok" if allowed else "block",
                      "Boleh membuka basket" if allowed else "Tidak membuka basket",
                      esc(str(adm.get("reason") or "Semua syarat terpenuhi."))[:240]))
        steps = []
        steps.append(("p" if pool.get("universe") else "f", "Data & universe siap",
                      "%s simbol dipindai, %s lolos kriteria pool" % (pool.get("universe"), pool.get("poolLong"))))
        steps.append(("p" if not ex.get("signalStale") else "w", "Sinyal segar",
                      "umur %.0f menit dari batas %.0f menit" % ((ex.get("signalAgeMs") or 0)/60000.0, (ex.get("signalMaxAgeMs") or 0)/60000.0)))
        ls, ss = att.get("longSymbols"), att.get("shortSymbols")
        steps.append(("p" if ls and ss else "w", "Kandidat cukup di dua sisi",
                      ("long %s · short %s" % (", ".join(ls or []), ", ".join(ss or []))) if ls or ss else "belum ada percobaan tercatat"))
        gp = att.get("scoreGap")
        thr = ((get(INST[k]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {}).get("minScoreGap")
        if isinstance(gp, (int, float)) and isinstance(thr, (int, float)):
            steps.append(("p" if gp >= thr else "f", "Pemisahan long vs short cukup lebar",
                          "terukur %.4f, minimum %.4f" % (gp, thr)))
        else:
            steps.append(("w", "Pemisahan long vs short", "tidak tercatat pada percobaan terakhir"))
        rg = R["axis"] if isinstance(R["axis"], dict) else {}
        cur = rg.get("current") or {}
        steps.append(("p", "Keadaan pasar terbaca",
                      "%s · zona %s · skor %s" % (cur.get("regime"), (rg.get("guidance") or {}).get("zoneLabel"), num(cur.get("score"), 3))))
        byp = ex.get("entryHealthBypassed")
        steps.append(("w" if byp else ("p" if gate["pass"] else "f"), "Bukti performa terakhir",
                      "8 terakhir %s · 30 terakhir %s%s" % (pct(gate.get("last8"), 3), pct(gate.get("last30"), 3),
                       " — <b>di-override operator</b>" if byp else "")))
        steps.append(("p" if allowed else "f", "Keputusan akhir", "boleh membuka" if allowed else "ditahan"))
        o.append("<div class='trace'>")
        for cls, t, d in steps:
            o.append("<div class='step %s'><div class='t'>%s</div><div class='d'>%s</div></div>" % (cls, t, d))
        o.append("</div>")
        o.append(tech("audit izin masuk · %s" % i["label"], [
            ("Traffic light aktif", str(aa.get("trafficLightEnabled"))),
            ("Diizinkan (hijau)", str(aa.get("greenAdmitted"))),
            ("Ukuran dikurangi (kuning)", str(aa.get("yellowAdmitted"))),
            ("Ditolak (merah)", str(aa.get("redBlocked"))),
            ("Percobaan terakhir", esc(json.dumps(att)[:400]) if att else "tidak ada"),
            ("Sumber gerbang", "laporan bayangan <code>filteredReport.recentNetReturns</code>, n=%s" % gate.get("n")),
        ]))
    return "".join(o)

def tab_formation(R):
    src, inst = None, None
    for k in ("live", "testnet"):
        for r in reversed(R["inst"][k]["rows"]):
            if (r.get("smartFormation") or {}).get("candidates"):
                if src is None or r["openedAtMs"] > src["openedAtMs"]: src, inst = r, R["inst"][k]["label"]
                break
    if not src:
        return lead("off", "Belum ada formasi tercatat", "Tidak ada observasi dengan rincian kandidat pada penyimpanan saat ini.")
    sf = src["smartFormation"]; cands = sf["candidates"]
    o = [lead("ok", "Formasi terakhir yang tercatat lengkap", "Dibentuk %s pada %s. Kolam %s kandidat, %s terpilih." % (
        esc(inst), esc(str(src.get("openedAt"))[:16]), sf.get("candidatePoolSize"), sum(1 for c in cands if c.get("selected"))))]
    for side in ("LONG", "SHORT"):
        rows = [c for c in cands if c.get("side") == side]
        if not rows: continue
        vals = [(c["score"] if side == "LONG" else -c["score"]) for c in rows]
        m = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals)) or 1e-9
        o.append("<h2>Kandidat %s</h2><div class='scroll'><table>"
                 "<tr><th>simbol</th><th class='num'>MOM36</th><th class='num'>peringkat baku</th><th class='num'>konfirmasi cepat</th>"
                 "<th class='num'>terlalu jauh</th><th class='num'>utility</th><th>klaster</th><th>terpilih</th></tr>" % side)
        for c in sorted(rows, key=lambda x: -(x.get("utility") or 0)):
            rr = ((c["score"] if side == "LONG" else -c["score"]) - m) / sd
            o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
                     "<td class='num'>%s</td><td class='num'><b>%s</b></td><td class='dim'>%s</td><td>%s</td></tr>" % (
                esc(c["symbol"].replace("USDT", "")), pct(100 * c["score"], 2), num(rr, 2),
                num(c.get("fastSupport"), 2), num(c.get("adverseExtensionVol"), 2), num(c.get("utility"), 3),
                esc(c.get("cluster") or "–"), DOT["ok"] if c.get("selected") else DOT["off"]))
        o.append("</table></div>")
    sel = [c for c in cands if c.get("selected")]
    ls = [c["score"] for c in sel if c["side"] == "LONG"]; ss = [c["score"] for c in sel if c["side"] == "SHORT"]
    gap = (sum(ls)/len(ls) - sum(ss)/len(ss)) if ls and ss else None
    thr = ((get(INST["live"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {}).get("minScoreGap")
    o.append("<h2>Basket terpilih</h2><div class='grid'>")
    o.append(card("Skor rata-rata long", pct(100 * sum(ls)/len(ls), 2) if ls else "–", ", ".join(c["symbol"].replace("USDT","") for c in sel if c["side"]=="LONG")))
    o.append(card("Skor rata-rata short", pct(100 * sum(ss)/len(ss), 2) if ss else "–", ", ".join(c["symbol"].replace("USDT","") for c in sel if c["side"]=="SHORT")))
    o.append(card("Pemisahan (scoreGap)", num(gap, 4), ("minimum %s — %s" % (num(thr, 3), "lolos" if isinstance(gap,float) and isinstance(thr,float) and gap>=thr else "tidak lolos")) if thr else "minimum tidak terbaca"))
    o.append(card("Utility gabungan", num(sf.get("objectiveScore"), 3), "sudah dikurangi penalti klaster"))
    o.append(card("Skor sumbu pasar", num(sf.get("axisScore"), 3), "dipakai untuk bonus konfirmasi sisi lawan"))
    o.append("</div>")
    o.append(tech("formasi", [("Versi", esc(sf.get("version"))), ("Ukuran kolam", str(sf.get("candidatePoolSize"))),
                              ("Sumber observasi", esc(str(src.get("openedAt")))),
                              ("Peringkat baku", "dihitung ulang di sini: (skor berarah − rata-rata kolam) ÷ simpangan baku kolam. Tidak disimpan runtime.")]))
    return "".join(o)

def tab_positions(R):
    o, any_open = [], False
    eq = (R["account"] or {}).get("accountEquity")
    now = datetime.now(timezone.utc)
    for k in ("live", "testnet"):
        i = R["inst"][k]; obs = i["ex"].get("openBaskets") or []
        o.append("<h2>%s · %d basket terbuka</h2>" % (i["label"], len(obs)))
        if not obs:
            o.append("<div class='card dim'>Tidak ada posisi terbuka.</div>"); continue
        any_open = True
        for b in obs:
            op = parse_iso(b.get("openedAt")); age = (now - op).total_seconds()/3600.0 if op else None
            capH = i["ex"].get("maxHoldHours")
            notional = sum(abs((l.get("qty") or 0) * (l.get("entryPrice") or 0)) for l in b.get("legs") or [])
            lnr = b.get("lastNetReturn"); sb = b.get("smartBasket") or {}
            o.append("<div class='card' style='margin-top:10px'>")
            o.append("<div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'>"
                     "<div><b>%s</b> <span class='dim'>· dibuka %s</span></div><div>%s</div></div>" % (
                esc(b.get("basketId")), esc(str(b.get("openedAt"))[:16]), pct(100*lnr, 3) if isinstance(lnr,float) else ""))
            o.append("<div class='grid' style='margin-top:9px'>")
            o.append(card("Umur / batas", "%.1f j / %s j" % (age, capH) if age is not None else "–",
                          "sisa %.1f jam" % (capH - age) if age is not None and capH else ""))
            o.append(card("Nilai posisi", money(notional, 0), ("%.0f%% ekuitas" % (100*notional/eq)) if eq else ""))
            o.append(card("P&amp;L berjalan", pct(100*lnr, 3) if isinstance(lnr,float) else "–",
                          money((lnr or 0) * notional / 2, 3) if isinstance(lnr,float) else ""))
            o.append(card("Puncak terbaik", pct(100*sb["maxNetReturn"], 3) if isinstance(sb.get("maxNetReturn"),float) else "–",
                          "pada %s" % str(sb.get("maxNetAt"))[:16] if sb.get("maxNetAt") else ""))
            o.append(card("Regime saat buka", esc(sb.get("regimeClassAtOpen") or "–"),
                          "sekarang %s" % esc(((R["axis"] or {}).get("current") or {}).get("regime") or "–")))
            o.append(card("Biaya dibukukan", money(b.get("feeEstimateUsd"), 4), "sumber bursa"))
            o.append("</div>")
            # ghost exits — live counters the executor still accrues although the exits are disabled
            scans = 2
            gh = [("Regime berbalik", sb.get("consecutiveRegimeLossScans"), sb.get("lastRegimeLossReason")),
                  ("Tesis batal", sb.get("consecutiveInvalidationScans"), sb.get("lastInvalidationReason"))]
            mfe = sb.get("maxNetReturn")
            mfe_hit = isinstance(mfe, float) and isinstance(lnr, float) and mfe >= 0.002 and lnr <= mfe * 0.5
            o.append("<h2 style='margin-top:14px'>Seandainya exit adaptif masih menyala</h2>")
            o.append("<div class='note'>Exit ini dimatikan; penghitungnya tetap berjalan, jadi angka di bawah keadaan nyata, bukan simulasi.</div>")
            o.append("<table><tr><th>aturan</th><th class='num'>scan berturut</th><th>akan memicu?</th><th>alasan terakhir</th></tr>")
            for nm, c, why in gh:
                fire = isinstance(c, int) and c >= scans
                o.append("<tr><td>%s</td><td class='num'>%s / %d</td><td>%s</td><td class='dim'>%s</td></tr>" % (
                    nm, c if c is not None else "–", scans, (DOT["block"]+" ya") if fire else (DOT["ok"]+" tidak"), esc(str(why or "–"))[:90]))
            o.append("<tr><td>Kunci laba (giveback)</td><td class='num'>–</td><td>%s</td><td class='dim'>puncak %s, sekarang %s</td></tr>" % (
                (DOT["block"]+" ya") if mfe_hit else (DOT["ok"]+" tidak"),
                pct(100*mfe,3) if isinstance(mfe,float) else "–", pct(100*lnr,3) if isinstance(lnr,float) else "–"))
            o.append("</table>")
            o.append("<div class='scroll'><table style='margin-top:10px'><tr><th>kaki</th><th>sisi</th><th class='num'>qty</th>"
                     "<th class='num'>harga masuk</th><th class='num'>harga kini</th><th class='num'>nilai</th>"
                     "<th class='num'>terbaik</th><th class='num'>terburuk</th><th>fill dikonfirmasi</th></tr>")
            for l in b.get("legs") or []:
                nv = abs((l.get("qty") or 0) * (l.get("entryPrice") or 0))
                o.append("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
                         "<td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td>%s</td></tr>" % (
                    esc(l.get("symbol","").replace("USDT","")), esc(l.get("side")), num(l.get("qty"), 4),
                    num(l.get("entryPrice"), 5), num(l.get("lastMarkPrice"), 5), money(nv, 2),
                    num(l.get("maxFavorableR"), 3), num(l.get("maxAdverseR"), 3),
                    DOT["ok"] if l.get("entryPriceConfirmed") else DOT["block"]))
            o.append("</table></div></div>")
    if not any_open:
        o.insert(0, lead("off", "Tidak ada posisi terbuka di mana pun", "Bot sedang menunggu formasi berikutnya."))
    return "".join(o)

def tab_edge(R):
    e = R["edge"]; W = e["windows"]; o = []
    allw = W["seluruhnya"]
    if not allw.get("n"):
        return lead("off", "Belum ada bukti", "Belum ada observasi sinyal produksi yang selesai.")
    ep = e["episodes"]
    o.append(lead("ok" if (allw.get("tStat") or 0) > 2 else "watch" if ep < 30 else "block" if (allw.get("meanPct") or 0) < 0 else "watch",
        "Rata-rata %s per basket dari %d observasi" % (pct(allw.get("meanPct"), 3), allw["n"]),
        "Tapi hanya <b>%d episode independen</b> — observasi bayangan dibuka tiap ~1 jam dan ditahan 48 jam, jadi jumlah mentahnya melebih-lebihkan bukti. Di bawah 30 episode, hasil apa pun sulit dibedakan dari nol." % ep))
    o.append("<div class='scroll'><table><tr><th>jendela</th><th class='num'>N</th><th class='num'>rata-rata</th>"
             "<th class='num'>menang</th><th class='num'>profit factor</th><th class='num'>drawdown</th><th class='num'>t-stat</th></tr>")
    for lbl in ("8 terakhir", "30 terakhir", "90 terakhir", "seluruhnya"):
        s = W[lbl]
        o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
                 "<td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>" % (
            lbl, s.get("n"), pct(s.get("meanPct"), 3), num(s.get("winPct"), 0) + "%" if s.get("n") else "–",
            num(s.get("pf"), 2), pct(s.get("ddPct"), 2, False), num(s.get("tStat"), 2)))
    o.append("</table></div>")
    o.append("<h2>Kurva hasil kumulatif</h2>")
    o.append(spark_area([c["net"] for c in e["curve"]]))
    o.append("<div class='note'>Sumbu tegak = jumlah kumulatif hasil bersih per basket (fraksi), bukan dolar.</div>")
    o.append("<h2>Hasil menurut pemisahan skor</h2>")
    o.append(bars([(b["key"], b.get("meanPct")) for b in e["byGap"]]))
    o.append("<h2>Pemisahan skor vs hasil akhir</h2>")
    thr = ((get(INST["live"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {}).get("minScoreGap") or 0.058
    o.append(scatter(e["gapVsReturn"], thr))
    o.append("<h2>Hasil menurut keadaan pasar</h2>")
    o.append(bars([(b["key"].replace("TREND_", "").replace("MIXED_", ""), b.get("meanPct")) for b in e["byRegime"]]))
    o.append("<h2>Hasil menurut lama tahan</h2>")
    o.append(bars([(b["key"], b.get("meanPct")) for b in e["byHold"]]))
    o.append("<h2>Kontribusi per bulan</h2>")
    o.append(bars([(b["key"][2:], b.get("totalPct")) for b in e["byMonth"]]))
    o.append("<h2>Sisi long vs short</h2>")
    o.append(bars([("long", e["sideLong"].get("meanPct")), ("short", e["sideShort"].get("meanPct"))]))
    o.append("<h2>Skor performa</h2><div class='grid'>")
    for key, lbl in (("overall","Performa keseluruhan"),("edge","Kualitas edge"),("recent","Performa terakhir"),
                     ("dd","Kendali drawdown"),("exec","Kualitas eksekusi"),("data","Kualitas data"),("research","Kekuatan bukti")):
        o.append(gauge(lbl, R["gauges"].get(key), GAUGE_DOC[key]))
    o.append("</div>")
    o.append(tech("sumber & metode", [
        ("Sinyal yang diukur", "<code>%s</code> — hanya observasi yang sudah selesai" % e["signal"]),
        ("Sumber", "penyimpanan observasi kedua instance, digabung dan dide-duplikasi"),
        ("Episode independen", "sampel non-tumpang-tindih pada horizon 48 jam — aturan yang sama dipakai harness"),
        ("Profit factor", "total hasil positif ÷ |total hasil negatif|"),
        ("t-stat di tabel", "rata-rata ÷ (simpangan baku ÷ √N); TIDAK dikoreksi untuk tumpang tindih, jadi terlalu optimistis"),
        ("t-stat dipakai skor", "t mentah × akar(episode independen ÷ N) — inilah yang masuk gauge Kualitas edge, supaya tidak membantah gauge Kekuatan bukti"),
        ("Biaya", "sudah termasuk — observasi menyimpan hasil bersih setelah biaya bolak-balik"),
        ("Funding & slippage", "tidak dibukukan terpisah oleh runtime — <b>tidak tersedia</b>"),
    ]))
    return "".join(o)

def tab_research(R):
    o = []
    rows = []
    for k in ("live", "testnet"):
        rows += R["inst"][k]["rows"]
    thr = ((get(INST["live"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {}).get("minScoreGap")
    o.append(lead("watch", "Perbandingan kebijakan dihitung dari observasi yang sama",
        "Kedua kebijakan dievaluasi pada himpunan sinyal identik, jadi selisihnya murni efek aturan — bukan perbedaan periode atau simbol."))
    if isinstance(thr, float) and rows:
        base = [r["netReturn"] for r in rows]
        prod = [r["netReturn"] for r in rows if isinstance(r.get("scoreGap"), float) and r["scoreGap"] >= thr]
        bs, ps = edge_stats(base), edge_stats(prod)
        o.append("<div class='scroll'><table><tr><th>kebijakan</th><th class='num'>N</th><th class='num'>rata-rata/basket</th>"
                 "<th class='num'>menang</th><th class='num'>total</th><th class='num'>drawdown</th><th class='num'>t-stat</th></tr>")
        for lbl, s in (("Tanpa ambang pemisahan (dasar)", bs), ("Produksi: ambang %.3f" % thr, ps)):
            o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s%%</td>"
                     "<td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>" % (
                lbl, s.get("n"), pct(s.get("meanPct"), 3), num(s.get("winPct"), 0),
                pct(s.get("totalPct"), 2), pct(s.get("ddPct"), 2, False), num(s.get("tStat"), 2)))
        o.append("</table></div>")
        o.append("<div class='note'>Ambang menaikkan kualitas per basket tetapi membuang sebagian peluang — total bisa turun meski rata-ratanya naik.</div>")
    else:
        o.append("<div class='card dim'>Bukti tidak cukup untuk membandingkan kebijakan.</div>")

    o.append("<h2>Varian sinyal yang berjalan berdampingan</h2>")
    per = {}
    for k in ("live", "testnet"):
        try: obs = (json.load(open(INST[k]["store"])) or {}).get("observations") or []
        except Exception: obs = []
        for ob in obs:
            if ob.get("status") == "OPEN": continue
            nr = ob.get("netReturn")
            if isinstance(nr, (int, float)): per.setdefault(ob.get("signal") or "?", []).append(nr)
    if per:
        o.append("<div class='scroll'><table><tr><th>varian</th><th class='num'>N</th><th class='num'>rata-rata</th><th class='num'>menang</th><th class='num'>t-stat</th><th>peran</th></tr>")
        for sig, v in sorted(per.items(), key=lambda x: -len(x[1]))[:8]:
            s = edge_stats(v)
            o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s%%</td><td class='num'>%s</td><td class='dim'>%s</td></tr>" % (
                esc(sig), s["n"], pct(s.get("meanPct"), 3), num(s.get("winPct"), 0), num(s.get("tStat"), 2),
                "produksi" if sig == PROD_SIGNAL else "pembanding"))
        o.append("</table></div>")
    o.append("<h2>Kelemahan yang diketahui</h2>")
    W = R["edge"]["windows"]["seluruhnya"]; ep = R["edge"]["episodes"]
    weak = []
    if ep < 30: weak.append(("block", "Bukti tipis", "%d episode independen. Di bawah 30, selisih sebesar edge lane ini tidak bisa dipisahkan dari nol." % ep))
    if W.get("n") and ep and W["n"] / max(ep, 1) > 3:
        weak.append(("watch", "Observasi sangat tumpang tindih", "%d observasi hanya mewakili %d episode (rasio %.1f×). Setiap t-stat di halaman ini terlalu optimistis." % (W["n"], ep, W["n"]/ep)))
    mo = R["edge"]["byMonth"]
    if len(mo) >= 2:
        tot = sum(abs(b.get("totalPct") or 0) for b in mo) or 1
        top = max(mo, key=lambda b: abs(b.get("totalPct") or 0))
        if abs(top.get("totalPct") or 0) / tot > .5:
            weak.append(("watch", "Hasil terkonsentrasi", "Bulan %s menyumbang %.0f%% dari seluruh pergerakan. Rata-rata tahunan menyembunyikan ini." % (top["key"], 100*abs(top["totalPct"])/tot)))
    if R["execQuality"]["pct"] is not None and R["execQuality"]["pct"] < 100:
        weak.append(("watch", "Sebagian harga fill tak terkonfirmasi", "%d dari %d harga dibukukan tanpa konfirmasi bursa." % (
            R["execQuality"]["total"] - R["execQuality"]["confirmed"], R["execQuality"]["total"])))
    if not weak: weak.append(("ok", "Tidak ada kelemahan terdeteksi otomatis", "Pemeriksaan ini hanya melihat ukuran sampel, tumpang tindih, konsentrasi, dan kualitas fill."))
    o.append("<table><tr><th>status</th><th>kelemahan</th><th>keterangan</th></tr>")
    for s, t, d in weak: o.append("<tr><td>%s</td><td>%s</td><td class='dim'>%s</td></tr>" % (DOT[s], t, d))
    o.append("</table>")
    o.append("<h2>Riwayat perubahan</h2>")
    log = sh("git -C %s log --oneline -12 2>/dev/null" % INST["live"]["rel"])
    if log and not log.startswith("ERR"):
        o.append("<div class='scroll'><table><tr><th>commit</th><th>keterangan</th></tr>%s</table></div>" % "".join(
            "<tr><td class='dim'>%s</td><td>%s</td></tr>" % (esc(l.split(" ",1)[0]), esc(l.split(" ",1)[1] if " " in l else ""))
            for l in log.splitlines()))
    else:
        o.append("<div class='card dim'>Tidak tersedia — direktori rilis ini bukan checkout git, jadi riwayat perubahan tidak bisa dibaca dari runtime.</div>")
    o.append(tech("cakupan & batasan pengukuran", [
        ("Termasuk", "biaya bolak-balik sudah dikurangi dari tiap observasi"),
        ("Tidak termasuk", "funding dan slippage tidak dibukukan terpisah oleh runtime — <b>tidak tersedia</b>"),
        ("Point-in-time", "observasi dicatat saat dibentuk dan diselesaikan pada horizonnya; tidak ada penulisan ulang ke belakang"),
        ("Holdout", "tidak ada pemisahan holdout di runtime — perbandingan di atas in-sample terhadap data yang sama"),
        ("Jalannya harness", "harness riset berjalan di luar layanan ini — <b>tidak tersedia</b> dari runtime"),
    ]))
    return "".join(o)

def tab_system(R):
    o, sysd = [], R["system"]
    bad = [j for j in sysd["jobs"] if j["stale"]] + [p for p in sysd["pm2"] if p["status"] != "online"]
    o.append(lead("block" if bad else "ok",
                  "Infrastruktur sehat" if not bad else "%d komponen perlu perhatian" % len(bad),
                  "Kesehatan sistem dinilai terpisah dari kesehatan edge: layanan bisa sempurna sementara strateginya rugi, dan sebaliknya."))
    o.append("<h2>Layanan</h2><table><tr><th>proses</th><th>status</th><th class='num'>restart</th></tr>")
    for p in sysd["pm2"]:
        o.append("<tr><td>%s</td><td>%s %s</td><td class='num'>%s</td></tr>" % (
            esc(p["name"]), DOT["ok"] if p["status"] == "online" else DOT["block"], esc(p["status"]), p["restarts"]))
    o.append("</table>")
    o.append("<h2>Kesegaran data</h2><table><tr><th>komponen</th><th>umur</th><th>ambang</th><th>status</th></tr>")
    for j in sysd["jobs"]:
        o.append("<tr><td>%s</td><td>%s</td><td class='dim'>%.0f jam</td><td>%s</td></tr>" % (
            j["job"], "tidak pernah" if j["ageHours"] is None else "%.1f jam" % j["ageHours"], j["maxHours"],
            (DOT["block"] + " berhenti") if j["stale"] else (DOT["ok"] + " berjalan")))
    for k in ("live", "testnet"):
        ex = R["inst"][k]["ex"]
        st = ex.get("signalStale")
        o.append("<tr><td>Sinyal %s</td><td>%.0f menit</td><td class='dim'>%.0f menit</td><td>%s</td></tr>" % (
            R["inst"][k]["label"], (ex.get("signalAgeMs") or 0)/60000.0, (ex.get("signalMaxAgeMs") or 0)/60000.0,
            (DOT["watch"] + " basi") if st else (DOT["ok"] + " segar")))
    o.append("</table>")
    prow = (R["inst"]["live"]["pool"] or {}).get("rows") or []
    miss = [r["symbol"] for r in prow if not isinstance(r.get("liquidityUsdPerHour"), (int, float))]
    o.append("<h2>Kualitas universe</h2><div class='grid'>")
    o.append(card("Simbol terukur", "%d / %d" % (len(prow) - len(miss), len(prow)), "likuiditas terbaca dari bursa"))
    o.append(card("Tidak terukur", str(len(miss)), esc(", ".join(s.replace("USDT","") for s in miss)) or "tidak ada"))
    o.append(card("Selisih kriteria", str(len((R["inst"]["live"]["pool"] or {}).get("mismatch") or [])), "pool vs kriteria mentah"))
    o.append("</div>")
    o.append("<h2>Kualitas eksekusi</h2>")
    drift = []
    for k in ("live", "testnet"):
        for b in (R["inst"][k]["ex"].get("recent") or [])[-6:]:
            plan = {p.get("symbol"): p for p in (b.get("plan") or []) if isinstance(p, dict)}
            for l in b.get("legs") or []:
                p = plan.get(l.get("symbol"))
                if not p: continue
                tgt, act = p.get("targetNotionalUsd"), abs((l.get("qty") or 0) * (l.get("entryPrice") or 0))
                if isinstance(tgt, (int, float)) and tgt > 0:
                    drift.append((l.get("symbol"), 100 * (act / tgt - 1),
                                  100 * ((l.get("entryPrice") or 0) / (p.get("refPrice") or 1) - 1) if p.get("refPrice") else None))
    o.append("<div class='grid'>")
    o.append(card("Harga fill terkonfirmasi", ("%.0f%%" % R["execQuality"]["pct"]) if R["execQuality"]["pct"] is not None else "–",
                  "%d dari %d nilai" % (R["execQuality"]["confirmed"], R["execQuality"]["total"])))
    if drift:
        rd = [d[1] for d in drift]
        pd_ = [d[2] for d in drift if isinstance(d[2], float)]
        o.append(card("Galat pembulatan lot", "%.1f%%" % (sum(abs(x) for x in rd)/len(rd)), "rata-rata simpangan dari nilai target"))
        o.append(card("Selisih harga masuk", ("%.3f%%" % (sum(abs(x) for x in pd_)/len(pd_))) if pd_ else "–", "fill vs harga acuan saat rencana"))
    o.append(card("Kaki yatim", str(len(R["inst"]["live"]["ex"].get("orphanedLegs") or []) + len(R["inst"]["testnet"]["ex"].get("orphanedLegs") or [])), "posisi tanpa basket induk"))
    o.append(card("Basket akunting belum lengkap", str(len(R["inst"]["live"]["ex"].get("accountingIncompleteBaskets") or []) + len(R["inst"]["testnet"]["ex"].get("accountingIncompleteBaskets") or [])), "tidak semua kaki punya harga keluar"))
    o.append("</div>")
    o.append("<h2>Perbedaan konfigurasi antar-instance</h2><div class='scroll'><table><tr><th>parameter</th><th>live</th><th>testnet</th><th>sama?</th></tr>")
    lv, tn = R["inst"]["live"]["ex"], R["inst"]["testnet"]["ex"]
    lc = ((get(INST["live"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {})
    tc = ((get(INST["testnet"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {})
    for lbl, a, b in (("Ukuran per kaki", lv.get("legUsd"), tn.get("legUsd")),
                      ("Batas tahan (jam)", lv.get("maxHoldHours"), tn.get("maxHoldHours")),
                      ("Stop (%)", lv.get("stopNetReturnPct"), tn.get("stopNetReturnPct")),
                      ("Ambil untung (%)", lv.get("tpNetReturnPct"), tn.get("tpNetReturnPct")),
                      ("Ambang pemisahan", lc.get("minScoreGap"), tc.get("minScoreGap")),
                      ("Sinyal", lc.get("signal"), tc.get("signal")),
                      ("Ukuran universe", len(lc.get("executionUniverse") or []), len(tc.get("executionUniverse") or [])),
                      ("Override gerbang bukti", lv.get("entryHealthBypassed"), tn.get("entryHealthBypassed"))):
        same = (a == b)
        o.append("<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            lbl, esc(a), esc(b), DOT["ok"] if same else DOT["watch"]))
    o.append("</table></div>")
    o.append("<div class='note'>Perbedaan pada baris terakhir memang disengaja: testnet melonggarkan perlindungan modal karena tidak punya modal untuk dilindungi, sementara parameter strategi sengaja dijaga identik agar hasilnya sebanding.</div>")
    o.append(tech("host & integritas", [
        ("Waktu host (UTC)", esc(sysd["hostTimeUtc"][:19])),
        ("Disk", "%s terpakai dari %s, sisa %s" % (sysd["disk"]["pct"], sysd["disk"]["size"], sysd["disk"]["avail"]) if sysd.get("disk") else "–"),
        ("Hash manifest kode", "<br>".join("%s: <code>%s</code>" % (k, (v or "tidak tersedia")[:20]) for k, v in (sysd["manifests"] or {}).items())),
        ("Kepatuhan kebijakan konfigurasi", "<br>".join("%s: %s" % (R["inst"][k]["label"], esc(R["inst"][k]["envPolicy"][:60])) for k in INST)),
    ]))
    return "".join(o)


def snapshot_md(R):
    """Compact, paste-able digest. Deliberately NOT the 310KB JSON: an assistant reasons better
    from a page of state than from a dump, and a smaller artefact leaks less if it is pasted
    somewhere careless."""
    a = R["account"]; liv = R["inst"]["live"]; tst = R["inst"]["testnet"]
    W = R["edge"]["windows"]; g = R["gauges"]; ax = (R["axis"] or {}).get("current") or {}
    L = []
    P = L.append
    P("# Kronos — ringkasan keadaan  (%s UTC)" % R["generatedAt"][:19])
    P("")
    P("Strategi: market-neutral lintas-simbol, 3 long / 3 short, peringkat momentum 36 jam,")
    P("ditahan sampai batas waktu kecuali stop/TP kena. Bursa: Binance USD-M Futures.")
    P("")
    P("## Modal")
    P("- Ekuitas: $%.2f  (wallet $%.2f, tersedia $%.2f)" % (
        a.get("accountEquity") or 0, a.get("walletBalance") or 0, a.get("availableBalance") or 0))
    P("- P&L belum terealisasi: $%.4f dari %s posisi" % (a.get("unrealizedPnl") or 0, a.get("openPositionCount")))
    P("- P&L terealisasi live: $%.4f dari %s basket selesai" % (liv["ex"].get("totalNetPnlUsd") or 0, liv["ex"].get("closedCount")))
    P("- P&L terealisasi testnet (uang demo): $%.4f dari %s basket" % (tst["ex"].get("totalNetPnlUsd") or 0, tst["ex"].get("closedCount")))
    P("")
    P("## Konfigurasi berjalan")
    fc = ((get(INST["live"]["api"] + "/api/shadow/cross-sectional-report") or {}).get("filteredConfig") or {})
    P("- Ukuran per kaki: $%s, leverage %s, eksposur kotor ~$%s" % (
        liv["ex"].get("legUsd"), liv["ex"].get("leverage"),
        (liv["ex"].get("legUsd") or 0) * 6))
    P("- Batas tahan %s jam; stop/TP simetris ±%s%% / %s%% dari nilai basket" % (
        liv["ex"].get("maxHoldHours"), liv["ex"].get("stopNetReturnPct"), liv["ex"].get("tpNetReturnPct")))
    P("- Ambang pemisahan skor long-short: %s" % fc.get("minScoreGap"))
    P("- Exit adaptif (regime/tesis/kunci-laba): DIMATIKAN sejak 2026-08-19")
    P("")
    P("## Izin masuk")
    for k in ("live", "testnet"):
        i = R["inst"][k]
        P("- %s: tier %s%s — %s" % (i["label"], i["adm"].get("tier"),
          " (override operator)" if i["ex"].get("entryHealthBypassed") else "",
          str(i["adm"].get("reason") or "semua syarat terpenuhi")[:150]))
        P("  gerbang bukti: 8 terakhir %s, 30 terakhir %s" % (
          ("%+.3f%%" % i["gate"]["last8"]) if isinstance(i["gate"]["last8"], float) else "n/a",
          ("%+.3f%%" % i["gate"]["last30"]) if isinstance(i["gate"]["last30"], float) else "n/a"))
    P("")
    P("## Posisi terbuka")
    got = False
    for k in ("live", "testnet"):
        for b in R["inst"][k]["ex"].get("openBaskets") or []:
            got = True
            lnr = b.get("lastNetReturn")
            P("- [%s] %s dibuka %s, P&L berjalan %s" % (
              R["inst"][k]["label"], b.get("basketId"), str(b.get("openedAt"))[:16],
              ("%+.3f%%" % (100 * lnr)) if isinstance(lnr, float) else "n/a"))
            P("  kaki: %s" % ", ".join("%s %s" % (l.get("side"), (l.get("symbol") or "").replace("USDT", ""))
                                       for l in b.get("legs") or []))
    if not got: P("- tidak ada")
    P("")
    P("## Bukti performa (sinyal produksi %s)" % R["edge"]["signal"])
    P("| jendela | N | rata-rata/basket | menang | t-stat |")
    P("|---|---|---|---|---|")
    for lbl in ("8 terakhir", "30 terakhir", "90 terakhir", "seluruhnya"):
        s_ = W[lbl]
        P("| %s | %s | %s | %s | %s |" % (lbl, s_.get("n"),
          ("%+.3f%%" % s_["meanPct"]) if s_.get("n") else "-",
          ("%.0f%%" % s_["winPct"]) if s_.get("n") else "-",
          ("%.2f" % s_["tStat"]) if isinstance(s_.get("tStat"), float) else "-"))
    P("")
    P("PENTING untuk interpretasi: N di atas adalah observasi bayangan yang dibuka tiap ~1 jam dan")
    P("ditahan 48 jam, jadi hampir seluruhnya tumpang tindih. Episode benar-benar independen: **%d**." % R["edge"]["episodes"])
    P("Semua t-stat di tabel TIDAK dikoreksi untuk tumpang tindih, jadi terlalu optimistis.")
    if isinstance(g.get("edgeTRaw"), float) and isinstance(g.get("edgeTEff"), float):
        P("t-stat setelah dikoreksi tumpang tindih: %.2f (mentah %.2f)." % (g["edgeTEff"], g["edgeTRaw"]))
    P("")
    P("## Keadaan pasar")
    P("- Regime: %s, zona %s, skor sumbu %s" % (
        ax.get("regime"), ((R["axis"] or {}).get("guidance") or {}).get("zoneLabel"),
        ("%.3f" % ax["score"]) if isinstance(ax.get("score"), float) else "n/a"))
    P("- Mode directional: %s (%s)" % ((R["dir"] or {}).get("mode"), (R["dir"] or {}).get("marketRegime")))
    P("")
    P("## Skor 0-100")
    for key, lbl in (("overall", "Keseluruhan"), ("edge", "Kualitas edge"), ("recent", "Performa terakhir"),
                     ("dd", "Kendali drawdown"), ("exec", "Kualitas eksekusi"), ("data", "Kualitas data"),
                     ("research", "Kekuatan bukti")):
        v = g.get(key)
        P("- %s: %s" % (lbl, ("%d" % round(v)) if isinstance(v, float) else "tidak tersedia"))
    P("")
    al = _alerts(R)
    P("## Peringatan aktif")
    if not al: P("- tidak ada")
    for s_, t, d in al: P("- [%s] %s — %s" % (s_.upper(), t, d))
    P("")
    P("## Yang TIDAK tersedia dari runtime (jangan diasumsikan)")
    P("- funding dan slippage tidak dibukukan terpisah")
    P("- provenance harness riset tidak terekspos")
    P("- tidak ada pemisahan holdout; perbandingan kebijakan bersifat in-sample")
    return "\n".join(L)

TABS = [("overview", "Ringkasan", tab_overview), ("strategy", "Strategi", tab_strategy),
        ("decision", "Keputusan", tab_decision), ("formation", "Formasi", tab_formation),
        ("positions", "Posisi", tab_positions), ("edge", "Edge", tab_edge),
        ("research", "Riset", tab_research), ("system", "Sistem", tab_system)]

def render(R):
    body = []
    for i, (tid, lbl, fn) in enumerate(TABS):
        try: html = fn(R)
        except Exception as e:
            html = "<div class='lead'><div class='c'>🔴 Tab gagal dirender</div><div class='r'>%s</div></div>" % esc(str(e)[:220])
        body.append("<section id='%s'%s>%s</section>" % (tid, " class='on'" if i == 0 else "", html))
    nav = "".join("<button data-t='%s'%s>%s</button>" % (t, " class='on'" if i == 0 else "", l)
                  for i, (t, l, _) in enumerate(TABS))
    js = ("<script>document.querySelectorAll('nav button').forEach(function(b){b.onclick=function(){"
          "document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('on')});"
          "document.querySelectorAll('section').forEach(function(x){x.classList.remove('on')});"
          "b.classList.add('on');document.getElementById(b.dataset.t).classList.add('on');"
          "location.hash=b.dataset.t};});"
          "if(location.hash){var b=document.querySelector(\"nav button[data-t='\"+location.hash.slice(1)+\"']\");if(b)b.click();}"
          "</script>")
    return ("<!doctype html><html lang='id'><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>Kronos · kokpit</title><style>%s</style><div class='wrap'>"
            "<header><h1>KRONOS · kokpit trading</h1><span class='stamp'>%s UTC · hanya-baca, tanpa kunci bursa</span></header>"
            "<nav>%s</nav>%s</div>%s</html>") % (CSS, R["generatedAt"][:19], nav, "".join(body), js)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        try:
            if self.path.startswith("/api/report"):
                R = collect()
                slim = {k: v for k, v in R.items() if k != "inst"}
                slim["inst"] = {k: {kk: vv for kk, vv in v.items() if kk not in ("rows",)} for k, v in R["inst"].items()}
                body, ct = json.dumps(slim, default=str).encode(), "application/json"
            elif self.path.startswith("/snapshot"):
                body, ct = snapshot_md(collect()).encode(), "text/plain; charset=utf-8"
            elif self.path == "/healthz":
                body, ct = b"ok", "text/plain"
            else:
                body, ct = render(collect()).encode(), "text/html; charset=utf-8"
            self.send_response(200); self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as e:
            m = ("cockpit error: %s" % e).encode()
            self.send_response(500); self.send_header("Content-Length", str(len(m))); self.end_headers(); self.wfile.write(m)

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
