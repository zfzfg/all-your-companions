/**
 * The briefing format (AP-10) — the actual product of the Crew work.
 *
 * A briefing is what a role receives INSTEAD of a transcript. That is the
 * whole mechanism behind "context stretching" (feature plan §5.4): step 4
 * starts with a couple of thousand tokens rather than a 120k conversation,
 * because nothing was carried over except what was written down here. The
 * corollary is unforgiving — **what is missing from the briefing, the next
 * agent does not know** — so the schema, not the orchestration, is what has to
 * be right. AP-11 through AP-13 all write into this format; changing it later
 * breaks every run already on disk.
 *
 * Four properties are load-bearing, and each is pinned by a test:
 *
 * 1. **Deterministic.** {@link renderBriefing} is a pure function of its two
 *    arguments. No clock, no counter, no `Object.keys` ordering, no absolute
 *    paths. Render the same briefing twice and the bytes are identical — which
 *    is what makes a briefing diffable across a re-run and reviewable at all.
 *    Anything time-dependent (when a run started, what it cost) belongs in the
 *    run log, never in the brief.
 * 2. **`runId` and `step` from day one.** Stage 1 only ever writes step 1.
 *    Introducing the coordinates later would invalidate every run already
 *    written, so they are in the header and in the machine-readable stamp now.
 * 3. **Paths, never contents.** `files` lists where to look. Pasting file
 *    bodies into a briefing rebuilds precisely the context bloat the briefing
 *    exists to avoid, and goes stale the moment the role edits anything.
 * 4. **The return format is part of the briefing.** A structured result is
 *    only structured if the role was told the structure. {@link RESULT_FORMAT}
 *    is the text that goes into the brief, and {@link parseResult} is the
 *    reader for exactly that text — they are one contract, tested by
 *    round-trip, not two features that happen to agree today.
 *
 * Pure module (recipe R7): no `vscode`, no `fs`, no `Date.now()`.
 */
import type { AgentRole } from "./agent-roles";

/**
 * Bumped only for a breaking change to the section set. Written into the stamp
 * so a later reader can tell which shape it is holding.
 *
 * v2 (AP-11) adds the optional `## Where this came from` section. A v1 run
 * already on disk stays readable: {@link parseResult} never depended on the
 * section set, and the stamp says which shape each directory holds.
 */
export const BRIEFING_FORMAT_VERSION = 2;

export interface Briefing {
  /** Groups every step of one run. Stable for the life of the run. */
  runId: string;
  /** 1-based. Stage 1 always writes 1; the field exists so stage 3 does not
   *  have to invalidate stage 1's runs to gain a second step. */
  step: number;
  /** The overarching objective this step serves. */
  goal: string;
  /** EXACTLY this one step. */
  task: string;
  /** How success is recognised — the sentence the reviewer will judge against. */
  acceptance: string;
  /** Workspace-relative paths. Paths, never contents. */
  files: string[];
  /** Already settled, so the role neither re-decides nor re-litigates. */
  decisions: string[];
  /** What this role must not do. */
  forbidden: string[];
  /** Expected structure of the reply. Defaults to {@link RESULT_FORMAT}. */
  returnFormat: string;
  /**
   * Where this briefing's contents came from — and, for each source that gave
   * nothing, WHY (AP-11).
   *
   * Only meaningful when the host DERIVED the briefing instead of being handed
   * a task: `/agent` leaves it empty and the section does not render at all.
   * It earns its tokens on one distinction. A role told "no steps" reasonably
   * reads that as "there was nothing to do"; a role told "this companion
   * reports no step list" knows the gap is structural and not its to close.
   * The same confusion one level down is what decided AP-02 against a
   * heuristic.
   */
  provenance?: string[];
}

/** What {@link makeBriefing} accepts before the run stamps its coordinates on.
 *  Split out so a caller can assemble a briefing without being able to choose
 *  its `runId` — that belongs to the run, and a caller-chosen one could
 *  collide with a directory already on disk. */
export type BriefingInput = Partial<Briefing> & Pick<Briefing, "task">;

/**
 * The prohibitions every commissioned role carries, whoever wrote its task.
 *
 * One list rather than one per entry point: a role that may not commit when
 * the user typed the task may not commit when the host derived it either, and
 * two copies of that rule would drift the first time one of them is edited.
 */
export const BASE_FORBIDDEN: readonly string[] = [
  "Do not commit, push, or create a branch, tag or pull request.",
  "Do not change anything outside the task described above, however tempting the adjacent fix looks.",
];

/**
 * {@link BASE_FORBIDDEN} plus whatever this particular role's own definition
 * already promised — read-only in plan mode, and its declared file scope.
 *
 * Stated in the briefing even though neither is enforced here (scope
 * enforcement is AP-13): a boundary the role is told about is one it can
 * respect, and one it can be judged against afterwards.
 */
export function roleForbidden(role: AgentRole): string[] {
  return [
    ...BASE_FORBIDDEN,
    ...(role.mode === "plan" ? ["Do not edit, create or delete any file — this role runs read-only."] : []),
    ...(role.scope?.length ? [`Do not touch files outside this role's scope: ${role.scope.join(", ")}.`] : []),
  ];
}

export interface AgentResult {
  summary: string;
  files: string[];
  open: string[];
  failed: string[];
}

/**
 * What the role SAID it touched, measured against what the host SAW it touch.
 *
 * The result document is a self-report, and a self-report is the weakest link
 * in the whole format: the turn is already paid for by the time it is read, so
 * {@link parseResult} has to accept whatever came back. That tolerance is
 * right, and it is also exactly why the list of files must not be believed on
 * its own — a role that forgets to mention an edit, or names a file it never
 * wrote, produces a briefing for the NEXT step that is quietly wrong.
 *
 * So both lists travel, and the difference is named rather than hidden:
 *
 * - `touched` — claimed and observed. The uncontested part.
 * - `unreported` — the host watched an edit the role did not mention. The
 *   dangerous direction: work the next step does not know happened.
 * - `claimedOnly` — the role named a file the host saw no edit for. Usually
 *   honest (a file it only read, or an edit made through a shell command that
 *   never crossed the diff machinery), occasionally a claim that did not
 *   happen. Reported, never silently dropped.
 *
 * `observed` is what the host's own diff machinery recorded, so it is evidence
 * rather than assertion — but it is not omniscience: an edit a role makes by
 * running `sed -i` in a terminal never becomes a diff block and will show up
 * as `claimedOnly`. The labels on the card say "reported" and "observed" for
 * that reason, and neither is presented as the truth about the other.
 */
export interface FileReconciliation {
  touched: string[];
  unreported: string[];
  claimedOnly: string[];
}

/**
 * Normalize a path for comparison: backslashes to slashes, no `./` prefix.
 *
 * Deliberately the same rule as `normalizeReviewPath` in review-center.ts,
 * kept as a local copy rather than an import so this module stays free of the
 * review-center's own dependency chain. A test pins the two together — the
 * same arrangement the repo already uses for `countLineDiff` against
 * `computeLineDiff`.
 */
export function normalizeResultPath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function reconcileFiles(
  claimed: readonly string[],
  observed: readonly string[],
): FileReconciliation {
  const byNormalized = (values: readonly string[]) => {
    const map = new Map<string, string>();
    for (const value of values) {
      const key = normalizeResultPath(value);
      if (key && !map.has(key)) map.set(key, key);
    }
    return map;
  };
  const claimedMap = byNormalized(claimed);
  const observedMap = byNormalized(observed);
  const touched: string[] = [];
  const unreported: string[] = [];
  const claimedOnly: string[] = [];
  // Observed order first — it is the host's own record and its ordering is
  // stable across runs, where a model's ordering is not.
  for (const key of observedMap.keys()) {
    (claimedMap.has(key) ? touched : unreported).push(key);
  }
  for (const key of claimedMap.keys()) {
    if (!observedMap.has(key)) claimedOnly.push(key);
  }
  return { touched, unreported, claimedOnly };
}

/**
 * The reply shape a briefing asks for, verbatim.
 *
 * Four sections, because those are the four things the next step needs and no
 * more: what happened, what it touched, what is still open, and what could not
 * be done. "What could not be done" is separate from "still open" on purpose —
 * a role that hit a wall and a role that ran out of scope call for different
 * next moves, and collapsing them hides the failure inside a to-do list.
 */
export const RESULT_FORMAT = [
  "Reply with exactly these four headings, in this order, and nothing above the first one:",
  "",
  "## Summary",
  "What you did, in a few sentences.",
  "",
  "## Files touched",
  "One workspace-relative path per line as `- path`. Write `- none` if you changed nothing.",
  "",
  "## Open",
  "Anything still to do that you did not do. `- none` if nothing.",
  "",
  "## Failed",
  "Anything you attempted and could not complete, with the reason. `- none` if nothing.",
].join("\n");

const EMPTY_MARKERS = new Set(["none", "n/a", "na", "-", "nothing", "(none)", "_none_", "*none*"]);

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const text = clean(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** `- a`, `- b`, or a single explicit "nothing here" line. Never an empty
 *  bullet: a heading with an empty list under it reads as a truncated file. */
function bullets(values: readonly string[], empty: string): string {
  const list = cleanList(values);
  return list.length ? list.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
}

function providerLabel(provider: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  if (provider === "gemini") return "Gemini";
  if (provider === "grok") return "Grok";
  return provider;
}

/** `Claude · claude-haiku-4-5 · effort low · plan mode` — the line that makes
 *  a same-provider/different-model crew legible at a glance. Omitted parts
 *  simply do not appear; "default model" is stated rather than left blank, so
 *  a briefing never looks like it lost a field. */
export function roleRunLine(role: AgentRole): string {
  const parts = [providerLabel(role.provider), clean(role.model) || "default model"];
  if (clean(role.effort)) parts.push(`effort ${clean(role.effort)}`);
  parts.push(`${role.mode ?? "agent"} mode`);
  return parts.join(" · ");
}

/**
 * Render a briefing to Markdown. Deterministic: same input, same bytes.
 *
 * Sections are emitted in a FIXED order from a fixed list, never by iterating
 * the object — the field order of a `Briefing` literal must not be able to
 * change a rendered file. Lists are de-duplicated but kept in the caller's
 * order: a sorted `files` would silently reorder the step list a planner wrote.
 *
 * The trailing HTML comment is the machine-readable stamp. It is a comment so
 * it renders as nothing in any Markdown viewer, and it carries the two
 * coordinates plus the format version so a run directory stays interpretable
 * without the code that wrote it.
 */
export function renderBriefing(briefing: Briefing, role: AgentRole): string {
  const sections: string[] = [];
  const preamble = clean(role.systemPreamble);
  if (preamble) sections.push(preamble);

  sections.push(`# Briefing — ${role.name} · run ${clean(briefing.runId)} · step ${briefing.step}`);

  const roleLines = [
    `- **Role:** \`${role.name}\``,
    `- **Runs on:** ${roleRunLine(role)}`,
    `- **Use when:** ${clean(role.whenToUse)}`,
  ];
  if (clean(role.whenNotToUse)) roleLines.push(`- **Do not use for:** ${clean(role.whenNotToUse)}`);
  if (cleanList(role.scope).length) {
    roleLines.push(`- **File scope:** ${cleanList(role.scope).map((glob) => `\`${glob}\``).join(", ")}`);
  }
  sections.push(roleLines.join("\n"));

  sections.push(`## Goal\n\n${clean(briefing.goal) || "(not stated)"}`);
  sections.push(`## Task — this step only\n\n${clean(briefing.task) || "(not stated)"}`);
  sections.push(`## Acceptance\n\n${clean(briefing.acceptance) || "(not stated)"}`);

  // The parenthetical is not decoration. Without it the list reads as "here is
  // everything you need", and a role that never opens the files will confidently
  // answer from the paths alone.
  sections.push(
    `## Files in scope\n\n${bullets(briefing.files, "no specific files named")}\n\n`
    + "These are paths, not contents — open the ones you need. Anything not listed here is background, "
    + "not part of this step.",
  );

  sections.push(`## Already decided\n\n${bullets(briefing.decisions, "nothing recorded")}`);
  // Omitted entirely when empty, exactly like the reconciliation sections in
  // renderResult and for the same reason: a heading that is always present and
  // usually says nothing trains the reader to skip the one run where it says
  // something. It also leaves an `/agent` briefing byte-identical to its v1
  // shape apart from the stamp.
  if (cleanList(briefing.provenance).length) {
    sections.push(
      `## Where this came from\n\n${bullets(briefing.provenance ?? [], "not recorded")}\n\n`
      + "This briefing was assembled by the host from a conversation you are not in. The list above "
      + "is what it could see — treat a gap in it as a gap, not as an absence.",
    );
  }
  sections.push(`## Do not\n\n${bullets(briefing.forbidden, "no additional restrictions beyond the role's own")}`);
  sections.push(`## Return format\n\n${clean(briefing.returnFormat) || RESULT_FORMAT}`);

  sections.push(
    `<!-- companions:briefing v${BRIEFING_FORMAT_VERSION}`
    + ` run=${clean(briefing.runId)} step=${briefing.step} role=${role.name} provider=${role.provider}`
    + `${clean(role.model) ? ` model=${clean(role.model)}` : ""} -->`,
  );

  return `${sections.join("\n\n")}\n`;
}

/** Build a briefing with the defaults stage 1 uses, so a caller cannot
 *  accidentally omit `returnFormat` and get a role that answers in prose. */
export function makeBriefing(input: BriefingInput & Pick<Briefing, "runId" | "step">): Briefing {
  return {
    runId: input.runId,
    step: input.step,
    goal: clean(input.goal) || clean(input.task),
    task: clean(input.task),
    acceptance: clean(input.acceptance),
    files: cleanList(input.files),
    decisions: cleanList(input.decisions),
    forbidden: cleanList(input.forbidden),
    returnFormat: clean(input.returnFormat) || RESULT_FORMAT,
    ...(cleanList(input.provenance).length ? { provenance: cleanList(input.provenance) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading the reply back
// ---------------------------------------------------------------------------

type ResultSection = "summary" | "files" | "open" | "failed";

/** Heading text → section. Generous on purpose: a model that writes "Files
 *  changed" instead of "Files touched" has answered correctly, and losing that
 *  answer to a string comparison would be the worst kind of brittleness. */
const HEADINGS: ReadonlyArray<[RegExp, ResultSection]> = [
  [/^summary\b/, "summary"],
  [/^(?:what i did|result|outcome)\b/, "summary"],
  [/^files?\b/, "files"],
  [/^(?:touched|changed|modified) files?\b/, "files"],
  [/^open\b/, "open"],
  [/^(?:remaining|todo|to do|still open|not done)\b/, "open"],
  [/^failed\b/, "failed"],
  [/^(?:failures?|blocked|could not|couldn.t)\b/, "failed"],
];

function sectionFor(heading: string): ResultSection | undefined {
  const text = heading.trim().toLowerCase().replace(/[:.]+$/, "").replace(/\*\*/g, "").trim();
  for (const [pattern, section] of HEADINGS) if (pattern.test(text)) return section;
  return undefined;
}

function isEmptyMarker(text: string): boolean {
  return EMPTY_MARKERS.has(text.trim().toLowerCase().replace(/[.]$/, ""));
}

/** Strip `- `, `* `, `1. ` and surrounding backticks/emphasis from one line. */
function bulletText(line: string): string {
  const stripped = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  return stripped.replace(/^[`*_]+|[`*_]+$/g, "").trim();
}

/**
 * Read a role's reply into {@link AgentResult}. **Tolerant by contract:** a
 * missing section is an empty section, never an error.
 *
 * The reason is economic. The role's turn has already been paid for by the
 * time this runs; rejecting the reply because a heading was spelled differently
 * throws that money away and leaves the user with nothing to read. Anything
 * before the first recognised heading becomes the summary, so a role that
 * answers in plain prose still produces a usable card.
 */
const COMPANIONS_RESULT_RE = /```companions-result\s*\r?\n([\s\S]*?)```/i;

/**
 * The machine channel (§2.1 point 1). `parseResult` prefers this block when
 * it is present and well-formed JSON; headings remain the fallback so `/agent`
 * without a block still parses.
 */
export function extractCompanionsResultJson(markdown: string): Record<string, unknown> | undefined {
  const match = COMPANIONS_RESULT_RE.exec(String(markdown ?? ""));
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringListFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const one = typeof value === "string" ? value.trim() : "";
    return one ? [one] : [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function parseResult(markdown: string): AgentResult {
  const block = extractCompanionsResultJson(markdown);
  if (block) {
    const summary = typeof block.summary === "string" ? block.summary.trim() : "";
    const files = stringListFromUnknown(block.filesChanged ?? block.files);
    const open = stringListFromUnknown(block.openQuestions ?? block.open);
    const failed = stringListFromUnknown(block.failed);
    // A JSON block that names nothing still wins over headings: asking for two
    // shapes of the same answer is how a child writes both badly (§2.1).
    return { summary, files, open, failed };
  }
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  const buckets: Record<ResultSection, string[]> = { summary: [], files: [], open: [], failed: [] };
  const preamble: string[] = [];
  let current: ResultSection | undefined;
  for (const line of text.split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line) ?? /^\s{0,3}\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    if (heading) {
      const section = sectionFor(heading[1]);
      // An unrecognised heading ENDS the current section rather than
      // continuing it. A role that adds "## Notes" of its own must not have
      // those notes silently filed under "Failed".
      current = section;
      continue;
    }
    if (current) buckets[current].push(line);
    else preamble.push(line);
  }

  const list = (lines: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      const value = bulletText(line);
      if (!value || isEmptyMarker(value) || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };

  const summaryLines = buckets.summary.length ? buckets.summary : preamble;
  const summary = summaryLines.join("\n").trim();
  return {
    summary: isEmptyMarker(summary) ? "" : summary,
    files: list(buckets.files),
    open: list(buckets.open),
    failed: list(buckets.failed),
  };
}

/**
 * The result document written next to the brief.
 *
 * Deliberately NOT the raw reply: it is the parsed result rendered back in the
 * canonical shape, so `step-01.result.md` is readable by the same parser that
 * produced it and every run directory looks the same regardless of how
 * chattily the role answered. The raw reply is preserved verbatim underneath —
 * a parse that dropped something must stay recoverable by a human.
 */
export function renderResult(
  result: AgentResult,
  raw: string,
  reconciliation?: FileReconciliation,
): string {
  const sections = [
    `## Summary\n\n${result.summary || "(the role returned no summary)"}`,
    `## Files touched\n\n${bullets(result.files, "none")}`,
    `## Open\n\n${bullets(result.open, "none")}`,
    `## Failed\n\n${bullets(result.failed, "none")}`,
  ];
  // The two discrepancy sections appear ONLY when there is a discrepancy — a
  // pair of "- none" headings on every well-behaved run would train the reader
  // to skip past exactly the section that matters on the run where it is not
  // none. `Files touched` above stays the role's own words; these are the
  // host's evidence about them.
  if (reconciliation?.unreported.length) {
    sections.push(
      `## Edits the role did not report\n\n${bullets(reconciliation.unreported, "none")}\n\n`
      + "Observed by the host's diff machinery, absent from the role's own list. "
      + "A later step briefed only from the list above would not know about these.",
    );
  }
  if (reconciliation?.claimedOnly.length) {
    sections.push(
      `## Reported but not observed\n\n${bullets(reconciliation.claimedOnly, "none")}\n\n`
      + "The role named these; the host recorded no edit for them. Usually a file it only read, "
      + "or an edit made through a shell command that never became a diff — occasionally a claim "
      + "that did not happen.",
    );
  }
  const verbatim = String(raw ?? "").trim();
  if (verbatim) sections.push(`## Raw reply\n\n${verbatim}`);
  return `${sections.join("\n\n")}\n`;
}
