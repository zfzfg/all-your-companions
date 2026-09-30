import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";

describe("AcpClient real spawn failure", () => {
  it.each([false, true])("rejects initialize through close (error listener: %s)", async (listenForError) => {
    const logs: string[] = [];
    const errors: NodeJS.ErrnoException[] = [];
    const requestTimeoutMs = 10_000;
    const client = new AcpClient({
      // A unique, nonexistent executable: no shell, adapter or provider CLI.
      cliPath: path.join(__dirname, `missing-acp-${randomUUID()}.exe`),
      cwd: __dirname,
      log: (message) => logs.push(message),
      timeouts: { requestTimeoutMs },
    });
    if (listenForError) client.on("error", (error) => errors.push(error));
    expect(client.listenerCount("error")).toBe(listenForError ? 1 : 0);

    const startedAt = performance.now();
    const starting = client.start();
    // Observe the real child, without mocking spawn or installing a client
    // error listener in the warm-up case. initialize is already in flight.
    const proc = (client as any).proc as ChildProcessWithoutNullStreams;
    const pending = (client as any).pending as Map<number, { method: string }>;
    const events: string[] = [];
    let spawnError: NodeJS.ErrnoException | undefined;
    proc.on("error", (error) => { spawnError = error; events.push("error"); });
    proc.on("exit", () => events.push("exit"));
    proc.on("close", () => events.push("close"));
    const rejection = starting.catch((error: Error) => {
      events.push("rejected");
      return error;
    });

    try {
      expect([...pending.values()].map((entry) => entry.method)).toEqual(["initialize"]);
      const error = await rejection;
      const elapsedMs = performance.now() - startedAt;
      expect(spawnError?.code).toBe("ENOENT");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^Grok process exited \(code -?\d+\)$/);
      expect(events).toEqual(["error", "close", "rejected"]);
      expect(pending.size).toBe(0);
      expect(logs.some((line) => /^spawn error: .*ENOENT/.test(line))).toBe(true);
      expect(errors).toEqual(listenForError ? [spawnError] : []);
      console.info(`spawn ENOENT (error listener: ${listenForError}): initialize rejected through close in ${elapsedMs.toFixed(1)} ms; request timeout ${requestTimeoutMs} ms`);
    } finally {
      await client.dispose();
    }
  }, 15_000);
});
