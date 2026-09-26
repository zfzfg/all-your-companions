// A parent turn that spawned background subagents stays `working` until the
// last child is terminal. `holdTurnForSubagents` records the hold and returns
// before `agentEnd`; `maybeFinishSubagentTurn` is what releases it.
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function harness(live: boolean, uncollected: { subagentId: string }[] = []) {
  const posted: unknown[] = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.currentTurnId = () => "turn-1";
  sidebar.postSubagentTray = vi.fn();
  sidebar.reportUnfollowedDirectives = vi.fn();
  sidebar.emit = (_session: Session, message: unknown) => { posted.push(message); };
  sidebar.noteLiveTurnEnded = vi.fn();
  sidebar.setStatus = vi.fn();
  sidebar.noteSessionActivity = vi.fn();
  sidebar.turnEndFields = () => ({ status: "completed" });
  sidebar.setProviderNeedsLogin = vi.fn();
  sidebar.maybeGenerateTitle = vi.fn();
  sidebar.postSessionName = vi.fn();
  // `subagents` is a getter over this store. A direct assignment throws.
  sidebar.subagentState = {
    registry: {
      turnHasLiveChildren: () => live,
      uncollectedFinished: () => uncollected,
      update: vi.fn(),
    },
    reports: new Map(),
    waiters: new Map(),
    outcomes: new Map(),
  };
  const session = new Session();
  session.activeSessionId = "parent";
  session.provider = "grok";
  session.status = "working";
  session.subagentTurnHold = { turnId: "turn-1", meta: { stopReason: "end_turn" } };
  return { sidebar, session, posted };
}

describe("a turn held for background subagents ends when the last child settles", () => {
  it("keeps the hold while a child is still running", () => {
    const { sidebar, session, posted } = harness(true);
    sidebar.maybeFinishSubagentTurn(session);
    expect(session.subagentTurnHold).toEqual({ turnId: "turn-1", meta: { stopReason: "end_turn" } });
    expect(posted).toEqual([]);
    expect(sidebar.setStatus).not.toHaveBeenCalled();
  });

  it("emits agentEnd and marks the session done when nothing is left running", () => {
    const { sidebar, session, posted } = harness(false);
    sidebar.maybeFinishSubagentTurn(session);
    expect(session.subagentTurnHold).toBeUndefined();
    expect(posted).toEqual([{
      type: "agentEnd",
      meta: { stopReason: "end_turn" },
      status: "completed",
    }]);
    expect(sidebar.setStatus).toHaveBeenCalledWith(session, "done");
    expect(sidebar.noteLiveTurnEnded).toHaveBeenCalledWith(session);
    expect(sidebar.setProviderNeedsLogin).toHaveBeenCalledWith("grok", false);
    expect(sidebar.maybeGenerateTitle).toHaveBeenCalledWith(session);
    expect(session.authRecoveryTried).toBe(false);
  });

  it("still ends the turn when the follow-up notice for uncollected children is posted", () => {
    const record = { subagentId: "child-1", label: "Auth inspector" };
    const { sidebar, session, posted } = harness(false, [record]);
    sidebar.maybeFinishSubagentTurn(session);
    expect(posted[0]).toMatchObject({ type: "hostNotice", level: "info" });
    expect(posted[1]).toMatchObject({ type: "agentEnd" });
    expect(sidebar.subagents.update).toHaveBeenCalledWith("child-1", { collected: true }, expect.any(Number));
    expect(session.status).toBe("working");
    expect(sidebar.setStatus).toHaveBeenCalledWith(session, "done");
  });

  it("does not end a newer turn that started while children were still running", () => {
    const { sidebar, session, posted } = harness(false);
    session.turnToken = {};
    sidebar.maybeFinishSubagentTurn(session);
    expect(session.subagentTurnHold).toBeUndefined();
    expect(posted).toEqual([]);
    expect(sidebar.setStatus).not.toHaveBeenCalled();
  });
});
