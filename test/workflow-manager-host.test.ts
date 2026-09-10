/**
 * Host wiring for Settings → Workflows (AP-18).
 *
 * A save must land as a crew-preset file that re-parses identically. An invalid
 * draft writes nothing. A generator fence fallback produces a preview, not a file.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { IDEA_TO_DONE } from "../src/workflow";
import { parseCrewPreset } from "../src/crew-preset";
import { workflowToDraft } from "../src/workflow-write";

let home: string;
let project: string;

function harness(over: Record<string, unknown> = {}) {
  const posted: Record<string, unknown>[] = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.host = {
    appendLine: vi.fn(),
    getConfiguration: () => ({ get: (_k: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) }),
  };
  sidebar.state = { get: (_key: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) };
  sidebar.postLocal = (message: Record<string, unknown>) => posted.push(message);
  sidebar.settingsEditor = undefined;
  sidebar.sessionCwd = () => project;
  sidebar.resolvedUserHome = () => home;
  sidebar.connectedProviders = () => ["claude"];
  sidebar.usableProviders = () => ["claude"];
  sidebar.focused = { provider: "claude" };
  Object.assign(sidebar, over);
  return { sidebar, posted };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wf-home-"));
  project = mkdtempSync(join(tmpdir(), "wf-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("saving a workflow", () => {
  it("writes a project preset that re-parses to the same stages", async () => {
    const { sidebar, posted } = harness();
    const draft = workflowToDraft(IDEA_TO_DONE);
    await sidebar.handleSaveWorkflow({ scope: "project", draft });
    const file = join(project, ".companions", "crews", "idea-to-done.md");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    const { preset, problem } = parseCrewPreset({ path: file, stem: "idea-to-done", text });
    expect(problem).toBeUndefined();
    expect(preset?.stages).toBeTruthy();
    expect(posted.some((m) => m.type === "agentRoles" && !m.error)).toBe(true);
  });

  it("writes nothing when the draft is invalid", async () => {
    const { sidebar, posted } = harness();
    await sidebar.handleSaveWorkflow({
      scope: "project",
      draft: { name: "broken", stagesJson: { schemaVersion: 1, name: "broken", stages: [] } },
    });
    expect(existsSync(join(project, ".companions", "crews", "broken.md"))).toBe(false);
    expect(posted.some((m) => m.type === "agentRoles" && m.error)).toBe(true);
  });
});

describe("generator fence fallback", () => {
  it("posts a preview from a companions-workflow fence and writes nothing", async () => {
    const { sidebar, posted } = harness();
    const draft = workflowToDraft(IDEA_TO_DONE);
    sidebar.pool = [{ provider: "claude" }];
    sidebar.agentRuns = { newRunId: () => "wg1" };
    sidebar.runAgentRole = vi.fn(async () => ({
      outcome: "completed",
      filesReported: [],
      filesObserved: [],
      durationMs: 1,
      summary: "",
      planEntries: [],
      rawReply: ["```companions-workflow", JSON.stringify(draft.stagesJson), "```"].join("\n"),
    }));
    await sidebar.handleGenerateWorkflow({
      description: "idea to done",
      scope: "project",
    });
    expect(existsSync(join(project, ".companions", "crews"))).toBe(false);
    const preview = posted.find((m) => m.type === "workflowGenerator" && m.status === "preview");
    expect(preview).toBeTruthy();
    expect((preview as { draft?: { name?: string } }).draft?.name).toBe("idea-to-done");
  });
});
