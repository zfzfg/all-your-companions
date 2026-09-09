import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESET,
  findCrewPreset,
  loadCrewPresets,
  parseCrewPreset,
} from "../src/crew-preset";

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
