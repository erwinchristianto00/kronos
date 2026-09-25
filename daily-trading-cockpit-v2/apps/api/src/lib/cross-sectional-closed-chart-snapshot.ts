/**
 * Immutable close-time charts for a Cross-Sectional basket.
 *
 * A basket has several independently traded symbols, so one durable SVG holds
 * one vertical 1D panel per confirmed leg.  It is generated after settlement
 * and every candle is capped before the basket's confirmed close timestamp.
 * The dashboard therefore never re-queries a historical report into a later
 * price path.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { FuturesKline } from "./binance-futures-private.js";

export const CROSS_SECTIONAL_CLOSED_CHART_SNAPSHOT_VERSION = "cross-sectional-closed-chart-svg-v2" as const;
type CrossSectionalClosedChartSnapshotVersion =
  | typeof CROSS_SECTIONAL_CLOSED_CHART_SNAPSHOT_VERSION
  | "cross-sectional-closed-chart-svg-v1";

export type CrossSectionalClosedChartSnapshot = {
  version: CrossSectionalClosedChartSnapshotVersion;
  status: "CAPTURED" | "PENDING" | "UNAVAILABLE";
  requestedAt: string;
  capturedAt: string | null;
  source: "BINANCE_USDM_COMPLETED_CANDLES";
  entryAt: string | null;
  exitAt: string | null;
  assetFile: string | null;
  mimeType: "image/svg+xml" | null;
  dailyCandleCount: number;
  legCount: number;
  reason: string | null;
};

export type CrossSectionalClosedChartSnapshotLeg = Readonly<{
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number | null;
  entryPriceConfirmed: boolean;
  exitPriceConfirmed: boolean | null;
  entryFilledAt?: string | null;
}>;

export type CrossSectionalClosedChartSnapshotBasket = Readonly<{
  basketId: string;
  openedAt: string;
  closedAt: string | null;
  signal: string;
  variant: string;
  /** First real Net Ladder arm; absent on legacy/non-armed baskets. */
  netLadderArm?: { at: string; armNetPnlUsd: number } | null;
  legs: readonly CrossSectionalClosedChartSnapshotLeg[];
}>;

export type CrossSectionalClosedChartSnapshotClient = {
  getKlines(symbol: string, interval: "1d", opts?: { startTime?: number; endTime?: number; limit?: number }): Promise<FuturesKline[]>;
};

type Candle = Readonly<{
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;
type Point = Readonly<{ openTime: number; value: number }>;
type StructuralLine = Readonly<{ kind: "RESISTANCE" | "SUPPORT"; anchors: readonly [Point, Point] }>;

const DAY_MS = 24 * 60 * 60_000;
const DAILY_CONTEXT_BARS = 120;
const VIEWPORT_CONTEXT_BARS = 45;
// Keep execution dots neutral while preserving the colored price lines and
// labels that distinguish entry from exit in the closed-basket review.
const EXECUTION_MARKER_POINT_COLOR = "#FFFFFF";
const COLORS = {
  background: "#071016",
  panel: "#0b171e",
  border: "#29414c",
  grid: "#263d48",
  text: "#dbe7ec",
  dim: "#8fa5ae",
  up: "#5ce4a6",
  down: "#ff777d",
  entry: "#f8fafc",
  exit: "#c4b5fd",
  ema20: "#EEDD88",
  ema50: "#AA4499",
  resistance: "#9CA3AF",
  support: "#66CCEE",
} as const;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

function price(value: number): string {
  const digits = value < 0.0001 ? 10 : value < 0.01 ? 8 : value < 1 ? 6 : value < 100 ? 4 : 2;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function taipei(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Taipei",
  }).format(new Date(ms)).replace(",", "");
}

function taipeiShort(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour12: false, timeZone: "Asia/Taipei",
  }).format(new Date(ms)).replace(",", " ");
}

function asCandle(value: FuturesKline): Candle | null {
  if (!positive(value.openTime) || !positive(value.closeTime) || !positive(value.open)
    || !positive(value.high) || !positive(value.low) || !positive(value.close)
    || !finite(value.volume) || value.volume < 0) return null;
  return value;
}

function completedCandles(rows: readonly FuturesKline[], startMs: number, exitMs: number): Candle[] {
  const unique = new Map<number, Candle>();
  for (const row of rows) {
    const candle = asCandle(row);
    // `closeTime >= exitMs` means the candle was still forming at the actual
    // close.  It is never allowed into an immutable close-time artifact.
    if (!candle || candle.openTime < startMs || candle.closeTime >= exitMs) continue;
    unique.set(candle.openTime, candle);
  }
  return [...unique.values()].sort((a, b) => a.openTime - b.openTime);
}

function ema(candles: readonly Candle[], period: number): Point[] {
  if (candles.length < period) return [];
  const multiplier = 2 / (period + 1);
  let value = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const out: Point[] = [{ openTime: candles[period - 1]!.openTime, value }];
  for (let index = period; index < candles.length; index += 1) {
    value = (candles[index]!.close - value) * multiplier + value;
    out.push({ openTime: candles[index]!.openTime, value });
  }
  return out;
}

function latestStructuralLine(candles: readonly Candle[], kind: StructuralLine["kind"]): StructuralLine | null {
  const pivots: Point[] = [];
  const radius = 2;
  for (let index = radius; index < candles.length - radius; index += 1) {
    const candidate = candles[index]!;
    const candidateValue = kind === "RESISTANCE" ? candidate.high : candidate.low;
    let confirmed = true;
    for (let offset = 1; offset <= radius; offset += 1) {
      const before = candles[index - offset]!;
      const after = candles[index + offset]!;
      const beforeValue = kind === "RESISTANCE" ? before.high : before.low;
      const afterValue = kind === "RESISTANCE" ? after.high : after.low;
      if (kind === "RESISTANCE" ? candidateValue <= beforeValue || candidateValue <= afterValue : candidateValue >= beforeValue || candidateValue >= afterValue) {
        confirmed = false;
        break;
      }
    }
    if (confirmed) pivots.push({ openTime: candidate.openTime, value: candidateValue });
  }
  if (pivots.length < 2) return null;
  return { kind, anchors: [pivots[pivots.length - 2]!, pivots[pivots.length - 1]!] };
}

function lineSvg(points: readonly Point[], x: (at: number) => number, y: (value: number) => number, start: number, end: number): string {
  const visible = points.filter((point) => point.openTime >= start && point.openTime <= end);
  return visible.map((point) => `${x(point.openTime).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
}

function structuralSvg(line: StructuralLine | null, x: (at: number) => number, y: (value: number) => number, start: number, end: number): string {
  if (!line) return "";
  const [first, second] = line.anchors;
  const elapsed = second.openTime - first.openTime;
  if (!(elapsed > 0)) return "";
  const slope = (second.value - first.value) / elapsed;
  const from = Math.max(start, first.openTime);
  const to = Math.max(from + 1, end);
  return `${x(from).toFixed(2)},${y(first.value + slope * (from - first.openTime)).toFixed(2)} ${x(to).toFixed(2)},${y(first.value + slope * (to - first.openTime)).toFixed(2)}`;
}

/** Only a genuine completed candle may receive an observed arm marker. */
function containingCompletedCandle(candles: readonly Candle[], at: number): Candle | null {
  return candles.find((candle) => at >= candle.openTime && at <= candle.closeTime) ?? null;
}

function renderLegPanel(input: {
  index: number;
  leg: CrossSectionalClosedChartSnapshotLeg;
  candles: Candle[];
  entryAtMs: number;
  exitAtMs: number;
  armAtMs: number | null;
  armLabel: string | null;
}): string {
  const { index, leg, candles, entryAtMs, exitAtMs, armAtMs, armLabel } = input;
  const panelX = 32;
  const panelY = 114 + index * 472;
  const panelWidth = 1536;
  const panelHeight = 442;
  const left = panelX + 68;
  const right = panelX + panelWidth - 152;
  const top = panelY + 50;
  const priceBottom = panelY + panelHeight - 112;
  const volumeTop = priceBottom + 19;
  const volumeBottom = panelY + panelHeight - 45;
  const plotWidth = right - left;
  const firstOpen = candles[0]!.openTime;
  const viewStart = Math.max(firstOpen, Math.min(entryAtMs, exitAtMs, armAtMs ?? entryAtMs) - VIEWPORT_CONTEXT_BARS * DAY_MS);
  const viewEnd = Math.max(viewStart + DAY_MS, exitAtMs);
  const visible = candles.filter((candle) => candle.openTime + DAY_MS > viewStart && candle.openTime <= viewEnd);
  const ema20 = ema(candles, 20);
  const ema50 = ema(candles, 50);
  const resistance = latestStructuralLine(candles, "RESISTANCE");
  const support = latestStructuralLine(candles, "SUPPORT");
  const structuralValues = [resistance, support].flatMap((line) => line ? line.anchors.map((point) => point.value) : []);
  const values = [
    ...visible.flatMap((candle) => [candle.low, candle.high]),
    leg.entryPrice,
    leg.exitPrice ?? 0,
    ...ema20.filter((point) => point.openTime >= viewStart && point.openTime <= viewEnd).map((point) => point.value),
    ...ema50.filter((point) => point.openTime >= viewStart && point.openTime <= viewEnd).map((point) => point.value),
    ...structuralValues,
  ].filter(positive);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * 0.1, maximum * 0.001, 1e-10);
  const low = minimum - padding;
  const high = maximum + padding;
  const x = (at: number) => left + (at - viewStart) / (viewEnd - viewStart) * plotWidth;
  const y = (value: number) => top + (high - value) / (high - low) * (priceBottom - top);
  const clipId = `xsec-close-${index}`;
  const grid = Array.from({ length: 5 }, (_, row) => {
    const ratio = row / 4;
    const yy = top + ratio * (priceBottom - top);
    const value = high - ratio * (high - low);
    return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="${COLORS.grid}" stroke-width="1" opacity="0.7"/><text x="${right + 10}" y="${yy + 4}" fill="${COLORS.dim}" font-size="12">${escapeXml(price(value))}</text>`;
  }).join("");
  const timeGrid = Array.from({ length: 5 }, (_, column) => {
    const ratio = column / 4;
    const at = viewStart + ratio * (viewEnd - viewStart);
    const xx = x(at);
    return `<line x1="${xx}" y1="${top}" x2="${xx}" y2="${volumeBottom}" stroke="${COLORS.grid}" stroke-width="1" opacity="0.48"/><text x="${xx}" y="${panelY + panelHeight - 20}" fill="${COLORS.dim}" font-size="11" text-anchor="middle">${escapeXml(taipeiShort(at))}</text>`;
  }).join("");
  const candleWidth = Math.max(2, Math.min(15, plotWidth / Math.max(visible.length, 1) * 0.7));
  const candleSvg = visible.map((candle) => {
    const xx = x(candle.openTime + DAY_MS / 2);
    const color = candle.close >= candle.open ? COLORS.up : COLORS.down;
    const openY = y(candle.open);
    const closeY = y(candle.close);
    return `<line x1="${xx}" y1="${y(candle.high)}" x2="${xx}" y2="${y(candle.low)}" stroke="${color}" stroke-width="1.2"/><rect x="${xx - candleWidth / 2}" y="${Math.min(openY, closeY)}" width="${candleWidth}" height="${Math.max(1, Math.abs(openY - closeY))}" fill="${color}"/>`;
  }).join("");
  const emaSvg = [
    { points: ema20, color: COLORS.ema20 },
    { points: ema50, color: COLORS.ema50 },
  ].map((line) => {
    const points = lineSvg(line.points, x, y, viewStart, viewEnd);
    return points ? `<polyline points="${points}" fill="none" stroke="${line.color}" stroke-width="2"/>` : "";
  }).join("");
  const structureSvg = [
    { line: resistance, color: COLORS.resistance },
    { line: support, color: COLORS.support },
  ].map(({ line, color }) => {
    const points = structuralSvg(line, x, y, viewStart, viewEnd);
    return points ? `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.2"/>` : "";
  }).join("");
  const levels = [
    { label: `Entry ${price(leg.entryPrice)}`, value: leg.entryPrice, color: COLORS.entry },
    { label: `Exit ${price(leg.exitPrice!)}`, value: leg.exitPrice!, color: COLORS.exit },
  ].map((level) => `<line x1="${left}" y1="${y(level.value)}" x2="${right}" y2="${y(level.value)}" stroke="${level.color}" stroke-width="1.5" stroke-dasharray="7 6"/><text x="${right - 4}" y="${Math.max(top + 13, Math.min(priceBottom - 5, y(level.value) - 5))}" fill="${level.color}" font-size="12" text-anchor="end" font-weight="700">${escapeXml(level.label)}</text>`).join("");
  const marker = (at: number, value: number, label: string, color: string) => {
    if (at < viewStart || at > viewEnd) return "";
    const xx = x(at);
    const yy = y(value);
    return `<circle cx="${xx}" cy="${yy}" r="5" fill="${EXECUTION_MARKER_POINT_COLOR}" stroke="${COLORS.background}" stroke-width="2"/><text x="${xx + 8}" y="${Math.max(top + 14, yy - 10)}" fill="${color}" font-size="12" font-weight="700">${escapeXml(label)}</text>`;
  };
  const armCandle = armAtMs === null ? null : containingCompletedCandle(visible, armAtMs);
  const armMarker = armCandle === null || !armLabel
    ? ""
    : (() => {
      const xx = x(armCandle.openTime + DAY_MS / 2);
      const anchorY = y(armCandle.high);
      const markerY = Math.max(top + 10, anchorY - 11);
      return `<g data-execution-marker="ARM" data-marker-candle-open="${armCandle.openTime}" data-marker-anchor="high"><line x1="${xx}" y1="${anchorY}" x2="${xx}" y2="${markerY}" stroke="${EXECUTION_MARKER_POINT_COLOR}" stroke-width="1.2" stroke-dasharray="2 2"/><circle cx="${xx}" cy="${markerY}" r="5" fill="${EXECUTION_MARKER_POINT_COLOR}" stroke="${COLORS.background}" stroke-width="2"/><text x="${xx + 8}" y="${Math.max(top + 14, markerY - 10)}" fill="${EXECUTION_MARKER_POINT_COLOR}" font-size="12" font-weight="700">${escapeXml(armLabel)}</text></g>`;
    })();
  const volumeMax = Math.max(...visible.map((candle) => candle.volume), 1);
  const volumeSvg = visible.map((candle) => {
    const xx = x(candle.openTime + DAY_MS / 2);
    const height = Math.max(1, candle.volume / volumeMax * (volumeBottom - volumeTop));
    return `<rect x="${xx - candleWidth / 2}" y="${volumeBottom - height}" width="${candleWidth}" height="${height}" fill="${candle.close >= candle.open ? COLORS.up : COLORS.down}" opacity="0.42"/>`;
  }).join("");
  const sideColor = leg.side === "LONG" ? COLORS.up : COLORS.down;
  return `<g font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
    <rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="8" fill="${COLORS.panel}" stroke="${COLORS.border}"/>
    <text x="${panelX + 16}" y="${panelY + 23}" fill="${COLORS.text}" font-size="16" font-weight="700">${escapeXml(`${leg.symbol} · ${leg.side} · 1D`)}</text>
    <text x="${panelX + 16}" y="${panelY + 40}" fill="${COLORS.dim}" font-size="11">${escapeXml(`entry ${taipei(entryAtMs)} @ ${price(leg.entryPrice)} → basket close ${taipei(exitAtMs)} @ ${price(leg.exitPrice!)}`)}</text>
    <text x="${panelX + panelWidth - 16}" y="${panelY + 23}" fill="${sideColor}" font-size="12" text-anchor="end" font-weight="700">${leg.side}</text>
    <clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${right - left}" height="${priceBottom - top}"/></clipPath>
    ${grid}${timeGrid}
    <line x1="${left}" y1="${volumeTop - 9}" x2="${right}" y2="${volumeTop - 9}" stroke="${COLORS.grid}" stroke-width="1"/>
    <g clip-path="url(#${clipId})">${candleSvg}${levels}${emaSvg}${structureSvg}${marker(entryAtMs, leg.entryPrice, `ENTRY ${leg.side}`, COLORS.entry)}${marker(exitAtMs, leg.exitPrice!, "EXIT", COLORS.exit)}${armMarker}</g>
    ${volumeSvg}
    <text x="${left}" y="${panelY + panelHeight - 20}" fill="${COLORS.dim}" font-size="11">volume</text>
    <g transform="translate(${panelX + 16}, ${panelY + panelHeight - 13})">
      <rect x="0" y="-8" width="10" height="3" fill="${COLORS.ema20}"/><text x="15" y="-5" fill="${COLORS.dim}" font-size="10">EMA20</text>
      <rect x="88" y="-8" width="10" height="3" fill="${COLORS.ema50}"/><text x="103" y="-5" fill="${COLORS.dim}" font-size="10">EMA50</text>
      <rect x="176" y="-8" width="10" height="3" fill="${COLORS.resistance}"/><text x="191" y="-5" fill="${COLORS.dim}" font-size="10">Structural resistance</text>
      <rect x="352" y="-8" width="10" height="3" fill="${COLORS.support}"/><text x="367" y="-5" fill="${COLORS.dim}" font-size="10">Structural support</text>
      ${armCandle ? `<circle cx="510" cy="-7" r="3" fill="${EXECUTION_MARKER_POINT_COLOR}"/><text x="518" y="-5" fill="${COLORS.dim}" font-size="10">first Net Ladder arm</text>` : ""}
    </g>
  </g>`;
}

function assetFile(basketId: string): string | null {
  return /^[a-z0-9-]{4,96}$/i.test(basketId) ? `${basketId}.svg` : null;
}

function unavailable(input: { requestedAt: string; basket: CrossSectionalClosedChartSnapshotBasket; reason: string }): CrossSectionalClosedChartSnapshot {
  const knownEntry = input.basket.legs.map((leg) => leg.entryFilledAt).find((at) => toMs(at) !== null) ?? null;
  return {
    version: CROSS_SECTIONAL_CLOSED_CHART_SNAPSHOT_VERSION,
    status: "UNAVAILABLE",
    requestedAt: input.requestedAt,
    capturedAt: null,
    source: "BINANCE_USDM_COMPLETED_CANDLES",
    entryAt: knownEntry,
    exitAt: input.basket.closedAt,
    assetFile: null,
    mimeType: null,
    dailyCandleCount: 0,
    legCount: input.basket.legs.length,
    reason: input.reason,
  };
}

export function pendingCrossSectionalClosedChartSnapshot(basket: CrossSectionalClosedChartSnapshotBasket, requestedAt: string): CrossSectionalClosedChartSnapshot {
  const knownEntry = basket.legs.map((leg) => leg.entryFilledAt).find((at) => toMs(at) !== null) ?? null;
  return {
    version: CROSS_SECTIONAL_CLOSED_CHART_SNAPSHOT_VERSION,
    status: "PENDING",
    requestedAt,
    capturedAt: null,
    source: "BINANCE_USDM_COMPLETED_CANDLES",
    entryAt: knownEntry,
    exitAt: basket.closedAt,
    assetFile: null,
    mimeType: null,
    dailyCandleCount: 0,
    legCount: basket.legs.length,
    reason: null,
  };
}

export async function captureCrossSectionalClosedChartSnapshot(input: {
  directory: string;
  client: CrossSectionalClosedChartSnapshotClient;
  basket: CrossSectionalClosedChartSnapshotBasket;
  nowMs?: () => number;
}): Promise<CrossSectionalClosedChartSnapshot> {
  const requestedAt = new Date(input.nowMs?.() ?? Date.now()).toISOString();
  const exitAtMs = toMs(input.basket.closedAt);
  const file = assetFile(input.basket.basketId);
  if (exitAtMs === null || !file) return unavailable({ requestedAt, basket: input.basket, reason: "a valid confirmed basket close and basket id are required" });
  if (input.basket.legs.length === 0) return unavailable({ requestedAt, basket: input.basket, reason: "a closed basket needs at least one settled leg" });
  const prepared = input.basket.legs.map((leg) => ({ leg, entryAtMs: toMs(leg.entryFilledAt) }));
  if (prepared.some(({ leg, entryAtMs }) => entryAtMs === null || entryAtMs! > exitAtMs || !positive(leg.entryPrice) || !positive(leg.exitPrice) || leg.entryPriceConfirmed !== true || leg.exitPriceConfirmed !== true)) {
    return unavailable({ requestedAt, basket: input.basket, reason: "every leg needs ordered exchange-confirmed entry and exit fills" });
  }
  const dailyEnd = Math.floor((exitAtMs - 1) / DAY_MS) * DAY_MS;
  const dailyStart = Math.max(0, dailyEnd - (DAILY_CONTEXT_BARS - 1) * DAY_MS);
  try {
    const series = await Promise.all(prepared.map(async ({ leg, entryAtMs }) => ({
      leg,
      entryAtMs: entryAtMs!,
      candles: completedCandles(await input.client.getKlines(leg.symbol, "1d", { startTime: dailyStart, endTime: dailyEnd, limit: DAILY_CONTEXT_BARS }), dailyStart, exitAtMs),
    })));
    const empty = series.find((item) => item.candles.length === 0);
    if (empty) return unavailable({ requestedAt, basket: input.basket, reason: `no completed 1D USD-M candle is available before close for ${empty.leg.symbol}` });
    const svgHeight = 114 + series.length * 472 + 32;
    const armAtMs = toMs(input.basket.netLadderArm?.at);
    const armLabel = armAtMs !== null && positive(input.basket.netLadderArm?.armNetPnlUsd)
      ? `ARM +$${input.basket.netLadderArm!.armNetPnlUsd.toFixed(2)}`
      : null;
    const panels = series.map((item, index) => renderLegPanel({
      index,
      leg: item.leg,
      candles: item.candles,
      entryAtMs: item.entryAtMs,
      exitAtMs,
      armAtMs,
      armLabel,
    })).join("");
    const earliestEntryMs = Math.min(...series.map((item) => item.entryAtMs));
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${svgHeight}" viewBox="0 0 1600 ${svgHeight}" role="img" aria-labelledby="snapshot-title snapshot-desc">
  <title id="snapshot-title">${escapeXml(`${input.basket.basketId} Cross-Sectional closed chart snapshot`)}</title>
  <desc id="snapshot-desc">Immutable one-day charts for every settled basket leg. Candles are completed Binance USD-M candles strictly before the confirmed basket close. A white ARM marker appears only when the persisted first Net Ladder arm falls inside a completed displayed candle; no nearest candle is substituted.</desc>
  <rect width="1600" height="${svgHeight}" fill="${COLORS.background}"/>
  <text x="32" y="38" fill="${COLORS.text}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="22" font-weight="700">CROSS-SECTIONAL · CLOSED CHART SNAPSHOT</text>
  <text x="32" y="65" fill="${COLORS.dim}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14">${escapeXml(`${input.basket.basketId} · ${input.basket.variant} · ${input.basket.signal} · entry ${taipei(earliestEntryMs)} → confirmed close ${taipei(exitAtMs)} Taipei`)}</text>
  <text x="32" y="88" fill="${COLORS.dim}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">One vertical 1D chart per leg. EMA20/EMA50 and structural support/resistance use only completed candles at close; white ARM = first persisted Net Ladder arm when its completed candle is available.</text>
  ${panels}
</svg>`;
    const root = resolve(input.directory);
    mkdirSync(root, { recursive: true });
    const target = resolve(root, file);
    if (!target.startsWith(root + sep)) return unavailable({ requestedAt, basket: input.basket, reason: "snapshot path escaped its archive directory" });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, svg, "utf8");
    renameSync(temporary, target);
    return {
      version: CROSS_SECTIONAL_CLOSED_CHART_SNAPSHOT_VERSION,
      status: "CAPTURED",
      requestedAt,
      capturedAt: new Date(input.nowMs?.() ?? Date.now()).toISOString(),
      source: "BINANCE_USDM_COMPLETED_CANDLES",
      entryAt: new Date(earliestEntryMs).toISOString(),
      exitAt: input.basket.closedAt,
      assetFile: file,
      mimeType: "image/svg+xml",
      dailyCandleCount: series.reduce((sum, item) => sum + item.candles.length, 0),
      legCount: series.length,
      reason: null,
    };
  } catch (error) {
    return {
      ...pendingCrossSectionalClosedChartSnapshot(input.basket, requestedAt),
      reason: `snapshot source unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Reads only the persisted allow-listed artifact; it never asks the exchange for a new chart. */
export function readCrossSectionalClosedChartSnapshotSvg(
  directory: string,
  snapshot: CrossSectionalClosedChartSnapshot | null | undefined,
): string | null {
  if (snapshot?.status !== "CAPTURED" || snapshot.mimeType !== "image/svg+xml" || !snapshot.assetFile) return null;
  if (!/^[a-z0-9-]{4,96}\.svg$/i.test(snapshot.assetFile)) return null;
  const root = resolve(directory);
  const target = resolve(root, snapshot.assetFile);
  if (!target.startsWith(root + sep)) return null;
  try {
    // Do not mutate the close-time artifact. This only normalizes legacy
    // entry/exit point colors in the bytes returned to the dashboard.
    return readFileSync(target, "utf8")
      .replace(/(<circle\b[^>]*\br="5"\s+fill=")(?:#f8fafc|#c4b5fd)(?="\s+stroke="#071016"\s+stroke-width="2"\/>)/gi, `$1${EXECUTION_MARKER_POINT_COLOR}`);
  } catch {
    return null;
  }
}
