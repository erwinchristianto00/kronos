import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";

export const COPY_AUTH_VERSION = "v1";
export const COPY_AUTH_DEFAULT_MAX_SKEW_MS = 60_000;
export const COPY_REPLAY_DEFAULT_TTL_MS = 10 * 60_000;

export interface CopyAuthHeaders {
  timestamp: string;
  nonce: string;
  idempotencyKey: string;
  signature: string;
}

export interface CopyAuditEvent {
  at: string;
  stage: "RELAY" | "RECEIVER";
  outcome: "ACCEPTED" | "REJECTED" | "FAILED" | "IDEMPOTENT_REPLAY";
  reason: string | null;
  requestId: string;
  idempotencyKey: string | null;
  sourcePaperOrderId: string | null;
  symbol: string | null;
  direction: "LONG" | "SHORT" | null;
  payloadSha256: string | null;
  remoteAddress: string | null;
}

interface ReplayState {
  version: 1;
  nonces: Array<{ nonce: string; expiresAtMs: number }>;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
    .join(",")}}`;
}

export function copyPayloadSha256(body: unknown): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

function signingMessage(headers: Omit<CopyAuthHeaders, "signature">, payloadSha256: string): string {
  return [
    COPY_AUTH_VERSION,
    headers.timestamp,
    headers.nonce,
    headers.idempotencyKey,
    payloadSha256,
  ].join("\n");
}

export function signCopyRequest(args: {
  secret: string;
  body: unknown;
  idempotencyKey: string;
  nowMs?: number;
  nonce?: string;
}): CopyAuthHeaders {
  const timestamp = String(Math.floor(args.nowMs ?? Date.now()));
  const nonce = args.nonce ?? randomBytes(18).toString("base64url");
  const unsigned = { timestamp, nonce, idempotencyKey: args.idempotencyKey };
  const signature = createHmac("sha256", args.secret)
    .update(signingMessage(unsigned, copyPayloadSha256(args.body)))
    .digest("hex");
  return { ...unsigned, signature };
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export class CopyReplayGuard {
  private readonly file: string;
  private readonly ttlMs: number;
  private state: ReplayState;

  constructor(dataDir = "data", ttlMs = COPY_REPLAY_DEFAULT_TTL_MS) {
    this.file = resolve(dataDir, "copy-to-live-replay.json");
    this.ttlMs = Math.max(60_000, Math.floor(ttlMs));
    this.state = this.load();
  }

  get path(): string {
    return this.file;
  }

  consume(nonce: string, nowMs = Date.now()): { ok: boolean; reason: string | null } {
    this.state.nonces = this.state.nonces.filter((entry) => entry.expiresAtMs > nowMs);
    if (this.state.nonces.some((entry) => entry.nonce === nonce)) {
      return { ok: false, reason: "replayed nonce" };
    }
    this.state.nonces.push({ nonce, expiresAtMs: nowMs + this.ttlMs });
    if (this.state.nonces.length > 10_000) this.state.nonces = this.state.nonces.slice(-10_000);
    try {
      this.save();
      return { ok: true, reason: null };
    } catch (error) {
      return {
        ok: false,
        reason: `replay ledger unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private load(): ReplayState {
    try {
      if (!existsSync(this.file)) return { version: 1, nonces: [] };
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<ReplayState>;
      return {
        version: 1,
        nonces: Array.isArray(parsed.nonces)
          ? parsed.nonces
              .filter(
                (entry): entry is { nonce: string; expiresAtMs: number } =>
                  !!entry &&
                  typeof entry.nonce === "string" &&
                  Number.isFinite(entry.expiresAtMs),
              )
              .slice(-10_000)
          : [],
      };
    } catch {
      return { version: 1, nonces: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

export function verifyCopyRequest(args: {
  secret: string;
  body: unknown;
  headers: Partial<CopyAuthHeaders>;
  replayGuard: CopyReplayGuard;
  nowMs?: number;
  maxSkewMs?: number;
}): { ok: boolean; reason: string | null; payloadSha256: string } {
  const payloadSha256 = copyPayloadSha256(args.body);
  if (args.secret.length < 32) {
    return { ok: false, reason: "copy auth secret missing or shorter than 32 characters", payloadSha256 };
  }
  const { timestamp, nonce, idempotencyKey, signature } = args.headers;
  if (!timestamp || !nonce || !idempotencyKey || !signature) {
    return { ok: false, reason: "missing copy authentication headers", payloadSha256 };
  }
  const timestampMs = Number(timestamp);
  const nowMs = args.nowMs ?? Date.now();
  const maxSkewMs = Math.max(1_000, args.maxSkewMs ?? COPY_AUTH_DEFAULT_MAX_SKEW_MS);
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: "copy authentication timestamp is stale", payloadSha256 };
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return { ok: false, reason: "invalid copy authentication nonce", payloadSha256 };
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 256) {
    return { ok: false, reason: "invalid copy idempotency key", payloadSha256 };
  }

  const expected = createHmac("sha256", args.secret)
    .update(signingMessage({ timestamp, nonce, idempotencyKey }, payloadSha256))
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "hex");
  } catch {
    return { ok: false, reason: "invalid copy authentication signature", payloadSha256 };
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "invalid copy authentication signature", payloadSha256 };
  }
  const replay = args.replayGuard.consume(nonce, nowMs);
  return { ok: replay.ok, reason: replay.reason, payloadSha256 };
}

export class CopyAuditLogger {
  private readonly file: string;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "copy-to-live-audit.jsonl");
  }

  get path(): string {
    return this.file;
  }

  append(event: CopyAuditEvent): { ok: boolean; reason: string | null } {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
      chmodSync(this.file, 0o600);
      return { ok: true, reason: null };
    } catch (error) {
      return {
        ok: false,
        reason: `copy audit unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
