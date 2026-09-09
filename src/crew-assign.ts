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

export function explicitRoleTag(title: string): string | undefined {
  const m = EXPLICIT_RE.exec(title ?? "");
  return m ? m[1].toLowerCase() : undefined;
}

export function stripRoleTag(title: string): string {
  return String(title ?? "").replace(EXPLICIT_RE, "").trim();
}

function keywordsFrom(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 5 && !STOP.has(w));
}

function titleHits(title: string, keywords: readonly string[]): string[] {
  const hay = ` ${title.toLowerCase()} `;
  const hits: string[] = [];
  for (const k of keywords) {
    if (k.length < 5) continue;
    if (hay.includes(k.toLowerCase())) hits.push(k);
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
    // Stable order so the same step is always the same question.
    hits.sort((a, b) => a.rank - b.rank || a.role.localeCompare(b.role));
    return {
      kind: "ambiguous",
      candidates: hits.map((h) => h.role),
      why: hits.map((h) => `${h.role}: ${h.why}`).join("; "),
    };
  }
  return { kind: "none", why: "no explicit tag, no matching path glob, no signal word from when_to_use" };
}
