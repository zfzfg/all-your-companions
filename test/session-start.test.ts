/**
 * SessionStart (W-15 Schritt D9): startup refusal and the send backstop.
 * The host still owns the real process spawn; these tests pin the seams that
 * moved out of sidebar.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSessionStart,
  type SessionStartDeps,
} from "../src/session-start";
import { Session } from "../src/session";

function makeStart() {
  const lines: string[] = [];
  const emitted: Array<{ type: string }> = [];
  const handleAgentCommand = vi.fn(async () => true as boolean | void);
  const ensureClient = vi.fn(async () => undefined);
  const presentEmptyProjectState = vi.fn();
  const postRepoCatalog = vi.fn();
  const postSessionsList = vi.fn();
  const session = new Session();
  const deps = {
    host: {
      canSwitchWorkspaceFolder: true,
      appendLine: (line: string) => { lines.push(line); },
    },
    state: { get: () => ({}), update: async () => {} },
    emit: (_session: Session, msg: { type: string }) => { emitted.push(msg); },
    post: () => {},
    sessionCwd: () => "/work",
    workspaceRoot: () => "/work",
    getFocused: () => session,
    getPool: () => new Set<Session>(),
    touch: () => {},
    reapPool: () => {},
    setStatus: () => {},
    noteSessionActivity: () => {},
    noteLiveTurnEnded: () => {},
    terminalManager: {},
    workspaceOps: {
      openWorkspaceFolders: () => ["/work"],
      isAuthorizedCwd: () => true,
      presentEmptyProjectState,
      postRepoCatalog,
      postSessionsList,
      postSessionName: () => {},
      updateSessionMeta: async () => {},
      sessionCacheDelete: () => {},
      findWorkspaceSensitiveFiles: () => [],
    },
    providerOps: {},
    reviewAndPlanOps: {},
    turnAndSendOps: { ensureClient },
    sessionLifecycleOps: {

},
usageOps: {

},
eventOps: {

},
    workflowCommandsOps: { handleAgentCommand },
    flags: {},
  } as unknown as SessionStartDeps;
  return {
    start: createSessionStart(deps),
    session,
    lines,
    emitted,
    deps,
    handleAgentCommand,
    ensureClient,
    presentEmptyProjectState,
    postRepoCatalog,
    postSessionsList,
  };
}

describe("SessionStart", () => {
  it("keeps the context interface at or under 25 members", () => {
    const { deps } = makeStart();
    expect(Object.keys(deps).length).toBeLessThanOrEqual(25);
  });

  it("serializes a second startup behind the first for the same session", async () => {
    const { start, session } = makeStart();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = start.runExclusiveSessionStart(session, async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return 1;
    });
    const second = start.runExclusiveSessionStart(session, async () => {
      order.push("second");
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("refuses a closed folder before any provider work", async () => {
    const h = makeStart();
    h.deps.workspaceOps.isAuthorizedCwd = () => false;
    h.session.cwd = "/closed";
    const client = await h.start.startSession(undefined, h.session);
    expect(client).toBeUndefined();
    expect(h.lines.join("\n")).toContain("refused startSession (cwd not authorized)");
    expect(h.postRepoCatalog).toHaveBeenCalled();
    expect(h.postSessionsList).toHaveBeenCalled();
    expect(h.emitted).toContainEqual({ type: "setBusy", value: false });
  });

  it("shows the empty-project state when nothing is open", async () => {
    const h = makeStart();
    h.deps.workspaceOps.openWorkspaceFolders = () => [];
    const client = await h.start.startSession(undefined, h.session);
    expect(client).toBeUndefined();
    expect(h.presentEmptyProjectState).toHaveBeenCalledWith(h.session);
  });

  it("answers /agent in the send backstop before waiting for startup", async () => {
    const h = makeStart();
    await h.start.handleSend("/agent researcher find it", false, h.session);
    expect(h.handleAgentCommand).toHaveBeenCalledWith("/agent researcher find it", h.session);
    expect(h.ensureClient).not.toHaveBeenCalled();
  });
});
