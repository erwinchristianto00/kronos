import { useEffect, useState } from 'react';

export interface MarketRegimeDisplay {
  source: 'CANONICAL_MARKET_REGIME';
  capturedAt: string | null;
  maxAgeMs: number;
  freshness: string;
  projection: 'BULLISH' | 'BEARISH' | 'MIXED' | null;
  confidence: number | null;
  validSymbolCount: number;
  requiredSymbolCount: number;
  reason: string | null;
}

export default function MarketRegimeCard({ snapshot }: { snapshot?: MarketRegimeDisplay }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const capturedMs = snapshot?.capturedAt ? Date.parse(snapshot.capturedAt) : NaN;
  const ageMs = Math.max(now, Date.now()) - capturedMs;
  const available = snapshot?.source === 'CANONICAL_MARKET_REGIME'
    && snapshot.freshness !== 'UNAVAILABLE' && Number.isFinite(ageMs) && ageMs >= 0;
  const fresh = available && snapshot.freshness === 'FRESH' && ageMs <= snapshot.maxAgeMs;
  const label = fresh && snapshot.projection
    ? { BULLISH: 'Bullish', BEARISH: 'Bearish', MIXED: 'Mixed' }[snapshot.projection]
    : available ? 'Stale market data' : 'Market data unavailable';
  return <div>
    <span>Regime</span>
    <strong>{label}</strong>
    <small>Market engine · {fresh ? 'Fresh' : available ? 'Stale' : 'Unavailable'}</small>
    {snapshot && <small>{snapshot.validSymbolCount}/{snapshot.requiredSymbolCount} symbols
      {fresh && snapshot.confidence != null ? ` · ${Math.round(snapshot.confidence * 100)}% confidence` : ''}</small>}
    {Number.isFinite(capturedMs) && <small>Updated <time dateTime={snapshot!.capturedAt!}>
      {new Date(capturedMs).toLocaleString()}
    </time></small>}
    {!available && <small>{snapshot?.reason ?? 'Waiting for market engine data'}</small>}
  </div>;
}
