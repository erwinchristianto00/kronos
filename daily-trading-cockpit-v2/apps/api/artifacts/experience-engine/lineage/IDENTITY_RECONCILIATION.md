# Identity reconciliation

Decision-log importer repair: route-assigned records are now imported with deterministic `candidateId` and raw numeric pre-open features. Paper orders now expose `sourceCandidateId` as an attempted exact join key. It does not equal a decision-log `candidateId` in this corpus, so it remains `NO_ELIGIBLE_PRE_OPEN_DECISION`; no fuzzy time/symbol join was used. Outcome identities are unique: **PASS**.
