import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  locateClaudeCli,
  parseClaudeVersionOutput,
  resolveClaudeSpawnTarget,
  type ClaudeLocatorFs,
} from "../src/claude-cli-locator";

function fakeFs(files: string[], texts: Record<string, string> = {}): ClaudeLocatorFs {
  const set = new Set(files);
  return {
    exists: (value) => set.has(value),
    isFile: (value) => set.has(value),
    readText: (value) => texts[value],
  };
}

function npmCmdShim(quotedTarget: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${quotedTarget} %*`,
    "",
  ].join("\r\n");
}

const npmShimTarget = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const npmShimFiles = ["C:\\npm\\claude.cmd", npmShimTarget];
const npmShimText = {
  "C:\\npm\\claude.cmd": npmCmdShim('"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"'),
};

describe("locateClaudeCli", () => {
  it("uses a valid configured override before PATH", () => {
    const configured = "C:\\tools\\claude.exe";
    expect(locateClaudeCli({
      configuredPath: configured,
      platform: "win32",
      fs: fakeFs([configured]),
      which: () => "C:\\path\\claude.cmd",
    })).toBe(configured);
  });

  it("returns undefined for an invalid configured override without falling through", () => {
    expect(locateClaudeCli({
      configuredPath: "missing",
      fs: fakeFs([]),
      which: () => "/bin/claude",
    })).toBeUndefined();
  });

  it("resolves a configured npm shim to the native exe behind it", () => {
    expect(locateClaudeCli({
      configuredPath: "C:\\npm\\claude.cmd",
      platform: "win32",
      fs: fakeFs(npmShimFiles, npmShimText),
      which: () => { throw new Error("configured path must not search PATH"); },
    })).toBe(npmShimTarget);
  });

  it("prefers a native exe on PATH over an npm shim", () => {
    const native = "C:\\Users\\Dev\\.local\\bin\\claude.exe";
    const asked: string[] = [];
    expect(locateClaudeCli({
      platform: "win32",
      fs: fakeFs([native, ...npmShimFiles], npmShimText),
      which: (name) => {
        asked.push(name);
        if (name === "claude.exe") return native;
        if (name === "claude.cmd") return "C:\\npm\\claude.cmd";
        return undefined;
      },
    })).toBe(native);
    expect(asked[0]).toBe("claude.exe");
  });

  it("resolves an npm claude.cmd on PATH to the package exe, not the shim", () => {
    const asked: string[] = [];
    expect(locateClaudeCli({
      platform: "win32",
      fs: fakeFs(npmShimFiles, npmShimText),
      which: (name) => {
        asked.push(name);
        return name === "claude.cmd" ? "C:\\npm\\claude.cmd" : undefined;
      },
    })).toBe(npmShimTarget);
    expect(asked).toEqual(["claude.exe", "claude.cmd"]);
  });

  it("does not return an unresolvable .cmd the SDK cannot spawn", () => {
    expect(locateClaudeCli({
      platform: "win32",
      fs: fakeFs(["C:\\npm\\claude.cmd"], { "C:\\npm\\claude.cmd": "@echo off\r\necho hi\r\n" }),
      which: (name) => name === "claude.cmd" ? "C:\\npm\\claude.cmd" : undefined,
    })).toBeUndefined();
  });

  it("falls back to the official user-bin location when PATH is empty", () => {
    const home = "C:\\Users\\Dev";
    const candidate = path.join(home, ".local", "bin", "claude.exe");
    expect(locateClaudeCli({
      home,
      platform: "win32",
      env: { LOCALAPPDATA: path.join(home, "AppData", "Local") },
      fs: fakeFs([candidate]),
      which: () => undefined,
    })).toBe(candidate);
  });
});

describe("resolveClaudeSpawnTarget", () => {
  it("keeps a native Windows exe and a POSIX path unchanged", () => {
    expect(resolveClaudeSpawnTarget("C:\\tools\\claude.exe", {
      platform: "win32",
      fs: fakeFs(["C:\\tools\\claude.exe"]),
    })).toBe("C:\\tools\\claude.exe");
    expect(resolveClaudeSpawnTarget("/usr/local/bin/claude", {
      platform: "linux",
      fs: fakeFs(["/usr/local/bin/claude"]),
    })).toBe("/usr/local/bin/claude");
  });

  it("prefers a sibling exe over reading the shim", () => {
    expect(resolveClaudeSpawnTarget("C:\\npm\\claude.cmd", {
      platform: "win32",
      fs: fakeFs(["C:\\npm\\claude.cmd", "C:\\npm\\claude.exe"]),
    })).toBe("C:\\npm\\claude.exe");
  });

  it("follows a JS cmd-shim to bin/claude.exe and skips node.exe", () => {
    const js = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const exe = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const shim = "C:\\npm\\claude.cmd";
    expect(resolveClaudeSpawnTarget(shim, {
      platform: "win32",
      fs: fakeFs(
        [shim, "C:\\npm\\node.exe", js, exe],
        {
          [shim]: [
            "@ECHO off",
            'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" )',
            `endLocal & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*`,
          ].join("\r\n"),
        },
      ),
    })).toBe(exe);
  });
});

describe("parseClaudeVersionOutput", () => {
  it("reads the numeric banner, not the adapter handshake constant", () => {
    expect(parseClaudeVersionOutput("2.1.233 (Claude Code)")).toBe("2.1.233");
    expect(parseClaudeVersionOutput("claude 2.1.233")).toBe("2.1.233");
    expect(parseClaudeVersionOutput("not a version")).toBe("");
  });
});

describe("Windows .cmd spawn vs resolved exe", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
    temps.length = 0;
  });

  it("launches the resolved exe the way the SDK does, and the shim cannot", () => {
    if (process.platform !== "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shim-"));
    temps.push(dir);
    const exe = path.join(dir, "claude.exe");
    const cmd = path.join(dir, "claude.cmd");
    fs.copyFileSync(process.execPath, exe);
    fs.writeFileSync(cmd, npmCmdShim(`"%dp0%claude.exe"`));

    const shimLaunch = spawnSync(cmd, ["-e", "process.stdout.write('from-shim')"], {
      shell: false,
      encoding: "utf8",
    });
    expect((shimLaunch.error as NodeJS.ErrnoException | undefined)?.code).toBe("EINVAL");

    const resolved = resolveClaudeSpawnTarget(cmd, { platform: "win32" });
    expect(resolved).toBe(exe);
    const nativeLaunch = spawnSync(resolved!, ["-e", "process.stdout.write('ok')"], {
      shell: false,
      encoding: "utf8",
    });
    expect(nativeLaunch.error).toBeUndefined();
    expect(nativeLaunch.status).toBe(0);
    expect(nativeLaunch.stdout).toBe("ok");
  });
});
