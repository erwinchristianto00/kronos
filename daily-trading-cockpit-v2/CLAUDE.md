# Kronos — operating rules

Real money runs here. `/live` port 3103 (`/root/kronos-live`) is a real Binance mainnet account.
Read this before asserting a cause or touching an instance.

## The rule that would have prevented every expensive mistake so far

**Do not state a cause until you have enumerated every path to the effect.**

Every costly error in this repo has the same shape: one grep, one store, one endpoint looked
conclusive, and the conclusion was stated with confidence and was wrong. Real instances:

- "The lane can't trade live, it isn't in the allocation table" — a force-eligible path bypasses
  the allocation table entirely. It was trading. Real money.
- "The lane is silent because a gate blocks it" — it was allowed; there were no OPEN signals.
- "`rcsTick` isn't scheduled" — it is; the grep filtered the line out.
- "Widening the universe only adds correlated duplicates" — true for the 20 cycles that already
  fire, false for the 1,309 that fire nothing, which is the case that matters.

When a check returns nothing, the first hypothesis is that the check is wrong, not that the thing
is absent. Say "I checked X and found nothing" — never "X does not happen".

**In this repo, EMPTY almost always means UNREAD, not ABSENT.** Four times in one session a value
was declared missing when the producer was running the whole time and only the reader was missing:

- `kronosAgree: null` with the note "no sync kronos-agree producer" — Kronos was running on the VPS
  (pm2 `kronos`, 127.0.0.1:8001) and the scanner already called it every cycle.
- crowding/sentiment "missing" — the live journal showed `crowdAlignLong` and `sentiment` FRESH on
  672 of 672 records. They had never been missing.
- SCALP "has no caller" — one default list, `["INTRADAY","SWING"]`, never mentioned it. SCALP is
  fully defined downstream (`HORIZON_MS.SCALP`, accepted by the outcome ledger).
- `liquidity` "no market liquidity/depth feed in repo" — `/fapi/v1/depth` and bookTicker are both
  in binance.ts.

So before concluding a source does not exist: grep the client for the endpoint, grep pm2 for the
process, and read the LIVE journal's `sourceStatuses` rather than a test fixture or a code comment.
A comment saying something is unavailable records what was true when it was written.

## Before believing any lane number

- `distinct(netR) / n`. A lane once read **+0.4200R at WR 100% on n=201** that was ONE value
  repeated 201 times — a fixed TP against a flat cost. It reached real money and lost.
- Count **independent episodes**, not rows. Signals fire on several symbols at the same instant
  from one market-wide reading; those are one observation. Book-wide, 7,653 closes collapse to 52
  episodes. Every SE/MDE in this system is understated 3–12×.
- Check what is **excluded** before it reaches the consumer. `MAX_HOLD_MTM` rows are dropped on the
  CORTEX ingest path and they are 75% losses — the mean you are reading has had its loss side
  removed.
- A lane's own store may hold only closed rows while its executor filters `status === "OPEN"`.
  "Store has 31 observations" does not mean the executor ever saw one.

## Attribution on live

- **Live intents carry no `laneId`.** Attribute through `position-paths.json` → `meta.laneId`,
  keyed `intent:<paperOrderId>:<openedAt>`.
- `paperOrderId` values beginning `rts-` come from `realtime-short-mirror.ts` and **exist in no
  paper store**. Any join through the paper router returns zero rows — that is not evidence of
  absence.
- Lanes reach live through more than the allocation table. `FORCE_ELIGIBLE_LONG_VARIANT_IDS` /
  `..._SHORT_...` (gated by `REALTIME_SHORT_FORCE_FAST_LONG` / `..._SHORT`) never read it.

## Gates that reject without leaving a trace

- `single-symbol-price-timeline.ts` `entryGate()` requires its own forecast directive to match the
  lane's direction, and rejects with `continue` **without** adding to `attemptedObservationIds`.
  A lane declining every signal then looks identical to a lane with no signals: `allowed: true`,
  `lastEntrySkipReason: null`, nothing in any store, nothing in the logs. It vetoed everything for
  days. Scoped to tracked symbols only (BTC/ETH/SOL) — others bypass it.
- A null `entryBlockReason` means "not blocked by the conditions the reason function can see".
  Since 2026-07-27 it reports the real binding condition; before that it only reported the edge
  veto, one of five.
- `maxSignalAgeMs` bounds how long a signal stays *actionable*, independent of how long it stays
  OPEN. RC signals live 11.6h and were actionable for 10 minutes against a 5-minute tick.

## Touching the instances

- Deploys go to research (3101) and testnet (3102). **Live needs explicit authorisation each time.**
- **Never rsync `app.ts` to live.** It differs from HEAD by ~514 lines / 72 hunks *by design*.
  Patch surgically, diff the result against the live file before sending, and typecheck **on the
  server** before restarting — a broken file only fails at restart.
- `/testnet` and `/live` are rsync-only and drift silently. Hash-diff before restarting anything.
- Before any restart, `find src -newermt <process start>` — a restart activates whatever is on disk.
- **Deploying a file also deploys its imports, or the instance dies on restart.** rsyncing individual
  files onto a shared checkout breaks the moment the other agent has added a module: on 2026-07-28
  `app.ts` went to research importing `innovation-testnet-execution.js`, which existed locally (their
  commit, pulled) but had never been shipped there — research crash-looped on ERR_MODULE_NOT_FOUND
  and was down until the missing file followed. Mechanical check, run BEFORE the restart:
  `grep -oE 'from "\./lib/[a-z0-9-]+\.js"' app.ts` and confirm each one exists on the target. Then
  restart, then confirm `/api/health` returns 200 — a deploy is not finished at rsync.
- Never print `.env` values. Back up `.env` before editing; verify the line count is unchanged.
- **Never POST to `/api/live/copy-intent`** — it opens real mainnet positions.
- A blanket `new-entry-drain` masks every executor's real reason (drain is checked before
  allocation, eligibility and veto). Once a targeted control exists, lift the blanket.

## Tests

- Run with **`npm test`** from the repo root. `npx vitest run` from the root used to fall back to
  vitest's 5s default and produced a rotating cast of phantom failures; a root `vitest.config.ts`
  now fixes that, but `npm test` is still the canonical command.
- Every fix needs a fail-without/pass-with test **and** a mutation check: break the fix, confirm
  exactly the intended test goes red.
- Source-level guards: brace-match the method's own body via `{\n`. Three of the executor methods
  return `Promise<{ changed: boolean; closed: boolean }>`, so `indexOf("{")` lands in the return
  type and matches an empty body while the guard is present and correct.

## Environment

- A concurrent Codex agent shares this checkout and commits to it. `git log --oneline -5` first.
- **A web `dist/` deploy silently overwrites whatever the other agent deployed**, and nothing on the
  page says which build it is. On 2026-07-28 a dashboard card deployed at 05:09 was gone by 05:23
  because the other agent pushed a `dist` built from a checkout that predated it — the API was
  healthy the whole time, so it looked like a backend regression. Before deploying `dist`: rebuild
  from current HEAD (never ship a stale local build), deploy the SAME bundle to every instance, and
  verify with `grep` for a string unique to your change plus a `sha256sum` of `index.html` matching
  across instances. If a panel vanishes and the endpoint still returns the data, suspect the bundle
  first.
- Binance market data is geo-blocked from Indonesia (testnet is fine); mainnet reads need WARP.
- Deeper history lives in `~/.claude/projects/-Users-erwin-Projects/memory/`. `MEMORY.md` is only
  the index — the file contents do **not** load automatically. Read the specific file before
  re-deriving anything it covers.
