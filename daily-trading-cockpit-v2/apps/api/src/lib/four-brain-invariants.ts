/**
 * Four-Brain invariants (Phase 1). Executable guarantees on the four brains' OUTPUTS + the few safety
 * rules that need a slice of context (a stale signal must not ENTER_NOW; the Exit Brain may never widen a
 * hard stop). These are checked on every decision before it is journaled; a violation is recorded, and the
 * executive fails OPEN to incumbent behavior — a brain can never coerce an action, so an invariant breach
 * is a data/logic bug to surface, not a trade risk. (The "no execution import / no order placement /
 * no setAllocations" invariants are proven structurally by four-brain-architecture.test.ts, not here.)
 */
import {
  validWindow,
  type DirectionDecision,
  type EntryDecision,
  type ExecutiveDecision,
  type ExitDecision,
  type MarketStateDecision,
} from "./four-brain-types.js";
import { validAllocationContext, validMarketContextLineage } from "./authority-contract.js";

export interface FourBrainInvariantResult {
  ok: boolean;
  violations: string[];
}

const inUnit = (x: number): boolean => Number.isFinite(x) && x >= 0 && x <= 1;
const finiteOrNull = (x: number | null): boolean => x === null || Number.isFinite(x);

function base(asOfMs: number, validUntilMs: number, v: string[]): void {
  if (!validWindow(asOfMs, validUntilMs)) v.push("validUntilMs < asOfMs (or non-finite)");
}

export function checkMarketStateInvariants(d: MarketStateDecision): FourBrainInvariantResult {
  const v: string[] = [];
  base(d.asOfMs, d.validUntilMs, v);
  if (!inUnit(d.transitionRisk)) v.push("transitionRisk out of 0..1");
  if (!inUnit(d.confidence)) v.push("confidence out of 0..1");
  for (const [k, val] of Object.entries(d.components)) if (!finiteOrNull(val)) v.push(`component ${k} not finite-or-null`);
  return { ok: v.length === 0, violations: v };
}

export function checkDirectionInvariants(d: DirectionDecision): FourBrainInvariantResult {
  const v: string[] = [];
  base(d.asOfMs, d.validUntilMs, v);
  if (!inUnit(d.longScore)) v.push("longScore out of 0..1");
  if (!inUnit(d.shortScore)) v.push("shortScore out of 0..1");
  if (!inUnit(d.flatScore)) v.push("flatScore out of 0..1"); // FLAT is a real competing baseline
  if (!inUnit(d.confidence)) v.push("confidence out of 0..1");
  if (!finiteOrNull(d.expectedDirectionalR)) v.push("expectedDirectionalR not finite-or-null");
  return { ok: v.length === 0, violations: v };
}

/** Entry context needed for the cross-cutting safety rules (optional — omit ⇒ output-only checks). */
export interface EntryInvariantContext {
  /** True if the lane signal driving this entry was FRESH. A stale signal must NEVER ENTER_NOW. */
  signalFresh?: boolean;
  side?: "LONG" | "SHORT";
}

export function checkEntryInvariants(d: EntryDecision, ctx: EntryInvariantContext = {}): FourBrainInvariantResult {
  const v: string[] = [];
  base(d.asOfMs, d.validUntilMs, v);
  if (!inUnit(d.chaseRisk)) v.push("chaseRisk out of 0..1");
  if (!inUnit(d.slippageRisk)) v.push("slippageRisk out of 0..1");
  if (!inUnit(d.confidence)) v.push("confidence out of 0..1");
  for (const k of ["targetEntry", "invalidationPrice", "initialStopPrice", "expectedNetR"] as const) {
    if (!finiteOrNull(d[k])) v.push(`${k} not finite-or-null`);
  }
  // Stale signals cannot ENTER_NOW (fail-safe timing contract).
  if (ctx.signalFresh === false && d.action === "ENTER_NOW") v.push("ENTER_NOW on a non-FRESH signal");
  // Valid stop geometry when a concrete entry is proposed: stop must be on the protective side of entry.
  if (d.action === "ENTER_NOW" && d.initialStopPrice != null && d.targetEntry != null) {
    const side = ctx.side ?? d.side;
    const badLong = side === "LONG" && d.initialStopPrice >= d.targetEntry;
    const badShort = side === "SHORT" && d.initialStopPrice <= d.targetEntry;
    if (badLong || badShort) v.push("ENTER_NOW with stop on the wrong side of entry (invalid geometry)");
  }
  return { ok: v.length === 0, violations: v };
}

/** Exit context needed to enforce "never widen a hard stop" + "hard stop / kill outrank HOLD". */
export interface ExitInvariantContext {
  side?: "LONG" | "SHORT";
  /** The incumbent hard stop price. Exit Brain's suggestedStop may only be tighter (protective), never looser. */
  hardStopPrice?: number | null;
  /** True if the incumbent hard stop is already breached OR the kill switch is latched. */
  hardExitTriggered?: boolean;
}

export function checkExitInvariants(d: ExitDecision, ctx: ExitInvariantContext = {}): FourBrainInvariantResult {
  const v: string[] = [];
  base(d.asOfMs, d.validUntilMs, v);
  if (!inUnit(d.exitFraction)) v.push("exitFraction out of 0..1");
  if (!inUnit(d.reversalRisk)) v.push("reversalRisk out of 0..1");
  if (!inUnit(d.continuationProbability)) v.push("continuationProbability out of 0..1");
  if (!finiteOrNull(d.edgeRemainingR)) v.push("edgeRemainingR not finite-or-null");
  if (!finiteOrNull(d.suggestedStop)) v.push("suggestedStop not finite-or-null");
  if (!finiteOrNull(d.suggestedTrailDistance)) v.push("suggestedTrailDistance not finite-or-null");
  if (d.suggestedTrailDistance != null && d.suggestedTrailDistance < 0) v.push("suggestedTrailDistance < 0");
  // NEVER widen a hard stop: for LONG a protective stop only moves UP; for SHORT only DOWN.
  if (ctx.hardStopPrice != null && d.suggestedStop != null) {
    const side = ctx.side;
    const widenedLong = side === "LONG" && d.suggestedStop < ctx.hardStopPrice;
    const widenedShort = side === "SHORT" && d.suggestedStop > ctx.hardStopPrice;
    if (widenedLong || widenedShort) v.push("suggestedStop widens the incumbent hard stop (forbidden)");
  }
  // A hard exit already fired: Exit Brain must not say HOLD (the executive will hard-override regardless,
  // but a HOLD here is a logic error worth surfacing).
  if (ctx.hardExitTriggered === true && d.action === "HOLD") v.push("HOLD while the hard stop/kill has already triggered");
  return { ok: v.length === 0, violations: v };
}

export function checkExecutiveInvariants(d: ExecutiveDecision): FourBrainInvariantResult {
  const v: string[] = [];
  if (d.reportOnly !== true) v.push("reportOnly is not true"); // the whole layer is report-only in Phase 1
  if (d.advisoryOnly !== true) v.push("advisoryOnly is not true");
  if (!validAllocationContext(d.allocationContext)) v.push("invalid allocation context");
  if (!validMarketContextLineage(d.marketContext)) v.push("invalid or causally inconsistent market context lineage");
  const ms = checkMarketStateInvariants(d.marketState);
  if (!ms.ok) v.push(...ms.violations.map((x) => `marketState: ${x}`));
  if (d.direction) {
    const r = checkDirectionInvariants(d.direction);
    if (!r.ok) v.push(...r.violations.map((x) => `direction: ${x}`));
  }
  if (d.entry) {
    const r = checkEntryInvariants(d.entry);
    if (!r.ok) v.push(...r.violations.map((x) => `entry: ${x}`));
  }
  if (d.exit) {
    const r = checkExitInvariants(d.exit);
    if (!r.ok) v.push(...r.violations.map((x) => `exit: ${x}`));
  }
  return { ok: v.length === 0, violations: v };
}
