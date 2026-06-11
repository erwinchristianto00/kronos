# 1. Why the bot must evolve beyond fixed-route patching

The current cockpit has become good at identifying specific weaknesses and applying targeted guards. That is useful, but it is not the same thing as strategy intelligence. Fixed-route patching assumes one route can be globally repaired into profitability, while the evidence already suggests the real question is conditional: symbol, direction, route geometry, market regime, costs, and external alignment interact.

Phase 2 should move the bot toward adaptive decisions that are learned from structured experience. The bot should be able to say that a route is promising for one symbol-direction-regime combination, toxic for another, and simply under-sampled for a third. Phase 2A is the data foundation for that shift. It does not change trading behavior.

# 2. Final Phase 2 architecture overview

The final Phase 2 architecture has four intelligence components fed by one shared evidence layer:

- Component A: Symbol-Route Suitability Engine
- Component B: Adaptive Market Gate Controller
- Component C: Technical Stop/TP Credibility Engine
- Component D: Adaptive Universe Rotation

All four components consume the same primitive:

- `StrategyContextSnapshot`: what was known when the route was selected.
- `ResolvedTradeOutcomeSnapshot`: what later happened in shadow execution.
- `StrategyExperienceRecord`: the joined context plus outcome record.
- `StrategyEvidenceTable`: read-only aggregations by route, symbol, direction, and regime.

# 3. Component A - Symbol-Route Suitability Engine

Objective: determine which route is most suitable for a specific symbol, direction, and market context.

Inputs:

- Symbol and direction.
- Selected entry and exit variants.
- Route mode, score, and reason codes.
- Market regime and trend stack.
- Kronos, whale, sentiment, volatility, spread, and cost context.
- Closed shadow outcomes from matching cohorts.

Learned tables:

- Symbol + direction + route.
- Symbol + direction + route + market regime.
- Route + market regime.
- Symbol + direction.
- Symbol only.

Later candidate ranking effect:

The engine should eventually adjust route preference and route eligibility, not rewrite scanner Top 10 ranking blindly. A candidate can remain highly ranked while its route is downgraded, or the route can be swapped if a better route has stronger evidence for that symbol and regime.

Exploration vs exploitation:

The engine should reserve most flow for proven cohorts while still allowing bounded exploration for under-sampled routes. Exploration must be capped and labeled so poor early results do not contaminate production confidence.

Avoiding overfitting:

- Require minimum sample tiers before using evidence.
- Use shrinkage toward route-level and global baselines.
- Keep regime buckets coarse until sample size justifies refinement.
- Separate recent drift warnings from permanent route verdicts.
- Never promote on one lucky cluster without downside checks.

Conceptual scoring:

`suitability = baselineRouteEdge + symbolDirectionAdjustment + regimeAdjustment + calibrationAgreement - costPenalty - instabilityPenalty`

Phase 2A implementation status:

Only the evidence foundation exists. No routing or route selection behavior uses the verdict yet.

## Phase 2A.5 Data Completeness Pass

Phase 2A.5 enriches the foundation without changing strategy behavior. It adds optional selection-time context fields, field completeness percentages, richer per-engine readiness reasons, and forward MAE/MFE tracking for filled shadow positions.

MAE/MFE are foundational because fixed stop floors cannot answer whether a stop was technically credible. Future stop/TP intelligence needs to know how far price moved favorably and adversely after entry, normalized in R, before it can distinguish normal setup noise from true invalidation.

Engines still remain blocked until enough forward records accumulate:

- Symbol-Route Suitability needs more watchable symbol-direction-route cohorts with complete trend and regime context.
- Adaptive Market Gates need broader market regime and source-alignment coverage, plus sentiment/fear-greed context before gate strictness can adapt.
- Technical Stop/TP Credibility needs high MAE/MFE coverage from newly closed shadow positions, plus stop distance, risk/reward, and close reason coverage.
- Universe Rotation needs enough symbol-level evidence and similarity fingerprint fields such as trend, volume, volatility, and regime.

Minimum forward data before Phase 2B should include at least several dozen newly resolved records with MAE/MFE populated, multiple route cohorts with 15+ closed samples, and materially improved trend/regime/source coverage. Until then, Phase 2B should remain read-only/advisory.

# 4. Component B - Adaptive Market Gate Controller

Market state model:

The gate controller should classify the current environment using market regime, BTC trend and dominance context, volatility state, liquidity/spread state, sentiment, whale behavior, and later macro/geopolitical shocks.

Dynamic gate types:

- Promotion thresholds.
- Route eligibility.
- Runner allowance.
- Symbol universe preference.
- Evidence collection strictness.

What should adapt:

- Required sample confidence in hostile regimes.
- Minimum calibrated expected R by volatility state.
- Runner allowance when trend and external intelligence align.
- Route mode strictness when whale or sentiment conflict rises.
- Symbol preference when a cohort performs well in the active regime.

What should not adapt automatically:

- Live execution mechanics.
- Hard risk caps.
- Emergency stop credibility guards.
- Exchange safety checks.
- Maximum trade caps.
- Any rule without enough labeled evidence.

Risk of overfitting:

Market regimes are sparse and can be mislabeled. The first adaptive gate should be advisory, then shadow-only, then eligible for limited live gating only after stable out-of-sample evidence.

# 5. Component C - Technical Stop/TP Credibility Engine

The current stop floor is an emergency credibility guard. It prevents obviously fragile trades, but it is not a long-term doctrine.

Future stop and TP credibility should be derived from technical invalidation:

- Swing structure.
- VWAP/EMA reclaim or loss.
- Support and resistance.
- ATR and wick noise bands.
- Recent MAE/MFE distribution.
- Forecast-conditioned adverse excursion.
- Expected retracement depth before continuation.

Noise band / ATR / wick noise:

The engine should estimate how much adverse movement is normal before a setup is invalidated. A stop inside routine noise should be marked structurally weak even if it passes a fixed bps floor.

Expected adverse excursion:

The engine should learn typical MAE before TP1 for each route and symbol-direction-regime cluster. If expected MAE frequently exceeds the proposed stop, the stop is not credible.

Forecast-conditioned stop:

Kronos forecast bands can eventually inform the adverse excursion estimate. If the forecast p25/p75 or forecast low/high routinely crosses the proposed stop before target, the plan needs review.

TP reachability:

TP credibility should use MFE, resistance/support proximity, forecast max/min, and route history. A TP that rarely becomes reachable should lower route suitability even if stop logic looks acceptable.

Replacement path:

The crude stop floor should remain until MAE/MFE and structural labels are reliably captured. Then it can become a backstop behind a technical credibility score.

# 6. Component D - Adaptive Universe Rotation

The symbol universe should eventually rotate based on performance fingerprints instead of staying permanently fixed.

Clusters:

- Exploitation cluster: symbols with proven positive evidence.
- Similarity expansion cluster: symbols whose liquidity, volatility, trend, spread, and route fingerprints resemble top cohorts.
- Exploration cluster: small bounded allocation for new or recovering symbols.

Rotation cadence:

Weekly review is a conservative starting point. Daily changes risk chasing noise. Emergency removal can happen sooner only for severe liquidity or execution degradation.

Similarity fingerprint features:

- Average spread and cost R.
- ATR percent and wick noise.
- Volume and liquidity stability.
- Trend persistence.
- Route-specific fill quality.
- TP1 reachability and SL rate.
- Kronos/whale alignment frequency.
- Regime-specific net R.

Admission/removal rules:

Admit symbols with adequate liquidity, acceptable spread, and similarity to profitable cohorts. Remove or downweight symbols with repeated toxic evidence, poor fills, or insufficient productive setups.

Protection against survivorship bias:

Keep records for removed symbols, preserve exploration cohorts, and compare new symbols against both winners and known losers. Do not train only on survivors.

# 7. Shared data architecture

`StrategyContextSnapshot` is the canonical selection-time snapshot. It captures identity, selected plan, expected value, scanner state, technical geometry, technical structure, and external intelligence. It is optional on historical shadow positions and can be reconstructed from older `ShadowPosition` records where possible.

`ResolvedTradeOutcomeSnapshot` is the canonical closed-trade outcome snapshot. It captures fill status, close reason, realized R, TP/SL flags, duration, costs, and win/loss label.

`StrategyExperienceRecord` joins one context snapshot to one resolved outcome. Only closed positions should become full experience records.

`StrategyEvidenceTable` aggregates experience records by symbol, direction, route, and regime. It provides sample tiers and conservative evidence verdicts for analysis only.

# 8. What must be implemented next, in what order

Phase 2B: Data completeness pass.

- Add MAE/MFE capture to shadow execution.
- Add actual exit price with stronger semantics.
- Persist richer scan-time context from tracker into shadow context when possible.
- Add BTC dominance and fear/greed only as nullable fields if reliable sources exist.

Phase 2C: Read-only Symbol-Route Suitability prototype.

- Use the evidence table to produce advisory route suitability scores.
- Add shrinkage and sample-tier guards.
- Keep it out of routing decisions.

Phase 2D: Shadow-only adaptive gate simulation.

- Simulate adaptive gate decisions against historical/shadow records.
- Compare static vs adaptive gates without changing live readiness.
- Add drift and overfit checks.

Phase 2E: Controlled promotion path.

- Allow limited advisory-to-decision use only for cohorts with stable evidence.
- Keep emergency guards and trade caps unchanged.
- Add rollback switches and report every adaptive override.

# 9. What should NOT be implemented yet

- Do not change scanner Top 10 ranking.
- Do not change opportunity, confidence, danger, or edge score formulas.
- Do not change route mode rules.
- Do not change ProfitRoutingAgent decisions.
- Do not change calibrated expectancy logic.
- Do not change ultra-tight-stop guard behavior.
- Do not change shadow entry/exit mechanics.
- Do not change live readiness gates.
- Do not change stop-loss or take-profit behavior.
- Do not change trade caps, live trading logic, or the symbol universe.
- Do not use evidence verdicts for routing yet.

# 10. Risks and open questions

Risks:

- Sparse samples can make toxic or promising labels unstable.
- Regime labels may be too coarse or too noisy.
- Historical records do not all contain the same context fields.
- MFE/MAE are currently missing, which blocks serious stop/TP intelligence.
- External data sources such as sentiment, fear/greed, dominance, and macro shocks can be unreliable.

Open questions:

- What minimum sample and confidence thresholds should permit advisory route suitability?
- Should regime state be global, symbol-specific, or both?
- How should the system handle symbols that are excellent only in rare regimes?
- What is the right exploration budget for new symbols and under-sampled routes?
- Which future fields deserve permanent persistence versus endpoint-only diagnostics?

# Phase 2B.1 — Symbol-Route Suitability Intelligence Engine (advisory)

Phase 2B.1 reuses the StrategyExperienceRecord stack built in Phase 2A and adds a
read-only advisory analyzer that, for each (symbol, direction, entryVariant,
exitVariant) cohort, scores how suitable that route currently looks against the
recorded outcomes. Output is consumed by humans only.

What was built:

- `apps/api/src/lib/symbol-route-suitability.ts` — engine. Exports
  `buildSymbolRouteSuitabilityReport(records, opts?)` and supporting types.
- `apps/api/test/symbol-route-suitability.test.ts` — 15 unit tests covering
  grouping, sample-tier boundaries, verdict transitions, suitability-score
  weighting, symbol-direction summarization, route heterogeneity classification,
  evidence-era filtering, metadata thresholds, and the empty-input safety case.
- `GET /api/shadow/symbol-route-suitability?era=POST_CALIBRATION|ALL_TIME` —
  endpoint registered in `apps/api/src/routes/shadow.ts`. Default era is
  POST_CALIBRATION.
- "Symbol-Route Suitability Intelligence" panel in `apps/web/src/App.tsx`,
  rendered immediately after the existing Strategy Intelligence Foundation panel.

Why symbol-direction-specificity matters:

A single route combo (e.g. `vwap_retest_entry + tp1_full_exit`) can behave very
differently per symbol and per direction — BTC may reward it on LONG while ETH
punishes it. Aggregating across symbols hides these effects. The
SYMBOL_SENSITIVE heterogeneity verdict makes that explicitly visible so future
phases can either restrict route eligibility per symbol or boost exploration on
underweighted ones.

Why it is advisory-only in 2B.1:

- Sample sizes per cohort are still small. The full bot has only a few cohorts
  approaching 30 closes today.
- Verdicts at EARLY (5–14) or WATCHABLE (15–29) tiers are directional, not
  confirmatory.
- Route ranking is the single most load-bearing piece of behaviour; any change
  must be evaluated against route-maturity, regime-drift, expectation calibration,
  and stop-geometry corroboration, none of which is automated yet.
- The readiness block emits `readyForRoutingInfluence: false` deterministically
  for this phase, regardless of sample size.

Explicit promotion conditions for Phase 2B.2 (NOT IMPLEMENTED):

Before any routing influence from this engine can ship, the data must clear ALL
of the following:

1. ≥30 closes per (symbol, direction, route) cohort being considered.
2. Cohort `netAvgR > 0.15` AND `profitFactor > 1.2`.
3. Tolerable `slRate` (target: below 0.40 in the cohort's stop-distance regime).
4. Stable recent performance — the most-recent rolling slice must not contradict
   the aggregate verdict.
5. Not contradicted by market-regime evidence — the regime-drift and
   regime-sensitive evidence rows must not show that the cohort's edge is regime
   conditional in a way the engine does not yet observe.

Phase 2B.2 (NOT implemented) would consume the suitability output to:

- Soft-bias routeMode selection toward the per-symbol best advisory route when
  the cohort is EVALUABLE_PROMISING and corroborating signals agree.
- Down-weight cohorts flagged EVALUABLE_TOXIC.
- Increase exploration for under-sampled symbol-route combinations.
- Feed the heterogeneity verdict into the universe-rotation and route-eligibility
  layers.

None of those behaviours are wired up. Phase 2B.1 strictly adds visibility.

# Phase 2C.1 - Adaptive Gate Controller Intelligence (advisory)

Phase 2C.1 adds a read-only intelligence layer for gate-like market context. It
uses `StrategyExperienceRecord` as its only learning input and compares resolved
trade outcomes against the current POST_CALIBRATION baseline across market
regime, Kronos alignment, Whale alignment, horizon conflict, inferred source
conflict, directional alignment, sentiment bucket, and fear/greed bucket when
those fields are present.

What was implemented:

- `apps/api/src/lib/adaptive-gate-intelligence.ts` builds an
  `AdaptiveGateIntelligenceReport` with baseline metrics, context coverage,
  dimension summaries, supportive and harmful condition assessments, a small
  interaction analysis set, future patch hypotheses, and an advisory-only
  readiness block.
- `GET /api/shadow/adaptive-gate-intelligence?era=POST_CALIBRATION|ALL_TIME`
  exposes the report. The default era is POST_CALIBRATION.
- The Performance page renders an "Adaptive Gate Controller Intelligence" panel
  after Symbol-Route Suitability Intelligence.
- Patch hypotheses are explicitly not behavior. Every hypothesis carries
  `doesNotImplementNow: true`, and `readyForGateInfluence` remains false.

This layer does not change scanner ranking, route selection, route mode,
promotion thresholds, ProfitRoutingAgent behavior, calibration, stop/TP logic,
fill or close mechanics, live readiness, trade caps, execution, or the symbol
universe.

Future Phase 2C.2 may only consider influence after all of the following are
true:

- At least 30 closes exist in the context bucket or interaction being considered.
- The condition shows consistent benefit or harm versus baseline on netAvgR,
  profit factor, and stop-loss rate.
- The finding does not contradict Symbol-Route Suitability evidence for the
  same symbol-direction-route cohorts.
- The effect remains stable across recent time slices, not just all-time
  aggregation.
- The signal is robust to market-regime drift and does not depend on sparse or
  unreliable external fields.

Until those conditions are met, the correct use of this engine is audit and data
collection: identify which market-context fields are missing, which interactions
deserve deeper review, and which proposed adaptive gates should stay on watch.

# Phase 2C.1.5 - Evidence Completeness and Regime Policy Counterfactuals

Phase 2C.1 surfaced a sharp asymmetry: market-regime coverage was complete in
resolved POST_CALIBRATION experiences, while Kronos alignment, Whale alignment,
horizon conflict, sentiment, and fear/greed all showed 0% resolved coverage.
That required diagnosis before any adaptive gate discussion could stay honest.

What Phase 2C.1.5 adds:

- Coverage provenance for adaptive-gate fields so the dashboard can distinguish
  between old resolved records that predate Phase 2A.5 snapshots and genuine
  forwarding failures.
- A read-only regime policy counterfactual simulator that estimates what
  historical POST_CALIBRATION performance would have looked like under simple
  regime-aware filtering policies.

Current diagnosis intent:

- If a field is present in current strategy snapshots but 0% in resolved
  experiences because no newer snapshot-backed positions have closed yet, the
  correct verdict is data-lag, not mapping failure.
- If a field is present on resolved snapshot-backed positions but disappears by
  the time the adaptive-gate engine reads the experience rows, that is a true
  non-behavioral mapping gap and should be fixed.
- Fear/greed remains special: the social provider can emit a fear/greed-flavored
  reason string, but the current Candidate and SentimentSignal pipeline does not
  yet expose structured `fearGreedValue` or `fearGreedBucket` fields.

What the regime simulator does:

- Recomputes baseline POST_CALIBRATION performance.
- Simulates a small fixed set of regime-aware include/exclude policies.
- Measures changes in netAvgR, profit factor, stop-loss rate, and remaining
  sample size.
- Emits policy hypotheses for deeper audit only.

Why it remains advisory-only:

- Counterfactual improvement is not deployment evidence.
- The simulator cannot prove causal uplift, only cohort separation.
- Regime-only filtering can conflict with symbol-route suitability, sample-size
  stability, or future multi-factor gate evidence.

Before Phase 2C.2 gate influence becomes justifiable, we still need:

- Enough resolved snapshot-backed records carrying Kronos, Whale, horizon
  conflict, and sentiment fields.
- Stable regime effects across recent slices, not only aggregate all-time
  buckets.
- No contradiction with Symbol-Route Suitability for the same
  symbol-direction-route slices.
- Evidence that candidate improvements remain meaningful after sample shrinkage,
  not just after excluding hard periods in hindsight.

# Phase 2C.2 - Adaptive Regime Gate Shadow Overlay

Phase 2C.2 exists to bridge historical counterfactuals and future gate
decisions. Historical studies can tell us which regime-aware policies look
promising in hindsight, but they cannot prove that those same policies improve
future results when applied prospectively to newly selected candidates.

This phase therefore adds a forward-only advisory overlay:

- Every new strategy context snapshot is evaluated against a small fixed set of
  regime-aware policies.
- The overlay verdicts are persisted with the selection-time strategy context.
- Later, resolved overlay-tagged trades are compared by policy:
  included vs excluded vs insufficient-context.

Tracked policies in Phase 2C.2:

- `EXCLUDE_BULLISH_EXPANSION_V1`
- `KEEP_ONLY_BEARISH_EXPANSION_AND_SHORT_V1`
- `EXCLUDE_BULLISH_EXPANSION_LONG_V1`

Why it is still advisory:

- The overlay does not block, demote, promote, reroute, or alter execution.
- It only measures whether the historical counterfactual direction reproduces in
  forward shadow outcomes.
- Legacy resolved trades that predate overlay persistence are deliberately not
  treated as forward overlay evidence.

Historical counterfactual vs forward overlay:

- Historical counterfactual:
  recompute old outcomes under hypothetical include/exclude policies.
- Forward overlay:
  tag new candidates at selection time, then later compare realized outcomes of
  the tagged included and excluded cohorts.

Only after all of the following should behavior influence be discussed later:

- At least 30 resolved overlay-tagged records for the policy under review.
- The included cohort materially outperforms the excluded cohort.
- The forward result matches the historical counterfactual direction.
- Symbol-route suitability does not contradict the policy.
- No regime-drift or instability warning undermines the result.

Phase 2C.2 does not implement any of that influence. It only creates the
forward evidence trail needed for that conversation.

# Phase 2D.1 — Technical Stop/TP Credibility Intelligence

## Why fixed stop floors are only temporary emergency guards

The ultra-tight stop floor (e.g., excluding stops <175 bps) is a blunt
emergency guard derived from historical stop-bucket aggregate analysis. It
prevents the most structurally damaging geometry from executing, but it is not
a technically informed stop placement strategy. The floor does not consider:

- How much adverse excursion a particular route typically requires before a
  trade resolves as a winner.
- How much favorable excursion losing trades show before they fail.
- Whether the TP1 level captures a reasonable share of the available favorable
  path, or whether the market consistently extends well past TP1 on winners.
- Whether different symbol-direction combinations have materially different path
  behavior requiring different stop and TP geometry.

The long-term vision is that stop placement should be informed by realized
technical invalidation levels — the actual path behavior of winning and losing
trades — rather than a static bps floor. Take-profit placement should be
informed by realized MFE distributions. But before any behavior change, the
system must be able to measure whether current geometry is technically credible.

## What the Phase 2D.1 engine measures

Phase 2D.1 builds a read-only advisory analytical engine (Technical Stop/TP
Credibility Intelligence) that answers:

1. How much adverse excursion do winning trades typically survive before winning?
   (Stop Survival Profile — winner MAE distribution)

2. How much favorable excursion do losing trades show before failing?
   (Favorable Excursion Profile — loser MFE distribution)

3. When winners win, what share of available favorable movement does current TP
   geometry actually capture?
   (TP Capture Efficiency Profile — MFE vs realized gross R ratio)

4. Which routes and symbol-direction slices show elevated stop stress, missed
   favorable excursion, or TP capture inefficiency?
   (Route-level and symbol-direction-route assessments)

5. Is there enough realized path data to make any of these conclusions
   meaningful yet?
   (Path coverage and readiness object)

## MAE/MFE path data is foundational

Each of the above questions requires forward-captured MAE/MFE data — the
maximum adverse excursion in R units and maximum favorable excursion in R units
measured from entry during shadow execution. This data:

- Is already being tracked by the shadow engine per position.
- Is persisted into ResolvedTradeOutcomeSnapshot as maeR, mfeR,
  maxAdverseExcursionR, maxFavorableExcursionR, and realizedPathAvailable.
- Is currently sparse because MAE/MFE tracking was added in Phase 2A.5 and
  legacy positions lack it.

The engine counts records as path-available only when realizedPathAvailable is
true OR both maeR and mfeR are finite and present. It never fabricates or
estimates MAE/MFE for legacy records without path data.

## Why the engine remains advisory-only

The engine is read-only and does not influence any behavior. Specifically, it
must NOT change:

- Stop-loss price calculation or placement.
- TP1, TP2, TP3 price calculation or placement.
- Route selection or routeMode decisions.
- Scanner ranking, Top 10 selection, or candidate visibility.
- Adaptive gate logic or overlay policy.
- Live readiness gates or ultra-tight stop guard behavior.
- Fill rules, close rules, or shadow execution mechanics.
- Trade caps, universe, or any live trading behavior.

The engine outputs verdicts (INSUFFICIENT_PATH_DATA, WINNERS_REQUIRE_BREATHING_ROOM,
LOSERS_SHOW_MISSED_FAVORABLE_EXCURSION, TP_CAPTURE_LOOKS_CONSERVATIVE, etc.)
and patch hypotheses with patchStatus WATCH or AUDIT_DEEPER. All patch
hypotheses carry doesNotImplementNow: true. readyForBehaviorInfluence is always
false.

The reasons for remaining advisory-only:

- Path coverage is far below the 80% threshold needed for behavior decisions.
- Route-level path samples are below the 30-record minimum for stable conclusions.
- MAE/MFE profiles are noisy at low sample sizes — early readings can shift
  dramatically as more forward data accumulates.
- No cross-route stability has been established yet.

## What Phase 2D.2 would do later (not implemented)

Phase 2D.2 (not yet built) would investigate, once path coverage matures:

1. Route-specific technical invalidation candidates: deriving stop levels from
   the observed winner MAE distribution rather than a static bps floor. For
   example, if 80% of winners on a given route survive at most 0.40R adverse
   excursion, a stop placed at -(0.50R) would provide sufficient breathing room
   without excessive capital exposure.

2. TP capture alternatives calibrated to realized MFE distributions: if winners
   on a route consistently have MFE 2× realized gross R, there may be an
   opportunity to trail TP or use a partial exit strategy that captures more of
   the available favorable path.

3. A realized-path counterfactual simulator: comparing the historical outcome
   distribution under fixed bps floor stops vs technically-calibrated stops
   derived from the path data, analogous to the regime policy counterfactual
   simulator in Phase 2C.1.

4. Symbol-direction-specific geometry: different symbols and directions may
   require different stop breathing room and TP placement. Phase 2D.2 would
   model these independently once per-slice path samples are large enough.

None of Phase 2D.2 has been implemented. Behavior influence from Phase 2D.1 or
2D.2 requires at minimum:

- At least 50 path-available resolved records per route under evaluation.
- MAE/MFE path coverage ≥ 80% of resolved experience records.
- Stable route-level path profiles across at least two non-overlapping time
  windows.
- No contradiction with symbol-route suitability, regime gate analysis, or
  live readiness logic.
- Human review and explicit operator approval before any stop or TP placement
  logic is changed.

---

# Phase 2E.1 — Adaptive Universe Rotation Intelligence (Implemented)

## Why universe rotation intelligence is needed

The bot currently operates on a fixed symbol universe. The question of *which symbols to observe* is answered once at setup time and never revisited. As shadow execution accumulates resolved experience, certain symbols will show consistent patterns — some contribute reliably to positive outcomes, others drag performance regardless of route or regime conditions. Without a structured way to measure this, the operator has no evidence-based lens for asking whether the current universe is optimal.

Phase 2E.1 builds the measurement layer. It analyzes, from resolved `StrategyExperienceRecord` history, which symbols contribute most positively or negatively, classifies symbols for rotation pressure vs core observation status, and extracts promising and toxic fingerprints. It is permanently advisory-only: it does not change the symbol universe, scanner ranking, routing, execution logic, gates, caps, stop/TP behavior, or live readiness.

## What the engine measures

### Symbol-level assessments

For each symbol in the resolved experience history, the engine computes:

- **Core performance stats**: closedCount, netAvgR, grossAvgR, profitFactor, winRate, slRate, tp1ProfitableRate, avgWinR, avgLossR.
- **Sample tier**: EMPTY (0 closes), TOO_EARLY (1–4), EARLY (5–14), WATCHABLE (15–29), EVALUABLE (30+). Consistent with all other Phase 2 engines.
- **Rotation pressure score** (0–100): 0 = no pressure (excellent performance); 100 = maximum pressure (terrible performance). Computed from netAvgR, profit factor, and SL rate, then blended toward neutral (50) proportional to the sample weight for the tier. A score above 50 indicates above-average drag; below 50 indicates above-average contribution.
- **Rotation pressure level**: LOW / MODERATE / HIGH. EMPTY and TOO_EARLY tiers are always LOW. EARLY tier can reach MODERATE but never HIGH. HIGH requires WATCHABLE or EVALUABLE tier (≥15 closes) with strongly negative performance.
- **Verdict**: from the rotation pressure ladder:
  - INSUFFICIENT_EVIDENCE: count < 5 or no netAvgR available.
  - EARLY_PROMISING: 5–14 closes, netAvgR > 0.10, PF > 1.0.
  - EARLY_DRAG: 5–14 closes, netAvgR < -0.10 or SL rate > 60%.
  - WATCHABLE_PROMISING: 15–29 closes, netAvgR > 0.15, PF > 1.2, SL < 40%.
  - WATCHABLE_DRAG: 15–29 closes, netAvgR < -0.15 or PF < 0.5.
  - TOXIC_PRESSURE: 30+ closes, netAvgR < -0.15 or PF < 0.5.
  - MIXED: everything in between.

### Symbol-direction assessments

The same metrics and verdict ladder are computed per (symbol, direction) pair. This allows the engine to detect direction-specific drag — e.g., a symbol where LONG trades are promising but SHORT trades are a persistent drag.

### Universe contribution summary

An aggregate view of the entire observed universe:

- Overall netAvgR and profit factor across all resolved records.
- Count of symbols contributing positively vs negatively (among those with ≥5 closes).
- Top contributor (highest netAvgR with ≥5 closes) and worst contributor (lowest netAvgR with ≥5 closes).
- Counts of symbols above and below the overall universe average.

### Core observation candidates and rotation pressure candidates

- **Core observation candidates**: symbols with verdict EARLY_PROMISING or WATCHABLE_PROMISING, sorted by netAvgR descending, capped at 5.
- **Rotation pressure candidates**: symbols with verdict EARLY_DRAG, WATCHABLE_DRAG, or TOXIC_PRESSURE, sorted by rotation pressure score descending, capped at 5.

### Promising and toxic fingerprints

Fingerprints are extracted from symbol-direction combinations with ≥5 closes and a netAvgR signal above +0.10 (promising) or below -0.10 (toxic). Each fingerprint records:

- Pattern description (e.g., "LONG trades on AAPL show sustained positive R contribution").
- Example symbol, direction, netAvgR, and sample count.
- Confidence: LOW for samples below EVALUABLE (30+ closes), MEDIUM at EVALUABLE. Confidence never reaches HIGH in Phase 2E.1 — that would require corroboration from cross-engine evidence, external validation, and operator review.

### Patch hypotheses

The engine generates advisory patch hypotheses when the data suggests a concern worth tracking. All hypotheses are strictly non-actionable in Phase 2E.1:

- `doesNotImplementNow: true` on every hypothesis, always.
- `patchStatus`: WATCH or AUDIT_DEEPER only. No hypothesis reaches READY_FOR_PATCH_DISCUSSION.

Hypothesis triggers:
1. A symbol with TOXIC_PRESSURE verdict → `AUDIT_TOXIC_SYMBOL_DEEPER` (AUDIT_DEEPER status).
2. A WATCHABLE_DRAG symbol approaching threshold → `AUDIT_TOXIC_SYMBOL_DEEPER` (WATCH status).
3. Direction-specific divergence on a symbol (one direction promising, other dragging) → `AUDIT_DIRECTION_SPECIFIC_DRAG` (WATCH status).
4. A promising symbol worth accumulating evidence on → `WATCH_PROMISING_SYMBOL_ACCUMULATE` (WATCH status).
5. Fallback: `NO_ACTION_YET` when no specific pattern is detected.

### Readiness

The readiness block carries two permanent invariants:

- `readyForUniverseInfluence: false` — always. The engine never modifies the symbol universe.
- `readyForExternalCandidateSearch: false` — always. External discovery of new symbols (applying fingerprints to unknown symbols) is reserved for Phase 2E.2.

`advisoryEngineReady` reflects whether the engine has any symbol data to analyze. It becomes `true` as soon as at least one symbol has resolved experience records.

## What Phase 2E.1 does NOT do

Phase 2E.1 is strictly measurement. It does not:

- Remove or add any symbol to the observed universe.
- Change scanner ranking, Top-10 selection, or opportunity/confidence/danger scoring.
- Influence routeMode decisions, variant selection, or shadow fill/close/cost logic.
- Change stop or TP geometry.
- Modify live readiness, symbol quarantine, or trade caps.
- Search for external symbol candidates.

## Why this remains advisory despite the data

Symbol-level performance patterns at 5–30 closes are early-stage signals. A symbol can show negative netAvgR for reasons unrelated to the symbol itself: adverse regime conditions during the measurement window, route-specific issues that would appear in any symbol, or simply variance at small sample sizes. Before any universe rotation recommendation could be justified, the engine would need:

- ≥30 closes per symbol with stable, non-regime-confounded performance.
- Corroboration from the adaptive gate and symbol-route suitability engines that the drag is not regime-specific or route-specific.
- Evidence that the TOXIC_PRESSURE verdict is stable across non-overlapping time windows.
- Human review and explicit operator approval.

None of these conditions can be satisfied in Phase 2E.1 given current sample sizes.

## What Phase 2E.2 would add (not implemented)

Phase 2E.2 (not yet built) would extend Phase 2E.1 with:

1. **Dynamic universe boundary recommendations**: using the TOXIC_PRESSURE evidence from Phase 2E.1 plus corroboration from gate and suitability engines, compute a structured operator recommendation for removing a symbol from the observation universe.
2. **External candidate discovery**: using promising fingerprints (direction, route, regime context) as search templates, identify new symbols that match the behavioral pattern. This is what `readyForExternalCandidateSearch` guards.
3. **Route-specific fingerprint transfer**: if a promising fingerprint (e.g., LONG on large-cap tech during BULLISH regime with conservative route) is confirmed at EVALUABLE sample, apply it as a hypothesis template for new symbol candidates.

All of Phase 2E.2 requires ≥30 closes per symbol across ≥5 symbols, stable cross-engine corroboration, and operator review. It has not been implemented.

---

# Phase 2E.2 — External Candidate Discovery Intelligence (Implemented)

## Why current-universe rotation pressure is not enough

Phase 2E.1 measures only what is already inside the active universe. It can identify which observed symbols are dragging or contributing, but it has no view of the broader tradable market. If the bot's current 20-symbol universe contains a high concentration of poor performers, Phase 2E.1 will produce TOXIC_PRESSURE verdicts but cannot answer the obvious next question: *what should replace them?*

Phase 2E.2 is the first external discovery layer. It does not rotate the universe. It produces an advisory shortlist of tradable symbols outside the current universe that may be worth observing later, ranked by their structural similarity to the promising patterns identified by Phase 2E.1.

## Why broader external discovery matters

A universe rotation system that only knows the current universe is structurally incapable of expanding the symbol set. To make rotation possible at all, the engine needs:

1. Visibility into a broader tradable candidate pool.
2. Filters that distinguish tradable instruments from low-quality noise.
3. A way to score external candidates against patterns the bot has actually learned from.
4. A clear record of what was rejected and why.

Phase 2E.2 implements all four — read-only and advisory.

## How external candidates are filtered for tradability

Phase 2E.2 pulls metadata from Binance spot exchange-info, the 24h ticker endpoint, and the book ticker endpoint. The fetcher caches the snapshot in-process for 5 minutes to avoid hammering the exchange.

Each candidate is classified by `classifyTradability`:

- `CURRENT_UNIVERSE_MEMBER` — symbol is already observed. Excluded from external shortlist; surfaced for transparency.
- `NOT_SUPPORTED_INSTRUMENT` — non-USDT quote, or non-SPOT/PERPETUAL instrument type.
- `STATUS_NOT_TRADING` — exchange marks the symbol as halted, suspended, or otherwise inactive.
- `DATA_INCOMPLETE` — required fields (latest price, 24h volume) are missing.
- `LOW_LIQUIDITY` — 24h quote volume below $10M USDT (advisory floor).
- `EXCESSIVE_SPREAD` — bid/ask spread above 10 bps.
- `TRADABLE` — passes all gates.

These thresholds are conservative and intentionally do NOT match live scanner gates. They exist only to prevent the discovery shortlist from being dominated by illiquid or wide-spread instruments.

## How discovery similarity scoring works

For tradable external candidates, the engine computes three scores:

- **promisingSimilarityScore** (0-100): rewards healthy 24h liquidity tier ($50M-$500M), tight spread (≤5 bps), moderate 24h volatility (1%-15%), and normal funding (|funding| ≤ 0.05%). Baseline is 50.
- **toxicSimilarityPenalty** (0-100): penalizes extreme 24h volatility (>30%), wide spread (>15 bps), marginal liquidity ($10M-$20M), extreme funding (>0.15%), missing metadata, and direct symbol overlap with current toxic fingerprints.
- **netDiscoveryScore** = `clamp(promisingSimilarityScore - toxicSimilarityPenalty × 0.5, 0, 100)`.

Tier classification:

- ≥70 → `EXPLORATORY_SHORTLIST`
- 50-69 → `WATCHLIST_ONLY`
- 30-49 → `LOW_PRIORITY`
- <30 → `REJECTED`

**Honest limitation:** because external candidates have no bot-specific shadow outcome history, similarity is METADATA-ONLY. The engine cannot evaluate route-level setup features (entry trigger geometry, regime context, ATR profile) for external symbols with the existing data pipeline. The `IMPROVE_EXTERNAL_FEATURE_CAPTURE` patch hypothesis names this as the next data-engineering investment.

## How promising and toxic fingerprints are reused

Phase 2E.2 consumes the `promisingFingerprints` and `toxicFingerprints` arrays produced by `buildUniverseRotationIntelligenceReport` (Phase 2E.1). It does not recompute fingerprint logic. The `discoveryFingerprintBasis` block surfaces the highest confidence level among current fingerprints, the count, and an explicit maturity warning. While fingerprints remain LOW confidence (sample <30 closes per symbol-direction), the engine refuses to elevate `discoveryReadiness.confidence` above LOW.

## Why shortlisted candidates are NOT added to the active universe

The engine carries permanent invariants:

- `readyForUniverseExpansionInfluence: false` — always.
- `readyForRotationShadowOverlay: false` — always; reserved for Phase 2E.3.
- All patch hypotheses carry `doesNotImplementNow: true`.
- `patchStatus` is restricted to `WATCH` or `AUDIT_DEEPER`. `READY_FOR_PATCH_DISCUSSION` is unreachable in Phase 2E.2.

Including a symbol in the shortlist is a hint for human review only. It is not a recommendation to trade, observe, or scan.

## What Phase 2E.3 needed next from the Phase 2E.2 perspective

From the original Phase 2E.2 perspective, Phase 2E.3 — Rotation Shadow Overlay — needed to:

1. Take the shortlisted external candidates from Phase 2E.2 and prospectively observe them in parallel with the active universe (read-only, shadow-style).
2. Build per-candidate prospective performance tracking to measure whether discovery scoring actually identifies useful future additions.
3. Compare cohorts: shortlisted vs rejected vs neutral candidates, to validate discovery skill.
4. Surface a Phase 2E.3 readiness metric that becomes `true` only after the overlay accumulates statistically meaningful prospective evidence (≥30 closes per shortlist symbol).

This has since been implemented as the advisory-only Phase 2E.3 external rotation shadow overlay described below. Phase 2E.2's own readiness fields still remain behavior-safe and do not add symbols to the active universe.

## What Phase 2E.4 would do much later (not implemented)

Phase 2E.4 — Controlled Universe Influence — would be the earliest point where evidence from Phase 2E.3 could justify actual changes to the active universe. Prerequisites:

- Mature Phase 2E.3 overlay evidence on a meaningful number of candidates.
- Cross-engine corroboration with Phase 2B.1 (symbol-route suitability), Phase 2C.1 (regime policy counterfactual), and Phase 2D.1 (technical stop/TP credibility).
- Stable promising fingerprints at MEDIUM or HIGH confidence in Phase 2E.1.
- Explicit operator approval for each universe change.

Phase 2E.4 is intentionally far in the future. Phase 2E.2 makes the path possible without taking any step toward it.

# Phase 2E.2.5 - External Strategy-Fit Enrichment Intelligence

Phase 2E.2 proved that the bot can discover external symbols with healthy tradability metadata, but metadata-only discovery is not enough to justify a future rotation candidate. Liquidity, spread, and volatility can identify symbols that are tradable; they cannot prove that the symbol currently resembles the bot's actual setup structure, route geometry, directional context, or stop/TP expectations.

Phase 2E.2.5 adds a read-only strategy-fit enrichment layer over the Phase 2E.2 shortlist. It evaluates only the compact discovery shortlist, not the full external market, and it reuses the existing shared scanner candidate builder plus shared variant-selection helper in a detached mode. The output is explicitly a detached strategy-fit hypothesis: it is not normal scanner output, is not persisted as a scanner candidate, cannot open shadow positions, and cannot modify ranking, routing, gates, or the active universe.

The enrichment separates metadata discovery score from strategy-fit score. Metadata remains a light prior, while the strategy-fit score emphasizes setup/route compatibility, direction/regime compatibility, and stop/TP geometry credibility. A liquid symbol can therefore fail enrichment when it has weak direction, no recognizable setup, contradictory regime context, or fragile hypothetical stop geometry.

This phase remains advisory only. It can identify which external discovery candidates deserve deeper observation, but it does not justify universe rotation. Phase 2E.3 now adds a Rotation Shadow Overlay that prospectively monitors enriched external candidates alongside metadata-only shortlist candidates and low-fit controls. Only after that forward evidence matures can the system compare whether strategy-fit enrichment has predictive value.

# Phase 2E.3 - External Rotation Shadow Overlay

Phase 2E.3 adds the first prospective external-universe validation layer. Phase 2E.2 can find tradable external symbols, and Phase 2E.2.5 can reorder that shortlist by detached strategy fit, but neither layer proves that those symbols actually perform better after selection. The external rotation shadow overlay exists to collect that proof without touching the active scanner universe.

The overlay tracks isolated research observations in a separate data store, not in normal `ShadowPosition` storage. This keeps external observations out of route maturity, live readiness, current-era shadow performance, scanner ranking, and all active trading analytics. Observations are selected from the top strategy-fit shortlist, the top metadata-only discovery baseline, and a small low-fit control cohort when available. Symbols may belong to multiple cohorts, so the model supports multi-group membership rather than duplicating the same symbol blindly.

Each observation persists an immutable selection snapshot: symbol, source discovery score, strategy-fit score/tier, detached entry/exit route hypothesis, direction, inferred regime, stop/TP geometry hints, selection batch id, and policy version. Duplicate suppression prevents repeated observations for the same symbol, direction, route hypothesis, and group set within the configured observation window.

Outcome resolution is research-only. It uses 5m candle progression, fills at the detached entry reference, applies conservative stop-first handling when TP/SL are touched in the same candle, and expires observations after the overlay window. This is deliberately isolated from active shadow execution and is labeled as comparable research evidence, not live trading semantics.

Phase 2E.3 still does not justify universe rotation. A later Phase 2E.4 discussion would require at least 30 resolved overlay observations in a group, material strategy-fit outperformance versus the metadata baseline, enough unique symbols to avoid one-symbol luck, agreement with symbol-route suitability evidence, and explicit operator approval before any controlled universe influence is considered.

# Phase 2F - Adaptive Profit Policy Engine

Phase 2F converts the existing Phase 2 intelligence stack into a shadow-only policy synthesis layer. Instead of adding another passive audit, it ranks actionable candidate lanes from already-available evidence while keeping `CORE` and `EXTERNAL_OVERLAY` evidence distinct. The engine evaluates LONG and SHORT under the same rules across regime, route, exit policy, and symbol scope so the system can currently prefer a SHORT lane when evidence warrants it without becoming structurally short-only.

The report exposes:

- ranked candidate policies with credibility, blockers, and verdicts;
- best LONG and SHORT lanes separately;
- an evidence-led adaptive direction posture (`SHORT_BIAS`, `LONG_BIAS`, `SPLIT_BY_REGIME`, or `NO_EDGE_YET`);
- advisory exploit-shadow collection priorities;
- lane-specific micro-pilot readiness that remains separate from whole-bot live readiness.

Phase 2F remains advisory only. It does not alter scanner ranking, route selection, route mode, overlay resolver behavior, execution, or live readiness. External Rotation Overlay evidence remains valid-post-fix V2 only and is surfaced as its own research lane rather than blended into core route evidence.

A future behavior-influence phase would still require mature, clean, direction-specific evidence: enough valid samples, positive net economics after costs, stable route/regime behavior, no contamination, and corroboration from symbol-route and forward overlay layers. Until then, exploit-shadow priority is an operator-facing research label, not an execution control.
