# Opportunity To Outcome Link

After the existing paper resolver writes terminal `closedAtMs` from the triggering market candle and `resolvedAtMs` from process time, it stamps a deterministic `outcomeId` in the additive identity field and appends one outcome event. The audit follows `outcome.opportunityId -> opportunity.decisionId -> decision.decisionId`; no fallback is used for eligibility.

Orders without market close time, valid R values, or direct identity remain incomplete and ineligible.
