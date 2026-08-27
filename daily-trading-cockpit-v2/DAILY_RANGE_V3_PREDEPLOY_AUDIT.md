# Daily Range V3 pre-deploy audit

Audit date: 2026-08-27 (Asia/Taipei). Scope is read-only until the V3 release cutover.

## Runtime provenance

| Lane | PM2 process | active release | deployed source | durable Daily Range state |
| --- | --- | --- | --- | --- |
| Testnet | `dtc-api-testnet` | `daily-range-chart-events-9ffc23f-20260827T033704Z` | `9ffc23f` | `/root/kronos-testnet-releases/128b09f/daily-trading-cockpit-v2/apps/api/data/daily-4h-range-acceptance-2r-v1.json` |
| Live | `dtc-api-live` | `pool-preview-consistency-5215e7c-20260827T031400Z` | `5215e7c` | `/root/kronos-live/daily-trading-cockpit-v2/apps/api/data/daily-4h-range-acceptance-2r-v1-mainnet.json` |

The Testnet release's state path is a shared-state symlink. The Live state path is outside release directories. A V3 cutover must preserve those files unchanged and restart only one PM2 process per lane.

## Actual policy before V3

Both running lanes report `AUTO_ROUTE_NY_V2` with an armed lane and a fixed three-position cap. Router semantics already match the required invariant:

- completed 5-minute data only;
- 00:00–04:00 New York reference range;
- expanding breakout closes select Continuation; re-entry before continuation selects Fade;
- structural stop and exact 2R native reduce-only SL/TP brackets;
- one Daily Range position per symbol; no forced EOD, MFE, or trailing exit.

The mismatch is allocation authority, not route semantics: both active lanes report `SEEDED_RANDOM_BASELINE`. That can be deterministic but does not express candidate quality, stop economics, or an alpha edge.

## Open-position safety snapshot

At audit time, both stores had zero pending entry reservations and all persisted Daily Range opens matched an exchange-native stop/TP pair.

| Lane | open trades | symbols | native bracket pairs |
| --- | ---: | --- | ---: |
| Testnet | 3 | `OPUSDT`, `ASTERUSDT`, `FILUSDT` | 3/3 |
| Live | 3 | `PROMUSDT`, `LTCUSDT`, `VVVUSDT` | 3/3 |

No V3 action is allowed to rebuild, reselect, resize, cancel, close, or otherwise modify these six trades. Existing state remains legacy/current-policy evidence only; the V3 allocator applies only to a new completed 5-minute batch after the cutover boundary.

## Cross isolation and account safety

- Cross executor has no persisted active basket, orphan leg, or exchange-incident entry halt in either state store at audit time.
- Historical `COMMITTED` account-exposure records are audit history, not active capacity reservations. Only `RESERVED` records consume capacity.
- Daily Range keeps its own symbol lease and checks exchange positions, regular orders, and conditional orders before its market entry.

## V3 change boundary

V3 changes only candidate preparation, allocation, planned size, and new-entry accounting for `AUTO_ROUTE_NY_V2`:

1. C2 closes and all symbols finish discovery.
2. Forward BBO and causal features are persisted for every candidate.
3. A frozen daily friction model, structural stop, stop-risk, and capped size are evaluated before allocation.
4. Only eligible candidates compete in one atomic top-N economic allocation.
5. Entry uses the frozen decision quantity. The exchange fill freezes actual initial risk, then native brackets are placed.

No older V1 record is reinterpreted; no existing open position enters this path.

## Pre-deploy gates

- API typecheck and targeted Daily Range tests must pass.
- Testnet release must preserve its three positions and six native brackets before and after PM2 restart.
- A natural Testnet signal only: no forced signal, no canary, and no manual order for V3 validation.
- Live promotion requires the same source patch, a clean Testnet smoke, config check, state snapshot, and a repeat exchange reconciliation. If friction-model creation fails in Live, new entries fail closed while open-bracket reconciliation continues.
