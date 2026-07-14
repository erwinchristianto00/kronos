/**
 * Production JournalFs (Track 1, Stage 2). Real filesystem adapter behind the DI'd `JournalFs` interface: JSONL
 * append-only, atomic checkpoint (tmp + rename), bounded rotation into numbered segments, bounded tail recovery
 * across segments, and coverage-safe pruning (a rotated segment is deleted ONLY once the durable checkpoint's
 * watermark fully covers it). Adds a single-writer lock + concurrent-writer detection + stale-temp cleanup.
 *
 * Multi-process assumption (documented + enforced): each instance runs ONE API process (pm2: dtc-api / dtc-api-
 * testnet). JSONL append + tmp-rename is safe under that assumption; the writer lock is belt-and-suspenders that
 * SURFACES a second writer rather than silently racing. All operations throw only for the binding's fail-open
 * boundary to catch — they never touch orders/allocation/beta/kill.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface WriterLockResult { acquired: boolean; holderPid: number | null; reason: string; }
export interface ProductionJournalFs {
  fs: import("./lane-context-journal-binding.js").JournalFs;
  acquireWriterLock(dir: string, instanceId: string, nowMs: number, maxAgeMs?: number): WriterLockResult;
  releaseWriterLock(dir: string): void;
  cleanupStaleTemp(dir: string): number;
  stats: { rotations: number; prunes: number; tailLinesRead: number };
}

const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM = exists, no perm
};
const segmentsOf = (path: string): { file: string; seq: number }[] => {
  const dir = dirname(path); const base = basename(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => { const m = f.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`)); return m ? { file: join(dir, f), seq: Number(m[1]) } : null; })
    .filter((x): x is { file: string; seq: number } => x != null)
    .sort((a, b) => a.seq - b.seq); // oldest (lowest seq) first
};

export function createProductionJournalFs(): ProductionJournalFs {
  const stats = { rotations: 0, prunes: 0, tailLinesRead: 0 };
  const self: ProductionJournalFs = {
    stats,
    fs: {
      ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); },
      readText(path) { return existsSync(path) ? readFileSync(path, "utf8") : null; },
      writeAtomic(path, data) {
        const tmp = `${path}.tmp.${process.pid}.${Math.abs(hashStr(data)) % 1e6}`;
        writeFileSync(tmp, data);
        renameSync(tmp, path); // atomic on the same filesystem
      },
      appendLines(path, lines) { if (lines.length) appendFileSync(path, lines.map((l) => `${l}\n`).join("")); },
      readTailLines(path, maxLines) {
        const out: string[] = [];
        // active first (newest), then segments newest→oldest, until we have maxLines. Bounded: each file ≤ rotation size.
        const files = [path, ...segmentsOf(path).reverse().map((s) => s.file)];
        for (const f of files) {
          if (!existsSync(f)) continue;
          const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
          out.unshift(...lines); // prepend older-file lines before newer already collected? keep chronological
          if (out.length >= maxLines) break;
        }
        const tail = out.slice(-maxLines);
        stats.tailLinesRead += tail.length;
        return tail;
      },
      rotateIfNeeded(path, maxBytes) {
        if (!existsSync(path)) return;
        if (statSync(path).size <= maxBytes) return;
        const next = (segmentsOf(path).at(-1)?.seq ?? 0) + 1;
        renameSync(path, `${path}.${next}`); // active → new segment; active is recreated on the next append
        stats.rotations += 1;
      },
      pruneCoveredSegments(path, safeBeforeResolvedAtMs, resolvedAtMsOf) {
        let deleted = 0;
        for (const seg of segmentsOf(path)) { // oldest first
          const lines = existsSync(seg.file) ? readFileSync(seg.file, "utf8").split("\n").filter((l) => l.trim()) : [];
          // the segment's MAX resolvedAtMs over ALL valid lines (records are NOT guaranteed sorted within a
          // segment) — using the last line's value could under-estimate and delete a segment still in-window.
          let maxResolved: number | null = null;
          for (const l of lines) { const v = resolvedAtMsOf(l); if (v != null && (maxResolved == null || v > maxResolved)) maxResolved = v; }
          if (maxResolved != null && maxResolved < safeBeforeResolvedAtMs) { unlinkSync(seg.file); deleted += 1; stats.prunes += 1; }
          else break; // this segment (and all newer) may still be within the overlap window — RETAIN
        }
        return deleted;
      },
    },
    acquireWriterLock(dir, instanceId, nowMs, maxAgeMs = 3_600_000) {
      const lock = join(dir, ".writer.lock");
      if (existsSync(lock)) {
        try {
          const held = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; instanceId: string; startedAtMs: number };
          // Declare a concurrent writer ONLY if it is a DIFFERENT pid, that pid is alive, its recorded instanceId
          // MATCHES ours (a foreign-instance lock in our own dir is stale, not a concurrent writer), AND the lock is
          // not older than maxAge (guards against PID REUSE — a long-dead pid whose number was recycled).
          const fresh = Number.isFinite(held.startedAtMs) && nowMs - held.startedAtMs <= maxAgeMs;
          if (held.pid !== process.pid && held.instanceId === instanceId && fresh && isProcessAlive(held.pid)) {
            return { acquired: false, holderPid: held.pid, reason: "concurrent-writer-detected" }; // SURFACE, don't race
          }
        } catch { /* corrupt lock — treat as stale, overwrite below */ }
      }
      writeFileSync(lock, JSON.stringify({ pid: process.pid, instanceId, startedAtMs: nowMs }));
      return { acquired: true, holderPid: process.pid, reason: "acquired" };
    },
    releaseWriterLock(dir) { const lock = join(dir, ".writer.lock"); try { if (existsSync(lock)) unlinkSync(lock); } catch { /* fail open */ } },
    cleanupStaleTemp(dir) {
      if (!existsSync(dir)) return 0;
      let n = 0;
      for (const f of readdirSync(dir)) { if (/\.tmp\.\d+\./.test(f)) { try { unlinkSync(join(dir, f)); n += 1; } catch { /* skip */ } } }
      return n; // stale temp checkpoints removed so they can never be mistaken for committed state
    },
  };
  return self;
}

function hashStr(s: string): number { let h = 0; for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }
