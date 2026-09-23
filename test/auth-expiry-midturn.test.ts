/**
 * An account whose sign-in dies DURING a conversation.
 *
 * `recoverAuthAndResend` already handled the recoverable half — a stale token
 * in a long-lived process, fixed by a fresh process and one replay. What it did
 * not do was tell the rest of the app when that failed, and the rest of the app
 * is where every sign-in affordance lives: the gear's account row, the model
 * picker, Settings, and (since 2026-09-14) the card above the composer.
 *
 * The overlay it posted instead is the EMPTY-STATE card, and the renderer
 * refuses to paint that over a live conversation on purpose — which is the only
 * situation this code runs in. So on a phone the entire guidance was the
 * vendor's own "Authentication required" in red, three times over, with no
 * mention of signing in anywhere on the page (owner, from a phone, 2026-09-14).
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

class Dead {
  constructor(private readonly credential: boolean) {}
  sessionId = "s1";
  provider = "claude";
  isCredentialError(): boolean { return this.credential; }
  async prompt(): Promise<never> { throw new Error("Authentication required"); }
}

function makeSidebar(opts: { credential?: boolean; tried?: boolean } = {}) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.startTurnDiffBaseline = vi.fn();
  sidebar.pendingTurnDiffCaptures = new WeakSet();
  const flagged: [string, boolean][] = [];
  sidebar.setProviderNeedsLogin = vi.fn((provider: string, needsLogin: boolean) => {
    flagged.push([provider, needsLogin]);
  });
  sidebar.host = { appendLine: vi.fn() };
  sidebar.emit = vi.fn();
  sidebar.post = vi.fn();
  sidebar.setStatus = vi.fn();
  sidebar.noteLiveTurnEnded = vi.fn();
  sidebar.onboardingForSession = vi.fn(() => "claude-login");
  sidebar.startSession = vi.fn(async () => undefined);

  const session = new Session();
  session.provider = "claude";
  session.activeSessionId = "s1";
  session.authRecoveryTried = opts.tried === true;
  session.client = new Dead(opts.credential !== false) as any;
  return { sidebar, session, flagged };
}

const refused = new Error("Authentication required");

describe("a credential that dies mid-conversation", () => {
  // The send a person makes while wondering why nothing works. One recovery is
  // claimed per failure streak, so the second and every later send declines
  // here — and before this they declined SILENTLY, leaving the account looking
  // healthy everywhere the app offers a sign-in.
  it("flags the account when the one recovery has already been spent", async () => {
    const { sidebar, session, flagged } = makeSidebar({ tried: true });

    const handled = await sidebar.recoverAuthAndResend(session, refused, "Hey", [], []);

    expect(handled).toBe(false); // the caller still shows the error itself
    expect(flagged).toEqual([["claude", true]]);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  // Entitlement and billing wording is auth-SHAPED and is not a signed-out
  // account: a sign-in cannot fix a 403, and labelling the account signed-out
  // sends the person through a login that changes nothing (#58).
  it("does not label an account signed-out for a failure a sign-in cannot fix", async () => {
    const { sidebar, session, flagged } = makeSidebar({ credential: false, tried: true });

    await sidebar.recoverAuthAndResend(session, new Error("Your plan does not include this model"), "Hey", [], []);

    expect(flagged).toEqual([]);
  });

  // Not auth-shaped at all: recovery declines before it ever classifies, and
  // nothing about the account has been learned.
  it("says nothing about the account for an ordinary failure", async () => {
    const { sidebar, session, flagged } = makeSidebar({ credential: false });

    const handled = await sidebar.recoverAuthAndResend(session, new Error("connection reset"), "Hey", [], []);

    expect(handled).toBe(false);
    expect(flagged).toEqual([]);
    expect(session.authRecoveryTried).toBe(false); // the recovery is still unspent
  });

  // The first send's own path: a FRESH process with the current disk token was
  // refused too, so the credential is genuinely dead and the honest ask is a
  // sign-in. This is the failure the owner was looking at.
  it("flags the account when a fresh process is refused as well", async () => {
    const { sidebar, session, flagged } = makeSidebar();
    sidebar.startSession = vi.fn(async () => {
      session.client = new Dead(true) as any;
      return session.client;
    });

    const handled = await sidebar.recoverAuthAndResend(session, refused, "Hey", [], []);

    expect(handled).toBe(true); // it reported the error itself
    expect(flagged).toEqual([["claude", true]]);
    // The overlay still goes out for whoever CAN see it — a desk view with no
    // conversation painted. It is no longer the only thing that does.
    expect(sidebar.post).toHaveBeenCalledWith({ type: "onboarding", state: "claude-login" });
  });

  // The first failure of a streak still buys its process restart: the whole
  // point of the recovery is that a stale token in a long-lived process is
  // fixable without anyone signing in at all.
  it("spends the recovery before flagging anything", async () => {
    const { sidebar, session, flagged } = makeSidebar();

    await sidebar.recoverAuthAndResend(session, refused, "Hey", [], []);

    expect(sidebar.startSession).toHaveBeenCalledWith("s1", session);
    expect(flagged).toEqual([]);
  });
});
