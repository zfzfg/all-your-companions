import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session, sessionUiSnapshot } from "../src/session";
import { SubagentHost, type SubagentHostDeps } from "../src/subagent-host";
import { bootWebview, dispatch } from "./webview-harness";

describe("activity across transcript switches", () => {
  function harness() {
    const ancestor = new Session();
    const child = new Session();
    const host = new SubagentHost({ emit: vi.fn() } as unknown as SubagentHostDeps);
    host.activityOwnerOf = () => ({ kind: "subagent", id: "sa_1" });
    host.visibleAncestorOf = () => ancestor;
    return { host, ancestor, child };
  }

  it("restores the accumulated current feed after a parent/child switch, without repeating text", () => {
    const { host, ancestor, child } = harness();
    child.childActivityQueue = [{ kind: "prose", text: "Inspecting " }, { kind: "prose", text: "adapters" }];
    host.flushChildActivity(child);
    child.childActivityQueue = [{ kind: "tool", id: "read", title: "Read adapters.ts", status: "pending" }];
    host.flushChildActivity(child);
    child.childActivityQueue = [{ kind: "tool", id: "read", title: "", status: "completed" }];
    host.flushChildActivity(child);
    expect(ancestor.buffer).toEqual([]);
    const snapshots = sessionUiSnapshot(ancestor, "agent").filter((m) => m.type === "childActivity");
    expect(snapshots).toEqual([{
      type: "childActivity", replace: true, owner: { kind: "subagent", id: "sa_1" },
      items: [{ kind: "prose", text: "Inspecting adapters" }, { kind: "tool", id: "read", title: "Read adapters.ts", status: "completed" }],
      lastLine: "Read adapters.ts",
    }]);
    expect(sessionUiSnapshot(child, "agent").some((m) => m.type === "childActivity")).toBe(false);

    const { window, doc } = bootWebview();
    for (let i = 0; i < 2; i++) {
      dispatch(window, { type: "clearMessages" });
      dispatch(window, { type: "historyReplay", active: true });
      dispatch(window, { type: "userMessage", text: "Inspect", chips: [] });
      dispatch(window, { type: "companionSubagent", subagentId: "sa_1", status: "running", provider: "gemini" });
      dispatch(window, { type: "historyReplay", active: false });
      for (const snapshot of snapshots) dispatch(window, snapshot);
      expect(doc.querySelectorAll(".child-activity-line")).toHaveLength(2);
      expect(doc.querySelector(".child-activity-lines")!.textContent).toBe("Inspecting adapters✓ Read adapters.ts");
    }
  });

  it("bounds snapshots per child and per ancestor", () => {
    const { host, ancestor, child } = harness();
    for (let i = 0; i < 55; i++) {
      host.activityOwnerOf = () => ({ kind: "subagent", id: `sa_${i}` });
      child.childActivityQueue = Array.from({ length: 100 }, (_, j) => ({ kind: "tool" as const, id: String(j), title: `Read ${j}` }));
      host.flushChildActivity(child);
    }
    expect(ancestor.childActivitySnapshots.size).toBe(50);
    expect(ancestor.childActivitySnapshots.has("sa_0")).toBe(false);
    expect(ancestor.childActivitySnapshots.get("sa_54")!.items).toHaveLength(40);
  });

  it("clears old activity when the host clears a session transcript", () => {
    const { ancestor, host, child } = harness();
    child.childActivityQueue = [{ kind: "prose", text: "Old task" }];
    host.flushChildActivity(child);
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.relayFromChild = vi.fn();
    sidebar.tapChildActivity = vi.fn();
    sidebar.focused = new Session();
    sidebar.emit(ancestor, { type: "clearMessages" });
    expect(ancestor.childActivitySnapshots.size).toBe(0);
  });
});
