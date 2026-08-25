/**
 * Runtime service around the 36H direction model.
 *
 * FAIL-OPEN, NEVER FAIL-CLOSED
 * ---------------------------
 * This lane traded profitably for months without a direction model. The model is an enhancement,
 * so every failure path — missing artifact, corrupt JSON, schema drift, short history, stale bars,
 * a non-finite head, an unexpected throw — resolves to the canonical 3L3S split and lets the basket
 * form exactly as it does today. Nothing here may ever return "do not trade": that would convert an
 * enhancement into a new silent admission blocker, which is the specific failure this codebase has
 * been bitten by repeatedly (see the timeline gate that vetoed every entry without logging).
 *
 * Admission is untouched. scoreGap, cluster caps, liquidity, cooldown and every risk control run
 * first and decide WHETHER a basket forms; this only influences the long/short split of one that
 * has already qualified.
 */

import type { Candle } from "@dtc/shared";
import {
  DIRECTION_MODEL_HORIZON_BARS,
  DIRECTION_MODEL_MIN_BARS,
  marketFeatures,
  type Bar,
  type FeatureVector,
  type MultiSourceInput,
} from "./direction-model-features.js";
import {
  DirectionEnsemble,
  DirectionModel,
  DirectionTrajectory,
  type DirectionPrediction,
  type EnsemblePrediction,
  type HorizonPrediction,
  type TrajectoryPrediction,
} from "./direction-model-runtime.js";
import {
  allocationFor,
  canonicalAllocation,
  isDirectionalAllocationActive,
  ladderInputFromEnsemble,
  ladderInputFromPrediction,
  ladderInputFromTrajectory,
  type AllocationDecision,
} from "./direction-model-allocation.js";

export type DirectionRegime = "TREND_UP" | "TREND_DOWN" | "CHOP" | "TRANSITION";

export interface DirectionModelSnapshot {
  /** When this reading was produced. */
  atMs: number;
  /** openTime of the last COMPLETED bar the features were built from. */
  featureAtMs: number | null;
  modelVersion: string | null;
  regime: DirectionRegime | null;
  prediction: DirectionPrediction | null;
  allocation: AllocationDecision;
  /** Null when the model drove the allocation; a short machine-readable code otherwise. */
  fallbackReason: string | null;
  universeSize: number;
  /** What the model WOULD have allocated, even when allocation is held at canonical. This is how
   *  a not-yet-promoted model accumulates a forward record without steering any money. */
  shadowAllocation: AllocationDecision | null;
  /** False while DIRECTION_MODEL_ALLOCATION_ACTIVE is unset: predictions are observed, not acted on. */
  allocationActive: boolean;
  schemaVersion: number | null;
  trainingPopulation: string | null;
  /** V3 only: per-horizon detail and the calibrated meta reading. */
  horizons: HorizonPrediction[] | null;
  confidence: number | null;
  horizonAgreement: number | null;
  /** Fraction of external venues agreeing with the leaned direction, when the features supply it. */
  sourceAgreement: number | null;
  /** V4 only: the predicted path distribution and its summary readings. */
  trajectory: TrajectoryPrediction | null;
}

export function isDirectionModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIRECTION_MODEL_ENABLED === "1";
}

/** Bars older than this are refused rather than served as a current reading. */
export function maxFeatureAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DIRECTION_MODEL_MAX_FEATURE_AGE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 3 * 3_600_000; // three 1h bars
  return raw;
}

/**
 * Deterministic regime label from features already computed for the model.
 *
 * This is a DESCRIPTOR of the current reading, not a new market classifier and not an admission
 * gate — it labels why the split came out where it did, for the operator panel. It deliberately
 * reuses the same breadth / BTC-trend / dispersion inputs the model consumes rather than
 * introducing an independent notion of regime that could disagree with the canonical one.
 */
export function regimeFrom(f: FeatureVector): DirectionRegime {
  const breadth = f.xs_breadth_mom36;
  const btcSlope = f.btc_slope4h;
  const dispersion = f.xs_disp_mom36;
  const medMom = f.xs_med_mom36;

  const bullish = (breadth ?? 0.5) > 0.60 && (medMom ?? 0) > 0;
  const bearish = (breadth ?? 0.5) < 0.40 && (medMom ?? 0) < 0;
  const trending = btcSlope !== null && Math.abs(btcSlope) > 0.0005;

  if (bullish && trending && (btcSlope ?? 0) > 0) return "TREND_UP";
  if (bearish && trending && (btcSlope ?? 0) < 0) return "TREND_DOWN";
  // High dispersion without agreement on direction is the classic turn: names are moving hard but
  // not together, which is neither a trend nor a quiet range.
  if (dispersion !== null && medMom !== null && dispersion > Math.abs(medMom) * 3) return "TRANSITION";
  return "CHOP";
}

/**
 * Candle plus the taker split.
 *
 * Declared locally rather than on the shared `Candle` interface on purpose: this repo's
 * `node_modules/@dtc/shared` symlinks to a DIFFERENT worktree's checkout, so a change to the shared
 * package here is not what the compiler (or another instance) actually reads. `getCandles` populates
 * the field at runtime; widening it structurally at the point of use keeps that fact local and
 * cannot desync another checkout.
 */
type CandleWithFlow = Candle & { takerBuyBase?: number };

function toBars(candles: readonly CandleWithFlow[]): Bar[] {
  return candles.map((c) => ({
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    // Production candles now carry the taker split (binance.ts getCandles maps klines field 9), and
    // V2 was fitted with it POPULATED — so it must be passed through here. Forwarding null would
    // serve the model constant-missing on features it never saw missing during training, which is
    // the exact train/serve break V1 avoided by nulling them on BOTH sides instead.
    takerBuyBase: c.takerBuyBase ?? null,
  }));
}

export class DirectionModelService {
  private model: DirectionModel | null = null;
  private ensemble: DirectionEnsemble | null = null;
  private trajectory: DirectionTrajectory | null = null;
  private loadError: string | null = null;
  private last: DirectionModelSnapshot | null = null;

  constructor(
    private readonly opts: {
      /** Returns the parsed artifact JSON, or null when none is installed. */
      loadArtifact: () => unknown | null;
      nowMs?: () => number;
      env?: NodeJS.ProcessEnv;
      /** Structured log sink; failures here must never propagate. */
      log?: (event: string, detail: Record<string, unknown>) => void;
      /**
       * Cross-venue bars and implied-volatility series, as-of now.
       *
       * REQUIRED FOR TRAIN/SERVE PARITY when the artifact was fitted with those families present:
       * the model saw them populated, so serving them null would exercise missing-value routing
       * learned from almost no missing examples. Returning null is still safe — the features become
       * null and their src_available_* flags 0, which is a state the model DID see — but it is a
       * degraded reading and is reported as such.
       */
      loadMultiSource?: () => Omit<MultiSourceInput, "eth"> | null;
    },
  ) {}

  private now(): number {
    return this.opts.nowMs?.() ?? Date.now();
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  /** Idempotent. A load failure is remembered so a corrupt artifact is not re-parsed every scan. */
  private ensureLoaded(): {
    model: DirectionModel | null;
    ensemble: DirectionEnsemble | null;
    trajectory: DirectionTrajectory | null;
  } {
    if (this.model || this.ensemble || this.trajectory || this.loadError) {
      return { model: this.model, ensemble: this.ensemble, trajectory: this.trajectory };
    }
    try {
      const raw = this.opts.loadArtifact();
      if (raw === null || raw === undefined) {
        this.loadError = "artifact_absent";
        return { model: null, ensemble: null, trajectory: null };
      }
      // Schema 3 is the multi-horizon ensemble; 1 and 2 are the single-model artifacts. Dispatching
      // on the declared version rather than on shape means a truncated or half-written artifact
      // fails validation loudly instead of being mistaken for an older schema.
      const declared = (raw as { schemaVersion?: number }).schemaVersion ?? 1;
      if (declared === 4) {
        this.trajectory = DirectionTrajectory.fromJson(raw);
      } else if (declared === 3) {
        this.ensemble = DirectionEnsemble.fromJson(raw);
      } else {
        this.model = DirectionModel.fromJson(raw);
      }
      return { model: this.model, ensemble: this.ensemble, trajectory: this.trajectory };
    } catch (error) {
      this.loadError = `artifact_invalid: ${(error as Error).message}`;
      return { model: null, ensemble: null, trajectory: null };
    }
  }

  private fallback(reason: string, universeSize: number, featureAtMs: number | null): DirectionModelSnapshot {
    const snap: DirectionModelSnapshot = {
      atMs: this.now(),
      featureAtMs,
      modelVersion: this.trajectory?.version ?? this.ensemble?.version ?? this.model?.version ?? null,
      regime: null,
      prediction: null,
      allocation: canonicalAllocation(),
      fallbackReason: reason,
      universeSize,
      shadowAllocation: null,
      allocationActive: isDirectionalAllocationActive(this.env()),
      schemaVersion: this.trajectory ? 4 : this.ensemble ? 3 : (this.model?.artifact.schemaVersion ?? null),
      trainingPopulation: this.trajectory?.artifact.trainingPopulation
        ?? this.ensemble?.artifact.trainingPopulation
        ?? this.model?.artifact.trainingPopulation ?? null,
      horizons: null,
      confidence: null,
      horizonAgreement: null,
      sourceAgreement: null,
      trajectory: null,
    };
    this.last = snap;
    try {
      this.opts.log?.("direction_model_fallback", { reason, universeSize, featureAtMs });
    } catch {
      // Logging must never affect basket formation.
    }
    return snap;
  }

  get status(): { loaded: boolean; version: string | null; loadError: string | null; last: DirectionModelSnapshot | null } {
    return {
      loaded: this.model !== null || this.ensemble !== null || this.trajectory !== null,
      version: this.trajectory?.version ?? this.ensemble?.version ?? this.model?.version ?? null,
      loadError: this.loadError,
      last: this.last,
    };
  }

  /**
   * Produce the allocation for this scan. NEVER throws: every path returns a usable decision, and
   * the caller can always act on `snapshot.allocation`.
   */
  evaluate(candlesBySymbol: Record<string, readonly Candle[]>, btcCandles: readonly Candle[] | null): DirectionModelSnapshot {
    const universeSize = Object.keys(candlesBySymbol).length;
    try {
      if (!isDirectionModelEnabled(this.env())) return this.fallback("disabled", universeSize, null);

      const loaded = this.ensureLoaded();
      if (!loaded.model && !loaded.ensemble && !loaded.trajectory) {
        return this.fallback(this.loadError ?? "artifact_absent", universeSize, null);
      }

      const bySymbol = new Map<string, Bar[]>();
      for (const [sym, candles] of Object.entries(candlesBySymbol)) {
        if (candles && candles.length >= DIRECTION_MODEL_MIN_BARS) bySymbol.set(sym, toBars(candles));
      }
      if (bySymbol.size < 8) return this.fallback("insufficient_universe_history", universeSize, null);

      /**
       * ALIGN ON TIMESTAMP, NOT ON ARRAY POSITION.
       *
       * `symbolFeatures` indexes positionally, so index `at` must mean the SAME INSTANT in every
       * series or the cross-sectional aggregate silently mixes timestamps — a bug that produces
       * confident numbers rather than an error. Symbols do not arrive on an identical grid in
       * practice: they are fetched concurrently, `completedCandles` drops each one's in-progress
       * bar against its own fetch time, and any symbol can have a gap. Requiring identical grids
       * therefore falls back on essentially every scan (observed on the first testnet cycle).
       *
       * Instead: take the newest bar present in EVERY series as the formation instant, drop
       * anything after it, then keep the same number of trailing bars everywhere. After this,
       * position `at` is the same timestamp in all series by construction.
       */
      // NOT the minimum last-bar time: a single stale or delisted symbol still being fetched drags
      // that back arbitrarily far (observed on testnet — one symbol pinned the whole universe to
      // July 2024, a year stale, and the reading was silently built from it). Instead, walk the
      // distinct recent bar times newest-first and take the first instant enough symbols actually
      // share. A stale symbol then simply fails to contain that bar and drops out, which is the
      // correct outcome for a series that has stopped updating.
      const candidateTimes = [...new Set(
        [...bySymbol.values()].flatMap((b) => b.slice(-4).map((x) => x.openTime)),
      )].sort((a, b) => b - a);

      let commonAtMs: number | null = null;
      let aligned = new Map<string, Bar[]>();
      for (const t of candidateTimes) {
        const candidate = new Map<string, Bar[]>();
        for (const [sym, all] of bySymbol) {
          const idx = all.findIndex((b) => b.openTime === t);
          // A symbol that lacks this exact bar has a hole (or has stopped updating); excluding it
          // is safer than substituting a neighbouring bar and calling it the same instant.
          if (idx < 0) continue;
          if (idx + 1 < DIRECTION_MODEL_MIN_BARS) continue;
          candidate.set(sym, all.slice(0, idx + 1));
        }
        if (candidate.size >= 8) {
          commonAtMs = t;
          aligned = candidate;
          break;
        }
      }
      if (commonAtMs === null) return this.fallback("unaligned_candle_grid", universeSize, null);

      const shortest = Math.min(...[...aligned.values()].map((b) => b.length));
      if (shortest < DIRECTION_MODEL_MIN_BARS) {
        return this.fallback("insufficient_aligned_history", universeSize, commonAtMs);
      }
      for (const [sym, b] of aligned) aligned.set(sym, b.slice(b.length - shortest));
      bySymbol.clear();
      for (const [sym, b] of aligned) bySymbol.set(sym, b);

      const at = shortest - 1;
      const featureAtMs = commonAtMs;

      const age = this.now() - featureAtMs;
      if (age > maxFeatureAgeMs(this.env())) {
        return this.fallback(`stale_features_${Math.round(age / 60_000)}m`, universeSize, featureAtMs);
      }

      // BTC is read at the same positional index, so it must be aligned to the same instant and
      // trimmed to the same length. If it cannot be, the BTC block reads null rather than reading
      // a different bar than the rest of the universe.
      let btcBars: Bar[] | null = null;
      if (btcCandles && btcCandles.length >= DIRECTION_MODEL_MIN_BARS) {
        const b = toBars(btcCandles);
        const idx = b.findIndex((x) => x.openTime === commonAtMs);
        if (idx + 1 >= shortest) btcBars = b.slice(idx + 1 - shortest, idx + 1);
      }
      // ETH is already in the fetched universe, so the second common factor costs nothing extra.
      // Aligning it the same way as BTC keeps index `at` the same instant for every series.
      let ethBars: Bar[] | null = null;
      const ethRaw = candlesBySymbol.ETHUSDT;
      if (ethRaw && ethRaw.length >= DIRECTION_MODEL_MIN_BARS) {
        const b = toBars(ethRaw);
        const idx = b.findIndex((x) => x.openTime === commonAtMs);
        if (idx + 1 >= shortest) ethBars = b.slice(idx + 1 - shortest, idx + 1);
      }
      let external: Omit<MultiSourceInput, "eth"> | null = null;
      try {
        external = this.opts.loadMultiSource?.() ?? null;
      } catch {
        // An unreadable raw store degrades the reading; it must never fail the scan.
        external = null;
      }
      const features = marketFeatures({
        bySymbol, btc: btcBars, at,
        multiSource: { ...(external ?? { venueBars: null, ivSeries: null }), eth: ethBars },
      });
      if (!features) return this.fallback("features_unavailable", universeSize, featureAtMs);

      // Venue agreement is already in the feature vector; surface it so the ladder and the operator
      // panel can both see how much of the market actually corroborated the reading.
      const agreementRatio = features.xv_agreement_ratio;
      const sourceAgreement = agreementRatio === null || !Number.isFinite(agreementRatio)
        ? null : agreementRatio;

      let prediction: DirectionPrediction | null = null;
      let ensemblePred: EnsemblePrediction | null = null;
      let trajectoryPred: TrajectoryPrediction | null = null;
      let shadowAllocation: AllocationDecision;
      if (loaded.trajectory) {
        trajectoryPred = loaded.trajectory.predict(features);
        shadowAllocation = allocationFor(ladderInputFromTrajectory(trajectoryPred, sourceAgreement), this.env());
        // Present the trajectory reading under the same prediction shape older consumers read. The
        // headline probabilities are the PERSISTENT path classes, not an endpoint distribution:
        // that is the substantive change in V4 and the panels should show it directly.
        prediction = {
          pUp: trajectoryPred.pathProbabilities.PERSISTENT_UP ?? 0,
          pStrongUp: trajectoryPred.pathProbabilities.PERSISTENT_UP ?? 0,
          pNeutral: (trajectoryPred.pathProbabilities.CHOP ?? 0)
            + (trajectoryPred.pathProbabilities.TRANSITION ?? 0),
          pStrongDown: trajectoryPred.pathProbabilities.PERSISTENT_DOWN ?? 0,
          directionScore: trajectoryPred.persistenceScore,
          expectedReturn: trajectoryPred.expectedReturn,
          q10: trajectoryPred.q10,
          q50: trajectoryPred.q50,
          q90: trajectoryPred.q90,
          expectedVol: trajectoryPred.expectedVol,
          modelVersion: trajectoryPred.modelVersion,
          schemaVersion: 4,
        };
      } else if (loaded.ensemble) {
        ensemblePred = loaded.ensemble.predict(features);
        shadowAllocation = allocationFor(ladderInputFromEnsemble(ensemblePred, sourceAgreement), this.env());
        // Present the ensemble under the same prediction shape older consumers read, so the route
        // and the ladder need no version branch.
        prediction = {
          pUp: ensemblePred.pStrongUp,
          pStrongUp: ensemblePred.pStrongUp,
          pNeutral: ensemblePred.pNeutral,
          pStrongDown: ensemblePred.pStrongDown,
          directionScore: ensemblePred.directionScore,
          expectedReturn: ensemblePred.expectedReturn,
          q10: ensemblePred.q10,
          q50: ensemblePred.q50,
          q90: ensemblePred.q90,
          expectedVol: ensemblePred.expectedVol,
          modelVersion: ensemblePred.modelVersion,
          schemaVersion: 3,
        };
      } else {
        prediction = loaded.model!.predict(features);
        shadowAllocation = allocationFor(ladderInputFromPrediction(prediction), this.env());
      }
      // A model that has not passed acceptance still runs, still predicts, and still records what
      // it WOULD have done — but the split it hands back stays canonical until it is promoted.
      // This is the operator's own instruction for a model that fails its holdout: deploy the
      // infrastructure, keep allocation canonical, keep collecting forward observations.
      const active = isDirectionalAllocationActive(this.env());
      const snap: DirectionModelSnapshot = {
        atMs: this.now(),
        featureAtMs,
        modelVersion: loaded.trajectory?.version ?? loaded.ensemble?.version ?? loaded.model!.version,
        regime: regimeFrom(features),
        prediction,
        allocation: active ? shadowAllocation : canonicalAllocation(),
        fallbackReason: active ? null : "allocation_inactive_shadow_only",
        universeSize,
        shadowAllocation,
        allocationActive: active,
        schemaVersion: loaded.trajectory ? 4 : loaded.ensemble ? 3 : (loaded.model!.artifact.schemaVersion ?? 1),
        trainingPopulation: loaded.trajectory?.artifact.trainingPopulation
          ?? loaded.ensemble?.artifact.trainingPopulation
          ?? loaded.model?.artifact.trainingPopulation ?? null,
        horizons: trajectoryPred?.horizons ?? ensemblePred?.horizons ?? null,
        confidence: trajectoryPred?.confidence ?? ensemblePred?.confidence ?? null,
        horizonAgreement: trajectoryPred?.horizonAgreement ?? ensemblePred?.horizonAgreement ?? null,
        sourceAgreement,
        trajectory: trajectoryPred,
      };
      this.last = snap;
      return snap;
    } catch (error) {
      return this.fallback(`exception: ${(error as Error).message}`, universeSize, null);
    }
  }
}

export const DIRECTION_MODEL_HORIZON = DIRECTION_MODEL_HORIZON_BARS;
