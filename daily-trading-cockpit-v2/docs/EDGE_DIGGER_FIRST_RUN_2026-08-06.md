# Edge Digger — first run against real forward evidence (2026-08-06)

Read-only research pipeline (`apps/api/src/lib/edge-digger.ts`, `GET /api/shadow/edge-digger`).
Nothing in this document changed any strategy, config, store, or instance. 3103 was never touched.

**Verdict: all three frozen hypothesis families REJECT. Zero candidates. No experiment recommended.**

---

## 1. Where the evidence actually lives (and where it does not)

The three families were checked against the canonical forward-evidence system first. They are not in
it:

- **Canonical causal journal** (`data/causal-experience/3102/events.jsonl`, 12,434 real events):
  contains only variant-matrix lanes — `CG_VARIANT_MATRIX:CG_MFE_GIVEBACK`,
  `CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE`, `CG_LONG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE`,
  `CG_VARIANT_MATRIX:CG_WIDE_LONG_RUNNER`, `CG_LONG_VARIANT_MATRIX:BL_TREND_R15_STOP200_FULL`,
  `CG_LONG_VARIANT_MATRIX:CG_MFE_GIVEBACK`. **No hypothesis-family lane appears at all.**
- **Variant matrix** (`VARIANT_MATRIX_DEFINITIONS`): 23 pure-geometry `CG_*`/`LG_*`/`BL_*` ids, fed
  only from the scanner's fresh candidates. None of the three families are members.
- **Paper book**: `laneId` is typed `VariantMatrixVariantId`, so it carries variant-matrix ids only.

Their evidence exists **only** in lane-specific shadow "edge" stores. That is a real and reportable
integrity limitation, not a footnote — see §4.

One thing that is *not* a blocker and was verified explicitly: innovation-campaign gating (campaigns
are OFF) blocks **execution**, not **measurement**. The shadow cycles that write these stores are
gated only by their own default-on env flags, so forward measurement evidence accrues regardless.
That measurement surface is what was evaluated.

## 2. Canonical reuse

| Concern | Source | Reused how |
|---|---|---|
| Independent-episode identity | `current-guard-variant-matrix.ts` | `countIndependentEpisodes` — the same union-find accumulator `computeEffectiveN` now delegates to (commit `d200454`). Never reimplemented. |
| Gate thresholds | same | `STABLE_MIN_EFFECTIVE_N`, `STABLE_MIN_HOLDOUT_EFFECTIVE_N`, `PROMOTION_MIN_HOLDOUT_EFFECTIVE_N`, `STABLE_MIN_DISTINCT_SYMBOLS`, `PROMOTION_MIN_CALENDAR_DAYS`, `MAX_TOP_SYMBOL_SHARE`, `PF_FLOOR` — read, never redeclared. |
| Comparator | same | `>=` throughout, surfaced in the payload rather than assumed by a reader. |

Resolved live policy at run time: DEV episodes ≥ **10**, validation/OOS ≥ **5**, recent/testnet ≥
**10**, distinct symbols ≥ **3**, calendar days ≥ **5**, top-symbol PnL share ≤ **0.4**, PF ≥ **1**.

⚠ The goal anticipated "DEV >40 / validation >20 / recent >10". The **actual** canonical policy is
10/5/10 with `>=`. The pipeline reads the real constants, so the gates shown are the ones readiness
itself enforces — not the anticipated numbers. Even against these *lower* real floors, all three
families fail.

Episode width: **36h** (the reset lanes' current max-hold), declared once and reported with every
count. Partitions: **60 / 25 / 15** by episode, fixed in source before any outcome was read, split
on episode boundaries so no market look straddles a partition edge.

## 3. Results (3102 testnet, real recorded evidence)

| | F1 composite-confirmed LONG | F2 residual-momentum SHORT | F3 compression / funding-carry |
|---|---|---|---|
| Sources selected | composite-estimator, regime-composite-long | residual-momentum, hedged-residual-short-v2 | compression-expansion |
| Raw eligible rows | 38 | 417 | 4 |
| **Independent episodes** | **4** | **5** | **1** |
| Rows per episode | 9.5 | **83.4** | 4 |
| Largest episode share | 0.421 | 0.338 | 1.000 |
| distinct(netR)/n | 0.737 | 0.487 | 1.000 |
| Calendar days | 6.49 | 7.05 | 0.00 |
| Distinct symbols | 9 | 17 | 4 |
| Net expectancy | **−0.3303 R** | **−0.4207 R** | **−1.1755 R** |
| Median netR | −0.2947 | −1.1867 | −1.1761 |
| PF | 0.349 | 0.497 | **null (NO_WINS_YET)** |
| WR | 0.474 | 0.319 | 0.000 |
| Cluster bootstrap 95% | [−0.667, +0.172] | **[−0.789, −0.197]** | undefined (1 cluster) |
| DEV / VAL / RECENT episodes | 2 / 1 / 1 | 3 / 1 / 1 | 0 / 0 / 1 |
| **Decision** | **REJECT** | **REJECT** | **REJECT** |

Cost stress (total round-trip, since recorded cost is a single scalar): every family is already
negative at +0bps and degrades monotonically to +20bps. No family has a breakeven to compute.

### Rejection reasons — F1
evidence integrity (2 non-canonical sources) · net expectancy −0.3303R ≤ 0 · PF 0.349 ≤ 1 ·
bootstrap lower bound −0.667 ≤ 0 · NO_TRADE beats it · DEV episodes 2 < 10 · validation 1 < 5 ·
recent 1 < 10.

### Rejection reasons — F2
evidence integrity (2 non-canonical sources) · net expectancy −0.4207R ≤ 0 · PF 0.497 ≤ 1 ·
bootstrap lower bound −0.789 ≤ 0 · NO_TRADE beats it · DEV episodes 3 < 10 · validation 1 < 5 ·
recent 1 < 10.

F2 is the strongest negative result in the set: its 95% clustered interval lies **entirely below
zero**, so the conclusion survives the episode-clustering correction rather than depending on it.

### Rejection reasons — F3
evidence integrity (4 non-canonical sources) · net expectancy −1.1755R ≤ 0 · clustered interval
undefined at 1 episode · NO_TRADE beats it · DEV 0 < 10 · validation 0 < 5 · recent 1 < 10 ·
calendar days 0 < 5 · PF not computable.

**On the F3 either/or.** By design the funding-carry lane is the cleaner instrument (it records an
honest R-decomposition and its v2 is a pure filter on the same parent cycle). Empirically it is
unusable: `funding-carry-edge.json`, `funding-carry-crowding-v2.json` and `compression-retest-v2.json`
all hold **zero** observations. Compression-expansion was selected only because it is the sole store
with any rows — and its four rows share **one origin instant**, which is one market look, not four.

## 4. Integrity limitation (reported, not worked around)

Every source read is classified `NON_CANONICAL`. Lane-edge stores express terminal status and finite
economics, but carry **no** evidence-version pin (`openMaxHoldMs`), **no** entry-freshness flag
(`isFreshValid`), **no** causal lineage, and **no** decomposable cost. So the eligibility applied here
is a strict subset of `isFreshValidObs` — terminal-status-and-finite-economics only — and is never
presented as equivalent to readiness-grade eligibility.

Also not recorded anywhere in these stores: **max adverse excursion**. It is reported `null`, never
imputed from netR. (The variant matrix does record `minMaeR`; these lanes do not.)

## 5. Evidence still needed

Per family, the binding constraint is elapsed market time, not more rows:

- **F1**: +8 DEV episodes, +4 validation, +9 recent.
- **F2**: +7 DEV episodes, +4 validation, +9 recent.
- **F3**: +10 DEV episodes, +5 validation, +9 recent, +5.00 calendar days.
- **All three**: canonical evidence markers on this lane family (evidence-version pin,
  entry-freshness flag, causal lineage) would let readiness-grade eligibility be applied instead of
  the terminal-status-only subset available today.

At a 36h episode width, 10 DEV episodes is roughly 15 days of *distinct* market conditions. Adding
rows inside the windows already collected cannot move any of these numbers.

## 6. Recommendation

**None.** No hypothesis passed every canonical gate, so the pipeline emits no bounded-experiment
recommendation. Campaigns remain OFF and CORTEX remains OBSERVE_ONLY; this pipeline cannot change
either and did not.

The honest reading of this run is not "these three ideas are dead" — it is that **four to seven days
of evidence collapsing to 1–5 independent episodes cannot distinguish a real edge from noise in
either direction**, and all three currently sit on the wrong side of zero anyway.
