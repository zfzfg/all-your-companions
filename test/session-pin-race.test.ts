/**
 * Pins share one read-modify-write map in globalState. Two pins started in the
 * same tick (a double click) both read the old map before either writes, so
 * without the serialised `updateSessionMeta` the second silently discards the
 * first. Moved here from the integration suite, which used to drive it through
 * a remote tab.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";

function pinHost() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.state = {
    get: (key: string, fallback: unknown) => (key in memento ? memento[key] : fallback),
    // The write awaits, which is exactly what opens the race.
    update: async (key: string, value: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      memento[key] = value;
    },
  };
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.allAdapterCatalogs = () => [];
  sidebar.isAuthorizedCwd = () => true;
  sidebar.postSessionsList = vi.fn();
  return { sidebar, meta: () => (memento["grok.sessionMeta"] ?? {}) as Record<string, any> };
}

describe("session pins", () => {
  it("two pins in the same tick both survive", async () => {
    const { sidebar, meta } = pinHost();
    await Promise.all([
      sidebar.toggleSessionPin("race-a", "/repo", true),
      sidebar.toggleSessionPin("race-b", "/repo", true),
    ]);
    expect(meta()["race-a"]).toMatchObject({ pinnedAt: expect.any(Number), pinnedCwd: "/repo" });
    expect(meta()["race-b"]).toMatchObject({ pinnedAt: expect.any(Number), pinnedCwd: "/repo" });
  });

  it("unpinning drops the override instead of leaving an empty object", async () => {
    const { sidebar, meta } = pinHost();
    await sidebar.toggleSessionPin("once", "/repo", true);
    await sidebar.toggleSessionPin("once", "/repo", false);
    expect(meta()).not.toHaveProperty("once");
    expect(sidebar.postSessionsList).toHaveBeenCalledTimes(2);
  });
});
