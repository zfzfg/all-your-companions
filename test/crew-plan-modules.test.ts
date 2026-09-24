// Pure modules of the crew / subagent improvement plan (C-03 … C-17, S-*, E-02, X-02).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareLabel, lineupSummary, preselectGateTarget, proposeLineup, suggestVerifyCommands } from "../src/workflow-target";
import { consensusLabel, mergeReviewPackets, panelTargets, strictestVerdict, textSimilarity } from "../src/workflow-panel";
import { formatDurationShort, formatTokenCount, renderRunReport, runTableRows, runTotalsLine } from "../src/workflow-report";
import { activityItemFromHostMsg, activityLastLine, coalesceActivity } from "../src/child-activity";
import { CHILD_STATUS_VIEW, stageChildStatus, subagentChildStatus } from "../src/child-status";
import { grokSubagentEnv, bothDelegationsHint } from "../src/grok-subagent-env";
import { MORE_BUILTIN_WORKFLOWS, workflowMarkdown } from "../src/workflow-builtins";
import { validateWorkflowDefinition } from "../src/workflow-validate";
import { parseCrewPreset, presetToStageGraph } from "../src/crew-preset";
import { IDEA_TO_DONE, findStage, stageContinues, workflowFromStagesJson } from "../src/workflow";
import {
  anotherRoundLabel,
  applyGateAction,
  applyLineupToDefinition,
  applyStageOutcome,
  autonomyFromSettings,
  makeWorkflowRun,
  sanitizePlanEdit,
  shouldAutoProceed,
  startStage,
  type WorkflowRun,
} from "../src/workflow-run";
import type { HandoffPacket } from "../src/workflow-handoff";
import { SubagentRegistry, subagentTurnSummary, type SubagentRecord } from "../src/companion-subagents";
import { normalizeAwaitArguments } from "../src/companions-protocol";

const packet = (over: Partial<HandoffPacket>): HandoffPacket => ({
  version: 1, runId: "r", stageId: "review", stageOrdinal: 3, visit: 1, role: "reviewer",
  target: { provider: "claude", modelVerified: true }, status: "done", summary: "ok",
  filesReported: [], filesObserved: [], unreported: [], claimedOnly: [], durationMs: 1000,
  resultPath: "/r/stage-03.result.md", ...over,
});

describe("gate preselection (C-03, F-05)", () => {
  const review = findStage(IDEA_TO_DONE, "review")!;
  const implement = packet({ stageId: "implement", stageOrdinal: 2, target: { provider: "codex", modelVerified: true } });
  const packets = new Map([["implement", implement]]);

  it("prefers a provider different from the implementer and says so", () => {
    const pick = preselectGateTarget({ stage: review, def: IDEA_TO_DONE, eligible: ["codex", "claude"], packets });
    expect(pick.target?.provider).toBe("claude");
    expect(pick.source).toBe("different");
    expect(compareLabel(pick.compare)).toBe("different from Implement ✔");
  });

  it("flags a lineup that puts review on the implementer's companion", () => {
    const pick = preselectGateTarget({ stage: review, def: IDEA_TO_DONE, eligible: ["codex", "claude"], packets, lineup: { provider: "codex" } });
    expect(pick.source).toBe("lineup");
    expect(compareLabel(pick.compare)).toBe("same companion as Implement — not an outside opinion");
  });

  it("an explicit hint wins; a built-in role's placeholder provider never does", () => {
    expect(preselectGateTarget({ stage: review, def: IDEA_TO_DONE, eligible: ["codex", "claude"], packets, hint: { provider: "codex", model: "m" } }).target)
      .toEqual({ provider: "codex", model: "m" });
    const plan = findStage(IDEA_TO_DONE, "plan")!;
    const pick = preselectGateTarget({ stage: plan, def: IDEA_TO_DONE, eligible: ["grok"], packets: new Map(), role: { provider: "claude", builtin: true } });
    expect(pick.target).toEqual({ provider: "grok", effort: "high" });
  });
});

describe("lineup (C-04)", () => {
  it("proposes review on another companion, fixer like the implementer, planner on high effort", () => {
    const lineup = proposeLineup({ def: IDEA_TO_DONE, eligible: ["codex", "claude"] });
    const by = Object.fromEntries(lineup.map((e) => [e.stageId, e]));
    expect(by.plan!.effort).toBe("high");
    expect(by.review!.provider).not.toBe(by.implement!.provider);
    expect(by.fix!.provider).toBe(by.implement!.provider);
    expect(by.clarify!.optional).toBe(true);
    expect(lineupSummary(lineup, (p) => p)).toContain("Plan: codex");
  });

  it("switches optional stages and gates on the run's snapshot only", () => {
    const def = applyLineupToDefinition(IDEA_TO_DONE, { clarify: { enabled: true }, review: { gate: "auto" } });
    expect(findStage(def, "clarify")!.enabled).toBe(true);
    expect(findStage(def, "review")!.gate).toBe("auto");
    expect(findStage(IDEA_TO_DONE, "clarify")!.enabled).toBe(false);
  });

  it("only proposes verify commands the project has", () => {
    expect(suggestVerifyCommands({ packageJson: { scripts: { test: "vitest", lint: "eslint" } }, hasCargo: true }))
      .toEqual(["npm test", "npm run lint", "cargo test"]);
    expect(suggestVerifyCommands({})).toEqual([]);
  });
});

describe("autonomy (C-05, D6)", () => {
  const plan = findStage(IDEA_TO_DONE, "plan")!;
  const autoDef = applyLineupToDefinition(IDEA_TO_DONE, { plan: { gate: "auto" } });
  it.each([
    ["step", IDEA_TO_DONE, [], false],
    ["stop-on-problems", IDEA_TO_DONE, [], false],
    ["stop-on-problems", autoDef, [], true],
    ["autopilot", IDEA_TO_DONE, [], true],
    ["autopilot", IDEA_TO_DONE, ["verify-failed"], false],
  ] as const)("%s", (autonomy, def, forced, expected) => {
    expect(shouldAutoProceed({ autonomy, stage: findStage(def, "plan") ?? plan, def, forced })).toBe(expected);
  });
  it("pause after this stage stops once, and the legacy setting maps to stop-on-problems", () => {
    expect(shouldAutoProceed({ autonomy: "autopilot", stage: plan, def: IDEA_TO_DONE, forced: [], pauseAfterCurrent: true })).toBe(false);
    expect(autonomyFromSettings(undefined, true)).toBe("stop-on-problems");
    expect(autonomyFromSettings("autopilot", false)).toBe("autopilot");
  });
  it("a provider switch after a limit always stops (F-08)", () => {
    let run: WorkflowRun = startStage(makeWorkflowRun({ runId: "r", sessionId: "s", workflow: IDEA_TO_DONE, idea: "x", cwd: "/w" }), "plan", 1);
    run = applyStageOutcome(run, IDEA_TO_DONE, packet({ stageId: "plan", stageOrdinal: 1, planSteps: [{ id: "S1", title: "x" }], switchedFrom: "codex" }), [], { autoStartNextStage: false, autonomy: "autopilot" });
    expect(run.gate?.autoProceed).toBeFalsy();
    expect(run.gate?.forcedManual).toContain("provider-switched");
    expect(run.gate?.switchedFrom).toBe("codex");
  });
});

describe("another round (C-11) and findings (C-09)", () => {
  it("grants one extra visit, labelled, and the cap returns after it", () => {
    let run = makeWorkflowRun({ runId: "r", sessionId: "s", workflow: IDEA_TO_DONE, idea: "x", cwd: "/w" });
    run = { ...run, executed: [{ stageId: "fix", ordinal: 4, visit: 1, packetPath: "", status: "done" }, { stageId: "fix", ordinal: 6, visit: 2, packetPath: "", status: "done" }],
      gate: { proposedNext: ["$pause", "$done", "$cancel"], reason: "", kind: "fixer-limit" }, status: "paused" };
    expect(anotherRoundLabel(run, IDEA_TO_DONE)).toBe("Another round (3 of 3)");
    const next = applyGateAction(run, IDEA_TO_DONE, { type: "anotherRound" }, 1);
    expect(next.extraVisits).toEqual({ fix: 1 });
    expect(next.current?.stageId).toBe("fix");
  });

  it("selection keeps the rest as accepted, and Accept as is records all open ones", () => {
    let run = makeWorkflowRun({ runId: "r", sessionId: "s", workflow: IDEA_TO_DONE, idea: "x", cwd: "/w" });
    run = { ...run, lastFindingIds: ["F1", "F2", "F3"] };
    run = applyGateAction(run, IDEA_TO_DONE, { type: "selectFindings", keep: ["F1"] }, 1);
    expect(run.ignoredFindings).toEqual(["F2", "F3"]);
    const done = applyGateAction({ ...run, ignoredFindings: [] }, IDEA_TO_DONE, { type: "acceptAsIs" }, 1);
    expect(done.status).toBe("done");
    expect(done.ignoredFindings).toEqual(["F1", "F2", "F3"]);
  });

  it("cleans a plan edit (C-06)", () => {
    expect(sanitizePlanEdit([{ title: " a ", files: ["x", "x", ""] }, { id: "S9", title: "" }, { id: "S2", title: "b", acceptance: "ok" }]))
      .toEqual([{ id: "S1", title: "a", files: ["x"] }, { id: "S2", title: "b", acceptance: "ok" }]);
  });
});

describe("review panel (C-13)", () => {
  it("merges strictest verdict and de-duplicates findings with their reporters", () => {
    const a = packet({ verdict: "pass", findings: [{ id: "F1", severity: "minor", file: "a.ts", line: 10, text: "missing null check on user input" }] });
    const b = packet({ verdict: "changes_requested", findings: [
      { id: "F1", severity: "major", file: "a.ts", line: 11, text: "missing null check for the user input" },
      { id: "F2", severity: "nit", text: "typo" },
    ], target: { provider: "codex", modelVerified: true } });
    const merged = mergeReviewPackets([a, b], ["Claude", "Codex"]);
    expect(merged.verdict).toBe("changes_requested");
    expect(merged.findings).toHaveLength(2);
    expect(merged.findings![0]).toMatchObject({ id: "F1", severity: "major", reporters: ["Claude", "Codex"] });
    expect(consensusLabel(merged.findings![0]!, 2)).toBe("2/2 reviewers");
    expect(merged.panel).toHaveLength(2);
  });
  it("an unreadable verdict from any reviewer keeps the gate stopping", () => {
    expect(strictestVerdict(["pass", undefined])).toBeUndefined();
    expect(textSimilarity("a b c", "")).toBe(0);
    expect(panelTargets({ provider: "grok" }, [{ provider: "grok" }, { provider: "claude" }, { provider: "codex" }], 2, true))
      .toEqual([{ provider: "grok" }, { provider: "claude" }]);
  });
});

describe("run report and totals (C-17, X-05)", () => {
  it("renders honest numbers and no money", () => {
    const run = { ...makeWorkflowRun({ runId: "r", sessionId: "s", workflow: IDEA_TO_DONE, idea: "Add login", cwd: "/w" }),
      executed: [{ stageId: "plan", ordinal: 1, visit: 1, packetPath: "", status: "done" as const }], status: "done" as const };
    const p = packet({ stageId: "plan", stageOrdinal: 1, tokens: 84_000, durationMs: 372_000, filesObserved: ["src/a.ts"] });
    const rows = runTableRows(run, IDEA_TO_DONE, [p]);
    expect(runTotalsLine(rows)).toBe("1 stage · 6m 12s · 84k tokens");
    const md = renderRunReport({ run, def: IDEA_TO_DONE, packets: [p] });
    expect(md).toContain("# Crew run r");
    expect(md).toContain("`src/a.ts`");
    expect(md).not.toContain("$");
    expect(formatDurationShort(45_000)).toBe("45s");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});

describe("child activity (X-02) and one status vocabulary (E-02)", () => {
  it("coalesces prose, keeps the latest tool state and reads a last line", () => {
    const items = [
      activityItemFromHostMsg({ type: "messageChunk", text: "Look" })!,
      activityItemFromHostMsg({ type: "messageChunk", text: "ing\nat auth" })!,
      activityItemFromHostMsg({ type: "toolCall", call: { toolCallId: "t", title: "src/auth.ts", kind: "edit", status: "in_progress" } })!,
      activityItemFromHostMsg({ type: "toolCallUpdate", call: { toolCallId: "t", status: "in_progress" } })!,
    ];
    const merged = coalesceActivity(items);
    expect(merged).toHaveLength(2);
    expect(activityLastLine(merged)).toBe("Editing src/auth.ts…");
    expect(activityItemFromHostMsg({ type: "agentEnd" })).toBeNull();
  });
  it("maps every kind of child onto one enum", () => {
    expect(subagentChildStatus("running", { needsYou: true })).toBe("needs-you");
    expect(subagentChildStatus("pending-approval")).toBe("needs-you");
    expect(stageChildStatus("done")).toBe("completed");
    expect(stageChildStatus("reverted")).toBe("cancelled");
    expect(CHILD_STATUS_VIEW.stalled.tone).toBe("warn");
  });
});

describe("Grok's own subagents (S-07)", () => {
  it("sets env only where asked and never over the user's", () => {
    expect(grokSubagentEnv({ enabled: false, maxConcurrent: 3 }, {})).toEqual({ GROK_SUBAGENTS: "0", GROK_MAX_CONCURRENT_SUBAGENTS: "3" });
    expect(grokSubagentEnv({ enabled: true }, { GROK_SUBAGENTS: "1" })).toEqual({});
    expect(grokSubagentEnv({ maxConcurrent: 0 }, {})).toEqual({});
    expect(bothDelegationsHint(true, true)).toContain("its own subagents");
    expect(bothDelegationsHint(false, true)).toBeUndefined();
  });
});

describe("built-in workflows (C-14)", () => {
  it.each(MORE_BUILTIN_WORKFLOWS.map((d) => [d.name, d] as const))("%s validates and its Markdown copy re-parses to the same graph", (name, def) => {
    const check = validateWorkflowDefinition(def, { roleNames: ["planner", "implementer", "reviewer", "researcher", "fixer"] } as never);
    expect(check.errors).toEqual([]);
    const md = readFileSync(new URL(`../resources/crews/${name}.md`, import.meta.url), "utf8");
    expect(md).toBe(workflowMarkdown(def));
    const parsed = parseCrewPreset({ path: `resources/crews/${name}.md`, stem: name, text: md });
    expect(parsed.problem).toBeUndefined();
    const graph = presetToStageGraph(parsed.preset!);
    expect(graph.stages).toEqual(workflowFromStagesJson(JSON.parse(md.split("```json")[1]!.split("```")[0]!), { source: "builtin", name }).ok ? graph.stages : []);
    expect(graph.stages.map((s) => s.id)).toEqual(def.stages.map((s) => s.id));
  });
  it("refactor-safe walks plan steps with a verify after each", () => {
    const refactor = MORE_BUILTIN_WORKFLOWS.find((d) => d.name === "refactor-safe")!;
    expect(findStage(refactor, "implement")).toMatchObject({ strategy: "per-plan-step", verifyEach: true });
    expect(stageContinues({ session: "continue:implement" })).toBe("implement");
  });
});

describe("subagents: follow-up and turn summary (S-04, X-05)", () => {
  const rec = (over: Partial<SubagentRecord>): SubagentRecord => ({
    subagentId: "sa", parentSessionId: "p", runId: "run", step: 1, label: "Scan", target: { provider: "codex" },
    profile: "read-only", status: "completed", startedAt: 0, endedAt: 134_000, background: false, spawnedInTurn: "1", ...over,
  });
  it("reopens a finished record for a follow-up, never a refused one", () => {
    const reg = new SubagentRegistry();
    reg.add(rec({}));
    reg.add(rec({ subagentId: "no", status: "refused" }));
    expect(reg.reopen("sa")).toMatchObject({ status: "running", step: 2, collected: false });
    expect(reg.reopen("no")).toBeUndefined();
  });
  it("summarizes a turn's delegations", () => {
    expect(subagentTurnSummary([rec({ tokens: 30_000 }), rec({ subagentId: "b", tokens: 18_000 }), rec({ subagentId: "c" })]))
      .toBe("3 subagents · 2m 14s · 48k tokens");
    expect(subagentTurnSummary([])).toBeUndefined();
  });
  it("await continue needs a message", () => {
    expect(normalizeAwaitArguments({ ids: ["sa"], action: "continue" }).ok).toBe(false);
    expect(normalizeAwaitArguments({ ids: ["sa"], action: "continue", message: "and tests?" })).toMatchObject({ ok: true, value: { action: "continue", message: "and tests?" } });
  });
});
