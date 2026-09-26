"""Market features for the local signal model, computed from trades alone.

The same function builds the training set (from Binance's historical aggTrades files)
and the live input (from the bot's trade stream), so the model always sees numbers
computed exactly the way it was trained on.

A trade is (time in seconds, is_buy, price, quantity), where is_buy means the buyer
was the aggressor (the taker). Prices are a bounce-free mid estimate (see Trades).
"""

from __future__ import annotations

import numpy as np

RET_WINDOWS = (5, 30, 120)      # price change over the last N seconds, in bps
FLOW_WINDOWS = (5, 30, 120)     # share of traded USD that was aggressive buying
COUNT_WINDOWS = (5, 30)         # number of trades
PATH_WINDOW = 60                # total absolute price movement (choppiness), in bps
HISTORY_S = 300  # trade history the live feed keeps; longer than every window, so a quiet spell never blanks a feature

NAMES = ([f"ret_{w}s_bps" for w in RET_WINDOWS] + [f"buy_share_{w}s" for w in FLOW_WINDOWS]
         + [f"log_trades_{w}s" for w in COUNT_WINDOWS] + [f"path_{PATH_WINDOW}s_bps", "log_usd_30s"])


def pd_ffill(x: np.ndarray) -> np.ndarray:
    """Forward-fill NaNs in a 1-D array."""
    idx = np.where(np.isnan(x), 0, np.arange(len(x)))
    np.maximum.accumulate(idx, out=idx)
    out = x[idx]
    return out


class Trades:
    """Trades as sorted arrays, with running sums for fast window lookups."""

    def __init__(self, t, is_buy, px, qty):
        order = np.argsort(t, kind="stable")
        self.t = np.asarray(t, dtype=float)[order]
        raw = np.asarray(px, dtype=float)[order]
        usd = raw * np.asarray(qty, dtype=float)[order]
        buy = np.asarray(is_buy, dtype=bool)[order]
        # Trade prices bounce between the bid (sells) and the ask (buys). The last aggressive buy and the
        # last aggressive sell approximate the ask and the bid, so their average is a mid price without
        # the bounce (until both sides have traded, fall back to the raw price).
        self.px = raw
        if len(raw):
            ask = pd_ffill(np.where(buy, raw, np.nan))
            bid = pd_ffill(np.where(~buy, raw, np.nan))
            self.px = np.where(np.isnan(ask) | np.isnan(bid), raw, (ask + bid) / 2)
        zero = np.zeros(1)
        self.c_usd = np.concatenate([zero, np.cumsum(usd)])
        self.c_buy = np.concatenate([zero, np.cumsum(np.where(buy, usd, 0.0))])
        steps = np.abs(np.diff(np.log(self.px), prepend=np.log(self.px[:1]))) * 1e4 if len(self.px) else np.zeros(0)
        self.c_path = np.concatenate([zero, np.cumsum(steps)])

    @classmethod
    def from_rows(cls, rows) -> "Trades":
        """From the live feed's (t, is_buy, px, qty) tuples."""
        if not rows:
            return cls([], [], [], [])
        t, b, p, q = zip(*rows)
        return cls(t, b, p, q)

    def last_index(self, q: np.ndarray) -> np.ndarray:
        """Index of the last trade at or before each time (-1 if none)."""
        return np.searchsorted(self.t, q, side="right") - 1

    def price_at(self, q: np.ndarray) -> np.ndarray:
        i = self.last_index(q)
        return np.where(i >= 0, self.px[np.clip(i, 0, None)], np.nan) if len(self.px) else np.full(len(q), np.nan)


def compute(trades: Trades, q) -> np.ndarray:
    """Feature matrix, one row per query time in q (seconds). NaN where there isn't enough history."""
    q = np.atleast_1d(np.asarray(q, dtype=float))
    out = np.full((len(q), len(NAMES)), np.nan)
    if len(trades.t) == 0:
        return out
    now_i = trades.last_index(q) + 1  # number of trades at or before q (index into the running sums)
    p_now = trades.price_at(q)
    col = 0
    for w in RET_WINDOWS:
        out[:, col] = 1e4 * (p_now / trades.price_at(q - w) - 1)
        col += 1
    for w in FLOW_WINDOWS:
        s = trades.last_index(q - w) + 1
        usd = trades.c_usd[now_i] - trades.c_usd[s]
        buy = trades.c_buy[now_i] - trades.c_buy[s]
        out[:, col] = np.where(usd > 0, buy / np.where(usd > 0, usd, 1), 0.5)
        col += 1
    for w in COUNT_WINDOWS:
        s = trades.last_index(q - w) + 1
        out[:, col] = np.log1p(now_i - s)
        col += 1
    s = trades.last_index(q - PATH_WINDOW) + 1
    # path over trades inside the window; the first step into the window is excluded
    out[:, col] = np.where(now_i - s > 1, trades.c_path[now_i] - trades.c_path[np.minimum(s + 1, now_i)], 0.0)
    col += 1
    s = trades.last_index(q - 30) + 1
    out[:, col] = np.log1p(trades.c_usd[now_i] - trades.c_usd[s])
    # no trade at all before the longest window means the history is too short to trust
    too_short = trades.last_index(q - max(RET_WINDOWS)) < 0
    out[too_short] = np.nan
    return out
