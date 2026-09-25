"""Expose measured host features, not invented quantitative performance estimates.

The current source provides candles/features/economics, not an independently
validated Quant opportunity estimator. Missing statistical evidence stays null.
"""
import math
from quant_measurements import measure, portfolio_exposure
from quant_snapshot import snapshot

UNAVAILABLE = ("estimatedEdgeBps", "historicalExpectancy", "historicalProfitFactor",
               "sampleSize", "beta", "portfolioCorrelation", "regime")


def contract(raw, at):
    if raw.get("source") != "BINANCE_USDM_TESTNET" or raw.get("status", {}).get("environment") != "testnet":
        raise ValueError("Quant input requires verified Testnet host context")
    rows = []
    references = [r for r in raw.get('quantReferences',[]) + raw.get('rows',[]) if r.get('symbol') in ('BTCUSDT','ETHUSDT')
                  and type(r.get('observedAt')) in (int,float) and 0 <= at-r['observedAt'] <= 120000]
    for row in raw.get("rows", []):
        stamp = row.get("observedAt")
        fresh = type(stamp) in (int, float) and math.isfinite(stamp) and 0 <= at-stamp <= 120000
        measured = {}
        for key, value in (row.get("features") or {}).items():
            if type(value) in (int, float) and math.isfinite(value):
                measured[key] = value if fresh else None
        measurement = measure(row, at, references) if fresh else None
        measured_beta = ((measurement or {}).get('benchmarks',{}).get('BTCUSDT') or {}).get('beta')
        measured_regime = ((measurement or {}).get('features') or {}).get('regime')
        rows.append({"symbol": row["symbol"], "marketDataCutoff": stamp,
                     "status": "FEATURE_CONTEXT_ONLY" if fresh else "STALE_FEATURE_CONTEXT",
                     "measuredFeatures": measured, **{key: None for key in UNAVAILABLE},
                     'measurement':measurement,'beta':measured_beta,'regime':measured_regime})
    return {"version": "QUANT_EVIDENCE_V4", "validatedEdgeEngineAvailable": False,
            'snapshot': snapshot(raw, at),
            "source": "EXISTING_TESTNET_HOST_FEATURES", "rows": rows,
            'portfolio':portfolio_exposure(raw.get('status',{}),raw.get('rows',[]),at),
            "missingValueMeaning": "UNKNOWN_NOT_ZERO_NOT_PROVEN_EDGE",
            "historicalPerformanceMeaning": "No current-policy statistical estimator supplied; do not infer from legacy trades"}
