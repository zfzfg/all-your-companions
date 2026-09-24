/**
 * Fair clocks for child sessions (X-04).
 *
 * A subagent's time limit must not run while it waits for the person — the
 * wait is ours, not its. And a crew stage has no hard limit at all (D6: nothing
 * is stopped silently), only a warning when it has shown no activity for a
 * while and is not waiting for anyone.
 *
 * Pure: the caller passes `now`.
 */

export class PausableDeadline {
  private spentMs = 0;
  private runningSince: number | undefined;

  constructor(private readonly totalMs: number, now: number) {
    this.runningSince = now;
  }

  get paused(): boolean {
    return this.runningSince === undefined;
  }

  pause(now: number): void {
    if (this.runningSince === undefined) return;
    this.spentMs += Math.max(0, now - this.runningSince);
    this.runningSince = undefined;
  }

  resume(now: number): void {
    if (this.runningSince !== undefined) return;
    this.runningSince = now;
  }

  remainingMs(now: number): number {
    const running = this.runningSince === undefined ? 0 : Math.max(0, now - this.runningSince);
    return Math.max(0, this.totalMs - this.spentMs - running);
  }

  expired(now: number): boolean {
    return this.remainingMs(now) <= 0;
  }
}

export type StallState = "active" | "waiting" | "stalled";

/** A running stage is stalled when nothing happened for `warnAfterMs` and it
 *  is not waiting for the person. */
export function stageStallState(input: {
  lastActivityAt: number;
  now: number;
  warnAfterMs: number;
  needsYou: boolean;
}): StallState {
  if (input.needsYou) return "waiting";
  if (!(input.warnAfterMs > 0)) return "active";
  return input.now - input.lastActivityAt >= input.warnAfterMs ? "stalled" : "active";
}

export function stallWarningText(idleMs: number): string {
  const min = Math.max(1, Math.round(idleMs / 60000));
  return `No activity for ${min} min`;
}

/** The fixed, short steer a Nudge sends. */
export const NUDGE_TEXT = "Status? If you are stuck, say what blocks you and stop.";

/** `companions.crew.stallWarningSec`, clamped to its documented floor. */
export function normalizeStallWarningSec(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 300;
  return Math.max(60, n);
}
