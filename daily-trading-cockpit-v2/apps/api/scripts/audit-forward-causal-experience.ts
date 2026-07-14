/** Offline-only reader for the forward causal journal. It never starts collection or changes runtime state. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { auditForwardCausalEvents, type ForwardCausalEvent } from "../src/experience-engine/forward-causal-auditor.js";

const apiRoot = join(import.meta.dirname, "..");
const instanceId = process.env.FORWARD_CAUSAL_AUDIT_INSTANCE ?? "3102";
const dataDir = process.env.CAUSAL_EXPERIENCE_COLLECTION_DIR ?? join(apiRoot, "data");
const journal = join(dataDir, "causal-experience", instanceId, "events.jsonl");
const outDir = join(apiRoot, "artifacts", "experience-engine", "forward-collection");

const events: ForwardCausalEvent[] = existsSync(journal)
  ? readFileSync(journal, "utf8").split("\n").flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line) as ForwardCausalEvent] : []; } catch { return []; }
    })
  : [];
const result = auditForwardCausalEvents(events);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "REAL_CHAIN_AUDIT.json"), JSON.stringify({ instanceId, journal, eventCount: events.length, ...result }, null, 2));
writeFileSync(join(outDir, "REAL_CHAIN_AUDIT.md"), `# Real Chain Audit\n\nInstance: \`${instanceId}\`\n\n- Journal events: **${events.length}**\n- Direct links observed: **${result.directChains}**\n- Complete causal chains: **${result.completeChains}**\n- Deterministic audit hash: \`${result.auditHash}\`\n\nNo time-nearest fallback was used. A complete chain is required before any candidate learning work may begin.\n`);
console.log(JSON.stringify({ instanceId, eventCount: events.length, completeChains: result.completeChains, directChains: result.directChains, auditHash: result.auditHash }, null, 2));
