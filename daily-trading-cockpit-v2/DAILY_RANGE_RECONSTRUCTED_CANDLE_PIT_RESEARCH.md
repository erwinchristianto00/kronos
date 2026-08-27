# Daily Range RECONSTRUCTED_CANDLE_PIT research

Research date: 2026-08-27 Asia/Taipei  
Dataset class: `RECONSTRUCTED_CANDLE_PIT`  
Authority: research only; never production execution authority.

## Purpose

Historical `FULL_PIT` is not available because exact decision-time BBO, historical rolling C1–C6 membership, Testnet availability, and ownership conflicts are not reconstructable from the archive. That does not make market-direction research impossible; it means its scope must be labelled honestly.

This study replays only the market/signal path using canonical Binance USD-M mainnet candles. It does **not** claim historical production-execution parity and cannot promote an allocator.

## Data and eligibility contract

- Source: Binance USD-M mainnet public candles.
- Requested research horizon: up to 180 days ending at the last completed Binance 5m bar.
- 5m candles: exact route state.
- 1m candles: TP/SL barrier sequence and approximate MFE/MAE only.
- 1h and 4h candles: source-coverage audit; conservative features are derived from completed 5m panels at the same decision timestamp.
- Research universe: a 12-symbol current-snapshot candle-eligible USDT perpetual panel plus BTC/ETH auxiliary market series.
- Unknown/not reconstructed: exact historical C1–C6 membership, liquidity, spread, Testnet availability, strategy ownership, and delisted-contract representation.

The resulting eligibility label is `CANDLE_ELIGIBLE_CURRENT_UNIVERSE`; it carries survivorship bias. The result must not be described as an unbiased whole-market replay.

## Causality contract

- Route state uses the shared pure `advanceDailyRangeAutoRoute` function also used by runtime.
- Every feature at decision time T sees only candles whose `closeTime < T`.
- A 1m TP/SL bar touching both barriers is `OUTCOME_AMBIGUOUS`, excluded from primary model fitting.
- There is no forced EOD label. An unresolved path stays `UNRESOLVED`; a 25-hour completed observation window is still labelled as censored/unresolved.
- Economic selection is a current-friction proxy, explicitly not a reconstructed historical fill model.

## Candidate and selection evaluation

Candidate rows remain in chronological same-timestamp batches. Train/validation/newest-holdout partitions are by entire batch, never random row split. The primary operational comparison replays scarce-slot selection on oversubscribed batches:

```text
ECONOMIC_QUALITY_BASELINE ranking
vs
route specialist alpha score ranking
```

Reported diagnostics include outcome counts, pTP calibration/logloss, rank correlation, batch-local precision@1/2/3, selected net R/modelled USD, profit factor, max drawdown, CVaR, and batch-bootstrap confidence intervals for alpha minus economic selection. Seeded-random and non-discriminating route-base-rate baselines are reported separately. Correlated symbols within a batch are never treated as IID rows.

## Final 180-day result

Run: `rcpit-20260827-180d-v5` from source commit `da3b6cc7c87281011e79ce0fb99c212db0cf864d`.

| Item | Result |
| --- | --- |
| Completed-candle window | 2026-02-28 06:55 UTC through 2026-08-27 06:59:59 UTC |
| Research symbols | 12 current-snapshot USD-M perpetuals, with BTC/ETH auxiliary panels |
| Candidates | 13,823: 7,958 Continuation and 5,865 Fade |
| Outcome labels | 4,469 TP, 9,291 SL, 5 ambiguous, 58 unresolved; 13,765 complete 1m windows |
| Missing state | 0 skipped symbol-days; no candle interpolation |
| Historical eligibility | `CANDLE_ELIGIBLE_CURRENT_UNIVERSE`; C1–C6, historical liquidity/spread/ownership, and delisted symbols remain not reconstructed |
| Overall historical verdict | `REJECTED` |

The newest-holdout combined selector replay selected 102 economically admissible rows. `ECONOMIC_QUALITY_BASELINE` returned -6.7252R / -1.6813 USD; alpha returned -6.7407R / -1.6852 USD. There was only one oversubscribed batch and alpha's batch delta was -0.0155R (95% interval is degenerate because N=1). This is neither an edge nor sufficient evidence for a selector claim.

The artifact is `daily-range-rcpit-f84b16b3`, status `REJECTED`, with `executionAuthority: false`. It records historical gate `FAIL`, forward Full-PIT `PENDING 0/20`, Testnet parity `PENDING`, and operator approval `NOT_APPROVED`.

## Non-promotion rule

Even a positive reconstructed historical result can only become `HISTORICALLY_VALIDATED` research evidence. Production authority additionally requires at least 20 mature, complete `FULL_PIT` oversubscribed forward batches, Testnet parity, and explicit operator approval. The research artifact explicitly records `executionAuthority: false`.
