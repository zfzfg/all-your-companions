import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, type ModelInfo } from "./acp";
import { CodexBackend, type CodexBackendOptions } from "./codex-backend";

export interface WarmCodexModelCacheOptions {
  cliPath: string;
  onModels: (models: readonly ModelInfo[], currentModelId?: string) => void | PromiseLike<void>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  backend?: CodexBackendOptions;
  /** Where to retry when Codex refuses the scratch directory. The workspace, in
   *  practice — the same cwd a real session uses. */
  fallbackCwd?: string;
}

async function readModelsIn(cwd: string, options: WarmCodexModelCacheOptions): Promise<void> {
  const client = new AcpClient({
    cliPath: options.cliPath,
    cwd,
    env: options.env ?? { ...process.env },
    backend: new CodexBackend(options.backend),
    log: options.log ?? (() => {}),
  });
  try {
    await client.start();
    const created = await client.newSession();
    await options.onModels(client.availableModels, client.currentModelId);
    try {
      await client.deleteSession(created.sessionId);
    } catch (error) {
      // codex 0.147 answers session/delete with "Internal error: no rollout
      // found for thread id …" for a throwaway that never wrote one. The
      // models are already delivered by this point — hygiene must not fail
      // the warm-up. It did: this doubles as the post-login credential probe,
      // so a perfectly valid sign-in read as "no usable credential". Nothing
      // rolled out also means there is nothing to clean.
      options.log?.(`[codex] throwaway session cleanup failed (${(error as Error).message}); models already cached, continuing`);
    }
  } finally {
    await client.dispose();
  }
}

/**
 * Read Codex's advertised models by opening one throwaway session.
 *
 * A scratch directory is tried first, because this session exists only to be
 * asked a question and should not appear in the user's project. But Codex can
 * refuse a bare temp directory outright — observed on Windows as
 * `session/new` answering "Internal error", with the adapter exiting 0 seconds
 * later. When that happened the cache stayed empty forever, so a newly
 * connected Codex never appeared in the model picker, while a real session in
 * the workspace worked fine.
 *
 * So: fall back to the workspace, which is the same cwd a real session uses and
 * is therefore known to be acceptable. The throwaway session is still deleted
 * through ACP either way.
 */
export async function warmCodexModelCache(options: WarmCodexModelCacheOptions): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "grok-codex-models-"));
  try {
    await readModelsIn(scratch, options);
    return;
  } catch (error) {
    if (!options.fallbackCwd) throw error;
    options.log?.(
      `[codex] model-cache warm-up in a scratch dir failed (${(error as Error).message}); retrying in the workspace`,
    );
  } finally {
    // Best effort, and never fatal. The adapter process can still hold this
    // directory for a moment after it answers, so Windows throws EBUSY on
    // rmdir — and thrown from a `finally` that beat the retry line, it replaced
    // the retry with its own failure. A leftover temp directory is harmless;
    // losing the model cache over one is not.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (cleanup) {
      options.log?.(`[codex] left a scratch dir behind: ${(cleanup as Error).message}`);
    }
  }
  await readModelsIn(options.fallbackCwd, options);
}
