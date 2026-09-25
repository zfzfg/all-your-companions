import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

const adapterPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-codex-acp.cjs",
);
const validSessionId = "0198f0d1-2b3c-7d4e-8f50-123456789abc";
const validToolCallId = "exec-550e8400-e29b-41d4-a716-446655440000";

function makeSidebar(cwd: string, readFile: any): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.providerConnectionState = { grok: false, codex: true };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.connectedProviders = vi.fn(() => ["codex"]);
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "codex";
  sidebar.focused.cwd = cwd;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.loginReprobeTimers = new Map();
  sidebar.turnOrderTimers = new Set();
  sidebar.pendingConfirms = new Map();
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    append: vi.fn(),
    appendLine: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: vi.fn(async () => {}),
    })),
    fs: {
      readFile,
      writeFile: vi.fn(async () => {}),
      createDirectory: vi.fn(async () => {}),
    },
  };
  sidebar.context = { globalStorageUri: { fsPath: cwd }, subscriptions: [] };
  sidebar.terminalManager = { create: vi.fn(), disposeAll: vi.fn(), ownedBy: vi.fn(() => ({ create: vi.fn() })), releaseOwnedBy: vi.fn(() => 0) };
  sidebar.workspaceRoot = vi.fn(() => cwd);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.locateProvider = vi.fn(() => "codex");
  sidebar.providerDefaultForProject = vi.fn(() => "");
  sidebar.configForcesAutoApprove = vi.fn(() => false);
  sidebar.stopVoiceInput = vi.fn();
  sidebar.queueInFlightPlanCommentsOnExit = vi.fn();
  sidebar.warnOAuthShadowOnce = vi.fn();
  sidebar.cacheProviderModels = vi.fn(async () => {});
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.postSessionName = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.touch = vi.fn();
  sidebar.reapPool = vi.fn();
  sidebar.maybeFlushQueuedSends = vi.fn(async () => {});
  sidebar.accumulateUsage = vi.fn(async () => {});
  sidebar.mirrorToProjectsRail = vi.fn();
  return sidebar;
}

describe("Codex generated-image adapter ids are hostile", () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    adapter: process.env.GROK_TEST_CODEX_ACP_ADAPTER_PATH,
    codexHome: process.env.CODEX_HOME,
    sessionId: process.env.FAKE_CODEX_SESSION_ID,
    toolCallId: process.env.FAKE_CODEX_IMAGE_TOOL_CALL_ID,
    skipArtifact: process.env.FAKE_CODEX_SKIP_IMAGE_ARTIFACT,
  };
  let cwd: string;
  let codexHome: string;
  let live: any[];

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-path-ws-"));
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-path-home-"));
    process.env.NODE_ENV = "test";
    process.env.GROK_TEST_CODEX_ACP_ADAPTER_PATH = adapterPath;
    process.env.CODEX_HOME = codexHome;
    process.env.FAKE_CODEX_SKIP_IMAGE_ARTIFACT = "1";
    live = [];
  });

  afterEach(async () => {
    await Promise.all(live.filter(Boolean).map((client) => client.dispose()));
    for (const [key, value] of Object.entries({
      NODE_ENV: saved.nodeEnv,
      GROK_TEST_CODEX_ACP_ADAPTER_PATH: saved.adapter,
      CODEX_HOME: saved.codexHome,
      FAKE_CODEX_SESSION_ID: saved.sessionId,
      FAKE_CODEX_IMAGE_TOOL_CALL_ID: saved.toolCallId,
      FAKE_CODEX_SKIP_IMAGE_ARTIFACT: saved.skipArtifact,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  async function driveImageUpdate(options: {
    sessionId: string;
    toolCallId: string;
    refuseResolvedPath?: boolean;
  }) {
    process.env.FAKE_CODEX_SESSION_ID = options.sessionId;
    process.env.FAKE_CODEX_IMAGE_TOOL_CALL_ID = options.toolCallId;
    const readFile = vi.fn(async (..._args: any[]) => Buffer.from("secret bytes"));
    const sidebar = makeSidebar(cwd, readFile);
    if (options.refuseResolvedPath) sidebar.isServableFromDisk = vi.fn(() => false);
    const frames: HostMsg[] = [];
    sidebar.postTap = (message: HostMsg) => { frames.push(message); };

    const client = await sidebar.startSession(undefined, sidebar.focused);
    live.push(client);
    expect(client).toBeDefined();
    readFile.mockClear();
    frames.length = 0;

    await client.prompt("SCENARIO_IMAGE_GENERATION");
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      readFile,
      mediaFrames: frames.filter((message) => message.type === "media"),
      log: sidebar.host.appendLine,
    };
  }

  it("refuses traversal session ids before reading or emitting media", async () => {
    const result = await driveImageUpdate({ sessionId: "..\\..", toolCallId: validToolCallId });
    expect(result.readFile).not.toHaveBeenCalled();
    expect(result.mediaFrames).toEqual([]);
    expect(result.log).toHaveBeenCalledWith(expect.stringContaining("refused Codex generated-image"));
  });

  it("refuses separator-bearing tool-call ids before reading or emitting media", async () => {
    const result = await driveImageUpdate({ sessionId: validSessionId, toolCallId: `${validToolCallId}/escape` });
    expect(result.readFile).not.toHaveBeenCalled();
    expect(result.mediaFrames).toEqual([]);
    expect(result.log).toHaveBeenCalledWith(expect.stringContaining("refused Codex generated-image"));
  });

  it("refuses an out-of-root resolved artifact instead of taking the data-URI fallback", async () => {
    const result = await driveImageUpdate({
      sessionId: validSessionId,
      toolCallId: validToolCallId,
      refuseResolvedPath: true,
    });
    expect(result.readFile).not.toHaveBeenCalled();
    expect(result.mediaFrames).toEqual([]);
    expect(result.log).toHaveBeenCalledWith(expect.stringContaining("outside its trusted root"));
  });
});
