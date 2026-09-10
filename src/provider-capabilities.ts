// Single source of truth for ACP provider capabilities (AP-01).
//
// Defines what each provider can do across 11 distinct capability dimensions.
// Every combination is set explicitly without fallback or default cells; each
// is documented with code or architectural references.
//
// Pure logic module adhering to Recipe R7: no vscode imports, no filesystem I/O.

import type { AcpProvider } from "./acp-backend";

export type ProviderCapability =
  | "steer"          // _x.ai/interject (mid-turn injection)
  | "rewind"         // _x.ai/rewind/* (conversation + fs rollback)
  | "fork"           // _x.ai/session/fork (branch conversation)
  | "worktree"       // isolated git worktree sessions (Grok RPC or local git, AP-13a)
  | "planMode"       // Plan mode availability
  | "clientPlanGate" // Client-side fs/terminal safety gate (vs adapter-enforced)
  | "vision"         // Multimodal image attachments in turns
  | "manualCompact"  // Manual /compact turn handling
  | "questionRpc"    // x.ai/ask_user_question (NOT the host-MCP server in AP-05)
  | "feedback"       // _x.ai/feedback (thumbs rating)
  | "subagents"      // Subagent delegation & lifecycle rail
  | "structuredPlan" // ACP `plan` update carries entries[], not prose (AP-02)
  | "hostMcp"        // Consumes host-supplied MCP servers via session/new (AP-16)
  | "companionSubagentTarget" // May be started as a companion subagent (AP-16)
  | "delegationShim"; // Needs the fenced-block delegation shim instead of host MCP (§6.4.4)

export type CapabilitySupport =
  | { state: "yes" }
  | { state: "no"; reason: string }
  | { state: "probe"; reason: string };

export const PROVIDER_CAPABILITY_NAMES: readonly ProviderCapability[] = [
  "steer",
  "rewind",
  "fork",
  "worktree",
  "planMode",
  "clientPlanGate",
  "vision",
  "manualCompact",
  "questionRpc",
  "feedback",
  "subagents",
  "structuredPlan",
  "hostMcp",
  "companionSubagentTarget",
  "delegationShim",
] as const;

/**
 * Static capability matrix for all providers.
 * Note: `planMode` for Grok is runtime-probed via CLI version, so the static
 * baseline is "probe".
 */
export const PROVIDER_CAPABILITIES: Record<
  AcpProvider,
  Record<ProviderCapability, CapabilitySupport>
> = {
  grok: {
    // Steer via _x.ai/interject (acp.ts:807, media/chat.js:4149, #52)
    steer: { state: "yes" },
    // Native `_x.ai/rewind/*` first; client checkpoints (AP-08) are the fallback.
    rewind: { state: "yes" },
    // Fork via _x.ai/session/fork (docs/architecture.md:56, file-upload.ts)
    fork: { state: "yes" },
    // Grok RPC `_x.ai/git/worktree/*` when a Grok session is live; local git
    // path otherwise (worktree-local.ts, AP-13a).
    worktree: { state: "yes" },
    // Plan mode for Grok is CLI version-dependent (>= 0.2.101 required)
    planMode: { state: "probe", reason: "Checking Plan mode availability…" },
    // Grok requires client-side fs and terminal execution gating (grok-backend.ts:13, plan-gate.ts:813)
    clientPlanGate: { state: "yes" },
    // Multimodal image input supported over ACP (prompt-builder.ts:151, chips.ts:29)
    vision: { state: "yes" },
    // Manual /compact via xAI session notifications (sidebar.ts:15589, slash-filter.ts:121)
    manualCompact: { state: "yes" },
    // Native question dialogs via x.ai/ask_user_question (acp-dispatch.ts:913, docs/architecture.md:60)
    questionRpc: { state: "yes" },
    // Thumbs feedback via _x.ai/feedback (acp.ts:846, media/chat.js:9865)
    feedback: { state: "yes" },
    // Subagent execution and lifecycle tracking (docs/architecture.md:1004, acp-dispatch.ts)
    subagents: { state: "yes" },
    // grok sends plan PROSE, never entries[] (plan-entries.ts head comment)
    structuredPlan: {
      state: "no",
      reason: "Grok reports plans as prose, not as a step list, so there is no checklist to read.",
    },
    // Host-supplied `mcpServers` on session/new are consumed and called
    // (research/mcp-shapes.md: grok routes them through search_tool/use_tool).
    hostMcp: { state: "yes" },
    // Any provider this host can start as a fresh session can be a child.
    companionSubagentTarget: { state: "yes" },
    // Not needed: the MCP channel works.
    delegationShim: { state: "no", reason: "Grok consumes host MCP servers, so the shim is unnecessary." },
  },
  codex: {
    // Steer not implemented by OpenAI Codex ACP adapter; answers -32601 (media/chat.js:4150)
    steer: {
      state: "no",
      reason: "Steer is not supported by Codex — your message will be sent after the turn.",
    },
    // Client-side file checkpoints + transcript truncate (AP-08). No native RPC.
    rewind: { state: "yes" },
    // Session fork not supported on Codex adapter (docs/architecture.md:56)
    fork: {
      state: "no",
      reason: "Forking conversations is not supported by Codex.",
    },
    // Local git path (worktree-local.ts). Grok RPC is used only when a Grok
    // session is already running — we never start Grok just to make a worktree.
    worktree: { state: "yes" },
    // Native collaboration / Plan mode supported by Codex ACP (docs/architecture.md:869, 977)
    planMode: { state: "yes" },
    // Codex manages edits and permissions natively; no client safety gate (codex-backend.ts:296)
    clientPlanGate: {
      state: "no",
      reason: "Codex enforces plans natively in the adapter (no client-side gate).",
    },
    // Multimodal prompt support in modern OpenAI models
    vision: { state: "yes" },
    // /compact supported by Codex ACP adapter (sidebar.ts:15594)
    manualCompact: { state: "yes" },
    // Codex does not implement x.ai/ask_user_question (docs/architecture.md:60)
    questionRpc: {
      state: "no",
      reason: "Interactive question cards via x.ai/ask_user_question are not supported by Codex.",
    },
    // Codex does not implement _x.ai/feedback (acp.ts:846, media/chat.js:9865)
    feedback: {
      state: "no",
      reason: "Thumbs feedback rating (_x.ai/feedback) is not supported by Codex.",
    },
    // Subagent delegation is not supported by Codex adapter (docs/architecture.md:1004)
    subagents: {
      state: "no",
      reason: "Subagent delegation is not supported by Codex.",
    },
    // Codex sends the entries[] shape of the ACP plan update (plan-entries.ts)
    structuredPlan: { state: "yes" },
    // Host-supplied `mcpServers` on session/new are consumed and called
    // (research/mcp-shapes.md: `_meta.is_mcp_tool_call`).
    hostMcp: { state: "yes" },
    companionSubagentTarget: { state: "yes" },
    delegationShim: { state: "no", reason: "Codex consumes host MCP servers, so the shim is unnecessary." },
  },
  claude: {
    // Claude Code has no interjection RPC; queued send is used instead (media/chat.js:4151)
    steer: {
      state: "no",
      reason: "Steer is not supported by Claude — your message will be sent after the turn.",
    },
    // Client-side file checkpoints + transcript truncate (AP-08). No native RPC.
    rewind: { state: "yes" },
    // Session fork not supported by Claude adapter (docs/architecture.md:56)
    fork: {
      state: "no",
      reason: "Forking conversations is not supported by Claude.",
    },
    // Local git path (worktree-local.ts). Grok RPC is used only when a Grok
    // session is already running — we never start Grok just to make a worktree.
    worktree: { state: "yes" },
    // Native Plan mode supported by Claude Code (docs/architecture.md:869, 977)
    planMode: { state: "yes" },
    // Claude manages plan enforcement in the adapter (claude-backend.ts:422)
    clientPlanGate: {
      state: "no",
      reason: "Claude enforces plans natively in the adapter (no client-side gate).",
    },
    // Multimodal prompt support in Claude Code
    vision: { state: "yes" },
    // /compact passed through to Claude Code CLI (sidebar.ts:15594)
    manualCompact: { state: "yes" },
    // Claude does not implement x.ai/ask_user_question (docs/architecture.md:60)
    questionRpc: {
      state: "no",
      reason: "Interactive question cards via x.ai/ask_user_question are not supported by Claude.",
    },
    // Claude does not implement _x.ai/feedback (acp.ts:846, media/chat.js:9865)
    feedback: {
      state: "no",
      reason: "Thumbs feedback rating (_x.ai/feedback) is not supported by Claude.",
    },
    // Subagent delegation is not supported by Claude adapter (docs/architecture.md:1004)
    subagents: {
      state: "no",
      reason: "Subagent delegation is not supported by Claude.",
    },
    // Claude sends the entries[] shape of the ACP plan update (plan-entries.ts)
    structuredPlan: { state: "yes" },
    // Host-supplied `mcpServers` on session/new are consumed and called
    // (research/mcp-shapes.md: `mcp__<server>__<tool>`), and AP-05 ask_user
    // already rides this path in production.
    hostMcp: { state: "yes" },
    companionSubagentTarget: { state: "yes" },
    delegationShim: { state: "no", reason: "Claude consumes host MCP servers, so the shim is unnecessary." },
  },
  gemini: {
    // Steer not supported by Gemini / Antigravity (media/chat.js:4158)
    steer: {
      state: "no",
      reason: "Steer is not supported by Gemini — your message will be sent after the turn.",
    },
    // Client-side file checkpoints + transcript truncate (AP-08). No native RPC.
    rewind: { state: "yes" },
    // Session fork not supported by Gemini adapter (docs/architecture.md:56)
    fork: {
      state: "no",
      reason: "Forking conversations is not supported by Gemini.",
    },
    // Local git path (worktree-local.ts). Grok RPC is used only when a Grok
    // session is already running — we never start Grok just to make a worktree.
    worktree: { state: "yes" },
    // Native Plan mode supported by Gemini / Antigravity (sidebar.ts:9414)
    planMode: { state: "yes" },
    // Gemini manages execution and permissions in the adapter (gemini-backend.ts:434)
    clientPlanGate: {
      state: "no",
      reason: "Gemini enforces plans natively in the adapter (no client-side gate).",
    },
    // Antigravity stages images to disk and prompts inspection (agy-acp-adapter.ts:1143-1211)
    vision: { state: "yes" },
    // Antigravity automatically handles compaction in background (sidebar.ts:15575-15579)
    manualCompact: {
      state: "no",
      reason: "Antigravity manages and compacts context automatically in the background (no manual /compact needed).",
    },
    // Gemini does not implement x.ai/ask_user_question (docs/architecture.md:60)
    questionRpc: {
      state: "no",
      reason: "Interactive question cards via x.ai/ask_user_question are not supported by Gemini.",
    },
    // Gemini does not implement _x.ai/feedback (acp.ts:846, media/chat.js:9865)
    feedback: {
      state: "no",
      reason: "Thumbs feedback rating (_x.ai/feedback) is not supported by Gemini.",
    },
    // Subagent delegation is not supported by Gemini adapter (docs/architecture.md:1004)
    subagents: {
      state: "no",
      reason: "Subagent delegation is not supported by Gemini.",
    },
    // One provider id, two CLIs: Gemini CLI sends entries[], Antigravity sends
    // prose (plan-entries.ts head comment). Resolved at runtime by whether a
    // list has actually arrived; unresolved it stays a probe, because the
    // wrong guess here writes a false sentence into every derived briefing.
    structuredPlan: {
      state: "probe",
      reason: "Gemini CLI reports a step list; Antigravity reports plans as prose.",
    },
    // Not covered by research/mcp-shapes.md (that probe ran grok/codex/claude
    // only). Antigravity and Gemini CLI share this provider id and may differ,
    // so the cell stays a probe until `research/probe-acp-mcp.cjs gemini` has
    // run on this machine. A probe cell is spawnable (§6.3 rule 3 refuses only
    // "no") but does not get the host `companions` server until it is proven.
    hostMcp: {
      state: "probe",
      reason: "Whether Antigravity consumes host MCP servers over ACP is unprobed — run research/probe-acp-mcp.cjs gemini.",
    },
    companionSubagentTarget: { state: "yes" },
    delegationShim: {
      state: "probe",
      reason: "Depends on the hostMcp probe: the shim is only needed if host MCP servers are not consumed.",
    },
  },
};

/** Runtime facts that can resolve probe-dependent capabilities. */
export interface RuntimeCapabilityContext {
  planModeAvailable?: boolean;
  cliVerified?: boolean;
  planModeUnavailableReason?: string;
  /**
   * This session has received at least one `plan` update carrying entries.
   *
   * Positive evidence only, and that asymmetry is the point: having seen a
   * list proves the protocol; not having seen one proves nothing, because a
   * session may simply not have planned yet.
   */
  sawPlanEntries?: boolean;
}

/**
 * Returns whether a provider supports a specific capability, taking optional
 * runtime observations into account.
 */
export function providerCapability(
  provider: AcpProvider,
  cap: ProviderCapability,
  runtime?: RuntimeCapabilityContext,
): CapabilitySupport {
  const providerMatrix = PROVIDER_CAPABILITIES[provider];
  if (!providerMatrix) {
    return { state: "no", reason: `Unknown provider '${String(provider)}'.` };
  }

  const baseSupport = providerMatrix[cap];
  if (!baseSupport) {
    return { state: "no", reason: `Unknown capability '${String(cap)}'.` };
  }

  // Handle runtime overlay for planMode (especially Grok CLI version probing)
  if (cap === "planMode" && provider === "grok" && runtime) {
    if (runtime.planModeAvailable === true) {
      return { state: "yes" };
    }
    if (runtime.planModeAvailable === false) {
      const reason =
        runtime.planModeUnavailableReason ||
        (runtime.cliVerified
          ? "Grok CLI is below the required version for Plan mode."
          : "Grok CLI version could not be verified.");
      return { state: "no", reason };
    }
    return { state: "probe", reason: "Checking Plan mode availability…" };
  }

  // `gemini` is one provider id over two CLIs that differ here (Gemini CLI
  // sends entries, Antigravity sends prose), so the static cell cannot answer.
  // One list actually seen settles it; nothing seen leaves it a probe rather
  // than guessing, because "has not planned yet" and "cannot report a plan"
  // call for different briefings.
  if (cap === "structuredPlan" && provider === "gemini" && runtime?.sawPlanEntries === true) {
    return { state: "yes" };
  }

  return baseSupport;
}

/**
 * Returns the full capability snapshot for a provider.
 */
export function allProviderCapabilities(
  provider: AcpProvider,
  runtime?: RuntimeCapabilityContext,
): Record<ProviderCapability, CapabilitySupport> {
  const result = {} as Record<ProviderCapability, CapabilitySupport>;
  for (const cap of PROVIDER_CAPABILITY_NAMES) {
    result[cap] = providerCapability(provider, cap, runtime);
  }
  return result;
}
