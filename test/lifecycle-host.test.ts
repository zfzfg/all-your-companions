import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  FAKE_UNIQUE_SESSION_IDS_ENV,
  LIFECYCLE_HOST_READY_LINE,
  LIFECYCLE_HOST_SHUTDOWN_LINE,
  LIFECYCLE_HOST_SHUTDOWN_STUCK_CODE,
  LIFECYCLE_WORKSPACES_ENV,
  UPLINK_ADMITTED_NEEDLE,
  attachStdinShutdown,
  createReadyScanner,
  isLifecycleShutdownLine,
  lifecycleChildEnv,
  parseLifecycleWorkspaces,
  superviseLifecycleChild,
  terminateAndWait,
} from "../scripts/lifecycle-host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("parseLifecycleWorkspaces", () => {
  it("splits on the OS path delimiter", () => {
    expect(parseLifecycleWorkspaces("C:\\a;C:\\b", ";")).toEqual(["C:\\a", "C:\\b"]);
    expect(parseLifecycleWorkspaces("/a:/b", ":")).toEqual(["/a", "/b"]);
  });

  it("accepts a JSON array so a path containing the delimiter survives", () => {
    expect(parseLifecycleWorkspaces('["/tmp/a","/tmp/b"]')).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("treats empty / missing as no workspaces", () => {
    expect(parseLifecycleWorkspaces(undefined)).toEqual([]);
    expect(parseLifecycleWorkspaces("")).toEqual([]);
    expect(parseLifecycleWorkspaces("   ")).toEqual([]);
  });

  it("rejects JSON that is not an array of paths", () => {
    expect(() => parseLifecycleWorkspaces('{"cwd":"/a"}')).toThrow(/array/i);
    expect(() => parseLifecycleWorkspaces("[")).toThrow(/JSON/i);
  });

  it("keeps the env name, ready line, and shutdown line stable for part 2", () => {
    expect(LIFECYCLE_WORKSPACES_ENV).toBe("GROK_LIFECYCLE_WORKSPACES");
    expect(LIFECYCLE_HOST_READY_LINE).toBe("GROK_LIFECYCLE_HOST_READY");
    expect(LIFECYCLE_HOST_SHUTDOWN_LINE).toBe("GROK_LIFECYCLE_HOST_SHUTDOWN");
    expect(LIFECYCLE_HOST_READY_LINE).toMatch(/^GROK_LIFECYCLE_HOST_READY$/);
    expect(isLifecycleShutdownLine(`  ${LIFECYCLE_HOST_SHUTDOWN_LINE}  `)).toBe(true);
    expect(isLifecycleShutdownLine("SIGINT")).toBe(false);
    expect(LIFECYCLE_HOST_SHUTDOWN_STUCK_CODE).toBe(2);
  });
});

describe("lifecycle-host runner", () => {
  it("applies the token gate before spawning Electron", () => {
    const src = fs.readFileSync(path.join(here, "..", "scripts", "lifecycle-host.mjs"), "utf8");
    const gateAt = src.indexOf("resolveInjectedDeviceToken({");
    const electronAt = src.indexOf("electronExe,");
    expect(gateAt).toBeGreaterThan(0);
    expect(electronAt).toBeGreaterThan(gateAt);
    expect(src).toContain("isProduction: false");
    expect(src).toContain("refusing to start");
  });

  it("forwards the device token into Electron instead of consuming it here", () => {
    const env = lifecycleChildEnv(
      {
        GROK_RELAY_DEVICE_TOKEN: "lifecycle-device-token",
        GROK_RELAY_URL: "ws://127.0.0.1:8791",
        PATH: "/bin",
      },
      { grokHome: "/tmp/grok-home", userData: "/tmp/user-data" },
    );
    expect(env.GROK_RELAY_DEVICE_TOKEN).toBe("lifecycle-device-token");
    expect(env[FAKE_UNIQUE_SESSION_IDS_ENV]).toBe("1");
    const src = fs.readFileSync(path.join(here, "..", "scripts", "lifecycle-host.mjs"), "utf8");
    expect(src).not.toMatch(/delete\s+env(?:In)?\.GROK_RELAY_DEVICE_TOKEN/);
    expect(src).not.toContain("consumeInjectedDeviceToken");
  });

  it("ready waits for relay admission, not the local socket open", () => {
    expect(UPLINK_ADMITTED_NEEDLE).toBe("[remote] relay clients:");
    const hits: number[] = [];
    const scanner = createReadyScanner(UPLINK_ADMITTED_NEEDLE, () => hits.push(1));
    scanner.push("[remote] uplink connected to ws://127.0.0.1:8791\n");
    expect(scanner.ready).toBe(false);
    scanner.push("[remote] relay cli");
    expect(scanner.ready).toBe(false);
    scanner.push("ents: 0\n");
    expect(scanner.ready).toBe(true);
    expect(hits).toEqual([1]);
    scanner.push("[remote] relay clients: 1\n");
    expect(hits).toEqual([1]);
  });
});

describe("lifecycle-host stdin shutdown", () => {
  it("fires once the exact token arrives on stdin", async () => {
    const stdin = new PassThrough();
    const hits: string[] = [];
    const stop = attachStdinShutdown(stdin, () => hits.push("down"));
    stdin.write("noise\n");
    stdin.write(`${LIFECYCLE_HOST_SHUTDOWN_LINE}\n`);
    await new Promise((r) => setTimeout(r, 30));
    expect(hits).toEqual(["down"]);
    stop();
    stdin.end();
  });

  it("waits for the child to actually exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const result = await terminateAndWait(child, { timeoutMs: 2_000, forceWaitMs: 1_000 });
    expect(result.timedOut).toBe(false);
    expect(child.exitCode != null || child.signalCode != null).toBe(true);
  });

  it("stays alive past the ready deadline once admitted, then exits on the stdin token", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => process.stdout.write('[remote] relay clients: 0\\n'), 10); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    const run = superviseLifecycleChild(child, {
      readyMs: 300,
      shutdownMs: 2_000,
      stdin,
      stdout,
      stderr,
    });
    try {
      await vi.waitFor(() => {
        expect(output).toContain(LIFECYCLE_HOST_READY_LINE);
      });
      // Well past the 300ms admission deadline — a leftover timer would have
      // rejected `run` with "relay did not admit this host" by now.
      await new Promise((r) => setTimeout(r, 400));
      expect(output).not.toMatch(/relay did not admit this host/);
      stdin.write(`${LIFECYCLE_HOST_SHUTDOWN_LINE}\n`);
      await expect(run).resolves.toBe(0);
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill();
      }
    }
  });

  it("still times out when the relay never admits the host", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await expect(
        superviseLifecycleChild(child, {
          readyMs: 50,
          shutdownMs: 2_000,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }),
      ).rejects.toThrow(/relay did not admit this host within 50ms/);
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill();
      }
    }
  });

  it("does not hang if the child never emits exit", async () => {
    const fake = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      pid: number;
      kill: () => boolean;
    };
    fake.exitCode = null;
    fake.signalCode = null;
    fake.pid = 424242;
    fake.kill = () => false;
    const result = await terminateAndWait(fake, { timeoutMs: 20, forceWaitMs: 20 });
    expect(result.timedOut).toBe(true);
  });
});
