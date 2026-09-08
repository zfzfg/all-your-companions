import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { locateGrokCli } from "../src/cli-locator";
import { locateClaudeCli } from "../src/claude-cli-locator";
import { locateCodexCli } from "../src/codex-cli-locator";
import { locateGeminiCli } from "../src/gemini-cli-locator";
import { findCliOnPath } from "../src/cli-path";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: vi.fn(() => { throw new Error("not on PATH"); }),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(execSync).mockReset().mockImplementation(() => { throw new Error("not on PATH"); });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("CLI PATH discovery without a shell (#151)", () => {
  it.each(["grok", "claude", "codex", "agy"])("expands PATHEXT for bare %s on win32 and skips non-files", (name) => {
    const binary = `C:\\bin\\${name}.cmd`;
    const checked: string[] = [];
    expect(findCliOnPath(name, { PATH: "C:\\gone;C:\\directory;C:\\bin", PATHEXT: ".CMD;.EXE" }, "win32", (p) => {
      checked.push(p);
      if (p.startsWith("C:\\gone")) throw new Error("EACCES");
      return p === binary;
    })).toBe(binary);
    expect(checked).toContain(`C:\\directory\\${name}.cmd`);
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("finds a Windows %s.cmd and ignores an earlier directory with that name", (provider) => {
    const shim = `C:\\npm\\${provider}.cmd`;
    const native = `C:\\npm\\package\\${provider}.exe`;
    const isFile = (candidate: string) => [shim, native].some((p) => p.toLowerCase() === candidate.toLowerCase());
    const options = {
      platform: "win32" as const,
      // A quoted PATH entry is legal on Windows and must still be searched.
      env: { Path: "C:\\directory;\"C:\\npm\"", PATHEXT: ".COM;.EXE;.CMD;.BAT" },
      home: "C:\\empty",
      fs: {
        exists: (candidate: string) => isFile(candidate) || candidate.toLowerCase() === `c:\\directory\\${provider}.cmd`,
        isFile,
        readDir: () => [],
        readText: () => `@echo off\r\n"${native}" %*`,
      },
    };
    const found = provider === "claude" ? locateClaudeCli(options) : locateCodexCli(options);
    expect(found?.toLowerCase()).toBe(provider === "claude" ? native.toLowerCase() : shim.toLowerCase());
    // Claude may try `where claude.exe` first: its native-first priority is intentional.
    expect(vi.mocked(execSync).mock.calls.some(([command]) => command === `where ${provider}.cmd`)).toBe(false);
  });

  it("honors custom PATHEXT entries for an extensionless Windows lookup", () => {
    const binary = "C:\\bin\\codex.custom";
    expect(locateCodexCli({
      platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".CUSTOM;.CMD" }, home: "C:\\empty",
      fs: { exists: () => true, isFile: (p) => p.toLowerCase() === binary.toLowerCase(), readDir: () => [] },
    })?.toLowerCase()).toBe(binary.toLowerCase());
    expect(vi.mocked(execSync).mock.calls.some(([command]) => command === "where codex")).toBe(false);
  });

  it("finds the Antigravity CLI on a Windows PATH without a shell", () => {
    const binary = "C:\\bin\\agy.cmd";
    expect(locateGeminiCli({
      platform: "win32", env: { Path: "C:\\bin", PATHEXT: ".COM;.EXE;.CMD" }, home: "C:\\empty",
      fs: { exists: () => false, isFile: (p: string) => p.toLowerCase() === binary.toLowerCase(), readText: () => undefined },
    })?.toLowerCase()).toBe(binary.toLowerCase());
    // agy.exe is tried first and may shell out; the .cmd that exists is found
    // in memory, so it never does.
    expect(vi.mocked(execSync).mock.calls.some(([command]) => command === "where agy.cmd")).toBe(false);
  });

  it.each(["claude", "codex"] as const)("falls through to hidden execSync when %s has no PATH match", (provider) => {
    const binary = `C:\\shell\\${provider}.exe`;
    vi.mocked(execSync).mockReturnValue(`${binary}\r\n`);
    const options = {
      platform: "win32" as const, env: { PATH: "C:\\missing" }, home: "C:\\empty",
      fs: { exists: () => false, isFile: (p: string) => p === binary, readDir: () => [] },
    };
    expect(provider === "claude" ? locateClaudeCli(options) : locateCodexCli(options)).toBe(binary);
    expect(execSync).toHaveBeenCalledWith(expect.stringMatching(/^where /), expect.objectContaining({ windowsHide: true }));
  });

  it("scans Grok's PATH for a regular executable and retains the shell fallback", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grok-path-"));
    dirs.push(dir);
    const first = path.join(dir, "directory");
    const second = path.join(dir, "bin");
    const name = process.platform === "win32" ? "grok.cmd" : "grok";
    mkdirSync(path.join(first, name), { recursive: true }); // a directory named like the binary
    mkdirSync(second);
    const binary = path.join(second, name);
    writeFileSync(binary, "", { mode: 0o755 });
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("PATH", [first, second].join(path.delimiter));
    vi.stubEnv("PATHEXT", ".COM;.EXE;.CMD;.BAT");

    expect(locateGrokCli("")?.toLowerCase()).toBe(binary.toLowerCase());
    expect(execSync).not.toHaveBeenCalled();
    expect(locateGrokCli(path.join(first, name))).toBeUndefined();

    vi.stubEnv("PATH", "");
    vi.mocked(execSync).mockReturnValue(`${binary}\n`);
    expect(locateGrokCli("")).toBe(binary);
    expect(execSync).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ windowsHide: true }));
  });
});
