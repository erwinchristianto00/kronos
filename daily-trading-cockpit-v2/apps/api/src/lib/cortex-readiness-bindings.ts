/**
 * CORTEX Readiness — impure bindings (2026-07-21). Gathers the pure computeCortexReadiness() inputs
 * from this instance's real sources and (best-effort) a PEER instance's readiness:
 *
 *   brain      → data/cortex-brain.json read directly (same pattern as cortex-collection-status.ts:
 *                the file is tiny — coefficients + counters + the bounded outcome ledger — so a
 *                per-request read at the card's 60s poll is negligible; reading the file rather than
 *                the store singleton also works on instances where the brain never booted).
 *   refit      → getLatestCortexRefitReport() in-memory cache (no recompute, no disk).
 *   collection → buildCortexCollectionStatus() (its own incremental accumulator — O(new bytes)).
 *   alpha      → getLatestCortexShadowDecisionAlpha() in-memory cache.
 *   history    → CortexReadinessHistoryStore; each local build ALSO upserts today's snapshot, so the
 *                multi-component rate basis accrues wherever the endpoint is polled (the /research
 *                card polls research directly and testnet through the peer fetch, so both instances'
 *                histories advance).
 *
 * CROSS-INSTANCE (operator requirement): /research must show TESTNET's readiness — that's where
 * promotion is actually being proven — not research's own shadow. Same precedent as lane-symbol
 * curation's localhost fetch (lane-symbol-curation-cache.ts / LANE_SYMBOL_CURATION_SOURCE_URL):
 * gated behind CORTEX_READINESS_PEER_URL (unset ⇒ no fetch, so tests and dev never need a live
 * peer), short timeout, NEVER throws — an unreachable peer just returns peer:null with the error
 * recorded, and the dashboard falls back to local with an honest label. On the VPS research (3101)
 * instance this should be set to http://localhost:3102 (testnet). Recursion-safe by construction:
 * the peer's own endpoint only fetches ITS peer env var, which is unset on testnet.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildCortexCollectionStatus } from "./cortex-collection-status.js";
import {
  getLatestCortexRefitReport,
  getLatestCortexShadowDecisionAlpha,
  CORTEX_LANE_ROSTER,
} from "./cortex-refit-runner-bindings.js";
import {
  computeCortexReadiness,
  getCortexReadinessHistoryStore,
  type CortexReadinessBrainInput,
  type CortexReadinessCollectionInput,
  type CortexReadinessHistoryStore,
  type CortexReadinessReport,
} from "./cortex-readiness.js";
import { diagnoseCortexInstance, type CortexInstanceDiagnosis } from "./cortex-instance-diagnosis.js";

const PEER_FETCH_TIMEOUT_MS = 3_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parse data/cortex-brain.json into the pure module's brain input. Null on absent/corrupt/foreign
 *  shape — "no brain data" is an honest report state, never a throw. Exported for tests. */
export function parseCortexBrainJsonForReadiness(raw: unknown): CortexReadinessBrainInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const resolvedByFamily: Record<string, number> = {};
  if (rec.resolvedByFamily && typeof rec.resolvedByFamily === "object" && !Array.isArray(rec.resolvedByFamily)) {
    for (const [fam, n] of Object.entries(rec.resolvedByFamily as Record<string, unknown>)) {
      if (finite(n) && n >= 0) resolvedByFamily[fam] = n;
    }
  }
  const ledgerResolvedAtMs: number[] = [];
  if (rec.countedObservations && typeof rec.countedObservations === "object" && !Array.isArray(rec.countedObservations)) {
    for (const ms of Object.values(rec.countedObservations as Record<string, unknown>)) {
      if (finite(ms) && ms >= 0) ledgerResolvedAtMs.push(ms);
    }
  }
  return {
    cumulativeResolved: finite(rec.cumulativeResolved) && rec.cumulativeResolved >= 0 ? rec.cumulativeResolved : 0,
    resolvedByFamily,
    ledgerResolvedAtMs,
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : null,
  };
}

/** Build THIS instance's readiness report (and upsert today's history snapshot). Never throws. */
export function buildLocalCortexReadiness(deps: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  historyStore?: CortexReadinessHistoryStore;
} = {}): { report: CortexReadinessReport; instanceId: string } {
  const env = deps.env ?? process.env;
  const dataDir = deps.dataDir ?? "data";
  const nowMs = deps.nowMs ?? Date.now();

  let brain: CortexReadinessBrainInput | null = null;
  try {
    const file = resolve(dataDir, "cortex-brain.json");
    if (existsSync(file)) brain = parseCortexBrainJsonForReadiness(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    brain = null;
  }

  const refitReport = getLatestCortexRefitReport();
  const refit = refitReport
    ? {
        at: refitReport.at,
        examplesTotal: refitReport.examplesTotal,
        journalBadLines: finite(refitReport.journalBadLines) ? refitReport.journalBadLines : null,
        blindCapitalPct: refitReport.coverage.blindCapitalPct,
        regimeCoverageGateMet: refitReport.coverage.regimeCoverageGateMet,
        regimeFamiliesWithOutcomes: refitReport.coverage.regimeFamiliesWithOutcomes,
        learningActiveLanes: refitReport.coverage.learningActiveLanes,
        evaluationBeta: refitReport.coverage.evaluationBeta,
        archetypes: refitReport.archetypes.map((a) => ({ archetype: a.archetype, status: a.status, examples: a.examples })),
        perLane: refitReport.perLane.map((l) => ({ laneId: l.laneId, status: l.status, staticWeightPct: l.staticWeightPct })),
        reinforcement: refitReport.reinforcementByLane.map((r) => ({ laneId: r.laneId, positive: r.positive, noReward: r.noReward })),
      }
    : null;

  let collection: CortexReadinessCollectionInput | null = null;
  let instanceId = (env.FOUR_BRAIN_INSTANCE_ID ?? env.PORT ?? "unknown").toString();
  try {
    const status = buildCortexCollectionStatus({ env, nowMs });
    instanceId = status.collection.instanceId;
    collection = {
      mode: status.collection.mode,
      instanceId: status.collection.instanceId,
      totalEvents: status.lineage.totalEvents,
      decisionSnapshots: status.lineage.decisionSnapshots,
      opportunitiesOpened: status.lineage.opportunitiesOpened,
      outcomesResolved: status.lineage.outcomesResolved,
      unresolvedOpportunities: status.lineage.unresolvedOpportunities,
      validOutcomes: status.lineage.validOutcomes,
      directOutcomes: status.lineage.directOutcomes,
      economicWins: status.lineage.economicWins,
      latestAt: status.lineage.latestAt,
    };
  } catch {
    collection = null;
  }

  const alphaCache = getLatestCortexShadowDecisionAlpha();
  const decisionAlpha = alphaCache
    ? {
        n: alphaCache.decisionAlpha.n,
        cumulativeTiltDeltaR: alphaCache.decisionAlpha.cumulativeTiltDeltaR,
        meanTiltDeltaR: alphaCache.decisionAlpha.meanTiltDeltaR,
        perLane: alphaCache.decisionAlpha.perLane,
      }
    : null;

  const historyStore = deps.historyStore ?? getCortexReadinessHistoryStore(dataDir);
  const report = computeCortexReadiness({
    brain,
    refit,
    collection,
    decisionAlpha,
    history: historyStore.all(),
    rosterSize: CORTEX_LANE_ROSTER.length,
    nowMs,
  });

  // Upsert today's snapshot AFTER computing (the rate basis only ever uses previous days' snapshots,
  // so recording order can't feed today's value back into today's rate).
  historyStore.record({
    dateUtc: new Date(nowMs).toISOString().slice(0, 10),
    atIso: new Date(nowMs).toISOString(),
    readinessPct: report.readinessPct,
    components: Object.fromEntries(report.components.map((c) => [c.key, c.pct])),
    cumulativeResolved: report.quality.cumulativeResolved,
    blindCapitalPct: refit ? refit.blindCapitalPct : null,
    learningActiveLanes: refit ? refit.learningActiveLanes : null,
    refitAccepted: refit ? report.reinforcement.refitAccepted : null,
    refitRejected: refit ? report.reinforcement.refitRejected : null,
  });

  return { report, instanceId };
}

/** Normalize CORTEX_READINESS_PEER_URL: accept either a bare origin (http://localhost:3102) or a
 *  full endpoint URL. Exported for tests. */
export function normalizeCortexReadinessPeerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.includes("/api/") ? trimmed : `${trimmed}/api/shadow/cortex-readiness`;
}

/** Best-effort peer readiness fetch. Never throws; null report + error string on ANY failure. */
export async function fetchPeerCortexReadiness(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ report: CortexReadinessReport | null; error: string | null }> {
  const timeoutMs = opts.timeoutMs ?? PEER_FETCH_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(normalizeCortexReadinessPeerUrl(url), { signal: controller.signal });
    if (!res.ok) return { report: null, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { local?: CortexReadinessReport };
    const local = body?.local;
    if (!local || !finite(local.readinessPct) || !Array.isArray(local.components)) {
      return { report: null, error: "malformed peer response" };
    }
    return { report: local, error: null };
  } catch (error) {
    return { report: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface CortexReadinessEndpointResponse {
  reportOnly: true;
  generatedAt: string;
  instanceId: string;
  local: CortexReadinessReport;
  localDiagnosis: CortexInstanceDiagnosis;
  /** Present only when CORTEX_READINESS_PEER_URL is configured AND the peer answered sanely. */
  peer: { url: string; label: string; report: CortexReadinessReport } | null;
  /** Why peer is null (null when peer succeeded or no peer URL is configured). */
  peerError: string | null;
}

/** The GET /api/shadow/cortex-readiness response: local readiness + (gated, best-effort) peer. */
export async function buildCortexReadinessEndpointResponse(deps: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  historyStore?: CortexReadinessHistoryStore;
  fetchImpl?: typeof fetch;
} = {}): Promise<CortexReadinessEndpointResponse> {
  const env = deps.env ?? process.env;
  const nowMs = deps.nowMs ?? Date.now();
  const { report: local, instanceId } = buildLocalCortexReadiness(deps);
  const localDiagnosis = diagnoseCortexInstance({
    env,
    brainPresent: local.inputsPresent.brain,
    refitPresent: local.inputsPresent.refit,
    collectionPresent: local.inputsPresent.collection,
  });

  let peer: CortexReadinessEndpointResponse["peer"] = null;
  let peerError: string | null = null;
  const peerUrl = (env.CORTEX_READINESS_PEER_URL ?? "").trim();
  if (peerUrl) {
    const { report, error } = await fetchPeerCortexReadiness(peerUrl, { fetchImpl: deps.fetchImpl });
    if (report) {
      peer = {
        url: normalizeCortexReadinessPeerUrl(peerUrl),
        label: (env.CORTEX_READINESS_PEER_LABEL ?? "testnet (3102)").trim() || "testnet (3102)",
        report,
      };
    } else {
      peerError = error;
    }
  }

  return {
    reportOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    instanceId,
    local,
    localDiagnosis,
    peer,
    peerError,
  };
}
