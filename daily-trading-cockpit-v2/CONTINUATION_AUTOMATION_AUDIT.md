# Continuation Automation Predeploy Audit

Date: 2026-08-26
Scope: Dynamic MOM36 V4 continuation data/training/champion lifecycle only. This audit does not
change admission, MOM36 breadth/ranking, strict SLOW_AND_FAST eligibility, basket exits, sizing,
or any existing basket.

## Current V4 runtime

The active Dynamic MOM36 strategy reads a V4 trajectory artifact through
`apps/api/src/lib/dynamic-mom36-continuation-runtime.ts` and evaluates it with the shared
TypeScript feature/runtime path:

```text
DirectionModelService.evaluate -> DirectionTrajectory.predict
```

The bootstrap artifact is deliberately known-good and pinned by both version and SHA-256:

```text
version: dm-36h-v4-20260824T153338Z
schema: 4
sha256: 4b49fd53aeb271185cd79f652f98ea1b50eb1395771cc6309a7a5964c9563114
feature schema: direction-model-features-v4-975c996
calibration: temperature-1.1
horizons: H6/H12/H24/H36
```

Its output is formation-only evidence. `dynamic-mom36-shock-strategy.ts` owns the frozen
interpretation: continuation can change base breadth by at most one adjacent rung and cannot veto,
select symbols, change SLOW_AND_FAST, or steer an open basket.

The common feature code is in `direction-model-features.ts`; it provides price/momentum, breadth,
structure, volatility, taker-flow, funding, BTC/ETH, venue agreement and options features. Labels
are the existing volatility-normalised H6/H12/H24/H36 labels plus deterministic V4 path classes.
The feature implementation is TypeScript for both matrix build and serving. The fitted tree runtime
is TypeScript in `direction-model-runtime.ts`.

## Existing offline training implementation

The historical V4 matrix builder and LightGBM exporter exist in the repository history introduced
by commit `975c996`:

```text
apps/api/scripts/build-direction-training-matrix-v3.ts
apps/api/scripts/train-trajectory-v4.py
```

They produce the current schema-4 trajectory artifact: four horizon specialists, OOF trajectory
head, validation-only temperature calibration and JSON tree export consumed by TypeScript. The
trainer is intentionally small and fixed-family (`num_threads=2`, two frozen configuration
families); it is not a hyperparameter search.

Those scripts are not present in the deployed V4 release tree, so they are being restored as part
of this canonical lifecycle. The lifecycle may not depend on an unversioned `/root/xsec-sim`
working copy.

## Legacy services discovered on the host

Two PM2 services currently run from `/root/xsec-sim`:

```text
kronos-collector  -> /root/xsec-sim/kronos_collector.py
kronos-lifecycle  -> /root/xsec-sim/run-lifecycle.sh -> kronos_lifecycle.py
```

They are useful evidence and have collected public derivatives/venue/options data, but they are
not an active V4 lifecycle:

1. `kronos_lifecycle.py` targets fixed August 23 release directories rather than either active
   V4 release.
2. Its `REPO` target is the same stale release tree; the active testnet/live V4 releases do not
   read those target paths.
3. The V4 runtime has a strict artifact SHA check, so an unregistered artifact copied by that
   process cannot become an active continuation model.
4. State is a mutable `lifecycle-state.json` with no immutable registry/history, no shared
   champion pointer, no compatible runtime dry-load, no lock, and no API visibility.
5. Its gate is only a tiny raw logloss comparison plus broad secondary tolerances. It does not
   enforce a meaningful minimum improvement, data manifest, mature-label cutoff, bootstrap
   uncertainty, temporal stability, calibration gate, or exact decision-level non-regression.
6. The legacy collector writes useful JSONL but lacks the required immutable event envelope,
   per-source watermarks, gap repair contract, quarantine, source-freshness policy, and canonical
   materialized snapshot for training/serving.

The legacy jobs are therefore classified as **UNTRUSTED SHADOW RESEARCH**. They must not be made
authoritative by toggling an environment flag or by copying a file into an old release. Historical
data can be imported with a manifest, but source records remain preserved and tagged as legacy
imports.

## Required migration architecture

The canonical lifecycle root is outside release directories and is explicitly shared by TESTNET
and LIVE:

```text
CONTINUATION_LIFECYCLE_ROOT=/root/kronos-continuation
  raw/                  append-only source envelopes
  quarantine/           invalid source rows with reason
  materialized/         atomically rebuilt runtime/training views
  snapshots/            immutable training inputs + manifests
  runs/                 run-local work and artifacts
  registry/artifacts/   immutable model bytes
  registry/history/     append-only run records
  registry/champion-pointer.json
  status/               collector/lifecycle health
  commands/             local-only operator requests
  locks/                single collector/trainer authority
```

The new runtime first validates `registry/champion-pointer.json`, the current artifact checksum,
schema, feature schema and parser. If current is corrupt it reads the previous approved artifact;
if the registry is unavailable it safely uses the known V4 bootstrap artifact. The trading API
never writes this registry. A pointer change affects only a later formation scan; every basket
persists its formation `continuationArtifactId` and remains immutable after entry.

## Gaps this implementation closes

| Area | Legacy state | Canonical lifecycle requirement |
| --- | --- | --- |
| Raw data | ad-hoc JSONL / legacy JSON views | immutable envelope, quarantine, source timestamps, watermarks |
| Collector | REST polling without an explicit recovery contract | WebSocket-primary completed-bar ingest plus REST startup/gap reconciliation |
| Feature path | V4 TypeScript code exists | one TS matrix/runtime feature implementation, fixed schema/hash |
| Labels | trainer can form forward labels | explicit H36 maturation cutoff and no immature-row training |
| Training | daily full rebuild in stale worktree | low-priority, locked, snapshot-manifested, retrain only after 7d + 168 mature rows |
| Evaluation | raw holdout logloss comparison | baseline/champion/challenger metrics, calibration, exact decision mapping, stability and bootstrap gates |
| Promotion | copies into stale releases | immutable artifact, checksum, dry-load, atomic shared pointer |
| Rollback | stale-file copy | validated previous-pointer rollback with runtime read-only failover |
| Visibility | PM2 logs / mutable JSON | TESTNET/LIVE read-only status and model endpoints |

## Predeploy verdict

**The existing V4 model runtime is reusable and safe to retain as the bootstrap champion.**

**The existing `/root/xsec-sim` collector/lifecycle is not safe to promote or wire into V4.** The
canonical lifecycle must be deployed separately, seeded with the verified V4 bytes, and allowed to
auto-train/evaluate/reject immediately. Auto-promotion may only occur after every strict gate
passes. Until then, the old champion remains active; no model is forced merely because a scheduled
run completed.
