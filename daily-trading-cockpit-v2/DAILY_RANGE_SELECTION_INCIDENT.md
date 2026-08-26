# Daily Range selection incident

## Incident classification

**Confirmed structural allocation defect, not a universe or signal-rule
failure.** When simultaneous valid Daily Range signals exceeded capacity, the
old runtime allocated scarce slots according to lexical iteration order.

The behavior originated in `877fc6711802bf85a651ef757a93b219c05b499e` on
2026-08-26 and remained in the Live source baseline reconciled by
`f21db96544c217865bba9ee57fab85eaf0f83cf1`.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 09:10–12:15 | Live state recorded 87 accepted signals and 12 Daily entries under the old loop/cap allocator. |
| 12:20:11 | New Daily entries were explicitly disarmed with reason `SELECTION_FIX_PENDING_VALIDATION`. |
| 12:20 | Snapshot taken at `/root/kronos-live-snapshots/daily-range-selection-bias-containment-20260826T122200Z`. |
| 12:30 | HOLO native TP filled; its native stop sibling was cancelled by the exchange/lane lifecycle. |
| 12:45 | ONG native stop filled; its native TP sibling was cancelled by the exchange/lane lifecycle. |
| After containment | No Daily entry intent or accepted signal was created after the disarm timestamp. |

## Containment verification

Containment was entry-only. It did not invoke a close, resize, ownership
change, bracket cancellation, or Cross-sectional operation.

At containment, the two open Daily positions were:

| Symbol | Side | Qty | Native SL | Native TP |
| --- | --- | ---: | ---: | ---: |
| ONGUSDT | SHORT | 269 | `2000001387863037` | `2000001387863039` |
| HOLOUSDT | SHORT | 376 | `2000001387871016` | `2000001387871017` |

Signed Binance history subsequently confirmed the original lifecycle:

| Symbol | Triggered native algo | Fill | Sibling state |
| --- | --- | --- | --- |
| ONGUSDT | SL `2000001387863037` finished | reduce-only BUY 269 at 0.0953900 | TP `2000001387863039` cancelled |
| HOLOUSDT | TP `2000001387871017` finished | reduce-only BUY 376 at 0.0656600 | SL `2000001387871016` cancelled |

The later signed account check found no open Daily position, no open Daily
algo order, and no pending Daily entry intent. This closure happened under the
existing native exit contract, not through the containment action.

## Affected historical fills

Potentially affected means only that the symbol received or lost a scarce slot
because of ordering. It does **not** mean the fill was necessarily bad.

The clearest batches were:

| Batch | Entered under old allocator | Signals that lost capacity |
| --- | --- | --- |
| 09:35 | AKE SHORT, BCH SHORT | BTW, CYS, HOLO, JASMY, MON, ONG, PENGU, POL, PUMP, STORJ, TAC, XMR, XP (ACE was blocked by its own existing lane position) |
| 10:25 | FF SHORT | PUMP LONG, TRUMP LONG |
| 10:30 | ETHFI LONG | FARTCOIN LONG, XMR LONG |

The exact candidate state and counterfactual path results are preserved in the
research report. Historical rows lack exact signal-time order-book data, so
they are `PARTIAL_RECONSTRUCTION` and are excluded from promotion-quality
training data.

## Why existing tests missed it

The original tests proved that a single signal could reserve a pending trade
before an order and that each entry respected a cap. They did not test the
portfolio decision:

- no same-candle oversubscription fixture;
- no permutation of candidate order;
- no assertion that all symbols had finished C2 evaluation before the first
  order;
- no test that all selected reservations were durable before the first POST;
- no explicit selected-entry-failure/no-replacement test.

## Corrective action

The replacement is a batch allocator, not a universe reduction or subjective
indicator score. It:

1. persists all valid signals for a canonical closed 5m timestamp;
2. waits for every eligible symbol’s candle watermark at that timestamp;
3. preflights all candidates under one allocator authority;
4. calculates slots once;
5. uses an order-independent mode and deterministic hash tie-break;
6. durably reserves every selected trade before the first exchange POST; and
7. leaves a failed selected slot unused rather than promoting a later signal.

New skip reasons distinguish `NO_AVAILABLE_SLOT`,
`SKIP_CAP_LOWER_RANK`, `STRATEGY_SYMBOL_CONFLICT`,
`SPREAD_HARD_REJECT`, `SELECTOR_NOT_READY`,
`LIVE_NEW_ENTRY_PAUSED`, and `SELECTED_EXECUTION_FAILED`.

## Causation boundary

Confirmed:

- loop/lexical order controlled allocation under cap pressure;
- real Live signals lost allocation because capacity had already been consumed;
- prior tests did not protect this portfolio-level invariant.

Not established:

- that the old ordering caused the observed realised losses;
- that a liquidity, spread, trend, or model selector would have earned more;
- that shrinking C1–C6 would fix the defect.

Those questions require a forward, PIT-safe selector dataset and chronological
out-of-sample testing. Live remains entry-paused until that requirement or an
explicit operator baseline override is satisfied.
