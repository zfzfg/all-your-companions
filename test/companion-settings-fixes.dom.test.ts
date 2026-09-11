/**
 * Settings fixes that came with the companion UI rework. Each test fails when
 * its production fix is reverted:
 *   1. The Routines form keeps its upstream field classes — the fork's own
 *      field helper used to share its name and silently replace it
 *   2. The two AP-16 toggles flip on the page without waiting for the host
 *   3. A list is fetched again on a second visit to its page
 *   4. A stages block that does not parse says so, instead of Save doing nothing
 *   5. A Validate answer lands on the editor that asked, not on the generator
 *   6. A refusal lands on the card of its own kind, even when names collide
 *   7. List-shaped settings render under their own title
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(fileURLToPath(new URL("../media/settings.js", import.meta.url)), "utf8");

type Api = {
  defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
  defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
  mount: (el: unknown, opts: Record<string, unknown>) => {
    update: (p: Record<string, unknown>) => void;
    setCategory: (c: string) => void;
  };
};

const WORKFLOW = {
  name: "hotfix",
  title: "Hotfix",
  whenToUse: "A known bug.",
  scope: "project",
  hasStages: true,
  defaultGraph: false,
  isDefault: false,
  mermaid: "flowchart LR\n  a --> b",
  stages: [{ id: "implement", title: "Implement", role: "implementer" }],
  draft: { name: "hotfix", title: "Hotfix", stagesJson: { schemaVersion: 1, name: "hotfix" } },
  validation: { valid: true, errors: [], warnings: [] },
};

const ROLE = {
  name: "hotfix",
  provider: "claude",
  providerLabel: "Claude",
  mode: "agent",
  scope: "project",
  providerPinned: true,
  whenToUse: "Fix it.",
  editable: true,
  draft: { name: "hotfix", provider: "claude", mode: "agent", whenToUse: "Fix it." },
};

function boot(snapshotOver: Record<string, unknown> = {}, category = "agents") {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: Api }).GrokSettings;
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const posted: Record<string, unknown>[] = [];
  const surface = api.mount(root, {
    snapshot: api.defaultSnapshot({
      agentRoles: [],
      crewFlows: [],
      workflows: [WORKFLOW],
      agentRoleProviders: [{ id: "claude", label: "Claude", connected: true, models: [] }],
      agentRolesHasProject: true,
      subagentRoster: [],
      subagentRouting: [],
      efforts: [],
      routines: [],
      routineProjects: [{ path: "/repo", name: "repo" }],
      routineModels: [],
      ...snapshotOver,
    }),
    env: api.defaultEnv({ providersKnown: true }),
    post: (m: Record<string, unknown>) => posted.push(m),
    standalone: true,
    category,
  });
  return { window, doc, root, posted, surface };
}

const click = (el: Element | null) => (el as unknown as { click: () => void }).click();

describe("companion settings fixes", () => {
  it("keeps the upstream Routines form fields", () => {
    const { root } = boot({}, "routines");
    const create = [...root.querySelectorAll("button")].find((b) => /new routine|create/i.test(b.textContent || ""));
    click(create!);
    expect(root.querySelector(".settings-routine-field")).not.toBeNull();
    expect(root.querySelector(".settings-routine-form .settings-agent-field, .settings-routine-body .settings-agent-field")).toBeNull();
  });

  it("flips the subagent toggles locally", () => {
    const { root } = boot({ subagentsEnabled: true, crewStagesMayUseSubagents: false });
    const row = (id: string) => root.querySelector(`.settings-row[data-id="${id}"] .settings-switch`)!;
    click(row("subagentsEnabled"));
    expect(row("subagentsEnabled").getAttribute("aria-checked")).toBe("false");
    click(row("crewStageSubagents"));
    expect(row("crewStageSubagents").getAttribute("aria-checked")).toBe("true");
  });

  it("asks for the lists again on a second visit", () => {
    const { posted, surface } = boot({}, "advanced");
    surface.setCategory("agents");
    surface.setCategory("advanced");
    expect(posted.filter((m) => m.type === "listRuleFiles")).toHaveLength(2);
    expect(posted.filter((m) => m.type === "listPermissionRules")).toHaveLength(2);
    expect(posted.filter((m) => m.type === "listAgentRoles")).toHaveLength(1);
  });

  it("says why Save did nothing when the stages block does not parse", () => {
    const { window, root, posted } = boot();
    click(root.querySelector(".settings-workflow-toggle"));
    const json = root.querySelector('[data-field="stagesJsonText"]') as unknown as HTMLTextAreaElement;
    json.value = "{ not json";
    json.dispatchEvent(new window.Event("input") as unknown as Event);
    click(root.querySelector(".settings-workflow-save"));
    expect(posted.some((m) => m.type === "saveWorkflow")).toBe(false);
    expect(root.querySelector(".settings-agent-field-error")!.textContent).toMatch(/Not valid JSON/);
  });

  it("puts a Validate answer on the editor, and leaves the generator alone", () => {
    const { root, posted, surface } = boot();
    click(root.querySelector(".settings-workflow-toggle"));
    click(root.querySelector(".settings-workflow-validate"));
    expect(posted.some((m) => m.type === "validateWorkflow")).toBe(true);
    surface.update({
      workflowGenerator: {
        status: "error",
        requestId: "validate",
        error: "stage `review` names role `qa`, which does not exist",
      },
    });
    const editor = root.querySelector('[data-workflow="hotfix"] .settings-agent-form')!;
    expect(editor.textContent).toContain("names role `qa`");
    expect(root.querySelector(".settings-workflow-generator")).toBeNull();
  });

  it("shows a refusal only on the card of its kind", () => {
    const { root, surface } = boot({ agentRoles: [ROLE] });
    click(root.querySelector('[data-role="hotfix"] .settings-agent-toggle'));
    surface.update({ agentRolesError: "workflow problem", agentRolesErrorId: "workflow:hotfix" });
    expect(root.querySelector('[data-role="hotfix"] .settings-agent-error')).toBeNull();
    surface.update({ agentRolesError: "role problem", agentRolesErrorId: "role:hotfix" });
    expect(root.querySelector('[data-role="hotfix"] .settings-agent-error')!.textContent).toBe("role problem");
  });

  it("titles each list-shaped setting", () => {
    const { root } = boot();
    const titles = [...root.querySelectorAll(".settings-list-section-title")].map((el) => el.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Roles", "Subagents", "Routing rules", "Crew flows", "Workflows"]));
  });
});
