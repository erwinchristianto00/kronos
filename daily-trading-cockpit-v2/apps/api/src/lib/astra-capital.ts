/** Execution capital contract, not strategy PnL or a synthetic sub-wallet. */
export const ASTRA_CAPITAL = Object.freeze({
  mode: "BINANCE_TESTNET_WALLET" as const,
  asset: "USDT" as const,
  maxEntryNotionalUsd: 25,
  totalLaneAllocationUsd: null,
  maxOpenPositions: null,
  sharedAccountGuardsApply: true,
});
export interface AstraWalletSnapshot {
  walletBalance: number; availableBalance: number; fetchedAt: number;
}
export function walletView(snapshot: AstraWalletSnapshot | null, error: string | null, now: number) {
  const fresh = !!snapshot && now >= snapshot.fetchedAt && now - snapshot.fetchedAt <= 120000 && !error;
  return { source: "BINANCE_USDM_TESTNET_BALANCE" as const, asset: "USDT" as const,
    sharedAccount: true, snapshot, fresh, error };
}
