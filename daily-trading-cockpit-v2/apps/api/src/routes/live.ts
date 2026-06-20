/**
 * /api/live/* — control surface for the live-execution engine (Binance USD-M mirror).
 *
 * The engine is OPTIONAL: when LIVE_EXECUTION_ENABLED!=1 it is never constructed and
 * these routes report { enabled:false } without touching anything. Keys are never
 * echoed by any endpoint.
 */
import type { FastifyInstance } from "fastify";

import type { LiveExecutionEngine } from "../lib/live-execution-engine.js";

export async function registerLiveRoutes(
  app: FastifyInstance,
  engine: LiveExecutionEngine | null,
  opts: { configErrors?: string[] } = {},
): Promise<void> {
  app.get("/api/live/status", async () => {
    if (!engine) {
      return {
        enabled: false,
        configErrors: opts.configErrors ?? [],
        reason:
          opts.configErrors && opts.configErrors.length > 0
            ? `live execution enabled but misconfigured: ${opts.configErrors.join("; ")}`
            : "live execution disabled (set LIVE_EXECUTION_ENABLED=1 + LIVE_BINANCE_* env to enable)",
      };
    }
    return engine.getStatus();
  });

  app.post("/api/live/arm", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "ARM") {
      reply.code(400);
      return { ok: false, reason: 'arming requires body {"confirm":"ARM"}' };
    }
    const result = await engine.arm();
    if (!result.ok) reply.code(409);
    return { ...result, armed: engine.isArmed() };
  });

  app.post("/api/live/disarm", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    engine.disarm("manual disarm via /api/live/disarm");
    return { ok: true, armed: engine.isArmed() };
  });

  app.post("/api/live/kill", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "KILL") {
      reply.code(400);
      return { ok: false, reason: 'kill requires body {"confirm":"KILL"} — cancels ALL orders and FLATTENS all engine positions' };
    }
    await engine.kill(body.reason ?? "operator kill");
    return { ok: true, armed: engine.isArmed(), status: engine.getStatus() };
  });

  app.get("/api/live/balance", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      const balance = await engine.getUsdtBalance();
      if (!balance) return { ok: true, walletBalance: null, availableBalance: null };
      return { ok: true, ...balance };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "balance fetch failed" };
    }
  });

  app.get("/api/live/account", async (_request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    try {
      return { ok: true, ...(await engine.getAccountSnapshot()) };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "account snapshot failed" };
    }
  });

  app.post("/api/live/sync-testnet", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    const status = engine.getStatus();
    if (status.env !== "testnet") {
      reply.code(409);
      return { ok: false, reason: "manual mirror sync is testnet-only" };
    }
    if (body.confirm !== "SYNC_TESTNET") {
      reply.code(400);
      return { ok: false, reason: 'sync requires body {"confirm":"SYNC_TESTNET"}' };
    }
    await engine.tick();
    return { ok: true, status: engine.getStatus(), account: await engine.getAccountSnapshot() };
  });

  app.post("/api/live/reset-kill", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== "RESET") {
      reply.code(400);
      return { ok: false, reason: 'resetting a latched kill requires body {"confirm":"RESET"}' };
    }
    engine.resetKill();
    return { ok: true, armed: engine.isArmed() };
  });
}
