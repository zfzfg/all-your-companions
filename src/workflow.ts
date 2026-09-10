/**
 * Workflow definitions for Crew sessions (AP-17).
 *
 * A workflow is a named stage graph: roles, prompt contracts, transitions and
 * gate policy. On disk it is a crew preset whose machine section is the
 * `<!-- companions:stages v1 -->` JSON block (D7). This module owns the types
 * and the parse of that block; it does not walk a run (that is
 * `workflow-run.ts`) and it does not write files (`workflow-write.ts`, P5).
 *
 * Pure (recipe R7): no vscode, no fs, no clock. Effort values come from
 * `EffortLevel`; provider ids from `ACP_PROVIDERS`. JSON Schema validation
 * of a draft is P5 (`workflow-validate.ts`); what lives here is the shape a
 * run actually executes.
 */

import type { EffortLevel } from "./acp";
import type { AcpProvider } from "./acp-backend";
import { isAcpProvider } from "./acp-backend";
import { isEffortLevel, isPermissionProfile, type PermissionProfile, type Target } from "./target-eligibility";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

/** Introduces the machine-readable stage graph inside a crew-preset Markdown file. */
export const STAGES_MARKER = "<!-- companions:stages v1 -->";

export const RESERVED_TARGETS = ["$done", "$pause", "$cancel"] as const;
export type ReservedTarget = (typeof RESERVED_TARGETS)[number];

export type GatePolicy = "manual" | "auto";
export type StageStrategy = "single-session" | "per-plan-step";
export type WorkflowSource = "builtin" | "global" | "project";

export function isReservedTarget(value: unknown): value is ReservedTarget {
  return value === "$done" || value === "$pause" || value === "$cancel";
}

export function isGatePolicy(value: unknown): value is GatePolicy {
  return value === "manual" || value === "auto";
}

export function isStageStrategy(value: unknown): value is StageStrategy {
  return value === "single-session" || value === "per-plan-step";
}

export interface WorkflowDefaults {
  gate: GatePolicy;
  worktree: boolean;
  verify?: string;
  allowSubagents: boolean;
}

export interface InlineRole {
  whenToUse: string;
  whenNotToUse?: string;
  systemPreamble?: string;
  mode?: "agent" | "plan";
  permissions?: string[];
}

export type WorkflowRoleRef = { ref: string } | { inline: InlineRole };

export interface PromptContractInput {
  /** Path into the run: `idea`, `userNotes`, `files.attached`, or `<stageId>.<field>`. */
  from: string;
  as: string;
}

export interface PromptContract {
  purpose: string;
  inputs: PromptContractInput[];
  instructions?: string;
  output: {
    sections: string[];
    resultBlock: {
      required: string[];
      verdict?: { values: string[] };
      findings?: { severity: string[] };
    };
  };
  acceptance?: string;
  forbidden?: string[];
}

export type TransitionWhen = {
  verdict?: string[];
  verify?: Array<"passed" | "failed" | "none">;
  findingsAtLeast?: "blocker" | "major" | "minor" | "nit";
  status?: Array<"done" | "failed">;
  unreported?: boolean;
};

export interface WorkflowTransition {
  when?: TransitionWhen;
  to: string;
  reason?: string;
}

export interface WorkflowStageTarget {
  provider?: AcpProvider;
  model?: string;
  effort?: EffortLevel;
  /** Stage id whose provider this review should prefer to differ from. */
  preferDifferentProviderThan?: string;
}

export interface WorkflowStage {
  id: string;
  title: string;
  role: string;
  enabled: boolean;
  profile: PermissionProfile;
  runMode?: "agent" | "plan";
  strategy?: StageStrategy;
  gate?: GatePolicy;
  target?: WorkflowStageTarget;
  scopeFrom?: string | string[];
  scope?: string[];
  maxVisits?: number;
  onMaxVisits?: string;
  contract: string;
  next: WorkflowTransition[];
  /** P6. Ignored in P4/P5. */
  allowSubagents?: boolean;
}

export interface WorkflowCompiler {
  provider?: string;
  model?: string;
  sourcePrompt?: string;
  generatedAt?: string;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  name: string;
  title: string;
  description?: string;
  whenToUse: string;
  whenNotToUse?: string;
  defaults: WorkflowDefaults;
  roles: Record<string, WorkflowRoleRef>;
  stages: WorkflowStage[];
  contracts: Record<string, PromptContract>;
  start: string[];
  source: WorkflowSource;
  path?: string;
  overrides?: "builtin" | "global";
  compiler?: WorkflowCompiler;
}

export type WorkflowParseResult =
  | { ok: true; workflow: WorkflowDefinition }
  | { ok: false; error: string };

const STAGES_BLOCK_RE = /<!--\s*companions:stages\s+v1\s*-->\s*```(?:json)?\s*\r?\n([\s\S]*?)```/i;

export function extractStagesBlock(markdown: string): { json?: string; error?: string } {
  const match = STAGES_BLOCK_RE.exec(String(markdown ?? ""));
  if (!match) return {};
  const json = match[1].trim();
  if (!json) return { error: "the stages block is empty" };
  return { json };
}

/**
 * Pull the stages JSON out of a preset file body, if present.
 *
 * Absence is not an error: a preset without a block is still a valid `/crew`
 * flow, and Crew sessions convert it on the fly (§8.8). A present-but-broken
 * block IS an error, so a half-written file cannot silently become the
 * default graph.
 */
export function parseStagesJson(markdown: string): { raw?: unknown; error?: string } {
  const extracted = extractStagesBlock(markdown);
  if (extracted.error) return { error: extracted.error };
  if (!extracted.json) return {};
  try {
    return { raw: JSON.parse(extracted.json) };
  } catch (error) {
    return { error: `stages JSON is not valid: ${(error as Error).message}` };
  }
}

export function findStage(def: WorkflowDefinition, id: string): WorkflowStage | undefined {
  return def.stages.find((stage) => stage.id === id);
}

export function enabledStages(def: WorkflowDefinition): WorkflowStage[] {
  return def.stages.filter((stage) => stage.enabled);
}

/**
 * First enabled candidate in `start[]`. Clarify is in the built-in start list
 * but `enabled: false` by default, so Plan is what actually begins a run.
 */
export function firstEnabledStart(def: WorkflowDefinition): string | undefined {
  for (const id of def.start) {
    const stage = findStage(def, id);
    if (stage?.enabled) return stage.id;
  }
  return enabledStages(def)[0]?.id;
}

/** How many enabled stages a progress badge should treat as "~N". Loops do not count twice. */
export function estimatedStageCount(def: WorkflowDefinition): number {
  return Math.max(1, enabledStages(def).length);
}

export function stageGatePolicy(stage: WorkflowStage, def: WorkflowDefinition): GatePolicy {
  return stage.gate ?? def.defaults.gate;
}

export function isAutoGate(
  stage: WorkflowStage,
  def: WorkflowDefinition,
  autoStartNextStage: boolean,
): boolean {
  if (autoStartNextStage) return true;
  return stageGatePolicy(stage, def) === "auto";
}

export function isWriteProfile(profile: PermissionProfile): boolean {
  return profile === "scoped-edit" || profile === "inherit";
}

export function contractRequiresVerdict(contract: PromptContract | undefined): boolean {
  return !!contract?.output.resultBlock.required.includes("verdict");
}

export function workflowNameOk(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => clean(entry)).filter(Boolean);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Coerce a stages-block JSON document into a {@link WorkflowDefinition}.
 *
 * This is the P4 reader: required fields must be present and well-typed, but
 * the twelve P5 validation rules (cycles, reachability, input provenance) are
 * not applied here. A run that cannot start still fails later, at the gate,
 * rather than at parse — a broken custom workflow is P5's job to refuse.
 */
export function workflowFromStagesJson(
  raw: unknown,
  meta: { source: WorkflowSource; path?: string; overrides?: "builtin" | "global"; name?: string },
): WorkflowParseResult {
  const obj = asObject(raw);
  if (!obj) return { ok: false, error: "stages block is not a JSON object" };
  const name = workflowNameOk(clean(obj.name)) ? clean(obj.name) : (meta.name ?? "");
  if (!workflowNameOk(name)) {
    return { ok: false, error: "workflow name must match [a-z0-9-]+" };
  }
  const defaultsRaw = asObject(obj.defaults) ?? {};
  const defaults: WorkflowDefaults = {
    gate: isGatePolicy(defaultsRaw.gate) ? defaultsRaw.gate : "manual",
    worktree: defaultsRaw.worktree === true,
    allowSubagents: defaultsRaw.allowSubagents === true,
    ...(clean(defaultsRaw.verify) ? { verify: clean(defaultsRaw.verify) } : {}),
  };
  const roles: Record<string, WorkflowRoleRef> = {};
  const rolesRaw = asObject(obj.roles) ?? {};
  for (const [key, value] of Object.entries(rolesRaw)) {
    const entry = asObject(value);
    if (!entry) continue;
    if (typeof entry.ref === "string" && entry.ref.trim()) {
      roles[key] = { ref: entry.ref.trim() };
      continue;
    }
    const inline = asObject(entry.inline);
    if (inline && clean(inline.whenToUse)) {
      roles[key] = {
        inline: {
          whenToUse: clean(inline.whenToUse),
          ...(clean(inline.whenNotToUse) ? { whenNotToUse: clean(inline.whenNotToUse) } : {}),
          ...(clean(inline.systemPreamble) ? { systemPreamble: clean(inline.systemPreamble) } : {}),
          ...(inline.mode === "plan" || inline.mode === "agent" ? { mode: inline.mode } : {}),
          ...(Array.isArray(inline.permissions) ? { permissions: asStringArray(inline.permissions) } : {}),
        },
      };
    }
  }
  const contracts: Record<string, PromptContract> = {};
  const contractsRaw = asObject(obj.contracts) ?? {};
  for (const [key, value] of Object.entries(contractsRaw)) {
    const parsed = parseContract(value);
    if (parsed) contracts[key] = parsed;
  }
  const stagesRaw = Array.isArray(obj.stages) ? obj.stages : [];
  const stages: WorkflowStage[] = [];
  for (const entry of stagesRaw) {
    const parsed = parseStage(entry, contracts);
    if (parsed) stages.push(parsed);
  }
  if (!stages.length) return { ok: false, error: "workflow has no stages" };
  const start = asStringArray(obj.start);
  const compilerRaw = asObject(obj.compiler);
  return {
    ok: true,
    workflow: {
      schemaVersion: 1,
      name,
      title: clean(obj.title) || name,
      ...(clean(obj.description) ? { description: clean(obj.description) } : {}),
      whenToUse: clean(obj.whenToUse) || clean(obj.when_to_use) || "",
      ...(clean(obj.whenNotToUse) || clean(obj.when_not_to_use)
        ? { whenNotToUse: clean(obj.whenNotToUse) || clean(obj.when_not_to_use) }
        : {}),
      defaults,
      roles,
      stages,
      contracts,
      start: start.length ? start : [stages.find((s) => s.enabled)?.id ?? stages[0].id],
      source: meta.source,
      ...(meta.path ? { path: meta.path } : {}),
      ...(meta.overrides ? { overrides: meta.overrides } : {}),
      ...(compilerRaw
        ? {
            compiler: {
              ...(clean(compilerRaw.provider) ? { provider: clean(compilerRaw.provider) } : {}),
              ...(clean(compilerRaw.model) ? { model: clean(compilerRaw.model) } : {}),
              ...(clean(compilerRaw.sourcePrompt) ? { sourcePrompt: clean(compilerRaw.sourcePrompt) } : {}),
              ...(clean(compilerRaw.generatedAt) ? { generatedAt: clean(compilerRaw.generatedAt) } : {}),
            },
          }
        : {}),
    },
  };
}

function parseContract(raw: unknown): PromptContract | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const purpose = clean(obj.purpose);
  const inputsRaw = Array.isArray(obj.inputs) ? obj.inputs : [];
  const inputs: PromptContractInput[] = [];
  for (const entry of inputsRaw) {
    const item = asObject(entry);
    if (!item) continue;
    const from = clean(item.from);
    const as = clean(item.as) || from;
    if (from) inputs.push({ from, as });
  }
  if (!purpose || !inputs.length) return undefined;
  const outputRaw = asObject(obj.output) ?? {};
  const blockRaw = asObject(outputRaw.resultBlock) ?? {};
  const verdictRaw = asObject(blockRaw.verdict);
  const findingsRaw = asObject(blockRaw.findings);
  return {
    purpose,
    inputs,
    ...(clean(obj.instructions) ? { instructions: clean(obj.instructions) } : {}),
    output: {
      sections: asStringArray(outputRaw.sections),
      resultBlock: {
        required: asStringArray(blockRaw.required),
        ...(verdictRaw && Array.isArray(verdictRaw.values)
          ? { verdict: { values: asStringArray(verdictRaw.values) } }
          : {}),
        ...(findingsRaw && Array.isArray(findingsRaw.severity)
          ? { findings: { severity: asStringArray(findingsRaw.severity) } }
          : {}),
      },
    },
    ...(clean(obj.acceptance) ? { acceptance: clean(obj.acceptance) } : {}),
    ...(Array.isArray(obj.forbidden) ? { forbidden: asStringArray(obj.forbidden) } : {}),
  };
}

function parseStage(raw: unknown, contracts: Record<string, PromptContract>): WorkflowStage | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const id = clean(obj.id);
  const role = clean(obj.role);
  if (!id || !role) return undefined;
  const contractRef = resolveContractName(obj.contract, contracts);
  if (!contractRef) return undefined;
  const nextRaw = Array.isArray(obj.next) ? obj.next : [];
  const next: WorkflowTransition[] = [];
  for (const entry of nextRaw) {
    const item = asObject(entry);
    if (!item) continue;
    const to = clean(item.to);
    if (!to) continue;
    const when = parseWhen(item.when);
    next.push({
      to,
      ...(when ? { when } : {}),
      ...(clean(item.reason) ? { reason: clean(item.reason) } : {}),
    });
  }
  const target = parseStageTarget(obj.target);
  const scopeFrom = Array.isArray(obj.scopeFrom)
    ? asStringArray(obj.scopeFrom)
    : clean(obj.scopeFrom) || undefined;
  const maxVisits = typeof obj.maxVisits === "number" && obj.maxVisits >= 1
    ? Math.floor(obj.maxVisits)
    : undefined;
  return {
    id,
    title: clean(obj.title) || id,
    role,
    enabled: obj.enabled !== false,
    profile: isPermissionProfile(obj.profile) ? obj.profile : "read-only",
    ...(obj.runMode === "plan" || obj.runMode === "agent" ? { runMode: obj.runMode } : {}),
    ...(isStageStrategy(obj.strategy) ? { strategy: obj.strategy } : {}),
    ...(isGatePolicy(obj.gate) ? { gate: obj.gate } : {}),
    ...(target ? { target } : {}),
    ...(scopeFrom ? { scopeFrom } : {}),
    ...(Array.isArray(obj.scope) ? { scope: asStringArray(obj.scope) } : {}),
    ...(maxVisits !== undefined ? { maxVisits } : {}),
    ...(clean(obj.onMaxVisits) ? { onMaxVisits: clean(obj.onMaxVisits) } : {}),
    contract: contractRef,
    next,
    ...(obj.allowSubagents === true ? { allowSubagents: true } : {}),
  };
}

function resolveContractName(raw: unknown, contracts: Record<string, PromptContract>): string | undefined {
  if (typeof raw === "string" && contracts[raw]) return raw;
  const obj = asObject(raw);
  const ref = typeof obj?.$ref === "string" ? obj.$ref : "";
  const named = ref.replace(/^#\/contracts\//, "");
  if (named && contracts[named]) return named;
  return undefined;
}

function parseWhen(raw: unknown): TransitionWhen | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const when: TransitionWhen = {};
  if (Array.isArray(obj.verdict)) when.verdict = asStringArray(obj.verdict);
  if (Array.isArray(obj.verify)) {
    when.verify = asStringArray(obj.verify).filter(
      (value): value is "passed" | "failed" | "none" =>
        value === "passed" || value === "failed" || value === "none",
    );
  }
  if (
    obj.findingsAtLeast === "blocker"
    || obj.findingsAtLeast === "major"
    || obj.findingsAtLeast === "minor"
    || obj.findingsAtLeast === "nit"
  ) {
    when.findingsAtLeast = obj.findingsAtLeast;
  }
  if (Array.isArray(obj.status)) {
    when.status = asStringArray(obj.status).filter(
      (value): value is "done" | "failed" => value === "done" || value === "failed",
    );
  }
  if (typeof obj.unreported === "boolean") when.unreported = obj.unreported;
  return Object.keys(when).length ? when : undefined;
}

function parseStageTarget(raw: unknown): WorkflowStageTarget | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const target: WorkflowStageTarget = {};
  if (isAcpProvider(obj.provider)) target.provider = obj.provider;
  if (clean(obj.model)) target.model = clean(obj.model);
  if (isEffortLevel(obj.effort)) target.effort = obj.effort;
  if (clean(obj.preferDifferentProviderThan)) {
    target.preferDifferentProviderThan = clean(obj.preferDifferentProviderThan);
  }
  return Object.keys(target).length ? target : undefined;
}

/** Stable JSON for snapshots: sorted keys, no whitespace drift. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = asObject(value);
  if (!obj) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
  return out;
}

/** FNV-1a 32-bit, hex. Snapshot identity without pulling in `node:crypto`. */
export function snapshotHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function workflowSnapshotPayload(def: WorkflowDefinition): string {
  const { source: _source, path: _path, overrides: _overrides, ...rest } = def;
  void _source;
  void _path;
  void _overrides;
  return stableStringify(rest);
}

export function workflowSnapshotHash(def: WorkflowDefinition): string {
  return snapshotHash(workflowSnapshotPayload(def));
}

/**
 * Overlay `companions.crew.maxFixerPasses` onto the Fix stage of a snapshot.
 *
 * The setting is read at run start and baked in: editing it later must not
 * change a paused run's meaning, which is why this happens before the
 * snapshot is written, not at resume.
 */
export function applyMaxFixerPasses(def: WorkflowDefinition, maxFixerPasses: number): WorkflowDefinition {
  const n = Number.isFinite(maxFixerPasses) && maxFixerPasses >= 1 ? Math.floor(maxFixerPasses) : 2;
  return {
    ...def,
    stages: def.stages.map((stage) =>
      stage.id === "fix" || stage.role === "fixer" ? { ...stage, maxVisits: n } : stage,
    ),
  };
}

export function stageTargetHint(stage: WorkflowStage): Target | undefined {
  const t = stage.target;
  if (!t) return undefined;
  if (!t.provider && !t.model && !t.effort) return undefined;
  return {
    ...(t.provider ? { provider: t.provider } : { provider: "grok" as AcpProvider }),
    ...(t.model ? { model: t.model } : {}),
    ...(t.effort ? { effort: t.effort } : {}),
    ...(stage.runMode ? { runMode: stage.runMode } : {}),
  };
}

// ---------------------------------------------------------------------------
// Built-in `idea-to-done` (§7.3, Appendix B)
// ---------------------------------------------------------------------------

const PLAN_CONTRACT: PromptContract = {
  purpose: "Turn the idea into an ordered plan a different model can implement without asking.",
  inputs: [
    { from: "idea", as: "Goal" },
    { from: "files.attached", as: "Attached files" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Write an ordered plan. Each step has an id, a title, an acceptance criterion and the files it is likely to touch. "
    + "Name risks and open questions. Do not edit anything.",
  output: {
    sections: ["Summary", "Plan", "Risks", "Open questions"],
    resultBlock: { required: ["planSteps"] },
  },
  acceptance: "A later implementer can carry this out without asking what the steps are.",
  forbidden: ["Editing files", "Running commands that modify the workspace"],
};

const IMPLEMENT_CONTRACT: PromptContract = {
  purpose: "Implement the plan steps in order; stay within scope; run the verify command if given.",
  inputs: [
    { from: "idea", as: "Goal" },
    { from: "plan.planSteps", as: "Plan steps and acceptance criteria" },
    { from: "plan.filesReported", as: "Files the planner named" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Carry out the plan in order. Stay inside the named files unless a deviation is unavoidable, and say so. "
    + "Run the verify command if one is in this briefing.",
  output: {
    sections: ["Summary", "Steps done", "Files touched", "Deviations", "Open questions"],
    resultBlock: { required: ["summary", "filesChanged"] },
  },
  acceptance: "Every plan step is done or named as a deviation, with the files that changed.",
  forbidden: ["Re-planning the feature", "Touching files outside scope without saying so"],
};

const REVIEW_CONTRACT: PromptContract = {
  purpose: "Judge whether the implementation satisfies the plan and is safe to keep.",
  inputs: [
    { from: "idea", as: "Goal" },
    { from: "plan.planSteps", as: "Plan steps and acceptance criteria" },
    { from: "implement.summary", as: "What the implementer says was done" },
    { from: "implement.filesObserved", as: "Files actually changed (host-observed)" },
    { from: "implement.verify", as: "Verify result" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Read the changed files and the diffs. Check every acceptance criterion. "
    + "Look for regressions, missing error handling, and edits outside the plan. Do not edit.",
  output: {
    sections: ["Summary", "Findings", "Acceptance check", "Open questions"],
    resultBlock: {
      required: ["verdict", "findings"],
      verdict: { values: ["pass", "changes_requested", "blocked"] },
      findings: { severity: ["blocker", "major", "minor", "nit"] },
    },
  },
  acceptance: "Every plan step is marked met / not met with a reason.",
  forbidden: ["Editing files", "Running commands that modify the workspace", "Re-planning the feature"],
};

const FIX_CONTRACT: PromptContract = {
  purpose: "Resolve the review findings (blocker and major first); re-run verify.",
  inputs: [
    { from: "idea", as: "Goal" },
    { from: "review.findings", as: "Review findings" },
    { from: "review.verdict", as: "Review verdict" },
    { from: "implement.filesObserved", as: "Files the implementer changed" },
    { from: "implement.verify", as: "Verify result" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Fix the findings, blocker and major first. Do not add features or unrelated refactors. Re-run verify if given.",
  output: {
    sections: ["Summary", "Fixed", "Not fixed", "Files touched"],
    resultBlock: { required: ["summary", "filesChanged"] },
  },
  acceptance: "Each finding is fixed or named with a reason it was not.",
  forbidden: ["New features", "Unrelated refactors"],
};

const CLARIFY_CONTRACT: PromptContract = {
  purpose: "Ask at most 5 questions whose answers would change the plan.",
  inputs: [
    { from: "idea", as: "Goal" },
    { from: "files.attached", as: "Attached files" },
  ],
  instructions: "You ask questions only. You never plan or edit. At most five questions.",
  output: {
    sections: ["Questions"],
    resultBlock: { required: ["questions"] },
  },
  forbidden: ["Planning", "Editing files"],
};

/**
 * The shipped default workflow. Source of truth for the runtime; the Markdown
 * copy in `resources/crews/idea-to-done.md` is kept in lockstep by test.
 */
export const IDEA_TO_DONE: WorkflowDefinition = {
  schemaVersion: 1,
  name: "idea-to-done",
  title: "Idea to done",
  description: "Plan, implement, review, and fix until the review passes.",
  whenToUse: "Features and changes that touch a handful of files and can be reviewed as one change.",
  whenNotToUse: "Pure research questions; large migrations that need per-step worktrees.",
  defaults: {
    gate: "manual",
    worktree: false,
    allowSubagents: false,
  },
  roles: {
    planner: { ref: "planner" },
    implementer: { ref: "implementer" },
    reviewer: { ref: "reviewer" },
    fixer: { ref: "fixer" },
    clarifier: {
      inline: {
        whenToUse: "Ask the user the few questions that would change the plan.",
        systemPreamble: "You ask questions only. You never plan or edit.",
        mode: "plan",
      },
    },
  },
  stages: [
    {
      id: "clarify",
      title: "Clarify",
      role: "clarifier",
      enabled: false,
      profile: "read-only",
      runMode: "plan",
      contract: "clarify",
      next: [{ to: "plan" }],
    },
    {
      id: "plan",
      title: "Plan",
      role: "planner",
      enabled: true,
      profile: "read-only",
      runMode: "plan",
      target: { effort: "high" },
      contract: "plan",
      next: [{ to: "implement" }],
    },
    {
      id: "implement",
      title: "Implement",
      role: "implementer",
      enabled: true,
      profile: "scoped-edit",
      scopeFrom: "plan.files",
      strategy: "single-session",
      contract: "implement",
      next: [{ to: "review" }],
    },
    {
      id: "review",
      title: "Review",
      role: "reviewer",
      enabled: true,
      profile: "read-only",
      target: { preferDifferentProviderThan: "implement" },
      contract: "review",
      next: [
        { when: { verdict: ["pass"], verify: ["passed", "none"] }, to: "$done" },
        { when: { verdict: ["changes_requested"] }, to: "fix" },
        { when: { verify: ["failed"] }, to: "fix" },
        { when: { verdict: ["blocked"] }, to: "$pause", reason: "Reviewer is blocked and needs you." },
      ],
    },
    {
      id: "fix",
      title: "Fix",
      role: "fixer",
      enabled: true,
      profile: "scoped-edit",
      scopeFrom: ["review.findings.files", "implement.filesObserved"],
      maxVisits: 2,
      onMaxVisits: "$pause",
      contract: "fix",
      next: [{ to: "review" }],
    },
  ],
  contracts: {
    clarify: CLARIFY_CONTRACT,
    plan: PLAN_CONTRACT,
    implement: IMPLEMENT_CONTRACT,
    review: REVIEW_CONTRACT,
    fix: FIX_CONTRACT,
  },
  start: ["clarify", "plan"],
  source: "builtin",
};
