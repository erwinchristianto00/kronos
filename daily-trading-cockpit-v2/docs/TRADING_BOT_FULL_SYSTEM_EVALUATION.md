# Trading Bot — Full System Evaluation (Brutally Honest)

**Generated:** 2026-05-13
**Repo:** `daily-trading-cockpit-v2`
**Scope:** Read-only audit. No trading logic, scoring, routing, execution, threshold, UI
behavior, or live readiness was changed. Companion file:
`docs/TRADING_BOT_PERFORMANCE_SNAPSHOT.md` (timestamped raw metrics).

---

## 1. Executive Verdict

**Identity.** A shadow-only crypto futures strategy lab built around three layers:
(a) a heuristic scanner that nominates candidates from 20 USDT-perp symbols,
(b) a deterministic profit router that downgrades anything not supported by realized
shadow evidence, and (c) a growing stack of read-only analytics that try to expose
what the strategy is actually doing vs. what the planner *thinks* it is doing.

**Verdict label:** **IMPROVING but NOT READY.**

- The router and audits **work**. They correctly quarantine destructive cohorts
  (RESEARCH_ONLY = netAvgR -2.46R, slRate 90% over 230 closes — confirms the
  router is identifying real garbage, not pruning real edge).
- The realized P&L of the leading cohort is **still firmly negative**:
  `vwap_retest_entry + tp1_full_exit`, POST_CALIBRATION era, 42 closed,
  netAvgR -0.7089R, profitFactor 0.1473, win rate 35.71%. That cohort is the
  **best thing on the field** and it loses money.
- Calibration cut the overconfidence error by **67.68%** — that is a genuine,
  measurable improvement of the planner's self-knowledge.
- The locked live-readiness route (`fib_500 + tp1_full`) has **zero closed
  primary trades** and is in MISMATCH with the maturity leader (`vwap_retest`).

**Single biggest current bottleneck:** the bot is auditing itself well but the
underlying strategy still loses gross R (-0.24R) even *before* costs. Until a
route is found whose gross R is reliably positive, every other improvement is
cosmetic.

**Single biggest encouraging signal:** the calibration error fell from +1.77R
overestimate to -0.57R underestimate — the planner is no longer fooling itself.
Combined with the stop-geometry audit identifying ULTRA_TIGHT (<100 bps) as a
near-deterministic loser (-2.14R, 72.7% SL) and the new guard demoting those
candidates, the bot can now *see* its own weakness.

**Worth continuing? YES, conditionally.** See §22.

**Anywhere near live?** **No, not by a wide margin.** 3/10 hard gates pass; the
three that pass are infrastructure gates (Kronos health, data coverage, max
losing streak). All seven P&L-related gates fail.

---

## 2. System Architecture Overview

```
                        ┌────────────────────────────────────────┐
                        │  EXTERNAL MARKET DATA                   │
                        │  Binance REST  •  Kronos sidecar        │
                        │  Whale flow    •  Fear & Greed          │
                        └────────────────────┬────────────────────┘
                                             │
                                             ▼
                              ┌─────────────────────────────┐
                              │  apps/api  (Fastify, :3101) │
                              │  scan-service.ts            │
                              │      ↓                      │
                              │  buildVariantSelection()    │  packages/shared/src/execution-plan.ts
                              │      ↓                      │
                              │  computeProfitRoute()       │  packages/shared/src/profit-routing.ts
                              │      ↓                      │
                              │  shadow-engine.ts (fills,   │
                              │      SL/TP, close-reason)   │
                              │      ↓                      │
                              │  outcome-checker.ts (sync   │
                              │      candle-based outcomes) │
                              │      ↓                      │
                              │  decision-ledger.ts (JSONL) │
                              │      ↓                      │
                              │  Audit endpoints (16x)      │
                              └────────────────┬────────────┘
                                               │
                                               ▼
                              ┌─────────────────────────────┐
                              │  apps/web  (Vite + React)   │
                              │  App.tsx Performance page   │
                              │   – ~14 analytics panels    │
                              └─────────────────────────────┘

       SIDECAR                                 DATA FILES
   services/kronos                       data/shadow-positions.json
   FastAPI (:8001)                       data/shadow-execution-log.json
   PyTorch + NeoQuasar/Kronos-small      data/scan-history.jsonl
                                         data/decision-log.jsonl (when enabled)
                                         data/performance-migration-audit.json
```

**Main data flow:**

1. `GET /api/scan` → `ScanService.scan()` fetches 5m/15m/1h candles + ticker for
   every symbol in `UNIVERSE` (20 USDT-perp pairs), parallel with
   `KronosClient.predict()` for 1h, `WhaleClient.getFlow()`, `getSocialSentiment()`.
2. For each symbol, `buildCandidate()` (shared/src/scan.ts) produces a per-side
   scoring envelope (`longScore`, `shortScore`, `opportunityScore`, `dangerScore`,
   `confidence`).
3. `chooseDirection(long, short)` picks LONG/SHORT or rejects as NEUTRAL.
4. `buildVariantSelection()` (shared/src/execution-plan.ts) picks an
   `entryVariant + exitVariant`, computes expected gross/net R via shadow
   replay stats + heuristic geometry.
5. `computeProfitRoute()` (shared/src/profit-routing.ts) assigns
   `PROFIT_CANDIDATE | DATA_COLLECTION | RESEARCH_ONLY`.
6. `ShadowExecutionEngine.processScan()` opens pending entries, waits for the
   conservative pending-limit fill, then evaluates SL/TP starting on the **next**
   candle.
7. Closed positions feed the audits, which are re-computed per-request from
   `shadow-positions.json` + `tracker.readAllRaw()`.
8. UI fetches `/api/scan`, `/api/shadow`, `/api/shadow/*` endpoints on demand.

**Persistence:**

- `data/shadow-positions.json` — canonical state of every shadow position
  (lifecycle, fills, fee/slippage, route mode, calibration evidence).
- `data/shadow-execution-log.json` — append-only audit ledger of close events
  used to rebuild aggregate performance.
- `data/scan-history.jsonl` + `scan-history-raw.jsonl` — every scan response.
- `data/decision-log.jsonl` — Decision Ledger (when `DECISION_LEDGER_DISABLED != "1"`).

**Scheduled scan assumptions:** the API exposes `GET /api/scan`; the cockpit UI
calls it on a timer. There is no in-process cron — the scan cadence is whatever
the UI (or external tooling) requests. `tracker.persistScan()` saves each scan
response.

---

## 3. Data Sources and Inputs

### 3.1 Binance (mandatory)

- **Fetched by:** `apps/api/src/lib/binance.ts` → `getCandles`, `getTicker24h`,
  `getBookTicker`.
- **Used in:** `scan-service.ts` for 5m/15m/1h candles (150 bars each), ticker,
  best bid/ask (spread).
- **Hard-gating?** Yes — symbols that fail `BinanceRequestError` are skipped
  (`scan-service.ts`).
- **Degrade behavior:** symbol counted in `skippedSymbols`; everything else proceeds.

### 3.2 Kronos forecasting (advisory)

- **Sidecar:** `services/kronos/app/main.py` → PyTorch model `NeoQuasar/Kronos-small`.
- **Client:** `apps/api/src/lib/kronos.ts` → `HttpKronosClient`.
- **Fields extracted:** `kronosBias`, `kronosBias1h`, `kronosBias4h`,
  `selectedKronosBias`, `kronosConfidence`, `kronosLongProbability/ShortProbability`,
  `horizonConflict`, `expectedReturn1h/4h`, `kronosRisk`, `forecastMedianClose`.
- **How it influences scoring:** see `shared/src/scan.ts` lines 405+ — Kronos
  agreement adds to `longScore`/`shortScore`; horizon conflict surfaces as a
  scoring/routing concern (and routing reason code `KRONOS_HORIZON_CONFLICT` in
  `profit-routing.ts`).
- **Hard gates?** No. Kronos is advisory and annotative. The router does **not**
  upgrade route mode on Kronos agreement alone (test
  `profit-routing.test.ts:111`: "Whale/Kronos agreement alone cannot upgrade
  routeMode when net R is negative").
- **Health gate:** Live Readiness has a `KRONOS_HEALTHY` gate (`live-readiness.ts:347`).
- **Degraded behavior:** scanner runs without it; route reasons include
  `KRONOS_AGREES`/`KRONOS_DISAGREES` only when available.
- **Recent fix (this session):** The PyTorch `RotaryPositionalEmbedding` had a
  non-thread-safe `seq_len_cached` that corrupted under concurrent predictions,
  causing "0/20 forecasts succeeded" outage. Patched (see
  `services/kronos/app/main.py` rotary monkey-patch + threading.Lock, plus
  `KRONOS_CONCURRENCY = 1` in `apps/api/src/lib/kronos.ts`). Health restored to
  20/20 succeeded.

### 3.3 Whale flow (soft-confirming)

- **Fetched by:** `apps/api/src/lib/whale.ts`.
- **Used in:** scoring (`shared/src/scan.ts`) — whale agreement nudges
  long/short scores; surfaces as `WHALE_AGREES`/`WHALE_DISAGREES` in routing reasons.
- **Hard gating?** No — same advisory rules as Kronos. Whale alone cannot
  promote a negative-net-R route. Whale conflict surfaces as
  `whale_conflict_exit` candidate exit (advisory).
- **Degrade behavior:** `whale.available = false` flag; routing simply omits
  the WHALE_* reason codes.

### 3.4 Social sentiment / Fear & Greed (advisory only)

- **Fetched by:** `apps/api/src/lib/social.ts`. Provider configured by
  `SOCIAL_SENTIMENT_PROVIDER` env (`feargreed`, `reddit`, or none).
- **Effect on decisions:** *not confirmed* — surfaces in scan output (`socialSentiment`)
  but no direct routing/scoring rule references it that I could verify from the
  code I inspected.

### 3.5 Local replay/performance datasets (the actual edge memory)

- `data/shadow-positions.json` — every shadow position with full variant breakdown.
- `tracker.readAllRaw()` (`apps/api/src/lib/tracker.ts`) — scan history index.
- These power **replay-backed selection** inside `chooseEntryVariant` and
  `chooseExitVariant`, the calibration evidence in
  `buildCalibrationEvidenceFromPositions`, and every audit panel.
- Hard-gating: yes when **replay-negative**. `computeProfitRoute()` blocks
  promotion when `allReplayCombosForVariant` is all-negative (reason code
  `ALL_REPLAY_VARIANTS_NEGATIVE`).

---

## 4. Market Regime Logic

- **Classifier:** `deriveMarketRegime(candidates)` in
  `apps/api/src/lib/scan-service.ts` (line 70+).
- **Inputs:** ratio of `finalDirection === "LONG"` vs `"SHORT"` in the candidate
  pool that survived scanning.
- **Labels in use:**
  - `"No usable market regime"` (everything skipped),
  - `"Bullish expansion"` (longs dominate),
  - `"Bearish pressure"` (shorts dominate),
  - implicit "neutral" fallback (not confirmed from repo; verify before relying).
- **Where it affects behavior:** scan-service.ts line 363–373. Candidates whose
  direction conflicts with the regime get a `reason` annotation (`"Caution:
  Bullish expansion conflicts with this short setup"`) but **are still surfaced** —
  it's a display caveat, not a hard filter. No routing demotion is triggered by
  regime alone.
- **Verdict:** regime is **display/analytics, not behavioral**. Long/short
  preference is *not* regime-sensitive at the routing layer.

---

## 5. Symbol Universe and Scanner Flow

- **Universe:** `UNIVERSE` in `scan-service.ts` — 20 USDT-perp symbols
  (BTC, ETH, BNB, SOL, XRP, ADA, AVAX, DOGE, LINK, NEAR, OP, ARB, APT, SUI,
  WLD, SEI, FET, INJ, TIA, PENDLE — confirm in code if exact membership matters).
  Coverage in current snapshot: `totalSymbols=20, scannedSymbols=20`.
- **Fetch concurrency:** `SYMBOL_FETCH_CONCURRENCY` controls parallelism.
  Per-symbol pulls 5m/15m/1h candles (150 each), ticker24h, bookTicker, and
  Kronos prediction.
- **Skip rules:** any `BinanceRequestError`, missing candles (`NOT_ENOUGH_CANDLES`),
  or schema failure → symbol enters `skippedSymbols`.
- **Duplicate suppression:** `tracker.ts` dedupes by signal fingerprint
  (symbol + direction + entry zone + plan). `scan-history-pre-dedupe-archive.jsonl`
  is the pre-dedupe raw stream. Top-10 list is unique signals only.
- **Status pipeline** (from `shared/src/scan.ts` line 292+):

| Status     | Threshold | Display/behavior |
|------------|-----------|------------------|
| TRADE_NOW  | opportunityScore ≥ 75 AND confidence ≥ 70 AND dangerScore ≤ 50 (verify the AND-chain at line 292) | "Trade now" tag in UI; treated as top-of-rank candidate. Does **not** auto-execute. |
| READY      | opportunityScore ≥ 68 AND confidence ≥ 62 AND dangerScore ≤ 55 | "Ready" tag; second tier. |
| WAIT       | opportunityScore ≥ 60 AND dangerScore ≤ 65 | "Wait for trigger". |
| WATCH      | opportunityScore ≥ 50 AND dangerScore ≤ 70 | Surface but low priority. |
| else       | — | Hidden / not surfaced. |

**Critical:** these statuses are **scanner display tags**, not shadow-execution
gates. Shadow execution opens pending entries for *every* surfaced candidate that
the router does not put in a hard block; the status influences ranking and UI
priority only.

---

## 6. Opportunity / Danger / Confidence Scoring

All formulas live in `packages/shared/src/scan.ts`. The scores are **heuristic**,
not replay-backed.

- **opportunityScore** — composite of long/shortScore, edgeStrength, kronosScore,
  volumeScore, trendScore, volatilityScore, liquidityScore.
- **dangerScore** — composite of volatility, spread, chase-risk, drawdown
  expected, kronos risk, low-data-quality penalty.
- **confidence** — internal multi-source agreement metric.
- **kronosScore** — derived from `kronosConfidence` + bias agreement.

**Ranking:** `scan-service.ts:350` — sort by `opportunityScore` desc, tiebreak
on `confidence`. The top 10 surfaced after dedup is **what the UI shows**.

**Effect on routing:** these scores do **not directly drive** route mode.
`computeProfitRoute()` consumes `expectedNetR`, `expectedGrossR`,
`variantConfidenceTier`, symbol/side/variant stats, cost, and Kronos/whale
flags — *not* the scanner scores. The scanner scores are essentially a
candidate-discovery layer; the router treats every surfaced candidate equally
and decides on shadow evidence + cost geometry.

**Implication.** "TRADE_NOW" and "high opportunity" in the UI is not a claim
that the bot would actually take that trade; it's a claim that *this symbol
looks heuristically promising right now*. The router then frequently
overrides to DATA_COLLECTION or RESEARCH_ONLY.

---

## 7. Direction Selection

`chooseDirection(longScore, shortScore)` in `shared/src/scan.ts:202`:

```ts
if (Math.abs(longScore - shortScore) < 8 || Math.max(longScore, shortScore) < 52) {
  return "NEUTRAL";
}
return longScore > shortScore ? "LONG" : "SHORT";
```

- **Neutralization band:** |Δ| < 8 OR max < 52 → NEUTRAL (filtered out).
- **Asymmetry:** the formula is structurally symmetric. Net long/short skew in
  output (147 longs vs 106 shorts in the current snapshot) reflects the **market
  regime + per-symbol scoring**, not a hardcoded bias.
- **Performance asymmetry in realized data:** LONG -1.62R vs SHORT -0.28R is
  **not** caused by `chooseDirection` — it's caused by tighter stops on LONG
  (avg stop 148 bps vs SHORT 340 bps), much higher cost (0.88R vs 0.16R),
  and higher runnerExitShare (68% vs 6%). These are downstream of variant
  selection, not direction selection. (Source: calibration `byDirection`.)
- **Was this previously audited?** Yes, repeatedly — the audit panels surface
  this in `byDirection` breakdowns. The conclusion across audits has been that
  the directional bug is **not in direction selection**, it is in
  *which entry/exit combos get applied to LONG trades in this regime*.

---

## 8. Entry Playbooks

Defined in `packages/shared/src/execution-plan.ts` lines 84–89 and
`chooseEntryVariant()` line 155+.

| Variant key            | Idea                                       | Currently selectable? | Evidence verdict |
|------------------------|--------------------------------------------|------------------------|------------------|
| `vwap_retest_entry`    | Wait for retracement to 5m VWAP, fade only if there's confluence | Yes — **currently the leader by maturity** | Best of the field: 42 closed, netAvgR -0.71R, PF 0.15, 36% win. Best gross R available; still net-negative |
| `fib_500_entry`        | 0.500 fib retrace into prior leg          | Yes — **locked live-readiness route**, 0 closed | Insufficient data; legacy `fib_500+tp1_full` shows 14 closed at -0.92R |
| `fib_382_entry`        | 0.382 shallow fib retrace                  | Yes | `fib_382+trail_after_tp1`: 13 closed, -0.33R, 38% win, 23% SL — least-bad runner combo |
| `no_chase_atr_entry`   | Reject continuation moves; require pullback ≥ k×ATR | Selectable but **toxic** with `kronos_runner_exit`: 171 closed, **-2.86R, 0% win, 98% SL** | Catastrophic — legacy data, mostly emitted before router patches |
| `ema20_pullback_entry` | Pull back to 5m EMA20 | **Toxic flagged in code** — `TOXIC_ENTRY_VARIANTS` in `profit-routing.ts:84`; tests enforce demotion to RESEARCH_ONLY unless symbol stats override at ≥15 resolved AND netAvgR ≥ 0.10 | 16 closed at -2.23R, 0% win, 94% SL when paired with `tp1_full_exit` |

**Historical findings already surfaced by analytics:**
- `no_chase_atr_entry + kronos_runner_exit` was the dominant legacy emission
  cohort and is the single largest leak in the data set. Currently the router
  blocks runner exits when net R is negative (test:
  `RUNNER_REQUIRES_POSITIVE_NET`) or under horizon conflict
  (`RUNNER_BLOCKED_BY_HORIZON_CONFLICT`).
- `ema20_pullback_entry` is on the explicit toxic list with a stronger override
  threshold than generic symbol-positive (15 resolved + netAvgR ≥ 0.10).
- `vwap_retest_entry + tp1_full_exit` is the post-calibration leader. Best
  available but still loses money.
- `fib_500_entry + tp1_full_exit` is the locked live-readiness route despite
  being un-evidenced (0 closed).

---

## 9. Exit Variants

Defined in `execution-plan.ts` and surfaced via `chooseExitVariant()`.
Replay/runner data from current snapshots:

| Variant key            | Idea | Block conditions | Realized (recent) |
|------------------------|------|------------------|-------------------|
| `tp1_full_exit`        | Take full position at TP1; safest default | None | Across all entries: +0.143R, PF 3.28, 60% win, 0% SL when actually triggered (n=25). This is **the only exit reason that pays**. |
| `tp1_50_tp2_runner`    | 50% off at TP1, runner to TP2 | Blocked if `RUNNER_REQUIRES_POSITIVE_NET`, blocked under `KRONOS_HORIZON_CONFLICT` | vwap_retest pair: 14 closed -0.75R, 64% win, 71% SL — runner giveback eats winners |
| `tp1_70_runner30`      | 70% off at TP1, 30% runner | Same runner blockers | not confirmed in current sample |
| `trail_after_tp1`      | Trail stop after TP1 hit | Same runner blockers | fib_382 pair: 13 closed -0.33R |
| `kronos_runner_exit`   | Hold while Kronos agrees, flip on bias change | Hard-blocked if `kronos.horizonConflict === true` (`profit-routing.ts:RUNNER_BLOCKED_BY_HORIZON_CONFLICT`) | Legacy with `no_chase_atr`: 171 closed -2.86R |
| `kronos_flip_exit`     | Exit on Kronos bias flip even before TP1 | Same Kronos availability requirement | not confirmed independently |
| `whale_conflict_exit`  | Exit on whale-flow opposition | Requires whale availability | not confirmed independently |
| `vwap_loss_exit`       | Exit if price closes back through VWAP | None | not confirmed independently |

**Why `tp1_full_exit` became the safer default:**
By exit reason in the current 42-trade leading cohort:

| Exit reason | n  | netAvgR | gross  | PF   | win  |
|-------------|----|---------|--------|------|------|
| `TP1_FULL`  | 25 | +0.143  | +0.272 | 3.28 | 60%  |
| `SL`        | 17 | -1.962  | -1.000 | 0    | 0%   |

When TP1 fires, the trade is profitable. The losses come entirely from SL hits.
Runners (when they trigger) historically give back winners faster than they
extend them in the current sample. The system has gravitated toward `tp1_full`
as the safer default for that reason.

---

## 10. Variant Selection Engine

Entry point: `buildVariantSelection(candidate, performance, calibration)` in
`shared/src/execution-plan.ts:404`. This is the most important "is the bot
smart yet" function.

**Selection flow (high level):**

1. `chooseEntryVariant(candidate, perf, chaseRisk)` — picks an entry variant.
   - Replay-backed shortcut: if the candidate's variant has positive replay
     `netAvgR`, prefer that. This is the "positiveReplayChoice dominates
     geometry" rule.
   - Geometry fallback: when replay is thin/absent, pick by setup geometry
     (VWAP available? fib levels well-formed? etc.).
   - Toxic variants (`ema20_pullback_entry`) get routed away unless symbol-specific
     positive evidence exceeds 15 resolved + 0.10 netAvgR.
2. `chooseExitVariant(candidate, perf, chaseRisk)` — picks an exit variant.
   - Runner exits are blocked under Kronos horizon conflict or when net R
     would be negative.
   - Default fallback is `tp1_full_exit`.
3. Expected R is built from:
   - Replay net/gross averages when sample tier is `usable` or `provisional`,
   - Heuristic geometry (entry ⇆ TP, stop distance, cost model) when replay
     is `early`.
4. The result is wrapped in a `selectedExecutionPlan` containing
   `expectedNetR`, `expectedGrossR`, `routeMode`, `routeReasonCodes`,
   `selectionSource: "replay" | "heuristic_fallback"`, calibration evidence.

**Separation of concerns:**

| Layer | Source of truth | Used by |
|-------|-----------------|---------|
| Replay-backed selection | `tracker.readAllRaw()` + `shadow-positions.json` aggregates | `chooseEntryVariant`, `chooseExitVariant`, `computeProfitRoute` |
| Heuristic fallback | `candidate.indicators` (VWAP, EMA20, ATR, fib levels) | `chooseEntryVariant` when replay tier is `early` |
| Analytics-only "historical best variant" | Route Maturity panel, Symbol-Route Audit | Display only — does **not** feed back into selection |

**Historical convergence event:** After one patch (the "positive replay choice
dominates" path), most candidates briefly converged on the same entry/exit
combo because that combo was the only one with sufficient positive replay
evidence. This is visible in the audit data and was noted as a side effect
to monitor; subsequent symbol-aware filters (toxic-variant guard,
all-replay-negative guard) re-spread the distribution.

---

## 11. Profit Routing System

**Canonical function:** `computeProfitRoute(input)` in
`packages/shared/src/profit-routing.ts`. **This is the choke point.** Whatever
the scanner says, this function decides whether the trade is treated as
profit-eligible.

### 11.1 Route modes

| Mode              | Meaning |
|-------------------|---------|
| `PROFIT_CANDIDATE`| Primary, profit-route-eligible. Counts toward live readiness gates. |
| `DATA_COLLECTION` | Run as shadow; collect evidence; do NOT count as profit route. Default for early-tier and breakeven candidates. |
| `RESEARCH_ONLY`   | Negative-edge or toxic; quarantine. Shadow continues for learning but never escalates. |

### 11.2 Reason codes (current, observed in code/snapshot)

Promotion-supporting:
`POSITIVE_NET_EVIDENCE`, `SYMBOL_NET_POSITIVE`, `KRONOS_AGREES`, `WHALE_AGREES`,
`RUNNER_OK`, `PROFITABLE_REPLAY_CHOICE`, `TP1_PROFITABLE_AFTER_COST`,
`TOXIC_VARIANT_OVERRIDDEN_BY_SYMBOL`.

Demotion / blocker:
`NEGATIVE_NET_EVIDENCE`, `NEUTRAL_NET_EVIDENCE`, `EARLY_SAMPLE`,
`ALL_REPLAY_VARIANTS_NEGATIVE`, `SYMBOL_NET_NEGATIVE`, `SIDE_NET_NEGATIVE`,
`TOXIC_VARIANT`, `KRONOS_DISAGREES`, `KRONOS_HORIZON_CONFLICT`,
`RUNNER_BLOCKED_BY_HORIZON_CONFLICT`, `RUNNER_REQUIRES_POSITIVE_NET`,
`COST_R_HIGH`, `STOP_TOO_TIGHT`, `TP1_NOT_PROFITABLE_AFTER_COST`,
`NO_EVIDENCE`, `WHALE_DISAGREES`, `CALIBRATION_BLOCKS_PROMOTION`,
`STOP_DISTANCE_ULTRA_TIGHT`.

### 11.3 Deterministic decision order (from `profit-routing.ts:254+`)

```
if toxic && !toxicOverridden            → RESEARCH_ONLY
else if allReplayVariantsNegative       → RESEARCH_ONLY (net < -0.05) else DATA_COLLECTION
else if expectedNetR === null           → DATA_COLLECTION (NO_EVIDENCE)
else if expectedNetR < 0                → RESEARCH_ONLY
else if LONG + side deeply negative + no symbol-positive → DATA_COLLECTION
else if variantConfidenceTier === early → DATA_COLLECTION
else if expectedNetR > 0                → PROFIT_CANDIDATE
else                                    → DATA_COLLECTION

post-pass:
  SHORT near breakeven (net ≥ -0.05) + not toxic → DATA_COLLECTION
  CALIBRATION GATE:
    if PROFIT_CANDIDATE AND (calibratedNetR ≤ 0
                            OR verdict RAW_EDGE_NOT_VALIDATED
                            OR HEURISTIC_OVERCONFIDENT && calibSample ≥ 5)
      → DATA_COLLECTION + CALIBRATION_BLOCKS_PROMOTION
  ULTRA_TIGHT STOP GUARD:
    if stopDistanceBps < 100 (finite)
      → add STOP_DISTANCE_ULTRA_TIGHT
      → if PROFIT_CANDIDATE: demote to DATA_COLLECTION
      → never loosen RESEARCH_ONLY or DATA_COLLECTION

primaryProfitEligible = (routeMode === PROFIT_CANDIDATE)
```

### 11.4 Key protections present in code

- **Toxic-variant protection:** `ema20_pullback_entry` cannot promote unless
  symbol-specific stats meet 15+ resolved AND netAvgR ≥ 0.10. Generic
  `symbolPositive` is not enough.
- **All-replay-negative block:** if every replay combo for this variant set
  shows non-positive netAvgR, promotion is blocked.
- **Symbol-net-negative:** soft demotion via `SYMBOL_NET_NEGATIVE`.
- **Negative expected net R block:** unconditional `RESEARCH_ONLY`.
- **LONG deep-negative-side fallback:** when side stats are deeply negative
  and no symbol-specific positive evidence exists, demoted to DATA_COLLECTION
  rather than allowed to promote on a thin signal.
- **SHORT near-breakeven → DATA_COLLECTION:** prevents RESEARCH_ONLY churn
  on marginal shorts (kept learning rather than thrown away).
- **Whale/Kronos annotate but do not upgrade:** explicitly tested — agreement
  alone cannot lift a negative-net candidate. Disagreement does not block;
  it just annotates.
- **Ultra-tight stop guard (added this session):** `stopDistanceBps < 100` is
  an unconditional demotion to DATA_COLLECTION when PROFIT_CANDIDATE. Driven
  by audit evidence: ULTRA_TIGHT bucket = 0% win, -2.14R, 73% SL across 11
  closes.

**`primaryProfitEligible`** is the boolean that downstream code uses to mean
"yes, this is a real trade idea, count it." Identical to `routeMode === "PROFIT_CANDIDATE"`.

---

## 12. Expectancy and Calibration

### 12.1 Raw heuristic expected R

Computed in `buildVariantSelection`. Driven by:
- Replay variant stats (`netAvgR`, `grossAvgR`) when sample tier allows,
- Heuristic geometry (entry-to-TP distance, stop-distance, cost model) otherwise.

This is the planner's *first-pass* expectation. The audits show it is
**systematically too high**:

```
Total 166-trade sample, raw heuristic:
  avgExpectedNetR =  +0.85
  avgRealizedNetR =  -1.18
  expectationError = 2.04
  overestimationRate = 65%
  correlation expected-vs-realized = -0.001 (essentially noise)
```

### 12.2 Calibrated expected net R

`packages/shared/src/calibrated-expectancy.ts` + `buildCalibrationEvidenceFromPositions`
in `apps/api/src/lib/expectation-calibration.ts`. The calibration system:

1. Aggregates closed positions by (entryVariant, exitVariant, optionally symbol/side).
2. Computes a residual: realized − raw-expected.
3. Adjusts new raw expectations by the cohort residual.
4. Emits a `calibrationVerdict` (`CALIBRATED_POSITIVE`, `CALIBRATED_NEGATIVE`,
   `RAW_EDGE_NOT_VALIDATED`, `INSUFFICIENT_SAMPLE`) and `diagnosisCodes`
   (`HEURISTIC_OVERCONFIDENT`, `COST_DRAG_UNDERCOUNTED`, etc.).
5. `computeProfitRoute()` consumes `calibratedExpectedNetR`,
   `calibrationVerdict`, and `calibrationSampleSize` to gate promotion
   (see §11.3 CALIBRATION GATE).

### 12.3 Latest calibration verdict (live snapshot)

Top-level diagnoses: **`HEURISTIC_OVERCONFIDENT`** + **`COST_DRAG_UNDERCOUNTED`**.

```
Post-calibration cohort (42 trades emitted under POST_CALIBRATION policy):
  Raw expected R:           +1.0636
  Calibrated expected R:    -1.2817   ← calibration is now bearish
  Realized R:               -0.7089
  Raw error:                +1.7725 (raw was too optimistic)
  Calibrated error:         -0.5728 (calibrated is too pessimistic)
  Improvement (1 − |err_calib| / |err_raw|): +67.68%
```

**Honest read:** the calibration overshot the correction. It is now *more
pessimistic than reality*. This is preferable to the raw overconfidence (a
slight downward bias is a defensive stance), but the calibration model itself
is still settling.

### 12.4 Themes confirmed

- **Planner overestimates raw R** — confirmed at 65% overestimation rate,
  severe at 51%, hit-rate-when-expected-positive 27% (random).
- **Cost drag was suspected then deprioritized as primary leak** — confirmed:
  `byRouteMode.PROFIT_CANDIDATE` has avgCostR = 1.52R but realized R = +0.09R
  (cost is real but doesn't dominate). The dominant leak is gross-R-negative
  routes (gross -0.24R on the leader cohort *before* costs).
- **Post-calibration adjustment reduced raw error materially** — confirmed: 67.68%.
- **Realized R still negative** — confirmed: -0.71R on the leader cohort.

---

## 13. Shadow Execution Engine

`apps/api/src/lib/shadow-engine.ts`. Operational flow:

1. **Candidate received.** `processScan()` called by the scan route. Each
   candidate gets reviewed for an existing open/pending position
   (dedup by symbol-direction-fingerprint).
2. **Pending entry created.** A pending entry zone (from
   `selectedExecutionPlan.entryZone`) is recorded. State: `OPEN_PENDING`.
3. **Pending-limit fill.** On subsequent 5m candle snapshots, the engine
   checks whether price entered the zone. The fill price is the conservative
   side of the zone (closer to current price). No-fill positions stay pending
   until either (a) a fill, (b) a stop-out before fill, (c) timeout / new
   scan supersedes them.
4. **Same-candle ambiguity.** When the entry candle also touches SL and TP,
   the engine defers SL/TP evaluation to the **next** candle to avoid
   intrabar ordering assumptions. This is conservative.
5. **SL/TP evaluation.** Starts from the candle *after* fill. SL hits resolve
   as `SL`. TP1 hits resolve as `TP1_FULL` (under tp1_full_exit) or partial
   (`TP1_PARTIAL_THEN_RUNNER`) under runner variants.
6. **Close reason taxonomy:**
   - `SL` — stop triggered.
   - `TP1_FULL` — TP1 hit, full exit.
   - `TP1_PARTIAL_THEN_RUNNER` — TP1 partial, runner phase active.
   - `RUNNER_TP2` / `RUNNER_TP3` / `RUNNER_TRAIL_STOP` — runner outcomes.
   - `KRONOS_FLIP` / `WHALE_CONFLICT` / `VWAP_LOSS` — variant-specific exits
     (when those variants are selected).
   - `NO_FILL` / `EXPIRED` — pending entries that never filled.
7. **Remaining size.** Runner variants track `remainingSize` from initial
   100% down through staged exits.
8. **Route mode persisted.** `routeMode` is captured at position creation and
   immutable thereafter — audits filter on the route mode the position was
   *born* with, not on a current re-evaluation.
9. **Dedup behavior.** Same symbol+direction+fingerprint within a scan window
   is rejected at the pending stage; updates can refresh the entry zone but
   not the route mode of an existing position.
10. **Lifecycle logging.** When `DECISION_LEDGER_DISABLED != "1"`,
    `decision-ledger.ts` writes JSONL events (currently `ROUTE_ASSIGNED`
    is confirmed; other lifecycle events are TBD — see §14).

**Cost assumptions:**

- Spread cost: from book ticker bid/ask captured at scan time.
- Fee + slippage: a fixed-rate model (configurable via env / constants in
  `shadow-engine.ts`). The calibration system validates this against realized
  cost; the current sample shows `costModelCalibrated: true, costOverrun: 0`.
- Stop distance: derived from the candidate's plan; recorded in bps.

**Pending-entry mechanics — UI gap to flag.** The Trade Plan card on the UI
shows the entry as the target zone, but the *executed* (fill) price is
whatever the conservative pending-limit logic actually filled at. These can
differ materially when price moves through the zone. The Entry Precision
Audit (see §15) is the panel that surfaces this gap.

---

## 14. Decision Ledger / Reflection / Monitoring Layers

**Decision Ledger:** `apps/api/src/lib/decision-ledger.ts`. Writes to
`data/decision-log.jsonl` when `DECISION_LEDGER_DISABLED != "1"`.

Confirmed events from code/grep:
- `ROUTE_ASSIGNED` — emitted by `scan.ts` per surfaced candidate (with
  `routeMode`, `routeReasonCodes`, expectations, kronos/whale agreement).

Events that are referenced in design docs but not confirmed as currently
emitted in this codebase scan:
- `PLAN_SELECTED`, `ENTRY_PENDING`, `EXIT_CLOSED`, `REFLECTION_ADDED` —
  **not confirmed from repo.** They may be partially implemented or deferred;
  please verify before assuming they exist.

**ReflectionAgent:** `apps/api/src/lib/reflection-agent.ts` exists. Behavior
is **deterministic / LLM-free** (no API keys consumed). It is intentionally
read-only commentary, not a feedback loop into routing.

**Routing-monitor:** `apps/api/src/lib/routing-monitor.ts` —
`/api/shadow/routing-monitor` endpoint. Surfaces:
- route mode distribution,
- new-ideas-today,
- top profit leaks,
- locked-route progress (`fib_500 + tp1_full`).

---

## 15. Analytics and Audit Panels

All read-only. None feed back into routing or selection (this is intentional).

| Panel / endpoint | Question it answers | Data scope | Latest conclusion (snapshot 2026-05-13) |
|---|---|---|---|
| Profitability first / `routing-monitor` | Did routing actually keep us out of obvious losers? | All eras | RESEARCH_ONLY: -2.46R/230 closed/PF 0.016 — router correctly quarantines garbage. PROFIT_CANDIDATE: +0.09R/6 closed (too small to read). |
| Shadow Route Maturity / `route-maturity` | Which route has enough evidence to consider promoting? | POST_CALIBRATION era, all priority cohorts | Leader: `vwap_retest+tp1_full`, 42 closed, **WEAK** maturity. `fib_500+tp1_full` and `fib_382+tp1_full` are 0-closed/COLLECTING. |
| Live Auto Readiness / `live-readiness` | Are we safe to enable full-auto? | Locked route only | 30/100 score, 3/10 gates pass (all infra), 0 closed on the locked route. MISMATCH with maturity leader. |
| Route Alignment | Is the locked route same as the maturity leader? | Cross-panel | MISMATCH. Locked = fib_500+tp1_full, leader = vwap_retest+tp1_full. |
| Expectation Calibration / `expectation-calibration` | Is the planner systematically wrong? | All closed primary | YES — 65% overestimation, correlation -0.001. Calibration cuts error 67.68%. |
| Calibration improvement | How much did post-deployment improve? | POST_CALIBRATION subset | +67.68% error reduction; calibrated slightly under-estimates. |
| System Drift Monitor / `regime-drift` | Has the edge changed lately? | recent 7d vs baseline | STABLE (most routes flagged `SAMPLE_TOO_SMALL_FOR_DRIFT`). |
| Post-Calibration Profit Anatomy / `profit-anatomy` | What is the dominant leak shape? | POST_CALIBRATION leader | Primary leaks: 40% SL rate, 0.47R cost drag, avg loss -1.29R vs avg win +0.34R (4× asymmetry). |
| Entry Fill & Cost Attribution / `cost-attribution` | Is our cost model honest? | All closed | Cost model calibrated (0 overrun). avg cost 0.47R. High-chase-risk rate 91.67% — most fills are chasing into the zone. |
| Symbol-Route Audit / `symbol-route-audit` | Which symbols drag the leader route? | POST_CALIBRATION leader | SUIUSDT (-13.29 totalR), BNBUSDT (-7.42), NEARUSDT (-5.57), DOGEUSDT (-4.83). `SYMBOL_CONCENTRATED` diagnosis. |
| Entry Fill Precision / `entry-precision-audit` | Are we filling deep enough into the zone? | POST_CALIBRATION leader | INSIDE_OR_BETTER fills still -0.33R — entry quality is fine; route is the problem. MODERATE_DRIFT fills -2.24R (deep, late chasers). |
| Winner vs Loser Setup Discriminant / `winner-loser-audit` | Which features actually predict winners? | POST_CALIBRATION | `FEATURE_SEPARATION_EMERGING`. Strongest signals: wider stops (winners 430 vs 274 bps), lower RR (3.99 vs 9.32), lower horizonConflict (7% vs 30%). Kronos/whale agreement does NOT separate winners. |
| Stop Geometry & RR Credibility / `stop-geometry-audit` | Are tight stops fake-edge artifacts? | POST_CALIBRATION | `STOP_AND_RR_COMBINED_LEAK`. ULTRA_TIGHT (<100 bps) = 0% win/-2.14R; VERY_WIDE (>500) = 64% win/+0.24R. Excluding <100 bps lifts net by +0.40R. |
| Cohort Performance / `cohort-performance` | Per-cohort closed metrics. | All eras | (Not summarized here — see endpoint.) |

**No panel changes routing.** This is structurally important: the audits exist
to *explain* the bot to a human; if they could mutate behavior they'd be
indistinguishable from the strategy itself.

---

## 16. Live Readiness Logic

### 16.1 The 10 hard gates (from `apps/api/src/lib/live-readiness.ts`)

| Gate code                  | Threshold (line in code)         | Current status |
|----------------------------|-----------------------------------|----------------|
| CLOSED_SAMPLE_SUFFICIENT   | `TARGET_CLOSED = 100` (119)        | **FAIL** (0)   |
| NET_AVG_R_POSITIVE         | `NET_AVG_R_GATE = 0.15` (120)      | **FAIL** (n/a) |
| PROFIT_FACTOR_OK           | `PF_GATE = 1.3` (121)              | **FAIL** (n/a) |
| TP1_PROFITABLE_RATE_OK     | `TP1_PROFIT_RATE_GATE = 0.55` (122)| **FAIL** (n/a) |
| SL_RATE_OK                 | `SL_RATE_GATE = 0.35` (123)        | **FAIL** (n/a) |
| MAX_LOSING_STREAK_OK       | `MAX_LOSING_STREAK_GATE = 4` (124) | PASS (0)       |
| RECENT_DAYS_POSITIVE       | `≥7 of last 10` (126)              | **FAIL** (0/0) |
| WORST_DAY_OK               | `> -2R` (127)                      | **FAIL** (n/a) |
| DATA_COVERAGE_OK           | `≥ 0.95` (128)                     | PASS (1.00)    |
| KRONOS_HEALTHY             | adapter `forecastHealthy=true`     | PASS           |

Score = 30/100 (3 pass × 10).

### 16.2 Locked evaluation route

The gate evaluator looks at trades whose **route was the locked route**:
`fib_500_entry + tp1_full_exit`. This is hardcoded as the "candidate live
route". Any maturity leader running on a different route does **not** advance
the readiness gates.

### 16.3 Route alignment mismatch

Currently `routeAlignmentStatus = "MISMATCH"`. The system explicitly says:

> "Live Auto Readiness gates evaluate the locked route only and do not
> automatically follow the maturity leader. This is informational — no
> action is required."

This is the right design (otherwise readiness chases noise), but the
*operator implication* is that you cannot reach live readiness without
either:
(a) running enough `fib_500+tp1_full` shadow trades to fill the gates, or
(b) consciously re-locking to the maturity leader.

### 16.4 Why readiness is **still advisory only**

`live-readiness.ts:notes`:

> "Live readiness is advisory only. Shadow collection continues regardless
> of this report. Hard gates do not cap shadow trades, daily losses, or
> open positions."

There is **no automatic live-trading switch**. Even if all 10 gates passed,
the next action is human review. This is the correct safety stance for the
current maturity level.

---

## 17. Current Performance Snapshot

See `docs/TRADING_BOT_PERFORMANCE_SNAPSHOT.md` for the full timestamped
extract (pulled **live** at 2026-05-13 11:48–11:49 UTC from
`http://localhost:3101/api/shadow/*`). Key numbers:

- 253 total ideas (6 PROFIT_CANDIDATE / 165 DATA_COLLECTION / 82 RESEARCH_ONLY).
- Leading cohort `vwap_retest+tp1_full` POST_CALIBRATION: 42 closed,
  netAvgR -0.7089R, PF 0.1473, win 35.71%.
- Locked live-readiness route `fib_500+tp1_full`: 0 closed.
- Live readiness 30/100, MISMATCH alignment.
- Calibration improvement +67.68%.
- Stop ULTRA_TIGHT: -2.14R/0% win. VERY_WIDE: +0.24R/64% win.
- LONG: -1.62R, 74% SL. SHORT: -0.28R, 30% SL.
- Symbol drag: SUI -13.29R, BNB -7.42R, NEAR -5.57R total.

---

## 18. Historical Evolution of the Bot

Reconstructed from code comments, audit panel inputs, and visible patches.
Each entry: **what bug/leak it addressed → what changed → outcome.**

1. **Profitability cards separated by scope.** Earlier cards mixed
   PROFIT_CANDIDATE / DATA_COLLECTION / RESEARCH_ONLY into one number.
   Now `routing-monitor` and `expansion` report per-route. **Outcome:** the
   real numbers stopped being hidden behind aggregation. Mixed→Positive.

2. **`routeMode` introduced.** The three-mode router was added (PROFIT_CANDIDATE,
   DATA_COLLECTION, RESEARCH_ONLY). **Outcome:** quarantine of bad ideas works
   (RESEARCH_ONLY now -2.46R/0.016 PF — confirming the router *finds* the bad
   ideas). Positive.

3. **ProfitRoutingAgent (`computeProfitRoute`).** Centralized routing in
   shared/src/profit-routing.ts; all reason codes added. **Outcome:** route
   decisions became testable; tests in `packages/shared/test/profit-routing.test.ts`
   cover toxic-variant, replay-negative, Kronos-conflict, calibration gate,
   ultra-tight stop. Positive.

4. **DecisionLedger.** JSONL audit trail; `ROUTE_ASSIGNED` confirmed.
   **Outcome:** explanatory provenance for any candidate. Mixed (only
   ROUTE_ASSIGNED confirmed; other lifecycle events not confirmed in this scan).

5. **ReflectionAgent.** Deterministic LLM-free commentary. **Outcome:**
   useful UI; no behavior change. Neutral.

6. **Route Maturity panel.** Tracks cohort maturity status separately from
   live readiness. **Outcome:** revealed the locked-route mismatch.
   Positive — surfaces real fact.

7. **Calibration system.** Empirical residual correction.
   **Outcome:** +67.68% error reduction; calibrated estimate now slightly
   under-estimates. Positive.

8. **System Drift Monitor.** Recent vs baseline net R, drift codes.
   **Outcome:** currently inconclusive (samples too small for drift). Neutral.

9. **Profit-Anatomy + Cost-Attribution audits.** **Outcome:** confirmed
   cost drag is real but not primary (gross is also negative). Positive
   (correctly identified the leak as upstream of cost).

10. **`no_chase_atr_entry + kronos_runner_exit` toxicity fix.** Router now
    blocks runner exits under negative net or horizon conflict.
    **Outcome:** legacy 171-trade -2.86R cohort can no longer reproduce.
    Strongly positive — single biggest historical leak shut down.

11. **`ema20_pullback_entry` toxicity guard.** Promoted only if
    symbol-specific evidence ≥ 15 resolved AND netAvgR ≥ 0.10.
    **Outcome:** correctly demoted in tests; 16-trade legacy still in
    sample. Positive.

12. **Ultra-tight stop guard (this session).** `stopDistanceBps < 100`
    demotes PROFIT_CANDIDATE → DATA_COLLECTION, never loosens stricter
    modes. **Outcome:** ULTRA_TIGHT historical cohort -2.14R, 73% SL —
    guard now blocks the false-edge quadrant. Positive.

13. **Kronos rotary cache concurrency fix (this session).** Sidecar threading
    lock + stateless rotary patch + KRONOS_CONCURRENCY=1. **Outcome:**
    Kronos went from 0/20 succeeded to 20/20 succeeded. Critical-bug fix.

---

## 19. What the Bot Currently Seems to Believe

Synthesised from code and audit outputs — the design philosophy *the code
actually implements*:

1. **The scanner is for discovery, not truth.** Scanner scores rank candidates
   for human attention; the router decides whether the bot will *believe*
   the candidate enough to call it a profit route.
2. **Replay evidence beats heuristic geometry.** When a variant has enough
   resolved shadow data, replay net R drives selection. Heuristic geometry
   is the fallback when replay is `early`.
3. **Negative observed evidence is unconditional.** Symbol-net-negative,
   replay-all-negative, expected-net-negative — none can be overruled by
   confluence signals.
4. **Whale/Kronos agreement annotates; it does not upgrade.** Confluence is
   suspicious because the discriminant audit shows it does **not** separate
   winners from losers (Kronos aligned: 100% on both sides; whale aligned:
   91% vs 81%).
5. **Skepticism of projected RR.** Tight stops produce inflated RR mechanically;
   the system treats this as a false-edge quadrant and demotes it.
6. **PROFIT_CANDIDATE is rare.** Out of 253 ideas, 6 (2.37%) reached PC.
   The router is biased *strongly* toward DATA_COLLECTION / RESEARCH_ONLY,
   not toward production trades.
7. **Live readiness is intentionally hard.** Ten gates, locked-route only,
   no auto-promotion of the maturity leader. The system would rather show
   30/100 than over-state readiness.
8. **All audits are read-only.** No analytics panel can mutate trading
   logic. Strategy and self-knowledge are kept on different layers.

**Internal coherence check:** the philosophy is **consistent**. The router,
audits, calibration system, and readiness gates all reinforce the same
conservative posture: *don't promote until evidence is real, and don't
fool yourself about the evidence.*

The single internal tension: the locked live-readiness route (`fib_500+tp1_full`)
is unrelated to the actual maturity leader. This is by design (avoid chasing
noise) but it makes "approach live readiness" effectively a function of
running fib_500 shadow trades the bot doesn't currently emit much of.

---

## 20. Critical Weaknesses

### A. Confirmed

1. **Realized R is negative on every cohort with a usable sample.** Leader
   cohort -0.71R/PF 0.15. The router correctly quarantines junk, but the
   non-junk it allows through is *also* losing — just losing less.
2. **Gross R is negative (-0.24R) on the leader.** This is not a cost
   problem. Even before fees+slippage+spread, the entries don't pay.
3. **LONG side is catastrophic in current regime.** 74% SL, -1.62R, much
   tighter stops than SHORT. The router does not currently differentiate
   LONG vs SHORT routing thresholds. (Symmetric direction selection +
   asymmetric realized outcomes = unaddressed bias.)
4. **Symbol concentration in the leak.** Four symbols account for ~85%
   of the leader cohort's negative total R. SUIUSDT alone is -13.29R from
   8 trades (one avg-loss-5.18R outlier). No active symbol-blacklist for
   the leader route exists.
5. **Locked-route MISMATCH with maturity leader.** Live readiness will
   not advance even if vwap_retest matures, because gates evaluate
   fib_500 only.
6. **`no_chase_atr + kronos_runner_exit` legacy.** 171-trade pile of
   -2.86R sits in the data. Router blocks reproduction, but the legacy
   still appears in aggregate metrics until filtered by era.

### B. Strong suspicions

7. **Post-calibration sample size is still small.** 42 closed on the
   leader cohort; ROUTE_MATURITY's PROMOTABLE threshold is ≥30 closed +
   net > 0.10 + PF > 1.2 + TP1prof > 50% + SL < 40%. Sample is only just
   crossing 30 and the route is not promotable.
8. **`tp1_full_exit` may simply be the least-bad option.** It pays when
   TP1 fires (+0.27R gross), but TP1 fires only ~60% of the time and the
   40% that hit SL average -1.96R. Asymmetric loss profile is the heart
   of the problem.
9. **Scanner ranking optimizes for *attention*, not realized PnL.**
   `opportunityScore` is composed of heuristic factors that have weak
   correlation with winning trades in the discriminant audit
   (`routeScore` Δ winner−loser = +1.4, effect size WEAK).
10. **High-chase-risk rate at 91.67%.** Nearly every fill is a chase.
    The entry-precision audit shows INSIDE_OR_BETTER fills are still
    -0.33R — entry quality alone isn't fixing it, but improving fill
    discipline might at least narrow the bleed.

### C. Still unproven concerns

11. **Regime sensitivity.** Drift monitor flags SAMPLE_TOO_SMALL universally;
    we genuinely don't know if the current loss profile is regime-specific
    (and would invert in a different regime) or structural.
12. **Whether stricter symbol filtering would extract net-positive R from
    the leader cohort.** Removing the 4 worst symbols would lift the leader
    from -0.71R to roughly breakeven-or-slightly-positive on a smaller n —
    but that's classic data dredging; can't be acted on without forward
    confirmation.
13. **Whether the planner can learn from ReflectionAgent / Decision Ledger
    feedback.** The hooks exist; the feedback loop into routing does not.

---

## 21. What Looks Genuinely Promising

Evidence-based, not aspirational:

1. **Calibration error reduction is real.** +67.68% improvement from raw to
   calibrated estimate. The planner is now better-calibrated about its own
   weakness than at any prior point in this codebase.
2. **Router correctly quarantines garbage.** RESEARCH_ONLY: 230 closed,
   -2.46R, 9.6% win, 90% SL — that is *unmistakably* destructive cohort,
   and 32% of all ideas go there before they can hurt the leader.
3. **`tp1_full_exit` carries a +0.27R gross expectancy when it triggers.**
   When TP1 fires (60% of the time), the trade is profitable. The "winning
   side of the strategy" is genuine, not statistical noise — n=25, +0.143R
   net, PF 3.28.
4. **Stop-geometry audit produces a clean answer.** ULTRA_TIGHT (<100bps)
   vs VERY_WIDE (>500bps) shows a 2.4R per-trade gap. The guard now blocks
   the false-edge quadrant. Next sample should see a noticeable lift.
5. **Discriminant audit identifies separating features.** Three moderate-effect
   features (stop distance, entry drift, horizon conflict) show direction
   we can act on. Confluence signals (Kronos, whale) correctly identified
   as non-separating.
6. **SHORT side is near breakeven.** -0.28R on n=54, 30% SL. With the
   right symbol filtering and the ultra-tight-stop guard active, this
   side might reach gross-positive in the next sample.
7. **Test coverage is solid.** `packages/shared/test/profit-routing.test.ts`,
   `scanner-diagnostics.test.ts`, `apps/api/test/*.test.ts` for every audit —
   303 tests, all green. Patches don't regress silently.

---

## 22. Is It Worth Continuing?

**CONDITIONAL YES.**

**Why:**
- The infrastructure is sound. Router, calibration, audits, shadow execution,
  decision ledger — these are real, testable, working components. Building
  them again from scratch would cost 2–3× the marginal cost of fixing the
  remaining strategy issues.
- The system is **finding** real signal (stop geometry, horizon conflict,
  symbol concentration) at a rate that suggests another 50–100 closed
  POST_CALIBRATION trades will materially change the picture.
- The downside risk is bounded: no live trading, no auto-promotion, no
  capital exposed.

**What would flip the answer to NO:**
- 100+ additional POST_CALIBRATION closed trades with **no** improvement
  in either gross R or calibration accuracy.
- A confirmed regime change where the current edge (such as it is) inverts
  on shorts as well — i.e. when the directional asymmetry disappears and
  *both* sides are -1R.
- Loss of the underlying market data feeds (Binance throttling, Kronos
  sidecar instability — the recent rotary bug is a reminder that the model
  has supply-chain risk).

**Milestones that would justify continued development:**
- **M1 (immediate, low-cost):** next 30 POST_CALIBRATION closes on
  `vwap_retest+tp1_full` *with* the ultra-tight-stop guard active. If
  net R rises above -0.30R and the calibrated error stays inside ±0.5R,
  the bot is improving on its own.
- **M2 (medium):** identify whether SHORT side can cross gross-positive
  (≥ 0.10R gross) on 40+ closes. If yes, asymmetric LONG/SHORT routing
  becomes the lever.
- **M3 (large):** any cohort reaches PROMOTABLE status (≥30 closed,
  netAvgR > 0.10, PF > 1.2, TP1prof > 50%, SL < 40%) in
  Route-Maturity. That's the bar this codebase set for itself; nothing
  has hit it yet.

---

## 23. What Must Be True Before Full Auto Live Trading

Beyond the existing 10 gates, the **real maturity bar** is:

1. **≥100 closed trades on the actual production route** (not the locked
   placeholder). Live-readiness needs to re-lock to whichever route has
   the evidence.
2. **netAvgR ≥ 0.15 on the production route** with PF ≥ 1.3.
3. **Calibration error inside ±0.30R** on the production cohort (currently
   -0.57R — meaningfully outside this band).
4. **Regime robustness:** the route must be positive in at least 2 distinct
   regime classifications, not only in the regime that happened to dominate
   collection.
5. **Symbol-route stability:** no single symbol contributes > 20% of total
   net R (positive or negative). Currently SUIUSDT alone is 45% of total
   negative R on the leader cohort.
6. **Failure mode containment:** documented behavior for Kronos outage,
   Binance throttle, sidecar restart, mid-trade SL adjustment failures.
   The recent Kronos crash gave us a glimpse — the cockpit gracefully
   showed "Kronos degraded" and continued, which is good, but live
   trading needs an explicit pre-mortem of every external dep.
7. **Post-patch cohort proving itself:** every routing patch from the
   last 60 days needs at least one promoted-from-DATA_COLLECTION cohort
   *after* the patch landed. Right now we have legacy data poisoning
   most aggregates; we need to see the *post-patch* world stand on its own.
8. **No single toxic slice dominating PnL.** A passing maturity status
   that is driven by 5 symbols out of 20 is not robust; it's a tracked
   subset that happens to be working.

---

## 24. Recommended Next 3 Steps

Targeted, minimal, evidence-driven.

### Step 1 — **Do now: re-align the locked live-readiness route**

The locked route `fib_500_entry + tp1_full_exit` has 0 closed trades.
The maturity leader `vwap_retest_entry + tp1_full_exit` has 42 closed
trades and is the only cohort showing maturity status above COLLECTING.
Locking readiness to a route the system isn't emitting is dead reckoning.

- Change `LOCKED_EVALUATION_ROUTE` in `apps/api/src/lib/live-readiness.ts`
  to reflect the current maturity leader, **or** explicitly document why
  fib_500 is the locked future-state route and what selection nudge is
  needed to produce more fib_500 emissions.
- **Why:** without this, the readiness score is a meaningless display.
- **Trigger metric for next action:** non-zero closed count on the locked
  route within 7 days of re-aligning.

### Step 2 — **Wait for data: accumulate 30 more POST_CALIBRATION closes with ultra-tight-stop guard active**

The ultra-tight-stop guard demoted PROFIT_CANDIDATE for stopDistanceBps < 100
*just this session*. The historical 11 closes in ULTRA_TIGHT bucket
(-2.14R, 73% SL) can no longer be reproduced as PROFIT_CANDIDATE.

- **Do not patch anything else in the routing layer until** the leader
  cohort grows to ~70 POST_CALIBRATION closes with the guard active.
- **Trigger metric for next action:** if next 30 closes lift netAvgR to
  > -0.30R (currently -0.71R), step 3 becomes "consider promoting to
  PROFIT_CANDIDATE for a small live shadow cohort". If next 30 closes
  *don't* improve, step 3 becomes a structural rethink (see below).

### Step 3 — **Patch later (conditional): asymmetric LONG/SHORT routing**

If steps 1–2 show that the leader cohort cannot reach gross-positive *and*
the LONG/SHORT asymmetry persists (LONG -1.6R, SHORT -0.3R), the next
high-leverage patch is asymmetric routing thresholds:

- LONG requires a *stronger* `expectedNetR` threshold than SHORT.
- LONG inherits the ultra-tight-stop guard at a wider threshold (e.g.,
  <175 bps for LONG, <100 bps for both).
- LONG `chooseExitVariant` defaults to `tp1_full_exit` regardless of
  runner replay positivity until LONG side reaches gross-positive.

**Do not implement this preemptively** — wait for step 2 to confirm whether
the asymmetry is regime-specific (resolves on its own with more data) or
structural (needs code).

---

## 25. Appendix — Exact Code Map

### Scanner / candidate construction

| Concern | File / function |
|---|---|
| Symbol universe, scan loop, parallel fetch | `apps/api/src/lib/scan-service.ts:UNIVERSE`, `ScanService.scan()` |
| Market regime classification | `apps/api/src/lib/scan-service.ts:deriveMarketRegime()` (line ~70) |
| Per-candidate construction | `packages/shared/src/scan.ts:buildCandidate()` |
| Status assignment (TRADE_NOW/READY/WAIT/WATCH) | `packages/shared/src/scan.ts:` (lines 292–310) |
| Direction selection | `packages/shared/src/scan.ts:chooseDirection()` (line 202) |
| Sorting / top-10 | `apps/api/src/lib/scan-service.ts:` (line 350) |

### Scoring

| Concern | File / function |
|---|---|
| Opportunity / danger / confidence formulas | `packages/shared/src/scan.ts` (search for `opportunityScore`, `dangerScore`, `confidence`) |
| Long / short scoring | `packages/shared/src/scan.ts` (lines 436, 446) |
| Edge metric | `packages/shared/src/edge.ts` |
| Indicators (VWAP, EMA20, ATR, fib levels) | `packages/shared/src/indicators.ts` |

### Variant selection

| Concern | File / function |
|---|---|
| Entry variant choice | `packages/shared/src/execution-plan.ts:chooseEntryVariant()` (line 155) |
| Exit variant choice | `packages/shared/src/execution-plan.ts:chooseExitVariant()` (line 219) |
| Full execution plan | `packages/shared/src/execution-plan.ts:buildVariantSelection()` (line 404) |
| Entry variant labels | `packages/shared/src/execution-plan.ts` (lines 84–89) |
| Toxic-variant list | `packages/shared/src/profit-routing.ts:TOXIC_ENTRY_VARIANTS` (line 84) |

### Profit routing

| Concern | File / function |
|---|---|
| Canonical router | `packages/shared/src/profit-routing.ts:computeProfitRoute()` (line 123) |
| Reason codes | `packages/shared/src/types.ts:ProfitRouteReasonCode` |
| Ultra-tight stop guard | `packages/shared/src/profit-routing.ts:ULTRA_TIGHT_STOP_BPS` + guard block |
| Calibration gate | `packages/shared/src/profit-routing.ts:CALIBRATION GATE` block |
| Tests | `packages/shared/test/profit-routing.test.ts` |

### Calibration

| Concern | File / function |
|---|---|
| Calibrated expectancy types | `packages/shared/src/calibrated-expectancy.ts` |
| Aggregation from positions | `apps/api/src/lib/expectation-calibration.ts:buildCalibrationEvidenceFromPositions()` |
| Evidence era classifier | `packages/shared/src/evidence-era.ts:classifyEvidenceEra()` |

### Shadow execution

| Concern | File / function |
|---|---|
| Engine | `apps/api/src/lib/shadow-engine.ts:ShadowExecutionEngine` |
| Outcome resolution | `apps/api/src/lib/outcome-checker.ts:OutcomeChecker` |
| Position persistence | `data/shadow-positions.json` |
| Execution log | `data/shadow-execution-log.json` |
| Tracker | `apps/api/src/lib/tracker.ts` |

### Audits

| Concern | File / function |
|---|---|
| Profit anatomy | `apps/api/src/lib/profit-anatomy.ts` |
| Cost attribution | `apps/api/src/lib/cost-attribution.ts` |
| Entry precision | `apps/api/src/lib/entry-precision-audit.ts` |
| Symbol-route audit | `apps/api/src/lib/symbol-route-audit.ts` |
| Stop geometry & RR | `apps/api/src/lib/stop-geometry-audit.ts` |
| Winner vs loser | `apps/api/src/lib/winner-loser-audit.ts` |
| Route maturity | `apps/api/src/lib/route-maturity.ts` |
| Regime drift | `apps/api/src/lib/regime-drift.ts` |
| Cohort performance | `apps/api/src/lib/cohort-performance.ts` |
| Expansion report | `apps/api/src/lib/expansion-report.ts` |
| Routing monitor | `apps/api/src/lib/routing-monitor.ts` |
| Reflection agent | `apps/api/src/lib/reflection-agent.ts` |
| Decision ledger | `apps/api/src/lib/decision-ledger.ts` |

### Live readiness

| Concern | File / function |
|---|---|
| Gates, thresholds | `apps/api/src/lib/live-readiness.ts` (constants at line 119–128) |
| Locked route | `apps/api/src/lib/live-readiness.ts:LOCKED_EVALUATION_ROUTE` (search) |
| Route alignment | same file |

### Routes

| Concern | File / function |
|---|---|
| Scan | `apps/api/src/routes/scan.ts` |
| Shadow (all 16 audit endpoints) | `apps/api/src/routes/shadow.ts` |
| Outcomes | `apps/api/src/routes/outcomes.ts` |
| Kronos | `apps/api/src/routes/kronos.ts` |

### Kronos sidecar

| Concern | File / function |
|---|---|
| FastAPI adapter | `services/kronos/app/main.py` |
| Model code (vendored) | `services/kronos/vendor/Kronos/model/*.py` |
| Rotary cache patch (this session) | `services/kronos/app/main.py` (`_rotary_forward_stateless`) and `services/kronos/vendor/Kronos/model/module.py:RotaryPositionalEmbedding` |
| TypeScript client | `apps/api/src/lib/kronos.ts:HttpKronosClient` |

### UI

| Concern | File / function |
|---|---|
| Single-file React UI | `apps/web/src/App.tsx` |
| Styles | `apps/web/src/styles.css` |

---

## Closing Note

This evaluation was generated by reading the repo and pulling live metrics
from a running API instance at 2026-05-13 11:48 UTC. Every numerical claim
in this document is sourced from either a code constant or a specific
endpoint response captured in `TRADING_BOT_PERFORMANCE_SNAPSHOT.md`.

**No trading logic, scoring, routing, execution, threshold, UI behavior, or
live readiness was changed by this audit.** Only these two documentation
files were created.

When a claim could not be confirmed from the code (notably the full Decision
Ledger event set, the social-sentiment routing effect, and the exact
membership of `UNIVERSE` beyond its size), the text says so explicitly.
