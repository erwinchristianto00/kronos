# Source joinability matrix

| Source | Stable record ID | Decision link | Pre-open features | Open | Close | Resolution | Lane/symbol/direction |
|---|---|---|---|---|---|---|---|
| decision-log.jsonl | candidateId | candidateId | PRESENT (imported) | absent | absent | absent | symbol/direction, lane absent |
| regime-controller-aligned-shadow.json | id | absent | absent | PRESENT | PRESENT for closed rows | same as market close | PRESENT |
| paper-execution-router.json | paperOrderId | sourceCandidateId (not exact match) | partial context, no immutable feature vector | PRESENT | absent for open rows | processing timestamp only | PRESENT |
| kronos-counterfactual-observations.json | observationId | absent | nested snapshot, no stable upstream decision id | mostly absent | absent | absent | PRESENT |
| regime-direction-controller-snapshots.jsonl | no stable decision id | absent | regime-only | absent | absent | absent | no symbol/lane |

No display-text or time-nearest join is permitted.
