"""Read-only Testnet telemetry; no exchange credentials, order routes or model calls."""
import collections,json,os,subprocess,time
from pathlib import Path
from shadow_projection import collect_shadows

def projection(manifest,state,active,root,now):
    if manifest.get('fingerprint') != state.get('fingerprint') or not manifest.get('fingerprint'):
        raise ValueError('COHORT_FINGERPRINT_MISMATCH')
    router=state.get('router',{})
    if router.get('modelPolicyVersion')!='SONNET_MEDIUM_OPUS_REVIEW_V1':
        raise ValueError('UNSUPPORTED_MODEL_POLICY')
    polled=state.get('lastPollAt',0)
    fresh=0 <= now-polled <= 300000
    jobs=list(state.get('jobs',{}).values())
    rows=[]
    for j in jobs:
        r=j.get('result') or {}
        rows.append({'id':j['id'],'at':j.get('at'),'mode':j.get('mode'),
            'model':(j.get('modelPolicy') or {}).get('model'),
            'effort':(j.get('modelPolicy') or {}).get('effort'),
            'outcome':r.get('outcome','RUNNING' if not j.get('finishedAt') else 'UNKNOWN'),
            'error':r.get('error'),'completed':r.get('completed') is True,
            'finishedAt':j.get('finishedAt'),
            'actions':[{'action':a.get('action'),'outcome':a.get('outcome'),
                        'orderFilledAt':a.get('orderFilledAt')} for a in r.get('actions',[])]})
    rows.sort(key=lambda r:r.get('at') or 0,reverse=True)
    counts=dict(collections.Counter(r['outcome'] for r in rows))
    failures=[r for r in rows if r['error'] or r['outcome'] in
        ('INTEGRATION_BLOCKED','INVALID_MODEL_RESPONSE','UNRESOLVED_RECONCILE','TURN_BUDGET_EXHAUSTED')]
    def recovered(failure):
        return any(r['mode']==failure['mode'] and r['completed'] and not r['error']
            and r['outcome'] in ('MODEL_DECISION','COACHING_COMPLETED')
            and (r['at'] or 0)>(failure['finishedAt'] or failure['at'] or 0) for r in rows)
    unresolved=[r for r in failures if not recovered(r)]
    loop_error=state.get('lastLoopError') or {}
    loop_blocked=bool(loop_error.get('error') and (loop_error.get('at') or 0)>=(state.get('lastHealthyTickAt') or 0))
    availability=state.get('claudeAvailability') or {}
    budgets=state.get('modelCallBudgets') or {}
    budget_fresh=(budgets.get('version')=='SPLIT_MODEL_BUDGET_V1'
                  and 0 <= now-budgets.get('observedAt',0) <= 300000
                  and now < budgets.get('resetsAt',0))
    formation_exhausted=budget_fresh and budgets.get('FAST_TRADING',{}).get('status')=='EXHAUSTED'
    status=('OFF' if not active or not manifest.get('armed') else 'STALE' if not fresh
            else 'ARMED_WAITING_FOR_CLAUDE' if availability.get('status')!='READY'
            else 'RUNNING_WITH_ERRORS' if unresolved or loop_blocked
            else 'RUNNING_TRADING_BUDGET_EXHAUSTED' if formation_exhausted else 'RUNNING')
    return {'schemaVersion':1,'environment':'testnet','laneId':'ASTRA_HERMES_TESTNET',
        'observedAt':now,'lastPollAt':polled,'serviceActive':active,'status':status,
        'source':'ACTIVE_SERVICE_MANIFEST_AND_SUPERVISOR','release':root,
        'fingerprint':manifest['fingerprint'],'cohortStartedAt':manifest.get('startedAt'),
        'legacyTradeIds':manifest.get('legacyDecisionIds',[]),
        'model':'claude-sonnet-5','reasoning':'medium','modelRole':'PRIMARY',
        'reviewModel':'claude-opus-5','reviewEffort':'high','deepEffort':'max',
        'availability':{'status':availability.get('status'),'nextProbeAt':availability.get('nextProbeAt'),
                        'checks':(availability.get('result') or {}).get('checks',[])},
        'jobCounts':counts,'jobsN':len(rows),'recentJobs':rows[:12],
        'modelCallBudgets':budgets if budget_fresh else None,
        'budgetMeaning':'Independent UTC-day dispatch allowances; coaching cannot spend trading slots. Connection probes and unknown legacy reservations count toward trading. Existing urgent position/ready-plan exceptions remain; not a token or provider quota.',
        'healthMeaning':'Historical failures remain in jobCounts/latestFailure. A later completed job in the same mode proves recovery, not permanent bug elimination.',
        'unresolvedFailureN':len(unresolved),'historicalFailureN':len(failures),
        'lastLoopError':loop_error or None,'loopErrorUnresolved':loop_blocked,
        'latestFailure':next((r for r in rows if r['error'] or r['outcome'] in
            ('INTEGRATION_BLOCKED','INVALID_MODEL_RESPONSE','UNRESOLVED_RECONCILE','TURN_BUDGET_EXHAUSTED')),None),
        'alphaEvidence':'MARKET_STATE_ONLY','profitability':'UNPROVEN'}

def bounded_json(path):
    if path.stat().st_size>64*1024*1024:raise ValueError('TELEMETRY_INPUT_TOO_LARGE')
    return json.loads(path.read_text())

def collect():
    now=int(time.time()*1000)
    def field(name):
        return subprocess.check_output(['systemctl','show','kronos-astra-hermes.service','--value','-p',name],text=True,timeout=5).strip()
    root=Path(field('WorkingDirectory')).resolve()
    if root.parent!=Path('/opt/kronos-astra/releases'):raise ValueError('UNEXPECTED_RUNTIME_ROOT')
    return projection(bounded_json(root/'v8-manifest.json'),bounded_json(root/'hermes-home/v8/supervisor.json'),
                      field('ActiveState')=='active',str(root),now)

def main():
    out=Path('/opt/kronos-astra-dashboard/state/runtime.json')
    try:data=collect()
    except Exception as e:
        data={'schemaVersion':1,'environment':'testnet','laneId':'ASTRA_HERMES_TESTNET',
              'observedAt':int(time.time()*1000),'status':'UNKNOWN','error':type(e).__name__+': '+str(e)}
    runtime=Path(data['release']) if data.get('release') else None
    data['shadows']=collect_shadows(runtime)
    temp=out.with_suffix('.tmp')
    with temp.open('w') as f:
        json.dump(data,f);f.flush();os.fsync(f.fileno())
    os.chmod(temp,0o644);os.replace(temp,out)

if __name__=='__main__':main()
