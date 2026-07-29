/** Persisted, immutable market-context lineage for Four-Brain review records. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { MarketContextLineage } from "./authority-contract.js";

export interface MarketContextSnapshotRecord extends MarketContextLineage {
  marketContextSnapshotId: string;
  instanceId: string;
  capturedAtMs: number;
}

interface MarketContextSnapshotState {
  version: 1;
  records: MarketContextSnapshotRecord[];
}

const MAX_RECORDS = 5_000;
const empty = (): MarketContextSnapshotState => ({ version: 1, records: [] });

function validRecord(value: MarketContextSnapshotRecord): boolean {
  return typeof value.marketContextSnapshotId === "string" && value.marketContextSnapshotId.length > 0
    && typeof value.instanceId === "string" && value.instanceId.length > 0
    && typeof value.decisionPipelinePolicyVersion === "string" && value.decisionPipelinePolicyVersion.length > 0
    && Number.isFinite(value.asOfMs) && Number.isFinite(value.sourceCutoffMs)
    && Number.isFinite(value.capturedAtMs)
    && (value.sourceCutoffMs as number) <= value.asOfMs;
}

/**
 * This store intentionally holds only source lineage, not mutable market values. The snapshot ID is
 * deterministic from the exact source cutoff and policy stamp, so a restart cannot mint a new owner.
 */
export class MarketContextSnapshotStore {
  private state: MarketContextSnapshotState = empty();
  private readonly file: string;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "market-context-snapshots.json");
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<MarketContextSnapshotState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
      this.state = { version: 1, records: parsed.records.filter(validRecord).slice(-MAX_RECORDS) };
    } catch {
      this.state = empty();
    }
  }

  capture(input: {
    instanceId: string;
    asOfMs: number;
    sourceCutoffMs: number;
    decisionPipelinePolicyVersion: string;
  }): MarketContextLineage | null {
    if (
      !input.instanceId ||
      !input.decisionPipelinePolicyVersion ||
      !Number.isFinite(input.asOfMs) ||
      !Number.isFinite(input.sourceCutoffMs) ||
      input.sourceCutoffMs > input.asOfMs
    ) return null;
    const marketContextSnapshotId = [
      "market-context",
      input.instanceId,
      Math.trunc(input.sourceCutoffMs),
      input.decisionPipelinePolicyVersion,
    ].join(":");
    const existing = this.state.records.find((record) => record.marketContextSnapshotId === marketContextSnapshotId);
    if (!existing) {
      const record: MarketContextSnapshotRecord = {
        marketContextSnapshotId,
        instanceId: input.instanceId,
        asOfMs: input.asOfMs,
        sourceCutoffMs: input.sourceCutoffMs,
        decisionPipelinePolicyVersion: input.decisionPipelinePolicyVersion,
        capturedAtMs: input.asOfMs,
      };
      const previous = this.state;
      this.state = { version: 1, records: [...previous.records, record].slice(-MAX_RECORDS) };
      if (!this.save()) {
        this.state = previous;
        return null;
      }
    }
    return {
      marketContextSnapshotId,
      asOfMs: input.asOfMs,
      sourceCutoffMs: input.sourceCutoffMs,
      decisionPipelinePolicyVersion: input.decisionPipelinePolicyVersion,
    };
  }

  get(): Readonly<MarketContextSnapshotState> {
    return this.state;
  }

  private save(): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch {
      // A lineage snapshot cannot be treated as persisted if its atomic write failed.
      return false;
    }
  }
}
