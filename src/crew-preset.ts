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

/** Shipped when `.companions/crews/` is missing or empty. */
export const BUILTIN_PRESET: CrewPreset = {
  name: "default",
  roles: ["planner", "implementer", "reviewer", "fixer"],
  verify: undefined,
  body: "Plan, implement each step, review at the end. Insert fixer when a verify command is red.",
  source: "builtin",
};

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
  return {
    preset: {
      name,
      roles,
      ...(verify ? { verify } : {}),
      ...(reviewEvery ? { reviewEvery } : {}),
      ...(parallel ? { parallel: true } : {}),
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
  const presets = [...byName.values()];
  if (!presets.length) presets.push({ ...BUILTIN_PRESET });
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

/** Re-export so callers that already import this module do not also need agent-roles. */
export { AGENT_ROLES_DIR };
