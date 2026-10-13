import { expect, it, vi } from "vitest";
import { SidebarViewHost } from "../src/sidebar-view-host";
it.each([{ type: "disconnectProvider", provider: "muse" }, { type: "setProjectsWorkspaceOnly", value: true }])(
  "routes the new settings tab action $type through the host allowlist", async message => {
    const onMessage = vi.fn(async () => {});
    const host = new SidebarViewHost({ sidebarOps: { state: { host: { appendLine: vi.fn() } }, actions: { onMessage } } } as any);
    await host.onSettingsPanelMessage(message as any);
    expect(onMessage).toHaveBeenCalledWith(message);
  });
