# Kronos Research Tournament v1

This directory is a research-only, fail-closed backtest desk. It has no import
path from the runtime server or execution engines.

A valid archival input must supply:

- candle, funding, Expected-execution, and historical-universe artifact hashes;
- point-in-time universe snapshots proving listing, history, liquidity, spread,
  futures availability, and delisting status at every decision time;
- frozen current-Kronos signal and regime ledgers, each with its own source hash;
- point-in-time fee/slippage functions for `EXPECTED` execution.

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
manifest, immutable trade ledger, result, and append-only registry. Rank only
hard-gate survivors; do not use a raw weighted score as a promotion decision.

Do not infer historical-universe eligibility from today's exchange listing or
from candle availability. Until a historical point-in-time universe artifact is
provided, the intended outcome is a blocked run rather than a result.

The locally archived 2026-01 through 2026-06 BTCUSDT/ETHUSDT candles and
funding rows are useful raw inputs, but they are not that artifact: they carry
neither decision-time listing/delisting state nor volume, spread, futures
availability, execution-liquidity, or frozen-Kronos signal/regime ledgers.
