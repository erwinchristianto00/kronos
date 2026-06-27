import { useEffect, useState } from 'react';
import './neural-mindmap.css';

const REFRESH_MS = 5_000;
const TESTNET_API_PREFIX = '/testnet/api';

interface LiveStatus {
  enabled: boolean;
  env?: string | null;
  armed?: boolean;
  killedAt?: string | null;
  killReason?: string | null;
  configErrors?: string[];
  health?: {
    errorStreak: number;
    clockSkewMs: number | null;
    lastTickAt: string | null;
    lastTickError: string | null;
  };
  controller?: {
    regime: string | null;
    mode: string | null;
    bias?: string | null;
    confidence?: string | null;
    reasons?: string[];
    capturedAt?: string | null;
  } | null;
  reconcileIssues?: string[];
  watermark?: string;
  quarantinedPaperOrders?: number;
  openIntents?: Array<{
    paperOrderId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    state: string;
    qty: number;
  }>;
  closedToday?: {
    dateUtc: string;
    realizedPnlUsd: number;
    wins: number;
    losses: number;
  };
  consecutiveLosses?: number;
  totalRealizedPnlUsd?: number;
  reason?: string;
}

interface LiveAccount {
  ok?: boolean;
  reason?: string;
  walletBalance: number | null;
  availableBalance: number | null;
  unrealizedPnl: number;
  accountEquity: number | null;
  openPositionCount: number;
  openOrderCount: number;
  positions: Array<{
    symbol: string;
    direction: 'LONG' | 'SHORT';
    quantity: number;
    entryPrice: number;
    markPrice: number | null;
    targetTpPrice: number | null;
    targetTpGapPct: number | null;
    liquidationPrice: number | null;
    unrealizedPnl: number;
    estimatedCloseCostUsd?: number;
    unrealizedAfterEstimatedCloseCostUsd?: number;
    leverage: number;
    sourceOrderCount: number;
    laneIds: string[];
  }>;
  lanes: Array<{
    laneId: string;
    sourceOrderCount: number;
    symbols: string[];
    notionalUsd: number;
    unrealizedPnl: number;
  }>;
}

function signed(value: number | null | undefined, suffix = 'USDT'): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} ${suffix}`;
}

function plain(value: number | null | undefined, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}${suffix}`;
}

function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return 'n/a';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function tone(value: number | null | undefined): string {
  if (value == null || value === 0) return 'tone-measure';
  return value > 0 ? 'tone-healthy' : 'tone-critical';
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ageSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ago`;
}

function compactLane(laneId: string): string {
  return laneId.replace(/^CG_VARIANT_MATRIX:/, '').replace(/^CG_LONG_VARIANT_MATRIX:/, '');
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.reason ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export default function TestnetExchangeDashboard() {
  const [account, setAccount] = useState<LiveAccount | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);

  async function loadExchangeOnly() {
    try {
      const [nextStatus, nextAccount] = await Promise.all([
        fetchJson<LiveStatus>(`${TESTNET_API_PREFIX}/live/status`),
        fetchJson<LiveAccount>(`${TESTNET_API_PREFIX}/live/account`),
      ]);
      setStatus(nextStatus);
      setAccount(nextAccount);
      setError(null);
      setLastLoadedAt(new Date().toISOString());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load Binance testnet mirror');
    }
  }

  useEffect(() => {
    void loadExchangeOnly();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadExchangeOnly();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const stale = lastLoadedAt ? Date.now() - new Date(lastLoadedAt).getTime() > REFRESH_MS * 2.5 : true;
  const healthTone = status?.armed ? 'tone-healthy' : status?.health?.lastTickError ? 'tone-warning' : 'tone-measure';

  return (
    <div className="neural-shell testnet-shell">
      <header className="neural-topbar">
        <div className="neural-brand">
          <span className={`neural-live-dot ${stale || error ? 'is-stale' : ''}`} />
          <div>
            <p>Binance testnet mirror</p>
            <h1>Exchange P&amp;L</h1>
          </div>
        </div>
        <nav className="neural-nav" aria-label="Dashboard views">
          <button type="button" className="is-current">Testnet</button>
        </nav>
        <div className="neural-actions">
          <label className="neural-toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span />
            Live
          </label>
          <button type="button" className="neural-icon-button" title="Refresh exchange data" aria-label="Refresh exchange data" onClick={() => void loadExchangeOnly()}>
            ↻
          </button>
        </div>
      </header>

      <section className="neural-statusbar testnet-statusbar">
        <div>
          <span>Execution</span>
          <strong className={healthTone}>{status?.armed ? 'Armed' : 'Disarmed'}</strong>
          <small>{status?.env ?? 'loading'} · {status?.enabled === false ? 'disabled' : 'live engine'}</small>
        </div>
        <div>
          <span>Regime</span>
          <strong>{status?.controller?.regime ?? 'Loading'}</strong>
          <small>{status?.controller?.mode ?? 'mode n/a'} · {status?.controller?.bias ?? 'bias n/a'} · {status?.controller?.confidence ?? 'confidence n/a'}</small>
        </div>
        <div>
          <span>Binance equity</span>
          <strong>{account?.accountEquity != null ? `${account.accountEquity.toFixed(2)} USDT` : 'Loading'}</strong>
          <small>{account?.availableBalance != null ? `${account.availableBalance.toFixed(2)} available` : 'testnet wallet'}</small>
        </div>
        <div>
          <span>Unrealized P&amp;L</span>
          <strong className={tone(account?.unrealizedPnl)}>{signed(account?.unrealizedPnl)}</strong>
          <small>{account ? `${account.openPositionCount} exchange positions` : 'loading positions'}</small>
        </div>
        <div>
          <span>Realized P&amp;L</span>
          <strong className={tone(status?.totalRealizedPnlUsd)}>{signed(status?.totalRealizedPnlUsd)}</strong>
          <small>today {signed(status?.closedToday?.realizedPnlUsd)}</small>
        </div>
        <div>
          <span>Open exits</span>
          <strong>{account?.openOrderCount ?? 'n/a'}</strong>
          <small>{status?.openIntents?.length ?? 0} mirrored intents</small>
        </div>
      </section>

      {error && (
        <div className="neural-error">
          <strong>Exchange link interrupted</strong>
          <span>{error}. Last visible Binance state remains on screen.</span>
        </div>
      )}

      <main className="testnet-grid">
        <section className="testnet-panel testnet-hero">
          <div>
            <span>Scope</span>
            <strong>Exchange-only testnet view</strong>
            <p>This page reads only `{TESTNET_API_PREFIX}/live/status` and `{TESTNET_API_PREFIX}/live/account`. Paper evidence, diagnostics, fade-long, H6 trend, and promotion telemetry are intentionally hidden here.</p>
          </div>
          <div className="testnet-kpis">
            <div><span>Wallet</span><strong>{plain(account?.walletBalance, ' USDT')}</strong></div>
            <div><span>Clock skew</span><strong>{status?.health?.clockSkewMs == null ? 'n/a' : `${Math.round(status.health.clockSkewMs)} ms`}</strong></div>
            <div><span>Last tick</span><strong>{timeAgo(status?.health?.lastTickAt)}</strong></div>
            <div><span>Loss streak</span><strong>{status?.consecutiveLosses ?? 0}</strong></div>
          </div>
        </section>

        {status?.health?.lastTickError && (
          <section className="testnet-panel testnet-warning">
            <span>Live engine warning</span>
            <strong>{status.health.lastTickError}</strong>
            <p>The page is still exchange-only; this warning is from the Binance mirror engine, not diagnostics.</p>
          </section>
        )}

        {status?.killedAt && (
          <section className="testnet-panel testnet-warning">
            <span>Kill switch latched</span>
            <strong>{status.killReason ?? 'Manual or risk kill-switch engaged'}</strong>
            <p>Latched at {new Date(status.killedAt).toLocaleString()}.</p>
          </section>
        )}

        <section className="testnet-panel">
          <header><span>Exchange Positions</span><strong>{account?.positions.length ?? 0}</strong></header>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>TP target</th><th>TP gap</th><th>Liq / margin call</th><th>Unrealized</th><th>After fee+slip</th><th>Lev</th><th>Mirrored lane</th></tr>
              </thead>
              <tbody>
                {(account?.positions ?? []).length === 0 ? (
                  <tr><td colSpan={12}>No open Binance testnet positions.</td></tr>
                ) : account!.positions.map((position) => (
                  <tr key={position.symbol}>
                    <td>{position.symbol}</td>
                    <td className={position.direction === 'SHORT' ? 'tone-warning' : 'tone-healthy'}>{position.direction}</td>
                    <td>{position.quantity}</td>
                    <td>{price(position.entryPrice)}</td>
                    <td>{price(position.markPrice)}</td>
                    <td>{price(position.targetTpPrice)}</td>
                    <td className={tone(position.targetTpGapPct)}>{percent(position.targetTpGapPct)}</td>
                    <td className="tone-critical">{price(position.liquidationPrice)}</td>
                    <td className={tone(position.unrealizedPnl)}>{signed(position.unrealizedPnl)}</td>
                    <td className={tone(position.unrealizedAfterEstimatedCloseCostUsd)}>
                      {signed(position.unrealizedAfterEstimatedCloseCostUsd)}
                    </td>
                    <td>{position.leverage}x</td>
                    <td>{position.laneIds.length > 0 ? position.laneIds.map(compactLane).join(', ') : 'unattributed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="testnet-panel">
          <header><span>Mirrored Lane P&amp;L</span><strong>{account?.lanes.length ?? 0}</strong></header>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Lane</th><th>Orders</th><th>Symbols</th><th>Notional</th><th>Unrealized</th></tr>
              </thead>
              <tbody>
                {(account?.lanes ?? []).length === 0 ? (
                  <tr><td colSpan={5}>No mirrored Binance lane exposure.</td></tr>
                ) : account!.lanes.map((lane) => (
                  <tr key={lane.laneId}>
                    <td>{compactLane(lane.laneId)}</td>
                    <td>{lane.sourceOrderCount}</td>
                    <td>{lane.symbols.join(', ')}</td>
                    <td>{plain(lane.notionalUsd, ' USDT')}</td>
                    <td className={tone(lane.unrealizedPnl)}>{signed(lane.unrealizedPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="testnet-panel">
          <header><span>Mirror Intents</span><strong>{status?.openIntents?.length ?? 0}</strong></header>
          <div className="testnet-table-wrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Side</th><th>State</th><th>Qty</th><th>Paper source</th></tr>
              </thead>
              <tbody>
                {(status?.openIntents ?? []).length === 0 ? (
                  <tr><td colSpan={5}>No active live mirror intents.</td></tr>
                ) : status!.openIntents!.map((intent) => (
                  <tr key={intent.paperOrderId}>
                    <td>{intent.symbol}</td>
                    <td>{intent.direction}</td>
                    <td>{intent.state}</td>
                    <td>{intent.qty}</td>
                    <td>{intent.paperOrderId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="testnet-panel">
          <header><span>Engine Notes</span><strong>{status?.health?.errorStreak ?? 0} errors</strong></header>
          {(status?.reconcileIssues ?? []).length === 0 && !status?.reason && (status?.configErrors ?? []).length === 0 ? (
            <p className="testnet-empty">No live mirror warnings visible.</p>
          ) : (
            <ul className="testnet-note-list">
              {status?.reason ? <li>{status.reason}</li> : null}
              {(status?.configErrors ?? []).map((item) => <li key={item}>{item}</li>)}
              {(status?.reconcileIssues ?? []).slice(-6).map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
