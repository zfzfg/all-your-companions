import { expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
vi.mock("../src/codex-model-cache", () => ({ warmCodexModelCache: vi.fn(async () => { throw new Error("Internal error"); }) }));
vi.mock("../src/claude-model-cache", () => ({ warmClaudeModelCache: vi.fn(async () => { throw new Error("Internal error"); }) }));
vi.mock("../src/gemini-model-cache", () => ({ warmGeminiModelCache: vi.fn(async () => { throw new Error("Internal error"); }) }));

it.each(["codex", "claude", "gemini"])("does not promote an unverified %s account on an ordinary refresh error", async provider => {
 const sidebar = Object.create(GrokSidebar.prototype) as any;
 sidebar.providerConnectionState = { [provider]: true };
 sidebar.providerNeedsLogin = { [provider]: true };
 sidebar.locateProvider = vi.fn(() => "/fake/cli");
 sidebar.workspaceRoot = vi.fn(() => "/repo");
 sidebar.host = { appendLine: vi.fn(), workspaceRoot: () => "/repo" };
 sidebar.cacheProviderModels = vi.fn(); sidebar.postProviderState = vi.fn();
 const warm = { codex: "warmConnectedCodexModels", claude: "warmConnectedClaudeModels", gemini: "warmConnectedGeminiModels" }[provider]!;
 expect(await sidebar[warm]()).toBe(false);
 expect(sidebar.providerNeedsLogin[provider]).toBe(true);
 expect(sidebar.cacheProviderModels).not.toHaveBeenCalled();
});
