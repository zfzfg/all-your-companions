import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encode } from "jpeg-js";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixtureImage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-original-"));
  tempDirs.push(root);
  const staging = path.join(root, "image-staging");
  fs.mkdirSync(staging);
  const source = path.join(staging, "image-123.png");
  fs.writeFileSync(source, "pixels");
  return { root, staging, source };
}

function host() {
  const h = Object.create(GrokSidebar.prototype) as any;
  h.focused = {};
  h.workspaceRoot = () => "/workspace";
  h.fullImagePaths = new Map([["handle-1", "/workspace/photo.jpg"]]);
  h.fullImageHandles = new Map();
  h.isImagePathAuthorizedNow = vi.fn(() => true);
  h.host = { appendLine: vi.fn() };
  h.postLocal = vi.fn();
  h.sendRemoteRequester = vi.fn();
  h.captureRemoteRequester = () => ({ clientId: "phone" });
  h.remoteClients = { active: () => h.focused, cwd: h.workspaceRoot };
  return h;
}

describe("original image delivery", () => {
  it.each(["requestImageFull", "requestImageOriginal"])("keeps unknown and revoked handles silent for %s", async (type) => {
    const h = host();
    const read = vi.spyOn(fs.promises, "readFile");
    await h.onMessage({ type, fullId: "unknown", requestId: 1 }, "local");
    h.isImagePathAuthorizedNow.mockReturnValue(false);
    await h.onMessage({ type, fullId: "handle-1", requestId: 1 }, "local");
    expect(read).not.toHaveBeenCalled();
    expect(h.postLocal).not.toHaveBeenCalled();
  });

  it.each(["stat", "readFile"] as const)("answers unavailable on an asynchronous %s failure", async (method) => {
    const h = host();
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 100 } as any);
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from("bytes"));
    vi.mocked(fs.promises[method]).mockRejectedValueOnce(new Error("unreadable"));
    await h.onMessage({ type: "requestImageOriginal", fullId: "handle-1", requestId: 1 }, "local");
    expect(h.postLocal).toHaveBeenCalledWith({ type: "imageOriginal", fullId: "handle-1", requestId: 1, src: undefined });
  });

  it("rejects oversized originals without shrinking them to fit", async () => {
    const h = host();
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 26 * 1024 * 1024 } as any);
    const read = vi.spyOn(fs.promises, "readFile");
    expect(await h.readOriginalImage("/workspace/photo.jpg")).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks revocation after an asynchronous read", async () => {
    const h = host();
    h.readOriginalImage = vi.fn(async () => {
      h.isImagePathAuthorizedNow.mockReturnValue(false);
      return "data:image/png;base64,cGl4ZWxz";
    });
    await h.onMessage({ type: "requestImageOriginal", fullId: "handle-1", requestId: 1 }, "local");
    expect(h.postLocal).not.toHaveBeenCalled();
  });

  it("issues local handles for composer, queued, live and replayed attachments", () => {
    const h = host();
    const { source } = fixtureImage();
    const chip = { id: "image-1", imageIndex: 1, path: source, mimeType: "image/png" };
    const webview = { asWebviewUri: () => "vscode-resource:image" };
    const composer = h.localPreviewChips({ chips: [chip] }, webview)[0];
    expect(composer.fullId).toBeTruthy();
    const live = h.localizeHistoryMessage({ type: "userMessage", chips: [chip] }, webview);
    const queued = h.localizeHistoryMessage({ type: "queuedSends", queued: [{ chips: [chip] }] }, webview);
    const replay = h.localizeHistoryMessage({ type: "userMessageChunk", images: [{ imageIndex: 1, path: chip.path }] }, webview);
    expect([live.chips[0].fullId, queued.queued[0].chips[0].fullId, replay.images[0].fullId]).toEqual([composer.fullId, composer.fullId, composer.fullId]);
  });

  it.each(["grok", "codex", "claude"])("authorizes %s staged images only while owned by the asking session and open project", (provider) => {
    const h = host();
    delete h.isImagePathAuthorizedNow;
    h.authorizedSessionCwds = () => ["/workspace"];
    h.isAuthorizedCwd = vi.fn(() => true);
    h.sessionCwd = () => "/workspace";
    const { root, staging, source } = fixtureImage();
    h.imageStagingDir = () => staging;
    const session = new Session();
    session.provider = provider as any;
    expect(h.isImagePathAuthorizedNow(source, session)).toBe(false);
    session.buffer.push({ type: "userMessageChunk", text: "image", images: [{ imageIndex: 1, path: source }] });
    expect(h.isImagePathAuthorizedNow(source, session)).toBe(true);
    h.isAuthorizedCwd.mockReturnValue(false);
    expect(h.isImagePathAuthorizedNow(source, session)).toBe(false);
    h.isAuthorizedCwd.mockReturnValue(true);
    const outside = path.join(root, "other.png");
    fs.writeFileSync(outside, "outside");
    session.buffer.push({ type: "userMessageChunk", text: "image", images: [{ imageIndex: 2, path: outside }] });
    expect(h.isImagePathAuthorizedNow(outside, session)).toBe(false);
  });
});
