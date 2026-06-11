import os
import sys
import logging
import traceback
import threading
from math import ceil
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field


logger = logging.getLogger("kronos_adapter")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)


class KronosBias(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"
    NEUTRAL = "NEUTRAL"


class Candle(BaseModel):
    open_time: int = Field(alias="openTime")
    open: float
    high: float
    low: float
    close: float
    volume: float


class PredictRequest(BaseModel):
    symbol: str
    timeframe: str
    candles: List[Candle]


class KronosPrediction(BaseModel):
    available: bool
    reason: Optional[str] = None
    availabilityReasonCode: Optional[str] = None
    kronosLongProbability: Optional[float] = None
    kronosShortProbability: Optional[float] = None
    kronosBias: Optional[KronosBias] = None
    kronosBias1h: Optional[KronosBias] = None
    kronosBias4h: Optional[KronosBias] = None
    selectedKronosBias: Optional[KronosBias] = None
    expectedReturn3: Optional[float] = None
    expectedReturn6: Optional[float] = None
    expectedVolatility: Optional[float] = None
    kronosConfidence: Optional[float] = None
    kronosRisk: Optional[float] = None
    currentPrice: Optional[float] = None
    forecastMedianClose: Optional[float] = None
    forecastP25Close: Optional[float] = None
    forecastP75Close: Optional[float] = None
    forecastMaxHigh: Optional[float] = None
    forecastMinLow: Optional[float] = None
    expectedReturn15m: Optional[float] = None
    expectedReturn1h: Optional[float] = None
    expectedReturn4h: Optional[float] = None
    probabilityUp: Optional[float] = None
    probabilityDown: Optional[float] = None
    kronosConfidenceBucket: Optional[str] = None
    horizonConflict: Optional[bool] = None
    degradedSampling: Optional[bool] = None
    debugSymbol: Optional[str] = None
    debugTimeframe: Optional[str] = None
    debugCandleCount: Optional[int] = None
    debugFirstTimestamp: Optional[int] = None
    debugLastTimestamp: Optional[int] = None
    debugLastClose: Optional[float] = None
    debugRequestShape: Optional[str] = None
    debugCandleSource: Optional[str] = None
    debugLast3Closes: Optional[List[float]] = None
    debugFailureCode: Optional[str] = None
    rawErrorMessage: Optional[str] = None
    tracebackSummary: Optional[str] = None


@dataclass
class AdapterStatus:
    connected: bool
    message: str


class KronosPredictionError(RuntimeError):
    def __init__(self, code: str, reason: str, raw_error: str, traceback_summary: str = "", debug: Optional[dict] = None):
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.raw_error = raw_error
        self.traceback_summary = traceback_summary
        self.debug = debug or {}


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def round_metric(value: float) -> float:
    return round(float(value), 4)


class DisabledKronosAdapter:
    def __init__(self, reason: str):
        self.reason = reason

    def health(self) -> AdapterStatus:
        return AdapterStatus(connected=False, message=self.reason)

    def predict(self, _: PredictRequest) -> KronosPrediction:
        return KronosPrediction(
            available=False,
            reason=self.reason,
        )


class OfficialKronosAdapter:
    def __init__(self):
        repo_root = Path(__file__).resolve().parents[1] / "vendor" / "Kronos"
        if not repo_root.exists():
            raise RuntimeError("Official Kronos repository is missing from services/kronos/vendor/Kronos.")

        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))

        import numpy as np
        import pandas as pd
        from model import Kronos, KronosPredictor, KronosTokenizer

        tokenizer_id = os.getenv("KRONOS_TOKENIZER_ID", "NeoQuasar/Kronos-Tokenizer-base")
        model_id = os.getenv("KRONOS_MODEL_ID", "NeoQuasar/Kronos-small")
        device = os.getenv("KRONOS_DEVICE") or None
        max_context = int(os.getenv("KRONOS_MAX_CONTEXT", "512"))

        tokenizer = KronosTokenizer.from_pretrained(tokenizer_id)
        model = Kronos.from_pretrained(model_id)

        # ── Rotary cache race-condition patch ─────────────────────────────────
        # RotaryPositionalEmbedding uses a mutable seq_len_cached attribute that is
        # shared across all inference calls.  When two requests are in-flight
        # simultaneously (FastAPI runs sync handlers in a thread pool), Thread A at
        # auto-regressive step i=5 (seq_len=155) and Thread B at step i=0
        # (seq_len=150) race on the cache: B reads cos_cached AFTER A overwrote it
        # with size-155 tensors, causing:
        #   RuntimeError: The size of tensor a (150) must match the size of tensor b (155)
        # Fix: replace the cached forward with a stateless one that computes cos/sin
        # inline (negligible overhead vs the attention forward pass).
        import torch as _torch
        from model.module import RotaryPositionalEmbedding as _RPE

        def _rotary_forward_stateless(self_rpe, q, k):
            seq_len = q.shape[-2]
            t = _torch.arange(seq_len, device=q.device).type_as(self_rpe.inv_freq)
            freqs = _torch.einsum('i,j->ij', t, self_rpe.inv_freq)
            emb = _torch.cat((freqs, freqs), dim=-1)
            cos = emb.cos()[None, None, :, :]
            sin = emb.sin()[None, None, :, :]
            x1_q, x2_q = q.chunk(2, dim=-1)
            x1_k, x2_k = k.chunk(2, dim=-1)
            rot_q = _torch.cat((-x2_q, x1_q), dim=-1)
            rot_k = _torch.cat((-x2_k, x1_k), dim=-1)
            return (q * cos) + (rot_q * sin), (k * cos) + (rot_k * sin)

        _RPE.forward = _rotary_forward_stateless
        logger.info("Rotary cache patch applied — stateless forward installed on RotaryPositionalEmbedding")
        # ─────────────────────────────────────────────────────────────────────

        # Serialise model calls: FastAPI runs synchronous handlers in a thread
        # pool, meaning multiple predict requests can run the shared PyTorch model
        # concurrently.  A single lock prevents all remaining shared-state races.
        self._predict_lock = threading.Lock()

        self.np = np
        self.pd = pd
        self.model_id = model_id
        self.max_context = max_context
        self.predictor = KronosPredictor(model, tokenizer, device=device, max_context=max_context)
        self.configured_pred_len = max(1, int(os.getenv("KRONOS_PRED_LEN", "6")))
        self.sample_runs = max(1, int(os.getenv("KRONOS_SAMPLE_RUNS", "2")))
        self.temperature = float(os.getenv("KRONOS_TEMPERATURE", "1.0"))
        self.top_p = float(os.getenv("KRONOS_TOP_P", "0.9"))

    def health(self) -> AdapterStatus:
        return AdapterStatus(connected=True, message=f"Official Kronos model {self.model_id} is loaded.")

    def _timeframe_ms(self, timeframe: str) -> int:
        mapping = {
            "5m": 5 * 60 * 1000,
            "15m": 15 * 60 * 1000,
            "1h": 60 * 60 * 1000,
        }
        if timeframe not in mapping:
            raise ValueError(f"Unsupported Kronos timeframe {timeframe}.")
        return mapping[timeframe]

    def _steps_for_named_horizons(self, timeframe: str) -> Dict[str, int]:
        timeframe_minutes = {
            "5m": 5,
            "15m": 15,
            "1h": 60,
        }[timeframe]
        return {
            "15m": max(1, ceil(15 / timeframe_minutes)),
            "1h": max(1, ceil(60 / timeframe_minutes)),
            "4h": max(1, ceil(240 / timeframe_minutes)),
        }

    def _pred_len_for_request(self, timeframe: str) -> int:
        required = max(self._steps_for_named_horizons(timeframe).values())
        return max(self.configured_pred_len, required)

    def _confidence_bucket(self, confidence: float) -> str:
        if confidence < 45:
            return "WEAK"
        if confidence < 70:
            return "MEDIUM"
        return "STRONG"

    def _debug_payload(self, request: PredictRequest, candles: Optional[List[Candle]] = None, frame=None, candle_source: str = "request.candles") -> dict:
        source = candles if candles is not None else request.candles
        first_timestamp = source[0].open_time if source else None
        last_timestamp = source[-1].open_time if source else None
        last_close = float(source[-1].close) if source else None
        last_3_closes = [round_metric(float(candle.close)) for candle in source[-3:]] if source else []
        request_shape = "unknown"
        if frame is not None:
          request_shape = f"{frame.shape[0]}x{frame.shape[1]}"
        return {
            "symbol": request.symbol,
            "timeframe": request.timeframe,
            "candleCount": len(source),
            "firstTimestamp": first_timestamp,
            "lastTimestamp": last_timestamp,
            "lastClose": round_metric(last_close) if last_close is not None else None,
            "requestShape": request_shape,
            "candleSource": candle_source,
            "last3Closes": last_3_closes,
        }

    def _raise_prediction_error(self, code: str, reason: str, error: Exception, debug: Optional[dict] = None):
        trace = traceback.format_exc(limit=6)
        logger.exception("Kronos prediction error [%s]: %s | debug=%s", code, reason, debug)
        raise KronosPredictionError(code, reason, str(error), trace, debug)

    def _normalize_input(self, request: PredictRequest):
        if len(request.candles) < 32:
            raise KronosPredictionError("NOT_ENOUGH_CANDLES", "not enough candles", "Kronos requires at least 32 candles for a stable forecast.", "", self._debug_payload(request))

        timeframe_ms = self._timeframe_ms(request.timeframe)
        candles = sorted(request.candles, key=lambda candle: candle.open_time)
        if len({candle.open_time for candle in candles}) != len(candles):
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos candles contain duplicate timestamps.", "", self._debug_payload(request, candles))

        timestamps = [candle.open_time for candle in candles]
        gaps = [timestamps[index + 1] - timestamps[index] for index in range(len(timestamps) - 1)]
        if any(gap != timeframe_ms for gap in gaps):
            raise KronosPredictionError("INVALID_INPUT", "invalid input", f"Kronos candles are not aligned to the declared {request.timeframe} timeframe.", "", self._debug_payload(request, candles))

        clipped = candles[-self.max_context :]
        frame = self.pd.DataFrame(
            [
                {
                    "open": candle.open,
                    "high": candle.high,
                    "low": candle.low,
                    "close": candle.close,
                    "volume": candle.volume,
                }
                for candle in clipped
            ]
        )
        if frame.empty:
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos received no usable candle rows.", "", self._debug_payload(request, candles))

        numeric = frame[["open", "high", "low", "close", "volume"]]
        if not self.np.isfinite(numeric.to_numpy(dtype=float)).all():
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos candles contain NaN or infinite numeric values.", "", self._debug_payload(request, candles, frame))
        if (frame[["open", "high", "low", "close"]] <= 0).any().any():
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos candles must have positive OHLC values.", "", self._debug_payload(request, candles, frame))
        if (frame["volume"] < 0).any():
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos candles contain negative volume.", "", self._debug_payload(request, candles, frame))
        if (frame["close"] == 0).all():
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos candles contain all-zero close values, which usually indicates a feed bug.", "", self._debug_payload(request, candles, frame))
        if (frame["volume"] == 0).all():
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Kronos candles contain all-zero volume, which usually indicates a feed bug.", "", self._debug_payload(request, candles, frame))

        current_close = float(frame["close"].iloc[-1])
        if current_close <= 0:
            raise KronosPredictionError("INVALID_INPUT", "invalid input", "Current close must be positive for Kronos scoring.", "", self._debug_payload(request, candles, frame))

        x_timestamp = self.pd.Series(self.pd.to_datetime([candle.open_time for candle in clipped], unit="ms"))
        return frame, x_timestamp, current_close, clipped

    def _predict_once(self, frame, x_timestamp, y_timestamp, pred_len: int):
        return self.predictor.predict(
            df=frame,
            x_timestamp=x_timestamp,
            y_timestamp=y_timestamp,
            pred_len=pred_len,
            T=self.temperature,
            top_p=self.top_p,
            sample_count=1,
            verbose=False,
        )

    def _validate_prediction_shape(self, pred_df, pred_len: int):
        if pred_df.empty:
            raise ValueError("Official Kronos predictor returned an empty forecast path.")
        required_columns = {"open", "high", "low", "close", "volume"}
        if not required_columns.issubset(set(pred_df.columns)):
            raise ValueError("Official Kronos predictor returned an incomplete forecast path.")
        if len(pred_df.index) != pred_len:
            raise ValueError(f"Official Kronos predictor returned {len(pred_df.index)} rows, expected {pred_len}.")
        values = pred_df[["open", "high", "low", "close", "volume"]].to_numpy(dtype=float)
        if not self.np.isfinite(values).all():
            raise ValueError("Official Kronos predictor returned NaN or infinite forecast values.")

    def _predict_paths(self, frame, x_timestamp, y_timestamp, pred_len: int, debug: dict):
        predictions = []
        try:
            for _ in range(self.sample_runs):
                pred_df = self._predict_once(frame, x_timestamp, y_timestamp, pred_len)
                self._validate_prediction_shape(pred_df, pred_len)
                predictions.append(pred_df.reset_index(drop=True))
            return predictions, False
        except Exception as error:
            if self.sample_runs <= 1:
                self._raise_prediction_error("PREDICTION_FAILED", "prediction failed", error, debug)
            logger.warning("Kronos multi-run sampling failed, retrying single-run fallback: %s", error)
            try:
                single_df = self._predict_once(frame, x_timestamp, y_timestamp, pred_len)
                self._validate_prediction_shape(single_df, pred_len)
                return [single_df.reset_index(drop=True)], True
            except Exception as single_error:
                self._raise_prediction_error("PREDICTION_FAILED", "prediction failed", single_error, debug)

    def _return_at_horizon(self, current_close: float, path, step: Optional[int]) -> Optional[float]:
        if step is None or step < 1 or step > len(path):
            return None
        target_close = float(path[step - 1])
        return ((target_close - current_close) / current_close) * 100

    def _bias_from_return_and_probability(self, expected_return: Optional[float], probability_up: float, probability_down: float) -> KronosBias:
        if expected_return is None:
            if probability_up > probability_down:
                return KronosBias.LONG
            if probability_down > probability_up:
                return KronosBias.SHORT
            return KronosBias.NEUTRAL
        if expected_return > 0 and probability_up >= probability_down:
            return KronosBias.LONG
        if expected_return < 0 and probability_down >= probability_up:
            return KronosBias.SHORT
        return KronosBias.NEUTRAL

    def _build_prediction(self, request: PredictRequest) -> KronosPrediction:
        try:
            timeframe_ms = self._timeframe_ms(request.timeframe)
        except ValueError as error:
            raise KronosPredictionError("UNSUPPORTED_SYMBOL", "unsupported symbol", str(error), "", self._debug_payload(request))
        pred_len = self._pred_len_for_request(request.timeframe)
        frame, x_timestamp, current_close, candles = self._normalize_input(request)
        debug = self._debug_payload(request, candles, frame)
        future_times = [candles[-1].open_time + timeframe_ms * (index + 1) for index in range(pred_len)]
        y_timestamp = self.pd.Series(self.pd.to_datetime(future_times, unit="ms"))
        prediction_paths, degraded_sampling = self._predict_paths(frame, x_timestamp, y_timestamp, pred_len, debug)

        close_paths = self.np.stack([pred_df["close"].to_numpy(dtype=float) for pred_df in prediction_paths])
        high_paths = self.np.stack([pred_df["high"].to_numpy(dtype=float) for pred_df in prediction_paths])
        low_paths = self.np.stack([pred_df["low"].to_numpy(dtype=float) for pred_df in prediction_paths])

        median_close_path = self.np.median(close_paths, axis=0)
        horizon_steps = self._steps_for_named_horizons(request.timeframe)
        horizon_1h_index = min(horizon_steps["1h"] - 1, pred_len - 1)
        horizon_4h_index = min(horizon_steps["4h"] - 1, pred_len - 1)
        close_distribution_1h = close_paths[:, horizon_1h_index]
        close_distribution_4h = close_paths[:, horizon_4h_index]

        return_1h_samples = ((close_paths[:, horizon_1h_index] - current_close) / current_close) * 100
        return_4h_samples = ((close_paths[:, horizon_4h_index] - current_close) / current_close) * 100
        probability_up_1h = float((return_1h_samples > 0).mean() * 100)
        probability_down_1h = float((return_1h_samples < 0).mean() * 100)
        probability_up_4h = float((return_4h_samples > 0).mean() * 100)
        probability_down_4h = float((return_4h_samples < 0).mean() * 100)

        expected_return_3 = self._return_at_horizon(current_close, median_close_path, min(3, pred_len))
        expected_return_6 = self._return_at_horizon(current_close, median_close_path, min(6, pred_len))
        expected_return_15m = (
            self._return_at_horizon(current_close, median_close_path, horizon_steps["15m"])
            if self._timeframe_ms(request.timeframe) <= 15 * 60 * 1000
            else None
        )
        expected_return_1h = self._return_at_horizon(current_close, median_close_path, horizon_steps["1h"])
        expected_return_4h = self._return_at_horizon(current_close, median_close_path, horizon_steps["4h"])
        bias_1h = self._bias_from_return_and_probability(expected_return_1h, probability_up_1h, probability_down_1h)
        bias_4h = self._bias_from_return_and_probability(expected_return_4h, probability_up_4h, probability_down_4h)
        horizon_conflict = bias_1h != KronosBias.NEUTRAL and bias_4h != KronosBias.NEUTRAL and bias_1h != bias_4h
        selected_bias = bias_1h if bias_1h != KronosBias.NEUTRAL else bias_4h

        path_returns = self.np.diff(median_close_path) / self.np.clip(median_close_path[:-1], 1e-9, None)
        expected_volatility = float(self.np.std(path_returns) * 100) if len(path_returns) > 0 else 0.0
        dispersion_pct = float(self.np.std(close_distribution_1h) / current_close * 100) if len(close_distribution_1h) > 1 else 0.0
        return_signal = expected_return_1h or 0.0
        directional_edge = clamp(return_signal * 7 + (probability_up_1h - probability_down_1h) * 0.55, -45, 45)
        long_probability = clamp(50 + directional_edge, 0, 100)
        short_probability = clamp(50 - directional_edge, 0, 100)
        confidence = clamp(
            abs(probability_up_1h - probability_down_1h) * 0.9
            + max(0, 18 - expected_volatility * 2.5)
            + max(0, 14 - dispersion_pct * 3),
            0,
            100,
        )
        risk = clamp(expected_volatility * 7 + dispersion_pct * 10 + max(0, -return_signal * 2), 0, 100)
        confidence_bucket = self._confidence_bucket(confidence)

        return KronosPrediction(
            available=True,
            kronosLongProbability=round_metric(long_probability),
            kronosShortProbability=round_metric(short_probability),
            kronosBias=selected_bias,
            kronosBias1h=bias_1h,
            kronosBias4h=bias_4h,
            selectedKronosBias=selected_bias,
            expectedReturn3=round_metric(expected_return_3) if expected_return_3 is not None else None,
            expectedReturn6=round_metric(expected_return_6) if expected_return_6 is not None else None,
            expectedVolatility=round_metric(expected_volatility),
            kronosConfidence=round_metric(confidence),
            kronosRisk=round_metric(risk),
            currentPrice=round_metric(current_close),
            forecastMedianClose=round_metric(self.np.median(close_distribution_1h)),
            forecastP25Close=round_metric(self.np.percentile(close_distribution_1h, 25)),
            forecastP75Close=round_metric(self.np.percentile(close_distribution_1h, 75)),
            forecastMaxHigh=round_metric(float(high_paths.max())),
            forecastMinLow=round_metric(float(low_paths.min())),
            expectedReturn15m=round_metric(expected_return_15m) if expected_return_15m is not None else None,
            expectedReturn1h=round_metric(expected_return_1h) if expected_return_1h is not None else None,
            expectedReturn4h=round_metric(expected_return_4h) if expected_return_4h is not None else None,
            probabilityUp=round_metric(probability_up_1h),
            probabilityDown=round_metric(probability_down_1h),
            kronosConfidenceBucket=confidence_bucket,
            horizonConflict=horizon_conflict,
            degradedSampling=degraded_sampling,
            debugSymbol=debug["symbol"],
            debugTimeframe=debug["timeframe"],
            debugCandleCount=debug["candleCount"],
            debugFirstTimestamp=debug["firstTimestamp"],
            debugLastTimestamp=debug["lastTimestamp"],
            debugLastClose=debug["lastClose"],
            debugRequestShape=debug["requestShape"],
            debugCandleSource=debug["candleSource"],
            debugLast3Closes=debug["last3Closes"],
        )

    def predict(self, request: PredictRequest) -> KronosPrediction:
        with self._predict_lock:
            return self._build_prediction(request)


def build_adapter():
    try:
        return OfficialKronosAdapter()
    except Exception as error:
        reason = f"Official Kronos model is unavailable: {error}"
        return DisabledKronosAdapter(reason)


app = FastAPI(title="Kronos Adapter Service", version="0.2.0")
adapter = build_adapter()


@app.get("/health")
def health() -> dict:
    status = adapter.health()
    return {"ok": True, "modelConnected": status.connected, "message": status.message}


@app.post("/predict", response_model=KronosPrediction)
def predict(request: PredictRequest) -> KronosPrediction:
    try:
        return adapter.predict(request)
    except KronosPredictionError as error:
        return KronosPrediction(
            available=False,
            reason=error.reason,
            availabilityReasonCode=error.code,
            debugSymbol=error.debug.get("symbol"),
            debugTimeframe=error.debug.get("timeframe"),
            debugCandleCount=error.debug.get("candleCount"),
            debugFirstTimestamp=error.debug.get("firstTimestamp"),
            debugLastTimestamp=error.debug.get("lastTimestamp"),
            debugLastClose=error.debug.get("lastClose"),
            debugRequestShape=error.debug.get("requestShape"),
            debugCandleSource=error.debug.get("candleSource"),
            debugLast3Closes=error.debug.get("last3Closes"),
            debugFailureCode=error.code,
            rawErrorMessage=error.raw_error,
            tracebackSummary=error.traceback_summary,
        )
    except Exception as error:
        trace = traceback.format_exc(limit=6)
        logger.exception("Unhandled Kronos prediction failure")
        return KronosPrediction(
            available=False,
            reason="prediction failed",
            availabilityReasonCode="PREDICTION_FAILED",
            rawErrorMessage=error.args[0] if error.args else "Official Kronos prediction failed.",
            tracebackSummary=trace,
        )
