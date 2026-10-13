import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { SessionInboundRouter } from "../src/sidebar-inbound";
import { Session } from "../src/session";
import { bootWebview, dispatch } from "./webview-harness";

function host() {
  const session = new Session();
  const posted: any[] = [];
  const composer = { isImagePathAuthorizedNow: vi.fn(() => true), readOriginalImage: vi.fn(async () => "data:image/png;base64,eA==") };
  const router = new SessionInboundRouter({ getFocused: () => session, sessionCwd: () => path.resolve("workspace"), composer,
    postLocal: (m: any) => posted.push(m) } as any);
  return { session, posted, composer, router };
}
describe("local markdown image pipeline", () => {
  it("resolves escaped spaces against the conversation directory and checks access before and after reading", async () => {
    const h = host();
    await h.router.tryHandle({ type: "resolveMarkdownImage", requestId: "a", source: "images/a%20b.png" }, h.session, () => h.session, "");
    expect(h.composer.readOriginalImage).toHaveBeenCalledWith(path.resolve("workspace", "images/a b.png"));
    expect(h.composer.isImagePathAuthorizedNow).toHaveBeenCalledTimes(2);
    expect(h.posted[0].src).toBe("data:image/png;base64,eA==");
  });
  it("refuses outside paths, external URLs and asynchronous read errors", async () => {
    const h = host(); h.composer.isImagePathAuthorizedNow.mockReturnValue(false);
    await h.router.tryHandle({ type: "resolveMarkdownImage", requestId: "a", source: "../secret.png" }, h.session, () => h.session, "");
    await h.router.tryHandle({ type: "resolveMarkdownImage", requestId: "b", source: "https://example.com/a.png" }, h.session, () => h.session, "");
    expect(h.composer.readOriginalImage).not.toHaveBeenCalled();
    h.composer.isImagePathAuthorizedNow.mockReturnValue(true);
    h.composer.readOriginalImage.mockRejectedValueOnce(new Error("EACCES"));
    await h.router.tryHandle({ type: "resolveMarkdownImage", requestId: "c", source: "missing.png" }, h.session, () => h.session, "");
    expect(h.posted.every(m => m.src === undefined)).toBe(true);
  });
  it("drops a read that finishes after a session generation change", async () => {
    const h = host();
    h.composer.readOriginalImage.mockImplementationOnce(async () => { h.session.gen++; return "data:image/png;base64,eA=="; });
    await h.router.tryHandle({ type: "resolveMarkdownImage", requestId: "a", source: "a.png" }, h.session, () => h.session, "");
    expect(h.posted).toEqual([]);
  });
  it("renders empty alt and spaced paths, retains a fallback, and handles image load failure", async () => {
    const h = bootWebview();
    dispatch(h.window, { type: "messageChunk", text: "![](images/a b.png)" });
    await new Promise(resolve => setTimeout(resolve, 30));
    const request = h.posted.find((m: any) => m.type === "resolveMarkdownImage") as any;
    expect(request.source).toBe("images/a b.png");
    dispatch(h.window, { type: "markdownImage", requestId: request.requestId, src: "data:image/png;base64,eA==" });
    const img = h.doc.querySelector("img.md-image") as HTMLImageElement;
    expect(img.alt).toBe("");
    img.dispatchEvent(new h.window.Event("error"));
    expect(img.hidden).toBe(true);
    expect((h.doc.querySelector(".md-image-fallback") as HTMLElement).hidden).toBe(false);
  });
});
