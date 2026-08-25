# Continuation Champion / Challenger Policy

## Baseline

The bootstrap champion is immutable V4:

```text
dm-36h-v4-20260824T153338Z
SHA-256 4b49fd53aeb271185cd79f652f98ea1b50eb1395771cc6309a7a5964c9563114
feature schema direction-model-features-v4-975c996
```

It is not replaced merely because a retrain completes. Candidate and champion are evaluated on the
same newest mature chronological holdout, after a 36-hour purge/embargo. The base-rate path
predictor and `NO_EDGE` behavior remain comparators.

## Strict direct auto-promotion

Default mode is `AUTO_PROMOTION_STRICT_GATE`. All gates below must pass:

| Gate | Requirement |
| --- | --- |
| DATA_INTEGRITY | all required completed Binance streams healthy; immutable snapshot valid |
| FEATURE_PARITY | exact frozen feature schema/hash, Python export fidelity <= 1e-6, and deterministic Python-to-TypeScript holdout inference parity |
| NO_LEAKAGE | feature timestamps at/before formation and labels at/before frozen mature cutoff |
| SUFFICIENT_SAMPLES | >=2,700 mature rows, >=500 newest holdout rows, >=168 new mature rows |
| BASE_RATE | candidate trajectory loss no worse than base rate by more than 0.5% |
| PRIMARY_IMPROVEMENT | candidate trajectory logloss at least 0.5% lower than champion |
| CALIBRATION | trajectory ECE does not deteriorate by more than 0.01 |
| DECISION_LEVEL | exact V4 plus/minus one-rung mapping does not become >5pp more active than champion, never >50% tilt, and signed decision returns do not materially regress |
| TEMPORAL_STABILITY | >=3 monthly blocks, >=60% non-regressing, worst monthly loss delta <=0.05 |
| BOOTSTRAP_UNCERTAINTY | 36-hour block-bootstrap 97.5% loss-delta bound remains below zero |
| RUNTIME_DRY_LOAD | TypeScript parses the candidate and sampled probabilities/outputs are finite and normalized |

`candidate - champion` loss must therefore be negative on the point estimate and its upper
time-block bootstrap confidence bound. A numerical tie such as `1.83940` versus `1.83939` is
rejected. Calibration or generic accuracy cannot override this policy.

When auto-promotion is disabled through the loopback command queue, collection/training/evaluation
still occur and a fully passing artifact becomes `PROMOTION_CANDIDATE`; no pointer changes.

## Artifact registry and rollback

Artifacts are copied once under SHA-derived immutable names. Each metadata record contains its
artifact ID/SHA, V4 schema, feature hash/schema, label version, calibration, trained/cutoff times,
snapshot hash, run ID and metrics. The only mutable authority is the atomically replaced pointer:

```text
current approved champion
previous approved champion
```

On a successful promotion the lifecycle writes artifact bytes, validates checksum/parser/dry load,
then atomically advances the pointer. TESTNET and LIVE consume that same pointer on future
formation only. An open basket retains its stored artifact identity and exit fingerprint.

Operational corruption, parser failure or unreadable current bytes triggers failover to previous;
the lifecycle may atomically make that known-good previous record current. No PnL threshold,
winning/losing streak, or recent basket result can cause automatic rollback or a policy change.
