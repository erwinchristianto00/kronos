# Daily Range selector research plan and initial evidence

## Verdict

**No validated selector exists. `SELECTOR = SHADOW`.**

The structural allocation bug is fixed independently of alpha research. Live
must remain `PAUSED_SELECTION_FIX`; Testnet uses the neutral,
`SEEDED_RANDOM_BASELINE` allocator. A seeded random baseline has no claimed
alpha and is only an unbiased, reproducible comparator.

## Current dataset boundary

The pre-fix Live day contains:

| Population | Count | Usable role |
| --- | ---: | --- |
| Accepted Daily signals | 87 | incident reconstruction only |
| Actual Daily entries | 12 | execution/accounting evidence only |
| Same-timestamp passive cohort records | 1 | incomplete historic coverage |
| Full PIT selector samples | 0 | none before this forward collector |

The historical state did not persist exact signal-time BBO/spread and all
C1–C6 facts for the earliest signals. No missing value is fabricated. Old
reconstruction is explicitly `PARTIAL_RECONSTRUCTION`, never mixed into the
primary promotion sample.

## Forward PIT record

Every post-fix accepted signal persists independently of whether it gets a
slot. The canonical batch time is `confirmationBar2.closeTime + 1 ms`.

### Frozen provenance and execution quality

- frozen UTC-day C1–C6 pool version, membership, thresholds, audit values, and
  pool capture time;
- pool C1–C6 pass/fail state, liquidity, listing age, 5m/4h data quality, and
  median spread;
- actual BBO fields: bid, ask, source time, observation time, and spread;
- candidate count, long/short count, free slots, reservations at allocation,
  oversubscription ratio, and selector mode/rank/result.

The frozen day C1–C6 record is the actual admission provenance. A later
rolling pool read may block a live entry for safety, but cannot overwrite a
historical feature row.

A REST BBO is frozen after every symbol has finished C2 evaluation and before
the batch allocator can submit an order. A signal is only knowable after C2
closes, so a BBO observed in this forward decision phase is causal even when
its exchange timestamp follows the candle close. It is labelled
`AT_DECISION_BEFORE_ALLOCATION` and is `FULL_PIT` only when the UTC-day pool
evidence was already frozen before the signal and the exchange timestamp is
not later than the local decision capture (with a small clock-skew bound).
A recovery read after allocation is always `RECOVERY_AFTER_ALLOCATION` and
cannot upgrade a historical row; a BBO timestamp in the future is explicitly
`FUTURE_OF_DECISION` / `UNAVAILABLE`. This preserves a usable forward dataset
without silently leaking a later quote into an old decision.

### Causal feature schema (v1)

All candle reads end at the completed C2 bar; missing/gapped history yields
`null` or `UNAVAILABLE`, never a bridged return.

| Group | Features |
| --- | --- |
| Breakout | C1/C2 extension, extension/range width, extension/ATR14, extension %, ATR14, realised volatility |
| Relative volume | C1 and C2 volume; C1, C2, and combined relative volume versus 12/24/36 prior 5m bars |
| Trend | 1h and 4h returns, plus side-aligned forms and boolean alignment |
| Range quality | range/price, range/ATR, 4h body/range, upper/lower wick %, 4h volume and relative volume |
| Regime | BTC and ETH 1h/4h return, BTC side alignment, universe 1h positive/negative breadth |
| Crowding | total candidates, long/short candidates, capacity, and oversubscription ratio |

The feature schema is observation-only. It does not alter C1–C6, signal
generation, position cap, sizing, entry, SL, TP, or exits.

## Counterfactual labels

For every accepted signal, including a capacity skip, the research record uses
the incumbent semantics:

```text
entry = C2 close
stop = same structural stop and tick rounding
take profit = same rounded 2R target
fees = 4 bps entry + 4 bps exit
slippage = 0 bps modeled separately from real fills
```

It follows 1m USD-M OHLC until the first barrier. Labels are `PENDING`,
`MATURE_TP`, `MATURE_SL`, or `OUTCOME_AMBIGUOUS`. If both barriers occur in
one 1m bar, no favorable ordering is chosen and the row is excluded from
primary training/evaluation. There is no forced midnight or EOD label.

## Known batch reconstruction (incident only)

Historical paths below use public USD-M 1m candles through
2026-08-26 12:58 UTC, exact C2-close/structural-stop/tick-rounded-2R
semantics, and no time stop. They are not actual unfilled orders and are not
training inputs.

| Batch | Actual old selection | Capacity-skipped counterfactual outcome |
| --- | --- | --- |
| 09:35 | AKE SHORT: actual TP; BCH SHORT: actual SL | 13 cap-skipped: 3 TP, 6 SL, 4 still pending. ACE was separately blocked by its existing lane lease. |
| 10:25 | FF SHORT: actual SL | PUMP LONG: SL; TRUMP LONG: pending. |
| 10:30 | ETHFI LONG: actual SL | FARTCOIN LONG: TP; XMR LONG: SL. |

The 09:10 group had 12 candidates: ACE was selected and 11 were marked cap
reached. Its bypassed counterfactuals were also mixed (3 TP, 4 SL, 4 pending).
This is evidence of the allocation defect, not evidence for a particular
feature, model, or universe reduction.

Actual fill PnL and C2-close counterfactual PnL must not be directly compared:
actual entries use exchange fill prices and fees, while counterfactuals use the
predeclared model convention above.

## Baselines and selector family

### Initial result status

There is deliberately **no baseline-performance result yet**: the eligible
forward selector population starts at zero full-PIT, matured signals and zero
matured oversubscribed batches. The pre-fix incident paths are a separate,
partial reconstruction and cannot be used to claim a loop-order, random,
liquidity, spread, or model advantage. This is a data-collection deployment,
not a retrospective optimization.

Every future oversubscribed batch must be replayed against:

1. `LOOP_ORDER_LEGACY` — replay/incident comparator only, never runtime;
2. `SEEDED_RANDOM_BASELINE` — deterministic hash seed from strategy version,
   timestamp, and environment; evaluate many seeds for a distribution;
3. liquidity-only and spread-only diagnostic ranks; and
4. a small preregistered model family only: linear score, logistic regression,
   and a small tree/LightGBM candidate.

The first model features are limited to the documented causal schema. No
manually weighted composite, neural network, feature mining sweep, or model
artifact has entry authority.

Targets are both (a) probability that TP precedes SL and (b) expected net R.
The primary evaluation is the actual portfolio question: within each
oversubscribed batch, does top-N selection improve the realised counterfactual
stream versus the baselines?

## Evaluation and promotion gates

Splits are strictly chronological:

```text
train → validation → newest untouched holdout
```

Use rolling walk-forward replay with the historical free slot count and exact
candidate set at each timestamp. Batch-correlated samples must use a
time-aware/block bootstrap; simultaneous candidates are not IID observations.

The default minimum before any Live selector promotion is:

- at least **200** matured, valid candidate signals; and
- at least **50** matured oversubscribed batches.

All gates must pass: PIT integrity, feature parity, no leakage, sample
sufficiency, chronological OOS, newest holdout, walk-forward stability,
net-after-cost improvement, oversubscribed-batch lift, and no catastrophic
drawdown regression. Required reporting includes net R/PnL, TP/SL counts,
profit factor, max drawdown, CVaR, lift versus random and legacy loop, rank
IC, precision@k, calibration, Brier score, and log loss by week/month/side,
BTC regime, volatility, and crowding.

## Artifact and runtime contract

If a selector is eventually promoted, its immutable artifact must include
`selectorId`, training cutoff, feature schema version, data-manifest hash,
model hash, metrics, promotion timestamp, and git commit. Every candidate and
trade already has fields for selector mode, ID, score, rank, selection, and
execution result.

Until then:

| Environment | Allocator | Entry authority |
| --- | --- | --- |
| Testnet | `SEEDED_RANDOM_BASELINE` | baseline-only validation/data collection |
| Live | `PAUSED` | none; collection/reconciliation may run |
| Optional explicit Live override | `SEEDED_RANDOM_BASELINE` | operator-only; status reports `NO_VALIDATED_ALPHA_SELECTOR` |

No Cross-sectional champion pointer, continuation artifact, or Cross strategy
policy is reused by this Daily Range research lifecycle.
