"""V8 bounded-job worker. Start FAST and COACHING in separate host processes.

The host owns scanning, event admission, prospective assignment and protection.
This module never starts a scan, advances an experiment, or executes an exchange
order. The incumbent engine and its final gateway contract remain authoritative.
"""
import hermes_learner
import argparse
import copy
import candidate_disposition as DISPOSITION
import fcntl
import hashlib
import importlib
import json
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import astra_decisions as AD
import astra_fast_v8 as FAST
import astra_models_v8 as MODELS
import hermes_model_policy_v1 as ROUTER
import astra_replan_v2 as REPLAN
from astra_canonical_v8 import (AXES as CANONICAL_AXES, CanonicalBook, canonical_evidence,
                               needs_review, coaching_support, PROCEDURAL_CHECKS, SUPPORT_FIELDS,
                               _hash as _canonical_hash)

FAST_TRADING = "FAST_TRADING"
COACHING = "COACHING"
DEEP_REVIEW = 'DEEP_REVIEW'
REVIEW_MODES = (COACHING, DEEP_REVIEW)
AUDIT_REASONS = ('CONFLICTING_LESSONS', 'ROOT_CAUSE_AUDIT', 'STRATEGY_REDESIGN', 'MULTI_TRADE_ANOMALY')
# Model routing changes who decides, so it opens its own cohort. The previous
# cohort is sealed and kept: no lesson, trade or phase is reset or deleted.
COHORT = REPLAN.COHORT
MODEL = 'claude-sonnet-5'
MAX_TURNS = 12
# PlanBook.create demands a market row under 120s old. Refresh with margin: the fetch
# itself takes time, and a row that ages out between refresh and validation would fail
# the very gate this exists to satisfy.
ROW_REFRESH_AFTER_MS = 45000
BUDGET_SECONDS = {FAST_TRADING: 240, COACHING: 240, DEEP_REVIEW: 240}
ALLOWLIST = frozenset(("astra_context", "astra_enter", "astra_plan", "astra_decide",
                       "astra_learn", "astra_experiment", "memory"))
POSITION_ACTIONS = frozenset(("HOLD", "TAKE_PROFIT", "CUT_LOSS"))
PROCESS_LOCK = threading.Lock()


def clone(value):
    return json.loads(json.dumps(value, allow_nan=False))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def now_ms():
    return int(time.time() * 1000)


def elapsed(start, end):
    return end - start if (isinstance(start, (int, float)) and not isinstance(start, bool)
                          and isinstance(end, (int, float)) and not isinstance(end, bool)
                          and end >= start) else None


def require_fields(value, fields, label):
    """Name the missing field instead of raising a bare KeyError.

    `args["review"]["id"]` on an absent key surfaced to the model as the string `'id'`,
    which is indistinguishable from noise. Every COACHING cycle in the lane's history
    died retrying against errors like that.
    """
    if not isinstance(value, dict):
        raise ValueError(label + " must be an object with: " + ", ".join(fields))
    missing = [f for f in fields if value.get(f) in (None, "", [], {})]
    if missing:
        raise ValueError(label + " is missing required field(s): " + ", ".join(missing)
                         + ". Required: " + ", ".join(fields))
    return value


def explain_review_body(body):
    """Say exactly which keys are wrong, before the validator's summary message.

    The validator rejects ANY key outside the permitted set, so a helpfully-added extra
    field fails with the same sentence as a missing one. That is what the model could
    not see: it reported all named fields present and was still refused.
    """
    required = ("axes", "observedMechanism", "requiredAction", "exceptions")
    if not isinstance(body, dict):
        raise ValueError("review.body must be an object with: " + ", ".join(required))
    missing = [k for k in required if k not in body]
    extra = sorted(set(body) - set(required) - {"outcomeClassification"})
    problems = []
    if missing:
        problems.append("missing " + ", ".join(missing))
    if extra:
        problems.append("remove these keys, they are not permitted: " + ", ".join(extra))
    axes = body.get("axes")
    if isinstance(axes, dict):
        axes_missing = [a for a in CANONICAL_AXES if a not in axes]
        axes_extra = sorted(set(axes) - set(CANONICAL_AXES))
        if axes_missing:
            problems.append("axes missing " + ", ".join(axes_missing))
        if axes_extra:
            problems.append("axes has unknown keys " + ", ".join(axes_extra))
        blank = sorted(k for k, v in axes.items() if not isinstance(v, str) or not v.strip())
        if blank:
            problems.append("axes values must be non-empty strings: " + ", ".join(blank))
    elif "axes" in body:
        problems.append("axes must be an object keyed by exactly: " + ", ".join(CANONICAL_AXES))
    if problems:
        raise ValueError("review.body rejected -> " + "; ".join(problems)
                         + ". Permitted keys: " + ", ".join(required)
                         + ", outcomeClassification (optional).")
    return body


class IntegrationError(RuntimeError):
    """Required host/module contract is absent; never substitute invented data."""


class Journal:
    """Append-only V8 facts. A torn/corrupt line fails closed; history is not reset."""
    def __init__(self, root, mode):
        self.path = Path(root) / "logs" / ("astra-v8-" + mode.lower() + ".jsonl")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.records = [json.loads(line) for line in self.path.read_text().splitlines()] if self.path.exists() else []

    def append(self, kind, **fields):
        record = clone({"kind": kind, "recordedAt": now_ms(), **fields})
        with self.path.open("a") as stream:
            stream.write(json.dumps(record, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.records.append(record)
        return record


def fast_rules(engine):
    """One active decision policy: V4 plus binding to existing host tools."""
    from astra_v4_spec import PROMPT
    prompt = PROMPT.replace('Model: GPT-6 Astra · MEDIUM', 'Model: Claude Sonnet 5 · MEDIUM', 1)
    return prompt + "\n\n" + V4_HOST_CONTRACT + "\n\n" + DECISION_GROUNDING_RULES


DECISION_GROUNDING_RULES = """
DECISION GROUNDING V1 — interpretation, not a new entry or alpha gate:
1. UNKNOWN/UNSUPPORTED means not measured/evaluated, NEVER false. In particular
invalidation.thesisPredicate=UNSUPPORTED is a host capability limitation, not a
host-confirmed invalidation. Judge a thesis only from its stated invalidation and
observed evidence. An untriggered breakout is not a failed breakout unless evidence
shows it triggered first and then failed. A failed plan does not prove a failed thesis.
2. Momentum, ATR and attention scores describe the past, not expected future return.
Do not call momentum 'edge', compare its magnitude to fees as a forecast, invent a
probability, or turn P1/P2/P3 examples into mandatory filters/unspecified thresholds.
An unusual volume print alone is not corrupt data or a proven liquidation cascade.
Use measured structure to justify a labelled hypothesis OR a concrete contradiction.
3. feeAndSpreadBps is BASELINE ONLY, excluding slippage/funding. Modelled all-in cost
requires declared allowances; calibrated cost and expected return remain UNKNOWN
unless supported. A plausible target is not an expected return or guaranteed fill.
4. Read hostDecisionFacts before interpreting a frozen plan: price relative to the
entry band is different from displacement relative to the trigger. A negative
side-adjusted displacement means before trigger, not automatically adverse/chasing.
WAIT cannot clear a latched failure. State whether waiting for original arrival or
for NEW CLOSED STRUCTURE permitting bounded REPLAN; a price/cost recovery alone
cannot reactivate a latched plan. Do not fabricate new evidence or exhaust retries.
ABANDON only with an observed thesis contradiction, not missing host evaluation.
5. One pass: manage owned positions, assess each selected candidate, persist the
appropriate action, then stop. For a defensible fresh hypothesis build a coherent
plan and use host validation; missing validated alpha alone is not a veto. For a
concrete blocker use WAIT/WATCH/NO_TRADE as appropriate. Never trade for a quota.
6. FAST output override: persist thesis, contradiction, invalidation and assessments
in the decision tools, not a second 26-field narrative. After the supplied work is
resolved, final text is at most three short lines referencing tool receipts.
Do not repeat the batch or recalculate values after host-confirmed completion.
Copy numeric facts from supplied context/tool results; newest host result supersedes
earlier context. Label judgment as judgment. Preserve UNKNOWN and all hard guards.
7. candidateDecisionFacts is the per-candidate interpretation receipt. For a COST
reason, distinguish measured spread/fee from unmodelled costs and from the economic
judgment. Do not justify a spread threshold by comparing past momentum or ATR to
cost and calling the remainder profit. A WATCH threshold is an attention condition,
not a profitability threshold; a subsequent plan still needs structural geometry.
If no target/stop was formed, do not claim costs consume 'most of any bounce'.
Low volumeRatio or an outlier volume alone is NOT a DATA_QUALITY failure. Cite a
failed supplied data-quality check for that classification; thin trading can instead
be a liquidity/structure concern. Describe the actual visible candle-window count;
do not relabel its high/low as a 20-bar extreme when only 12 bars are supplied.
8. Omit decision id for a NEW intent: the host deterministically assigns an
immutable id from this job and exact payload. This avoids batch-id collisions.
Different payloads get different ids. A repeated identical omitted-id call in
this job resolves to the same id. Explicit ids remain supported, but a different
action/payload must never reuse one. Plan ids remain required and separate.
For a retry/unknown execution, use EXACT original id AND payload; never substitute
nextDecisionId to bypass reconciliation. Plan id and decision id are different.
9. Resolve a READY plan's explicit entry/veto before persisting batch NO_TRADE for
other candidates. A rejected NO_TRADE does NOT register its WATCH proposals, even
when their report schema is COMPLETE. Check pendingCandidateAssessmentIds in tool
receipts: after resolving the READY plan, persist still-valid remaining candidate
assessments with a NEW intent. Never claim unconfirmed WATCH proposals are queued.
"""


def candidate_decision_facts(candidate):
    """No new indicators/alpha: label existing cost and visible-window evidence."""
    from astra_plans import finite
    economics = candidate.get('economics') or {}
    commission = economics.get('commission') or {}
    baseline = economics.get('feeAndSpreadBps')
    known = commission.get('status') == 'AVAILABLE' and finite(baseline)
    candles = candidate.get('closedCandles') or []
    lows = [c['low'] for c in candles if finite(c.get('low'))]
    highs = [c['high'] for c in candles if finite(c.get('high'))]
    checks = (candidate.get('formation') or {}).get('checks') or {}
    return {'version': 'CANDIDATE_DECISION_FACTS_V1', 'executionAuthority': False,
            'cost': {'baselineFeeAndSpreadBps': baseline if known else None,
                     'baselineStatus': 'KNOWN_BASELINE_ONLY' if known else 'UNKNOWN',
                     'allInBps': None, 'allInStatus': 'UNMODELLED_WITHOUT_PLAN_ALLOWANCES',
                     'profitAfterCosts': 'UNKNOWN_NOT_INFERRED_FROM_MOMENTUM_OR_ATR'},
            'visibleWindow': {'count': len(candles),
                              'low': min(lows) if len(lows) == len(candles) and lows else None,
                              'high': max(highs) if len(highs) == len(candles) and highs else None,
                              'meaning': 'SUPPLIED_WINDOW_ONLY_NOT_A_LONGER_LOOKBACK'},
            'failedFormationChecks': sorted(k for k,v in checks.items() if v is False),
            'dataQualityMeaning': 'VOLUME_MAGNITUDE_ALONE_DOES_NOT_PROVE_BAD_DATA',
            'watchMeaning': 'ATTENTION_THRESHOLD_NOT_PROFITABILITY_THRESHOLD'}


def host_decision_facts(opportunity):
    """Pure interpretation of delivered facts; no evaluation, plan mutation or authority."""
    from astra_plans import finite
    plan = opportunity.get('frozenPlan') or {}
    assessment = opportunity.get('assessment') or {}
    lifecycle = opportunity.get('reassessment') or {}
    px = opportunity.get('executablePrice')
    lo, hi = plan.get('entryMin'), plan.get('entryMax')
    band = 'UNKNOWN'
    if all(finite(x) for x in (px, lo, hi)) and 0 < lo <= hi and px > 0:
        band = 'BELOW' if px < lo else 'ABOVE' if px > hi else 'WITHIN'
    displaced = opportunity.get('adverseDisplacementBps')
    displacement = 'UNKNOWN'
    if finite(displaced):
        displacement = 'BEYOND_TRIGGER' if displaced > 0 else 'BEFORE_TRIGGER' if displaced < 0 else 'AT_TRIGGER'
    latched = lifecycle.get('failedAt') is not None
    status = lifecycle.get('status')
    terminal = status in ('REPLANNED', 'ABANDONED', 'EXPIRED')
    wait_meaning = ('TERMINAL_PLAN' if terminal else 'NEW_STRUCTURE_FOR_REASSESSMENT_NOT_REACTIVATION'
                    if latched else 'ORIGINAL_ARRIVAL_OR_THESIS_REVIEW')
    cost, cap = assessment.get('costBps'), plan.get('maxCostBps')
    created_bar = ((lifecycle.get('createdSnapshot') or {}).get('candle') or {}).get('closeTime')
    current_bar = ((opportunity.get('reassessmentSnapshot') or {}).get('candle') or {}).get('closeTime')
    return {'version': 'HOST_DECISION_FACTS_V1', 'executionAuthority': False,
            'assessmentAt': assessment.get('at'), 'thesisValidity': 'NOT_MACHINE_EVALUATED',
            'unsupportedThesisPredicateMeans': 'CAPABILITY_LIMIT_NOT_THESIS_FAILURE',
            'entryBandLocation': band, 'triggerDisplacementLocation': displacement,
            'negativeDisplacementMeans': 'BEFORE_TRIGGER_NOT_AUTOMATICALLY_ADVERSE',
            'modelledCostBps': cost, 'maxCostBps': cap,
            'costHeadroomBps': cap-cost if finite(cost) and finite(cap) else None,
            'planFailureLatched': latched, 'waitMeaning': wait_meaning,
            'attemptsRemaining': lifecycle.get('attemptsRemaining'),
            'newClosedEvidenceSinceCreation': current_bar > created_bar
                if finite(current_bar) and finite(created_bar) else None,
            'replanStillRequires': 'RECOVERABLE_FAILURE_NEW_STRUCTURE_FULL_VALIDATION',
            'priceRecoveryClearsLatch': False}


V4_HOST_CONTRACT = """
HOST TOOL BINDING (not a new strategy):
Persist the chosen action through the allowlisted tools before the concise final
V4 output. Final prose alone never places orders. Use astra_enter with explicit
ENTER_LONG/ENTER_SHORT and a complete frozen plan or setupId. Gateway remains the
sole executor. No REDUCE, partial close, open-position stop/target amendments,
market-making activation, hedge/carry execution or automatic future entry.
Read the returned plan assessment before ENTER. Only ready=true is executable;
FROZEN/ADMISSIBLE is not READY. A trigger crossing alone does not waive other
checks. Compare maxCostBps with host costBps (fees + executable spread + declared
slippage/funding allowances); a gross target is not permission to exceed the cap.
If blocked, use existing WAIT/REPLAN/ABANDON semantics and the unchanged attempt
budget. Never raise cost or risk limits merely to force acceptance, or resubmit
the same failed plan as a fresh decision without a material change.
Each owned position needs HOLD/TAKE_PROFIT/CUT_LOSS before increasing risk.
HOLD_WITH_REASON is only a missing-data alias, recorded as HOLD with its reason.
Use only host-supplied context and max three canonical lessons. No full scan,
personal memory, broad research, coaching, experiment proposals or publication in
FAST. astra_context reads the supplied snapshot; host handles execution refresh.
Report appliedLessonIds and rejectedLessonIds with reasons, not invented checks.
Quant status FEATURE_CONTEXT_ONLY means deterministic features exist but a validated
statistical edge does NOT. UNKNOWN remains unknown; do not manufacture expectancy,
PF, beta, correlation, regime or estimated edge from attention rankings or PnL.
A NOVEL hypothesis must be labelled unproven. Quant/context timestamps do not waive
any freshness check. Strategy assignment is provenance, never proof of edge.
quantEvidence.snapshot separates marketContext, costContext, portfolioContext and
strategyEvidence. MARKET_STATE_ONLY is descriptive context, not validated alpha.
TESTNET HYPOTHESIS MODE: absence of OOS/FORWARD validation, PF or calibrated
expectancy is NOT by itself an entry veto and is NOT a mandatory next-review
trigger. You may form a clearly labelled unproven hypothesis from fresh measured
market structure and submit a complete justified plan for full host validation.
Missing candidate trigger/entryBand means no plan exists yet, not that you must
wait for Quant to invent one. NO_TRADE remains valid for concrete data, structure,
timing, cost or risk reasons. Never force entry, invent probability/edge, treat
historical momentum as forecast profit, or treat UNKNOWN slippage as zero.
FORMATION CONTEXT: A candidateClass of FRESH_FORMATION_CONTEXT means the host has
verified fresh closed candles, a fresh executable book, and known baseline fees plus
spread. It is not a directional signal, a validated edge, a trigger, an entry band,
or order permission. For each such candidate, either (a) form a clearly-labelled
NOVEL frozen plan from the supplied closed-candle structure, with your own bounded
trigger, entry band, stop, target and cost allowance, or (b) reject it using a
specific observed contradiction. Do not cite the absence of a host-supplied trigger
or entry band as the reason to stand down: deciding whether that geometry can be
formed is Astra's responsibility. A frozen plan is still not an entry, and every
entry continues through the unchanged host validation and fresh execution checks.
Validation is required for claims of validated alpha, not for this existing
Testnet hypothesis permission. All freshness, cost and hard risk guards remain.
candidateSelection is an ATTENTION-ONLY deterministic 4+1+1 ranking receipt, not
alpha, trade direction, probability, or permission. Its temporal features are
sampled executable-mid quote proxies, NOT closed-candle Quant indicators. Missing
components remain UNKNOWN; volume expansion is not inferred from rolling 24h
volume. Independently assess supplied fresh closed-candle Quant and execution data.
Read dataQuality per field: UNKNOWN/null is not zero, DEGRADED is not GOOD.
Evidence is specific to strategyId + version + scope + methodVersion + dataWindow
and evidenceAsOf. Never transfer a validation label outside that scope or period.
Fees are account/symbol rates per fill, funding is indicative, and a missing
slippage estimate/bound must not be replaced with zero or executable spread.
Benchmark-only BTC/ETH references are not additional candidate entry permission.
For WAIT/REPLAN/ABANDON_SETUP on a plan, use astra_decide with setupId and the supplied
snapshotId. WAIT and ABANDON_SETUP need only id/action/setupId/reason/snapshotId
plus optional lesson metadata; do not add REPLAN-only geometry or explanation fields.
Plan limits: 0 < notionalUsd <= 25; 0 < entrySlippageBps <= 100 (zero is invalid).
GEOMETRY PREFLIGHT: with trigger T, stop S, executable entry P and host cap c,
LONG planned risk r=(T-S)/T and actual risk=(P-S)/P; SHORT r=(S-T)/T
and actual risk=(S-P)/P. Require r>0 and actual risk/r<=c (normally 1.25).
For LONG when 1-c*r>0, P<=S/(1-c*r); SHORT P>=S/(1+c*r).
These continuous limits are diagnostics, not order permission or tick-rounded prices.
Use them BEFORE submitting a plan; all normal guards still apply. Narrowing a
LONG band upward or a SHORT band downward can worsen risk inflation. Changing
target or reducing notional does not repair this ratio. Never move a structural
stop/trigger or raise the cap merely to pass. If price has run beyond a justified
plan, WAIT for admissible geometry or reassess using genuinely new evidence.
An initial constructor rejection creates no plan. A successful constructor CAN create
a plan whose first evaluation immediately fails cost/trigger. Read entryDiagnostic:
NEW_PLAN_FAILED_INITIAL_CHECK is not an old symbol latch. Never claim no plan exists
when planPersisted=true. Host predicate values outrank your earlier snapshot/prose.
Only host lineage/attempt state
can establish that REPLAN attempts are exhausted; do not invent that conclusion.
These are bounds, not recommended cost assumptions: justify actual allowances.
An expired plan is retired by the host without declaring its thesis false; a new
hypothesis needs a genuinely newer closed candle, not a recycled expired plan.
For REPLAN use the supplied
reassessmentSnapshot.snapshotId. If it changed, inspect the returned fresh snapshot
before deciding. A candidate with no plan may use NO_TRADE + assessedOpportunityIds
to wait without inventing a plan. Never portray a batch verdict as market-wide.
REPLAN requires a new child plan id, new closed evidenceCandleAt, whatChanged,
whatRemainsValid, newEvidence, contradictingEvidence, updatedInvalidation,
replanReason, setupType and playbooks. Same-symbol PRE-ENTRY only. Max two attempts
per lineage, including rejected reassessments. WAIT or ABANDON after exhaustion.
Ordinary WAIT for an original trigger on the approach side, with no genuine prior
execution failure, returns AWAITING_ENTRY and does not spend reassessment attempts.
It does not authorize any future order. Once READY, make a fresh explicit ENTER
decision if the thesis still holds. Genuine cost/risk/overshoot failures still
invalidate the old plan and retain the two-attempt reassessment limit.
LIFECYCLE_BLOCKED is NOT READY even if marketPlanStatus says READY. A prior
failedAt latch survives WAIT and recovering prices. Never retry ENTER on that old
id; use evidence-backed bounded REPLAN, or WAIT/ABANDON. Do not manufacture a new
structure to evade the latch. Check the supplied lifecycle before requesting tools.
REPLAN writes a plan, not an order. A later explicit ENTER runs every host gate.
Never cosmetically move geometry or reduce cost allowances to force admission.
Provider failures/exhausted turns are not HOLD/WAIT decisions.
The final response follows the user's V4 OUTPUT fields, with UNKNOWN for absent
data and no essay. Do not append extra analysis once the action is defensible.
"""


COACHING_RULES = """You are Hermes in an isolated V8 COACHING session.
Use only the supplied canonical actual evidence and canonical module checks.
No trading, management, gateway calls, market fetching, old journals, personal
memory, plan changes or strategy assignment changes are permitted in this mode.
astra_learn REVIEW/PUBLISH are the only writing operations; LIST reads canonical data.
Review SETUP_SELECTION, ENTRY_TIMING, ENTRY_DISPLACEMENT, POSITION_MANAGEMENT,
EXIT_DECISION, EXECUTION_QUALITY and UNFORESEEABLE_MARKET_CHANGE. Preserve unknowns.
Use actual quantity/fill/fees/funding/protection and exchange-reconciled state.
Non-trade/no-fill PnL is zero, future paths are counterfactual diagnostics only.
Classify process and outcome separately. A winner is not automatic lesson support.
Publishing nothing is valid when evidence is weak. No generic advice. Lessons need
version, evidence IDs, context, mechanism, required check, exceptions, supporting
and contradicting evidence and status. Old contradicted execution lessons cannot
be promoted as current policy. Do not claim profitability from compliance.
decisionContext is frozen pre-decision data, not hindsight truth. A model reason
is a claim to evaluate, not a verified causal explanation. Batch NO_TRADE does not
give a separate reason for each symbol. Never invent one. Use a unique review id
including evidenceHash when revisiting changed evidence. supportEvidence contains
bounded supporting/counterexamples in the same policy partition, not all history.
Only existing procedural checks in publicationContract may be published; this is
not permission to invent alpha or weaken risk. Three independent episodes are
required, not three reviews/retries. UNKNOWN cannot be counted as a passing check.
"""


def fast_trial_context(trial):
    """FAST gets the assigned policy, never the coaching study-history payload.

    Host ExperimentBook remains unchanged and still enforces all promotion,
    assignment and risk gates. No numeric field or strategy text is truncated.
    """
    return {**{k: clone(v) for k, v in trial.items() if k not in ('progress', 'recentStudies')},
            'coachingOnlyFields': ['progress', 'recentStudies']}


def context_chars(context):
    # Same serialization used by the actual model prompt, not pretty JSON.
    return len(json.dumps(context, allow_nan=False, separators=(',', ':')))


def share_quant_metadata(context):
    """Lossless references for repeated metadata; retain all evidence and risk values."""
    snapshot = context.get('quantEvidence', {}).get('snapshot') or {}
    rows = snapshot.get('rows', [])
    groups = {}
    for row in rows:
        for parent, key in ((row.get('dataQuality', {}), 'fieldCompleteness'),
                            (row.get('dataQuality', {}), 'reasons'),
                            (row, 'strategyEvidence'),
                            (row.get('marketContext', {}), 'dataQuality'),
                            (row.get('costContext', {}), 'dataQuality')):
            value = parent.get(key)
            if not isinstance(value, (dict, list)) or (isinstance(value,dict) and '$quantRef' in value):
                continue
            encoded = json.dumps(value, allow_nan=False, sort_keys=True, separators=(',', ':'))
            if len(encoded) >= 250:
                groups.setdefault(encoded, []).append((parent, key, value))
    # This function runs both before and after Quant enrichment. Preserve earlier
    # references and allocate distinct IDs on subsequent calls.
    shared = dict(snapshot.get('sharedMetadata') or {})
    for encoded, matches in groups.items():
        if len(matches) < 2:
            continue
        ident = 'q' + str(len(shared))
        while ident in shared:
            ident = 'q' + str(int(ident[1:])+1)
        shared[ident] = matches[0][2]
        for parent, key, value in matches:
            parent[key] = {'$quantRef': ident}
    if shared:
        snapshot = context['quantEvidence']['snapshot']
        snapshot['sharedMetadata'] = shared
        snapshot['referenceContract'] = '$quantRef resolves to the identical value in this snapshot.sharedMetadata. No evidence, cost, risk or UNKNOWN value removed.'


def bounded_context(context):
    """Defense in depth: no hidden raw/journal payload in any nested field."""
    forbidden = {"rawcontext", "journal", "fulljournal", "history", "fulluniverse", "overview",
                 "learningfeedback", "memories", "memory", "closedtrades", "entryintents", "submissions"}
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.lower().replace("_", "") in forbidden:
                    raise IntegrationError("Unbounded/legacy context field: " + key)
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(context)
    if not isinstance(context, dict):
        raise IntegrationError("Host context must be a bounded object (maximum 64000 characters)")
    context = clone(context)
    if context_chars(context) > 60000:
        share_quant_metadata(context)
    # Scorer diagnostics are not trading evidence. The immutable host job keeps
    # the full decomposition; FAST needs identity, ordering and provenance only.
    selection = context.get('candidateSelection')
    if isinstance(selection, dict) and context_chars(context) > 60000:
        removed = []
        for row in selection.get('selected', []):
            if isinstance(row, dict):
                omitted = [k for k in ('components', 'componentRanks', 'unknownComponents', 'volumeExpansionStatus') if k in row]
                for key in omitted:
                    row.pop(key)
                if omitted:
                    removed.append(row.get('symbol'))
        if removed:
            context['contextCompaction'] = {
                'methodVersion': 'FAST_SCORER_DIAGNOSTICS_V2',
                'omitted': 'candidateSelection.selected ranking decomposition only',
                'symbols': removed, 'source': 'IMMUTABLE_HOST_JOB',
                'meaning': 'Ranking diagnostics only; prices, risk, costs, evidence and lessons unchanged'}
    size = context_chars(context)
    from astra_watch_queue import context_limit
    maximum = context_limit(context)
    if size > maximum and context.get('narrativeContext'):
        for symbol, row in list(context['narrativeContext'].get('rows', {}).items()):
            if row.get('status') == 'UNKNOWN_NO_MATCHED_COVERAGE':
                context['narrativeContext']['rows'][symbol] = {'status': row['status'], 'omitted': 'EMPTY_COVERAGE_DETAILS'}
        context['narrativeContext']['deliveryCompaction'] = 'EMPTY_COVERAGE_DETAILS_V1'
        context['narrativeContext'].pop('deliveredHash', None)
        context['narrativeContext']['deliveredHash'] = digest(context['narrativeContext'])
        size = context_chars(context)
    if size > maximum and context.get('narrativeContext'):
        original = context['narrativeContext']
        context['narrativeContext'] = {k: clone(original.get(k)) for k in
            ('version','asOf','dataQuality','snapshotHash','evidenceStatus','walletFlow','socialAttention','executionAuthority')}
        context['narrativeContext']['rows'] = {s: {k: clone(row.get(k)) for k in
            ('status','uniqueHeadlineN','publisherN','sourceIds','topicKeywords','latestPublishedAt')}
            for s,row in original.get('rows',{}).items() if row.get('status')=='OBSERVED_MEDIA_COVERAGE'}
        context['narrativeContext']['unknownSymbols'] = [s for s,row in original.get('rows',{}).items()
            if row.get('status') != 'OBSERVED_MEDIA_COVERAGE']
        context['narrativeContext']['deliveryCompaction'] = 'MEDIA_COUNTS_ONLY_FULL_SNAPSHOT_BY_HASH'
        size = context_chars(context)
    if size > maximum and context.get('narrativeContext'):
        # Optional context must not break an otherwise valid trading job.
        original = context.pop('narrativeContext')
        context['narrativeContext'] = {'version': original.get('version'),
            'snapshotHash': original.get('snapshotHash'), 'status': 'OMITTED_CONTEXT_BUDGET',
            'executionAuthority': False}
        size = context_chars(context)
        if size > maximum:
            context.pop('narrativeContext', None)
            size = context_chars(context)
    if size > maximum:
        sizes = {k: len(json.dumps(v, allow_nan=False)) for k, v in context.items()}
        raise IntegrationError("Host context must be a bounded object (maximum " + str(maximum) + " characters); "
                               + "serializedChars=" + str(size) + "; fields=" + json.dumps(sizes, sort_keys=True))
    return clone(context)


def position_signature(position):
    return {k: position.get(k) for k in ("id", "symbol", "side", "state", "qty", "stopPrice",
                                       "targetPrice", "maxHoldMs", "createdAt", "stateVersion", "stopId", "stopDone")}


def verify_manifest(root, job, status):
    """Host arming/fingerprint checked again at the actual decision gateway."""
    from astra_v8_host import release_gate
    path = Path(root) / "v8-manifest.json"
    manifest = json.loads(path.read_text())
    if manifest.get("fingerprint") != job["fingerprint"]:
        raise IntegrationError("Worker deployment fingerprint differs from host job")
    files = manifest.get("runtimeFiles") or {}
    required = {"astra_v8_runner.py", "astra_runner.py", "astra_decisions.py", "astra_fast_v8.py",
                "astra_canonical_v8.py", "astra_v8_host.py", "astra_v8_phase.py", "astra_v8_supervisor.py"}
    if not required <= set(files) or any(Path(name).is_absolute() or ".." in Path(name).parts for name in files):
        raise IntegrationError("Manifest lacks required worker/runtime hashes")
    actual = {name: hashlib.sha256((Path(root) / name).read_bytes()).hexdigest() for name in files}
    release_gate(manifest, current_hashes=actual, gateway_status=status)


def verify_v8_phase(engine, root, job):
    """Re-read persisted enrollment immediately before new risk; management is independent."""
    book = engine.ExperimentBook(Path(root), engine.digest({"base": engine.SYSTEM, "common": engine.EXPERIMENT_RULES}))
    assignment = book.state["assignments"].get(str(job.get("assignmentId")))
    study = book.active()
    phase = study["phases"][-1] if study and study.get("phases") else None
    if (book.state.get("decisionVersion") != COHORT or book.state.get("executionVersion") != COHORT
            or not assignment or assignment.get("executionVersion") != COHORT
            or not phase or phase.get("fingerprint") != job["fingerprint"]
            or phase.get("decisionVersion") != COHORT or phase.get("cohortId") != COHORT
            or phase.get("sealedAt") or assignment.get("phaseId") != phase.get("id")):
        raise IntegrationError("V8 prospective phase/assignment/fingerprint mismatch; no new risk")
    return True


def event_keys(job):
    result = []
    for event in job.get("events", []):
        if event.get("entityType") in ("POSITION", "OPPORTUNITY") and event.get("eventReason") in FAST.EVENT_REASONS:
            result.append(FAST.event_key(event))
        elif event.get("id") or event.get("eventId"):
            result.append(str(event.get("id") or event["eventId"]))
        else:
            raise IntegrationError("Host events require a stable identity")
    return sorted(set(result))


def execution_times(action, result, intent_at):
    """Gateway-owned handle attempts and matched exchange fills; never wall-clock guesses."""
    handles = [result.get("entry") or {}] if action in AD.ENTRIES else (
        [h for h in result.get("exits", []) if isinstance(h, dict)
         and isinstance(h.get("attemptedAt"), (int, float)) and h["attemptedAt"] >= intent_at]
        if action in ("TAKE_PROFIT", "CUT_LOSS") else [])
    attempts = [h["attemptedAt"] for h in handles if type(h.get("attemptedAt")) in (int, float)]
    order_ids = {str(h["order"]["orderId"]) for h in handles if isinstance(h.get("order"), dict)
                 and h["order"].get("orderId") is not None}
    fills = [f["time"] for f in result.get("fills", []) if str(f.get("orderId")) in order_ids
             and type(f.get("time")) in (int, float) and float(f.get("qty") or 0) > 0]
    return {"orderSubmittedAt": min(attempts) if attempts else None,
            "orderFilledAt": min(fills) if fills else None,
            "submissionTimestampSource": "GATEWAY_HANDLE_PRE_NETWORK_ATTEMPT" if attempts else None,
            "fillTimestampSource": "EXCHANGE_FILL_MATCHED_ORDER_ID" if fills else None}


class JobSession:
    def __init__(self, root, job, mode, engine, canonical, journal):
        if mode == DEEP_REVIEW and job.get('auditReason') not in AUDIT_REASONS:
            raise IntegrationError('DEEP_REVIEW requires an explicit host auditReason; not a routine review')
        self.root, self.job, self.mode = Path(root), clone(job), mode
        self.engine, self.canonical, self.journal = engine, canonical, journal
        self.context = bounded_context(job["context"]) if mode == FAST_TRADING else clone(job["context"])
        self.lock = threading.RLock()
        self.actions, self.covered, self.reviews = [], set(), []
        self.assessed_symbols = set()
        self.active_intent = None
        self.replay_position_attempts = {}
        self.gateway_calls = 0
        self.original_gateway = engine.gateway if engine else None
        self.positions = {}
        self.lessons = []
        self.lesson_contexts = {}
        self.canonical_path = self.root / "hermes-home" / "astra-canonical-v8.json"
        if self.canonical is None:
            overlay = json.loads(self.canonical_path.read_text()) if self.canonical_path.exists() else []
            self.canonical = CanonicalBook(overlay=overlay)
        self.canonical_saved = len(self.canonical.export())
        # The host chooses the decision policy and freezes it into the job. A declared
        # policy that is not one of the two named ones is refused rather than run: an
        # arbitrary model reaching astra_decide would be an unreviewed policy change.
        declared = self.job.get("modelPolicy") or ROUTER.policy(mode)
        # Policies are task-typed now: the same model at a different effort is a
        # different policy. Checking membership of the declared table rather than
        # rebuilding from a role is what stops FAST_TRADING ever running at MAX.
        if not ROUTER.is_declared(declared):
            raise IntegrationError("Job model policy is not a declared policy: " + json.dumps(declared, sort_keys=True))
        if declared["task"] != mode:
            raise IntegrationError("Job model policy is for " + declared["task"] + ", not " + mode)
        expected = declared
        self.model_policy = expected
        self.model_identity = ROUTER.identity(expected)
        self.session_id = "v8-" + mode.lower() + "-" + digest([job["id"], job["fingerprint"],
                                                              expected["role"]])[:24]

    def record(self, kind, **data):
        # Model identity rides on every record: the same cohort now holds decisions
        # from two different policies, and only this field can tell them apart later.
        return self.journal.append(kind, jobId=self.job["id"], mode=self.mode,
                                   cohortId=COHORT, fingerprint=self.job["fingerprint"],
                                   **self.model_identity, **data)

    def prepare(self):
        if self.mode in REVIEW_MODES:
            source = self.job.get("canonicalInput")
            legacy = self.job.get("rawCanonical", {}).get("legacyJournal", {})
            if source is not None:
                legacy = source.get("legacyJournal", {})
                rows = canonical_evidence(source["report"], source["status"], legacy,
                                          bindings=source.get("bindings", {}), plans=source.get("plans", []),
                                          decisions=source.get("decisions", []),
                                          post_fix_execution_versions=source.get("postFixExecutionVersions", ()))
            else:
                rows = self.context.get("canonicalEvidence")
            if not isinstance(rows, list):
                raise IntegrationError("COACHING context requires host canonicalEvidence rows")
            self.canonical.ingest(rows, legacy)
            # The host resends every FAST delta since cutover. Replaying one that is
            # already merged is a no-op but costs a full-book verify (~35s each on VPS),
            # so coaching grew past its own hourly cadence. IMPORT_PROVENANCE id is
            # exactly _hash(delta), written by ingest_applications.
            imported = {e["id"] for e in self.canonical.export() if e["kind"] == "IMPORT_PROVENANCE"}
            for delta in self.job.get("canonicalDeltas", []):
                if not delta or _canonical_hash(delta) in imported:
                    continue
                overlay = self.canonical.export()
                anchor = delta[0]["previousHash"]
                index = next((i + 1 for i, e in enumerate(overlay) if e["hash"] == anchor), None)
                if anchor == "GENESIS":
                    index = 0
                if index is None:
                    raise IntegrationError("FAST canonical delta has no known base snapshot")
                self.canonical.ingest_applications(overlay[:index], delta)
                imported.add(_canonical_hash(delta))
            self.persist_canonical()
            wanted = self.job.get("reviewEvidenceIds")
            review_events = self.canonical.export() if wanted is None else []
            selected = [r for r in rows if r.get("eligible") is True and
                        (r["evidenceId"] in wanted if wanted is not None else needs_review(r,review_events))][:2]
            self.context = {"mode": self.mode, "canonicalEvidence": selected,
                            'reviewEvidenceHashes':{r['evidenceId']:digest(r) for r in selected},
                            'supportEvidence':coaching_support(rows,selected),
                            'publicationContract':{'checks':PROCEDURAL_CHECKS,
                                'supportFields':sorted(SUPPORT_FIELDS),'supportOp':'eq','supportValue':False,
                                'minimumIndependentEpisodes':3,'alphaPromotionAllowed':False},
                            "publicationOptional": True}
            if len(json.dumps(self.context, allow_nan=False)) > 64000:
                raise IntegrationError("Canonical review evidence exceeds bounded context")
            return
        e = self.engine
        raw = self.job.get("rawContext") or {}
        if raw.get("source") != "BINANCE_USDM_TESTNET" or raw.get("status", {}).get("environment") != "testnet":
            raise IntegrationError("Host raw context must be verified Testnet data")
        e.ROOT = self.root
        from astra_quant_v4 import contract as quant_contract
        quant = quant_contract(raw, now_ms())
        if self.context.get('narrativeContext'):
            from narrative_attention import revalidate as revalidate_narrative
            self.context['narrativeContext'] = revalidate_narrative(self.context['narrativeContext'], now_ms())
        # Keep the compatibility API for offline callers, but do not send both
        # old measurement rows and the new snapshot to a time-sensitive model.
        self.context["quantEvidence"] = {k: v for k, v in quant.items() if k not in ('rows', 'portfolio')}
        e.LEARNING_BOOK = None
        e.PLAN_BOOK = e.PlanBook(self.root, max_risk_inflation=e.execution_config(self.root).get("maxRiskInflation"))
        # Import host observation stamps, never make stale candles young with observe().
        e.PLAN_BOOK.status = clone(raw["status"])
        e.PLAN_BOOK.unavailable = clone(raw.get("unavailableSymbols", []))
        for row in raw.get("rows", []):
            if not isinstance(row.get("observedAt"), (int, float)):
                raise IntegrationError("Host cached rows require original observedAt")
            e.PLAN_BOOK.rows[row["symbol"]] = clone(row)
        for opportunity in self.context.get("opportunities", []):
            saved = e.PLAN_BOOK.get(opportunity["opportunityId"])
            opportunity["reassessment"] = e.PLAN_BOOK.view(saved).get("reassessment")
            try:
                opportunity["reassessmentSnapshot"] = e.PLAN_BOOK.snapshot(saved["plan"]["symbol"])
            except ValueError:
                opportunity["reassessmentSnapshot"] = None
            opportunity['hostDecisionFacts'] = host_decision_facts(opportunity)
        self.positions = {p["id"]: clone(p) for p in raw["status"].get("active", [])}
        supplied = {p.get("positionId", p.get("id")) for p in self.context.get("positions", [])}
        if supplied != set(self.positions):
            raise IntegrationError("FAST context omitted or invented an owned position")
        self.selected_plans = [{"plan": o["frozenPlan"], "submissionId": o.get("submissionId"),
                                "assessment": o.get("assessment", {})} for o in self.context.get("opportunities", [])]
        if self.context.get("stateVersion") != FAST.state_version(self.selected_plans, list(self.positions.values())):
            raise IntegrationError("Host FAST context stateVersion does not match raw owned positions/plans")
        common_hash = e.digest({"base": e.SYSTEM, "common": e.EXPERIMENT_RULES})
        e.EXPERIMENT_REQUIRED = True
        try:
            e.EXPERIMENT_BOOK = e.ExperimentBook(self.root, common_hash)
            assignment = e.EXPERIMENT_BOOK.state["assignments"].get(str(self.job.get("assignmentId")))
            if assignment is None:
                raise IntegrationError("Host prospective assignmentId is missing from ExperimentBook")
            e.EXPERIMENT_BOOK.current = assignment
            trial = e.EXPERIMENT_BOOK.summary()
        except (OSError, ValueError, KeyError, IntegrationError) as error:
            e.EXPERIMENT_BOOK = None
            trial = {"available": False, "error": str(error), "newEntriesBlocked": True}
        # Assigned strategy is host data, not a model-provided override.
        self.context["strategyTrial"] = fast_trial_context(trial)
        # Hermes lessons the host enforces for THIS arm only; CONTROL cycles see none
        # of the TESTING lessons, so the A/B compares with and without them.
        arm = e.EXPERIMENT_BOOK.learner_arm() if e.EXPERIMENT_BOOK is not None else "INCUMBENT"
        self.context["hermesLessons"] = hermes_learner.fast_context(
            hermes_learner.read_state_quiet(self.root), arm,
            [(o.get("frozenPlan") or {}).get("id") for o in self.context.get("opportunities", [])])
        # The canonical overlay is the authority, not free-form host memory or model claims.
        self.context.pop("lessons", None)
        tags = {**self.context.get("policyVersions", {}), "cohort": COHORT,
                "fingerprint": self.job["fingerprint"], **self.model_identity}
        for item in self.context.get("opportunities", []) + self.context.get("positions", []):
            plan = item.get("frozenPlan") or item
            ident = item.get("opportunityId", item.get("positionId"))
            observed = {**clone(plan), **clone(item), **tags,
                        "evaluatingAction": "ENTER_" + plan["side"] if "opportunityId" in item else "HOLD",
                        "phase": "ENTRY" if "opportunityId" in item else "MANAGEMENT"}
            assessment = item.get("assessment") or {}
            observed.update(executableQuote=item.get("executablePrice"),
                            spreadBps=assessment.get("spreadBps"), costBps=assessment.get("costBps"))
            self.lesson_contexts[ident] = observed
            delivery = self.canonical.deliver(self.session_id + ":" + ident, observed)
            for lesson in delivery["procedures"]:
                if len(self.lessons) < 3 and lesson["lessonId"] not in {l["lessonId"] for l in self.lessons}:
                    self.lessons.append(lesson)
        for candidate in self.context.get("marketCandidates", []):
            candidate['candidateDecisionFacts'] = candidate_decision_facts(candidate)
            for side in ("LONG", "SHORT"):
                observed = {**clone(candidate), **tags, "side": side, "phase": "ENTRY",
                            "evaluatingAction": "ENTER_" + side,
                            "executableQuote": (candidate.get("book") or {}).get("ask" if side == "LONG" else "bid")}
                ident = candidate["opportunityId"] + ":" + side
                self.lesson_contexts[ident] = observed
                delivery = self.canonical.deliver(self.session_id + ":" + ident, observed)
                for lesson in delivery["procedures"]:
                    if len(self.lessons) < 3 and lesson["lessonId"] not in {l["lessonId"] for l in self.lessons}:
                        self.lessons.append(lesson)
        self.context["lessons"] = clone(self.lessons)
        self.context["deliveredLessonIds"] = [l["lessonId"] for l in self.lessons]
        self.context["procedureVersions"] = {l["lessonId"]: l["version"] for l in self.lessons}
        self.record('FAST_CONTEXT_SIZE', serializedChars=len(json.dumps(self.context, allow_nan=False)),
                    maxChars=__import__('astra_watch_queue').context_limit(self.context), coachingOnlyFields=['progress', 'recentStudies'],
                    fieldChars={k: len(json.dumps(v, allow_nan=False)) for k, v in self.context.items()})
        self.context = bounded_context(self.context)

    def call(self, name, args):
        with self.lock:
            try:
                result = self._call(name, clone(args))
                if name in ('astra_decide', 'astra_enter') and isinstance(result, dict):
                    result = {**result, 'nextDecisionId': self.next_decision_id(),
                              'idRule': 'NEW_INTENT_ONLY; retries require exact original id and payload'}
                    result['pendingCandidateAssessmentIds'] = pending_candidate_assessments(self)
                    if result['pendingCandidateAssessmentIds']:
                        result['reportInstruction'] = ('These assessments are NOT host-confirmed or registered as WATCH. '
                            'Resolve READY plan/uncertain execution first, then persist remaining still-valid '
                            'assessments as a NEW NO_TRADE intent. Do not claim they were accepted.')
                return json.dumps(result, allow_nan=False)
            except (ValueError, TypeError, KeyError, RuntimeError) as error:
                self.record('TOOL_REJECTED', tool=name, action=args.get('action'),
                            errorType=type(error).__name__, error=str(error)[:1000])
                result = {"error": str(error), "mode": self.mode,
                          "nextDecisionId": self.next_decision_id(),
                          "idRule": "NEW_INTENT_ONLY; never replace an unresolved original request"}
                if getattr(error, "diagnostic", None):
                    result["geometryDiagnostic"] = clone(error.diagnostic)
                return json.dumps(result, allow_nan=False)

    def next_decision_id(self):
        used = {r.get('decisionId') for r in self.journal.records if r.get('decisionId')}
        n = 1
        prefix = str(self.job['id']) + '-intent-'
        while prefix + str(n) in used:
            n += 1
        return prefix + str(n)

    def _call(self, name, args):
        if name not in ALLOWLIST:
            raise ValueError("Tool outside fixed allowlist")
        if name in ('astra_decide', 'astra_enter') and 'id' not in args:
            args = {**args, 'id': automatic_intent_id(self.job['id'], args)}
        if name == "memory":
            raise ValueError("Personal memory is disabled in V8; use supplied canonical evidence only")
        if name == "astra_context":
            guard_mode = COACHING if self.mode in REVIEW_MODES else self.mode
            FAST.guard_operation(guard_mode, "READ_CONTEXT", budget_lane=guard_mode)
            if any(args.get(k) for k in ("symbols", "offset", "overviewOffset")):
                raise ValueError("Context is supplied by host; fetching/scanning/pagination is disabled")
            return clone(self.context)
        if self.mode in REVIEW_MODES:
            if name != "astra_learn":
                raise ValueError("COACHING cannot trade, manage plans or mutate experiments")
            return self.canonical_call(args)
        operation = args.get("operation")
        if name == "astra_learn":
            if operation == "LIST":
                return {"lessons": clone(self.lessons)}
            raise ValueError("FAST cannot REVIEW/PUBLISH or write old learning journals; attach lesson usage to decision")
        if name == "astra_experiment":
            if operation != "LIST":
                raise ValueError("FAST cannot propose/review/advance experiments")
            return clone(self.context["strategyTrial"])
        if name == "astra_plan":
            if operation == "LIST":
                return {"plans": clone(self.context.get("opportunities", []))}
            if operation != "CREATE":
                raise ValueError("Only LIST/CREATE frozen plans are available")
            FAST.guard_operation(self.mode, "CREATE_PLAN", budget_lane=self.mode)
            symbol = args.get("plan", {}).get("symbol")
            if symbol not in self.engine.PLAN_BOOK.rows:
                raise ValueError("Plan must use a host-selected inspected symbol")
            self.refresh_selected_row(symbol)
            return json.loads(self.engine.plan_result(args))
        if name == "astra_decide" and args.get("action") in REPLAN.ACTIONS:
            return self.pre_entry_action(args)
        return self.decide(args, fused=name == "astra_enter")

    def pre_entry_action(self, args):
        if set(self.positions) - self.covered:
            raise ValueError("Manage every owned position before reassessing entries")
        book = self.engine.PLAN_BOOK
        parent = book.get(args.get("setupId"))
        symbol = parent["plan"]["symbol"]
        if symbol not in book.rows:
            raise ValueError("Reassessment needs a host-selected symbol")
        known = next((r for r in self.journal.records if r["kind"] == "V2_PRE_ENTRY_INTENT"
                      and r["decisionId"] == args.get("id")), None)
        if known and known["input"] != args:
            raise ValueError("Reassessment id reused with different input")
        delivered_ids = {o.get('reassessmentSnapshot', {}).get('snapshotId')
                         for o in self.context.get('opportunities', []) if o.get('reassessmentSnapshot')}
        delivered_ids.update(getattr(self, '_returned_snapshot_ids', set()))
        try:
            delivered_ids.add(book.snapshot(symbol)['snapshotId'])
        except ValueError:
            pass
        if args.get('action') != 'REPLAN' and not known and args.get('snapshotId') not in delivered_ids:
            raise ValueError('Use a supplied snapshotId for this session')
        self.refresh_selected_row(symbol)
        # Refresh verified account state as well: a concurrent fill must block replanning.
        book.status = clone(self.engine.gateway("/status"))
        self.engine.validate_capital_identity(book.status)
        snap = book.snapshot(symbol)
        if args.get('action') == 'REPLAN' and snap["snapshotId"] != args.get("snapshotId"):
            self._returned_snapshot_ids = getattr(self, '_returned_snapshot_ids', set()) | {snap['snapshotId']}
            return {"status": "STALE_REASSESSMENT", "snapshot": snap,
                    "instruction": "Reassess this current evidence; no plan mutation or order occurred"}
        if not known:
            self.record("V2_PRE_ENTRY_INTENT", decisionId=args.get("id"), input=clone(args),
                        assignmentId=self.job.get('assignmentId'))
        if args.get("action") == "REPLAN":
            verify_manifest(self.root, self.job, book.status)
            verify_v8_phase(self.engine, self.root, self.job)
            if self.engine.EXPERIMENT_BOOK is None:
                raise ValueError("Prospective assignment unavailable; no new child")
            self.engine.EXPERIMENT_BOOK.check_entry(parent)
        if args.get('symbol', symbol) != symbol or set(args.get('assessedOpportunityIds', [])) - {args['setupId']}:
            raise ValueError('Reassessment metadata must match selected plan')
        lesson_keys = {"appliedLessonIds", "applicableLessonIds", "rejectedLessonIds", "checks", "lessonRationale",
                       "assessedOpportunityIds", "symbol", "opportunityId"}
        usage = (self.lesson_usage({**args, "opportunityId": args["setupId"]}, "NO_TRADE")
                 if not known else {"replayed": True})
        result = book.reassess({k:v for k,v in args.items() if k not in lesson_keys})
        # Return the same semantics after the current host check, not just in the
        # original prompt. This changes no PlanBook receipt or execution outcome.
        current = book.view(book.get(args['setupId']))
        q = current['plan']
        px = snap['book']['ask' if q['side'] == 'LONG' else 'bid']
        result['hostDecisionFacts'] = host_decision_facts({
            'frozenPlan': q, 'assessment': result.get('hostValidation') or current.get('assessment'),
            'reassessment': current.get('reassessment'), 'reassessmentSnapshot': snap,
            'executablePrice': px,
            'adverseDisplacementBps': (px-q['triggerPrice']) / q['triggerPrice'] * 10000
                * (1 if q['side'] == 'LONG' else -1)})
        if result.get("childPlanId") and self.engine.EXPERIMENT_BOOK is not None:
            self.engine.EXPERIMENT_BOOK.bind_plan(book.get(result["childPlanId"]))
        self.assessed_symbols.add(symbol)
        record = self.record("ACTION_ACTUALITY", decisionId=args["id"], action=args["action"],
                             opportunityId=args["setupId"], positionId=None, result=result, executionResult=result,
                             outcome="REJECTED_BY_POLICY" if result["status"] == "REASSESSMENT_REJECTED" else "PLAN_UPDATED",
                             validAction=result["status"] != "REASSESSMENT_REJECTED", validDecision=True,
                             decisionValidatedAt=now_ms(), usage=usage)
        self.actions.append(record)
        return result

    def refresh_selected_row(self, symbol):
        """Re-read this symbol deterministically, immediately before the freeze is judged.

        `PlanBook.create` requires the symbol's row to be under 120s old. Model latency
        is routinely 130s-1200s, so by the time the model decides to enter, the host
        snapshot it reasoned over is already stale by construction and EVERY entry
        attempt failed on a window the model could not meet. Measured over 48h: gaps of
        230s, 254s, 984s, 1036s and 136s against a 120s window.

        This does not widen the window and does not restamp stale candles young. It
        fetches real current data for the one selected symbol — deterministic host work,
        no model involvement — so the risk envelope then judges the frozen band against
        the price NOW. A band that has drifted is correctly rejected; that rejection is
        the entry-displacement guard doing its job, not this refresh failing.
        """
        row = self.engine.PLAN_BOOK.rows.get(symbol)
        if row and now_ms() - row["observedAt"] <= ROW_REFRESH_AFTER_MS:
            return None
        from astra_v8_host import fetch_histories
        before = row["observedAt"] if row else None
        started = now_ms()
        # The incumbent full-context route also fetches expensive history. Reuse
        # its authenticated metadata contract (fees/filters/account), then fetch
        # only this symbol's closed candles and final BBO through the existing
        # bounded public TESTNET reader. No stale-row fallback or venue changes.
        fetched = fetch_histories(self.engine.gateway, [symbol], metadata_only=True)
        metadata_at = now_ms()
        from quant_candidate_refresh import refresh_candidates
        fetched = refresh_candidates(fetched)
        if fetched.get('marketDataComplete') is not True:
            raise ValueError('Selected symbol fresh Testnet candles/book incomplete; no freeze or order')
        market_at = now_ms()
        current = self.engine.gateway('/status')
        self.engine.validate_capital_identity(current)
        fetched['status'] = current
        fresh = next((r for r in fetched.get("rows", []) if r.get("symbol") == symbol), None)
        if not fresh:
            # Refusing is correct: no fresh data means no freeze, and the existing gate
            # will say so. Never fall through to the stale row.
            raise ValueError("Selected symbol is not currently readable; cannot freeze a setup on it")
        fresh = clone(fresh)
        fresh["observedAt"] = now_ms()
        self.engine.PLAN_BOOK.rows[symbol] = fresh
        self.engine.PLAN_BOOK.unavailable = clone(fetched.get("unavailableSymbols", []))
        self.engine.PLAN_BOOK.status = clone(fetched["status"])
        self.engine.PLAN_BOOK.status_observed_at = now_ms()
        self.journal.append("HOST_ROW_REFRESH", jobId=self.job["id"], symbol=symbol,
                            refreshMethod='METADATA_PUBLIC_TESTNET_V1',
                            metadataMs=metadata_at-started, marketMs=market_at-metadata_at,
                            accountMs=now_ms()-market_at, totalRefreshMs=now_ms()-started,
                            previousObservedAt=before, observedAt=fresh["observedAt"],
                            stalenessMs=(fresh["observedAt"] - before) if before else None,
                            meaning="Deterministic re-read before freezing; the band is judged "
                                    "against the current price, never against the older snapshot")
        return fresh

    def canonical_call(self, args):
        operation = args.get("operation")
        if operation == "LIST":
            return clone(self.context)
        if operation not in ("REVIEW", "PUBLISH"):
            raise ValueError("Only canonical LIST/REVIEW/PUBLISH are available")
        guard_mode = COACHING if self.mode in REVIEW_MODES else self.mode
        FAST.guard_operation(guard_mode, operation, budget_lane=guard_mode)
        if operation == "REVIEW":
            value = require_fields(args.get("review"), ("id", "evidenceId", "body"), "astra_learn REVIEW review")
            ids = {row["evidenceId"] for row in self.context["canonicalEvidence"]}
            if value["evidenceId"] not in ids:
                raise ValueError("Review evidence must be in the supplied canonical job; supplied evidenceIds are: "
                                 + ", ".join(sorted(ids)))
            explain_review_body(value["body"])
            result = self.canonical.review(value["id"], value["evidenceId"], value["body"])
        else:
            value = require_fields(args.get("lesson"),
                                   ("lessonId", "body", "evidenceIds", "scope", "condition", "check", "support"),
                                   "astra_learn PUBLISH lesson")
            supplied={r['evidenceId'] for r in self.context['canonicalEvidence']+self.context.get('supportEvidence',[])}
            if not set(value['evidenceIds']) <= supplied:
                raise ValueError('Publication evidence must be supplied in this coaching context')
            result = self.canonical.publish(value["lessonId"], value["body"], value["evidenceIds"],
                                            value["scope"], value["condition"], value["check"],
                                            value["support"], value.get("errorType", "UNKNOWN"))
        self.persist_canonical()
        self.reviews.append(self.record("CANONICAL_" + operation, result=result))
        return result

    def persist_canonical(self):
        if self.mode not in REVIEW_MODES:
            raise RuntimeError("Only COACHING may persist the canonical overlay")
        events = self.canonical.export()
        if len(events) > self.canonical_saved:
            self.canonical_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.canonical_path.with_suffix(".tmp")
            with temporary.open("w") as stream:
                json.dump(events, stream, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.canonical_path)
            self.canonical_saved = len(events)

    def lesson_usage(self, args, action):
        identity = args.get("positionId") or args.get("opportunityId") or args.get("setupId")
        context = self.lesson_contexts.get(identity)
        if context is None and identity:
            side = args.get("side") or (args.get("plan") or {}).get("side") or AD.GATEWAY[action].get("side")
            context = self.lesson_contexts.get(identity + ":" + str(side))
        if context is None and "plan" in args:
            plan = args["plan"]
            context = {**clone(plan), **self.context.get("policyVersions", {}), "cohort": COHORT,
                       "fingerprint": self.job["fingerprint"], "evaluatingAction": action, "phase": "ENTRY"}
        context = context or {**self.context.get("policyVersions", {}), "cohort": COHORT,
                              "fingerprint": self.job["fingerprint"], "evaluatingAction": "NO_TRADE"}
        allowed = [l["lessonId"] for l in self.lessons]
        superseded = []
        if allowed and self.canonical_path.exists():
            # No delivered lessons means no permitted publication can become
            # newly applicable mid-decision. Keep DELIVERY/CHECKS/APPLICATION
            # below, but do not replay the entire archive for an empty allowlist.
            latest = CanonicalBook(json.loads(self.canonical_path.read_text()))
            current = {p["lessonId"]: p for p in latest.deliver(args["id"], context,
                       allowed_lesson_ids=allowed)["procedures"]}
            # A freshness probe is a comparison, not a delivery: run it on a throwaway
            # copy so the real journal gains no record, and give every lesson its own
            # key because one decision id can only ever be delivered once.
            baseline = CanonicalBook(self.canonical.export())
            for lesson in self.lessons:
                # Relevance is checked separately: only compare procedures applicable to this context.
                original = baseline.deliver(args["id"] + ":freshness:" + lesson["lessonId"], context,
                                            allowed_lesson_ids=[lesson["lessonId"]])["procedures"]
                if original and current.get(lesson["lessonId"]) != original[0]:
                    superseded.append(lesson["lessonId"])
            allowed = [ident for ident in allowed if ident not in superseded]
            if superseded:
                self.record("LESSON_SUPERSEDED", decisionId=args["id"], lessonIds=superseded,
                            reason="Canonical evidence/version/retirement changed during model session")
        delivery = self.canonical.deliver(args["id"], context,
                                         allowed_lesson_ids=allowed)
        checks = self.canonical.run_checks(args["id"])
        rejected = args.get("rejectedLessonIds") or {}
        if isinstance(rejected, list):
            rejected = {r["lessonId"]: r["reason"] for r in rejected}
        usage = self.canonical.verify(args["id"], action, args.get("appliedLessonIds", []), rejected)
        self.record("LESSON_APPLICATION", decisionId=args["id"], delivery=delivery, checks=checks, usage=usage,
                    supersededLessonIds=superseded,
                    verificationScope="INTENT_CONSISTENCY_NOT_EXECUTION_OR_PROFIT")
        return usage

    def normalize(self, args, fused):
        original_action = args.get("action")
        action = original_action
        if action == "HOLD_WITH_REASON":
            if not isinstance(args.get("missingDataReason"), str) or not args["missingDataReason"].strip():
                raise ValueError("HOLD_WITH_REASON requires missingDataReason")
            action = "HOLD"
        if action not in AD.GATEWAY or (fused and action not in AD.ENTRIES):
            raise ValueError("Explicit V7 action required; REDUCE/amendments and raw OPEN/CLOSE/WAIT unavailable")
        FAST.guard_operation(self.mode, action, budget_lane=self.mode)
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", str(args.get("id", ""))):
            raise ValueError("Decision id must be 8-80 alphanumeric/underscore/hyphen characters")
        if not isinstance(args.get("reason"), str) or not 10 <= len(args["reason"]) <= 4000:
            raise ValueError("Decision requires a concrete 10-4000 character reason")
        model_only = {"positionId", "opportunityId", "assessedOpportunityIds", "appliedLessonIds", "rejectedLessonIds", "applicableLessonIds",
                      "deliveredLessonIds", "procedureVersions", "checks", "missingDataReason", "lessonRationale", "candidateAssessments",
                      "setupType", "playbooks"}
        allowed = model_only | {"id", "action", "reason", "symbol", "side", "setupId", "vetoReason", "plan"}
        if set(args) - allowed:
            raise ValueError("Unsupported action fields: " + str(sorted(set(args) - allowed)))
        if 'setupType' in args and (not isinstance(args['setupType'], str) or not 1 <= len(args['setupType']) <= 120):
            raise ValueError('setupType must be a bounded descriptive label')
        if 'playbooks' in args and (not isinstance(args['playbooks'], list) or len(args['playbooks']) > 3
                or any(p not in ('P1', 'P2', 'P3') for p in args['playbooks'])):
            raise ValueError('playbooks must contain only P1/P2/P3 reference labels')
        if action in AD.ENTRIES and ('plan' in args) == ('setupId' in args):
            raise ValueError('Entry requires exactly one of plan or setupId; an existing frozen plan uses setupId only. Use REPLAN for changes.')
        candidates = {o["opportunityId"]: (o.get("symbol") or o.get("frozenPlan", {}).get("symbol"))
                      for o in self.context.get("marketCandidates", []) + self.context.get("opportunities", [])}
        assessed = args.get("assessedOpportunityIds", [])
        if not isinstance(assessed, list) or any(not isinstance(i, str) or i not in candidates for i in assessed):
            raise ValueError("assessedOpportunityIds must enumerate supplied candidate IDs")
        if action == "NO_TRADE" and self.context.get("marketCandidates") and not assessed:
            raise ValueError("NO_TRADE requires assessedOpportunityIds; no blanket all-market claim")
        if action in POSITION_ACTIONS:
            pid = args.get("positionId")
            if pid not in self.positions:
                raise ValueError("Management requires an owned positionId")
            p = self.positions[pid]
            if any(k in args and args[k] != p.get(k) for k in ("symbol", "side")):
                raise ValueError("Management position identity mismatch")
        elif set(self.positions) - self.covered:
            raise ValueError("Explicit position action missing: " + ",".join(sorted(set(self.positions) - self.covered)))
        mapping = AD.GATEWAY[action]
        if "side" in mapping and "side" in args and args["side"] != mapping["side"]:
            raise ValueError("Entry action and side disagree")
        request = {k: v for k, v in args.items() if k not in model_only and k != "plan"}
        request.update(mapping)
        if action in POSITION_ACTIONS:
            request["tradeId"] = args["positionId"]
            request["symbol"] = self.positions[args["positionId"]]["symbol"]
        if original_action == "HOLD_WITH_REASON":
            request["reason"] = ("MISSING_DATA: " + args["missingDataReason"] + " | " + args["reason"])[:4000]
        return action, request

    def fresh_management(self, args):
        fresh = self.original_gateway("/status")
        self.gateway_calls += 1
        if fresh.get("environment") != "testnet":
            raise ValueError("Fresh Testnet management state unavailable")
        verify_manifest(self.root, self.job, fresh)
        current = next((p for p in fresh.get("active", []) if p.get("id") == args["positionId"]), None)
        if current is None or position_signature(current) != position_signature(self.positions[args["positionId"]]):
            raise ValueError("STALE_ACTION: owned position state changed; host must supply a new event")
        maximum = self.job.get("maxActionAgeMs")
        if maximum is not None and (elapsed(self.job.get("contextBuiltAt"), now_ms()) is None
                                   or now_ms() - self.job["contextBuiltAt"] > maximum):
            raise ValueError("STALE_ACTION: host action age limit exceeded")
        return now_ms()

    def gateway(self, path, payload=None):
        if self.mode != FAST_TRADING:
            raise RuntimeError("COACHING gateway forbidden")
        if path not in ("/status", "/context", "/decision"):
            raise RuntimeError("No old learning/report gateway calls in V8 worker")
        if path == "/decision":
            if self.active_intent is None:
                raise RuntimeError("Gateway request has no immutable V8 decision intent")
            if payload.get("action") in ("OPEN", "CLOSE"):
                verify_manifest(self.root, self.job, self.engine.PLAN_BOOK.status)
            if payload.get("action") == "OPEN":
                verify_v8_phase(self.engine, self.root, self.job)
                p = self.engine.PLAN_BOOK.get((payload.get("entryContract") or {}).get("planId"))
                if not p.get("v2") or p.get("v2Retired") or p["v2"].get("failedAt") or p["v2"]["status"] == "WAITING":
                    raise ValueError("Old/retired plan cannot open exposure under V2")
            prior = [r for r in self.journal.records if r["kind"] == "REQUEST"
                     and r["decisionId"] == self.active_intent]
            if prior and prior[0]["request"] != payload:
                raise ValueError("Reconciliation requires the exact original gateway request")
            if not prior:
                self.record("REQUEST", decisionId=self.active_intent, request=payload)
            self.record("REQUEST_ATTEMPT", decisionId=self.active_intent,
                        gatewayRequestAt=now_ms(), isReconciliation=bool(prior))
        self.gateway_calls += 1
        result = self.original_gateway(path, payload)
        if path == "/decision":
            self.record("GATEWAY_RESULT", decisionId=self.active_intent, result=result)
        return result

    def decide(self, args, fused=False):
        if "opportunityId" in args and "setupId" not in args and "plan" not in args and any(
                o["opportunityId"] == args["opportunityId"] for o in self.context.get("opportunities", [])):
            args["setupId"] = args["opportunityId"]
        action, request = self.normalize(args, fused)
        # Both advertised entry tools use the same explicit-intent path. Never
        # pass model metadata or lose a supplied plan in the legacy OPEN adapter.
        fused = action in AD.ENTRIES
        old = next((r for r in self.journal.records if r["kind"] == "DECISION_INTENT"
                    and r["decisionId"] == args["id"]), None)
        if old:
            if old["input"] != args:
                raise ValueError("Decision id reused with different intent; exact original only")
            return self.reconcile(old)
        # A new id must never replace an unresolved exposure, even within this job.
        symbol = (args.get("plan") or {}).get("symbol") or args.get("symbol")
        if args.get("positionId") in self.positions:
            symbol = self.positions[args["positionId"]]["symbol"]
        if args.get("setupId"):
            symbol = self.engine.PLAN_BOOK.get(args["setupId"])["plan"]["symbol"]
        for prior in self.journal.records:
            if prior["kind"] != "DECISION_INTENT" or prior["decisionId"] == args["id"]:
                continue
            attempts = [r for r in self.journal.records if r["kind"] == "REQUEST" and r["decisionId"] == prior["decisionId"]]
            outcomes = [r for r in self.journal.records if r["kind"] == "ACTION_ACTUALITY" and r["decisionId"] == prior["decisionId"]]
            if attempts and (not outcomes or outcomes[-1]["outcome"] == "UNRESOLVED_RECONCILE"):
                old_request = attempts[0]["request"]
                if (symbol and old_request.get("symbol") == symbol or args.get("positionId") and
                        old_request.get("tradeId") == args["positionId"]):
                    raise ValueError("Unresolved exposure: reconcile exact original decision " + prior["decisionId"])
        # Persist the choice before any fresh read, plan mutation or gateway request.
        intent = self.record("DECISION_INTENT", decisionId=args["id"], input=args, decisionToolRequestedAt=now_ms(),
                             candidateReport=DISPOSITION.build_report(args,self.context,now_ms()),
                             action=action, translated=request, fused=fused,
                             assignmentId=self.job.get("assignmentId"),
                             deliveredLessonIds=[l.get("lessonId", l.get("id")) for l in self.lessons])
        selected = set(args.get("assessedOpportunityIds", []))
        if args.get("opportunityId"):
            selected.add(args["opportunityId"])
        for candidate in self.context.get("marketCandidates", []) + self.context.get("opportunities", []):
            if candidate["opportunityId"] in selected:
                self.assessed_symbols.add(candidate.get("symbol") or candidate["frozenPlan"]["symbol"])
        self.active_intent = args["id"]
        validated = None
        try:
            usage = self.lesson_usage(args, action)
            self.record("DECISION_VALIDATED", decisionId=args["id"], usage=usage, decisionValidatedAt=now_ms())
            if action in POSITION_ACTIONS:
                validated = self.fresh_management(args)
            if fused:
                entry = {k: args[k] for k in ("id", "reason", "plan", "setupId") if k in args}
                plan = entry.get("plan") or self.engine.PLAN_BOOK.get(entry.get("setupId"))["plan"]
                if plan["side"] != AD.GATEWAY[action]["side"]:
                    raise ValueError("Entry action differs from frozen plan side")
                if plan['symbol'] not in self.engine.PLAN_BOOK.rows:
                    raise ValueError('Entry must use a host-selected symbol')
                # Existing invalid plans must fail before either refresh layer.
                # This only skips reads for rejection; never authorizes execution.
                parent = self.engine.PLAN_BOOK.get(entry['setupId']) if entry.get('setupId') else None
                if parent is None:
                    from astra_plans import validate_entry_geometry
                    validate_entry_geometry(plan, self.engine.PLAN_BOOK.cap)
                if parent is None or not self.engine.entry_lifecycle_blocked(parent):
                    self.refresh_selected_row(plan['symbol'])
                result = json.loads(self.engine.enter_result(entry))
            else:
                result = json.loads(self.engine.decision_result(request))
            validated = (result.get("entryLatency") or {}).get("finalCheckAt", validated)
        except Exception as error:
            submitted = any(r["kind"] == "REQUEST" and r["decisionId"] == args["id"] for r in self.journal.records)
            result = {"status": "REJECTED_OR_UNRESOLVED" if submitted else "V8_REJECTED",
                      "errorDetail": str(error)}
            if not submitted and getattr(error, "diagnostic", None):
                result["geometryDiagnostic"] = clone(error.diagnostic)
        finally:
            self.active_intent = None
        return self.actuality(intent, result, validated)

    def actuality(self, intent, result, validated=None):
        if self.engine and intent["action"] in AD.ENTRIES:
            pid = intent["input"].get("setupId") or (intent["input"].get("plan") or {}).get("id")
            if pid:
                try:
                    self.engine.PLAN_BOOK.record_rejection(self.engine.PLAN_BOOK.get(pid))
                except ValueError:
                    pass  # A constructor rejection never created a plan.
            if pid and result.get('status') == 'SETUP_NOT_READY' and result.get('noOrderSubmitted') is True:
                p = self.engine.PLAN_BOOK.get(pid)
                a, q, v = p.get('assessment') or {}, p['plan'], p.get('v2') or {}
                new_plan = bool(intent['input'].get('plan') and
                                p.get('createdAt', 0) >= intent['recordedAt'])
                awaiting_price = (bool(a.get('failed')) and not v.get('failedAt') and
                                  not set(a.get('failed', [])) - {'trigger', 'entryBand'})
                result['entryDiagnostic'] = {
                    'source': 'HOST_PERSISTED_PLAN_ASSESSMENT_V1', 'planId': pid,
                    'planPersisted': True, 'planCreatedAt': p.get('createdAt'),
                    'failureOrigin': ('AWAITING_PRICE_NOT_PLAN_FAILURE' if awaiting_price else
                                      'NEW_PLAN_FAILED_INITIAL_CHECK' if new_plan else 'EXISTING_PLAN_LIFECYCLE'),
                    'failedAt': v.get('failedAt'), 'failedPredicates': v.get('failedPredicates', a.get('failed', [])),
                    'assessmentAt': a.get('at'), 'costBps': a.get('costBps'),
                    'maxCostBps': q['maxCostBps'], 'candleClose': a.get('candleClose'),
                    'triggerKind': q['triggerKind'], 'triggerPrice': q['triggerPrice'],
                    'orderSubmitted': False,
                    'meaning': ('Price condition not reached; no order submitted and no failure inferred.' if awaiting_price else
                                'Historical rejection evidence, not a fresh quote or permission to retry. WAIT does not clear a failed plan.')}
        actual_results = [r for r in self.journal.records if r["kind"] == "GATEWAY_RESULT"
                          and r["decisionId"] == intent["decisionId"]]
        execution_result = actual_results[-1]["result"] if actual_results else result
        outcome = AD.classify(intent["action"], execution_result)
        if (execution_result.get("status") == "ENTRY_REJECTED"
                and execution_result.get("noOrderSubmitted") is True
                and (execution_result.get("entryGate") or {}).get("executionVersion") == "astra-final-book-contract-v1-20260909"):
            outcome = "REJECTED_BY_POLICY"
        if not actual_results and (result.get("status") == "V8_REJECTED" or result.get("entry_error")):
            outcome = "REJECTED_BY_POLICY"
        if outcome == "INVALID_MODEL_RESPONSE" and any(r["kind"] == "REQUEST" and
                r["decisionId"] == intent["decisionId"] for r in self.journal.records):
            outcome = "UNRESOLVED_RECONCILE"
        valid = outcome in ("VALID_NO_TRADE", "OPEN", "PARTIALLY_FILLED", "SETTLED",
                            "EXECUTED_MANAGEMENT", "NO_FILL_CONFIRMED")
        if intent["action"] in POSITION_ACTIONS and valid:
            self.covered.add(intent["input"]["positionId"])
        timing = execution_times(intent["action"], execution_result, intent["recordedAt"])
        record = self.record("ACTION_ACTUALITY", decisionId=intent["decisionId"], action=intent["action"],
                             positionId=intent["input"].get("positionId"),
                             opportunityId=intent["input"].get("opportunityId") or intent["input"].get("setupId"),
                             outcome=outcome, validAction=valid, result=result, executionResult=execution_result,
                             validDecision=valid or (intent["action"] in AD.ENTRIES and outcome == "REJECTED_BY_POLICY"
                               and execution_result.get("status") in ("ENTRY_REJECTED", "SETUP_NOT_READY", "SETUP_DATA_UNAVAILABLE")),
                             decisionValidatedAt=validated,
                             decisionToolRequestedAt=intent.get("decisionToolRequestedAt"), **timing)
        self.actions.append(record)
        response={"decisionId": intent["decisionId"], "action": intent["action"], "outcome": outcome, "result": result}
        if intent.get('candidateReport') is not None:
            response['candidateReport']={**clone(intent['candidateReport']),
                'decisionExecutionOutcome':'NO_NEW_POSITION' if outcome=='VALID_NO_TRADE' else 'UNCONFIRMED',
                'hostOutcome':outcome}
        return response

    def reconcile(self, intent):
        previous = [r for r in self.journal.records if r["kind"] == "ACTION_ACTUALITY"
                    and r["decisionId"] == intent["decisionId"]]
        if previous and previous[-1]["outcome"] != "UNRESOLVED_RECONCILE":
            self.actions.append(previous[-1])
            if previous[-1]["validAction"] and intent["action"] in POSITION_ACTIONS:
                self.covered.add(intent["input"]["positionId"])
            response={"duplicate": True, **previous[-1]}
            if intent.get('candidateReport') is not None:
                outcome=previous[-1]['outcome']
                response['candidateReport']={**clone(intent['candidateReport']),
                    'decisionExecutionOutcome':'NO_NEW_POSITION' if outcome=='VALID_NO_TRADE' else 'UNCONFIRMED',
                    'hostOutcome':outcome}
            return response
        requests = [r for r in self.journal.records if r["kind"] == "REQUEST"
                    and r["decisionId"] == intent["decisionId"]]
        if not requests:
            # Crash before first request: do not manufacture a stale new execution.
            return self.actuality(intent, {"status": "V8_REJECTED", "errorDetail": "INTENT_WITHOUT_REQUEST_REQUIRES_NEW_EVENT"})
        self.active_intent = intent["decisionId"]
        try:
            result = self.gateway("/decision", clone(requests[0]["request"]))
            if self.engine.EXPERIMENT_BOOK is not None:
                self.engine.EXPERIMENT_BOOK.record_result(intent["decisionId"], result)
        except Exception as error:
            result = {"status": "REJECTED_OR_UNRESOLVED", "errorDetail": str(error)}
        finally:
            self.active_intent = None
        return self.actuality(intent, result)


def tool_schemas(engine):
    action_properties = {k: {"type": "string"} for k in ("id", "action", "reason", "positionId", "opportunityId", "symbol",
                        "side", "setupId", "vetoReason", "missingDataReason", "lessonRationale")}
    action_properties["action"]["enum"] = list(AD.GATEWAY) + ["HOLD_WITH_REASON"] + list(REPLAN.ACTIONS)
    action_properties['id']['description'] = ('Optional for NEW intent: omit to let host assign a '
        'stable job+payload id. Explicit id is immutable, not a batch/plan id. '
        'Retry uncertain execution with exact original id AND payload; never change intent.')
    for key in (*REPLAN.EXPLANATIONS, "snapshotId", "setupType"):
        action_properties[key] = {"type": "string"}
    action_properties["evidenceCandleAt"] = {"type": "number"}
    action_properties["playbooks"] = {"type": "array", "items": {"type": "string", "enum": ["P1", "P2", "P3"]}}
    action_properties["plan"] = engine.PLAN_SCHEMA["parameters"]["properties"]["plan"]
    for key in ("appliedLessonIds", "applicableLessonIds", "assessedOpportunityIds"):
        action_properties[key] = {"type": "array", "items": {"type": "string"}}
    action_properties["rejectedLessonIds"] = {"type": "array", "items": {"type": "object"}}
    action_properties['candidateAssessments']=clone(DISPOSITION.SCHEMA)
    action_properties["checks"] = {"type": "array", "items": {"type": "object"}}
    def schema(name, props, required=()):
        return {"name": name, "description": "V8 mode-guarded " + name,
                "parameters": {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}}
    schemas = {
        "astra_context": schema("astra_context", {"symbols": {"type": "array", "items": {"type": "string"}}}),
        "astra_decide": schema("astra_decide", action_properties, ("action", "reason")),
        "astra_enter": schema("astra_enter", {**action_properties, "plan": engine.PLAN_SCHEMA["parameters"]["properties"]["plan"]}, ("action", "reason")),
        "astra_plan": clone(engine.PLAN_SCHEMA),
        "astra_experiment": schema("astra_experiment", {"operation": {"type": "string", "enum": ["LIST"]}}),
        # The shape is spelled out because it is not guessable. Declared as a bare
        # {"type": "object"}, the model had to infer `id`/`evidenceId`/`body` and the
        # body's exact key set, got bare KeyErrors back, and every COACHING cycle in the
        # lane's history ended INVALID_MODEL_RESPONSE after ~9 failed attempts.
        # This describes the EXISTING contract in astra_canonical_v8; it relaxes nothing.
        "astra_learn": schema("astra_learn", {
            "operation": {"type": "string", "enum": ["LIST", "REVIEW", "PUBLISH"]},
            "review": {"type": "object", "required": ["id", "evidenceId", "body"],
                       "description": "REVIEW only. body takes EXACTLY these keys and no others.",
                       "properties": {
                           "id": {"type": "string", "description": "Your new unique review id"},
                           "evidenceId": {"type": "string",
                                          "description": "Must be an evidenceId from the supplied canonicalEvidence"},
                           "body": {"type": "object",
                                    "required": ["axes", "observedMechanism", "requiredAction", "exceptions"],
                                    "properties": {
                                        "axes": {"type": "object",
                                                 "description": "Object with EXACTLY these seven keys, each a non-empty string: "
                                                                + ", ".join(CANONICAL_AXES)},
                                        "observedMechanism": {"type": "string"},
                                        "requiredAction": {"type": "string"},
                                        "exceptions": {"type": "string"},
                                        "outcomeClassification": {"type": "string",
                                                                  "description": "Optional; the only additional key permitted"}}}}},
            "lesson": {"type": "object", "required": ["lessonId", "body", "evidenceIds", "scope", "condition", "check", "support"],
                       "description": "PUBLISH only.",
                       "properties": {
                           "lessonId": {"type": "string"},
                           "body": {"type": "object", "required": ["observedMechanism", "requiredAction", "exceptions"],
                                    "description": "EXACTLY these three keys, each a non-empty string"},
                           "evidenceIds": {"type": "array", "items": {"type": "string"},
                                           "description": "Distinct canonical evidence IDs"},
                           "scope": {"type": "object"},
                           "condition": {"type": "object", "description": "{op: eq|lte|gte|between, field: ...}"},
                           "check": {"type": "object", "required": ["predicate", "passActions", "failActions"],
                                     "description": "passActions/failActions are non-empty lists of allowed actions"},
                           "support": {"type": "object", "description": "{op: eq|lte|gte|between, field: ...}"},
                           "errorType": {"type": "string"}}}}),
        "memory": schema("memory", {"action": {"type": "string"}, "content": {"type": "string"}}),
    }
    schemas = clone(schemas)
    entry_props = schemas['astra_enter']['parameters']['properties']
    entry_props['action']['enum'] = sorted(AD.ENTRIES)
    for field in (*REPLAN.EXPLANATIONS, 'snapshotId', 'evidenceCandleAt'):
        entry_props.pop(field, None)
    schemas['astra_enter']['parameters']['oneOf'] = [
        {'required': ['plan'], 'not': {'required': ['setupId']}},
        {'required': ['setupId'], 'not': {'required': ['plan']}}]
    schemas['astra_enter']['description'] = ('Explicit entry only. Supply exactly one of a new plan or existing setupId. '
        'setupType/playbooks are report metadata only. Never resubmit an edited frozen plan; use REPLAN. '
        'Risk, cost, freshness and final executable-price checks remain authoritative.')
    for name in ('astra_plan', 'astra_enter', 'astra_decide'):
        props = schemas[name]['parameters']['properties'].get('plan', {}).get('properties', {})
        for field, maximum in (('notionalUsd', 25), ('entrySlippageBps', 100)):
            if field in props:
                props[field].update(exclusiveMinimum=0, maximum=maximum)
    return schemas


def check_agent_identity(model, provider, tools, spec):
    """A silently substituted model is a different decision policy wearing the frozen
    policy's records, so a mismatch fails the job rather than running it."""
    if tools != ALLOWLIST:
        raise IntegrationError("V8 tool isolation failed: " + str(sorted(tools)))
    if model != spec["model"] or provider != spec["provider"]:
        raise IntegrationError("V8 model isolation failed: expected " + spec["model"] + "/" + spec["provider"]
                               + " got " + str(model) + "/" + str(provider))
    return True


def automatic_intent_id(job_id, args):
    """Identity only; no retry, remapping of explicit IDs, or execution authority."""
    if 'id' in args:
        raise ValueError('Explicit decision id must never be remapped')
    return 'v8-auto-' + digest({'jobId': job_id, 'intent': args})[:40]


def pending_candidate_assessments(session):
    reports = DISPOSITION.cycle_reports(session.journal.records,session.job['id'],session.actions)
    accepted = {r['opportunityId'] for report in reports
                if report.get('decisionExecutionOutcome') == 'NO_NEW_POSITION'
                and report.get('reportingStatus') == 'COMPLETE'
                for r in report.get('candidates',[]) if r.get('reportingStatus') == 'COMPLETE'}
    return sorted({r['opportunityId'] for report in reports
                   if report.get('decisionExecutionOutcome') != 'NO_NEW_POSITION'
                   or report.get('reportingStatus') != 'COMPLETE'
                   for r in report.get('candidates',[])
                   if r.get('opportunityId') and r['opportunityId'] not in accepted})


def confirmed_candidate_completion(session):
    """A narrow host terminal, never inferred from prose or a subset of candidates.

    Plan/position jobs retain the entire original conversation; a rejected entry
    or a partial/invalid report can never be turned into a successful completion.
    """
    if session.mode != FAST_TRADING or session.positions or session.context.get('opportunities'):
        return None
    candidates = session.context.get('marketCandidates', [])
    expected = {r.get('opportunityId'): r for r in candidates}
    if not expected or None in expected or len(expected) != len(candidates):
        return None
    if not session.actions or any(a.get('action') != 'NO_TRADE' or
            a.get('outcome') != 'VALID_NO_TRADE' or a.get('validAction') is not True
            for a in session.actions):
        return None
    reports = DISPOSITION.cycle_reports(session.journal.records, session.job['id'], session.actions)
    assessed = {}
    for report in reports:
        if (report.get('reportingStatus') != 'COMPLETE' or
                report.get('decisionExecutionOutcome') != 'NO_NEW_POSITION'):
            return None
        for row in report.get('candidates', []):
            oid = row.get('opportunityId')
            if (oid not in expected or oid in assessed or row.get('reportingStatus') != 'COMPLETE'
                    or row.get('issues') or row.get('symbol') != expected[oid].get('symbol')
                    or row.get('candidateDisposition') not in ('NO_TRADE', 'WATCH')):
                return None
            assessed[oid] = row
    if set(assessed) != set(expected):
        return None
    lines = ['HOST-CONFIRMED DECISION RECEIPT (not a second model response).',
             'BATCH_ACTION: NO_NEW_POSITION. All supplied candidate assessments persisted.',
             'Report completeness verifies structure/coverage, not factual accuracy or alpha.']
    for oid, row in assessed.items():
        facts = expected[oid].get('candidateDecisionFacts') or candidate_decision_facts(expected[oid])
        lines.append(str(row['symbol']) + ' | ' + row['candidateDisposition'] +
                     ' | host input facts: ' + json.dumps(facts, sort_keys=True, allow_nan=False))
    lines.append('Original model rationale and WATCH conditions remain in candidateReports and the durable journal. No order submitted.')
    return '\n'.join(lines)


@contextmanager
def candidate_terminal_scope(agent, session):
    """Worker-process-only adapter; shared Hermes source and other lanes untouched.

    Run the complete original tool round, including all tools and persistence
    checks. Only then return BREAK through Hermes' normal finalizer/usage/lease
    cleanup, rather than interrupting or manufacturing a provider response.
    """
    if not getattr(agent, '_astra_candidate_terminal', False):
        yield
        return
    from functools import wraps
    from agent import conversation_loop
    original = conversation_loop.run_tool_round
    @wraps(original)
    def wrapped(current_agent, **kwargs):
        names = [c.function.name for c in kwargs['assistant_message'].tool_calls]
        before_actions, before_records = len(session.actions), len(session.journal.records)
        verdict = original(current_agent, **kwargs)
        if (current_agent is not agent or verdict.action != 'continue' or verdict.failed
                or getattr(agent, '_incremental_persistence_failed', False)
                or getattr(agent, '_tool_guardrail_halt_decision', None) is not None
                or getattr(agent, 'is_interrupted', False)
                or kwargs.get('api_call_count', 0) >= agent.max_iterations):
            return verdict
        # Invalid/error tools need their normal repair turn, even when another
        # call in the same batch happened to persist a complete decision.
        if (not names or any(name != 'astra_decide' for name in names)
                or len(session.actions) - before_actions != len(names)
                or any(r.get('kind') == 'TOOL_REJECTED' for r in session.journal.records[before_records:])):
            return verdict
        response = confirmed_candidate_completion(session) or confirmed_management_completion(session)
        if response is not None:
            verdict.action = 'break'
            verdict.final_response = response
            verdict._turn_exit_reason = 'host_confirmed_candidate_completion'
            agent._astra_host_terminal = True
        return verdict
    conversation_loop.run_tool_round = wrapped
    try:
        yield
    finally:
        conversation_loop.run_tool_round = original


def confirmed_management_completion(session):
    """Terminal only for fully persisted WAIT/ABANDON/HOLD jobs.

    Entries, closes, replans and any failed action retain the normal repair flow.
    This removes redundant prose, not model authority to repair an execution.
    """
    if session.mode != FAST_TRADING or not session.actions:
        return None
    if session.context.get('marketCandidates'):
        return None
    expected_plans = {o.get('opportunityId') for o in session.context.get('opportunities', [])}
    expected_positions = set(session.positions)
    if None in expected_plans or not (expected_plans or expected_positions):
        return None
    plans, positions = set(), set()
    for action in session.actions:
        if action.get('validAction') is not True:
            return None
        kind, result = action.get('action'), action.get('result') or {}
        if kind in ('WAIT', 'ABANDON_SETUP'):
            allowed = ('WAITING', 'AWAITING_ENTRY') if kind == 'WAIT' else ('ABANDONED',)
            if (action.get('outcome') != 'PLAN_UPDATED' or result.get('status') not in allowed
                    or result.get('noOrderSubmitted') is not True
                    or action.get('opportunityId') not in expected_plans):
                return None
            plans.add(action['opportunityId'])
        elif kind in ('HOLD', 'HOLD_WITH_REASON'):
            if (action.get('outcome') not in ('VALID_NO_TRADE', 'EXECUTED_MANAGEMENT')
                    or action.get('positionId') not in expected_positions):
                return None
            positions.add(action['positionId'])
        else:
            return None
    if plans != expected_plans or positions != expected_positions:
        return None
    return ('HOST-CONFIRMED DECISION RECEIPT (not model prose).\n'
            'All supplied plan/position management decisions persisted; no new entry authority.\n' +
            '\n'.join(str(a.get('decisionId')) + ' | ' + a['action'] + ' | ' + a['outcome']
                      for a in session.actions))


def make_agent(*, session, system_prompt, max_turns, budget_seconds):
    """Dedicated worker only: registry/engine globals are not thread-safe sessions."""
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from agent import agent_init
    from tools.registry import registry
    engine = session.engine or importlib.import_module("astra_runner")
    for name, schema in tool_schemas(engine).items():
        registry.register(name=name, toolset="memory" if name == "memory" else "astra_testnet",
                          schema=schema, handler=lambda args, _name=name, **kw: session.call(_name, args),
                          check_fn=lambda: True, override=True)
    spec = session.model_policy
    if not ROUTER.is_declared(spec):
        raise IntegrationError('Undeclared model policy at provider construction')
    runtime = resolve_runtime_provider(requested=spec["provider"], target_model=spec["model"])
    db = SessionDB(db_path=session.root / "hermes-home" / ("astra-v8-" + session.mode.lower() + ".db"))
    original = agent_init._init_memory
    def guarded_memory(agent, config, skip_memory, platform):
        # Guard before constructor prompt creation; skip_memory alone still loads MEMORY.md.
        agent._memory_store = agent._memory_manager = None
        agent._memory_enabled = agent._user_profile_enabled = False
        agent._memory_nudge_interval = 10
        agent._turns_since_memory = agent._iters_since_skill = 0
    agent_init._init_memory = guarded_memory
    try:
        agent = AIAgent(model=spec["model"], provider=runtime["provider"], api_key=runtime["api_key"],
                        base_url=runtime["base_url"], api_mode=runtime["api_mode"],
                        reasoning_config={"enabled": True, "effort": spec["effort"]},
                        enabled_toolsets=["astra_testnet", "memory"], max_iterations=max_turns,
                        run_budget_seconds=budget_seconds, quiet_mode=True, skip_context_files=True,
                        skip_memory=True, skip_background_review=True, load_soul_identity=False,
                        ephemeral_system_prompt=system_prompt, session_id=session.session_id,
                        session_db=db, fallback_model=None)
        try:
            check_agent_identity(agent.model, agent.provider,
                                 {t.get("function", t).get("name") for t in agent.tools}, spec)
        except IntegrationError:
            agent.close()
            raise
        agent._v8_session_db = db
        agent._astra_candidate_terminal = session.mode == FAST_TRADING
        return agent
    except Exception:
        db.close()
        raise
    finally:
        agent_init._init_memory = original


@contextmanager
def job_lock(root, mode):
    # Fail closed for concurrent invocations in one interpreter; protection runs elsewhere.
    if not PROCESS_LOCK.acquire(blocking=False):
        raise IntegrationError("Separate worker processes required for concurrent V8 jobs")
    try:
        path = Path(root) / "logs" / ("astra-v8-" + mode.lower() + ".lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
    finally:
        PROCESS_LOCK.release()


def run_job(root, job, mode=None, *, agent_factory=None, engine=None, canonical=None):
    """Run one host-built job; no scan, scheduler, monitor, or provider fallback.

    Injected factories receive session, system_prompt, max_turns, budget_seconds
    and return an agent exposing run_conversation(prompt) and close(). Tests must
    inject an engine whose gateway never sends real orders.
    """
    root, job = Path(root), clone(job)
    mode = mode or job.get("mode")
    if mode not in BUDGET_SECONDS or job.get("mode", mode) != mode:
        raise IntegrationError("Unknown/mismatched V8 mode")
    if not job.get("id") or job.get("cohortId") != COHORT or not job.get("fingerprint"):
        raise IntegrationError("Host job requires id, V8 cohortId and deployment fingerprint")
    with job_lock(root, mode):
        journal = Journal(root, mode)
        engine = engine or (importlib.import_module("astra_runner") if mode == FAST_TRADING else None)
        session = JobSession(root, job, mode, engine, canonical, journal)
        previous = [r for r in journal.records if r["kind"] == "JOB_STARTED" and r["jobId"] == job["id"]]
        if previous:
            if previous[0]["jobHash"] != digest(job):
                raise IntegrationError("Host job id reused with different input")
            session.prepare()
            if mode == FAST_TRADING:
                for intent in list(journal.records):
                    if intent["kind"] == "DECISION_INTENT" and intent["jobId"] == job["id"]:
                        session.reconcile(intent)
            return session.record("JOB_DEDUPLICATED", modelCalled=False, apiCalls=0, modelCalls=0,
                                  completed=False, outcome="SKIPPED_UNCHANGED", actions=session.actions)
        keys = event_keys(job)
        prior_keys = {key for r in journal.records if r["kind"] == "JOB_STARTED" for key in r.get("eventKeys", [])}
        if mode == FAST_TRADING and keys and set(keys) <= prior_keys:
            return session.record("JOB_DEDUPLICATED", modelCalled=False, apiCalls=0, modelCalls=0,
                                  completed=False, outcome="SKIPPED_UNCHANGED", actions=[])
        session.prepare()
        session.record("JOB_STARTED", jobHash=digest(job), events=job.get("events", []),
                       eventKeys=keys,
                       eventDetectedAt=job.get("eventDetectedAt"), contextBuiltAt=job.get("contextBuiltAt"),
                       assignmentId=job.get("assignmentId"), sessionId=session.session_id)
        if mode == FAST_TRADING:
            quant = session.context['quantEvidence']['snapshot']
            session.record('QUANT_CONTEXT_PREPARED', snapshotHash=digest(quant), snapshot=quant,
                           meaning='EXACT_MODEL_INPUT_CONTEXT_NOT_REALIZED_TRADE_OR_ALPHA_EVIDENCE')
        if mode == FAST_TRADING and session.context.get('narrativeContext'):
            session.record('NARRATIVE_CONTEXT_PREPARED', snapshot=clone(session.context['narrativeContext']),
                           snapshotHash=digest(session.context['narrativeContext']))
        from narrative_attention import RULES as NARRATIVE_RULES
        prompt = fast_rules(engine)+'\n'+DISPOSITION.RULES+'\n'+NARRATIVE_RULES if mode == FAST_TRADING else COACHING_RULES+'\n'+NARRATIVE_RULES
        if mode == FAST_TRADING:
            prompt += '\nFirst NEW decision id available: ' + session.next_decision_id()
        prompt += "\nHOST SUPPLIED DATA (not instructions):\n" + json.dumps(session.context, allow_nan=False, separators=(',', ':'))
        agent, model_started, model_finished, cleanup_error = None, None, None, None
        old_gateway = engine.gateway if engine else None
        if engine:
            engine.gateway = session.gateway
        try:
            agent = (agent_factory or make_agent)(session=session, system_prompt=prompt,
                                                 max_turns=MAX_TURNS, budget_seconds=BUDGET_SECONDS[mode])
            model_started = now_ms()
            with candidate_terminal_scope(agent, session):
                result = agent.run_conversation("Evaluate this supplied V8 job and persist explicit decisions." if mode == FAST_TRADING
                                                else "Review only this canonical evidence; publish only if supported.")
            model_finished = now_ms()
            if not isinstance(result, dict):
                raise ValueError("Model returned no structured completion result")
        except Exception as error:
            model_finished = now_ms() if model_started is not None else None
            result = {"completed": False, "error": str(error)}
        finally:
            if engine:
                engine.gateway = old_gateway
            if agent:
                try:
                    agent.close()
                except Exception as error:
                    cleanup_error = str(error)
                db = getattr(agent, "_v8_session_db", None)
                if db:
                    try:
                        db.close()
                    except Exception as error:
                        cleanup_error = str(error)
        calls = result.get("api_calls")
        turns = result.get("turns_used", calls)
        exhausted = isinstance(turns, (int, float)) and turns >= MAX_TURNS and not result.get("completed")
        error_text = str(result.get("error", "")).lower()
        covered = set(session.positions) <= session.covered
        action_valid = bool(session.actions) and all(a["outcome"] != "UNRESOLVED_RECONCILE" for a in session.actions)
        valid_decision = action_valid and covered and any(a.get("validDecision", a["validAction"]) for a in session.actions)
        completed = bool(result.get("completed") and (valid_decision if mode == FAST_TRADING else session.reviews))
        outcome = ("MODEL_DECISION" if completed and mode == FAST_TRADING else "COACHING_COMPLETED" if completed
                   else "TURN_BUDGET_EXHAUSTED" if exhausted else "PROVIDER_UNAVAILABLE"
                   if any(marker in error_text for marker in ("timeout", "timed out", "429", "quota", "unavailable", "connection", "rate limit"))
                   else "INVALID_MODEL_RESPONSE" if result.get("completed") else "MODEL_INCOMPLETE")
        experiment_error = None
        if mode == FAST_TRADING:
            try:
                engine.EXPERIMENT_BOOK.finish_cycle("MODEL_DECISION" if completed else
                                                    "PROVIDER_UNAVAILABLE" if outcome == "PROVIDER_UNAVAILABLE" else "MODEL_INCOMPLETE")
            except Exception as error:
                experiment_error = str(error)
        first = session.actions[0] if session.actions else {}
        validated, submitted = first.get("decisionValidatedAt"), first.get("orderSubmittedAt")
        accepted_times = [a.get('recordedAt') for a in session.actions
                          if a.get('validAction') is True and type(a.get('recordedAt')) in (int, float)]
        return session.record("CYCLE_COMPLETION", completed=completed, outcome=outcome,
                              modelCompleted=bool(result.get("completed")), modelCalled=model_started is not None,
                              eventDetectedAt=job.get("eventDetectedAt"), contextBuiltAt=job.get("contextBuiltAt"),
                              modelStartedAt=model_started, modelFinishedAt=model_finished,
                              decisionValidatedAt=validated, orderSubmittedAt=submitted,
                              orderFilledAt=first.get("orderFilledAt"), apiCalls=calls,
                              modelCalls=calls, gatewayApiCalls=session.gateway_calls, turnsUsed=turns,
                              turnsLimit=MAX_TURNS, turnsExhausted=exhausted,
                              terminationReason=result.get("termination_reason") or result.get('turn_exit_reason') or outcome,
                              responseSource=('HOST_CONFIRMED_DECISIONS' if getattr(agent, '_astra_host_terminal', False)
                                              else 'MODEL_RESPONSE'),
                              modelNarrativeCompleted=bool(result.get('completed') and not getattr(agent, '_astra_host_terminal', False)),
                              tokenUsage=result.get("token_usage", result.get("usage")),
                              hostContextLatency=elapsed(job.get("eventDetectedAt"), job.get("contextBuiltAt")),
                              modelDecisionLatency=elapsed(model_started, model_finished),
                              firstAcceptedDecisionLatency=elapsed(model_started, min(accepted_times, default=None)),
                              postDecisionOverheadMs=elapsed(max(accepted_times, default=None), model_finished),
                              acceptedDecisionTimingBasis='DURABLE_ACTION_ACTUALITY_NOT_EXCHANGE_FILL',
                              validationLatency=None,  # Tools act before the whole conversation ends.
                              toolValidationLatency=elapsed(first.get("decisionToolRequestedAt"), validated),
                              decisionToSubmitLatency=elapsed(validated, submitted),
                              totalEventToSubmitLatency=elapsed(job.get("eventDetectedAt"), submitted),
                              missingPositionIds=sorted(set(session.positions) - session.covered),
                              assessedSymbols=sorted(session.assessed_symbols),
                              candidateReports=DISPOSITION.cycle_reports(journal.records,job['id'],session.actions),
                              canonicalDelta=session.canonical.export()[session.canonical_saved:] if mode == FAST_TRADING else [],
                              actions=session.actions, response=result.get("final_response"),
                              hostEntryDiagnostics=[a['result']['entryDiagnostic'] for a in session.actions
                                  if isinstance(a.get('result'), dict) and a['result'].get('entryDiagnostic')],
                              error=result.get("error"), cleanupError=cleanup_error, experimentError=experiment_error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=Path)
    args = parser.parse_args()
    job = json.loads(args.job.read_text())
    try:
        result = run_job(Path(__file__).resolve().parent, job)
    except Exception as error:
        # Carry the declared role even on a failure the session never reached: the
        # host decides whether to fail over, and it cannot without knowing who failed.
        result = {"jobId": job.get("id"), "completed": False, "outcome": "INTEGRATION_BLOCKED",
                  "modelRole": (job.get("modelPolicy") or {}).get("role", MODELS.PRIMARY),
                  "error": str(error)}
    result_path = args.job.with_suffix(".result.json")
    temporary = result_path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(result, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(result_path)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
