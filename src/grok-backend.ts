import { isCredentialError } from "./acp-dispatch";
import type { AcpBackend, BackendConfigState, BackendSessionListResult, BackendSpawnOptions } from "./acp-backend";
import type { EffortLevel, PromptContentBlock } from "./acp";
import { grokCliNeedsShell } from "./cli-process";
import { compareVersionTuple, parseGrokVersion } from "./cli-locator";

/**
 * Oldest grok whose `_x.ai/interject` honors `content` (text + image blocks).
 * 0.2.x accepts `{sessionId, text}` and ignores unknown fields, so images
 * would drop silently — the host refuses image-bearing Steer instead.
 * Fail closed unless the version is live-verified. Inspected on 1.0.5
 * (`InterjectRequest.content` in `extensions/interject.rs`).
 */
export const GROK_INTERJECT_CONTENT_MIN_VERSION: [number, number, number] = [1, 0, 0];

/** True only for a live-verified grok that will apply interject `content`. */
export function cliHonorsInterjectContent(
  grokVersion?: string | null,
  versionVerified = false,
): boolean {
  if (!versionVerified) return false;
  const parsed = parseGrokVersion(grokVersion ?? "");
  if (!parsed) return false;
  return compareVersionTuple(parsed, GROK_INTERJECT_CONTENT_MIN_VERSION) >= 0;
}

/**
 * `_x.ai/interject` params. `content` is omitted entirely when there are no
 * image blocks so the legacy `{sessionId, text}` wire stays byte-identical
 * (the TUI does the same). The Text block, when present, is the rewritten
 * prompt (`buildPromptWithImages`) and wins over `text` on a capable CLI.
 */
export function buildInterjectParams(
  sessionId: string,
  text: string,
  content?: readonly PromptContentBlock[],
): { sessionId: string; text: string; content?: PromptContentBlock[] } {
  const params: { sessionId: string; text: string; content?: PromptContentBlock[] } = {
    sessionId,
    text,
  };
  if (content && content.some((block) => block.type === "image")) {
    params.content = [...content];
  }
  return params;
}

import { providerCapability } from "./provider-capabilities";

export function buildGrokAgentArgs(effort?: EffortLevel): string[] {
  return effort ? ["agent", "--reasoning-effort", effort, "stdio"] : ["agent", "stdio"];
}

export const grokBackend: AcpBackend = {
  provider: "grok",
  processName: "Grok process",
  usesClientPlanGate: providerCapability("grok", "clientPlanGate").state === "yes",
  spawn(options: BackendSpawnOptions) {
    return {
      command: options.cliPath,
      args: buildGrokAgentArgs(options.effort),
      env: options.env,
      shell: grokCliNeedsShell(options.cliPath),
    };
  },
  normalizeSessionResponse: (response) => response,
  normalizePromptResult: (result) => result,
  normalizeUpdate: (update, meta) => ({ update, meta }),
  normalizePermissionParams: (params) => params,
  setModel(sessionId, modelId, reasoningEffort) {
    return {
      method: "session/set_model",
      params: {
        sessionId,
        modelId,
        ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
      },
    };
  },
  setReasoningEffort(sessionId, modelId, level) {
    return level ? {
      method: "session/set_model",
      params: { sessionId, modelId, _meta: { reasoningEffort: level } },
    } : null;
  },
  setMode(sessionId, modeId) {
    return { method: "session/set_mode", params: { sessionId, modeId } };
  },
  // `_x.ai/interject` is unadvertised, so grok starts optimistic and the
  // client latches it off on -32601.
  steeringCapabilities(_initializeResult, options) {
    return {
      supported: true,
      acceptsContent: cliHonorsInterjectContent(options.grokVersion, options.grokVersionVerified),
    };
  },
  interject(sessionId, text, content) {
    return { method: "_x.ai/interject", params: buildInterjectParams(sessionId, text, content) };
  },
  // `_x.ai/interject` buffers the text and reports failure as an error, which
  // `interject` already rethrows; there is no in-band outcome to read.
  steerDelivered() { return true; },
  configState(_response, fallback: BackendConfigState) { return fallback; },
  modelSetSucceeded(response) { return !!response?._meta?.model?.Ok; },
  async listSessions(request, cwd): Promise<BackendSessionListResult> {
    return request("session/list", { cwd });
  },
  isCredentialError,
};
