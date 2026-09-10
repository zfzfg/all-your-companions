/**
 * Run artefacts for `/agent` (AP-10, Crew stage 1).
 *
 * Decision 18.1: role definitions are project files (`.companions/agents/`,
 * versionable), run artefacts are NOT. A run is execution noise — a brief, a
 * result and a log line per step — and putting it in the repo would fill the
 * project history with the by-products of thinking. So runs live under
 * `<globalStorage>/runs/<runId>/`, the same reasoning (and the same storage
 * root) as the AP-08 checkpoints:
 *
 * ```
 * <globalStorage>/runs/<runId>/step-01.brief.md
 * <globalStorage>/runs/<runId>/step-01.result.md
 * <globalStorage>/runs/<runId>/log.jsonl
 * ```
 *
 * The files are the point, not a debug aid: the acceptance criterion is that a
 * human can open the brief and the result and see exactly what the role was
 * told and what it said back. Everything here therefore writes plain UTF-8
 * text through an injected {@link AgentRunFs} — same shape as `CheckpointStore`
 * and `RuleFileFs`, so the whole module is testable against a fake disk.
 *
 * `step` is zero-padded to two digits so a directory listing sorts correctly
 * past step 9, which stage 3 will reach.
 */

export interface AgentRunFs {
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
  existsSync(path: string): boolean;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

export interface AgentRunStoreOptions {
  /** `<globalStorage>/runs`. */
  root: string;
  fs: AgentRunFs;
  /** Injected so the module has no clock of its own (recipe R7). */
  now?: () => number;
  /** Path join. Injected so tests can pin POSIX separators on Windows. */
  join?: (...parts: string[]) => string;
}

/**
 * What caused a role to be commissioned.
 *
 * Worth recording because the three differ in who wrote the task. With
 * `command` the user typed it and owns it; with the other two the HOST derived
 * it from the conversation (AP-11), and a result read months later should not
 * have to guess which of those it is looking at.
 */
export type AgentRunTrigger =
  | "command"
  | "handoff"
  | "second-opinion"
  | "crew-step"
  // AP-16: the main agent delegated this run to another companion. Recorded
  // because a result read months later must say whether a person asked for it
  // or another model did.
  | "subagent"
  // AP-17: one stage of a Crew session's workflow run.
  | "workflow-stage";

/** One line of `log.jsonl`. Deliberately flat and additive — stage 3 will add
 *  fields, and a reader must survive not knowing them. */
export interface AgentRunLogEntry {
  at: number;
  runId: string;
  step: number;
  role: string;
  provider: string;
  model?: string;
  event: "started" | "briefed" | "finished" | "failed" | "cancelled";
  sessionId?: string;
  detail?: string;
  durationMs?: number;
  costUsdTicks?: number;
}

function defaultJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

export function stepSlug(step: number): string {
  const n = Number.isFinite(step) && step > 0 ? Math.floor(step) : 1;
  return `step-${String(n).padStart(2, "0")}`;
}

/**
 * `run-20260908-141233-a3f1` — sortable, unique, and readable in a directory
 * listing. The suffix exists because two runs started inside the same second
 * are entirely ordinary (a role kicked off from two windows), and a collision
 * would have them overwrite each other's brief.
 */
export function makeRunId(now: number, suffix: string): string {
  const d = new Date(now);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `run-${stamp}-${suffix}`;
}

export class AgentRunStore {
  private readonly root: string;
  private readonly fs: AgentRunFs;
  private readonly now: () => number;
  private readonly join: (...parts: string[]) => string;
  /** Monotonic within this host, so two runs in the same second differ even
   *  when `Math.random` is stubbed out in a test. */
  private seq = 0;

  constructor(options: AgentRunStoreOptions) {
    this.root = options.root;
    this.fs = options.fs;
    this.now = options.now ?? (() => Date.now());
    this.join = options.join ?? defaultJoin;
  }

  newRunId(): string {
    this.seq += 1;
    const suffix = `${this.seq.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")}`;
    return makeRunId(this.now(), suffix);
  }

  runDir(runId: string): string {
    return this.join(this.root, runId);
  }

  briefPath(runId: string, step: number): string {
    return this.join(this.runDir(runId), `${stepSlug(step)}.brief.md`);
  }

  resultPath(runId: string, step: number): string {
    return this.join(this.runDir(runId), `${stepSlug(step)}.result.md`);
  }

  logPath(runId: string): string {
    return this.join(this.runDir(runId), "log.jsonl");
  }

  writeBrief(runId: string, step: number, markdown: string): string {
    const target = this.briefPath(runId, step);
    this.fs.mkdirSync(this.runDir(runId), { recursive: true });
    this.fs.writeFileSync(target, markdown);
    return target;
  }

  writeResult(runId: string, step: number, markdown: string): string {
    const target = this.resultPath(runId, step);
    this.fs.mkdirSync(this.runDir(runId), { recursive: true });
    this.fs.writeFileSync(target, markdown);
    return target;
  }

  /**
   * Append one JSON line. Best-effort by contract: a run must not fail because
   * its log could not be written — the log is the account of the run, not the
   * run. The caller logs the write failure to the output channel instead.
   */
  appendLog(entry: AgentRunLogEntry): void {
    this.fs.mkdirSync(this.runDir(entry.runId), { recursive: true });
    this.fs.appendFileSync(this.logPath(entry.runId), `${JSON.stringify(entry)}\n`);
  }

  /** Drop a run directory that never produced anything — the counterpart to
   *  not leaving an empty "New session" behind when a role is cancelled before
   *  its first prompt. */
  discard(runId: string): void {
    const dir = this.runDir(runId);
    if (!this.fs.existsSync(dir)) return;
    this.fs.rmSync(dir, { recursive: true, force: true });
  }

  stamp(): number {
    return this.now();
  }
}

// ---------------------------------------------------------------------------
// Cost, as the card states it
// ---------------------------------------------------------------------------

/** Grok's fixed-point billing unit: 10^10 ticks per USD (xAI's published
 *  UsageTotals contract). Same divisor as the usage popover in media/chat.js —
 *  it is not cents and not micros. */
export const USD_TICKS_PER_DOLLAR = 10_000_000_000;

/**
 * What a run cost, in the words the card uses.
 *
 * A role is a SECOND run, billed separately, and §5.10 is blunt that a crew
 * can easily cost more than the single turn it replaced. So the card states
 * the cost rather than tucking it away — and when the provider reported no
 * cost, it says that too. "no cost reported" and "$0.00" are different facts,
 * and printing the second for the first would be a lie about money.
 */
export function formatRunCost(costUsdTicks: number | undefined, totalTokens: number | undefined): string {
  const parts: string[] = [];
  if (typeof costUsdTicks === "number" && Number.isFinite(costUsdTicks)) {
    const usd = costUsdTicks / USD_TICKS_PER_DOLLAR;
    parts.push(usd > 0 && usd < 0.000001
      ? "<$0.000001"
      : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(usd));
  }
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    parts.push(`${totalTokens.toLocaleString("en-US")} tokens`);
  }
  return parts.length ? parts.join(" · ") : "no cost reported";
}
