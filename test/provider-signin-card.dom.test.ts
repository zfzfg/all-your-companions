/**
 * What a person is offered when the agent's sign-in expires MID-CONVERSATION.
 *
 * The offer already existed — `providerState.needsLogin` turns the gear's
 * account row, the model picker and Settings into a sign-in — but every one of
 * those is somewhere else, and the welcome card that spells it out refuses to
 * paint over a live conversation on purpose. So the case this file covers is
 * a real conversation on screen, the vendor's "Authentication required" in
 * red, and no route back.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

function boot(opts: { caps?: Record<string, unknown> } = {}) {
  const h = bootWebview();
  dispatch(h.window, {
    type: "initialState",
    effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "4.5.2",
    showThinking: false, expandCommandOutputs: false, steerByDefault: false,
    soundNotifications: false, processingSound: false, readRepliesAloud: false,
    appPurpose: "coding",
    capabilities: opts.caps ?? {},
  } as any);
  return h;
}

const session = (h: Harness, provider: string) =>
  dispatch(h.window, { type: "session", provider, models: [], currentModelId: "model" } as any);
const providers = (h: Harness, list: unknown[]) =>
  dispatch(h.window, { type: "providerState", providers: list } as any);
const card = (h: Harness) => h.doc.getElementById("provider-signin-card");
const lapsed = (id: string) => ({ id, connected: true, needsLogin: true });

describe("the lapsed-account offer above the composer", () => {
  it("names the agent and posts the same sign-in the accounts row posts", () => {
    const h = boot();
    session(h, "claude");
    providers(h, [lapsed("claude")]);
    const el = card(h)!;
    expect(el).not.toBeNull();
    expect(el.textContent).toContain("sign in again");
    h.posted.length = 0;
    click(h.window, el.querySelector("button")!);
    expect(h.posted).toEqual([{ type: "runGrokLogin", provider: "claude" }]);
  });

  // It sits above the composer rather than replacing it, unlike the superseded
  // card. This flag is OUR bookkeeping about somebody else's credential, and
  // locking a person out of their own conversation over it is worse than one
  // more refused send.
  it("leaves the composer usable", () => {
    const h = boot();
    session(h, "claude");
    providers(h, [lapsed("claude")]);
    expect(card(h)!.parentElement!.classList.contains("composer")).toBe(true);
    expect((h.doc.getElementById("input") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("goes away the moment the account works again", () => {
    const h = boot();
    session(h, "claude");
    providers(h, [lapsed("claude")]);
    expect(card(h)).not.toBeNull();
    providers(h, [{ id: "claude", connected: true }]);
    expect(card(h)).toBeNull();
  });

  // The flag is per account; the card speaks for the session in front of you.
  // Offering "sign in to Codex" over a working Grok conversation would be an
  // interruption about something the reader is not doing.
  it("says nothing about an account this session is not using", () => {
    const h = boot();
    session(h, "grok");
    providers(h, [lapsed("codex"), { id: "grok", connected: true }]);
    expect(card(h)).toBeNull();
  });

  it("follows the session when the provider changes under it", () => {
    const h = boot();
    session(h, "grok");
    providers(h, [lapsed("claude"), { id: "grok", connected: true }]);
    expect(card(h)).toBeNull();
    session(h, "claude");
    expect(card(h)).not.toBeNull();
  });

  // An account that was never connected is the empty state's job, and that card
  // has a whole panel for choosing one. This one only ever says "again".
  it("stays out of the way of an account that was never connected", () => {
    const h = boot();
    session(h, "claude");
    providers(h, [{ id: "claude", connected: false, needsLogin: true }]);
    expect(card(h)).toBeNull();
  });

});

/**
 * The tail of the flow: a sign-in that succeeds must not do so in silence
 * with the vendor's red refusal still the last thing on screen.
 */
describe("the tail of the sign-in", () => {
  const notices = (h: Harness) =>
    [...h.doc.querySelectorAll(".plan-notice")].map((el) => el.textContent);

  it("says the sign-in worked, under the refusal that asked for it", () => {
    const h = boot();
    session(h, "claude");
    dispatch(h.window, { type: "error", text: "Authentication required" } as any);
    providers(h, [lapsed("claude")]);
    expect(notices(h)).toEqual([]);
    providers(h, [{ id: "claude", connected: true }]);
    expect(card(h)).toBeNull();
    expect(notices(h).join("")).toContain("Claude is signed in again");
  });

  // It is a line in the transcript, not a message from the host, so nothing
  // replays it: the owner asked for a confirmation that does not survive
  // restoring the conversation.
  it("leaves nothing behind for a restore to repaint", () => {
    const h = boot();
    session(h, "claude");
    dispatch(h.window, { type: "error", text: "Authentication required" } as any);
    providers(h, [lapsed("claude")]);
    providers(h, [{ id: "claude", connected: true }]);
    expect(notices(h).length).toBe(1);
    // What a restore does: empty the transcript, then replay what the host
    // buffered. The line was never in that buffer, so it does not come back.
    dispatch(h.window, { type: "clearMessages" } as any);
    dispatch(h.window, { type: "userMessage", text: "the prompt that was refused" } as any);
    expect(notices(h)).toEqual([]);
  });

  // `addPlanNotice` hides the welcome panel to make room, so on an empty
  // transcript the confirmation would cost the reader the connect UI itself —
  // which is already saying everything this line would.
  it("stays quiet when there is no transcript to say it in", () => {
    const h = boot();
    session(h, "claude");
    providers(h, [lapsed("claude")]);
    providers(h, [{ id: "claude", connected: true }]);
    expect(notices(h)).toEqual([]);
    expect(h.doc.getElementById("welcome")!.hidden).toBe(false);
  });

  // The card also goes away when the session moves to a provider that is fine.
  // Claiming that as a successful sign-in would congratulate the reader for
  // something nobody did, and the expired account is still expired.
  it("does not mistake the card following the session for a sign-in", () => {
    const h = boot();
    session(h, "claude");
    dispatch(h.window, { type: "error", text: "Authentication required" } as any);
    providers(h, [lapsed("claude"), { id: "grok", connected: true }]);
    expect(card(h)).not.toBeNull();
    session(h, "grok");
    expect(card(h)).toBeNull();
    expect(notices(h)).toEqual([]);
  });
});
