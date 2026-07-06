/**
 * /api/live/* — control surface for the live-execution engine (Binance USD-M mirror).
 *
 * The engine is OPTIONAL: when LIVE_EXECUTION_ENABLED!=1 it is never constructed and
 * these routes report { enabled:false } without touching anything. Keys are never
 * echoed by any endpoint.
 */
import type { FastifyInstance } from "fastify";

import type { LiveExecutionEngine } from "../lib/live-execution-engine.js";
import {
  CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
  type CrossSectionalExecutor,
} from "../lib/cross-sectional-executor.js";
import type { RegimeAutopilot } from "../lib/regime-autopilot.js";

type LiveAccountSnapshot = Awaited<ReturnType<LiveExecutionEngine["getAccountSnapshot"]>>;

function annotateCrossSectionalAccount(
  snapshot: LiveAccountSnapshot,
  executor: CrossSectionalExecutor | null,
): LiveAccountSnapshot {
  const openBasket = executor?.getStatus().openBasket ?? null;
  if (!openBasket) return snapshot;

  const laneRow = {
    laneId: CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
    sourceOrderCount: 0,
    symbols: new Set<string>(),
    notionalUsd: 0,
    unrealizedPnl: 0,
  };

  for (const leg of openBasket.legs) {
    if (leg.exitOrderId !== null) continue;
    const row = snapshot.positions.find((position) => position.symbol === leg.symbol && position.direction === leg.side);
    if (!row) continue;

    const positionQty = Number(row.quantity);
    const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, leg.qty / positionQty) : 1;
    row.sourceOrderCount += 1;
    if (!row.laneIds.includes(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID)) {
      row.laneIds.push(CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID);
    }
    laneRow.sourceOrderCount += 1;
    laneRow.symbols.add(row.symbol);
    laneRow.notionalUsd += Math.abs(leg.qty * leg.entryPrice);
    laneRow.unrealizedPnl += row.unrealizedPnl * share;
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId: CROSS_SECTIONAL_MARKET_NEUTRAL_LANE_ID,
        sourceOrderCount: laneRow.sourceOrderCount,
        symbols: Array.from(laneRow.symbols).sort(),
        notionalUsd: laneRow.notionalUsd,
        unrealizedPnl: laneRow.unrealizedPnl,
      });
      snapshot.lanes.sort((left, right) => left.laneId.localeCompare(right.laneId));
    }
  }

  return snapshot;
}

export async function registerLiveRoutes(
  app: FastifyInstance,
  engine: LiveExecutionEngine | null,
  opts: {
    configErrors?: string[];
    crossSectionalExecutor?: () => CrossSectionalExecutor | null;
    regimeAutopilot?: () => RegimeAutopilot | null;
  } = {},
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

  // RECEIVER (runs on the MAINNET instance): open an exact copy of a testnet
  // position. Requires {"confirm":"COPY"} and the engine to be ARMED. The stop/TP
  // geometry is preserved relative to entry; the protective stop is placed before
  // the intent is considered OPEN (same machinery as the normal mirror).
  app.post("/api/live/copy-intent", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as {
      confirm?: string;
      symbol?: string;
      direction?: "LONG" | "SHORT";
      qty?: number;
      entryPrice?: number;
      stopLossPrice?: number;
      tp1Price?: number;
      exitRule?: string | null;
      sourceLaneId?: string | null;
      sourcePaperOrderId?: string | null;
      sourceEnv?: string | null;
    };
    if (body.confirm !== "COPY") {
      reply.code(400);
      return { ok: false, reason: 'copy requires body {"confirm":"COPY", ...spec} — this opens a REAL position' };
    }
    if (
      typeof body.symbol !== "string" ||
      (body.direction !== "LONG" && body.direction !== "SHORT") ||
      typeof body.qty !== "number" ||
      typeof body.entryPrice !== "number" ||
      typeof body.stopLossPrice !== "number" ||
      typeof body.tp1Price !== "number"
    ) {
      reply.code(400);
      return { ok: false, reason: "spec requires symbol, direction, qty, entryPrice, stopLossPrice, tp1Price" };
    }
    const result = await engine.copyExternalIntent({
      symbol: body.symbol,
      direction: body.direction,
      qty: body.qty,
      entryPrice: body.entryPrice,
      stopLossPrice: body.stopLossPrice,
      tp1Price: body.tp1Price,
      exitRule: (body.exitRule ?? null) as never,
      sourceLaneId: body.sourceLaneId ?? null,
      sourcePaperOrderId: body.sourcePaperOrderId ?? null,
      sourceEnv: body.sourceEnv ?? null,
    });
    if (!result.ok) reply.code(409);
    return result;
  });

  // RELAY (runs on the TESTNET instance): the dashboard's per-position "copy to
  // live" button. Looks up the OPEN testnet intent and forwards its exact spec to
  // the mainnet instance (LIVE_COPY_TARGET_URL, default the local 3103 process).
  app.post("/api/live/copy-to-live", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { paperOrderId?: string };
    if (typeof body.paperOrderId !== "string" || body.paperOrderId.length === 0) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"paperOrderId":"<open intent id>"}' };
    }
    const lookup = engine.getOpenIntentCopySpec(body.paperOrderId);
    if (!lookup.ok || !lookup.spec) {
      reply.code(lookup.reason?.startsWith("no intent") ? 404 : 409);
      return { ok: false, reason: lookup.reason };
    }
    const target = process.env.LIVE_COPY_TARGET_URL ?? "http://127.0.0.1:3103";
    const spec = { confirm: "COPY", ...lookup.spec, sourceEnv: "testnet" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${target}/api/live/copy-intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const payload = (await response.json()) as { ok?: boolean; reason?: string };
      if (!response.ok || payload.ok === false) {
        reply.code(response.status === 200 ? 409 : response.status);
        return { ok: false, reason: payload.reason ?? `live copy failed (${response.status})`, spec };
      }
      return { ok: true, spec, live: payload };
    } catch (error) {
      reply.code(502);
      return { ok: false, reason: `live instance unreachable: ${(error as Error).message}`, spec };
    }
  });

  // Operator lane selection for the live mirror. Body:
  //   {"lanes": null}                          → all lanes allowed (default)
  //   {"lanes": []}                            → pause every new mirror
  //   {"lanes": ["CG_WIDE_FAST_SHORT", ...]}   → only these lanes may open new positions
  // Ids match a paper order's selectedLaneId as the full id or its variant suffix.
  // Affects NEW entries only — existing open positions keep managing/closing normally.
  app.post("/api/live/lanes", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { lanes?: unknown };
    if (body.lanes !== null && !Array.isArray(body.lanes)) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"lanes": null | string[]}' };
    }
    const result = engine.setAllowedLanes(
      body.lanes === null ? null : (body.lanes as unknown[]).map((v) => String(v)),
    );
    return { ok: true, ...result };
  });

  // Cross-sectional executor status (testnet-first basket execution of the measured lane).
  app.get("/api/live/cross-sectional-executor", async () => {
    const executor = opts.crossSectionalExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });

  // Regime auto-pilot status (Tier 1: auto-syncs allocation to detected regime, anti-whipsaw).
  app.get("/api/live/autopilot", async () => {
    const pilot = opts.regimeAutopilot?.() ?? null;
    if (!pilot) {
      return { enabled: false, reason: "auto-pilot disabled (set REGIME_AUTOPILOT_ENABLED=1 + REGIME_ENGINE_ENABLED=1)" };
    }
    return pilot.getStatus();
  });

  // WEIGHTED lane allocation (manual intervention: e.g. lane1 70% / lane2 30%).
  // Takes precedence over /api/live/lanes while set. Body:
  //   {"allocations": null}   → off (back to allow-list / all lanes)
  //   {"allocations": [{"laneId":"CG_WIDE_FAST_SHORT","weightPct":70},
  //                    {"laneId":"CG_WIDE_FAST_LONG","weightPct":30}]}
  // Only listed lanes may open NEW positions; each entry's size is scaled by weightPct.
  // Operator toggle: RAW selector mode (bypass the 2b book overlay + regime direction-gate; trade
  // exactly the lane allocation selector). OFF = the current "smart" behavior. Hard safety rails
  // (kill-switch, cluster cap, risk size) are never affected.
  app.post("/api/live/manual-mode", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      reply.code(400);
      return { ok: false, reason: 'body must be {"enabled": true | false}' };
    }
    return engine.setManualSelectorMode(body.enabled);
  });

  app.post("/api/live/lane-allocations", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { allocations?: unknown };
    if (body.allocations !== null && !Array.isArray(body.allocations)) {
      reply.code(400);
      return { ok: false, reason: 'body must be {"allocations": null | [{laneId, weightPct}]}' };
    }
    const result = engine.setLaneAllocations(
      body.allocations === null
        ? null
        : (body.allocations as Array<{ laneId?: unknown; weightPct?: unknown }>).map((a) => ({
            laneId: String(a.laneId ?? ""),
            weightPct: Number(a.weightPct),
          })),
    );
    if (!result.ok) reply.code(400);
    return result;
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

  app.post("/api/live/flatten-exchange", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { confirm?: string; reason?: string };
    if (body.confirm !== "FLATTEN_BINANCE_ALL") {
      reply.code(400);
      return {
        ok: false,
        reason:
          'exchange flatten requires body {"confirm":"FLATTEN_BINANCE_ALL"} — cancels ALL visible Binance USD-M orders and MARKET reduce-only closes ALL exchange positions',
      };
    }
    const result = await engine.flattenAllExchangePositions(body.reason ?? "operator exchange flatten");
    if (!result.ok) reply.code(502);
    return { ...result, armed: engine.isArmed(), status: engine.getStatus() };
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
      const snapshot = await engine.getAccountSnapshot();
      return { ok: true, ...annotateCrossSectionalAccount(snapshot, opts.crossSectionalExecutor?.() ?? null) };
    } catch (err) {
      reply.code(502);
      return { ok: false, reason: err instanceof Error ? err.message : "account snapshot failed" };
    }
  });

  app.get("/api/live/lane-performance-series", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const query = (request.query ?? {}) as { view?: string; period?: string; anchor?: string; regime?: string };
    try {
      return {
        ok: true,
        ...engine.getLanePerformanceSeries({
          view: query.view,
          period: query.period,
          anchor: query.anchor,
          regime: query.regime,
        }),
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, reason: err instanceof Error ? err.message : "lane performance series failed" };
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
