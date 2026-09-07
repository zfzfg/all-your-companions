/**
 * Device-login — the RUNTIME half: everything that touches a process. The wire
 * types and text helpers are pure and live in
 * [device-login.ts](./device-login.ts).
 *
 * `runDeviceLogin` is a no-op handle: the relay-backed remote flow is gone with
 * the rest of the AFK Pilot surface, and the callers only need something that
 * cancels cleanly. `probeClaudeAuthStatus` is the one REAL implementation here —
 * it asks the locally installed Claude CLI whether it is signed in, which is a
 * local question with a local answer and therefore survives the purge.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { DeviceLoginCallbacks, DeviceLoginHandle } from "./device-login";

export function runDeviceLogin(
  _cliPath?: string,
  _args?: string[],
  _callbacks?: DeviceLoginCallbacks,
  ..._rest: any[]
): DeviceLoginHandle {
  return {
    cancel() {},
    submitCode(_code: string) {},
  };
}

/**
 * `claude auth status` → is this CLI signed in?
 *
 * `undefined` means "could not tell" (spawn failed) and must stay distinct from
 * `false` ("answered, not signed in") — the caller shows a different surface for
 * each. The 3s cap resolves `false` rather than hanging a sign-in check on a CLI
 * that never answers; `unref` keeps that timer from holding the host alive.
 */
export async function probeClaudeAuthStatus(cliPath: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    try {
      const child = nodeSpawn(cliPath, ["auth", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      child.stdout?.on("data", (c) => {
        out += String(c);
      });
      child.on("error", () => resolve(undefined));
      child.on("close", () => resolve(/"loggedIn":\s*true/.test(out)));
      setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve(false);
      }, 3000).unref?.();
    } catch {
      resolve(undefined);
    }
  });
}
