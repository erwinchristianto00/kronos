# Trading Bot — Performance Snapshot

**Timestamp:** 2026-05-13 11:48–11:49 UTC (Cockpit time)
**Source:** Live HTTP fetches against `http://localhost:3101/api/shadow/*` while the API server was running.
**Scope:** Read-only extraction; no logic touched.

> This file is a static point-in-time extract so future audits can compare against it. The companion
> document `TRADING_BOT_FULL_SYSTEM_EVALUATION.md` interprets these numbers in context.

---

## 1. Population

| Field                    | Value |
|--------------------------|-------|
| Total tracked ideas      | 253   |
| PROFIT_CANDIDATE         | 6     (2.37%) |
| DATA_COLLECTION          | 165   (65.22%) |
| RESEARCH_ONLY            | 82    (32.41%) |
| LONG candidates          | 147   |
| SHORT candidates         | 106   |
| `no_chase_atr` selected  | 38    (legacy cohort, now toxic) |
| `fib_500` selected       | 34    |
| New ideas today          | 37 (all DATA_COLLECTION; 0 PROFIT_CANDIDATE) |

Source: `/api/shadow/expansion`, `/api/shadow/routing-monitor`.

---

## 2. Leading POST_CALIBRATION Cohort

Cohort: **`vwap_retest_entry + tp1_full_exit`**, era filter `POST_CALIBRATION`, 42 closed trades.

| Metric                | Value     |
|-----------------------|-----------|
| netAvgR               | **-0.7089** |
| grossAvgR             | -0.2426   |
| profitFactor          | 0.1473    |
| winRate               | 35.71%    |
| tp1Rate (any TP1 hit) | 59.52%    |
| profitableTp1Rate     | 60%       |
| slRate                | 40.48%    |
| avgWinR               | +0.3429   |
| avgLossR              | -1.2933   |
| expectancyGap (cost)  | 0.4663R/trade |
| Maturity status       | **WEAK**  |

Source: `/api/shadow/route-maturity`, `/api/shadow/profit-anatomy`.

---

## 3. Route-Mode All-Time Realized (cumulative, all eras)

| Route mode        | Ideas | Closed | netAvgR  | PF      | winRate | slRate |
|-------------------|-------|--------|----------|---------|---------|--------|
| PROFIT_CANDIDATE  | 6     | 6      | **+0.0885** | 1.1256 | 33.3% | 50%   |
| DATA_COLLECTION   | 165   | 89     | -0.7442  | 0.1356 | 31.5%  | 47.2% |
| RESEARCH_ONLY     | 82    | 230    | -2.4601  | 0.0157 | 9.6%   | 90.0% |

The RESEARCH_ONLY netAvgR of -2.46R, slRate 90% confirms the router is correctly
quarantining a destructive cohort. The PROFIT_CANDIDATE bucket is breakeven-positive
on a tiny n=6 sample — not actionable but not contradicted either.

Source: `/api/shadow/routing-monitor`.

---

## 4. Expectation Calibration

Total sample (166 closed primary trades, all eras):

| Field                          | Value   |
|--------------------------------|---------|
| avgExpectedNetR (raw heuristic)| +0.8525 |
| avgRealizedNetR                | -1.1843 |
| expectationError               | 2.0368  |
| overestimationRate             | 65.06%  |
| severeOverestimationRate       | 51.20%  |
| hitRateWhenExpectedPositive    | 27.03%  |
| Pearson correlation (exp ↔ real)| -0.0011 |
| Diagnoses                      | `HEURISTIC_OVERCONFIDENT`, `COST_DRAG_UNDERCOUNTED` |

**Post-calibration subset (42 trades emitted under POST_CALIBRATION policy):**

| Field                                | Value   |
|--------------------------------------|---------|
| Raw heuristic avg expected R         | +1.0636 |
| Calibrated avg expected R            | **-1.2817** |
| Realized avg R                       | -0.7089 |
| Raw expectation error                | +1.7725 |
| Calibrated expectation error         | -0.5728 |
| Raw-vs-calibrated error improvement  | **+67.68%** |

Calibration cut overestimation by ~2/3. The calibrated estimate now slightly
**under**estimates (says -1.28R, reality -0.71R) — preferable to the +1.06R fantasy
the raw heuristic produced.

Source: `/api/shadow/expectation-calibration`.

---

## 5. Direction Bias

| Direction | n   | exp R  | real R | error | slRate | avgCostR | runnerShare |
|-----------|-----|--------|--------|-------|--------|----------|-------------|
| LONG      | 112 | +0.68  | **-1.62** | 2.30 | **74.1%** | 0.88 | 67.9% |
| SHORT     | 54  | +1.20  | -0.28  | 1.47 | 29.6%  | 0.16 | 5.6%   |

LONG side has been catastrophic in this regime — 74% SL rate, -1.62R per trade.
SHORT side is near breakeven on a smaller sample.

Source: `/api/shadow/expectation-calibration`.

---

## 6. Stop Geometry & RR Credibility

42 closed POST_CALIBRATION trades; overall mainDiagnosis: **`STOP_AND_RR_COMBINED_LEAK`**.

| Bucket       | n  | netAvgR | slRate | avgRR  | Diagnosis |
|--------------|----|---------|--------|--------|-----------|
| ULTRA_TIGHT (<100bps) | 11 | **-2.143** | 72.7% | 15.06 | Destructive |
| TIGHT (100-175)       | 12 | -0.588  | 50.0% | 4.96  | Underperforming |
| MODERATE (175-300)    | 2  | +0.149  | 0%    | 5.48  | Too few |
| WIDE (300-500)        | 6  | -0.355  | 50.0% | 3.65  | Underperforming |
| VERY_WIDE (>500)      | 11 | **+0.244** | 0%   | 4.85  | **Workable** |

Winners avg stop = 430 bps, losers avg stop = 274 bps. Winners avg RR = 3.99,
losers avg RR = 9.32. Tight stops with inflated projected RR are the dominant
loss pattern.

Source: `/api/shadow/stop-geometry-audit`.

---

## 7. Winner vs Loser Discriminant (POST_CALIBRATION, 42 closed)

mainDiagnosis: **`FEATURE_SEPARATION_EMERGING`** (15 winners / 27 losers).

| Feature              | Winner | Loser | Δ        | Skew         | Effect    |
|----------------------|--------|-------|----------|--------------|-----------|
| stopDistanceBps      | 430    | 274   | +155     | WINNER_SKEW  | MODERATE  |
| riskReward           | 3.99   | 9.32  | -5.33    | LOSER_SKEW   | WEAK      |
| entryDriftPct        | 128.6% | 59.9% | +68.7%   | LOSER_SKEW   | MODERATE  |
| directionGap         | 28.7   | 24.2  | +4.5     | WINNER_SKEW  | MODERATE  |
| horizonConflict      | 7%     | 30%   | -23%     | WINNER_SKEW  | MODERATE  |
| kronosAligned        | 100%   | 100%  | 0        | NEUTRAL      | WEAK      |
| whaleAligned         | 91%    | 81%   | +10%     | NEUTRAL      | WEAK      |
| routeScore           | 22.47  | 21.07 | +1.39    | NEUTRAL      | WEAK      |
| dangerScore          | 22.4   | 21.4  | +1.0     | NEUTRAL      | WEAK      |
| calibratedExpectedR  | -1.244 | -1.303| +0.059   | WINNER_SKEW  | WEAK      |

Confluence is dominantly *unhelpful* — Kronos and whale agreement is 100%/81%+ on
both sides. The features that actually separate winners from losers are stop
geometry, drift, and horizonConflict.

Source: `/api/shadow/winner-loser-audit`.

---

## 8. Symbol Concentration (POST_CALIBRATION, vwap_retest+tp1_full)

mainDiagnosis: **`SYMBOL_CONCENTRATED`** (small set of symbols accounts for majority of drag).

| Symbol  | Closed | netAvgR | totalNetR | slRate | Verdict |
|---------|--------|---------|-----------|--------|---------|
| SUIUSDT | 8      | -1.66   | **-13.29** | 37.5% | SYMBOL_ROUTE_DRAG (avgLoss -5.18R single outlier) |
| BNBUSDT | 8      | -0.93   | -7.42     | 62.5% | TOXIC (0% wins) |
| NEARUSDT| 10     | -0.56   | -5.57     | 50.0% | TOXIC |
| DOGEUSDT| 4      | -1.21   | -4.83     | 100%  | TOXIC |
| SEIUSDT | 4      | -0.03   | -0.11     | 0%    | mixed |
| ADAUSDT | 1      | +0.32   | +0.32     | n/a   | (1-sample) |
| FETUSDT | 2      | +0.27   | +0.53     | n/a   | (small) |
| BTCUSDT | 5      | +0.12   | +0.60     | n/a   | (small positive) |

Source: `/api/shadow/symbol-route-audit`, `/api/shadow/profit-anatomy`.

---

## 9. Live Readiness

| Field                    | Value |
|--------------------------|-------|
| Locked evaluation route  | **`fib_500_entry + tp1_full_exit`** |
| Maturity leader route    | **`vwap_retest_entry + tp1_full_exit`** |
| Route alignment status   | **MISMATCH** |
| Closed sample on locked route | 0 |
| Readiness score          | 30 / 100 |
| `liveReady`              | false |

**Gate status (10 gates):**

| Gate | Threshold | Actual | Status |
|------|-----------|--------|--------|
| CLOSED_SAMPLE_SUFFICIENT | ≥ 100 | 0   | FAIL |
| NET_AVG_R_POSITIVE       | > 0.15 | n/a | FAIL |
| PROFIT_FACTOR_OK         | > 1.3 | n/a | FAIL |
| TP1_PROFITABLE_RATE_OK   | > 55% | n/a | FAIL |
| SL_RATE_OK               | < 35% | n/a | FAIL |
| MAX_LOSING_STREAK_OK     | ≤ 4   | 0   | PASS |
| RECENT_DAYS_POSITIVE     | ≥ 7 of last 10 | 0/0 | FAIL |
| WORST_DAY_OK             | > -2R | n/a | FAIL |
| DATA_COVERAGE_OK         | ≥ 95% | 100% | PASS |
| KRONOS_HEALTHY           | healthy | healthy | PASS |

Source: `/api/shadow/live-readiness`.

---

## 10. Top Profit Leaks (all eras)

| Route | Ideas | Closed | netAvgR | PF | winRate |
|-------|-------|--------|---------|----|---------|
| `no_chase_atr_entry + kronos_runner_exit` | 38 | **171** | **-2.86** | 0 | 0% |
| `ema20_pullback_entry + tp1_full_exit`    | 2  | 16   | -2.23  | 0    | 0%   |
| `fib_500_entry + tp1_50_tp2_runner`       | 15 | 13   | -1.01  | 0.31 | 30.8%|
| `fib_500_entry + tp1_full_exit`           | 19 | 14   | -0.92  | 0.19 | 28.6%|
| `vwap_retest_entry + tp1_50_tp2_runner`   | 18 | 14   | -0.75  | 0.39 | 64.3%|

`no_chase_atr_entry + kronos_runner_exit` is the legacy disaster (0% win in 171 trades).
The router now demotes this combo; remaining sample is pre-patch legacy.

Source: `/api/shadow/routing-monitor`.

---

## 11. Cost Attribution

| Field                   | Value  |
|-------------------------|--------|
| avgActualCostR          | 0.4663 |
| avgModelCostR           | 0.4663 |
| Cost overrun            | 0      |
| Cost model calibrated   | true   |
| avgModelSpreadR         | 0.0199 |
| avgModelFeeSlippageR    | 0.4464 |
| highChaseRiskRate       | 91.67% |

Cost model is in calibration with realized cost; cost drag (~0.47R) explains the
gross-to-net gap (gross -0.24R → net -0.71R) but is *not* the dominant leak.
The dominant leak is the gross-negative core route + tight-stop geometry +
direction bias.

Source: `/api/shadow/cost-attribution`.

---

## 12. Regime Drift

Status: **STABLE**. All routes carry `SAMPLE_TOO_SMALL_FOR_DRIFT` warnings — drift
detection needs baseline-vs-recent partitions that the current sample does not
yet support meaningfully.

Source: `/api/shadow/regime-drift`.

---

## 13. Quick Comparison Markers (for future audit diffs)

These are the headline numbers a future audit can diff against:

```
2026-05-13 11:48 UTC
  ideas=253  pc=6  dc=165  ro=82
  leader=vwap_retest+tp1_full netR=-0.7089 PF=0.1473 win=35.71% n=42
  locked=fib_500+tp1_full     n=0  score=30/10
  expectationError raw=2.04  calibrated=-0.57  improvement=67.68%
  LONG netR=-1.62 (74% SL)  SHORT netR=-0.28 (30% SL)
  stop ULTRA_TIGHT netR=-2.14  VERY_WIDE netR=+0.24
  research_only netR=-2.46  PF=0.016  slRate=90%
  kronos: 20/20 forecasts succeeded (post-fix)
```
