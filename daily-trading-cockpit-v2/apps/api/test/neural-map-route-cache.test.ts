import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

// /api/shadow/neural-map's report builders (buildCurrentGuardVariantMatrixReport over the
// variant-matrix store, buildPaperPerformanceReport, live mark-price fetch) got expensive enough
// (2026-07-06 profiling: 5-10s on the production data volume) that the dashboard's 5s auto-refresh
// was permanently queuing requests behind each other. The route now short-TTL-caches its result and
// dedupes concurrent in-flight calls to one computation — this locks in that concurrent callers
// never trigger the expensive work twice.
describe("/api/shadow/neural-map response caching", () => {
  it("concurrent requests share one computation (same generatedAt, not recomputed per request)", async () => {
    const app = await buildApp({});
    const [first, second, third] = await Promise.all([
      app.inject({ method: "GET", url: "/api/shadow/neural-map" }),
      app.inject({ method: "GET", url: "/api/shadow/neural-map" }),
      app.inject({ method: "GET", url: "/api/shadow/neural-map" }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    const a = first.json();
    const b = second.json();
    const c = third.json();
    expect(a.generatedAt).toBeTruthy();
    expect(b.generatedAt).toBe(a.generatedAt);
    expect(c.generatedAt).toBe(a.generatedAt);
  });

  it("a request after the cache TTL elapses recomputes (fresh generatedAt)", async () => {
    const app = await buildApp({});
    const first = await app.inject({ method: "GET", url: "/api/shadow/neural-map" });
    await new Promise((resolve) => setTimeout(resolve, 6_100));
    const second = await app.inject({ method: "GET", url: "/api/shadow/neural-map" });
    expect(first.json().generatedAt).not.toBe(second.json().generatedAt);
  }, 12_000);
});
