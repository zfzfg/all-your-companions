import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { readWorkflowCompletion } from "../src/workflow-state";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { bracketRemoteSnapshot } from "../src/remote-policy";
import {
  isRunProgressUpdate,
  parseRunProgressUpdate,
  workflowControlCommand,
  runProgressKindLabel,
  formatRunProgressPct,
} from "../src/run-progress";

const statelessRuns = JSON.parse(readFileSync(new URL("fixtures/workflow-stateless-phases.json", import.meta.url), "utf8")).runs;
const outputRuns = JSON.parse(readFileSync(new URL("fixtures/workflow-output.json", import.meta.url), "utf8")).runs;

const capturedStates = ["complete", "cancelled", "active-1", "active-2", "active-3"].map(name => ({
  name, file: JSON.parse(readFileSync(new URL(`fixtures/workflow-state/${name}.json`, import.meta.url), "utf8")),
}));

describe("buffered workflow repairs", () => {
  it("replaces every frame in order from the newest observation and delivers the repair once", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    const run = statelessRuns[0];
    const update = parseRunProgressUpdate({ ...run.state, sessionUpdate: "workflow_updated",
      run_id: run.run_id, name: run.name, status: "active" })!;
    const latest = { ...update, revision: 42, agents: [{ label: "final writer", state: "done", tokensUsed: 12345 }] };
    // Missing disk roster must retain the newest notification's roster/tokens.
    const disk = JSON.stringify({ ...run.state, agents: undefined });
    const completed = readWorkflowCompletion("session", latest, () => disk)!;
    sidebar.focused = session;
    sidebar.workflowCompletion = (_session: Session, previous: typeof update) =>
      readWorkflowCompletion("session", previous, () => disk);
    const desk = vi.fn();
    sidebar.view = { webview: { postMessage: desk } };
    sidebar.mirrorToProjectsRail = () => {};
    sidebar.sendRemoteSession = vi.fn();
    const before = { type: "userMessage" as const, text: "before" };
    const after = { type: "userMessage" as const, text: "after" };
    const between = { type: "userMessage" as const, text: "between observations" };
    const other = { type: "runProgress" as const, update: { ...update, id: "wf_other", done: true } };
    session.buffer.push(before, { type: "runProgress", update }, between, other,
      { type: "runProgress", update: latest }, after);
    sidebar.refreshWorkflowCompletions(session);
    sidebar.refreshWorkflowCompletions(session);
    expect({ buffer: session.buffer, desk: desk.mock.calls })
      .toEqual({ buffer: [before, { type: "runProgress", update: completed }, between, other,
        { type: "runProgress", update: completed }, after],
        desk: [[{ type: "runProgress", update: completed, replaceOnly: true }]] });
  });

  it("isolates repaired updates and their nested fields from other frames and deliveries", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    const run = statelessRuns[0];
    const update = parseRunProgressUpdate({ ...run.state, sessionUpdate: "workflow_updated",
      run_id: run.run_id, name: run.name, status: "active" })!;
    const completed = readWorkflowCompletion("session", update, () => JSON.stringify(run.state))!;
    sidebar.workflowCompletion = () => completed;
    sidebar.focused = session;
    sidebar.postLocal = vi.fn();
    const first = { type: "runProgress" as const, update: structuredClone(update) };
    const last = { type: "runProgress" as const, update: structuredClone(update) };
    session.buffer.push(first, last);
    sidebar.refreshWorkflowCompletions(session);
    const expected = structuredClone(completed);
    first.update.done = false;
    first.update.agents![0].tokensUsed = -1;
    first.update.phases![0].title = "changed phase";
    first.update.workflowContent!.resultSummary = "changed result";
    expect.soft({ last: last.update, delivered: sidebar.postLocal.mock.calls[0][0].update })
      .toEqual({ last: expected, delivered: expected });
    // Mutation in the other direction also cannot reach the first frame.
    const firstAfterMutation = structuredClone(first.update);
    last.update.agents!.push({ label: "another agent" });
    last.update.phases!.push({ title: "another phase" });
    expect.soft(first.update).toEqual(firstAfterMutation);
  });

  it("keeps repairs outside a trimmed phone snapshot and skips runs absent from the host buffer", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    const run = statelessRuns[0];
    const update = parseRunProgressUpdate({ ...run.state, sessionUpdate: "workflow_updated",
      run_id: run.run_id, name: run.name, status: "active" })!;
    sidebar.workflowCompletion = vi.fn((_session, previous) =>
      readWorkflowCompletion("session", previous, () => JSON.stringify(run.state)));
    sidebar.sendRemoteSession = vi.fn();
    session.buffer.push({ type: "runProgress", update });
    for (let i = 0; i < 11; i++) session.buffer.push({ type: "userMessage", text: `turn ${i}` });
    sidebar.refreshWorkflowCompletions(session);
    const snapshot = bracketRemoteSnapshot(session.buffer);
    session.buffer = [];
    sidebar.workflowCompletion.mockClear();
    sidebar.sendRemoteSession.mockClear();
    sidebar.refreshWorkflowCompletions(session);
    expect({ snapshot, buffer: session.buffer, reads: sidebar.workflowCompletion.mock.calls,
      deliveries: sidebar.sendRemoteSession.mock.calls }).toEqual({
      snapshot: [{ type: "historyReplay", active: true }, { type: "historyBatch",
        messages: Array.from({ length: 10 }, (_, i) => ({ type: "userMessage", text: `turn ${i + 1}` })) },
      { type: "historyReplay", active: false }], buffer: [], reads: [], deliveries: [],
    });
  });
});

describe("workflow content provenance", () => {
  it.each(outputRuns)("preserves result provenance and the legacy detail for $run_id", (run) => {
    const u = parseRunProgressUpdate(run)!;
    const payload = run.result_summary || "Workflow outcome ignored: ignored cancelled while status is cancelled";
    expect({ content: u.workflowContent, legacy: u.detail }).toEqual({
      content: { resultSummary: run.result_summary || null, pauseMessage: null },
      legacy: `${run.current_phase} · ${payload} · ${run.agents_used} of ${run.agent_budget} agents used`,
    });
  });
  it("separates pause reasons from results and explicitly clears missing content", () => {
    const parse = (over: object) => parseRunProgressUpdate({ sessionUpdate: "workflow_updated", run_id: "r", ...over })!.workflowContent;
    expect([parse({ resultSummary: "A result", pauseMessage: "Review required" }), parse({ last_event: "log", last_event_detail: "bookkeeping" })])
      .toEqual([{ resultSummary: "A result", pauseMessage: "Review required" }, { resultSummary: null, pauseMessage: null }]);
  });
});

describe("the CLI workflow state store", () => {
  it.each(capturedStates)("reads the captured $name state file without guessing completion", ({ file }) => {
    const previous = parseRunProgressUpdate({ ...file.state, sessionUpdate: "workflow_updated", status: "active", revision: 42 })!;
    const result = readWorkflowCompletion("session", previous, () => JSON.stringify(file));
    expect(result).toEqual(file.state.status === "active" ? undefined : expect.objectContaining({
      id: file.state.run_id, done: true, phase: file.state.status === "complete" ? "completed" : "cancelled",
      elapsedMs: file.state.elapsed_ms_floor, revision: 42,
    }));
  });

  it("does not use a root terminal status when the wrapped state is active or invalid", () => {
    const previous = parseRunProgressUpdate({ ...capturedStates[0].file.state, sessionUpdate: "workflow_updated", status: "active" })!;
    for (const state of [{ status: "active" }, null, [], "complete", {}]) {
      expect(readWorkflowCompletion("session", previous, () => JSON.stringify({ status: "complete", state }))).toBeUndefined();
    }
  });

  it("repairs stale notifications from terminal two-stage states without inventing phase states", () => {
    for (const run of statelessRuns) {
      const previous = parseRunProgressUpdate({ ...run.state, run_id: run.run_id, name: run.name,
        sessionUpdate: "workflow_updated", status: "active", revision: 42 })!;
      const completed = readWorkflowCompletion("session", previous, () => JSON.stringify(run.state));
      expect(completed).toMatchObject({ id: run.run_id, displayName: run.name, title: run.name,
        done: true, phase: "completed", currentPhase: "Summarize", elapsedMs: run.state.elapsed_ms_floor,
        revision: 42, agentsUsed: 3, agentBudget: 4 });
      expect(completed?.phases).toEqual([{ title: "Read" }, { title: "Summarize" }]);
      expect(completed?.agents?.map(a => a.state)).toEqual(["done", "done", "done"]);
    }
  });

  it("leaves active all-done rosters, unavailable state and unsafe run ids alone", () => {
    const run = statelessRuns[0];
    const previous = parseRunProgressUpdate({ ...run.state, run_id: run.run_id, name: run.name,
      sessionUpdate: "workflow_updated", status: "active" })!;
    for (const status of ["active", "user_paused", undefined]) {
      expect(readWorkflowCompletion("session", previous, () => JSON.stringify({ ...run.state, status }))).toBeUndefined();
    }
    for (const raw of ["{", "null", "[]"]) expect(readWorkflowCompletion("session", previous, () => raw)).toBeUndefined();
    for (const code of ["ENOENT", "EACCES", "EIO"]) {
      expect(readWorkflowCompletion("session", previous, () => { throw Object.assign(new Error(code), { code }); })).toBeUndefined();
    }
    const noRead = vi.fn(() => JSON.stringify(run.state));
    expect(readWorkflowCompletion("session", { ...previous, id: "../../other" }, noRead)).toBeUndefined();
    expect(readWorkflowCompletion(undefined, previous, noRead)).toBeUndefined();
    expect(readWorkflowCompletion("session", { ...previous, done: true }, noRead)).toBeUndefined();
    expect(noRead).not.toHaveBeenCalled();
  });

  it("parses a complete run even though its phase definitions have no state", () => {
    const run = statelessRuns[0];
    expect(parseRunProgressUpdate({ ...run.state, run_id: run.run_id, name: run.name, sessionUpdate: "workflow_updated" }))
      .toMatchObject({ done: true, phase: "complete", phases: [{ title: "Read" }, { title: "Summarize" }] });
  });
});

describe("isRunProgressUpdate", () => {
  it("accepts workflow_updated / goal_updated and lifecycle siblings", () => {
    expect(isRunProgressUpdate({ sessionUpdate: "workflow_updated" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "goal_updated" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "workflow_paused" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "goal_completed" })).toBe(true);
  });

  it("rejects unrelated rail kinds", () => {
    expect(isRunProgressUpdate({ sessionUpdate: "auto_compact_completed" })).toBe(false);
    expect(isRunProgressUpdate({ sessionUpdate: "subagent_spawned" })).toBe(false);
    expect(isRunProgressUpdate(null)).toBe(false);
    expect(isRunProgressUpdate({})).toBe(false);
  });
});

describe("parseRunProgressUpdate — workflow", () => {
  it("parses a running workflow_updated", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      run_id: "run-abc",
      display_name: "deep-research-2",
      objective: "Compare Postgres 17 vs MySQL 9",
      current_phase: "running",
      last_event: "agent_started",
      last_event_detail: "researcher",
      agents_used: 4,
      agent_budget: 128,
    });
    expect(u).toMatchObject({
      kind: "workflow",
      id: "run-abc",
      title: "deep-research-2",
      subtitle: "Compare Postgres 17 vs MySQL 9",
      phase: "running",
      done: false,
      failed: false,
      displayName: "deep-research-2",
    });
    // `agent_started` is deliberately NOT in EVENT_LABEL — and is not even in
    // the CLI binary's string table, so this fixture has always modelled an
    // event that never arrives. Kept exactly for that: it exercises the
    // fallback, and shows an unpredicted name reaching the card as English.
    expect(u?.detail).toMatch(/Agent started: researcher/);
    expect(u?.detail).not.toMatch(/agent_started/);
    // Spend is reported as spend. `progress` is the completion slot the card
    // prints as a bare `%`, and a workflow has no completion number to put in
    // it — putting agents_used/agent_budget there is what #163 reported.
    expect(u?.progress).toBeUndefined();
    expect(u?.agentsUsed).toBe(4);
    expect(u?.agentBudget).toBe(128);
    expect(u?.detail).toMatch(/4 of 128 agents used/);
  });

  it("omits the agent count when the run reports no budget", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      run_id: "run-nobudget",
      display_name: "review-changes",
      current_phase: "running",
      last_event: "agent_started",
      agents_used: 2,
    });
    expect(u?.progress).toBeUndefined();
    expect(u?.agentBudget).toBeUndefined();
    expect(u?.detail).toBe("Agent started");
  });

  describe("status is the lifecycle, current_phase is the position within it", () => {
    // Measured live: pausing and stopping a run change `status` and leave
    // `current_phase` alone, and the discriminator stays `workflow_updated`
    // for all three states. Reading the position first is what made Pause
    // look like it had done nothing.
    const at = (over: Record<string, unknown>) =>
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "run-real",
        name: "deep-research",
        agents_used: 1,
        agent_budget: 128,
        current_phase: "Plan",
        ...over,
      });

    it("prefers the position while the run is merely active", () => {
      // "Plan" tells the reader more than "active" does, so `active` must NOT
      // count as a lifecycle word.
      expect(at({ status: "active" })?.phase).toBe("plan");
    });

    it("prefers the lifecycle once the run is paused or stopped", () => {
      expect(at({ status: "user_paused" })?.phase).toBe("user_paused");
      const stopped = at({ status: "cancelled" });
      expect(stopped?.phase).toBe("cancelled");
      expect(stopped?.cancelled).toBe(true);
      expect(stopped?.done).toBe(true);
    });

    it("does not mistake a pause for a finish", () => {
      const paused = at({ status: "user_paused" });
      expect(paused?.done).toBe(false);
      expect(paused?.failed).toBe(false);
      expect(paused?.cancelled).toBe(false);
    });

    it.each(["complete", "completed"])("recognizes %s with a retained Report position and Partial result", (status) => {
      expect(at({ status, current_phase: "Report", result_summary: "Partial" })).toMatchObject({
        phase: status, currentPhase: "Report", done: true, failed: false, cancelled: false,
        detail: "Report · Partial · 1 of 128 agents used",
      });
    });

    it("catches lifecycle words we have not seen, on their stems", () => {
      // The CLI's own vocabulary nearby: budget_limited, interrupted, failed.
      // Each must outrank the position the same way a measured one does.
      for (const status of ["budget_limited", "workflow_interrupted", "failed", "agent_paused"]) {
        expect(at({ status })?.phase, status).toBe(status);
      }
    });

    it("still falls back when no status arrives at all", () => {
      expect(at({ status: undefined })?.phase).toBe("plan");
      expect(parseRunProgressUpdate({
        sessionUpdate: "workflow_updated", run_id: "r", name: "deep-research",
      })?.phase).toBe("updated");
    });
  });

  // The owner, reading a card built from real captured frames: "phase_entered?
  // Can't we translate those labels? Is this the only one?" No, it was not —
  // the phase word leaks the same way, and that half is fixed at the render
  // site (see media/chat.js and the note in src/run-progress.ts).
  describe("wire event names do not reach the card", () => {
    const detailOf = (over: Record<string, unknown>) =>
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "run-real",
        name: "deep-research",
        agents_used: 4,
        agent_budget: 128,
        ...over,
      })?.detail;

    // Every case below is a frame shape the 2026-09-17 live capture actually
    // produced, with the phase it arrived alongside.
    it("drops `phase_entered`, because the row already shows the phase", () => {
      expect(detailOf({ current_phase: "Research", last_event: "phase_entered", last_event_detail: "Research" }))
        .toBe("4 of 128 agents used");
    });

    it("keeps a phase_entered detail that is NOT the phase on screen", () => {
      // Same event, different content: only the duplicate is noise.
      expect(detailOf({ current_phase: "Research", last_event: "phase_entered", last_event_detail: "Verify" }))
        .toBe("Verify · 4 of 128 agents used");
    });

    it("prints a `log` message without its own name in front of it", () => {
      expect(detailOf({
        current_phase: "Plan", last_event: "log",
        last_event_detail: "research plan: 3 question(s), capped at 4",
      })).toBe("research plan: 3 question(s), capped at 4 · 4 of 128 agents used");
    });

    it("says nothing for a lifecycle event the phase slot already carries", () => {
      // `workflow_started` beside a row reading `· active`, and
      // `workflow_cancelled` beside one reading `· cancelled`: in both the
      // event name is the row's job, so the detail is the spend alone.
      expect(detailOf({ status: "active", last_event: "workflow_started" })).toBe("4 of 128 agents used");
      expect(detailOf({ status: "cancelled", last_event: "workflow_cancelled" })).toBe("4 of 128 agents used");
    });

    it("keeps a lifecycle event's prose, and drops its bare reason token", () => {
      // The CLI explains a failure in a sentence — that must survive. A pause
      // reason is a single word the row has already said.
      expect(detailOf({
        status: "budget_exceeded", last_event: "workflow_failed",
        last_event_detail: "maximum agent budget reached; start a new run",
      })).toBe("maximum agent budget reached; start a new run · 4 of 128 agents used");
      expect(detailOf({
        status: "user_paused", current_phase: "Plan",
        last_event: "workflow_paused", last_event_detail: "user",
      })).toBe("Plan · 4 of 128 agents used");
    });

    it("sentence-cases a name nobody predicted, rather than shipping Rust", () => {
      expect(detailOf({ current_phase: "Verify", last_event: "verification_failed" }))
        .toBe("Verification failed · 4 of 128 agents used");
    });

    it("leaves a pause message and a result summary to speak for themselves", () => {
      // These outrank last_event and are already prose from the CLI.
      expect(detailOf({ last_event: "log", pause_message: "Waiting for your review" }))
        .toBe("Waiting for your review · 4 of 128 agents used");
      expect(detailOf({ last_event: "log", result_summary: "3 sources agreed" }))
        .toBe("3 sources agreed · 4 of 128 agents used");
    });
  });

  it("marks completed / failed / cancelled terminal", () => {
    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "r1",
        display_name: "review-changes",
        phase: "completed",
        result_summary: "All checks green",
      }),
    ).toMatchObject({ done: true, failed: false, detail: "All checks green" });

    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_failed",
        run_id: "r2",
        display_name: "x",
        phase: "failed",
      }),
    ).toMatchObject({ done: true, failed: true });

    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_cancelled",
        run_id: "r3",
        name: "y",
        phase: "cancelled",
      }),
    ).toMatchObject({ done: true, cancelled: true });
  });

  it("returns null without an id / name", () => {
    expect(parseRunProgressUpdate({ sessionUpdate: "workflow_updated" })).toBeNull();
  });

  it("never promotes a run id to a control handle", () => {
    const u = parseRunProgressUpdate({ sessionUpdate: "workflow_updated", run_id: "opaque-run-id" });
    expect(u).toMatchObject({ id: "opaque-run-id", title: "Workflow" });
    expect(u?.displayName).toBeUndefined();
    expect(workflowControlCommand("pause", u?.displayName)).toBeNull();
  });

  it.each(["display_name", "displayName", "name", "run_name", "runName"])("preserves the observed %s handle", (field) => {
    const u = parseRunProgressUpdate({ sessionUpdate: "workflow_updated", run_id: "opaque", [field]: "deep-research-2" });
    expect(u?.displayName).toBe("deep-research-2");
  });

  it("keeps optional capabilities absent and normalizes fields only when supplied", () => {
    const minimal = parseRunProgressUpdate({ sessionUpdate: "workflow_updated", run_id: "r" });
    for (const field of ["phases", "agents", "elapsedMs", "currentPhase", "revision"] as const) {
      expect(minimal?.[field]).toBeUndefined();
    }
    expect(parseRunProgressUpdate({
      sessionUpdate: "workflow_updated", runId: "r", currentPhase: "Research", currentPhaseId: "p2",
      phases: [{ phase_id: "p2", title: "Research", state: "active" }],
      agents: [{ agentId: "a1", label: "Researcher", phase: "Research", state: "permission_blocked", tokensUsed: 0 }],
      elapsedMs: 728000, activeAgents: 1, revision: 3,
    })).toMatchObject({
      currentPhase: "Research", currentPhaseId: "p2", elapsedMs: 728000, activeAgents: 1, revision: 3,
      phases: [{ id: "p2", title: "Research", state: "active" }],
      agents: [{ id: "a1", label: "Researcher", phase: "Research", state: "permission_blocked", tokensUsed: 0 }],
    });
  });

  it("falls back to display name as id", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      display_name: "review-changes",
      phase: "running",
    });
    expect(u?.id).toBe("review-changes");
  });
});

describe("parseRunProgressUpdate — goal", () => {
  it("parses goal_updated with deliverable progress", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "goal_updated",
      goal_id: "g1",
      objective: "Migrate auth module",
      phase: "Executing",
      total_deliverables: 4,
      completed_deliverables: 1,
      current_deliverable_title: "Rewrite login handler",
    });
    expect(u).toMatchObject({
      kind: "goal",
      id: "g1",
      title: "Goal",
      subtitle: "Migrate auth module",
      phase: "executing",
      done: false,
    });
    expect(u?.progress).toBeCloseTo(0.25);
    expect(u?.detail).toMatch(/1\/4 deliverables/);
    expect(u?.detail).toMatch(/Rewrite login handler/);
  });

  it("marks goal_completed / goal_cleared done", () => {
    expect(
      parseRunProgressUpdate({ sessionUpdate: "goal_completed", goal_id: "g1", phase: "completed" }),
    ).toMatchObject({ done: true });
    expect(
      parseRunProgressUpdate({ sessionUpdate: "goal_cleared", goal_id: "g1", phase: "cleared" }),
    ).toMatchObject({ done: true, cancelled: true });
  });
});

describe("workflowControlCommand", () => {
  it("builds pause/resume/stop slash commands", () => {
    expect(workflowControlCommand("pause", "review-changes")).toBe("/workflow pause review-changes");
    expect(workflowControlCommand("resume", "deep-research-2")).toBe("/workflow resume deep-research-2");
    expect(workflowControlCommand("stop", "x")).toBe("/workflow stop x");
  });

  it("rejects empty or unsafe names", () => {
    expect(workflowControlCommand("pause", "")).toBeNull();
    expect(workflowControlCommand("pause", "a b")).toBeNull();
    expect(workflowControlCommand("pause", "foo;rm -rf")).toBeNull();
    expect(workflowControlCommand("pause", " deep-research ")).toBeNull();
  });
});

describe("labels", () => {
  it("kind labels", () => {
    expect(runProgressKindLabel("workflow")).toBe("Workflow");
    expect(runProgressKindLabel("goal")).toBe("Goal");
  });
  it("percent formatting", () => {
    expect(formatRunProgressPct(0.25)).toBe("25%");
    expect(formatRunProgressPct(undefined)).toBe("");
  });
});
