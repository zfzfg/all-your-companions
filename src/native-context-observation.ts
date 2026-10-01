import type { ContextQuality, ContextRuntime, ContextUsageSemantics, ModelContextLimits } from "./context-budget";
import type { AcpProvider } from "./acp-backend";
import manifest from "../package.json";

export const CONTEXT_RUNTIMES: Record<AcpProvider, ContextRuntime> = {
  grok: { product: "grok-build", executable: "grok" },
  codex: { product: "codex", executable: "codex", adapterVersion: manifest.dependencies["@agentclientprotocol/codex-acp"] },
  claude: { product: "claude-code", executable: "claude", adapterVersion: manifest.dependencies["@agentclientprotocol/claude-agent-acp"] },
  gemini: { product: "antigravity", executable: "agy", adapterVersion: manifest.version },
  muse: { product: "muse-code", executable: "muse", adapterVersion: manifest.dependencies["@muse-code/sdk"] },
};

/** Provider-specific parsers supply semantics; arbitrary vendor fields never do. */
export interface NativeContextObservation {
  limits?: ModelContextLimits;
  limitQuality?: ContextQuality;
  used?: number;
  usageQuality?: ContextQuality;
  usageSemantics: ContextUsageSemantics;
  runtime?: ContextRuntime;
  /** Retained only during normalization; never sent to UI or persisted. */
  native?: unknown;
}
