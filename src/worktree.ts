/**
 * Pure helpers for Grok's git-worktree surface (`_x.ai/git/worktree/*`).
 *
 * Wire format (probe-confirmed on CLI 0.2.111 — see research/worktree.md):
 *   create  { sessionId, sourcePath, label? } → { status:"creating", worktreePath, sourceGitRoot, sessionId }
 *           + async `_x.ai/git/worktree/status` { status:"progress"|"created", … }
 *   list    {} | filters → { result: WorktreeRecord[] }  (snake_case fields)
 *   show    { idOrPath } → WorktreeRecord | null
 *   apply   { sessionId, worktreePath } → { status:"success", files[], gitRoot }
 *   remove  { worktreePath } → { removed:true, resolvedPath }
 *
 * Methods are `_`-prefixed on the wire; bare `x.ai/...` is -32601.
 */

import * as path from "node:path";

/** Leading history/toolbar tag for a worktree-isolated session. */
export const WORKTREE_NAME_TAG = "(WT)";

export interface WorktreeRecord {
  id: string;
  path: string;
  sourceRepo: string;
  repoName: string;
  kind: string;
  creationMode: string;
  gitRef: string;
  headCommit: string;
  sessionId?: string;
  status: string;
  label: string;
  userProvidedLabel: boolean;
  createdAt?: number;
}

/**
 * How a worktree create ended, as far as the host can tell.
 *
 * `silent` and `stalled` both mean "no completion event arrived", and they call
 * for opposite responses — one is an older CLI that never reports, the other is
 * a copy that genuinely did not finish. Collapsing them into one "timeout" is
 * what let a half-copied checkout be accepted.
 */
export type WorktreeCreateOutcome = "created" | "failed" | "stalled" | "silent";

/**
 * Whether a `worktree/status` notification belongs to the create we are
 * waiting on.
 *
 * The CLI's PROGRESS notifications carry no `worktreePath` — only the terminal
 * one does (research/worktree.md) — so a pathless event can only be attributed
 * when there is exactly one create it could belong to. That is why creates are
 * serialised rather than correlated: correlation is impossible for the events
 * that matter most.
 */
export function worktreeStatusIsForCreate(
  event: { worktreePath?: string } | null | undefined,
  opts: { target?: string; soleCreateInFlight: boolean; sameCwd?: (a: string, b: string) => boolean },
): boolean {
  const named = event?.worktreePath?.trim();
  if (!named) return opts.soleCreateInFlight;
  if (!opts.target) return false;
  return (opts.sameCwd ?? pathsEqual)(named, opts.target);
}

/** Terminal reading of a `worktree/status` notification, or undefined for progress. */
export function worktreeStatusVerdict(
  event: { status?: string } | null | undefined,
): "created" | "failed" | undefined {
  const value = String(event?.status ?? "").toLowerCase();
  if (value === "created" || value === "ready" || value === "done") return "created";
  if (value === "failed" || value === "error") return "failed";
  return undefined;
}

export interface WorktreeCreateResult {
  status: string;
  sessionId?: string;
  worktreePath: string;
  sourceGitRoot: string;
}

export interface WorktreeApplyFile {
  path: string;
  type: string;
  additions: number;
  deletions: number;
}

export interface WorktreeApplyResult {
  status: string;
  files: WorktreeApplyFile[];
  gitRoot: string;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  resolvedPath: string;
}

export interface WorktreeStatusUpdate {
  status: string;
  sessionId?: string;
  worktreePath?: string;
  sourceGitRoot?: string;
  message?: string;
  commit?: string;
}

/**
 * Grok double-wraps many extension results as `{ result: T }` inside the
 * JSON-RPC `result` field. Unwrap one layer when present so callers see T.
 * Pure — accepts any unknown payload.
 */
export function unwrapExtResult<T = unknown>(payload: unknown): T {
  if (payload && typeof payload === "object" && "result" in (payload as object)) {
    return (payload as { result: T }).result;
  }
  return payload as T;
}

/** Case-fold + normalize separators for path equality on Windows/macOS/Linux. */
export function normalizeFsPath(p: string): string {
  if (!p) return "";
  const resolved = path.resolve(p);
  // Windows paths are case-insensitive; elsewhere keep the original case after resolve.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizeFsPath(a) === normalizeFsPath(b);
}

/** True when `candidate` is the same path as `root` or lives under it. */
export function pathIsInside(candidate: string, root: string): boolean {
  const c = normalizeFsPath(candidate);
  const r = normalizeFsPath(root);
  if (!c || !r) return false;
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

/**
 * Best-effort "is this a git working tree?" without spawning git: a `.git`
 * file (worktree) or directory (main checkout) at `cwd` (or an ancestor).
 * Pure against an injected fs.
 */
export function isGitRepo(
  cwd: string,
  fs: { existsSync(p: string): boolean; statSync?(p: string): { isDirectory(): boolean; isFile(): boolean } },
): boolean {
  return gitRootForPath(cwd, fs) !== undefined;
}

/** Resolve the nearest checkout root for `cwd`. The nearest `.git` marker is
 * authoritative so an independent nested checkout does not inherit its
 * ancestor repository's worktrees. */
export function gitRootForPath(
  cwd: string,
  fs: { existsSync(p: string): boolean },
): string | undefined {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const git = path.join(dir, ".git");
    if (fs.existsSync(git)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Parse one raw list/show row (snake_case from the CLI) into a WorktreeRecord. */
export function parseWorktreeRecord(raw: any): WorktreeRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const wtPath = typeof raw.path === "string" ? raw.path : typeof raw.worktreePath === "string" ? raw.worktreePath : "";
  if (!wtPath) return null;
  const id = typeof raw.id === "string" ? raw.id : wtPath;
  const meta = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const label =
    (typeof meta.label === "string" && meta.label) ||
    (typeof raw.label === "string" && raw.label) ||
    path.basename(wtPath);
  return {
    id,
    path: wtPath,
    sourceRepo: typeof raw.source_repo === "string" ? raw.source_repo : typeof raw.sourceRepo === "string" ? raw.sourceRepo : "",
    repoName: typeof raw.repo_name === "string" ? raw.repo_name : typeof raw.repoName === "string" ? raw.repoName : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    creationMode: typeof raw.creation_mode === "string" ? raw.creation_mode : typeof raw.creationMode === "string" ? raw.creationMode : "",
    gitRef: typeof raw.git_ref === "string" ? raw.git_ref : typeof raw.gitRef === "string" ? raw.gitRef : "",
    headCommit: typeof raw.head_commit === "string" ? raw.head_commit : typeof raw.headCommit === "string" ? raw.headCommit : "",
    sessionId: typeof raw.session_id === "string" ? raw.session_id : typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    status: typeof raw.status === "string" ? raw.status : "alive",
    label,
    userProvidedLabel: meta.user_provided === true || meta.userProvided === true,
    createdAt: typeof raw.created_at === "number" ? raw.created_at : typeof raw.createdAt === "number" ? raw.createdAt : undefined,
  };
}

/** Parse a list RPC payload into WorktreeRecord[]. Handles double-wrapped `{result:[…]}`. */
export function parseWorktreeList(payload: unknown): WorktreeRecord[] {
  const unwrapped = unwrapExtResult(payload);
  const arr = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped && typeof unwrapped === "object" && Array.isArray((unwrapped as any).result)
      ? (unwrapped as any).result
      : [];
  const out: WorktreeRecord[] = [];
  for (const row of arr) {
    const rec = parseWorktreeRecord(row);
    if (rec) out.push(rec);
  }
  return out;
}

export function parseWorktreeCreate(payload: unknown): WorktreeCreateResult | null {
  const r = unwrapExtResult<any>(payload);
  if (!r || typeof r !== "object") return null;
  const worktreePath = typeof r.worktreePath === "string" ? r.worktreePath : "";
  if (!worktreePath) return null;
  return {
    status: typeof r.status === "string" ? r.status : "creating",
    sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
    worktreePath,
    sourceGitRoot: typeof r.sourceGitRoot === "string" ? r.sourceGitRoot : "",
  };
}

export function parseWorktreeApply(payload: unknown): WorktreeApplyResult | null {
  const r = unwrapExtResult<any>(payload);
  if (!r || typeof r !== "object") return null;
  const filesRaw = Array.isArray(r.files) ? r.files : [];
  const files: WorktreeApplyFile[] = filesRaw.map((f: any) => ({
    path: typeof f?.path === "string" ? f.path : "",
    type: typeof f?.type === "string" ? f.type : "",
    additions: typeof f?.additions === "number" ? f.additions : 0,
    deletions: typeof f?.deletions === "number" ? f.deletions : 0,
  }));
  return {
    status: typeof r.status === "string" ? r.status : "success",
    files,
    gitRoot: typeof r.gitRoot === "string" ? r.gitRoot : "",
  };
}

export function parseWorktreeRemove(payload: unknown): WorktreeRemoveResult | null {
  const r = unwrapExtResult<any>(payload);
  if (!r || typeof r !== "object") return null;
  return {
    removed: r.removed === true || r.removed === "true",
    resolvedPath: typeof r.resolvedPath === "string" ? r.resolvedPath : typeof r.worktreePath === "string" ? r.worktreePath : "",
  };
}

/** Parse a `_x.ai/git/worktree/status` notification params blob. */
export function parseWorktreeStatus(params: unknown): WorktreeStatusUpdate | null {
  if (!params || typeof params !== "object") return null;
  const p = params as any;
  const status = typeof p.status === "string" ? p.status : "";
  if (!status) return null;
  return {
    status,
    sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
    worktreePath: typeof p.worktreePath === "string" ? p.worktreePath : undefined,
    sourceGitRoot: typeof p.sourceGitRoot === "string" ? p.sourceGitRoot : undefined,
    message: typeof p.message === "string" ? p.message : undefined,
    commit: typeof p.commit === "string" ? p.commit : undefined,
  };
}

/**
 * Worktrees whose source repo is the given workspace (or live under it).
 * Alive-only by default so dead records don't open phantom session catalogs.
 */
export function worktreesForRepo(
  records: WorktreeRecord[],
  workspaceRoot: string,
  opts?: { includeDead?: boolean },
): WorktreeRecord[] {
  return records.filter((r) => {
    if (!opts?.includeDead && r.status && r.status !== "alive") return false;
    if (!r.sourceRepo) return pathsEqual(r.path, workspaceRoot) || pathIsInside(r.path, workspaceRoot);
    return pathsEqual(r.sourceRepo, workspaceRoot);
  });
}

/**
 * Name a worktree session for history: leading `(WT) <label>`.
 * Idempotent — already-tagged names are returned unchanged.
 */
export function worktreeDisplayName(label: string | undefined): string {
  const base = (label ?? "").trim();
  if (!base) return WORKTREE_NAME_TAG;
  if (base.toLowerCase().startsWith(WORKTREE_NAME_TAG.toLowerCase())) return base;
  return `${WORKTREE_NAME_TAG} ${base}`;
}

/** True when a session cwd is one of the given worktree paths. */
export function matchWorktreeForCwd(
  cwd: string,
  records: WorktreeRecord[],
): WorktreeRecord | undefined {
  return records.find((r) => pathsEqual(r.path, cwd));
}

/** A worktree as history knows it: where it lives, and its recorded parent. */
export interface WorktreeParentRef {
  path: string;
  /** The CLI's GIT root — NOT the VS Code workspace folder. May be absent on
   *  records written before the field existed. */
  sourceGitRoot?: string;
}

/**
 * Which worktree cwds ride along with a repo's session history.
 *
 * Parent matching is by checkout identity: the selected folder's nearest git
 * root must equal the worktree's recorded source root. A worktree without
 * parent metadata, or a selected folder whose root cannot be established, is
 * not assigned to any repository. Hiding an ambiguous row is safer than
 * authorizing deletion from the wrong checkout.
 */
export function worktreeCwdsForRepo(opts: {
  repoCwd: string;
  repoGitRoot?: string;
  worktrees: WorktreeParentRef[];
}): string[] {
  return opts.worktrees
    .filter((w) => w.path && belongsToRepo(w.sourceGitRoot, opts.repoGitRoot))
    .map((w) => w.path);
}

/**
 * A worktree list RPC is scoped to the repo of the ACP client that served it.
 * Replace that repo's rows without erasing registrations learned from clients
 * rooted in other repositories.
 *
 * Refreshed rows are filtered through {@link filterWorktreesForSourceRepo} so a
 * malformed or compromised list cannot inject arbitrary paths into the cache
 * (and thus into desktop auth roots).
 */
export function mergeWorktreeRefresh(
  current: WorktreeRecord[],
  sourceRepo: string,
  refreshed: WorktreeRecord[],
  opts?: { sourceGitRoot?: string },
): WorktreeRecord[] {
  const trusted = filterWorktreesForSourceRepo(refreshed, sourceRepo, opts);
  const refreshedPaths = new Set(trusted.map((record) => normalizeFsPath(record.path)));
  return [
    ...current.filter((record) =>
      !pathsEqual(record.sourceRepo, sourceRepo) &&
      !refreshedPaths.has(normalizeFsPath(record.path))
    ),
    ...trusted,
  ];
}

/**
 * Keep only worktree records that claim the requested repository as their
 * source. Records without `sourceRepo` are refused — they cannot be attributed
 * and must not widen auth roots.
 */
export function filterWorktreesForSourceRepo(
  records: readonly WorktreeRecord[],
  sourceRepo: string,
  opts?: { sourceGitRoot?: string },
): WorktreeRecord[] {
  if (!sourceRepo) return [];
  const roots = [sourceRepo];
  if (opts?.sourceGitRoot && !pathsEqual(opts.sourceGitRoot, sourceRepo)) {
    roots.push(opts.sourceGitRoot);
  }
  return records.filter((r) => {
    if (!r?.path || typeof r.path !== "string") return false;
    if (!r.sourceRepo) return false;
    return roots.some((root) => pathsEqual(r.sourceRepo, root));
  });
}

/**
 * Whether an ACP-returned worktree path may enter the cache / session cwd /
 * auth roots. The path must appear in an authoritative worktree list for the
 * requested repository (from `git worktree list` or `_x.ai/git/worktree/list`).
 *
 * When `claimedSourceGitRoot` is non-empty it must match the source repo (or
 * its git root). Empty claimed root is allowed (older payloads) as long as the
 * path is listed.
 */
export function worktreePathAuthorizedForRepo(opts: {
  worktreePath: string;
  sourceRepo: string;
  listedWorktreePaths: readonly string[];
  claimedSourceGitRoot?: string;
  sourceGitRoot?: string;
  sameCwd?: (a: string, b: string) => boolean;
}): boolean {
  const same = opts.sameCwd ?? pathsEqual;
  const wt = opts.worktreePath;
  const source = opts.sourceRepo;
  if (!wt || typeof wt !== "string" || !source) return false;
  if (!opts.listedWorktreePaths.some((p) => same(p, wt))) return false;
  // The main checkout is listed too — create must return a *different* path.
  if (same(wt, source)) return false;
  if (opts.sourceGitRoot && same(wt, opts.sourceGitRoot)) return false;
  const claimed = opts.claimedSourceGitRoot?.trim();
  if (claimed) {
    const ok =
      same(claimed, source) ||
      (!!opts.sourceGitRoot && same(claimed, opts.sourceGitRoot));
    if (!ok) return false;
  }
  return true;
}

/**
 * Where the CLI records which repository a CLONE-mode worktree came from.
 *
 * Not every "worktree" the CLI makes is a `git worktree add`. For some repos it
 * produces a standalone clone instead — its `.git` is a real directory with its
 * own object store, so the source repo's `git worktree list` will never mention
 * it, no matter how long we wait. That is not a lag; it is a different thing.
 * The CLI leaves this file behind naming the source.
 */
export const CLONE_WORKTREE_SOURCE_MARKER = ".git/grok-worktree-source";

/**
 * Read the clone-mode provenance marker and say whether it names `sourceRepo`.
 *
 * This is what makes a clone-mode checkout trustable WITHOUT taking the agent's
 * word for it: the claim is a file the CLI wrote on local disk, checked by us,
 * against the repo the user actually asked to branch from. An agent that lied
 * about a path cannot forge a marker inside a directory it does not control —
 * and if it could write there, it already had the access.
 *
 * Pure over an injected reader so it is testable and so the caller decides what
 * "read a file" means.
 */
export function cloneWorktreeSourceMatches(opts: {
  worktreePath: string;
  sourceRepo: string;
  sourceGitRoot?: string;
  readMarker: (markerPath: string) => string | undefined;
  joinPath?: (a: string, b: string) => string;
  sameCwd?: (a: string, b: string) => boolean;
}): boolean {
  const { worktreePath, sourceRepo } = opts;
  if (!worktreePath || !sourceRepo) return false;
  const same = opts.sameCwd ?? pathsEqual;
  const join = opts.joinPath ?? ((a, b) => `${a.replace(/[\\/]+$/, "")}/${b}`);
  let raw: string | undefined;
  try {
    raw = opts.readMarker(join(worktreePath, CLONE_WORKTREE_SOURCE_MARKER));
  } catch {
    return false;
  }
  const claimed = (raw ?? "").trim();
  if (!claimed) return false;
  // A marker naming the worktree itself proves nothing about provenance.
  if (same(claimed, worktreePath)) return false;
  return same(claimed, sourceRepo) || (!!opts.sourceGitRoot && same(claimed, opts.sourceGitRoot));
}

/**
 * Parse `git worktree list --porcelain` stdout into absolute worktree paths.
 * Pure against the text (no spawn).
 */
export function parseGitWorktreeListPorcelain(stdout: string): string[] {
  return parseGitWorktreeList(stdout).map((r) => r.path);
}

/**
 * Parse `git worktree list --porcelain` into the same {@link WorktreeRecord}
 * shape the Grok RPC list uses. One data model, two sources — otherwise the
 * surface would have two truths about the same checkout.
 *
 * Local git can only produce linked worktrees (decision 18.8). Clone-mode is
 * a Grok RPC invention and is never inferred here.
 */
export function parseGitWorktreeList(porcelain: string): WorktreeRecord[] {
  if (!porcelain || typeof porcelain !== "string") return [];
  const out: WorktreeRecord[] = [];
  const seen = new Set<string>();
  let current: Partial<WorktreeRecord> & { path?: string } | undefined;
  const flush = () => {
    const rec = current;
    const wtPath = rec?.path;
    if (!rec || !wtPath) {
      current = undefined;
      return;
    }
    const key = normalizeFsPath(wtPath);
    if (!key || seen.has(key)) {
      current = undefined;
      return;
    }
    seen.add(key);
    const label = path.basename(wtPath) || wtPath;
    out.push({
      id: wtPath,
      path: wtPath,
      sourceRepo: "",
      repoName: "",
      kind: rec.kind === "bare" ? "bare" : "session",
      creationMode: "linked",
      gitRef: rec.gitRef ?? "",
      headCommit: rec.headCommit ?? "",
      status: rec.status === "prunable" ? "prunable" : "alive",
      label,
      userProvidedLabel: false,
    });
    current = undefined;
  };
  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      const p = unquotePorcelainPath(line.slice("worktree ".length));
      if (p) current = { path: p };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.headCommit = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.gitRef = ref.replace(/^refs\/heads\//, "") || ref;
    } else if (line === "detached") current.gitRef = "HEAD";
    else if (line === "bare") current.kind = "bare";
    else if (line === "prunable" || line.startsWith("prunable ")) current.status = "prunable";
  }
  flush();
  return out;
}

/** Porcelain quotes paths with special characters as C strings. */
function unquotePorcelainPath(raw: string): string {
  const s = raw.replace(/^\s+/, "").replace(/\s+$/, "");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\([\\nrt"])/g, (_, ch: string) => {
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      if (ch === "r") return "\r";
      return ch;
    });
  }
  return s;
}

function belongsToRepo(sourceGitRoot: string | undefined, repoGitRoot: string | undefined): boolean {
  return !!sourceGitRoot && !!repoGitRoot && pathsEqual(sourceGitRoot, repoGitRoot);
}

/**
 * Merge session index entries from several cwds, de-duping by id
 * (first wins — caller should put the preferred catalog first).
 */
export function mergeSessionIndexes(
  indexes: Array<{ cwd: string; entries: Array<{ id: string; mtimeMs: number }> }>,
): Array<{ id: string; mtimeMs: number; cwd: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; mtimeMs: number; cwd: string }> = [];
  for (const { cwd, entries } of indexes) {
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, mtimeMs: e.mtimeMs, cwd });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** The emitter surface {@link WorktreeCreateSlots} needs from an `AcpClient`. */
export interface WorktreeSlotClient {
  on(event: string, fn: (...args: any[]) => void): unknown;
  off?(event: string, fn: (...args: any[]) => void): unknown;
}

/**
 * How many worktree creates are live on each CLI client, and the listeners that
 * release them.
 *
 * Extracted from the watcher because the bug this fixes is a LIFETIME bug, and
 * a lifetime is the one thing a source-text assertion cannot check. The
 * watcher's correlation logic stays where it is; only the bookkeeping moved.
 *
 * Two properties, and both were wrong before:
 *
 *  - **The exit listener is registered when the slot is taken.** `exit` is
 *    one-shot. Registering it later — at the moment a stalled create decides to
 *    hold its slot, minutes after the CLI may have died — attaches to an event
 *    that has already gone, and the slot outlives the process.
 *  - **The counts are WEAK.** Only ever read by client key, never iterated, so
 *    the weak form is a drop-in and a slot that is never released costs nothing
 *    instead of pinning a dead process's listeners and session graph for the
 *    life of the sidebar. The listener still releases promptly; this is what
 *    stops a missed release from being a leak.
 */
export class WorktreeCreateSlots {
  private readonly counts = new WeakMap<WorktreeSlotClient, number>();

  /**
   * Take a slot on `client`, returning its release.
   *
   * `release({ keep: true })` drops nothing: a STALLED create is one we stopped
   * waiting for, not one that ended, so its slot has to outlive the call — and
   * the exit listener stays behind as the thing that eventually frees it. Every
   * other release drops the listener and the count together, which is what
   * keeps an ordinary create from leaving a callback on a reused workspace
   * client.
   */
  take(client: WorktreeSlotClient): (opts?: { keep?: boolean }) => void {
    this.counts.set(client, (this.counts.get(client) ?? 0) + 1);
    const onExit = () => this.counts.delete(client);
    try {
      client.on("exit", onExit);
    } catch {
      /* a client that cannot subscribe is bounded by its own lifetime anyway */
    }
    let released = false;
    return (opts?: { keep?: boolean }) => {
      // Idempotent: a second release would under-count, and an under-count reads
      // as "only one create in flight" — which is exactly the state that makes a
      // pathless progress event trusted when it should not be.
      if (released) return;
      released = true;
      if (opts?.keep) return;
      try {
        client.off?.("exit", onExit);
      } catch {
        /* best effort — a disposed client has nothing to detach from */
      }
      const left = (this.counts.get(client) ?? 1) - 1;
      if (left > 0) this.counts.set(client, left);
      else this.counts.delete(client);
    };
  }

  /** True when exactly one create is live on `client`, so a notification that
   *  names no worktree path can only belong to it. */
  sole(client: WorktreeSlotClient): boolean {
    return this.counts.get(client) === 1;
  }
}

/** Sanitize a user-typed worktree label for the create RPC (no path separators). */
export function sanitizeWorktreeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "")
    .slice(0, 64);
}
