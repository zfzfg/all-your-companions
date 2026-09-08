// "@" file autocomplete — the pure host half. Typing `@` in the composer opens
// a workspace-file picker: the webview detects the token (getMentionQuery in
// media/webview-helpers.js) and posts it as `mentionQuery`; the host answers
// `mentionResults` from a TTL-cached `workspace.findFiles` index filtered here.
// Split from sidebar.ts so ranking/exclude behavior is unit-testable without
// vscode (same reason slash-filter.ts exists for the `/` popover).

import * as path from "node:path";

/** Max rows a single mentionResults reply carries (the popover is ~6 rows tall
 *  and scrolls; past ~50 the ranking, not the list, is what helps). */
export const MENTION_RESULT_LIMIT = 50;

/** Default findFiles cap for one index build (also the `grok.mentionIndexLimit`
 *  setting default). Big monorepos exceed it — the popover is a quick-add
 *  affordance, not a complete search surface; raise the setting if files are
 *  missing from `@` autocomplete (#69). */
export const MENTION_INDEX_LIMIT = 5000;

/** Floor for `grok.mentionIndexLimit` — tiny values make the popover useless;
 *  there is no upper bound (the user may index an entire monorepo if they want). */
export const MENTION_INDEX_LIMIT_MIN = 100;

/**
 * Normalize a raw `grok.mentionIndexLimit` value: floor to an integer, enforce
 * {@link MENTION_INDEX_LIMIT_MIN}, no upper cap. Non-finite / non-positive input
 * falls back to {@link MENTION_INDEX_LIMIT}.
 */
export function clampMentionIndexLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MENTION_INDEX_LIMIT;
  return Math.max(MENTION_INDEX_LIMIT_MIN, Math.floor(n));
}

/** How long one findFiles snapshot serves queries before a rebuild. Keystrokes
 *  within a popover interaction hit the cache; newly created files appear on
 *  the next interaction. */
export const MENTION_INDEX_TTL_MS = 15_000;

/** Workspace-relative paths always render/match with forward slashes (chips
 *  elsewhere carry Windows backslashes from asRelativePath — see chat.js's
 *  basename split note). */
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

/** True when `candidate` is strictly below `workspaceRoot`. Call this on both
 * lexical paths and their realpath results: the former rejects `..`/absolute
 * escapes, while the latter rejects an in-workspace symlink targeting outside.
 * Windows comparisons are case-insensitive, matching the host filesystem. */
export function isMentionPathInsideWorkspace(
  workspaceRoot: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const normalize = (p: string) => {
    const resolved = api.resolve(p);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = api.relative(normalize(workspaceRoot), normalize(candidate));
  return !!rel && rel !== ".." && !rel.startsWith(".." + api.sep) && !api.isAbsolute(rel);
}

/** Resolve the local-only #69 fallback without allowing a supplied absolute
 * path or a normalized result outside the first workspace root. */
export function resolveMentionFallback(
  workspaceRoot: string,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const api = pathApi(platform);
  if (!relPath || api.isAbsolute(relPath)) return undefined;
  const candidate = api.resolve(workspaceRoot, relPath);
  return isMentionPathInsideWorkspace(workspaceRoot, candidate, platform)
    ? candidate
    : undefined;
}

/** Select an attachment candidate without letting a remote fall through to a
 * workspace join. `catalogMatch` is the host's current merged index result for
 * remote calls; local calls may also use an open-tab match and the #69 fallback. */
export function resolveMentionAttachmentPath(
  origin: "local" | "remote",
  workspaceRoot: string,
  relPath: string,
  catalogMatch: string | undefined,
  openTabMatch: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (origin === "remote") return catalogMatch;
  return catalogMatch
    ?? openTabMatch
    ?? resolveMentionFallback(workspaceRoot, relPath, platform);
}

/**
 * Union extra `{rel, abs}` paths into a findFiles snapshot. Paths already in the
 * map are left alone (first wins). Returns the input map unchanged when nothing
 * new is added; otherwise a new Map so the cached findFiles snapshot stays
 * pure. Used to inject currently open editors that the 5k cap missed (#69).
 */
export function mergeMentionEntries(
  absByRel: Map<string, string>,
  extra: Iterable<{ rel: string; abs: string }>,
): Map<string, string> {
  let out: Map<string, string> | null = null;
  for (const { rel, abs } of extra) {
    if (!rel || !abs || (out ?? absByRel).has(rel)) continue;
    if (!out) out = new Map(absByRel);
    out.set(rel, abs);
  }
  return out ?? absByRel;
}

/**
 * Combine the user's `files.exclude` + `search.exclude` maps into one findFiles
 * exclude glob. findFiles' default (undefined) applies only `files.exclude`,
 * which does NOT contain node_modules — that lives in `search.exclude` — so
 * without this a default workspace indexes its dependency tree. Only `true`
 * values count (a `files.exclude` value can be a `{ when: … }` clause object);
 * node_modules/.git are always excluded even if the user unset the defaults.
 */
export function buildExcludeGlob(configs: Array<Record<string, unknown> | undefined>): string {
  const patterns = new Set<string>(["**/node_modules/**", "**/.git/**"]);
  for (const cfg of configs) {
    if (!cfg) continue;
    for (const [glob, on] of Object.entries(cfg)) {
      if (on === true) patterns.add(glob);
    }
  }
  return `{${[...patterns].join(",")}}`;
}

/** Index order = what an empty `@` shows: shallow files first (root README above
 *  a deep test fixture), alphabetical within a depth. findFiles order is
 *  arbitrary, so this also makes results stable across rebuilds. */
export function orderMentionIndex(paths: string[]): string[] {
  const depth = (p: string) => p.split("/").length;
  return [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** Chars of `q` appear in `s` in order (the classic fuzzy-finder fallback tier). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Rank the index against the typed token. Tiers, best first: basename prefix →
 * basename substring → full-path substring (covers `src/ch`-style dir queries)
 * → in-order subsequence. Within a tier shorter paths win (the file you mean is
 * rarely the deeply nested one), then alphabetical for stability. Empty query
 * passes the index through in its own (depth-first) order.
 */
export function filterMentionFiles(
  files: string[],
  query: string,
  limit: number = MENTION_RESULT_LIMIT,
): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: Array<{ path: string; tier: number }> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let tier: number;
    if (base.startsWith(q)) tier = 0;
    else if (base.includes(q)) tier = 1;
    else if (lower.includes(q)) tier = 2;
    else if (isSubsequence(q, lower)) tier = 3;
    else continue;
    scored.push({ path: f, tier });
  }
  scored.sort((a, b) => a.tier - b.tier || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}

// ── Non-file sources ─────────────────────────────────────────────────────────
//
// `@` answers with files AND with the two host-collected sources from AP-03.
// They ride a SEPARATE additive field on `mentionResults` rather than being
// mixed into `files`, for two reasons: `files` is a list of workspace-relative
// paths that `addMentionFile` resolves against the mention catalog (a fake path
// in it would be a hole, not a feature), and a client that predates this field
// simply keeps showing files.

/** Which host source a virtual `@` entry stands for. */
export type ContextSourceId = "problems" | "terminal";

export interface MentionSourceEntry {
  source: ContextSourceId;
  /** Inserted into the composer as `@<token> ` when picked. */
  token: string;
  label: string;
  /** One line of explanation shown beside the label. */
  detail: string;
}

/** The catalog, in the order it is offered. Errors before console output: a
 *  problem list is the more common thing to hand an agent, and it is the one
 *  that exists on every machine (terminal capture needs shell integration). */
export const MENTION_SOURCES: readonly MentionSourceEntry[] = [
  {
    source: "problems",
    token: "problems",
    label: "@problems",
    detail: "Errors and warnings the editor is reporting",
  },
  {
    source: "terminal",
    token: "terminal",
    label: "@terminal",
    detail: "Output of the terminal you last used",
  },
];

/**
 * Virtual entries for the head of the results list.
 *
 * Prefix match on the token only — no fuzzy tier. A source has ONE name, and
 * the subsequence tier that helps find `src/a/b/chips.ts` would put `@problems`
 * under `@ps`, above the files someone was actually reaching for. Empty query
 * offers both, which is what makes them discoverable at all.
 */
export function filterMentionSources(query: string): MentionSourceEntry[] {
  const q = query.toLowerCase();
  return MENTION_SOURCES.filter((entry) => entry.token.startsWith(q));
}
