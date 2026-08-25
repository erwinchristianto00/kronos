/**
 * Runtime inference for the 36H market-direction model.
 *
 * The trading path must never train, never call out over the network, and never depend on a Python
 * sidecar being alive: training produces a versioned JSON artifact of the fitted trees, and this
 * module walks them. Inference is pure arithmetic over a frozen structure — deterministic, allocation
 * -free per node, and impossible to make slow. There is no timeout path because there is no I/O.
 *
 * ARTIFACT CONTRACT
 * -----------------
 * Produced by scripts/train-direction-model.py from sklearn's HistGradientBoosting predictors.
 * `featureNames` is the exact, ordered schema the model was fitted on; `predict` refuses a vector
 * that does not match it rather than silently reading a shifted feature (a reordered vector still
 * produces confident numbers, which is the worst possible failure mode here).
 *
 * MISSING VALUES
 * --------------
 * HistGradientBoosting learns a per-node missing-direction, so a null feature is a first-class
 * input rather than an imputed zero. Nulls are passed through as NaN and routed by
 * `missingGoToLeft`. This is why the trainer uses the Hist variant: zero-imputation would teach the
 * model that "no funding history" and "funding exactly zero" are the same state.
 */

export interface TreeNodes {
  /** Feature index per node; ignored on leaves. */
  featureIdx: number[];
  /** Split threshold per node; ignored on leaves. */
  threshold: number[];
  /** 1 when a NaN at this node routes left, else 0. */
  missingGoToLeft: number[];
  left: number[];
  right: number[];
  /** 1 for leaf nodes. */
  isLeaf: number[];
  /** Leaf output (raw score contribution). */
  value: number[];
}

export type HeadKind = "logistic" | "identity";

export interface ModelHead {
  kind: HeadKind;
  /** Baseline raw prediction the trees add onto. */
  baseline: number;
  trees: TreeNodes[];
}

/** Multiclass head: one independent tree ensemble per class, combined by softmax. */
export interface SoftmaxHead {
  kind: "softmax";
  classes: string[];
  perClass: Array<{ baseline: number; trees: TreeNodes[] }>;
}

export interface DirectionModelArtifact {
  version: string;
  /** 1 = V1 binary pUp. 2 = V2 admission-conditioned multiclass. Absent means 1. */
  schemaVersion?: number;
  trainedAt: string;
  horizonBars: number;
  featureNames: string[];
  /** Which population the model was fitted on. V2 is ADMISSION_CONDITIONED. */
  trainingPopulation?: string;
  classes?: string[];
  classCounts?: Record<string, number>;
  /** Rows used for fitting — recorded so the runtime can report what it is trusting. */
  trainRows: number;
  trainSpan: { fromMs: number; toMs: number };
  heads: {
    /** V1 only. */
    pUp?: ModelHead;
    /** V2 only. */
    cls?: SoftmaxHead;
    mean: ModelHead;
    q10: ModelHead;
    q50: ModelHead;
    q90: ModelHead;
    /** V2 only: expected forward volatility of the common factor. */
    vol?: ModelHead;
  };
}

export interface DirectionPrediction {
  /** V2: P(STRONG_UP). V1: P(up). Kept under one name so consumers need no schema branch. */
  pUp: number;
  /** V2 only; null on a V1 artifact. */
  pStrongUp: number | null;
  pNeutral: number | null;
  pStrongDown: number | null;
  /** P_STRONG_UP - P_STRONG_DOWN. Null on V1. */
  directionScore: number | null;
  expectedReturn: number;
  q10: number;
  q50: number;
  q90: number;
  /** V2 only; null on V1. */
  expectedVol: number | null;
  modelVersion: string;
  schemaVersion: number;
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

function walk(tree: TreeNodes, x: Float64Array): number {
  let node = 0;
  // Depth is bounded by the trained max_depth, but guard anyway: a corrupt artifact with a cyclic
  // child pointer would otherwise hang the scan loop rather than fail a validation check.
  for (let steps = 0; steps < 256; steps += 1) {
    if (tree.isLeaf[node] === 1) return tree.value[node];
    const v = x[tree.featureIdx[node]];
    if (Number.isNaN(v)) {
      node = tree.missingGoToLeft[node] === 1 ? tree.left[node] : tree.right[node];
    } else {
      node = v <= tree.threshold[node] ? tree.left[node] : tree.right[node];
    }
  }
  throw new Error("direction-model: tree traversal exceeded depth bound (corrupt artifact)");
}

function rawScore(head: ModelHead, x: Float64Array): number {
  let acc = head.baseline;
  for (const tree of head.trees) acc += walk(tree, x);
  return acc;
}

/** Structural validation. Runs once at load, not per prediction. */
export function validateArtifact(a: unknown): asserts a is DirectionModelArtifact {
  const art = a as DirectionModelArtifact;
  if (!art || typeof art !== "object") throw new Error("direction-model: artifact is not an object");
  if (typeof art.version !== "string" || !art.version) throw new Error("direction-model: missing version");
  if (!Array.isArray(art.featureNames) || art.featureNames.length === 0) {
    throw new Error("direction-model: missing featureNames");
  }
  if (new Set(art.featureNames).size !== art.featureNames.length) {
    throw new Error("direction-model: duplicate feature names");
  }
  if (!Number.isFinite(art.horizonBars) || art.horizonBars <= 0) {
    throw new Error("direction-model: invalid horizonBars");
  }
  const heads = art.heads;
  if (!heads) throw new Error("direction-model: missing heads");
  const schema = art.schemaVersion ?? 1;
  if (schema !== 1 && schema !== 2) {
    throw new Error(`direction-model: unsupported schemaVersion ${String(schema)}`);
  }
  const checkTrees = (label: string, trees: TreeNodes[]): void => {
    if (!Array.isArray(trees) || trees.length === 0) {
      throw new Error(`direction-model: head ${label} has no trees`);
    }
    for (const t of trees) {
      const n = t.value?.length ?? 0;
      if (!n) throw new Error(`direction-model: head ${label} has an empty tree`);
      for (const arr of [t.featureIdx, t.threshold, t.missingGoToLeft, t.left, t.right, t.isLeaf]) {
        if (!Array.isArray(arr) || arr.length !== n) {
          throw new Error(`direction-model: head ${label} tree arrays are ragged`);
        }
      }
      for (let i = 0; i < n; i += 1) {
        if (t.isLeaf[i] === 1) continue;
        const fi = t.featureIdx[i];
        if (!Number.isInteger(fi) || fi < 0 || fi >= art.featureNames.length) {
          throw new Error(`direction-model: head ${label} references feature index ${String(fi)} out of range`);
        }
      }
    }
  };
  if (schema === 2) {
    const cls = heads.cls;
    if (!cls) throw new Error("direction-model: schemaVersion 2 requires a cls head");
    if (cls.kind !== "softmax") throw new Error("direction-model: cls head must be softmax");
    if (!Array.isArray(cls.classes) || cls.classes.length !== 3) {
      throw new Error("direction-model: cls head must declare exactly 3 classes");
    }
    if (!Array.isArray(cls.perClass) || cls.perClass.length !== cls.classes.length) {
      throw new Error("direction-model: cls head perClass does not match classes");
    }
    cls.perClass.forEach((pc, i) => {
      if (!Number.isFinite(pc.baseline)) throw new Error(`direction-model: cls class ${i} baseline not finite`);
      checkTrees(`cls[${i}]`, pc.trees);
    });
  } else if (!heads.pUp) {
    throw new Error("direction-model: schemaVersion 1 requires a pUp head");
  }
  const scalarHeads: Array<"pUp" | "mean" | "q10" | "q50" | "q90" | "vol"> =
    schema === 2 ? ["mean", "q10", "q50", "q90", "vol"] : ["pUp", "mean", "q10", "q50", "q90"];
  for (const name of scalarHeads) {
    const h = heads[name];
    if (!h) throw new Error(`direction-model: missing head ${name}`);
    if (h.kind !== "logistic" && h.kind !== "identity") {
      throw new Error(`direction-model: head ${name} has unknown kind ${String(h.kind)}`);
    }
    if (!Number.isFinite(h.baseline)) throw new Error(`direction-model: head ${name} baseline not finite`);
    checkTrees(name, h.trees);
  }
}

export class DirectionModel {
  private readonly index: Map<string, number>;

  private constructor(readonly artifact: DirectionModelArtifact) {
    this.index = new Map(artifact.featureNames.map((n, i) => [n, i]));
  }

  static fromJson(raw: unknown): DirectionModel {
    validateArtifact(raw);
    return new DirectionModel(raw);
  }

  get version(): string {
    return this.artifact.version;
  }

  /**
   * Build the dense input vector. Throws when the supplied features do not cover the trained
   * schema — a missing NAME is a schema mismatch (deploying a model against older feature code)
   * and must fail loudly, whereas a present-but-null VALUE is a legitimate missing reading and
   * becomes NaN for the model's own missing-value routing.
   */
  private vectorise(features: Record<string, number | null>): Float64Array {
    const x = new Float64Array(this.artifact.featureNames.length);
    for (let i = 0; i < this.artifact.featureNames.length; i += 1) {
      const name = this.artifact.featureNames[i];
      if (!(name in features)) {
        throw new Error(`direction-model: feature "${name}" absent from input (schema mismatch)`);
      }
      const v = features[name];
      x[i] = v === null || !Number.isFinite(v) ? Number.NaN : v;
    }
    return x;
  }

  predict(features: Record<string, number | null>): DirectionPrediction {
    const x = this.vectorise(features);
    const h = this.artifact.heads;
    const schemaVersion = this.artifact.schemaVersion ?? 1;

    let pUp: number;
    let pStrongUp: number | null = null;
    let pNeutral: number | null = null;
    let pStrongDown: number | null = null;
    let directionScore: number | null = null;

    if (schemaVersion === 2) {
      const cls = h.cls!;
      // Softmax over the per-class raw scores, shifted by the max first: LightGBM raw scores can
      // reach magnitudes where a bare exp() overflows to Infinity and every probability becomes NaN.
      const raws = cls.perClass.map((pc) => {
        let acc = pc.baseline;
        for (const t of pc.trees) acc += walk(t, x);
        return acc;
      });
      const mx = Math.max(...raws);
      const exps = raws.map((r) => Math.exp(r - mx));
      const sum = exps.reduce((a, b) => a + b, 0);
      if (!(sum > 0) || !Number.isFinite(sum)) {
        throw new Error("direction-model: softmax produced a degenerate denominator");
      }
      const probs = exps.map((e) => e / sum);
      const idxOf = (name: string): number => cls.classes.indexOf(name);
      const iUp = idxOf("STRONG_UP");
      const iNeutral = idxOf("NEUTRAL");
      const iDown = idxOf("STRONG_DOWN");
      if (iUp < 0 || iNeutral < 0 || iDown < 0) {
        throw new Error(`direction-model: cls head classes ${cls.classes.join(",")} are not the expected three`);
      }
      pStrongUp = probs[iUp];
      pNeutral = probs[iNeutral];
      pStrongDown = probs[iDown];
      directionScore = pStrongUp - pStrongDown;
      pUp = pStrongUp;
    } else {
      const pUpRaw = rawScore(h.pUp!, x);
      pUp = h.pUp!.kind === "logistic" ? sigmoid(pUpRaw) : pUpRaw;
    }

    const expectedVol = h.vol ? rawScore(h.vol, x) : null;
    const expectedReturn = rawScore(h.mean, x);
    const q10 = rawScore(h.q10, x);
    const q50 = rawScore(h.q50, x);
    const q90 = rawScore(h.q90, x);

    for (const [k, v] of Object.entries({ pUp, expectedReturn, q10, q50, q90 })) {
      if (!Number.isFinite(v)) throw new Error(`direction-model: head ${k} produced a non-finite value`);
    }
    if (pUp < 0 || pUp > 1) throw new Error(`direction-model: pUp out of range (${pUp})`);
    if (expectedVol !== null && (!Number.isFinite(expectedVol) || expectedVol < 0)) {
      throw new Error(`direction-model: expectedVol out of range (${String(expectedVol)})`);
    }

    return {
      pUp,
      pStrongUp,
      pNeutral,
      pStrongDown,
      directionScore,
      expectedVol,
      schemaVersion,
      expectedReturn,
      // Quantile heads are fitted independently, so nothing forces q10 <= q50 <= q90. Crossed
      // quantiles are a real and well-known artefact of independent pinball fits; sorting is the
      // standard non-parametric repair and keeps the downside reading interpretable rather than
      // letting a crossed pair drive allocation.
      ...(() => {
        const [a, b, c] = [q10, q50, q90].sort((p, q) => p - q);
        return { q10: a, q50: b, q90: c };
      })(),
      modelVersion: this.artifact.version,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// V3 — MULTI-HORIZON SPECIALISTS + META ENSEMBLE
// ---------------------------------------------------------------------------------------------

/** Horizons, in the ONLY order the meta feature vector may be built in. */
export const V3_HORIZONS = [6, 12, 24, 36] as const;
export type V3Horizon = (typeof V3_HORIZONS)[number];

/** Per-horizon head set. Same shapes as V2, one bundle per horizon. */
export interface SpecialistHeads {
  cls: SoftmaxHead;
  mean: ModelHead;
  q10: ModelHead;
  q50: ModelHead;
  q90: ModelHead;
  vol: ModelHead;
}

export interface HorizonPrediction {
  horizon: number;
  pStrongDown: number;
  pNeutral: number;
  pStrongUp: number;
  expectedReturn: number;
  q10: number;
  q50: number;
  q90: number;
  expectedVol: number;
}

export interface EnsemblePrediction {
  /** Final calibrated 36h distribution from the meta model. */
  pStrongUp: number;
  pNeutral: number;
  pStrongDown: number;
  directionScore: number;
  /** Taken from the 36h specialist — the meta head models the distribution, not the magnitude. */
  expectedReturn: number;
  q10: number;
  q50: number;
  q90: number;
  expectedVol: number;
  /** Per-horizon detail, in V3_HORIZONS order. */
  horizons: HorizonPrediction[];
  /** 0..1. Blends probability margin, cross-horizon agreement and quantile asymmetry. */
  confidence: number;
  /** |sum(sign(p_up - p_down))| / 4 — 1 when every horizon leans the same way. */
  horizonAgreement: number;
  modelVersion: string;
  schemaVersion: number;
}

export interface DirectionEnsembleArtifact {
  version: string;
  schemaVersion: 3;
  trainedAt: string;
  horizonBars: number;
  horizons: number[];
  trainingPopulation?: string;
  featureNames: string[];
  metaFeatureNames: string[];
  classes: string[];
  calibrationTemperature: number;
  configsEvaluated?: number;
  trainRows: number;
  classCounts?: Record<string, number>;
  trainSpan: { fromMs: number; toMs: number };
  specialists: Record<string, SpecialistHeads>;
  meta: { cls: SoftmaxHead };
}

function softmaxOf(raws: number[]): number[] {
  const mx = Math.max(...raws);
  const exps = raws.map((r) => Math.exp(r - mx));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) {
    throw new Error("direction-model: softmax produced a degenerate denominator");
  }
  return exps.map((e) => e / sum);
}

function headRaw(head: ModelHead, x: Float64Array): number {
  let acc = head.baseline;
  for (const t of head.trees) acc += walk(t, x);
  return acc;
}

function classRaws(head: SoftmaxHead, x: Float64Array): number[] {
  return head.perClass.map((pc) => {
    let acc = pc.baseline;
    for (const t of pc.trees) acc += walk(t, x);
    return acc;
  });
}

export function validateEnsembleArtifact(a: unknown): asserts a is DirectionEnsembleArtifact {
  const art = a as DirectionEnsembleArtifact;
  if (!art || typeof art !== "object") throw new Error("direction-ensemble: not an object");
  if (art.schemaVersion !== 3) throw new Error(`direction-ensemble: expected schemaVersion 3, got ${String(art.schemaVersion)}`);
  if (!Array.isArray(art.featureNames) || !art.featureNames.length) throw new Error("direction-ensemble: missing featureNames");
  if (new Set(art.featureNames).size !== art.featureNames.length) throw new Error("direction-ensemble: duplicate feature names");
  if (!Array.isArray(art.metaFeatureNames) || !art.metaFeatureNames.length) throw new Error("direction-ensemble: missing metaFeatureNames");
  if (!Number.isFinite(art.calibrationTemperature) || art.calibrationTemperature <= 0) {
    throw new Error("direction-ensemble: invalid calibrationTemperature");
  }
  if (!art.specialists) throw new Error("direction-ensemble: missing specialists");
  for (const h of V3_HORIZONS) {
    const sp = art.specialists[String(h)];
    if (!sp) throw new Error(`direction-ensemble: missing specialist for horizon ${h}`);
    if (sp.cls?.kind !== "softmax" || sp.cls.perClass?.length !== 3) {
      throw new Error(`direction-ensemble: specialist ${h} cls head malformed`);
    }
    for (const name of ["mean", "q10", "q50", "q90", "vol"] as const) {
      const head = sp[name];
      if (!head || !Array.isArray(head.trees) || !head.trees.length) {
        throw new Error(`direction-ensemble: specialist ${h} missing head ${name}`);
      }
    }
  }
  if (art.meta?.cls?.kind !== "softmax" || art.meta.cls.perClass?.length !== 3) {
    throw new Error("direction-ensemble: meta cls head malformed");
  }
  // The meta vector is 8 columns per horizon plus 4 aggregate columns; a mismatch here means the
  // trainer and the runtime disagree about the vector's shape, which would silently shift columns.
  const expected = 8 * V3_HORIZONS.length + 4;
  if (art.metaFeatureNames.length !== expected) {
    throw new Error(`direction-ensemble: metaFeatureNames has ${art.metaFeatureNames.length}, expected ${expected}`);
  }
}

export class DirectionEnsemble {
  private constructor(readonly artifact: DirectionEnsembleArtifact) {}

  static fromJson(raw: unknown): DirectionEnsemble {
    validateEnsembleArtifact(raw);
    return new DirectionEnsemble(raw);
  }

  get version(): string {
    return this.artifact.version;
  }

  private vectorise(features: Record<string, number | null>): Float64Array {
    const names = this.artifact.featureNames;
    const x = new Float64Array(names.length);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (!(name in features)) {
        throw new Error(`direction-ensemble: feature "${name}" absent from input (schema mismatch)`);
      }
      const v = features[name];
      x[i] = v === null || !Number.isFinite(v) ? Number.NaN : v;
    }
    return x;
  }

  /**
   * Specialist block for one horizon, in the EXACT column order the trainer used:
   * [p_down, p_neutral, p_up, mean, q10, q50, q90, vol].
   * Any reordering here silently feeds the meta model shifted columns.
   */
  private block(h: V3Horizon, x: Float64Array): number[] {
    const sp = this.artifact.specialists[String(h)]!;
    const p = softmaxOf(classRaws(sp.cls, x));
    return [p[0], p[1], p[2], headRaw(sp.mean, x), headRaw(sp.q10, x), headRaw(sp.q50, x),
      headRaw(sp.q90, x), headRaw(sp.vol, x)];
  }

  predict(features: Record<string, number | null>): EnsemblePrediction {
    const x = this.vectorise(features);
    const blocks = V3_HORIZONS.map((h) => this.block(h, x));

    // Aggregates, matching build_meta_features in the trainer exactly.
    const ups = blocks.map((b) => b[2]);
    const downs = blocks.map((b) => b[0]);
    const means = blocks.map((b) => b[3]);
    const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
    const leanSum = blocks.reduce((acc, b) => acc + sgn(b[2] - b[0]), 0);
    const agreeDirection = Math.abs(leanSum) / V3_HORIZONS.length;
    const agreeMeanSign = Math.abs(means.reduce((a, m) => a + sgn(m), 0)) / V3_HORIZONS.length;
    const upSpread = Math.max(...ups) - Math.min(...ups);
    const meanOfMeans = means.reduce((a, b) => a + b, 0) / means.length;

    const metaVec = Float64Array.from([...blocks.flat(), agreeDirection, agreeMeanSign, upSpread, meanOfMeans]);
    if (metaVec.length !== this.artifact.metaFeatureNames.length) {
      throw new Error(`direction-ensemble: meta vector length ${metaVec.length} != schema ${this.artifact.metaFeatureNames.length}`);
    }

    const T = this.artifact.calibrationTemperature;
    const probs = softmaxOf(classRaws(this.artifact.meta.cls, metaVec).map((r) => r / T));
    const classes = this.artifact.meta.cls.classes;
    const iDown = classes.indexOf("STRONG_DOWN");
    const iNeutral = classes.indexOf("NEUTRAL");
    const iUp = classes.indexOf("STRONG_UP");
    if (iDown < 0 || iNeutral < 0 || iUp < 0) {
      throw new Error(`direction-ensemble: meta classes ${classes.join(",")} are not the expected three`);
    }

    const h36 = blocks[V3_HORIZONS.indexOf(36)];
    const [q10, q50, q90] = [h36[4], h36[5], h36[6]].sort((a, b) => a - b);
    const pStrongUp = probs[iUp];
    const pNeutral = probs[iNeutral];
    const pStrongDown = probs[iDown];

    const horizons: HorizonPrediction[] = V3_HORIZONS.map((h, i) => {
      const b = blocks[i];
      const [a10, a50, a90] = [b[4], b[5], b[6]].sort((p, q) => p - q);
      return {
        horizon: h, pStrongDown: b[0], pNeutral: b[1], pStrongUp: b[2],
        expectedReturn: b[3], q10: a10, q50: a50, q90: a90, expectedVol: b[7],
      };
    });

    // Confidence deliberately is NOT just the top probability. A 0.5 probability with all four
    // horizons leaning the same way and a lopsided distribution is a different proposition from
    // the same 0.5 with the horizons split, and the ladder should be able to tell them apart.
    const margin = Math.max(pStrongUp, pStrongDown) - pNeutral;
    const width = q90 - q10;
    const asymmetry = width > 1e-9 ? Math.abs(q90 + q10) / width : 0;
    const confidence = Math.max(0, Math.min(1,
      0.45 * Math.max(0, margin) + 0.35 * agreeDirection + 0.20 * Math.min(1, asymmetry)));

    for (const [k, v] of Object.entries({ pStrongUp, pNeutral, pStrongDown, expectedReturn: h36[3], confidence })) {
      if (!Number.isFinite(v)) throw new Error(`direction-ensemble: ${k} produced a non-finite value`);
    }

    return {
      pStrongUp, pNeutral, pStrongDown,
      directionScore: pStrongUp - pStrongDown,
      expectedReturn: h36[3], q10, q50, q90, expectedVol: h36[7],
      horizons, confidence, horizonAgreement: agreeDirection,
      modelVersion: this.artifact.version, schemaVersion: 3,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// V4 — TRAJECTORY / PATH PREDICTOR
// ---------------------------------------------------------------------------------------------

export type PathClassName =
  | "PERSISTENT_UP" | "PERSISTENT_DOWN"
  | "UP_THEN_REVERSAL" | "DOWN_THEN_REVERSAL"
  | "EARLY_UP_THEN_FLAT" | "EARLY_DOWN_THEN_FLAT"
  | "CHOP" | "TRANSITION";

export interface TrajectoryPrediction {
  /** Calibrated probability per path class, in the artifact's own class order. */
  pathProbabilities: Record<string, number>;
  topPath: PathClassName;
  topPathProbability: number;
  /** Net persistence: P(persistent up) - P(persistent down). */
  persistenceScore: number;
  /** Total probability mass on the two reversal classes. */
  reversalRisk: number;
  /** Per-horizon detail, in V3_HORIZONS order. */
  horizons: HorizonPrediction[];
  /** Mean lean of 6h+12h and of 24h+36h, and their difference (the reversal axis). */
  earlyLean: number;
  lateLean: number;
  reversalAxis: number;
  /** Endpoint distribution, still taken from the 36h specialist. */
  expectedReturn: number;
  q10: number;
  q50: number;
  q90: number;
  expectedVol: number;
  confidence: number;
  horizonAgreement: number;
  modelVersion: string;
  schemaVersion: number;
}

export interface DirectionTrajectoryArtifact {
  version: string;
  schemaVersion: 4;
  trainedAt: string;
  horizonBars: number;
  horizons: number[];
  trainingPopulation?: string;
  featureNames: string[];
  trajectoryFeatureNames: string[];
  classes: string[];
  pathClasses: string[];
  zBoundary: number;
  calibrationTemperature: number;
  configsEvaluated?: number;
  trainRows: number;
  pathCounts?: Record<string, number>;
  trainSpan: { fromMs: number; toMs: number };
  specialists: Record<string, SpecialistHeads>;
  trajectory: { cls: SoftmaxHead };
}

export function validateTrajectoryArtifact(a: unknown): asserts a is DirectionTrajectoryArtifact {
  const art = a as DirectionTrajectoryArtifact;
  if (!art || typeof art !== "object") throw new Error("direction-trajectory: not an object");
  if (art.schemaVersion !== 4) {
    throw new Error(`direction-trajectory: expected schemaVersion 4, got ${String(art.schemaVersion)}`);
  }
  if (!Array.isArray(art.featureNames) || !art.featureNames.length) {
    throw new Error("direction-trajectory: missing featureNames");
  }
  if (new Set(art.featureNames).size !== art.featureNames.length) {
    throw new Error("direction-trajectory: duplicate feature names");
  }
  if (!Array.isArray(art.pathClasses) || art.pathClasses.length < 2) {
    throw new Error("direction-trajectory: missing pathClasses");
  }
  if (!Number.isFinite(art.calibrationTemperature) || art.calibrationTemperature <= 0) {
    throw new Error("direction-trajectory: invalid calibrationTemperature");
  }
  for (const h of V3_HORIZONS) {
    const sp = art.specialists?.[String(h)];
    if (!sp) throw new Error(`direction-trajectory: missing specialist for horizon ${h}`);
    if (sp.cls?.kind !== "softmax" || sp.cls.perClass?.length !== 3) {
      throw new Error(`direction-trajectory: specialist ${h} cls head malformed`);
    }
    for (const name of ["mean", "q10", "q50", "q90", "vol"] as const) {
      if (!sp[name]?.trees?.length) throw new Error(`direction-trajectory: specialist ${h} missing ${name}`);
    }
  }
  const tj = art.trajectory?.cls;
  if (tj?.kind !== "softmax") throw new Error("direction-trajectory: trajectory head malformed");
  if (tj.perClass?.length !== art.pathClasses.length) {
    throw new Error("direction-trajectory: trajectory head does not cover every path class");
  }
  // 8 columns per horizon plus 8 shape aggregates. A mismatch means the trainer and the runtime
  // disagree about the vector, which would silently shift every column.
  const expected = 8 * V3_HORIZONS.length + 8;
  if (art.trajectoryFeatureNames?.length !== expected) {
    throw new Error(`direction-trajectory: trajectoryFeatureNames has ${art.trajectoryFeatureNames?.length}, expected ${expected}`);
  }
}

export class DirectionTrajectory {
  private constructor(readonly artifact: DirectionTrajectoryArtifact) {}

  static fromJson(raw: unknown): DirectionTrajectory {
    validateTrajectoryArtifact(raw);
    return new DirectionTrajectory(raw);
  }

  get version(): string {
    return this.artifact.version;
  }

  private vectorise(features: Record<string, number | null>): Float64Array {
    const names = this.artifact.featureNames;
    const x = new Float64Array(names.length);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (!(name in features)) {
        throw new Error(`direction-trajectory: feature "${name}" absent from input (schema mismatch)`);
      }
      const v = features[name];
      x[i] = v === null || !Number.isFinite(v) ? Number.NaN : v;
    }
    return x;
  }

  /** [p_down, p_neutral, p_up, mean, q10, q50, q90, vol] — the trainer's exact column order. */
  private block(h: V3Horizon, x: Float64Array): number[] {
    const sp = this.artifact.specialists[String(h)]!;
    const p = softmaxOf(classRaws(sp.cls, x));
    return [p[0], p[1], p[2], headRaw(sp.mean, x), headRaw(sp.q10, x), headRaw(sp.q50, x),
      headRaw(sp.q90, x), headRaw(sp.vol, x)];
  }

  predict(features: Record<string, number | null>): TrajectoryPrediction {
    const x = this.vectorise(features);
    const blocks = V3_HORIZONS.map((h) => this.block(h, x));

    // Shape aggregates, matching build_traj_features in the trainer exactly.
    const lean = blocks.map((b) => b[2] - b[0]);
    const means = blocks.map((b) => b[3]);
    const ups = blocks.map((b) => b[2]);
    const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
    const earlyLean = (lean[0] + lean[1]) / 2;
    const lateLean = (lean[2] + lean[3]) / 2;
    const reversalAxis = lateLean - earlyLean;
    const agreeDirection = Math.abs(lean.reduce((a, v) => a + sgn(v), 0)) / V3_HORIZONS.length;
    const agreeMeanSign = Math.abs(means.reduce((a, v) => a + sgn(v), 0)) / V3_HORIZONS.length;
    const upSpread = Math.max(...ups) - Math.min(...ups);
    const meanOfMeans = means.reduce((a, b) => a + b, 0) / means.length;
    const longMinusShort = means[3] - means[0];

    const vec = Float64Array.from([
      ...blocks.flat(),
      earlyLean, lateLean, reversalAxis, agreeDirection, agreeMeanSign, upSpread,
      meanOfMeans, longMinusShort,
    ]);
    if (vec.length !== this.artifact.trajectoryFeatureNames.length) {
      throw new Error(`direction-trajectory: vector length ${vec.length} != schema ${this.artifact.trajectoryFeatureNames.length}`);
    }

    const T = this.artifact.calibrationTemperature;
    const probs = softmaxOf(classRaws(this.artifact.trajectory.cls, vec).map((r) => r / T));
    const classes = this.artifact.pathClasses;
    const pathProbabilities: Record<string, number> = {};
    classes.forEach((c, i) => { pathProbabilities[c] = probs[i]; });

    let topIdx = 0;
    for (let i = 1; i < probs.length; i += 1) if (probs[i] > probs[topIdx]) topIdx = i;

    const pUp = pathProbabilities.PERSISTENT_UP ?? 0;
    const pDown = pathProbabilities.PERSISTENT_DOWN ?? 0;
    const reversalRisk = (pathProbabilities.UP_THEN_REVERSAL ?? 0) + (pathProbabilities.DOWN_THEN_REVERSAL ?? 0);

    const h36 = blocks[V3_HORIZONS.indexOf(36)];
    const [q10, q50, q90] = [h36[4], h36[5], h36[6]].sort((a, b) => a - b);

    const horizons: HorizonPrediction[] = V3_HORIZONS.map((h, i) => {
      const b = blocks[i];
      const [a10, a50, a90] = [b[4], b[5], b[6]].sort((p, q) => p - q);
      return {
        horizon: h, pStrongDown: b[0], pNeutral: b[1], pStrongUp: b[2],
        expectedReturn: b[3], q10: a10, q50: a50, q90: a90, expectedVol: b[7],
      };
    });

    // Confidence deliberately DISCOUNTS reversal mass: a high persistence probability that sits
    // beside a large reversal probability is not a confident reading, it is a contested one, and
    // the ladder must not treat the two the same.
    const persistenceScore = pUp - pDown;
    const confidence = Math.max(0, Math.min(1,
      0.50 * Math.abs(persistenceScore)
      + 0.30 * agreeDirection
      + 0.20 * Math.max(0, 1 - 2 * reversalRisk)));

    for (const [k, v] of Object.entries({ pUp, pDown, confidence, expectedReturn: h36[3] })) {
      if (!Number.isFinite(v)) throw new Error(`direction-trajectory: ${k} produced a non-finite value`);
    }

    return {
      pathProbabilities,
      topPath: classes[topIdx] as PathClassName,
      topPathProbability: probs[topIdx],
      persistenceScore,
      reversalRisk,
      horizons,
      earlyLean, lateLean, reversalAxis,
      expectedReturn: h36[3], q10, q50, q90, expectedVol: h36[7],
      confidence, horizonAgreement: agreeDirection,
      modelVersion: this.artifact.version, schemaVersion: 4,
    };
  }
}
