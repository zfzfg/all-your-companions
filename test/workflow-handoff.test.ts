import { describe, expect, it } from "vitest";
import { parseResult, renderBriefing } from "../src/briefing";
import type { AgentRole } from "../src/agent-roles";
import {
  FINDINGS_CAP,
  SUMMARY_CAP,
  VERIFY_TAIL_CAP,
  briefingFromContract,
  buildHandoffPacket,
  capHandoffPacket,
  extractCompanionsResult,
  parsePlanStepsFromProse,
  stageReturnFormat,
  verdictUnreadable,
} from "../src/workflow-handoff";
import { IDEA_TO_DONE } from "../src/workflow";

const role: AgentRole = {
  name: "reviewer",
  provider: "claude",
  whenToUse: "review",
  source: "builtin",
};

function packetOver(over: Partial<Parameters<typeof buildHandoffPacket>[0]> = {}) {
  return buildHandoffPacket({
    runId: "run-1",
    stageId: "review",
    stageOrdinal: 3,
    visit: 1,
    role: "reviewer",
    target: { provider: "claude", modelVerified: true },
    status: "done",
    rawReply: [
      "looks mostly fine",
      "",
      "```companions-result",
      JSON.stringify({
        summary: "Two findings.",
        verdict: "changes_requested",
        findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 4, text: "null swallow" }],
        filesChanged: [],
        openQuestions: [],
      }),
      "```",
    ].join("\n"),
    filesObserved: ["src/a.ts"],
    reconciliation: { touched: [], unreported: ["src/a.ts"], claimedOnly: [] },
    durationMs: 12,
    resultPath: "/runs/run-1/stage-03.result.md",
    contract: IDEA_TO_DONE.contracts.review,
    ...over,
  });
}

describe("companions-result is the machine channel", () => {
  it("wins over RESULT_FORMAT headings in parseResult", () => {
    const md = [
      "## Summary",
      "heading summary",
      "## Files touched",
      "- heading.ts",
      "```companions-result",
      JSON.stringify({ summary: "json summary", filesChanged: ["json.ts"], openQuestions: ["q"] }),
      "```",
    ].join("\n");
    expect(parseResult(md)).toEqual({
      summary: "json summary",
      files: ["json.ts"],
      open: ["q"],
      failed: [],
    });
    expect(extractCompanionsResult(md)?.summary).toBe("json summary");
  });

  it("falls back to headings when the block is missing", () => {
    expect(parseResult("## Summary\nhello\n## Files touched\n- a.ts").summary).toBe("hello");
  });
});

describe("buildHandoffPacket", () => {
  it("caps summary, findings and verify tail, and never inlines result.md", () => {
    const findings = Array.from({ length: 50 }, (_, i) => ({
      id: `F${i + 1}`,
      severity: "nit" as const,
      text: `n${i}`,
    }));
    const packet = capHandoffPacket(packetOver({
      rawReply: [
        "```companions-result",
        JSON.stringify({
          summary: "S".repeat(SUMMARY_CAP + 80),
          verdict: "changes_requested",
          findings,
        }),
        "```",
      ].join("\n"),
      verify: { command: "npm test", exitCode: 1, output: "E".repeat(VERIFY_TAIL_CAP + 50) },
    }));
    expect(packet.summary.length).toBeLessThanOrEqual(SUMMARY_CAP);
    expect(packet.findings).toHaveLength(FINDINGS_CAP);
    expect(packet.verify?.outputTail.length).toBeLessThanOrEqual(VERIFY_TAIL_CAP);
    expect(packet.resultPath).toBe("/runs/run-1/stage-03.result.md");
    expect(JSON.stringify(packet)).not.toContain("## Summary");
  });

  it("records provenance when a required verdict is missing rather than guessing", () => {
    const packet = packetOver({
      rawReply: "I think it is fine.\n\n## Summary\nok",
    });
    expect(packet.verdict).toBeUndefined();
    expect(packet.provenance?.some((line) => /verdict/i.test(line))).toBe(true);
    expect(verdictUnreadable(packet, IDEA_TO_DONE.contracts.review)).toBe(true);
  });

  it("parses a numbered plan from prose when the planner skipped the block (D17)", () => {
    const steps = parsePlanStepsFromProse("1. Add the parser\n2. Wire the host\n- skip tiny");
    expect(steps.map((s) => s.title)).toContain("Add the parser");
    expect(steps.map((s) => s.title)).toContain("Wire the host");
  });
});

describe("briefingFromContract", () => {
  it("copies only contract inputs, capped, and names resultPath rather than the body", () => {
    const plan = packetOver({
      stageId: "plan",
      stageOrdinal: 1,
      role: "planner",
      rawReply: [
        "```companions-result",
        JSON.stringify({
          summary: "P".repeat(3000),
          planSteps: [{ id: "S1", title: "Do the thing", acceptance: "it works", files: ["src/a.ts"] }],
        }),
        "```",
      ].join("\n"),
      contract: IDEA_TO_DONE.contracts.plan,
    });
    const implement = IDEA_TO_DONE.stages.find((s) => s.id === "implement")!;
    const packets = new Map([["plan", plan]]);
    const brief = briefingFromContract({
      runId: "run-1",
      step: 2,
      idea: "Ship it",
      stage: implement,
      def: IDEA_TO_DONE,
      packets,
      userNotes: "keep the public API stable",
    });
    const joined = [...brief.decisions, ...(brief.provenance ?? [])].join("\n");
    expect(brief.goal).toBe("Ship it");
    expect(joined).toMatch(/keep the public API stable/);
    expect(joined).toMatch(/Do the thing/);
    expect(joined).not.toMatch(/P{2001}/);
    expect(JSON.stringify(brief)).not.toContain(plan.resultPath.replace(/\\/g, "/") === plan.resultPath
      ? "THIS BODY SHOULD NEVER APPEAR"
      : "");
    const rendered = renderBriefing(
      { ...brief, runId: "run-1", step: 2, returnFormat: brief.returnFormat || "" } as never,
      { ...role, name: "implementer" },
    );
    expect(rendered).toContain("companions-result");
    expect(rendered).not.toContain("THIS BODY SHOULD NEVER APPEAR");
  });

  it("asks for the contract's result block, not RESULT_FORMAT plus a second schema", () => {
    const format = stageReturnFormat(IDEA_TO_DONE.contracts.review);
    expect(format).toContain("```companions-result");
    expect(format).toContain("verdict");
    expect(format).not.toMatch(/Reply with exactly these four headings/);
  });
});
