/**
 * All your Companions — Remote Control & Device-Login Stub / Compatibility Layer
 *
 * All your Companions is strictly local-first and privacy-focused.
 * External relay connections (AFK Pilot / wss://relay.grok-build.com)
 * and remote headless device login flows have been removed.
 *
 * This module provides clean, no-op stub implementations for internal
 * compatibility with the UI event loop without any external network dependencies.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Session } from "./session";

export const CLOUD_ENVIRONMENT_ENV = "GROK_CLOUD_ENVIRONMENT";
export const RELAY_DEVICE_TOKEN_SECRET = "grok.remote.deviceToken";

export type MsgOrigin = "local" | "remote";

export * from "./remote-policy";

export interface MediaInlineDeps {
  registerFullImage: (p: string) => string | undefined;
  thumbnailCache: Map<string, string | null>;
  readFile: (p: string) => Buffer | null;
  toBase64: (bytes: Buffer | Uint8Array) => string;
  thumbnail: (bytes: Buffer | Uint8Array, mimeType: string, maxDimension: number) => { bytes: Buffer | Uint8Array; mime: string } | null;
  mtimeMs: (p: string) => number | undefined;
  [key: string]: any;
}

export class RemoteUplink {
  dispose(): void {}
  setWorking(_working: boolean): void {}
  broadcastTo(_clientIds: string[], _msg: any, _scopeCwd?: string): void {}
}

export function serializesRemoteSessionTransition(type: string): boolean {
  return type === "newSession" || type === "resumeSession" || type === "selectRepo";
}

export class RemoteClientState<T = Session, C = any> {
  private readonly cwdByClient = new Map<string, string>();
  private readonly activeByClient = new Map<string, T>();
  private readonly metadataByClient = new Map<string, C>();
  private readonly tailsByClient = new Map<string, Promise<void>>();
  private readonly tabTokenByClient = new Map<string, string>();
  private readonly clientByTabToken = new Map<string, string>();
  private readonly explicitSessionByClient = new Set<string>();
  private readonly supersededSessionIdByClient = new Map<string, string>();
  private readonly detachedByTabToken = new Map<string, {
    cwd: string;
    active?: T;
    metadata?: C;
    requiresExplicitSession?: boolean;
    supersededSessionId?: string;
  }>();

  constructor(
    private readonly defaultCwd: string = "",
    private readonly normalize: (cwd: string) => string = (cwd) => cwd,
  ) {}

  get size(): number {
    return this.cwdByClient.size;
  }

  get(id: string): any {
    return this.activeByClient.get(id);
  }

  set(id: string, val: any): this {
    this.activeByClient.set(id, val);
    return this;
  }

  delete(id: string): boolean {
    return this.activeByClient.delete(id);
  }

  has(id: string): boolean {
    return this.cwdByClient.has(id);
  }

  values(): IterableIterator<any> {
    return this.activeByClient.values();
  }

  keys(): IterableIterator<string> {
    return this.cwdByClient.keys();
  }

  [Symbol.iterator](): IterableIterator<[string, any]> {
    return this.activeByClient[Symbol.iterator]();
  }

  ready(clientId: string): string {
    const existing = this.cwdByClient.get(clientId);
    if (existing) return existing;
    const cwd = this.defaultCwd;
    this.cwdByClient.set(clientId, cwd);
    return cwd;
  }

  identify(clientId: string, tabToken: string): string | undefined {
    const priorClientId = this.clientByTabToken.get(tabToken);
    const priorToken = this.tabTokenByClient.get(clientId);
    if (priorToken && priorToken !== tabToken && this.clientByTabToken.get(priorToken) === clientId) {
      this.clientByTabToken.delete(priorToken);
    }
    this.tabTokenByClient.set(clientId, tabToken);
    this.clientByTabToken.set(tabToken, clientId);
    if (!priorClientId || priorClientId === clientId) {
      const detached = this.detachedByTabToken.get(tabToken);
      if (detached) {
        this.detachedByTabToken.delete(tabToken);
        this.cwdByClient.set(clientId, detached.cwd);
        const takenByAnother = detached.active !== undefined
          && [...this.activeByClient].some(([other, value]) => other !== clientId && value === detached.active);
        if (detached.active !== undefined && !takenByAnother) {
          this.activeByClient.set(clientId, detached.active);
        }
        if (detached.metadata !== undefined) this.metadataByClient.set(clientId, detached.metadata);
        this.restoreExplicitSession(clientId, detached.requiresExplicitSession, detached.supersededSessionId);
      }
      return undefined;
    }

    const cwd = this.cwdByClient.get(priorClientId);
    const active = this.activeByClient.get(priorClientId);
    const metadata = this.metadataByClient.get(priorClientId);
    const requiresExplicitSession = this.explicitSessionByClient.has(priorClientId);
    const supersededSessionId = this.supersededSessionIdByClient.get(priorClientId);
    this.cwdByClient.delete(priorClientId);
    this.activeByClient.delete(priorClientId);
    this.metadataByClient.delete(priorClientId);
    this.clearRequiresExplicitSession(priorClientId);
    if (cwd) this.cwdByClient.set(clientId, cwd);
    if (active !== undefined) this.activeByClient.set(clientId, active);
    if (metadata !== undefined) this.metadataByClient.set(clientId, metadata);
    this.restoreExplicitSession(clientId, requiresExplicitSession, supersededSessionId);
    return priorClientId;
  }

  isCurrent(clientId: string): boolean {
    const token = this.tabTokenByClient.get(clientId);
    return !token || this.clientByTabToken.get(token) === clientId;
  }

  tabToken(clientId: string): string | undefined {
    return this.tabTokenByClient.get(clientId);
  }

  clientForTabToken(tabToken: string): string | undefined {
    return this.clientByTabToken.get(tabToken);
  }

  private sessionTransitionKey(clientId: string): string {
    const tabToken = this.tabTokenByClient.get(clientId);
    return tabToken ? `tab:${tabToken}` : `client:${clientId}`;
  }

  currentClient(clientId: string): string | undefined {
    const tabToken = this.tabTokenByClient.get(clientId);
    const current = tabToken ? this.clientByTabToken.get(tabToken) : clientId;
    return current && this.cwdByClient.has(current) ? current : undefined;
  }

  cwd(clientId: string): string {
    const cwd = this.cwdByClient.get(clientId);
    if (!cwd) throw new Error(`Remote client ${clientId} is not ready`);
    return cwd;
  }

  cwdIfPresent(clientId: string): string | undefined {
    return this.cwdByClient.get(clientId);
  }

  select(clientId: string, cwd: string): string {
    if (!this.cwdByClient.has(clientId)) {
      throw new Error(`Remote client ${clientId} is not ready`);
    }
    const selected = cwd || this.defaultCwd;
    const previous = this.cwdByClient.get(clientId);
    this.cwdByClient.set(clientId, selected);
    if (previous && this.normalize(previous) !== this.normalize(selected)) {
      this.activeByClient.delete(clientId);
    }
    return selected;
  }

  clientsForCwd(cwd: string): string[] {
    const key = this.normalize(cwd);
    return [...this.cwdByClient]
      .filter(([, selected]) => this.normalize(selected) === key)
      .map(([clientId]) => clientId);
  }

  clients(): string[] {
    return [...this.cwdByClient.keys()];
  }

  retainClients(clientIds: Iterable<string>): string[] {
    const keep = new Set(clientIds);
    const removed: string[] = [];
    const known = new Set([...this.cwdByClient.keys(), ...this.tabTokenByClient.keys()]);
    for (const clientId of known) {
      if (keep.has(clientId)) continue;
      this.deleteClient(clientId);
      removed.push(clientId);
    }
    return removed;
  }

  setActive(clientId: string, value: T): void {
    if (!this.cwdByClient.has(clientId)) {
      throw new Error(`Remote client ${clientId} is not ready`);
    }
    this.activeByClient.set(clientId, value);
    this.clearRequiresExplicitSession(clientId);
  }

  markRequiresExplicitSession(clientId: string, sessionId?: string): void {
    if (!this.cwdByClient.has(clientId)) return;
    this.explicitSessionByClient.add(clientId);
    if (sessionId) this.supersededSessionIdByClient.set(clientId, sessionId);
  }

  requiresExplicitSession(clientId: string): boolean {
    return this.explicitSessionByClient.has(clientId);
  }

  supersededSessionId(clientId: string): string | undefined {
    return this.supersededSessionIdByClient.get(clientId);
  }

  clearRequiresExplicitSession(clientId: string): void {
    this.explicitSessionByClient.delete(clientId);
    this.supersededSessionIdByClient.delete(clientId);
  }

  private restoreExplicitSession(
    clientId: string,
    requiresExplicitSession?: boolean,
    supersededSessionId?: string,
  ): void {
    if (!requiresExplicitSession) {
      this.clearRequiresExplicitSession(clientId);
      return;
    }
    this.explicitSessionByClient.add(clientId);
    if (supersededSessionId) this.supersededSessionIdByClient.set(clientId, supersededSessionId);
    else this.supersededSessionIdByClient.delete(clientId);
  }

  active(clientId: string): T | undefined {
    return this.activeByClient.get(clientId);
  }

  setMetadata(clientId: string, value: C): void {
    if (!this.cwdByClient.has(clientId)) {
      throw new Error(`Remote client ${clientId} is not ready`);
    }
    this.metadataByClient.set(clientId, value);
  }

  metadata(clientId: string): C | undefined {
    return this.metadataByClient.get(clientId);
  }

  deleteActive(clientId: string, value?: T): void {
    if (value === undefined || this.activeByClient.get(clientId) === value) {
      this.activeByClient.delete(clientId);
    }
  }

  deleteActiveValue(value: T): void {
    for (const [clientId, active] of this.activeByClient) {
      if (active === value) this.activeByClient.delete(clientId);
    }
  }

  replaceDetachedActiveWhere(
    predicate: (value: T) => boolean,
    replace: (cwd: string, value: T) => T,
  ): T[] {
    const removed: T[] = [];
    for (const detached of this.detachedByTabToken.values()) {
      if (detached.active === undefined || !predicate(detached.active)) continue;
      const previous = detached.active;
      detached.active = replace(detached.cwd, previous);
      removed.push(previous);
    }
    return removed;
  }

  detachedActiveValues(): T[] {
    return [...this.detachedByTabToken.values()]
      .flatMap((detached) => detached.active === undefined ? [] : [detached.active]);
  }

  clientsForActiveValue(value: T): string[] {
    return [...this.activeByClient]
      .filter(([, active]) => active === value)
      .map(([clientId]) => clientId);
  }

  isActiveValueVisible(value: T): boolean {
    return this.clientsForActiveValue(value).length > 0;
  }

  runExclusive<R>(clientId: string, action: () => Promise<R>): Promise<R> {
    const previous = this.tailsByClient.get(clientId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    this.tailsByClient.set(clientId, tail);
    return run.finally(() => {
      if (this.tailsByClient.get(clientId) === tail) this.tailsByClient.delete(clientId);
    });
  }

  runSessionOperation<R>(clientId: string, type: string, action: () => Promise<R>): Promise<R> {
    return serializesRemoteSessionTransition(type)
      ? this.runExclusive(clientId, action)
      : action();
  }

  runSessionTransition<R>(
    clientId: string,
    sessionId: string | undefined,
    action: (currentClientId: string) => Promise<R>,
  ): Promise<R | undefined> {
    const tabToken = this.tabTokenByClient.get(clientId);
    const runForCurrentOwner = () => {
      const currentClientId = tabToken
        ? this.clientByTabToken.get(tabToken)
        : this.currentClient(clientId);
      if (!currentClientId || !this.cwdByClient.has(currentClientId)) {
        return Promise.resolve(undefined);
      }
      return action(currentClientId);
    };
    return this.runExclusive(this.sessionTransitionKey(clientId), () =>
      sessionId
        ? this.runExclusive(`session:${sessionId}`, runForCurrentOwner)
        : runForCurrentOwner(),
    );
  }

  async runAfterSessionTransition<R>(
    clientId: string,
    action: (currentClientId: string) => Promise<R>,
  ): Promise<R | undefined> {
    const tabToken = this.tabTokenByClient.get(clientId);
    const transition = this.tailsByClient.get(this.sessionTransitionKey(clientId));
    if (transition) await transition;
    const currentClientId = tabToken
      ? this.clientByTabToken.get(tabToken)
      : this.currentClient(clientId);
    if (!currentClientId || !this.cwdByClient.has(currentClientId)) return undefined;
    return action(currentClientId);
  }

  deleteClient(clientId: string): void {
    this.cwdByClient.delete(clientId);
    this.activeByClient.delete(clientId);
    this.metadataByClient.delete(clientId);
    this.clearRequiresExplicitSession(clientId);
    this.tailsByClient.delete(clientId);
    this.tailsByClient.delete(`client:${clientId}`);
    const token = this.tabTokenByClient.get(clientId);
    this.tabTokenByClient.delete(clientId);
    if (token && this.clientByTabToken.get(token) === clientId) {
      this.clientByTabToken.delete(token);
    }
  }

  detachClient(clientId: string): void {
    const token = this.tabTokenByClient.get(clientId);
    const cwd = this.cwdByClient.get(clientId);
    const active = this.activeByClient.get(clientId);
    const metadata = this.metadataByClient.get(clientId);
    if (token && cwd && this.clientByTabToken.get(token) === clientId) {
      this.detachedByTabToken.set(token, {
        cwd,
        active,
        metadata,
        requiresExplicitSession: this.explicitSessionByClient.has(clientId),
        supersededSessionId: this.supersededSessionIdByClient.get(clientId),
      });
    }
    this.deleteClient(clientId);
  }

  clear(): void {
    this.cwdByClient.clear();
    this.activeByClient.clear();
    this.metadataByClient.clear();
    this.tailsByClient.clear();
    this.tabTokenByClient.clear();
    this.clientByTabToken.clear();
    this.explicitSessionByClient.clear();
    this.supersededSessionIdByClient.clear();
    this.detachedByTabToken.clear();
  }
}

export class RemotePcmIngress {
  constructor(..._args: any[]) {}
  ready(): Uint8Array[] {
    return [];
  }
  restarting(): boolean {
    return false;
  }
  close(): void {}
}

export function acceptRemotePcm(..._args: any[]): any {
  return { kind: "voice", bytes: new Uint8Array() };
}


export function listRemoteProjectDir(..._args: any[]): { ok: true; entries: any[]; truncated: boolean } | { ok: false; reason: string } {
  return { ok: false, reason: "Remote files disabled" };
}

export function projectFileContentForWire(..._args: any[]):
  | {
      ok: true;
      reason?: string;
      relPath: string;
      kind: "image" | "text" | "markdown" | "json";
      text?: string;
      dataUrl?: string;
      pretty?: boolean;
      reformatted?: boolean;
      stamp?: { mtimeMs: number; size: number };
      absPath?: string;
    }
  | {
      ok: false;
      reason: string;
    } {
  return {
    ok: false,
    reason: "Remote files disabled",
  };
}

export function readRemoteProjectFile(..._args: any[]): {
  ok: boolean;
  reason?: string;
  relPath?: string;
  kind?: string;
  text?: string;
  dataUrl?: string;
  pretty?: string;
  reformatted?: string;
  stamp?: string;
  absPath?: string;
} {
  return { ok: false, reason: "Remote files disabled" };
}

export function resolveRemoteFileRoot(_opts?: {
  origin?: any;
  claimedCwd?: any;
  selectedCwd?: any;
  workspaceRoot?: any;
  isKnownCwd?: (cwd: string) => boolean;
  sameCwd?: (a: string, b: string) => boolean;
}): { ok: true; root: string } | { ok: false; reason: string } {
  return { ok: false, reason: "Remote files disabled" };
}

export function writeRemoteProjectFile(..._args: any[]): {
  ok: boolean;
  reason: string;
  relPath: string;
  stamp: { mtimeMs: number; size: number };
} {
  return {
    ok: false,
    reason: "Remote files disabled",
    relPath: "",
    stamp: { mtimeMs: 0, size: 0 },
  };
}

export function isCloudEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLOUD_ENVIRONMENT_ENV] === "1";
}

export function buildLinkStartBody(..._args: any[]): any {
  return { type: "linkStart" };
}

export function deviceDisplayName(..._args: any[]): string {
  return "Local Desk";
}

export function httpBaseFromRelayUrl(url: string): string {
  return url;
}

export function parseRelayFrame(_raw: any): any {
  return undefined;
}

export function resolveRelayUrl(..._args: any[]): string {
  return "";
}

export interface DeviceLoginHandle {
  cancel(): void;
  submitCode(code: string): void;
}

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
