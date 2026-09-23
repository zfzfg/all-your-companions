// #167 — "Agent edits unexpectedly close open editor tabs".
//
// The proposed-change diff used to open with `preview: true`, to reuse one
// tab across grok's many small sequential edits. VS Code keeps exactly ONE
// preview slot per editor group, so that diff took the slot the user's
// single-clicked file was sitting in, and the file was gone at that instant.
// Our own `closeDiffTabs` then destroyed the diff, which is correctly guarded
// and never touched a user file — we took its seat and then burned the chair.
//
// One flag, no behaviour of its own to observe, and nothing pinned it: that is
// how it survived a release, and #132's fix in 3.19.2 (which stopped the diff
// RE-OPENING itself) read as the whole answer. This test exists so the flag
// cannot go back without someone deciding to.
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";

function makeSidebar(openDiff: ReturnType<typeof vi.fn>): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.diffSeq = 0;
  sidebar.diffProvider = { set: vi.fn() };
  sidebar.openDiffsByRequest = { set: () => undefined, take: () => undefined };
  sidebar.host = { openDiff };
  return sidebar;
}

describe("the proposed-change diff never takes the editor's preview slot", () => {
  it("opens with preview:false", async () => {
    const openDiff = vi.fn(async () => {});
    const sidebar = makeSidebar(openDiff);
    await sidebar.openDiffEditor({} as never, "/workspace/src/a.ts", "before", "after", 7);
    expect(openDiff).toHaveBeenCalledTimes(1);
    expect(openDiff.mock.calls[0][3]).toMatchObject({ preview: false });
  });

  it("keeps the two options that are not the bug", async () => {
    // preserveFocus keeps the permission card clickable; selection opens the
    // whole-file diff on the edit rather than at line 1 (#66). Both are load
    // bearing and unrelated, so a later reader does not read the whole options
    // bag as suspect.
    const openDiff = vi.fn(async () => {});
    const sidebar = makeSidebar(openDiff);
    await sidebar.openDiffEditor({} as never, "/workspace/src/a.ts", "before", "after", 7);
    const options = openDiff.mock.calls[0][3] as any;
    expect(options.preserveFocus).toBe(true);
    expect(options.selection.start.line).toBe(options.selection.end.line);
  });

  it("opens a distinct pair of URIs per edit, so sequential edits cannot collide", async () => {
    // The old preview slot was also what made one tab per edit unthinkable.
    // With preview:false the keys have to stay unique or two edits to one file
    // would now overwrite each other's content in the provider.
    const openDiff = vi.fn(async () => {});
    const sidebar = makeSidebar(openDiff);
    await sidebar.openDiffEditor({} as never, "/workspace/src/a.ts", "one", "two", 1);
    await sidebar.openDiffEditor({} as never, "/workspace/src/a.ts", "two", "three", 2);
    const firstLeft = String(openDiff.mock.calls[0][0]);
    const secondLeft = String(openDiff.mock.calls[1][0]);
    expect(firstLeft).not.toBe(secondLeft);
  });
});
