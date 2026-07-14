# Lineage completion stop report

1. Input/reconciled records: **2884/2884**.
2. Rejection funnel: `REJECTION_FUNNEL.md`.
3. Importer fixes: exact decision-log and paper attempted-link adapters, offline only.
4. Permanently unavailable in current history: aligned-shadow decision IDs/pre-open features; row-level historical replay; market close for open paper/counterfactual records.
5. Unsafe reconstructions rejected: final aggregates, processing timestamps, fuzzy text/time joins.
6. Complete real chains: **0**; fixture chains: 1.
7. Eligible A/B/C: **0/0/0**.
8. Idempotency: outcome identities unique=true; deterministic audit hash=9a2d38aabdd8da993ad9bcf87c327530913a427abf78dae7c7802c26e4d1e26a.
9. Timestamp validation: {"INCOMPLETE":2884}.
10. Provenance: synthetic/stress was never imported as a learning source.
11. Focused tests passed (9/9); TypeScript build passed; full API suite passed (202 files, 3,687 tests).
12. Authority isolation: script imports no executor, CORTEX store, beta, route, deployment, or VPS code.

Recommended next step: separately authorize forward-only shadow journal collection with the listed stable identity and market-time fields; do not train candidates until at least one real chain passes unchanged frozen gates.
