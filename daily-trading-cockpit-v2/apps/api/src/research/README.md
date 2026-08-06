# Kronos Research Tournament v1

This directory is a research-only, fail-closed backtest desk. It has no import
path from the runtime server or execution engines.

## Capability tiers

| Tier | Required Foundry inputs | Allowed claim |
|---|---|---|
| `TIER_1_BASELINE` | candles, PIT universe, actual funding settlements, canonical episodes, PIT portfolio risk | conservative simple-baseline comparison only |
| `TIER_2_EXPECTED_EXECUTION` | Tier 1 plus PIT liquidity/spread and fee artifacts | execution-sensitivity results for simple strategies |
| `TIER_3_EXACT_KRONOS` | Tier 2 plus frozen Kronos decision ledger | exact Kronos incremental-value comparison and ablations |

Tier 1 accepts only Conservative execution. Current Kronos cannot be run below
Tier 3. Missing artifact kinds fail manifest creation, so a report cannot claim
more evidence than its Foundry inputs supply.

A valid archival input must supply:

- candle, funding, Expected-execution, and historical-universe artifact hashes;
- point-in-time universe snapshots proving listing, history, liquidity, spread,
  futures availability, and delisting status at every decision time;
- frozen current-Kronos signal and regime ledgers, each with its own source hash;
- point-in-time fee/slippage functions for `EXPECTED` execution.

## Dataset Foundry semantics

Every artifact is validated as schema `v1` before it receives a manifest. The
validator rejects malformed/unknown rows, non-normalized symbols, invalid OHLC,
non-finite values, duplicate keys, unordered timestamps, invalid effective
bounds, and unknown schema versions. Coverage is derived from rows against an
explicit expected contract: symbols, cadence, gaps, funding settlement gaps,
and PIT snapshot age are recorded exactly. Caller-declared completeness is not
accepted.

Artifacts persist both `rowsHash` and `semanticManifestHash`. The latter binds
kind, schema, source, generation SHA/time, units, expected and derived coverage,
range, row count, and `rowsHash`; tournament manifests reference semantic hashes.
The canonical experiment clock is `dataRange × timeframeMs`: every eligible
symbol needs a completed candle or a sourced validated absence on each tick.

`runTournamentMatrix` runs CASH, BTC hold, equal-weight hold, Donchian, MACD,
EMA, RSI, random timing control, and frozen current Kronos under one supplied
data/risk/execution contract. `withKronosRegimeGate` provides the paired
Donchian/MACD regime ablations. `runWalkForwardTournament` exposes only the
training slice to its tuner and keeps the sealed holdout out of all folds.

`CONSERVATIVE` is the governance mode. `OPTIMISTIC` is diagnostic only.
`EXPECTED` fails without a point-in-time execution model. Random controls fail
unless their planned count, direction mix, templates, sizing inputs, and
concurrency distribution match the frozen reference plan.

Persist each `TournamentRunResult` through `persistTournamentRun` to write the
manifest, immutable trade ledger, fixed-interval NAV ledger, result, and
append-only registry. NAV return series—not trade-close returns—drives Sharpe,
drawdown, and Calmar. Funding accrues only from exact settlement rows. Rank only
hard-gate survivors; do not use a raw weighted score as a promotion decision.

Do not infer historical-universe eligibility from today's exchange listing or
from candle availability. Until a historical point-in-time universe artifact is
provided, the intended outcome is a blocked run rather than a result.

The locally archived 2026-01 through 2026-06 BTCUSDT/ETHUSDT candles and
funding rows are useful raw inputs, but they are not that artifact: they carry
neither decision-time listing/delisting state nor volume, spread, futures
availability, execution-liquidity, or frozen-Kronos signal/regime ledgers.

`local-binance-archive-adapter.ts` can turn those CSV exports into deterministic
candle/funding Foundry artifacts and `tier1-capability.ts` reports their exact
Tier-1 blockers. It never invents unavailable listing, eligibility, episode, or
portfolio-risk history.
