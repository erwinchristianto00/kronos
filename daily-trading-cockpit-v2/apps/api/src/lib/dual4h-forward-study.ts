import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {MomentumBar, MomentumFeature} from './daily-momentum4h.js';
import {momentumExitNetPct} from './daily-momentum4h-exit.js';
import {DUAL4H_IMPROVEMENT, dualExecutionBlock} from './dual4h-improvement.js';

type Outcome = {arm: number; peak: number | null; floor: number | null; exitAt: number | null;
  reason: string | null; netPct: number | null; netUsd: number | null};
export type StudyRow = {
  id: string; cohort: string; feature: MomentumFeature; observedAt: number;
  authority: 'SIGNAL_ONLY_NO_ORDER'; route: string; status: 'WAITING_QUOTE'|'OPEN'|'CLOSED'|'NO_FILL';
  entryAt: number | null; entry: number | null; qty: number | null; deadline: number | null;
  stop: number | null; target: number | null; lastQuoteAt: number | null; lastSourceAt: number | null;
  gaps: string[]; pendingExit: string | null; variants: Outcome[];
};

/** Public-market forward proxies. Deliberately has no private client/order API.
 * Each entry has three identical-price paths and independent exits. All variants
 * continue until their own exit, even after the baseline would have closed.
 */
export class Dual4hForwardStudy {
  readonly rows: StudyRow[] = [];
  private lastSave = 0;
  private lastMarketQuoteAt: number | null = null;
  private dirty = false;
  constructor(private file: string, private now: () => number = Date.now) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.policyId === DUAL4H_IMPROVEMENT.id && Array.isArray(data.rows)) this.rows.push(...data.rows);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.markGap('PROCESS_RESTART');
  }
  observe(feature: MomentumFeature, cohort: string): void {
    if (!feature.dual || this.now() < feature.decisionTime || this.now() - feature.decisionTime > 95000) return;
    const id = `${cohort}:${feature.dual.family}:${feature.symbol}:${feature.dual.sourceBoundary}`;
    if (this.rows.some(row => row.id === id)) return;
    this.rows.push({id, cohort, feature: structuredClone(feature), observedAt: this.now(),
      authority: 'SIGNAL_ONLY_NO_ORDER', route: cohort === 'BASELINE_V1' ? 'BASELINE_SHADOW_ONLY' : dualExecutionBlock(feature) ?? 'TESTNET_CANDIDATE_NOT_FILL',
      status: 'WAITING_QUOTE', entryAt: null, entry: null, qty: null, deadline: null, stop: null, target: null,
      lastQuoteAt: null, lastSourceAt: null, gaps: [], pendingExit: null,
      variants: DUAL4H_IMPROVEMENT.shadowArmNetPct.map(arm => ({arm, peak: null, floor: null, exitAt: null, reason: null, netPct: null, netUsd: null}))});
    this.dirty = true;
    this.flush(true); // Persist observation before any quote can create a proxy fill.
  }
  markGap(reason: string): void {
    for (const row of this.rows) if (row.status === 'OPEN') {
      if (!row.gaps.includes(reason)) row.gaps.push(reason);
      this.dirty = true;
    }
  }
  advanceTime(now: number, candles: Record<string, MomentumBar[]>): void {
    for (const row of this.rows) {
      if (row.status === 'WAITING_QUOTE' && now - row.feature.decisionTime > 95000) {
        row.status = 'NO_FILL'; this.dirty = true;
      }
      if (row.status !== 'OPEN') continue;
      if (now - row.lastQuoteAt! > 60000 && !row.gaps.includes('QUOTE_GAP_OVER_60S')) {
        row.gaps.push('QUOTE_GAP_OVER_60S'); this.dirty = true;
      }
      const f = row.feature, sign = f.direction === 'LONG' ? 1 : -1;
      if (!row.pendingExit && f.dual?.exitKind === 'THESIS_12H' &&
        (candles[f.symbol] ?? []).some(b => b.closeTime >= row.entryAt! && b.closeTime < now && sign * (b.close - f.dual!.thesisLevel) < 0)) {
        row.pendingExit = 'STRUCTURE_INVALIDATION'; this.dirty = true;
      }
    }
  }
  quote(symbol: string, bid: number, ask: number, sourceAt: number, receivedAt: number): void {
    const now = this.now();
    if (![bid, ask, sourceAt, receivedAt].every(Number.isFinite) || bid <= 0 || ask < bid || now < receivedAt ||
      now - receivedAt > 5000 || receivedAt - sourceAt > 5000 || sourceAt - receivedAt > 1000) return;
    this.lastMarketQuoteAt=now;
    for (const row of this.rows) {
      if (row.feature.symbol !== symbol || !['OPEN','WAITING_QUOTE'].includes(row.status) || sourceAt < row.observedAt || sourceAt < (row.lastSourceAt ?? 0)) continue;
      const f = row.feature, sign = f.direction === 'LONG' ? 1 : -1;
      if (row.status === 'WAITING_QUOTE') {
        if (now - f.decisionTime > 95000) {row.status = 'NO_FILL'; this.dirty = true; continue;}
        if ((ask-bid)/((ask+bid)/2) > .001) continue;
        const entry = (sign > 0 ? ask : bid) * (1 + sign * .0005);
        if (Math.abs(entry/f.close-1) > .005) continue;
        if (f.dual?.improvementId && f.dual.family === 'MOMENTUM' &&
          (!f.dual.confirmationLevel || sign*(entry-f.dual.confirmationLevel) <= 0 || sign*(entry-f.dual.confirmationLevel)/entry > (f.dual.stopPct??2)/100*.5)) continue;
        row.entry = entry; row.entryAt = now;
        row.qty = Math.min(25/entry, .25/(entry*((f.dual?.stopPct??2)/100+.002+f.fundingRateReserve)));
        row.stop = entry*(1-sign*(f.dual?.stopPct??2)/100);
        row.target = f.dual?.targetR == null ? null : entry+sign*f.dual.targetR*Math.abs(entry-row.stop);
        row.deadline = now+(f.dual?.maxHoldHours??12)*3600000;
        row.status = 'OPEN';
      }
      if (row.lastQuoteAt !== null && now-row.lastQuoteAt > 60000 && !row.gaps.includes('QUOTE_GAP_OVER_60S')) row.gaps.push('QUOTE_GAP_OVER_60S');
      row.lastQuoteAt = now; row.lastSourceAt = sourceAt;
      const quote = sign > 0 ? bid : ask;
      const net = momentumExitNetPct(row.entry!, quote, f.direction, f.fundingRateReserve);
      for (const v of row.variants) {
        if (v.exitAt !== null) continue;
        v.peak = Math.max(v.peak ?? -Infinity, net);
        if (v.peak >= v.arm-1e-9) v.floor = Math.max(v.floor ?? -Infinity, Math.floor((v.peak*.5+1e-9)/.05)*.05);
        const reason = sign*(quote-row.stop!) <= 0 ? 'STOP_PROXY' :
          row.target !== null && sign*(quote-row.target) >= 0 ? 'TP_PROXY' :
          row.pendingExit ?? (now >= row.deadline! ? 'TIME_CAP_PROXY' :
          v.floor !== null && net <= v.floor+1e-9 ? 'GIVEBACK_PROXY' : null);
        if (reason) {v.exitAt = now; v.reason = reason; v.netPct = net; v.netUsd = net/100*row.entry!*row.qty!;}
      }
      if (row.variants.every(v => v.exitAt !== null)) row.status = 'CLOSED';
      this.dirty = true;
    }
    this.flush();
  }
  flush(force = false): void {
    if (!this.dirty || (!force && this.now()-this.lastSave < 5000)) return;
    mkdirSync(dirname(this.file), {recursive:true});
    writeFileSync(this.file+'.tmp', JSON.stringify({policyId:DUAL4H_IMPROVEMENT.id, updatedAt:this.now(), rows:this.rows}));
    renameSync(this.file+'.tmp',this.file); this.lastSave=this.now(); this.dirty=false;
  }
  status() {
    const groups: Record<string,{pairedClosed:number;netUsd:Record<string,number>}> = {};
    for (const row of this.rows) if (row.status === 'CLOSED' && row.gaps.length === 0) {
      const key = `${row.cohort}:${row.feature.dual!.family}:${row.feature.dual!.exitKind}`;
      const g = groups[key] ??= {pairedClosed:0,netUsd:{}}; g.pairedClosed++;
      for (const v of row.variants) g.netUsd[String(v.arm)] = (g.netUsd[String(v.arm)]??0)+v.netUsd!;
    }
    return {policyId:DUAL4H_IMPROVEMENT.id, mode:'PUBLIC_BBO_FORWARD_PROXY_NO_ORDERS',
      lastMarketQuoteAt:this.lastMarketQuoteAt, armNetPct:DUAL4H_IMPROVEMENT.shadowArmNetPct, feeBpsRoundTrip:10, slippageBpsPerSide:5,
      funding:'FROZEN_CONSERVATIVE_RESERVE_NOT_REALIZED_FUNDING', quantity:'CONTINUOUS_RISK_SIZED_NO_EXCHANGE_LOT_FILTER',
      limitations:'Mainnet public quotes; no Testnet fill, liquidity, capacity or portfolio simulation. Paired complete gap-free rows only. No automatic promotion.',
      observations:this.rows.length, open:this.rows.filter(r=>r.status==='OPEN').length,
      noFill:this.rows.filter(r=>r.status==='NO_FILL').length, incomplete:this.rows.filter(r=>r.gaps.length>0).length,
      pairedClosed:this.rows.filter(r=>r.status==='CLOSED'&&!r.gaps.length).length,groups};
  }
}
