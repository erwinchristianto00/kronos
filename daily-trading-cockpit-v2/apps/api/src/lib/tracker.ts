import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Candidate, FinalStatus, MigrationAuditSnapshot, ScanResult, SignalFamily, StatusHistoryEntry, TimeframeBucket, TrackedSignal } from "@dtc/shared";
import { rotateJsonlIfNeeded } from "./jsonl-rotation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(__dirname, "../../../../data");
const DUPLICATE_COOLDOWN_MS = 60 * 60 * 1000;
const ENTRY_ZONE_TOLERANCE_RATIO = 0.003;
const MIN_ENTRY_ZONE_TOLERANCE = 0.00000001;
const PRIMARY_WINDOW = "4h";
const MIGRATION_AUDIT_FILE = "performance-migration-audit.json";
const OUTCOME_CHECKER_AUDIT_FILE = "outcome-checker-audit.json";

const STATUS_RANK: Record<FinalStatus, number> = {
  TRADE_NOW: 4,
  READY: 3,
  WAIT: 2,
  WATCH: 1,
  SKIP: 0,
};

function getPrimaryOutcome(signal: TrackedSignal) {
  return signal.outcomes[PRIMARY_WINDOW];
}

function isResolvedOrExpired(signal: TrackedSignal): boolean {
  const primary = getPrimaryOutcome(signal);
  if (!primary) return false;
  return primary.result !== "OPEN";
}

function isWithinActiveExpiryWindow(signal: TrackedSignal, now: number): boolean {
  const firstSeenMs = new Date(signal.firstSeenAt).getTime();
  return now - firstSeenMs < 24 * 60 * 60 * 1000;
}

function entryZoneTolerance(priceAtScan: number): number {
  return Math.max(Math.abs(priceAtScan) * ENTRY_ZONE_TOLERANCE_RATIO, MIN_ENTRY_ZONE_TOLERANCE);
}

function roundEntryValue(value: number, priceAtScan: number): number {
  const step = entryZoneTolerance(priceAtScan);
  return Math.round(value / step) * step;
}

function normalizeEntryZone(entryZone: [number, number] | null, priceAtScan: number): string {
  if (entryZone === null) return "NO_ENTRY";
  return `${roundEntryValue(entryZone[0], priceAtScan).toFixed(8)}:${roundEntryValue(entryZone[1], priceAtScan).toFixed(8)}`;
}

function hasMaterialEntryZoneChange(a: TrackedSignal, b: TrackedSignal): boolean {
  if (a.entryZone === null && b.entryZone === null) return false;
  if (a.entryZone === null || b.entryZone === null) return true;
  const tolerance = Math.max(entryZoneTolerance(a.priceAtScan), entryZoneTolerance(b.priceAtScan));
  return Math.abs(a.entryZone[0] - b.entryZone[0]) > tolerance || Math.abs(a.entryZone[1] - b.entryZone[1]) > tolerance;
}

function determineSignalFamily(candidate: Candidate): SignalFamily {
  const fiveMinute = candidate.indicators.fiveMinute;
  const oneHour = candidate.indicators.oneHour;
  if (fiveMinute.breakoutHigh || fiveMinute.breakoutLow) {
    return "BREAKOUT";
  }
  if (candidate.status === "WAIT") {
    return "PULLBACK";
  }
  if (
    (candidate.finalDirection === "LONG" && oneHour.trend === "BULLISH") ||
    (candidate.finalDirection === "SHORT" && oneHour.trend === "BEARISH")
  ) {
    return "TREND_CONTINUATION";
  }
  return "ROTATION_SETUP";
}

function determineTimeframeBucket(_candidate: Candidate): TimeframeBucket {
  return "INTRADAY_5M_15M_1H";
}

function buildNormalizedSignalKey(parts: {
  symbol: string;
  direction: TrackedSignal["direction"];
  timeframeBucket: TimeframeBucket;
  signalFamily: SignalFamily;
  entryZone: [number, number] | null;
  priceAtScan: number;
}): string {
  return [
    parts.symbol,
    parts.direction,
    parts.timeframeBucket,
    normalizeEntryZone(parts.entryZone, parts.priceAtScan),
    parts.signalFamily,
  ].join("|");
}

function bestStatusOf(a: FinalStatus, b: FinalStatus): FinalStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function inferKronosConfidenceBucket(confidence: number | null | undefined): "STRONG" | "MEDIUM" | "WEAK" | null {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return null;
  if (confidence < 45) return "WEAK";
  if (confidence < 70) return "MEDIUM";
  return "STRONG";
}

function mergeStatusHistory(baseHistory: StatusHistoryEntry[], incomingStatus: FinalStatus, seenAt: string): StatusHistoryEntry[] {
  const last = baseHistory.at(-1);
  if (last && last.status === incomingStatus) {
    return baseHistory;
  }
  return [...baseHistory, { status: incomingStatus, seenAt }];
}

function mergeSignalState(base: TrackedSignal, incoming: TrackedSignal): TrackedSignal {
  const mergedOutcomes = { ...base.outcomes };
  for (const key of ["30m", "1h", "4h", "24h"] as const) {
    if (mergedOutcomes[key] === null && incoming.outcomes[key] !== null) {
      mergedOutcomes[key] = incoming.outcomes[key];
    }
  }

  const mergedHistory = mergeStatusHistory(base.statusHistory, incoming.latestStatus, incoming.lastSeenAt);

  return {
    ...base,
    firstSeenAt: base.firstSeenAt,
    lastSeenAt: incoming.lastSeenAt,
    scanCount: base.scanCount + incoming.scanCount,
    isDuplicateSuppressed: true,
    latestScore: incoming.latestScore,
    latestStatus: incoming.latestStatus,
    latestReason: incoming.latestReason,
    bestStatus: bestStatusOf(base.bestStatus, incoming.latestStatus),
    statusHistory: mergedHistory,
    opportunityScore: incoming.opportunityScore,
    dangerScore: incoming.dangerScore,
    confidence: incoming.confidence,
    longScore: incoming.longScore,
    shortScore: incoming.shortScore,
    kronosScore: incoming.kronosScore,
    directionConflict: incoming.directionConflict,
    sourceConflict: incoming.sourceConflict,
    kronosBias: incoming.kronosBias,
    kronosBias1h: incoming.kronosBias1h,
    kronosBias4h: incoming.kronosBias4h,
    selectedKronosBias: incoming.selectedKronosBias,
    kronosConfidence: incoming.kronosConfidence,
    kronosConfidenceBucket: incoming.kronosConfidenceBucket,
    expectedReturn1h: incoming.expectedReturn1h,
    expectedReturn4h: incoming.expectedReturn4h,
    horizonConflict: incoming.horizonConflict,
    whaleSignal: incoming.whaleSignal,
    whaleScore: incoming.whaleScore,
    sentimentSignal: incoming.sentimentSignal,
    sentimentScore: incoming.sentimentScore,
    selectedExecutionPlan: base.selectedExecutionPlan ?? incoming.selectedExecutionPlan ?? null,
    outcomes: mergedOutcomes,
  };
}

export function normalizeTrackedSignal(signal: TrackedSignal): TrackedSignal {
  const timeframeBucket = signal.timeframeBucket ?? "INTRADAY_5M_15M_1H";
  const signalFamily = signal.signalFamily ?? "ROTATION_SETUP";
  const latestStatus = signal.latestStatus ?? signal.finalStatus;
  const firstStatus = signal.firstStatus ?? signal.finalStatus;
  const normalizedSignalKey = signal.normalizedSignalKey ?? buildNormalizedSignalKey({
    symbol: signal.symbol,
    direction: signal.direction,
    timeframeBucket,
    signalFamily,
    entryZone: signal.entryZone,
    priceAtScan: signal.priceAtScan,
  });

  return {
    ...signal,
    firstSeenAt: signal.firstSeenAt ?? signal.scannedAt,
    lastSeenAt: signal.lastSeenAt ?? signal.scannedAt,
    firstStatus,
    scanCount: signal.scanCount ?? 1,
    isDuplicateSuppressed: signal.isDuplicateSuppressed ?? false,
    timeframeBucket,
    signalFamily,
    normalizedSignalKey,
    latestScore: signal.latestScore ?? signal.opportunityScore,
    latestStatus,
    latestReason: signal.latestReason ?? signal.reason,
    bestStatus: signal.bestStatus ?? bestStatusOf(firstStatus, latestStatus),
    statusHistory: signal.statusHistory ?? [{ status: firstStatus, seenAt: signal.firstSeenAt ?? signal.scannedAt }],
    kronosConfidenceBucket: signal.kronosConfidenceBucket ?? inferKronosConfidenceBucket(signal.kronosConfidence),
    selectedKronosBias: signal.selectedKronosBias ?? signal.kronosBias,
    horizonConflict: signal.horizonConflict ?? false,
    selectedExecutionPlan: signal.selectedExecutionPlan ?? null,
  };
}

export function collapseTrackedSignals(signals: TrackedSignal[]): { signals: TrackedSignal[]; suppressedDuplicateScans: number } {
  const sortedSignals = [...signals]
    .map((signal) => normalizeTrackedSignal(signal))
    .sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime());
  const uniqueSignals: TrackedSignal[] = [];
  let suppressedDuplicateScans = 0;

  for (const signal of sortedSignals) {
    const signalLastSeenMs = new Date(signal.lastSeenAt).getTime();
    const duplicateIndex = uniqueSignals.findIndex((existing) =>
      existing.symbol === signal.symbol &&
      existing.direction === signal.direction &&
      existing.timeframeBucket === signal.timeframeBucket &&
      existing.signalFamily === signal.signalFamily &&
      existing.normalizedSignalKey === signal.normalizedSignalKey &&
      !isResolvedOrExpired(existing) &&
      signalLastSeenMs - new Date(existing.lastSeenAt).getTime() <= DUPLICATE_COOLDOWN_MS,
    );

    if (duplicateIndex === -1) {
      uniqueSignals.push(signal);
      continue;
    }

    const previous = uniqueSignals[duplicateIndex];
    uniqueSignals[duplicateIndex] = mergeSignalState(previous, signal);
    suppressedDuplicateScans += signal.scanCount;
  }

  return { signals: uniqueSignals, suppressedDuplicateScans };
}

export class SignalTracker {
  private readonly dataDir: string;
  private readonly historyFile: string;
  private readonly rawHistoryFile: string;
  private readonly archiveFile: string;
  private readonly migrationAuditFile: string;
  private readonly outcomeCheckerAuditFile: string;

  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.historyFile = resolve(dataDir, "scan-history.jsonl");
    this.rawHistoryFile = resolve(dataDir, "scan-history-raw.jsonl");
    this.archiveFile = resolve(dataDir, "scan-history-pre-dedupe-archive.jsonl");
    this.migrationAuditFile = resolve(dataDir, MIGRATION_AUDIT_FILE);
    this.outcomeCheckerAuditFile = resolve(dataDir, OUTCOME_CHECKER_AUDIT_FILE);
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private ensureRawHistorySeeded(): void {
    if (!existsSync(this.rawHistoryFile) && existsSync(this.historyFile)) {
      copyFileSync(this.historyFile, this.rawHistoryFile);
    }
  }

  /**
   * Best-effort rotation of scan-history.jsonl and scan-history-raw.jsonl.
   * Files larger than SCAN_HISTORY_ROTATION_THRESHOLD_BYTES (default 100MB)
   * are archived under <dataDir>/archive/ and the last
   * SCAN_HISTORY_ROTATION_TAIL_LINES (default 10000) lines retained.
   *
   * Disabled via SCAN_HISTORY_ROTATION_DISABLED=1.
   * Never throws into the caller.
   *
   * Bug fixed: scan-history*.jsonl growing to ~500MB previously broke scans
   * with "Cannot create a string longer..." (Node string-size limit). The
   * rotation uses a chunked backward reader and never loads the full file.
   */
  private maybeRotate(): void {
    try {
      if (process.env.SCAN_HISTORY_ROTATION_DISABLED === "1") return;
      const thresholdBytes =
        Number(process.env.SCAN_HISTORY_ROTATION_THRESHOLD_BYTES) || 100 * 1024 * 1024;
      const tailLines = Number(process.env.SCAN_HISTORY_ROTATION_TAIL_LINES) || 10_000;
      const tailBytes = Number(process.env.SCAN_HISTORY_ROTATION_TAIL_BYTES) || 25 * 1024 * 1024;
      for (const targetPath of [this.historyFile, this.rawHistoryFile]) {
        try {
          const result = rotateJsonlIfNeeded(targetPath, { thresholdBytes, tailLines, tailBytes });
          if (result.rotated) {
            console.warn(
              `[tracker] rotated ${targetPath}: archived ${result.fromSize ?? "?"} bytes → ${result.archivePath ?? "?"}; kept ${result.linesKept ?? 0} lines`,
            );
          } else if (result.error) {
            // intentionally quiet — rotation failure must never block scans
          }
        } catch {
          // never throw from per-file rotation
        }
      }
    } catch {
      // silent fail; rotation must never block scan
    }
  }

  async persistScan(result: ScanResult): Promise<void> {
    this.maybeRotate();
    this.ensureRawHistorySeeded();
    const scannedAtMs = new Date(result.generatedAt).getTime();
    const existingSignals = this.readAll();
    const rawSignals = this.readAllRaw();

    for (const candidate of result.top10) {
      if (candidate.status === "SKIP") continue;
      const incoming = candidateToTracked(candidate, result.generatedAt, result.marketRegime);
      appendFileSync(this.rawHistoryFile, JSON.stringify(incoming) + "\n", "utf-8");
      rawSignals.push(incoming);

      const duplicateIndex = existingSignals.findIndex((signal) =>
        signal.symbol === incoming.symbol &&
        signal.direction === incoming.direction &&
        signal.timeframeBucket === incoming.timeframeBucket &&
        signal.signalFamily === incoming.signalFamily &&
        !isResolvedOrExpired(signal) &&
        scannedAtMs - new Date(signal.lastSeenAt).getTime() <= DUPLICATE_COOLDOWN_MS &&
        !hasMaterialEntryZoneChange(signal, incoming),
      );

      if (duplicateIndex !== -1) {
        existingSignals[duplicateIndex] = mergeSignalState(existingSignals[duplicateIndex], incoming);
        continue;
      }

      existingSignals.push(incoming);
    }

    this.writeAll(existingSignals);
  }

  readAll(): TrackedSignal[] {
    const canonicalSource = existsSync(this.historyFile) ? this.historyFile : this.rawHistoryFile;
    if (!existsSync(canonicalSource)) return [];
    const content = readFileSync(canonicalSource, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => normalizeTrackedSignal(JSON.parse(line) as TrackedSignal));
  }

  readAllRaw(): TrackedSignal[] {
    this.ensureRawHistorySeeded();
    const source = existsSync(this.rawHistoryFile) ? this.rawHistoryFile : this.historyFile;
    if (!existsSync(source)) return [];
    const content = readFileSync(source, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => normalizeTrackedSignal(JSON.parse(line) as TrackedSignal));
  }

  writeAll(signals: TrackedSignal[]): void {
    const content = signals.map((s) => JSON.stringify(normalizeTrackedSignal(s))).join("\n");
    writeFileSync(this.historyFile, content + (signals.length ? "\n" : ""), "utf-8");
  }

  writeAllRaw(signals: TrackedSignal[]): void {
    const content = signals.map((s) => JSON.stringify(normalizeTrackedSignal(s))).join("\n");
    writeFileSync(this.rawHistoryFile, content + (signals.length ? "\n" : ""), "utf-8");
  }

  getLastTrackerUpdateAt(): string | null {
    const source = existsSync(this.historyFile) ? this.historyFile : this.rawHistoryFile;
    if (!existsSync(source)) return null;
    return statSync(source).mtime.toISOString();
  }

  getPerformanceInputSignature(): string {
    this.ensureRawHistorySeeded();
    const source = existsSync(this.rawHistoryFile) ? this.rawHistoryFile : this.historyFile;
    const history = existsSync(source)
      ? (() => {
          const stat = statSync(source);
          return `${source}:${stat.size}:${stat.mtimeMs}`;
        })()
      : `${source}:missing`;
    const outcomeAudit = existsSync(this.outcomeCheckerAuditFile)
      ? (() => {
          const stat = statSync(this.outcomeCheckerAuditFile);
          return `${this.outcomeCheckerAuditFile}:${stat.size}:${stat.mtimeMs}`;
        })()
      : `${this.outcomeCheckerAuditFile}:missing`;
    return `${history}|${outcomeAudit}`;
  }

  readArchive(): TrackedSignal[] {
    if (!existsSync(this.archiveFile)) return [];
    const content = readFileSync(this.archiveFile, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => normalizeTrackedSignal(JSON.parse(line) as TrackedSignal));
  }

  private writeArchive(signals: TrackedSignal[]): void {
    const content = signals.map((s) => JSON.stringify(normalizeTrackedSignal(s))).join("\n");
    writeFileSync(this.archiveFile, content + (signals.length ? "\n" : ""), "utf-8");
  }

  getMigrationAudit(): MigrationAuditSnapshot {
    if (!existsSync(this.migrationAuditFile)) {
      return {
        currentCanonicalSample: this.readAll().length,
        archivedPreDedupeSample: this.readArchive().length,
        migratedResolvedOutcomes: 0,
        skippedLegacyRecords: 0,
        skippedLegacyReasons: [],
        note: "No rebuild migration audit recorded yet.",
      };
    }
    return JSON.parse(readFileSync(this.migrationAuditFile, "utf-8")) as MigrationAuditSnapshot;
  }

  private writeMigrationAudit(audit: MigrationAuditSnapshot): void {
    writeFileSync(this.migrationAuditFile, JSON.stringify(audit, null, 2), "utf-8");
  }

  getLastOutcomeCheckerRunAt(): string | null {
    if (!existsSync(this.outcomeCheckerAuditFile)) {
      return null;
    }
    const audit = JSON.parse(readFileSync(this.outcomeCheckerAuditFile, "utf-8")) as { lastRunAt?: string };
    return audit.lastRunAt ?? null;
  }

  setLastOutcomeCheckerRunAt(lastRunAt: string): void {
    writeFileSync(this.outcomeCheckerAuditFile, JSON.stringify({ lastRunAt }, null, 2), "utf-8");
  }

  rebuildFromRaw(): { signals: TrackedSignal[]; audit: MigrationAuditSnapshot } {
    const rawSignals = this.readAllRaw();
    const legacyCanonical = this.readAll();
    const { signals: collapsed } = collapseTrackedSignals(rawSignals);
    const archived: TrackedSignal[] = [];
    let migratedResolvedOutcomes = 0;
    const skippedReasons = new Set<string>();

    const matchedLegacyIds = new Set<string>();
    const enriched = collapsed.map((signal) => {
      const legacyMatch = legacyCanonical.find((legacy) =>
        legacy.normalizedSignalKey === signal.normalizedSignalKey &&
        legacy.direction === signal.direction &&
        Math.abs(new Date(legacy.firstSeenAt).getTime() - new Date(signal.firstSeenAt).getTime()) <= 24 * 60 * 60 * 1000,
      );

      if (!legacyMatch) {
        return signal;
      }

      matchedLegacyIds.add(legacyMatch.id);
      const legacyPrimary = getPrimaryOutcome(legacyMatch);
      const signalPrimary = getPrimaryOutcome(signal);
      const hasValidLegacyResolved =
        legacyPrimary !== null &&
        legacyPrimary.result !== "OPEN" &&
        legacyPrimary.result !== "EXPIRED" &&
        legacyMatch.entryZone !== null &&
        legacyMatch.stopLoss !== null &&
        legacyMatch.tp1 !== null;

      if (!hasValidLegacyResolved) {
        skippedReasons.add("legacy record missing valid resolved outcome or trade plan");
        return signal;
      }

      if (signalPrimary === null || signalPrimary.result === "OPEN" || signalPrimary.result === "EXPIRED") {
        migratedResolvedOutcomes += 1;
        return {
          ...signal,
          outcomes: legacyMatch.outcomes,
        };
      }

      return signal;
    });

    for (const legacy of legacyCanonical) {
      const legacyPrimary = getPrimaryOutcome(legacy);
      const hasResolvedLegacy = legacyPrimary !== null && legacyPrimary.result !== "OPEN" && legacyPrimary.result !== "EXPIRED";
      if (hasResolvedLegacy && !matchedLegacyIds.has(legacy.id)) {
        archived.push(legacy);
      }
    }

    if (archived.length > 0) {
      skippedReasons.add("legacy resolved record could not be safely matched and was archived");
    }

    this.writeAll(enriched);
    this.writeArchive(archived);

    const audit: MigrationAuditSnapshot = {
      currentCanonicalSample: enriched.length,
      archivedPreDedupeSample: archived.length,
      migratedResolvedOutcomes,
      skippedLegacyRecords: archived.length,
      skippedLegacyReasons: [...skippedReasons],
      note:
        archived.length > 0
          ? "Post-dedupe analytics continues from canonical data. Unmatched resolved legacy records were preserved in pre-dedupe archive."
          : "Resolved legacy outcomes were migrated into the canonical post-dedupe sample where safe.",
    };
    this.writeMigrationAudit(audit);
    return { signals: enriched, audit };
  }

  rebuildCanonicalSnapshot(): TrackedSignal[] {
    const collapsed = collapseTrackedSignals(this.readAllRaw()).signals;
    this.writeAll(collapsed);
    return collapsed;
  }
}

function candidateToTracked(candidate: Candidate, scannedAt: string, marketRegime: string): TrackedSignal {
  const timeframeBucket = determineTimeframeBucket(candidate);
  const signalFamily = determineSignalFamily(candidate);
  return {
    id: randomUUID(),
    scannedAt,
    firstSeenAt: scannedAt,
    lastSeenAt: scannedAt,
    firstStatus: candidate.finalStatus,
    scanCount: 1,
    isDuplicateSuppressed: false,
    timeframeBucket,
    signalFamily,
    normalizedSignalKey: buildNormalizedSignalKey({
      symbol: candidate.symbol,
      direction: candidate.finalDirection,
      timeframeBucket,
      signalFamily,
      entryZone: candidate.entryZone,
      priceAtScan: candidate.indicators.fiveMinute.latestClose,
    }),
    latestScore: candidate.opportunityScore,
    latestStatus: candidate.finalStatus,
    latestReason: candidate.reason,
    bestStatus: candidate.finalStatus,
    statusHistory: [{ status: candidate.finalStatus, seenAt: scannedAt }],
    symbol: candidate.symbol,
    direction: candidate.finalDirection,
    finalStatus: candidate.finalStatus,
    opportunityScore: candidate.opportunityScore,
    dangerScore: candidate.dangerScore,
    confidence: candidate.confidence,
    longScore: candidate.longScore,
    shortScore: candidate.shortScore,
    kronosScore: candidate.kronosScore,
    priceAtScan: candidate.indicators.fiveMinute.latestClose,
    entryZone: candidate.entryZone,
    stopLoss: candidate.stopLoss,
    tp1: candidate.takeProfits.tp1,
    tp2: candidate.takeProfits.tp2,
    tp3: candidate.takeProfits.tp3,
    reason: candidate.reason,
    directionConflict: candidate.directionConflict,
    sourceConflict: candidate.sourceConflict,
    kronosBias: candidate.kronosBias,
    kronosBias1h: candidate.kronosBias1h ?? null,
    kronosBias4h: candidate.kronosBias4h ?? null,
    selectedKronosBias: candidate.selectedKronosBias ?? candidate.kronosBias,
    kronosConfidence: candidate.kronosConfidence,
    kronosConfidenceBucket: candidate.kronosConfidenceBucket,
    expectedReturn1h: candidate.expectedReturn1h ?? null,
    expectedReturn4h: candidate.expectedReturn4h ?? null,
    horizonConflict: candidate.horizonConflict ?? false,
    selectedExecutionPlan: candidate.selectedExecutionPlan ?? null,
    whaleSignal: candidate.whale.signal,
    whaleScore: candidate.whale.score,
    sentimentSignal: candidate.sentiment.signal,
    sentimentScore: candidate.sentiment.score,
    analysisContext: {
      marketRegime,
      spreadPercent: candidate.spread.percent,
      riskReward: candidate.riskReward,
      fiveMinuteEma20: candidate.indicators.fiveMinute.ema20,
      fiveMinuteVwap: candidate.indicators.fiveMinute.vwap,
      fiveMinuteAtr14: candidate.indicators.fiveMinute.atr14,
      fiveMinuteAtrPercent: candidate.indicators.fiveMinute.atrPercent,
      fiveMinuteVolumeRatio: candidate.indicators.fiveMinute.volumeRatio,
      fiveMinuteTrend: candidate.indicators.fiveMinute.trend,
      fifteenMinuteTrend: candidate.indicators.fifteenMinute.trend,
      oneHourTrend: candidate.indicators.oneHour.trend,
      fibonacci: candidate.fibonacci,
    },
    outcomes: { "30m": null, "1h": null, "4h": null, "24h": null },
  };
}
