/**
 * Budget enforcement for a crew role (AP-13).
 *
 * AP-10 parsed `budget` and named it in the briefing. This module is the
 * check that makes it a limit: over cap → a card, never a silent abort.
 * The host asks "continue / stop / raise the cap"; this file only answers
 * whether the cap is hit.
 *
 * Pure. `usd` on the role is dollars; usage is ticks (10^10 = $1), same
 * unit as `formatRunCost`.
 */

import type { AgentRoleBudget } from "./agent-roles";

export const USD_TICKS_PER_DOLLAR = 10_000_000_000;

export interface BudgetState {
  toolCalls: number;
  tokens: number;
  usdTicks: number;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; limit: keyof AgentRoleBudget; used: number; cap: number };

export function checkBudget(
  used: BudgetState,
  budget: AgentRoleBudget | undefined,
): BudgetVerdict {
  if (!budget) return { ok: true };
  if (typeof budget.toolCalls === "number" && used.toolCalls > budget.toolCalls) {
    return { ok: false, limit: "toolCalls", used: used.toolCalls, cap: budget.toolCalls };
  }
  if (typeof budget.tokens === "number" && used.tokens > budget.tokens) {
    return { ok: false, limit: "tokens", used: used.tokens, cap: budget.tokens };
  }
  if (typeof budget.usd === "number") {
    const capTicks = budget.usd * USD_TICKS_PER_DOLLAR;
    if (used.usdTicks > capTicks) {
      return { ok: false, limit: "usd", used: used.usdTicks / USD_TICKS_PER_DOLLAR, cap: budget.usd };
    }
  }
  return { ok: true };
}

/**
 * How many parallel role sessions a crew may start, given the pool.
 *
 * `working` / `needs-you` are never harvested, so the cap is `maxLive` minus
 * the sessions that cannot be reaped. A crew that would exceed this waits
 * rather than overbooking — and never reaps its own running roles.
 */
export function parallelSlotCap(opts: {
  maxLive: number;
  /** Live sessions that will not be reaped (focused, working, needs-you). */
  unreapable: number;
}): number {
  const max = Number.isFinite(opts.maxLive) ? Math.max(0, Math.floor(opts.maxLive)) : 0;
  const busy = Number.isFinite(opts.unreapable) ? Math.max(0, Math.floor(opts.unreapable)) : 0;
  return Math.max(1, max - busy);
}

/**
 * Next provider on a quota failover. `exhausted` is never retried — a second
 * attempt against the same ceiling is only a second bill (#151).
 */
export function nextFailoverProvider<T extends string>(
  exhausted: readonly T[],
  usable: readonly T[],
): T | undefined {
  const gone = new Set(exhausted);
  return usable.find((p) => !gone.has(p));
}

/**
 * Sessions the pool will not reap: the focused one, plus anything
 * `working` / `needs-you`. Used as the `unreapable` half of {@link parallelSlotCap}.
 */
export function countUnreapable(
  sessions: Iterable<{ status: string }>,
  focused?: { status: string },
): number {
  let n = 0;
  const seen = new Set<object>();
  const count = (s: { status: string }) => {
    if (seen.has(s as object)) return;
    seen.add(s as object);
    n += 1;
  };
  if (focused) count(focused);
  for (const s of sessions) {
    if (s === focused || s.status === "working" || s.status === "needs-you") count(s);
  }
  return n;
}

/**
 * Same tool failed `n` times in a row. The host treats this like a budget
 * card (continue / stop), never a silent retry loop.
 */
export function repeatedFailingTool(
  calls: readonly { tool: string; ok: boolean }[],
  n = 3,
): boolean {
  const need = Number.isFinite(n) ? Math.max(2, Math.floor(n)) : 3;
  if (calls.length < need) return false;
  const tail = calls.slice(-need);
  const name = tail[0]?.tool;
  if (!name) return false;
  return tail.every((c) => c.tool === name && c.ok === false);
}
