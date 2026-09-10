/**
 * AP-17 persistence: atomic `run.json`, snapshot protection, staleness.
 * Behaviour lives in `workflow-run.ts`; this file is the named home spec §13.1
 * asked for so a later reader does not have to hunt inside the orchestrator
 * suite.
 */
import { describe, expect, it } from "vitest";
import { IDEA_TO_DONE, applyMaxFixerPasses, workflowSnapshotHash } from "../src/workflow";
import {
  makeWorkflowRun,
  parseWorkflowRun,
  serializeWorkflowRun,
  snapshotDrift,
  withSnapshotHash,
  writeAtomic,
  WorkflowRunStore,
} from "../src/workflow-run";

describe("run.json atomic write", () => {
  it("replaces via temp + rename so a crash mid-write cannot leave a half file as run.json", () => {
    const files = new Map<string, string>();
    const fs = {
      mkdirSync: () => undefined,
      writeFileSync: (path: string, data: string) => { files.set(path, data); },
      renameSync: (from: string, to: string) => {
        const data = files.get(from);
        if (data === undefined) throw new Error("missing tmp");
        files.set(to, data);
        files.delete(from);
      },
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
    };
    const store = new WorkflowRunStore({ root: "/runs", fs, join: (...p) => p.join("/") });
    const run = withSnapshotHash(
      makeWorkflowRun({
        runId: "run-1",
        sessionId: "s-1",
        workflow: IDEA_TO_DONE,
        idea: "Ship it",
        cwd: "/repo",
      }),
      "abcd",
    );
    store.writeRun(run);
    store.writeSnapshot("run-1", '{"name":"idea-to-done"}');
    expect(files.has("/runs/run-1/run.json.tmp")).toBe(false);
    expect(parseWorkflowRun(serializeWorkflowRun(store.readRun("run-1")!))?.idea).toBe("Ship it");
    writeAtomic(fs, "/runs/run-1/x.json", "{}");
    expect(files.get("/runs/run-1/x.json")).toBe("{}");
  });
});

describe("snapshot protection", () => {
  it("a later edit of the live workflow does not match a paused run's hash", () => {
    const snap = workflowSnapshotHash(IDEA_TO_DONE);
    const run = withSnapshotHash(
      makeWorkflowRun({
        runId: "run-1",
        sessionId: "s-1",
        workflow: IDEA_TO_DONE,
        idea: "x",
        cwd: "/r",
      }),
      snap,
    );
    expect(snapshotDrift(run, workflowSnapshotHash(applyMaxFixerPasses(IDEA_TO_DONE, 9)))).toBe(true);
    expect(snapshotDrift(run, snap)).toBe(false);
  });
});
