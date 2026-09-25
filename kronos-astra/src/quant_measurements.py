"""Pure, versioned market measurements. No orders, model, network or fitted alpha.

All windows end on verified closed, contiguous candles. Regime labels are a
descriptive heuristic, never statistical edge or an entry gate.
"""
import hashlib
import json
import math
import statistics as stats

METHOD = 'CLOSED_CANDLE_QUANT_SNAPSHOT_V1'
WINDOW = 60
MIN_PAIRS = 30


def finite(x):
    return type(x) in (int, float) and math.isfinite(x)


def closed_window(row, at):
    step = row.get('intervalMs', 300000)
    if not finite(step) or step <= 0:
        return [], 'INVALID_INTERVAL'
    supplied = row.get('candles') or []
    bars = [c for c in supplied if finite(c.get('closeTime')) and c['closeTime'] < at]
    if not bars:
        return [], 'NO_CLOSED_CANDLES'
    stamps = [c['closeTime'] for c in bars]
    if stamps != sorted(set(stamps)):
        return [], 'DUPLICATE_OR_UNORDERED_CANDLES'
    bars = bars[-(WINDOW+1):]
    if at-bars[-1]['closeTime'] > step+5000:
        return [], 'STALE_CANDLES'
    for i, c in enumerate(bars):
        if (not all(finite(c.get(k)) for k in ('open','high','low','close','volume'))
                or min(c['open'],c['high'],c['low'],c['close']) <= 0 or c['volume'] < 0
                or not c['low'] <= min(c['open'],c['close']) <= max(c['open'],c['close']) <= c['high']):
            return [], 'INVALID_OHLCV'
        if i and c['closeTime']-bars[i-1]['closeTime'] != step:
            return [], 'CANDLE_GAP'
    return bars, None


def returns(bars):
    return {(a['closeTime'],b['closeTime']): math.log(b['close']/a['close'])
            for a,b in zip(bars,bars[1:])}


def pair_measurement(bars, benchmark):
    x, y = returns(benchmark), returns(bars)
    keys = sorted(x.keys() & y.keys())[-WINDOW:]
    result = {'beta':None,'correlation':None,'n':len(keys),'reason':None}
    if len(keys) < MIN_PAIRS:
        return {**result,'reason':'INSUFFICIENT_ALIGNED_RETURNS'}
    xs, ys = [x[k] for k in keys], [y[k] for k in keys]
    mx, my = stats.mean(xs), stats.mean(ys)
    vx, vy = sum((v-mx)**2 for v in xs), sum((v-my)**2 for v in ys)
    if vx <= 1e-24 or vy <= 1e-24:
        return {**result,'reason':'ZERO_RETURN_VARIANCE'}
    cov = sum((a-mx)*(b-my) for a,b in zip(xs,ys))
    return {**result,'beta':cov/vx,'correlation':max(-1,min(1,cov/math.sqrt(vx*vy))),
            'firstReturnStart':keys[0][0],'lastReturnEnd':keys[-1][1]}


def measure(row, at, benchmark_rows=()):
    bars, error = closed_window(row, at)
    features = {k:None for k in ('momentum20Bps','sma20','sma60','atrSma14Bps',
                 'realizedVol20BpsPerBar','efficiency20','zscore20','vwap20','volumeRatio20',
                 'breakoutAbovePrior20','breakoutBelowPrior20','regime')}
    result = {'method':METHOD,'symbol':row.get('symbol'),'intervalMs':row.get('intervalMs',300000),
              'cutoff':at,'lastClosedCandleAt':bars[-1]['closeTime'] if bars else None,
              'closedBarsN':len(bars),'status':'UNAVAILABLE' if error else 'MEASURED',
              'reason':error,'features':features,'benchmarks':{},
              'execution':execution_measurement(row,at),
              'regimeMeaning':'DESCRIPTIVE_HEURISTIC_NOT_A_VALIDATED_EDGE_OR_TRADING_GATE'}
    if error:
        return result
    closes = [c['close'] for c in bars]
    if len(bars) >= 21:
        win = closes[-20:]
        lr = list(returns(bars[-21:]).values())
        sd = stats.pstdev(win)
        features.update(momentum20Bps=(closes[-1]/closes[-21]-1)*10000,
                        sma20=stats.mean(win), realizedVol20BpsPerBar=stats.stdev(lr)*10000,
                        zscore20=(closes[-1]-stats.mean(win))/sd if sd else None,
                        efficiency20=abs(sum(lr))/sum(abs(r) for r in lr) if any(lr) else 0,
                        breakoutAbovePrior20=closes[-1] > max(c['high'] for c in bars[-21:-1]),
                        breakoutBelowPrior20=closes[-1] < min(c['low'] for c in bars[-21:-1]))
        volumes = [c['volume'] for c in bars[-21:-1]]
        features['volumeRatio20'] = bars[-1]['volume']/stats.mean(volumes) if sum(volumes)>0 else None
        vwin = bars[-20:]
        if all(finite(c.get('quoteVolume')) and c['quoteVolume'] >= 0 for c in vwin) and sum(c['volume'] for c in vwin)>0:
            features['vwap20'] = sum(c['quoteVolume'] for c in vwin)/sum(c['volume'] for c in vwin)
    if len(bars) >= 15:
        tr = [max(b['high']-b['low'],abs(b['high']-a['close']),abs(b['low']-a['close']))
              for a,b in zip(bars[-15:],bars[-14:])]
        features['atrSma14Bps'] = stats.mean(tr)/closes[-1]*10000
    if len(bars) >= 60:
        features['sma60'] = stats.mean(closes[-60:])
        efficiency = features['efficiency20']
        features['regime'] = ('RANGE' if efficiency is not None and efficiency < .25 else
            'UPWARD_STRUCTURE' if features['sma20'] > features['sma60'] and features['momentum20Bps']>0 else
            'DOWNWARD_STRUCTURE' if features['sma20'] < features['sma60'] and features['momentum20Bps']<0 else 'UNCLEAR')
    else:
        result.update(status='PARTIAL',reason='INSUFFICIENT_60_BAR_WINDOW')
    for reference in benchmark_rows:
        b, issue = closed_window(reference, at)
        p = pair_measurement(bars,b) if not issue and reference.get('intervalMs',300000)==result['intervalMs'] else {
            'beta':None,'correlation':None,'n':0,'reason':issue or 'INTERVAL_MISMATCH'}
        if not issue and len(bars)>=21 and len(b)>=21 and [c['closeTime'] for c in bars[-21:]]==[c['closeTime'] for c in b[-21:]]:
            p['relativeStrength20Bps'] = features['momentum20Bps']-(b[-1]['close']/b[-21]['close']-1)*10000
        else:
            p['relativeStrength20Bps'] = None
        result['benchmarks'][reference['symbol']] = p
    result['inputHash'] = hashlib.sha256(json.dumps(bars,sort_keys=True,allow_nan=False).encode()).hexdigest()
    return result


def execution_measurement(row, at):
    book=row.get('book') or {}
    good=(all(finite(book.get(k)) for k in ('bid','ask','time'))
          and 0<book['bid']<=book['ask'] and 0<=at-book['time']<=5000)
    funding=(row.get('economics') or {}).get('funding') or {}
    stamp=funding.get('observedAt')
    rate = funding.get('lastFundingRate', funding.get('rate'))
    funding_good=(funding.get('status')=='INDICATIVE' and finite(rate)
                  and finite(stamp) and 0<=at-stamp<=120000)
    return {'bookStatus':'MEASURED' if good else 'STALE_OR_MISSING_BOOK',
            'bookAt':book.get('time'),'bid':book.get('bid') if good else None,
            'ask':book.get('ask') if good else None,
            'spreadBps':(book['ask']-book['bid'])/((book['ask']+book['bid'])/2)*10000 if good else None,
            'indicativeFundingRate':rate if funding_good else None,
            'fundingAt':stamp,'fundingMeaning':'INDICATIVE_NOT_GUARANTEED_NEXT_PAYMENT',
            'allInModeledCostBps':None,'costReason':'REQUIRES_PLAN_ALLOWANCES_AND_VERIFIED_ACCOUNT_FEES'}


def portfolio_exposure(status, rows, at):
    """Actual owned positions only, never assume missing account data means flat."""
    if not isinstance(status.get('active'),list) or status.get('environment')!='testnet':
        return {'status':'UNKNOWN','reason':'VERIFIED_POSITION_STATE_NOT_SUPPLIED','grossNotionalUsd':None,'netNotionalUsd':None}
    # A gateway snapshot age must be supplied before treating exposure as current.
    stamp = status.get('observedAt')
    if not finite(stamp) or not 0 <= at-stamp <= 120000:
        return {'status':'UNKNOWN','reason':'POSITION_STATE_FRESHNESS_UNVERIFIED','grossNotionalUsd':None,'netNotionalUsd':None}
    gross=net=0
    for p in status['active']:
        row = next((r for r in rows if r['symbol']==p.get('symbol')), {})
        b = row.get('book') or {}
        if (not finite(p.get('qty')) or p['qty']<=0 or p.get('side') not in ('LONG','SHORT')
                or not all(finite(b.get(k)) for k in ('bid','ask','time'))
                or not 0 <= at-b['time'] <= 5000 or not 0<b['bid']<=b['ask']):
            return {'status':'UNKNOWN','reason':'POSITION_OR_MARKET_DATA_INCOMPLETE','grossNotionalUsd':None,'netNotionalUsd':None}
        n=p['qty']*(b['bid']+b['ask'])/2
        gross+=n
        net+=n*(1 if p['side']=='LONG' else -1)
    return {'status':'MEASURED','positionsN':len(status['active']),'grossNotionalUsd':gross,'netNotionalUsd':net,
            'meaning':'MIDPOINT_MARKED_GROSS_AND_NET_EXPOSURE_NOT_WORST_CASE_LOSS'}
