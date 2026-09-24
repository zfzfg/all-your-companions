/**
 * When Grok compacts its context, and what the extension shows about it.
 *
 * xAI's model catalog pins `auto_compact_threshold_percent: 80` per model, so
 * Grok compacts at 400k of a 500k window. The env variable
 * `GROK_AUTO_COMPACT_THRESHOLD_PERCENT` outranks the catalog (probe against
 * grok 1.0.41, research/compact.md); a `GROK_CONFIG` overlay does not. The
 * extension therefore sets the variable on every Grok spawn, the same way it
 * sets `GROK_SHELL`.
 *
 * Pure: no vscode, no fs, no clock.
 */

export const GROK_COMPACT_ENV = "GROK_AUTO_COMPACT_THRESHOLD_PERCENT";

/** Setting default: compact at 95% (25k tokens of headroom in a 500k window). */
export const DEFAULT_COMPACT_THRESHOLD = 95;
/** Highest value the setting accepts; 100 leaves no room for the compaction call itself. */
export const MAX_COMPACT_THRESHOLD = 99;

/** Normalise the setting: an integer 1–99, or undefined for "keep Grok's own default". */
export function normalizeCompactThreshold(setting: unknown): number | undefined {
  const n = typeof setting === "string" && setting.trim() !== "" ? Number(setting) : setting;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 1 || n > MAX_COMPACT_THRESHOLD) return undefined;
  return n;
}

/**
 * The value to put in a Grok spawn's env, or undefined to leave it alone.
 * A variable the user set themselves (shell or workspace `.env`, already
 * merged into `env`) is never overwritten — presence check, like `GROK_SHELL`.
 */
export function grokCompactThresholdEnv(setting: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (GROK_COMPACT_ENV in env) return undefined;
  const n = normalizeCompactThreshold(setting);
  return n === undefined ? undefined : String(n);
}

/**
 * The threshold the user asked for and Grok actually reports disagree. Only
 * meaningful when the extension set the variable (desired defined) and Grok
 * reported a number.
 */
export function compactThresholdMismatch(desired: number | undefined, reported: number | undefined): boolean {
  if (desired === undefined || reported === undefined) return false;
  return Math.round(desired) !== Math.round(reported);
}

export function compactThresholdMismatchNotice(desired: number, reported: number): string {
  return `Grok reports auto-compaction at ${reported}%, not the ${desired}% you set. `
    + "A newer Grok CLI or an enterprise policy may be ignoring GROK_AUTO_COMPACT_THRESHOLD_PERCENT.";
}

/** "≈ 475k" — rounded token count for the popover and the settings hint. */
export function formatTokensShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

/** "Auto-compacts at 95% (≈ 475k tokens)". */
export function compactThresholdLine(thresholdPercent: number, window: number | undefined): string {
  const base = `Auto-compacts at ${thresholdPercent}%`;
  if (!window || !Number.isFinite(window) || window <= 0) return base;
  return `${base} (≈ ${formatTokensShort((window * thresholdPercent) / 100)} tokens)`;
}

export type ContextTone = "normal" | "warn" | "danger";

/** Ring colour: warn from threshold − 5 points, danger from the threshold. */
export function contextTone(used: number, window: number, thresholdPercent: number | undefined): ContextTone {
  if (!(window > 0) || !(used >= 0)) return "normal";
  const pct = (used / window) * 100;
  const t = thresholdPercent && thresholdPercent > 0 ? thresholdPercent : 90;
  if (pct >= t) return "danger";
  if (pct >= t - 5) return "warn";
  return "normal";
}

/**
 * Should the near-full prompt (K-04) appear now? Once per compaction cycle:
 * `armed` is true until it was shown and flips back to true after the next
 * compaction.
 */
export function shouldOfferNearFull(input: {
  used: number;
  window: number;
  thresholdPercent: number | undefined;
  armed: boolean;
  mode: "ask" | "off";
}): boolean {
  if (input.mode === "off" || !input.armed) return false;
  if (!(input.window > 0) || !input.thresholdPercent) return false;
  const pct = (input.used / input.window) * 100;
  return pct >= input.thresholdPercent - 3 && pct < 100;
}

/** Compaction lifecycle kinds from `_x.ai/session_notification`. */
export type CompactEventKind = "started" | "completed" | "failed" | "cancelled";

export function compactEventKind(update: unknown): CompactEventKind | null {
  const k = (update as { sessionUpdate?: unknown } | null | undefined)?.sessionUpdate;
  switch (k) {
    case "auto_compact_started": return "started";
    case "auto_compact_completed": return "completed";
    case "auto_compact_failed": return "failed";
    case "auto_compact_cancelled": return "cancelled";
    default: return null;
  }
}

/**
 * The short summary Grok keeps after a compaction (`summary_preview` on
 * `auto_compact_completed`, present in the 1.0.41 binary). Trimmed and capped;
 * null when absent.
 */
export function compactSummaryPreview(update: unknown, maxChars = 2000): string | null {
  const u = update as { sessionUpdate?: unknown; summary_preview?: unknown; summaryPreview?: unknown } | null | undefined;
  if (!u || u.sessionUpdate !== "auto_compact_completed") return null;
  const raw = typeof u.summary_preview === "string" ? u.summary_preview
    : typeof u.summaryPreview === "string" ? u.summaryPreview : "";
  const text = raw.trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
