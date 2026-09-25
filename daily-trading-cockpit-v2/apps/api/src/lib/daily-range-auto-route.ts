/**
 * Pure AUTO_ROUTE_NY state transition.
 *
 * Runtime uses this exact function and reconstructed-candle research imports
 * the same function. It has no store, clock, network, allocation, or order
 * dependency, so replay cannot silently become a second interpretation of the
 * live route semantics.
 */

export const DAILY_RANGE_AUTO_ROUTE_EPSILON = 1e-9;

export type DailyRangeAutoRouteDirection = "UP" | "DOWN";
export type DailyRangeAutoRouteTradeDirection = "LONG" | "SHORT";
export type DailyRangeAutoRoutePolicy = "CONTINUATION" | "FADE";
/**
 * V3 chooses one simple route policy per environment.  The default preserves
 * the historical V2 replay exactly, while the two explicit modes avoid any
 * hidden C2/C3 wait in the production decision path.
 */
export type DailyRangeAutoRouteEntryMode =
  | "FOLLOW_THROUGH_OR_FIRST_REENTRY"
  | "FADE_FIRST_REENTRY_ONLY"
  | "CONTINUATION_FIRST_OUTSIDE_CLOSE";
export type DailyRangeAutoRouteEntryTiming =
  | "FIRST_OUTSIDE_CLOSE"
  | "FOLLOW_THROUGH_CLOSE"
  | "FIRST_REENTRY_CLOSE";
/** Canonical close-only relationship to the frozen reference range. */
export type DailyRangeAutoRouteRangePosition = "ABOVE" | "BELOW" | "INSIDE";

export interface DailyRangeAutoRouteCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DailyRangeAutoRouteState {
  phase: "IDLE" | "ARMED" | "CONTINUATION_LOCKED";
  breakoutId: string | null;
  breakoutDirection: DailyRangeAutoRouteDirection | null;
  firstOutsideCandle: DailyRangeAutoRouteCandle | null;
  lastOutsideCandle: DailyRangeAutoRouteCandle | null;
  breakoutExtreme: number | null;
  outsideCloseCount: number;
  maxCloseExtension: number;
}

export interface DailyRangeAutoRouteDecision {
  entryPolicy: DailyRangeAutoRoutePolicy;
  breakoutDirection: DailyRangeAutoRouteDirection;
  direction: DailyRangeAutoRouteTradeDirection;
  breakoutId: string;
  breakoutExtreme: number;
  confirmationBar1: DailyRangeAutoRouteCandle;
  confirmationBar2: DailyRangeAutoRouteCandle;
  /** Explicitly distinguishes a first-breakout entry from historical C2. */
  entryTiming?: DailyRangeAutoRouteEntryTiming;
}

export interface DailyRangeAutoRouteTransition {
  state: DailyRangeAutoRouteState;
  decision: DailyRangeAutoRouteDecision | null;
}

export function blankDailyRangeAutoRouteState(): DailyRangeAutoRouteState {
  return {
    phase: "IDLE",
    breakoutId: null,
    breakoutDirection: null,
    firstOutsideCandle: null,
    lastOutsideCandle: null,
    breakoutExtreme: null,
    outsideCloseCount: 0,
    maxCloseExtension: 0,
  };
}

function cloneCandle(candle: DailyRangeAutoRouteCandle | null): DailyRangeAutoRouteCandle | null {
  return candle ? { ...candle } : null;
}

function cloneState(state: DailyRangeAutoRouteState | null | undefined): DailyRangeAutoRouteState {
  const source = state ?? blankDailyRangeAutoRouteState();
  return {
    ...source,
    firstOutsideCandle: cloneCandle(source.firstOutsideCandle),
    lastOutsideCandle: cloneCandle(source.lastOutsideCandle),
  };
}

/**
 * Shared boundary semantics for AUTO_ROUTE_NY_V2. Equality is inside the
 * reference range. Both router and route-exit invalidation call this helper so
 * a later policy cannot silently reinterpret a close at the boundary.
 */
export function dailyRangeAutoRouteRangePosition(
  close: number,
  rangeHigh: number,
  rangeLow: number,
): DailyRangeAutoRouteRangePosition {
  if (!Number.isFinite(close) || !Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) || rangeHigh < rangeLow) return "INSIDE";
  return close > rangeHigh + DAILY_RANGE_AUTO_ROUTE_EPSILON
    ? "ABOVE"
    : close < rangeLow - DAILY_RANGE_AUTO_ROUTE_EPSILON ? "BELOW" : "INSIDE";
}

function positionFor(candle: DailyRangeAutoRouteCandle, rangeHigh: number, rangeLow: number): DailyRangeAutoRouteRangePosition {
  return dailyRangeAutoRouteRangePosition(candle.close, rangeHigh, rangeLow);
}

function directionFor(position: "ABOVE" | "BELOW"): DailyRangeAutoRouteDirection {
  return position === "ABOVE" ? "UP" : "DOWN";
}

function extensionFor(direction: DailyRangeAutoRouteDirection, candle: DailyRangeAutoRouteCandle, rangeHigh: number, rangeLow: number): number {
  return direction === "UP" ? candle.close - rangeHigh : rangeLow - candle.close;
}

function extremeFor(direction: DailyRangeAutoRouteDirection, candle: DailyRangeAutoRouteCandle): number {
  return direction === "UP" ? candle.high : candle.low;
}

function mergeExtreme(direction: DailyRangeAutoRouteDirection, prior: number | null, candle: DailyRangeAutoRouteCandle): number {
  const current = extremeFor(direction, candle);
  return prior === null ? current : direction === "UP" ? Math.max(prior, current) : Math.min(prior, current);
}

/**
 * Advance exactly one completed 5m candle. The breakout id format is retained
 * byte-for-byte from the incumbent lane so durable and replayed lineage agree.
 */
export function advanceDailyRangeAutoRoute(input: {
  dateUtc: string;
  symbol: string;
  rangeHigh: number;
  rangeLow: number;
  state: DailyRangeAutoRouteState | null | undefined;
  candle: DailyRangeAutoRouteCandle;
  /** Omitted is the byte-for-byte incumbent V2 route. */
  entryMode?: DailyRangeAutoRouteEntryMode;
}): DailyRangeAutoRouteTransition {
  const state = cloneState(input.state);
  const entryMode = input.entryMode ?? "FOLLOW_THROUGH_OR_FIRST_REENTRY";
  const position = positionFor(input.candle, input.rangeHigh, input.rangeLow);
  const arm = (direction: DailyRangeAutoRouteDirection): DailyRangeAutoRouteState => ({
    phase: "ARMED",
    breakoutId: `drra2-break-${input.dateUtc.replaceAll("-", "")}-${input.symbol.toLowerCase().slice(0, 8)}-${direction[0]}-${input.candle.closeTime.toString(36)}`.slice(0, 72),
    breakoutDirection: direction,
    firstOutsideCandle: { ...input.candle },
    lastOutsideCandle: { ...input.candle },
    breakoutExtreme: extremeFor(direction, input.candle),
    outsideCloseCount: 1,
    maxCloseExtension: extensionFor(direction, input.candle, input.rangeHigh, input.rangeLow),
  });

  if (state.phase === "IDLE") {
    if (position === "INSIDE") return { state, decision: null };
    const breakoutDirection = directionFor(position);
    const armed = arm(breakoutDirection);
    if (entryMode !== "CONTINUATION_FIRST_OUTSIDE_CLOSE") {
      return { state: armed, decision: null };
    }
    const breakoutId = armed.breakoutId;
    const breakoutExtreme = armed.breakoutExtreme;
    if (!breakoutId || breakoutExtreme === null) return { state: armed, decision: null };
    return {
      state: { ...armed, phase: "CONTINUATION_LOCKED" },
      decision: {
        entryPolicy: "CONTINUATION",
        breakoutDirection,
        direction: breakoutDirection === "UP" ? "LONG" : "SHORT",
        breakoutId,
        breakoutExtreme,
        // The completed C1 itself is the only causal confirmation. The lane
        // records this explicitly instead of pretending a non-existent C2.
        confirmationBar1: { ...input.candle },
        confirmationBar2: { ...input.candle },
        entryTiming: "FIRST_OUTSIDE_CLOSE",
      },
    };
  }
  if (state.phase === "CONTINUATION_LOCKED") {
    return { state: position === "INSIDE" ? blankDailyRangeAutoRouteState() : state, decision: null };
  }

  const breakoutDirection = state.breakoutDirection;
  const previousOutside = state.lastOutsideCandle;
  if (!breakoutDirection || !previousOutside) {
    return { state: position === "INSIDE" ? blankDailyRangeAutoRouteState() : arm(directionFor(position)), decision: null };
  }
  const sameOutside = (breakoutDirection === "UP" && position === "ABOVE") || (breakoutDirection === "DOWN" && position === "BELOW");
  if (sameOutside) {
    const extension = extensionFor(breakoutDirection, input.candle, input.rangeHigh, input.rangeLow);
    const priorMaximum = state.maxCloseExtension;
    state.lastOutsideCandle = { ...input.candle };
    state.breakoutExtreme = mergeExtreme(breakoutDirection, state.breakoutExtreme, input.candle);
    state.outsideCloseCount += 1;
    state.maxCloseExtension = Math.max(state.maxCloseExtension, extension);
    if (
      entryMode !== "FADE_FIRST_REENTRY_ONLY"
      && state.outsideCloseCount >= 2
      && extension > priorMaximum + DAILY_RANGE_AUTO_ROUTE_EPSILON
    ) {
      const direction: DailyRangeAutoRouteTradeDirection = breakoutDirection === "UP" ? "LONG" : "SHORT";
      const breakoutId = state.breakoutId;
      const breakoutExtreme = state.breakoutExtreme;
      if (!breakoutId || breakoutExtreme === null) return { state, decision: null };
      return {
        state: { ...state, phase: "CONTINUATION_LOCKED" },
        decision: {
          entryPolicy: "CONTINUATION",
          breakoutDirection,
          direction,
          breakoutId,
          breakoutExtreme,
          confirmationBar1: previousOutside,
          confirmationBar2: { ...input.candle },
          entryTiming: "FOLLOW_THROUGH_CLOSE",
        },
      };
    }
    return { state, decision: null };
  }
  if (position === "INSIDE") {
    const breakoutExtreme = mergeExtreme(breakoutDirection, state.breakoutExtreme, input.candle);
    const breakoutId = state.breakoutId;
    if (!breakoutId) return { state: blankDailyRangeAutoRouteState(), decision: null };
    return {
      state: blankDailyRangeAutoRouteState(),
      decision: {
        entryPolicy: "FADE",
        breakoutDirection,
        direction: breakoutDirection === "UP" ? "SHORT" : "LONG",
        breakoutId,
        breakoutExtreme,
        confirmationBar1: previousOutside,
        confirmationBar2: { ...input.candle },
        entryTiming: "FIRST_REENTRY_CLOSE",
      },
    };
  }
  // Directly through the entire range: spend neither a fade nor continuation.
  return { state: arm(directionFor(position)), decision: null };
}
