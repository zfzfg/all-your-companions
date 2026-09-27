/**
 * RoutineScheduler: background cron/cadence scheduler for agent tasks.
 * Extracted from GrokSidebar as part of W-15 (Step S7b).
 */

import type { AcpProvider } from "./acp-backend";
import { providerDisplayName } from "./provider-ui";
import {
  ROUTINES_KEY,
  type Routine,
  type RoutineRun,
  routineWindow,
  routineSessionName,
} from "./routines";
import { RoutineRunStore } from "./routine-store";
import type { Session } from "./session";
import type { SessionMetaOverrides } from "./sessions";
import { SESSION_META_KEY } from "./worktree-host";

export interface RoutineSchedulerDeps {
  state: {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: any): Thenable<void> | Promise<void>;
  };
  getRoutineRuns(): RoutineRunStore;
  usableProviders(): AcpProvider[];
  resolveLocalRepoTarget(cwd: string): any;
  newLocalSession(): Session;
  addSessionToPool(session: Session): void;
  setSessionCwd(session: Session, cwd: string, root: string): void;
  workspaceRoot(): string;
  startSession(id?: string, session?: Session): Promise<any>;
  switchModel(model: string, session: Session, provider?: AcpProvider): Promise<void>;
  deleteSessionCache(id: string): void;
  postSessionName(session: Session): void;
  postRepoCatalog(): void;
  postSessionsList(): void;
  postRoutines(): void;
  handleSend(prompt: string, isSteer: boolean, session: Session): Promise<void>;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class RoutineScheduler {
  public routineTimer?: NodeJS.Timeout;
  public readonly routinesInFlight = new Set<string>();

  constructor(private readonly deps: RoutineSchedulerDeps) {}

  public loadRoutines(): Routine[] {
    const raw = this.deps.state.get<Record<string, Routine>>(ROUTINES_KEY, {});
    return Object.values(raw || {})
      .filter((r) => r && typeof r.id === "string" && typeof r.cwd === "string")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  public async saveRoutines(routines: readonly Routine[]): Promise<void> {
    const map: Record<string, Routine> = {};
    for (const routine of routines) map[routine.id] = routine;
    await this.deps.state.update(ROUTINES_KEY, map);
  }

  public startRoutineScheduler(): void {
    const now = Date.now();
    const runs = this.deps.getRoutineRuns();
    for (const routine of this.loadRoutines()) runs.sweepInterrupted(routine.id, now);

    this.routineTimer = setInterval(() => void this.tickRoutines(), 60_000);
    this.routineTimer.unref?.();
  }

  public dispose(): void {
    if (this.routineTimer) {
      clearInterval(this.routineTimer);
      this.routineTimer = undefined;
    }
  }

  public async tickRoutines(): Promise<void> {
    const now = Date.now();
    const runs = this.deps.getRoutineRuns();
    for (const routine of this.loadRoutines()) {
      if (routine.paused) continue;
      if (this.routinesInFlight.has(routine.id)) continue;
      const { key } = routineWindow(routine, now);
      if (!key) continue;
      const claimed = runs.claim(routine.id, key, {
        routineId: routine.id,
        windowKey: key,
        startedAt: now,
        outcome: "running",
      });
      if (!claimed) continue;
      await this.runRoutine(routine, key, now);
    }
  }

  public async runRoutine(routine: Routine, windowKey: string, startedAt: number): Promise<void> {
    const runs = this.deps.getRoutineRuns();
    this.routinesInFlight.add(routine.id);
    const finish = (outcome: RoutineRun["outcome"], extra: Partial<RoutineRun> = {}): void => {
      runs.finish({
        routineId: routine.id,
        windowKey,
        startedAt,
        endedAt: Date.now(),
        outcome,
        cwd: routine.cwd,
        ...extra,
      });
      runs.prune(routine.id);
      this.routinesInFlight.delete(routine.id);
      this.deps.postRoutines();
    };

    if (!this.deps.usableProviders().includes(routine.provider)) {
      finish("skipped", { detail: `Skipped — ${providerDisplayName(routine.provider)} was not connected` });
      return;
    }
    if (!this.deps.resolveLocalRepoTarget(routine.cwd)) {
      finish("skipped", { detail: "Skipped — the project is no longer available" });
      return;
    }

    try {
      const session = this.deps.newLocalSession();
      this.deps.addSessionToPool(session);
      this.deps.setSessionCwd(session, routine.cwd, this.deps.workspaceRoot());
      session.provider = routine.provider;
      const client = await this.deps.startSession(undefined, session);
      if (!client) {
        finish("failed", { detail: "Failed — the agent could not start" });
        return;
      }
      if (routine.model) await this.deps.switchModel(routine.model, session, routine.provider);
      const sessionId = session.client?.sessionId;
      runs.finish({
        routineId: routine.id,
        windowKey,
        startedAt,
        outcome: "running",
        cwd: routine.cwd,
        ...(sessionId ? { sessionId } : {}),
      });
      if (sessionId) {
        const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
        await this.deps.state.update(SESSION_META_KEY, {
          ...overrides,
          [sessionId]: {
            ...(overrides[sessionId] ?? {}),
            customName: routineSessionName(routine.title),
          },
        });
        this.deps.deleteSessionCache(sessionId);
        this.deps.postSessionName(session);
      }
      this.deps.postRepoCatalog();
      this.deps.postSessionsList();
      this.deps.postRoutines();

      await this.deps.handleSend(routine.prompt, false, session);
      const failed = session.status === "error";
      finish(failed ? "failed" : "ran", {
        cwd: routine.cwd,
        ...(session.client?.sessionId ? { sessionId: session.client.sessionId } : {}),
        ...(failed ? { detail: "Failed — the turn ended in an error" } : {}),
      });
    } catch (e) {
      finish("failed", { detail: `Failed — ${(e as Error).message}` });
    }
  }
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  return new RoutineScheduler(deps);
}
