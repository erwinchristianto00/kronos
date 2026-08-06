# Live Edge Digger — why the candidates read negative

**Forensic, read-only. No tuning, no mutation, no deploy.**

| | |
|---|---|
| Analysed SHA | `6142032ec63345f4556145c5955b3ee24584ae42` (3101, `dtc-api`) |
| Store snapshot sha256 | `6ae35f275f6a1c7a0181213e09357fd637a228c6e926e1d5d7b8beb27ec45369` (1,622,270 bytes) |
| Evidence window | `2026-08-05T18:01:22.984Z` → `2026-08-06T03:33:52.935Z` (**9.54 hours**) |
| Observations | 1,221 — **42 resolved, 1,179 open** |
| Cycles / candidates / symbols | 82 / 10 emitting (16 registered) / 17 |
| Diagnostic script | `apps/api/scripts/live-edge-digger-forensics.ts` |

---

## Conclusion first

The negative numbers are **not a measurement of the hypotheses**. They are an artifact of reading a
9.5-hour-old store in which only the fastest-losing 3.4% of positions have resolved.

Three facts settle it:

1. **Every one of the 42 resolved rows is a STOP.** Zero targets, zero timeouts, zero ambiguous
   bars. Gross expectancy is exactly **−1.0000R**, which is not a finding — it is an identity, since
   a stop exit prices at `stopPrice` and therefore returns exactly −1R by construction.
2. **Those 42 rows are 1 canonical independent episode.** They collapse to 5 distinct
   (symbol, entryPrice) pairs, 3 distinct exit instants and 5 distinct netR values. The sample size
   is not 42.
3. **Three all-losing events is an ordinary draw under a zero-edge null** (p = 0.254). Nothing here
   falsifies any hypothesis, and nothing here supports one.

The engine already knows this: **no candidate is marked REJECTED.** All 16 sit in `COLLECTING`,
`OPEN` or `DORMANT` with zero rejection reasons. The displayed −1.03R is a statistic on evidence the
engine itself declines to judge.

---

## A. Overlapping entries — **PROVEN, and the dominant multiplier**

| metric | value |
|---|---|
| candidate+symbol groups | 36 |
| rows opened while a prior row was still live | **1,169 / 1,221 (95.7%)** |
| max concurrent depth | **80** |
| resolved rows → distinct (symbol, entryPrice) | 42 → **5** |
| resolved rows → distinct exit instants | 42 → **3** |
| resolved rows → distinct netR values | 42 → **5** |

### Mechanism (proven from source, not inferred)

`emitShadowSignals` (`live-edge-digger.ts:177`) is a pure function of the current market snapshot.
It has **no open-position check** — nothing anywhere prevents re-entry while a position is live.
Entry price is `s.close`, the last **closed** 1h candle, which is constant for a whole hour, while
the shadow cycle runs every ~7 minutes. `observationId` is `candidateId|symbol|asOfMs`, so each
cycle mints a distinct id for what is the *same* signal at the *same* price.

Result: one signal becomes 7–10 identical rows per hour. Worst groups:

```
RESIDUAL_REVERSION_LONG_DISPERSED|BANKUSDT    rows= 82  overlapping= 80  distinctEntries= 8  maxDepth=80
RESIDUAL_REVERSION_SHORT_DISPERSED|HEIUSDT    rows= 82  overlapping= 80  distinctEntries=10  maxDepth=80
RESIDUAL_REVERSION_LONG_DISPERSED|COTIUSDT    rows= 79  overlapping= 78  distinctEntries= 9  maxDepth=78
HIGH_VOL_LAGGARD_SHORT|COTIUSDT               rows= 79  overlapping= 78  distinctEntries= 9  maxDepth=78
```

Representative duplicate group — 9 rows, one entry price, one exit instant:

```
HOMEUSDT LONG  entry=0.00991  stop=0.00889714  stopBps=1022.1
  opened 18:01:22 .. 18:55:49 (9 rows)   all resolved 2026-08-05T20:00:00.000Z
  holdHours 1.98, 1.86, 1.74, 1.63, 1.51, 1.39, 1.27, 1.18, 1.07   grossR = -1.0000 each
```
Observation IDs share the pattern
`RESIDUAL_REVERSION_LONG_DISPERSED@v1-<hash>|HOMEUSDT|<asOfMs>`, one per cycle.

### Read-only counterfactuals

| counterfactual | resolved rows | expectancy |
|---|---|---|
| canonical (as stored) | 42 | −1.0434R |
| **1) one live row per candidate+symbol** | **3** | −1.03R (unchanged) |
| **2) one entry per candidate per 36h episode** | **0** | not computable — the single kept row is still OPEN |

The expectancy is **unchanged** because the duplicates are exact copies. That is precisely the
finding: overlap inflates *n* by ~14×, not the mean. Every standard error and confidence interval
computed on the raw row count is overstated by roughly √14 ≈ 3.7×.

Evidence was never rewritten; counterfactuals are computed on a copy.

---

## B. Shared-event dependence — **PROVEN**

| metric | value |
|---|---|
| raw resolved rows | 42 |
| **canonical independent episodes** | **1** |
| distinct exit instants | 3 |
| largest shared-exit cluster | **18 rows (42.9%)** |
| raw-row expectancy | −1.0434R |
| episode-weighted expectancy | −1.0422R |

Losses land together across candidates — the signature of one market move, not independent failures:

```
2026-08-05T20:00:00.000Z  rows=18  candidates=2  symbols=HOMEUSDT,BICOUSDT  meanNetR=-1.0282
2026-08-06T02:00:00.000Z  rows=16  candidates=2  symbols=ENAUSDT,HOMEUSDT   meanNetR=-1.0660
2026-08-05T22:00:00.000Z  rows= 8  candidates=1  symbols=HOMEUSDT           meanNetR=-1.0324
```

Raw and episode-weighted expectancy agree (−1.0434 vs −1.0422) only because every row is a full
stop-out. The agreement is not reassurance — with one episode there is nothing to average over.

---

## C. Cost drag — **REAL BUT MINOR; FALSIFIED as a cause**

| component | R |
|---|---|
| gross expectancy | **−1.0000** |
| fee (taker round-trip, 22bps) | −0.0281 |
| stop slippage (12bps, stop exits only) | −0.0153 |
| funding (1.5bps/8h) | **+0.0000** — no row held ≥ 8h |
| **net expectancy** | **−1.0434** |
| **cost share of the loss** | **4.16%** |

**Classification: GROSS NEGATIVE BEFORE COST — cost is not the cause.**

Cost reconstruction was reconciled against the stored `costR` for all 42 rows: **0 mismatches, max
error 0.00e+0**. The decomposition is exact, not estimated.

Caveat that matters: gross −1.0000R carries **zero information** about hypothesis quality. It is the
arithmetic identity of an all-stops subset. Cost drag will only become measurable against a mixed
outcome set.

Per-candidate classification: all five emitting candidates are `GROSS NEGATIVE BEFORE COST`; the
other five are `INSUFFICIENT EVIDENCE` (0 resolved).

---

## D. Exit effects — **stop-first resolution FALSIFIED as a cause**

| exitReason | n | meanNetR | meanGrossR | sumNetR | median holdH |
|---|---|---|---|---|---|
| TARGET | **0** | n/a | n/a | 0.00 | n/a |
| STOP | **42** | −1.0434 | −1.0000 | −43.82 | 1.81 |
| AMBIGUOUS_STOP_FIRST | **0** | n/a | n/a | 0.00 | n/a |
| MAX_HOLD_MTM | **0** | n/a | n/a | 0.00 | n/a |

- **Ambiguous intrabar resolution explains exactly 0.0000R.** There are no ambiguous rows, so the
  best-case and worst-case intrabar bounds are *identical* to the canonical result. The conservative
  stop-first rule has not cost a single R in this window.
- **Timeout decay is structurally impossible here.** 0 of 1,179 open rows have had their 24h/36h
  horizon elapse in a 9.54h window. `resolveShadowObservation` correctly keeps a row OPEN until the
  horizon is fully covered by data (`live-edge-digger.ts:306`), so `MAX_HOLD_MTM` cannot yet occur.
- Time-to-exit is fast: median 1.81h, range 1.00–4.74h.

Losses are **immediate adverse moves**, not ambiguity and not decay.

---

## E. Rule / market mismatch — losses are broad, evidence is narrow

| split | breakdown |
|---|---|
| direction | LONG n=24 (−1.0541) · SHORT n=18 (−1.0291) |
| symbol | HOMEUSDT n=26 (−1.0336) · BICOUSDT n=9 (−1.0231) · ENAUSDT n=7 (−1.1057) |
| regime | **MIXED n=42** — single regime, no contrast available |
| origin | seed n=35 (−1.0309) · generated n=7 (−1.1057) |
| day | 2026-08-05 n=33 · 2026-08-06 n=9 |

Every split has **1 independent episode**. No split is interpretable; they are reported for
completeness, not inference.

Emission is heavily concentrated in low-liquidity alts — 3 of 17 symbols carry 55.9% of all rows:

```
BANKUSDT 231 (18.9%)   COTIUSDT 230 (18.8%)   HOMEUSDT 222 (18.2%)
HEIUSDT   97 ( 7.9%)   BICOUSDT  96 ( 7.9%)   ENAUSDT   60 ( 4.9%)
```

Stop widths are very large in percentage terms (median 10.22%, max 14.72%), so targets sit
6.43–22.08% away. Both losses and (eventual) wins require large moves.

---

## F. Integrity — **CLEAN**

| check | result |
|---|---|
| duplicate `observationId` | **0** |
| R-math violations (gross & net) | **0** |
| wrong-sign `costR` | **0** |
| cost reconstruction mismatches | **0** (max err 0.00e+0) |
| malformed / stale outcomes | **0** |
| rows using a not-yet-closed candle | **0** |
| freeze anchors present | **16 / 16** |
| rows opened before their freeze anchor | **0** |
| **young evidence wrongly marked REJECTED** | **0 — no candidate is REJECTED** |
| deployed tree vs `RELEASE_SHA` | **868/868 files byte-identical to `6142032`** |

Lifecycle states are correct: 5 `COLLECTING`, 5 `OPEN`, 6 `DORMANT`, 0 rejected. The
`MIN_EPISODES_TO_JUDGE = 5` guard (`live-edge-digger.ts:779`) is working — economic rejection cannot
fire at 1 episode, so no rule is being discarded for early bad luck.

---

## Per-candidate table

`raw/open/res` = rows · `eps` = canonical independent episodes · `ovlp` = rows opened while another
was live · `dEnt` = distinct entry prices · `cf1` = one-live-row counterfactual (resolved:expectancy)
· `cf2` = one-entry-per-episode (resolved/kept)

```
candidate                            raw  open  res  eps  ovlp  dEnt   rawExp   epsExp    cf1n:R  cf2r/all   WR            PF
RESIDUAL_REVERSION_LONG_DISPERSED    246   237    9    1   237    28   -1.033   -1.033   1:-1.03       0/1    0%  NO_WINS_YET
HIGH_VOL_LAGGARD_SHORT               237   228    9    1   229    27   -1.035   -1.035     0:n/a       0/1    0%  NO_WINS_YET
CROWDED_FUNDING_LONG                 217   209    8    1   212    26   -1.032   -1.032   1:-1.03       0/1    0%  NO_WINS_YET
GEN_COMPRESSION_EXPANSION_LONG       199   192    7    1   189    27   -1.106   -1.106     0:n/a       0/1    0%  NO_WINS_YET
RESIDUAL_REVERSION_SHORT_DISPERSED   191   182    9    1   185    25   -1.023   -1.023   1:-1.02       0/1    0%  NO_WINS_YET
GEN_BREADTH_EXTREME_RS_LONG           51    51    0    0    47     9      n/a      n/a     0:n/a       0/1  n/a      NO_DATA
CROWDED_FUNDING_SHORT                 27    27    0    0    26     4      n/a      n/a     0:n/a       0/1  n/a      NO_DATA
LOW_VOL_RELATIVE_STRENGTH_LONG        27    27    0    0    26     4      n/a      n/a     0:n/a       0/1  n/a      NO_DATA
GEN_CROWDED_FUNDING_FADE_LONG         20    20    0    0    15     6      n/a      n/a     0:n/a       0/1  n/a      NO_DATA
GEN_BREADTH_EXTREME_RS_SHORT           6     6    0    0     3     3      n/a      n/a     0:n/a       0/1  n/a      NO_DATA
```

Six further rules are `DORMANT` — evaluated every cycle, never matched: `RESIDUAL_MOMENTUM_SHORT_COHESIVE_BEAR`,
`RESIDUAL_MOMENTUM_LONG_COHESIVE_BULL`, `COMPRESSION_BREAK_LONG`, `COMPRESSION_BREAK_SHORT`,
`SHOCK_REVERSION_LONG`, `SHOCK_REVERSION_SHORT`.

**Confidence intervals: not computable for any candidate.** Every one has 1 cluster, and
`clusterBootstrap` refuses an interval below 2 — reporting `null` rather than an interval computed as
if the rows were independent.

---

## Ranked attribution

### 1. Proven primary causes

1. **Outcome censoring — the resolved subset is the fast-losing tail, by construction.**
   Only 42/1,221 (3.4%) rows have resolved. A stop sits 1.0R away; targets sit 1.5–2.0R away. The
   nearer barrier is hit first, so in a young store the resolved set is systematically the losers,
   while every position that is quietly winning remains OPEN and contributes nothing. Under a
   driftless-walk null, P(stop before target) = **63.3%** per event at the observed R-multiples.
   With 3 independent events, **P(all stops | zero edge) = 25.4%** — an entirely ordinary draw.
   *The −1.0434R is a censoring artifact and carries no information about edge.*

2. **Duplicate overlapping entries — 14× sample inflation.**
   95.7% of all rows were opened while a prior row of the same candidate+symbol was live, max depth
   80. 42 resolved rows are 5 entry prices, 3 exit instants, 1 canonical episode. Any statistic read
   off the raw row count overstates precision by ~3.7×. Root cause in source: emission has no
   open-position check, and entry price is the last *closed* 1h candle — constant for an hour while
   cycles run every ~7 minutes.

### 2. Proven secondary causes

3. **Cost drag — real, small, not causal.** −0.0434R total (fee −0.0281, slippage −0.0153, funding
   0.0000) = **4.16%** of the loss. Gross was already −1.0000R.

4. **Symbol concentration.** 3 of 17 symbols carry 55.9% of emissions and 100% of resolved rows, all
   low-liquidity alts with 10%+ stop widths.

### 3. Falsified suspicions

- **Conservative stop-first resolution — FALSIFIED.** Zero `AMBIGUOUS_STOP_FIRST` rows. Best- and
  worst-case intrabar bounds are identical. Cost of the conservative rule so far: **exactly 0.0000R**.
- **Cost drag as the primary cause — FALSIFIED.** 4.16% of the loss.
- **Timeout decay — FALSIFIED (structurally impossible).** Zero `MAX_HOLD_MTM`; 0/1,179 open rows
  have had their horizon elapse.
- **"Genuinely bad hypotheses" — NOT SUPPORTED.** At 1 episode and p = 0.254 the data cannot
  distinguish a bad hypothesis from an unlucky one. No rule has been falsified.
- **"Young evidence is being rejected" — FALSIFIED.** 0 candidates REJECTED; the
  `MIN_EPISODES_TO_JUDGE` guard is working.

### 4. Unresolved

- **Whether any hypothesis has edge.** Needs ≥5 independent episodes; there is 1.
- **Earliest checkpoint at which any unbiased read is possible:** the first cohort's horizons must
  fully elapse. First row opened `2026-08-05T18:01:22Z`; the widest horizon is 36h, so the earliest
  moment a `MAX_HOLD_MTM` or an unbiased target/stop mix can exist is **≈ 2026-08-07T06:00Z**.
  A 5-episode population at a 36h episode block requires **≈ 7.5 days** of continuous scanning from
  first emission — i.e. **≈ 2026-08-13** — assuming rules keep firing at the current rate.
- **True cost drag** cannot be measured until a mixed (non-all-stop) outcome set exists.

---

## Confirmation of scope

No runtime, data, config or code-path change was made. No deploy, no restart, no pm2 action, no
process signalled. The shadow store was **read only**: it was copied, the source hash after the copy
matched the hash before, and the local copy was `chmod 444` before analysis. Its mtime/size continue
to advance solely because the scanner keeps running on its own schedule.

Full disclosure of writes: two scratch files were created on the VPS to carry the snapshot and a
path manifest (`/root/led-forensic-snapshot.json`, `/root/fpaths.txt`); **both have been removed**.
No store, `.env`, release directory or pm2 entry was modified.

**3102 and 3103 were never contacted.** Verified after analysis: `dtc-api-live` restarts **8378**
(unchanged), `dtc-api-testnet` restarts **0** (unchanged), `dtc-api` restarts **0** (unchanged).

The only files added are the read-only diagnostic script and this report; `apps/api` typechecks
clean.
