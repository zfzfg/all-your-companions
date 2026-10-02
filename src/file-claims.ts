/**
 * Exclusive file claims for a crew run (AP-13, §6.4).
 *
 * A claim is one JSON file under `dir`, created with `wx`. The file name is a
 * hash of the checkout plus the normalized path, so `src/A.ts`, `./src/a.ts`
 * and `src/../src/a.ts` share a claim on a case-insensitive volume, and the
 * same relative path in two checkouts does not. The hash is not a directory
 * of `sha256` files; the old comment that said so was wrong.
 *
 * The same owner (run plus attempt, or run plus step when there is no
 * attempt) may claim again. That refreshes the lease. A sibling is a
 * different owner. A live lease is not taken just because `at` is old, so a
 * long question does not hand the file to someone else. Takeover of an
 * expired lease unlinks and then creates with `wx`, so two takers cannot
 * both win. A corrupt claim is left in place.
 *
 * I/O is injected. Time is injected. No vscode.
 */

export interface FileClaim {
  path: string;
  runId: string;
  step: number;
  role: string;
  at: number;
  /** Checkout or repository root this path is relative to. */
  checkout?: string;
  /** Worker or attempt. Same run, different attempt, is a different owner. */
  attemptId?: string;
  /** Absolute expiry. Absent claims use `at + staleMs`. */
  leaseUntil?: number;
}

export type ClaimResult =
  | { ok: true; idempotent?: boolean }
  | { ok: false; reason: "held"; heldBy: FileClaim }
  | { ok: false; reason: "corrupt" | "io"; message: string };

export interface ClaimFs {
  mkdirSync(p: string, opts: { recursive: true }): void;
  writeFileSync(p: string, data: string, opts: { encoding: "utf8"; flag?: string }): void;
  readFileSync(p: string, encoding: "utf8"): string;
  readdirSync(p: string): string[];
  existsSync(p: string): boolean;
  unlinkSync(p: string): void;
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
}

export interface FileClaimStoreOpts {
  /** `<globalStorage>/file-claims` */
  dir: string;
  fs: ClaimFs;
  now?: () => number;
  join?: (...parts: string[]) => string;
  /** Stale-claim TTL in ms. Default 2 hours. Also the lease length. */
  staleMs?: number;
  /**
   * Case folding. Default follows the host: Windows and macOS fold, Linux
   * does not. Tests pass this explicitly. Do not fold a case-sensitive volume.
   */
  caseSensitive?: boolean;
  /**
   * Resolve a path that already exists. A missing path (a file the worker is
   * about to create) stays on the logical normalization below. Throw or
   * return the input when the path is not there.
   */
  realpath?: (absolutePath: string) => string;
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/;

function defaultJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

function hostIsCaseSensitive(): boolean {
  return process.platform !== "win32" && process.platform !== "darwin";
}

/**
 * Logical path identity. `./`, `//` and `.` / `..` segments collapse. The
 * filesystem is not touched. Case folds only when asked.
 */
export function normalizeClaimPath(path: string, caseSensitive = hostIsCaseSensitive()): string {
  let raw = String(path ?? "").replace(/\\/g, "/").trim();
  raw = raw.replace(/^\.\/+/, "");
  const drive = /^[A-Za-z]:/.exec(raw);
  const absolute = raw.startsWith("/");
  const body = drive ? raw.slice(drive[0].length).replace(/^\/+/, "") : raw.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(caseSensitive ? segment : segment.toLowerCase());
  }
  const prefix = drive ? drive[0].toLowerCase() + "/" : absolute ? "/" : "";
  return prefix + parts.join("/");
}

/** Path → filename. Hex so `../` cannot escape the store. */
export function claimFileName(path: string, checkout = "", caseSensitive = hostIsCaseSensitive()): string {
  const id = `${normalizeClaimPath(checkout, caseSensitive)}\0${normalizeClaimPath(path, caseSensitive)}`;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash * 33) ^ id.charCodeAt(i)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  const slug = normalizeClaimPath(path, caseSensitive).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-24);
  return `${hex}${slug ? "-" + slug : ""}.json`;
}

function ownerKey(claim: Pick<FileClaim, "runId" | "step" | "attemptId">): string {
  return claim.attemptId ? `${claim.runId}#${claim.attemptId}` : `${claim.runId}#${claim.step}`;
}

function ioMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FileClaimStore {
  private readonly dir: string;
  private readonly fs: ClaimFs;
  private readonly now: () => number;
  private readonly join: (...parts: string[]) => string;
  private readonly staleMs: number;
  private readonly caseSensitive: boolean;
  private readonly realpath?: (absolutePath: string) => string;

  constructor(opts: FileClaimStoreOpts) {
    this.dir = opts.dir;
    this.fs = opts.fs;
    this.now = opts.now ?? (() => 0);
    this.join = opts.join ?? defaultJoin;
    this.staleMs = opts.staleMs ?? 2 * 60 * 60 * 1000;
    this.caseSensitive = opts.caseSensitive ?? hostIsCaseSensitive();
    this.realpath = opts.realpath;
  }

  private identity(claim: FileClaim): { path: string; checkout: string } {
    let path = normalizeClaimPath(claim.path, this.caseSensitive);
    const checkout = normalizeClaimPath(claim.checkout ?? "", this.caseSensitive);
    if (checkout && this.realpath) {
      const absolute = this.join(checkout, ...path.split("/").filter(Boolean));
      try {
        const resolved = normalizeClaimPath(this.realpath(absolute), this.caseSensitive);
        const prefix = checkout.endsWith("/") ? checkout : `${checkout}/`;
        if (resolved === checkout) path = "";
        else if (resolved.startsWith(prefix)) path = resolved.slice(prefix.length);
      } catch {
        /* a path that does not exist yet keeps the logical name */
      }
    }
    return { path, checkout };
  }

  private stamp(claim: FileClaim, identity: { path: string; checkout: string }): FileClaim {
    const at = claim.at || this.now();
    return {
      ...claim,
      path: identity.path,
      ...(identity.checkout ? { checkout: identity.checkout } : {}),
      at,
      leaseUntil: claim.leaseUntil && claim.leaseUntil > at ? claim.leaseUntil : at + this.staleMs,
    };
  }

  private leaseLive(held: FileClaim): boolean {
    const until = typeof held.leaseUntil === "number" ? held.leaseUntil : (held.at || 0) + this.staleMs;
    return this.now() < until;
  }

  private readHeld(file: string): { held: FileClaim } | { failure: ClaimResult } {
    let raw: string;
    try {
      raw = this.fs.readFileSync(file, "utf8");
    } catch (error) {
      return { failure: { ok: false, reason: "io", message: ioMessage(error) } };
    }
    try {
      const held = JSON.parse(raw) as FileClaim;
      if (!held || typeof held !== "object" || typeof held.runId !== "string" || !held.runId) {
        return { failure: { ok: false, reason: "corrupt", message: "claim file is not a claim" } };
      }
      return { held };
    } catch {
      return { failure: { ok: false, reason: "corrupt", message: "claim file is unreadable" } };
    }
  }

  tryClaim(claim: FileClaim): ClaimResult {
    let identity: { path: string; checkout: string };
    try {
      identity = this.identity(claim);
    } catch (error) {
      return { ok: false, reason: "io", message: ioMessage(error) };
    }
    const stored = this.stamp(claim, identity);
    const file = this.join(this.dir, claimFileName(identity.path, identity.checkout, this.caseSensitive));
    const body = JSON.stringify(stored);
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
      return { ok: true };
    } catch (error: any) {
      if (error?.code !== "EEXIST") return { ok: false, reason: "io", message: ioMessage(error) };
    }

    const existing = this.readHeld(file);
    if ("failure" in existing) return existing.failure;
    if (ownerKey(existing.held) === ownerKey(stored)) {
      try {
        this.fs.writeFileSync(file, body, { encoding: "utf8" });
        return { ok: true, idempotent: true };
      } catch (error) {
        return { ok: false, reason: "io", message: ioMessage(error) };
      }
    }
    if (this.leaseLive(existing.held)) return { ok: false, reason: "held", heldBy: existing.held };

    try {
      this.fs.unlinkSync(file);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return { ok: false, reason: "io", message: ioMessage(error) };
    }
    try {
      this.fs.writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
      return { ok: true };
    } catch (error: any) {
      if (error?.code !== "EEXIST") return { ok: false, reason: "io", message: ioMessage(error) };
      const winner = this.readHeld(file);
      if ("failure" in winner) return winner.failure;
      if (ownerKey(winner.held) === ownerKey(stored)) return { ok: true, idempotent: true };
      return { ok: false, reason: "held", heldBy: winner.held };
    }
  }

  /** Extend every live lease this run holds. A paused question calls this. */
  renewRun(runId: string): void {
    if (!SAFE.test(runId) || !this.fs.existsSync(this.dir)) return;
    let names: string[] = [];
    try { names = this.fs.readdirSync(this.dir); } catch { return; }
    const now = this.now();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = this.join(this.dir, name);
      const existing = this.readHeld(file);
      if ("failure" in existing || existing.held.runId !== runId) continue;
      if (!this.leaseLive(existing.held)) continue;
      try {
        this.fs.writeFileSync(file, JSON.stringify({ ...existing.held, leaseUntil: now + this.staleMs }), { encoding: "utf8" });
      } catch {
        /* a failed refresh leaves the old lease; it does not drop the claim */
      }
    }
  }

  /** Drop every claim this run holds. Safe to call twice. */
  releaseRun(runId: string): void {
    if (!SAFE.test(runId) || !this.fs.existsSync(this.dir)) return;
    let names: string[] = [];
    try { names = this.fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = this.join(this.dir, name);
      try {
        const held = JSON.parse(this.fs.readFileSync(file, "utf8")) as FileClaim;
        if (held.runId === runId) this.fs.unlinkSync(file);
      } catch {
        /* skip unreadable — release must not delete a claim it cannot identify */
      }
    }
  }
}
