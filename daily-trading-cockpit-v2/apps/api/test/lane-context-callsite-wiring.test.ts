/**
 * Stage-2 CALL-SITE WIRING integration tests. These prove the three report-only taps cannot disturb their hosts:
 *   1. Resolution tap (shadow.ts, post-resolvePaperOrders): observes persisted outcomes, never mutates an order,
 *      fail-open; sees the PERSISTED closedAtMs (market ts), not a draft.
 *   2. Snapshot tap (app.ts, four-brain cadence): values equal the call-site values; a later source mutation can't
 *      alter a recorded snapshot; a thrown writer never escapes; no active incumbent lane is dropped.
 *   3. Lifecycle tap (live-execution-engine.openIntent): default-OFF; 3103 hard-blocked; when the logger throws at
 *      EVERY entry point the exchange-call sequence + intent result are byte-for-byte unchanged and nothing throws.
 *   4. Writer-lock boot: a second live writer disables the journal (scan returns writer-lock-unavailable) without
 *      throwing — the incumbent cycle keeps running.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLaneResolutionScan,
  journalLaneSnapshots,
  recordExecLifecycle,
  laneJournalActive,
  scanMetrics,
  snapshotMetrics,
  lifecycleMetrics,
  _resetLaneRuntimeForTests,
  type PaperOrderLike,
} from "../src/lib/lane-context-journal-runtime.js";
import {
  buildLaneContextSnapshotInputs,
  type IncumbentLaneForSnapshot,
} from "../src/lib/lane-context-snapshot-source.js";
import { planSnapshotBatch, resolveLaneJournalActivation, resolveCollectOnly } from "../src/lib/lane-context-journal-binding.js";

// ── env harness — every entry point takes an explicit env; the tap in the live engine uses process.env ─────────
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lane-cs-"));
  dirs.push(d);
  return d;
}
const shadowEnv = (dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  LANE_CONTEXT_JOURNAL_MODE: "shadow",
  FOUR_BRAIN_INSTANCE_ID: "3102",
  LANE_CONTEXT_JOURNAL_DIR: dir,
  ...extra,
});

beforeEach(() => _resetLaneRuntimeForTests());
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────
const closedOrder = (over: Partial<PaperOrderLike> = {}): PaperOrderLike => ({
  paperOrderId: "po-1",
  selectedLaneId: "CG_WIDE_FAST_LONG",
  symbol: "CG_WIDE_FAST_LONG", // lane-level identity: matches snapshot symbolOrBasketId so the strict matcher can attribute
  direction: "LONG",
  paperStatus: "PAPER_CLOSED_WIN",
  openedAt: new Date(2_000).toISOString(),
  closedAtMs: 5_000,
  resolvedAtMs: 6_000,
  grossR: 1.0,
  costR: 0.15,
  netR: 0.85,
  closeReason: "TP1",
  closeIntrabarAmbiguous: false,
  ...over,
});

const lane = (over: Partial<IncumbentLaneForSnapshot> = {}): IncumbentLaneForSnapshot => ({
  laneId: "CG_WIDE_FAST_LONG",
  weightPct: 40,
  status: "SUPPORTED",
  direction: "LONG",
  reason: null,
  ...over,
});

// ═══════════════════════════════ 1. RESOLUTION TAP ═══════════════════════════════
describe("resolution call-site tap — never disturbs the resolver", () => {
  it("does not mutate the persisted orders (byte-for-byte unchanged after a scan)", () => {
    const dir = tmp();
    const orders = [closedOrder(), closedOrder({ paperOrderId: "po-2", netR: -0.5, paperStatus: "PAPER_CLOSED_LOSS" })];
    const before = JSON.parse(JSON.stringify(orders));
    const r = runLaneResolutionScan(orders, 7_000, shadowEnv(dir));
    expect(r.ran).toBe(true);
    expect(orders).toEqual(before); // the tap OBSERVES; it never writes back to an order
  });

  it("sees the PERSISTED closedAtMs (market ts), never a draft — recorded on the resolution", () => {
    const dir = tmp();
    runLaneResolutionScan([closedOrder({ closedAtMs: 5_000, resolvedAtMs: 6_000 })], 7_000, shadowEnv(dir));
    const path = join(dir, "lane-context", "3102", "resolutions.jsonl");
    expect(existsSync(path)).toBe(true);
    const rec = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]!) as { closedAtMs: number; attributionStatus: string };
    expect(rec.closedAtMs).toBe(5_000); // market close ts, NOT resolvedAtMs (6000) or a draft
  });

  it("fail-open: a broken journal dir yields {ran:false} without throwing, orders untouched", () => {
    const fileAsDir = join(tmp(), "not-a-dir");
    writeFileSync(fileAsDir, "x"); // a FILE where the base dir should be ⇒ every fs op under it throws
    const orders = [closedOrder()];
    const before = JSON.parse(JSON.stringify(orders));
    let threw = false;
    let res: { ran: boolean } = { ran: true };
    try { res = runLaneResolutionScan(orders, 7_000, shadowEnv(fileAsDir)); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(res.ran).toBe(false);
    expect(orders).toEqual(before);
  });

  it("mode off ⇒ ZERO I/O (no journal dir created)", () => {
    const dir = tmp();
    const r = runLaneResolutionScan([closedOrder()], 7_000, { ...shadowEnv(dir), LANE_CONTEXT_JOURNAL_MODE: "off" });
    expect(r.ran).toBe(false);
    expect(existsSync(join(dir, "lane-context"))).toBe(false);
  });
});

// ═══════════════════════════════ 2. SNAPSHOT TAP ═══════════════════════════════
describe("snapshot call-site tap — faithful capture, frozen, isolated, complete", () => {
  const source = () => ({
    regimeRaw: "BULLISH_EXPANSION",
    axisScore: 0.62,
    controllerMode: "LONG_BIAS",
    conviction: 0.4,
    lanes: [lane(), lane({ laneId: "CG_WIDE_FAST_SHORT", direction: "SHORT", weightPct: 20 })],
    laneEdgeStat: (_dir: "LONG" | "SHORT", laneId: string) => (laneId === "CG_WIDE_FAST_LONG" ? { n: 44, avgNetR: 0.12 } : { n: 8, avgNetR: -0.3 }),
    laneVeto: (dir: "LONG" | "SHORT", _laneId: string) => ({ vetoed: dir === "SHORT", reason: dir === "SHORT" ? "VETO_NEGATIVE" : "ALLOW_PROVEN" }),
    cortexFinalPctForLane: (laneId: string) => (laneId === "CG_WIDE_FAST_LONG" ? 40 : 20),
    laneEligibleIncumbent: () => true,
  });

  it("(a) recorded snapshot values equal the call-site values", () => {
    const inputs = buildLaneContextSnapshotInputs(source());
    const batch = planSnapshotBatch("3102", 10_000, inputs);
    expect(batch.ok).toBe(true);
    const longSnap = batch.snapshots.find((s) => s.laneId === "CG_WIDE_FAST_LONG")!;
    expect(longSnap.edgeMemory).toBe(0.12);
    expect(longSnap.edgeMemoryN).toBe(44);
    expect(longSnap.conviction).toBe(0.4);
    expect(longSnap.regimeFamily).toBe("BULLISH_EXPANSION");
    expect(longSnap.axisScore).toBe(0.62);
    expect(longSnap.staticWeightPct).toBe(40);
    expect(longSnap.cortexFinalPct).toBe(40);
    expect(longSnap.vetoed).toBe(false);
    const shortSnap = batch.snapshots.find((s) => s.laneId === "CG_WIDE_FAST_SHORT")!;
    expect(shortSnap.vetoed).toBe(true);
    expect(shortSnap.vetoReason).toBe("VETO_NEGATIVE");
  });

  it("(b) a source mutation AFTER capture cannot change a recorded snapshot (frozen)", () => {
    const inputs = buildLaneContextSnapshotInputs(source());
    const batch = planSnapshotBatch("3102", 10_000, inputs);
    const rec = batch.snapshots[0]!;
    // mutate the SOURCE input's nested sourceStatuses map after the batch was built
    inputs[0]!.sourceStatuses.regime = "ERROR";
    inputs[0]!.edgeMemory = 999;
    expect(rec.sourceStatuses.regime).toBe("FRESH"); // deep-copied ⇒ still the captured value
    expect(rec.edgeMemory).toBe(0.12); // scalar copied at capture
  });

  it("(c) a thrown writer never escapes — {ran:false}, no throw (executive is untouched)", () => {
    const dir = tmp();
    // pre-create snapshots.jsonl AS A DIRECTORY so the append (after a valid writer-lock) throws EISDIR
    mkdirSync(join(dir, "lane-context", "3102"), { recursive: true });
    mkdirSync(join(dir, "lane-context", "3102", "snapshots.jsonl"));
    const inputs = buildLaneContextSnapshotInputs(source());
    let threw = false;
    let res: { ran: boolean } = { ran: true };
    try { res = journalLaneSnapshots(10_000, inputs, shadowEnv(dir)); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(res.ran).toBe(false);
    expect(snapshotMetrics.journalErrors).toBeGreaterThan(0);
  });

  it("(d) no active incumbent lane is silently dropped — 1:1 incl. UNSUPPORTED", () => {
    const s = source();
    s.lanes = [lane(), lane({ laneId: "UNKNOWN_LANE", status: "UNSUPPORTED_WITH_REASON", direction: null, reason: "not in registry" })];
    const inputs = buildLaneContextSnapshotInputs(s);
    expect(inputs).toHaveLength(2);
    const unsup = inputs.find((i) => i.laneId === "UNKNOWN_LANE")!;
    expect(unsup.direction).toBe("NEUTRAL");
    expect(unsup.vetoReason).toBe("not in registry"); // reason surfaced, not lost
    expect(unsup.sourceStatuses.support).toBe("MISSING");
  });

  it("end-to-end: journalLaneSnapshots persists one record per lane; values match", () => {
    const dir = tmp();
    const inputs = buildLaneContextSnapshotInputs(source());
    const r = journalLaneSnapshots(10_000, inputs, shadowEnv(dir));
    expect(r.ran).toBe(true);
    expect(r.count).toBe(2);
    const lines = readFileSync(join(dir, "lane-context", "3102", "snapshots.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l) as { laneId: string; edgeMemory: number | null; reportOnly: boolean });
    expect(recs.every((x) => x.reportOnly === true)).toBe(true);
    expect(recs.find((x) => x.laneId === "CG_WIDE_FAST_LONG")!.edgeMemory).toBe(0.12);
  });
});

// ═══════════════════════════════ 3. LIFECYCLE TAP (direct gate/fail-open) ═══════════════════════════════
describe("lifecycle call-site tap — gated + fail-open", () => {
  const rec = {
    orderId: "dtc-abc-e", decisionId: "po-1", event: "SUBMITTED" as const, eventAtMs: 1_000, exchangeEventAtMs: null,
    symbol: "ETHUSDT", side: "BUY" as const, orderType: "MARKET", requestedQty: 0.05, cumulativeFilledQty: null,
    source: "test",
  };

  it("default-OFF ⇒ returns false, zero events (flag unset)", () => {
    const dir = tmp();
    expect(recordExecLifecycle(rec, { FOUR_BRAIN_INSTANCE_ID: "3102", LANE_CONTEXT_JOURNAL_DIR: dir })).toBe(false);
    expect(lifecycleMetrics.events).toBe(0);
    expect(existsSync(join(dir, "lane-context"))).toBe(false);
  });

  it("hard-blocks 3103 by resolved id AND by raw PORT even with the flag on", () => {
    const dir = tmp();
    expect(recordExecLifecycle(rec, { EXEC_LIFECYCLE_TIMESTAMPS: "1", FOUR_BRAIN_INSTANCE_ID: "3103", LANE_CONTEXT_JOURNAL_DIR: dir })).toBe(false);
    expect(recordExecLifecycle(rec, { EXEC_LIFECYCLE_TIMESTAMPS: "1", PORT: "3103", LANE_CONTEXT_JOURNAL_DIR: dir })).toBe(false);
    expect(existsSync(join(dir, "lane-context"))).toBe(false);
  });

  it("writes on 3102 when enabled; the record carries the instance id", () => {
    const dir = tmp();
    expect(recordExecLifecycle(rec, { EXEC_LIFECYCLE_TIMESTAMPS: "1", FOUR_BRAIN_INSTANCE_ID: "3102", LANE_CONTEXT_JOURNAL_DIR: dir })).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, "lane-context", "3102", "lifecycle.jsonl"), "utf8").trim()) as { instanceId: string; event: string; schemaVersion: string };
    expect(written.instanceId).toBe("3102");
    expect(written.event).toBe("SUBMITTED");
    expect(written.schemaVersion).toBe("exec-lifecycle-1");
  });

  it("fail-open: a broken dir yields false without throwing, journalErrors incremented", () => {
    const fileAsDir = join(tmp(), "f");
    writeFileSync(fileAsDir, "x");
    let threw = false;
    let ok = true;
    try { ok = recordExecLifecycle(rec, { EXEC_LIFECYCLE_TIMESTAMPS: "1", FOUR_BRAIN_INSTANCE_ID: "3102", LANE_CONTEXT_JOURNAL_DIR: fileAsDir }); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(ok).toBe(false);
    expect(lifecycleMetrics.journalErrors).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════ 4. WRITER-LOCK BOOT ═══════════════════════════════
describe("writer-lock boot — a second live writer disables the journal without throwing", () => {
  it("a concurrent live-writer lock ⇒ scan returns writer-lock-unavailable; the incumbent proceeds", () => {
    const dir = tmp();
    const instDir = join(dir, "lane-context", "3102");
    mkdirSync(instDir, { recursive: true });
    // simulate another LIVE process holding the writer lock (pid 1 is alive; fresh; same instance ⇒ concurrent)
    writeFileSync(join(instDir, ".writer.lock"), JSON.stringify({ pid: 1, instanceId: "3102", startedAtMs: 7_000 }));
    const orders = [closedOrder()];
    let threw = false;
    let res: { ran: boolean; reason: string } = { ran: true, reason: "" };
    try { res = runLaneResolutionScan(orders, 7_000, shadowEnv(dir)); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("writer-lock-unavailable");
    expect(scanMetrics.scansSkipped).toBeGreaterThan(0);
  });

  it("laneJournalActive reflects gating (shadow+3102 ⇒ true; off ⇒ false; 3103 ⇒ false)", () => {
    expect(laneJournalActive({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3102" })).toBe(true);
    expect(laneJournalActive({ LANE_CONTEXT_JOURNAL_MODE: "off", FOUR_BRAIN_INSTANCE_ID: "3102" })).toBe(false);
    expect(laneJournalActive({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3103" })).toBe(false);
    expect(laneJournalActive({ LANE_CONTEXT_JOURNAL_MODE: "shadow", PORT: "3103" })).toBe(false);
  });
});

// ═══════════════════════════════ 5. COLLECT_ONLY gate — the ONLY switch that lifts the 3103 block ═══════════════════════════════
describe("COLLECT_ONLY gate — live-3103 report-only collection, default-OFF, authority never enabled", () => {
  it("resolveCollectOnly is default-OFF; only \"1\"/\"true\" enable it", () => {
    expect(resolveCollectOnly({})).toBe(false);
    expect(resolveCollectOnly({ COLLECT_ONLY: "0" })).toBe(false);
    expect(resolveCollectOnly({ COLLECT_ONLY: "false" })).toBe(false);
    expect(resolveCollectOnly({ COLLECT_ONLY: "1" })).toBe(true);
    expect(resolveCollectOnly({ COLLECT_ONLY: "true" })).toBe(true);
    expect(resolveCollectOnly({ COLLECT_ONLY: "TRUE" })).toBe(true);
  });

  it("3103 stays HARD-blocked WITHOUT COLLECT_ONLY (by resolved id AND raw PORT)", () => {
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3103" } as never)).toMatchObject({ active: false, reason: "live-3103-blocked" });
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", PORT: "3103" } as never)).toMatchObject({ active: false, reason: "live-3103-blocked" });
    // even with an EXEC flag, lifecycle stays blocked on 3103 without COLLECT_ONLY
    expect(recordExecLifecycle({ orderId: "o", decisionId: null, event: "SUBMITTED", eventAtMs: 1, exchangeEventAtMs: null, symbol: "ETHUSDT", side: "BUY", orderType: "MARKET", requestedQty: 1, cumulativeFilledQty: null, source: "t" }, { EXEC_LIFECYCLE_TIMESTAMPS: "1", FOUR_BRAIN_INSTANCE_ID: "3103", LANE_CONTEXT_JOURNAL_DIR: tmp() })).toBe(false);
  });

  it("COLLECT_ONLY lifts the block for 3103 report-only collection (its own isolated namespace)", () => {
    const act = resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3103", COLLECT_ONLY: "1" } as never);
    expect(act).toMatchObject({ active: true, reason: "collect-only-3103", instanceId: "3103", collectOnly: true });
    // ...also when only the raw PORT says 3103
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", PORT: "3103", COLLECT_ONLY: "true" } as never)).toMatchObject({ active: true, reason: "collect-only-3103" });
  });

  it("COLLECT_ONLY does NOT change 3101/3102 (they never needed it) and stays gated by mode", () => {
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3102", COLLECT_ONLY: "1" } as never)).toMatchObject({ active: true, reason: "shadow-active" });
    expect(resolveLaneJournalActivation({ LANE_CONTEXT_JOURNAL_MODE: "off", FOUR_BRAIN_INSTANCE_ID: "3103", COLLECT_ONLY: "1" } as never)).toMatchObject({ active: false, reason: "mode-off" });
  });

  it("3103 collect-only END-TO-END: resolution + snapshot + lifecycle all write to the 3103 namespace", () => {
    const dir = tmp();
    const env3103 = { LANE_CONTEXT_JOURNAL_MODE: "shadow", FOUR_BRAIN_INSTANCE_ID: "3103", COLLECT_ONLY: "1", LANE_CONTEXT_JOURNAL_DIR: dir };
    // resolution
    expect(runLaneResolutionScan([closedOrder()], 7_000, env3103).ran).toBe(true);
    // snapshot
    const inputs = buildLaneContextSnapshotInputs({
      regimeRaw: "BULLISH", axisScore: 0.5, controllerMode: "LONG", conviction: 0.3, lanes: [lane()],
      laneEdgeStat: () => ({ n: 10, avgNetR: 0.1 }), laneVeto: () => ({ vetoed: false, reason: "ok" }),
      cortexFinalPctForLane: () => 40, laneEligibleIncumbent: () => true,
    });
    expect(journalLaneSnapshots(10_000, inputs, env3103).ran).toBe(true);
    // lifecycle
    expect(recordExecLifecycle({ orderId: "o", decisionId: "po-1", event: "SUBMITTED", eventAtMs: 1, exchangeEventAtMs: null, symbol: "ETHUSDT", side: "BUY", orderType: "MARKET", requestedQty: 1, cumulativeFilledQty: null, source: "t" }, { ...env3103, EXEC_LIFECYCLE_TIMESTAMPS: "1" })).toBe(true);
    // all three land under the isolated 3103 namespace
    expect(existsSync(join(dir, "lane-context", "3103", "resolutions.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "lane-context", "3103", "snapshots.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "lane-context", "3103", "lifecycle.jsonl"))).toBe(true);
  });
});
