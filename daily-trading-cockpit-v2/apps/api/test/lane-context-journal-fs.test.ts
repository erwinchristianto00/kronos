import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionJournalFs } from "../src/lib/lane-context-journal-fs.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lane-fs-"));
const resolvedAtMsOf = (line: string): number | null => { try { const v = (JSON.parse(line) as { resolvedAtMs?: number }).resolvedAtMs; return typeof v === "number" ? v : null; } catch { return null; } };

describe("production JournalFs — atomic writes, append, tail", () => {
  it("writeAtomic commits via tmp+rename and leaves no tmp behind", () => {
    const dir = tmp(); const { fs } = createProductionJournalFs();
    const p = join(dir, "ckpt.json");
    fs.writeAtomic(p, JSON.stringify({ a: 1 }));
    expect(JSON.parse(fs.readText(p)!).a).toBe(1);
    expect(readdirSync(dir).some((f) => f.includes(".tmp."))).toBe(false); // no temp leftover
  });
  it("appendLines is append-only JSONL; readTailLines returns the bounded newest tail", () => {
    const dir = tmp(); const { fs } = createProductionJournalFs();
    const p = join(dir, "j.jsonl");
    for (let i = 0; i < 10; i += 1) fs.appendLines(p, [JSON.stringify({ i })]);
    const tail = fs.readTailLines(p, 3);
    expect(tail).toHaveLength(3);
    expect(JSON.parse(tail[2]!).i).toBe(9); // newest
  });
});

describe("production JournalFs — rotation + recovery + coverage-safe prune", () => {
  it("rotation moves the active file to a segment; tail recovery still spans segments", () => {
    const dir = tmp(); const { fs, stats } = createProductionJournalFs();
    const p = join(dir, "j.jsonl");
    fs.appendLines(p, [JSON.stringify({ resolvedAtMs: 1 }), JSON.stringify({ resolvedAtMs: 2 })]);
    fs.rotateIfNeeded(p, 1); // tiny maxBytes ⇒ rotate
    expect(stats.rotations).toBe(1);
    expect(existsSync(`${p}.1`)).toBe(true); // segment created
    fs.appendLines(p, [JSON.stringify({ resolvedAtMs: 3 })]); // new active
    const tail = fs.readTailLines(p, 10);
    expect(tail.map(resolvedAtMsOf)).toEqual([1, 2, 3]); // recovery spans segment + active, chronological
  });
  it("pruneCoveredSegments deletes ONLY segments fully covered by the watermark; retains newer evidence", () => {
    const dir = tmp(); const { fs } = createProductionJournalFs();
    const p = join(dir, "j.jsonl");
    // segment .1 (old: resolvedAtMs 10,20), segment .2 (recent: 100,110), active (200)
    writeFileSync(`${p}.1`, `${JSON.stringify({ resolvedAtMs: 10 })}\n${JSON.stringify({ resolvedAtMs: 20 })}\n`);
    writeFileSync(`${p}.2`, `${JSON.stringify({ resolvedAtMs: 100 })}\n${JSON.stringify({ resolvedAtMs: 110 })}\n`);
    fs.appendLines(p, [JSON.stringify({ resolvedAtMs: 200 })]);
    const deleted = fs.pruneCoveredSegments!(p, 50, resolvedAtMsOf); // safe-before=50: seg.1(max20)<50 delete; seg.2(max110)≥50 retain
    expect(deleted).toBe(1);
    expect(existsSync(`${p}.1`)).toBe(false);
    expect(existsSync(`${p}.2`)).toBe(true); // recovery evidence NOT covered by checkpoint is retained
  });
  it("prune STOPS at the first uncovered segment (never deletes past an uncovered one)", () => {
    const dir = tmp(); const { fs } = createProductionJournalFs();
    const p = join(dir, "j.jsonl");
    writeFileSync(`${p}.1`, `${JSON.stringify({ resolvedAtMs: 500 })}\n`); // uncovered
    writeFileSync(`${p}.2`, `${JSON.stringify({ resolvedAtMs: 5 })}\n`); // would be covered, but is NEWER seq
    // oldest-first is seq order: .1 (500) then .2 (5). .1 uncovered ⇒ stop immediately.
    expect(fs.pruneCoveredSegments!(p, 50, resolvedAtMsOf)).toBe(0);
    expect(existsSync(`${p}.1`)).toBe(true);
  });
  it("REGRESSION (finding 4): prune uses the segment's MAX resolvedAtMs, not its LAST line", () => {
    const dir = tmp(); const { fs } = createProductionJournalFs();
    const p = join(dir, "j.jsonl");
    // last line is SMALL (10) but an EARLIER line is LARGE (999); records are not guaranteed sorted in a segment.
    writeFileSync(`${p}.1`, `${JSON.stringify({ resolvedAtMs: 999 })}\n${JSON.stringify({ resolvedAtMs: 10 })}\n`);
    expect(fs.pruneCoveredSegments!(p, 50, resolvedAtMsOf)).toBe(0); // max 999 ≥ 50 ⇒ RETAINED (last-line-only would wrongly delete)
    expect(existsSync(`${p}.1`)).toBe(true);
  });
});

describe("production JournalFs — writer lock + stale temp", () => {
  it("acquires the writer lock; a DIFFERENT live pid is detected as concurrent (surfaced, not raced)", () => {
    const dir = tmp(); const prod = createProductionJournalFs(); prod.fs.ensureDir(dir);
    const first = prod.acquireWriterLock(dir, "3102", 1000);
    expect(first.acquired).toBe(true);
    // simulate another LIVE writer holding the lock (use this test process's own live pid ≠ ... use pid 1 which is alive)
    writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: 1, instanceId: "3102", startedAtMs: 1 }));
    const second = prod.acquireWriterLock(dir, "3102", 2000);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe("concurrent-writer-detected");
  });
  it("a stale lock from a DEAD pid is reclaimable", () => {
    const dir = tmp(); const prod = createProductionJournalFs(); prod.fs.ensureDir(dir);
    writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: 2147483646, instanceId: "3102", startedAtMs: 1 })); // improbable dead pid
    expect(prod.acquireWriterLock(dir, "3102", 1000).acquired).toBe(true);
  });
  it("REGRESSION (finding 5): an OLD lock beyond maxAge (PID-reuse) is reclaimable; a foreign-instance lock is stale", () => {
    const dir = tmp(); const prod = createProductionJournalFs(); prod.fs.ensureDir(dir);
    const TEN_H = 10 * 3_600_000;
    // pid 1 is alive, but the lock is ANCIENT (older than the 1h maxAge) ⇒ PID must have been reused, not concurrent.
    writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: 1, instanceId: "3102", startedAtMs: 0 }));
    expect(prod.acquireWriterLock(dir, "3102", TEN_H).acquired).toBe(true);
    // a FRESH live-pid lock recorded for a DIFFERENT instance in our dir is stale (foreign), reclaimable.
    writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: 1, instanceId: "3101", startedAtMs: TEN_H }));
    expect(prod.acquireWriterLock(dir, "3102", TEN_H + 1).acquired).toBe(true);
  });
  it("cleanupStaleTemp removes leftover .tmp checkpoint files on startup", () => {
    const dir = tmp(); const prod = createProductionJournalFs(); prod.fs.ensureDir(dir);
    writeFileSync(join(dir, "ckpt.json.tmp.999.1"), "partial");
    writeFileSync(join(dir, "ckpt.json"), "committed");
    expect(prod.cleanupStaleTemp(dir)).toBe(1);
    expect(existsSync(join(dir, "ckpt.json.tmp.999.1"))).toBe(false);
    expect(readFileSync(join(dir, "ckpt.json"), "utf8")).toBe("committed"); // committed state untouched
  });
});
