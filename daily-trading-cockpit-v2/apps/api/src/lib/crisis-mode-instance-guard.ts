/**
 * CRISIS MODE — LIVE-INSTANCE STRUCTURAL BLOCK (wiring-layer safety gate, 2026-07-22).
 *
 * WHAT THIS IS: the ONE gate any future wiring code MUST call before it actually APPLIES
 * crisis-mode-controller.ts's evaluateCrisisMode() output (allocationTiltPct to a real allocation,
 * exitToleranceOverride to a real exit-brain-policy.ts binding) to anything real. As of this file's
 * creation NOTHING in this repo calls such an "apply" function — crisis-mode-cycle.ts (the wiring
 * cycle) only detects/classifies/evaluates and persists an audit log entry; it never touches
 * RegimeAutopilot.setAllocations, any executor's sizing, or exit-brain-policy.ts's real params. This
 * file exists so that guarantee is structural (checked here, not "we'll remember to check it later")
 * from the very first line of any future application code, exactly the staged path CORTEX itself
 * took: build the pure core → shadow-measure it for weeks → THEN, and only then, wire a real
 * application behind an explicit operator-reviewed gate.
 *
 * THE GATE, canApplyCrisisModeActions(env), is true only when ALL of:
 *   1. isCrisisModeLiveInstance(env) is FALSE — this is a HARD, NON-OVERRIDABLE block. No env var,
 *      no flag, no combination of settings can make this true on the live/mainnet instance (PORT
 *      3103). This mirrors the exact idiom four-brain-live-gather-bindings.ts's
 *      fourBrainInstanceAllowed() already uses in this repo: check BOTH the resolved instance id AND
 *      the raw serving PORT against "3103", so a stray relabeling env var can never smuggle this
 *      feature onto the real-money box. See resolveCrisisModeInstanceId's doc for why PORT, not a
 *      hostname or hand-set flag, is the source of truth (it's what server.ts actually binds to).
 *   2. crisis-mode-controller.ts's isCrisisModeActionEnabled(env) is true (CRISIS_MODE_ACTION_ENABLED
 *      = "1", default false — that module's own wiring-layer action gate).
 *   3. isCrisisModeLiveExecutionAllowed(env) is true (CRISIS_MODE_LIVE_EXECUTION_ALLOWED = "1",
 *      default false — a SEPARATE flag from (2), so both must be independently and explicitly
 *      flipped; belt-and-suspenders against one flag being left on from an earlier, narrower test).
 *
 * CRISIS_MODE_LIVE_EXECUTION_ALLOWED must stay unset (false) on the live repo's .env until an
 * operator has explicitly reviewed WEEKS of testnet evidence that crisis-mode's detection is sound
 * (no false triggers, sane tilt/exit-override values, no missed real escalations) — the same bar
 * every other mechanism in this repo (CORTEX, four-brain, exit-brain, meta-label, …) had to clear
 * before being trusted anywhere near real capital. Do not set it as a convenience; it does not
 * unlock anything on the live instance regardless (see (1) above) — its only effect is on
 * research/testnet, where crisis-mode can otherwise run in evaluate-and-report mode indefinitely.
 */

import { isCrisisModeActionEnabled } from "./crisis-mode-controller.js";

/** The serving PORT that identifies the LIVE, real-money instance — hard-blocked no matter what. */
export const CRISIS_MODE_LIVE_INSTANCE_PORT = "3103";

/** Resolve a stable instance id for this runtime. CRISIS_MODE_INSTANCE_ID lets an operator label an
 *  instance explicitly (e.g. in a non-standard deployment); it falls back to the actual serving PORT
 *  (what server.ts binds to) and finally to "3101" (research, the safest default) — NEVER "unknown",
 *  so a missing env can never silently resolve to something outside every check below. */
export function resolveCrisisModeInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CRISIS_MODE_INSTANCE_ID ?? env.PORT ?? "3101").toString();
}

/** True if EITHER the resolved instance id OR the raw serving PORT is the live instance (3103).
 *  Checking both (not just the resolved id) means an operator who sets CRISIS_MODE_INSTANCE_ID to
 *  relabel the box for some other purpose can never accidentally unblock this on real money — the
 *  raw PORT always wins toward "blocked". */
export function isCrisisModeLiveInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolveCrisisModeInstanceId(env);
  const rawPort = (env.PORT ?? "").toString();
  return resolved === CRISIS_MODE_LIVE_INSTANCE_PORT || rawPort === CRISIS_MODE_LIVE_INSTANCE_PORT;
}

/** Default-false action gate, SEPARATE from crisis-mode-controller.ts's own CRISIS_MODE_ACTION_ENABLED
 *  — both must be independently set for canApplyCrisisModeActions to ever return true off the live
 *  instance. Must stay unset on the live repo's .env — see module header. */
export const CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG = "CRISIS_MODE_LIVE_EXECUTION_ALLOWED";

export function isCrisisModeLiveExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CRISIS_MODE_LIVE_EXECUTION_ALLOWED_FLAG] === "1";
}

/**
 * THE gate. Any future code that would apply allocationTiltPct/exitToleranceOverride to a real
 * allocation or exit-brain-policy.ts binding MUST check this FIRST and no-op when it is false. Fails
 * closed on every leg: the live instance is blocked unconditionally (cannot be overridden by any env
 * var), and even off the live instance BOTH default-false action gates must be explicitly enabled.
 * As of 2026-07-22 nothing in this repo calls the "apply" step this gates — crisis-mode-cycle.ts only
 * detects/reports/audits — so this function currently has no caller that touches real capital; it
 * exists so the FIRST such caller is safe by construction.
 */
export function canApplyCrisisModeActions(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isCrisisModeLiveInstance(env)) return false; // HARD BLOCK — never overridable
  if (!isCrisisModeActionEnabled(env)) return false;
  if (!isCrisisModeLiveExecutionAllowed(env)) return false;
  return true;
}
