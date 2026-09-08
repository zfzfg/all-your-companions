/**
 * On-disk checkpoint store (AP-08).
 *
 * Layout: `<globalStorage>/checkpoints/<sessionId>/<turnId>/`
 *   meta.json     — Checkpoint without blobs (hashes, skipped, flags)
 *   blobs/<sha256> — exact file bytes, content-addressed
 *
 * Retention (20 turns or 200 MB per session) runs on write, never as a
 * background job. A failed step never throws to the caller: the host
 * disables that turn's checkpoint and the turn continues.
 *
 * Recipe R4: own files, not PersistedState. Injected fs so tests never
 * touch a real disk and can fail any one step.
 */

import * as nodePath from "node:path";
import {
  CHECKPOINT_RETENTION_BYTES,
  CHECKPOINT_RETENTION_TURNS,
  capRetention,
  checkpointId,
  normalizeRelPath,
  type Checkpoint,
  type CheckpointFile,
  type CheckpointSkippedFile,
} from "./checkpoints";

export interface CheckpointStoreFs {
  mkdirSync(p: string, opts: { recursive: true }): void;
  writeFileSync(p: string, data: Uint8Array | string): void;
  readFileSync(p: string): Uint8Array;
  readdirSync(p: string): string[];
  existsSync(p: string): boolean;
  statSync(p: string): { size: number; isDirectory(): boolean };
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
}

export interface CheckpointStoreOpts {
  /** `<globalStorage>/checkpoints` */
  root: string;
  fs: CheckpointStoreFs;
  now?: () => number;
  log?: (line: string) => void;
  maxTurns?: number;
  maxBytes?: number;
}

export type StoreResult = { ok: true } | { ok: false; reason: string };

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,80}$/;

export function sanitizeCheckpointSegment(value: string): string {
  const s = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
  return s || "x";
}

interface MetaFile {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  userMessagePreview: string;
  files: Array<Omit<CheckpointFile, "blob"> & { blobSha256: string }>;
  skipped: CheckpointSkippedFile[];
  bytes: number;
  disabled?: boolean;
  disableReason?: string;
}

export interface CheckpointListEntry {
  turnId: string;
  createdAt: number;
  bytes: number;
  preview: string;
  disabled: boolean;
  fileCount: number;
  skippedCount: number;
}

export class CheckpointStore {
  private readonly root: string;
  private readonly fs: CheckpointStoreFs;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxTurns: number;
  private readonly maxBytes: number;

  constructor(opts: CheckpointStoreOpts) {
    this.root = opts.root;
    this.fs = opts.fs;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.maxTurns = opts.maxTurns ?? CHECKPOINT_RETENTION_TURNS;
    this.maxBytes = opts.maxBytes ?? CHECKPOINT_RETENTION_BYTES;
  }

  private sessionDir(sessionId: string): string {
    return nodePath.join(this.root, sanitizeCheckpointSegment(sessionId));
  }

  private turnDir(sessionId: string, turnId: string): string {
    return nodePath.join(this.sessionDir(sessionId), sanitizeCheckpointSegment(turnId));
  }

  private metaPath(sessionId: string, turnId: string): string {
    return nodePath.join(this.turnDir(sessionId, turnId), "meta.json");
  }

  private blobPath(sessionId: string, turnId: string, sha: string): string {
    return nodePath.join(this.turnDir(sessionId, turnId), "blobs", sha);
  }

  /**
   * Persist (or update) one turn. Writes blobs first, meta last. A failure
   * removes the turn directory so a half-written snapshot cannot be loaded.
   */
  save(cp: Checkpoint): StoreResult {
    const sessionId = String(cp.sessionId || "");
    const turnId = String(cp.turnId || "");
    if (!sessionId || !turnId) return { ok: false, reason: "missing session or turn id" };
    if (!SAFE_SEGMENT.test(sanitizeCheckpointSegment(sessionId)) ||
        !SAFE_SEGMENT.test(sanitizeCheckpointSegment(turnId))) {
      return { ok: false, reason: "unsafe checkpoint id" };
    }
    const dir = this.turnDir(sessionId, turnId);
    try {
      this.fs.mkdirSync(dir, { recursive: true });
      this.fs.mkdirSync(nodePath.join(dir, "blobs"), { recursive: true });
    } catch (e) {
      return this.fail(dir, "mkdir", e);
    }

    const files: MetaFile["files"] = [];
    let bytes = 0;
    for (const file of cp.files ?? []) {
      const blobSha = file.sha256;
      const blobBytes = Buffer.from(file.blob, "utf8");
      bytes += blobBytes.length;
      const dest = this.blobPath(sessionId, turnId, blobSha);
      try {
        this.fs.writeFileSync(dest, blobBytes);
      } catch (e) {
        return this.fail(dir, "blob", e);
      }
      files.push({
        relPath: normalizeRelPath(file.relPath),
        sha256: file.sha256,
        existedBefore: file.existedBefore,
        afterSha256: file.afterSha256,
        blobSha256: blobSha,
      });
    }

    const meta: MetaFile = {
      id: cp.id || checkpointId(sessionId, turnId),
      sessionId,
      turnId,
      createdAt: cp.createdAt || this.now(),
      userMessagePreview: cp.userMessagePreview || "",
      files,
      skipped: (cp.skipped ?? []).map((s) => ({ ...s, relPath: normalizeRelPath(s.relPath) })),
      bytes,
      disabled: cp.disabled,
      disableReason: cp.disableReason,
    };
    try {
      this.fs.writeFileSync(this.metaPath(sessionId, turnId), Buffer.from(JSON.stringify(meta), "utf8"));
    } catch (e) {
      return this.fail(dir, "meta", e);
    }

    this.pruneSession(sessionId, turnId, bytes);
    return { ok: true };
  }

  load(sessionId: string, turnId: string): Checkpoint | null {
    try {
      const raw = this.fs.readFileSync(this.metaPath(sessionId, turnId));
      const meta = JSON.parse(Buffer.from(raw).toString("utf8")) as MetaFile;
      if (!meta || typeof meta !== "object") return null;
      const files: CheckpointFile[] = [];
      for (const f of meta.files ?? []) {
        if (!f || typeof f.relPath !== "string" || typeof f.sha256 !== "string") continue;
        let blob = "";
        try {
          const bytes = this.fs.readFileSync(this.blobPath(sessionId, turnId, f.blobSha256 || f.sha256));
          blob = Buffer.from(bytes).toString("utf8");
        } catch {
          return null;
        }
        files.push({
          relPath: f.relPath,
          sha256: f.sha256,
          blob,
          existedBefore: f.existedBefore === true,
          afterSha256: typeof f.afterSha256 === "string" ? f.afterSha256 : undefined,
        });
      }
      return {
        id: typeof meta.id === "string" ? meta.id : checkpointId(sessionId, turnId),
        sessionId,
        turnId,
        createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
        userMessagePreview: typeof meta.userMessagePreview === "string" ? meta.userMessagePreview : "",
        files,
        skipped: Array.isArray(meta.skipped) ? meta.skipped : [],
        bytes: typeof meta.bytes === "number" ? meta.bytes : files.reduce((n, f) => n + Buffer.byteLength(f.blob, "utf8"), 0),
        disabled: meta.disabled === true,
        disableReason: typeof meta.disableReason === "string" ? meta.disableReason : undefined,
      };
    } catch {
      return null;
    }
  }

  list(sessionId: string): CheckpointListEntry[] {
    const dir = this.sessionDir(sessionId);
    let names: string[] = [];
    try {
      names = this.fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: CheckpointListEntry[] = [];
    for (const name of names) {
      const cp = this.load(sessionId, name);
      if (!cp) continue;
      out.push({
        turnId: cp.turnId,
        createdAt: cp.createdAt,
        bytes: cp.bytes,
        preview: cp.userMessagePreview,
        disabled: !!cp.disabled,
        fileCount: cp.files.length,
        skippedCount: cp.skipped.length,
      });
    }
    out.sort((a, b) => Number(a.turnId) - Number(b.turnId));
    return out;
  }

  /** Checkpoints for turns after `surviving` (1-based), oldest first. */
  loadFrom(sessionId: string, surviving: number): Checkpoint[] {
    const ids = this.list(sessionId)
      .filter((e) => Number(e.turnId) > surviving)
      .map((e) => e.turnId);
    const out: Checkpoint[] = [];
    for (const id of ids) {
      const cp = this.load(sessionId, id);
      if (cp) out.push(cp);
    }
    return out;
  }

  disable(sessionId: string, turnId: string, reason: string): StoreResult {
    // Wipe any blobs first so a disabled turn cannot be restored from leftovers.
    this.removeTurn(sessionId, turnId);
    return this.save({
      id: checkpointId(sessionId, turnId),
      sessionId,
      turnId,
      createdAt: this.now(),
      userMessagePreview: "",
      files: [],
      skipped: [],
      bytes: 0,
      disabled: true,
      disableReason: reason,
    });
  }

  /** Drop turns after `surviving` (kept as conversation). */
  pruneAfter(sessionId: string, surviving: number): void {
    for (const entry of this.list(sessionId)) {
      if (Number(entry.turnId) > surviving) this.removeTurn(sessionId, entry.turnId);
    }
  }

  removeSession(sessionId: string): void {
    try {
      this.fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch (e) {
      this.log(`[checkpoints] remove session failed: ${(e as Error).message}`);
    }
  }

  private removeTurn(sessionId: string, turnId: string): void {
    try {
      this.fs.rmSync(this.turnDir(sessionId, turnId), { recursive: true, force: true });
    } catch (e) {
      this.log(`[checkpoints] remove turn failed: ${(e as Error).message}`);
    }
  }

  private pruneSession(sessionId: string, incomingTurnId: string, incomingBytes: number): void {
    const entries = this.list(sessionId).filter((e) => e.turnId !== incomingTurnId);
    const drop = capRetention(entries, incomingBytes, this.maxTurns, this.maxBytes);
    for (const e of drop) this.removeTurn(sessionId, e.turnId);
  }

  private fail(dir: string, step: string, e: unknown): StoreResult {
    const reason = `${step}: ${(e as Error)?.message ?? e}`;
    this.log(`[checkpoints] ${reason}`);
    try {
      this.fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: a leftover dir is unused without meta */
    }
    return { ok: false, reason };
  }
}

/** Node `fs` adapter used by the host. */
export function nodeCheckpointFs(fs: {
  mkdirSync(p: string, opts: { recursive: boolean }): void;
  writeFileSync(p: string, data: Uint8Array | string): void;
  readFileSync(p: string): Uint8Array;
  readdirSync(p: string): string[];
  existsSync(p: string): boolean;
  statSync(p: string): { size: number; isDirectory(): boolean };
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
}): CheckpointStoreFs {
  return {
    mkdirSync: (p, o) => { fs.mkdirSync(p, o); },
    writeFileSync: (p, d) => { fs.writeFileSync(p, d); },
    readFileSync: (p) => fs.readFileSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => fs.statSync(p),
    rmSync: (p, o) => { fs.rmSync(p, o); },
  };
}
