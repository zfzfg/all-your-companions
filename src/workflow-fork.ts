/**
 * One parallel group inside a single workflow iteration.
 *
 * A fork is not a global DAG and it is not a transition. `join: "all"` runs
 * once, after every required branch has succeeded. A failed, cancelled or
 * skipped required branch stops the group. An update from an older iteration
 * does not satisfy the current one.
 *
 * Pure.
 */

export type BranchState =
  | "pending"
  | "ready"
  | "running"
  | "waiting-for-user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ForkBranch {
  id: string;
  stageId: string;
  required: boolean;
  state: BranchState;
  attempt: number;
  visit: number;
}

export interface ForkGroup {
  runId: string;
  groupId: string;
  /** Iteration of this group. Old visits do not count. */
  iteration: number;
  join: "all";
  joined: boolean;
  branches: ForkBranch[];
}

export interface ForkJoinDecision {
  /** True when every required branch is terminal and join has not run. */
  ready: boolean;
  /** True only when every required branch succeeded. */
  ok: boolean;
  reason: string;
}

const TERMINAL = new Set<BranchState>(["succeeded", "failed", "cancelled", "skipped"]);

export function createForkGroup(input: {
  runId: string;
  groupId: string;
  iteration: number;
  branches: ReadonlyArray<{ id: string; stageId: string; required?: boolean }>;
}): ForkGroup {
  return {
    runId: input.runId,
    groupId: input.groupId,
    iteration: input.iteration,
    join: "all",
    joined: false,
    branches: input.branches.map((branch) => ({
      id: branch.id,
      stageId: branch.stageId,
      required: branch.required !== false,
      state: "pending",
      attempt: 1,
      visit: input.iteration,
    })),
  };
}

export function markBranch(
  group: ForkGroup,
  branchId: string,
  state: BranchState,
  visit: number,
): ForkGroup {
  if (visit !== group.iteration || group.joined) return group;
  return {
    ...group,
    branches: group.branches.map((branch) =>
      branch.id === branchId && branch.visit === group.iteration ? { ...branch, state } : branch,
    ),
  };
}

export function joinDecision(group: ForkGroup): ForkJoinDecision {
  if (group.joined) return { ready: false, ok: false, reason: "join already ran" };
  const required = group.branches.filter((branch) => branch.required);
  if (!required.length) return { ready: false, ok: false, reason: "the group has no required branch" };
  if (required.some((branch) => branch.visit !== group.iteration)) {
    return { ready: false, ok: false, reason: "a branch is from another iteration" };
  }
  if (required.some((branch) => !TERMINAL.has(branch.state))) {
    return { ready: false, ok: false, reason: "a required branch is still running" };
  }
  const failed = required.filter((branch) => branch.state !== "succeeded");
  if (failed.length) {
    return {
      ready: true,
      ok: false,
      reason: `required ${failed.map((branch) => `${branch.id}=${branch.state}`).join(", ")}`,
    };
  }
  return { ready: true, ok: true, reason: "every required branch succeeded" };
}

/** Record that join ran. A second call leaves the group joined and does not reset it. */
export function noteJoined(group: ForkGroup): ForkGroup {
  if (group.joined) return group;
  const decision = joinDecision(group);
  if (!decision.ready) return group;
  return { ...group, joined: true };
}
