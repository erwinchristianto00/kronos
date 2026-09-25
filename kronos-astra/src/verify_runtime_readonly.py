"""Read-only deployed Testnet identity and continuity; never calls a model or order."""
import hashlib,json,sys,time,subprocess
from pathlib import Path
root=Path('/opt/kronos-astra/releases/sonnet-v4-reliability-v1-20260918')
old=Path('/opt/kronos-astra/releases/sonnet-v4-watch-contract-v2-20260915')
sys.path.insert(0,str(root))
import astra_runner as engine
import astra_v8_runner as runner
from astra_v8_host import release_gate
from make_v8_manifest import runtime_hashes
from astra_canonical_v8 import CanonicalBook
from astra_v8_phase import validate_assignment
from astra_experiments import ExperimentBook,digest
read=lambda p:json.loads(p.read_text())
status=engine.gateway('/status');engine.validate_capital_identity(status)
manifest=read(root/'v8-manifest.json')
release_gate(manifest,current_hashes=runtime_hashes(root),gateway_status=status)
assert read(root/'runner-config.json')==read(old/'runner-config.json')
prior=read(old/'hermes-home/astra-canonical-v8.json')
events=read(root/'hermes-home/astra-canonical-v8.json')
assert events[:len(prior)]==prior
CanonicalBook(events)
schema=runner.tool_schemas(engine)['astra_decide']['parameters']['properties']['candidateAssessments']
assert schema['items']['properties']['candidateDisposition']['enum']==['WATCH','NO_TRADE']
book=ExperimentBook(root,digest({'base':engine.SYSTEM,'common':engine.EXPERIMENT_RULES}))
boundary=next(e for e in reversed(book.state['events']) if e.get('type')=='ORCHESTRATION_BOUNDARY')
assignment=list(book.state['assignments'].values())[-1]
try:admitted=validate_assignment(book,assignment,manifest,int(time.time()*1000))
except ValueError:admitted='WAITING_FOR_NEXT_SLOT_OR_ASSIGNMENT'
state=read(root/'hermes-home/v8/supervisor.json')
jobs=list(state['jobs'].values());results=[j.get('result') or {} for j in jobs]
print(json.dumps({'release':str(root),'fingerprint':manifest['fingerprint'],'releaseGate':'PASS',
    'phaseAdmission':admitted,'resumeAfterMs':boundary['resumeAfterMs'],
    'phaseId':boundary['phaseId'],'armed':manifest['armed'],'gatewayVersion':manifest['gatewayExecutionVersion'],
    'openN':len(status.get('active',[])),'closedN':len(status.get('closed',[])),
    'lastError':status.get('lastError'),'entryBlock':status.get('entryBlock'),
    'configurationUnchanged':True,'priorCanonicalEventsPreservedN':len(prior),
    'modelCallsPreservedN':len(state['calls']),'currentJobsN':len(jobs),
    'currentCandidateReportsN':sum(len(r.get('candidateReports',[])) for r in results),
    'candidateContractAvailable':True,'now':int(time.time()*1000)}))
