import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  calculateLinearMonthEndProjection,
  fmtNtd,
  NotificationService,
  type NotificationSnapshot,
} from "../src/lib/notification-service.js";
import { registerNotificationRoutes } from "../src/routes/notifications.js";

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "notification-service-test-"));
}

function enabledEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NOTIFICATIONS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "test-token-never-log",
    TELEGRAM_CHAT_ID: "123456",
    ...over,
  };
}

function snapshot(over: Partial<NotificationSnapshot> = {}): NotificationSnapshot {
  return {
    regime: "Bearish pressure",
    mode: "SHORT_ONLY",
    bias: "SHORT",
    confidence: "MEDIUM",
    paperPnl: 100,
    diagnosticPnl: 25,
    totalPaperPnl: 125,
    startingBalance: 2_000,
    headlineBalance: 2_100,
    totalBalance: 2_125,
    monthTotalPaperPnl: 125,
    todayClosed: 0,
    todayWins: 0,
    todayLosses: 0,
    todayHeadlinePnl: 0,
    todayDiagnosticPnl: 0,
    todayTotalPnl: 0,
    dailyPnl: 10,
    headlineNet: 0.2,
    headlinePF: 2,
    headlineWR: 0.6,
    guardrailStatus: "COLLECTING_OOS",
    recommendedAction: "KEEP_COLLECTING",
    guardrailReasons: ["OOS_TOO_SMALL"],
    activeMixedBudgetProfile: "SYMBOL_SAFE_RELAXED",
    closedUnderProfileCount: 0,
    forwardVerdict: "NEED_MORE_OOS",
    totalOrders: 0,
    openOrders: 0,
    closedOrders: 0,
    wins: 0,
    losses: 0,
    latestOrder: null,
    ...over,
  };
}

function successfulFetch(messages: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    messages.push(body.text ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("notification-service", () => {
  it("[1] missing env disables notifications safely", async () => {
    const service = new NotificationService({ dataDir: tmpDir(), env: {} });
    expect(service.getStatus().enabled).toBe(false);
    await expect(service.evaluate(snapshot())).resolves.toEqual({
      enabled: false,
      initialized: false,
      alertsAttempted: 0,
      alertsSent: 0,
      alerts: [],
    });
  });

  it("[2] POST /api/notifications/test sends with mocked Telegram fetch", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    const app = Fastify({ logger: false });
    await registerNotificationRoutes(app, service);
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/test",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sent).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Telegram Notifications Test");
    expect(response.body).not.toContain("test-token-never-log");
    await app.close();
  });

  it("[3] regime change triggers one alert", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    const result = await service.evaluate(snapshot({
      regime: "Mixed rotation",
      mode: "VALIDATION_ONLY",
      bias: "MIXED",
      confidence: "LOW",
    }));
    expect(result.alerts).toEqual(["REGIME_CHANGE"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Bearish pressure → Mixed rotation");
  });

  it("[4] unchanged regime and state do not spam", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    const result = await service.evaluate(snapshot());
    expect(result.alertsAttempted).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("[5] PnL movement below thresholds does not alert", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    const result = await service.evaluate(snapshot({
      paperPnl: 149,
      dailyPnl: 109,
      headlineNet: 0.249,
    }));
    expect(result.alerts).not.toContain("PNL_CHANGE");
  });

  it("[6] PnL movement above threshold alerts", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    const result = await service.evaluate(snapshot({ paperPnl: 150 }));
    expect(result.alerts).toContain("PNL_CHANGE");
    expect(messages[0]).toContain("Paper PnL Update");
  });

  it("[7] guardrail WARNING transition alerts", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot({
      guardrailStatus: "HEALTHY",
      recommendedAction: "KEEP_PROFILE",
      guardrailReasons: ["PROFILE_HEALTHY"],
    }));
    const result = await service.evaluate(snapshot({
      guardrailStatus: "WARNING",
      recommendedAction: "REVIEW_PROFILE",
      guardrailReasons: ["WAIT_CAPACITY_SPIKE"],
    }));
    expect(result.alerts).toContain("GUARDRAIL_CHANGE");
    expect(messages[0]).toContain("WAIT_CAPACITY_SPIKE");
  });

  it("[8] forward validation milestone alerts", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    const result = await service.evaluate(snapshot({ closedUnderProfileCount: 1 }));
    expect(result.alerts).toContain("FORWARD_VALIDATION_PROGRESS");
    expect(messages[0]).toContain("Milestone: 1");
  });

  it("[9] total paper order increase alerts with latest order summary", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    const result = await service.evaluate(snapshot({
      totalOrders: 1,
      openOrders: 1,
      latestOrder: {
        symbol: "BTCUSDT",
        direction: "SHORT",
        lane: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
        admission: "ALLOW_REDUCED",
        profile: "SYMBOL_SAFE_RELAXED",
        occupancyMode: "REDUCED_RISK",
        riskMultiplier: 0.25,
      },
    }));
    expect(result.alerts).toContain("NEW_PAPER_ORDER");
    expect(messages[0]).toContain("BTCUSDT");
    expect(messages[0]).toContain("reduced paper-only");
  });

  it("[10] Telegram failure warns without throwing or exposing token", async () => {
    const warnings: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: (async () => {
        throw new Error("network unavailable");
      }) as typeof fetch,
      warn: (message) => warnings.push(message),
    });
    await service.evaluate(snapshot());
    await expect(service.evaluate(snapshot({ regime: "Mixed rotation" }))).resolves.toMatchObject({
      alertsAttempted: 1,
      alertsSent: 0,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("network unavailable");
    expect(warnings[0]).not.toContain("test-token-never-log");
    expect(service.getStatus().lastError).toContain("network unavailable");
  });

  it("[11] state file updates after successful evaluation", async () => {
    const messages: string[] = [];
    const dir = tmpDir();
    const service = new NotificationService({
      dataDir: dir,
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
    });
    await service.evaluate(snapshot());
    await service.evaluate(snapshot({ regime: "Mixed rotation", mode: "VALIDATION_ONLY" }));
    expect(existsSync(join(dir, "notification-state.json"))).toBe(true);
    const state = JSON.parse(readFileSync(join(dir, "notification-state.json"), "utf-8"));
    expect(state.lastRegime).toBe("Mixed rotation");
    expect(state.lastMode).toBe("VALIDATION_ONLY");
    expect(state.lastSentAt).toBeTruthy();
    expect(JSON.stringify(state)).not.toContain("test-token-never-log");
  });

  it("[12] status endpoint exposes monitoring state only and preserves safety posture", async () => {
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch([]),
    });
    await service.evaluate(snapshot());
    const app = Fastify({ logger: false });
    await registerNotificationRoutes(app, service);
    const response = await app.inject({ method: "GET", url: "/api/notifications/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().enabled).toBe(true);
    expect(response.body).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(response.body).not.toContain("test-token-never-log");
    expect(snapshot().latestOrder).toBeNull();
    await app.close();
  });

  it("[13] five-minute status heartbeat reports requested paper metrics", async () => {
    const messages: string[] = [];
    const service = new NotificationService({
      dataDir: tmpDir(),
      env: enabledEnv(),
      fetchImpl: successfulFetch(messages),
      heartbeatIntervalMs: 0,
      now: () => new Date("2026-06-06T12:00:00.000Z"),
    });
    service.setSnapshotProvider(() =>
      snapshot({
        openOrders: 7,
        closedOrders: 153,
        wins: 123,
        losses: 30,
        dailyPnl: 57.7,
        paperPnl: 1332.5,
        diagnosticPnl: 364,
        totalPaperPnl: 1696.5,
        startingBalance: 2000,
        headlineBalance: 3332.5,
        totalBalance: 3696.5,
        monthTotalPaperPnl: 1696.5,
        todayClosed: 2,
        todayWins: 2,
        todayLosses: 0,
        todayHeadlinePnl: 0,
        todayDiagnosticPnl: 39.41,
        todayTotalPnl: 39.41,
      }),
    );
    await expect(service.sendStatusHeartbeat()).resolves.toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Paper Bot Status (5m)");
    expect(messages[0]).toContain("TODAY (Asia/Taipei)");
    expect(messages[0]).toContain("Closed: 2");
    expect(messages[0]).toContain("Wins / Losses: 2 / 0");
    expect(messages[0]).toContain("Headline PnL: NT$ 0");
    expect(messages[0]).toContain("Diagnostic PnL: NT$ 40");
    expect(messages[0]).toContain("Total PnL: NT$ 40");
    expect(messages[0]).toContain("CUMULATIVE");
    expect(messages[0]).toContain("Open positions now: 7");
    expect(messages[0]).toContain("Wins / Losses: 123 / 30");
    expect(messages[0]).toContain("Headline PnL: NT$ 1.333");
    expect(messages[0]).toContain("Diagnostic PnL: NT$ 364");
    expect(messages[0]).toContain("Total Paper PnL: NT$ 1.697");
    expect(messages[0]).toContain("Starting balance: NT$ 2.000");
    expect(messages[0]).toContain("Current headline balance: NT$ 3.333");
    expect(messages[0]).toContain("Current total balance: NT$ 3.697");
    expect(messages[0]).toContain("Month-end projection:");
    expect(messages[0]).toContain("linear MTD paper estimate, volatile");
    expect(messages[0]).toContain("liveBlocked=TRUE microPilotAllowed=FALSE");
    expect(service.getStatus().lastState.lastHeartbeatAt).toBeTruthy();
  });

  it("[14] month-end projection uses linear month-to-date paper pace", () => {
    const projection = calculateLinearMonthEndProjection(
      3696.5,
      1696.5,
      new Date("2026-06-06T12:00:00.000Z"),
    );
    expect(projection.dailyPace).toBeCloseTo(308.4545, 4);
    expect(projection.projectedBalance).toBeCloseTo(11253.6364, 4);
  });

  it("[15] NTD formatter rounds upward to whole units with Indonesian separators", () => {
    expect(fmtNtd(0)).toBe("NT$ 0");
    expect(fmtNtd(-0)).toBe("NT$ 0");
    expect(fmtNtd(12_000)).toBe("NT$ 12.000");
    expect(fmtNtd(1_234.001)).toBe("NT$ 1.235");
    expect(fmtNtd(-12.349)).toBe("NT$ -12");
  });
});
