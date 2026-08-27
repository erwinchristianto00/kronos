# Daily Range V3 stop-economics audit

Audit date: 2026-08-27. This is an execution-cost audit, not a PnL threshold optimisation.

## Source and limitations

The pre-deploy ledger contains actual exchange closed-fill totals but predates V3's per-order commission persistence. Therefore:

- Testnet: 41 closed trades; 19 TP / 22 SL; 0 rows with separate entry/exit fees.
- Live: 25 closed trades; 8 TP / 17 SL; 0 rows with separate entry/exit fees.
- Historic total `feesUsd` is real. Its entry/exit split is marked `LEGACY_COMBINED_FEE_ALLOCATION`, proportional to entry and exit notionals; it is **not** presented as an exact per-order fee.
- V3 settlement persists exact `entryFeesUsd`, `exitFeesUsd`, and `feeEvidence=EXACT_FILL_COMMISSION` from the exchange user-fill ledger for future closed trades.

## Read-only ledger snapshot

| Metric | Testnet | Live |
| --- | ---: | ---: |
| closed usable fills | 41 | 25 |
| entry fee p50 / p95 | 4.00 / 5.00 bps | 5.00 / 5.00 bps |
| exit fee p50 / p95 | 4.00 / 5.00 bps | 5.00 / 5.00 bps |
| entry adverse execution p50 / p95 | 0.00 / 0.00 bps | 0.00 / 2.54 bps |
| stop gap p50 / p95 | 0.00 / 2.05 bps | 0.48 / 19.14 bps |

The snapshot is an input to a frozen model, not a claim that every future stop will gap by those values. The model is frozen once for a UTC decision day and its ID, cutoff, sample counts, percentiles, and SHA-256 hash are persisted before that day's first V3 allocation.

## V3 economics contract

For every candidate, using causal BBO (`ask` for a Long, `bid` for a Short) plus p95 adverse entry friction:

1. Round the **unchanged structural stop** and exact 2R target to the exchange tick.
2. Compute `stopRiskBps` from the expected executable entry to that stop.
3. Compute safe loss friction:

   `entryFeeP95 + exitFeeP95 + 1.25 × lossAdverseFrictionP95`

4. Reject `STOP_ECONOMICS_FAIL` when:

   `safeLossFrictionBps / stopRiskBps > 0.25`.

5. Size without widening a stop or raising notional to satisfy a filter:

   `notional = min(25 USDT, 0.25 USDT / stopDistanceDecimal)`.

   Quantity is rounded down to exchange step size. If minQty/minNotional cannot be met within both limits, reject `RISK_BUDGET_UNEXECUTABLE`.

6. After actual fill, recompute initial dollar risk and cost ratio. A material breach records `POST_FILL_ECONOMICS_FAIL`, preserves structural brackets while the exact reduce-only flatten is reconciled, and never changes the stop. Material means either cost ratio exceeds 25%, or cost/risk differs by more than 15% from the frozen pre-trade plan; the 15% band is a reconciliation safety tolerance, not an entry-optimisation parameter.

## Allocation score (non-alpha)

Candidates that pass all safeguards are ranked by lower break-even win rate, lower cost ratio, then higher capped planned risk, with a deterministic hash of policy, batch timestamp, symbol, side, and route. The score does not use realised PnL, a future mark, outcome labels, alphabetical input order, or a new optimised threshold.

`netWinR = 2 − medianWinFrictionBps / stopRiskBps`

`netLossR = −1 − medianLossFrictionBps / stopRiskBps`

`breakEvenWinRate = abs(netLossR) / (netWinR + abs(netLossR))`

## Fail-closed behavior

- Live with fewer than 12 usable terminal ledger samples: `FRICTION_MODEL_UNAVAILABLE`; it records the candidate and submits no new Daily Range order.
- Testnet with insufficient samples: explicitly persisted `CONSERVATIVE_FALLBACK`, never zero slippage or zero fees.
- A model is immutable once referenced by a candidate; later fills create a later model only, never rewrite a past decision.
