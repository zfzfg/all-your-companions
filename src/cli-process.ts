import { execFile, type ExecFileOptions } from "node:child_process";

/** Windows command shims are scripts, not directly executable binaries. */
export function grokCliNeedsShell(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
}

export type GrokCliExecOptions = Pick<
  ExecFileOptions,
  "cwd" | "env" | "timeout" | "windowsHide"
>;

/**
 * Run a one-shot grok CLI command through the same Windows-shim policy as the
 * long-lived ACP process. All version, update-check, and update calls use this
 * wrapper so a resolved grok.cmd/grok.bat keeps working everywhere.
 */
export function execGrokCli(
  cliPath: string,
  args: readonly string[],
  options: GrokCliExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath,
      [...args],
      {
        ...options,
        encoding: "utf8",
        shell: grokCliNeedsShell(cliPath),
        windowsHide: options.windowsHide ?? true,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Run a fast, synchronous `--version` probe against a CLI executable to record
 * its version stamp in logs alongside adapter pins.
 */
export function probeCliVersion(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 3000,
): string | undefined {
  if (!cliPath) return undefined;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(cliPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      shell: grokCliNeedsShell(cliPath, platform),
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
