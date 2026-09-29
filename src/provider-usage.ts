import type { AcpProvider } from "./acp-backend";

export interface ProviderUsagePolicy {
  readonly source: "rpc" | "codex-file" | "updates" | "none";
  readonly cache: "shared" | "session";
}
/** Claude observations belong to one live process; Grok/Codex are account-wide. */
export const PROVIDER_USAGE: Record<AcpProvider, ProviderUsagePolicy> = {
  grok: { source: "rpc", cache: "shared" },
  codex: { source: "codex-file", cache: "shared" },
  claude: { source: "updates", cache: "session" },
  gemini: { source: "none", cache: "session" },
  muse: { source: "none", cache: "session" },
};
