import { PROVIDER_CLI } from "./provider-cli";
import { isAcpProvider } from "./acp-backend";

export interface CliUpdateHostSidebarOps {
  hasProviderConsent: (provider: AcpProvider) => boolean;
  probeCodexVersion: () => Promise<string>;
  probeClaudeVersion: () => Promise<string>;
  probeGeminiVersion: () => Promise<string>;
  probeMuseVersion: () => Promise<string>;
  locateProvider: (provider: AcpProvider) => string | undefined;
  readGrokVersion: (cliPath: string, timeout?: number) => Promise<string>;
  postProviderState: () => void;
  readonly providerCliVersions: Partial<Record<"grok" | "codex" | "claude" | "gemini" | "muse", string>>;
}
/**
 * CliUpdateHost: CLI update execution, provider version probing,
 * and on-demand grok/codex/claude updater workflows.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S7d).
 */

import * as fs from "node:fs";
import type { Host } from "./host";
import type { AcpProvider } from "./acp-backend";
import type { Session } from "./session";
import type { MementoLike } from "./usage-host";
import { pathsEqual } from "./worktree";
import { cliUpdatePlan, selfUpdateArgs } from "./cli-update-plan";
import { providerDisplayName, parseCodexVersionOutput, type ProviderModelCache } from "./provider-ui";
import { execGrokCli } from "./cli-process";
import { isLockedBinaryError, grokUpdatePolicy } from "./cli-locator";

import { parseClaudeVersionOutput } from "./claude-cli-locator";
import { parseMuseVersionOutput } from "./muse-cli-locator";
import { parseGeminiVersionOutput } from "./gemini-cli-locator";
import { PROVIDER_MODEL_CACHE_KEY } from "./subagent-host";

export interface CliUpdateHostDeps {
  host: Host;
  state: MementoLike;
  context: { globalStorageUri: { fsPath: string } };
  post(msg: any): void;
  postGrokUpdateStatus(msg: any): void;
  postProviderState(): void;
  providerCliVersions: Record<string, string>;
  hasProviderConsent(provider: AcpProvider): boolean;
  locateProvider(provider: AcpProvider): string | undefined;
  readGrokVersion(cliPath: string): Promise<string>;
  connectedProviders(): string[];
  installManagedCodexCli(): Promise<void>;
  reprobeProviderCredentials(provider: AcpProvider): Promise<void | boolean>;
  getFocused(): Session;
  setFocused(session: Session): void;
  getPool(): Iterable<Session>;
  newLocalSession(): Session;
  disposePool(): Promise<void>;
  startSession(resumeId?: string): Promise<any>;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;

  readonly sidebarOps: CliUpdateHostSidebarOps;
}

export class CliUpdateHost {
  public codexVersionProbe?: Promise<string>;
  public claudeVersionProbe?: Promise<string>;
  public museVersionProbe?: Promise<string>;
  public geminiVersionProbe?: Promise<string>;

  constructor(private readonly deps: CliUpdateHostDeps) {}

  public async updateProviderCli(provider: unknown): Promise<void> {
    if (!isAcpProvider(provider)) return;
    const update = PROVIDER_CLI[provider].update;
    if (!update) return;
    if (!this.deps.hasProviderConsent(provider)) return;
    const cliPath = this.deps.locateProvider(provider);
    if (!cliPath) return;
    let realPath = cliPath;
    try { realPath = fs.realpathSync(cliPath); } catch { /* keep the located path */ }
    const managedRoot = this.deps.context.globalStorageUri.fsPath;
    const managed = update.managed && pathsEqual(realPath.slice(0, managedRoot.length), managedRoot);
    if (managed) {
      await this.deps.installManagedCodexCli();
      return;
    }
    const plan = cliUpdatePlan({
      managed: false,
      realPath,
      packageName: update.packageName,
      targetVersion: update.targetVersion,
    });
    const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    const command = plan.kind === "npm"
      ? `npm install -g --prefix ${quote(plan.prefix)} ${plan.packageSpec}`
      : [quote(cliPath), ...selfUpdateArgs(update.provider, plan.kind === "self" ? plan.target : undefined)].join(" ");
    const term = this.deps.host.createTerminal({ name: `Update ${providerDisplayName(provider)} CLI` });
    term.show();
    term.sendText(command);
    this.deps.host.appendLine(`[${provider}] CLI update started in a terminal: ${command}`);
    this[update.provider === "codex" ? "codexVersionProbe" : "claudeVersionProbe"] = undefined;
  }

  public async refreshModelsIfCliChanged(provider: AcpProvider, version: string): Promise<void> {
    if (!version || !this.deps.hasProviderConsent(provider)) return;
    const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const cached = cache[provider];
    if (!cached || cached.cliVersion === version) return;
    await this.deps.state.update(PROVIDER_MODEL_CACHE_KEY, {
      ...cache,
      [provider]: { ...cached, cliVersion: version },
    } satisfies ProviderModelCache);
    this.deps.host.appendLine(`[${provider}] CLI ${cached.cliVersion ?? "unknown"} -> ${version}; re-reading the model catalog`);
    await this.deps.reprobeProviderCredentials(provider);
  }

  public probeCodexVersion(): Promise<string> {
    if (this.codexVersionProbe) return this.codexVersionProbe;
    this.codexVersionProbe = (async () => {
      const cliPath = this.deps.locateProvider("codex");
      if (!cliPath) return "";
      try {
        const { stdout } = await execGrokCli(cliPath, ["--version"], {
          timeout: 30_000,
          windowsHide: true,
        });
        const version = parseCodexVersionOutput(stdout ?? "");
        if (!version) throw new Error("unrecognized version output");
        this.deps.providerCliVersions.codex = version;
        this.deps.postProviderState();
        await this.refreshModelsIfCliChanged("codex", version);
        return version;
      } catch (error) {
        this.deps.host.appendLine(`codex --version failed: ${(error as Error).message}`);
        this.deps.postProviderState();
        return "";
      }
    })();
    return this.codexVersionProbe;
  }

  public probeClaudeVersion(): Promise<string> {
    if (this.claudeVersionProbe) return this.claudeVersionProbe;
    this.claudeVersionProbe = (async () => {
      const cliPath = this.deps.locateProvider("claude");
      if (!cliPath) return "";
      try {
        const { stdout } = await execGrokCli(cliPath, ["--version"], {
          timeout: 30_000,
          windowsHide: true,
        });
        const version = parseClaudeVersionOutput(stdout ?? "");
        if (!version) throw new Error("unrecognized version output");
        this.deps.providerCliVersions.claude = version;
        this.deps.postProviderState();
        await this.refreshModelsIfCliChanged("claude", version);
        return version;
      } catch (error) {
        this.deps.host.appendLine(`claude --version failed: ${(error as Error).message}`);
        this.deps.postProviderState();
        return "";
      }
    })();
    return this.claudeVersionProbe;
  }

  public probeMuseVersion(): Promise<string> {
    if (!this.deps.hasProviderConsent("muse")) return Promise.resolve("");
    if (this.museVersionProbe) return this.museVersionProbe;
    this.museVersionProbe = (async () => {
      const cliPath = this.deps.locateProvider("muse");
      if (!cliPath) return "";
      try {
        const { stdout } = await execGrokCli(cliPath, ["--version"], { timeout: 30_000, windowsHide: true });
        const version = parseMuseVersionOutput(stdout ?? "");
        if (!version) throw new Error("unrecognized version output");
        this.deps.providerCliVersions.muse = version;
        this.deps.postProviderState();
        return version;
      } catch (error) {
        this.deps.host.appendLine(`muse --version failed: ${(error as Error).message}`);
        this.deps.postProviderState();
        return "";
      }
    })();
    return this.museVersionProbe;
  }

  public probeGeminiVersion(): Promise<string> {
    if (this.geminiVersionProbe) return this.geminiVersionProbe;
    this.geminiVersionProbe = (async () => {
      const cliPath = this.deps.locateProvider("gemini");
      if (!cliPath) return "";
      try {
        const { stdout } = await execGrokCli(cliPath, ["--version"], {
          timeout: 30_000,
          windowsHide: true,
        });
        const version = parseGeminiVersionOutput(stdout ?? "");
        if (!version) throw new Error("unrecognized version output");
        this.deps.providerCliVersions.gemini = version;
        this.deps.postProviderState();
        return version;
      } catch (error) {
        this.deps.host.appendLine(`gemini --version failed: ${(error as Error).message}`);
        this.deps.postProviderState();
        return "";
      }
    })();
    return this.geminiVersionProbe;
  }

  public async checkGrokUpdate(): Promise<void> {
    const connected = this.deps.connectedProviders();
    if (connected.includes("codex")) void this.probeCodexVersion();
    if (!connected.includes("grok")) return;
    const cliPath = this.deps.locateProvider("grok");
    if (!cliPath) {
      this.deps.postGrokUpdateStatus({ type: "grokUpdateStatus", error: "grok CLI not found" });
      return;
    }
    const policy = grokUpdatePolicy(await this.deps.readGrokVersion(cliPath), process.platform);
    try {
      const { stdout } = await execGrokCli(cliPath, ["update", "--check", "--json"], { timeout: 30_000 });
      const info = JSON.parse(stdout) as {
        currentVersion?: string;
        latestVersion?: string;
        updateAvailable?: boolean;
      };
      this.deps.postGrokUpdateStatus({
        type: "grokUpdateStatus",
        current: info.currentVersion ?? null,
        latest: info.latestVersion ?? null,
        updateAvailable: !!info.updateAvailable,
        policy,
      });
    } catch (e) {
      this.deps.host.appendLine(`grok update --check failed: ${(e as Error).message}`);
      this.deps.postGrokUpdateStatus({ type: "grokUpdateStatus", error: (e as Error).message, policy });
    }
  }

  public async updateGrokCliOnDemand(): Promise<void> {
    const cliPath = this.deps.locateProvider("grok");
    if (!cliPath) {
      this.deps.post({ type: "onboarding", state: "missing-cli", platform: process.platform, provider: "grok" });
      return;
    }
    const policy = grokUpdatePolicy(await this.deps.readGrokVersion(cliPath), process.platform);
    if (!policy.allow) {
      void this.deps.host.showInformationMessage(
        policy.note ?? "Grok CLI updates are paused for compatibility.",
      );
      return;
    }
    const updateArgs = policy.target ? ["update", "--version", policy.target] : ["update"];
    const busy = [...this.deps.getPool()].filter(
      (s) => s.status === "working" || s.status === "needs-you",
    ).length;
    if (busy > 0) {
      const choice = await this.deps.host.showWarningMessage(
        `Updating the Grok Build CLI will stop ${busy} session${busy === 1 ? "" : "s"} currently in progress. Continue?`,
        { modal: true },
        "Update Anyway",
      );
      if (choice !== "Update Anyway") return;
    }
    const focused = this.deps.getFocused();
    const resumeId = focused.activeSessionId;
    const resumeCwd = focused.cwd;
    const resumeWorktree = focused.worktree;

    const nextFocused = this.deps.newLocalSession();
    nextFocused.cwd = resumeCwd;
    nextFocused.worktree = resumeWorktree;
    this.deps.setFocused(nextFocused);
    this.deps.post({ type: "clearMessages" });
    this.deps.post({ type: "cliUpdating" });
    await this.deps.disposePool();
    await this.runGrokUpdate(cliPath, updateArgs);
    await this.deps.startSession(resumeId);
  }

  public async runGrokUpdate(
    cliPath: string,
    updateArgs: string[],
    notifyFailure = true,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout, stderr } = await execGrokCli(cliPath, updateArgs, { timeout: 180_000 });
        if (stdout?.trim()) this.deps.host.appendLine(stdout.trim());
        if (stderr?.trim()) this.deps.host.appendLine(stderr.trim());
        return true;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 0 && isLockedBinaryError(msg)) {
          this.deps.host.appendLine("grok update hit a locked binary; pausing then retrying once…");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        this.deps.host.appendLine(`grok update failed: ${msg}`);
        if (notifyFailure) {
          void this.deps.host.showWarningMessage(`Grok Build update failed: ${msg}`);
        }
        return false;
      }
    }
    return false;
  }


public probeProviderVersion(provider: AcpProvider): Promise<string> {
    const override = this.deps.getOverride?.<typeof this.probeProviderVersion>("probeProviderVersion");
    if (override) return override(provider);

    if (!this.deps.sidebarOps.hasProviderConsent(provider)) return Promise.resolve("");
    const probe = PROVIDER_CLI[provider].versionProbe;
    if (probe === "probeGrokVersion") return this.probeGrokVersion();
    return this.deps.sidebarOps[probe]();
  }

  grokVersionProbe?: Promise<string>;

  private probeGrokVersion(): Promise<string> {
    if (this.grokVersionProbe) return this.grokVersionProbe;
    this.grokVersionProbe = (async () => {
      const cliPath = this.deps.sidebarOps.locateProvider("grok");
      if (!cliPath) return "";
      const output = await this.deps.sidebarOps.readGrokVersion(cliPath);
      this.deps.sidebarOps.postProviderState();
      return this.deps.sidebarOps.providerCliVersions.grok ?? output;
    })();
    return this.grokVersionProbe;
  }
}

export function createCliUpdateHost(deps: CliUpdateHostDeps): CliUpdateHost {
  return new CliUpdateHost(deps);
}
