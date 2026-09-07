import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grokCliNeedsShell, probeCliVersion } from "../src/cli-process";

describe("grok CLI process invocation", () => {
  it("uses a shell only for Windows command shims", () => {
    expect(grokCliNeedsShell("C:\\Users\\me\\.grok\\bin\\grok.cmd", "win32")).toBe(true);
    expect(grokCliNeedsShell("C:\\Tools\\grok.BAT", "win32")).toBe(true);
    expect(grokCliNeedsShell("C:\\Users\\me\\.grok\\bin\\grok.exe", "win32")).toBe(false);
    expect(grokCliNeedsShell("/usr/local/bin/grok.cmd", "linux")).toBe(false);
  });

  it("keeps every one-shot sidebar invocation on the shared wrapper", () => {
    const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    expect(sidebar).not.toMatch(/\bexecFile(?:Async)?\s*\(/);
    expect(sidebar).not.toMatch(/execGrokCli\([^\n]*\["mcp"/);
    expect(sidebar).toContain('client.listMcpServers()');
    // Pinned so a NEW one-shot invocation has to be noticed rather than slipped
    // in — which is what this count is for, and it worked: the ninth is the
    // remote grok sign-out. A cloud environment has no one to watch the terminal
    // the desk path opens, so that path runs the CLI through the wrapper and
    // waits for it instead.
    expect(sidebar.match(/execGrokCli\s*\(/g)).toHaveLength(10);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseCodexVersionOutput/);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseClaudeVersionOutput/);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseGeminiVersionOutput/);
  });

  it("shares the same shim predicate with the ACP spawn path", () => {
    const acp = readFileSync(new URL("../src/acp.ts", import.meta.url), "utf8");
    expect(acp).toContain("grokCliNeedsShell(this.opts.cliPath)");
  });

  it("probes CLI versions safely via probeCliVersion", () => {
    expect(probeCliVersion("")).toBeUndefined();
    expect(probeCliVersion("non-existent-binary-xyz-123")).toBeUndefined();
    // Node.js executable itself supports --version
    const nodeVer = probeCliVersion(process.execPath);
    expect(nodeVer).toMatch(/^v\d+\.\d+/);
  });
});

describe("sensitive files detection", () => {
  it("detects sensitive files in workspace root", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { findWorkspaceSensitiveFiles } = await import("../src/sidebar");

    expect(findWorkspaceSensitiveFiles(undefined)).toEqual([]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sens-test-"));
    try {
      expect(findWorkspaceSensitiveFiles(tmp)).toEqual([]);

      fs.writeFileSync(path.join(tmp, ".env"), "SECRET=123");
      fs.writeFileSync(path.join(tmp, "server.pem"), "CERT");
      fs.writeFileSync(path.join(tmp, "id_rsa"), "KEY");
      fs.writeFileSync(path.join(tmp, "normal.ts"), "code");

      const found = findWorkspaceSensitiveFiles(tmp);
      expect(found).toHaveLength(3);
      expect(found).toContain(".env");
      expect(found).toContain("server.pem");
      expect(found).toContain("id_rsa");
      expect(found).not.toContain("normal.ts");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
