"""Deterministic attention only. Sampled quotes are NOT closed-candle alpha."""
import bisect
import copy
import hashlib
import json
import math
import statistics

VERSION='DYNAMIC_CANDIDATE_SCORE_V1'
INTERVAL_MS=180000
MAX_SCAN_AGE_MS=300000
MAX_QUOTE_AGE_MS=180000
RETENTION_MS=7200000
POSITIVE={'emergingMomentum':1,'momentumAcceleration':1,'trendAlignment':1,
          'breakoutProximity':1,'compression':1,'volumeExpansion':1,
          'relativeStrengthImprovement':1,'meanReversionSetupQuality':1,'liquidityQuality':1}
NEGATIVE={'overextension':1,'wideSpread':1,'poorLiquidity':1}

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def num(value):
    return type(value) in (float,int) and math.isfinite(value)

def before(history,at):
    rows=[r for r in history if r['at']<=at and at-r['at']<=INTERVAL_MS]
    return rows[-1] if rows else None

def features(history,btc,at):
    out={k:None for k in (*POSITIVE,*NEGATIVE)}
    current=history[-1];price=current['mid'];old=before(history,at-INTERVAL_MS)
    older=before(history,at-2*INTERVAL_MS);h9=before(history,at-3*INTERVAL_MS)
    h30=before(history,at-10*INTERVAL_MS)
    ret=lambda a,b:math.log(a['mid']/b['mid'])*10000 if a and b else None
    r3=ret(current,old);prev=ret(old,older);r9=ret(current,h9);r30=ret(current,h30)
    if r3 is not None:out['emergingMomentum']=abs(r3)
    if r3 is not None and prev is not None:out['momentumAcceleration']=max(0,abs(r3)-abs(prev))
    if all(v is not None for v in (r3,r9,r30)):
        out['trendAlignment']=float(r3*r9>0 and r9*r30>0)
    short=[r['mid'] for r in history if at-3*INTERVAL_MS<=r['at']<at]
    long=[r['mid'] for r in history if at-10*INTERVAL_MS<=r['at']<at]
    if h9 and len(short)>=3 and max(short)>min(short):
        out['breakoutProximity']=max(0,1-min(abs(price-max(short)),abs(price-min(short)))/(max(short)-min(short)))
    if h30 and len(long)>=10 and max(long)>min(long):
        out['compression']=max(0,1-(max(short)-min(short))/(max(long)-min(long))) if short else None
        sd=statistics.pstdev(long);mean=statistics.mean(long)
        if sd>0:
            z=(price-mean)/sd;out['overextension']=abs(z)
            if old:
                previous_z=(old['mid']-mean)/sd
                out['meanReversionSetupQuality']=max(0,abs(previous_z)-abs(z)) if abs(previous_z)>=1 else 0
    bnow=before(btc,at);bprev=before(btc,at-INTERVAL_MS);bolder=before(btc,at-2*INTERVAL_MS)
    br3=ret(bnow,bprev);brprev=ret(bprev,bolder)
    if all(v is not None for v in (r3,prev,br3,brprev)):
        out['relativeStrengthImprovement']=max(0,abs(r3-br3)-abs(prev-brprev))
    depth=current.get('depth');volume=current.get('volume24h')
    if num(depth) and num(volume) and depth>=0 and volume>0:
        out['liquidityQuality']=math.log1p(depth)+math.log1p(volume)
        out['poorLiquidity']=1/(1+depth)
    out['wideSpread']=current['spreadBps']
    # Difference of rolling 24h volume is not interval traded volume.
    return out

def observe(overview,previous,at):
    if (overview.get('source')!='BINANCE_USDM_TESTNET'
            or overview.get('status',{}).get('environment')!='testnet'):
        raise ValueError('Unverified Testnet overview')
    universe=overview.get('universe')
    if (not isinstance(universe,list) or not universe or len(set(universe))!=len(universe)
            or any(not isinstance(s,str) or not s.endswith('USDT') for s in universe)):
        raise ValueError('Invalid complete universe')
    previous=previous or {}
    if previous and previous.get('methodVersion')!=VERSION:raise ValueError('Scorer version migration required')
    if previous and at<=previous['observedAt']:raise ValueError('Non-increasing scan time')
    rows=overview.get('overview',[])
    if not isinstance(rows,list) or len({r['symbol'] for r in rows})!=len(rows):raise ValueError('Duplicate overview row')
    indexed={r['symbol']:r for r in rows};history={};accepted={};excluded={}
    for symbol in sorted(universe):
        r=indexed.get(symbol,{});b=r.get('book') or {};reasons=[]
        if not all(num(b.get(k)) for k in ('bid','ask','time')) or not 0<b.get('bid',0)<=b.get('ask',0):
            reasons.append('MISSING_OR_INVALID_EXECUTABLE_BOOK')
        elif not 0<=at-b['time']<=MAX_QUOTE_AGE_MS:reasons.append('STALE_OR_FUTURE_BOOK')
        hist=[h for h in previous.get('history',{}).get(symbol,[]) if at-RETENTION_MS<=h['at']<at]
        history[symbol]=hist
        if reasons:excluded[symbol]=reasons;continue
        mid=(b['bid']+b['ask'])/2;depth=None
        if all(num(b.get(k)) and b[k]>=0 for k in ('bidQty','askQty')):
            depth=min(b['bid']*b['bidQty'],b['ask']*b['askQty'])
        # Never re-sample an unchanged cached book as independent time-series data.
        item={'at':b['time'],'mid':mid,'depth':depth,'spreadBps':(b['ask']-b['bid'])/mid*10000,
              'volume24h':r.get('quoteVolume24h') if r.get('statsFresh') is True else None}
        if not hist or item['at']>hist[-1]['at']:hist.append(item)
        elif item['at']<hist[-1]['at']:excluded[symbol]=['OUT_OF_ORDER_BOOK'];continue
        elif item['mid']!=hist[-1]['mid'] or item['spreadBps']!=hist[-1]['spreadBps']:
            excluded[symbol]=['CONFLICTING_BOOK_AT_SAME_TIMESTAMP'];continue
        if not hist:excluded[symbol]=['NO_VALID_OBSERVATION'];continue
        if r.get('unavailableForNewEntry') is True:
            excluded[symbol]=['HOST_PROVISIONALLY_UNAVAILABLE'];continue
        accepted[symbol]={'symbol':symbol,'quoteAt':b['time'],'sampleN':len(hist)}
    btc=history.get('BTCUSDT',[])
    raw={s:features(history[s],btc,history[s][-1]['at']) for s in accepted}
    distributions={k:sorted(f[k] for f in raw.values() if num(f[k])) for k in (*POSITIVE,*NEGATIVE)}
    prior_ranked={r['symbol']:r for r in previous.get('ranked',[])}
    ranked=[]
    for s,row in accepted.items():
        f=raw[s];ranks={}
        for k,value in f.items():
            values=distributions[k]
            # Equal values get equal ranks; missing components never get an imputed measurement.
            ranks[k]=(0 if value==0 else (bisect.bisect_left(values,value)+bisect.bisect_right(values,value))/(2*len(values))) if num(value) else None
        score=100*(sum(ranks[k]*w for k,w in POSITIVE.items() if ranks[k] is not None)/sum(POSITIVE.values())
                   -.25*sum(ranks[k]*w for k,w in NEGATIVE.items() if ranks[k] is not None)/sum(NEGATIVE.values()))
        old=prior_ranked.get(s);comparable=[k for k in f if old and num(f[k]) and num(old['components'].get(k))]
        # Own measured state, not rank drift caused solely by other symbols.
        delta=sum(abs(f[k]-old['components'][k])/(abs(f[k])+abs(old['components'][k])+1e-12) for k in comparable)/len(comparable) if comparable else None
        ranked.append({**row,'score':round(score,8),'stateChange':delta,'components':f,'componentRanks':ranks,
                       'unknownComponents':[k for k,v in f.items() if v is None],
                       'status':'WARMING_UP' if f['trendAlignment'] is None else 'MEASURED_QUOTE_PROXIES',
                       'volumeExpansionStatus':'UNKNOWN_ROLLING_24H_IS_NOT_INTERVAL_VOLUME'})
    ranked.sort(key=lambda r:(-r['score'],r['symbol']))
    source={'source':overview['source'],'universe':universe,'overview':rows,'at':overview.get('at')}
    state={'methodVersion':VERSION,'observedAt':at,'sourceHash':digest(source),'universe':sorted(universe),
           'history':history,'ranked':ranked,'excluded':excluded,
           'meaning':'ATTENTION_PRIORITY_ONLY_NOT_ALPHA_OR_EXECUTION_PERMISSION',
           'featureMethod':'SAMPLED_EXECUTABLE_MID_QUOTES_3_9_30_MIN_NOT_CLOSED_CANDLES',
           'stateChangeMethod':'MEAN_BOUNDED_RELATIVE_CHANGE_OF_COMPARABLE_RAW_COMPONENTS',
           'weights':{'positive':POSITIVE,'negative':NEGATIVE,'negativeMultiplier':.25}}
    state['rankingHash']=digest({'at':at,'sourceHash':state['sourceHash'],'ranked':ranked})
    return state

def select(state,coverage,at,exclude_symbols=()):
    if state.get('methodVersion')!=VERSION or not 0<=at-state['observedAt']<=MAX_SCAN_AGE_MS:
        raise ValueError('Dynamic candidate scan unavailable or stale')
    last={}
    for j in coverage.get('jobs',{}).values():
        if j.get('outcome') is not None:
            for s in j.get('symbols',[]):last[s]=max(last.get(s,0),j['at'])
    rows=[r for r in state['ranked'] if r['symbol'] not in set(exclude_symbols)];picked=[];used=set()
    def add(row,slot):
        used.add(row['symbol']);picked.append({'symbol':row['symbol'],'slot':slot,'score':row['score'],
            'stateChange':row['stateChange'],'sampleN':row['sampleN'],'status':row['status'],
            'components':copy.deepcopy(row['components']),'unknownComponents':row['unknownComponents']})
    for r in rows[:4]:add(r,'TOP_SCORE')
    changed=sorted((r for r in rows if r['symbol'] not in used and r['stateChange'] is not None),
                   key=lambda r:(-r['stateChange'],-r['score'],r['symbol']))
    if changed and changed[0]['stateChange']>0:add(changed[0],'BIGGEST_STATE_CHANGE')
    else:
        remaining=sorted((r for r in rows if r['symbol'] not in used),key=lambda r:(last.get(r['symbol'],0),r['symbol']))
        if remaining:add(remaining[0],'EXPLORATION_NO_MEASURED_STATE_CHANGE')
    remaining=sorted((r for r in rows if r['symbol'] not in used),key=lambda r:(last.get(r['symbol'],0),r['symbol']))
    if remaining:add(remaining[0],'EXPLORATION')
    return {'methodVersion':VERSION,'rankingHash':state['rankingHash'],'sourceHash':state['sourceHash'],
            'observedAt':state['observedAt'],'selectedAt':at,'universeN':len(state['universe']),
            'eligibleN':len(rows),'excludedN':len(state['excluded']),'selected':picked,
            'separatelyMonitoredSymbols':sorted(set(exclude_symbols)),
            'meaning':state['meaning'],'featureMethod':state['featureMethod']}
