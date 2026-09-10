/**
 * Deterministic workflow validation (AP-18 §8.7).
 *
 * The generator may only propose. This module, plus the user's Save, is the
 * authority. Twelve rules, JSON pointers, no fs, no clock, no vscode.
 *
 * JSON Schema conformance here is the small structural check (schemaVersion,
 * name pattern, stages present). The rest of the rules are graph and contract
 * properties a schema cannot express.
 */

import { isEffortLevel } from "./target-eligibility";
import { parseRolePermissionLine } from "./agent-roles";
import {
  findStage,
  firstEnabledStart,
  isReservedTarget,
  isWriteProfile,
  workflowFromStagesJson,
  workflowNameOk,
  type WorkflowDefinition,
  type WorkflowStage,
} from "./workflow";

export interface ValidationIssue {
  pointer: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateWorkflowContext {
  roleNames: readonly string[];
  existingNames?: readonly string[];
  originalName?: string;
  knownModels?: Partial<Record<string, { checked: boolean; ids: readonly string[] }>>;
  maxStages?: number;
  generated?: boolean;
  allowWrite?: boolean;
}

const DEFAULT_MAX_STAGES = 8;
const MAX_CONTRACT_CHARS = 8000;

export function validateWorkflowRaw(
  raw: unknown,
  context: ValidateWorkflowContext,
): ValidationResult {
  const parsed = workflowFromStagesJson(raw, { source: "project", name: typeof (raw as { name?: string })?.name === "string" ? (raw as { name: string }).name : "draft" });
  if (!parsed.ok) {
    return { valid: false, errors: [{ pointer: "", message: parsed.error }], warnings: [] };
  }
  return validateWorkflowDefinition(parsed.workflow, context);
}

export function validateWorkflowDefinition(
  def: WorkflowDefinition,
  context: ValidateWorkflowContext,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (pointer: string, message: string) => errors.push({ pointer, message });
  const warn = (pointer: string, message: string) => warnings.push({ pointer, message });

  // 1. schemaVersion known
  if (def.schemaVersion !== 1) {
    err("/schemaVersion", `Unknown schemaVersion ${String(def.schemaVersion)}. Only 1 is supported.`);
  }

  // 2. name
  if (!workflowNameOk(def.name)) {
    err("/name", "name must match [a-z0-9-]+.");
  }
  const taken = (context.existingNames ?? []).map((n) => n.toLowerCase());
  const original = (context.originalName ?? "").toLowerCase();
  if (def.name !== original && taken.includes(def.name)) {
    err("/name", `A workflow called \`${def.name}\` already exists in this scope.`);
  }

  // 3. role refs
  for (const [key, ref] of Object.entries(def.roles)) {
    if ("ref" in ref) {
      if (!context.roleNames.includes(ref.ref)) {
        err(`/roles/${key}`, `Role \`${ref.ref}\` is not defined.`);
      }
    } else if (!ref.inline.whenToUse.trim()) {
      err(`/roles/${key}/inline/whenToUse`, "An inline role needs a non-empty whenToUse.");
    }
  }
  for (const [i, stage] of def.stages.entries()) {
    if (!def.roles[stage.role] && !context.roleNames.includes(stage.role)) {
      err(`/stages/${i}/role`, `Stage \`${stage.id}\` names role \`${stage.role}\` that is not in the workflow or the role set.`);
    }
  }

  // 4. contracts
  for (const [i, stage] of def.stages.entries()) {
    const contract = def.contracts[stage.contract];
    if (!contract) {
      err(`/stages/${i}/contract`, `Stage \`${stage.id}\` has no contract.`);
      continue;
    }
    if (!contract.purpose.trim()) err(`/contracts/${stage.contract}/purpose`, "A contract needs a purpose.");
    if (!contract.inputs.length) err(`/contracts/${stage.contract}/inputs`, "A contract needs at least one input.");
    if (!contract.output.sections.length) {
      err(`/contracts/${stage.contract}/output/sections`, "A contract needs an output section list.");
    }
    const usedVerdicts = new Set<string>();
    for (const transition of stage.next) {
      for (const value of transition.when?.verdict ?? []) usedVerdicts.add(value);
    }
    if (usedVerdicts.size) {
      const declared = contract.output.resultBlock.verdict?.values ?? [];
      if (!declared.length) {
        err(
          `/contracts/${stage.contract}/output/resultBlock/verdict`,
          `Stage \`${stage.id}\` transitions on verdict but the contract does not declare one.`,
        );
      } else {
        for (const value of usedVerdicts) {
          if (!declared.includes(value)) {
            err(
              `/contracts/${stage.contract}/output/resultBlock/verdict/values`,
              `Verdict \`${value}\` is used in a transition but not declared.`,
            );
          }
        }
      }
    }
  }

  // 5. graph: to, start, reachable, $done reachable
  const start = firstEnabledStart(def);
  if (!start) err("/start", "No enabled start stage.");
  else if (!findStage(def, start)) err("/start", `Start stage \`${start}\` does not exist.`);
  for (const [i, stage] of def.stages.entries()) {
    for (const [j, transition] of stage.next.entries()) {
      if (!isReservedTarget(transition.to) && !findStage(def, transition.to)) {
        err(`/stages/${i}/next/${j}/to`, `Transition to unknown stage \`${transition.to}\`.`);
      }
    }
  }
  const enabled = def.stages.filter((s) => s.enabled);
  const reachable = start ? reachableFrom(def, start) : new Set<string>();
  for (const stage of enabled) {
    if (!reachable.has(stage.id)) err(`/stages/${stageIndex(def, stage)}/id`, `Stage \`${stage.id}\` is not reachable from start.`);
  }
  if (start && !canReachDone(def, start)) {
    err("/start", "$done is not reachable from the start.");
  }

  // 6. cycles bounded
  for (const cycle of findCycles(def)) {
    const bounded = cycle.some((id) => {
      const stage = findStage(def, id);
      return !!stage && (stage.maxVisits ?? 0) >= 1 && !!stage.onMaxVisits;
    });
    if (!bounded) {
      err(`/stages`, `Cycle ${cycle.join(" → ")} has no stage with maxVisits ≥ 1 and onMaxVisits.`);
    }
  }

  // 7. input paths available on every path to the stage
  for (const [i, stage] of def.stages.entries()) {
    if (!stage.enabled) continue;
    const contract = def.contracts[stage.contract];
    if (!contract) continue;
    const ancestors = ancestorsOf(def, stage.id);
    for (const [j, input] of contract.inputs.entries()) {
      if (!inputPathOk(input.from, ancestors, stage.id)) {
        err(
          `/contracts/${stage.contract}/inputs/${j}/from`,
          `Input \`${input.from}\` is not available on every path to \`${stage.id}\`.`,
        );
      }
    }
  }

  // 8. write profiles
  for (const [i, stage] of def.stages.entries()) {
    if (!isWriteProfile(stage.profile)) continue;
    const hasScope = !!(stage.scope?.length || stage.scopeFrom);
    if (!hasScope) {
      err(`/stages/${i}/profile`, `Write profile \`${stage.profile}\` needs a scope source or explicit globs.`);
    }
    if (stage.profile === "inherit" && context.generated && !context.allowWrite) {
      err(`/stages/${i}/profile`, "Generated workflows may not use inherit unless write stages were allowed.");
    }
  }

  // 9. models and efforts
  for (const [i, stage] of def.stages.entries()) {
    const effort = stage.target?.effort;
    if (effort && !isEffortLevel(effort)) {
      err(`/stages/${i}/target/effort`, `\`${effort}\` is not an EffortLevel.`);
    }
    const provider = stage.target?.provider;
    const model = stage.target?.model;
    if (provider && model) {
      const cache = context.knownModels?.[provider];
      if (!cache || !cache.checked) {
        warn(`/stages/${i}/target/model`, "Model list not loaded yet — not verified.");
      } else if (!cache.ids.includes(model)) {
        err(`/stages/${i}/target/model`, `Unknown model \`${model}\` for ${provider}.`);
      }
    }
  }

  // 10. permission lines on inline roles
  for (const [key, ref] of Object.entries(def.roles)) {
    if (!("inline" in ref) || !ref.inline.permissions) continue;
    for (const [j, line] of ref.inline.permissions.entries()) {
      if (!parseRolePermissionLine(line)) {
        err(`/roles/${key}/inline/permissions/${j}`, `\`${line}\` is not a permission rule.`);
      }
    }
  }

  // 11. size limits
  const maxStages = context.maxStages ?? DEFAULT_MAX_STAGES;
  if (def.stages.length > maxStages) {
    err("/stages", `At most ${maxStages} stages.`);
  }
  for (const [name, contract] of Object.entries(def.contracts)) {
    const len = (contract.purpose + (contract.instructions ?? "") + (contract.acceptance ?? "")).length;
    if (len > MAX_CONTRACT_CHARS) {
      err(`/contracts/${name}`, `Contract text is ${len} characters; keep it under ${MAX_CONTRACT_CHARS}.`);
    }
  }

  // 12. warnings
  for (const stage of def.stages) {
    const prefer = stage.target?.preferDifferentProviderThan;
    if (prefer) {
      const other = findStage(def, prefer);
      if (other?.target?.provider && stage.target?.provider && other.target.provider === stage.target.provider) {
        warn(`/stages/${stageIndex(def, stage)}/target`, "Review stage is on the same provider as the stage it reviews.");
      }
    }
  }
  const hasWrite = def.stages.some((s) => isWriteProfile(s.profile));
  if (hasWrite && !def.defaults.verify && !def.stages.some((s) => s.profile && def.defaults.verify)) {
    if (!def.defaults.verify) warn("/defaults/verify", "Write stages exist but no verify command is set.");
  }
  for (const [i, stage] of def.stages.entries()) {
    const contract = def.contracts[stage.contract];
    const conditional = stage.next.some((t) => t.when);
    if (conditional && !contract?.output.resultBlock.required.length) {
      warn(`/stages/${i}/next`, "Conditional transitions but no required result fields.");
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function stageIndex(def: WorkflowDefinition, stage: WorkflowStage): number {
  return def.stages.findIndex((s) => s.id === stage.id);
}

function outgoing(def: WorkflowDefinition, id: string): string[] {
  const stage = findStage(def, id);
  if (!stage) return [];
  return stage.next.map((t) => t.to);
}

function reachableFrom(def: WorkflowDefinition, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || isReservedTarget(id)) continue;
    seen.add(id);
    for (const to of outgoing(def, id)) stack.push(to);
  }
  return seen;
}

function canReachDone(def: WorkflowDefinition, start: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === "$done") return true;
    if (seen.has(id) || isReservedTarget(id)) continue;
    seen.add(id);
    for (const to of outgoing(def, id)) stack.push(to);
  }
  return false;
}

function findCycles(def: WorkflowDefinition): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (isReservedTarget(id)) return;
    if (visiting.has(id)) {
      const at = stack.indexOf(id);
      if (at >= 0) cycles.push(stack.slice(at));
      return;
    }
    if (stack.includes(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const to of outgoing(def, id)) visit(to);
    stack.pop();
    visiting.delete(id);
  };
  const start = firstEnabledStart(def);
  if (start) visit(start);
  return cycles;
}

function ancestorsOf(def: WorkflowDefinition, target: string): Set<string> {
  // Stages that can appear before `target` on some path from start.
  const start = firstEnabledStart(def);
  const before = new Set<string>();
  if (!start) return before;
  const dfs = (id: string, path: string[]) => {
    if (isReservedTarget(id)) return;
    if (id === target) {
      for (const step of path) before.add(step);
      return;
    }
    if (path.includes(id)) return;
    for (const to of outgoing(def, id)) dfs(to, [...path, id]);
  };
  dfs(start, []);
  return before;
}

function inputPathOk(from: string, ancestors: Set<string>, stageId: string): boolean {
  if (from === "idea" || from === "userNotes" || from === "files.attached" || from === "repo.root") return true;
  const dot = from.indexOf(".");
  if (dot <= 0) return false;
  const src = from.slice(0, dot);
  if (src === stageId) return false;
  return ancestors.has(src);
}
