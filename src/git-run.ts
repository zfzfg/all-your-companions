/**
 * The process seam for the Changes view. Everything it decides lives in
 * `src/git-status.ts`; this file only runs what that one planned.
 *
 * Kept out of sidebar.ts for the same reason `git-clone.ts` is: sidebar holds
 * no bare `execFile`, because every one-shot *grok* invocation has to go
 * through `execGrokCli`'s Windows-shim policy and a test enforces that by
 * banning the call shape. `git` is a real binary with no `.cmd` shim, so it
 * wants an explicit boundary of its own rather than that wrapper.
 *
 * Four environment settings apply to every call here and each is load-bearing:
 *
 * - `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` — the difference
 *   between a reported failure and a hang. A push needing credentials
 *   otherwise blocks on a terminal that does not exist, or pops a Windows
 *   credential dialog on a machine nobody is sitting at.
 * - `GIT_OPTIONAL_LOCKS=0` on the read paths — `git status` normally refreshes
 *   the index, which takes `index.lock`. The agent is often running git in the
 *   same repository at the same time, and a status refresh is never worth
 *   making its commit fail.
 * - `LC_ALL=C` — {@link describeGitFailure} matches English. Without this it
 *   silently stops recognising anything on a localised machine.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GIT_NUMSTAT_ARGS,
  GIT_REMOTE_ARGS,
  GIT_STATUS_ARGS,
  GIT_TURN_BASELINE_ARGS,
  GIT_HEAD_ARGS,
  buildGitStatusSnapshot,
  gitDiffArgs,
  gitDiffUntrackedArgs,
  gitTurnDiffArgs,
  gitUnpushedArgs,
  parseGitNumstatZ,
  parseGitBaseline,
  parseGitStatusPorcelain2,
  parseUnpushedLog,
  type GitOpPlan,
  type GitStatusSnapshot,
} from "./git-status";

/** Injected process seam. Matches the one shape this module uses. */
export interface GitIo {
  execFile: typeof nodeExecFile;
}

const REAL_IO: GitIo = { execFile: nodeExecFile };

/** Reads: long enough for a cold disk, short enough not to look wedged. */
export const GIT_READ_TIMEOUT_MS = 20_000;
/** Writes: a push over a slow line, or a repository with heavy hooks. */
export const GIT_WRITE_TIMEOUT_MS = 180_000;
/** A patch past this is cut; the view says so rather than rendering silence. */
export const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const GIT_BASELINE_TIMEOUT_MS = 5_000;
// At most 128 paths, and 1 MiB per file (128 MiB worst case).
//
// The two caps answer differently ON PURPOSE. Hundreds of untracked paths mean
// an unignored build directory, where snapshotting an arbitrary 128 of them
// buys nothing -- so the whole map is dropped and every path keeps the old
// behaviour. One oversized file among small ones is ordinary (an archive, a
// screenshot, a core dump), and dropping the map there would reinstate #168's
// whole-file diff for the small files too. So that file alone is skipped: a
// path absent from the map already means "fall through", which is exactly
// right for it.
export const GIT_BASELINE_UNTRACKED_MAX_PATHS = 128;
export const GIT_BASELINE_UNTRACKED_MAX_FILE_BYTES = 1024 * 1024;

export interface GitExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** The command could not start at all — usually git is not installed. */
  spawnFailed?: boolean;
}

function gitEnv(base: NodeJS.ProcessEnv, readOnly: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
  if (readOnly) env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** Run one `git` in `root`. Never rejects — every caller classifies instead. */
export function runGit(
  root: string,
  args: readonly string[],
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv; timeoutMs?: number; readOnly?: boolean; maxBytes?: number; stdin?: string },
): Promise<GitExecResult> {
  const io = opts?.io ?? REAL_IO;
  const readOnly = opts?.readOnly !== false;
  return new Promise((resolve) => {
    let inputError: Error | undefined;
    try {
      const child = io.execFile(
        "git",
        ["-C", root, ...args],
        {
          env: gitEnv(opts?.env ?? process.env, readOnly),
          timeout: opts?.timeoutMs ?? (readOnly ? GIT_READ_TIMEOUT_MS : GIT_WRITE_TIMEOUT_MS),
          windowsHide: true,
          maxBuffer: opts?.maxBytes ?? 8 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          error ??= inputError ?? null;
          const out = String(stdout ?? "");
          const err = String(stderr ?? "");
          if (!error) {
            resolve({ ok: true, code: 0, stdout: out, stderr: err });
            return;
          }
          const anyError = error as NodeJS.ErrnoException & { code?: number | string };
          // ENOENT means no git on PATH; a numeric code is git's own exit.
          const spawnFailed = anyError.code === "ENOENT";
          const code = typeof anyError.code === "number" ? anyError.code : spawnFailed ? -1 : 1;
          resolve({
            ok: false,
            code,
            stdout: out,
            stderr: err || String(error.message || ""),
            ...(spawnFailed ? { spawnFailed: true } : {}),
          });
        },
      );
      if (opts?.stdin !== undefined) {
        // Git may exit before consuming the list (e.g. an unreadable file).
        // Drain the child's result as usual, but never let EPIPE escape or
        // turn a failed stdin write into a successful partial baseline.
        child.stdin!.on("error", (error: Error) => { inputError = error; });
        child.stdin!.end(opts.stdin);
      }
    } catch (e: unknown) {
      resolve({
        ok: false,
        code: -1,
        stdout: "",
        stderr: String((e as Error)?.message ?? e),
        spawnFailed: true,
      });
    }
  });
}

const NOT_A_REPO = /not a git repository|does not appear to be a git repository/i;

export type GitStatusRead =
  | { ok: true; snapshot: GitStatusSnapshot }
  | { ok: false; reason: string; kind: "no-git" | "not-a-repo" | "failed" };

/**
 * Read everything the Changes view shows, in as few calls as the answers need.
 *
 * The status call runs first and alone because its result decides whether the
 * others are even askable: an unborn repository has no HEAD to diff against,
 * and a branch with no upstream has to ask a different question about which
 * commits are unpushed. The remaining three run together.
 *
 * There is deliberately no `git fetch` here. Fetching is a network call on a
 * path a person is waiting on, it can hang on credentials, and the number it
 * refreshes — how far behind the remote is — is not one the view needs to be
 * correct to answer "is my work safe". `behind` is reported as of the last
 * fetch, and the view says so.
 */
export async function readGitStatus(
  root: string,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv },
): Promise<GitStatusRead> {
  const status = await runGit(root, GIT_STATUS_ARGS, opts);
  if (!status.ok) {
    if (status.spawnFailed) return { ok: false, reason: "Git is not installed on this machine.", kind: "no-git" };
    if (NOT_A_REPO.test(status.stderr)) {
      return { ok: false, reason: "This project is not a git repository.", kind: "not-a-repo" };
    }
    return { ok: false, reason: firstLine(status.stderr) || "git status failed.", kind: "failed" };
  }
  const parsed = parseGitStatusPorcelain2(status.stdout);

  const [numstat, unpushed, remotes] = await Promise.all([
    // An unborn repository has no HEAD, so `diff HEAD` is an error rather than
    // an empty diff. Every file is new there anyway.
    parsed.headers.unborn
      ? Promise.resolve(null)
      : runGit(root, GIT_NUMSTAT_ARGS, opts),
    parsed.headers.unborn
      ? Promise.resolve(null)
      : runGit(root, gitUnpushedArgs(parsed.headers.upstream), opts),
    runGit(root, GIT_REMOTE_ARGS, opts),
  ]);

  return {
    ok: true,
    snapshot: buildGitStatusSnapshot({
      status: parsed,
      numstat: numstat && numstat.ok ? parseGitNumstatZ(numstat.stdout) : undefined,
      unpushed: unpushed && unpushed.ok ? parseUnpushedLog(unpushed.stdout) : undefined,
      hasRemote: !!(remotes && remotes.ok && remotes.stdout.trim()),
    }),
  };
}

export type GitDiffRead =
  | { ok: true; patch: string; truncated: boolean; untracked: boolean }
  | { ok: false; reason: string };

export interface GitTurnBaseline {
  sha: string;
  untracked?: Map<string, string>;
}

/** Caller holds GitRunGate. Never waits on the prompt path or updates refs. */
export async function captureGitTurnBaseline(
  root: string,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv },
): Promise<GitTurnBaseline | undefined> {
  const options = { ...opts, timeoutMs: GIT_BASELINE_TIMEOUT_MS };
  // Capture the immutable HEAD before stash, never resolve a moving ref at click.
  const head = await runGit(root, GIT_HEAD_ARGS, options);
  const headSha = head.ok ? parseGitBaseline(head.stdout) : undefined;
  if (!headSha) return undefined; // includes an unborn / non-git directory
  const stash = await runGit(root, GIT_TURN_BASELINE_ARGS, options);
  if (!stash.ok) return undefined;
  const sha = stash.stdout.trim() ? parseGitBaseline(stash.stdout) : headSha;
  if (!sha) return undefined;

  // `stash create` snapshots tracked content only and has no -u option.
  // Preserve pre-existing untracked content as loose blobs, without touching
  // the index or refs. Ignored build output must never reach hash-object.
  const listed = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"], options);
  if (!listed.ok) return { sha };
  const paths = listed.stdout.split("\0").filter(Boolean);
  if (paths.length > GIT_BASELINE_UNTRACKED_MAX_PATHS) return { sha };
  const survivors: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(join(root, path));
      if (!info.isFile()) continue;
      if (info.size > GIT_BASELINE_UNTRACKED_MAX_FILE_BYTES) continue;
      survivors.push(path);
    } catch {
      // A disappeared or unreadable candidate is not a file we can snapshot.
    }
  }
  if (!survivors.length) return { sha };
  // --stdin-paths is line-delimited, not NUL-delimited. Git accepts C-quoted
  // filenames here; octal escapes keep quotes, backslashes and newlines literal.
  const stdin = survivors.map(path => '"' + path.replace(/["\\\x00-\x1f\x7f]/g,
    char => "\\" + char.charCodeAt(0).toString(8).padStart(3, "0")) + '"\n').join("");
  const hashed = await runGit(root, ["hash-object", "-w", "--stdin-paths"], { ...options, stdin });
  if (!hashed.ok) return { sha };
  const blobs = hashed.stdout.trim().split(/\r?\n/).map(parseGitBaseline);
  // No partial map on a failed or malformed batch: positional pairing is only
  // trustworthy when every input has exactly one complete object id.
  if (blobs.length !== survivors.length || blobs.some(blob => !blob)) return { sha };
  return { sha, untracked: new Map(survivors.map((path, i) => [path, blobs[i]!])) };
}

/**
 * One file's diff against a host-owned baseline (the last commit by default).
 *
 * The path is checked against the snapshot by the caller, not here — this
 * function is given a path the repository is already reporting as changed.
 *
 * `--no-index` for an untracked file exits 1 when the files differ, which for
 * a new file is always. A non-zero exit with a patch on stdout is therefore
 * the SUCCESS case, and treating it as failure is the obvious way to get this
 * wrong.
 */
export async function readGitFileDiff(
  root: string,
  path: string,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv; untracked?: boolean; baseline?: string; baselineBlob?: string },
): Promise<GitDiffRead> {
  let args: string[];
  if (opts?.baselineBlob) {
    // hash-object takes literal filenames, not pathspecs; -- only terminates
    // options. -w is required so the following blob diff can read the object.
    const current = await runGit(root, ["hash-object", "-w", "--", path], opts);
    const blob = current.ok ? parseGitBaseline(current.stdout) : undefined;
    if (!blob) {
      return { ok: false, reason: current.spawnFailed ? "Git is not installed on this machine."
        : firstLine(current.stderr) || "Could not read the diff." };
    }
    args = ["diff", opts.baselineBlob, blob];
  } else {
    args = opts?.untracked ? gitDiffUntrackedArgs(path)
      : opts?.baseline ? gitTurnDiffArgs(path, opts.baseline) : gitDiffArgs(path);
  }
  const result = await runGit(root, args, { ...opts, maxBytes: GIT_DIFF_MAX_BYTES + 1024 });
  const hasPatch = result.stdout.length > 0;
  if (!result.ok && !hasPatch) {
    if (result.spawnFailed) return { ok: false, reason: "Git is not installed on this machine." };
    return { ok: false, reason: firstLine(result.stderr) || "Could not read the diff." };
  }
  const truncated = result.stdout.length > GIT_DIFF_MAX_BYTES;
  return {
    ok: true,
    patch: truncated ? result.stdout.slice(0, GIT_DIFF_MAX_BYTES) : result.stdout,
    truncated,
    untracked: !!opts?.untracked,
  };
}

/** Whole before-side text for a host-local turn diff; never derived from a capped patch. */
export async function readGitTurnFileBefore(
  root: string,
  path: string,
  baseline: GitTurnBaseline,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv },
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const fail = (result: GitExecResult) => ({
    ok: false as const,
    reason: result.spawnFailed ? "Git is not installed on this machine."
      : firstLine(result.stderr) || "Could not read this file's turn baseline.",
  });
  const blob = baseline.untracked?.get(path);
  if (!blob) {
    // A failed `show sha:path` cannot distinguish a new file from a broken
    // baseline without parsing prose. ls-tree's successful empty listing can;
    // a non-zero exit (even with stdout) or diagnostic must never mean empty.
    const entry = await runGit(root, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", baseline.sha, "--", path], opts);
    if (!entry.ok || entry.stderr) return fail(entry);
    if (!entry.stdout) return { ok: true, text: "" };
  }
  // <rev>:<path> names one object, not a pathspec (gitrevisions). Brackets and
  // wildcard characters are literal here, unlike ls-tree's path operand above.
  const result = await runGit(root, blob
    ? ["cat-file", "blob", blob] : ["show", `${baseline.sha}:${path}`], opts);
  // Unlike --no-index diff, these reads require exit 0: partial stdout on a
  // timeout/buffer failure is not a whole file and must not reach the editor.
  if (!result.ok) return fail(result);
  return { ok: true, text: result.stdout };
}

export interface GitRunOutcome {
  ok: boolean;
  /** Index of the step that failed, or -1 when every step succeeded. */
  failedStep: number;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a plan's steps in order, stopping at the first required failure.
 *
 * Stopping matters more than it looks: a commit that fails must not be
 * followed by the push it was paired with, or "Commit and push" reports a
 * push error for a commit that never happened.
 */
export async function runGitPlan(
  root: string,
  plan: GitOpPlan,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv },
): Promise<GitRunOutcome> {
  const chunks: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const result = await runGit(root, step.args, { ...opts, readOnly: false });
    if (result.stdout) chunks.push(result.stdout);
    if (result.stderr) errors.push(result.stderr);
    if (!result.ok && step.required) {
      return {
        ok: false,
        failedStep: i,
        code: result.code,
        stdout: chunks.join("\n"),
        stderr: errors.join("\n"),
      };
    }
  }
  return { ok: true, failedStep: -1, code: 0, stdout: chunks.join("\n"), stderr: errors.join("\n") };
}

function firstLine(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const line = trimmed.split(/\r?\n/).find((entry) => entry.trim().length > 0) || "";
  return line.replace(/^fatal:\s*/i, "").trim();
}

/**
 * Serialise runs per repository.
 *
 * Two commits at once on one checkout is not a race worth surviving — the
 * second would stage what the first is committing. A remote pressing Run twice
 * is refused with a sentence rather than queued, because by the time a queued
 * second commit ran, the message on screen would describe a tree that no
 * longer exists.
 */
export class GitRunGate {
  private readonly busy = new Set<string>();

  tryAcquire(root: string): boolean {
    const key = this.key(root);
    if (this.busy.has(key)) return false;
    this.busy.add(key);
    return true;
  }

  release(root: string): void {
    this.busy.delete(this.key(root));
  }

  isBusy(root: string): boolean {
    return this.busy.has(this.key(root));
  }

  private key(root: string): string {
    return process.platform === "win32" ? String(root || "").toLowerCase() : String(root || "");
  }
}
