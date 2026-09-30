/** CLI/storage policy. Specialized locators and parsers remain authoritative. */
import * as os from "node:os";
import * as path from "node:path";
import type { AcpProvider } from "./acp-backend";
import { locateGrokCli } from "./cli-locator";
import { locateCodexCli, resolveCodexHome } from "./codex-cli-locator";
import { locateClaudeCli } from "./claude-cli-locator";
import { isAntigravityCli, locateGeminiCli } from "./gemini-cli-locator";
import { locateMuseCli } from "./muse-cli-locator";
import { resolveGrokHome } from "./sessions";
import { CODEX_MANAGED_VERSION } from "./codex-managed-installer";

export interface ProviderCliPolicy {
  readonly cacheKey: "cliPath" | "codexCliPath" | "claudeCliPath" | "geminiCliPath" | "museCliPath";
  readonly versionProbe: "probeGrokVersion" | "probeCodexVersion" | "probeClaudeVersion" | "probeGeminiVersion" | "probeMuseVersion";
  readonly credentialProbe: "native" | "warmConnectedCodexModels" | "warmConnectedClaudeModels" | "warmConnectedGeminiModels" | "unavailable";
  readonly environment: "grok" | "inherited";
  readonly loginArgs: string[];
  readonly logoutArgs: string[];
  interactiveLogout?(cliPath: string): string | undefined;
  readonly update?: { provider: "codex" | "claude"; packageName: string; managed: boolean; targetVersion?: string };
  locate(options: { configuredPath: string; managedStorageRoot: string; arch: string }): string | undefined;
  credentialFiles(): readonly string[];
}

export const PROVIDER_CLI: Record<AcpProvider, ProviderCliPolicy> = {
  grok: {
    cacheKey: "cliPath", versionProbe: "probeGrokVersion", credentialProbe: "native", environment: "grok", loginArgs: ["login"], logoutArgs: ["logout"],
    locate: ({ configuredPath }) => locateGrokCli(configuredPath) || undefined,
    credentialFiles: () => [path.join(resolveGrokHome(process.env), "auth.json")],
  },
  codex: {
    cacheKey: "codexCliPath", versionProbe: "probeCodexVersion", credentialProbe: "warmConnectedCodexModels", environment: "inherited", loginArgs: ["login"], logoutArgs: ["logout"],
    update: { provider: "codex", packageName: "@openai/codex", managed: true, targetVersion: CODEX_MANAGED_VERSION },
    locate: (options) => locateCodexCli(options),
    credentialFiles: () => [path.join(resolveCodexHome(), "auth.json")],
  },
  claude: {
    cacheKey: "claudeCliPath", versionProbe: "probeClaudeVersion", credentialProbe: "warmConnectedClaudeModels", environment: "inherited", loginArgs: ["auth", "login"], logoutArgs: ["auth", "logout"],
    update: { provider: "claude", packageName: "@anthropic-ai/claude-code", managed: false },
    locate: (options) => locateClaudeCli(options),
    credentialFiles: () => [], // Claude's keychain cannot be inferred from a file.
  },
  gemini: {
    // Both Gemini CLI and Antigravity sign in from their interactive startup.
    cacheKey: "geminiCliPath", versionProbe: "probeGeminiVersion", credentialProbe: "warmConnectedGeminiModels", environment: "inherited", loginArgs: [], logoutArgs: ["auth", "logout"],
    interactiveLogout: (cliPath) => isAntigravityCli(cliPath) ? "/logout" : undefined,
    locate: (options) => locateGeminiCli(options), // Gemini CLI and Antigravity use the same locator.
    credentialFiles: () => {
      const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
      return [path.join(home, ".gemini", "oauth.json"), path.join(home, ".gemini", "settings.json")];
    },
  },
  muse: {
    cacheKey: "museCliPath", versionProbe: "probeMuseVersion", credentialProbe: "unavailable", environment: "inherited", loginArgs: ["login"], logoutArgs: ["logout"],
    locate: (options) => locateMuseCli(options),
    credentialFiles: () => [path.join(os.homedir(), ".config", "muse", "auth.json")],
  },
};
