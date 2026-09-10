import { describe, expect, it } from "vitest";
import {
  BUILTIN_IDEA_TO_DONE_PRESET,
  BUILTIN_PRESET,
  findCrewPreset,
  loadCrewPresets,
  parseCrewPreset,
  presetReviewRole,
  presetRoles,
  presetToStageGraph,
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
    expect(set.presets.map((p) => p.name).sort()).toEqual(["default", "idea-to-done"]);
    expect(set.presets.find((p) => p.name === "default")).toEqual({ ...BUILTIN_PRESET });
    expect(set.presets.find((p) => p.name === "idea-to-done")?.source).toBe("builtin");
    expect(set.problems).toEqual([]);
  });

  it("does not rewrite a project flow without a stages block, and still offers idea-to-done", () => {
    const set = loadCrewPresets([{
      path: ".companions/crews/fast.md",
      stem: "fast",
      text: "---\nname: fast\nroles: [implementer]\n---\nGo.",
    }]);
    expect(set.presets.find((p) => p.name === "fast")?.stages).toBeUndefined();
    expect(set.presets.find((p) => p.name === "idea-to-done")?.name).toBe("idea-to-done");
    expect(set.presets.find((p) => p.name === "default")).toBeUndefined();
  });

  it("skips duplicates and keeps the first", () => {
    const file = (n: string, extra: string) => ({
      path: `.companions/crews/${n}.md`,
      stem: n,
      text: `---\nname: ship\n${extra}\n---\n`,
    });
    const set = loadCrewPresets([file("a", "verify: npm test"), file("b", "verify: cargo test")]);
    expect(set.presets.filter((p) => p.name === "ship")).toHaveLength(1);
    expect(set.presets.find((p) => p.name === "ship")?.verify).toBe("npm test");
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

describe("stages block and presetToStageGraph", () => {
  it("parses a companions:stages block and extra frontmatter keys", () => {
    const { preset, problem } = parseCrewPreset({
      path: ".companions/crews/ship.md",
      stem: "ship",
      text: [
        "---",
        "name: ship",
        "title: Ship it",
        "when_to_use: Small changes.",
        "roles: [planner, implementer]",
        "default_gate: manual",
        "worktree: true",
        "---",
        "Go.",
        "",
        "<!-- companions:stages v1 -->",
        "```json",
        JSON.stringify({
          schemaVersion: 1,
          name: "ship",
          title: "Ship it",
          whenToUse: "Small changes.",
          defaults: { gate: "manual", worktree: true, allowSubagents: false },
          roles: { planner: { ref: "planner" }, implementer: { ref: "implementer" } },
          stages: [
            {
              id: "plan",
              title: "Plan",
              role: "planner",
              profile: "read-only",
              contract: { $ref: "#/contracts/plan" },
              next: [{ to: "$done" }],
            },
          ],
          contracts: {
            plan: {
              purpose: "Plan.",
              inputs: [{ from: "idea", as: "Goal" }],
              output: { sections: ["Summary"], resultBlock: { required: ["planSteps"] } },
            },
          },
          start: ["plan"],
        }),
        "```",
      ].join("\n"),
    });
    expect(problem).toBeUndefined();
    expect(preset?.title).toBe("Ship it");
    expect(preset?.worktree).toBe(true);
    expect(preset?.stages).toMatchObject({ name: "ship" });
    const graph = presetToStageGraph(preset!);
    expect(graph.stages).toHaveLength(1);
    expect(graph.stages[0].id).toBe("plan");
  });

  it("converts a preset without a stages block into the default graph without rewriting it", () => {
    const { preset } = parseCrewPreset({
      path: ".companions/crews/legacy.md",
      stem: "legacy",
      text: "---\nname: legacy\nroles: [planner, implementer, reviewer, fixer]\nparallel: true\nverify: npm test\n---\nGo.",
    });
    expect(preset?.stages).toBeUndefined();
    const graph = presetToStageGraph(preset!);
    expect(graph.stages.map((s) => s.id)).toEqual(["plan", "implement", "review", "fix"]);
    expect(graph.stages.find((s) => s.id === "implement")?.strategy).toBe("per-plan-step");
    expect(graph.defaults.verify).toBe("npm test");
    expect(preset?.stages).toBeUndefined();
  });

  it("reports a broken stages block instead of half-applying it", () => {
    const { preset, problem } = parseCrewPreset({
      path: ".companions/crews/broken.md",
      stem: "broken",
      text: "---\nname: broken\n---\n<!-- companions:stages v1 -->\n```json\n{nope}\n```\n",
    });
    expect(preset).toBeUndefined();
    expect(problem?.message).toMatch(/not valid/);
  });

  it("the builtin idea-to-done preset converts to the shipped graph", () => {
    const graph = presetToStageGraph(BUILTIN_IDEA_TO_DONE_PRESET);
    expect(graph.name).toBe("idea-to-done");
    expect(graph.stages.find((s) => s.id === "clarify")?.enabled).toBe(false);
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
    const ship = set.presets.find((p) => p.name === "ship");
    expect(ship?.roles).toEqual(["reviewer"]);
    expect(ship?.source).toBe("project");
    expect(ship?.overrides).toBe("global");
  });

  it("still reports two files of the same scope claiming one name", () => {
    const set = loadCrewPresets([
      { path: ".companions/crews/a.md", stem: "a", text: "---\nname: dup\n---\n" },
      { path: ".companions/crews/b.md", stem: "b", text: "---\nname: dup\n---\n" },
    ]);
    expect(set.problems).toHaveLength(1);
    expect(set.presets.filter((p) => p.name === "dup")).toHaveLength(1);
  });
});
