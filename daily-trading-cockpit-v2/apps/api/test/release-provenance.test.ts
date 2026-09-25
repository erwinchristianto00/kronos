import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  captureOpenedExecutionReleaseLifecycle,
  normalizeExecutionReleaseLifecycle,
  readRuntimeReleaseManifest,
  stampClosedExecutionReleaseLifecycle,
} from "../src/lib/release-provenance.js";
import { closedBasketRealizedBreakdown } from "../src/lib/cross-sectional-executor.js";

const openedAt = "2026-09-03T03:23:00.000Z";
const closedAt = "2026-09-03T04:00:00.000Z";

function withManifest(
  environment: "testnet" | "mainnet",
  releaseId: string,
  activatedAt = "2026-09-03T03:20:00.000Z",
) {
  const directory = mkdtempSync(join(tmpdir(), "kronos-release-provenance-"));
  const file = join(directory, "release-provenance.json");
  writeFileSync(file, JSON.stringify({
    schemaVersion: "kronos-release-provenance/1",
    releaseId,
    label: releaseId.replace(/-[0-9]{8}T[0-9]{6}Z$/, ""),
    environment,
    activatedAt,
  }), "utf8");
  return {
    directory,
    file,
    env: {
      LIVE_BINANCE_ENV: environment,
      KRONOS_RELEASE_PROVENANCE_FILE: file,
    } as NodeJS.ProcessEnv,
  };
}

describe("execution release provenance", () => {
  it("captures the active matching release and never accepts a cross-environment manifest", () => {
    const fixture = withManifest("testnet", "fade-r30-bbo-trigger-20260903T112300Z");
    try {
      expect(readRuntimeReleaseManifest(fixture.env)).toMatchObject({
        releaseId: "fade-r30-bbo-trigger-20260903T112300Z",
        label: "fade-r30-bbo-trigger",
        environment: "testnet",
      });

      const opened = captureOpenedExecutionReleaseLifecycle(openedAt, fixture.env);
      expect(opened).toMatchObject({
        openedWith: {
          releaseId: "fade-r30-bbo-trigger-20260903T112300Z",
          label: "fade-r30-bbo-trigger",
          activatedAt: "2026-09-03T03:20:00.000Z",
          capturedAt: openedAt,
          source: "RUNTIME_MANIFEST",
        },
        closedWith: null,
      });

      expect(readRuntimeReleaseManifest({
        ...fixture.env,
        LIVE_BINANCE_ENV: "mainnet",
      })).toBeNull();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("renders pre-provenance records as LEGACY instead of guessing from the current release", () => {
    expect(normalizeExecutionReleaseLifecycle(null, openedAt)).toEqual({
      openedWith: expect.objectContaining({
        label: "LEGACY",
        capturedAt: openedAt,
        source: "LEGACY_UNVERIFIED",
      }),
      closedWith: null,
    });
  });

  it("projects old Cross closed baskets as LEGACY in the report payload", () => {
    const rows = closedBasketRealizedBreakdown([{
      basketId: "legacy-basket",
      variant: "RAW",
      signal: "CROSS_SECTIONAL_MARKET_NEUTRAL",
      openedAt,
      closedAt,
      status: "CLOSED",
      closeReason: "HORIZON",
      grossPnlUsd: 1,
      feeEstimateUsd: 0.1,
      netPnlUsd: 0.9,
      legs: [{
        symbol: "SOLUSDT",
        side: "LONG",
        qty: 1,
        entryPrice: 100,
        exitPrice: 101,
        entryPriceConfirmed: true,
        exitPriceConfirmed: true,
      }],
    }] as never);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.releaseProvenance).toEqual({
      openedWith: expect.objectContaining({
        label: "LEGACY",
        capturedAt: openedAt,
        source: "LEGACY_UNVERIFIED",
      }),
      closedWith: null,
    });
  });

  it("keeps the first terminal close release through retries and reconciliation", () => {
    const first = withManifest("testnet", "release-v1-20260903T112300Z");
    const second = withManifest("testnet", "release-v2-20260903T120000Z", "2026-09-03T04:00:00.000Z");
    try {
      const opened = captureOpenedExecutionReleaseLifecycle(openedAt, first.env);
      const settled = stampClosedExecutionReleaseLifecycle(opened, openedAt, closedAt, first.env);
      const retried = stampClosedExecutionReleaseLifecycle(
        settled,
        openedAt,
        "2026-09-03T05:00:00.000Z",
        second.env,
      );

      expect(retried.closedWith).toMatchObject({
        releaseId: "release-v1-20260903T112300Z",
        label: "release-v1",
        capturedAt: closedAt,
        source: "RUNTIME_MANIFEST",
      });
    } finally {
      rmSync(first.directory, { recursive: true, force: true });
      rmSync(second.directory, { recursive: true, force: true });
    }
  });
});
