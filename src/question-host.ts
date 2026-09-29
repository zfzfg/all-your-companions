import { providerCapability } from "./provider-capabilities";
/** QuestionHost: GrokSidebar collaborators. Methods moved unchanged. */
import type { Host, HostContext } from "./host";
import * as path from "node:path";
import { QuestionRequest } from "./acp";
import { Session, SessionStatus, turnIsInFlight } from "./session";
import type { QuestionResponder } from "./session";
import { HostMsg } from "./protocol";
import { HostPipeMux } from "./host-pipe-mux";
import { normalizeMcpName } from "./mcp-connectors";
import type { ReservedMcpIdentity, AcpMcpStdioServer } from "./mcp-connectors";
import { ASK_USER_SERVER_NAME, askTimeoutMs } from "./ask-user-protocol";
import { AskUserServer } from "./ask-user-server";



export interface QuestionHostDeps {
  readonly host: Host;
  emit(session: Session, message: HostMsg): void;
  setStatus(session: Session, status: SessionStatus): void;
  hostPipeMux?: HostPipeMux;
  askUserChannel?: AskUserServer;
  readonly context: HostContext;
  readonly pool: Set<Session>;
  reservedMcpIdentityFor(session: Session): ReservedMcpIdentity;
  touch(session: Session): void;
}

export class QuestionHost {
  constructor(private readonly deps: QuestionHostDeps) {}

  private get host() { return this.deps.host; }

  private get emit() { return this.deps.emit; }

  private get setStatus() { return this.deps.setStatus; }

  private get hostPipeMux() { return this.deps.hostPipeMux; }
  private set hostPipeMux(value) { this.deps.hostPipeMux = value; }

  private get askUserChannel() { return this.deps.askUserChannel; }
  private set askUserChannel(value) { this.deps.askUserChannel = value; }

  private get context() { return this.deps.context; }

  private get pool() { return this.deps.pool; }

  private get reservedMcpIdentityFor() { return this.deps.reservedMcpIdentityFor; }

  private get touch() { return this.deps.touch; }


  // ---------- question cards (AP-05) ----------
  //
  // One card, two transports. `showQuestion` is the only place a card is
  // raised, `answerQuestion` / `cancelQuestion` the only places one is settled,
  // and none of them knows whether the answer will travel back over grok's ACP
  // pipe or over the local socket to a CLI-spawned MCP server. Adding a third
  // transport means adding a QuestionResponder, nothing here.

  /**
   * Raise a question card and take ownership of its lifetime.
   *
   * Arms the auto-continue timer here rather than in the webview: a webview
   * that is closed, backgrounded or never opened must not be able to swallow a
   * question, and a person who closes the tab must not thereby extend the
   * deadline on a run they left behind.
   */
  showQuestion(session: Session, req: QuestionRequest, responder: QuestionResponder): void {
    session.pendingQuestions.set(req.id, responder);
    this.syncHumanWait(session);
    const timeout = askTimeoutMs(this.host.getConfiguration("grok").get<string>("askTimeout", "off"));
    this.emit(session, { type: "questionRequest", req, ...(timeout === undefined ? {} : { autoContinueMs: timeout }) });
    this.setStatus(session, "needs-you");
    if (timeout === undefined) return;
    const timer = setTimeout(() => this.autoContinueQuestion(session, req.id), timeout);
    // Never the reason a host process stays alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    session.questionTimers.set(req.id, timer);
  }

  /**
   * Settle a card with the user's selections.
   *
   * The `delete` is the stale-card guard and it comes FIRST: a card that is no
   * longer outstanding — replayed from the session buffer, or still on screen
   * in a second tab — would otherwise write a duplicate response and drag a
   * settled session back to `working` with no turn left to ever end it.
   */
  answerQuestion(
    session: Session,
    requestId: number | string,
    answers: Record<string, string>,
    annotations: Record<string, { notes?: string; preview?: string }>,
    auto = false,
  ): boolean {
    const responder = session.pendingQuestions.get(requestId);
    if (!responder) return false;
    this.forgetQuestion(session, requestId);
    return responder.answer(answers, annotations, auto);
  }

  /** Settle a card as dismissed. Same stale-card guard as {@link answerQuestion}. */
  cancelQuestion(session: Session, requestId: number | string, auto = false): boolean {
    const responder = session.pendingQuestions.get(requestId);
    if (!responder) return false;
    this.forgetQuestion(session, requestId);
    return responder.cancel(auto);
  }

  forgetQuestion(session: Session, requestId: number | string): void {
    session.pendingQuestions.delete(requestId);
    this.syncHumanWait(session);
    session.questionDrafts.delete(requestId);
    const timer = session.questionTimers.get(requestId);
    if (timer) { clearTimeout(timer); session.questionTimers.delete(requestId); }
  }

  /**
   * `companions.askTimeout` elapsed with the card still up.
   *
   * Sends what the user already marked if — and only if — every question in the
   * card carries an answer. A half-filled map is worse than none: the model
   * would read a confident partial answer and never learn that the rest was
   * guessed. Either way the card collapses marked as continued automatically,
   * so the transcript never implies a person chose this.
   */
  autoContinueQuestion(session: Session, requestId: number | string): void {
    const draft = session.questionDrafts.get(requestId);
    const settled = draft?.complete
      ? this.answerQuestion(session, requestId, draft.answers, draft.annotations, true)
      : this.cancelQuestion(session, requestId, true);
    if (!settled && !session.pendingQuestions.has(requestId)) return;
    this.emit(session, {
      type: "questionResolved",
      requestId,
      auto: true,
      ...(draft?.complete ? { answers: draft.answers } : {}),
    });
    this.noteAnswered(session);
  }

  /**
   * Drop every outstanding card for this session without the user having acted.
   *
   * Each responder decides what that means for its own transport — silence for
   * grok, whose CLI already settled the request, and a cancellation for the MCP
   * path, where nothing else will ever reply and the tool call would otherwise
   * block until the CLI is killed.
   */
  dropPendingQuestions(session: Session): void {
    for (const [requestId, responder] of session.pendingQuestions) {
      try { responder.abandon(); } catch { /* teardown is not worth failing over */ }
      // The card must stop taking input the moment nothing will read it.
      this.emit(session, { type: "questionResolved", requestId, outcome: "closed" });
    }
    session.pendingQuestions.clear();
    this.syncHumanWait(session);
    session.questionDrafts.clear();
    for (const timer of session.questionTimers.values()) clearTimeout(timer);
    session.questionTimers.clear();
  }

  /**
   * The host-side `ask_user` MCP channel, created on first use.
   *
   * One per window, shared by every session: the pipe is the transport, the
   * per-session token is the identity on it.
   */
  /**
   * The window's one host pipe (P6, §16).
   *
   * Shared by the AP-05 question channel and the AP-16 delegation channel. Two
   * protocols, two entries in `mcpServers` — the CLI needs two stdio servers —
   * but one listener underneath, and the per-session token is what routes a
   * connection to the right one.
   */
  hostPipe(): HostPipeMux {
    if (!this.hostPipeMux) {
      this.hostPipeMux = new HostPipeMux({ log: (message) => this.host.appendLine(message) });
    }
    return this.hostPipeMux;
  }

  askUser(): AskUserServer {
    if (!this.askUserChannel) {
      this.askUserChannel = new AskUserServer({
        mux: this.hostPipe(),
        // From `extensionUri`, not a path relative to `out/`: the script is a
        // packaged RESOURCE, and `.vscodeignore` has to keep `resources/mcp/**`
        // in the VSIX or this path exists in development and nowhere else.
        scriptPath: path.join(this.context.extensionUri.fsPath, "resources", "mcp", "ask-user-server.cjs"),
        log: (message) => this.host.appendLine(message),
        onRequest: (token, request) => {
          const session = this.sessionForAskUserToken(token);
          // No session owns this token any more: answer immediately so the CLI
          // is not left blocked inside `tools/call`.
          if (!session) { request.cancel(); return; }
          this.showQuestion(session, {
            id: request.id,
            sessionId: session.activeSessionId ?? "",
            // Narrowed to `QuestionItem`, the shape grok's RPC produces, so the
            // card sees one thing and there is no second render path. The
            // derived `header` is dropped here on purpose: nothing renders it
            // today, and a field on the wire that no reader consumes is a
            // promise the next feature would have to keep.
            questions: request.questions.map((q) => ({
              question: q.question,
              options: q.options.map((option) => ({ ...option })),
              multiSelect: q.multiSelect,
            })),
          }, {
            answer: (answers, annotations, auto) => request.answer(answers, annotations, auto),
            cancel: (auto) => request.cancel(auto),
            abandon: () => { request.cancel(); },
          });
        },
        onWithdraw: (token, id) => {
          const session = this.sessionForAskUserToken(token);
          if (!session || !session.pendingQuestions.has(id)) return;
          // The CLI withdrew the call or its process died. Take the card down
          // rather than leave a control that does nothing when pressed.
          this.forgetQuestion(session, id);
          this.emit(session, { type: "questionResolved", requestId: id, outcome: "closed" });
          this.noteAnswered(session);
        },
      });
    }
    return this.askUserChannel;
  }

  sessionForAskUserToken(token: string): Session | undefined {
    for (const session of this.pool) {
      if (session.askUserToken === token) return session;
    }
    return undefined;
  }

  revokeAskUserToken(session: Session): void {
    if (!session.askUserToken) return;
    this.askUserChannel?.revoke(session.askUserToken);
    session.askUserToken = undefined;
  }

  /**
   * The `companions` MCP entry for this session, if it should get one.
   *
   * Withheld from grok, which already has a native question RPC — a second
   * affordance for the same card would cost every grok turn the tool's tokens
   * and let the model pick the worse of two identical paths. Withheld too when
   * the provider already loads a server called `companions`, following the same
   * rule the connectors use: skip ours rather than shadow theirs.
   */
  async askUserMcpServer(session: Session): Promise<AcpMcpStdioServer | undefined> {
    if (providerCapability(session.provider, "questionRpc").state === "yes") return undefined;
    const reserved = this.reservedMcpIdentityFor(session);
    if (reserved.names.some((name) => normalizeMcpName(name) === ASK_USER_SERVER_NAME)) {
      this.host.appendLine(`[ask_user] a provider MCP server is already named "${ASK_USER_SERVER_NAME}" — not adding ours`);
      return undefined;
    }
    const channel = this.askUser();
    if (!(await channel.listen())) return undefined;
    this.revokeAskUserToken(session);
    session.askUserToken = channel.register();
    return channel.spawnSpec(session.askUserToken);
  }

  /**
   * Suspend the prompt idle timer exactly while a person holds a card.
   * Called wherever a question, permission or plan request is added or
   * settled; the absolute cap is never suspended (upstream e2e8458).
   */
  syncHumanWait(session: Session): void {
    session.client?.setHumanWaitActive?.(
      session.pendingQuestions.size > 0
      || session.pendingPermissions.size > 0
      || session.pendingExitPlans.size > 0,
    );
  }

  /**
   * A terminal tool update for a question's own tool call: the CLI stopped
   * waiting (answered, or its ask timeout expired — the wire does not say
   * which, and the prose is deliberately not read). Retire the card now
   * rather than leave a Submit that writes into a dead channel (#160).
   */
  closeQuestionsForToolCall(
    session: Session,
    call: { toolCallId?: unknown; status?: unknown } | null | undefined,
  ): void {
    const toolCallId = call?.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId
      || (call?.status !== "completed" && call?.status !== "failed")) return;
    let closed = false;
    for (const [requestId, responder] of [...session.pendingQuestions]) {
      if (responder.toolCallId !== toolCallId) continue;
      this.forgetQuestion(session, requestId);
      this.emit(session, { type: "questionResolved", requestId, outcome: "closed" });
      closed = true;
    }
    if (closed && turnIsInFlight(session)) this.noteAnswered(session);
  }

  /** True when any live pool member is mid-turn or waiting on the user. */
  /**
   * The agent was waiting on a person and now it is not.
   *
   * Answering is ACTIVITY whether or not it unblocks the whole turn: the tool
   * that was approved starts running immediately. Setting `working` is separate,
   * and conditional — with another card still outstanding the turn is not
   * resumed and saying so would be a lie — but the clock has to be re-armed
   * either way, or a machine can freeze on work that has only just begun.
   */
  noteAnswered(session: Session): void {
    // EVERY kind of card, not just permissions. Parallel tool calls can raise a
    // question and a plan review together, and answering one of them resumed
    // nothing — while `working` is the status the view shows, so the claim
    // would be untrue.
    if (session.pendingPermissions.size === 0
      && session.pendingExitPlans.size === 0
      && session.pendingQuestions.size === 0) {
      this.setStatus(session, "working"); // setStatus touches and re-asserts
      return;
    }
    this.touch(session);
  }
}
