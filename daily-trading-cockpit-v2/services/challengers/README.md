# Forecast Challengers

Serialized CPU-only sidecar for Chronos-2-small and TimesFM 2.5. It only emits
advisory forecasts for CORTEX/Four-Brain; it has no exchange credentials and no
execution capability.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --index-url https://download.pytorch.org/whl/cpu 'torch==2.6.0+cpu'
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8002
```

All model loading and inference shares one process-wide lock. The Node side calls
only the BTC anchor on a staggered twenty-minute cadence, so models do not run
concurrently or compete with the scan loop. Python 3.10+ is required.
