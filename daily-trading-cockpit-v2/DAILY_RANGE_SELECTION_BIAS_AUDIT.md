# Daily Range selection-bias audit

Status: **CONFIRMED_LOOP_ORDER_SELECTION_BIAS** in the pre-fix implementation.

Scope: Daily Range only. The 00:00–04:00 UTC range, two closed 5m
acceptance rule, structural stop, 2R TP, 25 USDT notional, 1x leverage,
native brackets, C1–C6 universe policy, Cross-sectional strategy, and
Continuation lifecycle are not changed by this fix.

## Evidence of the old mechanism

The defect was introduced in commit `877fc6711802bf85a651ef757a93b219c05b499e`
(`feat(testnet): add isolated daily 4h range acceptance lane`). The initial
implementation:

1. normalized the frozen day universe with `.sort()`;
2. iterated `Object.entries(day.levels)` in that lexical insertion order;
3. appended valid C2 signals to `actions` in that order; and
4. called `Promise.all(actions.map(executeFreshSignal))`.

The historical implementation is visible in that commit at
`daily-4h-range-acceptance-lane.ts:910–957` and `:1117–1122`. `Promise.all`
did not make the allocation atomic: every `executeFreshSignal` synchronously
checked the cap and called `createPendingTrade()` before its first await.
That method durably created an `ENTRY_SUBMITTING` lease, so the first symbols
mutated available capacity before later symbols were evaluated.

In short, a fixed lexical symbol order became an unstated allocator whenever
valid signals exceeded available Daily slots.

## Deterministic proof

The retained legacy replay fixture has one free slot and the same candle for
AAA, BBB, and CCC:

| Input sequence | Legacy selected symbol |
| --- | --- |
| AAA, BBB, CCC | AAA |
| CCC, BBB, AAA | CCC |
| BBB, AAA, CCC | BBB |

The regression is in
`apps/api/test/daily-4h-range-acceptance-lane.test.ts` as
`CONFIRMED_LOOP_ORDER_SELECTION_BIAS`.

The replacement allocator is pure and canonicalizes its input before any
ranking. Its tests shuffle the same candidate set 1,000 times for both
validated top-N and seeded-random modes; the resulting selected set is
identical every time.

## Live incident evidence

The Live state recorded 87 accepted signals and 12 actual Daily entries before
containment. The following same-timestamp groups demonstrate scarce-slot
selection. Times are UTC.

| Batch | Candidate count | Actual selection | Recorded non-selected result |
| --- | ---: | --- | --- |
| 09:10 | 12 | ACE SHORT | 11 `MAX_OPEN_TRADES_REACHED` |
| 09:35 | 16 | AKE SHORT, BCH SHORT | ACE had its own existing lane lease; 13 `MAX_OPEN_TRADES_REACHED` |
| 10:25 | 3 | FF SHORT | PUMP LONG and TRUMP LONG `MAX_OPEN_TRADES_REACHED` |
| 10:30 | 3 | ETHFI LONG | FARTCOIN LONG and XMR LONG `MAX_OPEN_TRADES_REACHED` |

This proves allocation authority came from the loop/cap path. It does **not**
prove that a different selector would have earned more money: counterfactual
outcomes are mixed and the sample is small. See
`DAILY_RANGE_SELECTOR_RESEARCH.md`.

## Corrected allocation contract

The implementation now has these explicit phases:

```text
all symbols evaluate C2 at T
→ persist complete SignalBatch(T)
→ preflight every candidate
→ compute free slots once under one durable allocator lock
→ canonical, order-independent allocation
→ persist every selected reservation together
→ submit selected entries
```

Implementation anchors:

| Control | Source |
| --- | --- |
| Complete-candle collection, no orders in the loop | `daily-4h-range-acceptance-lane.ts:1656` |
| Same-timestamp batch construction | `daily-4h-range-acceptance-lane.ts:1850` |
| Cross-process durable lock | `daily-4h-range-acceptance-lane.ts:676` |
| Capacity calculation, preflight, atomic reservation commit | `daily-4h-range-acceptance-lane.ts:1982` |
| No lower-rank replacement after a selected entry failure | `daily-4h-range-acceptance-lane.ts:2081` |
| Pure canonical allocator and hash tie-break | `daily-range-selector.ts:65–104` |

The allocator modes are `PAUSED`, `LOOP_ORDER_LEGACY` (replay only),
`SEEDED_RANDOM_BASELINE`, `SHADOW_SELECTOR`, and `VALIDATED_SELECTOR`.
`LOOP_ORDER_LEGACY` is rejected by runtime policy.

## Safety invariants

- The cap is computed once from open Daily trades and durable pending
  reservations. It is not recomputed per candidate.
- Testnet's neutral baseline uses the persisted three-trade cap too; it cannot
  turn a scarce-slot batch into unlimited entries.
- A filesystem lock allows one allocator authority for the shared state file.
- All selected `ENTRY_SUBMITTING` records are saved in one commit before any
  exchange order can be sent.
- A rejected selected order leaves its slot unused; a lower-ranked candidate is
  never entered later merely because a slot becomes free.
- A foreign same-symbol position/order is an explicit
  `STRATEGY_SYMBOL_CONFLICT`, not an implicit allocation result.
- Existing Daily trades retain their original ownership and native brackets.

## Validation

Targeted validation covers:

- 1,000 permutation order-invariance checks;
- complete batch collection before the first order call;
- durable allocator lock exclusion;
- one-slot and multi-slot reservation limits;
- selected-entry failure with no lower-rank promotion;
- foreign symbol conflict; and
- paused Mainnet restart with an existing owned position and both brackets
  unchanged.

No selector alpha is claimed or enabled by this change.
