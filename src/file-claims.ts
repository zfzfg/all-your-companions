/**
 * Exclusive file claims for a crew run (AP-13, §6.4).
 *
 * The claim IS the file: `claims/<runId>/<sha256(path)>.json` created with
 * `wx`. There is no leader. A second create gets `EEXIST` and becomes a
 * card, never a silent overwrite. The same pattern as `routine-store.ts`.
 *
 * A claim without a release path is worse than no claim — every exit (done,
 * failed, cancelled, process death) must drop the files this run created.
 * `releaseRun` deletes the run's claim directory; a crash leaves files that
 * the next claim of the same path treats as stale if `at` is older than the
 * injected TTL, so a dead holder cannot block the project forever.
 *
 * I/O is injected. Time is injected. No vscode.
 */

export interface FileClaim {
  path: string;
  runId: string;
  step: number;
  role: string;
  at: number;
}

export type ClaimResult = { ok: true } | { ok: false; heldBy: FileClaim };

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
  /** Stale-claim TTL in ms. Default 2 hours. */
  staleMs?: number;
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/;

function defaultJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/** Path → filename. Hex so `../` cannot escape the store. */
export function claimFileName(path: string): string {
  const raw = String(path ?? "").replace(/\\/g, "/");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  const slug = raw.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-24);
  return `${hex}${slug ? "-" + slug : ""}.json`;
}

export class FileClaimStore {
  private readonly dir: string;
  private readonly fs: ClaimFs;
  private readonly now: () => number;
  private readonly join: (...parts: string[]) => string;
  private readonly staleMs: number;

  constructor(opts: FileClaimStoreOpts) {
    this.dir = opts.dir;
    this.fs = opts.fs;
    this.now = opts.now ?? (() => 0);
    this.join = opts.join ?? defaultJoin;
    this.staleMs = opts.staleMs ?? 2 * 60 * 60 * 1000;
  }

  tryClaim(claim: FileClaim): ClaimResult {
    this.fs.mkdirSync(this.dir, { recursive: true });
    const file = this.join(this.dir, claimFileName(claim.path));
    const body = JSON.stringify({ ...claim, at: claim.at || this.now() });
    try {
      this.fs.writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
      return { ok: true };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let heldBy: FileClaim | undefined;
      try {
        heldBy = JSON.parse(this.fs.readFileSync(file, "utf8")) as FileClaim;
      } catch {
        /* unreadable holder — treat as stale and take over */
      }
      if (heldBy && this.now() - (heldBy.at || 0) < this.staleMs) {
        return { ok: false, heldBy };
      }
      this.fs.writeFileSync(file, body, { encoding: "utf8" });
      return { ok: true };
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
        /* skip unreadable */
      }
    }
  }
}
