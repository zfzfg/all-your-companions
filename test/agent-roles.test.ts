// AP-10 role registry: frontmatter edge cases, the five shipped fallbacks,
// name/provider/effort/mode rejection, and the model-against-provider check
// that keeps a "second opinion" from quietly being the same model again.
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROLES,
  findAgentRole,
  isValidRoleName,
  loadAgentRoles,
  parseAgentRole,
  parseFrontmatter,
  validateRoleModel,
  type AgentRoleFile,
} from "../src/agent-roles";

function file(stem: string, text: string): AgentRoleFile {
  return { path: `.companions/agents/${stem}.md`, stem, text };
}

describe("frontmatter subset", () => {
  it("reads scalars, inline arrays, block lists and one nested map", () => {
    const { fields, body } = parseFrontmatter(
      [
        "---",
        "name: reviewer",
        "provider: claude",
        'model: "claude-opus-5"',
        "scope: [src/**, test/**]",
        "extra_list:",
        "  - one",
        "  - two",
        "budget:",
        "  tool_calls: 20",
        "  usd: 1.5",
        "---",
        "",
        "Prose body.",
      ].join("\n"),
    );
    expect(fields.name).toBe("reviewer");
    expect(fields.model).toBe("claude-opus-5");
    expect(fields.scope).toEqual(["src/**", "test/**"]);
    expect(fields.extra_list).toEqual(["one", "two"]);
    expect(fields.budget).toEqual({ tool_calls: 20, usd: 1.5 });
    expect(body).toBe("Prose body.");
  });

  it("reports a missing frontmatter block rather than guessing", () => {
    expect(parseFrontmatter("just prose").error).toMatch(/frontmatter/);
  });

  it("handles CRLF and a trailing newline-less file", () => {
    const { fields } = parseFrontmatter("---\r\nname: fixer\r\nprovider: grok\r\n---");
    expect(fields).toEqual({ name: "fixer", provider: "grok" });
  });

  it("ignores comments and blank lines", () => {
    const { fields } = parseFrontmatter("---\n# a comment\n\nname: x\n---\n");
    expect(fields).toEqual({ name: "x" });
  });

  it("keeps a colon inside a quoted value", () => {
    const { fields } = parseFrontmatter('---\nwhen_to_use: "use when: it is late"\n---\n');
    expect(fields.when_to_use).toBe("use when: it is late");
  });
});

describe("role names", () => {
  it("accepts lowercase, digits and inner dashes", () => {
    expect(isValidRoleName("reviewer")).toBe(true);
    expect(isValidRoleName("fast-fixer2")).toBe(true);
  });

  it("rejects anything that would read as a flag or a path", () => {
    for (const bad of ["-reviewer", "reviewer-", "Reviewer", "rev iewer", "rev/iewer", ""]) {
      expect(isValidRoleName(bad)).toBe(false);
    }
  });
});

describe("parseAgentRole", () => {
  it("takes the prose body as when_to_use when the frontmatter omits it", () => {
    const { role } = parseAgentRole(file("scout", "---\nprovider: gemini\n---\n\nFinding things fast.\n"));
    expect(role?.name).toBe("scout");
    expect(role?.provider).toBe("gemini");
    expect(role?.whenToUse).toBe("Finding things fast.");
    expect(role?.source).toBe("project");
    expect(role?.path).toBe(".companions/agents/scout.md");
  });

  it("requires a provider", () => {
    const { problem } = parseAgentRole(file("x", "---\nwhen_to_use: a\n---\n"));
    expect(problem?.message).toMatch(/`provider:` is required/);
  });

  it("names an unknown provider instead of falling back", () => {
    const { problem } = parseAgentRole(file("x", "---\nprovider: openai\nwhen_to_use: a\n---\n"));
    expect(problem?.message).toMatch(/unknown provider `openai`/);
  });

  it("rejects an unknown effort and an unknown mode", () => {
    expect(parseAgentRole(file("x", "---\nprovider: claude\neffort: turbo\nwhen_to_use: a\n---\n")).problem?.message)
      .toMatch(/unknown effort `turbo`/);
    expect(parseAgentRole(file("x", "---\nprovider: claude\nmode: readonly\nwhen_to_use: a\n---\n")).problem?.message)
      .toMatch(/must be `agent` or `plan`/);
  });

  it("refuses a role with nothing saying when to use it", () => {
    const { problem } = parseAgentRole(file("x", "---\nprovider: claude\n---\n"));
    expect(problem?.message).toMatch(/when_to_use/);
  });

  it("keeps unknown keys out of the role without failing the file", () => {
    const { role } = parseAgentRole(
      file("x", "---\nprovider: claude\nwhen_to_use: a\npermissions: strict\n---\n"),
    );
    expect(role).toBeTruthy();
    expect(role as unknown as Record<string, unknown>).not.toHaveProperty("permissions");
  });
});

describe("loadAgentRoles", () => {
  it("ships five working roles when there is no .companions/agents at all", () => {
    const set = loadAgentRoles([]);
    expect(set.problems).toEqual([]);
    expect(set.roles.map((role) => role.name).sort())
      .toEqual(["fixer", "implementer", "planner", "researcher", "reviewer"]);
    for (const role of set.roles) {
      expect(role.source).toBe("builtin");
      expect(role.whenToUse.length).toBeGreaterThan(0);
      // A built-in must never name a model — see agent-roles.ts.
      expect(role.model).toBeUndefined();
    }
  });

  it("lets a project file replace a built-in of the same name outright", () => {
    const set = loadAgentRoles([
      file("reviewer", "---\nprovider: gemini\nmodel: gemini-3-flash\nwhen_to_use: cheap second pass\n---\n"),
    ]);
    const reviewer = findAgentRole(set, "reviewer");
    expect(reviewer?.source).toBe("project");
    expect(reviewer?.provider).toBe("gemini");
    expect(reviewer?.model).toBe("gemini-3-flash");
    // No merge: the built-in's preamble does not survive the override.
    expect(reviewer?.systemPreamble).toBeUndefined();
    expect(set.roles).toHaveLength(BUILTIN_ROLES.length);
  });

  it("reports a broken file and keeps the rest usable", () => {
    const set = loadAgentRoles([
      file("good", "---\nprovider: claude\nwhen_to_use: fine\n---\n"),
      file("bad", "no frontmatter here"),
    ]);
    expect(findAgentRole(set, "good")).toBeTruthy();
    expect(set.problems).toHaveLength(1);
    expect(set.problems[0].message).toMatch(/could not be read/);
  });

  it("reports a duplicate name and keeps the first file", () => {
    const set = loadAgentRoles([
      { path: "a/dup.md", stem: "dup", text: "---\nprovider: claude\nwhen_to_use: first\n---\n" },
      { path: "b/dup.md", stem: "dup", text: "---\nprovider: grok\nwhen_to_use: second\n---\n" },
    ]);
    expect(findAgentRole(set, "dup")?.whenToUse).toBe("first");
    expect(set.problems[0].message).toMatch(/defined twice/);
  });

  it("is a MAIN case: two roles, same provider, different models", () => {
    const set = loadAgentRoles([
      file("implementer", "---\nprovider: claude\nmodel: claude-haiku-4-5\nwhen_to_use: typing\n---\n"),
      file("reviewer", "---\nprovider: claude\nmodel: claude-opus-5\nwhen_to_use: judging\n---\n"),
    ]);
    expect(set.problems).toEqual([]);
    expect(findAgentRole(set, "implementer")?.provider).toBe("claude");
    expect(findAgentRole(set, "reviewer")?.provider).toBe("claude");
    expect(findAgentRole(set, "implementer")?.model)
      .not.toBe(findAgentRole(set, "reviewer")?.model);
  });

  it("lists roles in a stable order regardless of file order", () => {
    const a = loadAgentRoles([file("zeta", "---\nprovider: grok\nwhen_to_use: z\n---\n")]);
    const b = loadAgentRoles([file("zeta", "---\nprovider: grok\nwhen_to_use: z\n---\n")]);
    expect(a.roles.map((role) => role.name)).toEqual(b.roles.map((role) => role.name));
  });
});

describe("validateRoleModel", () => {
  const known = [{ modelId: "claude-opus-5" }, { modelId: "claude-haiku-4-5" }];

  it("passes a model the provider carries", () => {
    expect(validateRoleModel({ name: "r", provider: "claude", model: "claude-opus-5" }, known, "Claude"))
      .toEqual({ ok: true, checked: true });
  });

  it("rejects a model the provider does not carry, naming the alternatives", () => {
    const verdict = validateRoleModel({ name: "implementer", provider: "claude", model: "gpt-9" }, known, "Claude");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a rejection");
    expect(verdict.message).toContain("Role `implementer`");
    expect(verdict.message).toContain("Claude does not have a model `gpt-9`");
    expect(verdict.message).toContain("claude-haiku-4-5, claude-opus-5");
  });

  it("SKIPS the check on an unwarmed cache rather than rejecting every role", () => {
    expect(validateRoleModel({ name: "r", provider: "claude", model: "anything" }, [], "Claude"))
      .toEqual({ ok: true, checked: false });
    expect(validateRoleModel({ name: "r", provider: "claude", model: "anything" }, undefined, "Claude"))
      .toEqual({ ok: true, checked: false });
  });

  it("treats a placeholder entry with an empty modelId as no list at all", () => {
    expect(validateRoleModel({ name: "r", provider: "grok", model: "x" }, [{ modelId: "" }], "Grok"))
      .toEqual({ ok: true, checked: false });
  });

  it("passes a role with no model — empty means the provider default", () => {
    expect(validateRoleModel({ name: "r", provider: "grok" }, known, "Grok"))
      .toEqual({ ok: true, checked: false });
  });

  it("checks each half of a same-provider pair independently", () => {
    expect(validateRoleModel({ name: "a", provider: "claude", model: "claude-haiku-4-5" }, known, "Claude").ok).toBe(true);
    expect(validateRoleModel({ name: "b", provider: "claude", model: "claude-opus-5" }, known, "Claude").ok).toBe(true);
    expect(validateRoleModel({ name: "c", provider: "claude", model: "claude-opus-4" }, known, "Claude").ok).toBe(false);
  });
});

describe("preferDifferentProvider", () => {
  it("is set on the shipped reviewer and on nothing else", () => {
    const set = loadAgentRoles([]);
    const flagged = set.roles.filter((role) => role.preferDifferentProvider).map((role) => role.name);
    expect(flagged).toEqual(["reviewer"]);
  });

  it("can be declared by a project role", () => {
    const { role } = parseAgentRole(
      file("auditor", "---\nprovider: grok\nprefer_different_provider: true\nwhen_to_use: audit\n---\n"),
    );
    expect(role?.preferDifferentProvider).toBe(true);
  });

  it("is absent rather than false when not declared", () => {
    const { role } = parseAgentRole(file("plain", "---\nprovider: grok\nwhen_to_use: x\n---\n"));
    expect(role).not.toHaveProperty("preferDifferentProvider");
  });

  it("takes only a real boolean, not the string 'yes'", () => {
    const { role } = parseAgentRole(
      file("x", "---\nprovider: grok\nprefer_different_provider: yes\nwhen_to_use: x\n---\n"),
    );
    expect(role?.preferDifferentProvider).toBeUndefined();
  });
});
