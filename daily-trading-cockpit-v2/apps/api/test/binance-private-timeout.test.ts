import { describe, it, expect } from "vitest";
import { REQUEST_TIMEOUT_MS } from "../src/lib/binance-futures-private.js";

/**
 * Measured 2026-08-18 during a Binance Futures Testnet backend outage, from the VPS, outside this
 * application: every authenticated endpoint (positionRisk, account, balance, openOrders) failed at
 * a consistent ~8,080-8,103ms with HTTP 408 / -1007, 8 attempts out of 8, while the gateway
 * answered a deliberately malformed key in 80-88ms. So ~8.08s is Binance's own server-side ceiling.
 */
const BINANCE_SERVER_CEILING_MS = 8_103;

describe("binance-futures-private REQUEST_TIMEOUT_MS", () => {
  it("clears Binance's measured ~8.08s server ceiling, so a slow-but-alive backend still answers", () => {
    // Below the ceiling we abort first and turn a knowable outcome into an unknown one. This
    // timeout covers POST and DELETE as well as GET, and -1007 says outright "Send status unknown;
    // execution status unknown" — aborting early on an order placement is how the recurring
    // "invisible naked position" bug class starts.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(BINANCE_SERVER_CEILING_MS);
  });

  it("stays well inside the 25s tick interval so a slow call cannot stall the loop", () => {
    // tick() runs every 25s behind an `if (this.ticking) return` guard: a slow tick skips the next
    // one rather than overlapping, but a timeout at or above the interval would stall it outright.
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(25_000);
  });
});
