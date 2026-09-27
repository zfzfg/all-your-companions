import { WorktreeHost, SESSION_META_KEY } from "./worktree-host";
import { ProviderSetup } from "./provider-setup";
import { TurnEdit, createTurnEdit } from "./turn-edit";
import { AgentAuthoring, createAgentAuthoring } from "./agent-authoring";
import {
  ProviderSession,
  createProviderSession,
  type CliCompatibilityResult,
  ACT_MODE_ID,
} from "./provider-session";
import { VoiceAndMcp, type VoiceStreamContext } from "./voice-and-mcp";
import { WebviewHtml } from "./webview-html";
import { QuestionHost } from "./question-host";
import { ReviewHost } from "./review-host";
import { WorkflowStageRunner } from "./workflow-stage-runner";
import { RoutineScheduler } from "./routine-scheduler";
import { createSidebarTestHooks, type SidebarTestHooks } from "./sidebar-test-hooks";
import {
  SubagentHost,
  createSubagentHost,
  type SubagentHostDeps,
  type SubagentState,
  SUBAGENT_INDEX_KEY
} from "./subagent-host";
import type {
  Host,
  HostContext,
  HostDisposable,
  HostTerminalCapture,
  HostTextDocumentContentProvider,
  HostWebview,
  HostWebviewView,
  HostEditorWebview
} from "./host";
import { Uri, disposeAll, shouldRehydrateOnWebviewReady } from "./host";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, EffortLevel, ExitPlanRequest, PermissionRequest, QuestionRequest } from "./acp";
import type { AcpProvider } from "./acp-backend";
import { isAdapterProvider, isAcpProvider } from "./acp-backend";
import { allProviderCapabilities, providerCapability } from "./provider-capabilities";
import {
  dropReviewTurnsAfter,
  filesForScope,
  reviewCenterSnapshot,
  type ReviewScope
} from "./review-center";
import {
  appendRuleEntry,
  ensureRuleFile,
  resolveRuleFileStates,
  ruleFileCandidates,
  type RuleFile,
  type RuleFileFs
} from "./rules-files";
import {
  PERMISSION_RULES_ADOPTED_KEY,
  PERMISSION_RULES_KEY,
  PERMISSION_RULES_ORDER_COPY,
  SOCKET_RULE_VIEWS,
  activeRulesFrom,
  adoptionKeyFor,
  createRule,
  globalRulesToMap,
  loadWorkspaceRulesFile,
  parseAdoptionMap,
  parseGlobalRulesMap,
  pendingWorkspaceAdoption,
  sanitizeWebviewAllowMatch,
  toRuleView,
  writeWorkspaceRulesFile,
  type AdoptionRecord,
  type PermissionRule,
  type PermissionRulesFs,
  type PermissionRuleView
} from "./permission-rules";
import { resolveCodexHome } from "./codex-cli-locator";
import {
  adapterEntriesEligibleForClear,
  adapterListEntry,
  findCachedAdapterSession,
  mergeProviderHistoryPage,
  mergeProviderSessionEntries,
  missingProviderState,
  modelsForConnectedProviders,
  projectProviderKey,
  providerDisplayName,
  providerLoginState,
  type ProviderConnections,
  type ProviderModelCache,
  type ProviderModelInfo,
  type ProviderHistoryCursor
} from "./provider-ui";
import {
  toRoutineView,
  validateRoutine,
  manualWindowKey,
  type Routine,
  type RoutineModelOption,
  type RoutineProjectOption
} from "./routines";
import { RoutineRunStore } from "./routine-store";
import { CheckpointStore, nodeCheckpointFs } from "./checkpoint-store";
import { PersistedState } from "./persisted-state";
import {
  Session,
  SessionStartIntent,
  SessionStatus,
  INTERRUPTED_SEND_TEXT,
  beginQueuedSendCommit,
  beginTurn,
  decideSessionStart,
  endTurn,
  finishQueuedSendCommit,
  runExclusiveHistoryLoad,
  pendingPermissionOptions,
  preferredPermissionAllowOption,
  rehydrateBusyChrome,
  sessionReadyForPrompt,
  sessionUiSnapshot,
  turnElapsedMs,
  turnIsInFlight,
  type QuestionResponder
} from "./session";
import { buildReapCandidates, selectReapable, computeDot, Dot } from "./session-pool";
import {
  resolveVoiceKey,
  extractGrokAuthKey,
  voiceSettingWriteTarget,
  sanitizeVoiceSendPhrase,
  sanitizeVoiceKeyterms,
  pickSttBackend,
  resolveOpenAiVoiceKey,
  type SttBackend,
  type SttPreference,
  type VoiceBackendState
} from "./voice";
import { VoiceRecorder } from "./voice-recorder";
import { VoiceStreamer } from "./voice-streamer";
import { summarizeForSpeech } from "./speech-summary";
import type { PromptResultMeta, PromptUsage, SessionInfoContext } from "./acp-dispatch";
import { DEFAULT_COMPACT_THRESHOLD, GROK_COMPACT_ENV, compactEventKind, compactSummaryPreview, compactThresholdMismatch, compactThresholdMismatchNotice, grokCompactThresholdEnv, normalizeCompactThreshold, shouldOfferNearFull } from "./grok-compaction";

import { ChildRelayTable, type RelayKind, type RelayOrigin } from "./child-relay";
import { normalizeStallWarningSec, type PausableDeadline } from "./child-watch";
import { subagentTurnSummary } from "./companion-subagents";
import { bothDelegationsHint, grokSubagentEnv } from "./grok-subagent-env";
import { MediaRef, adapterCompactSignal, adapterContextOccupancy, agentTimestampMsFromMeta, autoCompactStartedNote, childStreamFromRoute, commandOutputForToolCall, commandOutputFromLiveTerminal, contextUsedFromCompactNotification, enforceCompleteSessionCost, errorDetail, gateZeroTokenMeta, isCredentialError, isIncompatibleAgentError, isResumeNotFound, isSubagentLifecycleUpdate, occupancyFromAdapterTurn, parseSessionInfoContext, permissionOutcomeFor, promptErrorText, rateLimitNoticeText, replayedTurnDuration, sessionInfoCacheFresh, sumUsage, summarizeBackgroundCommand, turnStatusFromPromptResult, usageIsRealMeasurement, type TurnEndStatus, type UpdateRoute } from "./acp-dispatch";
import { createMcpPrepareState, prepareMcpToolCall } from "./mcp-tool";
import { configWriteTarget, rememberedEffort, startsInYolo, withRememberedEffort, type EffortPrefs } from "./mode-prefs";
import { oauthShadowsXaiApiKey } from "./auth-recovery";
import {
  classifyLimitError,
  CONTEXT_OVERFLOW_TEXT,
  isContextOverflowError,
  limitOfferHint,
  limitOfferTargets,
  freePercentFromWindows,
  limitOfferTitle,
  recommendedLimitAction
} from "./limit-errors";
import {
  WELCOME_TIPS_KEY,
  WELCOME_TIPS_SHOWN_KEY,
  localDayKey,
  parseDismissedTips,
  shownOn,
  withDismissedTip,
  withShownTip
} from "./welcome-tips";
import { ProjectFolders } from "./project-folders";
import type { GithubAuthState } from "./github-auth";
import { SubscriptionUsageBinding, SubscriptionUsageCache, subscriptionCredentialContext, type SubscriptionWindow } from "./subscription-usage";
import { readCodexSubscriptionWindows } from "./codex-usage";
import { providerConfigFiles, type ProviderConfigFile } from "./provider-config";
import { readWorkflowCompletion } from "./workflow-state";
import { CliUpdateHost, createCliUpdateHost } from "./cli-update-host";
import { supportsClientMcpServers } from "./acp-backend";
import { GitRunGate, type GitTurnBaseline } from "./git-run";
import {
  GROK_VIEW_ID,
  MOVE_VIEW_HINT_USED_KEY,
  moveViewContainerFor,
  panelPositionFor,
  shouldShowMoveViewHint
} from "./view-move";
import {
  APTABASE_APP_KEY_PROD,
  buildSessionStartEvent,
  osNameFromPlatform,
  postEvent,
  sessionStartHostKind,
  sessionStartSurface,
  shouldSendTelemetry,
  OFFICIAL_EXTENSION_ID
} from "./telemetry";
import { randomUUID } from "node:crypto";
import { execGrokCli } from "./cli-process";
import type { LocalGitWorktrees } from "./worktree-local";
import {
  isStdioBrokenGrokVersion,
  parseGrokVersion,
  shouldReactivelyDowngrade,
  GROK_STDIO_DOWNGRADE_TARGET
} from "./cli-locator";
import { OpenClock } from "./open-timing";
import {
  TerminalManager,
  commandLanguageForDialect,
  grokShellEnvValue,
  resolvedTerminalShell,
  resolvedTerminalShellDialect,
  setTerminalShellPreference,
  type ShellPreference
} from "./terminal-manager";
import {
  FileChip,
  MAX_VISION_IMAGE_BYTES,
  clearImplicitChips,
  consumeChips,
  extFromMime,
  isImageChip,
  isImplicitChip,
  isVisionMime,
  makeExplicitChip,
  makeImageChip,
  implicitChipStartsHidden,
  makeImplicitChip,
  mimeFromPath,
  removeChip,
  selectionLineRange,
  toggleChip,
  allocateImageIndex
} from "./chips";
import {
  contextChipLabel,
  isDiagnosticsChip,
  isFileChip,
  isTerminalChip,
  makeDiagnosticsChip,
  makeTerminalChip,
  type ContextChip,
  type ContextChipPayload
} from "./context-chips";
import { buildPromptWithImages, buildQueuedPromptWithImages, type PromptImageInput, type QueuedPromptContribution } from "./prompt-builder";
import {
  chipsForQueueSend,
  dequeueQueuedSends,
  enqueueQueuedSend,
  explicitVisibleChips,
  queuedFlushText,
  queuedSendsMessage,
  restoreQueuedChips,
  type QueuedSendEntry
} from "./queued-send";

import { EXTENSION_HOST_SLASH_COMMANDS, matchSlashCommand, parseAgentCommand, parseCrewCommand, parseHandoffCommand, parseSubagentsCommand } from "./slash-filter";

import { CREW_PRESETS_DIR, loadCrewPresets, type CrewPresetSet } from "./crew-preset";
import { type WorkflowDefinition } from "./workflow";
import { type ValidateWorkflowContext } from "./workflow-validate";
import { type WorkflowDraft } from "./workflow-write";

import {
  applyGateAction,
  historySubtitle,
  isTerminalRunStatus,
  WorkflowRunStore,
  type Autonomy,
  type RunLineupEntry,
  type WorkflowRun
} from "./workflow-run";
import {
  type HandoffPacket,
  type HandoffPlanStep
} from "./workflow-handoff";
import { type AgentRoleDraft, type CrewFlowDraft, type RoleScope } from "./agent-role-write";
import { FileClaimStore } from "./file-claims";
import { AGENT_ROLES_DIR, loadAgentRoles, type AgentRole, type AgentRoleSet } from "./agent-roles";
import { type AgentResult, type BriefingInput, type FileReconciliation } from "./briefing";
import { type HandoffKind, type ThreadContext } from "./handoff";
import { AgentRunStore, type AgentRunTrigger } from "./agent-run";
import {
  MENTION_INDEX_LIMIT,
  MENTION_INDEX_TTL_MS,
  buildExcludeGlob,
  clampMentionIndexLimit,
  filterMentionFiles,
  filterMentionSources,
  isMentionPathInsideWorkspace,
  mergeMentionEntries,
  normalizeRelPath,
  orderMentionIndex,
  resolveMentionAttachmentPath,
  type ContextSourceId
} from "./mention";
import {
  ALWAYS_APPROVE_NOTICE_KEY,
  alwaysApproveSource,
  configForcesAlwaysApprove,
  ensureConfigToml,
  globalConfigPath,
  projectConfigPath,
  shouldShowAlwaysApproveNotice
} from "./grok-config";
import { sessionScopedRoots } from "./auth-roots";
import { parseFileRef } from "./file-ref";
import {
  retainedUploadDirectories,
  stagedUploadDirectory,
  unreferencedUploadsForRemovedSessions
} from "./file-upload";
import { applyAgentModeToHostPlan, isPlanReviewPermission, permissionAnswerAllowed, planReviewVerdictForOption } from "./plan-gate";
import { appendPlanEntry, planRestoreSource, truncateResolvedAfter, countsAsUserBubble, decideRestoreState, isInterjectionText } from "./plan-restore";
import {
  planReviewFileName,
  planReviewSessionDirectoryName
} from "./plan-review";
import { isPrimerText } from "./grok-primer";
import { AsyncSerialQueue } from "./async-serial";
import { HOST_CAPABILITIES, HostMsg, INTERRUPTED_SEND_CODE, WebviewMsg, type GithubState, type WorkflowLineupView } from "./protocol";
import { withoutArchiveFields } from "./project-discovery";
import { SessionRequestState } from "./session-request-state";
import { historyImagePreviews } from "./image-history";
import {
  SessionListEntry,
  SessionMetaOverrides,
  sessionCwdBelongsToRepo,
  RepoArchives,
  RepoColors,
  RepoListEntry,
  RepoPins,
  capAutoName,
  capUsageLog,
  capSessionMetaAutoNames,
  carrySessionName,
  clearSessions,
  cliSessionTitle,
  defaultFs,
  deleteSessionDir,
  discoverRepos,
  fallbackName,
  findSessionCatalogCwd,
  indexSessions,
  isEmptySession,
  isRepoColor,
  REPO_COLOR_IDS,
  neighbourAfterDelete,
  normalizeRepoPath,
  orderedResumeCwdCandidates,
  persistSessionContext,
  persistedContextUsage,
  contextUsageFromLog,
  readContextUsage,
  relativePathWithin,
  readSessionEntries,
  expiredArchiveChoiceKeys,
  newestTranscriptMtime,
  resolveGrokHome,
  sessionCatalogDirs,
  sessionDirFor
} from "./sessions";
import {
  applySessionTypeSwitch,
  defaultSessionTypeFromSetting,
  effectiveSessionType,
  isSessionTypeLocked,
  lockSessionType,
  type HiddenReason,
  type SessionType,
  type SessionTypeMeta
} from "./session-type";
import { type AwaitArguments, type ListArguments, type SpawnArguments } from "./companions-protocol";
import { CompanionsHostServer, type CompanionsCall } from "./companions-server";
import { HostPipeMux } from "./host-pipe-mux";
import {
  type SubagentDirective
} from "./subagent-directives";
import {
  SubagentRegistry,
  formatSubagentDiagnosis,
  type CompanionsSkipReason
} from "./companion-subagents";
import { listEligibleTargets, resolveTarget, type EligibilityInput, type EligibilityResult, type RefusalCode, type RosterEntry, type SpawnLimits } from "./target-eligibility";
import {
  isTrustedGeneratedMediaPath,
  resolveChatOpenFilePath
} from "./media-serve";
import {
  type FfmpegResolution
} from "./ffmpeg-locate";
import {
        gitRootForPath,
  matchWorktreeForCwd,
  mergeSessionIndexes,
  normalizeFsPath,
  pathsEqual,
              type WorktreeParentRef,
  type WorktreeRecord,
  worktreeCwdsForRepo,
    worktreesForRepo
} from "./worktree";
import {
  authorizedListCwd,
  cwdIsAuthorized,
  filterEntriesByAuthorizedCwd,
  imagePathStillAuthorized,
  pathBoundToClosedFolder
} from "./workspace-auth";
import {
  historyEventCount,
  checkWorkspaceGitStatus,
  truncateReplayBuffer,
} from "./rewind";
import {
  commandsAdvertiseFeedback,
  decideFeedbackAvailability,
  parseFeedbackEnabledMeta
} from "./feedback";
import {
  parseRunProgressUpdate,
  type RunProgressUpdate,
  workflowControlCommand
} from "./run-progress";
import {
  APP_PURPOSE_KEY,
  DEFAULT_APP_PURPOSE,
  parseAppPurpose,
  type AppPurpose
} from "./app-purpose";
import { type McpServerView } from "./mcp";
import type {
  ConnectedConnectorStore,
  ConnectorDef,
  ConnectorId,
  ReservedMcpIdentity,
  AcpMcpStdioServer
} from "./mcp-connectors";
import { AskUserServer } from "./ask-user-server";

// HostMsg (host -> webview) and WebviewMsg (webview -> host) both live in
// src/protocol.ts now — the single source of truth for the message contract,
// imported above. See that file for why.

// Older booleans included silent credential-probe promotions (#171), so they
// carry no provenance and are never imported: a v2 key starts clean. Only the
// connection flags reset; no credential is touched.
const PROVIDER_MODEL_CACHE_KEY = "grok.providerModelCache";
const REPO_PINS_KEY = "grok.repoPins";
/** Timestamped archive choices, stored under ~/.grok/client-state rather than
 *  per-client so the choice follows you to a phone and survives a cleared
 *  browser — archiving is curation of your projects, not a preference about one
 *  sidebar. Every rail reads it; the VS Code repo picker ignores it entirely. */
const REPO_ARCHIVES_KEY = "grok.repoArchives";
/** Shared client-state key for per-project folder colours in the conversation
 *  rail. Stored under ~/.grok/client-state so the choice follows you to a phone
 *  and survives a cleared browser — same home as pins/archives. */
const REPO_COLORS_KEY = "grok.repoColors";
/**
 * Folders the user added to the rail by hand, on a host that cannot open them.
 *
 * Desktop "Add project" changes the app's OWN workspace, so it needs no list —
 * `workspaceFolders()` is the list. VS Code's workspace belongs to VS Code, and
 * adding a folder to it converts a single-folder window into a multi-root one
 * and reloads the extension host, which is a violent answer to "show me this
 * project in the rail". So VS Code records the folder here instead: it joins
 * `trustedCwds` and appears as an ordinary catalog row, VS Code's own Explorer
 * is untouched, and nothing reloads.
 *
 * **It does grant reach, and that is the point.** An earlier version of this
 * comment claimed otherwise on the grounds that `localTrustedSessionCwds`
 * already trusts the whole discovered catalog — true, but the folder this
 * feature adds is precisely the one Grok has NEVER run in, so it was not in
 * that catalog and is now. It becomes selectable, and through the phone,
 * browsable and editable like any other project. That is what the user asked
 * for by picking it. What it must therefore also be is REVOCABLE — see
 * {@link GrokSidebar.forgetExtraProjectFolder}, reachable from the rail's ⋯
 * menu on exactly the rows that came from here.
 *
 * Absent from `DISK_KEYS`, so it lives in `globalState` rather than the shared
 * `~/.grok/client-state` that pins and colours use. Deliberate: pins and colours
 * are curation you want to follow you to the phone, this is a workaround for one
 * editor's inability to show a folder it has not opened. Desktop filters it out
 * anyway (`localRepoCatalogEntries` keeps only open folders there), so sharing
 * it would move bytes around for no effect.
 */
const EXTRA_PROJECT_FOLDERS_KEY = "grok.extraProjectFolders";
/**
 * Folders the user has explicitly REMOVED from the rail, which stay removed.
 *
 * Dropping the added-folder record was not enough to make "Hide project" mean
 * anything. VS Code's catalog is discovered from Grok's own session history, so
 * the moment anything ran in that folder the row came back on its own — and a
 * phone selecting the project is enough to create that history, because
 * `selectRemoteRepo` opens or starts a session there. So a remote could make its
 * own access permanent by selecting a newly added project before the user
 * thought better of it, and the returning row carried no `added` marker, so the
 * rail no longer offered to remove it.
 *
 * A tombstone is the only thing that survives that. Nothing on disk is touched
 * and no conversation is deleted — the project is simply not listed, and
 * therefore not trusted, until the user adds the folder again, which clears it.
 * VS Code-local like its counterpart: absent from `DISK_KEYS`, so it lives in
 * `globalState` rather than the shared client-state.
 */
const REMOVED_PROJECT_FOLDERS_KEY = "grok.removedProjectFolders";
/** Shared client-state key for the anonymous per-install telemetry GUID (survives
 *  updates and identifies this machine across clients).
 *
 *  This is MACHINE identity, not DEVICE identity. The relay REVOKES every device
 *  row carrying the same install id when a link is approved (that is how a
 *  re-link retires its own stale predecessor instead of hitting the free tier's
 *  device cap). So a second client on this machine must NOT send this value
 *  verbatim to `/api/link/start` — it would revoke the extension's device and
 *  drop its uplink, and re-linking here would revoke that client's in turn.
 *  Send a discriminated form (`<id>:desktop`) and leave the bare id to the
 *  extension, whose already-linked rows store it bare. */
const INSTALL_ID_KEY = "grok.installId";
/** VS Code-local globalState key for the eye-off choice on the active-editor context chip.
 *  The chip is rebuilt from scratch on every file switch, so the user's "don't
 *  send this" has to live outside it or every switch silently re-enables the
 *  file — the #67 complaint. Persisted (not per-session) because a preference
 *  this deliberate should survive a reload, exactly like the setting would. */
const IMPLICIT_CHIP_HIDDEN_KEY = "grok.implicitChipHidden";
/** One helpful warning per install, even though every pooled process initializes. */
const OAUTH_SHADOW_WARNING_KEY = "grok.oauthShadowWarningShown";

interface SessionLoadReservation {
  token: symbol;
  session?: Session;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/** Resolved at commit time, AFTER any await. Undefined means the tab that asked
 *  is gone and the attachment must be dropped — never redirected. */
type AttachmentOwner = () => Session | undefined;

interface SessionsListOptions {
  offset?: number;
  limit?: number;
  query?: string;
  providerCursor?: ProviderHistoryCursor;
}

type GrokSessionsListOptions = Omit<SessionsListOptions, "providerCursor">;
type GrokSessionsListMessage = Extract<HostMsg, { type: "sessions" }>;

// History pagination: rows fetched per "page" (initial open + each load-more / search page).
const SESSION_PAGE_SIZE = 100;

/** Rows a `listRepoSessions` preview returns when the client names no limit —
 *  the projects rail shows a few per repo and links out for the rest. */
const REPO_PREVIEW_SIZE = 3;

/** How long a cancelled turn may go unanswered before the host settles it
 *  itself. Generous: an honoured cancel comes back well inside a second, so this
 *  only ever fires when the turn was going to wedge anyway. */
const CANCEL_SETTLE_GRACE_MS = 10_000;

// Scheme for the permission-card diff preview's virtual documents. Backing the
// before/after sides with a read-only content provider (rather than untitled
// scratch buffers) means the diff tab never goes "dirty", so closing it doesn't
// prompt to save (issue #21). The path keeps the real filename so VS Code infers
// the language for syntax highlighting.
const GROK_DIFF_SCHEME = "grok-diff";

/**
 * Read-only content provider for the diff-preview virtual documents. Content is
 * stored per-URI and served verbatim; the documents are never editable or dirty,
 * so the diff tab closes without a save prompt. Host-registered via
 * {@link Host.registerTextDocumentContentProvider}.
 */
class GrokDiffContentProvider implements HostTextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
  set(uri: Uri, content: string): void {
    this.contents.set(uri.toString(), content);
  }
  delete(...uris: Uri[]): void {
    for (const uri of uris) this.contents.delete(uri.toString());
  }
}

/** Best-effort MIME from a file extension, for inlining generated media. */
function guessMediaMime(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    case "mp4":
    case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    default: return "image/png";
  }
}

/** Find sensitive credential/key/env files in a workspace root */
export function findWorkspaceSensitiveFiles(workspaceRoot?: string): string[] {
  if (!workspaceRoot) return [];
  try {
    const entries = fs.readdirSync(workspaceRoot);
    const found: string[] = [];
    for (const file of entries) {
      const lower = file.toLowerCase();
      if (
        lower.startsWith(".env") ||
        lower.endsWith(".pem") ||
        lower.startsWith("id_rsa") ||
        lower.startsWith("id_ed25519") ||
        lower.endsWith(".key")
      ) {
        found.push(file);
      }
    }
    return found;
  } catch {
    return [];
  }
}

export class GrokSidebar {
  private warnedSensitiveFiles = false;
  /** Workspace roots whose unadopted `.grok/permissions.json` we already asked about this run. */
  private readonly permissionAdoptionPrompted = new Set<string>();
  public static readonly viewId = "companions.chat";
  public static readonly legacyViewId = "grok.chat";
  /** Primary side bar projects rail — separate webview, not a second chat client. */
  public static readonly projectsViewId = "companions.projects";
  public static readonly legacyProjectsViewId = "grok.projects";
  private view?: HostWebviewView;
  /** Second local consumer of catalog-shaped host messages. Absent until resolved. */
  private projectsRail?: HostWebviewView;
  /** The session currently shown in the chat — one member of {@link pool}. */
  private focused = this.newLocalSession();
  /**
   * Every live session (each a spawned `grok agent stdio` process), including the
   * focused one. Backgrounded members keep streaming into their own buffers, so
   * re-focusing one replays its buffer losslessly — no kill, no reload. A session
   * is added on its first successful start and removed when its client is disposed
   * (switch-away of an empty one, delete, logout, reap, teardown).
   */
  private pool = new Set<Session>();
  /**
   * Cache of parsed session metadata for the history popover, keyed by session id. Each value
   * remembers the `summary.json` mtime it was read at, so a cheap `indexSessions` stat pass can
   * tell which entries are stale and re-read only those — the rest are reused across popover opens,
   * load-more pages, and searches. Invalidated per id on rename/delete; the whole map is disposable
   * (it's just a read cache, never a source of truth).
   */
  private sessionCache = new Map<string, { mtimeMs: number; entry: SessionListEntry }>();
  get codexSessionCache(): Map<string, SessionListEntry[]> { return this.providerSetup.codexSessionCache; }
  set codexSessionCache(v: Map<string, SessionListEntry[]>) { this.providerSetup.codexSessionCache = v; }
  get codexSessionCacheAt(): Map<string, number> { return this.providerSetup.codexSessionCacheAt; }
  set codexSessionCacheAt(v: Map<string, number>) { this.providerSetup.codexSessionCacheAt = v; }
  get codexSessionRefresh(): Map<string, Promise<void>> { return this.providerSetup.codexSessionRefresh; }
  set codexSessionRefresh(v: Map<string, Promise<void>>) { this.providerSetup.codexSessionRefresh = v; }
  get claudeSessionCache(): Map<string, SessionListEntry[]> { return this.providerSetup.claudeSessionCache; }
  set claudeSessionCache(v: Map<string, SessionListEntry[]>) { this.providerSetup.claudeSessionCache = v; }
  get claudeSessionCacheAt(): Map<string, number> { return this.providerSetup.claudeSessionCacheAt; }
  set claudeSessionCacheAt(v: Map<string, number>) { this.providerSetup.claudeSessionCacheAt = v; }
  get claudeSessionRefresh(): Map<string, Promise<void>> { return this.providerSetup.claudeSessionRefresh; }
  set claudeSessionRefresh(v: Map<string, Promise<void>>) { this.providerSetup.claudeSessionRefresh = v; }
  get geminiSessionCache(): Map<string, SessionListEntry[]> { return this.providerSetup.geminiSessionCache; }
  set geminiSessionCache(v: Map<string, SessionListEntry[]>) { this.providerSetup.geminiSessionCache = v; }
  get geminiSessionCacheAt(): Map<string, number> { return this.providerSetup.geminiSessionCacheAt; }
  set geminiSessionCacheAt(v: Map<string, number>) { this.providerSetup.geminiSessionCacheAt = v; }
  get geminiSessionRefresh(): Map<string, Promise<void>> { return this.providerSetup.geminiSessionRefresh; }
  set geminiSessionRefresh(v: Map<string, Promise<void>>) { this.providerSetup.geminiSessionRefresh = v; }
  get museSessionCache(): Map<string, SessionListEntry[]> { return this.providerSetup.museSessionCache; }
  set museSessionCache(v: Map<string, SessionListEntry[]>) { this.providerSetup.museSessionCache = v; }
  get museSessionCacheAt(): Map<string, number> { return this.providerSetup.museSessionCacheAt; }
  set museSessionCacheAt(v: Map<string, number>) { this.providerSetup.museSessionCacheAt = v; }
  get museSessionRefresh(): Map<string, Promise<void>> { return this.providerSetup.museSessionRefresh; }
  set museSessionRefresh(v: Map<string, Promise<void>>) { this.providerSetup.museSessionRefresh = v; }
  get codexInstallAbort(): AbortController | undefined { return this.providerSetup.codexInstallAbort; }
  set codexInstallAbort(v: AbortController | undefined) { this.providerSetup.codexInstallAbort = v; }
  get providerConnectionState(): ProviderConnections { return this.providerSetup.providerConnectionState; }
  set providerConnectionState(v: ProviderConnections) { this.providerSetup.providerConnectionState = v; }
  /**
   * Bounds on the live-session pool (see session-pool.ts). A backgrounded session
   * idle past {@link IDLE_TTL_MS}, or beyond the {@link MAX_LIVE_SESSIONS} LRU cap,
   * is silently reaped (its process killed, its dot going cold) — re-focusing it
   * reloads from grok's on-disk history. Working/needs-you and the focused session
   * are never reaped.
   */
  private static readonly MAX_LIVE_SESSIONS = 8;
  private static readonly IDLE_TTL_MS = 60 * 60 * 1000; // 1h
  private static readonly REAP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 min
  private static readonly STAGING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // The empty-session sweep only scans the newest N by mtime, keeping it bounded
  // on a large store.
  public static readonly SWEEP_SCAN_LIMIT = 300;
  // …and leaves recent ones alone entirely. Parking is what removes the empty
  // session you just walked away from; the sweep exists for the ones nothing was
  // there to park, and those are never minutes old. A session grok registered
  // recently may not have written its history yet, and — the case this is really
  // sized for — may be open in ANOTHER VS Code window, whose live processes this
  // one cannot see. That window's session would be empty (nothing else is ever
  // swept) and grok re-persists it on its next turn, so the cost is bounded; the
  // delay is what keeps it from being routine. Costs nothing in return: an orphan
  // is stamped when its window opened, so by the next activation it is already old.
  public static readonly SWEEP_MIN_AGE_MS = 30 * 60 * 1000;
  /** How often the sweep may actually walk, per repo. Well under
   *  SWEEP_MIN_AGE_MS, so a shell waits at most SWEEP_MIN_AGE_MS + this before
   *  it is collected — while the walk stops being something a click pays for. */
  public static readonly SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  /** Last real sweep per repo, for SWEEP_INTERVAL_MS. */
  private readonly lastSweepAt = new Map<string, number>();
  /** A whole-list refresh is already queued for this tick. See postSessionsList. */
  private sessionsListScheduled = false;
  private reaper?: ReturnType<typeof setInterval>;
  private oauthShadowWarningShown = false;
  /** K-02: the threshold-mismatch notice shows once per window. */
  private compactMismatchNoticeShown = false;
  private get chips(): ContextChip[] { return this.focused.chips; }
  private set chips(value: ContextChip[]) { this.focused.chips = value; }
  /** Attachment-staging ops still in flight — see trackAttach. */
  private readonly pendingAttach = new Set<Promise<void>>();
  /** Cached findFiles snapshot for the `@` popover (no open-editor merge).
   *  One snapshot serves {@link MENTION_INDEX_TTL_MS}; concurrent queries share
   *  one in-flight build. Open tabs are layered on at read time. */
  private mentionIndex: { at: number; rels: string[]; absByRel: Map<string, string> } | null = null;
  private mentionIndexPromise: Promise<{ rels: string[]; absByRel: Map<string, string> }> | null = null;
  /** Same snapshot, for a session whose cwd is not the open workspace folder. */
  private readonly otherCwdMentionIndexes = new Map<string, {
    at: number;
    rels: string[];
    absByRel: Map<string, string>;
  }>();
  private editorWatcher?: HostDisposable;
  private terminalManager = new TerminalManager();
  get voiceRecorder(): VoiceRecorder { return this.voiceAndMcp.voiceRecorder; }
  set voiceRecorder(v: VoiceRecorder) { this.voiceAndMcp.voiceRecorder = v; }
  get voiceTempPath(): string | undefined { return this.voiceAndMcp.voiceTempPath; }
  set voiceTempPath(v: string | undefined) { this.voiceAndMcp.voiceTempPath = v; }
  get voiceBatchCtx(): { backend: SttBackend; key: string } | undefined { return this.voiceAndMcp.voiceBatchCtx; }
  set voiceBatchCtx(v: { backend: SttBackend; key: string } | undefined) { this.voiceAndMcp.voiceBatchCtx = v; }
  get voiceStreamer(): VoiceStreamer | undefined { return this.voiceAndMcp.voiceStreamer; }
  set voiceStreamer(v: VoiceStreamer | undefined) { this.voiceAndMcp.voiceStreamer = v; }
  get voiceStoppingStreamer(): VoiceStreamer | undefined { return this.voiceAndMcp.voiceStoppingStreamer; }
  set voiceStoppingStreamer(v: VoiceStreamer | undefined) { this.voiceAndMcp.voiceStoppingStreamer = v; }
  get voiceFinalizing(): boolean { return this.voiceAndMcp.voiceFinalizing; }
  set voiceFinalizing(v: boolean) { this.voiceAndMcp.voiceFinalizing = v; }
  get voiceGeneration(): number { return this.voiceAndMcp.voiceGeneration; }
  set voiceGeneration(v: number) { this.voiceAndMcp.voiceGeneration = v; }
  get voiceStreamCtx(): VoiceStreamContext | undefined { return this.voiceAndMcp.voiceStreamCtx; }
  set voiceStreamCtx(v: VoiceStreamContext | undefined) { this.voiceAndMcp.voiceStreamCtx = v; }
  get localVoiceCwd(): string | undefined { return this.voiceAndMcp.localVoiceCwd; }
  set localVoiceCwd(v: string | undefined) { this.voiceAndMcp.localVoiceCwd = v; }
  get localVoiceCredentialCwd(): string | undefined { return this.voiceAndMcp.localVoiceCredentialCwd; }
  set localVoiceCredentialCwd(v: string | undefined) { this.voiceAndMcp.localVoiceCredentialCwd = v; }
  get lastVoiceConfiguredByCwd(): Map<string, boolean> { return this.voiceAndMcp.lastVoiceConfiguredByCwd; }
  set lastVoiceConfiguredByCwd(v: Map<string, boolean>) { this.voiceAndMcp.lastVoiceConfiguredByCwd = v; }
  get lastPostedVoiceConfigured(): Map<string, string> { return this.voiceAndMcp.lastPostedVoiceConfigured; }
  set lastPostedVoiceConfigured(v: Map<string, string>) { this.voiceAndMcp.lastPostedVoiceConfigured = v; }
  private configWatcher?: HostDisposable;
  /** Cold session/load claims the persisted id before ACP has emitted `session`. */
  private readonly sessionLoadReservations = new Map<string, SessionLoadReservation>();
  /**
   * Per-Session start tail. Boot, client-ready, resume, and ensureClient all
   * share it with handleSend so a send cannot commit an echo while a start
   * is still replacing the process.
   */
  private sessionStartTails?: WeakMap<Session, Promise<void>>;
  private static readonly SESSION_LOAD_RESERVATION_TTL_MS = 10 * 60_000;
  private testSessionStartDelay?: {
    resumeId: string | undefined;
    started: () => void;
    wait: Promise<void>;
  };
  /**
   * Test-only latch. When set, Grok discovery stops after an explicit cached
   * path (provisionFakeGrok). Config and PATH are not searched, so a developer
   * box cannot silently pick up a real CLI. Production never sets this.
   */
  get testForceMissingGrokCli(): boolean { return !!this.providerSetup.testForceMissingGrokCli; }
  set testForceMissingGrokCli(v: boolean) { this.providerSetup.testForceMissingGrokCli = v; }
  /** First full boot pass — repo catalog AND the deferred session-list — finished. */
  private firstBootScanStarted = false;
  private firstBootScanCompleted = false;
  get cliPath(): string | undefined { return this.providerSetup.cliPath; }
  set cliPath(v: string | undefined) { this.providerSetup.cliPath = v; }
  get codexCliPath(): string | undefined { return this.providerSetup.codexCliPath; }
  set codexCliPath(v: string | undefined) { this.providerSetup.codexCliPath = v; }
  get claudeCliPath(): string | undefined { return this.providerSetup.claudeCliPath; }
  set claudeCliPath(v: string | undefined) { this.providerSetup.claudeCliPath = v; }
  get geminiCliPath(): string | undefined { return this.providerSetup.geminiCliPath; }
  set geminiCliPath(v: string | undefined) { this.providerSetup.geminiCliPath = v; }
  get museCliPath(): string | undefined { return this.providerSetup.museCliPath; }
  set museCliPath(v: string | undefined) { this.providerSetup.museCliPath = v; }
  private readonly providerCliVersions: Partial<Record<AcpProvider, string>> = {};
  get providerNeedsLogin(): Partial<Record<AcpProvider, boolean>> { return this.providerSetup.providerNeedsLogin; }
  set providerNeedsLogin(v: Partial<Record<AcpProvider, boolean>>) { this.providerSetup.providerNeedsLogin = v; }
  get lastProviderConnected(): { grok: boolean; codex: boolean; claude: boolean; gemini: boolean } | null { return this.providerSetup.lastProviderConnected; }
  set lastProviderConnected(v: { grok: boolean; codex: boolean; claude: boolean; gemini: boolean } | null) { this.providerSetup.lastProviderConnected = v; }
  get providerRefreshInFlight(): boolean { return this.providerSetup.providerRefreshInFlight; }
  set providerRefreshInFlight(v: boolean) { this.providerSetup.providerRefreshInFlight = v; }
  get loginReprobeTimers(): Map<AcpProvider, NodeJS.Timeout> { return this.providerSetup.loginReprobeTimers; }
  set loginReprobeTimers(v: Map<AcpProvider, NodeJS.Timeout>) { this.providerSetup.loginReprobeTimers = v; }
  /** VS Code settings tab. Desktop/remote keep the in-page overlay. */
  private settingsEditor?: HostEditorWebview;
  private static readonly SETTINGS_PANEL_TYPES = new Set<WebviewMsg["type"]>([
    "openSettingsSurface",
    "closeSettingsSurface",
    // The standalone VS Code Settings tab is a first-class surface for this
    // page — it loads settings.js and nothing else. Without these five it
    // posts `listRoutines`, gets "[settings] ignored", and shows an empty
    // Routines page with no projects, no models and no way to create one.
    "listRoutines",
    "saveRoutine",
    "deleteRoutine",
    "setRoutinePaused",
    "runRoutineNow",
    // Agents & Crew is a settings-tab page in exactly the same way, and
    // without these five it posts `listAgentRoles`, gets "[settings] ignored",
    // and shows an empty page with no way to create anything.
    "listAgentRoles",
    "saveAgentRole",
    "deleteAgentRole",
    "saveCrewFlow",
    "deleteCrewFlow",
    "saveWorkflow",
    "validateWorkflow",
    "generateWorkflow",
    "cancelWorkflowGenerate",
    "setDefaultWorkflow",
    "addWorkflowStagesBlock",
    "runWorkflow",
    // The rest of Agents & Crew and Advanced: roster, routing, the two
    // toggles, rule files, permission rules, and workflow Export.
    "subagentRosterSave",
    "subagentRoutingSave",
    "setSubagentsEnabled",
    "setCrewStageSubagents",
    "setCompanionsSetting",
    "listRuleFiles",
    "openRuleFile",
    "listPermissionRules",
    "deletePermissionRule",
    "adoptPermissionRules",
    "openText",
    "setShowThinking",
    "setAppPurpose",
    "setExpandCommandOutputs",
    "setSteerByDefault",
    "setSoundNotifications",
    "setProcessingSound",
    "setReadRepliesAloud",
    "setSummarizeRepliesAloud",
    "setVoiceSendPhrase",
    "setVoiceKeyterms",
    "setVoiceBackend",
    "configureOpenAiVoice",
    "setTelemetryEnabled",
    "setThumbsFeedback",
    "openGlobalConfig",
    "openProjectConfig",
    "listMcpServers",
    "connectMcpConnector",
    "disconnectMcpConnector",
    "showLogs",
    "toggleDevTools",
    "openSettings",
    "openUrl",
    "moveView",
    "logout",
    "setupGithubCli",
    "githubSignOut",
    "githubLoginWithToken",
    "runGrokLogin",
    "refreshProviders",
    // An agent row's "Re-check connection" after a terminal sign-in started
    // FROM this page.
    "recheckConnection",
    "checkGrokUpdate",
    "updateGrok",
  ]);
  /** Project folders subsystem */
  private _projectFolders?: ProjectFolders;
  get projectFolders(): ProjectFolders {
    return this._projectFolders ??= this.createProjectFolders();
  }
  set projectFolders(value: ProjectFolders) { this._projectFolders = value; }

  /** Routine scheduler subsystem */
  private _routineScheduler?: RoutineScheduler;
  get routineScheduler(): RoutineScheduler {
    return this._routineScheduler ??= this.createRoutineScheduler();
  }
  set routineScheduler(value: RoutineScheduler) { this._routineScheduler = value; }

  get routineTimer(): NodeJS.Timeout | undefined { return this.routineScheduler.routineTimer; }
  set routineTimer(v: NodeJS.Timeout | undefined) { this.routineScheduler.routineTimer = v; }
  get routinesInFlight(): Set<string> { return this.routineScheduler.routinesInFlight; }

  get githubConnection(): GithubAuthState | undefined { return this.projectFolders.githubConnection; }
  set githubConnection(v: GithubAuthState | undefined) { this.projectFolders.githubConnection = v; }

  /** CLI update subsystem */
  private _cliUpdateHost?: CliUpdateHost;
  get cliUpdateHost(): CliUpdateHost {
    return this._cliUpdateHost ??= this.createCliUpdateHost();
  }
  set cliUpdateHost(value: CliUpdateHost) { this._cliUpdateHost = value; }
  get mcpServers(): McpServerView[] { return this.voiceAndMcp.mcpServers; }
  set mcpServers(v: McpServerView[]) { this.voiceAndMcp.mcpServers = v; }
  get mcpServersCwd(): string | undefined { return this.voiceAndMcp.mcpServersCwd; }
  set mcpServersCwd(v: string | undefined) { this.voiceAndMcp.mcpServersCwd = v; }
  get mcpServersView(): McpServerView[] { return this.voiceAndMcp.mcpServersView; }
  set mcpServersView(v: McpServerView[]) { this.voiceAndMcp.mcpServersView = v; }
  get mcpListSupported(): boolean | undefined { return this.voiceAndMcp.mcpListSupported; }
  set mcpListSupported(v: boolean | undefined) { this.voiceAndMcp.mcpListSupported = v; }
  get grokMcpReserved(): ReservedMcpIdentity { return this.voiceAndMcp.grokMcpReserved; }
  set grokMcpReserved(v: ReservedMcpIdentity) { this.voiceAndMcp.grokMcpReserved = v; }
  get mcpConnectingId(): ConnectorId | undefined { return this.voiceAndMcp.mcpConnectingId; }
  set mcpConnectingId(v: ConnectorId | undefined) { this.voiceAndMcp.mcpConnectingId = v; }
  get mcpConnectError(): { id: ConnectorId; message: string } | undefined { return this.voiceAndMcp.mcpConnectError; }
  set mcpConnectError(v: { id: ConnectorId; message: string } | undefined) { this.voiceAndMcp.mcpConnectError = v; }
  get mcpConnectorKeys(): Map<string, string> { return this.voiceAndMcp.mcpConnectorKeys as Map<string, string>; }
  set mcpConnectorKeys(v: Map<string, string>) { this.voiceAndMcp.mcpConnectorKeys = v as Map<ConnectorId, string>; }
  get grokSessionForMcpListInFlight(): Promise<Session | undefined> | undefined { return this.voiceAndMcp.grokSessionForMcpListInFlight; }
  set grokSessionForMcpListInFlight(v: Promise<Session | undefined> | undefined) { this.voiceAndMcp.grokSessionForMcpListInFlight = v; }
  private readonly mcpConnectorKeysReady: Promise<void>;
  private grokVersionProbe?: Promise<string>;
  get codexVersionProbe(): Promise<string> | undefined { return this.cliUpdateHost.codexVersionProbe; }
  set codexVersionProbe(v: Promise<string> | undefined) { this.cliUpdateHost.codexVersionProbe = v; }
  get claudeVersionProbe(): Promise<string> | undefined { return this.cliUpdateHost.claudeVersionProbe; }
  set claudeVersionProbe(v: Promise<string> | undefined) { this.cliUpdateHost.claudeVersionProbe = v; }
  get geminiVersionProbe(): Promise<string> | undefined { return this.cliUpdateHost.geminiVersionProbe; }
  set geminiVersionProbe(v: Promise<string> | undefined) { this.cliUpdateHost.geminiVersionProbe = v; }
  get museVersionProbe(): Promise<string> | undefined { return this.cliUpdateHost.museVersionProbe; }
  set museVersionProbe(v: Promise<string> | undefined) { this.cliUpdateHost.museVersionProbe = v; }
  /** History browsing scope. Deliberately independent of the live session cwd. */
  private selectedRepoCwd?: string;
  /**
   * Serializes local project-folder switches (desktop multi-folder). Renderer
   * `repoSwitchPending` is not a trust boundary — two concurrent `selectRepo`
   * messages must not interleave host-side openSession against a mutated
   * focused session (cross-repo bleed).
   */
  private readonly localWorkspaceSwitchQueue = new AsyncSerialQueue();
  // The original update trigger: at most once per activation, and only after an
  // extension-version change (never on the fresh-install baseline).
  get cliUpdateChecked(): boolean { return this.providerSession.cliUpdateChecked; }
  set cliUpdateChecked(v: boolean) { this.providerSession.cliUpdateChecked = v; }

  // Known-broken Windows builds are checked and pinned at most once per
  // activation after the normal extension-upgrade update has run.
  private brokenCliPinned = false;

  // Re-entrancy guard for the reactive (post-init-failure) downgrade + retry in
  // startSession. Prevents a tight loop if the downgrade "succeeds" but the spawn
  // still fails; it is NOT a permanent latch — it's reset after each retry, so a
  // later manual re-upgrade that breaks again gets downgraded again.
  private reactiveDowngradeInFlight = false;

  // Diff-preview plumbing (issue #21): a read-only content provider backs the
  // before/after sides (no save prompt on close), a monotonic counter keeps each
  // diff's virtual URIs unique, and openDiffsByRequest maps a pending permission
  // request → its diff URIs so the tab can be auto-closed when the user answers.
  private readonly diffProvider = new GrokDiffContentProvider();
  private diffSeq = 0;
  private readonly openDiffsByRequest =
    new SessionRequestState<Session, { left: Uri; right: Uri }>();
  /**
   * In-flight in-chat confirms, keyed by request id — see confirmInChat.
   *
   * The SESSION is stored with the resolver because the id alone is not an
   * authorization: it is a sequential `confirm-N`, the map is host-global, and
   * `uiConfirmAnswer` stopped being host-local when Rewind was opened to
   * remotes. Without this, an answer sent while bound to conversation B
   * resolves conversation A's confirm — and the thing on the other side of
   * that confirm reverts files on disk.
   */
  private readonly pendingConfirms = new Map<string, { session: Session; resolve: (ok: boolean) => void }>();
  /**
   * Per-session git baseline for the CURRENT turn (upstream 2a8ffb0 / #168):
   * `git stash create` right after the turn begins records the before-state
   * without touching the tree, index or refs. It lets the Review Center open
   * ONE diff per file covering everything the turn did — shell edits included —
   * instead of the last tool call's edit. Absent, non-git or spoiled, the
   * Review Center falls back to its own tool-call diff.
   */
  private readonly turnGitBaselines = new WeakMap<Session, {
    turnId: string;
    root: string;
    turn: object;
    pending: boolean;
    baseline?: GitTurnBaseline;
  }>();
  private readonly gitRunGate = new GitRunGate();
  private confirmSeq = 0;

  /** Session names, pins, archives and the install id — held in `~/.grok` so a
   *  non-VS-Code client of this machine reads the same state. Everything else
   *  still lands in `globalState`; see persisted-state.ts. */
  private readonly state: PersistedState;

  /** Run records, and the exclusive-create claim that makes a due run happen
   *  exactly once across every host sharing this `~/.grok`. */
  private readonly routineRuns: RoutineRunStore;

  /** Client-side file snapshots per user turn (AP-08). Lives under globalStorage. */
  private readonly checkpointStore: CheckpointStore;
  /** `/agent` briefs, results and run logs (AP-10). Decision 18.1: runs are
   *  execution noise and live in globalStorage, not in the project. */
  private readonly agentRuns: AgentRunStore;
  private routineError?: { id?: string; message: string };

  private hostPipeMux?: HostPipeMux;
  private askUserChannel?: AskUserServer;

  private _questionHost?: QuestionHost;
  private _reviewHost?: ReviewHost;
  private _webviewHtml?: WebviewHtml;
  private _worktreeHost?: WorktreeHost;
  private _providerSetup?: ProviderSetup;
  private _workflowStageRunner?: WorkflowStageRunner;
  private _turnEdit?: TurnEdit;
  private _agentAuthoring?: AgentAuthoring;
  private _providerSession?: ProviderSession;
  private _voiceAndMcp?: VoiceAndMcp;

  /** Real instances set these in the constructor. Prototype stubs used by tests
   *  never run it, so the first delegating call builds the collaborator. */
  get webviewHtml(): WebviewHtml {
    return this._webviewHtml ??= this.createWebviewHtml();
  }
  set webviewHtml(value: WebviewHtml) { this._webviewHtml = value; }
  get questionHost(): QuestionHost {
    return this._questionHost ??= this.createQuestionHost();
  }
  set questionHost(value: QuestionHost) { this._questionHost = value; }
  get reviewHost(): ReviewHost {
    return this._reviewHost ??= this.createReviewHost();
  }
  set reviewHost(value: ReviewHost) { this._reviewHost = value; }
  get worktreeHost(): WorktreeHost {
    return this._worktreeHost ??= this.createWorktreeHost();
  }
  set worktreeHost(value: WorktreeHost) { this._worktreeHost = value; }
  get providerSetup(): ProviderSetup {
    return this._providerSetup ??= this.createProviderSetup();
  }
  set providerSetup(value: ProviderSetup) { this._providerSetup = value; }
  get workflowStageRunner(): WorkflowStageRunner {
    return this._workflowStageRunner ??= this.createWorkflowStageRunner();
  }
  set workflowStageRunner(value: WorkflowStageRunner) { this._workflowStageRunner = value; }
  get turnEdit(): TurnEdit {
    return this._turnEdit ??= this.createTurnEdit();
  }
  set turnEdit(value: TurnEdit) { this._turnEdit = value; }
  get agentAuthoring(): AgentAuthoring {
    return this._agentAuthoring ??= this.createAgentAuthoring();
  }
  set agentAuthoring(value: AgentAuthoring) { this._agentAuthoring = value; }
  get providerSession(): ProviderSession {
    return this._providerSession ??= this.createProviderSession();
  }
  set providerSession(value: ProviderSession) { this._providerSession = value; }
  get voiceAndMcp(): VoiceAndMcp {
    return this._voiceAndMcp ??= this.createVoiceAndMcp();
  }
  set voiceAndMcp(value: VoiceAndMcp) { this._voiceAndMcp = value; }

  private createVoiceAndMcp(): VoiceAndMcp {
    const self = this;
    return new VoiceAndMcp({
      get host() { return self.host; },
      get state() { return self.state; },
      get context() {
        return {
          secrets: self.context?.secrets ?? {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
          },
          globalStorageUri: self.context?.globalStorageUri ?? { fsPath: "" },
        };
      },
      getFocused: () => self.focused,
      getPool: () => self.pool,
      getOverride: (name: string) => self.sidebarTestOverride(name),
      voiceOps: {
        sessionCwd: (session) => self.sessionCwd(session),
        workspaceRoot: () => self.workspaceRoot(),
        defaultProviderForProject: (cwd) => self.defaultProviderForProject(cwd),
        resolveSttApiKey: (cwd, backend) => self.resolveSttApiKey(cwd, backend),
        voiceBackendState: (cwd, provider) => self.voiceBackendState(cwd, provider),
        openSettingsEditor: (tab) => self.openSettingsEditor(tab),
        postLocal: (msg) => self.postLocal(msg),
        post: (msg) => self.post(msg),
      },
      mcpOps: {
        connectedProviders: () => self.connectedProviders(),
        newLocalSession: () => self.newLocalSession(),
        setSessionCwd: (session, cwd, root) => self.setSessionCwd(session, cwd, root ?? self.workspaceRoot()),
        startSession: (id, target, mode) => self.startSession(id, target, mode),
        askUserMcpServer: (session) => self.askUserMcpServer(session),
        companionsMcpServer: (session) => self.companionsMcpServer(session),
        noteCompanionsSkip: (session, reason) => self.noteCompanionsSkip(session, reason),
        postWelcomeTips: () => self.postWelcomeTips(),
        getSettingsWebview: () => self.settingsEditor?.webview,
      },
      mediaOps: {
        emit: (session, msg) => self.emit(session, msg),
        getViewWebview: () => self.view?.webview,
        isImagePathAuthorizedNow: (path, session) => self.isImagePathAuthorizedNow(path, session),
        registerFullImage: (path) => self.registerFullImage(path),
        importImageFromDisk: (path, owner) => self.importImageFromDisk(path, owner),
        postChips: (session) => self.postChips(session),
      },
    });
  }

  private createRoutineScheduler(): RoutineScheduler {
    const self = this;
    return new RoutineScheduler({
      state: {
        get: <T>(key: string, defaultValue?: T) =>
          defaultValue !== undefined ? self.state.get<T>(key, defaultValue) : (self.state.get<T>(key) as T),
        update: (key: string, value: any) => self.state.update(key, value),
      },
      getRoutineRuns: () => self.routineRuns,
      usableProviders: () => self.usableProviders(),
      resolveLocalRepoTarget: (cwd: string) => self.resolveLocalRepoTarget(cwd),
      newLocalSession: () => self.newLocalSession(),
      addSessionToPool: (session: Session) => { self.pool.add(session); },
      setSessionCwd: (session: Session, cwd: string, root: string) => self.setSessionCwd(session, cwd, root),
      workspaceRoot: () => self.workspaceRoot(),
      startSession: (id?: string, session?: Session) => self.startSession(id, session),
      switchModel: (model: string, session: Session, provider?: AcpProvider) => self.switchModel(model, session, provider),
      deleteSessionCache: (id: string) => { self.sessionCache.delete(id); },
      postSessionName: (session: Session) => self.postSessionName(session),
      postRepoCatalog: () => self.postRepoCatalog(),
      postSessionsList: () => self.postSessionsList(),
      postRoutines: () => self.postRoutines(),
      handleSend: (prompt: string, isSteer: boolean, session: Session) => self.handleSend(prompt, isSteer, session),
      getOverride: (name: string) => self.sidebarTestOverride(name),
    });
  }

  private createCliUpdateHost(): CliUpdateHost {
    const self = this;
    return createCliUpdateHost({
      get host() { return self.host; },
      get state() { return self.state; },
      get context() { return self.context; },
      post: (msg) => self.post(msg),
      postGrokUpdateStatus: (msg) => self.postGrokUpdateStatus(msg),
      postProviderState: () => self.postProviderState(),
      get providerCliVersions() {
        return (self.providerCliVersions ?? ((self as any).providerCliVersions = {})) as Record<string, string>;
      },
      hasProviderConsent: (provider) => self.hasProviderConsent(provider),
      locateProvider: (provider) => self.locateProvider(provider),
      readGrokVersion: (cliPath) => self.readGrokVersion(cliPath),
      connectedProviders: () => self.connectedProviders(),
      installManagedCodexCli: () => self.installManagedCodexCli(),
      reprobeProviderCredentials: (provider) => self.reprobeProviderCredentials(provider),
      getFocused: () => self.focused,
      setFocused: (session) => { self.focused = session; },
      getPool: () => (self.pool ? self.pool.values() : []),
      newLocalSession: () => self.newLocalSession(),
      disposePool: () => self.disposePool(),
      startSession: (resumeId) => self.startSession(resumeId),
      getOverride: (name: string) => self.sidebarTestOverride(name)
    });
  }

  private createProjectFolders(): ProjectFolders {
    const self = this;
    return new ProjectFolders({
      host: {
        get canSwitchWorkspaceFolder() { return !!self.host.canSwitchWorkspaceFolder; },
        workspaceRoot: () => self.workspaceRoot(),
        openWorkspaceFolders: () => self.openWorkspaceFolders(),
        showOpenDialog: (opts) => self.host.showOpenDialog(opts),
        showWarningMessage: (msg, ...args) => self.host.showWarningMessage(msg, ...args),
        addWorkspaceFolder: (folder) => self.host.addWorkspaceFolder(folder),
        removeWorkspaceFolder: (folder) => self.host.removeWorkspaceFolder(folder),
        setActiveWorkspaceFolder: (target) => self.host.setActiveWorkspaceFolder(target),
        appendLine: (line) => self.host.appendLine(line),
        createTerminal: (opts) => self.host.createTerminal(opts),
      },
      state: {
        get: <T>(key: string, def?: T) => (def !== undefined ? self.state.get<T>(key, def) : (self.state.get<T>(key) as T)),
        update: (key: string, val: any) => self.state.update(key, val),
      },
      context: {
        get globalState() { return (self.context?.globalState ?? self.state) as any; },
        get globalStorageUri() { return self.context?.globalStorageUri ?? { fsPath: "" }; },
      },
      sessionOps: {
        getFocused: () => self.focused,
        setFocused: (s) => { self.focused = s; },
        getPool: () => self.pool,
        newLocalSession: () => self.newLocalSession(),
        sessionCwd: (s) => self.sessionCwd(s),
        setSessionCwd: (s, cwd, exp) => self.setSessionCwd(s, cwd, exp),
        startSession: (id, s, mode) => self.startSession(id, s, mode as SessionStartIntent),
        parkFocused: () => self.parkFocused(),
        disposeSession: (s) => self.disposeSession(s),
        defaultProviderForProject: (cwd) => self.defaultProviderForProject(cwd),
        isAuthorizedCwd: (cwd) => self.isAuthorizedCwd(cwd),
      },
      uiOps: {
        emit: (s, msg) => self.emit(s, msg),
        post: (msg) => self.post(msg),
        postRepoCatalog: () => self.postRepoCatalog(),
        postSessionsList: () => self.postSessionsList(),
        getSelectedRepoCwd: () => self.selectedRepoCwd,
        setSelectedRepoCwd: (cwd) => { self.selectedRepoCwd = cwd; },
        getSettingsEditorWebview: () => self.settingsEditor?.webview,
      },
      catalogOps: {
        resolveLocalRepoTarget: (cwd) => self.resolveLocalRepoTarget(cwd),
        workspaceRoot: () => self.workspaceRoot(),
        extraProjectFolders: () => self.extraProjectFolders(),
        canAddProjectFolder: () => self.canAddProjectFolder(),
        getWorktreeCache: () => self.worktreeCache,
        setWorktreeCache: (w) => { self.worktreeCache = w; },
        getAuthEpoch: () => self.authEpoch,
        bumpAuthEpoch: () => ++self.authEpoch,
      },
      mediaOps: {
        getFullImagePaths: () => self.fullImagePaths,
        getFullImageHandles: () => self.fullImageHandles,
        getLocalVoiceCwd: () => self.localVoiceCwd,
        getLocalVoiceCredentialCwd: () => self.localVoiceCredentialCwd,
        stopVoiceInput: () => self.stopVoiceInput(),
      },
      localWorkspaceSwitchQueue: self.localWorkspaceSwitchQueue,
      getOverride: (name: string) => self.sidebarTestOverride(name),
    });
  }

  private createProviderSession(): ProviderSession {
    const self = this;
    return createProviderSession({
      get host() { return self.host; },
      get state() { return self.state; },
      get context() { return { extensionVersion: self.context?.extensionVersion ?? "0.2.0" }; },
      getOverride: (name: string) => self.sidebarTestOverride(name),
      getFocused: () => self.focused,
      setFocused: (session) => { self.focused = session; },
      getPool: () => self.pool,
      sessionOps: {
        sessionCwd: (...args) => self.sessionCwd(...args),
        setSessionCwd: (session, cwd, root) => self.setSessionCwd(session, cwd, root ?? self.workspaceRoot()),
        workspaceRoot: () => self.workspaceRoot(),
        newLocalSession: () => self.newLocalSession(),
        startSession: (...args) => self.startSession(...args),
        restartSession: (...args) => self.restartSession(...args),
        disposeSession: (session) => { void self.disposeSession(session); },
        removeSessionFromDisk: (...args) => self.removeSessionFromDisk(...args),
        discardRestartedEmptySession: (...args) => self.discardRestartedEmptySession(...args),
        discardAdapterEmptySession: (provider, id, cwd, client) => self.discardAdapterEmptySession(provider, id, cwd ?? "", client),
        restoreStrandedDraft: (...args) => self.restoreStrandedDraft(...args),
        rememberQueuedDraft: (...args) => self.rememberQueuedDraft(...args),
        rememberProjectProvider: (...args) => self.rememberProjectProvider(...args),
        rememberGrokConfig: (...args) => self.rememberGrokConfig(...args),
        sessionDisplayName: (...args) => self.sessionDisplayName(...args),
        authorizedSessionCwds: () => self.authorizedSessionCwds(),
      },
      uiOps: {
        notifyUser: (...args) => self.notifyUser(...args),
        emit: (...args) => self.emit(...args),
        emitLocalTransient: (...args) => self.emitLocalTransient(...args),
        post: (...args) => self.post(...args),
        postSessionsList: () => self.postSessionsList(),
        setStatus: (...args) => self.setStatus(...args),
        setPlanActive: (...args) => self.setPlanActive(...args),
        syncHumanWait: (...args) => self.syncHumanWait(...args),
        persistPlanVerdict: (session, verdict, text) => self.persistPlanVerdict(session, verdict, text ?? ""),
        noteAnswered: (...args) => self.noteAnswered(...args),
        autoApprovePendingPermissions: (...args) => self.autoApprovePendingPermissions(...args),
        divertRacingSend: (...args) => self.divertRacingSend(...args),
        pickRestartMode: (...args) => self.pickRestartMode(...args),
        childWriteClaimWarning: (...args) => self.childWriteClaimWarning(...args),
        snapshotToolCallWrites: (...args) => self.snapshotToolCallWrites(...args),
        loadPermissionRuleState: (...args) => self.loadPermissionRuleState(...args),
        maybePromptWorkspaceRulesAdoption: (...args) => self.maybePromptWorkspaceRulesAdoption(...args),
        turnInFlight: (...args) => self.turnInFlight(...args),
        armCancelRecovery: (...args) => self.armCancelRecovery(...args),
      },
      providerOps: {
        modelsForSession: (...args) => self.modelsForSession(...args),
        connectedProviders: () => self.connectedProviders(),
        defaultProviderForProject: (...args) => self.defaultProviderForProject(...args),
        locateProvider: (...args) => self.locateProvider(...args),
        readGrokVersion: (...args) => self.readGrokVersion(...args),
        getProviderCliVersions: () => self.providerCliVersions,
      },
    });
  }

  private createAgentAuthoring(): AgentAuthoring {
    const self = this;
    return createAgentAuthoring({
      get host() { return self.host; },
      get state() { return self.state; },
      getOverride: (name: string) => self.sidebarTestOverride(name),
      getFocused: () => self.focused,
      setFocused: (session) => { self.focused = session; },
      getPool: () => self.pool,
      getAgentRuns: () => self.agentRuns,
      sessionOps: {
        sessionCwd: (...args) => self.sessionCwd(...args),
        setSessionCwd: (session, cwd, root) => self.setSessionCwd(session, cwd, root ?? self.workspaceRoot()),
        workspaceRoot: () => self.workspaceRoot(),
        newLocalSession: () => self.newLocalSession(),
        startSession: (...args) => self.startSession(...args),
        handleSend: (...args) => self.handleSend(...args),
        parkFocused: () => self.parkFocused(),
        postSessionsList: () => self.postSessionsList(),
        sessionTypeMetaFor: (...args) => self.sessionTypeMetaFor(...args),
        buildThreadContext: (...args) => self.buildThreadContext(...args),
        persistedUsageLedger: (sessionId, count) => self.persistedUsageLedger(sessionId, count ?? 0),
        markHiddenChildSession: (...args) => self.markHiddenChildSession(...args),
        noteChildStarted: (...args) => self.noteChildStarted(...args),
        closeChildRelays: (...args) => self.closeChildRelays(...args),
        postRunningChildren: () => self.postRunningChildren(),
        teardownEmptySession: (...args) => self.teardownEmptySession(...args),
        cancelSubagentsOf: (...args) => self.cancelSubagentsOf(...args),
        setStatus: (...args) => self.setStatus(...args),
        companionsList: (...args) => self.companionsList(...args),
      },
      uiOps: {
        emit: (...args) => self.emit(...args),
        postLocal: (...args) => self.postLocal(...args),
        postToSettingsEditor: (msg) => { void self.settingsEditor?.webview.postMessage(msg); },
        confirmInChat: (...args) => self.confirmInChat(...args),
        postSessionName: (...args) => self.postSessionName(...args),
        deleteSessionCache: (id) => { self.sessionCache.delete(id); },
      },
      providerOps: {
        usableProviders: () => self.usableProviders(),
        connectedProviders: () => self.connectedProviders(),
        subagentRoster: () => self.subagentRoster(),
        subagentsEnabledGlobally: () => self.subagentsEnabledGlobally(),
        companionSettingsView: () => self.companionSettingsView(),
        defaultWorkflowName: () => self.defaultWorkflowName(),
        companionsSetting: (key, fallback) => self.companionsSetting(key, fallback),
      },
      companionOps: {
        agentRoleSet: (...args) => self.agentRoleSet(...args),
        crewPresetSet: (...args) => self.crewPresetSet(...args),
        companionsRoot: (...args) => self.companionsRoot(...args),
        logAgentRun: (...args) => self.logAgentRun(...args),
      },
    });
  }

  private createTurnEdit(): TurnEdit {
    const self = this;
    return createTurnEdit({
      get host() { return self.host; },
      get state() { return self.state; },
      get context() { return self.context; },
      get checkpointStore() { return self.checkpointStore; },
      getOverride: (name: string) => self.sidebarTestOverride(name),
      getFocused: () => self.focused,
      setFocused: (session) => { self.focused = session; },
      getSessionCache: () => self.sessionCache,
      steerOps: {
        emit: (...args) => self.emit(...args),
        emitQueuedSends: (...args) => self.emitQueuedSends(...args),
        refreshImplicitChip: (...args) => self.refreshImplicitChip(...args),
        postChips: (...args) => self.postChips(...args),
        notifyUser: (...args) => self.notifyUser(...args),
        contextChipPayloads: (...args) => self.contextChipPayloads(...args),
        readImageChip: (...args) => self.readImageChip(...args),
        retainUploadedFilesForSession: (...args) => self.retainUploadedFilesForSession(...args),
        maybeFlushQueuedSends: (...args) => self.maybeFlushQueuedSends(...args),
      },
      rewindOps: {
        notifyUser: (...args) => self.notifyUser(...args),
        rewindFromClientCheckpoints: (...args) => self.rewindFromClientCheckpoints(...args),
        restoreComposerFor: (...args) => self.restoreComposerFor(...args),
        checkWorkspaceGitStatus,
        workspaceRoot: () => self.workspaceRoot(),
        confirmInChat: (...args) => self.confirmInChat(...args),
        truncateSessionCardsAfterRewind: (...args) => self.truncateSessionCardsAfterRewind(...args),
        applyRewindToView: (...args) => self.applyRewindToView(...args),
        sessionDisplayName: (...args) => self.sessionDisplayName(...args),
        sessionCwd: (...args) => self.sessionCwd(...args),
        openSession: (...args) => self.openSession(...args),
        rememberQueuedDraft: (...args) => self.rememberQueuedDraft(...args),
      },
      authLimitOps: {
        usableProviders: () => self.usableProviders(),
        emit: (...args) => self.emit(...args),
        post: (...args) => self.post(...args),
        rememberProjectProvider: (...args) => self.rememberProjectProvider(...args),
        sessionCwd: (...args) => self.sessionCwd(...args),
        startSession: (...args) => self.startSession(...args),
        handleSend: (...args) => self.handleSend(...args),
        setProviderNeedsLogin: (...args) => self.setProviderNeedsLogin(...args),
        startTurnGitBaseline: (...args) => self.startTurnGitBaseline(...args),
        setStatus: (...args) => self.setStatus(...args),
        emitAbandonedSend: (...args) => self.emitAbandonedSend(...args),
        turnEndFields: (...args) => self.turnEndFields(...args),
        noteLiveTurnEnded: (...args) => self.noteLiveTurnEnded(...args),
        maybeGenerateTitle: (...args) => self.maybeGenerateTitle(...args),
        postSessionName: (...args) => self.postSessionName(...args),
        surfaceLimitError: (...args) => self.surfaceLimitError(...args),
        onboardingForSession: (...args) => self.onboardingForSession(...args),
      },
      feedbackOps: {
        ackTurnFeedback: (...args) => self.ackTurnFeedback(...args),
        latchFeedbackUnavailable: (...args) => self.latchFeedbackUnavailable(...args),
        thumbsFeedbackEnabled: () => self.thumbsFeedbackEnabled(),
        notifyUser: (...args) => self.notifyUser(...args),
        contextExtensionVersion: () => self.context.extensionVersion,
        canSwitchWorkspaceFolder: () => self.host.canSwitchWorkspaceFolder,
      },
    });
  }

  private createReviewHost(): ReviewHost {
    const self = this;
    return new ReviewHost({
      get diffSeq() { return self.diffSeq; },
      set diffSeq(value) { self.diffSeq = value; },
      get diffProvider() { return self.diffProvider; },
      get openDiffsByRequest() { return self.openDiffsByRequest; },
      get host() { return self.host; },
      sessionCwd: (...args) => self.sessionCwd(...args),
      emit: (...args) => self.emit(...args),
      get checkpointStore() { return self.checkpointStore; },
      confirmInChat: (...args) => self.confirmInChat(...args),
      createPlanReviewSnapshot: (...args) => self.createPlanReviewSnapshot(...args),
      syncHumanWait: (...args) => self.syncHumanWait(...args),
      setStatus: (...args) => self.setStatus(...args),
      get turnGitBaselines() { return self.turnGitBaselines; },
      get gitRunGate() { return self.gitRunGate; },
      notifyUser: (...args) => self.notifyUser(...args),
      truncateSessionCardsAfterRewind: (...args) => self.truncateSessionCardsAfterRewind(...args),
      applyRewindToView: (...args) => self.applyRewindToView(...args),
      restoreComposerFor: (...args) => self.restoreComposerFor(...args)
    });
  }

  private createQuestionHost(): QuestionHost {
    const self = this;
    return new QuestionHost({
      get host() { return self.host; },
      emit: (...args) => self.emit(...args),
      setStatus: (...args) => self.setStatus(...args),
      get hostPipeMux() { return self.hostPipeMux; },
      set hostPipeMux(value) { self.hostPipeMux = value; },
      get askUserChannel() { return self.askUserChannel; },
      set askUserChannel(value) { self.askUserChannel = value; },
      get context() { return self.context; },
      get pool() { return self.pool; },
      reservedMcpIdentityFor: (...args) => self.reservedMcpIdentityFor(...args),
      touch: (...args) => self.touch(...args)
    });
  }

  private createWebviewHtml(): WebviewHtml {
    const self = this;
    return new WebviewHtml({
      get context() { return self.context; },
      get host() { return self.host; },
      appPurpose: () => self.appPurpose(),
      chatFontScale: () => self.chatFontScale(),
      voiceBackendState: (cwd, provider) => self.voiceBackendState(cwd, provider),
      sessionCwd: (session) => self.sessionCwd(session),
      get focused() { return self.focused; },
      voiceSetting: (cwd, key, fallback) => self.voiceSetting(cwd, key, fallback),
      providerStateMessage: () => self.providerStateMessage(),
      get providerRefreshInFlight() { return self.providerRefreshInFlight; },
      githubStatePayload: () => self.githubStatePayload(),
      get providerCliVersions() { return self.providerCliVersions; },
      get mcpServersView() { return self.mcpServersView; },
      mcpConnectorsMessage: () => self.mcpConnectorsMessage(),
      showThinking: () => self.showThinking()
    });
  }

  private createWorktreeHost(): WorktreeHost {
    const self = this;
    return new WorktreeHost({
      get host() { return self.host; },
      get focused() { return self.focused; },
      set focused(value) { self.focused = value; },
      get pool() { return self.pool; },
      get state() { return self.state; },
      get sessionCache() { return self.sessionCache; },
      workspaceRoot: () => self.workspaceRoot(),
      sessionCwd: (...args) => self.sessionCwd(...args),
      historyCwdFor: () => self.historyCwdFor(),
      openWorkspaceFolders: () => self.openWorkspaceFolders(),
      resolveLocalRepoTarget: (...args) => self.resolveLocalRepoTarget(...args),
      newLocalSession: (...args) => self.newLocalSession(...args),
      parkFocused: () => self.parkFocused(),
      startSession: (...args) => self.startSession(...args),
      postSessionsList: () => self.postSessionsList(),
      removeSessionFromDisk: (...args) => self.removeSessionFromDisk(...args),
      confirmInChat: (...args) => self.confirmInChat(...args),
      detachClient: (...args) => self.detachClient(...args)
    });
  }

  private sidebarTestOverride(name: string): any {
    const descriptor = Object.getOwnPropertyDescriptor(this, name);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const override = descriptor.value;
    // Some host tests explicitly assign the prototype method to a stubbed
    // sidebar in order to request its production implementation. Once the
    // method is a thin collaborator wrapper, treating that same function as
    // an override would route back into the collaborator recursively.
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(GrokSidebar.prototype, name);
    if (prototypeDescriptor && "value" in prototypeDescriptor && override === prototypeDescriptor.value) return undefined;
    return typeof override === "function" ? override.bind(this) : override;
  }

  private createProviderSetup(): ProviderSetup {
    const self = this;
    return new ProviderSetup({
      get host() { return self.host; },
      get context() { return self.context; },
      get state() { return self.state; },
      get providerCliVersions() { return self.providerCliVersions; },
      workspaceRoot: () => self.workspaceRoot(),
      post: (msg) => self.post(msg),
      postLocal: (msg) => self.postLocal(msg),
      postToSettingsEditor: (msg) => { void self.settingsEditor?.webview.postMessage(msg); },
      cacheProviderModels: (...args) => self.cacheProviderModels(...args),
      probeProviderVersion: (...args) => self.probeProviderVersion(...args),
      invalidateSubscriptionUsage: (...args) => self.invalidateSubscriptionUsage(...args),
      rearmAuthRecovery: (provider) => {
        const rearm = (session: Session | undefined) => {
          if (session?.provider === provider) session.authRecoveryTried = false;
        };
        rearm(self.focused);
        for (const session of self.pool ?? []) rearm(session);
      },
      refreshGithubState: () => self.refreshGithubState(),
      buildEnv: (...args) => self.buildEnv(...args),
      removeSessionFromDisk: (...args) => self.removeSessionFromDisk(...args),
      getOverride: (name: string) => self.sidebarTestOverride(name)
    });
  }

  private createWorkflowStageRunner(): WorkflowStageRunner {
    const self = this;
    return new WorkflowStageRunner({
      get host() { return self.host; },
      get context() { return self.context; },
      get state() { return self.state; },
      get agentRuns() { return self.agentRuns; },
      get checkpointStore() { return self.checkpointStore; },
      get worktreeHost() { return self.worktreeHost; },
      get providerSetup() { return self.providerSetup; },
      get pool() { return self.pool; },
      get focused() { return self.focused; },
      sessionCwd: (session?: Session) => self.sessionCwd(session),
      emit: (session: Session, msg: HostMsg) => self.emit(session, msg),
      agentNotice: (session: Session, level: "info" | "warning" | "error", text: string) => self.agentNotice(session, level === "error" ? "warning" : level, text),
      confirmInChat: (session: Session, opts: any) => self.confirmInChat(session, opts),
      showQuestion: (session: Session, question: any, handlers: any) => self.showQuestion(session, question, handlers),
      newFocusedSession: async () => {
        await self.newFocusedSession();
        return self.focused;
      },
      setStatus: (session: Session, status: Session["status"]) => self.setStatus(session, status),
      runAgentRole: (...args) => self.runAgentRole(...args),
      resolveRoleProvider: (...args) => self.resolveRoleProvider(...args),
      agentRoleSet: (cwd: string) => self.agentRoleSet(cwd),
      crewPresetSet: (cwd: string) => self.crewPresetSet(cwd),
      crewEligibilityInput: (session: Session) => self.crewEligibilityInput(session),
      steerSend: (text: string, session: Session) => self.steerSend(text, session),
      emitReviewCenter: (session: Session) => self.emitReviewCenter(session),
      persistSessionType: (session: Session) => self.persistSessionType(session),
      childWaitsForYou: (child: Session | undefined) => self.childWaitsForYou(child),
      getOverride: (name: string) => self.sidebarTestOverride(name)
    });
  }

  constructor(
    private context: HostContext,
    /** Effectful host surface — VS Code supplies createVsCodeHost; a desktop app injects its own. */
    private readonly host: Host,
  ) {
    this._reviewHost = this.createReviewHost();
    this._questionHost = this.createQuestionHost();
    this._webviewHtml = this.createWebviewHtml();
    this._worktreeHost = this.createWorktreeHost();
    this._providerSetup = this.createProviderSetup();
    this._workflowStageRunner = this.createWorkflowStageRunner();
    // Before anything can read it: the loss case is an empty read followed by a
    // write, so this must not be deferred to an async init.
    this.state = new PersistedState(
      context.globalState,
      path.join(resolveGrokHome(process.env), "client-state"),
      fs,
      (line) => this.host.appendLine(line),
    );
    this._providerSession = this.createProviderSession();
    this._voiceAndMcp = this.createVoiceAndMcp();
    this._projectFolders = this.createProjectFolders();
    this._cliUpdateHost = this.createCliUpdateHost();
    this.providerConnectionState = this.migrateProviderConnections();
    this.focused.provider = this.defaultProviderForProject(this.workspaceRoot());
    context.subscriptions.push(
      this.host.registerTextDocumentContentProvider(GROK_DIFF_SCHEME, this.diffProvider),
    );
    // Apply the terminal-shell preference at construction, BEFORE any command
    // (e.g. grok.newSession) can spawn a session — otherwise the first
    // resolvedTerminalShell() (for GROK_SHELL in buildEnv) could cache the
    // default "auto" resolution and diverge from a configured `cmd` pref.
    this.applyTerminalShellPref();
    this.mcpConnectorKeysReady = this.loadMcpConnectorKeys();
    this.routineRuns = new RoutineRunStore({
      dir: `${path.join(resolveGrokHome(process.env), "client-state").replace(/\\/g, "/")}/routine-runs`,
      fs,
      log: (line) => this.host.appendLine(line)
    });
    this._routineScheduler = this.createRoutineScheduler();
    this.checkpointStore = new CheckpointStore({
      root: path.join(this.context.globalStorageUri.fsPath, "checkpoints"),
      fs: nodeCheckpointFs(fs),
      log: (line) => this.host.appendLine(line)
    });
    this.agentRuns = new AgentRunStore({
      root: path.join(this.context.globalStorageUri.fsPath, "runs"),
      fs: {
        mkdirSync: (dir, options) => { fs.mkdirSync(dir, options); },
        writeFileSync: (file, data) => fs.writeFileSync(file, data, "utf8"),
        appendFileSync: (file, data) => fs.appendFileSync(file, data, "utf8"),
        existsSync: (target) => fs.existsSync(target),
        rmSync: (target, options) => fs.rmSync(target, options)
      },
      join: (...parts) => path.join(...parts)
    });
    void this.sweepImageStaging();
    void this.sweepFileStaging();
    this.startRoutineScheduler();
    this.startWorkflowCompletionPolling();
  }

  /* ------------------------------------------------------------ routines */

  /**
   * A record map keyed by id, NOT an array — twice over.
   *
   * `PersistedState.validValue` accepts a string or a record map and nothing
   * else, so an array is rejected on load AND on the globalState shadow read:
   * every routine would vanish on the next restart. And the write path is a
   * three-way `mergeRecord` against the disk snapshot, which is what lets two
   * hosts each add a routine without clobbering each other. An array would have
   * broken that too, silently, and only for people running two editors.
   */
  private loadRoutines(): Routine[] {
    return this.routineScheduler.loadRoutines();
  }

  private async saveRoutines(routines: readonly Routine[]): Promise<void> {
    return this.routineScheduler.saveRoutines(routines);
  }

  private startRoutineScheduler(): void {
    this.routineScheduler.startRoutineScheduler();
  }

  private async tickRoutines(): Promise<void> {
    return this.routineScheduler.tickRoutines();
  }

  private async runRoutine(routine: Routine, windowKey: string, startedAt: number): Promise<void> {
    return this.routineScheduler.runRoutine(routine, windowKey, startedAt);
  }

  /* --------------------------------------------------------------- /agent */

  /**
   * Role files for this project, folded over the five built-ins (AP-10).
   *
   * Read fresh on every `/agent`, deliberately: role files are edited in the
   * same window that runs them, and a cache would hand the user yesterday's
   * definition of a role they just fixed. There are at most a handful of small
   * files, so the read is cheaper than the surprise.
   */
  private agentRoleSet(cwd: string): AgentRoleSet {
    return loadAgentRoles([
      ...this.readCompanionFiles(this.companionsRoot("global"), AGENT_ROLES_DIR, "global", "agent"),
      ...this.readCompanionFiles(this.companionsRoot("project", cwd), AGENT_ROLES_DIR, "project", "agent"),
    ]);
  }

  /**
   * Where one scope's `.companions/` lives.
   *
   * `global` is this MACHINE's set (`~/.companions`), so a role you rely on
   * everywhere does not have to be copied into every repo; `project` is the
   * open project's own, which stays the versionable, shareable, reviewable
   * thing decision 18.1 asks for. Returns empty when there is no project, and
   * every caller treats that as "this scope contributes nothing" rather than
   * reaching for a default that would put files somewhere surprising.
   */
  private companionsRoot(scope: RoleScope, cwd?: string): string {
    if (scope === "global") return path.join(this.resolvedUserHome(), ".companions");
    const project = (cwd ?? "").trim();
    return project ? path.join(project, ".companions") : "";
  }

  /**
   * Read one `.companions/<kind>/*.md` directory into parser input.
   *
   * A missing directory is the normal case, not an error — the built-ins are
   * the whole point of shipping five of them — but a directory that exists and
   * cannot be READ is logged, because that one is a real problem wearing the
   * same shape as the ordinary one.
   */
  private readCompanionFiles(
    root: string,
    relDir: string,
    scope: RoleScope,
    tag: "agent" | "crew",
  ): { path: string; stem: string; text: string; scope: RoleScope }[] {
    if (!root) return [];
    const dir = path.join(root, path.basename(relDir));
    const files: { path: string; stem: string; text: string; scope: RoleScope }[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".md")).sort();
    } catch {
      return [];
    }
    const prefix = scope === "global" ? `~/${relDir}` : relDir;
    for (const name of names) {
      try {
        files.push({
          path: `${prefix}/${name}`,
          stem: name.replace(/\.md$/i, ""),
          text: fs.readFileSync(path.join(dir, name), "utf8"),
          scope
        });
      } catch (error) {
        this.host.appendLine(`[${tag}] could not read ${prefix}/${name}: ${(error as Error).message}`);
      }
    }
    return files;
  }

  /**
   * Which provider actually answers for this role.
   *
   * A role read from a FILE names its provider on purpose, and swapping that
   * silently would defeat the point of a `reviewer` pinned to a second
   * opinion. So a project role whose provider is not usable is an error the
   * user is told about, not a substitution.
   *
   * A BUILT-IN role is the opposite case: its `provider` is a placeholder
   * (agent-roles.ts says so), because a shipped default cannot know which
   * accounts exist on this machine. It falls back to the calling session's
   * provider so `/agent` works on the first run of a fresh install — except
   * where the role declares `preferDifferentProvider`, which steers it AWAY
   * from the caller. Without that, the shipped `reviewer` defaults to the same
   * companion that just did the work: the weakest grade of review in §5.10,
   * wearing the label of the strongest. With only one companion connected it
   * still runs — a fresh session holding only the briefing IS a real review —
   * and `runAgentRole` puts a caution on the card so nobody reads it as an
   * outside opinion.
   */
  private resolveRoleProvider(role: AgentRole, caller: Session): { provider: AcpProvider } | { error: string } {
    return this.agentAuthoring.resolveRoleProvider(role, caller);
  }

  /** Post a plain line into the calling thread and log it. */
  private agentNotice(session: Session, level: "info" | "warning", text: string): void {
    return this.agentAuthoring.agentNotice(session, level, text);
  }

  /**
   * `/subagents` — live roster and injection diagnose (AP-16).
   *
   * Host-answered; never a billed prompt. Reads the flag stamped at
   * `session/new`, not the settings the user may have flipped since.
   */
  private handleSubagentsCommand(text: string, session: Session): void {
    this.emit(session, { type: "userMessage", text, chips: [] });
    const turnId = this.currentTurnId(session);
    const eligibility = this.eligibilityInput(session, turnId);
    const geminiRoster = eligibility.roster.gemini;
    const geminiSpawn = resolveTarget({ provider: "gemini", profile: "read-only" }, eligibility);
    const hostMcp = providerCapability(session.provider, "hostMcp");
    const report = formatSubagentDiagnosis({
      sessionType: session.sessionType ?? "agent",
      subagentsEnabled: this.subagentsCouldBeUsedIn(session),
      mcpInjected: session.companionsMcpInjected === true,
      ...(session.companionsSkipReason ? { skipReason: session.companionsSkipReason } : {}),
      parentProvider: session.provider,
      parentHostMcp: hostMcp.state,
      geminiUsable: this.usableProviders().includes("gemini"),
      geminiRosterEnabled: geminiRoster?.enabled !== false,
      geminiSpawn: geminiSpawn.ok
        ? { ok: true, ...(geminiSpawn.target.model ? { model: geminiSpawn.target.model } : {}) }
        : { ok: false, code: geminiSpawn.code, message: geminiSpawn.message },
      limits: {
        running: eligibility.limits.running,
        maxConcurrent: eligibility.limits.maxConcurrent,
        thisTurn: eligibility.limits.thisTurn,
        maxPerTurn: eligibility.limits.maxPerTurn
      }
    });
    this.host.appendLine(`[companions] /subagents\n${report}`);
    this.emit(session, { type: "hostNotice", level: "info", text: report });
  }

  /**
   * `/agent <name> <task>` — commission one named role (AP-10, crew stage 1).
   *
   * Host-answered end to end; the text never reaches a CLI as a prompt (see
   * `HOST_SLASH_COMMANDS`). The role runs in its OWN session — that is the
   * mechanism, not an implementation detail: a fresh session holding nothing
   * but a briefing is what stretches the context, and it is also what makes a
   * second opinion worth having.
   *
   * Returns true when the message was consumed here, so the caller must not
   * fall through to an ordinary send.
   */
  private async handleAgentCommand(text: string, session: Session): Promise<boolean> {
    return this.agentAuthoring.handleAgentCommand(text, session);
  }

  /**
   * Start the role session, brief it, and turn its reply into a card.
   *
   * Everything the role does — permission cards, diffs, checkpoints, usage —
   * runs through the ordinary machinery of a session. Nothing here bypasses a
   * grant; a role's edit is reviewed exactly like a hand-typed one.
   */
  private async runAgentRole(
    role: AgentRole,
    brief: BriefingInput,
    trigger: AgentRunTrigger,
    caller: Session,
    coords?: {
      runId: string;
      step: number;
      cwd?: string;
      live?: boolean;
      /**
       * AP-16. Set when this run is a companion subagent rather than an
       * `/agent` role or a crew step. It changes three things and nothing else:
       * the caller's turn state is NOT taken over (several subagents run at
       * once, and the parent keeps working), the `/agent` result card is not
       * emitted (a `companionSubagent` card is, keyed by this id), and the
       * child session is stamped hidden before its first turn.
       */
      subagent?: { subagentId: string; label: string; profile: string };
      /**
       * AP-17. A crew-stage child. Same hidden-session treatment as a
       * subagent, writes `stage-NN` artefacts, and does not emit an
       * `/agent` result card — the gate card is the one card for the stage.
       */
      /** AP-17. `allowSubagents` is the workflow's half of the §7.9 gate.
       *  `scope` (C-01): edits outside these globs are flagged on the card. */
      stage?: { stageId: string; allowSubagents?: boolean; scope?: string[]; subStep?: boolean };
      /**
       * AP-18. The workflow generator: hidden, read-only, no `/agent` card,
       * and it does not take over the caller's `agentRun` slot.
       */
      generator?: { requestId: string };
      /**
       * C-07 / C-08 / S-04. Send `continueMessage` as ANOTHER turn into this
       * existing role session instead of starting a fresh one — the context
       * stays, which is cheaper than a new brief. Only while the session is
       * still live in the pool; otherwise a fresh session is started.
       */
      continueSession?: Session;
      continueMessage?: string;
    },
  ): Promise<{
    outcome: "completed" | "failed" | "cancelled";
    filesReported: string[];
    filesObserved: string[];
    costUsdTicks?: number;
    totalTokens?: number;
    durationMs: number;
    sessionId?: string;
    detail?: string;
    summary: string;
    planEntries: import("./plan-entries").PlanEntry[];
    /** AP-16: the host's own file evidence, for the subagent card and result. */
    reconciliation?: FileReconciliation;
    /** AP-16: the parsed result, so the tool payload does not re-parse. */
    parsed?: AgentResult;
    /** AP-16: the child's whole reply, for `await` with `action: "read"`. */
    rawReply?: string;
  }> {
    return this.agentAuthoring.runAgentRole(role, brief, trigger, caller, coords);
  }

  /** Name a role session before its turn, for the reason routines do the same:
   *  an interrupted run still leaves a row, and an untitled one is the hardest
   *  to account for afterwards. */
  private nameAgentRoleSession(roleSession: Session, role: AgentRole, runId: string, step: number): void {
    return this.agentAuthoring.nameAgentRoleSession(roleSession, role, runId, step);
  }

  /** A role session that produced nothing is removed outright — the same path
   *  as an abandoned empty "New session" (see {@link teardownEmptySession}). */
  private discardAgentRoleSession(roleSession: Session): void {
    return this.agentAuthoring.discardAgentRoleSession(roleSession);
  }

  /** Stop the running role, if any. Returns true when there was one. */
  private cancelAgentRun(caller: Session): boolean {
    return this.agentAuthoring.cancelAgentRun(caller);
  }

  private emitCrewRun(session: Session): void {
    this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
  }

  // ---------------------------------------------------------------- AP-17 --
  // Crew-session workflow runs. The pure state machine is `workflow-run.ts`;
  // this is the glue: persistence, `runAgentRole` with `coords.stage`, the
  // gate's target picker, and the D8 `/crew` intercept.

  get workflowState(): { store: WorkflowRunStore; packets: Map<string, HandoffPacket>; defs: Map<string, WorkflowDefinition> } | undefined {
    return this.workflowStageRunner.workflowState;
  }
  set workflowState(v) {
    this.workflowStageRunner.workflowState = v;
  }

  private workflowStore(): NonNullable<GrokSidebar["workflowState"]> {
    return this.workflowStageRunner.workflowStore();
  }

  private workflowRuns(): WorkflowRunStore { return this.workflowStageRunner.workflowRuns(); }

  private get generatorState(): AgentAuthoring["generatorState"] { return this.agentAuthoring.generatorState; }
  private set generatorState(value: AgentAuthoring["generatorState"]) { this.agentAuthoring.generatorState = value; }

  private generatorStore(): NonNullable<GrokSidebar["generatorState"]> {
    return this.agentAuthoring.generatorStore();
  }

  private postWorkflowGenerator(view: import("./protocol").WorkflowGeneratorView): void {
    return this.agentAuthoring.postWorkflowGenerator(view);
  }

  private handleGeneratorTool(session: Session, call: CompanionsCall): void {
    return this.agentAuthoring.handleGeneratorTool(session, call);
  }

  get fileClaims(): FileClaimStore | undefined {
    return (this.workflowStageRunner as any).fileClaims;
  }
  set fileClaims(v: FileClaimStore | undefined) {
    (this.workflowStageRunner as any).fileClaims = v;
  }

  private inThreadCrewCommand(): boolean {
    return this.workflowStageRunner.inThreadCrewCommand();
  }

  private defaultWorkflowName(): string {
    return this.workflowStageRunner.defaultWorkflowName();
  }

  private autoStartNextStage(): boolean {
    return this.workflowStageRunner.autoStartNextStage();
  }

  private maxFixerPasses(): number {
    return this.workflowStageRunner.maxFixerPasses();
  }

  private resolveWorkflow(session: Session, name?: string): WorkflowDefinition {
    return this.workflowStageRunner.resolveWorkflow(session, name);
  }

  private postWorkflowList(session: Session, preferred?: string): void {
    this.workflowStageRunner.postWorkflowList(session, preferred);
  }

  private emitWorkflowRun(session: Session, extra?: { staleDetails?: string[]; missing?: string[] }): void {
    this.workflowStageRunner.emitWorkflowRun(session, extra);
  }

  private workflowAutonomy(run: WorkflowRun): Autonomy {
    return this.workflowStageRunner.workflowAutonomy(run);
  }

  private workflowReportPath(runId: string): string | undefined {
    return this.workflowStageRunner.workflowReportPath(runId);
  }

  private lineupForRun(session: Session, run: WorkflowRun | undefined, def: WorkflowDefinition): WorkflowLineupView[] {
    return this.workflowStageRunner.lineupForRun(session, run, def);
  }

  private rememberedLineup(cwd: string, workflow: string): Record<string, RunLineupEntry> | undefined {
    return this.workflowStageRunner.rememberedLineup(cwd, workflow);
  }

  private async rememberLineup(cwd: string, workflow: string, lineup: Record<string, RunLineupEntry>): Promise<void> {
    return this.workflowStageRunner.rememberLineup(cwd, workflow, lineup);
  }

  private verifySuggestions(cwd: string): string[] {
    return this.workflowStageRunner.verifySuggestions(cwd);
  }

  private withGatePreselection(session: Session, run: WorkflowRun, def: WorkflowDefinition): WorkflowRun {
    return this.workflowStageRunner.withGatePreselection(session, run, def);
  }

  private nextStageScope(run: WorkflowRun, def: WorkflowDefinition): { globs: string[]; note?: string } | undefined {
    return this.workflowStageRunner.nextStageScope(run, def);
  }

  private persistWorkflowRun(session: Session): void {
    this.workflowStageRunner.persistWorkflowRun(session);
  }

  private crewEligibilityInput(session: Session): EligibilityInput {
    return this.workflowStageRunner.crewEligibilityInput(session);
  }

  private async restoreWorkflowRun(session: Session, runId: string): Promise<void> {
    return this.workflowStageRunner.restoreWorkflowRun(session, runId);
  }

  private loadWorkflowPackets(run: WorkflowRun): string[] {
    return this.workflowStageRunner.loadWorkflowPackets(run);
  }

  private async currentWorkspaceStamp(run: WorkflowRun): Promise<{
    gitHead?: string;
    observedHash?: string;
    worktreeExists?: boolean;
    worktree?: string;
  }> {
    return this.workflowStageRunner.currentWorkspaceStamp(run);
  }

  private async startWorkflowRun(
    session: Session,
    idea: string,
    workflowName: string,
    options?: any,
  ): Promise<void> {
    return this.workflowStageRunner.startWorkflowRun(session, idea, workflowName, options);
  }

  private async openNewCrewSession(
    idea: string,
    workflowName: string,
    options?: any,
  ): Promise<void> {
    return this.workflowStageRunner.openNewCrewSession(idea, workflowName, options);
  }

  private applyWorkflowPlanEdit(
    session: Session,
    edit: any,
  ): void {
    this.workflowStageRunner.applyWorkflowPlanEdit(session, edit);
  }

  private async handleHostGateAction(
    session: Session,
    action: any,
  ): Promise<boolean> {
    return this.workflowStageRunner.handleHostGateAction(session, action);
  }

  private gateActionFromMsg(
    msg: any,
  ): any {
    return this.workflowStageRunner.gateActionFromMsg(msg);
  }

  private async handleWorkflowGateAction(
    session: Session,
    action: any,
  ): Promise<void> {
    return this.workflowStageRunner.handleWorkflowGateAction(session, action);
  }

  private async createCrewWorktree(
    sourcePath: string,
    label: string,
  ): Promise<{ path: string; label: string; sourceGitRoot: string } | { error: string }> {
    return this.workflowStageRunner.createCrewWorktree(sourcePath, label);
  }

  private async applyCrewWorktree(
    session: Session,
    wt: { path: string; label: string; sourceGitRoot: string },
  ): Promise<void> {
    return this.workflowStageRunner.applyCrewWorktree(session, wt);
  }

  private finishWorkflowRun(session: Session, def: WorkflowDefinition): void {
    this.workflowStageRunner.finishWorkflowRun(session, def);
  }

  private writeWorkflowReport(session: Session, def: WorkflowDefinition): string | undefined {
    return this.workflowStageRunner.writeWorkflowReport(session, def);
  }

  private poolSessionById(sessionId: string | undefined): Session | undefined {
    return this.workflowStageRunner.poolSessionById(sessionId);
  }

  private async finishWorkflowStage(session: Session, def: WorkflowDefinition, packet: HandoffPacket): Promise<void> {
    return this.workflowStageRunner.finishWorkflowStage(session, def, packet);
  }

  private planStepsFor(run: WorkflowRun): HandoffPlanStep[] {
    return this.workflowStageRunner.planStepsFor(run);
  }

  private packetMap(runId: string): Map<string, HandoffPacket> {
    return this.workflowStageRunner.packetMap(runId);
  }

  private packetsFor(runId: string): HandoffPacket[] {
    return this.workflowStageRunner.packetsFor(runId);
  }

  private async revertWorkflowRun(session: Session): Promise<void> {
    return this.workflowStageRunner.revertWorkflowRun(session);
  }

  private async revertWorkflowStage(session: Session, def: WorkflowDefinition, ordinal: number): Promise<void> {
    return this.workflowStageRunner.revertWorkflowStage(session, def, ordinal);
  }

  private async handleCrewSessionInput(text: string, session: Session): Promise<void> {
    return this.workflowStageRunner.handleCrewSessionInput(text, session);
  }

  private crewPresetSet(cwd: string): CrewPresetSet {
    return loadCrewPresets([
      ...this.readCompanionFiles(this.companionsRoot("global"), CREW_PRESETS_DIR, "global", "crew"),
      ...this.readCompanionFiles(this.companionsRoot("project", cwd), CREW_PRESETS_DIR, "project", "crew"),
    ]);
  }

  private async executeWorkflowStage(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    targetHint?: any,
    opts?: any,
  ): Promise<void> {
    return this.workflowStageRunner.executeWorkflowStage(session, def, run, targetHint, opts);
  }

  private async handleCrewCommand(text: string, session: Session): Promise<boolean> {
    return this.workflowStageRunner.handleCrewCommand(text, session);
  }

  private async runCrewVerify(command: string, cwd: string): Promise<{ code: number; output: string }> {
    return this.workflowStageRunner.runCrewVerify(command, cwd);
  }

  private uniqueCrewPaths(paths: readonly string[]): string[] {
    return this.workflowStageRunner.uniqueCrewPaths(paths);
  }

  private crewUnreapableCount(): number {
    return this.workflowStageRunner.crewUnreapableCount();
  }

  private crewFileClaims(): FileClaimStore {
    return this.workflowStageRunner.crewFileClaims();
  }

  private logAgentRun(entry: Parameters<AgentRunStore["appendLog"]>[0]): void {
    try {
      this.agentRuns.appendLog(entry);
    } catch (error) {
      // The log is the account of the run, not the run.
      this.host.appendLine(`[agent] could not append to the run log: ${(error as Error).message}`);
    }
  }

  // ---------- handoff and second opinion (AP-11) ----------
  //
  // The same run machinery as `/agent`, reached with a task nobody typed.
  // Everything specific to that lives in these four methods: what the host is
  // allowed to look at (buildThreadContext), what it makes of it
  // (deriveBriefing, pure, in handoff.ts), whether to ask first, and the two
  // entry points. The run itself is unchanged, deliberately — abort, cleanup,
  // reconciliation, cost and card were all solved once in AP-10.

  /**
   * The last thing the USER said in this conversation, and nothing else.
   *
   * A backwards walk that stops at the first hit. That bound is the feature,
   * not an optimisation: the briefing exists so a fresh session does NOT
   * inherit a transcript (§5.4), and one user message is the smallest thing
   * that still carries the goal in the words the user chose. "While we are
   * here, take the last three" is how that guarantee gets lost, so the shape
   * of this function refuses to make it easy.
   */
  private lastUserMessageText(session: Session): string {
    for (let i = session.buffer.length - 1; i >= 0; i -= 1) {
      const msg = session.buffer[i];
      if (msg.type === "userMessage") return String(msg.text ?? "").trim();
    }
    return "";
  }

  /** `Claude · claude-opus-5` — who did the work being handed over. The model
   *  half is omitted rather than guessed when no client is live. */
  private sessionRunLabel(session: Session): string {
    const model = session.client?.currentModelId;
    return model
      ? `${providerDisplayName(session.provider)} · ${model}`
      : providerDisplayName(session.provider);
  }

  /**
   * Everything the derivation may see, and nothing more.
   *
   * Assembled here rather than inside handoff.ts so that module stays pure —
   * and so the list of what the host is willing to hand over is one readable
   * object instead of a set of reaches into a live Session.
   */
  private buildThreadContext(session: Session, kind: HandoffKind): ThreadContext {
    // Turn scope for a second opinion (judge what just happened), session
    // scope for a handoff (the successor inherits all of it).
    const files = reviewCenterSnapshot(session.reviewBlocks, String(session.userMessageCount));
    const scoped = filesForScope(files, kind === "second-opinion" ? "turn" : "session");
    // `sawPlanEntries` is positive evidence only. It resolves `gemini`, which
    // is one provider id over two CLIs that differ here — and leaves it a
    // probe when nothing has arrived, because "has not planned yet" and
    // "cannot report a plan" are different sentences in the briefing.
    const cap = providerCapability(session.provider, "structuredPlan", {
      sawPlanEntries: session.planEntries.length > 0
    });
    return {
      kind,
      lastUserText: this.lastUserMessageText(session),
      planEntries: session.planEntries,
      structuredPlan: cap.state === "yes" ? "yes" : cap.state === "no" ? "no" : "unknown",
      changedFiles: scoped.map((file) => file.path),
      chipPaths: session.chips.filter((chip) => !chip.hidden && chip.relPath).map((chip) => chip.relPath),
      callerLabel: this.sessionRunLabel(session)
    };
  }

  /**
   * Commission a role from the thread (AP-11).
   *
   * `confirm` is true for the BUTTON path only. A button names neither the
   * role nor the task — the host chose both — so it shows what it decided
   * before spending anything. A typed `/handoff reviewer` named the role and
   * asked for it, which is the same standing `/agent` has, and `/agent` does
   * not ask either.
   *
   * Decision §18.3: the confirmation carries **no cost or token figure**. The
   * only number about money in this whole path is the exact one on the result
   * card afterwards.
   */
  /**
   * The running role, re-read AFTER an await.
   *
   * Through a call rather than the property directly, because an earlier
   * `if (session.agentRun) return` narrows it to `undefined` for the rest of
   * the function — and that narrowing stops being true the moment control
   * yields to a dialog the user can sit on for a minute.
   */
  private runningRoleName(session: Session): string | undefined {
    return this.agentAuthoring.runningRoleName(session);
  }

  private async startHandoff(
    kind: HandoffKind,
    roleName: string | undefined,
    session: Session,
    confirm: boolean,
  ): Promise<void> {
    return this.agentAuthoring.startHandoff(kind, roleName, session, confirm);
  }

  /**
   * K-04: a nearly full conversation continues in a fresh session on the same
   * companion and model. The first message is derived like a handoff — goal,
   * open steps, changed files — never the transcript.
   */
  private async continueInFreshSession(session: Session): Promise<void> {
    return this.agentAuthoring.continueInFreshSession(session);
  }

  /**
   * `/handoff [role]` and `/second-opinion [role]` — the typed form (AP-11).
   *
   * Returns true when the message was consumed here, so the caller must not
   * fall through to an ordinary send.
   */
  private async handleHandoffCommand(text: string, session: Session): Promise<boolean> {
    return this.agentAuthoring.handleHandoffCommand(text, session);
  }

  /** Connected models, in the shape the Routines form needs. */
  private routineModelOptions(): RoutineModelOption[] {
    // `usableProviders`, not merely connected: a provider that cannot answer
    // must not be offerable, or a routine saves against a model that will skip
    // every time it fires.
    //
    // Ordered PROVIDER BY PROVIDER, each provider's "<X> default" row first and
    // its concrete models after. Emitting all the default rows and then all the
    // models put every provider in the list twice, and the client groups by
    // consecutive provider — so the picker showed six headings for three agents.
    //
    // The default row is always sent. Whether it is DISPLAYED is the client's
    // call: it is meaningless clutter beside real models (the composer does not
    // offer it either), but it must exist for a routine already saved with an
    // empty model, or editing one would silently re-point it.
    const cache = this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const providers = this.usableProviders();
    const all = modelsForConnectedProviders(providers, cache);
    const out: RoutineModelOption[] = [];
    for (const provider of providers) {
      out.push({ provider, model: "", label: `${providerDisplayName(provider)} default` });
      for (const m of all) {
        if (m.provider !== provider || !m.modelId) continue;
        out.push({ provider, model: m.modelId, label: m.name || m.modelId });
      }
    }
    return out;
  }

  private routineProjectOptions(): RoutineProjectOption[] {
    // Archived projects stay in this list on purpose. Archiving hides a project
    // from the RAIL; a routine is not the rail, and one already scheduled
    // against an archived project must keep running. `resolveLocalRepoTarget`
    // does not filter on `archived` either, so the run path agrees.
    return this.localRepoCatalogEntries().map((entry) => ({
      cwd: entry.cwd,
      label: entry.label,
      defaultProvider: this.defaultProviderForProject(entry.cwd),
      ...(entry.archived ? { archived: true } : {})
    }));
  }

  private buildRoutinesMessage(): Extract<HostMsg, { type: "routines" }> {
    const now = Date.now();
    const projects = this.routineProjectOptions();
    const byCwd = new Map(projects.map((p) => [normalizeRepoPath(p.cwd), p]));
    return {
      type: "routines",
      entries: this.loadRoutines().map((routine) =>
        toRoutineView(
          routine,
          this.routineRuns.list(routine.id),
          now,
          byCwd.get(normalizeRepoPath(routine.cwd)),
        ),
      ),
      projects,
      models: this.routineModelOptions(),
      ...(this.routineError
        ? { error: this.routineError.message, ...(this.routineError.id ? { errorId: this.routineError.id } : {}) }
        : {})
    };
  }

  /** Remote routines omit projects outside the host's current trusted set. */
  /* --------------------------------------- Settings → Agents & Crew (AP-10) */

  /** Last save/delete refusal, shown on the card that caused it. Cleared by
   *  the next successful write, exactly like `routineError`. */
  private get agentRolesError(): AgentAuthoring["agentRolesError"] { return this.agentAuthoring.agentRolesError; }
  private set agentRolesError(value: AgentAuthoring["agentRolesError"]) { this.agentAuthoring.agentRolesError = value; }

  /**
   * The whole Agents & Crew page: roles, flows, the companions a role may be
   * pointed at, and the parser's complaints about both file sets.
   *
   * Read fresh rather than cached, for the same reason `/agent` re-reads its
   * role files: they are edited in the window that runs them, and a cache
   * would hand the user yesterday's definition of a role they just fixed.
   */
  private buildAgentRolesMessage(): Extract<HostMsg, { type: "agentRoles" }> {
    return this.agentAuthoring.buildAgentRolesMessage();
  }

  /**
   * Which companion a BUILT-IN role would actually run on right now.
   *
   * Mirrors `resolveRoleProvider`'s built-in branch — including the steer away
   * from the calling companion for a role that wants a fresh pair of eyes —
   * without needing a session to commission it from. Falls back to the
   * placeholder when nothing is connected, because with no usable companion
   * there is no truer answer to give.
   */
  private effectiveRoleProvider(role: AgentRole): AcpProvider {
    return this.agentAuthoring.effectiveRoleProvider(role);
  }

  public companionsSetting<T>(key: string, fallback: T): T {
    try {
      return this.host.getConfiguration("companions").get<T>(key, fallback) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Local webview + the settings TAB, like `postRoutines`. Never crosses to a
   *  remote: the frame names `~/.companions` (OUTBOUND_DISPOSITION host-local). */
  /** The plan's new settings, as the settings page shows them (§9). */
  private companionSettingsView(): Record<string, string | number | boolean> {
    const grokSubagents = this.companionsSetting<string>("grok.subagents.enabled", "default");
    return {
      "grok.autoCompactThresholdPercent": this.grokCompactThresholdSetting(),
      "context.nearFullPrompt": this.companionsSetting<string>("context.nearFullPrompt", "ask"),
      "notifications.childNeedsYou": this.companionsSetting<boolean>("notifications.childNeedsYou", true) !== false,
      "crew.stallWarningSec": normalizeStallWarningSec(this.companionsSetting<number>("crew.stallWarningSec", 300)),
      "crew.onLimit": this.companionsSetting<string>("crew.onLimit", "ask"),
      "crew.defaultAutonomy": this.companionsSetting<string>("crew.defaultAutonomy", "step"),
      "subagents.writeIsolation": this.companionsSetting<string>("subagents.writeIsolation", "shared"),
      "grok.subagents.enabled": grokSubagents,
      "grok.subagents.maxConcurrent": Number(this.companionsSetting<number>("grok.subagents.maxConcurrent", 0)) || 0,
      bothDelegationsHint: bothDelegationsHint(grokSubagents !== "off", this.subagentsEnabledGlobally()) ?? ""
    };
  }

  /** The keys `setCompanionsSetting` may write, with their accepted values. */
  private static readonly COMPANION_SETTING_KEYS: Record<string, (v: unknown) => boolean> = {
    "grok.autoCompactThresholdPercent": (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99,
    "context.nearFullPrompt": (v) => v === "ask" || v === "off",
    "notifications.childNeedsYou": (v) => typeof v === "boolean",
    "crew.stallWarningSec": (v) => typeof v === "number" && Number.isInteger(v) && v >= 60,
    "crew.onLimit": (v) => v === "ask" || v === "switch",
    "crew.defaultAutonomy": (v) => v === "step" || v === "stop-on-problems" || v === "autopilot",
    "subagents.writeIsolation": (v) => v === "shared" || v === "worktree",
    "grok.subagents.enabled": (v) => v === "default" || v === "on" || v === "off",
    "grok.subagents.maxConcurrent": (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 16
  };

  private async setCompanionsSetting(key: string, value: unknown): Promise<void> {
    const check = GrokSidebar.COMPANION_SETTING_KEYS[key];
    const coerced = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (!check || !check(coerced)) {
      this.host.appendLine(`[settings] refused ${key}=${JSON.stringify(value)}`);
      return;
    }
    await this.host.getConfiguration("companions").update(key, coerced, "global");
    this.postAgentRoles();
  }

  private postAgentRoles(): void {
    return this.agentAuthoring.postAgentRoles();
  }

  /**
   * The directory one scope's files are written into.
   *
   * Returns undefined when the scope has no root — the only real case being
   * `project` with no folder open, where the honest answer is "there is
   * nowhere to put this", not a guess at a directory.
   *
   * Does NOT create anything: a refused draft must leave no trace, and an
   * empty `.companions/agents/` appearing in a repo after a validation error
   * is a change the user did not ask for. {@link companionsEnsureDir} is the
   * half that writes, called only once a draft is known to be good.
   */
  private companionsWriteDir(scope: RoleScope, kind: "agents" | "crews"): string | undefined {
    return this.agentAuthoring.companionsWriteDir(scope, kind);
  }

  /** Record a refusal against one card and repaint. The page keeps the draft,
   *  so the reason lands on the text that caused it rather than a blank form. */
  private refuseAgentRoles(id: string | undefined, message: string): void {
    return this.agentAuthoring.refuseAgentRoles(id, message);
  }

  /** Names already taken in one scope — what a save is checked against. A
   *  built-in name is NOT taken: writing it is how you override the built-in. */
  private agentRoleNamesInScope(scope: RoleScope, kind: "agents" | "crews"): string[] {
    return this.agentAuthoring.agentRoleNamesInScope(scope, kind);
  }

  /**
   * Remove the file a save has just superseded.
   *
   * Two cases, and missing either one makes a save look like it did nothing:
   * a RENAME (the old name would keep answering alongside the new one) and a
   * SCOPE MOVE (writing the global copy while the project file stays put
   * leaves the project file winning, so the edit appears discarded).
   */
  private dropSupersededCompanionFile(opts: {
    kind: "agents" | "crews";
    savedName: string;
    savedScope: RoleScope;
    originalName?: string;
    originalScope?: RoleScope;
  }): void {
    return this.agentAuthoring.dropSupersededCompanionFile(opts);
  }

  private async handleSaveAgentRole(
    msg: { scope: RoleScope; originalName?: string; originalScope?: RoleScope; draft: AgentRoleDraft },
  ): Promise<void> {
    return this.agentAuthoring.handleSaveAgentRole(msg);
  }

  private async handleSaveCrewFlow(
    msg: { scope: RoleScope; originalName?: string; originalScope?: RoleScope; draft: CrewFlowDraft },
  ): Promise<void> {
    return this.agentAuthoring.handleSaveCrewFlow(msg);
  }

  private workflowValidateContext(over: Partial<ValidateWorkflowContext> = {}): ValidateWorkflowContext {
    return this.agentAuthoring.workflowValidateContext(over);
  }

  private buildWorkflowViews(
    flowSet: CrewPresetSet,
    roleNames: string[],
  ): import("./protocol").WorkflowManagerView[] {
    return this.agentAuthoring.buildWorkflowViews(flowSet, roleNames);
  }

  private async handleSaveWorkflow(msg: {
    scope: RoleScope;
    originalName?: string;
    originalScope?: RoleScope;
    draft: WorkflowDraft;
    setDefault?: boolean;
  }): Promise<void> {
    return this.agentAuthoring.handleSaveWorkflow(msg);
  }

  private postWorkflowValidation(draft: WorkflowDraft): void {
    return this.agentAuthoring.postWorkflowValidation(draft);
  }

  private async handleAddWorkflowStagesBlock(scope: RoleScope, name: string): Promise<void> {
    return this.agentAuthoring.handleAddWorkflowStagesBlock(scope, name);
  }

  private async handleGenerateWorkflow(msg: {
    description: string;
    scope: RoleScope;
    reuseRoles?: boolean;
    newRoles?: "inline" | "files";
    allowWrite?: boolean;
    maxStages?: number;
    provider?: import("./acp-backend").AcpProvider;
    model?: string;
    effort?: string;
    refine?: string;
  }): Promise<void> {
    return this.agentAuthoring.handleGenerateWorkflow(msg);
  }

  private cancelWorkflowGenerate(): void {
    return this.agentAuthoring.cancelWorkflowGenerate();
  }

  /**
   * Delete one role or flow file.
   *
   * For a built-in NAME this is "reset to built-in": the file goes and the
   * shipped role comes back, which is why a missing file is a success rather
   * than an error — the end state the user asked for already holds.
   */
  private handleDeleteCompanionFile(scope: RoleScope, kind: "agents" | "crews", rawName: string): void {
    return this.agentAuthoring.handleDeleteCompanionFile(scope, kind, rawName);
  }

  private postRoutines(): void {
    const message = this.buildRoutinesMessage();
    this.postLocal(message);
    void this.settingsEditor?.webview.postMessage(message);
    // The routine count is one of the two facts the empty-state tip pool cannot
    // observe for itself, and it just changed. Posted from here rather than
    // from each of the seven call sites above, so the two can never disagree.
    this.postWelcomeTips();
  }

  /**
   * Facts for the empty-state tip pool: the two counts the chat client never
   * receives on its own, plus the tips this machine is finished with.
   *
   * Counts, deliberately — not the routines or the connector list. A tip only
   * asks whether the number is zero, and the chat client has no other reason to
   * hold either list (only the settings surface requests them). Sending the
   * lists here would put routine prompts on the wire for a client that never
   * asked for them.
   */
  private welcomeTipsMessage(): Extract<HostMsg, { type: "welcomeTips" }> {
    return {
      type: "welcomeTips",
      routineCount: this.loadRoutines().length,
      connectorCount: Object.keys(this.connectedConnectorStore()).length,
      dismissed: parseDismissedTips(this.state.get(WELCOME_TIPS_KEY, {})),
      shownToday: shownOn(this.state.get(WELCOME_TIPS_SHOWN_KEY, {}), localDayKey(new Date()))
    };
  }

  private postWelcomeTips(): void {
    this.post(this.welcomeTipsMessage());
  }

  /**
   * May a routine point at `cwd`? Any project in the catalog — archived
   * included, because the rail hiding a project is a view decision and a
   * routine is not the rail.
   */
  private mayTargetRoutineCwd(cwd: string): boolean {
    if (!cwd) return false;
    return !!this.resolveLocalRepoTarget(cwd);
  }

  private providerConnections(): ProviderConnections {
    return this.providerSetup.providerConnections();
  }

  private hasProviderConsent(provider: AcpProvider): boolean {
    return this.providerSetup.hasProviderConsent(provider);
  }

  private acpClientTimeouts() {
    return this.providerSetup.acpClientTimeouts();
  }

  private locateProvider(provider: AcpProvider): string | undefined {
    return this.providerSetup.locateProvider(provider);
  }

  private locatedProviders(): Partial<Record<AcpProvider, boolean>> {
    return this.providerSetup.locatedProviders();
  }

  private adapterHistory(provider: AcpProvider) {
    return this.providerSetup.adapterHistory(provider);
  }

  private allAdapterCatalogs(): Iterable<readonly SessionListEntry[]> {
    return this.providerSetup.allAdapterCatalogs();
  }

  private createProviderBackend(provider: AcpProvider, effort?: string) {
    return this.providerSetup.createProviderBackend(provider, effort);
  }

  private connectedProviders(): AcpProvider[] {
    return this.providerSetup.connectedProviders();
  }

  private usableProviders(): AcpProvider[] {
    return this.providerSetup.usableProviders();
  }

  private onboardingForSession(session: Session) {
    return this.providerSetup.onboardingForSession(session);
  }

  private migrateProviderConnections(): ProviderConnections {
    return this.providerSetup.migrateProviderConnections();
  }

  private setProviderConnectedInMemory(provider: AcpProvider, connected: boolean): void {
    this.providerSetup.setProviderConnectedInMemory(provider, connected);
  }

  private async persistProviderConnections(): Promise<void> {
    return this.providerSetup.persistProviderConnections();
  }

  private async setProviderConnected(provider: AcpProvider, connected: boolean): Promise<void> {
    return this.providerSetup.setProviderConnected(provider, connected);
  }

  private setProviderNeedsLogin(provider: AcpProvider, needsLogin: boolean): void {
    this.providerSetup.setProviderNeedsLogin(provider, needsLogin);
  }

  private rearmAuthRecovery(provider: AcpProvider): void {
    this.providerSetup.rearmAuthRecovery(provider);
  }

  private async warmConnectedCodexModels(): Promise<boolean> {
    return this.providerSetup.warmConnectedCodexModels();
  }

  private async warmConnectedClaudeModels(): Promise<boolean> {
    return this.providerSetup.warmConnectedClaudeModels();
  }

  private async warmConnectedGeminiModels(): Promise<boolean> {
    return this.providerSetup.warmConnectedGeminiModels();
  }

  private async reprobeProviderCredentials(provider: AcpProvider): Promise<boolean> {
    return this.providerSetup.reprobeProviderCredentials(provider);
  }

  private providerCredentialFilePresent(provider: AcpProvider): boolean {
    return this.providerSetup.providerCredentialFilePresent(provider);
  }

  private watchProviderLogin(provider: AcpProvider): void {
    this.providerSetup.watchProviderLogin(provider);
  }

  private async installManagedCodexCli(): Promise<void> {
    return this.providerSetup.installManagedCodexCli();
  }

  private providerStateMessage(): Extract<HostMsg, { type: "providerState" }> {
    return this.providerSetup.providerStateMessage();
  }

  private postProviderState(): void {
    this.providerSetup.postProviderState();
  }

  private async refreshProviderStates(): Promise<void> {
    return this.providerSetup.refreshProviderStates();
  }

  private defaultProviderForProject(cwd: string): AcpProvider {
    return this.providerSetup.defaultProviderForProject(cwd);
  }

  private providerDefaultForProject(cwd: string, provider: AcpProvider): string | undefined {
    return this.providerSetup.providerDefaultForProject(cwd, provider);
  }

  private async rememberProjectProvider(cwd: string, provider: AcpProvider, modelId?: string): Promise<void> {
    return this.providerSetup.rememberProjectProvider(cwd, provider, modelId);
  }

  private cacheProviderModels(
    provider: AcpProvider,
    models: readonly ProviderModelInfo[] | readonly any[],
    currentModelId?: string,
  ): PromiseLike<void> {
    const current = this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const clean = models.map(({ provider: _provider, defaultImplied: _default, ...model }: any) => model);
    const stored = this.state.update(PROVIDER_MODEL_CACHE_KEY, {
      ...current,
      [provider]: {
        models: clean,
        currentModelId,
        seenAt: Date.now(),
        // Stamp the CLI this catalog came from, so a later update can be seen.
        cliVersion: this.providerCliVersions[provider]
      }
    } satisfies ProviderModelCache);
    // The picker reads this cache, and an adapter's models arrive
    // ASYNCHRONOUSLY — the warm-up runs after the connect returns. Re-posting
    // only at connect time therefore published an empty list, and the newly
    // connected agent appeared in the picker only after a New session, which is
    // exactly what the owner saw with Codex. Push the catalog again once the
    // models actually exist.
    // A provider the cache had NOTHING for is a newly connected agent, and it
    // must appear in the picker of the conversation the person is looking at —
    // not only in an empty one. The owner connected Codex from a session with
    // history and it stayed missing until he reloaded (2026-08-31). Adding
    // options cannot disturb a live thread: the current model is re-sent
    // unchanged, so nothing about the running conversation moves.
    const providerIsNew = !current[provider] || (current[provider].models ?? []).length === 0;
    void Promise.resolve(stored).then(() => {
      const sessions = providerIsNew
        ? this.sessionsForModelRefresh()
        : this.emptySessionsForModelRefresh();
      for (const session of sessions) this.postSessionModels(session);
    });
    return stored;
  }

  /** Sessions whose picker may be refreshed in place: no history, so there is
   *  nothing a changed model list could disturb. */
  /** Every session with a live client. Used only when a provider appears for
   *  the first time, where the change is purely additive. */
  private sessionsForModelRefresh(): Session[] {
    const seen = new Set<Session>();
    for (const session of [this.focused, ...this.pool]) {
      if (!session || seen.has(session)) continue;
      seen.add(session);
    }
    return [...seen].filter((session) => session.client?.sessionId);
  }

  private emptySessionsForModelRefresh(): Session[] {
    const seen = new Set<Session>();
    for (const session of [this.focused, ...this.pool]) {
      if (!session || seen.has(session)) continue;
      seen.add(session);
    }
    return [...seen].filter((session) => !session.hasHistory && session.client?.sessionId);
  }

  /**
   * Re-post the model catalog for a session already on screen.
   *
   * Connecting a second agent used to leave the picker stale until the user
   * clicked New session — on a session that was already new. An empty
   * conversation has nothing to protect, so its catalog is refreshed in place;
   * one with history is left alone, because changing the model list under a
   * live thread is a different thing entirely.
   */
  /**
   * The identity frame for a conversation that is already live.
   *
   * Re-focusing one replays its transcript and its UI snapshot and, until
   * 2026-09-01, stopped there. `sessionUiSnapshot` carries `modelChanged`, so
   * the model PICKER updated — but `session` is the only frame that sets the
   * provider, and it was never sent on this path. Switching from a Grok
   * conversation to a live Codex one therefore left the client believing it was
   * still on Grok: the composer said "Ask Grok", the working indicator said
   * "grokking", the model list stayed the old session's, and steering was
   * attempted against a CLI that has no such method (owner, from a phone,
   * 2026-09-01 — the model picker showing the right model while everything
   * around it showed the wrong agent is exactly this frame's absence).
   *
   * The same omission the `sessionName` note in focusSession records, one field
   * over: send the small identity frame the client needs, rather than rebuild a
   * catalog to carry it.
   *
   * `newSession: false` — a re-focus is not a new conversation, matching what
   * startSession passes for a resume.
   */
  private sessionIdentityFrame(session: Session): HostMsg | undefined {
    const client = session.client;
    if (!client?.sessionId) return undefined;
    return {
      type: "session",
      sessionId: client.sessionId,
      // `?? []` is load-bearing. A session can have a sessionId before its
      // model list arrives — a phone JOINING a conversation the desk already
      // holds is the ordinary case — and `modelsForSession` maps over this
      // array unconditionally. Without the fallback it threw here, after
      // `clearMessages` had already gone out, so the client was left cleared
      // with an error instead of a transcript. Ten integration tests said so
      // and I had not run them.
      models: this.modelsForSession(session, client.availableModels ?? [], client.currentModelId, false),
      currentModelId: client.currentModelId,
      worktree: !!session.worktree,
      provider: session.provider
    };
  }

  private postSessionModels(session: Session): void {
    const client = session.client;
    // `hasHistory` no longer disqualifies a session: a NEW provider's models
    // are additive and the selection is re-sent unchanged (see
    // cacheProviderModels). Callers decide which sessions to refresh.
    if (!client?.sessionId) return;
    this.emit(session, {
      type: "session",
      sessionId: client.sessionId,
      models: this.modelsForSession(session, client.availableModels, client.currentModelId, true),
      currentModelId: client.currentModelId,
      worktree: !!session.worktree,
      provider: session.provider
    });
  }

  private modelsForSession(session: Session, ownModels: readonly any[], currentModelId?: string, newSession = false): ProviderModelInfo[] {
    if (!newSession) return ownModels.map((model) => ({ ...model, provider: session.provider }));
    return modelsForConnectedProviders(
      // Usable, not connected: a provider that cannot answer contributes no
      // rows to the picker, so its heading and its stale cached models go with
      // it (owner, 2026-08-17: "Not connected => Not visible").
      this.usableProviders(),
      this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {}),
      { provider: session.provider, models: ownModels, currentModelId },
    );
  }

  private providerForRequestedModel(modelId: string, fallback: AcpProvider): AcpProvider {
    return this.providerSession.providerForRequestedModel(modelId, fallback);
  }

  resolveWebviewView(view: HostWebviewView): void {
    this.view = view;
    // Assigning html boots a new renderer. The `local` cache entry belonged
    // to the previous JS state and must not suppress the next identical frame.
    this.forgetPostedVoiceConfigured("local");
    view.webview.options = {
      enableScripts: true,
      // Extension assets keep extensionUri identity (vscode-remote on remote hosts).
      // Staging + grok home are genuinely local disk paths → Uri.file.
      localResourceRoots: this.chatLocalResourceRoots()
    };
    view.webview.html = this.getHtml(view.webview);
    // Message handlers run async; without this catch a throw (e.g. an fs error
    // in an image-attach path) becomes a silent unhandled rejection and the
    // user's action just... does nothing.
    view.webview.onDidReceiveMessage((raw) => {
      const m = raw as WebviewMsg;
      void this.onMessage(m).catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.host.appendLine(`[webview] ${m.type} failed: ${msg}`);
        void this.host.showErrorMessage(`Grok: ${m.type} failed — ${msg}`);
      });
    });
    this.restorePersistedDraft(this.focused);
    this.watchActiveEditor();
    // Periodic idle-TTL sweep over the live-session pool (the LRU cap is enforced
    // eagerly on each new start; this catches sessions that simply went stale).
    if (!this.reaper) {
      this.reaper = setInterval(() => {
        this.reapPool();
      }, GrokSidebar.REAP_INTERVAL_MS);
    }
    // Re-tell the webview whether voice is set up when the relevant settings
    // change, so the mic button's "needs setup" hint updates without a reload.
    this.configWatcher?.dispose();
    const configChanges = this.host.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("grok.voiceApiKey") ||
        e.affectsConfiguration("grok.voiceOpenAiApiKey") ||
        e.affectsConfiguration("grok.voiceBackend") ||
        e.affectsConfiguration("grok.ffmpegPath") ||
        e.affectsConfiguration("grok.voiceSendPhrase") ||
        e.affectsConfiguration("grok.voiceKeyterms")
      ) {
        this.postVoiceConfigured();
      }
      if (e.affectsConfiguration("grok.chatFontScale")) {
        this.postFontScale();
      }
      if (e.affectsConfiguration("grok.showThinking")) {
        this.postShowThinking();
      }
      if (e.affectsConfiguration("grok.codexCliPath")) {
        this.codexCliPath = undefined;
        this.postProviderState();
      }
      if (e.affectsConfiguration("grok.claudeCliPath")) {
        this.claudeCliPath = undefined;
        this.postProviderState();
      }
      if (e.affectsConfiguration("grok.museCliPath")) {
        this.museCliPath = undefined;
        this.postProviderState();
      }
      if (e.affectsConfiguration("grok.geminiCliPath")) {
        this.geminiCliPath = undefined;
        this.postProviderState();
      }
      if (e.affectsConfiguration("grok.expandCommandOutputs")) {
        this.post({
          type: "expandCommandOutputs",
          value: this.host.getConfiguration("grok").get<boolean>("expandCommandOutputs", false)
        });
      }
      if (e.affectsConfiguration("grok.steerByDefault")) {
        this.post({
          type: "steerByDefault",
          value: this.host.getConfiguration("grok").get<boolean>("steerByDefault", false)
        });
      }
      if (e.affectsConfiguration("grok.promptNav")) {
        const value = this.host.getConfiguration("grok").get<boolean>("promptNav", true) !== false;
        this.post({ type: "promptNav", value });
        void this.settingsEditor?.webview.postMessage({ type: "promptNav", value });
      }
      if (e.affectsConfiguration("grok.soundNotifications")) {
        this.post({
          type: "soundNotifications",
          value: this.host.getConfiguration("grok").get<boolean>("soundNotifications", false)
        });
      }
      if (e.affectsConfiguration("grok.processingSound")) {
        this.post({
          type: "processingSound",
          value: this.host.getConfiguration("grok").get<boolean>("processingSound", false)
        });
      }
      if (e.affectsConfiguration("grok.readRepliesAloud")) {
        this.post({
          type: "readRepliesAloud",
          value: this.host.getConfiguration("grok").get<boolean>("readRepliesAloud", false)
        });
      }
      if (e.affectsConfiguration("grok.summarizeRepliesAloud")) {
        this.post({
          type: "summarizeRepliesAloud",
          value: this.host.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true)
        });
      }
      if (e.affectsConfiguration("grok.includeActiveFileByDefault")) {
        // Apply the toggle immediately: disabling removes a visible context
        // chip right away (not on the next editor event), enabling shows it.
        this.refreshImplicitChip(true);
      }
      if (e.affectsConfiguration("grok.mentionIndexLimit")) {
        // Drop the TTL-cached findFiles snapshot so the next `@` rebuilds with
        // the new cap (otherwise a raise would wait up to MENTION_INDEX_TTL_MS).
        this.mentionIndex = null;
        this.otherCwdMentionIndexes.clear();
      }
      if (e.affectsConfiguration("grok.terminalShell")) {
        this.applyTerminalShellPref();
      }
      if (e.affectsConfiguration("grok.telemetry.enabled")) {
        this.post({
          type: "telemetryEnabled",
          value: this.host.getConfiguration("grok").get<boolean>("telemetry.enabled", true)
        });
      }
      if (e.affectsConfiguration("companions.grok.autoCompactThresholdPercent")) {
        void this.offerGrokRestartForCompactThreshold();
      }
      if (e.affectsConfiguration("grok.thumbsFeedback")) {
        this.postThumbsFeedback();
        for (const session of [this.focused, ...this.pool]) {
          this.refreshFeedbackAvailability(session);
        }
      }
    });
    const authWatcher = this.host.createFileSystemWatcher(
      resolveGrokHome(process.env),
      "auth.json",
    );
    const refreshVoiceConfigured = () => {
      this.postVoiceConfigured();
      // A running CLI may still hold the previous login, so nothing is asked
      // here: publish cleared usage now; a new process binds the new account.
      for (const session of new Set([this.focused, ...this.pool])) {
        if (session.subscriptionUsage && !session.subscriptionUsage.current()) {
          this.emit(session, { type: "subscriptionUsage", windows: [] });
        }
      }
    };
    authWatcher.onDidCreate(refreshVoiceConfigured);
    authWatcher.onDidChange(refreshVoiceConfigured);
    authWatcher.onDidDelete(refreshVoiceConfigured);
    this.configWatcher = disposeAll(configChanges, authWatcher);
    this.applyTerminalShellPref();
  }

  /**
   * Primary side bar projects rail. Same catalog stream as the chat webview
   * (`repos` / `sessions` / `repoSessions` / `pinnedSessions` / `sessionDot`),
   * never chat traffic — a second `chat.js` client would double-own sessions.
   */
  resolveProjectsRailView(view: HostWebviewView): void {
    this.projectsRail = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, "media"),
        Uri.joinPath(this.context.extensionUri, "resources"),
      ]
    };
    view.webview.html = this.getProjectsRailHtml(view.webview);
    view.webview.onDidReceiveMessage((raw) => {
      const m = raw as WebviewMsg;
      void this.onProjectsRailMessage(m).catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.host.appendLine(`[projects-rail] ${m.type} failed: ${msg}`);
        void this.host.showErrorMessage(`Grok Projects: ${m.type} failed — ${msg}`);
      });
    });
  }

  /** Drop the rail handle when the view is disposed (or re-created). */
  disposeProjectsRailView(): void {
    this.projectsRail = undefined;
  }

  private chatLocalResourceRoots(): Uri[] {
    return [
      Uri.joinPath(this.context.extensionUri, "media"),
      Uri.joinPath(this.context.extensionUri, "resources"),
      Uri.file(this.imageStagingDir()),
      // grok writes generated media under ~/.grok/sessions/<cwd>/<id>/{images,videos};
      // serving it via asWebviewUri (instead of a base64 data: URI) lets the
      // webview stream a multi-MB video from disk — see postGeneratedMedia.
      Uri.file(resolveGrokHome()),
      Uri.file(resolveCodexHome()),
    ];
  }

  /**
   * Rail actions only. `ready` pushes catalog — never postInitialState / startSession
   * (those belong to the chat view). Everything else reuses onMessage so there is
   * one host path for resume/pin/rename/delete.
   */
  private async onProjectsRailMessage(msg: WebviewMsg): Promise<void> {
    if (msg.type === "ready") {
      this.pushProjectsRailCatalog();
      return;
    }
    if (!GrokSidebar.PROJECTS_RAIL_WEBVIEW_TYPES.has(msg.type)) {
      this.host.appendLine(`[projects-rail] ignored ${msg.type}`);
      return;
    }
    await this.onMessage(msg);
    // Opening a conversation from the rail is someone saying which conversation
    // they want to be in, so put them in it. The rail lives in its own activity
    // bar container, so without this the chat can stay behind another view and
    // the click looks like it did nothing.
    //
    // Only these two, and only from the RAIL: renaming, pinning or deleting a
    // row is housekeeping done while looking at the list, and yanking the view
    // out from under that would be the opposite of helpful. This handler is
    // rail-only, so the chat asking for its own session never lands here.
    if (msg.type === "resumeSession" || msg.type === "newSession") {
      await this.host.revealChatView();
    }
  }

  /** Catalog snapshot for a freshly-resolved rail (or its ready handshake). */
  private pushProjectsRailCatalog(): void {
    if (!this.projectsRail) return;
    this.mirrorToProjectsRail(this.providerStateMessage());
    this.postRepoCatalog();
    this.postSessionsList();
  }

  /** Push the `grok.terminalShell` preference (#46) into the shared shell
   *  resolver so the next agent command re-resolves cmd vs PowerShell. */
  private applyTerminalShellPref(): void {
    const pref = this.host.getConfiguration("grok").get<ShellPreference>("terminalShell", "auto");
    setTerminalShellPreference(pref === "cmd" ? "cmd" : "auto");
  }

  insertActiveMention(opts?: { selection?: boolean; uri?: Uri; pickIfMissing?: boolean }): void {
    const editor = this.host.getActiveTextEditor();
    // Prefer a full Uri end-to-end (scheme + authority) so asRelativePath matches
    // remote workspace folders. Explorer Send File passes the explorer Uri via
    // the adapter; never flatten to fsPath and rebuild with Uri.file.
    const pathUri = opts?.uri ?? editor?.document.uri;
    const absPath = pathUri?.fsPath;
    if (!absPath || !pathUri) {
      // Invoked from the Command Palette with no file editor active — no target
      // to attach. Degrade gracefully instead of a silent no-op that also drops
      // focus (#43): Send File opens the file picker; the selection/@-mention
      // commands (which have nothing to reference without an editor) surface a
      // hint so the command visibly did *something*.
      if (opts?.pickIfMissing) {
        void this.trackAttach(this.pickFileFromComputer());
      } else {
        void this.host.showInformationMessage(
          "Grok: open a file in the editor first, then run this command.",
        );
      }
      return;
    }
    // Same fence as the implicit chip, and for the same reason: the attachment
    // has to belong to the CONVERSATION, not to the window. Once the rail could
    // put a project-B conversation on screen inside a window opened on A, "Add
    // Selection to Grok" on an A file handed A's source to B — and with a
    // selection the prompt builder reads that absolute path and embeds the text
    // under an innocuous A-relative name like `src/foo.ts`.
    //
    // Also where the relative path comes from. `asRelativePath` resolves against
    // VS Code's workspace folders, and a project reached through the rail is
    // deliberately not one of them, so it would have labelled an ordinary file
    // with its full absolute path.
    const sessionRoot = this.sessionCwd(this.focused);
    const relPath = this.conversationRelPath(absPath);
    if (relPath === undefined) {
      void this.host.showWarningMessage(
        `That file is outside ${path.basename(sessionRoot) || "this project"}, which is where ` +
          "this conversation is running. Open a conversation in its project first.",
      );
      return;
    }
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (opts?.selection && editor && !editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }
    this.chips.push(makeExplicitChip(absPath, relPath, selStart, selEnd));
    this.postChips();
    this.revealAndFocusComposer();
  }

  newSession(): void {
    void this.newFocusedSession();
  }

  async pickModel(): Promise<void> {
    return this.providerSession.pickModel();
  }

  async switchModel(
    modelId: string,
    session: Session = this.focused,
    provider: AcpProvider = session.provider,
  ): Promise<void> {
    return this.providerSession.switchModel(modelId, session, provider);
  }

  openModePopover(): void {
    this.post({ type: "openModePopover" });
  }

  /**
   * Development / testing helper. Posts a realistic dummy `exitPlanRequest` so
   * the plan-review card (Approve / Reject / Cancel) appears in the webview.
   * Lets you exercise the three options, the feedback textarea, the resolved
   * state, and the downstream notice/mode logic without a live grok process.
   * The "Reject" button is the one labeled "Keep planning" in the real flow.
   */
  debugShowDummyPlan(): void {
    const dummyPlan = `# Refactor authentication helper

## Summary
Introduce a small \`auth.ts\` module and migrate the two call sites in the API layer. No behavior change for end users.

## Detailed steps
1. Create \`src/lib/auth.ts\` exporting \`getSessionToken()\` and \`isTokenExpired()\`.
2. Update \`src/api/client.ts\` (two call sites) to delegate to the new helper.
3. Add unit tests in \`tests/auth.test.ts\` covering expiry + refresh paths.
4. Run the integration suite to confirm nothing regressed.

## Risk / notes
- Token format is unchanged.
- One new (already-transitive) dependency on \`jsonwebtoken\`.

\`\`\`ts
// proposed addition to src/lib/auth.ts
export async function getSessionToken(): Promise<string> {
  const cached = getFromCache();
  if (cached && !isTokenExpired(cached)) return cached;
  return refresh();
}
\`\`\`

See design doc for the full state machine diagram.`;

    this.post({
      type: "exitPlanRequest",
      req: {
        id: "dummy-plan-" + Date.now(),
        sessionId: this.focused.activeSessionId || "dummy-session",
        plan: dummyPlan
      }
    });

    // Make the bottom mode button reflect Plan during the manual test.
    this.post({ type: "modeChanged", modeId: "plan" });
  }

  /**
   * The mode the UI should show. Plan and YOLO are *client* states that the CLI
   * doesn't model (the CLI only knows agent/plan), so we derive the button label
   * here rather than echoing the CLI's raw mode id.
   */
  private displayMode(session: Session = this.focused): "agent" | "plan" | "yolo" {
    if (session.planActive) return "plan";
    if (session.autoApprove) return "yolo";
    return "agent";
  }

  private postMode(session: Session = this.focused): void {
    const message: HostMsg = { type: "modeChanged", modeId: this.displayMode(session) };
    if (session === this.focused) this.view?.webview.postMessage(message);
  }

  /** Whether grok's config.toml forces always-approve (#31). Project
   *  `.grok/config.toml` overrides global `~/.grok/config.toml`. Read fresh on
   *  each session start — it's a couple of small file reads, and the user may
   *  edit the config between sessions. Any read error → false (treat as normal). */
  /**
   * Confirmation for the handful of messages that make the host RUN something.
   *
   * The desktop dispatcher authorizes on "this came from the main window's main
   * frame", which proves origin but not intent — there is no user-gesture
   * notion, so anything able to post a message can trigger these. A per-
   * capability model is the real answer; until then these two get a dialog the
   * renderer cannot draw or dismiss, which is what makes it worth anything.
   */
  private async confirmHostExecute(
    title: string,
    detail: string,
    confirmLabel: string,
  ): Promise<boolean> {
    const ok = await this.host.showWarningMessage(
      `${title}

${detail}`,
      { modal: true },
      confirmLabel,
    );
    return ok === confirmLabel;
  }

  /** Which config forced always-approve, if any. See alwaysApproveSource. */
  private autoApproveSource(cwd: string = this.workspaceRoot()): "project" | "global" | undefined {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    return alwaysApproveSource({
      project: cwd ? readSafe(projectConfigPath(cwd)) : undefined,
      global: readSafe(globalConfigPath())
    });
  }

  /** Roots whose repo-supplied always-approve the user has accepted this run. */
  private readonly autoApproveConsented = new Set<string>();

  /**
   * Consent for a repository that ships its own always-approve config, asked
   * once per project root per run.
   *
   * This is the one setting a *repository* can use to switch off every
   * permission prompt the agent would otherwise hit before writing files or
   * running commands — and cloning the repo is enough to carry it, because a
   * project .grok/config.toml overrides the user's own.
   *
   * grok applies the file itself, server-side, so declining cannot un-apply it.
   * Declining therefore refuses to start the session at all, which is the only
   * honest option available from here.
   */
  private async confirmRepoForcedAutoApprove(cwd: string): Promise<boolean> {
    if (!cwd || this.autoApproveSource(cwd) !== "project") return true;
    const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (this.autoApproveConsented.has(key)) return true;
    const ok = await this.host.showWarningMessage(
      `"${path.basename(cwd)}" turns off every permission prompt.

` +
        `This project ships a .grok/config.toml setting permission_mode = "always-approve", which ` +
        `overrides your own setting. The agent will edit files and run commands here without asking ` +
        `you first.

Only continue if you trust this code.`,
      { modal: true },
      "Continue anyway",
    );
    if (ok !== "Continue anyway") {
      this.host.appendLine(`[trust] declined: ${cwd} forces always-approve`);
      return false;
    }
    this.autoApproveConsented.add(key);
    return true;
  }

  private configForcesAutoApprove(cwd: string = this.workspaceRoot()): boolean {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const globalPath = globalConfigPath();
    const projectPath = cwd ? projectConfigPath(cwd) : undefined;
    return configForcesAlwaysApprove({ project: readSafe(projectPath), global: readSafe(globalPath) });
  }

  private alwaysApproveNoticeShown = false;

  /** Tell the user once that always-approve is set globally, so the "Auto
   *  accept" mode they see isn't a per-session choice they can undo from the
   *  extension (the CLI reads the global config). Persisted: on desktop this
   *  is a blocking dialog, and "once per activation" meant every app launch. */
  private noticeAlwaysApproveOnce(cwd: string = this.workspaceRoot()): void {
    const shown =
      this.alwaysApproveNoticeShown || this.state.get<boolean>(ALWAYS_APPROVE_NOTICE_KEY) === true;
    if (!shouldShowAlwaysApproveNotice({ source: this.autoApproveSource(cwd), shown })) {
      // Latch only when the notice was already delivered. A project-supplied
      // config has its own consent dialog and must not consume the one-shot
      // for a later session that is actually using the global setting.
      if (shown) this.alwaysApproveNoticeShown = true;
      return;
    }
    this.alwaysApproveNoticeShown = true;
    void this.state.update(ALWAYS_APPROVE_NOTICE_KEY, true);
    const OPEN = "Open config.toml";
    void this.host.showInformationMessage(
      'Grok: "always-approve" is set in your grok config.toml, so tool actions are auto-approved for every session (CLI and extension). The mode shows "Auto accept" to reflect this — the extension can\'t override a global config setting per-session.',
      OPEN,
    ).then((pick) => {
      if (pick !== OPEN) return;
      void this.host.openGlobalConfig();
    });
  }

  /** Toggle the client-enforced plan gate and keep the live client in sync. Only
   *  the focused session drives the mode button — a background session entering
   *  plan mode raises its own gate silently. */
  private setPlanActive(session: Session, v: boolean): void {
    const changed = session.planActive !== v;
    session.planActive = v;
    if (session.client) session.client.planActive = v;
    this.postMode(session);
    if (changed) {
      for (const [requestId, pending] of session.pendingPermissions) {
        this.emit(session, {
          type: "permissionOptions",
          requestId,
          options: pendingPermissionOptions(pending, v)
        });
      }
    }
  }

  async setMode(
    modeId: "agent" | "plan" | "yolo",
    session: Session = this.focused,
  ): Promise<void> {
    return this.providerSession.setMode(modeId, session);
  }

  private handleExitPlan(
    requestId: number | string,
    verdict: "approved" | "abandoned" | "rejected",
    comment?: string,
    session: Session = this.focused,
  ): void {
    return this.providerSession.handleExitPlan(requestId, verdict, comment, session);
  }

  private queueInFlightPlanCommentsOnExit(session: Session, client: AcpClient, gen: number): void {
    return this.providerSession.queueInFlightPlanCommentsOnExit(session, client, gen);
  }

  private recoverUnavailablePlanMode(
    session: Session,
    client: AcpClient,
    gen: number,
    exitPlanRequestId?: number | string,
  ): void {
    return this.providerSession.recoverUnavailablePlanMode(session, client, gen, exitPlanRequestId);
  }

  private finishUnavailablePlanRecovery(
    session: Session,
    client: AcpClient,
    gen: number,
    recovery: NonNullable<Session["planModeRecovery"]>,
  ): void {
    return this.providerSession.finishUnavailablePlanRecovery(session, client, gen, recovery);
  }

  private settleUnavailablePlanTurn(session: Session, client: AcpClient, gen: number): void {
    return this.providerSession.settleUnavailablePlanTurn(session, client, gen);
  }

  /** Persist this plan (text + verdict) so the resume view can replay every plan
   *  the user resolved in this session — grok's on-disk plan.md only retains the
   *  latest, so we'd otherwise lose plans the agent overwrote later. */
  /**
   * Drop our own persisted cards for turns a rewind just deleted.
   *
   * grok truncates its history; the plan and permission cards are the
   * EXTENSION's records (the CLI replays neither on `session/load`), so without
   * this they outlive their turns and the next restore dumps them at the bottom
   * of the conversation — cards for messages the user just removed, sitting
   * under the ones that survived. Applies to Rewind and Edit alike.
   *
   * `lastPlanVerdict` is recomputed from the survivors because it drives whether
   * the plan gate goes back up on restore (`decideRestoreState`) — leaving a
   * discarded verdict there would restore plan mode from a turn that no longer
   * exists.
   */
  private async truncateSessionCardsAfterRewind(sessionId: string, surviving: number): Promise<void> {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sessionId];
    if (!cur) return;
    const boundarySession = [...this.pool].find((session) => session.activeSessionId === sessionId);
    const survivingHistoryEvents = boundarySession
      ? historyEventCount(truncateReplayBuffer(boundarySession.buffer, surviving))
      : undefined;
    const plans = truncateResolvedAfter(cur.plans, surviving, survivingHistoryEvents);
    const permissions = truncateResolvedAfter(cur.permissions, surviving, survivingHistoryEvents);
    const usageLog = truncateResolvedAfter(cur.usageLog, surviving, survivingHistoryEvents);
    const droppedPlans = (cur.plans?.length ?? 0) - plans.length;
    const droppedPerms = (cur.permissions?.length ?? 0) - permissions.length;
    const droppedTurns = (cur.usageLog?.length ?? 0) - usageLog.length;
    if (!droppedPlans && !droppedPerms && !droppedTurns) return;
    // The billing total is DERIVED from the surviving turns, never patched — so
    // rewinding away a turn removes its tokens from the session total instead of
    // leaving the user billed in the UI for a turn that no longer exists. A
    // session with no `usageLog` (recorded before it existed) keeps its stored
    // total rather than dropping to zero: uncorrectable, but not wrong-by-a-lot.
    const rawUsage = cur.usageLog ? sumUsage(usageLog) : cur.usage;
    const usage = enforceCompleteSessionCost(
      rawUsage,
      usageLog,
      surviving,
    );
    const occupancy = contextUsageFromLog(usageLog, cur.contextWindow);
    this.host.appendLine(
      `[rewind] dropped ${droppedPlans} plan card(s) + ${droppedPerms} permission card(s) + ${droppedTurns} usage turn(s) past user message ${surviving}`,
    );
    await this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sessionId]: {
        ...cur,
        plans,
        permissions,
        usageLog,
        usage,
        lastPlanVerdict: plans.length ? plans[plans.length - 1].verdict : undefined,
        contextUsed: occupancy.used,
        contextWindow: occupancy.window ?? cur.contextWindow,
        contextPendingCompact: occupancy.pendingCompact || undefined
      }
    });
    // Keep the live popover in step with what we just persisted. The ledger
    // itself remains keyed by session id in meta; no live Session copy exists.
    const live = [...this.pool].find((s) => s.activeSessionId === sessionId);
    if (live) {
      this.emit(live, { type: "usage", session: usage, afterUserMessage: surviving, afterHistoryEvent: live.historyEventCount });
      if (occupancy.used) {
        this.emit(live, {
          type: "contextUsage",
          used: occupancy.used,
          ...(occupancy.window ? { window: occupancy.window } : {})
        });
      }
    }
  }

  private persistPlanVerdict(
    session: Session,
    verdict: "approved" | "abandoned" | "rejected",
    planText: string,
  ): void {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const plans = appendPlanEntry(cur.plans, {
      text: planText,
      verdict,
      afterUserMessage: session.userMessageCount,
      afterInterjection: session.interjectionCount,
      afterHistoryEvent: session.historyEventCount
    });
    const next: SessionMetaOverrides = {
      ...overrides,
      [sid]: { ...cur, lastPlanVerdict: verdict, plans }
    };
    void this.state.update(SESSION_META_KEY, next);
  }

  /**
   * Mark a conversation as used NOW, and re-push the lists that order by it.
   *
   * Called when a message is sent and when a session is created — the two
   * moments a person would expect their conversation to jump to the top. The
   * lists order by the recency clock (`updates.jsonl` mtime for grok; host
   * `activeAt` for adapters), and grok writes that file about 2.1 seconds
   * after a send (measured), so without this the row sits still through
   * the whole wait and a brand-new conversation is missing entirely.
   *
   * Every project and every session is treated the same; there is no special
   * case for archived, which is a client presentation concept and has no
   * business in the activity path.
   */
  private noteSessionActivity(session: Session): void {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const activeAt = Date.now();
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    void this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...(overrides[sid] ?? {}), activeAt }
    });
    for (const provider of (["codex", "claude", "gemini", "muse"] as const)) {
      const history = this.adapterHistory(provider);
      if (!history) continue;
      for (const [key, entries] of history.cache) {
        history.cache.set(key, entries.map((entry) =>
          entry.id === sid ? { ...entry, updatedAt: activeAt } : entry));
      }
    }
    const cwd = this.sessionCwd(session);
    this.postSessionsList();
    if (cwd) this.sendLocalRepoSessionsPreview(cwd);
  }

  /** Persist an answered permission card (title + allowed/rejected + position) so
   *  a resumed session can replay it collapsed — the CLI doesn't replay
   *  request_permission on session/load. */
  private persistPermissionAnswer(session: Session, requestId: number | string, optionId: string): void {
    const pending = session.pendingPermissions.get(requestId);
    session.pendingPermissions.delete(requestId);
    this.syncHumanWait(session);
    if (!pending) return;
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const outcome = permissionOutcomeFor(pending.options, optionId);
    const chosen = pending.options.find((option) => option.optionId === optionId);
    // A switch_mode card with no plan text is a mode question, not a plan
    // review — persist the option they picked, not "Ready to code?".
    const title = isPlanReviewPermission(pending.toolKind) && !pending.plan?.trim()
      ? (chosen?.name || pending.title)
      : pending.title;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const permissions = [
      ...(cur.permissions ?? []),
      { title, outcome, toolCallId: pending.toolCallId, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount },
    ];
    void this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...cur, permissions }
    });
  }

  /**
   * Decide a live `session/request_permission`. The Plan bit comes from
   * `effectivePlanActive` so a same-chunk request cannot still see Auto
   * accept after a successful Plan RPC. Grok also refuses mutating tools
   * through the client gate; Codex/Claude do not — their Plan is
   * adapter-enforced, but the permission card still has to reach a human.
   */
  private handlePermissionRequest(
    session: Session,
    client: AcpClient,
    req: PermissionRequest,
    cwd: string,
  ): void {
    return this.providerSession.handlePermissionRequest(session, client, req, cwd);
  }

  private applyPermissionRules(
    session: Session,
    client: AcpClient,
    req: PermissionRequest,
    cwd: string,
  ): boolean {
    return this.providerSession.applyPermissionRules(session, client, req, cwd);
  }

  private permissionRulesFs(): PermissionRulesFs {
    return {
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
      mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
      writeFileSync: (p, data) => { fs.writeFileSync(p, data); }
    };
  }

  private loadPermissionRuleState(cwd: string): {
    active: PermissionRule[];
    global: PermissionRule[];
    workspace?: { path: string; raw: string; hash: string; rules: PermissionRule[] };
    adoption?: AdoptionRecord;
    shouldPromptAdoption: boolean;
  } {
    const global = parseGlobalRulesMap(this.state.get(PERMISSION_RULES_KEY, {}));
    const workspace = cwd ? loadWorkspaceRulesFile(cwd, this.permissionRulesFs()) : undefined;
    const adoptionMap = parseAdoptionMap(this.state.get(PERMISSION_RULES_ADOPTED_KEY, {}));
    const adoption = cwd ? adoptionMap[adoptionKeyFor(cwd)] : undefined;
    const shouldPromptAdoption = !!workspace && workspace.rules.length > 0 &&
      (!adoption || adoption.hash !== workspace.hash);
    return {
      active: activeRulesFrom(global, workspace, adoption),
      global,
      workspace,
      adoption,
      shouldPromptAdoption
    };
  }

  private maybePromptWorkspaceRulesAdoption(
    session: Session,
    cwd: string,
    loaded: ReturnType<GrokSidebar["loadPermissionRuleState"]>,
  ): void {
    if (!loaded.shouldPromptAdoption || !cwd) return;
    const prompted = this.permissionAdoptionPrompted;
    if (!prompted) return;
    const key = adoptionKeyFor(cwd);
    if (prompted.has(key)) return;
    prompted.add(key);
    void this.offerWorkspaceRulesAdoption(session, cwd, loaded);
  }

  private async offerWorkspaceRulesAdoption(
    session: Session,
    cwd: string,
    loaded: ReturnType<GrokSidebar["loadPermissionRuleState"]>,
  ): Promise<void> {
    const count = loaded.workspace?.rules.length ?? 0;
    this.emit(session, {
      type: "hostNotice",
      level: "warning",
      text: `This project includes ${count} permission rule${count === 1 ? "" : "s"} that are not active yet. They apply only after you adopt them.`
    });
    if (!this.pendingConfirms) return;
    const ok = await this.confirmInChat(session, {
      title: "Adopt this project's permission rules?",
      body: `${path.basename(cwd)} ships .grok/permissions.json (${count} rule${count === 1 ? "" : "s"}). Checked-in rules stay inert until you adopt them — they can auto-allow or auto-deny tool calls.\n\nOnly continue if you trust this repository.`,
      confirmLabel: "Adopt rules",
      danger: true
    });
    await this.adoptPermissionRules(session, !!ok, cwd);
  }

  private postPermissionRules(session: Session = this.focused): void {
    const cwd = this.sessionCwd(session);
    const loaded = this.loadPermissionRuleState(cwd);
    const userViews: PermissionRuleView[] = [
      ...loaded.global.map(toRuleView),
      ...(loaded.adoption?.status === "adopted" && loaded.workspace &&
        loaded.adoption.hash === loaded.workspace.hash
        ? loaded.workspace.rules.map(toRuleView)
        : []),
    ];
    const pending = pendingWorkspaceAdoption(loaded.workspace, loaded.adoption)
      && loaded.workspace
      ? { path: loaded.workspace.path, ruleCount: loaded.workspace.rules.length, hash: loaded.workspace.hash }
      : undefined;
    const pendingViews: PermissionRuleView[] = pending && loaded.workspace
      ? loaded.workspace.rules.map((r) => {
          const view = toRuleView(r);
          return {
            ...view,
            deletable: false,
            detail: `Not active until adopted. ${view.detail}`
          };
        })
      : [];
    const message: Extract<HostMsg, { type: "permissionRules" }> = {
      type: "permissionRules",
      rules: [...SOCKET_RULE_VIEWS, ...userViews, ...pendingViews],
      orderCopy: PERMISSION_RULES_ORDER_COPY,
      ...(pending ? { pendingAdoption: pending } : {})
    };
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
  }

  /** A session grant: same sanitizer and matcher as a saved rule, but held on
   *  the conversation only and never written to disk. */
  private addSessionAllowRule(session: Session, matchRaw: unknown): void {
    const match = sanitizeWebviewAllowMatch(matchRaw);
    if (!match) return;
    session.sessionPermissionRules = [...(session.sessionPermissionRules ?? []), createRule({
      id: `session-${randomUUID()}`,
      createdAt: Date.now(),
      action: "allow",
      scope: "workspace",
      match,
      note: "this session only"
    })];
  }

  private async persistAllowRuleFromCard(
    session: Session,
    matchRaw: unknown,
  ): Promise<void> {
    const match = sanitizeWebviewAllowMatch(matchRaw);
    if (!match) return;
    const created = createRule({
      id: `pr-${randomUUID()}`,
      createdAt: Date.now(),
      action: "allow",
      scope: "workspace",
      match,
      note: `from card on ${new Date().toISOString().slice(0, 10)}`
    });
    await this.addPermissionRule(session, created);
  }

  private async addPermissionRule(session: Session, created: PermissionRule): Promise<void> {
    const cwd = this.sessionCwd(session);
    const loaded = this.loadPermissionRuleState(cwd);
    // An unadopted checked-in file must not be merged with a new rule — that
    // would adopt hostile allow-rules as a side effect of "always allow npm test".
    const workspaceWritable = !!cwd &&
      (!loaded.workspace || (loaded.adoption?.status === "adopted" &&
        loaded.adoption.hash === loaded.workspace.hash));
    if (created.scope === "workspace" && workspaceWritable && cwd) {
      const next = [...(loaded.workspace?.rules ?? []), created];
      const written = writeWorkspaceRulesFile(cwd, next, this.permissionRulesFs());
      await this.rememberAdoption(cwd, written.hash, "adopted");
    } else {
      const global = [...loaded.global, { ...created, scope: "global" as const }];
      await this.state.update(PERMISSION_RULES_KEY, globalRulesToMap(global));
    }
    this.postPermissionRules(session);
  }

  private async rememberAdoption(
    cwd: string,
    hash: string,
    status: AdoptionRecord["status"],
  ): Promise<void> {
    const map = parseAdoptionMap(this.state.get(PERMISSION_RULES_ADOPTED_KEY, {}));
    map[adoptionKeyFor(cwd)] = { hash, status, at: Date.now() };
    await this.state.update(PERMISSION_RULES_ADOPTED_KEY, map);
  }

  private async deletePermissionRule(session: Session, id: string): Promise<void> {
    if (!id || id.startsWith("socket-")) return;
    const cwd = this.sessionCwd(session);
    const loaded = this.loadPermissionRuleState(cwd);
    const inGlobal = loaded.global.some((r) => r.id === id);
    if (inGlobal) {
      const next = loaded.global.filter((r) => r.id !== id);
      await this.state.update(PERMISSION_RULES_KEY, globalRulesToMap(next));
    } else if (cwd && loaded.workspace && loaded.adoption?.status === "adopted") {
      const next = loaded.workspace.rules.filter((r) => r.id !== id);
      const written = writeWorkspaceRulesFile(cwd, next, this.permissionRulesFs());
      await this.rememberAdoption(cwd, written.hash, "adopted");
    }
    this.postPermissionRules(session);
  }

  private async adoptPermissionRules(
    session: Session,
    adopt: boolean,
    cwd: string = this.sessionCwd(session),
  ): Promise<void> {
    if (!cwd) return;
    const loaded = this.loadPermissionRuleState(cwd);
    if (!loaded.workspace) return;
    await this.rememberAdoption(cwd, loaded.workspace.hash, adopt ? "adopted" : "declined");
    this.postPermissionRules(session);
    this.emit(session, {
      type: "hostNotice",
      level: "info",
      text: adopt
        ? `Adopted ${loaded.workspace.rules.length} permission rule${loaded.workspace.rules.length === 1 ? "" : "s"} from this project.`
        : "Left this project's permission rules inactive. They stay visible in Settings until adopted."
    });
  }

  /** Auto-approve routine permission cards currently awaiting the user (#64).
   *  Fired when the user switches to Auto-accept mid-turn so on-screen tool
   *  cards resolve immediately instead of only future requests. Plan-review
   *  / `switch_mode` cards are excluded: that flip is not a verdict on an
   *  unread plan, and the card must stay answerable. A card with no allow
   *  option is left for the user as well. */
  private autoApprovePendingPermissions(session: Session): void {
    const client = session.client;
    if (!client || session.pendingPermissions.size === 0) return;
    let resolved = 0;
    // Snapshot first — persistPermissionAnswer mutates pendingPermissions.
    for (const [requestId, pending] of [...session.pendingPermissions]) {
      if (isPlanReviewPermission(pending.toolKind)) continue;
      const opt = preferredPermissionAllowOption(pending, session.planActive);
      if (!opt) continue;
      if (!client.respondPermission(requestId, opt.optionId)) continue;
      this.emit(session, { type: "permissionResolved", requestId, optionId: opt.optionId });
      this.persistPermissionAnswer(session, requestId, opt.optionId);
      this.closeDiffForRequest(session, requestId);
      resolved += 1;
    }
    // A leftover plan-review, question, or a card with no allow option still
    // needs the user — `noteAnswered` is the one place that knows all three.
    if (resolved > 0) this.noteAnswered(session);
  }

  /**
   * Resolve the session's queued sends (#37) as ONE combined prompt — blank-line
   * separated, so grok gets a single turn with full context — once its turn is
   * truly over. Safe to call opportunistically: it no-ops while a turn is in
   * flight (`working`), while a card awaits the user (`needs-you`), while a
   * during the spawn window (`priming` — no session id to prompt yet), or with
   * no live client. Works
   * for backgrounded sessions too.
   */
  private queuedSendReadyText(session: Session): string | undefined {
    // Same readiness as handleSend — client without sessionId is still priming.
    if (!sessionReadyForPrompt(session)) return undefined;
    if (session.status === "working" || session.status === "needs-you") return undefined;
    // `""` is a ready image-only queue; `undefined` is "do not flush".
    return queuedFlushText(session.queuedSends);
  }

  private emitQueuedSends(session: Session): void {
    this.emit(session, queuedSendsMessage(session.queuedSends));
  }

  private async maybeFlushQueuedSends(session: Session): Promise<void> {
    const combined = this.queuedSendReadyText(session);
    if (combined === undefined) return;
    if (session.queuedSendCommit) return;
    const claim = beginQueuedSendCommit(session, combined);
    if (!claim) return;
    try {
      await this.handleSend(combined, false, session, claim);
    } finally {
      finishQueuedSendCommit(session, claim, false);
    }
  }

  /**
   * Steer (#52) — inject text (and attachments) into the RUNNING turn instead
   * of waiting. Unlike a second `session/prompt` (which kills the in-flight
   * turn), grok's `_x.ai/interject` queues into a buffer the agent drains at
   * its next safe point, so no tool work is lost and the turn still ends
   * normally.
   *
   * Images ride additive `content` blocks built by `buildPromptWithImages` —
   * the same encoder as `session/prompt`. A CLI old enough to ignore `content`
   * never sees a silent drop: the whole item is queued instead. File chips
   * stay in the text block and work on that legacy wire.
   *
   * The queue / composer snapshot is synchronous (VS Code does not serialize
   * async webview handlers; a following `clearQueuedSends` can race). A
   * failure restores that snapshot rather than losing the message.
   */
  private async steerSend(
    text: string,
    session: Session = this.focused,
    requestedChips?: ContextChip[],
    fromQueue = false,
  ): Promise<void> {
    return this.turnEdit.steerSend(text, session, requestedChips, fromQueue);
  }

  private refreshFeedbackAvailability(session: Session): void {
    const available = decideFeedbackAvailability({
      provider: session.provider,
      metaEnabled: session.feedbackMetaEnabled,
      commandsAdvertise: session.feedbackCommandsAdvertise,
      latchedUnsupported: session.feedbackUnsupported,
      userEnabled: this.thumbsFeedbackEnabled()
    });
    if (session.feedbackAvailable === available) return;
    session.feedbackAvailable = available;
    this.emit(session, { type: "feedbackAvailability", available });
  }

  private latchFeedbackUnavailable(session: Session): void {
    session.feedbackUnsupported = true;
    this.refreshFeedbackAvailability(session);
  }

  private ackTurnFeedback(session: Session, rating: -1 | 0 | 1): void {
    if (!session.liveFeedbackEligible) return;
    session.turnRating = rating === 1 || rating === -1 ? rating : 0;
    this.emit(session, { type: "turnFeedbackAck", rating });
  }

  /** Turn-footer fields for the HostMsg that ends the current turn — how it
   *  ended and how long it ran (wall clock from `beginTurn`). Only the sites
   *  that JUST settled this turn's token call this, so `turnStartedAt` is
   *  always this turn's; a newer turn would have overwritten it only after
   *  beginning, and such a turn is never the one being ended here. */
  private turnEndFields(session: Session, status: TurnEndStatus): { status: TurnEndStatus; durationMs?: number; children?: string } {
    const durationMs = turnElapsedMs(session);
    const children = this.turnChildrenSummary(session);
    return { status, ...(durationMs !== undefined ? { durationMs } : {}), ...(children ? { children } : {}) };
  }

  /** X-05: "3 subagents · 2m 14s · 48k tokens" — this turn's delegations, measured. */
  private turnChildrenSummary(session: Session): string | undefined {
    const parentId = session.activeSessionId;
    if (!parentId || !this.subagentState) return undefined;
    const turnId = this.currentTurnId(session);
    return subagentTurnSummary(
      this.subagents.forParent(parentId).filter((r) => r.spawnedInTurn === turnId && r.status !== "refused"),
    );
  }

  /**
   * A live (non-replay) prompt settled in this process. Thumbs may rate that
   * turn and no earlier one; a cold `session/load` never sets this.
   */
  private noteLiveTurnEnded(session: Session): void {
    // The turn is over, so nothing it asked is outstanding any more — whether
    // it ended by finishing or by being cancelled. Without this, a question
    // card left on screen after Stop still passes the "is it outstanding" check
    // when somebody answers it, and `noteAnswered` drags a settled session back
    // to `working` with no turn left that could ever end it. On a rented
    // machine that holds it awake and billing for good.
    // NOTHING the ended turn asked is outstanding any more — whichever kind of
    // card it was. Clearing only one kind is worse than clearing none: with a
    // question and a permission both on screen after Stop, emptying the
    // question set alone means answering the leftover permission finds every
    // map empty and marks the settled session `working`, with no turn left that
    // could ever end it. Both other paths already refuse a card they cannot
    // find, so clearing here is what makes a stale card inert rather than
    // merely mis-scored.
    //
    // ONLY when no newer turn has started, though. This runs from a completion
    // path that can resume after an await — /compact yields while it refreshes
    // context — and by then another tab or a remote send may have begun a turn
    // of its own. Clearing then would delete a LIVE turn's cards, and the host
    // would refuse to answer the card still on the reader's screen, leaving
    // that agent blocked with no way back short of restarting the session.
    if (!turnIsInFlight(session)) {
      this.dropPendingQuestions(session);
      session.pendingPermissions.clear();
      session.pendingExitPlans.clear();
      this.syncHumanWait(session);
    }
    if (session.replaying || session.suppressContent) return;
    session.liveFeedbackEligible = true;
    session.turnRating = 0;
  }

  /**
   * Per-turn thumbs (#114). Rates the turn that just finished in this process.
   * Does not send `turn_number` — the agent attributes the rating from its own
   * session tracking. See research/turn-feedback.md.
   */
  private async handleTurnFeedback(
    rating: unknown,
    session: Session,
  ): Promise<void> {
    return this.turnEdit.handleTurnFeedback(rating, session);
  }

  /**
   * Fork (#48) — branch this session's conversation into a new session and focus
   * it. The source session is left completely untouched (verified: its history is
   * byte-identical after a fork), and the workspace is never touched either —
   * grok copies session files only, so **code is not rewound**. Whole-session
   * only, deliberately: `targetPromptIndex` truncates `chat_history` without
   * truncating `updates.jsonl`, so a partial fork would replay a conversation the
   * model has forgotten (see research/grok-build-oss-findings.md § 3a).
   */
  private async forkFocusedSession(session: Session = this.focused): Promise<void> {
    return this.turnEdit.forkFocusedSession(session);
  }

  /**
   * Rewind (P2-9) — roll the conversation (and file snapshots) back to an
   * earlier user prompt. Primary UX: the Rewind button on a user bubble
   * (`userBubbleIndex`). Fallback: gear / command palette opens a QuickPick.
   * Execute always uses `force:true` + mode `all`; then reloads the same
   * session so the chat matches the truncated history.
   */
  /**
   * Edit-and-resend the latest user message (#56).
   *
   * `execute` DISCARDS its target along with everything after it (probe-verified,
   * research/rewind-semantics-probe.cjs), so removing this message means
   * targeting its OWN point — see `resolveEditRewindTarget`. The tip is a legal
   * target; nothing here needs the predecessor.
   *
   * The text handed back to the composer is the webview's own bubble text rather
   * than the execute result's `prompt_text`. `prompt_text` IS this message (the
   * CLI returns the discarded prompt precisely so a client can restore it), but
   * it's the raw wire form — still carrying the `<vscode-context>` envelope,
   * fenced selection blocks and `[Image #N]` tags. Only the bubble has those
   * peeled off.
   */
  /**
   * `session` is explicit: the conversation the message was edited in, not
   * whatever happens to be focused by the time an await returns.
   */
  private async editLastMessage(
    userBubbleIndex: number,
    text: string,
    totalUserBubbles?: number,
    session: Session = this.focused,
  ): Promise<void> {
    return this.turnEdit.editLastMessage(userBubbleIndex, text, totalUserBubbles, session);
  }

  /**
   * Hand a rewound message back to the surface that ASKED for it, and only that
   * one.
   *
   * `restoreComposer` APPENDS to whatever is already typed — deliberately, since
   * silently destroying a draft is the bug Edit exists to fix. Sent through
   * `emit` it reaches the focused desk webview and every remote holder of the
   * session, so a phone tapping Edit would paste its message on top of an unsent
   * draft at the computer and steal focus there. Nobody at that desk asked for
   * it, and the appended text is the thing the usage model calls unacceptable.
   *
   * Reachable from a remote only since rewind/edit were widened, which is what
   * makes it a defect this change introduced; the desk-to-phone mirror of it was
   * always possible and is fixed by the same narrowing.
   *
   * The SESSION check is the half a first attempt at this dropped, and the
   * review caught it: `emit` delivered locally only while that session was
   * focused and remotely only to clients still holding it, so replacing it with
   * a plain "send to whoever asked" opened a worse hole than the one being
   * closed. Rewind is an RPC to the CLI and takes seconds; switching
   * conversation while it runs is ordinary impatience, not an exotic race, and
   * the text would have landed in a different conversation's composer — a
   * different REPOSITORY's, at that.
   */
  private restoreComposerFor(
    session: Session,
    text: string,
  ): void {
    if (!text) return;
    const message: HostMsg = { type: "restoreComposer", text };
    if (this.focused === session) {
      // postLocal posts to the focused webview whatever it is displaying.
      this.postLocal(message);
      return;
    }
    // The view has moved to another conversation. Refusing to deliver
    // is only half an answer: the rewind has ALREADY removed the message from
    // the transcript, so dropping it here loses the user's text outright — the
    // failure the previous attempt traded the cross-session paste for.
    //
    // Park it on the conversation it belongs to instead. `rememberQueuedDraft`
    // exists for exactly this and says so: a conversation is the only place a
    // draft can be handed back without guessing who is watching what.
    const id = session.activeSessionId;
    if (!id) return;
    // APPEND, never replace. The slot holds one string, so a second rewind
    // parked before the first was collected would overwrite it — and the first
    // message is already gone from the transcript, so that loses it outright.
    // The webview's own `restoreComposer` appends for exactly this reason
    // ("anything already typed is the user's"); the store follows the same rule
    // rather than being the one place that silently drops a message.
    const parked = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]?.queuedDraft;
    void this.rememberQueuedDraft(id, parked ? `${parked}\n\n${text}` : text);
  }

  /** See {@link editLastMessage} for why `session` is explicit. */
  async rewindFocusedSession(
    userBubbleIndex?: number,
    bubbleText?: string,
    totalUserBubbles?: number,
    session: Session = this.focused,
  ): Promise<void> {
    return this.turnEdit.rewindFocusedSession(userBubbleIndex, bubbleText, totalUserBubbles, session);
  }

  /**
   * Pause / resume / stop a background workflow by its display name (P2-10).
   * Sends the matching `/workflow …` slash command as a real turn so the CLI
   * dispatches it (same path as typing the command in the composer).
   */
  private async controlWorkflow(
    action: "pause" | "resume" | "stop",
    displayName: string,
    session: Session = this.focused,
  ): Promise<void> {
    const cmd = workflowControlCommand(action, displayName);
    if (!cmd) {
      return void this.host.showWarningMessage("Missing workflow display name.");
    }
    await this.handleSend(cmd, true, session);
  }

  /** Workspace folder root (the main checkout for worktree ops). */
  private workspaceRoot(): string {
    const root = this.host.workspaceRoot();
    if (root) return root;
    // Desktop with an empty open set has no root — do not fall back to the
    // process cwd (that would create sessions under the install directory).
    if (this.host.canSwitchWorkspaceFolder) return "";
    return process.cwd();
  }

  /** Effective cwd for a session (worktree path or workspace root). */
  private sessionCwd(session: Session = this.focused): string {
    return session.cwd || this.workspaceRoot();
  }

  private findInWorkspaceSubtree(root: string, raw: string): string | undefined {
    if (!root || !raw || path.isAbsolute(raw) || raw.includes("..")) return undefined;
    // 1. Check immediate subdirectories in root (e.g. root/grok-build-vscode/src/...)
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          entry.name !== "dist" &&
          entry.name !== "out"
        ) {
          const directCandidate = path.resolve(root, entry.name, raw);
          if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
            return directCandidate;
          }
        }
      }
    } catch {}

    // 2. Check active editor project and open workspace folders
    try {
      const activeEditor = this.host.getActiveTextEditor();
      if (activeEditor && activeEditor.document.uri.scheme === "file") {
        const activeDir = path.dirname(activeEditor.document.uri.fsPath);
        let cur = activeDir;
        while (cur && cur.length > 3) {
          const candidate = path.resolve(cur, raw);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
          if (fs.existsSync(path.join(cur, ".git")) || fs.existsSync(path.join(cur, "package.json"))) {
            break;
          }
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
    } catch {}

    for (const folder of this.openWorkspaceFolders()) {
      if (!pathsEqual(folder, root)) {
        const candidate = path.resolve(folder, raw);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        } catch {}
      }
    }

    return undefined;
  }

  /** Resolve the same workspace/media path used by the chat openFile action. */
  private resolveChatOpenPath(session: Session, rawPath: string): {
    ref: ReturnType<typeof parseFileRef>;
    path: string;
  } {
    const ref = parseFileRef(rawPath);
    const { grokHome, sessionDir } = this.desktopOpenMediaContext(session);
    const resolved = resolveChatOpenFilePath({
      rawPath: ref.path,
      workspaceRoots: [this.sessionCwd(session)],
      sessionDir,
      grokHome,
      exists: (abs) => {
        try {
          return fs.statSync(abs).isFile();
        } catch {
          return false;
        }
      },
      realpath: (candidate) => fs.realpathSync(candidate),
      homeDir: os.homedir(),
      findInSubtree: (root, rel) => this.findInWorkspaceSubtree(root, rel)
    });
    return { ref, path: resolved };
  }

  private setSessionCwd(session: Session, cwd: string, fallbackSourceGitRoot: string): void {
    session.cwd = cwd;
    session.worktree = undefined;
    const wt = matchWorktreeForCwd(cwd, this.worktreeCache);
    if (!wt) return;
    session.worktree = {
      path: wt.path,
      label: wt.label,
      sourceGitRoot: wt.sourceRepo || fallbackSourceGitRoot,
      id: wt.id
    };
  }

  private async persistWorktreeBinding(session: Session): Promise<void> {
    const id = session.activeSessionId;
    const wt = session.worktree;
    if (!id || !wt) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: {
        ...(overrides[id] ?? {}),
        worktreePath: wt.path,
        worktreeLabel: wt.label,
        sourceGitRoot: wt.sourceGitRoot
      }
    });
  }

  /**
   * New Worktree Session (P2-8) — create an isolated git worktree and open a
   * fresh session whose cwd is that worktree. Edits stay out of the main
   * checkout until the user runs Apply Worktree.
   */
  /** Command Palette / `companions.runCrew` — same as typing `/crew`. */
  /** E-03: focus the conversation of the running (or last) Crew run. */
  async showCrewRun(): Promise<void> {
    const crew = [...this.pool].find((s) => s.workflowRun && s.workflowRun.status === "running")
      ?? [...this.pool].find((s) => s.workflowRun && !isTerminalRunStatus(s.workflowRun.status))
      ?? [...this.pool].find((s) => s.workflowRun);
    if (!crew) {
      void this.host.showInformationMessage("No Crew run in this window.");
      return;
    }
    if (crew !== this.focused) this.focusSession(crew);
    await this.host.revealChatView();
  }

  /** E-03 / C-05: "Pause after this stage" for the running Crew run. */
  async pauseCrewAfterStage(): Promise<void> {
    const crew = [...this.pool].find((s) => s.workflowRun?.status === "running");
    if (!crew?.workflowRun) {
      void this.host.showInformationMessage("No Crew stage is running.");
      return;
    }
    const def = this.workflowStore().defs.get(crew.workflowRun.runId) ?? this.resolveWorkflow(crew, crew.workflowRun.workflowName);
    crew.workflowRun = applyGateAction(crew.workflowRun, def, { type: "pauseAfterStage", value: true }, Date.now());
    this.persistWorkflowRun(crew);
    this.emitWorkflowRun(crew);
    void this.host.showInformationMessage("The Crew run will stop at the next gate.");
  }

  /** E-03: jump to the first card that waits for the person, in any conversation. */
  async jumpToWaitingApprovalCommand(): Promise<void> {
    if (!this.jumpToWaitingApproval()) void this.host.showInformationMessage("Nothing is waiting for you.");
  }

  async runCrewCommand(): Promise<void> {
    await this.handleCrewCommand("/crew", this.focused);
  }

  async newWorktreeSession(): Promise<void> {
    return this.worktreeHost.newWorktreeSession();
  }

  async applyFocusedWorktree(session: Session = this.focused, skipConfirm = false): Promise<void> {
    return this.worktreeHost.applyFocusedWorktree(session, skipConfirm);
  }

  private async applyWorktreeViaLocalGit(
    session: Session,
    worktreePath: string,
    sourceGitRoot: string,
    label: string,
  ): Promise<void> {
    return this.worktreeHost.applyWorktreeViaLocalGit(session, worktreePath, sourceGitRoot, label);
  }

  async removeFocusedWorktree(session: Session = this.focused, skipConfirm = false): Promise<void> {
    return this.worktreeHost.removeFocusedWorktree(session, skipConfirm);
  }

  private async refreshWorktreeCache(): Promise<void> {
    return this.worktreeHost.refreshWorktreeCache();
  }

  private worktreeLocal(): LocalGitWorktrees {
    return this.worktreeHost.worktreeLocal();
  }

  get worktreeCache(): WorktreeRecord[] {
    return this.worktreeHost.worktreeCache;
  }
  set worktreeCache(records: WorktreeRecord[]) {
    this.worktreeHost.worktreeCache = records;
  }

  get localWorktrees(): LocalGitWorktrees | undefined {
    return this.worktreeHost.localWorktrees;
  }
  set localWorktrees(lw: LocalGitWorktrees | undefined) {
    this.worktreeHost.localWorktrees = lw;
  }

  /** Every open workspace folder root (desktop multi-folder, or VS Code folders). */
  private openWorkspaceFolders(): string[] {
    try {
      const folders = this.host.workspaceFolders?.() ?? [];
      if (folders.length) return folders;
    } catch {
      /* fall through */
    }
    const root = this.workspaceRoot();
    return root ? [root] : [];
  }

  /**
   * Hand-added project folders (VS Code only — see EXTRA_PROJECT_FOLDERS_KEY).
   *
   * Not filtered for existence here: `discoverRepos` stats every trusted cwd and
   * drops the ones that are gone, so a deleted folder disappears from the rail
   * on its own without this having to police the stored list.
   */
  private extraProjectFolders(): string[] {
    const raw = this.state.get<string[]>(EXTRA_PROJECT_FOLDERS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is string => typeof c === "string" && !!c && path.isAbsolute(c));
  }

  /** Normalised keys of folders the user removed — see REMOVED_PROJECT_FOLDERS_KEY. */
  private removedProjectFolderKeys(): Set<string> {
    const raw = this.state.get<string[]>(REMOVED_PROJECT_FOLDERS_KEY, []);
    if (!Array.isArray(raw)) return new Set();
    return new Set(
      raw.filter((c): c is string => typeof c === "string" && !!c).map((c) => normalizeRepoPath(c)),
    );
  }

  /**
   * Whether this host offers "Add project" at all.
   *
   * Two different meanings behind one control: desktop opens the folder for
   * real, VS Code records it for the rail ({@link EXTRA_PROJECT_FOLDERS_KEY}).
   * Every local host can do one or the other, so this is flat true — it exists
   * as a method because the two call sites read better for it and because the
   * next host that cannot will want one place to say so.
   *
   * Deliberately NOT `canSwitchWorkspaceFolder`, which is what it used to be:
   * that flag means "this host owns its own workspace", which VS Code does not
   * and must not start claiming. Remotes are excluded twice over — the message
   * is `host-local` at the policy gate, and the client never paints a control
   * that opens a native dialog the phone could not see.
   */
  private canAddProjectFolder(): boolean {
    return true;
  }

  private repoCatalog() {
    const pins = this.state.get<RepoPins>(REPO_PINS_KEY, {});
    const worktreeLabels = new Map<string, string>();
    for (const o of Object.values(this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {}))) {
      if (o.worktreePath && o.worktreeLabel) {
        worktreeLabels.set(normalizeRepoPath(o.worktreePath), o.worktreeLabel);
      }
    }
    for (const wt of this.worktreeCache) {
      worktreeLabels.set(normalizeRepoPath(wt.path), wt.label);
    }
    const discovered = discoverRepos({
      fs: defaultFs,
      grokHome: resolveGrokHome(process.env),
      pins,
      archives: this.host.canArchiveRepos
        ? this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {})
        : undefined,
      // Colours are host-persisted on every surface that has a rail (desktop +
      // AFK Pilot). Always passed so every row carries `color` (possibly "") —
      // field presence is the client capability probe.
      colors: this.state.get<RepoColors>(REPO_COLORS_KEY, {}),
      tmpDir: os.tmpdir(),
      // Open folders remain selectable before Grok creates a catalog row (and
      // bypass managed-worktree exclusion when the user opened a worktree).
      // Hand-added folders join them: on VS Code that is the only thing keeping
      // a never-used project in the rail, since it has no session history to be
      // discovered from.
      trustedCwds: [...this.openWorkspaceFolders(), ...this.extraProjectFolders()],
      worktreeLabels,
      log: (m) => this.host.appendLine(m)
    });
    // Tombstoned folders are dropped HERE, at the single source, not in the
    // display list. `localTrustedSessionCwds` reads this catalog directly on VS
    // Code, so filtering only what the rail draws would have left a removed
    // project invisible but still authorized — the row would be gone while the
    // phone carried on browsing and editing it.
    const removed = this.removedProjectFolderKeys();
    if (!removed.size) return discovered;
    // A folder VS Code actually has OPEN outranks its own tombstone. Removal
    // refuses to tombstone the open folder, but one written while the folder was
    // CLOSED still applied when it was opened later: the project vanished from
    // the rail, `postRepoCatalog` silently selected a different one, so History
    // and New Session pointed somewhere other than the Explorer — while the root
    // stayed authorized for remotes the whole time, invisibly. Opening a folder
    // is a louder statement of intent than having once removed its row.
    for (const open of this.openWorkspaceFolders()) removed.delete(normalizeRepoPath(open));
    if (!removed.size) return discovered;
    return discovered.filter((r) => !removed.has(normalizeRepoPath(r.cwd)));
  }

  /**
   * Project rows for the local rail (and, on desktop, for remotes attached to
   * this host). Desktop multi-folder: only open project folders. VS Code: the
   * full discoverRepos catalog. Archive fields are stripped when the host
   * cannot archive ({@link Host.canArchiveRepos}) so the client hides Project
   * Archive without an `IS_DESKTOP` flag.
   */
  private localRepoCatalogEntries(): RepoListEntry[] {
    const full = this.repoCatalog();
    let entries: RepoListEntry[];
    if (!this.host.canSwitchWorkspaceFolder) {
      // Hand-added rows are marked so the rail can offer to take them back out.
      // A folder added by hand is the one kind of catalog row the user cannot
      // otherwise revoke: everything else is here because Grok has run there,
      // and stops being listed when that stops being true.
      const added = new Set(this.extraProjectFolders().map((c) => normalizeRepoPath(c)));
      entries = added.size
        ? full.map((r) => (added.has(normalizeRepoPath(r.cwd)) ? { ...r, added: true } : r))
        : full;
    } else {
      const open = this.openWorkspaceFolders();
      // Empty open set → empty rail (user may Add Project Folder). Never fall
      // back to the historical catalog — that reopened the trust hole.
      if (!open.length) {
        entries = [];
      } else {
        const byKey = new Map(full.map((r) => [normalizeRepoPath(r.cwd), r]));
        entries = [];
        for (const cwd of open) {
          const key = normalizeRepoPath(cwd);
          const hit = byKey.get(key);
          if (hit) {
            entries.push(hit);
            continue;
          }
          // Trusted open folder with no catalog row yet — still show it.
          // Colour still comes from the shared store so a painted project
          // keeps its tint when Grok has not created a sessions catalog yet.
          const colors = this.state.get<RepoColors>(REPO_COLORS_KEY, {});
          const colorChoice = colors[key]?.color;
          const archiveChoice = this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {})[key];
          entries.push({
            cwd,
            label: path.basename(cwd) || cwd,
            available: true,
            pinned: false,
            updatedAt: 0,
            archived: !!archiveChoice?.archived,
            archivedAt: archiveChoice?.at ?? 0,
            // Stored choices are non-empty ids; missing/invalid → "" for none.
            color: colorChoice && (REPO_COLOR_IDS as readonly string[]).includes(colorChoice)
              ? colorChoice
              : ""
          });
        }
      }
    }
    return this.applyArchiveCapability(entries);
  }

  /** Drop archive fields when the host does not support archiving. */
  private applyArchiveCapability(entries: RepoListEntry[]): RepoListEntry[] {
    if (this.host.canArchiveRepos) return entries;
    return entries.map((e) => withoutArchiveFields(e) as RepoListEntry);
  }

  private selectedHistoryCwd(): string {
    return this.selectedRepoCwd || this.sessionCwd(this.focused);
  }

  /** Session catalogs to index for a repo row: the checkout itself plus the
   *  isolated worktrees that belong to it. Worktrees are deliberately NOT repo
   *  rows (a worktree is not a checkout you choose between, and `discoverRepos`
   *  excludes `<grokHome>/worktrees` by path), so their sessions have to surface
   *  under the parent — otherwise leaving a worktree session strands it. */
  private sessionCwdsForRepo(repoCwd: string, overrides: SessionMetaOverrides): string[] {
    const cwds: string[] = [];
    const seen = new Set<string>();
    const add = (p?: string) => {
      if (!p) return;
      const key = normalizeFsPath(p);
      if (!key || seen.has(key)) return;
      seen.add(key);
      cwds.push(p);
    };
    add(repoCwd);
    const known: WorktreeParentRef[] = [
      ...Object.values(overrides)
        .filter((o) => o.worktreePath)
        .map((o) => ({ path: o.worktreePath!, sourceGitRoot: o.sourceGitRoot })),
      ...this.worktreeCache.map((wt) => ({ path: wt.path, sourceGitRoot: wt.sourceRepo })),
      ...[...this.pool]
        .filter((s) => s.worktree)
        .map((s) => ({ path: s.worktree!.path, sourceGitRoot: s.worktree!.sourceGitRoot })),
    ];
    for (const p of worktreeCwdsForRepo({
      repoCwd,
      repoGitRoot: gitRootForPath(repoCwd, defaultFs) ?? repoCwd,
      worktrees: known
    })) {
      add(p);
    }
    return cwds;
  }

  /**
   * Authorization epoch — bumped on open/close of a project folder so any
   * capability that cached "was authorized" can detect revocation. The live
   * check is always {@link isAuthorizedCwd} against the current open set.
   */
  private authEpoch = 0;

  /**
   * **Single authorization query** for session/process/remote/image use:
   * is this cwd currently in the host-trusted set?
   *
   * Desktop: open folders + worktrees authorized for sessions within them
   * (`localTrustedSessionCwds`). VS Code: full historical catalog (v3.1.0).
   * All call sites (remote target, start/resume, image handles, desktop auth
   * roots via the same trusted set) consult this rather than re-deriving.
   */
  private isAuthorizedCwd(cwd: string | undefined): boolean {
    if (!cwd) return false;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    return cwdIsAuthorized(cwd, this.localTrustedSessionCwds(overrides), pathsEqual);
  }

  // ---------------------------------------------------------------- AP-15 --
  // Session type (Agent | Crew). The pure decisions live in `session-type.ts`;
  // everything here is the plumbing that pure module deliberately refuses to
  // own — the setting, the metadata record, the webview message.

  /**
   * What a brand-new session starts as (`companions.sessionType.default`).
   *
   * Guarded, and the guard is the same claim the pure fallback makes: a
   * setting must never be able to stop a session from being created. A host
   * that cannot answer (a harness, a configuration provider that throws) gets
   * the default rather than an exception on the `+` button.
   */
  private configuredDefaultSessionType(): SessionType {
    try {
      return defaultSessionTypeFromSetting(
        this.host.getConfiguration("companions").get<string>("sessionType.default", "agent"),
      );
    } catch {
      return "agent";
    }
  }

  /** The stored AP-15 metadata for a session, or undefined before it has an id. */
  private sessionTypeMetaFor(session: Session): SessionTypeMeta | undefined {
    const id = session.activeSessionId;
    if (!id) return undefined;
    return this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
  }

  /**
   * Has this conversation started?
   *
   * Two sources, because they answer at different times: the live send counter
   * for a session that is open right now, and the persisted `hasHistory` for
   * one restored from disk. Either one being true means the type is settled.
   */
  private sessionHasStarted(session: Session): boolean {
    return session.userMessageCount > 0 || session.hasHistory;
  }

  private sessionTypeIsLocked(session: Session): boolean {
    return isSessionTypeLocked(
      { sessionType: session.sessionType, sessionTypeLockedAt: session.sessionTypeLockedAt },
      this.sessionHasStarted(session),
    );
  }

  /** Tell the webview which control to draw. */
  private postSessionType(session: Session): void {
    this.emit(session, {
      type: "sessionType",
      sessionId: session.activeSessionId ?? "",
      sessionType: session.sessionType,
      locked: this.sessionTypeIsLocked(session)
    });
    this.postSessionDelegation(session);
  }

  /** S-03: the composer's delegation switch, and the targets `@subagent:` offers. */
  private postSessionDelegation(session: Session): void {
    if (session.sessionType !== "agent" || this.hiddenReasonOf(session)) {
      this.emit(session, { type: "sessionDelegation", value: null });
      return;
    }
    const meta = this.sessionTypeMetaFor(session);
    const enabled = session.delegationOverride?.enabled ?? meta?.subagentsEnabled ?? this.subagentsEnabledGlobally();
    const policy = session.delegationOverride?.spawnPolicy ?? meta?.spawnPolicy ?? this.companionsSetting<string>("subagents.spawnPolicy", "auto");
    const value = !enabled ? "off" : policy === "ask" ? "ask" : policy === "auto-read-only" ? "read-only-auto" : "auto";
    let targets: Array<{ provider: AcpProvider; name: string; eligible: boolean; reason?: string; models?: Array<{ id: string; efforts?: string[] }> }> = [];
    let roles: Array<{ name: string; whenToUse: string }> = [];
    try {
      const listing = listEligibleTargets(this.eligibilityInput(session, this.currentTurnId(session)), { includeIneligible: true, expand: "all" });
      targets = [
        ...listing.targets.map((t) => ({
          provider: t.provider,
          name: t.displayName,
          eligible: true,
          ...(t.models ? { models: t.models.map((m) => ({ id: m.id, ...(m.efforts ? { efforts: m.efforts } : {}) })) } : {})
        })),
        ...listing.ineligible.map((row) => ({ provider: row.provider, name: providerDisplayName(row.provider), eligible: false, reason: row.message })),
      ];
      roles = this.agentRoleSet(this.sessionCwd(session)).roles.map((r) => ({ name: r.name, whenToUse: r.whenToUse }));
    } catch { /* the switch still works without suggestions */ }
    this.emit(session, {
      type: "sessionDelegation",
      value,
      ...(enabled && session.client && session.companionsMcpInjected === false ? { needsRestart: true } : {}),
      targets,
      roles
    });
  }

  /** S-03: set this session's delegation from the composer. */
  private setSessionDelegation(session: Session, value: string): void {
    const enabled = value !== "off";
    const spawnPolicy = value === "ask" ? "ask" as const : value === "read-only-auto" ? "auto-read-only" as const : "auto" as const;
    session.delegationOverride = { enabled, spawnPolicy };
    const id = session.activeSessionId;
    if (id) {
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      void this.state.update(SESSION_META_KEY, {
        ...overrides,
        [id]: { ...(overrides[id] ?? {}), subagentsEnabled: enabled, spawnPolicy }
      });
      this.sessionCache.delete(id);
    }
    this.postSessionDelegation(session);
  }

  /**
   * Write the type into `grok.sessionMeta`.
   *
   * A no-op before the CLI has named the session: the record is keyed by the
   * provider's session id, so there is nothing to key against yet. The runtime
   * field on `Session` is the store until then, and this runs again the moment
   * an id exists (ST-1).
   */
  private persistSessionType(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const current = overrides[id] ?? {};
    const crewRunId = session.workflowRun?.runId;
    const workflowName = session.workflowRun?.workflowName;
    if (
      current.sessionType === session.sessionType
      && current.sessionTypeLockedAt === session.sessionTypeLockedAt
      && current.crewRunId === crewRunId
      && current.workflowName === workflowName
    ) {
      return;
    }
    void this.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: {
        ...current,
        sessionType: session.sessionType,
        ...(session.sessionTypeLockedAt !== undefined
          ? { sessionTypeLockedAt: session.sessionTypeLockedAt }
          : {}),
        ...(crewRunId ? { crewRunId } : {}),
        ...(workflowName ? { workflowName } : {})
      }
    });
    this.sessionCache.delete(id);
  }

  /**
   * Read the type back for a session restored from history (ST-3).
   *
   * A record with no `sessionType` is a session created before AP-15: it reads
   * as a locked Agent session, and nothing is written to make that true.
   */
  private restoreSessionType(session: Session): void {
    const meta = this.sessionTypeMetaFor(session);
    session.sessionType = effectiveSessionType(meta);
    if (typeof meta?.sessionTypeLockedAt === "number") {
      session.sessionTypeLockedAt = meta.sessionTypeLockedAt;
    }
    this.postSessionType(session);
    if (session.sessionType === "crew") this.postWorkflowList(session);
    // S-05: this session's subagent cards come back from their run folders.
    this.restoreSubagentCards(session);
    if (meta?.crewRunId && !session.workflowRun) {
      const runId = meta.crewRunId;
      void this.restoreWorkflowRun(session, runId).catch((error) => {
        this.host.appendLine?.(`[workflow] could not restore run ${runId}: ${(error as Error).message}`);
      });
    }
  }

  /**
   * ST-2 — the lock, at the first submitted content.
   *
   * Idempotent, because more than one trigger can fire for a single send
   * (text plus chips, a voice utterance that also carries an image).
   */
  private lockSessionTypeNow(session: Session): void {
    if (session.sessionTypeLockedAt !== undefined) {
      this.persistSessionType(session);
      return;
    }
    const locked = lockSessionType(
      { sessionType: session.sessionType, sessionTypeLockedAt: session.sessionTypeLockedAt },
      Date.now(),
    );
    session.sessionType = locked.sessionType ?? "agent";
    session.sessionTypeLockedAt = locked.sessionTypeLockedAt;
    this.persistSessionType(session);
    this.postSessionType(session);
  }

  /**
   * ST-1 — a pre-lock switch, or the host's refusal.
   *
   * The refusal is the point: §5.6 requires a forged `setSessionType` to be
   * rejected HERE, not merely hidden in the webview, so a remote or a tampered
   * frame cannot re-type a conversation that has already started.
   */
  private setSessionType(session: Session, next: unknown): void {
    const result = applySessionTypeSwitch(
      { sessionType: session.sessionType, sessionTypeLockedAt: session.sessionTypeLockedAt },
      next,
      this.sessionHasStarted(session),
    );
    if (!result.ok) {
      this.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: result.reason === "locked"
          ? session.sessionType === "crew"
            ? "This session is locked to Crew mode. Start a new session to use Agent."
            : "This session is locked to Agent mode. Start a new session to use Crew."
          : "Unknown session type."
      });
      // Re-assert the truth so a webview that drew the wrong control corrects.
      this.postSessionType(session);
      return;
    }
    session.sessionType = result.meta.sessionType ?? "agent";
    this.persistSessionType(session);
    this.postSessionType(session);
    if (session.sessionType === "crew") this.postWorkflowList(session);
  }

  // ---------------------------------------------------------------- AP-16 --
  // Companion subagents & Delegation subsystem (extracted to SubagentHost, W-15 Schritt D3).
  public _subagentHost?: SubagentHost;
  public get subagentHost(): SubagentHost {
    if (!this._subagentHost) {
      this._subagentHost = createSubagentHost(this.createSubagentHostDeps());
    }
    return this._subagentHost;
  }

  private createSubagentHostDeps(): SubagentHostDeps {
    const self = this;
    return {
      get host() { return self.host; },
      get context() { return self.context; },
      get state() { return self.state; },
      get agentRuns() { return self.agentRuns; },
      get pool() { return self.pool; },
      getFocused: () => self.focused,
      focusSession: (s) => self.focusSession(s),
      sessionCwd: (s) => self.sessionCwd(s),
      emit: (s, m) => self.emit(s, m),
      post: (m) => self.post(m),
      setStatus: (s, st) => self.setStatus(s, st),
      sessionTypeMetaFor: (s) => self.sessionTypeMetaFor(s),
      agentNotice: (s, l, t) => self.agentNotice(s, l === "error" ? "warning" : l, t),
      confirmInChat: (s, o) => self.confirmInChat(s, o),
      runAgentRole: (r, b, t, c, co) => self.runAgentRole(r, b, t, c, co),
      usableProviders: () => self.usableProviders(),
      companionsSetting: (k, d) => self.companionsSetting(k, d),
      agentRoleSet: (cwd) => self.agentRoleSet(cwd),
      sessionDisplayName: (s) => self.sessionDisplayName(s),
      steerSend: (t, s) => self.steerSend(t, s),
      crewFileClaims: () => self.crewFileClaims(),
      mcpOps: {
        hostPipe: () => self.hostPipe(),
        reservedMcpIdentityFor: (s) => self.reservedMcpIdentityFor(s)
      },
      worktreeOps: {
        createCrewWorktree: (cwd, b) => self.createCrewWorktree(cwd, b),
        applyCrewWorktree: (s, wt) => self.applyCrewWorktree(s, wt),
        worktreeLocal: () => self.worktreeLocal()
      },
      lifecycleOps: {
        emitWorkflowRun: (s) => self.emitWorkflowRun(s),
        persistWorkflowRun: (s) => self.persistWorkflowRun(s),
        getWorkflowDefs: () => self.workflowState?.defs,
        getWorkflowStore: () => self.workflowStore?.()?.store ?? self.workflowStore?.(),
        handleGeneratorTool: (s, c) => self.handleGeneratorTool(s, c),
        turnEndFields: (s, st) => self.turnEndFields(s, st as any),
        noteLiveTurnEnded: (s) => self.noteLiveTurnEnded(s),
        noteSessionActivity: (s) => self.noteSessionActivity(s),
        setProviderNeedsLogin: (p, n) => self.setProviderNeedsLogin(p, n),
        maybeGenerateTitle: (s) => self.maybeGenerateTitle(s),
        postSessionName: (s) => self.postSessionName(s),
        postSessionsList: () => self.postSessionsList(),
        sessionCacheDelete: (id) => self.sessionCache.delete(id)
      },
      getOverride: (name) => self.sidebarTestOverride(name)
    };
  }

  public static readonly SUBAGENT_INDEX_KEY = SUBAGENT_INDEX_KEY;

  public get subagentState(): SubagentState | undefined {
    return this.subagentHost.state;
  }
  public set subagentState(val: SubagentState | undefined) {
    this.subagentHost.state = val;
  }

  public get subagentDeadlines(): Map<string, PausableDeadline> | undefined {
    return this.subagentHost.subagentDeadlines;
  }
  public set subagentDeadlines(val: Map<string, PausableDeadline> | undefined) {
    this.subagentHost.subagentDeadlines = val;
  }

  public get subagents(): SubagentRegistry { return this.subagentHost.subagents; }
  public get subagentReports(): Map<string, string> { return this.subagentHost.reports; }
  public get subagentWaiters(): Map<string, Array<() => void>> { return this.subagentHost.waiters; }
  public get subagentOutcomes(): Map<string, any> { return this.subagentHost.outcomes; }

  private subagentStore(): SubagentState {
    return this.subagentHost.subagentStore();
  }

  private companions(): CompanionsHostServer {
    return this.subagentHost.companions();
  }

  private sessionForCompanionsToken(token: string): Session | undefined {
    return this.subagentHost.sessionForCompanionsToken(token);
  }

  private revokeCompanionsToken(session: Session): void {
    this.subagentHost.revokeCompanionsToken(session);
  }

  private async companionsMcpServer(session: Session): Promise<AcpMcpStdioServer | undefined> {
    return this.subagentHost.companionsMcpServer(session);
  }

  private noteCompanionsSkip(session: Session, reason: CompanionsSkipReason): void {
    this.subagentHost.noteCompanionsSkip(session, reason);
  }

  private subagentMaxDepth(): 1 | 2 {
    return this.subagentHost.subagentMaxDepth();
  }

  private stageMayDelegate(session: Session): boolean {
    return this.subagentHost.stageMayDelegate(session);
  }

  private async spawnCompanionsServer(session: Session, mode: "delegate" | "generator"): Promise<AcpMcpStdioServer | undefined> {
    return this.subagentHost.spawnCompanionsServer(session, mode);
  }

  private subagentsCouldBeUsedIn(session: Session): boolean {
    return this.subagentHost.subagentsCouldBeUsedIn(session);
  }

  private subagentsEnabledGlobally(): boolean {
    return this.subagentHost.subagentsEnabledGlobally();
  }

  private subagentRoster(): Partial<Record<AcpProvider, RosterEntry>> {
    return this.subagentHost.subagentRoster();
  }

  private subagentLimits(session: Session, turnId: string): SpawnLimits {
    return this.subagentHost.subagentLimits(session, turnId);
  }

  private parentSessionOf(session: Session): Session | undefined {
    return this.subagentHost.parentSessionOf(session);
  }

  private chainLabelFor(session: Session): string | undefined {
    return this.subagentHost.chainLabelFor(session);
  }

  public get childRelayTable(): ChildRelayTable<Session> | undefined {
    return (this.subagentHost as any).childRelayTable;
  }
  public set childRelayTable(v: ChildRelayTable<Session> | undefined) {
    (this.subagentHost as any).childRelayTable = v;
  }

  public relayTable(): ChildRelayTable<Session> {
    return this.subagentHost.relayTable();
  }

  private hiddenReasonOf(session: Session): HiddenReason | undefined {
    return this.subagentHost.hiddenReasonOf(session);
  }

  private relayOriginFor(child: Session, route: string): RelayOrigin {
    return this.subagentHost.relayOriginFor(child, route);
  }

  public relayFromChild(child: Session, message: HostMsg): void {
    this.subagentHost.relayFromChild(child, message);
  }

  private activityOwnerOf(child: Session): import("./child-activity").ActivityOwner | undefined {
    return this.subagentHost.activityOwnerOf(child);
  }

  private tapChildActivity(child: Session, message: HostMsg): void {
    this.subagentHost.tapChildActivity(child, message);
  }

  private flushChildActivity(child: Session): void {
    this.subagentHost.flushChildActivity(child);
  }

  private noteChildStarted(caller: Session, child: Session, subagentId?: string): void {
    this.subagentHost.noteChildStarted(caller, child, subagentId);
  }

  private ensureStallWatch(): void {
    this.subagentHost.ensureStallWatch();
  }

  public checkStalls(now = Date.now()): void {
    this.subagentHost.checkStalls(now);
  }

  private noteNativeChild(session: Session, update: unknown): void {
    this.subagentHost.noteNativeChild(session, update);
  }

  public postRunningChildren(): void {
    this.subagentHost.postRunningChildren();
  }

  public runningChildrenSnapshot(now = Date.now()): Omit<Extract<HostMsg, { type: "runningChildren" }>, "type"> {
    return this.subagentHost.runningChildrenSnapshot(now);
  }

  public jumpToWaitingApproval(): boolean {
    return this.subagentHost.jumpToWaitingApproval();
  }

  private async childOverviewAction(msg: { action: string; kind?: string; id?: string; parentSessionId?: string; sessionId?: string }): Promise<void> {
    return this.subagentHost.childOverviewAction(msg);
  }

  private runningStageSession(parent: Session): Session | undefined {
    return this.subagentHost.runningStageSession(parent);
  }

  private async sendToRunningStage(parent: Session, text: string, mode: "steer" | "note"): Promise<void> {
    return this.subagentHost.sendToRunningStage(parent, text, mode);
  }

  private postChildContext(session: Session): void {
    this.subagentHost.postChildContext(session);
  }

  private outsideStageScope(child: Session, req: PermissionRequest): boolean {
    return this.subagentHost.outsideStageScope(child, req);
  }

  private afterRelayClosed(ancestor: Session, child: Session): void {
    this.subagentHost.afterRelayClosed(ancestor, child);
  }

  public closeChildRelays(child: Session): void {
    this.subagentHost.closeChildRelays(child);
  }

  private childNeedsYouChanged(child: Session, needsYou: boolean): void {
    this.subagentHost.childNeedsYouChanged(child, needsYou);
  }

  public childWaitsForYou(child: Session | undefined): boolean {
    return this.subagentHost.childWaitsForYou(child);
  }

  private notifyChildNeedsYou(ancestor: Session, origin: RelayOrigin, kind: RelayKind): void {
    this.subagentHost.notifyChildNeedsYou(ancestor, origin, kind);
  }

  public resolveRelayedAnswer(msg: WebviewMsg): { session: Session; msg: WebviewMsg } | undefined {
    return this.subagentHost.resolveRelayedAnswer(msg);
  }

  private visibleAncestorOf(session: Session): Session {
    return this.subagentHost.visibleAncestorOf(session);
  }

  private eligibilityInput(session: Session, turnId: string): EligibilityInput {
    return this.subagentHost.eligibilityInput(session, turnId);
  }

  public currentTurnId(session: Session): string {
    return this.subagentHost.currentTurnId(session);
  }

  private async handleCompanionsCall(session: Session, call: CompanionsCall): Promise<void> {
    return this.subagentHost.handleCompanionsCall(session, call);
  }

  private companionsList(session: Session, args: ListArguments): unknown {
    return this.subagentHost.companionsList(session, args);
  }

  private async companionsSpawn(session: Session, args: SpawnArguments, call: CompanionsCall): Promise<void> {
    return this.subagentHost.companionsSpawn(session, args, call);
  }

  private async companionsAwait(session: Session, args: AwaitArguments, call: CompanionsCall): Promise<void> {
    return this.subagentHost.companionsAwait(session, args, call);
  }

  private async runCompanionSubagent(session: Session, subagentId: string, args: SpawnArguments, verdict: Extract<EligibilityResult, { ok: true }>, roleTemplate: AgentRole | undefined): Promise<void> {
    return this.subagentHost.runCompanionSubagent(session, subagentId, args, verdict, roleTemplate);
  }

  private preClaimSubagentFiles(runId: string, label: string, entries: readonly string[]): string | undefined {
    return this.subagentHost.preClaimSubagentFiles(runId, label, entries);
  }

  private childWriteClaimWarning(session: Session, req: PermissionRequest): string | undefined {
    return this.subagentHost.childWriteClaimWarning(session, req);
  }

  private sessionSpawnPolicy(session: Session): string {
    return this.subagentHost.sessionSpawnPolicy(session);
  }

  private askSubagentApproval(session: Session, args: SpawnArguments, verdict: Extract<EligibilityResult, { ok: true }>): Promise<{ approved: boolean; adjusted?: Record<string, unknown> }> {
    return this.subagentHost.askSubagentApproval(session, args, verdict);
  }

  private answerSubagentApproval(session: Session, msg: { id: string; approved: boolean; task?: string; provider?: string; model?: string; effort?: string; profile?: string }): void {
    this.subagentHost.answerSubagentApproval(session, msg);
  }

  private async continueSubagent(parent: Session, subagentId: string, message: string): Promise<{ ok: true } | { ok: false; code: RefusalCode; message: string }> {
    return this.subagentHost.continueSubagent(parent, subagentId, message);
  }

  private writeSubagentRaw(runId: string, step: number, raw: string): void {
    this.subagentHost.writeSubagentRaw(runId, step, raw);
  }

  private readSubagentReport(subagentId: string): string | undefined {
    return this.subagentHost.readSubagentReport(subagentId);
  }

  private rememberSubagentRun(parent: Session, runId: string): void {
    this.subagentHost.rememberSubagentRun(parent, runId);
  }

  private persistSubagentRecord(subagentId: string): void {
    this.subagentHost.persistSubagentRecord(subagentId);
  }

  private restoreSubagentCards(parent: Session): void {
    this.subagentHost.restoreSubagentCards(parent);
  }

  private async settleSubagentWorktree(session: Session, subagentId: string, apply: boolean): Promise<void> {
    return this.subagentHost.settleSubagentWorktree(session, subagentId, apply);
  }

  private rearmSubagentTimer(subagentId: string): void {
    this.subagentHost.rearmSubagentTimer(subagentId);
  }

  private clearSubagentDeadline(subagentId: string): void {
    this.subagentHost.clearSubagentDeadline(subagentId);
  }

  private async claimSubagentFiles(session: Session, record: { runId: string; step: number; label: string }, files: readonly string[]): Promise<void> {
    return this.subagentHost.claimSubagentFiles(session, record, files);
  }

  public holdTurnForSubagents(session: Session, meta?: unknown): boolean {
    return this.subagentHost.holdTurnForSubagents(session, meta);
  }

  public postSubagentTray(session: Session): void {
    this.subagentHost.postSubagentTray(session);
  }

  public releaseTurnHold(session: Session): void {
    this.subagentHost.releaseTurnHold(session);
  }

  public applyTurnDirectives(session: Session, text: string): { text: string; block: string } {
    return this.subagentHost.applyTurnDirectives(session, text);
  }

  private directiveForSpawn(session: Session, args: SpawnArguments): SubagentDirective | undefined {
    return this.subagentHost.directiveForSpawn(session, args);
  }

  public reportUnfollowedDirectives(session: Session, turnId: string): void {
    this.subagentHost.reportUnfollowedDirectives(session, turnId);
  }

  private markHiddenChildSession(child: Session, parent: Session, subagentId: string, hiddenReason: HiddenReason = "companion-subagent"): void {
    this.subagentHost.markHiddenChildSession(child, parent, subagentId, hiddenReason);
  }

  private async promoteSubagentSession(session: Session, subagentId: string): Promise<void> {
    return this.subagentHost.promoteSubagentSession(session, subagentId);
  }

  private flushHiddenChildMeta(session: Session): void {
    this.subagentHost.flushHiddenChildMeta(session);
  }

  public postSubagentCard(session: Session, subagentId: string): void {
    this.subagentHost.postSubagentCard(session, subagentId);
  }

  private raceSubagent(subagentId: string, ms: number): Promise<boolean> {
    return this.subagentHost.raceSubagent(subagentId, ms);
  }

  private async raceSubagents(ids: readonly string[], ms: number, mode: "all" | "any"): Promise<void> {
    return this.subagentHost.raceSubagents(ids, ms, mode);
  }

  private releaseSubagentWaiters(subagentId: string): void {
    this.subagentHost.releaseSubagentWaiters(subagentId);
  }

  public cancelSubagent(subagentId: string, reason: string, code?: RefusalCode): void {
    this.subagentHost.cancelSubagent(subagentId, reason, code);
  }

  public cancelSubagentsOf(session: Session, reason: string): void {
    this.subagentHost.cancelSubagentsOf(session, reason);
  }

  public maybeFinishSubagentTurn(session: Session): void {
    this.subagentHost.maybeFinishSubagentTurn(session);
  }


  /** Snapshot of currently authorized session cwds (same set as isAuthorizedCwd). */
  private authorizedSessionCwds(): string[] {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    return this.localTrustedSessionCwds(overrides);
  }

  /** Retire choices superseded by transcript activity, including worktrees.
   *  Store maintenance only, performed when publishing the catalog. */
  private normalizeArchiveChoices(): void {
    if (!this.host.canArchiveRepos) return;
    const archives = this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {});
    if (!Object.keys(archives).length) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const grokHome = resolveGrokHome(process.env);
    const expired = expiredArchiveChoiceKeys({
      archives,
      newestActivityAt: (cwd: string) => {
        let newest = 0;
        for (const c of this.sessionCwdsForRepo(cwd, overrides)) {
          const at = newestTranscriptMtime({ fs: defaultFs, grokHome, cwd: c });
          if (at > newest) newest = at;
        }
        return newest;
      }
    });
    if (!expired.length) return;
    const next: RepoArchives = { ...archives };
    for (const key of expired) {
      this.host.appendLine(`[archive] ${next[key]?.cwd ?? key} has been worked in since — its archive choice no longer applies`);
      delete next[key];
    }
    void this.state.update(REPO_ARCHIVES_KEY, next);
  }

  private postRepoCatalog(): void {
    this.normalizeArchiveChoices();
    // Both local and remote attached clients see the host's catalog: curated
    // open folders on desktop, full discovery on VS Code. Archive fields only
    // when canArchiveRepos (already applied inside localRepoCatalogEntries).
    const localEntries = this.localRepoCatalogEntries().map((entry) => ({
      ...entry,
      defaultProvider: this.defaultProviderForProject(entry.cwd)
    }));
    const activeCwd = this.sessionCwd(this.focused);
    const selectedKey = normalizeRepoPath(this.selectedHistoryCwd());
    const selected = localEntries.find((r) => normalizeRepoPath(r.cwd) === selectedKey);
    // The selection MUST name a row in the catalog. `clearAllSessions` and
    // `selectRepo` both resolve through it and bail when the lookup misses, so
    // a selection that isn't there turns a confirmed "Delete All" into a silent
    // no-op. Falling back to the workspace root is always valid when a root is
    // open — it's a trusted cwd. Empty desktop rail: clear the selection.
    const inLocal = (cwd: string) =>
      !!cwd && localEntries.some((r) => normalizeRepoPath(r.cwd) === normalizeRepoPath(cwd));
    if (selected && inLocal(selected.cwd)) this.selectedRepoCwd = selected.cwd;
    else if (inLocal(activeCwd)) this.selectedRepoCwd = activeCwd;
    else {
      const root = this.host.workspaceRoot();
      this.selectedRepoCwd = root && inLocal(root) ? root : (localEntries[0]?.cwd ?? "");
    }
    // Both hosts follow the selection the LOCAL user made. VS Code used to be
    // pinned to its own workspace root — a rule from when remote showed one
    // project at a time and VS Code had no rail. Now that both have one,
    // history stuck on the open folder while the chat shows another project's
    // conversation is simply wrong: the user picked that conversation.
    //
    // Desktop multi-folder already worked this way: selectedCwd tracks the open
    // folder the user chose, and may equal the active session cwd once a switch
    // settles.
    const localSelected = this.selectedRepoCwd || this.workspaceRoot() || "";
    this.postLocal({
      type: "repos",
      entries: localEntries,
      selectedCwd: localSelected,
      activeCwd,
      canAddProject: this.canAddProjectFolder(),
      canCreateProject: this.canAddProjectFolder(),
      canCloneProject: this.canAddProjectFolder(),
      // What the EDITOR has open, sent alongside the selection rather than
      // instead of it — the rail needs both to say "you are working here, your
      // window is there".
      workspaceCwd: this.workspaceRoot() || ""
    });
  }

  /**
   * Resolve a renderer/local `cwd` against the host-owned local catalog only.
   * Desktop: open folders (via {@link localRepoCatalogEntries}). VS Code: the
   * full historical catalog (same helper returns the full list when the host
   * cannot switch folders). A registered worktree cwd resolves to its owning
   * catalog row through {@link sessionCwdsForRepo}. Never the remote
   * full-catalog-or-fallback probe.
   */
  private resolveLocalRepoTarget(cwd: string): RepoListEntry | undefined {
    const entries = this.localRepoCatalogEntries();
    let hit = entries.find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) {
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      // Ownership resolves by GIT ROOT, so every open folder sharing one
      // checkout claims the same worktree — two sibling monorepo packages both
      // answer yes. Taking the first would silently pick whichever the catalog
      // listed first, which is normally just the active folder, so an ambiguous
      // claim is treated as no claim.
      const owners = entries.filter(
        (r) =>
          r.available
          && this.sessionCwdsForRepo(r.cwd, overrides).some((c) => pathsEqual(c, cwd)),
      );
      hit = owners.length === 1 ? owners[0] : undefined;
    }
    if (!hit || !hit.available) return undefined;
    return hit;
  }

  /** Answer `listRepoSessions`: the newest few sessions for ONE repo, without
   *  making it the client's selection. `cwd` is matched against the catalog the
   *  client was already sent. Unknown and unavailable paths receive the same
   *  coarse empty refusal, so a remote cannot use the answer to probe whether
   *  an arbitrary path exists on the host. Both local and remote use
   *  {@link localRepoCatalogEntries} (open folders on desktop, full catalog on
   *  VS Code) so the preview scope cannot exceed the trust set. */
  private buildRepoSessionsPreview(
    cwd: string,
    limit: number | undefined,
    activeId: string | null | undefined,
  ): HostMsg {
    const hit = this.resolveLocalRepoTarget(cwd);
    if (!hit || !hit.available) {
      this.host.appendLine(`[rail] listRepoSessions failed: project unavailable`);
      return { type: "repoSessions", cwd, entries: [], dots: {}, total: 0, error: "project-unavailable" };
    }
    // Clamp: the rail wants a handful, and an unbounded limit would make every
    // repo row a full history read.
    const size = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || REPO_PREVIEW_SIZE));
    const list = this.buildSessionsList(
      hit.cwd,
      { offset: 0, limit: size },
      activeId,
    );
    if (list.type !== "sessions") {
      this.host.appendLine(`[rail] listRepoSessions failed: session list unavailable`);
      return { type: "repoSessions", cwd: hit.cwd, entries: [], dots: {}, total: 0, error: "sessions-unavailable" };
    }
    return {
      type: "repoSessions",
      // The host's own spelling, not the one the client sent — the rail keys its
      // rows on this, and echoing an arbitrary casing would split one repo into
      // two rail entries.
      cwd: hit.cwd,
      entries: list.entries,
      dots: list.dots,
      total: list.total
    };
  }

  private sendLocalRepoSessionsPreview(cwd: string, limit?: number): void {
    this.postLocal(this.buildRepoSessionsPreview(cwd, limit, this.focused.activeSessionId));
  }

  /**
   * Local repo selection. VS Code: history-scope only (workspace does not move).
   * Desktop multi-folder: re-homes the active folder and conversation — same
   * "newest real session or new" rule as {@link selectRemoteRepo}.
   * Desktop only accepts open folders; a closed historical catalog path is refused.
   */
  private async selectRepo(cwd: string): Promise<void> {
    return this.projectFolders.selectRepo(cwd);
  }

  private async switchLocalWorkspaceFolder(
    cwd: string,
    options: { warnOnRefusal?: boolean } = {},
  ): Promise<void> {
    return this.projectFolders.switchLocalWorkspaceFolder(cwd, options);
  }

  private async switchLocalWorkspaceFolderExclusive(
    target: string,
    options: { warnOnRefusal?: boolean } = {},
  ): Promise<void> {
    return this.projectFolders.switchLocalWorkspaceFolderExclusive(target, options);
  }

  /**
   * Roots the desktop trust boundary may open files under, for THIS session.
   *
   * Two conditions, both necessary. The folder must be in the host-owned open
   * set — never a historical catalog cwd the user has not opened — AND it must
   * belong to the session the message came from. The second used to be missing:
   * the parameter was accepted and then ignored on desktop, so every open
   * project was a legal target and a message from a session in repo A could
   * open or diff a file in repo B merely because B was also open. Being open is
   * what makes a folder reachable at all; it is not what makes it this
   * session's business.
   */
  desktopAuthRoots(session: Session = this.focused): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();
    const add = (p: string | undefined) => {
      if (!p || typeof p !== "string") return;
      const abs = path.resolve(p);
      const key = process.platform === "win32" ? abs.toLowerCase() : abs;
      if (seen.has(key)) return;
      seen.add(key);
      roots.push(abs);
    };
    if (this.host.canSwitchWorkspaceFolder) {
      return sessionScopedRoots({
        sessionCwd: this.sessionCwd(session),
        worktreePath: session.worktree?.path,
        worktreeSourceRoot: session.worktree?.sourceGitRoot,
        activeRoot: this.workspaceRoot(),
        isAuthorized: (cwd) => this.isAuthorizedCwd(cwd)
      });
    }
    add(this.sessionCwd(session));
    if (session.worktree?.path) add(session.worktree.path);
    if (session.worktree?.sourceGitRoot) add(session.worktree.sourceGitRoot);
    add(this.workspaceRoot());
    return roots;
  }

  /**
   * Grok home + on-disk session directory + project session catalogs for desktop
   * openFile authorization of trusted session-generated media
   * (`images|videos` under `~/.grok/sessions/<cwd>/…`). Absolute opens are scoped
   * to the project catalogs (sibling sessions OK for fork replay; cross-repo not).
   * Public so Electron main can wire both message-gate and use-time contexts.
   */
  desktopOpenMediaContext(session: Session = this.focused): {
    grokHome?: string;
    sessionDir?: string;
    sessionCatalogDirs?: string[];
  } {
    let grokHome: string | undefined;
    try {
      grokHome = resolveGrokHome(process.env);
    } catch {
      grokHome = undefined;
    }
    const cwd = this.sessionCwd(session);
    const sid = session.activeSessionId;
    const sessionDir =
      grokHome && sid
        ? sessionDirFor(grokHome, cwd, sid, { fs: defaultFs })
        : undefined;
    const catalogs =
      grokHome
        ? sessionCatalogDirs({ fs: defaultFs, grokHome, cwd })
        : undefined;
    return { grokHome, sessionDir, sessionCatalogDirs: catalogs };
  }

  /** Review directory authorized for the focused desktop conversation. No I/O. */
  desktopPlanReviewSessionRoot(session: Session = this.focused): string {
    const sessionId =
      session.activeSessionId ?? session.client?.sessionId ?? "session";
    return Uri.joinPath(
      this.context.globalStorageUri,
      "plan-reviews",
      planReviewSessionDirectoryName(sessionId),
    ).fsPath;
  }

  async addProjectFolder(cwd?: string): Promise<void> {
    return this.projectFolders.addProjectFolder(cwd);
  }

  /* ----------------------------------------------- making a project */

  private projectHomeDir(): string {
    return this.projectFolders.projectHomeDir();
  }

  private projectRootPath(): string {
    return this.projectFolders.projectRootPath();
  }

  private projectSetupMessage(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> = {},
  ): Extract<HostMsg, { type: "projectSetup" }> {
    return this.projectFolders.projectSetupMessage(extra);
  }

  private githubStatePayload(): GithubState {
    return this.projectFolders.githubStatePayload();
  }

  private githubStateMessage(): Extract<HostMsg, { type: "githubState" }> {
    return this.projectFolders.githubStateMessage();
  }

  private postGithubState(): void {
    this.projectFolders.postGithubState();
  }

  private async refreshGithubState(): Promise<void> {
    return this.projectFolders.refreshGithubState();
  }

  private postProjectSetup(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> = {},
  ): void {
    this.projectFolders.postProjectSetup(extra);
  }

  async createProject(name: string): Promise<void> {
    return this.projectFolders.createProject(name);
  }

  async cloneProject(url: string, name?: string): Promise<void> {
    return this.projectFolders.cloneProject(url, name);
  }

  async setupGithubCli(action: "install" | "auth"): Promise<void> {
    return this.projectFolders.setupGithubCli(action);
  }

  private async listGithubRepos(): Promise<void> {
    return this.projectFolders.listGithubRepos();
  }

  private async githubSignOut(): Promise<void> {
    return this.projectFolders.githubSignOut();
  }

  private async githubLoginWithToken(token: string): Promise<void> {
    return this.projectFolders.githubLoginWithToken(token);
  }

  private async rememberExtraProjectFolder(resolved: string): Promise<void> {
    return this.projectFolders.rememberExtraProjectFolder(resolved);
  }

  private async forgetExtraProjectFolder(cwd?: string): Promise<void> {
    return this.projectFolders.forgetExtraProjectFolder(cwd);
  }

  async removeProjectFolder(cwd?: string): Promise<void> {
    return this.projectFolders.removeProjectFolder(cwd);
  }

  private presentEmptyProjectState(session: Session): void {
    this.projectFolders.presentEmptyProjectState(session);
  }

  private sessionsBoundToFolder(closedCwd: string): Session[] {
    return this.projectFolders.sessionsBoundToFolder(closedCwd);
  }

  private revokeClosedProjectFolder(closedCwd: string): void {
    this.projectFolders.revokeClosedProjectFolder(closedCwd);
  }

  private invalidateImageHandlesUnder(closedCwd: string): void {
    this.projectFolders.invalidateImageHandlesUnder(closedCwd);
  }

  private revokeVoiceForClosedFolder(closedCwd: string): void {
    this.projectFolders.revokeVoiceForClosedFolder(closedCwd);
  }

  private async toggleRepoPin(cwd: string, pinned: boolean): Promise<void> {
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const pins = this.state.get<RepoPins>(REPO_PINS_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    const next = { ...pins };
    if (pinned) next[key] = { cwd: hit.cwd, pinnedAt: Date.now() };
    else delete next[key];
    await this.state.update(REPO_PINS_KEY, next);
    this.postRepoCatalog();
  }

  /** Record where a project belongs in the rail. Both answers are stored,
   *  including "not archived" — that one exists to hold a long-idle project in
   *  view against the rail's own age rule, so forgetting it is not the same as
   *  storing it (see RepoArchiveChoice). */
  private async setRepoArchived(cwd: string, archived: boolean): Promise<void> {
    if (!this.host.canArchiveRepos) return;
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const archives = this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    await this.state.update(REPO_ARCHIVES_KEY, {
      ...archives,
      [key]: { cwd: hit.cwd, at: Date.now(), archived }
    });
    this.postRepoCatalog();
  }

  /** Record a project's folder-icon colour (or clear it). Empty `color` removes
   *  the stored entry so the wire reports `""` again. Invalid ids are ignored —
   *  a remote must not invent a palette entry the host never offered. */
  private async setRepoColor(cwd: string, color: string): Promise<void> {
    if (!isRepoColor(color)) return;
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const colors = this.state.get<RepoColors>(REPO_COLORS_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    const next: RepoColors = { ...colors };
    if (color === "") delete next[key];
    else next[key] = { cwd: hit.cwd, color };
    await this.state.update(REPO_COLORS_KEY, next);
    this.postRepoCatalog();
  }

  /** Pin/unpin one conversation. Stored on the session's own override entry, so
   *  it survives a rename and travels with nothing else — `pinnedCwd` is kept
   *  alongside because the Pinned group spans repos and has to know where to
   *  read each session from without scanning every checkout. */
  private async toggleSessionPin(id: string, cwd: string | undefined, pinned: boolean): Promise<void> {
    if (!id) return;
    await this.updateSessionMeta((overrides) => {
      const existing = overrides[id];
      // Resolve the home repo once, at pin time: the client sends the row's own
      // cwd (already gated against the catalog), and falling back to whatever
      // repo happens to be selected would file the pin under the wrong project.
      const cachedAdapterCwd = [...this.allAdapterCatalogs()].flat().find((entry) => entry.id === id)?.cwd;
      const home = cwd || existing?.pinnedCwd || this.sessionCache.get(id)?.entry.cwd || cachedAdapterCwd;
      if (!home) return null; // nothing to write (pin or unpin)
      // Authorization is not only "cwd was once in the catalog": a remote client
      // that knows a session id must not mutate pin state for a closed project.
      // No protocol change — wire still allows optional cwd; we re-check home.
      if (!this.isAuthorizedCwd(home)) return null;
      const next: SessionMetaOverrides = { ...overrides };
      const entry = { ...(existing ?? {}) };
      if (pinned) {
        entry.pinnedAt = Date.now();
        entry.pinnedCwd = home;
      } else {
        delete entry.pinnedAt;
        delete entry.pinnedCwd;
      }
      // An override that now carries nothing is noise in globalState — drop it
      // rather than accumulating empty objects for every session ever unpinned.
      if (Object.keys(entry).length === 0) delete next[id];
      else next[id] = entry;
      return next;
    });
    // The pin lives in globalState, not in the session's summary.json, so the
    // file's mtime does not move and the entry cache would keep serving a row
    // with the OLD pin state — the pin control would then still say "Pin" right
    // after pinning, and clicking it would pin again instead of unpinning. Same
    // reason `customName` invalidates here: an override changes the entry
    // without touching disk.
    this.sessionCache.delete(id);
    this.postSessionsList(); // fans out the pinned refresh too
  }

  /** Read-modify-write on the session-meta map, serialised.
   *
   *  Every writer of this map reads the whole object, edits a copy and writes it
   *  back. The read is synchronous but the write awaits, so two updates started
   *  in the same tick both read the OLD map and the second silently discards the
   *  first — pin A then immediately pin B, and only B survives. Remote messages
   *  are not serialised, so "the same tick" is an ordinary double click.
   *
   *  Chaining every call through one promise makes the read-modify-write atomic
   *  with respect to other users of this helper. It is the mechanism the older
   *  writers should migrate onto (ROADMAP § Concurrent writes); until they do,
   *  a pin can still lose a race against a rename, which is far rarer than two
   *  pins in a row. Returning null from the mutator means "nothing to write". */
  private sessionMetaWrites: Promise<void> = Promise.resolve();
  private updateSessionMeta(
    mutate: (current: SessionMetaOverrides) => SessionMetaOverrides | null,
  ): Promise<void> {
    const run = this.sessionMetaWrites.then(async () => {
      const current = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const next = mutate(current);
      if (next) await this.state.update(SESSION_META_KEY, capSessionMetaAutoNames(next).value);
    });
    // Keep the chain alive even if one link throws, or every later write dies.
    this.sessionMetaWrites = run.catch(() => {});
    return run;
  }

  /** Park a composer draft on the conversation it was typed into, because that
   *  conversation is the only place it can be handed back without guessing who
   *  is watching what. */
  private rememberQueuedDraft(id: string, text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return this.updateSessionMeta((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), queuedDraft: text }
    }));
  }

  /** Hand a parked draft back to this session's live composer, exactly once.
   *  Detached tabs keep META untouched until reattachment because
   *  `restoreComposer` is transient and has no recipient while detached. */
  private restorePersistedDraft(session: Session): void {
    const hasComposer = session === this.focused && this.view !== undefined;
    if (!hasComposer || session.needsProvider) return;
    const id = session.activeSessionId;
    if (!id) return;
    const draft = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]?.queuedDraft;
    if (!draft) return;
    void this.updateSessionMeta((current) => {
      const meta = current[id];
      if (!meta?.queuedDraft) return null;
      const { queuedDraft: _restored, ...rest } = meta;
      return { ...current, [id]: rest };
    });
    this.emit(session, { type: "restoreComposer", text: draft });
  }

  /** Restore a replacement's captured draft only after its provider start
   * succeeded. The durable copy stays on the old conversation until then. */
  private restoreStrandedDraft(session: Session): void {
    if (!this.sessionHasLiveOwner(session) || session.needsProvider) return;
    const draft = session.strandedDraft;
    if (!draft) return;
    const originId = session.strandedDraftSessionId;
    session.strandedDraft = undefined;
    session.strandedDraftSessionId = undefined;
    if (originId) {
      void this.updateSessionMeta((current) => {
        const meta = current[originId];
        if (!meta?.queuedDraft) return null;
        const { queuedDraft: _restored, ...rest } = meta;
        return { ...current, [originId]: rest };
      });
    }
    this.emit(session, { type: "restoreComposer", text: draft });
  }

  /** Every pinned conversation across every repo, newest pin first. Reads are
   *  grouped by the stored home cwd so this costs one index scan per repo that
   *  actually holds a pin — not one per repo in the catalog. */
  private buildPinnedSessions(): { entries: SessionListEntry[]; dots: Record<string, Dot> } {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // Enforce authorization at build time — never trust pin metadata alone.
    const authorized = this.authorizedSessionCwds();
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.host.appendLine(m);
    const byCwd = new Map<string, { cwd: string; ids: string[] }>();
    for (const [id, o] of Object.entries(overrides)) {
      if (typeof o?.pinnedAt !== "number" || !o.pinnedCwd) continue;
      // Closed project: skip the whole bucket before any disk scan.
      if (!authorizedListCwd(o.pinnedCwd, authorized, pathsEqual)) continue;
      const key = normalizeFsPath(o.pinnedCwd);
      const bucket = byCwd.get(key) ?? { cwd: o.pinnedCwd, ids: [] };
      bucket.ids.push(id);
      byCwd.set(key, bucket);
    }
    const entries: SessionListEntry[] = [];
    const cachedAdapterIds = new Set(
      [...this.allAdapterCatalogs()].flat().map((entry) => entry.id),
    );
    for (const { cwd, ids } of byCwd.values()) {
      const adapterIds = new Set(ids.filter((id) => {
        const provider = overrides[id]?.provider;
        return (provider && isAdapterProvider(provider)) || cachedAdapterIds.has(id);
      }));
      if (adapterIds.size) {
        this.scheduleAdapterHistoryRefresh("codex", cwd);
        this.scheduleAdapterHistoryRefresh("claude", cwd);
        this.scheduleAdapterHistoryRefresh("gemini", cwd);
        this.scheduleAdapterHistoryRefresh("muse", cwd);
      }
      for (const id of adapterIds) {
        const cached = findCachedAdapterSession(
          this.allAdapterCatalogs(),
          id,
          [cwd],
          (entryCwd, allowed) => sessionCwdBelongsToRepo(entryCwd, allowed, pathsEqual),
        );
        if (!cached) continue;
        entries.push({
          ...cached,
          customName: overrides[id]?.customName,
          displayName: overrides[id]?.customName?.trim() || cached.rawSummary || cached.displayName,
          pinnedAt: overrides[id]?.pinnedAt
        });
      }
      const wanted = new Set(ids.filter((id) => !adapterIds.has(id)));
      if (!wanted.size) continue;
      const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
      const present = index.filter((e) => wanted.has(e.id));
      if (!present.length) continue;
      const mtimeById = new Map(present.map((e) => [e.id, e.mtimeMs]));
      // One repo per pass, so every id in it reads from that same checkout.
      const cwdById = new Map(present.map((e) => [e.id, cwd]));
      entries.push(...this.readEntriesCachedMulti(
        present.map((e) => e.id), mtimeById, cwdById, overrides, grokHome, log,
      ));
    }
    // Newest pin on top — the same rule the repo rows use, and the one that
    // matches "I just pinned this, where did it go". Defense in depth: drop
    // any entry whose cwd slipped past the bucket gate.
    const filtered = filterEntriesByAuthorizedCwd(entries, authorized, pathsEqual);
    filtered.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    const dots: Record<string, Dot> = {};
    for (const e of filtered) dots[e.id] = this.dotForId(e.id);
    return { entries: filtered, dots };
  }

  private postPinnedSessions(): void {
    // Desktop multi-folder rail OR the VS Code primary-side-bar projects view.
    const hasLocalRail = this.host.canSwitchWorkspaceFolder || !!this.projectsRail;
    if (!hasLocalRail) return;
    this.postLocal({ type: "pinnedSessions", ...this.buildPinnedSessions() });
  }

  private annotateWorktreeLabels(
    entries: SessionListEntry[],
    overrides: SessionMetaOverrides,
    workspaceCwd: string,
  ): void {
    const repoWts = worktreesForRepo(this.worktreeCache, workspaceCwd, { includeDead: true });
    for (const e of entries) {
      const fromMeta = overrides[e.id]?.worktreeLabel;
      if (fromMeta) {
        e.worktreeLabel = fromMeta;
        continue;
      }
      const hit = matchWorktreeForCwd(e.cwd, repoWts);
      if (hit) e.worktreeLabel = hit.label;
      else if (e.cwd && !pathsEqual(e.cwd, workspaceCwd)) {
        // Session lives outside the workspace (likely a worktree we no longer
        // track) — still surface the basename so the row is distinguishable.
        e.worktreeLabel = path.basename(e.cwd);
      }
    }
  }

  /**
   * Forward generated media (grok's `/imagine` image or `/imagine-video` video)
   * to the webview. Remote URLs pass through as a link. File paths — how grok
   * writes media into its session dir — are served via `asWebviewUri` when they
   * are **trusted** generated media under the Grok home (canonical containment
   * + sessions/…/images|videos/ shape), so big videos stream from disk.
   *
   * Paths outside that provenance still render via a size-capped base64 data:
   * URI (v3.1.0 behaviour restored). Reachable only from ACP `mediaContent`
   * (agent over stdio); the agent already has full filesystem access, so
   * showing the picture to the same authenticated user adds no capability.
   * Still refuse `auth.json` by name, and never weaken renderer-facing
   * `app-resource://` registry containment.
   * Best-effort: a failure just drops the media rather than breaking the turn.
   */
  private async postGeneratedMedia(m: MediaRef, session: Session, gen: number): Promise<void> {
    return this.voiceAndMcp.postGeneratedMedia(m, session, gen);
  }

  private isServableFromDisk(p: string, provider: AcpProvider = "grok"): boolean {
    return this.voiceAndMcp.isServableFromDisk(p, provider);
  }

  private async exportExpr(msg: Parameters<VoiceAndMcp["exportExpr"]>[0], session: Session): Promise<void> {
    return this.voiceAndMcp.exportExpr(msg, session);
  }

  /**
   * Sign out of the Grok CLI (`grok logout` — clears `~/.grok/auth.json`). The
   * CLI owns auth, so we shell out to it, tear down the live session, and drop
   * the webview back to the auth-required onboarding state. Resolves issue #13.
   */
  async logout(
    provider: AcpProvider = "grok",
    opts: { report?: (text: string) => void } = {},
  ): Promise<void> {
    // Every failure below goes through here.
    const fail = (text: string) => {
      this.host.appendLine(`[providers] ${text}`);
      if (opts.report) opts.report(text);
      else void this.host.showErrorMessage(text);
    };
    if (isAdapterProvider(provider)) {
      const cliPath = this.locateProvider(provider);
      const name = providerDisplayName(provider);
      if (!cliPath) {
        fail(`${name} sign-out could not run because the ${name} CLI was not found. The account remains connected.`);
        return;
      }
      const choice = await this.host.showWarningMessage(
        `Sign out of ${name}? This clears the ${name} CLI's cached credentials.`,
        { modal: true },
        "Sign Out",
      );
      if (choice !== "Sign Out") return;
      const logoutArgs = (provider === "claude" || provider === "gemini") ? ["auth", "logout"] : ["logout"];
      try {
        await execGrokCli(cliPath, logoutArgs, { timeout: 30_000, windowsHide: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
          this.host.createTerminal({ name: `${name} Logout`, shellPath: cliPath, shellArgs: logoutArgs }).show();
          // The cause, in the log, next to the sentence that hides it. This
          // branch fires when the resolved CLI cannot be executed at all —
          // on Windows that is almost always an extensionless npm shim run
          // without a shell — and the user-facing text cannot say that.
          this.host.appendLine(`[providers] ${provider} logout spawn failed: ${cliPath} (${code}) ${errorDetail(error)}`);
          fail(`${name} sign-out could not be observed, so it was opened in a terminal. The account remains connected until sign-out is confirmed.`);
        } else {
          fail(`${name} sign-out failed: ${errorDetail(error)}. The account remains connected.`);
        }
        this.postProviderState();
        return;
      }
      await this.finishProviderLogout(provider, opts.report);
      return;
    }
    const cliPath = this.locateProvider("grok");
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform, provider: "grok" });
      return;
    }
    const choice = await this.host.showWarningMessage(
      "Sign out of Grok? This clears the CLI's cached credentials.",
      { modal: true },
      "Sign Out",
    );
    if (choice !== "Sign Out") return;
    // shellPath/shellArgs, not sendText — a quoted path typed into PowerShell
    // is parsed as a string literal rather than an invocation.
    this.host.createTerminal({ name: "Grok Logout", shellPath: cliPath, shellArgs: ["logout"] });
    await this.finishProviderLogout("grok", opts.report);
  }

  private async finishProviderLogout(
    provider: AcpProvider,
    report?: (text: string) => void,
  ): Promise<void> {
    this.setProviderConnectedInMemory(provider, false);
    const reset = this.resetProviderSessionsAfterLogout(provider);
    try {
      await this.persistProviderConnections();
    } catch (error) {
      const providerName = providerDisplayName(provider);
      const detail = errorDetail(error);
      this.host.appendLine(`[providers] ${providerName} signed out, but saving connection state failed: ${detail}`);
      const text = `${providerName} signed out and its conversations were reset, but the disconnected state could not be saved: ${detail}`;
      if (report) report(text);
      else await this.host.showErrorMessage(text);
    }
    await reset;
    this.postSessionsList();
  }

  private async resetProviderSessionsAfterLogout(provider: AcpProvider): Promise<void> {
    return this.providerSession.resetProviderSessionsAfterLogout(provider);
  }

  /**
   * A provider just became usable (Settings' "Check again",
   * `recheckConnection`) — put every session that was waiting for one to work.
   */
  private async adoptSessionsForConnectedProvider(
    provider: AcpProvider,
    session: Session,
  ): Promise<void> {
      // Every view stranded by a last-provider sign-out, not just this one.
      const adopted = await this.retargetNeedsProviderSessions(provider);
      // An empty conversation bound to a provider that cannot answer has
      // nothing worth preserving, so hand it to the one just connected. This
      // used to require `firstConnection`, computed from CONNECTED providers,
      // so a lapsed Codex made connecting Grok look like a second account and
      // the empty session stayed on Codex — asking for a codex login while
      // the picker read Grok 4.6. What matters is whether the session's own
      // provider can answer, not how many others are linked.
      // Both halves matter: the session is stranded on something that cannot
      // answer, AND the provider just re-checked can. A FAILED re-check leaves
      // it unusable, and handing the empty session to it there would start a
      // session against an agent that just refused to authenticate.
      const nowUsable = this.usableProviders();
      const strandedOnUnusable = !session.hasHistory
        && !nowUsable.includes(session.provider)
        && nowUsable.includes(provider);
      // Say it worked. An empty session looks exactly like a re-check that did
      // nothing, and this is the moment someone most wants confirmation. Only
      // on a conversation with no history — a real transcript is its own
      // evidence, and the panel would cover it.
      // Announced once, after whichever branch ran, and only when the re-check
      // actually succeeded. It was previously wired into two of the four
      // outcomes and missed the most ordinary one — the session is already on
      // this provider and simply starts — so the confirmation the owner asked
      // for did not appear in the case he was testing.
      const confirmConnected = () => {
        if (session.hasHistory || !this.usableProviders().includes(provider)) return;
        // No folder to start in — "You can start grokking!" would be a lie.
        // startSession already painted no-project.
        if (this.host.canSwitchWorkspaceFolder && !this.openWorkspaceFolders().length) return;
        this.emit(session, {
          type: "onboarding",
          state: "provider-connected",
          platform: process.platform,
          provider
        });
      };
      if (adopted.has(session)) {
        this.postSessionsList();
      } else if (strandedOnUnusable) {
        session.provider = provider;
        await this.rememberProjectProvider(this.sessionCwd(session), provider);
        await this.startSession(undefined, session);
      } else if (session.provider === provider && !session.client) {
        // Retry a provider whose first real session exposed a credential error.
        await this.startSession(session.hasHistory ? session.activeSessionId : undefined, session);
      } else {
        // Adding a second account must not restart or change a conversation
        // with history on screen. But an EMPTY one has nothing to protect,
        // and leaving its picker stale meant the newly connected agent's
        // models only appeared after clicking New session — for a session
        // that already was new. Re-post the catalog so the picker picks it up
        // in place.
        if (isAdapterProvider(provider)) this.scheduleAdapterHistoryRefresh(provider, this.sessionCwd(session));
        if (!session.hasHistory) this.postSessionModels(session);
        this.postSessionsList();
      }
      // Re-post after the branches, not just after setProviderConnected: the
      // credential re-probe and any retarget above change what a provider row
      // should say, and Settings → Providers reads this. Without it a freshly
      // connected agent still showed its old state there until something else
      // happened to refresh the panel.
      this.postProviderState();
      confirmConnected();
  }

  private async retargetNeedsProviderSessions(provider: AcpProvider): Promise<Set<Session>> {
    const targets = new Set<Session>();
    const consider = (session: Session | undefined) => {
      if (session?.needsProvider) targets.add(session);
    };
    consider(this.focused);
    for (const session of this.pool) consider(session);
    if (!targets.size) return targets;
    // Bind and lock all of them before the first start can await, for the same
    // reason the sign-out path detaches before it starts: a send arriving
    // mid-adoption must queue against a priming session, not fall back through
    // the refusal path it is being rescued from.
    for (const session of targets) {
      session.provider = provider;
      session.priming = true;
      this.emit(session, { type: "setBusy", value: true, locked: true });
    }
    // `needsProvider` is cleared by a start that actually succeeds, so a refused
    // one (closed folder, missing CLI) stays adoptable by the next re-check
    // rather than becoming permanently unreachable.
    for (const session of targets) {
      const started = await this.startSession(undefined, session);
      if (started && !session.needsProvider) this.restoreStrandedDraft(session);
    }
    return targets;
  }

  dispose(): void {
    void this.host.setContext("grok.composerFocus", false);
    if (this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
    this._routineScheduler?.dispose();
    if (this.workflowTimer) { clearInterval(this.workflowTimer); this.workflowTimer = undefined; }
    this._providerSetup?.dispose();
    for (const timer of this.turnOrderTimers) clearTimeout(timer);
    this.turnOrderTimers.clear();
    // Window reload and extension deactivation both land here. Closing the pipe
    // cancels every outstanding question first — a CLI blocked inside
    // `tools/call` has no timeout of its own and would wait for ever.
    this.askUserChannel?.dispose();
    this.askUserChannel = undefined;
    // Window reload and extension deactivation both land here. Every
    // outstanding delegation call is settled and every child cancelled — a
    // subagent that outlives its editor is spending a subscription for nobody.
    this._subagentHost?.dispose();
    // Last, and only here: both protocols hold sockets on it, and each one's
    // own dispose has just settled what it owed.
    this.hostPipeMux?.dispose();
    this.hostPipeMux = undefined;
    for (const session of this.pool) {
      session.askUserToken = undefined;
      this.dropPendingQuestions(session);
    }
    try { this.settingsEditor?.dispose(); } catch { /* tab already gone */ }
    this.settingsEditor = undefined;
    void this.disposePool();
    this.editorWatcher?.dispose();
    this.configWatcher?.dispose();
    this.terminalManager.disposeAll();
    this.stopVoiceInput();
    try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
  }

  moveComposerCaret(direction: "forward" | "previousLine"): void {
    this.post({ type: "moveComposerCaret", direction });
  }

  // ---------- internals ----------

  private async ensureClient(session: Session = this.focused): Promise<AcpClient | undefined> {
    if (session.client) return session.client;
    // After a CLI crash the focused session keeps its grok id but loses its
    // client — respawn by RESUMING that id, so the next send continues the same
    // conversation (a bare startSession would open a blank-context session
    // under the old transcript). Fresh/unstarted sessions have no id and start
    // clean as before.
    await this.waitForSessionStart(session);
    if (session.client) return session.client;
    return this.startSession(session.activeSessionId, session, "ensure");
  }

  /** Read `grok --version` for policy checks. Returns "" on failure (logged). */
  private async readGrokVersion(cliPath: string, timeout = 30_000): Promise<string> {
    try {
      const { stdout } = await execGrokCli(cliPath, ["--version"], { timeout });
      const output = stdout?.trim() ?? "";
      const parsed = parseGrokVersion(output);
      if (parsed) this.providerCliVersions.grok = parsed.join(".");
      return output;
    } catch (e) {
      this.host.appendLine(`grok --version failed: ${(e as Error).message}`);
      return "";
    }
  }

  private probeProviderVersion(provider: AcpProvider): Promise<string> {
    if (!this.hasProviderConsent(provider)) return Promise.resolve("");
    if (provider === "codex") return this.probeCodexVersion();
    if (provider === "claude") return this.probeClaudeVersion();
    if (provider === "gemini") return this.probeGeminiVersion();
    if (provider === "muse") return this.probeMuseVersion();
    if (this.grokVersionProbe) return this.grokVersionProbe;
    this.grokVersionProbe = (async () => {
      const cliPath = this.locateProvider("grok");
      if (!cliPath) return "";
      const output = await this.readGrokVersion(cliPath);
      this.postProviderState();
      return this.providerCliVersions.grok ?? output;
    })();
    return this.grokVersionProbe;
  }

  /** Read `codex --version` once per activation. The adapter handshake reports
   * its own package version, not the binary it launches. */
  /**
   * Update the Codex or Claude CLI the way it was INSTALLED (upstream 22443dc,
   * a896ba1): an npm global install is reinstalled into its own prefix (npm's
   * configured prefix can differ and fail with EACCES), anything else runs the
   * CLI's own updater, and the Codex we manage goes through our installer.
   * In VS Code it runs in a visible terminal — these are the person's own
   * global installs, so nothing happens silently. Refresh re-reads the version.
   */
  private async updateProviderCli(provider: unknown): Promise<void> {
    return this.cliUpdateHost.updateProviderCli(provider);
  }

  private async refreshModelsIfCliChanged(provider: AcpProvider, version: string): Promise<void> {
    return this.cliUpdateHost.refreshModelsIfCliChanged(provider, version);
  }

  private probeCodexVersion(): Promise<string> {
    return this.cliUpdateHost.probeCodexVersion();
  }

  private probeClaudeVersion(): Promise<string> {
    return this.cliUpdateHost.probeClaudeVersion();
  }

  private probeMuseVersion(): Promise<string> {
    return this.cliUpdateHost.probeMuseVersion();
  }

  private probeGeminiVersion(): Promise<string> {
    return this.cliUpdateHost.probeGeminiVersion();
  }

  /** Once per extension upgrade, from session start, with a fresh install only
   * establishing the baseline. Bounded at 20s and attempted ONCE per extension
   * version whether or not it succeeds — it blocks the composer, and a network
   * that cannot reach x.ai would otherwise re-charge that wait on every
   * window. */
  private async maybeUpdateCliOnUpgrade(cliPath: string): Promise<void> {
    return this.providerSession.maybeUpdateCliOnUpgrade(cliPath);
  }

  private async planModeCompatibility(
    cliPath: string,
    opts: { notify?: boolean } = {},
  ): Promise<CliCompatibilityResult> {
    return this.providerSession.planModeCompatibility(cliPath, opts);
  }

  private applyPlanModeCompatibility(session: Session, compatibility: CliCompatibilityResult): void {
    return this.providerSession.applyPlanModeCompatibility(session, compatibility);
  }

  private async recheckPlanModeAvailability(session: Session): Promise<boolean> {
    return this.providerSession.recheckPlanModeAvailability(session);
  }

  /** Pin the bounded Windows stdio-hang range before spawning ACP. */
  private async maybePinBrokenCli(cliPath: string): Promise<void> {
    if (this.brokenCliPinned) return;
    const versionOutput = await this.readGrokVersion(cliPath);
    if (!versionOutput) return;
    if (!isStdioBrokenGrokVersion(versionOutput, process.platform)) {
      this.brokenCliPinned = true;
      return;
    }
    const detected = parseGrokVersion(versionOutput)?.join(".") ?? versionOutput;
    if (await this.downgradeBrokenCli(cliPath, detected, "proactive")) {
      this.brokenCliPinned = true;
    }
  }

  /**
   * Run `grok update --version <supported>` and notify the user, returning true
   * on success during proactive or reactive recovery from a Windows stdio failure.
   */
  private async downgradeBrokenCli(
    cliPath: string,
    fromVersion: string,
    reason: "proactive" | "reactive",
  ): Promise<boolean> {
    this.host.appendLine(
      `grok CLI ${fromVersion} has the stdio regression (issue #22, ${reason}); ` +
        `pinning to ${GROK_STDIO_DOWNGRADE_TARGET}.`,
    );
    this.post({ type: "cliUpdating" });
    try {
      const { stdout, stderr } = await execGrokCli(
        cliPath,
        ["update", "--version", GROK_STDIO_DOWNGRADE_TARGET],
        { timeout: 180_000 },
      );
      if (stdout?.trim()) this.host.appendLine(stdout.trim());
      if (stderr?.trim()) this.host.appendLine(stderr.trim());
      const detail = reason === "proactive"
        ? `Grok CLI ${fromVersion} has a known Windows startup issue (issue #22). Switched to the supported version ${GROK_STDIO_DOWNGRADE_TARGET}.`
        : `Grok CLI ${fromVersion} failed to start a session (issue #22). Switched to the supported version ${GROK_STDIO_DOWNGRADE_TARGET} and retrying.`;
      void this.host.showInformationMessage(detail);
      return true;
    } catch (e) {
      this.host.appendLine(`grok recovery update to ${GROK_STDIO_DOWNGRADE_TARGET} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * On-demand "is a newer grok available?" check for Settings → About.
   * Read-only — `grok update --check --json` doesn't touch the binary, so it's
   * safe while a session is live. Posts a grokUpdateStatus back to the webview.
   */
  private async checkGrokUpdate(): Promise<void> {
    return this.cliUpdateHost.checkGrokUpdate();
  }

  private async updateGrokCliOnDemand(): Promise<void> {
    return this.cliUpdateHost.updateGrokCliOnDemand();
  }

  private async runGrokUpdate(
    cliPath: string,
    updateArgs: string[],
    notifyFailure = true,
  ): Promise<boolean> {
    return this.cliUpdateHost.runGrokUpdate(cliPath, updateArgs, notifyFailure);
  }

  /** Persist a picker choice where the next read will actually find it: every
   *  read here asks for the EFFECTIVE value, so a workspace value outranks a
   *  Global write and the control snapped back to it (upstream #162). */
  private async rememberGrokConfig(key: "defaultEffort" | "defaultModel" | "defaultMode", value: string): Promise<void> {
    const cfg = this.host.getConfiguration("grok");
    await cfg.update(key, value, configWriteTarget(cfg.inspect<string>(key)));
  }

  /** Remember a reasoning-effort choice for the agent it was made in. The
   *  legacy single `grok.defaultEffort` is kept in step for grok so an existing
   *  setting keeps working and older hosts still read something sensible. */
  private async persistEffort(provider: AcpProvider, level: string): Promise<void> {
    const cfg = this.host.getConfiguration("grok");
    const next = withRememberedEffort(cfg.get<EffortPrefs>("defaultEffortByProvider", {}), provider, level);
    try {
      await cfg.update("defaultEffortByProvider", next, configWriteTarget(cfg.inspect<EffortPrefs>("defaultEffortByProvider")));
      if (provider === "grok") await this.rememberGrokConfig("defaultEffort", level);
    } catch {
      // Best-effort persistence: a host settings write failure should not break the session effort switch
    }
  }

  /** Confirm a restart for a setting that only applies on a fresh session
   *  (reasoning effort, cross-agent model). Returns the chosen restart mode, or
   *  undefined if the user dismissed the dialog. */
  private async pickRestartMode(message: string): Promise<"clear" | "summarize" | undefined> {
    // Restarting plainly is offered first, and the cost of the alternative is
    // named: summarizing runs two extra model turns — one over the whole
    // conversation — and neither of them appears in the transcript.
    const choice = await this.host.showInformationMessage(
      `${message} Summarizing first spends two extra model turns.`,
      "Just Restart",
      "Summarize & Restart",
    );
    if (!choice) return undefined;
    return choice === "Just Restart" ? "clear" : "summarize";
  }

  /** Restart the session. "clear" drops the visible history; "summarize" first
   *  captures a one-paragraph summary of the conversation and re-injects it as
   *  hidden context after the restart so the new session keeps the thread. */
  private async restartSession(mode: "clear" | "summarize", session: Session = this.focused): Promise<void> {
    if (mode === "clear") {
      this.emit(session, { type: "clearMessages" });
      await this.startSession(undefined, session);
      return;
    }
    const currentClient = session.client;
    this.emit(session, { type: "summarizing" });
    const chunks: string[] = [];
    const captureChunk = (t: string) => chunks.push(t);
    currentClient?.on("messageChunk", captureChunk);
    session.suppressContent = true;
    try {
      await currentClient?.prompt(
        "Summarize our conversation so far in a concise paragraph. Be brief.",
      );
    } catch { /* best effort */ } finally {
      currentClient?.off("messageChunk", captureChunk);
      session.suppressContent = false;
    }
    const summary = chunks.join("").trim();

    await this.startSession(undefined, session); // resets suppressContent

    if (summary && session.client) {
      this.emit(session, { type: "sessionContext" });
      session.suppressContent = true;
      try {
        await session.client.prompt(`[Context from previous session]\n${summary}`);
      } catch { /* best effort */ } finally {
        session.suppressContent = false;
      }
    }
  }

  /** A model/effort switch on an empty session (no real conversation) restarts it with a new
   *  grok session id. grok already persisted the abandoned one, so without this each repeated switch
   *  would pile another empty session into history. Drop the old session's on-disk dir and carry any
   *  user rename (`customName`) onto the new session so the chosen name survives the restart. The
   *  caller must only invoke this when the prior session genuinely had no history. No-op if the ids
   *  match or the old session was never persisted. */
  private discardRestartedEmptySession(oldId: string | undefined, session: Session = this.focused): void {
    const newId = session.activeSessionId;
    if (!oldId || oldId === newId) return;
    // Restart keeps the same session.cwd (workspace or worktree).
    const cwd = this.sessionCwd(session);
    const grokHome = resolveGrokHome(process.env);
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id: oldId });
    } catch (e) {
      this.host.appendLine(`[sessions] could not discard empty session ${oldId}: ${(e as Error).message}`);
    }
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // carrySessionName only moves customName — also carry worktree binding so a
    // model switch mid-worktree session doesn't lose Apply/Remove.
    let next = carrySessionName(overrides, oldId, newId);
    const oldMeta = overrides[oldId];
    if (newId && oldMeta?.worktreePath) {
      next = {
        ...next,
        [newId]: {
          ...(next[newId] ?? {}),
          worktreePath: oldMeta.worktreePath,
          worktreeLabel: oldMeta.worktreeLabel,
          sourceGitRoot: oldMeta.sourceGitRoot
        }
      };
    }
    void this.state.update(SESSION_META_KEY, next);
    this.sessionCache.delete(oldId);
    this.postSessionsList();
  }

  private sessionStartTailMap(): WeakMap<Session, Promise<void>> {
    return (this.sessionStartTails ??= new WeakMap());
  }

  private runExclusiveSessionStart<R>(session: Session, action: () => Promise<R>): Promise<R> {
    const tails = this.sessionStartTailMap();
    const previous = tails.get(session) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(session, tail);
    return run.finally(() => {
      if (tails.get(session) === tail) tails.delete(session);
    });
  }

  private async waitForSessionStart(session: Session): Promise<void> {
    const tail = this.sessionStartTailMap().get(session);
    if (tail) await tail;
  }

  private emitAbandonedSend(session: Session): void {
    if (session.staleSendReported) return;
    session.staleSendReported = true;
    // Generic `error`, not agentError: after a gen bump this Session is the
    // replacement, and agentError would clear its startup lock or a flushed
    // follow-on turn.
    this.emit(session, { type: "error", text: INTERRUPTED_SEND_TEXT, code: INTERRUPTED_SEND_CODE });
  }

  /** `clock` lets a CALLER start the measurement where the user's click landed.
   *  Opening a conversation resolves a cwd, reads session meta and waits on the
   *  workspace queue before it ever reaches here, and a clock made in this
   *  function cannot see any of it — measured at 86-131ms on the QA fixture and
   *  225-352ms once `session-meta.json` reaches the 1.47MB a heavy real store
   *  has (`npm run e2e:open-timing`). That window is where a slow open would
   *  hide, so the callers that have a click to time pass their own. */
  private async startSession(
    resumeId?: string,
    target: Session = this.focused,
    intent: SessionStartIntent = "replace",
    clock?: OpenClock,
  ): Promise<AcpClient | undefined> {
    return this.runExclusiveSessionStart(target, () => this.startSessionBody(resumeId, target, intent, clock));
  }

  private async startSessionBody(
    resumeId: string | undefined,
    target: Session,
    intent: SessionStartIntent,
    startedClock?: OpenClock,
  ): Promise<AcpClient | undefined> {
    // Read the caller's clock BEFORE this function can add to it: the load
    // reservation, the workspace-switch queue, the cwd resolution, the
    // `session-meta.json` read and the wait for the exclusive start lock are
    // all already on it, and all of them belong to `resolve`.
    const clock = startedClock ?? new OpenClock();
    // A re-entry (the reactive downgrade below) arrives with the first pass's
    // phases already on it. Fold them into one NAMED phase and subtract it, so
    // the failed attempt keeps its own number instead of being reported as
    // session resolution. Zero on every ordinary open.
    const priorMs = clock.collapse("downgrade");
    const resolveMs = clock.totalMs() - priorMs;
    let approveGateMs = 0;
    // Desktop with no open folder: empty rail is valid — do not spawn grok
    // against process.cwd(). Unlock the baked "Starting" welcome; returning
    // silently here left first-run / last-project-removed on that spinner
    // forever (the HTML default is busy "Starting", and nothing else cleared
    // it). Adding a folder starts a session via select/switch.
    if (
      this.host.canSwitchWorkspaceFolder &&
      !this.openWorkspaceFolders().length &&
      !resumeId &&
      !target.cwd
    ) {
      this.presentEmptyProjectState(target);
      return undefined;
    }
    // Resume / held-session paths set target.cwd before start. A closed folder
    // must not restart just because resumeId is set (empty-open-set guard above
    // only covers the no-cwd case).
    if (
      this.host.canSwitchWorkspaceFolder &&
      target.cwd &&
      !this.isAuthorizedCwd(target.cwd)
    ) {
      this.host.appendLine(
        `[sessions] refused startSession (cwd not authorized): ${target.cwd}` +
          (resumeId ? ` resumeId=${resumeId}` : ""),
      );
      if (!this.openWorkspaceFolders().length) {
        this.presentEmptyProjectState(target);
      } else {
        target.priming = false;
        this.emit(target, { type: "setBusy", value: false });
        this.postRepoCatalog();
        this.postSessionsList();
      }
      return undefined;
    }
    // An EMPTY conversation pinned to a provider that cannot answer just moves
    // to one that can, silently. There is nothing to preserve — no history, no
    // model choice worth defending — and the alternative is what the owner hit:
    // Grok connected and chosen in the picker, while the turn insisted on
    // finishing a codex login because the session object still said "codex".
    // A conversation WITH history is never retargeted; that would silently
    // change who is answering someone mid-thread.
    //
    // `resumeId` is the other half of "has history": openSession mints a fresh
    // Session (hasHistory still false) and then loads an existing conversation
    // into it. Treating that as empty handed a Grok rail click to Codex, then
    // blamed Codex for the spawn that followed.
    if (!resumeId && !target.hasHistory && !this.usableProviders().includes(target.provider)) {
      const fallback = this.defaultProviderForProject(this.sessionCwd(target));
      if (fallback !== target.provider && this.usableProviders().includes(fallback)) {
        this.host.appendLine(
          `[providers] ${target.provider} cannot answer; empty session retargeted to ${fallback}`,
        );
        target.provider = fallback;
        await this.rememberProjectProvider(this.sessionCwd(target), fallback);
        this.postProviderState();
      }
    }
    if (!this.connectedProviders().includes(target.provider)) {
      const testDelay = this.testSessionStartDelay;
      if (testDelay && testDelay.resumeId === resumeId) {
        this.testSessionStartDelay = undefined;
        testDelay.started();
        await testDelay.wait;
      }
      target.priming = false;
      this.emit(target, { type: "setBusy", value: false });
      this.postProviderState();
      this.emit(target, {
        type: "onboarding",
        // Usable, not connected — with only a lapsed provider left there is
        // nothing to fall back to, so offer the choice rather than this one
        // provider's missing-CLI copy.
        state: this.usableProviders().length ? missingProviderState(target.provider) : "connect-agent",
        platform: process.platform,
        provider: target.provider
      });
      return undefined;
    }
    // A repository that ships its own always-approve config gets consent first.
    // Deliberately here, before anything is mutated: nothing has been touched
    // yet, so declining is a clean no-op rather than a half-started session.
    const consentAt = clock.now();
    if (target.provider === "grok" && !(await this.confirmRepoForcedAutoApprove(this.sessionCwd(target)))) {
      return undefined;
    }
    // Its own phase because a modal is a PERSON reading a dialog, and folded
    // into `resolve` that would report a fast disk lookup as tens of seconds.
    // Named `approve-gate` rather than `consent` because the call also reads
    // project and global config to decide WHETHER to ask — on a slow or network
    // filesystem that is real I/O, and calling it consent would blame a human
    // who was never shown anything.
    approveGateMs = clock.elapsed(consentAt);
    // After the last await before ++gen: a send can have begun a turn (or
    // another start can have finished) while consent was up.
    const startDecision = decideSessionStart(target, resumeId, intent);
    if (startDecision === "reuse" || startDecision === "refuse-turn") {
      if (startDecision === "refuse-turn") {
        this.host.appendLine(`[sessions] refused startSession (turn in flight)`);
      }
      return target.client;
    }
    if (startDecision === "refuse-mismatch") {
      this.host.appendLine(
        `[sessions] refused startSession (ensure resumeId=${resumeId} does not match live session)`,
      );
      return undefined;
    }
    // The session this start (re)builds. Today always the focused one (pool-of-1);
    // Step D passes a pool member. Its handlers close over `session`/`gen` so a
    // backgrounded session's events stay bound to it even after focus moves.
    const session = target;
    // `resolve` is zero when the clock was made in this function, which is the
    // honest answer for the paths with no click to measure from (restart, model
    // change, provider swap).
    clock.record("resolve", resolveMs);
    clock.record("approve-gate", approveGateMs);
    const openedAt = clock.now();
    const replacedClient = session.client;
    if (replacedClient) {
      this.queueInFlightPlanCommentsOnExit(session, replacedClient, session.gen);
    }
    const gen = ++session.gen;
    const testDelay = this.testSessionStartDelay;
    if (testDelay && testDelay.resumeId === resumeId) {
      this.testSessionStartDelay = undefined;
      testDelay.started();
      await testDelay.wait;
      if (gen !== session.gen) return undefined;
    }
    const keepTranscript = session.keepTranscriptOnStart === true;
    session.keepTranscriptOnStart = false;
    if (!keepTranscript) session.buffer = [];
    session.subscriptionUsage = undefined;
    session.status = "idle";
    // The replacement session has no turn, whatever the old one was doing. This
    // matters most in the case the token exists for: a `prompt()` that never
    // settles never runs its `finally`, so the token outlives the client that
    // owned it — and resetting only `status` (which is all this used to have to
    // do) would leave the fresh session reporting a turn in flight and diverting
    // every send into the queue. A restart has always been the cure for a wedged
    // session; it stays the cure.
    session.turnToken = undefined;
    // Stop any in-progress voice capture so listening never carries across a
    // new/resumed/restarted session (covers New Session, history resume, and
    // model/effort restarts — all of which route through here).
    this.stopVoiceInput(session);
    this.drainPendingConfirms(session);
    session.client = undefined;
    // Detach and dispose as one structural operation. Nothing that can return
    // belongs between these lines: the old ACP callbacks remain live until the
    // process has actually exited.
    const disposeAt = clock.now();
    if (replacedClient) {
      // Its commands go with it, exactly as in detachClient — this path does
      // not go through that function but tears a client down all the same.
      // A cancel the CLI ignored replaces the client mid-turn, and without
      // this its terminals stay in the manager with no agent that could ever
      // release them: a running command with no owner, holding a rented
      // machine awake for the rest of the session.
      try {
        const n = this.terminalManager.releaseOwnedBy(replacedClient);
        if (n > 0) this.host.appendLine(`[terminal] released ${n} command(s) with the replaced client`);
      } catch { /* teardown is not worth failing over */ }
      await replacedClient.dispose();
      if (gen !== session.gen) return undefined;
    }
    const disposeMs = replacedClient ? clock.elapsed(disposeAt) : 0;
    clock.record("dispose", disposeMs);
    // A brand-new session starts in the remembered mode (#25) immediately, so the
    // toolbar shows the right one from the first paint — no Agent → Auto accept
    // flash while the session spins up and primes. Resumed sessions stay
    // verdict-driven (plan-restore decides), so they don't pre-apply it.
    const rememberedYolo = startsInYolo(
      this.host.getConfiguration("grok").get<string>("defaultMode", ""),
      !!resumeId,
    );
    // grok's own `permission_mode = "always-approve"` (config.toml, set via
    // Shift+Tab or `/always-approve`) auto-approves every session server-side
    // and is invisible over ACP — the CLI still reports plain agent mode. Detect
    // it so the button shows "Auto accept" instead of a misleading "Agent" (#31).
    // Applies to resumed sessions too (the config is global, not per-session).
    const configAutoApprove = session.provider === "grok" && this.configForcesAutoApprove(this.sessionCwd(session));
    session.autoApprove = rememberedYolo || configAutoApprove;
    session.planActive = false;
    // Session grants never outlive the process they were given to.
    session.sessionPermissionRules = [];
    // A resume is assumed to have history (which locks the provider) until a
    // successful replay proves otherwise — see replaySessionHistory.
    session.hasHistory = !!resumeId;
    session.suppressContent = false;
    session.captureAgentText = undefined;
    session.lastSessionInfoAt = 0;
    session.lastSessionInfoUsed = undefined;
    session.sessionInfoStale = false;
    session.sessionInfoUnsupported = false;
    session.sawCompactNotification = false;
    session.lastPlanText = "";
    // A new, resumed or restarted conversation starts with no checklist. The
    // paired `clearMessages` below empties the rail on the webview side, so
    // this needs no message of its own. Review-center rows rebuild from
    // replayed tool calls the same way.
    session.planEntries = [];
    session.reviewBlocks = [];
    session.pendingExitPlans.clear();
    this.dropPendingQuestions(session);
    // The old process's MCP children hold a token that must stop working the
    // moment this session restarts — otherwise a stale child could still raise
    // a card against a conversation that no longer exists.
    this.revokeAskUserToken(session);
    session.inFlightPlanComments.clear();
    if (session.planModeRecovery?.warningTimer) clearTimeout(session.planModeRecovery.warningTimer);
    session.planModeRecovery = undefined;
    session.interjectionCount = 0;
    session.historyEventCount = 0;
    session.replayUserRaw = "";
    session.replayUserCounted = false;
    session.replayUserIsInterjection = false;
    session.userMessageCount = 0;
    session.inUserMessage = false;
    session.feedbackAvailable = false;
    session.feedbackUnsupported = false;
    session.feedbackMetaEnabled = undefined;
    session.feedbackCommandsAdvertise = undefined;
    session.liveFeedbackEligible = false;
    session.turnRating = 0;
    session.activeSessionId = undefined;
    session.titleGenerated = false;
    session.firstUserMessageForTitle = undefined;
    session.priming = true;
    session.compactUsageArmed = false;
    session.adapterCompactThisTurn = false;
    session.adapterTurnCallUsed = [];
    // session.authRecoveryTried deliberately NOT reset here: recoverAuthAndResend
    // calls startSession as its own retry, and a reset would let an entitlement
    // failure (#58) pay a full restart+resend cycle on every prompt. Only a clean
    // turn re-arms it.
    this.emit(session, { type: "modeChanged", modeId: session.autoApprove ? "yolo" : "agent" });
    if (configAutoApprove) this.noticeAlwaysApproveOnce(this.sessionCwd(session));
    if (resumeId) this.emit(session, { type: "clearMessages" });

    // Lock the composer (spinner, disabled) for start() + newSession()/load so a
    // prompt cannot be sent before the session exists. Success and failure paths
    // both clear this startup lock below.
    this.emit(session, { type: "setBusy", value: true, locked: true });

    const cfg = this.host.getConfiguration("grok");
    const cliPath = this.locateProvider(session.provider);
    if (!cliPath) {
      if (gen !== session.gen) return undefined;
      this.pool.delete(session);
      session.priming = false;
      this.emit(session, { type: "setBusy", value: false });
      this.emit(session, {
        type: "onboarding",
        state: missingProviderState(session.provider),
        platform: process.platform,
        provider: session.provider
      });
      return undefined;
    }

    // Keep the established once-per-extension-upgrade update trigger, then read
    // the resulting version solely to decide whether Plan is safe to expose
    // and which initialize handshake to advertise.
    // Everything before the version probe that is not the dispose itself. Cheap
    // in principle — mode/flag resets — which is exactly why it needs measuring
    // rather than assuming: an open that is slow here would otherwise land in
    // `other` with nothing to point at.
    clock.record("prep", Math.max(0, clock.elapsed(openedAt) - disposeMs));
    const versionAt = clock.now();
    let versionNote: string | undefined;
    let grokHandshakeVersion: string | undefined;
    let grokVersionVerified = false;
    if (session.provider === "grok") {
      await this.maybeUpdateCliOnUpgrade(cliPath);
      if (gen !== session.gen) return undefined;
      await this.maybePinBrokenCli(cliPath);
      if (gen !== session.gen) return undefined;
      const compatibility = await this.planModeCompatibility(cliPath);
      if (gen !== session.gen) return undefined;
      if (compatibility.usedCache) versionNote = "cached";
      // initialize cannot be renegotiated; only a live probe may change the fs handshake.
      grokVersionVerified = compatibility.planModeVersionVerified;
      grokHandshakeVersion = grokVersionVerified
        ? compatibility.cliVersion
        : undefined;
      this.applyPlanModeCompatibility(session, compatibility);
    } else {
      session.planModeAvailable = true;
      session.planModeVersionVerified = true;
      session.planModeUnavailableReason = undefined;
      this.emit(session, {
        type: "providerCapabilities",
        provider: session.provider,
        capabilities: allProviderCapabilities(session.provider, {
          planModeAvailable: true,
          cliVerified: true
        })
      });
    }
    clock.record("version", clock.elapsed(versionAt), versionNote);
    const afterVersionAt = clock.now();

    // Worktree sessions pin cwd at creation/open; everyone else uses the workspace root.
    const cwd = session.cwd || this.workspaceRoot();
    session.cwd = cwd;
    // Re-bind worktree meta from override when resuming (cold open may only have cwd).
    if (!session.worktree && resumeId) {
      const o = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[resumeId];
      if (o?.worktreePath) {
        session.worktree = {
          path: o.worktreePath,
          label: o.worktreeLabel || path.basename(o.worktreePath),
          sourceGitRoot: o.sourceGitRoot || this.workspaceRoot()
        };
      }
    }
    if (this.mcpConnectorKeysReady !== undefined) await this.mcpConnectorKeysReady;
    if (gen !== session.gen) return undefined;
    const env = session.provider === "grok" ? this.buildEnv(cwd) : { ...process.env };
    session.compactThresholdRequested = session.provider === "grok" ? normalizeCompactThreshold(env[GROK_COMPACT_ENV]) : undefined;
    session.compactThresholdChecked = false;
    // A role's effort (AP-10) wins over the remembered default, and it is
    // applied HERE — on the spawn, ahead of `session/new` — because that is the
    // only place grok takes `--reasoning-effort` at all and the only point an
    // adapter's `setReasoningEffort` runs before the first turn.
    const effortStr = session.startOverrides?.effort
      || rememberedEffort(
        cfg.get<EffortPrefs>("defaultEffortByProvider", {}),
        session.provider,
        cfg.get<string>("defaultEffort", ""),
      );
    const effort = effortStr ? (effortStr as EffortLevel) : undefined;
    // Transient spawn/init after an update can throw once; retry the plain
    // failure only (auth and the Windows stdio pin keep their own paths).
    const startSpawnAttempts = 3;
    const startSpawnBackoffMs = [300, 900] as const;
    const createBoundClient = (): AcpClient => {
    const client = new AcpClient({
      cliPath,
      cwd,
      env,
      effort,
      log: (msg) => this.host.appendLine(msg),
      timeouts: this.acpClientTimeouts(),
      // The Muse adapter takes no host MCP servers (capability clientMcp).
      mcpServers: async () => supportsClientMcpServers(session.provider) ? this.hostMcpServersFor(session) : [],
      ...(session.provider === "grok"
        ? { grokVersion: grokHandshakeVersion, grokVersionVerified }
        : { backend: this.createProviderBackend(session.provider, effort) })
    });
    session.client = client;
    this.syncHumanWait(session);
    // A replacement process may have gained the capability after a CLI update.
    session.lastSessionInfoAt = 0;
    session.lastSessionInfoUsed = undefined;
    session.sessionInfoStale = false;
    session.sessionInfoUnsupported = false;

    // fs handlers. Still wired on every session: 0.2.x, unverified, and Codex
    // advertise readTextFile and will call them. A live-verified grok >= 1.0.4
    // currently will not (withheld read → no client fs at all) but a later CLI
    // may honour writeTextFile independently.
    client.fsRead = async (p: string) => {
      try {
        // Agent paths are genuine workspace disk paths on the extension host.
        const bytes = await this.host.fs.readFile(Uri.file(p));
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return fs.readFileSync(p, "utf8");
      }
    };
    client.fsWrite = async (p: string, content: string) => {
      this.snapshotAbsPaths(session, [p]);
      this.noteCheckpointAfterContent(session, p, content);
      try {
        await this.host.fs.createDirectory(Uri.file(path.dirname(p)));
        await this.host.fs.writeFile(Uri.file(p), Buffer.from(content, "utf8"));
      } catch {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    // Owned by this client, so tearing it down takes its commands with it.
    client.terminal = this.terminalManager.ownedBy(client);

    client.on("initialized", (init) => {
      if (gen !== session.gen) return;
      this.warnOAuthShadowOnce(init?._meta?.defaultAuthMethodId, env);
      const handshakeVersion = init?.serverInfo?.version ?? init?.version ?? null;
      if (session.provider === "grok" && typeof handshakeVersion === "string" && handshakeVersion.trim()) {
        this.providerCliVersions.grok = handshakeVersion.trim().replace(/^v/i, "");
        this.postProviderState();
      }
      this.emit(session, {
        type: "initialized",
        info: {
          cliPath,
          cwd,
          version: handshakeVersion,
          provider: session.provider,
          init: { protocolVersion: init?.protocolVersion },
          // Host-confirmed at initialize by the backend (upstream 2f67d9a):
          // the webview stops guessing Steer from a provider list.
          steeringSupported: client.supportsInterject?.() ?? false
        }
      });
    });
    client.on("session", (res) => {
      if (gen !== session.gen) return;
      if (res?.sessionId) session.activeSessionId = res.sessionId;
      this.cacheProviderModels(session.provider, client.availableModels, client.currentModelId);
      if (res?.sessionId) {
        void this.updateSessionMeta((current) => ({
          ...current,
          [res.sessionId]: {
            ...(current[res.sessionId] ?? {}),
            provider: session.provider,
            providerCwd: cwd
          }
        }));
      }
      this.emit(session, {
        type: "session",
        sessionId: res.sessionId,
        models: this.modelsForSession(session, client.availableModels, client.currentModelId, !resumeId || (session.historyEventCount === 0 && session.userMessageCount === 0)),
        currentModelId: client.currentModelId,
        worktree: !!session.worktree,
        provider: session.provider
      });
      if (session.provider === "grok") {
        const metaEnabled = parseFeedbackEnabledMeta(res);
        if (metaEnabled !== undefined) session.feedbackMetaEnabled = metaEnabled;
        this.refreshFeedbackAvailability(session);
      }
    });
    client.on("sessionTitle", (title: string) => {
      if (gen !== session.gen || !title.trim()) return;
      const sid = client.sessionId ?? session.activeSessionId;
      if (!sid) return;
      void this.updateSessionMeta((current) => {
        const entry = current[sid];
        const autoName = capAutoName(title);
        if (!autoName || entry?.customName || entry?.autoName === autoName) return null;
        return { ...current, [sid]: { ...(entry ?? {}), autoName } };
      }).then(() => {
        this.sessionCache.delete(sid);
        this.postSessionName(session);
        this.postSessionsList();
      });
    });
    client.on("modelChanged", (id) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "modelChanged", modelId: id });
    });
    client.on("modeChanged", (id) => {
      if (gen !== session.gen) return;
      if (id === "plan") {
        // Raise the safety gate synchronously for every Plan transition. During
        // session/load, current_mode_update events replay before AcpClient has a
        // sessionId, so defer the unavailable-mode set_mode RPC to the existing
        // post-load restore block without ever leaving the gate down.
        session.autoApprove = false;
        this.setPlanActive(session, true);
        if (!session.planModeAvailable) {
          if (session.replaying) return;
          this.recoverUnavailablePlanMode(session, client, gen);
          return;
        }
        // CLI entered plan mode (covers the agent self-initiating it from a
        // natural-language request). Raise our gate so the exit is enforced.
      } else if (!client.usesClientPlanGate) {
        // Claude ExitPlanMode / Codex plan approval switch to a writable mode
        // and then edit. Follow that mode so the button and permission filter
        // stop saying Plan. Grok's descriptive update must not do this.
        const next = applyAgentModeToHostPlan(id, false);
        if (next) {
          session.autoApprove = next.autoApprove;
          this.setPlanActive(session, next.planActive);
        }
      } else if (session === this.focused) {
        // A non-plan update is descriptive, not authority to lower the safety
        // gate. The verdict handler settles that gate before its response; direct
        // Agent/YOLO choices do so in setMode. Just refresh the button label.
        this.postMode();
      }
    });
    client.on("commandsUpdate", (cmds) => {
      if (gen !== session.gen) return;
      const merged = [...cmds];
      for (const hostCmd of EXTENSION_HOST_SLASH_COMMANDS) {
        if (!merged.some((c) => c.name === hostCmd.name)) {
          merged.push(hostCmd);
        }
      }
      this.emit(session, { type: "commandsUpdate", commands: merged });
      if (session.provider === "grok") {
        session.feedbackCommandsAdvertise = commandsAdvertiseFeedback(cmds);
        this.refreshFeedbackAvailability(session);
      }
    });
    client.on("messageChunk", (text: string) => {
      if (gen !== session.gen) return;
      // AP-10: a role run reads the reply while it still renders and still
      // bills. Additive on purpose — see Session.agentTextTap.
      session.agentTextTap?.(text);
      if (session.captureAgentText !== undefined) {
        session.captureAgentText += text;
        return;
      }
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "messageChunk", text });
      this.noteAdapterCompactSignal(session, text);
    });
    client.on("userMessageChunk", (text: string, meta?: any) => {
      if (gen !== session.gen) return;
      // grok ≥0.2.33 echoes the *live* prompt back as user_message_chunk; 0.2.3
      // did not (its comment here read "the agent never echoes them back"). The
      // live bubble + userMessageCount come from send(), so a forwarded live
      // echo would render a duplicate bubble and double-count. Only the CLI's
      // session/load *replay* should drive user bubbles from here.
      if (!session.replaying) return;
      // Older extension sessions contain a hidden primer user turn. Don't count
      // it toward plan positions, but forward it so the webview's matching
      // legacy pattern suppresses the primer bubble and grok's acknowledgement.
      if (!session.inUserMessage && isPrimerText(text)) {
        session.inUserMessage = true;
        this.emit(session, {
          type: "userMessageChunk",
          text,
          timestampMs: agentTimestampMsFromMeta(meta),
          images: historyImagePreviews(text, this.imageStagingDir(), this.sessionCwd(session))
        });
        return;
      }
      // The first chunk after a non-user chunk marks the start of a new user
      // message — count it so the next persisted plan knows where it lives.
      // Count ONLY turns the webview renders as bubbles (countsAsUserBubble):
      // <system-reminder> turns and marker-only verdicts replay as user
      // messages but paint nothing, and counting them here inflated every
      // post-restore verdict position — those plan/permission cards then
      // landed at the END of the conversation on the next restore.
      if (!session.inUserMessage) {
        session.replayUserRaw = "";
        session.replayUserCounted = countsAsUserBubble(text);
        // The turn's start edge for a restored footer's duration: the newest
        // replayed user message's own wall-clock time. Only kept when the user
        // bubble actually renders (countsAsUserBubble) — a hidden primer or
        // system-reminder turn is not a turn the footer describes.
        session.replayTurnStartedAt = session.replayUserCounted
          ? agentTimestampMsFromMeta(meta)
          : undefined;
        session.replayUserIsInterjection = false;
        if (session.replayUserCounted) session.userMessageCount += 1;
        session.inUserMessage = true;
      }
      session.replayUserRaw += text;
      if (!session.replayUserIsInterjection && isInterjectionText(session.replayUserRaw)) {
        session.replayUserIsInterjection = true;
        session.interjectionCount += 1;
        if (session.replayUserCounted) {
          session.userMessageCount = Math.max(0, session.userMessageCount - 1);
          session.replayUserCounted = false;
        }
        // An interjection rides a running turn — it is never the turn the next
        // turn_completed duration is measured from.
        session.replayTurnStartedAt = undefined;
      }
      // No counter to re-seed: numbering restarts at #1 on every message, so a
      // restored conversation's tags say nothing about what the next one gets.
      // (Old transcripts written under the session-scoped scheme still render
      // correctly — the previews below are matched to the tags found in the
      // very same text, whatever numbers that text happens to carry.)
      this.emit(session, {
        type: "userMessageChunk",
        text,
        timestampMs: agentTimestampMsFromMeta(meta),
        images: historyImagePreviews(
          session.replayUserRaw,
          this.imageStagingDir(),
          this.sessionCwd(session),
        )
      });
    });
    client.on("thoughtChunk", (text: string) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "thoughtChunk", text });
    });
    const mcpState = createMcpPrepareState();
    client.on("childStream", (ev: { childSessionId: string; route: UpdateRoute }) => {
      if (gen !== session.gen) return;
      const payload = childStreamFromRoute(ev.childSessionId, ev.route);
      if (!payload) return;
      if (payload.event === "toolCall" || payload.event === "toolCallUpdate") {
        const prepared = prepareMcpToolCall(payload.call, mcpState);
        this.emit(session, { type: "childStream", ...payload, call: prepared.call });
        this.noteReviewToolCall(session, prepared.call);
        return;
      }
      this.emit(session, { type: "childStream", ...payload });
    });
    client.on("mediaContent", (m: MediaRef) => {
      if (gen !== session.gen) return;
      void this.postGeneratedMedia(m, session, gen);
    });
    client.on("taskBackgrounded", (u: any) => {
      if (gen !== session.gen) return;
      const cmd = typeof u?.command === "string" ? u.command : "";
      this.host.appendLine(`[task] backgrounded: ${cmd.slice(0, 200)}`);
    });
    client.on("taskCompleted", (u: any) => {
      if (gen !== session.gen) return;
      // A long-running background command finished. Surface it as a one-shot
      // toast, NOT a chat bubble — the CLI separately feeds a <system-reminder>
      // back to grok (the webview drops that on replay). Skipped during replay so
      // a resumed session doesn't re-announce tasks that finished long ago.
      if (session.replaying) return;
      const snap = u?.task_snapshot ?? u ?? {};
      const cmd = typeof snap.command === "string" ? snap.command : "";
      const exit = snap.exit_code ?? snap.exitCode ?? snap.status?.exitCode;
      const ok = exit == null || exit === 0;
      const label = summarizeBackgroundCommand(cmd);
      const text = `Grok background task ${ok ? "completed" : `exited (code ${exit})`}${label ? `: ${label}` : ""}`;
      this.host.appendLine(`[task] ${text}`);
      void this.host.showInformationMessage(text, "Show Logs").then((choice) => {
        if (choice === "Show Logs") this.host.showOutput();
      });
    });
    const replayedCommandOutputs = new Set<string>();
    const replayedCommandsByToolCallId = new Map<string, string>();
    const emitReplayedCommandOutput = (call: unknown) => {
      const replayed = commandOutputForToolCall(call, {
        replaying: session.replaying,
        rememberedCommands: replayedCommandsByToolCallId
      });
      if (!replayed) return;
      const id = typeof (call as { toolCallId?: unknown })?.toolCallId === "string"
        && (call as { toolCallId: string }).toolCallId
        ? (call as { toolCallId: string }).toolCallId
        : replayed.command;
      if (replayedCommandOutputs.has(id)) return;
      replayedCommandOutputs.add(id);
      this.emit(session, { type: "commandOutput", ...replayed });
    };
    const emitToolCallEvent = (type: "toolCall" | "toolCallUpdate", u: unknown) => {
      const prepared = prepareMcpToolCall(u, mcpState);
      session.inUserMessage = false;
      session.historyEventCount += 1;
      if (!session.replaying) this.snapshotPendingEditToolCall(session, prepared.call);
      this.emit(session, { type, call: prepared.call });
      this.noteReviewToolCall(session, prepared.call);
      this.noteAdapterCompactSignal(session, prepared.call);
      if (prepared.commandOutput) {
        this.emit(session, { type: "commandOutput", ...prepared.commandOutput });
      }
      emitReplayedCommandOutput(prepared.call);
    };
    client.on("toolCall", (u) => {
      if (gen !== session.gen) return;
      emitToolCallEvent("toolCall", u);
    });
    client.on("toolCallUpdate", (u) => {
      if (gen !== session.gen) return;
      this.closeQuestionsForToolCall(session, u);
      emitToolCallEvent("toolCallUpdate", u);
    });
    client.on("plan", (u) => {
      if (gen !== session.gen) return;
      this.applyPlanUpdate(session, u);
    });
    client.on("promptComplete", (meta) => {
      if (gen !== session.gen) return;
      const gated = gateZeroTokenMeta(meta);
      if (isAdapterProvider(session.provider) && !session.replaying) {
        // Stale partitions on a zero-inference compact turn are the previous
        // turn replayed — observing them would undo the compact reset.
        // Claude's result usage is a SUM; occupancy is the largest call.
        const occupancy = this.adapterTurnOccupancy(session, meta);
        const remembered = this.rememberAdapterContext(session, occupancy !== undefined ? { occupancy } : {});
        this.emit(session, {
          type: "promptComplete",
          meta: { ...gated, totalTokens: remembered?.used ?? gated.totalTokens }
        });
      } else {
        if (
          typeof gated.totalTokens === "number"
          && session.lastSessionInfoUsed != null
          && gated.totalTokens !== session.lastSessionInfoUsed
        ) {
          session.sessionInfoStale = true;
        }
        this.emit(session, { type: "promptComplete", meta: gated });
      }
      // The hidden legacy `/session-info` fallback is a CLI-local meter, not a
      // user turn. Do not add its zero-inference response to the billing ledger.
      if (session.captureAgentText === undefined) void this.accumulateUsage(session, meta);
      session.adapterTurnCallUsed = [];
      if (!session.replaying) this.finishCheckpointTurn(session);
      // A zero report (stripped above) is /compact or /session-info; neither
      // warrants a donut update here. /session-info leaves the context
      // untouched, and after /compact the fresh count comes from the live
      // auto_compact_completed notification (primary; xaiNotification listener)
      // or the live session/update envelope — reading signals.json now would
      // fetch the stale pre-compact count (the CLI recomputes it only at the
      // next inference turn's end; research/signals-refresh-probe.cjs).
    });
    client.on("contextUsage", (used: number | undefined, window?: number) => {
      if (gen !== session.gen) return;
      if (isAdapterProvider(session.provider)) {
        // Window only. Occupancy is remembered from prompt size / compact,
        // never from billed usage_update.used.
        this.rememberAdapterContext(session, {
          ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {})
        });
        return;
      }
      if (
        typeof used === "number" && Number.isFinite(used) && used > 0
        && session.lastSessionInfoUsed != null
        && used !== session.lastSessionInfoUsed
      ) {
        session.sessionInfoStale = true;
      }
      this.emit(session, {
        type: "contextUsage",
        ...(typeof used === "number" && Number.isFinite(used) && used > 0 ? { used } : {}),
        ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {})
      });
    });
    client.on("subscriptionUsage", (windows: SubscriptionWindow[]) => {
      if (gen !== session.gen || session.client !== client || session.replaying) return;
      session.subscriptionUsage?.observe(windows);
      this.publishSubscriptionUsage(session);
    });
    client.on("adapterUsageUpdate", (used: number, window?: number) => {
      if (gen !== session.gen) return;
      if (!isAdapterProvider(session.provider) || session.replaying) {
        if (typeof window === "number" && Number.isFinite(window) && window > 0) {
          this.rememberAdapterContext(session, { window });
        }
        return;
      }
      if (session.compactUsageArmed) {
        session.compactUsageArmed = false;
        this.rememberAdapterContext(session, {
          occupancy: used,
          compacted: true,
          ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {})
        });
        return;
      }
      if (typeof used === "number" && Number.isFinite(used) && used > 0) {
        session.adapterTurnCallUsed.push(used);
      }
      if (typeof window === "number" && Number.isFinite(window) && window > 0) {
        this.rememberAdapterContext(session, { window });
      }
    });
    client.on("mcpNotification", (method: string, params: unknown) => {
      if (gen !== session.gen) return;
      this.applyMcpNotification(session, method, params);
    });
    client.on("xaiNotification", (u) => {
      if (gen !== session.gen) return;
      // The post-compaction context size rides this live rail
      // (`_x.ai/session_notification`): `auto_compact_completed.tokens_after` is
      // the fresh count for BOTH a manual /compact and the CLI's automatic
      // compaction. The turn meta reports it as 0 and signals.json won't hold it
      // until the next inference turn, so this notification is the only instant
      // source (research/oss-surfaces-probe.cjs, grok 0.2.101). The donut tracks
      // the window itself (modelChanged), so pushing `used` alone updates it.
      const kind = (u as { sessionUpdate?: string })?.sessionUpdate;
      const compactUsed = contextUsedFromCompactNotification(u);
      if (compactUsed !== null) {
        this.emit(session, { type: "contextUsage", used: compactUsed });
        session.sawCompactNotification = true;
      }
      // Compaction FAILED (either path — compaction.rs emits it on both). The
      // context is unchanged, so the donut needs no refresh; flag it so a manual
      // /compact paints the failure instead of a false "Compacted.", and surface
      // a note.
      if (kind === "auto_compact_failed") {
        session.sawCompactNotification = true;
        session.sawCompactFailed = true;
        const err = (u as { error?: unknown })?.error;
        this.emit(session, {
          type: "autoCompactNotice",
          text: typeof err === "string" && err.trim() ? `Compaction failed: ${err.trim()}` : "Compaction failed."
        });
      }
      const compactKind = compactEventKind(u);
      if (compactKind === "cancelled") {
        this.emit(session, { type: "autoCompactNotice", text: "Compaction cancelled." });
      }
      if (compactKind === "completed") {
        session.nearFullArmed = true;
        session.compactionCount += 1;
        const summary = compactSummaryPreview(u);
        if (summary) this.emit(session, { type: "compactSummary", summary });
      }
      // Subagent lifecycle rides this LIVE rail (not the persist/replay
      // subagentLifecycle channel). Re-route to the same `subagentUpdate` the
      // webview cards already consume — subagent_finished fills duration/output.
      if (isSubagentLifecycleUpdate(u)) {
        this.emit(session, { type: "subagentUpdate", update: u });
        this.noteNativeChild(session, u);
      }
      // Deep Research / Workflow / Goal progress (P2-10) — same live rail.
      // Normalized once so the webview only sees a stable card shape.
      const runProg = parseRunProgressUpdate(u);
      if (runProg) this.emit(session, { type: "runProgress", update: runProg });
      // Automatic (context-full) compaction was previously silent — surface a
      // dedicated notice (auto-path only; manual /compact paints "Compacted."
      // from the slash path). Dedicated (not a messageChunk) so it finalizes any
      // active bubble and can't reorder the agent's answer. Not persisted.
      const autoCompactNote = autoCompactStartedNote(u);
      if (autoCompactNote) this.emit(session, { type: "autoCompactNotice", text: autoCompactNote });
      // NB: the raw `xaiNotification` forward to the webview was removed — the
      // webview ignores it, so buffering every notification (incl. ~2s-cadence
      // subagent_progress) only bloated the session replay buffer. The kinds we
      // act on are re-emitted as their own (buffered, consumed) messages above.
    });
    client.on("subagentLifecycle", (u: unknown, meta?: any) => {
      if (gen !== session.gen) return;
      if ((u as { sessionUpdate?: unknown })?.sessionUpdate === "turn_completed") {
        if (session.replaying) {
          const timestampMs = agentTimestampMsFromMeta(meta);
          // Restored footer duration: explicit duration_ms when the CLI sends
          // one, else the wall-clock gap from the turn's user message. Never
          // the SUBAGENT duration_ms — that belongs to the child card.
          const turnDurationMs = replayedTurnDuration(u, meta, session.replayTurnStartedAt);
          this.emit(session, {
            type: "subagentUpdate",
            update: u,
            timestampMs,
            ...(turnDurationMs !== undefined ? { turnDurationMs, turnStatus: "completed" as const } : {})
          });
        }
        return;
      }
      this.emit(session, { type: "subagentUpdate", update: u });
    });
    client.on("commandDone", (info: { command: string; output: string; exitCode: number | null; truncated: boolean }) => {
      if (gen !== session.gen) return;
      // Defensive display cap on top of the terminal's own byte limit — a huge
      // buffer must not stall postMessage/DOM (#41). Grok saw the same capped
      // buffer, so the cut is honest either way. Shared with session/load restore.
      // Null exit here is a real kill; `cancelled` is always stated so a later
      // historyReplay rebuild still paints [Cancelled], and so absence can only
      // mean an older host.
      this.emit(session, { type: "commandOutput", ...commandOutputFromLiveTerminal(info) });
    });
    client.on("permissionRequest", (req: PermissionRequest) => {
      if (gen !== session.gen) return;
      this.handlePermissionRequest(session, client, req, cwd);
    });
    client.on("mutationBlocked", (info: { kind: string; target: string }) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "planBlocked", kind: info.kind, target: info.target });
    });
    client.on("planFileContent", (content: string) => {
      if (gen !== session.gen) return;
      if (typeof content === "string" && content.trim()) session.lastPlanText = content;
    });
    client.on("exitPlanRequest", (req: ExitPlanRequest) => {
      if (gen !== session.gen) return;
      if (!session.planModeAvailable) {
        this.recoverUnavailablePlanMode(session, client, gen, req.id);
        return;
      }
      void this.postExitPlanRequest(req, session, gen);
    });
    client.on("questionRequest", (req: QuestionRequest) => {
      if (gen !== session.gen) return;
      // Questions are read-only and need a human — surface them in every mode
      // (plan/YOLO included); there's no sensible auto-answer.
      //
      // The responder is the grok transport: the CLI made this a JSON-RPC
      // request and is waiting on its own pipe for the response. `abandon` is
      // silent here on purpose — see QuestionResponder.
      this.showQuestion(session, req, {
        toolCallId: req.toolCallId,
        answer: (answers, annotations) => client.respondQuestion(req.id, answers, annotations),
        cancel: () => client.respondQuestionCancelled(req.id),
        abandon: () => { /* the CLI settled its own request; saying more would be a stale reply */ }
      });
    });
    client.on("exit", (code) => {
      if (gen !== session.gen) return; // suppress exit events from disposed/replaced clients
      // Startup window: teardown owns the user-facing outcome — no banner
      // (this is the empty-session spawn window the bounded retry exists
      // for), and no detachClient, whose gen bump would abort that retry.
      // But a death here is not always followed by a catch: the best-effort
      // setMode during resume swallows its error, so a client that died
      // there used to finish startup marked live and route every send into
      // a dead pipe (review find, 2026-08-15). Drop the attachment only;
      // the next send respawns. The equality check keeps a late exit from a
      // replaced attempt's client away from the current attempt's pipe.
      if (session.priming) {
        if (session.client === client) {
          this.drainPendingConfirms(session);
          session.client = undefined;
          this.pool.delete(session);
        }
        return;
      }
      // A process death mid-turn ends that turn — attach the footer fields so
      // the client can show "Failed after …". Only when a turn was actually in
      // flight: a clean exit between turns ends no turn.
      this.emit(session, {
        type: "exit",
        code,
        ...(turnIsInFlight(session) ? this.turnEndFields(session, "failed") : {})
      });
      if (session.queuedSends.length) {
        session.queuedSendCommit = undefined;
        session.queuedSends = [];
        this.emitQueuedSends(session);
      }
      this.setStatus(session, "error");
      this.pool.delete(session); // the process is gone; it's no longer a live pool member
      // Drop the dead client too (and bump gen so its other in-flight handlers
      // bail): `handleSend`/`ensureClient` prefer `session.client`, so leaving
      // it set routed every post-crash send into a dead pipe instead of
      // respawning.
      // Ends the turn too: a process that dies mid-turn may never settle its
      // `prompt()`, and the send path tests for a turn in flight BEFORE it
      // respawns — so the next send would be diverted into a queue this handler
      // has just emptied. The turn died with the process.
      this.detachClient(session);
      void client.dispose();
    });
    client.on("stderr", (text: string) => this.host.append(text));
    return client;
    };

    for (let attempt = 1; attempt <= startSpawnAttempts; attempt++) {
      if (gen !== session.gen) return undefined;
      const client = createBoundClient();
      // Version probe done to the first spawn attempt: resolving the
      // environment (which on Windows can shell out to locate a shell) AND
      // building the ACP client with its handlers. Recorded after
      // `createBoundClient`, not before the loop, because recording it first
      // charged the client construction to `other` while the phase named after
      // it reported 0-1ms — a confident wrong number, which is the one thing
      // this line must never print. First attempt only: a retry repeats
      // `spawn+init`, and that is the phase allowed to repeat.
      if (attempt === 1) clock.record("client", clock.elapsed(afterVersionAt));
      // Once the resume branch starts emitting (queued plan/permission cards,
      // then streamed history), a retry would replay onto the partial
      // transcript and duplicate every message (review find, 2026-08-15) —
      // so a failure past this flag surfaces immediately, like before the
      // retry existed. The fresh-session path stays retryable end to end.
      let replayBegan = false;
    try {
      const spawnAt = clock.now();
      await client.start();
      clock.record("spawn+init", clock.elapsed(spawnAt));
      if (gen !== session.gen) { void client.dispose(); return undefined; }
      // AP-10: a role's model is set on the `newSession` path, before the first
      // turn, and NEVER by a live switch — the CLI locks the model's agent type
      // after turn one and a cross-agent `set_model` then fails with
      // MODEL_SWITCH_INCOMPATIBLE_AGENT. Read once and cleared, so a later
      // restart of this same session object does not inherit the role's model.
      const startOverrides = session.startOverrides;
      session.startOverrides = undefined;
      const defaultModel = startOverrides?.model
        || this.providerDefaultForProject(cwd, session.provider)
        || "";
      if (resumeId) {
        replayBegan = true;
        // Queue any saved plans BEFORE replay starts so the webview can interleave
        // them inline with user messages as they replay (instead of dumping all
        // cards at the bottom).
        const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
        // Answered permission cards (collapsed) for this session, interleaved
        // inline during replay like the plan cards below.
        const savedPerms = overrides[resumeId]?.permissions ?? [];
        if (savedPerms.length > 0) {
          this.emit(session, { type: "permissionHistoryQueue", permissions: savedPerms });
        }
        // `undefined` means we have NO record for this session (legacy, from
        // before per-plan persistence) — only then is the on-disk fallback
        // right. An EMPTY array is a record saying "no plans", which is exactly
        // what a rewind leaves behind: treating that as legacy re-read grok's
        // plan.md — which rewind doesn't truncate — and resurrected the very
        // plan the user had just removed, labelled "Restored from the previous
        // session".
        const saved = overrides[resumeId]?.plans;
        const planSource = planRestoreSource(saved);
        if (planSource === "saved") {
          this.emit(session, { type: "planHistoryQueue", plans: await this.withPlanReviewPaths(saved!, resumeId) });
          session.lastPlanText = saved![saved!.length - 1].text;
        } else if (client.usesClientPlanGate && planSource === "disk") {
            // Legacy Grok session (no per-plan persistence): fall back to the
            // on-disk latest plan, which we'll render at the bottom after replay.
            const sessDir = sessionDirFor(resolveGrokHome(process.env), cwd, resumeId, { fs: defaultFs });
            const planPath = sessDir ? path.join(sessDir, "plan.md") : "";
            if (planPath && fs.existsSync(planPath)) {
              try {
                const planText = fs.readFileSync(planPath, "utf8");
                let snapshot: { path: string; name: string } | undefined;
                try {
                  snapshot = await this.createPlanReviewSnapshot(planText, resumeId);
                } catch (e) {
                  this.host.appendLine(`[plan-review] ${(e as Error).message}`);
                }
                this.emit(session, {
                  type: "planHistoryQueue",
                  plans: [{
                    text: planText,
                    verdict: undefined as any,
                    planPath: snapshot?.path,
                    planName: snapshot?.name
                  }]
                });
                session.lastPlanText = planText;
              } catch (e) {
                this.host.appendLine(`[plan-restore] ${(e as Error).message}`);
              }
            }
        }

        const loadAt = clock.now();
        let replayAt = 0;
        await this.replayLoadedHistory(session, async () => {
          try {
            await client.loadSession(resumeId, defaultModel || undefined);
          } catch (e) {
            // A resumed session's agent is fixed by its history, so a cross-agent
            // default model (e.g. a Composer model while resuming a grok-build
            // session, or vice-versa) can't be applied with a live set_model — it
            // errors MODEL_SWITCH_INCOMPATIBLE_AGENT. The session itself already
            // loaded and replayed; just keep its own model instead of letting the
            // whole resume crash with "Grok exited (code null)".
            if (!isIncompatibleAgentError(e)) throw e;
            this.host.appendLine(
              `[resume] kept the session's own model; default '${defaultModel}' needs a different agent`,
            );
          }
          // Events stream during session/load; replay(post) is the host wrap-up
          // after the RPC settles (no webview-complete signal exists). `new` is
          // zero on this branch and printed anyway — a resume creates nothing,
          // and a missing name is not a 0ms name in a line meant to be grepped.
          clock.record("new", 0);
          clock.record("load", clock.elapsed(loadAt));
          replayAt = clock.now();
        });
        clock.record("replay(post)", clock.elapsed(replayAt));
        session.activeSessionId = resumeId;
        session.titleGenerated = true; // existing session, name already in storage
        // AP-15 / ST-3. The session now has an id, so its stored type can be
        // read. A record without one is a pre-AP-15 conversation and reads as a
        // locked Agent session — no migration write, the reader supplies it.
        this.restoreSessionType(session);

        // Plan-gate restoration: the CLI replays its own current_mode_update
        // events during loadSession, which our modeChanged handler honors by
        // raising the gate. Override that here with the actual verdict-driven
        // decision (see plan-restore.ts) so a Cancelled or Approved session
        // doesn't come back stuck in Plan mode.
        if (client.usesClientPlanGate) {
          const decision = decideRestoreState(saved);
          const unavailablePlan = !session.planModeAvailable && (
            decision.planActive || session.planActive || client.currentModeId === "plan"
          );
          if (unavailablePlan) {
            this.recoverUnavailablePlanMode(session, client, gen);
          } else {
            const restorePlan = decision.planActive && session.planModeAvailable;
            this.setPlanActive(session, restorePlan);
            const targetMode = restorePlan ? "plan" : ACT_MODE_ID;
            try { await client.setMode(targetMode); } catch { /* best-effort */ }
          }
        }

        // Seed the context donut from grok's persisted signals.json or the
        // remembered adapter occupancy — no turn has run yet, so without this
        // a restored session shows 0 until the first prompt completes. Emitted
        // after loadSession so it lands after the donut-resetting `session`
        // event in the replay buffer.
        this.emitContextUsage(session);
        if (session.provider === "grok" || session.provider === "gemini") void this.refreshContextFromSessionInfo(session, gen, { force: true });
        // Same reason, for the billing breakdown (#53) — but from OUR store, as
        // grok persists no per-turn usage anywhere.
        this.restoreUsage(session);
      } else {
        // MEASURED, not assumed cheap. `session/new` also awaits the MCP server
        // list, `setModel`, and for adapters `setReasoningEffort` — and in one
        // reporter's log every `events: 0` open (i.e. every create) spent
        // 2.2-4.8s here with no phase naming it. It reached `other` once this
        // line started accounting for its own total; `new` says which call.
        const newAt = clock.now();
        await client.newSession(defaultModel || undefined);
        clock.record("new", clock.elapsed(newAt));
        clock.record("load", 0);
        clock.record("replay(post)", 0);
        session.activeSessionId = client.sessionId;
        // AP-16 §6.6 point 1: before the child's first turn, so no history
        // refresh can race it into the list.
        this.flushHiddenChildMeta(session);
        // AP-15 / ST-1. The CLI has named the session, so the type the user
        // picked in the empty state finally has a key to be written against.
        this.persistSessionType(session);
        this.postSessionType(session);
        // A role that declares `mode: plan` is read-only by construction, and
        // that has to be true from its first turn — asking for it afterwards
        // would let one write through first.
        if (startOverrides?.mode === "plan" && session.planModeAvailable) {
          this.setPlanActive(session, true);
          try { await client.setMode("plan"); } catch { /* best-effort */ }
        }
        if (session.autoApprove) {
          try {
            if (session.provider === "codex") {
              await client.setMode("default");
              await client.setMode("agent-full-access");
            } else if (session.provider === "claude" || session.provider === "gemini") {
              await client.setMode("yolo");
            } else {
              await client.setMode(ACT_MODE_ID);
            }
          } catch { /* best-effort */ }
        }
      }
      if (gen !== session.gen) { void client.dispose(); session.client = undefined; return undefined; }
      this.host.appendLine(clock.summary(session.historyEventCount));
      this.postSessionName(session);

      if (session.provider === "grok" && defaultModel && client.currentModelId && client.currentModelId !== defaultModel) {
        const hasModel = client.availableModels.some((m) => m.modelId === defaultModel);
        if (!hasModel) {
          // The configured default isn't available — grok already fell back to an
          // available model. Heal the (non-empty) setting silently to that model
          // so it stops being stale, and just log it; no popup nag. An EMPTY
          // default means "CLI default" and never reaches here (the `defaultModel &&`
          // guard above), so a fresh install's empty default is left untouched.
          this.host.appendLine(
            `[startup] Default model '${defaultModel}' is not available; switching grok.defaultModel to '${client.currentModelId}'.`,
          );
          void this.rememberGrokConfig("defaultModel", client.currentModelId);
        }
      }
      if (session.provider === "grok") {
        const warnEnabled = this.host.getConfiguration("companions").get<boolean>(
          "sensitiveFilesWarn",
          this.host.getConfiguration("grok").get<boolean>("sensitiveFilesWarn", true),
        );
        if (warnEnabled && !this.warnedSensitiveFiles) {
          const sensitive = findWorkspaceSensitiveFiles(session.cwd || this.workspaceRoot());
          if (sensitive.length > 0) {
            this.warnedSensitiveFiles = true;
            this.host.appendLine(
              `[security] Sensitive file(s) detected in workspace (${sensitive.slice(0, 3).join(", ")}). Note: Grok CLI ignores are configured in ~/.grok/config.toml.`,
            );
            this.postLocal({
              type: "hostNotice",
              level: "warning",
              text: `Sensitive file(s) detected in workspace (${sensitive.slice(0, 3).join(", ")}). Configure exclusions in ~/.grok/config.toml.`
            });
          }
        }
      }

      // A spontaneous death during startup detaches the pipe (see the exit
      // handler) without failing any awaited step — the best-effort setMode
      // swallows its error. Returning here would hand callers a silent
      // undefined, which recoverAuthAndResend and the send paths read as
      // "failure already surfaced" (review find, 2026-08-15: a swallowed
      // death consumed an auth-recovery resend with no error anywhere).
      // Throw into the classifier instead: the retry budget owns transient
      // startup deaths, and the final failure surfaces like any other.
      if (session.client !== client) throw new Error("the provider exited during startup");
      this.bindSubscriptionUsage(session, env);
      void this.refreshSubscriptionUsage(session);
      // Session is live — unlock the composer and flush anything typed during
      // the startup window (#37).
      session.priming = false;
      session.needsProvider = false;
      this.pool.add(session);
      this.touch(session);
      this.reapPool(); // enforce the LRU cap now that the pool grew
      // NOT `setProviderNeedsLogin(provider, false)` here: session/create,
      // load and replay all succeed against a dead token, and this line ran
      // inside the auth recovery's own restart — so the sign-in card blinked
      // out right before the refusal. Only an accepted credential clears it
      // (a served turn, below; upstream a8909af).
      this.emit(session, { type: "setBusy", value: false });
      // A draft this conversation lost to a provider sign-out comes back with
      // it, before the queue flushes — the composer is where it was typed.
      this.restorePersistedDraft(session);
      if (gen === session.gen) void this.maybeFlushQueuedSends(session);
      // A spontaneous death during startup detaches the pipe (see the exit
      // handler) without failing any awaited step. Returning the dead client
      // would hand the caller a dead pipe; report "no client" and let the
      // next send respawn.
      if (session.client !== client) { this.pool.delete(session); return undefined; }
      return client;
    } catch (err) {
      if (gen !== session.gen) { void client.dispose(); return undefined; }
      const msg = (err as any).message ?? String(err);
      // Decide the branch first: only the plain-failure path retries. Auth
      // must surface immediately; the Windows stdio pin has its own recovery.
      const credentialFailure =
        (client.provider !== "grok" && client.isCredentialError(err)) ||
        /auth|unauthor|401|api[_\s-]?key|credential|sign.?in/i.test(msg);
      const stdioRegression =
        session.provider === "grok" &&
        process.platform === "win32" &&
        /timed out: (initialize|session\/(new|load))|exited \(code null\)/i.test(msg);
      const userFacing = credentialFailure || stdioRegression || replayBegan || attempt >= startSpawnAttempts;
      client.removeAllListeners("exit");
      this.drainPendingConfirms(session);
      void client.dispose();
      session.client = undefined;
      if (!userFacing) {
        await new Promise<void>((resolve) => setTimeout(resolve, startSpawnBackoffMs[attempt - 1]));
        if (gen !== session.gen) return undefined;
        continue;
      }
      this.pool.delete(session);
      session.priming = false;
      this.emit(session, { type: "setBusy", value: false });
      // No `403`/`forbidden` here: the CLI deliberately does NOT map 403 to an
      // auth failure (entitlement/policy, which sign-in can't fix — #58); a
      // startup error carrying that wording surfaces as a plain error below.
      if (credentialFailure) {
        // The onboarding overlay only reaches whoever is looking at THIS
        // session. The account-level flag is what tells the gear and the model
        // picker, on every view, that signing in is the action — strictly
        // classified so an entitlement failure (which a sign-in cannot fix)
        // does not label the account signed-out.
        if (client.isCredentialError(err) || isCredentialError(err)) {
          this.setProviderNeedsLogin(session.provider, true);
        }
        this.emit(session, { type: "onboarding", state: this.onboardingForSession(session) });
      } else if (stdioRegression) {
        // The signature of the Windows stdio regression (issue #22): a startup request
        // hangs because the agent won't read stdin until EOF. It spanned 0.2.61–0.2.70
        // (`initialize` on 0.2.61–0.2.64, `session/new` on 0.2.67/0.2.69/0.2.70) and was
        // fixed in 0.2.71. The universal behavior floor replaces that old bounded
        // proactive pin; this reactive net is the backstop for a future
        // still-broken build above the Windows-verified target. We restore the
        // current supported feature baseline on the observed failure and retry
        // once. A target-or-older build cannot loop through this recovery; a
        // later manual upgrade above the target re-arms it.
        const version = await this.readGrokVersion(cliPath);
        if (gen !== session.gen) return undefined;
        if (!this.reactiveDowngradeInFlight && shouldReactivelyDowngrade(version, process.platform)) {
          this.reactiveDowngradeInFlight = true;
          try {
            const detected = parseGrokVersion(version)?.join(".") ?? version;
            if (await this.downgradeBrokenCli(cliPath, detected, "reactive")) {
              if (gen !== session.gen) return undefined;
              // Same clock: a downgrade re-entry that started a fresh one
              // reported only the successful second attempt and silently
              // dropped the timeout, the version read and the downgrade —
              // which is the slowest part of the open it was meant to explain.
              // `startSessionBody` clears the phases on entry, so the second
              // pass writes one set of names, not two.
              return await this.startSessionBody(resumeId, session, intent, clock); // same exclusive; do not re-enter the tail
            }
          } finally {
            this.reactiveDowngradeInFlight = false;
          }
        }
        // Pin unavailable, already attempted, or it didn't help — point the user at
        // the manual workaround instead of a bare timeout.
        this.emit(session, {
          type: "error",
          text:
            `Failed to start Grok: ${msg}. This matches the Grok CLI 0.2.61–0.2.70 stdio ` +
            `regression (issue #22, fixed after 0.2.70). Workaround: run ` +
            `\`grok update --version ${GROK_STDIO_DOWNGRADE_TARGET}\` in a terminal, then start a new session.`
        });
      } else if (isResumeNotFound(err)) {
        // The person asked for a conversation and got the adapter's own words
        // plus a uuid: “Failed to start Claude: Resource not found:
        // 85730a78-9918-43d7-a6c6-91a058348d89”. That identifier is ours, not
        // theirs, and “resource” is not a word for a conversation.
        //
        // Says only what is known. -32002 covers a thread that never recorded
        // anything AND a query that died mid-resume, so it names both
        // possibilities and offers the action that settles it, rather than
        // picking one and being wrong half the time.
        this.emit(session, {
          type: "error",
          text:
            `This conversation could not be opened. It may never have recorded `
            + `anything, or ${providerDisplayName(session.provider)} may not have `
            + `finished starting — try opening it again, and start a new `
            + `conversation if it stays this way.`
        });
      } else {
        this.emit(session, { type: "error", text: `Failed to start ${providerDisplayName(session.provider)}: ${msg}` });
      }
      return undefined;
    }
    }
    return undefined;
  }

  private async onMessage(msg: WebviewMsg): Promise<void> {
    let session = this.focused;
    // X-01: an answer to a card relayed from a hidden child goes to the child.
    const relayed = this.resolveRelayedAnswer(msg);
    if (relayed) {
      session = relayed.session;
      msg = relayed.msg;
    }
    const attachmentOwner: AttachmentOwner = () => this.focused;
    const messageCwd = this.workspaceRoot();
    switch (msg.type) {
      case "ready": {
        // Decide BEFORE postInitialState runs: its cold-start branch calls
        // startSession(), which can create this.focused.client before this
        // handler resumes (synchronously for Codex; Grok assigns behind
        // consent/version awaits — the pre-evaluation is right either way).
        // Re-evaluating afterwards read that self-inflicted "live client" as
        // "a reload rehydrate will post the catalog" and skips it, so a cold
        // desktop boot that auto-restores a session never grew a rail (the
        // race the owner hit as "no left menu"; reload cured it because a
        // real rehydrate runs then). VS Code is immune — its flag is false.
        const rehydrating = shouldRehydrateOnWebviewReady(
          this.host.webviewReloadsUnderLiveSession,
          !!this.focused.client,
        );
        this.postInitialState();
        // Rehydrate already posts catalog + sessions. Cold start needs an early
        // disk list so the rail is not empty while startSession runs — but the
        // catalog scan is deferred so ready returns and the UI paints first
        // (large histories must not block activation).
        if (!rehydrating) {
          if (!this.firstBootScanStarted && !this.firstBootScanCompleted) {
            void this.runFirstBootScan({ deferSessions: true });
          } else {
            this.postRepoCatalog();
            setImmediate(() => this.postSessionsList());
          }
        } else {
          this.completeFirstBootScan();
        }
        break;
      }
      case "composerFocus":
        await this.host.setContext("grok.composerFocus", !!msg.focused);
        break;
      case "summarizeSpeech": {
        const text = await summarizeForSpeech(
          msg.text,
          this.resolveVoiceApiKey(session.cwd || this.workspaceRoot()),
          (line) => this.host.appendLine(line),
        );
        this.postLocal({ type: "speechSummary", requestId: msg.requestId, text });
        break;
      }
      case "requestImageOriginal": {
        // Copy image (upstream #150): a webview can DISPLAY a vscode-resource
        // image but not read its pixels back, so the host sends the original
        // bytes for an authorized handle. Never resized.
        const source = this.fullImagePaths.get(msg.fullId);
        if (!source || !this.isImagePathAuthorizedNow(source, session)) break;
        const src = await this.readOriginalImage(source);
        if (!this.isImagePathAuthorizedNow(source, session)) break;
        this.postLocal({ type: "imageOriginal", fullId: msg.fullId, requestId: msg.requestId, src });
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
          await this.handleAgentCommand(msg.text, session);
          break;
        }
        // AP-11, under the same rule as the guard above and for the same
        // reason: parsed SYNCHRONOUSLY, awaited only on a hit.
        if (parseHandoffCommand(msg.text).kind !== "none") {
          await this.handleHandoffCommand(msg.text, session);
          break;
        }
        if (parseCrewCommand(msg.text).kind !== "none") {
          await this.handleCrewCommand(msg.text, session);
          break;
        }
        if (parseSubagentsCommand(msg.text).kind !== "none") {
          this.handleSubagentsCommand(msg.text, session);
          break;
        }
        await this.handleSend(msg.text, msg.bare === true, session, undefined, msg.submissionId);
        break;
      case "newSession":
        await this.newFocusedSession(msg.cwd);
        break;
      case "cancel": {
        // Stop stops the ROLE when one is running for this thread (AP-10) —
        // the role holds the turn, this session does not.
        if (this.cancelAgentRun(session)) break;
        const cancelled = session.turnToken;
        await session.client?.cancel("user Stop click");
        if (cancelled) this.armCancelRecovery(session, cancelled);
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
          if (s === this.focused) this.refreshImplicitChip(true);
          else this.postChips(s);
          this.emitQueuedSends(s);
          // If the turn ended while this message was in flight, fire it now.
          void this.maybeFlushQueuedSends(s);
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
          if (s === this.focused) this.refreshImplicitChip(true);
          else this.postChips(s);
          this.emitQueuedSends(s);
        }
        break;
      }
      case "steerSend":
        await this.steerSend(msg.text, session, msg.chips, msg.fromQueue === true);
        break;
      case "turnFeedback":
        await this.handleTurnFeedback(msg.rating, session);
        break;
      case "forkSession":
        if (this.refuseMismatchedSessionId(msg.sessionId, session)) break;
        await this.forkFocusedSession(session);
        break;
      case "newWorktreeSession":
        await this.newWorktreeSession();
        break;
      case "setAppPurpose": {
        const purpose = parseAppPurpose(msg.value);
        await this.state.update(APP_PURPOSE_KEY, purpose);
        this.post({ type: "appPurpose", value: purpose });
        break;
      }
      case "applyWorktree":
        // The webview's custom confirm already ran (native modals stay only on
        // the Command-Palette path).
        if (this.refuseMismatchedSessionId(msg.sessionId, session)) break;
        await this.applyFocusedWorktree(session, true);
        break;
      case "removeWorktree":
        if (this.refuseMismatchedSessionId(msg.sessionId, session)) break;
        await this.removeFocusedWorktree(session, true);
        break;
      case "rewindSession":
        await this.rewindFocusedSession(
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
        const pending = this.pendingConfirms.get(msg.id);
        // Only from the conversation the confirm was ASKED in. `emit` showed it
        // to every surface holding that session, so any of them may answer —
        // what a mismatch means is an answer for somebody else's conversation,
        // and dropping it is right. Ignoring it cannot hang the caller either:
        // the real answer still resolves, and an abandoned confirm already
        // fails closed on session teardown or replacement.
        if (pending && pending.session === session) {
          this.pendingConfirms.delete(msg.id);
          // The first answer from any surface dismisses it on the others.
          this.emit(session, { type: "uiConfirmResolved", requestId: msg.id });
          pending.resolve(msg.ok === true);
        }
        break;
      }
      case "editLastMessage":
        await this.editLastMessage(msg.userBubbleIndex, msg.text, msg.totalUserBubbles, session);
        break;
      case "workflowControl":
        await this.controlWorkflow(msg.action, msg.displayName, session);
        break;
      case "refreshSubscriptionUsage":
        void this.refreshSubscriptionUsage(session);
        break;
      case "refreshContextDetails":
        if (session.provider === "grok" || session.provider === "gemini") {
          void this.refreshContextFromSessionInfo(session, session.gen, {
            force: session.sessionInfoStale
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
          if (s === this.focused) this.refreshImplicitChip(true);
          else this.postChips(s);
          this.emitQueuedSends(s);
        }
        break;
      }
      case "pickModel":
        await this.pickModel();
        break;
      case "setMode":
        await this.setMode(msg.modeId, session);
        break;
      case "setSessionType":
        this.setSessionType(session, msg.sessionType);
        break;
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
            const uploadDir = stagedUploadDirectory(this.fileStagingDir(), removed.path);
            if (uploadDir) void fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        session.chips = removeChip(session.chips, msg.id);
        this.postChips(session);
        // A queued send retained after attachment validation failed is waiting
        // for exactly this state change. Re-drive only now (not from the send's
        // finally block, which would loop on the same unreadable attachment).
        void this.maybeFlushQueuedSends(session);
        break;
      }
      case "toggleChip": {
        session.chips = toggleChip(session.chips, msg.id);
        // Eye-off on the active-editor chip is a standing "don't send what I'm
        // looking at", not a one-file choice — remember it so the next file
        // switch doesn't quietly re-enable the context (#67).
        const toggled = session.chips.find((c) => c.id === msg.id);
        if (toggled && isImplicitChip(toggled)) {
          void this.state.update(IMPLICIT_CHIP_HIDDEN_KEY, toggled.hidden);
        }
        this.postChips(session);
        // Hiding an unreadable chip removes it from the next prompt just as
        // deleting it does, so it can unblock a retained idle queue too.
        void this.maybeFlushQueuedSends(session);
        break;
      }
      case "openFile": {
        const { ref, path: p } = this.resolveChatOpenPath(session, msg.path);
        if (ref.startLine != null) {
          const startLine = Math.max(0, ref.startLine - 1);
          const endLine = ref.endLine != null ? Math.max(startLine, ref.endLine - 1) : startLine;
          try {
            await this.host.openTextFile(p, {
              selection: {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: Number.MAX_SAFE_INTEGER }
              }
            });
          } catch {
            void this.host.openResource(p);
          }
        } else {
          void this.host.openResource(p);
        }
        break;
      }
      case "requestHandoff": {
        // The button form (AP-11). Confirmed, unlike the typed one: a click
        // named neither the role nor the task, so the host shows what it
        // chose before spending anything on it.
        await this.startHandoff(msg.kind, msg.role, session, true);
        break;
      }
      case "childMessage": {
        // The route names the Crew run; the host picks the running stage.
        if (String(msg.route ?? "").startsWith("stage:") && session.workflowRun) {
          await this.sendToRunningStage(session, String(msg.text ?? ""), msg.mode === "note" ? "note" : "steer");
        }
        break;
      }
      case "contextOverflowAnswer":
        await this.answerContextOverflow(session, msg);
        break;
      case "continueInFreshSession":
        await this.continueInFreshSession(session);
        break;
      case "stopCrew": {
        this.cancelAgentRun(session);
        break;
      }
      case "openCrewSession": {
        const id = String(msg.sessionId ?? "").trim();
        if (!id) break;
        const live = [...this.pool].find((s) => s.activeSessionId === id);
        if (live) this.focusSession(live);
        else await this.openSession(id);
        break;
      }
      case "openAgentArtifact": {
        // Coordinates in, path out — the run store owns the location, so no
        // renderer can name a file outside it (see the protocol note).
        const target = msg.which === "brief"
          ? this.agentRuns.briefPath(msg.runId, msg.step)
          : this.agentRuns.resultPath(msg.runId, msg.step);
        if (!fs.existsSync(target)) {
          this.agentNotice(session, "warning", `That run artefact is no longer on disk (${msg.runId}, step ${msg.step}).`);
          break;
        }
        void this.host.openResource(target);
        break;
      }
      case "showInFolder": {
        if (!this.host.canShowInFolder) break;
        const { path: p } = this.resolveChatOpenPath(session, msg.path);
        await this.host.showInFolder(p);
        break;
      }
      case "openUrl":
      case "openUpdateRelease":
        void this.host.openExternal(msg.url);
        break;
      case "restartToUpdate":
        this.host.installAppUpdate?.();
        break;
      case "openText": {
        // Basename only — a renderer-supplied path must not choose the directory.
        const name = typeof msg.filename === "string" ? path.basename(msg.filename.trim()) : "";
        const suggested = name ? path.join(this.sessionCwd(session), name) : undefined;
        await this.host.openUntitledText(msg.content, msg.language, suggested);
        break;
      }
      case "openDiff":
        if (msg.turnScope && await this.openTurnGitDiff(session, msg.path)) break;
        await this.openDiffEditor(
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
        await this.revertToolEdit(session, msg);
        break;
      case "reviewRevertFile":
        await this.reviewRevertFile(session, msg.path, msg.scope);
        break;
      case "reviewRevertAll":
        await this.reviewRevertAll(session, msg.scope);
        break;
      case "exportExpr":
        await this.exportExpr(msg, session);
        break;
      case "dropFile":
        // Desktop rewrites a host-minted handle to path before this runs; VS Code
        // still posts a path from drag-drop. Missing path is a no-op (forged
        // handle already refused at the Electron gate).
        if (typeof msg.path === "string" && msg.path.length > 0) {
          await this.trackAttach(this.addDroppedFile(msg.path, msg.shift, attachmentOwner));
        }
        break;
      case "pasteImage":
        await this.trackAttach(this.addPastedImage(
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
            pendingPermissionOptions(pending, session.planActive),
            msg.optionId,
            session.planActive,
            pending.toolKind,
          )) break;
          const chosenKind = pending.options.find((option) => option.optionId === msg.optionId)?.kind;
          if (chosenKind === "allow_once" || chosenKind === "allow_always") {
            this.snapshotRelOrAbsPaths(session, pending.paths ?? [], this.sessionCwd(session));
          }
          if (!session.client?.respondPermission(msg.requestId, msg.optionId)) break;
          if (msg.rule && !isPlanReviewPermission(pending.toolKind)) {
            if (msg.ruleScope === "session") this.addSessionAllowRule(session, msg.rule);
            else void this.persistAllowRuleFromCard(session, msg.rule);
          }
          // Record the resolution in the session buffer so re-focusing this session
          // replays the card collapsed instead of active (the live collapse is a
          // webview-only DOM mutation that the buffer never captured).
          this.emit(session, { type: "permissionResolved", requestId: msg.requestId, optionId: msg.optionId });
          const chosen = pending.options.find((option) => option.optionId === msg.optionId);
          if (isPlanReviewPermission(pending.toolKind) && pending.plan?.trim()) {
            this.persistPlanVerdict(
              session,
              planReviewVerdictForOption(chosen?.kind),
              pending.plan,
            );
            session.pendingPermissions.delete(msg.requestId);
            this.syncHumanWait(session);
          } else {
            // Persist it (title + outcome) so a cold reload replays a collapsed card —
            // the CLI doesn't replay request_permission on session/load.
            this.persistPermissionAnswer(session, msg.requestId, msg.optionId);
          }
          this.closeDiffForRequest(session, msg.requestId); // tidy up the auto-opened diff (#21)
          // Only once EVERY card is answered. Two tools can ask at the same
          // time, and answering one leaves the agent blocked on the other — so
          // saying "working" here was a lie that the auto-approval path (which
          // checks the same thing) never told. On a cloud machine the lie also
          // costs money: `working` is what holds the machine awake, so a
          // half-answered pair would hold it open indefinitely while nothing
          // ran.
          this.noteAnswered(session);
          break;
        }
      case "exitPlanAnswer":
        this.handleExitPlan(msg.requestId, msg.verdict, msg.comment, session);
        break;
      case "questionAnswer":
        // A card that is no longer outstanding is a STALE card: a second tab
        // still showing it, or one replayed from the session buffer after the
        // turn ended. Answering it again would write a duplicate JSON-RPC
        // response and drag a settled session back to `working` — with no turn
        // left to ever end it, which on a rented machine bills for ever.
        // The webview is told either way, so a stale card stops taking input
        // and offers its draft to the composer (upstream e2e8458).
        if (this.answerQuestion(session, msg.requestId, msg.answers ?? {}, msg.annotations ?? {})) {
          this.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "accepted" });
          // Answering a QUESTION is not answering a permission card that is
          // also outstanding — the agent stays blocked on it, so `working`
          // would be wrong and would hold a rented machine awake indefinitely.
          this.noteAnswered(session);
        } else {
          this.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "stale" });
        }
        break;
      case "questionCancel":
        if (this.cancelQuestion(session, msg.requestId)) {
          this.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "accepted" });
          this.noteAnswered(session);
        } else {
          this.emit(session, { type: "questionResolved", requestId: msg.requestId, outcome: "stale" });
        }
        break;
      case "limitOfferAnswer":
        await this.answerLimitOffer(session, msg);
        break;
      case "questionDraft": {
        // Nothing renders from this — it exists so the auto-continue timeout can
        // send what the user already marked instead of discarding it. Ignored
        // for a card that is no longer outstanding, exactly like an answer.
        if (!session.pendingQuestions.has(msg.requestId)) break;
        session.questionDrafts.set(msg.requestId, {
          answers: msg.answers ?? {},
          annotations: msg.annotations ?? {},
          complete: msg.complete === true
        });
        break;
      }
      case "setModel":
        await this.switchModel(
          msg.modelId,
          session,
          isAcpProvider(msg.provider)
            ? msg.provider
            : this.providerForRequestedModel(msg.modelId, session.provider),
        );
        break;
      case "setConfigOption":
        if (session.client && typeof (msg as any).configId === "string" && typeof session.client.setConfigOption === "function") {
          try {
            await session.client.setConfigOption((msg as any).configId, (msg as any).value);
            this.host.appendLine(`[acp] setConfigOption ${(msg as any).configId}=${JSON.stringify((msg as any).value)} succeeded`);
          } catch (e) {
            this.notifyUser("error", `Failed to set ${(msg as any).configId}: ${(e as Error).message}`);
          }
        }
        break;
      case "listRoutines":
        this.routineError = undefined;
        this.postRoutines();
        break;
      case "saveRoutine": {
        const existing = this.loadRoutines();
        const prior = msg.id ? existing.find((r) => r.id === msg.id) : undefined;
        if (msg.id && !prior) {
          this.routineError = { id: msg.id, message: "That routine is no longer there." };
          this.postRoutines();
          break;
        }
        // The cwd is checked against what this connection may reach, not
        // against the whole catalog: a remote may create routines, and reach is
        // the property that has to be bounded.
        const cwd = typeof msg.draft.cwd === "string" ? msg.draft.cwd : "";
        if (!this.mayTargetRoutineCwd(cwd)) {
          this.routineError = { id: msg.id, message: "Pick a project for this routine to run in." };
          this.postRoutines();
          break;
        }
        const result = validateRoutine(msg.draft, {
          id: prior?.id ?? randomUUID(),
          // Editing preserves createdAt, so the schedule anchor does not jump
          // when someone fixes a typo in the prompt.
          createdAt: prior?.createdAt ?? Date.now(),
          models: this.routineModelOptions()
        });
        if (!result.ok) {
          this.routineError = { id: msg.id, message: result.error };
          this.postRoutines();
          break;
        }
        this.routineError = undefined;
        const next = prior
          ? existing.map((r) => (r.id === prior.id ? { ...result.routine, paused: r.paused } : r))
          : [...existing, result.routine];
        await this.saveRoutines(next);
        this.postRoutines();
        break;
      }
      case "deleteRoutine": {
        const existing = this.loadRoutines();
        const target = existing.find((r) => r.id === msg.id);
        if (!target || !this.mayTargetRoutineCwd(target.cwd)) break;
        await this.saveRoutines(existing.filter((r) => r.id !== msg.id));
        this.routineRuns.forget(msg.id);
        this.routineError = undefined;
        this.postRoutines();
        break;
      }
      case "setRoutinePaused": {
        const existing = this.loadRoutines();
        const target = existing.find((r) => r.id === msg.id);
        if (!target || !this.mayTargetRoutineCwd(target.cwd)) break;
        await this.saveRoutines(
          existing.map((r) => (r.id === msg.id ? { ...r, paused: msg.paused === true } : r)),
        );
        this.postRoutines();
        break;
      }
      case "runRoutineNow": {
        const target = this.loadRoutines().find((r) => r.id === msg.id);
        if (!target || !this.mayTargetRoutineCwd(target.cwd)) break;
        if (this.routinesInFlight.has(target.id)) break;
        const now = Date.now();
        // A manual key, so an explicit run never consumes the scheduled window
        // — "Run now" at 07:59 must not cancel the 08:00 run.
        const key = manualWindowKey(now);
        this.routineRuns.claim(target.id, key, {
          routineId: target.id,
          windowKey: key,
          startedAt: now,
          outcome: "running"
        });
        await this.runRoutine(target, key, now);
        break;
      }
      case "installCodex":
        await this.installManagedCodexCli();
        break;
      case "updateProviderCli":
        await this.updateProviderCli(msg.provider);
        break;
      case "cancelCodexInstall":
        this.codexInstallAbort?.abort(new Error("Installation cancelled."));
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
          await this.persistEffort(session.provider, newLevel);
          if (wasEmpty && isAdapterProvider(session.provider)) {
            await this.discardAdapterEmptySession(session.provider, discardId, this.sessionCwd(session), session.client);
          }
          await this.startSession(undefined, session);
          if (wasEmpty && session.provider === "grok") this.discardRestartedEmptySession(discardId, session);
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
            await this.persistEffort(session.provider, newLevel);
            break;
          }
        }

        const mode = await this.pickRestartMode("Changing reasoning effort requires restarting the session.");
        if (!mode) break; // dismissed — leave the remembered effort untouched
        await this.persistEffort(session.provider, newLevel);
        await this.restartSession(mode, session);
        break;
      }
      case "addProjectFolder":
        await this.addProjectFolder();
        break;
      case "removeProjectFolder":
        // removeWorkspaceFolder returns false for anything not in the open set.
        await this.removeProjectFolder(msg.cwd);
        break;
      case "createProject":
        await this.createProject(msg.name);
        break;
      case "cloneProject":
        await this.cloneProject(msg.url, msg.name);
        break;
      case "setupGithubCli":
        await this.setupGithubCli(msg.action === "install" ? "install" : "auth");
        break;
      case "listGithubRepos":
        await this.listGithubRepos();
        break;
      case "githubSignOut":
        await this.githubSignOut();
        break;
      case "githubLoginWithToken":
        await this.githubLoginWithToken(msg.token);
        break;
      case "welcomeTipShown": {
        // Idempotent per day: `withShownTip` answers null when this tip is
        // already recorded for today, which means no write and no frame — the
        // client posts at most once per tip per day, and this is the second
        // gate so a client that forgets cannot rewrite the file all afternoon.
        const seen = withShownTip(
          this.state.get(WELCOME_TIPS_SHOWN_KEY, {}),
          msg.id,
          localDayKey(new Date()),
        );
        if (!seen) break;
        await this.state.update(WELCOME_TIPS_SHOWN_KEY, seen);
        this.postWelcomeTips();
        break;
      }
      case "dismissWelcomeTip": {
        // Id-shaped only, capped, and idempotent — `withDismissedTip` answers
        // null for anything already retired or out of bounds, and a null means
        // do not write and do not re-broadcast an identical frame. The host
        // deliberately does NOT check the id against a catalogue: the catalogue
        // lives in the client, and a newer client knowing a tip this host does
        // not is the normal case, not an error.
        const next = withDismissedTip(this.state.get(WELCOME_TIPS_KEY, {}), msg.id);
        if (!next) break;
        await this.state.update(WELCOME_TIPS_KEY, next);
        this.postWelcomeTips();
        break;
      }
      case "openGlobalConfig": {
        // Intent only — host resolves ~/.grok/config.toml (never a renderer path).
        await this.host.openGlobalConfig();
        break;
      }
      case "openProjectConfig": {
        // Intent only — host resolves project .grok/config.toml from session cwd.
        await this.host.openProjectConfig(this.sessionCwd(session));
        break;
      }
      case "listRuleFiles": {
        await this.refreshRuleFiles(session);
        break;
      }
      case "listAgentRoles": {
        // Opening the page is the request. Clearing the last refusal first, so
        // a reopened page does not greet the user with an error they already
        // fixed — same rule as `listRoutines`.
        this.agentRolesError = undefined;
        this.postAgentRoles();
        break;
      }
      case "saveAgentRole": {
        await this.handleSaveAgentRole(msg);
        break;
      }
      case "companionSubagentAction": {
        const record = this.subagents.get(msg.subagentId);
        if (!record) break;
        if (msg.action === "cancel") {
          this.cancelSubagent(msg.subagentId, "the user cancelled it from the tray");
          this.postSubagentCard(session, msg.subagentId);
          this.postSubagentTray(session);
        } else if (msg.action === "openTranscript" && record.childSessionId) {
          // The child is hidden from history but its transcript is readable —
          // that is the whole reason §6.6 keeps it rather than asking the CLI
          // not to persist. A live child is focused as it is (X-03).
          const live = this.poolSessionById(record.childSessionId);
          if (live) this.focusSession(live);
          else await this.openSession(record.childSessionId, this.sessionCwd(session));
        } else if (msg.action === "promote") {
          await this.promoteSubagentSession(session, msg.subagentId);
        } else if (msg.action === "followUp") {
          const text = String(msg.message ?? "").trim();
          if (!text) break;
          const started = await this.continueSubagent(session, msg.subagentId, text);
          if (!started.ok) this.agentNotice(session, "warning", started.message);
        } else if (msg.action === "applyWorktree" || msg.action === "discardWorktree") {
          await this.settleSubagentWorktree(session, msg.subagentId, msg.action === "applyWorktree");
        }
        break;
      }
      case "childOverviewAction":
        await this.childOverviewAction(msg);
        break;
      case "setCompanionsSetting":
        await this.setCompanionsSetting(String(msg.key ?? ""), msg.value);
        break;
      case "setSessionDelegation":
        this.setSessionDelegation(session, String(msg.value ?? "auto"));
        break;
      case "subagentApprovalAnswer": {
        this.answerSubagentApproval(session, msg);
        break;
      }
      case "workflowStart": {
        const target = [...this.pool].find((s) => s.activeSessionId === msg.sessionId) ?? session;
        if (msg.openNew) {
          await this.openNewCrewSession(msg.idea, msg.workflowName, msg.options);
          break;
        }
        await this.startWorkflowRun(target, msg.idea, msg.workflowName, msg.options);
        break;
      }
      case "workflowPlanEdit":
        this.applyWorkflowPlanEdit(session, msg);
        break;
      case "workflowGateAction": {
        if (await this.handleHostGateAction(session, msg)) break;
        const action = this.gateActionFromMsg(msg);
        if (action) await this.handleWorkflowGateAction(session, action);
        break;
      }
      case "openCrewWithGoal":
        await this.openNewCrewSession(msg.goal, this.defaultWorkflowName());
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
            ...(rule.effort ? { effort: rule.effort } : {})
          }
        }));
        await this.host.getConfiguration("companions").update("subagents.routing", rules, "global");
        this.host.appendLine(`[companions] routing: ${rules.length} rule(s)`);
        this.postAgentRoles();
        break;
      }
      case "setCrewStageSubagents":
        await this.host.getConfiguration("companions")
          .update("crew.stagesMayUseSubagents", !!msg.value, "global");
        this.postAgentRoles();
        break;
      case "setSubagentsEnabled":
        // Global, like the other display and behaviour prefs. The config
        // watcher re-posts it, keeping every open settings page in step.
        await this.host.getConfiguration("companions")
          .update("subagents.enabled", !!msg.value, "global");
        this.postAgentRoles();
        break;
      case "subagentRosterSave": {
        // A PATCH, merged into the stored object. Two settings pages open on
        // one window must not overwrite each other's untouched rows.
        const stored = this.companionsSetting<Record<string, unknown>>("subagents.roster", {});
        const current = (stored?.[msg.provider] ?? {}) as Record<string, unknown>;
        const next: Record<string, unknown> = { ...(stored ?? {}) };
        const merged: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(msg.patch ?? {})) {
          // An empty string is a real answer here — it means "this companion's
          // own default" / "no ceiling" — so it is stored rather than dropped.
          if (value !== undefined) merged[key] = value;
        }
        next[msg.provider] = merged;
        await this.host.getConfiguration("companions").update("subagents.roster", next, "global");
        this.host.appendLine(
          `[companions] roster: ${msg.provider} ${Object.keys(msg.patch ?? {}).join(", ")}`,
        );
        this.postAgentRoles();
        break;
      }
      case "deleteAgentRole": {
        this.handleDeleteCompanionFile(msg.scope, "agents", msg.name);
        break;
      }
      case "saveCrewFlow": {
        await this.handleSaveCrewFlow(msg);
        break;
      }
      case "deleteCrewFlow": {
        this.handleDeleteCompanionFile(msg.scope, "crews", msg.name);
        break;
      }
      case "saveWorkflow": {
        await this.handleSaveWorkflow(msg);
        break;
      }
      case "validateWorkflow": {
        this.postWorkflowValidation(msg.draft);
        break;
      }
      case "generateWorkflow": {
        await this.handleGenerateWorkflow(msg);
        break;
      }
      case "cancelWorkflowGenerate":
        this.cancelWorkflowGenerate();
        break;
      case "setDefaultWorkflow": {
        const name = String(msg.name ?? "").trim().toLowerCase();
        if (name) {
          await this.host.getConfiguration("companions").update("crew.defaultWorkflow", name, "global");
        }
        this.postAgentRoles();
        break;
      }
      case "addWorkflowStagesBlock": {
        await this.handleAddWorkflowStagesBlock(msg.scope, msg.name);
        break;
      }
      case "runWorkflow":
        await this.openNewCrewSession("", msg.name);
        break;
      case "listPermissionRules": {
        this.postPermissionRules(session);
        break;
      }
      case "deletePermissionRule": {
        await this.deletePermissionRule(session, msg.id);
        break;
      }
      case "adoptPermissionRules": {
        await this.adoptPermissionRules(session, msg.adopt === true);
        break;
      }
      case "openRuleFile": {
        await this.openRuleFile(session, msg.path);
        break;
      }
      case "appendRuleFile": {
        await this.appendRuleFile(session, msg.text);
        break;
      }
      case "listMcpServers": {
        await this.refreshMcpServers(session);
        break;
      }
      case "connectMcpConnector":
        await this.connectMcpConnector(msg.id, {
          key: typeof msg.key === "string" ? msg.key : undefined,
          readOnly: typeof msg.readOnly === "boolean" ? msg.readOnly : undefined
        });
        break;
      case "disconnectMcpConnector":
        await this.disconnectMcpConnector(msg.id);
        break;
      case "showLogs":
        this.host.showOutput();
        break;
      case "toggleDevTools":
        if (this.host.canToggleDevTools) this.host.toggleDevTools();
        break;
      case "openSettings":
        await this.host.openSettings(typeof msg.section === "string" ? msg.section : "companions");
        break;
      case "openSettingsSurface":
        await this.openSettingsEditor(typeof msg.category === "string" ? msg.category : undefined);
        break;
      case "closeSettingsSurface":
        this.settingsEditor?.dispose();
        this.settingsEditor = undefined;
        break;
      case "moveView": {
        // Settings -> Advanced -> Move view. Each destination targets an
        // extension-owned container, so the move is direct — no quickpick. An
        // unknown location falls back to the built-in destination picker
        // preselected on our view (the view-id argument also sidesteps the
        // focusedView context, which Cursor never sets for webview views).
        await this.retireMoveViewHint();
        await this.host.relocateView(
          GROK_VIEW_ID,
          moveViewContainerFor(msg.location),
          panelPositionFor(msg.location),
        );
        break;
      }
      case "setShowThinking":
        // Persist globally (like the other display prefs); the config watcher
        // re-posts the value, keeping every open webview in sync.
        await this.host.getConfiguration("grok")
          .update("showThinking", !!msg.value, "global");
        break;
      case "setExpandCommandOutputs":
        await this.host.getConfiguration("grok")
          .update("expandCommandOutputs", !!msg.value, "global");
        break;
      case "setSteerByDefault":
        await this.host.getConfiguration("grok")
          .update("steerByDefault", !!msg.value, "global");
        break;
      case "setPromptNav":
        await this.host.getConfiguration("grok")
          .update("promptNav", !!msg.value, "global");
        break;
      case "setSoundNotifications":
        await this.host.getConfiguration("grok")
          .update("soundNotifications", !!msg.value, "global");
        break;
      case "setProcessingSound":
        await this.host.getConfiguration("grok")
          .update("processingSound", !!msg.value, "global");
        break;
      case "setReadRepliesAloud":
        await this.host.getConfiguration("grok")
          .update("readRepliesAloud", !!msg.value, "global");
        break;
      case "setSummarizeRepliesAloud":
        await this.host.getConfiguration("grok")
          .update("summarizeRepliesAloud", !!msg.value, "global");
        break;
      case "setVoiceSendPhrase": {
        const cwd = messageCwd;
        const cfg = this.host.getConfiguration("grok", cwd);
        await cfg.update(
          "voiceSendPhrase",
          sanitizeVoiceSendPhrase(msg.value),
          voiceSettingWriteTarget(cfg.inspect("voiceSendPhrase"), this.host.isInWorkspace(cwd)),
        );
        break;
      }
      case "setVoiceKeyterms": {
        const cwd = messageCwd;
        const cfg = this.host.getConfiguration("grok", cwd);
        await cfg.update(
          "voiceKeyterms",
          sanitizeVoiceKeyterms(msg.value),
          voiceSettingWriteTarget(cfg.inspect("voiceKeyterms"), this.host.isInWorkspace(cwd)),
        );
        break;
      }
      case "setVoiceBackend": {
        if (!["auto", "xai", "openai"].includes(msg.value)) break;
        const cfg = this.host.getConfiguration("grok", messageCwd);
        await cfg.update("voiceBackend", msg.value,
          voiceSettingWriteTarget(cfg.inspect("voiceBackend"), this.host.isInWorkspace(messageCwd)));
        this.postVoiceConfigured();
        break;
      }
      case "configureOpenAiVoice": {
        const value = await this.host.showInputBox({
          title: "OpenAI voice API key",
          prompt: "An OpenAI API-platform key is required; Codex / ChatGPT sign-in does not include transcription. Saved in host settings. Empty clears the override.",
          password: true,
          placeHolder: "OpenAI API key"
        });
        if (value === undefined) break;
        const cfg = this.host.getConfiguration("grok", messageCwd);
        await cfg.update("voiceOpenAiApiKey", value.trim(),
          voiceSettingWriteTarget(cfg.inspect("voiceOpenAiApiKey"), this.host.isInWorkspace(messageCwd)));
        this.postVoiceConfigured();
        break;
      }
      case "setTelemetryEnabled":
        await this.host.getConfiguration("grok")
          .update("telemetry.enabled", !!msg.value, "global");
        break;
      case "setThumbsFeedback":
        await this.host.getConfiguration("grok")
          .update("thumbsFeedback", !!msg.value, "global");
        break;
      case "runInstallCmd": {
        // Host-owned confirmation, because this is one of the two messages that
        // run something. The renderer does not supply the command — it is the
        // fixed x.ai installer — so a compromised renderer cannot choose WHAT
        // runs, only trigger it. Confirming closes that anyway: the desktop
        // dispatcher authorizes on "the message came from the main frame", not
        // on a user gesture, and this is cheap where a general fix is not.
        if (!(await this.confirmHostExecute(
          "Install the Grok Build CLI?",
          "This runs the official installer from x.ai in a terminal.",
          "Install",
        ))) break;
        const term = this.host.createTerminal("Install Grok");
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
        const cliPath = this.locateProvider(provider);
        if (!cliPath) {
          this.post({
            type: "onboarding",
            state: missingProviderState(provider),
            platform: process.platform,
            provider
          });
          break;
        }
        // Connecting an account and RENEWING one are different errands, and
        // only the second is about the conversation on screen. Read the flag
        // before any probe below can clear it (upstream 61e0c57).
        const renewing = !!this.providerNeedsLogin?.[provider];
        // Pressing Connect / Sign in IS the consent, recorded before any CLI
        // runs (#171). Everything after may now execute this agent's binary.
        await this.setProviderConnected(provider, true);
        // Official CLI owns login. For Claude and Gemini this is `auth login`.
        const loginArgs = (provider === "claude" || provider === "gemini") ? ["auth", "login"] : ["login"];
        const term = this.host.createTerminal({
          name: `${providerDisplayName(provider)} Login`,
          shellPath: cliPath,
          shellArgs: loginArgs
        });
        term.show();
        // The terminal is outside the host protocol, so completion cannot be
        // observed directly. Probe immediately as well: browser/desktop login
        // helpers may already have completed, and the explicit Re-check below
        // remains available for interactive terminals still in progress.
        // Muse has no credential-status probe to poll; Re-check reads its
        // credential file instead (upstream 9a4aa6b).
        if (provider !== "muse") this.watchProviderLogin(provider);
        // Connecting an agent is about the NEXT conversation, not the one on
        // screen. Showing its sign-in panel over a session with history covered
        // that transcript, and the confirmation afterwards had nowhere sensible
        // to land — the owner connected Claude from an open Grok conversation
        // and got the panel there, then no confirmation at all. So start a fresh
        // session first and run the whole flow in it.
        // Not without a project: on desktop with nothing open, workspaceRoot()
        // is deliberately empty rather than the install directory, so there is
        // nowhere to start a session. Connecting still works — it only opens a
        // terminal — and the panel below still shows; the fresh session simply
        // waits until there is a project to put it in.
        //
        // A RENEWAL is the exception: the composer's sign-in card sits on a
        // conversation whose replies are being refused and offers to fix THAT
        // conversation, so parking it for the login panel is not wanted.
        if (session.hasHistory && this.workspaceRoot() && !renewing) {
          await this.newFocusedSession();
        }
        // ALWAYS show this provider's login panel, and say the terminal was
        // launched. Two bugs lived in the gate this replaces.
        //
        // It only posted when the provider was not marked connected, so
        // connecting a lapsed Codex from Settings opened its browser flow and
        // left the chat on whatever panel was already there — no instructions,
        // and no Re-check button to finish with.
        //
        // And `launched` matters because this terminal is opened by the HOST,
        // not by a click in the webview. The done mark was only set on click, so
        // an automatically opened terminal left the button looking untouched —
        // which reads as "that did nothing, press it again".
        this.post({
          type: "onboarding",
          state: providerLoginState(provider),
          platform: process.platform,
          provider,
          launched: true
        });
        break;
      }
      case "recheckConnection": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : session.provider;
        if (!this.locateProvider(provider)) {
          this.post({
            type: "onboarding",
            state: missingProviderState(provider),
            platform: process.platform,
            provider
          });
          break;
        }
        const pendingLoginProbe = this.loginReprobeTimers.get(provider);
        if (pendingLoginProbe) clearTimeout(pendingLoginProbe);
        this.loginReprobeTimers.delete(provider);
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
        if (!this.hasProviderConsent(provider)) break;
        if (provider === "muse") {
          // No status RPC: the person acknowledges the CLI sign-in here, and a
          // landed credential file is the evidence (upstream). A turn still
          // reports a credential failure through the normal path.
          this.setProviderNeedsLogin("muse", !this.providerCredentialFilePresent("muse"));
          void this.probeProviderVersion("muse");
        } else await this.reprobeProviderCredentials(provider);
        await this.adoptSessionsForConnectedProvider(provider, session);
        break;
      }
      case "retryProviderSession": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : session.provider;
        if (!this.connectedProviders().includes(provider)) break;
        if (session.provider === provider && !session.client) {
          await this.startSession(session.hasHistory ? session.activeSessionId : undefined, session);
        }
        break;
      }
      case "logout":
        await this.logout(
          isAcpProvider(msg.provider) ? msg.provider : "grok",
          { report: (text) => this.notifyUser("error", text) },
        );
        break;
      case "refreshProviders":
        await this.refreshProviderStates();
        break;
      case "checkGrokUpdate":
        await this.checkGrokUpdate();
        break;
      case "updateGrok":
        if (!(await this.confirmHostExecute(
          "Update the Grok Build CLI?",
          "This runs the CLI's own updater.",
          "Update",
        ))) break;
        await this.updateGrokCliOnDemand();
        break;
      case "listSessions":
        this.postSessionsList({ offset: msg.offset, limit: msg.limit, query: msg.query, providerCursor: msg.providerCursor });
        break;
      case "listRepoSessions":
        // Preview rows for a repo WITHOUT selecting it (the projects rail).
        // Local: desktop multi-folder rail and the VS Code primary-side-bar rail.
        this.sendLocalRepoSessionsPreview(msg.cwd, msg.limit);
        break;
      case "toggleSessionPin":
        // Rail pin, when any projects rail is live (desktop multi-folder or
        // VS Code primary-side-bar view).
        if (this.host.canSwitchWorkspaceFolder || this.projectsRail) {
          await this.toggleSessionPin(msg.id, msg.cwd, msg.pinned);
        }
        break;
      case "selectRepo":
        await this.selectRepo(msg.cwd);
        break;
      case "setRepoArchived":
        await this.setRepoArchived(msg.cwd, msg.archived);
        break;
      case "setRepoColor":
        await this.setRepoColor(msg.cwd, msg.color);
        break;
      case "toggleRepoPin":
        await this.toggleRepoPin(msg.cwd, msg.pinned);
        break;
      case "resumeSession":
        await this.openSession(msg.id, msg.cwd);
        break;
      case "renameSession":
        this.renameSession(msg.id, msg.name, msg.cwd);
        break;
      case "deleteSession":
        await this.deleteSession(msg.id, msg.name, msg.cwd);
        break;
      case "clearAllSessions":
        await this.clearAllSessions(msg.cwd);
        break;
      case "pickFile":
        await this.trackAttach(this.pickFileFromComputer());
        break;
      case "mentionQuery": {
        // Answer from the TTL-cached index; a failed build degrades to an empty
        // list (the popover just hides) rather than an error surface.
        let files: string[] = [];
        try {
          const index = await this.mentionFileIndexForCwd(this.sessionCwd(session));
          files = filterMentionFiles(index.rels, msg.query);
        } catch (e) {
          this.host.appendLine(`[mention] index failed: ${(e as Error).message}`);
        }
        // Virtual entries ride their own field so the file ranking above stays
        // exactly what it was, and so `files` keeps meaning "paths the mention
        // catalog can resolve".
        const sources = filterMentionSources(msg.query);
        this.post({ type: "mentionResults", query: msg.query, files, sources });
        break;
      }
      case "addMentionFile": {
        const workspaceRoot = this.sessionCwd(attachmentOwner());
        if (!workspaceRoot) break;

        let catalogMatch: string | undefined;
        let openTabMatch: string | undefined;
        // Keeps the #69 fallback for a result whose cached/open entry
        // disappeared between rendering and selection.
        try {
          catalogMatch = (await this.mentionFileIndexForCwd(workspaceRoot)).absByRel.get(msg.relPath);
        } catch (e) {
          this.host.appendLine(`[mention] index failed while validating pick: ${(e as Error).message}`);
        }
        if (pathsEqual(workspaceRoot, this.workspaceRoot())) {
          openTabMatch = this.openWorkspaceFileEntries().find((e) => e.rel === msg.relPath)?.abs;
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
        await this.trackAttach(this.addDroppedFile(abs, false, attachmentOwner));
        break;
      }
      case "addContextChip":
        this.addContextSourceChip(msg.source, attachmentOwner);
        break;
      case "openContextChipSource":
        await this.host.revealContextSource(msg.source);
        break;
      case "voiceStart":
        await this.handleVoiceStart(session);
        break;
      case "voiceStop":
        if (msg.discard) this.stopVoiceInput();
        else await this.handleVoiceStop();
        break;
    }

  }

  /** {@link RuleFileFs} over the ordinary host filesystem facade — the only
   *  effectful seam AP-04 needs; see rules-files.ts for the pure logic this
   *  feeds. `stat`/`readText` are left to reject on a missing path exactly
   *  like `workspace.fs` does; rules-files.ts is the layer that turns that
   *  into `exists:false` / `undefined`, so there is no double-catch here. */
  private ruleFileFs(): RuleFileFs {
    return {
      stat: async (absPath) => {
        const s = await this.host.fs.stat(Uri.file(absPath));
        // VS Code FileType: File=1, Directory=2, SymbolicLink=64 (bitwise —
        // a symlinked directory is 2|64). Bit 2 is the only one that matters
        // here: open-vs-reveal only cares whether it resolves to a directory.
        return { isDirectory: (s.type & 2) !== 0, size: s.size };
      },
      readText: async (absPath) => Buffer.from(await this.host.fs.readFile(Uri.file(absPath))).toString("utf8"),
      writeText: async (absPath, content) => {
        await this.host.fs.writeFile(Uri.file(absPath), Buffer.from(content, "utf8"));
      },
      mkdir: async (absPath) => {
        await this.host.fs.createDirectory(Uri.file(absPath));
      }
    };
  }

  /** Same home resolution as cli-locator.ts's `effectiveHome()`: env override
   *  first (so tests can redirect it), then `os.homedir()`. */
  private resolvedUserHome(): string {
    const env = process.env;
    return (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  }

  private async currentRuleFiles(session: Session): Promise<RuleFile[]> {
    // Provider config files (upstream 27a01d8) ride along: same Open/Create row.
    const candidates = [...ruleFileCandidates(this.sessionCwd(session), this.resolvedUserHome()), ...providerConfigFiles()];
    return resolveRuleFileStates(candidates, this.ruleFileFs());
  }

  private postRuleFiles(files: RuleFile[]): void {
    const message: Extract<HostMsg, { type: "ruleFiles" }> = { type: "ruleFiles", files };
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
  }

  private async refreshRuleFiles(session: Session): Promise<void> {
    this.postRuleFiles(await this.currentRuleFiles(session));
  }

  /**
   * Open (or reveal) one rule-file candidate, creating it first if missing.
   * `requestedPath` must match one of the host's OWN current candidates —
   * intent only, never a renderer-supplied path, same discipline as
   * openGlobalConfig/openProjectConfig above.
   */
  private async openRuleFile(session: Session, requestedPath: string): Promise<void> {
    const candidates: RuleFile[] = [...ruleFileCandidates(this.sessionCwd(session), this.resolvedUserHome()), ...providerConfigFiles()];
    const target = candidates.find((f) => f.path === requestedPath);
    if (!target) return;
    try {
      // A provider config is created with a stub its CLI parses; a rule file empty.
      if ("config" in target) ensureConfigToml(target.path, (target as ProviderConfigFile).stub);
      else await ensureRuleFile(target, this.ruleFileFs());
    } catch (err) {
      await this.host.showErrorMessage(`Couldn't create ${target.label}: ${(err as Error)?.message || String(err)}`);
      return;
    }
    if (target.kind === "directory") {
      await this.host.showInFolder(target.path);
    } else {
      await this.host.openTextFile(target.path);
    }
    await this.refreshRuleFiles(session);
  }

  /**
   * Chat action "Add as rule" (AP-04): append `text` (the user's chat
   * selection) to a file the user picks from a native QuickPick. Directory
   * candidates are not offered — there is nothing to append text to. The
   * active session's provider and project sort its own likely file first;
   * every candidate stays pickable, since a note about one provider's
   * behavior can belong in anyone's rules file.
   */
  private async appendRuleFile(session: Session, text: string): Promise<void> {
    const addition = String(text ?? "");
    if (!addition.trim()) return;
    const candidates = ruleFileCandidates(this.sessionCwd(session), this.resolvedUserHome())
      .filter((f) => f.kind === "file");
    const provider = session.provider;
    const rank = (f: RuleFile) => (f.scope === "project" ? 0 : 10) + (f.providers.includes(provider) ? 0 : 1);
    const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
    const picks = ordered.map((f) => ({
      label: f.label,
      description: f.exists ? undefined : "Will be created",
      detail: f.path,
      file: f
    }));
    const picked = await this.host.showQuickPick(picks, {
      title: "Add as rule",
      placeHolder: "Select a rule file to append to"
    });
    if (!picked) return;
    const dateStamp = new Date().toISOString().slice(0, 10);
    try {
      await appendRuleEntry(picked.file, addition, dateStamp, this.ruleFileFs());
    } catch (err) {
      await this.host.showErrorMessage(`Couldn't update ${picked.file.label}: ${(err as Error)?.message || String(err)}`);
      return;
    }
    await this.refreshRuleFiles(session);
  }

  private applyMcpNotification(session: Session, method: string, params: unknown): void {
    this.voiceAndMcp.applyMcpNotification(session, method, params);
  }

  private postMcpServers(message: Extract<HostMsg, { type: "mcpServers" }>): void {
    this.voiceAndMcp.postMcpServers(message);
  }

  private connectedConnectorStore(): ConnectedConnectorStore {
    return this.voiceAndMcp.connectedConnectorStore();
  }

  private mcpConnectorsMessage(): Extract<HostMsg, { type: "mcpConnectors" }> {
    return this.voiceAndMcp.mcpConnectorsMessage();
  }

  private postMcpConnectors(): void {
    this.voiceAndMcp.postMcpConnectors();
  }

  private mcpNameCatalogFor(cwd: string): {
    nameLayer: Map<string, "project" | "user">;
    nameFile: Map<string, string>;
  } {
    return this.voiceAndMcp.mcpNameCatalogFor(cwd);
  }

  private filterMcpServers(servers: readonly McpServerView[] = this.mcpServers): McpServerView[] {
    return this.voiceAndMcp.filterMcpServers(servers);
  }

  private reservedMcpIdentityFor(session: Session = this.focused): ReservedMcpIdentity {
    return this.voiceAndMcp.reservedMcpIdentityFor(session);
  }

  private async hostMcpServersFor(session: Session): Promise<any[]> {
    return this.voiceAndMcp.hostMcpServersFor(session);
  }

  private lapsedOAuthConnectors(store = this.connectedConnectorStore()): ReadonlySet<string> {
    return this.voiceAndMcp.lapsedOAuthConnectors(store);
  }

  private async loadMcpConnectorKeys(): Promise<void> {
    return this.voiceAndMcp.loadMcpConnectorKeys();
  }

  private async forgetConnectorKey(id: ConnectorId): Promise<void> {
    return this.voiceAndMcp.forgetConnectorKey(id);
  }

  private async connectMcpConnector(
    id: string,
    opts: { key?: string; readOnly?: boolean } = {},
  ): Promise<void> {
    return this.voiceAndMcp.connectMcpConnector(id, opts);
  }

  private async connectKeyMcpConnector(
    connector: ConnectorDef,
    endpoint: string,
    opts: { key?: string; readOnly?: boolean },
  ): Promise<void> {
    return this.voiceAndMcp.connectKeyMcpConnector(connector, endpoint, opts);
  }

  private async disconnectMcpConnector(id: string): Promise<void> {
    return this.voiceAndMcp.disconnectMcpConnector(id);
  }

  private findLiveGrokSession(): Session | undefined {
    return this.voiceAndMcp.findLiveGrokSession();
  }

  private async grokSessionForMcpList(requester: Session): Promise<Session | undefined> {
    return this.voiceAndMcp.grokSessionForMcpList(requester);
  }

  private async refreshMcpServers(session: Session = this.focused): Promise<void> {
    return this.voiceAndMcp.refreshMcpServers(session);
  }

  /**
   * Send one page of session history to the webview. The cheap `indexSessions` stat pass orders
   * every session by last activity without reading content; only the visible window (or, for a
   * search, the matched window) is parsed — and even those come from {@link sessionCache} unless
   * their `summary.json` changed. So opening the popover is O(page) reads regardless of how many
   * thousands of sessions exist on disk; the multi-second full-scan stall is gone.
   *
   * `offset === 0` is a fresh list/search (the webview replaces); `offset > 0` is load-more (the
   * webview appends). A non-empty `query` filters by display name across ALL sessions (it warms the
   * cache once so search stays complete, not just over what's already loaded).
   */
  /**
   * The local webview has no repo switcher and always uses the workspace root.
   * Remote callers bypass this legacy audience helper and resolve their own cwd
   * through RemoteClientState.
   */
  /**
   * Which repository the LOCAL surfaces are scoped to — the history list, New
   * Session, and the last-resort cwd a delete falls back to.
   *
   * This used to be the open workspace folder unconditionally
   * (`repoScopeFor`'s local branch), and the reason was sound at the time: VS
   * Code hid the repo switcher, so a selection the local user could not see
   * must not decide where Grok writes files. A phone that switched repos hours
   * ago would otherwise have been aiming the desk's New Session at another
   * checkout.
   *
   * Two things changed. VS Code has a projects rail now, so the selection is
   * visible and deliberate. And the selection is provably not the phone's:
   * `selectRepo` routes by origin — remotes go to `selectRemoteRepo`, which
   * writes a per-client cwd — and every writer of `selectedRepoCwd` is a local
   * path (selectRepo, postRepoCatalog's normalisation, the desktop folder
   * switch, openSession's follow). What the old rule produces now is simply the
   * wrong answer: a conversation from project B on screen with A's history
   * beside it, and New Session starting in A.
   *
   * Desktop is unaffected in steady state — there `selectedRepoCwd` tracks the
   * active folder, so the two agree.
   *
   * Remote scope is untouched and still goes through {@link repoScopeFor},
   * which is where per-tab isolation lives.
   */
  private historyCwdFor(): string {
    return this.selectedHistoryCwd() || this.workspaceRoot();
  }

  /** Refresh local history plus each connected remote tab. */
  /**
   * Rebuild and fan out the conversation list — COALESCED.
   *
   * Twenty-odd sites call this, because every catalog mutation funnels here on
   * purpose. That is the right shape, and it meant one click ran the rebuild
   * about twice, each time walking every session directory to sort by mtime:
   * ~380ms per walk at 3000 conversations, synchronously, on the thread that
   * paints the window (#133/#131).
   *
   * Every call posts a COMPLETE snapshot, so collapsing the ones that land in a
   * single tick loses nothing — the earlier frames were superseded before
   * anyone saw them. What the rail shows is unchanged; it is painted once
   * instead of twice, a tick later.
   *
   * A paged request is NOT coalesced. `opts` means the webview asked for a
   * specific slice and is waiting for it: merging that into a later
   * whole-list refresh would answer a scroll with the wrong page, or not at all.
   */
  private postSessionsList(opts?: SessionsListOptions): void {
    if (opts) {
      this.postSessionsListNow(opts);
      return;
    }
    if (this.sessionsListScheduled) return;
    this.sessionsListScheduled = true;
    setImmediate(() => {
      this.sessionsListScheduled = false;
      this.postSessionsListNow();
    });
  }

  private postSessionsListNow(opts?: SessionsListOptions): void {
    const localCwd = this.historyCwdFor();
    const local = this.buildSessionsList(localCwd, opts, undefined);
    this.postLocal(local);
    this.postSessionName(this.focused);
    if (opts) return;
    // Pins ride along with every catalog mutation rather than being refreshed at
    // each site that can invalidate one. Deleting a session, clearing a repo and
    // removing a worktree all land here; hanging the pinned refresh off the same
    // funnel fixes the whole class instead of the three cases we happened to
    // think of. Cheap when nothing is pinned — the scan is over an in-memory map
    // and reads no disk until a pin actually exists.
    this.postPinnedSessions();
  }

  private buildSessionsList(
    cwd: string,
    opts?: SessionsListOptions,
    activeId: string | null | undefined = this.focused.activeSessionId,
  ): Extract<HostMsg, { type: "sessions" }> {
    const offset = Math.max(0, opts?.offset ?? 0);
    const authorized = this.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    if (!listCwd) {
      return {
        type: "sessions",
        entries: [],
        activeId: null,
        dots: {},
        offset,
        total: 0,
        hasMore: false,
        nextOffset: offset,
        query: opts?.query ?? ""
      };
    }
    cwd = listCwd;
    const providers = this.connectedProviders();
    const adapterProviders = providers.filter(isAdapterProvider);
    for (const provider of adapterProviders) this.scheduleAdapterHistoryRefresh(provider, cwd);
    // Grok rows are files under GROK_HOME/sessions (plus live-pool synthesis) —
    // listing is disk/buffer-truth and must not wait for a located grok binary.
    // Adapter rows come from session/list, so they legitimately require that CLI.
    if (!adapterProviders.length) {
      return this.buildGrokSessionsList(cwd, opts, activeId);
    }

    const query = opts?.query ?? "";
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const providerCursor = opts?.providerCursor ?? { grokOffset: offset };
    const grok = this.buildGrokSessionsList(cwd, query
          ? { offset: 0, limit: Number.MAX_SAFE_INTEGER, query }
          : { offset: providerCursor.grokOffset, limit, query }, activeId);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const adapter: SessionListEntry[] = [];
    if (providers.includes("codex")) adapter.push(...(this.codexSessionCache.get(projectProviderKey(cwd)) ?? []));
    if (providers.includes("claude")) adapter.push(...(this.claudeSessionCache.get(projectProviderKey(cwd)) ?? []));
    if (providers.includes("gemini")) adapter.push(...(this.geminiSessionCache.get(projectProviderKey(cwd)) ?? []));
    if (providers.includes("muse")) adapter.push(...(this.museSessionCache.get(projectProviderKey(cwd)) ?? []));
    for (const session of this.pool) {
      if (!isAdapterProvider(session.provider) || !session.activeSessionId || !pathsEqual(this.sessionCwd(session), cwd)) continue;
      if (adapter.some((entry) => entry.id === session.activeSessionId)) continue;
      adapter.push(this.liveSessionEntry(session, session.activeSessionId, this.sessionCwd(session), overrides));
    }
    adapter.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const merged = query
      ? mergeProviderSessionEntries(grok?.entries ?? [], adapter, providers, query)
      : undefined;
    const combinedPage = query ? undefined : mergeProviderHistoryPage(
      grok,
      adapter,
      providerCursor,
      limit,
    );
    const entries = query
      ? (merged ?? []).slice(offset, offset + limit)
      : combinedPage?.entries ?? [];
    const dots: Record<string, Dot> = {};
    for (const entry of entries) dots[entry.id] = this.dotForId(entry.id);
    const nextOffset = query
      ? offset + entries.length
      : Math.max(offset + entries.length, combinedPage?.providerCursor.grokOffset ?? 0);
    const total = query ? (merged?.length ?? 0) : (grok?.total ?? 0) + adapter.length;
    return {
      type: "sessions",
      entries,
      activeId,
      dots,
      offset,
      total,
      hasMore: query ? nextOffset < total : combinedPage?.hasMore ?? false,
      nextOffset,
      ...(!query && combinedPage ? { providerCursor: combinedPage.providerCursor } : {}),
      query
    };
  }

  private scheduleAdapterHistoryRefresh(provider: AcpProvider, cwd: string): void {
    if (!isAdapterProvider(provider) || !this.connectedProviders().includes(provider)) return;
    const history = this.adapterHistory(provider);
    if (!history) return;
    const key = projectProviderKey(cwd);
    if (history.refresh.has(key)) return;
    if (Date.now() - (history.at.get(key) ?? 0) < 10_000) return;
    const refresh = (provider === "codex"
      ? this.refreshCodexHistory(cwd, key)
      : this.refreshAdapterHistory(provider, cwd, key))
      .catch((error) => {
        this.host.appendLine(`[${provider}] session listing failed: ${(error as Error).message}`);
        const credential = this.providerSetup.isProviderCredentialError(provider, error);
        if (!credential) return;
        history.at.set(key, Date.now());
        this.setProviderNeedsLogin(provider, true);
      })
      .finally(() => history.refresh.delete(key));
    history.refresh.set(key, refresh);
  }

  private async refreshCodexHistory(cwd: string, key = projectProviderKey(cwd)): Promise<void> {
    return this.refreshAdapterHistory("codex", cwd, key);
  }

  private async refreshAdapterHistory(provider: AcpProvider, cwd: string, key = projectProviderKey(cwd)): Promise<void> {
    if (!isAdapterProvider(provider) || !this.hasProviderConsent(provider)) return;
    const history = this.adapterHistory(provider);
    const cliPath = this.locateProvider(provider);
    const backend = this.createProviderBackend(provider);
    if (!history || !cliPath || !backend || !this.connectedProviders().includes(provider)) return;
    const client = new AcpClient({
      cliPath,
      cwd,
      env: { ...process.env },
      backend,
      log: (message) => this.host.appendLine(message)
    });
    try {
      await client.start();
      const result = await client.listSessions(cwd, process.platform);
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const stableOverrides: SessionMetaOverrides = { ...overrides };
      // First-seen adapter listing time is a baseline only. Claude restamps
      // `updatedAt` on `session/load` (measured). Codex does not restamp, but
      // pinning is still what we want: an open must not promote the row.
      // Trade-off: work done outside this extension stops promoting the row.
      // Unlike grok, neither adapter has a load-stable on-disk file to rank by.
      for (const entry of result.sessions) {
        const previous = stableOverrides[entry.sessionId] ?? {};
        if (typeof previous.activeAt === "number") continue;
        stableOverrides[entry.sessionId] = {
          ...previous,
          activeAt: adapterListEntry(entry, {}, provider, Date.now()).updatedAt
        };
      }
      const entries = result.sessions.map((entry) => adapterListEntry(entry, stableOverrides, provider));
      // A listing reads this machine's own files and succeeds with any token,
      // so a successful one is evidence of nothing (upstream a8909af). A
      // listing that fails with a credential error still raises the flag.
      history.cache.set(key, entries);
      history.at.set(key, Date.now());
      await this.updateSessionMeta((current) => {
        let changed = false;
        const next = { ...current };
        for (const entry of result.sessions) {
          const previous = next[entry.sessionId] ?? {};
          const title = typeof entry.title === "string" ? entry.title.trim() : "";
          const autoName = capAutoName(title);
          const updated = {
            ...previous,
            provider,
            providerCwd: entry.cwd,
            activeAt: typeof previous.activeAt === "number"
              ? previous.activeAt
              : stableOverrides[entry.sessionId]?.activeAt,
            ...(!previous.customName && autoName ? { autoName } : {})
          };
          if (JSON.stringify(updated) !== JSON.stringify(previous)) {
            next[entry.sessionId] = updated;
            changed = true;
          }
        }
        return changed ? next : null;
      });
    } finally {
      await client.dispose();
    }
    this.postSessionsList();
    this.sendLocalRepoSessionsPreview(cwd);
  }

  private buildGrokSessionsList(
    cwd: string,
    opts?: GrokSessionsListOptions,
    activeId: string | null | undefined = this.focused.activeSessionId,
  ): GrokSessionsListMessage {
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const query = (opts?.query ?? "").trim().toLowerCase();
    // Stale per-tab / selected cwds must not scan a closed project's catalog.
    const authorized = this.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    if (!listCwd) {
      return {
        type: "sessions",
        entries: [],
        activeId: null,
        dots: {},
        offset,
        total: 0,
        hasMore: false,
        nextOffset: offset,
        query: opts?.query ?? ""
      };
    }
    cwd = listCwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const log = (m: string) => this.host.appendLine(m);

    // Best-effort refresh so worktree sessions appear without a create this window.
    // Fire-and-forget: a late refresh just needs another list open to show up.
    void this.refreshWorktreeCache();

    // Scoped to the SELECTED repo — that is what makes picking a repo define the
    // history scope. Its worktrees ride along (they are not repo rows of their
    // own), so a worktree session stays reachable after you leave it.
    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    const repoCwdKeys = new Set(repoCwds.map(normalizeFsPath));
    const index = mergeSessionIndexes(
      repoCwds.map((c) => ({
        cwd: c,
        entries: indexSessions({ fs: defaultFs, grokHome, cwd: c, log })
      })),
    );
    const mtimeById = new Map(index.map((e) => [e.id, e.mtimeMs]));
    const cwdById = new Map(index.map((e) => [e.id, e.cwd]));

    // Subagent child sessions (`session_kind: "subagent"` — grok persists every
    // spawn_subagent delegation as a top-level sibling session) are grok's own
    // working state, not user chats: hide them from history or every delegation
    // adds a junk row. They still occupy index slots, so paging advances by ids
    // CONSUMED (nextOffset), never by entries shown — a filtered-out id must not
    // make the next page re-read the same slice.
    let pageEntries: SessionListEntry[];
    let total: number;
    let nextOffset: number;
    if (query) {
      // Search needs names for everything, so read (cache-backed) the whole list once, then filter.
      const all = this.readEntriesCachedMulti(index.map((e) => e.id), mtimeById, cwdById, overrides, grokHome, log)
        .filter((e) => e.kind !== "subagent");
      all.sort((a, b) => b.updatedAt - a.updatedAt);
      const matched = all.filter(
        (e) =>
          e.displayName.toLowerCase().includes(query) ||
          (e.worktreeLabel && e.worktreeLabel.toLowerCase().includes(query)),
      );
      total = matched.length;
      pageEntries = matched.slice(offset, offset + limit);
      nextOffset = offset + pageEntries.length;
    } else {
      total = index.length;
      const pageIndex = index.slice(offset, offset + limit);
      const pageIds = pageIndex.map((e) => e.id);
      pageEntries = this.readEntriesCachedMulti(pageIds, mtimeById, cwdById, overrides, grokHome, log)
        .filter((e) => e.kind !== "subagent");
      // mtime is an approximate sort key; re-order the loaded page by exact updated_at.
      pageEntries.sort((a, b) => b.updatedAt - a.updatedAt);
      nextOffset = offset + pageIds.length;
    }
    this.annotateWorktreeLabels(pageEntries, overrides, cwd);
    // AP-15 §5.2. Only Crew rows are badged; an Agent row is what a row has
    // always looked like, and every pre-AP-15 session is an Agent session.
    for (const entry of pageEntries) {
      if (effectiveSessionType(overrides[entry.id]) === "crew") {
        entry.sessionType = "crew";
        const runId = overrides[entry.id]?.crewRunId;
        const live = [...this.pool].find((s) => s.workflowRun?.runId === runId);
        if (live?.workflowRun) {
          const def = this.workflowStore().defs.get(live.workflowRun.runId)
            ?? this.resolveWorkflow(live, live.workflowRun.workflowName);
          entry.crewStatus = historySubtitle(live.workflowRun, def);
        } else if (runId) {
          const stored = this.workflowRuns().readRun(runId);
          if (stored) {
            const def = this.resolveWorkflow(this.focused, stored.workflowName);
            entry.crewStatus = historySubtitle(stored, def);
          }
        }
      }
      // AP-16 §6.6 point 2. Carried onto the entry so the ONE filter in
      // `sessions.ts` decides visibility for both the grok-stamped kind and
      // our own marker — pagination keeps counting index slots exactly as it
      // does today, so a hidden row cannot stall load-more.
      const hidden = overrides[entry.id]?.hiddenReason;
      if (hidden) entry.hiddenReason = hidden;
    }

    // hasMore is governed purely by what's on disk (load-more pages disk-only); compute it before
    // injecting any live-only rows below so an injected entry can't be mistaken for another page.
    const hasMore = nextOffset < total;

    // A brand-new live session has no summary.json yet, so the disk-scan index misses it. Without
    // this, opening history the moment a session goes live drops the active row entirely (and the
    // old top session masquerades as the whole list) until grok flushes the file — exactly the
    // "open too early" glitch. Synthesize a row from in-memory state for any live pool session not
    // yet on disk, pinned newest-first. Only on the first, unfiltered page: later pages are
    // disk-only, and a nameless not-yet-persisted session can't be matched by a search query.
    // These ids are never on disk, so they can't duplicate onto a later page when the user scrolls.
    // Scoped to repoCwdKeys (same set `index` was built from) — a live pool session from a
    // DIFFERENT repo (e.g. the still-focused session right after a remote repo switch) must
    // not leak into this repo's list, or it masquerades as this repo's newest/active row and
    // the remote auto-open shim mistakes it for an already-open match, never resuming/starting
    // the session that actually belongs here.
    if (!query && offset === 0) {
      const onDisk = new Set(index.map((e) => e.id));
      const seen = new Set(pageEntries.map((e) => e.id));
      const synthetic: SessionListEntry[] = [];
      for (const s of this.pool) {
        const id = s.activeSessionId;
        if (!id || onDisk.has(id) || seen.has(id)) continue;
        const sCwd = this.sessionCwd(s);
        if (!repoCwdKeys.has(normalizeFsPath(sCwd))) continue;
        const entry = this.liveSessionEntry(s, id, sCwd, overrides);
        if (s.worktree) entry.worktreeLabel = s.worktree.label;
        synthetic.push(entry);
        seen.add(id);
      }
      if (synthetic.length) {
        synthetic.sort((a, b) => b.updatedAt - a.updatedAt);
        pageEntries = [...synthetic, ...pageEntries];
      }
    }

    // A live, still-empty session must read "New session", never a stale disk-derived
    // summary — even after grok flushes summary.json. The truth is in
    // memory (hasHistory), so override the disk-derived name here. This is the single
    // untitled session the user starts from; abandoning it deletes it (parkFocused).
    const liveEmpty = new Set<string>();
    const liveProvider = new Map<string, AcpProvider>();
    for (const s of this.pool) {
      if (!s.activeSessionId) continue;
      liveProvider.set(s.activeSessionId, s.provider);
      if (!s.hasHistory) liveEmpty.add(s.activeSessionId);
    }
    for (const e of pageEntries) {
      const provider = liveProvider.get(e.id);
      if (provider) e.provider = provider;
      if (!e.customName && liveEmpty.has(e.id)) e.displayName = "New session";
    }

    // Dashboard dot per grok-session-id (live status + persisted unread badge) for the rows we send,
    // plus any live pool member not yet written to disk (a brand-new session has no summary.json).
    const dots: Record<string, Dot> = {};
    for (const e of pageEntries) dots[e.id] = this.dotForId(e.id);
    for (const s of this.pool) {
      if (s.activeSessionId && !(s.activeSessionId in dots)) {
        dots[s.activeSessionId] = this.dotForId(s.activeSessionId);
      }
    }
    return {
      type: "sessions",
      entries: pageEntries,
      activeId,
      dots,
      offset,
      total,
      hasMore,
      nextOffset,
      query: opts?.query ?? ""
    };
  }

  /** Synthesize a list entry for a live session grok hasn't written a `summary.json` for yet (a
   *  brand-new one). The disk-scan index can't see it, so without this the active row would vanish
   *  from history when the popover is opened the instant a session goes live. Uses the best name we
   *  have in memory: a generated/renamed `customName`, else the first user message, else a
   *  placeholder — all of which the next refresh replaces with grok's own summary once it lands. */
  /** The name this session shows in the history list — what the user actually
   *  reads, which is what a fork should be named after (#48).
   *
   *  Precedence mirrors the list itself: the user's `customName` first (that IS
   *  the row's label for any session that has one), then grok's own title, then
   *  the first user message.
   *
   *  The one deliberate departure: a **legacy primer-derived** title is skipped.
   *  Older builds sent the primer as message #1, so inheriting that invisible
   *  internal title into a fork would propagate it forever. `cliSessionTitle`
   *  rejects it and we fall through to something real. */
  private sessionDisplayName(session: Session): string {
    const id = session.activeSessionId;
    if (!id) return "";
    const override = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    const custom = override?.customName?.trim();
    if (custom) return custom;
    // A live empty session is deliberately shown as "New session" in the
    // history list, even if grok has already left a summary file behind.
    if (!session.hasHistory) return "New session";
    try {
      const cwd = this.sessionCwd(session);
      const grokHome = resolveGrokHome(process.env);
      const sessDir = sessionDirFor(grokHome, cwd, id, { fs: defaultFs });
      if (!sessDir) throw new Error("no session dir");
      const raw = JSON.parse(fs.readFileSync(path.join(sessDir, "summary.json"), "utf8"));
      const title = cliSessionTitle(raw?.session_summary, raw?.generated_title);
      if (title) return fallbackName(title, Date.now());
    } catch {
      // No summary yet (grok flushes it at turn end) — fall through.
    }
    // Same last resort the history list uses ("Untitled (<date>)"), so a fork of
    // a nameless session reads like a row rather than a bare "(Fork)".
    const generated = (override?.autoName || "").trim();
    const opening = (session.firstUserMessageForTitle || "").trim();
    const first = session.client && isAdapterProvider(session.client.provider) ? generated || opening : opening || generated;
    return fallbackName(first, Date.now());
  }

  /** Push the focused conversation's title independently of history pagination.
   *  The VS Code webview must not depend on the history popover having been
   *  opened. */
  private postSessionName(session: Session, name = this.sessionDisplayName(session)): void {
    const id = session.activeSessionId;
    if (!id) return;
    const cwd = this.sessionCwd(session);
    // The owning PROJECT, resolved the same way the rail groups worktrees under
    // their parent. Only when it differs from the cwd — an ordinary session is
    // its own project and the field would be noise.
    const owner = this.resolveLocalRepoTarget(cwd)?.cwd;
    const message: HostMsg = {
      type: "sessionName",
      sessionId: id,
      name,
      cwd,
      ...(owner && !pathsEqual(owner, cwd) ? { repoCwd: owner } : {})
    };
    if (session === this.focused) this.postLocal(message);
  }

  private postSessionRemoved(id: string | undefined, cwd: string): void {
    if (!id) return;
    const message: HostMsg = { type: "sessionRemoved", id, cwd };
    this.postLocal(message);
  }

  private liveSessionEntry(
    session: Session,
    id: string,
    cwd: string,
    overrides: SessionMetaOverrides,
  ): SessionListEntry {
    const now = Date.now();
    const customName = overrides[id]?.customName?.trim() || undefined;
    // No summary.json to read yet, so grok has no title for this one — the best
    // we have is the opening message, live or as the stored `autoName`.
    const firstMsg = (session.firstUserMessageForTitle || "").trim()
      || (overrides[id]?.autoName || "").trim();
    const displayName = customName || (firstMsg ? fallbackName(firstMsg, now) : "New session");
    const ts = session.lastActiveAt || now;
    return {
      id,
      cwd,
      displayName,
      rawSummary: firstMsg,
      customName,
      updatedAt: ts,
      createdAt: ts,
      numMessages: session.userMessageCount,
      modelId: undefined,
      provider: session.provider
    };
  }

  /**
   * Like {@link readEntriesCached} but each id may live under a different cwd
   * (workspace vs worktree). Groups stale ids by cwd so we still batch the
   * disk reads per catalog.
   */
  private readEntriesCachedMulti(
    ids: string[],
    mtimeById: Map<string, number>,
    cwdById: Map<string, string>,
    overrides: SessionMetaOverrides,
    grokHome: string,
    log: (m: string) => void,
  ): SessionListEntry[] {
    const staleByCwd = new Map<string, string[]>();
    for (const id of ids) {
      const cached = this.sessionCache.get(id);
      if (cached && cached.mtimeMs === (mtimeById.get(id) ?? -1)) continue;
      const c = cwdById.get(id) || this.workspaceRoot();
      const list = staleByCwd.get(c) ?? [];
      list.push(id);
      staleByCwd.set(c, list);
    }
    for (const [c, stale] of staleByCwd) {
      const fresh = readSessionEntries({ fs: defaultFs, grokHome, cwd: c, ids: stale, overrides, log });
      for (const e of fresh) {
        this.sessionCache.set(e.id, { mtimeMs: mtimeById.get(e.id) ?? 0, entry: e });
      }
    }
    return ids.map((id) => this.sessionCache.get(id)?.entry).filter((e): e is SessionListEntry => !!e);
  }

  private renameSession(
    id: string,
    name: string,
    requestedCwd?: string,
  ): void {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const trimmed = (name || "").trim();
    const next: SessionMetaOverrides = { ...overrides };
    if (!trimmed) {
      const cur = next[id];
      if (cur) {
        const { customName: _drop, ...rest } = cur;
        if (Object.keys(rest).length === 0) delete next[id];
        else next[id] = rest;
      }
    } else {
      next[id] = { ...(next[id] ?? {}), customName: trimmed };
    }
    void this.state.update(SESSION_META_KEY, next);
    // A rename changes displayName but not summary.json's mtime, so the mtime-keyed cache would
    // otherwise keep serving the old name. Drop it so the next read rebuilds the entry.
    this.sessionCache.delete(id);
    for (const adapter of (["codex", "claude"] as const)) {
      const history = this.adapterHistory(adapter);
      if (!history) continue;
      for (const [key, entries] of history.cache) {
        history.cache.set(key, entries.map((entry) => {
          if (entry.id !== id) return entry;
          const customName = next[id]?.customName?.trim() || undefined;
          return {
            ...entry,
            customName,
            displayName: customName || entry.rawSummary || next[id]?.autoName || `Untitled (${new Date(entry.updatedAt).toLocaleDateString()})`
          };
        }));
      }
    }
    const live = [...this.pool].find((session) => session.activeSessionId === id);
    this.postSessionsList();
    // Recompute rather than echoing `trimmed`: an empty rename DROPS the custom
    // name, and the view then has to be told the title it falls back to.
    if (live) this.postSessionName(live);
    // The renamed row's OWN project, not just the selected one. `postSessionsList`
    // refreshes the selected project's list and the rail draws every other
    // project from its `repoSessions` preview — so renaming a conversation in
    // project B while A is selected left B's rows showing the old name, and the
    // cache entry that would have corrected them was just dropped.
    if (requestedCwd) this.sendLocalRepoSessionsPreview(requestedCwd);
  }

  /** Is this conversation on screen? Only the focused session is. */
  private sessionHasLiveOwner(session: Session): boolean {
    return session === this.focused;
  }

  private reportProtectedSession(action: "delete" | "clear"): void {
    const text = action === "delete"
      ? "This conversation is open. Close it before deleting it."
      : "Open conversations were kept. Close them before clearing them.";
    void this.host.showInformationMessage(text);
  }

  /**
   * Explicit session identity on fork/apply/remove. A present id that is not
   * the dispatch-resolved session is refused here, before any await — this
   * codebase has been bitten three times by an identifier captured before an
   * await going stale after it.
   */
  private refuseMismatchedSessionId(
    requestedId: string | undefined,
    session: Session,
  ): boolean {
    if (requestedId === undefined || requestedId === session.activeSessionId) return false;
    const text = "That conversation is no longer focused — nothing was changed.";
    this.postLocal({ type: "hostNotice", level: "info", text });
    return true;
  }

  /** A host notification at the given severity. */
  private notifyUser(
    level: "info" | "warning" | "error",
    text: string,
  ): void {
    if (level === "error") void this.host.showErrorMessage(text);
    else if (level === "warning") void this.host.showWarningMessage(text);
    else void this.host.showInformationMessage(text);
  }

  private async deleteSession(
    id: string,
    _name: string | undefined,
    requestedCwd?: string,
  ): Promise<void> {
    const overridesNow = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    if (this.isSessionLoadReserved(id)) {
      this.host.appendLine(`[sessions] refused delete of reserved session ${id}`);
      this.reportProtectedSession("delete");
      return;
    }
    // Deleting the conversation you are reading is allowed; the view lands on
    // its neighbour below.
    const live = [...this.pool].find((s) => s.activeSessionId === id);
    // A row may name its own project, validated through the catalog. The
    // rail lists other projects' conversations now, and their rows carry a cwd
    // that this chain ignored: rename a cold conversation in project B (which
    // drops its cache entry), then Delete the same row, and it resolved to the
    // SELECTED project instead — deleting nothing under A, reporting nothing
    // wrong, and leaving the conversation in B under its old name. Resolved
    // rather than trusted: an unknown path falls through to the chain below.
    const localNamedCwd =
      requestedCwd
        ? this.resolveLocalRepoTarget(requestedCwd)?.cwd
          ?? (this.localTrustedSessionCwds(overridesNow).some((c) => pathsEqual(c, requestedCwd))
            ? requestedCwd
            : undefined)
        : undefined;
    const cachedAdapter = [...this.allAdapterCatalogs()].flat().find((entry) => entry.id === id);
    const cwd =
      live?.cwd ||
      overridesNow[id]?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      cachedAdapter?.cwd ||
      localNamedCwd ||
      this.historyCwdFor();
    const provider = live?.provider ?? overridesNow[id]?.provider ?? cachedAdapter?.provider ?? "grok";
    // Tear the CLI down BEFORE touching the disk, not after. The live process
    // owns this conversation and re-persists it: delete the directory first and
    // it simply comes back, which is why deleting the open conversation used to
    // be refused outright rather than merely awkward. `disposeSession` ends the
    // turn, drops the client and disposes it, so by the time the files go there
    // is nothing left that could write them again.

    const visibleEntries = this.buildSessionsList(
      cwd,
      { limit: Number.MAX_SAFE_INTEGER },
      undefined,
    ).entries;
    if (isAdapterProvider(provider)) {
      // A FAILED DELETE MUST STILL REMOVE THE ROW.
      //
      // Codex implements delete as one `threadArchive(threadId)` and Claude's
      // removes a session file, and BOTH throw when the thread was never
      // written — which is every conversation nobody has used yet. The host
      // then read the adapter's own words out to the person (“Internal
      // error”) and, far worse, returned before its own cleanup, so a failed
      // delete was how a conversation became permanently un-sendable.
      //
      // Three attempts tried to PREDICT whether a thread existed and skip the
      // provider when it did not — keyed on `hasHistory`, then on a flag set
      // at the prompt call site, then on one set from provider output. Each
      // was wrong in a different direction, because persistence happens
      // inside the provider at a moment the host cannot observe: a suppressed
      // Summarize & Restart turn writes a thread the row calls empty, a
      // prompt that throws may or may not have written, and the user turn
      // persists before any agent output arrives. Skipping wrongly ORPHANS a
      // real thread; calling wrongly is the original bug. There is no signal
      // here that separates them, so this no longer guesses.
      //
      // Ask the provider every time, and treat a refusal as done: for the
      // overwhelmingly common cause — nothing there to delete — that is the
      // truth, and for a genuine provider failure the row returns on the next
      // listing refresh, which is visible and recoverable. Neither outcome
      // loses anything the person wrote. A dead row is worse than both.
      let temporary: AcpClient | undefined;
      const name = providerDisplayName(provider);
      try {
        const cliPath = this.locateProvider(provider);
        const backend = this.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${name} CLI is not available.`);
        // DISPOSING FIRST WAS TRIED HERE AND REVERTED. It looks obviously
        // right — the comment above asks for it and the Grok branch does it —
        // but tearing the live session down before the delete leaves it
        // unbound and still `this.focused` for the seconds a fresh CLI needs
        // to spawn, initialize and delete. In that window: a reconnect
        // re-opens the conversation onto the zombie focus and a second
        // process starts on the same id; or the person opens another
        // conversation and the finishing delete moves them onto a blank
        // session, so their next message goes somewhere they did not choose.
      // Independent review found all three. The defect was the RECOVERY
      // below, which used to return before our own cleanup; it no longer does.
        const client = live?.client ?? (temporary = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.host.appendLine(message)
        }));
        if (temporary) await temporary.start();
        await client.deleteSession(id);
      } catch (error) {
        // Logged, never raised: the usual cause is a thread that was never
        // written, where an error would be a lie about the person's own
        // system. Falling through is the point — the row goes either way.
        this.host.appendLine(
          `[sessions] ${name} could not delete ${id}, removing it locally: ${(error as Error).message}`,
        );
      }
      if (temporary) await temporary.dispose();
      if (live) void this.disposeSession(live);
      const history = this.adapterHistory(provider);
      if (history) {
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => entry.id !== id));
        }
      }
    } else {
      // NOT awaited, and that is a deliberate revert rather than an
      // oversight: awaiting widens the same unbound window the adapter
      // branch above was reverted for, by up to the process kill timeout.
      // Worth revisiting only together with the recovery this path lacks.
      if (live) void this.disposeSession(live);
      try {
        deleteSessionDir({
          fs: defaultFs,
          grokHome: resolveGrokHome(process.env),
          cwd,
          id
        });
      } catch (e) {
        this.host.appendLine(`[sessions] delete failed for ${id}: ${(e as Error).message}`);
      }
    }
    // Said once, here, so anything downstream can tell a deleted conversation
    // from a live one without re-deriving it from an id that outlives the
    // directory.
    if (live) live.deleted = true;
    this.sessionCache.delete(id);
    this.removePlanReviews(id); // snapshots live outside grok's session dir
    this.removeCheckpoints(id);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.removeUploadsForSessions([id], overrides);
    if (overrides[id]) {
      const next = { ...overrides };
      delete next[id];
      void this.state.update(SESSION_META_KEY, next);
    }
    // Re-home only the surfaces that were looking at it. The next row in the
    // list they were looking at is the home; a blank session is minted only
    // when that list is empty. Watchers share that same home. A viewer of a
    // different conversation is not moved.
    const neighbour = neighbourAfterDelete(visibleEntries, id);
    // THE ONLY QUESTION: is the view sitting on something that no longer
    // exists? If so it needs a home; if not, wherever the person is now is
    // where they want to be.
    //
    // Asked after the teardown, never remembered from before it. Four review
    // rounds went at this and every wrong answer was a PROXY — comparing focus
    // to the neighbour, asking whether the open succeeded, trusting a snapshot
    // taken earlier. Each minted a blank conversation over one the person had
    // deliberately opened, in one direction or the other.
    const viewNeedsHome = this.viewIsOnDeleted(id);
    if (viewNeedsHome) {
      if (neighbour) await this.openSession(neighbour.id, neighbour.cwd);
      // Still here means the open declined — another view holds that
      // session's load reservation — so there is nowhere to go but a new one.
      if (this.viewIsOnDeleted(id)) {
        this.focused = this.newLocalSession();
        // Neighbour rows already live in this project. A minted replacement
        // does not — without this it starts in the VS Code workspace folder
        // while history and the rail stay on the project the deleted
        // conversation belonged to. Same rule as newFocusedSession: the local
        // scope IS the selection.
        this.setSessionCwd(this.focused, this.historyCwdFor(), this.workspaceRoot());
        this.focused.provider = this.defaultProviderForProject(this.historyCwdFor());
        await this.startSession();
      }
    }
    this.postSessionsList();
    // The rail's per-project rows come from `repoSessions`, which is a separate
    // frame from the selected repo's list that postSessionsList refreshes.
    if (cwd) this.sendLocalRepoSessionsPreview(cwd);
  }

  /** Delete every inactive session in the requested repo's history. The
   *  conversation on screen is kept: deleting it would strand the rendered
   *  transcript over a blank replacement process. The webview confirms first
   *  (custom dialog). */
  private async clearAllSessions(requestedCwd: string): Promise<void> {
    // Any project in the host's own catalog, not just the selected one — the
    // rail offers this per project, and the catalog is the boundary. A path the
    // host has never discovered still gets nothing.
    const repo = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, requestedCwd));
    if (!repo) return;
    const cwd = repo.cwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    // Tear ownerless live processes down BEFORE touching disk. deleteSession
    // already does this: a grok process that still holds the directory makes
    // the Windows delete fail (or the CLI re-persists the shell), and the row
    // comes back as a live-empty "New session". Ownerless parked empties —
    // New session clicks while the previous one was still priming — are the
    // usual leftovers. Live-owned conversations stay protected below.
    const repoCwdKeys = new Set(repoCwds.map(normalizeFsPath));
    const exiting: Promise<void>[] = [];
    for (const s of [...this.pool]) {
      if (this.sessionHasLiveOwner(s)) continue;
      if (!repoCwdKeys.has(normalizeFsPath(this.sessionCwd(s)))) continue;
      exiting.push(this.disposeSession(s));
    }
    // AWAIT the exits. Firing dispose and moving on leaves `clearSessions`
    // racing a Windows taskkill that still holds the directory — the delete
    // then fails, or the CLI re-persists the shell, and the row returns as a
    // live-empty "New session". That is the precise failure this block exists
    // to prevent, so not waiting made it a no-op on the first clear.
    if (exiting.length) await Promise.allSettled(exiting);
    // Adapter history is provider-owned, so make the cache authoritative before
    // a destructive combined-history action. Grok-only installs skip this.
    // A failed refresh must not fall through to the stale cache — that is how
    // "were not cleared" became a delete. Only providers that checked succeed.
    const adapterHistoryChecked = new Set<AcpProvider>();
    for (const provider of this.connectedProviders().filter(isAdapterProvider)) {
      try {
        await this.refreshAdapterHistory(provider, cwd);
        adapterHistoryChecked.add(provider);
      } catch (error) {
        const text = `${providerDisplayName(provider)} history could not be checked, so its conversations were not cleared: ${(error as Error).message}`;
        this.host.appendLine(`[sessions] ${text}`);
        void this.host.showErrorMessage(text);
      }
    }
    const protectedIds = new Set(
      [...this.pool]
        .filter((session) => this.sessionHasLiveOwner(session))
        .map((session) => session.activeSessionId)
        .filter((id): id is string => !!id),
    );
    for (const id of this.reservedSessionIds()) protectedIds.add(id);
    const requesterId = this.focused.activeSessionId;
    // Count via the cheap stat-only index — no need to parse every summary just to confirm.
    const repoEntries = mergeSessionIndexes(repoCwds.map((sessionCwd) => ({
      cwd: sessionCwd,
      entries: indexSessions({ fs: defaultFs, grokHome, cwd: sessionCwd })
    })));
    const adapterEntries = adapterEntriesEligibleForClear(
      [
        { provider: "codex", entries: this.codexSessionCache.get(projectProviderKey(cwd)) ?? [] },
        { provider: "claude", entries: this.claudeSessionCache.get(projectProviderKey(cwd)) ?? [] },
        { provider: "gemini", entries: this.geminiSessionCache.get(projectProviderKey(cwd)) ?? [] },
      ],
      adapterHistoryChecked,
    );
    const allEntries = [...repoEntries, ...adapterEntries];
    const keptForAnotherOwner = allEntries.some(
      (entry) => protectedIds.has(entry.id) && entry.id !== requesterId,
    );
    const clearableCount = allEntries.filter((entry) => !protectedIds.has(entry.id)).length;
    if (clearableCount === 0) {
      if (keptForAnotherOwner) this.reportProtectedSession("clear");
      else this.notifyUser("info", "No history to clear.");
      // Ownerless live empties may have been disposed above without a catalog
      // row. The rail still has to drop them.
      this.postSessionsList();
      this.sendLocalRepoSessionsPreview(cwd);
      return;
    }
    // Confirm lives in the webview (custom dialog) — see deleteSession.

    const removedIds = new Set<string>();
    for (const sessionCwd of repoCwds) {
      try {
        for (const id of clearSessions({
          fs: defaultFs,
          grokHome,
          cwd: sessionCwd,
          exceptIds: protectedIds
        })) removedIds.add(id);
      } catch (e) {
        this.host.appendLine(
          `[sessions] clear-all failed for ${sessionCwd}: ${(e as Error).message}`,
        );
      }
    }
    for (const provider of (["codex", "claude"] as const)) {
      if (!adapterHistoryChecked.has(provider)) continue;
      const history = this.adapterHistory(provider);
      const entries = (history?.cache.get(projectProviderKey(cwd)) ?? [])
        .filter((entry) => !protectedIds.has(entry.id));
      if (!entries.length) continue;
      let client: AcpClient | undefined;
      const name = providerDisplayName(provider);
      try {
        const cliPath = this.locateProvider(provider);
        const backend = this.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${name} CLI is not available.`);
        client = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.host.appendLine(message)
        });
        await client.start();
        for (const entry of entries) {
          try {
            await client.deleteSession(entry.id);
            removedIds.add(entry.id);
          } catch (error) {
            const text = `${name} refused to delete “${entry.displayName}”: ${(error as Error).message}`;
            this.host.appendLine(`[sessions] ${text}`);
            void this.host.showErrorMessage(text);
          }
        }
      } catch (error) {
        const text = `${name} conversations were not cleared: ${(error as Error).message}`;
        this.host.appendLine(`[sessions] ${text}`);
        void this.host.showErrorMessage(text);
      } finally {
        if (client) await client.dispose();
      }
    }
    const removed = [...removedIds];

    if (removed.length) {
      const gone = new Set(removed);
      for (const adapter of (["codex", "claude"] as const)) {
        const history = this.adapterHistory(adapter);
        if (!history) continue;
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => !gone.has(entry.id)));
        }
      }
    }

    // Purge our meta overrides + read cache for every removed id.
    if (removed.length) {
      await this.removeUploadsForSessions(removed, overrides);
      const next = { ...overrides };
      let changed = false;
      for (const id of removed) {
        this.sessionCache.delete(id);
        this.removePlanReviews(id);
        this.removeCheckpoints(id);
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) await this.state.update(SESSION_META_KEY, next);
    }

    // Tear down only ownerless live pool members whose history was deleted.
    const gone = new Set(removed);
    let removedFocused = false;
    for (const s of [...this.pool]) {
      if (s.activeSessionId && gone.has(s.activeSessionId)) {
        removedFocused ||= s === this.focused;
        void this.disposeSession(s);
      }
    }
    if (removedFocused) {
      this.focused = this.newLocalSession();
      await this.startSession();
    }
    this.postSessionsList();
    // `postSessionsList` only refreshes the project the client has SELECTED, so
    // clearing any other one left the rail showing every row it had just deleted
    // — no confirmation, and a later delete on one of those ghosts failed with a
    // permissions error that was really "this is not there any more".
    this.sendLocalRepoSessionsPreview(cwd);
    if (keptForAnotherOwner) this.reportProtectedSession("clear");
  }

  private async pickFileFromComputer(): Promise<void> {
    const picked = await this.host.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Add to chat"
    });
    if (!picked || picked.length === 0) return;
    for (const filePath of picked) {
      try {
        await this.addDroppedFile(filePath, false);
      } catch (e) {
        // Per-file: one unreadable pick must not abort the rest of a multi-select.
        this.host.appendLine(`[image] could not attach ${filePath}: ${(e as Error).message}`);
        void this.host.showErrorMessage(`Grok: could not attach ${path.basename(filePath)} — ${(e as Error).message}`);
      }
    }
    this.revealAndFocusComposer();
  }

  /** The `@` popover's file index, rebuilt at most once per
   *  {@link MENTION_INDEX_TTL_MS}. Keystrokes during a cold build all await the
   *  same findFiles pass instead of stacking one per key. Open editors that the
   *  findFiles cap missed are merged in on every read (not cached) so a newly
   *  opened tab is mentionable immediately, and closing it drops it again (#69). */
  private async mentionFileIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const base = await this.mentionFindFilesIndex();
    const merged = mergeMentionEntries(base.absByRel, this.openWorkspaceFileEntries());
    if (merged === base.absByRel) return base;
    return { rels: orderMentionIndex([...merged.keys()]), absByRel: merged };
  }

  /** TTL-cached `findFiles` snapshot only — no open-editor injection. */
  private async mentionFindFilesIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const cached = this.mentionIndex;
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    if (!this.mentionIndexPromise) {
      this.mentionIndexPromise = this.buildMentionIndex()
        .then((idx) => {
          this.mentionIndex = { at: Date.now(), ...idx };
          return idx;
        })
        .finally(() => { this.mentionIndexPromise = null; });
    }
    return this.mentionIndexPromise;
  }

  private async buildMentionIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const cfg = this.host.getConfiguration();
    // findFiles' default excludes are files.exclude ONLY — node_modules lives in
    // search.exclude, so both must be merged in or the index is dependency soup.
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    // Cap is user-tunable (`grok.mentionIndexLimit`) — large monorepos that hit
    // the default 5000 can miss files from `@` autocomplete (#69).
    const limit = clampMentionIndexLimit(
      this.host.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await this.host.findFiles("**/*", exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      // Default asRelativePath prefixes the folder name only in a multi-root
      // workspace — exactly when the prefix is needed to disambiguate. Pass the
      // full Uri so remote schemes match workspace folders (path-only fails).
      const rel = normalizeRelPath(this.host.asRelativePath(uri));
      const abs = uri.fsPath;
      if (!absByRel.has(rel)) absByRel.set(rel, abs);
    }
    return { rels: orderMentionIndex([...absByRel.keys()]), absByRel };
  }

  /** Currently open workspace text tabs as `{rel, abs}` for mention merge.
   *  Non-file schemes and paths outside the workspace are skipped. */
  private openWorkspaceFileEntries(): Array<{ rel: string; abs: string }> {
    return this.host.openWorkspaceTextFiles().map((e) => ({
      rel: normalizeRelPath(e.rel),
      abs: e.abs
    }));
  }

  /** Resolve the xAI key for Speech-to-Text: the `grok.voiceApiKey` setting,
   *  else `GROK_VOICE_API_KEY` / `XAI_API_KEY` from the workspace .env or the
   *  host environment, else the reusable token the CLI stored at `grok login`
   *  (`~/.grok/auth.json`) — so Voice works out of the box for a signed-in user,
   *  no separate console.x.ai key needed (#51). */
  private resolveVoiceApiKey(cwd: string): string | undefined {
    const setting = this.host.getConfiguration("grok").get<string>("voiceApiKey", "");
    const env = { ...process.env, ...this.readDotEnv(cwd) } as Record<string, string | undefined>;
    // Explicit config wins and short-circuits — only touch the credential file
    // when nothing explicit is set (least-privilege; the login token is a
    // last-resort fallback, #51).
    const explicit = resolveVoiceKey({ setting, env });
    if (explicit) return explicit;
    try {
      return extractGrokAuthKey(fs.readFileSync(path.join(resolveGrokHome(process.env), "auth.json"), "utf8"));
    } catch { /* not logged in / unreadable — no key available */ }
    return undefined;
  }

  /** Deliberately separate from the xAI resolver used by summarizeSpeech. */
  private resolveSttApiKey(cwd: string, backend: SttBackend): string | undefined {
    if (backend === "xai") return this.resolveVoiceApiKey(cwd);
    return resolveOpenAiVoiceKey({
      setting: this.voiceSetting(cwd, "voiceOpenAiApiKey", ""),
      env: { ...process.env, ...this.readDotEnv(cwd) }
    });
  }

  private voiceBackendState(cwd: string, provider: AcpProvider): VoiceBackendState {
    const raw = this.voiceSetting<string>(cwd, "voiceBackend", "auto");
    const preference: SttPreference = raw === "xai" || raw === "openai" ? raw : "auto";
    const state = { provider, preference, hasXai: !!this.resolveSttApiKey(cwd, "xai"), hasOpenAi: !!this.resolveSttApiKey(cwd, "openai") };
    return { ...state, backend: pickSttBackend(state), backends: {
      grok: pickSttBackend({ ...state, provider: "grok" }) ?? null,
      codex: pickSttBackend({ ...state, provider: "codex" }) ?? null,
      claude: pickSttBackend({ ...state, provider: "claude" }) ?? null,
      gemini: pickSttBackend({ ...state, provider: "gemini" }) ?? null,
      muse: pickSttBackend({ ...state, provider: "muse" }) ?? null
    } };
  }

  /** Tell the webview whether a voice API key is resolvable, so the mic button
   *  can show a "needs setup" hint up front instead of only failing on click. */
  /** Chat-panel zoom factor (1.0 = 100%). Clamped to the declared 60–300% range. */
  private chatFontScale(): number {
    const pct = this.host.getConfiguration("grok").get<number>("chatFontScale", 100);
    const n = Number.isFinite(pct) ? (pct as number) : 100;
    return Math.min(300, Math.max(60, n)) / 100;
  }

  private postFontScale(): void {
    this.post({ type: "fontScale", value: this.chatFontScale() });
  }

  /** Command Palette: expand (open:true) / collapse (open:false) every tool group
   *  and command IN/OUT box in the focused session. Per-session, in-memory: it's
   *  `emit`ted (not `post`ed) so it lands in the session's replay buffer and a
   *  warm re-focus re-applies the latch; a cold reopen (no buffer) falls back to
   *  the persisted grok.expandCommandOutputs default. Never persisted to disk. */
  setAllToolDetails(open: boolean): void {
    this.emit(this.focused, { type: "setAllToolDetails", open });
  }

  /** Command Palette / Ctrl+F fallback: open in-webview find (#99). `post`
   *  (not emit) so a focus-swap cannot replay it; host-local so a desk
   *  invocation does not pop find on a linked phone. */
  findInSession(): void {
    this.view?.show?.(false);
    this.post({ type: "findInSession" });
  }

  /** grok.showThinking (#26) — whether grok's reasoning traces are shown. Off by
   *  default; hidden traces are replaced by a lightweight "Thinking…" indicator. */
  private showThinking(): boolean {
    return this.host.getConfiguration("grok").get<boolean>("showThinking", false);
  }

  private postShowThinking(): void {
    this.post({ type: "showThinking", value: this.showThinking() });
  }

  /** grok.thumbsFeedback — Settings → General opt-in. Off by default. */
  private thumbsFeedbackEnabled(): boolean {
    return this.host.getConfiguration("grok").get<boolean>("thumbsFeedback", false);
  }

  private postThumbsFeedback(): void {
    this.post({ type: "thumbsFeedback", value: this.thumbsFeedbackEnabled() });
  }

  /** Anonymous, per-install GUID — generated once and kept in shared client state
   *  (so it survives extension updates and identifies this machine across clients).
   *  It's an opaque random id, not tied to any
   *  account or the grok login; it's sent only as an event property so distinct
   *  installs can be counted without identifying anyone. */
  private installId(): string {
    return this.state.getOrCreate(INSTALL_ID_KEY, randomUUID);
  }

  /** Fire the single `session_start` telemetry event for the first real user
   *  message of `session` (callers gate on isFirstSend, so empty sessions
   *  never reach here). Respects VS Code's global telemetry setting + our own
   *  `grok.telemetry.enabled`; fully fire-and-forget. Must not rediscover
   *  providers or resolve credentials — those flags come from the last
   *  providerState / voiceConfigured refresh. */
  private reportSessionStart(session: Session): void {
    // Telemetry must NEVER affect the user's turn. Build the event synchronously
    // from already-cached session + settings + the last connection/voice snapshot
    // (so it captures THIS session's mode/model/effort — focus could move during
    // the turn's awaits), then fire it asynchronously off the send path and
    // swallow any error silently. The PROD project always (dev host / local
    // installs included — only the probe script uses DEV).
    try {
      const enabled = shouldSendTelemetry(
        this.host.isTelemetryEnabled,
        this.host.getConfiguration("grok").get<boolean>("telemetry.enabled", true),
        this.context.extensionId === OFFICIAL_EXTENSION_ID,
      );
      if (!enabled) return;
      const cfg = this.host.getConfiguration("grok");
      const appVersion = this.context.extensionVersion;
      const cwd = this.sessionCwd(session);
      // Read before installId(): getOrCreate would create the id first and make
      // every send look like a returning install. Reuse the value rather than
      // asking twice — PersistedState.get() is a disk-backed read (refreshSync
      // stats the file), so a second call would be a second probe on the send
      // path for an answer we already hold. Only a genuine first run falls
      // through to installId(), and only once ever.
      const existingInstallId = this.state.get<string>(INSTALL_ID_KEY);
      const returningInstall = existingInstallId !== undefined;
      const event = buildSessionStartEvent(
        {
          installId: existingInstallId ?? this.installId(),
          mode: this.displayMode(session),
          model: session.client?.currentModelId || cfg.get<string>("defaultModel", "") || "",
          effort: session.client?.currentReasoningEffort
            || rememberedEffort(
              cfg.get<EffortPrefs>("defaultEffortByProvider", {}),
              session.provider,
              cfg.get<string>("defaultEffort", ""),
            ),
          // Feature flags + host kind + connection snapshot. Config/enum values
          // only — the same class of anonymous property as mode/model/effort,
          // never content, paths, or free text. The builder allowlists every key.
          showThinking: cfg.get<boolean>("showThinking", false),
          expandToolDetails: cfg.get<boolean>("expandCommandOutputs", false),
          steerByDefault: cfg.get<boolean>("steerByDefault", false),
          chatFontScale: Math.round(this.chatFontScale() * 100),
          readRepliesAloud: cfg.get<boolean>("readRepliesAloud", false),
          soundNotifications: cfg.get<boolean>("soundNotifications", false),
          ...sessionStartSurface(),
          host: this.host.appName || undefined,
          hostKind: sessionStartHostKind(this.host.canSwitchWorkspaceFolder),
          appPurpose: this.appPurpose(),
          voiceConfigured: this.lastVoiceConfiguredByCwd.get(normalizeRepoPath(cwd)),
          voiceStreaming: cfg.get<boolean>("voiceStreaming", true),
          voiceLanguageSet: !!String(this.voiceSetting(cwd, "voiceLanguage", "") || "").trim(),
          grokConnected: this.lastProviderConnected?.grok,
          codexConnected: this.lastProviderConnected?.codex,
          claudeConnected: this.lastProviderConnected?.claude,
          geminiConnected: this.lastProviderConnected?.gemini,
          provider: session.provider,
          connectorCount: Object.keys(this.connectedConnectorStore()).length,
          worktree: !!session.worktree,
          returningInstall: returningInstall
        },
        {
          appVersion,
          osName: osNameFromPlatform(process.platform),
          osVersion: os.release(),
          locale: this.host.language || "",
          isDebug: !this.context.isProduction
        },
        randomUUID(),
        new Date().toISOString(),
      );
      // Off the send path entirely; postEvent is itself non-blocking + self-guarding.
      setImmediate(() => postEvent(APTABASE_APP_KEY_PROD, event));
    } catch {
      // Silent — a telemetry failure must never surface to or affect the user.
    }
  }

  private rememberVoiceConfigured(cwd: string, value: boolean): void {
    this.voiceAndMcp.rememberVoiceConfigured(cwd, value);
  }

  private voiceConfiguredMsg(
    cwd: string,
    value: boolean,
    provider: AcpProvider = this.focused.provider,
  ): Extract<HostMsg, { type: "voiceConfigured" }> {
    return this.voiceAndMcp.voiceConfiguredMsg(cwd, value, provider);
  }

  private seedPostedVoiceConfigured(
    destKey: string,
    payload: Extract<HostMsg, { type: "voiceConfigured" }>,
  ): void {
    this.voiceAndMcp.seedPostedVoiceConfigured(destKey, payload);
  }

  private forgetPostedVoiceConfigured(destKey: string): void {
    this.voiceAndMcp.forgetPostedVoiceConfigured(destKey);
  }

  private deliverVoiceConfigured(
    destKey: string,
    payload: Extract<HostMsg, { type: "voiceConfigured" }>,
    send: () => void,
  ): boolean {
    return this.voiceAndMcp.deliverVoiceConfigured(destKey, payload, send);
  }

  private postVoiceConfigured(): void {
    this.voiceAndMcp.postVoiceConfigured();
  }

  private voiceSetting<T>(cwd: string, key: string, fallback: T): T {
    return this.voiceAndMcp.voiceSetting(cwd, key, fallback);
  }

  private async mentionFileIndexForCwd(cwd: string): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    if (pathsEqual(cwd, this.workspaceRoot())) return this.mentionFileIndex();
    const key = normalizeRepoPath(cwd);
    const cached = this.otherCwdMentionIndexes.get(key);
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    const cfg = this.host.getConfiguration();
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    const limit = clampMentionIndexLimit(
      this.host.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await this.host.findFiles({ base: cwd, pattern: "**/*" }, exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      const abs = uri.fsPath;
      const rel = normalizeRelPath(path.relative(cwd, abs));
      if (rel && !absByRel.has(rel)) absByRel.set(rel, abs);
    }
    const value = { at: Date.now(), rels: orderMentionIndex([...absByRel.keys()]), absByRel };
    this.otherCwdMentionIndexes.set(key, value);
    return value;
  }

  private async promptVoiceKeySetup(): Promise<void> {
    return this.voiceAndMcp.promptVoiceKeySetup();
  }

  private rejectVoiceStart(): void {
    this.voiceAndMcp.rejectVoiceStart();
  }

  private claimVoice(cwd: string): boolean {
    return this.voiceAndMcp.claimVoice(cwd);
  }

  private releaseVoice(cwd?: string): void {
    this.voiceAndMcp.releaseVoice(cwd);
  }

  private async reportFfmpegProblem(problem: Extract<FfmpegResolution, { ok: false }>): Promise<void> {
    return this.voiceAndMcp.reportFfmpegProblem(problem);
  }

  private async handleVoiceStart(session: Session = this.focused): Promise<void> {
    return this.voiceAndMcp.handleVoiceStart(session);
  }

  private async startVoiceStream(
    key: string,
    ffmpegPath: string,
    device: string | undefined,
    cwd: string,
    generation: number,
    backend: SttBackend,
  ): Promise<void> {
    return this.voiceAndMcp.startVoiceStream(key, ffmpegPath, device, cwd, generation, backend);
  }

  private async openVoiceStream(): Promise<void> {
    return this.voiceAndMcp.openVoiceStream();
  }

  private commitVoiceStream(text: string): void {
    this.voiceAndMcp.commitVoiceStream(text);
  }

  private async finalizeVoiceStream(): Promise<void> {
    return this.voiceAndMcp.finalizeVoiceStream();
  }

  private stopVoiceInput(session?: Session): void {
    this.voiceAndMcp.stopVoiceInput(session);
  }

  private async handleVoiceStop(): Promise<void> {
    return this.voiceAndMcp.handleVoiceStop();
  }

  private async openDiffEditor(
    session: Session,
    filePath: string,
    oldText: string,
    newText: string,
    requestId?: number | string,
    replaceAll?: boolean,
    sites?: { oldText: string; newText: string; oldLine?: number; newLine?: number }[],
  ): Promise<void> {
    return this.reviewHost.openDiffEditor(session, filePath, oldText, newText, requestId, replaceAll, sites);
  }
  private resolveDiffFilePath(session: Session, filePath: string): string | undefined {
    return this.reviewHost.resolveDiffFilePath(session, filePath);
  }
  private readFileForDiff(session: Session, filePath: string): string | undefined {
    return this.reviewHost.readFileForDiff(session, filePath);
  }
  private async revertToolEdit(
    session: Session,
    msg: {
      toolCallId: string;
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      sites?: { oldText: string; newText: string; oldLine?: number; newLine?: number }[];
    },
  ): Promise<void> {
    return this.reviewHost.revertToolEdit(session, msg);
  }
  private noteReviewToolCall(session: Session, call: unknown): void {
    return this.reviewHost.noteReviewToolCall(session, call);
  }
  private emitReviewCenter(session: Session): void {
    return this.reviewHost.emitReviewCenter(session);
  }
  private forgetReviewPath(session: Session, filePath: string, opts?: { turnId?: string; toolCallId?: string }): void {
    return this.reviewHost.forgetReviewPath(session, filePath, opts);
  }
  private ackReviewReverted(session: Session, blocks: { toolCallId: string; path: string }[]): void {
    return this.reviewHost.ackReviewReverted(session, blocks);
  }
  private async reviewRevertFile(session: Session, filePath: string, scope: ReviewScope): Promise<void> {
    return this.reviewHost.reviewRevertFile(session, filePath, scope);
  }
  private async reviewRevertAll(session: Session, scope: ReviewScope): Promise<void> {
    return this.reviewHost.reviewRevertAll(session, scope);
  }
  private closeDiffForRequest(session: Session, requestId: number | string): void {
    return this.reviewHost.closeDiffForRequest(session, requestId);
  }
  private closeDiffUris(uris: { left: Uri; right: Uri }): void {
    return this.reviewHost.closeDiffUris(uris);
  }
  private applyPlanUpdate(session: Session, u: any): void {
    return this.reviewHost.applyPlanUpdate(session, u);
  }
  private clearPlanEntries(session: Session): void {
    return this.reviewHost.clearPlanEntries(session);
  }
  private async postExitPlanRequest(req: ExitPlanRequest, session: Session, gen: number): Promise<void> {
    return this.reviewHost.postExitPlanRequest(req, session, gen);
  }
  private async withPlanReviewPaths<T extends { text: string }>(
    plans: T[],
    sessionId?: string,
  ): Promise<Array<T & { planPath?: string; planName?: string }>> {
    return this.reviewHost.withPlanReviewPaths<T>(plans, sessionId);
  }
  private removeCheckpoints(sessionId: string): void {
    return this.reviewHost.removeCheckpoints(sessionId);
  }
  private startTurnGitBaseline(session: Session, turn: object): void {
    return this.reviewHost.startTurnGitBaseline(session, turn);
  }
  private async openTurnGitDiff(session: Session, relPath: string): Promise<boolean> {
    return this.reviewHost.openTurnGitDiff(session, relPath);
  }
  private beginCheckpointTurn(session: Session, text: string): void {
    return this.reviewHost.beginCheckpointTurn(session, text);
  }
  private ensureCheckpointTurn(session: Session): Session["checkpointTurn"] | undefined {
    return this.reviewHost.ensureCheckpointTurn(session);
  }
  private snapshotToolCallWrites(
    session: Session,
    toolCall: { kind?: string; rawInput?: unknown; content?: unknown } | undefined,
    cwd: string,
  ): void {
    return this.reviewHost.snapshotToolCallWrites(session, toolCall, cwd);
  }
  private snapshotPendingEditToolCall(session: Session, call: { kind?: string; status?: string; rawInput?: unknown; content?: unknown }): void {
    return this.reviewHost.snapshotPendingEditToolCall(session, call);
  }
  private snapshotRelOrAbsPaths(session: Session, paths: readonly string[], cwd: string): void {
    return this.reviewHost.snapshotRelOrAbsPaths(session, paths, cwd);
  }
  private snapshotAbsPaths(session: Session, absPaths: readonly string[]): void {
    return this.reviewHost.snapshotAbsPaths(session, absPaths);
  }
  private noteCheckpointAfterContent(session: Session, absPath: string, content: string): void {
    return this.reviewHost.noteCheckpointAfterContent(session, absPath, content);
  }
  private persistCheckpointTurn(session: Session): void {
    return this.reviewHost.persistCheckpointTurn(session);
  }
  private disableCheckpointTurn(session: Session, reason: string): void {
    return this.reviewHost.disableCheckpointTurn(session, reason);
  }
  private finishCheckpointTurn(session: Session): void {
    return this.reviewHost.finishCheckpointTurn(session);
  }
  private async rewindFromClientCheckpoints(
    session: Session,
    opts: {
      userBubbleIndex?: number;
      bubbleText?: string;
      totalUserBubbles?: number;
      edit: boolean;
    },
  ): Promise<void> {
    return this.reviewHost.rewindFromClientCheckpoints(session, opts);
  }

  /** Delete a session's plan-review snapshots. They live under globalStorage,
   *  outside grok's session dir, so `deleteSessionDir` never touched them and
   *  every deleted session left its plan Markdown behind forever. Best-effort:
   *  losing a scratch snapshot is never worth failing a delete over. */
  private removePlanReviews(sessionId: string): void {
    // Keep globalStorageUri identity so remote storage stays on the remote fs.
    const dir = Uri.joinPath(
      this.context.globalStorageUri,
      "plan-reviews",
      planReviewSessionDirectoryName(sessionId),
    );
    void this.host.fs.delete(dir, { recursive: true, useTrash: false }).then(
      undefined,
      () => { /* never existed, or already gone */ },
    );
  }

  /**
   * Apply a completed rewind to the live view WITHOUT reloading the session.
   *
   * The CLI has already truncated its own history, and the surviving messages
   * are still correct on screen — so there is nothing to rebuild. The old path
   * (`clearMessages` + `startSession`) blanked the panel to the welcome logo and
   * re-rendered the entire conversation for what is a tail deletion.
   *
   * The replay buffer is cut to the same point, or a focus-swap would rebuild
   * the chat from the pre-rewind history and resurrect every discarded turn.
   */
  private applyRewindToView(session: Session, surviving: number): void {
    session.buffer = truncateReplayBuffer(session.buffer, surviving);
    session.userMessageCount = surviving;
    // The checklist described the turns that just went away. Keeping it would
    // claim steps against a conversation that no longer contains them.
    this.clearPlanEntries(session);
    session.reviewBlocks = dropReviewTurnsAfter(session.reviewBlocks, surviving);
    this.emitReviewCenter(session);
    session.liveFeedbackEligible = false;
    session.turnRating = 0;
    session.historyEventCount = historyEventCount(session.buffer);
    // Positions for anything persisted after this point are counted against the
    // same number the webview now holds.
    this.emit(session, { type: "truncateMessages", surviving });
  }

  /**
   * Confirm via the webview's own in-chat dialog instead of a native modal.
   *
   * Every other destructive confirm moved in-chat in 2.0.0 so it behaves the
   * same in the sidebar and the AFK Pilot browser client; rewind/edit were left
   * on `showWarningMessage`. They can't simply call `uiConfirm` themselves,
   * because only the HOST knows whether files are at stake — hence the
   * round-trip.
   *
   * Session teardown/replacement resolves false (drainPendingConfirms): a
   * lost confirm must fail closed, never silently revert files.
   */
  private confirmInChat(
    session: Session,
    opts: { title: string; body?: string; confirmLabel: string; danger?: boolean },
  ): Promise<boolean> {
    const id = `confirm-${++this.confirmSeq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(id, { session, resolve });
      this.emit(session, { type: "uiConfirmRequest", id, ...opts });
    });
  }

  /** Fail every confirm this session still awaits closed, and take the modal
   *  down on every surface (upstream e2e8458). Before this, a confirm asked
   *  just before a restart awaited an answer nobody could give. */
  private drainPendingConfirms(session: Session): void {
    if (!this.pendingConfirms) return;
    for (const [requestId, pending] of this.pendingConfirms) {
      if (pending.session !== session) continue;
      this.pendingConfirms.delete(requestId);
      this.emit(session, { type: "uiConfirmResolved", requestId });
      pending.resolve(false);
    }
  }

  private async createPlanReviewSnapshot(plan: string, sessionId?: string): Promise<{ path: string; name: string }> {
    const content = plan && plan.trim() ? plan : "(empty plan)\n";
    const sessionPart = planReviewSessionDirectoryName(
      sessionId ?? this.focused.activeSessionId ?? this.focused.client?.sessionId ?? "session",
    );
    // Join under globalStorageUri so workspace.fs targets the same scheme VS Code
    // gave us (vscode-remote on remote hosts — never rebuild with Uri.file).
    const dir = Uri.joinPath(this.context.globalStorageUri, "plan-reviews", sessionPart);
    await this.host.fs.createDirectory(dir);
    // Content-addressed, so re-snapshotting the same plan on every restore
    // reuses one file instead of writing a new one forever.
    const fileUri = Uri.joinPath(dir, planReviewFileName(content));
    let existing: string | undefined;
    try {
      existing = Buffer.from(await this.host.fs.readFile(fileUri)).toString("utf8");
    } catch { /* first time for this plan */ }
    if (existing !== content) {
      // Different content under the same name means a hash collision — fall back
      // to a unique name rather than overwriting someone else's plan.
      const target = existing === undefined ? fileUri : await this.uniquePlanReviewUri(dir, planReviewFileName(content));
      await this.host.fs.writeFile(target, Buffer.from(content, "utf8"));
      return { path: target.fsPath, name: path.basename(target.fsPath) };
    }
    return { path: fileUri.fsPath, name: path.basename(fileUri.fsPath) };
  }

  private async uniquePlanReviewUri(dir: Uri, fileName: string): Promise<Uri> {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    for (let i = 0; i < 100; i += 1) {
      const suffix = i === 0 ? "" : `-${i + 1}`;
      const candidate = Uri.joinPath(dir, `${stem}${suffix}${ext}`);
      try {
        await this.host.fs.stat(candidate);
      } catch {
        return candidate;
      }
    }
    return Uri.joinPath(dir, `${stem}-${Date.now()}${ext}`);
  }

  /** Track an in-flight attachment-staging op (paste / drop / pick). Message
   *  ordering only guarantees an op posted before send has STARTED handling —
   *  its fs awaits can still be mid-flight when handleSend runs (VS Code does
   *  not serialize async onDidReceiveMessage handlers), so handleSend settles
   *  this set before snapshotting chips: the chip must make THIS send, not the
   *  next one. */
  private trackAttach(op: Promise<unknown>): Promise<void> {
    const tracked = op.then(() => undefined);
    this.pendingAttach.add(tracked);
    const done = () => { this.pendingAttach.delete(tracked); };
    void tracked.then(done, done);
    return tracked;
  }

  /**
   * Session-NEUTRAL staging dir for images waiting in the composer. Deliberately
   * NOT the grok session dir: composer chips are provider-level state that
   * outlives sessions, while a session dir is deleted by the empty-session
   * cleanup (parkFocused / discardRestartedEmptySession / history delete), which
   * would kill a pasted screenshot before it was ever sent. Staging also works
   * with no live session at all (paste during startup/onboarding just works).
   */
  private imageStagingDir(): string {
    // Node-fs staging path — genuine local disk on the extension host (v3.1.0
    // also used globalStorageUri.fsPath here; not a workspace.fs address).
    return path.join(this.context.globalStorageUri.fsPath, "image-staging");
  }

  private fileStagingDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "file-staging");
  }

  /** Delete staged images older than 7 days. A pending attachment lives for
   *  minutes; anything week-old is an orphan (pasted, never sent, window
   *  closed). The age gate keeps a second VS Code window's fresh staging
   *  files safe — globalStorage is shared across windows. */
  private async sweepImageStaging(): Promise<void> {
    const dir = this.imageStagingDir();
    try {
      const cutoff = Date.now() - GrokSidebar.STAGING_ORPHAN_TTL_MS;
      for (const name of await fs.promises.readdir(dir)) {
        const p = path.join(dir, name);
        try {
          if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.unlink(p);
        } catch { /* raced or locked — next sweep gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
  }

  /** Keep sent documents for their session's lifetime; only abandoned staging
   * directories use the seven-day orphan policy shared with images. */
  private async sweepFileStaging(): Promise<void> {
    const root = this.fileStagingDir();
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const retained = retainedUploadDirectories(root, overrides);
    try {
      const cutoff = Date.now() - GrokSidebar.STAGING_ORPHAN_TTL_MS;
      for (const name of await fs.promises.readdir(root)) {
        const dir = path.join(root, name);
        // Reuse the owned-path validator with a synthetic leaf: unknown entries
        // in globalStorage are not ours to remove.
        const owned = stagedUploadDirectory(root, path.join(dir, "_"));
        if (!owned) continue;
        const key = process.platform === "win32" ? path.resolve(owned).toLowerCase() : path.resolve(owned);
        if (retained.has(key)) continue;
        try {
          if ((await fs.promises.stat(owned)).mtimeMs < cutoff) {
            await fs.promises.rm(owned, { recursive: true, force: true });
          }
        } catch { /* raced or locked — next activation gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
  }

  private async retainUploadedFilesForSession(session: Session, chips: ContextChip[]): Promise<void> {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const uploaded = chips
      .filter(isFileChip)
      .filter((chip) => !chip.hidden && !!stagedUploadDirectory(this.fileStagingDir(), chip.path))
      .map((chip) => chip.path);
    if (!uploaded.length) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const files = [...new Set([...(cur.uploadedFiles ?? []), ...uploaded])];
    await this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...cur, uploadedFiles: files }
    });
  }

  /** Remove UUID upload directories owned only by the sessions being deleted.
   * Shared source/fork references keep the file alive. */
  private async removeUploadsForSessions(
    ids: Iterable<string>,
    overrides: SessionMetaOverrides,
  ): Promise<void> {
    const files = unreferencedUploadsForRemovedSessions(overrides, ids);
    const dirs = new Set(
      files
        .map((file) => stagedUploadDirectory(this.fileStagingDir(), file))
        .filter((dir): dir is string => !!dir),
    );
    for (const dir of dirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (e) {
        this.host.appendLine(`[upload] could not remove staged document directory: ${(e as Error).message}`);
      }
    }
  }

  /** Write image bytes into staging and attach the chip. The `[Image #N]`
   *  index is stamped once here (`allocateImageIndex`) and is never rewritten. */
  private async stageImageAttachment(
    bytes: Buffer,
    mimeType: string,
    originPath?: string,
    owner: AttachmentOwner = () => this.focused,
    previewId?: string,
  ): Promise<Session | undefined> {
    const dir = this.imageStagingDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `image-${randomUUID()}${extFromMime(mimeType)}`);
    await fs.promises.writeFile(absPath, bytes);
    const session = owner();
    if (!session) {
      // The asking tab left while this was writing. Delivering it anywhere else
      // would put its image in someone else's conversation; the staged copy is
      // left for the seven-day sweep rather than deleted, in case the write
      // raced a reconnect that is about to come back.
      return undefined;
    }
    const rel = originPath
      ? normalizeRelPath(path.relative(this.sessionCwd(session), originPath))
      : undefined;
    // asRelativePath returns the input unchanged for files outside the
    // workspace — only carry the origin when it's a real workspace-relative path.
    const originRelPath = rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)
      ? rel
      : undefined;
    const allocated = allocateImageIndex(session.imageIndexHighWater, [
      ...session.chips,
      ...session.queuedSends.flatMap((item) => item.chips),
    ]);
    session.imageIndexHighWater = allocated.highWater;
    session.chips.push(makeImageChip(absPath, allocated.index, mimeType, originRelPath, previewId));
    this.postChips(session);
    return session;
  }

  /** Clipboard paste from the webview (base64 + mime, already prefiltered to
   *  raster image types there — re-checked here since the webview isn't a
   *  trust boundary). */
  private async addPastedImage(
    base64: string,
    mimeType: string,
    owner: AttachmentOwner = () => this.focused,
    previewId?: string,
  ): Promise<void> {
    try {
      if (!isVisionMime(mimeType)) {
        this.notifyUser("error", `Grok: unsupported image type ${mimeType} — use PNG, JPEG, GIF, or WebP.`);
        return;
      }
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) return;
      if (bytes.length > MAX_VISION_IMAGE_BYTES) {
        this.notifyUser("error", "Grok: pasted image exceeds the 20 MiB vision limit.");
        return;
      }
      const session = await this.stageImageAttachment(bytes, mimeType, undefined, owner, previewId);
      if (session === this.focused) this.revealAndFocusComposer();
    } catch (e) {
      this.host.appendLine(`[image] paste failed: ${(e as Error).message}`);
      this.notifyUser("error", `Grok: could not attach the pasted image — ${(e as Error).message}`);
    }
  }

  /** Copy an on-disk raster image into staging as a vision attachment, keeping
   *  the workspace-relative origin so the prompt tag can carry the real file
   *  identity. Three outcomes, and they are not interchangeable: the owning
   *  session when it attached, `false` when the file should stay a plain path
   *  chip (oversized, or unreadable as a regular file), and `undefined` when the
   *  asking tab left — which must drop the attachment rather than degrade it to
   *  a path chip in someone else's conversation. */
  private async importImageFromDisk(
    srcPath: string,
    owner: AttachmentOwner = () => this.focused,
  ): Promise<Session | false | undefined> {
    const stat = await fs.promises.stat(srcPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_VISION_IMAGE_BYTES) return false;
    const bytes = await fs.promises.readFile(srcPath);
    return this.stageImageAttachment(bytes, mimeFromPath(srcPath), srcPath, owner);
  }

  private async addDroppedFile(
    dropped: string,
    shiftHeld: boolean,
    owner: AttachmentOwner = () => this.focused,
  ): Promise<Session | undefined> {
    return this.voiceAndMcp.addDroppedFile(dropped, shiftHeld, owner);
  }

  // ── Context chips: diagnostics and terminal (AP-03) ──────────────────────
  //
  // Two halves, deliberately far apart in time:
  //   attach — probe the source through the host facade, refuse an empty one,
  //            stage a chip that holds only metadata;
  //   send   — read the source AGAIN (contextChipPayloads) and hand the fresh
  //            bytes to the prompt builder.
  // Nothing carries content between the two. A chip attached before a build ran
  // must send the problems the build produced, not the empty list from before.

  /**
   * Stage `@problems` / `@terminal`.
   *
   * The probe is also the emptiness check: no problems and no captured output
   * mean there is nothing to attach, and saying so beats a chip that silently
   * contributes an empty block at send. A facade that throws lands in the same
   * branch — the user is told, the composer is untouched.
   */
  private addContextSourceChip(
    source: ContextSourceId,
    owner: AttachmentOwner,
  ): void {
    const session = owner();
    if (!session) return; // asking tab gone — drop, never redirect
    let chip: ContextChip;
    if (source === "problems") {
      let count: number;
      try {
        count = this.host.getDiagnostics({ scope: "workspace" }).length;
      } catch (e) {
        this.host.appendLine(`[context-chip] diagnostics probe failed: ${(e as Error).message}`);
        this.notifyUser("warning", "Could not read the editor's problems.");
        return;
      }
      if (!count) {
        this.notifyUser("info", "No problems reported — nothing to attach.");
        return;
      }
      chip = makeDiagnosticsChip({ scope: "workspace", count });
    } else {
      let capture: HostTerminalCapture | undefined;
      try {
        capture = this.host.getTerminalCapture();
      } catch (e) {
        this.host.appendLine(`[context-chip] terminal probe failed: ${(e as Error).message}`);
        this.notifyUser("warning", "Could not read the terminal.");
        return;
      }
      if (!capture?.text.trim()) {
        this.notifyUser("info",
          "No terminal output captured yet. Run a command in the integrated terminal first — capture needs shell integration.",
        );
        return;
      }
      chip = makeTerminalChip({
        label: capture.label,
        bytes: Buffer.byteLength(capture.text, "utf8")
      });
    }
    session.chips.push(chip);
    this.postChips(session);
  }

  /**
   * Collect, at SEND, what every visible non-file chip contributes.
   *
   * Returns a resolver for `PromptBuilderDeps.contextChipPayload`. A source that
   * throws or emptied resolves to `undefined`, which the builder renders as
   * nothing at all — the send goes through with one fewer block rather than
   * failing, the same degradation an unreadable selection already gets.
   */
  private contextChipPayloads(
    chips: readonly ContextChip[],
  ): (chip: ContextChip) => ContextChipPayload | undefined {
    const payloads = new Map<string, ContextChipPayload>();
    for (const chip of chips) {
      if (chip.hidden || isFileChip(chip)) continue;
      try {
        if (isDiagnosticsChip(chip)) {
          const items = this.host.getDiagnostics({ scope: chip.scope, path: chip.path });
          payloads.set(chip.id, { kind: "diagnostics", items });
        } else if (isTerminalChip(chip)) {
          const capture = this.host.getTerminalCapture();
          if (capture) payloads.set(chip.id, { kind: "terminal", label: capture.label, text: capture.text });
        }
      } catch (e) {
        // Logged, never fatal: the turn the user asked for still goes.
        this.host.appendLine(
          `[context-chip] ${contextChipLabel(chip)} could not be collected: ${(e as Error).message}`,
        );
      }
    }
    return (chip) => payloads.get(chip.id);
  }

  /** A prompt is running or pending user action — a new prompt now would
   *  cancel it (a second `session/prompt` kills the in-flight turn). */
  /** Whether a prompt is genuinely running. This used to read `status`, which
   *  cannot tell "working" from "was working and never settled" — see
   *  Session.turnToken for the wedge that cost. */
  private turnInFlight(session: Session): boolean {
    return turnIsInFlight(session);
  }

  /** A cancel is a request, not an outcome: `client.prompt()` settling is the ONLY
   *  thing that ends a turn, so a cancel the CLI never answers leaves the session
   *  pinned mid-turn and every later send diverted into the queue — permanently,
   *  with nothing on disk to show for it.
   *
   *  Recovery RESTARTS the process rather than declaring the turn over locally.
   *  Declaring it over is not enough and is worse than doing nothing: the client
   *  is still live and its handlers are fenced only by `gen`, so a cancel that
   *  eventually produces chunks, a permission request or a completion would pour
   *  them into whatever turn is current by then — and flushing the queue would
   *  put a second prompt on a client that may still be running the first.
   *  `startSession` is the fence this codebase already has: it bumps `gen` (so
   *  every event from the old client is ignored), disposes it, clears the turn
   *  token, and resumes this same conversation from disk so nothing is lost.
   *
   *  A CLI that has ignored a stop request for ten seconds is wedged; replacing
   *  the process is the honest reading of what the user asked for. */
  private armCancelRecovery(session: Session, token: object): void {
    const gen = session.gen;
    setTimeout(() => {
      if (gen !== session.gen) return; // already restarted or replaced
      if (session.turnToken !== token) return; // the cancel was honoured
      void this.recoverUnansweredCancel(session, token);
    }, CANCEL_SETTLE_GRACE_MS);
  }

  private async recoverUnansweredCancel(session: Session, token: object): Promise<void> {
    // Nothing to recover if the client is already gone — something else tore it
    // down (a crash, a removed worktree), and respawning here would resurrect a
    // session that was deliberately ended, possibly against a cwd that no longer
    // exists. Belt to the generation check: whoever disposes a client is
    // expected to invalidate the turn, and this survives one that forgets.
    if (!session.client) {
      endTurn(session, token);
      return;
    }
    this.host.appendLine("[turn] cancel went unanswered; restarting this session's CLI");
    // Said BEFORE the restart, deliberately. startSession unlocks the composer
    // and flushes any queued sends itself, so a notice emitted afterwards could
    // land behind that queued turn's userMessage/agentStart — reading as if the
    // new turn had failed, and clearing the busy state of a turn that had only
    // just begun. Live-only as a consequence (the restart clears the buffer);
    // the conversation itself is reloaded from disk intact.
    session.staleSendReported = true;
    this.emit(session, {
      type: "agentError",
      text: "Stopped. The agent didn't answer the stop request, so its process is being restarted. This conversation is intact.",
      ...this.turnEndFields(session, "cancelled")
    });
    const client = await this.startSession(session.activeSessionId, session);
    // Another restart can overtake this one while it is starting. Then the
    // session belongs to that one, and nothing here has anything to say about
    // it — least of all an error.
    if (session.client && session.client !== client) return;
    if (!session.client) {
      // startSession clears the token on its way through, but it can fail before
      // reaching that; either way this session must not be left pinned mid-turn.
      endTurn(session, token);
      this.emit(session, {
        type: "agentError",
        text: "The agent's process couldn't be restarted. Send again to start it."
      });
      this.setStatus(session, "error");
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
  private divertRacingSend(
    session: Session,
    text: string,
    bare: boolean,
    chips: ContextChip[] = explicitVisibleChips(session.chips),
  ): void {
    if (bare) {
      this.emit(session, {
        type: "error",
        text: "Grok is mid-turn — that command was not run. Try again when the turn finishes."
      });
      return;
    }
    if (!text.trim() && !chips.length) return;
    session.queuedSends = enqueueQueuedSend(session.queuedSends, text, chips);
    if (chips.length) {
      session.chips = consumeChips(session.chips, chips);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }
    this.emitQueuedSends(session);
    void this.maybeFlushQueuedSends(session);
  }

  private async handleSend(
    text: string,
    bare = false,
    target?: Session,
    queuedSendCommit?: { text: string; items: QueuedSendEntry[] },
    submissionId?: string,
  ): Promise<void> {
    // `target` lets a queued-send flush fire into a BACKGROUNDED session (its
    // turn ended while another was focused). Only the focused session may spawn
    // a client on demand; a background target without one has nothing to talk to.
    const session = target ?? this.focused;
    // Backstop for every OTHER caller of this method — a queued send flushed
    // after a turn, a routine prompt. `/agent` is host-answered and must never
    // reach a CLI as a prompt (AP-10); the composer path catches it earlier so
    // it does not consume a queued-send dispatch. A briefing never starts with
    // `/agent`, so the role run below cannot re-enter this branch.
    //
    // Parsed synchronously, awaited only on a hit: an unconditional await on
    // entry suspends every send before the `turnInFlight` fast path below, and
    // the races that path exists for are decided in exactly that window.
    if (parseAgentCommand(text).kind !== "none") {
      await this.handleAgentCommand(text, session);
      return;
    }
    // AP-11. Same backstop, same synchronous-guard rule. A briefing never
    // starts with one of these either, so a role run cannot re-enter here.
    if (parseHandoffCommand(text).kind !== "none") {
      await this.handleHandoffCommand(text, session);
      return;
    }
    if (parseCrewCommand(text).kind !== "none") {
      await this.handleCrewCommand(text, session);
      return;
    }
    if (parseSubagentsCommand(text).kind !== "none") {
      this.handleSubagentsCommand(text, session);
      return;
    }
    if (session.sessionType === "crew" && !session.pendingHiddenChild) {
      await this.handleCrewSessionInput(text, session);
      return;
    }
    await this.waitForSessionStart(session);
    // Desk↔remote co-attach: the OTHER view only learns `busy` once the
    // mirrored agentStart crosses the relay, so a send can race through that
    // window into a turn that is already running — and a second
    // `session/prompt` cancels the in-flight turn (see steerIntoTurn's note).
    // Serialize host-side: such a send joins the queued-send path, which is
    // what the sender's own chat.js does when it knows in time. A remote send
    // was already metered on ingress, so the flag stays as-is (queueSend's
    // sticky rule governs unmetered contributions). This entry check is the
    // fast path only — the awaits below can suspend past it, so the SAME
    // check runs again at the commit point, where everything through
    // setStatus("working") is synchronous.
    // maybeFlushQueuedSends can never re-enter this branch: it only flushes
    // when the turn is over (queuedSendReadyText).
    if (this.turnInFlight(session)) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }
    // Priming is latched before a client exists (sign-out replacements start
    // sequentially). A phone send in that gap used to call ensureClient and
    // race the planned replace. Queue whenever startup already owns this
    // session — not only when a client is sitting without a session id.
    if (session.priming || (session.client && !sessionReadyForPrompt(session))) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }
    const client = session.client ?? await this.ensureClient(session);
    if (!client) return;
    // ensureClient may return mid-startSession; re-check before committing work.
    if (!sessionReadyForPrompt(session)) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }
    const gen = session.gen;

    // An attachment posted before send has started staging (message ordering),
    // but its fs awaits can still be mid-flight — a paste is ms, a 20MiB drop
    // import is tens of ms. Settle the in-flight set so its chip makes THIS
    // send. One-shot snapshot on purpose: an op starting during this await was
    // posted after send, so it belongs to the next turn.
    const staging = [...this.pendingAttach];
    if (staging.length) {
      await Promise.allSettled(staging);
      if (gen !== session.gen) return;
    }

    // Snapshot attachments. A live send reads the composer's chips; a queued
    // flush uses the per-item copies snapshotted at queue time so a later
    // composer remove cannot silently drop them. `bare` sends (gear-menu
    // /compact) carry none. `[Image #N]` is the attach-time index on those
    // chips — send does not renumber.
    const queuedItems = !bare && queuedSendCommit?.items.length
      ? queuedSendCommit.items.map((item) => ({ text: item.text, chips: item.chips ?? [] }))
      : undefined;
    const implicitChips = session.chips.filter((chip) => isImplicitChip(chip));
    let chips: ContextChip[] = [];
    let contributions: QueuedPromptContribution[] | undefined;
    if (bare) {
      chips = [];
    } else if (queuedItems) {
      contributions = [];
      const queuedChips: ContextChip[] = [];
      for (const item of queuedItems) {
        const itemImages: PromptImageInput[] = [];
        for (const chip of item.chips) {
          if (chip.hidden || !isFileChip(chip) || !isImageChip(chip)) continue;
          const read = await this.readImageChip(chip, session, gen);
          if (read === "gone") return;
          if (read === "failed") return;
          itemImages.push(read);
        }
        contributions.push({ text: item.text, chips: item.chips, images: itemImages });
        queuedChips.push(...item.chips);
      }
      chips = [...queuedChips, ...implicitChips];
    } else {
      chips = [...session.chips];
    }

    // Pre-read every visible image BEFORE anything is cleared or sent. Any
    // failure blocks the whole send with the chips intact — never a prompt
    // whose [Image #N] tag has no image block behind it (a dangling tag sends
    // grok hunting the workspace for an image it was never given).
    const images: PromptImageInput[] = contributions
      ? contributions.flatMap((contribution) => contribution.images)
      : [];
    if (!contributions) {
      for (const chip of chips) {
        if (chip.hidden || !isFileChip(chip) || !isImageChip(chip)) continue;
        const read = await this.readImageChip(chip, session, gen);
        if (read === "gone") return;
        if (read === "failed") return;
        images.push(read);
      }
    }
    // Mirror the failure path's guard: if the client was torn down during the
    // pre-read awaits, bail BEFORE consuming chips / unlinking staged files —
    // the composer keeps its attachments for the session that replaced us.
    if (gen !== session.gen) return;

    // A leading context envelope knocks a slash command off position 0 of the
    // text block, and the CLI then routes it to the LLM instead of dispatching
    // it (a /compact that *grew* the context 6x in testing — see
    // research/compact.md). Confirmed commands flip the prompt order so the
    // command keeps position 0 and the context trails it.
    const slashCommand = matchSlashCommand(
      text,
      client.availableCommands.map((c) => c.name),
    );
    const promptDeps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      extName: (p: string) => path.extname(p),
      // The whole point of the chip split: the diagnostics and terminal state
      // read HERE, after every attachment await, not the state that existed
      // when the chip was staged.
      contextChipPayload: this.contextChipPayloads(chips)
    };
    // AP-16 §6.8. Parsed from the composer text, stripped out of it, and
    // appended as one block AFTER the context envelope so it cannot knock a
    // slash command off position 0 (the same reason the envelope trails one).
    // Replaced on every send, including a send with none — which is how the
    // previous turn's directives stop applying.
    const directives = this.applyTurnDirectives(session, text);
    const directiveText = directives.text;
    const { blocks: promptBlocks } = contributions
      ? buildQueuedPromptWithImages(contributions, implicitChips, promptDeps, slashCommand != null)
      : buildPromptWithImages(directiveText, chips, images, promptDeps, slashCommand != null);
    if (directives.block) {
      const last = promptBlocks[promptBlocks.length - 1];
      if (last && last.type === "text") last.text = `${last.text}

${directives.block}`;
      else promptBlocks.push({ type: "text", text: directives.block });
    }

    // Unlike images, document bytes are read lazily by Grok from the path in
    // the prompt. Persist ownership before consuming the chip or sending.
    await this.retainUploadedFilesForSession(session, chips);
    if (gen !== session.gen) return;

    // COMMIT-POINT re-check: that was the last await before this send turns
    // into a prompt — everything from here through setStatus("working") is
    // synchronous. Without this, two views' sends could both pass the entry
    // check while one was still reading attachments, and the second prompt
    // would cancel the first turn. Runs before chips are consumed, so a
    // diverted send leaves its attachments staged for the queued flush.
    if (this.turnInFlight(session)) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare, explicitVisibleChips(chips));
      return;
    }

    if (queuedSendCommit) {
      if (!finishQueuedSendCommit(session, queuedSendCommit, true)) return;
      this.emitQueuedSends(session);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }

    if (bare) {
      this.postChips(session);
    } else if (!queuedSendCommit) {
      // One-shot attachments are consumed by the send; the implicit context
      // chip mirrors IDE state and stays resident (like Claude Code's). Keep
      // it through the clear so refreshImplicitChip sees `prev` — preserving
      // the user's eye-off choice and no-op-diffing against the live editor.
      // Consume by id, not wholesale: a chip staged after the snapshot (while
      // images were pre-reading) belongs to the next turn and must survive.
      session.chips = consumeChips(session.chips, chips);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }
    // Keep staged image sources until the seven-day orphan sweeper. The prompt
    // carries each path so live and restored history can render a thumbnail;
    // a missing/expired source simply falls back to the image tag.

    const isFirstSend = !session.hasHistory;
    session.hasHistory = true;
    if (isFirstSend) {
      void this.rememberProjectProvider(
        this.sessionCwd(session),
        session.provider,
        session.client?.currentModelId,
      );
      if (session.client?.sessionId) {
        this.emit(session, {
          type: "session",
          sessionId: session.client.sessionId,
          models: this.modelsForSession(session, session.client.availableModels, session.client.currentModelId, false),
          currentModelId: session.client.currentModelId,
          worktree: !!session.worktree,
          provider: session.provider
        });
      }
      // Image-only first message: leave the title source empty so grok's own
      // generated summary shows through, instead of pinning a permanent
      // "[Image #1]" customName over every screenshot-first session.
      session.firstUserMessageForTitle = text;
      // One `session_start` per session, on the first real user message.
      this.reportSessionStart(session);
      // ST-2. This send is the first submitted content, whatever it consists of
      // — text, a voice utterance, or nothing but chips and images. The type is
      // settled from here on and never comes undone, not by a rewind either.
      this.lockSessionTypeNow(session);
    }
    const sentChips = chips.filter((c) => !c.hidden);
    session.userMessageCount += 1;
    this.beginCheckpointTurn(session, text);
    session.inUserMessage = false; // live send isn't part of the streamed-chunk count path
    this.emit(session, { type: "userMessage", text, chips: sentChips, submissionId });
    this.emit(session, { type: "agentStart" });
    // The token, not the status, is what says a turn is running from here on —
    // and only whoever holds it may end this one.
    const turn = beginTurn(session);
    this.startTurnGitBaseline(session, turn);
    this.setStatus(session, "working");
    // The send IS the activity — the rail should not wait ~2s for the CLI to
    // write a transcript before admitting you are working in this conversation.
    this.noteSessionActivity(session);

    try {
      session.adapterCompactThisTurn = false;
      session.compactUsageArmed = false;
      session.adapterTurnCallUsed = [];

      if (slashCommand === "compact" && session.provider === "gemini") {
        this.emit(session, {
          type: "messageChunk",
          text: "Antigravity manages and compacts context automatically in the background. No manual compaction is needed — you can continue chatting normally."
        });
        if (endTurn(session, turn)) {
          if (!turnIsInFlight(session)) this.emit(session, { type: "agentEnd" });
          this.noteLiveTurnEnded(session);
          if (!turnIsInFlight(session)) this.setStatus(session, "done");
          this.noteSessionActivity(session);
        }
        return;
      }

      // Arm the compact-notification watch BEFORE the prompt: the live
      // auto_compact_completed / auto_compact_failed land DURING this turn.
      if (slashCommand === "compact") {
        session.sawCompactFailed = false;
        session.sawCompactNotification = false;
        if (isAdapterProvider(session.provider)) {
          session.adapterCompactThisTurn = true;
          this.rememberAdapterContext(session, { compacted: true });
        }
      }
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) {
        this.emitAbandonedSend(session);
        return;
      }
      // A cancel recovery may have settled this turn already; a second agentEnd
      // would end a turn that is no longer ours.
      if (!endTurn(session, turn)) return;
      if (slashCommand === "compact") {
        // A native /compact streams no agent content (research/compact.md), so
        // the turn would end with a blank bubble and no sign it worked. Paint a
        // live-only confirmation into that empty bubble — UNLESS compaction failed
        // (auto_compact_failed set sawCompactFailed), in which case the failure
        // note already showed and a "Compacted." would contradict it. Deliberately
        // not persisted: grok's own history has no such message, so re-focus keeps
        // it but a disk restore won't.
        if (!session.sawCompactFailed) this.emit(session, { type: "messageChunk", text: "Compacted." });
        // The live compact rail is exact and wins. Older Grok CLIs fall through
        // to the control-plane meter; only an explicit -32601 may use the hidden
        // legacy prompt fallback.
        if (session.provider === "grok" && !session.sawCompactNotification) {
          await this.refreshContextAfterCompact(client, session, gen);
          if (gen !== session.gen) return;
        }
      }
      // Nor does it get to say the turn ENDED. Browsers treat agentEnd as
      // authoritative and clear busy on it, so a stale compact handler
      // resuming after a newer turn started would leave every remote tab
      // showing that turn as idle, with no Stop control — and a refresh does
      // not repair it, because the snapshot replays the same order. The newer
      // turn emits its own end when it really ends. (The other agentEnd site
      // needs no guard: nothing awaits between its endTurn check and its
      // emit.)
      // AP-16 / D20. The CLI has ended its ACP prompt turn, but the HOST turn
      // spans the whole delegation: a subagent this turn started is still
      // running, still spending a subscription, and still owed a card. Holding
      // here keeps the status dot, the Stop button, the pool's never-reap rule
      // and the composer's queue-or-steer behaviour all consistent with what is
      // actually happening. `maybeFinishSubagentTurn` ends the turn when the
      // last child is terminal.
      if (this.holdTurnForSubagents(session, meta)) return;
      if (!turnIsInFlight(session)) this.emit(session, { type: "agentEnd", meta, ...this.turnEndFields(session, turnStatusFromPromptResult(meta)) });
      this.noteLiveTurnEnded(session);
      // "done" only if this is still the LAST word. /compact releases its turn
      // token before awaiting the context refresh, so a send from another tab
      // can start a turn while this handler is suspended — and marking the
      // session done then tells every view the agent is idle while it is not.
      // On a cloud machine it also stops the heartbeat, which reads the status:
      // a quiet long-running tool in the newer turn is then frozen ninety
      // seconds later.
      if (!turnIsInFlight(session)) this.setStatus(session, "done");
      // Again at the end: by now the transcript really has moved, so this is
      // the push that makes the row's position true rather than asserted.
      this.noteSessionActivity(session);
      session.authRecoveryTried = false; // a clean turn re-arms token auto-recovery
      // A served turn is the only proof the account works; it takes the
      // sign-in card down, and nothing takes it down before one arrives.
      this.setProviderNeedsLogin(session.provider, false);
      this.maybeGenerateTitle(session);
      this.postSessionName(session);
    } catch (err) {
      if (gen !== session.gen) {
        this.emitAbandonedSend(session);
        return;
      }
      // Same rule as the success path: if a cancel recovery already ended this
      // turn, the failure it eventually reported is not ours to announce.
      // Checked BEFORE the auth resend, which starts a turn of its own.
      if (!endTurn(session, turn)) return;
      const e = err as any;
      // A rate/usage-limit failure is not a credential problem: skip auth
      // recovery (its retry would end on the login screen) and offer the
      // failover card instead of a generic error (#57 / AP-06). The card
      // is posted first so a limit never also rebuilds the session against
      // the same ceiling.
      if (this.surfaceLimitError(session, e, text, sentChips)) return;
      if (this.surfaceContextOverflow(session, e, text, sentChips)) return;
      // An expired-token error wedges only THIS long-lived process (the CLI shares
      // ~/.grok/auth.json across the pool + sibling `grok login`); transparently
      // reload the process and resend before surfacing the error (see method doc).
      if (await this.recoverAuthAndResend(session, e, text, sentChips, promptBlocks)) return;
      // Recovery declined (already retried this streak, or not auth-shaped):
      // promptErrorText keeps the copy consistent — the entitlement notice for
      // billing-flavored wording (#58), the raw detail otherwise.
      // A prompt failure reached the transcript and NOTHING reached the log:
      // the owner sent two messages to a Codex session, saw a bare “Internal
      // error” twice, and the host had no record either happened. An error we
      // show a person and cannot ourselves account for is the shape that costs
      // an evening — the rail's version verdict was the same mistake.
      //
      // The session id is what makes it diagnosable: it says whether the
      // prompt went to the session the person is looking at.
      this.host.appendLine(
        `[${session.provider}] prompt failed for session ${session.client?.sessionId ?? session.activeSessionId ?? "none"}`
        + `: ${errorDetail(e)}`,
      );
      this.emit(session, { type: "agentError", text: promptErrorText(e), ...this.turnEndFields(session, "failed") });
      this.noteLiveTurnEnded(session);
      this.setStatus(session, "error");
    } finally {
      // Belt to the braces above: however this turn left — an early return on a
      // switched session, a throw nobody caught — it must not stay in flight, or
      // every later send in this session is diverted into the queue. A no-op
      // when the turn was already settled, or when the auth resend has since
      // started one of its own.
      endTurn(session, turn);
      // The turn is fully over — fire anything queued during it (#37).
      if (gen === session.gen) {
        this.settleUnavailablePlanTurn(session, client, gen);
        void this.maybeFlushQueuedSends(session);
      }
    }
  }

  /**
   * If this turn failure is a rate or quota limit, post the failover card and
   * stash the prompt so Continue / Wait can resend it. Returns true when it
   * handled the error (caller must not also show it, and must not resend).
   */
  private surfaceLimitError(
    session: Session,
    err: unknown,
    displayText: string,
    chips: ContextChip[],
  ): boolean {
    const code = typeof (err as { code?: unknown })?.code === "number" ? (err as { code: number }).code : undefined;
    const kind = classifyLimitError(session.provider, errorDetail(err), code);
    if (kind !== "rate" && kind !== "quota") return false;
    const id = randomUUID();
    const source = session.provider;
    const targets = limitOfferTargets(source, this.usableProviders(), (provider) => this.measuredFreePercent(provider));
    const recommended = recommendedLimitAction(kind, targets);
    session.pendingLimitOffer = { id, kind, source, text: displayText, chips: chips.slice() };
    this.emit(session, {
      type: "limitOffer",
      id,
      kind,
      source,
      targets,
      title: limitOfferTitle(kind, source),
      text: `${rateLimitNoticeText(err)} ${limitOfferHint(kind, targets.length > 0)}`,
      recommended,
      ...this.turnEndFields(session, "failed")
    });
    this.noteLiveTurnEnded(session);
    this.setStatus(session, "error");
    return true;
  }

  /** K-05: a context overflow gets its own card instead of a raw error. */
  private surfaceContextOverflow(session: Session, err: unknown, displayText: string, chips: ContextChip[]): boolean {
    if (!isContextOverflowError(errorDetail(err))) return false;
    const id = randomUUID();
    session.pendingOverflow = { id, text: displayText, chips: chips.slice() };
    this.host.appendLine(`[context] overflow: ${errorDetail(err)}`);
    this.emit(session, {
      type: "contextOverflow",
      id,
      text: CONTEXT_OVERFLOW_TEXT,
      canCompact: providerCapability(session.provider, "manualCompact").state !== "no",
      ...this.turnEndFields(session, "failed")
    });
    this.noteLiveTurnEnded(session);
    this.setStatus(session, "error");
    return true;
  }

  private async answerContextOverflow(
    session: Session,
    msg: { id: string; action: "compact-retry" | "fresh" | "dismiss" },
  ): Promise<void> {
    const pending = session.pendingOverflow;
    if (!pending || pending.id !== msg.id) return;
    session.pendingOverflow = undefined;
    if (msg.action === "fresh") {
      await this.continueInFreshSession(session);
      return;
    }
    if (msg.action !== "compact-retry") return;
    // One attempt: compact, then the lost message once more. A second
    // overflow shows the card again; nothing loops on its own.
    await this.handleSend("/compact", true, session);
    if (session.status === "error") return;
    session.chips = [...pending.chips, ...session.chips];
    await this.handleSend(pending.text, false, session);
  }

  /**
   * User picked an action on the limit card. Continue rebinds this session to
   * a *different* provider (same-account models are not targets) and resends
   * the failed prompt there. Wait resends to the current provider only because
   * the person asked — never automatically. Every switch is a transcript line.
   */
  private async answerLimitOffer(
    session: Session,
    msg: { id: string; action: "continue" | "retry" | "dismiss"; target?: AcpProvider },
  ): Promise<void> {
    return this.turnEdit.answerLimitOffer(session, msg);
  }

  /**
   * Recover from an expired-token turn failure without a manual sign-out. A
   * pooled `grok agent stdio` process can wedge on an expired OAuth token when
   * its 401-refresh loses a rotation race with the sibling processes / `grok
   * login` that share `~/.grok/auth.json`. A FRESH process re-reads the current
   * disk token — exactly what re-login does, minus the sign-out — so we
   * transparently restart the owning session (`startSession` respawns +
   * `session/load`s to preserve history) and RE-SEND the failed prompt once.
   * Guarded by `authRecoveryTried` (reset on any clean turn) so a genuine
   * dead-auth / entitlement error can't loop. The resend's failure is the
   * decision point (#58): only a CREDENTIAL failure (`isCredentialError` — the
   * CLI's -32000 auth_required, or unambiguous credential wording) earns the
   * sign-in overlay; billing/entitlement wording that a fresh process couldn't
   * clear is NOT fixable by login (the CLI maps 403 to a plain error precisely
   * because the credential was accepted) and shows the in-chat entitlement
   * notice instead. Returns true when it handled the error (caller must not
   * also show it).
   */
  private async recoverAuthAndResend(
    session: Session,
    err: unknown,
    displayText: string,
    chips: ContextChip[],
    promptBlocks: Parameters<AcpClient["prompt"]>[0],
  ): Promise<boolean> {
    return this.turnEdit.recoverAuthAndResend(session, err, displayText, chips, promptBlocks);
  }

  /** Give a session a readable name from its opening prompt, as `autoName` — never
   *  as `customName`. The distinction is the whole of #96: written as a rename, our
   *  guess outranked grok's own `session_summary` forever, so every unrenamed row
   *  stayed a truncated first sentence while the CLI had a real topic for it.
   *  `buildEntry` now ranks this below the CLI title, which means it shows only
   *  until grok writes one — usually the same turn.
   *
   *  Sessions named before this change keep the name they have: an auto title
   *  already written into `customName` is indistinguishable from a rename, and
   *  guessing wrong there would silently discard names people typed. */
  private maybeGenerateTitle(session: Session): void {
    if (session.titleGenerated) return;
    const sid = session.client?.sessionId ?? session.activeSessionId;
    const first = session.firstUserMessageForTitle;
    if (!sid || !first) return;
    session.titleGenerated = true;
    const cleaned = first.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    const title = cleaned.length > 50 ? cleaned.slice(0, 47) + "…" : cleaned;
    void this.updateSessionMeta((current) => {
      const entry = current[sid];
      if (entry?.customName || entry?.autoName) return null;
      return { ...current, [sid]: { ...(entry ?? {}), autoName: title } };
    }).then(() => this.postSessionName(session));
    // An override changes the row without touching summary.json's mtime, so the
    // mtime-keyed cache would keep serving the un-named entry (same reason rename
    // and pin invalidate here).
    this.sessionCache.delete(sid);
  }

  /**
   * The user has opened the host's move-view picker — from the gear, the palette
   * command, or the empty-state hint's own link. Retires that hint for good.
   *
   * The single place both routes record it, and it does two things because one
   * is not enough: persist, for future windows, and tell the LIVE webview, for
   * this one. `initialState` is not re-sent on a session swap, so a webview
   * holding a stale true would rebuild the hint the user had already acted on —
   * and if they open the picker and cancel, no rebuild happens to refresh it.
   *
   * Called BEFORE the move, never after: relocating a view makes the host tear
   * the webview down and rebuild it, and the rebuilt one asks for capabilities
   * immediately, so a write afterwards loses that race.
   *
   * Recorded for ANY destination, including one the user then cancels out of:
   * they have found the control, which is all the hint was for. It never affects
   * where the view goes — that decision takes no account of it.
   */
  async retireMoveViewHint(): Promise<void> {
    await this.state.update(MOVE_VIEW_HINT_USED_KEY, true);
    this.post({ type: "moveViewHint", value: false });
  }

  /** Global "Use this app for" from ~/.grok/client-state (absent → Knowledge work). */
  private appPurpose(): AppPurpose {
    return parseAppPurpose(this.state.get<string>(APP_PURPOSE_KEY));
  }

  private buildInitialStateMsg(session: Session = this.focused): Extract<HostMsg, { type: "initialState" }> {
    const cfg = this.host.getConfiguration("grok");
    const cwd = this.workspaceRoot();
    // Additive: older webviews ignore an unknown field; older hosts omit it
    // and command View all then leaves language unset.
    const commandLanguage = commandLanguageForDialect(resolvedTerminalShellDialect());
    return {
      type: "initialState",
      // The level this session is actually running at, not the last one chosen
      // anywhere: a remote picking up a Claude conversation must not be shown
      // grok's effort.
      effort: session.client?.currentReasoningEffort || rememberedEffort(
        cfg.get<EffortPrefs>("defaultEffortByProvider", {}),
        session.provider,
        cfg.get<string>("defaultEffort", ""),
      ),
      cwd,
      useCtrlEnter: cfg.get("useCtrlEnterToSend", false),
      extVersion: this.context.extensionVersion,
      showThinking: cfg.get("showThinking", false),
      expandCommandOutputs: cfg.get("expandCommandOutputs", false),
      steerByDefault: cfg.get("steerByDefault", false),
      promptNav: cfg.get<boolean>("promptNav", true) !== false,
      soundNotifications: cfg.get("soundNotifications", false),
      processingSound: cfg.get("processingSound", false),
      readRepliesAloud: cfg.get("readRepliesAloud", false),
      telemetryEnabled: cfg.get("telemetry.enabled", true),
      thumbsFeedback: cfg.get("thumbsFeedback", false),
      appPurpose: this.appPurpose() || DEFAULT_APP_PURPOSE,
      ...(commandLanguage ? { commandLanguage } : {}),
      // `canSwitchWorkspaceFolder` is the desktop app's defining capability and
      // is how every other host-kind decision here is made.
      hostKind: this.host.canSwitchWorkspaceFolder ? "desktop" : "extension",
      // Wire baseline + host-kind UI affordances (gear Move view / Show logs).
      capabilities: {
        ...HOST_CAPABILITIES,
        relocateView: this.host.canRelocateView,
        // Cursor refuses extension containers in the secondary side bar, so the
        // menu offers the panel by edge there rather than a destination that
        // would silently do nothing.
        secondarySideBar: this.host.canUseSecondarySideBar,
        moveViewHint: shouldShowMoveViewHint({
          hostAcceptedSecondarySideBar: this.host.canUseSecondarySideBar,
          canRelocateView: this.host.canRelocateView,
          pickerAlreadyUsed: this.state.get<boolean>(MOVE_VIEW_HINT_USED_KEY) === true
        }),
        showOutput: this.host.canShowOutput,
        // OPT-IN: unpackaged desktop only. Gear → Advanced offers the control so
        // DevTools is discoverable without the auto-hidden application menu.
        toggleDevTools: this.host.canToggleDevTools,
        // OPT-IN: absent/false hides Settings → Connectors.
        ...(this.host.canShowMcpSettings ? { mcpSettings: true } : {}),
        // Absent/true = host opens files in an editor tab; false = no editor
        // (desktop → in-app lightbox for generated images). See Host.canOpenInEditor.
        openInEditor: this.host.canOpenInEditor,
        // Only a host that owns the media handler may opt generated videos into
        // metadata preload; every other host keeps the lazy default.
        servesMediaRanges: this.host.canServeMediaRanges,
        showInFolder: this.host.canShowInFolder,
        // OPT-IN: desktop only. View all / proposed diffs open the in-app
        // overlay instead of a host editor or bare window.
        previewInApp: this.host.canPreviewInApp,
        // OPT-IN: VS Code editor tab. Desktop/remotes keep the in-page overlay.
        settingsEditor: this.host.canOpenSettingsEditor,
        // Only a host that owns its own folder set can add one. VS Code's
        // workspace is VS Code's to manage, so the extension never advertises
        // this and the rail never draws the control — capability, not a flag.
        addProjectFolder: this.canAddProjectFolder(),
        // Add project can MAKE one as well as find one. Both are opt-in field
        // presence, never a version check: a client older than this ignores the
        // flags and keeps offering only the picker.
        createProject: this.canAddProjectFolder(),
        cloneProject: this.canAddProjectFolder(),
        removeProjectFolder: this.canAddProjectFolder()
      }
    };
  }

  private postInitialState(): void {
    // `ready` means the local renderer just booted (including Electron
    // document reload, which does not re-enter resolveWebviewView). Drop the
    // cache so postVoiceConfigured below is not swallowed against the old view.
    this.forgetPostedVoiceConfigured("local");
    this.post(this.buildInitialStateMsg());
    this.postProviderState();
    void this.refreshGithubState();
    this.postMcpConnectors();
    // Where new projects go. Static per host, but the Add project form needs it
    // before the user has done anything, so it rides the initial burst rather
    // than waiting for a first attempt.
    this.postProjectSetup();
    for (const provider of this.connectedProviders()) void this.probeProviderVersion(provider);
    this.post({
      type: "summarizeRepliesAloud",
      value: this.host.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true)
    });
    // Sync the active-editor context chip into the fresh webview (the config
    // gate + no-editor case live inside refreshImplicitChip).
    this.refreshImplicitChip(true);
    this.postVoiceConfigured();
    // Usable, not connected: with only a lapsed provider there is nothing that
    // can answer, and connect-agent lets the user pick any of the three rather
    // than being funnelled into that one provider's login instructions.
    if (this.usableProviders().length === 0) {
      this.focused.priming = false;
      this.post({ type: "setBusy", value: false });
      this.post({ type: "onboarding", state: "connect-agent", platform: process.platform });
      this.postSessionsList();
      return;
    }
    // Host-declared capability (not incidental focused.client): only Electron
    // sets webviewReloadsUnderLiveSession. VS Code is false by construction, so
    // a view move / "Reload Webviews" that recreates the webview under a live
    // client still takes the v3.1.0 startSession path below.
    if (shouldRehydrateOnWebviewReady(this.host.webviewReloadsUnderLiveSession, !!this.focused.client)) {
      this.rehydrateWebviewFromFocused();
      return;
    }
    // Sweep abandoned empty sessions once the first session is live (so the
    // newly-focused session is excluded from the sweep). This is the run that
    // collects what the last window left behind when it closed without a prompt.
    // Re-post the session list after start so a live empty "New session" row and
    // any id assigned by session/new land on the selected project's rail (ready
    // already pushed the disk list before the agent was up).
    // The pristine session has no cwd, and `startSession`'s fallback is the
    // WORKSPACE ROOT — so a project chosen in the rail before the chat view was
    // ever revealed was ignored by the very first conversation. The rail and
    // history said B while the agent ran in A, and the first prompt could read
    // or write A. Every other entry point sets this (newFocusedSession, resume,
    // the delete replacement); the one that starts by itself did not.
    if (!this.focused.cwd) {
      this.setSessionCwd(this.focused, this.historyCwdFor(), this.workspaceRoot());
    }
    if (!this.focused.hasHistory && !this.focused.client) {
      this.focused.provider = this.defaultProviderForProject(this.sessionCwd(this.focused));
    }
    void this.startSession(undefined, this.focused, "ensure").then(() => {
      this.postSessionsList();
      this.sweepEmptySessions();
    });
  }

  /**
   * Replay the focused session into a freshly-booted webview without restarting
   * the ACP process. Used when the document reloads (Electron) but the sidebar
   * controller still holds a live pool member.
   */
  private rehydrateWebviewFromFocused(): void {
    const session = this.focused;
    const wv = this.view?.webview;
    if (!wv) return;
    this.touch(session);
    this.markRead(session);
    this.refreshWorkflowCompletions(session);
    void wv.postMessage({ type: "clearMessages" });
    void wv.postMessage({ type: "historyReplay", active: true });
    for (const m of session.buffer) {
      void wv.postMessage(this.localizeHistoryMessage(m, wv));
    }
    void wv.postMessage({ type: "historyReplay", active: false });
    for (const m of sessionUiSnapshot(
      session,
      this.displayMode(session),
      this.localPreviewChips(session, wv),
    )) {
      void wv.postMessage(m);
    }
    if (session.sessionType === "crew") this.postWorkflowList(session);
    // Restore turn chrome the buffer does not carry (busy is event-sourced live).
    // During priming the client exists but has no session id yet — keep the
    // startup lock so a reload cannot unlock the composer into a lost prompt.
    const chrome = rehydrateBusyChrome(session);
    void wv.postMessage({ type: "setBusy", value: chrome.value, locked: chrome.locked });
    this.postMode();
    this.postRepoCatalog();
    this.postSessionsList();
    this.postSessionName(session);
  }

  private async readImageChip(
    chip: FileChip,
    session: Session,
    gen: number,
  ): Promise<PromptImageInput | "failed" | "gone"> {
    try {
      const bytes = await fs.promises.readFile(chip.path);
      if (bytes.length === 0) throw new Error("file is empty");
      return {
        index: chip.imageIndex!,
        mimeType: chip.mimeType ?? "image/png",
        data: bytes.toString("base64"),
        path: chip.path,
        relPath: chip.originRelPath
      };
    } catch (e) {
      if (gen !== session.gen) return "gone";
      this.emit(session, {
        type: "agentError",
        text: `Could not read ${chip.relPath} (${(e as Error).message}). Remove the attachment and try again.`
      });
      return "failed";
    }
  }

  private postChips(session: Session = this.focused): void {
    if (session === this.focused && this.view) {
      const webview = this.view.webview;
      const localMessage: HostMsg = { type: "chips", chips: this.localPreviewChips(session, webview) };
      void webview.postMessage(localMessage);
    }
  }

  private localPreviewChips(session: Session, webview: HostWebview): ContextChip[] {
    return session.chips.map((chip) => isFileChip(chip) && isImageChip(chip)
      // Staging paths are genuine local disk (Uri.file roots).
      ? { ...chip, previewSrc: webview.asWebviewUri(Uri.file(chip.path)), fullId: this.registerFullImage(chip.path) }
      : chip);
  }

  private localizeHistoryMessage(message: HostMsg, webview: HostWebview): HostMsg {
    if (message.type === "userMessage" && message.chips) {
      return { ...message, chips: message.chips.map((chip) => isFileChip(chip) && isImageChip(chip)
        ? { ...chip, ...(fs.existsSync(chip.path)
          ? { previewSrc: webview.asWebviewUri(Uri.file(chip.path)), fullId: this.registerFullImage(chip.path) }
          : {}) }
        : chip) };
    }
    if (message.type === "queuedSends" && message.queued) {
      return {
        ...message,
        queued: message.queued.map((item) => ({
          ...item,
          ...(item.chips ? { chips: item.chips.map((chip) => isFileChip(chip) && isImageChip(chip)
            ? { ...chip, ...(fs.existsSync(chip.path)
              ? { previewSrc: webview.asWebviewUri(Uri.file(chip.path)), fullId: this.registerFullImage(chip.path) }
              : {}) }
            : chip) } : {})
        }))
      };
    }
    if (message.type === "userMessageChunk" && message.images) {
      return {
        ...message,
        images: message.images.map((image) => image.path && fs.existsSync(image.path)
          ? { ...image, previewSrc: webview.asWebviewUri(Uri.file(image.path)), fullId: this.registerFullImage(image.path) }
          : image)
      };
    }
    return message;
  }

  // grok's output for hidden summary/context-injection turns, dropped from both
  // the session buffer and live view. User input/lifecycle messages are excluded.
  private static readonly SUPPRESS_TYPES = new Set([
    "messageChunk", "userMessageChunk", "thoughtChunk", "toolCall", "toolCallUpdate",
    "promptComplete", "xaiNotification", "subagentUpdate", "runProgress", "commandOutput", "agentEnd",
  ]);
  /** Messages that DO something once rather than describe the conversation.
   *  The session buffer exists so a focus switch can rebuild the chat, and it is
   *  replayed in full every time — so anything action-shaped must stay out of it
   *  or it fires again on every switch back. `restoreComposer` is the one that
   *  bit: an Edit puts the message text back in the composer, the client appends
   *  it (deliberately, so an Edit cannot destroy what you are mid-way through
   *  typing), and a buffered copy therefore added the same draft again on every
   *  return to that conversation. The other two would re-steal focus and re-open
   *  the mode picker on reconnect. */
  private static readonly TRANSIENT_TYPES = new Set([
    "restoreComposer", "focusInput", "findInSession", "openModePopover",
    // Replaying a DESTRUCTIVE modal after a reconnect is the bug, not the fix.
    "uiConfirmRequest", "uiConfirmResolved",
    "subscriptionUsage",
    // Replayed mid-buffer it would stamp the then-current footer, not the live
    // one. `sessionUiSnapshot` restores eligibility after historyReplay ends.
    "turnFeedbackAck",
    "providerCapabilities",
    // Whole-list replacement on every agent update. Buffered, a ten-step plan
    // would replay ten stale checklists on every focus switch; `sessionUiSnapshot`
    // re-sends the current one instead.
    "planEntries",
    // Same replacing-state as the checklist: N diffs would replay N stale
    // panels on every focus switch. sessionUiSnapshot re-sends the current one.
    "reviewCenter",
    // Same replacing-state as the review panel: N step updates would replay
    // N stale crews on every focus switch. sessionUiSnapshot re-sends it.
    "crewRun",
    "workflowRun",
    "workflowList",
    "workflowGenerator",
    // K-04: an offer about the context right now; stale after a compaction.
    "nearFullPrompt",
    // X-02: a child's live feed. The child's own transcript is the record.
    "childActivity",
    // X-03: which parent a focused hidden child belongs to; re-sent on focus.
    "childContext",
    // E-01: a window-wide overview, re-sent whenever it changes.
    "runningChildren",
    "scrollToWaiting",
  ]);
  /**
   * Host→rail catalog surface. Everything else stays chat-only so a user who
   * never opens the rail sees exactly today's behaviour.
   */
  private static readonly PROJECTS_RAIL_HOST_TYPES = new Set<HostMsg["type"]>([
    "repos",
    "sessions",
    "sessionRemoved",
    "repoSessions",
    "pinnedSessions",
    "sessionDot",
    "session",
    "sessionName",
    "providerState",
    // The Add project form lives in this view too, and it needs both: where
    // folders go, and which mode decides whether cloning is on the menu.
    "projectSetup",
    "githubState",
    "githubRepos",
    "appPurpose",
  ]);
  /** Webview→host actions the rail may post. Closed set — never send/cancel/etc. */
  private static readonly PROJECTS_RAIL_WEBVIEW_TYPES = new Set<WebviewMsg["type"]>([
    "createProject",
    "cloneProject",
    "setupGithubCli",
    "listGithubRepos",
    // The rail renders the same clone form as the chat, so it can reach the
    // token paste too.
    "githubLoginWithToken",
    "listSessions",
    "listRepoSessions",
    "selectRepo",
    "resumeSession",
    "newSession",
    "toggleSessionPin",
    "renameSession",
    "deleteSession",
    "clearAllSessions",
    "setRepoArchived",
    "setRepoColor",
    // Host-local by construction: it opens a native folder dialog. Reachable
    // from the rail because that is where the project list lives; a remote
    // cannot send it (remote-policy classifies it `host-local`).
    "addProjectFolder",
    // The way back out. Same host-local classification — on VS Code it forgets
    // a hand-added folder, which is the only revocation that surface has.
    "removeProjectFolder",
  ]);
  private post(message: HostMsg): void {
    if (this.focused.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    this.view?.webview.postMessage(message);
    this.mirrorToProjectsRail(message);
  }

  /** Chat + the settings tab (when open) both consume About update status. */
  private postGrokUpdateStatus(message: Extract<HostMsg, { type: "grokUpdateStatus" }>): void {
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
  }

  /** Post to the VS Code webview only (plus catalog mirror to the projects rail). */
  private postLocal(message: HostMsg): void {
    this.postTap?.(message);
    this.view?.webview.postMessage(message);
    this.mirrorToProjectsRail(message);
  }

  /**
   * Second local destination for catalog-shaped frames. A view that has never
   * resolved is simply skipped — no parallel data path, no throw.
   */
  private mirrorToProjectsRail(message: HostMsg): void {
    if (!this.projectsRail) return;
    if (!GrokSidebar.PROJECTS_RAIL_HOST_TYPES.has(message.type)) return;
    void this.projectsRail.webview.postMessage(message);
  }

  /** Test-only tap on local posts. Never assigned in a released build:
   *  `extension.ts` hands out `installTestHooks` only under
   *  `ExtensionMode.Test`, which VS Code sets exclusively for a test runner. */
  private postTap?: (message: HostMsg) => void;

  /**
   * Test-only seam for the integration suite: drives the real host against a
   * real Extension Host, where a unit test would have to fake the webview.
   */
  installTestHooks(): SidebarTestHooks {
    return createSidebarTestHooks(this);
  }

  /**
   * Session-scoped post. Records the message in that session's view buffer (so a
   * focus switch can rebuild its chat losslessly — clearMessages + replay) and,
   * when the session is the focused one, forwards it to the webview. Per-session
   * suppress flags drop hidden summary/context content from BOTH buffer and live
   * view (so they never reappear on replay). `clearMessages` resets the buffer —
   * the replay path issues its own clear before replaying, and a (re)started
   * session begins empty. Background sessions buffer silently; nothing reaches
   * the webview until they're focused. (Pool-of-1 today: session is always the
   * focused one, so this is behaviorally identical to `post`.)
   */
  private workflowTimer?: ReturnType<typeof setInterval>;

  /**
   * A Grok workflow's "finished" notification can be missed (the webview was
   * away, the notification never came). The CLI writes the run's state file
   * anyway, so read it and repair the card (upstream workflow-state.ts).
   */
  private startWorkflowCompletionPolling(): void {
    this.workflowTimer = setInterval(() => {
      for (const session of new Set([this.focused, ...this.pool])) this.refreshWorkflowCompletions(session);
    }, 2000);
    (this.workflowTimer as unknown as { unref?: () => void }).unref?.();
  }

  private workflowCompletion(session: Session, update: RunProgressUpdate) {
    if (session.provider !== "grok" || update.kind !== "workflow" || update.done) return;
    const sid = session.activeSessionId || session.client?.sessionId;
    if (!sid) return;
    const dir = sessionDirFor(resolveGrokHome(process.env), this.sessionCwd(session), sid, { fs: defaultFs });
    return readWorkflowCompletion(dir, update);
  }

  private refreshWorkflowCompletions(session: Session): void {
    if (session?.provider !== "grok" || !session.buffer) return;
    const runs = new Map<string, Extract<HostMsg, { type: "runProgress" }>[]>();
    for (const message of session.buffer) {
      if (message.type !== "runProgress" || message.update.kind !== "workflow") continue;
      const frames = runs.get(message.update.id);
      if (frames) frames.push(message);
      else runs.set(message.update.id, [message]);
    }
    for (const frames of runs.values()) {
      const completed = this.workflowCompletion(session, frames[frames.length - 1].update);
      if (!completed) continue;
      // Repair every replay position from the newest observation.
      for (const message of frames) message.update = structuredClone(completed);
      if (session.suppressContent) continue;
      if (session === this.focused) this.postLocal({ type: "runProgress", update: completed, replaceOnly: true });
    }
  }

  private emit(session: Session, message: HostMsg): void {
    if (!session.replaying) {
      this.relayFromChild(session, message);
      this.tapChildActivity(session, message);
    }
    if (message.type === "runProgress") {
      const completed = this.workflowCompletion(session, message.update);
      if (completed) message = { type: "runProgress", update: completed };
    }
    // A baseline capture still running when tools start may already contain
    // their writes; a wrong "before" is worse than none (upstream 2a8ffb0).
    if (message.type === "toolCall" || message.type === "toolCallUpdate" || message.type === "permissionRequest") {
      const pendingBaseline = this.turnGitBaselines?.get(session);
      if (pendingBaseline?.pending) {
        pendingBaseline.pending = false;
        pendingBaseline.baseline = undefined;
        pendingBaseline.turn = {};
      }
    }
    if (session.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (message.type === "clearMessages") session.buffer = [];
    else if (!GrokSidebar.TRANSIENT_TYPES.has(message.type)) session.buffer.push(message);
    if (message.type === "userMessage" && !message.steer) {
      session.liveFeedbackEligible = false;
      session.turnRating = 0;
    }
    if (message.type === "contextUsage" && !session.replaying) {
      if (typeof message.window === "number" && message.window > 0) session.lastContextWindow = message.window;
      if (typeof message.used === "number") {
        this.maybeOfferNearFull(session, message.used, session.lastContextWindow, message.autoCompactThresholdPercent);
      }
    }
    if (session === this.focused) {
      this.postTap?.(message);
      const webview = this.view?.webview;
      if (webview) webview.postMessage(this.localizeHistoryMessage(message, webview));
      // Active-session identity for the projects rail (highlight + pin home).
      this.mirrorToProjectsRail(message);
    }
  }

  /** Desk-targeted, non-replayable delivery for one-shot notices. */
  private emitLocalTransient(session: Session, message: HostMsg): void {
    if (session.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (session !== this.focused) return;
    this.postTap?.(message);
    const webview = this.view?.webview;
    if (webview) webview.postMessage(this.localizeHistoryMessage(message, webview));
    this.mirrorToProjectsRail(message);
  }

  private async replayLoadedHistory(session: Session, load: () => Promise<void>): Promise<void> {
    // Join an in-flight load rather than superseding it: session/load cannot
    // be aborted, and a second stream would interleave into the same buffer.
    await runExclusiveHistoryLoad(session, async () => {
      await load();
      // A saved id may still be an untouched shell: an old but empty
      // conversation must be allowed to switch provider. Only a successful
      // replay can prove that; a failed load keeps the lock (upstream ce12449).
      session.hasHistory = session.historyEventCount > 0 || session.userMessageCount > 0;
      this.refreshWorkflowCompletions(session);
    }, {
      onStart: () => this.emit(session, { type: "historyReplay", active: true }),
      onFinish: () => {
        this.emit(session, { type: "historyReplay", active: false });
      }
    });
  }

  // ---------- session pool ----------

  /** An unused empty conversation is one nobody is looking at, with no real
   *  work in it. Minting another while one of these exists is how a project
   *  ends up with two identical "New session" rows. */
  private sessionIsReusableEmpty(session: Session): boolean {
    return !!session.activeSessionId
      && !session.hasHistory
      && !session.worktree
      && session.chips.length === 0
      && !session.priming
      && !session.strandedDraft
      && session.queuedSends.length === 0
      && !session.needsProvider;
  }

  private findUnusedEmptySession(
    cwd: string,
    excludeId?: string,
  ): { session?: Session; id: string; cwd: string } | undefined {
    if (!cwd) return undefined;
    for (const session of this.pool) {
      const id = session.activeSessionId;
      if (!id || id === excludeId) continue;
      if (!pathsEqual(this.sessionCwd(session), cwd)) continue;
      if (!this.sessionIsReusableEmpty(session)) continue;
      if (this.sessionHasLiveOwner(session)) continue;
      return { session, id, cwd: this.sessionCwd(session) };
    }
    // ONLY sessions this host is holding, never a row from the list.
    //
    // The cold-row branch that used to live here read `numMessages === 0` as
    // “nobody has used this”. For Codex and Claude that field is HARDCODED to
    // zero for every row (`provider-ui.ts`, adapterListEntry), so every
    // conversation they own looked unused — and New Session would silently
    // adopt one with somebody's work in it, sending their next message into a
    // conversation they thought was new. An independent round caught it before
    // release; a stale Grok shell that cannot be resumed was the same premise
    // failing a second way.
    //
    // A live session in the pool is different in kind: emptiness is the host's
    // own state, not an inference from a list field that means nothing here.
    // So the reuse is narrower than first written, and only says what it knows.
    return undefined;
  }

  /**
   * Is the local view sitting on the conversation that was just deleted?
   *
   * By ID, and only by id. `disposeSession` does not clear `activeSessionId`,
   * so a view still attached to the dead conversation still carries its id —
   * which covers both the ordinary case and a view that moved onto it while
   * the delete was in flight.
   *
   * Object identity was tried and removed. A `Session` is a container that
   * gets RECYCLED: after the delete disposes it, a reasoning-effort change
   * calls `startSession(undefined, session)` and the same object comes back
   * holding a brand-new conversation. Identity then said “still on the deleted
   * one” and moved the person off a conversation they had just started
   * writing in. The id cannot make that mistake: it is the conversation, not
   * the box it arrived in.
   *
   * Asked at the moment of the decision. A snapshot taken before the provider
   * teardown answers a question about a view that has since moved.
   */
  private viewIsOnDeleted(id: string): boolean {
    return !!id && this.focused.activeSessionId === id;
  }
  private newLocalSession(): Session {
    const session = new Session();
    // A brand-new session is the only moment the setting applies; everything
    // after this is the user's own choice or a lock.
    session.sessionType = this.configuredDefaultSessionType();
    return session;
  }

  private reserveSessionLoad(
    id: string,
  ): { reservation: SessionLoadReservation; joined: boolean } | undefined {
    const existing = this.sessionLoadReservations.get(id);
    if (existing && existing.expiresAt > Date.now()) return undefined;
    if (existing) {
      clearTimeout(existing.timer);
      this.sessionLoadReservations.delete(id);
    }
    const token = Symbol(id);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void completion.catch(() => undefined);
    const timer = setTimeout(() => {
      const current = this.sessionLoadReservations.get(id);
      if (current?.token === token) this.sessionLoadReservations.delete(id);
    }, GrokSidebar.SESSION_LOAD_RESERVATION_TTL_MS);
    timer.unref?.();
    const reservation: SessionLoadReservation = {
      token,
      completion,
      resolve,
      reject,
      expiresAt: Date.now() + GrokSidebar.SESSION_LOAD_RESERVATION_TTL_MS,
      timer
    };
    this.sessionLoadReservations.set(id, reservation);
    return { reservation, joined: false };
  }

  private releaseSessionLoad(
    id: string,
    reservation: SessionLoadReservation,
    error?: unknown,
  ): void {
    if (error === undefined) reservation.resolve();
    else reservation.reject(error);
    const current = this.sessionLoadReservations.get(id);
    if (current?.token !== reservation.token) return;
    clearTimeout(current.timer);
    this.sessionLoadReservations.delete(id);
  }

  private isSessionLoadReserved(id: string): boolean {
    const current = this.sessionLoadReservations.get(id);
    if (!current) return false;
    if (current.expiresAt > Date.now()) return true;
    clearTimeout(current.timer);
    this.sessionLoadReservations.delete(id);
    return false;
  }

  private reservedSessionIds(): string[] {
    return [...this.sessionLoadReservations.keys()].filter((id) => this.isSessionLoadReserved(id));
  }

  private focusSession(session: Session): void {
    if (session === this.focused) return;
    this.focused = session;
    this.touch(session);
    this.markRead(session); // opening it clears any unread (green/red) badge
    this.refreshWorkflowCompletions(session);
    const wv = this.view?.webview;
    // Both surfaces need it, and the desk has the same gap the browser does —
    // re-focusing a live conversation never said which agent it belongs to.
    const identity = this.sessionIdentityFrame(session);
    if (wv) {
      wv.postMessage({ type: "clearMessages" });
      if (identity) wv.postMessage(identity);
      wv.postMessage({ type: "historyReplay", active: true });
      for (const m of session.buffer) wv.postMessage(this.localizeHistoryMessage(m, wv));
      wv.postMessage({ type: "historyReplay", active: false });
      for (const m of sessionUiSnapshot(
        session,
        this.displayMode(session),
        this.localPreviewChips(session, wv),
      )) wv.postMessage(m);
    }
    this.postMode();
    this.postRepoCatalog();
    // The IDENTITY frame, sent directly rather than as a side effect.
    //
    // Both clients hold their rail transition open until they learn which
    // conversation is now active — from `sessionName`, or from a sessions list's
    // `activeId` (chat.js `noteRailTransitionSessionName`, projects-rail.js
    // `case "sessionName"`). That frame used to ride inside postSessionsList,
    // which is a whole catalog walk to deliver one id, and dropping the walk
    // dropped the id with it: switching to an already-live conversation hung the
    // transition for its full timeout and then snapped the highlight back to the
    // previous one while the host was focused on the new one. Caught in review,
    // after a commit message asserted this path already sent it.
    //
    // Sending it here is the point of the change rather than an exception to it:
    // the small frame the client actually needs, instead of rebuilding a list
    // that has not changed.
    this.postSessionName(session);
    this.postChildContext(session);
    // Same as the remote path, and for the same reason: restorePersistedDraft
    // broadcasts, so it is not called here.
  }

  /**
   * Leave the focused session running in the pool so it can be re-focused later
   * — unless it's an untouched, idle session, which isn't worth a live process,
   * so we tear it down. Called before switching focus to a new/other session.
   */
  private parkFocused(): void {
    const cur = this.focused;
    // A DELETED conversation is not parked, whatever state it is holding.
    //
    // Re-homing after a delete opens the neighbour, and a COLD neighbour
    // reaches here while `this.focused` is still the just-disposed object. If
    // the person had typed a follow-up while the agent worked, the arm below
    // put it BACK in the pool — and the list builder synthesizes a row for any
    // pool member with no directory on disk, so the conversation they deleted
    // reappeared. Reaping will not take it either, because a queued send
    // counts as a draft. Deleting it a second time works, which is exactly the
    // “it came back” complaint this change set out to fix, by a new route.
    if (cur.deleted) return;
    const busy = cur.status === "working" || cur.status === "needs-you";
    if (cur.needsProvider || cur.strandedDraft || cur.queuedSends.length > 0) {
      this.pool.add(cur);
      return;
    }
    // A worktree session backs a real git checkout the user explicitly created —
    // never auto-delete it as an empty session, even before the first
    // message (that's what made creating/leaving a worktree replace the current
    // one). It's removed only via Remove worktree.
    if (cur.hasHistory || busy || cur.chips.length > 0 || cur.worktree) return; // real/active work — keep it parked & alive
    // Still starting: `hasHistory` is the flag that says "this conversation is
    // real, do not delete it", and on a RESUME it is set at the very end of
    // startSession — after the client has already reported the session id and
    // after the default-model await. In that window a resumed conversation looks
    // exactly like an untouched new one, and the two lines below would delete the
    // stored conversation off disk. Reachable by clicking a second rail row while
    // the first is still opening, which the rail does not prevent because loads
    // are reserved per session id, not globally.
    if (cur.priming) return;
    // Empty session being left behind (New Session, or switching to
    // another): tear down its process AND delete its on-disk dir so it doesn't pile
    // up in history (#24). The next focused session becomes the single live "New
    // session"; abandoning this one removes it entirely.
    this.teardownEmptySession(cur);
  }

  /**
   * Tear a session's process down AND delete its conversation directory.
   *
   * Extracted from {@link parkFocused} so an abandoned `/agent` role session
   * goes through exactly the same path (AP-10): a role cancelled before its
   * first prompt has produced nothing, and every one of those left behind
   * would be another unaccountable "New session" in the rail — the #24 problem
   * arriving by a second route. The CALLER decides a session is empty; this
   * only removes it.
   */
  private teardownEmptySession(session: Session): void {
    const id = session.activeSessionId;
    const cwd = this.sessionCwd(session);
    const provider = session.provider;
    // Retain the pipe for session/delete. disposeSession still owns all pool
    // and remote bookkeeping; its second detach finds no client to terminate.
    const client = isAdapterProvider(provider) ? this.detachClient(session) : undefined;
    void this.disposeSession(session);
    if (isAdapterProvider(provider)) {
      void this.discardAdapterEmptySession(provider, id, cwd, client).finally(() => client?.dispose()).then((removed) => {
        if (removed) this.postSessionRemoved(id, cwd);
      }).catch((error) => {
        this.host.appendLine(`[${provider}] empty-session cleanup failed: ${(error as Error).message}`);
      });
    } else if (this.removeSessionFromDisk(id, cwd)) this.postSessionRemoved(id, cwd);
  }

  /** Delete a session's on-disk dir + drop its meta override and read-cache entry.
   *  Used when an empty session is abandoned or a legacy primer-only session is swept. Best-effort —
   *  a locked/already-gone dir is logged, not thrown. */
  private removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean {
    if (!id) return false;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cwd =
      sessionCwd ||
      overrides[id]?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      this.workspaceRoot();
    const grokHome = resolveGrokHome(process.env);
    let removed = false;
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
      removed = true;
    } catch (e) {
      this.host.appendLine(`[sessions] could not remove empty session ${id}: ${(e as Error).message}`);
    }
    if (overrides[id]) {
      void this.removeUploadsForSessions([id], overrides);
      const next = { ...overrides };
      delete next[id];
      void this.state.update(SESSION_META_KEY, next);
    }
    this.sessionCache.delete(id);
    return removed;
  }

  /** Every session id in a repo that has been PROVEN to hold real work, for this
   *  activation. The sweep runs on every new/opened session, and without this each
   *  run would re-read every `summary.json` under the repo; with it, a repeat run
   *  reads only directories it has never classified. Safe to keep forever: a
   *  session that has a real user turn never becomes empty again. Keyed by
   *  {@link normalizeRepoPath}. */
  private readonly provenNonEmpty = new Map<string, Set<string>>();

  /** Delete every empty session directory in `cwd` — one that grok registered but
   *  no conversation ever reached. `parkFocused` handles the session you walk away
   *  from inside a running window; this handles the ones nothing was there to park:
   *  a window closed without a prompt, a crashed host, a remote tab that vanished.
   *  With the primer retired (v2.2.0) nothing removed those at all and they
   *  collected as unloadable "Untitled" rows — a session directory holding only
   *  `summary.json` is not loadable by the CLI (#97).
   *
   *  Runs on activation and after every new/opened session, so at most one empty
   *  session — the live one you are looking at — survives in the repo you are
   *  working in. Scans the newest slice by mtime so it stays bounded on a large
   *  store, plus every summary-only (`hasTranscript === false`) entry even when
   *  it has aged out of that slice, and reads content only for directories it
   *  has not already cleared. Never touches a live session, one being loaded
   *  right now, one younger than {@link SWEEP_MIN_AGE_MS}, a renamed or pinned
   *  one, a worktree session, or a subagent's transcript. Best-effort
   *  throughout: a locked directory is logged and skipped. */
  private sweepEmptySessions(
    cwd: string = this.workspaceRoot(),
    opts: { force?: boolean } = {},
  ): void {
    if (!cwd) return;
    const repoKey = normalizeRepoPath(cwd);
    // THROTTLED, because the per-open frequency was buying nothing.
    //
    // Every call walks the whole catalog to sort it by mtime — `readdirSync`
    // plus up to three `statSync` per session directory — and then reads
    // `summary.json` and `chat_history.jsonl` for each surviving candidate. At
    // 3000 conversations that measured 200-380ms of walking plus the reads, on
    // the Electron MAIN thread, which is the thread that paints the window.
    // Callers put it on the open path, so it ran on every click (#133/#131).
    //
    // And it could not have found anything: SWEEP_MIN_AGE_MS is THIRTY MINUTES,
    // so a session that was not sweepable half an hour ago is not sweepable now.
    // Running it dozens of times an hour deletes exactly what running it once
    // would have.
    //
    // This is not the "tidy up the conversation I just abandoned" path — that is
    // `discardRestartedEmptySession` / `removeSessionFromDisk`, which delete one
    // known id immediately and are untouched here. This is the periodic sweep of
    // shells left by earlier runs, and periodic is what it now is.
    //
    // `force` is for a caller that NAMES the sweep, which means now. The
    // throttle is about the incidental callers on the open path; applying it to
    // a deliberate request makes an explicit call silently do nothing, which is
    // the shape of a bug nobody can find later. The integration gate caught
    // exactly that: it calls the sweep to assert what it deletes, an earlier
    // incidental sweep had already stamped the repo, and it deleted nothing.
    const startedAt = Date.now();
    const lastSweep = this.lastSweepAt.get(repoKey) ?? 0;
    if (!opts.force && startedAt - lastSweep < GrokSidebar.SWEEP_INTERVAL_MS) return;
    this.lastSweepAt.set(repoKey, startedAt);
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.host.appendLine(m);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // A session with a live process re-persists itself the moment it is touched,
    // so deleting one is at best pointless and at worst races the CLI. The same
    // goes for a load already in flight: its directory is about to be handed to a
    // process that has not started yet, and it has no pool entry to protect it.
    const liveIds = new Set<string>();
    for (const s of this.pool) if (s.activeSessionId) liveIds.add(s.activeSessionId);
    if (this.focused.activeSessionId) liveIds.add(this.focused.activeSessionId);
    for (const id of this.sessionLoadReservations.keys()) liveIds.add(id);

    let proven = this.provenNonEmpty.get(repoKey);
    if (!proven) {
      proven = new Set<string>();
      this.provenNonEmpty.set(repoKey, proven);
    }
    const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
    const removed: string[] = [];
    const now = Date.now();
    // Newest-N as before, PLUS every summary-only shell even when it has aged
    // out of that window. The 300 cap is what let 312 transcript-less
    // directories accumulate on a large store: they fall off the slice and
    // are never looked at again. A dir with no events.jsonl is cheap to
    // judge and is the shape a credential probe leaves behind.
    const considered = new Set<string>();
    const candidates: typeof index = [];
    for (const entry of index.slice(0, GrokSidebar.SWEEP_SCAN_LIMIT)) {
      considered.add(entry.id);
      candidates.push(entry);
    }
    // DELIBERATELY not extended past that slice. Walking every
    // `hasTranscript === false` entry would reach the shells that already fell
    // off the scan — but `hasTranscript` is a snapshot, and another window can
    // begin a session's first prompt after it was taken. The age gate does not
    // help there: an OLD session that stayed open still looks stale, so an
    // in-progress first write could be deleted, unrecoverably, from a second
    // window. Historical shells are inert; a deleted conversation is not.
    // Stopping their creation (see the probe's scratch cwd) is the fix that
    // does not risk data to collect a tidier directory listing.
    for (const { id, mtimeMs } of candidates) {
      if (liveIds.has(id) || proven.has(id)) continue;
      // The index is already sorted newest-first, so this could break — but a
      // clock skew or a touched file would then silently end the scan early.
      if (now - mtimeMs < GrokSidebar.SWEEP_MIN_AGE_MS) continue;
      // Alias-aware: session may live under a differently-cased catalog leaf.
      const sessDir = sessionDirFor(grokHome, cwd, id, { fs: defaultFs });
      if (!sessDir) continue;
      let raw: any;
      try {
        raw = JSON.parse(defaultFs.readFileSync(path.join(sessDir, "summary.json"), "utf8"));
      } catch {
        continue;
      }
      // Read the chat history and let the content check decide — do NOT skip on a
      // high num_messages. A primer-only session whose agentic primer turn ballooned
      // past the gate (e.g. 74 messages, zero real queries) would otherwise survive
      // forever. A history file that is present but unreadable is not evidence of
      // anything, so it is reported as such rather than as "no history".
      let chatHistory: string | undefined;
      let historyUnreadable = false;
      const historyPath = path.join(sessDir, "chat_history.jsonl");
      try {
        chatHistory = defaultFs.readFileSync(historyPath, "utf8");
      } catch {
        historyUnreadable = defaultFs.existsSync(historyPath);
      }
      const override = overrides[id];
      const empty = isEmptySession({
        customName: override?.customName,
        pinnedAt: override?.pinnedAt,
        worktreePath: override?.worktreePath,
        queuedDraft: override?.queuedDraft,
        kind: typeof raw?.session_kind === "string" ? raw.session_kind : undefined,
        // AP-16 §6.6 point 3. A child mid-run has no user turns yet and would
        // otherwise look exactly like an abandoned "New session".
        hiddenReason: override?.hiddenReason,
        numMessages: typeof raw?.num_messages === "number" ? raw.num_messages : 0,
        summary: typeof raw?.session_summary === "string" ? raw.session_summary : "",
        generatedTitle: typeof raw?.generated_title === "string" ? raw.generated_title : "",
        chatHistory,
        historyUnreadable
      });
      if (!empty) {
        // Cache only a verdict reached from evidence. A locked file makes this
        // "not empty" too, and caching THAT would retire the session from every
        // later sweep this activation — the lock clears, the orphan stays forever.
        if (!historyUnreadable) proven.add(id);
        continue;
      }
      try {
        deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
        removed.push(id);
      } catch (e) {
        log(`[sessions] could not sweep ${id}: ${(e as Error).message}`);
      }
    }
    if (removed.length) {
      const next = { ...overrides };
      void this.removeUploadsForSessions(removed, overrides);
      for (const id of removed) {
        delete next[id];
        this.sessionCache.delete(id);
      }
      void this.state.update(SESSION_META_KEY, next);
      log(`[sessions] swept ${removed.length} empty session(s) from history`);
      this.postSessionsList();
    }
  }

  /** Detach a session from its live client: bump the generation so every handler
   *  and await bound to that client bails, drop the reference, and END ITS TURN.
   *
   *  The turn is the part that is easy to forget and expensive to miss. A client
   *  that goes away without settling its `prompt()` leaves the turn in flight
   *  with nothing left to end it, and the send path tests that BEFORE it
   *  respawns — so the next send is diverted into a queue that can never flush,
   *  and the session is dead to its user until the window is reloaded. Four
   *  teardown paths made that same mistake independently, which is why this is
   *  one function rather than four careful call sites.
   *
   *  Returns the detached client so the caller can dispose it as it needs —
   *  fire-and-forget, or awaited. */
  private detachClient(session: Session): AcpClient | undefined {
    const client = session.client;
    session.gen++;
    this.drainPendingConfirms(session);
    session.client = undefined;
    session.turnToken = undefined;
    // ITS COMMANDS GO WITH IT.
    //
    // A terminal is a child of the extension, not of the agent, so it outlives
    // the client that asked for it — and once the client is gone nothing can
    // ever send it `terminal/release`. That leaves a command running that
    // nobody owns, and since a running command is what keeps a cloud machine
    // awake, it holds one running and billing until the extension itself exits.
    //
    // Done HERE rather than in disposeSession because every teardown path goes
    // through this one function: worktree removal, a crashed ACP process, pool
    // disposal, and the session being deleted outright.
    if (client) {
      try {
        const n = this.terminalManager.releaseOwnedBy(client);
        if (n > 0) this.host.appendLine(`[terminal] released ${n} command(s) with their session`);
      } catch { /* teardown is not worth failing over */ }
    }
    return client;
  }

  /** Tear down one session's live process and drop it from the pool. Bumps its
   *  generation so any in-flight handlers/awaits bound to the old client bail.
   *  Recomputes the dot after removal — a reaped session that's still unread stays
   *  green; an idle/read one goes gray. */
  private disposeSession(session: Session): Promise<void> {
    const id = session.activeSessionId;
    // Returned, not dropped. `dispose()` resolves when the process is actually
    // gone — on Windows that is a `taskkill` still running — and a caller about
    // to DELETE the session's directory must wait for it. Callers that only
    // want the pool entry gone can keep ignoring this, exactly as before.
    const exited = this.detachClient(session)?.dispose();
    this.pool.delete(session);
    if (id) this.post({ type: "sessionDot", id, dot: this.dotForId(id) });
    return exited ?? Promise.resolve();
  }

  /** Stamp a session's recency for LRU/TTL reaping (created / focused / made busy). */
  private touch(session: Session): void {
    session.lastActiveAt = Date.now();
  }

  /**
   * Enforce the pool bounds (idle TTL + LRU cap). Silently tears down whatever the
   * pure policy selects — never the focused session, never a working/needs-you one.
   * Called eagerly after each new start (cap) and on the periodic timer (TTL).
   */
  private reapPool(): void {
    const candidates = buildReapCandidates(this.pool, this.focused);
    const doomed = selectReapable(candidates, {
      maxLive: GrokSidebar.MAX_LIVE_SESSIONS,
      idleTtlMs: GrokSidebar.IDLE_TTL_MS,
      now: Date.now()
    });
    for (const c of doomed) void this.disposeSession(c.session);
  }

  /**
   * Update a session's dashboard status and push just that dot to the webview
   * (cheap — no disk read, unlike postSessionsList). The history dropdown colors
   * each live session's row by this; a cold session (not in the pool) shows no
   * dot. Only emits when the value actually changes and the session has a grok id
   * to key the dot on.
   */
  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status === status) return;
    session.status = status;
    // Activity refreshes the LRU/TTL clock so a busy session never ages out.
    if (status === "working" || status === "needs-you") this.touch(session);
    // Unread metadata is global per conversation, while visibility is per view.
    // Define the badge as "completed while nobody was looking": if VS Code or any
    // remote tab owns this session, at least one view watched the result arrive.
    if ((status === "done" || status === "error") && !this.sessionHasLiveOwner(session)) {
      this.setMetaUnread(session.activeSessionId, true, status === "error");
    }
    this.pushDot(session);
    if (status === "done" || status === "error") this.refreshSessionOrderAfterTurn(session);
  }

  /**
   * Re-push the project preview a finished turn just reordered.
   *
   * The rail's Recent group ranks by `updatedAt`, which is the session FILE's
   * mtime — and the extension is not what writes that file, the agent process
   * is. So rename and delete refresh (we do those) while sending a message did
   * not: nothing in here knew the row had moved. Recent stayed on whatever
   * order it was built with until something unrelated happened to redraw it.
   *
   * The turn ending is the closest signal we own. The agent writes the
   * transcript around the same moment, not necessarily before, so this reads a
   * beat later — and once more after that, because a single delay is a guess
   * about someone else's disk write. Two cheap directory scans, only when a
   * turn actually ended.
   */
  private refreshSessionOrderAfterTurn(session: Session): void {
    const cwd = this.sessionCwd(session);
    if (!cwd) return;
    for (const delay of [400, 1600]) {
      const timer = setTimeout(() => {
        this.turnOrderTimers.delete(timer);
        try {
          this.sendLocalRepoSessionsPreview(cwd);
        } catch {
          /* a preview refresh is never worth failing a turn over */
        }
      }, delay);
      this.turnOrderTimers.add(timer);
    }
  }

  /** Pending {@link refreshSessionOrderAfterTurn} timers, so dispose can clear them. */
  private turnOrderTimers = new Set<ReturnType<typeof setTimeout>>();

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
    return this.questionHost.showQuestion(session, req, responder);
  }

  private answerQuestion(
    session: Session,
    requestId: number | string,
    answers: Record<string, string>,
    annotations: Record<string, { notes?: string; preview?: string }>,
    auto = false,
  ): boolean {
    return this.questionHost.answerQuestion(session, requestId, answers, annotations, auto);
  }

  private cancelQuestion(session: Session, requestId: number | string, auto = false): boolean {
    return this.questionHost.cancelQuestion(session, requestId, auto);
  }

  private forgetQuestion(session: Session, requestId: number | string): void {
    return this.questionHost.forgetQuestion(session, requestId);
  }

  private autoContinueQuestion(session: Session, requestId: number | string): void {
    return this.questionHost.autoContinueQuestion(session, requestId);
  }

  private dropPendingQuestions(session: Session): void {
    return this.questionHost.dropPendingQuestions(session);
  }

  private hostPipe(): HostPipeMux {
    return this.questionHost.hostPipe();
  }

  private askUser(): AskUserServer {
    return this.questionHost.askUser();
  }

  private sessionForAskUserToken(token: string): Session | undefined {
    return this.questionHost.sessionForAskUserToken(token);
  }

  private revokeAskUserToken(session: Session): void {
    return this.questionHost.revokeAskUserToken(session);
  }

  private async askUserMcpServer(session: Session): Promise<AcpMcpStdioServer | undefined> {
    return this.questionHost.askUserMcpServer(session);
  }

  private syncHumanWait(session: Session): void {
    return this.questionHost.syncHumanWait(session);
  }

  private closeQuestionsForToolCall(
    session: Session,
    call: { toolCallId?: unknown; status?: unknown } | null | undefined,
  ): void {
    return this.questionHost.closeQuestionsForToolCall(session, call);
  }

  noteAnswered(session: Session): void {
    return this.questionHost.noteAnswered(session);
  }

  /** Push just this session's recomputed dot to the webview (cheap — no disk read
   *  beyond the small meta object). Used on status changes, read/unread changes,
   *  and on reaping (where the session has left the pool but may stay green). */
  private pushDot(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const message: HostMsg = { type: "sessionDot", id, dot: this.dotForId(id) };
    this.view?.webview.postMessage(message);
    this.mirrorToProjectsRail(message);
  }

  /** The dashboard dot for a grok-session id, from live status (if it's a live pool
   *  member) plus the persisted unread badge (which outlives the live process). */
  private dotForId(id: string): Dot {
    const live = [...this.pool].find((s) => s.activeSessionId === id);
    const meta = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    return computeDot({ liveStatus: live?.status, unread: meta?.unread, unreadError: meta?.unreadError });
  }

  /** Persist (or clear) a session's unread badge in globalState session-meta. */
  private setMetaUnread(id: string | undefined, unread: boolean, error: boolean): void {
    if (!id) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const next: SessionMetaOverrides = { ...overrides };
    if (unread) {
      if (cur.unread && !!cur.unreadError === error) return; // unchanged
      next[id] = { ...cur, unread: true, unreadError: error || undefined };
    } else {
      if (!cur.unread && !cur.unreadError) return; // nothing to clear
      const { unread: _u, unreadError: _e, ...rest } = cur;
      if (Object.keys(rest).length === 0) delete next[id];
      else next[id] = rest;
    }
    void this.state.update(SESSION_META_KEY, next);
  }

  /** Adapter catalogs own their persistence, so abandoning an empty conversation
   *  must use the advertised ACP delete rather than touching Grok's store. */
  private async discardAdapterEmptySession(
    provider: AcpProvider,
    id: string | undefined,
    cwd: string,
    liveClient?: AcpClient,
  ): Promise<boolean> {
    if (!id || !isAdapterProvider(provider)) return false;
    // A live client proves this conversation already ran; a temporary one may
    // only be spawned for a connected agent (#171).
    if (!liveClient && !this.hasProviderConsent(provider)) return false;
    let temporary: AcpClient | undefined;
    try {
      let client = liveClient;
      if (!client) {
        const cliPath = this.locateProvider(provider);
        const backend = this.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${providerDisplayName(provider)} CLI is not available.`);
        client = temporary = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.host.appendLine(message)
        });
        await client.start();
      }
      await client.deleteSession(id);
      const history = this.adapterHistory(provider);
      if (history) {
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => entry.id !== id));
        }
      }
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      if (overrides[id]) {
        const next = { ...overrides };
        delete next[id];
        await this.state.update(SESSION_META_KEY, next);
      }
      return true;
    } catch (error) {
      this.host.appendLine(`[${provider}] could not discard empty session ${id}: ${(error as Error).message}`);
      return false;
    } finally {
      if (temporary) await temporary.dispose();
    }
  }

  /**
   * Fold a finished turn's billing into the session total and push both to the
   * webview (#53). Skips turns whose usage isn't a real measurement — a
   * `/compact` replays the previous turn's numbers verbatim, so counting them
   * would double-bill that turn into the total on every compact.
   *
   * The total is persisted per session id because nothing on disk can rebuild
   * it: grok reports usage per prompt and `signals.json` keeps only context size.
   */
  private accumulateUsage(session: Session, meta: PromptResultMeta): PromiseLike<void> | undefined {
    const measured = usageIsRealMeasurement(meta);
    // One line per billed turn, in the Output panel, for every agent. The
    // donut answers "how full is the context"; this answers "what did that
    // cost", which is the question a session limit actually raises — and it
    // is the only per-turn record that survives the conversation being closed.
    // `research/usage-report.cjs` adds up a saved log.
    if (measured) {
      const u = meta.usage ?? {};
      this.host.appendLine(
        `[usage] ${session.provider} turn`
        + ` in=${u.inputTokens ?? meta.inputTokens ?? 0}`
        + ` out=${u.outputTokens ?? meta.outputTokens ?? 0}`
        + ` reasoning=${u.reasoningTokens ?? meta.reasoningTokens ?? 0}`
        + ` cacheRead=${u.cachedReadTokens ?? meta.cachedReadTokens ?? 0}`
        + ` cacheWrite=${u.cachedWriteTokens ?? meta.cachedWriteTokens ?? 0}`
        + ` total=${u.totalTokens ?? meta.totalTokens ?? 0}`
        + ` model=${meta.modelId ?? session.client?.currentModelId ?? "?"}`,
      );
    }
    // totalTokens:0 is the CLI's reliable no-inference result for native slash
    // turns such as /compact. Record that successful prompt as covered without
    // counting its stale usage siblings. A real inference with missing usage is
    // NOT covered: its cost is unknown, so the aggregate must remain withheld.
    if (!measured && meta.totalTokens !== 0) return;
    const id = session.activeSessionId;
    if (!id) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const occupancy = this.adapterTurnOccupancy(session, meta);
    const compacted = isAdapterProvider(session.provider) && session.adapterCompactThisTurn;
    const usageLog = capUsageLog([
      ...(cur.usageLog ?? []),
      {
        afterUserMessage: session.userMessageCount,
        afterHistoryEvent: session.historyEventCount,
        usage: measured ? meta.usage : undefined,
        ...(occupancy !== undefined
          ? { contextUsed: occupancy }
          : compacted && !cur.contextPendingCompact && cur.contextUsed
            ? { contextUsed: cur.contextUsed }
            : {}),
        ...(compacted ? { compacted: true } : {})
      },
    ]);
    const sessionUsage = enforceCompleteSessionCost(
      sumUsage(usageLog),
      usageLog,
      session.userMessageCount,
    );
    if (measured) {
      this.emit(session, { type: "usage", turn: meta.usage, session: sessionUsage, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount });
    }
    return this.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...cur, usage: sessionUsage, usageLog }
    });
  }

  private persistedUsageLedger(sessionId: string, userMessageCount: number): {
    usageLog: NonNullable<SessionMetaOverrides[string]["usageLog"]>;
    usage: PromptUsage | undefined;
  } {
    const persisted = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[sessionId];
    const usageLog = [...(persisted?.usageLog ?? [])];
    const rawUsage = persisted?.usageLog ? sumUsage(usageLog) : persisted?.usage;
    return {
      usageLog,
      usage: enforceCompleteSessionCost(rawUsage, usageLog, userMessageCount)
    };
  }

  /** Seed a (re)opened session's cumulative billing from our own globalState and
   *  push it, so the popover survives a reload. No stored total (an older session
   *  or a pre-usage CLI) posts nothing — the popover shows context only. */
  private restoreUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    // Re-derive from the id-keyed ledger instead of trusting an aggregate that may have summed
    // cost-bearing turns over historical turns where cost was not recorded.
    const stored = this.persistedUsageLedger(id, session.userMessageCount).usage;
    if (!stored) return;
    this.emit(session, { type: "usage", session: stored, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount });
  }

  private noteAdapterCompactSignal(session: Session, update: unknown): void {
    if (session.replaying || !isAdapterProvider(session.provider)) return;
    const signal = adapterCompactSignal(update);
    if (!signal) return;
    if (signal === "failed") {
      session.compactUsageArmed = false;
      session.adapterCompactThisTurn = false;
      this.rememberAdapterContext(session, { compactFailed: true });
      return;
    }
    session.adapterCompactThisTurn = true;
    session.compactUsageArmed = signal === "completed";
    this.rememberAdapterContext(session, { compacted: true });
  }

  /**
   * Largest single call in this turn, never Claude's summed PromptResponse.
   * A compact turn must not feed that sum back over getContextUsage.
   */
  private adapterTurnOccupancy(session: Session, meta: PromptResultMeta): number | undefined {
    if (!usageIsRealMeasurement(meta) || session.adapterCompactThisTurn) return undefined;
    return occupancyFromAdapterTurn(adapterContextOccupancy(meta.usage), session.adapterTurnCallUsed);
  }

  /**
   * Remember adapter occupancy and push it to the donut. Prompt size is the
   * conversation; a later smaller prompt is not, unless a compact just armed
   * a reset. Grok never enters here.
   */
  private rememberAdapterContext(
    session: Session,
    event: Parameters<typeof persistSessionContext>[1],
  ): { used?: number; window?: number } | undefined {
    if (!isAdapterProvider(session.provider)) return undefined;
    const id = session.activeSessionId;
    if (!id) return undefined;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const next = persistSessionContext(overrides[id] ?? {}, event);
    void this.state.update(SESSION_META_KEY, { ...overrides, [id]: next });
    const usage = persistedContextUsage(next);
    if (usage) {
      this.emit(session, {
        type: "contextUsage",
        used: usage.used,
        ...(usage.window ? { window: usage.window } : {})
      });
    } else if (next.contextWindow) {
      this.emit(session, { type: "contextUsage", window: next.contextWindow });
    }
    return { used: next.contextUsed, window: next.contextWindow };
  }

  /** Push the context size to the webview — chiefly the cold-restore source
   *  before any turn has run. Grok reads signals.json; Claude/Codex read the
   *  remembered prompt occupancy. Best-effort: no readable count, no message. */
  private emitContextUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    if (isAdapterProvider(session.provider)) {
      const usage = persistedContextUsage(this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]);
      if (usage) {
        this.emit(session, {
          type: "contextUsage",
          used: usage.used,
          ...(usage.window ? { window: usage.window } : {})
        });
      }
      return;
    }
    const cwd = this.sessionCwd(session);
    const usage = readContextUsage({ fs: defaultFs, grokHome: resolveGrokHome(process.env), cwd, id });
    if (usage) this.emit(session, { type: "contextUsage", used: usage.used, window: usage.window });
  }

  private subscriptionUsageCaches?: Map<string, SubscriptionUsageCache>;

  /**
   * Account capacity (#159, upstream 084dedf, 48942e1). Grok answers on
   * request, Claude pushes on a rate-limit event, Codex is read from its own
   * rollout file. Keyed by an opaque digest of the credential context, so a
   * different login never inherits another's numbers.
   */
  private bindSubscriptionUsage(session: Session, env: NodeJS.ProcessEnv): void {
    const provider = session.provider;
    if (provider !== "grok" && provider !== "claude" && provider !== "codex") {
      session.subscriptionUsage = undefined;
      return;
    }
    const cwd = this.sessionCwd(session);
    const key = subscriptionCredentialContext(provider, env);
    const caches = this.subscriptionUsageCaches ??= new Map();
    // Claude can log in through an opaque OS keychain: keep its observations
    // process-local. Grok and Codex write their login to a file the key hashes.
    let cache = provider === "claude" ? new SubscriptionUsageCache() : caches.get(key);
    if (!cache) caches.set(key, cache = new SubscriptionUsageCache());
    session.subscriptionUsage = new SubscriptionUsageBinding(cache, key, () =>
      subscriptionCredentialContext(provider, provider === "grok"
        ? { ...process.env, ...this.readDotEnv(cwd) } : process.env));
  }

  /** Free share of a provider's tightest known window, from any live binding. */
  private measuredFreePercent(provider: AcpProvider): number | undefined {
    for (const session of new Set([this.focused, ...(this.pool ?? [])])) {
      if (session?.provider !== provider || !session.subscriptionUsage) continue;
      const free = freePercentFromWindows(session.subscriptionUsage.snapshot());
      if (free !== undefined) return free;
    }
    return undefined;
  }

  private invalidateSubscriptionUsage(provider: AcpProvider): void {
    for (const [key, cache] of this.subscriptionUsageCaches ?? []) {
      if (key.startsWith(`${provider}:`)) {
        cache.invalidate();
        this.subscriptionUsageCaches!.delete(key);
      }
    }
    for (const session of new Set([this.focused, ...(this.pool ?? [])])) {
      if (session?.provider !== provider || !session.subscriptionUsage) continue;
      session.subscriptionUsage.invalidate();
      this.publishSubscriptionUsage(session);
    }
  }

  private publishSubscriptionUsage(session: Session): void {
    this.emit(session, { type: "subscriptionUsage", windows: session.subscriptionUsage?.snapshot() ?? [] });
  }

  /** On session start and a real popover open, never on a timer: a billing
   *  read re-arms a prompt's idle timer, so polling would hold a hung prompt. */
  private async refreshSubscriptionUsage(session: Session): Promise<void> {
    const binding = session.subscriptionUsage;
    const client = session.client;
    this.publishSubscriptionUsage(session);
    if (!binding) return;
    if (session.provider === "codex") {
      await binding.refresh(async () => readCodexSubscriptionWindows({ codexHome: resolveCodexHome(process.env) }));
    } else if (session.provider === "grok") {
      if (!client?.sessionId) return;
      await binding.refresh(() => client.getSubscriptionUsage());
    } else return;
    if (session.client === client && session.subscriptionUsage === binding) this.publishSubscriptionUsage(session);
  }

  /** Publish a control-plane session/info snapshot without touching accounting. */
  private emitSessionInfoContext(session: Session, info: SessionInfoContext): void {
    session.lastSessionInfoAt = Date.now();
    session.lastSessionInfoUsed = info.used;
    session.sessionInfoStale = false;
    this.emit(session, {
      type: "contextUsage",
      used: info.used,
      window: info.window,
      categories: info.categories,
      systemPromptTokens: info.systemPromptTokens,
      toolDefinitionsTokens: info.toolDefinitionsTokens,
      toolDefinitionsCount: info.toolDefinitionsCount,
      messageTokens: info.messageTokens,
      freeTokens: info.freeTokens,
      autoCompactThresholdPercent: info.autoCompactThresholdPercent,
      compactionCount: info.compactionCount
    });
    if (info.autoCompactThresholdPercent !== undefined) session.compactThresholdReported = info.autoCompactThresholdPercent;
    if (info.compactionCount !== undefined) session.compactionCount = info.compactionCount;
    this.checkCompactThreshold(session, info.autoCompactThresholdPercent);
  }

  /** K-02: the first snapshot of a Grok process tells whether the env was honoured. Never silent. */
  private checkCompactThreshold(session: Session, reported: number | undefined): void {
    if (session.provider !== "grok" || session.compactThresholdChecked || reported === undefined) return;
    session.compactThresholdChecked = true;
    const desired = session.compactThresholdRequested;
    if (!compactThresholdMismatch(desired, reported)) return;
    const text = compactThresholdMismatchNotice(desired!, reported);
    this.host.appendLine(`[context] ${text}`);
    if (this.compactMismatchNoticeShown) return;
    this.compactMismatchNoticeShown = true;
    this.emit(session, { type: "hostNotice", level: "warning", text });
  }

  /** K-04: a few points before the threshold, let the user decide instead of the CLI. */
  private maybeOfferNearFull(session: Session, used: number | undefined, window: number | undefined, threshold: number | undefined): void {
    if (used === undefined || window === undefined) return;
    const effective = threshold ?? session.compactThresholdReported;
    if (session.provider === "muse") return;
    let mode: "ask" | "off" = "ask";
    try {
      mode = this.host.getConfiguration("companions").get<string>("context.nearFullPrompt", "ask") === "off" ? "off" : "ask";
    } catch { /* default */ }
    if (!shouldOfferNearFull({ used, window, thresholdPercent: effective, armed: session.nearFullArmed, mode })) return;
    // Live only: a session in the background keeps its prompt armed for later.
    if (session !== this.focused) return;
    session.nearFullArmed = false;
    this.emit(session, {
      type: "nearFullPrompt",
      used,
      window,
      threshold: effective!,
      canCompact: providerCapability(session.provider, "manualCompact").state !== "no"
    });
  }

  /**
   * Read Grok's structured context meter. This is intentionally separate from
   * the adapter usageLog/contextUsageFromLog seam: those entries reconstruct
   * Claude/Codex occupancy and never describe Grok's live categories.
   */
  private async refreshContextFromSessionInfo(
    session: Session,
    gen: number,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    if ((session.provider !== "grok" && session.provider !== "gemini") || gen !== session.gen || session.sessionInfoUnsupported) return false;
    const client = session.client;
    if (!client?.sessionId) return false;
    if (!opts.force && !session.sessionInfoStale && sessionInfoCacheFresh(session.lastSessionInfoAt, Date.now())) {
      return false;
    }
    try {
      const info = await client.getSessionInfo();
      if (gen !== session.gen) return false;
      if (info === "unsupported") {
        session.sessionInfoUnsupported = true;
        return false;
      }
      this.emitSessionInfoContext(session, info);
      return true;
    } catch (error) {
      this.host.appendLine(`[context] session/info failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Post-compact compatibility chain: live notification → session/info →
   * legacy `/session-info`. The prompt fallback is only permitted after the
   * RPC explicitly returned -32601; a transient RPC error must not manufacture
   * a hidden model turn.
   */
  private async refreshContextAfterCompact(client: AcpClient, session: Session, gen: number): Promise<void> {
    if (await this.refreshContextFromSessionInfo(session, gen, { force: true })) return;
    if (gen !== session.gen || !session.sessionInfoUnsupported) return;
    if (!client.availableCommands.some((command) => command?.name === "session-info")) return;
    // NOT while somebody else's turn is running.
    //
    // This is a real `session/prompt`, and a second prompt ends the active one.
    // The compact path released its turn token before the RPC above, so another
    // tab can have started a genuine turn during that await — and sending this
    // would cancel it mid-work, silently, to refresh a context number. The
    // guards further down run only after this returns and cannot undo it.
    //
    // Skipping costs a stale context reading until the next turn refreshes it.
    // That is the cheaper of the two by a wide margin.
    if (turnIsInFlight(session)) return;
    session.suppressContent = true;
    session.captureAgentText = "";
    try {
      await client.prompt("/session-info");
      if (gen !== session.gen) return;
      const info = parseSessionInfoContext(session.captureAgentText);
      if (info) this.emit(session, { type: "contextUsage", used: info.used, window: info.window });
    } catch (error) {
      this.host.appendLine(`[compact] hidden /session-info failed: ${(error as Error).message}`);
    } finally {
      if (gen === session.gen) session.suppressContent = false;
      session.captureAgentText = undefined;
    }
  }

  /** Clear a session's unread badge (it's being opened/viewed) and refresh its dot. */
  private markRead(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const meta = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    if (!meta?.unread && !meta?.unreadError) return;
    this.setMetaUnread(id, false, false);
    this.pushDot(session);
  }

  /** Tear down every live session (logout, CLI update, extension teardown).
   *  Resolves once every process has actually exited — the CLI-update path awaits
   *  this so `grok update` doesn't race a still-locked grok.exe (see dispose()).
   *  Fire-and-forget callers (the sync VS Code disposable) can drop the promise. */
  private disposePool(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const s of this.pool) {
      const client = this.detachClient(s);
      if (client) closing.push(client.dispose());
    }
    this.pool.clear();
    return Promise.all(closing).then(() => undefined);
  }

  /** Start a brand-new session, keeping the current one alive in the background. */
  private async newFocusedSession(requestedCwd?: string): Promise<void> {
    // Repo selection only changes history scope; New Session is the deliberate
    // second action that starts Grok in the selected cwd — deliberate only for
    // the client that can SEE the selection. That used to exclude VS Code,
    // whose switcher was hidden; the projects rail is that switcher, so it no
    // longer does. The phone half of the old worry is handled where it always
    // was: a remote's selection is per-client and never reaches
    // `selectedRepoCwd` (see historyCwdFor).
    //
    // An explicitly named project (the rail's per-project "+") is honoured, and
    // it MOVES the selection rather than starting somewhere the rest of the view
    // is not looking. Resolved through the catalog, so an unknown path falls back
    // to the scope instead of becoming a cwd nobody vouched for — the caller may
    // be a webview, and a "+" on a row is not a licence to name a directory.
    const named = requestedCwd ? this.resolveLocalRepoTarget(requestedCwd) : undefined;
    if (requestedCwd && !named) {
      // A specific project was asked for and it is not there any more — the rail
      // was drawn before the folder was unmounted or deleted. Falling through to
      // the scope would start Grok in whatever happens to be selected while the
      // click plainly named another project, and the agent would then write
      // there. Refuse, and refresh so the dead row goes away.
      void this.host.showWarningMessage(`That project is no longer available:\n${requestedCwd}`);
      this.postRepoCatalog();
      this.postSessionsList();
      return;
    }
    if (named && !pathsEqual(named.cwd, this.selectedRepoCwd || "")) {
      this.selectedRepoCwd = named.cwd;
    }
    const targetCwd = named?.cwd ?? this.historyCwdFor();
    const leavingId = this.focused.activeSessionId;
    this.parkFocused();
    const unused = this.findUnusedEmptySession(targetCwd, leavingId);
    if (unused?.session?.client) {
      this.focusSession(unused.session);
    } else if (unused?.session) {
      this.focused = unused.session;
      this.pool.add(this.focused);
      this.emit(this.focused, { type: "clearMessages" });
      await this.startSession(unused.id, this.focused, "ensure");
    } else if (unused) {
      await this.openSession(unused.id, unused.cwd);
    } else {
      this.focused = this.newLocalSession();
      this.setSessionCwd(this.focused, targetCwd, this.workspaceRoot());
      this.focused.provider = this.defaultProviderForProject(targetCwd);
      // The webview toolbar button clears its own DOM before posting newSession,
      // but the Command Palette command lands here directly — without this clear
      // the old transcript stayed onscreen under the fresh session. (The toolbar
      // path just clears twice, a no-op.)
      this.emit(this.focused, { type: "clearMessages" });
      await this.startSession();
    }
    await this.persistWorktreeBinding(this.focused);
    this.sweepEmptySessions(this.sessionCwd(this.focused));
    this.postRepoCatalog();
    // The rail's rows for the selected project come from `sessions` frames, and
    // this path posted the catalog but never the list — so a new conversation on
    // the desktop did not appear in the rail until something unrelated refreshed
    // it (closing and reopening the project was how it got noticed). The remote
    // path has always sent its own list here; only the local one was missing it.
    // After the sweep, not before: the sweep can retire the empty session this
    // one replaced, and a list built ahead of it would show a row that is gone.
    this.postSessionsList();
  }

  /**
   * First full boot pass: repo catalog plus the deferred session-list build
   * that ready/cold-boot schedule after it. "Warmed" means this pair finished,
   * not that postRepoCatalog has merely started.
   */
  private async runFirstBootScan(opts?: { deferSessions?: boolean }): Promise<void> {
    if (this.firstBootScanStarted || this.firstBootScanCompleted) return;
    this.firstBootScanStarted = true;
    this.postRepoCatalog();
    const finish = async () => {
      this.postSessionsList();
      this.completeFirstBootScan();
    };
    if (opts?.deferSessions) {
      setImmediate(() => { void finish(); });
      return;
    }
    await finish();
  }

  private completeFirstBootScan(): void {
    this.firstBootScanCompleted = true;
  }

  /**
   * Open the session with grok id `id`. If it's already live in the pool, re-focus
   * it instantly (lossless buffer replay — no reload). Otherwise park the current
   * session and load this one cold from grok's on-disk history into a fresh member.
   */
  private async openSession(id: string, sessionCwd?: string): Promise<void> {
    // The user's open starts HERE, not in startSession. See the note there.
    const clock = new OpenClock();
    const claim = this.reserveSessionLoad(id);
    if (!claim) {
      this.host.appendLine(`[sessions] refused local resume (session load is reserved by another view)`);
      void this.host.showInformationMessage(
        "This conversation is already being opened in another tab or view.",
      );
      return;
    }
    let failure: unknown;
    try {
      // Claim before entering the workspace queue so a duplicate resume cannot
      // slip through while this transition waits for a repo switch already in
      // progress. The queued operation calls the exclusive switch primitive
      // directly; calling switchLocalWorkspaceFolder here would wait on the
      // same queue and deadlock the resume transition.
      const open = () => this.openSessionReserved(id, sessionCwd, clock);
      if (this.host.canSwitchWorkspaceFolder) {
        await this.localWorkspaceSwitchQueue.run(open);
      } else {
        await open();
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.releaseSessionLoad(id, claim.reservation, failure);
    }
    // Opening a conversation is the other moment the user is looking straight at
    // this repo's history — and the moment the session they just left became
    // abandonable. Only on success: a load that threw has told us nothing.
    this.sweepEmptySessions(this.sessionCwd(this.focused));
    // The history list follows the conversation the LOCAL user just opened.
    // With a rail in VS Code you can open one from another project, and leaving
    // the list on the old project meant reading a conversation from B while the
    // history beside it offered A's. Resolved through the catalog rather than
    // taken raw, because a worktree session's cwd is the worktree and the row
    // that owns it is the parent project.
    //
    // VS Code only. On desktop the selection and the ACTIVE FOLDER are one
    // thing — the file tree, New Session and the rail all read it — so moving
    // the selection without switching the folder would split them, and opening
    // a conversation is not a request to change which project you are in.
    // Desktop's own selectRepo does the whole switch; this is the half VS Code
    // needs because it has no folder to switch.
    if (this.host.canSwitchWorkspaceFolder) return;
    const openedIn = this.resolveLocalRepoTarget(this.sessionCwd(this.focused));
    if (openedIn && !pathsEqual(openedIn.cwd, this.selectedRepoCwd || "")) {
      this.selectedRepoCwd = openedIn.cwd;
      this.postRepoCatalog();
      this.postSessionsList();
    }
  }

  /**
   * Host-trusted directories that may hold a session catalog for local resume,
   * list, select, and desktop file authorization.
   *
   * **Desktop** (`canSwitchWorkspaceFolder`): exactly the configured open
   * folders plus worktrees authorized for sessions within them. The full
   * historical `discoverRepos` catalog is deliberately excluded — a closed
   * repo must not become a process cwd or widen {@link desktopAuthRoots}.
   *
   * **VS Code**: the full historical catalog (history can span any discovered
   * checkout under grok home). That is the v3.1.0 behaviour and must not regress.
   */
  private localTrustedSessionCwds(overrides: SessionMetaOverrides): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (cwd: string | undefined) => {
      if (!cwd) return;
      const key = normalizeRepoPath(cwd);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(cwd);
    };
    if (this.host.canSwitchWorkspaceFolder) {
      for (const repoCwd of this.openWorkspaceFolders()) {
        for (const c of this.sessionCwdsForRepo(repoCwd, overrides)) add(c);
      }
      // Active root as a backstop if the folders list is empty mid-init.
      add(this.workspaceRoot());
      return out;
    }
    // VS Code: full historical catalog.
    add(this.workspaceRoot());
    if (this.selectedRepoCwd) add(this.selectedRepoCwd);
    for (const repo of this.repoCatalog()) {
      for (const c of this.sessionCwdsForRepo(repo.cwd, overrides)) add(c);
    }
    return out;
  }

  /**
   * Move only the desktop view to the project represented by a resumed
   * session. A worktree cwd is authorized for the session but is not itself an
   * open workspace folder, so the file tree deliberately follows the
   * worktree's owning project root instead.
   *
   * `openSession` already owns localWorkspaceSwitchQueue while this runs. Keep
   * this on the exclusive path: taking the public queue wrapper here would
   * deadlock the resume transition.
   */
  private async followSessionWorkspace(session: Session): Promise<void> {
    if (!this.host.canSwitchWorkspaceFolder) return;
    const intendedTarget = session.worktree?.sourceGitRoot ?? session.cwd;
    if (!intendedTarget) {
      this.host.appendLine(
        "[sessions] skipped active-folder follow (resumed session has no project root)",
      );
      return;
    }
    // ONE resolution, always from the session's own cwd. A plain session's cwd
    // is itself an open folder and matches exactly; a worktree's resolves
    // through ownership, which declines when more than one open folder claims
    // it. Trying sourceGitRoot first would walk straight past that guard: with
    // both /repo and /repo/packages/app open, a worktree made from app records
    // /repo, so the exact match would move the panel — and every subsequent new
    // session's root — up to /repo without ever noticing the ambiguity.
    const target = session.cwd ? this.resolveLocalRepoTarget(session.cwd)?.cwd : undefined;
    if (!target) {
      this.host.appendLine(
        `[sessions] skipped active-folder follow (no single open folder owns ${intendedTarget})`,
      );
      return;
    }
    await this.switchLocalWorkspaceFolderExclusive(target, { warnOnRefusal: false });
  }

  private async openSessionReserved(id: string, sessionCwd?: string, clock?: OpenClock): Promise<void> {
    for (const s of this.pool) {
      if (s.activeSessionId === id && s.client) {
        await this.followSessionWorkspace(s);
        this.focusSession(s);
        return;
      }
    }
    this.parkFocused();
    this.focused = this.newLocalSession();
    this.pool.add(this.focused);
    // Session cwd is resolved host-side from the on-disk catalog. The message
    // may name an id (and optionally a look-first cwd that must already be
    // trusted); it never supplies the process root.
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const o = overrides[id];
    this.focused.provider = o?.provider ?? "grok";
    const trustedCwds = this.localTrustedSessionCwds(overrides);
    const candidates = orderedResumeCwdCandidates({
      messageCwd: sessionCwd,
      trustedCwds,
      metaWorktreePath: o?.worktreePath,
      cachedCwd: o?.providerCwd ?? this.sessionCache.get(id)?.entry.cwd,
      sameCwd: pathsEqual
    });
    const cwd = isAdapterProvider(this.focused.provider)
      ? candidates.find((candidate) => trustedCwds.some((trusted) => pathsEqual(candidate, trusted)))
      : findSessionCatalogCwd({
          fs: defaultFs,
          grokHome: resolveGrokHome(process.env),
          id,
          candidates
        });
    if (!cwd) {
      this.host.appendLine(
        `[sessions] refused resumeSession (session ${id} not found under any trusted catalog cwd)`,
      );
      void this.host.showInformationMessage(
        "Could not restore this conversation. It may have been deleted. Starting a new session.",
      );
      await this.startSession();
      this.postRepoCatalog();
      return;
    }
    this.focused.cwd = cwd;
    if (o?.worktreePath && pathsEqual(o.worktreePath, cwd)) {
      this.focused.worktree = {
        path: o.worktreePath,
        label: o.worktreeLabel || path.basename(o.worktreePath),
        sourceGitRoot: o.sourceGitRoot || this.workspaceRoot()
      };
    } else {
      const hit = matchWorktreeForCwd(cwd, worktreesForRepo(this.worktreeCache, this.workspaceRoot(), { includeDead: true }));
      if (hit) {
        this.focused.worktree = {
          path: hit.path,
          label: hit.label,
          sourceGitRoot: hit.sourceRepo || this.workspaceRoot(),
          id: hit.id
        };
      }
    }
    await this.followSessionWorkspace(this.focused);
    // Same as the remote open: this id already has a conversation. startSession
    // resets hasHistory if the load actually runs; if the provider cannot
    // answer we return first, and this bit stops a later re-check from
    // retargeting the row onto a different agent.
    this.focused.hasHistory = true;
    await this.startSession(id, this.focused, "ensure", clock);
    this.markRead(this.focused); // opening a cold session clears its unread badge
    this.postRepoCatalog();
  }

  /** Reveal the panel AND move keyboard focus into the composer, so every flow
   *  that adds an attachment (Send Selection / Send File / @-mention, the "+"
   *  file picker, image paste) leaves the user ready to type a prompt (#43).
   *  show(false) takes focus to the view; the focusInput message then lands the
   *  caret in the textarea itself. This matters even for the picker/paste flows:
   *  the native file dialog returns focus to the editor on close, and a plain
   *  Send Selection would otherwise leave focus in the editor. */
  private revealAndFocusComposer(): void {
    this.view?.show?.(false);
    this.post({ type: "focusInput" });
  }

  private watchActiveEditor(): void {
    this.editorWatcher?.dispose();
    this.editorWatcher = disposeAll(
      this.host.onDidChangeActiveTextEditor(() => this.refreshImplicitChip()),
      // Host already filters to the active editor (split editors that are not
      // active must not drive the context chip).
      this.host.onDidChangeActiveTextEditorSelection(() => this.refreshImplicitChip()),
    );
  }

  /** The remembered eye-off choice for the active-editor context chip (#67).
   *  Defaults to visible — this only ever reflects an explicit click. */
  private implicitChipHidden(): boolean {
    return this.state.get<boolean>(IMPLICIT_CHIP_HIDDEN_KEY, false);
  }

  /** Mirror the active editor (file + live selection line range) onto the
   *  implicit context chip. No-op diffing keeps this silent for plain cursor
   *  movement — selection events fire on every caret change, but an empty
   *  selection compares equal to the previous empty one, so nothing is posted.
   *  `forcePost` is for a fresh webview, which needs the current state even
   *  when it hasn't changed. */
  /**
   * The focused conversation's relative path for a file, or undefined when the
   * file does not really belong to it.
   *
   * Lexical containment first ({@link relativePathWithin}), then CANONICAL.
   * A symlink — or a Windows junction — inside project B pointing at project A
   * passes the lexical test as `linked/secret.ts`, because it genuinely is at
   * that path inside B. But `buildPrompt` opens the absolute path and reads
   * whatever is on the other end, so A's source would be embedded in B's
   * conversation under a name that looks like B's own. The remote file browser
   * has always resolved canonically for exactly this reason
   * (`resolveTreePath` in `file-tree.ts`); this fence has to as well.
   *
   * Unprovable means refused: if either side cannot be resolved (deleted,
   * permissions), there is no containment to demonstrate, and a chip is not
   * worth guessing about.
   */
  private conversationRelPath(absPath: string): string | undefined {
    const root = this.sessionCwd(this.focused);
    const lexical = relativePathWithin(root, absPath);
    if (lexical === undefined) return undefined;
    try {
      if (relativePathWithin(fs.realpathSync(root), fs.realpathSync(absPath)) === undefined) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    // The LEXICAL path is the label: it is where the user sees the file, and
    // rewriting it to the link target would name a project they did not open.
    return lexical;
  }

  private refreshImplicitChip(forcePost = false): void {
    const includeActive = this.host.getConfiguration("grok")
      .get<boolean>("includeActiveFileByDefault", true);
    const prev = this.chips.filter(isFileChip).find(isImplicitChip);
    const editor = this.host.getActiveTextEditor();

    if (!includeActive || !editor || editor.document.uri.scheme !== "file") {
      // No chip to show — and if one is lingering, the webview must hear about
      // its removal (the old code cleared host-side but never posted).
      this.chips = clearImplicitChips(this.chips);
      if (prev || forcePost) this.postChips();
      return;
    }

    const absPath = editor.document.uri.fsPath;
    // The chip must belong to the CONVERSATION, not to the window.
    //
    // While VS Code history was pinned to the open folder these were the same
    // thing, so taking the active editor unconditionally was safe. It is not any
    // more: the rail can put a project-B conversation on screen while VS Code
    // still shows a project-A file. Sending then attached A's file — and for a
    // SELECTION, `buildPrompt` reads that absolute path and embeds A's source
    // text under an A-relative name — into B's prompt. Content crossing projects
    // is exactly the class this scope work exists to close.
    //
    // Also the source of the relative path now. `asRelativePath` resolves
    // against VS Code's workspace folders, and a project reached through the
    // rail is deliberately not one of them, so it would have handed back an
    // absolute path for a file that is perfectly ordinary inside its own repo.
    const relPath = this.conversationRelPath(absPath);
    if (relPath === undefined) {
      this.chips = clearImplicitChips(this.chips);
      if (prev || forcePost) this.postChips();
      return;
    }
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (!editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }

    if (
      prev &&
      prev.path === absPath &&
      prev.relPath === relPath &&
      prev.selectionStart === selStart &&
      prev.selectionEnd === selEnd
    ) {
      if (forcePost) this.postChips();
      return;
    }

    const next = makeImplicitChip(absPath, relPath, selStart, selEnd);
    next.hidden = implicitChipStartsHidden(prev, this.implicitChipHidden());
    this.chips = clearImplicitChips(this.chips);
    this.chips.push(next);
    this.postChips();
  }

  /** Parse the workspace `.env` into a plain map (no process.env merge). Used by
   *  both the CLI env builder and the voice key resolver. */
  private readDotEnv(cwd: string): Record<string, string> {
    const dotEnv: Record<string, string> = {};
    try {
      const content = fs.readFileSync(path.join(cwd, ".env"), "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key) dotEnv[key] = val;
      }
    } catch { /* no .env — fine */ }
    return dotEnv;
  }

  private warnOAuthShadowOnce(defaultAuthMethodId: unknown, env: NodeJS.ProcessEnv): void {
    if (!oauthShadowsXaiApiKey(defaultAuthMethodId, env)) return;
    if (this.oauthShadowWarningShown || this.state.get<boolean>(OAUTH_SHADOW_WARNING_KEY, false)) return;
    this.oauthShadowWarningShown = true;
    void this.state.update(OAUTH_SHADOW_WARNING_KEY, true);
    void this.host.showWarningMessage(
      "Grok is using its cached OAuth session, so XAI_API_KEY is currently ignored. To use the API key, run `grok logout`, then start a new session.",
    );
  }

  /** `companions.grok.autoCompactThresholdPercent`; 0 = keep Grok's own default. */
  private grokCompactThresholdSetting(): number {
    try {
      const n = this.host.getConfiguration("companions").get<number>("grok.autoCompactThresholdPercent", DEFAULT_COMPACT_THRESHOLD);
      return typeof n === "number" ? n : DEFAULT_COMPACT_THRESHOLD;
    } catch {
      return DEFAULT_COMPACT_THRESHOLD;
    }
  }

  /** K-01: the env reaches new processes only. Offer to restart the idle
   *  Grok ones — never a working or needs-you session (pool reap rules). */
  private async offerGrokRestartForCompactThreshold(): Promise<void> {
    const idle = () => [...new Set([this.focused, ...this.pool])].filter(
      (s) => s?.provider === "grok" && s.client && s.status === "idle",
    );
    if (idle().length === 0) return;
    const pick = await this.host.showInformationMessage(
      "The compaction threshold applies to new Grok sessions. Restart idle Grok sessions now?",
      "Restart idle sessions",
    );
    if (pick !== "Restart idle sessions") return;
    let n = 0;
    for (const s of idle()) {
      // Detached, the conversation resumes on the next send (ensureClient).
      void this.detachClient(s)?.dispose();
      n++;
    }
    this.host.appendLine(`[context] restarted ${n} idle Grok session(s) for the new compaction threshold`);
  }

  private buildEnv(cwd: string): NodeJS.ProcessEnv {
    const dotEnv = this.readDotEnv(cwd);
    const env: NodeJS.ProcessEnv = { ...process.env, ...dotEnv };

    // XAI_API_KEY is the generic xAI key name; grok CLI needs GROK_CODE_XAI_API_KEY.
    // Map from either source (workspace .env or the user's shell environment).
    if (env["XAI_API_KEY"] && !env["GROK_CODE_XAI_API_KEY"]) {
      env["GROK_CODE_XAI_API_KEY"] = env["XAI_API_KEY"];
    }

    // Tell the agent which shell dialect to write for — match the shell we
    // actually run its commands under (#46, §2.9). Presence check (not truthiness)
    // so an explicitly-empty user GROK_SHELL ("let grok detect") is honored, not
    // overridden. Frozen at spawn: a mid-session `grok.terminalShell` toggle
    // updates the shell we RUN commands under (cache cleared) but not this env,
    // so the dialect hint realigns on the next session — acceptable for a rare
    // escape-hatch toggle.
    if (!("GROK_SHELL" in env)) {
      const grokShell = grokShellEnvValue(resolvedTerminalShell(), process.platform);
      if (grokShell) env["GROK_SHELL"] = grokShell;
    }

    // Compact only when the context is really full (K-01). The catalog pins
    // 80%; the env outranks it. A user-set variable (shell or .env) wins.
    const compactThreshold = grokCompactThresholdEnv(this.grokCompactThresholdSetting(), env);
    if (compactThreshold !== undefined) env[GROK_COMPACT_ENV] = compactThreshold;
    // S-07: Grok's own subagents — on/off and parallelism, by env, like K-01.
    const grokSub = this.companionsSetting<string>("grok.subagents.enabled", "default");
    Object.assign(env, grokSubagentEnv({
      ...(grokSub === "on" ? { enabled: true } : grokSub === "off" ? { enabled: false } : {}),
      maxConcurrent: Number(this.companionsSetting<number>("grok.subagents.maxConcurrent", 0)) || 0
    }, env));

    if (Object.keys(dotEnv).length > 0) {
      this.host.appendLine(`[env] loaded ${Object.keys(dotEnv).length} var(s) from .env`);
    }
    return env;
  }

  /** How many enlargeable images a session remembers. Bounded because the map
   *  is keyed by a handle we mint per path and never otherwise expire. */
  private static readonly FULL_IMAGE_HANDLE_LIMIT = 300;

  /** handle -> path, and its inverse so the same picture keeps one handle
   *  across replays instead of minting a new one on every reconnect. */
  private readonly fullImagePaths = new Map<string, string>();
  private readonly fullImageHandles = new Map<string, string>();

  /** Mint (or reuse) the handle for a path we are about to show a remote. */
  private registerFullImage(imagePath: string): string {
    const existing = this.fullImageHandles.get(imagePath);
    if (existing) return existing;
    const handle = randomUUID().replace(/-/g, "");
    this.fullImageHandles.set(imagePath, handle);
    this.fullImagePaths.set(handle, imagePath);
    while (this.fullImagePaths.size > GrokSidebar.FULL_IMAGE_HANDLE_LIMIT) {
      const oldest = this.fullImagePaths.keys().next().value;
      if (oldest === undefined) break;
      const stalePath = this.fullImagePaths.get(oldest);
      this.fullImagePaths.delete(oldest);
      if (stalePath && this.fullImageHandles.get(stalePath) === oldest) {
        this.fullImageHandles.delete(stalePath);
      }
    }
    return handle;
  }

  /** Fetch-time revalidation for remote image handles (open-set + session media). */
  private isImagePathAuthorizedNow(imagePath: string, session?: Session): boolean {
    if (this.isImagePathInOpenSet(imagePath)) return true;
    // Pasted attachments live in global storage, outside the project. Require
    // staging containment AND a reference in the asking session, so one
    // session cannot read another's images (upstream 330e709).
    if (!session || !this.isAuthorizedCwd(this.sessionCwd(session))) return false;
    try {
      if (!pathBoundToClosedFolder(fs.realpathSync(imagePath), fs.realpathSync(this.imageStagingDir()), pathsEqual)) return false;
    } catch { return false; }
    const owns = (images: readonly unknown[]) => images.some((image) => (image as { path?: unknown }).path === imagePath);
    return owns(session.chips)
      || session.queuedSends.some((item) => owns(item.chips))
      || session.buffer.some((m) =>
        m.type === "userMessage" ? owns(m.chips ?? [])
          : m.type === "userMessageChunk" ? owns((m as { images?: { path?: string }[] }).images ?? []) : false);
  }

  /** Whole original image as a data URI, for the clipboard. Undefined when
   *  unsupported or over the budget: never resized to fit. */
  private async readOriginalImage(imagePath: string): Promise<string | undefined> {
    try {
      const mime = guessMediaMime(imagePath);
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)) return undefined;
      const limit = 25 * 1024 * 1024;
      if ((await fs.promises.stat(imagePath)).size > limit) return undefined;
      const bytes = await fs.promises.readFile(imagePath);
      if (!bytes.length || bytes.length > limit) return undefined;
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  private isImagePathInOpenSet(imagePath: string): boolean {
    const authorized = this.authorizedSessionCwds();
    let home: string | undefined;
    try {
      home = resolveGrokHome(process.env);
    } catch {
      home = undefined;
    }
    return imagePathStillAuthorized(imagePath, authorized, {
      grokHome: home,
      sameCwd: pathsEqual,
      isTrustedGeneratedMedia: (p) => {
        try {
          return !!home && isTrustedGeneratedMediaPath(p, home, (c) => fs.realpathSync(c));
        } catch {
          return false;
        }
      }
    });
  }

  /**
   * HTML for the primary-side-bar projects rail. Self-contained: does not load
   * chat.js (that would create a second chat client).
   */
  private getProjectsRailHtml(webview: HostWebview): string {
    return this.webviewHtml.getProjectsRailHtml(webview);
  }

  /**
   */
  async openSettingsEditor(category?: string): Promise<void> {
    const targetCategory = category === "rules" ? "advanced" : category;
    if (this.settingsEditor) {
      this.settingsEditor.reveal();
      if (targetCategory) {
        void this.settingsEditor.webview.postMessage({ type: "settingsCategory", category: targetCategory });
      }
      return;
    }
    const panel = this.host.openEditorWebview({
      viewType: "grok.settings",
      title: "All your Companions Settings",
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, "media"),
        Uri.joinPath(this.context.extensionUri, "resources"),
      ]
    });
    if (!panel) return;
    this.settingsEditor = panel;
    panel.onDidDispose(() => {
      if (this.settingsEditor === panel) this.settingsEditor = undefined;
    });
    panel.webview.html = this.getSettingsHtml(panel.webview, {
      category: targetCategory
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const msg = raw as WebviewMsg;
      void this.onSettingsPanelMessage(msg).catch((e) => {
        const text = (e as Error)?.message ?? String(e);
        this.host.appendLine(`[settings] ${msg.type} failed: ${text}`);
      });
    });
  }

  private async onSettingsPanelMessage(msg: WebviewMsg): Promise<void> {
    if (!GrokSidebar.SETTINGS_PANEL_TYPES.has(msg.type)) {
      this.host.appendLine(`[settings] ignored ${msg.type}`);
      return;
    }
    await this.onMessage(msg);
  }

  private getSettingsHtml(
    webview: HostWebview,
    opts: { category?: string } = {},
  ): string {
    return this.webviewHtml.getSettingsHtml(webview, opts);
  }

  private getHtml(webview: HostWebview): string {
    return this.webviewHtml.getHtml(webview);
  }
}

/**
 * Which Agents & Crew card a refusal belongs to. Prefixed by kind because a
 * role, a crew flow and a workflow may share a name, and an unsaved card has
 * no name at all. media/settings.js `agentCardId` builds the same string.
 */
export function agentCardErrorId(kind: "role" | "flow" | "workflow", name?: string): string {
  return kind + ":" + (name || "*new*");
}
