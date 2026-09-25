"""Offline empirical slippage. No network, orders, fitted alpha or silent pooling.

SELL uses referenceBid/fillVWAP - 1 by explicit contract. Sample unit is a
terminal exchange order, never an individual fill. Protocol gates are exploratory
data-sufficiency safeguards, not proof of calibration or profitability.
"""
import copy
import hashlib
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation

METHOD = 'EXECUTABLE_QUOTE_VWAP_SELL_FILL_DENOM_V1'
BUCKET_METHOD = 'PRE_SUBMIT_BUCKETS_V1'
PROTOCOL = {'maxQuoteAgeMs': 5000, 'minOrders': 30, 'minUtcDays': 5,
            'tailQuantile': .90, 'bootstrapIterations': 500, 'seed': 20260912,
            'historyWindowMs': 90*86400000}
FIXED = ('environment','laneId','executionPath','executionVersion','side','orderType','timeInForce')
LEVELS = (('SYMBOL_FULL',('symbol','notionalBucket','spreadBucket','volatilityBucket')),
          ('SYMBOL_SIDE_ORDER',('symbol',)),
          ('LIQUIDITY_SIDE_ORDER',('liquidityBucket',)))


def digest(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def number(value):
    if isinstance(value,bool) or value is None: return None
    try:
        d=Decimal(str(value))
        return d if d.is_finite() and math.isfinite(float(d)) else None
    except (ValueError,InvalidOperation,OverflowError): return None


def valid_id(value):
    return isinstance(value,(str,int)) and not isinstance(value,bool) and str(value) not in ('','None')


def bucket(value, edges):
    n=number(value)
    if n is None or n<0: return None
    return next((str(i) for i,e in enumerate(edges) if n<Decimal(str(e))),str(len(edges)))


def inspect_order(observation, as_of, protocol=PROTOCOL):
    """Validate all accounting/chronology before calculating any price statistic."""
    if number(as_of) is None or number(as_of)<=0: raise ValueError('Invalid asOf')
    o=observation
    if not isinstance(o,dict): return {'eligible':False,'orderId':None,'reasons':['MALFORMED_OBSERVATION']}
    if o.get('schemaStatus') in ('UNKNOWN_UNSUPPORTED_SCHEMA','UNKNOWN_MALFORMED_SCHEMA'):
        return {'eligible':False,'orderId':o.get('orderId'),'reasons':[o['schemaStatus']]}
    if 'schemaVersion' in o and o['schemaVersion']!='ASTRA_EXECUTION_PROVENANCE_V1':
        return {'eligible':False,'orderId':o.get('orderId'),'reasons':['UNKNOWN_UNSUPPORTED_SCHEMA']}
    reasons=[]
    q=o.get('preSubmitQuote')
    if not isinstance(q,dict): q={}
    submit, terminal, accounting = [number(o.get(k)) for k in ('submittedAt','terminalAt','accountingAsOf')]
    qt,bid,ask=[number(q.get(k)) for k in ('time','bid','ask')]
    if o.get('environment')!='testnet' or o.get('laneId')!='ASTRA_HERMES_TESTNET': reasons.append('WRONG_ENVIRONMENT_OR_OWNERSHIP')
    if not valid_id(o.get('orderId')) or not o.get('symbol'): reasons.append('MISSING_ORDER_IDENTITY')
    if o.get('side') not in ('BUY','SELL'): reasons.append('UNKNOWN_SIDE')
    if o.get('orderType') not in ('LIMIT','MARKET','STOP_MARKET','TAKE_PROFIT_MARKET','STOP','TAKE_PROFIT'):
        reasons.append('UNKNOWN_ORDER_TYPE')
    if o.get('executionPath') not in ('ENTRY','NORMAL_EXIT'): reasons.append('NONREPRESENTATIVE_OR_UNKNOWN_EXECUTION_PATH')
    if o.get('finalState') not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'): reasons.append('UNKNOWN_OR_NONTERMINAL_ORDER_STATE')
    if o.get('fillAccountingComplete') is not True: reasons.append('INCOMPLETE_FILL_ACCOUNTING')
    if None in (submit,terminal,accounting) or min(submit or 0,terminal or 0,accounting or 0)<=0:
        reasons.append('MISSING_LIFECYCLE_TIMESTAMPS')
    elif not submit<=terminal<=accounting<=Decimal(str(as_of)):
        reasons.append('INVALID_OR_FUTURE_LIFECYCLE_TIMESTAMPS')
    if qt is None or bid is None or ask is None or not 0<bid<=ask:
        reasons.append('MISSING_OR_INVALID_PRE_SUBMIT_QUOTE')
    elif submit is not None:
        if qt>submit: reasons.append('QUOTE_AFTER_SUBMIT')
        elif submit-qt>protocol['maxQuoteAgeMs']: reasons.append('STALE_QUOTE')
    fills=o.get('fills')
    ids=set(); qty=Decimal(0); notion=Decimal(0); times=[]
    if not isinstance(fills,list) or not fills: reasons.append('NO_FILL_ACCOUNTING')
    else:
        for f in fills:
            if not isinstance(f,dict): reasons.append('INVALID_FILL'); continue
            key=f.get('tradeId')
            fq,fp,ft=[number(f.get(k)) for k in ('qty','price','time')]
            if (not valid_id(key) or str(key) in ids or str(f.get('orderId'))!=str(o.get('orderId'))
                    or f.get('symbol')!=o.get('symbol') or f.get('side',o.get('side'))!=o.get('side')
                    or None in (fq,fp,ft) or min(fq or 0,fp or 0,ft or 0)<=0):
                reasons.append('INVALID_DUPLICATE_OR_UNMATCHED_FILL'); continue
            ids.add(str(key)); qty+=fq; notion+=fq*fp; times.append(ft)
        if times and submit is not None and terminal is not None and not submit<=min(times)<=max(times)<=terminal:
            reasons.append('FILL_OUTSIDE_ORDER_LIFECYCLE')
    executed=number(o.get('executedQty')); requested=number(o.get('requestedQty'))
    if executed is None or executed<=0: reasons.append('NO_EXECUTED_QUANTITY')
    elif qty!=executed: reasons.append('EXECUTED_QUANTITY_MISMATCH')
    if requested is None or requested<=0 or (executed is not None and executed>requested): reasons.append('INVALID_REQUESTED_QUANTITY')
    if o.get('finalState')=='FILLED' and executed!=requested: reasons.append('FILLED_ORDER_QUANTITY_MISMATCH')
    if o.get('finalState')=='REJECTED' and executed is not None and executed>0: reasons.append('REJECTED_ORDER_WITH_FILLS')
    if reasons: return {'eligible':False,'reasons':sorted(set(reasons)),'orderId':o.get('orderId')}
    vwap=notion/qty
    ref=ask if o['side']=='BUY' else bid
    slip=(vwap/ref-1 if o['side']=='BUY' else ref/vwap-1)*10000
    spread=(ask-bid)/((ask+bid)/2)*10000
    context=o.get('preSubmitContext')
    if not isinstance(context,dict): context={}
    stamp=number(context.get('time'))
    context_ok=stamp is not None and 0<=submit-stamp<=120000
    vol=context.get('volatilityBpsPerBar') if context_ok else None
    liquidity=context.get('liquidityBucket') if context_ok and context.get('liquidityMethodVersion') else None
    conditioning={k:o.get(k) for k in FIXED}
    conditioning.update(symbol=o['symbol'],notionalBucket=bucket(requested*ref,(10,25,50,100,250)),
                        spreadBucket=bucket(spread,(1,3,10,30)),volatilityBucket=bucket(vol,(5,15,40,100)),
                        liquidityBucket=(str(context['liquidityMethodVersion'])+':'+str(liquidity)) if liquidity else None)
    return {'eligible':True,'reasons':[],'orderId':o['orderId'],'conditioning':conditioning,
            'slippageBps':float(slip),'fillVWAP':float(vwap),'referencePrice':float(ref),
            'quoteAgeMs':float(submit-qt),'timeToFirstFillMs':float(min(times)-submit),
            'timeToFinalFillMs':float(max(times)-submit),'fillCount':len(fills),
            'filledNotional':float(notion),'requestedReferenceNotional':float(requested*ref),
            'finalFillAt':int(max(times)),'accountingAsOf':int(accounting),
            'methodVersion':METHOD,'bucketMethodVersion':BUCKET_METHOD}


def audit(observations, as_of, protocol=PROTOCOL):
    groups=defaultdict(list)
    for i,o in enumerate(observations):
        key=tuple(str(o.get(k)) for k in ('environment','laneId','symbol','orderId')) if isinstance(o,dict) and valid_id(o.get('orderId')) else ('UNIDENTIFIED',str(i))
        groups[key].append(o)
    results=[]; duplicates=0
    for key,group in groups.items():
        duplicates+=len(group)-1
        # Exact retries deduplicate. Conflicting snapshots are quarantined instead
        # of selecting the convenient version or inflating the sample denominator.
        if any(x!=group[0] for x in group[1:]):
            results.append({'eligible':False,'orderId':group[0].get('orderId'),'reasons':['CONFLICTING_ORDER_OBSERVATIONS']})
        else: results.append(inspect_order(group[0],as_of,protocol))
    reasons=Counter(r for x in results for r in x['reasons'])
    eligible=sum(x['eligible'] for x in results)
    complete=sum(r['eligible'] and all(r['conditioning'].get(k) not in (None,'','UNKNOWN') for k in FIXED) for r in results)
    return {'observations':results,'dataCoverage':{'totalRecords':len(observations),'duplicateRecords':duplicates,
            'totalObservations':len(results),'eligible':eligible,'excluded':len(results)-eligible,
            'executionScopeComplete':complete,'executionScopeIncomplete':eligible-complete,
            'exclusionReasons':dict(sorted(reasons.items())),
            'meaning':'ORDER_LEVEL; REASON_COUNTS_MAY_OVERLAP; ELIGIBLE_DOES_NOT_MEAN_CALIBRATED'}}


def quantile(values, p):
    values=sorted(values); rank=(len(values)-1)*p; lo=int(rank); hi=math.ceil(rank)
    return values[lo]+(values[hi]-values[lo])*(rank-lo)


def estimate(observations, query, as_of, protocol=PROTOCOL):
    if isinstance(as_of,bool) or not isinstance(as_of,(int,float)) or not math.isfinite(as_of) or as_of<=0: raise ValueError('Invalid asOf')
    for key in ('minOrders','minUtcDays','bootstrapIterations','seed','maxQuoteAgeMs','historyWindowMs'):
        if type(protocol.get(key)) is not int: raise ValueError('Protocol requires integer '+key)
    if (protocol['minOrders']<30 or protocol['minUtcDays']<5 or protocol['tailQuantile'] not in (.9,.95)
            or protocol['bootstrapIterations']<100 or protocol['maxQuoteAgeMs']<=0 or protocol['historyWindowMs']<=0):
        raise ValueError('Invalid protocol or weakened minimum safeguards')
    audited=audit(observations,as_of,protocol)
    eligible=[r for r in audited['observations'] if r['eligible']]
    out={'status':'UNKNOWN_INSUFFICIENT_SAMPLE','expectedBps':None,'medianBps':None,'upperBoundBps':None,
         'upperBoundType':'EMPIRICAL_P90' if protocol['tailQuantile']==.9 else 'EMPIRICAL_P95','sampleN':0,'observationWindow':None,
         'conditioning':None,'requestedConditioning':copy.deepcopy(query),'fallbackTrace':[],
         'methodVersion':METHOD,'bucketMethodVersion':BUCKET_METHOD,'evidenceAsOf':as_of,
         'protocol':copy.deepcopy(protocol),'protocolHash':digest(protocol),
         'quoteAgeMs':None,'uncertainty':None,'dataCoverage':audited['dataCoverage'],
         'confidence':None,'meaning':'EMPIRICAL_EXECUTION_COST_NOT_ALPHA_OR_GUARANTEED_MAXIMUM'}
    if (any(query.get(k) in (None,'','UNKNOWN') for k in FIXED)
            or query['environment']!='testnet' or query['laneId']!='ASTRA_HERMES_TESTNET'):
        return {**out,'reason':'MISSING_OR_UNSUPPORTED_EXECUTION_CONDITIONING'}
    base=[r for r in eligible if all(r['conditioning'].get(k)==query[k] for k in FIXED)
          and as_of-protocol['historyWindowMs']<=r['finalFillAt']<=as_of]
    out['dataCoverage'].update(scopeMatched=len(base),outsideScopeOrWindow=len(eligible)-len(base))
    for label,keys in LEVELS:
        if any(query.get(k) in (None,'','UNKNOWN') for k in keys):
            out['fallbackTrace'].append({'level':label,'status':'MISSING_CONDITIONING'}); continue
        rows=[r for r in base if all(r['conditioning'].get(k)==query[k] for k in keys)]
        days=defaultdict(list)
        for r in rows: days[r['finalFillAt']//86400000].append(r['slippageBps'])
        n=len(rows)
        out['fallbackTrace'].append({'level':label,'sampleN':n,'utcDaysN':len(days)})
        if n>out['sampleN']:
            out.update(sampleN=n,observationWindow={'firstFillAt':min(r['finalFillAt'] for r in rows),
                       'lastFillAt':max(r['finalFillAt'] for r in rows),'utcDaysN':len(days)})
        if n<protocol['minOrders'] or len(days)<protocol['minUtcDays']: continue
        values=[r['slippageBps'] for r in rows]
        rng=random.Random(protocol['seed']); blocks=[days[k] for k in sorted(days)]
        means=[]; tails=[]
        for _ in range(protocol['bootstrapIterations']):
            sample=[v for _ in blocks for v in rng.choice(blocks)]
            means.append(statistics.mean(sample)); tails.append(quantile(sample,protocol['tailQuantile']))
        dropped=[k for k in LEVELS[0][1] if k not in keys]
        return {**out,'status':'ESTIMATED','sampleN':n,'confidence':'LOW_EXPLORATORY',
                'expectedBps':statistics.mean(values),'medianBps':statistics.median(values),
                'upperBoundBps':quantile(values,protocol['tailQuantile']),
                'conditioning':{'level':label,'matched':{k:query[k] for k in FIXED+keys},'droppedDimensions':dropped},
                'observationWindow':{'firstFillAt':min(r['finalFillAt'] for r in rows),'lastFillAt':max(r['finalFillAt'] for r in rows),'utcDaysN':len(days)},
                'quoteAgeMs':{'median':statistics.median(r['quoteAgeMs'] for r in rows),'max':max(r['quoteAgeMs'] for r in rows)},
                'uncertainty':{'method':'UTC_DAY_CLUSTER_BOOTSTRAP_PERCENTILE_95','iterations':protocol['bootstrapIterations'],
                               'meanIntervalBps':[quantile(means,.025),quantile(means,.975)],
                               'tailIntervalBps':[quantile(tails,.025),quantile(tails,.975)],
                               'caveats':['APPROXIMATE_NOT_COVERAGE_VALIDATED','DAYS_ASSUMED_EXCHANGEABLE','NO_FORWARD_CALIBRATION','CONDITIONAL_ON_EXECUTED_ORDERS_NOT_FILL_PROBABILITY']}}
    return {**out,'reason':'NO_DECLARED_LEVEL_MEETS_ORDER_AND_DAY_MINIMUMS'}
