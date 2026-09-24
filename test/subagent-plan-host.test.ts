// S-01 claims before start, S-04 follow-up refusals, S-05 report on disk.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { FileClaimStore } from "../src/file-claims";
import { SubagentRegistry } from "../src/companion-subagents";
import { AgentRunStore } from "../src/agent-run";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "sa-plan-"));
  dirs.push(root);
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.host = { appendLine: vi.fn() };
  sidebar.fileClaims = new FileClaimStore({
    dir: path.join(root, "claims"),
    fs: {
      mkdirSync: (p, o) => fs.mkdirSync(p, o), writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
      readFileSync: (p, e) => fs.readFileSync(p, e), readdirSync: (p) => fs.readdirSync(p),
      existsSync: (p) => fs.existsSync(p), unlinkSync: (p) => fs.unlinkSync(p), rmSync: (p, o) => fs.rmSync(p, o),
    },
    now: () => Date.now(),
    join: (...p) => path.join(...p),
  });
  const registry = new SubagentRegistry();
  sidebar.subagentState = { registry, reports: new Map(), waiters: new Map(), outcomes: new Map() };
  Object.defineProperty(sidebar, "agentRuns", { value: new AgentRunStore({ root, fs: {
    mkdirSync: (p, o) => { fs.mkdirSync(p, o); }, writeFileSync: (p, d) => fs.writeFileSync(p, d),
    appendFileSync: (p, d) => fs.appendFileSync(p, d), existsSync: (p) => fs.existsSync(p), rmSync: (p, o) => fs.rmSync(p, o),
  }, join: (...p) => path.join(...p) }) });
  sidebar.pool = new Set();
  return { sidebar, registry, root };
}

describe("subagent file claims before start (S-01)", () => {
  it("refuses a second writer on a named file, and globs never claim", () => {
    const { sidebar } = harness();
    expect(sidebar.preClaimSubagentFiles("run-a", "writer A", ["src/a.ts", "src/**"])).toBeUndefined();
    const conflict = sidebar.preClaimSubagentFiles("run-b", "writer B", ["src/b.ts", "src/a.ts"]);
    expect(conflict).toContain("src/a.ts is being edited by writer A");
    // B's partial claim was rolled back, so a third writer gets b.ts.
    expect(sidebar.preClaimSubagentFiles("run-c", "writer C", ["src/b.ts"])).toBeUndefined();
  });
});

describe("follow-up into a finished subagent (S-04)", () => {
  it("refuses while running and when the session is gone", async () => {
    const { sidebar, registry } = harness();
    registry.add({ subagentId: "sa1", parentSessionId: "p", runId: "run-1", step: 1, label: "Scan", target: { provider: "codex" },
      profile: "read-only", status: "running", startedAt: 0, background: false, spawnedInTurn: "1" });
    const parent = new Session();
    expect(await sidebar.continueSubagent(parent, "sa1", "more")).toMatchObject({ ok: false, code: "still-running" });
    registry.update("sa1", { status: "completed", childSessionId: "gone" }, 1);
    expect(await sidebar.continueSubagent(parent, "sa1", "more")).toMatchObject({ ok: false, code: "session-gone" });
  });
});

describe("reports after a reload (S-05)", () => {
  it("await read falls back to the raw report on disk", () => {
    const { sidebar, registry, root } = harness();
    registry.add({ subagentId: "sa2", parentSessionId: "p", runId: "run-2", step: 1, label: "Scan", target: { provider: "codex" },
      profile: "read-only", status: "completed", startedAt: 0, endedAt: 1, background: false, spawnedInTurn: "1" });
    mkdirSync(path.join(root, "run-2"), { recursive: true });
    writeFileSync(path.join(root, "run-2", "step-01.raw.md"), "the whole report", "utf8");
    expect(sidebar.readSubagentReport("sa2")).toBe("the whole report");
  });
});
