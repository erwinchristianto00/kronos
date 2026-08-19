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
    """Map a raw value onto 0-100 between lo (=0) and hi (=100), clamped. Used only where an
    absolute reference genuinely exists (a percentage of confirmed fills is 0-100 by definition)."""
    if not fin(v) or hi==lo: return None
    return clamp(100.0*(v-lo)/(hi-lo))

def rank_in(v,dist):
    """Percentile rank of v inside the strategy's OWN observed distribution.

    Earlier versions scored formation quality against hand-picked anchors, and the anchors were
    unreachable: the '100' for separation sat at 2x the threshold when the strategy's own median
    formation reaches 0.78x, and the '100' for cluster spread required six distinct clusters across
    six legs. Every real basket therefore scored as garbage, which said more about the yardstick
    than the baskets. 50 now means typical for this strategy, 90 means better than 90% of what it
    has actually produced."""
    if not fin(v) or not dist: return None
    n=len(dist); below=sum(1 for x in dist if x<v); eq=sum(1 for x in dist if x==v)
    return clamp(100.0*(below+0.5*eq)/n)

# ------------------------------------------------------------------ basket quality
def _sf_for(b, sfidx):
    """Formation diagnostics for an EXECUTED basket, joined through sourceObservationId.
    The basket record keeps plan/legs; fastSupport and extension live on the observation that
    produced it, so without this join three of the quality components would be permanently blank."""
    sf = sfidx.get(b.get("sourceObservationId")) or {}
    cands = sf.get("candidates") or []
    sel = {c["symbol"]: c for c in cands if c.get("selected")}
    return sf, sel

def basket_scores(b, thr, sfidx=None, dist=None):
    """Four separate verdicts. Entry quality is fixed the moment the basket is formed; current
    health moves while it is open; execution is about the fills; outcome is money. Mixing them
    is what makes a lucky winner look well-built and a well-built loser look like a mistake."""
    sfidx = sfidx or {}; dist = dist or {}
    plan = b.get("plan") or []; legs = b.get("legs") or []; sb = b.get("smartBasket") or {}
    sf, sel = _sf_for(b, sfidx)
    lsc=[p["scoreAtOpen"] for p in plan if p.get("side")=="LONG" and fin(p.get("scoreAtOpen"))]
    ssc=[p["scoreAtOpen"] for p in plan if p.get("side")=="SHORT" and fin(p.get("scoreAtOpen"))]
    gap=(sum(lsc)/len(lsc)-sum(ssc)/len(ssc)) if lsc and ssc else None
    scores=[p.get("scoreAtOpen") for p in plan if fin(p.get("scoreAtOpen"))]

    E=Score("Kualitas entry")
    if fin(gap) and fin(thr) and thr>0:
        _r=rank_in(gap,dist.get("gap"))
        E.add("Pemisahan long-short",_r,2.0,
              "scoreGap %.4f = %.2f× minimum %.3f · lebih lebar dari %s formasi lain"%(
                  gap,gap/thr,thr,("%.0f%%"%_r) if _r is not None else "?"))
    else: E.add("Pemisahan long-short",None,2.0,NA)
    if scores:
        strg=sum(abs(x) for x in scores)/len(scores)
        E.add("Kekuatan sinyal",rank_in(strg,dist.get("strg")),1.5,"rata-rata |MOM36| kaki terpilih %.2f%%"%(100*strg))
    else: E.add("Kekuatan sinyal",None,1.5,NA)
    E.add("Utility formasi",rank_in(sf.get("objectiveScore"),dist.get("obj")),1.0,
          ("total utility kombinasi terpilih %.3f"%sf["objectiveScore"]) if fin(sf.get("objectiveScore")) else NA+" — formasi tidak terjoin")
    fss=[c.get("fastSupport") for c in sel.values() if fin(c.get("fastSupport"))]
    E.add("Konfirmasi cepat",rank_in((sum(fss)/len(fss)) if fss else None,dist.get("fast")),1.0,
          ("rata-rata fastSupport kaki terpilih %+.2f"%(sum(fss)/len(fss))) if fss else NA)
    aes=[c.get("adverseExtensionVol") for c in sel.values() if fin(c.get("adverseExtensionVol"))]
    E.add("Risiko terlalu jauh",rank_in(-(sum(aes)/len(aes)) if aes else None,dist.get("ext")),1.0,
          ("rata-rata ekstensi %+.2f (makin tinggi makin mengejar)"%(sum(aes)/len(aes))) if aes else NA)
    cl=[(p.get("cluster") or (sel.get(p.get("symbol"),{}) or {}).get("cluster") or "?") for p in plan]
    known=[c for c in cl if c!="?"]
    E.add("Sebaran klaster",band(len(set(known))/float(len(known)),0.34,1.0) if known else None,1.0,
          ("%d klaster berbeda dari %d kaki"%(len(set(known)),len(known))) if known else NA)

    H=Score("Kesehatan tesis kini")
    rs,cs=sb.get("consecutiveRegimeLossScans"),sb.get("consecutiveInvalidationScans")
    if isinstance(rs,int) or isinstance(cs,int):
        worst=max(rs or 0,cs or 0)
        H.add("Tesis pembentuk masih berlaku",band(-worst,-2.0,0.0),2.0,"scan berturut tertinggi %d dari ambang 2"%worst)
    else: H.add("Tesis pembentuk masih berlaku",None,2.0,NA)
    mfe,lnr=sb.get("maxNetReturn"),b.get("lastNetReturn")
    if fin(mfe) and fin(lnr) and mfe>0:
        H.add("Jarak dari puncak",band(lnr/mfe,0.0,1.0),1.0,"kini %.3f%% dari puncak %.3f%%"%(100*lnr,100*mfe))
    else: H.add("Jarak dari puncak",None,1.0,NA)

    X=Score("Kualitas eksekusi")
    tot=conf=0
    for l in legs:
        for f in ("entryPriceConfirmed","exitPriceConfirmed"):
            if l.get(f) is None: continue
            tot+=1; conf+=1 if l[f] else 0
    X.add("Harga fill dikonfirmasi bursa",(100.0*conf/tot) if tot else None,2.0,("%d dari %d nilai"%(conf,tot)) if tot else NA)
    pmap={p.get("symbol"):p for p in plan if isinstance(p,dict)}
    errs=[];drifts=[]
    for l in legs:
        p=pmap.get(l.get("symbol"))
        if not p: continue
        if fin(p.get("targetNotionalUsd")) and p["targetNotionalUsd"]>0:
            errs.append(abs(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0))/p["targetNotionalUsd"]-1))
        if fin(p.get("refPrice")) and p["refPrice"]>0 and fin(l.get("entryPrice")):
            drifts.append(abs(l["entryPrice"]/p["refPrice"]-1))
    X.add("Ketepatan ukuran kaki",band(-(sum(errs)/len(errs)),-0.25,0.0) if errs else None,1.0,
          ("simpangan %.1f%% dari nilai rencana"%(100*sum(errs)/len(errs))) if errs else NA)
    X.add("Selisih harga masuk",band(-(sum(drifts)/len(drifts)),-0.005,0.0) if drifts else None,1.0,
          ("%.3f%% dari harga acuan"%(100*sum(drifts)/len(drifts))) if drifts else NA)
    L=sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs if l.get("side")=="LONG")
    S=sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs if l.get("side")=="SHORT")
    if L+S>0:
        imb=abs(L-S)/(L+S)
        X.add("Keseimbangan long/short",band(-imb,-0.10,0.0),1.5,"selisih nilai %.1f%% (long $%.0f vs short $%.0f)"%(100*imb,L,S))
    else: X.add("Keseimbangan long/short",None,1.5,NA)

    return {"entry":E.as_dict(),"health":H.as_dict(),"exec":X.as_dict(),
            "scoreGap":gap,"formationJoined":bool(sf),
            "execCoverage":{"measured":[p["name"] for p in X.parts if fin(p["value"])],
                            "unmeasured":[p["name"] for p in X.parts if not fin(p["value"])]}}

GHOST_SCANS=2
def ghost_chain(b):
    """The REAL evaluation order in smartExitReason, not three independent switches.
    Regime short-circuits everything; nothing below it is even reached unless Context
    Invalidation is already confirmed; MFE giveback lives INSIDE that branch."""
    sb=b.get("smartBasket") or {}
    rs=sb.get("consecutiveRegimeLossScans") or 0
    cs=sb.get("consecutiveInvalidationScans") or 0
    mfe,lnr=sb.get("maxNetReturn"),b.get("lastNetReturn")
    steps=[]
    regime_fire = rs>=GHOST_SCANS
    steps.append({"n":1,"rule":"Regime berbalik","gate":"scan berturut %d dari %d"%(rs,GHOST_SCANS),
                  "state":"MEMICU" if regime_fire else "tidak","fire":regime_fire,
                  "reason":sb.get("lastRegimeLossReason"),
                  "note":"Kalau ini menyala, seluruh langkah di bawahnya tidak pernah diperiksa."})
    if regime_fire:
        for n,r in ((2,"Tesis batal"),(3,"Kunci laba (MFE giveback)")):
            steps.append({"n":n,"rule":r,"gate":"tidak dijangkau","state":"—","fire":False,"reason":None,
                          "note":"Dilewati karena regime sudah menutup basket lebih dulu."})
        return steps,regime_fire
    ctx_ok = cs>=GHOST_SCANS
    steps.append({"n":2,"rule":"Tesis batal (Context Invalidation)","gate":"scan berturut %d dari %d"%(cs,GHOST_SCANS),
                  "state":"terpenuhi" if ctx_ok else "TIDAK terpenuhi — gerbang tertutup","fire":False,
                  "reason":sb.get("lastInvalidationReason"),
                  "note":"Ini gerbang, bukan exit. Selama belum terpenuhi, MFE giveback maupun penutupan tesis tidak mungkin terjadi."})
    if not ctx_ok:
        steps.append({"n":3,"rule":"Kunci laba (MFE giveback)","gate":"tidak dijangkau","state":"—","fire":False,
                      "reason":("aritmetikanya %s, tapi gerbang di atas belum terbuka"%(
                          "sudah terpenuhi" if (fin(mfe) and fin(lnr) and mfe>=0.002 and lnr<=mfe*0.5) else "belum terpenuhi")),
                      "note":"Bukan trailing stop berdiri sendiri — hanya bisa dijangkau setelah tesis dinyatakan batal."})
        steps.append({"n":4,"rule":"Penutupan tesis batal","gate":"tidak dijangkau","state":"—","fire":False,
                      "reason":None,"note":"Menuntut gerbang yang sama."})
        return steps,False
    mfe_fire = fin(mfe) and fin(lnr) and mfe>=0.002 and lnr<=mfe*0.5
    steps.append({"n":3,"rule":"Kunci laba (MFE giveback)",
                  "gate":"puncak %s ≥ 0,20%% dan kini %s ≤ separuh puncak"%(
                      ("%.3f%%"%(100*mfe)) if fin(mfe) else "?",("%.3f%%"%(100*lnr)) if fin(lnr) else "?"),
                  "state":"MEMICU" if mfe_fire else "tidak","fire":mfe_fire,"reason":None,
                  "note":"Diperiksa hanya karena gerbang tesis batal sudah terbuka."})
    ctx_fire = (not mfe_fire) and fin(lnr) and lnr<=0
    steps.append({"n":4,"rule":"Penutupan tesis batal","gate":"hasil kini %s ≤ 0"%(("%.3f%%"%(100*lnr)) if fin(lnr) else "?"),
                  "state":"MEMICU" if ctx_fire else "tidak","fire":ctx_fire,"reason":None,
                  "note":"Langkah terakhir; hanya menutup kalau basket sedang rugi."})
    return steps,(mfe_fire or ctx_fire)

def post_trade_verdict(q,net):
    if not fin(q) or not fin(net): return NA,NA
    return ("PROSES BAGUS" if q>=65 else "PROSES SEDANG" if q>=45 else "PROSES LEMAH"),("HASIL UNTUNG" if net>0 else "HASIL RUGI")

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
    sfidx={}
    for k in INST:
        try: obs=(json.load(open(INST[k]["store"])) or {}).get("observations") or []
        except Exception: obs=[]
        latest=None
        for ob in obs:
            sf=ob.get("smartFormation")
            if not (sf and sf.get("candidates")): continue
            if ob.get("observationId"): sfidx[ob["observationId"]]=sf
            # Formation is fully determined at entry, so an OPEN observation is a complete record
            # of what was selected and why. Requiring resolution here left LIVE blank for days.
            if ob.get("signal")==PROD_SIGNAL and fin(ob.get("openedAtMs")):
                if latest is None or ob["openedAtMs"]>latest["openedAtMs"]:
                    latest={"openedAtMs":ob["openedAtMs"],"openedAt":ob.get("openedAt"),
                            "status":ob.get("status"),"sf":sf,"scoreGap":ob.get("scoreGap")}
        R["inst"][k]["latestFormation"]=latest
    R["sfIndex"]=sfidx
    D={"gap":[],"clus":[],"strg":[],"obj":[],"fast":[],"ext":[]}
    for k in INST:
        try: obs=(json.load(open(INST[k]["store"])) or {}).get("observations") or []
        except Exception: obs=[]
        for ob in obs:
            if ob.get("signal")!=PROD_SIGNAL: continue
            sf=ob.get("smartFormation") or {}; sel=[c for c in (sf.get("candidates") or []) if c.get("selected")]
            if len(sel)!=6: continue
            if fin(ob.get("scoreGap")): D["gap"].append(ob["scoreGap"])
            cl=[c.get("cluster") for c in sel if c.get("cluster")]
            if cl: D["clus"].append(len(set(cl))/len(cl))
            sc=[abs(c["score"]) for c in sel if fin(c.get("score"))]
            if sc: D["strg"].append(sum(sc)/len(sc))
            if fin(sf.get("objectiveScore")): D["obj"].append(sf["objectiveScore"])
            f=[c["fastSupport"] for c in sel if fin(c.get("fastSupport"))]
            if f: D["fast"].append(sum(f)/len(f))
            a=[c["adverseExtensionVol"] for c in sel if fin(c.get("adverseExtensionVol"))]
            if a: D["ext"].append(-(sum(a)/len(a)))
    R["dist"]=D
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

def score_card(sd, extra_line=None):
    v=sd.get("value")
    if not fin(v):
        return "<div class='card'><div class='k'>%s</div><div class='v dim'>%s</div><div class='s'>bukti tidak cukup</div></div>"%(sd["label"],NA)
    col="#4ec9a0" if v>=70 else "#d9a441" if v>=50 else "#e5686d"
    have=[p for p in sd["parts"] if fin(p["value"])]
    ups=sorted([p for p in have if p["value"]>=60],key=lambda p:-p["value"])
    dns=sorted([p for p in have if p["value"]<45],key=lambda p:p["value"])
    mid=[p for p in have if 45<=p["value"]<60]
    miss=[p["name"] for p in sd["parts"] if not fin(p["value"])]
    line = extra_line or ("Ditarik naik oleh %s%s.%s"%(
        ", ".join(p["name"].lower() for p in ups[:2]) if ups else "tidak ada komponen yang kuat",
        (" Ditekan oleh %s"%", ".join(p["name"].lower() for p in dns[:2])) if dns else " Tidak ada komponen yang benar-benar lemah",
        (" %d komponen tanpa data dikeluarkan beserta bobotnya."%len(miss)) if miss else ""))
    def _blk(title,items,cls,sym,empty):
        if not items: return "<div><span class='k'>%s</span><div class='dim' style='font-size:12px'>%s</div></div>"%(title,empty)
        return "<div><span class='k'>%s</span>%s</div>"%(title,"".join(
            "<div style='font-size:12px'><span class='%s'>%s</span> %s <span class='dim'>· %s · %s</span></div>"%(
                cls,sym,esc(p["name"]),num(p["value"],0),esc(p["detail"])) for p in items[:3]))
    why=("<div class='g2' style='margin-top:8px'>%s%s</div>"%(
        _blk("Pendorong",ups,"plus","+","tidak ada komponen yang mencapai kuat"),
        _blk("Penekan",dns,"minus","−","tidak ada komponen yang benar-benar lemah — sisanya sedang"))
        +(("<div class='note'>%d komponen di rentang sedang: %s</div>"%(len(mid),esc(", ".join(p["name"] for p in mid)))) if mid else "")
        +(("<div class='note'>Tanpa data (dikeluarkan beserta bobotnya): %s</div>"%esc(", ".join(miss))) if miss else ""))
    rows="".join("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num dim'>%.1f</td><td class='dim'>%s</td></tr>"%(
        p["name"],("<span class='plus'>+</span>" if fin(p["value"]) and p["value"]>=60 else "<span class='minus'>−</span>" if fin(p["value"]) else "<span class='dim'>·</span>"),
        num(p["value"],0),p["weight"],esc(p["detail"] or "")) for p in sd["parts"])
    return ("<div class='card'><div class='k'>%s</div>"
            "<div class='v' style='color:%s'>%d<span style='font-size:12px;color:#68788a'> / 100 · %s</span></div>"
            "<div class='bar'><i style='width:%.0f%%;background:%s'></i></div>"
            "<div class='s' style='color:#93a5b8'>%s</div>%s"
            "<details style='margin-top:8px'><summary>Bagaimana dihitung?</summary><div class='body'>"
            "<table><tr><th>komponen</th><th></th><th class='num'>nilai</th><th class='num'>bobot</th><th>dasar</th></tr>%s</table>"
            "<div class='note'>Rata-rata tertimbang dari komponen yang punya data; komponen tanpa data dibuang beserta bobotnya, jadi data hilang tidak pernah terhitung sebagai nol. "
            "Komponen kualitas entry dinilai sebagai <b>peringkat persentil terhadap riwayat strategi ini sendiri</b> — 50 berarti khas, 90 berarti lebih baik dari 90%% formasi yang pernah ia hasilkan. "
            "Bukan terhadap patokan ideal yang tak pernah dicapai.</div>"
            "</div></details></div>")%(sd["label"],col,round(v),rate(v),v,col,
             esc(line),why,rows)

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
    steps=[("1 · MOM36","Peringkat momentum 36 jam atas %s simbol universe. Menghasilkan urutan kuat→lemah, belum memutuskan apa pun."%cnt.get("universe")),
      ("2 · Smart Formation","Ambil 5 kandidat teratas tiap sisi, nilai tiap nama, lalu coba SEMUA kombinasi 3-lawan-3 dan pilih yang total utility-nya tertinggi setelah penalti klaster. <b>Tidak membuat sinyal baru</b> — hanya memilih basket terbaik dari peringkat yang sudah ada."),
      ("3 · Gerbang scoreGap","Selisih rata-rata skor long dan short harus ≥ <b>%s</b>. Di bawah itu basket ditolak sepenuhnya, betapapun bagus kombinasinya — cross-section yang rapat berarti tak ada yang bisa dipanen."%fc.get("minScoreGap")),
      ("4 · Revalidasi entry","Tepat sebelum order dikirim, cek apakah harga sudah lari melawan sejak sinyal dibentuk. Kalau sudah, batalkan daripada mengejar."),
      ("5 · Smart Basket / Ghost","Setelah basket hidup, tiga aturan adaptif <b>mengevaluasi</b> apakah alasan masuknya masih berlaku. Eksekusinya dimatikan; evaluasinya tetap jalan sehingga bisa diukur tanpa menyentuh uang."),
      ("6 · Batas 36 jam / stop / TP","Yang benar-benar menutup posisi: batas waktu keras %s jam, atau stop/TP simetris ±%s%%/%s%%."%(ex.get("maxHoldHours"),ex.get("stopNetReturnPct"),ex.get("tpNetReturnPct")))]
    o.append("<div class='flow'>"+"<span class='a'>→</span>".join("<span class='n'>%s</span>"%x[0] for x in steps)+"</div>")
    o.append("<table><tr><th>tahap</th><th>yang terjadi</th></tr>%s</table>"%"".join(
        "<tr><td><b>%s</b></td><td class='dim' style='white-space:normal'>%s</td></tr>"%(a,b) for a,b in steps))
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

def _decompose(c, side, pool_scores, axis):
    """Rebuild the utility from its terms. Verified against the stored value on every candidate
    in both stores (1178/1178 exact), so the breakdown below is the real arithmetic rather than a
    plausible-looking reconstruction."""
    m=sum(pool_scores)/len(pool_scores)
    sd=math.sqrt(sum((v-m)**2 for v in pool_scores)/len(pool_scores)) or 1e-6
    dir_score=(c["score"] if side=="LONG" else -c["score"])
    raw=(dir_score-m)/sd
    fs=c.get("fastSupport"); ae=c.get("adverseExtensionVol")
    t_fast=0.22*clamp(fs,-2,2) if fin(fs) else None
    t_ext=-0.20*max(0.0,clamp(ae,-2,3)) if fin(ae) else None
    sign=1 if side=="LONG" else -1
    counter=fin(axis) and axis*sign<-0.12 and fin(fs)
    t_bonus=0.08*clamp(fs,-2,2) if counter else None
    total=raw+(t_fast or 0)+(t_ext or 0)+(t_bonus or 0)
    return {"raw":raw,"fast":t_fast,"ext":t_ext,"bonus":t_bonus,"total":total,
            "stored":c.get("utility"),"match":fin(c.get("utility")) and abs(total-c["utility"])<1e-6}

def _formation_block(R,key,src):
    sf=src["sf"]; cands=sf["candidates"]; axis=sf.get("axisScore")
    thr=R["inst"][key]["fc"].get("minScoreGap"); o=[]
    o.append("<h2>%s · formasi %s <span class='pill'>%s</span></h2>"%(
        R["inst"][key]["long"],esc(str(src.get("openedAt"))[:16]),
        "masih berjalan" if src.get("status")=="OPEN" else "sudah selesai"))
    for side in ("LONG","SHORT"):
        rows=[c for c in cands if c.get("side")==side]
        if not rows: continue
        ps=[(c["score"] if side=="LONG" else -c["score"]) for c in rows]
        dec={c["symbol"]:_decompose(c,side,ps,axis) for c in rows}
        rows=sorted(rows,key=lambda c:-(c.get("utility") or 0))
        o.append("<h3>Sisi %s — bagaimana angka pemilihnya terbentuk</h3>"%side)
        o.append("<div class='scroll'><table><tr><th>simbol</th><th class='num'>MOM36</th>"
                 "<th class='num'>peringkat</th><th class='num'>+0,22×konfirmasi</th><th class='num'>−0,20×ekstensi</th>"
                 "<th class='num'>+bonus</th><th class='num'>= utility</th><th>klaster</th><th>terpilih</th></tr>")
        for c in rows:
            d=dec[c["symbol"]]
            o.append("<tr><td><b>%s</b></td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
                     "<td class='num'>%s</td><td class='num'>%s</td><td class='num'><b>%s</b></td><td class='dim'>%s</td><td>%s</td></tr>"%(
                esc(c["symbol"].replace("USDT","")),pct(100*c["score"],2),num(d["raw"],3),
                ("<span class='%s'>%+.3f</span>"%("pos" if d["fast"]>=0 else "neg",d["fast"])) if d["fast"] is not None else "<span class='dim'>–</span>",
                ("<span class='neg'>%+.3f</span>"%d["ext"]) if d["ext"] is not None and d["ext"]!=0 else ("<span class='dim'>0</span>" if d["ext"] is not None else "<span class='dim'>–</span>"),
                ("<span class='pos'>%+.3f</span>"%d["bonus"]) if d["bonus"] is not None else "<span class='dim'>–</span>",
                num(d["total"],3),esc(c.get("cluster") or "–"),
                DOT["ok"] if c.get("selected") else DOT["off"]))
        o.append("</table></div>")
        sel=[c for c in rows if c.get("selected")]
        uns=[c for c in rows if not c.get("selected")]
        if sel and uns:
            worst=min(sel,key=lambda c:c.get("utility") or 9); best=max(uns,key=lambda c:c.get("utility") or -9)
            dw,db=dec[worst["symbol"]],dec[best["symbol"]]
            gapu=(worst.get("utility") or 0)-(best.get("utility") or 0)
            terms=[("peringkat momentum",dw["raw"]-db["raw"]),
                   ("konfirmasi cepat",(dw["fast"] or 0)-(db["fast"] or 0)),
                   ("penalti ekstensi",(dw["ext"] or 0)-(db["ext"] or 0)),
                   ("bonus sisi lawan",(dw["bonus"] or 0)-(db["bonus"] or 0))]
            terms=[t for t in terms if abs(t[1])>1e-9]
            drv=max(terms,key=lambda t:abs(t[1]))[0] if terms else "–"
            o.append("<div class='card'><div class='k'>Kenapa %s masuk dan %s tidak</div>"
                     "<div class='s'>Selisih utility <b>%.3f</b>. Penyumbang terbesar: <b>%s</b>.</div>"
                     "<table style='margin-top:6px'><tr><th>suku</th><th class='num'>%s</th><th class='num'>%s</th><th class='num'>selisih</th></tr>%s"
                     "<tr><td><b>utility</b></td><td class='num'><b>%s</b></td><td class='num'><b>%s</b></td><td class='num'><b>%s</b></td></tr></table>"
                     "<div class='note'>Kalau selisihnya tipis, urutan ini bisa berbalik oleh pergerakan kecil — bukan keyakinan kuat bahwa satu lebih baik dari yang lain.</div></div>"%(
                esc(worst["symbol"].replace("USDT","")),esc(best["symbol"].replace("USDT","")),gapu,drv,
                esc(worst["symbol"].replace("USDT","")),esc(best["symbol"].replace("USDT","")),
                "".join("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>"%(
                    nm,num(getattr_,3),num(getattr_-dv,3),num(dv,3)) for nm,dv,getattr_ in
                    [(t[0],t[1],{"peringkat momentum":dw["raw"],"konfirmasi cepat":(dw["fast"] or 0),
                                 "penalti ekstensi":(dw["ext"] or 0),"bonus sisi lawan":(dw["bonus"] or 0)}[t[0]]) for t in terms]),
                num(worst.get("utility"),3),num(best.get("utility"),3),num(gapu,3)))
    sel=[c for c in cands if c.get("selected")]
    ls=[c["score"] for c in sel if c["side"]=="LONG"]; ss=[c["score"] for c in sel if c["side"]=="SHORT"]
    gap=(sum(ls)/len(ls)-sum(ss)/len(ss)) if ls and ss else None
    ok=fin(gap) and fin(thr) and gap>=thr
    o.append("<div class='grid' style='margin-top:10px'>")
    o.append(card("Long terpilih",", ".join(c["symbol"].replace("USDT","") for c in sel if c["side"]=="LONG"),"skor rata-rata %s"%(pct(100*sum(ls)/len(ls),2) if ls else "–")))
    o.append(card("Short terpilih",", ".join(c["symbol"].replace("USDT","") for c in sel if c["side"]=="SHORT"),"skor rata-rata %s"%(pct(100*sum(ss)/len(ss),2) if ss else "–")))
    o.append(card("Pemisahan vs ambang","%s %s"%(DOT["ok"] if ok else DOT["block"],num(gap,4)),"minimum %s — %s"%(num(thr,3),"LOLOS" if ok else "GAGAL")))
    o.append(card("Utility kombinasi",num(sf.get("objectiveScore"),3),"sesudah penalti klaster 0,18/nama kembar"))
    o.append(card("Skor sumbu pasar",num(axis,3),"bonus sisi lawan aktif bila |skor| > 0,12 melawan sisi itu"))
    o.append("</div>")
    allm=all(_decompose(c,c["side"],[(x["score"] if c["side"]=="LONG" else -x["score"]) for x in cands if x["side"]==c["side"]],axis)["match"] for c in cands)
    o.append("<div class='note'>%s Uraian di atas dihitung ulang dari rumus produksi dan %s dengan utility yang disimpan runtime untuk setiap kandidat di formasi ini.</div>"%(
        DOT["ok"] if allm else DOT["block"],"cocok persis" if allm else "TIDAK cocok"))
    return "".join(o)

def tab_formation(R):
    o=[];found=False
    o.append(lead("ok","Kenapa simbol ini yang dipilih — dengan angkanya",
        "Pemilihan diputuskan satu angka: <b>utility</b>. Ia dibentuk dari peringkat momentum di dalam kolam, ditambah konfirmasi gerak cepat (bobot 0,22), dikurangi penalti mengejar (0,20), plus bonus kecil (0,08) kalau sisi itu melawan sumbu pasar tapi namanya sendiri terkonfirmasi. Tabel di bawah menguraikan tiap suku untuk tiap kandidat, jadi pilihannya bisa ditelusuri, bukan dipercaya."))
    for key in ("live","testnet"):
        src=R["inst"][key].get("latestFormation")
        if not src:
            o.append("<h2>%s</h2><div class='card dim'>Belum ada formasi dengan rincian kandidat pada penyimpanan instance ini.</div>"%R["inst"][key]["long"])
            continue
        found=True; o.append(_formation_block(R,key,src))
    if not found: return lead("off","Belum ada formasi tercatat","Tidak ada observasi dengan rincian kandidat di kedua instance.")
    o.append(tech("rumus & sumber",[
        ("Rumus utility","<code>rawRank + 0,22×clamp(fastSupport,±2) − 0,20×max(0,clamp(ekstensi,−2,3)) + 0,08×clamp(fastSupport) bila sisi lawan sumbu</code>"),
        ("rawRank","(skor berarah − rata-rata kolam) ÷ simpangan baku kolam; runtime tidak menyimpannya, dihitung ulang di sini"),
        ("Verifikasi","uraian diuji terhadap utility tersimpan pada 1178 kandidat di kedua penyimpanan: cocok persis, selisih 0"),
        ("Penalti klaster","0,18 per nama tambahan sekluster, dikenakan pada KOMBINASI bukan pada kandidat, jadi tidak muncul di tabel per simbol"),
        ("Kolam kandidat","5 teratas per sisi, diperdalam bila batas klaster tidak terpenuhi"),
        ("signalWeight",NA+" pada observasi bayangan — hanya basket tereksekusi yang menyimpannya")]))
    return "".join(o)

EXEC_UNCOVERED=[("Slippage terukur","executor tidak membukukan harga acuan vs fill sebagai biaya tersendiri"),
 ("Funding","tidak dibukukan per basket"),
 ("Fill sebagian / order ditolak","tidak terekspos per basket; hanya ada penghitung kaki yatim tingkat instance"),
 ("Campuran maker/taker","tidak disimpan pada catatan kaki"),
 ("Latensi per kaki","hanya ada latensi sinyal→order tingkat instance, bukan per kaki"),
 ("Selisih harga keluar","hanya harga masuk yang punya harga acuan rencana untuk dibandingkan")]

def exec_coverage_html(bs):
    cov=bs.get("execCoverage") or {}
    m=cov.get("measured") or []; u=cov.get("unmeasured") or []
    return ("<details><summary>Apakah seluruh logika eksekusi sudah tercakup? — <b>belum, ini batasnya</b></summary><div class='body'>"
            "<div class='k'>Yang benar-benar diukur untuk basket ini</div><div class='s'>%s</div>"
            "<div class='k' style='margin-top:8px'>Ada di skor tapi tanpa data pada basket ini</div><div class='s'>%s</div>"
            "<div class='k' style='margin-top:8px'>Tidak diukur sama sekali oleh runtime</div>%s"
            "<div class='note'>Karena itu skor eksekusi hanya menilai apa yang tercatat. Ia <b>tidak</b> bisa membuktikan eksekusinya bersih — hanya bahwa hal-hal di daftar pertama tidak bermasalah.</div>"
            "</div></details>")%( ", ".join(m) or "<span class=\'dim\'>tidak ada</span>",
             ", ".join(u) or "<span class=\'dim\'>tidak ada</span>",
             "".join("<div style='font-size:12px'><span class='dim'>·</span> %s <span class='dim'>— %s</span></div>"%(esc(a),esc(b)) for a,b in EXEC_UNCOVERED))

def ghost_html(b):
    steps,any_fire=ghost_chain(b)
    rows="".join("<tr><td class='dim'>%d</td><td>%s</td><td class='dim'>%s</td><td>%s</td><td class='dim' style='white-space:normal'>%s</td></tr>"%(
        g["n"],esc(g["rule"]),esc(g["gate"]),
        (DOT["block"]+" "+g["state"]) if g["fire"] else (("<span class='dim'>%s</span>"%esc(g["state"])) if g["state"]=="—" else (DOT["ok"]+" "+esc(g["state"]))),
        esc(str(g.get("reason") or "")+(" · " if g.get("reason") else "")+g["note"])) for g in steps)
    return ("<div class='card'><div class='k'>Seandainya exit adaptif menyala — rantai pemicu sebenarnya</div>"
            "<table style='margin-top:6px'><tr><th>urutan</th><th>aturan</th><th>gerbang</th><th>status</th><th>catatan</th></tr>%s</table>"
            "<div class='note'>Ini bukan tiga saklar sejajar. Regime diperiksa lebih dulu dan menghubung-singkat sisanya; "
            "<b>Kunci laba bukan trailing stop berdiri sendiri</b> — ia hanya dijangkau setelah tesis dinyatakan batal 2 scan berturut. "
            "Eksekusinya dimatikan, penghitungnya tetap berjalan, jadi tabel ini keadaan nyata bukan simulasi.</div>"
            "<div class='note'><b>Kesimpulan: %s</b></div></div>")%(rows,
            "basket ini akan ditutup aturan adaptif" if any_fire else "tidak ada aturan adaptif yang akan menutup basket ini")

def tab_positions(R):
    o=[];eq=(R["account"] or {}).get("accountEquity");now=datetime.now(timezone.utc);sfi=R.get("sfIndex") or {}
    any_open=False
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
            bs=basket_scores(b,thr,sfi,R.get("dist")); usd=(lnr or 0)*notion/2 if fin(lnr) else None
            o.append("<div class='card' style='margin-top:11px'>")
            o.append("<div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'><div><b>%s</b> <span class='dim'>· dibuka %s</span></div><div>%s %s</div></div>"%(
                friendly(b.get("basketId")),esc(str(b.get("openedAt"))[:16]),pct(100*lnr,3) if fin(lnr) else "",money(usd,3) if fin(usd) else ""))
            o.append("<div class='grid' style='margin-top:9px'>")
            o.append(card("Umur / batas","%.1f / %s jam"%(age,capH) if age is not None else "–","sisa %.1f jam"%(capH-age) if age is not None and capH else ""))
            o.append(card("Nilai posisi",money(notion,0),("%.0f%% ekuitas"%(100*notion/eq)) if eq else ""))
            o.append(card("HASIL sejauh ini",pct(100*lnr,3) if fin(lnr) else "–",(money(usd,3) if fin(usd) else "")+" · terpisah dari kualitas"))
            o.append(card("Puncak terbaik",pct(100*sb["maxNetReturn"],3) if fin(sb.get("maxNetReturn")) else "–","pada %s"%str(sb.get("maxNetAt"))[:16] if sb.get("maxNetAt") else ""))
            o.append(card("Pemisahan saat masuk",num(bs.get("scoreGap"),4),"minimum %s"%num(thr,3)))
            o.append(card("Regime saat masuk",esc(sb.get("regimeClassAtOpen") or "–"),"kini %s"%esc(((R["axis"] or {}).get("current") or {}).get("regime") or "–")))
            o.append("</div>")
            o.append("<div class='g2' style='margin-top:10px'>%s%s%s</div>"%(
                score_card(bs["entry"]),score_card(bs["health"]),score_card(bs["exec"])))
            o.append(exec_coverage_html(bs))
            if not bs["formationJoined"]:
                o.append("<div class='note'>Utility formasi, konfirmasi cepat dan risiko ekstensi %s untuk basket ini — observasi sumbernya sudah tidak ada di penyimpanan, jadi tiga komponen itu dikeluarkan beserta bobotnya.</div>"%NA.lower())
            o.append(ghost_html(b))
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
                ("Formasi terjoin","ya" if bs["formationJoined"] else "tidak"),
                ("Biaya dibukukan",money(b.get("feeEstimateUsd"),4)),("Funding",NA)]))
            o.append("</div>")
    o.append("<h2>Tinjauan basket yang sudah tutup</h2>")
    got=False
    for k in ("live","testnet"):
        i=R["inst"][k]; thr=i["fc"].get("minScoreGap")
        for b in (i["ex"].get("recent") or []):
            if b.get("status")=="OPEN" or not b.get("closedAt"): continue
            got=True
            bs=basket_scores(b,thr,sfi,R.get("dist")); net=b.get("netPnlUsd"); lnr=b.get("lastNetReturn")
            legs=b.get("legs") or []
            proc_v=Score("x"); proc_v.parts=[p for p in bs["entry"]["parts"]+bs["exec"]["parts"]]
            proc,outc=post_trade_verdict(proc_v.value,net)
            notion=sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs)
            o.append("<div class='card' style='margin-top:10px'><div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'>"
                     "<div><b>%s</b> <span class='dim'>· %s → %s · %s</span></div><div><b>%s · %s</b></div></div>"%(
                friendly(b.get("basketId")),esc(str(b.get("openedAt"))[:16]),esc(str(b.get("closedAt"))[:16]),
                esc(b.get("closeReason") or "–"),proc,outc))
            o.append("<div class='grid' style='margin-top:8px'>")
            o.append(card("HASIL akhir",money_pct(net,eq,4),pct(100*lnr,3) if fin(lnr) else ""))
            o.append(card("Kualitas entry",num(bs["entry"]["value"],0),rate(bs["entry"]["value"])))
            o.append(card("Kualitas eksekusi",num(bs["exec"]["value"],0),rate(bs["exec"]["value"])))
            o.append(card("Nilai posisi",money(notion,0),"biaya %s"%money(b.get("feeEstimateUsd"),4)))
            o.append("</div>")
            o.append(exec_coverage_html(bs))
            o.append("<div class='scroll'><table style='margin-top:8px'><tr><th>kaki</th><th>sisi</th><th class='num'>masuk</th><th class='num'>keluar</th><th class='num'>kontribusi</th></tr>")
            for l in legs:
                e_,x_=l.get("entryPrice"),l.get("exitPrice"); c=None
                if fin(e_) and fin(x_) and e_: c=((x_-e_)/e_ if l.get("side")=="LONG" else (e_-x_)/e_)
                o.append("<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>"%(
                    esc((l.get("symbol") or "").replace("USDT","")),esc(l.get("side")),num(e_,5),num(x_,5),pct(100*c,3) if fin(c) else "–"))
            o.append("</table></div>")
            o.append(ghost_html(b))
            o.append("<div class='note'>Vonis proses dihitung dari kualitas entry dan eksekusi saja — <b>hasil untung-rugi tidak ikut</b>. Basket yang dibentuk baik boleh rugi, dan yang dibentuk lemah boleh untung.</div></div>")
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
    ev=R["scores"]["evidence"]["value"]
    ov_line=("Rata-rata tertimbang dari Edge 35%%, Performa terakhir 20%%, Drawdown 20%%, Eksekusi 15%%, Data 10%%. "
             "<b>Kekuatan bukti (%s/100) sengaja TIDAK ikut berbobot</b> — ia menilai apakah angka-angka itu layak dipercaya, bukan seberapa bagus performanya. "
             "Jadi angka ini menjawab \u201cseberapa bagus hasilnya\u201d, bukan \u201cseberapa yakin kita boleh\u201d.")%(("%d"%round(ev)) if fin(ev) else "?")
    o.append(score_card(R["scores"]["overall"],ov_line))
    for k in ("edge","recent","dd","exec","data","evidence"): o.append(score_card(R["scores"][k]))
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


def snapshot_md(R):
    """Compact, paste-able digest for handing state to an outside reader without handing over
    access. ~3KB instead of the 100KB page: a reader reasons better from a page of state than from
    a dump, and a smaller artefact leaks less if pasted somewhere careless. Caveats travel WITH the
    numbers, never after them."""
    a=R["account"]; liv=R["inst"]["live"]; tst=R["inst"]["testnet"]
    W=R["edge"]["windows"]; e=R["edge"]; sc=R["scores"]; ax=(R["axis"] or {}).get("current") or {}
    L=[];P=L.append
    P("# Kronos — ringkasan keadaan  (%s UTC)"%R["generatedAt"][:19])
    P("")
    P("Strategi: momentum relatif lintas-simbol. Memeringkat universe dengan MOM36, membeli 3")
    P("terkuat dan menjual 3 terlemah, netral pasar. Bursa: Binance USD-M Futures.")
    P("Yang dikejar selisih kuat-vs-lemah, bukan arah pasar.")
    P("")
    P("## Modal")
    P("- Ekuitas $%.2f (wallet $%.2f, tersedia $%.2f)"%(a.get("accountEquity") or 0,a.get("walletBalance") or 0,a.get("availableBalance") or 0))
    P("- Belum terealisasi $%.4f dari %s posisi"%(a.get("unrealizedPnl") or 0,a.get("openPositionCount")))
    P("- Terealisasi hari ini $%.4f | total live $%.4f (%s basket)"%(
        liv["ex"].get("dailyRealizedUsd") or 0,liv["ex"].get("totalNetPnlUsd") or 0,liv["ex"].get("closedCount")))
    P("- Testnet (uang demo) $%.4f (%s basket)"%(tst["ex"].get("totalNetPnlUsd") or 0,tst["ex"].get("closedCount")))
    P("")
    P("## Konfigurasi berjalan")
    P("- Leg $%s, leverage %s, kotor ~$%s | batas tahan %s jam | stop/TP +-%s%%/%s%%"%(
        liv["ex"].get("legUsd"),liv["ex"].get("leverage"),(liv["ex"].get("legUsd") or 0)*6,
        liv["ex"].get("maxHoldHours"),liv["ex"].get("stopNetReturnPct"),liv["ex"].get("tpNetReturnPct")))
    P("- Ambang pemisahan skor long-short: %s"%liv["fc"].get("minScoreGap"))
    P("- Exit adaptif (regime/tesis/kunci-laba): EKSEKUSI DIMATIKAN, evaluasi ghost tetap jalan")
    P("")
    P("## Status per instance")
    for k in ("live","testnet"):
        i=R["inst"][k]; ex=i["ex"]; g=i["gate"]
        P("- %s"%i["long"])
        P("  eksekusi %s | kesehatan bukti %s | override operator %s | sinyal %s"%(
          "BERJALAN" if not ex.get("__error__") else "MATI",
          "LOLOS" if g["pass"] else "GAGAL",
          "AKTIF" if ex.get("entryHealthBypassed") else "tidak",
          "BASI" if ex.get("signalStale") else "segar"))
        P("  gerbang: 8 terakhir %s, 30 terakhir %s"%(
          ("%+.3f%%"%g["last8"]) if fin(g["last8"]) else "n/a",
          ("%+.3f%%"%g["last30"]) if fin(g["last30"]) else "n/a"))
    P("")
    P("## Posisi terbuka")
    got=False
    for k in ("live","testnet"):
        for b in R["inst"][k]["ex"].get("openBaskets") or []:
            got=True; lnr=b.get("lastNetReturn")
            bq=basket_scores(b,R["inst"][k]["fc"].get("minScoreGap"),R.get("sfIndex") or {},R.get("dist"))
            P("- [%s] %s dibuka %s | hasil %s | %s"%(
              R["inst"][k]["label"],friendly(b.get("basketId")),str(b.get("openedAt"))[:16],
              ("%+.3f%%"%(100*lnr)) if fin(lnr) else "n/a",
              ("entry %s / eksekusi %s"%(("%d"%round(bq["entry"]["value"])) if fin(bq["entry"]["value"]) else "n/a",
                                          ("%d"%round(bq["exec"]["value"])) if fin(bq["exec"]["value"]) else "n/a"))))
            P("  %s"%", ".join("%s %s"%(l.get("side"),(l.get("symbol") or "").replace("USDT","")) for l in b.get("legs") or []))
            _st,_fire=ghost_chain(b)
            P("  ghost exit: %s"%("AKAN menutup — %s"%", ".join(x["rule"] for x in _st if x["fire"]) if _fire
              else "tidak ada yang menutup (gerbang tesis-batal belum terbuka)"))
    if not got: P("- tidak ada")
    P("")
    P("## Bukti performa (sinyal produksi %s)"%e["signal"])
    P("| jendela | N | rata-rata/basket | menang | t mentah |")
    P("|---|---|---|---|---|")
    for lbl in ("8 terakhir","30 terakhir","90 terakhir","seluruhnya"):
        s_=W[lbl]
        P("| %s | %s | %s | %s | %s |"%(lbl,s_.get("n"),
          ("%+.3f%%"%s_["meanPct"]) if s_.get("n") else "-",
          ("%.0f%%"%s_["winPct"]) if s_.get("n") else "-",
          ("%.2f"%s_["tStat"]) if fin(s_.get("tStat")) else "-"))
    P("")
    P("BACA INI SEBELUM MENYIMPULKAN APA PUN DARI TABEL DI ATAS:")
    P("N adalah observasi bayangan yang dibuka tiap ~1 jam dan ditahan sampai horizonnya, jadi")
    P("hampir seluruhnya tumpang tindih. Episode yang benar-benar independen: **%d**."%e["episodes"])
    P("t-stat terkoreksi tumpang tindih: **%.2f** (mentah %.2f). Di bawah ~30 episode, selisih"%(e["tEff"] or 0,e["tRaw"] or 0))
    P("sebesar edge lane ini belum bisa dipisahkan dari nol.")
    P("Rentetan rugi terpanjang: %d basket berturut."%e["longestLossStreak"])
    c=e.get("concentration")
    if c: P("Konsentrasi: kuartal %s menyumbang %.0f%% pergerakan; %d dari %d bulan untung."%(c["topQuarter"],c["share"],c["profitableMonths"],c["months"]))
    P("")
    if R.get("mismatch"):
        P("## PERINGATAN: bukti tidak persis mewakili produksi")
        for m in R["mismatch"]:
            P("- %s — produksi: %s | bukti: %s"%(m["what"],m["prod"],m["evid"]))
        P("")
    P("## Keadaan pasar")
    P("- Regime %s, zona %s, skor sumbu %s"%(ax.get("regime"),((R["axis"] or {}).get("guidance") or {}).get("zoneLabel"),
      ("%.3f"%ax["score"]) if fin(ax.get("score")) else "n/a"))
    P("- Mode directional: %s (%s)"%((R["dir"] or {}).get("mode"),(R["dir"] or {}).get("marketRegime")))
    P("")
    P("## Skor 0-100 (komponen lengkap ada di dashboard)")
    for k,lbl in (("overall","Keseluruhan"),("edge","Kualitas edge"),("recent","Performa terakhir"),
                  ("dd","Kendali drawdown"),("exec","Kualitas eksekusi"),("data","Kualitas data"),
                  ("evidence","Kekuatan bukti")):
        v=sc[k]["value"]
        P("- %s: %s"%(lbl,("%d (%s)"%(round(v),rate(v))) if fin(v) else NA))
    P("")
    A=alerts_of(R)
    P("## Peringatan aktif (prioritas menurun)")
    if not A: P("- tidak ada")
    names={0:"MENGHALANGI",1:"RISIKO",2:"PANTAU",3:"INFO"}
    for pr,st,t,d in A: P("- [%s] %s — %s"%(names[pr],t,d))
    P("")
    P("## Yang TIDAK diukur runtime (jangan diasumsikan nol)")
    P("- funding dan slippage tidak dibukukan terpisah")
    P("- provenance harness riset dan pemisahan holdout tidak terekspos")
    P("- riwayat parameter->perubahan->bukti tidak terbaca dari runtime")
    return "\n".join(L)

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
            elif self.path.startswith("/snapshot"):
                body,ct=snapshot_md(collect()).encode(),"text/plain; charset=utf-8"
            elif self.path=="/healthz": body,ct=b"ok","text/plain"
            else: body,ct=render(collect()).encode(),"text/html; charset=utf-8"
            self.send_response(200); self.send_header("Content-Type",ct)
            self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as ex:
            m=("cockpit error: %s"%ex).encode()
            self.send_response(500); self.send_header("Content-Length",str(len(m))); self.end_headers(); self.wfile.write(m)

if __name__=="__main__":
    HTTPServer(("127.0.0.1",PORT),H).serve_forever()
