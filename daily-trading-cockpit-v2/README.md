# Daily Trading Cockpit v2

Paper-only crypto scanner built as a clean-room v2:

- `apps/web`: Vite + React + TypeScript dashboard
- `apps/api`: Fastify + TypeScript scan API
- `services/kronos`: FastAPI adapter service for official Kronos integration
- `packages/shared`: shared types and scan logic helpers

## Environment

Copy `.env.example` into your local env file or shell session:

```bash
KRONOS_BASE_URL=http://localhost:8001
KRONOS_PREDICT_TIMEOUT_MS=45000
KRONOS_SAMPLE_RUNS=2
SOCIAL_SENTIMENT_PROVIDER=none
SOCIAL_SENTIMENT_URL=
```

`SOCIAL_SENTIMENT_PROVIDER` supports:

- `none`
- `custom`
- `feargreed`
- `reddit`

## Run

1. `npm install`
2. Start the API: `npm run dev -w @dtc/api`
3. Start the web app: `npm run dev -w @dtc/web`
4. Optional: start Kronos from `services/kronos`
5. Optional: enable a social provider with `SOCIAL_SENTIMENT_PROVIDER`

You can still use the root `npm run dev` helper if you want both web and API together.
Use `npm run dev:full` when you want web, API, and Kronos together in one command.
`dev:full` automatically loads repo-root `.env` before starting the stack.

Dev wiring:

- Web: `http://localhost:5173`
- API: `http://localhost:3101`
- Scan endpoint: `GET /api/scan`
- Health endpoint: `GET /api/health`

The scanner keeps running when optional sources fail:

- Binance: always required
- Kronos: active when the default `http://localhost:8001` service is healthy, or when `KRONOS_BASE_URL` points at a healthy model-backed service
- Whale: active when Binance futures-flow data is reachable
- Social: active only when the configured provider returns valid data

Unavailable optional sources stay weightless and move into Source Status instead of card blockers.

## Optional Kronos service

From `services/kronos`:

```powershell
.\setup.ps1
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001
```

Then set:

```bash
KRONOS_BASE_URL=http://localhost:8001
```

The wrapper uses the official `shiyu-coder/Kronos` repo and only contributes score when `/health` reports `modelConnected: true` and `/predict` returns a valid forecast-derived payload.

Once the Python env is prepared, you can also boot everything together from the repo root:

```bash
npm run dev:full
```

If Kronos has not been set up yet, `dev:full` stops with a clear message telling you to run `services/kronos/setup.ps1` first.
If `.env` exists at the repo root, `dev:full` imports it so `KRONOS_BASE_URL` and social provider settings are available to the API immediately.
If `.env` is missing, `dev:full` now defaults `KRONOS_BASE_URL` to `http://localhost:8001` and `SOCIAL_SENTIMENT_PROVIDER` to `none`.

## Optional social providers

- `custom`: fetches `SOCIAL_SENTIMENT_URL?symbol=BTCUSDT` and expects `{ signal, score, confidence, scope, source, reason }`
- `feargreed`: uses Alternative.me Fear & Greed as a market-wide sentiment source only
- `reddit`: uses Reddit OAuth with `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`, then reads recent posts/comments from configured subreddits for symbol-level sentiment

If any provider errors or rate-limits, the API marks it unavailable and the scanner continues without social weight.

Recommended env for Reddit:

```bash
SOCIAL_SENTIMENT_PROVIDER=reddit
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=daily-trading-cockpit-v2/0.1
REDDIT_SUBREDDITS=CryptoCurrency,Bitcoin,ethtrader,solana,Altcoin
```
