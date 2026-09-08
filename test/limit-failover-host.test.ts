// AP-06 host wiring, without a webview or a process.
//
// Pins the two things a unit classifier cannot: the card hangs in FRONT of
// recoverAuthAndResend (so a limit never also rebuilds against the same
// ceiling), and Continue rebinds the session to a different provider then
// resends — never to the exhausted one.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RATE_LIMITED_ERROR_CODE } from "../src/acp-dispatch";
import { switchTranscriptLine } from "../src/limit-errors";

const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

function harness() {
  const posted: unknown[] = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.host = { appendLine: vi.fn() };
  sidebar.emit = (_session: Session, message: unknown) => { posted.push(message); };
  sidebar.setStatus = vi.fn();
  sidebar.noteLiveTurnEnded = vi.fn();
  sidebar.turnEndFields = () => ({ status: "failed", durationMs: 12 });
  sidebar.usableProviders = () => ["grok", "claude"];
  sidebar.sessionCwd = () => "/tmp/proj";
  sidebar.rememberProjectProvider = vi.fn(async () => {});
  sidebar.startSession = vi.fn(async () => ({ sessionId: "new" }));
  sidebar.handleSend = vi.fn(async () => {});
  const session = new Session();
  session.provider = "grok";
  return { sidebar, session, posted };
}

describe("prompt-failure path hangs the card in front of auth recovery", () => {
  it("classifies the limit and returns before recoverAuthAndResend", () => {
    const catchStart = sidebarSrc.indexOf("const e = err as any;");
    const catchEnd = sidebarSrc.indexOf("if (await this.recoverAuthAndResend", catchStart);
    const catchBlock = sidebarSrc.slice(catchStart, catchEnd);
    expect(catchBlock).toContain("this.surfaceLimitError(session, e, text, sentChips)");
    expect(catchBlock).not.toContain("recoverAuthAndResend");
    expect(sidebarSrc).toContain("if (this.surfaceLimitError(session, e2, displayText, chips)) return true");
  });

  it("Continue starts a fresh session on the target (no resume of the exhausted id)", () => {
    const method = sidebarSrc.slice(
      sidebarSrc.indexOf("private async answerLimitOffer"),
      sidebarSrc.indexOf("private async recoverAuthAndResend"),
    );
    expect(method).toContain("this.startSession(undefined, session)");
    expect(method).toContain("session.keepTranscriptOnStart = true");
    expect(method).toContain("switchTranscriptLine");
    expect(method).not.toContain("startSession(session.activeSessionId");
    expect(method).not.toContain("startSession(offer");
  });

  it("keeps the transcript across the failover start", () => {
    expect(sidebarSrc).toContain("const keepTranscript = session.keepTranscriptOnStart === true");
    expect(sidebarSrc).toContain("if (!keepTranscript) session.buffer = []");
  });
});

describe("surfaceLimitError", () => {
  it("posts the card with partner targets and stashes the failed prompt", () => {
    const h = harness();
    const handled = h.sidebar.surfaceLimitError(
      h.session,
      { code: RATE_LIMITED_ERROR_CODE, message: "You hit your weekly limit." },
      "please fix the tests",
      [{ id: "c1", relPath: "a.ts" }],
    );
    expect(handled).toBe(true);
    const offer = h.posted.find((m: any) => m.type === "limitOffer") as any;
    expect(offer.kind).toBe("quota");
    expect(offer.source).toBe("grok");
    expect(offer.targets).toEqual([{ id: "claude", name: "Claude" }]);
    expect(offer.recommended).toBe("continue");
    expect(offer.title).toBe("Grok usage limit reached");
    expect(h.session.pendingLimitOffer?.text).toBe("please fix the tests");
    expect(h.sidebar.setStatus).toHaveBeenCalledWith(h.session, "error");
  });

  it("omits continue targets when no other companion is connected", () => {
    const h = harness();
    h.sidebar.usableProviders = () => ["grok"];
    h.sidebar.surfaceLimitError(h.session, { code: RATE_LIMITED_ERROR_CODE, message: "Rate limited" }, "hi", []);
    const offer = h.posted.find((m: any) => m.type === "limitOffer") as any;
    expect(offer.targets).toEqual([]);
    expect(offer.recommended).toBe("retry");
    expect(offer.kind).toBe("rate");
  });

  it("does not claim an ordinary error", () => {
    const h = harness();
    expect(h.sidebar.surfaceLimitError(h.session, new Error("network timeout"), "hi", [])).toBe(false);
    expect(h.posted).toEqual([]);
    expect(h.session.pendingLimitOffer).toBeUndefined();
  });
});

describe("answerLimitOffer", () => {
  it("Continue switches provider, logs a transcript line, and resends only to the target", async () => {
    const h = harness();
    h.sidebar.surfaceLimitError(
      h.session,
      { code: RATE_LIMITED_ERROR_CODE, message: "You hit your weekly limit." },
      "please fix the tests",
      [],
    );
    const id = h.session.pendingLimitOffer!.id;
    await h.sidebar.answerLimitOffer(h.session, { id, action: "continue", target: "claude" });

    expect(h.session.provider).toBe("claude");
    expect(h.sidebar.startSession).toHaveBeenCalledWith(undefined, h.session);
    expect(h.sidebar.handleSend).toHaveBeenCalledWith("please fix the tests", false, h.session);
    expect(h.sidebar.rememberProjectProvider).toHaveBeenCalledWith("/tmp/proj", "claude");
    expect(h.posted.some((m: any) => m.type === "hostNotice" && m.text === switchTranscriptLine("grok", "claude"))).toBe(true);
    expect(h.session.pendingLimitOffer).toBeUndefined();
  });

  it("refuses Continue to the exhausted provider (or any non-usable id)", async () => {
    const h = harness();
    h.sidebar.surfaceLimitError(
      h.session,
      { code: RATE_LIMITED_ERROR_CODE, message: "You hit your weekly limit." },
      "please fix the tests",
      [],
    );
    const id = h.session.pendingLimitOffer!.id;
    await h.sidebar.answerLimitOffer(h.session, { id, action: "continue", target: "grok" });
    expect(h.session.provider).toBe("grok");
    expect(h.sidebar.startSession).not.toHaveBeenCalled();
    expect(h.sidebar.handleSend).not.toHaveBeenCalled();
    expect(h.session.pendingLimitOffer?.id).toBe(id);
  });

  it("Wait resends to the current provider only because the user asked", async () => {
    const h = harness();
    h.sidebar.surfaceLimitError(
      h.session,
      { code: RATE_LIMITED_ERROR_CODE, message: "Rate limited" },
      "please fix the tests",
      [],
    );
    const id = h.session.pendingLimitOffer!.id;
    await h.sidebar.answerLimitOffer(h.session, { id, action: "retry" });
    expect(h.session.provider).toBe("grok");
    expect(h.sidebar.startSession).not.toHaveBeenCalled();
    expect(h.sidebar.handleSend).toHaveBeenCalledWith("please fix the tests", false, h.session);
  });

  it("Dismiss settles the card and does not send", async () => {
    const h = harness();
    h.sidebar.surfaceLimitError(
      h.session,
      { code: RATE_LIMITED_ERROR_CODE, message: "Rate limited" },
      "please fix the tests",
      [],
    );
    const id = h.session.pendingLimitOffer!.id;
    await h.sidebar.answerLimitOffer(h.session, { id, action: "dismiss" });
    expect(h.sidebar.handleSend).not.toHaveBeenCalled();
    expect(h.sidebar.startSession).not.toHaveBeenCalled();
    expect(h.posted.some((m: any) => m.type === "limitOfferResolved" && m.action === "dismiss")).toBe(true);
  });
});
