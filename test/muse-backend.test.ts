import { AcpClient } from "../src/acp";
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { MuseBackend } from "../src/muse-backend";
import { locateMuseCli } from "../src/muse-cli-locator";
import { ACP_PROVIDERS, INTERNAL_PROVIDERS, isAcpProvider, isInternalProvider, supportsSessionDeletion, supportsModeSwitching, usesPerCallContextOccupancy } from "../src/acp-backend";

describe("Muse backend boundary", () => {
  it("spawns the installed ESM entry under Node with the user's executable", () => {
    const backend = new MuseBackend();
    const spec = backend.spawn({ cliPath: "/bin/muse", cwd: "/workspace", env: { TEST: "kept" } });
    expect(backend.provider).toBe("muse");
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(path.resolve(__dirname, "../src/muse-adapter/main.mjs"));
    expect(spec.env).toEqual({ TEST: "kept", ELECTRON_RUN_AS_NODE: "1", MUSE_CODE_EXECUTABLE: "/bin/muse" });
    expect(spec.shell).toBe(false);
  });

  it("honours an explicit Windows executable", () => {
    expect(locateMuseCli({ platform: "win32", configuredPath: "muse.exe", isExecutable: () => true })).toBe(path.resolve("muse.exe"));
    expect(locateMuseCli({ platform: "win32", env: { MUSE_CODE_EXECUTABLE: "muse.exe" }, isExecutable: () => true })).toBe(path.resolve("muse.exe"));
    expect(locateMuseCli({ platform: "win32", configuredPath: "missing.exe", isExecutable: () => false })).toBeUndefined();
  });

  it("does not probe the POSIX home-bin fallback on Windows", () => {
    const checked: string[] = [];
    expect(locateMuseCli({ platform: "win32", env: {}, home: "C:\\Users\\test", which: () => undefined,
      isExecutable: file => { checked.push(file); return true; },
    })).toBeUndefined();
    expect(checked).toEqual([]);
  });

  it("checks executability, honours an explicit missing path, and finds the user bin fallback", () => {
    const isExecutable = (file: string) => file === path.join("/home/test", ".local/bin/muse");
    const options = { platform: "darwin" as const, home: "/home/test", env: {}, isExecutable, which: () => undefined };
    expect(locateMuseCli(options)).toBe(path.join("/home/test", ".local/bin/muse"));
    expect(locateMuseCli({ ...options, configuredPath: "/missing" })).toBeUndefined();
  });
});


it("lists every page scoped to the requested workspace", async () => {
  const calls: any[] = [];
  const result = await new MuseBackend().listSessions(async (method, params) => {
    calls.push([method, params]);
    return { sessions: [{ sessionId: params.cursor ? "two" : "one", cwd: "/project", _meta: { turnCount: 2 } }],
      nextCursor: params.cursor ? null : "opaque" };
  }, "/project");
  expect(calls).toEqual([["session/list", { cwd: "/project" }], ["session/list", { cwd: "/project", cursor: "opaque" }]]);
  expect(result.sessions.map(s => s.sessionId)).toEqual(["one", "two"]);
  expect(result.sessions[0].turnCount).toBe(2);
});


it("reports Muse's exact context occupancy, including decreases and zero", () => {
  const client = new AcpClient({ cliPath: "/unused", cwd: "/workspace", backend: new MuseBackend(), log: () => {} });
  const seen: any[] = [];
  client.on("contextUsage", (...args) => seen.push(args));
  for (const used of [250, 100, 0]) (client as any).handleSessionUpdate({ sessionUpdate: "usage_update", used, size: 1007997 });
  expect(seen).toEqual([[250, 1007997], [100, 1007997], [0, 1007997]]);
});
