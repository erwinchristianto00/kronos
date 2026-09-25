import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { startAstraGateway } from "../src/lib/astra-hermes-gateway.js";
import type { AstraHermesLane } from "../src/lib/astra-hermes-lane.js";
it("exposes only authenticated lane-scoped routes on loopback", async () => {
  const lane = { status: () => ({ environment: "testnet", initialEquity: 25 }), market: vi.fn(async () => ({})), decide: vi.fn(async () => ({})) };
  const token = "a".repeat(64);
  const acceptLearning = vi.fn(() => ({ ok: true }));
  const server = startAstraGateway(lane as unknown as AstraHermesLane, token, 0, acceptLearning);
  await once(server, "listening"); const address = server.address() as any;
  expect(address.address).toBe("127.0.0.1");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(url + "/status")).status).toBe(401);
    expect((await fetch(url + "/learning", { method: "POST", body: "{}" })).status).toBe(401);
    expect(acceptLearning).not.toHaveBeenCalled();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect(await (await fetch(url + "/status", { headers })).json()).toEqual({ environment: "testnet", initialEquity: 25 });
    expect((await fetch(url + "/api/live/copy-to-live", { method: "POST", headers, body: "{}" })).status).toBe(404);
    const symbols = Array.from({ length: 47 }, (_, i) => `COIN${i}USDT`);
    await fetch(url + "/context", { method: "POST", headers, body: JSON.stringify({ symbols, offset: 20 }) });
    expect(lane.market).toHaveBeenCalledExactlyOnceWith(symbols, 20);
    await fetch(url + "/context", { method: "POST", headers, body: JSON.stringify({symbols:['DOGEUSDT'],contextMode:'FORMATION_METADATA_V1'}) });
    expect(lane.market).toHaveBeenLastCalledWith(['DOGEUSDT'],0,'FORMATION_METADATA_V1');
    await fetch(url + "/decision", { method: "POST", headers, body: JSON.stringify({ action: "WAIT" }) });
    expect(lane.decide).toHaveBeenCalledExactlyOnceWith({ action: "WAIT" });
    await fetch(url + "/learning", { method: "POST", headers, body: JSON.stringify({ memoryText: "test" }) });
    expect(acceptLearning).toHaveBeenCalledExactlyOnceWith({ memoryText: "test" });
    expect(lane.decide).toHaveBeenCalledTimes(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
