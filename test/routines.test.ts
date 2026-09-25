/**
 * Routines — the pure schedule, and the six decisions it carries.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1.  An interval routine fires at window 0 — immediately on creation
 *   2.  The window key is stable for the whole window (a second tick re-claims nothing)
 *   3.  Twelve missed windows resolve to ONE key — catch-up is arithmetic, not logic
 *   4.  `nextAt` is anchored to createdAt, so a late tick does not push the schedule
 *   5.  A `days` cadence NEVER fires at creation — the named time is honoured
 *   6.  A day cadence created before its slot fires today; created after, it waits
 *       a full cycle rather than a single day
 *   7.  The daily key is the local calendar date — 23:59 and 00:01 differ
 *   8.  Daylight saving: 08:00 stays 08:00, and the two slots are 25h apart
 *   9.  The same instant yields different keys in different zones
 *  10.  Below 15 minutes is refused; exactly 15 is accepted
 *  11.  A `days` cadence with no time defaults; with a BAD time it is refused
 *  12.  A model that is not connected cannot be saved
 *  13.  Paused routines never yield a key, whatever the clock says
 *  14.  Run history keeps the 20 newest, newest first
 *  15.  Only `running` records are swept to `interrupted`
 *  16.  A manual key is recognisable and never collides with a scheduled one
 *  17.  A routine created in the future yields nothing due
 */
import { describe, it, expect } from "vitest";
import { AUTO_NAME_MAX_CHARS } from "../src/sessions";
import {
  ROUTINE_MIN_INTERVAL_MS,
  ROUTINE_RUN_HISTORY_LIMIT,
  cadenceIntervalMs,
  capRoutineRuns,
  describeCadence,
  formatTimeOfDay,
  interruptStaleRuns,
  isManualWindowKey,
  manualWindowKey,
  parseTimeOfDay,
  routineWindow,
  routineSessionName,
  ROUTINE_SESSION_TAG,
  summarizeRuns,
  validateRoutine,
  type LocalClock,
  type Routine,
  type RoutineCadence,
  type RoutineRun,
} from "../src/routines";

const HOUR = 3_600_000;
const MIN = 60_000;

/** A fixed-offset zone, so the calendar under test is never the host's. */
function zoneClock(offsetMinutes: number): LocalClock {
  return {
    parts(ms) {
      const dt = new Date(ms + offsetMinutes * MIN);
      return {
        y: dt.getUTCFullYear(),
        m: dt.getUTCMonth() + 1,
        d: dt.getUTCDate(),
        minutes: dt.getUTCHours() * 60 + dt.getUTCMinutes(),
      };
    },
    stamp(y, m, d, minutes) {
      return Date.UTC(y, m - 1, d, 0, minutes) - offsetMinutes * MIN;
    },
  };
}

/**
 * A zone that puts its clocks BACK one hour at `cutover` — the autumn
 * transition, which makes that local day 25 hours long. Summer is +120,
 * winter +60.
 */
function dstClock(cutover: number): LocalClock {
  const offsetFor = (utc: number): number => (utc < cutover ? 120 : 60);
  return {
    parts(ms) {
      const dt = new Date(ms + offsetFor(ms) * MIN);
      return {
        y: dt.getUTCFullYear(),
        m: dt.getUTCMonth() + 1,
        d: dt.getUTCDate(),
        minutes: dt.getUTCHours() * 60 + dt.getUTCMinutes(),
      };
    },
    stamp(y, m, d, minutes) {
      const wall = Date.UTC(y, m - 1, d, 0, minutes);
      // Resolve the offset from a summer-time guess, then re-resolve: a wall
      // time after the cutover lands in winter and takes the winter offset.
      const guess = wall - 120 * MIN;
      return wall - offsetFor(guess) * MIN;
    },
  };
}

const UTC = zoneClock(0);

function routine(over: Partial<Routine> & { cadence: RoutineCadence; createdAt: number }): Routine {
  return {
    id: "r1",
    title: "Morning brief",
    prompt: "What changed?",
    cwd: "C:/repo",
    provider: "grok",
    model: "grok-4.6",
    ...over,
  };
}

describe("interval cadences", () => {
  const created = Date.UTC(2026, 7, 24, 14, 0);
  const every6h = routine({ cadence: { every: 6, unit: "hours" }, createdAt: created });

  it("fires at window 0 — immediately on creation (req 1)", () => {
    expect(routineWindow(every6h, created, UTC).key).toBe("i0");
  });

  it("keeps one key for the whole window (req 2)", () => {
    const a = routineWindow(every6h, created + 1 * MIN, UTC).key;
    const b = routineWindow(every6h, created + 5 * HOUR + 59 * MIN, UTC).key;
    expect(a).toBe("i0");
    expect(b).toBe("i0");
  });

  it("advances exactly one key per elapsed interval", () => {
    expect(routineWindow(every6h, created + 6 * HOUR, UTC).key).toBe("i1");
    expect(routineWindow(every6h, created + 12 * HOUR, UTC).key).toBe("i2");
  });

  it("collapses twelve missed windows into ONE key (req 3)", () => {
    // The laptop was shut from Friday to Monday: 72h of a 6h cadence.
    const keys = new Set<string>();
    for (let t = 0; t <= 72; t += 6) keys.add(routineWindow(every6h, created + t * HOUR, UTC).key!);
    expect(keys.size).toBe(13); // every window HAS a key...

    // ...but on the tick that actually happens after the gap, only one is
    // current, so only one run is ever claimed.
    expect(routineWindow(every6h, created + 72 * HOUR, UTC).key).toBe("i12");
  });

  it("anchors nextAt to createdAt, not to the tick (req 4)", () => {
    // A tick five minutes into window 3 must still point at the start of 4.
    const late = created + 18 * HOUR + 5 * MIN;
    expect(routineWindow(every6h, late, UTC).nextAt).toBe(created + 24 * HOUR);
  });

  it("yields nothing for a routine created in the future (req 17)", () => {
    const w = routineWindow(every6h, created - HOUR, UTC);
    expect(w.key).toBeUndefined();
    expect(w.nextAt).toBe(created);
  });
});

describe("daily cadences", () => {
  it("never fires at creation, even when the slot has passed (req 5)", () => {
    // Created 14:00, asking for 08:00. 08:00 today is behind us — and firing
    // now would ignore the time the user explicitly named.
    const created = Date.UTC(2026, 7, 24, 14, 0);
    const r = routine({ cadence: { every: 1, unit: "days", at: "08:00" }, createdAt: created });
    expect(routineWindow(r, created, UTC).key).toBeUndefined();
    expect(routineWindow(r, created, UTC).nextAt).toBe(Date.UTC(2026, 7, 25, 8, 0));
  });

  it("fires today when created before the slot (req 6)", () => {
    const created = Date.UTC(2026, 7, 24, 6, 0);
    const r = routine({ cadence: { every: 1, unit: "days", at: "08:00" }, createdAt: created });
    expect(routineWindow(r, created, UTC).key).toBeUndefined();
    expect(routineWindow(r, Date.UTC(2026, 7, 24, 8, 0), UTC).key).toBe("d2026-08-24");
  });

  it("waits a full cycle, not a day, when the slot has passed (req 6)", () => {
    // Every 3 days at 08:00, created 24 Aug 14:00. The next on-cycle day is
    // the 27th — NOT the 25th, which would silently become "every 1 day".
    const created = Date.UTC(2026, 7, 24, 14, 0);
    const r = routine({ cadence: { every: 3, unit: "days", at: "08:00" }, createdAt: created });
    expect(routineWindow(r, created, UTC).nextAt).toBe(Date.UTC(2026, 7, 27, 8, 0));
    expect(routineWindow(r, Date.UTC(2026, 7, 26, 23, 0), UTC).key).toBeUndefined();
    expect(routineWindow(r, Date.UTC(2026, 7, 27, 8, 0), UTC).key).toBe("d2026-08-27");
    // The 28th is off-cycle: the 27th is still the current window.
    expect(routineWindow(r, Date.UTC(2026, 7, 28, 12, 0), UTC).key).toBe("d2026-08-27");
    expect(routineWindow(r, Date.UTC(2026, 7, 30, 8, 0), UTC).key).toBe("d2026-08-30");
  });

  it("keys on the local calendar date (req 7)", () => {
    const created = Date.UTC(2026, 7, 24, 6, 0);
    const r = routine({ cadence: { every: 1, unit: "days", at: "00:30" }, createdAt: created });
    expect(routineWindow(r, Date.UTC(2026, 7, 25, 23, 59), UTC).key).toBe("d2026-08-25");
    expect(routineWindow(r, Date.UTC(2026, 7, 26, 0, 31), UTC).key).toBe("d2026-08-26");
  });

  it("holds 08:00 through a daylight-saving change, 25 hours apart (req 8)", () => {
    // Clocks go back at 01:00 UTC on 25 Oct 2026 (+120 -> +60).
    const cutover = Date.UTC(2026, 9, 25, 1, 0);
    const clock = dstClock(cutover);
    const created = Date.UTC(2026, 9, 23, 4, 0); // 06:00 local, before the 08:00 slot
    const r = routine({ cadence: { every: 1, unit: "days", at: "08:00" }, createdAt: created });

    const before = routineWindow(r, Date.UTC(2026, 9, 24, 7, 0), clock); // 24th 09:00 local
    expect(before.key).toBe("d2026-10-24");
    // The next slot is 08:00 on the 25th — one hour later in UTC, because the
    // 25th is a 25-hour day. A duration-based schedule would drift to 07:00.
    expect(before.nextAt).toBe(Date.UTC(2026, 9, 25, 7, 0));
    expect(before.nextAt - Date.UTC(2026, 9, 24, 6, 0)).toBe(25 * HOUR);

    expect(clock.parts(before.nextAt).minutes).toBe(8 * 60);
  });

  it("gives different keys for the same instant in different zones (req 9)", () => {
    const created = Date.UTC(2026, 7, 1, 0, 0);
    const r = routine({ cadence: { every: 1, unit: "days", at: "01:00" }, createdAt: created });
    const instant = Date.UTC(2026, 7, 24, 22, 30); // 24th late UTC, 25th in +0530
    expect(routineWindow(r, instant, zoneClock(0)).key).toBe("d2026-08-24");
    expect(routineWindow(r, instant, zoneClock(330)).key).toBe("d2026-08-25");
  });

  it("collapses a long absence into one key, same as intervals (req 3)", () => {
    const created = Date.UTC(2026, 7, 1, 6, 0);
    const r = routine({ cadence: { every: 1, unit: "days", at: "08:00" }, createdAt: created });
    // Away for three weeks. One key, not twenty.
    expect(routineWindow(r, Date.UTC(2026, 7, 22, 12, 0), UTC).key).toBe("d2026-08-22");
  });
});

describe("paused", () => {
  it("never yields a key, whatever the clock says (req 13)", () => {
    const created = Date.UTC(2026, 7, 24, 14, 0);
    const r = routine({ cadence: { every: 6, unit: "hours" }, createdAt: created, paused: true });
    expect(routineWindow(r, created, UTC).key).toBeUndefined();
    expect(routineWindow(r, created + 48 * HOUR, UTC).key).toBeUndefined();
    // The countdown still resolves, so the UI can say when it WOULD run.
    expect(routineWindow(r, created, UTC).nextAt).toBe(created + 6 * HOUR);
  });
});

describe("manual runs", () => {
  it("is recognisable and never collides with a scheduled key (req 16)", () => {
    const key = manualWindowKey(Date.UTC(2026, 7, 24, 14, 0));
    expect(isManualWindowKey(key)).toBe(true);
    expect(isManualWindowKey("i12")).toBe(false);
    expect(isManualWindowKey("d2026-08-24")).toBe(false);
    expect(key).not.toBe("i0");
  });
});

describe("validation", () => {
  const models = [
    { provider: "grok" as const, model: "grok-4.6" },
    { provider: "claude" as const, model: "claude-opus-5" },
  ];
  const base = {
    title: "Morning brief",
    prompt: "What changed?",
    cwd: "C:/repo",
    provider: "grok" as const,
    model: "grok-4.6",
  };
  const opts = { id: "r1", createdAt: 1000, models };

  it("refuses below 15 minutes and accepts exactly 15 (req 10)", () => {
    const under = validateRoutine({ ...base, cadence: { every: 14, unit: "minutes" } }, opts);
    expect(under).toEqual({ ok: false, error: "Routines run at most once every 15 minutes." });

    const exact = validateRoutine({ ...base, cadence: { every: 15, unit: "minutes" } }, opts);
    expect(exact.ok).toBe(true);
    expect(cadenceIntervalMs({ every: 15, unit: "minutes" })).toBe(ROUTINE_MIN_INTERVAL_MS);
  });

  it("defaults a missing time but refuses a bad one (req 11)", () => {
    const missing = validateRoutine({ ...base, cadence: { every: 1, unit: "days" } }, opts);
    expect(missing.ok).toBe(true);
    expect(missing.ok && missing.routine.cadence.at).toBe("09:00");

    const bad = validateRoutine({ ...base, cadence: { every: 1, unit: "days", at: "25:00" } }, opts);
    expect(bad).toEqual({ ok: false, error: "Enter a time like 08:00." });
  });

  it("accepts the agent's default, before AND after model discovery", () => {
    // The bug this pins: a routine saved as "Grok default" on a fresh host ran
    // once, populated the model cache as it went, and then could never be saved
    // or fired again — the exact-match gate could not find `model: ""` once the
    // list held concrete models instead of the sentinel.
    const emptyCache = [{ provider: "grok" as const, model: "", label: "Grok default" }];
    const discovered = [
      { provider: "grok" as const, model: "", label: "Grok default" },
      { provider: "grok" as const, model: "grok-4.6", label: "Grok 4.6" },
    ];
    const noSentinel = [{ provider: "grok" as const, model: "grok-4.6", label: "Grok 4.6" }];

    for (const models of [emptyCache, discovered, noSentinel]) {
      const saved = validateRoutine(
        { ...base, model: "", cadence: { every: 1, unit: "hours" } },
        { ...opts, models },
      );
      expect(saved.ok, JSON.stringify(models)).toBe(true);
      // And it stays the default rather than being pinned to a concrete row.
      expect(saved.ok && saved.routine.model).toBe("");
      expect(saved.ok && saved.routine.provider).toBe("grok");
    }
  });

  it("still refuses a default for a provider that is not connected", () => {
    const gone = validateRoutine(
      { ...base, provider: "codex", model: "", cadence: { every: 1, unit: "hours" } },
      opts,
    );
    expect(gone).toEqual({ ok: false, error: "Pick a model that is connected." });
  });

  it("refuses a model that is not connected (req 12)", () => {
    const gone = validateRoutine(
      { ...base, provider: "codex", model: "gpt-5.6-codex", cadence: { every: 1, unit: "hours" } },
      opts,
    );
    expect(gone).toEqual({ ok: false, error: "Pick a model that is connected." });
  });

  it("names what to do, not what failed", () => {
    const cadence = { every: 1, unit: "hours" as const };
    expect(validateRoutine({ ...base, title: "  ", cadence }, opts)).toEqual({
      ok: false,
      error: "Give the routine a name.",
    });
    expect(validateRoutine({ ...base, prompt: "", cadence }, opts)).toEqual({
      ok: false,
      error: "Write the prompt this routine should send.",
    });
    expect(validateRoutine({ ...base, cwd: "", cadence }, opts)).toEqual({
      ok: false,
      error: "Pick a project for this routine to run in.",
    });
    expect(validateRoutine({ ...base, cadence: { every: 1, unit: "fortnights" } }, opts)).toEqual({
      ok: false,
      error: "Pick how often this routine should run.",
    });
  });

  it("caps the stored strings", () => {
    const long = validateRoutine(
      { ...base, title: "t".repeat(500), prompt: "p".repeat(20_000), cadence: { every: 1, unit: "hours" } },
      opts,
    );
    expect(long.ok).toBe(true);
    expect(long.ok && long.routine.title.length).toBe(80);
    expect(long.ok && long.routine.prompt.length).toBe(8000);
  });
});

describe("run history", () => {
  const run = (startedAt: number, outcome: RoutineRun["outcome"] = "ran"): RoutineRun => ({
    routineId: "r1",
    windowKey: `i${startedAt}`,
    startedAt,
    outcome,
  });

  it("keeps the 20 newest, newest first (req 14)", () => {
    const many = Array.from({ length: 40 }, (_, i) => run(i));
    const kept = capRoutineRuns(many);
    expect(kept).toHaveLength(ROUTINE_RUN_HISTORY_LIMIT);
    expect(kept[0].startedAt).toBe(39);
    expect(kept[kept.length - 1].startedAt).toBe(20);
  });

  it("sweeps only running records (req 15)", () => {
    const swept = interruptStaleRuns(
      [run(1, "running"), run(2, "ran"), run(3, "skipped"), run(4, "failed")],
      99,
    );
    expect(swept.map((r) => r.outcome)).toEqual(["interrupted", "ran", "skipped", "failed"]);
    expect(swept[0].endedAt).toBe(99);
    expect(swept[0].detail).toContain("closed mid-run");
  });

  it("counts an interrupted run against health, not as a success", () => {
    const health = summarizeRuns([run(1, "ran"), run(2, "skipped"), run(3, "interrupted"), run(4, "failed")]);
    expect(health).toEqual({ ran: 1, skipped: 1, failed: 2, total: 4 });
  });

  it("ignores a still-running record in the totals", () => {
    expect(summarizeRuns([run(1, "ran"), run(2, "running")])).toEqual({
      ran: 1,
      skipped: 0,
      failed: 0,
      total: 1,
    });
  });
});

describe("naming a routine's session", () => {
  it("tags it and says which routine", () => {
    // A bare "[Routine]" answers why it is there but not which one, and the
    // rail can hold several.
    expect(routineSessionName("Morning brief")).toBe("[Routine] Morning brief");
    expect(routineSessionName("  Morning   brief  ")).toBe("[Routine] Morning brief");
  });

  it("does not stack tags when a routine is renamed", () => {
    expect(routineSessionName("[Routine] Morning brief")).toBe("[Routine] Morning brief");
  });

  it("degrades to the bare tag rather than a dangling prefix", () => {
    expect(routineSessionName("   ")).toBe(ROUTINE_SESSION_TAG);
  });

  it("stays inside the session-name cap", () => {
    expect(routineSessionName("x".repeat(500)).length).toBe(AUTO_NAME_MAX_CHARS);
  });
});

describe("display", () => {
  it("reads as a sentence in every unit", () => {
    expect(describeCadence({ every: 1, unit: "hours" })).toBe("Every hour");
    expect(describeCadence({ every: 6, unit: "hours" })).toBe("Every 6 hours");
    expect(describeCadence({ every: 15, unit: "minutes" })).toBe("Every 15 minutes");
    expect(describeCadence({ every: 1, unit: "days", at: "08:00" })).toBe("Every day at 08:00");
    expect(describeCadence({ every: 3, unit: "days", at: "08:00" })).toBe("Every 3 days at 08:00");
    expect(describeCadence({ every: 1, unit: "days" })).toBe("Every day at 09:00");
  });

  it("round-trips a time of day", () => {
    expect(parseTimeOfDay("08:00")).toBe(480);
    expect(parseTimeOfDay("8:05")).toBe(485);
    expect(parseTimeOfDay("23:59")).toBe(1439);
    expect(parseTimeOfDay("24:00")).toBeUndefined();
    expect(parseTimeOfDay("07:60")).toBeUndefined();
    expect(parseTimeOfDay("")).toBeUndefined();
    expect(parseTimeOfDay(undefined)).toBeUndefined();
    expect(formatTimeOfDay(485)).toBe("08:05");
  });
});
