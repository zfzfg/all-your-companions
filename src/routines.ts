/**
 * Routines — a prompt, a project, a model, and a cadence. The pure core.
 *
 * A routine sends the same prompt to one project on a schedule. Each firing
 * opens a session, and the last {@link ROUTINE_RUN_HISTORY_LIMIT} runs are kept
 * so the user can see the thing working. No I/O lives here: the host owns the
 * timer, the claim files and the session, and calls into this file for every
 * decision about *when*.
 *
 * ## Exactly once, without electing anyone
 *
 * VS Code, Cursor and the desktop app all read the same `~/.grok/client-state/`,
 * so all of them would fire every routine. The fix is not a leader — it is to
 * make each due run individually claimable. {@link routineWindow} returns a
 * **deterministic key** for the run that is currently due; the host claims it by
 * creating a file with an exclusive-create flag. Exactly one host wins, the rest
 * get `EEXIST` and stand down. No lease, no TTL, no renewal loop, and no gap
 * after a crash.
 *
 * Two consequences worth knowing, because they are free rather than designed:
 *
 *  - **Catch-up is arithmetic.** Twelve windows missed while the laptop was shut
 *    still resolves to one key — the current one — so "one catch-up run, however
 *    many were missed" needs no code of its own.
 *  - **Daylight saving is correct rather than survivable**, because a daily
 *    window is keyed on the local calendar date and never on a duration.
 *
 * ## When the first run happens, and why it differs by unit
 *
 * An interval cadence ("every 6 hours") names no wall-clock time, so window 0
 * falls at creation and the routine fires immediately — you find out the prompt
 * is wrong now rather than in six hours. A `days` cadence names a time
 * explicitly, so it is honoured: a routine created at 14:00 asking for 08:00
 * first runs at 08:00 tomorrow, never at 14:00 today. "Run now" covers
 * impatience, and a manual run deliberately takes no window key — it is not a
 * scheduled window and must not consume one.
 */

import type { AcpProvider } from "./acp-backend";
import { AUTO_NAME_MAX_CHARS } from "./sessions";

/** `PersistedState` key — routine definitions. Runs live in their own files. */
export const ROUTINES_KEY = "grok.routines";

/**
 * Below this a routine stops being a routine and becomes a leak: "every
 * 1 minute" is a billed session per minute, for as long as a window is open.
 */
export const ROUTINE_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** "the last 20 runs, others disappear" — the whole retention policy. */
export const ROUTINE_RUN_HISTORY_LIMIT = 20;

export const ROUTINE_TITLE_MAX = 80;
export const ROUTINE_PROMPT_MAX = 8000;

/** Fallback when a `days` cadence arrives with no time — older or hand-edited
 *  data. Never chosen through the UI, which always sends one. */
export const ROUTINE_DEFAULT_TIME = "09:00";

export const ROUTINE_UNITS = ["minutes", "hours", "days"] as const;
export type RoutineUnit = (typeof ROUTINE_UNITS)[number];

export interface RoutineCadence {
  /** Whole number >= 1. */
  every: number;
  unit: RoutineUnit;
  /** Local wall clock, "HH:MM". Meaningful only when `unit` is `days`. */
  at?: string;
}

export interface Routine {
  id: string;
  title: string;
  prompt: string;
  /** Project the session opens in. May be an archived project at the desk. */
  cwd: string;
  provider: AcpProvider;
  model: string;
  cadence: RoutineCadence;
  createdAt: number;
  paused?: boolean;
}

/**
 * `running` is written when a run is claimed and replaced when it ends.
 * `interrupted` is what a `running` record becomes when the host that owned it
 * died — swept on the next start, so a dead run cannot sit in the strip
 * pretending to be live.
 */
export type RoutineOutcome = "ran" | "skipped" | "failed" | "running" | "interrupted";

export interface RoutineRun {
  routineId: string;
  /** The window this run claimed, or `m<ms>` for a manual "Run now". */
  windowKey: string;
  startedAt: number;
  endedAt?: number;
  outcome: RoutineOutcome;
  /** Session the run opened — the row's link target. */
  sessionId?: string;
  /**
   * Project this run actually happened in.
   *
   * Recorded per-run rather than read off the routine, because the routine's
   * project can be edited afterwards: point it at B and every retained A run
   * would otherwise resolve its session against B, where that session does not
   * exist. A run record has to describe what happened, not what is configured
   * now.
   */
  cwd?: string;
  /** User-facing reason. Present on `skipped`, `failed` and `interrupted`. */
  detail?: string;
}

/* ------------------------------------------------------------------ clocks */

export interface LocalDateParts {
  y: number;
  /** 1-based, so it reads like a date rather than a `Date` argument. */
  m: number;
  d: number;
  /** Minutes since local midnight. */
  minutes: number;
}

/**
 * The local-calendar surface, injected so the schedule can be tested in any
 * zone without touching `process.env.TZ` (which vitest cannot change per-test
 * on Windows).
 */
export interface LocalClock {
  parts(ms: number): LocalDateParts;
  /** Epoch ms for a local calendar date at `minutes` past midnight. */
  stamp(y: number, m: number, d: number, minutes: number): number;
}

export const systemLocalClock: LocalClock = {
  parts(ms: number): LocalDateParts {
    const dt = new Date(ms);
    return {
      y: dt.getFullYear(),
      m: dt.getMonth() + 1,
      d: dt.getDate(),
      minutes: dt.getHours() * 60 + dt.getMinutes(),
    };
  },
  stamp(y: number, m: number, d: number, minutes: number): number {
    // The local Date constructor, deliberately: it resolves a wall-clock time
    // through whatever offset is in force on that date, which is exactly what
    // "08:00 every morning" means across a daylight-saving boundary.
    return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
  },
};

const MS_PER_DAY = 86_400_000;

/** Calendar date -> day number. Uses UTC arithmetic on *calendar components*,
 *  never on a local timestamp, so a 23- or 25-hour day still counts as one. */
function dayNumber(p: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / MS_PER_DAY);
}

function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function isoDate(p: { y: number; m: number; d: number }): string {
  const mm = String(p.m).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return `${p.y}-${mm}-${dd}`;
}

/** "HH:MM" -> minutes since midnight, or undefined when unparseable. */
export function parseTimeOfDay(at: unknown): number | undefined {
  if (typeof at !== "string") return undefined;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const UNIT_MS: Record<RoutineUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: MS_PER_DAY,
};

export function cadenceIntervalMs(cadence: RoutineCadence): number {
  const every = Math.max(1, Math.floor(cadence.every));
  return every * UNIT_MS[cadence.unit];
}

/** A `days` cadence always resolves to a time, so the schedule has one branch
 *  rather than two. */
function cadenceMinuteOfDay(cadence: RoutineCadence): number {
  return parseTimeOfDay(cadence.at) ?? parseTimeOfDay(ROUTINE_DEFAULT_TIME) ?? 9 * 60;
}

/* ----------------------------------------------------------------- windows */

export interface RoutineWindow {
  /**
   * Key of the run that is due right now, or `undefined` when nothing is.
   * Stable for the whole window, so a host that already ran it simply fails to
   * claim it again.
   */
  key?: string;
  /** When the next run is expected. Sent to the client for the countdown. */
  nextAt: number;
}

/**
 * The one scheduling decision, for one routine, at one instant.
 *
 * Pure and total: a paused routine, a routine whose cadence is nonsense and a
 * routine created in the future all resolve to "nothing due" rather than
 * throwing, because this runs on a timer that must never take the host down.
 */
export function routineWindow(
  routine: Routine,
  now: number,
  clock: LocalClock = systemLocalClock,
): RoutineWindow {
  const window = unpausedWindow(routine, now, clock);
  // Belt and braces: the caller filters paused routines, and so does this. A
  // routine that fires while the user believes it is paused is the one failure
  // here that reads as a betrayal rather than a bug.
  return routine.paused ? { nextAt: window.nextAt } : window;
}

function unpausedWindow(routine: Routine, now: number, clock: LocalClock): RoutineWindow {
  if (routine.cadence.unit === "days") return dailyWindow(routine, now, clock);

  const interval = cadenceIntervalMs(routine.cadence);
  const elapsed = now - routine.createdAt;
  // Created in the future (a clock rolled back, a hand-edited file): nothing is
  // due, and the next run is whenever `now` catches up.
  if (elapsed < 0) return { nextAt: routine.createdAt };
  const index = Math.floor(elapsed / interval);
  return {
    key: `i${index}`,
    nextAt: routine.createdAt + (index + 1) * interval,
  };
}

function dailyWindow(routine: Routine, now: number, clock: LocalClock): RoutineWindow {
  const at = cadenceMinuteOfDay(routine.cadence);
  const every = Math.max(1, Math.floor(routine.cadence.every));

  const created = clock.parts(routine.createdAt);
  const createdDay = dayNumber(created);
  // A cadence with a named time never fires at creation. If today's slot has
  // already passed when the routine is created, the first one is a full cycle
  // out — not tomorrow, which would silently break "every 3 days".
  const createdSlot = clock.stamp(created.y, created.m, created.d, at);
  const firstDay = createdSlot >= routine.createdAt ? createdDay : createdDay + every;
  const slotAt = (day: number): number => {
    const p = fromDayNumber(day);
    return clock.stamp(p.y, p.m, p.d, at);
  };

  const nowDay = dayNumber(clock.parts(now));
  if (nowDay < firstDay) return { nextAt: slotAt(firstDay) };

  let cycles = Math.floor((nowDay - firstDay) / every);
  // `cycles` lands on the most recent on-cycle day at or before today. When
  // that day IS today and its time has not arrived yet, the due window is the
  // previous cycle.
  if (slotAt(firstDay + cycles * every) > now) cycles -= 1;
  if (cycles < 0) return { nextAt: slotAt(firstDay) };

  const dueDay = firstDay + cycles * every;
  return {
    key: `d${isoDate(fromDayNumber(dueDay))}`,
    nextAt: slotAt(firstDay + (cycles + 1) * every),
  };
}

/** Key for an explicit "Run now". Never collides with a scheduled key, and is
 *  never claimed against — a manual run must not consume a window. */
export function manualWindowKey(now: number): string {
  return `m${now}`;
}

export function isManualWindowKey(key: string): boolean {
  return key.startsWith("m");
}

/* -------------------------------------------------------------- validation */

export type RoutineValidation =
  | { ok: true; routine: Routine }
  | { ok: false; error: string };

export interface RoutineDraft {
  id?: unknown;
  title?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  provider?: unknown;
  model?: unknown;
  cadence?: unknown;
  createdAt?: unknown;
  paused?: unknown;
}

function asCadence(value: unknown): RoutineCadence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { every?: unknown; unit?: unknown; at?: unknown };
  const unit = ROUTINE_UNITS.find((u) => u === raw.unit);
  if (!unit) return undefined;
  const every = typeof raw.every === "number" ? raw.every : Number(raw.every);
  if (!Number.isFinite(every)) return undefined;
  const cadence: RoutineCadence = { every: Math.floor(every), unit };
  if (unit === "days") cadence.at = formatTimeOfDay(cadenceMinuteOfDay({ every: 1, unit, at: raw.at as string }));
  return cadence;
}

/**
 * Validate a draft into a storable routine.
 *
 * Errors are the copy the user reads, so they say what to do rather than what
 * failed. `providers` is the connected set: a routine cannot be saved against a
 * model that is not there, because a routine that can never fire is worse than
 * one that will not save.
 */
export function validateRoutine(
  draft: RoutineDraft,
  opts: { id: string; createdAt: number; models: ReadonlyArray<{ provider: AcpProvider; model: string }> },
): RoutineValidation {
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  if (!title) return { ok: false, error: "Give the routine a name." };

  const prompt = typeof draft.prompt === "string" ? draft.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "Write the prompt this routine should send." };

  const cwd = typeof draft.cwd === "string" ? draft.cwd.trim() : "";
  if (!cwd) return { ok: false, error: "Pick a project for this routine to run in." };

  const rawAt = (draft.cadence as { at?: unknown } | undefined)?.at;
  const rawUnit = (draft.cadence as { unit?: unknown } | undefined)?.unit;
  // A present-but-unparseable time is a typo to report, not something to
  // quietly replace with the default — that would move the run by hours and
  // say nothing. An ABSENT time still defaults, so older data keeps loading.
  if (rawUnit === "days" && rawAt !== undefined && parseTimeOfDay(rawAt) === undefined) {
    return { ok: false, error: "Enter a time like 08:00." };
  }

  const cadence = asCadence(draft.cadence);
  if (!cadence) return { ok: false, error: "Pick how often this routine should run." };
  if (cadence.every < 1) return { ok: false, error: `Enter a whole number of ${cadence.unit}.` };
  if (cadenceIntervalMs(cadence) < ROUTINE_MIN_INTERVAL_MS) {
    return { ok: false, error: "Routines run at most once every 15 minutes." };
  }

  const provider = draft.provider;
  const model = typeof draft.model === "string" ? draft.model : "";
  // An EMPTY model means "this agent's default" and is valid for any listed
  // provider, whether or not that provider's concrete models have been
  // discovered yet. Requiring an exact row here would refuse to save a routine
  // that had been running happily for weeks, the moment discovery ran.
  const match = model
    ? opts.models.find((m) => m.provider === provider && m.model === model)
    : opts.models.find((m) => m.provider === provider);
  if (!match) return { ok: false, error: "Pick a model that is connected." };

  return {
    ok: true,
    routine: {
      id: opts.id,
      title: title.slice(0, ROUTINE_TITLE_MAX),
      prompt: prompt.slice(0, ROUTINE_PROMPT_MAX),
      cwd,
      provider: match.provider,
      // The DRAFT's model, not the matched row's: for an empty model the match
      // is only there to vouch for the provider, and copying its model would
      // silently pin the routine to whichever concrete row happened to be first.
      model,
      cadence,
      createdAt: opts.createdAt,
      ...(draft.paused === true ? { paused: true } : {}),
    },
  };
}

/* -------------------------------------------------------------------- runs */

/** Newest first, capped. The cap IS the retention policy — nothing prunes on a
 *  schedule, so a routine that stops running keeps its last 20 forever. */
export function capRoutineRuns(runs: readonly RoutineRun[]): RoutineRun[] {
  return [...runs]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, ROUTINE_RUN_HISTORY_LIMIT);
}

export interface RoutineHealth {
  ran: number;
  skipped: number;
  failed: number;
  /** Runs that actually attempted something — the strip's denominator. */
  total: number;
}

export function summarizeRuns(runs: readonly RoutineRun[]): RoutineHealth {
  let ran = 0;
  let skipped = 0;
  let failed = 0;
  for (const run of runs) {
    if (run.outcome === "ran") ran += 1;
    else if (run.outcome === "skipped") skipped += 1;
    else if (run.outcome === "failed" || run.outcome === "interrupted") failed += 1;
  }
  return { ran, skipped, failed, total: ran + skipped + failed };
}

/** A `running` record whose host is gone. Swept at start, so the strip never
 *  shows a dead run as live. */
export function interruptStaleRuns(runs: readonly RoutineRun[], now: number): RoutineRun[] {
  return runs.map((run) =>
    run.outcome === "running"
      ? { ...run, outcome: "interrupted" as const, endedAt: now, detail: "Interrupted — the app closed mid-run" }
      : run,
  );
}

/**
 * Session name for a run.
 *
 * A routine's session otherwise looks exactly like one the user started, and
 * arrives in the rail with an auto-summary that says nothing about where it
 * came from. The tag answers "why is this here" at a glance; the routine's own
 * title answers "which one", which a bare `[Routine]` prefix would not.
 */
export const ROUTINE_SESSION_TAG = "[Routine]";

export function routineSessionName(title: string): string {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean) return ROUTINE_SESSION_TAG;
  // Already tagged — renaming a routine must not stack tags on its next run.
  if (clean.startsWith(ROUTINE_SESSION_TAG)) return clean.slice(0, AUTO_NAME_MAX_CHARS);
  return `${ROUTINE_SESSION_TAG} ${clean}`.slice(0, AUTO_NAME_MAX_CHARS);
}

/* ------------------------------------------------------------------- wire */

/** A project the form may target. Built from the repo catalog, and on a remote
 *  filtered to what that connection is authorized for. */
export interface RoutineProjectOption {
  cwd: string;
  label: string;
  /**
   * Provider a fresh conversation in this project would use — the same value
   * the rail puts on its rows. The form picks the first model of this provider,
   * so creating a routine lands where the composer would have, instead of on
   * whichever model the catalog happened to list first.
   */
  defaultProvider?: AcpProvider;
  /** Archived projects stay selectable at the desk — the rail hides them, and
   *  a routine is not the rail. They never reach a remote at all, because the
   *  authorized set already excludes them. */
  archived?: boolean;
}

export interface RoutineModelOption {
  provider: AcpProvider;
  model: string;
  label: string;
}

/**
 * One row, ready to render.
 *
 * The client is a view: it does not own a clock, a calendar or the cadence
 * grammar. It gets `cadenceLabel` (static) and `nextRunAt` (a timestamp) and
 * renders the countdown itself, so the row stays live without the host
 * re-sending a frame every minute.
 */
export interface RoutineView extends Routine {
  cadenceLabel: string;
  nextRunAt: number;
  runs: RoutineRun[];
  health: RoutineHealth;
  projectLabel: string;
  projectArchived?: boolean;
}

export function toRoutineView(
  routine: Routine,
  runs: readonly RoutineRun[],
  now: number,
  project: { label: string; archived?: boolean } | undefined,
  clock: LocalClock = systemLocalClock,
): RoutineView {
  const capped = capRoutineRuns(runs);
  return {
    ...routine,
    cadenceLabel: describeCadence(routine.cadence),
    nextRunAt: routineWindow(routine, now, clock).nextAt,
    runs: capped,
    health: summarizeRuns(capped),
    // A project that has left the catalog still names itself, so a routine
    // pointing at a closed folder reads as a stale target rather than a blank.
    projectLabel: project?.label ?? routine.cwd,
    ...(project?.archived ? { projectArchived: true } : {}),
  };
}

/* ---------------------------------------------------------------- display */

/** Static half of the row's subtitle. The countdown is the client's job, since
 *  only it knows when it last painted. */
export function describeCadence(cadence: RoutineCadence): string {
  const every = Math.max(1, Math.floor(cadence.every));
  if (cadence.unit === "days") {
    const at = formatTimeOfDay(cadenceMinuteOfDay(cadence));
    return every === 1 ? `Every day at ${at}` : `Every ${every} days at ${at}`;
  }
  const noun = cadence.unit === "hours" ? "hour" : "minute";
  return every === 1 ? `Every ${noun}` : `Every ${every} ${noun}s`;
}
