import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type InnovationObservationStatus = "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";

export interface InnovationObservationBase {
  observationId: string;
  openedAt: string;
  openedAtMs: number;
  status: InnovationObservationStatus;
  grossR: number | null;
  costR: number | null;
  netR: number | null;
  exitReason: string | null;
  resolvedAt: string | null;
}

export interface InnovationCycleResult {
  scanned: number;
  candidates: number;
  recorded: number;
  resolved: number;
  expired: number;
  rejected: number;
}

export interface InnovationCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  scannedTotal: number;
  candidatesTotal: number;
  recordedTotal: number;
  resolvedTotal: number;
  expiredTotal: number;
  rejectedTotal: number;
  lastCycleError: string | null;
}

interface InnovationStoreState<T extends InnovationObservationBase> {
  version: number;
  observations: T[];
  cycleMeta: InnovationCycleMeta;
}

const EMPTY_META: InnovationCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  scannedTotal: 0,
  candidatesTotal: 0,
  recordedTotal: 0,
  resolvedTotal: 0,
  expiredTotal: 0,
  rejectedTotal: 0,
  lastCycleError: null,
};

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export class InnovationShadowStore<T extends InnovationObservationBase> {
  private state: InnovationStoreState<T> = {
    version: 1,
    observations: [],
    cycleMeta: { ...EMPTY_META },
  };

  constructor(
    private readonly file: string,
    private readonly maxSettled = 500,
  ) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<InnovationStoreState<T>>;
      if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations;
      if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
        this.state.cycleMeta = { ...EMPTY_META, ...parsed.cycleMeta };
      }
    } catch {
      // Corrupt research telemetry starts empty; it must never affect an execution path.
    }
  }

  get all(): T[] {
    return this.state.observations;
  }

  get cycleMeta(): InnovationCycleMeta {
    return this.state.cycleMeta;
  }

  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }

  add(observation: T): boolean {
    if (this.has(observation.observationId)) return false;
    this.state.observations.push(observation);
    return true;
  }

  update(observationId: string, patch: Partial<T>): void {
    const observation = this.state.observations.find((o) => o.observationId === observationId);
    if (observation) Object.assign(observation, patch);
  }

  recordCycle(at: string, result: InnovationCycleResult | null, error: string | null = null): void {
    const previous = this.state.cycleMeta;
    this.state.cycleMeta = {
      lastCycleAt: at,
      cycles: previous.cycles + 1,
      scannedTotal: previous.scannedTotal + (result?.scanned ?? 0),
      candidatesTotal: previous.candidatesTotal + (result?.candidates ?? 0),
      recordedTotal: previous.recordedTotal + (result?.recorded ?? 0),
      resolvedTotal: previous.resolvedTotal + (result?.resolved ?? 0),
      expiredTotal: previous.expiredTotal + (result?.expired ?? 0),
      rejectedTotal: previous.rejectedTotal + (result?.rejected ?? 0),
      lastCycleError: error,
    };
  }

  save(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keptSettled = settled.length > this.maxSettled
      ? settled.slice(settled.length - this.maxSettled)
      : settled;
    this.state.observations = [...open, ...keptSettled];

    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file);
  }
}

export interface InnovationShadowReport<TRecent = Record<string, unknown>> {
  laneId: string;
  parentLaneId: string | null;
  version: "V2" | "V1";
  thesis: string;
  signalSource: string;
  openCount: number;
  resolvedCount: number;
  expiredCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  edgeReady: boolean;
  edgeGate: {
    minimumResolved: number;
    minimumNetAvgR: number;
    minimumProfitFactor: number;
  };
  cycleMeta: InnovationCycleMeta;
  details: Record<string, unknown>;
  topRecent: TRecent[];
}

export function buildInnovationShadowReport<T extends InnovationObservationBase, TRecent = Record<string, unknown>>(opts: {
  laneId: string;
  parentLaneId: string | null;
  version?: "V2" | "V1";
  thesis: string;
  signalSource: string;
  store: InnovationShadowStore<T>;
  details?: Record<string, unknown>;
  recent?: (observation: T) => TRecent;
}): InnovationShadowReport<TRecent> {
  const resolved = opts.store.all.filter(
    (o) => o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS",
  );
  const net = resolved.map((o) => o.netR).filter(finite);
  const wins = net.filter((r) => r > 0);
  const losses = net.filter((r) => r <= 0);
  const grossProfit = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  const netAvgR = net.length ? net.reduce((sum, r) => sum + r, 0) / net.length : null;
  // No-loss cohorts keep PF null until a real denominator exists. JSON would serialize Infinity
  // as null anyway; being explicit also prevents a tiny all-win sample from passing edgeReady.
  const pf = net.length && grossLoss > 0 ? grossProfit / grossLoss : null;
  const wr = net.length ? wins.length / net.length : null;
  const edgeReady =
    net.length >= 30 &&
    netAvgR !== null &&
    netAvgR >= 0.05 &&
    pf !== null &&
    pf > 1.1;

  const recentRows = [...opts.store.all]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => opts.recent ? opts.recent(o) : (o as unknown as TRecent));

  return {
    laneId: opts.laneId,
    parentLaneId: opts.parentLaneId,
    version: opts.version ?? "V2",
    thesis: opts.thesis,
    signalSource: opts.signalSource,
    openCount: opts.store.all.filter((o) => o.status === "OPEN").length,
    resolvedCount: net.length,
    expiredCount: opts.store.all.filter((o) => o.status === "EXPIRED").length,
    netAvgR,
    wr,
    pf,
    totalNetR: net.reduce((sum, r) => sum + r, 0),
    edgeReady,
    edgeGate: {
      minimumResolved: 30,
      minimumNetAvgR: 0.05,
      minimumProfitFactor: 1.1,
    },
    cycleMeta: opts.store.cycleMeta,
    details: opts.details ?? {},
    topRecent: recentRows,
  };
}
