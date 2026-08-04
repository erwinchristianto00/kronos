/**
 * Fail-closed campaign control for the /research innovation testnet execution bridge (see
 * innovation-testnet-execution.ts). Before this module existed, `isInnovationTestnetExecutionEnabled`
 * was the ONLY gate on the 13 innovation executor instances (3 CrossSectionalExecutor +
 * 10 SingleSymbolLaneExecutor) — fail-OPEN: enabled unless an operator explicitly set
 * `INNOVATION_TESTNET_EXEC_DISABLED=1`. This module replaces that default-on posture with a
 * default-OFF one: new innovation exposure requires a currently-active, schema-valid, non-expired
 * campaign file that explicitly names the lane and has capacity left under every cap.
 *
 * HARD INVARIANT — this file is READ-ONLY. There is no `_save()`, no `writeFileSync`, no
 * `mkdirSync`. The campaign file (`data/innovation-campaign.json` by default) is operator
 * hand-edited-or-absent; nothing in this module (or its callers) may ever create one or flip
 * `enabled` to `true`. Any future change that adds a writer here defeats the entire point of this
 * module — it must stay a pure reader.
 *
 * WIRING CONTRACT (see app.ts's innovation-execution construction block): every function here is
 * consulted ONLY from `isAllowed` / `entryHealthGate` / `isAllowedReason` closures — the gates that
 * decide whether a NEW basket/position may open. Nothing here is ever wired into
 * `monitorOpenPositions` / `closeBasketsHittingProfitTarget` / `closeDueBaskets` /
 * `retryOrphanedLegFlattens` / `ensureOpenBasketLeverage` / `closeAllPositionsOrderly` — those run
 * unconditionally, every tick, regardless of campaign state, so an expired or absent campaign can
 * only ever block a NEW entry, never position management or closing of what is already open.
 *
 * CAP ENFORCEMENT (2026-08-05 fix): `evaluateInnovationCampaignAdmission`'s own globalMaxPositions/
 * globalNotionalCap/perLaneCaps branches below are consulted ONCE PER TICK, against a
 * computeInnovationExposure() snapshot taken BEFORE any of that tick's entries actually open — a
 * fast, cheap pre-filter, but no longer the AUTHORITATIVE check for those three fields. The
 * authoritative check is account-exposure-coordinator.ts's `reserve()` gate 2, fed by this file's own
 * `campaignCapForLane()` below: it re-derives live campaign exposure INSIDE that coordinator's single
 * atomic synchronous call, from the SAME reservation ledger its other 5 capacity axes already read —
 * never from this module's own getStatus()-snapshot-based computeInnovationExposure. This closes the
 * race a per-tick snapshot check cannot: multiple entries within one tick (a SingleSymbolLaneExecutor's
 * own per-signal loop, a CrossSectionalExecutor's per-leg loop) and two DIFFERENT executor instances
 * racing each other can no longer both observe "capacity available" and both proceed. The `enabled`/
 * window/`allowedLaneIds` decision below remains authoritative exactly as before — those are
 * admission/policy checks, not arithmetic over a shared ledger, and stay checked once per tick.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CrossSectionalExecutor } from "./cross-sectional-executor.js";
import type { SingleSymbolLaneExecutor } from "./single-symbol-lane-executor.js";
import { EXECUTABLE_INNOVATION_LANE_IDS, type ExecutableInnovationLaneId } from "./innovation-testnet-execution.js";
import type { ExposureReserveCampaignCap } from "./account-exposure-coordinator.js";

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

export interface InnovationCampaignPerLaneCap {
  /** Positive finite integer if present. */
  maxPositions?: number;
  /** Positive finite number (USD) if present. */
  maxNotionalUsd?: number;
}

export interface InnovationCampaign {
  /** Non-empty (trimmed) operator-chosen identifier. */
  campaignId: string;
  /** Strict boolean — operator kill switch for this campaign, independent of the start/expiry window. */
  enabled: boolean;
  /** Subset of EXECUTABLE_INNOVATION_LANE_IDS. MAY be empty — an empty array is a well-formed
   *  campaign that currently authorizes zero lanes (every lane rejected individually with its own
   *  reason), not a malformed one. */
  allowedLaneIds: ExecutableInnovationLaneId[];
  /** ISO 8601 instant, MUST carry an explicit zone marker (Z or +/-HH:MM). */
  startsAt: string;
  /** Same rule as startsAt; must be strictly after startsAt. */
  expiresAt: string;
  /** Positive finite INTEGER — count across all 13 innovation executor instances combined. */
  globalMaxPositions: number;
  /** Positive finite number (USD) — notional across all 13 instances combined. */
  globalNotionalCap: number;
  /** Keyed by bare laneId (EXECUTABLE_INNOVATION_LANE_IDS carries no direction) — for the 5
   *  single-symbol lane ids this is ONE cap shared across that lane's LONG+SHORT instances
   *  combined, not per-direction. Always an object, never undefined, possibly {}. */
  perLaneCaps: Partial<Record<ExecutableInnovationLaneId, InnovationCampaignPerLaneCap>>;
  /** Operator metadata: why this campaign exists (free text). */
  reason: string | null;
  /** Operator metadata: who owns/approved it. */
  owner: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ISO instant with an explicit UTC/offset marker — a bare "2026-08-01T00:00:00" parses as LOCAL
 *  time in whatever process/timezone loads the file next, silently shifting the campaign window.
 *  This is stricter than the literal requirement examples, justified by this codebase's own
 *  recurring timezone-ambiguity bug class (see CLAUDE.md). */
const ISO_ZONE_MARKER_RE = /(Z|[+-]\d{2}:?\d{2})$/;

function isZonedIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_ZONE_MARKER_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isExecutableInnovationLaneId(id: string): id is ExecutableInnovationLaneId {
  return (EXECUTABLE_INNOVATION_LANE_IDS as readonly string[]).includes(id);
}

function isPositiveFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export type InnovationCampaignValidationResult =
  | { ok: true; campaign: InnovationCampaign }
  | { ok: false; reason: string };

/**
 * Validates an arbitrary parsed-JSON value against the campaign schema, in the exact rule order
 * documented above each check, returning the FIRST failing reason (no accumulation — one clear
 * message). Never throws: every branch is a plain type/value check.
 */
export function validateInnovationCampaign(parsed: unknown): InnovationCampaignValidationResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "campaign file must contain a single JSON object" };
  }

  const campaignIdRaw = parsed.campaignId;
  if (typeof campaignIdRaw !== "string" || campaignIdRaw.trim().length === 0) {
    return { ok: false, reason: "campaignId missing or empty" };
  }
  const campaignId = campaignIdRaw.trim();

  if (typeof parsed.enabled !== "boolean") {
    return { ok: false, reason: "enabled missing or not a boolean" };
  }
  const enabled = parsed.enabled;

  if (!Array.isArray(parsed.allowedLaneIds)) {
    return { ok: false, reason: "allowedLaneIds missing or not an array" };
  }
  const allowedLaneIds: ExecutableInnovationLaneId[] = [];
  for (const rawId of parsed.allowedLaneIds) {
    if (typeof rawId !== "string" || !isExecutableInnovationLaneId(rawId)) {
      return {
        ok: false,
        reason: `allowedLaneIds contains an id outside EXECUTABLE_INNOVATION_LANE_IDS: ${String(rawId)}`,
      };
    }
    allowedLaneIds.push(rawId);
  }

  if (!isZonedIsoInstant(parsed.startsAt)) {
    return {
      ok: false,
      reason: "startsAt missing, not a parseable ISO date-time, or missing an explicit UTC/offset marker",
    };
  }
  const startsAt = parsed.startsAt;

  if (!isZonedIsoInstant(parsed.expiresAt)) {
    return {
      ok: false,
      reason: "expiresAt missing, not a parseable ISO date-time, or missing an explicit UTC/offset marker",
    };
  }
  const expiresAt = parsed.expiresAt;

  if (!(Date.parse(expiresAt) > Date.parse(startsAt))) {
    return { ok: false, reason: "expiresAt must be after startsAt" };
  }

  if (!isPositiveFiniteInteger(parsed.globalMaxPositions)) {
    return { ok: false, reason: "globalMaxPositions must be a positive finite integer" };
  }
  const globalMaxPositions = parsed.globalMaxPositions;

  if (!isPositiveFiniteNumber(parsed.globalNotionalCap)) {
    return { ok: false, reason: "globalNotionalCap must be a positive finite number" };
  }
  const globalNotionalCap = parsed.globalNotionalCap;

  const perLaneCaps: Partial<Record<ExecutableInnovationLaneId, InnovationCampaignPerLaneCap>> = {};
  if (parsed.perLaneCaps !== undefined && parsed.perLaneCaps !== null) {
    if (!isPlainObject(parsed.perLaneCaps)) {
      return { ok: false, reason: "perLaneCaps must be an object if present" };
    }
    for (const [key, rawValue] of Object.entries(parsed.perLaneCaps)) {
      if (!isExecutableInnovationLaneId(key)) {
        return { ok: false, reason: `perLaneCaps key outside EXECUTABLE_INNOVATION_LANE_IDS: ${key}` };
      }
      if (!isPlainObject(rawValue)) {
        return {
          ok: false,
          reason: `perLaneCaps.${key} is empty (must specify maxPositions and/or maxNotionalUsd)`,
        };
      }
      const maxPositionsRaw = rawValue.maxPositions;
      const maxNotionalUsdRaw = rawValue.maxNotionalUsd;
      if (maxPositionsRaw === undefined && maxNotionalUsdRaw === undefined) {
        return {
          ok: false,
          reason: `perLaneCaps.${key} is empty (must specify maxPositions and/or maxNotionalUsd)`,
        };
      }
      const cap: InnovationCampaignPerLaneCap = {};
      if (maxPositionsRaw !== undefined) {
        if (!isPositiveFiniteInteger(maxPositionsRaw)) {
          return { ok: false, reason: `perLaneCaps.${key}.maxPositions must be a positive finite integer` };
        }
        cap.maxPositions = maxPositionsRaw;
      }
      if (maxNotionalUsdRaw !== undefined) {
        if (!isPositiveFiniteNumber(maxNotionalUsdRaw)) {
          return { ok: false, reason: `perLaneCaps.${key}.maxNotionalUsd must be a positive finite number` };
        }
        cap.maxNotionalUsd = maxNotionalUsdRaw;
      }
      perLaneCaps[key] = cap;
    }
  }

  let reason: string | null = null;
  if (parsed.reason !== undefined && parsed.reason !== null) {
    if (typeof parsed.reason !== "string") {
      return { ok: false, reason: "reason must be a string if present" };
    }
    reason = parsed.reason;
  }

  let owner: string | null = null;
  if (parsed.owner !== undefined && parsed.owner !== null) {
    if (typeof parsed.owner !== "string") {
      return { ok: false, reason: "owner must be a string if present" };
    }
    owner = parsed.owner;
  }

  return {
    ok: true,
    campaign: {
      campaignId,
      enabled,
      allowedLaneIds,
      startsAt,
      expiresAt,
      globalMaxPositions,
      globalNotionalCap,
      perLaneCaps,
      reason,
      owner,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Window evaluation (shared by the loader's own reason and the pure admission evaluator, so the
// two can never drift apart on what "currently active" means).
// ---------------------------------------------------------------------------------------------

interface CampaignWindowStatus {
  active: boolean;
  expired: boolean;
  reason: string | null;
}

function campaignWindowStatus(campaign: InnovationCampaign, nowMs: number): CampaignWindowStatus {
  if (!campaign.enabled) {
    return {
      active: false,
      expired: false,
      reason: `campaign ${campaign.campaignId} present but enabled=false`,
    };
  }
  const startsAtMs = Date.parse(campaign.startsAt);
  if (nowMs < startsAtMs) {
    return {
      active: false,
      expired: false,
      reason: `campaign ${campaign.campaignId} not yet started (startsAt ${campaign.startsAt})`,
    };
  }
  const expiresAtMs = Date.parse(campaign.expiresAt);
  if (nowMs >= expiresAtMs) {
    return {
      active: false,
      expired: true,
      reason: `campaign ${campaign.campaignId} expired (expiresAt ${campaign.expiresAt})`,
    };
  }
  return { active: true, expired: false, reason: null };
}

// ---------------------------------------------------------------------------------------------
// Loader — the ONLY place this module touches the filesystem. Never throws (every real failure
// mode has its own inner try/catch so its specific reason survives; the outer catch is pure
// defense-in-depth for the unforeseen). Never writes.
// ---------------------------------------------------------------------------------------------

export interface InnovationCampaignLoadResult {
  /** Resolved absolute path actually checked — ALWAYS populated, even when absent, so a
   *  misconfigured path reads as "absent AT <path>" rather than a bare "no file". */
  filePath: string;
  /** True iff currently admitting NEW entries right now. */
  active: boolean;
  /** True ONLY for "otherwise-valid campaign, but now() >= expiresAt" — a subset of !active. */
  expired: boolean;
  /** Null iff active === true; else the ONE specific blocking reason. */
  reason: string | null;
  /** Non-null whenever the file parsed + validated, REGARDLESS of active/enabled — so diagnostics
   *  can still show which campaign is sitting there turned off or expired. */
  campaign: InnovationCampaign | null;
}

function disabledResult(
  filePath: string,
  campaign: InnovationCampaign | null,
  reason: string,
  expired = false,
): InnovationCampaignLoadResult {
  return { filePath, active: false, expired, reason, campaign };
}

/**
 * Reads and validates the campaign file fresh — no caching, no module-level state. A restart (or
 * simply the next tick) re-reads from disk every time, so an operator edit takes effect without a
 * restart and a fresh process behaves identically to a live re-read of the same file.
 */
export function loadInnovationCampaign(
  dataDir = "data",
  fileName = "innovation-campaign.json",
  nowMs: number = Date.now(),
): InnovationCampaignLoadResult {
  const filePath = resolve(dataDir, fileName);
  try {
    if (!existsSync(filePath)) {
      return disabledResult(filePath, null, `no innovation campaign file present at ${filePath}`);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      return disabledResult(filePath, null, `campaign file unreadable: ${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error(`[innovation-campaign] ${filePath} is not valid JSON: ${(error as Error).message}`);
      return disabledResult(filePath, null, "campaign file is not valid JSON");
    }

    const validated = validateInnovationCampaign(parsed);
    if (!validated.ok) {
      console.error(`[innovation-campaign] ${filePath} failed validation: ${validated.reason}`);
      return disabledResult(filePath, null, `campaign invalid: ${validated.reason}`);
    }

    const campaign = validated.campaign;
    const window = campaignWindowStatus(campaign, nowMs);
    if (!window.active) {
      return disabledResult(filePath, campaign, window.reason ?? "campaign not currently active", window.expired);
    }
    return { filePath, active: true, expired: false, reason: null, campaign };
  } catch (error) {
    // Defense-in-depth only — every known failure mode is already handled above. isAllowed()/
    // entryHealthGate() run on a real-money-adjacent hot path every tick; an uncaught throw here
    // would either crash the process or silently propagate through a caller that swallows it.
    return disabledResult(filePath, null, `campaign loader failed unexpectedly: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Pure admission evaluator — no file I/O, no Date.now(). Takes an already-validated campaign (or
// null, meaning "no usable campaign") plus the caller-supplied current time and exposure, and
// returns a single allow/deny decision with a specific reason. Assumes `campaign`, if non-null,
// already passed validateInnovationCampaign (or is a hand-built valid test fixture) — this
// function re-checks enabled/window/lane/caps but does not re-validate schema-level shape.
//
// AUTHORITY (2026-08-05 fix — see this module's own header comment): enabled/window/lane-allowlist
// remain fully authoritative here — nothing else in the codebase re-checks those. The THREE cap
// branches (globalMaxPositions/globalNotionalCap/perLaneCaps) below are now a fast, racy,
// NON-authoritative pre-filter only — cheap enough to run once per tick before wasting a
// signal-loop iteration, but no longer what actually prevents an oversubscribed campaign.
// account-exposure-coordinator.ts's `reserve()` (fed by campaignCapForLane() below) is the real
// enforcement point for those three fields; it re-derives exposure atomically, inside its own
// single-flight-per-symbol-and-beyond synchronous call, from the same ledger its other 5 capacity
// axes already read.
// ---------------------------------------------------------------------------------------------

export interface InnovationCampaignAdmissionContext {
  laneId: string;
  nowIso: string;
  currentGlobalPositions: number;
  currentGlobalNotionalUsd: number;
  currentLanePositions: number;
  currentLaneNotionalUsd: number;
}

export interface InnovationCampaignAdmissionDecision {
  allowed: boolean;
  reason: string | null;
}

export function evaluateInnovationCampaignAdmission(
  campaign: InnovationCampaign | null,
  ctx: InnovationCampaignAdmissionContext,
): InnovationCampaignAdmissionDecision {
  if (!campaign) {
    return { allowed: false, reason: "no active innovation campaign" };
  }

  const nowMs = Date.parse(ctx.nowIso);
  const window = campaignWindowStatus(campaign, nowMs);
  if (!window.active) {
    return { allowed: false, reason: window.reason ?? "no active innovation campaign" };
  }

  if (!(campaign.allowedLaneIds as readonly string[]).includes(ctx.laneId)) {
    return {
      allowed: false,
      reason: `lane ${ctx.laneId} is not in campaign ${campaign.campaignId}'s allowedLaneIds`,
    };
  }

  if (ctx.currentGlobalPositions >= campaign.globalMaxPositions) {
    return {
      allowed: false,
      reason: `global innovation position cap reached (${ctx.currentGlobalPositions}/${campaign.globalMaxPositions})`,
    };
  }

  if (ctx.currentGlobalNotionalUsd >= campaign.globalNotionalCap) {
    return {
      allowed: false,
      reason: `global innovation notional cap reached ($${ctx.currentGlobalNotionalUsd.toFixed(2)}/$${campaign.globalNotionalCap})`,
    };
  }

  const laneCap = (campaign.perLaneCaps as Partial<Record<string, InnovationCampaignPerLaneCap>>)[ctx.laneId];
  if (laneCap) {
    if (laneCap.maxPositions !== undefined && ctx.currentLanePositions >= laneCap.maxPositions) {
      return {
        allowed: false,
        reason: `lane ${ctx.laneId} per-lane position cap reached (${ctx.currentLanePositions}/${laneCap.maxPositions})`,
      };
    }
    if (laneCap.maxNotionalUsd !== undefined && ctx.currentLaneNotionalUsd >= laneCap.maxNotionalUsd) {
      return {
        allowed: false,
        reason: `lane ${ctx.laneId} per-lane notional cap reached ($${ctx.currentLaneNotionalUsd.toFixed(2)}/$${laneCap.maxNotionalUsd})`,
      };
    }
  }

  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------------------------
// campaignCapForLane — the translation point from "a freshly loaded campaign" to
// account-exposure-coordinator.ts's ExposureReserveCampaignCap, the shape reserve()'s gate 2
// atomically enforces (see this module's own header comment). Pure, no I/O: `loaded` is assumed
// already produced by loadInnovationCampaign. This is the ONE place a loaded campaign's cap fields
// become the coordinator's own capacity axis — callers (the innovation executor construction sites
// in app.ts) must route through this function rather than hand-building an
// ExposureReserveCampaignCap, so there is exactly one source of truth for campaignLaneIds (see its
// own doc comment below) instead of a second, independently-maintainable copy that could drift.
// ---------------------------------------------------------------------------------------------

/**
 * Returns undefined whenever there is no CURRENTLY ACTIVE campaign to enforce for `laneId` — checks
 * `loaded.active`, NOT merely `loaded.campaign !== null`: loadInnovationCampaign returns a non-null
 * campaign even when merely `enabled:false` or outside its start/expiry window (see this file's own
 * `disabledResult` call sites above), so checking only `!loaded.campaign` would apply a DISABLED or
 * EXPIRED campaign's caps — backwards; the correct behavior for an inactive campaign is to apply NO
 * gate at all, not a stale one. Must never be simplified to drop the `active` check.
 *
 * Deliberately laneId-agnostic about allowedLaneIds: campaignCapForLane does not itself check
 * whether `laneId` is in `campaign.allowedLaneIds` — that remains isAllowed()/entryHealthGate()'s
 * own job via innovationCampaignAdmissionForLane (app.ts), checked once per tick, unchanged by this
 * fix. This function only ever supplies the three CAP fields; a lane outside allowedLaneIds simply
 * never reaches reserve() in the first place, so gate 2 never runs for it either.
 */
export function campaignCapForLane(
  loaded: InnovationCampaignLoadResult,
  laneId: string,
): ExposureReserveCampaignCap | undefined {
  if (!loaded.active || !loaded.campaign) return undefined;
  const laneCap = (loaded.campaign.perLaneCaps as Partial<Record<string, InnovationCampaignPerLaneCap>>)[laneId];
  return {
    campaignId: loaded.campaign.campaignId,
    // The FULL static universe, NOT loaded.campaign.allowedLaneIds — see
    // ExposureReserveCampaignCap.campaignLaneIds's own doc comment (account-exposure-coordinator.ts)
    // for why a narrowed allowedLaneIds must not stop counting an older lane's exposure against the
    // global cap. EXECUTABLE_INNOVATION_LANE_IDS is the ONE source of truth for this array — never
    // hand-duplicate it at a call site, or a 9th lane added later silently under-counts here.
    campaignLaneIds: EXECUTABLE_INNOVATION_LANE_IDS,
    globalMaxPositions: loaded.campaign.globalMaxPositions,
    globalNotionalCap: loaded.campaign.globalNotionalCap,
    laneMaxPositions: laneCap?.maxPositions,
    laneMaxNotionalUsd: laneCap?.maxNotionalUsd,
  };
}

// ---------------------------------------------------------------------------------------------
// Global exposure aggregation — mirrors live-executor-wiring.ts's computeNotionalPerSymbol
// pattern (same executor classes, same getStatus() fields, same "never undercount an orphan"
// convention) but scoped globally + grouped by laneId instead of by symbol, for the campaign's
// globalMaxPositions/globalNotionalCap/perLaneCaps checks.
//
// Counting convention: one CrossSectionalExecutor basket = 1 "position" (its notional is the sum
// of its still-open legs) — matches maxOpenBaskets, the executor's own per-instance admission cap.
// One orphaned leg = 1 "position" of its own, counted separately from any basket, because an
// orphan is real still-open exchange exposure a basket's own bookkeeping can no longer reach (see
// cross-sectional-executor.ts's OrphanedLeg doc comment) — omitting it would undercount real risk.
// One SingleSymbolLaneExecutor open position = 1 "position". A single-symbol lane's LONG and SHORT
// instances share one bare laneId (EXECUTABLE_INNOVATION_LANE_IDS carries no direction), so their
// exposure combines under one perLane entry, matching perLaneCaps' own keying.
// ---------------------------------------------------------------------------------------------

export interface InnovationLaneExposure {
  openPositions: number;
  openNotionalUsd: number;
}

export interface InnovationExposureSnapshot {
  totalOpenPositions: number;
  totalOpenNotionalUsd: number;
  perLane: Map<string, InnovationLaneExposure>;
}

export function computeInnovationExposure(
  basketExecutors: ReadonlyArray<CrossSectionalExecutor | null>,
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
): InnovationExposureSnapshot {
  const perLane = new Map<string, InnovationLaneExposure>();
  let totalOpenPositions = 0;
  let totalOpenNotionalUsd = 0;

  const bump = (laneId: string, positions: number, notionalUsd: number): void => {
    const cur = perLane.get(laneId) ?? { openPositions: 0, openNotionalUsd: 0 };
    cur.openPositions += positions;
    cur.openNotionalUsd += notionalUsd;
    perLane.set(laneId, cur);
    totalOpenPositions += positions;
    totalOpenNotionalUsd += notionalUsd;
  };

  for (const exec of basketExecutors) {
    if (!exec) continue;
    const status = exec.getStatus();
    for (const basket of status.openBaskets) {
      const notional = basket.legs.reduce(
        (sum, leg) => sum + (leg.exitOrderId === null ? Math.abs(leg.qty * leg.entryPrice) : 0),
        0,
      );
      bump(status.laneId, 1, notional);
    }
    for (const orphan of status.orphanedLegs) {
      bump(status.laneId, 1, Math.abs(orphan.qty * orphan.entryPrice));
    }
  }

  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    const status = exec.getStatus();
    for (const pos of status.openPositions) {
      if (pos.exitOrderId !== null) continue;
      bump(status.laneId, 1, Math.abs(pos.qty * pos.entryPrice));
    }
  }

  return { totalOpenPositions, totalOpenNotionalUsd, perLane };
}

// ---------------------------------------------------------------------------------------------
// Convenience wrapper: combines a load result + a live exposure snapshot into one admission
// decision for a single lane. This is what app.ts's per-tick isAllowed/entryHealthGate/
// isAllowedReason closures call — it never bypasses evaluateInnovationCampaignAdmission, it only
// supplies that function's inputs from the loaded campaign + the caller's exposure snapshot, so
// the diagnostics builder below (which calls this same function once per lane) can never drift
// from the actual per-instance gating logic.
// ---------------------------------------------------------------------------------------------

export function innovationCampaignAdmission(
  loaded: InnovationCampaignLoadResult,
  laneId: string,
  exposure: InnovationExposureSnapshot,
  nowIso: string = new Date().toISOString(),
): InnovationCampaignAdmissionDecision {
  if (!loaded.campaign) {
    return { allowed: false, reason: loaded.reason ?? "no active innovation campaign" };
  }
  const laneExposure = exposure.perLane.get(laneId) ?? { openPositions: 0, openNotionalUsd: 0 };
  return evaluateInnovationCampaignAdmission(loaded.campaign, {
    laneId,
    nowIso,
    currentGlobalPositions: exposure.totalOpenPositions,
    currentGlobalNotionalUsd: exposure.totalOpenNotionalUsd,
    currentLanePositions: laneExposure.openPositions,
    currentLaneNotionalUsd: laneExposure.openNotionalUsd,
  });
}

// ---------------------------------------------------------------------------------------------
// Diagnostics — surfaced via GET /api/live/innovation-executors' new `campaign` field (see
// routes/live.ts). Reuses innovationCampaignAdmission for every lane so this can never report a
// decision the real gates wouldn't also make.
// ---------------------------------------------------------------------------------------------

export interface InnovationCampaignDiagnostics {
  filePath: string;
  /** File existed AND parsed AND passed schema validation (regardless of enabled/window). */
  configured: boolean;
  /** Currently admitting NEW entries right now. */
  active: boolean;
  /** Specifically "was valid, now() >= expiresAt" (subset of !active). */
  expired: boolean;
  /** Null iff active === true; else the ONE computed blocking reason. */
  statusReason: string | null;
  campaignId: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  allowedLaneIds: readonly string[];
  globalMaxPositions: number | null;
  globalNotionalCap: number | null;
  perLaneCaps: Partial<Record<string, InnovationCampaignPerLaneCap>>;
  /** The campaign's OWN `reason` field (operator's free-text purpose) — deliberately renamed here
   *  so it can never be confused with statusReason above. */
  metadataReason: string | null;
  metadataOwner: string | null;
  exposure: {
    totalOpenPositions: number;
    totalOpenNotionalUsd: number;
    perLane: Record<string, InnovationLaneExposure>;
  };
  /** One entry for EVERY EXECUTABLE_INNOVATION_LANE_IDS id (not just allowedLaneIds), always — so
   *  an operator can see both "why is X allowed" and "why is Y (not even in the campaign) blocked"
   *  in one place. Reports ONLY the campaign's own decision, never ANDed with the engine's
   *  armed/kill/drain/regime gate — a null reason here means "not blocked by the campaign", not
   *  "not blocked at all" (matches this codebase's existing entryBlockReason convention). */
  laneAdmission: Record<string, InnovationCampaignAdmissionDecision>;
}

export function buildInnovationCampaignDiagnostics(
  loaded: InnovationCampaignLoadResult,
  exposure: InnovationExposureSnapshot,
  nowIso: string = new Date().toISOString(),
): InnovationCampaignDiagnostics {
  const laneAdmission: Record<string, InnovationCampaignAdmissionDecision> = {};
  for (const laneId of EXECUTABLE_INNOVATION_LANE_IDS) {
    laneAdmission[laneId] = innovationCampaignAdmission(loaded, laneId, exposure, nowIso);
  }
  return {
    filePath: loaded.filePath,
    configured: loaded.campaign !== null,
    active: loaded.active,
    expired: loaded.expired,
    statusReason: loaded.reason,
    campaignId: loaded.campaign?.campaignId ?? null,
    startsAt: loaded.campaign?.startsAt ?? null,
    expiresAt: loaded.campaign?.expiresAt ?? null,
    allowedLaneIds: loaded.campaign?.allowedLaneIds ?? [],
    globalMaxPositions: loaded.campaign?.globalMaxPositions ?? null,
    globalNotionalCap: loaded.campaign?.globalNotionalCap ?? null,
    perLaneCaps: loaded.campaign?.perLaneCaps ?? {},
    metadataReason: loaded.campaign?.reason ?? null,
    metadataOwner: loaded.campaign?.owner ?? null,
    exposure: {
      totalOpenPositions: exposure.totalOpenPositions,
      totalOpenNotionalUsd: exposure.totalOpenNotionalUsd,
      // Map does NOT survive JSON.stringify (silently becomes {}) — must convert before this ever
      // reaches a Fastify route handler.
      perLane: Object.fromEntries(exposure.perLane),
    },
    laneAdmission,
  };
}
