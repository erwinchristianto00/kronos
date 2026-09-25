"""Task-fixed routing. No fallback, automatic effort escalation or trading authority."""
from astra_router_v9 import classify_provider_error, identity

FAST_TRADING = 'FAST_TRADING'
COACHING = 'COACHING'
DEEP_REVIEW = 'DEEP_REVIEW'
PRIMARY = 'PRIMARY'
FALLBACK = 'FALLBACK'
ESCALATION = 'ESCALATION'
TASKS = (FAST_TRADING, COACHING, DEEP_REVIEW)
VERSION = 'SONNET_MEDIUM_OPUS_REVIEW_V1'
COHORT = 'HERMES_QUANT_V4_SONNET_ROUTING_V1'
POLICIES = {
    (FAST_TRADING, PRIMARY): {'task':FAST_TRADING,'role':PRIMARY,'model':'claude-sonnet-5','provider':'anthropic','effort':'medium'},
    (COACHING, PRIMARY): {'task':COACHING,'role':PRIMARY,'model':'claude-opus-5','provider':'anthropic','effort':'high'},
    (DEEP_REVIEW, PRIMARY): {'task':DEEP_REVIEW,'role':PRIMARY,'model':'claude-opus-5','provider':'anthropic','effort':'max'},
}


def policy(task, role=PRIMARY):
    if (task, role) not in POLICIES:
        raise ValueError('Undeclared fixed model policy: '+str(task)+'/'+str(role))
    return dict(POLICIES[task, role])


def is_declared(spec):
    return isinstance(spec, dict) and POLICIES.get((spec.get('task'),spec.get('role'))) == spec


class Router:
    def __init__(self, state, now):
        if state and state.get('modelPolicyVersion') != VERSION:
            raise ValueError('Legacy routing state requires explicit cohort migration')
        if not state:
            state.update(modelPolicyVersion=VERSION, routerState='SONNET_PRIMARY',
                         primaryModel='claude-sonnet-5', currentProvider='anthropic',
                         primaryFailureReason=None, routerStateChangedAt=now())
        if (state.get('routerState') != 'SONNET_PRIMARY' or state.get('primaryModel') != 'claude-sonnet-5'
                or state.get('currentProvider') != 'anthropic'):
            raise ValueError('Fixed routing identity mismatch')
        self.state, self.now = state, now

    def policy_for(self, task, opportunity_key=None):
        return policy(task)

    def record_result(self, spec, error):
        if not is_declared(spec):
            raise ValueError('Undeclared result policy')
        if spec['task'] == FAST_TRADING:
            self.state.update(primaryFailureReason=classify_provider_error(error), lastResultAt=self.now())

    def snapshot(self):
        return dict(self.state)
