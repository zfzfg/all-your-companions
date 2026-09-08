/**
 * Granular permission rules (AP-07).
 *
 * The middle ground between "confirm every card" and "Auto accept allows
 * everything": Tool × command-prefix × path-glob → allow / ask / deny.
 *
 * Evaluation order (this string is the UI copy — keep it in one place):
 *
 *   1. The built-in safety floor runs first and cannot be overridden.
 *   2. Then any matching Deny wins.
 *   3. Among remaining matches, the last rule decides (last-match-wins).
 *
 * With no user rules and no floor hit the verdict is `ask`, which is today's
 * behaviour: the host falls through to Auto accept / the card. The floor is
 * a separate, always-on list (delete commands on system paths, writes to
 * credential files) — user rules cannot punch through it.
 *
 * Recipe R7: no vscode, no node:fs, no Date.now. Path I/O takes an injected
 * {@link PermissionRulesFs}. Time and ids are injected at rule creation.
 *
 * Path canonicalization + glob matching are the conflict-checking toolkit
 * AP-08 reuses (`canonicalPath`, `matchPathGlob`, `isPathUnder`).
 */

import { createHash } from "node:crypto";
import * as nodePath from "node:path";

export type PermissionKind = "read" | "edit" | "execute" | "other";
export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionScope = "workspace" | "global";

export interface PermissionRuleMatch {
  tool?: string;
  kind?: PermissionKind;
  commandPrefix?: string;
  pathGlob?: string;
}

export interface PermissionRule {
  id: string;
  match: PermissionRuleMatch;
  action: PermissionAction;
  scope: PermissionScope;
  createdAt: number;
  note?: string;
}

export interface PermissionRequestFacts {
  tool: string;
  kind: PermissionKind;
  command?: string;
  paths: readonly string[];
}

export interface PermissionRuleSuggestion {
  /** Ephemeral id for the submenu, not a persisted rule id. */
  id: string;
  label: string;
  match: PermissionRuleMatch;
  scope: PermissionScope;
}

/** What the settings page paints. Ids starting `socket-` are the floor. */
export interface PermissionRuleView {
  id: string;
  action: PermissionAction | "floor";
  scope: PermissionScope | "floor";
  summary: string;
  detail: string;
  source: "socket" | "workspace" | "global";
  createdAt?: number;
  note?: string;
  deletable: boolean;
}

export interface WorkspaceRulesFile {
  version: 1;
  rules: PermissionRule[];
}

export interface PermissionRulesFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: "utf8") => string;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  writeFileSync: (p: string, data: string) => void;
}

export type PermissionDecision =
  | { action: "ask" }
  | {
      action: "allow" | "deny";
      source: "socket" | "rule";
      ruleId?: string;
      reason: string;
    };

export type AdoptionStatus = "adopted" | "declined";

export interface AdoptionRecord {
  hash: string;
  status: AdoptionStatus;
  at: number;
}

export const PERMISSION_RULES_ORDER_COPY =
  "The built-in safety floor runs first and cannot be overridden. Then any matching Deny wins. Among remaining matches, the last rule decides (last-match-wins).";

export const PERMISSION_RULES_KEY = "grok.permissionRules";
export const PERMISSION_RULES_ADOPTED_KEY = "grok.permissionRulesAdopted";
export const WORKSPACE_RULES_VERSION = 1;
export const WORKSPACE_RULES_REL = ".grok/permissions.json";

/** Display-only floor rows. Not PermissionRules — they cannot be deleted or reordered. */
export const SOCKET_RULE_VIEWS: readonly PermissionRuleView[] = [
  {
    id: "socket-delete-system",
    action: "floor",
    scope: "floor",
    summary: "Delete commands on system paths",
    detail: "rm / del / Remove-Item targeting /, /usr, C:\\Windows, and other OS roots. User rules cannot override this.",
    source: "socket",
    deletable: false,
  },
  {
    id: "socket-credential-write",
    action: "floor",
    scope: "floor",
    summary: "Writes to credential files",
    detail: ".env*, *.pem, id_rsa*, id_ed25519*, *.key — the same names companions.sensitiveFilesWarn already flags. User rules cannot override this.",
    source: "socket",
    deletable: false,
  },
];

const DELETE_HEADS = new Set([
  "rm", "rmdir", "unlink", "del", "erase", "rd",
  "remove-item", "ri",
]);
const SUDO_HEADS = new Set(["sudo", "doas", "runas"]);

const POSIX_SYSTEM_EXACT = new Set([
  "/", "/bin", "/sbin", "/usr", "/etc", "/boot", "/dev", "/proc", "/sys",
  "/root", "/lib", "/lib64", "/system",
]);

const POSIX_SYSTEM_PREFIXES = [
  "/bin/", "/sbin/", "/usr/", "/etc/", "/boot/", "/dev/", "/proc/", "/sys/",
  "/root/", "/lib/", "/lib64/", "/system/",
];

// ---------------------------------------------------------------------------
// Path toolkit (AP-08 reuses these)
// ---------------------------------------------------------------------------

/**
 * Strip the Windows extended-length prefix, normalize separators to `/`,
 * collapse `.`/`..`, drop a trailing slash. Drive-letter / backslash paths
 * are treated as Windows and lower-cased; POSIX stays case-sensitive.
 */
export function canonicalPath(p: string): { norm: string; windows: boolean } {
  let s = String(p || "").trim();
  const windows = /^[\\/]{2}\?[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.includes("\\");
  s = s.replace(/^[\\/]{2}\?[\\/]/, "");
  s = s.replace(/\\/g, "/");
  s = nodePath.posix.normalize(s);
  s = s.replace(/\/+$/, "");
  if (s === "") s = "/";
  return { norm: windows ? s.toLowerCase() : s, windows };
}

/** True if `child` is `parent` or a descendant (segment-boundary, not prefix). */
export function isPathUnder(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const p = canonicalPath(parent);
  const c = canonicalPath(child);
  const windows = p.windows || c.windows;
  const pn = windows ? p.norm.toLowerCase() : p.norm;
  const cn = windows ? c.norm.toLowerCase() : c.norm;
  if (pn === "/") return cn === "/" || cn.startsWith("/");
  return cn === pn || cn.startsWith(pn + "/");
}

function escapeRegex(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Glob match with slash-aware `*` / `**`.
 *
 * `src/**` matches `src`, `src/foo`, `src/foo/bar` — not `srcfoo`.
 * `*` does not cross `/`. Trailing `/**` includes the prefix directory itself.
 */
export function matchPathGlob(glob: string, candidate: string, windows = false): boolean {
  const gRaw = String(glob || "").trim();
  const cRaw = String(candidate || "").trim();
  if (!gRaw || !cRaw) return false;
  const g = canonicalPath(gRaw);
  const c = canonicalPath(cRaw);
  const win = windows || g.windows || c.windows;
  const globNorm = win ? g.norm.toLowerCase() : g.norm;
  const candNorm = win ? c.norm.toLowerCase() : c.norm;
  const source = globToRegExpSource(globNorm);
  if (!source) return false;
  return new RegExp(source).test(candNorm);
}

function globToRegExpSource(glob: string): string | undefined {
  if (!glob) return undefined;
  let i = 0;
  let source = "^";
  while (i < glob.length) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      const next = glob[i + 2];
      if (next === "/" || next === undefined) {
        if (next === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else if (i === glob.length - 2 && source === "^") {
          // bare `**` — match everything. Callers that persist allow-rules
          // reject this glob; matching it here is still defined.
          source += ".*";
          i += 2;
        } else {
          // trailing `/**` after a prefix: `src/**` → `src(?:/.*)?`
          if (source.endsWith("/")) source = source.slice(0, -1);
          source += "(?:/.*)?";
          i += 2;
        }
      } else {
        source += "[^/]*[^/]*";
        i += 2;
      }
    } else if (glob[i] === "*") {
      source += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      source += "[^/]";
      i++;
    } else {
      source += escapeRegex(glob[i]);
      i++;
    }
  }
  return source + "$";
}

/** Relativize `target` against `root` when it sits inside; otherwise undefined. */
export function relativizeToRoot(target: string, root: string): string | undefined {
  if (!target || !root) return undefined;
  const t = canonicalPath(target);
  const r = canonicalPath(root);
  const windows = t.windows || r.windows;
  const tn = windows ? t.norm.toLowerCase() : t.norm;
  const rn = windows ? r.norm.toLowerCase() : r.norm;
  if (tn === rn) return ".";
  if (rn === "/") return tn.replace(/^\//, "") || undefined;
  if (!tn.startsWith(rn + "/")) return undefined;
  return tn.slice(rn.length + 1);
}

function pathMatchesGlob(
  glob: string,
  path: string,
  workspaceRoot?: string,
): boolean {
  const win = canonicalPath(path).windows || canonicalPath(glob).windows ||
    (workspaceRoot ? canonicalPath(workspaceRoot).windows : false);
  if (matchPathGlob(glob, path, win)) return true;
  if (!workspaceRoot) return false;
  const rel = relativizeToRoot(path, workspaceRoot);
  return !!rel && rel !== "." && matchPathGlob(glob, rel, win);
}

// ---------------------------------------------------------------------------
// Kind / command / tool matching
// ---------------------------------------------------------------------------

export function normalizePermissionKind(kind: string | undefined): PermissionKind {
  const k = String(kind || "").toLowerCase();
  if (k === "read") return "read";
  if (k === "execute") return "execute";
  if (k === "edit" || k === "write" || k === "delete" || k === "move") return "edit";
  return "other";
}

function commandMatchesPrefix(command: string | undefined, prefix: string, windows: boolean): boolean {
  if (!prefix) return false;
  const cmd = collapseWs(String(command || ""));
  const pre = collapseWs(prefix);
  if (!cmd || !pre) return false;
  const a = windows ? cmd.toLowerCase() : cmd;
  const b = windows ? pre.toLowerCase() : pre;
  return a === b || a.startsWith(b + " ");
}

function collapseWs(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function toolEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ruleMatches(
  rule: PermissionRule,
  req: PermissionRequestFacts,
  workspaceRoot?: string,
): boolean {
  const m = rule.match;
  if (m.tool && !toolEquals(m.tool, req.tool)) return false;
  if (m.kind && m.kind !== req.kind) return false;
  if (m.commandPrefix) {
    const win = /\.exe$|\.cmd$|\.bat$/i.test(req.command || "") ||
      (req.command || "").includes("\\");
    if (!commandMatchesPrefix(req.command, m.commandPrefix, win)) return false;
  }
  if (m.pathGlob) {
    if (req.paths.length === 0) return false;
    if (rule.action === "deny") {
      return req.paths.some((p) => pathMatchesGlob(m.pathGlob!, p, workspaceRoot));
    }
    return req.paths.every((p) => pathMatchesGlob(m.pathGlob!, p, workspaceRoot));
  }
  return true;
}

export function evaluateRules(
  rules: readonly PermissionRule[],
  req: PermissionRequestFacts,
  workspaceRoot?: string,
): { action: PermissionAction; ruleId?: string } {
  if (!rules.length) return { action: "ask" };
  const matching = rules.filter((r) => ruleMatches(r, req, workspaceRoot));
  if (matching.length === 0) return { action: "ask" };
  const deny = matching.find((r) => r.action === "deny");
  if (deny) return { action: "deny", ruleId: deny.id };
  const last = matching[matching.length - 1];
  return { action: last.action, ruleId: last.id };
}

// ---------------------------------------------------------------------------
// Safety floor (unbypassable)
// ---------------------------------------------------------------------------

function basenameOf(p: string): string {
  const n = canonicalPath(p).norm;
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

/** Same names `findWorkspaceSensitiveFiles` already flags, applied to any path. */
export function isCredentialFilePath(p: string): boolean {
  const base = basenameOf(p).toLowerCase();
  if (!base) return false;
  return base.startsWith(".env") ||
    base.endsWith(".pem") ||
    base.startsWith("id_rsa") ||
    base.startsWith("id_ed25519") ||
    base.endsWith(".key");
}

export function isSystemPath(p: string): boolean {
  const { norm, windows } = canonicalPath(p);
  if (norm === "/") return true;
  if (windows) {
    if (/^[a-z]:$/.test(norm) || /^[a-z]:\/$/.test(norm)) return true;
    if (/^[a-z]:\/windows(\/|$)/.test(norm)) return true;
    if (/^[a-z]:\/program files(\/|$)/.test(norm)) return true;
    if (/^[a-z]:\/program files \(x86\)(\/|$)/.test(norm)) return true;
  }
  const lower = norm.toLowerCase();
  if (POSIX_SYSTEM_EXACT.has(lower)) return true;
  return POSIX_SYSTEM_PREFIXES.some((pre) => lower.startsWith(pre));
}

function splitStages(command: string): string[][] {
  return collapseWs(command)
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((stage) => stage.trim())
    .filter(Boolean)
    .map((stage) => stage.split(/\s+/));
}

function stripExe(head: string): string {
  return head.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function stageIsDelete(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  let i = 0;
  if (SUDO_HEADS.has(stripExe(tokens[0]))) i = 1;
  if (!tokens[i]) return false;
  return DELETE_HEADS.has(stripExe(tokens[i]));
}

function looksLikePathArg(tok: string): boolean {
  if (!tok || tok.startsWith("-")) return false;
  if (tok === "/" || tok === "\\") return true;
  if (tok.startsWith("/") || tok.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(tok)) return true;
  if (tok.includes("/") || tok.includes("\\")) return true;
  return false;
}

export function evaluateSocket(
  req: PermissionRequestFacts,
): { reason: string } | undefined {
  if (req.kind === "edit") {
    const hit = req.paths.find(isCredentialFilePath);
    if (hit) {
      return { reason: `write to credential file ${basenameOf(hit)}` };
    }
  }
  if (req.kind === "execute" && req.command) {
    const stages = splitStages(req.command);
    for (const tokens of stages) {
      if (!stageIsDelete(tokens)) continue;
      for (const tok of tokens) {
        if (!looksLikePathArg(tok)) continue;
        const cleaned = tok.replace(/["']+/g, "");
        if (isSystemPath(cleaned)) {
          return { reason: "delete command on a system path" };
        }
        if (isCredentialFilePath(cleaned)) {
          return { reason: `delete of credential file ${basenameOf(cleaned)}` };
        }
      }
    }
  }
  if (req.kind === "edit") {
    const sys = req.paths.find(isSystemPath);
    if (sys) return { reason: "write on a system path" };
  }
  return undefined;
}

export function decidePermission(
  rules: readonly PermissionRule[],
  req: PermissionRequestFacts,
  workspaceRoot?: string,
): PermissionDecision {
  const socket = evaluateSocket(req);
  if (socket) {
    return { action: "deny", source: "socket", reason: socket.reason };
  }
  const verdict = evaluateRules(rules, req, workspaceRoot);
  if (verdict.action === "ask") return { action: "ask" };
  const rule = rules.find((r) => r.id === verdict.ruleId);
  return {
    action: verdict.action,
    source: "rule",
    ruleId: verdict.ruleId,
    reason: rule ? formatRuleSummary(rule) : verdict.action,
  };
}

export function permissionRulesNotice(decision: Extract<PermissionDecision, { action: "allow" | "deny" }>): string {
  if (decision.source === "socket") {
    return `Denied by the built-in safety floor: ${decision.reason}`;
  }
  const who = decision.ruleId ? ` (${decision.ruleId})` : "";
  if (decision.action === "allow") {
    return `Allowed by rule${who}: ${decision.reason}`;
  }
  return `Denied by rule${who}: ${decision.reason}`;
}

// ---------------------------------------------------------------------------
// Extract facts + suggestions
// ---------------------------------------------------------------------------

const PATH_KEYS = [
  "path", "file_path", "filePath", "target_file", "targetFile",
  "filename", "file", "old_path", "new_path", "oldPath", "newPath",
];

function collectPaths(rawInput: unknown, content: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const rec = rawInput as Record<string, unknown>;
    for (const k of PATH_KEYS) push(rec[k]);
    if (Array.isArray(rec.paths)) rec.paths.forEach(push);
  }
  const blocks = Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    push(rec.path);
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = canonicalPath(p).norm;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractCommand(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return undefined;
  const rec = rawInput as Record<string, unknown>;
  for (const k of ["command", "cmd"]) {
    if (typeof rec[k] === "string" && rec[k].trim()) return rec[k].trim();
  }
  return undefined;
}

function extractToolName(toolCall: { title?: string; rawInput?: unknown }): string {
  const raw = toolCall.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    for (const k of ["tool", "toolName", "name"]) {
      if (typeof rec[k] === "string" && rec[k].trim() && k !== "name") return rec[k].trim();
    }
  }
  return "";
}

export function extractPermissionFacts(
  toolCall: { kind?: string; title?: string; rawInput?: unknown; content?: unknown } | undefined,
): PermissionRequestFacts {
  const raw = toolCall?.rawInput;
  return {
    tool: extractToolName({ title: toolCall?.title, rawInput: raw }),
    kind: normalizePermissionKind(toolCall?.kind),
    command: extractCommand(raw),
    paths: collectPaths(raw, toolCall?.content),
  };
}

function commandHead(command: string): string | undefined {
  const tokens = collapseWs(command).split(" ");
  const head = tokens[0];
  return head ? stripExe(head) : undefined;
}

function commandTwoTokenPrefix(command: string): string | undefined {
  const tokens = collapseWs(command).split(" ");
  if (tokens.length < 2) return undefined;
  if (tokens[1].startsWith("-")) return undefined;
  return `${stripExe(tokens[0])} ${tokens[1]}`;
}

function parentGlob(relPath: string): string | undefined {
  const n = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const i = n.lastIndexOf("/");
  if (i <= 0) return undefined;
  return n.slice(0, i) + "/**";
}

/**
 * Suggestions derived from THIS request, never generic "allow everything".
 * Each suggestion carries a concrete commandPrefix or pathGlob.
 */
export function suggestRules(
  facts: PermissionRequestFacts,
  workspaceRoot?: string,
): PermissionRuleSuggestion[] {
  const out: PermissionRuleSuggestion[] = [];
  const push = (id: string, label: string, match: PermissionRuleMatch) => {
    if (!isConcreteAllowMatch(match)) return;
    out.push({ id, label, match, scope: "workspace" });
  };

  if (facts.kind === "execute" && facts.command) {
    const two = commandTwoTokenPrefix(facts.command);
    const head = commandHead(facts.command);
    if (two) push("cmd-two", two, { kind: "execute", commandPrefix: two });
    if (head && head !== two) {
      push("cmd-head", `${head} *`, { kind: "execute", commandPrefix: head });
    }
  }

  const rels = facts.paths.map((p) => {
    if (!workspaceRoot) return p.replace(/\\/g, "/");
    return relativizeToRoot(p, workspaceRoot) || p.replace(/\\/g, "/");
  }).filter((p) => p && p !== ".");

  if (facts.kind === "read" || facts.kind === "edit") {
    const uniqueRels = [...new Set(rels)];
    for (const rel of uniqueRels.slice(0, 3)) {
      const glob = rel.replace(/\\/g, "/");
      push(`path-${glob}`, glob, { kind: facts.kind, pathGlob: glob });
    }
    const parents = [...new Set(uniqueRels.map(parentGlob).filter((g): g is string => !!g))];
    for (const g of parents.slice(0, 2)) {
      const verb = facts.kind === "read" ? "reads" : "edits";
      push(`dir-${g}`, `all ${verb} under ${g}`, { kind: facts.kind, pathGlob: g });
    }
  }

  return out;
}

/** An allow-rule from the webview must name a command prefix or a path glob. */
export function isConcreteAllowMatch(match: PermissionRuleMatch): boolean {
  const prefix = typeof match.commandPrefix === "string" ? match.commandPrefix.trim() : "";
  const glob = typeof match.pathGlob === "string" ? match.pathGlob.trim() : "";
  if (prefix && !isUnboundedPrefix(prefix)) return true;
  if (glob && !isUnboundedGlob(glob)) return true;
  return false;
}

function isUnboundedPrefix(prefix: string): boolean {
  return prefix === "*" || prefix === "**";
}

function isUnboundedGlob(glob: string): boolean {
  const g = glob.replace(/\\/g, "/").replace(/\/+$/, "");
  return g === "*" || g === "**" || g === "/**" || g === "/" || g === ".";
}

export function matchIsEmpty(match: PermissionRuleMatch): boolean {
  return !match.tool && !match.kind && !match.commandPrefix && !match.pathGlob;
}

// ---------------------------------------------------------------------------
// Parse / serialize / views
// ---------------------------------------------------------------------------

const ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"]);
const KINDS = new Set<PermissionKind>(["read", "edit", "execute", "other"]);
const SCOPES = new Set<PermissionScope>(["workspace", "global"]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function parseRule(raw: unknown): PermissionRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const id = asString(rec.id);
  if (!id) return undefined;
  const action = asString(rec.action);
  if (!action || !ACTIONS.has(action as PermissionAction)) return undefined;
  const scope = asString(rec.scope);
  if (!scope || !SCOPES.has(scope as PermissionScope)) return undefined;
  const createdAt = typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt)
    ? rec.createdAt
    : 0;
  const matchRaw = rec.match && typeof rec.match === "object" && !Array.isArray(rec.match)
    ? rec.match as Record<string, unknown>
    : {};
  const kind = asString(matchRaw.kind);
  const match: PermissionRuleMatch = {};
  const tool = asString(matchRaw.tool);
  if (tool) match.tool = tool;
  if (kind && KINDS.has(kind as PermissionKind)) match.kind = kind as PermissionKind;
  const commandPrefix = asString(matchRaw.commandPrefix);
  if (commandPrefix) match.commandPrefix = commandPrefix;
  const pathGlob = asString(matchRaw.pathGlob);
  if (pathGlob) match.pathGlob = pathGlob;
  if (matchIsEmpty(match)) return undefined;
  if (action === "allow" && !isConcreteAllowMatch(match)) return undefined;
  const note = asString(rec.note);
  return {
    id,
    match,
    action: action as PermissionAction,
    scope: scope as PermissionScope,
    createdAt,
    ...(note ? { note } : {}),
  };
}

export function parseWorkspaceRulesFile(json: unknown): PermissionRule[] | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const rec = json as Record<string, unknown>;
  if (rec.version !== WORKSPACE_RULES_VERSION) return undefined;
  if (!Array.isArray(rec.rules)) return undefined;
  const rules: PermissionRule[] = [];
  for (const row of rec.rules) {
    const parsed = parseRule(row);
    if (parsed) rules.push({ ...parsed, scope: "workspace" });
  }
  return rules;
}

export function serializeWorkspaceRulesFile(rules: readonly PermissionRule[]): string {
  const body: WorkspaceRulesFile = {
    version: WORKSPACE_RULES_VERSION,
    rules: rules.map((r) => ({ ...r, scope: "workspace" })),
  };
  return JSON.stringify(body, null, 2) + "\n";
}

export function parseGlobalRulesMap(value: unknown): PermissionRule[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: PermissionRule[] = [];
  for (const row of Object.values(value as Record<string, unknown>)) {
    const parsed = parseRule(row);
    if (parsed) out.push({ ...parsed, scope: "global" });
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

export function globalRulesToMap(rules: readonly PermissionRule[]): Record<string, PermissionRule> {
  const map: Record<string, PermissionRule> = {};
  for (const r of rules) map[r.id] = { ...r, scope: "global" };
  return map;
}

export function parseAdoptionMap(value: unknown): Record<string, AdoptionRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, AdoptionRecord> = {};
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const hash = asString(rec.hash);
    const status = asString(rec.status);
    if (!hash || (status !== "adopted" && status !== "declined")) continue;
    const at = typeof rec.at === "number" && Number.isFinite(rec.at) ? rec.at : 0;
    out[key] = { hash, status: status as AdoptionStatus, at };
  }
  return out;
}

export function hashRulesText(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function workspaceRulesPath(cwd: string): string {
  const base = String(cwd || "").replace(/[\\/]+$/, "");
  const sep = /\\/.test(cwd) && !/\//.test(cwd) ? "\\" : "/";
  // Preserve the caller's separator so Windows tests stay deterministic on POSIX.
  if (/\\/.test(cwd)) return `${base}\\.grok\\permissions.json`;
  return `${base}${sep}${WORKSPACE_RULES_REL}`;
}

export function adoptionKeyFor(cwd: string): string {
  const { norm, windows } = canonicalPath(cwd);
  return windows ? norm.toLowerCase() : norm;
}

export interface LoadedWorkspaceRules {
  path: string;
  raw: string;
  hash: string;
  rules: PermissionRule[];
}

export function loadWorkspaceRulesFile(
  cwd: string,
  fs: PermissionRulesFs,
): LoadedWorkspaceRules | undefined {
  if (!cwd) return undefined;
  const p = workspaceRulesPath(cwd);
  try {
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    const rules = parseWorkspaceRulesFile(parsed);
    if (!rules) return undefined;
    return { path: p, raw, hash: hashRulesText(raw), rules };
  } catch {
    return undefined;
  }
}

export function writeWorkspaceRulesFile(
  cwd: string,
  rules: readonly PermissionRule[],
  fs: PermissionRulesFs,
): LoadedWorkspaceRules {
  const p = workspaceRulesPath(cwd);
  const dir = p.replace(/[\\/]permissions\.json$/, "");
  fs.mkdirSync(dir, { recursive: true });
  const raw = serializeWorkspaceRulesFile(rules);
  fs.writeFileSync(p, raw);
  return { path: p, raw, hash: hashRulesText(raw), rules: [...rules] };
}

export function formatRuleSummary(rule: PermissionRule): string {
  const parts: string[] = [rule.action];
  if (rule.match.kind) parts.push(rule.match.kind);
  if (rule.match.tool) parts.push(rule.match.tool);
  if (rule.match.commandPrefix) parts.push(rule.match.commandPrefix);
  if (rule.match.pathGlob) parts.push(rule.match.pathGlob);
  parts.push(`(${rule.scope})`);
  return parts.join(" ");
}

export function toRuleView(rule: PermissionRule): PermissionRuleView {
  return {
    id: rule.id,
    action: rule.action,
    scope: rule.scope,
    summary: formatRuleSummary(rule),
    detail: rule.note || matchDetail(rule.match),
    source: rule.scope,
    createdAt: rule.createdAt,
    note: rule.note,
    deletable: true,
  };
}

function matchDetail(match: PermissionRuleMatch): string {
  const bits: string[] = [];
  if (match.kind) bits.push(`kind ${match.kind}`);
  if (match.tool) bits.push(`tool ${match.tool}`);
  if (match.commandPrefix) bits.push(`command ${match.commandPrefix}…`);
  if (match.pathGlob) bits.push(`path ${match.pathGlob}`);
  return bits.join(" · ") || "match";
}

export function sanitizeWebviewAllowMatch(raw: unknown): PermissionRuleMatch | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const match: PermissionRuleMatch = {};
  const kind = asString(rec.kind);
  if (kind && KINDS.has(kind as PermissionKind)) match.kind = kind as PermissionKind;
  const tool = asString(rec.tool);
  if (tool) match.tool = tool;
  const commandPrefix = asString(rec.commandPrefix);
  if (commandPrefix) match.commandPrefix = commandPrefix;
  const pathGlob = asString(rec.pathGlob);
  if (pathGlob) match.pathGlob = pathGlob;
  if (!isConcreteAllowMatch(match)) return undefined;
  return match;
}

export function createRule(input: {
  match: PermissionRuleMatch;
  action: PermissionAction;
  scope: PermissionScope;
  note?: string;
  id: string;
  createdAt: number;
}): PermissionRule {
  return {
    id: input.id,
    match: input.match,
    action: input.action,
    scope: input.scope,
    createdAt: input.createdAt,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** Prefer allow_once so the CLI keeps asking and the engine (and floor) still see every request. */
export function pickAllowOnceOption(
  options: readonly { optionId: string; kind: string }[],
): string | undefined {
  const once = options.find((o) => o.kind === "allow_once");
  if (once) return once.optionId;
  return options.find((o) => o.kind === "allow_always")?.optionId;
}

export function activeRulesFrom(
  globalRules: readonly PermissionRule[],
  workspace: { rules: PermissionRule[]; hash: string } | undefined,
  adoption: AdoptionRecord | undefined,
): PermissionRule[] {
  const appliedWorkspace = workspace && adoption?.status === "adopted" && adoption.hash === workspace.hash
    ? workspace.rules
    : [];
  return [...globalRules, ...appliedWorkspace];
}

export function pendingWorkspaceAdoption(
  workspace: { rules: PermissionRule[]; hash: string } | undefined,
  adoption: AdoptionRecord | undefined,
): boolean {
  if (!workspace || workspace.rules.length === 0) return false;
  if (!adoption) return true;
  if (adoption.hash !== workspace.hash) return true;
  return adoption.status !== "adopted";
}
