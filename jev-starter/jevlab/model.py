"""The local signal model: a ridge regression that estimates the price move (in bps) over the
next few minutes from recent trade flow. Plain numpy, no API, answers in well under a millisecond.

  uv run python -m jevlab train --coin SOL      # download history, test it honestly, write models/SOLUSDT.json

Training data is Binance's public futures trade history (see history.py); the features are
computed by features.py, the same code the bot uses live, so training and trading match.

How it's tested: walk-forward. Train on 25 days, test on the next 5 days it has never seen,
slide forward, repeat. Only trades the model would have taken count, and each pays fees.
The report is written next to the model (models/<SYMBOL>-report.md).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import features as F

MODELS = Path(__file__).resolve().parent.parent / "models"

HORIZON_S = 900        # predict the move over the next 15 minutes
MIN_EDGE_BPS = 6.0     # only act when the predicted move is at least this big
CLIP_BPS = 200.0       # cap extreme moves in training so a few crashes don't dominate
ALPHA = 10.0           # ridge penalty
STEP_S = 2.0           # one training sample every 2 seconds
MAKER_COST_BPS = 4.0   # round trip with post-only limit orders (0.02% in + 0.02% out)
TAKER_COST_BPS = 10.0  # round trip with market orders


# ---------------------------------------------------------------- fitting

def fit(X: np.ndarray, y: np.ndarray, alpha: float = ALPHA) -> dict:
    """Standardise, then closed-form ridge regression."""
    mean, scale = X.mean(0), X.std(0)
    scale = np.where(scale > 0, scale, 1.0)
    Z = (X - mean) / scale
    y_mean = y.mean()
    w = np.linalg.solve(Z.T @ Z + alpha * np.eye(Z.shape[1]), Z.T @ (y - y_mean))
    return {"mean": mean.tolist(), "scale": scale.tolist(), "coef": w.tolist(), "intercept": float(y_mean)}


def predict(params: dict, X: np.ndarray) -> np.ndarray:
    Z = (X - np.asarray(params["mean"])) / np.asarray(params["scale"])
    return Z @ np.asarray(params["coef"]) + params["intercept"]


def dataset(trades: F.Trades, start: float, end: float, horizon: int = HORIZON_S, step: float = STEP_S):
    """Features, the move that followed (bps), and each sample's time, for query times in [start, end)."""
    q = np.arange(start, end, step)
    X = F.compute(trades, q)
    y = 1e4 * (trades.price_at(q + horizon) / trades.price_at(q) - 1)
    ok = ~np.isnan(X).any(1) & ~np.isnan(y)
    return X[ok], np.clip(y[ok], -CLIP_BPS, CLIP_BPS), y[ok], q[ok]


def simulate(q: np.ndarray, pred: np.ndarray, move: np.ndarray, min_edge: float, horizon: int,
             details: list | None = None) -> np.ndarray:
    """Per-trade gross result (bps): enter when |prediction| >= min_edge, hold `horizon`, one position at a time.
    If `details` is a list, each trade's (time, side, predicted bps, move bps) is appended to it."""
    side = np.where(pred >= min_edge, 1, np.where(pred <= -min_edge, -1, 0))
    out, free_at = [], -np.inf
    for j in np.flatnonzero(side):
        if q[j] >= free_at:
            out.append(side[j] * move[j])
            free_at = q[j] + horizon
            if details is not None:
                details.append((float(q[j]), int(side[j]), float(pred[j]), float(move[j])))
    return np.array(out)


def passes(stats: dict) -> bool:
    """The bar a model must clear before the bot trades it: positive after maker fees overall, in all
    but at most one test period, with enough trades to mean something."""
    return bool(stats.get("trades", 0) >= 20 and (stats.get("net_maker_bps") or 0) > 0
                and stats.get("folds_positive_after_maker_fees", 0) >= stats.get("folds", 0) - 1)


# ---------------------------------------------------------------- training + report

def train(symbol: str, days: int = 45, log=print) -> Path:
    from .history import last_days

    log(f"  downloading {days} days of {symbol} trades from data.binance.vision …")
    hist = last_days(symbol, days, log=log)
    if len(hist) < 20:
        raise SystemExit(f"  only {len(hist)} days of history for {symbol}; need at least 20")
    df = pd.concat([d for _, d in hist], ignore_index=True)
    trades = F.Trades(df.t, df.is_buy, df.px, df.qty)
    t0 = df.t.iloc[0] + F.HISTORY_S
    t_end = df.t.iloc[-1] - HORIZON_S
    X, y_fit, y_real, q = dataset(trades, t0, t_end)
    day = ((q - q[0]) // 86400).astype(int)
    n_days = int(day.max()) + 1
    log(f"  {len(q):,} samples over {n_days} days · walk-forward test …")

    # walk-forward: train on 25 days, test on the next 5, slide by 5
    folds, all_g, trade_rows = [], [], []
    train_len, test_len = min(25, n_days - 10), 5
    for k in range(train_len, n_days - test_len + 1, test_len):
        a = (day >= k - train_len) & (day < k)
        b = (day >= k) & (day < k + test_len)
        m = fit(X[a], y_fit[a])
        g = simulate(q[b], predict(m, X[b]), y_real[b], MIN_EDGE_BPS, HORIZON_S, details=trade_rows)
        folds.append((str(hist[k][0]), str(hist[min(k + test_len, len(hist)) - 1][0]), g))
        all_g.extend(g)
    all_g = np.array(all_g)

    final = fit(X, y_fit)  # the model the bot uses is trained on every day
    MODELS.mkdir(exist_ok=True)
    path = MODELS / f"{symbol}.json"
    n = len(all_g)
    stats = {
        "trades": n,
        "per_day": round(n / max(1, len(folds) * test_len), 2),
        "hit_rate": round(float(np.mean(all_g > 0)), 3) if n else None,
        "gross_bps": round(float(all_g.mean()), 2) if n else None,
        "stderr_bps": round(float(all_g.std(ddof=1) / np.sqrt(n)), 2) if n > 1 else None,
        "net_maker_bps": round(float(all_g.mean() - MAKER_COST_BPS), 2) if n else None,
        "net_taker_bps": round(float(all_g.mean() - TAKER_COST_BPS), 2) if n else None,
        "folds_positive_after_maker_fees": sum(1 for *_, g in folds if len(g) and g.mean() > MAKER_COST_BPS),
        "folds": len(folds),
    }
    stats["passes"] = passes(stats)
    blob = {"symbol": symbol, "kind": "ridge", "features": F.NAMES, "horizon_s": HORIZON_S,
            "min_edge_bps": MIN_EDGE_BPS, "trained_on": [str(hist[0][0]), str(hist[-1][0])],
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "walk_forward": stats, **final}
    path.write_text(json.dumps(blob, indent=1))
    trades_df = pd.DataFrame(trade_rows, columns=["t", "side", "predicted_bps", "move_bps"])
    trades_df.insert(0, "time_utc", pd.to_datetime(trades_df.pop("t"), unit="s", utc=True).dt.strftime("%Y-%m-%d %H:%M:%S"))
    trades_df["side"] = trades_df["side"].map({1: "long", -1: "short"})
    trades_df["net_after_maker_bps"] = (trades_df["move_bps"].where(trades_df["side"] == "long", -trades_df["move_bps"])
                                        - MAKER_COST_BPS).round(2)
    trades_df.round(2).to_csv(MODELS / f"{symbol}-trades.csv", index=False)

    lines = [f"# {symbol} signal model", "",
             f"Ridge regression predicting the move over the next {HORIZON_S // 60} minutes from trade flow.",
             f"Trained on {hist[0][0]} to {hist[-1][0]} ({len(hist)} days, {len(q):,} samples).",
             f"Trades only when the predicted move is at least {MIN_EDGE_BPS:g} bps, holds {HORIZON_S // 60} minutes.", "",
             "## Walk-forward test (train 25 days, test the next 5 unseen days)", "",
             "| test period | trades | hit rate | gross bps/trade | net after maker fees (4 bps) |",
             "|---|---|---|---|---|"]
    for a, b, g in folds:
        lines.append(f"| {a} to {b} | {len(g)} | {np.mean(g > 0):.0%} | {g.mean():+.1f} | {g.mean() - MAKER_COST_BPS:+.1f} |"
                     if len(g) else f"| {a} to {b} | 0 | – | – | – |")
    lines += ["", "## Verdict", "",
              ("**Passes** the bar" if stats["passes"] else "**Does not pass** the bar")
              + ": positive after maker fees overall and in all but at most one test period, with at least 20 trades."
              + ("" if stats["passes"] else " The bot won't run it with real money; on demo/testnet it runs as an experiment."),
              "One window is not enough: rerunning this on a data window shifted by a day can change the verdict.",
              "", "## All test periods together", "",
              f"- trades: {n} (about {stats['per_day']} a day)",
              f"- hit rate: {stats['hit_rate']:.1%}" if n else "- hit rate: –",
              f"- gross: {stats['gross_bps']:+.2f} bps per trade (± {stats['stderr_bps']} standard error)" if n > 1 else "- gross: –",
              f"- after maker fees: {stats['net_maker_bps']:+.2f} bps per trade" if n else "",
              f"- after taker fees: {stats['net_taker_bps']:+.2f} bps per trade" if n else "", "",
              "## How to read this", "",
              "- The edge is small and the uncertainty is about as big as the edge, so it may not be real.",
              "- The 15-minute horizon and 6 bps threshold were picked after comparing a few settings on these",
              "  same test periods, so these numbers are somewhat optimistic.",
              "- It assumes post-only limit orders fill at the mid price. Real fills are often worse:",
              "  a resting order tends to fill exactly when the price is moving against it.",
              "- Past results don't guarantee future ones. Retrain regularly and judge it on live demo results."]
    (MODELS / f"{symbol}-report.md").write_text("\n".join(lines) + "\n")
    verdict = ("PASSES the bar" if stats["passes"]
               else "does NOT pass the bar (real money won't run it; fake money runs it as an experiment)")
    log(f"  wrote {path}, {symbol}-report.md and {symbol}-trades.csv · walk-forward {verdict}")
    return path


# ---------------------------------------------------------------- live use

class SignalModel:
    """The trained model, loaded for the bot. edge_bps() gives the predicted move from the live trades."""

    def __init__(self, symbol: str, enforce: bool = True):
        """enforce=True refuses a model that failed its walk-forward test (the bot does this for real money)."""
        path = MODELS / f"{symbol}.json"
        if not path.exists():
            raise FileNotFoundError(f"no model for {symbol}: run `uv run python -m jevlab train --coin {symbol[:-4]}`")
        self.params = json.loads(path.read_text())
        if self.params["features"] != F.NAMES:
            raise ValueError(f"{path.name} was trained on different features; retrain it")
        wf = self.params.get("walk_forward", {})
        self.tested_ok = bool(wf.get("passes", passes(wf)))
        if not self.tested_ok and enforce and os.getenv("ALLOW_UNTESTED_MODEL", "").lower() != "true":
            raise ValueError(f"{path.name} did not pass its walk-forward test ({wf.get('net_maker_bps')} bps/trade after "
                             f"fees); the bot won't trade it with real money. Use another coin, or SIGNAL_SOURCE=jev")
        self.horizon_s = int(self.params["horizon_s"])
        self.min_edge_bps = float(self.params["min_edge_bps"])
        self.trained_to = self.params["trained_on"][1]
        self.name = f"local model · {self.horizon_s // 60}m · data to {self.trained_to}" + ("" if self.tested_ok else " · EXPERIMENT")

    def age_days(self) -> int:
        return (datetime.now(timezone.utc).date() - datetime.fromisoformat(self.trained_to).date()).days

    def edge_bps(self, trade_rows, now: float) -> float | None:
        """Predicted move over the horizon, in bps (+ up, - down). None while there isn't enough history."""
        x = F.compute(F.Trades.from_rows(trade_rows), now)
        if np.isnan(x).any():
            return None
        return float(predict(self.params, x)[0])
