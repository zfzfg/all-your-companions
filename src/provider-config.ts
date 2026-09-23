/**
 * Each provider CLI's own global config file, listed beside the AP-04 rule
 * files so it can be opened (or created) in an editor tab.
 *
 * Ported from upstream (27a01d8, b83f62c, 6cb33e3) with one difference: the
 * upstream editor lives in the desktop file panel and writes through the
 * remote-file layer, which this fork does not have. In VS Code the file simply
 * opens as a normal editor tab, so VS Code owns saving and conflict handling.
 *
 * The DIRECTORY must be the one the CLI itself reads — `GROK_HOME` and
 * `CODEX_HOME` both move it — or an edit lands in a file nothing reads.
 * Pure apart from the resolvers it calls; no fs writes here.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AcpProvider } from "./acp-backend";
import { resolveCodexHome } from "./codex-cli-locator";
import { antigravitySettingsPaths } from "./gemini-cli-locator";
import { GLOBAL_CONFIG_STUB } from "./grok-config";
import type { RuleFile } from "./rules-files";
import { resolveGrokHome } from "./sessions";

/** A rule-file row that is a provider's config, with what to create it as. */
export interface ProviderConfigFile extends RuleFile {
  config: true;
  stub: string;
}

function userHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
}

export function providerConfigFiles(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ProviderConfigFile[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home = userHome(env, platform);
  const row = (provider: AcpProvider, filePath: string, label: string, stub: string): ProviderConfigFile => ({
    path: filePath, label, scope: "global", kind: "file", providers: [provider], exists: false, config: true, stub,
  });
  return [
    row("grok", paths.join(resolveGrokHome(env, platform), "config.toml"), "Grok config (config.toml)", GLOBAL_CONFIG_STUB),
    row("codex", paths.join(resolveCodexHome(env, platform), "config.toml"), "Codex config (config.toml)", ""),
    row("claude", paths.join(home, ".claude", "settings.json"), "Claude settings (settings.json)", "{}\n"),
    row("gemini", antigravitySettingsPaths(home, env)[0], "Antigravity settings (settings.json)", "{}\n"),
  ];
}
