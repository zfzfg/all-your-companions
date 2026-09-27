import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../src/routine-scheduler";
import { RoutineRunStore, type RunStoreFs } from "../src/routine-store";
import { Session } from "../src/session";

describe("RoutineScheduler", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-sched-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const realFs: RunStoreFs = {
    mkdirSync: (p, o) => void fs.mkdirSync(p, o),
    writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
    readFileSync: (p, e) => fs.readFileSync(p, e),
    readdirSync: (p) => fs.readdirSync(p),
    existsSync: (p) => fs.existsSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
  };

  function makeHarness() {
    const store = new Map<string, any>();
    const posted: string[] = [];
    const runStore = new RoutineRunStore({ dir, fs: realFs });
    const deps: RoutineSchedulerDeps = {
      state: {
        get: (k, def) => store.get(k) ?? def,
        update: vi.fn(async (k, val) => { store.set(k, val); }),
      },
      getRoutineRuns: () => runStore,
      usableProviders: () => ["grok"],
      resolveLocalRepoTarget: () => ({ path: "/test" }),
      newLocalSession: () => new Session(),
      addSessionToPool: vi.fn(),
      setSessionCwd: vi.fn(),
      workspaceRoot: () => "/workspace",
      startSession: vi.fn(async (_id, s) => {
        if (s) s.client = { sessionId: "s1" } as any;
        return s?.client;
      }),
      switchModel: vi.fn(async () => {}),
      deleteSessionCache: vi.fn(),
      postSessionName: vi.fn(),
      postRepoCatalog: vi.fn(),
      postSessionsList: vi.fn(),
      postRoutines: () => { posted.push("routines"); },
      handleSend: vi.fn(async () => {}),
    };
    const scheduler = createRoutineScheduler(deps);
    return { scheduler, deps, store, posted, runStore };
  }

  it("loads routines sorted by createdAt", async () => {
    const { scheduler } = makeHarness();
    await scheduler.saveRoutines([
      { id: "r2", cwd: "/test", title: "R2", prompt: "p2", provider: "grok", model: "m1", cadence: { every: 1, unit: "days", at: "09:00" }, createdAt: 200 },
      { id: "r1", cwd: "/test", title: "R1", prompt: "p1", provider: "grok", model: "m1", cadence: { every: 1, unit: "days", at: "08:00" }, createdAt: 100 },
    ]);
    const loaded = scheduler.loadRoutines();
    expect(loaded.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("skips routine if provider is not usable", async () => {
    const { scheduler, deps, posted, runStore } = makeHarness();
    deps.usableProviders = () => [];
    runStore.claim("r1", "window1", {
      routineId: "r1",
      windowKey: "window1",
      startedAt: Date.now(),
      outcome: "running",
    });
    await scheduler.runRoutine(
      { id: "r1", cwd: "/test", title: "R1", prompt: "p1", provider: "grok", model: "m1", cadence: { every: 1, unit: "days", at: "08:00" }, createdAt: 100 },
      "window1",
      Date.now(),
    );
    expect(posted).toContain("routines");
    const history = runStore.list("r1");
    expect(history[0]?.outcome).toBe("skipped");
  });
});
