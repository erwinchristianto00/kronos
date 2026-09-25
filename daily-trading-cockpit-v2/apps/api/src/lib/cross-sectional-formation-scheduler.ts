/**
 * Boundary-aligned orchestration for the hourly Cross-Sectional formation pass.
 *
 * Dynamic MOM36 is defined from one fully completed 1h candle.  A generic
 * interval that starts at process boot can therefore land after the executor's
 * feature-freshness window even when every individual component is healthy.
 * This scheduler owns only formation timing: it neither places nor cancels an
 * order.  A persisted fresh signal is handed to the executor separately.
 */

export const CROSS_SECTIONAL_FORMATION_BAR_MS = 60 * 60_000;
export const CROSS_SECTIONAL_FORMATION_POST_CLOSE_GRACE_MS = 20_000;
export const CROSS_SECTIONAL_FORMATION_RETRY_MS = 60_000;

export type CrossSectionalFormationCycleResult = {
  opened?: number;
  openedDynamicMom36Shock?: number;
} | null;

export type CrossSectionalFormationSchedulerOutcome =
  | "IDLE"
  | "WAITING_FOR_CLOSE"
  | "CATCHING_UP"
  | "RUNNING"
  | "RETRYING_FOR_FRESH_FEATURE"
  | "FORMED"
  | "NO_TRADE"
  | "ALREADY_FRESH"
  | "WINDOW_EXPIRED"
  | "ERROR"
  | "STOPPED";

export type CrossSectionalFormationSchedulerStatus = {
  enabled: boolean;
  interval: "1h";
  postCloseGraceMs: number;
  retryIntervalMs: number;
  featureMaxAgeMs: number;
  latestAttemptStartOffsetMs: number;
  startedAt: string | null;
  nextDueAt: string | null;
  inFlight: boolean;
  activeFeatureCutoffAt: string | null;
  attemptsForActiveFeature: number;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastFeatureCutoffAt: string | null;
  lastOutcome: CrossSectionalFormationSchedulerOutcome;
  lastError: string | null;
  lastExecutorHandoffAt: string | null;
  lastExecutorHandoffError: string | null;
};

export type CrossSectionalFormationSchedulerOptions = {
  /** Executes the causal, persisted formation pass.  It must not place orders. */
  runFormation: () => Promise<CrossSectionalFormationCycleResult>;
  /** True only once the requested 1h feature cutoff was durably evaluated. */
  hasFreshFeature: (featureCutoffMs: number) => boolean;
  /** Receives only a newly persisted signal; executor ownership remains outside this scheduler. */
  onSignalFormed?: (result: Exclude<CrossSectionalFormationCycleResult, null>) => void | Promise<void>;
  /** Same policy cap the executor uses for feature freshness. */
  featureMaxAgeMs: number;
  nowMs?: () => number;
  postCloseGraceMs?: number;
  retryIntervalMs?: number;
};

const finitePositive = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;

const iso = (value: number | null): string | null => value === null ? null : new Date(value).toISOString();

const hourCutoff = (nowMs: number): number => Math.floor(nowMs / CROSS_SECTIONAL_FORMATION_BAR_MS) * CROSS_SECTIONAL_FORMATION_BAR_MS;

/**
 * One process-local, deadline-aware single-flight scheduler.  Unlike a generic
 * coalescing timer, it never queues a stale catch-up after the freshness window.
 */
export class CrossSectionalFormationScheduler {
  private readonly runFormation: () => Promise<CrossSectionalFormationCycleResult>;
  private readonly hasFreshFeature: (featureCutoffMs: number) => boolean;
  private readonly onSignalFormed: ((result: Exclude<CrossSectionalFormationCycleResult, null>) => void | Promise<void>) | null;
  private readonly nowMs: () => number;
  private readonly featureMaxAgeMs: number;
  private readonly postCloseGraceMs: number;
  private readonly retryIntervalMs: number;
  private readonly latestAttemptStartOffsetMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight = false;
  private startedAtMs: number | null = null;
  private nextDueAtMs: number | null = null;
  private activeFeatureCutoffMs: number | null = null;
  private attemptsForActiveFeature = 0;
  private lastAttemptAtMs: number | null = null;
  private lastCompletedAtMs: number | null = null;
  private lastFeatureCutoffMs: number | null = null;
  private lastOutcome: CrossSectionalFormationSchedulerOutcome = "IDLE";
  private lastError: string | null = null;
  private lastExecutorHandoffAtMs: number | null = null;
  private lastExecutorHandoffError: string | null = null;

  constructor(opts: CrossSectionalFormationSchedulerOptions) {
    this.runFormation = opts.runFormation;
    this.hasFreshFeature = opts.hasFreshFeature;
    this.onSignalFormed = opts.onSignalFormed ?? null;
    this.nowMs = opts.nowMs ?? Date.now;
    this.featureMaxAgeMs = finitePositive(opts.featureMaxAgeMs, 5 * 60_000);
    this.postCloseGraceMs = finitePositive(opts.postCloseGraceMs, CROSS_SECTIONAL_FORMATION_POST_CLOSE_GRACE_MS);
    this.retryIntervalMs = finitePositive(opts.retryIntervalMs, CROSS_SECTIONAL_FORMATION_RETRY_MS);
    // Preserve time to persist the signal and dispatch the executor even if the
    // configured freshness cap is tightened.  The normal 5m cap leaves 60s.
    const reserveMs = Math.min(60_000, Math.max(15_000, Math.floor(this.featureMaxAgeMs / 5)));
    this.latestAttemptStartOffsetMs = Math.max(this.postCloseGraceMs, this.featureMaxAgeMs - reserveMs);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAtMs = this.nowMs();
    this.scheduleCurrentWindowOrNext();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextDueAtMs = null;
    this.lastOutcome = "STOPPED";
  }

  getStatus(): CrossSectionalFormationSchedulerStatus {
    return {
      enabled: this.started,
      interval: "1h",
      postCloseGraceMs: this.postCloseGraceMs,
      retryIntervalMs: this.retryIntervalMs,
      featureMaxAgeMs: this.featureMaxAgeMs,
      latestAttemptStartOffsetMs: this.latestAttemptStartOffsetMs,
      startedAt: iso(this.startedAtMs),
      nextDueAt: iso(this.nextDueAtMs),
      inFlight: this.inFlight,
      activeFeatureCutoffAt: iso(this.activeFeatureCutoffMs),
      attemptsForActiveFeature: this.attemptsForActiveFeature,
      lastAttemptAt: iso(this.lastAttemptAtMs),
      lastCompletedAt: iso(this.lastCompletedAtMs),
      lastFeatureCutoffAt: iso(this.lastFeatureCutoffMs),
      lastOutcome: this.lastOutcome,
      lastError: this.lastError,
      lastExecutorHandoffAt: iso(this.lastExecutorHandoffAtMs),
      lastExecutorHandoffError: this.lastExecutorHandoffError,
    };
  }

  private featureIsFresh(cutoffMs: number): boolean {
    try {
      return this.hasFreshFeature(cutoffMs) === true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private scheduleCurrentWindowOrNext(): void {
    if (!this.started) return;
    const now = this.nowMs();
    const cutoffMs = hourCutoff(now);
    const firstAttemptAtMs = cutoffMs + this.postCloseGraceMs;
    const latestAttemptAtMs = cutoffMs + this.latestAttemptStartOffsetMs;
    if (now < firstAttemptAtMs) {
      this.lastOutcome = "WAITING_FOR_CLOSE";
      this.scheduleAt(firstAttemptAtMs);
      return;
    }
    if (now <= latestAttemptAtMs && !this.featureIsFresh(cutoffMs)) {
      this.lastOutcome = "CATCHING_UP";
      this.scheduleAt(now);
      return;
    }
    // A matching cutoff proves that formation happened, not that it is still
    // eligible for entry. Once the bounded freshness window has passed, report
    // the window as expired even if a previous process persisted this hour's
    // feature; otherwise the dashboard says "already fresh" while the executor
    // correctly rejects its age.
    if (now > latestAttemptAtMs) {
      if (this.featureIsFresh(cutoffMs)) this.lastFeatureCutoffMs = cutoffMs;
      this.lastOutcome = "WINDOW_EXPIRED";
      this.scheduleAt(cutoffMs + CROSS_SECTIONAL_FORMATION_BAR_MS + this.postCloseGraceMs);
      return;
    }
    if (this.featureIsFresh(cutoffMs)) {
      this.lastFeatureCutoffMs = cutoffMs;
      this.lastOutcome = "ALREADY_FRESH";
    } else {
      this.lastOutcome = "WINDOW_EXPIRED";
    }
    this.scheduleAt(cutoffMs + CROSS_SECTIONAL_FORMATION_BAR_MS + this.postCloseGraceMs);
  }

  private scheduleAt(dueAtMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextDueAtMs = dueAtMs;
    const delayMs = Math.max(0, dueAtMs - this.nowMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextDueAtMs = null;
      void this.runDueWindow();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runDueWindow(): Promise<void> {
    if (!this.started || this.inFlight) return;
    const now = this.nowMs();
    const cutoffMs = hourCutoff(now);
    const firstAttemptAtMs = cutoffMs + this.postCloseGraceMs;
    const latestAttemptAtMs = cutoffMs + this.latestAttemptStartOffsetMs;
    if (now < firstAttemptAtMs) {
      this.lastOutcome = "WAITING_FOR_CLOSE";
      this.scheduleAt(firstAttemptAtMs);
      return;
    }
    if (now > latestAttemptAtMs) {
      this.lastOutcome = "WINDOW_EXPIRED";
      this.scheduleAt(cutoffMs + CROSS_SECTIONAL_FORMATION_BAR_MS + this.postCloseGraceMs);
      return;
    }
    if (this.featureIsFresh(cutoffMs)) {
      this.lastFeatureCutoffMs = cutoffMs;
      this.lastOutcome = "ALREADY_FRESH";
      this.scheduleAt(cutoffMs + CROSS_SECTIONAL_FORMATION_BAR_MS + this.postCloseGraceMs);
      return;
    }

    if (this.activeFeatureCutoffMs !== cutoffMs) {
      this.activeFeatureCutoffMs = cutoffMs;
      this.attemptsForActiveFeature = 0;
    }
    this.inFlight = true;
    this.attemptsForActiveFeature += 1;
    this.lastAttemptAtMs = now;
    this.lastOutcome = "RUNNING";
    this.lastError = null;
    try {
      const result = await this.runFormation();
      if (!this.started) return;
      if (this.featureIsFresh(cutoffMs)) {
        this.lastCompletedAtMs = this.nowMs();
        this.lastFeatureCutoffMs = cutoffMs;
        this.lastOutcome = (result?.opened ?? 0) > 0 ? "FORMED" : "NO_TRADE";
        if (result && (result.opened ?? 0) > 0) this.dispatchExecutorHandoff(result);
        this.scheduleAt(cutoffMs + CROSS_SECTIONAL_FORMATION_BAR_MS + this.postCloseGraceMs);
        return;
      }
      this.scheduleRetryOrNext(cutoffMs);
    } catch (error) {
      if (!this.started) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastOutcome = "ERROR";
      this.scheduleRetryOrNext(cutoffMs);
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleRetryOrNext(cutoffMs: number): void {
    const now = this.nowMs();
    const latestAttemptAtMs = cutoffMs + this.latestAttemptStartOffsetMs;
    const retryAtMs = now + this.retryIntervalMs;
    if (retryAtMs <= latestAttemptAtMs) {
      this.lastOutcome = "RETRYING_FOR_FRESH_FEATURE";
      this.scheduleAt(retryAtMs);
      return;
    }
    this.lastOutcome = "WINDOW_EXPIRED";
    this.scheduleAt(cutoffMs + CROSS_SECTIONAL_FORMATION_BAR_MS + this.postCloseGraceMs);
  }

  private dispatchExecutorHandoff(result: Exclude<CrossSectionalFormationCycleResult, null>): void {
    if (!this.onSignalFormed) return;
    this.lastExecutorHandoffAtMs = this.nowMs();
    this.lastExecutorHandoffError = null;
    void Promise.resolve(this.onSignalFormed(result)).catch((error) => {
      this.lastExecutorHandoffError = error instanceof Error ? error.message : String(error);
    });
  }
}
