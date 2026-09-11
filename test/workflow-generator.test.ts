import { describe, expect, it } from "vitest";
import { IDEA_TO_DONE, workflowToMermaid } from "../src/workflow";
import { validateWorkflowDefinition } from "../src/workflow-validate";
import { workflowToDraft } from "../src/workflow-write";
import {
  acceptSubmission,
  extractCompanionsWorkflow,
  GENERATOR_TOOL_NAMES,
  GENERATOR_TOOLS,
  generatorMetaPrompt,
  isGeneratorTool,
  isGeneratorOnlyTool,
  makeGeneratorState,
  recordValidation,
  canRepair,
} from "../src/workflow-generator";
import { COMPANIONS_SPAWN_TOOL } from "../src/companions-protocol";

const ROLES = ["planner", "implementer", "reviewer", "fixer", "clarifier", "inspector", "researcher"];

describe("generator tools", () => {
  it("advertises schema, list, validate and submit — not spawn/await", () => {
    expect([...GENERATOR_TOOL_NAMES]).toContain("companions_workflow_schema");
    expect([...GENERATOR_TOOL_NAMES]).toContain("companions_validate_workflow");
    expect([...GENERATOR_TOOL_NAMES]).toContain("companions_submit_workflow");
    expect([...GENERATOR_TOOL_NAMES]).toContain("companions_list_subagent_targets");
    expect(isGeneratorTool("companions_spawn_subagent")).toBe(false);
    expect(isGeneratorTool("companions_list_subagent_targets")).toBe(true);
    expect(isGeneratorOnlyTool("companions_list_subagent_targets")).toBe(false);
    expect(isGeneratorOnlyTool("companions_workflow_schema")).toBe(true);
    expect(isGeneratorOnlyTool("companions_spawn_subagent")).toBe(false);
    expect(GENERATOR_TOOLS.map((t) => t.name)).toEqual([...GENERATOR_TOOL_NAMES]);
    expect(GENERATOR_TOOLS.some((t) => t.name === COMPANIONS_SPAWN_TOOL)).toBe(false);
  });
});

describe("repair then submit", () => {
  it("rejects an unbounded cycle, then accepts the repaired draft", () => {
    const broken = structuredClone(IDEA_TO_DONE);
    const fix = broken.stages.find((s) => s.id === "fix")!;
    delete fix.maxVisits;
    delete fix.onMaxVisits;
    const first = validateWorkflowDefinition(broken, { roleNames: ROLES, generated: true });
    expect(first.valid).toBe(false);

    const state = recordValidation(makeGeneratorState("idea to done"), workflowToDraft(broken).stagesJson, first);
    expect(canRepair(state)).toBe(true);

    const accepted = acceptSubmission(workflowToDraft(IDEA_TO_DONE).stagesJson, { roleNames: ROLES, generated: true });
    expect(accepted.ok, accepted.ok ? "" : accepted.error).toBe(true);
  });

  it("extracts a fenced companions-workflow block as the no-MCP fallback", () => {
    const draft = workflowToDraft(IDEA_TO_DONE);
    const md = ["thinking", "```companions-workflow", JSON.stringify(draft.stagesJson), "```"].join("\n");
    const raw = extractCompanionsWorkflow(md);
    const accepted = acceptSubmission(raw, { roleNames: ROLES });
    expect(accepted.ok).toBe(true);
  });
});

describe("meta-prompt", () => {
  it("carries the user's description and the Appendix C steps", () => {
    const text = generatorMetaPrompt({
      description: "For bug reports: reproduce then fix",
      options: { reuseRoles: true, newRoles: "inline", allowWrite: true, maxStages: 8, maxRepairRounds: 3 },
    });
    expect(text).toContain("For bug reports: reproduce then fix");
    expect(text).toContain("companions_submit_workflow");
    expect(text).toContain("companions-workflow");
  });
});

describe("mermaid preview", () => {
  it("renders idea-to-done as a flowchart with $done", () => {
    const mermaid = workflowToMermaid(IDEA_TO_DONE);
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain("plan");
    expect(mermaid).toContain("implement");
    expect(mermaid).toContain("$done");
  });
});
