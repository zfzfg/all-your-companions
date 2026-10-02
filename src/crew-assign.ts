/**
 * Deterministic step → role assignment (AP-12, decision 18.4).
 *
 * No model decides. Three sources, fixed rank:
 *
 *   1. An explicit `[role]` tag in the step title
 *   2. Path globs from the role's `scope` matching the step's files
 *   3. Signal words from the role's `when_to_use` against the title
 *
 * Exactly one role → `assigned` with a reason that goes in `log.jsonl`.
 * Several → `ambiguous` (the host asks; it does not guess).
 * None → `none` (the host asks too — assigning nothing would skip the step
 * silently, which is how a chain drops work).
 *
 * Pure (recipe R7).
 */

import type { AgentRole } from "./agent-roles";
import { matchPathGlob } from "./permission-rules";

export interface AssignmentRule {
  role: string;
  pathGlobs?: string[];
  keywords?: string[];
}

export type Assignment =
  | { kind: "assigned"; role: string; why: string }
  | { kind: "ambiguous"; candidates: string[]; why: string }
  | { kind: "none"; why: string };

const EXPLICIT_RE = /^\s*\[([a-z0-9][a-z0-9-]*)\]\s*/i;

const STOP = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "from",
  "that", "this", "its", "it", "is", "be", "as", "at", "by", "into", "over",
  "than", "then", "when", "which", "who", "not", "no", "any", "own", "out",
]);

/**
 * Short tokens that are real role signals. Anything shorter is dropped unless
 * it is in this set. Broad words such as `code` stay out: they match too much.
 * Automatic keywords and explicit `AssignmentRule.keywords` both use this set.
 */
export const SHORT_ROLE_SIGNALS = [
  "test", "tests", "spec", "docs", "fix", "bug", "lint", "api", "auth",
  "db", "sql", "ui", "css", "rust", "java",
] as const;

const SHORT_SIGNAL = new Set<string>(SHORT_ROLE_SIGNALS);

/**
 * Singular/plural and a few German terms. The alias is what gets matched,
 * so `tests` and `testen` both hit a rule that says `test`.
 */
const KEYWORD_ALIASES: Record<string, string> = {
  tests: "test",
  specs: "spec",
  bugs: "bug",
  fixes: "fix",
  apis: "api",
  fehler: "bug",
  testen: "test",
  dokumentation: "docs",
  doku: "docs",
  schnittstelle: "api",
  authentifizierung: "auth",
  datenbank: "db",
};

function normalizeKeyword(word: string): string {
  const lower = word.toLowerCase();
  return KEYWORD_ALIASES[lower] ?? lower;
}

function isSignal(word: string): boolean {
  return word.length >= 5 || SHORT_SIGNAL.has(word);
}

/** Tokens of a title, plus their aliases, so matching is by word and not by substring. */
function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of String(title ?? "").toLowerCase().split(/[^a-z0-9äöüß]+/)) {
    if (!raw) continue;
    tokens.add(raw);
    tokens.add(normalizeKeyword(raw));
  }
  return tokens;
}

export function explicitRoleTag(title: string): string | undefined {
  const m = EXPLICIT_RE.exec(title ?? "");
  return m ? m[1].toLowerCase() : undefined;
}

export function stripRoleTag(title: string): string {
  return String(title ?? "").replace(EXPLICIT_RE, "").trim();
}

function keywordsFrom(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z0-9äöüß]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const word = normalizeKeyword(raw);
    if (!isSignal(word) && !isSignal(raw)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * Word match. `api` does not hit `capital`. A keyword shorter than five
 * characters counts only when it is one of {@link SHORT_ROLE_SIGNALS}
 * (or an alias of one). Longer keywords match a whole token, not a substring.
 */
function titleHits(title: string, keywords: readonly string[]): string[] {
  const tokens = titleTokens(title);
  const hits: string[] = [];
  for (const raw of keywords) {
    const word = normalizeKeyword(String(raw ?? ""));
    if (!word || !isSignal(word)) continue;
    if (tokens.has(word) || tokens.has(String(raw).toLowerCase())) hits.push(String(raw));
  }
  return hits;
}

function filesHitGlobs(files: readonly string[], globs: readonly string[]): string[] {
  const hits: string[] = [];
  for (const glob of globs) {
    for (const file of files) {
      if (matchPathGlob(glob, file) && !hits.includes(glob)) hits.push(glob);
    }
  }
  return hits;
}

function rulesFromRoles(roles: readonly AgentRole[]): AssignmentRule[] {
  return roles.map((r) => ({
    role: r.name,
    pathGlobs: r.scope ? [...r.scope] : [],
    keywords: keywordsFrom(r.whenToUse),
  }));
}

/**
 * Ranked assignment. `rules` override / extend the roles' own scope and
 * when_to_use; when omitted, the roles themselves are the rules.
 */
export function assignStep(
  step: { title: string; files: readonly string[] },
  roles: readonly AgentRole[],
  rules: readonly AssignmentRule[] = rulesFromRoles(roles),
): Assignment {
  const known = new Map(roles.map((r) => [r.name, r]));
  const title = String(step.title ?? "");
  const files = step.files ?? [];

  const tagged = explicitRoleTag(title);
  if (tagged) {
    if (known.has(tagged)) {
      return { kind: "assigned", role: tagged, why: `explicit tag [${tagged}] in the step title` };
    }
    return { kind: "none", why: `explicit tag [${tagged}] names a role that is not loaded` };
  }

  type Hit = { role: string; why: string; rank: number };
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!known.has(rule.role) || seen.has(rule.role)) continue;
    const globHits = filesHitGlobs(files, rule.pathGlobs ?? []);
    if (globHits.length) {
      seen.add(rule.role);
      hits.push({
        role: rule.role,
        rank: 2,
        why: `path glob ${globHits.map((g) => `\`${g}\``).join(", ")} matched ${files.length} file(s)`,
      });
      continue;
    }
    const wordHits = titleHits(title, rule.keywords ?? []);
    if (wordHits.length) {
      seen.add(rule.role);
      hits.push({
        role: rule.role,
        rank: 3,
        why: `signal word${wordHits.length === 1 ? "" : "s"} ${wordHits.map((w) => `\`${w}\``).join(", ")} from when_to_use`,
      });
    }
  }

  if (hits.length === 1) {
    return { kind: "assigned", role: hits[0].role, why: hits[0].why };
  }
  if (hits.length > 1) {
    // Stable order so the same step is always the same question — and, past
    // the rank, the CALLER's order rather than the alphabet, so a crew flow
    // that lists `implementer` before `researcher` is answered in that order.
    // No change for the plain `/agent` path: `loadAgentRoles` already returns
    // roles name-sorted, so the index order there IS the alphabetical one.
    const order = new Map(roles.map((role, index) => [role.name, index]));
    const rank = (name: string) => order.get(name) ?? Number.MAX_SAFE_INTEGER;
    hits.sort((a, b) => a.rank - b.rank || rank(a.role) - rank(b.role) || a.role.localeCompare(b.role));
    return {
      kind: "ambiguous",
      candidates: hits.map((h) => h.role),
      why: hits.map((h) => `${h.role}: ${h.why}`).join("; "),
    };
  }
  return { kind: "none", why: "no explicit tag, no matching path glob, no signal word from when_to_use" };
}
