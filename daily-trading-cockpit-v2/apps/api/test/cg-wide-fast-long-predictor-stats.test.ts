import { describe, it, expect } from "vitest";
import {
  mean,
  median,
  rankValues,
  spearmanRho,
  pearsonCorrelation,
  computeBucketStats,
  buildTercileBucketer,
  trainLogisticRegression,
  predictLogisticProba,
  predictLogisticProbaBatch,
  buildDecisionTree,
  predictTreeProba,
  predictTreeProbaBatch,
  giniImpurity,
  describeTree,
  accuracy,
  logLoss,
  permutationImportance,
  permutationTestMeanDifference,
  mulberry32,
  type BucketStats,
} from "../src/lib/cg-wide-fast-long-predictor-stats.js";
import type { PathClass } from "../src/lib/cg-wide-fast-long-path-classification.js";

describe("mean / median", () => {
  it("computes mean and median of a plain array", () => {
    expect(mean([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
    expect(median([1, 2, 3])).toBe(2);
  });
  it("returns null for empty input", () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });
});

describe("rankValues — tie handling", () => {
  it("assigns average rank to tied values", () => {
    // values 5,5 tie for ranks 2 and 3 -> both get 2.5
    expect(rankValues([10, 5, 5, 20])).toEqual([3, 1.5, 1.5, 4]);
  });
  it("assigns simple 1..n ranks with no ties", () => {
    expect(rankValues([30, 10, 20])).toEqual([3, 1, 2]);
  });
});

describe("spearmanRho — hand-computed expected value", () => {
  it("matches the exact hand-computed rho for a known no-ties dataset", () => {
    // x = [10,20,30,40,50] -> ranks [1,2,3,4,5]
    // y = [7,6,4,5,3]      -> ranks [5,4,2,3,1]
    // d = rank_x - rank_y = [-4,-2,1,1,4] -> d^2 = [16,4,1,1,16] -> sum = 38
    // rho = 1 - 6*sum(d^2) / (n*(n^2-1)) = 1 - 228/120 = -0.9
    const x = [10, 20, 30, 40, 50];
    const y = [7, 6, 4, 5, 3];
    const { rho, n } = spearmanRho(x, y);
    expect(n).toBe(5);
    expect(rho).toBeCloseTo(-0.9, 10);
  });

  it("is exactly 1 for a perfectly monotonic increasing relationship", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(spearmanRho(x, y).rho).toBeCloseTo(1, 10);
  });

  it("drops null/non-finite entries pairwise before ranking", () => {
    const x: Array<number | null> = [1, 2, null, 4, 5];
    const y: Array<number | null> = [1, 2, 3, null, 5];
    // surviving pairs: (1,1) (2,2) (5,5) -> perfectly monotonic among survivors
    const { rho, n } = spearmanRho(x, y);
    expect(n).toBe(3);
    expect(rho).toBeCloseTo(1, 10);
  });

  it("returns null rho when fewer than 2 complete pairs remain", () => {
    expect(spearmanRho([1], [2]).rho).toBeNull();
    expect(spearmanRho([], []).rho).toBeNull();
  });

  it("returns null when the ranked variable has zero variance (all tied)", () => {
    expect(spearmanRho([5, 5, 5], [1, 2, 3]).rho).toBeNull();
  });
});

describe("pearsonCorrelation", () => {
  it("is 1 for identical linear increase and -1 for perfect inverse", () => {
    expect(pearsonCorrelation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearsonCorrelation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
  });
});

describe("computeBucketStats", () => {
  interface Row {
    id: string;
    bucket: string | null;
    pathClass: PathClass;
    netR: number | null;
    mfe: number | null;
    mae: number | null;
  }
  const rows: Row[] = [
    { id: "a", bucket: "X", pathClass: "TRUE_EXPANSION", netR: 1.2, mfe: 1.3, mae: -0.1 },
    { id: "b", bucket: "X", pathClass: "SCRATCHABLE", netR: 0.1, mfe: 0.3, mae: -0.2 },
    { id: "c", bucket: "X", pathClass: "DEAD_ON_ARRIVAL", netR: -0.2, mfe: 0.05, mae: -0.3 },
    { id: "d", bucket: "Y", pathClass: "TOXIC_REVERSAL", netR: -0.9, mfe: 0.05, mae: -0.8 },
  ];

  it("computes rates/means correctly and flags small samples", () => {
    const stats = computeBucketStats<Row>({
      records: rows,
      bucketOf: (r) => r.bucket,
      getPathClass: (r) => r.pathClass,
      getNetR: (r) => r.netR,
      getMFE: (r) => r.mfe,
      getMAE: (r) => r.mae,
      minReliableN: 2,
    });
    const bucketX = stats.find((s) => s.bucket === "X")!;
    expect(bucketX.n).toBe(3);
    expect(bucketX.expansionRate).toBeCloseTo(1 / 3, 10);
    expect(bucketX.scratchRate).toBeCloseTo(1 / 3, 10);
    expect(bucketX.deadRate).toBeCloseTo(1 / 3, 10);
    expect(bucketX.toxicRate).toBe(0);
    expect(bucketX.avgNetR).toBeCloseTo((1.2 + 0.1 - 0.2) / 3, 10);
    expect(bucketX.sampleTooSmall).toBe(false); // n=3 >= minReliableN=2

    const bucketY = stats.find((s) => s.bucket === "Y")!;
    expect(bucketY.n).toBe(1);
    expect(bucketY.toxicRate).toBe(1);
    expect(bucketY.sampleTooSmall).toBe(true); // n=1 < minReliableN=2
  });

  it("excludes records whose bucketOf returns null", () => {
    const stats = computeBucketStats<Row>({
      records: [...rows, { id: "e", bucket: null, pathClass: "TRUE_EXPANSION", netR: 5, mfe: 5, mae: 0 }],
      bucketOf: (r) => r.bucket,
      getPathClass: (r) => r.pathClass,
      getNetR: (r) => r.netR,
      getMFE: (r) => r.mfe,
      getMAE: (r) => r.mae,
    });
    const totalN = stats.reduce((s, b) => s + b.n, 0);
    expect(totalN).toBe(4); // the null-bucket record excluded
  });
});

describe("buildTercileBucketer", () => {
  it("splits 9 values into LOW/MID/HIGH terciles of 3 each", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => ({ record: v, value: v }));
    const bucketer = buildTercileBucketer(values);
    const labels = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(bucketer);
    expect(labels.filter((l) => l === "LOW")).toHaveLength(3);
    expect(labels.filter((l) => l === "MID")).toHaveLength(3);
    expect(labels.filter((l) => l === "HIGH")).toHaveLength(3);
    expect(bucketer(1)).toBe("LOW");
    expect(bucketer(9)).toBe("HIGH");
  });

  it("excludes null-valued records from any bucket", () => {
    const values = [
      { record: "a", value: 1 },
      { record: "b", value: null },
      { record: "c", value: 3 },
    ];
    const bucketer = buildTercileBucketer(values);
    expect(bucketer("b")).toBeNull();
  });
});

describe("giniImpurity", () => {
  it("is 0 for a pure set and 0.5 for a perfectly balanced set", () => {
    expect(giniImpurity([1, 1, 1, 1])).toBe(0);
    expect(giniImpurity([0, 0, 0, 0])).toBe(0);
    expect(giniImpurity([0, 1, 0, 1])).toBeCloseTo(0.5, 10);
  });
});

describe("buildDecisionTree — obviously-correct best split", () => {
  it("finds the exact threshold that perfectly separates two classes on a single feature", () => {
    // x <= 4 -> y=0, x > 4 -> y=1: perfect separation between 4 and 5.
    const X = [[1], [2], [3], [4], [5], [6], [7], [8]];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const tree = buildDecisionTree(X, y, { maxDepth: 1, minLeafSize: 2 });
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") throw new Error("unreachable");
    expect(tree.featureIndex).toBe(0);
    expect(tree.threshold).toBeGreaterThan(4);
    expect(tree.threshold).toBeLessThan(5);
    expect(tree.left.kind).toBe("leaf");
    expect(tree.right.kind).toBe("leaf");
    if (tree.left.kind === "leaf") expect(tree.left.positiveRate).toBe(0);
    if (tree.right.kind === "leaf") expect(tree.right.positiveRate).toBe(1);

    // predictions match the known generating rule
    expect(predictTreeProba(tree, [1])).toBe(0);
    expect(predictTreeProba(tree, [8])).toBe(1);
    expect(predictTreeProbaBatch(tree, X)).toEqual(y.map(Number));
  });

  it("picks the informative feature over a pure-noise feature", () => {
    const X = [
      [1, 99],
      [2, 1],
      [3, 50],
      [4, 3],
      [5, 77],
      [6, 2],
      [7, 60],
      [8, 4],
    ];
    const y = [0, 0, 0, 0, 1, 1, 1, 1]; // depends only on column 0 (threshold ~4.5)
    const tree = buildDecisionTree(X, y, { maxDepth: 1, minLeafSize: 2 });
    expect(tree.kind).toBe("split");
    if (tree.kind === "split") expect(tree.featureIndex).toBe(0);
  });

  it("stops at a pure leaf without over-splitting", () => {
    const X = [[1], [2], [3], [4]];
    const y = [1, 1, 1, 1];
    const tree = buildDecisionTree(X, y, { maxDepth: 2 });
    expect(tree.kind).toBe("leaf");
  });

  it("describeTree renders a human-readable structure without throwing", () => {
    const X = [[1], [2], [3], [4], [5], [6], [7], [8]];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const tree = buildDecisionTree(X, y, { maxDepth: 1, minLeafSize: 2 });
    const lines = describeTree(tree, ["myFeature"]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("myFeature"))).toBe(true);
  });
});

describe("trainLogisticRegression — converges to the correct direction of effect", () => {
  it("learns a positive weight for a feature that clearly separates the classes upward", () => {
    const X = [[-5], [-4], [-3], [-2], [-1], [1], [2], [3], [4], [5]];
    const y = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const model = trainLogisticRegression(X, y, { iterations: 3000, learningRate: 0.5 });
    expect(model.weights[0]).toBeGreaterThan(0);
    // strongly negative input -> low probability, strongly positive input -> high probability
    expect(predictLogisticProba(model, [-5])).toBeLessThan(0.1);
    expect(predictLogisticProba(model, [5])).toBeGreaterThan(0.9);
    // predictions should be monotonically non-decreasing in x on this dataset
    const probs = predictLogisticProbaBatch(model, X);
    for (let i = 1; i < probs.length; i++) expect(probs[i]!).toBeGreaterThanOrEqual(probs[i - 1]!);
  });

  it("learns a negative weight when the relationship is inverted", () => {
    const X = [[-5], [-4], [-3], [-2], [-1], [1], [2], [3], [4], [5]];
    const y = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const model = trainLogisticRegression(X, y, { iterations: 3000, learningRate: 0.5 });
    expect(model.weights[0]).toBeLessThan(0);
  });

  it("finalLoss decreases relative to the naive 50/50 baseline on separable data", () => {
    const X = [[-5], [-4], [-3], [-2], [-1], [1], [2], [3], [4], [5]];
    const y = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const model = trainLogisticRegression(X, y, { iterations: 3000, learningRate: 0.5 });
    expect(model.finalLoss).toBeLessThan(Math.log(2)); // ln(2) ~ 0.693 = loss of a coin-flip model
  });
});

describe("accuracy / logLoss", () => {
  it("accuracy is 1.0 for perfect predictions and 0.0 for perfectly wrong ones", () => {
    expect(accuracy([0, 1, 0, 1], [0.1, 0.9, 0.2, 0.8])).toBe(1);
    expect(accuracy([0, 1, 0, 1], [0.9, 0.1, 0.9, 0.1])).toBe(0);
  });
  it("logLoss is lower for confident-correct predictions than for confident-wrong ones", () => {
    const good = logLoss([1, 1, 1], [0.9, 0.9, 0.9]);
    const bad = logLoss([1, 1, 1], [0.1, 0.1, 0.1]);
    expect(good).toBeLessThan(bad);
  });
});

describe("permutationImportance", () => {
  it("ranks a genuinely informative feature above a pure-noise feature", () => {
    // column 0 fully determines y; column 1 is independent random noise.
    const rng = mulberry32(42);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 40; i++) {
      const informative = i < 20 ? 0 : 1;
      X.push([informative, rng()]);
      y.push(informative);
    }
    const model = trainLogisticRegression(X, y, { iterations: 2000 });
    const results = permutationImportance(
      (Xin) => predictLogisticProbaBatch(model, Xin),
      X,
      y,
      { metric: accuracy, higherIsBetter: true, permutations: 200, rng: mulberry32(7) },
    );
    const informativeImportance = results[0]!.importance;
    const noiseImportance = results[1]!.importance;
    expect(informativeImportance).toBeGreaterThan(noiseImportance);
  });
});

describe("permutationTestMeanDifference", () => {
  it("gives a low p-value for a large, obviously-real difference between groups", () => {
    const groupA = [10, 11, 9, 10.5, 9.5, 10, 11, 9];
    const groupB = [1, 2, 0.5, 1.5, 1, 2, 0.5, 1];
    const result = permutationTestMeanDifference(groupA, groupB, { permutations: 1000, rng: mulberry32(1) });
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("gives a high p-value when both groups are drawn from the same distribution", () => {
    const rng = mulberry32(99);
    const pooled = Array.from({ length: 40 }, () => rng() * 10);
    const groupA = pooled.slice(0, 20);
    const groupB = pooled.slice(20);
    const result = permutationTestMeanDifference(groupA, groupB, { permutations: 1000, rng: mulberry32(2) });
    expect(result.pValue).toBeGreaterThan(0.1);
  });
});
