// Crew / subagent plan UI in the real chat.js (happy-dom): gate (C-03, C-06,
// C-09, C-15, C-16, C-18), lineup (C-04), rail (X-02, X-04, C-05, C-17),
// input choice (X-03), delegation (S-02, S-03), overview (E-01).
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const baseRun = (over: Record<string, unknown> = {}) => ({
  runId: "run-1", idea: "Add login", workflowName: "idea-to-done", workflowTitle: "Idea to done",
  status: "at-gate", subtitle: "", currentStageId: "implement",
  stages: [{ id: "plan", title: "Plan", status: "done", ordinal: 1, sessionId: "s-plan", meta: "Claude · 1m 00s · 12k tokens" }, { id: "implement", title: "Implement", status: "pending" }],
  table: [{ ordinal: 1, stageId: "plan", title: "Plan", role: "planner", target: "claude", status: "done", duration: "1m 00s", tokens: "12k", files: 0, sessionId: "s-plan" }],
  totals: "1 stage · 1m 00s · 12k tokens",
  autonomy: "step",
  ...over,
});

const gate = (over: Record<string, unknown> = {}) => ({
  kind: "normal", title: "Stage 1 of ~4 done: Plan", reason: "Next stage: Implement",
  proposedNext: [{ id: "implement", title: "Implement" }], nextStageId: "implement",
  eligible: [
    { provider: "codex", displayName: "Codex", models: [{ id: "gpt-5", efforts: ["low", "high"] }] },
    { provider: "claude", displayName: "Claude", models: [{ id: "opus" }] },
  ],
  ineligible: [],
  preselected: { provider: "codex", model: "gpt-5", effort: "high" },
  compare: "different from Plan ✔",
  primaryLabel: "Start Implement on Codex",
  headerMeta: "Claude · 1m 00s · 12k tokens",
  ...over,
});

function crew(window: Window) {
  dispatch(window, { type: "sessionType", sessionId: "s", sessionType: "crew", locked: true } as never);
}

describe("gate card (C-03)", () => {
  it("preselects provider, model and effort, names the target and posts all three", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ gate: gate() }) } as never);
    const card = doc.querySelector(".workflow-gate-card")!;
    expect(card.textContent).toContain("Claude · 1m 00s · 12k tokens");
    expect(card.textContent).toContain("different from Plan ✔");
    expect((card.querySelector(".gate-model") as HTMLSelectElement).value).toBe("gpt-5");
    expect((card.querySelector(".gate-effort") as HTMLSelectElement).value).toBe("high");
    const primary = card.querySelector(".gate-primary") as HTMLElement;
    expect(primary.textContent).toBe("Start Implement on Codex");
    click(window, primary);
    expect(posted.find((p: any) => p.type === "workflowGateAction")).toMatchObject({
      action: "start", target: { provider: "codex", model: "gpt-5", effort: "high" },
    });
  });

  it("colours contract severities and verdicts, and posts the finding selection (C-09)", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ gate: gate({ verdict: "changes_requested", findings: [
      { id: "F1", severity: "blocker", text: "crash" }, { id: "F2", severity: "nit", text: "typo" },
    ] }) }) } as never);
    const card = doc.querySelector(".workflow-gate-card")!;
    expect(card.querySelector(".gate-verdict")!.className).toContain("cx-pill--warn");
    expect(card.querySelector(".cx-finding .cx-pill--danger")).toBeTruthy();
    const picks = [...card.querySelectorAll(".gate-finding-pick")] as HTMLInputElement[];
    expect(picks.map((p) => p.checked)).toEqual([true, false]);
    picks[1]!.checked = true;
    picks[1]!.dispatchEvent(new (window as any).Event("change"));
    expect(posted.find((p: any) => p.action === "selectFindings")).toMatchObject({ findings: ["F1", "F2"] });
  });

  it("offers the plan as an editable checklist (C-06) and the clarifier's questions as a form (C-15)", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ gate: gate({
      planSteps: [{ id: "S1", title: "Route" }, { id: "S2", title: "Tests" }],
      questions: ["Which auth provider?"],
    }) }) } as never);
    const card = doc.querySelector(".workflow-gate-card")!;
    const keep = card.querySelectorAll(".gate-plan-keep")[1] as HTMLInputElement;
    keep.checked = false;
    keep.dispatchEvent(new (window as any).Event("change"));
    click(window, card.querySelector(".gate-plan-save") as HTMLElement);
    expect(posted.find((p: any) => p.type === "workflowPlanEdit")).toMatchObject({ runId: "run-1", steps: [{ id: "S1", title: "Route" }] });
    (card.querySelector(".gate-answer") as HTMLInputElement).value = "GitHub";
    click(window, card.querySelector(".gate-primary") as HTMLElement);
    expect((posted.find((p: any) => p.action === "start") as any).notes).toContain("Which auth provider?\n  GitHub");
  });

  it("a limit gate offers the other companions, wait and retry, and pause (C-16)", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ gate: gate({ kind: "limit", limit: {
      provider: "codex", providerName: "Codex", alternatives: [{ provider: "claude", displayName: "Claude" }],
    } }) }) } as never);
    const labels = [...doc.querySelectorAll(".gate-actions > button")].map((b) => b.textContent);
    expect(labels).toEqual(["Run Implement on Claude", "Wait and retry on Codex", "Pause run"]);
    click(window, doc.querySelector(".gate-actions > button") as HTMLElement);
    expect(posted.find((p: any) => p.action === "start")).toMatchObject({ target: { provider: "claude" } });
  });

  it("revise sends feedback into the stage (C-07); the ⋯ menu reverts a stage (C-10)", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ gate: gate(), table: [{ ordinal: 1, stageId: "plan", title: "Plan", role: "planner", target: "", status: "done", files: 2, sessionId: "s", revertible: true }] }) } as never);
    click(window, doc.querySelector(".gate-revise-open") as HTMLElement);
    (doc.querySelector(".gate-revise-text") as HTMLTextAreaElement).value = "Split step 2";
    click(window, doc.querySelector(".gate-revise button") as HTMLElement);
    expect(posted.find((p: any) => p.action === "revise")).toMatchObject({ message: "Split step 2" });
    click(window, doc.querySelector('.gate-more-list [data-action="revertStage"]') as HTMLElement);
    expect(posted.find((p: any) => p.action === "revertStage")).toMatchObject({ ordinal: 1 });
  });

  it("a finished run shows Keep changes / Revert all / Open report (C-18)", () => {
    const { window, doc } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ status: "done" }) } as never);
    const labels = [...doc.querySelectorAll(".workflow-done-card .gate-actions button")].map((b) => b.textContent);
    expect(labels).toEqual(["Keep changes", "Revert all", "Open report", "Copy as Markdown"]);
    dispatch(window, { type: "workflowRun", run: baseRun({ status: "done", acknowledged: true }) } as never);
    expect(doc.querySelector(".workflow-done-card")).toBeNull();
  });
});

describe("crew rail (X-02, X-04, C-05, C-17)", () => {
  it("shows numbers, the live feed, the stall warning and the autonomy control", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({
      status: "running", currentStageId: "implement",
      stages: [{ id: "plan", title: "Plan", status: "done", ordinal: 1, meta: "Claude · 12k tokens" }, { id: "implement", title: "Implement", status: "stalled", sessionId: "s-impl" }],
      stalled: { stageId: "implement", text: "No activity for 5 min" },
    }) } as never);
    dispatch(window, { type: "childActivity", owner: { kind: "stage", id: "run-1:implement" }, items: [{ kind: "tool", id: "t", title: "src/auth.ts", status: "in_progress" }], lastLine: "Editing src/auth.ts…" } as never);
    const rail = doc.getElementById("crew-run")!;
    expect(rail.textContent).toContain("Claude · 12k tokens");
    expect(rail.textContent).toContain("Editing src/auth.ts…");
    expect(rail.textContent).toContain("No activity for 5 min");
    click(window, rail.querySelector(".crew-nudge") as HTMLElement);
    expect(posted.some((p: any) => p.action === "nudge")).toBe(true);
    click(window, rail.querySelector('#rail-autonomy-autopilot') as HTMLElement);
    expect(posted.find((p: any) => p.action === "setAutonomy")).toMatchObject({ autonomy: "autopilot" });
    const pause = rail.querySelector(".crew-pause-after") as HTMLInputElement;
    pause.checked = true;
    pause.dispatchEvent(new (window as any).Event("change"));
    expect(posted.find((p: any) => p.action === "pauseAfterStage")).toMatchObject({ value: true });
    expect(rail.querySelector(".crew-run-table")).toBeTruthy();
  });

  it("typed text while a stage runs asks where it goes (X-03)", () => {
    const { window, doc, posted } = bootWebview();
    crew(window);
    dispatch(window, { type: "workflowRun", run: baseRun({ status: "running", currentStageId: "implement" }) } as never);
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "use bcrypt";
    click(window, doc.getElementById("send-btn") as HTMLElement);
    expect(posted.some((p: any) => p.type === "send")).toBe(false);
    const choice = doc.getElementById("crew-input-choice")!;
    expect(choice.textContent).toContain("Send to the running stage (Implement)");
    click(window, choice.querySelectorAll("button")[1] as HTMLElement);
    expect(posted.find((p: any) => p.type === "childMessage")).toEqual({ type: "childMessage", route: "stage:run-1", text: "use bcrypt", mode: "note" });
  });
});

describe("crew start lineup (C-04)", () => {
  it("shows the proposed lineup and sends it with Start", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s", sessionType: "crew", locked: false } as never);
    dispatch(window, {
      type: "workflowList", defaultWorkflow: "idea-to-done", verifySuggestions: ["npm test"], defaultAutonomy: "step",
      workflows: [{ name: "idea-to-done", title: "Idea to done", whenToUse: "x", source: "builtin", hasFix: true, maxFixRounds: 2,
        stages: ["Plan", "Implement", "Review", "Fix"],
        lineup: [
          { stageId: "plan", title: "Plan", provider: "claude", providerName: "Claude", effort: "high", enabled: true, optional: false, gate: "manual" },
          { stageId: "implement", title: "Implement", provider: "codex", providerName: "Codex", enabled: true, optional: false, gate: "manual" },
        ] }],
    } as never);
    const panel = doc.querySelector(".crew-lineup")!;
    expect(panel.textContent).toContain("Plan: Claude high → Implement: Codex");
    click(window, panel.querySelector(".crew-lineup-customize") as HTMLElement);
    const fis = doc.querySelector(".lineup-fix-in-session") as HTMLInputElement;
    fis.checked = true;
    fis.dispatchEvent(new (window as any).Event("change"));
    (doc.getElementById("input") as HTMLTextAreaElement).value = "Add login";
    click(window, doc.getElementById("crew-start") as HTMLElement);
    const start = posted.find((p: any) => p.type === "workflowStart") as any;
    expect(start.options).toMatchObject({ startNow: true, fixInSession: true, autonomy: "step", lineup: { plan: { provider: "claude", effort: "high" }, implement: { provider: "codex" } } });
  });
});

describe("delegation in the composer (S-02, S-03) and the overview (E-01)", () => {
  it("offers @subagent: completions from the roster, ineligible ones struck through", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s", sessionType: "agent", locked: true } as never);
    dispatch(window, { type: "sessionDelegation", value: "auto", roles: [{ name: "reviewer", whenToUse: "reviews" }], targets: [
      { provider: "codex", name: "Codex", eligible: true, models: [{ id: "gpt-5" }] },
      { provider: "gemini", name: "Gemini", eligible: false, reason: "not signed in" },
    ] } as never);
    const sw = doc.getElementById("delegation-switch") as HTMLSelectElement;
    expect(sw.value).toBe("auto");
    sw.value = "ask";
    sw.dispatchEvent(new (window as any).Event("change"));
    expect(posted.find((p: any) => p.type === "setSessionDelegation")).toMatchObject({ value: "ask" });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "@subagent:";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new (window as any).Event("input"));
    const pop = doc.getElementById("mention-popover")!;
    expect(pop.textContent).toContain("@subagent:codex");
    expect(pop.querySelector(".is-disabled")!.textContent).toContain("not signed in");
  });

  it("the approval card sends only what the person changed", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "subagentApproval", id: "a1", label: "Scan", task: "scan it", provider: "codex", profile: "scoped-edit",
      profiles: ["read-only", "scoped-edit"], targets: [{ provider: "codex", displayName: "Codex" }, { provider: "claude", displayName: "Claude" }] } as never);
    const card = doc.querySelector(".subagent-approval")!;
    const profile = card.querySelector(".subagent-approval-profile") as HTMLSelectElement;
    profile.value = "read-only";
    click(window, [...card.querySelectorAll("button")].find((b) => b.textContent === "Start") as HTMLElement);
    expect(posted.find((p: any) => p.type === "subagentApprovalAnswer")).toEqual({ type: "subagentApprovalAnswer", id: "a1", approved: true, profile: "read-only" });
  });

  it("lists running children above the history with a jump to the first question", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "runningChildren", needYou: 1, groups: [{ parentSessionId: "p", parentName: "Login work", children: [
      { kind: "stage", id: "r:implement", label: "Implement", target: "Codex", status: "needs-you", startedAt: Date.now() - 5000 },
      { kind: "native", id: "n1", label: "explore", target: "Grok · built-in", status: "running", startedAt: Date.now() },
    ] }] } as never);
    click(window, doc.getElementById("history-btn") as HTMLElement);
    const box = doc.querySelector(".running-children")!;
    expect(box.textContent).toContain("1 needs you");
    expect(box.textContent).toContain("Needs you");
    click(window, box.querySelector(".running-children-jump") as HTMLElement);
    expect(posted.some((p: any) => p.type === "childOverviewAction" && p.action === "jump")).toBe(true);
  });
});
