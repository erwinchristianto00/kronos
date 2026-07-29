"""Serialized CPU forecast sidecars for Chronos-2 and TimesFM.

All model inference shares one lock. The process never trades and exposes no credentials;
it only converts OHLCV close history into a normalized forecast opinion consumed by
the testnet Four-Brain layer.
"""
from __future__ import annotations

import gc
import math
import os
import threading
import time
from dataclasses import dataclass
from typing import Literal

import numpy as np
import torch
from fastapi import FastAPI
from pydantic import AliasChoices, BaseModel, Field


# A 7.8 GB CPU VPS must never load/infer the two forecasters concurrently. This
# lock covers both lazy-load and prediction so the API can queue one request
# safely instead of allowing a memory/CPU spike during scheduled refreshes.
INFERENCE_LOCK = threading.Lock()


class Candle(BaseModel):
    # @dtc/shared names the candle clock `openTime`; accept `timestamp` too so
    # direct sidecar callers can use the conventional field name.
    timestamp: int = Field(validation_alias=AliasChoices("timestamp", "openTime"))
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None


class PredictRequest(BaseModel):
    symbol: str = Field(min_length=3, max_length=30)
    timeframe: Literal["5m", "15m", "1h"]
    candles: list[Candle] = Field(min_length=32, max_length=2048)


class PredictResponse(BaseModel):
    available: bool
    model: Literal["chronos2", "timesfm"]
    bias: Literal["LONG", "SHORT", "NEUTRAL"] | None = None
    confidence: float | None = None
    expectedReturn: float | None = None
    volatility: float | None = None
    probabilityUp: float | None = None
    probabilityDown: float | None = None
    generatedAtMs: int | None = None
    reason: str | None = None


@dataclass
class ModelStatus:
    connected: bool = False
    message: str = "not loaded"


def _device() -> str:
    # CPU-only by default. A GPU is an explicit operator decision, never an accidental VPS dependency.
    configured = os.getenv("CHALLENGER_DEVICE", "cpu")
    return "cuda" if configured.startswith("cuda") and torch.cuda.is_available() else "cpu"


def _validate(request: PredictRequest) -> np.ndarray:
    closes = np.asarray([row.close for row in request.candles], dtype=np.float64)
    timestamps = [row.timestamp for row in request.candles]
    if not np.isfinite(closes).all() or np.any(closes <= 0):
        raise ValueError("candles contain non-positive or non-finite close")
    if any(right <= left for left, right in zip(timestamps, timestamps[1:])):
        raise ValueError("candle timestamps must be strictly increasing")
    return closes


def _opinion(model: Literal["chronos2", "timesfm"], closes: np.ndarray, forecast: np.ndarray) -> PredictResponse:
    last = float(closes[-1])
    path = np.asarray(forecast, dtype=np.float64).reshape(-1)
    if path.size == 0 or not np.isfinite(path).all() or last <= 0:
        return PredictResponse(available=False, model=model, reason="model returned an invalid forecast path")
    expected_return = float(path[-1] / last - 1)
    volatility = float(np.std(path / last - 1))
    # A conservative confidence derived only from signal-to-path-dispersion. This is not a calibrated
    # probability, so it is capped and CORTEX treats it as a challenger feature, never an authorization.
    scale = max(volatility, 0.001)
    signed_strength = expected_return / scale
    confidence = max(0.0, min(80.0, abs(signed_strength) * 20.0))
    if confidence < 8.0:
        bias = "NEUTRAL"
    else:
        bias = "LONG" if expected_return > 0 else "SHORT"
    probability_up = max(1.0, min(99.0, 50.0 + math.tanh(signed_strength) * 35.0))
    return PredictResponse(
        available=True,
        model=model,
        bias=bias,
        confidence=round(confidence, 4),
        expectedReturn=round(expected_return, 8),
        volatility=round(volatility, 8),
        probabilityUp=round(probability_up, 4),
        probabilityDown=round(100.0 - probability_up, 4),
        generatedAtMs=int(time.time() * 1000),
    )


class Chronos2Runner:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.status = ModelStatus()
        self.pipeline = None

    def _load(self) -> None:
        if self.pipeline is not None:
            return
        from chronos import Chronos2Pipeline

        model_id = os.getenv("CHRONOS2_MODEL_ID", "autogluon/chronos-2-small")
        self.pipeline = Chronos2Pipeline.from_pretrained(model_id, device_map=_device())
        self.status = ModelStatus(True, f"{model_id} loaded on {_device()}")

    def predict(self, request: PredictRequest) -> PredictResponse:
        with INFERENCE_LOCK, self.lock:
            try:
                closes = _validate(request)
                self._load()
                horizon = max(3, min(12, int(os.getenv("CHALLENGER_HORIZON", "6"))))
                # Use Chronos-2's tensor API rather than predict_df. It avoids
                # pandas dtype normalization differences across releases and is
                # the natural fit for one univariate BTC close series.
                predictions = self.pipeline.predict(
                    [closes],
                    prediction_length=horizon,
                )
                if len(predictions) != 1:
                    raise ValueError(f"Chronos-2 returned {len(predictions)} series for one input")
                quantiles = list(self.pipeline.quantiles)
                median_index = quantiles.index(0.5)
                # shape = (variates=1, model quantiles, horizon).
                median = predictions[0][0, median_index].detach().cpu().numpy()
                return _opinion("chronos2", closes, median)
            except Exception as error:  # sidecar must report failure, never crash FastAPI
                self.status = ModelStatus(False, str(error))
                return PredictResponse(available=False, model="chronos2", reason=str(error))


class TimesFmRunner:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.status = ModelStatus()
        self.model = None

    def _load(self) -> None:
        if self.model is not None:
            return
        import timesfm

        model_id = os.getenv("TIMESFM_MODEL_ID", "google/timesfm-2.5-200m-pytorch")
        self.model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(model_id)
        self.model.compile(timesfm.ForecastConfig(
            max_context=1024,
            max_horizon=max(3, min(64, int(os.getenv("CHALLENGER_HORIZON", "6")))),
            normalize_inputs=True,
            use_continuous_quantile_head=True,
            force_flip_invariance=True,
            infer_is_positive=True,
            fix_quantile_crossing=True,
        ))
        self.status = ModelStatus(True, f"{model_id} loaded on CPU")

    def predict(self, request: PredictRequest) -> PredictResponse:
        with INFERENCE_LOCK, self.lock:
            try:
                closes = _validate(request)
                self._load()
                horizon = max(3, min(12, int(os.getenv("CHALLENGER_HORIZON", "6"))))
                point, _quantiles = self.model.forecast(horizon=horizon, inputs=[closes[-1024:]])
                return _opinion("timesfm", closes, np.asarray(point)[0])
            except Exception as error:
                self.status = ModelStatus(False, str(error))
                return PredictResponse(available=False, model="timesfm", reason=str(error))


chronos2 = Chronos2Runner()
timesfm = TimesFmRunner()
app = FastAPI(title="CORTEX Forecast Challengers", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "models": {
            "chronos2": chronos2.status.__dict__,
            "timesfm": timesfm.status.__dict__,
        },
    }


@app.post("/chronos2/predict", response_model=PredictResponse)
def chronos2_predict(request: PredictRequest) -> PredictResponse:
    return chronos2.predict(request)


@app.post("/timesfm/predict", response_model=PredictResponse)
def timesfm_predict(request: PredictRequest) -> PredictResponse:
    return timesfm.predict(request)
