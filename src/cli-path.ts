import { statSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

/**
 * Whether a PATH candidate is something we could actually spawn.
 *
 * A directory named like the binary is not a hit, and on POSIX a file without
 * an execute bit is not one either — returning it would only move the failure
 * from discovery to spawn, where it reads as "the CLI is broken".
 */
export function isCliFile(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/**
 * Find `name` on PATH without a shell, falling back to `where` / `command -v`.
 *
 * The in-process scan is what stops a console window flashing on Windows for
 * the common case; the shell fallback stays because a GUI host's PATH can miss
 * what a login shell would have found. Both are quiet — `windowsHide` and a
 * discarded stderr — so nothing flickers when the fallback does run.
 *
 * On Windows a bare name is expanded through PATHEXT. npm also drops the
 * extensionless POSIX script next to `grok.cmd`, and that file cannot be
 * launched there, so matching the bare name would hand back the wrong file.
 */
export function findCliOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (candidate: string) => boolean = (candidate) => isCliFile(candidate, platform),
): string | undefined {
  const win = platform === "win32";
  const paths = win ? path.win32 : path.posix;
  // Windows env keys are case-insensitive (Path, PATHEXT, PathExt all occur).
  const pathKey = win ? Object.keys(env).find((key) => key.toLowerCase() === "path") : "PATH";
  const pathExtKey = Object.keys(env).find((key) => key.toLowerCase() === "pathext");
  const names = win && !paths.extname(name)
    ? (env[pathExtKey ?? "PATHEXT"] || ".COM;.EXE;.BAT;.CMD")
      .split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."))
      .map((ext) => `${name}${ext}`)
    : [name];
  for (const entry of (env[pathKey ?? "PATH"] || "").split(win ? ";" : ":")) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = paths.join(dir, candidateName);
      try {
        if (isFile(candidate)) return candidate;
      } catch { /* A removed or inaccessible PATH entry must not stop discovery. */ }
    }
  }
  try {
    const command = win ? `where ${name}` : `command -v ${name}`;
    const found = execSync(command, {
      encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0]?.trim();
    return found && isFile(found) ? found : undefined;
  } catch {
    return undefined;
  }
}
