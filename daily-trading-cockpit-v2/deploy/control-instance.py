#!/usr/bin/env python3
"""Kronos control + report instance (port 3104).

READ-ONLY BY CONSTRUCTION. It holds no Binance credentials and never imports an exchange client:
it GETs from the live/testnet APIs and reads files on disk. It cannot place, cancel, or size an
order. Control is presented as copy-paste commands, deliberately not as buttons — a one-click
surface onto a real-money account is a different risk class than a report.

Every figure is labelled with where it came from. Anything derived from a model says MODEL and
carries its assumptions, because the lane's own edge is weak (t~1.27 across 48 block offsets) and
episodic (59% of two years of profit landed in one quarter) — a projection printed without that
context would read as a promise.
"""
import json, os, subprocess, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone, timedelta

PORT = 3104
LIVE, TEST = "http://127.0.0.1:3103", "http://127.0.0.1:3102"
LIVE_REL = "/root/kronos-live-releases/migrate-20260818T060000Z/daily-trading-cockpit-v2"
TEST_REL = "/root/kronos-testnet-releases/history-fb-lock-20260814T130500Z/daily-trading-cockpit-v2"
ARCHIVE = "/root/xsec-archive"

# --- measured constants, all from the 2026-08-19 harness runs -------------------------------
MEAN_PER_BASKET = 0.001276   # gap 0.058 + smart exits off, 36h cap, +-6% guards, 9 offsets/2.00yr
BASKETS_PER_YEAR = 183.0     # same run
USD_PER_RETURN_PER_LEG = 4.8 # netReturn x 4.8 x legUsd = USD; from live basket xb-msyft2cg
OLD_MEAN, OLD_BPY = -0.000304, 241.0   # the configuration that ran before 2026-08-19

def get(url, timeout=12):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception as e:
        return {"__error__": str(e)[:160]}

def sh(cmd, timeout=20):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception as e:
        return "ERR %s" % str(e)[:80]

def age_h(path):
    try: return (time.time() - os.path.getmtime(path)) / 3600.0
    except OSError: return None

def collect():
    now = datetime.now(timezone.utc)
    acct = get(LIVE + "/api/live/account")
    ex_l = get(LIVE + "/api/live/cross-sectional-executor")
    ex_t = get(TEST + "/api/live/cross-sectional-executor")
    pool_l = get(LIVE + "/api/live/cross-sectional-pool")
    axis = get(LIVE + "/api/shadow/regime-axis-timeline")
    dirr = get(LIVE + "/api/live/cross-sectional-directional-regime")
    rep_l = get(LIVE + "/api/shadow/cross-sectional-report")
    rep_t = get(TEST + "/api/shadow/cross-sectional-report")

    equity = acct.get("accountEquity")
    leg = ex_l.get("legUsd") or 25

    # ---- MODEL: projection -----------------------------------------------------------------
    days_left = ((now.replace(day=1) + timedelta(days=32)).replace(day=1) - now).days
    per_basket_usd = MEAN_PER_BASKET * USD_PER_RETURN_PER_LEG * leg
    per_day_usd = per_basket_usd * BASKETS_PER_YEAR / 365.0
    proj = None
    if isinstance(equity, (int, float)):
        proj = {
            "daysLeft": days_left,
            "perBasketUsd": per_basket_usd,
            "perDayUsd": per_day_usd,
            "monthEndUsd": equity + per_day_usd * days_left,
            "monthEndPct": 100 * (per_day_usd * days_left) / equity,
            "annualPct": 100 * (per_day_usd * 365) / equity,
            "oldPerDayUsd": OLD_MEAN * USD_PER_RETURN_PER_LEG * leg * OLD_BPY / 365.0,
        }
    sims = []
    for mult in (1, 2, 4, 10, 20):
        cap = (equity or 0) * mult
        l2 = leg * mult
        d = MEAN_PER_BASKET * USD_PER_RETURN_PER_LEG * l2 * BASKETS_PER_YEAR / 365.0
        sims.append({"multiple": mult, "capitalUsd": cap, "legUsd": l2,
                     "perDayUsd": d, "perMonthUsd": d * 30, "perYearUsd": d * 365,
                     "annualPct": (100 * d * 365 / cap) if cap else None})

    # ---- health ----------------------------------------------------------------------------
    def inst_health(ex, rel, iid, port):
        adm = ex.get("entryAdmission") or {}
        chk = sh("%s/deploy/apply-required-env.sh --check %s/.env %s 2>&1 | tail -1" % (rel, rel, iid))
        return {
            "port": port,
            "openBaskets": len(ex.get("openBaskets") or []),
            "closedCount": ex.get("closedCount"),
            "totalNetPnlUsd": ex.get("totalNetPnlUsd"),
            "tier": adm.get("tier"),
            "bypassed": ex.get("entryHealthBypassed"),
            "admissionReason": (adm.get("reason") or "")[:180],
            "lastError": ex.get("lastError"),
            "configErrors": ex.get("configErrors"),
            "orphanedLegs": len(ex.get("orphanedLegs") or []),
            "signalStale": ex.get("signalStale"),
            "legUsd": ex.get("legUsd"),
            "stop": ex.get("stopNetReturnPct"), "tp": ex.get("tpNetReturnPct"), "cap": ex.get("maxHoldHours"),
            "envPolicy": chk,
        }

    pm2 = []
    try:
        for p in json.loads(sh("pm2 jlist") or "[]"):
            e = p.get("pm2_env", {})
            pm2.append({"name": p.get("name"), "status": e.get("status"), "restarts": e.get("restart_time")})
    except Exception:
        pass

    jobs = []
    for label, path, max_h in (("perekam positioning", "/root/xsec-sim/record.log", 2.0),
                               ("arsip observasi", ARCHIVE + "/harvest.log", 2.0),
                               ("cek drift env", "/root/env-drift.log", 26.0),
                               ("microstructure", "/root/kronos-microstructure/cron.log", 2.0)):
        a = age_h(path)
        jobs.append({"job": label, "ageHours": a, "stale": (a is None or a > max_h), "maxHours": max_h})

    arch = []
    for f in sorted(__import__("glob").glob(ARCHIVE + "/*.jsonl")):
        arch.append({"file": os.path.basename(f),
                     "rows": sum(1 for _ in open(f)),
                     "mb": os.path.getsize(f) / 1048576})

    def shadow_gate(rep):
        fr = (rep or {}).get("filteredReport") or {}
        v = fr.get("recentNetReturns") or []
        if len(v) < 8: return {"n": len(v), "last8": None, "last30": None}
        return {"n": len(v), "last8": 100 * sum(v[-8:]) / 8,
                "last30": 100 * sum(v[-30:]) / len(v[-30:]),
                "openFiltered": len((rep or {}).get("filteredOpenBaskets") or [])}

    cur = (axis.get("current") or {}) if isinstance(axis, dict) else {}
    guid = (axis.get("guidance") or {}) if isinstance(axis, dict) else {}
    fc = (axis.get("forecast") or {}) if isinstance(axis, dict) else {}
    ed = (axis.get("entryDecision") or {}) if isinstance(axis, dict) else {}

    return {
        "generatedAt": now.isoformat(),
        "account": acct,
        "projection": proj,
        "capitalSim": sims,
        "live": inst_health(ex_l, LIVE_REL, "3103", 3103),
        "testnet": inst_health(ex_t, TEST_REL, "3102", 3102),
        "gateLive": shadow_gate(rep_l), "gateTestnet": shadow_gate(rep_t),
        "pool": {"counts": (pool_l or {}).get("counts"), "leg": (pool_l or {}).get("leg"),
                 "reconciliation": (pool_l or {}).get("reconciliation")},
        "regime": {"score": cur.get("score"), "regime": cur.get("regime"), "at": cur.get("at"),
                   "zone": guid.get("zoneLabel"), "direction": guid.get("direction"),
                   "slopePerHour": axis.get("slopePerHour") if isinstance(axis, dict) else None,
                   "forecastBias": fc.get("bias"), "forecastConfidence": fc.get("confidence"),
                   "entryAction": ed.get("action"), "entryReason": (ed.get("reason") or "")[:200],
                   "breadthNote": (axis.get("note") or "")[:220] if isinstance(axis, dict) else None},
        "directional": {"mode": dirr.get("mode"), "marketRegime": dirr.get("marketRegime"),
                        "family": dirr.get("canonicalRegimeFamily"), "reason": (dirr.get("reason") or "")[:200],
                        "enabled": dirr.get("enabled"), "scanFinishedAt": dirr.get("scanFinishedAt")},
        "pm2": pm2, "jobs": jobs, "archive": arch,
        "disk": sh("df -h / | tail -1"),
    }

# ------------------------------------------------------------------------------------------
CSS = """
*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#c9d1d9;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:1180px;margin:0 auto;padding:20px}
h1{font-size:17px;margin:0 0 2px;color:#e6edf3}h2{font-size:13px;margin:26px 0 8px;color:#e6edf3;border-bottom:1px solid #21262d;padding-bottom:5px;letter-spacing:.04em;text-transform:uppercase}
.sub{color:#7d8590;font-size:11px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.card{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:11px 13px}
.k{color:#7d8590;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.v{font-size:19px;color:#e6edf3;margin-top:3px}.v small{font-size:11px;color:#7d8590}
table{width:100%;border-collapse:collapse;margin-top:6px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #21262d}
th{color:#7d8590;font-weight:400;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.ok{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}.dim{color:#7d8590}
.model{background:#1c2128;border-left:3px solid #d29922;padding:9px 12px;margin:10px 0;color:#c9d1d9;font-size:11.5px;border-radius:0 4px 4px 0}
pre{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:10px;overflow-x:auto;font-size:11px;color:#c9d1d9;margin:6px 0}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid}
.t-ok{color:#3fb950;border-color:#238636}.t-bad{color:#f85149;border-color:#8b2c26}.t-warn{color:#d29922;border-color:#9e6a03}
"""

def fnum(v, d=2, suf=""):
    if not isinstance(v, (int, float)):
        return "<span class='dim'>-</span>"
    return format(round(v, d), ",.%df" % d) + suf

def tone(v):
    if not isinstance(v, (int, float)): return "dim"
    return "ok" if v > 0 else ("bad" if v < 0 else "dim")

def render(r):
    a = r.get("account") or {}
    p = r.get("projection") or {}
    o = []
    A = o.append
    A("<div class='wrap'><h1>KRONOS · kontrol &amp; laporan</h1>")
    A("<div class='sub'>%s UTC · port %d · read-only, tanpa kunci bursa — instance ini tidak bisa mengirim order</div>" % (r["generatedAt"][:19], PORT))

    A("<h2>Modal</h2><div class='grid'>")
    for k, lbl, d in (("accountEquity", "ekuitas", 2), ("walletBalance", "wallet", 2),
                      ("availableBalance", "tersedia", 2), ("unrealizedPnl", "belum terealisasi", 4)):
        v = a.get(k)
        A("<div class='card'><div class='k'>%s</div><div class='v %s'>$%s</div></div>" % (lbl, tone(v) if k == "unrealizedPnl" else "", fnum(v, d)))
    A("</div>")

    if p:
        A("<h2>Proyeksi</h2>")
        A("<div class='model'><b>MODEL</b> — bukan jaminan. Dari harness 2026-08-19: <b>%+.4f%%/basket</b> (gap 0.058 + smart exit mati, cap 36j, ±6%%), <b>%.0f basket/tahun</b>, faktor USD = netReturn × 4.8 × legUsd. "
          "Edge lane ini lemah (t≈1.27 lintas 48 offset) dan <b>episodik</b> — 59%% laba 2 tahun jatuh di satu kuartal. Kuartal berjalan berdispersi rendah, jadi jumlah basket jangka pendek akan <b>di bawah</b> 183/tahun."
          "</div>" % (100 * MEAN_PER_BASKET, BASKETS_PER_YEAR))
        A("<div class='grid'>")
        A("<div class='card'><div class='k'>akhir bulan (%d hari lagi)</div><div class='v'>$%s</div></div>" % (p["daysLeft"], fnum(p["monthEndUsd"])))
        A("<div class='card'><div class='k'>tambahan bulan ini</div><div class='v %s'>%+.2f%%</div></div>" % (tone(p["monthEndPct"]), p["monthEndPct"]))
        A("<div class='card'><div class='k'>setara per tahun</div><div class='v %s'>%+.1f%%</div></div>" % (tone(p["annualPct"]), p["annualPct"]))
        A("<div class='card'><div class='k'>per basket</div><div class='v'>$%s</div></div>" % fnum(p["perBasketUsd"], 3))
        A("<div class='card'><div class='k'>konfigurasi LAMA</div><div class='v %s'>$%s<small>/hari</small></div></div>" % (tone(p["oldPerDayUsd"]), fnum(p["oldPerDayUsd"], 3)))
        A("</div>")

        A("<h2>Simulasi penambahan modal</h2>")
        A("<div class='model'><b>MODEL</b> — leg diasumsikan ikut naik proporsional. Skalanya linier dalam USD, <b>persentasenya tidak berubah</b>: menambah modal menambah nominal, bukan edge. "
          "Satu efek nyata yang tidak linier dan menguntungkan: leg lebih besar memperkecil galat pembulatan lot (AAVE meleset +49%% pada leg $17,50 tapi cuma +5%% pada $25), sehingga basket lebih netral.</div>")
        A("<table><tr><th>modal</th><th>leg</th><th>per hari</th><th>per bulan</th><th>per tahun</th><th>%/tahun</th></tr>")
        for s in r["capitalSim"]:
            A("<tr><td>$%s%s</td><td>$%s</td><td>$%s</td><td>$%s</td><td>$%s</td><td class='%s'>%+.1f%%</td></tr>" % (
                fnum(s["capitalUsd"]), " <span class='dim'>(sekarang)</span>" if s["multiple"] == 1 else "",
                fnum(s["legUsd"], 0), fnum(s["perDayUsd"], 3), fnum(s["perMonthUsd"]), fnum(s["perYearUsd"]),
                tone(s["annualPct"]), s["annualPct"] or 0))
        A("</table>")

    A("<h2>Performa &amp; kesehatan instance</h2><table>")
    A("<tr><th>instance</th><th>tier</th><th>terbuka</th><th>ditutup</th><th>P&amp;L bersih</th><th>leg</th><th>stop/tp/cap</th><th>error</th><th>kebijakan env</th></tr>")
    for nm, key in (("live 3103", "live"), ("testnet 3102", "testnet")):
        h = r[key]
        tier = h.get("tier") or "?"
        tcls = "t-ok" if tier == "GREEN" else ("t-warn" if tier == "YELLOW" else "t-bad")
        err = h.get("lastError") or h.get("configErrors")
        pol = "ok" if "OK:" in (h.get("envPolicy") or "") else "bad"
        A("<tr><td>%s</td><td><span class='tag %s'>%s</span>%s</td><td>%s</td><td>%s</td><td class='%s'>$%s</td><td>$%s</td><td>%s/%s/%sj</td><td class='%s'>%s</td><td class='%s'>%s</td></tr>" % (
            nm, tcls, tier, " <span class='dim'>bypass</span>" if h.get("bypassed") else "",
            h.get("openBaskets"), h.get("closedCount"), tone(h.get("totalNetPnlUsd")), fnum(h.get("totalNetPnlUsd"), 4),
            fnum(h.get("legUsd"), 0), h.get("stop"), h.get("tp"), h.get("cap"),
            "bad" if err else "ok", (str(err)[:40] if err else "bersih"),
            pol, (h.get("envPolicy") or "?")[:34]))
    A("</table>")
    for nm, key in (("live", "live"), ("testnet", "testnet")):
        h = r[key]
        if h.get("admissionReason"):
            A("<div class='sub'><b>%s admission:</b> %s</div>" % (nm, h["admissionReason"]))

    A("<h2>Gerbang entry-health (baca laporan shadow, bukan basket tereksekusi)</h2><table>")
    A("<tr><th>instance</th><th>sampel</th><th>last8</th><th>last30</th><th>shadow terbuka</th><th>vonis</th></tr>")
    for nm, g in (("live", r["gateLive"]), ("testnet", r["gateTestnet"])):
        l8, l30 = g.get("last8"), g.get("last30")
        ok = isinstance(l8, float) and isinstance(l30, float) and l8 > 0 and l30 > 0
        A("<tr><td>%s</td><td>%s</td><td class='%s'>%s</td><td class='%s'>%s</td><td>%s</td><td class='%s'>%s</td></tr>" % (
            nm, g.get("n"), tone(l8), fnum(l8, 4, "%"), tone(l30), fnum(l30, 4, "%"),
            g.get("openFiltered"), "ok" if ok else "bad", "lolos" if ok else "memblokir"))
    A("</table>")

    rg = r["regime"]; dr = r["directional"]
    A("<h2>Regime · breadth · arah</h2><div class='grid'>")
    for lbl, v in (("skor axis", fnum(rg.get("score"), 4)), ("regime", rg.get("regime") or "–"),
                   ("zona", rg.get("zone") or "–"), ("slope/jam", fnum(rg.get("slopePerHour"), 4)),
                   ("forecast", "%s / %s" % (rg.get("forecastBias") or "–", rg.get("forecastConfidence") or "–")),
                   ("keputusan entry", rg.get("entryAction") or "–"),
                   ("mode directional", dr.get("mode") or "–"), ("regime pasar", dr.get("marketRegime") or "–")):
        A("<div class='card'><div class='k'>%s</div><div class='v' style='font-size:15px'>%s</div></div>" % (lbl, v))
    A("</div>")
    if rg.get("breadthNote"): A("<div class='sub'>breadth: %s</div>" % rg["breadthNote"])
    if dr.get("reason"): A("<div class='sub'>directional: %s</div>" % dr["reason"])

    pc = (r["pool"] or {}).get("counts") or {}
    rec = (r["pool"] or {}).get("reconciliation") or {}
    A("<h2>Pool / scanner</h2><div class='grid'>")
    for lbl, v in (("universe", pc.get("universe")), ("pool long", pc.get("poolLong")), ("pool short", pc.get("poolShort")),
                   ("short diblok", pc.get("shortBlocked")), ("short layak", pc.get("shortEligible"))):
        A("<div class='card'><div class='k'>%s</div><div class='v'>%s</div></div>" % (lbl, v if v is not None else "–"))
    A("</div>")
    adds, drops = rec.get("adds") or [], rec.get("drops") or []
    A("<div class='sub'>rekonsiliasi: %s</div>" % ("<span class='ok'>tidak ada yang perlu diubah</span>" if not adds and not drops
        else "<span class='warn'>tambah %s · keluarkan %s</span>" % (", ".join(adds) or "–", ", ".join(drops) or "–")))

    A("<h2>Komponen macet / basi / error</h2><table><tr><th>komponen</th><th>umur</th><th>ambang</th><th>status</th></tr>")
    for j in r["jobs"]:
        A("<tr><td>%s</td><td>%s</td><td>%.0f j</td><td class='%s'>%s</td></tr>" % (
            j["job"], ("%.1f j" % j["ageHours"]) if j["ageHours"] is not None else "–",
            j["maxHours"], "bad" if j["stale"] else "ok", "BASI" if j["stale"] else "segar"))
    for pr in r["pm2"]:
        st = pr.get("status")
        A("<tr><td>pm2 · %s</td><td class='dim'>restart %s</td><td>–</td><td class='%s'>%s</td></tr>" % (
            pr.get("name"), pr.get("restarts"), "ok" if st == "online" else "bad", st))
    A("<tr><td>disk</td><td colspan='2' class='dim'>%s</td><td class='%s'>%s</td></tr>" % (
        r["disk"], "warn" if "9" in (r["disk"] or "").split()[-2][:2] else "ok", (r["disk"] or "").split()[-2] if r["disk"] else "?"))
    A("</table>")

    if r["archive"]:
        A("<h2>Arsip observasi (append-only, tak pernah dipangkas)</h2><table><tr><th>berkas</th><th>baris</th><th>ukuran</th></tr>")
        for x in r["archive"]:
            A("<tr><td>%s</td><td>%s</td><td>%.2f MB</td></tr>" % (x["file"], x["rows"], x["mb"]))
        A("</table>")

    A("<h2>Perintah kontrol</h2>")
    A("<div class='sub'>Sengaja teks, bukan tombol — satu klik ke akun uang nyata itu kelas risiko yang berbeda dari sebuah laporan.</div>")
    A("<pre># cek kepatuhan kebijakan env (jalankan SETIAP habis cutover rilis, sebelum arming)\n"
      "%s/deploy/apply-required-env.sh --check %s/.env 3103\n"
      "%s/deploy/apply-required-env.sh --check %s/.env 3102\n\n"
      "# cabut bypass entry-health live setelah buktinya mendarat\n"
      "sed -i 's|^CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH=.*|CROSS_SECTIONAL_EXEC_FORCE_IGNORE_ENTRY_HEALTH=0|' %s/.env &amp;&amp; pm2 restart dtc-api-live\n\n"
      "# hentikan entry baru di live tanpa menyentuh posisi terbuka\n"
      "sed -i 's|^CROSS_SECTIONAL_EXEC_ENABLED=.*|CROSS_SECTIONAL_EXEC_ENABLED=0|' %s/.env &amp;&amp; pm2 restart dtc-api-live\n\n"
      "# log\npm2 logs dtc-api-live --lines 80 --nostream\ntail -20 /root/env-drift.log</pre>"
      % (LIVE_REL, LIVE_REL, TEST_REL, TEST_REL, LIVE_REL, LIVE_REL))
    A("</div>")
    return "<!doctype html><meta charset='utf-8'><title>Kronos kontrol</title><meta http-equiv='refresh' content='60'><style>%s</style>%s" % (CSS, "".join(o))

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        try:
            if self.path.startswith("/api/report"):
                body = json.dumps(collect(), default=str).encode(); ctype = "application/json"
            elif self.path in ("/", "/index.html"):
                body = render(collect()).encode(); ctype = "text/html; charset=utf-8"
            elif self.path == "/healthz":
                body = b"ok"; ctype = "text/plain"
            else:
                self.send_response(404); self.end_headers(); self.wfile.write(b"not found"); return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        except Exception as e:
            msg = ("collector error: %s" % e).encode()
            self.send_response(500); self.send_header("Content-Length", str(len(msg))); self.end_headers(); self.wfile.write(msg)

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
