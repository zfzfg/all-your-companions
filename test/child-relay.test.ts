import { describe, expect, it, vi } from "vitest";
import {
  ChildRelayTable,
  childNeedsYouNotice,
  childScopedSuggestions,
  isRelayRoute,
  relayOriginLabel,
} from "../src/child-relay";
import { PausableDeadline, normalizeStallWarningSec, stageStallState } from "../src/child-watch";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { bootWebview, dispatch, click } from "./webview-harness";

describe("ChildRelayTable (X-01)", () => {
  it("maps route ↔ (child, request id) and closes both directions", () => {
    const t = new ChildRelayTable<string>();
    const r1 = t.open("child", "parent", 7, "permissionRequest");
    expect(isRelayRoute(r1)).toBe(true);
    expect(t.open("child", "parent", 7, "permissionRequest")).toBe(r1);
    const r2 = t.open("child", "parent", "q1", "questionRequest");
    expect(t.routeFor("child", "7")).toBe(r1);
    expect(t.resolve(r2)).toMatchObject({ child: "child", requestId: "q1" });
    expect(t.pendingFor("child")).toBe(2);
    expect(t.pendingIn("parent")).toHaveLength(2);
    t.close(r1);
    expect(t.pendingFor("child")).toBe(1);
    expect(t.closeChild("child").map((e) => e.route)).toEqual([r2]);
    expect(t.pendingFor("child")).toBe(0);
    expect(t.resolve(r2)).toBeUndefined();
    expect(t.resolve(42)).toBeUndefined();
  });

  it("labels the origin the way the plan names it", () => {
    expect(relayOriginLabel({ kind: "stage", name: "Implement", providerName: "Codex", model: "gpt-5" }))
      .toBe('Stage "Implement" · Codex · gpt-5');
    expect(relayOriginLabel({ kind: "subagent", name: "Map the auth flow", providerName: "Claude" }))
      .toBe('Subagent "Map the auth flow" · Claude');
    expect(childNeedsYouNotice("stage", "Implement", "permissionRequest")).toBe("Crew stage Implement needs your approval.");
  });

  it("offers every concrete grant scoped to the child first", () => {
    const out = childScopedSuggestions([
      { id: "path-src/a.ts", label: "src/a.ts", scope: "workspace", match: {} },
      { id: "cmd-session", label: "npm", scope: "session", match: {} },
    ]);
    expect(out.map((s) => `${s.id}:${s.scope}`)).toEqual([
      "cmd-session:session", "child-path-src/a.ts:session", "path-src/a.ts:workspace",
    ]);
  });
});

describe("fair clocks (X-04)", () => {
  it("pauses the subagent deadline while it waits for the person", () => {
    const d = new PausableDeadline(10_000, 0);
    expect(d.remainingMs(4000)).toBe(6000);
    d.pause(4000);
    expect(d.remainingMs(100_000)).toBe(6000);
    d.resume(100_000);
    expect(d.remainingMs(103_000)).toBe(3000);
    expect(d.expired(106_000)).toBe(true);
  });

  it("warns about a stalled stage only when it waits for nobody", () => {
    expect(stageStallState({ lastActivityAt: 0, now: 301_000, warnAfterMs: 300_000, needsYou: false })).toBe("stalled");
    expect(stageStallState({ lastActivityAt: 0, now: 301_000, warnAfterMs: 300_000, needsYou: true })).toBe("waiting");
    expect(stageStallState({ lastActivityAt: 0, now: 100_000, warnAfterMs: 300_000, needsYou: false })).toBe("active");
    expect(normalizeStallWarningSec(10)).toBe(60);
    expect(normalizeStallWarningSec(undefined)).toBe(300);
  });
});

function harness(provider: Session["provider"] = "codex", reason: "companion-subagent" | "crew-stage" = "companion-subagent") {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const parent = new Session();
  parent.provider = "grok";
  parent.activeSessionId = "parent-1";
  parent.status = "working";
  const child = new Session();
  child.provider = provider;
  child.activeSessionId = "child-1";
  child.pendingHiddenChild = {
    parentSessionId: "parent-1",
    subagentId: reason === "crew-stage" ? "run1:implement" : "sa_1",
    hiddenReason: reason,
    depth: 1,
  };
  const emitted: Array<{ to: Session; msg: any }> = [];
  sidebar.focused = parent;
  sidebar.pool = new Set([parent, child]);
  sidebar.emit = function (s: Session, msg: any) {
    emitted.push({ to: s, msg });
    if (!s.replaying) this.relayFromChild(s, msg);
  };
  sidebar.setStatus = (s: Session, st: any) => { s.status = st; };
  sidebar.sessionTypeMetaFor = () => undefined;
  Object.defineProperty(sidebar, "subagents", { value: { get: () => ({ label: "Map the auth flow" }) } });
  sidebar.postSubagentCard = vi.fn();
  sidebar.emitWorkflowRun = vi.fn();
  sidebar.host = { appendLine: vi.fn(), isWindowFocused: () => true, showInformationMessage: vi.fn() };
  sidebar.companionsSetting = (_k: string, d: unknown) => d;
  return { sidebar, parent, child, emitted };
}

describe("relay wiring in the host (X-01)", () => {
  it.each(["codex", "claude", "grok", "gemini"] as const)("a %s subagent's permission card reaches the parent and the answer goes back", (provider) => {
    const { sidebar, parent, child, emitted } = harness(provider);
    sidebar.emit(child, {
      type: "permissionRequest",
      req: { id: 5, sessionId: "child-1", toolCall: { toolCallId: "t", kind: "edit", title: "Edit src/auth.ts" }, options: [] },
      ruleSuggestions: [{ id: "path-src/auth.ts", label: "src/auth.ts", scope: "workspace", match: { kind: "edit", pathGlob: "src/auth.ts" } }],
    });
    const relayed = emitted.find((e) => e.to === parent && e.msg.type === "permissionRequest")!;
    expect(relayed).toBeTruthy();
    expect(isRelayRoute(relayed.msg.req.id)).toBe(true);
    expect(relayed.msg.origin.label).toContain('Subagent "Map the auth flow"');
    expect(relayed.msg.origin.scopeWord).toBe("this subagent");
    expect(relayed.msg.ruleSuggestions[0].scope).toBe("session");
    expect(parent.status).toBe("needs-you");
    expect(sidebar.postSubagentCard).toHaveBeenCalledWith(parent, "sa_1");

    const answer = sidebar.resolveRelayedAnswer({ type: "permissionAnswer", requestId: relayed.msg.req.id, optionId: "allow" });
    expect(answer.session).toBe(child);
    expect(answer.msg.requestId).toBe(5);

    // The child's own resolution closes the parent's card and restores its status.
    sidebar.emit(child, { type: "permissionResolved", requestId: 5, optionId: "allow" });
    const closed = emitted.find((e) => e.to === parent && e.msg.type === "permissionResolved")!;
    expect(closed.msg.requestId).toBe(relayed.msg.req.id);
    expect(parent.status).toBe("working");
    expect(sidebar.relayTable().pendingFor(child)).toBe(0);
  });

  it("relays questions and plan approvals from a crew stage, labelled as the stage", () => {
    const { sidebar, parent, child, emitted } = harness("claude", "crew-stage");
    sidebar.workflowState = { defs: new Map([["run1", { stages: [{ id: "implement", title: "Implement" }] }]]) };
    parent.workflowRun = { runId: "run1" } as any;
    sidebar.emit(child, { type: "questionRequest", req: { id: "q", sessionId: "c", questions: [] } });
    sidebar.emit(child, { type: "exitPlanRequest", req: { id: "p", sessionId: "c", plan: "do it" } });
    const q = emitted.find((e) => e.to === parent && e.msg.type === "questionRequest")!;
    const p = emitted.find((e) => e.to === parent && e.msg.type === "exitPlanRequest")!;
    expect(q.msg.origin.label).toBe('Stage "Implement" · Claude');
    expect(q.msg.origin.scopeWord).toBe("this stage");
    expect(p.msg.origin.kind).toBe("stage");
    expect(sidebar.emitWorkflowRun).toHaveBeenCalledWith(parent);
  });

  it("does not relay for a visible session, and closes open cards when the child ends", () => {
    const { sidebar, parent, child, emitted } = harness();
    sidebar.emit(parent, { type: "permissionRequest", req: { id: 1, sessionId: "p", toolCall: { toolCallId: "x", kind: "edit", title: "t" }, options: [] } });
    expect(emitted.filter((e) => e.msg.type === "permissionRequest")).toHaveLength(1);
    sidebar.emit(child, { type: "questionRequest", req: { id: "q2", sessionId: "c", questions: [] } });
    sidebar.closeChildRelays(child);
    expect(emitted.some((e) => e.to === parent && e.msg.type === "questionResolved" && e.msg.outcome === "closed")).toBe(true);
    expect(parent.status).toBe("working");
  });

  it("notifies once through the OS when the window is not focused", async () => {
    const { sidebar, child } = harness();
    sidebar.host.isWindowFocused = () => false;
    sidebar.host.showInformationMessage = vi.fn(async () => undefined);
    sidebar.emit(child, { type: "questionRequest", req: { id: "q3", sessionId: "c", questions: [] } });
    expect(sidebar.host.showInformationMessage).toHaveBeenCalledWith('Subagent "Map the auth flow" has a question.', "Show");
  });

  it("pauses a subagent's time limit while it waits for the person", () => {
    const { sidebar, child } = harness();
    sidebar.subagentDeadlines = new Map([["sa_1", new PausableDeadline(60_000, Date.now())]]);
    sidebar.emit(child, { type: "questionRequest", req: { id: "q4", sessionId: "c", questions: [] } });
    expect(sidebar.subagentDeadlines.get("sa_1").paused).toBe(true);
    sidebar.emit(child, { type: "questionResolved", requestId: "q4", outcome: "accepted" });
    expect(sidebar.subagentDeadlines.get("sa_1").paused).toBe(false);
    sidebar.clearSubagentDeadline("sa_1");
  });
});

describe("webview: relayed cards (X-01)", () => {
  it("labels the card with its origin and scopes the session grant to the child", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: "relay-1", sessionId: "s", options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        toolCall: { toolCallId: "t1", kind: "edit", title: "Edit src/auth.ts" },
      },
      ruleSuggestions: [{ id: "child-x", label: "src/auth.ts", scope: "session", match: { kind: "edit", pathGlob: "src/auth.ts" } }],
      origin: { kind: "stage", label: 'Stage "Implement" · Codex · gpt-5', route: "relay-1", scopeWord: "this stage" },
    } as never);
    const card = doc.querySelector(".card.permission.card--relayed") as HTMLElement;
    expect(card.querySelector(".card-origin")!.textContent).toContain('Stage "Implement" · Codex · gpt-5');
    expect(card.textContent).toContain("this stage");
    click(window, card.querySelector(".perm-rule-suggestion") as HTMLElement);
    expect(posted.find((p: any) => p.type === "permissionAnswer")).toMatchObject({
      requestId: "relay-1", ruleScope: "session",
    });
  });

  it("shows Needs you on the stage row and the subagent card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s", sessionType: "crew", locked: true } as never);
    dispatch(window, {
      type: "workflowRun",
      run: {
        runId: "r", idea: "x", workflowName: "idea-to-done", workflowTitle: "Idea to done", status: "running",
        subtitle: "", waitingForYou: true, currentStageId: "implement",
        stages: [{ id: "plan", title: "Plan", status: "done", ordinal: 1, sessionId: "s1" }, { id: "implement", title: "Implement", status: "needs-you" }],
      },
    } as never);
    expect(doc.body.textContent).toContain("Needs you");
    expect(doc.body.textContent).toContain("Waiting for you");
    dispatch(window, {
      type: "companionSubagent", subagentId: "sa", label: "Scan", provider: "codex", providerName: "Codex",
      profile: "scoped-edit", profileLabel: "edits", status: "running", startedAt: Date.now(),
      modelVerified: true, sameProviderAsParent: false, needsYou: true,
    } as never);
    expect(doc.body.textContent).toContain("Waiting for you — timer paused");
  });
});
