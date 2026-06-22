import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { rotateJsonlIfNeeded } from "../src/lib/jsonl-rotation.js";

const tempDirs: string[] = [];

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "jsonl-rot-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("rotateJsonlIfNeeded", () => {
  it("archives file when above threshold and keeps tail N lines", () => {
    const dir = mkTmp();
    const file = join(dir, "scan-history.jsonl");
    // Build a file with 50 lines, each ~100 bytes.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ id: i, payload: "x".repeat(80) }));
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    const sizeBefore = statSync(file).size;
    expect(sizeBefore).toBeGreaterThan(0);

    const result = rotateJsonlIfNeeded(file, {
      thresholdBytes: 100,
      tailLines: 10,
    });
    expect(result.rotated).toBe(true);
    expect(result.linesKept).toBe(10);
    expect(result.archivePath).toBeDefined();
    expect(result.fromSize).toBe(sizeBefore);

    // Original file now has only the last 10 lines.
    const after = readFileSync(file, "utf-8").trim().split("\n");
    expect(after).toHaveLength(10);
    const lastParsed = JSON.parse(after.at(-1)!);
    expect(lastParsed.id).toBe(49);
    const firstKept = JSON.parse(after[0]!);
    expect(firstKept.id).toBe(40);

    // Archive file should exist.
    expect(existsSync(result.archivePath!)).toBe(true);
  });

  it("caps retained tail by bytes so large JSONL lines do not keep re-triggering rotation", () => {
    const dir = mkTmp();
    const file = join(dir, "scan-history.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      lines.push(JSON.stringify({ id: i, payload: "x".repeat(2048) }));
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");

    const result = rotateJsonlIfNeeded(file, {
      thresholdBytes: 10 * 1024,
      tailLines: 80,
      tailBytes: 12 * 1024,
    });

    expect(result.rotated).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(13 * 1024);
    const kept = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { id: number });
    expect(kept.at(-1)?.id).toBe(79);
    expect(kept.length).toBeLessThan(80);
  });

  it("drops an oversize tail line instead of rewriting a file above the byte cap", () => {
    const dir = mkTmp();
    const file = join(dir, "scan-history.jsonl");
    writeFileSync(file, `${JSON.stringify({ id: "small", payload: "ok" })}\n${"x".repeat(64 * 1024)}\n`, "utf-8");

    const result = rotateJsonlIfNeeded(file, {
      thresholdBytes: 1024,
      tailLines: 10,
      tailBytes: 4 * 1024,
    });

    expect(result.rotated).toBe(true);
    expect(result.linesKept).toBe(0);
    expect(statSync(file).size).toBe(0);
  });

  it("prunes old archives on rotation, keeping only the newest N", () => {
    const dir = mkTmp();
    const archiveDir = join(dir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    // Pre-seed 5 old archives with sortable (chronological) timestamp names.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(archiveDir, `scan-history.jsonl.2026-06-1${i}T00-00-00-000Z.jsonl`), "old\n");
    }
    process.env.SCAN_HISTORY_ARCHIVE_KEEP = "3";
    const file = join(dir, "scan-history.jsonl");
    writeFileSync(file, "x".repeat(2000) + "\n", "utf-8");
    const result = rotateJsonlIfNeeded(file, { thresholdBytes: 100, tailLines: 5 });
    expect(result.rotated).toBe(true);
    const archives = readdirSync(archiveDir).filter(
      (f) => f.startsWith("scan-history.jsonl.") && f.endsWith(".jsonl"),
    );
    expect(archives.length).toBe(3); // 5 old + 1 new = 6 → pruned to newest 3
    delete process.env.SCAN_HISTORY_ARCHIVE_KEEP;
  });

  it("returns BELOW_THRESHOLD when file is small", () => {
    const dir = mkTmp();
    const file = join(dir, "small.jsonl");
    writeFileSync(file, "tiny\n", "utf-8");
    const result = rotateJsonlIfNeeded(file, { thresholdBytes: 1024 * 1024 });
    expect(result.rotated).toBe(false);
    expect(result.reason).toBe("BELOW_THRESHOLD");
  });

  it("still prunes stale archives when active file is below threshold", () => {
    const dir = mkTmp();
    const archiveDir = join(dir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(archiveDir, `scan-history.jsonl.2026-06-1${i}T00-00-00-000Z.jsonl`), "old\n");
    }
    process.env.SCAN_HISTORY_ARCHIVE_KEEP = "2";
    const file = join(dir, "scan-history.jsonl");
    writeFileSync(file, "tiny\n", "utf-8");

    const result = rotateJsonlIfNeeded(file, { thresholdBytes: 1024 * 1024 });

    expect(result.rotated).toBe(false);
    const archives = readdirSync(archiveDir).filter(
      (f) => f.startsWith("scan-history.jsonl.") && f.endsWith(".jsonl"),
    );
    expect(archives.length).toBe(2);
    delete process.env.SCAN_HISTORY_ARCHIVE_KEEP;
  });

  it("returns FILE_NOT_FOUND when file doesn't exist", () => {
    const dir = mkTmp();
    const file = join(dir, "missing.jsonl");
    const result = rotateJsonlIfNeeded(file);
    expect(result.rotated).toBe(false);
    expect(result.reason).toBe("FILE_NOT_FOUND");
  });

  it("never throws on rotation failure (mock permission error)", () => {
    const dir = mkTmp();
    const file = join(dir, "doomed.jsonl");
    // create a large enough file to trigger rotation
    writeFileSync(file, "x".repeat(1024) + "\n", "utf-8");
    // Mark the archive target dir as read-only on POSIX; on Windows the
    // rename will succeed but mkdir + write may fail. Either way we just
    // verify no exception escapes.
    const archiveDir = join(dir, "nope");
    if (platform() !== "win32") {
      try {
        chmodSync(dir, 0o500);
      } catch {
        // ignore — best-effort
      }
    }
    expect(() =>
      rotateJsonlIfNeeded(file, {
        thresholdBytes: 100,
        tailLines: 1,
        archiveDir,
      }),
    ).not.toThrow();
    if (platform() !== "win32") {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // ignore — best-effort
      }
    }
  });

  it("archive file ends up in the configured archiveDir", () => {
    const dir = mkTmp();
    const file = join(dir, "history.jsonl");
    const archiveDir = resolve(dir, "custom-archive");
    writeFileSync(file, "a".repeat(2048) + "\n", "utf-8");
    const result = rotateJsonlIfNeeded(file, {
      thresholdBytes: 1024,
      tailLines: 1,
      archiveDir,
    });
    expect(result.rotated).toBe(true);
    expect(result.archivePath?.startsWith(archiveDir)).toBe(true);
    // archive directory should now contain the rotated file
    const entries = readdirSync(archiveDir);
    expect(entries.some((e) => e.startsWith("history.jsonl"))).toBe(true);
  });
});
