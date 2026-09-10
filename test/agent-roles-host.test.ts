/**
 * Host wiring for Settings → Agents & Crew.
 *
 * The page is a view; these are the writes. What matters here is that a save
 * lands in the scope the user picked, that a refusal writes NOTHING (a
 * half-written role file is a role that runs differently than it reads), and
 * that the frame the page paints from is the same set `/agent` would resolve.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. A project save writes <cwd>/.companions/agents/<name>.md; a global save
 *      writes ~/.companions/agents/<name>.md
 *   2. The written file parses back into the role that was asked for
 *   3. A refused draft writes no file and reports the reason against its card
 *   4. A rename moves the file rather than leaving the old name answering
 *   5. Deleting a materialised built-in restores the shipped role
 *   6. A project file overrides a global one of the same name, and the frame
 *      says so
 *   7. The frame offers every companion with its connected state and cached
 *      models
 *   8. With no folder open, a project save is refused rather than guessing a
 *      directory
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { loadAgentRoles, parseAgentRole } from "../src/agent-roles";

let home: string;
let project: string;

function harness(over: Record<string, unknown> = {}) {
  const posted: Record<string, unknown>[] = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.host = { appendLine: vi.fn() };
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

function frame(posted: Record<string, unknown>[]) {
  return posted[posted.length - 1] as {
    roles: { name: string; provider: string; scope: string; overrides?: string; model?: string; providerPinned: boolean }[];
    flows: { name: string; roles: string[]; scope: string; overrides?: string }[];
    providers: { id: string; connected: boolean; models: { modelId: string }[] }[];
    problems: string[];
    error?: string;
    errorId?: string;
    hasProject: boolean;
  };
}

const REVIEWER = {
  name: "reviewer",
  provider: "claude",
  model: "",
  mode: "agent",
  whenToUse: "Checking finished work against its briefing, in a fresh session.",
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "companions-home-"));
  project = mkdtempSync(join(tmpdir(), "companions-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("saving a role", () => {
  it("writes a project role into the open project", async () => {
    // Requirement 1, first half.
    const { sidebar, posted } = harness();
    await sidebar.handleSaveAgentRole({ scope: "project", draft: REVIEWER });
    const file = join(project, ".companions", "agents", "reviewer.md");
    expect(existsSync(file)).toBe(true);
    expect(frame(posted).error).toBeUndefined();
  });

  it("writes a global role into the home directory, not the project", async () => {
    // Requirement 1, second half — the point of the global set is that it
    // does NOT land in the repo.
    const { sidebar } = harness();
    await sidebar.handleSaveAgentRole({ scope: "global", draft: REVIEWER });
    expect(existsSync(join(home, ".companions", "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(project, ".companions", "agents", "reviewer.md"))).toBe(false);
  });

  it("writes a file that parses back into the role that was asked for", async () => {
    // Requirement 2. The whole editor is worthless if the file it produces
    // means something other than what the form said.
    const { sidebar } = harness();
    await sidebar.handleSaveAgentRole({
      scope: "project",
      draft: {
        ...REVIEWER,
        model: "claude-opus-5",
        mode: "plan",
        scope: ["src/**"],
        whenNotToUse: "On its own work: that review finds nothing.",
        systemPreamble: "You are reviewing, not fixing.\n\nDo not edit any file.",
        preferDifferentProvider: true,
      },
    });
    const text = readFileSync(join(project, ".companions", "agents", "reviewer.md"), "utf8");
    const { role, problem } = parseAgentRole({ path: "p", stem: "reviewer", text });
    expect(problem).toBeUndefined();
    expect(role!.provider).toBe("claude");
    expect(role!.model).toBe("claude-opus-5");
    expect(role!.mode).toBe("plan");
    expect(role!.scope).toEqual(["src/**"]);
    expect(role!.whenNotToUse).toBe("On its own work: that review finds nothing.");
    expect(role!.systemPreamble).toBe("You are reviewing, not fixing.\n\nDo not edit any file.");
    expect(role!.preferDifferentProvider).toBe(true);
  });

  it("writes nothing when the draft is refused, and says why against its card", async () => {
    // Requirement 3. A half-written role file runs differently than it reads.
    const { sidebar, posted } = harness();
    await sidebar.handleSaveAgentRole({ scope: "project", draft: { ...REVIEWER, whenToUse: "" } });
    expect(existsSync(join(project, ".companions", "agents", "reviewer.md"))).toBe(false);
    const answer = frame(posted);
    expect(answer.error).toContain("when to use");
    expect(answer.errorId).toBe("reviewer");
  });

  it("leaves no trace when the draft is refused", async () => {
    // A `.companions/agents/` directory appearing in a repo after a validation
    // error is a change the user did not ask for — and in a git project it
    // shows up as an untracked directory they then have to explain.
    const { sidebar } = harness();
    await sidebar.handleSaveAgentRole({ scope: "project", draft: { ...REVIEWER, name: "" } });
    expect(existsSync(join(project, ".companions"))).toBe(false);
  });

  it("refuses a model the companion does not carry", async () => {
    const { sidebar, posted } = harness({
      state: {
        get: (key: string, fallback: unknown) =>
          key === "grok.providerModelCache" ? { claude: { models: [{ modelId: "claude-opus-5" }] } } : fallback,
        update: vi.fn(async () => {}),
      },
    });
    await sidebar.handleSaveAgentRole({ scope: "project", draft: { ...REVIEWER, model: "gpt-9" } });
    expect(existsSync(join(project, ".companions", "agents", "reviewer.md"))).toBe(false);
    expect(frame(posted).error).toContain("gpt-9");
  });

  it("moves the file on a rename rather than leaving the old name answering", async () => {
    // Requirement 4.
    const { sidebar } = harness();
    await sidebar.handleSaveAgentRole({ scope: "project", draft: REVIEWER });
    await sidebar.handleSaveAgentRole({
      scope: "project",
      originalName: "reviewer",
      draft: { ...REVIEWER, name: "auditor" },
    });
    const dir = join(project, ".companions", "agents");
    expect(existsSync(join(dir, "auditor.md"))).toBe(true);
    expect(existsSync(join(dir, "reviewer.md"))).toBe(false);
  });

  it("removes the old file when a role moves between scopes", async () => {
    // The trap this closes: writing the global copy while the project file
    // stays put leaves the PROJECT file winning, so the user's edit appears to
    // have been discarded even though the save succeeded.
    const { sidebar, posted } = harness();
    await sidebar.handleSaveAgentRole({ scope: "project", draft: REVIEWER });
    await sidebar.handleSaveAgentRole({
      scope: "global",
      originalName: "reviewer",
      originalScope: "project",
      draft: { ...REVIEWER, whenToUse: "Moved to every project." },
    });
    expect(existsSync(join(home, ".companions", "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(project, ".companions", "agents", "reviewer.md"))).toBe(false);
    const reviewer = frame(posted).roles.find((role) => role.name === "reviewer")!;
    expect(reviewer.scope).toBe("global");
  });

  it("keeps the file when the scope did not change", async () => {
    const { sidebar } = harness();
    await sidebar.handleSaveAgentRole({ scope: "project", draft: REVIEWER });
    await sidebar.handleSaveAgentRole({
      scope: "project",
      originalName: "reviewer",
      originalScope: "project",
      draft: { ...REVIEWER, whenToUse: "Edited in place." },
    });
    expect(existsSync(join(project, ".companions", "agents", "reviewer.md"))).toBe(true);
  });

  it("refuses a project save with no folder open instead of guessing a directory", async () => {
    // Requirement 8.
    const { sidebar, posted } = harness({ sessionCwd: () => "" });
    await sidebar.handleSaveAgentRole({ scope: "project", draft: REVIEWER });
    expect(frame(posted).error).toContain("Open a project folder");
    expect(frame(posted).hasProject).toBe(false);
  });

  it("still allows a global save with no folder open", async () => {
    const { sidebar } = harness({ sessionCwd: () => "" });
    await sidebar.handleSaveAgentRole({ scope: "global", draft: REVIEWER });
    expect(existsSync(join(home, ".companions", "agents", "reviewer.md"))).toBe(true);
  });
});

describe("deleting", () => {
  it("restores the shipped role when a materialised built-in is removed", async () => {
    // Requirement 5 — "Reset to built-in".
    const { sidebar, posted } = harness();
    await sidebar.handleSaveAgentRole({
      scope: "project",
      draft: { ...REVIEWER, provider: "gemini", whenToUse: "My own reviewer." },
    });
    expect(frame(posted).roles.find((role) => role.name === "reviewer")!.provider).toBe("gemini");

    sidebar.handleDeleteCompanionFile("project", "agents", "reviewer");
    const after = frame(posted).roles.find((role) => role.name === "reviewer")!;
    expect(after.scope).toBe("builtin");
    expect(existsSync(join(project, ".companions", "agents", "reviewer.md"))).toBe(false);
  });

  it("treats an already-missing file as done rather than an error", async () => {
    const { sidebar, posted } = harness();
    sidebar.handleDeleteCompanionFile("project", "agents", "never-existed");
    expect(frame(posted).error).toBeUndefined();
  });

  it("refuses a name that is not a role name", async () => {
    const { sidebar, posted } = harness();
    sidebar.handleDeleteCompanionFile("project", "agents", "../../etc/passwd");
    expect(frame(posted).error).toContain("not a name");
  });
});

describe("the frame the page paints from", () => {
  it("lets a project role override a global one and says so", () => {
    // Requirement 6.
    mkdirSync(join(home, ".companions", "agents"), { recursive: true });
    mkdirSync(join(project, ".companions", "agents"), { recursive: true });
    writeFileSync(join(home, ".companions", "agents", "auditor.md"), "---\nprovider: gemini\n---\n\nGlobal audit.\n");
    writeFileSync(join(project, ".companions", "agents", "auditor.md"), "---\nprovider: claude\n---\n\nProject audit.\n");

    const { sidebar, posted } = harness();
    sidebar.postAgentRoles();
    const auditors = frame(posted).roles.filter((role) => role.name === "auditor");
    expect(auditors).toHaveLength(1);
    expect(auditors[0].provider).toBe("claude");
    expect(auditors[0].scope).toBe("project");
    expect(auditors[0].overrides).toBe("global");
  });

  it("offers every companion with its connected state and cached models", () => {
    // Requirement 7. Disconnected companions are SHOWN, not filtered: a role
    // pinned to one you have not signed into yet is a reasonable thing to
    // write down.
    const { sidebar, posted } = harness({
      state: {
        get: (key: string, fallback: unknown) =>
          key === "grok.providerModelCache" ? { claude: { models: [{ modelId: "claude-opus-5", name: "Opus 5" }] } } : fallback,
        update: vi.fn(async () => {}),
      },
    });
    sidebar.postAgentRoles();
    const providers = frame(posted).providers;
    expect(providers.map((p) => p.id)).toEqual(["grok", "codex", "claude", "gemini"]);
    expect(providers.find((p) => p.id === "claude")!.connected).toBe(true);
    expect(providers.find((p) => p.id === "grok")!.connected).toBe(false);
    expect(providers.find((p) => p.id === "claude")!.models).toEqual([{ modelId: "claude-opus-5", name: "Opus 5" }]);
    // Cold cache: an empty list, which the page renders as free text rather
    // than an empty dropdown.
    expect(providers.find((p) => p.id === "gemini")!.models).toEqual([]);
  });

  it("shows what a built-in would ACTUALLY run on, not its placeholder", () => {
    // The built-ins carry `provider: claude` as a placeholder the host
    // rewrites at run time. Painting that would tell the user a role runs on a
    // companion that is not connected — the exact lie this feature removes.
    const { sidebar, posted } = harness({
      usableProviders: () => ["gemini"],
      focused: { provider: "gemini" },
    });
    sidebar.postAgentRoles();
    const planner = frame(posted).roles.find((role) => role.name === "planner")!;
    expect(planner.scope).toBe("builtin");
    expect(planner.provider).toBe("gemini");
    expect(planner.providerPinned).toBe(false);
    // And the draft agrees, so opening it and pressing Save pins what the row
    // promised rather than the placeholder.
    expect((planner as unknown as { draft: { provider: string } }).draft.provider).toBe("gemini");
  });

  it("steers the shipped reviewer away from the calling companion", () => {
    const { sidebar, posted } = harness({
      usableProviders: () => ["claude", "gemini"],
      focused: { provider: "claude" },
    });
    sidebar.postAgentRoles();
    expect(frame(posted).roles.find((role) => role.name === "reviewer")!.provider).toBe("gemini");
  });

  it("marks a role read from a file as pinned", () => {
    mkdirSync(join(project, ".companions", "agents"), { recursive: true });
    writeFileSync(
      join(project, ".companions", "agents", "auditor.md"),
      ["---", "provider: codex", "---", "", "Audit.", ""].join("\n"),
    );
    const { sidebar, posted } = harness({ usableProviders: () => ["gemini"], focused: { provider: "gemini" } });
    sidebar.postAgentRoles();
    const auditor = frame(posted).roles.find((role) => role.name === "auditor")!;
    // Never swapped: a provider the user wrote down is a decision, not a hint.
    expect(auditor.provider).toBe("codex");
    expect(auditor.providerPinned).toBe(true);
  });

  it("reports a role file that will not parse", () => {
    mkdirSync(join(project, ".companions", "agents"), { recursive: true });
    writeFileSync(join(project, ".companions", "agents", "broken.md"), "no frontmatter here\n");
    const { sidebar, posted } = harness();
    sidebar.postAgentRoles();
    expect(frame(posted).problems.join(" ")).toContain("broken.md");
  });

  it("paints the same role set /agent would resolve", () => {
    // The page and the command must not be able to disagree about which role
    // is in force — that is the whole failure the old hardcoded list had.
    mkdirSync(join(project, ".companions", "agents"), { recursive: true });
    writeFileSync(join(project, ".companions", "agents", "auditor.md"), "---\nprovider: claude\n---\n\nAudit.\n");
    const { sidebar, posted } = harness();
    sidebar.postAgentRoles();
    const fromFrame = frame(posted).roles.map((role) => role.name).sort();
    const fromCommand = sidebar.agentRoleSet(project).roles.map((role: { name: string }) => role.name).sort();
    expect(fromFrame).toEqual(fromCommand);
    expect(fromFrame).toContain("auditor");
  });

  it("still resolves the built-ins when neither directory exists", () => {
    const { sidebar, posted } = harness();
    sidebar.postAgentRoles();
    expect(frame(posted).roles.map((role) => role.name)).toEqual(
      loadAgentRoles([]).roles.map((role) => role.name),
    );
    expect(frame(posted).problems).toEqual([]);
  });
});

describe("saving a crew flow", () => {
  it("writes a flow whose roles all exist", async () => {
    const { sidebar, posted } = harness();
    await sidebar.handleSaveCrewFlow({
      scope: "project",
      draft: { name: "audit", roles: ["planner", "reviewer"], verify: "npm test", reviewEvery: 2 },
    });
    expect(existsSync(join(project, ".companions", "crews", "audit.md"))).toBe(true);
    const flow = frame(posted).flows.find((entry) => entry.name === "audit")!;
    expect(flow.roles).toEqual(["planner", "reviewer"]);
  });

  it("refuses a flow naming a role that does not exist, and writes nothing", async () => {
    const { sidebar, posted } = harness();
    await sidebar.handleSaveCrewFlow({ scope: "project", draft: { name: "audit", roles: ["ghost"] } });
    expect(existsSync(join(project, ".companions", "crews", "audit.md"))).toBe(false);
    expect(frame(posted).error).toContain("ghost");
  });
});
