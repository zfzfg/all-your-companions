import { describe, expect, it } from "vitest";
import { IDEA_TO_DONE } from "../src/workflow";
import { parseCrewPreset } from "../src/crew-preset";
import { serializeWorkflowPreset, validateWorkflowDraft, workflowToDraft } from "../src/workflow-write";
import { extractCompanionsWorkflow, acceptSubmission } from "../src/workflow-generator";

const ROLES = ["planner", "implementer", "reviewer", "fixer", "clarifier", "inspector", "researcher"];

describe("workflow writer round-trip", () => {
  it("serialises idea-to-done, re-parses, and keeps the same meaning", () => {
    const draft = workflowToDraft(IDEA_TO_DONE);
    const result = validateWorkflowDraft(draft, { roleNames: ROLES });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    const parsed = parseCrewPreset({ path: ".companions/crews/idea-to-done.md", stem: "idea-to-done", text: result.text });
    expect(parsed.preset?.name).toBe("idea-to-done");
    expect(parsed.preset?.stages).toBeTruthy();
    expect(result.workflow.stages.map((s) => s.id)).toEqual(IDEA_TO_DONE.stages.map((s) => s.id));
  });

  it("refuses a draft whose stages block will not re-parse", () => {
    const result = validateWorkflowDraft({
      name: "x",
      stagesJson: { schemaVersion: 1, name: "x", stages: [] },
    }, { roleNames: ROLES });
    expect(result.ok).toBe(false);
  });
});

describe("generator fallback block", () => {
  it("extracts a companions-workflow fence and accepts a valid submission", () => {
    const draft = workflowToDraft(IDEA_TO_DONE);
    const md = ["here is the workflow", "```companions-workflow", JSON.stringify(draft.stagesJson), "```"].join("\n");
    const raw = extractCompanionsWorkflow(md);
    expect(raw).toBeTruthy();
    const accepted = acceptSubmission(raw, { roleNames: ROLES }, { sourcePrompt: "idea to done", generatedAt: "0" });
    expect(accepted.ok, accepted.ok ? "" : accepted.error).toBe(true);
  });
});
