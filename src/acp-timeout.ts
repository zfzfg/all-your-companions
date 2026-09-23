/**
 * ACP JSON-RPC request timeout policy (pure).
 *
 * `session/prompt` stays open for the whole turn. A wall-clock cap on that
 * request treats any long but healthy turn as a deadlock (#117). Idle time
 * since the last ACP traffic is the hang detector; an optional absolute cap
 * is only a safety net for a turn that heartbeats forever.
 */

export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 1_800_000;
export const DEFAULT_PROMPT_ABSOLUTE_TIMEOUT_MS = 86_400_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Floor for a positive timeout so a typo of `1` (ms) cannot fire instantly. */
export const MIN_ACP_TIMEOUT_MS = 1_000;

export type AcpTimeouts = {
  /** Silence before an in-flight `session/prompt` is treated as hung. `0` = no idle cap. */
  promptIdleTimeoutMs: number;
  /** Wall-clock cap for one `session/prompt`, even with traffic. `0` = no absolute cap. */
  promptAbsoluteTimeoutMs: number;
  /** Cap for every other ACP method (`initialize`, `session/new`, …). Always positive. */
  requestTimeoutMs: number;
};

export type AcpTimeoutInput = {
  promptIdleTimeoutMs?: unknown;
  promptAbsoluteTimeoutMs?: unknown;
  requestTimeoutMs?: unknown;
};

/**
 * Normalize one timeout setting. Non-finite / negative input falls back.
 * `allowZero` keeps an explicit `0` (disabled). Positive values are floored
 * and raised to {@link MIN_ACP_TIMEOUT_MS}.
 */
export function clampAcpTimeoutMs(
  raw: unknown,
  fallback: number,
  opts: { allowZero?: boolean } = {},
): number {
  if (opts.allowZero && (raw === 0 || raw === "0")) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return opts.allowZero ? 0 : fallback;
  return Math.max(MIN_ACP_TIMEOUT_MS, Math.floor(n));
}

export function resolveAcpTimeouts(raw: AcpTimeoutInput = {}): AcpTimeouts {
  return {
    promptIdleTimeoutMs: clampAcpTimeoutMs(
      raw.promptIdleTimeoutMs,
      DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
      { allowZero: true },
    ),
    promptAbsoluteTimeoutMs: clampAcpTimeoutMs(
      raw.promptAbsoluteTimeoutMs,
      DEFAULT_PROMPT_ABSOLUTE_TIMEOUT_MS,
      { allowZero: true },
    ),
    requestTimeoutMs: clampAcpTimeoutMs(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  };
}

/**
 * Milliseconds until the next `session/prompt` timeout should fire.
 * `Number.POSITIVE_INFINITY` means both caps are disabled — do not arm a timer.
 */
export function promptTimerDelayMs(args: {
  startedAt: number;
  lastActivityAt: number;
  now: number;
  idleMs: number;
  absoluteMs: number;
  /** Suspend only idle detection while the host holds a human request. */
  humanWaitActive?: boolean;
}): number {
  const idleRemaining =
    args.humanWaitActive || args.idleMs <= 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, args.idleMs - (args.now - args.lastActivityAt));
  const absRemaining =
    args.absoluteMs <= 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, args.absoluteMs - (args.now - args.startedAt));
  return Math.min(idleRemaining, absRemaining);
}
