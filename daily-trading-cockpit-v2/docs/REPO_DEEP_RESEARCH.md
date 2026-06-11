# Daily Trading Cockpit v2 — Deep Research Reference

> **Tujuan dokumen:** Satu file komprehensif yang menjelaskan seluruh repo secara mendalam untuk keperluan deep research / audit / onboarding. Ditulis berdasarkan keadaan aktual repo per Mei 2026.
>
> **Bahasa:** Konsep teknis tetap dalam Bahasa Inggris (sesuai kode). Narasi penjelas dalam Bahasa Indonesia.

---

## DAFTAR ISI

1. Ringkasan Eksekutif
2. Arsitektur Tingkat Atas
3. Struktur Workspace (Monorepo)
4. Konsep & Vokabulari Inti
5. Data Flow End-to-End
6. Sub-sistem: Live Behavior
7. Sub-sistem: Shadow / Report-Only Lanes
8. Evidence Pipeline & Validation Layers
9. File-by-File Map (apps/api/src/lib)
10. Routes API
11. Shared Package
12. Data Storage Layer
13. Service Kronos (Python)
14. Test Suite
15. Sejarah Fase Pengembangan
16. State Saat Ini & Open Issues
17. Daftar Istilah / Glossary

---

## 1. Ringkasan Eksekutif

**Daily Trading Cockpit v2 (DTC v2)** adalah sistem **paper-trading / scanning crypto** yang dibangun dalam pendekatan *clean-room*. Sistem ini:

- **Tidak menjalankan trade real.** Semua eksekusi bersifat *paper* (shadow / simulasi).
- **Multi-source scoring:** menggabungkan sinyal teknikal (Binance OHLCV), prediksi ML (Kronos), aliran whale (Binance futures), dan sentimen sosial (Reddit / Fear & Greed).
- **Report-only evidence lanes:** beberapa "shadow lanes" mengumpulkan bukti tanpa pernah memengaruhi keputusan live.
- **Monorepo TypeScript** dengan workspace `apps/*` dan `packages/*`, plus service Python untuk Kronos.
- **Disiplin arsitektur ketat:** isolasi antara "live behavior" dan "audit / shadow" lanes; data file `data/shadow-positions.json` (live shadow tape) tidak boleh disentuh oleh analytics report-only.

Komponen utama:
| Komponen | Path | Fungsi |
|---|---|---|
| Web UI | `apps/web` | Vite + React dashboard (port 5173) |
| Scanner API | `apps/api` | Fastify + TS (port 3101); inti sistem |
| Shared types | `packages/shared` | Tipe TS, indikator, calibrated expectancy, edge model |
| Kronos service | `services/kronos` | FastAPI wrapper untuk model Kronos (port 8001) |

Stats: **~38,000 baris source code di apps/api/src/lib**, 62 file test, ~1,162 test passing. Build clean (vite + tsc).

---

## 2. Arsitektur Tingkat Atas

```
┌──────────────────────────────────────────────────────────────────────┐
│                         User Browser (5173)                          │
│                          apps/web (React)                            │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ HTTP
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│              apps/api  (Fastify, port 3101)                          │
│                                                                       │
│  Routes:    /api/scan  /api/shadow/*  /api/kronos/*  /api/outcomes/* │
│  Services:  ScanService  ShadowExecutionEngine  SignalTracker        │
│             OutcomeChecker  DecisionLedger                           │
│                                                                       │
│  Libraries (~60 files in src/lib): scoring, analytics, audit         │
└─────┬──────────────────────┬──────────────────┬──────────────────────┘
      │                      │                  │
      ▼                      ▼                  ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Binance API │   │  Kronos service  │   │  Social (Reddit/ │
│  (OHLCV,     │   │  (port 8001)     │   │  Fear&Greed/...) │
│   whale flow)│   │  vendor model    │   │                  │
└──────────────┘   └──────────────────┘   └──────────────────┘

                         │
                         ▼
              ┌──────────────────────┐
              │  data/  (JSONL/JSON) │
              │  Append-only logs    │
              └──────────────────────┘
```

**Karakteristik penting:**
- **Stateless scoring** + **append-only persistence** untuk audit trail.
- Setiap sumber data **optional** (Kronos / Whale / Social bisa offline; scanner tetap jalan).
- **Tidak ada DB**; semua state di file (JSONL append, JSON snapshot).

---

## 3. Struktur Workspace (Monorepo)

```
daily-trading-cockpit-v2/
├── apps/
│   ├── api/          # Fastify backend (TypeScript)
│   │   ├── src/
│   │   │   ├── app.ts            # composes Fastify instance
│   │   │   ├── index.ts          # server entry
│   │   │   ├── server.ts         # listen wrapper
│   │   │   ├── lib/              # ~60 analytics & service modules
│   │   │   └── routes/           # 4 route files
│   │   ├── test/                 # 62 vitest files
│   │   └── data/                 # local data (api-scoped)
│   └── web/          # Vite + React dashboard
├── packages/
│   └── shared/       # shared types, indicators, edge model
├── services/
│   └── kronos/       # FastAPI wrapper for Kronos model
├── data/             # repo-root data (shadow tape, scan history)
├── docs/             # design docs
└── scripts/          # PowerShell + mjs audit scripts
```

**npm workspaces** (`package.json`):
```json
"workspaces": ["apps/*", "packages/*"]
```

Build chain:
```
npm run build → @dtc/shared → @dtc/api → @dtc/web
npm run test  → @dtc/shared → @dtc/api
```

---

## 4. Konsep & Vokabulari Inti

### 4.1 Sinyal & Sumber

| Istilah | Arti |
|---|---|
| **Kronos** | ML model (NeoQuasar/Kronos-small) yang memprediksi return / volatility / bias arah berdasarkan OHLCV |
| **Whale** | Binance futures-flow data (long/short ratio, taker buy/sell volume) |
| **Social** | Reddit OAuth sentiment / Alternative.me Fear & Greed |
| **Source conflict** | Kronos LONG + Whale BEARISH, atau Kronos SHORT + Whale BULLISH |
| **Live source conflict** | Versi exact yang dipakai scanner (`scan.ts::hasSourceConflict`) |

### 4.2 Direction & Trading Plan

| Istilah | Arti |
|---|---|
| **Candidate** | Hasil scan untuk satu simbol+arah dengan score, indicators, executionPlan |
| **Execution Plan** | Variant entry (e.g. `fib_500_entry`) + variant exit (e.g. `fib_tp1_exit`) |
| **Variant** | Strategi entry/exit specific (fib retracement levels) |
| **Trade Plan** | Entry / stopLoss / TP1 / TP2 / TP3 yang sudah dihitung dari geometry |
| **stopDistanceBps** | `abs(entry - stop) / entry * 10000` (basis points) |
| **costR** | `(costPerSideBps × 2) / stopDistanceBps`; default cost = 14 bps/side = 28 bps round-trip |
| **grossR** | Return dalam unit R (`(TP1 - entry) / risk` untuk win; `-1.0` untuk loss) |
| **netR** | `grossR - costR` |

### 4.3 Regime Direction Controller

| Istilah | Arti |
|---|---|
| **Current Regime** | Label market saat ini: `Bullish expansion`, `Bearish expansion`, `Mixed rotation`, `Choppy / range-bound`, dll |
| **Controller Mode** | `LONG_ONLY` / `SHORT_ONLY` / `BOTH_ALLOWED` / `NO_TRADE_CHOP` / `WAIT_RETEST_AFTER_DUMP` / `WAIT_RETEST_AFTER_PUMP` / `VALIDATION_ONLY` / `UNKNOWN` |
| **Primary Validation Lane** | Lane internal yang sedang divalidasi (e.g. `bullish-fib-long-v1`) |
| **Alignment** | `MATCH` / `MISMATCH` / `UNAVAILABLE` antara primary lane vs controller mode |

### 4.4 Shadow Lanes

| Lane | Storage | Tujuan |
|---|---|---|
| **Normal Shadow** (base route) | `data/shadow-positions.json` | Live paper-trading tape; satu-satunya yang "real" |
| **Regime Controller Aligned Shadow V1** | `apps/api/data/regime-controller-aligned-shadow.json` | Bukti: apakah controller-aligned candidates profitable? |
| **Regime Controller Filtered Edge Shadow V1** | `apps/api/data/regime-controller-filtered-edge-shadow.json` | Sub-lane dengan filter (cost cap, exclude BTC/SEI) |
| **Kronos Counterfactual** | `data/kronos-counterfactual-observations.json` | Bukti: apa yang terjadi jika ikuti / abaikan Kronos |
| **External Rotation Overlay V2** | `apps/api/data/external-rotation-overlay-observations.json` | Symbol di luar universe utama |
| **Parallel Shadow Experiments** | `apps/api/data/parallel-shadow-experiments.json` | A/B test profile baru |

### 4.5 Geometry & Risk Hygiene

| Istilah | Arti |
|---|---|
| **MIN_ADMISSION_STOP_DISTANCE_BPS = 175** | Hard guard normal shadow; NEVER relaxed |
| **Variant-adjusted guard** | `max(80bps, 1.0×ATR bps)` — controller-aligned lane only |
| **MFE / MAE** | Maximum Favorable / Adverse Excursion in R units |
| **Path Metric** | Klasifikasi: `VALID` / `MISSING` / `INVALID_RISK` / `OUTLIER` |
| **Intrabar Resolution** | `VALID_5M_ORDERED` / `RESOLVED_BY_1M` / `AMBIGUOUS_SAME_CANDLE` / `INTRABAR_UNAVAILABLE` |

### 4.6 Validation Status

| Istilah | Arti |
|---|---|
| **Fresh-Valid** | Status canonical: resolved + chronology VALID + intrabar VALID + path metric VALID + version stamped |
| **Quarantined** | Legacy record yang excluded dari fresh-valid karena alasan spesifik |
| **VerdictBucket** | `TOO_EARLY` (n<20) / `POSITIVE_EDGE` / `NEGATIVE_EDGE` / `WATCHABLE` |

### 4.7 Version Markers

```
BASE_ROUTE_POLICY_VERSION_V2          = "base-route-anchor-consistent-v2"
RISK_HYGIENE_GUARD_V1                  = "base-route-risk-hygiene-stop175-v1"
FILTERED_EDGE_ANALYTICS_VERSION        = "filtered-edge-analytics-v1"
FILTERED_EDGE_CHRONOLOGY_VERSION       = "chronology-v1"
FILTERED_EDGE_PATH_METRIC_VERSION      = "path-metric-v1"
```

---

## 5. Data Flow End-to-End

### 5.1 Scan Cycle

```
1. Trigger: GET /api/scan (manual) OR auto-refresh interval
2. ScanService.runScan()
   a. Fetch OHLCV (5m, 15m, 1h) untuk universe ~28 symbols (Binance)
   b. Compute indicators (EMA, RSI, MACD, BB, ATR, VWAP, Fib levels)
   c. Parallel fetch: Kronos /predict, Whale (long/short ratio), Social
   d. buildCandidate() per symbol — score + executionPlan + tradePlan
   e. Build market regime label (deriveMarketRegime)
3. Direction-aware enrichment:
   - hasSourceConflict per direction
   - trendAligned per direction
   - whaleAgreement per direction
4. SignalTracker.persistScan() → data/scan-history.jsonl
5. ShadowExecutionEngine.processScan() → live admission to base route
6. Regime Direction Controller report
7. Controller-aligned shadow admission (report-only)
8. Filtered Edge shadow admission (report-only)
9. Candidate Funnel log per candidate → JSONL
10. Decision Ledger emits PLAN_SELECTED / ROUTE_ASSIGNED events
11. Response: { candidates, sourceStatus, ... }
```

### 5.2 Outcome Check Cycle

```
1. OutcomeChecker periodically reads SignalTracker raw history
2. For each open position: fetch latest candles
3. Detect TP1 / TP2 / TP3 / SL hit using candle walk
4. Write outcome → tracker
5. ShadowExecutionEngine resolves open shadow positions
6. Append to data/shadow-execution-log.json
7. Decision Ledger emits ENTRY_FILLED / EXIT_CLOSED events
```

### 5.3 Dashboard Audit Cycle

```
GET /api/shadow/dashboard
1. Load shadow positions, controller-aligned, filtered-edge stores
2. Trigger fire-and-forget resolvers (controller-aligned, filtered-edge)
3. Build per-section reports:
   - Section A: tracker performance
   - Section B: profit anatomy
   - Section W (existing): adaptive policy, route maturity, regime drift
   - Section W*: Regime Direction Controller report
   - Section W**: Controller-Aligned Shadow + exit counterfactuals + edge isolation
   - Section W***: Filtered Edge Shadow + intrabar audit
   - Section X..Z: various audits
4. Append RegimeDirectionControllerSnapshot (DASHBOARD_AUDIT source)
5. Return Markdown-rendered summary + JSON
```

---

## 6. Sub-sistem: Live Behavior

### 6.1 ScanService (`lib/scan-service.ts`)

Inti scanner. Tanggung jawab:
- Mengelola universe (currently ~28 symbols, hard-coded `UNIVERSE`)
- Pull OHLCV per simbol di 3 timeframe (5m, 15m, 1h)
- Memanggil Kronos / Whale / Social
- Memanggil `buildCandidate` dari shared package
- Membentuk `ScanResult` dengan source status

### 6.2 ShadowExecutionEngine (`lib/shadow-engine.ts`)

Live paper-trading engine. Menulis ke `data/shadow-positions.json`. Karakteristik:
- **Hard guard:** `stopDistanceBps >= 175` (MIN_ADMISSION_STOP_DISTANCE_BPS)
- Anchor-consistent geometry (Phase 2 base-route fix)
- `policyVersion: "base-route-anchor-consistent-v2"` stamped on new positions
- Per-symbol concurrency cap

### 6.3 SignalTracker (`lib/tracker.ts`)

Persistent log scan results. Menulis ke `data/scan-history.jsonl` (append-only). Provides:
- `persistScan(result)`: append entry
- `readAllRaw()`: read all entries
- `getLastOutcomeCheckerRunAt()`: cursor untuk OutcomeChecker

### 6.4 OutcomeChecker (`lib/outcome-checker.ts`)

Periodic resolver: untuk setiap entry open, fetch candles dan tentukan TP/SL hit.

### 6.5 DecisionLedger (`lib/decision-ledger.ts`)

Append-only event log untuk audit:
- `PLAN_SELECTED` / `ROUTE_ASSIGNED` / `ENTRY_PENDING` / `ENTRY_FILLED`
- `EXIT_CLOSED` / `ROUTE_DUPLICATE_SUPPRESSED` / `REFLECTION_ADDED`
- File: `data/decision-log.jsonl`
- Duplicate suppression window: 60 menit

### 6.6 Source Clients

| Client | File | Catatan |
|---|---|---|
| `BinanceClient` | `lib/binance.ts` | Wraps `fapi.binance.com` (futures) + `api.binance.com` (spot) |
| `HttpKronosClient` | `lib/kronos.ts` | POST `/predict` to FastAPI service; warm-up on boot |
| `BinanceWhaleClient` | `lib/whale.ts` | Top long/short account ratio + taker buy/sell |
| `HttpSocialClient` | `lib/social.ts` | Reddit OAuth / Fear&Greed / custom URL |

---

## 7. Sub-sistem: Shadow / Report-Only Lanes

**Prinsip emas:** Setiap shadow lane TIDAK BOLEH memengaruhi keputusan live. Mereka hanya mengumpulkan bukti.

### 7.1 Regime Controller Aligned Shadow V1 (`REGIME_CONTROLLER_ALIGNED_SHADOW_V1`)

**File:** `lib/regime-controller-aligned-shadow.ts`, `apps/api/data/regime-controller-aligned-shadow.json`

**Tujuan:** Mengukur apakah kandidat yang **searah dengan Regime Direction Controller** lebih profitable.

**Admission gate (9 langkah):**
1. Controller mode = `LONG_ONLY` atau `SHORT_ONLY`
2. Direction match controller
3. selectedExecutionPlan exists
4. **Variant-adjusted stop guard:** `max(80, atrPercent×100)` — bukan 175bps fixed
5. sourceConflict = false
6. Tidak duplicate
7. entryPrice > 0
8. stopLoss > 0
9. takeProfitLevels non-empty

**Resolver:**
- Candle walk 5m, conservative same-candle rule (SL wins if both TP&SL in same candle)
- Track maxMfeR, minMaeR
- Extended for TP2/TP3 tracking → exact exit counterfactuals
- Sets `exactExitCounterfactuals` per position

**Counterfactuals computed:**
- Statistical (assumes all TP1 wins reach TP2/TP3): `TP1_FULL_EXIT`, `TP2_FULL_EXIT`, `TP1_50_TP2_50`, `TP1_50_RUNNER_TP3`
- Exact path (from candle walk): same 4 variants, WR-different

**Latest state (per memory):**
- ~46 resolved
- netAvgR ≈ -0.11, PF ≈ 0.40, WR ≈ 45%
- All 4 exit counterfactuals NEGATIVE → `NO_POSITIVE_EXACT_EXIT`
- Best exit remains TP1_FULL_EXIT

### 7.2 Regime Controller Filtered Edge Shadow V1 (`REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1`)

**File:** `lib/regime-controller-filtered-edge-shadow.ts`, `apps/api/data/regime-controller-filtered-edge-shadow.json`

**Tujuan:** Lane prospektif dengan filter berbasis edge isolation: bisakah pruning toxic sub-cohorts menciptakan positive edge?

**Profiles:**
| Profile | costR | stopDistanceBps |
|---|---|---|
| `STRICT_COST10` | ≤ 0.10 | (variant-adjusted) |
| `BROAD_COST20_STOP150` | ≤ 0.20 | ≥ 150 |

**Hard exclusions (both profiles):**
- BTCUSDT (toxic: n=3, netAvgR=-1.20 dari edge isolation)
- SEIUSDT (toxic: n=4, netAvgR=-0.14)

**Base gates:** sama dengan controller-aligned, plus exclude symbol + cost cap + stop cap.

**Canonical contract** (single source of truth):
```typescript
status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "NO_FILL" | "EXPIRED" | "FAILED" | "AMBIGUOUS"
intrabarResolutionStatus: "VALID_5M_ORDERED" | "RESOLVED_BY_1M" | "AMBIGUOUS_SAME_CANDLE" | "INTRABAR_UNAVAILABLE" | "UNAVAILABLE"
chronologyStatus: "VALID" | "INVALID_NEGATIVE_DURATION" | "INVALID_OPENED_BEFORE_CREATED" | "UNAVAILABLE"
pathMetricStatus: "VALID" | "MISSING" | "INVALID_RISK" | "OUTLIER" | "STALE" | "UNAVAILABLE"
quarantineReason: "LEGACY_MISSING_PATH" | "LEGACY_OUTLIER_PATH" | "LEGACY_INVALID_CHRONOLOGY" | "LEGACY_AMBIGUOUS_INTRABAR" | "LEGACY_MISSING_VERSION"
```

**`deriveFreshValidStatus(obs)` = single source of truth:**
```
status ∈ {CLOSED_WIN, CLOSED_LOSS}
∧ quarantineReason === null
∧ chronologyStatus === "VALID"
∧ intrabarResolutionStatus ∈ {VALID_5M_ORDERED, RESOLVED_BY_1M}
∧ pathMetricStatus === "VALID"
∧ grossR, netR finite
∧ analyticsVersion stamped
```

**Integrity checks (di report builder):**
- `freshValidConsistencyCheck`: PASS jika top count = uniqueIds = intrabar count = recent rows
- `pathMetricConsistencyCheck`: PASS jika tidak ada fresh-valid dengan pathMetric != VALID
- `chronologyConsistencyCheck`: PASS jika tidak ada negative duration / dur=0 + VALID_5M_ORDERED

### 7.3 Controller-Aligned Edge Isolation (`lib/controller-aligned-edge-isolation.ts`)

Pure module yang menghasilkan analytics breakdown 10-dimensi:
- byControllerMode, bySymbol, byRoute, byStopBucket, byCostBucket
- bySourceConflict, byLiveSourceConflict, byKronosBias, byWhaleAgreement, byRegimeFamily

**Best sub-cohorts:** pool semua dimensi, filter n≥5, sort netAvgR desc → top 5 (WATCHABLE)
**Worst sub-cohorts:** pool, filter n≥3, sort netAvgR asc → top 5 (TOXIC)

**Prune suggestions:** EXCLUDE_SYMBOL / COST_R_CAP / STOP_BUCKET_FILTER / SIGNAL_FILTER

### 7.4 Kronos Counterfactual Lane (`lib/kronos-counterfactual-lane.ts`)

Bukti: kalau kita mengikuti / mengabaikan Kronos bias, apa hasilnya? Storage: `data/kronos-counterfactual-observations.json`.

### 7.5 External Rotation Overlay V2 (`lib/external-rotation-overlay.ts`)

Symbol di luar universe utama (~Binance spot top volume). Anchor-consistency fix (Phase 2E.3).

### 7.6 Parallel Shadow Experiments (`lib/parallel-shadow-experiments.ts`)

Framework A/B testing profile baru tanpa mengkontaminasi normal shadow.

---

## 8. Evidence Pipeline & Validation Layers

### 8.1 Accelerated Evidence Funnel (`lib/accelerated-evidence-funnel.ts`)

Diagnostik level cycle: berapa raw candidates, berapa lolos controller, berapa eligible per lane. Per-direction, per-controllerMode breakdown.

### 8.2 Candidate Funnel Log (`lib/accelerated-evidence-candidate-funnel-log.ts`)

Per-candidate JSONL: setiap candidate dicatat dengan exact rejection reasons. File: `apps/api/data/accelerated-evidence-candidate-funnel.jsonl`.

**Rejection reasons:**
```
REJECTION_DIRECTION_BLOCKED_BY_CONTROLLER
REJECTION_MISSING_EXECUTION_PLAN
REJECTION_STOP_DISTANCE_BELOW_175
REJECTION_SOURCE_CONFLICT_TRUE
REJECTION_LIVE_SOURCE_CONFLICT_TRUE
REJECTION_CONTROLLER_MODE_NOT_DIRECTIONAL
REJECTION_MISSING_REAL_ENTRY_GEOMETRY
REJECTION_MISSING_STOP_LOSS
REJECTION_MISSING_TAKE_PROFIT_LEVELS
```

### 8.3 Regime Direction Controller Retrospective Audit

`lib/regime-direction-controller-retrospective-audit.ts`. Untuk CLOSED positions, infer apakah controller pada saat itu MEMBLOKIR atau MENGIZINKAN arah tersebut. Labeled RETROSPECTIVE — not prospective.

### 8.4 Live Readiness (`lib/live-readiness.ts`)

Kompozit readiness gates. Semua flag saat ini `readyFor*Influence: false` karena masih dalam evidence-gathering phase.

### 8.5 Base-Route Risk Hygiene Monitor (`lib/base-route-risk-hygiene-monitor.ts`)

Mengukur: berapa banyak admission ke base route yang lolos stop175 guard? Adakah drift?

---

## 9. File-by-File Map (apps/api/src/lib)

Berikut peta singkat ~60 file analytics:

### 9.1 Scoring & Live Behavior
| File | Tujuan |
|---|---|
| `scan-service.ts` | Inti scan loop |
| `binance.ts` | Binance API client |
| `kronos.ts` | Kronos HTTP client |
| `whale.ts` | Whale flow client |
| `social.ts` | Reddit / Fear&Greed |
| `tracker.ts` | Scan history persistence |
| `outcome-checker.ts` | Resolve open positions |
| `shadow-engine.ts` | Live shadow tape |
| `decision-ledger.ts` | Append-only event log |

### 9.2 Regime & Controller
| File | Tujuan |
|---|---|
| `regime-direction-controller.ts` | Regime label → controller mode (pure) |
| `regime-direction-controller-snapshot.ts` | JSONL snapshot store |
| `regime-direction-controller-retrospective-audit.ts` | Retro audit dari closed positions |
| `regime-drift.ts` | Detect regime label drift |
| `regime-policy-counterfactual.ts` | What-if regime policy |

### 9.3 Shadow Lanes & Counterfactuals
| File | Tujuan |
|---|---|
| `regime-controller-aligned-shadow.ts` | Lane V1 admission + resolver + report |
| `regime-controller-filtered-edge-shadow.ts` | Lane V1 filtered profiles |
| `controller-aligned-edge-isolation.ts` | 10-dim cohort analysis |
| `controller-aligned-exit-counterfactuals.ts` | Statistical exit variants |
| `kronos-counterfactual-lane.ts` | Kronos follow/abandon lane |
| `parallel-shadow-experiments.ts` | A/B framework |

### 9.4 Adaptive Policy & Routing
| File | Tujuan |
|---|---|
| `adaptive-gate-intelligence.ts` | Adaptive regime gating |
| `adaptive-gate-overlay-performance.ts` | Performance audit |
| `adaptive-profit-policy.ts` | Synthesized exit policy |
| `refined-policy-promotion.ts` | Promotion gates |
| `route-maturity.ts` | Route lifecycle status |
| `routing-monitor.ts` | Live routing diagnostics |

### 9.5 Audit & Diagnostics
| File | Tujuan |
|---|---|
| `dashboard-audit-summary.ts` | THE big dashboard renderer (sections A..Z***) |
| `accelerated-evidence-funnel.ts` | Cycle-level funnel report |
| `accelerated-evidence-candidate-funnel-log.ts` | Per-candidate JSONL log |
| `live-readiness.ts` | Composite readiness gates |
| `cohort-performance.ts` | Performance cohort breakdown |
| `cost-attribution.ts` | Cost drag analysis |
| `expectation-calibration.ts` | Calibrate expected vs realized |
| `entry-precision-audit.ts` | Entry slippage / fill quality |
| `profit-anatomy.ts` | Win/loss anatomy |
| `winner-loser-audit.ts` | W vs L decomposition (1238 lines, biggest file) |
| `symbol-route-audit.ts` | Per-symbol routing audit |
| `symbol-route-suitability.ts` | Suitability scoring |
| `lane-toxic-symbol-evaluator.ts` | Toxic symbol identification |
| `signal-multiplicity-guardrail.ts` | Multi-signal sanity check |
| `stop-geometry-audit.ts` | Stop placement audit |
| `tp-sl-geometry-root-cause-audit.ts` | TP/SL anchor-consistency audit |
| `technical-stop-tp-credibility.ts` | MAE/MFE path engine (995 lines) |
| `conditional-alpha-stability.ts` | Conditional alpha analysis |
| `top-contributor-fingerprint-v0.ts` | Top contributor pattern |
| `evidence-consensus.ts` | Multi-source consensus |
| `expansion-report.ts` | Universe expansion proposal |

### 9.6 Universe Expansion
| File | Tujuan |
|---|---|
| `universe-rotation-intelligence.ts` | Rotation candidates (852 lines) |
| `external-candidate-discovery-intelligence.ts` | Discovery dari Binance spot |
| `external-candidate-metadata-fetcher.ts` | Metadata fetch |
| `external-rotation-overlay.ts` | V2 overlay shadow |
| `external-rotation-overlay-economics.ts` | Cost-geometry audit |
| `external-rotation-overlay-performance.ts` | Performance audit |
| `external-rotation-overlay-auto-refresh.ts` | Periodic refresh |
| `external-strategy-fit-enrichment.ts` | Strategy fit enrichment |

### 9.7 Misc
| File | Tujuan |
|---|---|
| `core-scan-auto-refresh.ts` | Auto-refresh controller |
| `base-route-risk-hygiene-monitor.ts` | 175bps guard monitor |
| `reflection-agent.ts` | Self-reflection on outcomes |

---

## 10. Routes API

### 10.1 `routes/scan.ts` (~801 lines)

**GET `/api/scan`** — primary scan endpoint.

Tanggung jawab:
1. Trigger `ScanService.runScan()`
2. Build `RegimeDirectionControllerReport`
3. Wire calibrated expectancy evidence
4. Admit ke base route (live)
5. Admit ke controller-aligned shadow (report-only)
6. Admit ke filtered-edge shadow (report-only)
7. Snapshot regime controller (SCAN_CYCLE source)
8. Emit candidate funnel log entries
9. Return ScanResult + diagnostics

### 10.2 `routes/shadow.ts` (~792 lines)

**GET `/api/shadow/dashboard`** — comprehensive audit dashboard.

Output: Markdown-rendered summary (sections A..Z***) plus structured JSON. Triggers fire-and-forget resolvers for shadow lanes.

**Sections:**
- A: tracker performance
- B: profit anatomy
- ... (banyak)
- W: adaptive gate / policy
- W*: Regime Direction Controller
- W**: Controller-Aligned Shadow (+ exit counterfactuals + edge isolation)
- W***: Filtered Edge Shadow (+ intrabar audit + fresh-valid integrity)
- Z*: candidate funnel
- Z**: retrospective controller audit

### 10.3 `routes/kronos.ts`

Proxy ke Kronos service untuk health & predict.

### 10.4 `routes/outcomes.ts`

Outcomes export untuk debugging.

---

## 11. Shared Package (`packages/shared`)

### 11.1 `types.ts` (1101 lines)

Inti tipe data sistem:
- `Candle`, `IndicatorSet`, `MacdSnapshot`, `BollingerBands`, `FibonacciLevels`, `AtrPlan`
- `Candidate`, `ScanResult`, `KronosPrediction`, `WhaleSignal`, `SentimentSignal`
- `ShadowPosition` (live + lane variants)
- `Direction`, `FinalStatus`, `TrendLabel`, `ExternalSignalLabel`

### 11.2 `indicators.ts` (320 lines)

Pure math: EMA, SMA, RSI, MACD, Bollinger Bands, ATR, VWAP, Fibonacci retracements/extensions, swing high/low, body/wick ratio.

### 11.3 `scan.ts` (579 lines)

`buildCandidate()` — gabung indicators + Kronos + whale + social → score + direction + executionPlan.

### 11.4 `execution-plan.ts` (670 lines)

Variant matrix:
- Entry: `fib_500_entry`, `fib_618_entry`, dst.
- Exit: `fib_tp1_exit`, `fib_tp2_exit`, dst.
- `buildVariantSelection()`: pilih variant terbaik berdasarkan score & geometry.

### 11.5 `profit-routing.ts` (374 lines)

`ProfitRouteMode`: `BASE_ROUTE` / `EXTERNAL_OVERLAY` / `KRONOS_COUNTERFACTUAL` etc.
`ProfitRouteReasonCode`: kenapa route ini dipilih.

### 11.6 `trade-plan.ts` (359 lines)

`TradePlan`: entry / stop / TP1/2/3, anchor-consistent.

### 11.7 `edge.ts`, `calibrated-expectancy.ts`, `strategy-intelligence.ts`, `evidence-era.ts`, `scanner-diagnostics.ts`

Modul pendukung untuk evidence flow, expectancy calibration, dan strategy fitness.

---

## 12. Data Storage Layer

Semua append-only / snapshot JSON. Tidak ada DB.

### 12.1 Repo-root `data/`

| File | Format | Owner |
|---|---|---|
| `shadow-positions.json` | JSON array | ShadowExecutionEngine (LIVE) |
| `shadow-execution-log.json` | JSON array | ShadowExecutionEngine (events) |
| `scan-history.jsonl` | JSONL | SignalTracker |
| `scan-history-raw.jsonl` | JSONL | Raw input archive |
| `scan-history-pre-dedupe-archive.jsonl` | JSONL | Pre-dedupe archive |
| `outcome-checker-audit.json` | JSON | OutcomeChecker |
| `external-candidate-metadata-snapshot.json` | JSON | Metadata cache |
| `kronos-counterfactual-observations.json` | JSON array | Kronos CF lane |
| `regime-direction-controller-snapshots.jsonl` | JSONL | Controller snapshot |
| `performance-migration-audit.json` | JSON | Migration audit |

### 12.2 `apps/api/data/`

| File | Format | Owner |
|---|---|---|
| `regime-controller-aligned-shadow.json` | JSON array | Lane V1 |
| `regime-controller-filtered-edge-shadow.json` | JSON array | Lane filtered V1 |
| `external-rotation-overlay-observations.json` | JSON array | Overlay V2 |
| `parallel-shadow-experiments.json` | JSON array | A/B framework |
| `accelerated-evidence-candidate-funnel.jsonl` | JSONL | Candidate funnel |
| `decision-log.jsonl` | JSONL | DecisionLedger |
| `kronos-counterfactual-observations.json` | JSON | Lane mirror |
| `regime-direction-controller-snapshots.jsonl` | JSONL | Snapshot mirror |

**Penting:** `apps/api/data/` di-resolve relatif terhadap CWD ketika api dijalankan. Pada test, di-redirect ke `os.tmpdir()` via constructor arg.

---

## 13. Service Kronos (Python)

**Path:** `services/kronos/app/main.py`

**Engine:** FastAPI di port 8001.

**Model:** vendored di `services/kronos/vendor/Kronos` (shiyu-coder/Kronos), default `NeoQuasar/Kronos-small` + `NeoQuasar/Kronos-Tokenizer-base`.

**Endpoints:**
- `GET /health`: `{ ok, modelConnected }`
- `POST /predict`: input `{ symbol, timeframe, candles[] }`, output `KronosPrediction`

**Output fields (forecast-derived):**
- `expectedReturn3`, `expectedReturn6`
- `expectedVolatility`
- `kronosLongProbability`, `kronosShortProbability`, `kronosConfidence`
- `kronosBias`, `kronosBias1h`, `kronosBias4h`
- `kronosRisk`

**Behavior:**
- Returns `available: false` jika model gagal load atau prediksi invalid (NEVER synthetic output)
- Loads model on startup in background thread
- Configurable via env: `KRONOS_MODEL_ID`, `KRONOS_TOKENIZER_ID`, `KRONOS_DEVICE`, `KRONOS_MAX_CONTEXT`, `KRONOS_PRED_LEN`, `KRONOS_SAMPLE_RUNS`

**Reasoncode `KronosAvailabilityReasonCode`:** TIMEOUT / UNSUPPORTED_SYMBOL / NOT_ENOUGH_CANDLES / INVALID_INPUT / PREDICTION_FAILED / MODEL_BUSY / UNAVAILABLE.

---

## 14. Test Suite

**Total:** 62 test files, ~1,162 tests passing, runtime ~10s.

**Framework:** Vitest.

**Coverage area:**
- Core scoring (`scan-route.test.ts`, `shadow-engine.test.ts`, `tracker.test.ts`)
- Regime controller (`regime-direction-controller.test.ts`, `regime-direction-controller-snapshot.test.ts`, `regime-direction-controller-retro-audit.test.ts`)
- Shadow lanes (`regime-controller-aligned-shadow*.test.ts`, `regime-controller-filtered-edge-shadow.test.ts`)
- Exit counterfactuals (`controller-aligned-exit-counterfactuals.test.ts`, `regime-controller-aligned-exact-exit.test.ts`)
- Edge isolation (`controller-aligned-edge-isolation.test.ts`)
- Funnel & evidence (`accelerated-evidence-funnel.test.ts`, `accelerated-evidence-candidate-funnel-log.test.ts`)
- Dashboard rendering (`dashboard-audit-summary.test.ts`, `dashboard-audit-summary-formatting.test.ts`)
- Geometry & risk (`stop-geometry-audit.test.ts`, `tp-sl-geometry-root-cause-audit.test.ts`, `base-route-risk-hygiene-monitor.test.ts`)
- External overlay (`external-rotation-overlay*.test.ts`)
- Adaptive & policy (`adaptive-*.test.ts`, `refined-policy-promotion.test.ts`)
- Kronos (`kronos-client.test.ts`, `kronos-routes.test.ts`, `kronos-counterfactual-lane.test.ts`)
- Universe (`universe-rotation-intelligence.test.ts`, `external-candidate-discovery-intelligence.test.ts`)
- Misc (`live-readiness.test.ts`, `winner-loser-audit.test.ts`, `signal-multiplicity-guardrail.test.ts`, ...)

**Konvensi test:**
- Setiap modul punya test file dengan suffix `.test.ts`
- Tests pakai temp directories untuk file I/O (via `os.tmpdir()`)
- `_resetXxxStoreForTests()` exported helpers untuk reset singleton state
- No network calls (binance/kronos di-mock)

---

## 15. Sejarah Fase Pengembangan

(Berdasarkan memory & dokumen `docs/PHASE_2_ADAPTIVE_STRATEGY_INTELLIGENCE_BLUEPRINT.md`)

### Phase 1 — Foundation
Scanner + basic shadow engine + Kronos integration.

### Phase 2 — Adaptive Strategy Intelligence
- **2D.1** Technical Stop/TP Credibility — advisory MAE/MFE engine; `readyForBehaviorInfluence: false`
- **2E.1** Adaptive Universe Rotation Intelligence — advisory symbol contribution; `readyForUniverseInfluence: false`
- **2E.2** External Candidate Discovery Intelligence — Binance spot metadata + fingerprint similarity
- **2E.3** External Rotation Overlay Economics Audit — cost-geometry vs directional failure separation
- **TP/SL Geometry Root-Cause Audit** — discovered anchor/fill-price unit mismatch bug
- **External Rotation Overlay V2** — anchor-consistency fix (`overlay-anchor-consistent-v2`)
- **Base-Route Anchor Fix** — `BASE_ROUTE_POLICY_VERSION_V2` ("base-route-anchor-consistent-v2") stamped on all new positions

### Phase 2Z — Regime Direction Controller Era
- **Persistence patch** — append-only JSONL snapshot store
- **Parts 1–4 Evidence Pipeline** — retrospective audit, admission funnel diagnostics, REGIME_CONTROLLER_ALIGNED_SHADOW_V1 lane, tests
- **Candidate-level funnel logger** — fix `controllerAlignedEligible=0` heuristic
- **Regime controller input consistency** — fix scan-cycle BOTH_ALLOWED vs dashboard LONG_ONLY mismatch
- **Stop geometry audit** — root cause: `stopDistanceBps = atrPercent × 115`
- **Phase 2Z.1 guard recalibration** — controller-aligned lane: `max(80, atrBps)` instead of 175bps fixed
- **Resolver implementation** — candle-walk TP1/SL
- **Admission geometry fix** — wire real `stopLoss`/`takeProfitLevels`; FAILED_INVALID_GEOMETRY
- **Dashboard consistency + payoff anatomy** — W*/Y alignment; by-mode Z* aggregation
- **Statistical exit counterfactuals** — TP1_FULL, TP2_FULL, TP1_50_TP2_50, TP1_50_RUNNER_TP3
- **Exact path exit counterfactuals** — extended candle walk; deferred best-exit lane until exactN ≥ 10
- **Backfill function** — recompute exact CF for existing resolved obs

### Phase 2Z.2 — Filtered Edge Era
- **Edge Isolation Report** — 10-dim cohort analysis
- **REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1** — STRICT_COST10 + BROAD_COST20_STOP150 profiles; exclude BTCUSDT/SEIUSDT
- **Loss forensics** — MFE/MAE tracking, immediateSl, noMfeBeforeSl
- **Intrabar Ambiguity Audit** — same-candle ambiguity detection, 1m refinement, fresh-valid concept
- **Fresh-Valid Consistency Fix** — single source of truth helper
- **Comprehensive End-to-End Integrity Audit** — canonical contract; deriveChronology / deriveIntrabarResolution / derivePathMetric / deriveFreshValidStatus; integrity checks (freshValid / pathMetric / chronology); quarantine concept

---

## 16. State Saat Ini & Open Issues

### 16.1 Live Behavior
- **Normal shadow** running dengan `MIN_ADMISSION_STOP_DISTANCE_BPS = 175`
- **`policyVersion: "base-route-anchor-consistent-v2"`** pada new positions
- **Kronos** active when `/health` reports `modelConnected: true`
- **Whale** active when Binance futures-flow reachable
- **Social** active per `SOCIAL_SENTIMENT_PROVIDER` env

### 16.2 Evidence State (per memory snapshot terakhir)

**Controller-Aligned Shadow V1 (W**)**
- ~46 resolved; netAvgR ≈ -0.11; PF ≈ 0.40; WR ≈ 45%
- All exit counterfactuals NEGATIVE
- Edge isolation: only watchable cohort = costR ≤ 0.10 (n=8, netAvgR=+0.024, PF=1.38)
- Toxic: BTCUSDT, SEIUSDT, costR>0.20, stop bucket 100-125, 125-150

**Filtered Edge Shadow V1 (W***)**
- Tape masih kecil (~22 STRICT, ~13 BROAD resolved)
- Fresh-valid sangat sedikit setelah quarantine legacy
- Integrity checks: PASS untuk fresh-valid & path metric; FAIL untuk chronology (5 negative duration + 13 dur=0 dengan VALID_5M_ORDERED dari legacy data)
- Verdict: TOO_EARLY untuk semua profile

### 16.3 Known Bottlenecks / Decisions Pending

1. **Exit extension not validated** — TP2/TP3 runner variants tidak lebih baik dari TP1_FULL_EXIT (exact path)
2. **Next bottleneck = entry quality / sub-cohort filtering**, bukan exit variant
3. **Legacy data quarantine** — 5 negative-duration + 13 dur=0 + 24 missing MFE/MAE records di filtered edge file
4. **Best-exit lane (`REGIME_CONTROLLER_ALIGNED_BEST_EXIT_SHADOW_V1`)** — DEFERRED; threshold `exactN ≥ 10 with positive netAvgR`; gate via `REGIME_CONTROLLER_BEST_EXIT_ENABLED=1`
5. **`readyFor*Influence` flags** — semua masih `false` (advisory-only mode)

### 16.4 Disiplin Arsitektur yang Dipegang Konsisten

- ✅ `data/shadow-positions.json` TIDAK PERNAH disentuh oleh shadow lanes
- ✅ Setiap shadow lane wrapped try/catch isolated
- ✅ Setiap new struct punya `reportOnly: true`
- ✅ `MIN_ADMISSION_STOP_DISTANCE_BPS = 175` tidak pernah relaxed di base route
- ✅ Kronos / Whale / Fingerprint / adaptive policy untouched dari shadow patches
- ✅ Version markers stamped pada setiap new position
- ✅ Single source of truth helpers untuk klasifikasi (fresh-valid, path metric, dst.)

---

## 17. Daftar Istilah / Glossary

| Singkatan | Kepanjangan |
|---|---|
| **ATR** | Average True Range |
| **bps** | Basis points (1bps = 0.01%) |
| **CWD** | Current Working Directory |
| **EMA** | Exponential Moving Average |
| **HF** | Hugging Face |
| **MAE** | Maximum Adverse Excursion |
| **MFE** | Maximum Favorable Excursion |
| **OHLCV** | Open / High / Low / Close / Volume |
| **PF** | Profit Factor (sumWinR / abs(sumLossR)) |
| **R** | Risk units (1R = stop distance) |
| **RSI** | Relative Strength Index |
| **SL** | Stop Loss |
| **TP** | Take Profit |
| **TTL** | Time To Live |
| **VWAP** | Volume Weighted Average Price |
| **WR** | Win Rate |

---

## APPENDIX A — Build / Run Commands

```bash
# Install
npm install

# Dev (API + Web, kill-port 3101/5173)
npm run dev

# Dev full (API + Web + Kronos)
npm run dev:full

# Per workspace
npm run dev -w @dtc/api
npm run dev -w @dtc/web

# Test
cd apps/api && npx vitest run

# Build
npm run build

# Kronos service
cd services/kronos
.\setup.ps1
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001
```

## APPENDIX B — Environment Variables

```bash
KRONOS_BASE_URL=http://localhost:8001
KRONOS_PREDICT_TIMEOUT_MS=45000
KRONOS_SAMPLE_RUNS=2
KRONOS_MODEL_ID=NeoQuasar/Kronos-small
KRONOS_TOKENIZER_ID=NeoQuasar/Kronos-Tokenizer-base
KRONOS_DEVICE=cpu                    # or cuda:0
KRONOS_MAX_CONTEXT=512
KRONOS_PRED_LEN=6

SOCIAL_SENTIMENT_PROVIDER=none       # custom | feargreed | reddit
SOCIAL_SENTIMENT_URL=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=daily-trading-cockpit-v2/0.1
REDDIT_SUBREDDITS=CryptoCurrency,Bitcoin,ethtrader,solana

DECISION_LEDGER_DISABLED=0           # 1 to disable
DECISION_LEDGER_FILE=data/decision-log.jsonl
CONTROLLER_ALIGNED_SHADOW_DISABLED=  # 1 to disable lane V1
CANDIDATE_FUNNEL_LOG_DISABLED=       # 1 to disable per-candidate log
FILTERED_EDGE_SHADOW_DISABLED=       # 1 to disable filtered lane
REGIME_CONTROLLER_BEST_EXIT_ENABLED= # 1 to create best-exit lane (currently OFF)
```

## APPENDIX C — Key Constants

```typescript
// Base route (live shadow) hard guard
MIN_ADMISSION_STOP_DISTANCE_BPS = 175

// Controller-aligned lane (report-only) variant-adjusted guard
computeControllerAlignedGuardThreshold(atrPercent) → max(80bps, 1.0×atrPercent×100)

// Cost defaults
costPerSideBps = 14         // 28bps round-trip
costR formula: (costPerSideBps × 2) / stopDistanceBps

// stopDistanceBps formula (fib_500_entry)
stopDistanceBps ≈ atrPercent × 115

// Path metric outlier cap
MFE_MAE_CAP = 20.0          // |MFE| > 20 or |MAE| > 20 → OUTLIER

// Filtered edge profile thresholds
STRICT_COST10:        costR ≤ 0.10
BROAD_COST20_STOP150: costR ≤ 0.20 AND stopDistanceBps ≥ 150

// Verdict thresholds
TOO_EARLY: resolved < 20
POSITIVE_EDGE: resolved ≥ 20 AND netAvgR > 0
NEGATIVE_EDGE: resolved ≥ 20 AND netAvgR ≤ 0

// Best-exit lane promotion gate (deferred)
exactN ≥ 10 AND any variant netAvgR > 0
```

## APPENDIX D — Dashboard Section Map

| Section | File / Builder | Topic |
|---|---|---|
| A | various | Tracker performance |
| B | `profit-anatomy.ts` | Profit anatomy |
| C..V | various | Per-system diagnostics |
| W | `adaptive-gate-intelligence.ts` | Adaptive gate / policy |
| **W*** | `regime-direction-controller.ts` | Regime Direction Controller |
| **W*** | `regime-controller-aligned-shadow.ts` | Controller-Aligned Shadow + exit CF + edge isolation |
| **W**** | `regime-controller-filtered-edge-shadow.ts` | Filtered Edge + intrabar + fresh-valid |
| **Y** | `dashboard-audit-summary.ts` | Primary lane alignment (uses W* directly now) |
| **Z*** | `accelerated-evidence-funnel.ts` | Funnel diagnostics |
| **Z**** | `regime-direction-controller-retrospective-audit.ts` | Retro audit |

---

**END OF DOCUMENT**

> Untuk update / koreksi: file ini bersifat referensi statis pada tanggal pembuatan. State aktual (test count, lane economics) dapat berubah seiring run scan baru. Selalu cross-check dengan `apps/api/data/*.json` dan `npx vitest run` untuk numerik terkini.
