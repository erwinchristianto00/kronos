# Deploy report — Live

Status at source-preparation time: **pending guarded Live promotion after Testnet smoke**.

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

Post-cutover details are appended only after the actual guarded deployment.
