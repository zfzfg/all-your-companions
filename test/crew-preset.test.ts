import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESET,
  findCrewPreset,
  loadCrewPresets,
  parseCrewPreset,
  presetReviewRole,
  presetRoles,
} from "../src/crew-preset";
import { loadAgentRoles } from "../src/agent-roles";

describe("parseCrewPreset", () => {
  it("reads name, roles, verify and review_every from frontmatter", () => {
    const { preset, problem } = parseCrewPreset({
      path: ".companions/crews/ship.md",
      stem: "ship",
      text: [
        "---",
        "name: ship",
        "roles: [planner, implementer, reviewer]",
        "verify: npm test",
        "review_every: 3",
        "parallel: true",
        "---",
        "Plan, type, review.",
      ].join("\n"),
    });
    expect(problem).toBeUndefined();
    expect(preset).toMatchObject({
      name: "ship",
      roles: ["planner", "implementer", "reviewer"],
      verify: "npm test",
      reviewEvery: 3,
      parallel: true,
      body: "Plan, type, review.",
      source: "project",
    });
  });

  it("reports a missing frontmatter block and an invalid name", () => {
    expect(parseCrewPreset({ path: "x.md", stem: "x", text: "no fence" }).problem?.message).toMatch(/frontmatter/);
    expect(parseCrewPreset({
      path: "x.md",
      stem: "x",
      text: "---\nname: NOPE\n---\n",
    }).problem?.message).toMatch(/not \[a-z0-9-\]/);
  });
});

describe("loadCrewPresets", () => {
  it("falls back to the built-in when the directory is empty", () => {
    const set = loadCrewPresets([]);
    expect(set.presets).toEqual([{ ...BUILTIN_PRESET }]);
    expect(set.problems).toEqual([]);
  });

  it("skips duplicates and keeps the first", () => {
    const file = (n: string, extra: string) => ({
      path: `.companions/crews/${n}.md`,
      stem: n,
      text: `---\nname: ship\n${extra}\n---\n`,
    });
    const set = loadCrewPresets([file("a", "verify: npm test"), file("b", "verify: cargo test")]);
    expect(set.presets).toHaveLength(1);
    expect(set.presets[0].verify).toBe("npm test");
    expect(set.problems[0].message).toMatch(/duplicate/);
  });
});

describe("findCrewPreset", () => {
  it("resolves by name, default, then first", () => {
    const set = loadCrewPresets([{
      path: ".companions/crews/fast.md",
      stem: "fast",
      text: "---\nname: fast\nroles: [implementer]\n---\n",
    }]);
    expect(findCrewPreset(set, "fast").name).toBe("fast");
    expect(findCrewPreset(set, "missing").name).toBe("fast");
    expect(findCrewPreset(set, undefined).name).toBe("fast");
  });
});

/**
 * `roles:` used to be parsed and then ignored by the run loop, which made it a
 * decoration: a flow saying `roles: [planner, implementer]` still let a
 * `researcher` pick up a step. These cover the pool that fixes that.
 */
describe("presetRoles", () => {
  const set = loadAgentRoles([]);

  it("restricts the pool to the flow's roles, in the flow's order", () => {
    const { roles, problems } = presetRoles({ name: "ship", roles: ["reviewer", "planner"] }, set);
    expect(roles.map((role) => role.name)).toEqual(["reviewer", "planner"]);
    expect(problems).toEqual([]);
  });

  it("reads an empty list as EVERY role, not as no roles", () => {
    // The distinction matters: "no roles" would assign nothing and skip the
    // whole run, and an absent `roles:` is the shipped default.
    const { roles } = presetRoles({ name: "ship", roles: [] }, set);
    expect(roles.map((role) => role.name)).toEqual(set.roles.map((role) => role.name));
  });

  it("reports a role that does not exist rather than quietly shrinking the pool", () => {
    const { roles, problems } = presetRoles({ name: "ship", roles: ["planner", "ghost"] }, set);
    expect(roles.map((role) => role.name)).toEqual(["planner"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("ghost");
  });

  it("falls back to every role when the flow names only unknown ones", () => {
    // Otherwise a typo turns into "assign nothing", which skips every step.
    const { roles, problems } = presetRoles({ name: "ship", roles: ["ghost"] }, set);
    expect(roles.length).toBe(set.roles.length);
    expect(problems).toHaveLength(1);
  });
});

describe("presetReviewRole", () => {
  const set = loadAgentRoles([]);

  it("prefers the flow's own reviewer-ish role", () => {
    const custom = loadAgentRoles([
      { path: ".companions/agents/code-reviewer.md", stem: "code-reviewer", text: "---\nprovider: grok\nwhen_to_use: x\n---\n" },
    ]);
    expect(presetReviewRole({ roles: ["implementer", "code-reviewer"] }, custom)).toBe("code-reviewer");
  });

  it("falls back to the conventional reviewer", () => {
    expect(presetReviewRole({ roles: ["implementer"] }, set)).toBe("reviewer");
  });

  it("is undefined when no review role is loaded at all", () => {
    const only = { roles: [{ name: "implementer" }], problems: [] } as never;
    expect(presetReviewRole({ roles: [] }, only)).toBeUndefined();
  });
});

/** Flows follow the same three-scope narrowing as roles. */
describe("crew flow scopes", () => {
  it("lets a project flow replace a global one without a conflict", () => {
    const set = loadCrewPresets([
      { path: "~/.companions/crews/ship.md", stem: "ship", scope: "global", text: "---\nname: ship\nroles: [planner]\n---\n" },
      { path: ".companions/crews/ship.md", stem: "ship", text: "---\nname: ship\nroles: [reviewer]\n---\n" },
    ]);
    expect(set.problems).toEqual([]);
    expect(set.presets).toHaveLength(1);
    expect(set.presets[0].roles).toEqual(["reviewer"]);
    expect(set.presets[0].source).toBe("project");
    expect(set.presets[0].overrides).toBe("global");
  });

  it("still reports two files of the same scope claiming one name", () => {
    const set = loadCrewPresets([
      { path: ".companions/crews/a.md", stem: "a", text: "---\nname: dup\n---\n" },
      { path: ".companions/crews/b.md", stem: "b", text: "---\nname: dup\n---\n" },
    ]);
    expect(set.problems).toHaveLength(1);
    expect(set.presets).toHaveLength(1);
  });
});
