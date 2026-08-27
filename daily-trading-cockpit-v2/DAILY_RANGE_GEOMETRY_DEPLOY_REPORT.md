# Daily Range Geometry Deploy Report

This report is completed during the Testnet-first cutover.  It records the
pre-cutover snapshots, the position-by-position migration result, native-order
verification, and final PM2/runtime health for both environments.

## Pre-deploy checks

- Daily entries are paused only during cutover; existing reconciliation and
  native bracket management remain enabled.
- Testnet and Live exchange positions, open orders, Daily ownership records,
  reservations, and Cross exposure are snapshotted before mutation.
- No synthetic market canary is used.  New-entry coverage is unit/fixture and
  read-only candidate replay only.

## Required final evidence

1. Testnet deploy and migration complete before Live begins.
2. Explicit Testnet OPUSDT close has exchange-flat and zero-owned-orphan proof.
3. Each retained position preserves original native order IDs.
4. Each flattened Daily position has zero exchange quantity and zero owned
   bracket siblings.
5. Cross quantity, ownership, and pending intent are unchanged before/after.
6. The policy, reject counters, and candidate snapshots are visible through the
   Daily Range status API/dashboard.

## Completed cutover — 2026-08-27 UTC

Release commit: `c6e8134` (`fix(daily-range): gate wide trade geometry`),
based on `fdd3591`. Testnet was cut over first. In each environment the Daily
lane alone was disarmed with `DAILY_RANGE_GEOMETRY_CUTOVER`; Cross, existing
native bracket reconciliation, and all non-Daily lanes remained running.

### Testnet

Pre-cutover Daily positions were `OPUSDT` short 242.2, `BMTUSDT` long 238,
and `XMRUSDT` long 0.055. The separate Cross lane had six legs:
`1000PEPEUSDT`, `ARBUSDT`, `SOLUSDT`, `SUIUSDT`, `WIFUSDT`, and `XRPUSDT`.

| Position | Geometry result | Action / exchange result |
| --- | --- | --- |
| OPUSDT short | stop 3.876%, target 7.752%, 2.326 × ATR | Explicit owned-Daily close. 242.2 reduced at 0.0974 (`exitOrderId` `326369120`), reason `OPERATOR_REQUESTED_CLOSE_GEOMETRY_PATCH`. |
| BMTUSDT long | stop 4.948%, target 9.896% | Generic `STRUCTURAL_STOP_TOO_WIDE`; 238 reduced at 0.02152 (`exitOrderId` `160269289`). |
| XMRUSDT long | stop 0.546%, target 1.092%, 0.469 × ATR | PASS / KEPT. Existing stop `1000000183129583` and TP `1000000183129587` retained. |

After migration the exchange-facing account had seven positions: the unchanged
six Cross legs plus XMR; OPUSDT and BMT were absent. The Daily lane reported
`reconciled=true`, zero pending reservations, and no reconcile errors. It was
re-armed at `2026-08-27T11:01:59.458Z`.

After the migration/re-arm, XMR's unchanged native take-profit filled normally
at 453.71 at `2026-08-27T11:06:05.135Z` (`exitOrderId` `464722801`), with
reason `TAKE_PROFIT` and net realized `+0.26123582 USDT` (`+1.939R`). This was
not a geometry close; reconciliation then reported the six unchanged Cross
positions and no open Daily position.

### Live

Pre-cutover Daily positions were `1000BONKUSDT` long 3736, `TRUMPUSDT` long
4.05, and `BMTUSDT` long 238. The six Cross legs included `OPUSDT`; it had no
Daily ownership and was therefore not eligible for any migration action.

| Position | Geometry result | Action / exchange result |
| --- | --- | --- |
| 1000BONKUSDT long | stop 2.136%, target 4.272%, 1.040 × ATR | PASS / KEPT. Existing stop `2000001389913890` and TP `2000001389913895` retained. |
| TRUMPUSDT long | stop 2.470%, target 4.939%, 0.757 × ATR | PASS / KEPT. Existing stop `2000001389913907` and TP `2000001389913917` retained. |
| BMTUSDT long | stop 4.825%, target 9.650% | Generic `STRUCTURAL_STOP_TOO_WIDE`; 238 reduced at 0.02166 (`exitOrderId` `1489879806`). |

ATR is intentionally null for both BMT migration rows: the hard absolute-stop
failure was sufficient, so the migration did not make an unnecessary historic
ATR request before flattening. After migration the exchange-facing account had
eight positions: the unchanged six Cross legs plus the two passing Daily
positions. Live reconciliation was fresh and healthy at
`2026-08-27T11:04:41.033Z`; the previously stale 418 diagnostic was cleared.
The lane was re-armed at `2026-08-27T11:04:08.262Z`, with zero pending Daily
reservations and no reported reconciliation error.

### Native protection and UI proof

The controlled flatten path confirmed each exit before cancelling only its
owned siblings. Both flattened rows are terminal with no reconciliation error;
retained rows still carry their original native stop/TP identifiers and
subsequent reconciliations completed cleanly. The account endpoint reports zero
ordinary open orders; Daily reconciliation separately verified the surviving
native algo brackets.

Both Testnet and Live web symlinks now point at their respective `c6e8134`
release `apps/web/dist`. The status endpoint exposes `daily-trade-geometry-v1`,
all three limits, candidate geometry, and the six requested reject counters.

### Validation

- Shared, API, and web production builds passed.
- Targeted Daily Range geometry/migration tests: **58 passed**.
- Existing allocator permutation suite: **6 passed**, including its three
  deterministic 1,000-permutation assertions. The new V3 integration fixture
  separately proves a rejected geometry candidate cannot rank, reserve, or
  consume a slot.
- Full Web suite: **18 passed**.
- Full API suite: **8,244 passed, 11 failed, 3 skipped**. All 11 failures are
  pre-existing non-Daily tests in the execution-fill, Four-Brain, lane-reason,
  and position-path areas; no Daily Range geometry test failed.

### Post-cutover runtime validation — 2026-08-27T11:11Z

The lane admitted new entries only after re-arm, which independently confirms
that the gate is executable rather than merely observational. Testnet had three
open Daily positions (`AKEUSDT`, `HYPEUSDT`, and a new `XMRUSDT` trade), and
Live had three (`1000BONKUSDT`, `TRUMPUSDT`, and `PYTHUSDT`). All six recorded
`daily-trade-geometry-v1` as PASS, had no runtime/reconciliation error, had no
pending reservation, and retained both native stop and take-profit algorithmic
order IDs. The pre-cutover XMR trade described above remains closed at its
native TP; the later XMR row is a separate post-cutover admission.
