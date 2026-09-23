import * as fs from "node:fs";
import * as path from "node:path";
import { parseRunProgressUpdate, type RunProgressUpdate } from "./run-progress";

/** The notification log is not the workflow store. Only the run's terminal
 * state can repair a missed final notification; a quiet or all-done roster
 * can also occur between stages and is not evidence that the run ended. */
export function readWorkflowCompletion(
  sessionDir: string | undefined,
  previous: RunProgressUpdate,
  read: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): RunProgressUpdate | undefined {
  if (!sessionDir || previous.kind !== "workflow" || previous.done
    || !/^wf_[a-zA-Z0-9_-]+$/.test(previous.id)) return;
  try {
    const file = JSON.parse(read(path.join(sessionDir, "workflows", previous.id, "state.json")));
    if (!file || typeof file !== "object" || Array.isArray(file)) return;
    // CLI state files wrap the run in { version, state, script_revision }.
    // Accept flat states too, but never fall back past a malformed envelope.
    const state = "state" in file ? file.state : file;
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    if (typeof state.status !== "string" || !/^(complete|completed|failed|cancelled|stopped|budget_exceeded|error|success)$/.test(state.status)) return;
    const update = parseRunProgressUpdate({
      ...state, sessionUpdate: "workflow_updated", run_id: previous.id,
      display_name: previous.displayName,
      // Use the established terminal vocabulary for older renderers too.
      status: state.status === "complete" ? "completed" : state.status,
      elapsed_ms: state.elapsed_ms ?? state.elapsed_ms_floor,
    });
    if (!update?.done) return;
    // state.json has script_revision, not the notification sequence number.
    // Retain the latter so a replay cannot reject this repair as older.
    return { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
      revision: previous.revision };
  } catch {
    // Absent, unreadable or partially written state: retain the last observation
    // and retry on the next poll. Never invent a finish from a read failure.
    return;
  }
}
