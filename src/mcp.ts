/** Pure MCP catalog and live-status helpers for the Grok ACP surface. */

import type { McpConfigLayer } from "./mcp-connectors";

export type { McpConfigLayer };

export const MCP_GLOBAL_SCOPE_WARNING =
  "This list is read-only. Connector enable/disable is machine-global and is not controlled here.";

export interface McpToolView {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServerView {
  name: string;
  displayName?: string;
  enabled: boolean;
  managed?: boolean;
  scope?: string;
  /** Human label from `_x.ai/mcp/list` (`scopeName`), e.g. `"Grok CLI"`. */
  scopeName?: string;
  source?: string;
  /**
   * Basename of the user-level config file that declared this server
   * (`config.toml`, `mcp.json`). Managed rows and host-injected echoes have
   * none.
   */
  configFile?: string;
  status?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  tools?: McpToolView[];
  toolCount?: number;
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length ? strings : undefined;
}

function booleanField(session: Record<string, unknown> | undefined, item: Record<string, unknown>, key: string): boolean | undefined {
  return typeof session?.[key] === "boolean"
    ? session[key] as boolean
    : typeof item[key] === "boolean" ? item[key] as boolean : undefined;
}

function textField(session: Record<string, unknown> | undefined, item: Record<string, unknown>, key: string): string | undefined {
  return text(session?.[key]) || text(item[key]);
}

function parseTool(value: unknown): McpToolView | undefined {
  const tool = record(value);
  if (!tool) return undefined;
  const name = text(tool.name);
  const description = text(tool.description);
  const inputSchema = tool.inputSchema;
  if (!name && !description && inputSchema === undefined) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  };
}

function parseTools(value: unknown): McpToolView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value
    .map(parseTool)
    .filter((tool): tool is McpToolView => !!tool);
  return tools.length ? tools : undefined;
}

function parseServer(value: unknown): McpServerView | undefined {
  const item = record(value);
  if (!item) return undefined;
  const session = record(item.session);
  const name = textField(session, item, "name");
  if (!name) return undefined;
  const tools = parseTools(Array.isArray(session?.tools) ? session.tools : item.tools);
  const source = textField(session, item, "source");
  const type = textField(session, item, "type") || textField(session, item, "transport");
  const enabled = booleanField(session, item, "enabled");
  return {
    name,
    ...(textField(session, item, "displayName") ? { displayName: textField(session, item, "displayName") } : {}),
    enabled: enabled ?? true,
    ...(source ? { source } : {}),
    ...(type ? { type } : {}),
    ...(source === "managed" || type === "managedGateway" ? { managed: true } : {}),
    ...(textField(session, item, "scope") ? { scope: textField(session, item, "scope") } : {}),
    ...(textField(session, item, "scopeName") || textField(session, item, "scope_name")
      ? { scopeName: textField(session, item, "scopeName") || textField(session, item, "scope_name") }
      : {}),
    ...(textField(session, item, "status") ? { status: textField(session, item, "status") } : {}),
    ...(text(item.command) ? { command: text(item.command) } : {}),
    ...(stringArray(item.args) ? { args: stringArray(item.args) } : {}),
    ...(text(item.url) ? { url: text(item.url) } : {}),
    ...(tools ? { tools, toolCount: tools.length } : {}),
    ...(textField(session, item, "error") ? { error: textField(session, item, "error") } : {}),
  };
}

function listFromPayload(parsed: unknown): unknown[] | undefined {
  if (typeof parsed === "string") {
    try { return listFromPayload(JSON.parse(parsed)); } catch { return undefined; }
  }
  if (Array.isArray(parsed)) return parsed;
  const object = record(parsed);
  // Grok 1.0.5 currently returns an extra `{ result: ... }` envelope for
  // this undocumented RPC when called over ACP. Keep accepting the documented
  // shape as well as the wire shape actually emitted by the CLI.
  if (object?.result !== undefined) return listFromPayload(object.result);
  return Array.isArray(object?.servers) ? object.servers : undefined;
}

/**
 * Parse `_x.ai/mcp/list`, accepting a bare array and `{ servers: [] }`.
 * Allowlisted desk view only — env/headers/token/apiKey never reach the
 * catalog. Launch recipes stay for the local panel.
 */
export function parseMcpListResponse(value: unknown): McpServerView[] {
  const list = listFromPayload(value);
  if (!list) throw new Error("Unexpected response from _x.ai/mcp/list");
  return list
    .map(parseServer)
    .filter((server): server is McpServerView => !!server)
    .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
}

/**
 * Settings → Connectors lists grok.com-managed servers and user-level
 * config-file locals. A server belongs in Local only when its name is in a
 * user-level config layer we actually read (`collectMcpNameLayers`). A
 * `source: "local"` echo we injected at `session/new` is in no layer — it
 * already has an On this computer row. Project-file servers
 * (`.mcp.json`, `.grok/config.toml`) are omitted; that layer is classified
 * by `mcpConfigLayer`, not guessed from the section.
 */
export function mcpSettingsVisible(input: {
  source?: string;
  managed?: boolean;
  localLayer?: McpConfigLayer;
}): boolean {
  if (input.managed === true || input.source === "managed") return true;
  return input.localLayer === "user";
}

/** grok.com-managed vs everything else that survived {@link mcpSettingsVisible}. */
export function mcpIsManaged(server: { managed?: boolean; source?: string }): boolean {
  return server.managed === true || server.source === "managed";
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function mcpConfigFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Drop project-file rows and host-injected echoes (names in no config
 * layer). Stamp `configFile` (basename) on user-level locals. Strips a
 * leftover `tag`. Does not mutate `servers`.
 */
export function filterMcpSettingsServers(
  servers: readonly McpServerView[],
  opts: {
    nameLayer: ReadonlyMap<string, McpConfigLayer>;
    nameFile?: ReadonlyMap<string, string>;
  },
): McpServerView[] {
  const out: McpServerView[] = [];
  for (const server of servers) {
    const managed = mcpIsManaged(server);
    const localLayer = managed
      ? undefined
      : opts.nameLayer.get(nameKey(server.name));
    if (!mcpSettingsVisible({ source: server.source, managed: server.managed, localLayer })) {
      continue;
    }
    const rest = { ...server } as McpServerView & { tag?: string };
    delete rest.tag;
    if (managed) {
      delete rest.configFile;
      out.push(rest);
      continue;
    }
    const filePath = opts.nameFile?.get(nameKey(server.name));
    const configFile = filePath ? mcpConfigFileName(filePath) : undefined;
    if (configFile) rest.configFile = configFile;
    else delete rest.configFile;
    out.push(rest);
  }
  return out;
}

/**
 * Classify an `_x.ai/mcp/list` inventory against the workspace it was read
 * from. Project-file rows drop here; what remains is global and may be
 * rendered for any later workspace. `nameCatalogFor` is invoked only with
 * `catalogCwd`. A missing catalog cwd yields `[]` — nothing has been classified.
 */
export function mcpSettingsServersForCwd(opts: {
  servers: readonly McpServerView[];
  catalogCwd: string | undefined;
  nameCatalogFor: (cwd: string) => {
    nameLayer: ReadonlyMap<string, McpConfigLayer>;
    nameFile?: ReadonlyMap<string, string>;
  };
}): McpServerView[] {
  const catalogCwd = opts.catalogCwd;
  if (!catalogCwd) return [];
  const catalog = opts.nameCatalogFor(catalogCwd);
  return filterMcpSettingsServers(opts.servers, {
    nameLayer: catalog.nameLayer,
    nameFile: catalog.nameFile,
  });
}

/** Merge one of Grok's undocumented MCP status notifications into a catalog. */
export function mergeMcpNotification(
  current: readonly McpServerView[],
  method: string,
  params: unknown,
): McpServerView[] {
  const payload = record(params);
  if (!payload) return [...current];

  const servers = listFromPayload(payload.servers);
  if (method === "_x.ai/mcp/servers_updated" && servers) {
    const updates = parseMcpListResponse(servers);
    const byName = new Map(updates.map((server) => [server.name, server]));
    return current.map((server) => {
      const update = byName.get(server.name);
      return update ? { ...server, ...update, tools: update.tools ?? server.tools, toolCount: update.toolCount ?? server.toolCount } : server;
    }).concat(updates.filter((server) => !current.some((item) => item.name === server.name)))
      .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
  }

  if (method === "_x.ai/mcp_initialized") return [...current];
  const name = text(payload.name) || text(payload.server);
  if (!name) return [...current];
  const status = text(payload.status) || (method === "_x.ai/mcp/init_progress" ? text(payload.phase) : undefined);
  const error = text(payload.detail) || text(payload.error) || text(payload.reason);
  const existing = current.find((server) => server.name === name || server.displayName === name);
  const update: Partial<McpServerView> = {
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : {}),
    ...(Array.isArray(payload.tools) ? { tools: parseTools(payload.tools), toolCount: payload.tools.length } : {}),
  };
  // An error belongs to the event that reported it. A later notification that
  // states a status and reports no error supersedes it, so the old text must
  // not survive into the new state — nothing else ever cleared it, and a
  // server that failed once kept its error for the life of the session. Both
  // renderers short-circuit on `error`, so a recovered server stayed red at
  // the desk, and once a failure is projected to the phone as `unavailable`
  // it stayed red there too. If the fresh status is itself a failure it still
  // renders as one; it just does it on the current status rather than on a
  // sentence about something that has already stopped being true.
  if (status && !error) update.error = undefined;
  if (existing) return current.map((server) => server === existing ? { ...server, ...update } : server);
  return [...current, { name, enabled: true, ...update }].sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
}

export function mcpServerDetail(server: McpServerView): string {
  const parts: string[] = [];
  if (server.enabled === false) parts.push("disabled");
  if (server.status) parts.push(server.status);
  if (typeof server.toolCount === "number") {
    parts.push(`${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`);
  }
  if (server.url) parts.push(server.url);
  else if (server.command) parts.push([server.command, ...(server.args ?? [])].join(" "));
  if (server.error) parts.push(server.error);
  return parts.join(" · ");
}
