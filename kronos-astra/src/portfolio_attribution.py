"""Ledger-scoped attribution completeness, never model-inferred taxonomy/strategy.

No account-wide ownership claim and no automatic promotion of metadata. Until a
verified host registry exists, strategy and sector remain explicitly unattributed.
"""
from collections import Counter
from quant_measurements import finite

VERSION='PORTFOLIO_ATTRIBUTION_COMPLETENESS_V1'
LANE='ASTRA_HERMES_TESTNET'


def completeness(status, rows, at, markets=None):
    active=status.get('active')
    fresh=finite(status.get('observedAt')) and 0<=at-status['observedAt']<=120000
    verified=status.get('environment')=='testnet' and status.get('laneId')==LANE and fresh
    available=isinstance(active,list)
    positions=active if available else []
    ids=Counter(p.get('id') for p in positions if isinstance(p,dict) and isinstance(p.get('id'),str))
    records=[]
    for index,p in enumerate(positions):
        p=p if isinstance(p,dict) else {}
        identity=verified and isinstance(p.get('id'),str) and bool(p['id']) and ids[p['id']]==1 and p.get('laneId',LANE)==LANE
        valid=identity and isinstance(p.get('symbol'),str) and bool(p['symbol']) and p.get('side') in ('LONG','SHORT') and finite(p.get('qty')) and p['qty']>0
        candidates=[r for r in rows if isinstance(r,dict) and r.get('symbol')==p.get('symbol')]
        b=candidates[0].get('book') if len(candidates)==1 else None
        b=b if isinstance(b,dict) else {}
        priced=valid and all(finite(b.get(k)) for k in ('bid','ask','time')) and 0<b['bid']<=b['ask'] and 0<=at-b['time']<=5000
        notional=p['qty']*(b['bid']+b['ask'])/2 if priced else None
        beta=(markets or {}).get(p.get('symbol'),{}).get('btcBeta') if isinstance(p.get('symbol'),str) else None
        beta_bucket=('NEGATIVE' if beta<0 else 'ZERO_TO_LT_ONE' if beta<1 else 'ONE_OR_MORE') if finite(beta) and valid else None
        records.append({'index':index,'positionId':p.get('id'),'symbol':p.get('symbol'),'side':p.get('side'),
            'betaBucket':beta_bucket,
            'ownershipStatus':'LEDGER_ATTRIBUTED_NOT_EXCHANGE_RECONCILED' if identity else 'UNKNOWN_OWNERSHIP',
            'notionalUsd':notional,'valuationStatus':'MEASURED' if priced else 'UNKNOWN_VALUATION',
            'sectorStatus':'UNKNOWN_INCOMPLETE_ATTRIBUTION','strategyStatus':'UNKNOWN_INCOMPLETE_ATTRIBUTION',
            'sectorReason':'NO_VERIFIED_VERSIONED_TAXONOMY',
            'strategyReason':'NO_VERIFIED_POSITION_STRATEGY_VERSION_BINDING'})
    n=len(records) if available else None
    valued=[r for r in records if r['notionalUsd'] is not None]
    known=sum(r['notionalUsd'] for r in valued)
    valuation_complete=verified and available and len(valued)==len(records)
    total=known if valuation_complete else None
    def dimension(name):
        assigned=[r for r in records if r['ownershipStatus'].startswith('LEDGER_ATTRIBUTED') and (
                  name=='owner' or (name=='symbol' and isinstance(r['symbol'],str) and bool(r['symbol'])) or
                  (name=='side' and r['side'] in ('LONG','SHORT')) or (name=='betaBucket' and r['betaBucket'] is not None))]
        assigned_n=len(assigned) if available else None
        assigned_value=sum(r['notionalUsd'] for r in assigned if r['notionalUsd'] is not None)
        complete=verified and available and len(assigned)==len(records)
        state=('COMPLETE' if complete and valuation_complete else
               'PARTIAL' if assigned and verified else 'UNKNOWN_INCOMPLETE_ATTRIBUTION')
        groups={}
        for r in assigned:
            if r['notionalUsd'] is not None:
                key=LANE if name=='owner' else r[name]
                groups[key]=groups.get(key,0)+r['notionalUsd']
        return {'status':state,'positionsN':n,'attributedPositionsN':assigned_n,
            'unattributedPositionsN':n-assigned_n if available else None,
            'countCoverage':assigned_n/n if n and verified else None,
            'attributedKnownNotionalUsd':assigned_value if verified and available else None,
            'unattributedKnownNotionalUsd':known-assigned_value if verified and available else None,
            'notionalCoverage':assigned_value/total if total else None,
            'attributedExposurePct':100*assigned_value/total if total else None,
            'unattributedExposurePct':100*(total-assigned_value)/total if total else None,
            'knownGroupNotionalUsd':groups if verified and available else None,
            'concentration':({k:v/total for k,v in groups.items()} if total else {}) if complete and valuation_complete else None,
            'denominator':'TOTAL_OWNED_LEDGER_GROSS_NOTIONAL_NOT_ATTRIBUTED_SUBSET'}
    dimensions={k:dimension(k) for k in ('owner','symbol','side','sector','strategy','betaBucket')}
    # Joint attribution requires every requested dimension. No verified sector or
    # strategy binding is available yet; never infer either from a model label.
    empty=valuation_complete and n==0
    unknown_reasons=Counter(reason for r in records for reason in (
        ['NO_VERIFIED_VERSIONED_TAXONOMY','NO_VERIFIED_POSITION_STRATEGY_VERSION_BINDING']+
        (['UNKNOWN_BETA'] if r['betaBucket'] is None else [])+
        (['UNKNOWN_OWNERSHIP'] if not r['ownershipStatus'].startswith('LEDGER_ATTRIBUTED') else [])+
        (['UNKNOWN_VALUATION'] if r['notionalUsd'] is None else [])))
    inventory_reasons=[]
    if not available: inventory_reasons.append('POSITION_INVENTORY_UNAVAILABLE')
    if not verified: inventory_reasons.append('SOURCE_OWNERSHIP_OR_FRESHNESS_UNVERIFIED')
    return {'schemaVersion':VERSION,'scope':LANE,'source':'GATEWAY_OWNED_LEDGER',
        'attributionStatus':'COMPLETE' if empty else 'UNKNOWN_INCOMPLETE_ATTRIBUTION',
        'attributedExposurePct':0 if total else None,'unattributedExposurePct':100 if total else None,
        'percentageBasis':'ALL_REQUESTED_DIMENSIONS_JOINTLY; PERCENT_0_TO_100; NULL_IF_DENOMINATOR_UNKNOWN_OR_ZERO',
        'concentrationGuard':{'maxUnattributedExposurePct':0,'scope':'PER_DIMENSION',
            'requiresCompleteValuation':True,'meaning':'DISPLAY_EVIDENCE_GUARD_NOT_TRADING_RISK_POLICY'},
        'byStrategy':dimensions['strategy'],'bySymbol':dimensions['symbol'],'bySide':dimensions['side'],
        'bySector':dimensions['sector'],'byBetaBucket':dimensions['betaBucket'],
        'betaBucketMethodVersion':'BTC_BETA_SIGN_UNIT_BOUNDARIES_V1',
        'unknownPositions':{'count':n,'notional':total,'knownNotionalSubtotal':known if verified and available else None,
            'reasons':dict(unknown_reasons),'inventoryReasons':inventory_reasons},
        'exchangeOwnershipVerification':'UNKNOWN_NOT_ACCOUNT_WIDE_RECONCILED',
        'positionsN':n,'valuedPositionsN':len(valued) if available else None,
        'unvaluedPositionsN':len(records)-len(valued) if available else None,
        'knownGrossNotionalUsd':known if verified and available else None,'totalGrossNotionalUsd':total,
        'valuationStatus':'COMPLETE' if valuation_complete else 'UNKNOWN_INCOMPLETE_VALUATION',
        'byOwner':dimensions['owner'],'records':records,
        'notes':['POSITION_LABELS_AND_MODEL_RATIONALES_ARE_NOT_VERIFIED_ATTRIBUTION',
                 'MISSING_NOTIONAL_IS_NOT_ZERO','EMPTY_PORTFOLIO_COVERAGE_IS_NOT_100_PERCENT']}
