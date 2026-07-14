# Forward collection requirements

To resolve the actual top funnel buckets, forward collection must write immutable `decisionId`, `asOfMs`, lane, symbol/basket, direction, feature schema + feature snapshot with per-feature availability, `outcomeId`, `openedAtMs`, market `closedAtMs`, `resolvedAtMs`, and attribution schema. This directly resolves MISSING_DECISION_SNAPSHOT and NO_ELIGIBLE_PRE_OPEN_DECISION; no extra arbitrary telemetry is proposed. Existing 3101/3102 shadow journals should carry these fields, but this phase does not authorize changing them.
