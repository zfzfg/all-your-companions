/**
 * Local git worktree lifecycle (AP-13a) — create, list, apply, remove without
 * a Grok CLI.
 *
 * The Grok RPCs (`_x.ai/git/worktree/*`) are the proven path and they know a
 * clone mode that `git worktree add` does not. This module is the other source
 * for the SAME {@link WorktreeRecord} shape: when no Grok session is already
 * running, the host talks to git itself so a Claude / Codex / Gemini session
 * can still isolate its edits. Decision 18.8 is load-bearing here — the local
 * path can only produce linked worktrees, and it says so (`creationMode:
 * "linked"`) rather than pretending a clone happened.
 *
 * Apply is not `git merge`. The source checkout may be dirty, and a merge
 * would touch work that is not ours. Each file goes through
 * {@link decideLocalApplyFile}: if the source file still matches the
 * merge-base it is safe to take the worktree's bytes; if it already matches
 * the worktree there is nothing to do; anything else is a foreign change and
 * a conflict, never a silent write. That is the same rule as
 * {@link planEditRevert} / AP-08 restore, applied to whole files.
 *
 * Recipe R7: no `vscode`. Time, path-join, git and the filesystem are
 * injected so no test ever starts a real `git` binary (the suite is
 * binary-free, and that includes git). Spawn is `execFile` without
 * `shell: true` — under Windows that flag is both DEP0190 and the injection
 * surface (Erkenntnis 2).
 */

import { execFile as nodeExecFile } from "node:child_process";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import {
  parseGitWorktreeList,
  pathsEqual,
  sanitizeWorktreeLabel,
  type WorktreeApplyFile,
  type WorktreeApplyResult,
  type WorktreeCreateResult,
  type WorktreeRecord,
  type WorktreeRemoveResult,
} from "./worktree";

/** Injected, so no test ever starts a real `git`. Same shape as AgentRunFs. */
export interface GitRunner {
  run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Same as {@link run}, but stdout is raw bytes. Apply copies file contents
   * through this so a binary is not round-tripped as UTF-8.
   */
  runBytes(args: string[], cwd: string): Promise<{ code: number; stdout: Uint8Array; stderr: string }>;
}

export interface WorktreeLocalFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  writeFileSync(p: string, data: Uint8Array): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
  unlinkSync(p: string): void;
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
}

export interface LocalWorktreeOpsOptions {
  git: GitRunner;
  fs: WorktreeLocalFs;
  /** Injected so the module has no clock of its own (recipe R7). */
  now?: () => number;
  /** Path join. Injected so tests can pin POSIX separators on Windows. */
  join?: (...parts: string[]) => string;
  dirname?: (p: string) => string;
  basename?: (p: string) => string;
  log?: (msg: string) => void;
}

export type LocalApplyConflict = {
  error: string;
  conflicts: string[];
};

export interface LocalWorktreeOps {
  create(o: { sourcePath: string; label?: string; root: string }): Promise<WorktreeCreateResult | { error: string }>;
  list(sourcePath: string): Promise<WorktreeRecord[]>;
  apply(o: {
    worktreePath: string;
    sourceGitRoot: string;
    /** When true, conflicting files are overwritten. Default is refuse. */
    overwrite?: boolean;
  }): Promise<WorktreeApplyResult | LocalApplyConflict | { error: string }>;
  remove(o: { worktreePath: string; force: boolean }): Promise<WorktreeRemoveResult | { error: string }>;
}

export type LocalApplyDecision = "write" | "delete" | "skip" | "conflict";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const DEFAULT_TIMEOUT_MS = 30_000;
const BRANCH_PREFIX = "companions/";

function defaultJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Per-file apply decision. Whole-file bytes, not a patch: apply copies the
 * worktree's contents, it does not merge.
 *
 * - current == worktree → already applied, skip
 * - current == base     → source still at the branch point, take the worktree
 * - anything else       → foreign change, conflict. Never a silent write.
 */
export function decideLocalApplyFile(input: {
  base: Uint8Array | null;
  worktree: Uint8Array | null;
  current: Uint8Array | null;
}): LocalApplyDecision {
  if (bytesEqual(input.current, input.worktree)) return "skip";
  if (bytesEqual(input.current, input.base)) {
    return input.worktree === null ? "delete" : "write";
  }
  return "conflict";
}

/**
 * Parse `git diff --name-status` into {@link WorktreeApplyFile} rows.
 * Additions/deletions stay 0 — name-status does not carry them, and inventing
 * a line count from a path would be a lie on the apply card.
 */
export function planLocalApply(nameStatus: string): WorktreeApplyFile[] {
  if (!nameStatus || typeof nameStatus !== "string") return [];
  const out: WorktreeApplyFile[] = [];
  const seen = new Set<string>();
  for (const rawLine of nameStatus.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const code = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    const kind = code.charAt(0).toUpperCase();
    if (!"AMDTRC".includes(kind)) continue;
    if (kind === "R" || kind === "C") {
      const parts = rest.split("\t");
      const from = (parts[0] ?? "").trim();
      const to = (parts[1] ?? parts[0] ?? "").trim();
      if (from && !seen.has(from)) {
        seen.add(from);
        out.push({ path: from, type: "deleted", additions: 0, deletions: 0 });
      }
      if (to && !seen.has(to)) {
        seen.add(to);
        out.push({ path: to, type: "added", additions: 0, deletions: 0 });
      }
      continue;
    }
    const filePath = rest.split("\t")[0]?.trim() ?? "";
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const type = kind === "A" ? "added" : kind === "D" ? "deleted" : "modified";
    out.push({ path: filePath, type, additions: 0, deletions: 0 });
  }
  return out;
}

function gitError(stderr: string, stdout: string, fallback: string): string {
  const text = (stderr || stdout || fallback).trim();
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? fallback;
  return first.slice(0, 400);
}

/**
 * Production {@link GitRunner}. `execFile` with an argv array, never a shell.
 * Tests inject a fake; this is what the host uses.
 */
export function nodeGitRunner(opts?: {
  execFile?: typeof nodeExecFile;
  timeoutMs?: number;
}): GitRunner {
  const run = opts?.execFile ?? nodeExecFile;
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, ...GIT_ENV };
  const spawn = (
    args: string[],
    cwd: string,
    encoding: "utf8" | "buffer",
  ): Promise<{ code: number; stdout: Buffer; stderr: string }> =>
    new Promise((resolve) => {
      try {
        run(
          "git",
          args,
          {
            cwd,
            timeout,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            encoding: encoding === "utf8" ? "utf8" : "buffer",
            env,
          } as any,
          (err, stdout, stderr) => {
            const code =
              err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === "number"
                ? (err as NodeJS.ErrnoException & { code: number }).code
                : err
                  ? 1
                  : 0;
            const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""), "utf8");
            const errText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
            resolve({ code, stdout: outBuf, stderr: errText });
          },
        );
      } catch (e: any) {
        resolve({ code: 1, stdout: Buffer.alloc(0), stderr: e?.message ?? String(e) });
      }
    });
  return {
    async run(args, cwd) {
      const r = await spawn(args, cwd, "utf8");
      return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
    },
    async runBytes(args, cwd) {
      const r = await spawn(args, cwd, "buffer");
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

export function nodeWorktreeFs(): WorktreeLocalFs {
  return {
    existsSync: (p) => nodeFs.existsSync(p),
    readFileSync: (p) => nodeFs.readFileSync(p),
    writeFileSync: (p, data) => nodeFs.writeFileSync(p, data),
    mkdirSync: (p, opts) => nodeFs.mkdirSync(p, opts),
    unlinkSync: (p) => nodeFs.unlinkSync(p),
    rmSync: (p, opts) => nodeFs.rmSync(p, opts),
  };
}

export class LocalGitWorktrees implements LocalWorktreeOps {
  private readonly git: GitRunner;
  private readonly fs: WorktreeLocalFs;
  private readonly now: () => number;
  private readonly join: (...parts: string[]) => string;
  private readonly dirname: (p: string) => string;
  private readonly basename: (p: string) => string;
  private readonly log: (msg: string) => void;

  constructor(opts: LocalWorktreeOpsOptions) {
    this.git = opts.git;
    this.fs = opts.fs;
    this.now = opts.now ?? (() => 0);
    this.join = opts.join ?? defaultJoin;
    this.dirname = opts.dirname ?? ((p) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") || p);
    this.basename = opts.basename ?? ((p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p);
    this.log = opts.log ?? (() => {});
  }

  private async gitText(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.git.run(args, cwd);
  }

  private async gitBytes(args: string[], cwd: string): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
    return this.git.runBytes(args, cwd);
  }

  /**
   * Repos with submodules, sparse-checkout or LFS are refused rather than
   * half-done: local `git worktree add` does not reproduce Grok's clone-mode
   * handling of those, and a half-copied checkout is worse than a clear no.
   */
  async inspectUnsupported(sourcePath: string): Promise<string | undefined> {
    const inside = await this.gitText(["rev-parse", "--is-inside-work-tree"], sourcePath);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return "not a git working tree";
    }
    const sparse = await this.gitText(["config", "--bool", "core.sparseCheckout"], sourcePath);
    if (sparse.code === 0 && sparse.stdout.trim() === "true") {
      return "sparse-checkout is enabled; the local worktree path does not copy sparse rules";
    }
    if (this.fs.existsSync(this.join(sourcePath, ".gitmodules"))) {
      return "submodules are present; the local worktree path does not initialise them";
    }
    const lfs = await this.gitText(["config", "--get", "filter.lfs.smudge"], sourcePath);
    if (lfs.code === 0 && lfs.stdout.trim()) {
      return "Git LFS is configured; the local worktree path does not fetch LFS objects";
    }
    return undefined;
  }

  async list(sourcePath: string): Promise<WorktreeRecord[]> {
    const r = await this.gitText(["worktree", "list", "--porcelain"], sourcePath);
    if (r.code !== 0) {
      this.log(`[worktree-local] list failed: ${gitError(r.stderr, r.stdout, "git worktree list failed")}`);
      return [];
    }
    const repoName = this.basename(sourcePath);
    return parseGitWorktreeList(r.stdout).map((rec) => ({
      ...rec,
      sourceRepo: sourcePath,
      repoName,
    }));
  }

  async create(o: { sourcePath: string; label?: string; root: string }): Promise<WorktreeCreateResult | { error: string }> {
    const unsupported = await this.inspectUnsupported(o.sourcePath);
    if (unsupported) return { error: unsupported };

    const toplevel = await this.gitText(["rev-parse", "--show-toplevel"], o.sourcePath);
    if (toplevel.code !== 0) return { error: gitError(toplevel.stderr, toplevel.stdout, "not a git repository") };
    const sourceGitRoot = toplevel.stdout.trim() || o.sourcePath;

    const existing = await this.list(sourceGitRoot);
    const repoName = sanitizeWorktreeLabel(this.basename(sourceGitRoot)) || "repo";
    const wanted = sanitizeWorktreeLabel(o.label ?? "") || this.autoLabel();
    const { dest, label, branch } = this.choosePath(o.root, repoName, wanted, existing);

    if (this.fs.existsSync(dest)) {
      return { error: `target path already exists: ${dest}` };
    }

    const add = await this.gitText(
      ["worktree", "add", "-b", branch, "--", dest],
      sourceGitRoot,
    );
    if (add.code !== 0) {
      return { error: gitError(add.stderr, add.stdout, "git worktree add failed") };
    }
    this.log(`[worktree-local] created ${dest} (linked, branch=${branch}, label=${label})`);
    return { status: "created", worktreePath: dest, sourceGitRoot };
  }

  async apply(o: {
    worktreePath: string;
    sourceGitRoot: string;
    overwrite?: boolean;
  }): Promise<WorktreeApplyResult | LocalApplyConflict | { error: string }> {
    const unsupported = await this.inspectUnsupported(o.sourceGitRoot);
    if (unsupported) return { error: unsupported };

    const wtHead = await this.gitText(["rev-parse", "HEAD"], o.worktreePath);
    if (wtHead.code !== 0) return { error: gitError(wtHead.stderr, wtHead.stdout, "worktree HEAD is unreadable") };
    const srcHead = await this.gitText(["rev-parse", "HEAD"], o.sourceGitRoot);
    if (srcHead.code !== 0) return { error: gitError(srcHead.stderr, srcHead.stdout, "source HEAD is unreadable") };

    const base = await this.gitText(
      ["merge-base", wtHead.stdout.trim(), srcHead.stdout.trim()],
      o.worktreePath,
    );
    if (base.code !== 0) return { error: gitError(base.stderr, base.stdout, "could not find a merge-base") };
    const mergeBase = base.stdout.trim();

    const diff = await this.gitText(["diff", "--name-status", mergeBase, "HEAD"], o.worktreePath);
    if (diff.code !== 0) return { error: gitError(diff.stderr, diff.stdout, "git diff failed") };
    const files = planLocalApply(diff.stdout);

    const conflicts: string[] = [];
    const writes: { relPath: string; bytes: Uint8Array }[] = [];
    const deletes: string[] = [];
    const applied: WorktreeApplyFile[] = [];

    for (const file of files) {
      const rel = file.path.replace(/\\/g, "/");
      const wtAbs = this.join(o.worktreePath, ...rel.split("/"));
      const srcAbs = this.join(o.sourceGitRoot, ...rel.split("/"));
      const baseBytes = await this.showAt(mergeBase, rel, o.worktreePath);
      const wtBytes = this.readIfExists(wtAbs);
      const srcBytes = this.readIfExists(srcAbs);
      const decision = decideLocalApplyFile({ base: baseBytes, worktree: wtBytes, current: srcBytes });
      if (decision === "skip") continue;
      if (decision === "conflict" && !o.overwrite) {
        conflicts.push(rel);
        continue;
      }
      if (decision === "delete" || (decision === "conflict" && o.overwrite && wtBytes === null)) {
        deletes.push(rel);
        applied.push(file);
        continue;
      }
      if (wtBytes) {
        writes.push({ relPath: rel, bytes: wtBytes });
        applied.push(file);
      }
    }

    if (conflicts.length) {
      return {
        error: "source files changed since the worktree branched",
        conflicts,
      };
    }

    // Writes happen only after the whole plan is conflict-free (or overwrite
    // was explicit). A half-applied worktree is the failure mode this exists
    // to prevent.
    for (const w of writes) {
      const abs = this.join(o.sourceGitRoot, ...w.relPath.split("/"));
      this.fs.mkdirSync(this.dirname(abs), { recursive: true });
      this.fs.writeFileSync(abs, w.bytes);
    }
    for (const rel of deletes) {
      const abs = this.join(o.sourceGitRoot, ...rel.split("/"));
      if (this.fs.existsSync(abs)) this.fs.unlinkSync(abs);
    }

    return { status: "success", files: applied, gitRoot: o.sourceGitRoot };
  }

  async remove(o: { worktreePath: string; force: boolean }): Promise<WorktreeRemoveResult | { error: string }> {
    const common = await this.gitText(["rev-parse", "--git-common-dir"], o.worktreePath);
    if (common.code !== 0) {
      return { error: gitError(common.stderr, common.stdout, "not a git worktree") };
    }
    let commonDir = common.stdout.trim();
    if (!nodePath.isAbsolute(commonDir)) commonDir = this.join(o.worktreePath, ...commonDir.split(/[\\/]/));
    const sourceGitRoot = this.basename(commonDir) === ".git" ? this.dirname(commonDir) : commonDir;

    const args = o.force
      ? ["worktree", "remove", "--force", "--", o.worktreePath]
      : ["worktree", "remove", "--", o.worktreePath];
    const r = await this.gitText(args, sourceGitRoot);
    if (r.code !== 0) {
      return { error: gitError(r.stderr, r.stdout, "git worktree remove failed") };
    }
    this.log(`[worktree-local] removed ${o.worktreePath}`);
    return { removed: true, resolvedPath: o.worktreePath };
  }

  private autoLabel(): string {
    const n = this.now();
    if (!n) return "wt";
    const d = new Date(n);
    const pad = (x: number) => String(x).padStart(2, "0");
    return `wt-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  }

  private choosePath(
    root: string,
    repoName: string,
    wanted: string,
    existing: WorktreeRecord[],
  ): { dest: string; label: string; branch: string } {
    const taken = new Set(existing.map((e) => e.path).map((p) => p.replace(/[\\/]+$/, "")));
    let label = wanted;
    let dest = this.join(root, repoName, label);
    let n = 2;
    while (taken.has(dest) || this.fs.existsSync(dest)) {
      label = `${wanted}-${n}`;
      dest = this.join(root, repoName, label);
      n += 1;
      if (n > 100) break;
    }
    const branchBase = `${BRANCH_PREFIX}${label}`;
    let branch = branchBase;
    const takenRefs = new Set(existing.map((e) => e.gitRef));
    n = 2;
    while (takenRefs.has(branch)) {
      branch = `${branchBase}-${n}`;
      n += 1;
      if (n > 100) break;
    }
    return { dest, label, branch };
  }

  private readIfExists(abs: string): Uint8Array | null {
    if (!this.fs.existsSync(abs)) return null;
    try {
      return this.fs.readFileSync(abs);
    } catch {
      return null;
    }
  }

  private async showAt(rev: string, rel: string, cwd: string): Promise<Uint8Array | null> {
    // `rev:path` is git's tree-ish. A missing path is exit 128, not an empty file.
    const r = await this.gitBytes(["show", `${rev}:${rel}`], cwd);
    if (r.code !== 0) return null;
    return r.stdout;
  }
}
