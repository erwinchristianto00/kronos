# Runtime Reconciliation - 2026-08-01

## Scope

This reconciliation creates a clean release from the canonical Git branch after
capturing the legacy 3101 and 3102 runtime trees. It does not place runtime
data, environment files, logs, locks, generated output, or dependency caches
under source control.

## Immutable Evidence

- Backup root: `/root/release-backups/reconcile-20260801T113036Z`
- 3101 archive: `3101-source-config-runtime-data.tar.gz`
- 3102 archive: `3102-source-config-runtime-data.tar.gz`
- Both archive checksums were verified before release preparation.

The archives retain legacy source, configuration, Git metadata where present,
and runtime stores. They intentionally exclude reproducible dependency and
build artifacts: `node_modules`, TypeScript/Vite output, and Python virtual
environments. Legacy runtime directories are also retained unchanged as
rollback targets.

## Classification

| Class | Decision |
| --- | --- |
| Canonical source and policy/schema changes | Keep the Git source at this release commit. |
| Legacy modified/untracked source | Preserve only in the immutable archives; do not copy it into the release. |
| Deployment configuration | Recreate from the clean checkout, then copy the existing instance `.env` outside Git. |
| Runtime data/evidence/registries | Copy outside Git into each instance release data directory. |
| Logs, PID/lock files, generated output, `node_modules`, Python virtualenvs, AppleDouble `._*`, and Claude scratch files | Exclude from the release and Git. |

## Source Review Result

The legacy 3101 tree was based on `1a0d333` and contained 125 tracked changes
plus 352 untracked entries. The 3102 tree had no Git worktree. A source-only
comparison against the canonical release found that the canonical branch
already contains the current CORTEX/Four-Brain implementation, including the
operator, its provenance closure, and the forward-causal dependencies absent
from both legacy runtimes.

The only legacy-only TypeScript lane files were `fade-long-edge.ts`,
`h6-trend-edge.ts`, and `microstructure-feature-collector.ts`. They are not in
the CORTEX operator import closure and are superseded by the canonical
microstructure and research paths. They remain archived for audit and are not
silently promoted into the release.

## Release Rule

Only this canonical commit may seed the release directories. Each runtime must
be started from its own clean Git checkout. The operator must run dry before its
first audit commit; 3102 must remain disarmed throughout the cutover.
