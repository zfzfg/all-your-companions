/**
 * Crew presets: `.companions/crews/<name>.md` (AP-12, decision 18.1).
 *
 * A preset is the project-level recipe for a run: which roles, optional
 * verify command, optional review cadence, optional `parallel: true`.
 * Role `permissions:` live on the role file, not here.
 *
 * Pure against file *contents* the host already read.
 */

import {
  parseFrontmatter,
  isValidRoleName,
  AGENT_ROLES_DIR,
  type AgentRole,
  type AgentRoleSet,
} from "./agent-roles";
import {
  IDEA_TO_DONE,
  parseStagesJson,
  workflowFromStagesJson,
  type GatePolicy,
  type WorkflowDefinition,
} from "./workflow";

export const CREW_PRESETS_DIR = ".companions/crews";

export interface CrewPreset {
  name: string;
  /** Role names, in the order a human would read them. Empty = use built-ins. */
  roles: string[];
  /** Shell command run after each writing step. Empty = no verify loop. */
  verify?: string;
  /** Insert a reviewer every N implementer steps. 0 / absent = only at the end. */
  reviewEvery?: number;
  /** Opt-in isolation: each step runs in its own worktree (AP-13). Sequential remains the default. */
  parallel?: boolean;
  title?: string;
  whenToUse?: string;
  defaultGate?: GatePolicy;
  worktree?: boolean;
  /**
   * Raw JSON from `<!-- companions:stages v1 -->`, when the file has one.
   * Absent means "this is still a flat `/crew` flow"; Crew sessions convert
   * it on the fly via {@link presetToStageGraph} rather than rewriting the file.
   */
  stages?: unknown;
  body: string;
  source: "builtin" | "global" | "project";
  path?: string;
  /** Set when this flow replaced one of the same name from a wider scope. */
  overrides?: "builtin" | "global";
}

export interface CrewPresetProblem {
  preset: string;
  message: string;
}

export interface CrewPresetFile {
  path: string;
  stem: string;
  text: string;
  /** Which set this file belongs to. Absent means `project`. */
  scope?: "global" | "project";
}

export interface CrewPresetSet {
  presets: CrewPreset[];
  problems: CrewPresetProblem[];
}

/** Shipped when `.companions/crews/` is missing or empty. The `/crew` default. */
export const BUILTIN_PRESET: CrewPreset = {
  name: "default",
  roles: ["planner", "implementer", "reviewer", "fixer"],
  verify: undefined,
  body: "Plan, implement each step, review at the end. Insert fixer when a verify command is red.",
  source: "builtin",
};

/** Shipped Crew-session default. Lives in code so a missing resource file cannot disable Crew. */
export const BUILTIN_IDEA_TO_DONE_PRESET: CrewPreset = {
  name: IDEA_TO_DONE.name,
  title: IDEA_TO_DONE.title,
  whenToUse: IDEA_TO_DONE.whenToUse,
  roles: ["planner", "implementer", "reviewer", "fixer"],
  defaultGate: IDEA_TO_DONE.defaults.gate,
  stages: ideaToDoneStagesJson(),
  body: IDEA_TO_DONE.description ?? "",
  source: "builtin",
};

function ideaToDoneStagesJson(): unknown {
  return {
    schemaVersion: IDEA_TO_DONE.schemaVersion,
    name: IDEA_TO_DONE.name,
    title: IDEA_TO_DONE.title,
    description: IDEA_TO_DONE.description,
    whenToUse: IDEA_TO_DONE.whenToUse,
    whenNotToUse: IDEA_TO_DONE.whenNotToUse,
    defaults: IDEA_TO_DONE.defaults,
    roles: IDEA_TO_DONE.roles,
    stages: IDEA_TO_DONE.stages.map((stage) => ({
      ...stage,
      contract: { $ref: `#/contracts/${stage.contract}` },
    })),
    contracts: IDEA_TO_DONE.contracts,
    start: IDEA_TO_DONE.start,
  };
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  const single = str(value);
  return single ? single.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [];
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(str(value));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseCrewPreset(file: CrewPresetFile): { preset?: CrewPreset; problem?: CrewPresetProblem } {
  const parsed = parseFrontmatter(file.text);
  if (parsed.error && !Object.keys(parsed.fields).length) {
    return { problem: { preset: file.stem, message: `${file.path}: ${parsed.error}` } };
  }
  const name = str(parsed.fields.name) || file.stem;
  if (!isValidRoleName(name)) {
    return { problem: { preset: file.stem, message: `${file.path}: preset name '${name}' is not [a-z0-9-]` } };
  }
  const roles = strList(parsed.fields.roles).filter(isValidRoleName);
  const verify = str(parsed.fields.verify) || undefined;
  const reviewEvery = num(parsed.fields.review_every ?? parsed.fields.reviewEvery);
  const parallel = parsed.fields.parallel === true;
  const title = str(parsed.fields.title) || undefined;
  const whenToUse = str(parsed.fields.when_to_use ?? parsed.fields.whenToUse) || undefined;
  const defaultGate = parsed.fields.default_gate === "auto" || parsed.fields.defaultGate === "auto"
    ? "auto" as const
    : parsed.fields.default_gate === "manual" || parsed.fields.defaultGate === "manual"
      ? "manual" as const
      : undefined;
  const worktree = parsed.fields.worktree === true;
  const stagesParsed = parseStagesJson(file.text);
  if (stagesParsed.error) {
    return { problem: { preset: name, message: `${file.path}: ${stagesParsed.error}` } };
  }
  return {
    preset: {
      name,
      roles,
      ...(verify ? { verify } : {}),
      ...(reviewEvery ? { reviewEvery } : {}),
      ...(parallel ? { parallel: true } : {}),
      ...(title ? { title } : {}),
      ...(whenToUse ? { whenToUse } : {}),
      ...(defaultGate ? { defaultGate } : {}),
      ...(worktree ? { worktree: true } : {}),
      ...(stagesParsed.raw !== undefined ? { stages: stagesParsed.raw } : {}),
      body: parsed.body,
      source: file.scope === "global" ? "global" : "project",
      path: file.path,
    },
  };
}

/**
 * Fold flow files into the usable set, narrowing scope by scope — `global`
 * (`~/.companions/crews`, this machine) first, then `project`, which may
 * replace a global flow of the same name. Two files of the SAME scope
 * claiming one name stays a conflict, for the same reason as in
 * `loadAgentRoles`: neither is more specific, so choosing would be arbitrary.
 *
 * With no usable file at all the shipped `default` stands in, exactly as
 * before — `findCrewPreset` still falls back to the first flow when a project
 * defines flows but none of them is named `default`.
 */
export function loadCrewPresets(files: readonly CrewPresetFile[]): CrewPresetSet {
  const byName = new Map<string, CrewPreset>();
  const problems: CrewPresetProblem[] = [];
  const seen = new Map<string, { path: string; scope: "global" | "project" }>();
  const ordered = [...files].sort((a, b) => {
    const rank = (file: CrewPresetFile) => (file.scope === "global" ? 0 : 1);
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
  for (const file of ordered) {
    const scope = file.scope === "global" ? "global" : "project";
    const { preset, problem } = parseCrewPreset(file);
    if (problem) problems.push(problem);
    if (!preset) continue;
    const previous = seen.get(preset.name);
    if (previous && previous.scope === scope) {
      problems.push({ preset: preset.name, message: `${file.path}: duplicate preset name '${preset.name}'` });
      continue;
    }
    const displaced = byName.get(preset.name);
    seen.set(preset.name, { path: file.path, scope });
    byName.set(preset.name, displaced ? { ...preset, overrides: displaced.source as "builtin" | "global" } : preset);
  }
  const hadFiles = byName.size > 0;
  if (!byName.has(BUILTIN_IDEA_TO_DONE_PRESET.name)) {
    byName.set(BUILTIN_IDEA_TO_DONE_PRESET.name, { ...BUILTIN_IDEA_TO_DONE_PRESET });
  }
  // The empty-directory fallback is still `default` for `/crew`. A project
  // that already defined flows must not gain a silent extra `default` — that
  // would steal `findCrewPreset(undefined)` from the flow it used to pick.
  if (!hadFiles && !byName.has(BUILTIN_PRESET.name)) {
    byName.set(BUILTIN_PRESET.name, { ...BUILTIN_PRESET });
  }
  const presets = [...byName.values()];
  return { presets, problems };
}

export function findCrewPreset(set: CrewPresetSet, name: string | undefined): CrewPreset {
  const wanted = (name ?? "").trim().toLowerCase();
  if (wanted && wanted !== "default") {
    const named = set.presets.find((p) => p.name === wanted);
    if (named) return named;
  }
  return set.presets.find((p) => p.name === "default") ?? set.presets[0] ?? { ...BUILTIN_PRESET };
}

export function crewPresetPath(name: string): string {
  return `${CREW_PRESETS_DIR}/${name}.md`;
}

/**
 * The roles a flow may assign, in the flow's own order.
 *
 * `roles:` was parsed and then ignored by the run loop until now, which made
 * the field a decoration: a flow that said `roles: [planner, implementer]`
 * still let a `researcher` pick up a step because assignment saw every loaded
 * role. Restricting the pool is the whole difference between a flow being a
 * configuration and a flow being a label.
 *
 * An EMPTY list means "every role", not "no roles" — that is the shipped
 * meaning of an absent `roles:` and the only reading that keeps existing flow
 * files working. A name that resolves to nothing is reported rather than
 * dropped: silently shrinking the pool is how a chain ends up assigning steps
 * to a role the author never intended.
 */
export function presetRoles(
  preset: Pick<CrewPreset, "name" | "roles">,
  set: AgentRoleSet,
): { roles: AgentRole[]; problems: CrewPresetProblem[] } {
  const wanted = preset.roles ?? [];
  if (!wanted.length) return { roles: [...set.roles], problems: [] };
  const byName = new Map(set.roles.map((role) => [role.name, role]));
  const roles: AgentRole[] = [];
  const problems: CrewPresetProblem[] = [];
  for (const name of wanted) {
    const role = byName.get(name);
    if (!role) {
      problems.push({
        preset: preset.name,
        message: `Crew flow \`${preset.name}\` lists a role \`${name}\` that is not defined. It will not be assigned.`,
      });
      continue;
    }
    if (!roles.includes(role)) roles.push(role);
  }
  // A flow whose every name was wrong must not silently become "assign
  // nothing" — that skips the whole run. Fall back to the full set and let the
  // problems above explain why.
  if (!roles.length) return { roles: [...set.roles], problems };
  return { roles, problems };
}

/** The role a flow's review cadence should use: its own reviewer-ish entry
 *  when it lists one, else the conventional `reviewer`. Undefined when neither
 *  is loaded, which the caller reads as "no cadence to apply". */
export function presetReviewRole(
  preset: Pick<CrewPreset, "roles">,
  set: AgentRoleSet,
): string | undefined {
  const listed = (preset.roles ?? []).find((name) => name.includes("review"));
  const candidate = listed ?? "reviewer";
  return set.roles.some((role) => role.name === candidate) ? candidate : undefined;
}

/**
 * A preset without a stages block, converted to the default Plan → Implement
 * → Review → Fix graph (§8.8).
 *
 * Pure adapter: the file is not rewritten. `parallel: true` selects
 * `per-plan-step` for Implement; `verify` becomes the verify command; a red
 * verify still routes to Fix. `review_every` is recorded on the definition
 * as a repeated review-before-done cadence the inner step-walker already
 * understands — the graph itself stays four stages.
 */
export function presetToStageGraph(preset: CrewPreset): WorkflowDefinition {
  if (preset.stages !== undefined) {
    const parsed = workflowFromStagesJson(preset.stages, {
      source: preset.source,
      path: preset.path,
      overrides: preset.overrides,
      name: preset.name,
    });
    if (parsed.ok) {
      return {
        ...parsed.workflow,
        ...(preset.verify && !parsed.workflow.defaults.verify
          ? { defaults: { ...parsed.workflow.defaults, verify: preset.verify } }
          : {}),
      };
    }
  }
  const pool = (preset.roles.length ? preset.roles : ["planner", "implementer", "reviewer", "fixer"])
    .filter(isValidRoleName);
  const pick = (...candidates: string[]) =>
    pool.find((name) => candidates.includes(name)) ?? candidates[0];
  const planner = pick("planner");
  const implementer = pick("implementer");
  const reviewer = pick("reviewer");
  const fixer = pick("fixer");
  const strategy = preset.parallel ? "per-plan-step" as const : "single-session" as const;
  const verify = preset.verify;
  const gate = preset.defaultGate ?? "manual";
  return {
    schemaVersion: 1,
    name: preset.name,
    title: preset.title || preset.name,
    whenToUse: preset.whenToUse || preset.body.split("\n")[0] || "",
    defaults: {
      gate,
      worktree: preset.worktree === true || preset.parallel === true,
      allowSubagents: false,
      ...(verify ? { verify } : {}),
    },
    roles: {
      [planner]: { ref: planner },
      [implementer]: { ref: implementer },
      [reviewer]: { ref: reviewer },
      [fixer]: { ref: fixer },
    },
    stages: [
      {
        id: "plan",
        title: "Plan",
        role: planner,
        enabled: true,
        profile: "read-only",
        runMode: "plan",
        contract: "plan",
        next: [{ to: "implement" }],
      },
      {
        id: "implement",
        title: "Implement",
        role: implementer,
        enabled: true,
        profile: "scoped-edit",
        scopeFrom: "plan.files",
        strategy,
        contract: "implement",
        next: [{ to: "review" }],
      },
      {
        id: "review",
        title: "Review",
        role: reviewer,
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
        role: fixer,
        enabled: true,
        profile: "scoped-edit",
        scopeFrom: ["review.findings.files", "implement.filesObserved"],
        maxVisits: 2,
        onMaxVisits: "$pause",
        contract: "fix",
        next: [{ to: "review" }],
      },
    ],
    contracts: IDEA_TO_DONE.contracts,
    start: ["plan"],
    source: preset.source,
    ...(preset.path ? { path: preset.path } : {}),
    ...(preset.overrides ? { overrides: preset.overrides } : {}),
  };
}

/** Re-export so callers that already import this module do not also need agent-roles. */
export { AGENT_ROLES_DIR };
