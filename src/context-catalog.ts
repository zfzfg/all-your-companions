import { contextWindowSizes } from "./context-selection";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { subscriptionCredentialContext } from "./subscription-usage";
import type { AcpProvider } from "./acp-backend";
import { CONTEXT_CACHE_TTL_MS, contextTokens, validContextLimits, type ModelContextLimits } from "./context-budget";

export interface ContextCatalogModel {
  modelId: string;
  resolvedModelId?: string;
  name: string;
  limits: ModelContextLimits;
  contextWindowSizes?: number[];
}
export interface ContextCatalogSnapshot {
  models: ContextCatalogModel[];
  observedAt: number;
  stale: boolean;
  access: string;
}
export function modelsMatch(a?: string, b?: string): boolean {
  // Alias resolution belongs to the access-scoped native catalog, not spelling.
  return !!a && !!b && a === b;
}

type CatalogParser = (raw: any) => ContextCatalogModel[];
export const CATALOG_PARSERS: Partial<Record<AcpProvider, CatalogParser>> = {
  grok: raw => Object.entries(raw?.models ?? {}).flatMap(([id, entry]: [string, any]) => {
    const info = entry?.info;
    if (!info || info.hidden === true) return [];
    return [{ modelId: id, resolvedModelId: typeof info.model === "string" ? info.model : id,
      name: typeof info.name === "string" ? info.name : id,
      contextWindowSizes: contextWindowSizes(info.context_windows, info.context_window),
      limits: validContextLimits({ modelMaximum: Math.max(...contextWindowSizes(info.context_windows, info.context_window)), contextWindow: contextWindowSizes(info.context_windows, info.context_window)[0],
        outputReserve: info.max_completion_tokens, autoCompactThresholdPercent: info.auto_compact_threshold_percent }) }];
  }),
  codex: raw => (Array.isArray(raw?.models) ? raw.models : []).flatMap((row: any) => {
    if (typeof row?.slug !== "string" || row.visibility === "hide") return [];
    const window = contextTokens(row.context_window);
    const percent = row.effective_context_window_percent;
    const effective = window && typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100
      ? Math.floor(window * percent / 100) : undefined;
    return [{ modelId: row.slug, resolvedModelId: row.slug, name: row.display_name ?? row.slug,
      limits: validContextLimits({ modelMaximum: window, contextWindow: window, effectiveContextTokens: effective,
        // The CLI effective factor reserves its own headroom. Do not apply it again.
        reserveIncluded: effective !== undefined }) }];
  }),
};
const CATALOG_HOME: Partial<Record<AcpProvider, (env: NodeJS.ProcessEnv) => string>> = {
  grok: env => env.GROK_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".grok"),
  codex: env => env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".codex"),
};

export function contextCatalogPath(provider: AcpProvider, env: NodeJS.ProcessEnv): string | undefined {
  const home = CATALOG_HOME[provider]?.(env);
  return home ? path.join(home, "models_cache.json") : undefined;
}
export function parseContextCatalog(provider: AcpProvider, raw: unknown, now: number, access: string): ContextCatalogSnapshot {
  const body = raw as any;
  const fetched = typeof body?.fetched_at === "number" ? body.fetched_at < 1e12 ? body.fetched_at * 1000 : body.fetched_at
    : Date.parse(body?.fetched_at ?? "");
  const observedAt = Number.isFinite(fetched) && fetched <= now ? fetched : 0;
  return { models: CATALOG_PARSERS[provider]?.(body) ?? [], observedAt,
    stale: observedAt === 0 || now - observedAt >= CONTEXT_CACHE_TTL_MS,
    // Identity is hashed, never retained in the public model metadata.
    access: createHash("sha256").update(JSON.stringify([access, body?.identity, body?.origin,
      body?.client_version, body?.grok_version])).digest("hex") };
}

/** Observes vendor-owned caches. Does not modify config or invent network endpoints. */
export class ContextCatalogReader {
  private watcher?: fs.FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private revision = 0;
  private snapshot?: ContextCatalogSnapshot;
  private readonly file?: string;
  constructor(private readonly provider: AcpProvider, private readonly env: NodeJS.ProcessEnv,
    private readonly changed: (snapshot: ContextCatalogSnapshot) => void,
    private readonly log: (message: string) => void, private readonly versionScope = "") {
    this.file = contextCatalogPath(provider, env);
  }
  async refresh(): Promise<void> {
    if (!this.file || this.disposed) return;
    const revision = ++this.revision;
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
      if (this.disposed || revision !== this.revision) return;
      this.snapshot = parseContextCatalog(this.provider, raw, Date.now(), JSON.stringify([
        this.file, this.versionScope, subscriptionCredentialContext(this.provider, this.env),
      ]));
      this.changed(this.snapshot);
    } catch {
      // Never log raw cache contents, paths, credentials, or vendor errors.
      if (this.snapshot && !this.disposed && revision === this.revision) {
        this.snapshot = { ...this.snapshot, stale: true };
        this.changed(this.snapshot);
      }
    }
  }
  start(): void {
    if (!this.file || this.disposed || this.watcher) return;
    void this.refresh();
    try {
      this.watcher = fs.watch(path.dirname(this.file), (_event, filename) => {
        if (filename && filename.toString() !== path.basename(this.file!)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.refresh(); }, 150);
        this.timer.unref();
      });
      this.watcher.unref();
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.log("[context] model catalog watcher unavailable; refresh on next send");
      });
    } catch { /* Missing directory: prompt refresh remains available. */ }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.watcher?.close();
  }
}
