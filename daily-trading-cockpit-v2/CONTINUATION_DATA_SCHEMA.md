# Continuation Data Contract

## Canonical raw envelope

Every new raw record is append-only JSONL and has this contract:

```json
{
  "schemaVersion": 1,
  "source": "binance-usdm",
  "symbol": "BTCUSDT",
  "dataType": "kline_1h",
  "eventTimestampMs": 0,
  "receivedTimestampMs": 0,
  "sourceRecordId": "BTCUSDT:1h:...",
  "payload": {}
}
```

Invalid schema, timestamps, prices, OHLC relationships, symbol values or non-finite numbers are
quarantined rather than coerced. Materialized views deduplicate by source timestamp and are written
by temp-file plus rename, so a training snapshot sees a complete old or complete new file.

The legacy `/root/xsec-sim/raw` data is copied under `legacy-raw/xsec-sim/` with an import manifest.
It remains historical evidence, not a falsely relabelled canonical envelope. Its V4-compatible
JSON views are separately copied into `materialized/` after SHA verification.

## Sources and status

| Source | Data | Status | Training role now |
| --- | --- | --- | --- |
| Binance USD-M | completed 1m/5m/1h OHLCV and taker-buy volume for the exact 20-symbol V4 population plus BTC/ETH anchors | required | V4 1H price/flow foundation |
| Binance USD-M | funding, mark/index premium, OI, taker ratio | optional | frozen V4 funding route; other data diagnostic |
| Bybit/OKX/Coinbase | 1H price and volume for existing symbols | optional | existing V4 venue-agreement route |
| OKX | filled liquidations | optional | forward diagnostic only |
| Deribit | BTC/ETH DVOL | optional | existing V4 options route |

Required means only completed Binance price streams for the full V4 cross-sectional universe.
Optional outages preserve explicit missing inputs; they do not become zero or forward-filled values.
If a required stream is stale/gapped, training skips. Runtime continuation resolves to `NO_EDGE` on
an incompatible/missing model; base MOM36 stays governed by its existing safety path.

## Freshness and gap repair

Watermarks record event/receive/validated timestamps, cumulative gaps, unresolved gaps,
duplicates, invalid rows and last error. A WebSocket discontinuity is `GAPPED` until REST has
covered the first missing interval through the latest completed candle. The cumulative counter is
never erased; only `unresolvedGapCount` returns to zero after repair.

## PIT and feature schema

`direction-model-features.ts` is the canonical feature implementation for matrix build and runtime.
Every matrix row contains `formationTimestampMs`, `maxFeatureSourceTimestampMs` and
`baseLongCount` as audit metadata. The invariant is:

```text
maxFeatureSourceTimestampMs <= formationTimestampMs
formationTimestampMs <= frozen label cutoff
```

Current primary schema is `direction-model-features-v4-975c996`, with the model feature-list hash
stored in every artifact. The primary feature set is frozen. A newly accumulated OI/basis,
liquidation or other family is captured and health-reported, but cannot silently enter the primary
model. It requires an explicit, versioned feature-set challenger and the same promotion gates.

Labels remain the frozen volatility-normalized common-market H6/H12/H24/H36 returns and the eight
deterministic path classes. A formation cannot enter a training matrix until all four labels mature.
`status/label-maturation.json` persistently exposes the rolling `PENDING_LABEL -> MATURE` frontier
(common completed candle, mature-through timestamp and first still-pending timestamp); it is an
audit state, never a fabricated forward label store.
