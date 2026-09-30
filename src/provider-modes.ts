import type { AcpProvider } from "./acp-backend";

export type HostMode = "agent" | "yolo" | "plan";

/** Backend mode IDs, including Codex's required collaboration reset. */
const MODES: Record<AcpProvider, Record<HostMode, readonly string[]>> = {
  grok: { agent: ["default"], yolo: ["default"], plan: ["plan"] },
  codex: { agent: ["default", "agent"], yolo: ["default", "agent-full-access"], plan: ["plan"] },
  claude: { agent: ["agent"], yolo: ["yolo"], plan: ["plan"] },
  gemini: { agent: ["agent"], yolo: ["yolo"], plan: ["plan"] },
  muse: { agent: [], yolo: [], plan: [] },
};

export function hostModeSequence(provider: AcpProvider, mode: HostMode): readonly string[] {
  return MODES[provider][mode];
}

/** Allows injected RPC facades to exercise the same backend sequence. */
export async function applyHostMode(
  client: { setMode(mode: string): Promise<void>; setHostMode?(mode: HostMode): Promise<void> },
  provider: AcpProvider,
  mode: HostMode,
): Promise<void> {
  if (client.setHostMode) return client.setHostMode(mode);
  for (const step of hostModeSequence(provider, mode)) await client.setMode(step);
}

/** Grok native Plan instructions own planning; tools use YOLO approval. */
export function autoApproveNativePlanTools(provider: AcpProvider): boolean {
  return provider === "grok";
}
