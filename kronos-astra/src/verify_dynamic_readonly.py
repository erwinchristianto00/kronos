"""No model or order calls. Runtime source identity and dynamic scan evidence."""
import json,sys,time,collections
from pathlib import Path
from dynamic_candidates import observe,select

root=Path(sys.argv[1])
sys.path.insert(0,str(root))
import astra_runner as engine
import astra_v8_runner as runner
read=lambda p:json.loads(p.read_text())
status=engine.gateway('/status');engine.validate_capital_identity(status)
supervisor=read(root/'hermes-home/v8/supervisor.json')
coverage=read(root/'hermes-home/v8/coverage.json')
if '--fetch' in sys.argv:
    raw=engine.gateway('/context',{'symbols':[]})
    state=observe(raw,{},int(time.time()*1000))
else:state=read(root/'hermes-home/v8/dynamic-candidates.json')
selection=select(state,coverage,int(time.time()*1000))
jobs=list(supervisor['jobs'].values())
contextBytes=[]
for job in jobs[-3:]:
    path=Path(job.get('path',''))
    if path.is_file():
        data=read(path);ctx=data.get('context',{})
        if ctx.get('marketCandidates'):
            ctx['candidateSelection']=selection
            runner.bounded_context(ctx);contextBytes.append(len(json.dumps(ctx)))
print(json.dumps({'root':str(root),'now':int(time.time()*1000),
    'openN':len(status.get('active',[])),'closedN':len(status.get('closed',[])),
    'gatewayVersion':status.get('executionVersion'),'entryBlock':status.get('entryBlock'),
    'unfinishedJobs':[k for k,j in supervisor['jobs'].items() if not j.get('finishedAt')],
    'scanner':supervisor.get('dynamicCandidates'),'selection':selection,
    'excludedReasons':dict(collections.Counter(r for reasons in state['excluded'].values() for r in reasons)),
    'historicalContextWithNewSelectionBytes':contextBytes,
    'readOnly':True,'modelOrOrderCalls':0}))
