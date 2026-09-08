/**
 * Rule/instruction-file candidates for the four ACP providers (AP-04).
 *
 * The host NEVER interprets rule content — no parsing, no semantics of what a
 * file says, ever. This module only computes WHERE a candidate lives and
 * WHICH providers are documented to read it; `ruleFileCandidates` and
 * `buildRuleAppend` never touch `fs`. `resolveRuleFileStates` / `ensureRuleFile`
 * / `appendRuleEntry` take an injected {@link RuleFileFs} (same shape as
 * grok-config.ts's `ConfigFs`), so this whole module stays testable without a
 * real disk or `vscode`.
 *
 * The provider → file mapping is evidence-based, not guessed:
 *
 *  - **AGENTS.md** — OpenAI Codex CLI reads it from the repo root down to cwd,
 *    and globally at `~/.codex/AGENTS.md` (`~/.codex/AGENTS.override.md` first
 *    if present) — developers.openai.com/codex/guides/agents-md, fetched
 *    2026-09-08. Grok Build ALSO reads `AGENTS.md`/`Agents.md`/`AGENT.md` in
 *    every directory from the repo root to cwd — docs.x.ai/build/features/
 *    project-rules, fetched 2026-09-08 — so project-scope `AGENTS.md` lists
 *    both `codex` and `grok`. Claude Code explicitly does **not**: "Claude
 *    Code reads CLAUDE.md, not AGENTS.md" — code.claude.com/docs/en/memory,
 *    fetched 2026-09-08. Gemini CLI's default context filename is `GEMINI.md`;
 *    nothing documents it also reading `AGENTS.md` by default.
 *  - **CLAUDE.md** — Claude Code's own project (`./CLAUDE.md` or
 *    `./.claude/CLAUDE.md`) and user (`~/.claude/CLAUDE.md`) memory files,
 *    same source as above. The SAME Grok Build project-rules doc lists
 *    `CLAUDE.md`/`Claude.md`/`CLAUDE.local.md` among the filenames it reads
 *    project-side ("for compatibility") — so project-scope `CLAUDE.md` lists
 *    both `claude` and `grok`; the *global* `~/.claude/CLAUDE.md` row stays
 *    `claude`-only because Grok's own doc only claims the project-tree walk,
 *    never the user's `~/.claude/`.
 *  - **GEMINI.md** — Gemini CLI's hierarchical context file: global
 *    `~/.gemini/GEMINI.md`, project root `./GEMINI.md` —
 *    geminicli.com/docs/cli/gemini-md/, fetched 2026-09-08. Not among the
 *    filenames Grok Build's own docs enumerate, and no other provider
 *    documents reading it, so it stays `gemini`-only. This codebase's
 *    `"gemini"` provider id also stands in for Antigravity (`agy`), which
 *    shares the `.gemini` home directory here (see gemini-cli-locator.ts) —
 *    Antigravity's own `GEMINI.md` support is not independently confirmed,
 *    but there is no separate provider id to hang that uncertainty on.
 *  - **`.grok/`** — Grok Build's own project (`.grok/config.toml`, confirmed
 *    in this repo by grok-config.ts) and global (`~/.grok/config.toml`,
 *    `resolveGrokHome` in sessions.ts) directory; xAI's own docs additionally
 *    confirm a project `.grok/rules/*.md` and describe `~/.grok/` as where
 *    "global rules" live, without pinning one filename there — so the global
 *    row stays a bare directory candidate rather than a guessed filename.
 *  - **`.claude/`** — Claude Code's project rules directory
 *    (`.claude/rules/*.md`, `.claude/CLAUDE.md`) and user directory
 *    (`~/.claude/CLAUDE.md`, `~/.claude/rules/`), same source as CLAUDE.md
 *    above; this repo's own claude-backend.ts also resolves session
 *    transcripts under `~/.claude/projects`. Grok Build additionally reads a
 *    project `.claude/rules/` "for compatibility" per its own docs, so the
 *    PROJECT row lists `claude` and `grok`; nothing documents Grok reading
 *    the user's global `~/.claude/`, so that row stays `claude`-only.
 *  - **`.gemini/`** — Gemini CLI / Antigravity's own settings directory
 *    (`oauth_creds.json`, `settings.json` under `~/.gemini`, confirmed in
 *    this repo by gemini-cli-locator.ts).
 *
 * Nothing here is a guess beyond these citations. Where a mapping is not
 * documented, the provider is simply left out of that candidate's list — none
 * of the twelve candidates below end up with an empty list today, but
 * `providers` stays `AcpProvider[]` (not a non-empty tuple) because a future
 * candidate may legitimately need one; the UI must render that as "may be
 * read", never assert a guessed provider (see media/settings.js).
 */
import type { AcpProvider } from "./acp-backend";

export type RuleFileKind = "file" | "directory";
export type RuleFileScope = "project" | "global";

export interface RuleFile {
  /** Absolute path. */
  path: string;
  /** Display label, e.g. "AGENTS.md (project)". */
  label: string;
  scope: RuleFileScope;
  /**
   * Whether "open" means open-as-text vs. reveal-in-folder, and "create"
   * means write-an-empty-file vs. make-a-directory. This is intrinsic to
   * which of the six tracked candidates a row is (three filenames are always
   * files, three dot-directories are always directories) — decided here at
   * construction, never probed from disk, so it stays correct even before
   * the host has checked whether the path exists.
   */
  kind: RuleFileKind;
  /**
   * Providers documented to read this file/directory. Empty means uncertain:
   * the UI must show "may be read", never assert a provider without a
   * citation (see the module doc comment above).
   */
  providers: AcpProvider[];
  /** Filled in by {@link resolveRuleFileStates}; always `false` here. */
  exists: boolean;
  /** Filled in by {@link resolveRuleFileStates} for existing files; undefined for directories and missing files. */
  bytes?: number;
}

function looksWindowsPath(p: string): boolean {
  return /^[\\/]{2}\?[\\/]/.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
}

/** Join a candidate path using the SAME separator style as `base`, regardless
 *  of which OS is actually running — `cwd`/`home` may be a Windows path on a
 *  POSIX test runner and vice versa, and this stays deterministic either way. */
function joinCandidate(base: string, ...segments: string[]): string {
  const sep = looksWindowsPath(base) ? "\\" : "/";
  const trimmed = base.replace(/[\\/]+$/, "");
  return [trimmed, ...segments].join(sep);
}

/**
 * Candidate rule/instruction files and directories for `cwd` (project scope)
 * and `home` (global scope). Pure — no `fs`, no existence check; the caller
 * resolves `home` the way `cli-locator.ts` does (`HOME`/`USERPROFILE` first,
 * then `os.homedir()`) and passes it in. Either argument may be empty (no
 * project open, or home unresolved) — candidates for the other stay in the
 * result.
 */
export function ruleFileCandidates(cwd: string, home: string): RuleFile[] {
  const c = String(cwd ?? "").trim();
  const h = String(home ?? "").trim();
  const out: RuleFile[] = [];
  const add = (
    base: string,
    segments: string[],
    scope: RuleFileScope,
    kind: RuleFileKind,
    label: string,
    providers: AcpProvider[],
  ) => {
    if (!base) return;
    out.push({ path: joinCandidate(base, ...segments), label, scope, kind, providers, exists: false });
  };

  // Project scope — repo root.
  add(c, ["AGENTS.md"], "project", "file", "AGENTS.md (project)", ["codex", "grok"]);
  add(c, ["CLAUDE.md"], "project", "file", "CLAUDE.md (project)", ["claude", "grok"]);
  add(c, ["GEMINI.md"], "project", "file", "GEMINI.md (project)", ["gemini"]);
  add(c, [".grok"], "project", "directory", ".grok/ (project)", ["grok"]);
  add(c, [".claude"], "project", "directory", ".claude/ (project)", ["claude", "grok"]);
  add(c, [".gemini"], "project", "directory", ".gemini/ (project)", ["gemini"]);

  // Global scope — the REAL documented per-provider home locations (see the
  // module doc comment), not a flat guess at "<home>/<file>.md": Claude and
  // Gemini never read that bare path, only the nested one.
  add(h, [".codex", "AGENTS.md"], "global", "file", "AGENTS.md (global, ~/.codex/)", ["codex"]);
  add(h, [".claude", "CLAUDE.md"], "global", "file", "CLAUDE.md (global, ~/.claude/)", ["claude"]);
  add(h, [".gemini", "GEMINI.md"], "global", "file", "GEMINI.md (global, ~/.gemini/)", ["gemini"]);
  add(h, [".grok"], "global", "directory", ".grok/ (global)", ["grok"]);
  add(h, [".claude"], "global", "directory", ".claude/ (global)", ["claude"]);
  add(h, [".gemini"], "global", "directory", ".gemini/ (global)", ["gemini"]);

  return out;
}

/** Injected filesystem — same shape/spirit as grok-config.ts's `ConfigFs`, so
 *  every function below is testable without a real disk or `vscode`. */
export interface RuleFileFs {
  /** Metadata for `absPath`, or undefined when it does not exist. */
  stat(absPath: string): Promise<{ isDirectory: boolean; size: number } | undefined>;
  /** The file's text, or undefined when it does not exist. */
  readText(absPath: string): Promise<string | undefined>;
  /** Overwrite (or create) a file with the full given text in one call — never
   *  streamed, so a failure never leaves a partial write on disk. */
  writeText(absPath: string, content: string): Promise<void>;
  /** Create a directory (and its parents). No-op if it already exists. */
  mkdir(absPath: string): Promise<void>;
}

/** Overlay real `exists`/`bytes` from disk onto pure candidates. A stat
 *  failure (missing path, denied, whatever) is just `exists:false` — never
 *  thrown further, matching a plain ENOENT check. */
export async function resolveRuleFileStates(
  candidates: readonly RuleFile[],
  fs: RuleFileFs,
): Promise<RuleFile[]> {
  const out: RuleFile[] = [];
  for (const candidate of candidates) {
    let stat: { isDirectory: boolean; size: number } | undefined;
    try {
      stat = await fs.stat(candidate.path);
    } catch {
      stat = undefined;
    }
    out.push({
      ...candidate,
      exists: !!stat,
      bytes: stat && !stat.isDirectory ? stat.size : undefined,
    });
  }
  return out;
}

function parentDir(absPath: string): string {
  const sep = looksWindowsPath(absPath) ? "\\" : "/";
  const idx = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  return idx > 0 ? absPath.slice(0, idx) : sep;
}

/**
 * Create a missing candidate: an empty file (plus parent directories) for
 * `kind: "file"`, or the directory itself for `kind: "directory"`. No-op —
 * and never a write — when it already exists.
 */
export async function ensureRuleFile(
  file: Pick<RuleFile, "path" | "kind">,
  fs: RuleFileFs,
): Promise<void> {
  const stat = await fs.stat(file.path).catch(() => undefined);
  if (stat) return;
  if (file.kind === "directory") {
    await fs.mkdir(file.path);
    return;
  }
  await fs.mkdir(parentDir(file.path));
  await fs.writeText(file.path, "");
}

/**
 * Append `addition` to `existing` with a separator and a dated marker
 * comment. Never replaces, reorders, or reformats a single byte of
 * `existing` — the return value always starts with `existing` verbatim.
 * `dateStamp` is caller-supplied (e.g. `new Date().toISOString().slice(0, 10)`)
 * so this stays clock-free. A blank/whitespace-only `addition` is a no-op:
 * returns `existing` unchanged.
 */
export function buildRuleAppend(existing: string, addition: string, dateStamp: string): string {
  const text = addition.trim();
  if (!text) return existing;
  const block = `<!-- Added via All your Companions on ${dateStamp} -->\n${text}\n`;
  if (!existing) return block;
  const withTrailingNewline = existing.endsWith("\n") ? existing : `${existing}\n`;
  const gap = withTrailingNewline.endsWith("\n\n") ? "" : "\n";
  return `${withTrailingNewline}${gap}---\n${block}`;
}

/**
 * Append `addition` to a FILE-kind rule target, creating it (and its parent
 * directory) first if missing. Reads the existing content, computes the full
 * next content via {@link buildRuleAppend}, then writes it in exactly ONE
 * `fs.writeText` call — so a write failure (read-only file, permissions)
 * never leaves a partial write: either the whole new content lands, or the
 * file is exactly what it was before this call, and the rejection propagates
 * for the caller to show as a clear error.
 */
export async function appendRuleEntry(
  file: Pick<RuleFile, "path" | "kind">,
  addition: string,
  dateStamp: string,
  fs: RuleFileFs,
): Promise<void> {
  if (file.kind !== "file") {
    throw new Error("Only a file-kind rule target can be appended to.");
  }
  await fs.mkdir(parentDir(file.path));
  const existing = (await fs.readText(file.path).catch(() => undefined)) ?? "";
  const next = buildRuleAppend(existing, addition, dateStamp);
  if (next === existing) return; // blank selection — nothing to add
  await fs.writeText(file.path, next);
}
