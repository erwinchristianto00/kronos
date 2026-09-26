"""jev-starter CLI.

  uv run python -m jevlab check                # test the setup: live prices, headlines, and one real Jev call
  uv run python -m jevlab loop                 # the Jev Loop: live trading dashboard (paper), your strategy
  uv run python -m jevlab newsroom             # the news terminal: real headlines, Jev reading each one live
  uv run python -m jevlab bot --dry            # 24/7 bot on Binance prices with simulated fills (no Binance key)
  uv run python -m jevlab bot                  # 24/7 bot on Binance Demo Trading (fake money) · Claude sets the bias

Useful flags:
  --coin BTC        loop/bot: which coin to trade (default HYPE)
  --minutes 0       loop: run until Ctrl+C (default 10)
  --taker           loop: market orders instead of limit orders
  --gap 4           newsroom: seconds between replayed headlines (default 6)
  --port 8766       run a second dashboard alongside the first
  --no-open         don't open the browser
"""

from __future__ import annotations

import argparse
import threading


def check() -> None:
    import time

    from . import hl
    from .core import console
    from .judges import JevJudge, JudgeError
    from .news import fetch_headlines

    console.print("  [bold]1. Hyperliquid prices[/]")
    mids = hl.mids(["BTC", "HYPE"])
    console.print(f"     BTC {mids['BTC']:,.1f} · HYPE {mids['HYPE']:,.3f}  [#3fd68a]ok[/]")
    console.print("  [bold]2. News feeds[/]")
    n = len(fetch_headlines(24))
    console.print(f"     {n} headlines in the last 24h  [#3fd68a]ok[/]" if n else "     no headlines found  [#f5b53d]check your internet[/]")
    console.print("  [bold]3. Jev[/]")
    try:
        jev = JevJudge()
    except JudgeError:
        console.print("     [#f5b53d]no key yet[/]: paste your AI_GATEWAY_API_KEY into .env, save, and run this again")
        return
    q = {"side": {"type": "choice", "instructions": "Which side should a bot hold for the next few seconds?",
                  "criteria": {"buy": None, "sell": None}}}
    try:
        ans, meta = jev.ask({"return_5s_bps": 1.2, "top_of_book_imbalance": 0.4}, q, timeout=15, retries=2)
    except JudgeError as exc:
        msg = str(exc)
        if "401" in msg or "403" in msg:
            console.print("     [#ff5d6c]key rejected[/]: check the key in .env, and that your Vercel team has a card or credits")
        elif "429" in msg:
            console.print("     [#f5b53d]rate-limited[/]: the free tier is busy. Wait a minute, or add $5 of AI Gateway credits for full speed")
        else:
            console.print(f"     [#ff5d6c]failed[/]: {msg[:160]}")
        return
    side = ans["side"]["choice"]
    console.print(f"     Jev says [bold]{side.upper()} {ans['side']['probs'][side]:.0%}[/] in {meta['latency_ms']} ms "
                  f"(model {meta['model']})  [#3fd68a]ok[/]")
    console.print("  [bold]4. Speed[/]")
    ok = 0
    t0 = time.time()
    for _ in range(6):
        try:
            jev.ask({"return_5s_bps": 0.5}, q, timeout=10, retries=0)
            ok += 1
        except JudgeError:
            pass
        time.sleep(0.3)
    console.print(f"     {ok}/6 quick calls went through in {time.time() - t0:.1f}s · "
                  + ("full speed" if ok == 6 else "you're on the free tier, so the loop will run slower (add $5 of credits for full speed)"))
    check_binance()
    console.print("\n  [#3fd68a]All set.[/] Next: [bold]uv run python -m jevlab loop[/]")


def check_binance() -> None:
    import os

    from .core import console
    console.print("  [bold]5. Binance (only needed for the 24/7 bot)[/]")
    if not os.getenv("BINANCE_API_KEY", "").strip():
        console.print("     not set up yet (fine for the laptop version)")
        return
    from .binance import BinanceError, BinanceTrader, binance_mode
    try:
        mode = binance_mode()
        trader = BinanceTrader(os.getenv("BOT_SYMBOL", "HYPEUSDT"), mode)
        eq = trader.equity_usdt()
        console.print(f"     connected to Binance Futures [bold]{mode.upper()}[/] · equity {eq:,.2f} USDT  [#3fd68a]ok[/]" if eq is not None
                      else f"     connected to Binance Futures {mode.upper()}  [#3fd68a]ok[/]")
    except BinanceError as exc:
        msg = str(exc)
        if "restricted location" in msg or "451" in msg:
            hint = " (Binance blocks this server's country: use a server outside the US and other restricted regions)"
        elif "-2015" in msg or "-2014" in msg or "-1022" in msg:
            hint = (" (the key doesn't match this mode: a demo key only works with BINANCE_MODE=demo, a testnet key with "
                    "testnet, a live key with live. Also check Futures is enabled on the key and the IP whitelist)")
        else:
            hint = " (check the key and secret in .env)"
        console.print(f"     [#ff5d6c]Binance said no[/]: {msg[:140]}{hint}")
        return
    if mode != "live":
        console.print("     demo/testnet key: it can only move fake money  [#3fd68a]ok[/]")
        return
    try:  # safety checks on the live key itself
        r = trader.key_restrictions()
        if r.get("enableWithdrawals") or r.get("enableInternalTransfer") or r.get("permitsUniversalTransfer"):
            console.print("     [#ff5d6c]this key can WITHDRAW or TRANSFER funds[/]: make a new key with only Futures trading enabled")
        else:
            console.print("     key can't withdraw  [#3fd68a]ok[/]")
        console.print("     key is locked to your server's IP  [#3fd68a]ok[/]" if r.get("ipRestrict")
                      else "     key isn't locked to an IP yet (lock it to your server's IP)")
    except Exception:
        console.print("     [dim](couldn't read the key's permissions here, so double-check them on Binance: no withdrawals)[/]")


def main() -> None:
    ap = argparse.ArgumentParser(prog="jevlab")
    ap.add_argument("command", choices=["check", "loop", "newsroom", "bot"])
    ap.add_argument("--coin", default="HYPE", help="loop/bot: the coin to trade")
    ap.add_argument("--minutes", type=float, default=10.0, help="loop/bot: how long to run (0 = until stopped)")
    ap.add_argument("--pace", type=float, default=0.3, help="loop: fastest seconds between Jev calls")
    ap.add_argument("--late-ms", type=float, default=1500, help="loop: answers slower than this are ignored")
    ap.add_argument("--taker", action="store_true", help="loop: market orders instead of limit orders")
    ap.add_argument("--maker-wait", type=float, default=10.0, help="loop: seconds a limit order rests before cancel")
    ap.add_argument("--hours", type=float, default=36.0, help="newsroom: how far back to replay headlines")
    ap.add_argument("--gap", type=float, default=6.0, help="newsroom: seconds between replayed headlines")
    ap.add_argument("--dry", action="store_true", help="bot: Binance prices but simulated fills, no Binance key needed")
    ap.add_argument("--brain-every", type=float, default=10.0, help="bot: minutes between Claude's big-picture reads")
    ap.add_argument("--port", type=int, default=8765, help="dashboard port")
    ap.add_argument("--no-open", action="store_true", help="don't open the dashboard in a browser")
    a = ap.parse_args()

    from .core import console
    if a.command != "bot":  # the bot prints its own banner, with its trading mode
        console.print("[bold #8b7bff]jev-starter[/] [dim]· paper trading on live Hyperliquid data · no real orders are ever placed[/]")

    if a.command == "check":
        check()
        return
    if a.command == "loop":
        from .loop import run_loop
        run_loop(a.coin.upper(), a.pace, a.minutes, a.port, not a.no_open, a.late_ms, not a.taker, a.maker_wait)
    elif a.command == "bot":
        from .bot import run_bot
        run_bot(a.coin.upper(), a.pace, a.minutes, a.port, not a.no_open, a.late_ms, a.maker_wait, a.brain_every, a.dry)
        if a.no_open and not a.minutes:
            return
    else:
        from .newsroom import run_newsroom
        run_newsroom(a.hours, a.gap, a.port, not a.no_open)
    console.print("  [dim]dashboard still open · Ctrl+C to stop[/]")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
