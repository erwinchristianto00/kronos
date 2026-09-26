"""Claude as the big-picture brain (Path 2).

Every few minutes, Claude reads a plain summary of the market (recent price moves,
volatility, funding, and the latest crypto headlines) and sets the bias for the
next stretch: long, short, or flat. Jev and strategy.py still make the fast calls,
but only in the direction Claude allows.

Two ways to reach Claude, set with CLAUDE_BACKEND in .env:
  cli      (default) The Claude Code CLI (`claude -p`), logged in with your own Claude
           subscription on this machine. Model CLAUDE_CLI_MODEL (default claude-opus-5-5),
           effort CLAUDE_EFFORT (default medium). No API credits needed.
  gateway  The Vercel AI Gateway, with the same key as Jev. Model CLAUDE_MODEL
           (default anthropic/claude-sonnet-5). Needs AI Gateway credits.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
import time

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions"
BINANCE_REST = "https://fapi.binance.com"


def _get(url: str, **params):
    r = requests.get(url, params=params, timeout=10)
    if r.status_code != 200:  # e.g. 451 = Binance doesn't serve this server's country
        raise RuntimeError(f"Binance HTTP {r.status_code}: {r.text[:120]}")
    return r.json()


def market_summary(symbol: str, rest: str = BINANCE_REST) -> dict:
    """Plain numbers Claude can reason about, from Binance's public futures market data."""
    k = _get(f"{rest}/fapi/v1/klines", symbol=symbol, interval="5m", limit=49)
    closes = [float(r[4]) for r in k]  # oldest -> newest, 5-minute bars, last ~4 hours
    t = _get(f"{rest}/fapi/v1/ticker/24hr", symbol=symbol)
    f = _get(f"{rest}/fapi/v1/premiumIndex", symbol=symbol)
    pct = lambda a, b: round(100 * (b / a - 1), 2)
    moves = [abs(pct(a, b)) for a, b in zip(closes, closes[1:])]
    return {
        "symbol": symbol,
        "price": closes[-1],
        "change_15m_pct": pct(closes[-4], closes[-1]),
        "change_1h_pct": pct(closes[-13], closes[-1]),
        "change_4h_pct": pct(closes[0], closes[-1]),
        "change_24h_pct": round(float(t["priceChangePercent"]), 2),
        "avg_5m_move_pct": round(sum(moves) / len(moves), 3),
        "high_4h": max(closes), "low_4h": min(closes),
        "funding_rate_pct": round(100 * float(f.get("lastFundingRate") or 0), 4),
    }


def headlines(limit: int = 8) -> list[str]:
    try:
        from .news import fetch_headlines
        return [h["headline"] for h in fetch_headlines(6, quiet=True)][-limit:]
    except Exception:
        return []


def find_claude() -> str:
    """The Claude Code CLI: CLAUDE_BIN, then PATH, then the installer's usual spots (systemd has a bare PATH)."""
    for c in (os.getenv("CLAUDE_BIN", "").strip(), shutil.which("claude"),
              str(Path.home() / ".local/bin/claude"), "/root/.local/bin/claude", "/usr/local/bin/claude"):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return "claude"


PROMPT = """You are the portfolio manager for a small, cautious crypto trading bot.
A fast AI makes buy/sell calls every second, but it can only trade in the direction you allow.
Decide the bias for the next {minutes} minutes: "long" (only buying allowed), "short" (only selling allowed),
or "flat" (stay out, close any position).
If the evidence leans one way (momentum across timeframes, funding, the news), pick that side and let
"confidence" say how strongly it leans. Choose "flat" only when the signals genuinely conflict or the market is dead.

Market data:
{summary}

Latest crypto headlines:
{news}

Reply with ONLY a JSON object: {{"bias": "long" | "short" | "flat", "confidence": 0.0-1.0, "reason": "one short sentence"}}"""


class Brain:
    def __init__(self, symbol: str, every_min: float, rest: str = BINANCE_REST):
        self.key = os.getenv("AI_GATEWAY_API_KEY", "").strip()
        self.backend = os.getenv("CLAUDE_BACKEND", "cli").strip().lower()
        if self.backend == "cli":
            self.model = os.getenv("CLAUDE_CLI_MODEL", "claude-opus-5-5").strip()
            self.effort = os.getenv("CLAUDE_EFFORT", "medium").strip()
            self.claude_bin = find_claude()
        else:
            self.model = os.getenv("CLAUDE_MODEL", "anthropic/claude-sonnet-5").strip()
        self.symbol, self.every, self.rest = symbol, every_min, rest
        self.state = {"bias": None, "confidence": None, "reason": "waiting for Claude's first read", "t": None,
                      "model": self.model, "ms": None, "error": None}
        self.lock = threading.Lock()

    def _ask_gateway(self, prompt: str) -> str:
        body = {"model": self.model, "temperature": 0, "max_tokens": 200, "messages": [{"role": "user", "content": prompt}]}
        r = requests.post(CHAT_URL, headers={"Authorization": f"Bearer {self.key}"}, json=body, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
        return r.json()["choices"][0]["message"]["content"]

    def _ask_cli(self, prompt: str) -> str:
        cmd = [self.claude_bin, "-p", prompt, "--model", self.model, "--effort", self.effort, "--output-format", "json",
               "--tools", "", "--no-session-persistence"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=os.path.dirname(__file__))
        try:
            res = json.loads(p.stdout)
        except ValueError:
            raise RuntimeError(f"claude CLI exit {p.returncode}: {(p.stderr or p.stdout)[:160]}")
        if res.get("is_error") or p.returncode != 0:
            raise RuntimeError(f"claude CLI: {str(res.get('result') or res)[:160]}")
        return res["result"]

    def think(self) -> None:
        t0 = time.time()
        try:
            summary = market_summary(self.symbol, self.rest)
            news = "\n".join(f"- {h}" for h in headlines()) or "- (none)"
            prompt = PROMPT.format(minutes=self.every, summary=json.dumps(summary, indent=1), news=news)
            text = self._ask_cli(prompt) if self.backend == "cli" else self._ask_gateway(prompt)
            out = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
            bias = out.get("bias") if out.get("bias") in ("long", "short", "flat") else "flat"
            with self.lock:
                self.state.update(bias=bias, confidence=float(out.get("confidence") or 0), reason=str(out.get("reason", ""))[:160],
                                  t=time.time(), ms=round((time.time() - t0) * 1000), error=None, summary=summary)
        except Exception as exc:  # keep the last bias; if there's never been one, the bot stays flat
            with self.lock:
                self.state["error"] = str(exc)[:160]
                if self.state["bias"] is None:
                    self.state.update(bias="flat", reason="Claude unavailable, staying out", t=time.time())

    def start(self, stop: threading.Event) -> None:
        def run():
            while not stop.is_set():
                self.think()
                stop.wait(self.every * 60)
        threading.Thread(target=run, daemon=True).start()

    def current(self) -> dict:
        with self.lock:
            return dict(self.state)
