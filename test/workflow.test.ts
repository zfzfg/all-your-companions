import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IDEA_TO_DONE,
  applyMaxFixerPasses,
  estimatedStageCount,
  extractStagesBlock,
  firstEnabledStart,
  isAutoGate,
  parseStagesJson,
  snapshotHash,
  workflowFromStagesJson,
  workflowSnapshotHash,
} from "../src/workflow";
import { parseCrewPreset, presetToStageGraph } from "../src/crew-preset";

const ideaToDoneMd = readFileSync(
  new URL("../resources/crews/idea-to-done.md", import.meta.url),
  "utf8",
);

describe("idea-to-done", () => {
  it("starts at Plan because Clarify is disabled", () => {
    expect(firstEnabledStart(IDEA_TO_DONE)).toBe("plan");
    expect(estimatedStageCount(IDEA_TO_DONE)).toBe(4);
  });

  it("matches the diagram: Plan → Implement → Review, then Fix or Done", () => {
    const byId = Object.fromEntries(IDEA_TO_DONE.stages.map((s) => [s.id, s]));
    expect(byId.plan.next.map((t) => t.to)).toEqual(["implement"]);
    expect(byId.implement.next.map((t) => t.to)).toEqual(["review"]);
    expect(byId.implement.strategy).toBe("single-session");
    expect(byId.review.next.map((t) => t.to)).toEqual(["$done", "fix", "fix", "$pause"]);
    expect(byId.fix.maxVisits).toBe(2);
    expect(byId.fix.onMaxVisits).toBe("$pause");
    expect(byId.fix.next.map((t) => t.to)).toEqual(["review"]);
    expect(byId.review.profile).toBe("read-only");
    expect(byId.implement.profile).toBe("scoped-edit");
    expect(byId.planner).toBeUndefined();
    expect(IDEA_TO_DONE.roles.reviewer).toEqual({ ref: "reviewer" });
  });

  it("the shipped Markdown re-parses to the same graph", () => {
    const parsed = parseCrewPreset({
      path: "resources/crews/idea-to-done.md",
      stem: "idea-to-done",
      text: ideaToDoneMd,
    });
    expect(parsed.problem).toBeUndefined();
    const graph = presetToStageGraph(parsed.preset!);
    expect(graph.name).toBe("idea-to-done");
    expect(graph.stages.map((s) => s.id)).toEqual(IDEA_TO_DONE.stages.map((s) => s.id));
    expect(firstEnabledStart(graph)).toBe("plan");
    expect(graph.contracts.review.output.resultBlock.verdict?.values).toEqual([
      "pass",
      "changes_requested",
      "blocked",
    ]);
  });

  it("bakes maxFixerPasses into the snapshot, not the live file", () => {
    const overlay = applyMaxFixerPasses(IDEA_TO_DONE, 4);
    expect(overlay.stages.find((s) => s.id === "fix")?.maxVisits).toBe(4);
    expect(IDEA_TO_DONE.stages.find((s) => s.id === "fix")?.maxVisits).toBe(2);
  });
});

describe("stages block parse", () => {
  it("treats a missing block as absence, not an error", () => {
    expect(parseStagesJson("---\nname: x\n---\nhello")).toEqual({});
    expect(extractStagesBlock("no marker")).toEqual({});
  });

  it("reports a present-but-broken block so it cannot silently become the default graph", () => {
    const text = "<!-- companions:stages v1 -->\n```json\n{not json}\n```";
    expect(parseStagesJson(text).error).toMatch(/not valid/);
  });

  it("rejects a stages document with no stages", () => {
    const parsed = workflowFromStagesJson({ schemaVersion: 1, name: "x", stages: [] }, { source: "project", name: "x" });
    expect(parsed.ok).toBe(false);
  });
});

describe("gate policy", () => {
  it("autoStartNextStage makes every gate auto; a per-stage auto still is", () => {
    const plan = IDEA_TO_DONE.stages.find((s) => s.id === "plan")!;
    expect(isAutoGate(plan, IDEA_TO_DONE, false)).toBe(false);
    expect(isAutoGate(plan, IDEA_TO_DONE, true)).toBe(true);
    const autoed = { ...plan, gate: "auto" as const };
    expect(isAutoGate(autoed, IDEA_TO_DONE, false)).toBe(true);
  });
});

describe("snapshot hash", () => {
  it("is stable for the same definition and changes when a stage does", () => {
    const a = workflowSnapshotHash(IDEA_TO_DONE);
    const b = workflowSnapshotHash(IDEA_TO_DONE);
    expect(a).toBe(b);
    const tweaked = applyMaxFixerPasses(IDEA_TO_DONE, 9);
    expect(workflowSnapshotHash(tweaked)).not.toBe(a);
    expect(snapshotHash("abc")).toHaveLength(8);
  });
});
