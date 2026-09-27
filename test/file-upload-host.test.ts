import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createFileUploadHost,
  guessMediaMime,
  type FileUploadHostDeps,
} from "../src/file-upload-host";
import { Session } from "../src/session";

describe("FileUploadHost", () => {
  function makeHarness() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-upload-test-"));
    const focusedSession = new Session();
    const postedSessions: Session[] = [];
    const notifications: Array<{ level: string; text: string }> = [];

    const deps: FileUploadHostDeps = {
      host: {
        appendLine: vi.fn(),
      } as any,
      context: {
        globalStorageUri: { fsPath: tmpDir },
      } as any,
      state: {
        get: vi.fn((_k: string, def?: any) => def),
        update: vi.fn(async () => {}),
      },
      sessionCwd: () => tmpDir,
      isAuthorizedCwd: () => true,
      authorizedSessionCwds: () => [tmpDir],
      getFocused: () => focusedSession,
      postChips: (session?: Session) => {
        if (session) postedSessions.push(session);
      },
      notifyUser: (level, text) => {
        notifications.push({ level, text });
      },
      revealAndFocusComposer: vi.fn(),
    };

    const host = createFileUploadHost(deps);
    return { host, deps, tmpDir, focusedSession, postedSessions, notifications };
  }

  it("guessMediaMime resolves standard mime types", () => {
    expect(guessMediaMime("photo.jpg")).toBe("image/jpeg");
    expect(guessMediaMime("photo.JPEG")).toBe("image/jpeg");
    expect(guessMediaMime("image.png")).toBe("image/png");
    expect(guessMediaMime("image.webp")).toBe("image/webp");
    expect(guessMediaMime("video.mp4")).toBe("video/mp4");
    expect(guessMediaMime("video.webm")).toBe("video/webm");
    expect(guessMediaMime("unknown.xyz")).toBe("image/png");
  });

  it("computes staging directories and tracks attach operations", async () => {
    const { host, tmpDir } = makeHarness();
    expect(host.imageStagingDir()).toBe(path.join(tmpDir, "image-staging"));
    expect(host.fileStagingDir()).toBe(path.join(tmpDir, "file-staging"));

    let resolveOp!: () => void;
    const op = new Promise<void>((res) => { resolveOp = res; });
    const tracked = host.trackAttach(op);
    expect(host.pendingAttach.size).toBe(1);

    resolveOp();
    await tracked;
    expect(host.pendingAttach.size).toBe(0);
  });

  it("registers full image handles with reuse", () => {
    const { host } = makeHarness();
    const handle1 = host.registerFullImage("/path/to/img1.png");
    const handle2 = host.registerFullImage("/path/to/img1.png");
    const handle3 = host.registerFullImage("/path/to/img2.png");

    expect(handle1).toBe(handle2);
    expect(handle1).not.toBe(handle3);
    expect(host.fullImageHandles.get("/path/to/img1.png")).toBe(handle1);
    expect(host.fullImagePaths.get(handle1)).toBe("/path/to/img1.png");
  });

  it("stages image attachments and notifies postChips", async () => {
    const { host, focusedSession, postedSessions, tmpDir } = makeHarness();
    try {
      const buffer = Buffer.from("fake-png-data");
      const session = await host.stageImageAttachment(buffer, "image/png");
      expect(session).toBe(focusedSession);
      expect(focusedSession.chips.length).toBe(1);
      expect((focusedSession.chips[0] as any).mimeType).toBe("image/png");
      expect(focusedSession.chips[0].id?.startsWith("image:")).toBe(true);
      expect(postedSessions.length).toBe(1);
      expect(fs.existsSync(host.imageStagingDir())).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
