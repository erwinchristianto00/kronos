# Daily Range V3 friction formula audit

Audit date: 2026-08-27 Asia/Taipei  
Scope: execution-cost attribution and fail-closed entry economics only. This document does not change route, structural stop, 2R target, sizing caps, or an existing position.

## Verdict

The apparent omission of entry execution friction was a **metric-label ambiguity, not a missing cost term**. The pre-trade safe-loss model is deliberately:

```text
safeLossFrictionBps
  = entryFeeP95Bps
  + exitFeeP95Bps
  + safetyMultiplier × lossAdverseP95Bps
```

where `lossAdverseP95Bps` is the p95 of one **pointwise all-in loss path**, not a standalone stop gap. For each stopped trade that path is:

```text
entry adverse versus decision-side BBO
+ lane-originated immediate market-exit adverse versus pre-exit BBO, when observed
+ native stop trigger-to-fill gap versus the frozen structural stop
```

Consequently, adding the separately reported `entryAdverseP95Bps` again would double count entry friction and can construct a percentile combination that never occurred on one loss path.

## Definitions and non-overlap

| Component | Reference | Includes fees? | Role in safe loss |
| --- | --- | --- | --- |
| `entryFeeP95Bps` | exchange commission for entry fill | No | added once |
| `exitFeeP95Bps` | exchange commission for exit fill | No | added once |
| `entryAdverseP95Bps` | decision BBO to actual entry fill, adverse side | No | diagnostic only; already included within each loss-path observation |
| `stopGapP95Bps` | native structural-stop trigger to stop-fill adverse gap | No | diagnostic component of loss path |
| `lossAdverseP95Bps` | p95 of the per-loss sum above | No | multiplied once by the current safety multiplier |

The decision reference is the causal executable BBO: ask for a Long and bid for a Short. Native Daily brackets use `CONTRACT_PRICE`; the trigger-to-fill component is therefore contract-price based, not a mark-price proxy.

## Current audited artifacts before this completion release

| Environment | Artifact | Terminal ledger N | Fee evidence | Entry adverse p95 | stop / loss path p95 | Fee p95 in + out | Safe loss | Implied minimum structural stop at cost ratio 0.25 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| Testnet | `daily-friction-v1-20260827043500-c0475d0cce42` | 41 | 0 exact, 41 legacy combined allocation | 0.00 bps | 2.0499 bps all-in loss path | 5 + 5 bps | 12.5623 bps | 50.249 bps |
| Live | `daily-friction-v1-20260827045000-d0069844cb6f` | 26 | 0 exact, 26 legacy combined allocation | 2.5085 bps | 18.7866 bps all-in loss path | 5 + 5 bps | 33.4833 bps | 133.933 bps |

The values use the then-current 1.25 safety multiplier. The Live arithmetic is `10 + 1.25 × 18.7866 = 33.4833 bps`; it is correct only because the 18.7866 bps statistic is already all-in path adverse friction. It is not a bare `trigger → fill` stop gap.

## Evidence quality and environment isolation

- Historical pre-V3 totals are genuine exchange commissions but cannot be defensibly split by entry/exit; they remain `LEGACY_COMBINED_FEE_ALLOCATION`.
- New V3 terminal settlement counts actual user-fill rows per entry and exit and persists `EXACT_FILL_COMMISSION`, `entryFillCount`, and `exitFillCount`.
- The amended model artifact carries `environment`, source trade count, source fill count, known-fill trade count, training cutoff, source sample hash, formula definition version, and formula text inside its immutable model hash.
- A friction artifact whose persisted environment differs from its lane is rejected. Testnet values never calibrate Live and vice versa.

## Policy retained

- `MAX_COST_RATIO = 0.25`; this is not fitted to realized PnL.
- `MAX_NOTIONAL_USD = 25` and `MAX_PLANNED_RISK_USD = 0.25` remain unchanged.
- A structural stop that fails economics is `STOP_ECONOMICS_FAIL`; it is never widened.
- A post-fill deviation is attributed as `POST_FILL_ECONOMICS_FAIL` or `POST_FILL_RISK_FAIL` with the existing 15% operational reconciliation tolerance. That tolerance handles quantity/tick/fill mechanics; it is not an alpha or PnL tuning parameter.

## Regression evidence

The targeted economics tests prove a loss sample with disjoint high entry adverse and high stop gap observations yields the actual p95 all-in loss path, not their invalid sum. They also prove exact fee components are counted once and post-fill dollar-risk excess is not mislabeled as generic economics failure.

## Completion state

Source changes are complete and targeted tests pass. Deployment provenance and the post-cutover artifact identifiers are recorded in `DAILY_RANGE_V3_COMPLETION_DEPLOY_REPORT.md` after the Testnet-then-Live cutover.
