/**
 * Shared workspace-authorization predicates.
 *
 * Authorization is recomputed from a host-supplied set of authorized session
 * cwds (open folders + their worktrees on desktop; full catalog on VS Code).
 * Callers must also **revoke** on close (end sessions, release remote
 * ownership, drop image handles) — filtering the catalog alone is not enough.
 *
 * Pure: no vscode, no process spawn, injectable equality.
 */

import * as path from "node:path";
import { pathIsInside, pathsEqual } from "./worktree";

/** True when `cwd` is exactly one of the currently authorized session roots. */
export function cwdIsAuthorized(
  cwd: string | undefined,
  authorizedCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean = pathsEqual,
): boolean {
  if (!cwd || typeof cwd !== "string") return false;
  if (!authorizedCwds.length) return false;
  return authorizedCwds.some((root) => sameCwd(cwd, root));
}

/**
 * History/list cwd a builder may scan for a recipient. Returns the cwd only when
 * it is in the **current** authorized set; otherwise `undefined` so the builder
 * emits an empty list instead of trusting stale per-tab state after a close.
 */
export function authorizedListCwd(
  cwd: string | undefined,
  authorizedCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean = pathsEqual,
): string | undefined {
  return cwdIsAuthorized(cwd, authorizedCwds, sameCwd) ? cwd : undefined;
}

/**
 * Keep only entries whose `cwd` is currently authorized. Used for pinned lists
 * and any multi-repo fan-out that must not surface closed projects.
 */
export function filterEntriesByAuthorizedCwd<T extends { cwd?: string }>(
  entries: readonly T[],
  authorizedCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean = pathsEqual,
): T[] {
  return entries.filter((e) => cwdIsAuthorized(e.cwd, authorizedCwds, sameCwd));
}

/**
 * True when `filePath` is the closed folder or lives under it (segment-safe).
 * Used to revoke image handles and decide whether a session is bound to a
 * folder being closed.
 */
export function pathBoundToClosedFolder(
  filePath: string | undefined,
  closedFolder: string,
  sameCwd: (a: string, b: string) => boolean = pathsEqual,
): boolean {
  if (!filePath || typeof filePath !== "string" || !closedFolder) return false;
  return sameCwd(filePath, closedFolder) || pathIsInside(filePath, closedFolder);
}

/**
 * Whether a live session (by process cwd / worktree binding) is tied to a
 * folder that is being closed and must therefore be torn down.
 */
export function sessionBoundToClosedFolder(
  sessionCwd: string | undefined,
  worktreePath: string | undefined,
  sourceGitRoot: string | undefined,
  closedFolder: string,
  sameCwd: (a: string, b: string) => boolean = pathsEqual,
): boolean {
  if (pathBoundToClosedFolder(sessionCwd, closedFolder, sameCwd)) return true;
  if (pathBoundToClosedFolder(worktreePath, closedFolder, sameCwd)) return true;
  if (sourceGitRoot && sameCwd(sourceGitRoot, closedFolder)) return true;
  return false;
}

/** Handles whose paths sit under a just-closed folder. */
export function imageHandlesToRevoke(
  handleToPath: Iterable<readonly [string, string]>,
  closedFolder: string,
  sameCwd: (a: string, b: string) => boolean = pathsEqual,
): string[] {
  const out: string[] = [];
  for (const [handle, imagePath] of handleToPath) {
    if (pathBoundToClosedFolder(imagePath, closedFolder, sameCwd)) out.push(handle);
  }
  return out;
}

/**
 * Re-check an image path at fetch time: must still live under an authorized
 * root, or be Grok session media whose catalog cwd remains authorized.
 */
export function imagePathStillAuthorized(
  imagePath: string,
  authorizedCwds: readonly string[],
  opts?: {
    grokHome?: string;
    sameCwd?: (a: string, b: string) => boolean;
    /** When set, session-dir media under grokHome is allowed only if this returns true for the decoded catalog cwd. */
    isTrustedGeneratedMedia?: (p: string) => boolean;
  },
): boolean {
  const same = opts?.sameCwd ?? pathsEqual;
  if (!imagePath) return false;
  for (const root of authorizedCwds) {
    if (pathBoundToClosedFolder(imagePath, root, same)) return true;
  }
  const home = opts?.grokHome;
  if (home && opts?.isTrustedGeneratedMedia?.(imagePath)) {
    const sessCwd = sessionCwdFromGrokMediaPath(imagePath, home);
    if (sessCwd && cwdIsAuthorized(sessCwd, authorizedCwds, same)) return true;
  }
  return false;
}

/**
 * Decode `<grokHome>/sessions/<urlencoded-cwd>/…` back to the catalog cwd.
 * Returns undefined when the path is not under the sessions root.
 */
export function sessionCwdFromGrokMediaPath(
  imagePath: string,
  grokHome: string,
): string | undefined {
  if (!imagePath || !grokHome) return undefined;
  const sessionsRoot = path.join(path.resolve(grokHome), "sessions");
  const abs = path.resolve(imagePath);
  if (!pathIsInside(abs, sessionsRoot) && !pathsEqual(abs, sessionsRoot)) {
    // Allow equality only for the root itself (never a media path).
    return undefined;
  }
  if (pathsEqual(abs, sessionsRoot)) return undefined;
  const rel = path.relative(sessionsRoot, abs);
  if (!rel || rel.startsWith("..")) return undefined;
  const encoded = rel.split(path.sep)[0];
  if (!encoded) return undefined;
  try {
    const cwd = decodeURIComponent(encoded).trim();
    return cwd && path.isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}
