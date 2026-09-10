/**
 * AP-16 target eligibility — the exhaustive table.
 *
 * §6.3 is an ordered list of eight rules, and the ORDER is the contract: the
 * caller shows the first failing reason, so a provider that is both logged out
 * and disabled must read as logged out — the one the user can act on. These
 * tests walk every refusal code against every provider and every cache state,
 * which is only possible because the module is pure.
 */
import { describe, expect, it } from "vitest";
import { ACP_PROVIDERS, type AcpProvider } from "../src/acp-backend";
import type { EffortLevel } from "../src/acp";
import {
  EFFORT_ORDER,
  clampEffort,
  defaultRosterEntry,
  eligibleProviders,
  isEffortLevel,
  isPermissionProfile,
  limitRefusal,
  listEligibleTargets,
  providerRefusal,
  resolveChildEffort,
  resolveModel,
  resolveProfile,
  resolveTarget,
  type EligibilityInput,
  type ModelCacheView,
  type RosterEntry,
} from "../src/target-eligibility";

const roomyLimits = {
  running: 0,
  maxConcurrent: 3,
  thisTurn: 0,
  maxPerTurn: 4,
  thisSession: 0,
  maxPerSession: 20,
  poolHeadroom: 5,
};

const warmCache = (ids: string[], extra: Partial<ModelCacheView["models"][number]> = {}): ModelCacheView => ({
  checked: true,
  models: ids.map((id) => ({ id, ...extra })),
});

const coldCache: ModelCacheView = { checked: false, models: [] };

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    purpose: "subagent",
    usable: [...ACP_PROVIDERS],
    roster: {},
    capabilities: () => ({
      companionSubagentTarget: { state: "yes" },
      hostMcp: { state: "yes" },
    }),
    models: () => warmCache(["m-fast", "m-strong"]),
    limits: { ...roomyLimits },
    ...over,
  };
}

const roster = (over: Partial<RosterEntry> = {}): RosterEntry => ({ ...defaultRosterEntry(), ...over });

describe("target eligibility — vocabulary comes from the source modules (D12)", () => {
  it("orders every EffortLevel exactly once", () => {
    // A level missing here would clamp to the wrong neighbour rather than fail,
    // so the list being total is asserted at runtime as well as at build time.
    expect(new Set(EFFORT_ORDER).size).toBe(EFFORT_ORDER.length);
    for (const level of EFFORT_ORDER) expect(isEffortLevel(level)).toBe(true);
    expect(isEffortLevel("gigantic")).toBe(false);
  });

  it("knows exactly the three permission profiles", () => {
    for (const profile of ["read-only", "scoped-edit", "inherit"]) {
      expect(isPermissionProfile(profile)).toBe(true);
    }
    expect(isPermissionProfile("yolo")).toBe(false);
    expect(isPermissionProfile("plan")).toBe(false);
  });
});

describe("rules 1-3 — the provider, in order, for every provider", () => {
  for (const provider of ACP_PROVIDERS) {
    it(`${provider}: an unusable provider reads as not usable, not as disabled`, () => {
      // Both would be true here. The first failing rule is the one to report,
      // because "log in" is actionable and "enable in the roster" is not the
      // reason the spawn failed.
      const state = input({
        usable: ACP_PROVIDERS.filter((p) => p !== provider),
        roster: { [provider]: roster({ enabled: false }) },
      });
      expect(providerRefusal(state, provider)).toMatchObject({ code: "provider-not-usable" });
    });

    it(`${provider}: a roster toggle off refuses with provider-disabled`, () => {
      const state = input({ roster: { [provider]: roster({ enabled: false }) } });
      expect(providerRefusal(state, provider)).toMatchObject({ code: "provider-disabled" });
    });

    it(`${provider}: a capability of "no" refuses`, () => {
      const state = input({
        capabilities: (candidate: AcpProvider) => ({
          companionSubagentTarget:
            candidate === provider
              ? { state: "no" as const, reason: "cannot be a child" }
              : { state: "yes" as const },
          hostMcp: { state: "yes" as const },
        }),
      });
      expect(providerRefusal(state, provider)).toMatchObject({ code: "provider-not-usable" });
    });

    it(`${provider}: a capability of "probe" is still spawnable as a child`, () => {
      // §6.3 rule 3 refuses only "no". A probe cell is a recorded absence of
      // knowledge about the PARENT channel, not a claim about being a child.
      const state = input({
        capabilities: () => ({
          companionSubagentTarget: { state: "probe" as const, reason: "unprobed" },
          hostMcp: { state: "probe" as const, reason: "unprobed" },
        }),
      });
      expect(providerRefusal(state, provider)).toBeUndefined();
    });

    it(`${provider}: an exhausted provider refuses with provider-quota`, () => {
      const state = input({ exhausted: new Set([provider]) });
      expect(providerRefusal(state, provider)).toMatchObject({ code: "provider-quota" });
    });

    it(`${provider}: fully configured, nothing refuses`, () => {
      expect(providerRefusal(input(), provider)).toBeUndefined();
    });
  }

  it("says 'crew stages' rather than 'subagents' when that is the purpose", () => {
    const state = input({ purpose: "crew-stage", roster: { grok: roster({ enabled: false }) } });
    expect(providerRefusal(state, "grok")!.message).toMatch(/crew stages/);
  });
});

describe("rule 4 — the model", () => {
  it("accepts a model the warmed cache carries, and says it is verified", () => {
    expect(resolveModel(input(), "grok", "m-fast")).toEqual({ model: "m-fast", verified: true });
  });

  it("refuses an unknown model and lists what there is", () => {
    const result = resolveModel(input(), "grok", "m-imaginary") as { code: string; message: string };
    expect(result.code).toBe("model-unknown");
    expect(result.message).toContain("m-fast, m-strong");
  });

  it("skips the check on a cold cache rather than rejecting everything", () => {
    // The alternative — reading an unwarmed cache as "this provider has no
    // models" — would refuse every spawn on a cold start.
    const state = input({ models: () => coldCache });
    expect(resolveModel(state, "grok", "m-fast")).toEqual({ model: "m-fast", verified: false });
  });

  it("refuses a model outside the roster allow-list, before consulting the cache", () => {
    const state = input({ roster: { grok: roster({ allowedModels: ["m-fast"] }) } });
    const result = resolveModel(state, "grok", "m-strong") as { code: string; message: string };
    expect(result.code).toBe("model-not-allowed");
    expect(result.message).toContain("m-fast");
  });

  it("treats no model as the provider's default, which is a real choice", () => {
    expect(resolveModel(input(), "grok", undefined)).toEqual({ model: undefined, verified: true });
  });

  it("falls back to the roster default model when none is asked for", () => {
    const state = input({ roster: { grok: roster({ defaultModel: "m-strong" }) } });
    expect(resolveModel(state, "grok", undefined)).toEqual({ model: "m-strong", verified: true });
  });
});

describe("rule 6 — the profile never exceeds the roster or the parent", () => {
  it("always allows read-only", () => {
    const state = input({ roster: { grok: roster({ allowWrite: false }) } });
    expect(resolveProfile(state, "grok", "read-only")).toEqual({ profile: "read-only" });
  });

  it("refuses a write profile on a read-only provider and states the maximum", () => {
    const state = input({ roster: { grok: roster({ allowWrite: false }) } });
    const result = resolveProfile(state, "grok", "scoped-edit") as { code: string; message: string };
    expect(result.code).toBe("profile-not-allowed");
    expect(result.message).toContain("read-only");
  });

  it("refuses a child that would out-rank its parent", () => {
    const state = input({
      parent: { provider: "claude", maxProfile: "scoped-edit", planMode: false },
    });
    const result = resolveProfile(state, "grok", "inherit") as { code: string; message: string };
    expect(result.code).toBe("profile-not-allowed");
    expect(result.message).toContain("scoped-edit");
  });

  it("downgrades rather than refuses when the parent is in plan mode", () => {
    // A downgrade keeps the delegation working; a refusal would strand the
    // main agent for a reason it can do nothing about.
    const state = input({ parent: { provider: "claude", maxProfile: "inherit", planMode: true } });
    expect(resolveProfile(state, "grok", "inherit")).toEqual({
      profile: "read-only",
      downgraded: "parent in plan mode",
    });
  });
});

describe("rule 8 — limits", () => {
  it("reports which limit was hit, with the current usage", () => {
    expect(limitRefusal({ ...roomyLimits, running: 3 })!.message).toContain("limit 3");
    expect(limitRefusal({ ...roomyLimits, thisTurn: 4 })!.message).toContain("in this turn");
    expect(limitRefusal({ ...roomyLimits, thisSession: 20 })!.message).toContain("in this session");
    expect(limitRefusal({ ...roomyLimits, poolHeadroom: 0 })!.message).toContain("pool");
  });

  it("lets a spawn through when there is room everywhere", () => {
    expect(limitRefusal(roomyLimits)).toBeUndefined();
  });
});

describe("§6.3.1 — effort resolution, first match wins", () => {
  const chain = (over: Parameters<typeof resolveChildEffort>[2] = {}) =>
    resolveChildEffort("gemini", {}, { parentEffort: "high", ...over });

  it("takes the explicit effort on the tool call above everything", () => {
    expect(
      resolveChildEffort("gemini", { effort: "minimal", roleEffort: "max" }, { global: "high" }),
    ).toBe("minimal");
  });

  it("takes the role's effort next", () => {
    expect(resolveChildEffort("gemini", { roleEffort: "low" }, { global: "max" })).toBe("low");
  });

  it("takes a per-provider session override before the for-all one", () => {
    expect(chain({ sessionOverride: { gemini: "medium", "*": "max" } })).toBe("medium");
  });

  it("resolves a session override of 'inherit' to the parent's effort", () => {
    expect(chain({ sessionOverride: { "*": "inherit" } })).toBe("high");
  });

  it("takes the roster default before the global one", () => {
    expect(chain({ rosterDefault: () => "low", global: "max" })).toBe("low");
  });

  it("resolves the shipped global default 'inherit' to the parent's effort", () => {
    expect(chain({ global: "inherit" })).toBe("high");
  });

  it("falls through to the provider default last", () => {
    expect(chain({ providerDefault: () => "medium" })).toBe("medium");
  });

  it("answers undefined when nothing in the chain has an opinion", () => {
    // Not a level: "undefined" means the session starts on whatever the
    // provider itself defaults to, which is different from picking one.
    expect(resolveChildEffort("gemini", {}, {})).toBeUndefined();
  });

  it("never lets a parent's effort raise a role that pinned its own", () => {
    // The shipped `inspector` role is `low`; a parent on `max` must not
    // silently spend a subscription on a repo scan.
    expect(resolveChildEffort("gemini", { roleEffort: "low" }, { global: "inherit", parentEffort: "max" })).toBe("low");
  });
});

describe("effort clamping", () => {
  it("leaves an effort under the ceiling alone and reports no clamp", () => {
    expect(clampEffort("low", "high")).toEqual({ applied: "low" });
  });

  it("clamps down to the ceiling and reports both values", () => {
    expect(clampEffort("max", "medium")).toEqual({
      applied: "medium",
      clamped: { requested: "max", applied: "medium" },
    });
  });

  it("clamps to the nearest supported level at or below the target", () => {
    expect(clampEffort("xhigh", undefined, ["low", "medium"])).toEqual({
      applied: "medium",
      clamped: { requested: "xhigh", applied: "medium" },
    });
  });

  it("takes the weakest supported level when nothing is at or below the target", () => {
    expect(clampEffort("none", undefined, ["medium", "high"])).toEqual({
      applied: "medium",
      clamped: { requested: "none", applied: "medium" },
    });
  });

  it("treats an absent effort list as unknown, not as a restriction", () => {
    expect(clampEffort("max", undefined, [])).toEqual({ applied: "max" });
    expect(clampEffort("max", undefined, undefined)).toEqual({ applied: "max" });
  });

  it("clamps nothing when no effort was chosen", () => {
    expect(clampEffort(undefined, "low")).toEqual({});
  });
});

describe("resolveTarget — the whole chain", () => {
  it("refuses when subagents are off for this session", () => {
    const result = resolveTarget({}, input({ subagentsEnabled: false }));
    expect(result).toMatchObject({ ok: false, code: "subagents-disabled" });
  });

  it("refuses when the user forbade subagents on this message", () => {
    const result = resolveTarget({}, input({ forbiddenThisTurn: true }));
    expect(result).toMatchObject({ ok: false, code: "forbidden-by-user" });
  });

  it("prefers a provider other than the parent's, and says so", () => {
    const result = resolveTarget(
      {},
      input({ parent: { provider: ACP_PROVIDERS[0], maxProfile: "inherit", planMode: false } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.provider).not.toBe(ACP_PROVIDERS[0]);
    expect(result.sameProviderAsParent).toBe(false);
    expect(result.resolvedBy).toBe("roster-order");
  });

  it("allows the parent's own provider when it is the only eligible one", () => {
    // "Opus plans, a cheaper model of the same provider inspects" is a primary
    // use case, not a fallback to apologise for.
    const only = ACP_PROVIDERS[0];
    const result = resolveTarget({}, input({
      usable: [only],
      parent: { provider: only, maxProfile: "inherit", planMode: false },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.provider).toBe(only);
    expect(result.sameProviderAsParent).toBe(true);
  });

  it("refuses an explicitly named provider rather than substituting another", () => {
    // A silent substitution is the one thing this must never do: the user or
    // the agent asked for a specific worker.
    const named = ACP_PROVIDERS[1];
    const result = resolveTarget(
      { provider: named },
      input({ roster: { [named]: roster({ enabled: false }) } }),
    );
    expect(result).toMatchObject({ ok: false, code: "provider-disabled" });
    if (result.ok) return;
    expect(result.alternatives.map((t) => t.provider)).not.toContain(named);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it("takes the role's provider when the request names none", () => {
    const result = resolveTarget({ role: { provider: ACP_PROVIDERS[2] } }, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.provider).toBe(ACP_PROVIDERS[2]);
    expect(result.resolvedBy).toBe("role");
  });

  it("steers preferDifferentProvider away from the parent", () => {
    const parent = ACP_PROVIDERS[0];
    const result = resolveTarget(
      { role: { preferDifferentProvider: true } },
      input({ parent: { provider: parent, maxProfile: "inherit", planMode: false } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.provider).not.toBe(parent);
    expect(result.resolvedBy).toBe("prefer-different-provider");
  });

  it("reports a clamp instead of quietly lowering the effort", () => {
    const result = resolveTarget(
      { provider: "grok", effort: "max" },
      input({ roster: { grok: roster({ maxEffort: "low" }) } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.effort).toBe("low");
    expect(result.effortClamped).toEqual({ requested: "max", applied: "low" });
  });

  it("marks the model unverified when the cache was never warmed", () => {
    const result = resolveTarget({ provider: "grok", model: "m-fast" }, input({ models: () => coldCache }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.modelVerified).toBe(false);
  });

  it("defaults the profile to read-only when the spawn omits it", () => {
    const result = resolveTarget({}, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toBe("read-only");
  });

  it("records the downgrade when the parent is planning", () => {
    const result = resolveTarget(
      { profile: "scoped-edit" },
      input({ parent: { provider: "claude", maxProfile: "inherit", planMode: true } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toBe("read-only");
    expect(result.profileDowngraded).toBe("parent in plan mode");
  });

  it("answers no-eligible-target when nothing is usable, with the copy-deck line", () => {
    const result = resolveTarget({}, input({ usable: [] }));
    expect(result).toMatchObject({
      ok: false,
      code: "no-eligible-target",
      message: "No subagent is available right now; continue alone and tell the user why.",
    });
  });

  it("checks limits before choosing a provider", () => {
    // Otherwise a full pool would be reported as a provider problem.
    const result = resolveTarget({ provider: "grok" }, input({ limits: { ...roomyLimits, running: 3 } }));
    expect(result).toMatchObject({ ok: false, code: "limit-reached" });
  });
});

describe("listEligibleTargets — compact by default (§2.1)", () => {
  it("returns no per-model array unless a provider is expanded", () => {
    const listing = listEligibleTargets(input());
    expect(listing.targets).toHaveLength(ACP_PROVIDERS.length);
    for (const target of listing.targets) {
      expect(target.models).toBeUndefined();
      expect(target.modelCount).toBe(2);
      expect(target.modelListVerified).toBe(true);
    }
  });

  it("expands exactly one provider", () => {
    const listing = listEligibleTargets(input(), { expand: "codex" });
    const expanded = listing.targets.filter((t) => t.models);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].provider).toBe("codex");
    expect(expanded[0].models!.map((m) => m.id)).toEqual(["m-fast", "m-strong"]);
  });

  it("omits fields the cache does not know rather than inventing them", () => {
    const listing = listEligibleTargets(input(), { expand: "grok" });
    const model = listing.targets.find((t) => t.provider === "grok")!.models![0];
    expect(model).not.toHaveProperty("contextWindow");
    expect(model).not.toHaveProperty("efforts");
  });

  it("carries the cache-cold flag so a count is not read as a claim", () => {
    const listing = listEligibleTargets(input({ models: () => coldCache }));
    expect(listing.targets[0].modelListVerified).toBe(false);
    expect(listing.targets[0].modelCount).toBe(0);
  });

  it("never lists a provider that is not usable, disabled, or incapable", () => {
    const listing = listEligibleTargets(input({
      usable: ["claude", "gemini"],
      roster: { gemini: roster({ enabled: false }) },
    }));
    expect(listing.targets.map((t) => t.provider)).toEqual(["claude"]);
    const reasons = Object.fromEntries(listing.ineligible.map((i) => [i.provider, i.reason]));
    expect(reasons.gemini).toBe("provider-disabled");
    expect(reasons.grok).toBe("provider-not-usable");
  });

  it("offers only read-only when the provider forbids writes", () => {
    const listing = listEligibleTargets(input({ roster: { grok: roster({ allowWrite: false }) } }));
    expect(listing.targets.find((t) => t.provider === "grok")!.allowedProfiles).toEqual(["read-only"]);
  });

  it("offers only read-only to every provider while the parent is planning", () => {
    const listing = listEligibleTargets(input({
      parent: { provider: "claude", maxProfile: "inherit", planMode: true },
    }));
    for (const target of listing.targets) expect(target.allowedProfiles).toEqual(["read-only"]);
  });

  it("caps the offered profiles at what the parent itself has", () => {
    const listing = listEligibleTargets(input({
      parent: { provider: "claude", maxProfile: "scoped-edit", planMode: false },
    }));
    expect(listing.targets[0].allowedProfiles).toEqual(["read-only", "scoped-edit"]);
  });

  it("passes the user's notes through, because model strengths are theirs to state", () => {
    const listing = listEligibleTargets(input({
      roster: { gemini: roster({ notes: "fast and cheap, good for repo scans" }) },
    }));
    expect(listing.targets.find((t) => t.provider === "gemini")!.notes)
      .toBe("fast and cheap, good for repo scans");
  });

  it("reports remaining headroom, never a negative", () => {
    const listing = listEligibleTargets(input({
      limits: { ...roomyLimits, thisTurn: 9, thisSession: 99 },
    }));
    expect(listing.limits.remainingThisTurn).toBe(0);
    expect(listing.limits.remainingThisSession).toBe(0);
  });

  it("hardcodes no model id or effort list anywhere in its answer", () => {
    // D12. Everything in the listing traces back to the caches and the roster
    // the host passed in; this pins that an empty world produces an empty list
    // rather than a built-in suggestion.
    const listing = listEligibleTargets(input({ usable: [], models: () => coldCache }));
    expect(listing.targets).toEqual([]);
  });
});

describe("eligibleProviders", () => {
  it("keeps roster order", () => {
    expect(eligibleProviders(input())).toEqual([...ACP_PROVIDERS]);
  });

  it("drops each refused provider", () => {
    const state = input({ usable: ["claude"], roster: {} });
    expect(eligibleProviders(state)).toEqual(["claude"]);
  });
});
