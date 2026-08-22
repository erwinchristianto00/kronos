import { describe, expect, it } from "vitest";

import { CrossSectionalRouteCoordinator } from "../src/lib/cross-sectional-route-coordinator.js";

describe("CrossSectionalRouteCoordinator", () => {
  it("blocks directional formation while any market-neutral basket remains live", () => {
    let marketNeutral = true;
    const coordinator = new CrossSectionalRouteCoordinator({
      hasMarketNeutralExposure: () => marketNeutral,
      hasDirectionalExposure: () => false,
    });

    expect(coordinator.admissionFor("DIRECTIONAL")).toEqual({
      allowed: false,
      reason: "legacy market-neutral basket is still open or being formed",
    });

    marketNeutral = false;
    expect(coordinator.admissionFor("DIRECTIONAL")).toEqual({ allowed: true, reason: null });
  });

  it("blocks a new market-neutral basket while directional exposure or a pending maker order exists", () => {
    let directional = true;
    const coordinator = new CrossSectionalRouteCoordinator({
      hasMarketNeutralExposure: () => false,
      hasDirectionalExposure: () => directional,
    });

    expect(coordinator.admissionFor("MARKET_NEUTRAL")).toEqual({
      allowed: false,
      reason: "directional cross-sectional basket is still open or pending",
    });

    directional = false;
    expect(coordinator.admissionFor("MARKET_NEUTRAL")).toEqual({ allowed: true, reason: null });
  });

  it("serializes simultaneous flat-account formation attempts until the holder releases its claim", () => {
    const coordinator = new CrossSectionalRouteCoordinator({
      hasMarketNeutralExposure: () => false,
      hasDirectionalExposure: () => false,
    });

    expect(coordinator.tryClaim("MARKET_NEUTRAL")).toEqual({ allowed: true, reason: null });
    expect(coordinator.inFlightRoute()).toBe("MARKET_NEUTRAL");
    expect(coordinator.tryClaim("DIRECTIONAL")).toEqual({
      allowed: false,
      reason: "market-neutral cross-sectional entry is already being formed",
    });

    coordinator.release("DIRECTIONAL");
    expect(coordinator.inFlightRoute()).toBe("MARKET_NEUTRAL");
    coordinator.release("MARKET_NEUTRAL");
    expect(coordinator.tryClaim("DIRECTIONAL")).toEqual({ allowed: true, reason: null });
  });
});
