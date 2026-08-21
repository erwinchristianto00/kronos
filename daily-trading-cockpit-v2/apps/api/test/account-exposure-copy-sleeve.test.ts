import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  AccountExposureCoordinator,
  AccountExposureReservationStore,
} from "../src/lib/account-exposure-coordinator.js";
import type { FuturesPosition } from "../src/lib/binance-futures-private.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function coordinator(additional: Array<{ symbol: string; direction: "LONG" | "SHORT"; qty: number; entryPrice: number }>) {
  const dir = mkdtempSync(join(os.tmpdir(), "copy-exposure-test-"));
  dirs.push(dir);
  return new AccountExposureCoordinator({
    store: new AccountExposureReservationStore(dir),
    getSingleSymbolExecutors: () => [],
    getCrossSectionalExecutors: () => [],
    getAdditionalManagedPositions: () => additional,
    nowIso: () => "2026-08-21T00:00:00.000Z",
    maxGrossExposureUsd: () => 200,
    maxLongExposureUsd: () => 0,
    maxShortExposureUsd: () => 0,
    maxNotionalPerSymbolUsd: () => 0,
    maxClusterPositions: () => 0,
    maxConcurrentPositionsAcrossAccount: () => 0,
  });
}

function exchangePosition(symbol: string, positionAmt: number): FuturesPosition {
  return {
    symbol,
    positionAmt,
    entryPrice: 100,
    markPrice: 100,
    liquidationPrice: 0,
    unRealizedProfit: 0,
    leverage: 1,
    marginType: "ISOLATED",
  };
}

describe("AccountExposureCoordinator Copy Leader ownership", () => {
  it("counts a copy-owned exchange position once, not again as manual S4 exposure", () => {
    const coord = coordinator([{ symbol: "ETHUSDT", direction: "SHORT", qty: 1, entryPrice: 100 }]);
    coord.updatePositionSnapshot([exchangePosition("ETHUSDT", -1)]);

    // $100 owned sleeve exposure + this $75 reservation is admissible under a
    // $200 cap. It would fail if the matching exchange position were also
    // double-counted as manual/external S4 ($275 total).
    const reserved = coord.reserve({
      executorId: "COPY_TEST",
      symbol: "BTCUSDT",
      direction: "LONG",
      requestedNotionalUsd: 75,
      clientOrderId: "copy-owner-once",
    });
    expect(reserved.ok).toBe(true);
  });

  it("keeps original committed fill audit while recording partial then full close", () => {
    const coord = coordinator([]);
    const reserved = coord.reserve({
      executorId: "COPY_TEST",
      symbol: "ETHUSDT",
      direction: "SHORT",
      requestedNotionalUsd: 100,
      clientOrderId: "copy-release-audit",
    });
    expect(reserved.reservationId).not.toBeNull();
    coord.commitReservation(reserved.reservationId!, { qty: 1, avgPrice: 100 });
    coord.releaseCommittedReservation(reserved.reservationId!, 0.4, "COPY_LEADER_CLOSE:partial");
    const row = coord.getStatus().recentReservations.find((entry) => entry.reservationId === reserved.reservationId)!;
    expect(row).toMatchObject({ status: "COMMITTED", committedQty: 1, releasedQty: 0.4 });

    coord.releaseCommittedReservation(reserved.reservationId!, 0.6, "COPY_LEADER_CLOSE:final");
    expect(coord.getStatus().recentReservations.find((entry) => entry.reservationId === reserved.reservationId)).toMatchObject({
      status: "RELEASED",
      committedQty: 1,
      releasedQty: 1,
      releaseReason: "COPY_LEADER_CLOSE:final",
    });
  });
});
