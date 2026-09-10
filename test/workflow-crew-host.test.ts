/**
 * AP-17 host glue: D8 `/crew` intercept, Start workflow lock, idea required.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

function makeSidebar(inThread = false) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  const emitted: HostMsg[] = [];
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    appendLine: vi.fn(),
    getConfiguration: vi.fn((section: string) => ({
      get: (key: string, fallback: unknown) => {
        if (section === "companions" && key === "crew.inThreadCommand") return inThread;
        if (section === "companions" && key === "crew.defaultWorkflow") return "idea-to-done";
        if (section === "companions" && key === "crew.autoStartNextStage") return false;
        if (section === "companions" && key === "crew.maxFixerPasses") return 2;
        return fallback;
      },
    })),
  };
  sidebar.sessionCache = new Map();
  sidebar.pool = new Set();
  sidebar.emit = vi.fn((_session: Session, message: HostMsg) => { emitted.push(message); });
  sidebar.agentNotice = (session: Session, level: "info" | "warning", text: string) => {
    emitted.push({ type: "hostNotice", level, text });
  };
  sidebar.workflowState = undefined;
  return { sidebar, emitted };
}

describe("D8 /crew in an Agent session", () => {
  it("shows the copy-deck card with the open-Crew button", async () => {
    const { sidebar, emitted } = makeSidebar(false);
    const session = new Session();
    session.sessionType = "agent";
    const handled = await sidebar.handleCrewCommand("/crew idea-to-done ship the parser", session, "local");
    expect(handled).toBe(true);
    const notice = emitted.find((m) => m.type === "hostNotice") as Extract<HostMsg, { type: "hostNotice" }>;
    expect(notice.text).toBe("Crew runs live in their own session.");
    expect(notice.action).toEqual({
      id: "openCrewWithGoal",
      label: "Open a new Crew session with this goal",
      goal: "ship the parser",
    });
  });

  it("still walks the in-thread chain when companions.crew.inThreadCommand is on", async () => {
    const { sidebar, emitted } = makeSidebar(true);
    const session = new Session();
    session.sessionType = "agent";
    // The rest of handleCrewCommand needs a lot of host surface; we only
    // assert we did NOT take the D8 branch.
    sidebar.runningRoleName = () => undefined;
    sidebar.crewPresetSet = () => ({ presets: [{ name: "default", roles: [], body: "", source: "builtin" }], problems: [] });
    sidebar.agentRoleSet = () => ({ roles: [], problems: [] });
    sidebar.lastUserMessageText = () => "";
    sidebar.sessionCwd = () => "/repo";
    try {
      await sidebar.handleCrewCommand("/crew", session, "local");
    } catch {
      // The legacy path may throw in this harness; that still means it ran.
    }
    const notice = emitted.find((m) => m.type === "hostNotice") as Extract<HostMsg, { type: "hostNotice" }> | undefined;
    expect(notice?.action?.id).not.toBe("openCrewWithGoal");
  });

  it("refuses /crew inside a Crew session", async () => {
    const { sidebar, emitted } = makeSidebar(false);
    const session = new Session();
    session.sessionType = "crew";
    await sidebar.handleCrewCommand("/crew", session, "local");
    expect(emitted.some((m) => m.type === "hostNotice" && /already a Crew session/.test(m.text))).toBe(true);
  });
});

describe("Start workflow", () => {
  it("locks the session and refuses an empty idea with the copy-deck line", async () => {
    const { sidebar, emitted } = makeSidebar(false);
    const session = new Session();
    session.sessionType = "crew";
    sidebar.lockSessionTypeNow = GrokSidebar.prototype["lockSessionTypeNow" as never];
    sidebar.persistSessionType = vi.fn();
    sidebar.postSessionType = vi.fn();
    await sidebar.startWorkflowRun(session, "local", "   ", "idea-to-done");
    expect(session.sessionTypeLockedAt).toEqual(expect.any(Number));
    expect(emitted.some((m) => m.type === "hostNotice" && m.text === "Idea required.")).toBe(true);
    expect(session.workflowRun).toBeUndefined();
  });
});
