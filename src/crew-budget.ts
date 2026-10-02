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
 * the sessions that cannot be reaped. Zero is a real answer: a full pool
 * starts nothing and the run waits. It does not borrow a slot.
 */
export function parallelSlotCap(opts: {
  maxLive: number;
  /** Live sessions that will not be reaped (focused, working, needs-you). */
  unreapable: number;
}): number {
  const max = Number.isFinite(opts.maxLive) ? Math.max(0, Math.floor(opts.maxLive)) : 0;
  const busy = Number.isFinite(opts.unreapable) ? Math.max(0, Math.floor(opts.unreapable)) : 0;
  return Math.max(0, max - busy);
}

/**
 * Reservations that are not yet visible as live sessions.
 *
 * Two runs can read the same free-slot count before either one starts a
 * process. The ledger closes that gap inside one host: `tryAcquire` is
 * synchronous, and every path releases in `finally`. `free` is the count
 * {@link parallelSlotCap} would return right now, without this ledger.
 */
export class HostSlotLedger {
  private held = 0;

  constructor(private readonly free: () => number) {}

  tryAcquire(want: number): number {
    const asked = Number.isFinite(want) ? Math.max(0, Math.floor(want)) : 0;
    const room = Math.max(0, Math.floor(this.free()) - this.held);
    const take = Math.min(asked, room);
    this.held += take;
    return take;
  }

  release(count: number): void {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.held = Math.max(0, this.held - n);
  }

  get heldCount(): number {
    return this.held;
  }
}

/**
 * One budget for a root run, shared by its children and grandchildren.
 *
 * Each caller reserves with `tryStart` and releases with `finish`. A second
 * spawn in the same turn sees the first reservation. Carving a child's limits
 * does not mint a second copy of this budget.
 */
export interface RootBudgetLimits {
  maxActive: number;
  maxStarts: number;
  maxTokens?: number;
}

export class RootRunBudget {
  private active = 0;
  private starts = 0;
  private tokens = 0;

  constructor(private readonly limits: RootBudgetLimits) {}

  tryStart(): { ok: true } | { ok: false; reason: "active-children" | "starts" | "tokens" } {
    if (this.active >= Math.max(0, this.limits.maxActive)) return { ok: false, reason: "active-children" };
    if (this.starts >= Math.max(0, this.limits.maxStarts)) return { ok: false, reason: "starts" };
    if (typeof this.limits.maxTokens === "number" && this.tokens >= this.limits.maxTokens) {
      return { ok: false, reason: "tokens" };
    }
    this.active += 1;
    this.starts += 1;
    return { ok: true };
  }

  finish(tokens?: number): void {
    this.active = Math.max(0, this.active - 1);
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) this.tokens += tokens;
  }

  get activeCount(): number {
    return this.active;
  }

  get startCount(): number {
    return this.starts;
  }
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
