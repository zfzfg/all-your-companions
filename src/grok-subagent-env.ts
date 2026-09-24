/**
 * Grok's built-in subagents, configured from the extension (S-07).
 *
 * The 1.0.41 binary names `GROK_SUBAGENTS`, `GROK_MAX_CONCURRENT_SUBAGENTS`,
 * `GROK_SUBAGENT_SAMPLING_LIMIT` and `GROK_SUBAGENT_LIMIT_BEHAVIOR`. Env
 * variables outrank the config file (as with the compaction threshold, K-01),
 * so the extension sets them on the Grok spawn — never over a value the user
 * set in their shell or workspace `.env`.
 *
 * Per-type models (`subagents.models.<name>`) exist only in `config.toml`, and
 * the `GROK_CONFIG` overlay does not pass `subagents` (research/subagents.md),
 * so they are deliberately not offered here.
 *
 * Pure.
 */

export const GROK_SUBAGENTS_ENV = "GROK_SUBAGENTS";
export const GROK_MAX_CONCURRENT_SUBAGENTS_ENV = "GROK_MAX_CONCURRENT_SUBAGENTS";

export interface GrokSubagentSettings {
  /** undefined = leave Grok's own default. */
  enabled?: boolean;
  /** 0 / undefined = leave Grok's own default. */
  maxConcurrent?: number;
}

/** The variables to add to a Grok spawn's env. User-set ones are never touched. */
export function grokSubagentEnv(settings: GrokSubagentSettings, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof settings.enabled === "boolean" && !(GROK_SUBAGENTS_ENV in env)) {
    out[GROK_SUBAGENTS_ENV] = settings.enabled ? "1" : "0";
  }
  const n = settings.maxConcurrent;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 16 && !(GROK_MAX_CONCURRENT_SUBAGENTS_ENV in env)) {
    out[GROK_MAX_CONCURRENT_SUBAGENTS_ENV] = String(n);
  }
  return out;
}

/** The settings-page hint when two delegation mechanisms can be active at once. */
export function bothDelegationsHint(grokSubagentsOn: boolean, companionSubagentsOn: boolean): string | undefined {
  return grokSubagentsOn && companionSubagentsOn
    ? "Grok may delegate to its own subagents and to other companions."
    : undefined;
}
