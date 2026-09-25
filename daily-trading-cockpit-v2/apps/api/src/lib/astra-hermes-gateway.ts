import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AstraHermesLane, AstraDecision } from "./astra-hermes-lane.js";

/** Not mounted on the public dashboard: only a private, authenticated SSH-forwarded port. */
export function startAstraGateway(lane: AstraHermesLane, token: string, port = 3112, acceptLearning?: (input: unknown) => unknown) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Astra gateway credential");
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const provided = Buffer.from(req.headers.authorization ?? "");
    const wanted = Buffer.from(`Bearer ${token}`);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      res.writeHead(401); res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    try {
      if (req.method === "GET" && req.url === "/status") { res.end(JSON.stringify(lane.status())); return; }
      if (req.method !== "POST" || !["/context", "/decision", ...(acceptLearning ? ["/learning"] : [])].includes(req.url ?? "")) {
        res.writeHead(404); res.end("{}"); return;
      }
      let raw = "";
      for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > (req.url === "/learning" ? 131072 : 32768)) throw new Error("Request too large"); }
      const input = JSON.parse(raw);
      const result = req.url === "/learning" ? acceptLearning!(input) : req.url === "/context"
        ? await (input.contextMode === undefined ? lane.market(input.symbols ?? [], input.offset ?? 0)
          : lane.market(input.symbols ?? [], input.offset ?? 0, input.contextMode))
        : await lane.decide(input as AstraDecision);
      res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(409); res.end(JSON.stringify({ error: (e as Error).message })); }
  });
  server.requestTimeout = 180000;
  server.listen(port, "127.0.0.1");
  return server;
}
