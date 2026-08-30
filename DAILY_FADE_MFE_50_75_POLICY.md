# Daily 4H Range — BREAKOUT FADE MFE 50/75 V1

Policy ID: `daily-fade-mfe-50-75-v1`

## Scope

- Applies only to **new** `BREAKOUT FADE` trades created after this cutover.
- Does not change route selection, symbol universe, entry timing, sizing, structural TP, structural SL, allocator, or Continuation behavior.
- Existing trades and every Continuation trade retain `fadeMfe = null` and are never retrofitted.

## Frozen measurement

After the actual entry fill and rounded structural TP are known, the policy freezes them as `entryPrice` and `structuralTakeProfit`.

- LONG progress: `(price - entry) / (TP - entry)`
- SHORT progress: `(entry - price) / (entry - TP)`
- Price authority: causal `CONTRACT_AGG_TRADE` only, while the path is `EXACT_STREAM`.

## Ratchet

| Stage | Arm | Floor |
| --- | --- | --- |
| 1 | progress >= 50% | `max(25%, 50% * peakProgress)` |
| 2 | progress >= 75% | `max(previousFloor, 50%, 2/3 * peakProgress)` |

The floor is monotonic: `max(previousFloor, stageDerivedFloor)`. It never moves down.

## Exit and safety

When current progress is at or below the active floor, the lane writes one durable intent and uses its existing reconcile -> exact-quantity reduce-only flatten -> sibling-cancel -> exchange-flat workflow.

- Stage 1 reason: `FADE_MFE_STAGE1_GIVEBACK_EXIT`
- Stage 2 reason: `FADE_MFE_STAGE2_GIVEBACK_EXIT`
- Native structural TP/SL remain live and unchanged throughout.
- Native TP/SL wins any race; no second reduce-only exit is sent.
- Stream interruption, stale processing, or incomplete path degrades MFE to observation-off; native structural TP/SL remain the hard protection.

## Evidence and telemetry

Each new Fade persists policy state, arm timestamps, peak, ratcheted floor, health, exit intent, execution attribution, and a read-only original-bracket counterfactual. Counterfactual tracking begins only after a real MFE exit and never sends an order.
