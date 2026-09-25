"""Frozen, offline archetype probes; NOT the discretionary Astra execution policy.

Next-bar-open entry, fixed 12-bar exit, no overlapping episodes per symbol/probe.
No parameters are optimized, no order path is imported, no lesson is promoted.
Costs are explicit round-trip scenarios, NOT observed account commissions/funding.
"""
import hashlib
import json
import math
from pathlib import Path
from quant_measurements import measure, finite

PROTOCOL = {
    'version':'P1_P2_P3_DIAGNOSTIC_PROBES_V1', 'intervalMs':300000,'warmupBars':61,'holdBars':12,
    'split':'first 60 percent calibration; final 40 percent chronological holdout',
    'entry':'next bar open after closed-candle signal','exit':'open 12 bars after entry',
    'P1':'SMA20 above SMA60 and positive momentum20 => LONG; inverse => SHORT',
    'P2':'close above previous 20 highs => LONG; below previous 20 lows => SHORT',
    'P3':'efficiency20 < 0.25 and zscore20 <= -2 => LONG; zscore20 >= 2 => SHORT',
    'costScenariosBps':[15,30],
    'costMeaning':'ASSUMED aggregate round-trip fees/slippage/funding buffer, not actual accounting',
    'primaryPolicyMatch':False,'autoPromotion':False,
    'limitation':'No stop/target/order-book replay. Fixed-hold probe is not V4 position-management performance.'}


def signal(name, f):
    if name=='P1' and all(finite(f.get(k)) for k in ('sma20','sma60','momentum20Bps')):
        return 1 if f['sma20']>f['sma60'] and f['momentum20Bps']>0 else -1 if f['sma20']<f['sma60'] and f['momentum20Bps']<0 else 0
    if name=='P2':
        return 1 if f.get('breakoutAbovePrior20') is True else -1 if f.get('breakoutBelowPrior20') is True else 0
    if name=='P3' and finite(f.get('efficiency20')) and f['efficiency20']<.25 and finite(f.get('zscore20')):
        return 1 if f['zscore20']<=-2 else -1 if f['zscore20']>=2 else 0
    return 0


def replay(row, cutoff):
    if row.get('intervalMs')!=PROTOCOL['intervalMs']:
        raise ValueError('Protocol is fixed to 5m; another interval is a different experiment')
    bars=[c for c in row.get('candles',[]) if finite(c.get('closeTime')) and c['closeTime']<cutoff]
    if len(bars)<100:
        return {'status':'INSUFFICIENT_HISTORY','episodes':[],'symbol':row['symbol']}
    for i,c in enumerate(bars):
        if (not finite(c.get('openTime')) or c['closeTime']-c['openTime']!=299999
                or i and c['openTime']!=bars[i-1]['openTime']+300000):
            raise ValueError('History must be ordered, unique and contiguous')
        if measure({**row,'candles':bars[max(0,i-60):i+1]},c['closeTime']+1)['status']=='UNAVAILABLE':
            raise ValueError('Invalid historical OHLCV')
    boundary=int(len(bars)*.6)
    next_free={p:60 for p in ('P1','P2','P3')}
    episodes=[]
    purged=0
    for i in range(60,len(bars)-13):
        f=measure({**row,'candles':bars[i-60:i+1]},bars[i]['closeTime']+1)['features']
        for p in next_free:
            if i<next_free[p]: continue
            side=signal(p,f)
            if not side: continue
            entry_i,exit_i=i+1,i+13
            next_free[p]=exit_i
            # An outcome cannot cross the calibration/holdout boundary.
            if i<boundary<=exit_i:
                purged+=1
                continue
            entry,exit=bars[entry_i]['open'],bars[exit_i]['open']
            gross=side*(exit/entry-1)*10000
            episodes.append({'symbol':row['symbol'],'probe':p,'split':'HOLDOUT' if i>=boundary else 'CALIBRATION',
                'signalAt':bars[i]['closeTime'],'entryAt':bars[entry_i]['openTime'],'exitAt':bars[exit_i]['openTime'],
                'side':'LONG' if side==1 else 'SHORT','entryReference':entry,'exitReference':exit,
                'grossReferenceBps':gross,'modelNetBps':{str(cost):gross-cost for cost in PROTOCOL['costScenariosBps']},
                'realizedPnl':None,'outcomeType':'HYPOTHETICAL_FIXED_HOLD_NOT_AN_EXCHANGE_TRADE'})
    return {'symbol':row['symbol'],'status':'DIAGNOSTIC_ONLY','barsN':len(bars),
            'holdoutStart':bars[boundary]['openTime'],'purgedBoundaryEpisodes':purged,'episodes':episodes}


def metrics(episodes,cost):
    nets=[r['modelNetBps'][str(cost)] for r in episodes]
    wins=sum(x for x in nets if x>0); losses=-sum(x for x in nets if x<0)
    return {'n':len(nets),'modelExpectancyBps':sum(nets)/len(nets) if nets else None,
            'modelProfitFactor':wins/losses if losses else None,
            'profitFactorReason':None if losses else 'NO_LOSSES_OR_NO_OBSERVATIONS',
            'positiveOutcomeRate':sum(x>0 for x in nets)/len(nets) if nets else None,
            'calendarDaysN':len({r['entryAt']//86400000 for r in episodes}),
            'confidenceInterval':None,'uncertaintyReason':'No independently validated block-bootstrap confidence estimate yet',
            'estimatedCurrentEdgeBps':None,'edgeStatus':'UNVALIDATED_DIAGNOSTIC_ONLY'}


def report(raw):
    if raw.get('source')!='BINANCE_USDM_TESTNET':
        raise ValueError('Expected recorded Testnet source')
    rows=[replay(r,raw['collectionFinishedAt']) for r in raw['rows']]
    episodes=[e for r in rows for e in r['episodes']]
    summaries=[]
    for probe in ('P1','P2','P3'):
        for split in ('CALIBRATION','HOLDOUT'):
            selected=[e for e in episodes if e['probe']==probe and e['split']==split]
            summaries.append({'probe':probe,'split':split,'costScenarios':{str(c):metrics(selected,c) for c in PROTOCOL['costScenariosBps']}})
    return {'protocol':PROTOCOL,'protocolHash':hashlib.sha256(json.dumps(PROTOCOL,sort_keys=True).encode()).hexdigest(),
            'rows':rows,'summaries':summaries,'estimatedEdgeAvailableToAstra':False,
            'eligibility':'RESEARCH_ONLY; no promotion and no canonical realized-trade evidence'}


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('input',type=Path); p.add_argument('output',type=Path)
    args=p.parse_args()
    result=report(json.loads(args.input.read_text()))
    with args.output.open('x') as stream: json.dump(result,stream,indent=2,allow_nan=False)
    print(json.dumps(result['summaries']))
