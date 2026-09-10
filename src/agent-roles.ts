/**
 * Named roles for `/agent <name> <task>` (AP-10, Crew stage 1).
 *
 * A role is a *session recipe*: which provider answers, on which model, at
 * which reasoning effort, in which mode, and — the part a human reads — when
 * to reach for it. Roles live as `.companions/agents/<name>.md` in the project
 * (decision 18.1: versionable, shareable, reviewable like any other project
 * standard), with five built-ins standing in when that directory is absent.
 *
 * Pure by construction: no `vscode`, no `fs`, no clock. The host hands this
 * module file *contents* it already read and gets back roles or diagnostics;
 * nothing here learns what a path means. That is what lets the whole
 * validation surface — including the model-against-provider check, which is
 * the one with real teeth — be tested without a disk.
 *
 * ## Two roles may share a provider
 *
 * This is a MAIN case, not an edge one (feature plan §5.3.1): Opus plans,
 * Haiku implements, Opus reviews — one subscription, three sessions, full
 * context-stretching and role separation. Nothing here treats a repeated
 * provider as a collision, and {@link validateRoleModel} exists precisely so
 * that the *model* half of such a pair is checked rather than assumed.
 *
 * ## Why an unknown model is an error and not a fallback
 *
 * Silently dropping back to the provider default would produce the single
 * worst outcome this feature can have: a `reviewer` the user believes is a
 * second opinion from a different model, quietly re-running the same model
 * that wrote the code. That is the "quality illusion" of §5.10 with the
 * evidence removed. So a model this provider does not list is a configuration
 * error, named in full. The one exception is an unwarmed model cache: not
 * knowing the model list is not the same as knowing the model is wrong, and
 * guessing in either direction would be worse than skipping the check.
 */
import type { AcpProvider } from "./acp-backend";
import {
  createRule,
  type PermissionAction,
  type PermissionKind,
  type PermissionRule,
} from "./permission-rules";

export type AgentRoleMode = "agent" | "plan";

export interface AgentRoleBudget {
  toolCalls?: number;
  tokens?: number;
  usd?: number;
}

/**
 * One line of a role's AP-07 overlay: `allow edit src/**`, `deny execute rm`.
 * Tight on purpose (18.5) — never a blanket auto-accept.
 */
export interface AgentRolePermission {
  action: PermissionAction;
  kind: PermissionKind;
  pathGlob?: string;
  commandPrefix?: string;
}

export interface AgentRole {
  /** Invocation name — `[a-z0-9-]`, what follows `/agent `. */
  name: string;
  provider: AcpProvider;
  /** Empty/absent means "this provider's default model". */
  model?: string;
  effort?: string;
  mode?: AgentRoleMode;
  /** Globs this role may touch. Empty means the whole project. Stage 1 puts
   *  these in the briefing as a stated boundary; AP-13 also feeds them to
   *  {@link permissions} when the role file has no explicit overlay. */
  scope?: string[];
  budget?: AgentRoleBudget;
  /**
   * Tight AP-07 overlay for this role (18.5). Deny still wins; the floor
   * cannot be overridden. Absent means the usual card / Auto accept.
   */
  permissions?: AgentRolePermission[];
  /** The documentation from the source note — and the text a later
   *  orchestrator (AP-12) reads to assign a step. Never empty. */
  whenToUse: string;
  whenNotToUse?: string;
  /** Prepended to the briefing, ahead of everything else. */
  systemPreamble?: string;
  /**
   * This role is only worth running with a FRESH pair of eyes.
   *
   * Feature plan §5.10 is blunt that the outside view is the condition for a
   * review being worth anything, not a nicety — and it is graded: a different
   * model of the same provider in a fresh session with only the briefing does
   * review seriously; a different provider is the strongest form; the same
   * companion looking at its own work in its own thread finds nothing and is
   * worse than no review, because it looks like one.
   *
   * Two things follow, and both are visible rather than silent. When a role is
   * picking its provider (which only happens for the built-ins — see
   * {@link BUILTIN_ROLES}), this steers the pick AWAY from the caller's
   * provider. And when it ends up on the caller's provider anyway — one
   * account connected, or a project file that names it — the result card says
   * so, so nobody reads a same-provider pass as an independent one.
   */
  preferDifferentProvider?: boolean;
  /**
   * Where this role came from. Built-ins are the fallback set below; `global`
   * is `~/.companions/agents/` (this machine, every project); `project` is the
   * open project's own `.companions/agents/`.
   *
   * Only `builtin` is special to the runtime: its `provider` is a placeholder
   * the host may rewrite. A `global` role was written by the user with a
   * provider they meant, exactly like a `project` one, so nothing may swap it.
   */
  source: "builtin" | "global" | "project";
  /** Source file — relative to the project root for `project`, to the home
   *  directory for `global`. Absent for a built-in. */
  path?: string;
  /** Set when this role replaced one of the same name from a wider scope, so
   *  the settings page can say so rather than showing two rows or one silent
   *  winner. */
  overrides?: "builtin" | "global";
}

export interface AgentRoleProblem {
  /** Role name when it could be determined, else the file stem. */
  role: string;
  message: string;
}

export interface AgentRoleFile {
  /** Relative path, e.g. `.companions/agents/reviewer.md`. Used for messages
   *  and for the "open the role file" link on the result card. */
  path: string;
  /** File stem — the fallback name when the frontmatter omits one. */
  stem: string;
  text: string;
  /** Which set this file belongs to. Absent means `project`, so a caller that
   *  predates the global set keeps its old meaning. */
  scope?: "global" | "project";
}

export interface AgentRoleSet {
  roles: AgentRole[];
  problems: AgentRoleProblem[];
}

export const AGENT_ROLES_DIR = ".companions/agents";

const PROVIDERS: readonly AcpProvider[] = ["grok", "codex", "claude", "gemini"];
const EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];

/** `[a-z0-9-]`, must start and end alphanumeric. The name is typed after a
 *  slash and shown in a card; a leading dash reads as a flag. */
export const AGENT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidRoleName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/**
 * The five shipped roles (feature plan §5.3), used when `.companions/agents/`
 * is missing or empty — the acceptance criterion is that everything works
 * without that directory existing.
 *
 * `provider` here is a *placeholder* the host rewrites to a usable provider
 * before the run (`resolveRoleProvider`): a built-in cannot know which
 * accounts this machine has, and pinning them to `claude` would make the
 * feature dead on a Gemini-only install. `model` is deliberately unset — a
 * built-in must never name a model, because a named model the user's provider
 * does not carry is exactly the configuration error this module refuses to
 * invent.
 *
 * What the built-ins DO fix is the part carrying the value: read-only vs.
 * writing, plan vs. agent mode, and the prose saying when each is the right
 * call. Users who want model separation write role files; the built-ins give
 * them a working `/agent` on the first run.
 */
export const BUILTIN_ROLES: readonly AgentRole[] = [
  {
    name: "planner",
    provider: "claude",
    mode: "plan",
    whenToUse:
      "Turning a vague goal into an ordered list of concrete steps, before any code is written. "
      + "Runs in Plan mode on the strongest model available, and writes nothing.",
    whenNotToUse:
      "Anything that must change a file. A planner that edits has stopped being a planner.",
    systemPreamble:
      "You are planning only. Do not edit, create, or delete any file, and do not run commands that change state. "
      + "Produce the plan and stop.",
    source: "builtin",
  },
  {
    name: "implementer",
    provider: "claude",
    mode: "agent",
    whenToUse:
      "Carrying out one already-decided step with a stated acceptance criterion. Best on a fast, "
      + "cheap model: the thinking happened in the plan, this is the typing.",
    whenNotToUse:
      "Open questions, architecture decisions, or a step whose acceptance criterion is not written down. "
      + "Send those back to the planner instead of guessing.",
    systemPreamble:
      "Carry out exactly the one task in this briefing — no adjacent improvements, no refactors that were not asked for. "
      + "If the task cannot be done as written, say so in the result instead of substituting a different task.",
    source: "builtin",
  },
  {
    name: "reviewer",
    provider: "claude",
    mode: "agent",
    whenToUse:
      "Checking finished work against its briefing, in a fresh session that never saw the implementation. "
      + "Configure it on a DIFFERENT model from the implementer — a different provider is stronger still.",
    whenNotToUse:
      "As the same model, in the same thread, on its own work. That review finds nothing and is worse than "
      + "no review, because it looks like one.",
    preferDifferentProvider: true,
    systemPreamble:
      "You are reviewing, not fixing. Report what is wrong and where; do not edit any file. "
      + "Judge the work against the acceptance criterion in this briefing, not against your own preferences.",
    source: "builtin",
  },
  {
    name: "researcher",
    provider: "claude",
    mode: "agent",
    whenToUse:
      "Answering a question about the codebase — where something lives, how a flow is wired, what a "
      + "dependency actually does — without spending the main session's context on the search.",
    whenNotToUse: "Anything that should end in a change. A researcher answers; it does not act.",
    systemPreamble:
      "Answer the question. Do not edit, create, or delete any file. Cite the paths and symbols you relied on "
      + "so the answer can be checked.",
    source: "builtin",
  },
  {
    name: "fixer",
    provider: "claude",
    mode: "agent",
    whenToUse:
      "One job only: a named check is red and must go green. Give it the exact command and a hard iteration cap.",
    whenNotToUse:
      "As a general repair role. Without a check that decides when it is finished, a fixer edits until it runs out of budget.",
    systemPreamble:
      "Make the named check pass. Change the minimum needed for that, and never weaken or delete the check itself "
      + "to make it pass. If you cannot make it pass, stop and report why rather than continuing to edit.",
    source: "builtin",
  },
];

function builtinCopy(): AgentRole[] {
  return BUILTIN_ROLES.map((role) => ({
    ...role,
    ...(role.scope ? { scope: [...role.scope] } : {}),
    ...(role.permissions ? { permissions: role.permissions.map((p) => ({ ...p })) } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * A deliberately small YAML subset — `key: scalar`, `key: [a, b]`, `- item`
 * block lists, one level of nesting for `budget:`, and `key: |` / `key: >`
 * block scalars.
 *
 * The block scalars exist for the prose keys (`when_not_to_use`,
 * `system_preamble`): those are paragraphs, and the settings editor has to be
 * able to write one back without inventing a quoting scheme that this parser
 * would then have to un-invent. `|` keeps the line breaks, `>` folds them into
 * spaces; a trailing `-` (`|-`) is accepted and means the same thing here,
 * because nothing downstream cares about a final newline.
 *
 * Written by hand rather than pulled in as a dependency: production deps are
 * exactly four (plan §1.3) and a role file is a fixed, documented handful of
 * keys. The narrowness is the point — anything this parser cannot read is
 * reported as a problem naming the line, never half-understood.
 *
 * Unknown keys are IGNORED rather than rejected, so a role file written for a
 * later stage still loads here. `permissions:` is now a known list (AP-13).
 */
export interface Frontmatter {
  fields: Record<string, unknown>;
  body: string;
  error?: string;
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(text ?? "");
  if (!match) return { fields: {}, body: (text ?? "").trim(), error: "missing a `---` frontmatter block" };
  const body = (match[2] ?? "").trim();
  const fields: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  let listKey: string | undefined;
  let mapKey: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line.startsWith("- ") || line === "-") {
      if (!listKey) return { fields, body, error: `line ${index + 1}: list item without a key above it` };
      (fields[listKey] as unknown[]).push(scalar(line === "-" ? "" : line.slice(2)));
      continue;
    }
    const pair = splitKey(line);
    if (!pair) return { fields, body, error: `line ${index + 1}: expected \`key: value\`` };
    const [key, rest] = pair;
    if (indent > 0 && mapKey) {
      (fields[mapKey] as Record<string, unknown>)[key] = scalar(rest);
      continue;
    }
    listKey = undefined;
    mapKey = undefined;
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const collected: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor];
        const candidateIndent = candidate.length - candidate.trimStart().length;
        // A blank line inside a block is part of it (paragraph break); a blank
        // line that turns out to be the last thing in the block is trimmed off
        // below, so trailing whitespace cannot leak into the value.
        if (!candidate.trim()) {
          collected.push("");
          continue;
        }
        if (candidateIndent <= indent) break;
        collected.push(candidate);
      }
      while (collected.length && !collected[collected.length - 1]!.trim()) collected.pop();
      const base = collected.reduce(
        (least, candidate) =>
          candidate.trim() ? Math.min(least, candidate.length - candidate.trimStart().length) : least,
        Number.POSITIVE_INFINITY,
      );
      const dedented = collected.map((candidate) =>
        (candidate.trim() && Number.isFinite(base) ? candidate.slice(base) : "").replace(/\s+$/, ""));
      fields[key] = rest.startsWith(">")
        ? dedented.join(" ").replace(/\s+/g, " ").trim()
        : dedented.join("\n");
      index = cursor - 1;
      continue;
    }
    if (rest === "") {
      // Either a block list or a nested map follows; peek at the next
      // meaningful line rather than guessing from the key's name.
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() && !candidate.trim().startsWith("#"));
      if (next && next.trim().startsWith("-")) {
        fields[key] = [];
        listKey = key;
      } else if (next && next.length - next.trimStart().length > 0) {
        fields[key] = {};
        mapKey = key;
      } else {
        fields[key] = "";
      }
      continue;
    }
    fields[key] = scalar(rest);
  }
  return { fields, body };
}

/** Split on the first `:` that is not inside quotes. */
function splitKey(line: string): [string, string] | undefined {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") {
      const key = line.slice(0, i).trim();
      if (!key) return undefined;
      return [key, line.slice(i + 1).trim()];
    }
  }
  return undefined;
}

function scalar(value: string): unknown {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => unquote(part.trim())).filter((part) => part !== "");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return unquote(text);
}

function unquote(text: string): string {
  const quoted = text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")));
  return quoted ? text.slice(1, -1) : text;
}

// ---------------------------------------------------------------------------
// Role parsing
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter((entry) => entry !== "");
  const single = str(value);
  return single ? [single] : [];
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(str(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Parse one role file. Returns the role, or the single reason it was rejected.
 *
 * The prose body after the frontmatter becomes `whenToUse` when the
 * frontmatter has no `when_to_use:` — that is the shape §5.3 describes
 * ("YAML-Frontmatter + Prosa"), and it means the most natural role file, a
 * short header and a paragraph, works without saying the same thing twice.
 */
export function parseAgentRole(file: AgentRoleFile): { role?: AgentRole; problem?: AgentRoleProblem } {
  const stem = file.stem.trim().toLowerCase();
  const fail = (message: string) => ({ problem: { role: stem || file.path, message } });
  const front = parseFrontmatter(file.text);
  if (front.error) return fail(`\`${file.path}\` could not be read — ${front.error}.`);
  const fields = front.fields;

  const name = (str(fields.name) || stem).toLowerCase();
  if (!name) return fail(`\`${file.path}\` has no role name.`);
  if (!isValidRoleName(name)) {
    return fail(`Role \`${name}\` has an invalid name — use lowercase letters, digits and dashes only.`);
  }

  const providerRaw = str(fields.provider).toLowerCase();
  if (!providerRaw) return fail(`Role \`${name}\`: \`provider:\` is required (one of ${PROVIDERS.join(", ")}).`);
  if (!PROVIDERS.includes(providerRaw as AcpProvider)) {
    return fail(`Role \`${name}\`: unknown provider \`${providerRaw}\` — expected one of ${PROVIDERS.join(", ")}.`);
  }
  const provider = providerRaw as AcpProvider;

  const effort = str(fields.effort).toLowerCase();
  if (effort && !EFFORTS.includes(effort)) {
    return fail(`Role \`${name}\`: unknown effort \`${effort}\` — expected one of ${EFFORTS.join(", ")}.`);
  }

  const modeRaw = str(fields.mode).toLowerCase();
  if (modeRaw && modeRaw !== "agent" && modeRaw !== "plan") {
    return fail(`Role \`${name}\`: \`mode:\` must be \`agent\` or \`plan\`, not \`${modeRaw}\`.`);
  }

  const whenToUse = str(fields.when_to_use) || str(fields.whenToUse) || front.body;
  if (!whenToUse) {
    return fail(
      `Role \`${name}\`: needs \`when_to_use:\` or a paragraph of prose below the frontmatter — `
      + `without it nobody (and no orchestrator) can tell when to reach for this role.`,
    );
  }
  const whenNotToUse = str(fields.when_not_to_use) || str(fields.whenNotToUse);

  const budgetRaw = fields.budget;
  const budget: AgentRoleBudget = {};
  if (budgetRaw && typeof budgetRaw === "object" && !Array.isArray(budgetRaw)) {
    const source = budgetRaw as Record<string, unknown>;
    const toolCalls = num(source.tool_calls ?? source.toolCalls);
    const tokens = num(source.tokens);
    const usd = num(source.usd);
    if (toolCalls !== undefined) budget.toolCalls = toolCalls;
    if (tokens !== undefined) budget.tokens = tokens;
    if (usd !== undefined) budget.usd = usd;
  }

  const scope = strList(fields.scope);
  const systemPreamble = str(fields.system_preamble) || str(fields.systemPreamble);
  const preferDifferent = fields.prefer_different_provider === true
    || fields.preferDifferentProvider === true;
  const permissions = parseRolePermissions(fields.permissions);

  return {
    role: {
      name,
      provider,
      ...(str(fields.model) ? { model: str(fields.model) } : {}),
      ...(effort ? { effort } : {}),
      ...(modeRaw ? { mode: modeRaw as AgentRoleMode } : {}),
      ...(scope.length ? { scope } : {}),
      ...(Object.keys(budget).length ? { budget } : {}),
      ...(permissions.length ? { permissions } : {}),
      whenToUse,
      ...(whenNotToUse ? { whenNotToUse } : {}),
      ...(systemPreamble ? { systemPreamble } : {}),
      ...(preferDifferent ? { preferDifferentProvider: true } : {}),
      source: file.scope === "global" ? "global" : "project",
      path: file.path,
    },
  };
}

const ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"]);
const KINDS = new Set<PermissionKind>(["read", "edit", "execute", "other"]);

/** `allow edit src/**` / `deny execute rm`. A scalar like `strict` is ignored. */
export function parseRolePermissionLine(line: string): AgentRolePermission | undefined {
  const parts = String(line ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const action = parts[0]!.toLowerCase() as PermissionAction;
  const kind = parts[1]!.toLowerCase() as PermissionKind;
  if (!ACTIONS.has(action) || !KINDS.has(kind)) return undefined;
  const rest = parts.slice(2).join(" ").trim();
  const perm: AgentRolePermission = { action, kind };
  if (rest) {
    if (kind === "execute") perm.commandPrefix = rest;
    else perm.pathGlob = rest;
  }
  return perm;
}

export function parseRolePermissions(value: unknown): AgentRolePermission[] {
  const lines = Array.isArray(value) ? value.map(str) : [];
  const out: AgentRolePermission[] = [];
  for (const line of lines) {
    const parsed = parseRolePermissionLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Role overlay as AP-07 rules. Caller concatenates after user rules so last-match-wins. */
export function rolePermissionsToRules(role: AgentRole, now = 0): PermissionRule[] {
  const perms = role.permissions ?? [];
  return perms.map((p, i) => createRule({
    id: `role-${role.name}-${i + 1}`,
    action: p.action,
    scope: "workspace",
    createdAt: now,
    note: `role ${role.name}`,
    match: {
      kind: p.kind,
      ...(p.pathGlob ? { pathGlob: p.pathGlob } : {}),
      ...(p.commandPrefix ? { commandPrefix: p.commandPrefix } : {}),
    },
  }));
}

/**
 * Fold role files into the usable set.
 *
 * A file REPLACES the role of the same name from a wider scope rather than
 * merging with it — a half-overridden role is the kind of thing that reads as
 * working and is not. The three scopes narrow in order: built-in, then
 * `global` (`~/.companions/agents`, this machine), then `project`. So a
 * project may pin a reviewer for the repo without disturbing the one you use
 * everywhere else, and the winner records what it displaced (`overrides`) so
 * the settings page can say which file is actually in force.
 *
 * Two files of the SAME scope claiming one name is still a conflict, because
 * neither is more specific than the other and picking one would be arbitrary:
 * it is reported and the first path wins.
 *
 * A file that fails to parse does not silently fall back to the wider scope
 * either: it is reported, and the wider role remains only because it was never
 * removed. Ordering is by name so a listing is stable.
 */
export function loadAgentRoles(files: readonly AgentRoleFile[]): AgentRoleSet {
  const byName = new Map<string, AgentRole>();
  for (const role of builtinCopy()) byName.set(role.name, role);
  const problems: AgentRoleProblem[] = [];
  const seen = new Map<string, { path: string; scope: "global" | "project" }>();
  const ordered = [...files].sort((a, b) => {
    const rank = (file: AgentRoleFile) => (file.scope === "global" ? 0 : 1);
    return rank(a) - rank(b) || a.path.localeCompare(b.path);
  });
  for (const file of ordered) {
    const scope = file.scope === "global" ? "global" : "project";
    const { role, problem } = parseAgentRole(file);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (!role) continue;
    const previous = seen.get(role.name);
    if (previous && previous.scope === scope) {
      problems.push({
        role: role.name,
        message: `Role \`${role.name}\` is defined twice — \`${previous.path}\` and \`${file.path}\`. Using \`${previous.path}\`.`,
      });
      continue;
    }
    const displaced = byName.get(role.name);
    seen.set(role.name, { path: file.path, scope });
    byName.set(role.name, displaced ? { ...role, overrides: displaced.source as "builtin" | "global" } : role);
  }
  return {
    roles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

export function findAgentRole(set: AgentRoleSet, name: string): AgentRole | undefined {
  const wanted = String(name ?? "").trim().toLowerCase();
  return set.roles.find((role) => role.name === wanted);
}

// ---------------------------------------------------------------------------
// Model validation
// ---------------------------------------------------------------------------

export type RoleModelVerdict =
  | { ok: true; checked: boolean }
  | { ok: false; checked: true; message: string };

/**
 * Check a role's model against the models its provider actually carries.
 *
 * `known` is that provider's cached model list. An EMPTY list means the cache
 * has not been warmed for this provider — the check is skipped and reported as
 * `checked: false`, never read as "the provider has no models" (which would
 * reject every role on a cold start). A role with no model is always fine:
 * empty means "this provider's default", which is a real, working choice.
 */
export function validateRoleModel(
  role: Pick<AgentRole, "name" | "provider" | "model">,
  known: readonly { modelId: string; name?: string }[] | undefined,
  providerLabel: string,
): RoleModelVerdict {
  const model = (role.model ?? "").trim();
  if (!model) return { ok: true, checked: false };
  const list = (known ?? []).filter((entry) => typeof entry?.modelId === "string" && entry.modelId.length > 0);
  if (!list.length) return { ok: true, checked: false };
  if (list.some((entry) => entry.modelId === model)) return { ok: true, checked: true };
  const available = list.map((entry) => entry.modelId).sort().join(", ");
  return {
    ok: false,
    checked: true,
    message:
      `Role \`${role.name}\`: ${providerLabel} does not have a model \`${model}\`. `
      + `Available: ${available}.`,
  };
}
