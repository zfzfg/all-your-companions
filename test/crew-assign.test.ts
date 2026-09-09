import { describe, expect, it } from "vitest";
import { BUILTIN_ROLES, type AgentRole } from "../src/agent-roles";
import { assignStep, explicitRoleTag, stripRoleTag } from "../src/crew-assign";

const roles = BUILTIN_ROLES as unknown as AgentRole[];

describe("assignStep (18.4)", () => {
  it("ranks an explicit [role] tag first", () => {
    const a = assignStep({ title: "[reviewer] look at src/a.ts", files: ["src/a.ts"] }, roles);
    expect(a).toEqual({
      kind: "assigned",
      role: "reviewer",
      why: "explicit tag [reviewer] in the step title",
    });
  });

  it("uses path globs from the role scope before signal words", () => {
    const scoped: AgentRole[] = [
      { ...roles.find((r) => r.name === "implementer")!, scope: ["src/**"] },
      { ...roles.find((r) => r.name === "reviewer")!, scope: ["docs/**"] },
    ];
    const a = assignStep({ title: "touch the code", files: ["src/a.ts"] }, scoped);
    expect(a.kind).toBe("assigned");
    if (a.kind === "assigned") expect(a.role).toBe("implementer");
  });

  it("falls through to when_to_use signal words", () => {
    const a = assignStep({ title: "Review the finished work against the briefing", files: [] }, roles);
    expect(a.kind).toBe("assigned");
    if (a.kind === "assigned") expect(a.role).toBe("reviewer");
  });

  it("is ambiguous when two roles match, never guesses", () => {
    const both: AgentRole[] = [
      { ...roles.find((r) => r.name === "implementer")!, scope: ["src/**"] },
      { ...roles.find((r) => r.name === "reviewer")!, scope: ["src/**"] },
    ];
    const a = assignStep({ title: "edit src", files: ["src/a.ts"] }, both);
    expect(a.kind).toBe("ambiguous");
    if (a.kind === "ambiguous") {
      expect(a.candidates.sort()).toEqual(["implementer", "reviewer"]);
    }
  });

  it("returns none when nothing matches", () => {
    const a = assignStep({ title: "xyzzy", files: [] }, roles);
    expect(a.kind).toBe("none");
  });

  it("is deterministic — same input, same assignment", () => {
    const step = { title: "Turning a vague goal into an ordered list of concrete steps", files: [] as string[] };
    expect(assignStep(step, roles)).toEqual(assignStep(step, roles));
  });

  it("a rephrased title with the same [role] tag keeps the role (id is not the key)", () => {
    const a = assignStep({ title: "[implementer] write the parser", files: [] }, roles);
    const b = assignStep({ title: "[implementer] write the parser, more carefully", files: [] }, roles);
    expect(a.kind).toBe("assigned");
    expect(b.kind).toBe("assigned");
    if (a.kind === "assigned" && b.kind === "assigned") expect(a.role).toBe(b.role);
  });

  it("strips the tag from the title humans see", () => {
    expect(explicitRoleTag("[fixer] npm test is red")).toBe("fixer");
    expect(stripRoleTag("[fixer] npm test is red")).toBe("npm test is red");
  });

  it("an unknown tag is none, not a guess", () => {
    const a = assignStep({ title: "[wizard] cast fireball", files: [] }, roles);
    expect(a.kind).toBe("none");
  });
});
