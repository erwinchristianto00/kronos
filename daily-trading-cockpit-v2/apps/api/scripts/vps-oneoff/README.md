# One-off scripts recovered from research/3101

Rescued 2026-07-28 from `/root/kronos/daily-trading-cockpit-v2/apps/api/src/` on the VPS.

They had lived only on that box: `git log --all -- <path>` returned nothing for all nine, so they
existed in no commit, on no branch, and in no other checkout. They are committed here so the 3101
working tree can be brought back in line with HEAD without destroying them.

They sat in `apps/api/src/`, which is exactly what `tsconfig.json` compiles (`include: src/**/*.ts`),
so on the VPS they were inside the typecheck surface while being ad-hoc maintenance tools. `scripts/`
is outside that surface and already holds ~40 scripts of the same character, so that is where they
belong. Run them with `npx tsx` from `apps/api` — several read stores under `data/`, so the working
directory matters.

| Script | What it does |
|---|---|
| `cgwide-exit-search.ts` | sweeps exit parameters for the CG_WIDE family |
| `cgwide-short-search.ts` | same sweep on the short side |
| `cgwide-reseed.ts` | reseeds CG_WIDE lane state |
| `lane-seed.ts` | seeds lane records |
| `honest-reresolve.ts` | re-resolves recorded outcomes without the optimistic path |
| `repair-axis-history.ts` | repairs the regime axis history store |
| `reset-regime-gate.ts` | clears the regime gate latch |
| `run-regime-validation.ts` | runs regime validation end to end |
| `live-preflight.ts` | preflight check against the Binance private client |

`live-preflight.ts` constructs a `BinanceFuturesPrivateClient` from config-supplied credentials
(`cfg.apiKey` / `cfg.apiSecret`). It embeds no literal secret — verified before committing — but it
does talk to a real exchange account, so check `env` before running it.

Nothing here is imported by the application. Treat them as archive: they are kept for provenance,
not maintained, and they were written against the store shapes of their time.
