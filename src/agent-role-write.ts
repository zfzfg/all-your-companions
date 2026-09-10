/**
 * The WRITE half of `agent-roles.ts` / `crew-preset.ts` (Settings → Agents & Crew).
 *
 * Until now a role or a crew flow could only be created by hand-writing YAML
 * into `.companions/agents/<name>.md`. The settings editor needs the reverse
 * direction — a draft the webview posted, turned into the exact file the
 * existing parsers read back — and that direction is where a hand-rolled YAML
 * writer usually goes wrong: a colon in a sentence, an apostrophe in a
 * preamble, a paragraph break in prose.
 *
 * Two rules keep it honest:
 *
 * 1. **Nothing invents a quoting scheme.** Prose goes out as a block scalar
 *    (`key: |`), which is exactly what `parseFrontmatter` now reads, so no
 *    character in a sentence needs escaping at all.
 * 2. **Every write is proved by reading it back.** `validateAgentRoleDraft`
 *    serializes, re-parses with `parseAgentRole`, and compares. A draft that
 *    does not survive the round trip is REFUSED rather than written — the
 *    alternative is a settings page that says "saved" over a file that means
 *    something else, which is the same class of quiet lie as a `reviewer`
 *    silently running the implementer's own model.
 *
 * Pure by construction (recipe R7): no `vscode`, no `fs`, no clock. The host
 * hands drafts in and gets file TEXT back; nothing here knows what a path is.
 */

import type { AcpProvider } from "./acp-backend";
import {
  AGENT_ROLES_DIR,
  isValidRoleName,
  parseAgentRole,
  parseRolePermissionLine,
  validateRoleModel,
  type AgentRole,
  type AgentRoleBudget,
  type AgentRoleMode,
} from "./agent-roles";
import { CREW_PRESETS_DIR, parseCrewPreset, type CrewPreset } from "./crew-preset";

export type RoleScope = "global" | "project";

/** What the settings page posts. Every field is optional except the three the
 *  parsers require, so a half-filled form fails validation rather than the
 *  message decoder. */
export interface AgentRoleDraft {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
  mode?: string;
  scope?: string[];
  budget?: { toolCalls?: number | string; tokens?: number | string; usd?: number | string };
  /** Raw permission lines, exactly as typed (`allow edit src/lib`). */
  permissions?: string[];
  whenToUse: string;
  whenNotToUse?: string;
  systemPreamble?: string;
  preferDifferentProvider?: boolean;
}

export interface CrewFlowDraft {
  name: string;
  roles?: string[];
  verify?: string;
  reviewEvery?: number | string;
  parallel?: boolean;
  notes?: string;
}

export type DraftResult<T> = { ok: true; value: T; text: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// YAML emission
// ---------------------------------------------------------------------------

/** True for a scalar that can be written bare: no quoting rules to get wrong,
 *  no leading indicator character YAML would read as structure. */
function isPlainScalar(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

/**
 * One scalar line. A value that is not plainly safe becomes a block scalar
 * rather than a quoted string: `parseFrontmatter` unquotes but does not
 * unescape, so a value containing its own quote character would come back
 * wrong. A block scalar has no such character.
 */
function emitScalar(key: string, value: string, out: string[]): void {
  const text = value.trim();
  if (!text) return;
  if (isPlainScalar(text) && !text.includes("\n")) {
    out.push(`${key}: ${text}`);
    return;
  }
  emitBlock(key, text, out);
}

function emitBlock(key: string, value: string, out: string[]): void {
  const text = value.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (!text) return;
  out.push(`${key}: |`);
  for (const line of text.split("\n")) out.push(line ? `  ${line}` : "");
}

function emitList(key: string, values: readonly string[], out: string[]): void {
  const items = values.map((entry) => entry.trim()).filter(Boolean);
  if (!items.length) return;
  out.push(`${key}:`);
  // Always a block list, never the inline `[a, b]` form: a glob may contain a
  // comma, and the inline form splits on commas.
  for (const item of items) out.push(`  - ${isPlainScalar(item) ? item : JSON.stringify(item)}`);
}

function frontmatter(lines: readonly string[], body: string): string {
  const prose = body.replace(/\r\n/g, "\n").trim();
  return `---\n${lines.join("\n")}\n---\n${prose ? `\n${prose}\n` : ""}`;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function cleanList(value: readonly string[] | undefined): string[] {
  return (value ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/** Element-wise, so no separator has to be chosen that a glob or a role name
 *  could not itself contain. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function positiveNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The file text for one role.
 *
 * `when_to_use` goes in the BODY rather than the frontmatter — that is the
 * shape §5.3 describes and the one a human opening the file reads first. The
 * other two prose fields have no such place, so they are block scalars.
 */
export function serializeAgentRole(draft: AgentRoleDraft): string {
  const lines: string[] = [];
  emitScalar("name", String(draft.name ?? "").trim().toLowerCase(), lines);
  emitScalar("provider", String(draft.provider ?? "").trim().toLowerCase(), lines);
  emitScalar("model", String(draft.model ?? "").trim(), lines);
  emitScalar("effort", String(draft.effort ?? "").trim().toLowerCase(), lines);
  emitScalar("mode", String(draft.mode ?? "").trim().toLowerCase(), lines);
  emitList("scope", cleanList(draft.scope), lines);
  const toolCalls = positiveNumber(draft.budget?.toolCalls);
  const tokens = positiveNumber(draft.budget?.tokens);
  if (toolCalls !== undefined || tokens !== undefined) {
    lines.push("budget:");
    if (toolCalls !== undefined) lines.push(`  tool_calls: ${toolCalls}`);
    if (tokens !== undefined) lines.push(`  tokens: ${tokens}`);
  }
  emitList("permissions", cleanList(draft.permissions), lines);
  if (draft.preferDifferentProvider) lines.push("prefer_different_provider: true");
  if (draft.whenNotToUse?.trim()) emitBlock("when_not_to_use", draft.whenNotToUse, lines);
  if (draft.systemPreamble?.trim()) emitBlock("system_preamble", draft.systemPreamble, lines);
  return frontmatter(lines, String(draft.whenToUse ?? ""));
}

export interface RoleValidationContext {
  /** Providers this build knows about. */
  providers: readonly AcpProvider[];
  /** That provider's cached model list, if it has been warmed. An empty or
   *  absent list skips the model check — see `validateRoleModel`. */
  knownModels?: Partial<Record<string, readonly { modelId: string; name?: string }[]>>;
  providerLabel?: (provider: string) => string;
  /** Names already taken in the scope being written to. */
  existingNames?: readonly string[];
  /** The name this draft is replacing, when editing rather than creating. */
  originalName?: string;
}

/**
 * Turn a draft into the role it will become and the text that encodes it, or
 * the single reason it was refused.
 *
 * Reuses `parseAgentRole` as the judge rather than re-deriving its rules: the
 * only definition of a valid role that matters is the one the runtime reads.
 */
export function validateAgentRoleDraft(
  draft: AgentRoleDraft,
  context: RoleValidationContext,
): DraftResult<AgentRole> {
  const name = String(draft.name ?? "").trim().toLowerCase();
  if (!name) return { ok: false, error: "Give the role a name — it is what follows `/agent`." };
  if (!isValidRoleName(name)) {
    return {
      ok: false,
      error: `\`${name}\` is not a usable role name. Use lowercase letters, digits and dashes, starting and ending with a letter or digit.`,
    };
  }
  const taken = (context.existingNames ?? []).map((entry) => entry.toLowerCase());
  const original = (context.originalName ?? "").toLowerCase();
  if (name !== original && taken.includes(name)) {
    return { ok: false, error: `A role called \`${name}\` already exists here. Pick another name, or edit that one.` };
  }
  if (!String(draft.whenToUse ?? "").trim()) {
    return {
      ok: false,
      error: "Say when to use this role. Without it nobody — and no crew flow — can tell when to reach for it.",
    };
  }
  for (const line of cleanList(draft.permissions)) {
    if (!parseRolePermissionLine(line)) {
      return {
        ok: false,
        error: `\`${line}\` is not a permission rule. Write \`allow|ask|deny\`, then \`read|edit|execute|other\`, then an optional path glob or command prefix.`,
      };
    }
  }

  const text = serializeAgentRole(draft);
  const parsed = parseAgentRole({ path: `${AGENT_ROLES_DIR}/${name}.md`, stem: name, text });
  if (parsed.problem || !parsed.role) {
    return { ok: false, error: parsed.problem?.message ?? "That role could not be written." };
  }
  const role = parsed.role;

  if (!context.providers.includes(role.provider)) {
    return { ok: false, error: `\`${role.provider}\` is not a companion this build can run.` };
  }
  const known = context.knownModels?.[role.provider];
  const label = context.providerLabel?.(role.provider) ?? role.provider;
  const verdict = validateRoleModel(role, known, label);
  if (!verdict.ok) return { ok: false, error: verdict.message };

  // The round-trip guard. Everything above proves the text PARSES; this proves
  // it parses back into what the user asked for.
  const drifted = roundTripDrift(draft, role);
  if (drifted) {
    return {
      ok: false,
      error: `This role could not be written without changing it (\`${drifted}\` did not survive the round trip). Please report this.`,
    };
  }
  return { ok: true, value: role, text };
}

/** Which field, if any, came back different from what was asked for. */
function roundTripDrift(draft: AgentRoleDraft, role: AgentRole): string | undefined {
  const same = (a: string | undefined, b: string | undefined) =>
    (a ?? "").replace(/\r\n/g, "\n").trim() === (b ?? "").replace(/\r\n/g, "\n").trim();
  if (!same(draft.model, role.model)) return "model";
  if (!same(draft.effort?.toLowerCase(), role.effort)) return "effort";
  if (!same(draft.whenToUse, role.whenToUse)) return "when_to_use";
  if (!same(draft.whenNotToUse, role.whenNotToUse)) return "when_not_to_use";
  if (!same(draft.systemPreamble, role.systemPreamble)) return "system_preamble";
  const scope = cleanList(draft.scope);
  if (!sameList(scope, role.scope ?? [])) return "scope";
  const permissions = cleanList(draft.permissions);
  if (permissions.length !== (role.permissions ?? []).length) return "permissions";
  return undefined;
}

/** Populate the editor from a loaded role. */
export function roleToDraft(role: AgentRole): AgentRoleDraft {
  return {
    name: role.name,
    provider: role.provider,
    ...(role.model ? { model: role.model } : {}),
    ...(role.effort ? { effort: role.effort } : {}),
    ...(role.mode ? { mode: role.mode as AgentRoleMode } : {}),
    ...(role.scope?.length ? { scope: [...role.scope] } : {}),
    ...(role.budget ? { budget: budgetToDraft(role.budget) } : {}),
    ...(role.permissions?.length
      ? {
          permissions: role.permissions.map((permission) =>
            [permission.action, permission.kind, permission.pathGlob ?? permission.commandPrefix ?? ""]
              .filter(Boolean)
              .join(" ")),
        }
      : {}),
    whenToUse: role.whenToUse,
    ...(role.whenNotToUse ? { whenNotToUse: role.whenNotToUse } : {}),
    ...(role.systemPreamble ? { systemPreamble: role.systemPreamble } : {}),
    ...(role.preferDifferentProvider ? { preferDifferentProvider: true } : {}),
  };
}

function budgetToDraft(budget: AgentRoleBudget): NonNullable<AgentRoleDraft["budget"]> {
  return {
    ...(budget.toolCalls !== undefined ? { toolCalls: budget.toolCalls } : {}),
    ...(budget.tokens !== undefined ? { tokens: budget.tokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// Crew flows
// ---------------------------------------------------------------------------

export function serializeCrewFlow(draft: CrewFlowDraft): string {
  const lines: string[] = [];
  emitScalar("name", String(draft.name ?? "").trim().toLowerCase(), lines);
  emitList("roles", cleanList(draft.roles), lines);
  if (String(draft.verify ?? "").trim()) emitScalar("verify", String(draft.verify), lines);
  const reviewEvery = positiveNumber(draft.reviewEvery);
  if (reviewEvery !== undefined) lines.push(`review_every: ${Math.floor(reviewEvery)}`);
  if (draft.parallel) lines.push("parallel: true");
  return frontmatter(lines, String(draft.notes ?? ""));
}

export interface FlowValidationContext {
  /** Role names that exist right now, so a flow cannot name one that does not. */
  roleNames: readonly string[];
  existingNames?: readonly string[];
  originalName?: string;
}

export function validateCrewFlowDraft(
  draft: CrewFlowDraft,
  context: FlowValidationContext,
): DraftResult<CrewPreset> {
  const name = String(draft.name ?? "").trim().toLowerCase();
  if (!name) return { ok: false, error: "Give the crew flow a name — it is what follows `/crew`." };
  if (!isValidRoleName(name)) {
    return {
      ok: false,
      error: `\`${name}\` is not a usable flow name. Use lowercase letters, digits and dashes, starting and ending with a letter or digit.`,
    };
  }
  const taken = (context.existingNames ?? []).map((entry) => entry.toLowerCase());
  const original = (context.originalName ?? "").toLowerCase();
  if (name !== original && taken.includes(name)) {
    return { ok: false, error: `A crew flow called \`${name}\` already exists here.` };
  }
  const roles = cleanList(draft.roles).map((entry) => entry.toLowerCase());
  const unknown = roles.filter((entry) => !context.roleNames.includes(entry));
  if (unknown.length) {
    return {
      ok: false,
      error:
        `This flow names ${unknown.length === 1 ? "a role" : "roles"} that `
        + `${unknown.length === 1 ? "does" : "do"} not exist: ${unknown.join(", ")}.`,
    };
  }

  const text = serializeCrewFlow({ ...draft, name, roles });
  const parsed = parseCrewPreset({ path: `${CREW_PRESETS_DIR}/${name}.md`, stem: name, text });
  if (parsed.problem || !parsed.preset) {
    return { ok: false, error: parsed.problem?.message ?? "That crew flow could not be written." };
  }
  if (!sameList(parsed.preset.roles, roles)) {
    return { ok: false, error: "This flow could not be written without changing its role order. Please report this." };
  }
  return { ok: true, value: parsed.preset, text };
}

export function presetToDraft(preset: CrewPreset): CrewFlowDraft {
  return {
    name: preset.name,
    roles: [...preset.roles],
    ...(preset.verify ? { verify: preset.verify } : {}),
    ...(preset.reviewEvery ? { reviewEvery: preset.reviewEvery } : {}),
    ...(preset.parallel ? { parallel: true } : {}),
    ...(preset.body ? { notes: preset.body } : {}),
  };
}
