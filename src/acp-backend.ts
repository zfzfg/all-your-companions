import type { EffortLevel, PromptContentBlock } from "./acp";
import { providerCapability, type ProviderCapability } from "./provider-capabilities";

export const ACP_PROVIDERS = ["grok", "codex", "claude", "gemini"] as const;
export type AcpProvider = (typeof ACP_PROVIDERS)[number];

export function isAcpProvider(value: unknown): value is AcpProvider {
  return typeof value === "string" && (ACP_PROVIDERS as readonly string[]).includes(value);
}

function can(provider: AcpProvider, cap: ProviderCapability): boolean {
  return providerCapability(provider, cap).state === "yes";
}

/** Providers whose conversations live in an adapter catalog, not ~/.grok. */
export function usesAdapterHistory(provider: AcpProvider): boolean {
  return can(provider, "adapterHistory");
}

export const isAdapterProvider = usesAdapterHistory;

export function supportsHistoryDeletion(provider: AcpProvider): boolean {
  return can(provider, "deleteHistory");
}

export function supportsCompaction(provider: AcpProvider): boolean {
  return can(provider, "manualCompact");
}

/** ACP `session/delete` — only adapter catalogs answer it. */
export function supportsSessionDeletion(provider: AcpProvider): boolean {
  return usesAdapterHistory(provider) && supportsHistoryDeletion(provider);
}

export function supportsModeSwitching(provider: AcpProvider): boolean {
  return can(provider, "modeSwitching");
}

export function usesPerCallContextOccupancy(provider: AcpProvider): boolean {
  return can(provider, "perCallContext");
}

export function supportsClientMcpServers(provider: AcpProvider): boolean {
  return can(provider, "clientMcp");
}

export interface BackendSpawnOptions {
  cliPath: string;
  cwd: string;
  effort?: EffortLevel;
  env: NodeJS.ProcessEnv;
}

export interface BackendSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export interface BackendConfigState {
  modelId?: string;
  reasoningEffort?: string;
  modeId?: string;
  extraConfigOptions?: any[];
}

export interface BackendUpdate {
  update?: any;
  meta?: any;
  sessionTitle?: string;
  contextWindow?: number;
  /**
   * Ordinary `usage_update.used` is billed per model call (includes output).
   * Compact's getContextUsage is the exception — the host only adopts this
   * when a compact just completed. Otherwise these are per-call observations
   * for occupancyFromAdapterTurn, not occupancy by themselves.
   */
  usageUpdateUsed?: number;
}

export interface BackendSessionListEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string | number;
}

export interface BackendSessionListResult {
  sessions: BackendSessionListEntry[];
  nextCursor?: string | null;
}

/** Whether this backend can hear a mid-turn correction, read at initialize. */
export interface BackendSteeringCapabilities {
  supported: boolean;
  /** Structured content (images) is applied rather than silently dropped. */
  acceptsContent: boolean;
}

export interface BackendSteeringOptions {
  grokVersion?: string;
  grokVersionVerified?: boolean;
}

export interface AcpBackend {
  readonly provider: AcpProvider;
  readonly processName: string;
  readonly usesClientPlanGate: boolean;
  spawn(options: BackendSpawnOptions): BackendSpawnSpec;
  normalizeSessionResponse(response: any): any;
  normalizePromptResult(result: any): any;
  normalizeUpdate(update: any, meta: any): BackendUpdate;
  normalizePermissionParams(params: any): any;
  setModel(sessionId: string, modelId: string, reasoningEffort?: string): { method: string; params: any };
  setReasoningEffort(sessionId: string, modelId: string | undefined, level: string): { method: string; params: any } | null;
  setMode(sessionId: string, modeId: string): { method: string; params: any };
  configState(response: any, fallback: BackendConfigState): BackendConfigState;
  modelSetSucceeded(response: any): boolean;
  listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult>;
  isCredentialError(error: unknown): boolean;
  /**
   * Steer (upstream 2f67d9a): the backend reads its own capability from the
   * initialize result and names the method, next to setModel/setMode.
   */
  steeringCapabilities(initializeResult: any, options: BackendSteeringOptions): BackendSteeringCapabilities;
  interject(sessionId: string, text: string, content?: readonly PromptContentBlock[]): { method: string; params: any } | null;
  /**
   * Whether a steering RPC that RESOLVED actually delivered the text. Some
   * adapters report a steering failure in-band, as a successful response
   * (upstream 5088ce8).
   */
  steerDelivered(result: any): boolean;
  sessionNewMeta?(cwd: string): Record<string, unknown> | undefined;
}
