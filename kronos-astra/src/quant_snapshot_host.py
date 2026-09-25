"""Nonblocking, single-flight benchmark reads. Never a candidate/plan source."""
import copy
import threading
import time
from quant_measurements import closed_window, finite
from astra_v8_host import fetch_histories


class ReferenceCache:
    def __init__(self, gateway, clock=None):
        self.gateway = gateway
        self.clock = clock or (lambda: int(time.time()*1000))
        self.lock = threading.Lock()
        self.pending = False
        self.last_attempt = None
        self.rows = []
        self.issue = 'NOT_YET_COLLECTED'

    def _collect(self):
        try:
            raw = fetch_histories(self.gateway, ['BTCUSDT', 'ETHUSDT'])
            stamp = raw.get('at')
            if not finite(stamp) or not 0 <= self.clock()-stamp <= 120000:
                raise ValueError('BENCHMARK_SOURCE_TIMESTAMP_INVALID')
            rows = [{**r, 'observedAt': stamp} for r in raw['rows']]
            with self.lock:
                self.rows, self.issue = rows, None
        except Exception:
            # Do not leak network URLs/authentication errors into the model context.
            with self.lock:
                self.issue = 'REFERENCE_FETCH_FAILED'
        finally:
            with self.lock:
                self.pending = False

    def context(self):
        at = self.clock()
        with self.lock:
            rows = [copy.deepcopy(r) for r in self.rows
                    if finite(r.get('observedAt')) and 0 <= at-r['observedAt'] <= 120000
                    and not closed_window(r, at)[1]]
            result = {'quantReferences': rows,
                      'quantReferenceStatus': {'status': 'AVAILABLE' if len(rows)==2 else 'PENDING_OR_UNAVAILABLE',
                                               'reason': self.issue,
                                               'meaning': 'BENCHMARK_ONLY_NOT_TRADABLE_CANDIDATE'}}
            due = self.last_attempt is None or at-self.last_attempt >= 60000
            if due and not self.pending:
                self.pending = True
                self.last_attempt = at
                # Does not delay management or model invocation on slow market data.
                threading.Thread(target=self._collect, daemon=True, name='quant-reference-read').start()
            return result


def attach_references(raw, cache):
    # Preserve original execution rows, status and coverage exactly.
    return {**raw, **cache.context()}
