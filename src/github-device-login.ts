/**
 * GitHub device login — the browser-code flow `gh` uses to sign a machine in.
 *
 * Kept as a no-op alongside the rest of the removed remote surface: the local
 * GitHub path this fork actually uses is `gh auth` through
 * [github-auth.ts](./github-auth.ts), which owns `GITHUB_CLI_BIN` and
 * `isGithubCliMissing`. This module exists so the sidebar's remote sign-in
 * branches still resolve to a handle and a sentence instead of crashing.
 *
 * Shares its types with [device-login.ts](./device-login.ts) — one handle shape
 * for every login flow, so the sidebar's cancel path is provider-agnostic.
 */
import type { DeviceLoginCallbacks, DeviceLoginHandle } from "./device-login";

export function githubDeviceLoginFailureText(..._args: any[]): string {
  return "GitHub device login is disabled in standalone mode.";
}

export function runGithubDeviceLogin(
  _target?: any,
  _callbacks?: DeviceLoginCallbacks,
  ..._args: any[]
): DeviceLoginHandle {
  return {
    cancel() {},
    submitCode(_code: string) {},
  };
}
