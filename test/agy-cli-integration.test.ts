import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { AgyAcpAdapterServer } from "../src/agy-acp-adapter";

it("streams through a real command shim with spaces and awaits child teardown", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy fake CLI "));
  const fixture = path.join(__dirname, "fixtures/fake-agy-stream.cjs");
  const cli = path.join(cwd, process.platform === "win32" ? "agy.cmd" : "agy");
  fs.writeFileSync(cli, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${fixture.replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
  const input = new PassThrough(); const output = new PassThrough();
  let proc: ChildProcessWithoutNullStreams | undefined;
  const server = new AgyAcpAdapterServer({ cwd, geminiHome: cwd, agyPath: cli,
    inputStream: input, outputStream: output, toolRules: "off", supportsInputFormat: true,
    spawnFn: (command, args, options) => { proc = spawn(command, args, options); return proc; } });
  try {
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fake CLI reply timed out")), 5000);
      let buffer = "";
      output.on("data", data => {
        buffer += data.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
          if (message.id === 1) { clearTimeout(timer); resolve(message); }
        }
      });
    });
    server.start(); input.write(JSON.stringify({ id: 1, method: "session/prompt", params: { text: "fixture" } }) + "\n");
    expect((await reply).result.stopReason).toBe("end_turn");
    const closed = new Promise<void>(resolve => { proc!.once("close", () => resolve()); });
    proc!.emit("error", new Error("post-spawn fixture error does not prove exit"));
    await server.shutdown();
    await closed;
    expect(proc).toBeDefined();
    expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true);
  } finally {
    await server.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 10000);
