"""Guarded Testnet-only API handoff; no order calls and no safety overrides."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import urllib.request

OLD = Path('/root/kronos-testnet-releases/astra-fast-context-20260919/daily-trading-cockpit-v2')
NEW = Path('/root/kronos-testnet-releases/astra-tick-coalescing-20260921/daily-trading-cockpit-v2')
RUNNER = Path('/opt/kronos-astra/releases/sonnet-v4-resolution-v3-20260921')
SERVICE = 'kronos-astra-hermes.service'
SOURCE = 'apps/api/src/lib/astra-hermes-lane.ts'
SOURCE_SHA = 'd32464646ea08af4aa953a9cecd1756b3a8019d54af2ee510c23c1b8db349c8c'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def gateway():
    token = (RUNNER/'gateway-token').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:3112/status', headers={'Authorization':'Bearer '+token})
    return json.load(urllib.request.urlopen(req, timeout=20))

def pm2():
    return {p['name']: {'pid':p['pid'], 'script':p['pm2_env']['pm_exec_path'],
                       'uptime':p['pm2_env'].get('pm_uptime')} for p in json.loads(run('pm2','jlist'))
            if p.get('name') in ('dtc-api-testnet','dtc-api-live')}

def main():
    assert sha(NEW/SOURCE) == SOURCE_SHA
    assert sha(NEW/'.env') == sha(OLD/'.env'), 'CONFIG_DRIFT'
    assert (NEW/'apps/api/data').is_symlink()
    assert (NEW/'apps/api/data').resolve() == (OLD/'apps/api/data').resolve()
    differences=[]
    for folder in ('apps/api/src','packages/shared/src','deploy'):
        for a in (OLD/folder).rglob('*'):
            if a.is_file() and not a.is_symlink():
                rel=a.relative_to(OLD);b=NEW/rel
                if not b.is_file() or sha(a)!=sha(b):differences.append(str(rel))
    assert differences == [SOURCE], differences
    receipt=json.loads((NEW/'tick-test-receipt.json').read_text())
    assert receipt['success'] and receipt['numPassedTests']==96 and receipt['numFailedTests']==0
    assert receipt['buildPassed'] and receipt['sourceHash']==SOURCE_SHA, 'BUILD_NOT_CONFIRMED'
    assert sha(NEW/'apps/api/test/astra-hermes-lane.test.ts')==receipt['testHash']
    processes=pm2()
    assert processes['dtc-api-testnet']['script']==str(OLD/'deploy/run-api.sh')
    live=processes['dtc-api-live']
    assert run('systemctl','show',SERVICE,'-p','WorkingDirectory','--value')==str(RUNNER)
    status=gateway()
    assert status['environment']=='testnet' and not status.get('entryBlock') and not status.get('lastError')
    for p in status['active']:
        assert p['state']=='OPEN' and p['stopId'] and not p.get('stopDone') and not p.get('error')
        assert p['entry']['order']['status']=='FILLED'
    pid=int(run('systemctl','show',SERVICE,'-p','MainPID','--value'))
    assert pid>0
    os.kill(pid,signal.SIGSTOP)
    stopped=False
    try:
        state=json.loads((RUNNER/'hermes-home/v8/supervisor.json').read_text())
        assert all(j.get('finishedAt') for j in state['jobs'].values()), 'WAIT_FOR_NATURAL_IDLE'
        assert subprocess.run(['pgrep','-P',str(pid)],capture_output=True).returncode==1, 'WAIT_FOR_CHILD'
        os.kill(pid,signal.SIGTERM);os.kill(pid,signal.SIGCONT)
        subprocess.run(['systemctl','stop',SERVICE],check=True,timeout=45)
        stopped=True
        # Standard gate waits for fresh account/order coverage, refuses a healthy
        # continuous R-trail, fingerprints all account positions, restores drain
        # state and rolls back on failure. No override flags are provided.
        env={**os.environ,'CUTOVER_TARGET':'testnet','CUTOVER_PM2_NAME':'dtc-api-testnet','CUTOVER_PORT':'3102'}
        subprocess.run(['bash',str(NEW/'deploy/guarded-live-api-cutover.sh'),str(OLD),str(NEW)],env=env,check=True)
        after=pm2()
        assert after['dtc-api-testnet']['script']==str(NEW/'deploy/run-api.sh')
        assert after['dtc-api-live']==live,'LIVE_PROCESS_CHANGED'
        assert sha(NEW/SOURCE)==SOURCE_SHA
        fresh=gateway()
        assert fresh['environment']=='testnet' and not fresh.get('entryBlock') and not fresh.get('lastError')
        print(json.dumps({'release':str(NEW),'sourceHash':SOURCE_SHA,'liveUnchanged':True,
                          'activeN':len(fresh['active']),'closedN':len(fresh['closed']),
                          'tests':96,'runnerFingerprintUnchanged':True}),flush=True)
    finally:
        if stopped:
            subprocess.run(['systemctl','start',SERVICE],check=True)
        else:
            os.kill(pid,signal.SIGCONT)

if __name__=='__main__':main()
