/**
 * FileUploadHost: attachment staging, UUID-scoped file retaining/removal,
 * clipboard image paste, and remote full-image handles.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S7h).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Host, HostContext } from "./host";
import type { Session } from "./session";
import type { MementoLike } from "./usage-host";
import { isFileChip, type ContextChip } from "./context-chips";
import {
  allocateImageIndex,
  extFromMime,
  isVisionMime,
  makeImageChip,
  mimeFromPath,
  MAX_VISION_IMAGE_BYTES,
} from "./chips";
import { normalizeRelPath } from "./mention";
import { pathsEqual } from "./worktree";
import {
  pathBoundToClosedFolder,
  imagePathStillAuthorized,
} from "./workspace-auth";
import { isTrustedGeneratedMediaPath } from "./media-serve";
import { SESSION_META_KEY } from "./worktree-host";
import {
  resolveGrokHome,
  type SessionMetaOverrides,
} from "./sessions";
import {
  retainedUploadDirectories,
  stagedUploadDirectory,
  unreferencedUploadsForRemovedSessions,
} from "./file-upload";

export type AttachmentOwner = () => Session | undefined;

export const STAGING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FULL_IMAGE_HANDLE_LIMIT = 300;

/** Best-effort MIME from a file extension, for inlining generated media. */
export function guessMediaMime(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    case "mp4":
    case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    default: return "image/png";
  }
}

export interface FileUploadHostDeps {
  host: Host;
  context: HostContext;
  state: MementoLike;
  sessionCwd(session: Session): string;
  isAuthorizedCwd(cwd: string): boolean;
  authorizedSessionCwds(): string[];
  getFocused(): Session;
  postChips(session?: Session): void;
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  revealAndFocusComposer(): void;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class FileUploadHost {
  public pendingAttach = new Set<Promise<void>>();
  public fullImagePaths = new Map<string, string>();
  public fullImageHandles = new Map<string, string>();

  constructor(private readonly deps: FileUploadHostDeps) {}

  public trackAttach(op: Promise<unknown>): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.trackAttach>("trackAttach");
    if (override) return override(op);
    const tracked = op.then(() => undefined);
    this.pendingAttach.add(tracked);
    const done = () => { this.pendingAttach.delete(tracked); };
    void tracked.then(done, done);
    return tracked;
  }

  public imageStagingDir(): string {
    const override = this.deps.getOverride?.<typeof this.imageStagingDir>("imageStagingDir");
    if (override) return override();
    return path.join(this.deps.context.globalStorageUri.fsPath, "image-staging");
  }

  public fileStagingDir(): string {
    const override = this.deps.getOverride?.<typeof this.fileStagingDir>("fileStagingDir");
    if (override) return override();
    return path.join(this.deps.context.globalStorageUri.fsPath, "file-staging");
  }

  public async sweepImageStaging(): Promise<void> {
    const dir = this.imageStagingDir();
    try {
      const cutoff = Date.now() - STAGING_ORPHAN_TTL_MS;
      for (const name of await fs.promises.readdir(dir)) {
        const p = path.join(dir, name);
        try {
          if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.unlink(p);
        } catch { /* raced or locked — next sweep gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
  }

  public async sweepFileStaging(): Promise<void> {
    const root = this.fileStagingDir();
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const retained = retainedUploadDirectories(root, overrides);
    try {
      const cutoff = Date.now() - STAGING_ORPHAN_TTL_MS;
      for (const name of await fs.promises.readdir(root)) {
        const dir = path.join(root, name);
        const owned = stagedUploadDirectory(root, path.join(dir, "_"));
        if (!owned) continue;
        const key = process.platform === "win32" ? path.resolve(owned).toLowerCase() : path.resolve(owned);
        if (retained.has(key)) continue;
        try {
          if ((await fs.promises.stat(owned)).mtimeMs < cutoff) {
            await fs.promises.rm(owned, { recursive: true, force: true });
          }
        } catch { /* raced or locked — next activation gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
  }

  public async retainUploadedFilesForSession(session: Session, chips: ContextChip[]): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.retainUploadedFilesForSession>("retainUploadedFilesForSession");
    if (override) return override(session, chips);
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const uploaded = chips
      .filter(isFileChip)
      .filter((chip) => !chip.hidden && !!stagedUploadDirectory(this.fileStagingDir(), chip.path))
      .map((chip) => chip.path);
    if (!uploaded.length) return;
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const files = [...new Set([...(cur.uploadedFiles ?? []), ...uploaded])];
    await this.deps.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...cur, uploadedFiles: files },
    });
  }

  public async removeUploadsForSessions(
    ids: Iterable<string>,
    overrides: SessionMetaOverrides,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.removeUploadsForSessions>("removeUploadsForSessions");
    if (override) return override(ids, overrides);
    const files = unreferencedUploadsForRemovedSessions(overrides, ids);
    const dirs = new Set(
      files
        .map((file) => stagedUploadDirectory(this.fileStagingDir(), file))
        .filter((dir): dir is string => !!dir),
    );
    for (const dir of dirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (e) {
        this.deps.host.appendLine(`[upload] could not remove staged document directory: ${(e as Error).message}`);
      }
    }
  }

  public async stageImageAttachment(
    bytes: Buffer,
    mimeType: string,
    originPath?: string,
    owner: AttachmentOwner = () => this.deps.getFocused(),
    previewId?: string,
  ): Promise<Session | undefined> {
    const override = this.deps.getOverride?.<typeof this.stageImageAttachment>("stageImageAttachment");
    if (override) return override(bytes, mimeType, originPath, owner, previewId);
    const dir = this.imageStagingDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `image-${randomUUID()}${extFromMime(mimeType)}`);
    await fs.promises.writeFile(absPath, bytes);
    const session = owner();
    if (!session) return undefined;
    const rel = originPath
      ? normalizeRelPath(path.relative(this.deps.sessionCwd(session), originPath))
      : undefined;
    const originRelPath = rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)
      ? rel
      : undefined;
    const allocated = allocateImageIndex(session.imageIndexHighWater, [
      ...session.chips,
      ...session.queuedSends.flatMap((item) => item.chips),
    ]);
    session.imageIndexHighWater = allocated.highWater;
    session.chips.push(makeImageChip(absPath, allocated.index, mimeType, originRelPath, previewId));
    this.deps.postChips(session);
    return session;
  }

  public async addPastedImage(
    base64: string,
    mimeType: string,
    owner: AttachmentOwner = () => this.deps.getFocused(),
    previewId?: string,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.addPastedImage>("addPastedImage");
    if (override) return override(base64, mimeType, owner, previewId);
    try {
      if (!isVisionMime(mimeType)) {
        this.deps.notifyUser("error", `Grok: unsupported image type ${mimeType} — use PNG, JPEG, GIF, or WebP.`);
        return;
      }
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) return;
      if (bytes.length > MAX_VISION_IMAGE_BYTES) {
        this.deps.notifyUser("error", "Grok: pasted image exceeds the 20 MiB vision limit.");
        return;
      }
      const session = await this.stageImageAttachment(bytes, mimeType, undefined, owner, previewId);
      if (session === this.deps.getFocused()) this.deps.revealAndFocusComposer();
    } catch (e) {
      this.deps.host.appendLine(`[image] paste failed: ${(e as Error).message}`);
      this.deps.notifyUser("error", `Grok: could not attach the pasted image — ${(e as Error).message}`);
    }
  }

  public async importImageFromDisk(
    srcPath: string,
    owner: AttachmentOwner = () => this.deps.getFocused(),
  ): Promise<Session | false | undefined> {
    const override = this.deps.getOverride?.<typeof this.importImageFromDisk>("importImageFromDisk");
    if (override) return override(srcPath, owner);
    const stat = await fs.promises.stat(srcPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_VISION_IMAGE_BYTES) return false;
    const bytes = await fs.promises.readFile(srcPath);
    return this.stageImageAttachment(bytes, mimeFromPath(srcPath), srcPath, owner);
  }

  public registerFullImage(imagePath: string): string {
    const override = this.deps.getOverride?.<typeof this.registerFullImage>("registerFullImage");
    if (override) return override(imagePath);
    const existing = this.fullImageHandles.get(imagePath);
    if (existing) return existing;
    const handle = randomUUID().replace(/-/g, "");
    this.fullImageHandles.set(imagePath, handle);
    this.fullImagePaths.set(handle, imagePath);
    while (this.fullImagePaths.size > FULL_IMAGE_HANDLE_LIMIT) {
      const oldest = this.fullImagePaths.keys().next().value;
      if (oldest === undefined) break;
      const stalePath = this.fullImagePaths.get(oldest);
      this.fullImagePaths.delete(oldest);
      if (stalePath && this.fullImageHandles.get(stalePath) === oldest) {
        this.fullImageHandles.delete(stalePath);
      }
    }
    return handle;
  }

  public isImagePathAuthorizedNow(imagePath: string, session?: Session): boolean {
    const override = this.deps.getOverride?.<typeof this.isImagePathAuthorizedNow>("isImagePathAuthorizedNow");
    if (override) return override(imagePath, session);
    if (this.isImagePathInOpenSet(imagePath)) return true;
    if (!session || !this.deps.isAuthorizedCwd(this.deps.sessionCwd(session))) return false;
    try {
      if (!pathBoundToClosedFolder(fs.realpathSync(imagePath), fs.realpathSync(this.imageStagingDir()), pathsEqual)) return false;
    } catch { return false; }
    const owns = (images: readonly unknown[]) => images.some((image) => (image as { path?: unknown }).path === imagePath);
    return owns(session.chips)
      || session.queuedSends.some((item) => owns(item.chips))
      || session.buffer.some((m) =>
        m.type === "userMessage" ? owns(m.chips ?? [])
          : m.type === "userMessageChunk" ? owns((m as { images?: { path?: string }[] }).images ?? []) : false);
  }

  public async readOriginalImage(imagePath: string): Promise<string | undefined> {
    const override = this.deps.getOverride?.<typeof this.readOriginalImage>("readOriginalImage");
    if (override) return override(imagePath);
    try {
      const mime = guessMediaMime(imagePath);
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)) return undefined;
      const limit = 25 * 1024 * 1024;
      if ((await fs.promises.stat(imagePath)).size > limit) return undefined;
      const bytes = await fs.promises.readFile(imagePath);
      if (!bytes.length || bytes.length > limit) return undefined;
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  public isImagePathInOpenSet(imagePath: string): boolean {
    const authorized = this.deps.authorizedSessionCwds();
    let home: string | undefined;
    try {
      home = resolveGrokHome(process.env);
    } catch {
      home = undefined;
    }
    return imagePathStillAuthorized(imagePath, authorized, {
      grokHome: home,
      sameCwd: pathsEqual,
      isTrustedGeneratedMedia: (p) => {
        try {
          return !!home && isTrustedGeneratedMediaPath(p, home, (c) => fs.realpathSync(c));
        } catch {
          return false;
        }
      },
    });
  }
}

export function createFileUploadHost(deps: FileUploadHostDeps): FileUploadHost {
  return new FileUploadHost(deps);
}
