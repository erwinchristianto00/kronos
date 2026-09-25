#!/usr/bin/env python3
"""Append-only archive of cross-sectional observations, so the edge store never has to be the
historian. The store is rewritten WHOLE on every save, which is why its retention cap cannot simply
be raised without bound — a 234MB store once made testnet unresponsive. This harvester copies each
observation out ONCE, keyed by observationId, into a file that is only ever appended to and never
pruned. Losing history then requires this job to be down longer than the store's own retention
(~11-13 months at the current 15000 cap), instead of the cap silently deciding what survives.

Legs are flattened to [symbol, entryPrice, weight] — enough to replay a basket against klines —
rather than the full leg records, which are most of the store's bulk.

Idempotent: run it as often as you like. cron: 27 * * * *
"""
import json, os, sys, glob

OUT = "/root/xsec-archive"
SRC = {
    "live":    "/root/kronos-live/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json",
    "testnet": "/root/kronos-testnet-releases/128b09f/daily-trading-cockpit-v2/apps/api/data/cross-sectional-edge.json",
}
SCALARS = ("observationId","openedAt","openedAtMs","resolvedAt","status","signal","variant",
           "strategyFamily","weightingModel","regimeClassAtOpen","netReturn","grossReturn",
           "costReturn","longLegReturn","shortLegReturn","scoreGap","horizonMs","k","longK",
           "shortK","exitReason","regimeFlipExit","riskDistanceAtOpen","stopLossReturn",
           "takeProfitReturn","longCapitalWeight","shortCapitalWeight")

def legs(v):
    out = []
    for l in (v or []):
        try:
            out.append([l.get("symbol"), l.get("entryPrice"), l.get("weight")])
        except AttributeError:
            pass
    return out

def compact(o):
    r = {k: o.get(k) for k in SCALARS if o.get(k) is not None}
    r["longLeg"] = legs(o.get("longLeg"))
    r["shortLeg"] = legs(o.get("shortLeg"))
    rc = o.get("regimeContext") or {}
    if rc:
        r["regimeContext"] = {k: rc.get(k) for k in ("currentRegime","controllerMode","directionalBias","confidence") if rc.get(k) is not None}
    sf = o.get("smartFormation") or {}
    if sf:
        r["smartFormation"] = {"version": sf.get("version"), "axisScore": sf.get("axisScore")}
    return r

os.makedirs(OUT, exist_ok=True)
total_new = 0
for inst, src in SRC.items():
    if not os.path.exists(src):
        print("  %-8s store tidak ada, dilewati" % inst); continue
    dst = os.path.join(OUT, "%s-observations.jsonl" % inst)
    seen = set()
    if os.path.exists(dst):
        with open(dst) as fh:
            for ln in fh:
                try: seen.add(json.loads(ln)["observationId"])
                except Exception: pass
    try:
        obs = (json.load(open(src)) or {}).get("observations") or []
    except Exception as e:
        print("  %-8s GAGAL membaca store: %s" % (inst, str(e)[:70])); continue
    new = 0
    # append RESOLVED rows only: an OPEN one would be archived with a null return and never updated
    with open(dst, "a") as fh:
        for o in obs:
            oid = o.get("observationId")
            if not oid or oid in seen or o.get("status") == "OPEN": continue
            fh.write(json.dumps(compact(o), separators=(",", ":")) + "\n")
            seen.add(oid); new += 1
    total_new += new
    size = os.path.getsize(dst) / 1048576
    print("  %-8s +%-5d baru   arsip %d baris, %.2f MB" % (inst, new, len(seen), size))
print("  total baru: %d" % total_new)
