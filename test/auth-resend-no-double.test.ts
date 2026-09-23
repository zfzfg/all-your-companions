/**
 * The prompt that appeared twice.
 *
 * Owner, 2026-09-14: "Anthropic started doubling my prompts". His screenshot
 * shows one bubble reading "HeyHey" and two more reading "Hey".
 *
 * `recoverAuthAndResend` restarts the session to get a process holding the
 * current disk token. That restart is `startSession(resumeId)`, which wipes the
 * transcript and replays it from the AGENT's record — and Claude writes the
 * user turn before the call it then refuses, so the replay puts the prompt back
 * on screen. The recovery then re-emitted its own copy on top.
 *
 * Which copy exists is agent- and timing-dependent (grok 0.2.3 echoed nothing
 * back at all), so neither side can simply be deleted. The transcript itself
 * says which happened: a replay that ends ON a user turn is a refused turn.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

/** A client whose resend succeeds, so the test is only about what was drawn. */
class Reviving {
  sessionId = "s1";
  provider = "claude";
  isCredentialError(): boolean { return true; }
  async prompt(): Promise<Record<string, never>> { return {}; }
}

function recovering(replayEndsWith?: string) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.startTurnDiffBaseline = vi.fn();
  sidebar.pendingTurnDiffCaptures = new WeakSet();
  const session = new Session();
  session.provider = "claude";
  session.activeSessionId = "s1";
  session.hasHistory = true;
  session.client = { sessionId: "s1", isCredentialError: () => true,
    prompt: vi.fn(async () => { throw new Error("Authentication required"); }) } as any;

  sidebar.host = { appendLine: vi.fn() };
  sidebar.emit = vi.fn();
  sidebar.post = vi.fn();
  sidebar.setStatus = vi.fn();
  sidebar.noteLiveTurnEnded = vi.fn();
  sidebar.maybeGenerateTitle = vi.fn();
  sidebar.postSessionName = vi.fn();
  sidebar.setProviderNeedsLogin = vi.fn();
  sidebar.onboardingForSession = vi.fn(() => "claude-login");
  // The restart, standing in for what session/load leaves behind.
  sidebar.startSession = vi.fn(async () => {
    if (replayEndsWith !== undefined) {
      session.inUserMessage = true;
      session.replayUserRaw = replayEndsWith;
      session.userMessageCount += 1; // the replay counts what it restored
    }
    session.client = new Reviving() as any;
    return session.client;
  });
  return { sidebar, session };
}

const bubbles = (sidebar: any): string[] => sidebar.emit.mock.calls
  .filter(([, msg]: [unknown, any]) => msg?.type === "userMessage")
  .map(([, msg]: [unknown, any]) => msg.text);

describe("a resend after the token dance", () => {
  it("does not draw the prompt again when the replay already restored it", async () => {
    const { sidebar, session } = recovering("Hey");

    await sidebar.recoverAuthAndResend(session, new Error("Authentication required"), "Hey", [], []);

    expect(bubbles(sidebar)).toEqual([]);
    expect(session.userMessageCount).toBe(1); // counted once, by the replay
  });

  // grok 0.2.3 echoed nothing back, and an agent can refuse before it records
  // anything. Deleting the re-emit outright would lose the prompt there.
  it("draws it when the replay did not bring it back", async () => {
    const { sidebar, session } = recovering();

    await sidebar.recoverAuthAndResend(session, new Error("Authentication required"), "Hey", [], []);

    expect(bubbles(sidebar)).toEqual(["Hey"]);
    expect(session.userMessageCount).toBe(1);
  });

  // A transcript ending on a REPLY is a turn that completed. The user text
  // further up belongs to an older turn and says nothing about this one.
  it("draws it when the transcript ends on something other than our turn", async () => {
    const { sidebar, session } = recovering("an older question");

    await sidebar.recoverAuthAndResend(session, new Error("Authentication required"), "Hey", [], []);

    expect(bubbles(sidebar)).toEqual(["Hey"]);
  });

  it("treats a reply after the user turn as the turn being over", async () => {
    const { sidebar, session } = recovering("Hey");
    const started = sidebar.startSession;
    sidebar.startSession = vi.fn(async (...args: unknown[]) => {
      const client = await started(...args);
      session.inUserMessage = false; // an assistant chunk followed it
      return client;
    });

    await sidebar.recoverAuthAndResend(session, new Error("Authentication required"), "Hey", [], []);

    expect(bubbles(sidebar)).toEqual(["Hey"]);
  });
});
