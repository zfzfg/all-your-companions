/**
 * The WRITE half of a workflow preset (AP-18).
 *
 * Same two rules as `agent-role-write.ts`:
 * 1. Nothing invents a quoting scheme — prose is a block scalar or a body.
 * 2. Every write is proved by reading it back. A draft that does not re-parse
 *    to the same meaning is refused rather than written.
 *
 * Pure (recipe R7).
 */

import { CREW_PRESETS_DIR, parseCrewPreset, presetToStageGraph } from "./crew-preset";
import { STAGES_MARKER, stableStringify, workflowFromStagesJson, type WorkflowDefinition } from "./workflow";
import { validateWorkflowDefinition, type ValidateWorkflowContext, type ValidationResult } from "./workflow-validate";

export interface WorkflowDraft {
  name: string;
  title?: string;
  whenToUse?: string;
  whenNotToUse?: string;
  description?: string;
  body?: string;
  verify?: string;
  defaultGate?: "manual" | "auto";
  worktree?: boolean;
  roles?: string[];
  stagesJson: unknown;
}

export type WorkflowWriteResult =
  | { ok: true; text: string; workflow: WorkflowDefinition; validation: ValidationResult }
  | { ok: false; error: string; validation?: ValidationResult };

function emitScalar(key: string, value: string, lines: string[]): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) lines.push(`${key}: ${trimmed}`);
  else lines.push(`${key}: ${JSON.stringify(trimmed)}`);
}

function emitList(key: string, values: readonly string[], lines: string[]): void {
  if (!values.length) return;
  lines.push(`${key}: ${values.join(", ")}`);
}

export function serializeWorkflowPreset(draft: WorkflowDraft): string {
  const lines: string[] = [];
  const name = String(draft.name ?? "").trim().toLowerCase();
  emitScalar("name", name, lines);
  emitScalar("title", String(draft.title ?? ""), lines);
  emitScalar("when_to_use", String(draft.whenToUse ?? ""), lines);
  emitScalar("when_not_to_use", String(draft.whenNotToUse ?? ""), lines);
  emitList("roles", (draft.roles ?? []).map((r) => r.trim()).filter(Boolean), lines);
  emitScalar("verify", String(draft.verify ?? ""), lines);
  emitScalar("default_gate", draft.defaultGate ?? "", lines);
  if (draft.worktree) lines.push("worktree: true");
  const body = String(draft.body ?? draft.description ?? "").trim();
  const json = stableStringify(draft.stagesJson);
  const parts = [
    "---",
    ...lines,
    "---",
    body,
    "",
    STAGES_MARKER,
    "```json",
    json,
    "```",
    "",
  ];
  return parts.join("\n");
}

function meaningOf(def: WorkflowDefinition): string {
  return stableStringify({
    name: def.name,
    title: def.title,
    whenToUse: def.whenToUse,
    start: def.start,
    defaults: def.defaults,
    stages: def.stages.map((s) => ({
      id: s.id,
      role: s.role,
      enabled: s.enabled,
      profile: s.profile,
      maxVisits: s.maxVisits,
      onMaxVisits: s.onMaxVisits,
      next: s.next.map((t) => ({ to: t.to, when: t.when })),
      contract: s.contract,
    })),
    contracts: def.contracts,
  });
}

export function validateWorkflowDraft(
  draft: WorkflowDraft,
  context: ValidateWorkflowContext,
): WorkflowWriteResult {
  const name = String(draft.name ?? "").trim().toLowerCase();
  if (!name) return { ok: false, error: "Give the workflow a name." };
  const text = serializeWorkflowPreset({ ...draft, name });
  const parsed = parseCrewPreset({
    path: `${CREW_PRESETS_DIR}/${name}.md`,
    stem: name,
    text,
  });
  if (parsed.problem || !parsed.preset) {
    return { ok: false, error: parsed.problem?.message ?? "That workflow could not be written." };
  }
  if (parsed.preset.stages === undefined) {
    return { ok: false, error: "The stages block did not survive serialisation." };
  }
  const fromFile = workflowFromStagesJson(parsed.preset.stages, {
    source: "project",
    name,
    path: parsed.preset.path,
  });
  if (!fromFile.ok) return { ok: false, error: fromFile.error };
  const intended = workflowFromStagesJson(draft.stagesJson, { source: "project", name });
  if (!intended.ok) return { ok: false, error: intended.error };
  if (meaningOf(fromFile.workflow) !== meaningOf(intended.workflow)) {
    return { ok: false, error: "This workflow could not be written without changing its meaning. Please report this." };
  }
  const validation = validateWorkflowDefinition(fromFile.workflow, context);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.errors[0]?.message ?? "This workflow is not valid.",
      validation,
    };
  }
  return { ok: true, text, workflow: fromFile.workflow, validation };
}

export function draftFromUnknown(raw: unknown): WorkflowDraft | undefined {
  const parsed = workflowFromStagesJson(raw, { source: "project" });
  if (!parsed.ok) return undefined;
  return workflowToDraft(parsed.workflow);
}

export function workflowToDraft(def: WorkflowDefinition): WorkflowDraft {
  return {
    name: def.name,
    title: def.title,
    whenToUse: def.whenToUse,
    whenNotToUse: def.whenNotToUse,
    description: def.description,
    body: def.description ?? "",
    verify: def.defaults.verify,
    defaultGate: def.defaults.gate,
    worktree: def.defaults.worktree,
    roles: Object.keys(def.roles),
    stagesJson: {
      schemaVersion: 1,
      name: def.name,
      title: def.title,
      description: def.description,
      whenToUse: def.whenToUse,
      whenNotToUse: def.whenNotToUse,
      defaults: def.defaults,
      roles: def.roles,
      stages: def.stages.map((stage) => ({
        ...stage,
        contract: { $ref: `#/contracts/${stage.contract}` },
      })),
      contracts: def.contracts,
      start: def.start,
      ...(def.compiler ? { compiler: def.compiler } : {}),
    },
  };
}

export { presetToStageGraph };
