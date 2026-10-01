import type { AcpProvider } from "./acp-backend";
import type { PromptContentBlock } from "./acp-types";

export type ContextQuality = "verified" | "estimated" | "unknown";
export type ContextSource = "session" | "catalog" | "documented" | "adapter" | "persisted";
export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export type ContextUsageSemantics = "current-context" | "estimated-context" | "last-request" | "turn-cumulative" | "session-cumulative" | "billing" | "subscription" | "unknown";
export interface ContextRevision {
  process: number;
  session: number;
  model: number;
  compaction: number;
}
export interface ContextRuntime {
  product: string;
  executable?: string;
  cliVersion?: string;
  adapterVersion?: string;
  protocolVersion?: string;
}

export interface ModelContextLimits {
  modelMaximum?: number;
  configuredWindow?: number;
  activeWindow?: number;
  autoCompactAtTokens?: number;
  contextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  effectiveContextTokens?: number;
  autoCompactThresholdPercent?: number;
  /** Configured output includes reasoning; never add reasoning a second time. */
  outputReserve?: number;
  /** Effective CLI budget already excludes an output reserve. */
  reserveIncluded?: boolean;
}

export interface ContextObservation {
  provider: AcpProvider;
  access: string;
  modelId?: string;
  resolvedModelId?: string;
  sessionId?: string;
  generation: number;
  source: ContextSource;
  observedAt: number;
  usageObservedAt?: number;
  usageSource?: ContextSource;
  usageSemantics?: ContextUsageSemantics;
  usageStale?: boolean;
  revision?: ContextRevision;
  runtime?: ContextRuntime;
  limitQuality: ContextQuality;
  usageQuality: ContextQuality;
  stale?: boolean;
  limits: ModelContextLimits;
  /** Public API reference only; never participates in CLI budget enforcement. */
  documentedLimits?: ModelContextLimits;
  used?: number;
}

export function contextTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
export function contextUsed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function effectiveContextWindow(limits: ModelContextLimits): number | undefined {
  return contextTokens(limits.effectiveContextTokens) ?? contextTokens(limits.inputTokenLimit)
    ?? contextTokens(limits.activeWindow) ?? contextTokens(limits.configuredWindow) ?? contextTokens(limits.contextWindow);
}
export function validContextLimits(raw: ModelContextLimits): ModelContextLimits {
  return {
    modelMaximum: contextTokens(raw.modelMaximum),
    configuredWindow: contextTokens(raw.configuredWindow),
    activeWindow: contextTokens(raw.activeWindow),
    autoCompactAtTokens: contextTokens(raw.autoCompactAtTokens),
    contextWindow: contextTokens(raw.contextWindow),
    inputTokenLimit: contextTokens(raw.inputTokenLimit),
    outputTokenLimit: contextTokens(raw.outputTokenLimit),
    effectiveContextTokens: contextTokens(raw.effectiveContextTokens),
    outputReserve: contextUsed(raw.outputReserve),
    reserveIncluded: raw.reserveIncluded === true,
    autoCompactThresholdPercent: typeof raw.autoCompactThresholdPercent === "number"
      && Number.isFinite(raw.autoCompactThresholdPercent) && raw.autoCompactThresholdPercent > 0
      && raw.autoCompactThresholdPercent < 100 ? raw.autoCompactThresholdPercent : undefined,
  };
}

/** No public API reference is shipped without versioned source evidence.
 * Native catalogs and sessions are the authority for CLI capacities. */
export const DOCUMENTED_CONTEXT: Partial<Record<AcpProvider, Record<string, ModelContextLimits>>> = {};

/** Independent priority for usage and limit: catalog refresh must not erase usage. */
export function mergeContextObservation(previous: ContextObservation | undefined, incoming: ContextObservation): ContextObservation {
  const next = { ...incoming, limits: validContextLimits(incoming.limits), used: contextUsed(incoming.used) };
  if (next.usageSemantics && next.usageSemantics !== "current-context" && next.usageSemantics !== "estimated-context") next.used = undefined;
  if (next.source === "documented") next.limits = {};
  if (!previous || previous.generation !== next.generation || previous.access !== next.access
    || previous.sessionId !== next.sessionId || previous.modelId !== next.modelId
    || (previous.revision && next.revision && Object.keys(previous.revision).some(key =>
      previous.revision![key as keyof ContextRevision] !== next.revision![key as keyof ContextRevision]))) return next;
  const rank = (o: ContextObservation) => o.stale ? 0
    : o.source === "session" && o.limits.activeWindow ? 4
    : o.limitQuality !== "verified" ? 1 : o.source === "session" ? 4 : o.source === "catalog" ? 3 : 2;
  const prevWindow = effectiveContextWindow(previous.limits);
  const nextWindow = effectiveContextWindow(next.limits);
  const prevIsApiMax = previous.source === "documented";
  const nextIsApiMax = next.source === "documented";
  const isEnlargement = previous.limitQuality === "verified" && previous.source === "catalog"
    && next.source === "session" && next.limitQuality !== "verified"
    && !next.limits.activeWindow
    && (nextWindow ?? 0) > (prevWindow ?? 0);
  const keepLimit = (nextWindow === undefined)
    || (nextIsApiMax && prevWindow !== undefined && !prevIsApiMax)
    || (!prevIsApiMax && (isEnlargement || rank(previous) > rank(next)
      || (rank(previous) === rank(next) && previous.observedAt > next.observedAt)));
  const limit = keepLimit ? previous : next;
  const usage = next.used === undefined
    || (previous.usageObservedAt ?? 0) > (next.usageObservedAt ?? next.observedAt)
    || (previous.usageQuality === "verified" && next.usageQuality === "estimated"
      && (next.usageObservedAt ?? next.observedAt) <= (previous.usageObservedAt ?? previous.observedAt)) ? previous : next;
  return { ...limit, limits: { ...limit.limits,
    modelMaximum: next.limits.modelMaximum ?? previous.limits.modelMaximum,
    autoCompactAtTokens: limit.limits.autoCompactAtTokens ?? previous.limits.autoCompactAtTokens },
    resolvedModelId: next.resolvedModelId ?? previous.resolvedModelId,
    used: usage.used, usageQuality: usage.usageQuality, usageObservedAt: usage.usageObservedAt,
    usageSource: usage.usageSource ?? usage.source, usageSemantics: usage.usageSemantics,
    usageStale: usage.usageStale ?? usage.stale };
}

/** Invalidations are explicit; a missing count in a catalog event is not one. */
export function invalidateContextUsage(observation: ContextObservation): ContextObservation {
  return { ...observation, used: undefined, usageQuality: "unknown", usageSemantics: "unknown", usageStale: true };
}

export function historicalContextObservation(observation: ContextObservation): ContextObservation {
  return { ...observation, stale: true, usageStale: true, usageQuality: "estimated",
    usageSemantics: "estimated-context" };
}

export interface ContextPromptCount {
  tokens: number;
  quality: "verified" | "estimated";
  /** Counts the complete serialized request, including CLI history/system/tools. */
  complete?: boolean;
}
export interface ContextBudgetDecision {
  action: "allow" | "warn" | "block";
  reason: "unknown" | "fits" | "overflow";
  projected?: number;
  window?: number;
  quality: ContextQuality;
}

/** Text estimate only. Images/resources and invisible CLI content remain uncounted. */
export function estimateContextPrompt(prompt: readonly PromptContentBlock[]): ContextPromptCount {
  let tokens = 0;
  for (const block of prompt) {
    if (block.type === "text") tokens += Math.ceil(Buffer.byteLength(block.text, "utf8") / 3);
  }
  return { tokens, quality: "estimated", complete: false };
}

export function checkContextBudget(observation: ContextObservation | undefined, count: ContextPromptCount): ContextBudgetDecision {
  const window = observation?.source !== "documented" && observation ? effectiveContextWindow(observation.limits) : undefined;
  if (!window || contextUsed(count.tokens) === undefined) return { action: "warn", reason: "unknown", quality: "unknown" };
  const limits = observation!.limits;
  const reserve = limits.inputTokenLimit || limits.reserveIncluded ? 0 : limits.outputReserve;
  const projected = count.tokens + (count.complete ? 0 : observation!.used ?? 0) + (reserve ?? 0);
  const verified = count.quality === "verified" && count.complete === true
    && observation!.limitQuality === "verified" && !observation!.stale && reserve !== undefined;
  return { action: projected > window ? verified ? "block" : "warn" : "allow",
    reason: projected > window ? "overflow" : "fits", projected, window,
    quality: verified ? "verified" : "estimated" };
}

export class ContextBudgetExceededError extends Error {
  constructor(public readonly decision: ContextBudgetDecision) {
    super(`context_length_exceeded: request requires ${decision.projected} tokens; maximum context length is ${decision.window}. Reduce context, compact, or start a new chat.`);
    this.name = "ContextBudgetExceededError";
  }
}
