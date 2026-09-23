/**
 * Plan-mode enforcement policy (pure).
 *
 * grok's `x.ai/exit_plan_mode` treats *any* client response as approval, so we
 * cannot reject a plan at the protocol layer. Instead we enforce plan/act on
 * our side at the server→client hooks the agent still reaches:
 *
 *   - `terminal/create` — every shell command. Load-bearing on every supported
 *     grok: Plan still hands mutating shells to the client.
 *   - `fs/write_text_file` — workspace writes, when they are delegated.
 *
 * On a live-verified grok >= 1.0.4 we withhold `readTextFile`, the CLI treats
 * client fs as all-or-nothing, and writes are not delegated. Plan-mode file
 * safety then rests on grok's native edit refusal; only terminal mutations
 * remain extension-enforced. The write handler + this gate stay so a later
 * CLI that honours `writeTextFile` independently still has the hook, and so
 * 0.2.x / unverified (which still advertise the delegated handshake) is
 * unchanged.
 *
 * Empirically (grok 0.2.3–0.2.117, ACP, delegated fs), a plan-mode turn only
 * *reads* the workspace and writes its plan to
 * `~/.grok/sessions/<cwd>/<id>/plan.md`. The gate therefore refuses every
 * other file write, including writes outside the workspace.
 *
 * These functions are pure so the policy can be unit-tested without spawning a
 * CLI; `acp.ts` / `sidebar.ts` call them with the live path/command strings.
 */

import * as nodePath from "node:path";

/** JSON-RPC error code we use when refusing a mutating call during plan mode. */
export const PLAN_BLOCKED_CODE = -32010;
export const PLAN_BLOCKED_WRITE_MSG =
  "Blocked by Plan mode: only Grok's session plan.md may be written before you approve the plan.";
export const PLAN_BLOCKED_TERMINAL_MSG =
  "Blocked by Plan mode: approve the plan before running commands that may change the workspace.";

/**
 * Strip the Windows extended-length prefix (`\\?\` or `//?/`), normalize all
 * separators to `/`, collapse `.`/`..` segments, and drop a trailing slash.
 * Drive-letter / backslash paths are treated as Windows and lower-cased for a
 * case-insensitive compare; POSIX paths stay case-sensitive.
 */
function canonical(p: string): { norm: string; windows: boolean } {
  let s = String(p || "").trim();
  const windows = /^[\\/]{2}\?[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.includes("\\");
  s = s.replace(/^[\\/]{2}\?[\\/]/, ""); // \\?\C:\... → C:\...
  s = s.replace(/\\/g, "/");
  s = nodePath.posix.normalize(s);
  s = s.replace(/\/+$/, ""); // drop trailing slash (but keep "/" root)
  if (s === "") s = "/";
  return { norm: windows ? s.toLowerCase() : s, windows };
}

function isAbsolutePath(p: string): boolean {
  const s = String(p || "").trim();
  return /^[\\/]{2}\?[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s) ||
    s.startsWith("/") || s.startsWith("\\");
}

function canonicalTarget(target: string, root: string): { norm: string; windows: boolean } {
  if (isAbsolutePath(target)) return canonical(target);
  const r = canonical(root);
  const t = canonical(target);
  const norm = nodePath.posix.normalize(`${r.norm}/${t.norm}`);
  return { norm: r.windows ? norm.toLowerCase() : norm, windows: r.windows };
}

/**
 * True if `target` resolves to `root` itself or somewhere beneath it. Used to
 * decide whether a write lands in the user's workspace (block) or outside it
 * (allow). Grok's own `~/.grok/.../plan.md` is handled separately because a
 * user may open their home directory as the workspace root.
 */
export function isInsideWorkspace(target: string, root: string): boolean {
  if (!target || !root) return false;
  const t = canonicalTarget(target, root).norm;
  const r = canonical(root).norm;
  if (r === "/" ) return t === "/" || t.startsWith("/");
  return t === r || t.startsWith(r + "/");
}

/** Tool-call `kind`s that mutate state and must be rejected while planning. */
const MUTATING_KINDS = new Set(["edit", "execute", "delete", "move", "write"]);

/** Read-only `kind`s the agent may use freely while planning. */
export function isMutatingKind(kind: string | undefined): boolean {
  return MUTATING_KINDS.has(String(kind || "").toLowerCase());
}

export type ShellDialect = "posix" | "powershell" | "cmd";

interface ShellToken {
  value: string;
  /** True only when a glob metacharacter was unquoted and therefore active. */
  activeGlob: boolean;
}

function isShellBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch) || ";|&".includes(ch);
}

/**
 * Return the last character of a redirection that cannot touch a file.
 * File-naming targets and every unrecognised redirection form fail closed.
 */
function safeRedirectionEnd(
  command: string,
  operatorStart: number,
  dialect: ShellDialect,
): number | undefined {
  let i = operatorStart;
  if (command[i] !== ">") return undefined;
  i++;
  if (command[i] === ">") i++;
  else if (dialect === "posix" && command[i] === "|") i++;

  if (command[i] === "&") {
    i++;
    const streamStart = i;
    while (/[0-9]/.test(command[i] || "")) i++;
    if (i === streamStart && !(dialect === "posix" && command[i++] === "-")) {
      return undefined;
    }
    return isShellBoundary(command[i]) ? i - 1 : undefined;
  }

  while (/\s/.test(command[i] || "")) i++;
  const sink = dialect === "powershell" ? "$null" :
    dialect === "cmd" ? "nul" : "/dev/null";
  if (command.slice(i, i + sink.length).toLowerCase() !== sink) return undefined;
  i += sink.length;
  if (dialect === "cmd" && command[i] === ":") i++;
  return isShellBoundary(command[i]) ? i - 1 : undefined;
}

/**
 * Tokenize the deliberately small shell subset that plan mode permits.
 *
 * Quotes are removed and escape syntax is normalized before option checks, so
 * `-de\lete` and `-de"lete"` both become the dangerous argv token `-delete`.
 * Expansion or execution syntax (`$`, command substitution, file-targeting
 * redirects, script blocks, splatting, and so on) fails closed. Quoted
 * operators and globs remain literal data. Unbalanced quotes/escapes also fail
 * closed.
 */
function tokenizeReadOnlyCommand(
  command: string,
  dialect: ShellDialect,
): ShellToken[][] | undefined {
  const stages: ShellToken[][] = [];
  let stage: ShellToken[] = [];
  let value = "";
  let activeGlob = false;
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const finishToken = () => {
    if (!tokenStarted) return;
    stage.push({ value, activeGlob });
    value = "";
    activeGlob = false;
    tokenStarted = false;
  };
  const finishStage = (): boolean => {
    finishToken();
    if (stage.length === 0) return false;
    stages.push(stage);
    stage = [];
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote === "single") {
      if (ch === "'") {
        // PowerShell represents a literal single quote inside a single-quoted
        // string by doubling it.
        if (dialect === "powershell" && command[i + 1] === "'") {
          value += "'";
          i++;
        } else {
          quote = undefined;
        }
      } else {
        value += ch;
      }
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = undefined;
        continue;
      }
      // Both POSIX and PowerShell expand these inside double quotes. Even an
      // escaped spelling is rejected rather than trying to prove it inert.
      if ((dialect === "posix" || dialect === "powershell") &&
          (ch === "$" || ch === "`")) return undefined;
      if (dialect === "cmd" && ch === "!") return undefined;
      if (dialect === "cmd" && ch === "%" && command.indexOf("%", i + 1) >= 0) {
        return undefined;
      }
      if (dialect === "posix" && ch === "\\") {
        const next = command[i + 1];
        if (next === undefined || next === "\r" || next === "\n") return undefined;
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          value += next;
          i++;
        } else {
          value += "\\";
        }
        continue;
      }
      value += ch;
      continue;
    }

    if (ch === "\r" || ch === "\n") return undefined;
    if (/\s/.test(ch)) {
      finishToken();
      continue;
    }
    if (ch === "'" && dialect !== "cmd") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }

    // A numeric file-descriptor prefix is syntax only at a token boundary.
    if (!tokenStarted && /[0-9]/.test(ch)) {
      let redirect = i;
      while (/[0-9]/.test(command[redirect] || "")) redirect++;
      if (command[redirect] === ">") {
        const end = safeRedirectionEnd(command, redirect, dialect);
        if (end === undefined) return undefined;
        i = end;
        continue;
      }
    }
    // PowerShell's `*>` redirects every stream. Bash's `&>` redirects stdout
    // and stderr. They are harmless only when the exact target is the dialect's
    // null sink.
    if (dialect === "powershell" && !tokenStarted && ch === "*" &&
        command[i + 1] === ">") {
      const end = safeRedirectionEnd(command, i + 1, dialect);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (dialect === "posix" && ch === "&" && command[i + 1] === ">") {
      const end = safeRedirectionEnd(command, i + 1, dialect);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (ch === ">") {
      const end = safeRedirectionEnd(command, i, dialect);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }

    if (ch === "&") {
      if (command[i + 1] !== "&" || !finishStage()) return undefined;
      i++;
      continue;
    }
    if (ch === "|") {
      if (!finishStage()) return undefined;
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (ch === ";") {
      if (!finishStage()) return undefined;
      continue;
    }

    // Input redirection, grouping/script syntax, substitutions, comments, and
    // PowerShell splatting are never needed for read-only exploration.
    if ("<>(){}$#@".includes(ch)) return undefined;
    if (ch === "`") {
      if (dialect !== "powershell") return undefined;
      const next = command[i + 1];
      if (next === undefined || next === "\r" || next === "\n") return undefined;
      value += next;
      tokenStarted = true;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (dialect === "posix") {
        const next = command[i + 1];
        if (next === undefined || next === "\r" || next === "\n") return undefined;
        value += next;
        tokenStarted = true;
        i++;
      } else {
        value += ch;
        tokenStarted = true;
      }
      continue;
    }
    if (ch === "^" && dialect === "cmd") {
      const next = command[i + 1];
      if (next === undefined || next === "\r" || next === "\n") return undefined;
      value += next;
      tokenStarted = true;
      i++;
      continue;
    }
    if (ch === "!" && dialect === "cmd") return undefined;
    // PowerShell's stop-parsing token hands the rest of the line to a native
    // program with different rules (including `%ENV%` expansion). Keeping it
    // out of the accepted subset avoids a second grammar inside one command.
    if (ch === "%" && dialect === "powershell" && value === "--") return undefined;
    if (ch === "%" && dialect === "cmd" && command.indexOf("%", i + 1) >= 0) {
      return undefined;
    }
    if (ch === "~" && (!tokenStarted || value.endsWith("="))) return undefined;

    if (ch === "*" || ch === "?" || ch === "[") activeGlob = true;
    value += ch;
    tokenStarted = true;
  }

  if (quote) return undefined;
  finishToken();
  if (stage.length > 0) stages.push(stage);
  else if (!command.trimEnd().endsWith(";")) return undefined;
  return stages;
}

/** The same fail-closed grammar as Plan, without its read-only argv policy.
 * Keep the literal executable token: basename/alias/wildcard matching would
 * grant programs the user never named on the card. */
export function commandProgramsForGrant(command: string, dialect: ShellDialect): string[] | undefined {
  return commandStagesForGrant(command, dialect)?.map((argv) => argv[0]);
}

/** Every pipeline/sequence stage as its literal argv, under the same
 * fail-closed grammar as {@link commandProgramsForGrant}. Undefined when any
 * stage cannot be proven to be a plain program invocation. */
export function commandStagesForGrant(command: string, dialect: ShellDialect): string[][] | undefined {
  if (!command.trim() || /[\r\n]/.test(command)) return undefined;
  const stages = tokenizeReadOnlyCommand(command, dialect);
  if (!stages?.length || stages.some(([head]) => !head?.value || head.activeGlob ||
    // The tokenizer leaves argv policy to its caller. An assignment prefix
    // isn't an executable: granting FOO=1 would otherwise cover FOO=1 rm.
    (dialect === "posix" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(head.value)))) return undefined;
  return stages.map((tokens) => tokens.map((t) => t.value));
}

const READONLY_HEADS = new Set([
  // POSIX
  "ls", "dir", "pwd", "cd", "echo", "cat", "type", "head", "tail", "less", "more",
  "grep", "rg", "ag", "ack", "find", "fd", "tree", "wc", "stat", "file", "which",
  "where", "whereis", "basename", "dirname", "realpath", "readlink", "du", "df",
  "printenv", "date", "whoami", "hostname", "uname", "sort", "uniq", "cut",
  // Pure inspection/filter programs with no file-writing or command-execution
  // mode. Keep mixed-purpose tools (sips, plutil, diff, xattr, sysctl, etc.)
  // behind argument-aware rules below instead.
  "cmp", "comm", "jq", "mdls", "afinfo", "sw_vers", "shasum", "md5", "cksum",
  "strings", "hexdump", "od", "nl", "paste", "join", "tr", "column",
  "ps", "id", "groups", "locale", "otool", "nm", "size",
  // PowerShell read-only cmdlets + aliases. Inspection/formatting only — anything
  // that writes (out-file, set-content, tee-object, export-*) or executes
  // (foreach-object, where-object, invoke-expression/iex, invoke-command, start-process)
  // is deliberately excluded, so a pipeline containing one is blocked.
  "get-childitem", "gci", "get-content", "gc", "get-item", "gi",
  "get-itemproperty", "gp", "test-path", "resolve-path", "rvpa", "get-location", "gl",
  "select-object", "select", "format-table", "ft", "format-list", "fl", "format-wide", "fw",
  "sort-object", "measure-object", "measure", "select-string", "sls", "out-string",
  "get-command", "gcm", "get-help", "get-member", "gm", "compare-object",
  "write-output",
]);

const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree",
  "rev-parse", "blame", "describe", "shortlog", "cat-file", "name-rev",
  "whatchanged", "show-ref", "for-each-ref", "merge-base", "check-ignore",
  "check-attr",
]);

const PKG_READONLY = new Set(["ls", "list", "view", "info", "outdated", "why", "show", "audit"]);

const GIT_BRANCH_READONLY_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list",
  "--show-current", "--merged", "--no-merged", "--contains", "--no-contains",
  "--points-at", "--color", "--no-color", "--column", "--no-column",
]);
const GIT_BRANCH_READONLY_PREFIXES = ["--format=", "--sort=", "--color=", "--column="];

const GIT_TAG_READONLY_FLAGS = new Set([
  "-l", "--list", "-n", "--contains", "--no-contains", "--points-at",
  "--merged", "--no-merged", "--color", "--no-color", "--column", "--no-column",
]);
const GIT_TAG_READONLY_PREFIXES = ["-n", "--format=", "--sort=", "--color=", "--column="];

const GIT_WRITE_OUTPUT_OPTIONS = [
  "--output=", "--output-directory=",
];

function hasToken(tokens: string[], ...blocked: string[]): boolean {
  return tokens.some((t) => blocked.includes(t));
}

function hasTokenPrefix(tokens: string[], ...prefixes: string[]): boolean {
  return tokens.some((t) => prefixes.some((p) => t.startsWith(p)));
}

function activeGlobMatches(pattern: string, candidate: string): boolean {
  // Bracket expressions have enough edge cases that uncertainty should block.
  if (pattern.includes("[")) return true;
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(source + "$", "i").test(candidate);
}

function activeGlobCanProducePrefix(pattern: string, prefix: string): boolean {
  const firstGlob = pattern.search(/[*?[]/);
  const literalPrefix = firstGlob < 0 ? pattern : pattern.slice(0, firstGlob);
  return literalPrefix === "" ||
    prefix.toLowerCase().startsWith(literalPrefix.toLowerCase()) ||
    literalPrefix.toLowerCase().startsWith(prefix.toLowerCase());
}

function hasDangerousToken(
  tokens: ShellToken[],
  exact: string[],
  prefixes: string[] = [],
): boolean {
  return tokens.some((token) => {
    const value = token.value.toLowerCase();
    if (exact.includes(value) || prefixes.some((prefix) => value.startsWith(prefix))) return true;
    return token.activeGlob && (
      exact.some((candidate) => activeGlobMatches(value, candidate)) ||
      prefixes.some((prefix) => activeGlobCanProducePrefix(value, prefix))
    );
  });
}

function hasGitWriteOption(tokens: ShellToken[]): boolean {
  return hasDangerousToken(
    tokens,
    ["--output", "--output-directory", "--ext-diff"],
    GIT_WRITE_OUTPUT_OPTIONS,
  );
}

function allReadOnlyOptionTokens(tokens: string[], exact: Set<string>, prefixes: string[]): boolean {
  return tokens.every((t) => exact.has(t) || prefixes.some((p) => t.startsWith(p)));
}

function hasSedInPlace(tokens: string[]): boolean {
  return tokens.some((t) => /^-[a-z]*i([a-z]|\b)/i.test(t) || t.startsWith("--in-place"));
}

function hasOutputOption(tokens: ShellToken[]): boolean {
  return hasDangerousToken(tokens, ["-o", "/o", "--output"], ["-o", "--output="]);
}

function isReadOnlySips(tokens: ShellToken[]): boolean {
  const harmlessOptions = new Set([
    "-1", "--oneLine", "--verify",
    "-h", "--help", "-H", "--helpProperties",
    "-v", "--version", "--formats", "--debug",
  ]);
  let getters = 0;
  let inputs = 0;

  for (let i = 1; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (value === "-g" || value === "--getProperty") {
      const property = tokens[++i]?.value;
      if (!property || property.startsWith("-")) return false;
      getters++;
      continue;
    }
    if (value.startsWith("-")) {
      if (!harmlessOptions.has(value)) return false;
      continue;
    }
    inputs++;
  }

  return getters > 0 && inputs > 0;
}

function isReadOnlyPlutil(tokens: ShellToken[]): boolean {
  // `plutil -p file` pretty-prints to stdout. All editing/conversion/extract
  // forms stay blocked rather than trying to reason about their output target.
  if (tokens.length < 3 || tokens[1].value !== "-p") return false;
  return tokens.slice(2).every((token) => !token.value.startsWith("-"));
}

function isReadOnlyDiff(tokens: ShellToken[]): boolean {
  return !hasDangerousToken(
    tokens.slice(1),
    ["-o", "--output"],
    ["--output="],
  );
}

function isReadOnlyGit(tokens: ShellToken[]): boolean {
  const values = tokens.map((token) => token.value.toLowerCase());
  const sub = values[1] || "";
  const args = values.slice(2);
  const argTokens = tokens.slice(2);
  if (hasGitWriteOption(argTokens)) return false;
  if (sub === "tag") return args.length === 0 ||
    allReadOnlyOptionTokens(args, GIT_TAG_READONLY_FLAGS, GIT_TAG_READONLY_PREFIXES);
  if (sub === "branch") return args.length === 0 ||
    allReadOnlyOptionTokens(args, GIT_BRANCH_READONLY_FLAGS, GIT_BRANCH_READONLY_PREFIXES);
  if (sub === "remote") {
    if (args.length === 0 || allReadOnlyOptionTokens(args, new Set(["-v", "--verbose"]), [])) return true;
    const action = args.find((a) => !a.startsWith("-"));
    return action === "show" || action === "get-url";
  }
  if (sub === "reflog") {
    if (args.length === 0) return true;
    const action = args.find((a) => !a.startsWith("-")) || "show";
    return action === "show";
  }
  if (sub === "config") {
    if (args.length === 0) return false;
    if (args.length === 1 && !args[0].startsWith("-")) return true;
    return hasToken(args, "-l", "--list") ||
      hasTokenPrefix(args, "--get", "--get-regexp", "--show-origin", "--show-scope");
  }
  if (sub === "grep") {
    // `-O` / `--open-files-in-pager` executes an arbitrary configured or
    // supplied pager. Ordinary grep output is inspection-only.
    return !argTokens.some((token) =>
      token.value === "-O" ||
      token.value.startsWith("-O") ||
      token.value.startsWith("--open"));
  }
  return GIT_READONLY.has(sub);
}

function isReadOnlyPackageCommand(tokens: ShellToken[]): boolean {
  const values = tokens.map((token) => token.value.toLowerCase());
  const sub = values[1] || "";
  const args = values.slice(2);
  if (!PKG_READONLY.has(sub)) return false;
  if (sub === "audit" &&
      hasDangerousToken(tokens.slice(2), ["fix", "--fix"], ["--fix="])) return false;
  return true;
}

/** One pipeline stage: read-only iff its head token is a known read-only program. */
function isReadOnlyStage(tokens: ShellToken[]): boolean {
  if (!tokens[0]) return false;
  const lowerTokens = tokens.map((token) => token.value.toLowerCase());
  const head = lowerTokens[0].replace(/\.(exe|cmd|bat)$/i, "");

  if (head === "git") {
    return isReadOnlyGit(tokens);
  }
  if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
    return isReadOnlyPackageCommand(tokens);
  }
  if (head === "node" || head === "python" || head === "python3" || head === "deno") {
    // Only allow trivially read-only invocations like `node --version`.
    return tokens.length >= 2 && /^(-v|--version|--help|-h)$/.test(tokens[1].value);
  }
  if (head === "sips") return isReadOnlySips(tokens);
  if (head === "plutil") return isReadOnlyPlutil(tokens);
  if (head === "diff") return isReadOnlyDiff(tokens);
  if (head === "sed" && hasSedInPlace(lowerTokens.slice(1))) return false;
  if (head === "find" && hasDangerousToken(
    tokens.slice(1),
    ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"],
  )) return false;
  if (head === "fd" &&
      hasDangerousToken(tokens.slice(1), ["-x", "--exec", "--exec-batch"])) return false;
  if ((head === "sort" || head === "tree") && hasOutputOption(tokens.slice(1))) return false;
  return READONLY_HEADS.has(head);
}

function isReadOnlySimpleCommand(command: string, dialect: ShellDialect): boolean {
  const stages = tokenizeReadOnlyCommand(command, dialect);
  return !!stages && stages.every(isReadOnlyStage);
}

function skipWhitespace(value: string, start: number): number {
  let i = start;
  while (/\s/.test(value[i] || "")) i++;
  return i;
}

function keywordEnd(value: string, start: number, keyword: string): number | undefined {
  if (value.slice(start, start + keyword.length).toLowerCase() !== keyword) return undefined;
  const end = start + keyword.length;
  return !/[A-Za-z0-9_-]/.test(value[end] || "") ? end : undefined;
}

function quotedRegionEnd(
  value: string,
  start: number,
  open: "(" | "{",
  close: ")" | "}",
): number | undefined {
  let quote: "single" | "double" | undefined;
  for (let i = start + 1; i < value.length; i++) {
    const ch = value[i];
    if (quote === "single") {
      if (ch === "'" && value[i + 1] === "'") i++;
      else if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (ch === "`" && value[i + 1] !== undefined) i++;
      else if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    // Nested grouping/control flow stays outside the admitted grammar.
    if (ch === open || (open === "{" && ch === "(")) return undefined;
    if (ch === close) return i;
    if ((open === "(" && (ch === "{" || ch === "}")) ||
        (open === "{" && ch === "}")) return undefined;
  }
  return undefined;
}

function isLiteralTestPathCondition(condition: string): boolean {
  const testPathEnd = keywordEnd(condition, 0, "test-path");
  if (testPathEnd === undefined || !/\s/.test(condition[testPathEnd] || "")) return false;
  const literal = condition.slice(skipWhitespace(condition, testPathEnd));
  if (!literal) return false;
  if (literal[0] === "'") {
    if (literal[literal.length - 1] !== "'") return false;
    return !/(^|[^'])'(?!')/.test(literal.slice(1, -1));
  }
  if (literal[0] === '"') {
    return literal[literal.length - 1] === '"' &&
      !/[$`"]/.test(literal.slice(1, -1));
  }
  return /^[A-Za-z0-9_./\\:-]+$/.test(literal);
}

function isReadOnlyPowerShellCondition(condition: string): boolean {
  const normalized = condition.trim();
  if (isLiteralTestPathCondition(normalized)) return true;
  if (/^(?:-not\s+)?\$\?$/i.test(normalized)) return true;
  if (/^(?:-not\s+)?\$LASTEXITCODE$/i.test(normalized)) return true;
  return /^\$LASTEXITCODE\s+-(?:eq|ne|gt|ge|lt|le)\s+-?\d+$/i.test(normalized);
}

/**
 * Admit one complete PowerShell control-flow production. Braces remain unsafe
 * everywhere else, and the prefix/branches use the ordinary non-control-flow
 * classifier so nested conditionals cannot recurse through this exception.
 */
function isReadOnlyPowerShellConditional(command: string): boolean {
  let quote: "single" | "double" | undefined;
  let ifStart: number | undefined;
  let prefixEnd = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "single") {
      if (ch === "'" && command[i + 1] === "'") i++;
      else if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (ch === "`" && command[i + 1] !== undefined) i++;
      else if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (i !== 0 && ch !== ";") continue;
    const candidate = skipWhitespace(command, i === 0 ? 0 : i + 1);
    const end = keywordEnd(command, candidate, "if");
    if (end !== undefined) {
      ifStart = candidate;
      prefixEnd = i === 0 ? 0 : i;
      break;
    }
  }
  if (ifStart === undefined) return false;

  const prefix = command.slice(0, prefixEnd).trim();
  if (prefix && !isReadOnlySimpleCommand(prefix, "powershell")) return false;

  let i = skipWhitespace(command, ifStart + 2);
  if (command[i] !== "(") return false;
  const conditionEnd = quotedRegionEnd(command, i, "(", ")");
  if (conditionEnd === undefined ||
      !isReadOnlyPowerShellCondition(command.slice(i + 1, conditionEnd))) return false;

  i = skipWhitespace(command, conditionEnd + 1);
  if (command[i] !== "{") return false;
  const thenEnd = quotedRegionEnd(command, i, "{", "}");
  if (thenEnd === undefined) return false;
  const thenBranch = command.slice(i + 1, thenEnd).trim();

  i = skipWhitespace(command, thenEnd + 1);
  if (i === command.length) {
    return !!thenBranch && isReadOnlySimpleCommand(thenBranch, "powershell");
  }
  const elseEnd = keywordEnd(command, i, "else");
  if (elseEnd === undefined) return false;
  i = skipWhitespace(command, elseEnd);
  if (command[i] !== "{") return false;
  const elseBranchEnd = quotedRegionEnd(command, i, "{", "}");
  if (elseBranchEnd === undefined || command.slice(elseBranchEnd + 1).trim()) return false;
  const elseBranch = command.slice(i + 1, elseBranchEnd).trim();

  return !!thenBranch && !!elseBranch &&
    isReadOnlySimpleCommand(thenBranch, "powershell") &&
    isReadOnlySimpleCommand(elseBranch, "powershell");
}

/**
 * Conservative classifier: a command is "read-only" (safe to run while
 * planning) only if its quote-aware tokenization contains no expansion,
 * file-writing redirection, arbitrary script, or background syntax, AND every
 * sequenced/pipelined stage is itself a known read-only program (with a
 * read-only subcommand for git/npm/pnpm/yarn). Quote removal and escape
 * normalization happen before dangerous-option checks. So
 * `cd repo && git status` and `Get-ChildItem | Select-Object` pass, but
 * `cd repo && npm install`, `git status; rm -rf x`, and `cat x | iex` do not.
 * Everything else is blocked. Errs toward blocking.
 */
export function isReadOnlyCommand(
  command: string,
  dialect: ShellDialect = "posix",
): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (isReadOnlySimpleCommand(cmd, dialect)) return true;
  return dialect === "powershell" && isReadOnlyPowerShellConditional(cmd);
}

export interface PlanGateContext {
  active: boolean;
  workspaceRoot: string;
  grokHome?: string;
  shellDialect?: ShellDialect;
}

/** True only for the canonical Grok-owned `sessions/<cwd>/<id>/plan.md` path. */
export function isGrokOwnedPlanFile(path: string, grokHome: string | undefined): boolean {
  if (!path || !grokHome) return false;
  const target = canonicalTarget(path, grokHome).norm;
  const home = canonical(grokHome).norm;
  if (target === home || !target.startsWith(home + "/")) return false;
  const relative = target.slice(home.length + 1);
  return /^sessions\/[^/]+\/[^/]+\/plan\.md$/i.test(relative);
}

/** Should `fs/write_text_file` to `path` be refused right now? */
export function shouldBlockWrite(path: string, ctx: PlanGateContext): boolean {
  return ctx.active && !isGrokOwnedPlanFile(path, ctx.grokHome);
}

/** Should `terminal/create` of `command` be refused right now? */
export function shouldBlockTerminal(command: string, ctx: PlanGateContext): boolean {
  return ctx.active && !isReadOnlyCommand(command, ctx.shellDialect);
}

export interface PermissionToolCallLike {
  kind?: string;
  rawInput?: unknown;
}

/** Should a `session/request_permission` for `toolCall` be auto-rejected? */
export function shouldRejectPermission(
  toolCall: PermissionToolCallLike | undefined,
  ctx: PlanGateContext,
): boolean {
  if (!ctx.active) return false;
  const kind = String(toolCall?.kind || "").toLowerCase();
  if (kind !== "execute") return isMutatingKind(kind);

  const rawInput = toolCall?.rawInput;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return true;
  const input = rawInput as Record<string, unknown>;
  if (typeof input.command !== "string" || !input.command.trim()) return true;
  if (Object.prototype.hasOwnProperty.call(input, "is_background") && input.is_background !== false) {
    return true;
  }
  return shouldBlockTerminal(input.command, ctx);
}

export interface PermissionOptionLike {
  optionId: string;
  kind: string;
  name?: string;
}

/** Claude/Codex modes that mean Auto accept in the host picker. */
const ADAPTER_AUTO_ACCEPT_MODES = new Set([
  "yolo",
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "agent-full-access",
]);

/**
 * Map an agent-reported mode onto the host's Plan / Auto-accept flags.
 *
 * Grok's `current_mode_update` is descriptive: only a Plan *entry* raises the
 * client gate; a writable mode does not lower it (the verdict / `setMode` own
 * that). Adapters with `usesClientPlanGate === false` are the opposite — the
 * agent's mode is authority, because they switch to a writable mode and then
 * edit (Claude `ExitPlanMode`, Codex plan approval).
 */
export function applyAgentModeToHostPlan(
  modeId: string,
  usesClientPlanGate: boolean,
): { planActive: boolean; autoApprove: boolean } | null {
  if (modeId === "plan") {
    return { planActive: true, autoApprove: false };
  }
  if (usesClientPlanGate) return null;
  return {
    planActive: false,
    autoApprove: ADAPTER_AUTO_ACCEPT_MODES.has(modeId),
  };
}

/**
 * Live Plan bit for a permission decision.
 *
 * Grok commits the client gate in the `session/set_mode` response hook, before
 * the next ACP line in that stdout chunk. Session chrome (`session.planActive`)
 * and `autoApprove` still wait on the host await, so reading those here would
 * auto-grant a same-chunk `request_permission`.
 *
 * Adapters without the fs/terminal gate still raise `client.planActive` on a
 * successful Plan RPC: Codex plan review is an ordinary `request_permission`
 * whose `allow_once` means "implement this plan", and Auto accept would select
 * it. `usesClientPlanGate` stays false, so this bit does not enable grok's
 * write/terminal refusal. The session flag remains a fallback because a
 * `config_option_update` can raise Plan without going through that RPC.
 */
export function effectivePlanActive(
  usesClientPlanGate: boolean,
  clientPlanActive: boolean,
  sessionPlanActive: boolean,
): boolean {
  if (usesClientPlanGate) return clientPlanActive;
  return clientPlanActive || sessionPlanActive;
}

export function permissionOptionsForPlan<T extends PermissionOptionLike>(
  options: T[],
  planActive: boolean,
  toolKind?: string,
): T[] {
  if (!planActive || String(toolKind || "").toLowerCase() !== "execute") return options;
  return options.filter((option) => option.kind !== "allow_always");
}

export function permissionAnswerAllowed(
  options: PermissionOptionLike[],
  optionId: string,
  planActive: boolean,
  toolKind?: string,
): boolean {
  const option = options.find((candidate) => candidate.optionId === optionId);
  if (!option) return false;
  return !(planActive &&
    String(toolKind || "").toLowerCase() === "execute" &&
    option.kind === "allow_always");
}

/**
 * Adapter plan-review rides an ordinary `request_permission` whose allow
 * option means "implement this plan" (Codex `implement_plan`, Claude
 * `acceptEdits` / `default`). Auto accept is consent to routine tool
 * grants, not to that unread card.
 */
export function isPlanReviewPermission(toolKind?: string): boolean {
  return String(toolKind || "").toLowerCase() === "switch_mode";
}

/**
 * Codex puts the plan on `rawInput.plan`. Claude ExitPlanMode puts the same
 * string there and also as a `content` text block. Empty means the adapter
 * asked for a mode change without sending anything to review.
 */
export function planTextFromPermissionToolCall(toolCall?: {
  rawInput?: unknown;
  content?: unknown;
} | null): string {
  const raw = toolCall?.rawInput as { plan?: unknown } | undefined;
  if (typeof raw?.plan === "string" && raw.plan.trim()) return raw.plan;
  const blocks = Array.isArray(toolCall?.content) ? toolCall.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "content" && rec.content && typeof rec.content === "object") {
      const inner = rec.content as Record<string, unknown>;
      if (inner.type === "text" && typeof inner.text === "string" && inner.text.trim()) {
        return inner.text;
      }
    }
    if ((rec.type === "text" || rec.type === "input_text") && typeof rec.text === "string" && rec.text.trim()) {
      return rec.text;
    }
  }
  return "";
}

/** Adapter allow options implement the plan; reject keeps planning. */
export function planReviewVerdictForOption(kind?: string): "approved" | "rejected" {
  return kind && /reject|deny/i.test(kind) ? "rejected" : "approved";
}

/**
 * Pick the option that means "no" from a permission request's options. Prefers
 * an explicit `reject_once`, then any reject/deny kind; returns undefined if the
 * request offers no way to decline (caller should then fall back to the user).
 */
export function pickRejectOption(options: PermissionOptionLike[]): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const exact = options.find((o) => o.kind === "reject_once");
  if (exact) return exact.optionId;
  const anyReject = options.find((o) => /reject|deny|cancel|no/i.test(o.kind));
  return anyReject?.optionId;
}

/**
 * True if `path` is grok's own plan file (`.grok/sessions/.../plan.md`). We
 * still snoop that write as a fallback. Current CLIs send `exit_plan_mode`
 * with `planContent` populated; sidebar.ts prefers `req.plan` over the
 * snooped `lastPlanText`.
 */
export function isPlanFileWrite(path: string): boolean {
  return /[\\/]\.grok[\\/]sessions[\\/].*[\\/]plan\.md$/i.test(String(path || ""));
}
