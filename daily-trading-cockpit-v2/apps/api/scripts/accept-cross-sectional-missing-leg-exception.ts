/**
 * One-time, explicit operator migration for a verified historical phantom maker fill.
 *
 * Usage (only while the relevant API process is stopped):
 *   npx tsx scripts/accept-cross-sectional-missing-leg-exception.ts \
 *     --data-dir apps/api/data --basket-id <id> --symbol <symbol> --approve
 *
 * The script validates the exact UNKNOWN_REQUERY/zero-quantity signature before
 * changing anything. It creates timestamped backups of both mutable stores.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptVerifiedMissingLegException } from "../src/lib/cross-sectional-operator-exception.js";
import type { ExecutorBasket } from "../src/lib/cross-sectional-executor.js";

type ArgMap = Record<string, string | boolean>;
function args(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) out[key] = true;
    else { out[key] = value; i += 1; }
  }
  return out;
}
function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}
function atomicJson(path: string, payload: unknown): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

const argv = args(process.argv.slice(2));
if (argv["--approve"] !== true) {
  throw new Error("refusing mutation without --approve");
}
const dataDir = required(argv["--data-dir"], "--data-dir");
const basketId = required(argv["--basket-id"], "--basket-id");
const symbol = required(argv["--symbol"], "--symbol").toUpperCase();
const executorPath = join(dataDir, "cross-sectional-executor.json");
const reservationsPath = join(dataDir, "account-exposure-reservations.json");
if (!existsSync(executorPath) || !existsSync(reservationsPath)) {
  throw new Error("executor or account-exposure reservation store is missing");
}

const executorState = JSON.parse(readFileSync(executorPath, "utf8")) as { baskets?: ExecutorBasket[] };
const reservationsState = JSON.parse(readFileSync(reservationsPath, "utf8")) as {
  reservations?: Array<Record<string, unknown>>;
};
const basket = executorState.baskets?.find((candidate) => candidate.basketId === basketId);
if (!basket) throw new Error(`basket ${basketId} not found`);

const now = new Date().toISOString();
const stamp = now.replace(/[-:.]/g, "").replace("Z", "Z");
const result = acceptVerifiedMissingLegException(basket, {
  approvedAt: now,
  symbol,
  reason: "operator accepted the verified missing maker-entry leg; retain only the real exchange legs",
});
if (!result.reservationId) throw new Error(`basket ${basketId} ${symbol} has no reservation id to correct`);
const reservation = reservationsState.reservations?.find((entry) => entry.reservationId === result.reservationId);
if (!reservation || reservation.symbol !== symbol || reservation.status !== "COMMITTED") {
  throw new Error(`reservation ${result.reservationId} is not the expected committed ${symbol} phantom`);
}
reservation.status = "RELEASED";
reservation.releasedAt = now;
reservation.releaseReason = "OPERATOR_ACCEPTED_MISSING_LEG_VERIFIED_NOT_PLACED";
reservation.correctionNote = "The prior COMMITTED quantity came from the historical UNKNOWN_REQUERY phantom-fill defect; no exchange position was present.";

copyFileSync(executorPath, `${executorPath}.bak-operator-missing-leg-${stamp}`);
copyFileSync(reservationsPath, `${reservationsPath}.bak-operator-missing-leg-${stamp}`);
atomicJson(executorPath, executorState);
atomicJson(reservationsPath, reservationsState);
console.log(JSON.stringify({
  ok: true,
  basketId,
  retainedLegs: basket.legs.map((leg) => `${leg.symbol}:${leg.side}`),
  missingLeg: result.removedLeg,
  reservationId: result.reservationId,
  exception: result.exception,
  backups: [`${executorPath}.bak-operator-missing-leg-${stamp}`, `${reservationsPath}.bak-operator-missing-leg-${stamp}`],
}, null, 2));
