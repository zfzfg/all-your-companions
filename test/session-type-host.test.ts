/**
 * AP-15 session type — the HOST half.
 *
 * `test/session-type.test.ts` covers the pure decisions and
 * `test/session-type.dom.test.ts` covers what the webview draws. This file
 * covers the part neither can: that the host is the authority (§5.6), that the
 * type reaches `grok.sessionMeta` under the id the CLI hands out, and that a
 * session restored from a record without one reads as a locked Agent session
 * without writing anything (ST-3).
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import type { SessionMetaOverrides } from "../src/sessions";

const SESSION_META_KEY = "grok.sessionMeta";

function makeSidebar(configuredDefault = "agent") {
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
    getConfiguration: vi.fn(() => ({ get: (_k: string, fallback: unknown) => configuredDefault ?? fallback })),
  };
  sidebar.sessionCache = new Map();
  sidebar.emit = vi.fn((_session: Session, message: HostMsg) => { emitted.push(message); });
  return {
    sidebar,
    emitted,
    meta: () => (memento[SESSION_META_KEY] ?? {}) as SessionMetaOverrides,
    setMeta: (value: SessionMetaOverrides) => { memento[SESSION_META_KEY] = value; },
  };
}

const typeMessages = (emitted: HostMsg[]) =>
  emitted.filter((m): m is Extract<HostMsg, { type: "sessionType" }> => m.type === "sessionType");

describe("session type — host authority and persistence (AP-15)", () => {
  it("starts a new session as the configured default", () => {
    const { sidebar } = makeSidebar("crew");
    expect(sidebar.newLocalSession().sessionType).toBe("crew");
  });

  it("falls back to Agent rather than throwing when the setting cannot be read", () => {
    // A setting must never be able to stop a session from being created.
    const { sidebar } = makeSidebar();
    sidebar.host.getConfiguration = vi.fn(() => { throw new Error("no configuration provider"); });
    expect(sidebar.newLocalSession().sessionType).toBe("agent");
  });

  it("accepts a pre-lock switch and tells the webview", () => {
    const { sidebar, emitted } = makeSidebar();
    const session = new Session();
    sidebar.setSessionType(session, "crew");
    expect(session.sessionType).toBe("crew");
    expect(typeMessages(emitted).at(-1)).toEqual({
      type: "sessionType", sessionId: "", sessionType: "crew", locked: false,
    });
  });

  it("refuses a forged switch after the lock and re-asserts the truth", () => {
    // §5.6: the webview hides the control, but the host is what enforces it.
    const { sidebar, emitted } = makeSidebar();
    const session = new Session();
    session.activeSessionId = "s-1";
    session.sessionType = "agent";
    session.sessionTypeLockedAt = 1;
    sidebar.setSessionType(session, "crew");
    expect(session.sessionType).toBe("agent");
    const notice = emitted.find((m) => m.type === "hostNotice");
    expect(notice).toMatchObject({
      level: "warning",
      text: "This session is locked to Agent mode. Start a new session to use Crew.",
    });
    expect(typeMessages(emitted).at(-1)).toMatchObject({ sessionType: "agent", locked: true });
  });

  it("refuses a switch on a session that has already sent a message", () => {
    const { sidebar } = makeSidebar();
    const session = new Session();
    session.userMessageCount = 1;
    sidebar.setSessionType(session, "crew");
    expect(session.sessionType).toBe("agent");
  });

  it("refuses an unknown type, including the removed prototype's vocabulary", () => {
    const { sidebar, emitted } = makeSidebar();
    const session = new Session();
    sidebar.setSessionType(session, "single");
    expect(session.sessionType).toBe("agent");
    expect(emitted.find((m) => m.type === "hostNotice")).toMatchObject({ text: "Unknown session type." });
  });

  it("writes nothing before the CLI has named the session", () => {
    // `grok.sessionMeta` is keyed by the provider's id; there is nothing to key
    // against yet, so the runtime field is the store until there is.
    const { sidebar, meta } = makeSidebar();
    const session = new Session();
    sidebar.setSessionType(session, "crew");
    expect(meta()).toEqual({});
  });

  it("persists the type once the session has an id", () => {
    const { sidebar, meta } = makeSidebar();
    const session = new Session();
    sidebar.setSessionType(session, "crew");
    session.activeSessionId = "s-1";
    sidebar.persistSessionType(session);
    expect(meta()["s-1"]).toMatchObject({ sessionType: "crew" });
    expect(meta()["s-1"].sessionTypeLockedAt).toBeUndefined();
  });

  it("stamps the lock once and persists it", () => {
    const { sidebar, meta } = makeSidebar();
    const session = new Session();
    session.activeSessionId = "s-1";
    session.sessionType = "crew";
    sidebar.lockSessionTypeNow(session);
    const first = session.sessionTypeLockedAt;
    expect(typeof first).toBe("number");
    sidebar.lockSessionTypeNow(session);
    expect(session.sessionTypeLockedAt).toBe(first);
    expect(meta()["s-1"]).toMatchObject({ sessionType: "crew", sessionTypeLockedAt: first });
  });

  it("keeps unrelated metadata when it writes the type", () => {
    const { sidebar, meta, setMeta } = makeSidebar();
    setMeta({ "s-1": { customName: "My session", pinnedAt: 7 } });
    const session = new Session();
    session.activeSessionId = "s-1";
    session.sessionType = "crew";
    sidebar.persistSessionType(session);
    expect(meta()["s-1"]).toMatchObject({ customName: "My session", pinnedAt: 7, sessionType: "crew" });
  });

  it("restores a stored Crew session, lock and all", () => {
    const { sidebar, emitted, setMeta } = makeSidebar();
    setMeta({ "s-1": { sessionType: "crew", sessionTypeLockedAt: 42 } });
    const session = new Session();
    session.activeSessionId = "s-1";
    sidebar.restoreSessionType(session);
    expect(session.sessionType).toBe("crew");
    expect(session.sessionTypeLockedAt).toBe(42);
    expect(typeMessages(emitted).at(-1)).toMatchObject({ sessionType: "crew", locked: true });
  });

  it("reads a pre-AP-15 record as a locked Agent session and writes nothing", () => {
    // ST-3. Every session that existed before this feature takes this path.
    const { sidebar, meta, setMeta, emitted } = makeSidebar();
    setMeta({ "s-old": { customName: "Old work" } });
    const session = new Session();
    session.activeSessionId = "s-old";
    session.hasHistory = true;
    sidebar.restoreSessionType(session);
    expect(session.sessionType).toBe("agent");
    expect(typeMessages(emitted).at(-1)).toMatchObject({ sessionType: "agent", locked: true });
    expect(meta()["s-old"]).toEqual({ customName: "Old work" });
  });
});
