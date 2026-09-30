import { steerUnavailableNotice } from "./provider-ui";
import { ContextBudgetExceededError } from "./context-budget";
import { explicitVisibleChips } from "./queued-send";
import { OpenClock } from "./open-timing";
import { randomUUID } from "node:crypto";
import {
  classifyLimitError,
  CONTEXT_OVERFLOW_TEXT,
  isContextOverflowError,
  limitOfferHint,
  limitOfferTitle,
  recommendedLimitAction
} from "./limit-errors";
import { rateLimitNoticeText, type TurnEndStatus } from "./acp-dispatch";
import { SessionStartIntent, SessionStatus } from "./session";
import { providerCapability } from "./provider-capabilities";
export interface TurnEditSidebarOps {
  readonly host: Host;
  emit: (session: Session, message: HostMsg) => void;
  turnEndFields: (session: Session, status: TurnEndStatus) => { status: TurnEndStatus; durationMs?: number; children?: string; };
  startSession: (resumeId?: string, target?: Session, intent?: SessionStartIntent, clock?: OpenClock) => Promise<AcpClient | undefined>;
  setStatus: (session: Session, status: SessionStatus) => void;
  readonly focused: Session;
  refreshImplicitChip: (forcePost?: boolean) => void;
  postChips: (session?: Session) => void;
  emitQueuedSends: (session: Session) => void;
  maybeFlushQueuedSends: (session: Session) => Promise<void>;
  usableProviders: () => AcpProvider[];
  measuredFreePercent: (provider: AcpProvider) => number | undefined;
  noteLiveTurnEnded: (session: Session) => void;
  continueInFreshSession: (session: Session) => Promise<void>;
  handleSend: (text: string, bare?: boolean, target?: Session, queuedSendCommit?: { text: string; items: QueuedSendEntry[]; }, submissionId?: string) => Promise<void>;
}

/**
 * Turn editing, steering, rewinding, forking, turn feedback, and auth recovery.
 * Extracted from GrokSidebar (W-15 Schritt S2).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Host, HostContext } from "./host";
import { AcpClient } from "./acp";
import type { AcpProvider } from "./acp-backend";
import { isImageChip, consumeChips, type FileChip } from "./chips";
import { isFileChip, type ContextChip, type ContextChipPayload } from "./context-chips";
import type { HostMsg } from "./protocol";
import {
  Session,
  beginTurn,
  endTurn,
  turnIsInFlight
} from "./session";
import { SESSION_META_KEY } from "./worktree-host";
import { forkDisplayName, type SessionMetaOverrides } from "./sessions";
import { forkedSessionTypeMeta } from "./session-type";
import { matchSlashCommand } from "./slash-filter";
import {
  buildPromptWithImages,
  buildQueuedPromptWithImages,
  type PromptImageInput,
  type QueuedPromptContribution
} from "./prompt-builder";
import {
  cloneChipForQueue,
  enqueueQueuedSend,
  queuedSendsContainChipIds,
  queuedSendsHaveContent,
  queuedSendsText,
  restoreQueuedChips,
  chipsForQueueSend,
  type QueuedSendEntry
} from "./queued-send";
import { isThumbsRating, feedbackClientType } from "./feedback";
import {
  formatRewindPointDetail,
  formatRewindPointLabel,
  anyFilesAfter,
  bubbleMapIsConsistent,
  editRewindConfirmMessage,
  resolveEditRewindTarget,
  resolveUserBubbleRewind,
  survivingUserMessagesAfterRewind,
  rewindConfirmMessage,
  selectableRewindPoints,
  userFacingRewindPoints
} from "./rewind";
import { limitOfferTargets, switchTranscriptLine } from "./limit-errors";
import { beginAuthRecovery } from "./auth-recovery";
import {
  errorDetail,
  isCredentialError,
  isAuthErrorText,
  turnStatusFromPromptResult,
  promptErrorText
} from "./acp-dispatch";

export interface TurnEditSteerOps {
  emit(session: Session, msg: HostMsg): void;
  emitQueuedSends(session: Session): void;
  refreshImplicitChip(force?: boolean): void;
  postChips(session: Session): void;
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  contextChipPayloads(chips: readonly ContextChip[]): (chip: ContextChip) => ContextChipPayload | undefined;
  readImageChip(chip: FileChip, session: Session, gen: number): Promise<any>;
  retainUploadedFilesForSession(session: Session, chips: ContextChip[]): Promise<void>;
  maybeFlushQueuedSends(session: Session): Promise<void>;
}

export interface TurnEditRewindOps {
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  rewindFromClientCheckpoints(session: Session, opts: any): Promise<void>;
  restoreComposerFor(session: Session, text: string, chips?: ContextChip[]): void;
  checkWorkspaceGitStatus(cwd: string): Promise<any>;
  workspaceRoot(): string;
  confirmInChat(session: Session, opts: any): Promise<boolean>;
  truncateSessionCardsAfterRewind(sessionId: string, surviving: number): Promise<void>;
  applyRewindToView(session: Session, surviving: number): void;
  sessionDisplayName(session: Session): string;
  sessionCwd(session: Session): string;
  openSession(id: string, cwd: string): Promise<void>;
  rememberQueuedDraft(id: string, text: string): Promise<void>;
}

export interface TurnEditAuthLimitOps {
  usableProviders(): AcpProvider[];
  emit(session: Session, msg: HostMsg): void;
  post(msg: HostMsg): void;
  rememberProjectProvider(cwd: string, provider: AcpProvider): Promise<void>;
  sessionCwd(session: Session): string;
  startSession(id?: string, session?: Session): Promise<any>;
  handleSend(text: string, force?: boolean, session?: Session): Promise<void>;
  setProviderNeedsLogin(provider: AcpProvider, needs: boolean): void;
  startTurnGitBaseline(session: Session, turn: any): void;
  setStatus(session: Session, status: any): void;
  emitAbandonedSend(session: Session): void;
  turnEndFields(session: Session, status: any): any;
  noteLiveTurnEnded(session: Session): void;
  maybeGenerateTitle(session: Session): void;
  postSessionName(session: Session): void;
  onboardingForSession(session: Session): any;
}

export interface TurnEditFeedbackOps {
  ackTurnFeedback(session: Session, rating: any): void;
  latchFeedbackUnavailable(session: Session): void;
  thumbsFeedbackEnabled(): boolean;
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  contextExtensionVersion(): string;
  canSwitchWorkspaceFolder(): boolean;
}

export interface TurnEditDeps {
  host?: Host;
  state?: HostContext["globalState"];
  context?: HostContext;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
  getFocused(): Session;
  setFocused?(session: Session): void;
  checkpointStore?: any;
  getSessionCache(): Map<string, any>;

  steerOps: TurnEditSteerOps;
  rewindOps: TurnEditRewindOps;
  authLimitOps: TurnEditAuthLimitOps;
  feedbackOps: TurnEditFeedbackOps;

  readonly sidebarOps: TurnEditSidebarOps;
}

export class TurnEdit {
  constructor(private readonly deps: TurnEditDeps) { }

  private get host(): Host | undefined {
    return this.deps.host;
  }

  private get state(): HostContext["globalState"] | undefined {
    return this.deps.state;
  }

  private get sessionCache(): Map<string, any> {
    return this.deps.getSessionCache();
  }

  private notifyUser(level: "info" | "warning" | "error", text: string): void {
    this.deps.steerOps.notifyUser(level, text);
  }

  private restoreComposerFor(session: Session, text: string, chips?: ContextChip[]): void {
    this.deps.rewindOps.restoreComposerFor(session, text, chips);
  }

  private sessionDisplayName(session: Session): string {
    return this.deps.rewindOps.sessionDisplayName(session);
  }

  private sessionCwd(session: Session): string {
    return this.deps.rewindOps.sessionCwd(session);
  }

  private async openSession(id: string, cwd: string): Promise<void> {
    await this.deps.rewindOps.openSession(id, cwd);
  }

  private emit(session: Session, msg: HostMsg): void {
    this.deps.steerOps.emit(session, msg);
  }

  private post(msg: HostMsg): void {
    this.deps.authLimitOps.post(msg);
  }

  private async startSession(id?: string, session?: Session): Promise<any> {
    return this.deps.authLimitOps.startSession(id, session);
  }

  private async handleSend(text: string, force?: boolean, session?: Session): Promise<void> {
    await this.deps.authLimitOps.handleSend(text, force, session);
  }

  private setStatus(session: Session, status: any): void {
    this.deps.authLimitOps.setStatus(session, status);
  }

  private noteLiveTurnEnded(session: Session): void {
    this.deps.authLimitOps.noteLiveTurnEnded(session);
  }

  private turnEndFields(session: Session, status: any): any {
    return this.deps.authLimitOps.turnEndFields(session, status);
  }

  private setProviderNeedsLogin(provider: AcpProvider, needs: boolean): void {
    this.deps.authLimitOps.setProviderNeedsLogin(provider, needs);
  }

  private onboardingForSession(session: Session): any {
    return this.deps.authLimitOps.onboardingForSession(session);
  }

  /**
   * Steer (#52) — interject prompt text (and optional explicit file chips) into
   * a running turn.
   */
  public async steerSend(
    text: string,
    session: Session = this.deps.getFocused(),
    requestedChips?: ContextChip[],
    fromQueue = false,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.steerSend>("steerSend");
    if (override) return override(text, session, requestedChips, fromQueue);

    const authored = text ?? "";
    const takeQueue = (fromQueue && queuedSendsHaveContent(session.queuedSends))
      || queuedSendsContainChipIds(session.queuedSends, requestedChips);

    if (!session.client || !session.activeSessionId) {
      if (takeQueue) return;
      const chips = chipsForQueueSend(session.chips, requestedChips);
      if (!authored.trim() && !chips.length) return;
      session.queuedSends = enqueueQueuedSend(session.queuedSends, authored, chips);
      if (chips.length) {
        session.chips = consumeChips(session.chips, chips);
        if (session === this.deps.getFocused()) this.deps.steerOps.refreshImplicitChip(true);
        else this.deps.steerOps.postChips(session);
      }
      this.deps.steerOps.emitQueuedSends(session);
      return;
    }

    let contributions: QueuedSendEntry[];
    let fromComposer = false;
    if (takeQueue) {
      contributions = session.queuedSends.map((item) => ({
        text: item.text,
        chips: item.chips.map(cloneChipForQueue),
      }));
      session.queuedSends = [];
      session.queuedSendCommit = undefined;
      this.deps.steerOps.emitQueuedSends(session);
    } else {
      const chips = chipsForQueueSend(session.chips, requestedChips);
      if (!authored.trim() && !chips.length) return;
      contributions = [{ text: authored, chips }];
      if (chips.length) {
        fromComposer = true;
        session.chips = consumeChips(session.chips, chips);
        if (session === this.deps.getFocused()) this.deps.steerOps.refreshImplicitChip(true);
        else this.deps.steerOps.postChips(session);
      }
    }

    const putBackOnQueue = (): void => {
      if (takeQueue) {
        session.queuedSends = [...contributions, ...session.queuedSends];
      } else {
        for (const item of contributions) {
          session.queuedSends = enqueueQueuedSend(session.queuedSends, item.text, item.chips);
        }
      }
      this.deps.steerOps.emitQueuedSends(session);
    };
    const putBackOnComposer = (): void => {
      if (takeQueue) {
        session.queuedSends = [...contributions, ...session.queuedSends];
        this.deps.steerOps.emitQueuedSends(session);
        return;
      }
      if (fromComposer) {
        session.chips = restoreQueuedChips(session.chips, contributions);
        if (session === this.deps.getFocused()) this.deps.steerOps.refreshImplicitChip(true);
        else this.deps.steerOps.postChips(session);
      }
    };

    const client = session.client;
    const gen = session.gen;
    const promptDeps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      extName: (p: string) => path.extname(p),
      contextChipPayload: this.deps.steerOps.contextChipPayloads(
        contributions.flatMap((item) => item.chips),
      ),
    };

    const builtContributions: QueuedPromptContribution[] = [];
    for (const item of contributions) {
      const itemImages: PromptImageInput[] = [];
      for (const chip of item.chips) {
        if (chip.hidden || !isFileChip(chip) || !isImageChip(chip)) continue;
        const read = await this.deps.steerOps.readImageChip(chip, session, gen);
        if (read === "gone") {
          putBackOnComposer();
          return;
        }
        if (read === "failed") {
          putBackOnComposer();
          return;
        }
        itemImages.push(read);
      }
      builtContributions.push({ text: item.text, chips: item.chips, images: itemImages });
    }
    if (gen !== session.gen || session.client !== client) {
      putBackOnComposer();
      return;
    }

    const images = builtContributions.flatMap((item) => item.images);
    if (images.length && !client.honorsInterjectContent()) {
      putBackOnQueue();
      this.notifyUser("warning",
        "This agent cannot steer attachments mid-turn — your message was queued instead. It will send when the turn finishes.",
      );
      return;
    }

    const implicitChips: ContextChip[] = [];
    const slashCommand = matchSlashCommand(
      queuedSendsText(contributions) || authored,
      client.availableCommands.map((c) => c.name),
    );
    const built = builtContributions.length === 1
      ? buildPromptWithImages(
        builtContributions[0].text,
        builtContributions[0].chips,
        builtContributions[0].images,
        promptDeps,
        slashCommand != null,
      )
      : buildQueuedPromptWithImages(builtContributions, implicitChips, promptDeps, slashCommand != null);

    await this.deps.steerOps.retainUploadedFilesForSession(
      session,
      contributions.flatMap((item) => item.chips),
    );
    if (gen !== session.gen || session.client !== client) {
      putBackOnComposer();
      return;
    }

    if (!turnIsInFlight(session)) {
      putBackOnQueue();
      void this.deps.steerOps.maybeFlushQueuedSends(session);
      return;
    }

    const displayText = queuedSendsText(contributions);
    const displayChips = contributions.flatMap((item) => item.chips);
    this.emit(session, {
      type: "userMessage",
      text: displayText,
      chips: displayChips,
      steer: true,
    });

    const rpcText = images.length ? displayText : built.text;
    try {
      const r = await client.interject(rpcText, () => {
        if (gen === session.gen && session.client === client) session.interjectionCount += 1;
      }, images.length ? built.blocks : undefined);
      if (r === "unsupported") {
        this.emit(session, { type: "steerUnavailable" });
        this.emit(session, { type: "agentReset" });
        putBackOnQueue();
        this.notifyUser("warning",
          steerUnavailableNotice(session.provider),
        );
        return;
      }
      if (r === "failed") {
        putBackOnQueue();
        this.notifyUser("warning",
          "The agent could not take that correction mid-turn — your message was queued instead. It will send when the turn finishes.",
        );
        return;
      }
      this.host?.appendLine(
        images.length
          ? `[steer] interjected ${rpcText.length} chars + ${images.length} image(s) into the running turn`
          : `[steer] interjected ${rpcText.length} chars into the running turn`,
      );
    } catch (e: any) {
      this.emit(session, { type: "agentReset" });
      putBackOnQueue();
      this.emit(session, { type: "error", text: `Steer failed: ${e?.message ?? e}. Your message was queued instead.` });
    }
  }

  /**
   * Handle thumbs-up / thumbs-down ratings for an agent turn.
   */
  public async handleTurnFeedback(
    rating: unknown,
    session: Session,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleTurnFeedback>("handleTurnFeedback");
    if (override) return override(rating, session);

    const previous = session.turnRating;
    const revert = () => this.deps.feedbackOps.ackTurnFeedback(session, previous);
    if (!isThumbsRating(rating)) {
      revert();
      return;
    }
    if (!this.deps.feedbackOps.thumbsFeedbackEnabled()) {
      revert();
      return;
    }
    if (providerCapability(session.provider, "feedback").state !== "yes" || !session.feedbackAvailable) {
      this.deps.feedbackOps.latchFeedbackUnavailable(session);
      revert();
      return;
    }
    if (!session.liveFeedbackEligible) {
      revert();
      this.notifyUser("warning", "Only the latest reply in this session can be rated.");
      return;
    }
    const client = session.client;
    if (!client?.sessionId) {
      revert();
      this.notifyUser("warning", "Start a Grok session before rating a turn.");
      return;
    }
    try {
      const result = await client.submitFeedback({
        ratingValue: rating,
        clientType: feedbackClientType(this.deps.feedbackOps.canSwitchWorkspaceFolder()),
        clientVersion: this.deps.feedbackOps.contextExtensionVersion(),
      });
      if (result === "unsupported") {
        this.deps.feedbackOps.latchFeedbackUnavailable(session);
        revert();
        this.notifyUser("warning",
          "Turn ratings need a Grok Build CLI that accepts feedback.",
        );
        return;
      }
      if (!session.liveFeedbackEligible) return;
      this.deps.feedbackOps.ackTurnFeedback(session, rating);
    } catch (e: any) {
      revert();
      this.notifyUser("error", `Couldn't send that rating: ${e?.message ?? e}`);
    }
  }

  /**
   * Fork (#48) — branch this session's conversation into a new session and focus it.
   */
  public async forkFocusedSession(session: Session = this.deps.getFocused()): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.forkFocusedSession>("forkFocusedSession");
    if (override) return override(session);

    if (!session.client || !session.activeSessionId) {
      this.notifyUser("warning", "Start a session before forking it.");
      return;
    }
    if (!session.hasHistory) {
      this.notifyUser("info", "Nothing to fork yet — this session has no conversation.");
      return;
    }
    const parentName = this.sessionDisplayName(session);
    const forkName = forkDisplayName(parentName);
    try {
      const cwd = this.sessionCwd(session);
      const r = await session.client.forkSession(cwd);
      if (r === "unsupported") {
        this.notifyUser("warning",
          "Forking needs a newer Grok Build CLI. Update via Settings → About.",
        );
        return;
      }
      this.host?.appendLine(`[fork] ${session.activeSessionId} → ${r.newSessionId} ("${forkName}")`);
      const overrides = this.state?.get<SessionMetaOverrides>(SESSION_META_KEY, {}) ?? {};
      const prev = overrides[r.newSessionId] ?? {};
      const parentUploads = overrides[session.activeSessionId]?.uploadedFiles ?? [];
      const parentMeta = overrides[session.activeSessionId] ?? {};
      const forkedType = forkedSessionTypeMeta(parentMeta, Date.now());
      const carried: SessionMetaOverrides[string] = {
        ...prev,
        ...forkedType,
        customName: forkName,
        uploadedFiles: [...new Set([...(prev.uploadedFiles ?? []), ...parentUploads])],
        contextUsed: undefined,
        contextWindow: undefined,
        contextObservation: undefined,
        contextPendingCompact: undefined,
      };
      if (session.worktree) {
        carried.worktreePath = session.worktree.path;
        carried.worktreeLabel = session.worktree.label;
        carried.sourceGitRoot = session.worktree.sourceGitRoot;
      }
      await this.state?.update(SESSION_META_KEY, {
        ...overrides,
        [r.newSessionId]: carried,
      });
      this.sessionCache.delete(r.newSessionId);

      await this.openSession(r.newSessionId, cwd);
      this.notifyUser("info",
        `Forked into "${forkName}". The original conversation is unchanged and is in your session history` +
        (parentName ? ` as "${parentName}"` : "") +
        ". Files on disk were not touched.",
      );
    } catch (e: any) {
      this.notifyUser("error", `Fork failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Edit-and-resend the latest user message (#56).
   */
  public async editLastMessage(
    userBubbleIndex: number,
    text: string,
    totalUserBubbles?: number,
    session: Session = this.deps.getFocused(),
    requestedChips?: ContextChip[],
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.editLastMessage>("editLastMessage");
    if (override) return override(userBubbleIndex, text, totalUserBubbles, session, requestedChips);

    if (!session.client || !session.activeSessionId) {
      return void this.notifyUser("warning", "Start a session before editing a message.");
    }
    if (session.status === "working" || session.status === "needs-you") {
      this.host?.appendLine(
        `[edit] refused: session.status=${session.status} bubble=${userBubbleIndex}`,
      );
      return void this.notifyUser("warning",
        session.status === "needs-you"
          ? "Answer the pending permission or plan card first, then edit your last message."
          : "Wait for the current turn to finish (or Stop it) before editing your last message.",
      );
    }
    const { client, gen, activeSessionId, userMessageCount } = session;
    const sent = session.buffer.filter((message): message is Extract<HostMsg, { type: "userMessage" }> => message.type === "userMessage" && !message.steer)[userBubbleIndex];
    const chips = sent?.chips?.filter(chip => !requestedChips || requestedChips.some(requested => requested.id === chip.id)) ?? [];

    if (providerCapability(session.provider, "nativeRewind").state !== "yes") {
      await this.deps.rewindOps.rewindFromClientCheckpoints(session, {
        userBubbleIndex, bubbleText: text, totalUserBubbles, edit: true, chips,
      });
      return;
    }
    try {
      const points = await client.listRewindPoints();
      if (points === "unsupported") {
        await this.deps.rewindOps.rewindFromClientCheckpoints(session, {
          userBubbleIndex, bubbleText: text, totalUserBubbles, edit: true, chips,
        });
        return;
      }
      if (!bubbleMapIsConsistent(points, totalUserBubbles)) {
        this.host?.appendLine(
          `[rewind] map mismatch: ${userFacingRewindPoints(points).length} wire points vs ${totalUserBubbles} visible messages`,
        );
        return void this.notifyUser("warning",
          "Grok's restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
        );
      }
      const target = resolveEditRewindTarget(points, userBubbleIndex);
      if (!target) {
        this.restoreComposerFor(session, text, chips);
        return void this.notifyUser("info",
          "Grok has no restore point for that message, so it can't be rolled back. Its text is back in the composer.",
        );
      }

      if (anyFilesAfter(points, target)) {
        const gitStatus = await this.deps.rewindOps.checkWorkspaceGitStatus(session.cwd || this.deps.rewindOps.workspaceRoot());
        const ok = await this.deps.rewindOps.confirmInChat(session, {
          title: "Edit this message?",
          body: editRewindConfirmMessage(target, true, gitStatus),
          confirmLabel: "Edit",
          danger: true,
        });
        if (!ok) return;
      }

      if (
        session.client !== client || session.gen !== gen || session.activeSessionId !== activeSessionId ||
        session.userMessageCount !== userMessageCount ||
        ["working", "needs-you"].includes(session.status)
      ) {
        return void this.notifyUser("warning",
          "Edit cancelled because the conversation changed or another turn started. Nothing was rewound. Try Edit again when the conversation is idle.",
        );
      }
      const result = await client.executeRewind({
        targetPromptIndex: target.promptIndex,
        mode: "all",
      });
      if (result === "unsupported") {
        await this.deps.rewindOps.rewindFromClientCheckpoints(session, {
          userBubbleIndex, bubbleText: text, totalUserBubbles, edit: true, chips,
        });
        return;
      }
      if (!result.success) {
        return void this.notifyUser("error", result.error || "Couldn't roll back that message.");
      }

      const reportedFiles = result.revertedFiles.length;
      this.host?.appendLine(
        `[edit] rewound to prompt #${result.targetPromptIndex} (reported_files=${reportedFiles}, bubble=${userBubbleIndex})`,
      );
      const resumeId = session.activeSessionId;
      const surviving = survivingUserMessagesAfterRewind(points, target);
      if (resumeId) await this.deps.rewindOps.truncateSessionCardsAfterRewind(resumeId, surviving);
      this.deps.rewindOps.applyRewindToView(session, surviving);
      if (resumeId) this.deps.checkpointStore?.pruneAfter(resumeId, surviving);
      this.restoreComposerFor(session, text, chips);
      if (reportedFiles > 0) {
        this.notifyUser("info",
          "Message moved back to the composer. Files were rolled back — anything created after that point may still be on disk.",
        );
      }
    } catch (e: any) {
      this.notifyUser("error", `Couldn't edit that message: ${e?.message ?? e}`);
    }
  }

  /**
   * Rewind (P2-9) — roll the conversation (and file snapshots) back to an earlier user prompt.
   */
  public async rewindFocusedSession(
    userBubbleIndex?: number,
    bubbleText?: string,
    totalUserBubbles?: number,
    session: Session = this.deps.getFocused(),
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.rewindFocusedSession>("rewindFocusedSession");
    if (override) return override(userBubbleIndex, bubbleText, totalUserBubbles, session);

    if (!session.client || !session.activeSessionId) {
      return void this.notifyUser("warning", "Start a session before rewinding it.");
    }
    if (session.status === "working" || session.status === "needs-you") {
      return void this.notifyUser("warning",
        "Wait for the current turn to finish (or Stop it) before rewinding.",
      );
    }
    if (!session.hasHistory) {
      return void this.notifyUser("info", "Nothing to rewind yet — this session has no conversation.");
    }
    const { client, gen, activeSessionId, userMessageCount } = session;
    if (providerCapability(session.provider, "nativeRewind").state !== "yes") {
      await this.deps.rewindOps.rewindFromClientCheckpoints(session, {
        userBubbleIndex, bubbleText, totalUserBubbles, edit: false,
      });
      return;
    }
    try {
      const points = await client.listRewindPoints();
      if (points === "unsupported") {
        await this.deps.rewindOps.rewindFromClientCheckpoints(session, {
          userBubbleIndex, bubbleText, totalUserBubbles, edit: false,
        });
        return;
      }

      if (!bubbleMapIsConsistent(points, totalUserBubbles)) {
        this.host?.appendLine(
          `[rewind] map mismatch: ${userFacingRewindPoints(points).length} wire points vs ${totalUserBubbles} visible messages`,
        );
        return void this.notifyUser("warning",
          "Grok's restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
        );
      }
      let target: ReturnType<typeof resolveUserBubbleRewind> = null;
      if (typeof userBubbleIndex === "number") {
        target = resolveUserBubbleRewind(points, userBubbleIndex);
        if (!target) {
          return void this.notifyUser("info",
            "Can't rewind to this message — it's the latest turn, or the checkpoint is unavailable.",
          );
        }
      } else {
        const facing = userFacingRewindPoints(points);
        const selectable = selectableRewindPoints(facing.length ? facing : points);
        if (selectable.length === 0) {
          return void this.host?.showInformationMessage(
            facing.length <= 1
              ? "Only one message so far — hover an earlier user message and click Rewind."
              : "No rewind points available.",
          );
        }
        const visiblePosition = new Map(facing.map((p, i) => [p.promptIndex, i + 1]));
        const items = [...selectable]
          .sort((a, b) => b.promptIndex - a.promptIndex)
          .map((p) => ({
            label: formatRewindPointLabel(p, visiblePosition.get(p.promptIndex)),
            description: p.hasFileChanges ? "files" : undefined,
            detail: formatRewindPointDetail(p),
            point: p,
          }));
        const pick = await this.host?.showQuickPick(items, {
          placeHolder: "Rewind past which message? (it and everything after it are discarded)",
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!pick) return;
        target = pick.point;
      }

      const revertsFiles = anyFilesAfter(points, target);
      if (revertsFiles) {
        const gitStatus = await this.deps.rewindOps.checkWorkspaceGitStatus(session.cwd || this.deps.rewindOps.workspaceRoot());
        const ok = await this.deps.rewindOps.confirmInChat(session, {
          title: "Rewind past this message?",
          body: rewindConfirmMessage(target, "all", gitStatus),
          confirmLabel: "Rewind",
          danger: true,
        });
        if (!ok) return;
      }

      if (
        session.client !== client || session.gen !== gen || session.activeSessionId !== activeSessionId ||
        session.userMessageCount !== userMessageCount ||
        ["working", "needs-you"].includes(session.status)
      ) {
        return void this.notifyUser("warning",
          "Rewind cancelled because the conversation changed or another turn started. Nothing was rewound. Try Rewind again when the conversation is idle.",
        );
      }
      const result = await client.executeRewind({
        targetPromptIndex: target.promptIndex,
        mode: "all",
      });
      if (result === "unsupported") {
        await this.deps.rewindOps.rewindFromClientCheckpoints(session, {
          userBubbleIndex, bubbleText, totalUserBubbles, edit: false,
        });
        return;
      }
      if (!result.success) {
        const err = result.error || "Rewind did not apply (no changes).";
        return void this.notifyUser("error", err);
      }

      const reportedFiles = result.revertedFiles.length;
      this.host?.appendLine(
        `[rewind] → prompt #${result.targetPromptIndex} (mode=${result.mode}, reported_files=${reportedFiles}` +
        (typeof userBubbleIndex === "number" ? `, bubble=${userBubbleIndex}` : "") +
        `)`,
      );
      const resumeId = session.activeSessionId;
      const surviving = survivingUserMessagesAfterRewind(points, target);
      if (resumeId) await this.deps.rewindOps.truncateSessionCardsAfterRewind(resumeId, surviving);
      this.deps.rewindOps.applyRewindToView(session, surviving);
      if (resumeId) this.deps.checkpointStore?.pruneAfter(resumeId, surviving);
      const restored = (bubbleText ?? "").trim();
      if (restored) this.restoreComposerFor(session, restored);
      if (reportedFiles > 0) {
        this.notifyUser("info",
          "Rewound. Files were rolled back — anything created after that point may still be on disk.",
        );
      }
    } catch (e: any) {
      this.notifyUser("error", `Rewind failed: ${e?.message ?? e}`);
    }
  }

  /**
   * User picked an action on the limit card.
   */
  public async answerLimitOffer(
    session: Session,
    msg: { id: string; action: "continue" | "retry" | "dismiss"; target?: AcpProvider },
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.answerLimitOffer>("answerLimitOffer");
    if (override) return override(session, msg);

    const offer = session.pendingLimitOffer;
    if (!offer || offer.id !== msg.id) return;
    session.pendingLimitOffer = undefined;

    if (msg.action === "continue") {
      const allowed = limitOfferTargets(offer.source, this.deps.authLimitOps.usableProviders());
      const chosen = allowed.find((t) => t.id === msg.target);
      if (!chosen) {
        session.pendingLimitOffer = offer;
        return;
      }
      this.emit(session, {
        type: "limitOfferResolved",
        id: offer.id,
        action: "continue",
        target: chosen.id,
        targetName: chosen.name,
      });
      this.host?.appendLine(`[limit] switching ${offer.source} → ${chosen.id} (${offer.kind})`);
      this.emit(session, {
        type: "hostNotice",
        level: "info",
        text: switchTranscriptLine(offer.source, chosen.id),
      });
      session.provider = chosen.id;
      session.keepTranscriptOnStart = true;
      await this.deps.authLimitOps.rememberProjectProvider(this.sessionCwd(session), chosen.id);
      const client = await this.startSession(undefined, session);
      if (!client) return;
      session.chips = [...offer.chips, ...session.chips];
      await this.handleSend(offer.text, false, session);
      return;
    }

    this.emit(session, { type: "limitOfferResolved", id: offer.id, action: msg.action });
    if (msg.action !== "retry") return;
    session.chips = [...offer.chips, ...session.chips];
    await this.handleSend(offer.text, false, session);
  }

  /**
   * Recover from an expired-token turn failure without a manual sign-out.
   */
  public async recoverAuthAndResend(
    session: Session,
    err: unknown,
    displayText: string,
    chips: ContextChip[],
    promptBlocks: Parameters<AcpClient["prompt"]>[0],
  ): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.recoverAuthAndResend>("recoverAuthAndResend");
    if (override) return override(session, err, displayText, chips, promptBlocks);

    const errorText = errorDetail(err);
    const credential = session.client?.isCredentialError(err) === true || isCredentialError(err);
    if (!credential && !isAuthErrorText(errorText)) return false;
    const resumeId = beginAuthRecovery(session);
    if (!resumeId) {
      if (credential) this.setProviderNeedsLogin(session.provider, true);
      return false;
    }

    if (!credential) {
      this.host?.appendLine(`[auth] rebuilding the session without resending: ${errorText}`);
      await this.startSession(resumeId, session);
      return false;
    }
    this.host?.appendLine(`[auth] recoverable token error — reloading session + resending: ${errorText}`);

    const client = await this.startSession(resumeId, session);
    if (!client || session.client !== client) return true;
    const gen = session.gen;
    if (gen !== session.gen) return true;

    const replayRestoredIt = session.inUserMessage
      && session.replayUserRaw.trim() === displayText.trim();
    if (!replayRestoredIt) {
      session.userMessageCount += 1;
      this.emit(session, { type: "userMessage", text: displayText, chips });
    }
    this.emit(session, { type: "agentStart" });
    const turn = beginTurn(session);
    this.deps.authLimitOps.startTurnGitBaseline(session, turn);
    this.setStatus(session, "working");
    session.adapterTurnCallUsed = [];
    try {
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) {
        this.deps.authLimitOps.emitAbandonedSend(session);
        return true;
      }
      if (!endTurn(session, turn)) return true;
      this.emit(session, { type: "agentEnd", meta, ...this.turnEndFields(session, turnStatusFromPromptResult(meta)) });
      this.noteLiveTurnEnded(session);
      this.setStatus(session, "done");
      session.authRecoveryTried = false; // recovered
      this.setProviderNeedsLogin(session.provider, false);
      this.deps.authLimitOps.maybeGenerateTitle(session);
      this.deps.authLimitOps.postSessionName(session);
    } catch (err2) {
      if (gen !== session.gen) {
        this.deps.authLimitOps.emitAbandonedSend(session);
        return true;
      }
      if (!endTurn(session, turn)) return true;
      const e2 = err2 as any;
      if (this.surfaceLimitError(session, e2, displayText, chips)) return true;
      if (client.isCredentialError(e2) || isCredentialError(e2)) {
        this.emit(session, { type: "agentError", text: errorDetail(e2), ...this.turnEndFields(session, "failed") });
        this.noteLiveTurnEnded(session);
        this.setStatus(session, "error");
        this.setProviderNeedsLogin(session.provider, true);
        this.post({ type: "onboarding", state: this.onboardingForSession(session) });
      } else {
        this.host?.appendLine(
          `[${session.provider}] resend failed for session ${session.client?.sessionId ?? session.activeSessionId ?? "none"}`
          + `: ${errorDetail(e2)}`,
        );
        this.emit(session, { type: "agentError", text: promptErrorText(e2), ...this.turnEndFields(session, "failed") });
        this.noteLiveTurnEnded(session);
        this.setStatus(session, "error");
      }
    } finally {
      endTurn(session, turn);
    }
    return true;
  }


  public async recoverUnansweredCancel(session: Session, token: object): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.recoverUnansweredCancel>("recoverUnansweredCancel");
    if (testOverride) return testOverride(session, token);

    // Nothing to recover if the client is already gone — something else tore it
    // down (a crash, a removed worktree), and respawning here would resurrect a
    // session that was deliberately ended, possibly against a cwd that no longer
    // exists. Belt to the generation check: whoever disposes a client is
    // expected to invalidate the turn, and this survives one that forgets.
    if (!session.client) {
      endTurn(session, token);
      return;
    }
    this.deps.sidebarOps.host.appendLine("[turn] cancel went unanswered; restarting this session's CLI");
    // Said BEFORE the restart, deliberately. startSession unlocks the composer
    // and flushes any queued sends itself, so a notice emitted afterwards could
    // land behind that queued turn's userMessage/agentStart — reading as if the
    // new turn had failed, and clearing the busy state of a turn that had only
    // just begun. Live-only as a consequence (the restart clears the buffer);
    // the conversation itself is reloaded from disk intact.
    session.staleSendReported = true;
    this.deps.sidebarOps.emit(session, {
      type: "agentError",
      text: "Stopped. The agent didn't answer the stop request, so its process is being restarted. This conversation is intact.",
      ...this.deps.sidebarOps.turnEndFields(session, "cancelled")
    });
    const client = await this.deps.sidebarOps.startSession(session.activeSessionId, session);
    // Another restart can overtake this one while it is starting. Then the
    // session belongs to that one, and nothing here has anything to say about
    // it — least of all an error.
    if (session.client && session.client !== client) return;
    if (!session.client) {
      // startSession clears the token on its way through, but it can fail before
      // reaching that; either way this session must not be left pinned mid-turn.
      endTurn(session, token);
      this.deps.sidebarOps.emit(session, {
        type: "agentError",
        text: "The agent's process couldn't be restarted. Send again to start it."
      });
      this.deps.sidebarOps.setStatus(session, "error");
    }
    // A successful restart has already cleared the token, unlocked the composer
    // and flushed anything queued. There is nothing left to do here.
  }

  /** A send that raced into a running turn (desk↔remote co-attach: the other
     *  view learns `busy` only after agentStart crosses the relay). Ordinary
     *  sends join the host-owned queue — what the sender's own chat.js does
     *  when it knows in time. Bare slash turns (/compact, /workflow …) can't be
     *  queued (their text would corrupt the combined queued prompt) and must
     *  not cancel the running turn either, so they are rejected visibly.
     *
     *  Known limitation: a raced remote send's `submissionId` is lost here.
     *  The queue intentionally collapses contributions into one string, so
     *  retaining one id would falsely acknowledge the others when several
     *  views race. This can leave a refresh-correctable duplicate, not lose
     *  delivery. Revisit when queued state can track every contribution id and
     *  one committed message can acknowledge all of them without changing the
     *  relay dequeue handshake. */
  public divertRacingSend(
    session: Session,
    text: string,
    bare: boolean,
    chips: ContextChip[] = explicitVisibleChips(session.chips),
  ): void {
    const testOverride = this.deps.getOverride?.<typeof this.divertRacingSend>("divertRacingSend");
    if (testOverride) return testOverride(session, text, bare, chips);

    if (bare) {
      this.deps.sidebarOps.emit(session, {
        type: "error",
        text: "Grok is mid-turn — that command was not run. Try again when the turn finishes."
      });
      return;
    }
    if (!text.trim() && !chips.length) return;
    session.queuedSends = enqueueQueuedSend(session.queuedSends, text, chips);
    if (chips.length) {
      session.chips = consumeChips(session.chips, chips);
      if (session === this.deps.sidebarOps.focused) this.deps.sidebarOps.refreshImplicitChip(true);
      else this.deps.sidebarOps.postChips(session);
    }
    this.deps.sidebarOps.emitQueuedSends(session);
    void this.deps.sidebarOps.maybeFlushQueuedSends(session);
  }

  /**
     * If this turn failure is a rate or quota limit, post the failover card and
     * stash the prompt so Continue / Wait can resend it. Returns true when it
     * handled the error (caller must not also show it, and must not resend).
     */
  public surfaceLimitError(
    session: Session,
    err: unknown,
    displayText: string,
    chips: ContextChip[],
  ): boolean {
    const testOverride = this.deps.getOverride?.<typeof this.surfaceLimitError>("surfaceLimitError");
    if (testOverride) return testOverride(session, err, displayText, chips);

    const code = typeof (err as { code?: unknown })?.code === "number" ? (err as { code: number }).code : undefined;
    const kind = classifyLimitError(session.provider, errorDetail(err), code);
    if (kind !== "rate" && kind !== "quota") return false;
    const id = randomUUID();
    const source = session.provider;
    const targets = limitOfferTargets(source, this.deps.sidebarOps.usableProviders(), (provider) => this.deps.sidebarOps.measuredFreePercent(provider));
    const recommended = recommendedLimitAction(kind, targets);
    session.pendingLimitOffer = { id, kind, source, text: displayText, chips: chips.slice() };
    this.deps.sidebarOps.emit(session, {
      type: "limitOffer",
      id,
      kind,
      source,
      targets,
      title: limitOfferTitle(kind, source),
      text: `${rateLimitNoticeText(err)} ${limitOfferHint(kind, targets.length > 0)}`,
      recommended,
      ...this.deps.sidebarOps.turnEndFields(session, "failed")
    });
    this.deps.sidebarOps.noteLiveTurnEnded(session);
    this.deps.sidebarOps.setStatus(session, "error");
    return true;
  }

  /** K-05: a context overflow gets its own card instead of a raw error. */
  public surfaceContextOverflow(session: Session, err: unknown, displayText: string, chips: ContextChip[]): boolean {
    const testOverride = this.deps.getOverride?.<typeof this.surfaceContextOverflow>("surfaceContextOverflow");
    if (testOverride) return testOverride(session, err, displayText, chips);

    if (!isContextOverflowError(errorDetail(err))) return false;
    const id = randomUUID();
    session.pendingOverflow = { id, text: displayText, chips: chips.slice(), notSent: err instanceof ContextBudgetExceededError };
    this.deps.sidebarOps.host.appendLine(`[context] overflow: ${errorDetail(err)}`);
    this.deps.sidebarOps.emit(session, {
      type: "contextOverflow",
      id,
      text: CONTEXT_OVERFLOW_TEXT,
      canCompact: providerCapability(session.provider, "manualCompact").state === "yes",
      canReduce: err instanceof ContextBudgetExceededError,
      ...this.deps.sidebarOps.turnEndFields(session, "failed")
    });
    this.deps.sidebarOps.noteLiveTurnEnded(session);
    this.deps.sidebarOps.setStatus(session, "error");
    return true;
  }

  public async answerContextOverflow(
    session: Session,
    msg: { id: string; action: "compact-retry" | "fresh" | "dismiss" },
  ): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.answerContextOverflow>("answerContextOverflow");
    if (testOverride) return testOverride(session, msg);

    const pending = session.pendingOverflow;
    if (!pending || pending.id !== msg.id) return;
    const restore = () => {
      session.chips = [...pending.chips, ...session.chips].filter((chip, index, all) => all.findIndex(other => other.id === chip.id) === index);
      this.deps.sidebarOps.emit(session, { type: "restoreComposer", text: pending.text });
      this.deps.sidebarOps.emit(session, { type: "chips", chips: session.chips });
    };
    session.pendingOverflow = undefined;
    if (msg.action === "fresh") {
      restore();
      await this.deps.sidebarOps.continueInFreshSession(session);
      return;
    }
    if (msg.action !== "compact-retry") { if (pending.notSent) restore(); return; }
    // One attempt: compact, then the lost message once more ONLY if it was not already sent.
    // If the turn was already sent to the CLI, tool calls or partial work may have
    // executed, so never auto-repeat the agent turn. Restore draft and chips instead.
    try { await this.deps.sidebarOps.handleSend("/compact", true, session); }
    catch { restore(); return; }
    if (session.status === "error") { restore(); return; }
    if (pending.notSent) {
      session.chips = [...pending.chips, ...session.chips].filter((chip, index, all) => all.findIndex(other => other.id === chip.id) === index);
      await this.deps.sidebarOps.handleSend(pending.text, false, session);
    } else {
      restore();
    }
  }
}

export function createTurnEdit(deps: TurnEditDeps): TurnEdit {
  return new TurnEdit(deps);
}
