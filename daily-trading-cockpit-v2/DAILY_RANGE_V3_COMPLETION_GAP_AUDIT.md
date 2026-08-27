# Daily Range V3 completion / gap audit

Audit date: 2026-08-27 Asia/Taipei  
Pre-patch source: `559224e90f8c0d1d3a0f450eac617ff9f7b1930b`  
Completion source: `da3b6cc7c87281011e79ce0fb99c212db0cf864d`

## Scope and preservation boundary

This is a V3 completion, not a V4 redesign. The following remains unchanged:

- `AUTO_ROUTE_NY_V2`, completed-candle routing, Continuation/Fade semantics, structural stop geometry, exact 2R TP, native reduce-only sibling brackets, and no forced EOD;
- Daily C1–C6 pool, pool refresh, cap, atomic complete-batch allocation, ownership, risk cap of 25 USDT notional / 0.25 USDT planned risk, and `MAX_COST_RATIO=0.25`;
- Cross MOM36, Cross universe, Cross sizing/exits, and Cross continuation lifecycle;
- `ECONOMIC_QUALITY_BASELINE` as the only allocator with execution authority.

No trailing/breakeven/MFE exit, score threshold, symbol or side blacklist, route rule, stop width, TP, or cap was added.

## Pre-cutover runtime evidence

| Environment | Friction artifact | Ledger N | Exact fee rows | Legacy fee rows | Full PIT signals | Mature signals | Oversubscribed batches | Open Daily trades |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Testnet | `daily-friction-v1-20260827043500-c0475d0cce42` | 41 | 0 | 41 | 146 | 171 | 69 | 1 |
| Live | `daily-friction-v1-20260827045000-d0069844cb6f` | 26 | 0 | 26 | 158 | 199 | 30 | 0 |

The Testnet open `OPUSDT` position retains its durable quantity, entry, native stop/TP ids, route, and ownership. Live has no Daily open trade. Deployment evidence is completed in `DAILY_RANGE_V3_COMPLETION_DEPLOY_REPORT.md`.

## Requirement gap matrix

| Requirement | Completion evidence | Status | Action remaining |
| --- | --- | --- | --- |
| A. Stop-economics formula | Explicit all-in loss-path formula and independent-component tests. | DONE | Verify new artifact at cutover. |
| B. Fee/slippage accounting | Exact per-fill entry/exit fee evidence when available; legacy rows stay labelled combined. | DONE | Preserve evidence quality. |
| C. Friction model isolation | Artifact contains environment; a mismatched model is not accepted for new decisions. | DONE | Verify both lane artifacts. |
| D. Friction model versioning | Hash contains formula/version/environment/cutoff/sample provenance. | DONE | Verify IDs after cutover. |
| E. Risk-capped sizing | 25 USDT / 0.25 USDT and fail-closed exchange normalization unchanged. | DONE | Preserve. |
| F. Post-fill risk validation | Frozen actual initial risk and explicit economics-vs-risk failure attribution under existing 15% operational tolerance. | DONE | Preserve. |
| G. BBO causal snapshot | Existing causal snapshot ordering preserved. | DONE | Preserve. |
| H. BBO same-batch synchronization | Candidate event/received/snapshot age plus per-batch min/max/spread persisted. | DONE | Verify status. |
| I. Complete same-5m batching | Existing complete-batch gate preserved. | DONE | Preserve. |
| J. Atomic allocation | Existing durable reserve-before-order behavior preserved. | DONE | Preserve. |
| K. Economic allocator | Existing permutation-invariant Economic baseline preserved. | DONE | Preserve. |
| L. Alpha-shadow recording | Metadata registry and explicit shadow-only fallback added. | DONE | Seed only rejected metadata. |
| M. Historical reconstructed candle PIT | Separate 180-day Binance USD-M `RECONSTRUCTED_CANDLE_PIT` runner completed. | DONE | Retain research result. |
| N. Continuation selector research | Fixed-feature L2, chronological partitions, walk-forward, scarce-slot replay, and bootstrap completed. | DONE | Verdict `REJECTED`. |
| O. Fade selector research | Separate fixed-feature L2 under the same causal contract completed. | DONE | Verdict `REJECTED`. |
| P. Forward Full-PIT collection | Strict mature complete oversubscribed count is exposed; no old partial count can satisfy the gate. | DONE | Continue collection. |
| Q. MFE/MAE measurement | Contract aggregate-trade observer runs entry through terminal exit; reconciler no longer updates extrema. | DONE | Verify stream health. |
| R. MFE/MAE quality labels | `EXACT_STREAM`, `RECOVERED_FINE_DATA`, `APPROX_1M`, `INCOMPLETE` persist and render. | DONE | Existing positions stay observation-only. |
| S. Selector artifact lifecycle | Daily-only versioned metadata registry with fail-safe Economic fallback. | DONE | No artifact grants authority. |
| T. Selector promotion gates | Artifact persists historical/forward/Testnet/approval gates and `executionAuthority:false`. | DONE | Gates remain fail/pending. |
| U. Dashboard/status observability | Friction provenance, BBO age, Full-PIT progress, path quality, artifact gates, and ranks are exposed. | DONE | Verify API/UI post-cutover. |
| V. Cohort separation | Existing strategy/route/selector/economics cohorts preserved. | DONE | Preserve. |
| W. Existing-position freeze | Entry-time quantity, brackets, route, ids, and ownership stay durable. | DONE | Reconcile before/after. |
| X. Rollback behavior | Release-based single-process cutover preserves durable data links and prior releases. | DONE | Retain rollback path. |

## Friction finding

The reported Live arithmetic was a metric-label ambiguity, not an omitted entry-cost bug. The safe-loss model is:

```text
entryFeeP95 + exitFeeP95 + 1.25 × lossAdverseP95
```

`lossAdverseP95` is the percentile of one pointwise terminal-loss path: entry adverse execution + observed immediate loss-exit adverse execution (when present) + native stop trigger-to-fill gap. A separately reported entry-adverse p95 is diagnostic only; adding it again would double count.

## Historical selector outcome

The final run has 13,823 candidates, 13,765 complete 1m labels, 5 ambiguous labels, and 58 unresolved labels. Combined newest-holdout alpha returned -6.7407R versus Economic baseline -6.7252R, with only one economically admissible oversubscribed batch. Both Continuation and Fade are `REJECTED`.

The research artifact is `daily-range-rcpit-f84b16b3`; historical gate is `FAIL`, forward Full-PIT is `PENDING 0/20`, Testnet parity is `PENDING`, approval is `NOT_APPROVED`, and `executionAuthority=false`.

## Result

All originally PARTIAL/MISSING source and research requirements are complete. The only ongoing item is passive forward Full-PIT collection; it cannot change allocation authority automatically. Production remains `ECONOMIC_QUALITY_BASELINE`, alpha remains shadow, and Cross remains untouched.
