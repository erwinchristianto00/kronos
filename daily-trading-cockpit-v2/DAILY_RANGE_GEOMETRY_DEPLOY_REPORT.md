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
