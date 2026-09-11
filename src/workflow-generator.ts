/**
 * Workflow generator (AP-18 §8.5–8.6).
 *
 * The generator may only propose. This module parses the proposal (MCP submit
 * or the `companions-workflow` fenced-block fallback), runs the deterministic
 * validator, and tracks repair rounds. Nothing is written until the user
 * presses Save.
 *
 * Pure (recipe R7): no vscode, no fs, no clock. The host supplies `now` when
 * stamping `compiler.generatedAt`.
 */

import { COMPANIONS_LIST_TOOL, COMPANIONS_TOOLS } from "./companions-protocol";
import { validateWorkflowRaw, type ValidateWorkflowContext, type ValidationResult } from "./workflow-validate";
import { validateWorkflowDraft, workflowToDraft, type WorkflowWriteResult } from "./workflow-write";
import { workflowFromStagesJson, type WorkflowDefinition } from "./workflow";

export const WORKFLOW_GENERATOR_HIDDEN = "workflow-generator" as const;

export const COMPANIONS_WORKFLOW_SCHEMA_TOOL = "companions_workflow_schema";
export const COMPANIONS_LIST_ROLES_TOOL = "companions_list_roles";
export const COMPANIONS_LIST_WORKFLOWS_TOOL = "companions_list_workflows";
export const COMPANIONS_VALIDATE_WORKFLOW_TOOL = "companions_validate_workflow";
export const COMPANIONS_SUBMIT_WORKFLOW_TOOL = "companions_submit_workflow";

export const GENERATOR_TOOL_NAMES = [
  COMPANIONS_WORKFLOW_SCHEMA_TOOL,
  COMPANIONS_LIST_ROLES_TOOL,
  COMPANIONS_LIST_TOOL,
  COMPANIONS_LIST_WORKFLOWS_TOOL,
  COMPANIONS_VALIDATE_WORKFLOW_TOOL,
  COMPANIONS_SUBMIT_WORKFLOW_TOOL,
] as const;

export type GeneratorToolName = (typeof GENERATOR_TOOL_NAMES)[number];

export function isGeneratorTool(name: string): name is GeneratorToolName {
  return (GENERATOR_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Tools that exist only on the generator surface. List is shared with
 * delegation sessions (`companions_list_subagent_targets`); treating it as
 * generator-only made every normal-session list fail.
 */
export function isGeneratorOnlyTool(name: string): boolean {
  return isGeneratorTool(name) && name !== COMPANIONS_LIST_TOOL;
}

/** Compact authoring guide — NOT the full JSON Schema. The validator is the authority. */
export const WORKFLOW_AUTHORING_GUIDE = [
  "A workflow is JSON: schemaVersion 1, name [a-z0-9-]+, title, whenToUse, defaults, roles, stages, contracts, start.",
  "Reserved transition targets: $done, $pause, $cancel. Conditions are conjunctions of verdict / verify / findingsAtLeast / status / unreported — never expressions.",
  "Every loop needs maxVisits ≥ 1 and onMaxVisits. Every stage has a contract with purpose, inputs (from paths), output.sections, and a companions-result block listing required fields.",
  "Write profiles need a scope. Prefer read-only. Review stages should prefer a different provider than the stage they review.",
  "Do not invent model ids. Omit the model, or use one from list_subagent_targets expand.",
].join(" ");

const listTargetsTool = COMPANIONS_TOOLS.find((tool) => tool.name === COMPANIONS_LIST_TOOL)!;

/**
 * Handshake tool list for generator sessions. The CJS script advertises
 * whatever the ready frame sends, so this is the only place the generator
 * set is defined. Delegation sessions still get the three spawn/list/await
 * tools and never these.
 */
export const GENERATOR_TOOLS = [
  {
    name: COMPANIONS_WORKFLOW_SCHEMA_TOOL,
    description:
      "Compact authoring rules for a companions workflow: reserved targets, condition fields, contract rules, size limits. Not the full JSON Schema — call validate and iterate on its errors.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: COMPANIONS_LIST_ROLES_TOOL,
    description: "List existing roles (built-in, this machine, this project) with whenToUse, companion, model and profile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  listTargetsTool,
  {
    name: COMPANIONS_LIST_WORKFLOWS_TOOL,
    description: "List existing workflows (names, titles, whenToUse) so a new one does not duplicate them and can copy a good pattern.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: COMPANIONS_VALIDATE_WORKFLOW_TOOL,
    description: "Validate a workflow JSON draft. Returns { valid, errors: [{ pointer, message }], warnings }. Fix every error before submit.",
    inputSchema: {
      type: "object",
      properties: { workflow: { type: "object", description: "The stages JSON to validate." } },
      required: ["workflow"],
      additionalProperties: false,
    },
  },
  {
    name: COMPANIONS_SUBMIT_WORKFLOW_TOOL,
    description: "Submit the final workflow JSON. It must validate. The host shows a preview; nothing is written until the user saves.",
    inputSchema: {
      type: "object",
      properties: { workflow: { type: "object", description: "The stages JSON to submit." } },
      required: ["workflow"],
      additionalProperties: false,
    },
  },
] as const;

/** Server `instructions` for generator sessions. The meta-prompt is the user turn. */
export const GENERATOR_PRIMER = [
  `You design workflows via ${COMPANIONS_WORKFLOW_SCHEMA_TOOL}, ${COMPANIONS_LIST_ROLES_TOOL}, ${COMPANIONS_LIST_WORKFLOWS_TOOL}, ${COMPANIONS_LIST_TOOL} (compact; expand one provider for model ids), ${COMPANIONS_VALIDATE_WORKFLOW_TOOL}, and ${COMPANIONS_SUBMIT_WORKFLOW_TOOL}.`,
  "Do not invent model ids. Do not write files. The host writes after the user saves.",
  "Finish with companions_submit_workflow. If you cannot call tools, end with one fenced companions-workflow JSON block and nothing after it.",
].join("\n");

const WORKFLOW_BLOCK_RE = /```companions-workflow\s*\r?\n([\s\S]*?)```/i;

export function extractCompanionsWorkflow(markdown: string): unknown | undefined {
  const match = WORKFLOW_BLOCK_RE.exec(String(markdown ?? ""));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export interface GeneratorOptions {
  reuseRoles: boolean;
  newRoles: "inline" | "files";
  allowWrite: boolean;
  maxStages: number;
  maxRepairRounds: number;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  reuseRoles: true,
  newRoles: "inline",
  allowWrite: true,
  maxStages: 8,
  maxRepairRounds: 3,
};

export interface GeneratorState {
  description: string;
  options: GeneratorOptions;
  rounds: number;
  lastDraft?: unknown;
  lastValidation?: ValidationResult;
  submitted?: WorkflowDefinition;
}

export function makeGeneratorState(description: string, options: Partial<GeneratorOptions> = {}): GeneratorState {
  return {
    description: description.trim(),
    options: { ...DEFAULT_GENERATOR_OPTIONS, ...options },
    rounds: 0,
  };
}

export function recordValidation(state: GeneratorState, draft: unknown, validation: ValidationResult): GeneratorState {
  return {
    ...state,
    rounds: state.rounds + 1,
    lastDraft: draft,
    lastValidation: validation,
  };
}

export function canRepair(state: GeneratorState): boolean {
  return state.rounds < state.options.maxRepairRounds;
}

export function acceptSubmission(
  raw: unknown,
  context: ValidateWorkflowContext,
  compiler?: { provider?: string; model?: string; sourcePrompt?: string; generatedAt?: string },
): WorkflowWriteResult {
  const parsed = workflowFromStagesJson(raw, { source: "project" });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const withCompiler = compiler
    ? { ...parsed.workflow, compiler: { ...parsed.workflow.compiler, ...compiler } }
    : parsed.workflow;
  const draft = workflowToDraft(withCompiler);
  return validateWorkflowDraft(draft, context);
}

export function generatorMetaPrompt(opts: {
  description: string;
  options: GeneratorOptions;
}): string {
  return [
    "You design **workflows** for a VS Code extension that orchestrates AI coding agents. A workflow is a JSON document (authoring rules from `companions_workflow_schema` — not the full JSON Schema) describing stages, the role that runs each stage, the prompt contract of each stage, and the transitions between stages. A human approves every stage transition unless a stage gate is `auto`.",
    "",
    `**User's description:** «${opts.description}»`,
    `**Options:** reuse existing roles = ${opts.options.reuseRoles}; new roles as ${opts.options.newRoles}; write stages allowed = ${opts.options.allowWrite}; maximum stages = ${opts.options.maxStages}.`,
    "",
    "Steps: (1) call `companions_list_roles` and `companions_list_workflows`; list targets only if a stage must pin a provider (compact list; expand one provider for model ids); (2) draft the smallest workflow that satisfies the description — every stage must earn its cost; (3) give every stage a precise contract: purpose, inputs by path, instructions, a `companions-result` block with the fields later transitions need, acceptance, forbidden actions — do not also demand a second heading set; (4) bound every loop with `maxVisits`; route \"blocked\" or unclear outcomes to `$pause`; (5) prefer read-only profiles, and give write stages explicit scopes; (6) set a review stage to prefer a different provider than the stage it reviews; (7) call `companions_validate_workflow` and fix every error; (8) call `companions_submit_workflow` with the final JSON. Do not invent model ids — use only listed ones, or omit the model. Do not write files.",
    "",
    "If you cannot call tools, end with one fenced companions-workflow JSON block and nothing after it.",
  ].join("\n");
}

export function workflowArg(args: unknown): unknown {
  const obj = args && typeof args === "object" ? args as Record<string, unknown> : {};
  return obj.workflow ?? obj.draft ?? obj;
}

export { validateWorkflowRaw };
