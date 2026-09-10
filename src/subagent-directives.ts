/**
 * AP-16 §6.8 — telling the main agent which subagent to use, per message.
 *
 * The user types `@subagent:gemini/<model> effort:low` or `@role:inspector` in
 * the composer; the webview turns it into a chip as soon as it is typed; the
 * host serialises the chips into one block appended to the prompt, and peels
 * that block back into chips when the session is restored.
 *
 * Pure logic module adhering to Recipe R7: no vscode, no filesystem, no clock.
 *
 * Two rules shape the parsing, and both come from what a directive IS:
 *
 * 1. **A directive constrains WHICH worker, not what it does.** The main agent
 *    still writes the child's task — unless the user wrote one after the
 *    mention, which becomes the directive's `for:` text. So the parser is
 *    generous about the target and keeps the rest verbatim.
 * 2. **The host never acts on free text.** Only chips and mentions are
 *    directives (§6.8 point 2); a sentence naming a provider is something the
 *    MAIN AGENT may match against its roster, not something parsed here.
 */

import { ACP_PROVIDERS, type AcpProvider } from "./acp-backend";
import type { EffortLevel } from "./acp";
import { EFFORT_ORDER, isPermissionProfile, type PermissionProfile } from "./target-eligibility";

/** How hard a directive binds. `forbid` is the composer's "no subagents". */
export type DirectiveStrength = "must" | "prefer" | "forbid";

export interface SubagentDirective {
  /** Stable within one message, so a turn footer can say which was ignored. */
  id: string;
  strength: DirectiveStrength;
  provider?: AcpProvider;
  model?: string;
  effort?: EffortLevel;
  profile?: PermissionProfile;
  /** A named role, used as a template for tone and scope. */
  role?: string;
  /** What the user wants this worker used FOR, if they said. */
  task?: string;
}

/** The XML block appended to the prompt (§6.8). */
export const DIRECTIVE_BLOCK_TAG = "companions-subagent-directives";

const isProvider = (value: string): value is AcpProvider =>
  (ACP_PROVIDERS as readonly string[]).includes(value);

const isEffort = (value: string): value is EffortLevel =>
  (EFFORT_ORDER as readonly string[]).includes(value);

/**
 * The mention forms §6.8 lists, as one expression.
 *
 * `@subagent` alone is a directive too — "you may delegate, you pick" — so the
 * target part is optional. `@@` is the shortcut that jumps straight to the
 * Subagents section of the popover and expands to the same thing.
 */
const MENTION = new RegExp(
  String.raw`(?:^|\s)@{1,2}(subagent|role)` // @subagent, @@subagent, @role
  + String.raw`(?::([A-Za-z0-9._\-]+))?` // :gemini  or  :inspector
  + String.raw`(?:\/([A-Za-z0-9._\-:]+))?` // /model-id
  + String.raw`((?:\s+\w+:[A-Za-z0-9._\-]+)*)`, // effort:low profile:read-only
  "g",
);

/** `effort:low profile:scoped-edit` → { effort, profile }. */
function parseOptions(raw: string): Pick<SubagentDirective, "effort" | "profile"> {
  const out: Pick<SubagentDirective, "effort" | "profile"> = {};
  for (const match of raw.matchAll(/(\w+):([A-Za-z0-9._\-]+)/g)) {
    const key = match[1].toLowerCase();
    const value = match[2];
    // An unrecognised key or value is DROPPED, not an error: a typo in the
    // composer must not block a send, and the chip shows what was understood.
    if (key === "effort" && isEffort(value)) out.effort = value;
    if (key === "profile" && isPermissionProfile(value)) out.profile = value;
  }
  return out;
}

export interface ParsedComposerText {
  directives: SubagentDirective[];
  /** The message with the mention tokens removed, whitespace tidied. */
  text: string;
}

/**
 * Read the directives out of composer text.
 *
 * `@subagent:none` is the "no subagents for this message" form and produces a
 * single `forbid` directive — the host then refuses spawns during that turn
 * with `forbidden-by-user`, so the instruction is ENFORCED rather than merely
 * requested in a prompt.
 */
export function parseSubagentMentions(input: string): ParsedComposerText {
  const directives: SubagentDirective[] = [];
  let index = 0;
  const text = (input ?? "").replace(MENTION, (whole, kind: string, target?: string, model?: string, options?: string) => {
    const leading = /^\s/.test(whole) ? " " : "";
    index += 1;
    const id = `d${index}`;
    const opts = parseOptions(options ?? "");

    if (kind === "role") {
      // `@role` with no name is not a directive — there is no role to use.
      if (!target) { index -= 1; return whole; }
      directives.push({ id, strength: "must", role: target, ...opts });
      return leading;
    }
    if (target && target.toLowerCase() === "none") {
      directives.push({ id, strength: "forbid" });
      return leading;
    }
    if (target && !isProvider(target)) {
      // A word we cannot resolve to a companion is left in the text: it is
      // more likely an email address or a handle than a directive, and
      // swallowing it would eat the user's own words.
      index -= 1;
      return whole;
    }
    directives.push({
      id,
      strength: target ? "must" : "prefer",
      ...(target && isProvider(target) ? { provider: target } : {}),
      ...(model ? { model } : {}),
      ...opts,
    });
    return leading;
  });
  return { directives, text: text.replace(/[ \t]{2,}/g, " ").trim() };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Serialise directives into the block the prompt carries.
 *
 * A `forbid` directive collapses the whole block to the self-closing form: it
 * is about the message, not about one worker, and mixing it with targets would
 * be a contradiction the model has to resolve.
 */
export function renderDirectiveBlock(directives: readonly SubagentDirective[]): string {
  if (!directives.length) return "";
  if (directives.some((directive) => directive.strength === "forbid")) {
    return `<${DIRECTIVE_BLOCK_TAG} mode="forbid"/>`;
  }
  const lines = [`<${DIRECTIVE_BLOCK_TAG}>`];
  for (const directive of directives) {
    const attributes = [
      `id="${escapeAttribute(directive.id)}"`,
      `strength="${directive.strength}"`,
      ...(directive.provider ? [`provider="${directive.provider}"`] : []),
      ...(directive.model ? [`model="${escapeAttribute(directive.model)}"`] : []),
      ...(directive.effort ? [`effort="${directive.effort}"`] : []),
      ...(directive.profile ? [`profile="${directive.profile}"`] : []),
      ...(directive.role ? [`role="${escapeAttribute(directive.role)}"`] : []),
    ].join(" ");
    if (directive.task?.trim()) {
      lines.push(`  <directive ${attributes}>`);
      lines.push(`    for: ${directive.task.trim()}`);
      lines.push("  </directive>");
    } else {
      lines.push(`  <directive ${attributes}/>`);
    }
  }
  lines.push(`</${DIRECTIVE_BLOCK_TAG}>`);
  return lines.join("\n");
}

export interface PeeledDirectives {
  directives: SubagentDirective[];
  /** The message with the block removed, so a restore shows chips, not XML. */
  text: string;
  forbid: boolean;
}

/**
 * Peel a directive block back out of a stored prompt (§6.8 "Restore").
 *
 * Same approach as `parseAttachmentContext` and friends: a reopened session
 * must show chips, not the XML the host appended on the way out.
 */
export function peelDirectiveBlock(prompt: string): PeeledDirectives {
  const forbidMatch = new RegExp(`<${DIRECTIVE_BLOCK_TAG}\\s+mode="forbid"\\s*/>`).exec(prompt ?? "");
  if (forbidMatch) {
    return {
      directives: [{ id: "d1", strength: "forbid" }],
      text: (prompt ?? "").replace(forbidMatch[0], "").trim(),
      forbid: true,
    };
  }
  const block = new RegExp(`<${DIRECTIVE_BLOCK_TAG}>([\\s\\S]*?)</${DIRECTIVE_BLOCK_TAG}>`).exec(prompt ?? "");
  if (!block) return { directives: [], text: prompt ?? "", forbid: false };

  const directives: SubagentDirective[] = [];
  for (const entry of block[1].matchAll(/<directive\s([^>/]*?)(?:\/>|>([\s\S]*?)<\/directive>)/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of entry[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attributes.set(attribute[1], unescapeAttribute(attribute[2]));
    }
    const id = attributes.get("id");
    if (!id) continue;
    const provider = attributes.get("provider");
    const effort = attributes.get("effort");
    const profile = attributes.get("profile");
    const body = (entry[2] ?? "").replace(/^\s*for:\s*/m, "").trim();
    const strength = attributes.get("strength");
    directives.push({
      id,
      strength: strength === "prefer" || strength === "forbid" ? strength : "must",
      ...(provider && isProvider(provider) ? { provider } : {}),
      ...(attributes.get("model") ? { model: attributes.get("model")! } : {}),
      ...(effort && isEffort(effort) ? { effort } : {}),
      ...(profile && isPermissionProfile(profile) ? { profile } : {}),
      ...(attributes.get("role") ? { role: attributes.get("role")! } : {}),
      ...(body ? { task: body } : {}),
    });
  }
  return { directives, text: (prompt ?? "").replace(block[0], "").trim(), forbid: false };
}

/** The chip label a directive renders as, e.g. `⟢ Gemini · m-fast · low`. */
export function directiveChipLabel(
  directive: SubagentDirective,
  providerName: (provider: AcpProvider) => string = (provider) => provider,
): string {
  if (directive.strength === "forbid") return "⟢ none";
  const parts = [
    directive.role
      ? directive.role
      : directive.provider
        ? providerName(directive.provider)
        : "any companion",
    directive.model,
    directive.effort,
  ].filter(Boolean);
  return `⟢ ${parts.join(" · ")}`;
}

export type DirectiveValidation =
  | { ok: true }
  | { ok: false; reason: string; fix: "log-in" | "enable-in-roster" | "pick-another-model" | "none" };

/**
 * Can this directive still be honoured?
 *
 * Called before a send (§6.8 "Validation before send"), so a chip whose target
 * became ineligible turns red and blocks the send with a fix action rather than
 * failing halfway through a turn.
 */
export function validateDirective(
  directive: SubagentDirective,
  world: {
    usable: readonly AcpProvider[];
    connected: readonly AcpProvider[];
    enabled: (provider: AcpProvider) => boolean;
    knownRoles: readonly string[];
    knownModels: (provider: AcpProvider) => readonly string[];
    modelsChecked: (provider: AcpProvider) => boolean;
  },
): DirectiveValidation {
  if (directive.strength === "forbid") return { ok: true };
  if (directive.role && !world.knownRoles.includes(directive.role)) {
    return { ok: false, reason: `There is no role called ${directive.role}.`, fix: "none" };
  }
  const provider = directive.provider;
  if (!provider) return { ok: true };
  if (!world.usable.includes(provider)) {
    return world.connected.includes(provider)
      ? { ok: false, reason: `${provider} needs a login.`, fix: "log-in" }
      : { ok: false, reason: `${provider} is not connected.`, fix: "none" };
  }
  if (!world.enabled(provider)) {
    return { ok: false, reason: `${provider} is turned off for subagents.`, fix: "enable-in-roster" };
  }
  if (directive.model) {
    // An unwarmed cache is not evidence that the model is gone — the same rule
    // eligibility applies. Blocking a send on it would be a guess.
    if (world.modelsChecked(provider) && !world.knownModels(provider).includes(directive.model)) {
      return {
        ok: false,
        reason: `${provider} has no model ${directive.model}.`,
        fix: "pick-another-model",
      };
    }
  }
  return { ok: true };
}

/**
 * Directives the turn did not honour (§6.8 "Directive ignored").
 *
 * Only `must` counts: `prefer` is advice, and flagging it would train the user
 * to ignore the footer. The host knows whether a matching spawn happened,
 * which is what makes this checkable at all rather than a guess about intent.
 */
export function unfollowedDirectives(
  directives: readonly SubagentDirective[],
  spawned: readonly { provider: AcpProvider; model?: string; role?: string }[],
): SubagentDirective[] {
  return directives.filter((directive) => {
    if (directive.strength !== "must") return false;
    return !spawned.some((spawn) => {
      if (directive.role) return spawn.role === directive.role;
      if (directive.provider && spawn.provider !== directive.provider) return false;
      if (directive.model && spawn.model !== directive.model) return false;
      return true;
    });
  });
}
