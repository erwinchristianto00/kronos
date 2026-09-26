"""Binance USDⓈ-M Futures trade history from data.binance.vision (public, no key).

One zip per symbol per day of aggregated trades; files are cached in data/.
"""

from __future__ import annotations

import io
import zipfile
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

DATA = Path(__file__).resolve().parent.parent / "data"
URL = "https://data.binance.vision/data/futures/um/daily/aggTrades/{s}/{s}-aggTrades-{d}.zip"


def day_file(symbol: str, day: date) -> Path | None:
    """The cached zip for one day, downloading it if needed. None if Binance hasn't published it."""
    path = DATA / symbol / f"{symbol}-aggTrades-{day}.zip"
    if path.exists() and path.stat().st_size > 0:
        return path
    r = requests.get(URL.format(s=symbol, d=day), timeout=120)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(path)
    return path


def load_day(path: Path) -> pd.DataFrame:
    """Columns t (seconds), is_buy (buyer was the aggressor), px, qty."""
    with zipfile.ZipFile(path) as z:
        raw = z.read(z.namelist()[0])
    first = raw[:200].split(b"\n", 1)[0]
    header = 0 if first[:1].isalpha() else None
    df = pd.read_csv(io.BytesIO(raw), header=header)
    df = df.iloc[:, [1, 2, 5, 6]]
    df.columns = ["px", "qty", "time_ms", "is_buyer_maker"]
    maker = df["is_buyer_maker"]
    if maker.dtype != bool:
        maker = maker.astype(str).str.lower().eq("true")
    return pd.DataFrame({"t": df["time_ms"].to_numpy(dtype=np.int64) / 1000.0, "is_buy": ~maker.to_numpy(),
                         "px": df["px"].to_numpy(dtype=float), "qty": df["qty"].to_numpy(dtype=float)})


def last_days(symbol: str, days: int, end: date | None = None, log=print) -> list[tuple[date, pd.DataFrame]]:
    """The most recent `days` published days (Binance publishes each day a few hours after it ends)."""
    day = end or date.today()
    out: list[tuple[date, pd.DataFrame]] = []
    misses = 0
    while len(out) < days and misses < 5:
        path = day_file(symbol, day)
        if path is None:
            misses += 1
        else:
            misses = 0
            out.append((day, load_day(path)))
            log(f"  {day}  {len(out[-1][1]):>9,} trades")
        day -= timedelta(days=1)
    return sorted(out, key=lambda x: x[0])
