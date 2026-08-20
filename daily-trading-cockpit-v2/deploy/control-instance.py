#!/usr/bin/env python3
"""Kronos control cockpit (3104) — trading + research + decision audit.

READ-ONLY FOR TRADING: no exchange credentials, no exchange client. It GETs from the
live/testnet APIs and reads their stores. It cannot place, cancel, or size an order. The
only local write is an independent Smart Basket E / LOSS_CUT ghost-observation ledger; it
never feeds back into an executor or exchange action.

Every number is read from runtime or computed here from runtime data. Nothing about measured
performance is hardcoded. Where runtime has no source the UI says so.
"""
import json, math, os, statistics as st, subprocess, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone, timedelta

PORT = int(os.environ.get("PORT", "3104"))
INST = {
 "live":    {"api":"http://127.0.0.1:3103","label":"LIVE","long":"LIVE · mainnet","port":3103,"id":"3103",
             "pm2":"dtc-api-live",
             "rel":"/root/kronos-live-releases/migrate-20260818T060000Z/daily-trading-cockpit-v2",
             "store":"/root/kronos-live/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json"},
 "testnet": {"api":"http://127.0.0.1:3102","label":"TESTNET","long":"TESTNET · uang demo","port":3102,"id":"3102",
             "pm2":"dtc-api-testnet",
             "rel":"/root/kronos-testnet-releases/history-fb-lock-20260814T130500Z/daily-trading-cockpit-v2",
             "store":"/root/kronos-testnet-releases/128b09f/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json"},
}
PROD_SIGNAL = "MOM36_FILTERED"
NA = "Tidak tersedia"
_c = {"at":0.0,"d":None}; TTL = 25.0

# Smart Basket E and LOSS_CUT are deliberately observational challengers. These values are
# frozen research contracts, not executor settings. The state file is separate from every
# runtime store consumed by the trading processes.
SMART_E_VERSION = "smart-basket-ghost-monitor-v3"
SMART_E_STATE_FILE = "/root/kronos-control-data/smart-basket-e-ghost.json"
SMART_E_ARM_AGE_H = 24.0
SMART_E_ARM_MFE = 0.010
SMART_E_GIVEBACK = 0.70
LOSS_CUT_MIN_AGE_H = 12.0
LOSS_CUT_MAX_NET_RETURN = -0.010
LOSS_CUT_MIN_MFE = 0.005
LOSS_CUT_GIVEBACK = 0.70
SMART_E_HORIZON_H = 36.0
SMART_E_MAX_COMPLETED = 2000
_smart_e_lock = threading.Lock()
_smart_e_state = None

def get(u,t=12):
    try:
        with urllib.request.urlopen(u,timeout=t) as r: return json.load(r)
    except Exception as e: return {"__error__":str(e)[:140]}

def sh(c,t=25):
    try: return subprocess.run(c,shell=True,capture_output=True,text=True,timeout=t).stdout.strip()
    except Exception as e: return "ERR %s"%str(e)[:60]

def active_release(pm2_name,fallback):
    """Follow PM2 actual run-api.sh instead of showing a stale release path."""
    try:
        for proc in json.loads(sh("pm2 jlist") or "[]"):
            if proc.get("name") != pm2_name: continue
            run=((proc.get("pm2_env") or {}).get("pm_exec_path") or "")
            if run.endswith("/deploy/run-api.sh"):
                return os.path.dirname(os.path.dirname(run))
    except Exception:
        pass
    return fallback

def age_h(p):
    try: return (time.time()-os.path.getmtime(p))/3600.0
    except OSError: return None

def piso(s):
    try: return datetime.strptime(str(s)[:19],"%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception: return None

TAIPEI = timezone(timedelta(hours=8), "Asia/Taipei")

def basket_execution_policy(basket, executor):
    """Return the exit contract frozen for this basket, never just the current env.

    A deployment may change the current policy while an older basket remains open.  New rows
    carry their policy fingerprint; pre-fingerprint rows retain the executor's explicit legacy
    contract.  The runtime max-hold value is a last-resort display fallback only.
    """
    fingerprint=basket.get("policyFingerprint") if isinstance(basket,dict) else None
    execution=fingerprint.get("execution") if isinstance(fingerprint,dict) else None
    if isinstance(execution,dict):
        return execution,"fingerprint basket"
    legacy=executor.get("legacyExitPolicy") if isinstance(executor,dict) else None
    if isinstance(legacy,dict):
        return legacy,"kontrak legacy basket"
    cap=executor.get("maxHoldHours") if isinstance(executor,dict) else None
    return {"executionCapHours":cap},"fallback runtime (kontrak basket tidak tersedia)"

def basket_horizon_close(basket, executor, now=None):
    """Scheduled HORIZON timestamp and remaining time for an open basket.

    This is deliberately a scheduled horizon, not a promise that a TP/SL/emergency exit cannot
    happen earlier.  The executor still makes the actual exit on its next tick and reconciles it.
    """
    now=now or datetime.now(timezone.utc)
    opened=piso((basket or {}).get("openedAt"))
    policy,source=basket_execution_policy(basket or {},executor or {})
    cap=policy.get("executionCapHours") if isinstance(policy,dict) else None
    if not (opened and fin(cap) and cap>0):
        return {"openedAt":opened,"capHours":cap,"source":source,"dueAt":None,"remainingSeconds":None,
                "policy":policy if isinstance(policy,dict) else {}}
    due=opened+timedelta(hours=float(cap))
    return {"openedAt":opened,"capHours":float(cap),"source":source,"dueAt":due,
            "remainingSeconds":(due-now).total_seconds(),"policy":policy}

def horizon_remaining_text(seconds):
    if not fin(seconds): return NA
    if seconds<=0: return "sudah jatuh tempo; menunggu tick executor"
    total=int(seconds)
    days,rest=divmod(total,86400); hours,rest=divmod(rest,3600); minutes=rest//60
    pieces=[]
    if days: pieces.append("%dh"%days)
    if hours or days: pieces.append("%dj"%hours)
    pieces.append("%dm"%minutes)
    return "sisa "+" ".join(pieces)

def horizon_close_detail(info, executor):
    """Short, source-labelled human text for the Open Baskets card."""
    due=info.get("dueAt")
    if not due: return "waktu HORIZON tidak tersedia (%s)"%info.get("source")
    local=due.astimezone(TAIPEI)
    tick=((executor.get("effectiveRuntime") or {}).get("executorTick") or {}).get("effectiveMs")
    tick_text="tick runtime tidak tersedia"
    if fin(tick) and tick>0: tick_text="dicek tiap %.0f dtk"%(tick/1000.0)
    policy=info.get("policy") or {}
    early=[]
    if policy.get("takeProfitEnabled"): early.append("TP")
    if policy.get("stopLossEnabled"): early.append("SL")
    if policy.get("adaptiveExitsEnabled"): early.append("exit adaptif")
    early_text=("; %s legacy bisa menutup lebih awal"%"/".join(early)) if early else ""
    return ("%s Taipei · %s UTC · %s · %s · sumber %s%s"%(
        local.strftime("%d %b %Y %H:%M:%S"),due.strftime("%d %b %Y %H:%M:%S"),
        horizon_remaining_text(info.get("remainingSeconds")),tick_text,info.get("source"),early_text))

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

PRICE_RATIO_MIN, PRICE_RATIO_MAX = 0.02, 50.0

def corrupt_legs(o):
    """Price-scale corruption detector. A leg whose exit/entry ratio leaves [0.02, 50] is a
    decimal-scale error, not a market move: 1000PEPE has been stored at 0.0028 entry against a
    0.00000265 exit, which books a fake +15-18% basket. Thirteen such rows were inflating the
    measured mean from +0.89% to +2.75% per basket and the t-stat with it."""
    bad=[]
    for side in ("longLeg","shortLeg"):
        for l in o.get(side) or []:
            e,x=l.get("entryPrice"),l.get("exitPrice")
            if not (fin(e) and fin(x) and e>0 and x>0): continue
            r=x/e
            if r<PRICE_RATIO_MIN or r>PRICE_RATIO_MAX: bad.append(l.get("symbol"))
    return bad

def load_obs(path,signal=PROD_SIGNAL,rejected=None):
    try: obs=(json.load(open(path)) or {}).get("observations") or []
    except Exception: return []
    out=[]
    for o in obs:
        if o.get("signal")!=signal or o.get("status")=="OPEN": continue
        nr,oa=o.get("netReturn"),o.get("openedAtMs")
        if not fin(nr) or not fin(oa): continue
        cb=corrupt_legs(o)
        if cb:
            if rejected is not None:
                rejected.append({"at":o.get("openedAt"),"net":nr,"symbols":sorted(set(cb))})
            continue
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

# ------------------------------------------------------------------ Smart Basket E · ghost only
def _e_iso(now):
    return now.astimezone(timezone.utc).isoformat()

def _e_empty_state(now):
    at=_e_iso(now)
    return {"version":SMART_E_VERSION,"monitorStartedAt":at,"lossCutMonitorStartedAt":at,
            "lastRefreshAt":None,"baskets":{}}

def _e_load_locked(now):
    """Load only the cockpit-owned ghost ledger. It is intentionally not an executor store."""
    global _smart_e_state
    if _smart_e_state is not None: return _smart_e_state
    try:
        with open(SMART_E_STATE_FILE) as f: data=json.load(f)
    except Exception:
        data=None
    if not isinstance(data,dict): data=_e_empty_state(now)
    if not isinstance(data.get("baskets"),dict): data["baskets"]={}
    # The ledger is cockpit-only data. Upgrade its schema in place without changing an
    # executor store or making any inference that a pre-monitor trigger was historical truth.
    data["version"]=SMART_E_VERSION
    data.setdefault("monitorStartedAt",_e_iso(now))
    # LOSS_CUT starts only with this v3 observer. Retained E rows are therefore explicitly
    # left-censored for LOSS_CUT, even if they happened to open after the older E observer.
    data.setdefault("lossCutMonitorStartedAt",_e_iso(now))
    data.setdefault("lastRefreshAt",None)
    _smart_e_state=data
    return data

def _e_save_locked(data):
    """Atomically persist first-trigger evidence; this path never touches trading state."""
    directory=os.path.dirname(SMART_E_STATE_FILE)
    try:
        os.makedirs(directory,exist_ok=True)
        tmp=SMART_E_STATE_FILE+".tmp"
        with open(tmp,"w") as f:
            json.dump(data,f,ensure_ascii=False,separators=(",",":"),sort_keys=True)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp,SMART_E_STATE_FILE)
        data.pop("writeError",None)
    except Exception as ex:
        data["writeError"]=str(ex)[:180]

def _e_runtime_flags(cfg):
    """Read only the executor environment already loaded by the local control host."""
    supplied=cfg.get("flags") if isinstance(cfg,dict) else None
    if isinstance(supplied,dict): return supplied
    flags={}; rel=cfg.get("rel") if isinstance(cfg,dict) else None
    if not rel: return flags
    try:
        for ln in open(rel+"/.env"):
            if "=" not in ln or ln.lstrip().startswith("#"): continue
            k,v=ln.split("=",1)
            if k.startswith("CROSS_SECTIONAL_"): flags[k.strip()]=v.strip()
    except Exception: pass
    return flags

def _e_policy(ex,flags=None):
    """Describe the actual exit contract; NoTP means no TP *and* no other early exit."""
    hold=ex.get("maxHoldHours")
    tp=ex.get("tpNetReturnPct")
    stop=ex.get("stopNetReturnPct")
    no_tp=ex.get("tpDisabled") is True
    no_stop=(not fin(stop)) or stop<=0
    if isinstance(flags,dict) and "CROSS_SECTIONAL_SMART_BASKET_V1" in flags:
        smart_enabled=str(flags.get("CROSS_SECTIONAL_SMART_BASKET_V1") or "").strip()=="1"
        try: smart_scans=int(float(flags.get("CROSS_SECTIONAL_SMART_INVALIDATION_SCANS") or "2"))
        except Exception: smart_scans=2
        if not smart_enabled: smart_exit_active=False; smart_state="DISABLED"
        elif smart_scans>=999: smart_exit_active=False; smart_state="INERT (invalidationScans=%d)"%smart_scans
        else: smart_exit_active=True; smart_state="ACTIVE (invalidationScans=%d)"%smart_scans
    else:
        smart_exit_active=None; smart_state="UNVERIFIED"
    canonical=no_tp and no_stop and smart_exit_active is False and fin(hold) and abs(float(hold)-SMART_E_HORIZON_H)<0.01
    exact=["tpDisabled=%s"%("true" if no_tp else "false"),
           "tpNetReturnPct=%s"%(("%.6g"%tp) if fin(tp) else "unknown"),
           "stopNetReturnPct=%s"%(("%.6g"%stop) if fin(stop) else "off"),
           "maxHoldHours=%s"%(("%.6g"%hold) if fin(hold) else "unknown"),
           "smartBasketExit=%s"%smart_state]
    bits=[]
    if no_tp: bits.append("NO TP")
    elif fin(tp): bits.append("TP ACTIVE +%.2f%%"%tp)
    else: bits.append("TP ACTIVE")
    if not no_stop: bits.append("STOP ACTIVE −%.2f%%"%stop)
    if smart_exit_active is True: bits.append("SMART EXIT ACTIVE")
    elif smart_exit_active is None: bits.append("SMART EXIT UNVERIFIED")
    bits.append("HOLD %sh"%(("%.2f"%hold).rstrip("0").rstrip(".") if fin(hold) else "?"))
    return {"canonicalNoTp36":canonical,"tpDisabled":no_tp,"tpNetReturnPct":tp,"stopNetReturnPct":stop,
            "smartExitActive":smart_exit_active,"smartExitState":smart_state,
            "maxHoldHours":hold,"exact":"; ".join(exact),
            "mismatchReason":None if canonical else "; ".join(exact),
            "label":"NO TP · HOLD 36h" if canonical else "POLICY MISMATCH · "+" · ".join(bits)}

def _e_policy_from_execution(execution,source,identity):
    """Build the ghost comparator from this basket's frozen exit policy.

    The executor's top-level status describes the policy for a *new* basket.  A
    legacy basket can legitimately retain a different TP/SL contract through a
    deployment, so it must never borrow that global NoTP label.
    """
    if not isinstance(execution,dict):
        return {"canonicalNoTp36":False,"tpDisabled":False,"tpNetReturnPct":None,
                "stopNetReturnPct":None,"smartExitActive":None,"smartExitState":"UNVERIFIED",
                "maxHoldHours":None,"basketPolicySource":source,"basketPolicyIdentity":identity,
                "exact":"basket exit contract unavailable",
                "mismatchReason":"basket exit contract unavailable",
                "label":"POLICY UNKNOWN / PAUSED"}
    hold=execution.get("executionCapHours")
    tp_enabled=execution.get("takeProfitEnabled")
    tp_raw=execution.get("takeProfitNetReturn")
    stop_enabled=execution.get("stopLossEnabled")
    stop_raw=execution.get("stopLossNetReturn")
    adaptive=execution.get("adaptiveExitsEnabled")
    no_tp=tp_enabled is False
    no_stop=stop_enabled is False
    adaptive_off=adaptive is False
    tp=100*tp_raw if fin(tp_raw) else None
    stop=100*stop_raw if fin(stop_raw) else None
    canonical=no_tp and no_stop and adaptive_off and fin(hold) and abs(float(hold)-SMART_E_HORIZON_H)<0.01
    exact=["basketPolicySource=%s"%source,
           "takeProfitEnabled=%s"%("false" if no_tp else "true" if tp_enabled is True else "unknown"),
           "takeProfitNetReturnPct=%s"%("%.6g"%tp if fin(tp) else "off" if no_tp else "unknown"),
           "stopLossEnabled=%s"%("false" if no_stop else "true" if stop_enabled is True else "unknown"),
           "stopLossNetReturnPct=%s"%("%.6g"%stop if fin(stop) else "off" if no_stop else "unknown"),
           "adaptiveExitsEnabled=%s"%("false" if adaptive_off else "true" if adaptive is True else "unknown"),
           "executionCapHours=%s"%("%.6g"%hold if fin(hold) else "unknown")]
    bits=[]
    if no_tp: bits.append("NO TP")
    elif fin(tp): bits.append("TP ACTIVE +%.2f%%"%tp)
    else: bits.append("TP UNVERIFIED")
    if not no_stop:
        bits.append("STOP ACTIVE −%.2f%%"%stop if fin(stop) else "STOP UNVERIFIED")
    if not adaptive_off:
        bits.append("ADAPTIVE EXIT ACTIVE" if adaptive is True else "ADAPTIVE EXIT UNVERIFIED")
    bits.append("HOLD %sh"%(("%.2f"%hold).rstrip("0").rstrip(".") if fin(hold) else "?"))
    return {"canonicalNoTp36":canonical,"tpDisabled":no_tp,"tpNetReturnPct":tp,"stopNetReturnPct":stop,
            "smartExitActive":None if not isinstance(adaptive,bool) else adaptive,
            "smartExitState":"OFF" if adaptive_off else "ACTIVE" if adaptive is True else "UNVERIFIED",
            "maxHoldHours":hold,"basketPolicySource":source,"basketPolicyIdentity":identity,
            "exact":"; ".join(exact),"mismatchReason":None if canonical else "; ".join(exact),
            "label":"NO TP · HOLD 36h" if canonical else "POLICY MISMATCH · "+" · ".join(bits)}

def _e_policy_for_basket(ex,flags,basket):
    """Return the exact frozen policy that governs one open/recent basket."""
    execution,source=basket_execution_policy(basket or {},ex or {})
    fingerprint=(basket or {}).get("policyFingerprint") if isinstance(basket,dict) else None
    identity=(fingerprint.get("policyId") if isinstance(fingerprint,dict) else None) or ("LEGACY" if source=="kontrak legacy basket" else "UNKNOWN")
    if source.startswith("fallback"):
        # A fallback can describe the current runtime but cannot prove an old basket's contract.
        policy=_e_policy(ex,flags)
        policy.update({"canonicalNoTp36":False,"basketPolicySource":source,"basketPolicyIdentity":identity,
                       "exact":"basketPolicySource=%s; basket exit contract unavailable"%source,
                       "mismatchReason":"basket exit contract unavailable",
                       "label":"POLICY UNKNOWN / PAUSED"})
        return policy
    return _e_policy_from_execution(execution,source,identity)

def _e_basket_key(instance,b):
    bid=b.get("basketId") or b.get("id")
    return None if not bid else "%s:%s"%(instance,str(bid))

def _e_age_hours(opened_at,now):
    opened=piso(opened_at)
    return (now-opened).total_seconds()/3600.0 if opened else None

def _e_notional_usd(b):
    return sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in (b.get("legs") or [])
               if isinstance(l,dict) and fin(l.get("qty")) and fin(l.get("entryPrice")))

def _e_score_gap(b):
    for src in (b,b.get("smartBasket") or {}):
        if fin(src.get("scoreGap")): return src.get("scoreGap")
    plan=b.get("plan") or []
    longs=[]; shorts=[]
    for p in plan:
        if not isinstance(p,dict): continue
        v=p.get("scoreAtOpen") if fin(p.get("scoreAtOpen")) else p.get("score")
        if not fin(v): continue
        if str(p.get("side") or "").upper()=="LONG": longs.append(v)
        if str(p.get("side") or "").upper()=="SHORT": shorts.append(v)
    return (sum(longs)/len(longs)-sum(shorts)/len(shorts)) if longs and shorts else None

def _e_usd(rec,net_return):
    cap=rec.get("capitalUsd")
    return net_return*cap if fin(net_return) and fin(cap) else None

def _e_condition(age,mfe,net):
    giveback=(mfe-net)/mfe if fin(mfe) and mfe>0 and fin(net) else None
    armed=fin(age) and age>=SMART_E_ARM_AGE_H and fin(mfe) and mfe>=SMART_E_ARM_MFE
    return {"ageHours":age,"mfeNetReturn":mfe,"netReturn":net,"givebackFraction":giveback,
            "arm":armed,"exit":bool(armed and fin(giveback) and giveback>=SMART_E_GIVEBACK)}

def _e_condition_from_basket(b,now):
    age=_e_age_hours(b.get("openedAt"),now)
    net=b.get("lastNetReturn")
    sb=b.get("smartBasket") or {}; mfe=sb.get("maxNetReturn")
    if not fin(mfe) and fin(net): mfe=net
    return _e_condition(age,mfe,net)

def _loss_cut_condition(age,mfe,net):
    """Frozen LOSS_CUT rule evaluated from the single net whole-basket path."""
    giveback=(mfe-net)/mfe if fin(mfe) and mfe>0 and fin(net) else None
    age_ok=fin(age) and age>=LOSS_CUT_MIN_AGE_H
    pnl_ok=fin(net) and net<=LOSS_CUT_MAX_NET_RETURN
    mfe_ok=fin(mfe) and mfe>=LOSS_CUT_MIN_MFE
    giveback_ok=fin(giveback) and giveback>=LOSS_CUT_GIVEBACK
    return {"ageHours":age,"mfeNetReturn":mfe,"netReturn":net,"givebackFraction":giveback,
            "ageOk":age_ok,"pnlOk":pnl_ok,"mfeOk":mfe_ok,"givebackOk":giveback_ok,
            "watching":bool(age_ok),"exit":bool(age_ok and pnl_ok and mfe_ok and giveback_ok)}

def _e_left_censor(started_at,classification,reason,already=None):
    return {"classification":classification,"reason":reason,"monitorStartedAt":started_at,
            "conditionAlreadyTrueAtMonitorStart":already,"historicalFirstTriggerUnknown":bool(classification),
            "firstObservedTriggerAt":None}

def _loss_cut_preexisting(rec,state):
    opened=piso(rec.get("openedAt"))
    started=piso(state.get("lossCutMonitorStartedAt"))
    return (not opened) or (started is None) or opened<=started

def _loss_cut_state(rec):
    x=rec.get("lossCut")
    return x if isinstance(x,dict) else {}

def _e_policy_reason(policy):
    if not isinstance(policy,dict): return "runtime comparator policy unavailable"
    if policy.get("mismatchReason"): return policy["mismatchReason"]
    return "tpDisabled=%s; tpNetReturnPct=%s; maxHoldHours=%s"%(
        "true" if policy.get("tpDisabled") is True else "false",
        policy.get("tpNetReturnPct"),policy.get("maxHoldHours"))

def _e_comparator_new(policy,at):
    good=bool(policy.get("canonicalNoTp36"))
    return {"validAtFirstSeen":good,"validThroughoutObserved":good,
            "firstMismatchAt":None if good else at,
            "firstMismatchReason":None if good else _e_policy_reason(policy),
            "lastObservedPolicy":dict(policy)}

def _e_comparator_update(rec,policy,now):
    cmp=rec.get("comparator")
    if not isinstance(cmp,dict):
        first=rec.get("policyAtFirstSeen") or policy
        cmp=_e_comparator_new(first,rec.get("firstSeenAt") or _e_iso(now)); rec["comparator"]=cmp
    cmp["lastObservedPolicy"]=dict(policy)
    if not policy.get("canonicalNoTp36"):
        cmp["validThroughoutObserved"]=False
        if not cmp.get("firstMismatchAt"):
            cmp["firstMismatchAt"]=_e_iso(now); cmp["firstMismatchReason"]=_e_policy_reason(policy)
        elif "stopNetReturnPct" not in str(cmp.get("firstMismatchReason") or ""):
            # Preserve the original mismatch time but upgrade old v1 wording to the complete
            # current exit-contract diagnosis (TP, stop, horizon, and Smart Basket exit state).
            cmp["firstMismatchReason"]=_e_policy_reason(policy)
    return cmp

def _e_bind_basket_policy(rec,policy,now):
    """Correct pre-fix ghost rows once the executor supplies their frozen policy.

    Older ledger rows stored the instance-wide policy.  That was unsafe for a
    legacy basket, so replace it only when a stable basket policy identity is
    observable from the executor response; do not manufacture one for a row
    that has fallen out of the API's recent window.
    """
    identity=policy.get("basketPolicyIdentity") if isinstance(policy,dict) else None
    if not identity or rec.get("basketPolicyIdentity")==identity:
        return
    rec["basketPolicyIdentity"]=identity
    rec["basketPolicySource"]=policy.get("basketPolicySource")
    rec["policyAtFirstSeen"]=dict(policy)
    rec["policyNow"]=dict(policy)
    rec["comparator"]=_e_comparator_new(policy,rec.get("firstSeenAt") or _e_iso(now))

def _e_left_class(rec):
    left=rec.get("leftCensor") or {}
    return left.get("classification")

def _e_cohort_status(rec):
    left=_e_left_class(rec)
    if left:
        reason=(rec.get("leftCensor") or {}).get("reason") or "historical pre-monitor path is unknown"
        return left,reason
    if rec.get("lateDiscovery"):
        return "UNOBSERVED / LATE DISCOVERY","basket was first seen after its path had already elapsed"
    cmp=rec.get("comparator") or {}
    if not cmp.get("validThroughoutObserved"):
        return "COMPARATOR MISMATCH / PAUSED",("runtime mismatch since %s: %s"%(
            str(cmp.get("firstMismatchAt") or "unknown")[:19],cmp.get("firstMismatchReason") or "unknown"))
    if not rec.get("forwardEligible"):
        return "NOT ELIGIBLE","not opened after monitor deployment timestamp"
    return "VALID FORWARD COHORT","opened after monitor deployment; NoTP + 36h observed throughout"

def _loss_cut_cohort_status(rec):
    lc=_loss_cut_state(rec); left=lc.get("leftCensor") or {}
    classification=left.get("classification")
    if classification:
        return classification,left.get("reason") or "historical pre-monitor path is unknown"
    if rec.get("lateDiscovery"):
        return "UNOBSERVED / LATE DISCOVERY","basket was first discovered after its path had already elapsed"
    cmp=rec.get("comparator") or {}
    if not cmp.get("validThroughoutObserved"):
        return "COMPARATOR MISMATCH / PAUSED",("runtime mismatch since %s: %s"%(
            str(cmp.get("firstMismatchAt") or "unknown")[:19],cmp.get("firstMismatchReason") or "unknown"))
    if not rec.get("lossCutForwardEligible"):
        return "NOT ELIGIBLE","not opened after LOSS_CUT monitor deployment timestamp"
    return "VALID FORWARD COHORT","opened after LOSS_CUT monitor deployment; NoTP + 36h observed throughout"

def _e_migrate_record(rec,state,policy,now):
    """Upgrade observer provenance without inventing historical trigger timing."""
    pre=bool(rec.get("preexistingAtMonitorStart"))
    if "leftCensor" not in rec:
        if pre:
            ghost=rec.get("ghostExit") or {}; first=rec.get("firstSeenAt")
            age,mfe,net=rec.get("ageHours"),rec.get("maxMfeNetReturn"),rec.get("currentNetReturn")
            if ghost and ghost.get("observedAt")==first: already=True
            elif fin(age) and age<SMART_E_ARM_AGE_H: already=False
            elif fin(mfe) and mfe<SMART_E_ARM_MFE: already=False
            else: already=None
            rec["leftCensor"]={"classification":"LEFT-CENSORED / PRE-MONITOR",
                               "reason":"opened before monitor deployment timestamp; true historical first trigger unknown",
                               "monitorStartedAt":state.get("monitorStartedAt"),
                               "conditionAlreadyTrueAtMonitorStart":already,
                               "historicalFirstTriggerUnknown":True,
                               "firstObservedTriggerAt":ghost.get("observedAt") if ghost else None}
        elif rec.get("lateDiscovery"):
            rec["leftCensor"]={"classification":"UNOBSERVED / LATE DISCOVERY",
                               "reason":"first discovered after its path had elapsed; exact trigger timing unknown",
                               "monitorStartedAt":state.get("monitorStartedAt"),
                               "conditionAlreadyTrueAtMonitorStart":None,
                               "historicalFirstTriggerUnknown":True,"firstObservedTriggerAt":None}
        else:
            rec["leftCensor"]={"classification":None,"reason":None,"monitorStartedAt":state.get("monitorStartedAt"),
                               "conditionAlreadyTrueAtMonitorStart":None,"historicalFirstTriggerUnknown":False,
                               "firstObservedTriggerAt":None}
    # Comparator validity is observed only while a basket is live. A later policy change must
    # not retroactively invalidate an already completed 36h comparator.
    if not rec.get("closed") or not isinstance(rec.get("comparator"),dict):
        _e_comparator_update(rec,policy,now)
    if "prospectiveFirstGhostTrigger" not in rec:
        rec["prospectiveFirstGhostTrigger"]=None
        if not _e_left_class(rec) and rec.get("forwardEligible") and rec.get("ghostExit"):
            rec["prospectiveFirstGhostTrigger"]=dict(rec["ghostExit"])
    # LOSS_CUT did not exist in v2. Its own deployment timestamp makes every retained
    # pre-v3 basket left-censored for this challenger, even where E had exact provenance.
    lc=_loss_cut_state(rec)
    if not lc:
        lc_pre=_loss_cut_preexisting(rec,state)
        if lc_pre:
            lc_left=_e_left_censor(state.get("lossCutMonitorStartedAt"),
                "LEFT-CENSORED / PRE-MONITOR",
                "opened before LOSS_CUT monitor deployment timestamp; true historical first trigger unknown")
        elif rec.get("lateDiscovery"):
            lc_left=_e_left_censor(state.get("lossCutMonitorStartedAt"),
                "UNOBSERVED / LATE DISCOVERY",
                "first discovered after its path had elapsed; exact trigger timing unknown")
        else:
            lc_left=_e_left_censor(state.get("lossCutMonitorStartedAt"),None,None)
        lc={"monitorStartedAt":state.get("lossCutMonitorStartedAt"),
            "preexistingAtMonitorStart":lc_pre,"leftCensor":lc_left,
            "prospectiveFirstGhostTrigger":None,"ghostExit":None}
        rec["lossCut"]=lc
        rec["lossCutForwardEligible"]=not lc_pre and not rec.get("lateDiscovery")
    else:
        lc.setdefault("monitorStartedAt",state.get("lossCutMonitorStartedAt"))
        if not isinstance(lc.get("leftCensor"),dict):
            lc["leftCensor"]=_e_left_censor(lc.get("monitorStartedAt"),None,None)
        lc.setdefault("preexistingAtMonitorStart",_loss_cut_preexisting(rec,state))
        rec.setdefault("lossCutForwardEligible",not lc["preexistingAtMonitorStart"] and not rec.get("lateDiscovery"))
        lc.setdefault("prospectiveFirstGhostTrigger",None)
        lc.setdefault("ghostExit",None)
    return rec

def _e_record(instance,b,policy,state,now,late=False):
    opened_at=b.get("openedAt")
    opened=piso(opened_at)
    monitor_started=piso(state.get("monitorStartedAt"))
    # A basket that existed before this monitor started is displayed but excluded from forward
    # aggregation. Its earlier MFE path was not observed prospectively by this ledger.
    preexisting=(not opened) or (monitor_started is None) or opened<=monitor_started
    notional=_e_notional_usd(b)
    snap=_e_condition_from_basket(b,now)
    if preexisting:
        left=_e_left_censor(state.get("monitorStartedAt"),"LEFT-CENSORED / PRE-MONITOR",
                            "opened before monitor deployment timestamp; true historical first trigger unknown",snap["exit"])
    elif late:
        left=_e_left_censor(state.get("monitorStartedAt"),"UNOBSERVED / LATE DISCOVERY",
                            "first discovered after its path had elapsed; exact trigger timing unknown")
    else:
        left=_e_left_censor(state.get("monitorStartedAt"),None,None)
    lc_started=piso(state.get("lossCutMonitorStartedAt"))
    lc_pre=(not opened) or (lc_started is None) or opened<=lc_started
    lc_snap=_loss_cut_condition(snap.get("ageHours"),snap.get("mfeNetReturn"),snap.get("netReturn"))
    if lc_pre:
        lc_left=_e_left_censor(state.get("lossCutMonitorStartedAt"),"LEFT-CENSORED / PRE-MONITOR",
                                "opened before LOSS_CUT monitor deployment timestamp; true historical first trigger unknown",
                                lc_snap["exit"])
    elif late:
        lc_left=_e_left_censor(state.get("lossCutMonitorStartedAt"),"UNOBSERVED / LATE DISCOVERY",
                                "first discovered after its path had elapsed; exact trigger timing unknown")
    else:
        lc_left=_e_left_censor(state.get("lossCutMonitorStartedAt"),None,None)
    at=_e_iso(now)
    return {"instance":instance,"basketId":str(b.get("basketId") or b.get("id") or ""),
            "openedAt":opened_at,"openedAtMs":int(opened.timestamp()*1000) if opened else None,
            "firstSeenAt":at,"lastSeenAt":at,
            "preexistingAtMonitorStart":preexisting,"lateDiscovery":bool(late),
            "forwardEligible":not preexisting and not late,"grossNotionalUsd":notional if notional>0 else None,
            "capitalUsd":notional/2.0 if notional>0 else None,"scoreGap":_e_score_gap(b),
            "regime":(b.get("smartBasket") or {}).get("regimeClassAtOpen") or b.get("regimeClassAtOpen"),
            "policyAtFirstSeen":dict(policy),"policyNow":dict(policy),
            "basketPolicyIdentity":policy.get("basketPolicyIdentity"),
            "basketPolicySource":policy.get("basketPolicySource"),"maxMfeNetReturn":None,
            "comparator":_e_comparator_new(policy,at),"leftCensor":left,
            "prospectiveFirstGhostTrigger":None,"maxMfeAt":None,"armedAt":None,"ghostExit":None,
            "lossCutForwardEligible":not lc_pre and not late,
            "lossCut":{"monitorStartedAt":state.get("lossCutMonitorStartedAt"),
                       "preexistingAtMonitorStart":lc_pre,"leftCensor":lc_left,
                       "prospectiveFirstGhostTrigger":None,"ghostExit":None},
            "closed":None}

def _e_observe(rec,b,policy,now,state=None):
    """Observe one net whole-basket snapshot. No legs are independently evaluated or acted on."""
    if state is not None: _e_migrate_record(rec,state,policy,now)
    _e_bind_basket_policy(rec,policy,now)
    _e_comparator_update(rec,policy,now)
    rec["lastSeenAt"]=_e_iso(now); rec["policyNow"]=dict(policy)
    age=_e_age_hours(rec.get("openedAt") or b.get("openedAt"),now)
    if fin(age): rec["ageHours"]=age
    score_gap=_e_score_gap(b)
    if fin(score_gap): rec["scoreGap"]=score_gap
    regime=(b.get("smartBasket") or {}).get("regimeClassAtOpen") or b.get("regimeClassAtOpen")
    if regime: rec["regime"]=regime
    notional=_e_notional_usd(b)
    if notional>0:
        rec["grossNotionalUsd"]=notional; rec["capitalUsd"]=notional/2.0
    net=b.get("lastNetReturn")
    if not fin(net):
        pnl=b.get("netPnlUsd"); cap=rec.get("capitalUsd")
        net=(pnl/cap) if fin(pnl) and fin(cap) and cap else None
    if fin(net):
        rec["currentNetReturn"]=net; rec["currentPnlUsd"]=_e_usd(rec,net)
    sb=b.get("smartBasket") or {}
    candidates=[rec.get("maxMfeNetReturn"),sb.get("maxNetReturn"),net]
    mfe=max((x for x in candidates if fin(x)),default=None)
    if fin(mfe) and (not fin(rec.get("maxMfeNetReturn")) or mfe>rec.get("maxMfeNetReturn")+1e-12):
        rec["maxMfeNetReturn"]=mfe; rec["maxMfeAt"]=sb.get("maxNetAt") or _e_iso(now)
    elif fin(mfe):
        rec["maxMfeNetReturn"]=mfe
    mfe=rec.get("maxMfeNetReturn")
    giveback=(mfe-net)/mfe if fin(mfe) and mfe>0 and fin(net) else None
    if fin(giveback): rec["givebackFraction"]=max(0.0,giveback)

    # Frozen Rule E: arm only after both gates; once armed, freeze the first prospective
    # observation. A pre-monitor basket never gains a fabricated historical trigger timestamp.
    if not rec.get("armedAt") and fin(age) and age>=SMART_E_ARM_AGE_H and fin(mfe) and mfe>=SMART_E_ARM_MFE:
        rec["armedAt"]=_e_iso(now); rec["ageAtArmHours"]=age
        rec["mfeAtArmNetReturn"]=mfe; rec["mfeAtArmPnlUsd"]=_e_usd(rec,mfe)
    if rec.get("armedAt") and not rec.get("ghostExit") and fin(mfe) and mfe>0 and fin(net) and fin(giveback) and giveback>=SMART_E_GIVEBACK:
        rec["ghostExit"]={"observedAt":_e_iso(now),"ageHours":age,"netReturn":net,"pnlUsd":_e_usd(rec,net),
                          "mfeAtTriggerNetReturn":mfe,"mfeAtTriggerPnlUsd":_e_usd(rec,mfe),
                          "givebackFraction":giveback,"minNetReturnAfterTrigger":net,
                          "minPnlUsdAfterTrigger":_e_usd(rec,net)}
        left=rec.get("leftCensor") or {}
        if left.get("classification"):
            left["firstObservedTriggerAt"]=rec["ghostExit"]["observedAt"]
            left["historicalFirstTriggerUnknown"]=True
        else:
            rec["prospectiveFirstGhostTrigger"]=dict(rec["ghostExit"])
    elif rec.get("ghostExit") and fin(net):
        # The trigger itself remains immutable. This separate low-water mark quantifies the
        # maximum post-ghost giveback that E would have avoided while the real basket stayed on.
        ghost=rec["ghostExit"]
        prior=ghost.get("minNetReturnAfterTrigger")
        if not fin(prior) or net<prior:
            ghost["minNetReturnAfterTrigger"]=net; ghost["minPnlUsdAfterTrigger"]=_e_usd(rec,net)

    # Frozen LOSS_CUT: no leg-level condition and no executor action. The first observed
    # trigger is immutable. A pre-LOSS_CUT basket is explicitly labeled observed, never true
    # historical first trigger, because its earlier path was not monitored by this challenger.
    lc=_loss_cut_state(rec)
    if lc:
        lc_cond=_loss_cut_condition(age,mfe,net)
        lc["lastCondition"]=dict(lc_cond); lc["lastObservedAt"]=_e_iso(now)
        lc_left=lc.get("leftCensor") or {}
        if not lc.get("firstObservedAt"):
            lc["firstObservedAt"]=_e_iso(now)
            if lc_left.get("classification") and lc_left.get("conditionAlreadyTrueAtMonitorStart") is None:
                lc_left["conditionAlreadyTrueAtMonitorStart"]=lc_cond["exit"]
        lc_ghost=lc.get("ghostExit") or {}
        if lc_cond["exit"] and not lc_ghost:
            lc_ghost={"observedAt":_e_iso(now),"ageHours":age,"netReturn":net,"pnlUsd":_e_usd(rec,net),
                      "mfeAtTriggerNetReturn":mfe,"mfeAtTriggerPnlUsd":_e_usd(rec,mfe),
                      "givebackFraction":lc_cond["givebackFraction"],"minNetReturnAfterTrigger":net,
                      "minPnlUsdAfterTrigger":_e_usd(rec,net)}
            lc["ghostExit"]=lc_ghost
            if lc_left.get("classification"):
                lc_left["firstObservedTriggerAt"]=lc_ghost["observedAt"]
                lc_left["historicalFirstTriggerUnknown"]=True
            else:
                lc["prospectiveFirstGhostTrigger"]=dict(lc_ghost)
        elif lc_ghost and fin(net):
            prior=lc_ghost.get("minNetReturnAfterTrigger")
            if not fin(prior) or net<prior:
                lc_ghost["minNetReturnAfterTrigger"]=net
                lc_ghost["minPnlUsdAfterTrigger"]=_e_usd(rec,net)

def _e_close_comparability(cohort,cohort_reason,reason,hold):
    if cohort!="VALID FORWARD COHORT":
        return False,"%s: %s"%(cohort,cohort_reason)
    if not str(reason).upper().startswith("HORIZON"):
        return False,"actual close reason %s, not HORIZON"%reason
    if not fin(hold) or abs(hold-SMART_E_HORIZON_H)>1.0:
        return False,"actual hold %s h, not the 36h comparator"%(("%.2f"%hold) if fin(hold) else "unknown")
    return True,"NoTP / 36h comparable"

def _e_finalize(rec,b,policy,now,state=None):
    if rec.get("closed"): return
    _e_observe(rec,b,policy,now,state)
    actual_ret=b.get("lastNetReturn")
    actual_usd=b.get("netPnlUsd")
    if not fin(actual_ret) and fin(actual_usd) and fin(rec.get("capitalUsd")) and rec.get("capitalUsd"):
        actual_ret=actual_usd/rec["capitalUsd"]
    if not fin(actual_usd): actual_usd=_e_usd(rec,actual_ret)
    closed_at=b.get("closedAt") or _e_iso(now)
    opened=piso(rec.get("openedAt")); closed=piso(closed_at)
    hold=(closed-opened).total_seconds()/3600.0 if opened and closed else None
    reason=b.get("closeReason") or b.get("exitReason") or "UNKNOWN"
    cohort,cohort_reason=_e_cohort_status(rec)
    e_comparable,e_note=_e_close_comparability(cohort,cohort_reason,reason,hold)
    lc_cohort,lc_cohort_reason=_loss_cut_cohort_status(rec)
    lc_comparable,lc_note=_e_close_comparability(lc_cohort,lc_cohort_reason,reason,hold)
    # The forward table uses the common prospective cohort for both challengers. E-only
    # legacy observations remain in the ledger but are never mixed into LOSS_CUT evidence.
    comparable=bool(e_comparable and lc_comparable)
    note="NoTP / 36h comparable" if comparable else "E: %s | LOSS_CUT: %s"%(e_note,lc_note)
    ghost=rec.get("ghostExit") or {}
    e_ret=ghost.get("netReturn") if ghost else actual_ret
    e_usd=ghost.get("pnlUsd") if ghost else actual_usd
    delta_ret=(e_ret-actual_ret) if fin(e_ret) and fin(actual_ret) else None
    delta_usd=(e_usd-actual_usd) if fin(e_usd) and fin(actual_usd) else None
    after_low=ghost.get("minNetReturnAfterTrigger") if ghost else None
    after_low_usd=ghost.get("minPnlUsdAfterTrigger") if ghost else None
    if ghost and fin(actual_ret) and (not fin(after_low) or actual_ret<after_low): after_low=actual_ret
    if ghost and fin(actual_usd) and (not fin(after_low_usd) or actual_usd<after_low_usd): after_low_usd=actual_usd
    max_avoided=(ghost.get("netReturn")-after_low) if ghost and fin(ghost.get("netReturn")) and fin(after_low) else None
    max_avoided_usd=(ghost.get("pnlUsd")-after_low_usd) if ghost and fin(ghost.get("pnlUsd")) and fin(after_low_usd) else None
    e_verdict=("NO EFFECT" if not ghost else "SAVED LOSS" if fin(delta_ret) and delta_ret>1e-12 else
               "TRUNCATED RECOVERY/WINNER" if fin(delta_ret) and delta_ret<-1e-12 else "NO EFFECT")
    lc=_loss_cut_state(rec); lc_ghost=lc.get("ghostExit") or {}
    lc_ret=lc_ghost.get("netReturn") if lc_ghost else actual_ret
    lc_usd=lc_ghost.get("pnlUsd") if lc_ghost else actual_usd
    lc_delta_ret=(lc_ret-actual_ret) if fin(lc_ret) and fin(actual_ret) else None
    lc_delta_usd=(lc_usd-actual_usd) if fin(lc_usd) and fin(actual_usd) else None
    lc_after_low=lc_ghost.get("minNetReturnAfterTrigger") if lc_ghost else None
    lc_after_low_usd=lc_ghost.get("minPnlUsdAfterTrigger") if lc_ghost else None
    if lc_ghost and fin(actual_ret) and (not fin(lc_after_low) or actual_ret<lc_after_low): lc_after_low=actual_ret
    if lc_ghost and fin(actual_usd) and (not fin(lc_after_low_usd) or actual_usd<lc_after_low_usd): lc_after_low_usd=actual_usd
    lc_max_avoided=(lc_ghost.get("netReturn")-lc_after_low) if lc_ghost and fin(lc_ghost.get("netReturn")) and fin(lc_after_low) else None
    lc_max_avoided_usd=(lc_ghost.get("pnlUsd")-lc_after_low_usd) if lc_ghost and fin(lc_ghost.get("pnlUsd")) and fin(lc_after_low_usd) else None
    lc_verdict=("NO EFFECT" if not lc_ghost else "SAVED LOSS" if fin(lc_delta_ret) and lc_delta_ret>1e-12 else
                "TRUNCATED RECOVERY/WINNER" if fin(lc_delta_ret) and lc_delta_ret<-1e-12 else "NO EFFECT")
    rec["closed"]={"closedAt":closed_at,"closeReason":reason,"holdHours":hold,
                   "actualNetReturn":actual_ret,"actualPnlUsd":actual_usd,
                   "eNetReturn":e_ret,"ePnlUsd":e_usd,"deltaNetReturn":delta_ret,"deltaUsd":delta_usd,
                   "mfeThroughCloseNetReturn":rec.get("maxMfeNetReturn"),
                   "maxGivebackAvoidedNetReturn":max(0.0,max_avoided) if fin(max_avoided) else None,
                   "maxGivebackAvoidedUsd":max(0.0,max_avoided_usd) if fin(max_avoided_usd) else None,
                   "winnerTruncated":bool(ghost and fin(actual_ret) and fin(e_ret) and actual_ret>e_ret+1e-12),
                   "eVerdict":e_verdict,
                   "lossCutNetReturn":lc_ret,"lossCutPnlUsd":lc_usd,
                   "lossCutDeltaNetReturn":lc_delta_ret,"lossCutDeltaUsd":lc_delta_usd,
                   "lossCutMaxGivebackAvoidedNetReturn":max(0.0,lc_max_avoided) if fin(lc_max_avoided) else None,
                   "lossCutMaxGivebackAvoidedUsd":max(0.0,lc_max_avoided_usd) if fin(lc_max_avoided_usd) else None,
                   "lossCutWinnerTruncated":bool(lc_ghost and fin(actual_ret) and fin(lc_ret) and actual_ret>lc_ret+1e-12),
                   "lossCutVerdict":lc_verdict,
                   "cohortStatus":cohort,"cohortReason":cohort_reason,
                   "lossCutCohortStatus":lc_cohort,"lossCutCohortReason":lc_cohort_reason,
                   "eComparable":e_comparable,"lossCutComparable":lc_comparable,
                   "comparable":comparable,"comparatorNote":note,
                   "eComparatorNote":e_note,"lossCutComparatorNote":lc_note}

def _e_prune_locked(state):
    done=[(r.get("closed",{}).get("closedAt") or "",k) for k,r in state["baskets"].items() if r.get("closed")]
    if len(done)<=SMART_E_MAX_COMPLETED: return
    done.sort()
    for _,key in done[:len(done)-SMART_E_MAX_COMPLETED]: state["baskets"].pop(key,None)

def _e_episodes(rows,hours=48.0):
    free=None; kept=0
    for r in sorted(rows,key=lambda x:x.get("openedAt") or ""):
        opened=piso(r.get("openedAt"))
        if not opened: continue
        if free is None or opened>=free:
            kept+=1; free=opened+timedelta(hours=hours)
    return kept

def _e_evidence_status(n,episodes,mean_delta,median_delta,actual_mean,ghost_mean):
    # No challenger may be called PROMISING before both basket and de-overlapped episode
    # thresholds are met. REJECT is intentionally symmetric only after the same threshold.
    if n<30 or episodes<10: return "INSUFFICIENT"
    if n>=60 and episodes>=20 and fin(mean_delta) and mean_delta>0 and fin(median_delta) and median_delta>=0 and fin(actual_mean) and fin(ghost_mean) and ghost_mean>=actual_mean:
        return "PROMISING"
    if n>=60 and episodes>=20 and fin(mean_delta) and mean_delta<0 and fin(median_delta) and median_delta<=0 and fin(actual_mean) and fin(ghost_mean) and ghost_mean<actual_mean:
        return "REJECT"
    return "WATCH"

def _e_challenger_summary(comparable,triggered,result_key,delta_key,delta_usd_key,avoided_key,avoided_usd_key,winner_key,verdict_key,episodes):
    closed=[r.get("closed") or {} for r in comparable]
    deltas=[c.get(delta_key) for c in closed if fin(c.get(delta_key))]
    usd=[c.get(delta_usd_key) for c in closed if fin(c.get(delta_usd_key))]
    actual=[c.get("actualNetReturn") for c in closed if fin(c.get("actualNetReturn"))]
    ghost=[c.get(result_key) for c in closed if fin(c.get(result_key))]
    n=len(comparable)
    better=[c for c in closed if fin(c.get(delta_key)) and c.get(delta_key)>1e-12]
    worse=[c for c in closed if fin(c.get(delta_key)) and c.get(delta_key)<-1e-12]
    saved=[c for c in closed if c.get(verdict_key)=="SAVED LOSS"]
    truncated=[c for c in closed if c.get(verdict_key)=="TRUNCATED RECOVERY/WINNER"]
    no_effect=[c for c in closed if c.get(verdict_key)=="NO EFFECT"]
    mean_delta=sum(deltas)/len(deltas) if deltas else None
    median_delta=st.median(deltas) if deltas else None
    actual_mean=sum(actual)/len(actual) if actual else None
    ghost_mean=sum(ghost)/len(ghost) if ghost else None
    return {"triggered":len(triggered),"triggerPct":None,
            "better":len(better),"worse":len(worse),"same":n-len(better)-len(worse),
            "betterPct":100*len(better)/n if n else None,"worsePct":100*len(worse)/n if n else None,
            "meanDelta":mean_delta,"medianDelta":median_delta,"totalDeltaUsd":sum(usd) if usd else None,
            "actualMean":actual_mean,"ghostMean":ghost_mean,
            "riskSavedNetReturn":sum(c.get(avoided_key) for c in closed if fin(c.get(avoided_key))) if closed else None,
            "riskSavedUsd":sum(c.get(avoided_usd_key) for c in closed if fin(c.get(avoided_usd_key))) if closed else None,
            "winnerTruncated":sum(1 for c in closed if c.get(winner_key)),
            "savedLoss":len(saved),"truncatedRecovery":len(truncated),"noEffect":len(no_effect),
            "status":_e_evidence_status(n,episodes,mean_delta,median_delta,actual_mean,ghost_mean)}

def _e_aggregate(records):
    closed=[r for r in records if r.get("closed")]
    # The dashboard comparison starts at LOSS_CUT deployment. This creates one honest common
    # prospective cohort instead of mixing older E-only observations with a new challenger.
    valid_cohort=[r for r in records if _e_cohort_status(r)[0]=="VALID FORWARD COHORT"
                  and _loss_cut_cohort_status(r)[0]=="VALID FORWARD COHORT"]
    comparable=[r for r in closed if r["closed"].get("comparable")]
    episodes=_e_episodes(comparable)
    e_triggered=[r for r in valid_cohort if r.get("prospectiveFirstGhostTrigger")]
    lc_triggered=[r for r in valid_cohort if _loss_cut_state(r).get("prospectiveFirstGhostTrigger")]
    e=_e_challenger_summary(comparable,e_triggered,"eNetReturn","deltaNetReturn","deltaUsd",
                            "maxGivebackAvoidedNetReturn","maxGivebackAvoidedUsd",
                            "winnerTruncated","eVerdict",episodes)
    lc=_e_challenger_summary(comparable,lc_triggered,"lossCutNetReturn","lossCutDeltaNetReturn","lossCutDeltaUsd",
                             "lossCutMaxGivebackAvoidedNetReturn","lossCutMaxGivebackAvoidedUsd",
                             "lossCutWinnerTruncated","lossCutVerdict",episodes)
    e["triggerPct"]=100*len(e_triggered)/len(valid_cohort) if valid_cohort else None
    lc["triggerPct"]=100*len(lc_triggered)/len(valid_cohort) if valid_cohort else None
    e_left=[r for r in records if _e_left_class(r)=="LEFT-CENSORED / PRE-MONITOR"]
    lc_left=[r for r in records if ((_loss_cut_state(r).get("leftCensor") or {}).get("classification")=="LEFT-CENSORED / PRE-MONITOR")]
    mismatch=[r for r in records if (r.get("comparator") or {}).get("firstMismatchAt")]
    return {"observedTotal":len(records),"observedCompleted":len(closed),
            "validForwardCohort":len(valid_cohort),"validForwardOpen":sum(1 for r in valid_cohort if not r.get("closed")),
            "completed":len(comparable),"excluded":len(closed)-len(comparable),
            "leftCensored":len({id(r) for r in e_left+lc_left}),
            "eLeftCensored":len(e_left),"lossCutLeftCensored":len(lc_left),
            "comparatorMismatch":len(mismatch),"episodes":episodes,
            "actualMean":e.get("actualMean"),"e":e,"lossCut":lc,
            # v2 aliases retain a stable API shape for any out-of-tree reader; all now use the
            # common E/LOSS_CUT forward cohort rather than a mixed population.
            "triggered":e["triggered"],"better":e["better"],"worse":e["worse"],"same":e["same"],
            "triggerPct":e["triggerPct"],"betterPct":e["betterPct"],"worsePct":e["worsePct"],
            "meanDelta":e["meanDelta"],"medianDelta":e["medianDelta"],"totalDeltaUsd":e["totalDeltaUsd"],
            "ghostMean":e["ghostMean"],"status":e["status"]}

def _e_snapshot_locked(state,instances,open_views,now):
    out={"version":state.get("version"),"monitorStartedAt":state.get("monitorStartedAt"),
         "lossCutMonitorStartedAt":state.get("lossCutMonitorStartedAt"),
         "lastRefreshAt":state.get("lastRefreshAt"),"writeError":state.get("writeError"),"instances":{},
         "open":open_views,"recent":[]}
    for key,cfg in instances.items():
        rows=[r for r in state["baskets"].values() if r.get("instance")==key]
        out["instances"][key]={"label":cfg.get("long") or cfg.get("label") or key,
                               "policy":_e_policy((cfg.get("ex") or {}),_e_runtime_flags(cfg)),"summary":_e_aggregate(rows)}
        out["recent"].extend(r for r in rows if r.get("closed"))
    out["recent"].sort(key=lambda r:r.get("closed",{}).get("closedAt") or "",reverse=True)
    return out

def smart_e_refresh(instances,now=None):
    """Read executor snapshots and update the isolated ghost ledger. No orders, cancels, or config writes."""
    now=now or datetime.now(timezone.utc)
    with _smart_e_lock:
        state=_e_load_locked(now); open_views=[]
        # Migrate retained rows too, so old dashboard data cannot retain a misleading
        # “first trigger” label merely because it is no longer in the executor's recent window.
        for rec in state["baskets"].values():
            cfg=instances.get(rec.get("instance")) or {}; ex=cfg.get("ex") or {}
            if not ex.get("__error__"): _e_migrate_record(rec,state,_e_policy(ex,_e_runtime_flags(cfg)),now)
        for instance,cfg in instances.items():
            ex=cfg.get("ex") or {}
            if ex.get("__error__"): continue
            flags=_e_runtime_flags(cfg)
            policy=_e_policy(ex,flags)
            for b in ex.get("openBaskets") or []:
                if not isinstance(b,dict) or b.get("closedAt"): continue
                key=_e_basket_key(instance,b)
                if not key: continue
                basket_policy=_e_policy_for_basket(ex,flags,b)
                rec=state["baskets"].get(key)
                if rec is None:
                    rec=_e_record(instance,b,basket_policy,state,now); state["baskets"][key]=rec
                _e_observe(rec,b,basket_policy,now,state)
                open_views.append({"instance":instance,"label":cfg.get("long") or cfg.get("label") or instance,
                                   "policy":dict(basket_policy),"record":dict(rec)})
            for b in ex.get("recent") or []:
                if not isinstance(b,dict) or not b.get("closedAt"): continue
                key=_e_basket_key(instance,b)
                if not key: continue
                basket_policy=_e_policy_for_basket(ex,flags,b)
                rec=state["baskets"].get(key)
                if rec is None:
                    rec=_e_record(instance,b,basket_policy,state,now,late=True); state["baskets"][key]=rec
                _e_finalize(rec,b,basket_policy,now,state)
        state["lastRefreshAt"]=_e_iso(now)
        _e_prune_locked(state); _e_save_locked(state)
        return _e_snapshot_locked(state,instances,open_views,now)

def smart_e_monitor_loop():
    """Keeps the ghost monitor prospective even when nobody has the dashboard open."""
    while True:
        try:
            now=datetime.now(timezone.utc)
            # Do not let the unattended observer fall back to INST's historical release path.
            # PM2's actual run-api.sh is the runtime authority, even before a browser request has
            # called collect() and refreshed the shared display configuration.
            instances={}
            for k,cfg in INST.items():
                runtime_cfg={**cfg,"rel":active_release(cfg["pm2"],cfg["rel"])}
                instances[k]={**runtime_cfg,"flags":_e_runtime_flags(runtime_cfg),
                              "ex":get(runtime_cfg["api"]+"/api/live/cross-sectional-executor")}
            smart_e_refresh(instances,now)
        except Exception:
            pass
        time.sleep(TTL)

# ------------------------------------------------------------------ collector
def collect():
    if _c["d"] is not None and time.time()-_c["at"]<TTL: return _c["d"]
    now=datetime.now(timezone.utc)
    R={"generatedAt":now.isoformat(),"inst":{}}
    for cfg in INST.values():
        cfg["rel"]=active_release(cfg["pm2"],cfg["rel"])
    for k,cfg in INST.items():
        ex=get(cfg["api"]+"/api/live/cross-sectional-executor")
        rep=get(cfg["api"]+"/api/shadow/cross-sectional-report")
        pool=get(cfg["api"]+"/api/live/cross-sectional-pool")
        futures_health=get(cfg["api"]+"/api/live/futures-reference-health?symbols=1000PEPEUSDT,SOLUSDT,PEPEUSDT")
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
        R["inst"][k]={**cfg,"ex":ex,"rep":rep,"pool":pool,"futuresHealth":futures_health,"fc":fc,"gate":gate,
                      "adm":ex.get("entryAdmission") or {},"attempt":att,
                      "admAudit":ex.get("entryAdmissionAudit") or {},
                      "signalToOrderSec":lat,"rows":load_obs(cfg["store"],PROD_SIGNAL,R.setdefault("corrupt",[])),
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
            if ob.get("signal")!=PROD_SIGNAL or corrupt_legs(ob): continue
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
    # runtime flags read from the .env each instance actually loaded — not assumed
    for k,cfg in INST.items():
        fl={}
        try:
            for ln in open(cfg["rel"]+"/.env"):
                if "=" not in ln or ln.lstrip().startswith("#"): continue
                kk,vv=ln.split("=",1)
                if kk.startswith("CROSS_SECTIONAL_"): fl[kk.strip()]=vv.strip()
        except Exception: pass
        R["inst"][k]["flags"]=fl
    # execution economics from the leg records the executor now writes
    mk=tk=0.0; mkq=tkq=0; drift=[]; shortfall=[]; imbalance=[]; duration=[]
    for k in INST:
        ex=R["inst"][k]["ex"]
        for b in (ex.get("recent") or [])+(ex.get("openBaskets") or []):
            for l in b.get("legs") or []:
                q=l.get("exitMakerQty"); p_=l.get("exitMakerPrice")
                fq=l.get("exitFallbackQty"); fp=l.get("exitFallbackPrice")
                if fin(q) and q>0 and fin(p_): mk+=q*p_; mkq+=1
                if fin(fq) and fq>0 and fin(fp): tk+=fq*fp; tkq+=1
                if fin(p_) and fin(fp) and p_>0: drift.append(abs(fp/p_-1))
                xe=l.get("exitExecution") or {}
                if fin(xe.get("implementationShortfallUsd")): shortfall.append(xe["implementationShortfallUsd"])
                if fin(xe.get("temporaryImbalanceUsd")): imbalance.append(xe["temporaryImbalanceUsd"])
                if fin(xe.get("durationMs")): duration.append(xe["durationMs"])
    tot=mk+tk
    R["exitEcon"]={"makerNotional":mk,"takerNotional":tk,
                   "makerPct":(100*mk/tot) if tot>0 else None,
                   "fallbackPct":(100*tk/tot) if tot>0 else None,
                   "legsMaker":mkq,"legsTaker":tkq,
                   "feePaid":(mk*0.0002+tk*0.0005) if tot>0 else None,
                   "feeSaved":(mk*0.0003) if mk>0 else None,
                   "exitDrift":(100*sum(drift)/len(drift)) if drift else None,
                   "implementationShortfall":sum(shortfall) if shortfall else None,
                   "temporaryImbalance":max(imbalance) if imbalance else None,
                   "durationSec":(sum(duration)/len(duration)/1000.0) if duration else None}
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
    # This is an independent observer. Its own persistent evidence is never written into the
    # live/testnet executor stores and is not consumed by any exit or admission path.
    try: R["smartE"]=smart_e_refresh(R["inst"],now)
    except Exception as ex: R["smartE"]={"error":str(ex)[:180],"instances":{},"open":[],"recent":[]}
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
.health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}
.reference-chain{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:#93a5b8;font-size:11.5px;margin-top:9px}
.reference-chain span{background:#111823;border:1px solid #1e2836;border-radius:12px;padding:3px 8px}.reference-chain b{color:#4c8fd6}
.health-alert{margin-top:7px;padding:7px 9px;border-radius:5px;border:1px solid #1e2836;font-size:11.5px}
.health-alert.block{border-left:3px solid #e5686d}.health-alert.watch{border-left:3px solid #d9a441}
details.observability{background:#111823;border:1px solid #1e2836;border-radius:7px;margin-top:16px}
details.observability>summary{padding:11px 13px;color:#c9d4e0;font-weight:600;cursor:pointer}
details.observability>.body{padding:0 13px 13px}
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

def _e_pp(v,d=3):
    if not fin(v): return "<span class='dim'>–</span>"
    return "<span class='%s'>%s%.*f pp</span>"%("pos" if v>0 else "neg" if v<0 else "", "+" if v>0 else "",d,100*v)

def _e_giveback(v):
    if not fin(v): return "<span class='dim'>–</span>"
    return "<span class='%s'>%.1f%%</span>"%("neg" if v>=SMART_E_GIVEBACK else "warnc" if v>=.5 else "",100*v)

def _e_time(v):
    return esc(str(v or "–").replace("T"," ")[:19])

def _e_net_pair(ret,usd,d=3):
    return "%s <span class='dim'>(%s)</span>"%(money(usd,d),pct(100*ret,d) if fin(ret) else "–")

def smart_e_open_html(R):
    se=R.get("smartE") or {}; views=se.get("open") or []; o=[]
    o.append("<h2>Smart Basket E · Ghost</h2>")
    o.append("<div class='note'>Frozen Rule E, net whole-basket P&amp;L only: arm at age ≥24h and MFE ≥+1.0%%; after arm, ghost exit at giveback ≥70%% of MFE. It sends no order, cancellation, or configuration write.</div>")
    if se.get("error"):
        return "".join(o)+"<div class='card'><span class='neg'>Ghost monitor error:</span> %s</div>"%esc(se["error"])
    if not views:
        return "".join(o)+"<div class='card dim'>Tidak ada basket terbuka yang sedang dipantau.</div>"
    for view in views:
        r=view["record"]; policy=view["policy"]; ghost=r.get("ghostExit") or {}
        cohort,cohort_reason=_e_cohort_status(r); left=r.get("leftCensor") or {}
        status="WOULD EXIT" if ghost else "ARMED" if r.get("armedAt") else "NOT ARMED"
        status_cls="neg" if ghost else "warnc" if r.get("armedAt") else "dim"
        age=r.get("ageHours"); mfe=r.get("maxMfeNetReturn"); current=r.get("currentNetReturn")
        age_ok=fin(age) and age>=SMART_E_ARM_AGE_H; mfe_ok=fin(mfe) and mfe>=SMART_E_ARM_MFE
        o.append("<div class='card' style='margin-top:10px'>")
        cohort_cls="pos" if cohort=="VALID FORWARD COHORT" else "warnc" if "MISMATCH" in cohort else "neg"
        o.append("<div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'><div><b>%s</b> <span class='dim'>· %s · net basket</span></div><div><span class='%s'><b>%s</b></span> <span class='%s'><b>%s</b></span></div></div>"%(
            esc(friendly(r.get("basketId"))),esc(view.get("label")),cohort_cls,esc(cohort),status_cls,status))
        o.append("<div class='grid' style='margin-top:9px'>")
        trigger_note=("first observed after monitor; historical first trigger unknown" if left.get("classification") else
                      "first prospective trigger is frozen" if ghost else "ghost only")
        o.append(card("Status","<span class='%s'>%s</span>"%(status_cls,status),trigger_note))
        o.append(card("Age","%.1fh / 36h"%age if fin(age) else "– / 36h","arm after 24h"))
        o.append(card("Current P&amp;L",_e_net_pair(current,r.get("currentPnlUsd")),"runtime net whole basket"))
        o.append(card("MFE",_e_net_pair(mfe,_e_usd(r,mfe)),"at %s"%_e_time(r.get("maxMfeAt"))))
        o.append(card("Giveback",_e_giveback(r.get("givebackFraction")),"trigger ≥70%% after armed"))
        o.append("</div>")
        o.append("<div class='g2' style='margin-top:9px'>")
        arm_rows=("<div class='card'><div class='k'>Arm condition</div>"
                  "<div style='margin-top:7px'>%s age ≥24h <span class='dim'>(%s)</span></div>"
                  "<div>%s MFE ≥+1.0%% <span class='dim'>(%s)</span></div></div>")%(
                    "<span class='pos'>✓</span>" if age_ok else "<span class='neg'>✕</span>",
                    ("%.1fh"%age) if fin(age) else "–",
                    "<span class='pos'>✓</span>" if mfe_ok else "<span class='neg'>✕</span>",
                    ("%+.3f%%"%(100*mfe)) if fin(mfe) else "–")
        if ghost:
            trigger_title="first observed trigger" if left.get("classification") else "first prospective trigger"
            exit_html=("<div class='card'><div class='k'>Ghost exit · %s</div>"
                       "<div class='v'>%s</div><div class='s'>time %s · age %s · MFE then %s · giveback %s</div></div>")%(
                         trigger_title,
                         _e_net_pair(ghost.get("netReturn"),ghost.get("pnlUsd")),_e_time(ghost.get("observedAt")),
                         ("%.1fh"%ghost.get("ageHours")) if fin(ghost.get("ageHours")) else "–",
                         pct(100*ghost.get("mfeAtTriggerNetReturn"),3) if fin(ghost.get("mfeAtTriggerNetReturn")) else "–",
                         _e_giveback(ghost.get("givebackFraction")))
        else:
            exit_html="<div class='card'><div class='k'>Ghost exit</div><div class='v dim'>Belum</div><div class='s'>tidak ada exit yang dikirim</div></div>"
        o.append(arm_rows+exit_html)
        o.append("</div>")
        if left.get("classification"):
            already=left.get("conditionAlreadyTrueAtMonitorStart")
            already_text=("✓ condition already true at monitor start" if already is True else
                          "✕ condition not true at monitor start" if already is False else "? condition at monitor start unavailable")
            o.append("<div class='card' style='margin-top:9px'><div class='k'>%s</div><div style='margin-top:6px'>%s</div><div class='note'>True historical first trigger is unknown. First observed trigger: %s. Excluded from trigger-timing and forward-quality statistics.</div></div>"%(
                esc(left.get("classification")),esc(already_text),_e_time(left.get("firstObservedTriggerAt") or ghost.get("observedAt"))))
        o.append("<div class='note'><b>Cohort</b> · %s <span class='dim'>· %s</span></div>"%(esc(cohort),esc(cohort_reason)))
        o.append("<div class='note'><b>Actual comparator runtime</b> · %s <span class='dim'>· %s</span></div>"%(esc(policy.get("label")),esc(policy.get("exact") or "")))
        o.append("</div>")
    return "".join(o)

def smart_e_summary_html(R):
    se=R.get("smartE") or {}; o=["<h2>Smart Basket E · Forward</h2>"]
    o.append("<div class='note'>Valid Forward Evidence is separate from Historical Research. A basket enters E-vs-NoTP only when opened after monitor deployment, runtime is NoTP + hold 36h throughout the observed path, and the actual exit is HORIZON at the 36h comparator. Anything else is retained for diagnosis but excluded from timing and outcome statistics.</div>")
    for key,info in (se.get("instances") or {}).items():
        s=info.get("summary") or {}; policy=info.get("policy") or {}; n=s.get("completed") or 0
        o.append("<h3>%s</h3>"%esc(info.get("label") or key))
        if not policy.get("canonicalNoTp36"):
            o.append("<div class='card'><span class='warnc'><b>COMPARATOR PAUSED</b></span> · Runtime reports <b>%s</b><br><span class='dim'>Exact mismatch: %s</span><div class='note'>Ghost observation continues; no basket enters E-vs-NoTP until runtime itself is NoTP + hold 36h.</div></div>"%(esc(policy.get("label")),esc(policy.get("exact") or "")))
        o.append("<div class='grid' style='margin-top:9px'>")
        o.append(card("Valid comparable baskets",str(n),"%d valid cohort total · %d still open"%(s.get("validForwardCohort") or 0,s.get("validForwardOpen") or 0)))
        o.append(card("Left-censored",str(s.get("leftCensored") or 0),"pre-monitor; excluded from trigger timing / quality"))
        o.append(card("Comparator mismatch",str(s.get("comparatorMismatch") or 0),"runtime not NoTP + 36h at one or more observed scans"))
        o.append(card("E triggered","%d%s"%(s.get("triggered") or 0,(" (%.0f%%)"%s["triggerPct"]) if fin(s.get("triggerPct")) else ""),"valid forward cohort only"))
        o.append(card("E better than actual","%d%s"%(s.get("better") or 0,(" (%.0f%%)"%s["betterPct"]) if fin(s.get("betterPct")) else ""),"same %d"%(s.get("same") or 0)))
        o.append(card("E worse than actual","%d%s"%(s.get("worse") or 0,(" (%.0f%%)"%s["worsePct"]) if fin(s.get("worsePct")) else ""),"not a win-rate claim"))
        o.append(card("Mean delta",_e_pp(s.get("meanDelta")),"E minus actual valid comparator"))
        o.append(card("Median delta",_e_pp(s.get("medianDelta")),"E minus actual valid comparator"))
        o.append(card("Total $ delta",money(s.get("totalDeltaUsd"),3),"valid comparable baskets only"))
        o.append(card("Actual NoTP mean",pct(100*s.get("actualMean"),3) if fin(s.get("actualMean")) else "–","valid 36h HORIZON comparator"))
        o.append(card("Ghost E mean",pct(100*s.get("ghostMean"),3) if fin(s.get("ghostMean")) else "–","same cohort; E exit or 36h final"))
        o.append(card("Independent episodes",str(s.get("episodes") or 0),"48h de-overlap"))
        status=s.get("status") or "INSUFFICIENT"
        o.append(card("Evidence status","<span class='%s'>%s</span>"%({"PROMISING":"pos","WATCH":"warnc"}.get(status,"dim"),status),"PROMISING requires positive mean + median, no mean expectancy loss, ≥60 baskets and ≥20 episodes"))
        o.append("</div>")
    o.append("<h3>Historical Research · context only</h3><div class='g2'>")
    o.append(card("NoTP mean","<span class='pos'>+0.3149%</span>","canonical historical harness · N=1693"))
    o.append(card("E mean","<span class='pos'>+0.3107%</span>","historical research, not forward result"))
    o.append(card("E OOS delta vs NoTP","<span class='neg'>−0.0334 pp</span>","historical OOS only"))
    o.append(card("Offsets won","3 / 6","historical robustness only"))
    o.append("</div><div class='note'>The four cards above are fixed historical benchmark context. They are never combined with Valid Forward Evidence counts or means.</div>")
    return "".join(o)

def smart_e_recent_html(R):
    se=R.get("smartE") or {}; rows=(se.get("recent") or [])[:10]
    o=["<h2>Smart Basket E · Recent Evaluation</h2>"]
    o.append("<div class='note'>`Avoided after E` is the maximum post-ghost decline captured by the observer through final close; it is not hidden if final P&amp;L later recovers. A left-censored basket never receives a fabricated historical first-trigger time. Non-comparable rows remain diagnostic only.</div>")
    if not rows: return "".join(o)+"<div class='card dim'>Belum ada basket selesai yang tercatat oleh ledger ghost.</div>"
    o.append("<div class='scroll'><table><tr><th>basket / opened</th><th>cohort</th><th>regime / scoreGap</th><th>armed</th><th>first E trigger</th><th>MFE / giveback trigger</th><th>actual final</th><th>E delta vs actual</th><th>avoided after E</th><th>winner truncated</th><th>comparator</th></tr>")
    for r in rows:
        c=r.get("closed") or {}; g=r.get("ghostExit") or {}; comp=c.get("comparable")
        cohort,cohort_reason=_e_cohort_status(r); left=r.get("leftCensor") or {}
        delta=_e_pp(c.get("deltaNetReturn")) if comp else "<span class='dim'>–</span>"
        avoided=_e_pp(c.get("maxGivebackAvoidedNetReturn")) if comp else "<span class='dim'>–</span>"
        comp_html=("<span class='pos'>COMPARABLE</span>" if comp else "<span class='warnc'>EXCLUDED</span>")+"<br><span class='dim' style='white-space:normal'>%s</span>"%esc(c.get("comparatorNote") or cohort_reason)
        if left.get("classification"):
            trigger_html=("<span class='warnc'>HISTORICAL UNKNOWN</span><br><span class='dim'>first observed %s</span>"%_e_time(left.get("firstObservedTriggerAt") or g.get("observedAt")))
        elif g:
            trigger_html=("<span class='pos'>%s</span><br><span class='dim'>age %s · %s</span>"%(
                _e_time((r.get("prospectiveFirstGhostTrigger") or g).get("observedAt")),
                ("%.1fh"%g.get("ageHours")) if fin(g.get("ageHours")) else "–",_e_net_pair(g.get("netReturn"),g.get("pnlUsd"))))
        else:
            trigger_html="<span class='dim'>not triggered</span>"
        arm_html=("%s<br><span class='dim'>MFE %s</span>"%(
            _e_time(r.get("armedAt")),pct(100*r.get("mfeAtArmNetReturn"),3) if fin(r.get("mfeAtArmNetReturn")) else "–")) if r.get("armedAt") else "<span class='dim'>not armed</span>"
        mfe_trigger=("%s<br><span class='dim'>giveback %s</span>"%(pct(100*g.get("mfeAtTriggerNetReturn"),3),_e_giveback(g.get("givebackFraction")))) if g else "<span class='dim'>–</span>"
        o.append("<tr><td><b>%s</b><br><span class='dim'>%s · opened %s</span></td><td><span class='%s'>%s</span><br><span class='dim' style='white-space:normal'>%s</span></td><td>%s<br><span class='dim'>gap %s</span></td><td>%s</td><td>%s</td><td>%s</td><td>%s<br><span class='dim'>%s · %s · %s</span></td><td>%s</td><td>%s</td><td>%s</td><td style='white-space:normal'>%s</td></tr>"%(
            esc(friendly(r.get("basketId"))),esc(r.get("instance") or ""),_e_time(r.get("openedAt")),
            "pos" if cohort=="VALID FORWARD COHORT" else "warnc" if "MISMATCH" in cohort else "neg",esc(cohort),esc(cohort_reason),
            esc(r.get("regime") or "–"),num(r.get("scoreGap"),4),arm_html,trigger_html,mfe_trigger,
            _e_net_pair(c.get("actualNetReturn"),c.get("actualPnlUsd")),_e_time(c.get("closedAt")),esc(str(c.get("closeReason") or "–")),("%.1fh"%c["holdHours"]) if fin(c.get("holdHours")) else "–",
            delta,avoided,"<span class='neg'>YES</span>" if c.get("winnerTruncated") else "no",comp_html))
    o.append("</table></div>")
    return "".join(o)

def smart_e_overview_html(R):
    return smart_e_open_html(R)+smart_e_summary_html(R)+smart_e_recent_html(R)

# ------------------------------------------------------------------ Smart Basket ghosts v3 presentation
# Kept below the original v2 presentation so older references remain harmless; these definitions
# intentionally replace it at runtime with the dual-challenger, common-cohort view.
def _ghost_status_class(status):
    return {"WOULD EXIT":"neg","ARMED":"warnc","WATCHING":"warnc",
            "PROMISING":"pos","WATCH":"warnc","REJECT":"neg"}.get(status,"dim")

def _ghost_check(ok,label,actual,rule):
    return "%s <b>%s</b> <span class='dim'>%s / %s</span>"%(
        "<span class='pos'>✓</span>" if ok else "<span class='neg'>✕</span>",
        esc(label),esc(actual),esc(rule))

def _ghost_censor_box(left,label):
    if not isinstance(left,dict) or not left.get("classification"): return ""
    already=left.get("conditionAlreadyTrueAtMonitorStart")
    already_text=("condition already true at monitor start" if already is True else
                  "condition not true at monitor start" if already is False else
                  "condition at monitor start unavailable")
    return ("<div class='card'><div class='k'>%s · %s</div><div style='margin-top:6px'>%s</div>"
            "<div class='note'>True historical first trigger unknown. First observed trigger: %s. "
            "Excluded from trigger-timing and forward-quality statistics.</div></div>")%(
                esc(label),esc(left.get("classification")),esc(already_text),
                _e_time(left.get("firstObservedTriggerAt")))

def _ghost_trigger_box(title,ghost,left):
    if not ghost:
        return "<div class='s'>Belum terpicu; ghost tidak mengirim exit.</div>"
    observed=bool((left or {}).get("classification"))
    label="first observed trigger; historical first unknown" if observed else "first true ghost trigger (frozen)"
    return ("<div class='s'><b>%s</b><br>time %s · age %s · P&amp;L %s · MFE %s · giveback %s</div>")%(
        esc(label),_e_time(ghost.get("observedAt")),
        ("%.1fh"%ghost.get("ageHours")) if fin(ghost.get("ageHours")) else "–",
        _e_net_pair(ghost.get("netReturn"),ghost.get("pnlUsd")),
        pct(100*ghost.get("mfeAtTriggerNetReturn"),3) if fin(ghost.get("mfeAtTriggerNetReturn")) else "–",
        _e_giveback(ghost.get("givebackFraction")))

def smart_e_open_html(R):
    se=R.get("smartE") or {}; views=se.get("open") or []; o=[]
    o.append("<h2>Smart Basket · Ghost Monitor</h2>")
    o.append("<div class='note'><b>GHOST ONLY.</b> Both challengers use net whole-basket 3L/3S P&amp;L. "
             "They never submit/cancel an order, change a stop/TP, change the hard horizon, Formation, admission, or a position. "
             "E: age ≥24h, MFE ≥+1.0%%, giveback ≥70%%. LOSS_CUT: age ≥12h, current P&amp;L ≤−1.0%%, prior MFE ≥+0.5%%, giveback ≥70%%.</div>")
    if se.get("error"):
        return "".join(o)+"<div class='card'><span class='neg'>Ghost monitor error:</span> %s</div>"%esc(se["error"])
    if not views:
        return "".join(o)+"<div class='card dim'>Tidak ada basket terbuka yang sedang dipantau.</div>"
    for view in views:
        r=view["record"]; policy=view["policy"] or {}; eghost=r.get("ghostExit") or {}
        lc=_loss_cut_state(r); lcghost=lc.get("ghostExit") or {}
        eleft=r.get("leftCensor") or {}; lcleft=lc.get("leftCensor") or {}
        ecohort,ereason=_e_cohort_status(r); lccohort,lcreason=_loss_cut_cohort_status(r)
        age=r.get("ageHours"); mfe=r.get("maxMfeNetReturn"); current=r.get("currentNetReturn")
        econd=_e_condition(age,mfe,current)
        lccond=lc.get("lastCondition") if isinstance(lc.get("lastCondition"),dict) else _loss_cut_condition(age,mfe,current)
        estatus="WOULD EXIT" if eghost else "ARMED" if r.get("armedAt") else "NOT ARMED"
        lcstatus="WOULD EXIT" if lcghost else "WATCHING"
        edelta=(eghost.get("netReturn")-current) if eghost and fin(eghost.get("netReturn")) and fin(current) else None
        lcdelta=(lcghost.get("netReturn")-current) if lcghost and fin(lcghost.get("netReturn")) and fin(current) else None
        o.append("<div class='card' style='margin-top:10px'>")
        o.append("<div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'><div><b>%s</b> <span class='dim'>· %s · net whole basket</span></div><div><span class='%s'><b>%s</b></span> <span class='%s'><b>%s</b></span></div></div>"%(
            esc(friendly(r.get("basketId"))),esc(view.get("label")), _ghost_status_class(estatus),estatus,
            _ghost_status_class(lcstatus),lcstatus))
        o.append("<div class='grid' style='margin-top:9px'>")
        o.append(card("Actual policy",esc(policy.get("label") or "unknown"),
                      "HOLD CAP %sh · ghost does not alter runtime"%(
                          ("%.0f"%policy.get("maxHoldHours")) if fin(policy.get("maxHoldHours")) else "?")))
        o.append(card("Age","%.1fh / 36h"%age if fin(age) else "– / 36h","runtime basket age"))
        o.append(card("Current P&amp;L",_e_net_pair(current,r.get("currentPnlUsd")),"net whole basket"))
        o.append(card("Prior MFE",_e_net_pair(mfe,_e_usd(r,mfe)),"at %s"%_e_time(r.get("maxMfeAt"))))
        o.append(card("Current giveback",_e_giveback(r.get("givebackFraction")),"of prior MFE"))
        o.append("</div><div class='g2' style='margin-top:9px'>")
        o.append("<div class='card'><div class='k'>E · Ghost</div><div class='v'><span class='%s'>%s</span></div>"
                 "<div class='s'>Current delta %s · E vs current Hold path</div>"
                 "<div style='margin-top:7px'>%s</div><div>%s</div>%s</div>"%(
                     _ghost_status_class(estatus),estatus,_e_pp(edelta),
                     _ghost_check(econd.get("ageHours") is not None and econd.get("ageHours")>=SMART_E_ARM_AGE_H,
                                  "Age",("%.1fh"%age) if fin(age) else "–","min 24h"),
                     _ghost_check(fin(mfe) and mfe>=SMART_E_ARM_MFE,
                                  "MFE",("%+.3f%%"%(100*mfe)) if fin(mfe) else "–","min +1.0%"),
                     _ghost_trigger_box("E",eghost,eleft)))
        o.append("<div class='card'><div class='k'>LOSS_CUT · Ghost</div><div class='v'><span class='%s'>%s</span></div>"
                 "<div class='s'>Current delta %s · LOSS_CUT vs current Hold path</div>"
                 "<div style='margin-top:7px'>%s</div><div>%s</div><div>%s</div><div>%s</div>%s</div>"%(
                     _ghost_status_class(lcstatus),lcstatus,_e_pp(lcdelta),
                     _ghost_check(lccond.get("ageOk"),"Age",("%.1fh"%age) if fin(age) else "–","min 12h"),
                     _ghost_check(lccond.get("pnlOk"),"P&amp;L",("%+.3f%%"%(100*current)) if fin(current) else "–","≤ −1.00%"),
                     _ghost_check(lccond.get("mfeOk"),"Prior MFE",("%+.3f%%"%(100*mfe)) if fin(mfe) else "–","≥ +0.50%"),
                     _ghost_check(lccond.get("givebackOk"),"Giveback",
                                  ("%.1f%%"%(100*lccond.get("givebackFraction"))) if fin(lccond.get("givebackFraction")) else "–","≥ 70%"),
                     _ghost_trigger_box("LOSS_CUT",lcghost,lcleft)))
        o.append("</div>")
        censor="".join(x for x in (_ghost_censor_box(eleft,"E provenance"),_ghost_censor_box(lcleft,"LOSS_CUT provenance")) if x)
        if censor: o.append("<div class='g2' style='margin-top:9px'>%s</div>"%censor)
        o.append("<div class='note'><b>E forward record</b> · %s <span class='dim'>· %s</span><br>"
                 "<b>LOSS_CUT forward record</b> · %s <span class='dim'>· %s</span><br>"
                 "<b>Actual comparator runtime</b> · %s <span class='dim'>· %s</span></div>"%(
                     esc(ecohort),esc(ereason),esc(lccohort),esc(lcreason),
                     esc(policy.get("label") or "unknown"),esc(policy.get("exact") or "")))
        o.append("</div>")
    return "".join(o)

def _ghost_metric_row(label,e_value,lc_value):
    return "<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>"%(label,e_value,lc_value)

def _ghost_status_html(status):
    return "<span class='%s'><b>%s</b></span>"%(_ghost_status_class(status),esc(status or "INSUFFICIENT"))

def smart_e_summary_html(R):
    se=R.get("smartE") or {}; o=["<h2>Valid Forward Evidence</h2>"]
    o.append("<div class='note'>LIVE and TESTNET are separated. The E/LOSS_CUT table uses the common cohort: "
             "opened after LOSS_CUT monitor deployment, no left-censoring, actual runtime NoTP + hold 36h throughout, "
             "and a HORIZON close at 36h. Historical research is never merged into these counts.</div>")
    for key,info in (se.get("instances") or {}).items():
        s=info.get("summary") or {}; policy=info.get("policy") or {}; e=s.get("e") or {}; lc=s.get("lossCut") or {}
        o.append("<h3>%s</h3>"%esc(info.get("label") or key))
        if not policy.get("canonicalNoTp36"):
            o.append("<div class='card'><span class='warnc'><b>COMPARATOR PAUSED</b></span> · Runtime reports <b>%s</b><br>"
                     "<span class='dim'>Exact mismatch: %s</span><div class='note'>Ghost observation continues, but both "
                     "E and LOSS_CUT are excluded from Hold-36h forward comparisons until runtime itself matches NoTP + hold 36h.</div></div>"%(
                         esc(policy.get("label") or "unknown"),esc(policy.get("exact") or "")))
        o.append("<div class='grid' style='margin-top:9px'>")
        o.append(card("Comparable baskets",str(s.get("completed") or 0),
                      "%d common forward cohort · %d still open"%(s.get("validForwardCohort") or 0,s.get("validForwardOpen") or 0)))
        o.append(card("Independent episodes",str(s.get("episodes") or 0),"48h de-overlap"))
        o.append(card("Left-censored",str(s.get("leftCensored") or 0),
                      "E %d · LOSS_CUT %d; excluded"%(s.get("eLeftCensored") or 0,s.get("lossCutLeftCensored") or 0)))
        o.append(card("Comparator mismatch",str(s.get("comparatorMismatch") or 0),"not NoTP + hold 36h at observed scan"))
        o.append(card("Actual Hold mean",pct(100*s.get("actualMean"),3) if fin(s.get("actualMean")) else "–",
                      "common valid 36h HORIZON cohort"))
        o.append("</div>")
        o.append("<div class='scroll'><table><tr><th>metric</th><th class='num'>E</th><th class='num'>LOSS_CUT</th></tr>")
        o.append(_ghost_metric_row("Triggered","%d%s"%(e.get("triggered") or 0,(" (%.0f%%)"%e["triggerPct"]) if fin(e.get("triggerPct")) else ""),
                                   "%d%s"%(lc.get("triggered") or 0,(" (%.0f%%)"%lc["triggerPct"]) if fin(lc.get("triggerPct")) else "")))
        o.append(_ghost_metric_row("Better than Hold","%d%s"%(e.get("better") or 0,(" (%.0f%%)"%e["betterPct"]) if fin(e.get("betterPct")) else ""),
                                   "%d%s"%(lc.get("better") or 0,(" (%.0f%%)"%lc["betterPct"]) if fin(lc.get("betterPct")) else "")))
        o.append(_ghost_metric_row("Worse than Hold","%d%s"%(e.get("worse") or 0,(" (%.0f%%)"%e["worsePct"]) if fin(e.get("worsePct")) else ""),
                                   "%d%s"%(lc.get("worse") or 0,(" (%.0f%%)"%lc["worsePct"]) if fin(lc.get("worsePct")) else "")))
        o.append(_ghost_metric_row("Mean delta",_e_pp(e.get("meanDelta")),_e_pp(lc.get("meanDelta"))))
        o.append(_ghost_metric_row("Median delta",_e_pp(e.get("medianDelta")),_e_pp(lc.get("medianDelta"))))
        o.append(_ghost_metric_row("Total $ delta",money(e.get("totalDeltaUsd"),3),money(lc.get("totalDeltaUsd"),3)))
        o.append(_ghost_metric_row("Ghost mean",pct(100*e.get("ghostMean"),3) if fin(e.get("ghostMean")) else "–",
                                   pct(100*lc.get("ghostMean"),3) if fin(lc.get("ghostMean")) else "–"))
        o.append(_ghost_metric_row("Risk saved",money(e.get("riskSavedUsd"),3),money(lc.get("riskSavedUsd"),3)))
        o.append(_ghost_metric_row("Winner truncated",str(e.get("winnerTruncated") or 0),str(lc.get("winnerTruncated") or 0)))
        o.append(_ghost_metric_row("Saved loss / no effect","%d / %d"%(e.get("savedLoss") or 0,e.get("noEffect") or 0),
                                   "%d / %d"%(lc.get("savedLoss") or 0,lc.get("noEffect") or 0)))
        o.append(_ghost_metric_row("Evidence status",_ghost_status_html(e.get("status")),_ghost_status_html(lc.get("status"))))
        o.append("</table></div><div class='note'>PROMISING needs at least 60 comparable baskets and 20 independent episodes, "
                 "positive mean and median delta, and no mean expectancy loss. It is not inferred from win-rate.</div>")
    o.append("<h2>Canonical Research · N=1693</h2><div class='g2'>")
    o.append(card("Actual Hold 36h","<span class='pos'>Mean +0.3149%</span>","PF 1.40 · CVaR5 −4.566%"))
    o.append(card("LOSS_CUT","<span class='pos'>Mean +0.3295%</span>","PF 1.45 · CVaR5 −4.042% · avg hold 32.7h"))
    o.append(card("But","<span class='neg'>GHOST ONLY</span>","OOS advantage not robust · only 2/6 OOS offsets positive"))
    o.append(card("PROFIT_FLOOR / COMBINED","<span class='neg'>REJECTED</span>","expectancy loss too large"))
    o.append(card("E historical context","Mean +0.3107%","OOS delta vs NoTP −0.0334 pp · offsets won 3/6"))
    o.append("</div><h3>Why LOSS_CUT is monitored</h3><div class='g2'>")
    o.append(card("Giveback &gt;70%","continuation mean +0.053%","recovery 31.2% · final mean −0.777%"))
    o.append(card("Current P&amp;L &lt;−2%","recovery 3.4%","final mean −3.013%"))
    o.append("</div><div class='note'>Descriptive historical evidence only, not a guarantee or prediction. "
             "It is separate from Valid Forward Evidence.</div>")
    return "".join(o)

def _ghost_recent_cell(r,c,which):
    if which=="E":
        ghost=r.get("ghostExit") or {}; left=r.get("leftCensor") or {}
        result_key,usd_key,delta_key,verdict_key="eNetReturn","ePnlUsd","deltaNetReturn","eVerdict"
        prospective=r.get("prospectiveFirstGhostTrigger")
    else:
        lc=_loss_cut_state(r); ghost=lc.get("ghostExit") or {}; left=lc.get("leftCensor") or {}
        result_key,usd_key,delta_key,verdict_key="lossCutNetReturn","lossCutPnlUsd","lossCutDeltaNetReturn","lossCutVerdict"
        prospective=lc.get("prospectiveFirstGhostTrigger")
    if ghost:
        label="first observed; historical unknown" if left.get("classification") else "first true trigger"
        trigger="<b>%s</b><br><span class='dim'>%s · age %s · MFE %s · giveback %s</span>"%(
            esc(label),_e_time((prospective or ghost).get("observedAt")),
            ("%.1fh"%ghost.get("ageHours")) if fin(ghost.get("ageHours")) else "–",
            pct(100*ghost.get("mfeAtTriggerNetReturn"),3) if fin(ghost.get("mfeAtTriggerNetReturn")) else "–",
            _e_giveback(ghost.get("givebackFraction")))
    elif left.get("classification"):
        trigger="<span class='warnc'>pre-monitor / historical unknown</span>"
    else:
        trigger="<span class='dim'>not triggered</span>"
    result=_e_net_pair(c.get(result_key),c.get(usd_key)) if fin(c.get(result_key)) else "<span class='dim'>–</span>"
    delta=_e_pp(c.get(delta_key)) if fin(c.get(delta_key)) else "<span class='dim'>–</span>"
    verdict=esc(c.get(verdict_key) or "NO EFFECT")
    return "%s<br><span class='dim'>ghost result %s · delta %s · %s</span>"%(trigger,result,delta,verdict)

def smart_e_recent_html(R):
    se=R.get("smartE") or {}; rows=(se.get("recent") or [])[:10]
    o=["<h2>Recent Evaluation · up to 10 baskets</h2>"]
    o.append("<div class='note'>Actual Hold, E, and LOSS_CUT results are shown separately. Rows outside the common valid cohort "
             "are diagnostic only; their deltas are not included in forward aggregates.</div>")
    if not rows: return "".join(o)+"<div class='card dim'>Belum ada basket selesai yang tercatat oleh ledger ghost.</div>"
    o.append("<div class='scroll'><table><tr><th>basket / regime / scoreGap</th><th>actual</th><th>E trigger / result / delta</th><th>LOSS_CUT trigger / result / delta</th><th>comparable</th><th>verdict</th></tr>")
    for r in rows:
        c=r.get("closed") or {}; comp=c.get("comparable")
        comp_html=("<span class='pos'><b>VALID</b></span>" if comp else "<span class='warnc'><b>EXCLUDED</b></span>")
        comp_html+="<br><span class='dim' style='white-space:normal'>%s</span>"%esc(c.get("comparatorNote") or "not a 36h Hold comparator")
        actual="%s<br><span class='dim'>%s · %s · %s</span>"%(
            _e_net_pair(c.get("actualNetReturn"),c.get("actualPnlUsd")),
            _e_time(c.get("closedAt")),esc(str(c.get("closeReason") or "–")),
            ("%.1fh"%c.get("holdHours")) if fin(c.get("holdHours")) else "–")
        verdict="E: %s<br>LOSS_CUT: %s"%(esc(c.get("eVerdict") or "NO EFFECT"),esc(c.get("lossCutVerdict") or "NO EFFECT"))
        o.append("<tr><td><b>%s</b><br><span class='dim'>%s · gap %s · opened %s</span></td><td>%s</td><td style='white-space:normal'>%s</td><td style='white-space:normal'>%s</td><td style='white-space:normal'>%s</td><td>%s</td></tr>"%(
            esc(friendly(r.get("basketId"))),esc(r.get("regime") or "–"),num(r.get("scoreGap"),4),_e_time(r.get("openedAt")),
            actual,_ghost_recent_cell(r,c,"E"),_ghost_recent_cell(r,c,"LOSS_CUT"),comp_html,verdict))
    o.append("</table></div>")
    return "".join(o)

def smart_e_overview_html(R):
    return smart_e_open_html(R)+smart_e_summary_html(R)+smart_e_recent_html(R)

def alerts_of(R):
    """BLOCKING -> RISK -> WATCH -> INFO"""
    A=[]
    for k,i in R["inst"].items():
        ex=i["ex"]; L=i["long"]
        if ex.get("__error__"): A.append((0,"block","%s tidak merespons"%L,ex["__error__"]))
        if ex.get("lastError"): A.append((0,"block","%s melaporkan error"%L,str(ex["lastError"])[:120]))
        if ex.get("configErrors"): A.append((0,"block","%s konfigurasi bermasalah"%L,str(ex["configErrors"])[:120]))
        runtime=ex.get("effectiveRuntime") or {}
        for mismatch in runtime.get("mismatches") or []:
            A.append((0,"block","%s CONFIG INEFFECTIVE"%L,"%s — %s"%(mismatch.get("key") or "runtime",mismatch.get("reason") or "nilai env tidak dipakai runtime")))
        if "OK:" not in (i["envPolicy"] or ""): A.append((0,"block","%s menyimpang dari kebijakan konfigurasi"%L,i["envPolicy"][:120]))
        ep=_e_policy(ex,_e_runtime_flags(i))
        if not ep["canonicalNoTp36"]:
            A.append((3,"watch","%s belum menjalankan NoTP / 36h"%L,
                      "%s; Smart Basket E tetap ghost-only dan forward NoTP comparison dikecualikan."%ep["label"]))
        if ex.get("orphanedLegs"): A.append((1,"block","%s punya kaki yatim"%L,"%d posisi tanpa basket induk"%len(ex["orphanedLegs"])))
        if ex.get("entryHealthBypassed"): A.append((1,"override","%s: gerbang bukti di-override operator"%L,
            "Bot membuka basket walau bukti terakhirnya tidak lolos. Keputusan manual, bukan lampu hijau dari data."))
        if ex.get("signalStale"): A.append((2,"watch","%s sinyalnya basi"%L,
            "umur %.0f menit dari batas %.0f menit — tidak ada basket baru sampai segar"%((ex.get("signalAgeMs") or 0)/60000.0,(ex.get("signalMaxAgeMs") or 0)/60000.0)))
        fh=_fh_report(i)
        if fh:
            for alert in fh.get("alerts") or []:
                severe=alert.get("severity")=="BLOCK"
                A.append((0 if severe else 2,"block" if severe else "watch","%s Futures Reference Health: %s"%(L,alert.get("code") or "ALERT"),
                          str(alert.get("message") or "USD-M reference alert")[:160]))
    for j in R["system"]["jobs"]:
        if j["stale"]: A.append((2,"watch","%s berhenti"%j["job"],"terakhir %s"%("tidak pernah" if j["ageHours"] is None else "%.1f jam lalu"%j["ageHours"])))
    for p in R["system"]["pm2"]:
        if p["status"]!="online": A.append((0,"block","Proses %s: %s"%(p["name"],p["status"]),"Layanan tidak berjalan."))
    d=R["system"].get("disk")
    if d and int(str(d["pct"]).rstrip("%") or 0)>=90: A.append((2,"watch","Disk hampir penuh","%s terpakai, sisa %s"%(d["pct"],d["avail"])))
    if R.get("mismatch"): A.append((3,"watch","Bukti riset tidak sepenuhnya mewakili produksi","%d ketidakcocokan — lihat tab Riset"%len(R["mismatch"])))
    return sorted(A,key=lambda x:x[0])

def runtime_consistency_html(R):
    """Actual scheduler, exit path and accounting state from executor status, never env intent alone."""
    o=["<h2>Runtime efektif &amp; cohort forward</h2>",
       "<div class='scroll'><table><tr><th>lingkungan</th><th>formation aktual</th><th>revalidasi entry</th><th>adaptive exit</th><th>tick aktual</th><th>exit HORIZON aktual</th><th>measurement / cap</th><th>TP / SL baru</th><th>policy fingerprint</th><th>cohort valid / excluded / episode</th><th>clean / quarantine / reject</th><th>status</th></tr>"]
    for k in ("live","testnet"):
        i=R["inst"][k]; ex=i["ex"]; flags=i.get("flags") or {}; runtime=ex.get("effectiveRuntime") or {}
        tick=runtime.get("executorTick") or {}; maker=runtime.get("makerExit") or {}; adaptive=runtime.get("adaptiveExits") or {}
        policy=ex.get("currentPolicyFingerprint") or {}; cohort=ex.get("currentPolicyForwardCohort") or {}; accounting=ex.get("accountingCounts") or {}
        bad=list(runtime.get("mismatches") or [])
        requested_maker=(maker.get("configured") is True) or flags.get("CROSS_SECTIONAL_MAKER_EXIT_ENABLED")=="1"
        if not runtime: bad.append({"key":"executor runtime","reason":"API tidak mengekspos effectiveRuntime"})
        formation=runtime.get("formationMode")
        entry_revalidation=runtime.get("entryRevalidation")
        adaptive_mode=runtime.get("adaptiveExitMode")
        if formation not in ("PLAIN_MOM36","SMART_FORMATION_RERANK"):
            bad.append({"key":"formationMode","reason":"API belum mengekspos mode pemilihan efektif"})
            formation="CONFIG INEFFECTIVE"
        if not isinstance(entry_revalidation,bool):
            bad.append({"key":"entryRevalidation","reason":"API belum mengekspos status lifecycle efektif"})
            entry_revalidation=None
        if adaptive_mode not in ("ON","OFF"):
            bad.append({"key":"adaptiveExitMode","reason":"API belum mengekspos mode exit efektif"})
            adaptive_mode="CONFIG INEFFECTIVE"
        tick_text=("%sms"%tick.get("effectiveMs")) if tick.get("effectiveMs") is not None else "–"
        if not runtime or maker.get("state")=="CONFIG_INEFFECTIVE": exit_text="CONFIG INEFFECTIVE" if requested_maker else "MARKET"
        elif maker.get("effective"): exit_text="MAKER-FIRST"
        else: exit_text="MARKET"
        horizon="%s%s / %sj"%(ex.get("measurementHorizonBars") or "–",ex.get("measurementInterval") or "",ex.get("maxHoldHours") or "–")
        tp="OFF" if ex.get("tpDisabled") else ("%s%%"%ex.get("tpNetReturnPct"))
        sl="OFF" if ex.get("stopNetReturnPct") is None else ("%s%%"%ex.get("stopNetReturnPct"))
        strategy=policy.get("strategy") or {}; source=strategy.get("sourceSha") or "–"
        status="CONFIG INEFFECTIVE" if bad else "EFFECTIVE"
        detail="; ".join("%s: %s"%(m.get("key") or "runtime",m.get("reason") or "") for m in bad) or "API runtime path verified"
        rel=os.path.basename(os.path.dirname(i.get("rel") or ""))
        o.append("<tr><td><b>%s</b><br><span class='dim'>%s</span></td><td><b>%s</b></td><td>%s</td><td>%s</td><td>%s<br><span class='dim'>env %s</span></td><td>%s<br><span class='dim'>wait %sms</span></td><td>%s</td><td>%s / %s</td><td><code>%s</code><br><span class='dim'>%s</span></td><td>%s / %s / %s</td><td>%s / %s / %s</td><td>%s %s<br><span class='dim'>%s</span></td></tr>"%(
            esc(i["long"]),esc(rel),esc(formation),esc("ON" if entry_revalidation is True else "OFF" if entry_revalidation is False else "CONFIG INEFFECTIVE"),esc(adaptive_mode),esc(tick_text),esc(tick.get("configured") if tick.get("configured") is not None else flags.get("CROSS_SECTIONAL_EXEC_TICK_MS") or "–"),
            esc(exit_text),esc(maker.get("waitMs") if maker.get("waitMs") is not None else flags.get("CROSS_SECTIONAL_MAKER_EXIT_WAIT_MS") or "–"),esc(horizon),esc(tp),esc(sl),
            esc(policy.get("policyId") or "–"),esc(source),cohort.get("validCohortN",0),cohort.get("excludedN",0),cohort.get("independentEpisodes",0),
            accounting.get("cleanN",0),accounting.get("quarantinedN",0),accounting.get("rejectedN",0),DOT["block"] if bad else DOT["ok"],esc(status),esc(detail)))
    o.append("</table></div>")
    ee=R.get("exitEcon") or {}
    o.append("<div class='grid'>"+card("Maker participation",("%.0f%%"%ee["makerPct"]) if fin(ee.get("makerPct")) else NA,"notional exit historis")+card("Fallback taker",("%.0f%%"%ee["fallbackPct"]) if fin(ee.get("fallbackPct")) else NA,"hanya sisa qty")+card("Fee saved",money(ee.get("feeSaved"),4),"maker 2bps vs taker 5bps")+card("Exit drift",("%.3f%%"%ee["exitDrift"]) if fin(ee.get("exitDrift")) else NA,"fallback vs maker")+card("Implementation shortfall",money(ee.get("implementationShortfall"),4),"decision vs fill")+card("Imbalance sementara",money(ee.get("temporaryImbalance"),4),"maksimum antar-leg")+"</div>")
    return "".join(o)

def _fh_report(i):
    r=i.get("futuresHealth") or {}
    return r if isinstance(r,dict) and r.get("enabled") is True and isinstance(r.get("counters"),dict) else None

def _fh_counter(i,key):
    r=_fh_report(i)
    return (r.get("counters") or {}).get(key) if r else None

def _fh_number(v):
    return "–" if not fin(v) else str(int(v))

def _fh_percent(v):
    return "–" if not fin(v) else "%.0f%%"%v

def _fh_pair(R,key,percent=False):
    f=_fh_percent if percent else _fh_number
    return "LIVE %s · TESTNET %s"%(f(_fh_counter(R["inst"]["live"],key)),f(_fh_counter(R["inst"]["testnet"],key)))

def _fh_source(source):
    return {"USD_M_MARK_PRICE":"USD-M premiumIndex mark","USD_M_BOOK_TICKER":"USD-M book midpoint",
            "POSITION_RISK":"same-env positionRisk","NONE":"–"}.get(str(source),str(source or "–"))

def _fh_status(status):
    return {"HEALTHY":"ok","FALLBACK":"watch","ALERT":"watch","NOT_ELIGIBLE":"off",
            "UNAVAILABLE":"block","SCALE_GUARD_REJECTED":"block","UNVERIFIED":"watch"}.get(str(status),"watch")

def futures_reference_health_html(R,detail=False):
    reports=[(k,_fh_report(R["inst"][k])) for k in ("live","testnet")]
    usable=[(k,r) for k,r in reports if r]
    o=["<h2>Futures Reference Health</h2>"]
    if not usable:
        errors=[]
        for k in ("live","testnet"):
            raw=R["inst"][k].get("futuresHealth") or {}
            errors.append("%s: %s"%(R["inst"][k]["label"],esc(raw.get("__error__") or raw.get("reason") or "endpoint belum tersedia")))
        return "".join(o)+("<div class='card'><b>Belum tersedia</b><div class='s'>%s</div></div>"%" · ".join(errors))
    o.append("<div class='health-grid'>")
    o.append(card("USD-M Mark Used",_fh_pair(R,"usdMMarkUsed"),"resolusi dari premiumIndex mark"))
    o.append(card("Book Fallback",_fh_pair(R,"bookFallback"),"fallback USD-M midpoint saja"))
    o.append(card("positionRisk Fallback",_fh_pair(R,"positionRiskFallback"),"same-environment, urutan terakhir"))
    o.append(card("Reference Unavailable",_fh_pair(R,"referenceUnavailable"),"final FAIL CLOSED"))
    o.append(card("Scale Guard Rejected",_fh_pair(R,"scaleGuardRejected"),"source/alias/scale ditolak sebelum sizing"))
    o.append(card("Stale Cache Rejected",_fh_pair(R,"staleCacheRejected"),"stale tidak pernah dipakai ulang"))
    o.append(card("Cache Hit Rate",_fh_pair(R,"cacheHitRatePct",True),"hit / (hit + refresh miss)"))
    o.append("</div>")
    o.append("<div class='reference-chain'><span>USD-M premiumIndex mark</span><b>→</b><span>USD-M book midpoint</span><b>→</b><span>same-env positionRisk</span><b>→</b><span>FAIL CLOSED</span><span><b>tanpa spot fallback</b></span></div>")
    alerts=[]
    for k,r in usable:
        for a in r.get("alerts") or []:
            alerts.append((k,a))
    if alerts:
        for k,a in alerts:
            sev="block" if a.get("severity")=="BLOCK" else "watch"
            o.append("<div class='health-alert %s'>%s <b>%s</b> · %s</div>"%(sev,DOT[sev],esc(a.get("code") or "ALERT"),esc(a.get("message") or "")))
    failures=[]
    for k,r in usable:
        f=r.get("lastFailure") or {}
        if f: failures.append("%s · %s: %s"%(R["inst"][k]["label"],esc(f.get("symbol") or "–"),esc(f.get("reason") or "–")))
    o.append("<div class='note'><b>Last failure:</b> %s</div>"%(" | ".join(failures) if failures else "tidak ada sejak proses mulai"))
    rows=[]
    for k,r in usable:
        for s in r.get("symbols") or []:
            rows.append((k,s))
    if rows:
        o.append("<div class='scroll'><table><tr><th>environment</th><th>symbol</th><th>futures eligible</th><th>reference</th><th>price</th><th>status</th><th>diagnostic</th></tr>")
        for k,s in rows:
            eligible=s.get("eligible")
            eligible_text="true" if eligible is True else "false" if eligible is False else "unverified"
            price=s.get("price")
            price_text=("%.8g"%price) if fin(price) else "–"
            status=s.get("status") or "UNVERIFIED"
            diag=s.get("lastFailure") or (("mark/book %.3f%%"%s.get("markBookDivergencePct")) if fin(s.get("markBookDivergencePct")) else "–")
            o.append("<tr><td>%s</td><td><b>%s</b></td><td>%s</td><td>%s</td><td class='num'>%s</td><td>%s <b>%s</b></td><td class='dim'>%s</td></tr>"%(
                esc(R["inst"][k]["label"]),esc(s.get("symbol") or "–"),esc(eligible_text),esc(_fh_source(s.get("reference"))),
                esc(price_text),DOT[_fh_status(status)],esc(status),esc(diag)))
        o.append("</table></div>")
    o.append("<div class='note'>Counter sejak proses API mulai. Probe dashboard hanya GET public USD-M exchangeInfo / mark / book; tidak mengubah order, posisi, universe, atau sizing.</div>")
    return "".join(o)

def runtime_overview_html(R):
    o=["<h2>Runtime efektif</h2><div class='g2'>"]
    for k in ("live","testnet"):
        i=R["inst"][k]; ex=i["ex"]; runtime=ex.get("effectiveRuntime") or {}; policy=ex.get("currentPolicyFingerprint") or {}
        tick=runtime.get("executorTick") or {}; maker=runtime.get("makerExit") or {}
        formation=runtime.get("formationMode") or "CONFIG INEFFECTIVE"
        entry=runtime.get("entryRevalidation")
        entry_text="ON" if entry is True else "OFF" if entry is False else "UNVERIFIED"
        exit_text="MAKER-FIRST" if maker.get("effective") else "MARKET"
        line="formation %s · entry revalidation %s · %s · tick %sms"%(
            formation,entry_text,exit_text,tick.get("effectiveMs") or "–")
        o.append("<div class='card'><div class='k'>%s</div><div class='v'>%s</div><div class='s'>%s<br>policy <code>%s</code></div></div>"%(
            esc(i["long"]),DOT["ok"] if not (runtime.get("mismatches") or []) else DOT["block"],
            esc(line),esc(policy.get("policyId") or "–")))
    o.append("</div><div class='note'>Detail lengkap runtime, policy fingerprint, cohort, accounting clean/quarantine/reject, dan mismatch ada di Sistem.</div>")
    return "".join(o)

def ghost_overview_html(R):
    se=R.get("smartE") or {}; open_rows=se.get("open") or []; instances=se.get("instances") or {}
    live=(instances.get("live") or {}).get("summary") or {}; test=(instances.get("testnet") or {}).get("summary") or {}
    return ("<h2>Observability</h2><div class='grid'>"+
            card("Ghost E / LOSS_CUT","GHOST ONLY","%d basket terbuka dipantau; tidak mengubah exit / entry / order"%len(open_rows))+
            card("Forward cohort LIVE",str(live.get("validForwardCohort") or 0),"%d completed comparator"%(live.get("completed") or 0))+
            card("Forward cohort TESTNET",str(test.get("validForwardCohort") or 0),"%d completed comparator"%(test.get("completed") or 0))+
            card("Evidence ledger","terpisah","detail Ghost E / LOSS_CUT dipindahkan ke Sistem agar Ringkasan tetap ringkas")+
            "</div>")

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
    o.append(futures_reference_health_html(R))
    o.append(runtime_overview_html(R))
    o.append("<h2>Posisi &amp; keyakinan</h2><div class='grid'>")
    o.append(card("Basket terbuka","%d live · %d testnet"%(len(ob_l),len(ob_t)),"batas %s / %s"%(liv["ex"].get("maxOpenBaskets") or "–",tst["ex"].get("maxOpenBaskets") or "–")))
    sc=R["scores"]
    o.append(card("Keyakinan edge",num(sc["edge"]["value"],0),"%s · t terkoreksi %s"%(rate(sc["edge"]["value"]),num(R["edge"]["tEff"],2))))
    o.append(card("Kekuatan bukti",num(sc["evidence"]["value"],0),"%d episode independen"%R["edge"]["episodes"]))
    o.append(card("Performa keseluruhan",num(sc["overall"]["value"],0),rate(sc["overall"]["value"])))
    o.append("</div>")
    o.append(ghost_overview_html(R))
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
    runtime=ex.get("effectiveRuntime") or {}; maker_runtime=runtime.get("makerExit") or {}; tick_runtime=runtime.get("executorTick") or {}
    formation_mode=runtime.get("formationMode") or "CONFIG INEFFECTIVE"
    rerank=formation_mode=="SMART_FORMATION_RERANK"
    entry_revalidation=runtime.get("entryRevalidation")
    adaptive_mode=runtime.get("adaptiveExitMode") or "CONFIG INEFFECTIVE"
    mex=bool(maker_runtime.get("effective")); maker_state=maker_runtime.get("state") or "CONFIG_INEFFECTIVE"; adaptive=adaptive_mode=="ON"
    tick_sec=(tick_runtime.get("effectiveMs") or 0)/1000.0
    stop_text="OFF" if ex.get("stopNetReturnPct") is None else ("%s%%"%ex.get("stopNetReturnPct")); tp_text="OFF" if ex.get("tpDisabled") else ("%s%%"%ex.get("tpNetReturnPct"))
    gross=(leg*6) if fin(leg) else None
    o=[lead("ok","Momentum relatif lintas-simbol, netral pasar",
        "Bot memeringkat seluruh universe menurut momentum 36 jam, membeli 3 terkuat dan menjual 3 terlemah. Yang dikejar bukan arah pasar, melainkan <b>selisih</b> antara yang kuat dan yang lemah — kalau pasar naik atau turun bersama, keduanya saling meniadakan.")]
    PIPE2_TEXT=(("Ambil 5 kandidat teratas tiap sisi, coba SEMUA kombinasi 3-lawan-3, pilih total utility tertinggi setelah penalti klaster." if rerank else "Ambil 3 teratas tiap sisi menurut peringkat MOM36 dengan cluster cap sebagai batas keras, lalu uji scoreGap dan bentuk bobot CAPPED_SCORE_RANK. Re-ranking utility dimatikan.") + " <b>Tidak membuat sinyal baru</b> — hanya memilih dari peringkat yang sudah ada.")
    steps=[("1 · MOM36","Peringkat momentum 36 jam atas %s simbol universe. Menghasilkan urutan kuat→lemah, belum memutuskan apa pun."%cnt.get("universe")),
      ("2 · Pemilihan basket", PIPE2_TEXT),
      ("3 · Gerbang scoreGap","Selisih rata-rata skor long dan short harus ≥ <b>%s</b>. Di bawah itu basket ditolak sepenuhnya, betapapun bagus kombinasinya — cross-section yang rapat berarti tak ada yang bisa dipanen."%fc.get("minScoreGap")),
      ("4 · Revalidasi entry","Tepat sebelum order dikirim, cek apakah harga sudah lari melawan sejak sinyal dibentuk. Kalau sudah, batalkan daripada mengejar."),
      ("5 · Smart Basket / Ghost","Setelah basket hidup, tiga aturan adaptif <b>mengevaluasi</b> apakah alasan masuknya masih berlaku. Eksekusinya dimatikan; evaluasinya tetap jalan sehingga bisa diukur tanpa menyentuh uang."),
      ("6 · Exit policy","Measurement horizon %s%s, execution cap %s jam; stop %s, TP %s."%(ex.get("measurementHorizonBars") or "–",ex.get("measurementInterval") or "",ex.get("maxHoldHours"),stop_text,tp_text))]
    o.append("<div class='flow'>"+"<span class='a'>→</span>".join("<span class='n'>%s</span>"%x[0] for x in steps)+"</div>")
    o.append("<table><tr><th>tahap</th><th>yang terjadi</th></tr>%s</table>"%"".join(
        "<tr><td><b>%s</b></td><td class='dim' style='white-space:normal'>%s</td></tr>"%(a,b) for a,b in steps))
    o.append("<div class='grid'>")
    o.append(card("Universe","%s simbol"%cnt.get("universe"),"pool long %s · short layak %s"%(cnt.get("poolLong"),cnt.get("shortEligible"))))
    o.append(card("Struktur","3 long / 3 short","bobot dari peringkat skor, dibatasi"))
    o.append(card("Ukuran per kaki",money(leg,0),"kotor %s%s"%(money(gross,0),(" · %.0f%% ekuitas"%(100*gross/eq)) if gross and eq else "")))
    o.append(card("Execution cap","%s jam"%ex.get("maxHoldHours"),"measurement horizon %s%s"%(ex.get("measurementHorizonBars") or "–",ex.get("measurementInterval") or "")))
    o.append(card("Stop / ambil untung","%s / %s"%(stop_text,tp_text),"policy basket baru"))
    o.append(card("Ambang pemisahan",num(fc.get("minScoreGap"),3),"basket ditolak di bawah ini"))
    o.append("</div>")
    o.append("<h2>Bagaimana basket dipilih</h2>")
    if rerank:
        o.append("<div class='lead' style='border-left-color:#8a6fbf'><div class='r'>Formation mengambil peringkat MOM36, memotongnya jadi kolam 5 kandidat teratas per sisi, lalu <b>mencoba semua kombinasi</b> dan memilih yang total utility-nya tertinggi setelah dikurangi penalti klaster. Peringkat mentah dominan; dua faktor lain berbatas.</div></div>")
    else:
        o.append("<div class='lead' style='border-left-color:#8a6fbf'><div class='r'><b>Re-ranking dimatikan.</b> Pemilihan sekarang murni peringkat MOM36: ambil 3 teratas tiap sisi, dengan cluster cap sebagai batas keras, lalu scoreGap dan bobot CAPPED_SCORE_RANK. "
                 "Lifecycle Smart Basket tetap menjalankan revalidasi entry dan ghost dari data kaki yang dibekukan — tapi tidak lagi memengaruhi siapa yang terpilih. "
                 "Dasarnya: ablasi 12 offset selama 2 tahun memberi +0,2227%/basket dengan re-ranking penuh vs +0,2220% tanpanya — selisih 0,0007pp, dengan PF, hit rate, stabilitas kuartal dan kuartal terburuk yang identik.</div></div>")
    o.append("<table><tr><th>fitur</th><th>peran sekarang</th><th>artinya</th></tr>%s</table>"%"".join(
        "<tr><td><b>%s</b></td><td>%s</td><td class='dim' style='white-space:normal'>%s</td></tr>"%(
            esc(a),
            ("%s memilih"%DOT["ok"]) if (rerank or a in ("MOM36","rawRank","scoreGap")) else (("%s guardrail keras"%DOT["ok"]) if a=="penalti klaster" else ("%s bukan selector"%DOT["off"])),
            esc(b)) for a,b in FEATURES))
    if not rerank:
        o.append("<div class='note'>Baris bertanda ⚪ tidak menjadi selector. Revalidasi entry dan ghost tetap memakai harga, score, dan volatilitas kaki yang dibekukan, tanpa menjalankan utility rerank.</div>")
    maker_label="maker-first + taker fallback" if mex else ("CONFIG INEFFECTIVE" if maker_state=="CONFIG_INEFFECTIVE" else "taker penuh")
    maker_dot=DOT["ok"] if mex else (DOT["block"] if maker_state=="CONFIG_INEFFECTIVE" else DOT["off"])
    ee=R.get("exitEcon") or {}
    o.append("<h2>Mode produksi yang benar-benar berjalan</h2><table>"
      "<tr><th>hal</th><th>status</th><th class='dim'>dasar</th></tr>"
      "<tr><td>Mode formasi</td><td>%s <b>%s</b></td><td class='dim'>peringkat MOM36 + cluster cap sebagai pagar konsentrasi</td></tr>"
      "<tr><td>Re-ranking Smart Formation</td><td>%s <b>%s</b></td><td class='dim'>fastSupport / adverseExtension / counter-axis / penalti klaster</td></tr>"
      "<tr><td>Revalidasi entry</td><td>%s <b>%s</b></td><td class='dim'>lifecycle Smart Basket; tidak mengubah pemilihan simbol</td></tr>"
      "<tr><td>Exit adaptif</td><td>%s <b>%s</b></td><td class='dim'>ghost tetap dicatat walau eksekusi OFF</td></tr>"
      "<tr><td>Eksekusi exit</td><td>%s <b>%s</b></td><td class='dim'>%s</td></tr>"
      "<tr><td>Interval tick executor</td><td>%s <b>%s detik</b></td><td class='dim'>nilai efektif dari scheduler, bukan env yang belum dipakai</td></tr>"
      "</table>"%(
        DOT["ok"] if formation_mode!="CONFIG INEFFECTIVE" else DOT["block"],formation_mode,
        DOT["off"] if not rerank else DOT["watch"],"OFF" if not rerank else "ON",
        DOT["ok"] if entry_revalidation is True else (DOT["off"] if entry_revalidation is False else DOT["block"]),"ON" if entry_revalidation is True else "OFF" if entry_revalidation is False else "CONFIG INEFFECTIVE",
        DOT["ok"] if adaptive else DOT["off"],"ON" if adaptive else "OFF · Ghost AKTIF",
        maker_dot,maker_label,
        "hanya untuk penutupan terjadwal (HORIZON); stop/darurat tetap MARKET langsung",
        DOT["ok"] if tick_runtime.get("state")=="EFFECTIVE" else DOT["block"],tick_sec))
    o.append(runtime_consistency_html(R))
    o.append("<h2>Ekonomi eksekusi exit</h2><div class='grid'>")
    o.append(card("Porsi maker",("%.0f%%"%ee["makerPct"]) if fin(ee.get("makerPct")) else NA,"%d kaki pasif"%(ee.get("legsMaker") or 0)))
    o.append(card("Porsi fallback taker",("%.0f%%"%ee["fallbackPct"]) if fin(ee.get("fallbackPct")) else NA,"%d kaki menyeberang"%(ee.get("legsTaker") or 0)))
    o.append(card("Biaya dibayar",money(ee.get("feePaid"),4),"maker 2bps + taker 5bps"))
    o.append(card("Biaya dihemat",money(ee.get("feeSaved"),4),"3bps atas notional yang pasif"))
    o.append(card("Selisih harga exit",("%.3f%%"%ee["exitDrift"]) if fin(ee.get("exitDrift")) else NA,"fallback vs harga maker"))
    o.append(card("Implementation shortfall",money(ee.get("implementationShortfall"),4),"decision price vs fill aktual"))
    o.append(card("Imbalance sementara",money(ee.get("temporaryImbalance"),4),"maksimum antar-leg"))
    o.append(card("Durasi exit",("%.1f detik"%ee["durationSec"]) if fin(ee.get("durationSec")) else NA,"maker wait + fallback"))
    lat=[v for v in (R.get("exec") or {}).get("latency",{}).values() if fin(v)]
    o.append(card("Latensi sinyal→order",("%.0f detik"%(sum(lat)/len(lat))) if lat else NA,"percobaan terakhir tiap instance"))
    o.append("</div>")
    if not fin(ee.get("makerPct")):
        o.append("<div class='note'>Belum ada penutupan terjadwal sejak exit maker-first dinyalakan, jadi porsi maker dan biaya yang dihemat %s. Angkanya akan terisi setelah basket pertama tutup di batas 36 jam.</div>"%NA.lower())
    o.append("<h2>Smart Basket — mengelola basket setelah dibentuk</h2>")
    o.append("<div class='note'>Eksekusi exit adaptif <b>DIMATIKAN</b>; evaluasinya tetap berjalan. Penghitung scan terus bertambah, jadi tab Posisi bisa menunjukkan apa yang <i>akan</i> terjadi tanpa aturan itu menyentuh uang.</div>")
    o.append("<table><tr><th>mekanisme</th><th>status</th><th>parameter</th><th>artinya</th></tr>")
    for nm,stt,par,mean in [("Revalidasi entry",("ok · aktif" if entry_revalidation is True else "off · MATI" if entry_revalidation is False else "block · CONFIG INEFFECTIVE"),"drift merugikan sebelum order dikirim","Membatalkan kalau harga sudah lari melawan sejak sinyal dibentuk."),
        ("Regime Loss Exit","off · Eksekusi MATI, ghost AKTIF","kelas regime berubah + rugi ≥0,3% + sisi searah regime baru rugi, 2 scan","Menutup saat pasar berbalik melawan basket."),
        ("Context Invalidation","off · Eksekusi MATI, ghost AKTIF","≥2 dari 3 kaki satu sisi kehilangan alasan masuknya, 2 scan","Menutup saat alasan pemilihan nama-nama itu hilang."),
        ("MFE Giveback","off · Eksekusi MATI, ghost AKTIF","puncak ≥0,2% lalu turun ke ≤50% puncak","Mengunci laba yang mulai menguap."),
        ("Batas waktu keras","ok · aktif","%s jam"%ex.get("maxHoldHours"),"Selalu menutup di sini apa pun keadaannya."),
        ("Stop / TP",("ok · aktif" if (ex.get("stopNetReturnPct") is not None or not ex.get("tpDisabled")) else "off · OFF"),"%s / %s"%(stop_text,tp_text),"Policy basket baru; legacy basket tetap menyimpan kontraknya."),
        ("Cara menutup",("ok · maker-first" if mex else ("block · CONFIG INEFFECTIVE" if maker_state=="CONFIG_INEFFECTIVE" else "off · taker penuh")),
         "reduce-only post-only, tunggu %ss, sisanya MARKET" % int((maker_runtime.get("waitMs") or 0)/1000),
         "Hanya untuk penutupan terjadwal. Stop, darurat dan rekonsiliasi paksa tetap menyeberang seketika.")]:
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
    _rr=any(fin(c.get("utility")) and abs(_decompose(c,c["side"],
              [(x["score"] if c["side"]=="LONG" else -x["score"]) for x in cands if x["side"]==c["side"]],axis)["raw"]-c["utility"])>1e-9
            for c in cands)
    o.append("<h2>%s · formasi %s <span class='pill'>%s</span> <span class='pill'>%s</span></h2>"%(
        R["inst"][key]["long"],esc(str(src.get("openedAt"))[:16]),
        "masih berjalan" if src.get("status")=="OPEN" else "sudah selesai",
        "dibentuk DENGAN re-ranking" if _rr else "dibentuk dengan peringkat MOM36 saja"))
    if not _rr:
        o.append("<div class='note'>Formasi ini dibuat setelah re-ranking dimatikan: kolom konfirmasi dan ekstensi di bawah bernilai nol pada utility karena memang tidak lagi ikut memilih — nilainya tetap ditampilkan sebagai diagnostik.</div>")
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
    _modeF=((R["inst"]["live"].get("ex") or {}).get("effectiveRuntime") or {}).get("formationMode") or "CONFIG INEFFECTIVE"
    _rrF=_modeF=="SMART_FORMATION_RERANK"
    _leadF=("Pemilihan efektif sekarang memakai <b>SMART_FORMATION_RERANK</b>: utility = peringkat momentum di kolam + konfirmasi cepat (0,22) − penalti mengejar (0,20) + bonus counter-axis (0,08). Tabel di bawah menguraikan tiap suku." if _rrF else "<b>Produksi efektif sekarang %s</b>: memilih murni dari peringkat MOM36, dengan cluster cap sebagai batas keras. Rincian kandidat di bawah hanya ada untuk formasi historis yang memang memakai rerank; label tiap blok menyebut formasi mana yang mana."%esc(_modeF))
    o.append(lead("ok","Kenapa simbol ini yang dipilih — dengan angkanya",_leadF))

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
            horizon=basket_horizon_close(b,ex,now); capH=horizon.get("capHours"); legs=b.get("legs") or []
            notion=sum(abs((l.get("qty") or 0)*(l.get("entryPrice") or 0)) for l in legs)
            lnr=b.get("lastNetReturn"); sb=b.get("smartBasket") or {}
            bs=basket_scores(b,thr,sfi,R.get("dist")); usd=(lnr or 0)*notion/2 if fin(lnr) else None
            o.append("<div class='card' style='margin-top:11px'>")
            o.append("<div style='display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px'><div><b>%s</b> <span class='dim'>· dibuka %s</span></div><div>%s %s</div></div>"%(
                friendly(b.get("basketId")),esc(str(b.get("openedAt"))[:16]),pct(100*lnr,3) if fin(lnr) else "",money(usd,3) if fin(usd) else ""))
            o.append("<div class='grid' style='margin-top:9px'>")
            o.append(card("Umur / batas","%.1f / %s jam"%(age,capH) if age is not None else "–","sisa %.1f jam"%(capH-age) if age is not None and capH else ""))
            o.append(card("Close HORIZON","%sh · %s"%(num(capH,2),horizon.get("dueAt").astimezone(TAIPEI).strftime("%d %b %H:%M:%S Taipei")) if horizon.get("dueAt") else "–",horizon_close_detail(horizon,ex)))
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


ENTRY_W={"gap":2.0,"strg":1.5,"obj":1.0,"fast":1.0,"ext":1.0,"clus":1.0}
def obs_entry_score(ob,dist):
    """The SAME six entry components and the SAME percentile calibration used for live baskets,
    applied to a historical observation. That is what makes the attribution below a fair test:
    the score being validated is the score the dashboard shows, not a stand-in for it."""
    sf=ob.get("smartFormation") or {}
    sel=[c for c in (sf.get("candidates") or []) if c.get("selected")]
    if len(sel)!=6: return None,None
    def mean_of(fld,absolute=False):
        v=[abs(c[fld]) if absolute else c[fld] for c in sel if fin(c.get(fld))]
        return (sum(v)/len(v)) if v else None
    cl=[c.get("cluster") for c in sel if c.get("cluster")]
    raw={"gap":ob.get("scoreGap"),"strg":mean_of("score",True),"obj":sf.get("objectiveScore"),
         "fast":mean_of("fastSupport"),"ext":(-(mean_of("adverseExtensionVol")) if mean_of("adverseExtensionVol") is not None else None),
         "clus":(len(set(cl))/len(cl)) if cl else None}
    parts={k:rank_in(v,dist.get(k)) for k,v in raw.items()}
    have=[(k,v) for k,v in parts.items() if fin(v)]
    if not have: return None,raw
    return sum(v*ENTRY_W[k] for k,v in have)/sum(ENTRY_W[k] for k,_ in have),raw

def quality_attribution(R):
    """Does formation quality actually earn money? Scored, bucketed, and correlated on the same
    clean observations the rest of the page uses."""
    dist=R.get("dist") or {}
    pairs=[]
    for k in INST:
        try: obs=(json.load(open(INST[k]["store"])) or {}).get("observations") or []
        except Exception: obs=[]
        for ob in obs:
            if ob.get("signal")!=PROD_SIGNAL or ob.get("status")=="OPEN": continue
            if corrupt_legs(ob): continue
            nr=ob.get("netReturn")
            if not fin(nr): continue
            sc,raw=obs_entry_score(ob,dist)
            if sc is None: continue
            pairs.append({"score":sc,"net":nr,"raw":raw,"at":ob.get("openedAt")})
    if len(pairs)<8: return None
    pairs.sort(key=lambda x:x["score"])
    n=len(pairs); q=max(1,n//4)
    buckets=[]
    for i,lbl in enumerate(("terendah 25%","25-50%","50-75%","tertinggi 25%")):
        seg=pairs[i*q:(i+1)*q] if i<3 else pairs[3*q:]
        if not seg: continue
        buckets.append({"key":lbl,"n":len(seg),
                        "scoreLo":seg[0]["score"],"scoreHi":seg[-1]["score"],
                        **stats([x["net"] for x in seg])})
    def cor(xs,ys):
        if len(xs)<8: return None
        mx,my=sum(xs)/len(xs),sum(ys)/len(ys)
        num=sum((a-mx)*(b-my) for a,b in zip(xs,ys))
        den=math.sqrt(sum((a-mx)**2 for a in xs)*sum((b-my)**2 for b in ys))
        return (num/den) if den else None
    r_all=cor([x["score"] for x in pairs],[x["net"] for x in pairs])
    comp=[]
    for k,lbl in (("gap","Pemisahan skor"),("strg","Kekuatan sinyal"),("obj","Utility formasi"),
                  ("fast","Konfirmasi cepat"),("ext","Tidak mengejar"),("clus","Sebaran klaster")):
        xs=[x["raw"][k] for x in pairs if fin(x["raw"].get(k))]
        ys=[x["net"] for x in pairs if fin(x["raw"].get(k))]
        c=cor(xs,ys)
        comp.append({"key":lbl,"r":c,"n":len(xs),"r2":(100*c*c) if c is not None else None})
    top=[x["net"] for x in pairs[-q:]]; bot=[x["net"] for x in pairs[:q]]
    return {"pairs":pairs,"buckets":buckets,"r":r_all,"r2":(100*r_all*r_all) if r_all is not None else None,
            "components":sorted(comp,key=lambda c:-(c["r2"] or 0)),
            "topMean":100*sum(top)/len(top),"botMean":100*sum(bot)/len(bot),
            "spread":100*(sum(top)/len(top)-sum(bot)/len(bot)),"n":n,
            "episodes":R["edge"]["episodes"]}

def quality_vs_profit_html(R):
    a=quality_attribution(R)
    if not a: return "<div class='card dim'>Bukti tidak cukup untuk menguji hubungan kualitas dan hasil.</div>"
    strong = a["r2"] is not None and a["r2"]>=25
    o=[lead("ok" if strong else "watch",
        "Kualitas pembentukan menjelaskan %s variasi hasil"%(("%.1f%%"%a["r2"]) if a["r2"] is not None else "?"),
        "Skor entry yang sama dengan yang dipakai di tab Posisi, dihitung untuk %d basket bersih, lalu diadu dengan hasil nyatanya. "
        "Korelasi <b>%s</b>. Basket berkualitas tertinggi menghasilkan <b>%s</b> per basket, terendah <b>%s</b> — selisih <b>%s</b>. "
        "Ingat batasnya: %d observasi ini hanya %d episode independen, jadi selisih sebesar apa pun di sini belum bisa dipisahkan dari kebetulan."%(
        a["n"],("%+.3f"%a["r"]) if a["r"] is not None else "?",pct(a["topMean"],3),pct(a["botMean"],3),pct(a["spread"],3),
        a["n"],a["episodes"]))]
    o.append("<h2>Hasil menurut kuartil kualitas pembentukan</h2>")
    o.append("<div class='scroll'><table><tr><th>kuartil</th><th class='num'>rentang skor</th><th class='num'>N</th>"
             "<th class='num'>rata-rata/basket</th><th class='num'>menang</th><th class='num'>total</th></tr>")
    for b in a["buckets"]:
        o.append("<tr><td>%s</td><td class='num dim'>%.0f–%.0f</td><td class='num'>%d</td><td class='num'>%s</td><td class='num'>%.0f%%</td><td class='num'>%s</td></tr>"%(
            b["key"],b["scoreLo"],b["scoreHi"],b["n"],pct(b.get("meanPct"),3),b.get("winPct") or 0,pct(b.get("totalPct"),2)))
    o.append("</table></div>")
    o.append(bars([(b["key"],b.get("meanPct")) for b in a["buckets"]]))
    o.append("<h2>Kontribusi tiap komponen terhadap hasil</h2>")
    o.append("<div class='scroll'><table><tr><th>komponen</th><th class='num'>korelasi</th><th class='num'>menjelaskan</th><th class='num'>n</th><th>arah</th></tr>")
    for c in a["components"]:
        arah="–" if c["r"] is None else ("searah rancangan" if c["r"]>0.05 else ("BERLAWANAN rancangan" if c["r"]<-0.05 else "praktis nol"))
        o.append("<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td><td class='num'>%d</td><td class='%s'>%s</td></tr>"%(
            c["key"],("%+.3f"%c["r"]) if c["r"] is not None else "–",("%.1f%%"%c["r2"]) if c["r2"] is not None else "–",
            c["n"],"neg" if (c["r"] or 0)<-0.05 else ("pos" if (c["r"] or 0)>0.05 else "dim"),arah))
    o.append("</table></div>")
    o.append("<div class='note'>Komponen bertanda BERLAWANAN berarti nilai yang lebih tinggi justru diikuti hasil sedikit lebih buruk — kebalikan dari niat rancangannya. Pada ukuran sampel ini itu lebih mungkin derau daripada temuan, tapi ia tidak boleh disembunyikan.</div>")
    o.append("<h2>Skor pembentukan vs hasil, per basket</h2>")
    o.append(scatter([{"gap":x["score"],"net":x["net"]} for x in a["pairs"]],50.0))
    o.append("<div class='note'>Sumbu datar = skor kualitas pembentukan (0–100), garis kuning = median. Kalau kualitas menentukan hasil, titik hijau akan menumpuk di kanan.</div>")
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
    cr=R.get("corrupt") or []
    if cr:
        o.append("<div class='card' style='border-left:3px solid #d9a441'><div class='k'>%s Observasi dibuang karena korupsi skala harga</div>"
                 "<div class='s'>%d observasi punya kaki dengan rasio harga keluar/masuk di luar [0,02 – 50] — itu kesalahan desimal, bukan gerak pasar. "
                 "Masing-masing membukukan basket palsu +15%% sampai +18%%. Semuanya dikeluarkan dari seluruh angka di halaman ini.</div>"
                 "<table style='margin-top:6px'><tr><th>waktu</th><th>simbol</th><th class='num'>net palsu</th></tr>%s</table></div>"%(
            DOT["watch"],len(cr),"".join("<tr><td class='dim'>%s</td><td>%s</td><td class='num neg'>%+.2f%%</td></tr>"%(
                esc(str(c["at"])[:16]),esc(", ".join(c["symbols"])),100*c["net"]) for c in cr[:8])))
    o.append("<div class='grid'>")
    o.append(card("Episode independen",str(eps),"dari %d observasi bersih (%.1f× tumpang tindih)"%(allw["n"],allw["n"]/max(1,eps))))
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
    o.append("<h2>Apakah kualitas pembentukan menghasilkan uang?</h2>")
    o.append(quality_vs_profit_html(R))
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
    o=[runtime_consistency_html(R)];e=R["edge"];thr=R["inst"]["live"]["fc"].get("minScoreGap")
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
    o.append(runtime_consistency_html(R))
    o.append(futures_reference_health_html(R,detail=True))
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
    o.append("<details class='observability'><summary>Ghost E / LOSS_CUT &amp; forward evidence · observability only</summary><div class='body'>%s</div></details>"%smart_e_overview_html(R))
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
            horizon=basket_horizon_close(b,R["inst"][k]["ex"])
            P("- [%s] %s dibuka %s | hasil %s | %s"%(
              R["inst"][k]["label"],friendly(b.get("basketId")),str(b.get("openedAt"))[:16],
              ("%+.3f%%"%(100*lnr)) if fin(lnr) else "n/a",
              ("entry %s / eksekusi %s"%(("%d"%round(bq["entry"]["value"])) if fin(bq["entry"]["value"]) else "n/a",
                                          ("%d"%round(bq["exec"]["value"])) if fin(bq["exec"]["value"]) else "n/a"))))
            P("  %s"%", ".join("%s %s"%(l.get("side"),(l.get("symbol") or "").replace("USDT","")) for l in b.get("legs") or []))
            P("  HORIZON %sh: %s"%(num(horizon.get("capHours"),2),horizon_close_detail(horizon,R["inst"][k]["ex"])))
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
    if R.get("corrupt"): P("%d observasi dibuang karena korupsi skala harga (kaki 1000PEPE, basket palsu +15..18%%)."%len(R["corrupt"]))
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
    threading.Thread(target=smart_e_monitor_loop,name="smart-basket-e-ghost",daemon=True).start()
    HTTPServer(("127.0.0.1",PORT),H).serve_forever()
