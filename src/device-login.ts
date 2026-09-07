/**
 * Device-login — the PURE half: wire types plus the user-facing text and plan
 * helpers. No process spawning, no I/O; the runtime lives in
 * [device-login-run.ts](./device-login-run.ts) and the GitHub-specific flow in
 * [github-device-login.ts](./github-device-login.ts).
 *
 * All your Companions is strictly local-first: the relay-backed remote device
 * login (AFK Pilot) is gone, so every helper here answers with the standalone
 * refusal rather than starting a flow. They stay as functions — not as deleted
 * symbols — because the sidebar's sign-in surfaces still ask for the text to
 * show, and a missing function would be a crash where a sentence belongs.
 */

/** Cancellation/handoff handle a login flow returns to its caller. */
export interface DeviceLoginHandle {
  cancel(): void;
  submitCode(code: string): void;
}

/** What a provider asks the user to do (open a URL, type a code). */
export interface DeviceLoginPrompt {
  url?: string;
  code?: string;
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  interval?: number;
  needsCode?: boolean;
}

export interface DeviceLoginResult {
  ok: boolean;
  cancelled?: boolean;
  failure?: any;
  output: string;
  setupGit?: boolean;
}

export interface DeviceLoginCallbacks {
  onPrompt?: (prompt: DeviceLoginPrompt) => void;
  onDone?: (result: DeviceLoginResult) => void;
}

export function deviceLoginFailureText(..._args: any[]): string {
  return "Device login is disabled in standalone mode.";
}

export function deviceLoginPlan(..._args: any[]): any {
  return undefined;
}

export function deviceLoginPreflight(..._args: any[]): any {
  return undefined;
}

export function deviceLoginCodeNote(..._args: any[]): string {
  return "";
}

export function noRemoteSignInMessage(..._args: any[]): string {
  return "Remote sign-in disabled in this standalone build.";
}

export function deviceLoginUnavailable(..._args: any[]): string | undefined {
  return "Device login is disabled in standalone mode.";
}
