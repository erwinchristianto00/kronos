/**
 * Durable registry for Daily Range alpha research artifacts.
 *
 * The registry is deliberately metadata-first. Loading an artifact never
 * grants allocation authority: runtime still uses ECONOMIC_QUALITY_BASELINE
 * until the forward gate and an explicit operator approval are separately
 * satisfied. Corrupt/missing records return a visible fallback status instead
 * of seeded or loop-order allocation.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type DailyRangeSelectorArtifactStatus =
  | "RESEARCH"
  | "REJECTED"
  | "WEAK_SHADOW"
  | "HISTORICALLY_VALIDATED"
  | "FORWARD_VALIDATED"
  | "LIVE_APPROVED";

/**
 * An artifact records why it is (or is not) eligible for the next lifecycle
 * step. These fields are evidence only: no value in this object can grant
 * allocator authority. Runtime keeps ECONOMIC_QUALITY_BASELINE until its own
 * separately guarded promotion path is explicitly approved.
 */
export interface DailyRangeSelectorPromotionGates {
  historical: {
    status: "PASS" | "FAIL" | "PENDING";
    datasetClass: "RECONSTRUCTED_CANDLE_PIT" | "FORWARD_FULL_PIT" | "MIXED_RESEARCH_ONLY";
    reason: string;
  };
  forwardFullPit: {
    status: "PASS" | "FAIL" | "PENDING";
    matureOversubscribedBatches: number;
    requiredMatureOversubscribedBatches: number;
    reason: string;
  };
  testnetParity: {
    status: "PASS" | "FAIL" | "PENDING";
    reason: string;
  };
  operatorApproval: {
    status: "APPROVED" | "NOT_APPROVED";
    reason: string;
  };
  /** Immutable negative assertion for research output and registry loading. */
  executionAuthority: false;
}

export interface DailyRangeSelectorArtifact {
  schemaVersion: typeof DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION;
  selectorId: string;
  routeSpecialists: Array<"CONTINUATION" | "FADE">;
  featureSchemaVersion: string;
  trainingCutoff: string;
  datasetClass: "RECONSTRUCTED_CANDLE_PIT" | "FORWARD_FULL_PIT" | "MIXED_RESEARCH_ONLY";
  datasetManifest: Record<string, unknown>;
  trainingPeriod: { from: string; to: string };
  validationPeriod: { from: string; to: string };
  holdoutPeriod: { from: string; to: string };
  metrics: Record<string, unknown>;
  /** Optional only for pre-completion research records; new artifacts persist it. */
  promotionGates?: DailyRangeSelectorPromotionGates;
  modelHash: string;
  gitCommit: string;
  status: DailyRangeSelectorArtifactStatus;
  createdAt: string;
  notes?: string;
}

interface DailyRangeSelectorArtifactRegistryFile {
  schemaVersion: typeof DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION;
  artifacts: DailyRangeSelectorArtifact[];
}

export interface DailyRangeSelectorArtifactRegistryStatus {
  available: boolean;
  activeSelectorId: string | null;
  activeStatus: DailyRangeSelectorArtifactStatus | "MISSING" | "CORRUPT";
  fallback: "ECONOMIC_QUALITY_BASELINE";
  reason: string | null;
  promotionGates: DailyRangeSelectorPromotionGates | null;
}

function isStatus(value: unknown): value is DailyRangeSelectorArtifactStatus {
  return typeof value === "string" && [
    "RESEARCH", "REJECTED", "WEAK_SHADOW", "HISTORICALLY_VALIDATED", "FORWARD_VALIDATED", "LIVE_APPROVED",
  ].includes(value);
}

function isGateStatus(value: unknown): value is "PASS" | "FAIL" | "PENDING" {
  return value === "PASS" || value === "FAIL" || value === "PENDING";
}

function parsePromotionGates(value: unknown): DailyRangeSelectorPromotionGates | null {
  if (!value || typeof value !== "object") return null;
  const gates = value as Partial<DailyRangeSelectorPromotionGates>;
  const historical = gates.historical;
  const forwardFullPit = gates.forwardFullPit;
  const testnetParity = gates.testnetParity;
  const operatorApproval = gates.operatorApproval;
  if (!historical || !forwardFullPit || !testnetParity || !operatorApproval || gates.executionAuthority !== false) return null;
  if (!isGateStatus(historical.status) || !isGateStatus(forwardFullPit.status) || !isGateStatus(testnetParity.status)) return null;
  if (!["RECONSTRUCTED_CANDLE_PIT", "FORWARD_FULL_PIT", "MIXED_RESEARCH_ONLY"].includes(historical.datasetClass)) return null;
  if (typeof historical.reason !== "string" || typeof forwardFullPit.reason !== "string" || typeof testnetParity.reason !== "string") return null;
  if (typeof forwardFullPit.matureOversubscribedBatches !== "number" || !Number.isFinite(forwardFullPit.matureOversubscribedBatches)) return null;
  if (typeof forwardFullPit.requiredMatureOversubscribedBatches !== "number" || !Number.isFinite(forwardFullPit.requiredMatureOversubscribedBatches)) return null;
  if ((operatorApproval.status !== "APPROVED" && operatorApproval.status !== "NOT_APPROVED") || typeof operatorApproval.reason !== "string") return null;
  return {
    historical: { ...historical },
    forwardFullPit: { ...forwardFullPit },
    testnetParity: { ...testnetParity },
    operatorApproval: { ...operatorApproval },
    executionAuthority: false,
  };
}

function parseArtifact(value: unknown): DailyRangeSelectorArtifact | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<DailyRangeSelectorArtifact>;
  if (row.schemaVersion !== DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION || typeof row.selectorId !== "string" || !row.selectorId.trim()) return null;
  if (!Array.isArray(row.routeSpecialists) || !row.routeSpecialists.every((route) => route === "CONTINUATION" || route === "FADE")) return null;
  if (typeof row.featureSchemaVersion !== "string" || typeof row.trainingCutoff !== "string" || typeof row.datasetClass !== "string") return null;
  if (!row.datasetManifest || typeof row.datasetManifest !== "object" || !row.trainingPeriod || !row.validationPeriod || !row.holdoutPeriod) return null;
  if (!row.metrics || typeof row.metrics !== "object" || typeof row.modelHash !== "string" || typeof row.gitCommit !== "string" || !isStatus(row.status) || typeof row.createdAt !== "string") return null;
  const promotionGates = row.promotionGates === undefined ? undefined : parsePromotionGates(row.promotionGates);
  if (row.promotionGates !== undefined && promotionGates === null) return null;
  return {
    ...row,
    schemaVersion: DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION,
    selectorId: row.selectorId.trim(),
    routeSpecialists: [...row.routeSpecialists],
    datasetManifest: { ...row.datasetManifest },
    trainingPeriod: { ...row.trainingPeriod },
    validationPeriod: { ...row.validationPeriod },
    holdoutPeriod: { ...row.holdoutPeriod },
    metrics: { ...row.metrics },
    ...(promotionGates ? { promotionGates } : {}),
  } as DailyRangeSelectorArtifact;
}

export function hashDailyRangeSelectorModel(model: unknown): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
}

/**
 * Absence/corruption is a safe state. The registry never creates a replacement
 * during a read, so Live/Testnet startup does not mutate research authority.
 */
export class DailyRangeSelectorArtifactRegistry {
  private readonly file: string;

  constructor(dataDir = "data", fileName = "daily-range-selector-artifacts.json") {
    this.file = resolve(dataDir, fileName);
    mkdirSync(dirname(this.file), { recursive: true });
  }

  list(): DailyRangeSelectorArtifact[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DailyRangeSelectorArtifactRegistryFile>;
      if (parsed.schemaVersion !== DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION || !Array.isArray(parsed.artifacts)) return [];
      return parsed.artifacts.map(parseArtifact).filter((artifact): artifact is DailyRangeSelectorArtifact => artifact !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.selectorId.localeCompare(a.selectorId));
    } catch {
      return [];
    }
  }

  status(): DailyRangeSelectorArtifactRegistryStatus {
    if (!existsSync(this.file)) {
      return { available: false, activeSelectorId: null, activeStatus: "MISSING", fallback: "ECONOMIC_QUALITY_BASELINE", reason: "no Daily Range selector artifact registry", promotionGates: null };
    }
    let parsed: Partial<DailyRangeSelectorArtifactRegistryFile>;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DailyRangeSelectorArtifactRegistryFile>;
    } catch {
      return { available: false, activeSelectorId: null, activeStatus: "CORRUPT", fallback: "ECONOMIC_QUALITY_BASELINE", reason: "selector registry JSON is unreadable", promotionGates: null };
    }
    if (parsed.schemaVersion !== DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION || !Array.isArray(parsed.artifacts)) {
      return { available: false, activeSelectorId: null, activeStatus: "CORRUPT", fallback: "ECONOMIC_QUALITY_BASELINE", reason: "selector registry schema is invalid", promotionGates: null };
    }
    const artifacts = parsed.artifacts.map(parseArtifact).filter((artifact): artifact is DailyRangeSelectorArtifact => artifact !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.selectorId.localeCompare(a.selectorId));
    const active = artifacts[0] ?? null;
    return active
      ? { available: true, activeSelectorId: active.selectorId, activeStatus: active.status, fallback: "ECONOMIC_QUALITY_BASELINE", reason: null, promotionGates: active.promotionGates ?? null }
      : { available: false, activeSelectorId: null, activeStatus: "CORRUPT", fallback: "ECONOMIC_QUALITY_BASELINE", reason: "selector registry contains no valid artifact", promotionGates: null };
  }

  /** Research tooling only; overwrites no unrelated artifact and writes atomically. */
  saveArtifact(artifact: DailyRangeSelectorArtifact): void {
    const valid = parseArtifact(artifact);
    if (!valid) throw new Error("invalid Daily Range selector artifact");
    const current = this.list().filter((row) => row.selectorId !== valid.selectorId);
    const next: DailyRangeSelectorArtifactRegistryFile = {
      schemaVersion: DAILY_RANGE_SELECTOR_ARTIFACT_SCHEMA_VERSION,
      artifacts: [...current, valid].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.selectorId.localeCompare(a.selectorId)),
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, this.file);
  }
}
