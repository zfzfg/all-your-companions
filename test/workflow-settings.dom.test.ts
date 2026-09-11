/**
 * Settings → Agents & Crew → Workflows (AP-18).
 *
 * The page paints the host's workflow list, offers Generate / Save with the
 * copy-deck strings, and posts saveWorkflow / generateWorkflow rather than
 * writing files itself.
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(fileURLToPath(new URL("../media/settings.js", import.meta.url)), "utf8");
const settingsCss = readFileSync(fileURLToPath(new URL("../media/settings.css", import.meta.url)), "utf8");

function workflowView(over: Record<string, unknown> = {}) {
  return {
    name: "idea-to-done",
    title: "Idea to done",
    whenToUse: "A feature or bug from a sentence.",
    scope: "builtin",
    hasStages: true,
    defaultGraph: false,
    isDefault: true,
    mermaid: "flowchart LR\n    plan --> implement",
    stages: [
      { id: "plan", title: "Plan", role: "planner", profile: "read-only" },
      { id: "implement", title: "Implement", role: "implementer", profile: "scoped-edit" },
    ],
    draft: { name: "idea-to-done", title: "Idea to done", stagesJson: { schemaVersion: 1, name: "idea-to-done" } },
    validation: { valid: true, errors: [], warnings: [] },
    ...over,
  };
}

function mount(snapshotOver: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://localhost/" });
  const document = window.document;
  (globalThis as Record<string, unknown>).window = window;
  (globalThis as Record<string, unknown>).document = document;
  const style = document.createElement("style");
  style.textContent = settingsCss;
  document.head.appendChild(style);
  const module = { exports: {} as Record<string, unknown> };
  new window.Function("module", "globalThis", settingsSrc)(module, window);
  const api = module.exports as {
    defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
    defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
    mount: (el: unknown, opts: Record<string, unknown>) => { update: (p: Record<string, unknown>) => void };
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const posted: Record<string, unknown>[] = [];
  api.mount(root, {
    snapshot: api.defaultSnapshot({
      agentRoles: [],
      crewFlows: [],
      workflows: [workflowView()],
      defaultWorkflow: "idea-to-done",
      agentRolesHasProject: true,
      ...snapshotOver,
    }),
    env: api.defaultEnv({}),
    post: (msg: Record<string, unknown>) => posted.push(msg),
    standalone: true,
    category: "agents",
  });
  return { window, root, posted, document };
}

const q = (root: unknown, sel: string) => (root as { querySelector: (s: string) => unknown }).querySelector(sel) as never;
const qa = (root: unknown, sel: string) =>
  Array.from((root as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll(sel)) as never[];

describe("Workflows settings", () => {
  it("paints the host's workflows with scope and default badges", () => {
    const { root } = mount();
    const panel = q(root, ".settings-agent-workflows") as { textContent: string };
    expect(panel.textContent).toContain("Idea to done");
    expect(panel.textContent).toContain("built-in");
    expect(panel.textContent).toContain("default");
    // The section's actions sit in its heading, beside the title.
    expect((root as unknown as { textContent: string }).textContent).toContain("Generate workflow…");
  });

  it("opens the generator with the copy-deck placeholder and Generate", () => {
    const { window, root, posted } = mount();
    (q(root, ".settings-workflow-generate") as { click: () => void }).click();
    const gen = q(root, ".settings-workflow-generator") as { textContent: string };
    expect(gen.textContent).toContain("Describe how you want this workflow to run.");
    expect(gen.textContent).toContain("Generate");
    const area = q(root, "[data-field=\"wfGenDescription\"]") as { value: string; dispatchEvent: (e: unknown) => void };
    area.value = "For bug reports: reproduce then fix";
    area.dispatchEvent(new window.Event("input"));
    (q(root, ".settings-workflow-generate-run") as { click: () => void }).click();
    expect(posted.some((m) => m.type === "generateWorkflow" && String(m.description).includes("reproduce"))).toBe(true);
  });

  it("posts saveWorkflow from the editor", () => {
    const { root, posted } = mount();
    (q(root, ".settings-workflow-toggle") as { click: () => void }).click();
    (q(root, ".settings-workflow-save") as { click: () => void }).click();
    const save = posted.find((m) => m.type === "saveWorkflow") as Record<string, unknown>;
    expect(save).toBeTruthy();
    expect(save.scope).toBe("project");
    expect((save.draft as { name: string }).name).toBe("idea-to-done");
  });

  it("sets the default from the card radio", () => {
    const { root, posted } = mount({
      workflows: [workflowView({ name: "bugfix", title: "Bugfix", isDefault: false, draft: { name: "bugfix", stagesJson: {} } })],
    });
    (q(root, ".settings-workflow-default") as { click: () => void }).click();
    expect(posted).toContainEqual({ type: "setDefaultWorkflow", name: "bugfix" });
  });
});
