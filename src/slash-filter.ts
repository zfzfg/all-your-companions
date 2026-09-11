import type { HandoffKind } from "./handoff";

export interface SlashCmd {
  name: string;
  description?: string;
  /**
   * ACP `AvailableCommand._meta`. Skills are advertised with `scope` + `path`
   * (grok shell `available_commands()`); builtins omit those keys.
   */
  _meta?: { path?: unknown; scope?: unknown; [k: string]: unknown };
  meta?: { path?: unknown; scope?: unknown; [k: string]: unknown };
}

/**
 * A skill on the `available_commands_update` wire: `_meta.scope` + `_meta.path`
 * both present as non-empty strings. Builtins have no such meta. Name shape
 * (`user:commit`, `frontend-design:frontend-design`) is only the collision/
 * plugin qualifier — a skill with no collision is advertised as a bare name
 * (`imagine`, `commit`), so a colon is not the distinguisher.
 *
 * Source: grok-build-CLI `slash_commands.rs` `available_commands` and pager
 * `AcpSlashCommand::from` (`meta.path` + `meta.scope`).
 */
export function isAdvertisedSkill(cmd: SlashCmd | null | undefined): boolean {
  if (!cmd || typeof cmd !== "object") return false;
  const meta = cmd._meta || cmd.meta;
  if (!meta || typeof meta !== "object") return false;
  const path = meta.path;
  const scope = meta.scope;
  return typeof path === "string" && path.length > 0 && typeof scope === "string" && scope.length > 0;
}

/**
 * Slash commands the HOST answers itself. They are never forwarded to a CLI.
 *
 * The precedent is `/compact` on the Antigravity adapter, which the host
 * answers rather than passing down (agy-acp-adapter.ts). The rule matters more
 * here than it did there: `/agent` is not a command any of the four CLIs
 * advertises, so forwarding it would not produce an error — it would produce
 * an ordinary, billed LLM turn in which the model politely improvises what it
 * thinks `/agent reviewer …` might mean. That is worse than a failure, because
 * it looks like the feature working.
 */
export const HOST_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "agent",
  "agents",
  // AP-11. Same rule, same reason: no CLI advertises these, so forwarding
  // one buys a billed turn in which the model improvises what it might mean.
  "handoff",
  "second-opinion",
  // AP-12. A chain is N billed sessions; forwarding `/crew` would be one more,
  // in which the model improvises an orchestration it cannot actually run.
  "crew",
  // AP-16 diagnose. Forwarding would bill a turn in which the model guesses
  // at Gemini eligibility instead of reading the host's live roster.
  "subagents",
]);

/** Host slash commands advertised in autocomplete popovers with clear descriptions */
export const EXTENSION_HOST_SLASH_COMMANDS: SlashCmd[] = [
  {
    name: "agent",
    description: "Run a single task with a named agent role (e.g. planner, reviewer, implementer)",
  },
  {
    name: "agents",
    description: "List and manage available agent roles for this project",
  },
  {
    name: "crew",
    description: "Walk the current plan step-by-step with a team of specialized roles (/crew [preset] [goal])",
  },
  {
    name: "handoff",
    description: "Hand off conversation context to another role (default: implementer)",
  },
  {
    name: "second-opinion",
    description: "Request an independent review of recent changes from another model/reviewer",
  },
  {
    name: "subagents",
    description: "Show whether this session can start a companion subagent (e.g. Gemini)",
  },
];

export interface AgentCommand {
  name: string;
  task: string;
}

/** `/agent` or `/agents` typed with no role name — lists roles rather than complain. */
export type AgentCommandParse =
  | { kind: "none" }
  | { kind: "list" }
  | { kind: "run"; command: AgentCommand }
  | { kind: "error"; message: string };

/**
 * Parse `/agent <name> <task>` or `/agents [name] [task]` out of a composer message.
 *
 * Only at position 0 of the message, matching every other dispatching slash
 * command (see {@link matchSlashCommand}) — `see /agent docs` in prose must
 * stay prose. The task is everything after the name, verbatim including
 * newlines: a briefing task is frequently a paragraph, and trimming it to one
 * line would quietly truncate the only field the user actually wrote.
 */
export function parseAgentCommand(text: string): AgentCommandParse {
  const match = /^\/agents?(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return { kind: "none" };
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "list" };
  const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!split) return { kind: "list" };
  const name = split[1].toLowerCase();
  const task = (split[2] ?? "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return { kind: "error", message: `\`${split[1]}\` is not a valid role name — lowercase letters, digits and dashes only.` };
  }
  if (!task) {
    return { kind: "error", message: `\`/agent ${name}\` needs a task: \`/agent ${name} <what the role should do>\`.` };
  }
  return { kind: "run", command: { name, task } };
}

/** `/handoff` and `/second-opinion` (AP-11) — the typed form of the two
 *  thread actions. */
export type HandoffCommandParse =
  | { kind: "none" }
  | { kind: "run"; handoff: HandoffKind; role?: string }
  | { kind: "error"; message: string };

/**
 * Parse `/handoff [role]` or `/second-opinion [role]`.
 *
 * Unlike {@link parseAgentCommand} the role is OPTIONAL — each action has a
 * sensible default (`implementer`, `reviewer`) and, unlike `/agent`, there is
 * no task to supply: the host derives it from the conversation. That is the
 * whole point of these two commands, so requiring an argument would be asking
 * for the one thing the user does not have to say.
 *
 * Anything AFTER the role name is rejected rather than ignored. A user who
 * types `/second-opinion check the auth flow` is trying to give instructions;
 * silently dropping them and reviewing something else would be worse than
 * saying that this command does not take a task.
 */
export function parseHandoffCommand(text: string): HandoffCommandParse {
  const match = /^\/(handoff|second-opinion)(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return { kind: "none" };
  const handoff: HandoffKind = match[1] === "handoff" ? "handoff" : "second-opinion";
  const rest = (match[2] ?? "").trim();
  if (!rest) return { kind: "run", handoff };
  const parts = rest.split(/\s+/);
  const role = parts[0].toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(role)) {
    return {
      kind: "error",
      message: `\`${parts[0]}\` is not a valid role name — lowercase letters, digits and dashes only.`,
    };
  }
  if (parts.length > 1) {
    return {
      kind: "error",
      message:
        `\`/${match[1]}\` takes a role name and nothing else — the task is derived from this `
        + `conversation. Use \`/agent ${role} <task>\` to write the task yourself.`,
    };
  }
  return { kind: "run", handoff, role };
}

export type CrewCommandParse =
  | { kind: "none" }
  | { kind: "run"; preset?: string; goal?: string }
  | { kind: "error"; message: string };

/**
 * Parse `/crew [preset] [goal]`.
 *
 * The preset is optional (the built-in `default` stands in). Anything after
 * the preset name is the goal, verbatim — same reason `/agent`'s task keeps
 * newlines. An omitted goal means the host derives it from the last user
 * message, like a handoff.
 */
export function parseCrewCommand(text: string): CrewCommandParse {
  const match = /^\/crew(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return { kind: "none" };
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "run" };
  const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!split) return { kind: "run" };
  const preset = split[1].toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(preset)) {
    return {
      kind: "error",
      message: `\`${split[1]}\` is not a valid crew preset name — lowercase letters, digits and dashes only.`,
    };
  }
  const goal = (split[2] ?? "").trim();
  return { kind: "run", preset, ...(goal ? { goal } : {}) };
}

function isAsciiWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

export type SlashQuery = { query: string; atStart: boolean };

/**
 * Slash commands the extension hides from both the autocomplete list and the
 * dispatch gate. `/always-approve` (#31) only mutates grok's *global*
 * config.toml — a surprising, sticky side effect that then silences permission
 * cards in every grok session — and is a no-op over ACP anyway. `/context`
 * (#39) renders only in the CLI's own TUI: over ACP stdio it streams nothing
 * back, so selecting it silently does nothing (`/session-info` is the working
 * equivalent). Filtered at ingestion (see `filterAdvertisedCommands`).
 */
export const HIDDEN_SLASH_COMMANDS: ReadonlySet<string> = new Set(["always-approve", "context"]);

/** Drop hidden commands from an advertised `available_commands_update` list. */
export function filterAdvertisedCommands<T extends { name: string }>(commands: T[]): T[] {
  return commands.filter((c) => !HIDDEN_SLASH_COMMANDS.has(c.name));
}

/**
 * Given the current composer text and cursor position, return the slash-token
 * query (chars after `/` up to the caret) or `null` if no popover is active.
 *
 * A `/` token is at position 0 of the whole message, or preceded by ASCII
 * whitespace (the same boundary grok's `parse_skill_references` uses). File
 * paths like `foo/bar` are not tokens. `atStart` is true only when `/` is
 * byte 0 — commands dispatch only there; skills load anywhere.
 */
export function getSlashQuery(text: string, caret: number): SlashQuery | null {
  const before = text.slice(0, caret);
  const m = before.match(/\/(\S*)$/);
  if (!m) return null;
  const slashIndex = before.length - m[0].length;
  if (slashIndex > 0 && !isAsciiWhitespace(before.charAt(slashIndex - 1))) return null;
  return { query: m[1], atStart: slashIndex === 0 };
}

export function filterCommands(commands: SlashCmd[], query: string): SlashCmd[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  // Name prefix, then mid-name, then description-only. Name hits always beat
  // a description-only hit. Walk once so each tier keeps advertised order (#110).
  // KEEP IN STEP with media/webview-helpers.js filterCommands.
  const prefix: SlashCmd[] = [];
  const substring: SlashCmd[] = [];
  const description: SlashCmd[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) substring.push(c);
    else if ((c.description || "").toLowerCase().includes(q)) description.push(c);
  }
  return prefix.concat(substring, description);
}

/**
 * The partial `/q` token the popover is completing, or null.
 *
 * Matches a `/token` at position 0 **or** after whitespace — skills load
 * mid-prompt, so the completer must be able to rewrite that token. Commands
 * are still only *offered* when {@link getSlashQuery} reports `atStart`
 * (they only dispatch at position 0 of the text block; #110).
 */
export const SLASH_TOKEN_RE = /\/(\S*)$/;

/** Replace the partial `/q` token under the caret with `/<name> `. */
export function applySlashPick(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const hit = getSlashQuery(text, caret);
  if (!hit) return { text, caret };
  const m = before.match(SLASH_TOKEN_RE);
  if (!m) return { text, caret };
  const slashIndex = before.length - m[0].length;
  const newBefore = before.slice(0, slashIndex) + `/${name} `;
  return { text: newBefore + after, caret: newBefore.length };
}

export type SubagentsCommandParse = { kind: "none" } | { kind: "diagnose" };

/** `/subagents` — host diagnose, never forwarded. Extra words are ignored. */
export function parseSubagentsCommand(text: string): SubagentsCommandParse {
  return /^\/subagents(?:\s|$)/.test(String(text ?? "").trim())
    ? { kind: "diagnose" }
    : { kind: "none" };
}

/**
 * The slash command a typed message dispatches, or `null` for ordinary prose.
 *
 * The CLI only recognizes a slash command when it sits at position 0 of the
 * prompt's text block — editor-injected context in front of it silently turns
 * `/compact` into a normal LLM turn (verified against grok 0.2.87 in
 * research/compact-probe.cjs). The caller uses a match to move that context
 * BEHIND the command text instead (see buildPrompt), so this must never match
 * prose: the token boundary rejects Unix paths (`/tmp/foo` — `tmp` is followed
 * by `/`, not whitespace/end), and a known-commands check rejects things shaped
 * like commands that grok never advertised. An empty `commandNames` means the
 * `available_commands_update` hasn't arrived yet — fall back to shape alone,
 * since a wrongly-trailing envelope (broken dispatch) costs far more than a
 * wrongly-leading one (grok just reads the context first).
 */
export function matchSlashCommand(text: string, commandNames: string[]): string | null {
  const m = text.match(/^\/([A-Za-z0-9][\w.:-]*)(?:\s|$)/);
  if (!m) return null;
  if (commandNames.length === 0) return m[1];
  return commandNames.includes(m[1]) ? m[1] : null;
}
