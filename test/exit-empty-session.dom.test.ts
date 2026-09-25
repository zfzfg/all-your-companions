// A clean (code 0) process exit on an empty transcript is not an error — the
// composer's own send affordance already says what to do. Non-zero exits, and
// clean exits on a session that already has content, keep today's banner.
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const exitBanner = (doc: Document) =>
  [...doc.querySelectorAll(".msg.error")].map((el) => (el.textContent || "").trim());

describe("clean exit on an empty session is not an error", () => {
  it("renders nothing for code 0 when the transcript is empty", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "exit", code: 0 });
    expect(exitBanner(doc)).toEqual([]);
  });

  it("keeps the banner for code 0 once the session has content", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "hello" });
    dispatch(window, { type: "exit", code: 0 });
    expect(exitBanner(doc)).toEqual([
      "Grok exited (code 0). Send a message to restart this session, or start a new one.",
    ]);
  });

  it("keeps the banner for a non-zero exit on an empty transcript", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "exit", code: 1 });
    expect(exitBanner(doc)).toEqual([
      "Grok exited (code 1). Send a message to restart this session, or start a new one.",
    ]);
  });
});
