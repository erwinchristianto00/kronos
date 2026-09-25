"""Replay an immutable historical report locally; no model, gateway or writes."""
import json,hashlib
from pathlib import Path
import candidate_disposition as c
root=Path('/opt/kronos-astra/releases/sonnet-v4-candidate-disposition-v1-20260915')
found=[]
for line in (root/'logs/astra-v8-fast_trading.jsonl').open():
    try:r=json.loads(line)
    except ValueError:continue
    if r.get('kind')=='DECISION_INTENT' and r.get('decisionId')=='decide-20260915-batch-fastscan-1':found.append(r)
assert len(found)==1
intent=found[0];original=json.dumps(intent,sort_keys=True)
job=json.loads((root/'hermes-home/v8'/(intent['jobId']+'.json')).read_text())
result=c.build_report(intent['input'],job['context'],intent['recordedAt'])
assert result['reportingStatus']=='COMPLETE'
old=next(r for r in intent['candidateReport']['candidates'] if r['symbol']=='ACHUSDT')
new=next(r for r in result['candidates'] if r['symbol']=='ACHUSDT')
assert old['candidateDisposition']=='UNKNOWN' and new['candidateDisposition']=='WATCH'
assert new['revisitCondition']['operator']=='LTE'
assert json.dumps(intent,sort_keys=True)==original
print(json.dumps({'readOnlyReplay':True,'schemaVersion':c.VERSION,'sourceIntentHash':hashlib.sha256(original.encode()).hexdigest(),
                  'historicalStatusUnchanged':old['candidateDisposition'],'replayedACH':new['candidateDisposition'],
                  'replayedBatchStatus':result['reportingStatus'],'modelOrOrderInvocations':0}))
