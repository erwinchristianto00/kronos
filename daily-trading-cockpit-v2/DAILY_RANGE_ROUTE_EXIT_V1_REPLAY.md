# Daily Range Route-Specific Exit V1 — Historical Replay

## Purpose and fixed hypotheses

This is a diagnostic replay only. It compares the fixed V1 policy with the
old frozen global-2R bracket; it does not train a selector, optimize a target,
or sweep TP values.

- Continuation: old `2R + structural SL`; new `1R + completed-5m range re-entry + structural SL`.
- Fade: old `2R + structural SL`; new `2R + completed-5m original-breakout re-acceptance + structural SL`.

The replay walks chronological one-minute USD-M candles for native barriers.
For V1, native barriers are evaluated before the completed five-minute logical
close. A one-minute bar touching both native barriers is labelled ambiguous;
a missing/gapped path is explicit and never interpolated. The new logical
exit uses the completed 5m close as a research price proxy only; production
records the actual reduce-only fill and slippage.

## Source compatibility rule

The signal lane and candle source must match:

- Mainnet signal cohort -> `https://fapi.binance.com` USD-M candles.
- Testnet signal cohort -> `https://testnet.binancefuture.com` USD-M candles.

Testnet signal rows must never be replayed against mainnet candles. An early
mixed-source exploratory run was therefore discarded rather than counted.

## Harness verification

`apps/api/scripts/replay-daily-route-exit-v1.ts` is read-only and consumes the
exported signal history through stdin. It carries the actual stored legacy
rounded 2R target, gives both policies the same 1,500-minute causal horizon,
and reports legacy label mismatches separately from fetch failures.

The deterministic replay unit coverage verifies:

1. V1 continuation range-reentry can exit before legacy 2R.
2. Legacy native 2R does not become unavailable merely because its terminal
   one-minute candle is inside a partial five-minute group.
3. Same-minute TP/SL is ambiguous rather than assigned a favorable sequence.

## Current external-data status

At implementation verification time, the mainnet public USD-M endpoint
returned HTTP 418 even for one read-only, single-episode request after paced
retries. No further requests were sent, so this file deliberately contains no
invented quantitative historical result. The diagnostic can be resumed after
the public transport cooldown clears with:

```sh
ssh -i /Users/erwin/.ssh/contabo_dtc -o IdentitiesOnly=yes -o BatchMode=yes root@194.233.71.109 \
  'curl -sf "http://127.0.0.1:3103/api/live/daily-range-lane/history?kind=signals&limit=10000"' \
  | DAILY_ROUTE_REPLAY_LIMIT=250 DAILY_ROUTE_REPLAY_CONCURRENCY=1 \
    DAILY_ROUTE_REPLAY_MIN_REQUEST_GAP_MS=750 DAILY_ROUTE_REPLAY_RETRY_COUNT=1 \
    npx tsx apps/api/scripts/replay-daily-route-exit-v1.ts
```

The replay result is research evidence only. It has no order, allocation, or
configuration authority.
