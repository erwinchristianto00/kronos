import type { FastifyInstance } from "fastify";

import { computePerformance } from "../lib/outcome-checker.js";
import type { PerformanceStatsProvider } from "../lib/performance-cache.js";
import type { SignalTracker } from "../lib/tracker.js";

export async function registerOutcomesRoutes(
  app: FastifyInstance,
  tracker: SignalTracker | null,
  performanceProvider: PerformanceStatsProvider | null = null,
): Promise<void> {
  app.get("/api/outcomes", async (_request, reply) => {
    if (!tracker) {
      reply.code(503);
      return { error: "TRACKING_DISABLED", message: "Signal tracking is not enabled in this environment." };
    }
    const signals = tracker.readAll();
    return {
      total: signals.length,
      signals: signals.slice(-200).reverse(),
    };
  });

  app.get("/api/performance", async (_request, reply) => {
    if (!tracker) {
      reply.code(503);
      return { error: "TRACKING_DISABLED", message: "Signal tracking is not enabled in this environment." };
    }
    const performance = performanceProvider
      ? performanceProvider.getPerformance().performance
      : computePerformance(tracker.readAllRaw(), tracker.getLastOutcomeCheckerRunAt());
    return {
      ...performance,
      migrationAudit: tracker.getMigrationAudit(),
    };
  });

  app.post("/api/performance/rebuild", async (_request, reply) => {
    if (!tracker) {
      reply.code(503);
      return { error: "TRACKING_DISABLED", message: "Signal tracking is not enabled in this environment." };
    }
    const rebuilt = tracker.rebuildFromRaw();
    performanceProvider?.warm();
    return {
      ...computePerformance(tracker.readAllRaw(), tracker.getLastOutcomeCheckerRunAt()),
      migrationAudit: rebuilt.audit,
    };
  });
}
