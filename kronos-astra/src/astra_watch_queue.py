"""Durable attention queue. No plan creation, model calls or order authority."""
import copy
import queue
import threading
from concurrent.futures import ThreadPoolExecutor

from astra_experiments import digest
from candidate_disposition import number
from quant_candidate_refresh import read_public

VERSION = 'WATCH_REASSESSMENT_V1'
POLL_MS = 60000
COOLDOWN_MS = 300000
MAX_QUOTE_AGE_MS = 60000
MAX_EXTRA = 18  # six new + eighteen watch + eight plans <= 32 report rows


def init(state):
    value = state.setdefault('watchQueue', {'version': VERSION, 'items': {}, 'events': []})
    if value.get('version') != VERSION:
        raise ValueError('Watch queue migration required')
    return value


def event(state, row, action, at):
    state['events'].append({'watchId': row['id'], 'symbol': row['symbol'], 'event': action, 'at': at})
    state['events'] = state['events'][-2000:]


def ingest(state, reports, at):
    """Consume host-validated, confirmed no-order assessments only, idempotently."""
    for report in reports:
        stamp = report.get('assessedAt')
        if (report.get('hostOutcome') != 'VALID_NO_TRADE' or not number(stamp) or stamp > at):
            continue
        for row in report.get('candidates', []):
            if row.get('reportingStatus') != 'COMPLETE' or row.get('issues'):
                continue
            symbol = row.get('symbol')
            if not isinstance(symbol, str) or not symbol.endswith('USDT'):
                continue
            old = state['items'].get(symbol)
            if old and stamp <= old['assessedAt']:
                continue
            if row.get('candidateDisposition') == 'NO_TRADE':
                if old:
                    old.update(status='CLOSED_NO_TRADE', assessedAt=stamp)
                    event(state, old, 'CLOSED_NO_TRADE', at)
                continue
            if row.get('candidateDisposition') != 'WATCH' or row.get('expiresAt', 0) <= at:
                continue
            value = {**copy.deepcopy(row), 'id': digest([report.get('decisionId'), symbol, stamp]),
                     'decisionId': report.get('decisionId'), 'assessedAt': stamp, 'status': 'WATCHING',
                     'lastDeliveredAt': (old or {}).get('lastDeliveredAt'),
                     'lastDeliveredCandle': (old or {}).get('lastDeliveredCandle'),
                     'lastCheckedAt': None, 'checkStatus': 'NOT_CHECKED', 'executionAuthority': False}
            state['items'][symbol] = value
            event(state, value, 'REGISTERED', at)


def condition(row, observation, at):
    """No inferred side: a price threshold must hold for BOTH executable sides."""
    c = row['revisitCondition']
    if c['metric'] == 'closedCandleTime':
        t = observation.get('closedCandleTime')
        return (number(t) and 0 <= at-t <= 600000 and t < at and t > c['value'])
    b = observation.get('book') or {}
    if (not all(number(b.get(k)) for k in ('bid', 'ask', 'time'))
            or not 0 < b['bid'] <= b['ask'] or not 0 <= at-b['time'] <= MAX_QUOTE_AGE_MS):
        return False
    if c['metric'] == 'executableSpreadBps':
        return (b['ask']-b['bid']) / ((b['ask']+b['bid'])/2)*10000 <= c['value']
    if c['operator'] == 'LTE':
        return b['ask'] <= c['value']
    if c['operator'] == 'GTE':
        return b['bid'] >= c['value']
    return b['bid'] >= c['value'] and b['ask'] <= c['upperValue']


def observe(state, observations, at, blocked_symbols=()):
    for symbol, row in state['items'].items():
        if row['status'] not in ('WATCHING', 'READY', 'IN_FLIGHT'):
            continue
        if at >= row['expiresAt']:
            row['status'] = 'EXPIRED'
            event(state, row, 'EXPIRED', at)
            continue
        if row['status'] == 'IN_FLIGHT':
            continue
        if symbol in blocked_symbols:
            row['status'] = 'WATCHING'
            row['checkStatus'] = 'OWNED_OR_FROZEN_PLAN_MONITOR'
            continue
        obs = observations.get(symbol, {})
        row.update(lastCheckedAt=at, lastObservation=copy.deepcopy(obs))
        candle = int(at // 300000)*300000-1
        cooled = row.get('lastDeliveredAt') is None or at-row['lastDeliveredAt'] >= COOLDOWN_MS
        fresh_candle = row.get('lastDeliveredCandle') != candle
        ready = condition(row, obs, at) and cooled and fresh_candle
        row.update(status='READY' if ready else 'WATCHING',
                   checkStatus='TRIGGER_MET' if ready else 'WAITING_OR_STALE_OR_COOLDOWN')


def due(state):
    return sorted((r for r in state['items'].values() if r['status'] == 'READY'),
                  key=lambda r: (r.get('lastDeliveredAt') or 0, r['assessedAt'], r['symbol']))


def mark_dispatched(state, ids, jid, at):
    for row in state['items'].values():
        if row['id'] in ids:
            row.update(status='IN_FLIGHT', jobId=jid, lastDeliveredAt=at,
                       lastDeliveredCandle=int(at//300000)*300000-1)
            event(state, row, 'REASSESSMENT_DISPATCHED', at)


def finish(state, jid, at):
    for row in state['items'].values():
        if row.get('jobId') == jid and row['status'] == 'IN_FLIGHT':
            row['status'] = 'WATCHING' if at < row['expiresAt'] else 'EXPIRED'
            event(state, row, 'REASSESSMENT_FINISHED', at)


def summary(state):
    counts = {}
    for row in state['items'].values():
        counts[row['status']] = counts.get(row['status'], 0)+1
    return {'version': VERSION, 'counts': counts, 'freshCandidateSlots': 6,
            'maxAdditionalPerDispatch': MAX_EXTRA, 'overflowPolicy': 'DURABLE_FAIR_QUEUE',
            'executionAuthority': False, 'invalidationPolicy': 'MODEL_RECHECK_TEXT_BEFORE_PLAN_OR_ORDER'}


def context_limit(context):
    additional = any(r.get('watchReassessment') for r in context.get('marketCandidates', []))
    return 128000 if additional and context.get('watchQueue', {}).get('version') == VERSION else 64000


def fit_context(context, raw, fresh_symbols, at, limit=100000):
    """Keep every fresh candidate and owned/plan row; defer only extra WATCH rows.

    Reserve 28k for worker-added lessons, trial and reassessment snapshots. No
    price/cost/risk field is shortened to squeeze more candidates in a prompt.
    """
    import json
    from astra_quant_v4 import contract
    protected = set(fresh_symbols) | {p['symbol'] for p in raw['status'].get('active', [])}
    protected |= {p.get('frozenPlan', {}).get('symbol') for p in context.get('opportunities', [])}
    deferred = []
    while True:
        quant = contract(raw, at)
        preview = {**context, 'quantEvidence': {k: v for k, v in quant.items() if k not in ('rows', 'portfolio')}}
        if len(json.dumps(preview, allow_nan=False)) <= limit:
            break
        extra = [r for r in context['marketCandidates'] if r['symbol'] not in protected and r.get('watchReassessment')]
        if not extra:
            break  # existing baseline remains subject to unchanged worker guard
        last = extra[-1]
        context['marketCandidates'].remove(last)
        raw['rows'] = [r for r in raw['rows'] if r['symbol'] != last['symbol']]
        deferred.append(last['watchReassessment']['id'])
    return deferred


class WatchPoll:
    """Non-blocking public Testnet quote checks; never delays position protection."""
    def __init__(self, read=read_public):
        self.read = read
        self.worker = None
        self.messages = queue.Queue()
        self.next_at = 0
        self.observations = {}

    def _read(self, rows):
        def one(row):
            try:
                symbol = row['symbol']
                b = self.read('/fapi/v1/ticker/bookTicker', {'symbol': symbol})
                if b.get('symbol') != symbol:
                    raise ValueError('Wrong symbol')
                obs = {'book': {'bid': float(b['bidPrice']), 'ask': float(b['askPrice']), 'time': float(b['time'])}}
                if row['revisitCondition']['metric'] == 'closedCandleTime':
                    values = self.read('/fapi/v1/klines', {'symbol': symbol, 'interval': '5m', 'limit': 2})
                    # Last fully completed candle, never the open bar.
                    obs['closedCandleTime'] = float(values[-2][6])
                return symbol, obs
            except Exception:
                return row['symbol'], {'error': 'WATCH_PUBLIC_DATA_UNAVAILABLE'}
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.messages.put(dict(pool.map(one, rows)))

    def poll(self, state, at):
        if self.worker is not None and not self.worker.is_alive():
            self.observations = self.messages.get_nowait()
            self.worker = None
        rows = [copy.deepcopy(r) for r in state['items'].values()
                if r['status'] in ('WATCHING', 'READY') and r['expiresAt'] > at
                and r.get('checkStatus') != 'OWNED_OR_FROZEN_PLAN_MONITOR']
        if rows and self.worker is None and at >= self.next_at:
            self.next_at = at + POLL_MS
            self.worker = threading.Thread(target=self._read, args=(rows,), daemon=True, name='testnet-watch-poll')
            self.worker.start()
        return self.observations
