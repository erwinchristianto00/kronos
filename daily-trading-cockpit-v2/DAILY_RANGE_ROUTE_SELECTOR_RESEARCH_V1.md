# Daily Range route-selector research V1

Research date: 2026-08-27. Objective: determine whether an alpha selector can receive allocation authority. It does not alter the exact `AUTO_ROUTE_NY_V2` router.

## Required research contract

The candidate replay must preserve:

- NY 00:00–04:00 reference range, completed 5-minute router state, and exact Continuation/Fade direction;
- structural stop and exact 2R target;
- same-batch/all-symbol discovery before top-N allocation;
- TP-before-SL labels with 1-minute tie disambiguation, otherwise `OUTCOME_AMBIGUOUS`;
- chronological IS/validation/OOS splits and day/batch-aware bootstrap;
- full selection-portfolio comparison against loop order, seeded comparator, and the V3 economic baseline.

No end-of-day label, post-entry quote, future candle, or fabricated BBO may be used.

## Available canonical data audit

The checked local canonical archive contains monthly USD-M 1-hour candle panels and isolated BTC/ETH quote samples. It does **not** contain sufficient canonical 5-minute, multi-symbol, 180-day data for the Daily Range router and candidate batches. The 5-minute data required to reconstruct the NY session, C1/C2 state machine, and 1-minute barrier ordering is absent.

| Dataset class | available | usable for selector training |
| --- | --- | --- |
| current runtime forward snapshots | yes | forward collection only |
| historical 1-hour USD-M panels | yes | no: cannot reconstruct C1/C2 or barriers |
| isolated BTC/ETH quote samples | yes | no: not candidate BBO coverage |
| 180-day all-symbol 5-minute + 1-minute panel | no | no |
| historical candidate BBO for full PIT | no | no |

Any candle-only future replay, once a suitable 5-minute panel exists, must be labelled `RECONSTRUCTED_CANDLE_PIT`; it cannot claim historical BBO truth. The required data supports neither a `FULL_PIT` historical candidate set nor a valid alpha promotion today.

## Result

| item | result |
| --- | --- |
| historical FULL_PIT candidates | 0 available from current archive |
| historical model fit | not run; insufficient valid data |
| calibration / temporal OOS | not run; no valid fit |
| alpha authority | **REJECTED** |
| runtime alpha state | `SHADOW_ONLY` / no selector ID |
| execution allocator | `ECONOMIC_QUALITY_BASELINE` |

The V3 code persists causal forward feature snapshots, route, BBO timing, economics, and eventual barrier outcomes for every candidate. Those forward records are the legitimate cohort for later selector evaluation.

## Promotion gate (not met)

Alpha may become `VALIDATED_ALPHA_SELECTOR` only after all of the following:

1. complete historical data and walk-forward evidence meet the documented promotion gates;
2. a calibrated route-specific artifact produces positive expected net USD only;
3. at least 20 mature `FULL_PIT` oversubscribed forward batches exist under the current policy;
4. the selection portfolio beats the economic baseline robustly rather than through one symbol/order path;
5. an operator explicitly approves the first Mainnet alpha promotion.

Until then, a shadow value is diagnostic only. It has zero effect on symbol selection, route, direction, stop, target, size, or order submission.
