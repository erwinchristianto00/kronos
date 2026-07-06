import { describe, it, expect } from "vitest";
import { clusterOf, isMajorSymbol, MAJORS_CLUSTER, OTHER_CLUSTER } from "../src/lib/correlation-clusters.js";

describe("correlation clusters", () => {
  it("maps known symbols to their category cluster", () => {
    expect(clusterOf("SOLUSDT")).toBe("L1");
    expect(clusterOf("SUIUSDT")).toBe("L1");
    expect(clusterOf("SEIUSDT")).toBe("L1");
    expect(clusterOf("LINKUSDT")).toBe("L2_DEFI");
    expect(clusterOf("ARBUSDT")).toBe("L2_DEFI");
    expect(clusterOf("DOGEUSDT")).toBe("MEME");
    expect(clusterOf("WLDUSDT")).toBe("AI");
  });

  it("treats BTC/ETH as MAJORS and exempts them from the per-cluster cap", () => {
    expect(clusterOf("BTCUSDT")).toBe(MAJORS_CLUSTER);
    expect(clusterOf("ETHUSDT")).toBe(MAJORS_CLUSTER);
    expect(isMajorSymbol("BTCUSDT")).toBe(true);
    expect(isMajorSymbol("ETHUSDT")).toBe(true);
    expect(isMajorSymbol("SOLUSDT")).toBe(false);
  });

  it("puts unknown symbols in a single shared OTHER cluster (conservative)", () => {
    expect(clusterOf("ZZZUNKNOWNUSDT")).toBe(OTHER_CLUSTER);
    expect(clusterOf("QQQFAKEUSDT")).toBe(OTHER_CLUSTER);
    // both unknowns share ONE cluster → they contend for the same cap slot, not each free
    expect(clusterOf("ZZZUNKNOWNUSDT")).toBe(clusterOf("QQQFAKEUSDT"));
  });

  it("is case-insensitive", () => {
    expect(clusterOf("solusdt")).toBe("L1");
    expect(isMajorSymbol("btcusdt")).toBe(true);
  });

  it("honors a CORRELATION_CLUSTER_MAP_JSON override", () => {
    const env = { CORRELATION_CLUSTER_MAP_JSON: JSON.stringify({ MAJORS: ["BTCUSDT"], CUSTOM: ["FOOUSDT", "BARUSDT"] }) };
    expect(clusterOf("FOOUSDT", env)).toBe("CUSTOM");
    expect(clusterOf("BARUSDT", env)).toBe("CUSTOM");
    expect(clusterOf("SOLUSDT", env)).toBe(OTHER_CLUSTER); // not in the override → OTHER
  });
});
