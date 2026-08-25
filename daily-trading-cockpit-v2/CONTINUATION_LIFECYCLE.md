# Autonomous Continuation Lifecycle

## Scope and authority

This service maintains the Dynamic MOM36 continuation artifact. It is separate from the order
process and has no exchange client. It may only affect a **future** basket formation through the
already-frozen V4 mapping:

```text
MOM36 breadth base allocation
  -> continuation confirmation/conflict, maximum plus/minus one rung
  -> MOM36 ranking
  -> strict SLOW_AND_FAST per-leg eligibility
  -> entry
```

It cannot veto, select symbols, alter `SLOW_AND_FAST`, change an open basket, steer an exit, alter
the `-2%` stop, `+3%` MFE arm, `30%` giveback, `36H` cap, `$25` legs, `1x`, or `MAX_OPEN=1`.
The Daily 4H range lane is isolated.

## Services

One canonical root is shared by both API lanes:

```text
/root/kronos-continuation
  raw/                       new append-only event envelopes
  quarantine/                rejected records with a reason
  materialized/              atomic V4-compatible source views
  snapshots/<runId>/         immutable training input plus hash manifest
  runs/<runId>/              matrix, trainer logs, candidate bytes
  registry/artifacts/        immutable artifacts and metadata
  registry/history/          immutable final run records
  registry/champion-pointer.json
  status/
  commands/
  locks/
```

- `kronos-continuation-collector`: WebSocket-primary completed Binance candles, with REST
  bootstrap/reconciliation. It runs whether or not there is a basket or an armed lane.
- `kronos-continuation-lifecycle`: low-priority scheduler. It checks health every 15 minutes,
  evaluates training eligibility, and is the only process allowed to change the pointer.
- TESTNET and LIVE APIs are read-only registry consumers. They use the same pointer, then the
  previous approved artifact on a corrupted current record, then the pinned V4 bootstrap artifact.

## Schedule

```text
completed kline ingest             WebSocket continuously
REST reconciliation                startup, reconnect/gap repair, then hourly
health/status refresh              collector each minute / lifecycle each 15 minutes
label maturation eligibility       each lifecycle tick
full immutable matrix snapshot     only when retraining is eligible
challenger retrain                 at least 7 days since current training AND >=168 new mature rows
```

The full rebuild is intentionally not hourly. It is a reproducible weekly-or-slower training
snapshot, while data collection and maturity continue all the time.

## Training protocol

1. Freeze a label cutoff at `min(last complete common bar - 36H, now - 36H - 15m)`.
2. Atomically copy only the V4-compatible materialized data into a named snapshot and hash every
   copied file.
3. Build the admission-conditioned matrix using the same TypeScript feature engine as runtime.
4. Reject any row whose feature timestamp exceeds formation or whose label is not mature.
5. Train the fixed V4 LightGBM family: H6/H12/H24/H36 specialists, OOF trajectory head and
   validation-only temperature. Threads are capped at two. The trainer emits a deterministic
   holdout reference fixture, which must match TypeScript tree inference before promotion.
6. Evaluate the newest chronological 20% block after a 36-row embargo, using the exact runtime
   TypeScript tree parser and exact V4 allocation mapping.

No hyperparameter sweep, live-PnL response, threshold tuning, or feature-set expansion happens in
this loop.

## State transitions

```text
COLLECTED -> VALIDATED -> MATERIALIZED
                                  |
                                  v
                         formation + 36H mature
                                  |
                                  v
                          immutable snapshot/matrix
                                  |
                                  v
                     candidate trained/evaluated/rejected
                                  |
                         all strict gates pass?
                           |                 |
                          no                yes
                           |                 |
                   retain champion     atomic pointer advance
```

A failed collector, trainer, matrix builder or promotion does not place/close any order. It leaves
the champion pointer unchanged. If the current pointer/artifact becomes unreadable and the
previous approved artifact validates, the lifecycle atomically rolls back for operational reasons;
three losing baskets are never an automatic rollback trigger.
