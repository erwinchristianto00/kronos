/**
 * DURABLE SNAPSHOT OF THE PENDING OUTCOME LEDGER (2026-07-28, report-only).
 *
 * four-brain-outcome-ledger.ts is in-memory by design and is rebuilt after a restart by replaying
 * `four-brain-decision-journal.jsonl` (+ `.jsonl.1`). Measured on the VPS that day, those two files
 * together span **~2.4 hours** — the journal burns roughly 25 MB/hour, almost all EXECUTIVE_DECISION
 * records. Against HORIZON_MS that is fatal for two of the three horizons:
 *
 *     SCALP     1h   → survives a restart
 *     INTRADAY  4h   → does NOT
 *     SWING    24h   → does NOT
 *
 * The evidence is unambiguous. research/3101 has 254 pm2 restarts and has **never** held a single
 * resolved SWING row; testnet/3102's 431 SWING rows were all decided 25–27 July during one long
 * uptime, the newest is 25h old, and none has resolved since. A SWING decision needs to survive a
 * full day to be worth anything, and nothing here survives an afternoon.
 *
 * So the pending rows get their own file. They are tiny — a handful of primitives each, capped by the
 * ledger's own FIFO — so persisting them costs almost nothing next to the journal they were being
 * recovered from. The journal replay stays exactly as it was and runs AFTER this, as a second source
 * for anything the snapshot missed; callers dedup by passing the restored ids through the rehydrate
 * function's existing `hasProcessed*` predicates.
 *
 * Every function here fails OPEN. A missing, truncated, or garbage file degrades to "restore nothing"
 * and the journal path still runs — losing durability must never cost availability, and a write error
 * must never break the reconciler cycle that triggered it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { FourBrainOutcomeCanonicalRegimeFamily, PendingDirectionRow, PendingEntryRow } from "./four-brain-outcome-ledger.js";

const SNAPSHOT_VERSION = 1;

export interface PendingLedgerSnapshot {
  direction: PendingDirectionRow[];
  entry: PendingEntryRow[];
}

export interface PendingLedgerLoadResult extends PendingLedgerSnapshot {
  /** Why nothing was restored, when nothing was. Null on a clean load — including a clean EMPTY one. */
  skippedReason: string | null;
}

const EMPTY = (reason: string | null): PendingLedgerLoadResult => ({ direction: [], entry: [], skippedReason: reason });

export function pendingLedgerFilePath(dataDir = "data"): string {
  return resolve(dataDir, "four-brain-pending-ledger.json");
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** null and "absent" are the same thing for every optional numeric here — but a non-finite NUMBER is
 *  corruption, not absence, and must not be laundered into a null the resolver treats as "unknown". */
const optNum = (v: unknown): number | null | undefined => (v === null || v === undefined ? null : num(v) ?? undefined);

const HORIZONS = new Set(["SCALP", "INTRADAY", "SWING"]);
const DIRECTION_ACTIONS = new Set(["LONG", "SHORT", "FLAT", "BOTH"]);
const ENTRY_SIDES = new Set(["LONG", "SHORT"]);
const CANONICAL_REGIMES = new Set(["BULLISH", "BEARISH", "MIXED", "UNKNOWN"]);

function optionalLineage(r: Record<string, unknown>): {
  canonicalRegimeFamily?: FourBrainOutcomeCanonicalRegimeFamily | null;
  scannerRegime?: string | null;
  marketContextSnapshotId?: string | null;
} {
  const out: {
    canonicalRegimeFamily?: FourBrainOutcomeCanonicalRegimeFamily | null;
    scannerRegime?: string | null;
    marketContextSnapshotId?: string | null;
  } = {};
  if ("canonicalRegimeFamily" in r) {
    const value = r.canonicalRegimeFamily;
    out.canonicalRegimeFamily = value === null ? null : (str(value) && CANONICAL_REGIMES.has(str(value)!)
      ? str(value)! as FourBrainOutcomeCanonicalRegimeFamily
      : null);
  }
  if ("scannerRegime" in r) out.scannerRegime = str(r.scannerRegime);
  if ("marketContextSnapshotId" in r) out.marketContextSnapshotId = str(r.marketContextSnapshotId);
  return out;
}

function parseDirectionRow(v: unknown): PendingDirectionRow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const decisionId = str(r.decisionId);
  const asOfMs = num(r.asOfMs);
  const horizon = str(r.horizon);
  const action = str(r.action);
  const expectedDirectionalR = optNum(r.expectedDirectionalR);
  if (decisionId === null || asOfMs === null) return null;
  if (horizon === null || !HORIZONS.has(horizon)) return null;
  if (action === null || !DIRECTION_ACTIONS.has(action)) return null;
  if (expectedDirectionalR === undefined) return null;
  return {
    decisionId,
    asOfMs,
    horizon: horizon as PendingDirectionRow["horizon"],
    action: action as PendingDirectionRow["action"],
    expectedDirectionalR,
    ...optionalLineage(r),
  };
}

function parseEntryRow(v: unknown): PendingEntryRow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const decisionId = str(r.decisionId);
  const asOfMs = num(r.asOfMs);
  const side = str(r.side);
  const action = str(r.action);
  if (decisionId === null || asOfMs === null) return null;
  if (side === null || !ENTRY_SIDES.has(side)) return null;
  if (action === null) return null;
  const targetEntry = optNum(r.targetEntry);
  const initialStopPrice = optNum(r.initialStopPrice);
  const expectedNetR = optNum(r.expectedNetR);
  if (targetEntry === undefined || initialStopPrice === undefined || expectedNetR === undefined) return null;
  const row: PendingEntryRow = {
    decisionId,
    asOfMs,
    symbolOrBasketId: str(r.symbolOrBasketId),
    laneId: str(r.laneId),
    side: side as PendingEntryRow["side"],
    action: action as PendingEntryRow["action"],
    targetEntry,
    initialStopPrice,
    expectedNetR,
    ...optionalLineage(r),
  };
  // signalId is optional in the row type (absent on legacy journal rows) — preserve the distinction
  // between "absent" and "explicitly null", because Tier 1 identity matching reads it.
  if ("signalId" in r) row.signalId = str(r.signalId);
  return row;
}

/**
 * Read the snapshot. Rows that fail validation are dropped individually — one corrupt row must not
 * cost the other 2,000 their day of accumulated waiting.
 */
export function loadPendingLedgerSnapshot(dataDir = "data"): PendingLedgerLoadResult {
  const file = pendingLedgerFilePath(dataDir);
  if (!existsSync(file)) return EMPTY(null); // first run — not an error
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return EMPTY("unreadable or malformed JSON");
  }
  if (!parsed || typeof parsed !== "object") return EMPTY("not an object");
  const root = parsed as Record<string, unknown>;
  if (num(root.version) !== SNAPSHOT_VERSION) return EMPTY(`unsupported version ${String(root.version)}`);
  const direction = Array.isArray(root.direction)
    ? root.direction.map(parseDirectionRow).filter((r): r is PendingDirectionRow => r !== null)
    : [];
  const entry = Array.isArray(root.entry)
    ? root.entry.map(parseEntryRow).filter((r): r is PendingEntryRow => r !== null)
    : [];
  return { direction, entry, skippedReason: null };
}

/** Write the snapshot. Never throws: a persistence failure degrades durability, never availability. */
export function savePendingLedgerSnapshot(snapshot: PendingLedgerSnapshot, dataDir = "data"): boolean {
  const file = pendingLedgerFilePath(dataDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a half-file that the next boot would parse
    // as corruption and discard — the whole point of this module is surviving an abrupt restart.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, direction: snapshot.direction, entry: snapshot.entry }));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
