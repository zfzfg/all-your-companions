/**
 * One failover decision for legacy crew, workflow stages and subagents.
 *
 * Classification stays in `classifyLimitError`. This file only chooses wait,
 * switch or stop, so the three call sites cannot grow a second heuristic.
 * The default policy is `ask`: stop and show the gate. `switch` is opt-in.
 * Auth, a user refusal, a timeout that may have written, and an unclassified
 * error never change provider.
 *
 * Pure. `rand` is injected so a test can pin the jitter.
 */

import type { AcpProvider } from "./acp-backend";
import { classifyLimitError, type LimitKind } from "./limit-errors";

export type FailoverClass = LimitKind | "side-effect" | "unclassified";

export type FailoverAction =
  | { action: "wait"; waitMs: number; reason: string }
  | { action: "switch"; provider: string; reason: string }
  | { action: "stop"; reason: string };

export function classifyFailover(input: {
  provider: AcpProvider;
  message: string;
  code?: number;
  timedOut?: boolean;
  mayHaveWritten?: boolean;
}): FailoverClass {
  if (input.timedOut || input.mayHaveWritten) return "side-effect";
  return classifyLimitError(input.provider, input.message, input.code) ?? "unclassified";
}

/** Bounded backoff. Attempt 1 waits about a second, then 2s, 4s, capped at 30s. */
export function rateBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const base = Math.min(30_000, 1000 * 2 ** (n - 1));
  const jitter = Math.floor(Math.max(0, rand()) * base * 0.2);
  return base + jitter;
}

export function decideFailover(input: {
  kind: FailoverClass;
  /** `ask` never switches and never waits on its own. `switch` may. */
  policy: "ask" | "switch";
  /**
   * Legacy `/crew` already switches on rate and quota. Pass true only there,
   * so the default of every other path stays the configured policy.
   */
  legacyAutoSwitch?: boolean;
  attempt: number;
  maxAttempts: number;
  cancelled?: boolean;
  exhausted: readonly string[];
  usable: readonly string[];
  /** The user or a must-directive named the provider. Do not leave it. */
  explicitTarget?: boolean;
  rand?: () => number;
}): FailoverAction {
  if (input.cancelled) return { action: "stop", reason: "cancelled during failover" };
  const attempt = Number.isFinite(input.attempt) ? input.attempt : 1;
  const maxAttempts = Number.isFinite(input.maxAttempts) ? input.maxAttempts : 1;
  if (attempt >= maxAttempts) return { action: "stop", reason: "attempt budget is spent" };
  if (input.kind === "auth") return { action: "stop", reason: "authentication failed; a different model would not fix it" };
  if (input.kind === "side-effect") return { action: "stop", reason: "the attempt may have written; it is not retried blindly" };
  if (input.kind === "unclassified") return { action: "stop", reason: "the error is not a usage limit" };
  const allowSwitch = input.policy === "switch" || input.legacyAutoSwitch === true;
  if (!allowSwitch) return { action: "stop", reason: "failover is ask, so the run stops here" };
  if (input.kind === "rate") {
    return {
      action: "wait",
      waitMs: rateBackoffMs(attempt, input.rand ?? Math.random),
      reason: "short rate limit; waiting before the same provider",
    };
  }
  if (input.explicitTarget) return { action: "stop", reason: "the provider was named explicitly" };
  const gone = new Set(input.exhausted);
  const next = input.usable.find((provider) => !gone.has(provider));
  if (!next) return { action: "stop", reason: "no other usable provider" };
  return { action: "switch", provider: next, reason: `account limit; switching to ${next}` };
}
