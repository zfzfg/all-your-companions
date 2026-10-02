import { PROVIDER_CLI } from "./provider-cli";
import { grokShellEnvValue, resolvedTerminalShell } from "./terminal-manager";
import { grokSubagentEnv } from "./grok-subagent-env";
export interface ProviderSetupSidebarOps {
  grokCompactThresholdSetting?: () => number;
  companionsSetting: <T>(key: string, fallback: T) => T;
  readonly host: Host;
}
/** ProviderSetup: GrokSidebar collaborator for provider discovery, setup, auth and warmup. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient } from "./acp";
import { errorDetail, isCredentialError } from "./acp-dispatch";
import { ACP_PROVIDERS, type AcpProvider, isAdapterProvider } from "./acp-backend";
import { CLAUDE_ACP_ADAPTER_VERSION, ClaudeBackend, isClaudeCredentialError } from "./claude-backend";

import { warmClaudeModelCache } from "./claude-model-cache";

import { CODEX_ACP_ADAPTER_VERSION, CodexBackend, isCodexCredentialError } from "./codex-backend";

import { CODEX_MANAGED_VERSION, installManagedCodex } from "./codex-managed-installer";
import { warmCodexModelCache } from "./codex-model-cache";
import { GeminiBackend, isGeminiCredentialError } from "./gemini-backend";
import { hasAntigravityCredentials } from "./gemini-cli-locator";
import { warmGeminiModelCache } from "./gemini-model-cache";
import type { Host, HostContext } from "./host";
import { MuseBackend } from "./muse-backend";

import type { PersistedState } from "./persisted-state";
import  {
  connectedProviderIds,
  projectProviderKey,
  type ProjectProviderDefaults,
  type ProviderConnections,
  providerLoginState,
  type ProviderModelInfo,
  usableProviderIds,
  versionIsOlder
} from "./provider-ui";
import { Session } from "./session";
import { type SessionListEntry } from "./sessions";
import type { HostMsg } from "./protocol";

export const PROVIDER_CONNECTIONS_KEY = "grok.providerConnections.v2";
export const PROJECT_PROVIDER_DEFAULTS_KEY = "grok.projectProviderDefaults";

export interface ProviderSetupDeps {
  readonly host: Host;
  readonly context: HostContext;
  readonly state: PersistedState;
  readonly providerCliVersions: Partial<Record<AcpProvider, string>>;
  workspaceRoot(): string;
  post(msg: HostMsg): void;
  postLocal(msg: HostMsg): void;
  postToSettingsEditor(msg: HostMsg): void;
  cacheProviderModels(
    provider: AcpProvider,
    models: readonly ProviderModelInfo[] | readonly any[],
    currentModelId?: string,
  ): PromiseLike<void>;
  probeProviderVersion(provider: AcpProvider): Promise<string>;
  invalidateSubscriptionUsage(provider: AcpProvider): void;
  rearmAuthRecovery(provider: AcpProvider): void;
  refreshGithubState(): Promise<void>;
  buildEnv(cwd: string): NodeJS.ProcessEnv;
  removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;

  readonly sidebarOps: ProviderSetupSidebarOps;
}

export class ProviderSetup {
  cliPath?: string;
  codexCliPath?: string;
  claudeCliPath?: string;
  geminiCliPath?: string;
  museCliPath?: string;
  testForceMissingGrokCli?: boolean;
  providerRefreshInFlight = false;
  providerConnectionState: ProviderConnections = {};
  providerNeedsLogin: Partial<Record<AcpProvider, boolean>> = {};
  lastProviderConnected: { grok: boolean; codex: boolean; claude: boolean; gemini: boolean } | null = null;
  codexInstallAbort?: AbortController;

  codexSessionCache = new Map<string, SessionListEntry[]>();
  codexSessionCacheAt = new Map<string, number>();
  codexSessionRefresh = new Map<string, Promise<void>>();
  claudeSessionCache = new Map<string, SessionListEntry[]>();
  claudeSessionCacheAt = new Map<string, number>();
  claudeSessionRefresh = new Map<string, Promise<void>>();
  geminiSessionCache = new Map<string, SessionListEntry[]>();
  geminiSessionCacheAt = new Map<string, number>();
  geminiSessionRefresh = new Map<string, Promise<void>>();
  museSessionCache = new Map<string, SessionListEntry[]>();
  museSessionCacheAt = new Map<string, number>();
  museSessionRefresh = new Map<string, Promise<void>>();
  loginReprobeTimers = new Map<AcpProvider, NodeJS.Timeout>();
  private connectChecks = new Set<AcpProvider>();
  private credentialGenerations = new Map<AcpProvider, number>();

  constructor(private readonly deps: ProviderSetupDeps) {}

  private get host() { return this.deps.host; }
  private get context() { return this.deps.context; }
  private get state() { return this.deps.state; }
  private get providerCliVersions() { return this.deps.providerCliVersions; }
  private workspaceRoot(): string { return this.deps.workspaceRoot(); }
  private post(msg: HostMsg): void { this.deps.post(msg); }
  private postLocal(msg: HostMsg): void { this.deps.postLocal(msg); }
  private invalidateSubscriptionUsage(provider: AcpProvider): void { this.deps.invalidateSubscriptionUsage(provider); }
  private cacheProviderModels(provider: AcpProvider, models: readonly ProviderModelInfo[] | readonly any[], currentModelId?: string): PromiseLike<void> {
    return this.deps.cacheProviderModels(provider, models, currentModelId);
  }
  private probeProviderVersion(provider: AcpProvider): Promise<string> {
    return this.deps.probeProviderVersion(provider);
  }
  private removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean {
    return this.deps.removeSessionFromDisk(id, sessionCwd);
  }
  private refreshGithubState(): Promise<void> { return this.deps.refreshGithubState(); }

  providerConnections(): ProviderConnections {
    const override = this.deps.getOverride?.<typeof this.providerConnections>("providerConnections");
    if (override) return override();
    return this.providerConnectionState;
  }

  /**
   * Whether the person has CONNECTED this agent (#171, upstream 4444697).
   *
   * Connection is a fact stated by pressing Connect/Sign in, read from storage
   * and never discovered: nothing here may run a vendor's binary for an agent
   * that is not connected — no credential probe, model catalog, version read
   * or history listing. Finding the CLI on disk is a filesystem check and
   * still runs, because Connect cannot be offered for something not seen.
   */
  hasProviderConsent(provider: AcpProvider): boolean {
    return this.providerConnections()?.[provider] === true;
  }

  /** Session-start snapshot of `grok.acp.*` timeouts (#117). */
  acpClientTimeouts() {
    const cfg = this.host?.getConfiguration ? this.host.getConfiguration("grok") : undefined;
    return {
      promptIdleTimeoutMs: cfg?.get<number>("acp.promptIdleTimeoutMs"),
      promptAbsoluteTimeoutMs: cfg?.get<number>("acp.promptAbsoluteTimeoutMs"),
      requestTimeoutMs: cfg?.get<number>("acp.requestTimeoutMs"),
    };
  }

  locateProvider(provider: AcpProvider): string | undefined {
    const override = this.deps.getOverride?.<typeof this.locateProvider>("locateProvider");
    if (override) return override(provider);
    const policy = PROVIDER_CLI[provider];
    const cached = this[policy.cacheKey];
    if (cached && fs.existsSync(cached)) return cached;
    if (policy.environment === "grok" && this.testForceMissingGrokCli) {
      this[policy.cacheKey] = undefined;
      return undefined;
    }
    const companionsCfg = this.host?.getConfiguration ? this.host.getConfiguration("companions") : undefined;
    const grokCfg = this.host?.getConfiguration ? this.host.getConfiguration("grok") : undefined;
    const configuredPath = (policy.cacheKey === "geminiCliPath"
      ? (companionsCfg?.get<string>("antigravityCliPath") || companionsCfg?.get<string>("geminiCliPath"))
      : companionsCfg?.get<string>(policy.cacheKey))
      ?? grokCfg?.get<string>(policy.cacheKey, "") ?? "";
    return this[policy.cacheKey] = policy.locate({
      configuredPath,
      managedStorageRoot: this.context?.globalStorageUri?.fsPath ?? "",
      arch: process.arch,
    });
  }

  locatedProviders(): Partial<Record<AcpProvider, boolean>> {
    const override = this.deps.getOverride?.<typeof this.locatedProviders>("locatedProviders");
    if (override) return override();
    return {
      grok: !!this.locateProvider("grok"),
      codex: !!this.locateProvider("codex"),
      claude: !!this.locateProvider("claude"),
      gemini: !!this.locateProvider("gemini"),
      muse: !!this.locateProvider("muse"),
    };
  }

  adapterHistory(provider: AcpProvider): {
    cache: Map<string, SessionListEntry[]>;
    at: Map<string, number>;
    refresh: Map<string, Promise<void>>;
  } | undefined {
    const histories = {
      grok: undefined,
      codex: { cache: this.codexSessionCache, at: this.codexSessionCacheAt, refresh: this.codexSessionRefresh },
      claude: { cache: this.claudeSessionCache, at: this.claudeSessionCacheAt, refresh: this.claudeSessionRefresh },
      gemini: { cache: this.geminiSessionCache, at: this.geminiSessionCacheAt, refresh: this.geminiSessionRefresh },
      muse: { cache: this.museSessionCache, at: this.museSessionCacheAt, refresh: this.museSessionRefresh },
    };
    return histories[provider];
  }

  allAdapterCatalogs(): Iterable<readonly SessionListEntry[]> {
    return [
      ...(this.codexSessionCache?.values() ?? []),
      ...(this.claudeSessionCache?.values() ?? []),
      ...(this.geminiSessionCache?.values() ?? []),
      ...(this.museSessionCache?.values() ?? []),
    ];
  }

  createProviderBackend(provider: AcpProvider, effort?: string): CodexBackend | ClaudeBackend | GeminiBackend | MuseBackend | undefined {
    if (provider === "codex") return new CodexBackend();
    if (provider === "claude") {
      const companionsCfg = this.host?.getConfiguration ? this.host.getConfiguration("companions") : undefined;
      const grokCfg = this.host?.getConfiguration ? this.host.getConfiguration("grok") : undefined;
      const allowedTools = companionsCfg?.get<string[]>(
        "claudeAllowedTools",
        grokCfg?.get<string[]>("claudeAllowedTools", []) ?? [],
      ) ?? grokCfg?.get<string[]>("claudeAllowedTools", []);
      const customAgents = companionsCfg?.get<unknown>(
        "claudeCustomAgents",
        grokCfg?.get<unknown>("claudeCustomAgents", undefined),
      ) ?? grokCfg?.get<unknown>("claudeCustomAgents", undefined);
      return new ClaudeBackend({
        allowedTools: Array.isArray(allowedTools) && allowedTools.length > 0 ? allowedTools : undefined,
        customAgents: customAgents ? customAgents : undefined,
        effort: effort || undefined,
      });
    }
    if (provider === "gemini") {
      const cfg = this.host?.getConfiguration?.("companions");
      return new GeminiBackend({
        toolRules: cfg?.get<"prompt" | "off" | "global">("antigravity.toolRules", "prompt"),
        watchdogIdleTimeoutMs: cfg?.get<number>("antigravity.watchdogIdleTimeoutMs", 0),
        admission: { maxActiveTurns: cfg?.get<number>("antigravity.maxActiveTurns", 0) ?? 0,
          minStartSpacingMs: cfg?.get<number>("antigravity.minStartSpacingMs", 2000) ?? 2000 },
      });
    }
    if (provider === "muse") return new MuseBackend();
    return undefined;
  }

  connectedProviders(): AcpProvider[] {
    const override = this.deps.getOverride?.<typeof this.connectedProviders>("connectedProviders");
    if (override) return override();
    return connectedProviderIds(this.providerConnections(), this.locatedProviders());
  }

  /** Connected AND able to answer — see usableProviderIds. Use this to decide who
   *  runs a turn or which onboarding to show; use connectedProviders() to decide
   *  what to say ABOUT a provider, which still wants the lapsed ones. */
  usableProviders(): AcpProvider[] {
    return usableProviderIds(this.providerConnections(), this.locatedProviders(), this.providerNeedsLogin ?? {});
  }

  /**
   * The onboarding panel a session should show when it cannot run.
   *
   * With nothing CONNECTED, offer the choice of all three rather than one
   * provider's sign-in instructions: a session can carry a stale `provider`
   * inherited from a project default, and telling someone who has connected
   * nothing to "Complete codex login" names an agent they may never have picked.
   *
   * A conversation WITH history is different, and never gets the chooser: its
   * provider is pinned after the first turn, so there is nothing to choose. If
   * that agent's credentials die mid-session, its own sign-in is the only
   * correct panel — offering three would trade an answer for a question about
   * something the session cannot change anyway.
   *
   * Otherwise it depends on whether anything can answer. With NONE available,
   * the provider on an empty session is only a guess — a project default, or
   * whatever was used last — so naming one agent's sign-in presents a decision
   * as though it had already been made; offer all three and ask honestly. With
   * something available the session's own provider is the specific gap to
   * close, so show that.
   */
  onboardingForSession(session: Session): "connect-agent" | "auth-required" | "codex-login" | "claude-login" | "gemini-login" | "muse-login" {
    if (session.hasHistory) return providerLoginState(session.provider);
    return this.usableProviders().length ? providerLoginState(session.provider) : "connect-agent";
  }

  migrateProviderConnections(): ProviderConnections {
    const existing = this.state?.get ? this.state.get<ProviderConnections>(PROVIDER_CONNECTIONS_KEY) : undefined;
    if (existing !== undefined) return existing;
    // Nothing is inferred from what is installed or signed in on disk:
    // connecting is one press, and guessing it is what #171 was about.
    const migrated: ProviderConnections = {};
    if (this.state?.update) void this.state.update(PROVIDER_CONNECTIONS_KEY, migrated);
    return migrated;
  }

  setProviderConnectedInMemory(provider: AcpProvider, connected: boolean): void {
    const current = this.providerConnections();
    if (!connected) {
      this.credentialGenerations.set(provider, (this.credentialGenerations.get(provider) ?? 0) + 1);
      const timer = this.loginReprobeTimers.get(provider);
      if (timer) clearTimeout(timer);
      this.loginReprobeTimers.delete(provider);
    }
    if (connected && !current[provider]) this.providerNeedsLogin = { ...this.providerNeedsLogin, [provider]: true };
    if (!connected || !current[provider]) this.invalidateSubscriptionUsage(provider);
    this.providerConnectionState = { ...current, [provider]: connected };
    if (!connected && isAdapterProvider(provider)) {
      const history = this.adapterHistory(provider);
      history?.cache.clear();
      // A reconnect must re-list immediately. Keeping the old freshness stamp
      // after dropping the rows creates a fresh-but-empty cache for ten seconds.
      history?.at.clear();
    }
    this.postProviderState();
    if (connected) void this.probeProviderVersion(provider);
  }

  async persistProviderConnections(): Promise<void> {
    if (this.state?.update) {
      await this.state.update(PROVIDER_CONNECTIONS_KEY, this.providerConnectionState);
    }
  }

  async setProviderConnected(provider: AcpProvider, connected: boolean): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.setProviderConnected>("setProviderConnected");
    if (override) return override(provider, connected);
    this.setProviderConnectedInMemory(provider, connected);
    await this.persistProviderConnections();
  }

  /**
   * An agent that is installed and configured but will not authenticate.
   *
   * Disconnecting it would be the wrong hammer — that hides every conversation
   * it owns and tears down live sessions for a fault one sign-in fixes. This is
   * a view-only flag: the account still counts as connected, and every surface
   * that would otherwise degrade silently (a bare "<Agent> default" row in the
   * model picker, a history list that just comes back empty) shows the same
   * sign-in action the connect flow uses.
   *
   * Only the provider's credential classifier may raise it: adapter probes use
   * that backend's `isCredentialError`, while Grok uses `isCredentialError`.
   * The billing/entitlement family must never route to a login screen (#58).
   */
  setProviderNeedsLogin(provider: AcpProvider, needsLogin: boolean): void {
    const current = this.providerNeedsLogin ?? {};
    if (!!current[provider] === needsLogin) return;
    this.providerNeedsLogin = { ...current, [provider]: needsLogin };
    if (needsLogin) this.invalidateSubscriptionUsage(provider);
    // A recovered account must be able to re-list at once; the freshness stamp
    // would otherwise hold the empty catalog for its full back-off window.
    if (!needsLogin && isAdapterProvider(provider)) this.adapterHistory(provider)?.at.clear();
    // And it must be able to RECOVER again. `authRecoveryTried` survives a
    // restart on purpose (#58) and only a clean turn re-arms it — which a
    // conversation holding a process built on a dead token never has. A
    // completed sign-in is the new information it stood in for (upstream 61e0c57).
    if (!needsLogin) this.rearmAuthRecovery(provider);
    this.postProviderState();
  }

  /** Every session on this provider may try the token dance once more. */
  rearmAuthRecovery(provider: AcpProvider): void {
    this.deps.rearmAuthRecovery(provider);
  }

  async warmConnectedCodexModels(_requireProof = false): Promise<boolean> {
    if (!this.hasProviderConsent("codex")) return false;
    const cliPath = this.locateProvider("codex");
    if (!cliPath) return false;
    const generation = this.credentialGenerations.get("codex") ?? 0;
    const current = () => this.hasProviderConsent("codex") && generation === (this.credentialGenerations.get("codex") ?? 0);
    try {
      await warmCodexModelCache({
        cliPath,
        onModels: (models, currentModelId) => current() ? this.cacheProviderModels("codex", models, currentModelId) : undefined,
        log: (message) => this.host.appendLine(message),
        // Codex answered "Internal error" for a session in a bare temp dir on
        // Windows, so the cache never filled and a freshly connected Codex was
        // missing from the picker until a real session created one. The
        // workspace is the cwd a real session uses, so it is known to work.
        fallbackCwd: this.workspaceRoot() || undefined,
      });
      if (!current()) return false;
      this.setProviderNeedsLogin("codex", false);
      return true;
    } catch (error) {
      if (!current()) return false;
      this.host.appendLine(`[codex] model-cache warm-up failed: ${(error as Error).message}`);
      // The warm-up is the first thing that talks to the agent after a connect,
      // so its failure is the earliest honest answer about the credentials —
      // but only when the failure IS about credentials.
      if (isCodexCredentialError(error)) {
        this.setProviderNeedsLogin("codex", true);
      }
      return false;
    }
  }

  async warmConnectedClaudeModels(_requireProof = false): Promise<boolean> {
    if (!this.hasProviderConsent("claude")) return false;
    const cliPath = this.locateProvider("claude");
    if (!cliPath) return false;
    const generation = this.credentialGenerations.get("claude") ?? 0;
    const current = () => this.hasProviderConsent("claude") && generation === (this.credentialGenerations.get("claude") ?? 0);
    try {
      await warmClaudeModelCache({
        cliPath,
        onModels: (models, currentModelId) => current() ? this.cacheProviderModels("claude", models, currentModelId) : undefined,
        log: (message) => this.host.appendLine(message),
        // Same refusal Codex saw: `session/new` answering "Internal error" for
        // a session in a bare temp directory on Windows, so the cache never
        // filled and Claude never appeared connected (#146). The workspace is
        // the cwd a real session uses, so it is known to work.
        fallbackCwd: this.workspaceRoot() || undefined,
      });
      if (!current()) return false;
      this.setProviderNeedsLogin("claude", false);
      return true;
    } catch (error) {
      if (!current()) return false;
      this.host.appendLine(`[claude] model-cache warm-up failed: ${(error as Error).message}`);
      if (isClaudeCredentialError(error)) {
        this.setProviderNeedsLogin("claude", true);
      }
      return false;
    }
  }

  async warmConnectedGeminiModels(_requireProof = false): Promise<boolean> {
    if (!this.hasProviderConsent("gemini")) return false;
    const cliPath = this.locateProvider("gemini");
    if (!cliPath) return false;
    this.host.appendLine("[antigravity] Third-party access may carry account or service restrictions. Review https://antigravity.google/terms. Authentication stays with agy.");
    const generation = this.credentialGenerations.get("gemini") ?? 0;
    const current = () => this.hasProviderConsent("gemini") && generation === (this.credentialGenerations.get("gemini") ?? 0);
    try {
      await warmGeminiModelCache({
        cliPath,
        onModels: (models, currentModelId) => current() ? this.cacheProviderModels("gemini", models, currentModelId) : undefined,
        log: (message) => this.host.appendLine(message),
        fallbackCwd: this.workspaceRoot() || undefined,
      });
      // The Antigravity adapter answers session/new from a static model list
      // without launching `agy`, so this warm-up proves the binary, not the
      // account. Cached credentials or keyring indicate a signed-in account.
      const signedIn = hasAntigravityCredentials();
      if (!signedIn) this.host.appendLine("[gemini] no cached Antigravity credentials found — start `agy` to sign in");
      if (!current()) return false;
      this.setProviderNeedsLogin("gemini", !signedIn);
      return signedIn;
    } catch (error) {
      if (!current()) return false;
      this.host.appendLine(`[gemini] model-cache warm-up failed: ${(error as Error).message}`);
      if (isGeminiCredentialError(error)) {
        this.setProviderNeedsLogin("gemini", true);
      }
      return false;
    }
  }

  /** Explicit credential observation. Unlike history refresh this never obeys
   * the listing freshness clock, so a completed sign-in is visible at once. */
  async reprobeProviderCredentials(provider: AcpProvider, requireProof = false): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.reprobeProviderCredentials>("reprobeProviderCredentials");
    if (override) return override(provider, requireProof);
    if (!this.hasProviderConsent(provider)) return false;
    const probe = PROVIDER_CLI[provider].credentialProbe;
    if (probe === "unavailable") return false;
    if (probe !== "native") return this[probe](requireProof);
    const generation = this.credentialGenerations.get(provider) ?? 0;
    const current = () => this.hasProviderConsent(provider) && generation === (this.credentialGenerations.get(provider) ?? 0);
    const cliPath = this.locateProvider("grok");
    if (!cliPath) return false;
    // session/new is what actually proves the account, but grok has no ACP
    // session/delete (AcpClient.deleteSession always throws for this provider).
    // A leftover lands in ~/.grok/sessions/<urlencoded-cwd>/ as a summary-only
    // directory the catalog lists as "Untitled" and the CLI cannot load.
    // Probe in a scratch cwd so a failed cleanup cannot appear in the user's
    // project; still delete the dir after the process exits.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cred-probe-"));
    const envCwd = this.workspaceRoot() || scratch;
    const client = new AcpClient({
      cliPath,
      cwd: scratch,
      env: this.buildEnv(envCwd),
      log: (message) => this.host.appendLine(message),
      grokVersion: this.providerCliVersions.grok,
    });
    try {
      await client.start();
      await client.newSession();
      if (!current()) return false;
      this.cacheProviderModels("grok", client.availableModels, client.currentModelId);
      this.setProviderNeedsLogin("grok", false);
      return true;
    } catch (error) {
      this.host.appendLine(`[grok] credential re-probe failed: ${errorDetail(error)}`);
      if (current() && (client.isCredentialError(error) || isCredentialError(error))) {
        this.setProviderNeedsLogin("grok", true);
      }
      return false;
    } finally {
      const probeId = client.sessionId;
      await client.dispose();
      if (probeId) this.removeSessionFromDisk(probeId, scratch);
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* leftover temp dir is harmless */ }
    }
  }

  /** Does the provider's own credential file exist? Deliberately shallow —
   *  presence only, no validity claim: it separates "sign-in never landed"
   *  from "landed, but our probe is unhappy", which lead a person to
   *  different next actions. */
  providerCredentialFilePresent(provider: AcpProvider): boolean {
    try { return PROVIDER_CLI[provider].credentialFiles().some((file) => fs.existsSync(file)); }
    catch { return false; }
  }

  /** Observe an interactive terminal login without requiring a reload. Terminal
   * APIs do not expose CLI completion portably, so retry on a short bounded
   * cadence and stop at the first authenticated probe. */
  watchProviderLogin(provider: AcpProvider): void {
    const previous = this.loginReprobeTimers.get(provider);
    if (previous) clearTimeout(previous);
    const delays = [0, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
    const attempt = async (index: number): Promise<void> => {
      this.loginReprobeTimers.delete(provider);
      const generation = this.credentialGenerations.get(provider) ?? 0;
      if (!this.hasProviderConsent(provider)) return;
      if (await this.reprobeProviderCredentials(provider, true)) return;
      if (!this.hasProviderConsent(provider) || generation !== (this.credentialGenerations.get(provider) ?? 0)) return;
      const delay = delays[index + 1];
      if (delay === undefined) return;
      const timer = setTimeout(() => void attempt(index + 1), delay);
      this.loginReprobeTimers.set(provider, timer);
    };
    void attempt(0);
  }

  async installManagedCodexCli(): Promise<void> {
    if (this.codexInstallAbort) return;
    const alreadyLocated = this.locateProvider("codex");
    if (alreadyLocated) {
      this.postLocal({ type: "onboarding", state: "codex-login", platform: process.platform });
      return;
    }

    const controller = new AbortController();
    this.codexInstallAbort = controller;
    try {
      const binary = await installManagedCodex({
        storageRoot: this.context.globalStorageUri.fsPath,
        signal: controller.signal,
        onProgress: (phase, value) => this.postLocal({
          type: "codexInstallProgress",
          phase,
          receivedBytes: value?.receivedBytes,
          totalBytes: value?.totalBytes,
        }),
      });
      this.codexCliPath = binary;
      this.postProviderState();
      this.postLocal({ type: "codexInstallProgress", phase: "idle" });
      this.postLocal({ type: "onboarding", state: "codex-login", platform: process.platform });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const reason = cancelled
        ? "Codex installation was cancelled."
        : `Codex installation failed: ${errorDetail(error)}`;
      this.host.appendLine(`[codex] managed install failed: ${reason}`);
      this.postLocal({ type: "codexInstallProgress", phase: "idle", reason });
      this.postLocal({ type: "onboarding", state: "missing-codex", platform: process.platform, reason, provider: "codex" });
    } finally {
      if (this.codexInstallAbort === controller) this.codexInstallAbort = undefined;
    }
  }

  setProviderConnectChecking(provider: AcpProvider, checking: boolean): void {
    if (checking) this.connectChecks.add(provider);
    else this.connectChecks.delete(provider);
    this.postProviderState();
  }

  providerStateMessage(): Extract<HostMsg, { type: "providerState" }> {
    const connected = { ...this.providerConnections() };
    for (const provider of this.connectChecks) connected[provider] = false;
    const located = this.locatedProviders();
    const versions = this.providerCliVersions ?? {};
    const needsLogin = this.providerNeedsLogin ?? {};
    const grokConnected = connected.grok === true && located.grok === true;
    const codexConnected = connected.codex === true && located.codex === true;
    const claudeConnected = connected.claude === true && located.claude === true;
    const geminiConnected = connected.gemini === true && located.gemini === true;
    const museConnected = connected.muse === true && located.muse === true;
    this.lastProviderConnected = { grok: grokConnected, codex: codexConnected, claude: claudeConnected, gemini: geminiConnected };
    return {
      type: "providerState",
      providers: [
        {
          id: "grok",
          connected: grokConnected,
          ...(grokConnected && versions.grok ? { cliVersion: versions.grok } : {}),
          ...(grokConnected && needsLogin.grok ? { needsLogin: true } : {}),
        },
        {
          id: "codex",
          connected: codexConnected,
          ...(codexConnected && needsLogin.codex ? { needsLogin: true } : {}),
          ...(codexConnected && versions.codex ? { cliVersion: versions.codex } : {}),
          ...(codexConnected ? {
            adapterVersion: CODEX_ACP_ADAPTER_VERSION,
            latestCliVersion: CODEX_MANAGED_VERSION,
            ...(versions.codex ? { updateAvailable: versionIsOlder(versions.codex, CODEX_MANAGED_VERSION) } : {}),
          } : {}),
        },
        {
          id: "claude",
          connected: claudeConnected,
          ...(claudeConnected && needsLogin.claude ? { needsLogin: true } : {}),
          ...(claudeConnected && versions.claude ? { cliVersion: versions.claude } : {}),
          ...(claudeConnected ? { adapterVersion: CLAUDE_ACP_ADAPTER_VERSION } : {}),
        },
        {
          id: "gemini",
          connected: geminiConnected,
          ...(geminiConnected && needsLogin.gemini ? { needsLogin: true } : {}),
          ...(geminiConnected && versions.gemini ? { cliVersion: versions.gemini } : {}),
        },
        {
          id: "muse",
          connected: museConnected,
          ...(museConnected && needsLogin.muse ? { needsLogin: true } : {}),
          ...(museConnected && versions.muse ? { cliVersion: versions.muse } : {}),
        },
      ],
      ...(this.providerRefreshInFlight || this.connectChecks.size ? { checking: true } : {}),
    };
  }

  /** Chat, the projects rail, remotes — and the VS Code settings tab, which
   *  reads `providerState` but sits outside `post()`. Without this line that
   *  tab's Providers page only ever showed the snapshot it booted with, so a
   *  sign-in completed elsewhere never reached it. Same shape as
   *  {@link postGrokUpdateStatus}. */
  postProviderState(): void {
    const override = this.deps.getOverride?.<typeof this.postProviderState>("postProviderState");
    if (override) {
      override();
      return;
    }
    const message = this.providerStateMessage();
    this.post(message);
    this.deps.postToSettingsEditor(message);
  }

  /**
   * Re-observe every account, asserting nothing about any of them.
   *
   * Settings → Providers is derived from a persisted connection flag, a cached
   * CLI path and the last credential probe — none of which re-check themselves.
   * Sign out inside a terminal, install a CLI, let a token lapse, and the page
   * keeps repeating what it last heard. This is the way to make it tell the
   * truth, and it runs both from the page's Refresh button and when the page
   * is opened.
   *
   * Every INSTALLED agent is probed, not just the ones already marked connected.
   * Signing in happens outside this extension — a browser OAuth approval, a
   * `grok login` in any terminal — and the desk has no way to hear about it.
   * Probing only the already-connected set made the button useless in exactly
   * the case people press it: approve Grok in the browser, press Refresh, and
   * it skipped Grok because the stale flag said "not connected" (owner, and it
   * meant opening the chat and pressing Check instead).
   *
   * A provider whose CLI is not installed is still skipped — there is nothing
   * to run and nothing to learn.
   *
   * Still NOT `recheckConnection`: that marks its provider connected BEFORE
   * probing, so a failed sign-in leaves an account the user never had. Here the
   * probe comes first and only a SUCCESS promotes — evidence, not assumption.
   * A failure never demotes: a lapsed account keeps its row and gets the
   * sign-in action (see setProviderNeedsLogin), and one that was never
   * connected simply stays that way.
   */
  async refreshProviderStates(): Promise<void> {
    if (this.providerRefreshInFlight) return;
    this.providerRefreshInFlight = true;
    // Say it started before the slow part. The button reads `checking` off this
    // frame, so posting it first is what makes the click feel answered.
    this.postProviderState();
    try {
      // Drop the located paths so the locators genuinely re-run. `locateProvider`
      // only invalidates a cached path when the file is gone, so a CLI installed
      // or repointed since boot would otherwise stay invisible.
      if (!this.testForceMissingGrokCli) this.cliPath = undefined;
      this.codexCliPath = undefined;
      this.claudeCliPath = undefined;
      this.geminiCliPath = undefined;
      this.museCliPath = undefined;
      // Read AFTER dropping the paths, so a CLI that appeared since boot counts.
      const located = this.locatedProviders();
      // NEITHER probe nor promotion for an agent that is not connected (#171):
      // promoting whichever installed CLI answered was the extension deciding,
      // on the person's behalf, to run a vendor's binary and keep the result.
      const installed = ACP_PROVIDERS.filter((provider: AcpProvider) => located[provider] && this.hasProviderConsent(provider));
      // Failures are the answer here, not an error: a rejected probe is how a
      // lapsed account gets its needsLogin flag. reprobeProviderCredentials
      // already classifies and records that, so nothing is swallowed.
      //
      // Versions are deliberately not re-probed. They are read once per
      // activation by design, they do not appear on this page, and every
      // connected account already probes its version when it connects.
      await Promise.all(installed.map(async (provider: AcpProvider) => {
        await this.reprobeProviderCredentials(provider).catch(() => false);
      }));
    } finally {
      this.providerRefreshInFlight = false;
      // Always the last word, however the probes went — a spinner that outlives
      // its refresh is worse than a stale row, because it never resolves.
      this.postProviderState();
      void this.refreshGithubState();
    }
  }

  // USABLE, not merely connected. A provider whose credentials have lapsed is
  // still connected and still located, so it used to win connected[0] and
  // capture every new session — the owner had Grok and Claude unconnected and
  // Codex connected-but-expired, and a fresh session dropped him into "Complete
  // codex login" rather than letting him pick. Grok stays the fallback when
  // nothing can answer, which is what the empty case already did.
  defaultProviderForProject(cwd: string): AcpProvider {
    const usable = this.usableProviders();
    const saved = this.state?.get ? this.state.get<ProjectProviderDefaults>(PROJECT_PROVIDER_DEFAULTS_KEY, {})[
      projectProviderKey(cwd)
    ] : undefined;
    if (saved && usable.includes(saved.provider)) return saved.provider;
    return usable[0] ?? "grok";
  }

  providerDefaultForProject(cwd: string, provider: AcpProvider): string | undefined {
    const saved = this.state?.get ? this.state.get<ProjectProviderDefaults>(PROJECT_PROVIDER_DEFAULTS_KEY, {})[
      projectProviderKey(cwd)
    ] : undefined;
    if (saved?.provider === provider) return saved.modelId || undefined;
    const grokCfg = this.host?.getConfiguration ? this.host.getConfiguration("grok") : undefined;
    return provider === "grok"
      ? grokCfg?.get<string>("defaultModel", "") || undefined
      : undefined;
  }

  async rememberProjectProvider(cwd: string, provider: AcpProvider, modelId?: string): Promise<void> {
    if (!this.state?.update) return;
    const current = this.state.get<ProjectProviderDefaults>(PROJECT_PROVIDER_DEFAULTS_KEY, {});
    await this.state.update(PROJECT_PROVIDER_DEFAULTS_KEY, {
      ...current,
      [projectProviderKey(cwd)]: { provider, ...(modelId ? { modelId } : {}) },
    } satisfies ProjectProviderDefaults);
  }

  isProviderCredentialError(provider: AcpProvider, error: unknown): boolean {
    const checks = { grok: isCredentialError, codex: isCodexCredentialError, claude: isClaudeCredentialError, gemini: isGeminiCredentialError, muse: (err: unknown) => new MuseBackend().isCredentialError(err) };
    return checks[provider](error);
  }

  dispose(): void {
    for (const timer of this.loginReprobeTimers.values()) {
      clearTimeout(timer);
    }
    this.loginReprobeTimers.clear();
    this.codexInstallAbort?.abort(new Error("Installation cancelled."));
    this.codexInstallAbort = undefined;
  }


/** Parse the workspace `.env` into a plain map (no process.env merge). Used by
   *  both the CLI env builder and the voice key resolver. */
  public readDotEnv(cwd: string): Record<string, string> {
    const override = this.deps.getOverride?.<typeof this.readDotEnv>("readDotEnv");
    if (override) return override(cwd);

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

public buildEnv(cwd: string): NodeJS.ProcessEnv {
    const override = this.deps.getOverride?.<typeof this.buildEnv>("buildEnv");
    if (override) return override(cwd);

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

    // S-07: Grok's own subagents — on/off and parallelism, by env, like K-01.
    const grokSub = this.deps.sidebarOps.companionsSetting<string>("grok.subagents.enabled", "default");
    Object.assign(env, grokSubagentEnv({
      ...(grokSub === "on" ? { enabled: true } : grokSub === "off" ? { enabled: false } : {}),
      maxConcurrent: Number(this.deps.sidebarOps.companionsSetting<number>("grok.subagents.maxConcurrent", 0)) || 0
    }, env));

    if (Object.keys(dotEnv).length > 0) {
      this.deps.sidebarOps.host.appendLine(`[env] loaded ${Object.keys(dotEnv).length} var(s) from .env`);
    }
    return env;
  }
}
