"""Testnet code release: bounded supervisor working set (imported canonical deltas and
old finished job results move to hermes-home/v8/job-archive.jsonl.gz).

Only astra_v8_supervisor.py changes. The whole hermes-home is copied, learner state
included, untouched. Config, gateway, prompts and LIVE untouched.
"""
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

OLD = Path('/opt/kronos-astra/releases/sonnet-v4-hermes-learner-v3-20260922')
NEW = Path('/opt/kronos-astra/releases/sonnet-v4-state-compact-v1-20260924')
STAGE = Path(__file__).resolve().parent
UNIT = Path('/etc/systemd/system/kronos-astra-hermes.service')
SERVICE = 'kronos-astra-hermes.service'
CHANGED = {'astra_v8_supervisor.py'}
OLD_FINGERPRINT = '9b4beba2586e7a9120e393931f22c2a21cc0fab6301eef6dd2094b469a295615'


def ownership(status):
    assert status.get('environment') == 'testnet' and status.get('laneId') == 'ASTRA_HERMES_TESTNET'
    assert not status.get('entryBlock') and not status.get('lastError'), 'GATEWAY_UNHEALTHY'
    rows = []
    for p in status.get('active', []):
        assert p.get('state') == 'OPEN' and p.get('qty', 0) > 0 and p.get('stopId') and not p.get('stopDone') and not p.get('error'), 'PENDING_OR_UNPROTECTED'
        assert p.get('entry', {}).get('order', {}).get('status') == 'FILLED', 'PENDING_ENTRY'
        rows.append({k: p.get(k) for k in ('id', 'symbol', 'side', 'qty', 'entryQty', 'entryPrice', 'stopId', 'stopPrice', 'targetPrice', 'maxHoldMs', 'createdAt')})
    return sorted(rows, key=lambda p: p['id'])


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    assert not NEW.exists(), 'Release already exists; inspect before retry'
    assert run('systemctl', 'show', SERVICE, '-p', 'WorkingDirectory', '--value') == str(OLD)
    manifest = json.loads((OLD / 'v8-manifest.json').read_text())
    assert manifest['fingerprint'] == OLD_FINGERPRINT
    for name, h in manifest['runtimeFiles'].items():
        assert sha(OLD / name) == h, 'Incumbent source drift: ' + name
    sys.path.insert(0, str(STAGE))
    import make_v8_manifest as maker
    from astra_v8_host import release_gate, atomic_json, digest
    import astra_runner as engine
    tested = maker.runtime_hashes(STAGE)
    receipt = json.loads((STAGE / 'narrative-test-receipt.json').read_text())
    assert receipt['passed'] and receipt['tests'] >= 600 and receipt['fingerprint'] == digest(tested)
    assert {k for k, v in tested.items() if manifest['runtimeFiles'].get(k) != v} == CHANGED
    engine.ROOT = OLD
    before = engine.gateway('/status')
    release_gate(manifest, current_hashes={k: sha(OLD / k) for k in manifest['runtimeFiles']}, gateway_status=before)
    protected = ownership(before)
    old_state_dir = (OLD / 'hermes-home').resolve()
    old_unit = UNIT.read_text()
    old_config = json.loads((OLD / 'runner-config.json').read_text())
    pid = int(run('systemctl', 'show', SERVICE, '-p', 'MainPID', '--value'))
    assert pid > 0
    os.kill(pid, signal.SIGSTOP)
    stopped = False
    try:
        state = json.loads((old_state_dir / 'v8/supervisor.json').read_text())
        assert all(j.get('finishedAt') for j in state['jobs'].values()), 'WAIT_FOR_NATURAL_IDLE'
        assert subprocess.run(['pgrep', '-P', str(pid)], capture_output=True).returncode == 1, 'WAIT_FOR_CHILD'
        os.kill(pid, signal.SIGTERM)
        os.kill(pid, signal.SIGCONT)
        subprocess.run(['systemctl', 'stop', SERVICE], check=True, timeout=45)
        stopped = True
        shutil.copytree(OLD, NEW, symlinks=True, ignore=lambda d, names: ['hermes-home'] if Path(d) == OLD else [])
        # Own copy of state: migration below must not rewrite the rollback release's state.
        shutil.copytree(old_state_dir, NEW / 'hermes-home', symlinks=True)
        for name in CHANGED | {'test_hermes_learner.py', 'make_v8_manifest.py', 'verify_narrative.py', 'deploy_state_compact.py', 'test_supervisor_compaction.py', 'narrative-test-receipt.json'}:
            shutil.copy2(STAGE / name, NEW / name)
        assert maker.runtime_hashes(NEW) == tested
        continuity = {}
        for name in ('astra-plans.json', 'astra-canonical-v8.json', 'v8/supervisor.json'):
            a, b = old_state_dir / name, NEW / 'hermes-home' / name
            assert sha(a) == sha(b), 'Continuity mismatch: ' + name
            continuity[name] = sha(a)
        current = engine.gateway('/status')
        assert ownership(current) == protected and current.get('closed') == before.get('closed'), 'POSITION_CHANGED_DURING_HANDOFF'
        from astra_experiments import ExperimentBook
        from astra_v8_phase import prepare_v8_phase
        from migrate_supervisor_cohort import migrate
        import astra_watch_queue as watch
        at = int(time.time() * 1000)
        legacy = [d['decision']['id'] for d in current.get('decisions', [])
                  if isinstance(d, dict) and (d.get('decision') or {}).get('id')]
        new_manifest = maker.build(NEW, armed=True, tests_passed=True, integration_verified=True,
                                   gateway_version=current['executionVersion'], started_at=at, legacy_decision_ids=legacy)
        for key, value in manifest.items():
            if key not in new_manifest:
                new_manifest[key] = value
        book = ExperimentBook(NEW, digest({'base': engine.SYSTEM, 'common': engine.EXPERIMENT_RULES}))
        boundary = prepare_v8_phase(book, at, new_manifest['fingerprint'],
                                    sorted(t['id'] for t in current.get('closed', []) + current.get('active', [])), recohort=True)
        import hermes_learner
        study = book.active()
        assert study and study.get('kind') == hermes_learner.STUDY_KIND, 'LEARNER_STUDY_NOT_ACTIVE'
        book.save()
        learner = NEW / 'hermes-home' / hermes_learner.STATE_NAME
        assert sha(learner) == sha(old_state_dir / hermes_learner.STATE_NAME), 'LEARNER_STATE_NOT_CARRIED'
        atomic_json(NEW / 'v8-manifest.json', new_manifest)
        migrate(NEW, new_manifest['fingerprint'], apply_changes=True)
        sp = NEW / 'hermes-home/v8/supervisor.json'
        fresh = json.loads(sp.read_text())
        for key in ('calls', 'claudeAvailability', 'lastFormationAt', 'lastCoachingAt', 'watchQueue',
                    'positionSamples', 'lastManagedAt', 'modelCallBudgets', 'modelCallBudget'):
            if key in state:
                fresh[key] = state[key]
        queue = watch.init(fresh)
        for job in sorted(state['jobs'].values(), key=lambda j: j.get('at', 0)):
            if job.get('finishedAt'):
                watch.ingest(queue, (job.get('result') or {}).get('candidateReports', []), at)
        fresh['watchSummary'] = watch.summary(queue)
        assert fresh['calls'] == state['calls']
        atomic_json(sp, fresh)
        assert json.loads((NEW / 'runner-config.json').read_text()) == old_config, 'CONFIG_CHANGED'
        assert json.loads((OLD / 'hermes-home/v8/supervisor.json').read_text())['fingerprint'] == OLD_FINGERPRINT, 'ROLLBACK_STATE_MUTATED'
        release_gate(new_manifest, current_hashes=tested, gateway_status=current)
        (NEW / 'previous-service.unit').write_text(old_unit)
        final = {'release': str(NEW), 'previous': str(OLD), 'fingerprint': new_manifest['fingerprint'],
                 'previousFingerprint': OLD_FINGERPRINT, 'boundary': boundary, 'tests': receipt,
                 'changed': sorted(CHANGED), 'watchSummary': fresh['watchSummary'], 'continuityHashes': continuity,
                 'activeN': len(current['active']), 'closedN': len(current.get('closed', [])),
                 'configDelta': {}, 'callsLedgerPreserved': True, 'stateCopiedNotShared': True,
                 'deployModelCalls': 0, 'deployOrders': 0, 'carriedPositions': protected,
                 'learnerStudy': study['id'], 'learnerStateCarried': True}
        atomic_json(NEW / 'state-compact-deploy-receipt.json', final)
        subprocess.run(['chown', '-hR', 'kronos-astra:kronos-astra', str(NEW)], check=True)
        UNIT.write_text(old_unit.replace(str(OLD), str(NEW)))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'start', SERVICE], check=True)
        print(json.dumps(final), flush=True)
    except BaseException:
        if stopped:
            UNIT.write_text(old_unit)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
            subprocess.run(['systemctl', 'start', SERVICE], check=True)
        else:
            os.kill(pid, signal.SIGCONT)
        raise


if __name__ == '__main__':
    main()
