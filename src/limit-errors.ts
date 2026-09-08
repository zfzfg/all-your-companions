// Quota / rate-limit classification and failover copy (AP-06).
//
// Wraps the existing classifiers in acp-dispatch.ts — it does not replace them.
// A second regex over the same strings would drift from #57's precedence:
// `isRateLimitError` (ACP -32003 before text) wins, and `isAuthErrorText`
// yields to `isRateLimitErrorText` so a weekly-limit error never opens login.
//
// Recipe R7: no vscode, no fs, no Date.now.

import type { AcpProvider } from "./acp-backend";
import {
  AUTH_REQUIRED_ERROR_CODE,
  RATE_LIMITED_ERROR_CODE,
  isAuthErrorText,
  isCredentialError,
  isRateLimitError,
  isRateLimitErrorText,
} from "./acp-dispatch";
import { PROVIDER_ORDER, providerDisplayName } from "./provider-ui";

export type LimitKind = "rate" | "quota" | "auth";
export type LimitOfferAction = "continue" | "retry" | "dismiss";
export type LimitOfferRecommended = "continue" | "retry";

export interface LimitOfferTarget {
  id: AcpProvider;
  name: string;
}

/**
 * Classify a turn failure.
 *
 * Returns `"rate"` / `"quota"` only when an existing classifier already said
 * this is a limit, or when a provider-specific official code (commented with
 * its source) matches. Uncertain → `null`. A false-positive limit is worse
 * than a missed one: the word "rate" in ordinary prose must not trip this.
 */
export function classifyLimitError(
  provider: AcpProvider,
  message: string,
  code?: number,
): LimitKind | null {
  const err = { message, code };
  // Same order as the prompt-failure path: structured limit code before text,
  // limit family before auth (#57).
  if (isRateLimitError(err) || isRateLimitErrorText(message)) {
    return refineRateOrQuota(provider, message, code);
  }
  const extra = providerSpecificLimit(provider, message);
  if (extra) return extra;
  if (code === AUTH_REQUIRED_ERROR_CODE || isCredentialError(err) || isAuthErrorText(message)) {
    return "auth";
  }
  return null;
}

/**
 * Split an already-recognized limit into short-lived rate vs account quota.
 *
 * Quota is the case where another *model of the same provider* cannot help —
 * the ceiling is the account. Rate is the case where waiting is the right
 * default. Ambiguous RESOURCE_EXHAUSTED / bare -32003 defaults to `"rate"`
 * (wait), not `"quota"` (switch): switching on a 20-second throttle is the
 * more expensive mistake.
 */
function refineRateOrQuota(
  provider: AcpProvider,
  message: string,
  code?: number,
): "rate" | "quota" {
  if (isQuotaSignal(provider, message)) return "quota";
  if (isRateSignal(provider, message)) return "rate";
  // Grok ACP -32003 is documented as HTTP 429 (OSS sampling/error.rs).
  if (code === RATE_LIMITED_ERROR_CODE) return "rate";
  return "rate";
}

/**
 * Account-level ceiling. Sources per family, applied only after the shared
 * limit classifier already matched (or via {@link providerSpecificLimit}).
 */
function isQuotaSignal(provider: AcpProvider, message: string): boolean {
  // Grok / xAI — OSS sampling/error.rs + pager billing.rs (same strings as
  // isRateLimitErrorText): weekly/usage/free-usage-exhausted, spending cap.
  if (/(?:usage|weekly|monthly|daily)\s+limit|spending\s+(?:cap|limit)|free.usage.exhausted/i.test(message)) {
    return true;
  }
  // OpenAI / Codex — platform.openai.com/docs/guides/error-codes:
  // `insufficient_quota`, `credit_balance_exhausted`, and the classic
  // "You exceeded your current quota, please check your plan and billing details."
  if (provider === "codex" || provider === "grok") {
    if (/insufficient_quota|credit_balance_exhausted|exceeded your current quota/i.test(message)) {
      return true;
    }
  }
  // Anthropic / Claude — docs.anthropic.com/en/api/errors + rate-limits.md:
  // spend-cap 429 uses type rate_limit_error but `enforced_spend_limit_reached`
  // / "You have reached your API usage limits". The usage-limit branch above
  // already catches the prose; the error_code is Claude-specific.
  if (provider === "claude" && /enforced_spend_limit_reached|specified (?:workspace )?api usage limits/i.test(message)) {
    return true;
  }
  // Google / Gemini — ai.google.dev generate-content API errors: 429
  // RESOURCE_EXHAUSTED. "quota exceeded" / "quota metric" / "quota limit"
  // already live in isRateLimitErrorText; treat those as quota here.
  if (/quota\s*(?:exceeded|metric|limit)|\bquota\b/i.test(message)) return true;
  return false;
}

/** Short-lived throttle. Waiting is the right default. */
function isRateSignal(provider: AcpProvider, message: string): boolean {
  // Shared HTTP 429 / "too many requests" / "rate limit".
  if (/rate.?limit|too many requests|\b429\b|rate_limit_exceeded|tokens per min|requests per min/i.test(message)) {
    return true;
  }
  // OpenAI — error.code `rate_limit_exceeded` / type `rate_limit_error` for RPM.
  if (provider === "codex" && /rate_limit_error|\bslow_down\b/i.test(message)) return true;
  // Anthropic — type `rate_limit_error` for RPM/ITPM/OTPM (docs.anthropic.com/en/api/errors).
  // Spend-cap uses the same type but is already peeled off as quota above.
  if (provider === "claude" && /rate_limit_error/i.test(message)) return true;
  // Gemini — RESOURCE_EXHAUSTED without quota wording is typically RPM/TPM
  // (ai.google.dev troubleshooting: retry with backoff).
  if (provider === "gemini" && /resource_exhausted/i.test(message)) return true;
  return false;
}

/**
 * Official codes the shared `isRateLimitErrorText` does not already match.
 * Kept narrow: an underscore-code, not a word that appears in normal answers.
 */
function providerSpecificLimit(provider: AcpProvider, message: string): "rate" | "quota" | null {
  if (provider === "codex") {
    // platform.openai.com/docs/guides/error-codes — `insufficient_quota` is
    // not "quota exceeded", so the shared regex misses it.
    if (/insufficient_quota|credit_balance_exhausted|exceeded your current quota/i.test(message)) {
      return "quota";
    }
    if (/\brate_limit_exceeded\b|\bslow_down\b/i.test(message)) return "rate";
  }
  if (provider === "claude" && /enforced_spend_limit_reached/i.test(message)) {
    return "quota";
  }
  // ai.google.dev generate-content API errors: the prose form is
  // "Resource has been exhausted (e.g. check quota)." — spaces, so the
  // shared `resource_exhausted` token does not match.
  if (provider === "gemini" && /resource has been exhausted/i.test(message)) {
    return /\bquota\b/i.test(message) ? "quota" : "rate";
  }
  return null;
}

/**
 * Other connected providers that can take over. Never the exhausted provider:
 * a quota is per account, so another model of the same vendor is not a target.
 */
export function failoverTargets(
  source: AcpProvider,
  usable: readonly AcpProvider[],
): AcpProvider[] {
  const usableSet = new Set(usable);
  return PROVIDER_ORDER.filter((id) => id !== source && usableSet.has(id));
}

export function limitOfferTargets(
  source: AcpProvider,
  usable: readonly AcpProvider[],
): LimitOfferTarget[] {
  return failoverTargets(source, usable).map((id) => ({
    id,
    name: providerDisplayName(id),
  }));
}

/** Quota with a partner → continue; otherwise wait. */
export function recommendedLimitAction(
  kind: "rate" | "quota",
  targets: readonly LimitOfferTarget[],
): LimitOfferRecommended {
  return kind === "quota" && targets.length > 0 ? "continue" : "retry";
}

export function limitOfferTitle(kind: "rate" | "quota", source: AcpProvider): string {
  const name = providerDisplayName(source);
  return kind === "quota" ? `${name} usage limit reached` : `${name} is rate-limited`;
}

export function limitOfferHint(kind: "rate" | "quota", hasTarget: boolean): string {
  if (kind === "quota") {
    return hasTarget
      ? "This ceiling is per account — another model of the same companion will not help. Continue with a different companion, wait, or dismiss."
      : "This ceiling is per account. Connect another companion to continue elsewhere, or wait and try again.";
  }
  return hasTarget
    ? "This is usually short-lived. Waiting is the right first try; another companion uses a different account."
    : "This is usually short-lived. Wait a moment and try again.";
}

export function continueButtonLabel(target: LimitOfferTarget): string {
  return `Continue with ${target.name}`;
}

export const RETRY_BUTTON_LABEL = "Wait and try again";
export const DISMISS_BUTTON_LABEL = "Dismiss";

/** Transcript line for a switch. A silent model change is a quality bug. */
export function switchTranscriptLine(source: AcpProvider, target: AcpProvider): string {
  return `Switched from ${providerDisplayName(source)} to ${providerDisplayName(target)} after a usage limit.`;
}
