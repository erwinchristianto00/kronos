# Daily Range V3 MFE / MAE completion audit

Audit date: 2026-08-27 Asia/Taipei  
Scope: measurement and attribution only. No MFE/MAE reading is connected to stop amendment, trailing, take-profit, allocation, or manual closing.

## Prior limitation

The old field was a roughly 30-second account-reconciliation mark sample. It could miss a native `CONTRACT_PRICE` stop/TP excursion entirely; in particular, a trade could fill at 2R while its recorded MFE remained below 2R. That made it unsuitable for future exit research and misleading as an execution-quality diagnostic.

## Completed measurement contract

Native Daily stop and TP orders have `workingType=CONTRACT_PRICE`. The new observer therefore consumes Binance USD-M aggregate contract trades, not mark price, from the actual entry fill through the final exit fill.

```text
actual entry fill timestamp
  → CONTRACT_AGG_TRADE event extrema
  → terminal EXIT_FILL price observation
  → optional deterministic complete-1m recovery when stream coverage is not exact
  → freeze
```

The periodic account reconciler still records `lastMarkPrice` for display, but it no longer changes MFE or MAE.

## Persisted fields

Each future Daily trade can persist:

- `mfePrice`, `mfeR`, `mfeEventTime`
- `maePrice`, `maeR`, `maeEventTime`
- `lastPathPrice`, `lastPathEventTime`, `lastPathReceivedAt`
- `pathSource`, `pathQuality`, stream start, gap, recovery, and terminal-freeze fields.

No event after the frozen final exit can change those extrema.

## Quality labels

| Label | Meaning | Claim allowed |
| --- | --- | --- |
| `EXACT_STREAM` | continuous contract aggregate-trade coverage began no later than the actual entry and remained through the terminal fill | exact contract-path extrema |
| `RECOVERED_FINE_DATA` | reserved for a deterministic higher-resolution recovery source if available | exact only if its order/coverage proves it |
| `APPROX_1M` | complete one-minute OHLC bars wholly inside actual entry-to-exit interval | approximate excursion; intra-minute order is unknown |
| `INCOMPLETE` | a stream gap, missing bars, or invalid timing prevents defensible reconstruction | no exact/approximate claim beyond recorded points |

At a socket interruption, every affected open path is downgraded; a later reconnect does not erase the missing interval. A successful complete-1m terminal recovery is labelled `APPROX_1M`, never `EXACT_STREAM`.

## Existing positions

Existing open Daily positions retain entry quantity, entry fill, route, structural stop, TP, native order IDs, ownership, and all execution behavior. The observer may populate measurement fields only. It cannot cancel, resize, or modify a bracket.

## Regression evidence

Tests cover:

1. multiple contract events from entry through exit, with MFE/MAE frozen before a later market event;
2. stream interruption downgrading quality while native brackets remain untouched;
3. malformed aggregate-trade input being ignored rather than inventing an extrema point; and
4. terminal 1m recovery only when every included candle is fully contained and contiguous.

## Deployment validation

The observer is deployed in both environments and logged `DAILY_RANGE_PATH_STREAM_OPEN` after each API restart: 50 subscribed symbols on Testnet and 51 on Live at the final health check. The API status reports `triggerWorkingType=CONTRACT_PRICE`, `collection=BINANCE_USDM_AGG_TRADE_STREAM`, and `fallback=COMPLETE_1M_OHLC_ONLY`.

The pre-existing Testnet `OPUSDT` trade now receives current contract-stream observations, but its quality is correctly `INCOMPLETE` because its actual entry occurred before the observer began. Its original quantity, entry, TP, SL, native algo IDs, and exit behavior were unchanged. Live had no Daily position during cutover, so no artificial test trade was opened.

## Completion state

The source-side measurement path, status summary, dashboard quality label, and Testnet-then-Live stream health validation are complete. The ongoing work is passive collection of future entry-to-terminal paths; it has no control over stop, TP, allocation, or closing.
