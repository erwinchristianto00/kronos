"""Binance USDⓈ-M Futures: the live price feed and order placement for the 24/7 bot (Path 2).

Three modes, set with BINANCE_MODE in .env:
  demo  (default)  Binance Demo Trading: real market prices, fake money.
  testnet          The older Binance Futures testnet (testnet.binancefuture.com): its own
                   thinner order book, fake money. Use it if your demo key doesn't work.
  live             Real money. Refused unless JEV_LIVE_CONFIRM is set to the exact
                   phrase in LIVE_PHRASE. Only the account owner should ever set it.

Orders are post-only limit orders (GTX) at the best bid (to buy) or best ask (to sell),
so the bot never crosses the spread and pays the maker fee. An order that isn't
filled within the wait time is cancelled. The account must be in One-way position mode.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import threading
import time
from urllib.parse import urlencode

import requests
import websocket
from dotenv import load_dotenv

from .features import HISTORY_S
from .loop import Market

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

LIVE_PHRASE = "I accept the risk of trading real money"

# REST for orders/account, REST + WebSocket for market data (prices the bot trades against).
# Binance's live stream serves best bid/ask on the /public route and trades on the /market route;
# the testnet still serves both on one route.
_LIVE_DATA = {"data_rest": "https://fapi.binance.com",
              "ws_book": "wss://fstream.binance.com/public", "ws_trades": "wss://fstream.binance.com/market"}
VENUES = {
    "demo":    {"rest": "https://demo-fapi.binance.com", **_LIVE_DATA},
    "testnet": {"rest": "https://testnet.binancefuture.com", "data_rest": "https://testnet.binancefuture.com",
                "ws_book": "wss://fstream.binancefuture.com", "ws_trades": "wss://fstream.binancefuture.com"},
    "live":    {"rest": "https://fapi.binance.com", **_LIVE_DATA},
}
VENUES["dry"] = VENUES["live"]  # --dry: real prices, simulated fills, no key

# Order states Binance won't change any more.
DONE_STATES = {"FILLED", "CANCELED", "EXPIRED", "REJECTED", "EXPIRED_IN_MATCH"}


class BinanceError(Exception):
    pass


def binance_mode() -> str:
    mode = os.getenv("BINANCE_MODE", "demo").strip().lower() or "demo"
    if mode not in ("demo", "testnet", "live"):
        raise BinanceError(f"BINANCE_MODE must be 'demo', 'testnet' or 'live', not '{mode}'")
    if mode == "live" and os.getenv("JEV_LIVE_CONFIRM", "").strip() != LIVE_PHRASE:
        raise BinanceError("BINANCE_MODE=live, but JEV_LIVE_CONFIRM isn't set to the exact confirmation phrase. "
                           "Refusing to trade real money.")
    return mode


class BinanceMarket(Market):
    """Same live snapshot as the Hyperliquid feed, from Binance's public futures stream:
    best bid/ask (bookTicker, real time) and every aggregated trade."""

    def __init__(self, symbol: str, venue: dict):
        super().__init__(symbol)
        self.symbol, self.venue = symbol, venue

    def start(self) -> None:
        s = self.symbol.lower()
        urls = [f"{self.venue['ws_book']}/stream?streams={s}@bookTicker", f"{self.venue['ws_trades']}/stream?streams={s}@aggTrade"]
        # Binance pings the client; websocket-client answers the pings by itself.
        self.apps = [websocket.WebSocketApp(u, on_message=lambda ws, m: self._on_binance(m)) for u in urls]
        for app in self.apps:
            threading.Thread(target=lambda a=app: a.run_forever(reconnect=3), daemon=True).start()

    def _on_binance(self, raw: str) -> None:
        data, now = json.loads(raw).get("data") or {}, time.time()
        with self.lock:
            if data.get("e") == "bookTicker":
                bid, bsz, ask, asz = float(data["b"]), float(data["B"]), float(data["a"]), float(data["A"])
                if bsz + asz <= 0:
                    return
                self.bbo = (bid, ask, bsz, asz, now)
                self.mids.append((now, (bid + ask) / 2))
                if not self.ticks or now - self.ticks[-1][0] >= 0.05:
                    self.ticks.append((now, (bid * asz + ask * bsz) / (bsz + asz), bid, ask))
                self.ready.set()
            elif data.get("e") == "aggTrade":
                # m = buyer is the maker, so the aggressor was a seller
                self.trades.append((data["T"] / 1000, not data["m"], float(data["p"]), float(data["q"])))
            for dq, keep in ((self.mids, 120), (self.trades, HISTORY_S), (self.ticks, 300)):
                while dq and now - dq[0][0] > keep:
                    dq.popleft()


class BinanceTrader:
    """Places and tracks post-only limit orders on one USDⓈ-M perpetual."""

    def __init__(self, symbol: str, mode: str):
        self.key = os.getenv("BINANCE_API_KEY", "").strip()
        self.secret = os.getenv("BINANCE_API_SECRET", "").strip()
        if not self.key or not self.secret:
            raise BinanceError("BINANCE_API_KEY / BINANCE_API_SECRET are missing from .env")
        self.symbol, self.mode, self.base = symbol, mode, VENUES[mode]["rest"]
        self.session = requests.Session()
        self.session.headers["X-MBX-APIKEY"] = self.key
        try:  # sign with the exchange's clock, so a drifting server clock can't get orders rejected
            self.offset_ms = self.session.get(f"{self.base}/fapi/v1/time", timeout=10).json()["serverTime"] - int(time.time() * 1000)
        except Exception as exc:
            raise BinanceError(f"can't reach Binance ({self.base}): {str(exc)[:120]}") from exc
        info = self._public("/fapi/v1/exchangeInfo")
        row = next((s for s in info.get("symbols", []) if s["symbol"] == symbol), None)
        if not row or row.get("status") != "TRADING":
            raise BinanceError(f"{symbol} isn't a tradable Binance USDⓈ-M perpetual")
        f = {x["filterType"]: x for x in row["filters"]}
        self.qty_step, self.min_qty = float(f["LOT_SIZE"]["stepSize"]), float(f["LOT_SIZE"]["minQty"])
        self.min_notional = float(f.get("MIN_NOTIONAL", {}).get("notional") or 5)
        self.tick = float(f["PRICE_FILTER"]["tickSize"])
        if self._call("GET", "/fapi/v1/positionSide/dual").get("dualSidePosition"):
            raise BinanceError("your futures account is in Hedge mode. Switch it to One-way mode "
                               "(Futures → settings → Position Mode) and run this again")

    # --- plumbing ------------------------------------------------------------------
    def _public(self, path: str, **params) -> dict:
        r = self.session.get(f"{self.base}{path}", params=params, timeout=10)
        if r.status_code != 200:
            raise BinanceError(f"HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def _call(self, method: str, path: str, base: str | None = None, **params):
        params = {k: v for k, v in params.items() if v is not None}
        params.update(timestamp=int(time.time() * 1000) + self.offset_ms, recvWindow=10000)
        query = urlencode(params)
        sig = hmac.new(self.secret.encode(), query.encode(), hashlib.sha256).hexdigest()
        try:
            r = self.session.request(method, f"{base or self.base}{path}?{query}&signature={sig}", timeout=10)
        except requests.RequestException as exc:
            raise BinanceError(str(exc)[:300]) from exc
        try:
            body = r.json()
        except ValueError:
            raise BinanceError(f"HTTP {r.status_code}: {r.text[:200]}")
        if r.status_code != 200 or (isinstance(body, dict) and body.get("code", 0) < 0):
            raise BinanceError(f"{body.get('code', r.status_code)}: {body.get('msg', r.text[:200])}" if isinstance(body, dict)
                               else f"HTTP {r.status_code}")
        return body

    # --- helpers -----------------------------------------------------------------
    def _decimals(self, step: float) -> int:
        return max(0, -int(math.floor(math.log10(step)))) if step < 1 else 0

    def round_qty(self, qty: float) -> float:
        return round(math.floor(qty / self.qty_step + 1e-9) * self.qty_step, self._decimals(self.qty_step))

    def fmt_qty(self, qty: float) -> str:
        return f"{self.round_qty(qty):.{self._decimals(self.qty_step)}f}"

    def fmt_px(self, px: float) -> str:
        return f"{round(round(px / self.tick) * self.tick, self._decimals(self.tick)):.{self._decimals(self.tick)}f}"

    # --- account -------------------------------------------------------------------
    def equity_usdt(self) -> float | None:
        acct = self._call("GET", "/fapi/v2/account")
        v = acct.get("totalMarginBalance")
        return float(v) if v not in (None, "") else None

    def key_restrictions(self) -> dict:
        """What the API key itself is allowed to do (live keys only: demo/testnet keys can't touch real funds)."""
        return self._call("GET", "/sapi/v1/account/apiRestrictions", base="https://api.binance.com")

    def position(self) -> tuple[float, float]:
        """Signed size in coins (+ long, - short) and average entry price."""
        rows = self._call("GET", "/fapi/v2/positionRisk", symbol=self.symbol)
        size = sum(float(r["positionAmt"]) for r in rows)
        avg = next((float(r["entryPrice"]) for r in rows if float(r["positionAmt"])), 0.0)
        return size, avg

    # --- orders --------------------------------------------------------------------
    def place_post_only(self, side: str, qty: float, px: float, reduce_only: bool = False) -> str:
        res = self._call("POST", "/fapi/v1/order", symbol=self.symbol, side="BUY" if side == "buy" else "SELL",
                         type="LIMIT", timeInForce="GTX", quantity=self.fmt_qty(qty), price=self.fmt_px(px),
                         reduceOnly="true" if reduce_only else None, newClientOrderId=f"jev-{int(time.time() * 1000)}")
        return str(res["orderId"])

    def _fee(self, order_id: str, filled: float, avg_px: float) -> float:
        """USDT fees actually charged on this order's fills (fees paid in BNB are converted at the maker rate)."""
        if filled <= 0:
            return 0.0
        try:
            fills = self._call("GET", "/fapi/v1/userTrades", symbol=self.symbol, orderId=order_id)
        except BinanceError:
            fills = []
        if not fills:
            return filled * avg_px * 0.0002
        return sum(float(t["commission"]) if t.get("commissionAsset") == "USDT" else float(t["qty"]) * float(t["price"]) * 0.0002
                   for t in fills)

    def order(self, order_id: str) -> dict:
        """Current state of one order: status, filled qty, average price, fee paid, and whether it's finished."""
        try:
            r = self._call("GET", "/fapi/v1/order", symbol=self.symbol, orderId=order_id)
        except BinanceError:
            return {"status": "Unknown", "filled": 0.0, "avg_px": 0.0, "fee": 0.0, "done": False}
        filled, avg = float(r.get("executedQty") or 0), float(r.get("avgPrice") or 0)
        return {"status": r["status"], "filled": filled, "avg_px": avg, "fee": self._fee(order_id, filled, avg),
                "done": r["status"] in DONE_STATES}

    def cancel(self, order_id: str) -> None:
        try:
            self._call("DELETE", "/fapi/v1/order", symbol=self.symbol, orderId=order_id)
        except BinanceError:
            pass  # already filled or gone

    def cancel_all(self) -> None:
        try:
            self._call("DELETE", "/fapi/v1/allOpenOrders", symbol=self.symbol)
        except BinanceError:
            pass

    def flatten(self) -> dict | None:
        """Close any open position with a reduce-only market order (kill switch, loss limit, exit).
        Returns the closing fill (signed qty, price, fee) so the P&L includes it."""
        size, _ = self.position()
        if abs(size) < self.min_qty:
            return None
        res = self._call("POST", "/fapi/v1/order", symbol=self.symbol, side="SELL" if size > 0 else "BUY",
                         type="MARKET", quantity=self.fmt_qty(abs(size)), reduceOnly="true")
        oid = str(res["orderId"])
        for _ in range(10):  # market orders fill almost instantly; give it a moment to report
            time.sleep(0.3)
            o = self.order(oid)
            if o["status"] == "FILLED":
                return {"dq": -size, "px": o["avg_px"], "fee": o["fee"]}
        return {"dq": -size, "px": 0.0, "fee": 0.0}
