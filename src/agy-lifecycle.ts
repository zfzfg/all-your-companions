import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type AgyTurnState = "queued" | "claimed" | "running" | "finalizing" | "cancelling" | "terminal";

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Turn cancelled"));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A timeout is a failure to confirm exit, never permission to replace the child. */
export function stopAgyProcess(
  proc: ChildProcessWithoutNullStreams,
  options: { platform?: NodeJS.Platform; graceMs?: number; timeoutMs?: number; spawnFn?: typeof spawn } = {},
): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(escalation);
      clearTimeout(deadline);
      proc.removeListener("exit", exited);
      proc.removeListener("close", exited);
      error ? reject(error) : resolve();
    };
    const exited = () => finish();
    const hardKill = () => {
      if (finished) return;
      if ((options.platform ?? process.platform) === "win32" && proc.pid !== undefined) {
        try {
          const child = (options.spawnFn ?? spawn)("taskkill", ["/PID", String(proc.pid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true });
          child.once("error", () => { if (!finished) { try { proc.kill("SIGKILL"); } catch { /* deadline reports failure */ } } });
          child.once("exit", code => { if (!finished && code !== 0) { try { proc.kill("SIGKILL"); } catch { /* deadline */ } } });
        } catch { try { proc.kill("SIGKILL"); } catch { /* deadline */ } }
      } else {
        try { proc.kill("SIGKILL"); } catch { /* deadline reports failure */ }
      }
    };
    const escalation = setTimeout(hardKill, options.graceMs ?? 1000);
    const deadline = setTimeout(() => finish(new Error("Antigravity process exit was not confirmed; restart blocked")), options.timeoutMs ?? 3000);
    proc.once("exit", exited);
    proc.once("close", exited);
    if ((options.platform ?? process.platform) === "win32") hardKill();
    else { try { proc.kill("SIGINT"); } catch { hardKill(); } }
  });
}
