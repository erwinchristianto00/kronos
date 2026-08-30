# Deploy report — Live

Status: **deployed to Live after guarded Testnet smoke (final fail-closed follow-up active)**.

## Candidate checks completed

- API build: passed.
- Web build: passed.
- Focused API tests: 66 passed.
- Tests cover long/short arithmetic, no action below 50%, 50/75 stage behavior, ratchet monotonicity, frozen target, stream degradation, safe reduce-only MFE exit, native TP/SL race, restart persistence, and Continuation exclusion.

## Required guarded validation

Before promotion, snapshot the existing account/state, verify the active PM2 release is still the audited baseline, perform the guarded Live cutover, and prove:

1. Live remains `DISARMED` with the pre-existing kill-switch reason;
2. no Daily or Cross exchange position/order is modified by restart;
3. the status endpoint exposes `fadeMfe` with zero retrofitted active trades;
4. health, reconciliation, and account fingerprint match the pre-cutover snapshot.

## Guarded promotion result

- Initial release: `daily-fade-mfe-50-75-v1-20260830T103820Z`, guarded cutover completed at `2026-08-30T10:42:33Z`.
- Active final release: `daily-fade-mfe-50-75-v1-1-20260830T104506Z`, guarded cutover completed at `2026-08-30T10:47:45Z`.
- Follow-up hardening makes a stale/interrupted MFE path permanently observation-off for that trade; no later fresh tick can reactivate it.
- Account fingerprint matched before and after: 0 positions and 0 open orders.
- Process is online with zero PM2 restarts.
- Dashboard bundle contains the compact `Fade MFE` display.
- No recent fatal or MFE-path error was found after restart.

## Post-cutover state

- Live remains `DISARMED` with the unchanged pre-existing reason: `KILL_SWITCH_PORTFOLIO: max consecutive losses hit (6 within 24h of each other)`.
- No Daily Range trade was open before or after the promotion.
- `fadeMfe` status is active with policy ID `daily-fade-mfe-50-75-v1` and zero retrofitted/open MFE trades.
- Live Continuation remains `SHADOW_ONLY`; only future executable Fade entries can create MFE state after a confirmed fill.

Rollback path: run the active release's guarded Live cutover script with `daily-fade-mfe-50-75-v1-1-20260830T104506Z` as old and `daily-range-closed-chart-snapshot-20260830T100701Z` as new, preserving the same shared state ledger, Live disarm state, and account-fingerprint check.
