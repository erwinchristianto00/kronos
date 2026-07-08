/**
 * /api/live/* — control surface for the live-execution engine (Binance USD-M mirror).
 *
 * The engine is OPTIONAL: when LIVE_EXECUTION_ENABLED!=1 it is never constructed and
 * these routes report { enabled:false } without touching anything. Keys are never
 * echoed by any endpoint.
 */
import type { FastifyInstance } from "fastify";

import type { LiveExecutionEngine } from "../lib/live-execution-engine.js";
import { type CrossSectionalExecutor } from "../lib/cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor } from "../lib/single-symbol-lane-executor.js";
import type { RegimeAutopilot } from "../lib/regime-autopilot.js";

type LiveAccountSnapshot = Awaited<ReturnType<LiveExecutionEngine["getAccountSnapshot"]>>;

export function annotateCrossSectionalAccount(
  snapshot: LiveAccountSnapshot,
  executor: CrossSectionalExecutor | null,
): LiveAccountSnapshot {
  if (!executor) return snapshot;
  // 2026-07-08: generalized from the single hardcoded market-neutral lane id so the SAME function
  // annotates any of the (now multiple) executor instances — each instance reports its own laneId
  // via getStatus(), so calling this once per instance (app.ts's registerLiveRoutes wiring) merges
  // all of them into the one account snapshot without duplicating this logic per variant.
  const laneId = executor.getStatus().laneId;

  // Closed baskets: the engine's realized ledger deliberately excludes executor positions (they
  // are external-managed claims, not engine intents), so banked basket P&L must be merged into
  // closedLanes here — otherwise every realized display stays flat while the actual wallet
  // balance moves (2026-07-07 operator: "+1.45 banked, kok realized ga nambah??").
  const closedSummary = executor.getClosedSummary();
  if (closedSummary.closedCount > 0) {
    const existingClosed = snapshot.closedLanes.find((lane) => lane.laneId === laneId);
    if (existingClosed) {
      existingClosed.closedCount += closedSummary.closedCount;
      existingClosed.wins += closedSummary.wins;
      existingClosed.losses += closedSummary.losses;
      existingClosed.realizedPnlUsd += closedSummary.realizedPnlUsd;
      existingClosed.feesUsd += closedSummary.feesUsd;
      existingClosed.symbols = Array.from(new Set([...existingClosed.symbols, ...closedSummary.symbols])).sort();
      if (closedSummary.lastClosedAt && (!existingClosed.lastClosedAt || closedSummary.lastClosedAt > existingClosed.lastClosedAt)) {
        existingClosed.lastClosedAt = closedSummary.lastClosedAt;
      }
    } else {
      snapshot.closedLanes.push({
        laneId,
        closedCount: closedSummary.closedCount,
        wins: closedSummary.wins,
        losses: closedSummary.losses,
        realizedPnlUsd: closedSummary.realizedPnlUsd,
        feesUsd: closedSummary.feesUsd,
        symbols: closedSummary.symbols,
        lastClosedAt: closedSummary.lastClosedAt,
      });
    }
  }

  // ALL open baskets, not just the first — MAX_OPEN_BASKETS can exceed 1 (testnet runs 4), and
  // Binance nets same-symbol legs from different baskets into one account-level position. Only
  // attributing the first basket left every OTHER basket's real exchange positions silently
  // unattributed on the dashboard (2026-07-07: confirmed on testnet — 4 concurrent baskets, only
  // one basket's symbols got tagged, the rest showed "unattributed").
  const openBaskets = executor.getStatus().openBaskets;
  if (openBaskets.length === 0) return snapshot;

  const laneRow = {
    laneId,
    sourceOrderCount: 0,
    symbols: new Set<string>(),
    notionalUsd: 0,
    unrealizedPnl: 0,
  };

  for (const openBasket of openBaskets) {
    for (const leg of openBasket.legs) {
      if (leg.exitOrderId !== null) continue;
      // Match by SYMBOL (not symbol+direction): with a directional intent on the same symbol the
      // NETTED row's direction can differ from the leg's side, and the basket share must still be
      // attributed (2026-07-08 operator: "pisahkan unrealized antara cross sectional dan directional").
      const row = snapshot.positions.find((position) => position.symbol === leg.symbol);
      if (!row) continue;

      const positionQty = Number(row.quantity);
      const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, leg.qty / positionQty) : 1;
      row.sourceOrderCount += 1;
      if (!row.laneIds.includes(laneId)) {
        row.laneIds.push(laneId);
      }
      // The basket's OWN P&L for this leg, from ITS entry price — never the exchange's blended
      // average entry of the netted position.
      const legDir = leg.side === "LONG" ? 1 : -1;
      const legUnrealized = row.markPrice !== null && leg.entryPrice > 0 ? (row.markPrice - leg.entryPrice) * leg.qty * legDir : null;
      row.basketQty = (row.basketQty ?? 0) + leg.qty * legDir;
      if (legUnrealized !== null) row.basketUnrealizedPnl = (row.basketUnrealizedPnl ?? 0) + legUnrealized;
      laneRow.sourceOrderCount += 1;
      laneRow.symbols.add(row.symbol);
      laneRow.notionalUsd += Math.abs(leg.qty * leg.entryPrice);
      laneRow.unrealizedPnl += legUnrealized ?? row.unrealizedPnl * share;
    }
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === laneId);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId,
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

type LiveLaneSeriesReport = ReturnType<LiveExecutionEngine["getLanePerformanceSeries"]>;

/** Merge the cross-sectional executor's CLOSED baskets into the lane-performance timeline as
 *  their own lane. Same rationale as annotateCrossSectionalAccount: basket P&L never passes
 *  through engine intents, so without this the timeline shows a flat foundation lane while the
 *  wallet moves. Baskets carry no regime tag (market-neutral by design), so they are merged only
 *  into the unfiltered ("all") view — a regime-filtered view must not include unclassifiable P&L. */
export function mergeCrossSectionalIntoLaneSeries(
  report: LiveLaneSeriesReport,
  executor: CrossSectionalExecutor | null,
): LiveLaneSeriesReport {
  if (!executor || report.regimeFilter !== "all") return report;
  // 2026-07-08: generalized to executor.getStatus().laneId (see annotateCrossSectionalAccount
  // above) so this same function merges any of the (now multiple) executor instances' closed
  // baskets, called once per instance.
  const laneId = executor.getStatus().laneId;
  const sinceMs = new Date(report.since).getTime();
  const untilMs = new Date(report.until).getTime();
  const bucketStartsMs = report.bucketStarts.map((s) => new Date(s).getTime());

  const perBucket = new Map<string, { realizedPnlUsd: number; closedCount: number; wins: number; losses: number }>();
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  const symbols = new Set<string>();
  for (const basket of executor.getClosedBaskets()) {
    if (!basket.closedAt || basket.netPnlUsd === null) continue;
    const closedMs = new Date(basket.closedAt).getTime();
    if (!Number.isFinite(closedMs) || closedMs < sinceMs || closedMs >= untilMs) continue;
    // Greatest bucket start <= closedAt (bucket lengths vary across views, e.g. monthly).
    let bucketIdx = -1;
    for (let i = 0; i < bucketStartsMs.length; i += 1) {
      if (bucketStartsMs[i]! <= closedMs) bucketIdx = i;
      else break;
    }
    if (bucketIdx < 0) continue;
    const key = report.bucketStarts[bucketIdx]!;
    const bucket = perBucket.get(key) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
    bucket.realizedPnlUsd += basket.netPnlUsd;
    bucket.closedCount += 1;
    if (basket.netPnlUsd > 0) bucket.wins += 1;
    if (basket.netPnlUsd < 0) bucket.losses += 1;
    perBucket.set(key, bucket);
    realizedPnlUsd += basket.netPnlUsd;
    feesUsd += basket.feeEstimateUsd ?? 0;
    closedCount += 1;
    if (basket.netPnlUsd > 0) wins += 1;
    if (basket.netPnlUsd < 0) losses += 1;
    for (const leg of basket.legs) symbols.add(leg.symbol);
  }
  if (closedCount === 0) return report;

  const existing = report.lanes.find((lane) => lane.laneId === laneId);
  if (existing) {
    // An engine intent tagged with the same lane id would be rare, but merge pointwise instead of
    // pushing a duplicate laneId the chart would render twice.
    existing.realizedPnlUsd += realizedPnlUsd;
    existing.feesUsd += feesUsd;
    existing.closedCount += closedCount;
    existing.wins += wins;
    existing.losses += losses;
    existing.winRatePct = existing.closedCount > 0 ? (existing.wins / existing.closedCount) * 100 : null;
    existing.symbols = Array.from(new Set([...existing.symbols, ...symbols])).sort();
    let cumulative = 0;
    for (const point of existing.points) {
      const add = perBucket.get(point.bucketStart);
      if (add) {
        point.realizedPnlUsd += add.realizedPnlUsd;
        point.closedCount += add.closedCount;
        point.wins += add.wins;
        point.losses += add.losses;
      }
      cumulative += point.realizedPnlUsd;
      point.cumulativePnlUsd = cumulative;
    }
  } else {
    let cumulative = 0;
    const points = report.bucketStarts.map((bucketStart) => {
      const bucket = perBucket.get(bucketStart) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
      cumulative += bucket.realizedPnlUsd;
      return { bucketStart, ...bucket, cumulativePnlUsd: cumulative };
    });
    report.lanes.push({
      laneId,
      realizedPnlUsd,
      feesUsd,
      closedCount,
      wins,
      losses,
      winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : null,
      symbols: Array.from(symbols).sort(),
      regimes: [],
      points,
    });
  }
  report.lanes.sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
  return report;
}

/** Single-symbol-executor analog of annotateCrossSectionalAccount above — same rationale (a
 *  position opened by SHORT_FADE_EXHAUSTION/INTRADAY_MOMENTUM_BREAKOUT is NOT an engine intent, so
 *  without this its real fill would show up as an "unattributed" exchange position and its banked
 *  P&L would never move the account snapshot's realized figures). Simpler than the basket version:
 *  one leg per position, no multi-basket accumulation needed. */
export function annotateSingleSymbolAccount(
  snapshot: LiveAccountSnapshot,
  executor: SingleSymbolLaneExecutor | null,
): LiveAccountSnapshot {
  if (!executor) return snapshot;
  const status = executor.getStatus();
  const laneId = status.laneId;

  const closedSummary = executor.getClosedSummary();
  if (closedSummary.closedCount > 0) {
    const existingClosed = snapshot.closedLanes.find((lane) => lane.laneId === laneId);
    if (existingClosed) {
      existingClosed.closedCount += closedSummary.closedCount;
      existingClosed.wins += closedSummary.wins;
      existingClosed.losses += closedSummary.losses;
      existingClosed.realizedPnlUsd += closedSummary.realizedPnlUsd;
      existingClosed.feesUsd += closedSummary.feesUsd;
      existingClosed.symbols = Array.from(new Set([...existingClosed.symbols, ...closedSummary.symbols])).sort();
      if (closedSummary.lastClosedAt && (!existingClosed.lastClosedAt || closedSummary.lastClosedAt > existingClosed.lastClosedAt)) {
        existingClosed.lastClosedAt = closedSummary.lastClosedAt;
      }
    } else {
      snapshot.closedLanes.push({
        laneId,
        closedCount: closedSummary.closedCount,
        wins: closedSummary.wins,
        losses: closedSummary.losses,
        realizedPnlUsd: closedSummary.realizedPnlUsd,
        feesUsd: closedSummary.feesUsd,
        symbols: closedSummary.symbols,
        lastClosedAt: closedSummary.lastClosedAt,
      });
    }
  }

  const openPositions = status.openPositions;
  if (openPositions.length === 0) return snapshot;

  const laneRow = { laneId, sourceOrderCount: 0, symbols: new Set<string>(), notionalUsd: 0, unrealizedPnl: 0 };
  for (const pos of openPositions) {
    const row = snapshot.positions.find((position) => position.symbol === pos.symbol);
    if (!row) continue;
    const positionQty = Number(row.quantity);
    const share = Number.isFinite(positionQty) && positionQty > 0 ? Math.min(1, pos.qty / positionQty) : 1;
    row.sourceOrderCount += 1;
    if (!row.laneIds.includes(laneId)) row.laneIds.push(laneId);
    const dir = pos.direction === "LONG" ? 1 : -1;
    const legUnrealized = row.markPrice !== null && pos.entryPrice > 0 ? (row.markPrice - pos.entryPrice) * pos.qty * dir : null;
    row.basketQty = (row.basketQty ?? 0) + pos.qty * dir;
    if (legUnrealized !== null) row.basketUnrealizedPnl = (row.basketUnrealizedPnl ?? 0) + legUnrealized;
    laneRow.sourceOrderCount += 1;
    laneRow.symbols.add(row.symbol);
    laneRow.notionalUsd += Math.abs(pos.qty * pos.entryPrice);
    laneRow.unrealizedPnl += legUnrealized ?? row.unrealizedPnl * share;
  }

  if (laneRow.sourceOrderCount > 0) {
    const existing = snapshot.lanes.find((lane) => lane.laneId === laneId);
    if (existing) {
      existing.sourceOrderCount += laneRow.sourceOrderCount;
      existing.symbols = Array.from(new Set([...existing.symbols, ...laneRow.symbols])).sort();
      existing.notionalUsd += laneRow.notionalUsd;
      existing.unrealizedPnl += laneRow.unrealizedPnl;
    } else {
      snapshot.lanes.push({
        laneId,
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

/** Single-symbol-executor analog of mergeCrossSectionalIntoLaneSeries above. */
export function mergeSingleSymbolIntoLaneSeries(
  report: LiveLaneSeriesReport,
  executor: SingleSymbolLaneExecutor | null,
): LiveLaneSeriesReport {
  if (!executor || report.regimeFilter !== "all") return report;
  const laneId = executor.getStatus().laneId;
  const sinceMs = new Date(report.since).getTime();
  const untilMs = new Date(report.until).getTime();
  const bucketStartsMs = report.bucketStarts.map((s) => new Date(s).getTime());

  const perBucket = new Map<string, { realizedPnlUsd: number; closedCount: number; wins: number; losses: number }>();
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  const symbols = new Set<string>();
  for (const pos of executor.getClosedPositions()) {
    if (!pos.closedAt || pos.netPnlUsd === null) continue;
    const closedMs = new Date(pos.closedAt).getTime();
    if (!Number.isFinite(closedMs) || closedMs < sinceMs || closedMs >= untilMs) continue;
    let bucketIdx = -1;
    for (let i = 0; i < bucketStartsMs.length; i += 1) {
      if (bucketStartsMs[i]! <= closedMs) bucketIdx = i;
      else break;
    }
    if (bucketIdx < 0) continue;
    const key = report.bucketStarts[bucketIdx]!;
    const bucket = perBucket.get(key) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
    bucket.realizedPnlUsd += pos.netPnlUsd;
    bucket.closedCount += 1;
    if (pos.netPnlUsd > 0) bucket.wins += 1;
    if (pos.netPnlUsd < 0) bucket.losses += 1;
    perBucket.set(key, bucket);
    realizedPnlUsd += pos.netPnlUsd;
    feesUsd += pos.feeEstimateUsd ?? 0;
    closedCount += 1;
    if (pos.netPnlUsd > 0) wins += 1;
    if (pos.netPnlUsd < 0) losses += 1;
    symbols.add(pos.symbol);
  }
  if (closedCount === 0) return report;

  const existing = report.lanes.find((lane) => lane.laneId === laneId);
  if (existing) {
    existing.realizedPnlUsd += realizedPnlUsd;
    existing.feesUsd += feesUsd;
    existing.closedCount += closedCount;
    existing.wins += wins;
    existing.losses += losses;
    existing.winRatePct = existing.closedCount > 0 ? (existing.wins / existing.closedCount) * 100 : null;
    existing.symbols = Array.from(new Set([...existing.symbols, ...symbols])).sort();
    let cumulative = 0;
    for (const point of existing.points) {
      const add = perBucket.get(point.bucketStart);
      if (add) {
        point.realizedPnlUsd += add.realizedPnlUsd;
        point.closedCount += add.closedCount;
        point.wins += add.wins;
        point.losses += add.losses;
      }
      cumulative += point.realizedPnlUsd;
      point.cumulativePnlUsd = cumulative;
    }
  } else {
    let cumulative = 0;
    const points = report.bucketStarts.map((bucketStart) => {
      const bucket = perBucket.get(bucketStart) ?? { realizedPnlUsd: 0, closedCount: 0, wins: 0, losses: 0 };
      cumulative += bucket.realizedPnlUsd;
      return { bucketStart, ...bucket, cumulativePnlUsd: cumulative };
    });
    report.lanes.push({
      laneId,
      realizedPnlUsd,
      feesUsd,
      closedCount,
      wins,
      losses,
      winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : null,
      symbols: Array.from(symbols).sort(),
      regimes: [],
      points,
    });
  }
  report.lanes.sort((left, right) => Math.abs(right.realizedPnlUsd) - Math.abs(left.realizedPnlUsd));
  return report;
}

export async function registerLiveRoutes(
  app: FastifyInstance,
  engine: LiveExecutionEngine | null,
  opts: {
    configErrors?: string[];
    crossSectionalExecutor?: () => CrossSectionalExecutor | null;
    // 2026-07-08: two more instances (TREND_BETA_VOL / MIXED_MEAN_REVERSION), wired alongside the
    // original FILTERED foundation instance above. Optional/independent — either can be absent
    // (e.g. disabled, or an older deploy) without affecting the other's routes.
    crossSectionalTrendExecutor?: () => CrossSectionalExecutor | null;
    crossSectionalMixedExecutor?: () => CrossSectionalExecutor | null;
    // 2026-07-08: SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT single-symbol executors.
    // Same optional/independent contract as the cross-sectional getters above.
    shortFadeExecutor?: () => SingleSymbolLaneExecutor | null;
    intradayMomentumExecutor?: () => SingleSymbolLaneExecutor | null;
    regimeAutopilot?: () => RegimeAutopilot | null;
  } = {},
): Promise<void> {
  const allCrossSectionalExecutors = () =>
    [opts.crossSectionalExecutor?.() ?? null, opts.crossSectionalTrendExecutor?.() ?? null, opts.crossSectionalMixedExecutor?.() ?? null].filter(
      (exec): exec is CrossSectionalExecutor => exec !== null,
    );
  const allSingleSymbolExecutors = () =>
    [opts.shortFadeExecutor?.() ?? null, opts.intradayMomentumExecutor?.() ?? null].filter(
      (exec): exec is SingleSymbolLaneExecutor => exec !== null,
    );
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

  // Operator close of ONE open directional intent — the dashboard's per-position "Close" button
  // (2026-07-07: full manual control, bank early when the regime turns). Flattens only the
  // engine's own share of the netted position; basket legs on the same symbol stay open.
  app.post("/api/live/close-intent", async (request, reply) => {
    if (!engine) {
      reply.code(503);
      return { ok: false, reason: "live execution disabled" };
    }
    const body = (request.body ?? {}) as { paperOrderId?: string; confirm?: string };
    if (body.confirm !== "CLOSE") {
      reply.code(400);
      return { ok: false, reason: 'closing requires body {"confirm":"CLOSE","paperOrderId":"…"} — this places a REAL market order' };
    }
    if (typeof body.paperOrderId !== "string" || body.paperOrderId.length === 0) {
      reply.code(400);
      return { ok: false, reason: "paperOrderId required" };
    }
    const result = await engine.manualCloseIntent(body.paperOrderId);
    if (!result.ok) reply.code(409);
    return result;
  });

  // Cross-sectional executor status (testnet-first basket execution of the measured lane).
  app.get("/api/live/cross-sectional-executor", async () => {
    const executor = opts.crossSectionalExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });

  // 2026-07-08: sibling status endpoints for the two additional variant-targeted instances (same
  // shape as the FILTERED endpoint above, just a different underlying executor).
  app.get("/api/live/cross-sectional-executor-trend", async () => {
    const executor = opts.crossSectionalTrendExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "TREND_BETA_VOL executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/cross-sectional-executor-mixed", async () => {
    const executor = opts.crossSectionalMixedExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "MIXED_MEAN_REVERSION executor disabled (set CROSS_SECTIONAL_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });

  // 2026-07-08: single-symbol executor status (SHORT_FADE_EXHAUSTION / INTRADAY_MOMENTUM_BREAKOUT).
  app.get("/api/live/short-fade-executor", async () => {
    const executor = opts.shortFadeExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "SHORT_FADE_EXHAUSTION executor disabled (set SHORT_FADE_EXEC_ENABLED=1 + live execution env)" };
    }
    return executor.getStatus();
  });
  app.get("/api/live/intraday-momentum-executor", async () => {
    const executor = opts.intradayMomentumExecutor?.() ?? null;
    if (!executor) {
      return { enabled: false, reason: "INTRADAY_MOMENTUM_BREAKOUT executor disabled (set INTRADAY_MOMENTUM_EXEC_ENABLED=1 + live execution env)" };
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
      let snapshot = await engine.getAccountSnapshot();
      for (const executor of allCrossSectionalExecutors()) {
        snapshot = annotateCrossSectionalAccount(snapshot, executor);
      }
      for (const executor of allSingleSymbolExecutors()) {
        snapshot = annotateSingleSymbolAccount(snapshot, executor);
      }
      return { ok: true, ...snapshot };
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
      let series = engine.getLanePerformanceSeries({
        view: query.view,
        period: query.period,
        anchor: query.anchor,
        regime: query.regime,
      });
      for (const executor of allCrossSectionalExecutors()) {
        series = mergeCrossSectionalIntoLaneSeries(series, executor);
      }
      for (const executor of allSingleSymbolExecutors()) {
        series = mergeSingleSymbolIntoLaneSeries(series, executor);
      }
      return { ok: true, ...series };
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
