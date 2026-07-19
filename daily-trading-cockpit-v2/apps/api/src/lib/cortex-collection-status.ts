/**
 * Read-only status for the forward causal lineage and the CORTEX shadow learner.
 * This is deliberately observational: it only reads append-only journals and the
 * persisted brain state, and has no dependency on execution or allocation code.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CORTEX_LIVE_BETA, CORTEX_WIN_HURDLE_R } from "./cortex-brain.js";
import { CORTEX_ATTR_MIN_EXAMPLES_ACTIVE } from "./cortex-attribution.js";
import { readCortexJournalTail } from "./cortex-journal-reader.js";
import { getLatestCortexRefitReport } from "./cortex-refit-runner-bindings.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readJsonl(path: string | null): { rows: JsonRecord[]; badLines: number } {
  if (!path || !existsSync(path)) return { rows: [], badLines: 0 };
  try {
    const rows: JsonRecord[] = [];
    let badLines = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) rows.push(parsed);
        else badLines += 1;
      } catch {
        // A torn append must be visible as a count but never break the dashboard.
        badLines += 1;
      }
    }
    return { rows, badLines };
  } catch {
    return { rows: [], badLines: 1 };
  }
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

function resolveCollectionStatus(env: NodeJS.ProcessEnv, dataDir: string) {
  const instanceId = (env.PORT ?? "unknown").toString().trim() || "unknown";
  if (instanceId === "3103") return { active: false, instanceId, reason: "live-3103-blocked" as const, journalPath: null };
  if ((env.CAUSAL_EXPERIENCE_COLLECTION_MODE ?? "").toString().trim().toLowerCase() !== "shadow")
    return { active: false, instanceId, reason: "mode-off" as const, journalPath: null };
  if (instanceId !== "3101" && instanceId !== "3102")
    return { active: false, instanceId, reason: "unknown-instance-fail-closed" as const, journalPath: null };
  return {
    active: true,
    instanceId,
    reason: "shadow-active" as const,
    journalPath: resolve(dataDir, "causal-experience", instanceId, "events.jsonl"),
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
  const activation = resolveCollectionStatus(env, dataDir);
  const lineage = readJsonl(activation.journalPath);

  let decisionSnapshots = 0;
  let opportunitiesOpened = 0;
  let outcomesResolved = 0;
  let validOutcomes = 0;
  let ambiguousOutcomes = 0;
  let directOutcomes = 0;
  let economicWins = 0;
  let latestAt: string | null = null;
  const decisionsById = new Map<string, JsonRecord>();
  const recentOutcomes: Array<{
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
  }> = [];

  for (const row of lineage.rows) {
    const eventType = row.eventType;
    if (eventType === "DECISION_SNAPSHOT") {
      decisionSnapshots += 1;
      const identity = isRecord(row.identity) ? row.identity : null;
      const decisionId = text(identity?.decisionId) ?? text(row.eventId);
      if (decisionId) decisionsById.set(decisionId, row);
      latestAt = isoAt(row.asOfMs) ?? latestAt;
    } else if (eventType === "OPPORTUNITY_OPEN") {
      opportunitiesOpened += 1;
      latestAt = isoAt(row.openedAtMs) ?? latestAt;
    } else if (eventType === "OUTCOME_RESOLUTION") {
      outcomesResolved += 1;
      if (row.outcomeQuality === "RESOLVED_VALID") validOutcomes += 1;
      if (row.intrabarAmbiguous === true) ambiguousOutcomes += 1;
      if (row.directAttribution === "DIRECT_CAUSAL_LINK") directOutcomes += 1;
      if (finite(row.netR) && row.netR > CORTEX_WIN_HURDLE_R) economicWins += 1;
      latestAt = isoAt(row.resolvedAtMs) ?? latestAt;

      const identity = isRecord(row.identity) ? row.identity : null;
      const decision = decisionsById.get(text(row.decisionId) ?? "");
      const marketState = isRecord(decision?.marketState) ? decision.marketState : null;
      recentOutcomes.push({
        resolvedAt: isoAt(row.resolvedAtMs),
        laneId: text(identity?.laneId),
        symbolOrBasketId: text(identity?.symbolOrBasketId),
        direction: text(identity?.direction),
        regime: text(marketState?.regime),
        netR: finite(row.netR) ? row.netR : null,
        grossR: finite(row.grossR) ? row.grossR : null,
        costR: finite(row.costR) ? row.costR : null,
        exitReason: text(row.exitReason),
        reinforcement: causalReinforcement(row),
        exclusionReason: causalExclusionReason(row),
      });
    }
  }

  recentOutcomes.sort((a, b) => Date.parse(b.resolvedAt ?? "") - Date.parse(a.resolvedAt ?? ""));
  const causalLabels = recentOutcomes.reduce(
    (summary, item) => {
      summary[item.reinforcement] += 1;
      return summary;
    },
    { POSITIVE: 0, NON_POSITIVE: 0, EXCLUDED: 0 },
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
  const nowMs = options.nowMs ?? Date.now();

  return {
    reportOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    collection: {
      mode: activation.active ? "shadow" : "off",
      instanceId: activation.instanceId,
      status: activation.reason,
      journalPresent: Boolean(activation.journalPath && existsSync(activation.journalPath)),
      journalBadLines: lineage.badLines,
    },
    lineage: {
      totalEvents: lineage.rows.length,
      decisionSnapshots,
      opportunitiesOpened,
      outcomesResolved,
      unresolvedOpportunities: Math.max(0, opportunitiesOpened - outcomesResolved),
      validOutcomes,
      ambiguousOutcomes,
      directOutcomes,
      economicWins,
      economicNonWins: Math.max(0, outcomesResolved - economicWins),
      economicWinHurdleR: CORTEX_WIN_HURDLE_R,
      latestAt,
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
                schemaMismatch: item.schemaMismatch,
                duplicateDropped: item.duplicateDropped,
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
      causalLabels,
      recentCausalOutcomes: recentOutcomes.slice(0, 12),
      minAttributedExamplesPerLane: CORTEX_ATTR_MIN_EXAMPLES_ACTIVE,
      note: "Causal labels are evidence audit records. Only a refit-attributed subset may update CORTEX shadow coefficients; live beta remains zero.",
    },
  } as const;
}
