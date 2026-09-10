import { describe, expect, it } from "vitest";
import { IDEA_TO_DONE, applyMaxFixerPasses } from "../src/workflow";
import { validateWorkflowDefinition } from "../src/workflow-validate";
import { readFileSync } from "node:fs";
import { parseCrewPreset, presetToStageGraph } from "../src/crew-preset";

const ROLES = ["planner", "implementer", "reviewer", "fixer", "clarifier", "inspector", "researcher"];

function ctx(over: Partial<Parameters<typeof validateWorkflowDefinition>[1]> = {}) {
  return { roleNames: ROLES, ...over };
}

describe("idea-to-done validates", () => {
  it("the in-code builtin passes all twelve rules", () => {
    const result = validateWorkflowDefinition(IDEA_TO_DONE, ctx());
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("the shipped Markdown file validates and matches the diagram", () => {
    const text = readFileSync(new URL("../resources/crews/idea-to-done.md", import.meta.url), "utf8");
    const { preset } = parseCrewPreset({ path: "resources/crews/idea-to-done.md", stem: "idea-to-done", text });
    const graph = presetToStageGraph(preset!);
    const result = validateWorkflowDefinition(graph, ctx());
    expect(result.valid).toBe(true);
    expect(graph.stages.map((s) => s.id)).toEqual(["clarify", "plan", "implement", "review", "fix"]);
  });
});

describe("the twelve rules", () => {
  it("rejects an unbounded cycle", () => {
    const def = structuredClone(IDEA_TO_DONE);
    const fix = def.stages.find((s) => s.id === "fix")!;
    delete fix.maxVisits;
    delete fix.onMaxVisits;
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Cycle/.test(e.message))).toBe(true);
  });

  it("rejects a dangling to", () => {
    const def = structuredClone(IDEA_TO_DONE);
    def.stages.find((s) => s.id === "plan")!.next = [{ to: "nowhere" }];
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.pointer.includes("/to"))).toBe(true);
  });

  it("rejects an unknown model when the cache is warm", () => {
    const def = structuredClone(IDEA_TO_DONE);
    def.stages.find((s) => s.id === "plan")!.target = { provider: "claude", model: "no-such-model", effort: "high" };
    const result = validateWorkflowDefinition(def, ctx({
      knownModels: { claude: { checked: true, ids: ["claude-opus"] } },
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Unknown model/.test(e.message))).toBe(true);
  });

  it("warns rather than errors when the model cache is cold", () => {
    const def = structuredClone(IDEA_TO_DONE);
    def.stages.find((s) => s.id === "plan")!.target = { provider: "claude", model: "maybe", effort: "high" };
    const result = validateWorkflowDefinition(def, ctx({
      knownModels: { claude: { checked: false, ids: [] } },
    }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => /not loaded/.test(w.message))).toBe(true);
  });

  it("rejects a missing verdict definition when transitions use verdict", () => {
    const def = structuredClone(IDEA_TO_DONE);
    delete def.contracts.review.output.resultBlock.verdict;
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /verdict/.test(e.message))).toBe(true);
  });

  it("rejects a write stage with no scope", () => {
    const def = structuredClone(IDEA_TO_DONE);
    const impl = def.stages.find((s) => s.id === "implement")!;
    delete impl.scopeFrom;
    delete impl.scope;
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /scope/.test(e.message))).toBe(true);
  });

  it("rejects inherit in a generated workflow unless write was allowed", () => {
    const def = structuredClone(IDEA_TO_DONE);
    def.stages.find((s) => s.id === "implement")!.profile = "inherit";
    const result = validateWorkflowDefinition(def, ctx({ generated: true, allowWrite: false }));
    expect(result.valid).toBe(false);
  });

  it("rejects an unknown schemaVersion", () => {
    const def = { ...IDEA_TO_DONE, schemaVersion: 2 as 1 };
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.pointer).toBe("/schemaVersion");
  });

  it("rejects an unknown role", () => {
    const def = structuredClone(IDEA_TO_DONE);
    def.stages.find((s) => s.id === "plan")!.role = "ghost";
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /ghost/.test(e.message))).toBe(true);
  });

  it("rejects when $done is unreachable", () => {
    const def = structuredClone(IDEA_TO_DONE);
    for (const stage of def.stages) {
      stage.next = stage.next.filter((t) => t.to !== "$done").concat(
        stage.next.some((t) => t.to === "$done") ? [{ to: "$pause" }] : [],
      );
    }
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /\$done/.test(e.message))).toBe(true);
  });

  it("rejects an input path that is not on every ancestor path", () => {
    const def = structuredClone(IDEA_TO_DONE);
    def.contracts.review.inputs.push({ from: "clarify.questions", as: "Questions" });
    const result = validateWorkflowDefinition(def, ctx());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /clarify\.questions/.test(e.message))).toBe(true);
  });

  it("rejects too many stages", () => {
    const def = structuredClone(IDEA_TO_DONE);
    const result = validateWorkflowDefinition(def, ctx({ maxStages: 2 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /At most 2/.test(e.message))).toBe(true);
  });
});
