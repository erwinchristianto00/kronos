# Live Readiness Roadmap — Binance Futures (USD-M)

Status: **report-only by design, NOT live-ready.** This is the path to change that
safely. Each phase has a hard go/no-go gate; you do not advance until the gate passes.

---

## 0. Honest starting point (why this is a build project, not a config step)

- The system is architected report-only: hard invariants `liveBlocked: true`,
  `microPilotAllowed: false`; the resolver "consumes klines and nothing else, NEVER
  places a real exchange order." **There is no live order-execution module today.**
- The code's own live gate requires three things that are currently **spec-only, not
  implemented**: kill-switch, order-reconciliation, exchange-health.
- Edge evidence is only ~1 day old *after* the R-denominator bug fix (2026-06-10).
  Headline scaleout has **0 closed trades**. Top-symbol concentration is **51%** (cap
  is 40%). Mixed guardrail is currently `ROLLBACK_RECOMMENDED`.
- ⇒ Connecting a trade-enabled key now would risk the account. Real money does not
  touch the market until **Phase 4**, and only at microscopic size.

## Key-security rules (apply to every phase, no exceptions)

- API keys **never** in chat, never in code, never committed. They live only in a
  local `.env` / secret store; the code reads them from env. (Exact env var names
  confirmed against the binance client at build time of each phase.)
- **Withdrawals and internal transfer: always OFF** on every key, every phase.
- **IP whitelist** every key to the bot server's IP.
- Least privilege: a key gets the *minimum* scope the phase needs (read-only until F4).
- If a key ever appears in chat/logs/commit → treat as compromised, revoke immediately.

---

## Phase 0 — Read-only connection (ZERO trading risk)

**You provide:** a Binance **Futures (USD-M)** API key with **"Enable Reading" ONLY**
(trading OFF, futures-trading OFF, withdrawals OFF), IP-whitelisted; plus the server IP
and which account it is.

**Build/validate:**
- Read-only account client (balance, positions, open orders, leverage/margin mode).
- Reconcile reality vs paper assumptions: starting equity, symbol universe (USDT-perps),
  contract specs (tick/step size, min notional), funding schedule.
- Confirm market-data path (klines) matches what the resolver already uses.

**Gate → F1:** balances/positions read correctly; contract specs captured; data plumbing
verified. Still zero ability to trade.

---

## Phase 1 — Execution module on TESTNET (fake money)

**You provide:** Binance Futures **TESTNET** key+secret (separate site/account from
mainnet — fake funds).

**Build:**
- Order placement: market + limit, **reduce-only** for exits; map paper geometry
  (entry / stop / TP1 / scaleout 50%+trail) → real bracket/OCO-style orders.
- Position + leverage + margin-mode setup per symbol.
- Order-state machine + **reconciliation**: local intent vs exchange truth, every poll.
- Idempotency / dedupe (no double-submits), retry+backoff, **partial-fill** handling,
  cancel-on-restart of stale intents.

**Validate on testnet:**
- Fills land where expected; **measure real slippage** and replace the *assumed*
  `PAPER_EXECUTION_MODEL_REALISTIC` (entry 2bps / stop 5bps — these are guesses today).
- Reconciliation actually catches injected mismatches (orphan order, missed fill).

**Gate → F2:** ≥ ~50 testnet trades reconcile cleanly; measured slippage replaces
assumptions; zero orphan/unreconciled orders across a restart.

---

## Phase 2 — Infra safety gates (the code's own requirements, built for real)

The live-trading-gate needs `killSwitchReady / orderReconciliationReady /
exchangeHealthReady` to be genuinely true. Build + test each:

- **Kill-switch (LIVE-enforced, not paper):** on max-drawdown breach (our paper
  circuit-breaker is −15R/halt-admission; the live version must **cancel open orders +
  flatten positions + block new entries**), plus manual kill and heartbeat-loss kill.
- **Order reconciliation (continuous):** local book vs exchange truth; on divergence →
  alert + halt; recover correct state on process restart.
- **Exchange health:** detect API errors / rate-limit / stale data / clock skew →
  degrade to halt rather than trade blind.

**Gate → F3:** all three implemented and **fault-injection tested** (kill the process
mid-trade, simulate a rejected order, feed stale data) and recover safely.

---

## Phase 3 — Edge confirmation on POST-FIX data only

Pre-fix numbers are tainted by the R-denominator bug — do not cite them. Require fresh,
honest evidence:

- Headline **scaleout: ≥ 100–200 closed**, across **≥ 2 regimes**, OOS-positive, from
  **post-fix mirrors only**.
- Top-symbol concentration **≤ 40%** (currently 51%).
- Realistic cost model populated with **measured** testnet/live slippage (not the 2/5bps
  assumption).
- Mixed guardrail **not** in `ROLLBACK_RECOMMENDED`.
- Return is **risk-adjusted** (portfolio-heat sizing caps correlated exposure — the
  prior book's 114%-correlated-long was the live-death failure mode, not edge).

**Gate → F4:** edge holds with honest numbers AND survivable risk-adjusted, on a sample
that includes at least one adverse/chop stretch.

---

## Phase 4 — Micro-pilot LIVE (tiny real money, manual per-session approval)

**You provide:** a mainnet key with **Futures TRADING enabled**, **withdrawals +
transfer OFF**, IP-whitelisted. Plus your risk limits: per-trade $ risk, daily loss
limit, max leverage, max concurrent positions, starting pilot capital.

**Controls (all live-enforced):**
- Microscopic fixed size (cap risk to a few dollars per trade).
- Live portfolio **drawdown circuit-breaker** (flatten + halt, not just stop admitting).
- **Per-symbol + correlated-exposure caps** (the 114%-correlated failure mode).
- Daily loss limit, max concurrent positions, **low leverage cap**.
- **Manual approval to arm each session** (flip `liveBlocked` deliberately, never by
  default).
- **Shadow-vs-live divergence monitor:** live fills must track the paper resolver within
  tolerance; divergence → halt.

**Gate → F5:** micro-pilot matches paper expectation over a real sample (incl. a losing
stretch) with reconciliation clean and the kill-switch verified to actually fire.

---

## Phase 5 — Scale-up

Only after the pilot proves out. Increase size **gradually**, tied to confirmed
risk-adjusted return and the sizing rules — never step-change. Re-run the heat/ruin
check at each size.

---

## What I need from you to START (Phase 0)

1. Read-only Futures key created with the scopes above (you keep the values; tell me
   you've put them in the env, don't paste them).
2. The bot server's public IP (for the Binance IP whitelist).
3. Confirm: which account (Futures USD-M), and starting capital you intend for the pilot.
4. Your hard risk limits (per-trade $, daily loss cap, max leverage) — used to wire the
   live caps later.

## Non-negotiables (the whole way)

- `liveBlocked` stays TRUE until an explicit, manual flip at Phase 4.
- Keys never in chat/code; withdrawals/transfer never enabled.
- Start microscopic; size only follows proven, honest, risk-adjusted edge.
- No phase skipped. The gates exist because each one is a way to lose the account.
