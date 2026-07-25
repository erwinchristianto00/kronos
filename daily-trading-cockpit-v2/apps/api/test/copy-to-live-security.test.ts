import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  CopyAuditLogger,
  CopyReplayGuard,
  signCopyRequest,
  verifyCopyRequest,
} from "../src/lib/copy-to-live-security.js";
import type { LiveExecutionEngine } from "../src/lib/live-execution-engine.js";
import { registerLiveRoutes } from "../src/routes/live.js";

const SECRET = "kronos-copy-test-secret-that-is-long-enough";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kronos-copy-security-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function copyBody() {
  return {
    confirm: "COPY",
    symbol: "ETHUSDT",
    direction: "SHORT" as const,
    qty: 0.05,
    entryPrice: 2000,
    stopLossPrice: 2100,
    tp1Price: 1900,
    sourcePaperOrderId: "paper-1",
    idempotencyKey: "testnet:paper-1",
  };
}

describe("copy-to-live request security", () => {
  it("survives restart and rejects a nonce replay", () => {
    const dataDir = tempDir();
    const body = copyBody();
    const auth = signCopyRequest({
      secret: SECRET,
      body,
      idempotencyKey: body.idempotencyKey,
      nowMs: 10_000,
      nonce: "abcdefghijklmnop",
    });
    const first = verifyCopyRequest({
      secret: SECRET,
      body,
      headers: auth,
      replayGuard: new CopyReplayGuard(dataDir),
      nowMs: 10_000,
    });
    expect(first.ok).toBe(true);

    const afterRestart = verifyCopyRequest({
      secret: SECRET,
      body,
      headers: auth,
      replayGuard: new CopyReplayGuard(dataDir),
      nowMs: 10_001,
    });
    expect(afterRestart).toEqual(expect.objectContaining({ ok: false, reason: "replayed nonce" }));
  });

  it("rejects tampered payloads and stale timestamps before action", () => {
    const dataDir = tempDir();
    const body = copyBody();
    const auth = signCopyRequest({
      secret: SECRET,
      body,
      idempotencyKey: body.idempotencyKey,
      nowMs: 10_000,
      nonce: "abcdefghijklmnop",
    });
    expect(
      verifyCopyRequest({
        secret: SECRET,
        body: { ...body, qty: 9 },
        headers: auth,
        replayGuard: new CopyReplayGuard(dataDir),
        nowMs: 10_000,
      }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "invalid copy authentication signature" }));
    expect(
      verifyCopyRequest({
        secret: SECRET,
        body,
        headers: auth,
        replayGuard: new CopyReplayGuard(dataDir),
        nowMs: 100_001,
      }),
    ).toEqual(expect.objectContaining({ ok: false, reason: "copy authentication timestamp is stale" }));
  });

  it("enforces private loopback access, signed auth, replay protection, and redacted audit logging", async () => {
    const dataDir = tempDir();
    const calls: unknown[] = [];
    const engine = {
      copyExternalIntent: async (request: unknown) => {
        calls.push(request);
        return { ok: true, reason: null, intent: { paperOrderId: "copy-1" } };
      },
    } as unknown as LiveExecutionEngine;
    const app = Fastify();
    const replayGuard = new CopyReplayGuard(dataDir);
    const auditLogger = new CopyAuditLogger(dataDir);
    await registerLiveRoutes(app, engine, {
      copySecurity: { secret: SECRET, replayGuard, auditLogger, nowMs: () => 10_000 },
    });

    const body = copyBody();
    const auth = signCopyRequest({
      secret: SECRET,
      body,
      idempotencyKey: body.idempotencyKey,
      nowMs: 10_000,
      nonce: "abcdefghijklmnop",
    });
    const headers = {
      "content-type": "application/json",
      "x-kronos-copy-timestamp": auth.timestamp,
      "x-kronos-copy-nonce": auth.nonce,
      "x-kronos-copy-idempotency-key": auth.idempotencyKey,
      "x-kronos-copy-signature": auth.signature,
    };

    const publicAttempt = await app.inject({
      method: "POST",
      url: "/api/live/copy-intent",
      payload: body,
      headers,
      remoteAddress: "203.0.113.9",
    });
    expect(publicAttempt.statusCode).toBe(403);

    const unsigned = await app.inject({
      method: "POST",
      url: "/api/live/copy-intent",
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/live/copy-intent",
      payload: body,
      headers,
    });
    expect(accepted.statusCode).toBe(200);
    expect(calls).toHaveLength(1);

    const replayed = await app.inject({
      method: "POST",
      url: "/api/live/copy-intent",
      payload: body,
      headers,
    });
    expect(replayed.statusCode).toBe(401);
    expect(calls).toHaveLength(1);

    const audit = readFileSync(auditLogger.path, "utf-8");
    expect(audit).toContain('"stage":"RECEIVER"');
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toContain(auth.signature);
    await app.close();
  });
});
