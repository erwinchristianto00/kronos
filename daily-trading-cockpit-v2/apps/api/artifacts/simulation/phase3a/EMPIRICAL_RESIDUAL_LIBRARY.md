# Empirical residual library

Library records include synchronized timestamp, UTC hour/day provenance, regime/volatility/dependence state, BTC/ETH residuals, relative volatility, BTC/ETH volume changes, and empirical OHLC wick geometry. Funding and mark-basis are marked UNSUPPORTED because the candle corpus does not observe them.

Calibration snapshots:

```json
[
  {
    "fold": {
      "evalMonth": "03",
      "trainMonths": [
        "01",
        "02"
      ]
    },
    "residualRecords": 1391
  },
  {
    "fold": {
      "evalMonth": "04",
      "trainMonths": [
        "01",
        "02",
        "03"
      ]
    },
    "residualRecords": 2135
  },
  {
    "fold": {
      "evalMonth": "05",
      "trainMonths": [
        "01",
        "02",
        "03",
        "04"
      ]
    },
    "residualRecords": 2855
  },
  {
    "fold": {
      "evalMonth": "06",
      "trainMonths": [
        "01",
        "02",
        "03",
        "04",
        "05"
      ]
    },
    "residualRecords": 3599
  }
]
```
