# Deploy report — Testnet

Status: **deployed to Testnet (final fail-closed follow-up active)**.

## Candidate checks completed

- API build: passed.
- Web build: passed.
- Focused API tests: 66 passed.
- Tests cover long/short arithmetic, no action below 50%, 50/75 stage behavior, ratchet monotonicity, frozen target, stream degradation, safe reduce-only MFE exit, native TP/SL race, restart persistence, and Continuation exclusion.

## Required staged validation

Before promotion, snapshot the existing account/state, verify the active PM2 release is still the audited baseline, perform the guarded Testnet cutover, and prove:

1. the existing `PROMUSDT` `ENTRY_RECONCILING` record is byte-for-byte policy-unchanged;
2. no Daily or Cross exchange position/order is modified by restart;
3. the status endpoint exposes `fadeMfe` with zero retrofitted active trades;
4. health, reconciliation, and account fingerprint match the pre-cutover snapshot.

## Guarded cutover result

- Initial release: `daily-fade-mfe-50-75-v1-20260830T103820Z`, guarded cutover completed at `2026-08-30T10:40:23Z`.
- Active final release: `daily-fade-mfe-50-75-v1-1-20260830T104506Z`, guarded cutover completed at `2026-08-30T10:46:40Z`.
- Follow-up hardening makes a stale/interrupted MFE path permanently observation-off for that trade; no later fresh tick can reactivate it.
- Account fingerprint matched before and after: 1 position, 0 open orders, `DOTUSDT LONG 29.5`.
- Process is online with zero PM2 restarts.
- Dashboard bundle contains the compact `Fade MFE` display.
- No recent fatal or MFE-path error was found after restart.

## Post-cutover state

- Lane remains `ARMED`; no arm/disarm setting was changed by the release.
- `fadeMfe` status is active with policy ID `daily-fade-mfe-50-75-v1` and zero retrofitted/open MFE trades.
- Pre-existing `PROMUSDT` remains `CONTINUATION / ENTRY_RECONCILING / entryFilledAt=null / fadeMfe=null`; no bracket, fill, or selection was changed.

Rollback path: run the active release's guarded Testnet cutover script with `daily-fade-mfe-50-75-v1-1-20260830T104506Z` as old and `daily-range-closed-chart-snapshot-20260830T100701Z` as new, preserving the same shared state ledger and account-fingerprint check.
