# Daily 4H Range Acceptance 2R v1 — Pre-deploy Audit

Scope: `daily-4h-range-acceptance-2r-v1`, Testnet only. This audit does not authorize or modify Live deployment, Dynamic MOM36, V1–V4, or incumbent baskets.

## P0 — Must be resolved before arm

| Check | Result | Evidence / control |
|---|---|---|
| Testnet venue only | PASS (code) | The lane is constructed only when `LIVE_BINANCE_ENV === "testnet"` and `!isTest`; all mutating endpoints reject non-Testnet callers. No Live route can arm it. |
| One-way/netted account semantics | PASS (code), runtime check pending | Startup calls `isHedgeMode()` and refuses/disarms on hedge mode. A live Testnet canary must re-prove this before arm. |
| Symbol ownership across strategies | PASS (code + unit) | Durable daily trade states are symbol leases. Dynamic Cross checks the lease before a new basket and atomically claims every unfilled leg before maker pre-placement or market submission. A clean reserved basket is aborted if a durable lease appears in that gap; a partial basket is never abandoned. The legacy mirror receives the daily owned signed quantity and a same-side entry veto, so it cannot adopt or widen the lane position. |
| Durable intent before order | PASS | `ENTRY_SUBMITTING` is atomically persisted before the market POST. Unknown POST results reconcile by the exact client order id; no automatic resend. |
| Bracket failure handling | PASS (code + unit) | Entry is verified against exact signed position quantity and 1x leverage. A terminal partial market fill is adopted at its actual quantity and bracketed; Stop + TP must both be visible, otherwise an emergency reduce-only flatten retains any existing bracket until flatness is proven. |
| Stop/TP ownership | PASS | Brackets use lane-owned client algo ids, `reduceOnly`, exact entry quantity, and sibling cancellation only after the exit is proven. |
| Controlled exchange canary | PENDING runtime | Required sequence: Testnet market entry → both native brackets visible → cancellation → reduce-only close → no open position/order. Arm endpoint refuses without a persisted passed canary. |

## P1 — Must be resolved before arm

| Check | Result | Evidence / control |
|---|---|---|
| Reference venue / candle provenance | PASS | The private client now reads `/fapi/v1/klines` from the selected USD-M execution venue. No spot interpolation/fallback exists. |
| UTC daily reference | PASS (unit) | Only an exact `00:00–04:00 UTC` 4h candle becomes a persisted level after 04:00 UTC. |
| C1/C2 and reset contract | PASS (unit) | `>= high` / `<= low`, two consecutive closed 5m candles, one trigger per side outside-run. A close below HIGH resets the LONG run and a close above LOW resets the SHORT run, including a direct reversal across the range. |
| Stale/missing data | PASS | Watermarks never jump a missing 5m bar. The path is recorded as stale/error and no candle is invented. Startup/disarmed history is not backfilled into an entry. |
| 2R geometry | PASS (unit) | Structural stop uses actual fill and conservative tick rounding. Invalid/zero R flattens rather than sending a bracket. |
| No hidden global cap | PASS (unit) | Ten simultaneous distinct symbols can independently open; per-symbol ownership remains the only lane cap. |
| Current short blocklist | PASS | Short confirmation is retained as `SHORT_BLOCKED` but no entry is submitted. |

## P2 — Operational correctness

| Check | Result | Evidence / control |
|---|---|---|
| Restart recovery | PASS (unit) | Day levels, universe snapshot, watermarks, locks, signals, intents, bracket IDs, and MFE/MAE are durable. Restart does not replay an already processed C1/C2 pair. |
| Exchange reconciliation | PASS (code) | Pending entries, open positions, owned algos, and unknown responses reconcile by exact exchange identities; unresolved state disarms instead of guessing. |
| Slippage / cost records | PASS | Entry reference, actual entry fill, entry slippage, actual exit, fills, fees, funding, and net realized R are persisted. Native-trigger exit slippage remains explicitly null when no pre-trigger executable quote was observed. |
| Operator controls | PASS (code) | Isolated Testnet API: status, levels/signals/trades history, JSON/CSV export, canary, arm/disarm, and exact-trade controlled close. |

## P3 — Non-blocking observations

- This is a forward Testnet measurement lane, not a historical optimization or backtest.
- Dashboard presentation can consume the status/history API; the lane also emits structured server logs now. No existing dashboard panel or incumbent route is changed by this deploy.
- The Testnet canary and post-cutover health checks are still required before this document is marked deployment-complete.

## Runtime predeploy snapshot

- Active Testnet process: `dtc-api-testnet`, online, release `dynamic-mom36-continuation-sl2-mfe30-36h-v3-4baba456392c-20260825T151215Z`, port `3102`.
- Signed account check: `LIVE_BINANCE_ENV=testnet`; `hedgeMode=false` (one-way); `527` USD-M symbol filters available.
- Existing foreign Dynamic MOM36 basket is intact: `xb-mt6yf1ze-ltered`, six 3x cross-margin legs (`TAOUSDT`, `SEIUSDT`, `SUIUSDT`, `INJUSDT`, `NEARUSDT`, `ARBUSDT`).
- Signed exchange open-order check: `0` regular orders and `0` conditional/algo orders.
- Current pool snapshot is auto-pool `ACTIVE`, 20 symbols; the lane freezes its own copy only at the next applicable UTC 04:00 reference creation. Current short blocklist has six symbols and is reused unchanged.
- Rollback anchor: commit `4baba456392c7d203fa9f03e9968b0aeb6e3854a`; durable Testnet state remains at the existing shared `apps/api/data` path and will be reused, not migrated destructively.

## Unit evidence before deployment

- `daily-4h-range-acceptance-lane.test.ts`: UTC reference/window, equality/C1-C2/directional-reset, tick rounding, collision block, ten simultaneous symbols, terminal partial-fill protection, bracket lifecycle canary, restart deduplication.
- `binance-futures-private.test.ts`: selected-venue USD-M kline parsing.
- `cross-sectional-executor.test.ts`: a daily-range lease stops a new Dynamic basket before any reservation or order, and safely aborts a clean reserved basket if the lease appears immediately before placement.
- `live-execution-engine.test.ts`: a same-side daily lease vetoes an incumbent mirror entry rather than silently changing a bracket-owned quantity.
