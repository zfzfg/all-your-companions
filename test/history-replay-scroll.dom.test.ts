import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const INIT = {
  type: "initialState",
  effort: "",
  cwd: "/w",
  useCtrlEnter: false,
  extVersion: "0",
  showThinking: false,
};

function bootWithScrollMeter() {
  let scrollHeight = 400;
  let writes = 0;
  const harness = bootWebview({
    beforeScripts(window) {
      const messages = window.document.getElementById("messages")!;
      let scrollTop = 0;
      Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });
      Object.defineProperty(messages, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (value) => {
          writes += 1;
          scrollTop = Number(value);
        },
      });
    },
  });
  return {
    ...harness,
    writes: () => writes,
    resetWrites: () => { writes = 0; },
    setHeight: (height: number) => { scrollHeight = height; },
  };
}

describe("history replay does not per-element scroll", () => {
  it("suppresses auto-scroll during replay and scrolls once when it ends", () => {
    const { window, doc, writes, resetWrites, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    resetWrites();

    dispatch(window, { type: "historyReplay", active: true });
    for (let i = 0; i < 24; i++) {
      setHeight(400 + (i + 1) * 80);
      dispatch(window, { type: "userMessageChunk", text: `prompt ${i}` });
      dispatch(window, { type: "messageChunk", text: `answer ${i}` });
      dispatch(window, {
        type: "toolCall",
        call: { toolCallId: `t${i}`, kind: "read", title: `Read file-${i}.ts` },
      });
    }
    expect(writes()).toBe(0);
    expect((doc.getElementById("messages") as HTMLElement).scrollTop).toBe(0);

    const finalHeight = 400 + 24 * 80;
    setHeight(finalHeight);
    dispatch(window, { type: "historyReplay", active: false });
    expect(writes()).toBe(1);
    expect((doc.getElementById("messages") as HTMLElement).scrollTop).toBe(finalHeight);
  });

  it("does not scroll on the inner close of a nested replay", () => {
    const { window, writes, resetWrites, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    resetWrites();

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "historyReplay", active: true });
    setHeight(900);
    dispatch(window, { type: "messageChunk", text: "inner" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(writes()).toBe(0);

    setHeight(1200);
    dispatch(window, { type: "historyReplay", active: false });
    expect(writes()).toBe(1);
  });

  it("live streaming still follows the bottom", async () => {
    const { window, doc, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    dispatch(window, { type: "userMessage", text: "go", chips: [] });
    dispatch(window, { type: "agentStart" });

    setHeight(700);
    dispatch(window, { type: "messageChunk", text: "hello " });
    setHeight(1400);
    dispatch(window, { type: "messageChunk", text: "world" });

    await vi.waitFor(() => {
      expect((doc.getElementById("messages") as HTMLElement).scrollTop).toBe(1400);
    });
  });

  it("after replay ends, a live chunk follows the bottom again", async () => {
    const { window, doc, resetWrites, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    dispatch(window, { type: "historyReplay", active: true });
    setHeight(800);
    dispatch(window, { type: "messageChunk", text: "old" });
    dispatch(window, { type: "historyReplay", active: false });
    resetWrites();

    dispatch(window, { type: "agentStart" });
    setHeight(1600);
    dispatch(window, { type: "messageChunk", text: "new" });
    await vi.waitFor(() => {
      expect((doc.getElementById("messages") as HTMLElement).scrollTop).toBe(1600);
    });
  });
});

function messagesOf(doc: Document) {
  return doc.getElementById("messages") as HTMLElement;
}

function unpinAt(window: Window & typeof globalThis, messages: HTMLElement, top: number) {
  messages.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
  messages.scrollTop = top;
  messages.dispatchEvent(new window.Event("scroll"));
}

function replayTranscript(
  window: Window,
  setHeight: (height: number) => void,
  height: number,
  text: string,
) {
  dispatch(window, { type: "historyReplay", active: true });
  setHeight(height);
  dispatch(window, { type: "userMessageChunk", text });
  dispatch(window, { type: "messageChunk", text: `answer ${text}` });
  dispatch(window, { type: "historyReplay", active: false });
}

describe("history replay end follows the pin", () => {
  it("leaves the place alone when the reader has scrolled up", () => {
    const { window, doc, writes, resetWrites, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    replayTranscript(window, setHeight, 1200, "first");
    const messages = messagesOf(doc);
    unpinAt(window, messages, 80);
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);
    resetWrites();

    replayTranscript(window, setHeight, 1800, "second");
    expect(writes()).toBe(0);
    expect(messages.scrollTop).toBe(80);
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);
  });

  it("stays at the bottom so new messages are visible when the reader is pinned", () => {
    const { window, doc, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    replayTranscript(window, setHeight, 800, "old");
    expect(messagesOf(doc).scrollTop).toBe(800);
    expect(messagesOf(doc).classList.contains("stick-to-bottom")).toBe(true);

    replayTranscript(window, setHeight, 1600, "new");
    expect(messagesOf(doc).scrollTop).toBe(1600);
    expect(messagesOf(doc).classList.contains("stick-to-bottom")).toBe(true);
  });

  it("lands a fresh open with no established pin at the bottom", () => {
    const { window, doc, setHeight } = bootWithScrollMeter();
    dispatch(window, INIT);
    dispatch(window, { type: "clearMessages" });
    expect(messagesOf(doc).classList.contains("stick-to-bottom")).toBe(true);

    replayTranscript(window, setHeight, 1400, "fresh");
    expect(messagesOf(doc).scrollTop).toBe(1400);
    expect(messagesOf(doc).classList.contains("stick-to-bottom")).toBe(true);
  });
});
