import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  validateInnovationCampaign,
  loadInnovationCampaign,
  evaluateInnovationCampaignAdmission,
  innovationCampaignAdmission,
  computeInnovationExposure,
  buildInnovationCampaignDiagnostics,
  campaignCapForLane,
  type InnovationCampaign,
  type InnovationCampaignAdmissionContext,
  type InnovationCampaignLoadResult,
  type InnovationExposureSnapshot,
} from "../src/lib/innovation-campaign.js";
import { EXECUTABLE_INNOVATION_LANE_IDS } from "../src/lib/innovation-testnet-execution.js";
import type { CrossSectionalExecutor, ExecutorBasket, ExecutorLeg, OrphanedLeg } from "../src/lib/cross-sectional-executor.js";
import {
  SingleSymbolLaneExecutor,
  SingleSymbolLaneExecutorStore,
  makeFixedRewardExitPolicy,
  type SingleSymbolPosition,
} from "../src/lib/single-symbol-lane-executor.js";

// Pull 3 real lane ids out of the actual roster rather than hardcoding string literals — if the
// roster is ever renamed/reordered, this file tracks it instead of silently testing stale ids.
const [LANE_1, LANE_2, LANE_3] = EXECUTABLE_INNOVATION_LANE_IDS;

const dirs: string[] = [];
let dirSeq = 0;
function tmpDir(): string {
  const dir = resolve(os.tmpdir(), `innovation-campaign-${process.pid}-${++dirSeq}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  dirs.length = 0;
});

/** A fully valid, schema-passing campaign JSON body. Each test overrides only the field(s) it
 *  actually wants to exercise, so a failing assertion can only ever be attributed to that one
 *  field — never to some OTHER field this fixture happened to leave malformed. */
function validCampaignJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: "camp-1",
    enabled: true,
    allowedLaneIds: [LANE_1, LANE_2],
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-10T00:00:00.000Z",
    globalMaxPositions: 5,
    globalNotionalCap: 1000,
    perLaneCaps: {},
    reason: "test campaign",
    owner: "erwin",
    ...over,
  };
}

// =================================================================================================
// validateInnovationCampaign — one test per schema rule (in the order the module's own doc
// comment enumerates them), each a MINIMAL corruption of validCampaignJson() so a failure can only
// be attributed to the one rule under test.
// =================================================================================================
describe("validateInnovationCampaign", () => {
  it("accepts a fully valid campaign, trimming campaignId", () => {
    const result = validateInnovationCampaign(validCampaignJson({ campaignId: "  camp-1  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.campaign.campaignId).toBe("camp-1");
    expect(result.campaign.allowedLaneIds).toEqual([LANE_1, LANE_2]);
    expect(result.campaign.perLaneCaps).toEqual({});
  });

  it("defaults perLaneCaps/reason/owner to {}/null/null when omitted entirely (never undefined)", () => {
    const json = validCampaignJson();
    delete json.perLaneCaps;
    delete json.reason;
    delete json.owner;
    const result = validateInnovationCampaign(json);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.campaign.perLaneCaps).toEqual({});
    expect(result.campaign.reason).toBeNull();
    expect(result.campaign.owner).toBeNull();
  });

  describe("rule 1: must be a plain object (not null/array/primitive)", () => {
    const cases: unknown[] = [null, [], "a string", 42, true];
    for (const bad of cases) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        const result = validateInnovationCampaign(bad);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).toBe("campaign file must contain a single JSON object");
      });
    }
  });

  describe("rule 2: campaignId", () => {
    it("rejects a missing campaignId", () => {
      const json = validCampaignJson();
      delete json.campaignId;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("campaignId missing or empty");
    });
    it("rejects a whitespace-only campaignId", () => {
      const result = validateInnovationCampaign(validCampaignJson({ campaignId: "   " }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("campaignId missing or empty");
    });
    it("rejects a non-string campaignId", () => {
      const result = validateInnovationCampaign(validCampaignJson({ campaignId: 123 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("campaignId missing or empty");
    });
  });

  describe("rule 3: enabled (strict boolean, no coercion)", () => {
    it("rejects a missing enabled", () => {
      const json = validCampaignJson();
      delete json.enabled;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("enabled missing or not a boolean");
    });
    it('rejects the string "true"', () => {
      const result = validateInnovationCampaign(validCampaignJson({ enabled: "true" }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("enabled missing or not a boolean");
    });
    it("rejects the number 1", () => {
      const result = validateInnovationCampaign(validCampaignJson({ enabled: 1 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("enabled missing or not a boolean");
    });
  });

  describe("rule 4: allowedLaneIds", () => {
    it("rejects a missing allowedLaneIds", () => {
      const json = validCampaignJson();
      delete json.allowedLaneIds;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("allowedLaneIds missing or not an array");
    });
    it("rejects a non-array allowedLaneIds", () => {
      const result = validateInnovationCampaign(validCampaignJson({ allowedLaneIds: "not-an-array" }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("allowedLaneIds missing or not an array");
    });
    it("rejects an id outside EXECUTABLE_INNOVATION_LANE_IDS", () => {
      const result = validateInnovationCampaign(validCampaignJson({ allowedLaneIds: ["NOT_A_REAL_LANE"] }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe(
        "allowedLaneIds contains an id outside EXECUTABLE_INNOVATION_LANE_IDS: NOT_A_REAL_LANE",
      );
    });
    it("rejects a non-string element", () => {
      const result = validateInnovationCampaign(validCampaignJson({ allowedLaneIds: [123] }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe(
        "allowedLaneIds contains an id outside EXECUTABLE_INNOVATION_LANE_IDS: 123",
      );
    });
    it("ACCEPTS an empty array — a well-formed campaign authorizing zero lanes, not malformed", () => {
      const result = validateInnovationCampaign(validCampaignJson({ allowedLaneIds: [] }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.campaign.allowedLaneIds).toEqual([]);
    });
  });

  describe("rules 5/6: startsAt / expiresAt must be zoned ISO instants", () => {
    it("rejects a missing startsAt", () => {
      const json = validCampaignJson();
      delete json.startsAt;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/startsAt/);
    });
    it("rejects an unparseable startsAt", () => {
      const result = validateInnovationCampaign(validCampaignJson({ startsAt: "not-a-date" }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/startsAt/);
    });
    it("rejects a startsAt with no explicit UTC/offset marker (ambiguous local time)", () => {
      const result = validateInnovationCampaign(validCampaignJson({ startsAt: "2026-08-01T00:00:00.000" }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/startsAt/);
    });
    it("accepts an explicit +/-HH:MM offset, not only Z", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ startsAt: "2026-08-01T00:00:00.000+07:00", expiresAt: "2026-08-10T00:00:00.000+07:00" }),
      );
      expect(result.ok).toBe(true);
    });
    it("rejects a missing expiresAt", () => {
      const json = validCampaignJson();
      delete json.expiresAt;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/expiresAt/);
    });
    it("rejects an expiresAt with no explicit UTC/offset marker", () => {
      const result = validateInnovationCampaign(validCampaignJson({ expiresAt: "2026-08-10T00:00:00.000" }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/expiresAt/);
    });
  });

  describe("rule 7: expiresAt must be strictly after startsAt", () => {
    it("rejects expiresAt === startsAt", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ startsAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("expiresAt must be after startsAt");
    });
    it("rejects expiresAt before startsAt", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ startsAt: "2026-08-10T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("expiresAt must be after startsAt");
    });
  });

  describe("rule 8: globalMaxPositions (positive finite INTEGER)", () => {
    it("rejects a missing globalMaxPositions", () => {
      const json = validCampaignJson();
      delete json.globalMaxPositions;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalMaxPositions must be a positive finite integer");
    });
    it("rejects zero", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalMaxPositions: 0 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalMaxPositions must be a positive finite integer");
    });
    it("rejects a negative value", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalMaxPositions: -3 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalMaxPositions must be a positive finite integer");
    });
    it("rejects a fractional value", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalMaxPositions: 2.5 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalMaxPositions must be a positive finite integer");
    });
    it("rejects Infinity", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalMaxPositions: Number.POSITIVE_INFINITY }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalMaxPositions must be a positive finite integer");
    });
    it("rejects a numeric string (no coercion)", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalMaxPositions: "5" }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalMaxPositions must be a positive finite integer");
    });
  });

  describe("rule 9: globalNotionalCap (positive finite number, fractional OK)", () => {
    it("rejects a missing globalNotionalCap", () => {
      const json = validCampaignJson();
      delete json.globalNotionalCap;
      const result = validateInnovationCampaign(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalNotionalCap must be a positive finite number");
    });
    it("rejects zero", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalNotionalCap: 0 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalNotionalCap must be a positive finite number");
    });
    it("rejects a negative value", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalNotionalCap: -1 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("globalNotionalCap must be a positive finite number");
    });
    it("ACCEPTS a fractional value (no integer requirement, unlike globalMaxPositions)", () => {
      const result = validateInnovationCampaign(validCampaignJson({ globalNotionalCap: 1234.56 }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.campaign.globalNotionalCap).toBe(1234.56);
    });
  });

  describe("rule 10: perLaneCaps (optional; keyed by universe lane id, non-empty sub-objects)", () => {
    it("rejects a non-object perLaneCaps (array)", () => {
      const result = validateInnovationCampaign(validCampaignJson({ perLaneCaps: [] }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("perLaneCaps must be an object if present");
    });
    it("rejects a key outside EXECUTABLE_INNOVATION_LANE_IDS", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ perLaneCaps: { NOT_A_LANE: { maxPositions: 1 } } }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("perLaneCaps key outside EXECUTABLE_INNOVATION_LANE_IDS: NOT_A_LANE");
    });
    it("rejects an empty sub-object (neither maxPositions nor maxNotionalUsd)", () => {
      const result = validateInnovationCampaign(validCampaignJson({ perLaneCaps: { [LANE_1]: {} } }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe(`perLaneCaps.${LANE_1} is empty (must specify maxPositions and/or maxNotionalUsd)`);
    });
    it("rejects a non-positive maxPositions", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ perLaneCaps: { [LANE_1]: { maxPositions: 0 } } }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe(`perLaneCaps.${LANE_1}.maxPositions must be a positive finite integer`);
    });
    it("rejects a non-positive maxNotionalUsd", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ perLaneCaps: { [LANE_1]: { maxNotionalUsd: -5 } } }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe(`perLaneCaps.${LANE_1}.maxNotionalUsd must be a positive finite number`);
    });
    it("accepts a fully specified per-lane cap", () => {
      const result = validateInnovationCampaign(
        validCampaignJson({ perLaneCaps: { [LANE_1]: { maxPositions: 3, maxNotionalUsd: 500 } } }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.campaign.perLaneCaps).toEqual({ [LANE_1]: { maxPositions: 3, maxNotionalUsd: 500 } });
    });
  });

  describe("rules 11/12: reason / owner (optional, must be strings if present)", () => {
    it("rejects a non-string reason", () => {
      const result = validateInnovationCampaign(validCampaignJson({ reason: 123 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("reason must be a string if present");
    });
    it("rejects a non-string owner", () => {
      const result = validateInnovationCampaign(validCampaignJson({ owner: 123 }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("owner must be a string if present");
    });
    it("accepts an explicit null for both", () => {
      const result = validateInnovationCampaign(validCampaignJson({ reason: null, owner: null }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.campaign.reason).toBeNull();
      expect(result.campaign.owner).toBeNull();
    });
  });
});

// =================================================================================================
// loadInnovationCampaign — the filesystem-touching loader. Every test points at an isolated tmp
// directory, NEVER the repo's real "data" default (hard rule: never touch data/ or apps/api/data/).
// =================================================================================================
describe("loadInnovationCampaign", () => {
  const FILE = "innovation-campaign.json";
  const STARTS_AT = "2026-08-01T00:00:00.000Z";
  const EXPIRES_AT = "2026-08-10T00:00:00.000Z";
  const INSIDE_WINDOW_MS = Date.parse("2026-08-05T00:00:00.000Z");

  function writeCampaign(dir: string, json: unknown): void {
    writeFileSync(resolve(dir, FILE), JSON.stringify(json), "utf-8");
  }

  it("absent file -> disabled, reason names the resolved path, campaign null", () => {
    const dir = tmpDir();
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(false);
    expect(result.expired).toBe(false);
    expect(result.campaign).toBeNull();
    expect(result.filePath).toBe(resolve(dir, FILE));
    expect(result.reason).toBe(`no innovation campaign file present at ${resolve(dir, FILE)}`);
  });

  it("malformed JSON text -> disabled, reason mentions invalid JSON, campaign null", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, FILE), "{ this is not json", "utf-8");
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(false);
    expect(result.campaign).toBeNull();
    expect(result.reason).toBe("campaign file is not valid JSON");
  });

  it("schema-invalid JSON (missing campaignId) -> disabled, reason carries the SPECIFIC validation reason", () => {
    const dir = tmpDir();
    writeCampaign(dir, {
      enabled: true, allowedLaneIds: [], startsAt: STARTS_AT, expiresAt: EXPIRES_AT,
      globalMaxPositions: 1, globalNotionalCap: 1,
    });
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(false);
    expect(result.campaign).toBeNull();
    expect(result.reason).toBe("campaign invalid: campaignId missing or empty");
  });

  it("schema-invalid JSON (lane id outside the universe) -> disabled, reason names the offending id", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ allowedLaneIds: ["ROGUE_LANE"] }));
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(false);
    expect(result.campaign).toBeNull();
    expect(result.reason).toBe(
      "campaign invalid: allowedLaneIds contains an id outside EXECUTABLE_INNOVATION_LANE_IDS: ROGUE_LANE",
    );
  });

  it("valid but enabled:false -> disabled, campaign non-null, reason mentions enabled=false", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ enabled: false, startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(false);
    expect(result.expired).toBe(false);
    expect(result.campaign).not.toBeNull();
    expect(result.reason).toBe("campaign camp-1 present but enabled=false");
  });

  it("valid but not yet started -> disabled, expired false, reason mentions 'not yet started'", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const beforeStart = Date.parse(STARTS_AT) - 60_000;
    const result = loadInnovationCampaign(dir, FILE, beforeStart);
    expect(result.active).toBe(false);
    expect(result.expired).toBe(false);
    expect(result.campaign).not.toBeNull();
    expect(result.reason).toContain("not yet started");
  });

  it("valid but expired -> disabled, expired true, reason mentions expiry", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const afterExpiry = Date.parse(EXPIRES_AT) + 60_000;
    const result = loadInnovationCampaign(dir, FILE, afterExpiry);
    expect(result.active).toBe(false);
    expect(result.expired).toBe(true);
    expect(result.campaign).not.toBeNull();
    expect(result.reason).toContain("expired");
  });

  it("boundary: nowMs exactly AT expiresAt is already expired (>=, not >)", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const result = loadInnovationCampaign(dir, FILE, Date.parse(EXPIRES_AT));
    expect(result.active).toBe(false);
    expect(result.expired).toBe(true);
  });

  it("boundary: nowMs exactly AT startsAt is already active (not 'not yet started')", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const result = loadInnovationCampaign(dir, FILE, Date.parse(STARTS_AT));
    expect(result.active).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("fully valid + within window -> active true, reason null, campaign populated", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(true);
    expect(result.expired).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.campaign?.campaignId).toBe("camp-1");
  });

  it("[RESTART] repeated loads of the identical file/instant are deep-equal — no hidden module-level cache", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const first = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    const second = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(second).toEqual(first);
  });

  it("[RESTART] an operator edit on disk is picked up on the very next load — nothing caches the PREVIOUS read", () => {
    const dir = tmpDir();
    writeCampaign(dir, validCampaignJson({ enabled: false, startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const before = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(before.active).toBe(false);
    writeCampaign(dir, validCampaignJson({ enabled: true, startsAt: STARTS_AT, expiresAt: EXPIRES_AT }));
    const after = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(after.active).toBe(true);
  });

  it("never throws even when the resolved path is a directory, not a file", () => {
    const dir = tmpDir();
    mkdirSync(resolve(dir, FILE)); // a directory sitting where a file was expected (EISDIR on read)
    expect(() => loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS)).not.toThrow();
    const result = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(result.active).toBe(false);
    expect(result.campaign).toBeNull();
    expect(result.reason).toMatch(/unreadable/);
  });
});

// =================================================================================================
// evaluateInnovationCampaignAdmission — pure decision function (no file I/O, no Date.now()).
// =================================================================================================
describe("evaluateInnovationCampaignAdmission", () => {
  const STARTS_AT = "2026-08-01T00:00:00.000Z";
  const EXPIRES_AT = "2026-08-10T00:00:00.000Z";
  const INSIDE_WINDOW = "2026-08-05T00:00:00.000Z";

  function activeCampaign(over: Partial<InnovationCampaign> = {}): InnovationCampaign {
    return {
      campaignId: "camp-1",
      enabled: true,
      allowedLaneIds: [LANE_1, LANE_2],
      startsAt: STARTS_AT,
      expiresAt: EXPIRES_AT,
      globalMaxPositions: 5,
      globalNotionalCap: 1000,
      perLaneCaps: {},
      reason: null,
      owner: null,
      ...over,
    };
  }

  function ctx(over: Partial<InnovationCampaignAdmissionContext> = {}): InnovationCampaignAdmissionContext {
    return {
      laneId: LANE_1,
      nowIso: INSIDE_WINDOW,
      currentGlobalPositions: 0,
      currentGlobalNotionalUsd: 0,
      currentLanePositions: 0,
      currentLaneNotionalUsd: 0,
      ...over,
    };
  }

  it("blocks with 'no active innovation campaign' when campaign is null", () => {
    const decision = evaluateInnovationCampaignAdmission(null, ctx());
    expect(decision).toEqual({ allowed: false, reason: "no active innovation campaign" });
  });

  it("blocks when enabled:false, reason mentions enabled=false", () => {
    const decision = evaluateInnovationCampaignAdmission(activeCampaign({ enabled: false }), ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("enabled=false");
  });

  it("blocks before startsAt, reason mentions 'not yet started'", () => {
    const decision = evaluateInnovationCampaignAdmission(activeCampaign(), ctx({ nowIso: "2026-07-31T23:59:59.000Z" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not yet started");
  });

  it("boundary: allowed exactly AT startsAt", () => {
    const decision = evaluateInnovationCampaignAdmission(activeCampaign(), ctx({ nowIso: STARTS_AT }));
    expect(decision.allowed).toBe(true);
  });

  it("blocks exactly AT expiresAt (>=, not >), reason mentions expiry", () => {
    const decision = evaluateInnovationCampaignAdmission(activeCampaign(), ctx({ nowIso: EXPIRES_AT }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("expired");
  });

  it("blocks after expiresAt", () => {
    const decision = evaluateInnovationCampaignAdmission(activeCampaign(), ctx({ nowIso: "2026-08-11T00:00:00.000Z" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("expired");
  });

  it("[UNAUTHORIZED LANE] blocks a lane outside allowedLaneIds; a DIFFERENT allowed lane in the SAME campaign still admits", () => {
    const campaign = activeCampaign({ allowedLaneIds: [LANE_1] });
    const blocked = evaluateInnovationCampaignAdmission(campaign, ctx({ laneId: LANE_2 }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe(`lane ${LANE_2} is not in campaign camp-1's allowedLaneIds`);

    const admitted = evaluateInnovationCampaignAdmission(campaign, ctx({ laneId: LANE_1 }));
    expect(admitted).toEqual({ allowed: true, reason: null });
  });

  it("[CAP-EXHAUSTED] global position cap: blocks at the cap, allows just below it", () => {
    const campaign = activeCampaign({ globalMaxPositions: 5 });
    const atCap = evaluateInnovationCampaignAdmission(campaign, ctx({ currentGlobalPositions: 5 }));
    expect(atCap.allowed).toBe(false);
    expect(atCap.reason).toBe("global innovation position cap reached (5/5)");
    const belowCap = evaluateInnovationCampaignAdmission(campaign, ctx({ currentGlobalPositions: 4 }));
    expect(belowCap.allowed).toBe(true);
  });

  it("[CAP-EXHAUSTED] global notional cap: blocks at the cap, allows just below it", () => {
    const campaign = activeCampaign({ globalNotionalCap: 1000 });
    const atCap = evaluateInnovationCampaignAdmission(campaign, ctx({ currentGlobalNotionalUsd: 1000 }));
    expect(atCap.allowed).toBe(false);
    expect(atCap.reason).toBe("global innovation notional cap reached ($1000.00/$1000)");
    const belowCap = evaluateInnovationCampaignAdmission(campaign, ctx({ currentGlobalNotionalUsd: 999 }));
    expect(belowCap.allowed).toBe(true);
  });

  it("[CAP-EXHAUSTED] per-lane position cap blocks ONLY the capped lane; a sibling lane with equal raw exposure is unaffected", () => {
    const campaign = activeCampaign({
      allowedLaneIds: [LANE_1, LANE_2],
      perLaneCaps: { [LANE_1]: { maxPositions: 2 } },
    });
    const lane1Blocked = evaluateInnovationCampaignAdmission(campaign, ctx({ laneId: LANE_1, currentLanePositions: 2 }));
    expect(lane1Blocked.allowed).toBe(false);
    expect(lane1Blocked.reason).toBe(`lane ${LANE_1} per-lane position cap reached (2/2)`);

    const lane2Unaffected = evaluateInnovationCampaignAdmission(
      campaign,
      ctx({ laneId: LANE_2, currentLanePositions: 2 }), // identical raw count, but LANE_2 has no cap entry
    );
    expect(lane2Unaffected.allowed).toBe(true);
  });

  it("[CAP-EXHAUSTED] per-lane notional cap blocks ONLY the capped lane", () => {
    const campaign = activeCampaign({
      allowedLaneIds: [LANE_1, LANE_2],
      perLaneCaps: { [LANE_1]: { maxNotionalUsd: 100 } },
    });
    const lane1Blocked = evaluateInnovationCampaignAdmission(campaign, ctx({ laneId: LANE_1, currentLaneNotionalUsd: 100 }));
    expect(lane1Blocked.allowed).toBe(false);
    expect(lane1Blocked.reason).toBe(`lane ${LANE_1} per-lane notional cap reached ($100.00/$100)`);

    const lane2Unaffected = evaluateInnovationCampaignAdmission(
      campaign,
      ctx({ laneId: LANE_2, currentLaneNotionalUsd: 100 }),
    );
    expect(lane2Unaffected.allowed).toBe(true);
  });

  it("allows cleanly when every check clears", () => {
    const campaign = activeCampaign({
      allowedLaneIds: [LANE_1],
      globalMaxPositions: 5,
      globalNotionalCap: 1000,
      perLaneCaps: { [LANE_1]: { maxPositions: 3, maxNotionalUsd: 200 } },
    });
    const decision = evaluateInnovationCampaignAdmission(
      campaign,
      ctx({ laneId: LANE_1, currentGlobalPositions: 1, currentGlobalNotionalUsd: 50, currentLanePositions: 1, currentLaneNotionalUsd: 50 }),
    );
    expect(decision).toEqual({ allowed: true, reason: null });
  });
});

// =================================================================================================
// innovationCampaignAdmission — wrapper combining a loaded result + a live exposure snapshot.
// =================================================================================================
describe("innovationCampaignAdmission (loader-result + exposure wrapper)", () => {
  function emptyExposure(): InnovationExposureSnapshot {
    return { totalOpenPositions: 0, totalOpenNotionalUsd: 0, perLane: new Map() };
  }

  it("every lane is blocked with the LOADER's own reason when the campaign is absent", () => {
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path/innovation-campaign.json",
      active: false,
      expired: false,
      reason: "no innovation campaign file present at /fake/path/innovation-campaign.json",
      campaign: null,
    };
    for (const laneId of EXECUTABLE_INNOVATION_LANE_IDS) {
      const decision = innovationCampaignAdmission(loaded, laneId, emptyExposure());
      expect(decision).toEqual({ allowed: false, reason: loaded.reason });
    }
  });

  it("an active, authorized campaign with zero exposure admits its lane", () => {
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path/innovation-campaign.json",
      active: true,
      expired: false,
      reason: null,
      campaign: {
        campaignId: "camp-1", enabled: true, allowedLaneIds: [LANE_1],
        startsAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z",
        globalMaxPositions: 5, globalNotionalCap: 1000, perLaneCaps: {}, reason: null, owner: null,
      },
    };
    const decision = innovationCampaignAdmission(loaded, LANE_1, emptyExposure(), "2026-08-05T00:00:00.000Z");
    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it("blocks a lane not named in allowedLaneIds even though the campaign itself is active", () => {
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path/innovation-campaign.json",
      active: true,
      expired: false,
      reason: null,
      campaign: {
        campaignId: "camp-1", enabled: true, allowedLaneIds: [LANE_1],
        startsAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z",
        globalMaxPositions: 5, globalNotionalCap: 1000, perLaneCaps: {}, reason: null, owner: null,
      },
    };
    const decision = innovationCampaignAdmission(loaded, LANE_2, emptyExposure(), "2026-08-05T00:00:00.000Z");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain(LANE_2);
  });

  it("looks up per-lane exposure from the Map and defaults a lane with no entry to zero exposure (never throws)", () => {
    const exposure: InnovationExposureSnapshot = {
      totalOpenPositions: 1,
      totalOpenNotionalUsd: 50,
      perLane: new Map([[LANE_1, { openPositions: 1, openNotionalUsd: 50 }]]),
    };
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path/innovation-campaign.json",
      active: true,
      expired: false,
      reason: null,
      campaign: {
        campaignId: "camp-1", enabled: true, allowedLaneIds: [LANE_2],
        startsAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z",
        globalMaxPositions: 5, globalNotionalCap: 1000,
        perLaneCaps: { [LANE_2]: { maxPositions: 1 } }, reason: null, owner: null,
      },
    };
    // LANE_2 has no entry at all in the exposure Map -> must default to {0,0}, not throw.
    const decision = innovationCampaignAdmission(loaded, LANE_2, exposure, "2026-08-05T00:00:00.000Z");
    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it("[END-TO-END] a written file, loaded fresh, drives the same admission decision the pure evaluator would for the same inputs", () => {
    const dir = tmpDir();
    writeFileSync(
      resolve(dir, "innovation-campaign.json"),
      JSON.stringify(validCampaignJson({
        allowedLaneIds: [LANE_1],
        startsAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-10T00:00:00.000Z",
      })),
      "utf-8",
    );
    const nowMs = Date.parse("2026-08-05T00:00:00.000Z");
    const loaded = loadInnovationCampaign(dir, "innovation-campaign.json", nowMs);
    const decision = innovationCampaignAdmission(loaded, LANE_1, emptyExposure(), new Date(nowMs).toISOString());
    expect(decision).toEqual({ allowed: true, reason: null });
  });
});

// =================================================================================================
// computeInnovationExposure — sums OPEN exposure across all 13 innovation executor instances.
// =================================================================================================
describe("computeInnovationExposure", () => {
  function leg(over: Partial<ExecutorLeg> = {}): ExecutorLeg {
    return {
      symbol: "SOLUSDT", side: "LONG", qty: 10, entryPrice: 2,
      entryOrderId: "e1", entryPriceConfirmed: true,
      exitPrice: null, exitOrderId: null, exitPriceConfirmed: null,
      ...over,
    };
  }
  function basket(basketId: string, legs: ExecutorLeg[]): ExecutorBasket {
    return {
      basketId, sourceObservationId: "o1", signal: "MOM24", variant: "FILTERED",
      openedAt: "2026-08-01T00:00:00.000Z", closesAtMs: 0, legs,
      status: "OPEN", closedAt: null, closeReason: null,
      grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
    };
  }
  function orphan(over: Partial<OrphanedLeg> = {}): OrphanedLeg {
    return {
      basketId: "b1", symbol: "DOGEUSDT", side: "SHORT", qty: 100, entryPrice: 0.1,
      entryOrderId: "e2", since: "2026-08-01T00:00:00.000Z",
      lastAttemptAt: "2026-08-01T00:00:00.000Z", lastError: "fake", attempts: 1,
      ...over,
    };
  }
  function fakeBasketExecutor(laneId: string, openBaskets: ExecutorBasket[], orphanedLegs: OrphanedLeg[] = []): CrossSectionalExecutor {
    // 2026-08-05: computeInnovationExposure reads getExposureSnapshot(), never getStatus() (see the
    // critical-fix comment on that function) -- this fake implements ONLY that narrow surface, same
    // as the real class, so these tests can never accidentally pass by exercising a getStatus() path
    // computeInnovationExposure no longer calls.
    return { getExposureSnapshot: () => ({ laneId, openBaskets, orphanedLegs }) } as unknown as CrossSectionalExecutor;
  }
  function position(over: Partial<SingleSymbolPosition> = {}): SingleSymbolPosition {
    return {
      positionId: "p1", sourceObservationId: "o1", symbol: "BTCUSDT", direction: "SHORT", qty: 1,
      entryPrice: 60000, entryOrderId: "e1", entryPriceConfirmed: true, stopPrice: 61800,
      stopAlgoOrderId: "900", stopFailureCount: 0, stopUnprotectedSinceIso: null,
      closeFailureCount: 0, closeFailureSinceIso: null, peakFavorableR: 0,
      openedAt: "2026-08-01T00:00:00.000Z", status: "OPEN", closedAt: null, closeReason: null,
      exitPrice: null, exitOrderId: null, exitPriceConfirmed: null,
      grossPnlUsd: null, feeEstimateUsd: null, netPnlUsd: null,
      ...over,
    };
  }
  function fakeSingleExecutor(laneId: string, openPositions: SingleSymbolPosition[]): SingleSymbolLaneExecutor {
    // 2026-08-05: same rationale as fakeBasketExecutor above.
    return { getExposureSnapshot: () => ({ laneId, openPositions }) } as unknown as SingleSymbolLaneExecutor;
  }

  it("returns all-zero totals and an empty perLane map for two empty arrays", () => {
    const exposure = computeInnovationExposure([], []);
    expect(exposure.totalOpenPositions).toBe(0);
    expect(exposure.totalOpenNotionalUsd).toBe(0);
    expect(exposure.perLane.size).toBe(0);
  });

  it("skips null executors in either array without throwing", () => {
    const exposure = computeInnovationExposure([null], [null]);
    expect(exposure.totalOpenPositions).toBe(0);
  });

  it("sums a basket's still-open legs' notional and counts the basket as ONE position (not one per leg)", () => {
    const b = basket("b1", [
      leg({ symbol: "SOLUSDT", qty: 10, entryPrice: 2 }), // 20
      leg({ symbol: "DOGEUSDT", qty: 100, entryPrice: 0.1 }), // 10
    ]);
    const exposure = computeInnovationExposure([fakeBasketExecutor(LANE_1, [b])], []);
    expect(exposure.totalOpenPositions).toBe(1);
    expect(exposure.totalOpenNotionalUsd).toBeCloseTo(30, 9);
    expect(exposure.perLane.get(LANE_1)).toEqual({ openPositions: 1, openNotionalUsd: 30 });
  });

  it("excludes an already-exited leg's notional, but the basket itself still counts as 1 position", () => {
    const b = basket("b1", [
      leg({ symbol: "SOLUSDT", qty: 10, entryPrice: 2, exitOrderId: "x1" }), // exited -> excluded
      leg({ symbol: "DOGEUSDT", qty: 100, entryPrice: 0.1 }), // still open -> 10
    ]);
    const exposure = computeInnovationExposure([fakeBasketExecutor(LANE_1, [b])], []);
    expect(exposure.totalOpenPositions).toBe(1);
    expect(exposure.totalOpenNotionalUsd).toBeCloseTo(10, 9);
  });

  it("counts each orphaned leg as its OWN position, additive on top of any basket count", () => {
    const b = basket("b1", [leg({ symbol: "SOLUSDT", qty: 10, entryPrice: 2 })]); // 20, 1 position
    const o = orphan({ symbol: "DOGEUSDT", qty: 50, entryPrice: 0.1 }); // 5, +1 position
    const exposure = computeInnovationExposure([fakeBasketExecutor(LANE_1, [b], [o])], []);
    expect(exposure.totalOpenPositions).toBe(2);
    expect(exposure.totalOpenNotionalUsd).toBeCloseTo(25, 9);
  });

  it("counts an open single-symbol position as ONE position with |qty*entryPrice| notional", () => {
    const p = position({ qty: 0.5, entryPrice: 60000 });
    const exposure = computeInnovationExposure([], [fakeSingleExecutor(LANE_2, [p])]);
    expect(exposure.totalOpenPositions).toBe(1);
    expect(exposure.totalOpenNotionalUsd).toBeCloseTo(30000, 9);
  });

  it("EXCLUDES a single-symbol position ENTIRELY once exitOrderId is set (unlike a basket, which still counts)", () => {
    const p = position({ exitOrderId: "closed-1" });
    const exposure = computeInnovationExposure([], [fakeSingleExecutor(LANE_2, [p])]);
    expect(exposure.totalOpenPositions).toBe(0);
    expect(exposure.totalOpenNotionalUsd).toBe(0);
  });

  it("combines a single-symbol lane's LONG and SHORT instances (sharing one bare laneId) into ONE perLane entry", () => {
    const long = fakeSingleExecutor(LANE_3, [position({ direction: "LONG", qty: 1, entryPrice: 100 })]);
    const short = fakeSingleExecutor(LANE_3, [position({ direction: "SHORT", qty: 2, entryPrice: 100 })]);
    const exposure = computeInnovationExposure([], [long, short]);
    expect(exposure.perLane.get(LANE_3)).toEqual({ openPositions: 2, openNotionalUsd: 300 });
  });

  it("grand totals equal the sum of every perLane entry across a multi-lane scenario", () => {
    const basketExec = fakeBasketExecutor(LANE_1, [basket("b1", [leg({ qty: 10, entryPrice: 2 })])]); // 20
    const singleExec1 = fakeSingleExecutor(LANE_2, [position({ qty: 1, entryPrice: 100 })]); // 100
    const singleExec2 = fakeSingleExecutor(LANE_3, [position({ qty: 2, entryPrice: 50 })]); // 100
    const exposure = computeInnovationExposure([basketExec], [singleExec1, singleExec2]);
    const sumNotional = [...exposure.perLane.values()].reduce((s, v) => s + v.openNotionalUsd, 0);
    const sumPositions = [...exposure.perLane.values()].reduce((s, v) => s + v.openPositions, 0);
    expect(sumNotional).toBeCloseTo(exposure.totalOpenNotionalUsd, 9);
    expect(sumPositions).toBe(exposure.totalOpenPositions);
    expect(exposure.totalOpenNotionalUsd).toBeCloseTo(220, 9);
    expect(exposure.totalOpenPositions).toBe(3);
  });

  // -----------------------------------------------------------------------------------------------
  // 2026-08-05 CRITICAL REGRESSION: computeInnovationExposure <-> getStatus() infinite recursion.
  //
  // Found live: this session's runtime-validation gate deployed a build where computeInnovationExposure
  // read exec.getStatus() (not getExposureSnapshot()) for every innovation executor. getStatus()
  // unconditionally computes `allowed: this.isAllowed()`. In production (app.ts), an innovation
  // executor's isAllowed closure is wired to innovationAllowed(laneId) ->
  // innovationCampaignAdmissionForLane(laneId) -> computeInnovationExposure(...) again -- so calling
  // getStatus() from inside computeInnovationExposure recursed forever ("Maximum call stack size
  // exceeded"), confirmed on the live instance via LiveExecutionEngine.reconcile() silently failing
  // every tick (reconcile -> computeExternalManagedNetQty -> .getStatus() on the same executor list).
  //
  // Every OTHER test in this describe block uses fakeBasketExecutor/fakeSingleExecutor, which stub
  // getExposureSnapshot() directly and could NEVER have caught this -- the recursion only exists when
  // isAllowed is wired back to computeInnovationExposure the way app.ts actually wires it. This test
  // constructs a REAL SingleSymbolLaneExecutor with that exact real wiring shape and proves calling
  // getStatus() on it terminates without throwing.
  // -----------------------------------------------------------------------------------------------
  it("[CRITICAL REGRESSION] a REAL SingleSymbolLaneExecutor whose isAllowed is wired back to computeInnovationExposure (the exact app.ts shape) does not recurse when getStatus() is called", () => {
    const dir = tmpDir();
    const store = new SingleSymbolLaneExecutorStore(dir, "test.json");
    let executor: SingleSymbolLaneExecutor | null = null;
    // Mirrors app.ts's real shape exactly: innovationAllowed(laneId) calls
    // innovationCampaignAdmissionForLane(laneId), which calls computeInnovationExposure(...) over
    // the SAME executor array this executor itself is a member of.
    const innovationAllowed = (laneId: string): boolean => {
      const exposure = computeInnovationExposure([], [executor]);
      return exposure.perLane.get(laneId) === undefined || true; // value doesn't matter, only that it returns
    };
    executor = new SingleSymbolLaneExecutor({
      client: { getExchangeFilters: async () => new Map(), setLeverage: async () => {}, getPositions: async () => [], placeOrder: async () => { throw new Error("not used"); }, placeAlgoOrder: async () => { throw new Error("not used"); }, cancelAlgoOrder: async () => {}, getUserTrades: async () => [] } as never,
      store,
      laneId: LANE_1,
      direction: "LONG",
      getOpenSignals: () => [],
      exitPolicy: makeFixedRewardExitPolicy({ rewardMultiple: 0.5, maxHoldMs: 48 * 3_600_000 }),
      isAllowed: () => innovationAllowed(LANE_1),
      laneWeightPct: () => 100,
      legUsd: () => 25,
      leverage: () => 3,
      maxOpenPositions: () => 1,
      dailyMaxLossUsd: () => 0,
      nowIso: () => "2026-08-05T00:00:00.000Z",
      fillConfirmRetryDelayMs: 0,
      existingNotionalForSymbol: () => 0,
      maxNotionalPerSymbolAcrossLanes: () => 0,
      existingClusterOpenSymbols: () => new Set<string>(),
      maxClusterPositionsAcrossLanes: () => 0,
    });
    expect(() => executor!.getStatus()).not.toThrow();
    expect(executor!.getStatus().laneId).toBe(LANE_1);
    // The narrow accessor itself must also terminate and return the right shape.
    expect(() => executor!.getExposureSnapshot()).not.toThrow();
    expect(executor!.getExposureSnapshot()).toEqual({ laneId: LANE_1, openPositions: [] });
  });
});

// =================================================================================================
// buildInnovationCampaignDiagnostics — the /api/live/innovation-executors "campaign" payload.
// =================================================================================================
describe("buildInnovationCampaignDiagnostics", () => {
  function emptyExposure(): InnovationExposureSnapshot {
    return { totalOpenPositions: 0, totalOpenNotionalUsd: 0, perLane: new Map() };
  }

  it("laneAdmission always contains exactly the 8 EXECUTABLE_INNOVATION_LANE_IDS keys, even with no campaign configured", () => {
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path.json", active: false, expired: false,
      reason: "no innovation campaign file present at /fake/path.json", campaign: null,
    };
    const diagnostics = buildInnovationCampaignDiagnostics(loaded, emptyExposure());
    expect(Object.keys(diagnostics.laneAdmission).sort()).toEqual([...EXECUTABLE_INNOVATION_LANE_IDS].sort());
    for (const laneId of EXECUTABLE_INNOVATION_LANE_IDS) {
      expect(diagnostics.laneAdmission[laneId]!.allowed).toBe(false);
    }
    expect(diagnostics.configured).toBe(false);
  });

  it("maps every loaded-campaign field onto the diagnostics shape verbatim", () => {
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path.json", active: true, expired: false, reason: null,
      campaign: {
        campaignId: "camp-9", enabled: true, allowedLaneIds: [LANE_1],
        startsAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z",
        globalMaxPositions: 7, globalNotionalCap: 777,
        perLaneCaps: { [LANE_1]: { maxPositions: 2 } },
        reason: "operator rationale", owner: "erwin",
      },
    };
    const diagnostics = buildInnovationCampaignDiagnostics(loaded, emptyExposure(), "2026-08-05T00:00:00.000Z");
    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.active).toBe(true);
    expect(diagnostics.campaignId).toBe("camp-9");
    expect(diagnostics.startsAt).toBe("2026-08-01T00:00:00.000Z");
    expect(diagnostics.expiresAt).toBe("2026-08-10T00:00:00.000Z");
    expect(diagnostics.allowedLaneIds).toEqual([LANE_1]);
    expect(diagnostics.globalMaxPositions).toBe(7);
    expect(diagnostics.globalNotionalCap).toBe(777);
    expect(diagnostics.perLaneCaps).toEqual({ [LANE_1]: { maxPositions: 2 } });
    expect(diagnostics.metadataReason).toBe("operator rationale");
    expect(diagnostics.metadataOwner).toBe("erwin");
  });

  it("keeps statusReason (why blocked) and metadataReason (operator's own free text) distinct — never confused", () => {
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path.json", active: false, expired: false,
      reason: "campaign camp-1 present but enabled=false",
      campaign: {
        campaignId: "camp-1", enabled: false, allowedLaneIds: [],
        startsAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z",
        globalMaxPositions: 1, globalNotionalCap: 1, perLaneCaps: {},
        reason: "paused for review", owner: "erwin",
      },
    };
    const diagnostics = buildInnovationCampaignDiagnostics(loaded, emptyExposure());
    expect(diagnostics.statusReason).toBe("campaign camp-1 present but enabled=false");
    expect(diagnostics.metadataReason).toBe("paused for review");
    expect(diagnostics.statusReason).not.toBe(diagnostics.metadataReason);
  });

  it("[FASTIFY-SERIALIZATION GUARD] exposure.perLane survives a JSON.stringify/parse round-trip (a bare Map would silently become {})", () => {
    const exposure: InnovationExposureSnapshot = {
      totalOpenPositions: 3,
      totalOpenNotionalUsd: 150,
      perLane: new Map([
        [LANE_1, { openPositions: 2, openNotionalUsd: 100 }],
        [LANE_2, { openPositions: 1, openNotionalUsd: 50 }],
      ]),
    };
    const loaded: InnovationCampaignLoadResult = {
      filePath: "/fake/path.json", active: false, expired: false,
      reason: "no innovation campaign file present at /fake/path.json", campaign: null,
    };
    const diagnostics = buildInnovationCampaignDiagnostics(loaded, exposure);
    expect(diagnostics.exposure.perLane).toEqual({
      [LANE_1]: { openPositions: 2, openNotionalUsd: 100 },
      [LANE_2]: { openPositions: 1, openNotionalUsd: 50 },
    });
    const roundTripped = JSON.parse(JSON.stringify(diagnostics));
    expect(roundTripped.exposure.perLane).toEqual({
      [LANE_1]: { openPositions: 2, openNotionalUsd: 100 },
      [LANE_2]: { openPositions: 1, openNotionalUsd: 50 },
    });
    expect(roundTripped.exposure.perLane).not.toEqual({});
  });
});

// =================================================================================================
// campaignCapForLane (2026-08-05 fix) — the translation point from a loaded campaign to
// account-exposure-coordinator.ts's ExposureReserveCampaignCap, the shape reserve()'s gate 2
// atomically enforces. Pure function, no I/O of its own. See this module's own header comment: this
// is now the ONLY path a campaign's cap fields reach the authoritative, atomic enforcement point —
// evaluateInnovationCampaignAdmission's own cap branches (tested above) are a non-authoritative
// pre-filter as of this fix. Every test below either writes a real file through loadInnovationCampaign
// (matching the "loadInnovationCampaign" describe block's own conventions) or hand-builds an
// InnovationCampaignLoadResult (matching "innovationCampaignAdmission"'s own conventions) — never a
// third, ad hoc shape.
// =================================================================================================
describe("campaignCapForLane", () => {
  const STARTS_AT = "2026-08-01T00:00:00.000Z";
  const EXPIRES_AT = "2026-08-10T00:00:00.000Z";
  const INSIDE_WINDOW_MS = Date.parse("2026-08-05T00:00:00.000Z");
  const FILE = "innovation-campaign.json";

  function admissionCtx(laneId: string): InnovationCampaignAdmissionContext {
    return {
      laneId,
      nowIso: new Date(INSIDE_WINDOW_MS).toISOString(),
      currentGlobalPositions: 0,
      currentGlobalNotionalUsd: 0,
      currentLanePositions: 0,
      currentLaneNotionalUsd: 0,
    };
  }

  it("[REQ-1] absent campaign file -> undefined (gate 2 inert); the pre-existing evaluateInnovationCampaignAdmission gate independently denies with 'no active innovation campaign' — the full chain still blocks a new innovation entry, not just one layer", () => {
    const dir = tmpDir();
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(loaded.campaign).toBeNull();
    expect(campaignCapForLane(loaded, LANE_1)).toBeUndefined();
    const admission = evaluateInnovationCampaignAdmission(loaded.campaign, admissionCtx(LANE_1));
    expect(admission).toEqual({ allowed: false, reason: "no active innovation campaign" });
  });

  it("[REQ-2a] disabled campaign (enabled:false) -> undefined, even though loaded.campaign is non-null (the exact trap the function's own doc comment warns against)", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, FILE), JSON.stringify(validCampaignJson({ enabled: false, startsAt: STARTS_AT, expiresAt: EXPIRES_AT })), "utf-8");
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(loaded.campaign).not.toBeNull();
    expect(loaded.active).toBe(false);
    expect(campaignCapForLane(loaded, LANE_1)).toBeUndefined();
  });

  it("[REQ-2b] malformed campaign (fails schema validation) -> undefined", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, FILE), JSON.stringify({ enabled: true }), "utf-8"); // missing campaignId etc.
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(loaded.campaign).toBeNull();
    expect(campaignCapForLane(loaded, LANE_1)).toBeUndefined();
  });

  it("[REQ-2b variant] not valid JSON at all -> undefined", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, FILE), "{ not json", "utf-8");
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    expect(campaignCapForLane(loaded, LANE_1)).toBeUndefined();
  });

  it("[REQ-2c / MUTATION TARGET] expired campaign -> undefined, even though loaded.campaign is non-null and every cap field is fully populated — this is the EXACT regression campaignCapForLane's own doc comment warns against (checking !loaded.campaign instead of !loaded.active)", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, FILE), JSON.stringify(validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT })), "utf-8");
    const afterExpiry = Date.parse(EXPIRES_AT) + 60_000;
    const loaded = loadInnovationCampaign(dir, FILE, afterExpiry);
    expect(loaded.campaign).not.toBeNull();
    expect(loaded.expired).toBe(true);
    expect(loaded.campaign!.globalMaxPositions).toBeGreaterThan(0); // cap fields ARE populated...
    expect(campaignCapForLane(loaded, LANE_1)).toBeUndefined(); // ...but must still be undefined
  });

  it("[REQ-2c variant] not-yet-started campaign -> undefined", () => {
    const dir = tmpDir();
    writeFileSync(resolve(dir, FILE), JSON.stringify(validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT })), "utf-8");
    const beforeStart = Date.parse(STARTS_AT) - 60_000;
    const loaded = loadInnovationCampaign(dir, FILE, beforeStart);
    expect(loaded.campaign).not.toBeNull();
    expect(campaignCapForLane(loaded, LANE_1)).toBeUndefined();
  });

  it("active + valid campaign -> a fully-populated cap: campaignLaneIds is the FULL static universe (never allowedLaneIds, even when it is a strict subset), global fields copied verbatim, per-lane fields pulled from perLaneCaps for THIS laneId specifically", () => {
    const dir = tmpDir();
    writeFileSync(
      resolve(dir, FILE),
      JSON.stringify(validCampaignJson({
        allowedLaneIds: [LANE_1], // a STRICT SUBSET of the full universe
        startsAt: STARTS_AT,
        expiresAt: EXPIRES_AT,
        globalMaxPositions: 7,
        globalNotionalCap: 2500,
        perLaneCaps: { [LANE_1]: { maxPositions: 3, maxNotionalUsd: 400 } },
      })),
      "utf-8",
    );
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    const cap = campaignCapForLane(loaded, LANE_1);
    expect(cap).toBeDefined();
    expect(cap!.campaignId).toBe("camp-1");
    expect(cap!.campaignLaneIds).toEqual(EXECUTABLE_INNOVATION_LANE_IDS); // NOT [LANE_1]
    expect(cap!.globalMaxPositions).toBe(7);
    expect(cap!.globalNotionalCap).toBe(2500);
    expect(cap!.laneMaxPositions).toBe(3);
    expect(cap!.laneMaxNotionalUsd).toBe(400);
  });

  it("a lane with NO entry in perLaneCaps gets undefined lane-level fields (global fields still populated) — never throws on a missing key", () => {
    const dir = tmpDir();
    writeFileSync(
      resolve(dir, FILE),
      JSON.stringify(validCampaignJson({
        allowedLaneIds: [LANE_1, LANE_2],
        startsAt: STARTS_AT,
        expiresAt: EXPIRES_AT,
        perLaneCaps: { [LANE_1]: { maxPositions: 3 } }, // LANE_2 absent
      })),
      "utf-8",
    );
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    const cap = campaignCapForLane(loaded, LANE_2);
    expect(cap).toBeDefined();
    expect(cap!.laneMaxPositions).toBeUndefined();
    expect(cap!.laneMaxNotionalUsd).toBeUndefined();
  });

  it("[REQ-3] a lane OUTSIDE allowedLaneIds still gets a DEFINED cap — campaignCapForLane is deliberately laneId-agnostic about authorization (by design, per its own doc comment); the actual denial for an unauthorized lane comes from the separate, unchanged evaluateInnovationCampaignAdmission gate, proven directly here too so this test cannot pass on the wrong half of the story alone", () => {
    const dir = tmpDir();
    writeFileSync(
      resolve(dir, FILE),
      JSON.stringify(validCampaignJson({ allowedLaneIds: [LANE_1], startsAt: STARTS_AT, expiresAt: EXPIRES_AT })),
      "utf-8",
    );
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);

    // campaignCapForLane itself does not gate on allowedLaneIds:
    const capForUnauthorizedLane = campaignCapForLane(loaded, LANE_2);
    expect(capForUnauthorizedLane).toBeDefined();
    expect(capForUnauthorizedLane!.campaignLaneIds).toContain(LANE_2); // still part of the full universe

    // ...but the SEPARATE, unchanged admission gate still denies LANE_2 outright — this is the gate
    // that actually keeps an unauthorized lane's signals from ever reaching reserve() in the first
    // place (see this file's own header comment / this module's AUTHORITY doc comment).
    const admission = evaluateInnovationCampaignAdmission(loaded.campaign, admissionCtx(LANE_2));
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toContain(LANE_2);

    // A DIFFERENT lane that IS authorized is unaffected.
    const admittedLane1 = evaluateInnovationCampaignAdmission(loaded.campaign, admissionCtx(LANE_1));
    expect(admittedLane1.allowed).toBe(true);
  });

  it("[GLOBAL-SCOPE risk item] campaignLaneIds always covers the FULL universe, so a lane dropped from a narrowed allowedLaneIds still counts toward the global cap the coordinator computes — proven by asserting cap.campaignLaneIds is unaffected by allowedLaneIds shrinking to a single lane", () => {
    const dir = tmpDir();
    writeFileSync(
      resolve(dir, FILE),
      JSON.stringify(validCampaignJson({ allowedLaneIds: [LANE_1], startsAt: STARTS_AT, expiresAt: EXPIRES_AT })),
      "utf-8",
    );
    const loaded = loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS);
    const cap = campaignCapForLane(loaded, LANE_1);
    // The cap's own campaignLaneIds is still the FULL roster (length > 1), so
    // account-exposure-coordinator.ts's buildCampaignExposure will still sum a DIFFERENT,
    // no-longer-allowed lane's still-open exposure against the global cap, exactly per
    // ExposureReserveCampaignCap.campaignLaneIds's own doc comment.
    expect(cap!.campaignLaneIds).toEqual(EXECUTABLE_INNOVATION_LANE_IDS);
    expect(cap!.campaignLaneIds.length).toBeGreaterThan(1);
    expect(cap!.campaignLaneIds).toContain(LANE_3); // a lane NOT in allowedLaneIds at all
  });

  it("[RESTART] campaignCapForLane over two successive loads of the identical file/instant is deep-equal — no hidden module-level cache, matching loadInnovationCampaign's own no-cache contract", () => {
    const dir = tmpDir();
    writeFileSync(
      resolve(dir, FILE),
      JSON.stringify(validCampaignJson({ startsAt: STARTS_AT, expiresAt: EXPIRES_AT })),
      "utf-8",
    );
    const first = campaignCapForLane(loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS), LANE_1);
    const second = campaignCapForLane(loadInnovationCampaign(dir, FILE, INSIDE_WINDOW_MS), LANE_1);
    expect(second).toEqual(first);
  });
});
