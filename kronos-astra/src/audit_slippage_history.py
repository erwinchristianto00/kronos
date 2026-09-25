"""Read-only Testnet gateway audit; immutable local evidence, no order route."""
import argparse
import json
import subprocess
from pathlib import Path
from slippage_estimator import audit, estimate, digest, METHOD, PROTOCOL

REMOTE = '''cd /opt/kronos-astra/runtime && python3 -B -c 'import json,time; import astra_runner as e; s=e.gateway("/status"); print(json.dumps({"environment":s.get("environment"),"laneId":s.get("laneId"),"capturedAt":int(time.time()*1000),"closed":s.get("closed",[]),"active":s.get("active",[])}))' '''

SUPPORTED_SCHEMA='ASTRA_EXECUTION_PROVENANCE_V1'
VERSION_KEYS=('schemaVersion','executionSchemaVersion','provenanceVersion')


def schema_status(handle):
    """Absent envelope alone is legacy. Never downgrade an unknown envelope."""
    if 'execution' not in handle:
        return 'UNKNOWN_UNSUPPORTED_SCHEMA' if any(k in handle for k in VERSION_KEYS) else 'LEGACY'
    record=handle['execution']
    if not isinstance(record,dict): return 'UNKNOWN_MALFORMED_SCHEMA'
    if record.get('schemaVersion')!=SUPPORTED_SCHEMA: return 'UNKNOWN_UNSUPPORTED_SCHEMA'
    for scope in (handle,record):
        if any(scope[k]!=SUPPORTED_SCHEMA for k in VERSION_KEYS if k in scope):
            return 'UNKNOWN_UNSUPPORTED_SCHEMA'
    required=('environment','laneId','orderIntentId','symbol','side','orderType','timeInForce','executionPath','executionVersion','requestedQty')
    if any(k not in record for k in required): return 'UNKNOWN_MALFORMED_SCHEMA'
    if any(not isinstance(record[k],str) or not record[k] for k in required if k!='requestedQty'):
        return 'UNKNOWN_MALFORMED_SCHEMA'
    for key in ('preSubmit','submit','execution','fills'):
        if not isinstance(record.get(key),dict): return 'UNKNOWN_MALFORMED_SCHEMA'
    if not isinstance(record['fills'].get('raw'),list) or 'slippageStatus' not in record['execution']:
        return 'UNKNOWN_MALFORMED_SCHEMA'
    return 'SUPPORTED'


def normalize(source):
    if source.get('environment')!='testnet' or source.get('laneId')!='ASTRA_HERMES_TESTNET':
        raise ValueError('Only owned Testnet source accepted')
    observations=[]
    for trade in source['closed']+source['active']:
        handles=[('ENTRY',trade.get('entry') or {})]+[('NORMAL_EXIT',x) for x in trade.get('exits',[])]
        known={str(h.get('order',{}).get('orderId')) for _,h in handles}
        # Retain fills whose handles are missing in the denominator, never infer a
        # terminal order state from a fill alone (native stops may be in this set).
        orphan_ids={str(f.get('orderId')) for f in trade.get('fills',[])}-known
        handles += [('UNKNOWN_EXIT',{'order':{'orderId':oid}}) for oid in sorted(orphan_ids)]
        for path,h in handles:
            order=h.get('order') or {}
            schema=schema_status(h)
            if schema.startswith('UNKNOWN_'):
                observations.append({'environment':source['environment'],'laneId':source['laneId'],
                    'sourceTradeId':trade.get('id'),'sourceTradeHash':digest(trade),
                    'orderId':order.get('orderId'),'orderIntentId':h.get('clientId'),
                    'symbol':trade.get('symbol'),'schemaStatus':schema,'slippageStatus':schema,
                    'provenanceNotes':['QUARANTINED_NO_LEGACY_FALLBACK']})
                continue
            record=h.get('execution') or {}
            if schema=='SUPPORTED':
                pre=record['preSubmit']; sub=record['submit']; ex=record['execution']
                mapped={'NORMAL_ENTRY':'ENTRY','NORMAL_EXIT':'NORMAL_EXIT'}.get(record['executionPath'],record['executionPath'])
                observations.append({'environment':record['environment'],'laneId':record['laneId'],
                    'sourceTradeId':trade.get('id'),'sourceTradeHash':digest(trade),'schemaVersion':SUPPORTED_SCHEMA,
                    'decisionId':record.get('decisionId'),'orderIntentId':record['orderIntentId'],
                    'orderId':sub.get('exchangeOrderId'),'symbol':record['symbol'],'side':record['side'],
                    'orderType':record['orderType'],'timeInForce':record['timeInForce'],
                    'executionPath':mapped,'sourceExecutionPath':record['executionPath'],
                    'executionVersion':record['executionVersion'],
                    'preSubmitQuote':{'time':pre.get('quoteTimestamp'),'bid':pre.get('bestBid'),'ask':pre.get('bestAsk')},
                    'submittedAt':sub.get('wireTimestamp'),'terminalAt':order.get('updateTime'),
                    'accountingAsOf':ex.get('accountingAsOf'),'fillAccountingComplete':ex.get('accountingComplete') is True,
                    'finalState':order.get('status'),'requestedQty':record['requestedQty'],
                    'executedQty':order.get('executedQty'),'fills':record['fills']['raw'],
                    'preSubmitContext':None,'slippageStatus':ex['slippageStatus'],
                    'provenanceNotes':['DURABLE_PRE_SUBMIT_INTENT','TRANSPORT_DISPATCH_CLOCK_REQUIRED','NO_CONTEXT_BACKFILL']})
                continue
            oid=order.get('orderId')
            fs=[f for f in trade.get('fills',[]) if oid is not None and str(f.get('orderId'))==str(oid)]
            reason=str(trade.get('exitReason') or '').upper()
            if path!='ENTRY' and any(word in reason for word in ('SAFETY','RECOVER','MANUAL','OPERATOR','UNWIND')):
                path='NONREPRESENTATIVE_EXIT'
            elif path=='NORMAL_EXIT' and reason not in ('MAX_HOLD','TAKE_PROFIT','CUT_LOSS','MANAGEMENT_CLOSE'):
                path='UNKNOWN_EXIT'
            entry_reason=str((trade.get('decision') or {}).get('reasonCode') or '').upper()
            if path=='ENTRY' and any(word in entry_reason for word in ('MANUAL','OPERATOR','RECOVER','SAFETY')):
                path='NONREPRESENTATIVE_ENTRY'
            observations.append({'environment':source['environment'],'laneId':source['laneId'],
                'sourceTradeId':trade.get('id'),'sourceTradeHash':digest(trade),
                'orderId':oid,'symbol':trade.get('symbol'),'side':order.get('side'),
                'orderType':order.get('type'),'timeInForce':order.get('timeInForce'),
                'executionPath':path,'executionVersion':h.get('executionVersion') or trade.get('executionVersion'),
                'preSubmitQuote':trade.get('book') if path=='ENTRY' else h.get('book'),
                'submittedAt':h.get('attemptedAt'),'terminalAt':order.get('updateTime'),
                'accountingAsOf':source['capturedAt'],
                'fillAccountingComplete':trade.get('settlementComplete') is True,
                'finalState':order.get('status'),'requestedQty':order.get('origQty'),
                'executedQty':order.get('executedQty'),'fills':fs,
                'preSubmitContext':h.get('preSubmitContext'),
                'slippageStatus':'UNKNOWN_MISSING_PRE_SUBMIT_QUOTE' if not (trade.get('book') if path=='ENTRY' else h.get('book')) else 'UNKNOWN_LEGACY_PROVENANCE',
                'provenanceNotes':['TRADE_BOOK_USED_ONLY_FOR_ENTRY','NO_CURRENT_EXECUTION_VERSION_BACKFILL',
                                   'ACCOUNTING_KNOWN_AS_OF_CAPTURE_NOT_HISTORICAL_DECISION_TIME']})
    return observations


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True)
    parser.add_argument('--input',help='Replay previously captured gateway-history.json; no network')
    args=parser.parse_args(); dest=Path(args.output)
    if dest.exists(): raise SystemExit('Use a new output directory')
    if args.input:
        source=json.loads(Path(args.input).read_text())
    else:
        run=subprocess.run(['ssh','-i','/Users/erwin/.ssh/contabo_dtc','-o','IdentitiesOnly=yes','-o','BatchMode=yes',
                            '-o','ConnectTimeout=10','root@194.233.71.109',REMOTE],capture_output=True,text=True,timeout=200,check=True)
        source=json.loads(run.stdout)
    obs=normalize(source); findings=audit(obs,source['capturedAt'])
    estimates=[]
    for result in findings['observations']:
        if result['eligible']:
            query=result['conditioning']
            if not any(r['requestedConditioning']==query for r in estimates):
                estimates.append(estimate(obs,query,source['capturedAt']))
    summary={'methodVersion':METHOD,'protocol':PROTOCOL,'capturedAt':source['capturedAt'],
             'closedTradesN':len(source['closed']),'activeTradesN':len(source['active']),
             **findings,'estimates':estimates,
             'scope':'AVAILABLE_GATEWAY_OWNED_LEDGER_NOT_COMPLETE_EXCHANGE_LIFETIME_HISTORY'}
    dest.mkdir()
    files={'gateway-history.json':source,'slippage-observations.json':obs,'slippage-audit.json':summary}
    for name,obj in files.items():
        with (dest/name).open('x') as f: json.dump(obj,f,indent=2,sort_keys=True,allow_nan=False)
    provenance={'capturedAt':source['capturedAt'],'semanticHashes':{name:digest(obj) for name,obj in files.items()},
                'sourceHashes':{name:__import__('hashlib').sha256((Path(__file__).parent/name).read_bytes()).hexdigest()
                                for name in ('slippage_estimator.py','audit_slippage_history.py')}}
    with (dest/'provenance.json').open('x') as f: json.dump(provenance,f,indent=2)
    print(json.dumps({'output':str(dest),'coverage':findings['dataCoverage'],
                      'estimatedBuckets':sum(x['status']=='ESTIMATED' for x in estimates)}))


if __name__=='__main__': main()
