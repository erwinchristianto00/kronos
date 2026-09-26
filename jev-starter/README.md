# jev-starter

A Jev trading bot you can watch, test, and plug your own strategy into.
**The laptop version is paper trading only**: it reads live public market data and simulates fills, with no exchange account needed. The optional **24/7 bot** (Path 2) trades on Binance USDⓈ-M Futures, starting on Binance Demo Trading (fake money).

## What's inside

| | |
|---|---|
| **Jev Loop** · `uv run python -m jevlab loop` | Live dashboard: the real price ticking about 8 times a second, Jev's BUY/SELL calls landing on it, and your strategy deciding which calls become trades. Shows P&L before and after fees on a $1,000 paper position. |
| **Newsroom** · `uv run python -m jevlab newsroom` | A news terminal. It replays the last 36 hours of real crypto headlines in fast motion, Jev reads each one live (which coin, which way, how big), and then shows what the price actually did next. |
| **Your strategy** · `jevlab/strategy.py` | The one file you edit. `decide()` gets Jev's call and the live market numbers, and returns `"buy"`, `"sell"` or `"hold · reason"`. |
| **Setup check** · `uv run python -m jevlab check` | Tests prices, news feeds, your Jev key and your speed tier. |

## Setup

1. Install [uv](https://docs.astral.sh/uv/).
2. `cp .env.example .env` and paste your Vercel AI Gateway key after `AI_GATEWAY_API_KEY=`.
   Get one at vercel.com/dashboard → AI Gateway → API Keys. The free tier works but is slow (about one Jev call every 2 seconds); $5 of AI Gateway credits runs it at full speed. Each call costs a tiny fraction of a cent.
3. `uv sync`, then `uv run python -m jevlab check`.

## Plug in your own strategy

Open `jevlab/strategy.py`. The default is three simple rules:
- only act when Jev is at least 85% sure
- wait 15 seconds between flips
- let the loop use limit orders

Change `SETTINGS`, or rewrite `decide()`. There's a trend-following example at the bottom of the file. Easiest route: tell Claude your idea in one sentence and ask it to rewrite `decide()`. Then run `uv run python -m jevlab loop` again and watch what changes.

Before trusting any strategy, ask three questions:
1. Why should it make money?
2. Does it still make money after costs?
3. Does it work on data it's never seen?

## Flags

`--coin BTC` · `--days 45` (train) · `--minutes 0` (run until Ctrl+C) · `--taker` (market orders) · `--gap 4` (newsroom pace) · `--port 8766` (a second dashboard) · `--no-open`

## The 24/7 bot (Path 2): Claude + Jev on Binance Futures

`uv run python -m jevlab bot` runs the same loop against Binance USDⓈ-M Futures, with Claude as the big-picture brain:
- **Claude** reads the market every 10 minutes and sets the bias: long, short or flat. By default it runs through the Claude Code CLI (`claude -p`) logged in with your own Claude subscription (`CLAUDE_BACKEND=cli`, model `CLAUDE_CLI_MODEL`, effort `CLAUDE_EFFORT`); `CLAUDE_BACKEND=gateway` uses the Vercel key instead
- **Jev** makes the fast calls
- **`strategy.py`** only trades in Claude's direction

It starts on **Binance Demo Trading** (fake money; `BINANCE_MODE=testnet` uses the older futures testnet instead). `--dry` runs it on Binance prices with simulated fills and needs no Binance key. The futures account must be in One-way position mode, and the server must be in a country Binance serves (not the US).

### The local signal model (default)

Instead of asking Jev, the bot can use its own small model, trained on SOL's real trade history:

```
uv run python -m jevlab train --coin SOL     # downloads 45 days of Binance trades, tests, writes models/SOLUSDT.json
```

- It predicts the price move over the next 15 minutes from the last 2 minutes of trade flow (returns,
  aggressive buying vs selling, activity). It runs on the server in well under a millisecond, with no API.
- The bot enters only when the predicted move is at least 6 bps and Claude's bias agrees, holds 15 minutes,
  then exits unless the model still points the same way.
- `train` tests it walk-forward (train on 25 days, test on the next 5 unseen days) and writes
  `models/SOLUSDT-report.md`. Read it: the edge is small, uncertain, and assumes limit orders fill at the mid.
- Retrain every week or two. The bot warns when the model's data is more than 14 days old.
- `SIGNAL_SOURCE=jev` in `.env` switches back to Jev (with a rules-only fallback when Jev is busy).

On the testnet, signals read the real Binance market (the testnet's own book is thin and unrealistic),
while orders go to the testnet.

Safety, always on:
- post-only limit orders
- `MAX_POSITION_USD` and `MAX_DAILY_LOSS_USD` limits
- a kill switch: create a file called `STOP` and it closes out and halts
- on shutdown it cancels orders and closes the position

Real money needs `BINANCE_MODE=live` **and** the exact confirmation phrase in `JEV_LIVE_CONFIRM`. Set those yourself, after weeks of demo results.

To run it 24/7, put it on an always-on server (a small Linux VPS) with `deploy/jev-bot.service`. The setup prompt walks through all of it. Not financial advice.
