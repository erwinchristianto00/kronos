import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Direction } from "@dtc/shared";

import type { PaperOrder } from "./paper-execution-router.js";

const CONTROL_FILE = "paper-trading-controls.json";
const DEFAULT_TAKER_ROUNDTRIP_BPS = 22;

export interface PaperTradingControls {
  version: 1;
  cgWideTpPct: number | null;
  updatedAt: string | null;
}

export interface PaperTpAssessment {
  activeTpPct: number;
  configuredTpPct: number | null;
  defaultTpPct: number;
  roundTripCostPct: number;
  netTpAfterCostPct: number;
  verdict: "TOO_TIGHT_AFTER_COST" | "LOW_EDGE_AFTER_COST" | "OK";
  reason: string;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function dataDir(): string {
  return process.env.PAPER_CONTROLS_DATA_DIR ?? "data";
}

function controlPath(): string {
  return resolve(dataDir(), CONTROL_FILE);
}

function emptyControls(): PaperTradingControls {
  return { version: 1, cgWideTpPct: null, updatedAt: null };
}

function sanitizeTpPct(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0.05, Math.min(10, parsed));
}

export function readPaperTradingControls(): PaperTradingControls {
  try {
    const file = controlPath();
    if (!existsSync(file)) return emptyControls();
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PaperTradingControls>;
    return {
      version: 1,
      cgWideTpPct: sanitizeTpPct(parsed.cgWideTpPct),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return emptyControls();
  }
}

export function writePaperTradingControls(next: Partial<PaperTradingControls>): PaperTradingControls {
  const controls: PaperTradingControls = {
    ...readPaperTradingControls(),
    ...next,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  controls.cgWideTpPct = sanitizeTpPct(controls.cgWideTpPct);
  const file = controlPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(controls, null, 2), "utf-8");
  renameSync(tmp, file);
  return controls;
}

export function cgWideTargetFromEntry(entryPrice: number, direction: Direction, tpPct: number | null): number | null {
  if (!finite(entryPrice) || entryPrice <= 0 || !finite(tpPct) || tpPct <= 0) return null;
  return direction === "SHORT"
    ? entryPrice * (1 - tpPct / 100)
    : entryPrice * (1 + tpPct / 100);
}

export function cgWideTpPctFromOrder(order: PaperOrder): number | null {
  const target = order.takeProfitLevels[0];
  if (!finite(order.entryPrice) || order.entryPrice <= 0 || !finite(target) || target <= 0) return null;
  return order.direction === "SHORT"
    ? ((order.entryPrice - target) / order.entryPrice) * 100
    : ((target - order.entryPrice) / order.entryPrice) * 100;
}

export function roundTripCostPct(roundTripBps = DEFAULT_TAKER_ROUNDTRIP_BPS): number {
  return roundTripBps / 100;
}

export function assessPaperTp(activeTpPct: number | null | undefined): PaperTpAssessment | null {
  if (!finite(activeTpPct) || activeTpPct <= 0) return null;
  const controls = readPaperTradingControls();
  const costPct = roundTripCostPct();
  const netPct = activeTpPct - costPct;
  const verdict: PaperTpAssessment["verdict"] =
    netPct <= 0
      ? "TOO_TIGHT_AFTER_COST"
      : netPct < costPct
        ? "LOW_EDGE_AFTER_COST"
        : "OK";
  return {
    activeTpPct,
    configuredTpPct: controls.cgWideTpPct,
    defaultTpPct: 3,
    roundTripCostPct: costPct,
    netTpAfterCostPct: netPct,
    verdict,
    reason:
      verdict === "TOO_TIGHT_AFTER_COST"
        ? "TP is below estimated round-trip taker fee/slippage."
        : verdict === "LOW_EDGE_AFTER_COST"
          ? "TP is positive after cost, but the edge cushion is thin."
          : "TP remains above estimated round-trip taker fee/slippage.",
  };
}
