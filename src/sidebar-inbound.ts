import { autoApproveNativePlanTools } from "./provider-modes";
import { PROVIDER_CLI } from "./provider-cli";
import { providerCapability } from "./provider-capabilities";
/**
 * Inbound webview router (W-15 Schritt D1).
 * The sidebar keeps onMessage as a forwarder. Each domain router owns a
 * disjoint slice of the former switch. Fall-through pairs stay in one clause.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session } from "./session";
import { pendingPermissionOptions } from "./session";
import { shouldRehydrateOnWebviewReady, type Host, type HostContext } from "./host";
import type { HostMsg, WebviewMsg } from "./protocol";
import type { AcpProvider } from "./acp-backend";
import { isAcpProvider, isAdapterProvider } from "./acp-backend";
import { summarizeForSpeech } from "./speech-summary";
import {
  parseAgentCommand,
  parseCrewCommand,
  parseHandoffCommand,
  parseSubagentsCommand,
} from "./slash-filter";
import {
  chipsForQueueSend,
  dequeueQueuedSends,
  enqueueQueuedSend,
  restoreQueuedChips,
} from "./queued-send";
import {
  consumeChips,
  isImageChip,
  isImplicitChip,
  removeChip,
  toggleChip,
} from "./chips";
import { isFileChip } from "./context-chips";
import { stagedUploadDirectory } from "./file-upload";
import {
  isPlanReviewPermission,
  permissionAnswerAllowed,
  planReviewVerdictForOption,
} from "./plan-gate";
import {
  filterMentionFiles,
  filterMentionSources,
  isMentionPathInsideWorkspace,
  resolveMentionAttachmentPath,
} from "./mention";
import { pathsEqual } from "./worktree";
import { APP_PURPOSE_KEY, parseAppPurpose } from "./app-purpose";
import { manualWindowKey, validateRoutine } from "./routines";
import {
  WELCOME_TIPS_KEY,
  WELCOME_TIPS_SHOWN_KEY,
  localDayKey,
  withDismissedTip,
  withShownTip,
} from "./welcome-tips";
import { GROK_VIEW_ID, moveViewContainerFor, panelPositionFor } from "./view-move";
import {
  sanitizeVoiceKeyterms,
  sanitizeVoiceSendPhrase,
  voiceSettingWriteTarget,
} from "./voice";
import { missingProviderState, providerDisplayName, providerLoginState } from "./provider-ui";

/** VS Code globalState key for the eye-off choice on the active-editor chip. */
export const IMPLICIT_CHIP_HIDDEN_KEY = "grok.implicitChipHidden";

type AttachmentOwner = () => Session | undefined;

export interface InboundSlots {
  agentRolesError: any;
  agentRuns: any;
  codexInstallAbort: any;
  firstBootScanCompleted: any;
  firstBootScanStarted: any;
  fullImagePaths: any;
  loginReprobeTimers: any;
  pendingConfirms: any;
  projectsRail: any;
  providerNeedsLogin: any;
  routineError: any;
  routineRuns: any;
  routinesInFlight: any;
  settingsEditor: any;
  subagents: any;
}

export interface InboundBootOps {
  completeFirstBootScan(...args: any[]): any;
  postInitialState(...args: any[]): any;
  postRepoCatalog(...args: any[]): any;
  postSessionsList(...args: any[]): any;
  runFirstBootScan(...args: any[]): any;
}
export interface InboundComposerOps {
  addContextSourceChip(...args: any[]): any;
  addDroppedFile(...args: any[]): any;
  addPastedImage(...args: any[]): any;
  answerContextOverflow(...args: any[]): any;
  answerLimitOffer(...args: any[]): any;
  continueInFreshSession(...args: any[]): any;
  emitQueuedSends(...args: any[]): any;
  fileStagingDir(...args: any[]): any;
  handleAgentCommand(...args: any[]): any;
  handleCrewCommand(...args: any[]): any;
  handleHandoffCommand(...args: any[]): any;
  handleSend(...args: any[]): any;
  handleSubagentsCommand(...args: any[]): any;
  handleTurnFeedback(...args: any[]): any;
  isImagePathAuthorizedNow(...args: any[]): any;
  maybeFlushQueuedSends(...args: any[]): any;
  mentionFileIndexForCwd(...args: any[]): any;
  openWorkspaceFileEntries(...args: any[]): any;
  pickFileFromComputer(...args: any[]): any;
  postChips(...args: any[]): any;
  readOriginalImage(...args: any[]): any;
  refreshImplicitChip(...args: any[]): any;
  resolveChatOpenPath(...args: any[]): any;
  steerSend(...args: any[]): any;
  trackAttach(...args: any[]): any;
}
export interface InboundSessionOps {
  armCancelRecovery(...args: any[]): any;
  cancelAgentRun(...args: any[]): any;
  clearAllSessions(...args: any[]): any;
  deleteSession(...args: any[]): any;
  discardAdapterEmptySession(...args: any[]): any;
  discardRestartedEmptySession(...args: any[]): any;
  editLastMessage(...args: any[]): any;
  focusSession(...args: any[]): any;
  forkFocusedSession(...args: any[]): any;
  handleVoiceStart(...args: any[]): any;
  handleVoiceStop(...args: any[]): any;
  newFocusedSession(...args: any[]): any;
  noteAnswered(...args: any[]): any;
  openSession(...args: any[]): any;
  pickRestartMode(...args: any[]): any;
  refuseMismatchedSessionId(...args: any[]): any;
  renameSession(...args: any[]): any;
  restartSession(...args: any[]): any;
  rewindFocusedSession(...args: any[]): any;
  startSession(...args: any[]): any;
  stopVoiceInput(...args: any[]): any;
  syncHumanWait(...args: any[]): any;
}
export interface InboundSessionSettingsOps {
  persistEffort(...args: any[]): any;
  pickModel(...args: any[]): any;
  refreshContextFromSessionInfo(...args: any[]): any;
  refreshSubscriptionUsage(...args: any[]): any;
  setMode(...args: any[]): any;
  setProviderNeedsLogin(...args: any[]): any;
  setSessionType(...args: any[]): any;
  switchModel(...args: any[]): any;
}
export interface InboundWorktreeOps {
  applyFocusedWorktree(...args: any[]): any;
  newWorktreeSession(...args: any[]): any;
  removeFocusedWorktree(...args: any[]): any;
  selectRepo(...args: any[]): any;
  sendLocalRepoSessionsPreview(...args: any[]): any;
  setRepoArchived(...args: any[]): any;
  setRepoColor(...args: any[]): any;
  toggleRepoPin(...args: any[]): any;
  toggleSessionPin(...args: any[]): any;
}
export interface InboundReviewOps {
  addSessionAllowRule(...args: any[]): any;
  answerQuestion(...args: any[]): any;
  cancelQuestion(...args: any[]): any;
  closeDiffForRequest(...args: any[]): any;
  confirmHostExecute(...args: any[]): any;
  exportExpr(...args: any[]): any;
  handleExitPlan(...args: any[]): any;
  openDiffEditor(...args: any[]): any;
  openTurnGitDiff(...args: any[]): any;
  persistAllowRuleFromCard(...args: any[]): any;
  persistPermissionAnswer(...args: any[]): any;
  persistPlanVerdict(...args: any[]): any;
  revertToolEdit(...args: any[]): any;
  reviewRevertAll(...args: any[]): any;
  reviewRevertFile(...args: any[]): any;
  snapshotRelOrAbsPaths(...args: any[]): any;
}
export interface InboundWorkflowOps {
  agentNotice(...args: any[]): any;
  applyWorkflowPlanEdit(...args: any[]): any;
  companionsSetting(...args: any[]): any;
  controlWorkflow(...args: any[]): any;
  defaultWorkflowName(...args: any[]): any;
  gateActionFromMsg(...args: any[]): any;
  handleHostGateAction(...args: any[]): any;
  handleWorkflowGateAction(...args: any[]): any;
  openNewCrewSession(...args: any[]): any;
  poolSessionById(...args: any[]): any;
  sendToRunningStage(...args: any[]): any;
  startHandoff(...args: any[]): any;
  startWorkflowRun(...args: any[]): any;
}
export interface InboundAuthoringOps {
  cancelWorkflowGenerate(...args: any[]): any;
  handleAddWorkflowStagesBlock(...args: any[]): any;
  handleDeleteCompanionFile(...args: any[]): any;
  handleGenerateWorkflow(...args: any[]): any;
  handleSaveAgentRole(...args: any[]): any;
  handleSaveCrewFlow(...args: any[]): any;
  handleSaveWorkflow(...args: any[]): any;
  postAgentRoles(...args: any[]): any;
  postWorkflowValidation(...args: any[]): any;
  setCompanionsSetting(...args: any[]): any;
}
export interface InboundSubagentOps {
  answerSubagentApproval(...args: any[]): any;
  cancelSubagent(...args: any[]): any;
  childOverviewAction(...args: any[]): any;
  continueSubagent(...args: any[]): any;
  postSubagentCard(...args: any[]): any;
  postSubagentTray(...args: any[]): any;
  promoteSubagentSession(...args: any[]): any;
  setSessionDelegation(...args: any[]): any;
  settleSubagentWorktree(...args: any[]): any;
}
export interface InboundRoutineOps {
  loadRoutines(...args: any[]): any;
  mayTargetRoutineCwd(...args: any[]): any;
  postRoutines(...args: any[]): any;
  routineModelOptions(...args: any[]): any;
  runRoutine(...args: any[]): any;
  saveRoutines(...args: any[]): any;
}
export interface InboundProviderOps {
  adoptSessionsForConnectedProvider(...args: any[]): any;
  checkGrokUpdate(...args: any[]): any;
  connectedProviders(...args: any[]): any;
  githubLoginWithToken(...args: any[]): any;
  githubSignOut(...args: any[]): any;
  hasProviderConsent(...args: any[]): any;
  installManagedCodexCli(...args: any[]): any;
  listGithubRepos(...args: any[]): any;
  locateProvider(...args: any[]): any;
  logout(...args: any[]): any;
  notifyUser(...args: any[]): any;
  postVoiceConfigured(...args: any[]): any;
  probeProviderVersion(...args: any[]): any;
  providerCredentialFilePresent(...args: any[]): any;
  providerForRequestedModel(...args: any[]): any;
  refreshProviderStates(...args: any[]): any;
  reprobeProviderCredentials(...args: any[]): any;
  resolveVoiceApiKey(...args: any[]): any;
  setProviderConnectChecking(provider: AcpProvider, checking: boolean): void;
  setProviderConnected(...args: any[]): any;
  setupGithubCli(...args: any[]): any;
  updateGrokCliOnDemand(...args: any[]): any;
  updateProviderCli(...args: any[]): any;
  watchProviderLogin(...args: any[]): any;
}
export interface InboundProjectOps {
  addProjectFolder(...args: any[]): any;
  cloneProject(...args: any[]): any;
  createProject(...args: any[]): any;
  removeProjectFolder(...args: any[]): any;
}
export interface InboundSettingsOps {
  adoptPermissionRules(...args: any[]): any;
  appendRuleFile(...args: any[]): any;
  connectMcpConnector(...args: any[]): any;
  deletePermissionRule(...args: any[]): any;
  disconnectMcpConnector(...args: any[]): any;
  openRuleFile(...args: any[]): any;
  openSettingsEditor(...args: any[]): any;
  postPermissionRules(...args: any[]): any;
  postWelcomeTips(...args: any[]): any;
  refreshMcpServers(...args: any[]): any;
  refreshRuleFiles(...args: any[]): any;
  retireMoveViewHint(...args: any[]): any;
}

/** Top-level context. Capped at 25 members. Domain work lives on the ops bags. */
export interface SidebarInboundDeps {
  readonly host: Host;
  readonly state: HostContext["globalState"];
  getFocused(): Session;
  getPool(): Set<Session>;
  workspaceRoot(): string;
  sessionCwd(session?: Session): string;
  emit(session: Session, msg: HostMsg): void;
  post(msg: HostMsg): void;
  postLocal(msg: HostMsg): void;
  resolveRelayedAnswer(msg: WebviewMsg): { session: Session; msg: WebviewMsg } | undefined;
  readonly slots: InboundSlots;
  readonly boot: InboundBootOps;
  readonly composer: InboundComposerOps;
  readonly sessions: InboundSessionOps;
  readonly review: InboundReviewOps;
  readonly workflow: InboundWorkflowOps;
  readonly routines: InboundRoutineOps;
  readonly providers: InboundProviderOps;
  readonly projects: InboundProjectOps;
  readonly settings: InboundSettingsOps;

  readonly sessionSettings: InboundSessionSettingsOps;
  readonly worktrees: InboundWorktreeOps;

  readonly authoring: InboundAuthoringOps;
  readonly children: InboundSubagentOps;
}

export class SessionInboundRouter {
  constructor(private readonly deps: SidebarInboundDeps) {}
  async tryHandle(msg: WebviewMsg, session: Session, _attachmentOwner: AttachmentOwner, _messageCwd: string): Promise<boolean> {
    switch (msg.type) {
      case "ready": {
        // Decide BEFORE postInitialState runs: its cold-start branch calls
        // startSession(), which can create this.deps.getFocused().client before this
        // handler resumes (synchronously for Codex; Grok assigns behind
        // consent/version awaits — the pre-evaluation is right either way).
        // Re-evaluating afterwards read that self-inflicted "live client" as
        // "a reload rehydrate will post the catalog" and skips it, so a cold
        // desktop boot that auto-restores a session never grew a rail (the
        // race the owner hit as "no left menu"; reload cured it because a
        // real rehydrate runs then). VS Code is immune — its flag is false.
        const rehydrating = shouldRehydrateOnWebviewReady(
          this.deps.host.webviewReloadsUnderLiveSession,
          !!this.deps.getFocused().client,
        );
        this.deps.boot.postInitialState();
        // Rehydrate already posts catalog + sessions. Cold start needs an early
        // disk list so the rail is not empty while startSession runs — but the
        // catalog scan is deferred so ready returns and the UI paints first
        // (large histories must not block activation).
        if (!rehydrating) {
          if (!this.deps.slots.firstBootScanStarted && !this.deps.slots.firstBootScanCompleted) {
            void this.deps.boot.runFirstBootScan({ deferSessions: true });
          } else {
            this.deps.boot.postRepoCatalog();
            setImmediate(() => this.deps.boot.postSessionsList());
          }
        } else {
          this.deps.boot.completeFirstBootScan();
        }
        break;
      }
      case "composerFocus":
        await this.deps.host.setContext("grok.composerFocus", !!msg.focused);
        break;
      case "summarizeSpeech": {
        const text = await summarizeForSpeech(
          msg.text,
          this.deps.providers.resolveVoiceApiKey(session.cwd || this.deps.workspaceRoot()),
          (line) => this.deps.host.appendLine(line),
        );
        this.deps.postLocal({ type: "speechSummary", requestId: msg.requestId, text });
        break;
      }
      case "requestImageOriginal": {
        // Copy image (upstream #150): a webview can DISPLAY a vscode-resource
        // image but not read its pixels back, so the host sends the original
        // bytes for an authorized handle. Never resized.
        const source = this.deps.slots.fullImagePaths.get(msg.fullId);
        if (!source || !this.deps.composer.isImagePathAuthorizedNow(source, session)) break;
        const src = await this.deps.composer.readOriginalImage(source);
        if (!this.deps.composer.isImagePathAuthorizedNow(source, session)) break;
        this.deps.postLocal({ type: "imageOriginal", fullId: msg.fullId, requestId: msg.requestId, src });
        break;
      }
      case "send":
        // `/agent` is answered by the HOST and never reaches a CLI (AP-10).
        // Ahead of the queued-send bookkeeping on purpose: a role run is not a
        // turn on this session, so it must not consume a queued-send dispatch.
        //
        // The SYNCHRONOUS parse comes first and the await only happens for a
        // real `/agent`. An unconditional `await` here would suspend every
        // ordinary send before the duplicate-dequeue check below, which is one
        // of the few places in this file where the ordering is the behaviour.
        if (parseAgentCommand(msg.text).kind !== "none") {
          await this.deps.composer.handleAgentCommand(msg.text, session);
          break;
        }
        // AP-11, under the same rule as the guard above and for the same
        // reason: parsed SYNCHRONOUSLY, awaited only on a hit.
        if (parseHandoffCommand(msg.text).kind !== "none") {
          await this.deps.composer.handleHandoffCommand(msg.text, session);
          break;
        }
        if (parseCrewCommand(msg.text).kind !== "none") {
          await this.deps.composer.handleCrewCommand(msg.text, session);
          break;
        }
        if (parseSubagentsCommand(msg.text).kind !== "none") {
          this.deps.composer.handleSubagentsCommand(msg.text, session);
          break;
        }
        await this.deps.composer.handleSend(msg.text, msg.bare === true, session, undefined, msg.submissionId);
        break;
      case "newSession":
        await this.deps.sessions.newFocusedSession(msg.cwd, msg.draftId);
        break;
      case "cancel": {
        // Stop stops the ROLE when one is running for this thread (AP-10) —
        // the role holds the turn, this session does not.
        if (this.deps.sessions.cancelAgentRun(session)) break;
        const cancelled = session.turnToken;
        await session.client?.cancel("user Stop click");
        if (cancelled) this.deps.sessions.armCancelRecovery(session, cancelled);
        break;
      }
      case "queueSend": {
        // Host-owned per-session queue (#37): each contribution keeps the chips
        // snapshotted here (image numbers already stamped at attach), then the
        // flush sends them as one combined prompt with per-item tags. The
        // webview renders a mirror from queuedSends snapshots, so queued
        // messages survive focus switches and flush even while backgrounded.
        const s = session;
        const text = typeof msg.text === "string" ? msg.text : "";
        const chips = chipsForQueueSend(s.chips, msg.chips);
        if (text.trim() || chips.length) {
          s.queuedSends = enqueueQueuedSend(s.queuedSends, text, chips);
          s.chips = consumeChips(s.chips, chips);
          if (s === this.deps.getFocused()) this.deps.composer.refreshImplicitChip(true);
          else this.deps.composer.postChips(s);
          this.deps.composer.emitQueuedSends(s);
          // If the turn ended while this message was in flight, fire it now.
          void this.deps.composer.maybeFlushQueuedSends(s);
        }
        break;
      }
      case "dequeueSend": {
        // Old webviews render one pending block and send `index: 0` for Edit /
        // Remove / Steer. Chip-aware clients use `clearQueuedSends` for that
        // block, so this message keeps the pre-split meaning: the pending
        // block, not the first of several entries. Passing `false` is the
        // capability gate — every client that still sends `dequeueSend` is the
        // old one.
        const s = session;
        const result = dequeueQueuedSends(s.queuedSends, msg.index, false);
        if (result) {
          s.queuedSendCommit = undefined;
          if (result.removed.some((item) => item.chips.length)) {
            s.chips = restoreQueuedChips(s.chips, result.removed);
          }
          s.queuedSends = result.rest;
          if (s === this.deps.getFocused()) this.deps.composer.refreshImplicitChip(true);
          else this.deps.composer.postChips(s);
          this.deps.composer.emitQueuedSends(s);
        }
        break;
      }
      case "steerSend":
        await this.deps.composer.steerSend(msg.text, session, msg.chips, msg.fromQueue === true);
        break;
      case "turnFeedback":
        await this.deps.composer.handleTurnFeedback(msg.rating, session);
        break;
      case "forkSession":
        if (this.deps.sessions.refuseMismatchedSessionId(msg.sessionId, session)) break;
        await this.deps.sessions.forkFocusedSession(session);
        break;
      case "newWorktreeSession":
        await this.deps.worktrees.newWorktreeSession();
        break;
      case "applyWorktree":
        // The webview's custom confirm already ran (native modals stay only on
        // the Command-Palette path).
        if (this.deps.sessions.refuseMismatchedSessionId(msg.sessionId, session)) break;
        await this.deps.worktrees.applyFocusedWorktree(session, true);
        break;
      case "removeWorktree":
        if (this.deps.sessions.refuseMismatchedSessionId(msg.sessionId, session)) break;
        await this.deps.worktrees.removeFocusedWorktree(session, true);
        break;
      case "rewindSession":
        await this.deps.sessions.rewindFocusedSession(
          typeof msg.userBubbleIndex === "number" ? msg.userBubbleIndex : undefined,
          msg.text,
          // Was dropped here while editLastMessage forwarded it, so the
          // bubble<->restore-point consistency check never ran for the Rewind
          // button — the one path that reverts files without the user naming a
          // target from a list.
          msg.totalUserBubbles,
          session,
        );
        break;
      case "uiConfirmAnswer": {
        const pending = this.deps.slots.pendingConfirms.get(msg.id);
        // Only from the conversation the confirm was ASKED in. `emit` showed it
        // to every surface holding that session, so any of them may answer —
        // what a mismatch means is an answer for somebody else's conversation,
        // and dropping it is right. Ignoring it cannot hang the caller either:
        // the real answer still resolves, and an abandoned confirm already
        // fails closed on session teardown or replacement.
        if (pending && pending.session === session) {
          this.deps.slots.pendingConfirms.delete(msg.id);
          // The first answer from any surface dismisses it on the others.
          this.deps.emit(session, { type: "uiConfirmResolved", requestId: msg.id });
          pending.resolve(msg.ok === true);
        }
        break;
      }
      case "editLastMessage":
        await this.deps.sessions.editLastMessage(msg.userBubbleIndex, msg.text, msg.totalUserBubbles, session, msg.chips);
        break;
      case "refreshSubscriptionUsage":
        void this.deps.sessionSettings.refreshSubscriptionUsage(session);
        break;
      case "refreshContextDetails":
        if (providerCapability(session.provider, "sessionInfo").state === "yes") {
          void this.deps.sessionSettings.refreshContextFromSessionInfo(session, session.gen, {
            force: session.sessionInfoStale,
          });
        }
        break;
      case "clearQueuedSends": {
        // Posted by the webview's Stop/Edit/Remove flows. Stop and Edit set
        // `restore: true` so queued chips return to the composer; Remove omits
        // it and discards them. A halt must not auto-fire queued sends into
        // the cancelled turn's wake — this runs BEFORE cancel on that path.
        const s = session;
        if (s.queuedSends.length) {
          s.queuedSendCommit = undefined;
          const items = s.queuedSends;
          s.queuedSends = [];
          if (msg.restore) {
            s.chips = restoreQueuedChips(s.chips, items);
          }
          if (s === this.deps.getFocused()) this.deps.composer.refreshImplicitChip(true);
          else this.deps.composer.postChips(s);
          this.deps.composer.emitQueuedSends(s);
        }
        break;
      }
      case "pickModel":
        await this.deps.sessionSettings.pickModel();
        break;
      case "setMode":
        await this.deps.sessionSettings.setMode(msg.modeId, session);
        break;
      case "setSessionType":
        this.deps.sessionSettings.setSessionType(session, msg.sessionType);
        break;
      case "contextOverflowAnswer":
        await this.deps.composer.answerContextOverflow(session, msg);
        break;
      case "continueInFreshSession":
        await this.deps.composer.continueInFreshSession(session);
        break;
      case "limitOfferAnswer":
        await this.deps.composer.answerLimitOffer(session, msg);
        break;
      case "setModel":
        await this.deps.sessionSettings.switchModel(
          msg.modelId,
          session,
          isAcpProvider(msg.provider)
            ? msg.provider
            : this.deps.providers.providerForRequestedModel(msg.modelId, session.provider),
        );
        break;
      case "setEffort": {
        if (session.priming) break; // ignore changes fired mid-session-start (see switchModel)
        const newLevel = msg.level;

        if (!session.hasHistory || !session.client) {
          // As with a model switch on an empty session: restart without the summarize-vs-restart
          // prompt and discard the abandoned empty session — but only when it truly had no
          // history (a dead client on a session WITH history must keep that history).
          const wasEmpty = !session.hasHistory;
          const discardId = session.activeSessionId;
          await this.deps.sessionSettings.persistEffort(session.provider, newLevel);
          if (wasEmpty && isAdapterProvider(session.provider)) {
            await this.deps.sessions.discardAdapterEmptySession(session.provider, discardId, this.deps.sessionCwd(session), session.client);
          }
          await this.deps.sessions.startSession(undefined, session);
          if (wasEmpty && session.provider === "grok") this.deps.sessions.discardRestartedEmptySession(discardId, session);
          break;
        }

        // Live effort switch — no restart — when the CLI honors per-session
        // effort (grok ≥ the build advertising models[]._meta.supportsReasoningEffort
        // + accepting set_model _meta.reasoningEffort; confirmed 0.2.101). Only a
        // real, non-empty effort qualifies — "unset" (back to default) still needs
        // a fresh spawn without --reasoning-effort. Persist `defaultEffort` ONLY
        // after the switch actually lands (live-applied, or restart accepted) — a
        // persist-before that fails + dismissed restart would leave the saved
        // default changed while the session ran at the old effort.
        if (newLevel && session.client.currentModelSupportsEffort()) {
          const applied = await session.client.setReasoningEffort(newLevel).catch(() => false);
          if (applied) {
            await this.deps.sessionSettings.persistEffort(session.provider, newLevel);
            break;
          }
        }

        const mode = await this.deps.sessions.pickRestartMode("Changing reasoning effort requires restarting the session.");
        if (!mode) break; // dismissed — leave the remembered effort untouched
        await this.deps.sessionSettings.persistEffort(session.provider, newLevel);
        await this.deps.sessions.restartSession(mode, session);
        break;
      }
      case "listSessions":
        this.deps.boot.postSessionsList({ offset: msg.offset, limit: msg.limit, query: msg.query, providerCursor: msg.providerCursor });
        break;
      case "listRepoSessions":
        // Preview rows for a repo WITHOUT selecting it (the projects rail).
        // Local: desktop multi-folder rail and the VS Code primary-side-bar rail.
        this.deps.worktrees.sendLocalRepoSessionsPreview(msg.cwd, msg.limit);
        break;
      case "toggleSessionPin":
        // Rail pin, when any projects rail is live (desktop multi-folder or
        // VS Code primary-side-bar view).
        if (this.deps.host.canSwitchWorkspaceFolder || this.deps.slots.projectsRail) {
          await this.deps.worktrees.toggleSessionPin(msg.id, msg.cwd, msg.pinned);
        }
        break;
      case "selectRepo":
        await this.deps.worktrees.selectRepo(msg.cwd);
        break;
      case "setRepoArchived":
        await this.deps.worktrees.setRepoArchived(msg.cwd, msg.archived);
        break;
      case "setRepoColor":
        await this.deps.worktrees.setRepoColor(msg.cwd, msg.color);
        break;
      case "toggleRepoPin":
        await this.deps.worktrees.toggleRepoPin(msg.cwd, msg.pinned);
        break;
      case "resumeSession":
        await this.deps.sessions.openSession(msg.id, msg.cwd);
        break;
      case "renameSession":
        this.deps.sessions.renameSession(msg.id, msg.name, msg.cwd);
        break;
      case "deleteSession":
        await this.deps.sessions.deleteSession(msg.id, msg.name, msg.cwd);
        break;
      case "clearAllSessions":
        await this.deps.sessions.clearAllSessions(msg.cwd);
        break;
      case "voiceStart":
        await this.deps.sessions.handleVoiceStart(session);
        break;
      case "voiceStop":
        if (msg.discard) this.deps.sessions.stopVoiceInput();
        else await this.deps.sessions.handleVoiceStop();
        break;
      default:
        return false;
    }
    return true;
  }
}

export class WorkflowInboundRouter {
  constructor(private readonly deps: SidebarInboundDeps) {}
  async tryHandle(msg: WebviewMsg, session: Session, _attachmentOwner: AttachmentOwner, _messageCwd: string): Promise<boolean> {
    switch (msg.type) {
      case "workflowControl":
        await this.deps.workflow.controlWorkflow(msg.action, msg.displayName, session);
        break;
      case "requestHandoff": {
        // The button form (AP-11). Confirmed, unlike the typed one: a click
        // named neither the role nor the task, so the host shows what it
        // chose before spending anything on it.
        await this.deps.workflow.startHandoff(msg.kind, msg.role, session, true);
        break;
      }
      case "childMessage": {
        // The route names the Crew run; the host picks the running stage.
        if (String(msg.route ?? "").startsWith("stage:") && session.workflowRun) {
          await this.deps.workflow.sendToRunningStage(session, String(msg.text ?? ""), msg.mode === "note" ? "note" : "steer");
        }
        break;
      }
      case "stopCrew": {
        this.deps.sessions.cancelAgentRun(session);
        break;
      }
      case "openCrewSession": {
        const id = String(msg.sessionId ?? "").trim();
        if (!id) break;
        const live = [...this.deps.getPool()].find((s) => s.activeSessionId === id);
        if (live) this.deps.sessions.focusSession(live);
        else await this.deps.sessions.openSession(id);
        break;
      }
      case "openAgentArtifact": {
        // Coordinates in, path out — the run store owns the location, so no
        // renderer can name a file outside it (see the protocol note).
        const target = msg.which === "brief"
          ? this.deps.slots.agentRuns.briefPath(msg.runId, msg.step)
          : this.deps.slots.agentRuns.resultPath(msg.runId, msg.step);
        if (!fs.existsSync(target)) {
          this.deps.workflow.agentNotice(session, "warning", `That run artefact is no longer on disk (${msg.runId}, step ${msg.step}).`);
          break;
        }
        void this.deps.host.openResource(target);
        break;
      }
      case "listAgentRoles": {
        // Opening the page is the request. Clearing the last refusal first, so
        // a reopened page does not greet the user with an error they already
        // fixed — same rule as `listRoutines`.
        this.deps.slots.agentRolesError = undefined;
        this.deps.authoring.postAgentRoles();
        break;
      }
      case "saveAgentRole": {
        await this.deps.authoring.handleSaveAgentRole(msg);
        break;
      }
      case "companionSubagentAction": {
        const record = this.deps.slots.subagents.get(msg.subagentId);
        if (!record) break;
        if (msg.action === "cancel") {
          this.deps.children.cancelSubagent(msg.subagentId, "the user cancelled it from the tray");
          this.deps.children.postSubagentCard(session, msg.subagentId);
          this.deps.children.postSubagentTray(session);
        } else if (msg.action === "openTranscript" && record.childSessionId) {
          // The child is hidden from history but its transcript is readable —
          // that is the whole reason §6.6 keeps it rather than asking the CLI
          // not to persist. A live child is focused as it is (X-03).
          const live = this.deps.workflow.poolSessionById(record.childSessionId);
          if (live) this.deps.sessions.focusSession(live);
          else await this.deps.sessions.openSession(record.childSessionId, this.deps.sessionCwd(session));
        } else if (msg.action === "promote") {
          await this.deps.children.promoteSubagentSession(session, msg.subagentId);
        } else if (msg.action === "followUp") {
          const text = String(msg.message ?? "").trim();
          if (!text) break;
          const started = await this.deps.children.continueSubagent(session, msg.subagentId, text);
          if (!started.ok) this.deps.workflow.agentNotice(session, "warning", started.message);
        } else if (msg.action === "applyWorktree" || msg.action === "discardWorktree") {
          await this.deps.children.settleSubagentWorktree(session, msg.subagentId, msg.action === "applyWorktree");
        }
        break;
      }
      case "childOverviewAction":
        await this.deps.children.childOverviewAction(msg);
        break;
      case "setCompanionsSetting":
        await this.deps.authoring.setCompanionsSetting(String(msg.key ?? ""), msg.value);
        break;
      case "setSessionDelegation":
        this.deps.children.setSessionDelegation(session, String(msg.value ?? "auto"));
        break;
      case "subagentApprovalAnswer": {
        this.deps.children.answerSubagentApproval(session, msg);
        break;
      }
      case "workflowStart": {
        const target = [...this.deps.getPool()].find((s) => s.activeSessionId === msg.sessionId) ?? session;
        if (msg.openNew) {
          await this.deps.workflow.openNewCrewSession(msg.idea, msg.workflowName, msg.options);
          break;
        }
        await this.deps.workflow.startWorkflowRun(target, msg.idea, msg.workflowName, msg.options);
        break;
      }
      case "workflowPlanEdit":
        this.deps.workflow.applyWorkflowPlanEdit(session, msg);
        break;
      case "workflowGateAction": {
        if (await this.deps.workflow.handleHostGateAction(session, msg)) break;
        const action = this.deps.workflow.gateActionFromMsg(msg);
        if (action) await this.deps.workflow.handleWorkflowGateAction(session, action);
        break;
      }
      case "openCrewWithGoal":
        await this.deps.workflow.openNewCrewSession(msg.goal, this.deps.workflow.defaultWorkflowName());
        break;
      case "subagentRoutingSave": {
        // Written as the shape the setting documents, with empty strings
        // dropped: `""` is how the page says "not set", and storing it would
        // make `parseRoutingRules` throw the rule away on the next read.
        const rules = (Array.isArray(msg.rules) ? msg.rules : []).map((rule) => ({
          match: Array.isArray(rule.match)
            ? rule.match.map((word) => String(word ?? "").trim()).filter(Boolean)
            : [],
          target: {
            ...(rule.provider ? { provider: rule.provider } : {}),
            ...(rule.model ? { model: rule.model } : {}),
            ...(rule.effort ? { effort: rule.effort } : {}),
          },
        }));
        await this.deps.host.getConfiguration("companions").update("subagents.routing", rules, "global");
        this.deps.host.appendLine(`[companions] routing: ${rules.length} rule(s)`);
        this.deps.authoring.postAgentRoles();
        break;
      }
      case "setCrewStageSubagents":
        await this.deps.host.getConfiguration("companions")
          .update("crew.stagesMayUseSubagents", !!msg.value, "global");
        this.deps.authoring.postAgentRoles();
        break;
      case "setSubagentsEnabled":
        // Global, like the other display and behaviour prefs. The config
        // watcher re-posts it, keeping every open settings page in step.
        await this.deps.host.getConfiguration("companions")
          .update("subagents.enabled", !!msg.value, "global");
        this.deps.authoring.postAgentRoles();
        break;
      case "subagentRosterSave": {
        // A PATCH, merged into the stored object. Two settings pages open on
        // one window must not overwrite each other's untouched rows.
        const stored = this.deps.workflow.companionsSetting("subagents.roster", {}) as Record<string, unknown> | undefined;
        const current = (stored?.[msg.provider] ?? {}) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...(stored ?? {}) };
        const merged: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(msg.patch ?? {})) {
          // An empty string is a real answer here — it means "this companion's
          // own default" / "no ceiling" — so it is stored rather than dropped.
          if (value !== undefined) merged[key] = value;
        }
        next[msg.provider] = merged;
        await this.deps.host.getConfiguration("companions").update("subagents.roster", next, "global");
        this.deps.host.appendLine(
          `[companions] roster: ${msg.provider} ${Object.keys(msg.patch ?? {}).join(", ")}`,
        );
        this.deps.authoring.postAgentRoles();
        break;
      }
      case "deleteAgentRole": {
        this.deps.authoring.handleDeleteCompanionFile(msg.scope, "agents", msg.name);
        break;
      }
      case "saveCrewFlow": {
        await this.deps.authoring.handleSaveCrewFlow(msg);
        break;
      }
      case "deleteCrewFlow": {
        this.deps.authoring.handleDeleteCompanionFile(msg.scope, "crews", msg.name);
        break;
      }
      case "saveWorkflow": {
        await this.deps.authoring.handleSaveWorkflow(msg);
        break;
      }
      case "validateWorkflow": {
        this.deps.authoring.postWorkflowValidation(msg.draft);
        break;
      }
      case "generateWorkflow": {
        await this.deps.authoring.handleGenerateWorkflow(msg);
        break;
      }
      case "cancelWorkflowGenerate":
        this.deps.authoring.cancelWorkflowGenerate();
        break;
      case "setDefaultWorkflow": {
        const name = String(msg.name ?? "").trim().toLowerCase();
        if (name) {
          await this.deps.host.getConfiguration("companions").update("crew.defaultWorkflow", name, "global");
        }
        this.deps.authoring.postAgentRoles();
        break;
      }
      case "addWorkflowStagesBlock": {
        await this.deps.authoring.handleAddWorkflowStagesBlock(msg.scope, msg.name);
        break;
      }
      case "runWorkflow":
        await this.deps.workflow.openNewCrewSession("", msg.name);
        break;
      default:
        return false;
    }
    return true;
  }
}

export class ToolingInboundRouter {
  constructor(private readonly deps: SidebarInboundDeps) {}
  async tryHandle(msg: WebviewMsg, session: Session, attachmentOwner: AttachmentOwner, _messageCwd: string): Promise<boolean> {
    switch (msg.type) {
      case "removeChip": {
        // A removed image chip's staged file has no other reference — reclaim
        // it now instead of leaving multi-MB orphans until the weekly sweep.
        // Only a file chip owns bytes on disk; a diagnostics / terminal chip
        // has nothing to reclaim.
        const removed = session.chips.find((c) => c.id === msg.id);
        if (removed && isFileChip(removed)) {
          if (isImageChip(removed)) {
            void fs.promises.unlink(removed.path).catch(() => {});
          } else {
            const uploadDir = stagedUploadDirectory(this.deps.composer.fileStagingDir(), removed.path);
            if (uploadDir) void fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        session.chips = removeChip(session.chips, msg.id);
        this.deps.composer.postChips(session);
        // A queued send retained after attachment validation failed is waiting
        // for exactly this state change. Re-drive only now (not from the send's
        // finally block, which would loop on the same unreadable attachment).
        void this.deps.composer.maybeFlushQueuedSends(session);
        break;
      }
      case "toggleChip": {
        session.chips = toggleChip(session.chips, msg.id);
        // Eye-off on the active-editor chip is a standing "don't send what I'm
        // looking at", not a one-file choice — remember it so the next file
        // switch doesn't quietly re-enable the context (#67).
        const toggled = session.chips.find((c) => c.id === msg.id);
        if (toggled && isImplicitChip(toggled)) {
          void this.deps.state.update(IMPLICIT_CHIP_HIDDEN_KEY, toggled.hidden);
        }
        this.deps.composer.postChips(session);
        // Hiding an unreadable chip removes it from the next prompt just as
        // deleting it does, so it can unblock a retained idle queue too.
        void this.deps.composer.maybeFlushQueuedSends(session);
        break;
      }
      case "openFile": {
        const { ref, path: p } = this.deps.composer.resolveChatOpenPath(session, msg.path);
        if (ref.startLine != null) {
          const startLine = Math.max(0, ref.startLine - 1);
          const endLine = ref.endLine != null ? Math.max(startLine, ref.endLine - 1) : startLine;
          try {
            await this.deps.host.openTextFile(p, {
              selection: {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: Number.MAX_SAFE_INTEGER },
              },
            });
          } catch {
            void this.deps.host.openResource(p);
          }
        } else {
          void this.deps.host.openResource(p);
        }
        break;
      }
      case "showInFolder": {
        if (!this.deps.host.canShowInFolder) break;
        const { path: p } = this.deps.composer.resolveChatOpenPath(session, msg.path);
        await this.deps.host.showInFolder(p);
        break;
      }
      case "openUrl":
      case "openUpdateRelease":
        void this.deps.host.openExternal(msg.url);
        break;
      case "openText": {
        // Basename only — a renderer-supplied path must not choose the directory.
        const name = typeof msg.filename === "string" ? path.basename(msg.filename.trim()) : "";
        const suggested = name ? path.join(this.deps.sessionCwd(session), name) : undefined;
        await this.deps.host.openUntitledText(msg.content, msg.language, suggested);
        break;
      }
      case "openDiff":
        if (msg.turnScope && await this.deps.review.openTurnGitDiff(session, msg.path)) break;
        await this.deps.review.openDiffEditor(
          session,
          msg.path,
          msg.oldText,
          msg.newText,
          msg.requestId,
          msg.replaceAll,
          msg.sites,
        );
        break;
      case "revertToolEdit":
        await this.deps.review.revertToolEdit(session, msg);
        break;
      case "reviewRevertFile":
        await this.deps.review.reviewRevertFile(session, msg.path, msg.scope);
        break;
      case "reviewRevertAll":
        await this.deps.review.reviewRevertAll(session, msg.scope);
        break;
      case "exportExpr":
        await this.deps.review.exportExpr(msg, session);
        break;
      case "dropFile":
        // Desktop rewrites a host-minted handle to path before this runs; VS Code
        // still posts a path from drag-drop. Missing path is a no-op (forged
        // handle already refused at the Electron gate).
        if (typeof msg.path === "string" && msg.path.length > 0) {
          await this.deps.composer.trackAttach(this.deps.composer.addDroppedFile(msg.path, msg.shift, attachmentOwner));
        }
        break;
      case "pasteImage":
        await this.deps.composer.trackAttach(this.deps.composer.addPastedImage(
          msg.data,
          msg.mimeType,
          attachmentOwner,
          msg.previewId,
        ));
        break;
      case "permissionAnswer":
        {
          const pending = session.pendingPermissions.get(msg.requestId);
          if (!pending || !permissionAnswerAllowed(
            pendingPermissionOptions(pending, session.planActive && !autoApproveNativePlanTools(session.provider)),
            msg.optionId,
            session.planActive && !autoApproveNativePlanTools(session.provider),
            pending.toolKind,
          )) break;
          const chosenKind = pending.options.find((option) => option.optionId === msg.optionId)?.kind;
          if (chosenKind === "allow_once" || chosenKind === "allow_always") {
            this.deps.review.snapshotRelOrAbsPaths(session, pending.paths ?? [], this.deps.sessionCwd(session));
          }
          if (!session.client?.respondPermission(msg.requestId, msg.optionId)) break;
          if (msg.rule && !isPlanReviewPermission(pending.toolKind)) {
            if (msg.ruleScope === "session") this.deps.review.addSessionAllowRule(session, msg.rule);
            else void this.deps.review.persistAllowRuleFromCard(session, msg.rule);
          }
          // Record the resolution in the session buffer so re-focusing this session
          // replays the card collapsed instead of active (the live collapse is a
          // webview-only DOM mutation that the buffer never captured).
          this.deps.emit(session, { type: "permissionResolved", requestId: msg.requestId, optionId: msg.optionId });
          const chosen = pending.options.find((option) => option.optionId === msg.optionId);
          if (isPlanReviewPermission(pending.toolKind) && pending.plan?.trim()) {
            this.deps.review.persistPlanVerdict(
              session,
              planReviewVerdictForOption(chosen?.kind),
              pending.plan,
            );
            session.pendingPermissions.delete(msg.requestId);
            this.deps.sessions.syncHumanWait(session);
          } else {
            // Persist it (title + outcome) so a cold reload replays a collapsed card —
            // the CLI doesn't replay request_permission on session/load.
            this.deps.review.persistPermissionAnswer(session, msg.requestId, msg.optionId);
          }
          this.deps.review.closeDiffForRequest(session, msg.requestId); // tidy up the auto-opened diff (#21)
          // Only once EVERY card is answered. Two tools can ask at the same
          // time, and answering one leaves the agent blocked on the other — so
          // saying "working" here was a lie that the auto-approval path (which
          // checks the same thing) never told. On a cloud machine the lie also
          // costs money: `working` is what holds the machine awake, so a
          // half-answered pair would hold it open indefinitely while nothing
          // ran.
          this.deps.sessions.noteAnswered(session);
          break;
        }
      case "exitPlanAnswer":
        this.deps.review.handleExitPlan(msg.requestId, msg.verdict, msg.comment, session);
        break;
      case "questionAnswer":
        // A card that is no longer outstanding is a STALE card: a second tab
        // still showing it, or one replayed from the session buffer after the
        // turn ended. Answering it again would write a duplicate JSON-RPC
        // response and drag a settled session back to `working` — with no turn
        // left to ever end it, which on a rented machine bills for ever.
        // The webview is told either way, so a stale card stops taking input
        // and offers its draft to the composer (upstream e2e8458).
        if (this.deps.review.answerQuestion(session, msg.requestId, msg.answers ?? {}, msg.annotations ?? {})) {
          this.deps.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "accepted" });
          // Answering a QUESTION is not answering a permission card that is
          // also outstanding — the agent stays blocked on it, so `working`
          // would be wrong and would hold a rented machine awake indefinitely.
          this.deps.sessions.noteAnswered(session);
        } else {
          this.deps.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "stale" });
        }
        break;
      case "questionCancel":
        if (this.deps.review.cancelQuestion(session, msg.requestId)) {
          this.deps.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "accepted" });
          this.deps.sessions.noteAnswered(session);
        } else {
          this.deps.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "stale" });
        }
        break;
      case "questionDraft": {
        // Nothing renders from this — it exists so the auto-continue timeout can
        // send what the user already marked instead of discarding it. Ignored
        // for a card that is no longer outstanding, exactly like an answer.
        if (!session.pendingQuestions.has(msg.requestId)) break;
        session.questionDrafts.set(msg.requestId, {
          answers: msg.answers ?? {},
          annotations: msg.annotations ?? {},
          complete: msg.complete === true,
        });
        break;
      }
      case "pickFile":
        await this.deps.composer.trackAttach(this.deps.composer.pickFileFromComputer());
        break;
      case "mentionQuery": {
        // Answer from the TTL-cached index; a failed build degrades to an empty
        // list (the popover just hides) rather than an error surface.
        let files: string[] = [];
        try {
          const index = await this.deps.composer.mentionFileIndexForCwd(this.deps.sessionCwd(session));
          files = filterMentionFiles(index.rels, msg.query);
        } catch (e) {
          this.deps.host.appendLine(`[mention] index failed: ${(e as Error).message}`);
        }
        // Virtual entries ride their own field so the file ranking above stays
        // exactly what it was, and so `files` keeps meaning "paths the mention
        // catalog can resolve".
        const sources = filterMentionSources(msg.query);
        this.deps.post({ type: "mentionResults", query: msg.query, files, sources });
        break;
      }
      case "addMentionFile": {
        const workspaceRoot = this.deps.sessionCwd(attachmentOwner());
        if (!workspaceRoot) break;

        let catalogMatch: string | undefined;
        let openTabMatch: string | undefined;
        // Keeps the #69 fallback for a result whose cached/open entry
        // disappeared between rendering and selection.
        try {
          catalogMatch = (await this.deps.composer.mentionFileIndexForCwd(workspaceRoot)).absByRel.get(msg.relPath);
        } catch (e) {
          this.deps.host.appendLine(`[mention] index failed while validating pick: ${(e as Error).message}`);
        }
        if (pathsEqual(workspaceRoot, this.deps.workspaceRoot())) {
          openTabMatch = this.deps.composer.openWorkspaceFileEntries().find((e: any) => e.rel === msg.relPath)?.abs;
        }
        const abs = resolveMentionAttachmentPath(
          workspaceRoot,
          msg.relPath,
          catalogMatch,
          openTabMatch,
        );
        if (!abs || !isMentionPathInsideWorkspace(workspaceRoot, abs)) break;

        // Lexical containment above handles `..`; canonical containment also
        // rejects an in-workspace symlink whose target is outside the workspace.
        try {
          const [realRoot, realFile] = await Promise.all([
            fs.promises.realpath(workspaceRoot),
            fs.promises.realpath(abs),
          ]);
          if (!isMentionPathInsideWorkspace(realRoot, realFile)) break;
        } catch {
          // Stale/garbage catalog entries remain a no-op, as before.
          break;
        }
        await this.deps.composer.trackAttach(this.deps.composer.addDroppedFile(abs, false, attachmentOwner));
        break;
      }
      case "addContextChip":
        this.deps.composer.addContextSourceChip(msg.source, attachmentOwner);
        break;
      case "openContextChipSource":
        await this.deps.host.revealContextSource(msg.source);
        break;
      default:
        return false;
    }
    return true;
  }
}

export class SettingsInboundRouter {
  constructor(private readonly deps: SidebarInboundDeps) {}
  async tryHandle(msg: WebviewMsg, session: Session, attachmentOwner: AttachmentOwner, messageCwd: string): Promise<boolean> {
    switch (msg.type) {
      case "setAppPurpose": {
        const purpose = parseAppPurpose(msg.value);
        await this.deps.state.update(APP_PURPOSE_KEY, purpose);
        this.deps.post({ type: "appPurpose", value: purpose });
        break;
      }
      case "setConfigOption":
        if (session.client && typeof (msg as any).configId === "string" && typeof session.client.setConfigOption === "function") {
          try {
            await session.client.setConfigOption((msg as any).configId, (msg as any).value);
            this.deps.host.appendLine(`[acp] setConfigOption ${(msg as any).configId}=${JSON.stringify((msg as any).value)} succeeded`);
          } catch (e) {
            this.deps.providers.notifyUser("error", `Failed to set ${(msg as any).configId}: ${(e as Error).message}`);
          }
        }
        break;
      case "listRoutines":
        this.deps.slots.routineError = undefined;
        this.deps.routines.postRoutines();
        break;
      case "saveRoutine": {
        const existing = this.deps.routines.loadRoutines();
        const prior = msg.id ? existing.find((r: any) => r.id === msg.id) : undefined;
        if (msg.id && !prior) {
          this.deps.slots.routineError = { id: msg.id, message: "That routine is no longer there." };
          this.deps.routines.postRoutines();
          break;
        }
        // The cwd is checked against what this connection may reach, not
        // against the whole catalog: a remote may create routines, and reach is
        // the property that has to be bounded.
        const cwd = typeof msg.draft.cwd === "string" ? msg.draft.cwd : "";
        if (!this.deps.routines.mayTargetRoutineCwd(cwd)) {
          this.deps.slots.routineError = { id: msg.id, message: "Pick a project for this routine to run in." };
          this.deps.routines.postRoutines();
          break;
        }
        const result = validateRoutine(msg.draft, {
          id: prior?.id ?? randomUUID(),
          // Editing preserves createdAt, so the schedule anchor does not jump
          // when someone fixes a typo in the prompt.
          createdAt: prior?.createdAt ?? Date.now(),
          models: this.deps.routines.routineModelOptions(),
        });
        if (!result.ok) {
          this.deps.slots.routineError = { id: msg.id, message: result.error };
          this.deps.routines.postRoutines();
          break;
        }
        this.deps.slots.routineError = undefined;
        const next = prior
          ? existing.map((r: any) => (r.id === prior.id ? { ...result.routine, paused: r.paused } : r))
          : [...existing, result.routine];
        await this.deps.routines.saveRoutines(next);
        this.deps.routines.postRoutines();
        break;
      }
      case "deleteRoutine": {
        const existing = this.deps.routines.loadRoutines();
        const target = existing.find((r: any) => r.id === msg.id);
        if (!target || !this.deps.routines.mayTargetRoutineCwd(target.cwd)) break;
        await this.deps.routines.saveRoutines(existing.filter((r: any) => r.id !== msg.id));
        this.deps.slots.routineRuns.forget(msg.id);
        this.deps.slots.routineError = undefined;
        this.deps.routines.postRoutines();
        break;
      }
      case "setRoutinePaused": {
        const existing = this.deps.routines.loadRoutines();
        const target = existing.find((r: any) => r.id === msg.id);
        if (!target || !this.deps.routines.mayTargetRoutineCwd(target.cwd)) break;
        await this.deps.routines.saveRoutines(
          existing.map((r: any) => (r.id === msg.id ? { ...r, paused: msg.paused === true } : r)),
        );
        this.deps.routines.postRoutines();
        break;
      }
      case "runRoutineNow": {
        const target = this.deps.routines.loadRoutines().find((r: any) => r.id === msg.id);
        if (!target || !this.deps.routines.mayTargetRoutineCwd(target.cwd)) break;
        if (this.deps.slots.routinesInFlight.has(target.id)) break;
        const now = Date.now();
        // A manual key, so an explicit run never consumes the scheduled window
        // — "Run now" at 07:59 must not cancel the 08:00 run.
        const key = manualWindowKey(now);
        this.deps.slots.routineRuns.claim(target.id, key, {
          routineId: target.id,
          windowKey: key,
          startedAt: now,
          outcome: "running",
        });
        await this.deps.routines.runRoutine(target, key, now);
        break;
      }
      case "welcomeTipShown": {
        // Idempotent per day: `withShownTip` answers null when this tip is
        // already recorded for today, which means no write and no frame — the
        // client posts at most once per tip per day, and this is the second
        // gate so a client that forgets cannot rewrite the file all afternoon.
        const seen = withShownTip(
          this.deps.state.get(WELCOME_TIPS_SHOWN_KEY, {}),
          msg.id,
          localDayKey(new Date()),
        );
        if (!seen) break;
        await this.deps.state.update(WELCOME_TIPS_SHOWN_KEY, seen);
        this.deps.settings.postWelcomeTips();
        break;
      }
      case "dismissWelcomeTip": {
        // Id-shaped only, capped, and idempotent — `withDismissedTip` answers
        // null for anything already retired or out of bounds, and a null means
        // do not write and do not re-broadcast an identical frame. The host
        // deliberately does NOT check the id against a catalogue: the catalogue
        // lives in the client, and a newer client knowing a tip this host does
        // not is the normal case, not an error.
        const next = withDismissedTip(this.deps.state.get(WELCOME_TIPS_KEY, {}), msg.id);
        if (!next) break;
        await this.deps.state.update(WELCOME_TIPS_KEY, next);
        this.deps.settings.postWelcomeTips();
        break;
      }
      case "openGlobalConfig": {
        // Intent only — host resolves ~/.grok/config.toml (never a renderer path).
        await this.deps.host.openGlobalConfig();
        break;
      }
      case "openProjectConfig": {
        // Intent only — host resolves project .grok/config.toml from session cwd.
        await this.deps.host.openProjectConfig(this.deps.sessionCwd(session));
        break;
      }
      case "listRuleFiles": {
        await this.deps.settings.refreshRuleFiles(session);
        break;
      }
      case "listPermissionRules": {
        this.deps.settings.postPermissionRules(session);
        break;
      }
      case "deletePermissionRule": {
        await this.deps.settings.deletePermissionRule(session, msg.id);
        break;
      }
      case "adoptPermissionRules": {
        await this.deps.settings.adoptPermissionRules(session, msg.adopt === true);
        break;
      }
      case "openRuleFile": {
        await this.deps.settings.openRuleFile(session, msg.path);
        break;
      }
      case "appendRuleFile": {
        await this.deps.settings.appendRuleFile(session, msg.text);
        break;
      }
      case "listMcpServers": {
        await this.deps.settings.refreshMcpServers(session);
        break;
      }
      case "connectMcpConnector":
        await this.deps.settings.connectMcpConnector(msg.id, {
          key: typeof msg.key === "string" ? msg.key : undefined,
          readOnly: typeof msg.readOnly === "boolean" ? msg.readOnly : undefined,
        });
        break;
      case "disconnectMcpConnector":
        await this.deps.settings.disconnectMcpConnector(msg.id);
        break;
      case "showLogs":
        this.deps.host.showOutput();
        break;
      case "toggleDevTools":
        if (this.deps.host.canToggleDevTools) this.deps.host.toggleDevTools();
        break;
      case "openSettings":
        await this.deps.host.openSettings(typeof msg.section === "string" ? msg.section : "companions");
        break;
      case "openSettingsSurface":
        await this.deps.settings.openSettingsEditor(typeof msg.category === "string" ? msg.category : undefined);
        break;
      case "closeSettingsSurface":
        this.deps.slots.settingsEditor?.dispose();
        this.deps.slots.settingsEditor = undefined;
        break;
      case "moveView": {
        // Settings -> Advanced -> Move view. Each destination targets an
        // extension-owned container, so the move is direct — no quickpick. An
        // unknown location falls back to the built-in destination picker
        // preselected on our view (the view-id argument also sidesteps the
        // focusedView context, which Cursor never sets for webview views).
        await this.deps.settings.retireMoveViewHint();
        await this.deps.host.relocateView(
          GROK_VIEW_ID,
          moveViewContainerFor(msg.location),
          panelPositionFor(msg.location),
        );
        break;
      }
      case "setShowThinking":
        // Persist globally (like the other display prefs); the config watcher
        // re-posts the value, keeping every open webview in sync.
        await this.deps.host.getConfiguration("grok")
          .update("showThinking", !!msg.value, "global");
        break;
      case "setExpandCommandOutputs":
        await this.deps.host.getConfiguration("grok")
          .update("expandCommandOutputs", !!msg.value, "global");
        break;
      case "setSteerByDefault":
        await this.deps.host.getConfiguration("grok")
          .update("steerByDefault", !!msg.value, "global");
        break;
      case "setPromptNav":
        await this.deps.host.getConfiguration("grok")
          .update("promptNav", !!msg.value, "global");
        break;
      case "setSoundNotifications":
        await this.deps.host.getConfiguration("grok")
          .update("soundNotifications", !!msg.value, "global");
        break;
      case "setProcessingSound":
        await this.deps.host.getConfiguration("grok")
          .update("processingSound", !!msg.value, "global");
        break;
      case "setReadRepliesAloud":
        await this.deps.host.getConfiguration("grok")
          .update("readRepliesAloud", !!msg.value, "global");
        break;
      case "setSummarizeRepliesAloud":
        await this.deps.host.getConfiguration("grok")
          .update("summarizeRepliesAloud", !!msg.value, "global");
        break;
      case "setVoiceSendPhrase": {
        const cwd = messageCwd;
        const cfg = this.deps.host.getConfiguration("grok", cwd);
        await cfg.update(
          "voiceSendPhrase",
          sanitizeVoiceSendPhrase(msg.value),
          voiceSettingWriteTarget(cfg.inspect("voiceSendPhrase"), this.deps.host.isInWorkspace(cwd)),
        );
        break;
      }
      case "setVoiceKeyterms": {
        const cwd = messageCwd;
        const cfg = this.deps.host.getConfiguration("grok", cwd);
        await cfg.update(
          "voiceKeyterms",
          sanitizeVoiceKeyterms(msg.value),
          voiceSettingWriteTarget(cfg.inspect("voiceKeyterms"), this.deps.host.isInWorkspace(cwd)),
        );
        break;
      }
      case "setVoiceBackend": {
        if (!["auto", "xai", "openai"].includes(msg.value)) break;
        const cfg = this.deps.host.getConfiguration("grok", messageCwd);
        await cfg.update("voiceBackend", msg.value,
          voiceSettingWriteTarget(cfg.inspect("voiceBackend"), this.deps.host.isInWorkspace(messageCwd)));
        this.deps.providers.postVoiceConfigured();
        break;
      }
      case "configureOpenAiVoice": {
        const value = await this.deps.host.showInputBox({
          title: "OpenAI voice API key",
          prompt: "An OpenAI API-platform key is required; Codex / ChatGPT sign-in does not include transcription. Saved in host settings. Empty clears the override.",
          password: true,
          placeHolder: "OpenAI API key",
        });
        if (value === undefined) break;
        const cfg = this.deps.host.getConfiguration("grok", messageCwd);
        await cfg.update("voiceOpenAiApiKey", value.trim(),
          voiceSettingWriteTarget(cfg.inspect("voiceOpenAiApiKey"), this.deps.host.isInWorkspace(messageCwd)));
        this.deps.providers.postVoiceConfigured();
        break;
      }
      case "setTelemetryEnabled":
        await this.deps.host.getConfiguration("grok")
          .update("telemetry.enabled", !!msg.value, "global");
        break;
      case "setThumbsFeedback":
        await this.deps.host.getConfiguration("grok")
          .update("thumbsFeedback", !!msg.value, "global");
        break;
      default:
        return false;
    }
    return true;
  }
}

export class ProjectInboundRouter {
  private readonly connectChecks = new Set<AcpProvider>();
  constructor(private readonly deps: SidebarInboundDeps) {}
  async tryHandle(msg: WebviewMsg, session: Session, _attachmentOwner: AttachmentOwner, _messageCwd: string): Promise<boolean> {
    switch (msg.type) {
      case "restartToUpdate":
        this.deps.host.installAppUpdate?.();
        break;
      case "installCodex":
        await this.deps.providers.installManagedCodexCli();
        break;
      case "updateProviderCli":
        await this.deps.providers.updateProviderCli(msg.provider);
        break;
      case "cancelCodexInstall":
        this.deps.slots.codexInstallAbort?.abort(new Error("Installation cancelled."));
        break;
      case "addProjectFolder":
        await this.deps.projects.addProjectFolder();
        break;
      case "removeProjectFolder":
        // removeWorkspaceFolder returns false for anything not in the open set.
        await this.deps.projects.removeProjectFolder(msg.cwd);
        break;
      case "createProject":
        await this.deps.projects.createProject(msg.name);
        break;
      case "cloneProject":
        await this.deps.projects.cloneProject(msg.url, msg.name);
        break;
      case "setupGithubCli":
        await this.deps.providers.setupGithubCli(msg.action === "install" ? "install" : "auth");
        break;
      case "listGithubRepos":
        await this.deps.providers.listGithubRepos();
        break;
      case "githubSignOut":
        await this.deps.providers.githubSignOut();
        break;
      case "githubLoginWithToken":
        await this.deps.providers.githubLoginWithToken(msg.token);
        break;
      case "runInstallCmd": {
        // Host-owned confirmation, because this is one of the two messages that
        // run something. The renderer does not supply the command — it is the
        // fixed x.ai installer — so a compromised renderer cannot choose WHAT
        // runs, only trigger it. Confirming closes that anyway: the desktop
        // dispatcher authorizes on "the message came from the main frame", not
        // on a user gesture, and this is cheap where a general fix is not.
        if (!(await this.deps.review.confirmHostExecute(
          "Install the Grok Build CLI?",
          "This runs the official installer from x.ai in a terminal.",
          "Install",
        ))) break;
        const term = this.deps.host.createTerminal("Install Grok");
        term.show();
        // Windows ships a native CLI installed via PowerShell; the default VS Code
        // terminal there is PowerShell, so use its syntax. Everything else is POSIX.
        const done = "Done. Click 'Re-check connection' in the Grok sidebar.";
        term.sendText(
          process.platform === "win32"
            ? `irm https://x.ai/cli/install.ps1 | iex; Write-Host "\`n${done}"`
            : `curl -fsSL https://x.ai/cli/install.sh | bash && echo "\\n${done}"`,
        );
        break;
      }
      case "runGrokLogin": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : "grok";
        if (this.connectChecks.has(provider)) break;
        const cliPath = this.deps.providers.locateProvider(provider);
        if (!cliPath) {
          this.deps.post({ type: "onboarding", state: missingProviderState(provider), platform: process.platform, provider });
          break;
        }
        const connecting = !this.deps.providers.hasProviderConsent(provider);
        const renewing = !!this.deps.slots.providerNeedsLogin?.[provider];
        this.connectChecks.add(provider);
        if (connecting) this.deps.providers.setProviderConnectChecking(provider, true);
        try {
          this.deps.sessionSettings.setProviderNeedsLogin(provider, true);
          await this.deps.providers.setProviderConnected(provider, true);
          if (connecting) {
            const ready = PROVIDER_CLI[provider].credentialProbe === "unavailable"
              ? this.deps.providers.providerCredentialFilePresent(provider)
              : await this.deps.providers.reprobeProviderCredentials(provider, true).catch(() => false);
            if (!this.deps.providers.hasProviderConsent(provider)) break;
            if (ready) {
              this.deps.sessionSettings.setProviderNeedsLogin(provider, false);
              await this.deps.providers.adoptSessionsForConnectedProvider(provider, session);
              break;
            }
            this.deps.post({ type: "onboarding", state: providerLoginState(provider), provider, platform: process.platform });
            break;
          }
          if (!this.deps.providers.hasProviderConsent(provider)) break;
          const term = this.deps.host.createTerminal({
            name: `${providerDisplayName(provider)} Login`, shellPath: cliPath,
            shellArgs: [...PROVIDER_CLI[provider].loginArgs],
          });
          term.show();
          if (PROVIDER_CLI[provider].credentialProbe !== "unavailable") this.deps.providers.watchProviderLogin(provider);
          if (session.hasHistory && this.deps.workspaceRoot() && !renewing) await this.deps.sessions.newFocusedSession();
          this.deps.post({ type: "onboarding", state: providerLoginState(provider), platform: process.platform, provider, launched: true });
        } finally {
          this.connectChecks.delete(provider);
          if (connecting) this.deps.providers.setProviderConnectChecking(provider, false);
        }
        break;
      }
      case "recheckConnection": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : session.provider;
        if (!this.deps.providers.locateProvider(provider)) {
          this.deps.post({
            type: "onboarding",
            state: missingProviderState(provider),
            platform: process.platform,
            provider,
          });
          break;
        }
        const pendingLoginProbe = this.deps.slots.loginReprobeTimers.get(provider);
        if (pendingLoginProbe) clearTimeout(pendingLoginProbe);
        this.deps.slots.loginReprobeTimers.delete(provider);
        // Evidence, then promotion — never the other way round. Marking the
        // account connected BEFORE the probe meant a failed check left it
        // "connected but needs to sign in again" for an account that was
        // never signed in at all, which is exactly what the owner saw on a
        // fresh cloud machine (2026-08-31). The Providers refresh has always
        // promoted this way; this handler was the one that did not.
        //
        // A failure never demotes, either: a lapsed account keeps its row and
        // gets the sign-in action, which is what needsLogin is for.
        // Consent was stated by Connect; a re-check only re-reads it (#171).
        if (!this.deps.providers.hasProviderConsent(provider)) break;
        if (PROVIDER_CLI[provider].credentialProbe === "unavailable") {
          // No status RPC: the person acknowledges the CLI sign-in here, and a
          // landed credential file is the evidence (upstream). A turn still
          // reports a credential failure through the normal path.
          this.deps.sessionSettings.setProviderNeedsLogin(provider, !this.deps.providers.providerCredentialFilePresent(provider));
          void this.deps.providers.probeProviderVersion(provider);
        } else await this.deps.providers.reprobeProviderCredentials(provider);
        await this.deps.providers.adoptSessionsForConnectedProvider(provider, session);
        break;
      }
      case "retryProviderSession": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : session.provider;
        if (!this.deps.providers.connectedProviders().includes(provider)) break;
        if (session.provider === provider && !session.client) {
          await this.deps.sessions.startSession(session.hasHistory ? session.activeSessionId : undefined, session);
        }
        break;
      }
      case "logout":
        await this.deps.providers.logout(
          isAcpProvider(msg.provider) ? msg.provider : "grok",
          { report: (text: string) => this.deps.providers.notifyUser("error", text) },
        );
        break;
      case "refreshProviders":
        await this.deps.providers.refreshProviderStates();
        break;
      case "checkGrokUpdate":
        await this.deps.providers.checkGrokUpdate();
        break;
      case "updateGrok":
        if (!(await this.deps.review.confirmHostExecute(
          "Update the Grok Build CLI?",
          "This runs the CLI's own updater.",
          "Update",
        ))) break;
        await this.deps.providers.updateGrokCliOnDemand();
        break;
      default:
        return false;
    }
    return true;
  }
}

export class SidebarInbound {
  readonly sessionRouter: SessionInboundRouter;
  readonly workflowRouter: WorkflowInboundRouter;
  readonly toolingRouter: ToolingInboundRouter;
  readonly settingsRouter: SettingsInboundRouter;
  readonly projectRouter: ProjectInboundRouter;

  constructor(private readonly deps: SidebarInboundDeps) {
    this.sessionRouter = new SessionInboundRouter(deps);
    this.workflowRouter = new WorkflowInboundRouter(deps);
    this.toolingRouter = new ToolingInboundRouter(deps);
    this.settingsRouter = new SettingsInboundRouter(deps);
    this.projectRouter = new ProjectInboundRouter(deps);
  }

  async dispatch(msg: WebviewMsg): Promise<void> {
    let session = this.deps.getFocused();
    const relayed = this.deps.resolveRelayedAnswer(msg);
    if (relayed) {
      session = relayed.session;
      msg = relayed.msg;
    }
    const attachmentOwner: AttachmentOwner = () => this.deps.getFocused();
    const messageCwd = this.deps.workspaceRoot();
    if (await this.sessionRouter.tryHandle(msg, session, attachmentOwner, messageCwd)) return;
    if (await this.workflowRouter.tryHandle(msg, session, attachmentOwner, messageCwd)) return;
    if (await this.toolingRouter.tryHandle(msg, session, attachmentOwner, messageCwd)) return;
    if (await this.settingsRouter.tryHandle(msg, session, attachmentOwner, messageCwd)) return;
    await this.projectRouter.tryHandle(msg, session, attachmentOwner, messageCwd);
  }
}

export function createSidebarInbound(deps: SidebarInboundDeps): SidebarInbound {
  return new SidebarInbound(deps);
}
