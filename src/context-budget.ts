import type { AcpProvider } from "./acp-backend";
import type { PromptContentBlock } from "./acp-types";

export type ContextQuality = "verified" | "estimated" | "unknown";
export type ContextSource = "session" | "catalog" | "documented" | "adapter" | "persisted";
export const CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelContextLimits {
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
  return contextTokens(limits.effectiveContextTokens) ?? contextTokens(limits.inputTokenLimit) ?? contextTokens(limits.contextWindow);
}
export function validContextLimits(raw: ModelContextLimits): ModelContextLimits {
  return {
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

/** Public API capabilities, not promises about a CLI subscription or router. */
export const DOCUMENTED_CONTEXT: Partial<Record<AcpProvider, Record<string, ModelContextLimits>>> = {
  grok: { "grok-4.7": { contextWindow: 500000 }, "grok-4.6": { contextWindow: 500000 } },
  codex: {
    "gpt-6.1-sol": { contextWindow: 1050000, outputTokenLimit: 128000 },
    "gpt-6-sol": { contextWindow: 1050000, outputTokenLimit: 128000 },
    "gpt-5.6-sol": { contextWindow: 1050000, outputTokenLimit: 128000 },
    "gpt-oss-120b": { contextWindow: 131072 },
  },
  claude: {
    "claude-fable-5-1": { contextWindow: 1000000, outputTokenLimit: 128000 },
    "claude-opus-5-5": { contextWindow: 1000000, outputTokenLimit: 128000 },
    "claude-sonnet-5-5": { contextWindow: 1000000, outputTokenLimit: 128000 },
    "claude-sonnet-5": { contextWindow: 1000000 },
    "claude-opus-5": { contextWindow: 1000000 },
    "claude-opus-4-6": { contextWindow: 1000000 },
    "claude-sonnet-4-6": { contextWindow: 1000000 },
    "claude-haiku-4-5": { contextWindow: 200000, outputTokenLimit: 64000 },
    "claude-3-5-sonnet": { contextWindow: 200000 },
  },
};

/** Independent priority for usage and limit: catalog refresh must not erase usage. */
export function mergeContextObservation(previous: ContextObservation | undefined, incoming: ContextObservation): ContextObservation {
  const next = { ...incoming, limits: validContextLimits(incoming.limits), used: contextUsed(incoming.used) };
  if (!previous || previous.generation !== next.generation || previous.access !== next.access
    || previous.sessionId !== next.sessionId || previous.modelId !== next.modelId) return next;
  const rank = (o: ContextObservation) => o.stale ? 0
    : o.limitQuality !== "verified" ? 1 : o.source === "session" ? 4 : o.source === "catalog" ? 3 : 2;
  const prevWindow = effectiveContextWindow(previous.limits);
  const nextWindow = effectiveContextWindow(next.limits);
  const prevIsApiMax = prevWindow === 500000 || previous.source === "documented";
  const nextIsApiMax = nextWindow === 500000 || next.source === "documented";
  const isEnlargement = previous.limitQuality === "verified" && previous.source === "catalog"
    && next.source === "session" && next.limitQuality !== "verified"
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
  return { ...limit, used: usage.used, usageQuality: usage.usageQuality, usageObservedAt: usage.usageObservedAt };
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
  const window = observation && effectiveContextWindow(observation.limits);
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
