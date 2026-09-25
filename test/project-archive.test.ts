import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { normalizeRepoPath, sessionsDirFor } from "../src/sessions";

describe("project archive presentation", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-project-archive-"));
    vi.stubEnv("GROK_HOME", path.join(root, "grok"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(desktop = true, provider: "grok" | "codex" | "claude" = "grok") {
    const repo = path.join(root, "repo");
    const app = path.join(repo, "packages", "app");
    const worktree = path.join(root, "worktree");
    for (const dir of [app, worktree, path.join(repo, ".git")]) fs.mkdirSync(dir, { recursive: true });
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const stored: Record<string, any> = {
      "grok.sessionMeta": {
        conversation: { pinnedCwd: app, pinnedAt: 1, provider },
        worktree: { worktreePath: worktree, sourceGitRoot: repo },
      },
    };
    sidebar.state = {
      get: (key: string, fallback: unknown) => stored[key] ?? fallback,
      update: vi.fn(async (key: string, value: unknown) => { stored[key] = value; }),
    };
    sidebar.host = {
      canSwitchWorkspaceFolder: desktop,
      canArchiveRepos: true,
      workspaceRoot: () => repo,
      appendLine: vi.fn(),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    };
    sidebar.context = { extensionVersion: "test" };
    sidebar.appPurpose = () => "coding";
    sidebar.workspaceRoot = () => repo;
    sidebar.openWorkspaceFolders = () => [repo, app];
    sidebar.selectedRepoCwd = repo;
    sidebar.authEpoch = 7;
    sidebar.focused = new Session();
    sidebar.focused.cwd = repo;
    sidebar.pool = new Set();
    sidebar.worktreeCache = [];
    sidebar.defaultProviderForProject = () => provider;
    sidebar.connectedProviders = () => [provider];
    sidebar.postLocal = vi.fn();
    sidebar.refreshWorktreeCache = vi.fn();
    sidebar.scheduleAdapterHistoryRefresh = vi.fn();
    sidebar.annotateWorktreeLabels = vi.fn();
    sidebar.dotForId = () => "idle";
    const row = {
      id: "conversation", cwd: app, provider, displayName: "Still reachable",
      rawSummary: "Still reachable", createdAt: 1, updatedAt: 1, numMessages: 2,
    };
    sidebar.codexSessionCache = new Map(provider === "codex" ? [[normalizeRepoPath(app), [row]]] : []);
    sidebar.claudeSessionCache = new Map(provider === "claude" ? [[normalizeRepoPath(app), [row]]] : []);
    sidebar.readEntriesCachedMulti = (ids: string[]) => ids.includes(row.id) ? [{ ...row }] : [];
    if (provider === "grok") {
      const dir = path.join(sessionsDirFor(process.env.GROK_HOME!, app), row.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "summary.json"), "{}");
    }
    return { sidebar, stored, repo, app, worktree, row };
  }

  it.each(["grok", "codex", "claude"] as const)(
    "archive and unarchive keep %s projects, history and pins reachable",
    async (provider) => {
      const { sidebar, stored, app, row } = setup(true, provider);
      const trusted = sidebar.authorizedSessionCwds();
      const epoch = sidebar.authEpoch;
      await sidebar.setRepoArchived(app, true);
      expect(stored["grok.repoArchives"][normalizeRepoPath(app)].archived).toBe(true);
      expect(sidebar.authorizedSessionCwds()).toEqual(trusted);
      expect(sidebar.authEpoch).toBe(epoch);
      const image = path.join(app, "result.png");
      fs.writeFileSync(image, "image fixture");
      expect(sidebar.isImagePathAuthorizedNow(image)).toBe(true);
      expect(sidebar.localRepoCatalogEntries()).toContainEqual(expect.objectContaining({ cwd: app, archived: true }));
      expect(sidebar.buildPinnedSessions().entries).toContainEqual(expect.objectContaining({ id: row.id }));

      await sidebar.setRepoArchived(app, false);
      expect(sidebar.localRepoCatalogEntries()).toContainEqual(
        expect.objectContaining({ cwd: app, archived: false, archivedAt: expect.any(Number) }),
      );
      expect(sidebar.authorizedSessionCwds()).toEqual(trusted);
      expect(sidebar.host.appendLine.mock.calls.flat().join("\n")).not.toMatch(/dropped|failed/);
    },
  );

  it.each([false, true])("shared worktree access is independent of either owner's archive choice (desktop=%s)", async (desktop) => {
    const { sidebar, repo, app, worktree } = setup(desktop);
    const overrides = sidebar.state.get("grok.sessionMeta", {});
    expect(sidebar.sessionCwdsForRepo(repo, overrides)).toContain(worktree);
    expect(sidebar.sessionCwdsForRepo(app, overrides)).toContain(worktree);
    for (const cwd of [repo, app]) await sidebar.setRepoArchived(cwd, true);
    expect(sidebar.authorizedSessionCwds().filter((cwd: string) => cwd === worktree)).toEqual([worktree]);
  });

  it("advertises archive choices on desktop fallback rows without session catalogs", async () => {
    const { sidebar, app } = setup();
    sidebar.repoCatalog = () => [];
    expect(sidebar.localRepoCatalogEntries()).toContainEqual(expect.objectContaining({ cwd: app, archived: false, archivedAt: 0 }));
    await sidebar.setRepoArchived(app, true);
    expect(sidebar.localRepoCatalogEntries()).toContainEqual(expect.objectContaining({ cwd: app, archived: true }));
  });


  it("offers Hide independently of archive support", () => {
    const { sidebar } = setup();
    expect(sidebar.buildInitialStateMsg().capabilities.removeProjectFolder).toBe(true);
    expect(sidebar.localRepoCatalogEntries().every((r: { archived?: boolean }) => typeof r.archived === "boolean")).toBe(true);
  });
});
