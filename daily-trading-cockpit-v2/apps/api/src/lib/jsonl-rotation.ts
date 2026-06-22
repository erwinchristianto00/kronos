/**
 * JSONL FILE ROTATION HELPER (REPORT-ONLY UTILITY)
 *
 * Safely rotates an append-only JSONL file when it exceeds a size threshold.
 * Designed primarily for scan-history.jsonl and scan-history-raw.jsonl which
 * have grown to ~500MB and broken Node's string-size limit on read.
 *
 * STREAMING / CHUNKED READ (CRITICAL):
 *   Uses a backward chunk reader (read fixed-size chunks from the end of the
 *   file with a file descriptor) to capture the last N lines without ever
 *   loading the full file as a single string. The retained tail is also capped
 *   by bytes because scan-history lines can be large enough that "last N lines"
 *   still exceeds the rotation threshold and re-triggers rotation every scan.
 *
 * NEVER THROWS — returns RotationResult with `error` field on failure so
 * callers (tracker.persistScan, etc.) can safely ignore rotation failures.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, resolve } from "node:path";

/**
 * Delete old archives so the archive dir cannot grow unbounded. scan-history*
 * rotates ~every scan (~100MB each); without pruning the archive dir grew ~1GB/h
 * and would fill a VPS disk in ~a day. Keeps the newest `keep` archives for this
 * base (env SCAN_HISTORY_ARCHIVE_KEEP, default 3) and unlinks the rest. Never throws.
 */
function pruneArchives(archiveDir: string, base: string, keep: number): void {
  try {
    const prefix = `${base}.`;
    const files = readdirSync(archiveDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
      .sort(); // names embed an ISO timestamp → lexical sort == chronological
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try {
        unlinkSync(resolve(archiveDir, f));
      } catch {
        // best-effort; never block rotation
      }
    }
  } catch {
    // archive dir unreadable — ignore
  }
}

export interface RotationOptions {
  /** Default 100MB. Files smaller than this are not rotated. */
  thresholdBytes?: number;
  /** Default 10000. Last N lines of the source file are retained. */
  tailLines?: number;
  /** Default 25MB. Retained tail is capped by bytes, not just line count. */
  tailBytes?: number;
  /** Default <dirname>/archive */
  archiveDir?: string;
  /** Chunk size used by the backward chunked reader. Default 1MB. */
  readChunkSize?: number;
}

export interface RotationResult {
  rotated: boolean;
  reason: string;
  fromSize?: number;
  toSize?: number;
  archivePath?: string;
  linesKept?: number;
  error?: string;
}

const DEFAULT_THRESHOLD_BYTES = 100 * 1024 * 1024;
const DEFAULT_TAIL_LINES = 10_000;
const DEFAULT_TAIL_BYTES = 25 * 1024 * 1024;
const DEFAULT_READ_CHUNK_SIZE = 1024 * 1024;

function safeIsoForFilename(): string {
  // ISO 8601 with colons replaced for filename safety on all OSes.
  return new Date().toISOString().replace(/[:]/g, "-");
}

/**
 * Read the last `tailLines` non-empty lines of a file using a backward
 * chunked reader. Never loads the full file as a single string.
 */
function readTailLinesSync(filePath: string, tailLines: number, tailBytes: number, chunkSize: number): string[] {
  if (tailLines <= 0 || tailBytes <= 0) return [];
  const fd = openSync(filePath, "r");
  try {
    const size = statSync(filePath).size;
    if (size === 0) return [];
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = size;
    let leftover = "";
    const collected: string[] = [];
    let collectedBytes = 0;
    let byteLimitReached = false;
    const pushLine = (line: string): void => {
      if (byteLimitReached || line.length === 0) return;
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      if (collected.length > 0 && collectedBytes + lineBytes > tailBytes) {
        byteLimitReached = true;
        return;
      }
      collected.push(line);
      collectedBytes += lineBytes;
      if (collected.length >= tailLines || collectedBytes >= tailBytes) {
        byteLimitReached = true;
      }
    };
    while (pos > 0 && collected.length < tailLines && !byteLimitReached) {
      const toRead = Math.min(chunkSize, pos);
      pos -= toRead;
      const bytes = readSync(fd, buf, 0, toRead, pos);
      if (bytes <= 0) break;
      // Decode this chunk. Prepend the leftover from the previous (earlier-in-file)
      // chunk so that lines split across the chunk boundary are reassembled.
      const chunkStr = buf.slice(0, bytes).toString("utf-8") + leftover;
      const lines = chunkStr.split("\n");
      // The first element is potentially incomplete — it may continue further
      // back in the file. Save it as the leftover for the next iteration.
      leftover = lines.shift() ?? "";
      // Walk lines back-to-front so we collect newest first.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        pushLine(line);
        if (byteLimitReached) break;
      }
    }
    // If we still have room AND there's a leftover at the start, include it.
    if (collected.length < tailLines && leftover.length > 0 && !byteLimitReached) {
      pushLine(leftover);
    }
    // collected is newest-first; reverse so we return oldest-first like the source.
    return collected.reverse();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Safely rotate a JSONL file if it exceeds threshold.
 *
 * Algorithm:
 *  1. If file doesn't exist → FILE_NOT_FOUND
 *  2. If size < threshold → BELOW_THRESHOLD
 *  3. Build archive path under archiveDir (default <dirname>/archive)
 *  4. Read last N lines via chunked backward reader (no full read)
 *  5. Rename original to archive path
 *  6. Write tail back to original path
 *
 * Never throws; on failure returns a RotationResult with error field.
 */
export function rotateJsonlIfNeeded(
  filePath: string,
  opts: RotationOptions = {},
): RotationResult {
  const thresholdBytes = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const readChunkSize = opts.readChunkSize ?? DEFAULT_READ_CHUNK_SIZE;
  try {
    if (!existsSync(filePath)) {
      return { rotated: false, reason: "FILE_NOT_FOUND" };
    }

    let stat;
    try {
      stat = statSync(filePath);
    } catch (err) {
      return {
        rotated: false,
        reason: "STAT_FAILED",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (stat.size < thresholdBytes) {
      const dir = dirname(filePath);
      const base = basename(filePath);
      const archiveDir = opts.archiveDir ?? resolve(dir, "archive");
      pruneArchives(archiveDir, base, Number(process.env.SCAN_HISTORY_ARCHIVE_KEEP) || 3);
      return { rotated: false, reason: "BELOW_THRESHOLD", fromSize: stat.size };
    }

    const dir = dirname(filePath);
    const base = basename(filePath);
    const archiveDir = opts.archiveDir ?? resolve(dir, "archive");
    const archivePath = resolve(archiveDir, `${base}.${safeIsoForFilename()}.jsonl`);

    try {
      mkdirSync(archiveDir, { recursive: true });
    } catch (err) {
      return {
        rotated: false,
        reason: "MKDIR_FAILED",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let tail: string[];
    try {
      tail = readTailLinesSync(filePath, tailLines, tailBytes, readChunkSize);
    } catch (err) {
      return {
        rotated: false,
        reason: "TAIL_READ_FAILED",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      renameSync(filePath, archivePath);
    } catch (err) {
      return {
        rotated: false,
        reason: "RENAME_FAILED",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Bound the archive dir — without this it grows unbounded (~1GB/h) and fills disk.
    pruneArchives(archiveDir, base, Number(process.env.SCAN_HISTORY_ARCHIVE_KEEP) || 3);

    const tailContent = tail.length > 0 ? tail.join("\n") + "\n" : "";
    try {
      writeFileSync(filePath, tailContent, "utf-8");
    } catch (err) {
      return {
        rotated: false,
        reason: "TAIL_WRITE_FAILED",
        archivePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let toSize = 0;
    try {
      toSize = statSync(filePath).size;
    } catch {
      // ignore
    }

    return {
      rotated: true,
      reason: "ROTATED",
      fromSize: stat.size,
      toSize,
      archivePath,
      linesKept: tail.length,
    };
  } catch (err) {
    return {
      rotated: false,
      reason: "ROTATION_FAILED",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
