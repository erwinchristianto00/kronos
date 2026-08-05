/**
 * Read-only status for the forward causal lineage and the CORTEX shadow learner.
 * This is deliberately observational: it only reads append-only journals and the
 * persisted brain state, and has no dependency on execution or allocation code.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { CORTEX_LIVE_BETA, CORTEX_WIN_HURDLE_R } from "./cortex-brain.js";
import { CORTEX_ATTR_MIN_EXAMPLES_ACTIVE } from "./cortex-attribution.js";
import { readCortexJournalTail } from "./cortex-journal-reader.js";
import { getLatestCortexRefitReport } from "./cortex-refit-runner-bindings.js";
import { resolveCausalCollectionActivation, forwardCausalJournalPath } from "../experience-engine/forward-causal-collection.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isoAt(value: unknown): string | null {
  if (!finite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

type CausalReinforcement = "POSITIVE" | "NON_POSITIVE" | "EXCLUDED";

function causalReinforcement(row: JsonRecord): CausalReinforcement {
  // A malformed or unsafe close must remain visible but can never be described as a training label.
  if (row.outcomeQuality !== "RESOLVED_VALID" || row.directAttribution !== "DIRECT_CAUSAL_LINK" || !finite(row.netR)) {
    return "EXCLUDED";
  }
  return row.netR > CORTEX_WIN_HURDLE_R ? "POSITIVE" : "NON_POSITIVE";
}

function causalExclusionReason(row: JsonRecord): string | null {
  if (row.outcomeQuality !== "RESOLVED_VALID") return "unsafe or ambiguous intrabar close";
  if (row.directAttribution !== "DIRECT_CAUSAL_LINK") return "not a direct causal link";
  if (!finite(row.netR)) return "missing finite net R";
  return null;
}

interface RecentOutcomeEntry {
  resolvedAt: string | null;
  laneId: string | null;
  symbolOrBasketId: string | null;
  direction: string | null;
  regime: string | null;
  netR: number | null;
  grossR: number | null;
  costR: number | null;
  exitReason: string | null;
  reinforcement: CausalReinforcement;
  exclusionReason: string | null;
}

interface LineageAccumulator {
  byteOffset: number;
  badLines: number;
  totalEvents: number;
  decisionSnapshots: number;
  opportunitiesOpened: number;
  outcomesResolved: number;
  validOutcomes: number;
  ambiguousOutcomes: number;
  directOutcomes: number;
  economicWins: number;
  latestAt: string | null;
  decisionsById: Map<string, JsonRecord>;
  causalLabels: { POSITIVE: number; NON_POSITIVE: number; EXCLUDED: number };
  recentOutcomes: RecentOutcomeEntry[];
}

// 2026-07-20 incident fix: this used to be a stateless "read the whole file, TTL-cache the parsed rows
// for 5s" design. The causal-experience journal is append-only and UNROTATED — it reached 234MB / 186k
// lines on testnet — so a bare TTL only bounded how OFTEN a full 234MB readFileSync+line-by-line
// JSON.parse happened, not the COST of each one. Any poll landing outside the TTL window (or the first
// poll after each of the many restarts this session) paid that cost in full, badly enough to be a real,
// profiler-confirmed contributor to event-loop starvation. Now this keeps a per-file running accumulator
// (counts, the decisionId→snapshot join map, and a bounded recent-outcomes ring) and only reads the BYTES
// APPENDED since the last call via a file descriptor — cost is O(new bytes), not O(file size), on every
// call after the first. A torn/partial trailing line (the file mid-append) is left unconsumed and picked
// up whole on the next call, never dropped or double-counted.
const RECENT_OUTCOMES_RING_SIZE = 64; // comfortably above the 12 the report ever surfaces
// 2026-07-22 bug-hunt fix: decisionsById had no bound at all (unlike recentOutcomes' ring above) —
// every DECISION_SNAPSHOT ever read added one full row, forever, for the life of the process. Most
// entries ARE consumed exactly once by a later OUTCOME_RESOLUTION lookup (deleted there — see
// foldRow), but a real fraction of decisions never resolve at all (unresolvedOpportunities is a
// persistently nonzero count on this very report), so delete-on-lookup alone doesn't bound the
// never-resolves case. This cap is the backstop: comfortably above cortexLaneTtlMs's widest window
// (90 min XSEC) worth of decision volume, so a genuinely-still-resolvable decision is never evicted
// before its outcome can look it up, while still capping the process-memory analog of the disk-side
// 234MB-unrotated-journal incident this whole accumulator design exists to fix.
const DECISIONS_BY_ID_MAX = 20_000;
const lineageAccumulators = new Map<string, LineageAccumulator>();

function freshAccumulator(): LineageAccumulator {
  return {
    byteOffset: 0,
    badLines: 0,
    totalEvents: 0,
    decisionSnapshots: 0,
    opportunitiesOpened: 0,
    outcomesResolved: 0,
    validOutcomes: 0,
    ambiguousOutcomes: 0,
    directOutcomes: 0,
    economicWins: 0,
    latestAt: null,
    decisionsById: new Map(),
    causalLabels: { POSITIVE: 0, NON_POSITIVE: 0, EXCLUDED: 0 },
    recentOutcomes: [],
  };
}

function foldRow(acc: LineageAccumulator, row: JsonRecord): void {
  acc.totalEvents += 1;
  const eventType = row.eventType;
  if (eventType === "DECISION_SNAPSHOT") {
    acc.decisionSnapshots += 1;
    const identity = isRecord(row.identity) ? row.identity : null;
    const decisionId = text(identity?.decisionId) ?? text(row.eventId);
    if (decisionId) {
      acc.decisionsById.set(decisionId, row);
      // Backstop bound (see DECISIONS_BY_ID_MAX doc comment): evict the OLDEST entry once over cap.
      // Map preserves insertion order, so .keys().next() is always the longest-unconsumed decision —
      // exactly the one least likely to still be awaited by a future OUTCOME_RESOLUTION.
      if (acc.decisionsById.size > DECISIONS_BY_ID_MAX) {
        const oldestKey = acc.decisionsById.keys().next().value;
        if (oldestKey !== undefined) acc.decisionsById.delete(oldestKey);
      }
    }
    acc.latestAt = isoAt(row.asOfMs) ?? acc.latestAt;
  } else if (eventType === "OPPORTUNITY_OPEN") {
    acc.opportunitiesOpened += 1;
    acc.latestAt = isoAt(row.openedAtMs) ?? acc.latestAt;
  } else if (eventType === "OUTCOME_RESOLUTION") {
    acc.outcomesResolved += 1;
    if (row.outcomeQuality === "RESOLVED_VALID") acc.validOutcomes += 1;
    if (row.intrabarAmbiguous === true) acc.ambiguousOutcomes += 1;
    if (row.directAttribution === "DIRECT_CAUSAL_LINK") acc.directOutcomes += 1;
    if (finite(row.netR) && row.netR > CORTEX_WIN_HURDLE_R) acc.economicWins += 1;
    acc.latestAt = isoAt(row.resolvedAtMs) ?? acc.latestAt;

    const identity = isRecord(row.identity) ? row.identity : null;
    const resolvedDecisionId = text(row.decisionId) ?? "";
    const decision = acc.decisionsById.get(resolvedDecisionId);
    // 2026-07-22 bug-hunt fix: each decisionId resolves at most once (exactly-once outcome
    // resolution, same convention this pipeline uses everywhere else) — delete it the instant it's
    // consumed so a decision that DOES resolve doesn't sit in the map for the rest of the process's
    // uptime. This is the primary bound; DECISIONS_BY_ID_MAX above is the backstop for decisions
    // that never resolve at all.
    if (decision !== undefined) acc.decisionsById.delete(resolvedDecisionId);
    const marketState = isRecord(decision?.marketState) ? decision.marketState : null;
    const reinforcement = causalReinforcement(row);
    acc.causalLabels[reinforcement] += 1;
    acc.recentOutcomes.push({
      resolvedAt: isoAt(row.resolvedAtMs),
      laneId: text(identity?.laneId),
      symbolOrBasketId: text(identity?.symbolOrBasketId),
      direction: text(identity?.direction),
      regime: text(marketState?.regime),
      netR: finite(row.netR) ? row.netR : null,
      grossR: finite(row.grossR) ? row.grossR : null,
      costR: finite(row.costR) ? row.costR : null,
      exitReason: text(row.exitReason),
      reinforcement,
      exclusionReason: causalExclusionReason(row),
    });
    if (acc.recentOutcomes.length > RECENT_OUTCOMES_RING_SIZE) {
      acc.recentOutcomes.splice(0, acc.recentOutcomes.length - RECENT_OUTCOMES_RING_SIZE);
    }
  }
}

/** Read only the bytes appended since `fromOffset`, stopping at the last complete line — a partial
 *  trailing line (the writer mid-append) is left for the next call rather than parsed truncated. */
function readNewLinesFrom(path: string, fromOffset: number, size: number): { chunk: string; consumedTo: number } {
  const toRead = size - fromOffset;
  if (toRead <= 0) return { chunk: "", consumedTo: fromOffset };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, fromOffset);
    const lastNewlineIdx = buf.lastIndexOf(0x0a); // '\n' — always a safe split point in UTF-8
    if (lastNewlineIdx === -1) return { chunk: "", consumedTo: fromOffset };
    return { chunk: buf.toString("utf8", 0, lastNewlineIdx + 1), consumedTo: fromOffset + lastNewlineIdx + 1 };
  } finally {
    closeSync(fd);
  }
}

function getOrBuildLineageAccumulator(path: string | null): LineageAccumulator {
  if (!path || !existsSync(path)) {
    if (path) lineageAccumulators.delete(path);
    return freshAccumulator();
  }
  const size = statSync(path).size;
  let acc = lineageAccumulators.get(path);
  if (!acc || size < acc.byteOffset) {
    // First read for this path, or the file shrank underneath us (rotated/truncated externally) —
    // never keep stale/mismatched offsets, rebuild from scratch.
    acc = freshAccumulator();
  }
  if (size > acc.byteOffset) {
    let chunk: string;
    let consumedTo: number;
    try {
      ({ chunk, consumedTo } = readNewLinesFrom(path, acc.byteOffset, size));
    } catch {
      lineageAccumulators.set(path, acc);
      return acc; // transient read error — surface what we already have, never throw through
    }
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) foldRow(acc, parsed);
        else acc.badLines += 1;
      } catch {
        acc.badLines += 1;
      }
    }
    acc.byteOffset = consumedTo;
  }
  lineageAccumulators.set(path, acc);
  return acc;
}

function readJson(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 2026-08-05: this used to be an independent reimplementation of forward-causal-collection.ts's own
 * resolveCausalCollectionActivation — a second copy of the exact same gating logic, justified at the
 * time by a comment insisting "so the two can never disagree". They disagreed anyway: when
 * resolveCausalCollectionActivation gained role-based authorization for isolated staging mirrors
 * (FourBrainLogicalRole), this copy had no way to know, and silently kept reporting
 * unknown-instance-fail-closed for an instance the real writer had already started collecting on —
 * exactly the drift the comment warned about, caused by there being two places to update instead of
 * one. Delegates to the canonical functions directly now; there is no second copy left to drift.
 */
function resolveCollectionStatus(env: NodeJS.ProcessEnv, dataDir: string) {
  const activation = resolveCausalCollectionActivation(env);
  return {
    active: activation.active,
    instanceId: activation.instanceId,
    logicalRole: activation.logicalRole,
    reason: activation.reason,
    journalPath: activation.active ? forwardCausalJournalPath({ ...env, CAUSAL_EXPERIENCE_COLLECTION_DIR: dataDir }) : null,
  };
}

export type CortexCollectionStatus = ReturnType<typeof buildCortexCollectionStatus>;

export function buildCortexCollectionStatus(options: {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  nowMs?: number;
} = {}) {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? env.CAUSAL_EXPERIENCE_COLLECTION_DIR ?? "data";
  const nowMs = options.nowMs ?? Date.now();
  const activation = resolveCollectionStatus(env, dataDir);
  const acc = getOrBuildLineageAccumulator(activation.journalPath);

  const recentOutcomes = [...acc.recentOutcomes].sort(
    (a, b) => Date.parse(b.resolvedAt ?? "") - Date.parse(a.resolvedAt ?? ""),
  );

  const brain = readJson(resolve(dataDir, "cortex-brain.json"));
  const rawArchetypes = isRecord(brain?.archetypes) ? brain.archetypes : {};
  const archetypes = Object.fromEntries(["BREADTH", "NEUTRAL", "TACTICAL"].map((archetype) => {
    const state = isRecord(rawArchetypes[archetype]) ? rawArchetypes[archetype] : null;
    return [archetype, {
      effectiveSamples: finite(state?.nEff) ? state.nEff : 0,
      lastRefitAt: text(state?.refitAt),
    }];
  }));
  const latestRefit = getLatestCortexRefitReport();
  const latestDecision = readCortexJournalTail(dataDir, 1).at(-1) ?? null;

  return {
    reportOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    collection: {
      mode: activation.active ? "shadow" : "off",
      instanceId: activation.instanceId,
      logicalRole: activation.logicalRole,
      status: activation.reason,
      journalPresent: Boolean(activation.journalPath && existsSync(activation.journalPath)),
      journalBadLines: acc.badLines,
    },
    lineage: {
      totalEvents: acc.totalEvents,
      decisionSnapshots: acc.decisionSnapshots,
      opportunitiesOpened: acc.opportunitiesOpened,
      outcomesResolved: acc.outcomesResolved,
      unresolvedOpportunities: Math.max(0, acc.opportunitiesOpened - acc.outcomesResolved),
      validOutcomes: acc.validOutcomes,
      ambiguousOutcomes: acc.ambiguousOutcomes,
      directOutcomes: acc.directOutcomes,
      economicWins: acc.economicWins,
      economicNonWins: Math.max(0, acc.outcomesResolved - acc.economicWins),
      economicWinHurdleR: CORTEX_WIN_HURDLE_R,
      latestAt: acc.latestAt,
    },
    cortex: {
      brainPresent: Boolean(brain),
      cumulativeResolved: finite(brain?.cumulativeResolved) ? brain.cumulativeResolved : 0,
      brainUpdatedAt: text(brain?.updatedAt),
      liveBeta: CORTEX_LIVE_BETA,
      archetypes,
      latestRefit: latestRefit
        ? {
            at: latestRefit.at,
            examplesTotal: latestRefit.examplesTotal,
            examplesNew: latestRefit.examplesNew,
            coverage: {
              cumulativeResolved: latestRefit.coverage.cumulativeResolved,
              regimeFamiliesWithOutcomes: latestRefit.coverage.regimeFamiliesWithOutcomes,
              regimeCoverageGateMet: latestRefit.coverage.regimeCoverageGateMet,
              learningActiveLanes: latestRefit.coverage.learningActiveLanes,
              blindCapitalPct: latestRefit.coverage.blindCapitalPct,
              evaluationBeta: latestRefit.coverage.evaluationBeta,
            },
            statuses: latestRefit.archetypes.map((item) => ({ archetype: item.archetype, status: item.status, effectiveSamples: item.nEff })),
            lanes: latestRefit.perLane.map((item) => {
              const reinforcement = latestRefit.reinforcementByLane.find((entry) => entry.laneId === item.laneId);
              return {
                laneId: item.laneId,
                archetype: item.archetype,
                status: item.status,
                outcomesSeen: item.outcomesSeen,
                attributed: item.attributed,
                positive: reinforcement?.positive ?? 0,
                noReward: reinforcement?.noReward ?? 0,
                unattributedNoDecision: item.unattributedNoDecision,
                unattributedNoDecisionJournalGap: item.unattributedNoDecisionJournalGap,
                unattributedNoDecisionGenuineGap: item.unattributedNoDecisionGenuineGap,
                schemaMismatch: item.schemaMismatch,
                duplicateDropped: item.duplicateDropped,
                invalidData: item.invalidData,
              };
            }),
          }
        : null,
      latestShadowDecisionAt: latestDecision?.at ?? null,
      shadowDecisionMode: latestDecision?.mode ?? null,
    },
    learning: {
      reportOnly: true,
      positiveDefinition: `net R > ${CORTEX_WIN_HURDLE_R.toFixed(2)} after costs`,
      causalLabels: acc.causalLabels,
      recentCausalOutcomes: recentOutcomes.slice(0, 12),
      minAttributedExamplesPerLane: CORTEX_ATTR_MIN_EXAMPLES_ACTIVE,
      note: "Causal labels are evidence audit records. Only a refit-attributed subset may update CORTEX shadow coefficients; live beta remains zero.",
    },
  } as const;
}

/** Test-only: clear the incremental accumulators so each test starts from a clean read of its own tmpdir. */
export function _resetCortexCollectionStatusAccumulatorsForTests(): void {
  lineageAccumulators.clear();
}
