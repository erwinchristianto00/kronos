/**
 * Cross-sectional route coordinator.
 *
 * The legacy 3L/3S executor and the directional 3L / 3S companion are two
 * different ways to consume the same cross-sectional opportunity. They must
 * never establish new exposure together: a market-neutral basket plus a
 * directional basket is a materially different, levered portfolio rather than
 * a harmless second signal.
 *
 * This class closes both windows:
 * - durable state supplied by the callers blocks a route while the other route
 *   has OPEN, RESERVED, PLACING, or pending-maker exposure; and
 * - the synchronous in-flight claim blocks two executors that read the same
 *   flat account before either one has persisted its first order.
 */

export type CrossSectionalRoute = "MARKET_NEUTRAL" | "DIRECTIONAL";

export interface CrossSectionalRouteAdmission {
  allowed: boolean;
  reason: string | null;
}

export interface CrossSectionalRouteCoordinatorOptions {
  hasMarketNeutralExposure: () => boolean;
  hasDirectionalExposure: () => boolean;
}

export class CrossSectionalRouteCoordinator {
  private readonly hasMarketNeutralExposure: () => boolean;
  private readonly hasDirectionalExposure: () => boolean;
  private inFlight: CrossSectionalRoute | null = null;

  constructor(opts: CrossSectionalRouteCoordinatorOptions) {
    this.hasMarketNeutralExposure = opts.hasMarketNeutralExposure;
    this.hasDirectionalExposure = opts.hasDirectionalExposure;
  }

  /** Read-only gate used by normal executor admission checks. */
  admissionFor(route: CrossSectionalRoute): CrossSectionalRouteAdmission {
    if (this.inFlight !== null && this.inFlight !== route) {
      return {
        allowed: false,
        reason: `${this.inFlight === "DIRECTIONAL" ? "directional" : "market-neutral"} cross-sectional entry is still being formed`,
      };
    }
    if (route === "MARKET_NEUTRAL" && this.hasDirectionalExposure()) {
      return { allowed: false, reason: "directional cross-sectional basket is still open or pending" };
    }
    if (route === "DIRECTIONAL" && this.hasMarketNeutralExposure()) {
      return { allowed: false, reason: "legacy market-neutral basket is still open or being formed" };
    }
    if (route === "DIRECTIONAL" && this.hasDirectionalExposure()) {
      return { allowed: false, reason: "directional cross-sectional basket is still open or pending" };
    }
    return { allowed: true, reason: null };
  }

  /**
   * Atomic within Node's event loop: no await occurs between admission and the
   * claim assignment. A caller MUST release after its formation attempt ends.
   */
  tryClaim(route: CrossSectionalRoute): CrossSectionalRouteAdmission {
    if (this.inFlight !== null) {
      return {
        allowed: false,
        reason: `${this.inFlight === "DIRECTIONAL" ? "directional" : "market-neutral"} cross-sectional entry is already being formed`,
      };
    }
    const admission = this.admissionFor(route);
    if (!admission.allowed) return admission;
    this.inFlight = route;
    return { allowed: true, reason: null };
  }

  release(route: CrossSectionalRoute): void {
    if (this.inFlight === route) this.inFlight = null;
  }

  inFlightRoute(): CrossSectionalRoute | null {
    return this.inFlight;
  }
}
