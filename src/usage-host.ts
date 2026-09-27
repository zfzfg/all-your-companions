/**
 * UsageHost: context usage, billing token accumulation, subscription capacity,
 * and near-full prompt handling.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S7c).
 */

import type { Host } from "./host";
import type { HostMsg } from "./protocol";
import type { Session } from "./session";
import type { AcpClient } from "./acp";
import type { AcpProvider } from "./acp-backend";
import { isAdapterProvider } from "./acp-backend";
import { providerCapability } from "./provider-capabilities";
import {
  type PromptResultMeta,
  type PromptUsage,
  type SessionInfoContext,
  adapterCompactSignal,
  adapterContextOccupancy,
  enforceCompleteSessionCost,
  occupancyFromAdapterTurn,
  parseSessionInfoContext,
  sessionInfoCacheFresh,
  sumUsage,
  usageIsRealMeasurement,
} from "./acp-dispatch";
import {
  capUsageLog,
  defaultFs,
  persistSessionContext,
  persistedContextUsage,
  readContextUsage,
  resolveGrokHome,
  type SessionMetaOverrides,
} from "./sessions";
import { freePercentFromWindows } from "./limit-errors";
import { SESSION_META_KEY } from "./worktree-host";
import { resolveCodexHome } from "./codex-cli-locator";
import { readCodexSubscriptionWindows } from "./codex-usage";
import {
  subscriptionCredentialContext,
  SubscriptionUsageBinding,
  SubscriptionUsageCache,
} from "./subscription-usage";
import {
  compactThresholdMismatch,
  compactThresholdMismatchNotice,
  shouldOfferNearFull,
} from "./grok-compaction";
import { turnIsInFlight } from "./session";

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: any): Thenable<void> | Promise<void>;
}

export interface UsageHostDeps {
  host: Host;
  state: MementoLike;
  emit(session: Session, msg: HostMsg): void;
  sessionCwd(session: Session): string;
  readDotEnv(cwd: string): Record<string, string>;
  getFocused(): Session;
  getPool(): Iterable<Session>;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class UsageHost {
  private subscriptionUsageCaches?: Map<string, SubscriptionUsageCache>;
  public compactMismatchNoticeShown = false;

  constructor(private readonly deps: UsageHostDeps) {}

  public accumulateUsage(session: Session, meta: PromptResultMeta): PromiseLike<void> | undefined {
    const measured = usageIsRealMeasurement(meta);
    if (measured) {
      const u = meta.usage ?? {};
      this.deps.host.appendLine(
        `[usage] ${session.provider} turn`
        + ` in=${u.inputTokens ?? meta.inputTokens ?? 0}`
        + ` out=${u.outputTokens ?? meta.outputTokens ?? 0}`
        + ` reasoning=${u.reasoningTokens ?? meta.reasoningTokens ?? 0}`
        + ` cacheRead=${u.cachedReadTokens ?? meta.cachedReadTokens ?? 0}`
        + ` cacheWrite=${u.cachedWriteTokens ?? meta.cachedWriteTokens ?? 0}`
        + ` total=${u.totalTokens ?? meta.totalTokens ?? 0}`
        + ` model=${meta.modelId ?? session.client?.currentModelId ?? "?"}`,
      );
    }
    if (!measured && meta.totalTokens !== 0) return;
    const id = session.activeSessionId;
    if (!id) return;
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const occupancy = this.adapterTurnOccupancy(session, meta);
    const compacted = isAdapterProvider(session.provider) && session.adapterCompactThisTurn;
    const usageLog = capUsageLog([
      ...(cur.usageLog ?? []),
      {
        afterUserMessage: session.userMessageCount,
        afterHistoryEvent: session.historyEventCount,
        usage: measured ? meta.usage : undefined,
        ...(occupancy !== undefined
          ? { contextUsed: occupancy }
          : compacted && !cur.contextPendingCompact && cur.contextUsed
            ? { contextUsed: cur.contextUsed }
            : {}),
        ...(compacted ? { compacted: true } : {}),
      },
    ]);
    const sessionUsage = enforceCompleteSessionCost(
      sumUsage(usageLog),
      usageLog,
      session.userMessageCount,
    );
    if (measured) {
      this.deps.emit(session, {
        type: "usage",
        turn: meta.usage,
        session: sessionUsage,
        afterUserMessage: session.userMessageCount,
        afterHistoryEvent: session.historyEventCount,
      });
    }
    return this.deps.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...cur, usage: sessionUsage, usageLog },
    });
  }

  public persistedUsageLedger(sessionId: string, userMessageCount: number): {
    usageLog: NonNullable<SessionMetaOverrides[string]["usageLog"]>;
    usage: PromptUsage | undefined;
  } {
    const persisted = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[sessionId];
    const usageLog = [...(persisted?.usageLog ?? [])];
    const rawUsage = persisted?.usageLog ? sumUsage(usageLog) : persisted?.usage;
    return {
      usageLog,
      usage: enforceCompleteSessionCost(rawUsage, usageLog, userMessageCount),
    };
  }

  public restoreUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const stored = this.persistedUsageLedger(id, session.userMessageCount).usage;
    if (!stored) return;
    this.deps.emit(session, {
      type: "usage",
      session: stored,
      afterUserMessage: session.userMessageCount,
      afterHistoryEvent: session.historyEventCount,
    });
  }

  public noteAdapterCompactSignal(session: Session, update: unknown): void {
    if (session.replaying || !isAdapterProvider(session.provider)) return;
    const signal = adapterCompactSignal(update);
    if (!signal) return;
    if (signal === "failed") {
      session.compactUsageArmed = false;
      session.adapterCompactThisTurn = false;
      this.rememberAdapterContext(session, { compactFailed: true });
      return;
    }
    session.adapterCompactThisTurn = true;
    session.compactUsageArmed = signal === "completed";
    this.rememberAdapterContext(session, { compacted: true });
  }

  public adapterTurnOccupancy(session: Session, meta: PromptResultMeta): number | undefined {
    if (!usageIsRealMeasurement(meta) || session.adapterCompactThisTurn) return undefined;
    return occupancyFromAdapterTurn(adapterContextOccupancy(meta.usage), session.adapterTurnCallUsed);
  }

  public rememberAdapterContext(
    session: Session,
    event: Parameters<typeof persistSessionContext>[1],
  ): { used?: number; window?: number } | undefined {
    if (!isAdapterProvider(session.provider)) return undefined;
    const id = session.activeSessionId;
    if (!id) return undefined;
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const next = persistSessionContext(overrides[id] ?? {}, event);
    void this.deps.state.update(SESSION_META_KEY, { ...overrides, [id]: next });
    const usage = persistedContextUsage(next);
    if (usage) {
      this.deps.emit(session, {
        type: "contextUsage",
        used: usage.used,
        ...(usage.window ? { window: usage.window } : {}),
      });
    } else if (next.contextWindow) {
      this.deps.emit(session, { type: "contextUsage", window: next.contextWindow });
    }
    return { used: next.contextUsed, window: next.contextWindow };
  }

  public emitContextUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    if (isAdapterProvider(session.provider)) {
      const usage = persistedContextUsage(this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]);
      if (usage) {
        this.deps.emit(session, {
          type: "contextUsage",
          used: usage.used,
          ...(usage.window ? { window: usage.window } : {}),
        });
      }
      return;
    }
    const cwd = this.deps.sessionCwd(session);
    const usage = readContextUsage({ fs: defaultFs, grokHome: resolveGrokHome(process.env), cwd, id });
    if (usage) this.deps.emit(session, { type: "contextUsage", used: usage.used, window: usage.window });
  }

  public bindSubscriptionUsage(session: Session, env: NodeJS.ProcessEnv): void {
    const provider = session.provider;
    if (provider !== "grok" && provider !== "claude" && provider !== "codex") {
      session.subscriptionUsage = undefined;
      return;
    }
    const cwd = this.deps.sessionCwd(session);
    const key = subscriptionCredentialContext(provider, env);
    const caches = this.subscriptionUsageCaches ??= new Map();
    let cache = provider === "claude" ? new SubscriptionUsageCache() : caches.get(key);
    if (!cache) caches.set(key, cache = new SubscriptionUsageCache());
    session.subscriptionUsage = new SubscriptionUsageBinding(cache, key, () =>
      subscriptionCredentialContext(provider, provider === "grok"
        ? { ...process.env, ...this.deps.readDotEnv(cwd) } : process.env));
  }

  public measuredFreePercent(provider: AcpProvider): number | undefined {
    for (const session of new Set([this.deps.getFocused(), ...(this.deps.getPool() ?? [])])) {
      if (session?.provider !== provider || !session.subscriptionUsage) continue;
      const free = freePercentFromWindows(session.subscriptionUsage.snapshot());
      if (free !== undefined) return free;
    }
    return undefined;
  }

  public invalidateSubscriptionUsage(provider: AcpProvider): void {
    for (const [key, cache] of this.subscriptionUsageCaches ?? []) {
      if (key.startsWith(`${provider}:`)) {
        cache.invalidate();
        this.subscriptionUsageCaches!.delete(key);
      }
    }
    for (const session of new Set([this.deps.getFocused(), ...(this.deps.getPool() ?? [])])) {
      if (session?.provider !== provider || !session.subscriptionUsage) continue;
      session.subscriptionUsage.invalidate();
      this.publishSubscriptionUsage(session);
    }
  }

  public publishSubscriptionUsage(session: Session): void {
    this.deps.emit(session, { type: "subscriptionUsage", windows: session.subscriptionUsage?.snapshot() ?? [] });
  }

  public async refreshSubscriptionUsage(session: Session): Promise<void> {
    const binding = session.subscriptionUsage;
    const client = session.client;
    this.publishSubscriptionUsage(session);
    if (!binding) return;
    if (session.provider === "codex") {
      await binding.refresh(async () => readCodexSubscriptionWindows({ codexHome: resolveCodexHome(process.env) }));
    } else if (session.provider === "grok") {
      if (!client?.sessionId) return;
      await binding.refresh(() => client.getSubscriptionUsage());
    } else return;
    if (session.client === client && session.subscriptionUsage === binding) this.publishSubscriptionUsage(session);
  }

  public emitSessionInfoContext(session: Session, info: SessionInfoContext): void {
    session.lastSessionInfoAt = Date.now();
    session.lastSessionInfoUsed = info.used;
    session.sessionInfoStale = false;
    this.deps.emit(session, {
      type: "contextUsage",
      used: info.used,
      window: info.window,
      categories: info.categories,
      systemPromptTokens: info.systemPromptTokens,
      toolDefinitionsTokens: info.toolDefinitionsTokens,
      toolDefinitionsCount: info.toolDefinitionsCount,
      messageTokens: info.messageTokens,
      freeTokens: info.freeTokens,
      autoCompactThresholdPercent: info.autoCompactThresholdPercent,
      compactionCount: info.compactionCount,
    });
    if (info.autoCompactThresholdPercent !== undefined) session.compactThresholdReported = info.autoCompactThresholdPercent;
    if (info.compactionCount !== undefined) session.compactionCount = info.compactionCount;
    this.checkCompactThreshold(session, info.autoCompactThresholdPercent);
  }

  public checkCompactThreshold(session: Session, reported: number | undefined): void {
    if (session.provider !== "grok" || session.compactThresholdChecked || reported === undefined) return;
    session.compactThresholdChecked = true;
    const desired = session.compactThresholdRequested;
    if (!compactThresholdMismatch(desired, reported)) return;
    const text = compactThresholdMismatchNotice(desired!, reported);
    this.deps.host.appendLine(`[context] ${text}`);
    if (this.compactMismatchNoticeShown) return;
    this.compactMismatchNoticeShown = true;
    this.deps.emit(session, { type: "hostNotice", level: "warning", text });
  }

  public maybeOfferNearFull(
    session: Session,
    used: number | undefined,
    window: number | undefined,
    threshold: number | undefined,
  ): void {
    if (used === undefined || window === undefined) return;
    const effective = threshold ?? session.compactThresholdReported;
    if (session.provider === "muse") return;
    let mode: "ask" | "off" = "ask";
    try {
      mode = this.deps.host.getConfiguration("companions").get<string>("context.nearFullPrompt", "ask") === "off" ? "off" : "ask";
    } catch { /* default */ }
    if (!shouldOfferNearFull({ used, window, thresholdPercent: effective, armed: session.nearFullArmed, mode })) return;
    if (session !== this.deps.getFocused()) return;
    session.nearFullArmed = false;
    this.deps.emit(session, {
      type: "nearFullPrompt",
      used,
      window,
      threshold: effective!,
      canCompact: providerCapability(session.provider, "manualCompact").state !== "no",
    });
  }

  public async refreshContextFromSessionInfo(
    session: Session,
    gen: number,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    if ((session.provider !== "grok" && session.provider !== "gemini") || gen !== session.gen || session.sessionInfoUnsupported) return false;
    const client = session.client;
    if (!client?.sessionId) return false;
    if (!opts.force && !session.sessionInfoStale && sessionInfoCacheFresh(session.lastSessionInfoAt, Date.now())) {
      return false;
    }
    try {
      const info = await client.getSessionInfo();
      if (gen !== session.gen) return false;
      if (info === "unsupported") {
        session.sessionInfoUnsupported = true;
        return false;
      }
      this.emitSessionInfoContext(session, info);
      return true;
    } catch (error) {
      this.deps.host.appendLine(`[context] session/info failed: ${(error as Error).message}`);
      return false;
    }
  }

  public async refreshContextAfterCompact(client: AcpClient, session: Session, gen: number): Promise<void> {
    if (await this.refreshContextFromSessionInfo(session, gen, { force: true })) return;
    if (gen !== session.gen || !session.sessionInfoUnsupported) return;
    if (!client.availableCommands.some((command) => command?.name === "session-info")) return;
    if (turnIsInFlight(session)) return;
    session.suppressContent = true;
    session.captureAgentText = "";
    try {
      await client.prompt("/session-info");
      if (gen !== session.gen) return;
      const info = parseSessionInfoContext(session.captureAgentText);
      if (info) this.deps.emit(session, { type: "contextUsage", used: info.used, window: info.window });
    } catch (error) {
      this.deps.host.appendLine(`[compact] hidden /session-info failed: ${(error as Error).message}`);
    } finally {
      if (gen === session.gen) session.suppressContent = false;
      session.captureAgentText = undefined;
    }
  }
}

export function createUsageHost(deps: UsageHostDeps): UsageHost {
  return new UsageHost(deps);
}
