// Target eligibility for companion subagents, crew stage gates and the
// workflow generator (AP-16 §6.3, §6.3.1).
//
// One question, asked from three places: "may this {provider, model, effort,
// profile} run right now, and if not, which of the eight reasons is the first
// one that says no?" The order matters — the caller shows the FIRST failing
// reason, so a provider that is both logged out and disabled reads as logged
// out, which is the one the user can act on.
//
// Pure logic module adhering to Recipe R7: no vscode, no filesystem, no clock.
// Every input arrives as plain data (provider states, roster settings, cache
// snapshots, limits, the parent's permissions) and the answer is either a
// resolved target or a typed refusal. That is what makes the exhaustive
// refusal × provider × cache-state table in the tests possible at all.
//
// D12: no model id, effort list or context size is written here. `EffortLevel`
// and `ACP_PROVIDERS` are imported; per-model support comes from the caches the
// host passes in.

import { ACP_PROVIDERS, type AcpProvider } from "./acp-backend";
import type { EffortLevel } from "./acp";
import type { CapabilitySupport } from "./provider-capabilities";

/** The triple a subagent or a stage runs on, plus the permission mode. */
export interface Target {
  provider: AcpProvider;
  model?: string;
  effort?: EffortLevel;
  runMode?: "agent" | "plan";
}

export type PermissionProfile = "read-only" | "scoped-edit" | "inherit";

export const PERMISSION_PROFILES: readonly PermissionProfile[] = [
  "read-only",
  "scoped-edit",
  "inherit",
] as const;

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return value === "read-only" || value === "scoped-edit" || value === "inherit";
}

/**
 * Effort levels weakest → strongest.
 *
 * Clamping needs a total order, and a level missing from this list would clamp
 * to the wrong neighbour instead of failing — so the type below makes adding a
 * level to `acp.ts` without placing it here a build error rather than a silent
 * misordering.
 */
export const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const satisfies readonly EffortLevel[];

type EffortOrderCoversEveryLevel = Exclude<EffortLevel, (typeof EFFORT_ORDER)[number]> extends never
  ? true
  : ["EFFORT_ORDER is missing an EffortLevel", Exclude<EffortLevel, (typeof EFFORT_ORDER)[number]>];
const _effortOrderIsTotal: EffortOrderCoversEveryLevel = true;
void _effortOrderIsTotal;

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_ORDER as readonly string[]).includes(value);
}

const effortRank = (level: EffortLevel): number => EFFORT_ORDER.indexOf(level);

/** The user's per-provider subagent configuration (§6.2). */
export interface RosterEntry {
  enabled: boolean;
  /** Empty = every model the provider's cache carries. */
  allowedModels: string[];
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  /** Ceiling. A higher request is clamped and the clamp is reported. */
  maxEffort?: EffortLevel;
  /** Free text the main agent sees; replaces any hardcoded strengths table. */
  notes?: string;
  allowWrite: boolean;
}

export function defaultRosterEntry(): RosterEntry {
  return { enabled: true, allowedModels: [], allowWrite: true };
}

/** One provider's cached model list, and whether it has been warmed at all. */
export interface ModelCacheView {
  /** False = the cache was never warmed. Skip the check, never read as "no models". */
  checked: boolean;
  models: {
    id: string;
    label?: string;
    efforts?: EffortLevel[];
    contextWindow?: number;
    isDefault?: boolean;
  }[];
}

/** What the parent session may itself do — the ceiling for any child (§6.7). */
export interface ParentState {
  provider: AcpProvider;
  maxProfile: PermissionProfile;
  /** Plan mode forces every child to read-only, and says so. */
  planMode: boolean;
  effort?: EffortLevel;
}

export interface SpawnLimits {
  running: number;
  maxConcurrent: number;
  thisTurn: number;
  maxPerTurn: number;
  thisSession: number;
  maxPerSession: number;
  /** Room left in the live-session pool (`session-pool.ts`). */
  poolHeadroom: number;
}

/**
 * Which roster switch applies.
 *
 * The crew roster INHERITS the subagent roster; `companions.crew.providers.<id>
 * .enabled` is the only crew-specific override, so the caller resolves that one
 * key and hands the result in as the entry's `enabled`. The purpose is still
 * carried because the refusal wording differs.
 */
export type EligibilityPurpose = "subagent" | "crew-stage" | "generator";

export interface EligibilityInput {
  purpose: EligibilityPurpose;
  /** Connected + located + not needing login (`usableProviderIds`). */
  usable: readonly AcpProvider[];
  roster: Partial<Record<AcpProvider, RosterEntry>>;
  capabilities: (provider: AcpProvider) => {
    companionSubagentTarget: CapabilitySupport;
    hostMcp: CapabilitySupport;
  };
  models: (provider: AcpProvider) => ModelCacheView;
  parent?: ParentState;
  limits: SpawnLimits;
  /** Providers `crew-budget.ts` marked out of quota for this session. */
  exhausted?: ReadonlySet<AcpProvider>;
  /** Human-readable provider names, for messages. */
  displayName?: (provider: AcpProvider) => string;
  /** Effort defaults, in the order §6.3.1 consults them. */
  effortDefaults?: EffortDefaults;
  /** A "no subagents for this message" directive is in force (§6.8). */
  forbiddenThisTurn?: boolean;
  /** The master switch, or this session's gear override. */
  subagentsEnabled?: boolean;
  /**
   * The user's own routing rules (`companions.subagents.routing`, P6).
   *
   * Step 3 of §6.4.2's target resolution. Consulted only when the agent, the
   * role and an explicit directive have all left the target open — a rule is
   * advice about which worker suits which job, not an override of a choice
   * somebody already made.
   */
  routing?: readonly RoutingRule[];
}

/** Refusal codes (§6.13). Every one of them is user-visible somewhere. */
export type RefusalCode =
  | "subagents-disabled"
  | "provider-not-usable"
  | "provider-disabled"
  | "model-unknown"
  | "model-not-allowed"
  | "profile-not-allowed"
  | "limit-reached"
  | "provider-quota"
  | "forbidden-by-user"
  | "denied-by-user"
  | "no-eligible-target"
  | "timeout"
  | "child-crashed";

export interface SpawnRequest {
  provider?: AcpProvider;
  model?: string;
  effort?: EffortLevel;
  profile?: PermissionProfile;
  /** A named role acting as a template; its frontmatter fills gaps. */
  role?: {
    provider?: AcpProvider;
    model?: string;
    effort?: EffortLevel;
    preferDifferentProvider?: boolean;
  };
  /** The spawn's own words, matched against the user's routing rules (§6.2). */
  task?: string;
  /** A short name the spawn gave itself; matched alongside the task. */
  label?: string;
}

/**
 * One user-written routing rule (`companions.subagents.routing`, P6).
 *
 * The keywords are the USER'S, and so is the target — which is the whole reason
 * this key exists rather than a table of model strengths in code (D12). A rule
 * is advice about which worker suits which kind of job; it never widens what is
 * eligible, so a rule pointing at a companion that is logged out simply does
 * not apply.
 */
export interface RoutingRule {
  /** Case-insensitive substrings. Any one of them matching is a match. */
  match: string[];
  target: { provider?: AcpProvider; model?: string; effort?: EffortLevel };
}

/**
 * The first rule whose keywords appear in the spawn's task or label.
 *
 * Ordered, first match wins — the settings list order IS the precedence, which
 * is what makes a narrow rule above a broad one behave the way anyone would
 * expect from a rule list.
 */
export function matchRoutingRule(
  rules: readonly RoutingRule[] | undefined,
  request: { task?: string; label?: string },
): RoutingRule | undefined {
  const haystack = `${request.task ?? ""} ${request.label ?? ""}`.toLowerCase();
  if (!haystack.trim()) return undefined;
  return (rules ?? []).find((rule) =>
    (rule.match ?? []).some((keyword) => {
      const needle = String(keyword ?? "").trim().toLowerCase();
      return !!needle && haystack.includes(needle);
    }),
  );
}

/**
 * Normalize the raw setting into rules.
 *
 * Tolerant, and deliberately so: this is hand-edited JSON in a settings file.
 * A rule with no usable keyword or no target is DROPPED rather than throwing —
 * one malformed entry must not stop every other rule from working, and it must
 * certainly not stop a spawn.
 */
export function parseRoutingRules(raw: unknown): RoutingRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: RoutingRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const match = Array.isArray(record.match)
      ? record.match.filter((k): k is string => typeof k === "string" && !!k.trim()).map((k) => k.trim())
      : [];
    if (!match.length) continue;
    const rawTarget = (record.target ?? {}) as Record<string, unknown>;
    const provider = typeof rawTarget.provider === "string" && (ACP_PROVIDERS as readonly string[]).includes(rawTarget.provider)
      ? (rawTarget.provider as AcpProvider)
      : undefined;
    const model = typeof rawTarget.model === "string" && rawTarget.model.trim()
      ? rawTarget.model.trim()
      : undefined;
    const effort = isEffortLevel(rawTarget.effort) ? rawTarget.effort : undefined;
    // A rule that names nothing to route TO is not a rule.
    if (!provider && !model && !effort) continue;
    rules.push({
      match,
      target: { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    });
  }
  return rules;
}

export type ResolvedBy =
  | "explicit"
  | "role"
  | "routing-rule"
  | "roster-default"
  | "prefer-different-provider"
  | "roster-order";

export type EligibilityResult =
  | {
      ok: true;
      target: Target & { provider: AcpProvider };
      profile: PermissionProfile;
      effortClamped?: { requested: EffortLevel; applied: EffortLevel };
      /** False when the provider's model cache was never warmed (§6.3 rule 4). */
      modelVerified: boolean;
      profileDowngraded?: string;
      sameProviderAsParent: boolean;
      /** Which resolution step chose the provider, for the card and the result. */
      resolvedBy: ResolvedBy;
    }
  | { ok: false; code: RefusalCode; message: string; alternatives: Target[] };

const rosterFor = (input: EligibilityInput, provider: AcpProvider): RosterEntry =>
  input.roster[provider] ?? defaultRosterEntry();

const nameOf = (input: EligibilityInput, provider: AcpProvider): string =>
  input.displayName?.(provider) ?? provider;

// ---------------------------------------------------------------------------
// §6.3.1 — effort resolution for children
// ---------------------------------------------------------------------------

/**
 * The defaults the chain consults after the explicit request and the role.
 *
 * `sessionOverride` is the session gear's **Subagent effort**, per provider then
 * for all providers; `global` is `companions.subagents.defaultEffort`, whose
 * shipped value is the literal `"inherit"` — meaning the parent session's
 * current effort, not a level of its own.
 */
export interface EffortDefaults {
  sessionOverride?: Partial<Record<AcpProvider | "*", EffortLevel | "inherit">>;
  rosterDefault?: (provider: AcpProvider) => EffortLevel | undefined;
  global?: EffortLevel | "inherit";
  providerDefault?: (provider: AcpProvider) => EffortLevel | undefined;
  parentEffort?: EffortLevel;
}

/**
 * First match wins. The result is NOT yet clamped — clamping is a separate step
 * so the caller can report `effortClamped: { requested, applied }` against what
 * the chain actually chose rather than against the raw tool argument.
 *
 * The parent's effort never raises a child implicitly: `inherit` only reaches
 * spawns with no role, because the shipped `inspector` role pins `low`.
 */
export function resolveChildEffort(
  provider: AcpProvider,
  request: { effort?: EffortLevel; roleEffort?: EffortLevel; routedEffort?: EffortLevel },
  defaults: EffortDefaults = {},
): EffortLevel | undefined {
  if (isEffortLevel(request.effort)) return request.effort;
  if (isEffortLevel(request.roleEffort)) return request.roleEffort;
  // Step 3 of §6.3.1's chain, in the same place routing sits for the provider:
  // after anything explicit, before the session gear and the roster.
  if (isEffortLevel(request.routedEffort)) return request.routedEffort;

  const perProvider = defaults.sessionOverride?.[provider];
  const forAll = defaults.sessionOverride?.["*"];
  for (const override of [perProvider, forAll]) {
    if (override === "inherit") return defaults.parentEffort;
    if (isEffortLevel(override)) return override;
  }

  const rosterDefault = defaults.rosterDefault?.(provider);
  if (isEffortLevel(rosterDefault)) return rosterDefault;

  if (defaults.global === "inherit") return defaults.parentEffort;
  if (isEffortLevel(defaults.global)) return defaults.global;

  const providerDefault = defaults.providerDefault?.(provider);
  if (isEffortLevel(providerDefault)) return providerDefault;
  return undefined;
}

/**
 * Clamp an effort to the roster ceiling and to what the model supports.
 *
 * A model whose cache entry lists no `efforts` is not evidence of a restriction
 * — absent metadata means unknown, so only the roster ceiling applies. Clamping
 * is always downwards: a silent bump upwards would spend more of a subscription
 * than the user allowed.
 */
export function clampEffort(
  requested: EffortLevel | undefined,
  ceiling: EffortLevel | undefined,
  supported?: readonly EffortLevel[],
): { applied?: EffortLevel; clamped?: { requested: EffortLevel; applied: EffortLevel } } {
  if (!requested) return {};
  let applied = requested;
  if (ceiling && effortRank(applied) > effortRank(ceiling)) applied = ceiling;
  const list = (supported ?? []).filter(isEffortLevel);
  if (list.length && !list.includes(applied)) {
    const below = list
      .filter((level) => effortRank(level) <= effortRank(applied))
      .sort((a, b) => effortRank(b) - effortRank(a))[0];
    // Nothing at or below the target: take the weakest the model offers rather
    // than send an effort it will reject.
    applied = below ?? [...list].sort((a, b) => effortRank(a) - effortRank(b))[0];
  }
  return applied === requested ? { applied } : { applied, clamped: { requested, applied } };
}

// ---------------------------------------------------------------------------
// §6.3 — the eight eligibility rules, in order
// ---------------------------------------------------------------------------

const profileRank: Record<PermissionProfile, number> = {
  "read-only": 0,
  "scoped-edit": 1,
  inherit: 2,
};

/** Why this provider cannot be used, or undefined if it can. Rules 1-3, plus quota. */
export function providerRefusal(
  input: EligibilityInput,
  provider: AcpProvider,
): { code: RefusalCode; message: string } | undefined {
  if (!input.usable.includes(provider)) {
    return {
      code: "provider-not-usable",
      message: `${nameOf(input, provider)} is not connected, not installed, or needs a login.`,
    };
  }
  if (!rosterFor(input, provider).enabled) {
    return {
      code: "provider-disabled",
      message:
        input.purpose === "crew-stage"
          ? `The user disabled ${nameOf(input, provider)} for crew stages.`
          : `The user disabled ${nameOf(input, provider)} for subagents.`,
    };
  }
  if (input.capabilities(provider).companionSubagentTarget.state === "no") {
    return {
      code: "provider-not-usable",
      message: `${nameOf(input, provider)} cannot be started as a companion subagent.`,
    };
  }
  if (input.exhausted?.has(provider)) {
    return {
      code: "provider-quota",
      message: `${nameOf(input, provider)} hit a usage limit earlier in this session.`,
    };
  }
  return undefined;
}

/** Rule 8 — counts and pool room. Independent of which provider is chosen. */
export function limitRefusal(
  limits: SpawnLimits,
): { code: RefusalCode; message: string } | undefined {
  if (limits.running >= limits.maxConcurrent) {
    return {
      code: "limit-reached",
      message: `${limits.running} subagent(s) already running (limit ${limits.maxConcurrent}).`,
    };
  }
  if (limits.thisTurn >= limits.maxPerTurn) {
    return {
      code: "limit-reached",
      message: `${limits.thisTurn} subagent(s) started in this turn (limit ${limits.maxPerTurn}).`,
    };
  }
  if (limits.thisSession >= limits.maxPerSession) {
    return {
      code: "limit-reached",
      message: `${limits.thisSession} subagent(s) started in this session (limit ${limits.maxPerSession}).`,
    };
  }
  if (limits.poolHeadroom <= 0) {
    return { code: "limit-reached", message: "No room in the live-session pool right now." };
  }
  return undefined;
}

/** Rule 6 — the profile, against the roster and against the parent. */
export function resolveProfile(
  input: EligibilityInput,
  provider: AcpProvider,
  requested: PermissionProfile,
): { profile: PermissionProfile; downgraded?: string } | { code: RefusalCode; message: string } {
  // A parent that cannot edit cannot lend editing. This is a downgrade, not a
  // refusal: read-only is always available, and saying so beats failing.
  if (input.parent?.planMode && requested !== "read-only") {
    return { profile: "read-only", downgraded: "parent in plan mode" };
  }
  if (requested === "read-only") return { profile: "read-only" };
  if (!rosterFor(input, provider).allowWrite) {
    return {
      code: "profile-not-allowed",
      message: `${nameOf(input, provider)} is limited to read-only subagents. The allowed maximum is read-only.`,
    };
  }
  const parentMax = input.parent?.maxProfile;
  if (parentMax && profileRank[requested] > profileRank[parentMax]) {
    return {
      code: "profile-not-allowed",
      message: `A subagent never gets more than its parent. The allowed maximum is ${parentMax}.`,
    };
  }
  return { profile: requested };
}

/** Rule 4 — the model, against the cache and the roster allow-list. */
export function resolveModel(
  input: EligibilityInput,
  provider: AcpProvider,
  requested: string | undefined,
): { model?: string; verified: boolean } | { code: RefusalCode; message: string } {
  const roster = rosterFor(input, provider);
  const wanted = (requested ?? roster.defaultModel ?? "").trim();
  const cache = input.models(provider);
  const known = cache.models.filter((entry) => typeof entry?.id === "string" && entry.id.length > 0);

  if (!wanted) {
    // No model means "this provider's default", which is a real, working
    // choice — the same rule `validateRoleModel` applies to roles.
    return { model: undefined, verified: cache.checked && known.length > 0 };
  }
  if (roster.allowedModels.length && !roster.allowedModels.includes(wanted)) {
    return {
      code: "model-not-allowed",
      message: `The user's allow-list for ${nameOf(input, provider)} is: ${[...roster.allowedModels].sort().join(", ")}.`,
    };
  }
  if (!cache.checked || !known.length) {
    // An unwarmed cache is not evidence that the model is wrong. Skip rather
    // than guess, and let the card say the model was not verified.
    return { model: wanted, verified: false };
  }
  if (!known.some((entry) => entry.id === wanted)) {
    return {
      code: "model-unknown",
      message: `${nameOf(input, provider)} has no model '${wanted}'. Available: ${known
        .map((entry) => entry.id)
        .sort()
        .join(", ")}.`,
    };
  }
  return { model: wanted, verified: true };
}

/** Providers that pass rules 1-3, in roster order. */
export function eligibleProviders(input: EligibilityInput): AcpProvider[] {
  return ACP_PROVIDERS.filter((provider) => !providerRefusal(input, provider));
}

/**
 * Rules 1-8 for one request, in the order that makes the message actionable.
 *
 * Target resolution (§6.4.2) fills the gaps first: explicit fields always win,
 * then the role's frontmatter, then — for roles that ask for it — the first
 * eligible provider that differs from the parent, then roster order preferring
 * anything but the parent's own provider. An explicitly named provider that
 * cannot run is an ERROR, never a silent substitution.
 */
export function resolveTarget(request: SpawnRequest, input: EligibilityInput): EligibilityResult {
  if (input.subagentsEnabled === false) {
    return {
      ok: false,
      code: "subagents-disabled",
      message: "Subagents are turned off for this session.",
      alternatives: [],
    };
  }
  if (input.forbiddenThisTurn) {
    return {
      ok: false,
      code: "forbidden-by-user",
      message: "The user asked for no subagents on this message.",
      alternatives: [],
    };
  }

  const limits = limitRefusal(input.limits);
  if (limits) return { ok: false, ...limits, alternatives: [] };

  const eligible = eligibleProviders(input);
  const alternatives = (): Target[] => eligible.map((provider) => ({ provider }));

  // Matched once, up front, so the model and effort steps below can consult the
  // same rule the provider step did rather than re-matching and possibly
  // landing on a different one.
  const routed = request.provider || request.role?.provider
    ? undefined
    : matchRoutingRule(input.routing, request);

  // --- which provider ---
  let provider: AcpProvider | undefined;
  let resolvedBy: ResolvedBy = "explicit";
  if (request.provider) {
    provider = request.provider;
    const refusal = providerRefusal(input, provider);
    if (refusal) return { ok: false, ...refusal, alternatives: alternatives() };
  } else if (request.role?.provider && !providerRefusal(input, request.role.provider)) {
    provider = request.role.provider;
    resolvedBy = "role";
  } else if (routed?.target.provider && !providerRefusal(input, routed.target.provider)) {
    // Step 3 — the user's own routing rules. A rule never WIDENS eligibility:
    // one pointing at a companion that is logged out or turned off simply does
    // not apply, and resolution falls through to the steps below.
    provider = routed.target.provider;
    resolvedBy = "routing-rule";
  } else if (request.role?.preferDifferentProvider) {
    provider = eligible.find((candidate) => candidate !== input.parent?.provider) ?? eligible[0];
    resolvedBy = "prefer-different-provider";
  } else {
    provider = eligible.find((candidate) => candidate !== input.parent?.provider) ?? eligible[0];
    resolvedBy = "roster-order";
  }
  if (!provider) {
    return {
      ok: false,
      code: "no-eligible-target",
      message: "No subagent is available right now; continue alone and tell the user why.",
      alternatives: [],
    };
  }

  // --- model ---
  // A routing rule's model applies only when it also supplied the provider —
  // a model id means nothing next to a companion that does not have it.
  const routedModel = resolvedBy === "routing-rule" ? routed?.target.model : undefined;
  const requestedModel = request.model ?? request.role?.model ?? routedModel;
  const model = resolveModel(input, provider, requestedModel);
  if ("code" in model) return { ok: false, ...model, alternatives: alternatives() };
  if (!requestedModel && rosterFor(input, provider).defaultModel && resolvedBy === "roster-order") {
    resolvedBy = "roster-default";
  }

  // --- profile ---
  const requestedProfile = isPermissionProfile(request.profile) ? request.profile : "read-only";
  const profile = resolveProfile(input, provider, requestedProfile);
  if ("code" in profile) return { ok: false, ...profile, alternatives: alternatives() };

  // --- effort ---
  const chosenEffort = resolveChildEffort(
    provider,
    {
      effort: request.effort,
      roleEffort: request.role?.effort,
      // Same restriction as the model: a rule's effort applies only where the
      // rule actually decided the target.
      ...(resolvedBy === "routing-rule" && routed?.target.effort
        ? { routedEffort: routed.target.effort }
        : {}),
    },
    {
      ...(input.effortDefaults ?? {}),
      rosterDefault:
        input.effortDefaults?.rosterDefault
        ?? ((candidate: AcpProvider) => rosterFor(input, candidate).defaultEffort),
      parentEffort: input.effortDefaults?.parentEffort ?? input.parent?.effort,
    },
  );
  const supported = input.models(provider).models.find((entry) => entry.id === model.model)?.efforts;
  const effort = clampEffort(chosenEffort, rosterFor(input, provider).maxEffort, supported);

  return {
    ok: true,
    target: {
      provider,
      ...(model.model ? { model: model.model } : {}),
      ...(effort.applied ? { effort: effort.applied } : {}),
    },
    profile: profile.profile,
    ...(effort.clamped ? { effortClamped: effort.clamped } : {}),
    modelVerified: model.verified,
    ...(profile.downgraded ? { profileDowngraded: profile.downgraded } : {}),
    sameProviderAsParent: provider === input.parent?.provider,
    resolvedBy,
  };
}

// ---------------------------------------------------------------------------
// §6.4.2 — the compact roster the main agent sees
// ---------------------------------------------------------------------------

export interface TargetListingEntry {
  provider: AcpProvider;
  displayName: string;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  maxEffort?: EffortLevel;
  allowedProfiles: PermissionProfile[];
  notes?: string;
  modelCount: number;
  /** False = the cache was never warmed, so `modelCount` is not a claim. */
  modelListVerified: boolean;
  /** Only for the one provider named in `expand`. */
  models?: {
    id: string;
    label?: string;
    efforts?: EffortLevel[];
    contextWindow?: number;
    isDefault?: boolean;
  }[];
}

export interface TargetListing {
  targets: TargetListingEntry[];
  ineligible: { provider: AcpProvider; reason: RefusalCode; message: string }[];
  limits: {
    maxConcurrent: number;
    running: number;
    remainingThisTurn: number;
    remainingThisSession: number;
  };
  parent?: { provider: AcpProvider; maxProfile: PermissionProfile };
}

/**
 * Compact by default (§2.1 point 3): a per-model array is returned for the one
 * provider named in `expand` and nobody else, because these schemas and their
 * answers sit in every parent turn.
 *
 * Fields the cache does not know are OMITTED rather than filled with a guess —
 * an invented context window is worse than a missing one.
 */
export function listEligibleTargets(
  input: EligibilityInput,
  options: { includeIneligible?: boolean; expand?: AcpProvider } = {},
): TargetListing {
  const targets: TargetListingEntry[] = [];
  const ineligible: TargetListing["ineligible"] = [];

  for (const provider of ACP_PROVIDERS) {
    const refusal = providerRefusal(input, provider);
    if (refusal) {
      // The reason is always recorded; `includeIneligible` decides whether the
      // caller renders it, and a refusal the agent cannot see is a refusal it
      // will retry, so the list is never silently trimmed here.
      ineligible.push({ provider, reason: refusal.code, message: refusal.message });
      continue;
    }
    const roster = rosterFor(input, provider);
    const cache = input.models(provider);
    const allowedProfiles: PermissionProfile[] = ["read-only"];
    if (roster.allowWrite && !input.parent?.planMode) {
      const parentMax = input.parent?.maxProfile ?? "inherit";
      for (const profile of ["scoped-edit", "inherit"] as const) {
        if (profileRank[profile] <= profileRank[parentMax]) allowedProfiles.push(profile);
      }
    }
    const entry: TargetListingEntry = {
      provider,
      displayName: nameOf(input, provider),
      ...(roster.defaultModel ? { defaultModel: roster.defaultModel } : {}),
      ...(roster.defaultEffort ? { defaultEffort: roster.defaultEffort } : {}),
      ...(roster.maxEffort ? { maxEffort: roster.maxEffort } : {}),
      allowedProfiles,
      ...(roster.notes ? { notes: roster.notes } : {}),
      modelCount: cache.models.length,
      modelListVerified: cache.checked,
    };
    if (options.expand === provider) {
      entry.models = cache.models.map((model) => ({
        id: model.id,
        ...(model.label ? { label: model.label } : {}),
        ...(model.efforts?.length ? { efforts: model.efforts } : {}),
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(model.isDefault ? { isDefault: true } : {}),
      }));
    }
    targets.push(entry);
  }

  return {
    targets,
    // Always computed. `includeIneligible` is a TOOL-layer trim (§6.4.2): the
    // host needs the reasons for the settings roster and the directive
    // validator either way, and a refusal the agent cannot see is a refusal it
    // retries. `options.includeIneligible` is read by the MCP surface, not here.
    ineligible,
    limits: {
      maxConcurrent: input.limits.maxConcurrent,
      running: input.limits.running,
      remainingThisTurn: Math.max(0, input.limits.maxPerTurn - input.limits.thisTurn),
      remainingThisSession: Math.max(0, input.limits.maxPerSession - input.limits.thisSession),
    },
    ...(input.parent
      ? { parent: { provider: input.parent.provider, maxProfile: input.parent.maxProfile } }
      : {}),
  };
}
