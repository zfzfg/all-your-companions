/**
 * Client-side file checkpoints (AP-08).
 *
 * One checkpoint per user turn: the exact bytes of every workspace file the
 * turn is about to change, taken BEFORE the first write. Restore compares
 * those hashes to the disk as it is now. A file that no longer matches either
 * the before-hash or the recorded after-hash is a foreign change — never a
 * silent overwrite.
 *
 * Contents, not diffs: a patch that no longer applies is worthless. Line
 * endings are hashed as stored (CRLF ≠ LF). Time and I/O stay out of this
 * file; the store and the host inject both.
 *
 * Recipe R7: no vscode, no node:fs, no Date.now.
 */

import { createHash } from "node:crypto";
import { canonicalPath, relativizeToRoot } from "./permission-rules";

/** Per-file ceiling. Anything larger is recorded as unrestorable. */
export const CHECKPOINT_MAX_FILE_BYTES = 1024 * 1024;

/** Oldest-first prune when either cap is hit, at write time, not in a job. */
export const CHECKPOINT_RETENTION_TURNS = 20;
export const CHECKPOINT_RETENTION_BYTES = 200 * 1024 * 1024;

const BINARY_SCAN_BYTES = 8192;

export interface CheckpointFile {
  relPath: string;
  sha256: string;
  /** Exact text, including CRLF. Empty when the file did not exist. */
  blob: string;
  existedBefore: boolean;
  /** Hash of the file after this turn's write, when we observed it. */
  afterSha256?: string;
}

export interface CheckpointSkippedFile {
  relPath: string;
  reason: "too-large" | "binary";
  bytes: number;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  userMessagePreview: string;
  files: CheckpointFile[];
  skipped: CheckpointSkippedFile[];
  bytes: number;
  disabled?: boolean;
  disableReason?: string;
}

export type RestoreOutcome =
  | { kind: "restore"; files: string[] }
  | { kind: "conflict"; changedSince: string[] }
  | { kind: "nothing" };

export interface RestorePlan {
  writes: { relPath: string; blob: string }[];
  deletes: string[];
  unchanged: string[];
  conflicts: string[];
  skipped: CheckpointSkippedFile[];
}

export type SnapshotCapture =
  | { kind: "file"; file: CheckpointFile }
  | { kind: "skipped"; skipped: CheckpointSkippedFile };

export function sha256Bytes(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Hash the UTF-8 bytes of `text`. `"a\\r\\nb"` and `"a\\nb"` differ. */
export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

/** NUL in the first 8 KiB is the binary heuristic — UTF-16 and images trip it. */
export function bufferLooksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function classifySnapshotBytes(
  buf: Uint8Array,
  maxBytes: number = CHECKPOINT_MAX_FILE_BYTES,
): "ok" | "too-large" | "binary" {
  if (buf.length > maxBytes) return "too-large";
  if (bufferLooksBinary(buf)) return "binary";
  return "ok";
}

/**
 * Build a snapshot entry from the on-disk bytes (or `null` if the path did
 * not exist). Size-only skips pass `bytes: null` plus `reportedBytes`.
 */
export function snapshotFromBytes(
  relPath: string,
  bytes: Uint8Array | null,
  opts?: { maxBytes?: number; reportedBytes?: number },
): SnapshotCapture {
  const rel = normalizeRelPath(relPath);
  const maxBytes = opts?.maxBytes ?? CHECKPOINT_MAX_FILE_BYTES;
  if (bytes === null) {
    if (typeof opts?.reportedBytes === "number" && opts.reportedBytes > maxBytes) {
      return { kind: "skipped", skipped: { relPath: rel, reason: "too-large", bytes: opts.reportedBytes } };
    }
    return {
      kind: "file",
      file: {
        relPath: rel,
        sha256: sha256Text(""),
        blob: "",
        existedBefore: false,
      },
    };
  }
  const cls = classifySnapshotBytes(bytes, maxBytes);
  if (cls !== "ok") {
    return { kind: "skipped", skipped: { relPath: rel, reason: cls, bytes: bytes.length } };
  }
  const blob = Buffer.from(bytes).toString("utf8");
  return {
    kind: "file",
    file: {
      relPath: rel,
      sha256: sha256Text(blob),
      blob,
      existedBefore: true,
    },
  };
}

export function normalizeRelPath(relPath: string): string {
  return String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Workspace-relative path, or undefined when the file is outside the root. */
export function checkpointRelPath(absPath: string, workspaceRoot: string): string | undefined {
  if (!absPath || !workspaceRoot) return undefined;
  const rel = relativizeToRoot(absPath, workspaceRoot);
  if (!rel || rel === ".") return undefined;
  if (rel.split("/").includes("..")) return undefined;
  return normalizeRelPath(rel);
}

export function resolveCheckpointAbsPath(relPath: string, workspaceRoot: string): string | undefined {
  const rel = normalizeRelPath(relPath);
  if (!rel || rel.split("/").includes("..")) return undefined;
  const root = canonicalPath(workspaceRoot).norm;
  const joined = `${root.replace(/\/+$/, "")}/${rel}`;
  return joined;
}

/**
 * Per-file restore decision. `current` maps relPath → text (`null` = missing).
 *
 * - current hash == before-hash → already at the snapshot, skip
 * - current hash == after-hash → this turn's write is still there, restore
 * - current is missing and the file was created → already gone, skip
 * - anything else, including "we never saw the after-hash" → conflict
 */
export function planRestoreDetailed(
  cp: Checkpoint,
  current: ReadonlyMap<string, string | null>,
): RestorePlan {
  const writes: { relPath: string; blob: string }[] = [];
  const deletes: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const skipped = [...(cp.skipped ?? [])];
  if (cp.disabled) {
    return { writes, deletes, unchanged, conflicts, skipped };
  }
  for (const file of cp.files ?? []) {
    const rel = normalizeRelPath(file.relPath);
    const cur = current.has(rel) ? current.get(rel)! : current.get(file.relPath);
    const present = cur !== null && cur !== undefined;
    const currentHash = present ? sha256Text(cur) : null;

    if (!file.existedBefore) {
      if (!present) {
        unchanged.push(rel);
        continue;
      }
      if (file.afterSha256 && currentHash === file.afterSha256) {
        deletes.push(rel);
        continue;
      }
      if (currentHash === file.sha256 && file.blob === cur) {
        deletes.push(rel);
        continue;
      }
      conflicts.push(rel);
      continue;
    }

    if (currentHash === file.sha256) {
      unchanged.push(rel);
      continue;
    }
    if (file.afterSha256 && currentHash === file.afterSha256) {
      writes.push({ relPath: rel, blob: file.blob });
      continue;
    }
    if (!present) {
      // Deleted since the snapshot. Recreating is the rewind of a delete;
      // a later user-delete of an edited file is a conflict only when we
      // knew the after-hash and the file is gone — still restore (the
      // snapshot IS the before-state). Missing + known after-hash means
      // someone deleted our write: conflict.
      if (file.afterSha256) {
        conflicts.push(rel);
      } else {
        writes.push({ relPath: rel, blob: file.blob });
      }
      continue;
    }
    // Difference we cannot attribute to this turn.
    conflicts.push(rel);
  }
  return { writes, deletes, unchanged, conflicts, skipped };
}

export function planRestore(
  cp: Checkpoint,
  current: ReadonlyMap<string, string | null>,
): RestoreOutcome {
  const plan = planRestoreDetailed(cp, current);
  if (plan.conflicts.length) return { kind: "conflict", changedSince: [...plan.conflicts] };
  const files = [...plan.writes.map((w) => w.relPath), ...plan.deletes];
  if (files.length) return { kind: "restore", files };
  return { kind: "nothing" };
}

/**
 * Desired on-disk state after a rewind that discards `cps` (oldest first).
 * Each path keeps the FIRST (oldest discarded) before-image, and the LAST
 * observed after-hash so conflict detection still sees the newest write.
 */
export function mergeCheckpoints(cps: readonly Checkpoint[]): Checkpoint {
  const files = new Map<string, CheckpointFile>();
  const skipped = new Map<string, CheckpointSkippedFile>();
  let bytes = 0;
  let createdAt = 0;
  let preview = "";
  let sessionId = "";
  let turnId = "";
  let id = "";
  for (const cp of cps) {
    if (cp.disabled) continue;
    if (!sessionId) sessionId = cp.sessionId;
    if (!turnId) turnId = cp.turnId;
    if (!id) id = cp.id;
    if (!preview) preview = cp.userMessagePreview;
    if (!createdAt) createdAt = cp.createdAt;
    for (const file of cp.files ?? []) {
      const rel = normalizeRelPath(file.relPath);
      const prev = files.get(rel);
      if (!prev) {
        files.set(rel, { ...file, relPath: rel });
        bytes += Buffer.byteLength(file.blob, "utf8");
      } else if (file.afterSha256) {
        files.set(rel, { ...prev, afterSha256: file.afterSha256 });
      }
    }
    for (const skip of cp.skipped ?? []) {
      const rel = normalizeRelPath(skip.relPath);
      if (!files.has(rel) && !skipped.has(rel)) skipped.set(rel, { ...skip, relPath: rel });
    }
  }
  return {
    id: id || `merged:${turnId}`,
    sessionId,
    turnId,
    createdAt,
    userMessagePreview: preview,
    files: [...files.values()],
    skipped: [...skipped.values()],
    bytes,
  };
}

/** Writes + deletes to apply. Conflict files are included only when overwrite is set. */
export function restoreActions(
  plan: RestorePlan,
  overwriteConflicts: boolean,
  cp: Checkpoint,
): { writes: { relPath: string; blob: string }[]; deletes: string[] } {
  const writes = [...plan.writes];
  const deletes = [...plan.deletes];
  if (!overwriteConflicts) return { writes, deletes };
  const byRel = new Map(cp.files.map((f) => [normalizeRelPath(f.relPath), f]));
  for (const rel of plan.conflicts) {
    const file = byRel.get(rel);
    if (!file) continue;
    if (!file.existedBefore) deletes.push(rel);
    else writes.push({ relPath: rel, blob: file.blob });
  }
  return { writes, deletes };
}

export function capRetention<T extends { bytes: number }>(
  existingOldestFirst: readonly T[],
  incomingBytes: number,
  maxTurns: number = CHECKPOINT_RETENTION_TURNS,
  maxBytes: number = CHECKPOINT_RETENTION_BYTES,
): T[] {
  const kept = [...existingOldestFirst];
  const drop: T[] = [];
  const total = () => kept.reduce((n, t) => n + Math.max(0, t.bytes), 0) + incomingBytes;
  while (kept.length + 1 > maxTurns && kept.length) drop.push(kept.shift()!);
  while (total() > maxBytes && kept.length) drop.push(kept.shift()!);
  return drop;
}

/** User-bubble N is discarded along with everything after it, so N survive. */
export function survivingAfterClientRewind(userBubbleIndex: number): number {
  if (!Number.isInteger(userBubbleIndex) || userBubbleIndex < 0) return 0;
  return userBubbleIndex;
}

/** Turn ids are 1-based `userMessageCount` at send. Restore those after `surviving`. */
export function turnIdsToRestore(
  surviving: number,
  existingTurnIds: readonly string[],
): string[] {
  return existingTurnIds
    .filter((id) => {
      const n = Number(id);
      return Number.isFinite(n) && n > surviving;
    })
    .sort((a, b) => Number(a) - Number(b));
}

export function checkpointId(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

export function previewUserMessage(text: string, max = 80): string {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(0, max - 1)) + "…";
}
