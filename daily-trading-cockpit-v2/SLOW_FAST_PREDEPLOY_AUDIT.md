# SLOW_AND_FAST Pre-deploy Audit

Status: **legacy semantics confidently identified; implementation is permitted only with the invariants below.**

## Scope

This audit identifies the legacy `MOM36_FILTERED + SLOW_AND_FAST` implementation that produced the
known testnet basket. It does not evaluate profitability and does not change runtime behaviour.

## Provenance

The feature was introduced once in repository history:

| Evidence | Value |
| --- | --- |
| introducing commit | `d5243fdaf79849ee399a913eeebf77d0e7c81a0b` — `fix: align filtered momentum sides with trend` |
| legacy runtime mode | `apps/api/src/lib/cross-sectional-runtime-mode.ts` |
| legacy selection function | `sideTrendAligned()` in `apps/api/src/lib/cross-sectional-edge.ts` |
| legacy production wrapper | `buildFilteredCrossSectionalBasket()` |
| legacy release artifact | `/root/kronos-testnet-releases/mom36-side-trend-align-20260823T034343Z/...` |
| deployed legacy setting | `CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT=1` |

The artifact itself contains the same `sideTrendAligned()` predicate and the same four-bar fast-return
calculation. The historical policy fingerprint on the known basket reports source SHA
`7b454f640296b06bec2922dd0d2738eddc27eb0c`, which predates the introducing commit. Therefore that
field is a stale deployment provenance label and is **not** used as proof of semantics; the release
artifact, persisted policy fields, persisted leg features, commit history, and targeted legacy tests
are the proof.

No second, incompatible `SLOW_AND_FAST` implementation was found in repository history or the
deployed legacy artifact.

## Exact legacy semantics

The feature was a hard per-symbol, proposed-side eligibility gate for the `FILTERED` MOM36 lane:

```ts
if (alignment === "OFF") return true;
const fastReturn = finiteOrNull(candidate.fastReturn);
if (fastReturn === null) return false;
return side === "LONG"
  ? candidate.score > 0 && fastReturn > 0
  : candidate.score < 0 && fastReturn < 0;
```

Definitions in the legacy deployed configuration:

| Term | Exact definition |
| --- | --- |
| `SLOW` / `score` | `MOM36 = (close[t] - close[t-36]) / close[t-36]` |
| `FAST` / `fastReturn` | `(close[t] - close[t-4]) / close[t-4]` |
| interval | `CROSS_SECTIONAL_INTERVAL=1h` |
| slow lookback | `CROSS_SECTIONAL_MOMENTUM_BARS=36` |
| fast lookback | `CROSS_SECTIONAL_SMART_FAST_BARS=4` |
| LONG eligible | `MOM36 > 0` **and** `FAST4h > 0` |
| SHORT eligible | `MOM36 < 0` **and** `FAST4h < 0` |
| neutral | either value exactly zero: not eligible |
| missing/non-finite FAST | not eligible (fail closed) |
| missing history | candidate is absent before eligibility; no fallback |

The Binance candle boundary calls `completedCandles()` before feature computation. A candle is usable
only when `openTime + interval <= now`; the in-progress hourly candle cannot enter either MOM36 or
FAST4h. The legacy runtime fetched `MOM36 + 5` completed candles, enough for both features.

`SLOW_AND_FAST` did not rerank candidates, change breadth, change weighting, alter cluster rules, or
change exits. It removed a candidate from its proposed-side pool before the legacy rank/cluster
selection. `CAPPED_SCORE_RANK` was a legacy weighting model, not part of the alignment predicate.

## Known legacy basket replay

Persisted testnet basket:

| Field | Value |
| --- | --- |
| basket | `xb-mt6yf1ze-ltered` |
| source observation | `xsec:MOM36_FILTERED:1787558904266` |
| opened | `2026-08-24T08:08:46.209Z` |
| policy | `xsec-b66fb26c1fef4916` |
| formation mode | `PLAIN_MOM36` |
| side trend policy | `SLOW_AND_FAST` |

The persisted formation legs prove the predicate was actually applied:

| Side | Symbol | MOM36 | FAST4h |
| --- | --- | ---: | ---: |
| LONG | INJUSDT | +8.0508% | +1.5936% |
| LONG | TAOUSDT | +3.3069% | +0.4717% |
| LONG | NEARUSDT | +3.1844% | +1.6186% |
| SHORT | SEIUSDT | -2.1451% | -0.5131% |
| SHORT | SUIUSDT | -2.0406% | -0.5120% |
| SHORT | ARBUSDT | -0.6006% | -0.1006% |

All six signs meet the exact predicate. This verifies the known `MOM36_FILTERED + SLOW_AND_FAST`
basket against its persisted feature values, not merely its label.

## Required V4 port boundary

The current Dynamic MOM36 path is architecturally different from the old `FILTERED` wrapper. Only the
pure eligibility semantics above may be reused. The new integration must execute in this order:

1. admission;
2. raw MOM36 breadth to determine base allocation;
3. pinned V4 continuation overlay, limited to one rung;
4. final required LONG/SHORT count;
5. unchanged MOM36 rank order;
6. per-leg SLOW_AND_FAST eligibility;
7. exact-six final selection, or explicit no-entry.

It must not invoke the legacy `buildFilteredCrossSectionalBasket()` wrapper, its CAPPED_SCORE_RANK
weighting, old allowlists, old score-gap gate, or any old exit policy.

## Safety decision

`SLOW_AND_FAST LEGACY SEMANTICS AMBIGUOUS` is **not** the deployment blocker: the semantics are
unambiguous. Deployment remains gated on implementation-specific unit/integration tests, current
runtime preflight, state preservation, testnet validation, live validation, and the full invariant
list in the implementation report.

## V4 port mechanics (audited before deployment)

The port is a pure strict-sign predicate in
`apps/api/src/lib/dynamic-mom36-slowfast.ts`; it has no reference to
`CROSS_SECTIONAL_FILTERED_SIDE_TREND_ALIGNMENT`. The current Dynamic selector calls it only for
`dynamic-mom36-cont-slowfast-sl2-mfe30-36h-v4`, after the breadth allocation and the pinned V4
continuation overlay are frozen.

For an ordered side walk, the deterministic order is:

1. unchanged MOM36 sort (long high-to-low, short low-to-high; symbol tie-break);
2. existing opposite-side ownership and current execution guards;
3. existing quota and cluster check;
4. strict SLOW_AND_FAST eligibility;
5. select, or continue down the same MOM36 order.

An unaligned candidate consumes neither a slot nor cluster capacity. The snapshot records both the
raw V3 result after the final allocation and the v4 filtered result, including every candidate,
source close timestamp, current guard reason, alignment result, and skip reason. Missing/non-finite
feature data, a timestamp after the decision cutoff, or a source close older than the Dynamic
formation's synchronous fully-closed bar is `SLOW_FAST_DATA_MISSING`, never aligned. In production
the slow/fast source close must equal the decision cutoff; the 36h/4h start closes must merely be
closed no later than it.

The Dynamic implementation locks FAST to four 1h bars by code. It does **not** read the old
`CROSS_SECTIONAL_SMART_FAST_BARS` value, because that old setting belongs to Smart Formation and
must not be permitted to redefine recovered legacy semantics.

### Inherent V4 conflict consequence

There is one important, expected fail-closed consequence of combining exact breadth with strict
sign alignment. A `5L1S` breadth state means exactly one negative MOM36 symbol. If V4 returns
`CONFLICT_LONG`, its bounded allocation is `4L2S`, but strict SLOW_AND_FAST can supply at most one
SHORT because every valid SHORT must also have `MOM36 < 0`. The selector must therefore return
`INSUFFICIENT_SLOW_FAST_ALIGNED_LEGS` and open nothing; using a positive-MOM36 symbol as the second
short would violate the recovered legacy predicate. The bearish mirror (`1L5S` plus
`CONFLICT_SHORT -> 2L4S`) behaves identically. This is covered by a targeted test and is not tuned
away.
