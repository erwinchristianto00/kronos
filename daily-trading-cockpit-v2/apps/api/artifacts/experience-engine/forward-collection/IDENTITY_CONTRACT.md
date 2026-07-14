# Identity Contract

`CausalIdentity` is versioned as `causal-lineage-1` and contains `decisionId`, `opportunityId`, `outcomeId`, `instanceId`, `laneId`, `symbolOrBasketId`, `direction`, feature schema, decision rule, and attribution rule versions.

`decisionId` is created once at paper-opportunity construction from semantic source identity, market decision time, lane, symbol, direction, and instance. `opportunityId` is created once from the persisted paper order identity. `outcomeId` is deterministic from the persisted opportunity identity and market-close result. No display label or time-nearest lookup is used.
