"""Host-only common-policy transition; never a model tool or profitability promotion."""
import copy
from astra_experiments import ExperimentBook


def prepare(root, new_hash, reason, now):
    if not isinstance(new_hash, str) or len(new_hash) != 64 or any(c not in '0123456789abcdef' for c in new_hash):
        raise ValueError('Expected SHA256 policy hash')
    if not isinstance(reason, str) or not 20 <= len(reason) <= 600:
        raise ValueError('Explicit migration reason required')
    book = ExperimentBook(root, None, now=lambda: now)
    old_hash, old_champion = book.state['basePolicyHash'], book.state['champion']
    if old_hash == new_hash:
        raise ValueError('Policy already adopted; do not reset or relabel evidence')
    # Plan the entire transition in memory. Persist exactly once after cutover checks.
    book.state = copy.deepcopy(book.state)
    book.save = lambda: None
    active = book.active()
    if active:
        book.invalidate(active['id'], 'PROTOCOL', reason)
    baseline = 'baseline_' + new_hash[:16]
    if baseline in book.state['versions']:
        raise ValueError('Historical baseline already exists; explicit recovery required')
    book.state['versions'][baseline] = {'id': baseline, 'kind': 'BASELINE',
        'basePolicyHash': new_hash, 'createdAt': now,
        'description': 'Executable-search common-policy revision. Operator adoption, NOT earned promotion; profitability unproven.'}
    event = {'at': now, 'type': 'COMMON_POLICY_MIGRATION', 'reason': reason,
        'oldPolicyHash': old_hash, 'newPolicyHash': new_hash,
        'previousChampion': old_champion, 'champion': baseline,
        'previousWatch': copy.deepcopy(book.state.get('watch')),
        'resumeAfterMs': (now // 300000 + 1) * 300000,
        'verdict': 'UNPROVEN_POLICY_CHANGE_NOT_PROFITABILITY_PROMOTION'}
    book.state.update(basePolicyHash=new_hash, champion=baseline, watch=None)
    book.state['events'].append(event)
    return book, event
