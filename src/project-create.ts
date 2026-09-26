/**
 * Making a project, rather than finding one.
 *
 * `addProjectFolder` opens a native picker and takes whatever path comes back.
 * That is the right shape for a folder that already exists and the wrong shape
 * for everything else: a knowledge-work user starting their first piece of work
 * has no folder to point at.
 *
 * So the two new ways in take a NAME or a URL — never a path. The destination
 * is derived here, inside one configured root, and checked to be inside it
 * afterwards. That is the whole containment model: the client says WHAT, the
 * host says WHERE.
 *
 * Pure. No I/O, no `vscode`, no process spawning — the caller does all three.
 */

import * as path from "node:path";

/**
 * The one folder new projects are created in, relative to home.
 *
 * Lives here rather than in `src/desktop/paths.ts` for two reasons. The .vsix
 * does not pack `out/desktop/`, so an extension module importing from there
 * installs cleanly and dies on activation — caught by `npm run check:vsix`, and
 * the exact shape of issue #101. And the dependency was backwards: where
 * projects go is a product decision that the desktop shell also happens to
 * need, not a property of the shell.
 */
/**
 * The folder every project lives in, on a machine that has never run this
 * before.
 *
 * The product is what people see on every session start, and leading with the
 * agent's name there was a decision nobody made deliberately — it was simply
 * the name the first folder happened to get.
 */
export const PROJECT_ROOT_DIRNAME = "AFK Pilot";

/**
 * What that folder was called before, and still is on machines that already
 * have one.
 *
 * NOT a migration. Nothing moves, nothing is copied, and no existing project
 * changes path — a rename that relocated somebody's work to make a name nicer
 * would be a bad trade at any quality of name. An install that already has this
 * folder keeps using it forever; only a fresh machine gets the new one.
 */
export const LEGACY_PROJECT_ROOT_DIRNAME = "Grok Build";

/**
 * The first-run project, created inside the root.
 *
 * Previously the root WAS the first project — one folder doing both jobs, which
 * is why the projects list showed a folder named after the tool. They are
 * separate now: a container, and a project inside it that says what it is.
 */
export const DEFAULT_PROJECT_NAME = "My First Project";

/** @deprecated The root's name is no longer one constant — see
 *  {@link projectRoot}, which has to look at the disk to answer. */
export const DEFAULT_PROJECT_DIRNAME = LEGACY_PROJECT_ROOT_DIRNAME;

/** Longest project name we will make a folder for. */
export const PROJECT_NAME_MAX = 64;

/**
 * Windows device names. Reserved with OR without an extension and regardless of
 * case, and creating one fails in ways that do not look like a naming problem.
 */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Characters no folder name may carry on the strictest platform we ship to. */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/;

/**
 * The one directory new projects are created in.
 *
 * `~/Grok Build` — the same location `provisionDefaultProjectDir` already
 * chose for the first-run folder, and for the same reasons: on macOS it is not
 * TCC-protected (unlike Desktop / Documents / Downloads) so creating it raises
 * no consent dialog, and it is findable in Finder without being hidden.
 *
 * A single root is not tidiness. It is what makes a client-supplied name safe:
 * the client says what to call it, the host says where it goes.
 */
export function projectRoot(
  homeDir: string,
  opts: { useLegacyRoot?: boolean } = {},
): string {
  // Which name applies depends on the disk, and this module does no I/O — the
  // caller looks (see `shouldUseLegacyRoot` for exactly what to look at).
  //
  // It matters because getting it wrong splits somebody's projects across two
  // roots: new ones landing in a fresh folder beside the one already holding
  // all their work.
  return path.join(
    homeDir,
    opts.useLegacyRoot ? LEGACY_PROJECT_ROOT_DIRNAME : PROJECT_ROOT_DIRNAME,
  );
}

/**
 * Whether this machine keeps the old root.
 *
 * `remembered` wins outright, and that is the whole design. An earlier version
 * inferred the answer from the disk every time — legacy wins unless the new
 * root exists — and the filesystem simply cannot carry that meaning: it cannot
 * tell "an old install that also happens to have a folder by the new name"
 * from "a new install that committed to it". Getting it wrong the first way
 * splits an upgrading user's projects across two roots, which is the exact
 * thing the legacy rule exists to prevent.
 *
 * So the decision is made ONCE, from the disk, and then written down. After
 * that the disk is not consulted again and nothing anybody creates later can
 * move where their projects go.
 *
 * The legacy path must be a DIRECTORY to count: `existsSync` alone is true for
 * a plain file, which would declare a fresh machine "legacy" and then fail
 * every create against a path that cannot hold projects.
 */
export function shouldUseLegacyRoot(facts: {
  remembered?: "legacy" | "current";
  legacyIsDirectory: boolean;
}): boolean {
  if (facts.remembered) return facts.remembered === "legacy";
  return facts.legacyIsDirectory;
}

/** What to write down, given the answer. */
export function rememberedRootFor(useLegacy: boolean): "legacy" | "current" {
  return useLegacy ? "legacy" : "current";
}

/** globalState key holding {@link shouldUseLegacyRoot}'s `remembered`. */
export const PROJECT_ROOT_CHOICE_KEY = "grok.projectRootChoice";

/** The new root, for callers answering {@link shouldUseLegacyRoot}. */
export function currentProjectRootPath(homeDir: string): string {
  return path.join(homeDir, PROJECT_ROOT_DIRNAME);
}

/** What a caller must stat to answer {@link projectRoot}'s `legacyRootExists`. */
export function legacyProjectRootPath(homeDir: string): string {
  return path.join(homeDir, LEGACY_PROJECT_ROOT_DIRNAME);
}

/** `~/Grok Build`-style display form, so the UI never prints a home path. */
export function displayPath(fullPath: string, homeDir: string): string {
  if (!homeDir) return fullPath;
  const rel = path.relative(homeDir, fullPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return fullPath;
  return `~/${rel.split(path.sep).join("/")}`;
}

/**
 * Why this name cannot become a folder, or null if it can.
 *
 * Messages are the user-facing copy — they say what is wrong and what to do,
 * because the alternative is a native error about an invalid argument.
 */
export function projectNameError(raw: unknown): string | null {
  if (typeof raw !== "string") return "Enter a name for the project.";
  const name = raw.trim();
  if (!name) return "Enter a name for the project.";
  if (name.length > PROJECT_NAME_MAX) {
    return `Names are limited to ${PROJECT_NAME_MAX} characters.`;
  }
  if (ILLEGAL_NAME_CHARS.test(name)) {
    return "A name can't contain \\ / : * ? \" < > or |.";
  }
  // "." and ".." are directory entries, not names; a leading dot merely hides
  // the folder, which is a surprise rather than an error but not what anyone
  // meant to ask for on this screen.
  if (/^\.+$/.test(name)) return "Choose a name, not dots.";
  if (name.startsWith(".")) return "A name starting with a dot would hide the folder.";
  // Windows silently strips these, so `Report.` becomes `Report` and the folder
  // the user is then looking at is not the one they named.
  if (/[. ]$/.test(name)) return "A name can't end with a space or a dot.";
  const stem = name.split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) {
    return `"${name}" is a reserved name on Windows.`;
  }
  return null;
}

/**
 * Where a named project goes, or null if the name is unusable.
 *
 * The containment check is deliberately made against the RESOLVED path rather
 * than trusted from the validation above: the two disagreeing is exactly the
 * bug class this guards, and one cheap comparison beats reasoning about which
 * separator a platform folds.
 */
export function projectDestination(root: string, name: string): string | null {
  if (projectNameError(name)) return null;
  const full = path.resolve(root, name.trim());
  return withinRoot(root, full) ? full : null;
}

/** Whether `candidate` is a direct child of `root`. Case-folded on Windows. */
export function withinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  // A direct child only — nothing may write into a nested path a name implied.
  return !rel.includes(path.sep);
}

/**
 * Git remotes we will hand to `git clone`, and the folder each produces.
 *
 * Deliberately a small allowlist rather than a blocklist. Git's remote syntax
 * reaches further than it looks: `ext::sh -c ...` runs a command, and a URL
 * beginning with `-` is read by git as an OPTION, which is how
 * `--upload-pack=<anything>` becomes arbitrary execution even though the args
 * are passed as an array and never touch a shell. Both are refused here rather
 * than sanitised.
 */
/** `owner/repo` as GitHub itself accepts it — no extra path, no scheme. */
const GITHUB_OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

/**
 * Turn a typed clone target into a URL git can clone.
 *
 * `owner/repo` becomes `https://github.com/owner/repo`. Anything else is
 * returned trimmed, for `cloneUrlError` to accept or refuse. Never inserts a
 * token into the URL.
 */
export function normalizeCloneUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const nwo = trimmed.replace(/\.git$/i, "");
  if (GITHUB_OWNER_REPO.test(nwo)) return `https://github.com/${nwo}`;
  return trimmed;
}

function httpUrlHasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !!(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

export function cloneUrlError(raw: unknown): string | null {
  if (typeof raw !== "string") return "Paste a repository URL or owner/repo.";
  const url = normalizeCloneUrl(raw);
  if (!url) return "Paste a repository URL or owner/repo.";
  if (url.length > 512) return "That URL is too long.";
  if (/\s/.test(url)) return "That doesn't look like a repository URL.";
  // Argument injection: git reads a leading dash as a flag, not an address.
  if (url.startsWith("-")) return "That doesn't look like a repository URL.";
  // A token in the URL is written into `.git/config` on a machine the person
  // may never inspect. We never construct one; we also refuse to clone one.
  if (httpUrlHasUserinfo(url)) {
    return "Don't put a token in the URL. Connect GitHub instead.";
  }
  const httpish = /^https?:\/\/[^/]+\/.+/i.test(url);
  const sshUrl = /^ssh:\/\/[^/]+\/.+/i.test(url);
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^:]+$/.test(url);
  if (!httpish && !sshUrl && !scp) {
    return "Use an https:// URL, git@, or owner/repo.";
  }
  if (!repoNameFromCloneUrl(url)) return "That URL doesn't name a repository.";
  return null;
}

/**
 * The folder `git clone <url>` would create — the last path segment, minus
 * `.git`, minus any query or fragment.
 *
 * Returns null when the result would not be a usable folder name, which is the
 * same test the typed-name path uses. A URL ending in `/` or naming only a host
 * gets nothing rather than an empty folder.
 */
export function repoNameFromCloneUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  url = url.split("#")[0].split("?")[0].replace(/\/+$/, "");
  // Drop the scheme, then everything up to and including the host separator.
  // Doing this BEFORE taking the last segment is what stops `https://github.com`
  // — a URL naming only a host — from producing a project called "github.com".
  url = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  const cut = url.search(/[/:]/);
  if (cut < 0) return null;
  const afterHost = url.slice(cut + 1);
  if (!afterHost) return null;
  const segment = afterHost.split(/[/:]/).pop() || "";
  const name = segment.replace(/\.git$/i, "").trim();
  if (!name) return null;
  return projectNameError(name) ? null : name;
}

/** Where a cloned repository lands, or null if the URL yields no usable name. */
export function cloneDestination(root: string, url: string): string | null {
  const name = repoNameFromCloneUrl(normalizeCloneUrl(url) ?? url);
  return name ? projectDestination(root, name) : null;
}

/**
 * Classify a failed `git clone` from its combined output.
 *
 * The point is not diagnosis for its own sake — it decides which affordance the
 * form offers next. An authentication failure is the one case where we can do
 * something FOR the user (run `gh auth login`), and a missing `gh` is the one
 * before that. Everything else is reported as-is, because guessing at a network
 * or a typo'd URL helps nobody.
 */
export type CloneFailure = "auth" | "not-found" | "exists" | "no-git" | "other";

export function classifyCloneFailure(output: string): CloneFailure {
  const text = String(output || "").toLowerCase();
  if (/could not resolve host|connection refused|network is unreachable|timed out/.test(text)) {
    return "other";
  }
  if (/'git' is not recognized|command not found: git|spawn git enoent|no such file or directory: git/.test(text)) {
    return "no-git";
  }
  if (/already exists and is not an empty directory|destination path .* already exists/.test(text)) {
    return "exists";
  }
  if (
    /authentication failed|could not read username|permission denied \(publickey\)|invalid username or password|terminal prompts disabled|403 forbidden/.test(text)
  ) {
    return "auth";
  }
  // GitHub answers a private repo you cannot see with a 404, not a 403 — so a
  // "not found" on github.com is far more often a permissions problem than a
  // typo, and offering sign-in there is the useful answer.
  if (/repository not found|not found|404/.test(text)) return "not-found";
  return "other";
}

/**
 * What to tell the user about a failed clone.
 *
 * Git's own output is the last resort, not the first: `fatal: could not read
 * Username for 'https://github.com': terminal prompts disabled` is accurate and
 * says nothing a person can act on. Where we recognise the failure we say what
 * it means; where we do not, we pass the real text through rather than
 * inventing a friendlier lie.
 */
export function cloneFailureText(kind: CloneFailure, raw: string): string {
  switch (kind) {
    case "no-git":
      return "Git isn't installed on this machine. Install it, then try again.";
    case "exists":
      return "There's already a folder with that name.";
    case "auth":
      return "Git couldn't authenticate. If the repository is private, you need to sign in first.";
    case "not-found":
      // GitHub answers a private repo you cannot see with a 404, so "not found"
      // and "not allowed" are the same message from the outside.
      return "That repository wasn't found. Check the URL — or sign in, if it's private.";
    default:
      return lastMeaningfulLine(raw) || "The clone failed.";
  }
}

/** The last non-empty line of git's output, trimmed of its `fatal:` prefix. */
function lastMeaningfulLine(raw: string): string {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1] || "";
  return line.replace(/^fatal:\s*/i, "").slice(0, 300);
}

/**
 * Whether a failed clone should offer to set up GitHub access.
 *
 * Only for github.com — pointing someone at `gh auth login` after a GitLab
 * failure is advice that cannot help, and this is the difference between a
 * useful next step and a wrong one.
 */
export function offersGithubSetup(url: string, failure: CloneFailure): boolean {
  if (failure !== "auth" && failure !== "not-found") return false;
  return /(^|[@/.])github\.com([/:]|$)/i.test(String(url || ""));
}

/**
 * How to install the GitHub CLI on this platform, if we know.
 *
 * Returned as argv rather than a string so the caller starts a process instead
 * of handing a line to a shell, and as `display` so the UI can name the command
 * before running it. Nobody should be asked to approve a command they cannot
 * read.
 */
export interface InstallCommand {
  display: string;
  file: string;
  args: string[];
}

/**
 * The command that signs GitHub in AND wires it into git.
 *
 * `gh auth login` alone is not enough, which is the whole reason this exists as
 * a named thing. It stores a token for `gh` and then ASKS whether to configure
 * git — and on a machine where git already authenticates through Git Credential
 * Manager, answering no leaves the clone failing exactly as before while the
 * user has every reason to believe they just signed in. `gh auth setup-git`
 * writes the `credential.https://github.com.helper` entry that actually puts gh
 * in git's path, and it is idempotent, so running it when the prompt already
 * did costs nothing.
 *
 * Windows gets PowerShell syntax because that is the shell both hosts open
 * there — the desktop plan runs `powershell.exe -NoExit`, and it is VS Code's
 * default on Windows. Windows PowerShell 5.1 has no `&&`.
 */
export function githubSignInCommand(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "gh auth login; if ($?) { gh auth setup-git }"
    : "gh auth login && gh auth setup-git";
}

/** Where to send someone whose platform has no package manager we can drive. */
export const GITHUB_CLI_DOWNLOAD = "cli.github.com";

/**
 * What to offer when a clone failed on credentials.
 *
 * Three answers, not two, because "install it with brew" is useless advice to
 * the many Mac users who have never installed Homebrew — and `winget` is absent
 * on older Windows for the same reason. So the package manager has to be on the
 * machine before its command is worth naming; otherwise the honest answer is
 * the download page.
 *
 * `onPath` is injected so this stays pure and the decision is testable without
 * a particular machine's software installed.
 */
export type GithubFix =
  | { kind: "auth" }
  | { kind: "install"; command: string }
  | { kind: "download"; where: string };

export function githubFixFor(
  platform: NodeJS.Platform,
  onPath: (command: string) => boolean,
): GithubFix {
  if (onPath("gh")) return { kind: "auth" };
  const install = githubCliInstallCommand(platform);
  if (install && onPath(install.file)) {
    return { kind: "install", command: install.display };
  }
  return { kind: "download", where: GITHUB_CLI_DOWNLOAD };
}

export function githubCliInstallCommand(platform: NodeJS.Platform): InstallCommand | null {
  if (platform === "win32") {
    return { display: "winget install --id GitHub.cli -e", file: "winget", args: ["install", "--id", "GitHub.cli", "-e"] };
  }
  if (platform === "darwin") {
    return { display: "brew install gh", file: "brew", args: ["install", "gh"] };
  }
  if (platform === "linux") {
    // Debian/Ubuntu is the only family we can guess at with any confidence, and
    // guessing wrong here wastes a terminal rather than breaking anything.
    return { display: "sudo apt install gh", file: "sudo", args: ["apt", "install", "gh"] };
  }
  return null;
}
