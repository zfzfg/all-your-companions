import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const card = (over: Record<string, unknown> = {}) => ({
  type: "companionSubagent", subagentId: "sa_1", label: "Survey",
  provider: "gemini", providerName: "Antigravity", profile: "read-only",
  status: "running", startedAt: 1000, modelVerified: true, sessionId: "child",
  ...over,
});
const user = (text: string) => ({ type: "userMessage", text, chips: [] });
const activity = (over: Record<string, unknown> = {}) => ({
  type: "childActivity", owner: { kind: "subagent", id: "sa_1" },
  items: [{ kind: "prose", text: "Inspecting adapters" }], lastLine: "Inspecting adapters",
  ...over,
});
const order = (doc: Document) => [...doc.querySelectorAll("#messages > .msg.user, #messages > .companion-subagent")]
  .map((el) => el.classList.contains("user") ? el.querySelector(".body")!.textContent!.trim() : "subagent");
const history = (window: Window) => (window as unknown as { __grokHistory: { expandAll(): void } }).__grokHistory;

describe("subagent transcript switches", () => {
  it("keeps the card at its original position across repeated parent/child switches", () => {
    const { window, doc, posted } = bootWebview();
    const frames = [user("Inspect fork"), { type: "agentStart" }, card(), user("Next task")];
    for (const frame of frames) dispatch(window, frame);
    for (let i = 0; i < 3; i++) {
      click(window, doc.querySelector('[data-action="openTranscript"]')!);
      expect(posted.at(-1)).toMatchObject({ type: "companionSubagentAction", action: "openTranscript", subagentId: "sa_1" });
      dispatch(window, { type: "clearMessages" });
      dispatch(window, { type: "historyReplay", active: true });
      dispatch(window, user("Child brief"));
      dispatch(window, { type: "historyReplay", active: false });
      dispatch(window, { type: "clearMessages" });
      dispatch(window, { type: "historyReplay", active: true });
      for (const frame of frames) dispatch(window, frame);
      dispatch(window, card({ status: "completed", endedAt: 2000, summary: "Done" }));
      dispatch(window, { type: "historyReplay", active: false });
      expect(order(doc)).toEqual(["Inspect fork", "subagent", "Next task"]);
      expect(doc.querySelectorAll(".companion-subagent")).toHaveLength(1);
      expect(doc.querySelector(".companion-status")!.textContent).toContain("done");
    }
  });

  it("keeps a paginated card beside its original turn, with the newest status", () => {
    const { window, doc } = bootWebview();
    (window as unknown as { __grokHistoryWindow: number }).__grokHistoryWindow = 1;
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, user("Old task"));
    dispatch(window, card());
    dispatch(window, card({ needsYou: true }));
    dispatch(window, user("Recent task"));
    dispatch(window, card({ status: "completed", endedAt: 3000, summary: "Latest result" }));
    dispatch(window, { type: "historyReplay", active: false });
    expect(order(doc)).toEqual(["Recent task"]);
    // A live update must update the unloaded card, not create a second one.
    dispatch(window, card({ status: "completed", endedAt: 3000, summary: "Updated result", promotable: true }));
    history(window).expandAll();
    expect(order(doc)).toEqual(["Old task", "subagent", "Recent task"]);
    expect(doc.querySelectorAll(".companion-subagent")).toHaveLength(1);
    expect(doc.querySelector(".subagent-result")!.textContent).toContain("Updated result");
    expect(doc.querySelector(".companion-status")!.textContent).toContain("done");
  });

  it("resets the running tray when leaving the parent and restores it on return", () => {
    const { window, doc } = bootWebview();
    const tray = { type: "subagentTray", subagents: [{ subagentId: "sa_1", label: "Survey", provider: "gemini", startedAt: 1000 }] };
    dispatch(window, tray);
    dispatch(window, { type: "clearMessages" });
    expect((doc.getElementById("subagent-tray") as HTMLElement).hidden).toBe(true);
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, user("Parent"));
    dispatch(window, card());
    dispatch(window, tray);
    dispatch(window, { type: "historyReplay", active: false });
    expect((doc.getElementById("subagent-tray") as HTMLElement).hidden).toBe(false);
    expect(doc.querySelectorAll(".subagent-tray-row")).toHaveLength(1);
  });

  it("replaces an activity snapshot without duplicating prose, and leaves terminal cards quiet", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card());
    dispatch(window, activity());
    dispatch(window, activity({ replace: true }));
    dispatch(window, activity({ replace: true }));
    expect(doc.querySelector(".child-activity-lines")!.textContent).toBe("Inspecting adapters");
    dispatch(window, card({ status: "completed", endedAt: 2000 }));
    dispatch(window, activity({ replace: true }));
    expect(doc.querySelector(".companion-subagent .child-activity")).toBeNull();
  });

  it("clears the previous result when a completed child starts a follow-up", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card({ status: "completed", endedAt: 2000, summary: "Old answer" }));
    dispatch(window, card());
    const el = doc.querySelector(".companion-subagent")!;
    expect(el.classList.contains("subagent-done")).toBe(false);
    expect((el.querySelector(".subagent-result") as HTMLElement).hidden).toBe(true);
    expect(el.textContent).not.toContain("Old answer");
  });

  it("replays an approval in order and keeps it resolved when older turns are loaded", () => {
    const { window, doc } = bootWebview();
    (window as unknown as { __grokHistoryWindow: number }).__grokHistoryWindow = 1;
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, user("Request delegation"));
    dispatch(window, { type: "subagentApproval", id: "approval-1", label: "Survey", task: "Inspect", provider: "gemini", profile: "read-only" });
    dispatch(window, { type: "subagentApprovalResolved", id: "approval-1", approved: true });
    dispatch(window, user("Next request"));
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".subagent-approval")).toBeNull();
    history(window).expandAll();
    const approval = doc.querySelector(".subagent-approval")!;
    expect(approval.classList.contains("resolved")).toBe(true);
    const sequence = [...doc.querySelectorAll("#messages > .msg.user, #messages > .subagent-approval")];
    expect(sequence[1]).toBe(approval);
  });

  it("keeps delegation notices in transcript order on return", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, user("Inspect"));
    dispatch(window, { type: "hostNotice", level: "info", text: "Starting the requested subagent" });
    dispatch(window, card());
    dispatch(window, { type: "historyReplay", active: false });
    const sequence = [...doc.querySelectorAll("#messages > .msg.user, #messages > .host-notice, #messages > .companion-subagent")];
    expect(sequence.map((el) => el.classList.contains("user") ? "user" : el.classList.contains("host-notice") ? "notice" : "subagent"))
      .toEqual(["user", "notice", "subagent"]);
  });

  it("paints activity on an unloaded running card when its older turn is expanded", () => {
    const { window, doc } = bootWebview();
    (window as unknown as { __grokHistoryWindow: number }).__grokHistoryWindow = 1;
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, user("Original task"));
    dispatch(window, card());
    dispatch(window, user("Latest task"));
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, activity({ replace: true }));
    history(window).expandAll();
    expect(doc.querySelectorAll(".companion-subagent")).toHaveLength(1);
    expect(doc.querySelector(".companion-subagent .child-activity-lines")!.textContent).toBe("Inspecting adapters");
  });
});
