/**
 * AP-16 — the companion-subagent registry (§9, §6.5, §6.10, §6.12).
 *
 * One record per spawn, from `pending-approval` to a terminal state, plus the
 * counting the limits in §6.3 rule 8 are asked about and the D20 question "is
 * this parent turn still waiting for anything?"
 *
 * Pure logic module adhering to Recipe R7: no vscode, no filesystem, no clock —
 * the caller passes `now`. The host glue that actually starts child sessions
 * lives in `sidebar.ts`; everything decidable without a process lives here, so
 * the turn-boundary rule and the limit arithmetic are testable on their own.
 */

import type { AcpProvider } from "./acp-backend";
import type { PermissionProfile, RefusalCode, SpawnLimits, Target } from "./target-eligibility";

export type SubagentStatus =
  | "pending-approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "refused";

/** The states in which nothing more will happen without a new spawn. */
export const TERMINAL_SUBAGENT_STATUSES: readonly SubagentStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "refused",
] as const;

export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return (TERMINAL_SUBAGENT_STATUSES as readonly string[]).includes(status);
}

export interface SubagentRecord {
  subagentId: string;
  parentSessionId: string;
  /** The child's own provider session id, once the CLI has named it. */
  childSessionId?: string;
  runId: string;
  /** Run-directory step, so the artefacts of two children never collide. */
  step: number;
  label: string;
  target: Target;
  profile: PermissionProfile;
  status: SubagentStatus;
  startedAt: number;
  endedAt?: number;
  /** `wait: "none"` — the parent did not block its tool call on this one. */
  background: boolean;
  /** Which parent turn spawned it. D20 counts terminal children per turn. */
  spawnedInTurn: string;
  /** The `@subagent:` directive that asked for it, if any (§6.8). */
  directiveId?: string;
  /** The named role used as a template, so a `@role:` directive can be matched
   *  against what actually ran (§6.8 "Directive ignored"). */
  roleName?: string;
  /** Whether the parent has already been handed this child's result (§2.1.5). */
  collected?: boolean;
  tokens?: number;
  errorCode?: RefusalCode;
  /** Set when the roster ceiling lowered the effort — always reported (§6.3.5). */
  effortClamped?: { requested: string; applied: string };
  /** False when the provider's model cache was cold at spawn time. */
  modelVerified?: boolean;
  profileDowngraded?: string;
  sameProviderAsParent?: boolean;
  /** P6 §6.6 point 8 — the user kept this child as a session of its own. The
   *  card stays where it is; the delegation still happened. */
  promoted?: boolean;
}

/**
 * Live subagent state for one window.
 *
 * A plain map plus the questions the host asks it. Deliberately NOT a class
 * with I/O: restoring a parent session rebuilds its cards from the run
 * directory (§6.6 point 6), not from this, so nothing here has to survive a
 * reload.
 */
export class SubagentRegistry {
  private readonly records = new Map<string, SubagentRecord>();

  add(record: SubagentRecord): SubagentRecord {
    this.records.set(record.subagentId, record);
    return record;
  }

  get(subagentId: string): SubagentRecord | undefined {
    return this.records.get(subagentId);
  }

  /** Every record, newest first. */
  all(): SubagentRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  forParent(parentSessionId: string): SubagentRecord[] {
    return this.all().filter((record) => record.parentSessionId === parentSessionId);
  }

  /**
   * Move a record to a new state.
   *
   * A terminal record never moves again: a cancel that arrives after the child
   * already completed must not rewrite a finished report, and a late failure
   * from a torn-down process must not resurrect a cancelled one.
   */
  update(
    subagentId: string,
    patch: Partial<SubagentRecord>,
    now: number,
  ): SubagentRecord | undefined {
    const record = this.records.get(subagentId);
    if (!record) return undefined;
    if (isTerminalSubagentStatus(record.status) && patch.status && patch.status !== record.status) {
      return record;
    }
    const next: SubagentRecord = { ...record, ...patch };
    if (patch.status && isTerminalSubagentStatus(patch.status) && next.endedAt === undefined) {
      next.endedAt = now;
    }
    this.records.set(subagentId, next);
    return next;
  }

  /** Records still doing something, for this parent or for the whole window. */
  running(parentSessionId?: string): SubagentRecord[] {
    return this.all().filter(
      (record) =>
        !isTerminalSubagentStatus(record.status)
        && (!parentSessionId || record.parentSessionId === parentSessionId),
    );
  }

  /**
   * D20 — is the parent's turn still waiting?
   *
   * A turn that spawned subagents is not finished until every one of them is
   * terminal, whether or not the CLI has ended its own ACP prompt turn. That is
   * the whole point of the rule: "background" means the agent did not block its
   * tool call, never that a child outlives the turn unobserved.
   */
  turnHasLiveChildren(parentSessionId: string, turnId: string): boolean {
    return this.all().some(
      (record) =>
        record.parentSessionId === parentSessionId
        && record.spawnedInTurn === turnId
        && !isTerminalSubagentStatus(record.status),
    );
  }

  /**
   * Children of this turn that finished without the parent ever collecting them.
   *
   * These, and only these, earn the one batched follow-up line from §2.1 point
   * 5. A parent that already got the result via `spawn(wait=until_done)` or
   * `await` is charged no extra turn to be told to read what it has.
   */
  uncollectedFinished(parentSessionId: string, turnId: string): SubagentRecord[] {
    return this.all().filter(
      (record) =>
        record.parentSessionId === parentSessionId
        && record.spawnedInTurn === turnId
        && isTerminalSubagentStatus(record.status)
        && record.status !== "refused"
        && !record.collected,
    );
  }

  /** The live counts §6.3 rule 8 checks against the configured limits. */
  counts(parentSessionId: string, turnId: string): Pick<SpawnLimits, "running" | "thisTurn" | "thisSession"> {
    const mine = this.all().filter((record) => record.parentSessionId === parentSessionId);
    return {
      running: mine.filter((record) => !isTerminalSubagentStatus(record.status)).length,
      // A refused spawn never started anything, so it does not consume a slot —
      // otherwise four typos would exhaust a turn's budget.
      thisTurn: mine.filter((record) => record.spawnedInTurn === turnId && record.status !== "refused").length,
      thisSession: mine.filter((record) => record.status !== "refused").length,
    };
  }

  /** Drop a parent's records, e.g. when the session is disposed. */
  removeParent(parentSessionId: string): SubagentRecord[] {
    const gone = this.forParent(parentSessionId);
    for (const record of gone) this.records.delete(record.subagentId);
    return gone;
  }

  remove(subagentId: string): void {
    this.records.delete(subagentId);
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * A label for the card, derived when the spawn did not supply one.
 *
 * The task's first clause, capped. Not the whole task: the card header is one
 * line beside the provider and model, and a pasted paragraph there pushes the
 * target out of view — which is the part the user is checking.
 */
export function deriveSubagentLabel(task: string, cap = 48): string {
  const clean = (task ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "Subagent";
  const firstClause = clean.split(/[.;\n]/)[0].trim() || clean;
  if (firstClause.length <= cap) return firstClause;
  let out = "";
  for (const word of firstClause.split(" ")) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > cap) break;
    out = next;
  }
  return out || firstClause.slice(0, cap);
}

/**
 * The card header line (copy deck §18).
 *
 * `Subagent · {label} · {Provider} {model} · effort {effort}`, with the model
 * and effort segments dropped when they are the provider's own defaults —
 * writing "effort undefined" would be a claim we do not have.
 */
export function subagentCardHeader(
  label: string,
  providerName: string,
  model?: string,
  effort?: string,
): string {
  const target = [providerName, model].filter(Boolean).join(" ");
  const parts = ["Subagent", label, target];
  if (effort) parts.push(`effort ${effort}`);
  return parts.join(" · ");
}

/** The profile badge text (copy deck §18). */
export function profileBadge(profile: PermissionProfile): string {
  switch (profile) {
    case "read-only":
      return "read-only";
    case "scoped-edit":
      return "scoped edit";
    default:
      return "inherits permissions";
  }
}

/**
 * The one batched host line for children nobody collected (§6.10 point 3).
 *
 * Batched on purpose: three inspectors finishing within a second of each other
 * are one line, not three, and the review hint is deliberately NOT repeated
 * here — it already travelled with the tool result.
 */
export function uncollectedFollowUpText(records: readonly SubagentRecord[]): string {
  if (!records.length) return "";
  const labels = records.map((record) => record.label);
  const head = labels.length === 1
    ? `${labels[0]} finished — the main agent is reading its report.`
    : `${labels.join(", ")} finished — the main agent is reading their reports.`;
  return `${head} Call companions_await_subagents and read the report. Investigate only if something looks inconsistent.`;
}

/** Provider ids a parent's live children are occupying, for the tray. */
export function runningTargets(records: readonly SubagentRecord[]): AcpProvider[] {
  return [...new Set(records.map((record) => record.target.provider))];
}

// ---------------------------------------------------------------------------
// Briefing and permission pieces (§6.5 step 3, §6.7)
// ---------------------------------------------------------------------------

/**
 * The child's `returnFormat` — the ONE machine channel (§2.1 point 1).
 *
 * Deliberately not `RESULT_FORMAT` plus a second schema: asking for two shapes
 * of the same answer is how a child ends up writing both badly. `parseResult`
 * stays the tolerant reader and falls back to the `RESULT_FORMAT` headings when
 * a child ignores this, so `/agent` keeps working unchanged.
 */
export function subagentReturnFormat(deliverable?: string): string {
  const lines = [
    "End your reply with one fenced block, exactly like this, and nothing after it:",
    "",
    "```companions-result",
    "{",
    '  "summary": "one or two sentences on what you found or did",',
    '  "findings": ["one line per finding, most important first"],',
    '  "filesChanged": ["paths you edited; empty if you edited nothing"],',
    '  "openQuestions": ["anything you could not settle"]',
    "}",
    "```",
    "",
    "Write whatever prose helps above the block. The block is what is read back.",
  ];
  if (deliverable?.trim()) {
    lines.push("", `The prose above the block should be: ${deliverable.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Extra forbidden lines for the profile, appended to `BASE_FORBIDDEN`.
 *
 * Prose, not enforcement — the deny overlay is what actually stops an edit
 * (§6.7). Both exist because a child told what it may not do produces a better
 * report than one that discovers it by having a tool call refused.
 */
export function subagentForbidden(profile: PermissionProfile): string[] {
  if (profile === "read-only") {
    return [
      "Do not edit, create or delete files.",
      "Do not run commands that modify the workspace.",
    ];
  }
  if (profile === "scoped-edit") {
    return ["Do not edit files outside the scope given above."];
  }
  return [];
}

/**
 * The AP-07 overlay a profile compiles to (§6.7).
 *
 * Deny still wins over everything here, and the safety floor cannot be
 * overridden — this only ever narrows. `read-only` denies edits outright and
 * allows the read commands the user listed; `scoped-edit` allows edits inside
 * the given globs and leaves everything else to the normal card flow;
 * `inherit` adds nothing, because the parent's own rules already apply and a
 * child is never granted more than its parent.
 */
export function subagentPermissionOverlay(
  profile: PermissionProfile,
  scope: readonly string[],
  readOnlyCommands: readonly string[],
): { kind: "edit" | "execute"; action: "allow" | "deny" | "ask"; pattern: string }[] {
  if (profile === "read-only") {
    return [
      // The allow-list comes FIRST so the deny below is what a later rule has
      // to beat, matching how the overlay parser resolves ties.
      ...readOnlyCommands
        .map((command) => String(command ?? "").trim())
        .filter(Boolean)
        .map((command) => ({ kind: "execute" as const, action: "allow" as const, pattern: command })),
      { kind: "edit" as const, action: "deny" as const, pattern: "**" },
      { kind: "execute" as const, action: "ask" as const, pattern: "**" },
    ];
  }
  if (profile === "scoped-edit") {
    const globs = scope.map((glob) => String(glob ?? "").trim()).filter(Boolean);
    return [
      { kind: "edit" as const, action: "deny" as const, pattern: "**" },
      ...globs.map((glob) => ({ kind: "edit" as const, action: "allow" as const, pattern: glob })),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Delegation depth (D10, §12.3) — P6
// ---------------------------------------------------------------------------

/**
 * The deepest chain the design allows, ever.
 *
 * Not a setting: D10 calls 2 the hard cap, and §2 non-goal 1 says "there is no
 * depth 3". A parent delegating to a child that delegates once more is already
 * hard for a person to follow on one screen; a third level is a run nobody can
 * account for.
 */
export const SUBAGENT_MAX_DEPTH_CAP = 2;

/**
 * Read `companions.subagents.maxDepth`.
 *
 * Anything outside 1..2 clamps rather than throwing, and the caller is told
 * whether it clamped so it can say so once instead of silently running at a
 * depth the user did not ask for. A missing or unreadable value is 1 — the
 * shipped default, and the conservative direction.
 */
export function resolveMaxDepth(
  configured: unknown,
): { depth: 1 | 2; clamped: boolean } {
  // Absence is not an out-of-range number. `Number(null)` is 0, which would
  // otherwise report an unset setting as a clamp and put a notice in front of
  // someone who never touched it.
  if (configured === undefined || configured === null || configured === "") {
    return { depth: 1, clamped: false };
  }
  const raw = typeof configured === "number" ? configured : Number(configured);
  if (!Number.isFinite(raw)) return { depth: 1, clamped: false };
  const floored = Math.floor(raw);
  if (floored <= 1) return { depth: 1, clamped: floored < 1 };
  if (floored >= SUBAGENT_MAX_DEPTH_CAP) {
    return { depth: SUBAGENT_MAX_DEPTH_CAP, clamped: floored > SUBAGENT_MAX_DEPTH_CAP };
  }
  return { depth: 1, clamped: false };
}

/**
 * May a session at this depth be handed the delegation tools?
 *
 * `depth` is 0 for a user's own session, 1 for its children, 2 for theirs. A
 * session may delegate while its children would still be within `maxDepth`, so
 * at the shipped `maxDepth: 1` only depth 0 delegates — which is exactly the
 * P2-P5 behaviour, now expressed as a rule rather than as "hidden children
 * never get the server".
 */
export function mayDelegateAtDepth(depth: number, maxDepth: 1 | 2): boolean {
  const own = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return own < maxDepth;
}

/**
 * Why a session was not handed the `companions_subagents` MCP server.
 *
 * The server list is fixed at `session/new`, so a skip here is permanent for
 * that process. The host logs every reason; only the surprising ones become a
 * chat notice — crew, depth and stage gates are the design, not a failure.
 */
export type CompanionsSkipReason =
  | "subagents-disabled"
  | "not-agent"
  | "crew-orchestrator"
  | "stage-not-allowed"
  | "depth-capped"
  | "host-mcp-unproven"
  | "name-collision"
  | "pipe-failed";

export type CompanionsMcpMode = "delegate" | "generator";

export type CompanionsMcpDecision =
  | { kind: "offer"; mode: CompanionsMcpMode }
  | { kind: "skip"; reason: CompanionsSkipReason };

export interface CompanionsMcpOfferInput {
  /** `companion-subagent` | `crew-stage` | `workflow-generator`, if hidden. */
  hiddenReason?: string;
  sessionType: string;
  /** Global or session-gear switch, already resolved. Agent-type is separate. */
  subagentsEnabled: boolean;
  stageMayDelegate: boolean;
  depth: number;
  maxDepth: 1 | 2;
}

/**
 * Whether this session should get the delegation (or generator) MCP server.
 *
 * Spawn-time failures (pipe, name collision, unproven host MCP) are not
 * decided here — those need a live process. This is the §6.4.1 gate that is
 * knowable from session type, settings and depth alone.
 */
export function decideCompanionsMcp(input: CompanionsMcpOfferInput): CompanionsMcpDecision {
  if (input.hiddenReason === "workflow-generator") return { kind: "offer", mode: "generator" };
  if (input.sessionType === "crew" && !input.hiddenReason) {
    return { kind: "skip", reason: "crew-orchestrator" };
  }
  if (input.sessionType !== "agent") return { kind: "skip", reason: "not-agent" };
  if (!input.subagentsEnabled) return { kind: "skip", reason: "subagents-disabled" };
  if (input.hiddenReason === "crew-stage" && !input.stageMayDelegate) {
    return { kind: "skip", reason: "stage-not-allowed" };
  }
  if (!mayDelegateAtDepth(input.depth, input.maxDepth)) {
    return { kind: "skip", reason: "depth-capped" };
  }
  return { kind: "offer", mode: "delegate" };
}

/** Chat copy for a skip the user would otherwise only see as "no MCP tools". */
export function companionsSkipNotice(reason: CompanionsSkipReason): string {
  switch (reason) {
    case "subagents-disabled":
      return "Companion subagents are off for this session. Turn them on in Settings or the session gear, then start a new session so the tools can attach.";
    case "host-mcp-unproven":
      return "This companion cannot host subagent tools yet (host MCP support is unproven). It can still run as a subagent child of another companion.";
    case "name-collision":
      return "A provider MCP server already uses the name companions_subagents, so delegation tools were not added to this session.";
    case "pipe-failed":
      return "Could not open the companion-subagent channel. This session can still chat; it cannot start companion subagents.";
    case "not-agent":
      return "Companion subagents are only available in Agent sessions.";
    case "crew-orchestrator":
      return "Crew sessions orchestrate a workflow and do not get companion-subagent tools. A stage can, when both switches allow it.";
    case "stage-not-allowed":
      return "This crew stage cannot start subagents. Turn on “Crew stages may use subagents” and set the stage’s own flag.";
    case "depth-capped":
      return "This session is already as deep as companion subagents are allowed to nest.";
  }
}

/**
 * A skip the person (and the parent model) would otherwise misread as a
 * missing feature. Expected gates — crew, depth, stage — stay in the log.
 */
export function shouldAnnounceCompanionsSkip(
  reason: CompanionsSkipReason,
  hiddenReason?: string,
): boolean {
  if (reason === "host-mcp-unproven" || reason === "name-collision" || reason === "pipe-failed") {
    return true;
  }
  if (reason === "subagents-disabled") return !hiddenReason;
  return false;
}

/** Snapshot `/subagents` prints. Assembled by the host, formatted here. */
export interface SubagentDiagnosis {
  sessionType: string;
  subagentsEnabled: boolean;
  mcpInjected: boolean;
  skipReason?: CompanionsSkipReason;
  parentProvider: string;
  parentHostMcp: string;
  geminiUsable: boolean;
  geminiRosterEnabled: boolean;
  geminiSpawn?: { ok: true; model?: string } | { ok: false; code: string; message: string };
  limits: { running: number; maxConcurrent: number; thisTurn: number; maxPerTurn: number };
}

export function formatSubagentDiagnosis(d: SubagentDiagnosis): string {
  const yn = (ok: boolean) => (ok ? "yes" : "no");
  const gemini = d.geminiSpawn?.ok
    ? `would accept (model ${d.geminiSpawn.model ?? "provider default"})`
    : d.geminiSpawn
      ? `${d.geminiSpawn.code}: ${d.geminiSpawn.message}`
      : "not checked";
  const restart = !d.mcpInjected && d.subagentsEnabled && d.sessionType === "agent"
    ? "\n\nThe tools attach at session start. Restart this session (keep transcript) after turning subagents on."
    : "";
  const verdict = d.mcpInjected && d.geminiSpawn?.ok
    ? "Spawn would accept **gemini**."
    : "Spawn would **not** start a Gemini subagent from this session.";
  return [
    "### Companion subagents",
    "",
    verdict + restart,
    "",
    `- ${yn(d.sessionType === "agent")} — **Session type**: \`${d.sessionType}\``,
    `- ${yn(d.subagentsEnabled)} — **Subagents switch**: ${d.subagentsEnabled ? "on" : "off"}`,
    `- ${yn(d.mcpInjected)} — **\`companions_subagents\` injected**: ${d.mcpInjected ? "yes" : d.skipReason ? d.skipReason : "no"}`,
    `- ${yn(d.parentHostMcp === "yes")} — **${d.parentProvider} host MCP**: \`${d.parentHostMcp}\``,
    `- ${yn(d.geminiUsable)} — **Gemini usable** (connected, located, logged in)`,
    `- ${yn(d.geminiRosterEnabled)} — **Gemini on the subagent roster**`,
    `- ${yn(!!d.geminiSpawn?.ok)} — **resolveTarget gemini**: ${gemini}`,
    `- limits: ${d.limits.running}/${d.limits.maxConcurrent} running, ${d.limits.thisTurn}/${d.limits.maxPerTurn} this turn`,
  ].join("\n");
}

/**
 * A grandchild's budget, carved out of what the parent has left (§12.3, D10).
 *
 * The point of the carve-out is that depth 2 must not multiply the cost of a
 * turn: a parent allowed four children must not become a parent allowed four
 * children each allowed four more. So a depth-1 delegator is handed a SHARE of
 * its own remaining allowance rather than a fresh copy of the limits, and its
 * concurrency is capped below the parent's so one branch cannot starve the
 * others.
 *
 * Halving (rounded down, floor 1) is the simplest rule that keeps the total
 * bounded and still lets a grandchild exist at all.
 */
export function carveChildLimits(parent: SpawnLimits): SpawnLimits {
  const share = (used: number, max: number) => Math.max(1, Math.floor(Math.max(0, max - used) / 2));
  return {
    running: 0,
    thisTurn: 0,
    thisSession: 0,
    maxConcurrent: Math.max(1, Math.floor(parent.maxConcurrent / 2)),
    maxPerTurn: share(parent.thisTurn, parent.maxPerTurn),
    maxPerSession: share(parent.thisSession, parent.maxPerSession),
    // The live-session pool is one window-wide resource; a grandchild competes
    // for the same slots as everything else, so this is passed through rather
    // than divided.
    poolHeadroom: parent.poolHeadroom,
  };
}
