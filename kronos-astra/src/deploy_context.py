"""Guarded Testnet runner-only release cutover. Never invokes order endpoints."""
import hashlib,json,os,pwd,shutil,subprocess,sys,time
from pathlib import Path
OLD=Path('/opt/kronos-astra/releases/sonnet-v4-watch-contract-v2-20260915')
NEW=Path('/opt/kronos-astra/releases/sonnet-v4-reliability-v1-20260918')
UNIT=Path('/etc/systemd/system/kronos-astra-hermes.service')
SERVICE='kronos-astra-hermes.service'
def run(*args):return subprocess.check_output(args,text=True).strip()
def read(p):return json.loads(p.read_text())
def no_jobs(root):
    state=read(root/'hermes-home/v8/supervisor.json')
    assert not [j for j in state['jobs'].values() if not j.get('finishedAt')],'WAIT_FOR_RUNNING_JOBS'
    return state
def main():
    assert run('systemctl','show',SERVICE,'--value','-p','WorkingDirectory')==str(OLD)
    assert run('systemctl','is-active',SERVICE)=='active'
    assert not (NEW/'hermes-home').exists(),'NO_PROFILE_OVERWRITE'
    assert shutil.disk_usage(NEW).free>2*1024**3
    oldmanifest=read(OLD/'v8-manifest.json')
    for name,h in oldmanifest['runtimeFiles'].items():
        assert hashlib.sha256((OLD/name).read_bytes()).hexdigest()==h
        if name not in ('astra_v8_runner.py','candidate_disposition.py','astra_v8_supervisor.py','hermes_dashboard.py'):assert (NEW/name).read_bytes()==(OLD/name).read_bytes(),name
    no_jobs(OLD)
    sys.path.insert(0,str(OLD))
    import astra_runner as old_engine
    before=old_engine.gateway('/status');old_engine.validate_capital_identity(before)
    assert not before.get('active') and not before.get('lastError') and not before.get('entryBlock')
    backup=NEW/'previous-service.unit';shutil.copy2(UNIT,backup)
    subprocess.run(['systemctl','stop',SERVICE],check=True)
    activated=False
    try:
        state=no_jobs(OLD) # stop-race audit; never replay an interrupted worker
        after=old_engine.gateway('/status')
        assert not after.get('active') and not after.get('lastError')
        shutil.copytree(OLD/'hermes-home',NEW/'hermes-home',symlinks=True)
        archived=NEW/'hermes-home/v8-before-reliability'
        (NEW/'hermes-home/v8').rename(archived);(NEW/'hermes-home/v8').mkdir()
        for name in ('coverage.json','claude-availability.json','claude-probe-result.json','dynamic-candidates.json'):
            if (archived/name).exists():shutil.copy2(archived/name,NEW/'hermes-home/v8'/name)
        for name in ('work','gateway-token','logs'):
            p=NEW/name
            if p.exists() and not p.is_symlink():p.rename(NEW/(name+'-predeploy-tests'))
            p.symlink_to(OLD/name)
        shutil.copy2(OLD/'runner-config.json',NEW/'runner-config.json');(NEW/'runner.lock').touch()
        # Load the new worker/module in a clean child; incumbent imports cannot leak.
        run('/opt/kronos-astra/runtime/work/hermes-agent/.venv/bin/python','-B',str(NEW/'deploy_context.py'),'--prepare')
        text=backup.read_text();assert str(OLD) in text
        (NEW/'kronos-astra-hermes.service').write_text(text.replace(str(OLD),str(NEW)))
        shutil.copy2(NEW/'kronos-astra-hermes.service',UNIT)
        subprocess.run(['systemctl','daemon-reload'],check=True)
        subprocess.run(['systemctl','start',SERVICE],check=True);activated=True
        print(json.dumps({'deployment':'STARTED','release':str(NEW),'sourceOldPreserved':True,'gatewayUnchanged':True}))
    except Exception:
        if not activated:
            shutil.copy2(backup,UNIT);subprocess.run(['systemctl','daemon-reload'],check=True)
            subprocess.run(['systemctl','start',SERVICE],check=True)
        raise

def prepare():
    sys.path.insert(0,str(NEW))
    import astra_runner as engine
    from astra_v8_host import atomic_json,release_gate
    from make_v8_manifest import runtime_hashes,build
    from astra_experiments import ExperimentBook,digest
    from astra_v8_phase import prepare_v8_phase
    from migrate_supervisor_cohort import _fresh_state,reconcile_orphaned_coverage
    at=int(time.time()*1000);status=engine.gateway('/status');engine.validate_capital_identity(status)
    assert not status.get('active') and not status.get('lastError')
    old=read(OLD/'v8-manifest.json');state=read(NEW/'hermes-home/v8-before-reliability/supervisor.json')
    manifest=build(NEW,armed=True,tests_passed=True,integration_verified=True,
                   gateway_version=old['gatewayExecutionVersion'],started_at=at,
                   legacy_decision_ids=[r['decision']['id'] for r in status.get('decisions',[]) if (r.get('decision') or {}).get('id')])
    manifest.update(claudeWaitArm=True,alphaEvidenceMode='MARKET_STATE_ONLY',
                    parentFingerprint=old['fingerprint'],changeType='HOST_RELIABILITY_V1')
    book=ExperimentBook(NEW,digest({'base':engine.SYSTEM,'common':engine.EXPERIMENT_RULES}))
    boundary=prepare_v8_phase(book,at,manifest['fingerprint'],[t['id'] for t in status.get('closed',[])],recohort=True)
    book.save();release_gate(manifest,current_hashes=runtime_hashes(NEW),gateway_status=status)
    atomic_json(NEW/'v8-manifest.json',manifest)
    fresh=_fresh_state(NEW,manifest['fingerprint'],state.get('modelHealth'),state.get('router'))
    fresh['calls']=state.get('calls',[])
    fresh['lastFormationAt']=state.get('lastFormationAt')
    fresh['lastCoachingAt']=state.get('lastCoachingAt')
    atomic_json(NEW/'hermes-home/v8/supervisor.json',fresh)
    # A formation can reserve coverage before it creates a worker job. Such a
    # pre-dispatch reservation is not caught by checking unfinished worker jobs.
    coverage=reconcile_orphaned_coverage(NEW,[],apply_changes=True)
    owner=pwd.getpwnam('kronos-astra')
    os.chown(NEW,0,owner.pw_gid);os.chmod(NEW,0o750)
    for root,dirs,files in os.walk(NEW/'hermes-home',followlinks=False):
        os.chown(root,owner.pw_uid,owner.pw_gid)
        for name in files+dirs:os.lchown(Path(root)/name,owner.pw_uid,owner.pw_gid)
    for p in NEW.glob('*.py'):os.chown(p,0,owner.pw_gid);os.chmod(p,0o640)
    for name in ('runner-config.json','v8-manifest.json'):
        os.chown(NEW/name,0,owner.pw_gid);os.chmod(NEW/name,0o640)
    os.chown(NEW/'runner.lock',owner.pw_uid,owner.pw_gid)
    atomic_json(NEW/'cutover-receipt.json',{'fingerprint':manifest['fingerprint'],'boundary':boundary,
                'archivedFinishedJobs':len(state['jobs']),'callsPreserved':len(fresh['calls']),
                'coverageReconciliation':coverage,
                'positionsN':0,'tests':'Candidate reporting, canonical provenance, gateway isolation and runner regression; see local report',
                'modelOrOrderInvokedByDeployment':False})
    print(json.dumps({'prepared':True,'fingerprint':manifest['fingerprint']}))

if __name__=='__main__':prepare() if '--prepare' in sys.argv else main()
