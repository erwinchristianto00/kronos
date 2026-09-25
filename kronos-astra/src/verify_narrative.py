"""Hermetic focused suite and exact runtime receipt; no model or order calls."""
import json
import time
import unittest
from pathlib import Path
from astra_v8_host import atomic_json, digest
from make_v8_manifest import runtime_hashes

NAMES = '''test_hermes_dashboard test_candidate_completion test_decision_grounding test_entry_latency_fix test_context_budget_fix test_quant_candidate_refresh test_entry_path test_narrative_attention test_hermes_decision_evidence test_astra_watch_queue test_candidate_disposition test_dynamic_candidates
test_astra_plans test_astra_replan_v2 test_plan_reporting test_astra_v8_supervisor
test_astra_v8_runner test_astra_v8_host test_astra_v8_phase test_astra_fast_v8
test_runner_host test_runner_schema test_fast_entry test_row_refresh test_v2_worker
test_executable_search test_astra_experiments test_astra_cadence'''.split()

NAMES.append('test_resolution')
NAMES.extend(['test_split_budget', 'test_claude_availability', 'test_runtime_health', 'test_hermes_learner', 'test_supervisor_compaction'])

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    started = time.time()
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromNames(NAMES))
    receipt = {'passed': result.wasSuccessful(), 'tests': result.testsRun,
               'seconds': time.time()-started, 'fingerprint': digest(runtime_hashes(root)),
               'testModules': NAMES, 'modelCalls': 0, 'exchangeOrders': 0}
    receipt['skipped'] = len(result.skipped)
    atomic_json(root/'narrative-test-receipt.json', receipt)
    print(json.dumps(receipt), flush=True)
    raise SystemExit(0 if result.wasSuccessful() else 1)
