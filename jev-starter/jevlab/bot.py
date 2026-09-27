"""The 24/7 bot (Path 2): Jev + Claude + your strategy, trading on Binance USDⓈ-M Futures.

  uv run python -m jevlab bot --dry        # Binance prices, simulated fills. No Binance key needed
  uv run python -m jevlab bot              # Binance Demo Trading (fake money), needs a demo API key
  uv run python -m jevlab bot --minutes 0  # run until stopped (this is what the server runs)

How it decides:
  * Claude (the brain) reads the market every --brain-every minutes and sets the bias:
    long, short or flat.
  * Jev makes a fast buy/sell call several times a second.
  * strategy.py combines them. By default it only trades in Claude's direction, and only
    when Jev is 85%+ sure.
  * Orders are post-only limit orders at the best bid/ask (maker fee, no spread),
    cancelled if they don't fill within --maker-wait seconds.

Safety, always on:
  * Demo Trading unless BINANCE_MODE=live AND JEV_LIVE_CONFIRM is the exact phrase (see binance.py).
  * MAX_POSITION_USD caps the position size (default $1,000).
  * MAX_DAILY_LOSS_USD: hit it and the bot cancels everything, closes the position and stops
    trading for the day (default $50).
  * Kill switch: create a file called STOP in the project folder, and the bot closes out and halts.
  * On shutdown it cancels open orders and closes the position.
"""

from __future__ import annotations

import json
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import features, strategy
from .brain import Brain
from .binance import VENUES, BinanceError, BinanceMarket, BinanceTrader, binance_mode
from .core import RESULTS, console, header
from .judges import JevJudge, JudgeError
from .loop import QUESTIONS
from .model import MODELS as MODEL_DIR, SignalModel
from .server import serve

MAKER_FEE = 0.0002  # Binance base-tier maker fee on USDⓈ-M perps, used for --dry fills
TAKER_FEE = 0.0005  # Binance base-tier taker fee, used for simulated close-outs
STOP_FILE = Path(__file__).resolve().parent.parent / "STOP"


class Book:
    """Position and P&L from actual fills: coins, cash and fees, marked to the live mid."""

    def __init__(self):
        self.qty, self.cash, self.fees, self.trades = 0.0, 0.0, 0.0, 0
        self.entry = 0.0  # average entry price of the open position
        self.equity: list[list[float]] = []
        self.day = datetime.now(timezone.utc).date()
        self.day_start_net = 0.0

    def fill(self, dq: float, px: float, fee_usd: float, new_order: bool = True) -> None:
        """new_order=False for the later parts of a partially filled order, so one order counts as one trade."""
        old = self.qty
        self.cash -= dq * px
        self.qty += dq
        self.fees += fee_usd
        self.trades += new_order
        if abs(self.qty) < 1e-9:
            self.qty, self.entry = 0.0, 0.0
        elif old == 0 or (old > 0) != (self.qty > 0):  # opened, or flipped through zero: entry is this fill
            self.entry = px
        elif abs(self.qty) > abs(old):  # added to the position: average the entry
            self.entry = (abs(old) * self.entry + abs(dq) * px) / abs(self.qty)

    def net(self, mid: float) -> float:
        return self.cash + self.qty * mid - self.fees

    def snap(self, t: float, mid: float) -> dict:
        g = self.cash + self.qty * mid
        self.equity.append([round(t, 2), round(g, 3), round(g - self.fees, 3)])
        del self.equity[:-2400]
        pos = 1 if self.qty > 0 else -1 if self.qty < 0 else 0
        unreal = self.qty * (mid - self.entry) if self.qty else 0.0
        return {"pos": pos, "qty": round(self.qty, 8), "entry": self.entry, "unrealized": round(unreal, 3),
                "realized": round(g - unreal, 3), "gross": round(g, 3), "fees": round(self.fees, 3),
                "net": round(g - self.fees, 3), "trades": self.trades, "equity": self.equity}


def run_bot(coin: str, pace_s: float, minutes: float, port: int, open_browser: bool, late_ms: float = 1500,
            maker_wait: float = 10.0, brain_every: float = 10.0, dry: bool = False) -> None:
    symbol = f"{coin}USDT"
    try:
        mode = "dry" if dry else binance_mode()
    except BinanceError as exc:
        raise SystemExit(f"  {exc}")
    position_usd = float(os.getenv("MAX_POSITION_USD", "1000"))
    max_loss = float(os.getenv("MAX_DAILY_LOSS_USD", "50"))
    mode_label = {"dry": "Binance prices · simulated fills", "demo": "Binance DEMO · fake money",
                  "testnet": "Binance TESTNET · fake money", "live": "LIVE · REAL MONEY"}[mode]
    venue = VENUES[mode]
    # Where the fast calls come from: the local model (default when models/<SYMBOL>.json exists) or Jev.
    source = os.getenv("SIGNAL_SOURCE", "").strip().lower() or ("model" if (MODEL_DIR / f"{symbol}.json").exists() else "jev")
    if source not in ("model", "jev"):
        raise SystemExit(f"  SIGNAL_SOURCE must be 'model' or 'jev', not '{source}'")
    model = jev = None
    if source == "model":
        try:
            model = SignalModel(symbol, enforce=(mode == "live"))  # fake money may run an untested model as an experiment
        except (FileNotFoundError, ValueError) as exc:
            raise SystemExit(f"  {exc}")
        min_edge = strategy.SETTINGS.get("model_min_edge_bps") or model.min_edge_bps  # strategy.py can override it
        signal_txt = f"signal: {model.name}, enters at a predicted {model.horizon_s // 60}-min move ≥ {min_edge:g} bps"
        strategy_note = f"model: enter at |predicted {model.horizon_s // 60}m move| ≥ {min_edge:g} bps (Claude can veto) · hold {model.horizon_s // 60} min"
    else:
        try:
            jev = JevJudge()
        except JudgeError as exc:
            raise SystemExit(f"  Jev key missing: {exc}. Add AI_GATEWAY_API_KEY to .env first.")
        signal_txt = "signal: Jev, as fast as the key allows (rules when Jev is busy)"
        strategy_note = strategy.DESCRIPTION
    if model and not model.tested_ok:
        console.print(f"  [#f5b53d]EXPERIMENT: {symbol}'s model did not pass its walk-forward test "
                      f"({model.params['walk_forward'].get('net_maker_bps')} bps/trade after fees). It runs here because this "
                      f"is fake money; it will not run with real money.[/]")
    if model and model.age_days() > 14:
        console.print(f"  [#f5b53d]the model's data is {model.age_days()} days old: retrain it with "
                      f"`uv run python -m jevlab train --coin {coin}`[/]")
    header("THE JEV BOT", f"{symbol} on Binance Futures · {mode_label} · Claude sets the bias every {brain_every:g} min · "
           f"{signal_txt} · max position ${position_usd:,.0f} · daily loss limit ${max_loss:,.0f}")
    if mode == "live":
        console.print("  [bold #ff5d6c]LIVE MODE: this bot is trading real money.[/] Kill switch: create a file named STOP.")
    trader = None
    if mode != "dry":
        try:
            trader = BinanceTrader(symbol, mode)
            trader.cancel_all()  # start clean: no stale orders from a previous run
            equity = trader.equity_usdt()
            console.print(f"  Binance {mode} account connected · equity {equity:,.2f} USDT" if equity is not None
                          else f"  Binance {mode} account connected")
        except BinanceError as exc:
            raise SystemExit(f"  Binance problem: {exc}")

    market = BinanceMarket(symbol, venue)  # the book the bot trades on: prices, fills, the dashboard chart
    market.start()
    # Signals always read the real market. On the testnet (its own thin book) that's a second feed.
    signal_market = BinanceMarket(symbol, VENUES["live"]) if mode == "testnet" else market
    if signal_market is not market:
        signal_market.start()
    for m in {id(market): market, id(signal_market): signal_market}.values():
        if not m.ready.wait(15):
            raise SystemExit("  no price feed from Binance after 15s, check the connection")

    book = Book()
    if trader:  # adopt any position already open, so the numbers are honest from the first second
        size, avg = trader.position()
        if size:
            book.qty, book.cash, book.entry = size, -size * avg, avg
            console.print(f"  existing position adopted: {size:+g} {coin} @ {avg:g}")

    stop = threading.Event()
    # Claude reads the real market, also on the testnet; if this server can't reach it, the trading venue's data
    brain = Brain(symbol, brain_every, list(dict.fromkeys([VENUES["live"]["data_rest"], venue["data_rest"]])))
    brain.start(stop)

    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"bot_{symbol}.json"  # one set of files per coin, so several bots can run side by side
    log = open(RESULTS / f"bot_log_{symbol}.jsonl", "a")
    decisions: list[dict] = []
    fills: list[dict] = []
    latencies: list[float] = []
    counts = {"ok": 0, "late": 0, "throttled": 0, "error": 0, "warmup": 0}
    lock = threading.Lock()
    st = {"interval": pace_s, "streak": 0, "prev": None, "order": None, "last_trade_t": 0.0, "hits": 0, "scored": 0,
          "halted": None, "equity": None, "sig_entry": None, "sig_exit": None, "rt": None, "orders": 0, "missed": 0}
    # Execution journal: one line per round trip, comparing what the backtest assumes with what really happened
    exec_path = RESULTS / f"exec_{symbol}.jsonl"
    trips: list[dict] = [json.loads(line) for line in exec_path.read_text().splitlines() if line.strip()] if exec_path.exists() else []
    exec_log = open(exec_path, "a")
    started = time.time()
    serve(port, open_browser, page="loop.html", data=out.name)

    def record_fill(dq: float, px: float, fee: float, kind: str, call, waited: float, new_order: bool = True) -> None:
        before = book.qty
        book.fill(dq, px, fee, new_order)
        journal(before, dq, px, fee, kind)
        fills.append({"t": time.time(), "side": "buy" if dq > 0 else "sell", "px": px, "qty": abs(dq), "kind": kind,
                      "call": call, "wait_s": round(waited, 1)})
        st["last_trade_t"] = time.time()

    def journal(before: float, dq: float, px: float, fee: float, kind: str) -> None:
        """Follow each round trip (flat -> position -> flat) through its fills; write it out when it closes."""
        now, live, venue_mid = time.time(), signal_market.snapshot()["mid"], market.snapshot()["mid"]
        side = 1 if dq > 0 else -1
        rt = st["rt"]

        def open_trip(q: float, f: float) -> None:
            st["rt"] = {"side": side, "t_in": now, "q_in": q, "v_in": q * px, "fee": f, "live_in": live,
                        "venue_in": venue_mid, "sig_in": st["sig_entry"], "q_out": 0.0, "v_out": 0.0}
            st["sig_exit"] = None  # an exit signal from an earlier trip must not be reused for this one

        if rt is None:
            if abs(before) < 1e-9 and abs(before + dq) > 1e-9:
                open_trip(abs(dq), fee)
            return  # (a position adopted at startup has no entry signal, so it isn't journaled)
        if side == rt["side"]:  # another part of the entry order
            rt["q_in"] += abs(dq); rt["v_in"] += abs(dq) * px; rt["fee"] += fee
            return
        closing = min(abs(dq), rt["q_in"] - rt["q_out"])
        rt["q_out"] += closing; rt["v_out"] += closing * px; rt["fee"] += fee * closing / abs(dq)
        rt.update(t_out=now, live_out=live, venue_out=venue_mid, sig_out=st["sig_exit"], kind_out=kind)
        after = before + dq
        if abs(after) > 1e-9 and (after > 0) == (rt["side"] > 0):
            return  # partly closed
        finish_trip(rt)
        st["rt"] = None
        if abs(dq) - closing > 1e-9:  # flipped through zero: the rest opens the next trip
            open_trip(abs(dq) - closing, fee * (abs(dq) - closing) / abs(dq))

    def finish_trip(rt: dict) -> None:
        s, cost = rt["side"], MAKER_FEE * 2e4
        px_in, px_out = rt["v_in"] / rt["q_in"], rt["v_out"] / max(rt["q_out"], 1e-12)
        si, so = rt["sig_in"] or {}, rt.get("sig_out") or {}

        def bps(a, b):
            return round(1e4 * (a / b - 1), 2) if a and b else None

        paper = bps(so.get("live_mid"), si.get("live_mid"))
        row = {
            "t_in": round(rt["t_in"], 1), "t_out": round(rt["t_out"], 1), "side": "long" if s > 0 else "short",
            "hold_min": round((rt["t_out"] - rt["t_in"]) / 60, 1), "exit": rt.get("kind_out"),
            "predicted_bps": si.get("edge_bps"),
            # what the backtest assumes: in and out at the real market's mid the moment each signal fired, maker fees
            "paper_bps": round(s * paper - cost, 2) if paper is not None else None,
            # the real market's move between the times our orders actually filled, maker fees
            "at_fills_bps": round(s * bps(rt["live_out"], rt["live_in"]) - cost, 2),
            # what this account really made, fees included, at this venue's prices
            "actual_bps": round(1e4 * (s * (px_out - px_in) * rt["q_out"] - rt["fee"]) / (px_in * rt["q_out"]), 2),
            "entry_cost_bps": round(s * bps(px_in, si["venue_mid"]), 2) if si.get("venue_mid") else None,
            "exit_cost_bps": round(-s * bps(px_out, so["venue_mid"]), 2) if so.get("venue_mid") else None,
            "entry_wait_s": round(rt["t_in"] - si["t"], 1) if si.get("t") else None,
            "exit_wait_s": round(rt["t_out"] - so["t"], 1) if so.get("t") else None,
            "usd": round(s * (px_out - px_in) * rt["q_out"] - rt["fee"], 3), "mode": mode,
        }
        trips.append(row)
        del trips[:-5000]
        exec_log.write(json.dumps(row) + "\n")
        exec_log.flush()

    def exec_summary() -> dict:
        def avg(k):
            v = [t[k] for t in trips if t.get(k) is not None]
            return round(statistics.mean(v), 2) if v else None
        return {"trips": len(trips), "predicted": avg("predicted_bps"), "paper": avg("paper_bps"),
                "at_fills": avg("at_fills_bps"), "actual": avg("actual_bps"), "entry_cost": avg("entry_cost_bps"),
                "exit_cost": avg("exit_cost_bps"), "entry_wait": avg("entry_wait_s"), "orders": st["orders"],
                "missed": st["missed"], "recent": trips[-20:]}

    def check_order() -> None:
        o = st["order"]
        if not o:
            return
        now = time.time()
        if trader is None:  # --dry: fill only if the market traded through our price
            through = any((o["buying"] and px < o["px"]) or (not o["buying"] and px > o["px"])
                          for _, _, px, _ in market.trades_since(o["t"]))
            if through:
                record_fill(o["qty"] if o["buying"] else -o["qty"], o["px"], o["qty"] * o["px"] * MAKER_FEE, "limit", o["call"], now - o["t"])
                st["order"] = None
            elif now > o["expires"]:
                st["order"] = None
                st["missed"] += 1
            return
        try:
            s = trader.order(o["id"])
        except BinanceError:
            return
        new = s["filled"] - o["seen_qty"]
        if new > 1e-12:  # count only the newly filled part, with its share of the fee
            px = s["avg_px"] or o["px"]
            record_fill(new if o["buying"] else -new, px, s["fee"] - o["seen_fee"], "limit", o["call"], now - o["t"],
                        new_order=o["seen_qty"] == 0)
            o["seen_qty"], o["seen_fee"] = s["filled"], s["fee"]
        if s["done"]:
            st["order"] = None
            st["missed"] += o["seen_qty"] == 0
        elif now > o["expires"]:
            trader.cancel(o["id"])
            o["expires"] = now + 3  # look once more for fills that raced the cancel, then let go

    def close_out() -> None:
        try:
            f = trader.flatten()
        except BinanceError as exc:
            console.print(f"  [#ff5d6c]couldn't close the position: {exc}. Close it on Binance manually.[/]")
            return
        if f and f["px"]:
            record_fill(f["dq"], f["px"], f["fee"], "market", None, 0)

    def halt(reason: str) -> None:
        st["halted"] = reason
        st["order"] = None
        console.print(f"\n  [bold #f5b53d]HALTED: {reason}[/]. Cancelling orders and closing the position.")
        if trader:
            trader.cancel_all()
            close_out()
        else:
            mid = market.snapshot()["mid"]
            if book.qty:
                record_fill(-book.qty, mid, abs(book.qty) * mid * TAKER_FEE, "market", None, 0)

    def risk_check(mid: float) -> None:
        if st["halted"]:
            return
        today = datetime.now(timezone.utc).date()
        if today != book.day:  # a new UTC day resets the loss limit
            book.day, book.day_start_net = today, book.net(mid)
        if book.net(mid) - book.day_start_net < -max_loss:
            halt(f"daily loss limit (${max_loss:,.0f}) reached")
        elif STOP_FILE.exists():
            halt("kill switch (STOP file)")

    def write(status: str) -> None:
        with lock:
            check_order()
            mid = market.snapshot()["mid"]
            risk_check(mid)
            recent = [d["t"] for d in decisions if d["t"] >= time.time() - 10]
            o = st["order"]
            payload = {
                "status": status, "venue": "binance", "ws_url": venue["ws_book"], "symbol": symbol, "coin": coin, "mode": mode,
                "venue_label": f"{symbol} · Binance", "mode_label": mode_label + (f" · HALTED: {st['halted']}" if st["halted"] else ""),
                "pace": pace_s, "interval": round(st["interval"], 3), "rate_per_s": round(len(recent) / 10, 2),
                "late_ms": late_ms, "strategy_note": strategy_note, "source": source, "execution": "maker", "maker_wait": maker_wait,
                "started": started, "updated": time.time(), "model": model.name if model else jev.model, "notional": position_usd,
                "maker_fee_bps": MAKER_FEE * 1e4, "taker_fee_bps": TAKER_FEE * 1e4, "counts": dict(counts), "blocks": len(decisions),
                "last_ms": latencies[-1] if latencies else None,
                "avg_ms": round(statistics.mean(latencies[-200:])) if latencies else None,
                "hits": st["hits"], "scored": st["scored"], "brain": brain.current(), "equity": st.get("equity"),
                "order": ({"target": o["target"], "buying": o["buying"], "px": o["px"], "t": o["t"]} if o else None),
                "decisions": decisions[-200:], "fills": fills[-100:], "exec": exec_summary(),
                "book": book.snap(time.time(), mid), "ticks": market.recent_ticks(),
            }
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, default=str))
        os.replace(tmp, out)

    def decide(rec: dict, now: dict) -> str:
        """Jev's call + Claude's bias -> strategy.decide() -> a post-only limit order. Runs under the lock."""
        if st["halted"]:
            return f"hold · halted ({st['halted']})"
        bias = brain.current().get("bias")
        if bias is None:
            return "hold · waiting for Claude's first read"
        market_view = {**rec["state"], "claude_bias": bias}
        pos = 1 if book.qty > 0 else -1 if book.qty < 0 else 0
        try:
            call = {"side": rec["side"], "conf": rec["conf"]}
            call.update({k: rec[k] for k in ("source", "edge_bps", "min_edge_bps", "horizon_s") if k in rec})
            choice = strategy.decide(call, market_view, pos, time.time() - st["last_trade_t"])
        except Exception as exc:
            return f"hold · strategy error: {str(exc)[:60]}"
        if choice not in ("buy", "sell", "flat"):
            return str(choice or "hold")
        want = {"buy": 1, "sell": -1, "flat": 0}[choice]
        if want == pos:
            return "hold · already " + {1: "long", -1: "short", 0: "flat"}[want]
        if st["order"]:
            if st["order"]["target"] == want:
                return "hold · limit order working"
            if trader:
                trader.cancel(st["order"]["id"])
            st["missed"] += st["order"]["seen_qty"] == 0
            st["order"] = None
        size = position_usd / now["mid"]
        size = trader.round_qty(size) if trader else round(size, 6)
        dq = want * size - book.qty
        buying = dq > 0
        qty = trader.round_qty(abs(dq)) if trader else round(abs(dq), 6)
        if trader and (qty < trader.min_qty or qty * now["mid"] < trader.min_notional):
            return "hold · order too small for Binance"
        px = now["bid"] if buying else now["ask"]
        order = {"target": want, "buying": buying, "qty": qty, "px": px, "t": time.time(), "expires": time.time() + maker_wait,
                 "call": rec["block"], "seen_qty": 0.0, "seen_fee": 0.0, "id": None}
        if trader:
            try:
                order["id"] = trader.place_post_only("buy" if buying else "sell", qty, px, reduce_only=(want == 0))
            except BinanceError as exc:
                return f"hold · order rejected: {str(exc)[:70]}"
        st["order"] = order
        st["orders"] += 1
        sig = {"t": order["t"], "live_mid": signal_market.snapshot()["mid"], "venue_mid": now["mid"], "edge_bps": rec.get("edge_bps")}
        if pos:  # closing (or flipping): the exit signal
            st["sig_exit"] = sig
        if want:
            st["sig_entry"] = sig
        return f"limit {'buy' if buying else 'sell'} {qty:g} @ {px:g}"

    def ask_model(rec: dict) -> None:
        t0 = time.time()
        edge = model.edge_bps(signal_market.trades_since(t0 - features.HISTORY_S), t0)
        ms = round((time.time() - t0) * 1000, 1)
        if edge is None:
            rec.update(side=None, conf=None, ms=None, status="warmup")
            return
        rec.update(side="buy" if edge >= 0 else "sell", conf=round(min(1.0, abs(edge) / min_edge), 3), ms=ms,
                   status="ok", source="model", edge_bps=round(edge, 2), min_edge_bps=min_edge,
                   horizon_s=model.horizon_s)

    def ask_jev(rec: dict) -> None:
        try:
            ans, meta = jev.ask(rec["state"], QUESTIONS, timeout=5.0, retries=0)
            side = ans["side"]["choice"]
            rec.update(side=side, conf=round(ans["side"]["probs"][side], 3), ms=meta["latency_ms"],
                       status="ok" if meta["latency_ms"] <= late_ms else "late")
        except JudgeError as exc:
            rec.update(side=None, conf=None, ms=None, status="throttled" if "429" in str(exc) else "error", error=str(exc)[:160])

    def ask(seq: int) -> None:
        rec = {"block": seq, "t_ask": time.time(), "state": signal_market.snapshot()["state"]}
        (ask_model if model else ask_jev)(rec)
        now = market.snapshot()
        rec.update(t=time.time(), mid=now["mid"], micro=now["micro"])
        with lock:
            counts[rec["status"]] += 1
            if rec["ms"]:
                latencies.append(rec["ms"])
            if rec["status"] == "throttled":  # back off up to 6x the pace (30s at --pace 5)
                st["interval"], st["streak"] = min(max(4.0, 6 * pace_s), st["interval"] * 1.6), 0
            elif rec["status"] == "ok":
                st["streak"] += 1
                if st["streak"] >= 3:
                    st["interval"] = max(pace_s, st["interval"] * 0.9)
            prev = st["prev"]
            if prev and now["mid"] != prev["mid"]:
                st["hits"] += (now["mid"] > prev["mid"]) == (prev["side"] == "buy")
                st["scored"] += 1
            if rec["status"] == "ok":
                st["prev"] = rec
                rec["action"] = decide(rec, now)
            elif rec["status"] == "late":
                rec["action"] = "hold · late"
            elif rec["status"] == "warmup":
                rec["action"] = f"hold · model warming up (needs {max(features.RET_WINDOWS) // 60} min of trades)"
            else:  # Jev didn't answer: fall back to strategy.py's rules-only call
                state = signal_market.snapshot()["state"]
                fb = strategy.fallback_call(state) if hasattr(strategy, "fallback_call") else None
                if fb:
                    rec.update(side=fb["side"], conf=fb["conf"], source="rules", state=state)
                    rec["action"] = decide(rec, now)
                else:
                    rec["action"] = f"{rec['status']} · no rules signal"
            decisions.append(rec)
            log.write(json.dumps(rec) + "\n")
            log.flush()
        if rec["action"].startswith("limit") or rec["action"].startswith("hold · order"):
            sig = f"model {rec['edge_bps']:+.1f}bps" if rec.get("source") == "model" else f"{rec.get('source') or 'Jev'} {(rec['conf'] or 0):.2f}"
            console.print(f"  {time.strftime('%H:%M:%S')}  #{rec['block']:<6} {(rec['side'] or '-').upper():<4} {sig}  →  {rec['action']}")

    def writer():
        last_eq = 0.0
        while not stop.is_set():
            if trader and time.time() - last_eq > 30:  # the real account balance, for the dashboard
                last_eq = time.time()
                try:
                    st["equity"] = trader.equity_usdt()
                except BinanceError:
                    pass
            try:
                write("running")
            except Exception as exc:  # a hiccup reading the exchange shouldn't stop the bot
                console.print(f"  [dim]status update skipped: {str(exc)[:80]}[/]")
            stop.wait(0.5)

    threading.Thread(target=writer, daemon=True).start()
    console.print("  [dim]trades and orders print here · the dashboard shows every call[/]")
    seq = 0
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            while not minutes or time.time() - started < minutes * 60:
                seq += 1
                pool.submit(ask, seq)
                time.sleep(st["interval"])
    except KeyboardInterrupt:
        pass
    stop.set()
    with lock:
        if trader:
            trader.cancel_all()
            if os.getenv("FLATTEN_ON_EXIT", "true").lower() != "false":
                close_out()
    write("done")
    log.close()
    exec_log.close()
    mid = market.snapshot()["mid"]
    console.print(f"\n  {len(decisions)} calls · {book.trades} fills · fees ${book.fees:.2f} · net ${book.net(mid):+.2f}")
