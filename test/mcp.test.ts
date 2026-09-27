import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { collectMcpNameFiles, collectMcpNameLayers, hostMcpServers, mcpConfigLayer } from "../src/mcp-connectors";
import {
  MCP_GLOBAL_SCOPE_WARNING,
  filterMcpSettingsServers,
  mcpConfigFileName,
  mcpIsManaged,
  mcpSettingsServersForCwd,
  mcpSettingsVisible,
  mcpServerDetail,
  mergeMcpNotification,
  parseMcpListResponse,
} from "../src/mcp";

describe("MCP ACP catalog", () => {
  it("parses the wrapped response, sorts display names, and keeps tool metadata", () => {
    const tools = [{ name: "search", description: "Find designs", inputSchema: { type: "object" } }];
    expect(parseMcpListResponse({
      servers: [
        { name: "managed_gateway:canva", displayName: "Canva", source: "managed", type: "managedGateway", session: { enabled: true, status: "ready", tools } },
        { name: "linear", enabled: false, status: "initializing", tools: [{ name: "issues" }] },
      ],
    })).toEqual([
      { name: "managed_gateway:canva", displayName: "Canva", enabled: true, source: "managed", type: "managedGateway", managed: true, status: "ready", tools, toolCount: 1 },
      { name: "linear", enabled: false, status: "initializing", tools: [{ name: "issues" }], toolCount: 1 },
    ]);
  });

  it("accepts a bare array and prefers session state over top-level state", () => {
    expect(parseMcpListResponse(JSON.stringify([
      { name: "zeta", enabled: false, status: "down", session: { enabled: true, status: "ready" } },
      { enabled: true },
    ]))).toEqual([{ name: "zeta", enabled: true, status: "ready" }]);
  });

  it("unwraps the extra result envelope emitted by Grok over ACP", () => {
    expect(parseMcpListResponse({ result: { servers: [{ name: "canva", source: "local" }] } })).toEqual([
      { name: "canva", enabled: true, source: "local" },
    ]);
  });

  it("keeps scopeName from the CLI inventory", () => {
    expect(parseMcpListResponse({
      servers: [{
        name: "managed_gateway:linear",
        displayName: "Linear",
        source: "managed",
        scope: "user",
        scopeName: "Grok CLI",
      }],
    })).toEqual([{
      name: "managed_gateway:linear",
      displayName: "Linear",
      enabled: true,
      source: "managed",
      managed: true,
      scope: "user",
      scopeName: "Grok CLI",
    }]);
  });

  it("rejects a response without a server list", () => {
    expect(() => parseMcpListResponse({})).toThrow("Unexpected response from _x.ai/mcp/list");
  });

  it("merges pushed server health without polling", () => {
    const current = [{ name: "linear", enabled: true, status: "initializing" }];
    expect(mergeMcpNotification(current, "_x.ai/mcp/server_status", {
      name: "linear", status: "unavailable", reason: "handshake_failed", detail: "OAuth required",
    })).toEqual([{ name: "linear", enabled: true, status: "unavailable", error: "OAuth required" }]);
  });

  it("labels a compact server detail", () => {
    expect(mcpServerDetail({
      name: "docs", enabled: true, status: "ready", toolCount: 2, command: "npx", args: ["docs-mcp"],
    })).toBe("ready · 2 tools · npx docs-mcp");
  });

  it("keeps the launch recipe and drops credentials and unknown fields", () => {
    expect(parseMcpListResponse({
      servers: [{
        name: "linear",
        command: "npx",
        args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        env: { LINEAR_API_KEY: "secret" },
        headers: { Authorization: "Bearer secret" },
        token: "secret",
        apiKey: "secret",
        tools: [{ name: "issues", token: "secret", headers: { Authorization: "x" } }],
      }],
    })).toEqual([{
      name: "linear",
      enabled: true,
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      tools: [{ name: "issues" }],
      toolCount: 1,
    }]);
  });

  it("scopes the read-only warning to the inventory, not the host-owned catalog", () => {
    expect(MCP_GLOBAL_SCOPE_WARNING).toMatch(/this list is read-only/i);
    expect(MCP_GLOBAL_SCOPE_WARNING).toMatch(/machine-global/i);
  });
});

const LEAK_BEARER = "Authorization: Bearer sk_live_repro_token";
const LEAK_TOKEN = "sk_live_repro_token";
const LEAK_PATH = "C:/Users/Alice/AppData/Roaming/npm/npx.cmd";
const LEAK_URL = `https://mcp.linear.app/mcp?api_key=${LEAK_TOKEN}`;

/** Reviewer reproduction: bearer header, tokenized URL, and an absolute user path. */
function leakyMcpWireServer() {
  return {
    name: "linear",
    displayName: "Linear",
    enabled: true,
    source: "local",
    type: "stdio",
    scope: "global",
    status: "unavailable",
    command: LEAK_PATH,
    args: ["-y", "mcp-remote", LEAK_URL, "--header", LEAK_BEARER],
    url: LEAK_URL,
    env: { LINEAR_API_KEY: LEAK_TOKEN },
    headers: { Authorization: LEAK_BEARER },
    error: `spawn EACCES ${LEAK_PATH} --header ${LEAK_BEARER}`,
    tools: [{
      name: "list_issues",
      description: "List issues",
      inputSchema: {
        type: "object",
        properties: {
          token: { default: LEAK_TOKEN },
          path: { default: "C:/Users/Alice/secrets" },
        },
      },
    }],
  };
}

describe("MCP inventory catalog", () => {
  it("the desk catalog still keeps the launch recipe from the reproduction payload", () => {
    const [desk] = parseMcpListResponse({ servers: [leakyMcpWireServer()] });
    expect(desk.command).toBe(LEAK_PATH);
    expect(desk.args).toEqual(["-y", "mcp-remote", LEAK_URL, "--header", LEAK_BEARER]);
    expect(desk.url).toBe(LEAK_URL);
    expect(desk.error).toContain(LEAK_BEARER);
    expect(desk.error).toContain(LEAK_PATH);
    expect(desk.tools?.[0]?.inputSchema).toEqual(leakyMcpWireServer().tools[0].inputSchema);
    expect(JSON.stringify(desk)).toContain(LEAK_BEARER);
    expect(JSON.stringify(desk)).toContain("C:/Users/Alice");
  });

  it("clears a stale error when a later status reports no failure", () => {
    // Nothing ever cleared `error`, so a server that failed once carried the
    // text for the life of the session. The renderer short-circuits on it, so
    // a recovered server stayed red. The error belongs to the event that
    // reported it.
    const failed = mergeMcpNotification(
      [{ name: "linear", enabled: true }],
      "_x.ai/mcp/init_progress",
      { name: "linear", status: "unavailable", detail: "connection refused" },
    );
    expect(failed[0].error).toBe("connection refused");

    const recovered = mergeMcpNotification(
      failed,
      "_x.ai/mcp/init_progress",
      { name: "linear", status: "ready" },
    );
    expect(recovered[0].status).toBe("ready");
    expect(recovered[0].error).toBeUndefined();
  });

  it("keeps a fresh failure, and does not let a status-only note erase it", () => {
    const failed = mergeMcpNotification(
      [{ name: "linear", enabled: true }],
      "_x.ai/mcp/init_progress",
      { name: "linear", status: "unavailable", detail: "connection refused" },
    );
    // A notification carrying neither status nor error changes neither.
    const noise = mergeMcpNotification(failed, "_x.ai/mcp/init_progress", { name: "linear" });
    expect(noise[0].error).toBe("connection refused");
  });

  it("classifies Grok inventory against Grok config files even if Codex or Claude is focused", () => {
    const src = readFileSync(new URL("../src/voice-and-mcp.ts", import.meta.url), "utf8");
    const start = src.indexOf("public mcpNameCatalogFor(");
    const end = src.indexOf("public filterMcpServers(", start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('provider: "grok"');
    expect(body).not.toContain("session.provider");
    // Host-inject reserved identity stays provider-specific; only the Grok
    // inventory tagger is pinned to grok.
    const reserved = src.slice(
      src.indexOf("public reservedMcpIdentityFor("),
      src.indexOf("public async hostMcpServersFor("),
    );
    expect(reserved).toContain("provider: session.provider");
  });

  it("stamps the catalog cwd at read time and stores the classified view", () => {
    const src = readFileSync(new URL("../src/voice-and-mcp.ts", import.meta.url), "utf8");
    const refresh = src.slice(
      src.indexOf("public async refreshMcpServers("),
      src.indexOf("public isServableFromDisk("),
    );
    expect(refresh).toContain("this.mcpServersCwd = this.deps.voiceOps.sessionCwd(grok)");
    expect(refresh).toContain("this.grokSessionForMcpList(session)");
    expect(refresh).toContain("this.mcpServersView = this.filterMcpServers(this.mcpServers)");
    expect(refresh).not.toContain('session.provider === "grok" ? session.client');
    const helper = src.slice(
      src.indexOf("public async grokSessionForMcpList("),
      src.indexOf("public async refreshMcpServers("),
    );
    expect(helper).toContain('startSession(undefined, grok, "ensure")');
    expect(helper).toContain("grokSessionForMcpListInFlight");
    expect(helper).not.toContain("disposeSession");
    expect(helper).not.toContain("removeSessionFromDisk");
    const tag = src.slice(
      src.indexOf("public filterMcpServers("),
      src.indexOf("public reservedMcpIdentityFor("),
    );
    expect(tag).toContain("mcpSettingsServersForCwd");
    expect(tag).toContain("catalogCwd: this.mcpServersCwd");
    expect(tag).not.toContain("viewCwd");
    expect(tag).not.toContain("sameCwd");
    expect(tag).not.toContain("mcpNameCatalogFor(session)");
    const sessionStartSrc = readFileSync(new URL("../src/session-start.ts", import.meta.url), "utf8");
    const notify = sessionStartSrc.slice(
      sessionStartSrc.indexOf('client.on("mcpNotification"'),
      sessionStartSrc.indexOf('client.on("xaiNotification"'),
    );
    expect(notify).toContain("this.deps.sessionLifecycleOps.applyMcpNotification(session, method, params)");
    expect(notify).not.toContain("mcpServersCwd");
    const apply = src.slice(
      src.indexOf("public applyMcpNotification("),
      src.indexOf("public postMcpServers("),
    );
    const reservedAt = apply.indexOf("reservedFromMcpInventory");
    const cwdGuardAt = apply.indexOf("this.mcpServersCwd");
    expect(reservedAt).toBeGreaterThan(-1);
    expect(cwdGuardAt).toBeGreaterThan(reservedAt);
  });
});

describe("MCP settings sections", () => {
  it("treats source=managed and managed=true as grok.com, everything else as local", () => {
    expect(mcpIsManaged({ source: "managed", scopeName: "Grok CLI" } as { source: string })).toBe(true);
    expect(mcpIsManaged({ managed: true })).toBe(true);
    expect(mcpIsManaged({ source: "local" })).toBe(false);
    expect(mcpIsManaged({})).toBe(false);
  });

  it("keeps grok.com and user-level rows, drops project-file servers, and stamps configFile", () => {
    expect(mcpSettingsVisible({ source: "managed" })).toBe(true);
    expect(mcpSettingsVisible({ managed: true })).toBe(true);
    expect(mcpSettingsVisible({ source: "local", localLayer: "user" })).toBe(true);
    expect(mcpSettingsVisible({ source: "local" })).toBe(false);
    expect(mcpSettingsVisible({ source: "local", localLayer: "project" })).toBe(false);
    expect(mcpSettingsVisible({ source: "managed", localLayer: "project" })).toBe(true);

    const layers = new Map<string, "project" | "user">([
      ["docs", "project"],
      ["notes", "user"],
      ["linear", "user"],
    ]);
    const files = collectMcpNameFiles([
      { layer: "user", path: "/home/.grok/config.toml", names: ["notes"] },
      { layer: "user", path: "/home/.cursor/mcp.json", names: ["linear"] },
      { layer: "project", path: "/proj/.mcp.json", names: ["docs"] },
    ]);
    const filtered = filterMcpSettingsServers([
      { name: "managed_gateway:canva", displayName: "Canva", enabled: true, source: "managed", managed: true, scopeName: "Grok CLI" },
      { name: "docs", enabled: true, source: "local", command: "npx" },
      { name: "notes", enabled: true, source: "local" },
      { name: "linear", enabled: true, source: "local", command: "npx" },
    ], { nameLayer: layers, nameFile: files });
    expect(filtered.map((s) => s.name)).toEqual([
      "managed_gateway:canva",
      "notes",
      "linear",
    ]);
    expect(filtered.every((s) => !("tag" in s))).toBe(true);
    expect(filtered.find((s) => s.name === "managed_gateway:canva")?.scopeName).toBe("Grok CLI");
    expect(filtered.find((s) => s.name === "managed_gateway:canva")?.configFile).toBeUndefined();
    expect(filtered.find((s) => s.name === "notes")?.configFile).toBe("config.toml");
    expect(filtered.find((s) => s.name === "linear")?.configFile).toBe("mcp.json");
    expect(filtered.find((s) => s.name === "docs")).toBeUndefined();
    expect(filtered.find((s) => s.name === "notes")?.command).toBeUndefined();
    expect(filtered.find((s) => s.name === "linear")?.command).toBe("npx");
    expect(mcpConfigFileName("C:\\Users\\Dell\\.grok\\config.toml")).toBe("config.toml");
  });

  it("keeps a Grok compatibility server declared only in ~/.claude.json", () => {
    const grok = { cwd: "/proj", provider: "grok" as const };
    expect(mcpConfigLayer("/home/.claude.json", grok)).toBe("user");
    const files = [{ layer: "user" as const, path: "/home/.claude.json", names: ["notes"] }];
    const filtered = filterMcpSettingsServers(
      [{ name: "notes", enabled: true, source: "local" }],
      { nameLayer: collectMcpNameLayers(files), nameFile: collectMcpNameFiles(files) },
    );
    expect(filtered.map((s) => s.name)).toEqual(["notes"]);
    expect(filtered[0]?.configFile).toBe(".claude.json");
  });

  it("omits a host-injected echo whose name is in no config layer, keeps a config-declared local", () => {
    const layers = new Map<string, "project" | "user">([["linear", "user"]]);
    const files = collectMcpNameFiles([
      { layer: "user", path: "/home/.grok/config.toml", names: ["linear"] },
    ]);
    const filtered = filterMcpSettingsServers([
      { name: "linear", enabled: true, source: "local" },
      { name: "notion", enabled: true, source: "local" },
      { name: "atlassian", enabled: true, source: "local" },
      { name: "managed_gateway:canva", displayName: "Canva", enabled: true, source: "managed", managed: true },
    ], { nameLayer: layers, nameFile: files });
    expect(filtered.map((s) => s.name)).toEqual(["linear", "managed_gateway:canva"]);
    expect(filtered.find((s) => s.name === "linear")?.configFile).toBe("config.toml");
    expect(filtered.find((s) => s.name === "notion")).toBeUndefined();
    expect(filtered.find((s) => s.name === "atlassian")).toBeUndefined();
  });
});

describe("MCP catalog classified against the workspace it was read from", () => {
  const catalogA = [
    { name: "shared", enabled: true, source: "local" },
    { name: "a-only", enabled: true, source: "local" },
  ];
  const layersA = collectMcpNameLayers([
    { layer: "user", names: ["shared"] },
    { layer: "project", names: ["a-only"] },
  ]);
  const layersB = collectMcpNameLayers([
    { layer: "project", names: ["shared"] },
  ]);

  it("does not promote a name missing from the catalog layers to Local", () => {
    const filtered = filterMcpSettingsServers(catalogA, { nameLayer: layersB });
    expect(filtered.map((s) => s.name)).toEqual([]);
    expect(filtered.find((s) => s.name === "shared")).toBeUndefined();
    expect(filtered.find((s) => s.name === "a-only")).toBeUndefined();
  });

  it("keeps global shared and omits a-only when A's catalog is classified against A", () => {
    const nameCatalogFor = vi.fn((cwd: string) => ({
      nameLayer: cwd === "/proj-a" ? layersA : layersB,
    }));
    const filtered = mcpSettingsServersForCwd({
      servers: catalogA,
      catalogCwd: "/proj-a",
      nameCatalogFor,
    });
    expect(filtered.map((s) => s.name)).toEqual(["shared"]);
    expect(filtered.find((s) => s.name === "a-only")).toBeUndefined();
    expect(nameCatalogFor).toHaveBeenCalledWith("/proj-a");
    expect(nameCatalogFor).not.toHaveBeenCalledWith("/proj-b");
  });

  it("a global row survives a render for a different workspace because project-local rows never entered the view", () => {
    const nameCatalogFor = vi.fn((cwd: string) => ({
      nameLayer: cwd === "/proj-a" ? layersA : layersB,
    }));
    const storedView = mcpSettingsServersForCwd({
      servers: catalogA,
      catalogCwd: "/proj-a",
      nameCatalogFor,
    });
    expect(storedView.map((s) => s.name)).toEqual(["shared"]);
    expect(storedView.find((s) => s.name === "a-only")).toBeUndefined();
    expect(nameCatalogFor).toHaveBeenCalledWith("/proj-a");
    expect(nameCatalogFor).not.toHaveBeenCalledWith("/proj-b");
  });

  it("an unclassified catalog (no read-time cwd) yields an empty view", () => {
    const nameCatalogFor = vi.fn();
    expect(mcpSettingsServersForCwd({
      servers: catalogA,
      catalogCwd: undefined,
      nameCatalogFor,
    })).toEqual([]);
    expect(nameCatalogFor).not.toHaveBeenCalled();
  });

  it("sidebar stores the classified view, so a B session cannot reclassify A's inventory", () => {
    const proto = GrokSidebar.prototype as unknown as {
      filterMcpServers: (servers: typeof catalogA) => Array<{ name: string }>;
    };
    const instance = Object.create(proto) as {
      mcpServers: typeof catalogA;
      mcpServersCwd: string | undefined;
      mcpServersView: Array<{ name: string }>;
      mcpNameCatalogFor: any;
    };
    instance.mcpServers = catalogA;
    instance.mcpServersCwd = "/proj-a";
    instance.mcpNameCatalogFor = vi.fn((cwd: string) => ({
      nameLayer: cwd === "/proj-a" ? layersA : layersB,
    }));
    instance.mcpServersView = proto.filterMcpServers.call(instance, catalogA);

    expect(instance.mcpServersView.map((s) => s.name)).toEqual(["shared"]);
    expect(instance.mcpServersView.find((s) => s.name === "a-only")).toBeUndefined();
    expect(instance.mcpNameCatalogFor).toHaveBeenCalledWith("/proj-a");
    expect(instance.mcpNameCatalogFor).not.toHaveBeenCalledWith("/proj-b");

  });

  it("a startup notification updates dedup with no prior catalog read", () => {
    const proto = GrokSidebar.prototype as unknown as {
      applyMcpNotification(session: Session, method: string, params: unknown): void;
    };
    const store = { canva: { endpoint: "https://mcp.canva.com/mcp" } };
    const instance = Object.create(proto) as {
      mcpListSupported: boolean | undefined;
      mcpServers: Array<{ name: string }>;
      mcpServersCwd: string | undefined;
      mcpServersView: Array<{ name: string }>;
      grokMcpReserved: { names: string[]; urls: string[] };
      connectedConnectorStore: () => typeof store;
      sessionCwd: (session: Session) => string;
      postMcpServers: ReturnType<typeof vi.fn>;
    };
    instance.mcpListSupported = undefined;
    instance.mcpServers = [];
    instance.mcpServersCwd = undefined;
    instance.mcpServersView = [];
    instance.grokMcpReserved = { names: [], urls: [] };
    instance.connectedConnectorStore = () => store;
    instance.sessionCwd = (session) => session.cwd || "";
    instance.postMcpServers = vi.fn();

    expect(hostMcpServers(store, instance.grokMcpReserved).map((s) => s.name)).toEqual(["canva"]);

    const session = new Session();
    session.cwd = "/proj-a";
    proto.applyMcpNotification.call(instance, session, "_x.ai/mcp/servers_updated", {
      servers: [{
        name: "managed_gateway:canva",
        displayName: "Canva",
        source: "managed",
        enabled: true,
      }],
    });

    expect(instance.postMcpServers).not.toHaveBeenCalled();
    expect(hostMcpServers(store, instance.grokMcpReserved)).toEqual([]);
  });

  it("posts the stored classified view, not the incoming payload", () => {
    const src = readFileSync(new URL("../src/voice-and-mcp.ts", import.meta.url), "utf8");
    const post = src.slice(
      src.indexOf("public postMcpServers("),
      src.indexOf("public connectedConnectorStore("),
    );
    expect(post).toContain(".post(view)");

    const proto = GrokSidebar.prototype as unknown as {
      postMcpServers(message: { type: "mcpServers"; servers: Array<{ name: string }>; warning: string }): void;
    };
    const posted: Array<{ type: string; servers: Array<{ name: string }> }> = [];
    const instance = Object.create(proto) as {
      mcpServersView: Array<{ name: string; enabled: boolean }>;
      post: (msg: { type: string; servers: Array<{ name: string }> }) => void;
      settingsEditor: undefined;
    };
    instance.mcpServersView = [{ name: "shared", enabled: true }];
    instance.post = (msg) => posted.push(msg);
    instance.settingsEditor = undefined;
    proto.postMcpServers.call(instance, {
      type: "mcpServers",
      servers: [{ name: "should-not-appear" }],
      warning: MCP_GLOBAL_SCOPE_WARNING,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.servers.map((s) => s.name)).toEqual(["shared"]);
  });
});

describe("MCP inventory while a non-Grok session is focused", () => {
  function mcpHarness(opts: {
    focused: Session;
    pool: Session[];
    grokConnected: boolean;
  }) {
    const proto = GrokSidebar.prototype as unknown as {
      refreshMcpServers(session: Session): Promise<void>;
    };
    const posted: Array<{ type: string; error?: string; loading?: boolean }> = [];
    const startSession = vi.fn(async (_id: unknown, target: Session) => {
      target.client = {
        listMcpServers: vi.fn().mockResolvedValue({ servers: [{ name: "notes", source: "local", enabled: true }] }),
      } as unknown as Session["client"];
      return target.client;
    });
    const instance = Object.create(proto) as {
      focused: Session;
      pool: Set<Session>;
      mcpServers: unknown[];
      mcpServersView: unknown[];
      mcpServersCwd: string | undefined;
      mcpListSupported: boolean | undefined;
      grokMcpReserved: { names: string[]; urls: string[] };
      postMcpServers: (msg: { type: string; error?: string; loading?: boolean }) => void;
      sessionCwd: (session: Session) => string;
      filterMcpServers: (servers: unknown[]) => unknown[];
      connectedConnectorStore: () => Record<string, never>;
      connectedProviders: () => string[];
      startSession: typeof startSession;
      setSessionCwd: (session: Session, cwd: string) => void;
      newLocalSession: () => Session;
      workspaceRoot: () => string;
      host: { appendLine: ReturnType<typeof vi.fn> };
    };
    instance.focused = opts.focused;
    instance.pool = new Set(opts.pool);
    instance.mcpServers = [];
    instance.mcpServersView = [];
    instance.mcpServersCwd = undefined;
    instance.mcpListSupported = undefined;
    instance.grokMcpReserved = { names: [], urls: [] };
    instance.postMcpServers = (msg) => { posted.push(msg); };
    instance.sessionCwd = (session) => session.cwd || "";
    instance.filterMcpServers = (servers) => servers;
    instance.connectedConnectorStore = () => ({});
    instance.connectedProviders = () => (opts.grokConnected ? ["grok", "codex"] : ["codex"]);
    instance.startSession = startSession;
    instance.setSessionCwd = (session, cwd) => { session.cwd = cwd; };
    instance.newLocalSession = () => new Session();
    instance.workspaceRoot = () => "/proj";
    instance.host = { appendLine: vi.fn() };
    return { proto, instance, posted, startSession };
  }

  it("lists MCP from a pooled Grok session while Codex is focused", async () => {
    const listMcpServers = vi.fn().mockResolvedValue({
      servers: [{ name: "notes", source: "local", enabled: true }],
    });
    const grok = new Session();
    grok.provider = "grok";
    grok.cwd = "/proj";
    grok.client = { listMcpServers } as unknown as Session["client"];
    const focused = new Session();
    focused.provider = "codex";
    focused.cwd = "/proj";
    const { proto, instance, posted, startSession } = mcpHarness({
      focused,
      pool: [focused, grok],
      grokConnected: true,
    });
    await proto.refreshMcpServers.call(instance, focused);
    expect(listMcpServers).toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(instance.mcpServersCwd).toBe("/proj");
    expect(posted.some((msg) => msg.error === "Connect Grok to inspect MCP servers.")).toBe(false);
    expect(posted.some((msg) => msg.loading === true)).toBe(true);
  });

  it("starts a Grok session when none is live and Grok is connected", async () => {
    const focused = new Session();
    focused.provider = "codex";
    focused.cwd = "/proj";
    const { proto, instance, posted, startSession } = mcpHarness({
      focused,
      pool: [focused],
      grokConnected: true,
    });
    await proto.refreshMcpServers.call(instance, focused);
    expect(startSession).toHaveBeenCalled();
    expect(posted.some((msg) => msg.error === "Connect Grok to inspect MCP servers.")).toBe(false);
    expect(instance.mcpServersCwd).toBe("/proj");
  });

  it("says Connect Grok only when the Grok provider is not connected", async () => {
    const focused = new Session();
    focused.provider = "codex";
    focused.cwd = "/proj";
    const { proto, instance, posted, startSession } = mcpHarness({
      focused,
      pool: [focused],
      grokConnected: false,
    });
    await proto.refreshMcpServers.call(instance, focused);
    expect(startSession).not.toHaveBeenCalled();
    expect(posted.some((msg) => msg.error === "Connect Grok to inspect MCP servers.")).toBe(true);
  });

  it("overlapping inventory reads share one Grok start", async () => {
    const focused = new Session();
    focused.provider = "codex";
    focused.cwd = "/proj";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { proto, instance, startSession } = mcpHarness({
      focused,
      pool: [focused],
      grokConnected: true,
    });
    const minted: Session[] = [];
    instance.newLocalSession = () => {
      const session = new Session();
      minted.push(session);
      return session;
    };
    startSession.mockImplementation(async (_id: unknown, target: Session) => {
      await gate;
      target.client = {
        listMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
      } as unknown as Session["client"];
      return target.client;
    });
    const first = proto.refreshMcpServers.call(instance, focused);
    const second = proto.refreshMcpServers.call(instance, focused);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(minted).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(minted).toHaveLength(1);
  });
});
