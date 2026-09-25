import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from astra_v8_supervisor import Supervisor
from astra_v8_host import CoverageBook
from astra_v8_runner import bounded_context, IntegrationError


class ReservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sup = Supervisor.__new__(Supervisor)
        self.sup.dir = Path(self.tmp.name)
        self.sup.state = {'jobs': {}}
        self.sup.save = Mock()
        self.sup.coverage = CoverageBook(self.sup.dir / 'coverage.json')
        self.sup.coverage.observe(['AAAUSDT', 'BBBUSDT'], {}, 1)
        self.sup.coverage.reserve('orphan', 1, 2)

    def test_orphan_recovered_without_assessment_or_retry(self):
        self.sup.reconcile_pre_dispatch()
        row = self.sup.coverage.state['jobs']['orphan']
        self.assertEqual(row['outcome'], 'HOST_PRE_DISPATCH_ABORT')
        self.assertEqual(row['assessed'], [])
        self.assertFalse(self.sup.state['coverageRecovery']['modelOrOrderRetried'])
        self.sup.coverage.reserve('next', 1, 3)

    def test_worker_owned_reservation_never_discarded(self):
        self.sup.state['jobs']['orphan'] = {'finishedAt': None}
        self.sup.reconcile_pre_dispatch()
        self.assertIsNone(self.sup.coverage.state['jobs']['orphan']['outcome'])

    def test_unowned_durable_worker_file_blocks_recovery(self):
        (self.sup.dir / 'orphan.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'explicit reconciliation'):
            self.sup.reconcile_pre_dispatch()
        self.assertIsNone(self.sup.coverage.state['jobs']['orphan']['outcome'])

    def test_failure_after_reserve_before_dispatch_releases_reservation(self):
        self.sup.reconcile_pre_dispatch()
        def fail():
            self.sup.coverage.reserve('new', 1, 4)
            raise ValueError('provider changed after fetch')
        self.sup._tick = fail
        with self.assertRaisesRegex(ValueError, 'provider changed'):
            self.sup.tick()
        self.assertEqual(self.sup.coverage.state['jobs']['new']['outcome'], 'HOST_PRE_DISPATCH_ABORT')
        self.assertIn('provider changed', self.sup.state['lastLoopError']['error'])

    def test_error_after_durable_dispatch_does_not_discard_worker(self):
        self.sup.reconcile_pre_dispatch()
        def fail():
            self.sup.coverage.reserve('new', 1, 4)
            self.sup.state['jobs']['new'] = {'finishedAt': None}
            raise ValueError('process start uncertain')
        self.sup._tick = fail
        with self.assertRaises(ValueError): self.sup.tick()
        self.assertIsNone(self.sup.coverage.state['jobs']['new']['outcome'])


class CompactionTests(unittest.TestCase):
    def test_only_ranking_diagnostics_removed_required_data_unchanged(self):
        context = {'positions': [{'risk': 1, 'data': 'x'*55000}],
                   'lessons': [{'lessonId': 'verified'}],
                   'quantEvidence': {'cost': 35},
                   'candidateSelection': {'rankingHash': 'source', 'selected': [
                       {'symbol': str(i), 'slot': 'TOP_SCORE', 'score': 7,
                        'components': {'diagnostic': 'y'*1800}, 'unknownComponents': ['trend']}
                       for i in range(6)]}}
        before = copy.deepcopy(context)
        out = bounded_context(context)
        self.assertLess(len(json.dumps(out)), 64000)
        for key in ('positions', 'lessons', 'quantEvidence'):
            self.assertEqual(out[key], before[key])
        self.assertEqual(context, before)
        self.assertEqual(out['candidateSelection']['rankingHash'], 'source')
        self.assertEqual(out['candidateSelection']['selected'][0]['unknownComponents'], ['trend'])
        self.assertIn('contextCompaction', out)

    def test_required_payload_still_fails_closed(self):
        with self.assertRaises(IntegrationError):
            bounded_context({'positions': ['x'*65000]})

if __name__ == '__main__': unittest.main()
