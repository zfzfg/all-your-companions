/**
 * Crew presets: `.companions/crews/<name>.md` (AP-12, decision 18.1).
 *
 * A preset is the project-level recipe for a run: which roles, optional
 * verify command, optional review cadence, optional `parallel: true`.
 * Role `permissions:` live on the role file, not here.
 *
 * Pure against file *contents* the host already read.
 */

import { parseFrontmatter, isValidRoleName, AGENT_ROLES_DIR } from "./agent-roles";

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
  source: "builtin" | "project";
  path?: string;
}

export interface CrewPresetProblem {
  preset: string;
  message: string;
}

export interface CrewPresetFile {
  path: string;
  stem: string;
  text: string;
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
      source: "project",
      path: file.path,
    },
  };
}

export function loadCrewPresets(files: readonly CrewPresetFile[]): CrewPresetSet {
  const presets: CrewPreset[] = [];
  const problems: CrewPresetProblem[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const { preset, problem } = parseCrewPreset(file);
    if (problem) problems.push(problem);
    if (!preset) continue;
    if (seen.has(preset.name)) {
      problems.push({ preset: preset.name, message: `${file.path}: duplicate preset name '${preset.name}'` });
      continue;
    }
    seen.add(preset.name);
    presets.push(preset);
  }
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

/** Re-export so callers that already import this module do not also need agent-roles. */
export { AGENT_ROLES_DIR };
