/**
 * The write half of Settings → Agents & Crew.
 *
 * The load-bearing claim of this module is that anything it writes, the
 * runtime reads back unchanged — a settings page that says "saved" over a file
 * meaning something else is the same quiet lie as a reviewer secretly running
 * the implementer's model. So most of these tests are round trips through the
 * REAL parser, not assertions about the text.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. Prose survives verbatim, including the characters that break naive YAML
 *      quoting: colons, `#`, both quote species, and paragraph breaks
 *   2. Provider, model, effort, mode, scope, budget and permissions round-trip
 *   3. A model the provider does not carry is refused, and an unwarmed cache
 *      is NOT treated as "the model is wrong"
 *   4. A name that is not [a-z0-9-] is refused before anything is written
 *   5. A duplicate name in the same scope is refused, but re-saving under the
 *      same name (an edit) is not
 *   6. when_to_use is required — a role nobody can place is not a role
 *   7. An unparseable permission line is refused, naming the line
 *   8. A flow round-trips its role ORDER, verify, cadence and parallel flag
 *   9. A flow naming a role that does not exist is refused
 */
import { describe, expect, it } from "vitest";
import {
  presetToDraft,
  roleToDraft,
  serializeAgentRole,
  serializeCrewFlow,
  validateAgentRoleDraft,
  validateCrewFlowDraft,
  type AgentRoleDraft,
} from "../src/agent-role-write";
import { parseAgentRole, parseFrontmatter } from "../src/agent-roles";
import { parseCrewPreset } from "../src/crew-preset";
import type { AcpProvider } from "../src/acp-backend";

const PROVIDERS: AcpProvider[] = ["grok", "codex", "claude", "gemini"];

function draft(over: Partial<AgentRoleDraft> = {}): AgentRoleDraft {
  return {
    name: "auditor",
    provider: "claude",
    whenToUse: "Checking a finished change against its acceptance criterion.",
    ...over,
  };
}

function save(over: Partial<AgentRoleDraft> = {}, context: Parameters<typeof validateAgentRoleDraft>[1] = { providers: PROVIDERS }) {
  return validateAgentRoleDraft(draft(over), context);
}

/** Round-trip helper: what does the runtime actually see for this draft? */
function reread(over: Partial<AgentRoleDraft> = {}) {
  const text = serializeAgentRole(draft(over));
  const parsed = parseAgentRole({ path: ".companions/agents/auditor.md", stem: "auditor", text });
  expect(parsed.problem, parsed.problem?.message).toBeUndefined();
  return parsed.role!;
}

describe("serializeAgentRole → parseAgentRole", () => {
  it("carries prose through the characters that break naive YAML quoting", () => {
    // Requirement 1. Every one of these is a real thing to write in a role
    // note, and every one of them breaks a `key: "value"` writer.
    const prose = `Reviewing: don't "fix" it — say what is wrong.\n\nUse #tags freely: they are not comments here.`;
    const role = reread({ whenNotToUse: prose, systemPreamble: prose, whenToUse: prose });
    expect(role.whenToUse).toBe(prose);
    expect(role.whenNotToUse).toBe(prose);
    expect(role.systemPreamble).toBe(prose);
  });

  it("round-trips provider, model, effort, mode, scope, budget and permissions", () => {
    // Requirement 2 — the whole configurable surface in one pass, because a
    // per-field test would not catch a field that silently swallows the next.
    const role = reread({
      provider: "gemini",
      model: "gemini-3-pro",
      effort: "high",
      mode: "plan",
      scope: ["src/**", "test/**"],
      budget: { toolCalls: 40, tokens: 120000 },
      permissions: ["allow edit src/**", "deny execute rm"],
      preferDifferentProvider: true,
    });
    expect(role.provider).toBe("gemini");
    expect(role.model).toBe("gemini-3-pro");
    expect(role.effort).toBe("high");
    expect(role.mode).toBe("plan");
    expect(role.scope).toEqual(["src/**", "test/**"]);
    expect(role.budget).toEqual({ toolCalls: 40, tokens: 120000 });
    expect(role.permissions).toEqual([
      { action: "allow", kind: "edit", pathGlob: "src/**" },
      { action: "deny", kind: "execute", commandPrefix: "rm" },
    ]);
    expect(role.preferDifferentProvider).toBe(true);
  });

  it("does not write a money budget from the settings draft", () => {
    const text = serializeAgentRole(draft({ budget: { toolCalls: 8, usd: 9 } }));
    expect(text).toContain("tool_calls: 8");
    expect(text).not.toContain("usd:");
  });

  it("omits every field the draft left empty rather than writing blanks", () => {
    const text = serializeAgentRole(draft());
    expect(text).not.toContain("model:");
    expect(text).not.toContain("budget:");
    expect(text).not.toContain("effort:");
    const role = reread();
    expect(role.model).toBeUndefined();
    expect(role.budget).toBeUndefined();
  });

  it("round-trips a scope glob containing a space and a comma", () => {
    // Both are the separators a lazier comparison or an inline `[a, b]` list
    // would split on, silently turning one glob into two.
    const scope = ["src/my folder/**", "docs/{a,b}/**"];
    const role = reread({ scope });
    expect(role.scope).toEqual(scope);
    expect(save({ scope }).ok).toBe(true);
  });

  it("survives a full loop back out through roleToDraft", () => {
    const first = reread({ model: "claude-opus-5", scope: ["src/**"], whenNotToUse: "On its own work." });
    const second = reread(roleToDraft(first));
    expect(second.model).toBe(first.model);
    expect(second.scope).toEqual(first.scope);
    expect(second.whenNotToUse).toBe(first.whenNotToUse);
    expect(second.whenToUse).toBe(first.whenToUse);
  });
});

describe("validateAgentRoleDraft", () => {
  it("refuses a model the provider does not carry", () => {
    // Requirement 3, first half. This is the "quality illusion" gate: a
    // reviewer the user believes is a second opinion, quietly on the default.
    const result = save(
      { provider: "claude", model: "gpt-9" },
      { providers: PROVIDERS, knownModels: { claude: [{ modelId: "claude-opus-5" }] }, providerLabel: () => "Claude" },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("gpt-9");
    expect(result.ok === false && result.error).toContain("claude-opus-5");
  });

  it("accepts an unverifiable model when the cache is not warmed", () => {
    // Requirement 3, second half — "we do not know the model list" is not
    // "the model is wrong", and refusing here would brick a cold start.
    const result = save({ provider: "claude", model: "claude-opus-5" }, { providers: PROVIDERS, knownModels: { claude: [] } });
    expect(result.ok).toBe(true);
  });

  it("refuses a name that is not a slash-command name", () => {
    for (const name of ["-lead", "my role", "réviseur", "lead-", ""]) {
      const result = save({ name });
      expect(result.ok, name).toBe(false);
    }
  });

  it("accepts a name typed with capitals and stores it lowercased", () => {
    // Not a refusal case: `/agent` is lowercase, and rejecting "Reviewer"
    // would be a spelling lesson rather than a validation.
    const result = save({ name: "Reviewer" });
    expect(result.ok && result.value.name).toBe("reviewer");
  });

  it("refuses a duplicate name but allows re-saving the role being edited", () => {
    const context = { providers: PROVIDERS, existingNames: ["auditor", "planner"] };
    expect(save({}, context).ok).toBe(false);
    expect(save({}, { ...context, originalName: "auditor" }).ok).toBe(true);
  });

  it("refuses a role with nothing said about when to use it", () => {
    const result = save({ whenToUse: "   " });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("when to use");
  });

  it("refuses an unparseable permission line and names it", () => {
    const result = save({ permissions: ["allow edit src/**", "sometimes maybe"] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("sometimes maybe");
  });

  it("refuses a provider this build cannot run", () => {
    expect(save({ provider: "mistral" }).ok).toBe(false);
  });

  it("returns the parsed role, not just the text, so the host need not re-parse", () => {
    const result = save({ mode: "plan" });
    expect(result.ok && result.value.mode).toBe("plan");
    expect(result.ok && result.text.startsWith("---")).toBe(true);
  });
});

describe("crew flows", () => {
  it("round-trips role order, verify, cadence and the parallel flag", () => {
    // Requirement 8. Order is the point: it is what decides an ambiguous
    // assignment now that the pool is the flow's.
    const text = serializeCrewFlow({
      name: "audit",
      roles: ["planner", "implementer", "reviewer"],
      verify: "npm test -- --run",
      reviewEvery: 2,
      parallel: true,
      notes: "Two eyes on everything.",
    });
    const parsed = parseCrewPreset({ path: ".companions/crews/audit.md", stem: "audit", text });
    expect(parsed.problem).toBeUndefined();
    expect(parsed.preset!.roles).toEqual(["planner", "implementer", "reviewer"]);
    expect(parsed.preset!.verify).toBe("npm test -- --run");
    expect(parsed.preset!.reviewEvery).toBe(2);
    expect(parsed.preset!.parallel).toBe(true);
    expect(parsed.preset!.body).toBe("Two eyes on everything.");
  });

  it("refuses a flow that names a role which does not exist", () => {
    const result = validateCrewFlowDraft(
      { name: "audit", roles: ["planner", "ghost"] },
      { roleNames: ["planner", "reviewer"] },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("ghost");
  });

  it("accepts a flow with no roles at all — that means every role", () => {
    const result = validateCrewFlowDraft({ name: "audit" }, { roleNames: ["planner"] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.roles).toEqual([]);
  });

  it("survives a loop back out through presetToDraft", () => {
    const first = validateCrewFlowDraft(
      { name: "audit", roles: ["planner"], verify: "npm test", reviewEvery: 3 },
      { roleNames: ["planner"] },
    );
    expect(first.ok).toBe(true);
    const second = validateCrewFlowDraft(presetToDraft(first.ok ? first.value : ({} as never)), {
      roleNames: ["planner"],
    });
    expect(second.ok && second.value.reviewEvery).toBe(3);
    expect(second.ok && second.value.verify).toBe("npm test");
  });
});

describe("block scalars in the frontmatter parser", () => {
  it("keeps line breaks for `|` and folds them for `>`", () => {
    const front = parseFrontmatter(
      ["---", "kept: |", "  one", "  two", "folded: >", "  one", "  two", "after: yes", "---", ""].join("\n"),
    );
    expect(front.error).toBeUndefined();
    expect(front.fields.kept).toBe("one\ntwo");
    expect(front.fields.folded).toBe("one two");
    // The key AFTER a block must still be read — the block consumer has to
    // stop at the dedent rather than swallowing the rest of the frontmatter.
    expect(front.fields.after).toBe("yes");
  });

  it("keeps a paragraph break inside a block and trims the trailing blank", () => {
    const front = parseFrontmatter(["---", "note: |", "  one", "", "  two", "", "next: 1", "---", ""].join("\n"));
    expect(front.fields.note).toBe("one\n\ntwo");
    expect(front.fields.next).toBe(1);
  });
});
