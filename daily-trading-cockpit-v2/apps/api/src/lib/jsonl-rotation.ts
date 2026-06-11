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
 *   loading the full file as a single string. This avoids regression to the
 *   string-size bug we are fixing.
 *
 * NEVER THROWS — returns RotationResult with `error` field on failure so
 * callers (tracker.persistScan, etc.) can safely ignore rotation failures.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, resolve } from "node:path";

export interface RotationOptions {
  /** Default 100MB. Files smaller than this are not rotated. */
  thresholdBytes?: number;
  /** Default 10000. Last N lines of the source file are retained. */
  tailLines?: number;
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
const DEFAULT_READ_CHUNK_SIZE = 1024 * 1024;

function safeIsoForFilename(): string {
  // ISO 8601 with colons replaced for filename safety on all OSes.
  return new Date().toISOString().replace(/[:]/g, "-");
}

/**
 * Read the last `tailLines` non-empty lines of a file using a backward
 * chunked reader. Never loads the full file as a single string.
 */
function readTailLinesSync(filePath: string, tailLines: number, chunkSize: number): string[] {
  if (tailLines <= 0) return [];
  const fd = openSync(filePath, "r");
  try {
    const size = statSync(filePath).size;
    if (size === 0) return [];
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = size;
    let leftover = "";
    const collected: string[] = [];
    while (pos > 0 && collected.length < tailLines) {
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
        if (line.length === 0) continue;
        collected.push(line);
        if (collected.length >= tailLines) break;
      }
    }
    // If we still have room AND there's a leftover at the start, include it.
    if (collected.length < tailLines && leftover.length > 0) {
      collected.push(leftover);
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
      tail = readTailLinesSync(filePath, tailLines, readChunkSize);
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
