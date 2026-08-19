#!/usr/bin/env python3
"""Kronos control cockpit (3104) — trading + research + decision audit.

READ-ONLY BY CONSTRUCTION: no exchange credentials, no exchange client. It GETs from the
live/testnet APIs and reads their stores. It cannot place, cancel, or size an order.

Every number is read from runtime or computed here from runtime data. Nothing about measured
performance is hardcoded. Where runtime has no source the UI says so.
"""
import json, math, os, statistics as st, subprocess, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone, timedelta

PORT = 3104
INST = {
 "live":    {"api":"http://127.0.0.1:3103","label":"LIVE","long":"LIVE · mainnet","port":3103,"id":"3103",
             "rel":"/root/kronos-live-releases/migrate-20260818T060000Z/daily-trading-cockpit-v2",
             "store":"/root/kronos-live/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json"},
 "testnet": {"api":"http://127.0.0.1:3102","label":"TESTNET","long":"TESTNET · uang demo","port":3102,"id":"3102",
             "rel":"/root/kronos-testnet-releases/history-fb-lock-20260814T130500Z/daily-trading-cockpit-v2",
             "store":"/root/kronos-testnet-releases/128b09f/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json"},
}
PROD_SIGNAL = "MOM36_FILTERED"
NA = "Tidak tersedia"
_c = {"at":0.0,"d":None}; TTL = 25.0

def get(u,t=12):
    try:
        with urllib.request.urlopen(u,timeout=t) as r: return json.load(r)
    except Exception as e: return {"__error__":str(e)[:140]}

def sh(c,t=25):
    try: return subprocess.run(c,shell=True,capture_output=True,text=True,timeout=t).stdout.strip()
    except Exception as e: return "ERR %s"%str(e)[:60]

def age_h(p):
    try: return (time.time()-os.path.getmtime(p))/3600.0
    except OSError: return None

def piso(s):
    try: return datetime.strptime(str(s)[:19],"%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception: return None

def clamp(v,lo=0.0,hi=100.0): return max(lo,min(hi,v))
def fin(v): return isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)

# ------------------------------------------------------------------ statistics
def _dd(seq):
    eq=peak=worst=0.0
    for x in seq:
        eq+=x; peak=max(peak,eq); worst=min(worst,eq-peak)
    return worst

def stats(rets):
    n=len(rets)
    if not n: return {"n":0}
    m=sum(rets)/n
    w=[r for r in rets if r>0]; l=[r for r in rets if r<0]
    pf=(sum(w)/abs(sum(l))) if l and sum(l)!=0 else None
    t=None
    if n>1:
        sd=st.stdev(rets)
        if sd>0: t=m/(sd/math.sqrt(n))
    return {"n":n,"meanPct":100*m,"winPct":100*len(w)/n,"pf":pf,"tStat":t,
            "ddPct":100*_dd(rets),"totalPct":100*sum(rets)}

def episodes_of(rows,hz_h=48):
    kept,free=0,None
    for r in sorted(rows,key=lambda x:x["openedAtMs"]):
        if free is None or r["openedAtMs"]>=free:
            kept+=1; free=r["openedAtMs"]+hz_h*3600_000
    return kept

def load_obs(path,signal=PROD_SIGNAL):
    try: obs=(json.load(open(path)) or {}).get("observations") or []
    except Exception: return []
    out=[]
    for o in obs:
        if o.get("signal")!=signal or o.get("status")=="OPEN": continue
        nr,oa=o.get("netReturn"),o.get("openedAtMs")
        if not fin(nr) or not fin(oa): continue
        out.append({"netReturn":nr,"openedAtMs":oa,"openedAt":o.get("openedAt"),
                    "resolvedAt":o.get("resolvedAt"),"scoreGap":o.get("scoreGap"),
                    "regime":o.get("regimeClassAtOpen"),"longRet":o.get("longLegReturn"),
                    "shortRet":o.get("shortLegReturn"),"exitReason":o.get("exitReason"),
                    "horizonMs":o.get("horizonMs"),"sf":o.get("smartFormation")})
    out.sort(key=lambda r:r["openedAtMs"]); return out

def bucket(rows,keyfn,order=None):
    g={}
    for r in rows:
        k=keyfn(r)
        if k is None: continue
        g.setdefault(k,[]).append(r["netReturn"])
    ks=order or sorted(g)
    return [{"key":k,**stats(g[k])} for k in ks if k in g]

def hold_h(r):
    a,b=piso(r.get("openedAt")),piso(r.get("resolvedAt"))
    return None if not a or not b else (b-a).total_seconds()/3600.0

# ------------------------------------------------------------------ scoring engine
class Score:
    """A 0-100 score built from named, weighted components. Only components with data
    contribute; the weights of the rest are dropped so a missing input never silently
    counts as zero."""
    def __init__(self,label): self.label=label; self.parts=[]
    def add(self,name,value,weight,detail="",rating=None):
        self.parts.append({"name":name,"value":value,"weight":weight,"detail":detail,
                           "rating":rating or rate(value)})
        return self
    @property
    def value(self):
        have=[p for p in self.parts if fin(p["value"])]
        if not have: return None
        return sum(p["value"]*p["weight"] for p in have)/sum(p["weight"] for p in have)
    def as_dict(self):
        return {"label":self.label,"value":self.value,"rating":rate(self.value),"parts":self.parts}

def rate(v):
    if not fin(v): return NA
    return "SANGAT KUAT" if v>=85 else "KUAT" if v>=70 else "SEDANG" if v>=50 else "LEMAH" if v>=30 else "SANGAT LEMAH"

def band(v,lo,hi):
    """Map a raw value onto 0-100 between lo (=0) and hi (=100), clamped."""
    if not fin(v) or hi==lo: return None
    return clamp(100.0*(v-lo)/(hi-lo))

# ------------------------------------------------------------------ basket quality
def basket_quality(b, thr, legs_conf=None):
    """0-100 from what runtime actually records about this basket. Deliberately independent of
    P&L: a well-formed basket may lose and a badly-formed one may win."""
    s = Score("Kualitas basket"); why_up=[]; why_dn=[]
    plan = b.get("plan") or []
    legs = b.get("legs") or []
    sb = b.get("smartBasket") or {}
    scores = [p.get("scoreAtOpen") for p in plan if fin(p.get("scoreAtOpen"))]
    lsc = [p["scoreAtOpen"] for p in plan if p.get("side")=="LONG" and fin(p.get("scoreAtOpen"))]
    ssc = [p["scoreAtOpen"] for p in plan if p.get("side")=="SHORT" and fin(p.get("scoreAtOpen"))]
    gap = (sum(lsc)/len(lsc)-sum(ssc)/len(ssc)) if lsc and ssc else None
    # 1 separation vs the live threshold
    if fin(gap) and fin(thr) and thr>0:
        v = band(gap/thr, 0.8, 2.0)
        s.add("Pemisahan long-short", v, 2.0, "scoreGap %.4f vs minimum %.3f (%.2f×)"%(gap,thr,gap/thr))
        (why_up if (v or 0)>=60 else why_dn).append("pemisahan %.4f = %.2f× ambang"%(gap,gap/thr))
    else: s.add("Pemisahan long-short", None, 2.0, NA)
    # 2 raw signal strength
    if scores:
        strength = sum(abs(x) for x in scores)/len(scores)
        v = band(strength, 0.005, 0.05)
        s.add("Kekuatan sinyal", v, 1.0, "rata-rata |MOM36| kaki terpilih %.4f"%strength)
        (why_up if (v or 0)>=60 else why_dn).append("kekuatan momentum rata-rata %.2f%%"%(100*strength))
    else: s.add("Kekuatan sinyal", None, 1.0, NA)
    # 3 cluster diversification
    cl = [ (p.get("cluster") or "?") for p in plan ]
    if plan:
        v = band(len(set(cl))/float(len(plan)), 0.34, 1.0)
        s.add("Sebaran klaster", v, 1.0, "%d klaster berbeda dari %d kaki"%(len(set(cl)),len(plan)))
    else: s.add("Sebaran klaster", None, 1.0, NA)
    # 4 long/short notional balance
    L = sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs if l.get("side")=="LONG")
    S = sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs if l.get("side")=="SHORT")
    if L+S>0:
        imb = abs(L-S)/(L+S)
        v = band(-imb, -0.10, 0.0)
        s.add("Keseimbangan long/short", v, 1.5, "selisih nilai %.1f%% (long $%.0f vs short $%.0f)"%(100*imb,L,S))
        (why_dn if imb>0.03 else why_up).append("ketimpangan nilai %.1f%%"%(100*imb))
    else: s.add("Keseimbangan long/short", None, 1.5, NA)
    # 5 execution: exchange-confirmed fill prices
    tot=conf=0
    for l in legs:
        for f in ("entryPriceConfirmed","exitPriceConfirmed"):
            if l.get(f) is None: continue
            tot+=1; conf+= 1 if l[f] else 0
    if tot:
        v = 100.0*conf/tot
        s.add("Kualitas eksekusi", v, 1.5, "%d dari %d harga fill dikonfirmasi bursa"%(conf,tot))
        (why_up if v>=99 else why_dn).append("%d/%d harga fill terkonfirmasi"%(conf,tot))
    else: s.add("Kualitas eksekusi", None, 1.5, NA)
    # 6 lot rounding vs planned notional
    errs=[]
    pmap={p.get("symbol"):p for p in plan if isinstance(p,dict)}
    for l in legs:
        p=pmap.get(l.get("symbol"))
        if not p or not fin(p.get("targetNotionalUsd")) or p["targetNotionalUsd"]<=0: continue
        act=abs((l.get("qty") or 0)*(l.get("entryPrice") or 0))
        errs.append(abs(act/p["targetNotionalUsd"]-1))
    if errs:
        e=sum(errs)/len(errs)
        v=band(-e,-0.25,0.0)
        s.add("Ketepatan ukuran kaki", v, 1.0, "simpangan rata-rata %.1f%% dari nilai rencana"%(100*e))
        if e>0.10: why_dn.append("pembulatan lot meleset %.0f%%"%(100*e))
    else: s.add("Ketepatan ukuran kaki", None, 1.0, NA)
    # 7 thesis health (open baskets only)
    scans=2
    rs,cs = sb.get("consecutiveRegimeLossScans"), sb.get("consecutiveInvalidationScans")
    if isinstance(rs,int) or isinstance(cs,int):
        worst=max(rs or 0, cs or 0)
        v=band(-worst,-float(scans),0.0)
        s.add("Kesehatan tesis", v, 1.5, "scan berturut tertinggi %d dari ambang %d"%(worst,scans))
        if worst>=scans: why_dn.append("tesis pembentuknya sudah terbantah %d scan berturut"%worst)
    else: s.add("Kesehatan tesis", None, 1.5, NA)
    d=s.as_dict(); d["whyUp"]=why_up; d["whyDown"]=why_dn; d["scoreGap"]=gap
    return d

def ghost_exits(b, thr_scans=2):
    """Counterfactual for the disabled adaptive exits. The executor still accrues these counters,
    so this is live state, not a simulation."""
    sb=b.get("smartBasket") or {}
    lnr=b.get("lastNetReturn"); mfe=sb.get("maxNetReturn")
    out=[]
    for nm,cnt,why,when in (("Regime berbalik",sb.get("consecutiveRegimeLossScans"),sb.get("lastRegimeLossReason"),sb.get("lastRegimeLossSignalMs")),
                            ("Tesis batal",sb.get("consecutiveInvalidationScans"),sb.get("lastInvalidationReason"),sb.get("lastInvalidationSignalMs"))):
        fire = isinstance(cnt,int) and cnt>=thr_scans
        out.append({"rule":nm,"scans":cnt,"threshold":thr_scans,"fire":fire,"reason":why,
                    "atMs":when if fire else None,"pnlAtTrigger":None})
    mf = fin(mfe) and fin(lnr) and mfe>=0.002 and lnr<=mfe*0.5
    out.append({"rule":"Kunci laba (MFE giveback)","scans":None,"threshold":None,"fire":bool(mf),
                "reason":("puncak %.3f%% turun ke %.3f%%"%(100*mfe,100*lnr)) if fin(mfe) and fin(lnr) else None,
                "atMs":sb.get("maxNetAt") if mf else None,
                "pnlAtTrigger":(mfe*0.5) if mf else None})
    return out

def post_trade_verdict(bq, net):
    """Process quality and outcome are judged separately, on purpose."""
    if not fin(bq) or not fin(net): return NA, NA
    proc = "PROSES BAGUS" if bq>=65 else "PROSES SEDANG" if bq>=45 else "PROSES LEMAH"
    outc = "HASIL BAGUS" if net>0 else "HASIL RUGI"
    return proc, outc

# ------------------------------------------------------------------ collector
def collect():
    if _c["d"] is not None and time.time()-_c["at"]<TTL: return _c["d"]
    now=datetime.now(timezone.utc)
    R={"generatedAt":now.isoformat(),"inst":{}}
    for k,cfg in INST.items():
        ex=get(cfg["api"]+"/api/live/cross-sectional-executor")
        rep=get(cfg["api"]+"/api/shadow/cross-sectional-report")
        pool=get(cfg["api"]+"/api/live/cross-sectional-pool")
        fc=(rep or {}).get("filteredConfig") or {}
        rn=((rep or {}).get("filteredReport") or {}).get("recentNetReturns") or []
        gate={"n":len(rn),
              "last8":100*sum(rn[-8:])/8 if len(rn)>=8 else None,
              "last30":100*sum(rn[-30:])/len(rn[-30:]) if rn else None,
              "openShadow":len((rep or {}).get("filteredOpenBaskets") or [])}
        gate["pass"]=fin(gate["last8"]) and fin(gate["last30"]) and gate["last8"]>0 and gate["last30"]>0
        att=(ex.get("entryAttemptAudit") or {}).get("latest") or {}
        lat=None
        a_at,a_src=piso(att.get("at")),att.get("sourceOpenedAtMs")
        if a_at and fin(a_src): lat=(a_at.timestamp()*1000-a_src)/1000.0
        R["inst"][k]={**cfg,"ex":ex,"rep":rep,"pool":pool,"fc":fc,"gate":gate,
                      "adm":ex.get("entryAdmission") or {},"attempt":att,
                      "admAudit":ex.get("entryAdmissionAudit") or {},
                      "signalToOrderSec":lat,"rows":load_obs(cfg["store"]),
                      "envPolicy":sh("%s/deploy/apply-required-env.sh --check %s/.env %s 2>&1 | tail -1"%(cfg["rel"],cfg["rel"],cfg["id"]))}
    R["account"]=get(INST["live"]["api"]+"/api/live/account")
    R["axis"]=get(INST["live"]["api"]+"/api/shadow/regime-axis-timeline")
    R["dir"]=get(INST["live"]["api"]+"/api/live/cross-sectional-directional-regime")

    # merged production-signal evidence
    rows=[]; seen=set()
    for k in INST:
        for r in R["inst"][k]["rows"]:
            key=(r["openedAtMs"],round(r["netReturn"],12))
            if key in seen: continue
            seen.add(key); rows.append(r)
    rows.sort(key=lambda r:r["openedAtMs"])
    nets=[r["netReturn"] for r in rows]
    W={}
    for lbl,n in (("8 terakhir",8),("30 terakhir",30),("90 terakhir",90),("seluruhnya",None)):
        W[lbl]=stats(nets if n is None else nets[-n:])
    eps=episodes_of(rows) if rows else 0
    allw=W["seluruhnya"]
    traw=allw.get("tStat")
    teff=(traw*math.sqrt(min(1.0,eps/float(allw["n"])))) if fin(traw) and allw.get("n") else None
    months=bucket(rows,lambda r:(r.get("openedAt") or "")[:7])
    quarters=bucket(rows,lambda r:(lambda d:"%s-Q%d"%(d[:4],(int(d[5:7])-1)//3+1))(r.get("openedAt") or "0000-00") if r.get("openedAt") else None)
    conc=None
    if quarters:
        tot=sum(abs(q.get("totalPct") or 0) for q in quarters) or 1
        top=max(quarters,key=lambda q:abs(q.get("totalPct") or 0))
        conc={"topQuarter":top["key"],"share":100*abs(top.get("totalPct") or 0)/tot,
              "profitableMonths":sum(1 for m in months if (m.get("totalPct") or 0)>0),"months":len(months)}
    # longest losing streak of consecutive baskets
    ls=cur=0
    for x in nets:
        cur = cur+1 if x<0 else 0; ls=max(ls,cur)
    hzs=sorted({(r.get("horizonMs") or 0)/3600000.0 for r in rows if r.get("horizonMs")})
    R["edge"]={"windows":W,"episodes":eps,"tRaw":traw,"tEff":teff,"signal":PROD_SIGNAL,
               "curve":[{"at":r["openedAt"],"net":r["netReturn"]} for r in rows],
               "byRegime":bucket(rows,lambda r:r.get("regime"),["TREND_LONG","MIXED_CHOP","TREND_SHORT"]),
               "byGap":bucket(rows,lambda r:None if not fin(r.get("scoreGap")) else
                    ("<0.04" if r["scoreGap"]<.04 else "0.04-0.058" if r["scoreGap"]<.058
                     else "0.058-0.08" if r["scoreGap"]<.08 else ">=0.08"),
                    ["<0.04","0.04-0.058","0.058-0.08",">=0.08"]),
               "byHold":bucket(rows,lambda r:(lambda h:None if h is None else
                    "<12j" if h<12 else "12-24j" if h<24 else "24-36j" if h<36 else ">=36j")(hold_h(r)),
                    ["<12j","12-24j","24-36j",">=36j"]),
               "byMonth":months,"byQuarter":quarters,"concentration":conc,"longestLossStreak":ls,
               "sideLong":stats([r["longRet"] for r in rows if fin(r.get("longRet"))]),
               "sideShort":stats([r["shortRet"] for r in rows if fin(r.get("shortRet"))]),
               "gapVsReturn":[{"gap":r["scoreGap"],"net":r["netReturn"]} for r in rows if fin(r.get("scoreGap"))],
               "evidenceHorizonsH":hzs}

    # research vs production policy mismatch — detected, never assumed
    prod_h=R["inst"]["live"]["ex"].get("maxHoldHours")
    mism=[]
    if fin(prod_h) and hzs and prod_h not in hzs:
        mism.append({"what":"Horizon tahan","prod":"%s jam"%prod_h,"evid":"%s jam"%(" / ".join("%g"%h for h in hzs)),
                     "why":"Bukti mengukur basket yang ditahan penuh sampai horizon sinyal. Produksi menutup lebih awal di batas %s jam, jadi hasil yang diukur bukan hasil yang dijalankan."%prod_h})
    ex_off = "999" in (R["inst"]["live"]["envPolicy"] or "") or True
    mism.append({"what":"Exit adaptif","prod":"dimatikan (ghost tetap dievaluasi)",
                 "evid":"observasi bayangan menutup dengan aturannya sendiri (%s)"%
                        (", ".join(sorted({r.get("exitReason") or "?" for r in rows}))[:60] or "?"),
                 "why":"Observasi diselesaikan oleh aturan exit-nya sendiri, bukan oleh kontrak stop/TP/batas-waktu yang dipakai executor."})
    R["mismatch"]=mism

    # execution + data quality
    conf=tot=0; drift=[]; werr=[]
    for k in INST:
        ex=R["inst"][k]["ex"]
        for b in (ex.get("recent") or [])+(ex.get("openBaskets") or []):
            pmap={p.get("symbol"):p for p in (b.get("plan") or []) if isinstance(p,dict)}
            for l in b.get("legs") or []:
                for f in ("entryPriceConfirmed","exitPriceConfirmed"):
                    if l.get(f) is None: continue
                    tot+=1; conf+=1 if l[f] else 0
                p=pmap.get(l.get("symbol"))
                if p and fin(p.get("targetNotionalUsd")) and p["targetNotionalUsd"]>0:
                    act=abs((l.get("qty") or 0)*(l.get("entryPrice") or 0))
                    werr.append(abs(act/p["targetNotionalUsd"]-1))
                if p and fin(p.get("refPrice")) and p["refPrice"]>0 and fin(l.get("entryPrice")):
                    drift.append(abs(l["entryPrice"]/p["refPrice"]-1))
    R["exec"]={"confirmed":conf,"total":tot,"pct":(100.0*conf/tot) if tot else None,
               "notionalErrPct":(100*sum(werr)/len(werr)) if werr else None,
               "entryDriftPct":(100*sum(drift)/len(drift)) if drift else None,
               "latency":{k:R["inst"][k]["signalToOrderSec"] for k in INST}}
    prow=(R["inst"]["live"]["pool"] or {}).get("rows") or []
    miss=[r["symbol"] for r in prow if not fin(r.get("liquidityUsdPerHour"))]
    stale=[k for k in INST if R["inst"][k]["ex"].get("signalStale")]
    dq=clamp(100*(0.5*(len(prow)-len(miss))/max(1,len(prow))+0.5*(len(INST)-len(stale))/len(INST))) if prow else None
    R["data"]={"pct":dq,"missing":miss,"universe":len(prow),"stale":stale}

    # exchange clock skew (public endpoint, no credentials)
    skew=None
    try:
        t0=time.time()*1000
        srv=get("https://fapi.binance.com/fapi/v1/time",8).get("serverTime")
        if fin(srv): skew=srv-(t0+time.time()*1000)/2
    except Exception: pass
    R["clockSkewMs"]=skew

    # ---- explainable performance scores ----
    S={}
    e=Score("Kualitas edge")
    e.add("Rata-rata jangka panjang",band(allw.get("meanPct"),-0.3,0.5),1.5,"%s per basket"%(("%+.3f%%"%allw["meanPct"]) if allw.get("n") else NA))
    e.add("Tingkat menang",band(allw.get("winPct"),40,65),1.0,"%s"%(("%.0f%%"%allw["winPct"]) if allw.get("n") else NA))
    e.add("Signifikansi (terkoreksi tumpang tindih)",band(teff,-1.0,2.5),2.0,
          ("t=%.2f setelah dikoreksi (mentah %.2f)"%(teff,traw)) if fin(teff) else NA)
    e.add("Konsentrasi hasil",band(-(conc["share"] if conc else None) if conc else None,-90,-40) if conc else None,1.0,
          ("kuartal terbesar menyumbang %.0f%%"%conc["share"]) if conc else NA)
    S["edge"]=e
    r30=W["30 terakhir"]
    rc=Score("Performa terakhir")
    rc.add("Rata-rata 30 terakhir",band(r30.get("meanPct"),-0.3,0.5),2.0,("%+.3f%% per basket"%r30["meanPct"]) if r30.get("n") else NA)
    rc.add("Menang 30 terakhir",band(r30.get("winPct"),40,65),1.0,("%.0f%%"%r30["winPct"]) if r30.get("n") else NA)
    rc.add("Arah vs jangka panjang",band((r30.get("meanPct") or 0)-(allw.get("meanPct") or 0),-0.4,0.4) if r30.get("n") and allw.get("n") else None,1.0,
           ("selisih %+.3fpp dari rata-rata panjang"%((r30.get("meanPct") or 0)-(allw.get("meanPct") or 0))) if r30.get("n") else NA)
    S["recent"]=rc
    dd=Score("Kendali drawdown")
    ddv,tv=allw.get("ddPct"),allw.get("totalPct")
    dd.add("Drawdown vs hasil",clamp(100*(1-abs(ddv)/(abs(ddv)+abs(tv)))) if fin(ddv) and fin(tv) and (abs(ddv)+abs(tv))>0 else None,2.0,
           ("drawdown %.2f%% terhadap total %+.2f%%"%(ddv,tv)) if fin(ddv) else NA)
    dd.add("Rentetan rugi terpanjang",band(-ls,-12,0),1.0,"%d basket rugi berturut"%ls)
    S["dd"]=dd
    ex_s=Score("Kualitas eksekusi")
    ex_s.add("Harga fill terkonfirmasi",R["exec"]["pct"],2.0,("%d dari %d"%(conf,tot)) if tot else NA)
    ex_s.add("Ketepatan ukuran kaki",band(-(R["exec"]["notionalErrPct"] or 0),-25,0) if R["exec"]["notionalErrPct"] is not None else None,1.0,
             ("simpangan %.1f%% dari rencana"%R["exec"]["notionalErrPct"]) if R["exec"]["notionalErrPct"] is not None else NA)
    ex_s.add("Selisih harga masuk",band(-(R["exec"]["entryDriftPct"] or 0),-0.5,0) if R["exec"]["entryDriftPct"] is not None else None,1.0,
             ("%.3f%% dari harga acuan"%R["exec"]["entryDriftPct"]) if R["exec"]["entryDriftPct"] is not None else NA)
    S["exec"]=ex_s
    dq_s=Score("Kualitas data")
    dq_s.add("Simbol terukur",band((len(prow)-len(miss))/max(1,len(prow))*100,60,100) if prow else None,1.5,
             "%d dari %d simbol pool"%(len(prow)-len(miss),len(prow)))
    dq_s.add("Kesegaran sinyal",100.0*(len(INST)-len(stale))/len(INST),1.5,
             ("basi di: %s"%", ".join(stale)) if stale else "semua segar")
    S["data"]=dq_s
    ev=Score("Kekuatan bukti")
    ev.add("Episode independen",band(eps,0,30),2.5,"%d episode non-tumpang-tindih (butuh ~30)"%eps)
    ev.add("Rasio tumpang tindih",band(-(allw["n"]/max(1,eps)) if allw.get("n") else None,-20,-1) if allw.get("n") and eps else None,1.0,
           ("%d observasi mewakili %d episode (%.1f×)"%(allw["n"],eps,allw["n"]/max(1,eps))) if allw.get("n") and eps else NA)
    ev.add("Kecocokan bukti dgn produksi",0.0 if mism else 100.0,1.5,
           ("%d ketidakcocokan kebijakan terdeteksi"%len(mism)) if mism else "bukti mengukur kebijakan produksi")
    S["evidence"]=ev
    ov=Score("Performa keseluruhan")
    for k,w in (("edge",.35),("recent",.20),("dd",.20),("exec",.15),("data",.10)):
        ov.add(S[k].label,S[k].value,w,rate(S[k].value))
    S["overall"]=ov
    R["scores"]={k:v.as_dict() for k,v in S.items()}

    # system
    pm2=[]
    try:
        for p in json.loads(sh("pm2 jlist") or "[]"):
            if p.get("name","").startswith(("dtc-api","kronos-control")):
                pm2.append({"name":p["name"],"status":p["pm2_env"].get("status"),"restarts":p["pm2_env"].get("restart_time")})
    except Exception: pass
    jobs=[]
    for lbl,path,mx in (("Perekam positioning","/root/xsec-sim/record.log",2.0),
                        ("Arsip observasi","/root/xsec-archive/harvest.log",2.0),
                        ("Cek drift konfigurasi","/root/env-drift.log",26.0),
                        ("Perekam microstructure","/root/kronos-microstructure/cron.log",2.0)):
        a=age_h(path); jobs.append({"job":lbl,"ageHours":a,"stale":(a is None or a>mx),"maxHours":mx})
    d=sh("df -h / | tail -1").split()
    R["system"]={"pm2":pm2,"jobs":jobs,"hostTimeUtc":now.isoformat(),
                 "disk":{"size":d[1],"used":d[2],"avail":d[3],"pct":d[4]} if len(d)>5 else None}
    _c["at"],_c["d"]=time.time(),R
    return R

# ================================================================ presentation
CSS="""
*{box-sizing:border-box}body{margin:0;background:#0b0f14;color:#c9d4e0;font:13.5px/1.6 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1300px;margin:0 auto;padding:18px 16px 70px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}h1{font-size:16px;margin:0;color:#e8eef5;font-weight:600}
.stamp{color:#68788a;font-size:11px}
nav{display:flex;gap:2px;flex-wrap:wrap;margin:14px 0 18px;border-bottom:1px solid #1b2430}
nav button{background:none;border:0;border-bottom:2px solid transparent;color:#7d8fa3;padding:8px 13px;font:inherit;font-size:13px;cursor:pointer;border-radius:4px 4px 0 0}
nav button:hover{color:#c9d4e0;background:#111823}nav button.on{color:#e8eef5;border-bottom-color:#4c8fd6;font-weight:600}
section{display:none}section.on{display:block}
h2{font-size:12px;margin:24px 0 10px;color:#8fa3b8;font-weight:600;letter-spacing:.7px;text-transform:uppercase}
h2:first-child{margin-top:0}h3{font-size:12.5px;color:#c9d4e0;margin:16px 0 6px;font-weight:600}
.lead{background:#111823;border:1px solid #1e2836;border-left:3px solid #4c8fd6;border-radius:0 7px 7px 0;padding:13px 16px;margin-bottom:14px}
.lead .c{font-size:16px;color:#e8eef5;font-weight:600;margin-bottom:3px}.lead .r{color:#93a5b8;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:9px}
.g2{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:11px}
.card{background:#111823;border:1px solid #1e2836;border-radius:7px;padding:11px 13px}
.card .k{color:#68788a;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px}
.card .v{font-size:20px;color:#e8eef5;margin-top:3px;font-weight:600;letter-spacing:-.3px}
.card .s{font-size:11.5px;color:#7d8fa3;margin-top:2px}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}
th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #18202b;white-space:nowrap}
th{color:#68788a;font-weight:500;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
tr:hover td{background:#101722}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:#4ec9a0}.neg{color:#e5686d}.dim{color:#68788a}.warnc{color:#d9a441}
details{margin-top:9px;border:1px solid #1e2836;border-radius:7px;background:#0e141c}
summary{cursor:pointer;padding:8px 13px;color:#7d8fa3;font-size:12px}summary:hover{color:#c9d4e0}
details[open] summary{border-bottom:1px solid #1e2836;color:#c9d4e0}details .body{padding:11px 13px}
.kv{display:grid;grid-template-columns:minmax(200px,auto) 1fr;gap:3px 14px;font-size:12.5px}
.kv dt{color:#68788a}.kv dd{margin:0;color:#c9d4e0;word-break:break-word}
code{background:#0b1017;border:1px solid #1e2836;border-radius:4px;padding:1px 5px;font-size:11.5px;color:#8fb8dd}
.bar{height:6px;background:#18202b;border-radius:3px;overflow:hidden;margin-top:7px}.bar i{display:block;height:100%;border-radius:3px}
.flow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0}
.flow .n{background:#111823;border:1px solid #1e2836;border-radius:6px;padding:7px 11px;font-size:12px;color:#c9d4e0}
.flow .a{color:#3a4a5c}
.trace .step{position:relative;padding:6px 0 6px 24px}
.trace .step:before{position:absolute;left:0;top:6px;font-size:13px}
.trace .step.p:before{content:'✓';color:#4ec9a0}.trace .step.f:before{content:'✕';color:#e5686d}
.trace .step.w:before{content:'⚠';color:#d9a441}.trace .step.o:before{content:'○';color:#68788a}
.trace .t{color:#e8eef5;font-size:13px}.trace .d{color:#7d8fa3;font-size:12px}
.plus{color:#4ec9a0}.minus{color:#e5686d}
.note{color:#68788a;font-size:11.5px;margin-top:7px}.scroll{overflow-x:auto}
.pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10.5px;border:1px solid #1e2836;color:#8fa3b8}
@media(max-width:640px){.kv{grid-template-columns:1fr}.card .v{font-size:17px}}
"""
DOT={"ok":"🟢","watch":"🟡","override":"🟠","block":"🔴","off":"⚪"}

def esc(s): return str(s).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
def money(v,d=2):
    if not fin(v): return "<span class='dim'>–</span>"
    return "<span class='%s'>%s$%s</span>"%("pos" if v>0 else "neg" if v<0 else "","+" if v>0 else "-" if v<0 else "",format(abs(round(v,d)),",.%df"%d))
def pct(v,d=2,sign=True):
    if not fin(v): return "<span class='dim'>–</span>"
    return "<span class='%s'>%s%.*f%%</span>"%("pos" if v>0 else "neg" if v<0 else "","+" if sign and v>0 else "",d,v)
def num(v,d=2): return "<span class='dim'>–</span>" if not fin(v) else format(round(v,d),",.%df"%d)
def money_pct(v,base,d=2):
    if not fin(v): return "<span class='dim'>–</span>"
    return "%s <span class='dim'>(%s)</span>"%(money(v,d), pct(100*v/base,2) if fin(base) and base else "–")
def card(k,v,s=""): return "<div class='card'><div class='k'>%s</div><div class='v'>%s</div>%s</div>"%(k,v,"<div class='s'>%s</div>"%s if s else "")
def lead(st,c,r): return "<div class='lead'><div class='c'>%s %s</div><div class='r'>%s</div></div>"%(DOT.get(st,""),c,r)
def tech(t,pairs): return "<details><summary>Detail teknis · %s</summary><div class='body'><dl class='kv'>%s</dl></div></details>"%(t,"".join("<dt>%s</dt><dd>%s</dd>"%(k,v) for k,v in pairs))
def status_row(label,st,text,extra=""):
    return "<tr><td>%s</td><td>%s <b>%s</b></td><td class='dim'>%s</td></tr>"%(label,DOT[st],text,extra)

def score_card(sd, prev=None):
    v=sd.get("value")
    if not fin(v):
        return "<div class='card'><div class='k'>%s</div><div class='v dim'>%s</div><div class='s'>bukti tidak cukup</div></div>"%(sd["label"],NA)
    col="#4ec9a0" if v>=70 else "#d9a441" if v>=50 else "#e5686d"
    ups=[p for p in sd["parts"] if fin(p["value"]) and p["value"]>=60]
    dns=[p for p in sd["parts"] if fin(p["value"]) and p["value"]<45]
    rows="".join("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num dim'>%.1f</td><td class='dim'>%s</td></tr>"%(
        p["name"],("<span class='plus'>+</span>" if fin(p["value"]) and p["value"]>=60 else "<span class='minus'>−</span>" if fin(p["value"]) else "<span class='dim'>·</span>"),
        num(p["value"],0),p["weight"],esc(p["detail"] or "")) for p in sd["parts"])
    return ("<div class='card'><div class='k'>%s</div>"
            "<div class='v' style='color:%s'>%d<span style='font-size:12px;color:#68788a'> / 100 · %s</span></div>"
            "<div class='bar'><i style='width:%.0f%%;background:%s'></i></div>"
            "<div class='s'>%s%s</div>"
            "<details style='margin-top:8px'><summary>Bagaimana dihitung?</summary><div class='body'>"
            "<table><tr><th>komponen</th><th></th><th class='num'>nilai</th><th class='num'>bobot</th><th>dasar</th></tr>%s</table>"
            "<div class='note'>Rata-rata tertimbang dari komponen yang punya data. Komponen tanpa data dibuang beserta bobotnya, jadi data yang hilang tidak pernah terhitung sebagai nol.</div>"
            "</div></details></div>")%(sd["label"],col,round(v),rate(v),v,col,
             ("naik: "+", ".join(p["name"] for p in ups[:2])) if ups else "",
             (" · turun: "+", ".join(p["name"] for p in dns[:2])) if dns else "",rows)

def curve_svg(pts,w=600,h=120):
    if len(pts)<2: return "<div class='dim'>Data tidak cukup.</div>"
    cum=[];s=0.0
    for p in pts: s+=p; cum.append(s)
    lo,hi=min(cum+[0]),max(cum+[0]); rng=(hi-lo) or 1.0
    X=lambda i:8+i*(w-16)/(len(cum)-1); Y=lambda v:h-10-(v-lo)*(h-24)/rng
    d=" ".join("%s%.1f,%.1f"%("M" if i==0 else "L",X(i),Y(v)) for i,v in enumerate(cum))
    return ("<svg viewBox='0 0 %d %d' width='100%%' height='%d' preserveAspectRatio='none'>"
            "<line x1='8' y1='%.1f' x2='%d' y2='%.1f' stroke='#1e2836' stroke-dasharray='3 3'/>"
            "<path d='%s' fill='none' stroke='%s' stroke-width='1.8'/></svg>")%(w,h,h,Y(0),w-8,Y(0),d,"#4ec9a0" if cum[-1]>=0 else "#e5686d")

def dd_svg(pts,w=600,h=90):
    if len(pts)<2: return "<div class='dim'>Data tidak cukup.</div>"
    eq=peak=0.0; dd=[]
    for p in pts:
        eq+=p; peak=max(peak,eq); dd.append(eq-peak)
    lo=min(dd) or -1e-9
    X=lambda i:8+i*(w-16)/(len(dd)-1); Y=lambda v:8+(v/lo)*(h-20) if lo else 8
    d=" ".join("%s%.1f,%.1f"%("M" if i==0 else "L",X(i),Y(v)) for i,v in enumerate(dd))
    return ("<svg viewBox='0 0 %d %d' width='100%%' height='%d' preserveAspectRatio='none'>"
            "<path d='%s L%.1f,%.1f L8,%.1f Z' fill='#e5686d22' stroke='#e5686d' stroke-width='1.3'/></svg>")%(w,h,h,d,X(len(dd)-1),Y(0),Y(0))

def bars(items,w=600,h=132,fmt=lambda v:"%.2f%%"%v):
    items=[(l,v) for l,v in items if fin(v)]
    if not items: return "<div class='dim'>Tidak ada data.</div>"
    mx=max(abs(v) for _,v in items) or 1.0; bw=(w-20)/len(items); mid=h-34
    o=["<svg viewBox='0 0 %d %d' width='100%%' height='%d'>"%(w,h,h),
       "<line x1='10' y1='%d' x2='%d' y2='%d' stroke='#1e2836'/>"%(mid,w-10,mid)]
    for i,(l,v) in enumerate(items):
        bh=abs(v)/mx*(mid-14); x=10+i*bw+bw*.18; y=mid-bh if v>=0 else mid
        o.append("<rect x='%.1f' y='%.1f' width='%.1f' height='%.1f' rx='2' fill='%s'/>"%(x,y,bw*.64,max(bh,1),"#4ec9a0" if v>=0 else "#e5686d"))
        o.append("<text x='%.1f' y='%d' fill='#68788a' font-size='9.5' text-anchor='middle'>%s</text>"%(x+bw*.32,h-20,esc(l)[:12]))
        o.append("<text x='%.1f' y='%.1f' fill='#8fa3b8' font-size='9' text-anchor='middle'>%s</text>"%(x+bw*.32,(y-3) if v>=0 else (y+bh+9),fmt(v)))
    return "".join(o)+"</svg>"

def scatter(pairs,thr,w=600,h=175):
    if len(pairs)<3: return "<div class='dim'>Data tidak cukup.</div>"
    xs=[p["gap"] for p in pairs]; ys=[p["net"]*100 for p in pairs]
    x0,x1=min(xs),max(xs); y0,y1=min(ys),max(ys); xr=(x1-x0) or 1; yr=(y1-y0) or 1
    X=lambda v:36+(v-x0)*(w-48)/xr; Y=lambda v:h-26-(v-y0)*(h-44)/yr
    o=["<svg viewBox='0 0 %d %d' width='100%%' height='%d'>"%(w,h,h),
       "<line x1='36' y1='%.1f' x2='%d' y2='%.1f' stroke='#1e2836' stroke-dasharray='3 3'/>"%(Y(0),w-12,Y(0))]
    if x0<=thr<=x1:
        o.append("<line x1='%.1f' y1='6' x2='%.1f' y2='%d' stroke='#d9a441' stroke-dasharray='4 3'/>"%(X(thr),X(thr),h-26))
        o.append("<text x='%.1f' y='14' fill='#d9a441' font-size='9.5'>ambang %.3f</text>"%(min(X(thr)+4,w-84),thr))
    for p in pairs:
        o.append("<circle cx='%.1f' cy='%.1f' r='2.4' fill='%s' opacity='.72'/>"%(X(p["gap"]),Y(p["net"]*100),"#4ec9a0" if p["net"]>=0 else "#e5686d"))
    o.append("<text x='4' y='%.1f' fill='#68788a' font-size='9'>%.1f%%</text>"%(Y(y1)+3,y1))
    o.append("<text x='4' y='%.1f' fill='#68788a' font-size='9'>%.1f%%</text>"%(Y(y0)+3,y0))
    return "".join(o)+"</svg>"

def alerts_of(R):
    """BLOCKING -> RISK -> WATCH -> INFO"""
    A=[]
    for k,i in R["inst"].items():
        ex=i["ex"]; L=i["long"]
        if ex.get("__error__"): A.append((0,"block","%s tidak merespons"%L,ex["__error__"]))
        if ex.get("lastError"): A.append((0,"block","%s melaporkan error"%L,str(ex["lastError"])[:120]))
        if ex.get("configErrors"): A.append((0,"block","%s konfigurasi bermasalah"%L,str(ex["configErrors"])[:120]))
        if "OK:" not in (i["envPolicy"] or ""): A.append((0,"block","%s menyimpang dari kebijakan konfigurasi"%L,i["envPolicy"][:120]))
        if ex.get("orphanedLegs"): A.append((1,"block","%s punya kaki yatim"%L,"%d posisi tanpa basket induk"%len(ex["orphanedLegs"])))
        if ex.get("entryHealthBypassed"): A.append((1,"override","%s: gerbang bukti di-override operator"%L,
            "Bot membuka basket walau bukti terakhirnya tidak lolos. Keputusan manual, bukan lampu hijau dari data."))
        if ex.get("signalStale"): A.append((2,"watch","%s sinyalnya basi"%L,
            "umur %.0f menit dari batas %.0f menit — tidak ada basket baru sampai segar"%((ex.get("signalAgeMs") or 0)/60000.0,(ex.get("signalMaxAgeMs") or 0)/60000.0)))
    for j in R["system"]["jobs"]:
        if j["stale"]: A.append((2,"watch","%s berhenti"%j["job"],"terakhir %s"%("tidak pernah" if j["ageHours"] is None else "%.1f jam lalu"%j["ageHours"])))
    for p in R["system"]["pm2"]:
        if p["status"]!="online": A.append((0,"block","Proses %s: %s"%(p["name"],p["status"]),"Layanan tidak berjalan."))
    d=R["system"].get("disk")
    if d and int(str(d["pct"]).rstrip("%") or 0)>=90: A.append((2,"watch","Disk hampir penuh","%s terpakai, sisa %s"%(d["pct"],d["avail"])))
    if R.get("mismatch"): A.append((3,"watch","Bukti riset tidak sepenuhnya mewakili produksi","%d ketidakcocokan — lihat tab Riset"%len(R["mismatch"])))
    return sorted(A,key=lambda x:x[0])

def tab_overview(R):
    a=R["account"]; liv=R["inst"]["live"]; tst=R["inst"]["testnet"]
    eq=a.get("accountEquity"); o=[]
    A=alerts_of(R); blocking=[x for x in A if x[1]=="block"]
    ob_l=liv["ex"].get("openBaskets") or []; ob_t=tst["ex"].get("openBaskets") or []
    if blocking: st,c,r="block","%d masalah menghalangi"%len(blocking),"%s — %s"%(blocking[0][2],blocking[0][3])
    elif ob_l: st,c,r="ok","Memegang %d basket di uang nyata"%len(ob_l),"Berjalan dengan batas tahan %s jam dan stop/TP ±%s%%."%(liv["ex"].get("maxHoldHours"),liv["ex"].get("stopNetReturnPct"))
    elif liv["adm"].get("tier")=="GREEN": st,c,r="watch","Tanpa posisi, menunggu formasi","Izin masuk terbuka; basket dibuka begitu ada formasi yang lolos ambang."
    else: st,c,r="block","Tanpa posisi, entry tertutup",esc(str(liv["adm"].get("reason") or ""))[:170]
    o.append(lead(st,c,r))
    o.append("<div class='grid'>")
    o.append(card("Ekuitas",money(eq),"tersedia %s"%money(a.get("availableBalance"))))
    o.append(card("Belum terealisasi",money_pct(a.get("unrealizedPnl"),eq,4),"%d posisi terbuka"%(a.get("openPositionCount") or 0)))
    o.append(card("Terealisasi hari ini",money_pct(liv["ex"].get("dailyRealizedUsd"),eq,4),"batas rugi harian %s"%money(liv["ex"].get("dailyMaxLossUsd"),0)))
    o.append(card("Terealisasi total",money_pct(liv["ex"].get("totalNetPnlUsd"),eq,4),"%s basket selesai"%liv["ex"].get("closedCount")))
    o.append("</div>")
    o.append("<h2>Status</h2><div class='g2'>")
    for k in ("live","testnet"):
        i=R["inst"][k]; ex=i["ex"]; adm=i["adm"]; g=i["gate"]
        run = (ex.get("enabled") is not False) and not ex.get("__error__")
        byp = bool(ex.get("entryHealthBypassed"))
        rows=[status_row("Eksekusi","ok" if run else "block","BERJALAN" if run else "MATI",""),
              status_row("Kesehatan bukti","ok" if g["pass"] else "block","LOLOS" if g["pass"] else "GAGAL",
                         "8 terakhir %s · 30 terakhir %s"%(pct(g.get("last8"),3),pct(g.get("last30"),3))),
              status_row("Override operator","override" if byp else "off","AKTIF" if byp else "TIDAK AKTIF",
                         "menggantikan kegagalan di atas" if byp else ""),
              status_row("Kesegaran sinyal","block" if ex.get("signalStale") else "ok","BASI" if ex.get("signalStale") else "SEGAR",
                         "%.0f menit / batas %.0f"%((ex.get("signalAgeMs") or 0)/60000.0,(ex.get("signalMaxAgeMs") or 0)/60000.0)),
              status_row("Izin masuk baru","ok" if adm.get("tier")=="GREEN" and not ex.get("signalStale") else "block",
                         "TERBUKA" if adm.get("tier")=="GREEN" and not ex.get("signalStale") else "TERTUTUP","")]
        o.append("<div class='card'><div class='k'>%s</div><table style='margin-top:6px'>%s</table></div>"%(i["long"],"".join(rows)))
    o.append("</div>")
    o.append("<h2>Posisi &amp; keyakinan</h2><div class='grid'>")
    o.append(card("Basket terbuka","%d live · %d testnet"%(len(ob_l),len(ob_t)),"batas %s / %s"%(liv["ex"].get("maxOpenBaskets") or "–",tst["ex"].get("maxOpenBaskets") or "–")))
    sc=R["scores"]
    o.append(card("Keyakinan edge",num(sc["edge"]["value"],0),"%s · t terkoreksi %s"%(rate(sc["edge"]["value"]),num(R["edge"]["tEff"],2))))
    o.append(card("Kekuatan bukti",num(sc["evidence"]["value"],0),"%d episode independen"%R["edge"]["episodes"]))
    o.append(card("Performa keseluruhan",num(sc["overall"]["value"],0),rate(sc["overall"]["value"])))
    o.append("</div>")
    o.append("<h2>Peringatan</h2>")
    if not A: o.append("<div class='card'>%s Tidak ada peringatan aktif.</div>"%DOT["ok"])
    else:
        o.append("<table><tr><th>prioritas</th><th></th><th>masalah</th><th>keterangan</th></tr>")
        names={0:"MENGHALANGI",1:"RISIKO",2:"PANTAU",3:"INFO"}
        for pr,s,t,d in A:
            o.append("<tr><td class='dim'>%s</td><td>%s</td><td>%s</td><td class='dim'>%s</td></tr>"%(names[pr],DOT[s],esc(t),esc(d)))
        o.append("</table>")
    return "".join(o)

FEATURES=[("MOM36","Peringkat momentum 36 jam — inti alpha-nya. Berapa persen harga bergerak dalam 36 jam terakhir, dibandingkan antar-simbol, bukan terhadap dirinya sendiri."),
 ("rawRank","Posisi relatif skor itu di dalam kolam kandidat, dinyatakan dalam simpangan baku. Ini komponen dominan pemilihan."),
 ("fastSupport","Konfirmasi cepat: gerak 4 bar terakhir dibagi volatilitas simbol itu sendiri. Menaikkan nama yang gerak terbarunya searah dengan taruhannya. Dibatasi ±2 supaya tidak meledak saat volatilitas kecil."),
 ("adverseExtension","Penalti terlalu jauh: seberapa jauh harga sudah lari dari rata-rata pendeknya. Menurunkan nama yang sudah telanjur berlari."),
 ("bonus counter-axis","Kalau sumbu pasar melawan satu sisi, sisi itu tidak diveto — tapi hanya nama yang gerak cepatnya sendiri mengonfirmasi yang dapat tambahan."),
 ("penalti klaster","0,18 per nama tambahan dari klaster yang sama, supaya basket tidak jadi satu taruhan tema yang menyamar sebagai enam."),
 ("scoreGap","Selisih rata-rata skor sisi long dan sisi short. Ini yang diuji terhadap ambang minimum sebelum basket boleh dibentuk.")]

def tab_strategy(R):
    liv=R["inst"]["live"]; ex=liv["ex"]; fc=liv["fc"]; cnt=(liv["pool"] or {}).get("counts") or {}
    eq=(R["account"] or {}).get("accountEquity"); leg=ex.get("legUsd")
    gross=(leg*6) if fin(leg) else None
    o=[lead("ok","Momentum relatif lintas-simbol, netral pasar",
        "Bot memeringkat seluruh universe menurut momentum 36 jam, membeli 3 terkuat dan menjual 3 terlemah. Yang dikejar bukan arah pasar, melainkan <b>selisih</b> antara yang kuat dan yang lemah — kalau pasar naik atau turun bersama, keduanya saling meniadakan.")]
    o.append("<div class='flow'>"+ "<span class='a'>→</span>".join(
        "<span class='n'>%s</span>"%x for x in ["Universe","Peringkat MOM36","Smart Formation","Admission","Revalidasi entry","Basket","Smart Basket / tahan","Exit"])+"</div>")
    o.append("<div class='grid'>")
    o.append(card("Universe","%s simbol"%cnt.get("universe"),"pool long %s · short layak %s"%(cnt.get("poolLong"),cnt.get("shortEligible"))))
    o.append(card("Struktur","3 long / 3 short","bobot dari peringkat skor, dibatasi"))
    o.append(card("Ukuran per kaki",money(leg,0),"kotor %s%s"%(money(gross,0),(" · %.0f%% ekuitas"%(100*gross/eq)) if gross and eq else "")))
    o.append(card("Batas tahan","%s jam"%ex.get("maxHoldHours"),"horizon sinyalnya sendiri 48 jam"))
    o.append(card("Stop / ambil untung","±%s%% / %s%%"%(ex.get("stopNetReturnPct"),ex.get("tpNetReturnPct")),"atas nilai basket"))
    o.append(card("Ambang pemisahan",num(fc.get("minScoreGap"),3),"basket ditolak di bawah ini"))
    o.append("</div>")
    o.append("<h2>Smart Formation — memilih basket, bukan sinyal baru</h2>")
    o.append("<div class='lead' style='border-left-color:#8a6fbf'><div class='r'>Formation tidak membuat sinyal. Ia mengambil peringkat MOM36 yang sudah ada, memotongnya jadi kolam 5 kandidat teratas per sisi, lalu <b>mencoba semua kombinasi</b> dan memilih yang total utility-nya tertinggi setelah dikurangi penalti klaster. Peringkat mentah tetap dominan; dua faktor lain sengaja dibuat berbatas supaya tidak bisa mengangkat skor yang jelas kalah.</div></div>")
    o.append("<table><tr><th>fitur</th><th>artinya</th></tr>%s</table>"%"".join(
        "<tr><td><b>%s</b></td><td class='dim' style='white-space:normal'>%s</td></tr>"%(esc(a),esc(b)) for a,b in FEATURES))
    o.append("<h2>Smart Basket — mengelola basket setelah dibentuk</h2>")
    o.append("<div class='note'>Eksekusi exit adaptif <b>DIMATIKAN</b>; evaluasinya tetap berjalan. Penghitung scan terus bertambah, jadi tab Posisi bisa menunjukkan apa yang <i>akan</i> terjadi tanpa aturan itu menyentuh uang.</div>")
    o.append("<table><tr><th>mekanisme</th><th>status</th><th>parameter</th><th>artinya</th></tr>")
    for nm,stt,par,mean in [("Revalidasi entry","ok · aktif","drift merugikan sebelum order dikirim","Membatalkan kalau harga sudah lari melawan sejak sinyal dibentuk."),
        ("Regime Loss Exit","off · Eksekusi MATI, ghost AKTIF","kelas regime berubah + rugi ≥0,3% + sisi searah regime baru rugi, 2 scan","Menutup saat pasar berbalik melawan basket."),
        ("Context Invalidation","off · Eksekusi MATI, ghost AKTIF","≥2 dari 3 kaki satu sisi kehilangan alasan masuknya, 2 scan","Menutup saat alasan pemilihan nama-nama itu hilang."),
        ("MFE Giveback","off · Eksekusi MATI, ghost AKTIF","puncak ≥0,2% lalu turun ke ≤50% puncak","Mengunci laba yang mulai menguap."),
        ("Batas waktu keras","ok · aktif","%s jam"%ex.get("maxHoldHours"),"Selalu menutup di sini apa pun keadaannya."),
        ("Stop / TP","ok · aktif","±%s%% / %s%%"%(ex.get("stopNetReturnPct"),ex.get("tpNetReturnPct")),"Plafon bencana simetris, bukan pengambil untung harian.")]:
        s=stt.split(" · ")[0]
        o.append("<tr><td>%s</td><td>%s %s</td><td class='dim'>%s</td><td class='dim' style='white-space:normal'>%s</td></tr>"%(
            nm,DOT[s],esc(stt.split(" · ",1)[1] if " · " in stt else stt),esc(par),esc(mean)))
    o.append("</table>")
    o.append(tech("parameter runtime",[
        ("Sinyal","<code>%s</code>"%esc(fc.get("signal"))),
        ("Ambang scoreGap","<code>%s</code> · env <code>CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP</code>"%fc.get("minScoreGap")),
        ("Leg USD / leverage","<code>%s</code> / <code>%s</code>"%(leg,ex.get("leverage"))),
        ("Batas tahan","<code>%s</code> jam · env <code>CROSS_SECTIONAL_EXEC_MAX_HOLD_HOURS</code>"%ex.get("maxHoldHours")),
        ("Stop / TP","<code>%s</code> / <code>%s</code>"%(ex.get("stopNetReturnPct"),ex.get("tpNetReturnPct"))),
        ("Exit adaptif","ambang scan dinaikkan ke nilai yang tak terjangkau dalam horizon 48 jam"),
        ("Allowlist long","<code>%s</code>"%esc(", ".join((fc.get("longAllowlist") or [])[:30]))),
        ("Blocklist short","<code>%s</code>"%esc(", ".join(fc.get("shortBlocklist") or []))),
        ("Bursa","Binance USD-M Futures"),("Funding",NA+" — tidak dibukukan per basket oleh executor")]))
    return "".join(o)

def tab_decision(R):
    o=[]
    for k in ("live","testnet"):
        i=R["inst"][k]; ex=i["ex"]; adm=i["adm"]; g=i["gate"]; att=i["attempt"]; fc=i["fc"]
        pool=(i["pool"] or {}).get("counts") or {}
        allow=adm.get("tier")=="GREEN" and not ex.get("signalStale")
        o.append("<h2>%s</h2>"%i["long"])
        why=[]
        steps=[]
        steps.append(("Kesiapan formasi",None,None))
        steps.append(("p" if pool.get("universe") else "f","Universe terbaca","%s simbol dipindai, %s memenuhi kriteria pool"%(pool.get("universe"),pool.get("poolLong"))))
        ls,ss=att.get("longSymbols"),att.get("shortSymbols")
        steps.append(("p" if ls else "o","Kandidat long",", ".join(ls or []) or "tidak tercatat"))
        steps.append(("p" if ss else "o","Kandidat short",", ".join(ss or []) or "tidak tercatat"))
        steps.append(("p","Batas klaster","maksimum 2 nama sekluster per sisi, dengan penalti kombinasi"))
        steps.append(("Kualitas alpha",None,None))
        gp,thr=att.get("scoreGap"),fc.get("minScoreGap")
        if fin(gp) and fin(thr):
            ok=gp>=thr
            steps.append(("p" if ok else "f","Pemisahan long vs short","terukur %.4f dari minimum %.4f"%(gp,thr)))
            if not ok: why.append("pemisahan skor %.4f di bawah minimum %.4f"%(gp,thr))
        else: steps.append(("o","Pemisahan long vs short","tidak tercatat pada percobaan terakhir"))
        steps.append(("Keadaan pasar",None,None))
        cur=(R["axis"] or {}).get("current") or {}
        steps.append(("p","Regime terbaca","%s · zona %s · skor %s"%(cur.get("regime"),((R["axis"] or {}).get("guidance") or {}).get("zoneLabel"),num(cur.get("score"),3))))
        steps.append(("o","Lane directional","%s (%s)"%((R["dir"] or {}).get("mode"),(R["dir"] or {}).get("marketRegime"))))
        steps.append(("Izin masuk",None,None))
        steps.append(("p" if g["pass"] else "f","Gerbang bukti","8 terakhir %s · 30 terakhir %s"%(pct(g.get("last8"),3),pct(g.get("last30"),3))))
        if not g["pass"]: why.append("bukti performa terakhir tidak lolos gerbang")
        if ex.get("entryHealthBypassed"):
            steps.append(("w","Override operator","AKTIF — menggantikan kegagalan gerbang di atas"))
        steps.append(("f" if ex.get("signalStale") else "p","Kesegaran sinyal",
                      "umur %.0f menit dari batas %.0f menit"%((ex.get("signalAgeMs") or 0)/60000.0,(ex.get("signalMaxAgeMs") or 0)/60000.0)))
        if ex.get("signalStale"): why.append("sinyal terakhir sudah lewat batas umur, jadi tidak boleh dipakai membuka posisi")
        o.append(lead("ok" if allow else "block","BOLEH MEMBUKA" if allow else "TIDAK MEMBUKA",
                      esc(str(adm.get("reason") or "Semua syarat terpenuhi."))[:220]))
        o.append("<div class='trace'>")
        for a,b,c in steps:
            if b is None and c is None: o.append("<h3>%s</h3>"%a); continue
            o.append("<div class='step %s'><div class='t'>%s</div><div class='d'>%s</div></div>"%(a,esc(b),esc(c)))
        o.append("</div>")
        if why:
            o.append("<h3>Kenapa tidak membuka</h3><ol style='color:#93a5b8;font-size:12.5px'>%s</ol>"%"".join("<li>%s</li>"%esc(w) for w in why))
        o.append(tech("audit izin · %s"%i["long"],[
            ("Traffic light",str((i["admAudit"] or {}).get("trafficLightEnabled"))),
            ("Diizinkan / kuning / ditolak","%s / %s / %s"%((i["admAudit"] or {}).get("greenAdmitted"),(i["admAudit"] or {}).get("yellowAdmitted"),(i["admAudit"] or {}).get("redBlocked"))),
            ("Latensi sinyal→order","%s detik"%num(i["signalToOrderSec"],1) if fin(i["signalToOrderSec"]) else NA),
            ("Percobaan terakhir",esc(json.dumps(att)[:420]) if att else NA),
            ("Sumber gerbang","laporan bayangan <code>filteredReport.recentNetReturns</code>, n=%s"%g.get("n"))]))
    return "".join(o)

def friendly(bid):
    """Short human handle; the internal id stays available in the detail block."""
    t=str(bid or "").replace("xb-","").split("-")[0]
    return "Basket %s"%t.upper()[:6] if t else "Basket"

def tab_formation(R):
    src=inst=None
    for k in ("live","testnet"):
        for r in reversed(R["inst"][k]["rows"]):
            if (r.get("sf") or {}).get("candidates"):
                if src is None or r["openedAtMs"]>src["openedAtMs"]: src,inst=r,R["inst"][k]["long"]
                break
    if not src: return lead("off","Belum ada formasi tercatat","Tidak ada observasi dengan rincian kandidat pada penyimpanan saat ini.")
    sf=src["sf"]; cands=sf["candidates"]; thr=R["inst"]["live"]["fc"].get("minScoreGap")
    o=[lead("ok","Formasi terakhir yang tercatat lengkap","Dibentuk %s pada %s. Kolam %s kandidat per sisi; kombinasi terbaik dipilih dari seluruh kemungkinan."%(esc(inst),esc(str(src.get("openedAt"))[:16]),sf.get("candidatePoolSize")))]
    for side in ("LONG","SHORT"):
        rows=[c for c in cands if c.get("side")==side]
        if not rows: continue
        vals=[(c["score"] if side=="LONG" else -c["score"]) for c in rows]
        m=sum(vals)/len(vals); sd=math.sqrt(sum((v-m)**2 for v in vals)/len(vals)) or 1e-9
        best_un=max([c for c in rows if not c.get("selected")],key=lambda x:x.get("utility") or -9,default=None)
        worst_sel=min([c for c in rows if c.get("selected")],key=lambda x:x.get("utility") or 9,default=None)
        o.append("<h2>Kandidat %s</h2><div class='scroll'><table>"
                 "<tr><th>simbol</th><th class='num'>MOM36</th><th class='num'>peringkat</th><th class='num'>konfirmasi</th>"
                 "<th class='num'>terlalu jauh</th><th class='num'>utility</th><th>klaster</th><th>penilaian</th><th>terpilih</th></tr>"%side)
        for c in sorted(rows,key=lambda x:-(x.get("utility") or 0)):
            rr=((c["score"] if side=="LONG" else -c["score"])-m)/sd
            u=c.get("utility") or 0
            rating="BAGUS" if u>=1.0 else "SEDANG" if u>=0.3 else "LEMAH"
            o.append("<tr><td><b>%s</b></td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
                     "<td class='num'>%s</td><td class='num'><b>%s</b></td><td class='dim'>%s</td><td class='dim'>%s</td><td>%s</td></tr>"%(
                esc(c["symbol"].replace("USDT","")),pct(100*c["score"],2),num(rr,2),num(c.get("fastSupport"),2),
                num(c.get("adverseExtensionVol"),2),num(u,3),esc(c.get("cluster") or "–"),rating,
                DOT["ok"] if c.get("selected") else DOT["off"]))
        o.append("</table></div>")
        for c in sorted(rows,key=lambda x:-(x.get("utility") or 0)):
            bl=[]
            rr=((c["score"] if side=="LONG" else -c["score"])-m)/sd
            bl.append(("plus","peringkat kuat di kolam (%.2f simpangan)"%rr) if rr>0.4 else ("minus","peringkat lemah di kolam (%.2f)"%rr))
            fs=c.get("fastSupport")
            if fin(fs): bl.append(("plus","gerak cepat mengonfirmasi (%.2f)"%fs) if fs>0.15 else (("minus","gerak cepat melawan (%.2f)"%fs) if fs<-0.15 else ("dim","gerak cepat netral")))
            ae=c.get("adverseExtensionVol")
            if fin(ae) and ae>0.3: bl.append(("minus","sudah terlalu jauh berlari (%.2f)"%ae))
            if not c.get("selected"):
                if best_un and worst_sel and c["symbol"]==best_un["symbol"]:
                    bl.append(("minus","kalah tipis dari %s pada kombinasi terbaik (%.3f vs %.3f)"%(
                        worst_sel["symbol"].replace("USDT",""),c.get("utility") or 0,worst_sel.get("utility") or 0)))
                else: bl.append(("minus","utility di bawah tiga teratas sisinya"))
            o.append("<div class='card' style='margin-top:6px'><b>%s</b> <span class='pill'>%s</span> %s<div class='s'>%s</div></div>"%(
                esc(c["symbol"].replace("USDT","")),"terpilih" if c.get("selected") else "tidak terpilih",
                "" ,"".join("<span class='%s'>%s</span> %s<br>"%(t,"+" if t=="plus" else "−" if t=="minus" else "·",esc(x)) for t,x in bl)))
    sel=[c for c in cands if c.get("selected")]
    ls=[c["score"] for c in sel if c["side"]=="LONG"]; ss=[c["score"] for c in sel if c["side"]=="SHORT"]
    gap=(sum(ls)/len(ls)-sum(ss)/len(ss)) if ls and ss else None
    o.append("<h2>Basket terpilih</h2><div class='grid'>")
    o.append(card("Long",", ".join(c["symbol"].replace("USDT","") for c in sel if c["side"]=="LONG"),"skor rata-rata %s"%(pct(100*sum(ls)/len(ls),2) if ls else "–")))
    o.append(card("Short",", ".join(c["symbol"].replace("USDT","") for c in sel if c["side"]=="SHORT"),"skor rata-rata %s"%(pct(100*sum(ss)/len(ss),2) if ss else "–")))
    o.append(card("Pemisahan",num(gap,4),("minimum %s — %s"%(num(thr,3),"LOLOS" if fin(gap) and fin(thr) and gap>=thr else "GAGAL")) if fin(thr) else NA))
    o.append(card("Utility akhir",num(sf.get("objectiveScore"),3),"sudah dikurangi penalti klaster"))
    o.append(card("Skor sumbu pasar",num(sf.get("axisScore"),3),"dasar bonus konfirmasi sisi lawan"))
    o.append("</div>")
    o.append(tech("formasi",[("Versi",esc(sf.get("version"))),("Ukuran kolam",str(sf.get("candidatePoolSize"))),
        ("Sumber observasi",esc(str(src.get("openedAt")))),
        ("Peringkat","dihitung ulang di sini: (skor berarah − rata-rata kolam) ÷ simpangan baku kolam; runtime tidak menyimpannya"),
        ("signalWeight",NA+" pada observasi bayangan — hanya basket tereksekusi yang menyimpannya")]))
    return "".join(o)

def tab_positions(R):
    o=[];eq=(R["account"] or {}).get("accountEquity");now=datetime.now(timezone.utc);any_open=False
    for k in ("live","testnet"):
        i=R["inst"][k]; thr=i["fc"].get("minScoreGap"); ex=i["ex"]
        obs=ex.get("openBaskets") or []
        o.append("<h2>%s · %d terbuka</h2>"%(i["long"],len(obs)))
        if not obs: o.append("<div class='card dim'>Tidak ada posisi terbuka.</div>")
        for b in obs:
            any_open=True
            op=piso(b.get("openedAt")); age=(now-op).total_seconds()/3600.0 if op else None
            capH=ex.get("maxHoldHours"); legs=b.get("legs") or []
            notion=sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs)
            lnr=b.get("lastNetReturn"); sb=b.get("smartBasket") or {}
            bq=basket_quality(b,thr); usd=(lnr or 0)*notion/2 if fin(lnr) else None
            o.append("<div class='card' style='margin-top:11px'>")
            o.append("<div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'><div><b>%s</b> <span class='dim'>· dibuka %s</span></div><div>%s %s</div></div>"%(
                friendly(b.get("basketId")),esc(str(b.get("openedAt"))[:16]),pct(100*lnr,3) if fin(lnr) else "",money(usd,3) if fin(usd) else ""))
            o.append("<div class='grid' style='margin-top:9px'>")
            o.append(card("Umur / batas","%.1f / %s jam"%(age,capH) if age is not None else "–","sisa %.1f jam"%(capH-age) if age is not None and capH else ""))
            o.append(card("Nilai posisi",money(notion,0),("%.0f%% ekuitas"%(100*notion/eq)) if eq else ""))
            o.append(card("Hasil sejauh ini",pct(100*lnr,3) if fin(lnr) else "–",money(usd,3) if fin(usd) else ""))
            o.append(card("Puncak terbaik",pct(100*sb["maxNetReturn"],3) if fin(sb.get("maxNetReturn")) else "–","pada %s"%str(sb.get("maxNetAt"))[:16] if sb.get("maxNetAt") else ""))
            o.append(card("Pemisahan saat masuk",num(bq.get("scoreGap"),4),"minimum %s"%num(thr,3)))
            o.append(card("Regime saat masuk",esc(sb.get("regimeClassAtOpen") or "–"),"kini %s"%esc(((R["axis"] or {}).get("current") or {}).get("regime") or "–")))
            o.append("</div>")
            o.append("<div class='g2' style='margin-top:10px'>")
            o.append(score_card(bq))
            gh=ghost_exits(b)
            rows="".join("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='dim' style='white-space:normal'>%s</td></tr>"%(
                g["rule"],(DOT["block"]+" YA") if g["fire"] else (DOT["ok"]+" tidak"),
                ("%s/%s"%(g["scans"],g["threshold"])) if g["scans"] is not None else "–",esc(str(g["reason"] or "–"))[:110]) for g in gh)
            fired=[g for g in gh if g["fire"]]
            delta=""
            if fired and fin(lnr) and fin(sb.get("maxNetReturn")):
                d=(sb["maxNetReturn"]*0.5-lnr) if any(g["rule"].startswith("Kunci") for g in fired) else None
                if fin(d): delta="<div class='note'>Selisih kontrafaktual jika aturan itu menyala: %s (%s dari nilai posisi).</div>"%(pct(100*d,3),money(d*notion/2,3))
            o.append("<div class='card'><div class='k'>Seandainya exit adaptif menyala</div>"
                     "<table style='margin-top:6px'><tr><th>aturan</th><th>memicu?</th><th class='num'>scan</th><th>alasan</th></tr>%s</table>%s"
                     "<div class='note'>Eksekusinya dimatikan; penghitungnya tetap berjalan, jadi ini keadaan nyata, bukan simulasi.</div></div>"%(rows,delta))
            o.append("</div>")
            o.append("<div class='scroll'><table style='margin-top:10px'><tr><th>kaki</th><th>sisi</th><th class='num'>qty</th>"
                     "<th class='num'>masuk</th><th class='num'>kini</th><th class='num'>nilai</th><th class='num'>terbaik</th><th class='num'>terburuk</th><th>fill</th></tr>")
            for l in legs:
                nv=abs((l.get("qty") or 0)*(l.get("entryPrice") or 0))
                o.append("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td>%s</td></tr>"%(
                    esc((l.get("symbol") or "").replace("USDT","")),esc(l.get("side")),num(l.get("qty"),4),
                    num(l.get("entryPrice"),5),num(l.get("lastMarkPrice"),5),money(nv,2),
                    num(l.get("maxFavorableR"),3),num(l.get("maxAdverseR"),3),
                    DOT["ok"] if l.get("entryPriceConfirmed") else DOT["block"]))
            o.append("</table></div>")
            o.append(tech("identitas & sumber · %s"%friendly(b.get("basketId")),[
                ("ID internal","<code>%s</code>"%esc(b.get("basketId"))),
                ("Observasi sumber","<code>%s</code>"%esc(b.get("sourceObservationId"))),
                ("Biaya dibukukan",money(b.get("feeEstimateUsd"),4)),("Funding",NA),
                ("Jatuh tempo horizon",esc(str(b.get("closesAtMs"))))]))
            o.append("</div>")
    # closed baskets review
    o.append("<h2>Tinjauan basket yang sudah tutup</h2>")
    got=False
    for k in ("live","testnet"):
        i=R["inst"][k]; thr=i["fc"].get("minScoreGap")
        for b in (i["ex"].get("recent") or []):
            if b.get("status")=="OPEN" or not b.get("closedAt"): continue
            got=True
            bq=basket_quality(b,thr); net=b.get("netPnlUsd"); lnr=b.get("lastNetReturn")
            proc,outc=post_trade_verdict(bq.get("value"),net)
            legs=b.get("legs") or []
            notion=sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs)
            o.append("<div class='card' style='margin-top:10px'><div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'>"
                     "<div><b>%s</b> <span class='dim'>· %s → %s · %s</span></div><div><b>%s · %s</b></div></div>"%(
                friendly(b.get("basketId")),esc(str(b.get("openedAt"))[:16]),esc(str(b.get("closedAt"))[:16]),
                esc(b.get("closeReason") or "–"),proc,outc))
            o.append("<div class='grid' style='margin-top:8px'>")
            o.append(card("Hasil akhir",money_pct(net,eq,4),pct(100*lnr,3) if fin(lnr) else ""))
            o.append(card("Kualitas proses",num(bq.get("value"),0),rate(bq.get("value"))))
            o.append(card("Nilai posisi",money(notion,0),"biaya %s"%money(b.get("feeEstimateUsd"),4)))
            o.append("</div>")
            up="".join("<div><span class='plus'>+</span> %s</div>"%esc(x) for x in bq.get("whyUp") or [])
            dn="".join("<div><span class='minus'>−</span> %s</div>"%esc(x) for x in bq.get("whyDown") or [])
            o.append("<div class='g2' style='margin-top:8px'><div class='card'><div class='k'>Yang berjalan baik</div><div class='s'>%s</div></div>"
                     "<div class='card'><div class='k'>Yang merugikan</div><div class='s'>%s</div></div></div>"%(up or "<span class='dim'>–</span>",dn or "<span class='dim'>–</span>"))
            o.append("<div class='scroll'><table style='margin-top:8px'><tr><th>kaki</th><th>sisi</th><th class='num'>masuk</th><th class='num'>keluar</th><th class='num'>kontribusi</th></tr>")
            for l in legs:
                e_,x_=l.get("entryPrice"),l.get("exitPrice")
                c=None
                if fin(e_) and fin(x_) and e_:
                    c=((x_-e_)/e_ if l.get("side")=="LONG" else (e_-x_)/e_)
                o.append("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>"%(
                    esc((l.get("symbol") or "").replace("USDT","")),esc(l.get("side")),num(e_,5),num(x_,5),pct(100*c,3) if fin(c) else "–"))
            o.append("</table></div>")
            o.append("<div class='note'>Kualitas proses dinilai dari pembentukan dan eksekusinya, bukan dari untung-ruginya. Basket yang dibentuk baik boleh rugi, dan sebaliknya.</div></div>")
    if not got: o.append("<div class='card dim'>Belum ada basket tertutup pada jendela terbaru.</div>")
    if not any_open and not got: o.insert(0,lead("off","Tidak ada posisi maupun riwayat terbaru","Bot sedang menunggu formasi berikutnya."))
    return "".join(o)

def tab_edge(R):
    e=R["edge"];W=e["windows"];allw=W["seluruhnya"];o=[]
    if not allw.get("n"): return lead("off","Belum ada bukti","Belum ada observasi sinyal produksi yang selesai.")
    eps=e["episodes"]
    o.append(lead("watch" if eps<30 else ("ok" if (e["tEff"] or 0)>2 else "watch"),
        "%d episode independen — inilah ukuran bukti yang sebenarnya"%eps,
        "Observasi bayangan dibuka tiap ~1 jam dan ditahan sampai horizonnya, jadi hampir seluruhnya tumpang tindih. "
        "Angka mentahnya %d observasi, tapi hanya %d petak pasar yang benar-benar terpisah. "
        "<b>t-stat terkoreksi %s</b> (mentah %s). Di bawah ~30 episode, selisih sebesar edge lane ini belum bisa dipisahkan dari nol."%(
        allw["n"],eps,num(e["tEff"],2),num(e["tRaw"],2))))
    o.append("<div class='grid'>")
    o.append(card("Episode independen",str(eps),"dari %d observasi (%.1f× tumpang tindih)"%(allw["n"],allw["n"]/max(1,eps))))
    o.append(card("t-stat terkoreksi",num(e["tEff"],2),"angka utama · mentah %s ada di detail"%num(e["tRaw"],2)))
    o.append(card("Rata-rata per basket",pct(allw.get("meanPct"),3),"seluruh riwayat"))
    o.append(card("Rentetan rugi terpanjang","%d basket"%e["longestLossStreak"],"berturut-turut"))
    o.append("</div>")
    o.append("<h2>Jendela bergulir</h2><div class='scroll'><table><tr><th>jendela</th><th class='num'>N</th><th class='num'>rata-rata</th><th class='num'>menang</th><th class='num'>PF</th><th class='num'>drawdown</th><th class='num'>t mentah</th></tr>")
    for lbl in ("8 terakhir","30 terakhir","90 terakhir","seluruhnya"):
        s=W[lbl]
        o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num dim'>%s</td></tr>"%(
            lbl,s.get("n"),pct(s.get("meanPct"),3),(num(s.get("winPct"),0)+"%") if s.get("n") else "–",num(s.get("pf"),2),pct(s.get("ddPct"),2,False),num(s.get("tStat"),2)))
    o.append("</table></div><div class='note'>Kolom t di sini <b>mentah</b> dan tidak dikoreksi tumpang tindih — berguna untuk membandingkan antar-jendela, bukan untuk menilai kekuatan bukti. Untuk itu pakai t terkoreksi di atas.</div>")
    o.append("<h2>Kurva hasil kumulatif</h2>"+curve_svg([c["net"] for c in e["curve"]]))
    o.append("<h2>Drawdown</h2>"+dd_svg([c["net"] for c in e["curve"]]))
    o.append("<h2>Hasil menurut pemisahan skor</h2>"+bars([(b["key"],b.get("meanPct")) for b in e["byGap"]]))
    o.append("<h2>Pemisahan skor vs hasil akhir</h2>"+scatter(e["gapVsReturn"],R["inst"]["live"]["fc"].get("minScoreGap") or 0.058))
    o.append("<h2>Hasil menurut keadaan pasar</h2>"+bars([(b["key"].replace("TREND_","").replace("MIXED_",""),b.get("meanPct")) for b in e["byRegime"]]))
    o.append("<h2>Hasil menurut lama tahan</h2>"+bars([(b["key"],b.get("meanPct")) for b in e["byHold"]]))
    o.append("<h2>Kontribusi per bulan</h2>"+bars([(b["key"][2:],b.get("totalPct")) for b in e["byMonth"]]))
    if e["byQuarter"]: o.append("<h2>Kontribusi per kuartal</h2>"+bars([(b["key"][2:],b.get("totalPct")) for b in e["byQuarter"]]))
    o.append("<h2>Long vs short</h2>"+bars([("long",e["sideLong"].get("meanPct")),("short",e["sideShort"].get("meanPct"))]))
    c=e["concentration"]
    if c:
        o.append("<h2>Konsentrasi hasil</h2><div class='grid'>")
        o.append(card("Kuartal terbesar",esc(c["topQuarter"]),"menyumbang %.0f%% dari seluruh pergerakan"%c["share"]))
        o.append(card("Bulan untung","%d dari %d"%(c["profitableMonths"],c["months"]),"sisanya rugi atau datar"))
        o.append("</div><div class='note'>Kalau satu kuartal menyumbang sebagian besar hasil, rata-rata tahunan menyembunyikan kenyataannya: hasilnya datang bergerombol, bukan mengalir rata.</div>")
    o.append("<h2>Skor performa</h2><div class='g2'>")
    for k in ("overall","edge","recent","dd","exec","data","evidence"): o.append(score_card(R["scores"][k]))
    o.append("</div>")
    o.append(tech("sumber & metode",[
        ("Sinyal diukur","<code>%s</code>, hanya observasi selesai"%e["signal"]),
        ("Sumber","penyimpanan observasi kedua instance, digabung & dide-duplikasi"),
        ("Episode independen","sampel non-tumpang-tindih pada horizon 48 jam"),
        ("t terkoreksi","t mentah × akar(episode ÷ N) — inilah yang masuk skor"),
        ("Profit factor","total hasil positif ÷ |total hasil negatif|"),
        ("Biaya","sudah dikurangi di tiap observasi"),("Funding & slippage",NA+" — tidak dibukukan terpisah")]))
    return "".join(o)

def tab_research(R):
    o=[];e=R["edge"];thr=R["inst"]["live"]["fc"].get("minScoreGap")
    mm=R.get("mismatch") or []
    if mm:
        o.append(lead("watch","Bukti riset TIDAK persis mewakili kebijakan produksi",
            "Angka edge di dashboard ini diukur pada kebijakan yang berbeda dari yang dijalankan sekarang. Perbedaannya di bawah — bukan alasan membuang buktinya, tapi alasan untuk tidak membacanya sebagai bukti langsung atas konfigurasi hari ini."))
        o.append("<div class='scroll'><table><tr><th>hal</th><th>produksi</th><th>bukti</th><th>kenapa penting</th></tr>")
        for m in mm:
            o.append("<tr><td><b>%s</b></td><td>%s</td><td>%s</td><td class='dim' style='white-space:normal'>%s</td></tr>"%(
                esc(m["what"]),esc(m["prod"]),esc(m["evid"]),esc(m["why"])))
        o.append("</table></div>")
    else: o.append(lead("ok","Bukti mewakili kebijakan produksi","Tidak ada ketidakcocokan terdeteksi."))
    rows=[]
    for k in INST: rows+=R["inst"][k]["rows"]
    o.append("<h2>Perbandingan kebijakan pada sinyal yang sama</h2>")
    if fin(thr) and rows:
        base=[r["netReturn"] for r in rows]
        prod=[r["netReturn"] for r in rows if fin(r.get("scoreGap")) and r["scoreGap"]>=thr]
        o.append("<div class='scroll'><table><tr><th>kebijakan</th><th class='num'>N</th><th class='num'>rata-rata</th><th class='num'>menang</th><th class='num'>total</th><th class='num'>drawdown</th><th class='num'>t mentah</th></tr>")
        for lbl,s in (("Dasar — tanpa ambang pemisahan",stats(base)),("Produksi — ambang %.3f"%thr,stats(prod))):
            o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s%%</td><td class='num'>%s</td><td class='num'>%s</td><td class='num dim'>%s</td></tr>"%(
                lbl,s.get("n"),pct(s.get("meanPct"),3),num(s.get("winPct"),0),pct(s.get("totalPct"),2),pct(s.get("ddPct"),2,False),num(s.get("tStat"),2)))
        o.append("</table></div><div class='note'>Keduanya dievaluasi pada himpunan sinyal identik, jadi selisihnya murni efek aturan — bukan beda periode atau simbol. Ambang menaikkan kualitas per basket tetapi membuang peluang, sehingga total bisa turun meski rata-ratanya naik.</div>")
    else: o.append("<div class='card dim'>Bukti tidak cukup untuk membandingkan kebijakan.</div>")
    per={}
    for k in INST:
        try: obs=(json.load(open(INST[k]["store"])) or {}).get("observations") or []
        except Exception: obs=[]
        for ob in obs:
            if ob.get("status")=="OPEN": continue
            nr=ob.get("netReturn")
            if fin(nr): per.setdefault(ob.get("signal") or "?",[]).append(nr)
    if per:
        o.append("<h2>Varian yang berjalan berdampingan</h2><div class='scroll'><table><tr><th>varian</th><th class='num'>N</th><th class='num'>rata-rata</th><th class='num'>menang</th><th class='num'>t mentah</th><th>peran</th></tr>")
        for sig,v in sorted(per.items(),key=lambda x:-len(x[1]))[:8]:
            s=stats(v)
            o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s%%</td><td class='num dim'>%s</td><td class='dim'>%s</td></tr>"%(
                esc(sig),s["n"],pct(s.get("meanPct"),3),num(s.get("winPct"),0),num(s.get("tStat"),2),"produksi" if sig==PROD_SIGNAL else "pembanding"))
        o.append("</table></div>")
    o.append("<h2>Provenance riset</h2>")
    o.append("<div class='scroll'><table><tr><th>hal</th><th>keadaan</th></tr>"
      "<tr><td>Periode data</td><td>%s → %s</td></tr>"
      "<tr><td>Observasi / episode independen</td><td>%d / %d</td></tr>"
      "<tr><td>Horizon bukti</td><td>%s jam</td></tr>"
      "<tr><td>Biaya</td><td>sudah dikurangi tiap observasi</td></tr>"
      "<tr><td>Funding / slippage</td><td>%s</td></tr>"
      "<tr><td>Observasi tumpang tindih</td><td>ya — %.1f× · t terkoreksi dipakai sebagai angka utama</td></tr>"
      "<tr><td>Pemisahan holdout / OOS</td><td>%s — perbandingan di atas in-sample</td></tr>"
      "<tr><td>ID & tanggal jalannya harness</td><td>%s — harness berjalan di luar layanan ini</td></tr>"
      "<tr><td>Konfigurasi diuji sebagai satu bundel?</td><td>%s</td></tr></table></div>"%(
      esc((R["edge"]["curve"][0]["at"] or "")[:10]) if R["edge"]["curve"] else "–",
      esc((R["edge"]["curve"][-1]["at"] or "")[:10]) if R["edge"]["curve"] else "–",
      R["edge"]["windows"]["seluruhnya"].get("n",0),R["edge"]["episodes"],
      " / ".join("%g"%h for h in R["edge"]["evidenceHorizonsH"]) or "–",NA,
      R["edge"]["windows"]["seluruhnya"].get("n",0)/max(1,R["edge"]["episodes"]),NA,NA,NA))
    o.append("<h2>Riwayat perubahan parameter</h2>")
    log=sh("git -C %s log --oneline -14 2>/dev/null"%INST["live"]["rel"])
    if log and not log.startswith("ERR") and log.strip():
        o.append("<div class='scroll'><table><tr><th>commit</th><th>perubahan</th></tr>%s</table></div>"%"".join(
            "<tr><td class='dim'>%s</td><td>%s</td></tr>"%(esc(l.split(" ",1)[0]),esc(l.split(" ",1)[1] if " " in l else "")) for l in log.splitlines()))
    else:
        o.append("<div class='card dim'>%s — direktori rilis bukan checkout git, jadi riwayat <code>parameter → perubahan → bukti</code> tidak bisa dibaca dari runtime. Yang bisa diverifikasi runtime hanyalah nilai yang berlaku sekarang dan kepatuhannya terhadap berkas kebijakan.</div>"%NA)
    return "".join(o)

def tab_system(R):
    o=[];sy=R["system"];ex=R["exec"]
    bad=[j for j in sy["jobs"] if j["stale"]]+[p for p in sy["pm2"] if p["status"]!="online"]
    o.append(lead("block" if bad else "ok","Infrastruktur sehat" if not bad else "%d komponen perlu perhatian"%len(bad),
        "Kesehatan sistem dinilai terpisah dari kesehatan edge: layanan bisa sempurna sementara strateginya rugi, dan sebaliknya."))
    o.append("<h2>Kualitas eksekusi</h2><div class='grid'>")
    o.append(card("Harga fill terkonfirmasi",("%.0f%%"%ex["pct"]) if fin(ex["pct"]) else NA,"%d dari %d nilai"%(ex["confirmed"],ex["total"])))
    o.append(card("Galat ukuran kaki",("%.1f%%"%ex["notionalErrPct"]) if fin(ex["notionalErrPct"]) else NA,"simpangan dari nilai rencana (pembulatan lot)"))
    o.append(card("Selisih harga masuk",("%.3f%%"%ex["entryDriftPct"]) if fin(ex["entryDriftPct"]) else NA,"fill vs harga acuan saat rencana"))
    lat=[v for v in ex["latency"].values() if fin(v)]
    o.append(card("Latensi sinyal→order",("%.1f detik"%(sum(lat)/len(lat))) if lat else NA,"rata-rata percobaan terakhir tiap instance"))
    o.append("</div>")
    o.append("<h2>Kualitas data</h2><div class='grid'>")
    d=R["data"]
    o.append(card("Simbol terukur","%d / %d"%(d["universe"]-len(d["missing"]),d["universe"]),esc(", ".join(s.replace("USDT","") for s in d["missing"])) or "semua terbaca"))
    o.append(card("Sinyal basi",", ".join(R["inst"][k]["label"] for k in d["stale"]) or "tidak ada","batas umur sinyal dari executor"))
    o.append(card("Selisih jam bursa",("%.0f ms"%R["clockSkewMs"]) if fin(R.get("clockSkewMs")) else NA,"host vs waktu server Binance"))
    o.append("</div>")
    o.append("<h2>Layanan &amp; pekerjaan latar</h2><table><tr><th>komponen</th><th>status</th><th class='dim'>rinci</th></tr>")
    for p in sy["pm2"]:
        o.append("<tr><td>%s</td><td>%s %s</td><td class='dim'>restart %s</td></tr>"%(esc(p["name"]),DOT["ok"] if p["status"]=="online" else DOT["block"],esc(p["status"]),p["restarts"]))
    for j in sy["jobs"]:
        o.append("<tr><td>%s</td><td>%s %s</td><td class='dim'>terakhir %s, ambang %.0f jam</td></tr>"%(
            j["job"],DOT["block"] if j["stale"] else DOT["ok"],"BERHENTI" if j["stale"] else "berjalan",
            "tidak pernah" if j["ageHours"] is None else "%.1f jam lalu"%j["ageHours"],j["maxHours"]))
    o.append("</table>")
    o.append("<h2>Perbandingan lingkungan</h2><div class='scroll'><table><tr><th>parameter</th><th>LIVE</th><th>TESTNET</th><th>sama?</th></tr>")
    lv,tn=R["inst"]["live"],R["inst"]["testnet"]
    for lbl,a,b in (("Ukuran per kaki",lv["ex"].get("legUsd"),tn["ex"].get("legUsd")),
                    ("Batas tahan (jam)",lv["ex"].get("maxHoldHours"),tn["ex"].get("maxHoldHours")),
                    ("Stop (%)",lv["ex"].get("stopNetReturnPct"),tn["ex"].get("stopNetReturnPct")),
                    ("Ambil untung (%)",lv["ex"].get("tpNetReturnPct"),tn["ex"].get("tpNetReturnPct")),
                    ("Ambang pemisahan",lv["fc"].get("minScoreGap"),tn["fc"].get("minScoreGap")),
                    ("Sinyal",lv["fc"].get("signal"),tn["fc"].get("signal")),
                    ("Ukuran universe",len(lv["fc"].get("executionUniverse") or []),len(tn["fc"].get("executionUniverse") or [])),
                    ("Basket bersamaan",lv["ex"].get("maxOpenBaskets"),tn["ex"].get("maxOpenBaskets")),
                    ("Override gerbang bukti",lv["ex"].get("entryHealthBypassed"),tn["ex"].get("entryHealthBypassed"))):
        o.append("<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"%(lbl,esc(a),esc(b),DOT["ok"] if a==b else DOT["watch"]))
    o.append("</table></div><div class='note'>Perbedaan pada dua baris terakhir disengaja: testnet melonggarkan perlindungan modal karena tidak punya modal untuk dilindungi, sementara parameter strategi dijaga identik agar hasilnya sebanding.</div>")
    o.append(tech("host & integritas",[("Waktu host (UTC)",esc(sy["hostTimeUtc"][:19])),
        ("Disk","%s terpakai dari %s, sisa %s"%(sy["disk"]["pct"],sy["disk"]["size"],sy["disk"]["avail"]) if sy.get("disk") else "–"),
        ("Kepatuhan kebijakan","<br>".join("%s: %s"%(R["inst"][k]["long"],esc(R["inst"][k]["envPolicy"][:70])) for k in INST)),
        ("SHA rilis / hash konfigurasi",NA+" — manifest kode tidak mengekspos hash pohon yang bisa dibandingkan lintas-instance")]))
    return "".join(o)

TABS=[("overview","Ringkasan",tab_overview),("strategy","Strategi",tab_strategy),("decision","Keputusan",tab_decision),
      ("formation","Formasi",tab_formation),("positions","Posisi",tab_positions),("edge","Edge",tab_edge),
      ("research","Riset",tab_research),("system","Sistem",tab_system)]

def render(R):
    body=[]
    for i,(tid,lbl,fn) in enumerate(TABS):
        try: html=fn(R)
        except Exception as ex: html="<div class='lead'><div class='c'>🔴 Tab gagal dirender</div><div class='r'>%s</div></div>"%esc(str(ex)[:240])
        body.append("<section id='%s'%s>%s</section>"%(tid," class='on'" if i==0 else "",html))
    nav="".join("<button data-t='%s'%s>%s</button>"%(t," class='on'" if i==0 else "",l) for i,(t,l,_) in enumerate(TABS))
    js=("<script>document.querySelectorAll('nav button').forEach(function(b){b.onclick=function(){"
        "document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('on')});"
        "document.querySelectorAll('section').forEach(function(x){x.classList.remove('on')});"
        "b.classList.add('on');document.getElementById(b.dataset.t).classList.add('on');location.hash=b.dataset.t};});"
        "if(location.hash){var b=document.querySelector(\"nav button[data-t='\"+location.hash.slice(1)+\"']\");if(b)b.click();}</script>")
    return ("<!doctype html><html lang='id'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>Kronos · kokpit</title><style>%s</style><div class='wrap'>"
            "<header><h1>KRONOS · kokpit trading &amp; riset</h1><span class='stamp'>%s UTC · hanya-baca, tanpa kunci bursa</span></header>"
            "<nav>%s</nav>%s</div>%s</html>")%(CSS,R["generatedAt"][:19],nav,"".join(body),js)

class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        try:
            if self.path.startswith("/api/report"):
                R=collect(); slim={k:v for k,v in R.items() if k!="inst"}
                slim["inst"]={k:{kk:vv for kk,vv in v.items() if kk not in ("rows","rep")} for k,v in R["inst"].items()}
                body,ct=json.dumps(slim,default=str).encode(),"application/json"
            elif self.path=="/healthz": body,ct=b"ok","text/plain"
            else: body,ct=render(collect()).encode(),"text/html; charset=utf-8"
            self.send_response(200); self.send_header("Content-Type",ct)
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as ex:
            m=("cockpit error: %s"%ex).encode()
            self.send_response(500); self.send_header("Content-Length",str(len(m))); self.end_headers(); self.wfile.write(m)

if __name__=="__main__":
    HTTPServer(("127.0.0.1",PORT),H).serve_forever()
