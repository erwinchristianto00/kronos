"""Context-only Quant contract. No strategy promotion, execution or assumed fees."""
from quant_measurements import finite, measure, portfolio_exposure, closed_window, METHOD
from portfolio_attribution import completeness

VERSION = 'QUANT_CONTEXT_V2'
LANE = 'ASTRA_HERMES_TESTNET'


def fresh(stamp, at, ttl):
    return finite(stamp) and 0 <= at-stamp <= ttl


def quality(fields, at, reasons=(), invalid=False):
    completeness = {k: v is not None for k, v in fields.items()}
    missing = [k + ':UNKNOWN' for k, present in completeness.items() if not present]
    why = sorted(set(list(reasons) + missing))
    return {'status': 'INVALID' if invalid else 'DEGRADED' if why else 'GOOD',
            'reasons': why, 'timestamp': at, 'fieldCompleteness': completeness}


def cost_context(row, at, trusted):
    econ = row.get('economics') or {}
    fee = econ.get('commission') or {}
    ok = (trusted and fee.get('source') == 'TESTNET_ACCOUNT_SYMBOL_COMMISSION_RATE'
          and fee.get('status') == 'AVAILABLE' and fresh(fee.get('observedAt'), at, 900000))
    # Account/symbol rate, not an assumed VIP tier or a realized historical fee.
    maker = fee.get('makerRate') if ok and finite(fee.get('makerRate')) and -1 < fee['makerRate'] < 1 else None
    taker = fee.get('takerRate') if ok and finite(fee.get('takerRate')) and 0 <= fee['takerRate'] < 1 else None
    execution = measure(row, at)['execution']
    funding = econ.get('funding') or {}
    rate = funding.get('lastFundingRate', funding.get('rate'))
    funding_ok = (trusted and funding.get('status') == 'INDICATIVE'
                  and fresh(funding.get('observedAt'), at, 60000)
                  and fresh(funding.get('exchangeTime'), at, 120000)
                  and finite(funding.get('nextFundingTime')) and funding['nextFundingTime'] > at
                  and finite(rate))
    forecast = ({'rate': rate, 'nextFundingTime': funding['nextFundingTime'],
                 'longCostBps': rate*10000, 'shortCostBps': -rate*10000,
                 'meaning': 'ONE_SETTLEMENT_IF_RATE_UNCHANGED_AND_POSITION_HELD_THROUGH_SETTLEMENT'}
                if funding_ok else None)
    fields = {'makerFee': maker, 'takerFee': taker,
              'executableSpreadBps': execution['spreadBps'], 'fundingEstimate': forecast,
              'slippageEstimate': None, 'estimationBounds': None}
    return {**fields, 'feeUnit': 'FRACTION_OF_EXECUTED_NOTIONAL_PER_FILL',
            'feeSource': 'VERIFIED_TESTNET_GATEWAY_ACCOUNT_SYMBOL_COMMISSION' if ok else None,
            'feeAsOf': fee.get('observedAt') if ok else None,
            'spreadAsOf': execution['bookAt'],
            'fundingAsOf': funding.get('observedAt') if funding_ok else None,
            'slippageReason': 'NO_SIZE_CONDITIONED_DEPTH_OR_CALIBRATED_FILL_MODEL',
            'boundsReason': 'BBO_DOES_NOT_BOUND_MARKET_IMPACT_OR_FUTURE_FUNDING',
            'allInCostBps': None,
            'dataQuality': quality(fields, at)}


def market_context(row, at, references):
    current = fresh(row.get('observedAt'), at, 120000)
    m = measure(row, at, references) if current else {}
    f, b = m.get('features', {}), m.get('benchmarks', {})
    bars, _ = closed_window(row, at) if current else ([], None)
    btc, eth = b.get('BTCUSDT', {}), b.get('ETHUSDT', {})
    trend = None
    if f.get('sma20') is not None and f.get('sma60') is not None:
        trend = {'sma20': f['sma20'], 'sma60': f['sma60'], 'efficiency20': f['efficiency20'],
                 'meaning': 'DESCRIPTIVE_NOT_ENTRY_SIGNAL'}
    breakout = ('UPSIDE' if f.get('breakoutAbovePrior20') else 'DOWNSIDE'
                if f.get('breakoutBelowPrior20') else 'INSIDE_PRIOR_RANGE') if f.get('breakoutAbovePrior20') is not None else None
    fields = {'trend': trend, 'momentum': f.get('momentum20Bps'),
              'volatility': ({'realized20BpsPerBar': f.get('realizedVol20BpsPerBar'),
                              'atr14Bps': f.get('atrSma14Bps')} if f.get('atrSma14Bps') is not None and f.get('realizedVol20BpsPerBar') is not None else None),
              'breakoutState': breakout,
              'meanReversionState': ({'zscore20': f['zscore20'], 'meaning': 'DISPLACEMENT_NOT_REVERSAL_PROBABILITY'} if f.get('zscore20') is not None else None),
              'funding': m.get('execution', {}).get('indicativeFundingRate'),
              'spread': m.get('execution', {}).get('spreadBps'),
              'btcBeta': btc.get('beta'), 'ethBeta': eth.get('beta'),
              'btcCorrelation': btc.get('correlation'), 'ethCorrelation': eth.get('correlation'),
              'regime': f.get('regime')}
    reasons = [] if current else ['STALE_OR_MISSING_OBSERVATION']
    if m.get('reason'): reasons.append(m['reason'])
    for symbol, result in b.items():
        if result.get('reason'): reasons.append(symbol + ':' + result['reason'])
    return {**fields, 'methodVersion': METHOD, 'asOf': row.get('observedAt'),
            'dataWindow': {'intervalMs': m.get('intervalMs'), 'barsN': m.get('closedBarsN'),
                           'end': m.get('lastClosedCandleAt'),
                           'start': bars[0]['closeTime'] if bars else None},
            'benchmarkEvidence': b, 'units': {'momentum': 'BPS_OVER_20_BARS', 'spread': 'BPS', 'funding': 'RATE'},
            'dataQuality': quality(fields, at, reasons, not current or m.get('status') == 'UNAVAILABLE')}


def portfolio_context(status, rows, markets, at):
    trusted = status.get('laneId') == LANE and status.get('environment') == 'testnet'
    active = status.get('active')
    if isinstance(active, list) and active:
        ids = [p.get('id') if isinstance(p,dict) else None for p in active]
        trusted = trusted and all(isinstance(i,str) and i for i in ids) and len(set(ids)) == len(ids) and all(p.get('laneId', LANE) == LANE for p in active)
    exposure = portfolio_exposure(status, rows, at) if trusted else {'status': 'UNKNOWN', 'reason': 'OWNERSHIP_UNVERIFIED'}
    good = exposure.get('status') == 'MEASURED'
    positions = status.get('active') if good else None
    fields = {'ownedPositions': None, 'grossExposure': exposure.get('grossNotionalUsd'),
              'netExposure': exposure.get('netNotionalUsd'), 'directionalBeta': None,
              'symbolConcentration': None, 'sectorConcentration': None, 'strategyConcentration': None}
    if good:
        owned, totals = [], {}
        beta_usd = 0.0
        betas_complete = True
        for p in positions:
            r = next(r for r in rows if r['symbol'] == p['symbol'])
            notional = p['qty']*(r['book']['bid']+r['book']['ask'])/2
            totals[p['symbol']] = totals.get(p['symbol'], 0) + notional
            beta = markets.get(p['symbol'], {}).get('btcBeta')
            betas_complete = betas_complete and finite(beta)
            if finite(beta): beta_usd += notional * (1 if p['side'] == 'LONG' else -1) * beta
            owned.append({k: p.get(k) for k in ('id','symbol','side','qty')})
        gross = fields['grossExposure']
        fields.update(ownedPositions=owned, symbolConcentration={s: n/gross for s,n in totals.items()} if gross else {})
        # Units explicitly BTC-equivalent dollars; not portfolio beta to wallet equity.
        if betas_complete:
            fields['directionalBeta'] = {'btcEquivalentNotionalUsd': beta_usd,
                                        'signedBetaPerGrossDollar': beta_usd/gross if gross else None}
        if not positions:
            fields.update(sectorConcentration={}, strategyConcentration={})
    reasons = [] if good else [exposure.get('reason', 'POSITION_STATE_UNKNOWN')]
    if good and positions:
        reasons.extend(['SECTOR_TAXONOMY_NOT_VERIFIED', 'STRATEGY_VERSION_ATTRIBUTION_NOT_VERIFIED'])
    attribution=completeness(status,rows,at,markets)
    # Compatibility fields retain null for UNKNOWN; the versioned completeness
    # contract carries explicit status, coverage, missing exposure and reasons.
    fields['symbolConcentration']=attribution['bySymbol']['concentration']
    fields['sectorConcentration']=attribution['bySector']['concentration']
    fields['strategyConcentration']=attribution['byStrategy']['concentration']
    fields['sideConcentration']=attribution['bySide']['concentration']
    fields['betaBucketConcentration']=attribution['byBetaBucket']['concentration']
    return {**fields, **attribution, 'scope': LANE, 'asOf': status.get('observedAt'),
            'source': 'GATEWAY_OWNED_LEDGER_NOT_ACCOUNT_WIDE_EXCHANGE_RECONCILIATION',
            'units': {'grossExposure': 'USD_MIDPOINT_NOTIONAL', 'netExposure': 'SIGNED_USD_MIDPOINT_NOTIONAL',
                      'concentration': 'FRACTION_OF_GROSS_NOTIONAL'},
            'dataQuality': quality(fields, at, reasons)}


def snapshot(raw, at):
    status = dict(raw.get('status') or {})
    if raw.get('source') != 'BINANCE_USDM_TESTNET' or status.get('environment') != 'testnet':
        raise ValueError('Quant snapshot requires Testnet source')
    # Source response time, not the later worker preparation timestamp.
    if 'observedAt' not in status:
        status['observedAt'] = raw.get('at')
    rows = raw.get('rows') or []
    refs = {r['symbol']: r for r in raw.get('quantReferences', []) if r.get('symbol') in ('BTCUSDT','ETHUSDT')}
    refs.update({r['symbol']: r for r in rows if r.get('symbol') in ('BTCUSDT','ETHUSDT')})
    references = [r for r in refs.values() if fresh(r.get('observedAt'), at, 120000)]
    markets = {r['symbol']: market_context(r, at, references) for r in rows}
    portfolio = portfolio_context(status, rows, markets, at)
    out = []
    for row in rows:
        market = markets[row['symbol']]
        cost = cost_context(row, at, status.get('laneId') == LANE)
        # No registry promotion path exists yet. Never trust row/model-provided PF,
        # labels, or unknown-scope evidence. Research remains a separate artifact.
        evidence = {'strategyId': None, 'version': None,
                    'scope': {'symbol': row['symbol'], 'regime': market['regime'], 'intervalMs': market['dataWindow']['intervalMs']},
                    'evidenceStatus': 'MARKET_STATE_ONLY', 'sampleN': None,
                    'grossExpectancy': None, 'netExpectancy': None, 'profitFactor': None,
                    'uncertainty': None, 'evidenceAsOf': None, 'methodVersion': None, 'dataWindow': None,
                    'notes': ['NO_VERIFIED_STRATEGY_VERSION_SCOPE_EVIDENCE', 'MEASUREMENTS_ARE_NOT_ALPHA']}
        dq = quality({**{'marketContext.'+k: True if ok else None for k,ok in market['dataQuality']['fieldCompleteness'].items()},
                      **{'costContext.'+k: True if ok else None for k,ok in cost['dataQuality']['fieldCompleteness'].items()},
                      **{'portfolioContext.'+k: True if ok else None for k,ok in portfolio['dataQuality']['fieldCompleteness'].items()}}, at,
                     market['dataQuality']['reasons'] + cost['dataQuality']['reasons'] + portfolio['dataQuality']['reasons'],
                     market['dataQuality']['status'] == 'INVALID')
        out.append({'symbol': row['symbol'], 'dataQuality': dq, 'marketContext': market,
                    'costContext': cost, 'strategyEvidence': evidence})
    return {'methodVersion': VERSION, 'asOf': at, 'rows': out, 'portfolioContext': portfolio,
            'referenceStatus': raw.get('quantReferenceStatus'),
            'meaning': 'MARKET_CONTEXT_NOT_ALPHA; UNKNOWN_IS_NOT_ZERO; NO_AUTOMATIC_ENTRY_SIGNAL'}
