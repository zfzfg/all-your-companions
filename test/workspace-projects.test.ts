import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../src/session-catalog";

const full = [
  { cwd: "C:/Repo/A", label: "A", available: true, archived: true },
  { cwd: "C:/Repo/B", label: "B", available: true },
  { cwd: "/work/App", label: "App", available: true },
  { cwd: "/work/app", label: "app", available: true },
];
function catalog(roots: string[], enabled = true) {
  return new SessionCatalog({
    getOverride: (name: string) => name === "repoCatalog" ? () => full : undefined,
    host: { canSwitchWorkspaceFolder: false, canArchiveRepos: true,
      getConfiguration: () => ({ get: () => enabled }) },
    repoOps: { extraProjectFolders: () => [], openWorkspaceFolders: () => roots },
  } as any);
}
describe("workspace project presentation", () => {
  it("isolates two windows without rewriting the shared catalog or archive choices", () => {
    expect(catalog(["c:\\repo\\a"]).localRepoCatalogEntries()).toEqual([{ ...full[0], archived: false, archivedAt: 0 }]);
    expect(catalog(["C:/Repo/B"]).localRepoCatalogEntries().map(r => r.label)).toEqual(["B"]);
    expect(full[0].archived).toBe(true);
    expect(catalog(["C:/Repo/A"]).repoCatalog()).toBe(full);
  });
  it("honors every root, POSIX case, and undiscovered open folders", () => {
    const entries = catalog(["C:/Repo/B", "/work/App", "/new"]).localRepoCatalogEntries();
    expect(entries.map(r => r.cwd)).toEqual(["C:/Repo/B", "/work/App", "/new"]);
  });
  it("keeps all projects in empty windows and when disabled", () => {
    expect(catalog([]).localRepoCatalogEntries()).toEqual(full);
    expect(catalog(["C:/Repo/A"], false).localRepoCatalogEntries()).toEqual(full);
  });
});
