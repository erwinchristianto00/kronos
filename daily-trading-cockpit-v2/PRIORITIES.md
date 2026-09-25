# Cross basket improvement priorities

Recorded 2026-09-05 at the operator's request. Scope: TESTNET only; LIVE, Daily, Copy Sleeve and frozen existing basket policies remain unchanged.

1. **IN PROGRESS — Finish qualified alternative selection.** Fully validate baseline before preference, reuse final admission/scoreGap on alternatives, preserve exact baseline when no admissible alternative exists, restore effective pool deepening, and prove selection reaches actual executor order plans and persisted provenance. Work in a new release. Build/test the final source and use a guarded Testnet cutover preserving positions and old policy state.
2. **QUEUED — Verify basket protection and closing reliability.** Frozen initial notional, realized plus residual PnL, fresh executable quotes, durable close intent, restart/partial-close reconciliation. No implementation in the priority-1 change.
3. **QUEUED — Four completed 1h candles as a selection experiment.** Diagnose relative LONG-minus-SHORT spread trajectory; compare to baseline before adding mandatory gates. No threshold tuning to one incident.
4. **QUEUED — Measure LONG/SHORT risk imbalance.** Volatility, market sensitivity, and basket sizing within a fixed risk budget. Separate experiment from preference.

Later: 7d/30d context; ATH lower priority. Do not add RSI/MACD or change MOM36 during priority 1.

Evaluation: net expectancy, drawdown/tail loss, fees, giveback, recoveries cut short, comparable entry opportunities. A/B/C/D replay remains a separate required evidence item before calling the overall profit-protection experiment complete; wiring alone is not proof of improved returns.
