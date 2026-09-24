/**
 * Who runs the next crew stage, before anyone asks (C-03, C-04, F-05).
 *
 * The gate always offers provider, model and effort (D6). This module decides
 * what is PRESELECTED there, and what the Crew start panel proposes as the
 * run's lineup, so a person in a hurry presses Start and a person who wants
 * control sees who will do what before the first token.
 *
 * Pure: no vscode, no fs, no clock.
 */

import type { AcpProvider } from "./acp-backend";
import type { HandoffPacket } from "./workflow-handoff";
import type { WorkflowDefinition, WorkflowStage } from "./workflow";
import { isWriteProfile } from "./workflow";

export interface TargetChoice {
  provider: AcpProvider;
  model?: string;
  effort?: string;
}

export type PreselectSource = "hint" | "stage" | "lineup" | "role" | "different" | "last" | "first";

export interface GatePreselection {
  target?: TargetChoice;
  source: PreselectSource;
  /** The stage whose provider a review should differ from, and whether it does. */
  compare?: { stageId: string; stageTitle: string; provider: AcpProvider; same: boolean };
}

export interface RoleTemplateInfo {
  provider?: AcpProvider;
  model?: string;
  effort?: string;
  /** A built-in role's provider is a placeholder, never a choice. */
  builtin: boolean;
  preferDifferentProvider?: boolean;
}

/**
 * The stage a review compares against: `target.preferDifferentProviderThan`
 * when the workflow names one, else — for a role that prefers a fresh pair of
 * eyes — the last write stage that ran.
 */
export function comparisonStageId(
  stage: WorkflowStage,
  def: WorkflowDefinition,
  packets: ReadonlyMap<string, HandoffPacket>,
  role?: RoleTemplateInfo,
): string | undefined {
  const named = stage.target?.preferDifferentProviderThan;
  if (named) return named;
  if (!role?.preferDifferentProvider) return undefined;
  let last: HandoffPacket | undefined;
  for (const packet of packets.values()) {
    const s = def.stages.find((x) => x.id === packet.stageId);
    if (s && isWriteProfile(s.profile) && (!last || packet.stageOrdinal > last.stageOrdinal)) last = packet;
  }
  return last?.stageId;
}

/**
 * Order (C-03): an explicit hint (the gate's own choice) → the stage's
 * `target` → the run's lineup → a user-written role's pinned target → a
 * provider different from the compared stage → the provider that ran last →
 * the first eligible one. Only eligible providers are ever preselected.
 */
export function preselectGateTarget(input: {
  stage: WorkflowStage;
  def: WorkflowDefinition;
  eligible: readonly AcpProvider[];
  packets: ReadonlyMap<string, HandoffPacket>;
  hint?: TargetChoice;
  lineup?: TargetChoice;
  role?: RoleTemplateInfo;
  lastProvider?: AcpProvider;
}): GatePreselection {
  const ok = (p: AcpProvider | undefined): p is AcpProvider => !!p && input.eligible.includes(p);
  const compareId = comparisonStageId(input.stage, input.def, input.packets, input.role);
  const compared = compareId ? input.packets.get(compareId) : undefined;
  const compareStage = compareId ? input.def.stages.find((s) => s.id === compareId) : undefined;
  const withCompare = (target: TargetChoice | undefined, source: PreselectSource): GatePreselection => ({
    ...(target ? { target } : {}),
    source,
    ...(compared && target
      ? {
          compare: {
            stageId: compared.stageId,
            stageTitle: compareStage?.title ?? compared.stageId,
            provider: compared.target.provider,
            same: compared.target.provider === target.provider,
          },
        }
      : {}),
  });
  const effortOf = (...values: Array<string | undefined>) => values.find((v) => !!v);

  if (input.hint && ok(input.hint.provider)) return withCompare({ ...input.hint }, "hint");
  const st = input.stage.target;
  if (st?.provider && ok(st.provider)) {
    return withCompare({
      provider: st.provider,
      ...(st.model ? { model: st.model } : {}),
      ...(effortOf(st.effort) ? { effort: st.effort } : {}),
    }, "stage");
  }
  if (input.lineup && ok(input.lineup.provider)) return withCompare({ ...input.lineup }, "lineup");
  const role = input.role;
  if (role && !role.builtin && ok(role.provider)) {
    return withCompare({
      provider: role.provider,
      ...(role.model ? { model: role.model } : {}),
      ...(effortOf(st?.effort, role.effort) ? { effort: effortOf(st?.effort, role.effort) } : {}),
    }, "role");
  }
  const effort = effortOf(st?.effort, role?.effort);
  if (compared) {
    const other = input.eligible.find((p) => p !== compared.target.provider);
    if (other) return withCompare({ provider: other, ...(effort ? { effort } : {}) }, "different");
  }
  if (ok(input.lastProvider)) return withCompare({ provider: input.lastProvider, ...(effort ? { effort } : {}) }, "last");
  const first = input.eligible[0];
  return withCompare(first ? { provider: first, ...(effort ? { effort } : {}) } : undefined, "first");
}

/** "different from Implement ✔" / "same companion as Implement — not an outside opinion". */
export function compareLabel(compare: { stageTitle: string; same: boolean } | undefined): string {
  if (!compare) return "";
  return compare.same
    ? `same companion as ${compare.stageTitle} — not an outside opinion`
    : `different from ${compare.stageTitle} ✔`;
}

// ---------------------------------------------------------------------------
// C-04: the run's lineup, proposed before the first token
// ---------------------------------------------------------------------------

export interface LineupEntry extends TargetChoice {
  stageId: string;
  title: string;
  enabled: boolean;
  optional: boolean;
  gate: "manual" | "auto";
}

/**
 * The proposed lineup: the last one used for this workflow in this project
 * when there is one, else the heuristic — planner on the strongest effort,
 * implementer on the default model, review on a companion other than the
 * implementer's, fixer like the implementer.
 */
export function proposeLineup(input: {
  def: WorkflowDefinition;
  eligible: readonly AcpProvider[];
  remembered?: Record<string, Partial<LineupEntry>>;
  roles?: Record<string, RoleTemplateInfo | undefined>;
}): LineupEntry[] {
  const out: LineupEntry[] = [];
  const first = input.eligible[0];
  const byId = new Map<string, LineupEntry>();
  for (const stage of input.def.stages) {
    // Off by default (Clarify first) = optional: the person may switch it on.
    const optional = !stage.enabled;
    const remembered = input.remembered?.[stage.id];
    const role = input.roles?.[stage.role];
    let provider: AcpProvider | undefined;
    let model: string | undefined;
    let effort: string | undefined = stage.target?.effort;
    if (remembered?.provider && input.eligible.includes(remembered.provider)) {
      provider = remembered.provider;
      model = remembered.model;
      effort = remembered.effort ?? effort;
    } else if (stage.target?.provider && input.eligible.includes(stage.target.provider)) {
      provider = stage.target.provider;
      model = stage.target.model;
    } else if (role && !role.builtin && role.provider && input.eligible.includes(role.provider)) {
      provider = role.provider;
      model = role.model;
      effort = effort ?? role.effort;
    } else {
      const against = stage.target?.preferDifferentProviderThan ? byId.get(stage.target.preferDifferentProviderThan) : undefined;
      provider = against ? input.eligible.find((p) => p !== against.provider) ?? against.provider : first;
      if (stage.id === "fix" || stage.role === "fixer") {
        const impl = byId.get("implement");
        if (impl) {
          provider = impl.provider;
          model = impl.model;
        }
      }
      if (stage.role === "planner" && !effort) effort = "high";
    }
    if (!provider) continue;
    const entry: LineupEntry = {
      stageId: stage.id,
      title: stage.title,
      provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      enabled: remembered?.enabled ?? stage.enabled,
      optional,
      gate: remembered?.gate ?? stage.gate ?? input.def.defaults.gate,
    };
    byId.set(stage.id, entry);
    out.push(entry);
  }
  return out;
}

/** One line: "Plan: Claude opus/high → Implement: Codex gpt-5/medium → …". */
export function lineupSummary(entries: readonly LineupEntry[], name: (p: AcpProvider) => string): string {
  return entries
    .filter((e) => e.enabled)
    .map((e) => {
      const detail = [e.model, e.effort].filter(Boolean).join("/");
      return `${e.title}: ${name(e.provider)}${detail ? ` ${detail}` : ""}`;
    })
    .join(" → ");
}

// ---------------------------------------------------------------------------
// C-04: verify command suggestions
// ---------------------------------------------------------------------------

/**
 * Commands worth proposing as the run's verify step, from what the project
 * contains. Only PROPOSED — nothing runs until the person picks one.
 */
export function suggestVerifyCommands(project: {
  packageJson?: { scripts?: Record<string, unknown> } | undefined;
  hasCargo?: boolean;
  hasPyproject?: boolean;
  hasGoMod?: boolean;
  packageManager?: "npm" | "pnpm" | "yarn";
}): string[] {
  const out: string[] = [];
  const pm = project.packageManager ?? "npm";
  const scripts = project.packageJson?.scripts ?? {};
  for (const name of ["test", "check", "lint", "typecheck"]) {
    if (typeof scripts[name] === "string" && String(scripts[name]).trim()) {
      out.push(name === "test" ? `${pm} test` : `${pm} run ${name}`);
    }
  }
  if (project.hasCargo) out.push("cargo test");
  if (project.hasPyproject) out.push("pytest");
  if (project.hasGoMod) out.push("go test ./...");
  return out;
}
