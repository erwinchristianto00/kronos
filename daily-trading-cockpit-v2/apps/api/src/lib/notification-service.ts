import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NotificationState {
  lastRegime: string | null;
  lastMode: string | null;
  lastBias: string | null;
  lastConfidence: string | null;
  lastPaperPnl: number | null;
  lastDiagnosticPnl: number | null;
  lastTotalPaperPnl: number | null;
  lastStartingBalance: number | null;
  lastHeadlineBalance: number | null;
  lastTotalBalance: number | null;
  lastProjectedMonthEndBalance: number | null;
  lastDailyPnl: number | null;
  lastHeadlineNet: number | null;
  lastHeadlinePF: number | null;
  lastHeadlineWR: number | null;
  lastGuardrailStatus: string | null;
  lastRecommendedAction: string | null;
  lastClosedUnderProfileCount: number;
  lastForwardVerdict: string | null;
  lastTotalOrders: number;
  lastOpenOrders: number;
  lastClosedOrders: number;
  lastSentAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
}

export interface NotificationOrderSummary {
  symbol: string;
  direction: string;
  lane: string;
  admission: string | null;
  profile: string | null;
  occupancyMode: string | null;
  riskMultiplier: number | null;
}

export interface NotificationSnapshot {
  regime: string | null;
  mode: string | null;
  bias: string | null;
  confidence: string | null;
  /** Official headline-only realized paper PnL. */
  paperPnl: number | null;
  diagnosticPnl: number | null;
  totalPaperPnl: number | null;
  startingBalance: number | null;
  headlineBalance: number | null;
  totalBalance: number | null;
  monthTotalPaperPnl: number | null;
  todayClosed: number;
  todayWins: number;
  todayLosses: number;
  todayHeadlinePnl: number | null;
  todayDiagnosticPnl: number | null;
  todayTotalPnl: number | null;
  dailyPnl: number | null;
  headlineNet: number | null;
  headlinePF: number | null;
  headlineWR: number | null;
  guardrailStatus: string | null;
  recommendedAction: string | null;
  guardrailReasons: string[];
  activeMixedBudgetProfile: string | null;
  closedUnderProfileCount: number;
  forwardVerdict: string | null;
  totalOrders: number;
  openOrders: number;
  closedOrders: number;
  wins: number;
  losses: number;
  latestOrder: NotificationOrderSummary | null;
}

export interface NotificationEvaluationResult {
  enabled: boolean;
  initialized: boolean;
  alertsAttempted: number;
  alertsSent: number;
  alerts: string[];
}

export interface NotificationServiceStatus {
  enabled: boolean;
  configured: boolean;
  stateFile: string;
  lastState: NotificationState;
  lastSendTime: string | null;
  lastError: string | null;
}

export interface NotificationServiceOptions {
  dataDir?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  warn?: (message: string) => void;
  heartbeatIntervalMs?: number;
}

const STATE_FILE = "notification-state.json";
const TELEGRAM_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000;
const FORWARD_MILESTONES = [1, 5, 10, 20, 30, 50, 100] as const;

function emptyState(): NotificationState {
  return {
    lastRegime: null,
    lastMode: null,
    lastBias: null,
    lastConfidence: null,
    lastPaperPnl: null,
    lastDiagnosticPnl: null,
    lastTotalPaperPnl: null,
    lastStartingBalance: null,
    lastHeadlineBalance: null,
    lastTotalBalance: null,
    lastProjectedMonthEndBalance: null,
    lastDailyPnl: null,
    lastHeadlineNet: null,
    lastHeadlinePF: null,
    lastHeadlineWR: null,
    lastGuardrailStatus: null,
    lastRecommendedAction: null,
    lastClosedUnderProfileCount: 0,
    lastForwardVerdict: null,
    lastTotalOrders: 0,
    lastOpenOrders: 0,
    lastClosedOrders: 0,
    lastSentAt: null,
    lastHeartbeatAt: null,
    lastError: null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function envThreshold(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function fmtNumber(value: number | null, digits = 2, signed = false): string {
  if (value === null) return "n/a";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}`;
}

export function fmtNtd(value: number | null): string {
  if (value === null) return "n/a";
  const rounded = Math.ceil(value - Number.EPSILON);
  const roundedUp = rounded === 0 ? 0 : rounded;
  return `NT$ ${new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 0,
  }).format(roundedUp)}`;
}

function fmtPf(value: number | null): string {
  if (value === null) return "n/a";
  if (value === Infinity) return "inf";
  return value.toFixed(2);
}

function changed(previous: string | null, current: string | null): boolean {
  return previous !== current;
}

function crossedMilestone(previous: number, current: number): number | null {
  return FORWARD_MILESTONES.find((milestone) => previous < milestone && current >= milestone) ?? null;
}

export function calculateLinearMonthEndProjection(
  totalBalance: number | null,
  monthTotalPaperPnl: number | null,
  now: Date,
): { projectedBalance: number | null; dailyPace: number | null } {
  if (totalBalance === null || monthTotalPaperPnl === null) {
    return { projectedBalance: null, dailyPace: null };
  }
  const elapsedDays =
    now.getUTCDate() - 1 +
    (now.getUTCHours() * 3_600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 86_400;
  const safeElapsedDays = Math.max(1, elapsedDays);
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const dailyPace = monthTotalPaperPnl / safeElapsedDays;
  const remainingDays = Math.max(0, daysInMonth - elapsedDays);
  return {
    projectedBalance: totalBalance + dailyPace * remainingDays,
    dailyPace,
  };
}

function sanitizedError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Telegram request timed out";
    return error.message.slice(0, 300).replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "Telegram API");
  }
  return "Telegram request failed";
}

export class NotificationService {
  readonly stateFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private state: NotificationState;
  private initialized: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private latestSnapshot: NotificationSnapshot | null = null;
  private snapshotProvider: (() => NotificationSnapshot | Promise<NotificationSnapshot>) | null = null;
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | null;

  constructor(options: NotificationServiceOptions = {}) {
    const dataDir =
      options.dataDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../data");
    this.stateFile = resolve(dataDir, STATE_FILE);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.initialized = existsSync(this.stateFile);
    this.state = this.loadState();
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer =
      heartbeatIntervalMs > 0
        ? setInterval(() => {
            void this.sendStatusHeartbeat().catch(() => {
              // Heartbeat failures are warning-only and never escape the timer.
            });
          }, heartbeatIntervalMs)
        : null;
    this.heartbeatTimer?.unref();
  }

  isEnabled(): boolean {
    return (
      this.env.NOTIFICATIONS_ENABLED?.toLowerCase() === "true" &&
      Boolean(this.env.TELEGRAM_BOT_TOKEN) &&
      Boolean(this.env.TELEGRAM_CHAT_ID)
    );
  }

  getStatus(): NotificationServiceStatus {
    return {
      enabled: this.isEnabled(),
      configured: Boolean(this.env.TELEGRAM_BOT_TOKEN) && Boolean(this.env.TELEGRAM_CHAT_ID),
      stateFile: this.stateFile,
      lastState: { ...this.state },
      lastSendTime: this.state.lastSentAt,
      lastError: this.state.lastError,
    };
  }

  evaluate(snapshot: NotificationSnapshot): Promise<NotificationEvaluationResult> {
    this.latestSnapshot = snapshot;
    const run = this.queue.then(() => this.evaluateInternal(snapshot));
    this.queue = run.catch(() => undefined);
    return run;
  }

  setSnapshotProvider(
    provider: () => NotificationSnapshot | Promise<NotificationSnapshot>,
  ): void {
    this.snapshotProvider = provider;
  }

  sendStatusHeartbeat(): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (!this.isEnabled()) return false;
      let snapshot = this.latestSnapshot;
      try {
        if (this.snapshotProvider) {
          snapshot = await this.snapshotProvider();
          this.latestSnapshot = snapshot;
          await this.evaluateInternal(snapshot);
        }
      } catch (error) {
        const message = sanitizedError(error);
        this.state.lastError = message;
        this.persistState();
        this.warn(`[notifications] status snapshot failed: ${message}`);
        return false;
      }
      if (!snapshot) return false;
      const sent = await this.sendTelegram(this.buildStatusHeartbeat(snapshot));
      if (sent) {
        const sentAt = this.now().toISOString();
        this.state.lastSentAt = sentAt;
        this.state.lastHeartbeatAt = sentAt;
        this.state.lastError = null;
        this.persistState();
      }
      return sent;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  sendTestMessage(): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (!this.isEnabled()) return false;
      return this.sendTelegram(
        [
          "Telegram Notifications Test",
          "daily-trading-cockpit-v2 notification channel is configured.",
          "liveBlocked=TRUE microPilotAllowed=FALSE",
        ].join("\n"),
      );
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async evaluateInternal(snapshot: NotificationSnapshot): Promise<NotificationEvaluationResult> {
    if (!this.isEnabled()) {
      return { enabled: false, initialized: false, alertsAttempted: 0, alertsSent: 0, alerts: [] };
    }

    if (!this.initialized) {
      this.state = this.stateFromSnapshot(snapshot, this.state.lastSentAt, null);
      this.initialized = true;
      this.persistState();
      return { enabled: true, initialized: true, alertsAttempted: 0, alertsSent: 0, alerts: [] };
    }

    const messages = this.buildMessages(snapshot);
    let sent = 0;
    let failed = false;
    for (const message of messages) {
      const ok = await this.sendTelegram(message.text);
      if (ok) sent += 1;
      else failed = true;
    }

    if (!failed) {
      this.state = this.stateFromSnapshot(
        snapshot,
        sent > 0 ? this.now().toISOString() : this.state.lastSentAt,
        null,
      );
    }
    this.persistState();
    return {
      enabled: true,
      initialized: false,
      alertsAttempted: messages.length,
      alertsSent: sent,
      alerts: messages.map((message) => message.type),
    };
  }

  private buildMessages(snapshot: NotificationSnapshot): Array<{ type: string; text: string }> {
    const messages: Array<{ type: string; text: string }> = [];
    if (changed(this.state.lastRegime, snapshot.regime) || changed(this.state.lastMode, snapshot.mode)) {
      messages.push({
        type: "REGIME_CHANGE",
        text: [
          "🔄 Regime Changed",
          `${this.state.lastRegime ?? "n/a"} → ${snapshot.regime ?? "n/a"}`,
          `Mode: ${this.state.lastMode ?? "n/a"} → ${snapshot.mode ?? "n/a"}`,
          `Bias: ${this.state.lastBias ?? "n/a"} → ${snapshot.bias ?? "n/a"}`,
          `Confidence: ${this.state.lastConfidence ?? "n/a"} → ${snapshot.confidence ?? "n/a"}`,
          "liveBlocked=TRUE microPilotAllowed=FALSE",
        ].join("\n"),
      });
    }

    const pnlThreshold = envThreshold(this.env, "NOTIFY_PNL_THRESHOLD_NTD", 50);
    const dailyThreshold = envThreshold(this.env, "NOTIFY_DAILY_PNL_THRESHOLD_NTD", 100);
    const netThreshold = envThreshold(this.env, "NOTIFY_NET_THRESHOLD_R", 0.05);
    const paperDelta = this.delta(snapshot.paperPnl, this.state.lastPaperPnl);
    const dailyDelta = this.delta(snapshot.dailyPnl, this.state.lastDailyPnl);
    const netDelta = this.delta(snapshot.headlineNet, this.state.lastHeadlineNet);
    if (
      (paperDelta !== null && Math.abs(paperDelta) >= pnlThreshold) ||
      (dailyDelta !== null && Math.abs(dailyDelta) >= dailyThreshold) ||
      (netDelta !== null && Math.abs(netDelta) >= netThreshold)
    ) {
      messages.push({
        type: "PNL_CHANGE",
        text: [
          "💰 Paper PnL Update",
          `Paper PnL: ${fmtNtd(this.state.lastPaperPnl)} → ${fmtNtd(snapshot.paperPnl)}`,
          `Daily PnL: ${fmtNtd(snapshot.dailyPnl)}`,
          `Headline: net=${fmtNumber(snapshot.headlineNet, 4, true)} PF=${fmtPf(snapshot.headlinePF)} WR=${snapshot.headlineWR === null ? "n/a" : `${(snapshot.headlineWR * 100).toFixed(1)}%`}`,
        ].join("\n"),
      });
    }

    const guardrailChanged =
      changed(this.state.lastGuardrailStatus, snapshot.guardrailStatus) ||
      changed(this.state.lastRecommendedAction, snapshot.recommendedAction);
    if (guardrailChanged) {
      messages.push({
        type: "GUARDRAIL_CHANGE",
        text: [
          "⚠️ Mixed Budget Guardrail",
          `Status: ${snapshot.guardrailStatus ?? "n/a"}`,
          `Action: ${snapshot.recommendedAction ?? "n/a"}`,
          `Reason: ${snapshot.guardrailReasons.join(",") || "none"}`,
          `Profile: ${snapshot.activeMixedBudgetProfile ?? "n/a"}`,
        ].join("\n"),
      });
    }

    const milestone = crossedMilestone(
      this.state.lastClosedUnderProfileCount,
      snapshot.closedUnderProfileCount,
    );
    if (milestone !== null || changed(this.state.lastForwardVerdict, snapshot.forwardVerdict)) {
      messages.push({
        type: "FORWARD_VALIDATION_PROGRESS",
        text: [
          "📈 Mixed Forward Validation",
          `Closed under profile: ${this.state.lastClosedUnderProfileCount} → ${snapshot.closedUnderProfileCount}`,
          `Milestone: ${milestone ?? "none"}`,
          `Verdict: ${this.state.lastForwardVerdict ?? "n/a"} → ${snapshot.forwardVerdict ?? "n/a"}`,
          `Profile: ${snapshot.activeMixedBudgetProfile ?? "n/a"}`,
        ].join("\n"),
      });
    }

    if (snapshot.totalOrders > this.state.lastTotalOrders) {
      const order = snapshot.latestOrder;
      messages.push({
        type: "NEW_PAPER_ORDER",
        text: order
          ? [
              "🧪 New Paper Order",
              `Symbol: ${order.symbol}`,
              `Direction: ${order.direction}`,
              `Lane: ${order.lane}`,
              `Admission: ${order.admission ?? "n/a"}`,
              `Profile: ${order.profile ?? "n/a"}`,
              `Risk: ${order.occupancyMode === "REDUCED_RISK" ? "reduced paper-only" : "paper-only"}`,
            ].join("\n")
          : [
              "🧪 New Paper Order",
              `Total orders: ${this.state.lastTotalOrders} → ${snapshot.totalOrders}`,
              "liveBlocked=TRUE microPilotAllowed=FALSE",
            ].join("\n"),
      });
    }
    return messages;
  }

  private buildStatusHeartbeat(snapshot: NotificationSnapshot): string {
    const projection = calculateLinearMonthEndProjection(
      snapshot.totalBalance,
      snapshot.monthTotalPaperPnl,
      this.now(),
    );
    return [
      "📊 Paper Bot Status (5m)",
      "",
      "TODAY (Asia/Taipei)",
      `Closed: ${snapshot.todayClosed}`,
      `Wins / Losses: ${snapshot.todayWins} / ${snapshot.todayLosses}`,
      `Headline PnL: ${fmtNtd(snapshot.todayHeadlinePnl)}`,
      `Diagnostic PnL: ${fmtNtd(snapshot.todayDiagnosticPnl)}`,
      `Total PnL: ${fmtNtd(snapshot.todayTotalPnl)}`,
      "",
      "CUMULATIVE",
      `Closed: ${snapshot.closedOrders}`,
      `Wins / Losses: ${snapshot.wins} / ${snapshot.losses}`,
      `Headline PnL: ${fmtNtd(snapshot.paperPnl)}`,
      `Diagnostic PnL: ${fmtNtd(snapshot.diagnosticPnl)}`,
      `Total Paper PnL: ${fmtNtd(snapshot.totalPaperPnl)}`,
      `Open positions now: ${snapshot.openOrders}`,
      "",
      "BALANCE",
      `Starting balance: ${fmtNtd(snapshot.startingBalance)}`,
      `Current headline balance: ${fmtNtd(snapshot.headlineBalance)}`,
      `Current total balance: ${fmtNtd(snapshot.totalBalance)}`,
      `Month-end projection: ${fmtNtd(projection.projectedBalance)}`,
      `Projection pace: ${fmtNtd(projection.dailyPace)}/day (linear MTD paper estimate, volatile)`,
      `Headline: net=${fmtNumber(snapshot.headlineNet, 4, true)} PF=${fmtPf(snapshot.headlinePF)} WR=${snapshot.headlineWR === null ? "n/a" : `${(snapshot.headlineWR * 100).toFixed(1)}%`}`,
      `Regime: ${snapshot.regime ?? "n/a"} | Mode: ${snapshot.mode ?? "n/a"}`,
      "liveBlocked=TRUE microPilotAllowed=FALSE",
    ].join("\n");
  }

  private delta(current: number | null, previous: number | null): number | null {
    return current === null || previous === null ? null : current - previous;
  }

  private stateFromSnapshot(
    snapshot: NotificationSnapshot,
    lastSentAt: string | null,
    lastError: string | null,
  ): NotificationState {
    return {
      lastRegime: snapshot.regime,
      lastMode: snapshot.mode,
      lastBias: snapshot.bias,
      lastConfidence: snapshot.confidence,
      lastPaperPnl: finiteOrNull(snapshot.paperPnl),
      lastDiagnosticPnl: finiteOrNull(snapshot.diagnosticPnl),
      lastTotalPaperPnl: finiteOrNull(snapshot.totalPaperPnl),
      lastStartingBalance: finiteOrNull(snapshot.startingBalance),
      lastHeadlineBalance: finiteOrNull(snapshot.headlineBalance),
      lastTotalBalance: finiteOrNull(snapshot.totalBalance),
      lastProjectedMonthEndBalance: calculateLinearMonthEndProjection(
        snapshot.totalBalance,
        snapshot.monthTotalPaperPnl,
        this.now(),
      ).projectedBalance,
      lastDailyPnl: finiteOrNull(snapshot.dailyPnl),
      lastHeadlineNet: finiteOrNull(snapshot.headlineNet),
      lastHeadlinePF: snapshot.headlinePF === Infinity ? Infinity : finiteOrNull(snapshot.headlinePF),
      lastHeadlineWR: finiteOrNull(snapshot.headlineWR),
      lastGuardrailStatus: snapshot.guardrailStatus,
      lastRecommendedAction: snapshot.recommendedAction,
      lastClosedUnderProfileCount: Math.max(0, snapshot.closedUnderProfileCount),
      lastForwardVerdict: snapshot.forwardVerdict,
      lastTotalOrders: Math.max(0, snapshot.totalOrders),
      lastOpenOrders: Math.max(0, snapshot.openOrders),
      lastClosedOrders: Math.max(0, snapshot.closedOrders),
      lastSentAt,
      lastHeartbeatAt: this.state.lastHeartbeatAt,
      lastError,
    };
  }

  private async sendTelegram(text: string): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const token = this.env.TELEGRAM_BOT_TOKEN!;
    const chatId = this.env.TELEGRAM_CHAT_ID!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Telegram API returned HTTP ${response.status}`);
      }
      this.state.lastSentAt = this.now().toISOString();
      this.state.lastError = null;
      this.persistState();
      return true;
    } catch (error) {
      const message = sanitizedError(error);
      this.state.lastError = message;
      this.persistState();
      this.warn(`[notifications] ${message}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private loadState(): NotificationState {
    try {
      if (!existsSync(this.stateFile)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf-8")) as Partial<NotificationState>;
      return { ...emptyState(), ...parsed };
    } catch {
      return emptyState();
    }
  }

  private persistState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.stateFile);
    } catch (error) {
      this.warn(`[notifications] state persistence failed: ${sanitizedError(error)}`);
    }
  }
}
