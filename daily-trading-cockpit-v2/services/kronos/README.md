# Kronos Service

This service wraps the official [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) model behind the scanner's `POST /predict` contract.

Current behavior:

- uses the official Kronos repository vendored in `services/kronos/vendor/Kronos`
- loads the Hugging Face tokenizer and model on startup when dependencies are installed
- returns explicit `available: false` when the model or dependencies are unavailable
- never emits placeholder predictions

## Quick start

```powershell
.\setup.ps1
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001
```

Or run the equivalent manually:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

## Endpoints

- `GET /health`
- `POST /predict`

`/health` reports `modelConnected: true` only when the official Kronos model has loaded successfully.

## Environment

Optional variables:

- `KRONOS_MODEL_ID` default `NeoQuasar/Kronos-small`
- `KRONOS_TOKENIZER_ID` default `NeoQuasar/Kronos-Tokenizer-base`
- `KRONOS_SAMPLE_RUNS` default `2` for scan latency; raise it for slower, more stable manual diagnostics
- `KRONOS_DEVICE` optional override such as `cpu` or `cuda:0`
- `KRONOS_MAX_CONTEXT` default `512`
- `KRONOS_PRED_LEN` default `6`

## Prediction notes

The wrapper feeds real OHLCV candles into the official Kronos predictor and derives:

- `expectedReturn3`
- `expectedReturn6`
- `expectedVolatility`
- `kronosLongProbability`
- `kronosShortProbability`
- `kronosConfidence`
- `kronosRisk`

The probability-style fields are forecast-derived wrapper metrics based on the real predicted price path. If the model cannot produce a valid forecast, the service returns `available: false` instead of synthetic neutral output.
