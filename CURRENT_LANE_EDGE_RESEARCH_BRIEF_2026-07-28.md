# Kronos Current Lane Edge Research Brief

Snapshot: 2026-07-28 09:32 Asia/Taipei

Purpose: provide a complete, honest map of the current lane ecosystem so Deep
Research can search for genuinely new trading edges instead of producing another
minor TP/SL variant of an existing failed idea.

This is a research brief, not an instruction to deploy or trade.

Snapshot sources:

- Research instance `3101`: neural-map telemetry, operator brief,
  Current Guard variant-matrix report, and research-lane reports.
- Testnet instance `3102`: live-engine status, controller, allocation, open
  intents, and risk limits.
- Mainnet instance `3103`: live-engine status, controller, allocation, and
  realized lane evaluation.
- Repository implementations of the Current Guard, composite confirmation,
  composite estimator, cross-sectional, and event-research families.

Runtime figures are point-in-time values and can change after this snapshot.

## 1. Executive Reality

The system has broad execution infrastructure, many geometry variants, and a
large diagnostic sample. It does not yet have broad, stable, after-cost edge.

Current research-instance totals:

| Metric | Value |
| --- | ---: |
| Paper observations | 6,290 |
| Open / closed | 27 / 5,003 |
| Variant-matrix observations | 22,757 |
| Variant-matrix fresh-valid | 10,022 |
| Diagnostic realized PnL | -41,677.29 USDT |
| Diagnostic open MTM | -0.36 USDT |
| Headline PnL | -68.73 USDT |
| Average configured TP | 5.44% |
| Open-position MFE p90 | 3.99% |
| TP assessment | Too far versus observed MFE |

Direction-level diagnostic results:

| Direction or context | Closed | Open | Realized PnL | Net Avg R | WR |
| --- | ---: | ---: | ---: | ---: | ---: |
| LONG | 1,331 | 6 | -12,288.16 USDT | -0.326R | 49.6% |
| SHORT | 3,669 | 21 | -29,389.13 USDT | -0.171R | 72.9% |
| MIXED regime subset | 399 | 2 | -10,135.67 USDT | -0.193R | 69.9% |

The high SHORT win rate is not a profitable edge. Loss size, payoff geometry,
and costs still make its expectancy negative.

All current direction/posture buckets are negative:

| Direction | Posture | n | Net Avg R | WR |
| --- | --- | ---: | ---: | ---: |
| LONG | EXTENDED | 4,009 | -0.529R | 32.7% |
| LONG | TACTICAL | 1,589 | -0.629R | 28.8% |
| SHORT | EXTENDED | 3,214 | -0.112R | 59.4% |
| SHORT | TACTICAL | 1,210 | -0.126R | 63.0% |

The largest immediate research gap is therefore not another leverage or TP
setting. It is a causally distinct admission edge that selects when a geometry
has positive conditional expectancy.

## 2. Runtime and Wiring Snapshot

At snapshot time:

- Research controller: `Bearish pressure`, `SHORT_ONLY`, confidence `MEDIUM`.
- Live controller: `Bearish pressure`, `SHORT_ONLY`, confidence `HIGH`.
- Testnet controller: `Bearish pressure`, `SHORT_ONLY`, confidence `HIGH`.
- Live and testnet engines were armed and healthy.
- Live current allocation contained
  `REGIME_COMPOSITE_CONFIRMATION_SHORT` and
  `REGIME_COMPOSITE_CONFIRMATION_LONG`.
- Testnet was running a broad ten-lane collection allocation.
- Live had no open mirror intents at the snapshot.
- Testnet had eight open SHORT intents.

Execution wiring and edge proof are separate concepts:

- `EXECUTABLE` means the engine can route and manage it.
- `WATCHABLE` means a telemetry rule currently presents it as worth watching.
- `COHORT_SPLIT` means only some direction/regime slices are positive.
- `QUARANTINED` means the measured aggregate is not acceptable.
- `RESEARCH_ONLY` means it is measured but does not own live exposure.
- None of these labels alone proves stable live profitability.

## 3. Current Guard Geometry Family

These lanes mostly reuse the same candidate stream and change stop, TP, fill,
scale-out, or trailing geometry. They are not 33 independent alpha sources.

### Geometry definitions

| Geometry | Core behavior |
| --- | --- |
| BASELINE_CURRENT | Existing entry, stop, TP1, taker fill, full exit |
| WIDE_STOP_TP_WIDE | Stop floor near 3%, TP near 1R |
| TRAIL_AFTER_TP1 | Wide stop, touch 1R, move to BE and trail |
| SCALEOUT_TP1_TRAIL | Exit 50% at TP1, BE-stop the runner |
| NO_FIB500_ENTRYSET | Baseline without the fib-500 entry family |
| MAKER_LIMIT_SIM | Simulated post-only pullback fill and maker costs |
| TIGHT_FAST_05 | Native/tight stop, full TP at 0.5R |
| BE_AFTER_05 | Wide stop, arm BE after 0.5R |
| MFE_GIVEBACK | Wide stop, arm at 0.75R, exit on 50% MFE giveback |
| BASELINE_FAST_05 | Raw stop and full TP at 0.5R |
| MAKER_FAST_05 | Maker-style entry and full TP at 0.5R |
| WIDE_FAST_SHORT | SHORT, wide stop, TP at 0.5R |
| WIDE_FAST_LONG | LONG mirror, wide stop, TP at 0.5R |
| WIDE_LONG_RUNNER | LONG, wide stop, TP at 3R, max hold 144h |
| LG_R12_STOP250/300 | LONG full exit at 1.2R with 2.5%/3% stop floor |
| EXP_*_10X | Paper experiment with 10x sizing/leverage metadata |

### Complete current matrix

`Overall` is the full fresh-valid cohort, not a cherry-picked regime slice.

| Lane ID | Runtime status | n | Net Avg R | PF | WR | Positive pocket, if any | Honest classification |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1` | COHORT_SPLIT | 832 | -0.146 | 0.73 | 45% | SHORT +0.213R; SHORT_MIXED +0.396R | Negative overall; short admission hypothesis |
| `CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE` | COHORT_SPLIT | 805 | -0.201 | 0.64 | 43% | SHORT +0.189R; SHORT_MIXED +0.364R | Negative overall; short admission hypothesis |
| `CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE` | PAPER_EVIDENCE | 27 | -0.134 | 0.75 | 44% | None | Negative |
| `CG_VARIANT_MATRIX:CG_BE_AFTER_05` | COHORT_SPLIT | 787 | -0.149 | 0.65 | 57% | SHORT +0.083R; SHORT_MIXED +0.214R | Negative overall; small short pocket |
| `CG_VARIANT_MATRIX:CG_MFE_GIVEBACK` | QUARANTINED | 744 | -0.255 | 0.54 | 43% | SHORT_MIXED +0.101R | Negative overall |
| `CG_VARIANT_MATRIX:CG_TIGHT_FAST_05` | QUARANTINED | 711 | -0.320 | 0.38 | 52% | None | Negative |
| `CG_VARIANT_MATRIX:CG_BASELINE_FAST_05` | QUARANTINED | 568 | -0.441 | 0.29 | 51% | None | Negative |
| `CG_VARIANT_MATRIX:CG_WIDE_FAST_SHORT` | QUARANTINED | 448 | +0.016 | 1.06 | 73% | MIXED +0.119R; BEARISH +0.034R | Tiny paper edge; not robust to real costs |
| `CG_VARIANT_MATRIX:CG_BASELINE_CURRENT` | QUARANTINED | 394 | -0.542 | 0.09 | 39% | None | Strong reject |
| `CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL` | QUARANTINED | 394 | -0.566 | 0.09 | 25% | None | Strong reject |
| `CG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET` | QUARANTINED | 392 | -0.540 | 0.09 | 39% | None | Strong reject |
| `CG_VARIANT_MATRIX:CG_MAKER_FAST_05` | QUARANTINED | 368 | -0.313 | 0.43 | 55% | None | Negative |
| `CG_VARIANT_MATRIX:CG_EXP_SHORT_MFE_GIVEBACK_10X` | QUARANTINED | 334 | -0.161 | 0.46 | 57% | BEARISH n=79 +0.194R | Aggregate reject; leverage is not the edge |
| `CG_VARIANT_MATRIX:CG_EXP_SHORT_WIDE_FAST_10X` | QUARANTINED | 286 | -0.234 | 0.05 | 69% | None | High WR, negative expectancy |
| `CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM` | QUARANTINED | 250 | -0.398 | 0.24 | 66% | None | High WR, negative expectancy |
| `CG_LONG_VARIANT_MATRIX:CG_TIGHT_FAST_05` | QUARANTINED | 124 | -0.202 | 0.53 | 62% | None | Negative |
| `CG_LONG_VARIANT_MATRIX:CG_EXP_LONG_MFE_GIVEBACK_10X` | QUARANTINED | 99 | -0.031 | 0.84 | 78% | None | Nearer to flat, still negative |
| `CG_LONG_VARIANT_MATRIX:LG_R12_STOP300_FULL` | QUARANTINED | 90 | -1.096 | 0.00 | 0% | None | Strong reject |
| `CG_LONG_VARIANT_MATRIX:LG_R12_STOP250_FULL` | QUARANTINED | 65 | -1.115 | 0.00 | 0% | None | Strong reject |
| `CG_LONG_VARIANT_MATRIX:CG_MFE_GIVEBACK` | QUARANTINED | 65 | -0.180 | 0.57 | 49% | None | Negative |
| `CG_LONG_VARIANT_MATRIX:CG_BASELINE_FAST_05` | QUARANTINED | 61 | -0.802 | 0.06 | 51% | None | Strong reject |
| `CG_LONG_VARIANT_MATRIX:CG_EXP_LONG_TIGHT_FAST_10X` | QUARANTINED | 59 | -0.190 | 0.10 | 81% | None | High WR, negative expectancy |
| `CG_LONG_VARIANT_MATRIX:CG_MAKER_FAST_05` | QUARANTINED | 53 | -0.882 | 0.06 | 25% | None | Strong reject |
| `CG_LONG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER` | WATCHABLE | 51 | +0.318 | 2.56 | 55% | LONG only | Paper-positive, small and maturity-sensitive |
| `CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG` | WATCHABLE | 51 | +0.280 | 4.07 | 88% | LONG only | Paper-positive label contradicted by recent live after-cost result |
| `CG_LONG_VARIANT_MATRIX:BL_TREND_SCALEOUT_STOP200` | QUARANTINED | 48 | -0.691 | 0.21 | 21% | None | Strong reject |
| `CG_LONG_VARIANT_MATRIX:CG_NO_FIB500_ENTRYSET` | QUARANTINED | 46 | -0.182 | 0.29 | 76% | None | High WR, negative expectancy |
| `CG_LONG_VARIANT_MATRIX:BL_TREND_R15_STOP200_FULL` | QUARANTINED | 44 | -0.859 | 0.13 | 11% | None | Strong reject |
| `CG_LONG_VARIANT_MATRIX:CG_EXP_LONG_WIDE_FAST_10X` | QUARANTINED | 44 | -0.136 | 0.20 | 84% | None | High WR, negative expectancy |
| `CG_LONG_VARIANT_MATRIX:CG_BASELINE_CURRENT` | QUARANTINED | 43 | -0.229 | 0.24 | 72% | None | Negative |
| `CG_LONG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM` | QUARANTINED | 43 | -0.224 | 0.24 | 70% | None | Negative |
| `CG_LONG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL` | PAPER_EVIDENCE | 2 | -1.055 | 0.00 | 0% | None | Insufficient and negative |
| `MIXED_CHOP_RANGE_MR` | PAPER_EVIDENCE | 1 | -1.326 | 0.00 | 0% | None | No usable evidence |

### Important live contradiction

`CG_WIDE_FAST_LONG` is the clearest example of why the current status label must
not be accepted at face value:

- Matrix label: n=51, +0.280R, PF 4.07, WR 88%.
- Recent live namespace: 50 closed, 32 wins / 18 losses, net about -0.34 USDT
  after about 1.41 USDT fees.
- The historical maturity view excluded some max-hold exits and unresolved
  loser-heavy positions, inflating the apparent paper edge.

The research question is not "how to tune this TP again." It is "what admission
state makes the same geometry positive after cost without look-ahead?"

## 4. Directional and Single-Symbol Research Lanes

| Lane | Thesis | Current evidence | Classification |
| --- | --- | --- | --- |
| `REGIME_COMPOSITE_CONFIRMATION_LONG` | BTC/ETH/SOL LONG after bullish composite confirmation, stable crowding, EMA20 retest/rejection, no overextension | Live: 9 closed, +7.79 USDT. Measured n=31, +0.220R, WR 64.5%, PF 1.61 | Best current real directional clue; sample still small |
| `REGIME_COMPOSITE_CONFIRMATION_SHORT` | Mirrored SHORT after bearish composite confirmation and retest from below; avoid waterfall chasing | Live: 3 closed, +0.31 USDT. Measured n=31, -0.138R, WR 48.4%, PF 0.76 | Not proven; bearish timing remains a gap |
| `COMPOSITE_ESTIMATOR_BIDI_FAST_LONG` | Blend axis level, axis velocity, and forecast; fast 0.5R geometry | n=53, roughly flat to -0.016R, PF near 1 | No edge yet |
| `COMPOSITE_ESTIMATOR_BIDI_FAST_SHORT` | Same estimator, SHORT fast geometry | n=54, approximately +0.011R in research but -0.088R in live evaluation | Inconsistent, no robust edge |
| `COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG` | Strong composite score, 3R/144h wide geometry | Live 6 closes +2.81 USDT; measured n=10 +0.011R, PF 1.02 | Too little and too close to flat |
| `COMPOSITE_ESTIMATOR_BIDI_WIDE_SHORT` | Strong bearish score, wide geometry | Measured n=9, -0.205R, PF 0.56 | Negative |
| `INTRADAY_MOMENTUM_BREAKOUT_LONG` | 1h 20-bar breakout with volume and momentum confirmation; MFE giveback exit | n=217, -0.083R after cost, gross +0.007R, WR 55.8%, PF 0.82 | Costs and false breakouts erase edge |
| `SHORT_FADE_EXHAUSTION_CROWDED` | Fade crowded, exhausted upside with a SHORT | No resolved examples | Plausible thesis, zero evidence |
| `PANIC_WASHOUT_RECLAIM_LONG` | LONG after panic washout and confirmed reclaim | No resolved examples | Plausible event edge, zero evidence |
| `PROFIT_CORE_SHORT_TRAIL` | Stop-protected single-symbol SHORT with trailing profit capture | No current measured sample in lane evaluation | Wiring exists; edge unproven |

Current composite confirmation logic is already stricter than a raw regime line:

- Universe: BTC, ETH, SOL.
- LONG requires bullish axis, stable crowding, EMA20 retest/rejection,
  extension below about 0.75 ATR, and RSI not overheated.
- SHORT mirrors the logic, requires rejection below EMA20, avoids chasing a
  waterfall, and avoids already exhausted RSI.
- Structural stop is approximately 2 ATR with an MFE-giveback exit.

Deep Research should preserve the good part of this design: confirmation after a
pullback/retest. It should focus on fixing asymmetric SHORT timing and proving
whether the edge generalizes beyond three majors.

## 5. Cross-Sectional and Market-Neutral Lanes

| Lane | Current evidence | Diagnosis |
| --- | --- | --- |
| `CROSS_SECTIONAL_MARKET_NEUTRAL` | n=687, net -0.117%, gross +0.003%, WR 46.3% | Raw momentum dispersion is negative after cost |
| `CROSS_SECTIONAL_FILTERED` | n=271, net approximately 0.00%, gross +0.12%, WR 49.1% | Filtering helps, but gross spread is still too small |
| `CROSS_SECTIONAL_TREND` | n=111, net -0.14%, gross -0.02%, WR 18% | Reject current trend implementation |
| `CROSS_SECTIONAL_MIXED` | n=23, net -0.11%, gross +0.01%, WR 30.4% | Insufficient and negative |
| `RESIDUAL_MOMENTUM_LEADER_LAGGARD` | n=500, net -0.042R, gross +0.127R, PF 0.93 | Nearer to viable, but long legs destroy short-leg edge |
| `LIQUIDATION_RECOIL_CROSS_SECTIONAL_LONG` | n=0 | No evidence |

Residual momentum decomposition is more informative than its aggregate:

| Sub-edge | n | Net Avg R | Interpretation |
| --- | ---: | ---: | --- |
| Dispersion LONG | 215 | -0.197R | Harmful |
| Dispersion SHORT | 237 | +0.130R | Promising conditional edge |
| Catch-up LONG | 25 | -0.780R | Strong reject |
| Catch-up SHORT | 23 | +0.436R | Promising but small sample |

Research implication:

- Do not force an equal long-alt and short-alt basket merely to call it neutral.
- Investigate beta/vol-neutral short residual portfolios hedged with smaller
  BTC/ETH long exposure.
- Require expected gross basket spread above 0.35% before entry.
- Use basket-level after-cost TP around 0.30% to 0.50% and hard loss around
  -0.25% to -0.35%, subject to volatility normalization.
- Separate trend/extended momentum dispersion from mixed/choppy reversal.

## 6. Other Research-Only Edge Families

| Lane | Current evidence | Classification and next question |
| --- | --- | --- |
| `COMPRESSION_EXPANSION_IGNITION` | n=16, +0.088R net, +0.256R gross, WR 56.3%, PF 1.30 | Promising but tiny. Can pre-breakout compression plus flow confirmation survive costs and false squeezes? |
| `FUNDING_CARRY_NEUTRAL_PAIR` | n=3, +0.739R, PF 2.42 | Attractive thesis, unusably small sample. Test funding differential, borrowability, basis risk, and execution costs |
| `BTC_LEADLAG_RESIDUAL_SNAP` | n=47, -0.488R, PF 0.21 | Reject current implementation in both directions |
| `LIQUIDATION_RECOIL_EVENT` | n=17, -0.723R, PF 0.08 | Reject current long event definition |
| `META_LABEL` | Report-only overlay | Not an independent alpha lane |
| `CORTEX` / Four-Brain outputs | Decision and allocation learners | Not independent edge evidence; they can rank valid candidates but cannot manufacture alpha from negative labels |

Research-only design summaries:

- `COMPRESSION_EXPANSION_IGNITION`: low ATR and Bollinger-width compression
  sustained for several hours, then range breakout with volume and taker-flow
  confirmation; structural stop and ATR trail.
- `FUNDING_CARRY_NEUTRAL_PAIR`: same-cluster delta-neutral pair, long the
  low/negative-funding leg and short the high-funding leg; maximum 72h with
  divergence stop.
- `BTC_LEADLAG_RESIDUAL_SNAP`: trade alt residual response after BTC impulse;
  current implementation is negative in both directions.
- `LIQUIDATION_RECOIL_EVENT`: long a liquidation-style washout; current event
  detector enters too early or lacks a valid reclaim condition.

## 7. What Appears Promising, Without Calling It Proven

Ranked research leads:

1. Composite-confirmed LONG on liquid majors after retest, not breakout chase.
   It has the strongest small sample of actual live evidence.
2. Residual dispersion SHORT and catch-up SHORT. The aggregate is hidden by
   structurally bad long legs.
3. SHORT use of wide-stop/trail/BE geometries only inside correctly identified
   bearish or mixed cohorts. The geometry is not positive unconditionally.
4. Compression-to-expansion ignition with flow confirmation. Early result is
   positive but only n=16.
5. Funding-differential neutral carry. Strong economic thesis, only n=3.
6. A filtered market-neutral basket with a much higher gross-spread admission
   threshold and beta/vol-neutral sizing.

These are research priorities, not deployment recommendations.

## 8. Families That Should Not Be Renamed and Reintroduced

Deep Research should reject proposals that are merely:

- another `0.5R` versus `1R` versus `3R` TP on the same Current Guard signal;
- higher leverage on a negative-expectancy entry;
- a looser stop intended to turn unresolved losses into temporary open MTM;
- equal-weight alt baskets with gross spread below transaction costs;
- breakout LONG without a false-breakout or retest filter;
- mirrored LONG-to-SHORT logic without proving directional asymmetry;
- a high-WR strategy with PF below 1 or negative after-cost expectancy;
- a model trained to rank labels contaminated by unresolved or excluded losers.

## 9. Known Evidence and Measurement Risks

Any new research must explicitly protect against these known failure modes:

1. Winner maturity bias: winners resolve faster while loser-heavy positions
   remain open.
2. Excluded max-hold exits: omitting `MAX_HOLD_MTM` can make a losing lane look
   strongly positive.
3. Resolver horizon mismatch: a data window shorter than a lane's 144h hold can
   censor losses.
4. Diagnostic versus executable confusion: most observations are measurement
   outcomes, not exchange fills.
5. Gross-versus-net confusion: reported WR may count gross winners that are net
   losers after fees and slippage.
6. Slice mining: a positive bearish or mixed slice does not validate a negative
   aggregate unless the regime gate was fixed before evaluation.
7. Calendar concentration: thousands of closes may still represent only a few
   effective independent days.
8. Symbol concentration: one coin can dominate a lane's PnL.
9. Look-ahead risk: decision features, regime tags, and eligibility must be
   available strictly at decision time.
10. Backdated observation risk: `openedAt`, feature time, creation time, and
    resolver time must preserve causal order.
11. Cost model weakness: stress cost must be added to realistic fees/slippage,
    not replace them.
12. Position netting: one-way Binance positions can merge multiple source
    entries, so attribution must remain source-order aware.

## 10. Minimum Standard for a New Edge

A proposed lane should not be called promising unless it supplies:

- a distinct economic or behavioral mechanism;
- exact regime, direction, universe, and horizon;
- causal features available before entry;
- a no-trade state and explicit invalidation;
- entry geometry that avoids stale signals and price chasing;
- volatility-normalized stop and after-cost TP;
- expected gross movement comfortably above round-trip cost;
- per-symbol and correlated-cluster exposure limits;
- chronological walk-forward evaluation with purge and embargo;
- unresolved positions included through conservative MTM or fixed-horizon
  outcomes;
- results split by direction, regime, symbol, month, and cost scenario;
- clustered confidence interval lower bound above zero;
- comparison against the current incumbent and against `NO_TRADE`;
- a clear rejection rule before testing begins.

## 11. Deep Research Prompt

Copy the block below into Deep Research together with this document.

```text
You are conducting independent deep research for a Binance USD-M futures
trading system called Kronos. Use current primary sources, peer-reviewed papers,
exchange documentation, and high-quality market microstructure research. Cite
every material factual claim.

The attached Kronos lane brief is the complete current strategy landscape.
Treat all performance numbers as preliminary evidence with the listed
measurement risks. Do not assume that an executable or WATCHABLE lane is
profitable.

Objective:
Find causally distinct, implementable crypto trading edges that can produce
positive after-cost expectancy and controlled drawdown. Prioritize new admission
logic and market-state conditioning, not cosmetic TP/SL variants of the existing
Current Guard family.

Required coverage:
1. Bearish tactical edge.
2. Bearish extended-trend edge.
3. Bullish tactical edge.
4. Bullish extended-trend edge.
5. Mixed/choppy edge.
6. Market-neutral or hedged edge.
7. Event-driven edge.
8. Carry or structural edge.

For each candidate edge provide:
- unique edge name;
- causal/economic mechanism and why it should persist;
- exact regime and directional scope;
- suitable symbols and liquidity requirements;
- data fields and candle/order-book/funding resolution required;
- causal entry conditions available strictly at decision time;
- confirmation, anti-chase, staleness, and no-trade rules;
- stop, TP, trailing, time-stop, and regime-flip behavior;
- volatility and correlation-normalized sizing;
- minimum expected gross move required after fees and slippage;
- failure modes and pre-registered invalidation rule;
- overlap with every existing Kronos lane;
- smallest safe paper implementation using existing Kronos signals;
- evidence quality and links to primary sources.

Research constraints:
- Do not propose higher leverage as an edge.
- Do not rename an existing lane.
- Do not use synthetic outcomes as direct training labels.
- Do not optimize on a sealed holdout.
- Do not discard unresolved or max-hold losers.
- Do not claim success from win rate alone.
- Do not use future regime labels or future candle information.
- Do not recommend deployment merely because a backtest is positive.
- Assume at least 0.22% estimated round-trip fee plus slippage unless a more
  conservative symbol-specific model is justified.
- Prefer entries with expected gross movement above 0.35%.

Rank 8 to 12 candidate edges using:
1. expected after-cost alpha;
2. causal plausibility;
3. independence from current lanes;
4. regime coverage;
5. implementation feasibility with existing Kronos data;
6. robustness to Binance execution and one-way position netting;
7. sample efficiency.

Then produce:
A. a lane-overlap matrix;
B. the top three research specifications in implementation-ready pseudocode;
C. a falsification and walk-forward test plan;
D. a data-gap list;
E. a recommendation on which existing lane should be the control for each new
   candidate;
F. a blunt final verdict separating genuinely new edges from ideas that are only
   repackaged geometry.

The desired output is a research agenda, not a promise of profit and not a
deployment plan.
```

## 12. Suggested Research Order

1. Fix causal outcome accounting and establish an honest incumbent baseline.
2. Research residual SHORT and hedged-short baskets.
3. Research composite-confirmed LONG retest generalization.
4. Research compression ignition and funding carry.
5. Research a true mixed-regime edge separately.
6. Only after admission alpha exists, compare fast, wide, trail, and scale-out
   geometries.

The core question for every future lane should be:

> What information available before entry predicts a sufficiently large,
> directionally correct move after all costs, and in exactly which market state
> does that prediction stop working?
