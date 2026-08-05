import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EDGE_HYPOTHESES,
  EDGE_EPISODE_BLOCK_WIDTH_MS,
  EDGE_PARTITION_SHARES,
  POST_OUTCOME_FIELDS,
  buildEdgeDiggerReport,
  edgeClusterBootstrap,
  edgeDiggerPolicy,
  edgeEpisodeStats,
  edgeMetrics,
  loadEdgeSource,
  partitionByEpisode,
  type EdgeEvidenceRow,
} from "../src/lib/edge-digger.js";
import {
  countIndependentEpisodes,
  MAX_TOP_SYMBOL_SHARE,
  PF_FLOOR,
  STABLE_MIN_EFFECTIVE_N,
  STABLE_MIN_HOLDOUT_EFFECTIVE_N,
  PROMOTION_MIN_HOLDOUT_EFFECTIVE_N,
} from "../src/lib/current-guard-variant-matrix.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "edge-digger-"));
  dirs.push(dir);
  return dir;
}

const HOUR = 3_600_000;

/** Deterministic row builder — every field explicit, so a fixture's expected numbers are derivable
 *  by hand from the test itself rather than from a snapshot nobody can re-derive. */
function row(overrides: Partial<EdgeEvidenceRow> & { observationId: string; openedAtMs: number }): EdgeEvidenceRow {
  return {
    sourceStore: "fixture.json",
    openedAt: new Date(overrides.openedAtMs).toISOString(),
    resolvedAt: new Date(overrides.openedAtMs + HOUR).toISOString(),
    status: "CLOSED_WIN",
    direction: "LONG",
    symbol: "BTCUSDT",
    regime: "BULLISH",
    grossR: 1,
    netR: 1,
    costR: -0.05,
    exitReason: "TP_HIT",
    maxFavorableR: null,
    maxAdverseR: null,
    ...overrides,
  };
}

function writeStore(dir: string, name: string, observations: unknown[]): void {
  writeFileSync(join(dir, name), JSON.stringify({ version: 1, observations, cycleMeta: {} }));
}

describe("edge-digger", () => {
  // -------------------------------------------------------------------------
  // Leakage.
  // -------------------------------------------------------------------------
  describe("leakage boundary", () => {
    it("no frozen hypothesis declares a post-outcome field as a conditioning feature", () => {
      for (const h of EDGE_HYPOTHESES) {
        const leaked = h.allowedDecisionTimeFeatures.filter((f) => POST_OUTCOME_FIELDS.includes(f));
        expect(leaked, `${h.id} leaked: ${leaked.join(", ")}`).toEqual([]);
      }
    });

    it("costR is treated as POST-outcome — it is written at creation but MUTATED at resolution to fold in outcome-dependent slippage and funding", () => {
      // This is the subtle trap this codebase actually contains; a pipeline that treated costR as a
      // decision-time feature would condition on the outcome through the back door.
      expect(POST_OUTCOME_FIELDS).toContain("costR");
      expect(POST_OUTCOME_FIELDS).toContain("netR");
      expect(POST_OUTCOME_FIELDS).toContain("grossR");
      expect(POST_OUTCOME_FIELDS).toContain("exitReason");
      for (const h of EDGE_HYPOTHESES) {
        expect(h.allowedDecisionTimeFeatures).not.toContain("costR");
      }
    });

    it("every hypothesis is fully predeclared — rule, rationale, cost model and rejection rules all non-empty", () => {
      expect(EDGE_HYPOTHESES.length).toBe(3);
      for (const h of EDGE_HYPOTHESES) {
        expect(h.rule.length).toBeGreaterThan(0);
        expect(h.rationale.length).toBeGreaterThan(0);
        expect(h.costModel.length).toBeGreaterThan(0);
        expect(h.rejectionRules.length).toBeGreaterThan(0);
        expect(h.allowedDecisionTimeFeatures.length).toBeGreaterThan(0);
        expect(h.sources.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Independent episodes vs raw rows — THE discipline.
  // -------------------------------------------------------------------------
  describe("independent episodes, never raw rows", () => {
    it("50 rows fired inside ONE max-hold window collapse to 1 independent episode", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 50 }, (_, i) =>
        row({ observationId: `same-window-${i}`, openedAtMs: base + i * 60_000, symbol: `S${i % 7}USDT` }));
      const stats = edgeEpisodeStats(rows);
      expect(stats.rawRows).toBe(50);
      expect(stats.independentEpisodes).toBe(1);
      expect(stats.rowsPerEpisode).toBe(50);
      expect(stats.largestEpisodeShare).toBe(1);
    });

    it("rows spaced beyond the block width count as separate episodes", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 5 }, (_, i) =>
        row({ observationId: `spread-${i}`, openedAtMs: base + i * (EDGE_EPISODE_BLOCK_WIDTH_MS + HOUR) }));
      expect(edgeEpisodeStats(rows).independentEpisodes).toBe(5);
    });

    it("the episode count is the CANONICAL one — identical to countIndependentEpisodes on the same rows", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = [
        row({ observationId: "a", openedAtMs: base }),
        row({ observationId: "b", openedAtMs: base + HOUR }),
        row({ observationId: "c", openedAtMs: base + 40 * HOUR }),
        row({ observationId: "d", openedAtMs: base + 200 * HOUR }),
      ];
      const canonical = countIndependentEpisodes(
        rows.map((r) => ({ episodeMs: r.openedAtMs, observationId: r.observationId, batchId: null, episodeId: null })),
        EDGE_EPISODE_BLOCK_WIDTH_MS,
      );
      expect(edgeEpisodeStats(rows).independentEpisodes).toBe(canonical);
      expect(canonical).toBe(3);
    });

    it("episode identity is order-independent: a shuffled input yields the identical count", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 12 }, (_, i) =>
        row({ observationId: `ord-${i}`, openedAtMs: base + i * 20 * HOUR }));
      const forward = edgeEpisodeStats(rows).independentEpisodes;
      const reversed = edgeEpisodeStats(rows.slice().reverse()).independentEpisodes;
      const shuffled = edgeEpisodeStats([rows[5]!, rows[0]!, rows[11]!, ...rows.slice(1, 5), ...rows.slice(6, 11)])
        .independentEpisodes;
      expect(reversed).toBe(forward);
      expect(shuffled).toBe(forward);
    });

    it("distinct(netR)/n exposes duplicate-value inflation — 1 value repeated 200x reads as 0.005", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 200 }, (_, i) =>
        row({ observationId: `dup-${i}`, openedAtMs: base + i * 60_000, netR: 0.42, grossR: 0.47 }));
      expect(edgeEpisodeStats(rows).distinctNetRRatio).toBe(0.005);
    });
  });

  // -------------------------------------------------------------------------
  // PF semantics.
  // -------------------------------------------------------------------------
  describe("PF zero-denominator semantics", () => {
    it("all wins and zero losses => pf null with pfStatus NO_LOSSES_YET, never a large sentinel", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 20 }, (_, i) =>
        row({ observationId: `w-${i}`, openedAtMs: base + i * HOUR, netR: 0.4, grossR: 0.5 }));
      const m = edgeMetrics(rows);
      expect(m.pf).toBeNull();
      expect(m.pfStatus).toBe("NO_LOSSES_YET");
      expect(m.pf).not.toBe(999_999);
      expect(m.wr).toBe(1);
    });

    it("all losses and zero wins => pf null with pfStatus NO_WINS_YET", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 4 }, (_, i) =>
        row({ observationId: `l-${i}`, openedAtMs: base + i * HOUR, netR: -1, grossR: -0.9, status: "CLOSED_LOSS" }));
      const m = edgeMetrics(rows);
      expect(m.pf).toBeNull();
      expect(m.pfStatus).toBe("NO_WINS_YET");
    });

    it("a genuine mix computes a real PF", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = [
        row({ observationId: "w1", openedAtMs: base, netR: 2 }),
        row({ observationId: "l1", openedAtMs: base + HOUR, netR: -1, status: "CLOSED_LOSS" }),
      ];
      const m = edgeMetrics(rows);
      expect(m.pf).toBe(2);
      expect(m.pfStatus).toBe("COMPUTED");
    });
  });

  // -------------------------------------------------------------------------
  // Cluster bootstrap.
  // -------------------------------------------------------------------------
  describe("clustered bootstrap", () => {
    it("refuses to produce an interval from fewer than 2 independent episodes", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 300 }, (_, i) =>
        row({ observationId: `one-ep-${i}`, openedAtMs: base + i * 60_000 }));
      const b = edgeClusterBootstrap(rows);
      expect(b.clusters).toBe(1);
      expect(b.lowerBound95).toBeNull();
      expect(b.upperBound95).toBeNull();
      expect(b.note).toContain("fewer than 2 independent episodes");
    });

    it("is deterministic — the same cohort produces a byte-identical interval on repeated runs", () => {
      const base = Date.UTC(2026, 7, 1);
      const rows = Array.from({ length: 40 }, (_, i) =>
        row({
          observationId: `boot-${i}`,
          openedAtMs: base + i * 10 * HOUR,
          netR: i % 3 === 0 ? -1 : 0.6,
          status: i % 3 === 0 ? "CLOSED_LOSS" : "CLOSED_WIN",
        }));
      const a = edgeClusterBootstrap(rows);
      const b = edgeClusterBootstrap(rows);
      expect(a.lowerBound95).toBe(b.lowerBound95);
      expect(a.upperBound95).toBe(b.upperBound95);
      expect(a.deterministic).toBe(true);
      // ...and independent of input order, since the seed is derived from the ids, not the array.
      const c = edgeClusterBootstrap(rows.slice().reverse());
      expect(c.lowerBound95).toBe(a.lowerBound95);
    });

    it("clusters by EPISODE, not by row — an all-identical-row cohort cannot manufacture a tight interval", () => {
      const base = Date.UTC(2026, 7, 1);
      // 200 rows, all +0.42R, all inside ONE window: a row-level bootstrap would return a
      // zero-width interval around +0.42 and read as overwhelming evidence.
      const rows = Array.from({ length: 200 }, (_, i) =>
        row({ observationId: `flat-${i}`, openedAtMs: base + i * 60_000, netR: 0.42 }));
      const b = edgeClusterBootstrap(rows);
      expect(b.clusters).toBe(1);
      expect(b.lowerBound95).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Partitions.
  // -------------------------------------------------------------------------
  describe("chronological partitions", () => {
    it("splits by EPISODE (never mid-episode) in chronological order using the predeclared shares", () => {
      const base = Date.UTC(2026, 7, 1);
      // 10 well-separated episodes, 3 rows each.
      const rows = Array.from({ length: 30 }, (_, i) => {
        const episode = Math.floor(i / 3);
        return row({ observationId: `p-${i}`, openedAtMs: base + episode * 50 * HOUR + (i % 3) * 60_000 });
      });
      const { dev, validation, recent } = partitionByEpisode(rows);
      expect(EDGE_PARTITION_SHARES.dev).toBe(0.6);
      expect(dev.length).toBe(18);        // 6 episodes x 3
      expect(validation.length).toBe(6);  // 2 episodes x 3
      expect(recent.length).toBe(6);      // 2 episodes x 3
      // Chronological: every DEV row precedes every validation row, which precedes every recent row.
      const maxDev = Math.max(...dev.map((r) => r.openedAtMs!));
      const minVal = Math.min(...validation.map((r) => r.openedAtMs!));
      const maxVal = Math.max(...validation.map((r) => r.openedAtMs!));
      const minRecent = Math.min(...recent.map((r) => r.openedAtMs!));
      expect(maxDev).toBeLessThan(minVal);
      expect(maxVal).toBeLessThan(minRecent);
      // No episode is cut in half: each partition's row count is a multiple of the episode size.
      for (const part of [dev, validation, recent]) expect(part.length % 3).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Integrity + eligibility.
  // -------------------------------------------------------------------------
  describe("canonical integrity", () => {
    it("a lane-edge store is NON_CANONICAL and names every canonical marker it cannot express", () => {
      const dir = tmpDir();
      writeStore(dir, "residual-momentum-edge.json", [
        { observationId: "x1", openedAt: "2026-08-01T00:00:00.000Z", status: "CLOSED_WIN", direction: "SHORT", grossR: 1, netR: 0.9 },
      ]);
      const { integrity, rows } = loadEdgeSource(dir, { store: "residual-momentum-edge.json", label: "rm", direction: "SHORT" });
      expect(integrity.verdict).toBe("NON_CANONICAL");
      expect(integrity.markers.evidenceVersionPin).toBe(false);
      expect(integrity.markers.entryFreshness).toBe(false);
      expect(integrity.markers.causalProvenance).toBe(false);
      expect(integrity.markers.costDecomposable).toBe(false);
      expect(integrity.missingMarkers.join(" ")).toContain("openMaxHoldMs");
      expect(rows.length).toBe(1);
    });

    it("an absent store is ABSENT with zero rows — never silently treated as an empty success", () => {
      const dir = tmpDir();
      const { integrity, rows } = loadEdgeSource(dir, { store: "nope.json", label: "nope" });
      expect(integrity.verdict).toBe("ABSENT");
      expect(integrity.present).toBe(false);
      expect(rows).toEqual([]);
    });

    it("an unparseable store fails closed to zero rows rather than throwing or guessing", () => {
      const dir = tmpDir();
      writeFileSync(join(dir, "residual-momentum-edge.json"), "{ not json");
      const { integrity, rows } = loadEdgeSource(dir, { store: "residual-momentum-edge.json", label: "rm" });
      expect(integrity.verdict).toBe("NON_CANONICAL");
      expect(integrity.note).toContain("unparseable");
      expect(rows).toEqual([]);
    });

    it("only terminal rows with finite gross AND net are eligible; OPEN/malformed rows are dropped", () => {
      const dir = tmpDir();
      writeStore(dir, "s.json", [
        { observationId: "ok", openedAt: "2026-08-01T00:00:00.000Z", status: "CLOSED_WIN", grossR: 1, netR: 0.9 },
        { observationId: "open", openedAt: "2026-08-01T01:00:00.000Z", status: "OPEN", grossR: null, netR: null },
        { observationId: "nan", openedAt: "2026-08-01T02:00:00.000Z", status: "CLOSED_LOSS", grossR: 1, netR: null },
        { openedAt: "2026-08-01T03:00:00.000Z", status: "CLOSED_WIN", grossR: 1, netR: 1 }, // no id
      ]);
      const { rows, integrity } = loadEdgeSource(dir, { store: "s.json", label: "s" });
      expect(integrity.rawRows).toBe(4);
      expect(rows.map((r) => r.observationId)).toEqual(["ok"]);
    });

    it("a direction-filtered source keeps only its declared direction", () => {
      const dir = tmpDir();
      writeStore(dir, "s.json", [
        { observationId: "L", openedAt: "2026-08-01T00:00:00.000Z", status: "CLOSED_WIN", direction: "LONG", grossR: 1, netR: 1 },
        { observationId: "S", openedAt: "2026-08-01T01:00:00.000Z", status: "CLOSED_WIN", direction: "SHORT", grossR: 1, netR: 1 },
      ]);
      const { rows } = loadEdgeSource(dir, { store: "s.json", label: "s", direction: "SHORT" });
      expect(rows.map((r) => r.observationId)).toEqual(["S"]);
    });

    it("max adverse excursion is null when unrecorded — never imputed from netR", () => {
      const dir = tmpDir();
      writeStore(dir, "s.json", [
        { observationId: "a", openedAt: "2026-08-01T00:00:00.000Z", status: "CLOSED_LOSS", grossR: -1, netR: -1.1 },
      ]);
      const { rows } = loadEdgeSource(dir, { store: "s.json", label: "s" });
      expect(rows[0]!.maxAdverseR).toBeNull();
      expect(edgeMetrics(rows).maxAdverseExcursionR).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Gates read canonical policy.
  // -------------------------------------------------------------------------
  describe("gates", () => {
    it("every threshold is READ from the canonical exported policy constants, never redeclared", () => {
      const p = edgeDiggerPolicy();
      expect(p.devMinIndependentEpisodes).toBe(STABLE_MIN_EFFECTIVE_N);
      expect(p.validationMinIndependentEpisodes).toBe(STABLE_MIN_HOLDOUT_EFFECTIVE_N);
      expect(p.recentMinIndependentEpisodes).toBe(PROMOTION_MIN_HOLDOUT_EFFECTIVE_N);
      expect(p.maxTopSymbolPnlShare).toBe(MAX_TOP_SYMBOL_SHARE);
      expect(p.pfFloor).toBe(PF_FLOOR);
      expect(p.comparator).toBe(">=");
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end deterministic fixture + restart stability.
  // -------------------------------------------------------------------------
  describe("end-to-end", () => {
    it("[FIXTURE] a hypothesis whose evidence is one big cluster of losers REJECTS, and names every reason", () => {
      const dir = tmpDir();
      const base = Date.UTC(2026, 7, 1);
      writeStore(dir, "compression-expansion-edge.json", Array.from({ length: 4 }, (_, i) => ({
        observationId: `ce-${i}`,
        openedAt: new Date(base).toISOString(), // all four at ONE instant — 1 episode
        resolvedAt: new Date(base + HOUR).toISOString(),
        status: "CLOSED_LOSS",
        direction: "SHORT",
        symbol: `S${i}USDT`,
        grossR: -1,
        netR: -1.17,
        stopDistanceBps: 200,
      })));
      const report = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      const f3 = report.hypotheses.find((h) => h.hypothesis.id === "F3_COMPRESSION_OR_FUNDING_CARRY")!;

      expect(f3.decision).toBe("REJECT");
      expect(f3.episodes.rawRows).toBe(4);
      expect(f3.episodes.independentEpisodes).toBe(1);
      expect(f3.metrics.netExpectancyR).toBeCloseTo(-1.17, 9);
      expect(f3.metrics.pf).toBeNull();
      expect(f3.metrics.pfStatus).toBe("NO_WINS_YET");
      const reasons = f3.rejectionReasons.join(" | ");
      expect(reasons).toContain("evidence integrity");
      expect(reasons).toContain("after-cost net expectancy");
      expect(reasons).toContain("NO_TRADE (flat) beats the hypothesis");
      expect(reasons).toContain("clustered confidence interval undefined");
      // Evidence-still-needed is expressed in EPISODES (elapsed market time), not rows.
      expect(f3.evidenceStillNeeded.join(" ")).toContain("independent DEV episodes");
      // And nothing is ever promoted.
      expect(report.candidates).toEqual([]);
      expect(report.recommendation).toBeNull();
    });

    it("[FIXTURE] raw n alone never produces a CANDIDATE — 400 profitable rows inside one window still REJECT on episodes", () => {
      const dir = tmpDir();
      const base = Date.UTC(2026, 7, 1);
      writeStore(dir, "residual-momentum-edge.json", Array.from({ length: 400 }, (_, i) => ({
        observationId: `rm-${i}`,
        openedAt: new Date(base + i * 60_000).toISOString(), // all inside ONE 36h window
        resolvedAt: new Date(base + i * 60_000 + HOUR).toISOString(),
        status: i % 5 === 0 ? "CLOSED_LOSS" : "CLOSED_WIN",
        direction: "SHORT",
        symbol: `S${i % 11}USDT`,
        grossR: i % 5 === 0 ? -1 : 1,
        netR: i % 5 === 0 ? -1 : 1, // strongly profitable: PF = 4.0
        stopDistanceBps: 300,
      })));
      const report = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      const f2 = report.hypotheses.find((h) => h.hypothesis.id === "F2_RESIDUAL_MOMENTUM_SHORT")!;

      // The economics look excellent...
      expect(f2.metrics.n).toBe(400);
      expect(f2.metrics.netExpectancyR).toBeGreaterThan(0);
      expect(f2.metrics.pf).toBeCloseTo(4, 9);
      // ...and it is STILL rejected, because 400 rows are one look at the market.
      expect(f2.episodes.independentEpisodes).toBe(1);
      expect(f2.decision).toBe("REJECT");
      expect(f2.rejectionReasons.join(" | ")).toContain("DEV independent episodes");
      expect(report.candidates).toEqual([]);
    });

    // Added after a surviving mutant: swapping the DEV gate from `devPart.episodes` to
    // `devPart.rows` passed the whole suite, because no fixture had a DEV slice that was ROW-rich
    // and EPISODE-poor at the same time. This one is built to be exactly that and nothing else.
    it("[MUTANT-KILL] the DEV gate counts EPISODES, not rows — a row-rich, episode-poor DEV slice still fails", () => {
      const dir = tmpDir();
      const base = Date.UTC(2026, 7, 1);
      // 10 well-separated episodes x 25 rows each = 250 rows. DEV takes the first 6 episodes:
      // 150 rows but only 6 independent episodes. 150 >= 10 would PASS on rows; 6 >= 10 FAILS on
      // episodes — which is the only correct answer.
      const rows: unknown[] = [];
      for (let episode = 0; episode < 10; episode++) {
        for (let k = 0; k < 25; k++) {
          rows.push({
            observationId: `ep${episode}-r${k}`,
            openedAt: new Date(base + episode * 50 * HOUR + k * 60_000).toISOString(),
            resolvedAt: new Date(base + episode * 50 * HOUR + k * 60_000 + HOUR).toISOString(),
            status: k % 4 === 0 ? "CLOSED_LOSS" : "CLOSED_WIN",
            direction: "SHORT",
            symbol: `S${k % 8}USDT`,
            grossR: k % 4 === 0 ? -1 : 1,
            netR: k % 4 === 0 ? -1 : 1,
            stopDistanceBps: 300,
          });
        }
      }
      writeStore(dir, "residual-momentum-edge.json", rows);
      const report = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      const f2 = report.hypotheses.find((h) => h.hypothesis.id === "F2_RESIDUAL_MOMENTUM_SHORT")!;
      const dev = f2.partitions.find((p) => p.partition === "DEV")!;

      // The slice really is row-rich and episode-poor — otherwise this test proves nothing.
      expect(dev.rows).toBe(150);
      expect(dev.episodes).toBe(6);
      expect(dev.rows).toBeGreaterThan(edgeDiggerPolicy().devMinIndependentEpisodes);
      expect(dev.episodes).toBeLessThan(edgeDiggerPolicy().devMinIndependentEpisodes);

      const devGate = f2.gates.find((g) => g.id === "dev_episodes")!;
      expect(devGate.current).toBe(6);   // episodes, NOT 150 rows
      expect(devGate.pass).toBe(false);
      expect(f2.decision).toBe("REJECT");
    });

    it("[RESTART/CACHE] the same evidence produces a byte-identical report across independent runs", () => {
      const dir = tmpDir();
      const base = Date.UTC(2026, 7, 1);
      writeStore(dir, "residual-momentum-edge.json", Array.from({ length: 60 }, (_, i) => ({
        observationId: `rm-${i}`,
        openedAt: new Date(base + i * 9 * HOUR).toISOString(),
        resolvedAt: new Date(base + i * 9 * HOUR + HOUR).toISOString(),
        status: i % 3 === 0 ? "CLOSED_LOSS" : "CLOSED_WIN",
        direction: "SHORT",
        symbol: `S${i % 6}USDT`,
        grossR: i % 3 === 0 ? -1 : 0.8,
        netR: i % 3 === 0 ? -1.05 : 0.75,
        stopDistanceBps: 250,
      })));
      const a = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      const b = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      // Full structural equality, bootstrap interval included — a research CI that moved between
      // runs on identical data would be unreproducible and therefore worthless as evidence.
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it("[NO EVIDENCE] a hypothesis with no recorded rows REJECTS with an explicit no-evidence reason, never a silent pass", () => {
      const dir = tmpDir(); // no stores at all
      const report = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      expect(report.hypotheses.length).toBe(3);
      for (const h of report.hypotheses) {
        expect(h.decision).toBe("REJECT");
        expect(h.rejectionReasons.join(" | ")).toContain("no eligible forward evidence");
        expect(h.integrity.every((i) => i.verdict === "ABSENT")).toBe(true);
      }
      expect(report.candidates).toEqual([]);
      expect(report.recommendation).toBeNull();
    });

    it("the report is self-describing as report-only and live-blocked", () => {
      const dir = tmpDir();
      const report = buildEdgeDiggerReport({ dataDir: dir, generatedAt: "2026-08-06T00:00:00.000Z" });
      expect(report.reportOnly).toBe(true);
      expect(report.liveBlocked).toBe(true);
      expect(report.policy.source).toContain("current-guard-variant-matrix.ts");
    });
  });
});
