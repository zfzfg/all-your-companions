// Steer follows the live backend's own answer at initialize (upstream
// 2f67d9a), not a provider blacklist. In this fork the queued block always
// draws the Steer button (AP-01: an unavailable capability is shown with its
// reason, not hidden), so "offered" here means present AND enabled.
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, press } from "./webview-harness";

function initialize(window: any, provider: string, steeringSupported?: boolean) {
  dispatch(window, { type: "initialized", info: { provider, steeringSupported, version: "999.0.0", init: {} } });
  dispatch(window, { type: "session", provider, models: [] });
}

function queue(window: any) {
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "queuedSends", items: ["correct course"] });
}

function enter(window: any, doc: Document) {
  const input = doc.getElementById("input") as HTMLTextAreaElement;
  input.value = "correct course";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

const enabledSteer = (doc: Document) => doc.querySelector(".queued-steer:not([disabled])");

describe("Steer uses the focused backend's capability", () => {
  it.each([
    ["grok", true, true], ["grok", false, false],
    ["codex", true, true], ["codex", false, false], ["codex", undefined, false],
    ["claude", false, false], ["claude", undefined, false],
    ["gemini", false, false], ["gemini", undefined, false],
  ] as const)("%s with capability %s offers Steer=%s and preserves attachments", (provider, supported, offered) => {
    const { window, doc, posted } = bootWebview();
    initialize(window, provider, supported);
    dispatch(window, { type: "agentStart" });
    const chip = { id: "img-1", path: "/img.png", relPath: "Image #1", mimeType: "image/png", imageIndex: 1, hidden: false };
    dispatch(window, { type: "queuedSends", items: ["look"], queued: [{ text: "look", chips: [chip] }] });
    const button = enabledSteer(doc);
    expect(!!button).toBe(offered);
    if (button) {
      press(window, button);
      expect(posted.find((msg) => msg.type === "steerSend")).toMatchObject({ text: "look", chips: [expect.objectContaining({ id: chip.id })] });
    }
    dispatch(window, { type: "steerByDefault", value: true });
    posted.length = 0;
    enter(window, doc);
    expect(posted.some((msg) => msg.type === "steerSend")).toBe(offered);
    expect(posted.some((msg) => msg.type === "queueSend")).toBe(!offered);
    expect(posted.some((msg) => msg.type === "cancel" || msg.type === "send")).toBe(false);
  });

  it("says why a backend that answered no cannot steer", () => {
    const { window, doc } = bootWebview();
    initialize(window, "codex", false);
    queue(window);
    const button = doc.querySelector(".queued-steer") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/not available on this Codex version/);
  });

  it("repaints when the backend capability arrives after the queue", () => {
    const { window, doc } = bootWebview({ ready: false });
    dispatch(window, { type: "session", provider: "codex", models: [] });
    queue(window);
    expect(enabledSteer(doc)).toBeNull();
    initialize(window, "codex", true);
    expect(enabledSteer(doc)).not.toBeNull();
  });

  it("does not carry a capability or unsupported latch across session switches", () => {
    const { window, doc } = bootWebview();
    initialize(window, "codex", true);
    queue(window);
    dispatch(window, { type: "steerUnavailable" });
    expect(enabledSteer(doc)).toBeNull();
    dispatch(window, { type: "clearMessages" });
    initialize(window, "grok", true);
    queue(window);
    expect(enabledSteer(doc)).not.toBeNull();
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "session", provider: "codex", models: [] });
    queue(window);
    expect(enabledSteer(doc)).toBeNull();
    initialize(window, "claude", false);
    expect(enabledSteer(doc)).toBeNull();
  });

  it("does not apply the previous provider's capability before the next initialize", () => {
    const { window, doc } = bootWebview();
    initialize(window, "codex", true);
    queue(window);
    dispatch(window, { type: "session", provider: "claude", models: [] });
    expect(enabledSteer(doc)).toBeNull();
  });
});
