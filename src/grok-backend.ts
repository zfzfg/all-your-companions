import { isCredentialError } from "./acp-dispatch";
import type { AcpBackend, BackendConfigState, BackendSessionListResult, BackendSpawnOptions } from "./acp-backend";
import type { EffortLevel } from "./acp";
import { grokCliNeedsShell } from "./cli-process";

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
  configState(_response, fallback: BackendConfigState) { return fallback; },
  modelSetSucceeded(response) { return !!response?._meta?.model?.Ok; },
  async listSessions(request, cwd): Promise<BackendSessionListResult> {
    return request("session/list", { cwd });
  },
  isCredentialError,
};
