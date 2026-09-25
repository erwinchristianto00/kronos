import { describe, expect, it } from "vitest";

import {
  DAILY_RANGE_CROSS_SECTIONAL_RETURN_LEAD_MS,
  dailyRangeCrossSectionalBorrowEntryGate,
  resolveDailyRangeCrossSectionalBorrowing,
} from "../src/lib/daily-range-cross-sectional-borrowing.js";

const NOW = 1_760_000_000_000;
const MOM36 = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];

describe("Daily Range unused MOM36 borrowing", () => {
  it("keeps every MOM36 symbol reserved when no Cross-Sectional basket is active", () => {
    const decision = resolveDailyRangeCrossSectionalBorrowing({
      crossSectionalUniverse: MOM36,
      activeBaskets: [],
      nowMs: NOW,
    });

    expect(decision.state).toBe("NO_ACTIVE_CROSS_SECTIONAL_BASKET");
    expect(decision.reservedCrossSectionalSymbols).toEqual(MOM36);
    expect(decision.borrowableSymbols).toEqual([]);
    expect(dailyRangeCrossSectionalBorrowEntryGate("AAAUSDT", decision).allowed).toBe(false);
    expect(dailyRangeCrossSectionalBorrowEntryGate("OUTSIDEUSDT", decision).allowed).toBe(true);
  });

  it("lends only unused symbols while an active basket has more than one hour remaining", () => {
    const decision = resolveDailyRangeCrossSectionalBorrowing({
      crossSectionalUniverse: MOM36,
      activeBaskets: [{
        basketId: "xb-test",
        closesAtMs: NOW + 2 * 60 * 60_000,
        // Planned legs are reserved the same as filled legs.
        symbols: ["AAAUSDT", "BBBUSDT"],
      }],
      nowMs: NOW,
    });

    expect(decision.state).toBe("BORROWING_ACTIVE");
    expect(decision.reservedCrossSectionalSymbols).toEqual(["AAAUSDT", "BBBUSDT"]);
    expect(decision.borrowableSymbols).toEqual(["CCCUSDT"]);
    expect(dailyRangeCrossSectionalBorrowEntryGate("CCCUSDT", decision).allowed).toBe(true);
    expect(dailyRangeCrossSectionalBorrowEntryGate("AAAUSDT", decision).allowed).toBe(false);
  });

  it("returns all MOM36 symbols exactly one hour before the earliest basket close", () => {
    const decision = resolveDailyRangeCrossSectionalBorrowing({
      crossSectionalUniverse: MOM36,
      activeBaskets: [{
        basketId: "xb-test",
        closesAtMs: NOW + DAILY_RANGE_CROSS_SECTIONAL_RETURN_LEAD_MS,
        symbols: ["AAAUSDT"],
      }],
      nowMs: NOW,
    });

    expect(decision.state).toBe("RETURNED_TO_CROSS_SECTIONAL");
    expect(decision.reservedCrossSectionalSymbols).toEqual(MOM36);
    expect(decision.borrowableSymbols).toEqual([]);
  });

  it("fails closed when an active basket lacks a trustworthy close deadline", () => {
    const decision = resolveDailyRangeCrossSectionalBorrowing({
      crossSectionalUniverse: MOM36,
      activeBaskets: [{ basketId: "xb-unknown", closesAtMs: null, symbols: ["AAAUSDT"] }],
      nowMs: NOW,
    });

    expect(decision.state).toBe("RETURNED_TO_CROSS_SECTIONAL");
    expect(decision.borrowableSymbols).toEqual([]);
    expect(decision.reason).toContain("fail-closed");
  });
});
