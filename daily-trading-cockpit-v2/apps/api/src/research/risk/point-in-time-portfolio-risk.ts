import type { PointInTimePortfolioRiskSnapshot } from "../tournament-types.js";

export class PointInTimePortfolioRisk {
  private readonly snapshots: readonly PointInTimePortfolioRiskSnapshot[];

  constructor(snapshots: readonly PointInTimePortfolioRiskSnapshot[]) {
    if (snapshots.length === 0) throw new Error("TOURNAMENT_PORTFOLIO_RISK_SNAPSHOTS_MISSING");
    this.snapshots = snapshots.map((snapshot) => ({
      ...snapshot,
      btcBetaBySymbol: { ...snapshot.btcBetaBySymbol },
      correlationClusterBySymbol: { ...snapshot.correlationClusterBySymbol },
    })).sort((a, b) => a.asOfMs - b.asOfMs);
    if (this.snapshots.some((snapshot, index) => snapshot.asOfMs > snapshot.validUntilMs || (index > 0 && snapshot.asOfMs <= this.snapshots[index - 1]!.asOfMs) || !snapshot.sourceHash)) {
      throw new Error("TOURNAMENT_PORTFOLIO_RISK_SNAPSHOTS_INVALID");
    }
  }

  at(symbol: string, timestampMs: number, maxAgeMs: number): { btcBeta: number; correlationCluster: string; sourceHash: string } {
    const snapshot = [...this.snapshots].reverse().find((candidate) => candidate.asOfMs <= timestampMs);
    if (!snapshot) throw new Error(`TOURNAMENT_PORTFOLIO_RISK_FUTURE_OR_MISSING_${symbol}_${timestampMs}`);
    if (timestampMs > snapshot.validUntilMs || timestampMs - snapshot.asOfMs > maxAgeMs) throw new Error(`TOURNAMENT_PORTFOLIO_RISK_STALE_${symbol}_${timestampMs}`);
    const btcBeta = snapshot.btcBetaBySymbol[symbol]; const correlationCluster = snapshot.correlationClusterBySymbol[symbol];
    if (!Number.isFinite(btcBeta) || !correlationCluster) throw new Error(`TOURNAMENT_PORTFOLIO_RISK_SYMBOL_MISSING_${symbol}_${timestampMs}`);
    return { btcBeta, correlationCluster, sourceHash: snapshot.sourceHash };
  }
}
