// AP-05 — the host's question bookkeeping, without a webview or a process.
//
// The point of this file is the RESPONDER ABSTRACTION (§8.3 step 1). Before it,
// `session.pendingQuestions` was a `Set<id>` and the answer path reached
// straight for `session.client.respondQuestion`. Now it is a
// `Map<id, QuestionResponder>` and the sidebar never asks which transport it
// holds — which is exactly what lets a question raised by a CLI-spawned MCP
// server use the same card, the same stale-card guard and the same timeout.
//
// Two invariants are worth stating out loud, because breaking either is silent:
//
//   - **Grok is unchanged.** Its responder writes the same JSON-RPC response it
//     always did, and its `abandon` writes NOTHING. A sweep that cancelled would
//     put a stale response on the CLI's pipe for a request it already settled.
//   - **The MCP path must always reply.** Nothing else will. A dropped question
//     there is a CLI blocked inside `tools/call` for the rest of its life.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session, type QuestionResponder } from "../src/session";
import type { QuestionRequest } from "../src/acp";

interface Harness {
  sidebar: any;
  session: Session;
  posted: any[];
  /** Value `companions.askTimeout` reports. */
  askTimeout: string;
}

function harness(): Harness {
  const posted: any[] = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  const state = { askTimeout: "off" };
  sidebar.host = {
    appendLine: () => { /* quiet */ },
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key === "askTimeout" ? state.askTimeout : fallback) }),
  };
  sidebar.emit = (_session: Session, message: unknown) => { posted.push(message); };
  sidebar.setStatus = vi.fn();
  sidebar.noteAnswered = vi.fn();
  sidebar.touch = vi.fn();
  sidebar.refreshKeepAwake = vi.fn();
  const session = new Session();
  return {
    sidebar,
    session,
    posted,
    get askTimeout() { return state.askTimeout; },
    set askTimeout(value: string) { state.askTimeout = value; },
  } as Harness;
}

function request(id: number | string, question = "Which database?"): QuestionRequest {
  return { id, sessionId: "s-1", questions: [{ question, options: [{ label: "Postgres" }, { label: "SQLite" }] }] };
}

function spyResponder(): QuestionResponder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    answer: (answers) => { calls.push(`answer:${JSON.stringify(answers)}`); return true; },
    cancel: (auto) => { calls.push(auto ? "cancel:auto" : "cancel"); return true; },
    abandon: () => { calls.push("abandon"); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("pendingQuestions is a responder map, not a set of ids", () => {
  it("posts the card and marks the session as waiting on a person", () => {
    const h = harness();
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);

    expect(h.posted).toEqual([{ type: "questionRequest", req: request(1) }]);
    expect(h.sidebar.setStatus).toHaveBeenCalledWith(h.session, "needs-you");
    expect(h.session.pendingQuestions.get(1)).toBe(responder);
  });

  it("routes an answer to that question's own responder", () => {
    const h = harness();
    const first = spyResponder();
    const second = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), first);
    h.sidebar.showQuestion(h.session, request(2), second);

    expect(h.sidebar.answerQuestion(h.session, 2, { "Which database?": "SQLite" }, {})).toBe(true);
    expect(second.calls).toEqual(['answer:{"Which database?":"SQLite"}']);
    expect(first.calls).toEqual([]);
    // Two transports can be outstanding at once and neither settles the other.
    expect(h.session.pendingQuestions.has(1)).toBe(true);
  });

  it("refuses a second answer to the same card", () => {
    // The stale-card invariant: a card replayed out of the session buffer, or
    // still open in a second tab, would otherwise write a duplicate response and
    // drag a settled session back to `working` with no turn left to end it.
    const h = harness();
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);

    expect(h.sidebar.answerQuestion(h.session, 1, { a: "b" }, {})).toBe(true);
    expect(h.sidebar.answerQuestion(h.session, 1, { a: "c" }, {})).toBe(false);
    expect(h.sidebar.cancelQuestion(h.session, 1)).toBe(false);
    expect(responder.calls).toHaveLength(1);
  });

  it("refuses an answer to a card it never raised", () => {
    const h = harness();
    expect(h.sidebar.answerQuestion(h.session, "nope", {}, {})).toBe(false);
    expect(h.sidebar.cancelQuestion(h.session, "nope")).toBe(false);
  });
});

describe("dropping a card the user never acted on", () => {
  it("asks each responder to abandon, then forgets it", () => {
    const h = harness();
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);
    h.sidebar.dropPendingQuestions(h.session);

    expect(responder.calls).toEqual(["abandon"]);
    expect(h.session.pendingQuestions.size).toBe(0);
    expect(h.session.questionDrafts.size).toBe(0);
    expect(h.session.questionTimers.size).toBe(0);
  });

  it("survives a responder that throws while being torn down", () => {
    const h = harness();
    h.sidebar.showQuestion(h.session, request(1), {
      answer: () => true,
      cancel: () => true,
      abandon: () => { throw new Error("socket already gone"); },
    });
    expect(() => h.sidebar.dropPendingQuestions(h.session)).not.toThrow();
    expect(h.session.pendingQuestions.size).toBe(0);
  });

  it("the grok responder stays silent on abandon and speaks on cancel", () => {
    // The two are deliberately different verbs. The grok CLI owns its own
    // request and has already settled it by the time a sweep runs; a response
    // then is a stale write on a live pipe. A user pressing Skip is not that.
    const client = { respondQuestion: vi.fn(() => true), respondQuestionCancelled: vi.fn(() => true) };
    const responder: QuestionResponder = {
      answer: (answers, annotations) => client.respondQuestion(1, answers, annotations),
      cancel: () => client.respondQuestionCancelled(1),
      abandon: () => { /* silence, on purpose */ },
    };
    const h = harness();
    h.sidebar.showQuestion(h.session, request(1), responder);
    h.sidebar.dropPendingQuestions(h.session);
    expect(client.respondQuestionCancelled).not.toHaveBeenCalled();
    expect(client.respondQuestion).not.toHaveBeenCalled();

    h.sidebar.showQuestion(h.session, request(2), responder);
    h.sidebar.cancelQuestion(h.session, 2);
    expect(client.respondQuestionCancelled).toHaveBeenCalledOnce();
  });
});

describe("companions.askTimeout", () => {
  it("arms nothing by default, and the card carries no timer for the webview", () => {
    const h = harness();
    h.sidebar.showQuestion(h.session, request(1), spyResponder());
    expect(h.session.questionTimers.size).toBe(0);
    expect(h.posted[0].autoContinueMs).toBeUndefined();

    vi.advanceTimersByTime(60 * 60_000);
    expect(h.session.pendingQuestions.has(1)).toBe(true);
  });

  it("tells the card how long it has, so it starts mirroring its draft", () => {
    const h = harness();
    h.askTimeout = "60s";
    h.sidebar.showQuestion(h.session, request(1), spyResponder());
    expect(h.posted[0].autoContinueMs).toBe(60_000);
  });

  it("cancels a card nobody was filling in, and says it was automatic", () => {
    const h = harness();
    h.askTimeout = "60s";
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);

    vi.advanceTimersByTime(59_000);
    expect(responder.calls).toEqual([]);
    vi.advanceTimersByTime(1_000);

    expect(responder.calls).toEqual(["cancel:auto"]);
    expect(h.posted.at(-1)).toEqual({ type: "questionResolved", requestId: 1, auto: true });
    expect(h.sidebar.noteAnswered).toHaveBeenCalled();
  });

  it("sends a COMPLETE draft rather than throwing the user's marks away", () => {
    const h = harness();
    h.askTimeout = "60s";
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);
    h.session.questionDrafts.set(1, { answers: { "Which database?": "Postgres" }, annotations: {}, complete: true });

    vi.advanceTimersByTime(60_000);
    expect(responder.calls).toEqual(['answer:{"Which database?":"Postgres"}']);
    expect(h.posted.at(-1)).toEqual({
      type: "questionResolved",
      requestId: 1,
      auto: true,
      answers: { "Which database?": "Postgres" },
    });
  });

  it("continues without an answer when the draft is only half made", () => {
    // A partial map would read to the model as a confident answer to questions
    // the user never got to.
    const h = harness();
    h.askTimeout = "5m";
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);
    h.session.questionDrafts.set(1, { answers: { Q1: "1a" }, annotations: {}, complete: false });

    vi.advanceTimersByTime(5 * 60_000);
    expect(responder.calls).toEqual(["cancel:auto"]);
  });

  it("disarms the timer when the user answers first", () => {
    const h = harness();
    h.askTimeout = "60s";
    const responder = spyResponder();
    h.sidebar.showQuestion(h.session, request(1), responder);
    h.sidebar.answerQuestion(h.session, 1, { "Which database?": "SQLite" }, {});

    vi.advanceTimersByTime(120_000);
    expect(responder.calls).toEqual(['answer:{"Which database?":"SQLite"}']);
    expect(h.posted.some((m) => m.type === "questionResolved")).toBe(false);
  });
});

describe("the sidebar source keeps the AP-05 wiring", () => {
  // Cheap structural pins for the paths a unit test cannot reach without a live
  // ACP process, all of which are "if this is missing, something hangs".
  const source = require("node:fs").readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8") as string;

  it("withholds the MCP question tool from grok, which has its own RPC", () => {
    const method = source.slice(source.indexOf("private async askUserMcpServer("));
    expect(method.slice(0, 400)).toContain('if (session.provider === "grok") return undefined;');
  });

  it("skips our server when the provider already loads one by that name", () => {
    const method = source.slice(source.indexOf("private async askUserMcpServer("));
    expect(method.slice(0, 900)).toContain("normalizeMcpName(name) === ASK_USER_SERVER_NAME");
  });

  it("closes the pipe and drops every card on dispose", () => {
    const dispose = source.slice(source.indexOf("  dispose(): void {"), source.indexOf("  moveComposerCaret("));
    expect(dispose).toContain("this.askUserChannel?.dispose();");
    expect(dispose).toContain("this.dropPendingQuestions(session);");
  });

  it("revokes the session token on a session start or restart", () => {
    expect(source).toContain("this.revokeAskUserToken(session);");
  });

  it("never lets a failed pipe keep a session from starting", () => {
    const method = source.slice(source.indexOf("private async hostMcpServersFor("));
    expect(method.slice(0, 2000)).toContain("catch (error)");
  });
});
