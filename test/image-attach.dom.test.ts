// DOM tests for the image-attach webview surfaces: the composer paste handler
// (raster-only collection, mixed-clipboard text preservation, the pendingPaste
// send hold), the send payload (host-owned chips — no chips echo), and the
// session-restore rebuild of [Image #N] tags into chips via parseImageTags.
import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

function pasteEvent(window: any, items: Array<{ kind: string; type: string; file?: any }>, text = "") {
  const e = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: {
      items: items.map((it) => ({
        kind: it.kind,
        type: it.type,
        getAsFile: () => it.file ?? null,
      })),
      getData: (kind: string) => (kind === "text/plain" ? text : ""),
    },
  });
  return e;
}

function pngFile(window: any): any {
  // A tiny stand-in blob — the handler only base64s it, never decodes pixels.
  return new window.File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
}

describe("composer paste handler", () => {
  it("posts pasteImage for a clipboard image and suppresses the default paste", async () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input")!;
    const e = pasteEvent(window, [{ kind: "file", type: "image/png", file: pngFile(window) }]);
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === "pasteImage")).toBe(true);
    });
    const msg = posted.find((m) => m.type === "pasteImage")!;
    expect(msg.mimeType).toBe("image/png");
    expect(typeof msg.data).toBe("string");
    expect((msg.data as string).length).toBeGreaterThan(0);
  });

  it("leaves a text-only paste to the default handler", () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input")!;
    const e = pasteEvent(window, [{ kind: "string", type: "text/plain" }], "hello");
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(posted.filter((m) => m.type === "pasteImage")).toHaveLength(0);
  });

  it("does not hijack a non-raster image item (svg markup copy)", () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input")!;
    const e = pasteEvent(window, [{ kind: "string", type: "image/svg+xml" }], "<svg/>");
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(posted.filter((m) => m.type === "pasteImage")).toHaveLength(0);
  });

  it("keeps the text half of a mixed clipboard and posts every image", async () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const e = pasteEvent(
      window,
      [
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/png", file: pngFile(window) },
        { kind: "file", type: "image/jpeg", file: pngFile(window) },
      ],
      "caption text",
    );
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(input.value).toContain("caption text");
    await vi.waitFor(() => {
      expect(posted.filter((m) => m.type === "pasteImage")).toHaveLength(2);
    });
  });

  it("holds send while a pasted image is still being read", async () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const sendBtn = doc.getElementById("send-btn")!;
    input.value = "look at this";
    input.dispatchEvent(pasteEvent(window, [{ kind: "file", type: "image/png", file: pngFile(window) }]));
    // FileReader is in flight — the send must be refused so the pasteImage
    // post can't land AFTER the send and ride the next message.
    click(window, sendBtn);
    expect(posted.filter((m) => m.type === "send")).toHaveLength(0);
    await vi.waitFor(() => {
      expect(posted.some((m) => m.type === "pasteImage")).toBe(true);
    });
    click(window, sendBtn);
    expect(posted.filter((m) => m.type === "send")).toHaveLength(1);
  });

  it("send carries only the text — chips are host-owned state", () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "hi";
    click(window, doc.getElementById("send-btn")!);
    const send = posted.find((m) => m.type === "send")!;
    expect(send.text).toBe("hi");
    expect("chips" in send).toBe(false);
  });
});

describe("restored [Image #N] rendering", () => {
  function replayUserMessage(window: any, text: string) {
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text });
    dispatch(window, { type: "historyReplay", active: false });
  }

  it("rebuilds trailing tags as image chips with the origin path on the tooltip", () => {
    const { window, doc } = bootWebview();
    replayUserMessage(window, "compress this\n\n[Image #2] (assets/hero.png)");
    const bubble = doc.querySelector(".msg.user")!;
    expect(bubble.textContent).toContain("compress this");
    expect(bubble.textContent).not.toContain("[Image #2]");
    const chip = bubble.querySelector(".msg-chip")!;
    expect(chip.textContent).toContain("Image #2");
    expect(chip.getAttribute("title")).toBe("assets/hero.png");
  });

  it("renders a live history thumbnail when the host supplies it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "userMessage",
      text: "describe this",
      chips: [{
        id: "image-1",
        path: "/staging/hero.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        previewSrc: "data:image/png;base64,AAAA",
      }],
    });
    expect(doc.querySelector(".msg-chip-preview img")?.getAttribute("src"))
      .toBe("data:image/png;base64,AAAA");
  });

  it("renders a restored history thumbnail and falls back cleanly without it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "userMessageChunk",
      text: "describe this\n\n[Image #1] (C:\\staging\\hero.png — attached inline; do not Read it)",
      images: [{ imageIndex: 1, path: "C:\\staging\\hero.png", previewSrc: "data:image/png;base64,AAAA" }],
    });
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".msg-chip-preview img")?.getAttribute("src"))
      .toBe("data:image/png;base64,AAAA");

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "userMessageChunk",
      text: "describe this\n\n[Image #1] (C:\\staging\\missing.png — attached inline; do not Read it)",
      images: [{ imageIndex: 1, path: "C:\\staging\\missing.png" }],
    });
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".msg-chip-preview")).toBeNull();
    expect(doc.querySelector(".msg-chip")?.textContent).toContain("Image #1");
  });

  it("maps non-contiguous restored tags to the matching thumbnails", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "userMessageChunk",
      text: "edit both\n\n[Image #2] (C:\\staging\\two.png — attached inline; do not Read it)\n[Image #5] (C:\\staging\\five.png — attached inline; do not Read it)",
      images: [
        { imageIndex: 2, path: "C:\\staging\\two.png", previewSrc: "data:image/png;base64,AAA=" },
        { imageIndex: 5, path: "C:\\staging\\five.png", previewSrc: "data:image/png;base64,BBB=" },
      ],
    });
    dispatch(window, { type: "historyReplay", active: false });
    const chips = [...doc.querySelectorAll(".msg-chip")];
    expect(chips.map((el) => el.textContent)).toEqual(["Image #2", "Image #5"]);
    const thumbs = [...doc.querySelectorAll(".msg-chip-preview img")].map((el) => el.getAttribute("src"));
    expect(thumbs).toEqual([
      "data:image/png;base64,AAA=",
      "data:image/png;base64,BBB=",
    ]);
  });

  it("leaves a literal [Image #N] in the middle of the user's words alone", () => {
    const { window, doc } = bootWebview();
    replayUserMessage(window, "the TUI prints [Image #1] before the text — why?");
    const bubble = doc.querySelector(".msg.user")!;
    expect(bubble.textContent).toContain("[Image #1]");
    expect(bubble.querySelector(".msg-chip")).toBeNull();
  });

  it("still strips the legacy leading-tag wire shape", () => {
    const { window, doc } = bootWebview();
    replayUserMessage(window, "[Image #1] what is this?");
    const bubble = doc.querySelector(".msg.user")!;
    expect(bubble.textContent).toContain("what is this?");
    expect(bubble.textContent).not.toContain("[Image #1]");
    expect(bubble.querySelector(".msg-chip")!.textContent).toContain("Image #1");
  });
});

describe("image chips in the composer", () => {
  it("renders an image chip as a remove-only attachment row with the origin tooltip", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/staging/a.png:1:7",
        path: "/staging/a.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
        originRelPath: "assets/a.png",
      }],
    });
    const row = doc.querySelector(".attachment")!;
    expect(row).not.toBeNull();
    expect(row.getAttribute("title")).toBe("assets/a.png");
    expect(row.querySelector(".attachment-remove")).not.toBeNull();
  });

  it("renders the host's staged-file thumbnail and opens a large preview", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/staging/a.png:1:7",
        path: "/staging/a.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
        previewSrc: "vscode-webview://preview/image.png",
      }],
    });

    const thumbnail = doc.querySelector(".attachment-preview")!;
    expect(thumbnail.querySelector("img")!.getAttribute("src")).toBe("vscode-webview://preview/image.png");
    click(window, thumbnail);
    const overlay = doc.querySelector(".image-preview-overlay") as HTMLElement;
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelector("img")!.getAttribute("src")).toBe("vscode-webview://preview/image.png");
  });

  it("reuses browser-owned paste bytes for a thumbnail", async () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "session", sessionId: "session-a", models: [] });
    const input = doc.getElementById("input")!;
    input.dispatchEvent(pasteEvent(window, [{ kind: "file", type: "image/png", file: pngFile(window) }]));
    await vi.waitFor(() => expect(posted.some((m) => m.type === "pasteImage")).toBe(true));
    const paste = posted.find((m) => m.type === "pasteImage")!;
    expect(typeof paste.previewId).toBe("string");

    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image:/staging/pasted.png:1:8",
        path: "/staging/pasted.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
        previewId: paste.previewId,
      }],
    });
    expect(doc.querySelector(".attachment-preview img")!.getAttribute("src"))
      .toMatch(/^data:image\/png;base64,/);
  });

  it("keeps a paste made before the first session id is assigned", async () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input")!;
    input.dispatchEvent(pasteEvent(window, [{ kind: "file", type: "image/png", file: pngFile(window) }]));
    await vi.waitFor(() => expect(posted.some((m) => m.type === "pasteImage")).toBe(true));
    const previewId = posted.find((m) => m.type === "pasteImage")!.previewId;
    dispatch(window, { type: "session", sessionId: "assigned-after-paste", models: [] });
    dispatch(window, {
      type: "chips",
      chips: [{
        id: "image-after-start",
        path: "/staging/after-start.png",
        relPath: "Image #1",
        hidden: false,
        imageIndex: 1,
        mimeType: "image/png",
        previewId,
      }],
    });
    expect(doc.querySelector(".attachment-preview img")?.getAttribute("src"))
      .toMatch(/^data:image\/png;base64,/);
  });

  it("keeps a pasted thumbnail when switching away from its session and back", async () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "session", sessionId: "session-a", models: [] });
    const input = doc.getElementById("input")!;
    input.dispatchEvent(pasteEvent(window, [{ kind: "file", type: "image/png", file: pngFile(window) }]));
    await vi.waitFor(() => expect(posted.some((m) => m.type === "pasteImage")).toBe(true));
    const previewId = posted.find((m) => m.type === "pasteImage")!.previewId;
    const chip = {
      id: "image:/staging/pasted.png:1:9",
      path: "/staging/pasted.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
      previewId,
    };
    dispatch(window, { type: "chips", chips: [chip] });
    expect(doc.querySelector(".attachment-preview img")).not.toBeNull();

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "session", sessionId: "session-b", models: [] });
    dispatch(window, { type: "chips", chips: [] });
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "session", sessionId: "session-a", models: [] });
    dispatch(window, { type: "chips", chips: [chip] });

    expect(doc.querySelector(".attachment-preview img")!.getAttribute("src"))
      .toMatch(/^data:image\/png;base64,/);
  });

  it("evicts the oldest browser preview after 24 pasted images", async () => {
    const { window, doc, posted } = bootWebview();
    const input = doc.getElementById("input")!;
    for (let i = 0; i < 25; i++) {
      input.dispatchEvent(pasteEvent(window, [{ kind: "file", type: "image/png", file: pngFile(window) }]));
    }
    await vi.waitFor(() => {
      expect(posted.filter((m) => m.type === "pasteImage")).toHaveLength(25);
    });
    const previewIds = posted
      .filter((m) => m.type === "pasteImage")
      .map((m) => m.previewId as string);
    dispatch(window, {
      type: "chips",
      chips: [
        {
          id: "oldest",
          path: "/staging/oldest.png",
          relPath: "Image #1",
          hidden: false,
          imageIndex: 1,
          mimeType: "image/png",
          previewId: previewIds[0],
        },
        {
          id: "newest",
          path: "/staging/newest.png",
          relPath: "Image #25",
          hidden: false,
          imageIndex: 25,
          mimeType: "image/png",
          previewId: previewIds[24],
        },
      ],
    });
    expect(doc.querySelectorAll(".attachment-preview img")).toHaveLength(1);
    expect(doc.querySelector(".attachment-preview img")!.getAttribute("src"))
      .toMatch(/^data:image\/png;base64,/);
  });
});
