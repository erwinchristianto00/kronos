# Pre-deploy audit — Live

## Runtime baseline captured before patch

- Active Live release: `daily-range-closed-chart-snapshot-20260830T100701Z`.
- Active Daily source fingerprint: `3241fa2678e9f18919546d98299973bd0b55cbe059d88548d04f60ea24555037`.
- Dashboard source fingerprint: `181e73ca488769cc5b875a2e4ebf161451979e25431b64c73d110ddd37093c0a`.
- MFE/MAE authority is the live `CONTRACT_AGG_TRADE` path. Mark price and recovered OHLC are not allowed to trigger the new exit.

## Open-state preservation

At audit time, Live had no open Daily Range trade. Its Daily lane was `DISARMED` by the existing six-loss account kill switch.

This release must preserve that `DISARMED` state. It does not re-arm Live, alter any Cross position, or retrofit any prior Daily trade.

## Boundary checks

- Existing structural S/R route policy remains unchanged.
- Live Continuation `SHADOW_ONLY` authority remains unchanged.
- Cross-sectional process, source, state and dashboard files are outside this candidate release.
- Promotion occurs only after guarded Testnet smoke passes.
