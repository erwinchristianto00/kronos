# Replay audit — Testnet

This is a read-only diagnostic of closed historical Fade records. It is **not** a threshold optimization.

## Stored history

- Closed Fade records: 19.
- Path quality: 3 `EXACT_STREAM`, 12 `APPROX_1M`, 1 `INCOMPLETE`, 3 `MISSING`.
- Stored extrema indicate 6 records reached at least 50% of the frozen target and 3 reached at least 75%.
- Extrema timestamp is available for 16 records.

## What cannot be claimed

The historical store does not retain each ordered aggregate-trade event after entry. `APPROX_1M` records only retain intrabar extrema, so a 1m bar can touch both an MFE floor and a native TP/SL without an honest order of events.

Therefore:

- Exact event-path replay N: 0.
- Hypothetical MFE exits, P&L deltas, and win/loss attribution: **not determinable** from this stored history.
- No threshold, route, TP/SL, or admission rule was tuned from these counts.

Forward live contract-path telemetry will persist the causal sequence needed to compare a real MFE exit with the original frozen bracket counterfactual.
