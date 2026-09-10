/**
 * Settings → Agents & Crew, the page half of the feature.
 *
 * The page this replaces painted a HARDCODED list of the five built-ins: it
 * could not show a custom role, could not show a broken file, and had no
 * controls at all. So the first requirement below is the one the whole feature
 * rests on — what you see is what the host actually loaded.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. The list is the host's, not a constant — a custom role appears, and a
 *      built-in the host did not send does not
 *   2. The collapsed row answers "who runs this" without being opened:
 *      companion, model and scope
 *   3. Opening a card reveals the editor; the companion select offers every
 *      provider, connected or not, and says which is which
 *   4. Changing the companion re-fills the model list and drops the old
 *      model — a model of the previous provider is not a model of this one
 *   5. A provider whose model cache is cold gets free text, never an empty
 *      dropdown that reads as "this companion has no models"
 *   6. Save posts the EDITED draft, with the scope and the original name
 *   7. Delete takes two clicks, and the second one says what it removes
 *   8. Opening the category asks the host for the list exactly once
 *   9. Role-file problems are shown on the page
 *  10. A refusal lands on the card that caused it, and the draft survives
 *  11. The flow editor posts a reordered role list
 *  12. A flow's roles can be added, moved and removed before saving
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(fileURLToPath(new URL("../media/settings.js", import.meta.url)), "utf8");
const settingsCss = readFileSync(fileURLToPath(new URL("../media/settings.css", import.meta.url)), "utf8");

function roleView(over: Record<string, unknown> = {}) {
  return {
    name: "reviewer",
    provider: "claude",
    providerLabel: "Claude",
    model: "claude-opus-5",
    mode: "agent",
    scope: "project",
    path: ".companions/agents/reviewer.md",
    whenToUse: "Checking finished work against its briefing.",
    editable: true,
    providerPinned: true,
    draft: {
      name: "reviewer",
      provider: "claude",
      model: "claude-opus-5",
      mode: "agent",
      whenToUse: "Checking finished work against its briefing.",
    },
    ...over,
  };
}

function flowView(over: Record<string, unknown> = {}) {
  return {
    name: "default",
    roles: ["planner", "implementer", "reviewer"],
    verify: "npm test",
    reviewEvery: 2,
    scope: "project",
    path: ".companions/crews/default.md",
    draft: {
      name: "default",
      roles: ["planner", "implementer", "reviewer"],
      verify: "npm test",
      reviewEvery: 2,
    },
    ...over,
  };
}

const PROVIDERS = [
  { id: "grok", label: "Grok", connected: false, models: [{ modelId: "grok-4.6" }] },
  { id: "claude", label: "Claude", connected: true, models: [{ modelId: "claude-opus-5" }, { modelId: "claude-haiku-4-5" }] },
  // Deliberately cold: the page must offer free text rather than an empty list.
  { id: "gemini", label: "Gemini", connected: true, models: [] },
];

function mount(snapshotOver: Record<string, unknown> = {}, envOver: Record<string, unknown> = {}) {
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
    mount: (el: unknown, opts: Record<string, unknown>) => { update: (p: Record<string, unknown>) => void; setCategory: (c: string) => void };
  };

  const root = document.createElement("div");
  document.body.appendChild(root);
  const posted: Record<string, unknown>[] = [];
  const surface = api.mount(root, {
    snapshot: api.defaultSnapshot({
      agentRoles: [roleView()],
      crewFlows: [flowView()],
      agentRoleProviders: PROVIDERS,
      agentRoleProblems: [],
      agentRolesHasProject: true,
      agentRolesCwd: "C:/repo",
      ...snapshotOver,
    }),
    env: api.defaultEnv(envOver),
    post: (msg: Record<string, unknown>) => posted.push(msg),
    standalone: true,
    category: "agents",
  });
  return { window, document, root, posted, surface };
}

const q = (root: unknown, sel: string) => (root as { querySelector: (s: string) => unknown }).querySelector(sel) as never;
const qa = (root: unknown, sel: string) =>
  Array.from((root as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll(sel)) as never[];

function click(el: unknown) {
  (el as { click: () => void }).click();
}

function openCard(root: unknown, name: string) {
  const card = qa(root, ".settings-agent-card[data-role]").find(
    (c) => (c as unknown as { dataset: { role?: string } }).dataset.role === name,
  );
  click(q(card, ".settings-agent-toggle"));
  return card;
}

describe("Agents & Crew — the role list", () => {
  it("paints the host's roles, not a hardcoded set", () => {
    // Requirement 1. The old page listed planner/implementer/reviewer/
    // researcher/fixer no matter what the host had loaded.
    const { root } = mount({ agentRoles: [roleView({ name: "auditor", draft: { name: "auditor", provider: "claude", whenToUse: "x" } })] });
    const names = qa(root, ".settings-agent-card[data-role]").map(
      (c) => (c as unknown as { dataset: { role?: string } }).dataset.role,
    );
    expect(names).toEqual(["auditor"]);
    // Scoped to the roles panel: the crew-flow summary legitimately names
    // roles this project does not define.
    const panel = q(root, ".settings-agent-roles") as unknown as { textContent: string };
    expect(panel.textContent).not.toContain("implementer");
  });

  it("says who runs a role without the card being opened", () => {
    // Requirement 2 — the thing the whole feature is for.
    const { root } = mount();
    const card = qa(root, ".settings-agent-card[data-role]")[0];
    const text = (card as unknown as { textContent: string }).textContent;
    expect(text).toContain("Claude");
    expect(text).toContain("claude-opus-5");
    expect(text).toContain("this project");
    expect(text).toContain("/agent reviewer");
  });

  it("says a built-in's companion is chosen at run time, not pinned", () => {
    // The row must not read as a promise. A built-in carries a placeholder
    // provider the host resolves when the role runs, and printing it the same
    // way as a pinned one is the misreport this feature exists to remove.
    const { root } = mount({
      agentRoles: [roleView({ scope: "builtin", path: undefined, providerPinned: false, model: undefined })],
    });
    const card = qa(root, ".settings-agent-card[data-role]")[0];
    expect((card as unknown as { textContent: string }).textContent).toContain("Claude (chosen when it runs)");

    openCard(root, "reviewer");
    const hint = qa(root, ".settings-agent-field-hint").map((h) => (h as unknown as { textContent: string }).textContent);
    expect(hint.join(" ")).toContain("saving pins it");
  });

  it("marks a role that overrides a wider scope", () => {
    const { root } = mount({ agentRoles: [roleView({ scope: "project", overrides: "global" })] });
    expect((root as unknown as { textContent: string }).textContent).toContain("overrides all projects");
  });

  it("shows a loading line before the host has answered", () => {
    const { root } = mount({ agentRoles: null, crewFlows: null });
    expect((root as unknown as { textContent: string }).textContent).toContain("Reading roles…");
  });

  it("asks the host for the list exactly once when the category opens", () => {
    // Requirement 8 — the latch, not a request per repaint.
    const { posted, surface } = mount();
    surface.update({ agentRolesCwd: "C:/other" });
    surface.update({ agentRolesCwd: "C:/third" });
    expect(posted.filter((m) => m.type === "listAgentRoles")).toHaveLength(1);
  });

  it("shows role-file problems on the page", () => {
    // Requirement 9. Previously visible only if you happened to run /agent.
    const { root } = mount({ agentRoleProblems: ["`reviewer.md` could not be read — missing a `---` frontmatter block."] });
    const strip = q(root, ".settings-agent-problems");
    expect(strip).toBeTruthy();
    expect((strip as unknown as { textContent: string }).textContent).toContain("missing a `---` frontmatter block");
  });
});

describe("Agents & Crew — the role editor", () => {
  it("offers every companion, connected or not, and says which is which", () => {
    // Requirement 3. Hiding a disconnected companion would make a role file
    // pinned to it look impossible to author.
    const { root } = mount();
    openCard(root, "reviewer");
    const select = q(root, '.settings-agent-form select[data-field="provider"]');
    const options = qa(select, "option").map((o) => (o as unknown as { textContent: string }).textContent);
    expect(options).toEqual(["Grok · not connected", "Claude", "Gemini"]);
  });

  it("re-fills the model list when the companion changes, dropping the old model", () => {
    // Requirement 4. A model of the previous provider is not a model of this
    // one, and leaving it would write a role the host then refuses.
    const { root } = mount();
    openCard(root, "reviewer");
    const provider = q(root, '.settings-agent-form select[data-field="provider"]') as unknown as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    provider.value = "grok";
    provider.dispatchEvent(new (globalThis as never as { window: { Event: new (t: string) => unknown } }).window.Event("change"));
    const model = q(root, '.settings-agent-form [data-field="model"]') as unknown as { value: string; tagName: string };
    expect(model.tagName).toBe("SELECT");
    expect(model.value).toBe("");
    const options = qa(model, "option").map((o) => (o as unknown as { value: string }).value);
    expect(options).toContain("grok-4.6");
    expect(options).not.toContain("claude-opus-5");
  });

  it("offers free text when a companion's model cache is cold", () => {
    // Requirement 5 — an empty dropdown reads as "this companion has no
    // models", which is a different and wrong claim.
    const { root } = mount({ agentRoles: [roleView({ provider: "gemini", draft: { name: "reviewer", provider: "gemini", whenToUse: "x" } })] });
    openCard(root, "reviewer");
    const model = q(root, '.settings-agent-form [data-field="model"]') as unknown as { tagName: string };
    expect(model.tagName).toBe("INPUT");
  });

  it("posts the edited draft, the scope and the original name", () => {
    // Requirement 6. Posting the host's original view instead of the draft is
    // the bug that makes an editor look like it works and change nothing.
    const { root, posted, window } = mount();
    openCard(root, "reviewer");
    const when = q(root, '.settings-agent-form [data-field="whenToUse"]') as unknown as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    when.value = "Only for security-sensitive changes.";
    when.dispatchEvent(new window.Event("input"));
    click(q(root, ".settings-agent-save"));

    const save = posted.find((m) => m.type === "saveAgentRole") as Record<string, unknown>;
    expect(save).toBeTruthy();
    expect(save.originalName).toBe("reviewer");
    expect(save.scope).toBe("project");
    expect((save.draft as Record<string, unknown>).whenToUse).toBe("Only for security-sensitive changes.");
  });

  it("tells the host where the role used to live when the scope changes", () => {
    // Without `originalScope` the host cannot remove the project file, which
    // keeps winning — so the move succeeds and looks like it failed.
    const { root, posted, window } = mount();
    openCard(root, "reviewer");
    const scope = q(root, '.settings-agent-form select[data-field="cardScope"]') as unknown as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    scope.value = "global";
    scope.dispatchEvent(new window.Event("change"));
    click(q(root, ".settings-agent-save"));
    const save = posted.find((m) => m.type === "saveAgentRole") as Record<string, unknown>;
    expect(save.scope).toBe("global");
    expect(save.originalScope).toBe("project");
  });

  it("sends no original scope for a built-in, which has no file yet", () => {
    const { root, posted } = mount({
      agentRoles: [roleView({ scope: "builtin", path: undefined, providerPinned: false })],
    });
    openCard(root, "reviewer");
    click(q(root, ".settings-agent-save"));
    const save = posted.find((m) => m.type === "saveAgentRole") as Record<string, unknown>;
    expect(save.originalScope).toBeUndefined();
  });

  it("writes a new role with no original name", () => {
    const { root, posted } = mount();
    click(q(root, ".settings-agent-new"));
    click(q(root, ".settings-agent-save"));
    const save = posted.find((m) => m.type === "saveAgentRole") as Record<string, unknown>;
    expect(save.originalName).toBeUndefined();
  });

  it("takes two clicks to delete, and the second says what it removes", () => {
    // Requirement 7.
    const { root, posted } = mount();
    openCard(root, "reviewer");
    const remove = q(root, ".settings-agent-remove");
    expect((remove as unknown as { textContent: string }).textContent).toBe("Delete");
    click(remove);
    expect(posted.some((m) => m.type === "deleteAgentRole")).toBe(false);
    const armed = q(root, ".settings-agent-remove");
    expect((armed as unknown as { textContent: string }).textContent).toContain("reviewer.md");
    click(armed);
    const del = posted.find((m) => m.type === "deleteAgentRole") as Record<string, unknown>;
    expect(del.name).toBe("reviewer");
    expect(del.scope).toBe("project");
  });

  it("calls deleting a materialised built-in a reset", () => {
    const { root } = mount({ agentRoles: [roleView({ overrides: "builtin" })] });
    openCard(root, "reviewer");
    expect((q(root, ".settings-agent-remove") as unknown as { textContent: string }).textContent).toBe("Reset to built-in");
  });

  it("offers no delete for a built-in that has no file yet", () => {
    const { root } = mount({ agentRoles: [roleView({ scope: "builtin", path: undefined })] });
    openCard(root, "reviewer");
    expect(q(root, ".settings-agent-remove")).toBeNull();
  });

  it("keeps the draft and shows the refusal on the card that caused it", () => {
    // Requirement 10 — a refusal on a blank form cannot be acted on.
    const { root, surface, window } = mount();
    openCard(root, "reviewer");
    const when = q(root, '.settings-agent-form [data-field="whenToUse"]') as unknown as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    when.value = "edited text";
    when.dispatchEvent(new window.Event("input"));
    click(q(root, ".settings-agent-save"));
    surface.update({ agentRolesError: "A role called `reviewer` already exists here.", agentRolesErrorId: "reviewer" });

    expect((q(root, ".settings-agent-error") as unknown as { textContent: string }).textContent).toContain("already exists");
    const still = q(root, '.settings-agent-form [data-field="whenToUse"]') as unknown as { value: string };
    expect(still.value).toBe("edited text");
  });

  it("closes the editor once the host confirms the save", () => {
    const { root, surface } = mount();
    openCard(root, "reviewer");
    click(q(root, ".settings-agent-save"));
    surface.update({ agentRoles: [roleView()], agentRolesError: "" });
    expect(q(root, ".settings-agent-form")).toBeNull();
  });

  it("forces the all-projects scope when no folder is open", () => {
    const { root } = mount({ agentRolesHasProject: false });
    openCard(root, "reviewer");
    const scope = q(root, '.settings-agent-form select[data-field="cardScope"]') as unknown as { disabled: boolean };
    expect(scope.disabled).toBe(true);
  });
});

describe("Agents & Crew — the flow editor", () => {
  function openFlow(root: unknown, name: string) {
    const card = qa(root, ".settings-agent-card[data-flow]").find(
      (c) => (c as unknown as { dataset: { flow?: string } }).dataset.flow === name,
    );
    click(q(card, ".settings-flow-toggle"));
    return card;
  }

  it("summarises the flow without being opened", () => {
    const { root } = mount();
    const card = qa(root, ".settings-agent-card[data-flow]").find(
      (c) => (c as unknown as { dataset: { flow?: string } }).dataset.flow === "default",
    );
    const text = (card as unknown as { textContent: string }).textContent;
    expect(text).toContain("planner → implementer → reviewer");
    expect(text).toContain("review every 2");
    expect(text).toContain("npm test");
  });

  it("posts a reordered role list", () => {
    // Requirement 11. Order is not decoration: it decides an ambiguous
    // assignment now that the pool is the flow's.
    const { root, posted } = mount();
    openFlow(root, "default");
    const downs = qa(root, ".settings-agent-pool-down");
    click(downs[0]);
    click(q(root, ".settings-flow-save"));
    const save = posted.find((m) => m.type === "saveCrewFlow") as Record<string, unknown>;
    expect((save.draft as Record<string, unknown>).roles).toEqual(["implementer", "planner", "reviewer"]);
  });

  it("removes a role from the pool", () => {
    // Requirement 12.
    const { root, posted } = mount();
    openFlow(root, "default");
    click(qa(root, ".settings-agent-pool-remove")[1]);
    click(q(root, ".settings-flow-save"));
    const save = posted.find((m) => m.type === "saveCrewFlow") as Record<string, unknown>;
    expect((save.draft as Record<string, unknown>).roles).toEqual(["planner", "reviewer"]);
  });

  it("adds a role that is loaded but not yet in the flow", () => {
    const { root, posted, window } = mount({
      agentRoles: [roleView(), roleView({ name: "fixer", draft: { name: "fixer", provider: "claude", whenToUse: "x" } })],
      crewFlows: [flowView({ roles: ["planner"], draft: { name: "default", roles: ["planner"] } })],
    });
    openFlow(root, "default");
    const add = q(root, ".settings-agent-pool-add") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    add.value = "fixer";
    add.dispatchEvent(new window.Event("change"));
    click(q(root, ".settings-flow-save"));
    const save = posted.find((m) => m.type === "saveCrewFlow") as Record<string, unknown>;
    expect((save.draft as Record<string, unknown>).roles).toEqual(["planner", "fixer"]);
  });

  it("says an empty pool means every role, rather than none", () => {
    const { root } = mount({ crewFlows: [flowView({ roles: [], draft: { name: "default", roles: [] } })] });
    openFlow(root, "default");
    expect((q(root, ".settings-agent-pool") as unknown as { textContent: string }).textContent).toContain("every role may be assigned");
  });

  it("posts the parallel flag as edited", () => {
    const { root, posted, window } = mount();
    openFlow(root, "default");
    const box = q(root, '.settings-agent-form input[data-field="parallel"]') as unknown as {
      checked: boolean;
      dispatchEvent: (e: unknown) => void;
    };
    box.checked = true;
    box.dispatchEvent(new window.Event("change"));
    click(q(root, ".settings-flow-save"));
    const save = posted.find((m) => m.type === "saveCrewFlow") as Record<string, unknown>;
    expect((save.draft as Record<string, unknown>).parallel).toBe(true);
  });
});
